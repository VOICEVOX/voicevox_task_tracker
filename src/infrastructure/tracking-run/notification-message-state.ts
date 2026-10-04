import {
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  serializeInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../../application/tracking-run/initial-pages-evidence-codec.js";
import {
  serializeRunTransactionMarker,
  type RunTransactionMarker,
} from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { createGitHubRepositoryId, type Repository } from "../../domain/index.js";
import type { NotificationDeliveryAttempt } from "../../domain/notification-delivery-attempt.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StateFileReadResult,
  type StateFileUpdate,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { StateFormatError, StateHistoryError } from "../../persistence/errors.js";
import {
  appendStateHistoryNotificationEvents,
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
} from "../../persistence/history.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import { parseStateSnapshot, type StateSnapshot } from "../../persistence/snapshot-v23.js";
import { transitionNotificationMessageLedger } from "../../persistence/state-notification-transition.js";
import {
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  createStateNotificationLedger,
  parseStateNotificationLedger,
  parseStateOperationsAlertLedger,
  type StateNotificationLedger,
} from "../../persistence/state-documents.js";
import { createStateLedgerUpdates } from "../../persistence/state-ledger-files.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  createNotificationHistoryContext,
  createNotificationHistoryEventsForMessage,
} from "../../persistence/notification-history-events.js";
import { notificationLedgerEntry } from "../../persistence/notification-ledger-normalization.js";
import {
  restoreNotificationSelection,
  type NotificationMessageContext,
} from "./notification-message-context.js";
import { NotificationStructureError } from "./notification-structure-error.js";

export function assertCurrentState(
  state: NotificationMessageState,
  record: DurablePublicationRecord,
  initialStateRevision: string,
  evidence: InitialPagesPublicationEvidence,
): void {
  const { marker } = state.transaction;
  if (
    marker.phase === "notifications_settled" ||
    marker.phase === "run_finalized" ||
    state.transaction.record.recordDigest !== record.recordDigest ||
    marker.runId !== record.runIdentity.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    state.snapshot.run.id !== record.runIdentity.runId
  ) {
    throw new NotificationStructureError(
      "通知messageのstateが保留中の同じrunではありません",
      "no_effect",
    );
  }
  if (
    marker.phase === "initial_state_committed"
      ? state.transaction.initialPagesEvidence != null
      : marker.initialStateRevision !== initialStateRevision ||
        serializeCanonicalJson(state.transaction.initialPagesEvidence) !==
          serializeCanonicalJson(evidence)
  ) {
    throw new NotificationStructureError(
      "通知messageの初回revisionまたはPages証拠がstateと一致しません",
      "no_effect",
    );
  }
}

/** 一つのexact state revisionで検証した通知送達入力。 */
export type NotificationMessageState = Readonly<{
  revision: string;
  transaction: VerifiedRunTransactionFiles;
  snapshot: StateSnapshot;
  ledger: StateNotificationLedger;
  files: ReadonlyMap<string, StateFileReadResult>;
}>;

function requiredSource(files: ReadonlyMap<string, StateFileReadResult>, path: string): string {
  const file = files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`通知messageのstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

/** snapshot、ledger、marker、recordを同じcommit treeから読む。 */
export async function readNotificationMessageState(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<NotificationMessageState> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("通知messageのexact state file一覧が不足しています");
  }
  const transaction = verifyRunTransactionFiles(files, configuration);
  if (transaction == null) {
    throw new TypeError("通知messageのrun transactionがありません");
  }
  const snapshot = parseStateSnapshot(requiredSource(files, configuration.snapshotPath));
  const normalLedger = parseStateNotificationLedger(
    requiredSource(files, configuration.notificationLedgerPath),
  );
  const operationsFile = files.get(OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  const ledger = createStateNotificationLedger({
    ...normalLedger,
    operationsAlerts:
      operationsFile?.status === "present"
        ? parseStateOperationsAlertLedger(
            new TextDecoder("utf-8", { fatal: true }).decode(operationsFile.bytes),
          ).operationsAlerts
        : [],
  });
  return Object.freeze({ revision, transaction, snapshot, ledger, files });
}

export type MessageAttempt = NotificationDeliveryAttempt;

/** 一つのmessageに含まれる全keyを同じ試行へ遷移させる。 */
export function transitionMessageLedger(
  ledger: StateNotificationLedger,
  record: DurablePublicationRecord,
  context: NotificationMessageContext,
  attempt: MessageAttempt,
): StateNotificationLedger {
  try {
    return transitionNotificationMessageLedger(
      ledger,
      record,
      {
        deliveryId: context.deliveryId,
        notificationKeys: context.notificationKeys,
        ...(context.manualResolutionReceipt == null
          ? {}
          : { manualResolutionOperationId: context.manualResolutionReceipt.operationId }),
      },
      attempt,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError)) {
      throw cause;
    }
    throw new NotificationStructureError("通知messageのledger遷移が不正です", "no_effect", {
      cause,
    });
  }
}

/** 成功したmessageの履歴eventと安全なstate更新を組み立てる。 */
export async function messageStateUpdates(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  state: NotificationMessageState,
  nextLedger: StateNotificationLedger,
  marker: RunTransactionMarker,
  evidence: InitialPagesPublicationEvidence,
  context: NotificationMessageContext,
  result: "started" | "sent" | "clear_rejection",
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
): Promise<readonly StateFileUpdate[]> {
  const updates: StateFileUpdate[] = [
    ...(await createStateLedgerUpdates(
      adapter,
      configuration,
      { status: "present", revision: state.revision },
      nextLedger,
      "tracking_run",
    )),
  ];
  let historyRecords: readonly unknown[] = [];
  if (result === "sent") {
    if (state.transaction.record.notificationOutbox.action !== "send") {
      throw new TypeError("送信action以外の通知履歴を作れません");
    }
    const historyContext = createNotificationHistoryContext(
      state.snapshot,
      restoreNotificationSelection(state.transaction.record),
    );
    const entries = nextLedger.entries.filter((entry) =>
      context.notificationKeys.includes(entry.notificationKey),
    );
    const events = createNotificationHistoryEventsForMessage(
      state.snapshot,
      historyContext,
      entries.map(notificationLedgerEntry),
    );
    const path = joinStatePath(
      configuration.historyDirectory,
      `${state.snapshot.generatedAt.slice(0, 10)}.jsonl`,
    );
    const historyFile = state.files.get(path);
    if (historyFile?.status !== "present") {
      throw new NotificationStructureError(
        "通知messageの結果CASに必要な履歴fileがありません",
        "no_effect",
        { cause: new TypeError(`通知messageのstate fileがありません。対象: ${path}`) },
      );
    }
    let originalSource: string;
    try {
      originalSource = new TextDecoder("utf-8", { fatal: true }).decode(historyFile.bytes);
    } catch (cause: unknown) {
      if (!(cause instanceof TypeError)) {
        throw cause;
      }
      throw new NotificationStructureError(
        "通知messageの結果CASの履歴fileがUTF-8ではありません",
        "no_effect",
        { cause },
      );
    }
    let source: string;
    try {
      source = appendStateHistoryNotificationEvents(originalSource, marker.runId, events);
    } catch (cause: unknown) {
      if (!(cause instanceof StateFormatError || cause instanceof StateHistoryError)) {
        throw cause;
      }
      throw new NotificationStructureError(
        "通知messageの結果CASの履歴fileまたはrecordが不正です",
        "no_effect",
        { cause },
      );
    }
    const records = parseStateHistoryRecords(source);
    if (serializeStateHistoryRecords(records) !== source) {
      throw new NotificationStructureError(
        "通知履歴の保存値がcanonical JSON Linesではありません",
        "no_effect",
      );
    }
    historyRecords = records;
    updates.push({ path, bytes: new TextEncoder().encode(source) });
  }
  if (state.transaction.marker.phase === "initial_state_committed") {
    updates.push({
      path: INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
      bytes: new TextEncoder().encode(serializeInitialPagesPublicationEvidence(evidence, digest)),
    });
  }
  updates.push({
    path: RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    bytes: new TextEncoder().encode(serializeRunTransactionMarker(marker)),
  });
  assertStatePublicSafety({
    snapshot: state.snapshot,
    repositoryInventory,
    repositoryAllowlist: state.transaction.record.initialPagesProjection.repositoryAllowlist.map(
      (repository) => ({ ...repository, id: createGitHubRepositoryId(repository.id) }),
    ),
    additionalValues: [nextLedger, marker, evidence, ...historyRecords],
    knownSecrets,
  });
  updates.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return Object.freeze(updates);
}

/** ledgerとmarkerの候補が要求したmessage遷移と一致することを確かめる。 */
export function assertMessageCandidate(
  marker: RunTransactionMarker,
  ledger: StateNotificationLedger,
  context: NotificationMessageContext,
  result: "started" | "sent" | "clear_rejection",
  attemptId: string,
): void {
  if (
    marker.phase !== "notifications_in_progress" ||
    marker.lastMessageDeliveryId !== context.deliveryId ||
    context.notificationKeys.some((key) => {
      const entry = ledger.entries.find((value) => value.notificationKey === key);
      return (
        entry == null ||
        entry.lastDeliveryAttempt?.attemptId !== attemptId ||
        entry.lastDeliveryAttempt.result !== result ||
        (result === "started" && entry.status !== "delivery_started") ||
        (result === "sent" && entry.status !== "sent") ||
        (result === "clear_rejection" && entry.status !== "reserved")
      );
    })
  ) {
    throw new TypeError("通知messageのCAS候補が予定した遷移と一致しません");
  }
}

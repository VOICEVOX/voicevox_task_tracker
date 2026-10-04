import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StateBranchCommitInspection,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { parseStateHistoryRecords, serializeStateHistoryRecords } from "./history.js";
import { readAiCacheMigrationPlan } from "./state-ai-cache-migration-plan.js";
import {
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseRunTransactionNotificationLedger,
} from "./state-documents.js";
import type { VerifiedRunTransactionFiles } from "./state-transaction-files.js";

export type VerifiedCommitTree = Readonly<{
  files: ReadonlyMap<string, StateFileReadResult>;
  transaction: VerifiedRunTransactionFiles;
}>;

function sameFile(left: StateFileReadResult, right: StateFileReadResult): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === "missing" || right.status === "missing") {
    return true;
  }
  return (
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}

function fileAt(
  files: ReadonlyMap<string, StateFileReadResult>,
  path: string,
): StateFileReadResult {
  return files.get(path) ?? { status: "missing" };
}

function source(file: StateFileReadResult, path: string): string {
  if (file.status !== "present") {
    throw new TypeError(`Git祖先のstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

function isSentResult(
  current: VerifiedCommitTree,
  previous: VerifiedCommitTree | undefined,
  configuration: StatePersistenceConfiguration,
): boolean {
  if (previous == null) {
    return false;
  }
  const before = parseRunTransactionNotificationLedger(
    source(
      fileAt(previous.files, configuration.notificationLedgerPath),
      configuration.notificationLedgerPath,
    ),
  ).ledger;
  const after = parseRunTransactionNotificationLedger(
    source(
      fileAt(current.files, configuration.notificationLedgerPath),
      configuration.notificationLedgerPath,
    ),
  ).ledger;
  const priorByKey = new Map(before.entries.map((entry) => [entry.notificationKey, entry]));
  return after.entries.some((entry) => {
    const prior = priorByKey.get(entry.notificationKey);
    return (
      entry.lastDeliveryAttempt?.result === "sent" &&
      prior?.lastDeliveryAttempt?.result === "started" &&
      prior.lastDeliveryAttempt.attemptId === entry.lastDeliveryAttempt.attemptId
    );
  });
}

function assertHistoryPreserved(
  beforeFile: StateFileReadResult,
  afterFile: StateFileReadResult,
  path: string,
  runId: string,
  initial: boolean,
): void {
  const beforeSource = beforeFile.status === "present" ? source(beforeFile, path) : undefined;
  const afterSource = source(afterFile, path);
  const before = beforeSource == null ? [] : parseStateHistoryRecords(beforeSource);
  const after = parseStateHistoryRecords(afterSource);
  if (serializeStateHistoryRecords(after) !== afterSource) {
    throw new TypeError("Git祖先の履歴fileがcanonical JSON Linesではありません");
  }
  if (initial) {
    if (
      after.length !== before.length + 1 ||
      after.at(-1)?.runId !== runId ||
      before.some(
        (record, index) => serializeCanonicalJson(record) !== serializeCanonicalJson(after[index]),
      )
    ) {
      throw new TypeError("初回commitが過去の履歴recordを変更しています");
    }
    return;
  }
  if (before.length !== after.length) {
    throw new TypeError("通知結果commitで履歴record数が変化しています");
  }
  for (const [index, prior] of before.entries()) {
    const next = after[index];
    if (next == null) {
      throw new TypeError("通知結果commitの履歴recordがありません");
    }
    if (prior.runId !== runId) {
      if (serializeCanonicalJson(prior) !== serializeCanonicalJson(next)) {
        throw new TypeError("通知結果commitが過去の履歴recordを変更しています");
      }
      continue;
    }
    const previousEvents = new Set(prior.events.map((event) => serializeCanonicalJson(event)));
    const nextEvents = new Set(next.events.map((event) => serializeCanonicalJson(event)));
    if (
      next.runId !== prior.runId ||
      next.date !== prior.date ||
      next.recordedAt !== prior.recordedAt ||
      serializeCanonicalJson(next.inputEvents) !== serializeCanonicalJson(prior.inputEvents) ||
      next.events.length <= prior.events.length ||
      [...previousEvents].some((event) => !nextEvents.has(event)) ||
      next.events.some(
        (event) =>
          !previousEvents.has(serializeCanonicalJson(event)) && event.kind !== "notification_sent",
      )
    ) {
      throw new TypeError("通知結果commitが既存の履歴eventを変更しています");
    }
  }
}

/** tracking commitのphase別pathと固定fileのbyte不変条件を検証する。 */
export async function assertTrackingCommitPaths(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  commit: StateBranchCommitInspection,
  current: VerifiedCommitTree,
  previous: VerifiedCommitTree | undefined,
): Promise<void> {
  const phase = current.transaction.marker.phase;
  const initial = phase === "initial_state_committed";
  const historyPath = joinStatePath(
    configuration.historyDirectory,
    `${current.transaction.record.initialPagesProjection.generatedAt.slice(0, 10)}.jsonl`,
  );
  const reportPath = joinStatePath(
    configuration.runReportsDirectory,
    `${current.transaction.record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
  );
  const createdEvidence =
    previous?.transaction.marker.phase === "initial_state_committed" && !initial;
  const sentResult =
    phase === "notifications_in_progress" &&
    commit.metadata.commitScope === "tracking_run" &&
    isSentResult(current, previous, configuration);
  const hasCacheDeletion =
    initial &&
    commit.changedPathManifest.entries.some(
      (entry) =>
        entry.kind === "deleted" && entry.path.startsWith(`${configuration.aiCacheDirectory}/`),
    );
  const legacyCachePaths =
    hasCacheDeletion && commit.parent.status === "present"
      ? new Set(
          (await readAiCacheMigrationPlan(adapter, configuration, commit.parent)).legacyCachePaths,
        )
      : new Set<string>();
  const allowed = new Map<string, readonly string[]>([
    [RUN_TRANSACTION_MARKER_STATE_PATH_V1, initial ? ["created", "modified"] : ["modified"]],
  ]);
  if (initial) {
    allowed.set(configuration.snapshotPath, ["created", "modified"]);
    allowed.set(configuration.notificationLedgerPath, ["created", "modified"]);
    allowed.set(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1, ["created", "modified"]);
    allowed.set(historyPath, ["created", "modified"]);
    allowed.set(OPERATIONS_ALERT_LEDGER_STATE_PATH_V1, ["created"]);
    allowed.set(INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1, ["deleted"]);
  } else if (phase === "notifications_in_progress") {
    allowed.set(configuration.notificationLedgerPath, ["modified"]);
    if (sentResult) {
      allowed.set(historyPath, ["modified"]);
    }
    if (createdEvidence) {
      allowed.set(INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1, ["created"]);
      if (previous.transaction.snapshotSchemaVersion !== "23") {
        allowed.set(OPERATIONS_ALERT_LEDGER_STATE_PATH_V1, ["created"]);
      }
    }
  } else if (phase === "notifications_settled") {
    if (createdEvidence) {
      allowed.set(INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1, ["created"]);
    }
  } else {
    allowed.set(configuration.snapshotPath, ["modified"]);
    allowed.set(reportPath, ["created", "modified"]);
  }
  for (const entry of commit.changedPathManifest.entries) {
    let kinds = allowed.get(entry.path);
    if (initial && entry.path.startsWith(`${configuration.aiCacheDirectory}/`)) {
      const name = entry.path.slice(configuration.aiCacheDirectory.length + 1);
      if (/^[0-9a-f]{64}\.json$/u.test(name)) {
        kinds = legacyCachePaths.has(entry.path)
          ? ["deleted", "created", "modified"]
          : ["created", "modified"];
      }
    }
    if (initial && entry.path.startsWith(`${configuration.personalReminderAiCacheDirectory}/`)) {
      const name = entry.path.slice(configuration.personalReminderAiCacheDirectory.length + 1);
      if (/^[0-9a-f]{64}\.json$/u.test(name)) {
        kinds = ["created", "modified"];
      }
    }
    if (kinds?.includes(entry.kind) !== true) {
      throw new TypeError(`Git祖先のphaseに許可されない変更pathがあります。対象: ${entry.path}`);
    }
  }
  const fixedPaths = [
    configuration.snapshotPath,
    configuration.notificationLedgerPath,
    OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  ];
  const beforeFiles =
    commit.parent.status === "present"
      ? await adapter.readFiles(commit.parent.revision, fixedPaths)
      : new Map<string, StateFileReadResult>();
  const changedPaths = new Set(commit.changedPathManifest.entries.map((entry) => entry.path));
  if ((initial || sentResult) && !changedPaths.has(historyPath)) {
    throw new TypeError("Git祖先の履歴更新がcommit変更範囲にありません");
  }
  for (const path of fixedPaths) {
    if (
      !changedPaths.has(path) &&
      !sameFile(fileAt(beforeFiles, path), fileAt(current.files, path))
    ) {
      throw new TypeError(`Git祖先の固定file byteが変化しています。対象: ${path}`);
    }
  }
  if (changedPaths.has(historyPath)) {
    const before =
      commit.parent.status === "present"
        ? await adapter.readFile(commit.parent.revision, historyPath)
        : ({ status: "missing" } satisfies StateFileReadResult);
    const after = await adapter.readFile(commit.revision, historyPath);
    assertHistoryPreserved(before, after, historyPath, current.transaction.marker.runId, initial);
  }
}

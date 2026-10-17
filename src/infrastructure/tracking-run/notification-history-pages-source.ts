import { randomUUID } from "node:crypto";

import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { hashCanonicalJson } from "../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { Config } from "../../config/index.js";
import { createGitHubRepositoryId } from "../../domain/index.js";
import { assertPagesPublicSafety } from "../../pages/index.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { appendStateHistoryNotificationEvents } from "../../persistence/history.js";
import type {
  StateHistoryNotificationEvent,
  StateHistoryRecord,
} from "../../persistence/history-contracts.js";
import { assertStateValuesPublicSafety } from "../../persistence/public-safety.js";
import {
  createStateRunReport,
  serializeStateRunReport,
} from "../../persistence/state-run-report.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { readPagesHistoryRecords } from "./initial-pages-source.js";
import {
  createNotificationHistoryContext,
  createNotificationHistoryEventsForMessage,
} from "../../persistence/notification-history-events.js";
import { notificationLedgerEntry } from "../../persistence/notification-ledger-normalization.js";
import { restoreNotificationSelection } from "./notification-message-context.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { projectPublicationSettings } from "./publication/settings.js";
import { assertFinalRunValues } from "./run-finalization-state.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

/** final stateで確定した通知履歴Pagesの公開要否。 */
export type NotificationHistoryPagesRequirement =
  | Readonly<{ kind: "required" }>
  | Readonly<{
      kind: "not_required";
      reason: "notification_action_held" | "notification_action_acknowledged" | "no_sent_history";
    }>;

/** finalization receiptのexact treeで検証したPages入力。 */
export type NotificationHistoryPagesSource = Readonly<{
  revision: string;
  record: DurablePublicationRecord;
  snapshot: NotificationMessageState["snapshot"];
  historyRecords: readonly StateHistoryRecord[];
  finalizationReceipt: RunFinalizationReceipt;
  requirement: NotificationHistoryPagesRequirement;
}>;

function historySource(
  state: NotificationMessageState,
  configuration: StatePersistenceConfiguration,
): string {
  const path = joinStatePath(
    configuration.historyDirectory,
    `${state.snapshot.generatedAt.slice(0, 10)}.jsonl`,
  );
  const file = state.files.get(path);
  if (file?.status !== "present") {
    throw new TypeError("通知履歴Pagesのrun history fileがありません");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

function runHistoryRecord(
  records: readonly StateHistoryRecord[],
  runId: string,
): StateHistoryRecord {
  const matches = records.filter((record) => record.runId === runId);
  if (matches.length !== 1 || matches[0] == null) {
    throw new TypeError("通知履歴Pagesのrun history recordが一意ではありません");
  }
  return matches[0];
}

function sentHistoryEvents(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  finalized: NotificationMessageState,
): readonly StateHistoryNotificationEvent[] {
  if (record.notificationOutbox.action !== "send") {
    return [];
  }
  if (record.notificationOutbox.selectedContext.action === "skip_digest") {
    if (record.notificationOutbox.delivery !== "no_candidates") {
      throw new TypeError("通知履歴Pagesの送信0件outboxが一致しません");
    }
    return [];
  }
  if (record.notificationOutbox.delivery !== "send") {
    throw new TypeError("通知履歴Pagesの送信outboxが一致しません");
  }
  const selection = restoreNotificationSelection(record);
  const selectedKeys = new Set(selection.ledgerReservations.map((entry) => entry.notificationKey));
  const initialEntries = new Map(
    initial.ledger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const finalizedEntries = new Map(
    finalized.ledger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  if (
    selectedKeys.size !== selection.ledgerReservations.length ||
    initialEntries.size !== initial.ledger.entries.length ||
    finalizedEntries.size !== finalized.ledger.entries.length ||
    initialEntries.size !== finalizedEntries.size
  ) {
    throw new TypeError("通知履歴Pagesの通知key集合が不正です");
  }
  const byMessage = new Map<string, ReturnType<typeof notificationLedgerEntry>[]>();
  for (const [key, before] of initialEntries) {
    const after = finalizedEntries.get(key);
    if (
      after == null ||
      (!selectedKeys.has(key) && serializeCanonicalJson(before) !== serializeCanonicalJson(after))
    ) {
      throw new TypeError("通知履歴Pagesのoutbox外のledgerが変化しています");
    }
    if (!selectedKeys.has(key)) {
      continue;
    }
    if (before.status !== "reserved") {
      throw new TypeError("通知履歴Pagesの初回ledgerに送信予約がありません");
    }
    if (after.status !== "sent") {
      if (after.status === "delivery_started") {
        throw new TypeError("通知履歴Pagesに未確定の送信結果があります");
      }
      continue;
    }
    const group = byMessage.get(after.discordMessageId) ?? [];
    group.push(notificationLedgerEntry(after));
    byMessage.set(after.discordMessageId, group);
  }
  const context = createNotificationHistoryContext(initial.snapshot, selection);
  const events = [...byMessage.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([, entries]) =>
      createNotificationHistoryEventsForMessage(initial.snapshot, context, entries),
    );
  return events;
}

function requirement(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  finalized: NotificationMessageState,
  configuration: StatePersistenceConfiguration,
  settlement: NotificationSettlementReceipt,
): NotificationHistoryPagesRequirement {
  const initialRecords = readPagesHistoryRecords(initial.files, configuration.historyDirectory);
  const finalRecords = readPagesHistoryRecords(finalized.files, configuration.historyDirectory);
  const initialRun = runHistoryRecord(initialRecords, record.runIdentity.runId);
  const finalRun = runHistoryRecord(finalRecords, record.runIdentity.runId);
  if (
    initialRun.date !== record.initialPagesProjection.generatedAt.slice(0, 10) ||
    finalRun.date !== initialRun.date ||
    hashCanonicalJson(finalRun) !== settlement.result.notificationHistoryDigest
  ) {
    throw new TypeError("通知履歴Pagesのsettlement receiptとrun historyが一致しません");
  }
  const events = sentHistoryEvents(record, initial, finalized);
  const expected =
    events.length === 0
      ? historySource(initial, configuration)
      : appendStateHistoryNotificationEvents(
          historySource(initial, configuration),
          record.runIdentity.runId,
          events,
        );
  if (expected !== historySource(finalized, configuration)) {
    throw new TypeError("通知履歴Pagesの送信履歴差分とledgerが一致しません");
  }
  if (record.notificationOutbox.action === "hold") {
    return { kind: "not_required", reason: "notification_action_held" };
  }
  if (record.notificationOutbox.action === "acknowledge-current") {
    return { kind: "not_required", reason: "notification_action_acknowledged" };
  }
  return events.length > 0
    ? { kind: "required" }
    : { kind: "not_required", reason: "no_sent_history" };
}

/** settlementとfinalizationのreceiptをexact treeへ照合して公開入力を読む。 */
export async function readNotificationHistoryPagesSource(
  adapter: StateBranchAdapter,
  config: Config,
  configuration: StatePersistenceConfiguration,
  settlementInput: NotificationSettlementReceipt,
  finalizationInput: RunFinalizationReceipt,
  knownSecrets: readonly string[],
  now: () => Date,
): Promise<NotificationHistoryPagesSource> {
  const settlement = parseReceipt(settlementInput, digest);
  const finalization = parseReceipt(finalizationInput, digest);
  if (
    settlement.receiptType !== "notification_settlement" ||
    finalization.receiptType !== "run_finalization" ||
    settlement.binding.bindingKind !== "checkpoint" ||
    finalization.binding.bindingKind !== "checkpoint" ||
    serializeCanonicalJson(settlement.binding) !== serializeCanonicalJson(finalization.binding) ||
    finalization.previousReceiptDigest !== settlement.receiptDigest ||
    settlement.previousReceiptDigest == null ||
    finalization.phaseSequence !== settlement.phaseSequence + 1 ||
    finalization.expectedStateRevision !== settlement.result.resultingStateRevision
  ) {
    throw new TypeError("通知履歴Pagesのreceipt連鎖が一致しません");
  }
  const finalRevision = finalization.result.resultingStateRevision;
  const finalized = await readNotificationMessageState(adapter, configuration, finalRevision);
  const record = finalized.transaction.record;
  if (finalized.transaction.marker.phase !== "run_finalized") {
    throw new TypeError("通知履歴Pagesのfinal state markerがありません");
  }
  const initialRevision = finalized.transaction.marker.initialStateRevision;
  if (
    record.runIdentity.runId !== finalization.binding.runId ||
    record.checkpointDigest !== finalization.binding.checkpointDigest ||
    record.checkpointFileDigest !== finalization.binding.checkpointFileDigest ||
    digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) !==
      finalization.binding.runtimeIdentityDigest ||
    serializeCanonicalJson(projectPublicationSettings(config).pages) !==
      serializeCanonicalJson(record.initialPagesProjection.settings) ||
    record.notificationOutbox.action !== settlement.result.action ||
    finalized.transaction.notificationLedgerDigest !== settlement.result.notificationLedgerDigest ||
    finalized.transaction.initialPagesEvidence == null
  ) {
    throw new TypeError("通知履歴Pagesのfinal stateとrecordまたはreceiptが一致しません");
  }
  const settled = await readNotificationMessageState(
    adapter,
    configuration,
    settlement.result.resultingStateRevision,
  );
  const initial = await readNotificationMessageState(adapter, configuration, initialRevision);
  if (
    settled.transaction.marker.phase !== "notifications_settled" ||
    initial.transaction.marker.phase !== "initial_state_committed" ||
    settled.transaction.record.recordDigest !== record.recordDigest ||
    initial.transaction.record.recordDigest !== record.recordDigest ||
    settled.transaction.snapshotDigest !== initial.transaction.snapshotDigest ||
    settled.transaction.notificationLedgerDigest !==
      finalized.transaction.notificationLedgerDigest ||
    settled.transaction.initialPagesEvidence?.evidenceDigest !==
      finalized.transaction.initialPagesEvidence.evidenceDigest ||
    settled.transaction.marker.initialStateRevision !== initialRevision ||
    settled.snapshot.run.id !== record.runIdentity.runId ||
    initial.snapshot.run.id !== record.runIdentity.runId
  ) {
    throw new TypeError("通知履歴Pagesの初回、settlement、final stateが一致しません");
  }
  const observedAt = now().toISOString();
  const settledObserved = await observeStateCommitAtRevision(
    adapter,
    configuration,
    settled.revision,
    initialRevision,
    "notification_settlement",
    {
      invocationId: randomUUID(),
      observedAt,
      position: {
        kind: "after",
        previousReceiptDigest: settlement.previousReceiptDigest,
        previousPhaseSequence: settlement.phaseSequence - 1,
      },
    },
  );
  const finalObserved = await observeStateCommitAtRevision(
    adapter,
    configuration,
    finalRevision,
    initialRevision,
    "run_finalization",
    {
      invocationId: randomUUID(),
      observedAt,
      position: {
        kind: "after",
        previousReceiptDigest: settlement.receiptDigest,
        previousPhaseSequence: settlement.phaseSequence,
      },
    },
  );
  if (
    serializeCanonicalJson(settlement.result) !==
      serializeCanonicalJson(settledObserved.receipt.result) ||
    serializeCanonicalJson(finalization.result) !==
      serializeCanonicalJson(finalObserved.receipt.result) ||
    settlement.operationId !== settledObserved.receipt.operationId ||
    finalization.operationId !== finalObserved.receipt.operationId ||
    settlement.expectedStateRevision !== settledObserved.receipt.expectedStateRevision ||
    finalization.expectedStateRevision !== finalObserved.receipt.expectedStateRevision
  ) {
    throw new TypeError("通知履歴Pagesのstate receiptとGit commitが一致しません");
  }
  const settlementEvidence: ReceiptChainEvidence =
    settlement.receiptKind === "observed"
      ? { kind: "state_commit", state: settledObserved.evidence }
      : { kind: "none" };
  const finalizationEvidence: ReceiptChainEvidence =
    finalization.receiptKind === "observed"
      ? { kind: "state_commit", state: finalObserved.evidence }
      : { kind: "none" };
  verifyReceiptChain(
    [
      { receipt: settlement, evidence: settlementEvidence },
      { receipt: finalization, evidence: finalizationEvidence },
    ],
    digest,
  );
  const reportPath = joinStatePath(
    configuration.runReportsDirectory,
    `${record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
  );
  const reportFile = finalized.files.get(reportPath);
  if (reportFile?.status !== "present") {
    throw new TypeError("通知履歴Pagesの最終run reportがありません");
  }
  const reportSource = new TextDecoder("utf-8", { fatal: true }).decode(reportFile.bytes);
  const report = createStateRunReport(JSON.parse(reportSource));
  if (reportSource !== serializeStateRunReport(report)) {
    throw new TypeError("通知履歴Pagesの最終run reportがcanonical JSONではありません");
  }
  assertFinalRunValues(record, settled, finalized, report);
  const historyRecords = readPagesHistoryRecords(finalized.files, configuration.historyDirectory);
  const publicationRequirement = requirement(record, initial, finalized, configuration, settlement);
  assertStateValuesPublicSafety(
    [
      finalized.transaction.marker,
      record,
      finalized.ledger,
      finalized.transaction.initialPagesEvidence,
      ...historyRecords,
    ],
    record.initialPagesProjection.repositoryAllowlist,
    finalized.snapshot.verifiedExternalReferences,
    knownSecrets,
  );
  assertPagesPublicSafety({
    snapshot: finalized.snapshot,
    historyRecords,
    repositoryAllowlist: record.initialPagesProjection.repositoryAllowlist.map((repository) => ({
      ...repository,
      id: createGitHubRepositoryId(repository.id),
    })),
    repositoryInventory: finalized.snapshot.repositories,
    knownSecrets,
  });
  return Object.freeze({
    revision: finalRevision,
    record,
    snapshot: finalized.snapshot,
    historyRecords,
    finalizationReceipt: finalization,
    requirement: publicationRequirement,
  });
}

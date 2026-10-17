import type { OperationsAlertReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { OperationsAlertLedgerKind } from "../../domain/index.js";
import { type StateBranchAdapter, type StateBranchHead } from "../../persistence/branch-adapter.js";
import {
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  isCanonicalStateOperationsAlertLedgerSource,
  parseStateOperationsAlertLedger,
} from "../../persistence/operations-alert-ledger.js";
import { decodeStateFile } from "../../persistence/state-file-codec.js";
import { OperationsAlertPendingDeliveryError } from "./notification-delivery-runtime.js";

type RecordedAlert = Readonly<{
  incidentId: string;
  kind: OperationsAlertLedgerKind;
  discordMessageId: string;
}>;

async function containsCommit(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
  revision: string,
): Promise<boolean> {
  let cursor = head;
  while (cursor.status === "present") {
    if (cursor.revision === revision) {
      return true;
    }
    cursor = (await adapter.readCommit(cursor.revision)).parent;
  }
  return false;
}

async function assertSentReceiptCommit(
  adapter: StateBranchAdapter,
  dedicatedHead: StateBranchHead,
  legacyHead: StateBranchHead,
  receipt: OperationsAlertReceipt,
  incidentId: string,
  kind: OperationsAlertLedgerKind,
): Promise<void> {
  const revision = receipt.result.operationsLedgerRevision;
  const expectedMetadata = receipt.result.operationsLedgerCommitMetadata;
  if (revision == null || expectedMetadata == null) {
    throw new TypeError("送信済み運用障害通知receiptにcommit証拠がありません");
  }
  const inDedicated = await containsCommit(adapter, dedicatedHead, revision);
  const inLegacy = inDedicated ? false : await containsCommit(adapter, legacyHead, revision);
  if (!inDedicated && !inLegacy) {
    throw new TypeError("送信済み運用障害通知receiptのcommitが保存refにありません");
  }
  const commit = await adapter.readCommit(revision);
  if (
    serializeCanonicalJson(commit.metadata) !==
      serializeCanonicalJson({
        schemaVersion: expectedMetadata.commitMetadataVersion,
        commitScope: expectedMetadata.commitScope,
        operationId: expectedMetadata.commitOperationId,
        ...(expectedMetadata.commitRunId == null ? {} : { runId: expectedMetadata.commitRunId }),
        changedPathManifestVersion: expectedMetadata.changedPathManifestVersion,
        changedPathManifestDigest: expectedMetadata.changedPathManifestDigest,
      }) ||
    commit.changedPathManifest.entries.length !== 1 ||
    commit.changedPathManifest.entries[0]?.path !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1
  ) {
    throw new TypeError("送信済み運用障害通知receiptのcommit metadataが一致しません");
  }
  const source = decodeStateFile(
    await adapter.readFile(revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1),
    "operations alert ledger",
  );
  if (source == null || !isCanonicalStateOperationsAlertLedgerSource(source)) {
    throw new TypeError("送信済み運用障害通知receiptのledgerが不正です");
  }
  const recorded = parseStateOperationsAlertLedger(source).operationsAlerts.find(
    (entry) => entry.incidentId === incidentId && entry.kind === kind,
  );
  if (recorded?.discordMessageId !== receipt.result.discordMessageId) {
    throw new TypeError("送信済み運用障害通知receiptのDiscord message IDが一致しません");
  }
}

/** 前回の送信済みreceiptを専用refと旧ledgerの実状態へ照合する。 */
export async function assertPriorOperationsAlertDeliveries(
  adapter: StateBranchAdapter,
  dedicatedHead: StateBranchHead,
  dedicatedAlerts: readonly RecordedAlert[],
  legacyHead: StateBranchHead,
  legacyAlerts: readonly RecordedAlert[],
  receipts: readonly OperationsAlertReceipt[],
  incidentId: string,
  kind: OperationsAlertLedgerKind,
): Promise<void> {
  const recorded = [...dedicatedAlerts, ...legacyAlerts].filter(
    (entry) => entry.incidentId === incidentId && entry.kind === kind,
  );
  if (recorded.length > 1 && new Set(recorded.map((entry) => entry.discordMessageId)).size > 1) {
    throw new OperationsAlertPendingDeliveryError(
      new TypeError("運用障害通知の専用refと旧ledgerの送信記録が一致しません"),
    );
  }
  for (const receipt of receipts) {
    if (receipt.status === "no_effect") {
      continue;
    }
    if (receipt.status === "ambiguous") {
      throw new OperationsAlertPendingDeliveryError(
        new TypeError("以前の運用障害通知receiptの送信結果が未確定です"),
      );
    }
    const matching = recorded.find(
      (entry) => entry.discordMessageId === receipt.result.discordMessageId,
    );
    if (matching == null) {
      throw new OperationsAlertPendingDeliveryError(
        new TypeError("送信済み運用障害通知receiptをexact ledgerで確認できません"),
      );
    }
    try {
      await assertSentReceiptCommit(adapter, dedicatedHead, legacyHead, receipt, incidentId, kind);
    } catch (error: unknown) {
      throw new OperationsAlertPendingDeliveryError(error);
    }
  }
}

import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import type { ManualResolutionStateEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import {
  createReceipt,
  receiptIdentifiers,
  sealObservedReceipt,
} from "../../application/tracking-run/receipt-codec.js";
import type {
  ManualResolutionReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import { assertRunTransactionMarkerTransition } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import { isOrthogonalStateCommitScope } from "../../persistence/state-commit-metadata.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { advanceMessageMarker } from "../../persistence/state-notification-transition.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  resolveManualNotificationLedger,
  startedManualResolutionAttempt,
  type ManualResolutionTarget,
} from "./manual-resolution-state.js";
import { readNotificationMessageState } from "./notification-message-state.js";

function binding(
  record: DurablePublicationRecord,
): Extract<ManualResolutionReceipt["binding"], { bindingKind: "checkpoint" }> {
  return {
    bindingKind: "checkpoint",
    runId: record.runIdentity.runId,
    checkpointDigest: record.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    runtimeIdentityDigest: digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)),
  };
}

async function previousTrackingRevision(
  adapter: StateBranchAdapter,
  parentRevision: string,
): Promise<string> {
  let revision = parentRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      return revision;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("手動解決commitの前に運用通知commitの祖先がありません");
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("手動解決commitの追跡祖先探索が上限を超えました");
}

/** 手動判断の配送、試行、checkpointを含む論理対象。 */
export function manualResolutionLogicalTarget(target: ManualResolutionTarget): string {
  return `manual:${target.checkpointDigest}:${target.deliveryId}:${target.attemptId}:${target.decision}`;
}

/** 手動判断ごとの安定したcommit operation ID。 */
export function manualResolutionOperationId(
  record: DurablePublicationRecord,
  target: ManualResolutionTarget,
): string {
  return receiptIdentifiers(
    {
      binding: binding(record),
      stage: "notifications_settled",
      phase: "notification",
      logicalTarget: manualResolutionLogicalTarget(target),
      invocationId: record.runIdentity.invocationId,
      localAttemptIndex: 0,
    },
    digest,
  ).operationId;
}

/** Git親子treeとcommit metadataから手動解決を再観測する。 */
export async function observeManualResolutionAtRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  target: ManualResolutionTarget,
  observation: Readonly<{
    invocationId: string;
    observedAt: string;
    receiptKind: "executed" | "observed";
    previousReceipt?: Pick<Receipt, "phaseSequence" | "receiptDigest">;
  }>,
): Promise<
  Readonly<{ receipt: ManualResolutionReceipt; evidence: ManualResolutionStateEvidence }>
> {
  const commit = await adapter.readCommit(revision);
  if (commit.parent.status !== "present") {
    throw new TypeError("手動解決commitの親がありません");
  }
  const [parent, current] = await Promise.all([
    readNotificationMessageState(adapter, configuration, commit.parent.revision),
    readNotificationMessageState(adapter, configuration, revision),
  ]);
  const record = parent.transaction.record;
  const operationId = manualResolutionOperationId(record, target);
  const attempt = startedManualResolutionAttempt(parent, target);
  const resolved = current.ledger.entries.find(
    (entry) => entry.notificationKey === target.notificationKeys[0],
  )?.manualResolution;
  if (
    resolved?.operationId !== operationId ||
    resolved.decision !== target.decision ||
    resolved.attemptId !== target.attemptId ||
    resolved.deliveryId !== target.deliveryId ||
    commit.metadata.commitScope !== "manual_resolution" ||
    commit.metadata.operationId !== operationId ||
    commit.metadata.runId !== target.runId ||
    commit.changedPathManifest.entries.length !== 2 ||
    !commit.changedPathManifest.entries.some(
      (entry) => entry.path === configuration.notificationLedgerPath,
    ) ||
    !commit.changedPathManifest.entries.some(
      (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    )
  ) {
    throw new TypeError("手動解決commitの判断または変更範囲が一致しません");
  }
  const expectedLedger = resolveManualNotificationLedger(
    parent,
    target,
    operationId,
    resolved.resolvedAt,
  );
  const evidence = parent.transaction.initialPagesEvidence;
  if (evidence == null) {
    throw new TypeError("手動解決commitの初回Pages証拠がありません");
  }
  const expectedMarker = advanceMessageMarker(
    parent.transaction.marker,
    expectedLedger,
    evidence,
    evidence.sourceStateRevision,
    commit.parent.revision,
    target.deliveryId,
  );
  if (
    serializeCanonicalJson(current.ledger) !== serializeCanonicalJson(expectedLedger) ||
    serializeCanonicalJson(current.transaction.marker) !== serializeCanonicalJson(expectedMarker) ||
    current.transaction.record.recordDigest !== record.recordDigest ||
    current.transaction.snapshotDigest !== parent.transaction.snapshotDigest ||
    serializeCanonicalJson(current.transaction.initialPagesEvidence) !==
      serializeCanonicalJson(evidence)
  ) {
    throw new TypeError("手動解決commitのstateが固定runの遷移と一致しません");
  }
  assertRunTransactionMarkerTransition(
    parent.transaction.marker,
    current.transaction.marker,
    commit.parent.revision,
    evidence,
  );
  const expectedTrackingRevision = await previousTrackingRevision(adapter, commit.parent.revision);
  const advance = await authorizeAdvanceAfterOrthogonalCommits(
    adapter,
    configuration,
    expectedTrackingRevision,
    commit.parent.revision,
  );
  const stateContentDigest = digest.sha256Utf8(
    serializeCanonicalJson({
      marker: current.transaction.marker,
      recordDigest: record.recordDigest,
      snapshotDigest: current.transaction.snapshotDigest,
      notificationLedgerDigest: current.transaction.notificationLedgerDigest,
    }),
  );
  const stateEvidence: ManualResolutionStateEvidence = {
    runId: target.runId,
    checkpointDigest: target.checkpointDigest,
    publicationRecordDigest: record.recordDigest,
    deliveryId: target.deliveryId,
    notificationKeys: [...target.notificationKeys],
    decision: target.decision,
    resolvedAt: resolved.resolvedAt,
    attempt: { ...attempt, notificationKeys: [...attempt.notificationKeys] },
    parentRevision: commit.parent.revision,
    resultingRevision: revision,
    parentMarker: parent.transaction.marker,
    resultingMarker: current.transaction.marker,
    expectedTrackingStateRevision: expectedTrackingRevision,
    interveningOperationsAlertCommits: [...advance.interveningOperationsAlertCommits],
    commitOperationId: operationId,
    changedPathManifestDigest: commit.metadata.changedPathManifestDigest,
    stateContentDigest,
  };
  const draft = {
    schemaVersion: 1 as const,
    receiptType: "manual_resolution" as const,
    stage: "notifications_settled" as const,
    phase: "notification" as const,
    binding: binding(record),
    logicalTarget: manualResolutionLogicalTarget(target),
    invocationId: observation.invocationId,
    localAttemptIndex: 0,
    phaseSequence:
      (observation.previousReceipt?.phaseSequence ?? parent.transaction.marker.phaseSequence) + 1,
    ...(observation.previousReceipt == null
      ? {}
      : { previousReceiptDigest: observation.previousReceipt.receiptDigest }),
    expectedStateRevision: expectedTrackingRevision,
    receiptKind: observation.receiptKind,
    observedAt: observation.observedAt,
    effectOccurredAt: resolved.resolvedAt,
    status: "resolved" as const,
    effectCertainty: "committed" as const,
    result: {
      expectedTrackingStateRevision: expectedTrackingRevision,
      actualParentStateRevision: commit.parent.revision,
      resultingStateRevision: revision,
      stateContentDigest,
      commitScope: "manual_resolution" as const,
      commitMetadataVersion: 1 as const,
      commitOperationId: operationId,
      commitRunId: target.runId,
      changedPathManifestVersion: 1 as const,
      changedPathManifestDigest: commit.metadata.changedPathManifestDigest,
      interveningOperationsAlertCommits: [...advance.interveningOperationsAlertCommits],
      deliveryId: target.deliveryId,
      deliveryAttemptId: target.attemptId,
      notificationKeys: [...target.notificationKeys],
      decision: target.decision,
    },
  };
  const receipt =
    observation.receiptKind === "observed"
      ? sealObservedReceipt(draft, digest)
      : createReceipt(draft, digest);
  if (receipt.receiptType !== "manual_resolution" || receipt.operationId !== operationId) {
    throw new TypeError("手動解決receiptのoperation IDがcommitと一致しません");
  }
  return Object.freeze({ receipt, evidence: stateEvidence });
}

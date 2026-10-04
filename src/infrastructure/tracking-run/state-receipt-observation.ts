import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  observeStateCommitReceipt,
  type ObservedStateCommitPosition,
  type StateCommitReceiptEvidence,
} from "../../application/tracking-run/observed-state-commit.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { assertRunTransactionMarkerTransition } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  type StateBranchAdapter,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  MAX_INTERVENING_COMMITS,
} from "../../persistence/state-orthogonal-advance.js";
import { assertStateCommitChain } from "../../persistence/state-commit-chain-verification.js";
import { isOrthogonalStateCommitScope } from "../../persistence/state-commit-metadata.js";
import {
  finalizedHistoryDigest,
  finalizedRunReportDigest,
} from "../../persistence/state-transaction-finalization.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort } from "./content-digest.js";

type ObservedCommit<T> = Readonly<{
  receipt: T;
  evidence: StateCommitReceiptEvidence;
}>;

type VerifiedTree = Readonly<{
  files: ReadonlyMap<string, StateFileReadResult>;
  transaction: VerifiedRunTransactionFiles;
}>;

async function readVerifiedTree(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<VerifiedTree> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length) {
    throw new TypeError("観測対象のexact state file一覧が不足しています");
  }
  const transaction = verifyRunTransactionFiles(files, configuration);
  if (transaction == null) {
    throw new TypeError("観測対象のexact stateにrun transactionがありません");
  }
  return { files, transaction };
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
      throw new TypeError("追跡commitの前に運用通知commitの祖先がありません");
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("追跡commitの祖先探索が上限を超えています");
}

async function assertCommitAncestry(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  recordDigest: string,
): Promise<Readonly<{ expectedTrackingRevision: string; intervening: readonly string[] }>> {
  let currentRevision = revision;
  let targetParent:
    Readonly<{ expectedTrackingRevision: string; intervening: readonly string[] }> | undefined;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (currentRevision === initialStateRevision) {
      if (targetParent == null) {
        throw new TypeError("後続state commitの祖先がありません");
      }
      return targetParent;
    }
    const [currentCommit, currentTree] = await Promise.all([
      adapter.readCommit(currentRevision),
      readVerifiedTree(adapter, configuration, currentRevision),
    ]);
    if (
      currentCommit.parent.status !== "present" ||
      (currentCommit.metadata.commitScope !== "tracking_run" &&
        currentCommit.metadata.commitScope !== "manual_resolution") ||
      currentCommit.metadata.runId !== currentTree.transaction.marker.runId ||
      currentTree.transaction.record.recordDigest !== recordDigest ||
      !currentCommit.changedPathManifest.entries.some(
        (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      )
    ) {
      throw new TypeError("後続state commitのmetadataとmarkerが一致しません");
    }
    const previousRevision = await previousTrackingRevision(adapter, currentCommit.parent.revision);
    const advance = await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      previousRevision,
      currentCommit.parent.revision,
    );
    const previousTree = await readVerifiedTree(adapter, configuration, previousRevision);
    if (
      previousTree.transaction.marker.runId !== currentTree.transaction.marker.runId ||
      previousTree.transaction.record.recordDigest !== recordDigest ||
      (currentTree.transaction.marker.phase !== "initial_state_committed" &&
        currentTree.transaction.marker.initialStateRevision !== initialStateRevision)
    ) {
      throw new TypeError("後続state commitのrunまたは初回revisionが一致しません");
    }
    assertRunTransactionMarkerTransition(
      previousTree.transaction.marker,
      currentTree.transaction.marker,
      currentCommit.parent.revision,
      currentTree.transaction.initialPagesEvidence,
    );
    targetParent ??= {
      expectedTrackingRevision: previousRevision,
      intervening: advance.interveningOperationsAlertCommits,
    };
    currentRevision = previousRevision;
  }
  throw new TypeError("後続state commitの祖先探索が上限を超えています");
}

/** commit metadataと全marker遷移から復旧用のstate receiptを再観測する。 */
export async function observeStateCommitAtRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  initialStateRevision: string,
  receiptType: StateCommitReceiptEvidence["receiptType"],
  observation: Readonly<{
    invocationId: string;
    observedAt: string;
    position: ObservedStateCommitPosition;
  }>,
): Promise<
  ObservedCommit<InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt>
> {
  const [tree, commit] = await Promise.all([
    readVerifiedTree(adapter, configuration, revision),
    adapter.readCommit(revision),
  ]);
  const { marker, record } = tree.transaction;
  await assertStateCommitChain(
    adapter,
    configuration,
    revision,
    tree.transaction,
    initialStateRevision,
  );
  if (
    commit.metadata.commitScope !== "tracking_run" ||
    commit.metadata.runId !== marker.runId ||
    commit.changedPathManifest.entries.every(
      (entry) => entry.path !== RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    ) ||
    observation.invocationId === record.runIdentity.invocationId
  ) {
    throw new TypeError("state commitのmetadataまたは再観測試行が不正です");
  }
  const parentRevision = commit.parent.status === "present" ? commit.parent.revision : "unborn";
  let expectedTrackingStateRevision: string;
  let interveningOperationsAlertCommits: readonly string[];
  if (receiptType === "initial_state_commit") {
    if (revision !== initialStateRevision || marker.phase !== "initial_state_committed") {
      throw new TypeError("初回state commitのrevisionまたはphaseが一致しません");
    }
    expectedTrackingStateRevision = marker.baseStateRevision;
    const advance = await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      expectedTrackingStateRevision,
      parentRevision,
    );
    interveningOperationsAlertCommits = advance.interveningOperationsAlertCommits;
  } else {
    const ancestry = await assertCommitAncestry(
      adapter,
      configuration,
      revision,
      initialStateRevision,
      record.recordDigest,
    );
    expectedTrackingStateRevision = ancestry.expectedTrackingRevision;
    interveningOperationsAlertCommits = ancestry.intervening;
  }
  const common = {
    marker,
    record: {
      runId: record.runIdentity.runId,
      checkpointDigest: record.checkpointDigest,
      checkpointFileDigest: record.checkpointFileDigest,
      runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
        serializeCanonicalJson(record.runtimeIdentity),
      ),
      recordDigest: record.recordDigest,
      notificationAction: record.notificationOutbox.action,
    },
    commit: {
      revision,
      parentRevision,
      operationId: commit.metadata.operationId,
      runId: marker.runId,
      commitScope: commit.metadata.commitScope,
      changedPathManifestDigest: commit.metadata.changedPathManifestDigest,
    },
    expectedTrackingStateRevision,
    interveningOperationsAlertCommits: [...interveningOperationsAlertCommits],
    snapshotDigest: tree.transaction.snapshotDigest,
    notificationLedgerDigest: tree.transaction.notificationLedgerDigest,
  };
  let evidence: StateCommitReceiptEvidence;
  if (receiptType === "initial_state_commit") {
    evidence = { ...common, receiptType };
  } else if (receiptType === "notification_settlement") {
    evidence = {
      ...common,
      receiptType,
      notificationHistoryDigest: finalizedHistoryDigest(tree.files, configuration, marker, record),
    };
  } else {
    evidence = {
      ...common,
      receiptType,
      runReportDigest: finalizedRunReportDigest(tree.files, configuration, marker, record),
    };
  }
  const receipt = observeStateCommitReceipt(evidence, observation, nodeContentDigestPort);
  verifyReceiptChain(
    [{ receipt, evidence: { kind: "state_commit", state: evidence } }],
    nodeContentDigestPort,
  );
  return Object.freeze({ receipt, evidence });
}

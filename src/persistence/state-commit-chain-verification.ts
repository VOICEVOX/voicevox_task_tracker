import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../application/tracking-run/contracts/recovery-paths.js";
import { stateCommitReceiptOperationId } from "../application/tracking-run/observed-state-commit.js";
import { assertRunTransactionMarkerTransition } from "../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import {
  exactStateValidationSession,
  type ExactStateValidationSession,
} from "./exact-state-validation-session.js";
import {
  assertInitialStateWriteManifest,
  reconstructLegacyInitialStateWriteManifest,
} from "./initial-state-write-manifest.js";
import { assertLegacyInitialStateHistory } from "./legacy-initial-state-history.js";
import {
  isVerifiedStateCasCandidateTree,
  type VerifiedStateCasCandidateTree,
} from "./state-cas-candidate.js";
import {
  createStateChangedPathManifest,
  isOrthogonalStateCommitScope,
} from "./state-commit-metadata.js";
import { initialNotificationLedger } from "./state-initial-notification-transition.js";
import { loadStateNotificationLedgers } from "./state-ledger-files.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { assertFinalizationTransition } from "./state-commit-chain-finalization.js";
import { assertNotificationCommitTransition } from "./state-commit-chain-notification.js";
import {
  assertTrackingCommitPaths,
  type VerifiedCommitTree as VerifiedTree,
} from "./state-commit-chain-paths.js";
import {
  assertSettledOutboxLedger,
  assertSettlementParentPhase,
} from "./state-commit-chain-settlement.js";
import { advanceSettlementMarker } from "./state-notification-transition.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  MAX_INTERVENING_COMMITS,
} from "./state-orthogonal-advance.js";
import {
  verifyRunTransactionFiles,
  verifyLegacyCompletedRunTransactionAncestor,
  runTransactionSnapshot,
  runTransactionNotificationLedger,
  type VerifiedRunTransactionFiles,
} from "./state-transaction-files.js";

/** 同じ祖先走査で確定した先頭commitと追跡親。 */
export type StateCommitChainResult = Readonly<{
  latestTrackingRevision: string;
  initialStateRevision: string;
  expectedTrackingStateRevision: string;
  interveningOperationsAlertCommits: readonly string[];
}>;

const chainProofs = new WeakMap<ExactStateValidationSession, Map<string, StateCommitChainResult>>();

async function readFullTree(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
): Promise<ReadonlyMap<string, StateFileReadResult>> {
  if (head.status === "missing") {
    return new Map();
  }
  const paths = await adapter.listFiles(head.revision, "state");
  const files = await adapter.readFiles(head.revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("初回commitのexact treeを全件読み取れません");
  }
  return files;
}

async function assertInitialWriteSet(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  commit: Awaited<ReturnType<StateBranchAdapter["readCommit"]>>,
  current: VerifiedTree,
  candidate: VerifiedStateCasCandidateTree | undefined,
  allowLegacyReconstruction: boolean,
): Promise<void> {
  const record = current.transaction.record;
  const legacy = !("initialStateWriteManifest" in record);
  if (
    legacy &&
    (!allowLegacyReconstruction ||
      (current.transaction.snapshotSchemaVersion !== "21" &&
        current.transaction.snapshotSchemaVersion !== "22"))
  ) {
    throw new TypeError("旧初回commitの履歴とAI cacheを元recordから証明できません");
  }
  let before: ReadonlyMap<string, StateFileReadResult>;
  let after: ReadonlyMap<string, StateFileReadResult>;
  let changed: ReturnType<typeof createStateChangedPathManifest>;
  if (candidate != null) {
    const parentRevision = commit.parent.status === "present" ? commit.parent.revision : "unborn";
    if (
      candidate.revision !== commit.revision ||
      candidate.parentRevision !== parentRevision ||
      candidate.files !== current.files
    ) {
      throw new TypeError("初回commitの候補証明とGit祖先が一致しません");
    }
    before = candidate.before;
    after = candidate.after;
    changed = candidate.changedPathManifest;
  } else {
    const [parentFiles, currentFiles] = await Promise.all([
      readFullTree(adapter, commit.parent),
      readFullTree(adapter, { status: "present", revision: commit.revision }),
    ]);
    const paths = new Set([...parentFiles.keys(), ...currentFiles.keys()]);
    const fullBefore = new Map<string, StateFileReadResult>();
    const fullAfter = new Map<string, StateFileReadResult>();
    for (const path of paths) {
      fullBefore.set(path, parentFiles.get(path) ?? { status: "missing" });
      fullAfter.set(path, currentFiles.get(path) ?? { status: "missing" });
    }
    before = fullBefore;
    after = fullAfter;
    changed = createStateChangedPathManifest(before, after);
  }
  if (serializeCanonicalJson(changed) !== serializeCanonicalJson(commit.changedPathManifest)) {
    throw new TypeError("初回commitの親tree差分とGit変更manifestが一致しません");
  }
  const historyPath = joinStatePath(
    configuration.historyDirectory,
    `${record.initialPagesProjection.generatedAt.slice(0, 10)}.jsonl`,
  );
  if (legacy) {
    assertLegacyInitialStateHistory(
      configuration,
      historyPath,
      {
        snapshot: runTransactionSnapshot(current.transaction),
        inputEventsDigest: record.initialStateContentDigests.historyInputEvents,
        generatedAt: record.initialPagesProjection.generatedAt,
        timezone: record.initialPagesProjection.settings.timezone,
      },
      before,
      after,
    );
  }
  const manifest =
    record.initialStateWriteManifest ??
    reconstructLegacyInitialStateWriteManifest(configuration, historyPath, before, after, changed);
  assertInitialStateWriteManifest(
    manifest,
    configuration,
    historyPath,
    record.runIdentity.runId,
    before,
    after,
    changed,
    record.initialStateContentDigests,
  );
}

async function readVerifiedAt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
  legacyCompleted: boolean,
): Promise<VerifiedTree> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("Git祖先のexact state treeが不足しています");
  }
  const verify = legacyCompleted
    ? verifyLegacyCompletedRunTransactionAncestor
    : verifyRunTransactionFiles;
  const transaction = verify(
    files,
    configuration,
    exactStateValidationSession(adapter, configuration).validation,
  );
  if (transaction == null) {
    throw new TypeError("Git祖先にrun transactionがありません");
  }
  return { files, transaction };
}

async function previousTrackingRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  headRevision: string,
): Promise<string> {
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      return revision;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("運用通知commitの前に追跡runのcommitがありません");
    }
    await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      commit.parent.revision,
      revision,
    );
    revision = commit.parent.revision;
  }
  throw new TypeError("追跡runのcommit探索が上限を超えています");
}

function assertCommitOperation(
  scope: "tracking_run" | "manual_resolution",
  operationId: string,
  current: VerifiedTree,
  previous: VerifiedTree | undefined,
  configuration: StatePersistenceConfiguration,
): void {
  const marker = current.transaction.marker;
  if (marker.phase === "notifications_in_progress") {
    if (previous == null) {
      throw new TypeError("通知commitの追跡祖先がありません");
    }
    assertNotificationCommitTransition(previous, current, configuration, scope, operationId);
    return;
  }
  if (scope !== "tracking_run") {
    throw new TypeError("state commitのscopeが不正です");
  }
  let receiptType: "initial_state_commit" | "notification_settlement" | "run_finalization";
  if (marker.phase === "initial_state_committed") {
    receiptType = "initial_state_commit";
  } else if (marker.phase === "notifications_settled") {
    receiptType = "notification_settlement";
  } else {
    receiptType = "run_finalization";
  }
  if (marker.phase === "initial_state_committed" && previous != null) {
    throw new TypeError("初回state commitの追跡祖先が不正です");
  }
  const expected = stateCommitReceiptOperationId(
    receiptType,
    marker.runId,
    marker.checkpointDigest,
    nodeContentDigestPort,
  );
  if (operationId !== expected) {
    throw new TypeError("state commitのoperation IDが保存済み値と一致しません");
  }
}

/** headから初回commitまでの全Git祖先とtransaction遷移を検証する。 */
export async function verifyStateCommitChain(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  headRevision: string,
  verified: VerifiedRunTransactionFiles,
  initialStateRevision: string,
  latestTree?: VerifiedTree & Readonly<{ revision: string }>,
): Promise<StateCommitChainResult> {
  const session = exactStateValidationSession(adapter, configuration);
  adapter = session.adapter;
  const legacyCompleted = !("initialStateWriteManifest" in verified.record);
  if (
    legacyCompleted &&
    (verified.marker.phase !== "run_finalized" ||
      (verified.snapshotSchemaVersion !== "21" && verified.snapshotSchemaVersion !== "22"))
  ) {
    throw new TypeError("旧永続recordは完了済みv21・v22のrunだけで読み取れます");
  }
  const proofKey = serializeCanonicalJson([
    session.readGeneration,
    headRevision,
    initialStateRevision,
    verified.marker,
    verified.record.recordDigest,
  ]);
  const latestRevision = await previousTrackingRevision(adapter, configuration, headRevision);
  if (
    latestTree != null &&
    isVerifiedStateCasCandidateTree(latestTree) &&
    (latestTree.revision !== headRevision || latestRevision !== headRevision)
  ) {
    throw new TypeError("CAS候補証明のrevisionがchain先頭と一致しません");
  }
  const latest =
    latestTree != null && latestRevision === headRevision && latestTree.revision === headRevision
      ? latestTree
      : await readVerifiedAt(adapter, configuration, latestRevision, legacyCompleted);
  if (
    serializeCanonicalJson(latest.transaction.marker) !== serializeCanonicalJson(verified.marker) ||
    latest.transaction.record.recordDigest !== verified.record.recordDigest
  ) {
    throw new TypeError("headの検証済みtransactionとGit祖先の先頭が一致しません");
  }
  const retained = chainProofs.get(session)?.get(proofKey);
  if (retained != null) return retained;
  let revision = latestRevision;
  let current = latest;
  let targetParent:
    | Readonly<{
        expectedTrackingStateRevision: string;
        interveningOperationsAlertCommits: readonly string[];
      }>
    | undefined;
  let settled: VerifiedTree | undefined;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    const parentRevision = commit.parent.status === "present" ? commit.parent.revision : "unborn";
    if (
      (commit.metadata.commitScope !== "tracking_run" &&
        commit.metadata.commitScope !== "manual_resolution") ||
      commit.metadata.runId !== verified.marker.runId ||
      current.transaction.marker.expectedParentStateRevision !== parentRevision ||
      current.transaction.marker.runId !== verified.marker.runId ||
      current.transaction.record.recordDigest !== verified.record.recordDigest ||
      current.transaction.snapshotSchemaVersion !== verified.snapshotSchemaVersion ||
      !commit.changedPathManifest.entries.some(
        (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      )
    ) {
      throw new TypeError("Git祖先のcommit metadataとtransactionが一致しません");
    }
    if (revision === initialStateRevision) {
      if (
        current.transaction.marker.phase !== "initial_state_committed" ||
        current.transaction.snapshotDigest !==
          current.transaction.record.initialStateContentDigests.snapshot ||
        current.transaction.notificationLedgerDigest !==
          current.transaction.record.initialStateContentDigests.notificationLedger
      ) {
        throw new TypeError("初回state commitと現在のrecord chainが一致しません");
      }
      assertCommitOperation(
        commit.metadata.commitScope,
        commit.metadata.operationId,
        current,
        undefined,
        configuration,
      );
      const parentLedger = await loadStateNotificationLedgers(
        adapter,
        configuration,
        commit.parent,
      );
      const expectedLedger = initialNotificationLedger(parentLedger, current.transaction.record);
      const actualLedger = runTransactionNotificationLedger(current.transaction);
      if (
        serializeCanonicalJson(normalNotificationLedgerValue(actualLedger)) !==
        serializeCanonicalJson(normalNotificationLedgerValue(expectedLedger))
      ) {
        throw new TypeError(
          "初回state commitのledgerが固定outboxと親stateから導出した値と一致しません",
        );
      }
      await assertTrackingCommitPaths(adapter, configuration, commit, current, undefined);
      await assertInitialWriteSet(
        adapter,
        configuration,
        commit,
        current,
        isVerifiedStateCasCandidateTree(latest) && revision === latestRevision ? latest : undefined,
        legacyCompleted,
      );
      if (settled != null) {
        assertSettledOutboxLedger(current, settled, configuration);
      }
      const advance = await authorizeAdvanceAfterOrthogonalCommits(
        adapter,
        configuration,
        current.transaction.marker.baseStateRevision,
        parentRevision,
      );
      const result = Object.freeze({
        latestTrackingRevision: latestRevision,
        initialStateRevision,
        ...(targetParent ?? {
          expectedTrackingStateRevision: current.transaction.marker.baseStateRevision,
          interveningOperationsAlertCommits: advance.interveningOperationsAlertCommits,
        }),
      });
      let byKey = chainProofs.get(session);
      if (byKey == null) {
        byKey = new Map();
        chainProofs.set(session, byKey);
      }
      byKey.set(proofKey, result);
      return result;
    }
    if (commit.parent.status !== "present") {
      throw new TypeError("Git祖先が初回state commitに到達しません");
    }
    const previousRevision = await previousTrackingRevision(
      adapter,
      configuration,
      commit.parent.revision,
    );
    const advance = await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      previousRevision,
      commit.parent.revision,
    );
    targetParent ??= {
      expectedTrackingStateRevision: previousRevision,
      interveningOperationsAlertCommits: advance.interveningOperationsAlertCommits,
    };
    const previous = await readVerifiedAt(
      adapter,
      configuration,
      previousRevision,
      legacyCompleted,
    );
    if (
      current.transaction.marker.phase === "initial_state_committed" ||
      current.transaction.marker.initialStateRevision !== initialStateRevision ||
      previous.transaction.marker.runId !== verified.marker.runId ||
      previous.transaction.record.recordDigest !== verified.record.recordDigest
    ) {
      throw new TypeError("Git祖先のrunまたは初回revisionが一致しません");
    }
    assertRunTransactionMarkerTransition(
      previous.transaction.marker,
      current.transaction.marker,
      parentRevision,
      current.transaction.initialPagesEvidence,
    );
    if (
      current.transaction.initialPagesEvidence?.pageUrl !==
      current.transaction.record.initialPagesProjection.settings.url
    ) {
      throw new TypeError("Git祖先のPages証拠が固定公開URLと一致しません");
    }
    if (current.transaction.marker.phase === "notifications_settled") {
      assertSettlementParentPhase(current.transaction.record, previous.transaction.marker.phase);
      const evidence = current.transaction.initialPagesEvidence;
      const expectedMarker = advanceSettlementMarker(
        previous.transaction.marker,
        evidence,
        evidence.sourceStateRevision,
        parentRevision,
        previous.transaction.notificationLedgerDigest,
      );
      if (
        serializeCanonicalJson(expectedMarker) !==
        serializeCanonicalJson(current.transaction.marker)
      ) {
        throw new TypeError("通知settlementのmarkerが親stateから導出した値と一致しません");
      }
      settled = {
        transaction: current.transaction,
        files: new Map(
          [...current.files].filter(([path]) => path === configuration.notificationLedgerPath),
        ),
      };
    }
    if (current.transaction.marker.phase === "run_finalized") {
      assertFinalizationTransition(previous, current, configuration);
    }
    assertCommitOperation(
      commit.metadata.commitScope,
      commit.metadata.operationId,
      current,
      previous,
      configuration,
    );
    await assertTrackingCommitPaths(adapter, configuration, commit, current, previous);
    revision = previousRevision;
    current = previous;
  }
  throw new TypeError("state commitのGit祖先探索が上限を超えています");
}

/** headから初回commitまでの全Git祖先とtransaction遷移を検証する。 */
export async function assertStateCommitChain(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  headRevision: string,
  verified: VerifiedRunTransactionFiles,
  initialStateRevision: string,
  latestTree?: VerifiedTree & Readonly<{ revision: string }>,
): Promise<string> {
  const result = await verifyStateCommitChain(
    adapter,
    configuration,
    headRevision,
    verified,
    initialStateRevision,
    latestTree,
  );
  return result.latestTrackingRevision;
}

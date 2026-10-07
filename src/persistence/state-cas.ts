import type { PerformanceDetailObserver } from "../application/tracking-run/contracts/performance-detail-observation.js";
import { assertRunTransactionMarkerTransition } from "../application/tracking-run/run-transaction-marker.js";
import {
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { exactStateValidationSession } from "./exact-state-validation-session.js";
import { StateBranchConflictError } from "./errors.js";
import { assertStateCommitChain } from "./state-commit-chain-verification.js";
import {
  assertStateCasCandidateFilesUnchanged,
  copyStateCasCandidateFiles,
  verifyStateCasCandidate,
  verifyStateCasCandidateTransaction,
} from "./state-cas-candidate.js";
import {
  materializeCommitRequest,
  observeCommittedStateWrite,
  type StateCasCommitRequestInput,
  type StateCasWriteResult,
} from "./state-cas-observation.js";
import { digestStateManifest, isOrthogonalStateCommitScope } from "./state-commit-metadata.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  findInitialStateRevision,
  type OrthogonalCommitAdvance,
} from "./state-orthogonal-advance.js";
import { verifyRunTransactionFiles } from "./state-transaction-files.js";

export {
  type StateCasCommitRequestFactory,
  type StateCasWriteResult,
} from "./state-cas-observation.js";
export {
  authorizeAdvanceAfterOrthogonalCommits,
  type OrthogonalCommitAdvance,
} from "./state-orthogonal-advance.js";

/** 一つのremote commit treeから得た全state file。 */
export type ExactStateTree = Readonly<{
  observedHead: StateBranchHead;
  files: ReadonlyMap<string, StateFileReadResult>;
}>;

/** remote refを固定して、そのcommit treeにあるstate fileだけを読む。 */
export async function readExactStateTree(
  adapter: StateBranchAdapter,
  branch: string,
): Promise<ExactStateTree> {
  const observedHead = await adapter.resolveHead(branch);
  if (observedHead.status === "missing") {
    return Object.freeze({ observedHead, files: new Map<string, StateFileReadResult>() });
  }
  const paths = await adapter.listFiles(observedHead.revision, "state");
  const files = await adapter.readFiles(observedHead.revision, paths);
  if (files.size !== paths.length) {
    throw new TypeError("exact state treeのfile一覧と読み取り結果が一致しません");
  }
  return Object.freeze({ observedHead, files });
}

/** 指定した親からcommit候補を作り、非force pushの結果をremoteで確定する。 */
export async function writeStateCas(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedTrackingHead: StateBranchHead,
  requestInput: StateCasCommitRequestInput,
  observePerformanceDetail?: PerformanceDetailObserver,
): Promise<StateCasWriteResult> {
  validateStatePersistenceConfiguration(configuration);
  const session = exactStateValidationSession(adapter, configuration, observePerformanceDetail);
  adapter = session.adapter;
  const observedHead = await adapter.resolveHead(configuration.branch);
  if (
    observedHead.status === "present" &&
    (expectedTrackingHead.status === "missing" ||
      observedHead.revision !== expectedTrackingHead.revision)
  ) {
    try {
      const observed = await observeCommittedStateWrite(
        adapter,
        configuration,
        expectedTrackingHead,
        observedHead.revision,
        requestInput,
      );
      if (observed != null) {
        return observed;
      }
    } catch (error: unknown) {
      if (error instanceof StateBranchConflictError) {
        return Object.freeze({ status: "conflict", observedHead });
      }
      throw error;
    }
  }
  let advance: OrthogonalCommitAdvance;
  if (observedHead.status === "missing") {
    if (expectedTrackingHead.status !== "missing") {
      return Object.freeze({ status: "conflict", observedHead });
    }
    advance = Object.freeze({
      expectedTrackingStateRevision: "unborn",
      actualParentStateRevision: "unborn",
      interveningOperationsAlertCommits: Object.freeze([]),
    });
  } else {
    try {
      advance = await authorizeAdvanceAfterOrthogonalCommits(
        adapter,
        configuration,
        expectedTrackingHead.status === "present" ? expectedTrackingHead.revision : "unborn",
        observedHead.revision,
      );
    } catch (error: unknown) {
      if (error instanceof StateBranchConflictError) {
        return Object.freeze({ status: "conflict", observedHead });
      }
      throw error;
    }
  }
  const previousFiles =
    observedHead.status === "present"
      ? await adapter.readFiles(
          observedHead.revision,
          await adapter.listFiles(observedHead.revision, "state"),
        )
      : new Map<string, StateFileReadResult>();
  const previousVerified = verifyRunTransactionFiles(
    previousFiles,
    configuration,
    session.validation,
  );
  observePerformanceDetail?.({
    step: "cas_previous_transaction_verified",
    count: previousFiles.size,
  });
  if (previousVerified != null && observedHead.status === "present") {
    if (
      previousVerified.snapshotSchemaVersion === "21" &&
      previousVerified.marker.phase !== "run_finalized"
    ) {
      throw new TypeError("旧版の未完了runはexact runtimeで再開してください");
    }
    await assertStateCommitChain(
      adapter,
      configuration,
      observedHead.revision,
      previousVerified,
      previousVerified.marker.phase === "initial_state_committed"
        ? await findInitialStateRevision(
            adapter,
            configuration,
            observedHead.revision,
            previousVerified.marker.runId,
          )
        : previousVerified.marker.initialStateRevision,
      { revision: observedHead.revision, files: previousFiles, transaction: previousVerified },
    );
  }
  const request = await materializeCommitRequest(requestInput, observedHead, advance, adapter);
  let commit: StateBranchCommitResult;
  try {
    commit = await adapter.commit({
      ...request,
      branch: configuration.branch,
      expectedHead: observedHead,
    });
  } catch (error: unknown) {
    if (error instanceof StateBranchConflictError) {
      return Object.freeze({
        status: "conflict",
        observedHead: await adapter.resolveHead(configuration.branch),
      });
    }
    throw error;
  }
  observePerformanceDetail?.({
    step: "cas_adapter_commit_completed",
    count: request.updates.length,
    bytes: request.updates.reduce((total, update) => total + update.bytes.length, 0),
  });
  const inspectedCommit = await adapter.readCommit(commit.revision);
  if (
    inspectedCommit.metadata.changedPathManifestDigest !==
      commit.metadata.changedPathManifestDigest ||
    inspectedCommit.metadata.operationId !== commit.metadata.operationId ||
    inspectedCommit.metadata.commitScope !== commit.metadata.commitScope ||
    inspectedCommit.metadata.runId !== commit.metadata.runId ||
    commit.metadata.operationId !== request.commitIdentity.operationId ||
    commit.metadata.changedPathManifestDigest !== digestStateManifest(commit.changedPathManifest) ||
    inspectedCommit.parent.status !== observedHead.status ||
    (inspectedCommit.parent.status === "present" &&
      observedHead.status === "present" &&
      inspectedCommit.parent.revision !== observedHead.revision)
  ) {
    throw new TypeError("commit候補のmetadataをexact commitから照合できません");
  }
  const candidate = await verifyStateCasCandidate(adapter, inspectedCommit, request);
  observePerformanceDetail?.({ step: "cas_candidate_tree_read", count: candidate.files.size });
  const candidateTree = verifyStateCasCandidateTransaction(
    candidate,
    configuration,
    !isOrthogonalStateCommitScope(commit.metadata.commitScope),
    session.validation,
  );
  if ("build" in requestInput && requestInput.verifyCandidate != null) {
    const inspectionFiles = copyStateCasCandidateFiles(candidate);
    await requestInput.verifyCandidate(
      inspectionFiles,
      commit.revision,
      request,
      candidateTree?.transaction,
    );
    assertStateCasCandidateFilesUnchanged(candidate, inspectionFiles);
  }
  const verifiedCandidate = candidateTree?.transaction;
  observePerformanceDetail?.({
    step: "cas_current_transaction_verified",
    count: candidate.files.size,
  });
  if (previousVerified != null && verifiedCandidate == null) {
    throw new TypeError("既存run transactionをcommit候補から削除できません");
  }
  if (verifiedCandidate != null) {
    const previousMarker = previousVerified?.marker;
    if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      assertRunTransactionMarkerTransition(
        previousMarker,
        verifiedCandidate.marker,
        observedHead.status === "present" ? observedHead.revision : "unborn",
        verifiedCandidate.initialPagesEvidence,
      );
      if (
        previousMarker?.phase === "initial_state_committed" &&
        verifiedCandidate.marker.phase !== "initial_state_committed" &&
        (observedHead.status !== "present" ||
          verifiedCandidate.marker.initialStateRevision !==
            (await findInitialStateRevision(
              adapter,
              configuration,
              observedHead.revision,
              previousMarker.runId,
            )))
      ) {
        throw new TypeError("最初の通知commitが初回state revisionを固定していません");
      }
    } else if (previousMarker == null) {
      throw new TypeError("運用通知commitがmarkerを新設しています");
    }
    if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      await assertStateCommitChain(
        adapter,
        configuration,
        commit.revision,
        verifiedCandidate,
        verifiedCandidate.marker.phase === "initial_state_committed"
          ? commit.revision
          : verifiedCandidate.marker.initialStateRevision,
        candidateTree,
      );
      observePerformanceDetail?.({ step: "cas_commit_chain_verified" });
    }
  }
  try {
    await adapter.publish({ branch: configuration.branch, revision: commit.revision });
  } catch {
    const after = await adapter.resolveHead(configuration.branch);
    if (after.status === "present") {
      try {
        const observed = await observeCommittedStateWrite(
          adapter,
          configuration,
          expectedTrackingHead,
          after.revision,
          requestInput,
        );
        if (observed?.status === "committed" && observed.commit.revision === commit.revision) {
          return observed;
        }
      } catch (observationError: unknown) {
        if (!(observationError instanceof StateBranchConflictError)) {
          throw observationError;
        }
      }
    }
    if (
      after.status === "present" &&
      observedHead.status === "present" &&
      after.revision === observedHead.revision
    ) {
      return Object.freeze({ status: "no_effect", candidateRevision: commit.revision, advance });
    }
    if (after.status === "missing" && observedHead.status === "missing") {
      return Object.freeze({ status: "no_effect", candidateRevision: commit.revision, advance });
    }
    return Object.freeze({ status: "conflict", observedHead: after });
  }
  observePerformanceDetail?.({ step: "cas_published" });
  return Object.freeze({ status: "committed", commit, advance, observed: false });
}

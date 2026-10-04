import { assertRunTransactionMarkerTransition } from "../application/tracking-run/run-transaction-marker.js";
import {
  type StateBranchAdapter,
  type StateBranchCommitInspection,
  type StateBranchCommitRequest,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateBranchConflictError } from "./errors.js";
import { verifyStateCasCandidate } from "./state-cas-candidate.js";
import { assertStateCommitChain } from "./state-commit-chain-verification.js";
import type { StateCommitIdentity } from "./state-commit-metadata.js";
import {
  createStateChangedPathManifest,
  digestStateManifest,
  isOrthogonalStateCommitScope,
} from "./state-commit-metadata.js";
import {
  authorizeAdvanceAfterOrthogonalCommits,
  findInitialStateRevision,
  MAX_INTERVENING_COMMITS,
  type OrthogonalCommitAdvance,
} from "./state-orthogonal-advance.js";
import {
  verifyCurrentRunTransactionFiles,
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "./state-transaction-files.js";

/** CAS commit候補のremote反映と再観測結果。 */
export type StateCasWriteResult =
  | Readonly<{
      status: "committed";
      commit: StateBranchCommitResult;
      advance: OrthogonalCommitAdvance;
      observed: boolean;
    }>
  | Readonly<{ status: "no_effect"; candidateRevision: string; advance: OrthogonalCommitAdvance }>
  | Readonly<{ status: "conflict"; observedHead: StateBranchHead }>;

/** 実際のCAS親が確定してからstate変更を組み立てる。 */
export type StateCasCommitRequestFactory = Readonly<{
  commitIdentity: StateCommitIdentity;
  verifyCandidate?: (
    files: ReadonlyMap<string, StateFileReadResult>,
    revision: string,
    request: Omit<StateBranchCommitRequest, "branch" | "expectedHead">,
  ) => void | Promise<void>;
  build: (
    parent: StateBranchHead,
    advance: OrthogonalCommitAdvance,
  ) =>
    | Omit<StateBranchCommitRequest, "branch" | "expectedHead">
    | Promise<Omit<StateBranchCommitRequest, "branch" | "expectedHead">>;
}>;

export type StateCasCommitRequestInput =
  Omit<StateBranchCommitRequest, "branch" | "expectedHead"> | StateCasCommitRequestFactory;

export async function materializeCommitRequest(
  input: StateCasCommitRequestInput,
  parent: StateBranchHead,
  advance: OrthogonalCommitAdvance,
): Promise<Omit<StateBranchCommitRequest, "branch" | "expectedHead">> {
  if (!("build" in input)) {
    return input;
  }
  const request = await input.build(parent, advance);
  if (
    request.commitIdentity.operationId !== input.commitIdentity.operationId ||
    request.commitIdentity.commitScope !== input.commitIdentity.commitScope ||
    request.commitIdentity.runId !== input.commitIdentity.runId
  ) {
    throw new TypeError("CAS request factoryのcommit identityが変化しました");
  }
  return request;
}

async function verifiedFilesAtRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<VerifiedRunTransactionFiles | undefined> {
  const paths = await adapter.listFiles(revision, "state");
  return verifyRunTransactionFiles(await adapter.readFiles(revision, paths), configuration);
}

async function authorizeObservedSuccessors(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  candidate: StateBranchCommitInspection,
  successorsNewestFirst: readonly StateBranchCommitInspection[],
): Promise<void> {
  let previousRevision = candidate.revision;
  let previous = await verifiedFilesAtRevision(adapter, configuration, previousRevision);
  for (const successor of [...successorsNewestFirst].reverse()) {
    if (successor.parent.status !== "present" || successor.parent.revision !== previousRevision) {
      throw new StateBranchConflictError();
    }
    if (isOrthogonalStateCommitScope(successor.metadata.commitScope)) {
      await authorizeAdvanceAfterOrthogonalCommits(
        adapter,
        configuration,
        previousRevision,
        successor.revision,
      );
    } else {
      if (
        successor.metadata.runId == null ||
        successor.metadata.runId !== candidate.metadata.runId ||
        previous?.record.recordDigest == null
      ) {
        throw new StateBranchConflictError();
      }
      const next = await verifiedFilesAtRevision(adapter, configuration, successor.revision);
      if (next?.record.recordDigest !== previous.record.recordDigest) {
        throw new StateBranchConflictError();
      }
      try {
        assertRunTransactionMarkerTransition(
          previous.marker,
          next.marker,
          previousRevision,
          next.initialPagesEvidence,
        );
        if (
          previous.marker.phase === "initial_state_committed" &&
          next.marker.phase !== "initial_state_committed" &&
          next.marker.initialStateRevision !==
            (await findInitialStateRevision(
              adapter,
              configuration,
              previousRevision,
              previous.marker.runId,
            ))
        ) {
          throw new TypeError("初回state revisionがmarkerの保存commitと一致しません");
        }
      } catch (error: unknown) {
        throw new StateBranchConflictError({ cause: error });
      }
      previous = next;
    }
    previousRevision = successor.revision;
  }
}

export async function observeCommittedStateWrite(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedTrackingHead: StateBranchHead,
  observedHeadRevision: string,
  requestInput: StateCasCommitRequestInput,
): Promise<StateCasWriteResult | undefined> {
  let revision = observedHeadRevision;
  const successorsNewestFirst: StateBranchCommitInspection[] = [];
  const expectedRevision =
    expectedTrackingHead.status === "present" ? expectedTrackingHead.revision : "unborn";
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (revision === expectedRevision) {
      return undefined;
    }
    let inspected: StateBranchCommitInspection;
    try {
      inspected = await adapter.readCommit(revision);
    } catch (error: unknown) {
      throw new StateBranchConflictError({ cause: error });
    }
    if (inspected.metadata.operationId === requestInput.commitIdentity.operationId) {
      const actualParent =
        inspected.parent.status === "present" ? inspected.parent.revision : "unborn";
      let advance: OrthogonalCommitAdvance;
      if (actualParent === "unborn") {
        if (expectedRevision !== "unborn") {
          throw new StateBranchConflictError();
        }
        advance = Object.freeze({
          expectedTrackingStateRevision: "unborn",
          actualParentStateRevision: "unborn",
          interveningOperationsAlertCommits: Object.freeze([]),
        });
      } else {
        advance = await authorizeAdvanceAfterOrthogonalCommits(
          adapter,
          configuration,
          expectedRevision,
          actualParent,
        );
      }
      const request = await materializeCommitRequest(requestInput, inspected.parent, advance);
      if (
        inspected.metadata.commitScope !== request.commitIdentity.commitScope ||
        inspected.metadata.runId !== request.commitIdentity.runId
      ) {
        throw new StateBranchConflictError();
      }
      const changedPaths = [...request.updates.map((update) => update.path), ...request.deletions];
      const before =
        inspected.parent.status === "missing"
          ? new Map(
              changedPaths.map((path) => [
                path,
                { status: "missing" } satisfies StateFileReadResult,
              ]),
            )
          : await adapter.readFiles(inspected.parent.revision, changedPaths);
      const after = new Map<string, StateFileReadResult>([
        ...request.updates.map(
          (update) =>
            [
              update.path,
              { status: "present", bytes: update.bytes } satisfies StateFileReadResult,
            ] satisfies [string, StateFileReadResult],
        ),
        ...request.deletions.map(
          (path) =>
            [path, { status: "missing" } satisfies StateFileReadResult] satisfies [
              string,
              StateFileReadResult,
            ],
        ),
      ]);
      const manifest = createStateChangedPathManifest(before, after);
      if (digestStateManifest(manifest) !== inspected.metadata.changedPathManifestDigest) {
        throw new StateBranchConflictError();
      }
      try {
        const candidateFiles = await verifyStateCasCandidate(adapter, inspected, request);
        if (!isOrthogonalStateCommitScope(inspected.metadata.commitScope)) {
          verifyCurrentRunTransactionFiles(candidateFiles, configuration);
        }
        if ("build" in requestInput) {
          await requestInput.verifyCandidate?.(candidateFiles, inspected.revision, request);
        }
      } catch (error: unknown) {
        throw new StateBranchConflictError({ cause: error });
      }
      try {
        await authorizeObservedSuccessors(adapter, configuration, inspected, successorsNewestFirst);
        const latest = await verifiedFilesAtRevision(adapter, configuration, observedHeadRevision);
        if (latest != null) {
          await assertStateCommitChain(
            adapter,
            configuration,
            observedHeadRevision,
            latest,
            latest.marker.phase === "initial_state_committed"
              ? await findInitialStateRevision(
                  adapter,
                  configuration,
                  observedHeadRevision,
                  latest.marker.runId,
                )
              : latest.marker.initialStateRevision,
          );
        }
      } catch (error: unknown) {
        throw new StateBranchConflictError({ cause: error });
      }
      return Object.freeze({
        status: "committed",
        commit: Object.freeze({
          revision: inspected.revision,
          branchCreated: inspected.parent.status === "missing",
          metadata: inspected.metadata,
          changedPathManifest: inspected.changedPathManifest,
        }),
        advance,
        observed: true,
      });
    }
    if (inspected.parent.status === "missing") {
      return undefined;
    }
    successorsNewestFirst.push(inspected);
    revision = inspected.parent.revision;
  }
  throw new StateBranchConflictError({
    cause: new TypeError("再観測するstate commitが上限を超えています"),
  });
}

import type { ReducedCodexDecision } from "../../../codex/index.js";
import type {
  AiAnalysisDependency,
  TrackedItemAiDependencies,
} from "../../../domain/ai-analysis-dependencies.js";
import type {
  SourceId,
  StalenessResult,
  TrackedItemAiAnalysisApplications,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { FreshObservedGitHubItem } from "../../../github/index.js";
import type { SnapshotTrackedItem } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  revalidatedHistoricalAiDependency,
  revalidatedHistoricalAiDependencyForExpected,
} from "./history.js";
import { notDependentAiDependency, preferIndependentAiDependency } from "./selection.js";
import {
  candidateAiDependency,
  isPullRequestReviewWait,
  lastHumanReviewAt,
  lastResponsibleHumanActivityAt,
  latestEventTime,
  sameWaitingOnEntities,
  transitionBasisAiDependency,
  type AiDependencyTimeCandidate,
} from "./stall-time.js";

/** 停滞開始時刻のAI依存を選ぶ。 */
export function stallSinceAiDependency(
  item: FreshObservedGitHubItem,
  applications: TrackedItemAiAnalysisApplications,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  decision: ReducedCodexDecision,
  staleness: StalenessResult,
  itemDependencies: TrackedItemAiDependencies,
  previousItem: SnapshotTrackedItem | undefined,
  statusBasis: Readonly<{
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  responsibilityBasis: Readonly<{
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  deterministicTransitionDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  const stateDependencies = {
    status: itemDependencies.status,
    waitingOn: itemDependencies.waitingOn,
    evidence: itemDependencies.evidence,
  };
  const statusTransitionDependency = transitionBasisAiDependency(
    item,
    sourceOccurredAtById,
    decision,
    statusBasis,
    itemDependencies,
    deterministicTransitionDependency,
  );
  const responsibilityTransitionDependency = transitionBasisAiDependency(
    item,
    sourceOccurredAtById,
    decision,
    responsibilityBasis,
    itemDependencies,
    deterministicTransitionDependency,
  );
  const statusBasisDependency = candidateAiDependency(statusTransitionDependency, [
    stateDependencies.status,
  ]);
  const responsibilityBasisDependency = candidateAiDependency(responsibilityTransitionDependency, [
    stateDependencies.waitingOn,
  ]);
  const candidates: AiDependencyTimeCandidate[] = [];
  const add = (
    occurredAt: UtcIsoDateTime,
    dependency: AiAnalysisDependency,
    conditionDependencies: readonly AiAnalysisDependency[],
  ): void => {
    candidates.push(
      Object.freeze({
        occurredAt,
        dependency: candidateAiDependency(dependency, conditionDependencies),
      }),
    );
  };
  const reviewWait = isPullRequestReviewWait(item, decision);
  const previousStatusChanged = previousItem != null && previousItem.status !== decision.status;
  const previousResponsibilityChanged =
    previousItem != null && !sameWaitingOnEntities(previousItem.waitingOn, decision.waitingOn);
  const previousStateDependencies =
    previousItem == null
      ? undefined
      : Object.freeze({
          status: revalidatedHistoricalAiDependencyForExpected(
            previousItem.aiDependencies.status,
            stateDependencies.status,
          ),
          waitingOn: revalidatedHistoricalAiDependencyForExpected(
            previousItem.aiDependencies.waitingOn,
            stateDependencies.waitingOn,
          ),
        });
  const reviewWaitConditions = item.type === "pull_request" ? [stateDependencies.status] : [];
  const previousStateComparisonConditions: readonly AiAnalysisDependency[] =
    previousStateDependencies == null
      ? []
      : [
          stateDependencies.status,
          previousStateDependencies.status,
          stateDependencies.waitingOn,
          previousStateDependencies.waitingOn,
        ];
  if (previousItem == null) {
    add(staleness.statusSince, statusBasisDependency, reviewWaitConditions);
    add(responsibilityBasis.occurredAt, responsibilityBasisDependency, reviewWaitConditions);
  } else if (previousStatusChanged && previousResponsibilityChanged) {
    add(staleness.statusSince, statusBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
    add(responsibilityBasis.occurredAt, responsibilityBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
  } else if (previousStatusChanged) {
    add(staleness.statusSince, statusBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
  } else if (previousResponsibilityChanged) {
    add(responsibilityBasis.occurredAt, responsibilityBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
  }

  if (!reviewWait) {
    const progressConditions = item.type === "pull_request" ? [stateDependencies.status] : [];
    add(staleness.lastProgressAt, itemDependencies.lastProgressAt, progressConditions);
  }
  const responsibleActivityAt = lastResponsibleHumanActivityAt(item, decision.waitingOn);
  if (responsibleActivityAt != null) {
    add(responsibleActivityAt, notDependentAiDependency(), [stateDependencies.waitingOn]);
  }
  const humanReviewAt = lastHumanReviewAt(item);
  if (reviewWait && humanReviewAt != null) {
    add(humanReviewAt, notDependentAiDependency(), reviewWaitConditions);
  }

  if (
    previousItem != null &&
    (reviewWait || (!previousStatusChanged && !previousResponsibilityChanged))
  ) {
    const previousStallConditions = reviewWait
      ? reviewWaitConditions
      : previousStateComparisonConditions;
    add(
      previousItem.stallSince,
      revalidatedHistoricalAiDependency(
        item.nodeId,
        applications,
        previousItem.aiDependencies.stallSince,
      ),
      previousStallConditions,
    );
  }

  if (
    previousItem != null &&
    item.type === "pull_request" &&
    decision.status === "waiting_for_review"
  ) {
    const basisSourceIds = new Set(responsibilityBasis.sourceIds);
    const explicitReviewRequestAt = latestEventTime(
      item.events,
      (event) =>
        event.kind === "review_request" &&
        event.action === "added" &&
        basisSourceIds.has(event.sourceId) &&
        event.occurredAt === staleness.ownerSince &&
        event.occurredAt > previousItem.ownerSince,
    );
    if (explicitReviewRequestAt != null) {
      assertNonNullable(
        previousStateDependencies,
        `過去の状態比較に使うAI依存がありません。対象: ${item.nodeId}`,
      );
      add(explicitReviewRequestAt, notDependentAiDependency(), [
        stateDependencies.status,
        responsibilityTransitionDependency,
        previousStateDependencies.status,
        previousStateDependencies.waitingOn,
      ]);
    }
  }

  const selectedCandidates = candidates.filter(
    (candidate) => candidate.occurredAt === staleness.stallSince,
  );
  if (selectedCandidates.length === 0) {
    throw new TypeError(`stallSinceのAI依存候補がありません。対象: ${item.nodeId}`);
  }
  return preferIndependentAiDependency(selectedCandidates.map((candidate) => candidate.dependency));
}

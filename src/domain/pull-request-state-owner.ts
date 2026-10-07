import { assertNonNullable } from "../util/index.js";
import { type FreshObservedGitHubPullRequest } from "./github-item-observation.js";
import { getHeadBasis, getSuccessfulCheckOccurredAt } from "./pull-request-state-automation.js";
import type {
  DecisionContext,
  PullRequestStateDecision,
  PullRequestStateMachineInput,
  PullRequestTransitionBasis,
  ReviewEvent,
} from "./pull-request-state-contracts.js";
import {
  addUncertainty,
  compareEvents,
  createBasis,
  createEvidence,
  createWaitingOn,
  finalizeDecision,
  resolveDraftIntervalBasis,
  resolveMaintainerDecisionLabelBasis,
} from "./pull-request-state-decision.js";
import {
  getEffectiveReviews,
  getHumanReviewEvents,
  isReviewForCurrentHead,
  previousChangesRequestedForHead,
  reviewerCommentedReviewsAfterHead,
  reviewerCommentsAfterHead,
} from "./pull-request-state-review-sources.js";
import { createAuthorWaitingOn } from "./pull-request-state-revision.js";
import { type SourceId } from "./source-id.js";
import { type WaitingOn } from "./types.js";

function createMaintainerWaitingOn(
  sourceIds: readonly SourceId[],
  role: "maintainer" | "merge_decider",
  reasonSummary: string,
  confidence: number,
): WaitingOn {
  return createWaitingOn({
    kind: "role",
    candidateId: "maintainer",
    role,
    reasonSummary,
    sourceIds,
    confidence,
  });
}

export function createLabelDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  if (!input.labelEffects.requiresMaintainerDecision) {
    return undefined;
  }
  const basis = resolveMaintainerDecisionLabelBasis(
    input.pullRequest,
    input.labelEffects.maintainerDecisionLabelNames,
  );
  return finalizeDecision(input, context, {
    status: "waiting_for_decision",
    waitingOn: [
      createMaintainerWaitingOn(
        [input.pullRequest.sourceId],
        "maintainer",
        "ラベル効果によりmaintainer判断が必要です",
        1,
      ),
    ],
    primarySelectionReason: "明示的なmaintainer判断ルールを選定しました",
    nextAction: "maintainerが判断する",
    confidence: 1,
    evidence: [
      ...createEvidence(
        [input.pullRequest.sourceId],
        "status",
        "設定済みラベル効果がmaintainer判断を要求しています",
      ),
      ...createEvidence([input.pullRequest.sourceId], "waiting_on", "判断はmaintainerの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

export function createDraftDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  if (!input.pullRequest.draft) {
    return undefined;
  }
  const basis = resolveDraftIntervalBasis(input.pullRequest);
  return finalizeDecision(input, context, {
    status: "in_progress",
    waitingOn: [
      createAuthorWaitingOn(
        [input.pullRequest.sourceId],
        "draftをready for reviewにする作業中です",
        1,
      ),
    ],
    primarySelectionReason: "draftの既定責務としてauthorを選定しました",
    nextAction: "draftを完成させてready for reviewにする",
    confidence: 1,
    evidence: [
      ...createEvidence([input.pullRequest.sourceId], "status", "Pull Requestはdraftです"),
      ...createEvidence(
        [input.pullRequest.sourceId],
        "waiting_on",
        "明示的な他者待ちがないdraftはauthorの責務です",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

/** 既存のreview判定規則からrevision責務の解消を判定する。 */
export function isPullRequestRevisionResponsibilityResolved(
  input: Readonly<{
    pullRequest: FreshObservedGitHubPullRequest;
    previousResponsibilityBasis: PullRequestTransitionBasis;
  }>,
): boolean {
  const headBasis = getHeadBasis(input.pullRequest);
  if (headBasis.occurredAt <= input.previousResponsibilityBasis.occurredAt) {
    return false;
  }
  const effectiveReviews = getEffectiveReviews(getHumanReviewEvents(input.pullRequest));
  const previousChangesRequested = previousChangesRequestedForHead(
    effectiveReviews,
    input.pullRequest,
    headBasis,
    input.previousResponsibilityBasis,
  );
  if (previousChangesRequested.length === 0) {
    return true;
  }
  const reviewerNodeIds = new Set(previousChangesRequested.map((review) => review.actor.nodeId));
  if (reviewerCommentedReviewsAfterHead(input.pullRequest, reviewerNodeIds, headBasis).length > 0) {
    return false;
  }
  return reviewerCommentsAfterHead(input.pullRequest, reviewerNodeIds, headBasis).length === 0;
}

export function addAmbiguousHumanCommentUncertainty(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): void {
  const reviewThreadCommentSourceIds = new Set(
    input.pullRequest.reviewThreads.flatMap((thread) => thread.commentSourceIds),
  );
  const ambiguousEvents = input.pullRequest.events
    .filter((event) => {
      if (event.actor.type !== "human") {
        return false;
      }
      if (event.kind === "comment") {
        return !event.bodyEmpty && !reviewThreadCommentSourceIds.has(event.sourceId);
      }
      return event.kind === "review" && event.state === "commented" && !event.bodyEmpty;
    })
    .sort(compareEvents);
  const latestEvent = ambiguousEvents.at(-1);
  if (latestEvent == null) {
    return;
  }
  addUncertainty(
    context,
    "human commentの意味を決定論的に確定できません",
    [latestEvent.sourceId],
    input.confidenceThresholds.medium,
    ["status", "waitingOn", "nextAction"],
  );
}

export function createWaitingForMergeDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  effectiveReviews: readonly ReviewEvent[],
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  const checks = input.pullRequest.mergeState.checks;
  const checksSatisfied = checks.status === "not_configured" || checks.combinedState === "success";
  const mergeRequirementsSatisfied =
    input.pullRequest.mergeState.mergeability === "mergeable" &&
    input.pullRequest.mergeState.mergeState === "clean";
  if (!checksSatisfied || !mergeRequirementsSatisfied) {
    return undefined;
  }

  const effectiveApprovals = effectiveReviews.filter(
    (review) =>
      review.state === "approved" && isReviewForCurrentHead(review, input.pullRequest, headBasis),
  );
  const approvalSourceIds = effectiveApprovals.map((review) => review.sourceId);
  const sourceIds =
    checks.status === "configured"
      ? [input.pullRequest.sourceId, checks.sourceId, ...approvalSourceIds]
      : [input.pullRequest.sourceId, ...approvalSourceIds];
  const successfulCheckOccurredAts =
    checks.status === "configured"
      ? checks.contexts.flatMap((checkContext) => {
          const occurredAt = getSuccessfulCheckOccurredAt(checkContext);
          return occurredAt == null ? [] : [occurredAt];
        })
      : [];
  const occurredAt = [
    headBasis.occurredAt,
    ...effectiveApprovals.map((review) => review.occurredAt),
    ...successfulCheckOccurredAts,
  ]
    .sort()
    .at(-1);
  assertNonNullable(occurredAt, "merge可能になった時刻を解決できませんでした");
  const basis = createBasis(sourceIds, occurredAt, "inferred");
  return finalizeDecision(input, context, {
    status: "waiting_for_merge",
    waitingOn: [
      createMaintainerWaitingOn(
        sourceIds,
        "merge_decider",
        "merge要件を満たしておりmerge判断を待っています",
        1,
      ),
    ],
    primarySelectionReason: "merge要件を満たしたためmaintainerのmerge判断を選定しました",
    nextAction: "maintainerがmerge可否を判断する",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "GitHub上のmerge要件を満たしています"),
      ...createEvidence(sourceIds, "waiting_on", "最終merge判断はmaintainerの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

export function addMergeStateUncertainty(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): void {
  if (
    input.pullRequest.mergeState.mergeability !== "unknown" &&
    input.pullRequest.mergeState.mergeState !== "unknown"
  ) {
    return;
  }
  addUncertainty(
    context,
    "GitHubがmerge可否を確定できていません",
    [input.pullRequest.sourceId],
    input.confidenceThresholds.medium,
    ["status", "waitingOn", "nextAction"],
  );
}

export function createOwnerDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision {
  const basis = resolveDraftIntervalBasis(input.pullRequest);
  return finalizeDecision(input, context, {
    status: "waiting_for_owner",
    waitingOn: [
      createMaintainerWaitingOn(
        [input.pullRequest.sourceId],
        "maintainer",
        "ready for reviewですが現行review requestがありません",
        1,
      ),
    ],
    primarySelectionReason: "review未依頼の既定責務としてmaintainerを選定しました",
    nextAction:
      context.uncertainties.length === 0
        ? "maintainerがreview担当を決める"
        : "maintainerが不確実な点を確認して担当を決める",
    confidence: 1,
    evidence: [
      ...createEvidence(
        [input.pullRequest.sourceId],
        "status",
        "ready for reviewですが現行review requestがありません",
      ),
      ...createEvidence(
        [input.pullRequest.sourceId],
        "waiting_on",
        "review担当の決定はmaintainerの責務です",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

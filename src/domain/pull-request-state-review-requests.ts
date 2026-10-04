import { assertNonNullable } from "../util/index.js";
import { type FreshObservedGitHubPullRequest } from "./github-item-observation.js";
import type {
  DecisionContext,
  PullRequestStateDecision,
  PullRequestStateMachineInput,
  PullRequestTransitionBasis,
  ResolvedReviewRequest,
  ReviewEvent,
} from "./pull-request-state-contracts.js";
import {
  addUncertainty,
  createBasis,
  createEvidence,
  createWaitingOn,
  finalizeDecision,
} from "./pull-request-state-decision.js";
import {
  getBodyBearingHumanSpeechEvents,
  previousChangesRequestedForHead,
  reviewerCommentedReviewsAfterHead,
  reviewerCommentsAfterHead,
} from "./pull-request-state-review-sources.js";
import { createSourceIds } from "./pull-request-state-validation.js";
import { type SourceId } from "./source-id.js";
import { type NormalizedEvent } from "./types.js";

function compareResolvedReviewRequests(
  left: ResolvedReviewRequest,
  right: ResolvedReviewRequest,
): -1 | 0 | 1 {
  if (left.basis.occurredAt < right.basis.occurredAt) {
    return -1;
  }
  if (left.basis.occurredAt > right.basis.occurredAt) {
    return 1;
  }
  if (left.waitingOn.candidateId < right.waitingOn.candidateId) {
    return -1;
  }
  if (left.waitingOn.candidateId > right.waitingOn.candidateId) {
    return 1;
  }
  return 0;
}

export function resolveHumanReviewRequests(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly ResolvedReviewRequest[] {
  const requests = new Map<string, ResolvedReviewRequest>();
  for (const request of pullRequest.reviewRequests) {
    if (request.target.type === "user" && request.target.actor.type === "bot") {
      continue;
    }
    const candidateId =
      request.target.type === "user"
        ? request.target.actor.login
        : `${request.target.organizationLogin}/${request.target.slug}`;
    const kind = request.target.type === "user" ? "user" : "team";
    const basis =
      request.requestedAt.status === "available"
        ? createBasis([request.sourceId], request.requestedAt.value, "event")
        : createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred");
    const targetNodeId =
      request.target.type === "user" ? request.target.actor.nodeId : request.target.nodeId;
    let requestEventSourceIds: readonly SourceId[] = Object.freeze([]);
    if (request.requestedAt.status === "available") {
      const requestedAt = request.requestedAt.value;
      requestEventSourceIds = Object.freeze(
        pullRequest.events
          .filter(
            (event): event is Extract<NormalizedEvent, { kind: "review_request" }> =>
              event.kind === "review_request" &&
              event.action === "added" &&
              event.target.nodeId === targetNodeId &&
              event.occurredAt === requestedAt,
          )
          .map((event) => event.sourceId),
      );
    }
    const resolved = Object.freeze({
      requestSourceId: request.sourceId,
      requestEventSourceIds,
      waitingOn: createWaitingOn({
        kind,
        candidateId,
        role: "reviewer",
        reasonSummary: "現行のreview requestがあります",
        sourceIds: basis.sourceIds,
        confidence: 1,
      }),
      basis,
    });
    const key = `${kind}:${candidateId}`;
    const previous = requests.get(key);
    if (previous == null || compareResolvedReviewRequests(resolved, previous) < 0) {
      requests.set(key, resolved);
    }
  }
  return Object.freeze([...requests.values()].sort(compareResolvedReviewRequests));
}

function createReviewResponsibilityBasis(
  baseBasis: PullRequestTransitionBasis,
  reviewRequests: readonly ResolvedReviewRequest[],
): PullRequestTransitionBasis {
  const requestEventSourceIds = reviewRequests.flatMap((request) => request.requestEventSourceIds);
  if (requestEventSourceIds.length === 0) {
    return baseBasis;
  }
  return createBasis(
    [...baseBasis.sourceIds, ...requestEventSourceIds],
    baseBasis.occurredAt,
    baseBasis.precision,
  );
}

export function createRereviewDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  effectiveReviews: readonly ReviewEvent[],
  headBasis: PullRequestTransitionBasis,
  reviewRequests: readonly ResolvedReviewRequest[],
): PullRequestStateDecision | undefined {
  const previousChangesRequested = previousChangesRequestedForHead(
    effectiveReviews,
    input.pullRequest,
    headBasis,
    headBasis,
  );
  if (previousChangesRequested.length === 0) {
    return undefined;
  }

  const previousReviewerNodeIds = new Set(
    previousChangesRequested.map((review) => review.actor.nodeId),
  );
  const commentedAfterPush = reviewerCommentedReviewsAfterHead(
    input.pullRequest,
    previousReviewerNodeIds,
    headBasis,
  );
  if (commentedAfterPush.length > 0) {
    addUncertainty(
      context,
      "変更対応push後にreviewerがcommented reviewを返しているため追加のauthor対応が必要か判断できません",
      createSourceIds([
        ...commentedAfterPush.map((review) => review.sourceId),
        ...headBasis.sourceIds,
      ]),
      input.confidenceThresholds.medium,
      ["status", "waitingOn", "nextAction"],
    );
  }

  if (commentedAfterPush.length === 0) {
    const waitingReviewerNodeIds =
      reviewRequests.length === 0
        ? previousReviewerNodeIds
        : new Set(
            input.pullRequest.reviewRequests.flatMap((request) =>
              request.target.type === "user" && request.target.actor.type === "human"
                ? [request.target.actor.nodeId]
                : [],
            ),
          );
    const commentsAfterPush = reviewerCommentsAfterHead(
      input.pullRequest,
      waitingReviewerNodeIds,
      headBasis,
    );
    if (commentsAfterPush.length > 0) {
      addUncertainty(
        context,
        "変更対応push後にreviewerがhuman commentを投稿しているため追加のauthor対応が必要か判断できません",
        createSourceIds([
          ...commentsAfterPush.map((comment) => comment.sourceId),
          ...headBasis.sourceIds,
        ]),
        input.confidenceThresholds.medium,
        ["status", "waitingOn", "nextAction"],
      );
    }
  }

  const waitingOn =
    reviewRequests.length > 0
      ? reviewRequests.map((request) =>
          createWaitingOn({
            ...request.waitingOn,
            reasonSummary: "変更対応push後の再reviewを待っています",
            sourceIds: [...request.waitingOn.sourceIds, ...headBasis.sourceIds],
          }),
        )
      : previousChangesRequested.map((review) =>
          createWaitingOn({
            kind: "user",
            candidateId: review.actor.login,
            role: "reviewer",
            reasonSummary: "変更対応push後の再reviewを待っています",
            sourceIds: [review.sourceId, ...headBasis.sourceIds],
            confidence: 1,
          }),
        );
  const sourceIds = [
    ...previousChangesRequested.map((review) => review.sourceId),
    ...headBasis.sourceIds,
    ...reviewRequests.flatMap((request) => request.waitingOn.sourceIds),
  ];
  const responsibilityBasis = createReviewResponsibilityBasis(headBasis, reviewRequests);
  return finalizeDecision(input, context, {
    status: "waiting_for_review",
    waitingOn,
    primarySelectionReason: "変更要求後のhead pushによりreviewer側へ責務を戻しました",
    nextAction: "変更内容を再reviewする",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "変更要求後に新しいheadがpushされています"),
      ...createEvidence(sourceIds, "waiting_on", "再reviewはreviewer側の責務です"),
    ],
    statusBasis: headBasis,
    responsibilityBasis,
  });
}

export function createReviewRequestDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  reviewRequests: readonly ResolvedReviewRequest[],
): PullRequestStateDecision | undefined {
  if (reviewRequests.length === 0) {
    return undefined;
  }
  const primary = reviewRequests[0];
  assertNonNullable(primary, "primary review requestを選定できませんでした");
  const responsibilityBasis = createReviewResponsibilityBasis(primary.basis, reviewRequests);
  const sourceIds = reviewRequests.flatMap((request) => request.waitingOn.sourceIds);
  const resolvedUserRequestsBySourceId = new Map<SourceId, ResolvedReviewRequest>();
  for (const request of reviewRequests) {
    if (request.waitingOn.kind === "user") {
      resolvedUserRequestsBySourceId.set(request.requestSourceId, request);
    }
  }
  const bodyBearingHumanSpeechEvents = getBodyBearingHumanSpeechEvents(input.pullRequest);
  const reviewerSpeechForRequests = input.pullRequest.reviewRequests.flatMap((request) => {
    const resolvedRequest = resolvedUserRequestsBySourceId.get(request.sourceId);
    if (
      request.target.type !== "user" ||
      request.target.actor.type !== "human" ||
      resolvedRequest == null
    ) {
      return [];
    }
    const reviewerActor = request.target.actor;
    return bodyBearingHumanSpeechEvents
      .filter((event) => event.actor.nodeId === reviewerActor.nodeId)
      .map((event) => ({ request, resolvedRequest, event }));
  });
  const reviewerSpeechAfterRequests = reviewerSpeechForRequests.filter(
    ({ request, event }) =>
      request.requestedAt.status === "available" && event.occurredAt > request.requestedAt.value,
  );
  if (reviewerSpeechAfterRequests.length > 0) {
    addUncertainty(
      context,
      "review依頼後にreviewerが発言しているためauthor対応が必要か判断できません",
      reviewerSpeechAfterRequests.flatMap(({ resolvedRequest, event }) => [
        ...resolvedRequest.waitingOn.sourceIds,
        event.sourceId,
      ]),
      input.confidenceThresholds.medium,
      ["status", "waitingOn", "nextAction"],
    );
  }
  const reviewerSpeechWithUnavailableRequestedAt = reviewerSpeechForRequests.filter(
    ({ request }) => request.requestedAt.status === "unavailable",
  );
  if (reviewerSpeechWithUnavailableRequestedAt.length > 0) {
    addUncertainty(
      context,
      "review依頼時刻が不明なためreviewerの発言が依頼前か後か判断できません",
      reviewerSpeechWithUnavailableRequestedAt.flatMap(({ resolvedRequest, event }) => [
        ...resolvedRequest.waitingOn.sourceIds,
        event.sourceId,
      ]),
      input.confidenceThresholds.medium,
      ["status", "waitingOn", "nextAction"],
    );
  }
  return finalizeDecision(input, context, {
    status: "waiting_for_review",
    waitingOn: reviewRequests.map((request) => request.waitingOn),
    primarySelectionReason: "依頼時刻とcandidate IDの順で現行review requestを選定しました",
    nextAction: "依頼されたreviewを行う",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "現行のhuman review requestがあります"),
      ...createEvidence(sourceIds, "waiting_on", "review request先の対応待ちです"),
    ],
    statusBasis: primary.basis,
    responsibilityBasis,
  });
}

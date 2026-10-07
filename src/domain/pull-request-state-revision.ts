import { assertNonNullable } from "../util/index.js";
import { type FreshObservedGitHubPullRequest } from "./github-item-observation.js";
import type {
  DecisionContext,
  HumanCommentEvent,
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
} from "./pull-request-state-decision.js";
import {
  getBodyBearingHumanSpeechEvents,
  getHumanCommentEvents,
  isReviewForCurrentHead,
} from "./pull-request-state-review-sources.js";
import { compareSourceIds, createSourceIds } from "./pull-request-state-validation.js";
import { type SourceId } from "./source-id.js";
import { type NormalizedEvent, type UtcIsoDateTime, type WaitingOn } from "./types.js";

export function createAuthorWaitingOn(
  sourceIds: readonly SourceId[],
  reasonSummary: string,
  confidence: number,
): WaitingOn {
  return createWaitingOn({
    kind: "role",
    candidateId: "author",
    role: "author",
    reasonSummary,
    sourceIds,
    confidence,
  });
}

export function createChangesRequestedDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  effectiveReviews: readonly ReviewEvent[],
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  const changesRequested = effectiveReviews.filter(
    (review) =>
      review.state === "changes_requested" &&
      isReviewForCurrentHead(review, input.pullRequest, headBasis),
  );
  if (changesRequested.length === 0) {
    return undefined;
  }

  const sourceIds = changesRequested.map((review) => review.sourceId);
  const firstReview = changesRequested[0];
  assertNonNullable(firstReview, "変更要求reviewを取得できませんでした");
  const latestReview = changesRequested.at(-1);
  assertNonNullable(latestReview, "最新の変更要求reviewを取得できませんでした");
  const author = input.pullRequest.author;
  if (author.status === "identified" && author.actor.type === "human") {
    const authorSpeechEvents = getBodyBearingHumanSpeechEvents(input.pullRequest).filter(
      (event) =>
        event.actor.nodeId === author.actor.nodeId && event.occurredAt > latestReview.occurredAt,
    );
    if (authorSpeechEvents.length > 0) {
      addUncertainty(
        context,
        "変更要求後にauthorが発言しているためreviewer対応が必要か判断できません",
        [latestReview.sourceId, ...authorSpeechEvents.map((event) => event.sourceId)],
        input.confidenceThresholds.medium,
        ["status", "waitingOn", "nextAction"],
      );
    }
  }
  const basis = createBasis(sourceIds, firstReview.occurredAt, "event");
  return finalizeDecision(input, context, {
    status: "waiting_for_revision",
    waitingOn: [createAuthorWaitingOn(sourceIds, "human reviewerから変更を要求されています", 1)],
    primarySelectionReason: "現行headに対するhumanの変更要求を選定しました",
    nextAction: "変更要求へ対応してpushする",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "現行headにhumanの変更要求があります"),
      ...createEvidence(sourceIds, "waiting_on", "変更対応はauthorの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function getCommentEventsBySourceId(
  pullRequest: FreshObservedGitHubPullRequest,
): ReadonlyMap<SourceId, Extract<NormalizedEvent, { kind: "comment" }>> {
  const comments = new Map<SourceId, Extract<NormalizedEvent, { kind: "comment" }>>();
  for (const event of pullRequest.events) {
    if (event.kind === "comment") {
      comments.set(event.sourceId, event);
    }
  }
  return comments;
}

export function createReviewThreadDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  const commentsBySourceId = getCommentEventsBySourceId(input.pullRequest);
  const actionable: Readonly<{
    sourceIds: readonly SourceId[];
    occurredAt: UtcIsoDateTime;
    latestHumanComment: HumanCommentEvent;
  }>[] = [];

  for (const thread of [...input.pullRequest.reviewThreads].sort((left, right) =>
    compareSourceIds(left.sourceId, right.sourceId),
  )) {
    const comments = thread.commentSourceIds.map((sourceId) => {
      const comment = commentsBySourceId.get(sourceId);
      assertNonNullable(comment, `review threadのcomment eventがありません。対象: ${sourceId}`);
      return comment;
    });
    const reviewerComments = comments.filter((comment) => {
      if (comment.actor.type !== "human") {
        return false;
      }
      return (
        input.pullRequest.author.status === "unavailable" ||
        comment.actor.nodeId !== input.pullRequest.author.actor.nodeId
      );
    });
    if (thread.isResolved || reviewerComments.length === 0) {
      continue;
    }

    const sourceIds = reviewerComments.map((comment) => comment.sourceId);
    if (thread.isOutdated) {
      addUncertainty(
        context,
        "未解決のhuman review threadがoutdatedのため対応要否を確定できません",
        sourceIds,
        input.confidenceThresholds.medium,
        ["status", "waitingOn", "nextAction"],
      );
      continue;
    }
    const humanComments = comments
      .filter((comment): comment is HumanCommentEvent => comment.actor.type === "human")
      .sort(compareEvents);
    const latestHumanComment = humanComments.at(-1);
    assertNonNullable(latestHumanComment, "review threadのhuman commentを取得できませんでした");
    if (
      input.pullRequest.author.status === "identified" &&
      latestHumanComment.actor.nodeId === input.pullRequest.author.actor.nodeId
    ) {
      const authorRepliedSourceIds = [
        ...new Set([
          ...reviewerComments.map((comment) => comment.sourceId),
          latestHumanComment.sourceId,
        ]),
      ];
      addUncertainty(
        context,
        "authorが返信済みのため未解決review threadへの対応が完了したか判断できません",
        authorRepliedSourceIds,
        input.confidenceThresholds.medium,
        ["status", "waitingOn", "nextAction"],
      );
      continue;
    }
    const firstComment = [...reviewerComments].sort(compareEvents)[0];
    assertNonNullable(firstComment, "review threadのhuman commentを取得できませんでした");
    actionable.push({
      sourceIds,
      occurredAt: firstComment.occurredAt,
      latestHumanComment,
    });
  }
  if (actionable.length === 0) {
    return undefined;
  }

  const reviewThreadCommentSourceIds = new Set(
    input.pullRequest.reviewThreads.flatMap((thread) => thread.commentSourceIds),
  );
  const author = input.pullRequest.author;
  const authorCommentsOutsideThreads =
    author.status === "identified" && author.actor.type === "human"
      ? getHumanCommentEvents(input.pullRequest).filter(
          (comment) =>
            !comment.bodyEmpty &&
            comment.actor.nodeId === author.actor.nodeId &&
            !reviewThreadCommentSourceIds.has(comment.sourceId),
        )
      : [];
  const threadsBeforeAuthorComments = actionable.filter((thread) =>
    authorCommentsOutsideThreads.some(
      (comment) => comment.occurredAt > thread.latestHumanComment.occurredAt,
    ),
  );
  if (threadsBeforeAuthorComments.length > 0) {
    const laterAuthorComments = authorCommentsOutsideThreads.filter((comment) =>
      threadsBeforeAuthorComments.some(
        (thread) => comment.occurredAt > thread.latestHumanComment.occurredAt,
      ),
    );
    addUncertainty(
      context,
      "actionableなreview threadの後にauthorがスレッド外で発言しているため対応済みまたは質問返しか判断できません",
      [
        ...threadsBeforeAuthorComments.map((thread) => thread.latestHumanComment.sourceId),
        ...laterAuthorComments.map((comment) => comment.sourceId),
      ],
      input.confidenceThresholds.medium,
      ["status", "waitingOn", "nextAction"],
    );
  }

  const threadsWithBodyBearingLatestComment = actionable.filter(
    (thread) => !thread.latestHumanComment.bodyEmpty,
  );
  if (threadsWithBodyBearingLatestComment.length > 0) {
    addUncertainty(
      context,
      "未解決review threadの最終human commentがauthor対応を求める内容か判断できません",
      threadsWithBodyBearingLatestComment.map((thread) => thread.latestHumanComment.sourceId),
      input.confidenceThresholds.medium,
      ["status", "waitingOn", "nextAction"],
    );
  }

  actionable.sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return compareSourceIds(
      createSourceIds(left.sourceIds)[0],
      createSourceIds(right.sourceIds)[0],
    );
  });
  const firstThread = actionable[0];
  assertNonNullable(firstThread, "actionableなreview threadを取得できませんでした");
  const sourceIds = actionable.flatMap((thread) => thread.sourceIds);
  const basis = createBasis(sourceIds, firstThread.occurredAt, "event");
  return finalizeDecision(input, context, {
    status: "waiting_for_revision",
    waitingOn: [createAuthorWaitingOn(sourceIds, "未解決のhuman review threadがあります", 1)],
    primarySelectionReason: "未解決のhuman review threadをauthor対応として選定しました",
    nextAction: "未解決のreview threadへ対応する",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "actionableな未解決review threadがあります"),
      ...createEvidence(sourceIds, "waiting_on", "review threadへの対応はauthorの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

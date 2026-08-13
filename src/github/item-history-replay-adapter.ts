import {
  replayItemHistory,
  type GitHubNodeId,
  type ReplayCurrentItem,
  type ReplayEvent,
  type ReplayItemHistoryResult,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type GitHubBotPredicate } from "./item-normalization.js";
import {
  type GitHubDetailActor,
  type GitHubItemDetail,
  type GitHubPullRequestReview,
  type GitHubReviewRequestTarget,
  type GitHubReviewRequestTimestamp,
  type GitHubTimelineAssignee,
  type GitHubTimelineEvent,
} from "./item-detail-types.js";
import { type EnumeratedGitHubItem, type GitHubItemAccount } from "./item-enumeration.js";

/** GitHub詳細取得結果を項目履歴の再生へ渡す入力。 */
export type ReplayGitHubItemHistoryOptions = Readonly<{
  item: EnumeratedGitHubItem;
  detail: GitHubItemDetail;
  trackingStartAt: UtcIsoDateTime;
  isBot: GitHubBotPredicate;
}>;

type ReplayCurrentReviewRequest = Extract<
  ReplayCurrentItem,
  { type: "pull_request" }
>["reviewRequests"][number];

type TimelineAdaptation = Readonly<{
  status: "available";
  event: ReplayEvent;
}>;

type ReplayAccountActor = Extract<ReplayEvent["actor"], { type: "human" | "bot" }>;
type ReplayUnavailableActor = Readonly<{
  status: "unavailable";
  reason: "actor_unavailable";
}>;
type ReplayAssignee = ReplayAccountActor | ReplayUnavailableActor;

type ReplayTimelineEvent =
  | Extract<GitHubTimelineEvent, { kind: "assigned" | "unassigned" }>
  | Extract<GitHubTimelineEvent, { kind: "review_requested" | "review_request_removed" }>
  | (GitHubTimelineEvent &
      Readonly<{
        kind: "closed" | "reopened" | "merged" | "ready_for_review" | "converted_to_draft";
      }>);

type IdentifiedUserReviewRequestTarget = Extract<GitHubReviewRequestTarget, { type: "user" }>;

type ReplayTimelineAdaptation = Readonly<{
  timelineEvent: ReplayTimelineEvent;
  event: ReplayEvent;
}>;

function normalizeAccountActor(
  account: Pick<GitHubItemAccount, "nodeId" | "login" | "apiType">,
  isBot: GitHubBotPredicate,
): Extract<ReplayEvent["actor"], { type: "human" | "bot" }> {
  return Object.freeze({
    type: account.apiType === "Bot" || isBot(account) ? "bot" : "human",
    nodeId: account.nodeId,
    login: account.login,
  });
}

function normalizeActor(actor: GitHubDetailActor, isBot: GitHubBotPredicate): ReplayEvent["actor"] {
  if (actor.status === "unavailable") {
    return Object.freeze({
      status: "unavailable",
      reason: "actor_unavailable",
    });
  }
  return normalizeAccountActor(actor.account, isBot);
}

function normalizeAssignee(
  assignee: GitHubTimelineAssignee,
  isBot: GitHubBotPredicate,
): ReplayAssignee {
  if ("status" in assignee) {
    return Object.freeze({
      status: "unavailable",
      reason: "actor_unavailable",
    });
  }
  return normalizeAccountActor(assignee.account, isBot);
}

function normalizeReviewRequestTarget(target: GitHubReviewRequestTarget):
  | Readonly<{
      status: "identified";
      target: Readonly<{
        type: "user" | "team";
        nodeId: GitHubNodeId;
      }>;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "actor_unavailable";
    }> {
  if ("status" in target) {
    return Object.freeze({
      status: "unavailable",
      reason: "actor_unavailable",
    });
  }
  return Object.freeze({
    status: "identified",
    target: Object.freeze({
      type: target.type,
      nodeId: target.nodeId,
    }),
  });
}

function normalizeReviewRequestRequestedAt(
  requestedAt: GitHubReviewRequestTimestamp,
): ReplayCurrentReviewRequest["requestedAt"] {
  if (requestedAt.status === "available") {
    return Object.freeze({
      status: "available",
      value: requestedAt.value,
    });
  }
  return Object.freeze({
    status: "unavailable",
    reason: "history_unavailable",
  });
}

function isReplayTimelineEvent(event: GitHubTimelineEvent): event is ReplayTimelineEvent {
  switch (event.kind) {
    case "assigned":
    case "unassigned":
    case "review_requested":
    case "review_request_removed":
    case "closed":
    case "reopened":
    case "merged":
    case "ready_for_review":
    case "converted_to_draft":
      return true;
    case "labeled":
    case "unlabeled":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
    case "cross_referenced":
    case "connected":
    case "disconnected":
    case "blocked_by_added":
    case "blocked_by_removed":
    case "blocking_added":
    case "blocking_removed":
    case "sub_issue_added":
    case "sub_issue_removed":
    case "parent_issue_added":
    case "parent_issue_removed":
    case "head_ref_force_pushed":
    case "commit_added":
      return false;
  }
}

function createClosedStateReason(
  item: EnumeratedGitHubItem,
  occurredAt: UtcIsoDateTime,
): "completed" | "not_planned" | "duplicate" | "unavailable" {
  if (item.state !== "closed" || item.closedAt !== occurredAt || item.stateReason == null) {
    return "unavailable";
  }
  return item.stateReason;
}

function adaptTimelineEvent(
  item: EnumeratedGitHubItem,
  event: ReplayTimelineEvent,
  isBot: GitHubBotPredicate,
): TimelineAdaptation {
  const actor = normalizeActor(event.actor, isBot);

  switch (event.kind) {
    case "assigned":
    case "unassigned": {
      const assignee = normalizeAssignee(event.assignee, isBot);
      return Object.freeze({
        status: "available",
        event: Object.freeze({
          kind: "assignee",
          sourceId: event.sourceId,
          itemNodeId: item.nodeId,
          occurredAt: event.occurredAt,
          actor,
          assignee,
          action: event.kind === "assigned" ? "added" : "removed",
          sequence: event.sequence,
        }),
      });
    }
    case "review_requested":
    case "review_request_removed": {
      const target = normalizeReviewRequestTarget(event.target);
      return Object.freeze({
        status: "available",
        event: Object.freeze({
          kind: "review_request",
          sourceId: event.sourceId,
          itemNodeId: item.nodeId,
          occurredAt: event.occurredAt,
          actor,
          target: target.status === "identified" ? target.target : target,
          action: event.kind === "review_requested" ? "added" : "removed",
          sequence: event.sequence,
        }),
      });
    }
    case "closed":
      return Object.freeze({
        status: "available",
        event: Object.freeze({
          kind: "state",
          sourceId: event.sourceId,
          itemNodeId: item.nodeId,
          occurredAt: event.occurredAt,
          actor,
          state: "closed",
          stateReason: createClosedStateReason(item, event.occurredAt),
          sequence: event.sequence,
        }),
      });
    case "reopened":
    case "merged":
      return Object.freeze({
        status: "available",
        event: Object.freeze({
          kind: "state",
          sourceId: event.sourceId,
          itemNodeId: item.nodeId,
          occurredAt: event.occurredAt,
          actor,
          state: event.kind,
          sequence: event.sequence,
        }),
      });
    case "ready_for_review":
    case "converted_to_draft":
      return Object.freeze({
        status: "available",
        event: Object.freeze({
          kind: event.kind,
          sourceId: event.sourceId,
          itemNodeId: item.nodeId,
          occurredAt: event.occurredAt,
          actor,
          sequence: event.sequence,
        }),
      });
  }
}

function compareReplayEvents(left: ReplayEvent, right: ReplayEvent): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  if (left.sequence < right.sequence) {
    return -1;
  }
  if (left.sequence > right.sequence) {
    return 1;
  }
  if (left.sourceId < right.sourceId) {
    return -1;
  }
  if (left.sourceId > right.sourceId) {
    return 1;
  }
  return 0;
}

function compareReviews(left: GitHubPullRequestReview, right: GitHubPullRequestReview): -1 | 0 | 1 {
  if (left.submittedAt < right.submittedAt) {
    return -1;
  }
  if (left.submittedAt > right.submittedAt) {
    return 1;
  }
  if (left.sequence < right.sequence) {
    return -1;
  }
  if (left.sequence > right.sequence) {
    return 1;
  }
  if (left.sourceId < right.sourceId) {
    return -1;
  }
  if (left.sourceId > right.sourceId) {
    return 1;
  }
  return 0;
}

function isIdentifiedUserReviewRequestTarget(
  target: GitHubReviewRequestTarget,
): target is IdentifiedUserReviewRequestTarget {
  if ("status" in target || target.type !== "user") {
    return false;
  }
  return true;
}

function isMatchingUserReviewAfter(
  review: GitHubPullRequestReview,
  target: IdentifiedUserReviewRequestTarget,
  requestedAt: UtcIsoDateTime,
): boolean {
  if (review.submittedAt <= requestedAt || review.author.status === "unavailable") {
    return false;
  }
  return review.author.account.nodeId === target.nodeId;
}

function isMatchingUserReviewBetween(
  review: GitHubPullRequestReview,
  target: IdentifiedUserReviewRequestTarget,
  requestedAt: UtcIsoDateTime,
  nextRequestedAt: UtcIsoDateTime,
): boolean {
  return (
    isMatchingUserReviewAfter(review, target, requestedAt) && review.submittedAt < nextRequestedAt
  );
}

function createSyntheticReviewRequestRemoval(
  item: EnumeratedGitHubItem,
  target: IdentifiedUserReviewRequestTarget,
  review: GitHubPullRequestReview,
  sequence: number,
  isBot: GitHubBotPredicate,
): ReplayEvent {
  if (review.author.status === "unavailable") {
    throw new TypeError("review提出者の取得結果がありません");
  }
  return Object.freeze({
    kind: "review_request",
    sourceId: review.sourceId,
    itemNodeId: item.nodeId,
    occurredAt: review.submittedAt,
    actor: normalizeActor(review.author, isBot),
    target: Object.freeze({
      type: "user",
      nodeId: target.nodeId,
    }),
    action: "removed",
    sequence,
  });
}

function findNextUserReviewRequestBoundary(
  timelineEvents: readonly ReplayTimelineEvent[],
  requestIndex: number,
  targetNodeId: GitHubNodeId,
):
  | Extract<ReplayTimelineEvent, { kind: "review_requested" | "review_request_removed" }>
  | undefined {
  for (const event of timelineEvents.slice(requestIndex + 1)) {
    if (
      (event.kind !== "review_requested" && event.kind !== "review_request_removed") ||
      !isIdentifiedUserReviewRequestTarget(event.target) ||
      event.target.nodeId !== targetNodeId
    ) {
      continue;
    }
    return event;
  }
  return undefined;
}

function hasCurrentUserReviewRequest(
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  targetNodeId: GitHubNodeId,
): boolean {
  return detail.reviewRequests.current.some(
    (request) =>
      isIdentifiedUserReviewRequestTarget(request.target) && request.target.nodeId === targetNodeId,
  );
}

function findFirstMatchingReview(
  reviews: readonly GitHubPullRequestReview[],
  target: IdentifiedUserReviewRequestTarget,
  requestedAt: UtcIsoDateTime,
): GitHubPullRequestReview | undefined {
  return reviews.find((review) => isMatchingUserReviewAfter(review, target, requestedAt));
}

function findFirstMatchingReviewBetween(
  reviews: readonly GitHubPullRequestReview[],
  target: IdentifiedUserReviewRequestTarget,
  requestedAt: UtcIsoDateTime,
  nextRequestedAt: UtcIsoDateTime,
): GitHubPullRequestReview | undefined {
  return reviews.find((review) =>
    isMatchingUserReviewBetween(review, target, requestedAt, nextRequestedAt),
  );
}

function findReviewForRequest(
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  reviews: readonly GitHubPullRequestReview[],
  target: IdentifiedUserReviewRequestTarget,
  requestedAt: UtcIsoDateTime,
  nextBoundary:
    | Extract<ReplayTimelineEvent, { kind: "review_requested" | "review_request_removed" }>
    | undefined,
): GitHubPullRequestReview | undefined {
  if (nextBoundary == null) {
    if (hasCurrentUserReviewRequest(detail, target.nodeId)) {
      return undefined;
    }
    return findFirstMatchingReview(reviews, target, requestedAt);
  }
  if (nextBoundary.kind !== "review_requested") {
    return undefined;
  }
  return findFirstMatchingReviewBetween(reviews, target, requestedAt, nextBoundary.occurredAt);
}

function createSyntheticReviewRequestRemovals(
  item: EnumeratedGitHubItem,
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  adaptations: readonly ReplayTimelineAdaptation[],
  isBot: GitHubBotPredicate,
): readonly ReplayEvent[] {
  const timelineEvents = adaptations
    .slice()
    .sort((left, right) => compareReplayEvents(left.event, right.event))
    .map((adaptation) => adaptation.timelineEvent);
  const reviews = detail.reviews.slice().sort(compareReviews);
  const syntheticEvents: ReplayEvent[] = [];
  const maximumTimelineSequence = adaptations.reduce(
    (maximum, adaptation) => Math.max(maximum, adaptation.event.sequence),
    0,
  );
  for (const [requestIndex, timelineEvent] of timelineEvents.entries()) {
    if (
      timelineEvent.kind !== "review_requested" ||
      !isIdentifiedUserReviewRequestTarget(timelineEvent.target)
    ) {
      continue;
    }
    const nextBoundary = findNextUserReviewRequestBoundary(
      timelineEvents,
      requestIndex,
      timelineEvent.target.nodeId,
    );
    if (nextBoundary?.kind === "review_request_removed") {
      continue;
    }
    const review = findReviewForRequest(
      detail,
      reviews,
      timelineEvent.target,
      timelineEvent.occurredAt,
      nextBoundary,
    );
    if (review == null) {
      continue;
    }
    syntheticEvents.push(
      createSyntheticReviewRequestRemoval(
        item,
        timelineEvent.target,
        review,
        maximumTimelineSequence + 1 + review.sequence,
        isBot,
      ),
    );
  }
  return Object.freeze(syntheticEvents);
}

function createCurrentItem(
  item: EnumeratedGitHubItem,
  detail: GitHubItemDetail,
  isBot: GitHubBotPredicate,
): ReplayCurrentItem {
  const assignees = Object.freeze(
    item.assignees.map((assignee) => normalizeAccountActor(assignee, isBot)),
  );
  if (item.type === "issue") {
    const reviewRequests: readonly [] = [];
    return Object.freeze({
      type: "issue",
      sourceId: detail.sourceId,
      nodeId: item.nodeId,
      createdAt: item.createdAt,
      observedAt: detail.observedAt,
      state: item.state,
      closedAt: item.closedAt,
      assignees,
      reviewRequests,
    });
  }

  if (detail.type !== "pull_request") {
    throw new TypeError("Pull Requestの詳細取得結果がありません");
  }
  const state = item.mergeStatus === "merged" ? "merged" : item.state;
  const reviewRequests = Object.freeze(
    detail.reviewRequests.current.map((request) => {
      const target = normalizeReviewRequestTarget(request.target);
      if (target.status === "unavailable") {
        return Object.freeze({
          sourceId: request.sourceId,
          target: Object.freeze({
            status: "unavailable",
            reason: "actor_unavailable",
          }),
          requestedAt: normalizeReviewRequestRequestedAt(request.requestedAt),
        });
      }
      return Object.freeze({
        sourceId: request.sourceId,
        target: target.target,
        requestedAt: normalizeReviewRequestRequestedAt(request.requestedAt),
      });
    }),
  );
  return Object.freeze({
    type: "pull_request",
    sourceId: detail.sourceId,
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    observedAt: detail.observedAt,
    state,
    closedAt: item.closedAt,
    mergedAt: item.mergeStatus === "merged" ? item.mergedAt : null,
    draft: item.draft,
    assignees,
    reviewRequests,
  });
}

function validateItemAndDetail(item: EnumeratedGitHubItem, detail: GitHubItemDetail): void {
  if (item.nodeId !== detail.nodeId) {
    throw new TypeError("列挙結果と詳細取得結果のitem node IDが一致しません");
  }
  if (item.repositoryId !== detail.repositoryId) {
    throw new TypeError("列挙結果と詳細取得結果のrepository IDが一致しません");
  }
  if (item.number !== detail.number) {
    throw new TypeError("列挙結果と詳細取得結果のitem numberが一致しません");
  }
  if (item.type !== detail.type) {
    throw new TypeError("列挙結果と詳細取得結果のitem種別が一致しません");
  }
  if (item.observedAt !== detail.observedAt) {
    throw new TypeError("列挙結果と詳細取得結果の観測時刻が一致しません");
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged" && item.state !== "closed") {
    throw new TypeError("merge済みPull Requestの現行stateがclosedではありません");
  }
}

/** GitHub詳細取得結果を現行値と履歴イベントへ変換し、項目履歴を再生する。 */
export function replayGitHubItemHistory(
  options: ReplayGitHubItemHistoryOptions,
): ReplayItemHistoryResult {
  validateItemAndDetail(options.item, options.detail);
  const currentItem = createCurrentItem(options.item, options.detail, options.isBot);
  const adaptations: ReplayTimelineAdaptation[] = [];
  for (const timelineEvent of options.detail.timeline) {
    if (!isReplayTimelineEvent(timelineEvent)) {
      continue;
    }
    const adaptation = adaptTimelineEvent(options.item, timelineEvent, options.isBot);
    adaptations.push({
      timelineEvent,
      event: adaptation.event,
    });
  }
  const events = adaptations.map((adaptation) => adaptation.event);
  if (options.detail.type === "pull_request") {
    events.push(
      ...createSyntheticReviewRequestRemovals(
        options.item,
        options.detail,
        adaptations,
        options.isBot,
      ),
    );
  }
  return replayItemHistory({
    trackingStartAt: options.trackingStartAt,
    currentItem,
    history: Object.freeze({
      availability: "available",
      events: Object.freeze(events),
    }),
  });
}

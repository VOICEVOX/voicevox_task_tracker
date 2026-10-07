import { UnreachableError } from "../util/index.js";
import {
  type FreshObservedGitHubPullRequest,
  type ObservedGitHubPullRequestMergeState,
} from "./github-item-observation.js";
import {
  type CheckState,
  type GitHubAccountActor,
  type GitHubNodeId,
  type NormalizedEvent,
  type ReviewState,
} from "./types.js";

type ReviewEvent = Extract<NormalizedEvent, { kind: "review" }>;
type HumanReviewEvent = ReviewEvent &
  Readonly<{
    actor: GitHubAccountActor & Readonly<{ type: "human" }>;
  }>;
type EffectiveReviewState = Extract<ReviewEvent["state"], "approved" | "changes_requested">;

function compareReviewEvents(left: ReviewEvent, right: ReviewEvent): number {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
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

function isHumanReviewEvent(event: NormalizedEvent): event is HumanReviewEvent {
  return event.kind === "review" && event.actor.type === "human";
}

function effectiveReviewStates(
  events: readonly NormalizedEvent[],
): ReadonlyMap<GitHubNodeId, EffectiveReviewState> {
  const statesByActor = new Map<GitHubNodeId, EffectiveReviewState>();
  const reviews = events.filter(isHumanReviewEvent).sort(compareReviewEvents);
  for (const review of reviews) {
    switch (review.state) {
      case "approved":
      case "changes_requested":
        statesByActor.set(review.actor.nodeId, review.state);
        break;
      case "dismissed":
        statesByActor.delete(review.actor.nodeId);
        break;
      case "commented":
        break;
      default:
        throw new UnreachableError(review.state);
    }
  }
  return statesByActor;
}

function hasHumanReviewRequest(
  reviewRequests: FreshObservedGitHubPullRequest["reviewRequests"],
): boolean {
  return reviewRequests.some(
    (request) => request.target.type === "team" || request.target.actor.type === "human",
  );
}

/** 正規化レビューイベントと現行依頼からPull Requestのreview状態を集約する。 */
export function aggregatePullRequestReviewState(
  pullRequest: Pick<FreshObservedGitHubPullRequest, "events" | "reviewRequests">,
): ReviewState {
  const states = [...effectiveReviewStates(pullRequest.events).values()];
  if (states.includes("changes_requested")) {
    return "changes_requested";
  }
  if (hasHumanReviewRequest(pullRequest.reviewRequests)) {
    return "requested";
  }
  if (states.includes("approved")) {
    return "approved";
  }
  return "not_requested";
}

/** merge状態とhead checksからPull Requestのcheck状態を集約する。 */
export function aggregatePullRequestCheckState(
  mergeState: ObservedGitHubPullRequestMergeState,
): CheckState {
  if (mergeState.mergeability === "conflicting" || mergeState.mergeState === "dirty") {
    return "conflict";
  }
  if (mergeState.checks.status === "not_configured") {
    if (mergeState.mergeability === "unknown" && mergeState.mergeState === "unknown") {
      return "unknown";
    }
    return "not_required";
  }
  switch (mergeState.checks.combinedState) {
    case "success":
      return "passing";
    case "expected":
    case "pending":
      return "pending";
    case "error":
    case "failure":
      return "failing";
    default:
      throw new UnreachableError(mergeState.checks.combinedState);
  }
}

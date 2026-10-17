import { UnreachableError } from "../util/index.js";
import { type FreshObservedGitHubPullRequest } from "./github-item-observation.js";
import type {
  HumanCommentEvent,
  PullRequestTransitionBasis,
  ReviewEvent,
} from "./pull-request-state-contracts.js";
import { compareEvents } from "./pull-request-state-decision.js";
import { type GitHubNodeId } from "./types.js";

export function getHumanReviewEvents(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly ReviewEvent[] {
  return Object.freeze(
    pullRequest.events
      .filter(
        (event): event is ReviewEvent => event.kind === "review" && event.actor.type === "human",
      )
      .sort(compareEvents),
  );
}

export function getHumanCommentEvents(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly HumanCommentEvent[] {
  return Object.freeze(
    pullRequest.events
      .filter(
        (event): event is HumanCommentEvent =>
          event.kind === "comment" && event.actor.type === "human",
      )
      .sort(compareEvents),
  );
}

export function getBodyBearingHumanSpeechEvents(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly (HumanCommentEvent | ReviewEvent)[] {
  return Object.freeze(
    [...getHumanCommentEvents(pullRequest), ...getHumanReviewEvents(pullRequest)]
      .filter((event) => !event.bodyEmpty)
      .sort(compareEvents),
  );
}

export function getEffectiveReviews(events: readonly ReviewEvent[]): readonly ReviewEvent[] {
  const reviewsByActor = new Map<GitHubNodeId, ReviewEvent>();
  for (const event of events) {
    switch (event.state) {
      case "approved":
      case "changes_requested":
        reviewsByActor.set(event.actor.nodeId, event);
        break;
      case "dismissed":
        reviewsByActor.delete(event.actor.nodeId);
        break;
      case "commented":
        break;
      default:
        throw new UnreachableError(event.state);
    }
  }
  return Object.freeze([...reviewsByActor.values()].sort(compareEvents));
}

export function previousChangesRequestedForHead(
  effectiveReviews: readonly ReviewEvent[],
  pullRequest: FreshObservedGitHubPullRequest,
  headBasis: PullRequestTransitionBasis,
  previousBasis: PullRequestTransitionBasis,
): readonly ReviewEvent[] {
  return Object.freeze(
    effectiveReviews.filter(
      (review) =>
        review.state === "changes_requested" &&
        !isReviewForCurrentHead(review, pullRequest, headBasis) &&
        review.occurredAt < headBasis.occurredAt &&
        review.occurredAt <= previousBasis.occurredAt,
    ),
  );
}

export function reviewerCommentedReviewsAfterHead(
  pullRequest: FreshObservedGitHubPullRequest,
  reviewerNodeIds: ReadonlySet<GitHubNodeId>,
  headBasis: PullRequestTransitionBasis,
): readonly ReviewEvent[] {
  return Object.freeze(
    getHumanReviewEvents(pullRequest).filter(
      (review) =>
        review.state === "commented" &&
        review.occurredAt > headBasis.occurredAt &&
        reviewerNodeIds.has(review.actor.nodeId),
    ),
  );
}

export function reviewerCommentsAfterHead(
  pullRequest: FreshObservedGitHubPullRequest,
  reviewerNodeIds: ReadonlySet<GitHubNodeId>,
  headBasis: PullRequestTransitionBasis,
): readonly HumanCommentEvent[] {
  return Object.freeze(
    getHumanCommentEvents(pullRequest).filter(
      (comment) =>
        !comment.bodyEmpty &&
        comment.occurredAt > headBasis.occurredAt &&
        reviewerNodeIds.has(comment.actor.nodeId),
    ),
  );
}

export function isReviewForCurrentHead(
  review: ReviewEvent,
  pullRequest: FreshObservedGitHubPullRequest,
  headBasis: PullRequestTransitionBasis,
): boolean {
  if (review.occurredAt >= headBasis.occurredAt) {
    return true;
  }
  return review.commitStatus === "available" && review.commitSha === pullRequest.headSha;
}

import { z } from "zod";

import { createGitHubNodeId, type GitHubNodeId } from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { GitHubResponseValidationError } from "./errors.js";
import {
  normalizeActor,
  normalizeReviewRequestTarget,
  normalizeUnavailableCommit,
} from "./item-detail-accounts.js";
import {
  assertNoDuplicateNodeIds,
  parseGraphqlResponse,
  requireConnectionCursor,
  requireGraphqlNode,
} from "./item-detail-connection.js";
import {
  REVIEW_PAGE_QUERY,
  REVIEW_REQUEST_PAGE_QUERY,
  REVIEW_THREAD_COMMENT_PAGE_QUERY,
  REVIEW_THREAD_PAGE_QUERY,
} from "./item-detail-pagination-queries.js";
import type {
  Graphql,
  RawReview,
  RawReviewComment,
  RawReviewRequest,
  RawReviewThread,
  reviewConnectionSchema,
  reviewRequestConnectionSchema,
  reviewSchema,
  reviewThreadConnectionSchema,
} from "./item-detail-response-schema.js";
import {
  reviewPageResponseSchema,
  reviewRequestPageResponseSchema,
  reviewThreadCommentPageResponseSchema,
  reviewThreadPageResponseSchema,
} from "./item-detail-response-schema.js";
import {
  type GitHubCurrentReviewRequest,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
  type GitHubPullRequestReviewRequests,
  type GitHubPullRequestReviewThread,
  type GitHubReviewCommit,
  type GitHubReviewRequestTimestamp,
  type GitHubTimelineEvent,
} from "./item-detail-types.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import { buildProductionSourceId } from "./production-source-id.js";

export async function collectReviewNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof reviewConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReview[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "Pull Request reviews");
    if (cursor == null) {
      break;
    }
    const response = await graphql(REVIEW_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      reviewPageResponseSchema,
      response,
      "Pull Request review page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "Pull Request review page",
    );
    if (responseItem.reviews.nodes.length === 0) {
      throw new GitHubResponseValidationError("Pull Request review page", {
        cause: new TypeError("次ページとして空のreviews connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.reviews.nodes);
    pageInfo = responseItem.reviews.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "Pull Request reviews",
  );
  return Object.freeze(nodes);
}

function normalizeReviewState(
  state: z.output<typeof reviewSchema>["state"],
): GitHubPullRequestReview["state"] {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      throw new UnreachableError(state);
  }
}

function normalizeReviewCommit(
  commit: z.output<typeof reviewSchema>["commit"],
): GitHubReviewCommit {
  if (commit == null) {
    return normalizeUnavailableCommit();
  }
  const nodeId = createGitHubNodeId(commit.id);
  return Object.freeze({
    status: "available",
    sourceId: buildProductionSourceId("github_commit", nodeId),
    nodeId,
    sha: commit.oid,
  });
}

export function normalizeReviews(nodes: readonly RawReview[]): readonly GitHubPullRequestReview[] {
  return Object.freeze(
    nodes.map((review, sequence) => {
      if (review.submittedAt == null) {
        throw new GitHubResponseValidationError("Pull Request review submission", {
          cause: new TypeError("submitted reviewにsubmittedAtがありません"),
        });
      }
      const nodeId = createGitHubNodeId(review.id);
      return Object.freeze({
        sourceId: buildProductionSourceId("github_pull_request_review", nodeId),
        nodeId,
        sequence,
        state: normalizeReviewState(review.state),
        author: normalizeActor(review.author),
        commit: normalizeReviewCommit(review.commit),
        submittedAt: review.submittedAt,
        body: review.body,
        url: review.url,
      } satisfies GitHubPullRequestReview);
    }),
  );
}

export async function collectReviewThreadNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof reviewThreadConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReviewThread[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "Pull Request review threads");
    if (cursor == null) {
      break;
    }
    const response = await graphql(REVIEW_THREAD_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      reviewThreadPageResponseSchema,
      response,
      "Pull Request review thread page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "Pull Request review thread page",
    );
    if (responseItem.reviewThreads.nodes.length === 0) {
      throw new GitHubResponseValidationError("Pull Request review thread page", {
        cause: new TypeError("次ページとして空のreviewThreads connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.reviewThreads.nodes);
    pageInfo = responseItem.reviewThreads.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "Pull Request review threads",
  );
  return Object.freeze(nodes);
}

async function collectReviewCommentNodes(
  thread: RawReviewThread,
  graphql: Graphql,
): Promise<readonly RawReviewComment[]> {
  const nodes = [...thread.comments.nodes];
  let pageInfo = thread.comments.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "inline review comments");
    if (cursor == null) {
      break;
    }
    const response = await graphql(REVIEW_THREAD_COMMENT_PAGE_QUERY, {
      threadId: thread.id,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      reviewThreadCommentPageResponseSchema,
      response,
      "inline review comment page",
    );
    const responseThread = requireGraphqlNode(
      parsed.thread,
      createGitHubNodeId(thread.id),
      (node) => node.id,
      "inline review comment page",
    );
    if (responseThread.comments.nodes.length === 0) {
      throw new GitHubResponseValidationError("inline review comment page", {
        cause: new TypeError("次ページとして空のreview comments connectionを受け取りました"),
      });
    }
    nodes.push(...responseThread.comments.nodes);
    pageInfo = responseThread.comments.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "inline review comments",
  );
  return Object.freeze(nodes);
}

function normalizeReviewComments(
  nodes: readonly RawReviewComment[],
): readonly GitHubPullRequestReviewComment[] {
  return Object.freeze(
    nodes.map((comment, sequence) => {
      const nodeId = createGitHubNodeId(comment.id);
      return Object.freeze({
        sourceId: buildProductionSourceId("github_pull_request_review_comment", nodeId),
        nodeId,
        sequence,
        author: normalizeActor(comment.author),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
      } satisfies GitHubPullRequestReviewComment);
    }),
  );
}

export async function normalizeReviewThreads(
  nodes: readonly RawReviewThread[],
  graphql: Graphql,
): Promise<readonly GitHubPullRequestReviewThread[]> {
  const threads: GitHubPullRequestReviewThread[] = [];
  for (const [sequence, thread] of nodes.entries()) {
    const comments = await collectReviewCommentNodes(thread, graphql);
    const nodeId = createGitHubNodeId(thread.id);
    threads.push(
      Object.freeze({
        sourceId: buildProductionSourceId("github_pull_request_review_thread", nodeId),
        nodeId,
        sequence,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path,
        resolvedBy: normalizeActor(thread.resolvedBy),
        comments: normalizeReviewComments(comments),
      }),
    );
  }
  return Object.freeze(threads);
}

export async function collectReviewRequestNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof reviewRequestConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReviewRequest[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "current review requests");
    if (cursor == null) {
      break;
    }
    const response = await graphql(REVIEW_REQUEST_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      reviewRequestPageResponseSchema,
      response,
      "current review request page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "current review request page",
    );
    if (responseItem.reviewRequests.nodes.length === 0) {
      throw new GitHubResponseValidationError("current review request page", {
        cause: new TypeError("次ページとして空のreviewRequests connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.reviewRequests.nodes);
    pageInfo = responseItem.reviewRequests.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "current review requests",
  );
  const targetNodeIds = nodes.flatMap((node) =>
    node.requestedReviewer == null ? [] : [node.requestedReviewer.id],
  );
  assertNoDuplicateNodeIds(targetNodeIds, "current review request targets");
  return Object.freeze(nodes);
}

function isReviewRequestEvent(
  event: GitHubTimelineEvent,
): event is Extract<GitHubTimelineEvent, { kind: "review_requested" | "review_request_removed" }> {
  return event.kind === "review_requested" || event.kind === "review_request_removed";
}

function findReviewRequestTimestamp(
  targetNodeId: GitHubNodeId,
  history: GitHubPullRequestReviewRequests["history"],
): GitHubReviewRequestTimestamp {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    assertNonNullable(event, "review request historyのindexが範囲外です");
    if ("status" in event.target) {
      continue;
    }
    if (event.target.nodeId !== targetNodeId) {
      continue;
    }
    if (event.kind === "review_request_removed") {
      throw new GitHubResponseValidationError("current review requests", {
        cause: new TypeError("現行review requestの最新timeline eventが解除を示しています"),
      });
    }
    return Object.freeze({
      status: "available",
      value: event.occurredAt,
    });
  }
  return Object.freeze({
    status: "unavailable",
    reason: "timeline_event_not_found",
  });
}

export function normalizeReviewRequests(
  nodes: readonly RawReviewRequest[],
  timeline: readonly GitHubTimelineEvent[],
): GitHubPullRequestReviewRequests {
  const history = Object.freeze(timeline.filter(isReviewRequestEvent));
  const current: GitHubCurrentReviewRequest[] = nodes.map((request) => {
    const nodeId = createGitHubNodeId(request.id);
    const target = normalizeReviewRequestTarget(request.requestedReviewer);
    return Object.freeze({
      sourceId: buildProductionSourceId("github_review_request", nodeId),
      nodeId,
      target,
      requestedAt:
        "status" in target
          ? Object.freeze({
              status: "unavailable",
              reason: "timeline_event_not_found",
            })
          : findReviewRequestTimestamp(target.nodeId, history),
    });
  });
  return Object.freeze({
    current: Object.freeze(current),
    history,
  });
}

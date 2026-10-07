import { z } from "zod";

import { GitHubItemDetailCollectionError } from "./errors.js";
import { assertItemResponseType, discoverCapabilities } from "./item-detail-capability.js";
import {
  normalizePullRequestMergeState,
  resolvePullRequestHeadCommit,
} from "./item-detail-checks.js";
import { collectPullRequestCommitMembership } from "./item-detail-commits.js";
import type { CollectGitHubItemDetailsOptions } from "./item-detail-collection-contracts.js";
import {
  collectCommentNodes,
  collectTimelineNodes,
  normalizeComments,
} from "./item-detail-comments.js";
import {
  parseGraphqlResponse,
  requireGraphqlNode,
  validateDetailTargets,
  validateItemRepositoryAlias,
} from "./item-detail-connection.js";
import {
  collectClosingIssueNodes,
  normalizeNativeClosingIssues,
  normalizeNativeDependencies,
  normalizeNativeHierarchy,
} from "./item-detail-native-relations.js";
import { createItemDetailQuery } from "./item-detail-queries.js";
import type { baseIssueSchema, basePullRequestSchema } from "./item-detail-response-schema.js";
import { baseItemDetailResponseSchema } from "./item-detail-response-schema.js";
import {
  collectReviewNodes,
  collectReviewRequestNodes,
  collectReviewThreadNodes,
  normalizeReviewRequests,
  normalizeReviews,
  normalizeReviewThreads,
} from "./item-detail-reviews.js";
import {
  collectInboundCrossReferences,
  normalizeCommit,
  normalizeTimeline,
} from "./item-detail-timeline.js";
import {
  type GitHubItemDetail,
  type GitHubItemDetailCapabilities,
  type GitHubItemDetailCollection,
} from "./item-detail-types.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import { buildProductionSourceId } from "./production-source-id.js";
import { type PublicRepository } from "./public-repository-allowlist.js";

async function collectIssueDetail(
  item: EnumeratedGitHubItem,
  issue: z.output<typeof baseIssueSchema>,
  capabilities: GitHubItemDetailCapabilities,
  options: CollectGitHubItemDetailsOptions,
): Promise<GitHubItemDetail> {
  const commentNodes = await collectCommentNodes(item, issue.comments, options.graphql);
  const timelineNodes = await collectTimelineNodes(item, issue.timelineItems, options.graphql);
  const timeline = normalizeTimeline(timelineNodes, item);
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "issue",
    bodySourceId: buildProductionSourceId("github_item_body", item.nodeId),
    body: issue.body,
    comments: normalizeComments(commentNodes),
    timeline,
    inboundCrossReferences: collectInboundCrossReferences(item.nodeId, timeline),
    nativeDependencies: await normalizeNativeDependencies(
      item,
      issue,
      capabilities,
      options.graphql,
    ),
    nativeHierarchy: await normalizeNativeHierarchy(item, issue, capabilities, options.graphql),
    observedAt: options.observedAt,
  });
}

async function collectPullRequestDetail(
  item: EnumeratedGitHubItem,
  pullRequest: z.output<typeof basePullRequestSchema>,
  options: CollectGitHubItemDetailsOptions,
): Promise<GitHubItemDetail> {
  const headCommit = await resolvePullRequestHeadCommit(item.nodeId, pullRequest, options.graphql);
  const commitMembership = await collectPullRequestCommitMembership(
    item,
    pullRequest,
    options.graphql,
  );
  const commentNodes = await collectCommentNodes(item, pullRequest.comments, options.graphql);
  const reviewNodes = await collectReviewNodes(item, pullRequest.reviews, options.graphql);
  const reviewThreadNodes = await collectReviewThreadNodes(
    item,
    pullRequest.reviewThreads,
    options.graphql,
  );
  const reviewRequestNodes = await collectReviewRequestNodes(
    item,
    pullRequest.reviewRequests,
    options.graphql,
  );
  const closingIssueNodes = await collectClosingIssueNodes(
    item,
    pullRequest.closingIssuesReferences,
    options.graphql,
  );
  const timelineNodes = await collectTimelineNodes(
    item,
    pullRequest.timelineItems,
    options.graphql,
  );
  const timeline = normalizeTimeline(timelineNodes, item);
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "pull_request",
    bodySourceId: buildProductionSourceId("github_item_body", item.nodeId),
    body: pullRequest.body,
    comments: normalizeComments(commentNodes),
    timeline,
    inboundCrossReferences: collectInboundCrossReferences(item.nodeId, timeline),
    reviews: normalizeReviews(reviewNodes),
    reviewThreads: await normalizeReviewThreads(reviewThreadNodes, options.graphql),
    reviewRequests: normalizeReviewRequests(reviewRequestNodes, timeline),
    nativeClosingIssues: normalizeNativeClosingIssues(item, closingIssueNodes),
    headSha: pullRequest.headRefOid,
    headCommit: normalizeCommit(item.nodeId, headCommit),
    commitMembership,
    mergeState: await normalizePullRequestMergeState(pullRequest, headCommit, options.graphql),
    observedAt: options.observedAt,
  });
}

type UnavailableEvidenceField =
  | "ReviewRequest.requestedReviewer"
  | "AssignedEvent.assignee"
  | "UnassignedEvent.assignee"
  | "ReviewRequestedEvent.requestedReviewer"
  | "ReviewRequestRemovedEvent.requestedReviewer"
  | "SubIssueAddedEvent.subIssue"
  | "SubIssueRemovedEvent.subIssue"
  | "ParentIssueAddedEvent.parent"
  | "ParentIssueRemovedEvent.parent"
  | "HeadRefForcePushedEvent.afterCommit";

function collectUnavailableEvidenceFields(
  detail: GitHubItemDetail,
): readonly UnavailableEvidenceField[] {
  const foundFields = new Set<UnavailableEvidenceField>();
  if (detail.type === "pull_request") {
    for (const request of detail.reviewRequests.current) {
      if ("status" in request.target) {
        foundFields.add("ReviewRequest.requestedReviewer");
      }
    }
  }
  for (const event of detail.timeline) {
    switch (event.kind) {
      case "assigned":
        if ("status" in event.assignee) {
          foundFields.add("AssignedEvent.assignee");
        }
        break;
      case "unassigned":
        if ("status" in event.assignee) {
          foundFields.add("UnassignedEvent.assignee");
        }
        break;
      case "review_requested":
        if ("status" in event.target) {
          foundFields.add("ReviewRequestedEvent.requestedReviewer");
        }
        break;
      case "review_request_removed":
        if ("status" in event.target) {
          foundFields.add("ReviewRequestRemovedEvent.requestedReviewer");
        }
        break;
      case "sub_issue_added":
        if ("status" in event.subIssue) {
          foundFields.add("SubIssueAddedEvent.subIssue");
        }
        break;
      case "sub_issue_removed":
        if ("status" in event.subIssue) {
          foundFields.add("SubIssueRemovedEvent.subIssue");
        }
        break;
      case "parent_issue_added":
        if ("status" in event.parent) {
          foundFields.add("ParentIssueAddedEvent.parent");
        }
        break;
      case "parent_issue_removed":
        if ("status" in event.parent) {
          foundFields.add("ParentIssueRemovedEvent.parent");
        }
        break;
      case "head_ref_force_pushed":
        if (typeof event.afterSha !== "string") {
          foundFields.add("HeadRefForcePushedEvent.afterCommit");
        }
        break;
      default:
        break;
    }
  }
  const fieldOrder: readonly UnavailableEvidenceField[] = [
    "ReviewRequest.requestedReviewer",
    "AssignedEvent.assignee",
    "UnassignedEvent.assignee",
    "ReviewRequestedEvent.requestedReviewer",
    "ReviewRequestRemovedEvent.requestedReviewer",
    "SubIssueAddedEvent.subIssue",
    "SubIssueRemovedEvent.subIssue",
    "ParentIssueAddedEvent.parent",
    "ParentIssueRemovedEvent.parent",
    "HeadRefForcePushedEvent.afterCommit",
  ];
  return Object.freeze(fieldOrder.filter((field) => foundFields.has(field)));
}

function warnUnavailableEvidence(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
  detail: GitHubItemDetail,
): void {
  const fields = collectUnavailableEvidenceFields(detail);
  if (fields.length === 0) {
    return;
  }
  console.warn(
    `GitHubの判定根拠を除外しました item=${repository.owner}/${repository.name}#${item.number.toString()} fields=${fields.join(",")}`,
  );
}

async function collectItemDetail(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
  capabilities: GitHubItemDetailCapabilities,
  options: CollectGitHubItemDetailsOptions,
): Promise<GitHubItemDetail> {
  validateItemRepositoryAlias(item, repository);
  const response = await options.graphql(createItemDetailQuery(capabilities), {
    itemId: item.nodeId,
  });
  const parsed = parseGraphqlResponse(
    baseItemDetailResponseSchema,
    response,
    `${item.displayReference} details`,
  );
  const responseItem = requireGraphqlNode(
    parsed.item,
    item.nodeId,
    (node) => node.id,
    `${item.displayReference} details`,
  );
  assertItemResponseType(responseItem.__typename, item, `${item.displayReference} details`);
  const detail =
    responseItem.__typename === "Issue"
      ? await collectIssueDetail(item, responseItem, capabilities, options)
      : await collectPullRequestDetail(item, responseItem, options);
  warnUnavailableEvidence(item, repository, detail);
  return detail;
}

/** 公開allowlist内の詳細取得対象から判定に必要なGitHub情報を全ページ収集する。 */
export async function collectGitHubItemDetails(
  options: CollectGitHubItemDetailsOptions,
): Promise<GitHubItemDetailCollection> {
  validateDetailTargets(options.allowlist, options.targets);
  const capabilities = await discoverCapabilities(options.graphql);
  const details: GitHubItemDetail[] = [];
  for (const { item } of options.targets) {
    const repository = options.allowlist.require(item.repositoryId);
    try {
      details.push(await collectItemDetail(item, repository, capabilities, options));
    } catch (error: unknown) {
      if (error instanceof GitHubItemDetailCollectionError) {
        throw error;
      }
      throw new GitHubItemDetailCollectionError(repository.owner, repository.name, item.number, {
        cause: error,
      });
    }
  }
  return Object.freeze({
    capabilities,
    items: Object.freeze(details),
  });
}

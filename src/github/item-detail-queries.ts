import { appendRequiredFragments } from "./item-detail-query-fragments.js";
import { type GitHubItemDetailCapabilities } from "./item-detail-types.js";

export const ITEM_DETAIL_CAPABILITIES_QUERY = appendRequiredFragments(`
  query GitHubItemDetailCapabilities {
    issueType: __type(name: "Issue") {
      fields(includeDeprecated: true) {
        name
      }
    }
  }
`);

export const ISSUE_TIMELINE_ITEM_TYPES = `
  [
    CLOSED_EVENT
    REOPENED_EVENT
    ASSIGNED_EVENT
    UNASSIGNED_EVENT
    LABELED_EVENT
    UNLABELED_EVENT
    CROSS_REFERENCED_EVENT
    CONNECTED_EVENT
    DISCONNECTED_EVENT
    SUB_ISSUE_ADDED_EVENT
    SUB_ISSUE_REMOVED_EVENT
    PARENT_ISSUE_ADDED_EVENT
    PARENT_ISSUE_REMOVED_EVENT
  ]
`;

export const PULL_REQUEST_TIMELINE_ITEM_TYPES = `
  [
    CLOSED_EVENT
    REOPENED_EVENT
    MERGED_EVENT
    ASSIGNED_EVENT
    UNASSIGNED_EVENT
    LABELED_EVENT
    UNLABELED_EVENT
    REVIEW_REQUESTED_EVENT
    REVIEW_REQUEST_REMOVED_EVENT
    READY_FOR_REVIEW_EVENT
    CONVERT_TO_DRAFT_EVENT
    CROSS_REFERENCED_EVENT
    CONNECTED_EVENT
    DISCONNECTED_EVENT
    HEAD_REF_FORCE_PUSHED_EVENT
    PULL_REQUEST_COMMIT
    ADDED_TO_MERGE_QUEUE_EVENT
    REMOVED_FROM_MERGE_QUEUE_EVENT
    AUTO_MERGE_ENABLED_EVENT
    AUTO_MERGE_DISABLED_EVENT
  ]
`;

/** GitHub項目の詳細取得クエリを生成する。 */
export function createItemDetailQuery(capabilities: GitHubItemDetailCapabilities): string {
  const dependencyFields =
    capabilities.nativeDependencies === "available"
      ? `
        blockedBy(first: 100) {
          nodes {
            ...DetailReferencedItemFields
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        blocking(first: 100) {
          nodes {
            ...DetailReferencedItemFields
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      `
      : "";
  const hierarchyFields =
    capabilities.nativeHierarchy === "available"
      ? `
        parent {
          ...DetailReferencedItemFields
        }
        subIssues(first: 100) {
          nodes {
            ...DetailReferencedItemFields
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      `
      : "";

  return appendRequiredFragments(`
    query GitHubItemDetail($itemId: ID!) {
      item: node(id: $itemId) {
        __typename
        ... on Issue {
          id
          body
          comments(first: 100) {
            nodes {
              ...DetailIssueCommentFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          timelineItems(first: 100, itemTypes: ${ISSUE_TIMELINE_ITEM_TYPES}) {
            nodes {
              ...DetailIssueTimelineFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          ${dependencyFields}
          ${hierarchyFields}
        }
        ... on PullRequest {
          id
          body
          closingIssuesReferences(first: 100) {
            nodes {
              ...DetailReferencedItemFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          headRefOid
          headRef {
            target {
              ... on Commit {
                ...DetailHeadCommitFields
              }
            }
          }
          mergeable
          mergeStateStatus
          autoMergeRequest {
            enabledAt
            enabledBy {
              ...DetailActorFields
            }
            mergeMethod
          }
          mergeQueueEntry {
            id
          }
          comments(first: 100) {
            nodes {
              ...DetailIssueCommentFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          reviews(
            first: 100
            states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]
          ) {
            nodes {
              ...DetailReviewFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          reviewThreads(first: 100) {
            nodes {
              ...DetailReviewThreadFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          reviewRequests(first: 100) {
            nodes {
              id
              requestedReviewer {
                ...DetailReviewRequestTargetFields
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          headCommit: commits(last: 1) {
            nodes {
              commit {
                ...DetailHeadCommitFields
              }
            }
          }
          commits(first: 100) {
            totalCount
            nodes {
              commit {
                id
                oid
                committedDate
                pushedDate
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          timelineItems(first: 100, itemTypes: ${PULL_REQUEST_TIMELINE_ITEM_TYPES}) {
            nodes {
              ...DetailPullRequestTimelineFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `);
}

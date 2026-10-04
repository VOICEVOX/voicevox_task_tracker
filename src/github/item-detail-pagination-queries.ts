import {
  ISSUE_TIMELINE_ITEM_TYPES,
  PULL_REQUEST_TIMELINE_ITEM_TYPES,
} from "./item-detail-queries.js";
import { appendRequiredFragments } from "./item-detail-query-fragments.js";

export const PULL_REQUEST_HEAD_COMMIT_QUERY = appendRequiredFragments(`
  query GitHubPullRequestHeadCommit($pullRequestId: ID!, $headRefOid: GitObjectID!) {
    pullRequest: node(id: $pullRequestId) {
      __typename
      ... on PullRequest {
        id
        repository {
          object(oid: $headRefOid) {
            ... on Commit {
              ...DetailHeadCommitFields
            }
          }
        }
      }
    }
  }
`);

export const PULL_REQUEST_COMMIT_PAGE_QUERY = `
  query GitHubPullRequestCommitPage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on PullRequest {
        id
        headRefOid
        commits(first: 100, after: $after) {
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
      }
    }
  }
`;

export const PULL_REQUEST_COMMIT_STABILITY_QUERY = `
  query GitHubPullRequestCommitStability($itemId: ID!) {
    item: node(id: $itemId) {
      __typename
      ... on PullRequest {
        id
        headRefOid
        commits(first: 1) {
          totalCount
        }
      }
    }
  }
`;

export const COMMENT_PAGE_QUERY = appendRequiredFragments(`
  query GitHubItemCommentPage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on Issue {
        id
        comments(first: 100, after: $after) {
          nodes {
            ...DetailIssueCommentFields
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      ... on PullRequest {
        id
        comments(first: 100, after: $after) {
          nodes {
            ...DetailIssueCommentFields
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

/** GitHub項目のタイムライン次ページ取得クエリを生成する。 */
export function createTimelinePageQuery(itemType: "issue" | "pull_request"): string {
  if (itemType === "issue") {
    return appendRequiredFragments(`
      query GitHubIssueTimelinePage($itemId: ID!, $after: String!) {
        item: node(id: $itemId) {
          __typename
          ... on Issue {
            id
            timelineItems(
              first: 100
              after: $after
              itemTypes: ${ISSUE_TIMELINE_ITEM_TYPES}
            ) {
              nodes {
                ...DetailIssueTimelineFields
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
  return appendRequiredFragments(`
    query GitHubPullRequestTimelinePage($itemId: ID!, $after: String!) {
      item: node(id: $itemId) {
        __typename
        ... on PullRequest {
          id
          timelineItems(
            first: 100
            after: $after
            itemTypes: ${PULL_REQUEST_TIMELINE_ITEM_TYPES}
          ) {
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

export const REVIEW_PAGE_QUERY = appendRequiredFragments(`
  query GitHubPullRequestReviewPage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on PullRequest {
        id
        reviews(
          first: 100
          after: $after
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
      }
    }
  }
`);

export const REVIEW_THREAD_PAGE_QUERY = appendRequiredFragments(`
  query GitHubPullRequestReviewThreadPage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on PullRequest {
        id
        reviewThreads(first: 100, after: $after) {
          nodes {
            ...DetailReviewThreadFields
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

export const REVIEW_THREAD_COMMENT_PAGE_QUERY = appendRequiredFragments(`
  query GitHubPullRequestReviewThreadCommentPage($threadId: ID!, $after: String!) {
    thread: node(id: $threadId) {
      __typename
      ... on PullRequestReviewThread {
        id
        comments(first: 100, after: $after) {
          nodes {
            ...DetailReviewCommentFields
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

export const REVIEW_REQUEST_PAGE_QUERY = appendRequiredFragments(`
  query GitHubPullRequestReviewRequestPage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on PullRequest {
        id
        reviewRequests(first: 100, after: $after) {
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
      }
    }
  }
`);

export const CLOSING_ISSUE_PAGE_QUERY = appendRequiredFragments(`
  query GitHubPullRequestClosingIssuePage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on PullRequest {
        id
        closingIssuesReferences(first: 100, after: $after) {
          nodes {
            ...DetailReferencedItemFields
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

/** GitHub Issueの依存関係次ページ取得クエリを生成する。 */
export function createNativeDependencyPageQuery(direction: "blockedBy" | "blocking"): string {
  return appendRequiredFragments(`
    query GitHubNativeDependencyPage($itemId: ID!, $after: String!) {
      item: node(id: $itemId) {
        __typename
        ... on Issue {
          id
          ${direction}(first: 100, after: $after) {
            nodes {
              ...DetailReferencedItemFields
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

export const SUB_ISSUE_PAGE_QUERY = appendRequiredFragments(`
  query GitHubSubIssuePage($itemId: ID!, $after: String!) {
    item: node(id: $itemId) {
      __typename
      ... on Issue {
        id
        subIssues(first: 100, after: $after) {
          nodes {
            ...DetailReferencedItemFields
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

export const CHECK_CONTEXT_PAGE_QUERY = appendRequiredFragments(`
  query GitHubCheckContextPage($commitId: ID!, $after: String!) {
    commit: node(id: $commitId) {
      __typename
      ... on Commit {
        id
        statusCheckRollup {
          id
          state
          contexts(first: 100, after: $after) {
            nodes {
              ...DetailCheckContextFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  }
`);

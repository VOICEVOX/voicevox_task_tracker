import { parse, visit } from "graphql";

import { type GitHubItemDetailCapabilities } from "./item-detail-types.js";

const DETAIL_ACTOR_FIELDS_FRAGMENT = `
  fragment DetailActorFields on Actor {
    __typename
    login
    ... on Node {
      id
    }
  }
`;

const DETAIL_REVIEW_REQUEST_TARGET_FIELDS_FRAGMENT = `
  fragment DetailReviewRequestTargetFields on RequestedReviewer {
    __typename
    ... on Bot {
      id
      login
    }
    ... on Mannequin {
      id
      login
    }
    ... on User {
      id
      login
    }
    ... on Team {
      id
      name
      slug
      organization {
        login
      }
    }
  }
`;

const DETAIL_ASSIGNEE_FIELDS_FRAGMENT = `
  fragment DetailAssigneeFields on Assignee {
    __typename
    ... on Actor {
      login
      ... on Node {
        id
      }
    }
  }
`;

const DETAIL_REFERENCED_ITEM_FIELDS_FRAGMENT = `
  fragment DetailReferencedItemFields on Node {
    __typename
    ... on Issue {
      id
      number
      url
      createdAt
      issueState: state
      repository {
        id
        name
        visibility
        isArchived
        isDisabled
        owner {
          login
        }
      }
    }
    ... on PullRequest {
      id
      number
      url
      createdAt
      pullRequestState: state
      repository {
        id
        name
        visibility
        isArchived
        isDisabled
        owner {
          login
        }
      }
    }
  }
`;

const DETAIL_ISSUE_COMMENT_FIELDS_FRAGMENT = `
  fragment DetailIssueCommentFields on IssueComment {
    id
    author {
      ...DetailActorFields
    }
    body
    createdAt
    updatedAt
    url
  }
`;

const DETAIL_REVIEW_FIELDS_FRAGMENT = `
  fragment DetailReviewFields on PullRequestReview {
    id
    url
    author {
      ...DetailActorFields
    }
    body
    state
    submittedAt
    commit {
      id
      oid
    }
  }
`;

const DETAIL_REVIEW_COMMENT_FIELDS_FRAGMENT = `
  fragment DetailReviewCommentFields on PullRequestReviewComment {
    id
    author {
      ...DetailActorFields
    }
    body
    createdAt
    updatedAt
    url
  }
`;

const DETAIL_REVIEW_THREAD_FIELDS_FRAGMENT = `
  fragment DetailReviewThreadFields on PullRequestReviewThread {
    id
    isResolved
    isOutdated
    path
    resolvedBy {
      ...DetailActorFields
    }
    comments(first: 100) {
      nodes {
        ...DetailReviewCommentFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const DETAIL_CHECK_CONTEXT_FIELDS_FRAGMENT = `
  fragment DetailCheckContextFields on Node {
    __typename
    ... on CheckRun {
      id
      name
      status
      conclusion
      completedAt
    }
    ... on StatusContext {
      id
      context
      state
      createdAt
    }
  }
`;

const DETAIL_HEAD_COMMIT_FIELDS_FRAGMENT = `
  fragment DetailHeadCommitFields on Commit {
    id
    oid
    committedDate
    pushedDate
    statusCheckRollup {
      id
      state
      contexts(first: 100) {
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
`;

const DETAIL_ISSUE_TIMELINE_FIELDS_FRAGMENT = `
  fragment DetailIssueTimelineFields on IssueTimelineItems {
    __typename
    ... on ClosedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on ReopenedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on AssignedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      assignee {
        ...DetailAssigneeFields
      }
    }
    ... on UnassignedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      assignee {
        ...DetailAssigneeFields
      }
    }
    ... on BlockedByAddedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockingIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on BlockedByRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockingIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on BlockingAddedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockedIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on BlockingRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockedIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on LabeledEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      label {
        id
        name
      }
    }
    ... on UnlabeledEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      label {
        id
        name
      }
    }
    ... on CrossReferencedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      source {
        ...DetailReferencedItemFields
      }
      willCloseTarget
    }
    ... on ConnectedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      subject {
        ...DetailReferencedItemFields
      }
    }
    ... on DisconnectedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      subject {
        ...DetailReferencedItemFields
      }
    }
    ... on SubIssueAddedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      subIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on SubIssueRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      subIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on ParentIssueAddedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      parent {
        ...DetailReferencedItemFields
      }
    }
    ... on ParentIssueRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      parent {
        ...DetailReferencedItemFields
      }
    }
  }
`;

const DETAIL_PULL_REQUEST_TIMELINE_FIELDS_FRAGMENT = `
  fragment DetailPullRequestTimelineFields on PullRequestTimelineItems {
    __typename
    ... on ClosedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on ReopenedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on MergedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on AssignedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      assignee {
        ...DetailAssigneeFields
      }
    }
    ... on UnassignedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      assignee {
        ...DetailAssigneeFields
      }
    }
    ... on BlockedByAddedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockingIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on BlockedByRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockingIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on BlockingAddedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockedIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on BlockingRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      blockedIssue {
        ...DetailReferencedItemFields
      }
    }
    ... on LabeledEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      label {
        id
        name
      }
    }
    ... on UnlabeledEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      label {
        id
        name
      }
    }
    ... on ReviewRequestedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      requestedReviewer {
        ...DetailReviewRequestTargetFields
      }
    }
    ... on ReviewRequestRemovedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      requestedReviewer {
        ...DetailReviewRequestTargetFields
      }
    }
    ... on ReadyForReviewEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on ConvertToDraftEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on CrossReferencedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      source {
        ...DetailReferencedItemFields
      }
      willCloseTarget
    }
    ... on ConnectedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      subject {
        ...DetailReferencedItemFields
      }
    }
    ... on DisconnectedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      subject {
        ...DetailReferencedItemFields
      }
    }
    ... on HeadRefForcePushedEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
      beforeCommit {
        oid
      }
      afterCommit {
        oid
      }
    }
    ... on PullRequestCommit {
      id
      commit {
        id
        oid
        committedDate
        pushedDate
      }
    }
    ... on AddedToMergeQueueEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on RemovedFromMergeQueueEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on AutoMergeEnabledEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
    ... on AutoMergeDisabledEvent {
      id
      createdAt
      actor {
        ...DetailActorFields
      }
    }
  }
`;

const GRAPHQL_FRAGMENT_SOURCES: ReadonlyMap<string, string> = new Map([
  ["DetailActorFields", DETAIL_ACTOR_FIELDS_FRAGMENT],
  ["DetailReviewRequestTargetFields", DETAIL_REVIEW_REQUEST_TARGET_FIELDS_FRAGMENT],
  ["DetailAssigneeFields", DETAIL_ASSIGNEE_FIELDS_FRAGMENT],
  ["DetailReferencedItemFields", DETAIL_REFERENCED_ITEM_FIELDS_FRAGMENT],
  ["DetailIssueCommentFields", DETAIL_ISSUE_COMMENT_FIELDS_FRAGMENT],
  ["DetailReviewFields", DETAIL_REVIEW_FIELDS_FRAGMENT],
  ["DetailReviewCommentFields", DETAIL_REVIEW_COMMENT_FIELDS_FRAGMENT],
  ["DetailReviewThreadFields", DETAIL_REVIEW_THREAD_FIELDS_FRAGMENT],
  ["DetailCheckContextFields", DETAIL_CHECK_CONTEXT_FIELDS_FRAGMENT],
  ["DetailHeadCommitFields", DETAIL_HEAD_COMMIT_FIELDS_FRAGMENT],
  ["DetailIssueTimelineFields", DETAIL_ISSUE_TIMELINE_FIELDS_FRAGMENT],
  ["DetailPullRequestTimelineFields", DETAIL_PULL_REQUEST_TIMELINE_FIELDS_FRAGMENT],
]);

function collectFragmentSpreadNames(source: string): readonly string[] {
  const fragmentNames = new Set<string>();
  visit(parse(source), {
    FragmentSpread(node): void {
      fragmentNames.add(node.name.value);
    },
  });
  return Object.freeze([...fragmentNames]);
}

const GRAPHQL_FRAGMENT_DEPENDENCIES: ReadonlyMap<string, readonly string[]> = new Map(
  [...GRAPHQL_FRAGMENT_SOURCES].map(
    ([fragmentName, fragmentSource]) =>
      [fragmentName, collectFragmentSpreadNames(fragmentSource)] as const,
  ),
);
const GRAPHQL_QUERY_CACHE = new Map<string, string>();

function collectRequiredFragmentSources(
  fragmentNames: readonly string[],
  resolvedFragmentNames: Set<string>,
  fragmentSources: string[],
): void {
  for (const fragmentName of fragmentNames) {
    if (resolvedFragmentNames.has(fragmentName)) {
      continue;
    }
    const fragmentSource = GRAPHQL_FRAGMENT_SOURCES.get(fragmentName);
    const dependencies = GRAPHQL_FRAGMENT_DEPENDENCIES.get(fragmentName);
    if (fragmentSource == null || dependencies == null) {
      throw new Error(`未定義のGraphQLフラグメントを参照しています: ${fragmentName}`);
    }
    resolvedFragmentNames.add(fragmentName);
    fragmentSources.push(fragmentSource);
    collectRequiredFragmentSources(dependencies, resolvedFragmentNames, fragmentSources);
  }
}

function appendRequiredFragments(querySource: string): string {
  const cachedQuery = GRAPHQL_QUERY_CACHE.get(querySource);
  if (cachedQuery != null) {
    return cachedQuery;
  }
  const fragmentSources: string[] = [];
  collectRequiredFragmentSources(
    collectFragmentSpreadNames(querySource),
    new Set<string>(),
    fragmentSources,
  );
  const query = [querySource, ...fragmentSources].join("\n");
  GRAPHQL_QUERY_CACHE.set(querySource, query);
  return query;
}

export const ITEM_DETAIL_CAPABILITIES_QUERY = appendRequiredFragments(`
  query GitHubItemDetailCapabilities {
    issueType: __type(name: "Issue") {
      fields(includeDeprecated: true) {
        name
      }
    }
  }
`);

const ISSUE_TIMELINE_ITEM_TYPES = `
  [
    CLOSED_EVENT
    REOPENED_EVENT
    ASSIGNED_EVENT
    UNASSIGNED_EVENT
    BLOCKED_BY_ADDED_EVENT
    BLOCKED_BY_REMOVED_EVENT
    BLOCKING_ADDED_EVENT
    BLOCKING_REMOVED_EVENT
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

const PULL_REQUEST_TIMELINE_ITEM_TYPES = `
  [
    CLOSED_EVENT
    REOPENED_EVENT
    MERGED_EVENT
    ASSIGNED_EVENT
    UNASSIGNED_EVENT
    BLOCKED_BY_ADDED_EVENT
    BLOCKED_BY_REMOVED_EVENT
    BLOCKING_ADDED_EVENT
    BLOCKING_REMOVED_EVENT
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

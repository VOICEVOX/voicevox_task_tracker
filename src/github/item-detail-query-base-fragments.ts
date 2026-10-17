export const DETAIL_ACTOR_FIELDS_FRAGMENT = `
  fragment DetailActorFields on Actor {
    __typename
    login
    ... on Node {
      id
    }
  }
`;

export const DETAIL_REVIEW_REQUEST_TARGET_FIELDS_FRAGMENT = `
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

export const DETAIL_ASSIGNEE_FIELDS_FRAGMENT = `
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

export const DETAIL_REFERENCED_ITEM_FIELDS_FRAGMENT = `
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

export const DETAIL_ISSUE_COMMENT_FIELDS_FRAGMENT = `
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

export const DETAIL_REVIEW_FIELDS_FRAGMENT = `
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

export const DETAIL_REVIEW_COMMENT_FIELDS_FRAGMENT = `
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

export const DETAIL_REVIEW_THREAD_FIELDS_FRAGMENT = `
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

export const DETAIL_CHECK_CONTEXT_FIELDS_FRAGMENT = `
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

export const DETAIL_HEAD_COMMIT_FIELDS_FRAGMENT = `
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

export const DETAIL_ISSUE_TIMELINE_FIELDS_FRAGMENT = `
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

export const DETAIL_PULL_REQUEST_TIMELINE_FIELDS_FRAGMENT = `
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

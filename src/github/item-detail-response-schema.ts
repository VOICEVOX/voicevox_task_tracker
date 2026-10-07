import { z } from "zod";

import { createUtcIsoDateTime, type GitHubItemUrl } from "../domain/index.js";
import { type GitHubClient } from "./client.js";

const CONNECTION_PAGE_SIZE = 100;

const opaqueIdSchema = z.string().min(1).regex(/^\S+$/u);
const shaSchema = z.string().min(1).regex(/^\S+$/u);
const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
  })
  .transform((value) => createUtcIsoDateTime(value));
const githubItemUrlSchema = z.custom<GitHubItemUrl>(
  (value) => {
    if (typeof value !== "string") {
      return false;
    }
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.port.length === 0 &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      return false;
    }
  },
  {
    error: "GitHub項目URLが不正です",
  },
);
const pageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    endCursor: z.string().min(1).nullable(),
  })
  .superRefine((pageInfo, context) => {
    if (pageInfo.hasNextPage && pageInfo.endCursor == null) {
      context.addIssue({
        code: "custom",
        path: ["endCursor"],
        message: "次ページがあるconnectionにはendCursorが必要です",
      });
    }
  });
const githubApiAccountTypeSchema = z.enum([
  "Bot",
  "EnterpriseUserAccount",
  "Mannequin",
  "Organization",
  "User",
]);
export const actorSchema = z
  .object({
    __typename: githubApiAccountTypeSchema,
    id: opaqueIdSchema,
    login: z.string().min(1),
  })
  .nullable();
export const teamSchema = z.object({
  __typename: z.literal("Team"),
  id: opaqueIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  organization: z.object({
    login: z.string().min(1),
  }),
});
export const reviewRequestTargetSchema = z.union([
  z.object({
    __typename: z.enum(["Bot", "Mannequin", "User"]),
    id: opaqueIdSchema,
    login: z.string().min(1),
  }),
  teamSchema,
]);
export const assigneeSchema = z.object({
  __typename: githubApiAccountTypeSchema,
  id: opaqueIdSchema,
  login: z.string().min(1),
});
const referencedRepositorySchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1),
  visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
  isArchived: z.boolean(),
  isDisabled: z.boolean(),
  owner: z.object({
    login: z.string().min(1),
  }),
});
const referencedItemSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("Issue"),
    id: opaqueIdSchema,
    number: z.number().int().positive(),
    url: githubItemUrlSchema,
    createdAt: utcIsoDateTimeSchema,
    issueState: z.enum(["OPEN", "CLOSED"]),
    repository: referencedRepositorySchema,
  }),
  z.object({
    __typename: z.literal("PullRequest"),
    id: opaqueIdSchema,
    number: z.number().int().positive(),
    url: githubItemUrlSchema,
    createdAt: utcIsoDateTimeSchema,
    pullRequestState: z.enum(["OPEN", "CLOSED", "MERGED"]),
    repository: referencedRepositorySchema,
  }),
]);
const commentSchema = z.object({
  id: opaqueIdSchema,
  author: actorSchema,
  body: z.string(),
  createdAt: utcIsoDateTimeSchema,
  updatedAt: utcIsoDateTimeSchema,
  url: githubItemUrlSchema,
});
export const commentConnectionSchema = z.object({
  nodes: z.array(commentSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
export const reviewSchema = z.object({
  id: opaqueIdSchema,
  url: githubItemUrlSchema,
  author: actorSchema,
  body: z.string(),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
  submittedAt: utcIsoDateTimeSchema.nullable(),
  commit: z
    .object({
      id: opaqueIdSchema,
      oid: shaSchema,
    })
    .nullable(),
});
export const reviewConnectionSchema = z.object({
  nodes: z.array(reviewSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const reviewCommentSchema = z.object({
  id: opaqueIdSchema,
  author: actorSchema,
  body: z.string(),
  createdAt: utcIsoDateTimeSchema,
  updatedAt: utcIsoDateTimeSchema,
  url: githubItemUrlSchema,
});
const reviewCommentConnectionSchema = z.object({
  nodes: z.array(reviewCommentSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const reviewThreadSchema = z.object({
  id: opaqueIdSchema,
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string().min(1),
  resolvedBy: actorSchema,
  comments: reviewCommentConnectionSchema,
});
export const reviewThreadConnectionSchema = z.object({
  nodes: z.array(reviewThreadSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const reviewRequestSchema = z.object({
  id: opaqueIdSchema,
  requestedReviewer: reviewRequestTargetSchema.nullable(),
});
export const reviewRequestConnectionSchema = z.object({
  nodes: z.array(reviewRequestSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
export const referencedItemConnectionSchema = z.object({
  nodes: z.array(referencedItemSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
export const checkRunSchema = z.object({
  __typename: z.literal("CheckRun"),
  id: opaqueIdSchema,
  name: z.string().min(1),
  status: z.enum(["COMPLETED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"]),
  conclusion: z
    .enum([
      "ACTION_REQUIRED",
      "CANCELLED",
      "FAILURE",
      "NEUTRAL",
      "SKIPPED",
      "STALE",
      "STARTUP_FAILURE",
      "SUCCESS",
      "TIMED_OUT",
    ])
    .nullable(),
  completedAt: utcIsoDateTimeSchema.nullable(),
});
export const statusContextSchema = z.object({
  __typename: z.literal("StatusContext"),
  id: opaqueIdSchema,
  context: z.string().min(1),
  state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
  createdAt: utcIsoDateTimeSchema,
});
const checkContextSchema = z.discriminatedUnion("__typename", [
  checkRunSchema,
  statusContextSchema,
]);
const checkContextConnectionSchema = z.object({
  nodes: z.array(checkContextSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
export const statusCheckRollupSchema = z.object({
  id: opaqueIdSchema,
  state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
  contexts: checkContextConnectionSchema,
});
export const commitSchema = z.object({
  id: opaqueIdSchema,
  oid: shaSchema,
  committedDate: utcIsoDateTimeSchema,
  pushedDate: utcIsoDateTimeSchema.nullable(),
});
export const headCommitSchema = commitSchema.extend({
  statusCheckRollup: statusCheckRollupSchema.nullable(),
});
const timelineNodeSchema = z
  .object({
    __typename: z.string().min(1),
  })
  .loose();
export const timelineConnectionSchema = z.object({
  nodes: z.array(timelineNodeSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
export const timelineEventBaseSchema = z.object({
  id: opaqueIdSchema,
  createdAt: utcIsoDateTimeSchema,
  actor: actorSchema,
});
export const closedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ClosedEvent"),
});
export const reopenedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReopenedEvent"),
});
export const mergedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("MergedEvent"),
});
export const assignedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AssignedEvent"),
  assignee: assigneeSchema.nullable(),
});
export const unassignedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("UnassignedEvent"),
  assignee: assigneeSchema.nullable(),
});
const labelSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1),
});
export const labeledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("LabeledEvent"),
  label: labelSchema,
});
export const unlabeledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("UnlabeledEvent"),
  label: labelSchema,
});
export const reviewRequestedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReviewRequestedEvent"),
  requestedReviewer: reviewRequestTargetSchema.nullable(),
});
export const reviewRequestRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReviewRequestRemovedEvent"),
  requestedReviewer: reviewRequestTargetSchema.nullable(),
});
export const readyForReviewEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReadyForReviewEvent"),
});
export const convertToDraftEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ConvertToDraftEvent"),
});
export const crossReferencedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("CrossReferencedEvent"),
  source: referencedItemSchema,
  willCloseTarget: z.boolean(),
});
export const connectedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ConnectedEvent"),
  subject: referencedItemSchema,
});
export const disconnectedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("DisconnectedEvent"),
  subject: referencedItemSchema,
});
export const subIssueAddedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("SubIssueAddedEvent"),
  subIssue: referencedItemSchema.nullable(),
});
export const subIssueRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("SubIssueRemovedEvent"),
  subIssue: referencedItemSchema.nullable(),
});
export const parentIssueAddedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ParentIssueAddedEvent"),
  parent: referencedItemSchema.nullable(),
});
export const parentIssueRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ParentIssueRemovedEvent"),
  parent: referencedItemSchema.nullable(),
});
export const headRefForcePushedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("HeadRefForcePushedEvent"),
  beforeCommit: z
    .object({
      oid: shaSchema,
    })
    .nullable(),
  afterCommit: z
    .object({
      oid: shaSchema,
    })
    .nullable(),
});
export const pullRequestCommitEventSchema = z.object({
  __typename: z.literal("PullRequestCommit"),
  id: opaqueIdSchema,
  commit: commitSchema,
});
export const addedToMergeQueueEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AddedToMergeQueueEvent"),
});
export const removedFromMergeQueueEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("RemovedFromMergeQueueEvent"),
});
export const autoMergeEnabledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AutoMergeEnabledEvent"),
});
export const autoMergeDisabledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AutoMergeDisabledEvent"),
});
export const autoMergeRequestSchema = z.object({
  enabledAt: utcIsoDateTimeSchema,
  enabledBy: actorSchema,
  mergeMethod: z.enum(["MERGE", "REBASE", "SQUASH"]),
});
export const mergeQueueEntrySchema = z.object({
  id: opaqueIdSchema,
});
const headRefSchema = z
  .object({
    target: headCommitSchema.nullable(),
  })
  .nullable();
const headCommitConnectionSchema = z.object({
  nodes: z
    .array(
      z.object({
        commit: headCommitSchema,
      }),
    )
    .max(1),
});
export const pullRequestCommitConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  nodes: z.array(z.object({ commit: commitSchema })).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
export const baseIssueSchema = z
  .object({
    __typename: z.literal("Issue"),
    id: opaqueIdSchema,
    body: z.string(),
    comments: commentConnectionSchema,
    timelineItems: timelineConnectionSchema,
    blockedBy: referencedItemConnectionSchema.optional(),
    blocking: referencedItemConnectionSchema.optional(),
    parent: referencedItemSchema.nullable().optional(),
    subIssues: referencedItemConnectionSchema.optional(),
  })
  .loose();
export const basePullRequestSchema = z.object({
  __typename: z.literal("PullRequest"),
  id: opaqueIdSchema,
  body: z.string(),
  closingIssuesReferences: referencedItemConnectionSchema,
  headRefOid: shaSchema,
  headRef: headRefSchema,
  mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
  mergeStateStatus: z.enum([
    "BEHIND",
    "BLOCKED",
    "CLEAN",
    "DIRTY",
    "DRAFT",
    "HAS_HOOKS",
    "UNKNOWN",
    "UNSTABLE",
  ]),
  autoMergeRequest: autoMergeRequestSchema.nullable(),
  mergeQueueEntry: mergeQueueEntrySchema.nullable(),
  comments: commentConnectionSchema,
  reviews: reviewConnectionSchema,
  reviewThreads: reviewThreadConnectionSchema,
  reviewRequests: reviewRequestConnectionSchema,
  headCommit: headCommitConnectionSchema,
  commits: pullRequestCommitConnectionSchema,
  timelineItems: timelineConnectionSchema,
});
export const baseItemDetailResponseSchema = z.object({
  item: z.union([baseIssueSchema, basePullRequestSchema]).nullable(),
});
export const pullRequestHeadCommitResponseSchema = z.object({
  pullRequest: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      repository: z.object({
        object: headCommitSchema.nullable(),
      }),
    })
    .nullable(),
});
export const pullRequestCommitPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      headRefOid: shaSchema,
      commits: pullRequestCommitConnectionSchema,
    })
    .nullable(),
});
export const pullRequestCommitStabilityResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      headRefOid: shaSchema,
      commits: z.object({ totalCount: z.number().int().nonnegative() }),
    })
    .nullable(),
});
export const capabilityResponseSchema = z.object({
  issueType: z
    .object({
      fields: z.array(
        z.object({
          name: z.string().min(1),
        }),
      ),
    })
    .nullable(),
});
export const itemCommentPageResponseSchema = z.object({
  item: z
    .union([
      z.object({
        __typename: z.literal("Issue"),
        id: opaqueIdSchema,
        comments: commentConnectionSchema,
      }),
      z.object({
        __typename: z.literal("PullRequest"),
        id: opaqueIdSchema,
        comments: commentConnectionSchema,
      }),
    ])
    .nullable(),
});
export const itemTimelinePageResponseSchema = z.object({
  item: z
    .union([
      z.object({
        __typename: z.literal("Issue"),
        id: opaqueIdSchema,
        timelineItems: timelineConnectionSchema,
      }),
      z.object({
        __typename: z.literal("PullRequest"),
        id: opaqueIdSchema,
        timelineItems: timelineConnectionSchema,
      }),
    ])
    .nullable(),
});
export const reviewPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      reviews: reviewConnectionSchema,
    })
    .nullable(),
});
export const reviewThreadPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      reviewThreads: reviewThreadConnectionSchema,
    })
    .nullable(),
});
export const reviewThreadCommentPageResponseSchema = z.object({
  thread: z
    .object({
      __typename: z.literal("PullRequestReviewThread"),
      id: opaqueIdSchema,
      comments: reviewCommentConnectionSchema,
    })
    .nullable(),
});
export const reviewRequestPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      reviewRequests: reviewRequestConnectionSchema,
    })
    .nullable(),
});
export const closingIssuePageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      closingIssuesReferences: referencedItemConnectionSchema,
    })
    .nullable(),
});
export const nativeDependencyPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("Issue"),
      id: opaqueIdSchema,
      blockedBy: referencedItemConnectionSchema.optional(),
      blocking: referencedItemConnectionSchema.optional(),
    })
    .nullable(),
});
export const subIssuePageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("Issue"),
      id: opaqueIdSchema,
      subIssues: referencedItemConnectionSchema,
    })
    .nullable(),
});
export const checkContextPageResponseSchema = z.object({
  commit: z
    .object({
      __typename: z.literal("Commit"),
      id: opaqueIdSchema,
      statusCheckRollup: statusCheckRollupSchema.nullable(),
    })
    .nullable(),
});

export type Graphql = GitHubClient["graphql"];
export type RawPageInfo = z.output<typeof pageInfoSchema>;
export type RawComment = z.output<typeof commentSchema>;
export type RawReview = z.output<typeof reviewSchema>;
export type RawReviewComment = z.output<typeof reviewCommentSchema>;
export type RawReviewThread = z.output<typeof reviewThreadSchema>;
export type RawReviewRequest = z.output<typeof reviewRequestSchema>;
export type RawReferencedItem = z.output<typeof referencedItemSchema>;
export type RawCheckContext = z.output<typeof checkContextSchema>;
export type RawTimelineNode = z.output<typeof timelineNodeSchema>;
export type RawActor = NonNullable<z.output<typeof actorSchema>>;

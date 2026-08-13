import { z } from "zod";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemUrl,
  type GitHubNodeId,
  type ObservedGitHubCheckRunConclusion,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { type GitHubClient } from "./client.js";
import {
  GitHubItemDetailCollectionError,
  GitHubPublicBoundaryViolationError,
  GitHubResponseSchemaValidationError,
  GitHubResponseValidationError,
} from "./errors.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import {
  CHECK_CONTEXT_PAGE_QUERY,
  CLOSING_ISSUE_PAGE_QUERY,
  COMMENT_PAGE_QUERY,
  createItemDetailQuery,
  createNativeDependencyPageQuery,
  createTimelinePageQuery,
  ITEM_DETAIL_CAPABILITIES_QUERY,
  PULL_REQUEST_HEAD_COMMIT_QUERY,
  REVIEW_PAGE_QUERY,
  REVIEW_REQUEST_PAGE_QUERY,
  REVIEW_THREAD_COMMENT_PAGE_QUERY,
  REVIEW_THREAD_PAGE_QUERY,
  SUB_ISSUE_PAGE_QUERY,
  USER_CONTENT_EDIT_PAGE_QUERY,
} from "./item-detail-queries.js";
import { buildProductionSourceId } from "./production-source-id.js";
import {
  type GitHubAutoMerge,
  type GitHubCheckContext,
  type GitHubCommitPushedAt,
  type GitHubCurrentReviewRequest,
  type GitHubDetailAccount,
  type GitHubDetailActor,
  type GitHubHeadChecks,
  type GitHubInboundCrossReferenceCandidate,
  type GitHubItemDetail,
  type GitHubItemDetailCapabilities,
  type GitHubItemDetailCollection,
  type GitHubIssueComment,
  type GitHubMergeQueue,
  type GitHubNativeClosingIssue,
  type GitHubNativeDependency,
  type GitHubNativeDependencyCollection,
  type GitHubNativeHierarchy,
  type GitHubNativeHierarchyCollection,
  type GitHubPullRequestCommit,
  type GitHubPullRequestMergeState,
  type GitHubPullRequestReviewDecision,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewComment,
  type GitHubPullRequestReviewRequests,
  type GitHubPullRequestReviewThread,
  type GitHubReferencedItem,
  type GitHubReviewCommit,
  type GitHubReviewRequestTarget,
  type GitHubReviewRequestTimestamp,
  type GitHubTimelineEvent,
  type GitHubTimelineAssignee,
  type GitHubUserContentEdit,
  type GitHubUserContentEditCollection,
} from "./item-detail-types.js";
import {
  type PublicRepository,
  type PublicRepositoryAllowlist,
} from "./public-repository-allowlist.js";

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
const actorSchema = z
  .object({
    __typename: githubApiAccountTypeSchema,
    id: opaqueIdSchema,
    login: z.string().min(1),
  })
  .nullable();
const teamSchema = z.object({
  __typename: z.literal("Team"),
  id: opaqueIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  organization: z.object({
    login: z.string().min(1),
  }),
});
const reviewRequestTargetSchema = z.union([
  z.object({
    __typename: z.enum(["Bot", "Mannequin", "User"]),
    id: opaqueIdSchema,
    login: z.string().min(1),
  }),
  teamSchema,
]);
const assigneeSchema = z.object({
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
const userContentEditSchema = z.object({
  id: opaqueIdSchema,
  createdAt: utcIsoDateTimeSchema,
  deletedAt: utcIsoDateTimeSchema.nullable(),
  diff: z.string().nullable(),
  editedAt: utcIsoDateTimeSchema,
  editor: actorSchema,
  updatedAt: utcIsoDateTimeSchema,
});
const userContentEditConnectionSchema = z.object({
  nodes: z.array(userContentEditSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const commentSchema = z.object({
  id: opaqueIdSchema,
  author: actorSchema,
  body: z.string(),
  createdAt: utcIsoDateTimeSchema,
  lastEditedAt: utcIsoDateTimeSchema.nullable(),
  updatedAt: utcIsoDateTimeSchema,
  userContentEdits: userContentEditConnectionSchema.nullable(),
  url: githubItemUrlSchema,
});
const commentConnectionSchema = z.object({
  nodes: z.array(commentSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const reviewSchema = z.object({
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
const reviewConnectionSchema = z.object({
  nodes: z.array(reviewSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const reviewCommentSchema = z.object({
  id: opaqueIdSchema,
  author: actorSchema,
  body: z.string(),
  createdAt: utcIsoDateTimeSchema,
  lastEditedAt: utcIsoDateTimeSchema.nullable(),
  updatedAt: utcIsoDateTimeSchema,
  userContentEdits: userContentEditConnectionSchema.nullable(),
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
const reviewThreadConnectionSchema = z.object({
  nodes: z.array(reviewThreadSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const reviewRequestSchema = z.object({
  id: opaqueIdSchema,
  requestedReviewer: reviewRequestTargetSchema.nullable(),
});
const reviewRequestConnectionSchema = z.object({
  nodes: z.array(reviewRequestSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const referencedItemConnectionSchema = z.object({
  nodes: z.array(referencedItemSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const checkRunSchema = z.object({
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
const statusContextSchema = z.object({
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
const statusCheckRollupSchema = z.object({
  id: opaqueIdSchema,
  state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
  contexts: checkContextConnectionSchema,
});
const commitSchema = z.object({
  id: opaqueIdSchema,
  oid: shaSchema,
  committedDate: utcIsoDateTimeSchema,
  pushedDate: utcIsoDateTimeSchema.nullable(),
});
const headCommitSchema = commitSchema.extend({
  statusCheckRollup: statusCheckRollupSchema.nullable(),
});
const timelineNodeSchema = z
  .object({
    __typename: z.string().min(1),
  })
  .loose();
const timelineConnectionSchema = z.object({
  nodes: z.array(timelineNodeSchema).max(CONNECTION_PAGE_SIZE),
  pageInfo: pageInfoSchema,
});
const timelineEventBaseSchema = z.object({
  id: opaqueIdSchema,
  createdAt: utcIsoDateTimeSchema,
  actor: actorSchema,
});
const closedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ClosedEvent"),
});
const reopenedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReopenedEvent"),
});
const mergedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("MergedEvent"),
});
const assignedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AssignedEvent"),
  assignee: assigneeSchema.nullable(),
});
const unassignedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("UnassignedEvent"),
  assignee: assigneeSchema.nullable(),
});
const blockedByAddedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("BlockedByAddedEvent"),
  blockingIssue: referencedItemSchema.nullable(),
});
const blockedByRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("BlockedByRemovedEvent"),
  blockingIssue: referencedItemSchema.nullable(),
});
const blockingAddedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("BlockingAddedEvent"),
  blockedIssue: referencedItemSchema.nullable(),
});
const blockingRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("BlockingRemovedEvent"),
  blockedIssue: referencedItemSchema.nullable(),
});
const labelSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1),
});
const labeledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("LabeledEvent"),
  label: labelSchema,
});
const unlabeledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("UnlabeledEvent"),
  label: labelSchema,
});
const reviewRequestedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReviewRequestedEvent"),
  requestedReviewer: reviewRequestTargetSchema.nullable(),
});
const reviewRequestRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReviewRequestRemovedEvent"),
  requestedReviewer: reviewRequestTargetSchema.nullable(),
});
const readyForReviewEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ReadyForReviewEvent"),
});
const convertToDraftEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ConvertToDraftEvent"),
});
const crossReferencedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("CrossReferencedEvent"),
  source: referencedItemSchema,
  willCloseTarget: z.boolean(),
});
const connectedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ConnectedEvent"),
  subject: referencedItemSchema,
});
const disconnectedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("DisconnectedEvent"),
  subject: referencedItemSchema,
});
const subIssueAddedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("SubIssueAddedEvent"),
  subIssue: referencedItemSchema.nullable(),
});
const subIssueRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("SubIssueRemovedEvent"),
  subIssue: referencedItemSchema.nullable(),
});
const parentIssueAddedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ParentIssueAddedEvent"),
  parent: referencedItemSchema.nullable(),
});
const parentIssueRemovedEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("ParentIssueRemovedEvent"),
  parent: referencedItemSchema.nullable(),
});
const headRefForcePushedEventSchema = timelineEventBaseSchema.extend({
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
const pullRequestCommitEventSchema = z.object({
  __typename: z.literal("PullRequestCommit"),
  id: opaqueIdSchema,
  commit: commitSchema,
});
const addedToMergeQueueEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AddedToMergeQueueEvent"),
});
const removedFromMergeQueueEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("RemovedFromMergeQueueEvent"),
});
const autoMergeEnabledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AutoMergeEnabledEvent"),
});
const autoMergeDisabledEventSchema = timelineEventBaseSchema.extend({
  __typename: z.literal("AutoMergeDisabledEvent"),
});
const autoMergeRequestSchema = z.object({
  enabledAt: utcIsoDateTimeSchema,
  enabledBy: actorSchema,
  mergeMethod: z.enum(["MERGE", "REBASE", "SQUASH"]),
});
const mergeQueueEntrySchema = z.object({
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
const baseIssueSchema = z
  .object({
    __typename: z.literal("Issue"),
    id: opaqueIdSchema,
    body: z.string(),
    lastEditedAt: utcIsoDateTimeSchema.nullable(),
    userContentEdits: userContentEditConnectionSchema.nullable(),
    comments: commentConnectionSchema,
    timelineItems: timelineConnectionSchema,
    blockedBy: referencedItemConnectionSchema.optional(),
    blocking: referencedItemConnectionSchema.optional(),
    parent: referencedItemSchema.nullable().optional(),
    subIssues: referencedItemConnectionSchema.optional(),
  })
  .loose();
const basePullRequestSchema = z.object({
  __typename: z.literal("PullRequest"),
  id: opaqueIdSchema,
  body: z.string(),
  lastEditedAt: utcIsoDateTimeSchema.nullable(),
  userContentEdits: userContentEditConnectionSchema.nullable(),
  closingIssuesReferences: referencedItemConnectionSchema,
  headRefOid: shaSchema,
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
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
  timelineItems: timelineConnectionSchema,
});
const baseItemDetailResponseSchema = z.object({
  item: z.union([baseIssueSchema, basePullRequestSchema]).nullable(),
});
const userContentEditPageOwnerSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("Issue"),
    id: opaqueIdSchema,
    userContentEdits: userContentEditConnectionSchema.nullable(),
  }),
  z.object({
    __typename: z.literal("PullRequest"),
    id: opaqueIdSchema,
    userContentEdits: userContentEditConnectionSchema.nullable(),
  }),
  z.object({
    __typename: z.literal("IssueComment"),
    id: opaqueIdSchema,
    userContentEdits: userContentEditConnectionSchema.nullable(),
  }),
  z.object({
    __typename: z.literal("PullRequestReviewComment"),
    id: opaqueIdSchema,
    userContentEdits: userContentEditConnectionSchema.nullable(),
  }),
]);
const userContentEditPageResponseSchema = z.object({
  content: userContentEditPageOwnerSchema.nullable(),
});
const pullRequestHeadCommitResponseSchema = z.object({
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
const capabilityResponseSchema = z.object({
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
const itemCommentPageResponseSchema = z.object({
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
const itemTimelinePageResponseSchema = z.object({
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
const reviewPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      reviews: reviewConnectionSchema,
    })
    .nullable(),
});
const reviewThreadPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      reviewThreads: reviewThreadConnectionSchema,
    })
    .nullable(),
});
const reviewThreadCommentPageResponseSchema = z.object({
  thread: z
    .object({
      __typename: z.literal("PullRequestReviewThread"),
      id: opaqueIdSchema,
      comments: reviewCommentConnectionSchema,
    })
    .nullable(),
});
const reviewRequestPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      reviewRequests: reviewRequestConnectionSchema,
    })
    .nullable(),
});
const closingIssuePageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("PullRequest"),
      id: opaqueIdSchema,
      closingIssuesReferences: referencedItemConnectionSchema,
    })
    .nullable(),
});
const nativeDependencyPageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("Issue"),
      id: opaqueIdSchema,
      blockedBy: referencedItemConnectionSchema.optional(),
      blocking: referencedItemConnectionSchema.optional(),
    })
    .nullable(),
});
const subIssuePageResponseSchema = z.object({
  item: z
    .object({
      __typename: z.literal("Issue"),
      id: opaqueIdSchema,
      subIssues: referencedItemConnectionSchema,
    })
    .nullable(),
});
const checkContextPageResponseSchema = z.object({
  commit: z
    .object({
      __typename: z.literal("Commit"),
      id: opaqueIdSchema,
      statusCheckRollup: statusCheckRollupSchema.nullable(),
    })
    .nullable(),
});

type Graphql = GitHubClient["graphql"];
type RawPageInfo = z.output<typeof pageInfoSchema>;
type RawUserContentEdit = z.output<typeof userContentEditSchema>;
type RawUserContentEditConnection = z.output<typeof userContentEditConnectionSchema>;
type RawComment = z.output<typeof commentSchema>;
type RawReview = z.output<typeof reviewSchema>;
type RawReviewComment = z.output<typeof reviewCommentSchema>;
type RawReviewThread = z.output<typeof reviewThreadSchema>;
type RawReviewRequest = z.output<typeof reviewRequestSchema>;
type RawReferencedItem = z.output<typeof referencedItemSchema>;
type RawCheckContext = z.output<typeof checkContextSchema>;
type RawTimelineNode = z.output<typeof timelineNodeSchema>;
type RawActor = NonNullable<z.output<typeof actorSchema>>;

/** 詳細取得対象のGitHub項目。 */
export type GitHubItemDetailTarget = Readonly<{
  item: EnumeratedGitHubItem;
}>;

export type CollectGitHubItemDetailsOptions = Readonly<{
  allowlist: PublicRepositoryAllowlist;
  targets: readonly GitHubItemDetailTarget[];
  observedAt: UtcIsoDateTime;
  graphql: Graphql;
}>;

function parseGraphqlResponse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  context: string,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new GitHubResponseSchemaValidationError(context, result.error);
  }
  return result.data;
}

function requireGraphqlNode<Value>(
  value: Value | null,
  expectedNodeId: GitHubNodeId,
  getNodeId: (node: Value) => string,
  context: string,
): Value {
  if (value == null) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("要求したGraphQL nodeがありません"),
    });
  }
  if (getNodeId(value) !== expectedNodeId) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("要求したGraphQL node IDと応答が一致しません"),
    });
  }
  return value;
}

function requireConnectionCursor(pageInfo: RawPageInfo, context: string): string | undefined {
  if (!pageInfo.hasNextPage) {
    return undefined;
  }
  if (pageInfo.endCursor == null) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("次ページのcursorがありません"),
    });
  }
  return pageInfo.endCursor;
}

function assertNoDuplicateNodeIds(nodeIds: readonly string[], context: string): void {
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("同じnode IDがconnection内で重複しています"),
    });
  }
}

function normalizeAccount(account: RawActor): GitHubDetailAccount {
  const nodeId = createGitHubNodeId(account.id);
  return Object.freeze({
    sourceId: buildProductionSourceId("github_actor", nodeId),
    nodeId,
    login: account.login,
    apiType: account.__typename,
  });
}

function normalizeUnavailableActor(): Extract<GitHubDetailActor, { status: "unavailable" }> {
  return Object.freeze({
    status: "unavailable",
    reason: "github_did_not_return_actor",
  });
}

function normalizeActor(actor: z.output<typeof actorSchema>): GitHubDetailActor {
  if (actor == null) {
    return normalizeUnavailableActor();
  }
  return Object.freeze({
    status: "identified",
    account: normalizeAccount(actor),
  });
}

function normalizeReviewRequestTarget(
  target: z.output<typeof reviewRequestTargetSchema> | null,
): GitHubReviewRequestTarget {
  if (target == null) {
    return normalizeUnavailableActor();
  }
  const nodeId = createGitHubNodeId(target.id);
  if (target.__typename !== "Team") {
    return Object.freeze({
      type: "user",
      sourceId: buildProductionSourceId("github_user", nodeId),
      nodeId,
      login: target.login,
      apiType: target.__typename,
    });
  }
  return normalizeTeam(target);
}

function normalizeTeam(
  target: z.output<typeof teamSchema>,
): Extract<GitHubReviewRequestTarget, { type: "team" }> {
  const nodeId = createGitHubNodeId(target.id);
  return Object.freeze({
    type: "team",
    sourceId: buildProductionSourceId("github_team", nodeId),
    nodeId,
    organizationLogin: target.organization.login,
    slug: target.slug,
    name: target.name,
  });
}

function normalizeAssignee(
  assignee: z.output<typeof assigneeSchema> | null,
): GitHubTimelineAssignee {
  if (assignee == null) {
    return normalizeUnavailableActor();
  }
  return Object.freeze({
    type: "account",
    account: normalizeAccount(assignee),
  });
}

function normalizeReferencedItem(item: RawReferencedItem): GitHubReferencedItem {
  if (item.repository.visibility !== "PUBLIC") {
    throw new GitHubPublicBoundaryViolationError(1);
  }
  const nodeId = createGitHubNodeId(item.id);
  const repositoryId = createGitHubRepositoryId(item.repository.id);
  const type = item.__typename === "Issue" ? "issue" : "pull_request";
  const expectedKind = type === "issue" ? "issues" : "pull";
  const expectedPath =
    `/${item.repository.owner.login}/${item.repository.name}/${expectedKind}/${item.number.toString()}`.toLowerCase();
  const parsedUrl = new URL(item.url);
  if (
    parsedUrl.pathname.toLowerCase() !== expectedPath ||
    parsedUrl.search.length !== 0 ||
    parsedUrl.hash.length !== 0
  ) {
    throw new GitHubResponseValidationError("参照先IssueまたはPull Request", {
      cause: new TypeError("URLとrepository metadataが一致しません"),
    });
  }
  const state =
    item.__typename === "Issue"
      ? item.issueState === "OPEN"
        ? "open"
        : "closed"
      : item.pullRequestState === "OPEN"
        ? "open"
        : item.pullRequestState === "MERGED"
          ? "merged"
          : "closed";
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item", nodeId),
    nodeId,
    repositoryId,
    repositoryOwner: item.repository.owner.login,
    repositoryName: item.repository.name,
    repositoryArchived: item.repository.isArchived,
    repositoryDisabled: item.repository.isDisabled,
    type,
    number: item.number,
    url: item.url,
    createdAt: item.createdAt,
    state,
  });
}

function normalizeTimelineReferencedItem(
  item: RawReferencedItem | null,
): Extract<GitHubTimelineEvent, { kind: "sub_issue_added" | "sub_issue_removed" }>["subIssue"] {
  if (item == null) {
    return Object.freeze({
      status: "unavailable",
      reason: "github_did_not_return_item",
    });
  }
  return normalizeReferencedItem(item);
}

function normalizeUnavailableCommit(): Extract<GitHubReviewCommit, { status: "unavailable" }> {
  return Object.freeze({
    status: "unavailable",
    reason: "github_did_not_return_commit",
  });
}

function normalizeForcePushCommitSha(
  commit: z.output<typeof headRefForcePushedEventSchema>["beforeCommit"],
): Extract<GitHubTimelineEvent, { kind: "head_ref_force_pushed" }>["beforeSha"] {
  return commit == null ? normalizeUnavailableCommit() : commit.oid;
}

function detectFeatureAvailability(
  fieldNames: ReadonlySet<string>,
  requiredFieldNames: readonly string[],
  context: string,
): "available" | "unavailable" {
  const availableFieldCount = requiredFieldNames.filter((fieldName) =>
    fieldNames.has(fieldName),
  ).length;
  if (availableFieldCount === 0) {
    return "unavailable";
  }
  if (availableFieldCount !== requiredFieldNames.length) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("必要なGraphQL fieldの一部だけが提供されています"),
    });
  }
  return "available";
}

async function discoverCapabilities(graphql: Graphql): Promise<GitHubItemDetailCapabilities> {
  const response = await graphql(ITEM_DETAIL_CAPABILITIES_QUERY, {});
  const parsed = parseGraphqlResponse(
    capabilityResponseSchema,
    response,
    "Issue detail GraphQL capabilities",
  );
  if (parsed.issueType == null) {
    throw new GitHubResponseValidationError("Issue detail GraphQL capabilities", {
      cause: new TypeError("Issue型のschema情報がありません"),
    });
  }
  const fieldNames = new Set(parsed.issueType.fields.map((field) => field.name));
  return Object.freeze({
    nativeDependencies: detectFeatureAvailability(
      fieldNames,
      ["blockedBy", "blocking"],
      "native issue dependency GraphQL capabilities",
    ),
    nativeHierarchy: detectFeatureAvailability(
      fieldNames,
      ["parent", "subIssues"],
      "native sub-issue GraphQL capabilities",
    ),
  });
}

function assertItemResponseType(
  actualType: "Issue" | "PullRequest",
  item: EnumeratedGitHubItem,
  context: string,
): void {
  const expectedType = item.type === "issue" ? "Issue" : "PullRequest";
  if (actualType !== expectedType) {
    throw new GitHubResponseValidationError(context, {
      cause: new TypeError("列挙時と詳細取得時のitem種別が一致しません"),
    });
  }
}

function normalizeUserContentEdits(
  nodes: readonly RawUserContentEdit[],
): readonly GitHubUserContentEdit[] {
  const edits = nodes.map((edit, sequence) => {
    const normalized = Object.freeze({
      sourceId: buildSourceId("github_user_content_edit", edit.id),
      sequence,
      createdAt: edit.createdAt,
      deletedAt: edit.deletedAt,
      diff: edit.diff,
      editedAt: edit.editedAt,
      editor: normalizeActor(edit.editor),
      updatedAt: edit.updatedAt,
    } satisfies GitHubUserContentEdit);
    return normalized;
  });
  edits.sort((left, right) => {
    if (left.editedAt < right.editedAt) {
      return -1;
    }
    if (left.editedAt > right.editedAt) {
      return 1;
    }
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    if (left.sourceId < right.sourceId) {
      return -1;
    }
    if (left.sourceId > right.sourceId) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(edits);
}

async function collectUserContentEdits(
  contentNodeId: GitHubNodeId,
  initialConnection: RawUserContentEditConnection | null,
  graphql: Graphql,
  context: string,
): Promise<GitHubUserContentEditCollection> {
  if (initialConnection == null) {
    return Object.freeze({
      availability: "unavailable",
      reason: "connection_null",
    });
  }
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, `${context}編集履歴`);
    if (cursor == null) {
      break;
    }
    const response = await graphql(USER_CONTENT_EDIT_PAGE_QUERY, {
      contentId: contentNodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      userContentEditPageResponseSchema,
      response,
      `${context}編集履歴ページ`,
    );
    const responseContent = requireGraphqlNode(
      parsed.content,
      contentNodeId,
      (node) => node.id,
      `${context}編集履歴ページ`,
    );
    const responseConnection = responseContent.userContentEdits;
    if (responseConnection == null) {
      return Object.freeze({
        availability: "unavailable",
        reason: "connection_null",
      });
    }
    if (responseConnection.nodes.length === 0) {
      throw new GitHubResponseValidationError(`${context}編集履歴ページ`, {
        cause: new TypeError("次ページとして空のuserContentEdits connectionを受け取りました"),
      });
    }
    nodes.push(...responseConnection.nodes);
    pageInfo = responseConnection.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    `${context}編集履歴`,
  );
  return Object.freeze({
    availability: "available",
    edits: normalizeUserContentEdits(nodes),
  });
}

async function collectCommentNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof commentConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawComment[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "issue comments");
    if (cursor == null) {
      break;
    }
    const response = await graphql(COMMENT_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      itemCommentPageResponseSchema,
      response,
      "issue comment page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "issue comment page",
    );
    assertItemResponseType(responseItem.__typename, item, "issue comment page");
    if (responseItem.comments.nodes.length === 0) {
      throw new GitHubResponseValidationError("issue comment page", {
        cause: new TypeError("次ページとして空のcomments connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.comments.nodes);
    pageInfo = responseItem.comments.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "issue comments",
  );
  return Object.freeze(nodes);
}

async function normalizeComments(
  nodes: readonly RawComment[],
  graphql: Graphql,
): Promise<readonly GitHubIssueComment[]> {
  const comments: GitHubIssueComment[] = [];
  for (const [sequence, comment] of nodes.entries()) {
    const nodeId = createGitHubNodeId(comment.id);
    comments.push(
      Object.freeze({
        sourceId: buildProductionSourceId("github_issue_comment", nodeId),
        nodeId,
        sequence,
        author: normalizeActor(comment.author),
        body: comment.body,
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
        userContentEdits: await collectUserContentEdits(
          nodeId,
          comment.userContentEdits,
          graphql,
          "Issue comment",
        ),
      } satisfies GitHubIssueComment),
    );
  }
  return Object.freeze(comments);
}

async function collectTimelineNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof timelineConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawTimelineNode[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  const query = createTimelinePageQuery(item.type);
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "timeline events");
    if (cursor == null) {
      break;
    }
    const response = await graphql(query, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      itemTimelinePageResponseSchema,
      response,
      "timeline event page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "timeline event page",
    );
    assertItemResponseType(responseItem.__typename, item, "timeline event page");
    if (responseItem.timelineItems.nodes.length === 0) {
      throw new GitHubResponseValidationError("timeline event page", {
        cause: new TypeError("次ページとして空のtimeline connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.timelineItems.nodes);
    pageInfo = responseItem.timelineItems.pageInfo;
  }
  const nodeIds = nodes.map((node) => {
    const id = node["id"];
    if (typeof id !== "string") {
      throw new GitHubResponseValidationError("timeline events", {
        cause: new TypeError("timeline eventにnode IDがありません"),
      });
    }
    return id;
  });
  assertNoDuplicateNodeIds(nodeIds, "timeline events");
  return Object.freeze(nodes);
}

function normalizeCommit(commit: z.output<typeof commitSchema>): GitHubPullRequestCommit {
  const nodeId = createGitHubNodeId(commit.id);
  const pushedAt: GitHubCommitPushedAt =
    commit.pushedDate == null
      ? Object.freeze({
          status: "unavailable",
          reason: "github_did_not_return_pushed_at",
        })
      : Object.freeze({
          status: "available",
          value: commit.pushedDate,
        });
  return Object.freeze({
    sourceId: buildProductionSourceId("github_commit", nodeId),
    nodeId,
    sha: commit.oid,
    committedAt: commit.committedDate,
    pushedAt,
  });
}

function normalizeTimelineBase(
  event: z.output<typeof timelineEventBaseSchema>,
  sequence: number,
): Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  occurredAt: UtcIsoDateTime;
  actor: GitHubDetailActor;
}> {
  const nodeId = createGitHubNodeId(event.id);
  return {
    sourceId: buildProductionSourceId("github_timeline_event", nodeId),
    nodeId,
    sequence,
    occurredAt: event.createdAt,
    actor: normalizeActor(event.actor),
  };
}

function normalizeSimpleTimelineEvent(
  event: z.output<typeof timelineEventBaseSchema>,
  sequence: number,
  kind:
    | "closed"
    | "reopened"
    | "merged"
    | "ready_for_review"
    | "converted_to_draft"
    | "added_to_merge_queue"
    | "removed_from_merge_queue"
    | "auto_merge_enabled"
    | "auto_merge_disabled",
): GitHubTimelineEvent {
  return Object.freeze({
    ...normalizeTimelineBase(event, sequence),
    kind,
  });
}

function normalizeTimelineNode(node: RawTimelineNode, sequence: number): GitHubTimelineEvent {
  switch (node.__typename) {
    case "ClosedEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(closedEventSchema, node, "ClosedEvent"),
        sequence,
        "closed",
      );
    case "ReopenedEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(reopenedEventSchema, node, "ReopenedEvent"),
        sequence,
        "reopened",
      );
    case "MergedEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(mergedEventSchema, node, "MergedEvent"),
        sequence,
        "merged",
      );
    case "AssignedEvent": {
      const event = parseGraphqlResponse(assignedEventSchema, node, "AssignedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "assigned",
        assignee: normalizeAssignee(event.assignee),
      });
    }
    case "UnassignedEvent": {
      const event = parseGraphqlResponse(unassignedEventSchema, node, "UnassignedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "unassigned",
        assignee: normalizeAssignee(event.assignee),
      });
    }
    case "BlockedByAddedEvent": {
      const event = parseGraphqlResponse(blockedByAddedEventSchema, node, "BlockedByAddedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "blocked_by_added",
        blockingIssue: normalizeTimelineReferencedItem(event.blockingIssue),
      });
    }
    case "BlockedByRemovedEvent": {
      const event = parseGraphqlResponse(
        blockedByRemovedEventSchema,
        node,
        "BlockedByRemovedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "blocked_by_removed",
        blockingIssue: normalizeTimelineReferencedItem(event.blockingIssue),
      });
    }
    case "BlockingAddedEvent": {
      const event = parseGraphqlResponse(blockingAddedEventSchema, node, "BlockingAddedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "blocking_added",
        blockedIssue: normalizeTimelineReferencedItem(event.blockedIssue),
      });
    }
    case "BlockingRemovedEvent": {
      const event = parseGraphqlResponse(blockingRemovedEventSchema, node, "BlockingRemovedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "blocking_removed",
        blockedIssue: normalizeTimelineReferencedItem(event.blockedIssue),
      });
    }
    case "LabeledEvent": {
      const event = parseGraphqlResponse(labeledEventSchema, node, "LabeledEvent");
      const labelNodeId = createGitHubNodeId(event.label.id);
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "labeled",
        label: Object.freeze({
          sourceId: buildProductionSourceId("github_label", labelNodeId),
          nodeId: labelNodeId,
          name: event.label.name,
        }),
      });
    }
    case "UnlabeledEvent": {
      const event = parseGraphqlResponse(unlabeledEventSchema, node, "UnlabeledEvent");
      const labelNodeId = createGitHubNodeId(event.label.id);
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "unlabeled",
        label: Object.freeze({
          sourceId: buildProductionSourceId("github_label", labelNodeId),
          nodeId: labelNodeId,
          name: event.label.name,
        }),
      });
    }
    case "ReviewRequestedEvent": {
      const event = parseGraphqlResponse(reviewRequestedEventSchema, node, "ReviewRequestedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "review_requested",
        target: normalizeReviewRequestTarget(event.requestedReviewer),
      });
    }
    case "ReviewRequestRemovedEvent": {
      const event = parseGraphqlResponse(
        reviewRequestRemovedEventSchema,
        node,
        "ReviewRequestRemovedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "review_request_removed",
        target: normalizeReviewRequestTarget(event.requestedReviewer),
      });
    }
    case "ReadyForReviewEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(readyForReviewEventSchema, node, "ReadyForReviewEvent"),
        sequence,
        "ready_for_review",
      );
    case "ConvertToDraftEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(convertToDraftEventSchema, node, "ConvertToDraftEvent"),
        sequence,
        "converted_to_draft",
      );
    case "CrossReferencedEvent": {
      const event = parseGraphqlResponse(crossReferencedEventSchema, node, "CrossReferencedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "cross_referenced",
        source: normalizeReferencedItem(event.source),
        willCloseTarget: event.willCloseTarget,
      });
    }
    case "ConnectedEvent": {
      const event = parseGraphqlResponse(connectedEventSchema, node, "ConnectedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "connected",
        subject: normalizeReferencedItem(event.subject),
      });
    }
    case "DisconnectedEvent": {
      const event = parseGraphqlResponse(disconnectedEventSchema, node, "DisconnectedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "disconnected",
        subject: normalizeReferencedItem(event.subject),
      });
    }
    case "SubIssueAddedEvent": {
      const event = parseGraphqlResponse(subIssueAddedEventSchema, node, "SubIssueAddedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "sub_issue_added",
        subIssue: normalizeTimelineReferencedItem(event.subIssue),
      });
    }
    case "SubIssueRemovedEvent": {
      const event = parseGraphqlResponse(subIssueRemovedEventSchema, node, "SubIssueRemovedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "sub_issue_removed",
        subIssue: normalizeTimelineReferencedItem(event.subIssue),
      });
    }
    case "ParentIssueAddedEvent": {
      const event = parseGraphqlResponse(
        parentIssueAddedEventSchema,
        node,
        "ParentIssueAddedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "parent_issue_added",
        parent: normalizeTimelineReferencedItem(event.parent),
      });
    }
    case "ParentIssueRemovedEvent": {
      const event = parseGraphqlResponse(
        parentIssueRemovedEventSchema,
        node,
        "ParentIssueRemovedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "parent_issue_removed",
        parent: normalizeTimelineReferencedItem(event.parent),
      });
    }
    case "HeadRefForcePushedEvent": {
      const event = parseGraphqlResponse(
        headRefForcePushedEventSchema,
        node,
        "HeadRefForcePushedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "head_ref_force_pushed",
        beforeSha: normalizeForcePushCommitSha(event.beforeCommit),
        afterSha: normalizeForcePushCommitSha(event.afterCommit),
      });
    }
    case "PullRequestCommit": {
      const event = parseGraphqlResponse(pullRequestCommitEventSchema, node, "PullRequestCommit");
      const nodeId = createGitHubNodeId(event.id);
      return Object.freeze({
        sourceId: buildProductionSourceId("github_timeline_event", nodeId),
        nodeId,
        sequence,
        kind: "commit_added",
        commit: normalizeCommit(event.commit),
      });
    }
    case "AddedToMergeQueueEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(addedToMergeQueueEventSchema, node, "AddedToMergeQueueEvent"),
        sequence,
        "added_to_merge_queue",
      );
    case "RemovedFromMergeQueueEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(removedFromMergeQueueEventSchema, node, "RemovedFromMergeQueueEvent"),
        sequence,
        "removed_from_merge_queue",
      );
    case "AutoMergeEnabledEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(autoMergeEnabledEventSchema, node, "AutoMergeEnabledEvent"),
        sequence,
        "auto_merge_enabled",
      );
    case "AutoMergeDisabledEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(autoMergeDisabledEventSchema, node, "AutoMergeDisabledEvent"),
        sequence,
        "auto_merge_disabled",
      );
    default:
      throw new GitHubResponseValidationError("timeline event", {
        cause: new TypeError(`未対応のtimeline eventです。種別: ${node.__typename}`),
      });
  }
}

function normalizeTimeline(nodes: readonly RawTimelineNode[]): readonly GitHubTimelineEvent[] {
  return Object.freeze(nodes.map(normalizeTimelineNode));
}

function collectInboundCrossReferences(
  targetNodeId: GitHubNodeId,
  timeline: readonly GitHubTimelineEvent[],
): readonly GitHubInboundCrossReferenceCandidate[] {
  const candidates: GitHubInboundCrossReferenceCandidate[] = [];
  for (const event of timeline) {
    if (event.kind !== "cross_referenced" || event.source.nodeId === targetNodeId) {
      continue;
    }
    candidates.push(
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_inbound_cross_reference",
          `${event.nodeId}:${event.source.nodeId}`,
        ),
        candidateOnly: true,
        provenance: "cross_reference",
        eventSourceId: event.sourceId,
        sourceItem: event.source,
        willCloseTarget: event.willCloseTarget,
      }),
    );
  }
  return Object.freeze(candidates);
}

async function collectReviewNodes(
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

function normalizeReviews(nodes: readonly RawReview[]): readonly GitHubPullRequestReview[] {
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

async function collectReviewThreadNodes(
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

async function normalizeReviewComments(
  nodes: readonly RawReviewComment[],
  graphql: Graphql,
): Promise<readonly GitHubPullRequestReviewComment[]> {
  const comments: GitHubPullRequestReviewComment[] = [];
  for (const [sequence, comment] of nodes.entries()) {
    const nodeId = createGitHubNodeId(comment.id);
    comments.push(
      Object.freeze({
        sourceId: buildProductionSourceId("github_pull_request_review_comment", nodeId),
        nodeId,
        sequence,
        author: normalizeActor(comment.author),
        body: comment.body,
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
        userContentEdits: await collectUserContentEdits(
          nodeId,
          comment.userContentEdits,
          graphql,
          "Pull Request review comment",
        ),
      } satisfies GitHubPullRequestReviewComment),
    );
  }
  return Object.freeze(comments);
}

async function normalizeReviewThreads(
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
        comments: await normalizeReviewComments(comments, graphql),
      }),
    );
  }
  return Object.freeze(threads);
}

async function collectReviewRequestNodes(
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

function normalizeReviewRequests(
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

async function collectClosingIssueNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof referencedItemConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReferencedItem[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "Pull Request closing issues");
    if (cursor == null) {
      break;
    }
    const response = await graphql(CLOSING_ISSUE_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      closingIssuePageResponseSchema,
      response,
      "Pull Request closing issue page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "Pull Request closing issue page",
    );
    if (responseItem.closingIssuesReferences.nodes.length === 0) {
      throw new GitHubResponseValidationError("Pull Request closing issue page", {
        cause: new TypeError(
          "次ページとして空のclosingIssuesReferences connectionを受け取りました",
        ),
      });
    }
    nodes.push(...responseItem.closingIssuesReferences.nodes);
    pageInfo = responseItem.closingIssuesReferences.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "Pull Request closing issues",
  );
  return Object.freeze(nodes);
}

function normalizeNativeClosingIssues(
  item: EnumeratedGitHubItem,
  nodes: readonly RawReferencedItem[],
): readonly GitHubNativeClosingIssue[] {
  return Object.freeze(
    nodes.map((relatedItem) => {
      if (relatedItem.__typename !== "Issue") {
        throw new GitHubResponseValidationError("Pull Request closing issues", {
          cause: new TypeError("closingIssuesReferencesにIssue以外が含まれています"),
        });
      }
      const normalizedItem = normalizeReferencedItem(relatedItem);
      return Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_closing_issue",
          `${item.nodeId}:${normalizedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relatedItem: normalizedItem,
      } satisfies GitHubNativeClosingIssue);
    }),
  );
}

async function collectReferencedItemNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof referencedItemConnectionSchema>,
  direction: "blockedBy" | "blocking",
  graphql: Graphql,
): Promise<readonly RawReferencedItem[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  const query = createNativeDependencyPageQuery(direction);
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, `native dependency ${direction}`);
    if (cursor == null) {
      break;
    }
    const response = await graphql(query, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      nativeDependencyPageResponseSchema,
      response,
      `native dependency ${direction} page`,
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      `native dependency ${direction} page`,
    );
    const connection = direction === "blockedBy" ? responseItem.blockedBy : responseItem.blocking;
    if (connection == null) {
      throw new GitHubResponseValidationError(`native dependency ${direction} page`, {
        cause: new TypeError("要求したnative dependency connectionがありません"),
      });
    }
    if (connection.nodes.length === 0) {
      throw new GitHubResponseValidationError(`native dependency ${direction} page`, {
        cause: new TypeError("次ページとして空のdependency connectionを受け取りました"),
      });
    }
    nodes.push(...connection.nodes);
    pageInfo = connection.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    `native dependency ${direction}`,
  );
  return Object.freeze(nodes);
}

async function normalizeNativeDependencies(
  item: EnumeratedGitHubItem,
  issue: z.output<typeof baseIssueSchema>,
  capabilities: GitHubItemDetailCapabilities,
  graphql: Graphql,
): Promise<GitHubNativeDependencyCollection> {
  if (capabilities.nativeDependencies === "unavailable") {
    return Object.freeze({
      availability: "unavailable",
      reason: "api_not_supported",
    });
  }
  if (issue.blockedBy == null || issue.blocking == null) {
    throw new GitHubResponseValidationError("native issue dependencies", {
      cause: new TypeError("利用可能なnative dependency connectionがありません"),
    });
  }
  const blockedByNodes = await collectReferencedItemNodes(
    item,
    issue.blockedBy,
    "blockedBy",
    graphql,
  );
  const blockingNodes = await collectReferencedItemNodes(item, issue.blocking, "blocking", graphql);
  const relations: GitHubNativeDependency[] = [
    ...blockedByNodes.map((relatedItem) => {
      const normalizedItem = normalizeReferencedItem(relatedItem);
      return Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_dependency",
          `${item.nodeId}:blocked_by:${normalizedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        direction: "blocked_by",
        relatedItem: normalizedItem,
      } satisfies GitHubNativeDependency);
    }),
    ...blockingNodes.map((relatedItem) => {
      const normalizedItem = normalizeReferencedItem(relatedItem);
      return Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_dependency",
          `${item.nodeId}:blocking:${normalizedItem.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        direction: "blocking",
        relatedItem: normalizedItem,
      } satisfies GitHubNativeDependency);
    }),
  ];
  return Object.freeze({
    availability: "available",
    relations: Object.freeze(relations),
  });
}

async function collectSubIssueNodes(
  item: EnumeratedGitHubItem,
  initialConnection: z.output<typeof referencedItemConnectionSchema>,
  graphql: Graphql,
): Promise<readonly RawReferencedItem[]> {
  const nodes = [...initialConnection.nodes];
  let pageInfo = initialConnection.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "native sub-issues");
    if (cursor == null) {
      break;
    }
    const response = await graphql(SUB_ISSUE_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      subIssuePageResponseSchema,
      response,
      "native sub-issue page",
    );
    const responseItem = requireGraphqlNode(
      parsed.item,
      item.nodeId,
      (node) => node.id,
      "native sub-issue page",
    );
    if (responseItem.subIssues.nodes.length === 0) {
      throw new GitHubResponseValidationError("native sub-issue page", {
        cause: new TypeError("次ページとして空のsubIssues connectionを受け取りました"),
      });
    }
    nodes.push(...responseItem.subIssues.nodes);
    pageInfo = responseItem.subIssues.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "native sub-issues",
  );
  return Object.freeze(nodes);
}

async function normalizeNativeHierarchy(
  item: EnumeratedGitHubItem,
  issue: z.output<typeof baseIssueSchema>,
  capabilities: GitHubItemDetailCapabilities,
  graphql: Graphql,
): Promise<GitHubNativeHierarchyCollection> {
  if (capabilities.nativeHierarchy === "unavailable") {
    return Object.freeze({
      availability: "unavailable",
      reason: "api_not_supported",
    });
  }
  if (!Object.hasOwn(issue, "parent") || issue.subIssues == null) {
    throw new GitHubResponseValidationError("native sub-issue hierarchy", {
      cause: new TypeError("利用可能なnative hierarchy fieldがありません"),
    });
  }
  const subIssueNodes = await collectSubIssueNodes(item, issue.subIssues, graphql);
  const relations: GitHubNativeHierarchy[] = [];
  if (issue.parent != null) {
    const parent = normalizeReferencedItem(issue.parent);
    relations.push(
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_hierarchy",
          `${item.nodeId}:parent:${parent.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relationship: "parent",
        relatedItem: parent,
      }),
    );
  }
  for (const subIssueNode of subIssueNodes) {
    const subIssue = normalizeReferencedItem(subIssueNode);
    relations.push(
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_native_hierarchy",
          `${item.nodeId}:sub_issue:${subIssue.nodeId}`,
        ),
        authoritative: true,
        provenance: "native",
        relationship: "sub_issue",
        relatedItem: subIssue,
      }),
    );
  }
  return Object.freeze({
    availability: "available",
    relations: Object.freeze(relations),
  });
}

async function collectCheckContextNodes(
  commit: z.output<typeof headCommitSchema>,
  rollup: z.output<typeof statusCheckRollupSchema>,
  graphql: Graphql,
): Promise<readonly RawCheckContext[]> {
  const nodes = [...rollup.contexts.nodes];
  let pageInfo = rollup.contexts.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, "head commit check contexts");
    if (cursor == null) {
      break;
    }
    const response = await graphql(CHECK_CONTEXT_PAGE_QUERY, {
      commitId: commit.id,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(
      checkContextPageResponseSchema,
      response,
      "head commit check context page",
    );
    const responseCommit = requireGraphqlNode(
      parsed.commit,
      createGitHubNodeId(commit.id),
      (node) => node.id,
      "head commit check context page",
    );
    const responseRollup = responseCommit.statusCheckRollup;
    if (responseRollup?.id !== rollup.id) {
      throw new GitHubResponseValidationError("head commit check context page", {
        cause: new TypeError("status check rollupが途中で変化しました"),
      });
    }
    if (responseRollup.contexts.nodes.length === 0) {
      throw new GitHubResponseValidationError("head commit check context page", {
        cause: new TypeError("次ページとして空のcheck contexts connectionを受け取りました"),
      });
    }
    nodes.push(...responseRollup.contexts.nodes);
    pageInfo = responseRollup.contexts.pageInfo;
  }
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "head commit check contexts",
  );
  return Object.freeze(nodes);
}

function normalizeCheckRunStatus(
  status: z.output<typeof checkRunSchema>["status"],
): Extract<GitHubCheckContext, { type: "check_run" }>["status"] {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "IN_PROGRESS":
      return "in_progress";
    case "PENDING":
      return "pending";
    case "QUEUED":
      return "queued";
    case "REQUESTED":
      return "requested";
    case "WAITING":
      return "waiting";
    default:
      throw new UnreachableError(status);
  }
}

function normalizeCheckRunConclusion(
  conclusion: Exclude<z.output<typeof checkRunSchema>["conclusion"], null>,
): ObservedGitHubCheckRunConclusion {
  switch (conclusion) {
    case "ACTION_REQUIRED":
      return "action_required";
    case "CANCELLED":
      return "cancelled";
    case "FAILURE":
      return "failure";
    case "NEUTRAL":
      return "neutral";
    case "SKIPPED":
      return "skipped";
    case "STALE":
      return "stale";
    case "STARTUP_FAILURE":
      return "startup_failure";
    case "SUCCESS":
      return "success";
    case "TIMED_OUT":
      return "timed_out";
    default:
      throw new UnreachableError(conclusion);
  }
}

function normalizeCheckRunContext(
  context: z.output<typeof checkRunSchema>,
  nodeId: GitHubNodeId,
): Extract<GitHubCheckContext, { type: "check_run" }> {
  const fields = {
    type: "check_run",
    sourceId: buildProductionSourceId("github_check_run", nodeId),
    nodeId,
    name: context.name,
  } satisfies Pick<
    Extract<GitHubCheckContext, { type: "check_run" }>,
    "type" | "sourceId" | "nodeId" | "name"
  >;
  const status = normalizeCheckRunStatus(context.status);
  if (status === "completed") {
    if (context.conclusion == null) {
      throw new GitHubResponseValidationError("head commit check run", {
        cause: new TypeError("完了済みcheck runにconclusionがありません"),
      });
    }
    if (context.completedAt == null) {
      throw new GitHubResponseValidationError("head commit check run", {
        cause: new TypeError("完了済みcheck runに完了時刻がありません"),
      });
    }
    return Object.freeze({
      ...fields,
      status,
      conclusion: normalizeCheckRunConclusion(context.conclusion),
      completedAt: context.completedAt,
    });
  }
  if (context.conclusion != null) {
    throw new GitHubResponseValidationError("head commit check run", {
      cause: new TypeError("未完了check runにconclusionがあります"),
    });
  }
  if (context.completedAt != null) {
    throw new GitHubResponseValidationError("head commit check run", {
      cause: new TypeError("未完了check runに完了時刻があります"),
    });
  }
  return Object.freeze({
    ...fields,
    status,
    conclusion: "not_completed",
    completedAt: null,
  });
}

function normalizeCombinedStatus(
  state: z.output<typeof statusContextSchema>["state"],
): Extract<GitHubCheckContext, { type: "commit_status" }>["state"] {
  switch (state) {
    case "ERROR":
      return "error";
    case "EXPECTED":
      return "expected";
    case "FAILURE":
      return "failure";
    case "PENDING":
      return "pending";
    case "SUCCESS":
      return "success";
    default:
      throw new UnreachableError(state);
  }
}

function normalizeCheckContexts(nodes: readonly RawCheckContext[]): readonly GitHubCheckContext[] {
  return Object.freeze(
    nodes.map((context) => {
      const nodeId = createGitHubNodeId(context.id);
      if (context.__typename === "CheckRun") {
        return normalizeCheckRunContext(context, nodeId);
      }
      return Object.freeze({
        type: "commit_status",
        sourceId: buildProductionSourceId("github_commit_status", nodeId),
        nodeId,
        context: context.context,
        state: normalizeCombinedStatus(context.state),
        createdAt: context.createdAt,
      });
    }),
  );
}

async function normalizeHeadChecks(
  commit: z.output<typeof headCommitSchema>,
  graphql: Graphql,
): Promise<GitHubHeadChecks> {
  if (commit.statusCheckRollup == null) {
    return Object.freeze({
      status: "not_configured",
    });
  }
  const contexts = await collectCheckContextNodes(commit, commit.statusCheckRollup, graphql);
  const nodeId = createGitHubNodeId(commit.statusCheckRollup.id);
  return Object.freeze({
    status: "configured",
    sourceId: buildProductionSourceId("github_status_check_rollup", nodeId),
    nodeId,
    combinedState: normalizeCombinedStatus(commit.statusCheckRollup.state),
    contexts: normalizeCheckContexts(contexts),
  });
}

function normalizeMergeability(
  mergeability: z.output<typeof basePullRequestSchema>["mergeable"],
): GitHubPullRequestMergeState["mergeability"] {
  switch (mergeability) {
    case "CONFLICTING":
      return "conflicting";
    case "MERGEABLE":
      return "mergeable";
    case "UNKNOWN":
      return "unknown";
    default:
      throw new UnreachableError(mergeability);
  }
}

function normalizeMergeState(
  mergeState: z.output<typeof basePullRequestSchema>["mergeStateStatus"],
): GitHubPullRequestMergeState["mergeState"] {
  switch (mergeState) {
    case "BEHIND":
      return "behind";
    case "BLOCKED":
      return "blocked";
    case "CLEAN":
      return "clean";
    case "DIRTY":
      return "dirty";
    case "DRAFT":
      return "draft";
    case "HAS_HOOKS":
      return "has_hooks";
    case "UNKNOWN":
      return "unknown";
    case "UNSTABLE":
      return "unstable";
    default:
      throw new UnreachableError(mergeState);
  }
}

function normalizeMergeMethod(
  mergeMethod: z.output<typeof autoMergeRequestSchema>["mergeMethod"],
): Extract<GitHubAutoMerge, { status: "enabled" }>["mergeMethod"] {
  switch (mergeMethod) {
    case "MERGE":
      return "merge";
    case "REBASE":
      return "rebase";
    case "SQUASH":
      return "squash";
    default:
      throw new UnreachableError(mergeMethod);
  }
}

function normalizeAutoMerge(
  autoMergeRequest: z.output<typeof autoMergeRequestSchema> | null,
  pullRequestNodeId: GitHubNodeId,
): GitHubAutoMerge {
  if (autoMergeRequest == null) {
    return Object.freeze({
      status: "not_enabled",
    });
  }
  return Object.freeze({
    status: "enabled",
    sourceId: buildProductionSourceId("github_auto_merge_request", pullRequestNodeId),
    enabledAt: autoMergeRequest.enabledAt,
    enabledBy: normalizeActor(autoMergeRequest.enabledBy),
    mergeMethod: normalizeMergeMethod(autoMergeRequest.mergeMethod),
  });
}

function normalizeMergeQueue(
  mergeQueueEntry: z.output<typeof mergeQueueEntrySchema> | null,
): GitHubMergeQueue {
  if (mergeQueueEntry == null) {
    return Object.freeze({
      status: "not_queued",
    });
  }
  const nodeId = createGitHubNodeId(mergeQueueEntry.id);
  return Object.freeze({
    status: "queued",
    sourceId: buildProductionSourceId("github_merge_queue_entry", nodeId),
    nodeId,
  });
}

function normalizeReviewDecision(
  reviewDecision: z.output<typeof basePullRequestSchema>["reviewDecision"],
): GitHubPullRequestReviewDecision {
  switch (reviewDecision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    case null:
      return null;
    default:
      throw new UnreachableError(reviewDecision);
  }
}

async function normalizePullRequestMergeState(
  pullRequest: z.output<typeof basePullRequestSchema>,
  headCommit: z.output<typeof headCommitSchema>,
  graphql: Graphql,
): Promise<GitHubPullRequestMergeState> {
  return Object.freeze({
    mergeability: normalizeMergeability(pullRequest.mergeable),
    mergeState: normalizeMergeState(pullRequest.mergeStateStatus),
    autoMerge: normalizeAutoMerge(pullRequest.autoMergeRequest, createGitHubNodeId(pullRequest.id)),
    mergeQueue: normalizeMergeQueue(pullRequest.mergeQueueEntry),
    checks: await normalizeHeadChecks(headCommit, graphql),
  });
}

async function resolvePullRequestHeadCommit(
  pullRequestNodeId: GitHubNodeId,
  pullRequest: z.output<typeof basePullRequestSchema>,
  graphql: Graphql,
): Promise<z.output<typeof headCommitSchema>> {
  const headRefTarget = pullRequest.headRef?.target;
  if (headRefTarget?.oid === pullRequest.headRefOid) {
    return headRefTarget;
  }
  const comparisonHeadCommit = pullRequest.headCommit.nodes.at(-1)?.commit;
  if (comparisonHeadCommit?.oid === pullRequest.headRefOid) {
    return comparisonHeadCommit;
  }

  const context = `Pull Request head SHA ${pullRequest.headRefOid}のCommit解決`;
  const response = await graphql(PULL_REQUEST_HEAD_COMMIT_QUERY, {
    pullRequestId: pullRequestNodeId,
    headRefOid: pullRequest.headRefOid,
  });
  const parsed = parseGraphqlResponse(pullRequestHeadCommitResponseSchema, response, context);
  const responsePullRequest = requireGraphqlNode(
    parsed.pullRequest,
    pullRequestNodeId,
    (node) => node.id,
    context,
  );
  const repositoryObject = responsePullRequest.repository.object;
  if (repositoryObject?.oid === pullRequest.headRefOid) {
    return repositoryObject;
  }
  throw new GitHubResponseValidationError(context, {
    cause: new TypeError("repository.objectからhead SHAに一致するCommitを解決できません"),
  });
}

function validateDetailTargets(
  allowlist: PublicRepositoryAllowlist,
  targets: readonly GitHubItemDetailTarget[],
): void {
  const itemNodeIds = new Set<GitHubNodeId>();
  for (const { item } of targets) {
    allowlist.require(item.repositoryId);
    if (itemNodeIds.has(item.nodeId)) {
      throw new TypeError(`詳細取得対象のitem node IDが重複しています。対象: ${item.nodeId}`);
    }
    itemNodeIds.add(item.nodeId);
  }
}

function validateItemRepositoryAlias(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
): void {
  const expectedDisplayReference =
    `${repository.owner}/${repository.name}#${item.number.toString()}`.toLowerCase();
  if (item.displayReference.toLowerCase() !== expectedDisplayReference) {
    throw new GitHubResponseValidationError("詳細取得対象のrepository alias", {
      cause: new TypeError("allowlistとitemの表示用別名が一致しません"),
    });
  }
}

async function collectIssueDetail(
  item: EnumeratedGitHubItem,
  issue: z.output<typeof baseIssueSchema>,
  capabilities: GitHubItemDetailCapabilities,
  options: CollectGitHubItemDetailsOptions,
): Promise<GitHubItemDetail> {
  const commentNodes = await collectCommentNodes(item, issue.comments, options.graphql);
  const timelineNodes = await collectTimelineNodes(item, issue.timelineItems, options.graphql);
  const timeline = normalizeTimeline(timelineNodes);
  const bodyUserContentEdits = await collectUserContentEdits(
    item.nodeId,
    issue.userContentEdits,
    options.graphql,
    "Issue本文",
  );
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "issue",
    bodySourceId: buildProductionSourceId("github_item_body", item.nodeId),
    body: issue.body,
    lastEditedAt: issue.lastEditedAt,
    bodyUserContentEdits,
    comments: await normalizeComments(commentNodes, options.graphql),
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
  const timeline = normalizeTimeline(timelineNodes);
  const bodyUserContentEdits = await collectUserContentEdits(
    item.nodeId,
    pullRequest.userContentEdits,
    options.graphql,
    "Pull Request本文",
  );
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "pull_request",
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    bodySourceId: buildProductionSourceId("github_item_body", item.nodeId),
    body: pullRequest.body,
    lastEditedAt: pullRequest.lastEditedAt,
    bodyUserContentEdits,
    comments: await normalizeComments(commentNodes, options.graphql),
    timeline,
    inboundCrossReferences: collectInboundCrossReferences(item.nodeId, timeline),
    reviews: normalizeReviews(reviewNodes),
    reviewThreads: await normalizeReviewThreads(reviewThreadNodes, options.graphql),
    reviewRequests: normalizeReviewRequests(reviewRequestNodes, timeline),
    nativeClosingIssues: normalizeNativeClosingIssues(item, closingIssueNodes),
    headSha: pullRequest.headRefOid,
    headCommit: normalizeCommit(headCommit),
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

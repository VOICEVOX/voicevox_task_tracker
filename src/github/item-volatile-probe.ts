import { z } from "zod";

import { createGitHubNodeId, createUtcIsoDateTime, type GitHubNodeId } from "../domain/index.js";
import { type GitHubClient } from "./client.js";
import {
  GitHubPullRequestVolatileRaceError,
  GitHubPullRequestVolatileRaceRetryExhaustedError,
  GitHubResponseSchemaValidationError,
  GitHubResponseValidationError,
  type GitHubPullRequestVolatileRaceKind,
} from "./errors.js";
import { type GitHubCheckContext, type GitHubHeadChecks } from "./item-detail-types.js";
import {
  createGitHubPullRequestVolatileMetadata,
  type GitHubPullRequestReviewDecision,
  type GitHubPullRequestVolatileMetadata,
  type GitHubPullRequestVolatileMergeState,
  type GitHubVolatileActor,
  type GitHubVolatileAutoMerge,
  type GitHubVolatileMergeQueue,
  type GitHubVolatileReviewRequest,
  type GitHubVolatileReviewRequestTarget,
} from "./item-volatile-metadata.js";
import { buildProductionSourceId } from "./production-source-id.js";

const PROBE_BATCH_SIZE = 50;
const CONNECTION_PAGE_SIZE = 100;
const MAX_VOLATILE_PROBE_ATTEMPTS = 5;
const VOLATILE_PROBE_INITIAL_DELAY_MILLISECONDS = 2_000;
const VOLATILE_PROBE_MAX_DELAY_MILLISECONDS = 16_000;

const nodeIdSchema = z.string().min(1).regex(/^\S+$/u);
const shaSchema = z.string().min(1).regex(/^\S+$/u);
const utcIsoDateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => createUtcIsoDateTime(value));
const pageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    endCursor: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((pageInfo, context) => {
    if (pageInfo.hasNextPage && pageInfo.endCursor == null) {
      context.addIssue({
        code: "custom",
        path: ["endCursor"],
        message: "次ページがあるconnectionにはendCursorが必要です",
      });
    }
  });

const volatileActorSchema = z
  .object({
    __typename: z.enum(["Bot", "EnterpriseUserAccount", "Mannequin", "Organization", "User"]),
    id: nodeIdSchema,
  })
  .strict()
  .nullable();

const reviewRequestTargetSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("Bot"), id: nodeIdSchema }).strict(),
  z.object({ __typename: z.literal("Mannequin"), id: nodeIdSchema }).strict(),
  z.object({ __typename: z.literal("Team"), id: nodeIdSchema }).strict(),
  z.object({ __typename: z.literal("User"), id: nodeIdSchema }).strict(),
]);

const reviewRequestNodeSchema = z
  .object({
    id: nodeIdSchema,
    requestedReviewer: reviewRequestTargetSchema.nullable(),
  })
  .strict();

const reviewRequestConnectionSchema = z
  .object({
    nodes: z.array(reviewRequestNodeSchema).max(CONNECTION_PAGE_SIZE),
    pageInfo: pageInfoSchema,
    totalCount: z.number().int().nonnegative(),
  })
  .strict();

const checkRunSchema = z
  .object({
    __typename: z.literal("CheckRun"),
    id: nodeIdSchema,
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
  })
  .strict();

const statusContextSchema = z
  .object({
    __typename: z.literal("StatusContext"),
    id: nodeIdSchema,
    context: z.string().min(1),
    state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
    createdAt: utcIsoDateTimeSchema,
  })
  .strict();

const checkContextSchema = z.discriminatedUnion("__typename", [
  checkRunSchema,
  statusContextSchema,
]);

const checkContextConnectionSchema = z
  .object({
    nodes: z.array(checkContextSchema).max(CONNECTION_PAGE_SIZE),
    pageInfo: pageInfoSchema,
    totalCount: z.number().int().nonnegative(),
  })
  .strict();

const statusCheckRollupSchema = z
  .object({
    id: nodeIdSchema,
    state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
    commit: z
      .object({
        id: nodeIdSchema,
        oid: shaSchema,
      })
      .strict()
      .nullable(),
    contexts: checkContextConnectionSchema,
  })
  .strict();
const statusCheckRollupIdentitySchema = z
  .object({
    id: nodeIdSchema,
    state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
    commit: z
      .object({
        id: nodeIdSchema,
        oid: shaSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const autoMergeRequestSchema = z
  .object({
    enabledAt: utcIsoDateTimeSchema,
    enabledBy: volatileActorSchema,
    mergeMethod: z.enum(["MERGE", "REBASE", "SQUASH"]),
  })
  .strict();

const mergeQueueEntrySchema = z.object({ id: nodeIdSchema }).strict();

const pullRequestProbeNodeSchema = z
  .object({
    __typename: z.literal("PullRequest"),
    id: nodeIdSchema,
    headRefOid: shaSchema,
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
    reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
    autoMergeRequest: autoMergeRequestSchema.nullable(),
    mergeQueueEntry: mergeQueueEntrySchema.nullable(),
    reviewRequests: reviewRequestConnectionSchema.nullable(),
    statusCheckRollup: statusCheckRollupSchema.nullable(),
  })
  .strict();

const probeResponseSchema = z
  .object({
    nodes: z.array(pullRequestProbeNodeSchema.nullable()).max(PROBE_BATCH_SIZE),
  })
  .strict();

const reviewRequestPageResponseSchema = z
  .object({
    pullRequest: z
      .object({
        __typename: z.literal("PullRequest"),
        id: nodeIdSchema,
        headRefOid: shaSchema,
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
        reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
        autoMergeRequest: autoMergeRequestSchema.nullable(),
        mergeQueueEntry: mergeQueueEntrySchema.nullable(),
        statusCheckRollup: statusCheckRollupIdentitySchema.nullable(),
        reviewRequests: reviewRequestConnectionSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const checkContextPageResponseSchema = z
  .object({
    commit: z
      .object({
        __typename: z.literal("Commit"),
        id: nodeIdSchema,
        oid: shaSchema,
        statusCheckRollup: statusCheckRollupSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

type Graphql = GitHubClient["graphql"];
type RawProbeNode = z.output<typeof pullRequestProbeNodeSchema>;
type RawReviewRequestNode = z.output<typeof reviewRequestNodeSchema>;
type RawReviewRequestConnection = z.output<typeof reviewRequestConnectionSchema>;
type RawCheckContext = z.output<typeof checkContextSchema>;
type RawCheckContextConnection = z.output<typeof checkContextConnectionSchema>;
type RawStatusCheckRollup = z.output<typeof statusCheckRollupSchema>;
type RawPageInfo = z.output<typeof pageInfoSchema>;

export const PULL_REQUEST_VOLATILE_PROBE_QUERY = `
  query GitHubPullRequestVolatileProbe($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on PullRequest {
        id
        headRefOid
        mergeable
        mergeStateStatus
        reviewDecision
        autoMergeRequest {
          enabledAt
          enabledBy {
            __typename
            ... on Node {
              id
            }
          }
          mergeMethod
        }
        mergeQueueEntry {
          id
        }
        reviewRequests(first: 100) {
          nodes {
            id
            requestedReviewer {
              __typename
              ... on Bot {
                id
              }
              ... on Mannequin {
                id
              }
              ... on Team {
                id
              }
              ... on User {
                id
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
          totalCount
        }
        statusCheckRollup {
          id
          state
          commit {
            id
            oid
          }
          contexts(first: 100) {
            nodes {
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
            pageInfo {
              hasNextPage
              endCursor
            }
            totalCount
          }
        }
      }
    }
  }
`;

export const REVIEW_REQUEST_PAGE_QUERY = `
  query GitHubPullRequestVolatileReviewRequestPage($pullRequestId: ID!, $after: String) {
    pullRequest: node(id: $pullRequestId) {
      __typename
      ... on PullRequest {
        id
        headRefOid
        mergeable
        mergeStateStatus
        reviewDecision
        autoMergeRequest {
          enabledAt
          enabledBy {
            __typename
            ... on Node {
              id
            }
          }
          mergeMethod
        }
        mergeQueueEntry {
          id
        }
        statusCheckRollup {
          id
          state
          commit {
            id
            oid
          }
        }
        reviewRequests(first: 100, after: $after) {
          nodes {
            id
            requestedReviewer {
              __typename
              ... on Bot {
                id
              }
              ... on Mannequin {
                id
              }
              ... on Team {
                id
              }
              ... on User {
                id
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
          totalCount
        }
      }
    }
  }
`;

export const CHECK_CONTEXT_PAGE_QUERY = `
  query GitHubPullRequestVolatileCheckContextPage($commitId: ID!, $after: String) {
    commit: node(id: $commitId) {
      __typename
      ... on Commit {
        id
        oid
        statusCheckRollup {
          id
          state
          commit {
            id
            oid
          }
          contexts(first: 100, after: $after) {
            nodes {
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
            pageInfo {
              hasNextPage
              endCursor
            }
            totalCount
          }
        }
      }
    }
  }
`;

/** PR volatile probeをGraphQLで取得する入力。 */
export type ProbeGitHubPullRequestVolatileMetadataOptions = Readonly<{
  pullRequestNodeIds: readonly GitHubNodeId[];
  graphql: Graphql;
}>;

/** PR volatile probeの決定論的な取得結果。 */
export type GitHubPullRequestVolatileProbeCollection = Readonly<{
  items: readonly GitHubPullRequestVolatileMetadata[];
}>;

/** PR volatile probeの再試行へ注入する実行時依存。 */
export type GitHubPullRequestVolatileProbeRuntime = Readonly<{
  sleep: (delayMilliseconds: number) => Promise<void>;
}>;

/** PR volatile probeとdetail照合を同じ再試行単位で実行する入力。 */
export type ProbeGitHubPullRequestVolatileMetadataWithRetryOptions =
  ProbeGitHubPullRequestVolatileMetadataOptions &
    Readonly<{
      runtime: GitHubPullRequestVolatileProbeRuntime;
      validateDetail?: (
        collection: GitHubPullRequestVolatileProbeCollection,
      ) => void | Promise<void>;
    }>;

function createResponseValidationError(
  context: string,
  message: string,
): GitHubResponseValidationError {
  return new GitHubResponseValidationError(context, {
    cause: new TypeError(message),
  });
}

function createRaceError(
  kind: GitHubPullRequestVolatileRaceKind,
  nodeId: GitHubNodeId,
  message: string,
): GitHubPullRequestVolatileRaceError {
  return new GitHubPullRequestVolatileRaceError(kind, nodeId, {
    cause: new TypeError(message),
  });
}

function calculateVolatileProbeRetryDelayMilliseconds(attempt: number): number {
  return Math.min(
    VOLATILE_PROBE_MAX_DELAY_MILLISECONDS,
    VOLATILE_PROBE_INITIAL_DELAY_MILLISECONDS * 2 ** attempt,
  );
}

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

function assertNoDuplicateNodeIds(nodeIds: readonly string[], context: string): void {
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw createResponseValidationError(context, "同じnode IDが重複しています");
  }
}

function requireConnection<Value>(connection: Value | null, context: string): Value {
  if (connection == null) {
    throw createResponseValidationError(context, "要求したconnectionがありません");
  }
  return connection;
}

function requireCursor(pageInfo: RawPageInfo, context: string): string | null {
  if (!pageInfo.hasNextPage) {
    return null;
  }
  if (pageInfo.endCursor == null) {
    throw createResponseValidationError(context, "次ページのcursorがありません");
  }
  return pageInfo.endCursor;
}

function normalizeReviewDecision(
  reviewDecision: RawProbeNode["reviewDecision"],
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
      throw createResponseValidationError(
        "Pull Request review decision",
        "未知のreview decisionです",
      );
  }
}

function normalizeActor(actor: z.output<typeof volatileActorSchema>): GitHubVolatileActor {
  if (actor == null) {
    return Object.freeze({ status: "unavailable" });
  }
  return Object.freeze({
    status: "identified",
    nodeId: createGitHubNodeId(actor.id),
    apiType: actor.__typename,
  });
}

function normalizeReviewRequestTarget(
  target: z.output<typeof reviewRequestTargetSchema> | null,
): GitHubVolatileReviewRequestTarget {
  if (target == null) {
    return Object.freeze({ status: "unavailable" });
  }
  const nodeId = createGitHubNodeId(target.id);
  if (target.__typename === "Team") {
    return Object.freeze({ status: "identified", kind: "team", nodeId });
  }
  return Object.freeze({
    status: "identified",
    kind: "actor",
    nodeId,
    apiType: target.__typename,
  });
}

function normalizeReviewRequest(node: RawReviewRequestNode): GitHubVolatileReviewRequest {
  return Object.freeze({
    requestNodeId: createGitHubNodeId(node.id),
    target: normalizeReviewRequestTarget(node.requestedReviewer),
  });
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
      throw createResponseValidationError("Pull Request check run", "未知のcheck run statusです");
  }
}

function normalizeCheckRunConclusion(
  conclusion: Exclude<z.output<typeof checkRunSchema>["conclusion"], null>,
): Extract<
  Extract<GitHubCheckContext, { type: "check_run" }>,
  { status: "completed" }
>["conclusion"] {
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
      throw createResponseValidationError(
        "Pull Request check run",
        "未知のcheck run conclusionです",
      );
  }
}

function normalizeCombinedState(
  state: "ERROR" | "EXPECTED" | "FAILURE" | "PENDING" | "SUCCESS",
): Extract<GitHubHeadChecks, { status: "configured" }>["combinedState"] {
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
      throw createResponseValidationError("Pull Request check rollup", "未知のcheck stateです");
  }
}

function normalizeCheckContext(node: RawCheckContext): GitHubCheckContext {
  const nodeId = createGitHubNodeId(node.id);
  if (node.__typename === "StatusContext") {
    return Object.freeze({
      type: "commit_status",
      sourceId: buildProductionSourceId("github_commit_status", nodeId),
      nodeId,
      context: node.context,
      state: normalizeCombinedState(node.state),
      createdAt: node.createdAt,
    });
  }
  const status = normalizeCheckRunStatus(node.status);
  if (status === "completed") {
    if (node.conclusion == null || node.completedAt == null) {
      throw createResponseValidationError(
        "Pull Request check run",
        "完了済みcheck runに結果または完了時刻がありません",
      );
    }
    return Object.freeze({
      type: "check_run",
      sourceId: buildProductionSourceId("github_check_run", nodeId),
      nodeId,
      name: node.name,
      status,
      conclusion: normalizeCheckRunConclusion(node.conclusion),
      completedAt: node.completedAt,
    });
  }
  if (node.conclusion != null || node.completedAt != null) {
    throw createResponseValidationError(
      "Pull Request check run",
      "未完了check runに結果または完了時刻があります",
    );
  }
  return Object.freeze({
    type: "check_run",
    sourceId: buildProductionSourceId("github_check_run", nodeId),
    nodeId,
    name: node.name,
    status,
    conclusion: "not_completed",
    completedAt: null,
  });
}

function normalizeMergeability(
  mergeability: RawProbeNode["mergeable"],
): GitHubPullRequestVolatileMergeState["mergeability"] {
  switch (mergeability) {
    case "CONFLICTING":
      return "conflicting";
    case "MERGEABLE":
      return "mergeable";
    case "UNKNOWN":
      return "unknown";
    default:
      throw createResponseValidationError("Pull Request mergeability", "未知のmergeabilityです");
  }
}

function normalizeMergeState(
  mergeState: RawProbeNode["mergeStateStatus"],
): GitHubPullRequestVolatileMergeState["mergeState"] {
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
      throw createResponseValidationError("Pull Request merge state", "未知のmerge stateです");
  }
}

function normalizeAutoMerge(
  pullRequestNodeId: GitHubNodeId,
  autoMergeRequest: RawProbeNode["autoMergeRequest"],
): GitHubVolatileAutoMerge {
  if (autoMergeRequest == null) {
    return Object.freeze({ status: "not_enabled" });
  }
  return Object.freeze({
    status: "enabled",
    sourceId: buildProductionSourceId("github_auto_merge_request", pullRequestNodeId),
    enabledAt: autoMergeRequest.enabledAt,
    enabledBy: normalizeActor(autoMergeRequest.enabledBy),
    mergeMethod:
      autoMergeRequest.mergeMethod === "MERGE"
        ? "merge"
        : autoMergeRequest.mergeMethod === "REBASE"
          ? "rebase"
          : "squash",
  });
}

function normalizeMergeQueue(
  mergeQueueEntry: RawProbeNode["mergeQueueEntry"],
): GitHubVolatileMergeQueue {
  if (mergeQueueEntry == null) {
    return Object.freeze({ status: "not_queued" });
  }
  const nodeId = createGitHubNodeId(mergeQueueEntry.id);
  return Object.freeze({
    status: "queued",
    sourceId: buildProductionSourceId("github_merge_queue_entry", nodeId),
    nodeId,
  });
}

function normalizeReviewRequests(
  nodes: readonly RawReviewRequestNode[],
): readonly GitHubVolatileReviewRequest[] {
  const requestNodeIds = nodes.map((node) => node.id);
  assertNoDuplicateNodeIds(requestNodeIds, "current review requests");
  const targetNodeIds = nodes.flatMap((node) =>
    node.requestedReviewer == null ? [] : [node.requestedReviewer.id],
  );
  assertNoDuplicateNodeIds(targetNodeIds, "current review request targets");
  return Object.freeze(nodes.map(normalizeReviewRequest));
}

function normalizeProbeResponseNodes(
  nodes: readonly (RawProbeNode | null)[],
  requestedNodeIds: readonly GitHubNodeId[],
): readonly RawProbeNode[] {
  if (nodes.length !== requestedNodeIds.length) {
    throw createResponseValidationError(
      "Pull Request volatile probe",
      "要求したnode IDと応答件数が一致しません",
    );
  }
  const normalizedNodes = nodes.map((node) => {
    if (node == null) {
      throw createResponseValidationError(
        "Pull Request volatile probe",
        "要求したnodeがありません",
      );
    }
    return node;
  });
  assertNoDuplicateNodeIds(
    normalizedNodes.map((node) => node.id),
    "Pull Request volatile probe",
  );
  const requestedSet = new Set(requestedNodeIds);
  for (const node of normalizedNodes) {
    if (!requestedSet.has(createGitHubNodeId(node.id))) {
      throw createResponseValidationError(
        "Pull Request volatile probe",
        "要求していないnode IDが応答に含まれています",
      );
    }
  }
  const responseSet = new Set(normalizedNodes.map((node) => createGitHubNodeId(node.id)));
  for (const requestedNodeId of requestedNodeIds) {
    if (!responseSet.has(requestedNodeId)) {
      throw createResponseValidationError(
        "Pull Request volatile probe",
        "要求したnode IDが応答にありません",
      );
    }
  }
  return Object.freeze(normalizedNodes);
}

function requireReviewRequestConnection(
  connection: z.output<typeof reviewRequestConnectionSchema> | null,
  context: string,
): z.output<typeof reviewRequestConnectionSchema> {
  return requireConnection(connection, context);
}

function createVolatilePageSnapshot(
  value: Readonly<{
    headRefOid: string;
    mergeable: RawProbeNode["mergeable"];
    mergeStateStatus: RawProbeNode["mergeStateStatus"];
    reviewDecision: RawProbeNode["reviewDecision"];
    autoMergeRequest: RawProbeNode["autoMergeRequest"];
    mergeQueueEntry: RawProbeNode["mergeQueueEntry"];
    statusCheckRollup:
      RawStatusCheckRollup | z.output<typeof statusCheckRollupIdentitySchema> | null;
  }>,
): string {
  const rollup = value.statusCheckRollup;
  return JSON.stringify({
    headRefOid: value.headRefOid,
    mergeable: value.mergeable,
    mergeStateStatus: value.mergeStateStatus,
    reviewDecision: value.reviewDecision,
    autoMergeRequest: value.autoMergeRequest,
    mergeQueueEntry: value.mergeQueueEntry,
    statusCheckRollup:
      rollup == null
        ? null
        : {
            id: rollup.id,
            state: rollup.state,
            commit: rollup.commit,
          },
  });
}

function assertReviewRequestPageSnapshot(
  initial: RawProbeNode,
  page: z.output<typeof reviewRequestPageResponseSchema>["pullRequest"] & object,
): void {
  if (
    createVolatilePageSnapshot(initial) !==
    createVolatilePageSnapshot({
      headRefOid: page.headRefOid,
      mergeable: page.mergeable,
      mergeStateStatus: page.mergeStateStatus,
      reviewDecision: page.reviewDecision,
      autoMergeRequest: page.autoMergeRequest,
      mergeQueueEntry: page.mergeQueueEntry,
      statusCheckRollup: page.statusCheckRollup,
    })
  ) {
    throw createRaceError(
      "review_request_page",
      createGitHubNodeId(initial.id),
      "Pull Requestのvolatile metadataが途中で変化しました",
    );
  }
}

function requirePageNode<Value extends { id: string }>(
  value: Value | null,
  expectedNodeId: GitHubNodeId,
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): Value {
  if (value == null) {
    throw createRaceError(kind, pullRequestNodeId, `${context}のnodeが途中で変化しました`);
  }
  if (value.id !== expectedNodeId) {
    throw createResponseValidationError(context, "要求したGraphQL node IDと応答が一致しません");
  }
  return value;
}

function requirePageConnection<Value>(
  connection: Value | null,
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): Value {
  if (connection == null) {
    throw createRaceError(kind, pullRequestNodeId, `${context}が途中でなくなりました`);
  }
  return connection;
}

function assertConnectionTotalCount(
  actual: number,
  expected: number,
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): void {
  if (actual !== expected) {
    throw createRaceError(kind, pullRequestNodeId, `${context}のtotalCountが途中で変化しました`);
  }
}

function assertInitialConnectionCount(
  actual: number,
  expected: number,
  hasNextPage: boolean,
  context: string,
): void {
  const isInvalid = hasNextPage ? actual === 0 || actual >= expected : actual !== expected;
  if (isInvalid) {
    throw createResponseValidationError(
      context,
      "初回connectionの取得件数とtotalCountが矛盾しています",
    );
  }
}

function assertConnectionCollectedCount(
  actual: number,
  expected: number,
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): void {
  if (actual !== expected) {
    throw createRaceError(
      kind,
      pullRequestNodeId,
      `${context}の取得件数がtotalCountと一致しません`,
    );
  }
}

function assertPaginatedNodeIds(
  collected: readonly { id: string }[],
  page: readonly { id: string }[],
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): void {
  const nodeIds = new Set(collected.map((node) => node.id));
  for (const node of page) {
    if (nodeIds.has(node.id)) {
      throw createRaceError(kind, pullRequestNodeId, `${context}のnodeがページ間で重複しました`);
    }
    nodeIds.add(node.id);
  }
}

function assertConnectionPageWithinTotalCount(
  actual: number,
  expected: number,
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): void {
  if (actual > expected) {
    throw createRaceError(kind, pullRequestNodeId, `${context}の取得件数がtotalCountを超えました`);
  }
}

function createCanonicalReviewRequestCollection(nodes: readonly RawReviewRequestNode[]): string {
  return JSON.stringify(
    nodes
      .map((node) => ({
        id: node.id,
        requestedReviewer:
          node.requestedReviewer == null
            ? null
            : {
                __typename: node.requestedReviewer.__typename,
                id: node.requestedReviewer.id,
              },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function createCanonicalCheckContextCollection(nodes: readonly RawCheckContext[]): string {
  return JSON.stringify(
    nodes
      .map((node) =>
        node.__typename === "CheckRun"
          ? {
              __typename: node.__typename,
              id: node.id,
              name: node.name,
              status: node.status,
              conclusion: node.conclusion,
              completedAt: node.completedAt,
            }
          : {
              __typename: node.__typename,
              id: node.id,
              context: node.context,
              state: node.state,
              createdAt: node.createdAt,
            },
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function assertCanonicalCollection(
  actual: string,
  expected: string,
  kind: GitHubPullRequestVolatileRaceKind,
  context: string,
  pullRequestNodeId: GitHubNodeId,
): void {
  if (actual !== expected) {
    throw createRaceError(kind, pullRequestNodeId, `${context}の取得結果が途中で変化しました`);
  }
}

function hasSameCheckRollupCommit(
  actual: RawStatusCheckRollup["commit"],
  expected: NonNullable<RawStatusCheckRollup["commit"]>,
  headSha: string,
): boolean {
  if (actual == null) {
    return false;
  }
  return actual.id === expected.id && actual.oid === expected.oid && actual.oid === headSha;
}

async function fetchReviewRequestConnectionPage(
  pullRequestNodeId: GitHubNodeId,
  initialNode: RawProbeNode,
  after: string | null,
  graphql: Graphql,
): Promise<RawReviewRequestConnection> {
  const response = await graphql(REVIEW_REQUEST_PAGE_QUERY, {
    pullRequestId: pullRequestNodeId,
    after,
  });
  const parsed = parseGraphqlResponse(
    reviewRequestPageResponseSchema,
    response,
    "current review request page",
  );
  const pullRequest = requirePageNode(
    parsed.pullRequest,
    pullRequestNodeId,
    "review_request_page",
    "current review request page",
    pullRequestNodeId,
  );
  assertReviewRequestPageSnapshot(initialNode, pullRequest);
  return requirePageConnection(
    pullRequest.reviewRequests,
    "review_request_page",
    "current review requests",
    pullRequestNodeId,
  );
}

async function collectReviewRequestConnectionPages(
  pullRequestNodeId: GitHubNodeId,
  initialNode: RawProbeNode,
  initialConnection: RawReviewRequestConnection,
  graphql: Graphql,
): Promise<readonly RawReviewRequestNode[]> {
  const nodes = [...initialConnection.nodes];
  assertInitialConnectionCount(
    nodes.length,
    initialConnection.totalCount,
    initialConnection.pageInfo.hasNextPage,
    "current review requests",
  );
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "current review requests",
  );
  const expectedTotalCount = initialConnection.totalCount;
  let pageInfo = initialConnection.pageInfo;
  const seenCursors = new Set<string>();
  for (;;) {
    const cursor = requireCursor(pageInfo, "current review requests");
    if (cursor == null) {
      break;
    }
    if (seenCursors.has(cursor)) {
      throw createResponseValidationError(
        "current review requests",
        "同じcursorが繰り返されています",
      );
    }
    seenCursors.add(cursor);
    const nextConnection = await fetchReviewRequestConnectionPage(
      pullRequestNodeId,
      initialNode,
      cursor,
      graphql,
    );
    assertConnectionTotalCount(
      nextConnection.totalCount,
      expectedTotalCount,
      "review_request_page",
      "current review requests",
      pullRequestNodeId,
    );
    if (nextConnection.nodes.length === 0) {
      throw createRaceError(
        "review_request_page",
        pullRequestNodeId,
        "次ページとして空のreviewRequests connectionを受け取りました",
      );
    }
    assertPaginatedNodeIds(
      nodes,
      nextConnection.nodes,
      "review_request_page",
      "current review requests",
      pullRequestNodeId,
    );
    assertConnectionPageWithinTotalCount(
      nodes.length + nextConnection.nodes.length,
      expectedTotalCount,
      "review_request_page",
      "current review requests",
      pullRequestNodeId,
    );
    nodes.push(...nextConnection.nodes);
    pageInfo = nextConnection.pageInfo;
  }
  assertConnectionCollectedCount(
    nodes.length,
    expectedTotalCount,
    "review_request_page",
    "current review requests",
    pullRequestNodeId,
  );
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "current review requests",
  );
  return Object.freeze(nodes);
}

async function collectReviewRequestNodes(
  pullRequestNodeId: GitHubNodeId,
  initialNode: RawProbeNode,
  initialConnection: RawReviewRequestConnection | null,
  graphql: Graphql,
): Promise<readonly RawReviewRequestNode[]> {
  const connection = requireReviewRequestConnection(initialConnection, "current review requests");
  const nodes = await collectReviewRequestConnectionPages(
    pullRequestNodeId,
    initialNode,
    connection,
    graphql,
  );
  if (connection.pageInfo.hasNextPage) {
    const canonicalConnection = await fetchReviewRequestConnectionPage(
      pullRequestNodeId,
      initialNode,
      null,
      graphql,
    );
    assertConnectionTotalCount(
      canonicalConnection.totalCount,
      connection.totalCount,
      "review_request_page",
      "current review requests",
      pullRequestNodeId,
    );
    const canonicalNodes = await collectReviewRequestConnectionPages(
      pullRequestNodeId,
      initialNode,
      canonicalConnection,
      graphql,
    );
    assertCanonicalCollection(
      createCanonicalReviewRequestCollection(canonicalNodes),
      createCanonicalReviewRequestCollection(nodes),
      "review_request_page",
      "current review requests",
      pullRequestNodeId,
    );
  }
  return nodes;
}

async function fetchCheckContextConnectionPage(
  pullRequestNodeId: GitHubNodeId,
  headSha: string,
  rollup: RawStatusCheckRollup,
  after: string | null,
  graphql: Graphql,
): Promise<RawCheckContextConnection> {
  if (rollup.commit == null) {
    throw createResponseValidationError(
      "Pull Request status check rollup",
      "status check rollupに対象commitがありません",
    );
  }
  const response = await graphql(CHECK_CONTEXT_PAGE_QUERY, {
    commitId: createGitHubNodeId(rollup.commit.id),
    after,
  });
  const parsed = parseGraphqlResponse(
    checkContextPageResponseSchema,
    response,
    "head commit check context page",
  );
  const commit = requirePageNode(
    parsed.commit,
    createGitHubNodeId(rollup.commit.id),
    "check_context_page",
    "head commit check context page",
    pullRequestNodeId,
  );
  if (commit.oid !== headSha) {
    throw createRaceError(
      "check_context_page",
      pullRequestNodeId,
      "head commitのSHAが途中で変化しました",
    );
  }
  const nextRollup = commit.statusCheckRollup;
  if (nextRollup == null) {
    throw createRaceError(
      "check_context_page",
      pullRequestNodeId,
      "status check rollupが途中でなくなりました",
    );
  }
  if (
    nextRollup.id !== rollup.id ||
    nextRollup.state !== rollup.state ||
    !hasSameCheckRollupCommit(nextRollup.commit, rollup.commit, headSha)
  ) {
    throw createRaceError(
      "check_context_page",
      pullRequestNodeId,
      "status check rollupが途中で変化しました",
    );
  }
  return nextRollup.contexts;
}

async function collectCheckContextConnectionPages(
  pullRequestNodeId: GitHubNodeId,
  headSha: string,
  rollup: RawStatusCheckRollup,
  initialConnection: RawCheckContextConnection,
  graphql: Graphql,
): Promise<readonly RawCheckContext[]> {
  const nodes = [...initialConnection.nodes];
  assertInitialConnectionCount(
    nodes.length,
    initialConnection.totalCount,
    initialConnection.pageInfo.hasNextPage,
    "head commit check contexts",
  );
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "head commit check contexts",
  );
  const expectedTotalCount = initialConnection.totalCount;
  let pageInfo = initialConnection.pageInfo;
  const seenCursors = new Set<string>();
  for (;;) {
    const cursor = requireCursor(pageInfo, "head commit check contexts");
    if (cursor == null) {
      break;
    }
    if (seenCursors.has(cursor)) {
      throw createResponseValidationError(
        "head commit check contexts",
        "同じcursorが繰り返されています",
      );
    }
    seenCursors.add(cursor);
    const nextConnection = await fetchCheckContextConnectionPage(
      pullRequestNodeId,
      headSha,
      rollup,
      cursor,
      graphql,
    );
    assertConnectionTotalCount(
      nextConnection.totalCount,
      expectedTotalCount,
      "check_context_page",
      "head commit check contexts",
      pullRequestNodeId,
    );
    if (nextConnection.nodes.length === 0) {
      throw createRaceError(
        "check_context_page",
        pullRequestNodeId,
        "次ページとして空のcheck contexts connectionを受け取りました",
      );
    }
    assertPaginatedNodeIds(
      nodes,
      nextConnection.nodes,
      "check_context_page",
      "head commit check contexts",
      pullRequestNodeId,
    );
    assertConnectionPageWithinTotalCount(
      nodes.length + nextConnection.nodes.length,
      expectedTotalCount,
      "check_context_page",
      "head commit check contexts",
      pullRequestNodeId,
    );
    nodes.push(...nextConnection.nodes);
    pageInfo = nextConnection.pageInfo;
  }
  assertConnectionCollectedCount(
    nodes.length,
    expectedTotalCount,
    "check_context_page",
    "head commit check contexts",
    pullRequestNodeId,
  );
  assertNoDuplicateNodeIds(
    nodes.map((node) => node.id),
    "head commit check contexts",
  );
  return Object.freeze(nodes);
}

async function collectCheckContextNodes(
  pullRequestNodeId: GitHubNodeId,
  headSha: string,
  rollup: RawStatusCheckRollup,
  graphql: Graphql,
): Promise<readonly RawCheckContext[]> {
  if (rollup.commit == null) {
    throw createResponseValidationError(
      "Pull Request status check rollup",
      "status check rollupに対象commitがありません",
    );
  }
  if (rollup.commit.oid !== headSha) {
    throw createResponseValidationError(
      "Pull Request status check rollup",
      "status check rollupのcommitとhead SHAが一致しません",
    );
  }
  const nodes = await collectCheckContextConnectionPages(
    pullRequestNodeId,
    headSha,
    rollup,
    rollup.contexts,
    graphql,
  );
  if (rollup.contexts.pageInfo.hasNextPage) {
    const canonicalConnection = await fetchCheckContextConnectionPage(
      pullRequestNodeId,
      headSha,
      rollup,
      null,
      graphql,
    );
    assertConnectionTotalCount(
      canonicalConnection.totalCount,
      rollup.contexts.totalCount,
      "check_context_page",
      "head commit check contexts",
      pullRequestNodeId,
    );
    const canonicalNodes = await collectCheckContextConnectionPages(
      pullRequestNodeId,
      headSha,
      rollup,
      canonicalConnection,
      graphql,
    );
    assertCanonicalCollection(
      createCanonicalCheckContextCollection(canonicalNodes),
      createCanonicalCheckContextCollection(nodes),
      "check_context_page",
      "head commit check contexts",
      pullRequestNodeId,
    );
  }
  return nodes;
}

async function collectCheckContextsWithPullRequestSnapshotValidation(
  pullRequestNodeId: GitHubNodeId,
  initialNode: RawProbeNode,
  rollup: RawStatusCheckRollup,
  reviewRequestNodes: readonly RawReviewRequestNode[],
  graphql: Graphql,
): Promise<readonly RawCheckContext[]> {
  const nodes = await collectCheckContextNodes(
    pullRequestNodeId,
    initialNode.headRefOid,
    rollup,
    graphql,
  );
  if (rollup.contexts.pageInfo.hasNextPage) {
    const currentReviewRequestConnection = await fetchReviewRequestConnectionPage(
      pullRequestNodeId,
      initialNode,
      null,
      graphql,
    );
    const currentReviewRequestNodes = await collectReviewRequestConnectionPages(
      pullRequestNodeId,
      initialNode,
      currentReviewRequestConnection,
      graphql,
    );
    assertCanonicalCollection(
      createCanonicalReviewRequestCollection(currentReviewRequestNodes),
      createCanonicalReviewRequestCollection(reviewRequestNodes),
      "review_request_page",
      "current review requests",
      pullRequestNodeId,
    );
  }
  return nodes;
}

async function normalizeNode(
  node: RawProbeNode,
  graphql: Graphql,
): Promise<GitHubPullRequestVolatileMetadata> {
  const nodeId = createGitHubNodeId(node.id);
  const reviewRequestNodes = await collectReviewRequestNodes(
    nodeId,
    node,
    node.reviewRequests,
    graphql,
  );
  const reviewRequests = normalizeReviewRequests(reviewRequestNodes);
  const checks =
    node.statusCheckRollup == null
      ? Object.freeze({ status: "not_configured" } satisfies GitHubHeadChecks)
      : Object.freeze({
          status: "configured",
          sourceId: buildProductionSourceId(
            "github_status_check_rollup",
            node.statusCheckRollup.id,
          ),
          nodeId: createGitHubNodeId(node.statusCheckRollup.id),
          combinedState: normalizeCombinedState(node.statusCheckRollup.state),
          contexts: Object.freeze(
            (
              await collectCheckContextsWithPullRequestSnapshotValidation(
                nodeId,
                node,
                node.statusCheckRollup,
                reviewRequestNodes,
                graphql,
              )
            ).map(normalizeCheckContext),
          ),
        } satisfies Extract<GitHubHeadChecks, { status: "configured" }>);
  return createGitHubPullRequestVolatileMetadata({
    nodeId,
    headSha: node.headRefOid,
    reviewDecision: normalizeReviewDecision(node.reviewDecision),
    reviewRequests,
    mergeState: {
      mergeability: normalizeMergeability(node.mergeable),
      mergeState: normalizeMergeState(node.mergeStateStatus),
      autoMerge: normalizeAutoMerge(nodeId, node.autoMergeRequest),
      mergeQueue: normalizeMergeQueue(node.mergeQueueEntry),
      checks,
    },
  });
}

/** Pull Request nodeを50件単位でprobeし、現在値を決定論的に正規化する。 */
export async function probeGitHubPullRequestVolatileMetadata(
  options: ProbeGitHubPullRequestVolatileMetadataOptions,
): Promise<GitHubPullRequestVolatileProbeCollection> {
  assertNoDuplicateNodeIds(options.pullRequestNodeIds, "Pull Request volatile probeの入力");
  const items: GitHubPullRequestVolatileMetadata[] = [];
  for (let offset = 0; offset < options.pullRequestNodeIds.length; offset += PROBE_BATCH_SIZE) {
    const batch = options.pullRequestNodeIds.slice(offset, offset + PROBE_BATCH_SIZE);
    const response = await options.graphql(PULL_REQUEST_VOLATILE_PROBE_QUERY, {
      ids: batch,
    });
    const parsed = parseGraphqlResponse(
      probeResponseSchema,
      response,
      "Pull Request volatile probe",
    );
    const nodes = normalizeProbeResponseNodes(parsed.nodes, batch);
    for (const node of nodes) {
      items.push(await normalizeNode(node, options.graphql));
    }
  }
  items.sort((left, right) =>
    left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0,
  );
  return Object.freeze({ items: Object.freeze(items) });
}

/** PR volatile probeを競合時だけ最大5回やり直し、detail照合も同じ試行へ含める。 */
export async function probeGitHubPullRequestVolatileMetadataWithRetry(
  options: ProbeGitHubPullRequestVolatileMetadataWithRetryOptions,
): Promise<GitHubPullRequestVolatileProbeCollection> {
  const races: GitHubPullRequestVolatileRaceError[] = [];
  for (let attempt = 0; attempt < MAX_VOLATILE_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const collection = await probeGitHubPullRequestVolatileMetadata(options);
      if (options.validateDetail != null) {
        await options.validateDetail(collection);
      }
      return collection;
    } catch (error: unknown) {
      if (!(error instanceof GitHubPullRequestVolatileRaceError)) {
        throw error;
      }
      races.push(error);
    }
    if (attempt + 1 < MAX_VOLATILE_PROBE_ATTEMPTS) {
      await options.runtime.sleep(calculateVolatileProbeRetryDelayMilliseconds(attempt));
    }
  }
  throw new GitHubPullRequestVolatileRaceRetryExhaustedError(races);
}

import { z } from "zod";

import {
  createGitHubNodeId,
  type GitHubNodeId,
  type ObservedGitHubCheckRunConclusion,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { GitHubResponseValidationError } from "./errors.js";
import { normalizeActor } from "./item-detail-accounts.js";
import {
  assertNoDuplicateNodeIds,
  parseGraphqlResponse,
  requireConnectionCursor,
  requireGraphqlNode,
} from "./item-detail-connection.js";
import {
  CHECK_CONTEXT_PAGE_QUERY,
  PULL_REQUEST_HEAD_COMMIT_QUERY,
} from "./item-detail-pagination-queries.js";
import type {
  autoMergeRequestSchema,
  basePullRequestSchema,
  checkRunSchema,
  Graphql,
  headCommitSchema,
  mergeQueueEntrySchema,
  RawCheckContext,
  statusCheckRollupSchema,
  statusContextSchema,
} from "./item-detail-response-schema.js";
import {
  checkContextPageResponseSchema,
  pullRequestHeadCommitResponseSchema,
} from "./item-detail-response-schema.js";
import {
  type GitHubAutoMerge,
  type GitHubCheckContext,
  type GitHubHeadChecks,
  type GitHubMergeQueue,
  type GitHubPullRequestMergeState,
} from "./item-detail-types.js";
import { buildProductionSourceId } from "./production-source-id.js";

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

export async function normalizePullRequestMergeState(
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

export async function resolvePullRequestHeadCommit(
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

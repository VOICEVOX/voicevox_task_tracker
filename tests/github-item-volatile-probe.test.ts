import { readFileSync } from "node:fs";

import { parse } from "graphql";
import { buildSchema, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
} from "../src/domain/index.js";
import { type GitHubClient } from "../src/github/client.js";
import {
  GitHubPullRequestVolatileRaceError,
  GitHubPullRequestVolatileRaceRetryExhaustedError,
  GitHubApiBudgetExceededError,
  GitHubAuthenticationError,
  GitHubRequestError,
  GitHubResponseValidationError,
  GitHubResponseSchemaValidationError,
} from "../src/github/errors.js";
import {
  type GitHubCheckContext,
  type GitHubCurrentReviewRequest,
  type GitHubItemDetail,
} from "../src/github/item-detail-types.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";
import { buildProductionSourceId } from "../src/github/production-source-id.js";
import {
  createGitHubPullRequestVolatileMetadata,
  createGitHubPullRequestVolatileMetadataFingerprint,
  createGitHubPullRequestVolatileMetadataFromDetail,
  validateGitHubPullRequestVolatileMetadata,
  type GitHubPullRequestReviewDecision,
  type GitHubPullRequestVolatileMetadataInput,
  type GitHubPullRequestVolatileMergeState,
  type GitHubVolatileReviewRequest,
} from "../src/github/item-volatile-metadata.js";
import {
  probeGitHubPullRequestVolatileMetadata,
  probeGitHubPullRequestVolatileMetadataWithRetry,
  type GitHubPullRequestVolatileProbeRuntime,
} from "../src/github/item-volatile-probe.js";

type Graphql = GitHubClient["graphql"];
type GraphqlCall = Readonly<{
  query: string;
  variables: Readonly<Record<string, unknown>>;
}>;

const observedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const repositoryId = createGitHubRepositoryId("R_example");
const allowlist = createPublicRepositoryAllowlist([
  {
    id: repositoryId,
    owner: "VOICEVOX",
    name: "example",
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt,
  },
]);
const githubSchema = buildSchema(
  readFileSync(new URL("../schemas/github-graphql.schema.graphql", import.meta.url), "utf8"),
  {
    assumeValid: true,
    assumeValidSDL: true,
  },
);

const volatileProbeRuntime = Object.freeze({
  sleep: (): Promise<void> => Promise.resolve(),
}) satisfies GitHubPullRequestVolatileProbeRuntime;

function operationName(query: string): string {
  const match = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(query);
  const operation = match?.[1];
  if (operation == null) {
    throw new Error("volatile probe queryのoperation名がありません");
  }
  return operation;
}

function createGraphql(
  resolver: (operation: string, variables: Readonly<Record<string, unknown>>) => unknown,
): Readonly<{
  graphql: Graphql;
  calls: GraphqlCall[];
}> {
  const calls: GraphqlCall[] = [];
  const graphql: Graphql = (query, variables) => {
    const document = parse(query);
    const errors = validate(githubSchema, document);
    if (errors.length > 0) {
      const firstError = errors[0];
      if (firstError == null) {
        throw new Error("volatile probe queryのschema検証結果が不正です");
      }
      throw new Error(`volatile probe queryが公式schemaに適合しません: ${firstError.message}`);
    }
    calls.push({ query, variables });
    const response = resolver(operationName(query), variables);
    if (typeof response !== "object" || response == null || Array.isArray(response)) {
      throw new Error("volatile probe test responseがobjectではありません");
    }
    return Promise.resolve(z.record(z.string(), z.unknown()).parse(response));
  };
  return { graphql, calls };
}

function getNodeIds(variables: Readonly<Record<string, unknown>>): readonly string[] {
  const value = variables["ids"];
  const result = z.array(z.string()).safeParse(value);
  if (!result.success) {
    throw new Error("volatile probeのidsが不正です");
  }
  return result.data;
}

function createReviewRequest(index: number, targetIndex: number): Record<string, unknown> {
  return {
    id: `RR_${index.toString()}`,
    requestedReviewer: {
      __typename: "User",
      id: `U_reviewer_${targetIndex.toString()}`,
    },
  };
}

function createCheckRun(
  index: number,
  status: "COMPLETED" | "IN_PROGRESS",
): Record<string, unknown> {
  return {
    __typename: "CheckRun",
    id: `CR_${index.toString()}`,
    name: `check-${index.toString()}`,
    status,
    conclusion: status === "COMPLETED" ? "SUCCESS" : null,
    completedAt: status === "COMPLETED" ? "2026-07-31T00:00:00Z" : null,
  };
}

function createProbeNode(
  nodeId: string,
  options: Readonly<{
    reviewRequests?: readonly Record<string, unknown>[];
    reviewRequestsPageInfo?: Readonly<{ hasNextPage: boolean; endCursor: string | null }>;
    reviewRequestsTotalCount?: number;
    checkContexts?: readonly Record<string, unknown>[];
    checkContextsPageInfo?: Readonly<{ hasNextPage: boolean; endCursor: string | null }>;
    checkContextsTotalCount?: number;
    statusCheckRollup?: Record<string, unknown> | null;
    headSha?: string;
    mergeable?: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
    mergeStateStatus?:
      "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
    reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  }>,
): Record<string, unknown> {
  const reviewRequests = options.reviewRequests ?? [];
  const checkContexts = options.checkContexts ?? [];
  const headSha = options.headSha ?? `head-${nodeId}`;
  const statusCheckRollup =
    "statusCheckRollup" in options
      ? options.statusCheckRollup
      : "checkContexts" in options || "checkContextsPageInfo" in options
        ? {
            id: `SCR_${nodeId}`,
            state: "SUCCESS",
            commit: {
              id: `C_${nodeId}`,
              oid: headSha,
            },
            contexts: {
              nodes: checkContexts,
              pageInfo: options.checkContextsPageInfo ?? {
                hasNextPage: false,
                endCursor: null,
              },
              totalCount: options.checkContextsTotalCount ?? checkContexts.length,
            },
          }
        : null;
  return {
    __typename: "PullRequest",
    id: nodeId,
    headRefOid: headSha,
    mergeable: options.mergeable ?? "MERGEABLE",
    mergeStateStatus: options.mergeStateStatus ?? "CLEAN",
    reviewDecision: options.reviewDecision ?? null,
    autoMergeRequest: null,
    mergeQueueEntry: null,
    reviewRequests: {
      nodes: reviewRequests,
      pageInfo: options.reviewRequestsPageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      },
      totalCount: options.reviewRequestsTotalCount ?? reviewRequests.length,
    },
    statusCheckRollup,
  };
}

function createProbeResponse(nodes: readonly Record<string, unknown>[]): unknown {
  return { nodes };
}

function createReviewRequestPageResponse(
  nodeId: string,
  nodes: readonly Record<string, unknown>[],
  pageInfo: Readonly<{ hasNextPage: boolean; endCursor: string | null }>,
  totalCount: number,
): Readonly<{ pullRequest: Record<string, unknown> }> {
  return {
    pullRequest: {
      __typename: "PullRequest",
      id: nodeId,
      headRefOid: `head-${nodeId}`,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      autoMergeRequest: null,
      mergeQueueEntry: null,
      statusCheckRollup: null,
      reviewRequests: {
        nodes,
        pageInfo,
        totalCount,
      },
    },
  };
}

function createCheckContextPageResponse(
  nodeId: string,
  nodes: readonly Record<string, unknown>[],
  pageInfo: Readonly<{ hasNextPage: boolean; endCursor: string | null }>,
  totalCount: number,
): Readonly<{ commit: Record<string, unknown> }> {
  return {
    commit: {
      __typename: "Commit",
      id: `C_${nodeId}`,
      oid: `head-${nodeId}`,
      statusCheckRollup: {
        id: `SCR_${nodeId}`,
        state: "SUCCESS",
        commit: {
          id: `C_${nodeId}`,
          oid: `head-${nodeId}`,
        },
        contexts: {
          nodes,
          pageInfo,
          totalCount,
        },
      },
    },
  };
}

async function runCheckPaginationSnapshotRace(
  change: "reviewDecision" | "mergeStateStatus" | "reviewRequests",
): Promise<{
  result: Awaited<ReturnType<typeof probeGitHubPullRequestVolatileMetadataWithRetry>>;
  initialProbeCount: number;
  callCount: number;
}> {
  let initialProbeCount = 0;
  const nodeId = "PR_check_snapshot_race";
  const initialContexts = Array.from({ length: 100 }, (_, index) =>
    createCheckRun(index, "COMPLETED"),
  );
  const request = createReviewRequest(1, 1);
  const mock = createGraphql((operation, variables) => {
    if (operation === "GitHubPullRequestVolatileProbe") {
      initialProbeCount += 1;
      const requestedNodeId = getNodeIds(variables)[0];
      if (requestedNodeId == null) {
        throw new Error("probe node IDがありません");
      }
      if (initialProbeCount > 1) {
        return createProbeResponse([createProbeNode(requestedNodeId, {})]);
      }
      if (change === "reviewDecision") {
        return createProbeResponse([
          createProbeNode(requestedNodeId, {
            reviewRequests: [request],
            checkContexts: initialContexts,
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 101,
            reviewDecision: "APPROVED",
          }),
        ]);
      }
      if (change === "reviewRequests") {
        return createProbeResponse([
          createProbeNode(requestedNodeId, {
            reviewRequests: [request],
            checkContexts: initialContexts,
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 101,
          }),
        ]);
      }
      return createProbeResponse([
        createProbeNode(requestedNodeId, {
          reviewRequests: [request],
          checkContexts: initialContexts,
          checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
          checkContextsTotalCount: 101,
          mergeStateStatus: "CLEAN",
        }),
      ]);
    }
    if (operation === "GitHubPullRequestVolatileCheckContextPage") {
      const after = variables["after"];
      return createCheckContextPageResponse(
        nodeId,
        after == null ? initialContexts : [createCheckRun(100, "COMPLETED")],
        after == null
          ? { hasNextPage: true, endCursor: "check-cursor" }
          : { hasNextPage: false, endCursor: null },
        101,
      );
    }
    if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
      if (change === "reviewRequests") {
        const response = createReviewRequestPageResponse(
          nodeId,
          [request, createReviewRequest(2, 2)],
          { hasNextPage: false, endCursor: null },
          2,
        );
        return response;
      }
      const response = createReviewRequestPageResponse(
        nodeId,
        [request],
        { hasNextPage: false, endCursor: null },
        1,
      );
      return {
        pullRequest: {
          ...response.pullRequest,
          ...(change === "reviewDecision"
            ? { reviewDecision: "CHANGES_REQUESTED" }
            : { mergeStateStatus: "BLOCKED" }),
        },
      };
    }
    throw new Error(`予期しないqueryです。対象: ${operation}`);
  });
  const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
    pullRequestNodeIds: [createGitHubNodeId(nodeId)],
    graphql: mock.graphql,
    runtime: volatileProbeRuntime,
  });
  return { result, initialProbeCount, callCount: mock.calls.length };
}

async function runReviewRequestPaginationRace(anomaly: "empty" | "duplicate"): Promise<{
  result: Awaited<ReturnType<typeof probeGitHubPullRequestVolatileMetadataWithRetry>>;
  initialProbeCount: number;
  callCount: number;
}> {
  let initialProbeCount = 0;
  const nodeId = "PR_pagination_race_review";
  const initialRequests = Array.from({ length: 100 }, (_, index) =>
    createReviewRequest(index, index),
  );
  const mock = createGraphql((operation, variables) => {
    if (operation === "GitHubPullRequestVolatileProbe") {
      initialProbeCount += 1;
      const requestedNodeId = getNodeIds(variables)[0];
      if (requestedNodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse(
        initialProbeCount === 1
          ? [
              createProbeNode(requestedNodeId, {
                reviewRequests: initialRequests,
                reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
                reviewRequestsTotalCount: 101,
              }),
            ]
          : [createProbeNode(requestedNodeId, {})],
      );
    }
    if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
      const nodes = anomaly === "empty" ? [] : [createReviewRequest(99, 99)];
      return createReviewRequestPageResponse(
        nodeId,
        nodes,
        { hasNextPage: false, endCursor: null },
        101,
      );
    }
    throw new Error(`予期しないqueryです。対象: ${operation}`);
  });
  const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
    pullRequestNodeIds: [createGitHubNodeId(nodeId)],
    graphql: mock.graphql,
    runtime: volatileProbeRuntime,
  });
  return { result, initialProbeCount, callCount: mock.calls.length };
}

async function runCheckContextPaginationRace(anomaly: "empty" | "duplicate"): Promise<{
  result: Awaited<ReturnType<typeof probeGitHubPullRequestVolatileMetadataWithRetry>>;
  initialProbeCount: number;
  callCount: number;
}> {
  let initialProbeCount = 0;
  const nodeId = "PR_pagination_race_check";
  const initialContexts = Array.from({ length: 100 }, (_, index) =>
    createCheckRun(index, "COMPLETED"),
  );
  const mock = createGraphql((operation, variables) => {
    if (operation === "GitHubPullRequestVolatileProbe") {
      initialProbeCount += 1;
      const requestedNodeId = getNodeIds(variables)[0];
      if (requestedNodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse(
        initialProbeCount === 1
          ? [
              createProbeNode(requestedNodeId, {
                checkContexts: initialContexts,
                checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
                checkContextsTotalCount: 101,
              }),
            ]
          : [createProbeNode(requestedNodeId, {})],
      );
    }
    if (operation === "GitHubPullRequestVolatileCheckContextPage") {
      const nodes = anomaly === "empty" ? [] : [createCheckRun(99, "COMPLETED")];
      return createCheckContextPageResponse(
        nodeId,
        nodes,
        { hasNextPage: false, endCursor: null },
        101,
      );
    }
    throw new Error(`予期しないqueryです。対象: ${operation}`);
  });
  const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
    pullRequestNodeIds: [createGitHubNodeId(nodeId)],
    graphql: mock.graphql,
    runtime: volatileProbeRuntime,
  });
  return { result, initialProbeCount, callCount: mock.calls.length };
}

function createChecks(): GitHubPullRequestVolatileMergeState["checks"] {
  const nodeId = createGitHubNodeId("CR_detail");
  const context = {
    type: "check_run",
    sourceId: buildProductionSourceId("github_check_run", nodeId),
    nodeId,
    name: "check-detail",
    status: "completed",
    conclusion: "success",
    completedAt: createUtcIsoDateTime("2026-07-31T00:00:00Z"),
  } satisfies Extract<GitHubCheckContext, { type: "check_run" }>;
  return {
    status: "configured",
    sourceId: buildProductionSourceId("github_status_check_rollup", "SCR_detail"),
    nodeId: createGitHubNodeId("SCR_detail"),
    combinedState: "success",
    contexts: [context],
  };
}

function createMetadataInput(
  overrides: Readonly<{
    headSha?: string;
    reviewDecision?: GitHubPullRequestReviewDecision;
  }>,
): GitHubPullRequestVolatileMetadataInput {
  const reviewerNodeId = createGitHubNodeId("U_reviewer");
  const request = {
    requestNodeId: createGitHubNodeId("RR_detail"),
    target: {
      status: "identified",
      kind: "actor",
      nodeId: reviewerNodeId,
      apiType: "User",
    },
  } satisfies GitHubVolatileReviewRequest;
  return {
    nodeId: createGitHubNodeId("PR_detail"),
    headSha: overrides.headSha ?? "head-detail",
    reviewDecision: overrides.reviewDecision ?? "approved",
    reviewRequests: [request],
    mergeState: {
      mergeability: "mergeable",
      mergeState: "clean",
      autoMerge: { status: "not_enabled" },
      mergeQueue: { status: "not_queued" },
      checks: createChecks(),
    },
  };
}

function createDetail(): Extract<GitHubItemDetail, { type: "pull_request" }> {
  const nodeId = createGitHubNodeId("PR_detail");
  const reviewerNodeId = createGitHubNodeId("U_reviewer");
  const request = {
    sourceId: buildProductionSourceId("github_review_request", "RR_detail"),
    nodeId: createGitHubNodeId("RR_detail"),
    target: {
      type: "user",
      sourceId: buildProductionSourceId("github_actor", reviewerNodeId),
      nodeId: reviewerNodeId,
      login: "reviewer",
      apiType: "User",
    },
    requestedAt: {
      status: "unavailable",
      reason: "timeline_event_not_found",
    },
  } satisfies GitHubCurrentReviewRequest;
  const checks = createChecks();
  const repository = allowlist.repositories[0];
  if (repository == null) {
    throw new Error("volatile probe test用repositoryがありません");
  }
  return {
    sourceId: buildProductionSourceId("github_item_detail", nodeId),
    nodeId,
    repositoryId: repository.id,
    number: 1,
    type: "pull_request",
    reviewDecision: "approved",
    bodySourceId: buildProductionSourceId("github_item_body", nodeId),
    body: "本文",
    lastEditedAt: null,
    bodyUserContentEdits: {
      availability: "available",
      edits: [],
    },
    comments: [],
    timeline: [],
    inboundCrossReferences: [],
    observedAt,
    reviews: [],
    reviewThreads: [],
    reviewRequests: {
      current: [request],
      history: [],
    },
    nativeClosingIssues: [],
    headSha: "head-detail",
    headCommit: {
      sourceId: buildProductionSourceId("github_commit", "C_detail"),
      nodeId: createGitHubNodeId("C_detail"),
      sha: "head-detail",
      committedAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
      pushedAt: {
        status: "available",
        value: createUtcIsoDateTime("2026-07-30T01:00:00Z"),
      },
    },
    mergeState: {
      mergeability: "mergeable",
      mergeState: "clean",
      autoMerge: {
        status: "not_enabled",
      },
      mergeQueue: {
        status: "not_queued",
      },
      checks,
    },
  };
}

describe("Pull Request volatile metadata", () => {
  it("空入力ではGraphQLを呼ばず空の結果を返す", async () => {
    const mock = createGraphql(() => {
      throw new Error("空入力でGraphQLが呼ばれました");
    });

    const result = await probeGitHubPullRequestVolatileMetadata({
      pullRequestNodeIds: [],
      graphql: mock.graphql,
    });

    expect(result).toEqual({ items: [] });
    expect(mock.calls).toHaveLength(0);
  });

  it("50件単位でbatch取得し、応答順に依存せず正規化する", async () => {
    const nodeIds = Array.from({ length: 51 }, (_, index) =>
      createGitHubNodeId(`PR_${index.toString()}`),
    );
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`初回probe以外のqueryです。対象: ${operation}`);
      }
      const ids = getNodeIds(variables);
      return createProbeResponse(
        [...ids]
          .reverse()
          .map((nodeId) => createProbeNode(nodeId, { reviewDecision: "REVIEW_REQUIRED" })),
      );
    });

    const result = await probeGitHubPullRequestVolatileMetadata({
      pullRequestNodeIds: nodeIds,
      graphql: mock.graphql,
    });

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.variables["ids"]).toHaveLength(50);
    expect(mock.calls[1]?.variables["ids"]).toHaveLength(1);
    expect(result.items.map((item) => item.nodeId)).toEqual(
      [...nodeIds].sort((left, right) => left.localeCompare(right)),
    );
    expect(JSON.stringify(result)).not.toContain("本文");
    expect(JSON.stringify(result)).not.toContain("comment");
    expect(JSON.stringify(result)).not.toContain("diff");
  });

  it("statusCheckRollupがnullならcheckなしとして受理する", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      return createProbeResponse(
        getNodeIds(variables).map((nodeId) => createProbeNode(nodeId, {})),
      );
    });

    const result = await probeGitHubPullRequestVolatileMetadata({
      pullRequestNodeIds: [createGitHubNodeId("PR_no_checks")],
      graphql: mock.graphql,
    });

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
  });

  it("review requestとcheck contextの応答順をfingerprintへ持ち込まない", async () => {
    const reviewRequests = [createReviewRequest(1, 1), createReviewRequest(2, 2)];
    const checkContexts = [createCheckRun(1, "COMPLETED"), createCheckRun(2, "COMPLETED")];
    const collect = async (reverse: boolean): Promise<string> => {
      const mock = createGraphql((operation, variables) => {
        if (operation !== "GitHubPullRequestVolatileProbe") {
          throw new Error(`予期しないqueryです。対象: ${operation}`);
        }
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            reviewRequests: reverse ? [...reviewRequests].reverse() : reviewRequests,
            checkContexts: reverse ? [...checkContexts].reverse() : checkContexts,
          }),
        ]);
      });
      const result = await probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_order")],
        graphql: mock.graphql,
      });
      const item = result.items[0];
      if (item == null) {
        throw new Error("volatile probe itemがありません");
      }
      return item.currentMetadataFingerprint;
    };

    const forwardFingerprint = await collect(false);
    const reverseFingerprint = await collect(true);
    expect(reverseFingerprint).toBe(forwardFingerprint);
  });

  it("review requestとcheck contextを次ページまで取得する", async () => {
    const reviewRequests = Array.from({ length: 100 }, (_, index) =>
      createReviewRequest(index, index),
    );
    const checkContexts = Array.from({ length: 100 }, (_, index) =>
      createCheckRun(index, "COMPLETED"),
    );
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            reviewRequests,
            reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
            reviewRequestsTotalCount: 101,
            checkContexts,
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 101,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        const isCanonicalFirstPage = variables["after"] == null;
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_paged",
            headRefOid: "head-PR_paged",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: {
              id: "SCR_PR_paged",
              state: "SUCCESS",
              commit: {
                id: "C_PR_paged",
                oid: "head-PR_paged",
              },
            },
            reviewRequests: {
              nodes: isCanonicalFirstPage ? reviewRequests : [createReviewRequest(100, 100)],
              pageInfo: isCanonicalFirstPage
                ? { hasNextPage: true, endCursor: "review-cursor" }
                : { hasNextPage: false, endCursor: null },
              totalCount: 101,
            },
          },
        };
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        const isCanonicalFirstPage = variables["after"] == null;
        return {
          commit: {
            __typename: "Commit",
            id: "C_PR_paged",
            oid: "head-PR_paged",
            statusCheckRollup: {
              id: "SCR_PR_paged",
              state: "SUCCESS",
              commit: {
                id: "C_PR_paged",
                oid: "head-PR_paged",
              },
              contexts: {
                nodes: isCanonicalFirstPage ? checkContexts : [createCheckRun(100, "COMPLETED")],
                pageInfo: isCanonicalFirstPage
                  ? { hasNextPage: true, endCursor: "check-cursor" }
                  : { hasNextPage: false, endCursor: null },
                totalCount: 101,
              },
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    const result = await probeGitHubPullRequestVolatileMetadata({
      pullRequestNodeIds: [createGitHubNodeId("PR_paged")],
      graphql: mock.graphql,
    });

    expect(result.items[0]?.reviewRequests).toHaveLength(101);
    const checks = result.items[0]?.mergeState.checks;
    if (checks?.status !== "configured") {
      throw new Error("check contextsがconfiguredではありません");
    }
    expect(checks.contexts.some((context) => context.nodeId === createGitHubNodeId("CR_100"))).toBe(
      true,
    );
  });

  it("review requestの同件数置換を検出して次の試行で回復する", async () => {
    let initialProbeCount = 0;
    const initialRequests = Array.from({ length: 100 }, (_, index) =>
      createReviewRequest(index, index),
    );
    const replacementRequests = [
      ...Array.from({ length: 99 }, (_, index) => createReviewRequest(index, index)),
      createReviewRequest(999, 999),
    ];
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse(
          initialProbeCount === 1
            ? [
                createProbeNode(nodeId, {
                  reviewRequests: initialRequests,
                  reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
                  reviewRequestsTotalCount: 101,
                }),
              ]
            : [createProbeNode(nodeId, {})],
        );
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        const after = variables["after"];
        const nodes = after == null ? replacementRequests : [createReviewRequest(100, 100)];
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_same_count_review",
            headRefOid: "head-PR_same_count_review",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: null,
            reviewRequests: {
              nodes,
              pageInfo:
                after == null
                  ? { hasNextPage: true, endCursor: "review-cursor" }
                  : { hasNextPage: false, endCursor: null },
              totalCount: 101,
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
      pullRequestNodeIds: [createGitHubNodeId("PR_same_count_review")],
      graphql: mock.graphql,
      runtime: volatileProbeRuntime,
    });

    expect(result.items[0]?.reviewRequests).toEqual([]);
    expect(initialProbeCount).toBe(2);
    expect(mock.calls).toHaveLength(5);
  });

  it("review requestのtotalCount変化を競合として次の試行へ渡す", async () => {
    let initialProbeCount = 0;
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse(
          initialProbeCount === 1
            ? [
                createProbeNode(nodeId, {
                  reviewRequests: Array.from({ length: 100 }, (_, index) =>
                    createReviewRequest(index, index),
                  ),
                  reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
                  reviewRequestsTotalCount: 101,
                }),
              ]
            : [createProbeNode(nodeId, {})],
        );
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_total_count_review",
            headRefOid: "head-PR_total_count_review",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: null,
            reviewRequests: {
              nodes: [createReviewRequest(100, 100)],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 102,
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
      pullRequestNodeIds: [createGitHubNodeId("PR_total_count_review")],
      graphql: mock.graphql,
      runtime: volatileProbeRuntime,
    });

    expect(result.items[0]?.reviewRequests).toEqual([]);
    expect(initialProbeCount).toBe(2);
    expect(mock.calls).toHaveLength(3);
  });

  it("check contextの同件数置換を検出して次の試行で回復する", async () => {
    let initialProbeCount = 0;
    const initialContexts = Array.from({ length: 100 }, (_, index) =>
      createCheckRun(index, "COMPLETED"),
    );
    const replacementContexts = [
      ...Array.from({ length: 99 }, (_, index) => createCheckRun(index, "COMPLETED")),
      createCheckRun(999, "COMPLETED"),
    ];
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse(
          initialProbeCount === 1
            ? [
                createProbeNode(nodeId, {
                  checkContexts: initialContexts,
                  checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
                  checkContextsTotalCount: 101,
                }),
              ]
            : [createProbeNode(nodeId, {})],
        );
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        const after = variables["after"];
        const contexts = after == null ? replacementContexts : [createCheckRun(100, "COMPLETED")];
        return {
          commit: {
            __typename: "Commit",
            id: "C_PR_same_count_check",
            oid: "head-PR_same_count_check",
            statusCheckRollup: {
              id: "SCR_PR_same_count_check",
              state: "SUCCESS",
              commit: {
                id: "C_PR_same_count_check",
                oid: "head-PR_same_count_check",
              },
              contexts: {
                nodes: contexts,
                pageInfo:
                  after == null
                    ? { hasNextPage: true, endCursor: "check-cursor" }
                    : { hasNextPage: false, endCursor: null },
                totalCount: 101,
              },
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
      pullRequestNodeIds: [createGitHubNodeId("PR_same_count_check")],
      graphql: mock.graphql,
      runtime: volatileProbeRuntime,
    });

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
    expect(initialProbeCount).toBe(2);
    expect(mock.calls).toHaveLength(5);
  });

  it("review requestの空の次ページを競合として再取得で回復する", async () => {
    const { result, initialProbeCount, callCount } = await runReviewRequestPaginationRace("empty");

    expect(result.items[0]?.reviewRequests).toEqual([]);
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(3);
  });

  it("review requestの次ページ重複nodeを競合として再取得で回復する", async () => {
    const { result, initialProbeCount, callCount } =
      await runReviewRequestPaginationRace("duplicate");

    expect(result.items[0]?.reviewRequests).toEqual([]);
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(3);
  });

  it("check contextの空の次ページを競合として再取得で回復する", async () => {
    const { result, initialProbeCount, callCount } = await runCheckContextPaginationRace("empty");

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(3);
  });

  it("check contextの次ページ重複nodeを競合として再取得で回復する", async () => {
    const { result, initialProbeCount, callCount } =
      await runCheckContextPaginationRace("duplicate");

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(3);
  });

  it("review requestのcanonical node ID不一致は再試行しない", async () => {
    let initialProbeCount = 0;
    const nodeId = "PR_canonical_review_identity";
    const initialRequests = Array.from({ length: 100 }, (_, index) =>
      createReviewRequest(index, index),
    );
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const requestedNodeId = getNodeIds(variables)[0];
        if (requestedNodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(requestedNodeId, {
            reviewRequests: initialRequests,
            reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
            reviewRequestsTotalCount: 101,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        const after = variables["after"];
        const response = createReviewRequestPageResponse(
          nodeId,
          after == null ? initialRequests : [createReviewRequest(100, 100)],
          after == null
            ? { hasNextPage: true, endCursor: "review-cursor" }
            : { hasNextPage: false, endCursor: null },
          101,
        );
        return after == null
          ? { pullRequest: { ...response.pullRequest, id: "PR_canonical_review_other" } }
          : response;
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    let thrown: unknown;
    try {
      await probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId(nodeId)],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubResponseValidationError);
    expect(thrown).not.toBeInstanceOf(GitHubPullRequestVolatileRaceError);
    expect(initialProbeCount).toBe(1);
    expect(mock.calls).toHaveLength(3);
  });

  it("check contextのcanonical commit node ID不一致は再試行しない", async () => {
    let initialProbeCount = 0;
    const nodeId = "PR_canonical_check_identity";
    const initialContexts = Array.from({ length: 100 }, (_, index) =>
      createCheckRun(index, "COMPLETED"),
    );
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const requestedNodeId = getNodeIds(variables)[0];
        if (requestedNodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(requestedNodeId, {
            checkContexts: initialContexts,
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 101,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        const after = variables["after"];
        const response = createCheckContextPageResponse(
          nodeId,
          after == null ? initialContexts : [createCheckRun(100, "COMPLETED")],
          after == null
            ? { hasNextPage: true, endCursor: "check-cursor" }
            : { hasNextPage: false, endCursor: null },
          101,
        );
        return after == null
          ? { commit: { ...response.commit, id: "C_canonical_other" } }
          : response;
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    let thrown: unknown;
    try {
      await probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId(nodeId)],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubResponseValidationError);
    expect(thrown).not.toBeInstanceOf(GitHubPullRequestVolatileRaceError);
    expect(initialProbeCount).toBe(1);
    expect(mock.calls).toHaveLength(3);
  });

  it("check pagination完了後のreview decision変更を競合として再取得する", async () => {
    const { result, initialProbeCount, callCount } =
      await runCheckPaginationSnapshotRace("reviewDecision");

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(6);
  });

  it("check pagination完了後のmerge state変更を競合として再取得する", async () => {
    const { result, initialProbeCount, callCount } =
      await runCheckPaginationSnapshotRace("mergeStateStatus");

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(6);
  });

  it("check pagination完了後のreview request変更を競合として再取得する", async () => {
    const { result, initialProbeCount, callCount } =
      await runCheckPaginationSnapshotRace("reviewRequests");

    expect(result.items[0]?.mergeState.checks).toEqual({ status: "not_configured" });
    expect(initialProbeCount).toBe(2);
    expect(callCount).toBe(6);
  });

  it("初回review requestが空でhasNextPageならvalidationとして再試行しない", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
          reviewRequestsTotalCount: 1,
        }),
      ]);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_initial_empty_review")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      }),
    ).rejects.toBeInstanceOf(GitHubResponseValidationError);
    expect(mock.calls).toHaveLength(1);
  });

  it("初回check contextが空でhasNextPageならvalidationとして再試行しない", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
          checkContextsTotalCount: 1,
        }),
      ]);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_initial_empty_check")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      }),
    ).rejects.toBeInstanceOf(GitHubResponseValidationError);
    expect(mock.calls).toHaveLength(1);
  });

  it("初回review request connection内の重複nodeはvalidationとして再試行しない", async () => {
    const request = createReviewRequest(1, 1);
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          reviewRequests: [request, request],
          reviewRequestsTotalCount: 2,
        }),
      ]);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_initial_duplicate_review")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      }),
    ).rejects.toBeInstanceOf(GitHubResponseValidationError);
    expect(mock.calls).toHaveLength(1);
  });

  it("初回check context connection内の重複nodeはvalidationとして再試行しない", async () => {
    const context = createCheckRun(1, "COMPLETED");
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          checkContexts: [context, context],
          checkContextsTotalCount: 2,
        }),
      ]);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_initial_duplicate_check")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      }),
    ).rejects.toBeInstanceOf(GitHubResponseValidationError);
    expect(mock.calls).toHaveLength(1);
  });

  it("継続check contextのtotalCount変更は競合として扱う", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            checkContexts: [createCheckRun(1, "COMPLETED")],
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 2,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        return createCheckContextPageResponse(
          "PR_continuation_total_count",
          [createCheckRun(2, "COMPLETED")],
          { hasNextPage: false, endCursor: null },
          3,
        );
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_continuation_total_count")],
        graphql: mock.graphql,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubPullRequestVolatileRaceError,
      kind: "check_context_page",
      nodeId: createGitHubNodeId("PR_continuation_total_count"),
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("継続review request取得件数の上限超過は競合として停止する", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            reviewRequests: [createReviewRequest(1, 1)],
            reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
            reviewRequestsTotalCount: 2,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        return createReviewRequestPageResponse(
          "PR_continuation_review_overflow",
          [createReviewRequest(2, 2), createReviewRequest(3, 3)],
          { hasNextPage: false, endCursor: null },
          2,
        );
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_continuation_review_overflow")],
        graphql: mock.graphql,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubPullRequestVolatileRaceError,
      kind: "review_request_page",
      nodeId: createGitHubNodeId("PR_continuation_review_overflow"),
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("継続check context取得件数の上限超過は競合として停止する", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            checkContexts: [createCheckRun(1, "COMPLETED")],
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 2,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        return createCheckContextPageResponse(
          "PR_continuation_check_overflow",
          [createCheckRun(2, "COMPLETED"), createCheckRun(3, "COMPLETED")],
          { hasNextPage: false, endCursor: null },
          2,
        );
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_continuation_check_overflow")],
        graphql: mock.graphql,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubPullRequestVolatileRaceError,
      kind: "check_context_page",
      nodeId: createGitHubNodeId("PR_continuation_check_overflow"),
    });
    expect(mock.calls).toHaveLength(2);
  });

  it("review request pagination中のvolatile scalar変更を拒否する", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            reviewRequests: Array.from({ length: 100 }, (_, index) =>
              createReviewRequest(index, index),
            ),
            reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
            reviewRequestsTotalCount: 101,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_race",
            headRefOid: "changed-head",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: null,
            reviewRequests: {
              nodes: [createReviewRequest(100, 100)],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 101,
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_race")],
        graphql: mock.graphql,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubPullRequestVolatileRaceError,
      kind: "review_request_page",
      nodeId: createGitHubNodeId("PR_race"),
    });
  });

  it("raceだけをprobe全体の再取得で回復する", async () => {
    let initialProbeCount = 0;
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        if (initialProbeCount === 1) {
          return createProbeResponse([
            createProbeNode(nodeId, {
              reviewRequests: Array.from({ length: 100 }, (_, index) =>
                createReviewRequest(index, index),
              ),
              reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
              reviewRequestsTotalCount: 101,
            }),
          ]);
        }
        return createProbeResponse([createProbeNode(nodeId, {})]);
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_retry",
            headRefOid: "changed-head",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: null,
            reviewRequests: {
              nodes: [createReviewRequest(100, 100)],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 101,
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
      pullRequestNodeIds: [createGitHubNodeId("PR_retry")],
      graphql: mock.graphql,
      runtime: volatileProbeRuntime,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.reviewRequests).toEqual([]);
    expect(initialProbeCount).toBe(2);
    expect(mock.calls).toHaveLength(3);
  });

  it("schema不正は再取得せずそのまま失敗する", async () => {
    const mock = createGraphql(() => ({ nodes: [{}] }));

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_schema_error")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      }),
    ).rejects.toBeInstanceOf(GitHubResponseSchemaValidationError);
    expect(mock.calls).toHaveLength(1);
  });

  it("初回review requestのtotalCount矛盾は再試行しない", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          reviewRequests: [createReviewRequest(1, 1)],
          reviewRequestsTotalCount: 0,
        }),
      ]);
    });

    let thrown: unknown;
    try {
      await probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_initial_total_count")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubResponseValidationError);
    expect(thrown).not.toBeInstanceOf(GitHubPullRequestVolatileRaceError);
    expect(mock.calls).toHaveLength(1);
  });

  it("初回check contextのtotalCount矛盾は再試行しない", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          checkContexts: [createCheckRun(1, "COMPLETED")],
          checkContextsTotalCount: 0,
        }),
      ]);
    });

    let thrown: unknown;
    try {
      await probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_initial_check_total_count")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubResponseValidationError);
    expect(thrown).not.toBeInstanceOf(GitHubPullRequestVolatileRaceError);
    expect(mock.calls).toHaveLength(1);
  });

  it("認証、予算、通常APIエラーは再取得しない", async () => {
    const delays: number[] = [];
    const errors = [
      new GitHubAuthenticationError("probe test", { cause: new TypeError("認証失敗") }),
      new GitHubApiBudgetExceededError({
        source: "graphql",
        limit: 100,
        remaining: 0,
        resetAt: "2026-08-01T00:00:00Z",
        observedAt: "2026-08-01T00:00:00Z",
        cost: 1,
      }),
      new GitHubRequestError(500, 1, { cause: new TypeError("API失敗") }),
    ];

    for (const error of errors) {
      const mock = createGraphql(() => {
        throw error;
      });
      await expect(
        probeGitHubPullRequestVolatileMetadataWithRetry({
          pullRequestNodeIds: [createGitHubNodeId("PR_non_race_error")],
          graphql: mock.graphql,
          runtime: {
            sleep: (delayMilliseconds: number): Promise<void> => {
              delays.push(delayMilliseconds);
              return Promise.resolve();
            },
          },
        }),
      ).rejects.toBe(error);
      expect(mock.calls).toHaveLength(1);
    }
    expect(delays).toEqual([]);
  });

  it("競合が5回続いた場合はbackoff後も部分結果を返さず専用エラーにする", async () => {
    const delays: number[] = [];
    const runtime = Object.freeze({
      sleep: (delayMilliseconds: number): Promise<void> => {
        delays.push(delayMilliseconds);
        return Promise.resolve();
      },
    }) satisfies GitHubPullRequestVolatileProbeRuntime;
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            reviewRequests: Array.from({ length: 100 }, (_, index) =>
              createReviewRequest(index, index),
            ),
            reviewRequestsPageInfo: { hasNextPage: true, endCursor: "review-cursor" },
            reviewRequestsTotalCount: 101,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_retry_exhausted",
            headRefOid: "changed-head",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: null,
            reviewRequests: {
              nodes: [createReviewRequest(100, 100)],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 101,
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_retry_exhausted")],
        graphql: mock.graphql,
        runtime,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubPullRequestVolatileRaceRetryExhaustedError,
      attempts: 5,
      races: [
        { kind: "review_request_page" },
        { kind: "review_request_page" },
        { kind: "review_request_page" },
        { kind: "review_request_page" },
        { kind: "review_request_page" },
      ],
    });
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(mock.calls).toHaveLength(10);
  });

  it("detail照合の競合もprobe全体の再取得で回復する", async () => {
    const delays: number[] = [];
    const runtime = Object.freeze({
      sleep: (delayMilliseconds: number): Promise<void> => {
        delays.push(delayMilliseconds);
        return Promise.resolve();
      },
    }) satisfies GitHubPullRequestVolatileProbeRuntime;
    let detailValidationCount = 0;
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([createProbeNode(nodeId, {})]);
    });

    const result = await probeGitHubPullRequestVolatileMetadataWithRetry({
      pullRequestNodeIds: [createGitHubNodeId("PR_detail_retry")],
      graphql: mock.graphql,
      runtime,
      validateDetail: () => {
        detailValidationCount += 1;
        if (detailValidationCount === 1) {
          throw new GitHubPullRequestVolatileRaceError(
            "detail",
            createGitHubNodeId("PR_detail_retry"),
            { cause: new TypeError("detailが変化しました") },
          );
        }
      },
    });

    expect(result.items).toHaveLength(1);
    expect(detailValidationCount).toBe(2);
    expect(delays).toEqual([2_000]);
    expect(mock.calls).toHaveLength(2);
  });

  it("sleepの失敗は競合として再試行せずそのまま伝播する", async () => {
    const sleepError = new TypeError("sleepに失敗しました");
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`予期しないqueryです。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([createProbeNode(nodeId, {})]);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_sleep_error")],
        graphql: mock.graphql,
        runtime: {
          sleep: () => Promise.reject(sleepError),
        },
        validateDetail: () => {
          throw new GitHubPullRequestVolatileRaceError(
            "detail",
            createGitHubNodeId("PR_sleep_error"),
            { cause: new TypeError("detailが変化しました") },
          );
        },
      }),
    ).rejects.toBe(sleepError);
    expect(mock.calls).toHaveLength(1);
  });

  it("最終ページのendCursorを受理し、追加queryを行わない", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation !== "GitHubPullRequestVolatileProbe") {
        throw new Error(`最終ページで追加queryが呼ばれました。対象: ${operation}`);
      }
      const nodeId = getNodeIds(variables)[0];
      if (nodeId == null) {
        throw new Error("probe node IDがありません");
      }
      return createProbeResponse([
        createProbeNode(nodeId, {
          reviewRequestsPageInfo: { hasNextPage: false, endCursor: "terminal-cursor" },
        }),
      ]);
    });

    const result = await probeGitHubPullRequestVolatileMetadata({
      pullRequestNodeIds: [createGitHubNodeId("PR_terminal")],
      graphql: mock.graphql,
    });

    expect(result.items).toHaveLength(1);
    expect(mock.calls).toHaveLength(1);
  });

  it.each([
    "missing cursor",
    "empty next page",
    "repeated cursor",
    "duplicate node",
    "missing requested node",
    "wrong node type",
    "connection null",
  ])("異常なprobe応答を拒否する %s", async (caseName) => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        if (caseName === "missing requested node") {
          return { nodes: [null] };
        }
        if (caseName === "wrong node type") {
          return {
            nodes: [
              {
                __typename: "Issue",
                id: nodeId,
              },
            ],
          };
        }
        if (caseName === "duplicate node") {
          const node = createProbeNode(nodeId, {});
          return { nodes: [node, node] };
        }
        if (caseName === "connection null") {
          return {
            nodes: [
              {
                ...createProbeNode(nodeId, {}),
                reviewRequests: null,
              },
            ],
          };
        }
        return {
          nodes: [
            createProbeNode(nodeId, {
              reviewRequestsPageInfo:
                caseName === "missing cursor"
                  ? { hasNextPage: true, endCursor: null }
                  : { hasNextPage: true, endCursor: "review-cursor" },
            }),
          ],
        };
      }
      if (operation === "GitHubPullRequestVolatileReviewRequestPage") {
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_invalid",
            headRefOid: "head-PR_invalid",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            autoMergeRequest: null,
            mergeQueueEntry: null,
            statusCheckRollup: null,
            reviewRequests: {
              nodes: caseName === "empty next page" ? [] : [createReviewRequest(1, 1)],
              pageInfo:
                caseName === "repeated cursor"
                  ? { hasNextPage: true, endCursor: "review-cursor" }
                  : { hasNextPage: false, endCursor: null },
              totalCount: caseName === "empty next page" ? 0 : 1,
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    const requestedNodeIds =
      caseName === "duplicate node"
        ? [createGitHubNodeId("PR_invalid"), createGitHubNodeId("PR_invalid_2")]
        : [createGitHubNodeId("PR_invalid")];
    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: requestedNodeIds,
        graphql: mock.graphql,
      }),
    ).rejects.toThrow();
  });

  it("check context paginationのcursor反復を拒否する", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            checkContexts: [createCheckRun(1, "COMPLETED")],
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 2,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        return {
          commit: {
            __typename: "Commit",
            id: "C_PR_check_invalid",
            oid: "head-PR_check_invalid",
            statusCheckRollup: {
              id: "SCR_PR_check_invalid",
              state: "SUCCESS",
              commit: {
                id: "C_PR_check_invalid",
                oid: "head-PR_check_invalid",
              },
              contexts: {
                nodes: [createCheckRun(2, "COMPLETED")],
                pageInfo: { hasNextPage: true, endCursor: "check-cursor" },
                totalCount: 2,
              },
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_check_invalid")],
        graphql: mock.graphql,
      }),
    ).rejects.toThrow();
  });

  it("check context pagination中のrollup state変更を拒否する", async () => {
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            checkContexts: [createCheckRun(1, "COMPLETED")],
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 2,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        return {
          commit: {
            __typename: "Commit",
            id: "C_PR_check_race",
            oid: "head-PR_check_race",
            statusCheckRollup: {
              id: "SCR_PR_check_race",
              state: "FAILURE",
              commit: {
                id: "C_PR_check_race",
                oid: "head-PR_check_race",
              },
              contexts: {
                nodes: [createCheckRun(2, "COMPLETED")],
                pageInfo: { hasNextPage: false, endCursor: null },
                totalCount: 2,
              },
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadata({
        pullRequestNodeIds: [createGitHubNodeId("PR_check_race")],
        graphql: mock.graphql,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubPullRequestVolatileRaceError,
      kind: "check_context_page",
      nodeId: createGitHubNodeId("PR_check_race"),
    });
  });

  it("check context pagination中のrollup commit identity変更を拒否する", async () => {
    let initialProbeCount = 0;
    const mock = createGraphql((operation, variables) => {
      if (operation === "GitHubPullRequestVolatileProbe") {
        initialProbeCount += 1;
        const nodeId = getNodeIds(variables)[0];
        if (nodeId == null) {
          throw new Error("probe node IDがありません");
        }
        return createProbeResponse([
          createProbeNode(nodeId, {
            checkContexts: [createCheckRun(1, "COMPLETED")],
            checkContextsPageInfo: { hasNextPage: true, endCursor: "check-cursor" },
            checkContextsTotalCount: 2,
          }),
        ]);
      }
      if (operation === "GitHubPullRequestVolatileCheckContextPage") {
        return {
          commit: {
            __typename: "Commit",
            id: "C_changed",
            oid: "head-PR_check_identity",
            statusCheckRollup: {
              id: "SCR_PR_check_identity",
              state: "SUCCESS",
              commit: {
                id: "C_changed",
                oid: "head-PR_check_identity",
              },
              contexts: {
                nodes: [createCheckRun(2, "COMPLETED")],
                pageInfo: { hasNextPage: false, endCursor: null },
                totalCount: 2,
              },
            },
          },
        };
      }
      throw new Error(`予期しないqueryです。対象: ${operation}`);
    });

    await expect(
      probeGitHubPullRequestVolatileMetadataWithRetry({
        pullRequestNodeIds: [createGitHubNodeId("PR_check_identity")],
        graphql: mock.graphql,
        runtime: volatileProbeRuntime,
      }),
    ).rejects.toMatchObject({
      constructor: GitHubResponseValidationError,
    });
    expect(initialProbeCount).toBe(1);
    expect(mock.calls).toHaveLength(2);
  });

  it("volatile current値とfull detailから同じfingerprintを生成する", () => {
    const input = createMetadataInput({});
    const expected = createGitHubPullRequestVolatileMetadata(input);
    const fromDetail = createGitHubPullRequestVolatileMetadataFromDetail(createDetail());

    expect(fromDetail.currentMetadataFingerprint).toBe(expected.currentMetadataFingerprint);
    expect(createGitHubPullRequestVolatileMetadataFingerprint(input)).toBe(
      expected.currentMetadataFingerprint,
    );
  });

  it("full detailとのvolatile metadata不一致を拒否する", () => {
    const expected = createGitHubPullRequestVolatileMetadata(createMetadataInput({}));
    expect(validateGitHubPullRequestVolatileMetadata(expected, createDetail())).toEqual(expected);
    const changed = createGitHubPullRequestVolatileMetadata(
      createMetadataInput({ headSha: "different-head" }),
    );
    let thrown: unknown;
    try {
      validateGitHubPullRequestVolatileMetadata(changed, createDetail());
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GitHubPullRequestVolatileRaceError);
    if (!(thrown instanceof GitHubPullRequestVolatileRaceError)) {
      throw new Error("detail照合race errorがありません");
    }
    expect(thrown.kind).toBe("detail");
    expect(thrown.cause).toBeInstanceOf(TypeError);
  });

  it("head SHAとreview decisionの変更をfingerprintへ反映する", () => {
    const base = createGitHubPullRequestVolatileMetadata(createMetadataInput({}));
    const changedHead = createGitHubPullRequestVolatileMetadata(
      createMetadataInput({ headSha: "head-changed" }),
    );
    const changedDecision = createGitHubPullRequestVolatileMetadata(
      createMetadataInput({ reviewDecision: "changes_requested" }),
    );

    expect(changedHead.currentMetadataFingerprint).not.toBe(base.currentMetadataFingerprint);
    expect(changedDecision.currentMetadataFingerprint).not.toBe(base.currentMetadataFingerprint);
  });
});

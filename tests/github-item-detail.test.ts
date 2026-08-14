import { generateKeyPairSync } from "node:crypto";

import { z } from "zod";
import { parse } from "graphql";
import { describe, expect, it, vi } from "vitest";

import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type Repository,
} from "../src/domain/index.js";
import {
  collectGitHubItemDetails,
  createGitHubBodyFingerprint,
  createGitHubClient,
  createPublicRepositoryAllowlist,
  GITHUB_APP_READ_PERMISSIONS,
  GitHubItemDetailCollectionError,
  GitHubResponseSchemaValidationError,
  GitHubResponseValidationError,
  normalizeGitHubEvents,
  normalizeObservedGitHubItem,
  type CreateGitHubClientOptions,
  type EnumeratedGitHubItem,
  type GitHubClient,
  type GitHubItemDetail,
  type GitHubRetryRuntime,
  type PublicRepositoryAllowlist,
} from "../src/github/index.js";
import { createItemDetailQuery } from "../src/github/item-detail-queries.js";

type Graphql = GitHubClient["graphql"];
type GraphqlRequest = Readonly<{
  operation: string;
  query: string;
  variables: Readonly<Record<string, unknown>>;
}>;
type GraphqlResolver = (operation: string, variables: Readonly<Record<string, unknown>>) => unknown;
type HttpRequest = Readonly<{
  method: string;
  path: string;
  body: string | undefined;
}>;

const observedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const displayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);
const graphqlResponseSchema = z.record(z.string(), z.unknown());
const graphqlHttpPayloadSchema = z.object({
  query: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).optional(),
});
const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKey = keyPair.privateKey
  .export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();
const operations = {
  githubApiBudgetRatio: 0.7,
  retry: {
    maxAttempts: 2,
    initialDelaySeconds: 1,
    maxDelaySeconds: 2,
  },
} satisfies CreateGitHubClientOptions["operations"];

function createAllowlist(): PublicRepositoryAllowlist {
  const repository = {
    id: createGitHubRepositoryId("R_example"),
    owner: "VOICEVOX",
    name: "example",
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt,
  } satisfies Repository;
  return createPublicRepositoryAllowlist([repository]);
}

function createItem(
  allowlist: PublicRepositoryAllowlist,
  nodeIdValue: string,
  number: number,
  type: "issue" | "pull_request",
): EnumeratedGitHubItem {
  const repository = allowlist.repositories[0];
  if (repository == null) {
    throw new Error("公開repository fixtureがありません");
  }
  const nodeId = createGitHubNodeId(nodeIdValue);
  const bodyFingerprint = createGitHubBodyFingerprint("列挙時本文");
  const url: GitHubItemUrl =
    type === "issue"
      ? `https://github.com/VOICEVOX/example/issues/${number.toString()}`
      : `https://github.com/VOICEVOX/example/pull/${number.toString()}`;
  const common = {
    nodeId,
    repositoryId: repository.id,
    displayReference: displayReferenceSchema.parse(`VOICEVOX/example#${number.toString()}`),
    number,
    url,
    title: `項目${number.toString()}`,
    bodyFingerprint,
    bodyLocator: {
      kind: "github_item_body",
      repositoryId: repository.id,
      itemNodeId: nodeId,
      number,
    },
    author: {
      kind: "account",
      account: {
        nodeId: createGitHubNodeId("U_author"),
        login: "author",
        apiType: "User",
      },
    },
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00Z"),
    updatedAt: createUtcIsoDateTime("2026-07-31T23:00:00Z"),
    state: "open",
    stateReason: null,
    closedAt: null,
    assignees: [],
    labels: [],
    milestone: null,
    itemFingerprint: bodyFingerprint,
    observedAt,
  } satisfies Omit<EnumeratedGitHubItem, "type" | "draft" | "mergeStatus" | "mergedAt">;
  if (type === "issue") {
    return {
      ...common,
      type,
      draft: "not_applicable",
    };
  }
  return {
    ...common,
    type,
    draft: false,
    mergeStatus: "not_merged",
  };
}

function getOperationName(query: string): string {
  const match = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(query);
  const operation = match?.[1];
  if (operation == null) {
    throw new Error("GraphQL HTTP mockがquery operation名を取得できません");
  }
  return operation;
}

function getFragmentDefinitionNames(query: string): readonly string[] {
  return parse(query)
    .definitions.flatMap((definition) =>
      definition.kind === "FragmentDefinition" ? [definition.name.value] : [],
    )
    .sort();
}

function getRequestQuery(requests: readonly GraphqlRequest[], index: number): string {
  const request = requests[index];
  if (request == null) {
    throw new Error(`GraphQL request fixtureがありません。index: ${index.toString()}`);
  }
  return request.query;
}

function createGraphqlHttpMock(resolver: GraphqlResolver): Readonly<{
  graphql: Graphql;
  requests: GraphqlRequest[];
}> {
  const requests: GraphqlRequest[] = [];
  const graphql: Graphql = async (query, variables) => {
    await Promise.resolve();
    parse(query);
    const operation = getOperationName(query);
    requests.push({
      operation,
      query,
      variables,
    });
    const response = resolver(operation, variables);
    if (typeof response !== "object" || response == null || Array.isArray(response)) {
      throw new Error(`GraphQL HTTP mock responseがobjectではありません。対象: ${operation}`);
    }
    return graphqlResponseSchema.parse(response);
  };
  return {
    graphql,
    requests,
  };
}

function createJsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function createAuthenticatedGraphqlHttpMock(resolver: GraphqlResolver): Promise<
  Readonly<{
    client: GitHubClient;
    requests: HttpRequest[];
  }>
> {
  const requests: HttpRequest[] = [];
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      method,
      path: url.pathname,
      body,
    });
    if (url.pathname === "/app/installations/123/access_tokens") {
      return createJsonResponse(
        {
          token: "ghs_item_detail_http_mock",
          expires_at: "2026-08-01T02:00:00Z",
          permissions: GITHUB_APP_READ_PERMISSIONS,
          repository_selection: "all",
        },
        201,
      );
    }
    if (url.pathname !== "/graphql" || body == null) {
      throw new Error(`未定義のHTTP requestです。対象: ${method} ${url.pathname}`);
    }
    const parsedJson: unknown = JSON.parse(body);
    const payload = graphqlHttpPayloadSchema.parse(parsedJson);
    const operation = getOperationName(payload.query);
    const variables = payload.variables ?? Object.freeze({});
    const response = graphqlResponseSchema.parse(resolver(operation, variables));
    return createJsonResponse(
      {
        data: {
          ...response,
          voicevoxTaskTrackerRateLimit: {
            cost: 1,
            limit: 5000,
            remaining: 4999,
            resetAt: "2026-08-01T02:00:00Z",
          },
        },
      },
      200,
    );
  };
  const runtime = {
    sleep: (): Promise<void> => Promise.resolve(),
    random: (): number => 0,
    now: (): Date => new Date("2026-08-01T00:00:00Z"),
  } satisfies GitHubRetryRuntime;
  const client = await createGitHubClient({
    organization: "VOICEVOX",
    credentials: {
      appId: 1,
      privateKey,
      installationId: 123,
    },
    operations,
    baseUrl: "https://api.github.test",
    fetch: fetchImplementation,
    runtime,
  });
  return {
    client,
    requests,
  };
}

function getStringVariable(variables: Readonly<Record<string, unknown>>, name: string): string {
  const value = variables[name];
  if (typeof value !== "string") {
    throw new Error(`GraphQL variableが文字列ではありません。対象: ${name}`);
  }
  return value;
}

function createCapabilitiesResponse(availability: "available" | "unavailable"): unknown {
  const nativeFields =
    availability === "available" ? ["blockedBy", "blocking", "parent", "subIssues"] : [];
  return {
    issueType: {
      fields: [
        {
          name: "id",
        },
        ...nativeFields.map((name) => ({
          name,
        })),
      ],
    },
  };
}

function createPageInfo(
  hasNextPage: boolean,
  endCursor: string | null,
): Readonly<{
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  return {
    hasNextPage,
    endCursor,
  };
}

function createActor(index: number): Readonly<{
  __typename: "User";
  id: string;
  login: string;
}> {
  return {
    __typename: "User",
    id: `U_actor_${index.toString()}`,
    login: `actor-${index.toString()}`,
  };
}

function createBotActor(index: number): Readonly<{
  __typename: "Bot";
  id: string;
  login: string;
}> {
  return {
    __typename: "Bot",
    id: `B_actor_${index.toString()}`,
    login: `bot-${index.toString()}`,
  };
}

function createComment(index: number): unknown {
  return {
    id: `IC_comment_${index.toString()}`,
    author: createActor(index),
    body: `コメント${index.toString()}`,
    createdAt: `2026-07-31T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
      index % 60,
    ).padStart(2, "0")}:00Z`,
    lastEditedAt: null,
    updatedAt: `2026-07-31T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
      index % 60,
    ).padStart(2, "0")}:00Z`,
    userContentEdits: null,
    url: `https://github.com/VOICEVOX/example/issues/1#issuecomment-${index.toString()}`,
  };
}

function createUserContentEdit(index: number): unknown {
  const minute = (index % 60).toString().padStart(2, "0");
  return {
    id: `UCE_edit_${index.toString()}`,
    createdAt: `2026-07-30T00:${minute}:00Z`,
    deletedAt: null,
    diff: `+変更${index.toString()}`,
    editedAt: `2026-07-30T00:${minute}:00Z`,
    editor: createActor(index),
    updatedAt: `2026-07-30T00:${minute}:00Z`,
  };
}

function createReferencedIssue(
  nodeId: string,
  number: number,
  issueState: "OPEN" | "CLOSED",
): unknown {
  return {
    __typename: "Issue",
    id: nodeId,
    number,
    url: `https://github.com/VOICEVOX/example/issues/${number.toString()}`,
    createdAt: "2026-07-01T00:00:00Z",
    issueState,
    repository: {
      id: "R_example",
      name: "example",
      visibility: "PUBLIC",
      isArchived: false,
      isDisabled: false,
      owner: {
        login: "VOICEVOX",
      },
    },
  };
}

function createEmptyConnection(): Readonly<{
  nodes: readonly [];
  pageInfo: Readonly<{
    hasNextPage: false;
    endCursor: null;
  }>;
}> {
  return {
    nodes: [],
    pageInfo: {
      hasNextPage: false,
      endCursor: null,
    },
  };
}

function requireDetail(details: readonly GitHubItemDetail[], index: number): GitHubItemDetail {
  const detail = details[index];
  if (detail == null) {
    throw new Error(`detail fixtureがありません。index: ${index.toString()}`);
  }
  return detail;
}

describe("Issue詳細収集", () => {
  it("Zod検証失敗の先頭10件から安全な診断情報だけを保持する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_invalid_response", 1, "issue");
    const actualValueCanary = "item-detail-actual-value-canary";
    const mock = createGraphqlHttpMock((operation) => {
      if (operation !== "GitHubItemDetailCapabilities") {
        throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
      }
      return {
        issueType: {
          fields: Array.from({ length: 12 }, (_, index) => ({
            name: {
              actual: `${actualValueCanary}-${index.toString()}`,
            },
          })),
        },
      };
    });

    try {
      await collectGitHubItemDetails({
        allowlist,
        targets: [
          {
            item,
          },
        ],
        observedAt,
        graphql: mock.graphql,
      });
      throw new Error("GitHubResponseSchemaValidationErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubResponseSchemaValidationError)) {
        throw error;
      }
      expect(error.issueCount).toBe(12);
      expect(error.omittedIssueCount).toBe(2);
      expect(error.issues).toHaveLength(10);
      expect(error.issues[0]).toEqual({
        path: ["issueType", "fields", 0, "name"],
        code: "invalid_type",
        expected: "string",
      });
      expect(error.issues[9]).toEqual({
        path: ["issueType", "fields", 9, "name"],
        code: "invalid_type",
        expected: "string",
      });
      const diagnosticText = JSON.stringify({
        message: error.message,
        cause: error.cause instanceof Error ? error.cause.message : error.cause,
        issueCount: error.issueCount,
        issues: error.issues,
        omittedIssueCount: error.omittedIssueCount,
      });
      expect(diagnosticText).not.toContain(actualValueCanary);
      expect(diagnosticText).not.toContain("input");
      expect(diagnosticText).not.toContain("received");
    }
  });

  it("項目詳細の収集中に発生した例外を項目参照付きの型付きエラーで包む", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_collection_failure", 42, "issue");
    const cause = new Error("項目詳細取得エラー");
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        throw cause;
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    try {
      await collectGitHubItemDetails({
        allowlist,
        targets: [
          {
            item,
          },
        ],
        observedAt,
        graphql: mock.graphql,
      });
      throw new Error("GitHubItemDetailCollectionErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubItemDetailCollectionError)) {
        throw error;
      }
      expect(error).toMatchObject({
        repositoryOwner: "VOICEVOX",
        repositoryName: "example",
        number: 42,
      });
      expect(error.cause).toBe(cause);
    }
  });

  it("既に項目詳細収集エラーで包まれた例外を二重に包まない", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_wrapped_collection_failure", 43, "issue");
    const wrappedError = new GitHubItemDetailCollectionError("VOICEVOX", "example", 43, {
      cause: new Error("項目詳細取得エラー"),
    });
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        throw wrappedError;
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    await expect(
      collectGitHubItemDetails({
        allowlist,
        targets: [
          {
            item,
          },
        ],
        observedAt,
        graphql: mock.graphql,
      }),
    ).rejects.toBe(wrappedError);
  });

  it("同じ詳細収集の全項目でtimelineを全履歴取得する", async () => {
    const allowlist = createAllowlist();
    const firstItem = createItem(allowlist, "I_first", 1, "issue");
    const secondItem = createItem(allowlist, "I_second", 2, "issue");
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        const itemNodeId = getStringVariable(variables, "itemId");
        return {
          item: {
            __typename: "Issue",
            id: itemNodeId,
            body: "本文",
            lastEditedAt: null,
            userContentEdits: null,
            comments: createEmptyConnection(),
            timelineItems: createEmptyConnection(),
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item: firstItem,
        },
        {
          item: secondItem,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });
    const detailRequests = mock.requests.filter(
      (request) => request.operation === "GitHubItemDetail",
    );
    const firstRequest = detailRequests.find(
      (request) => request.variables["itemId"] === firstItem.nodeId,
    );
    const secondRequest = detailRequests.find(
      (request) => request.variables["itemId"] === secondItem.nodeId,
    );
    if (firstRequest == null || secondRequest == null) {
      throw new Error("全履歴timelineのGraphQL requestが不足しています");
    }

    expect(collection.items.map((item) => item.nodeId)).toEqual([
      firstItem.nodeId,
      secondItem.nodeId,
    ]);
    expect(firstRequest.variables).not.toHaveProperty("since");
    expect(firstRequest.query).not.toContain("$since");
    expect(secondRequest.variables).not.toHaveProperty("since");
    expect(secondRequest.query).not.toContain("$since");
  });

  it("100件を超えるコメントの順序とIDを保持し、native関係とinbound sourceを返す", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_target", 1, "issue");
    const comments = Array.from({ length: 105 }, (_, index) => createComment(index + 1));
    const timelineNodes = [
      {
        __typename: "AssignedEvent",
        id: "AE_assigned",
        createdAt: "2026-07-31T01:00:00Z",
        actor: createActor(1),
        assignee: {
          __typename: "User",
          id: "U_assignee",
          login: "assignee",
        },
      },
      {
        __typename: "UnassignedEvent",
        id: "UE_unassigned",
        createdAt: "2026-07-31T02:00:00Z",
        actor: createActor(2),
        assignee: {
          __typename: "User",
          id: "U_assignee",
          login: "assignee",
        },
      },
      {
        __typename: "BlockedByAddedEvent",
        id: "BBAE_added",
        createdAt: "2026-07-31T02:30:00Z",
        actor: createActor(2),
        blockingIssue: createReferencedIssue("I_blocker_event", 101, "OPEN"),
      },
      {
        __typename: "BlockedByRemovedEvent",
        id: "BBRE_removed",
        createdAt: "2026-07-31T02:40:00Z",
        actor: createActor(3),
        blockingIssue: createReferencedIssue("I_blocker_event", 101, "OPEN"),
      },
      {
        __typename: "BlockingAddedEvent",
        id: "BAE_added",
        createdAt: "2026-07-31T02:50:00Z",
        actor: createActor(4),
        blockedIssue: createReferencedIssue("I_blocked_event", 102, "OPEN"),
      },
      {
        __typename: "BlockingRemovedEvent",
        id: "BRE_removed",
        createdAt: "2026-07-31T02:55:00Z",
        actor: createActor(5),
        blockedIssue: createReferencedIssue("I_blocked_event", 102, "OPEN"),
      },
      {
        __typename: "LabeledEvent",
        id: "LE_labeled",
        createdAt: "2026-07-31T03:00:00Z",
        actor: createBotActor(3),
        label: {
          id: "LA_bug",
          name: "bug",
        },
      },
      {
        __typename: "UnlabeledEvent",
        id: "ULE_unlabeled",
        createdAt: "2026-07-31T04:00:00Z",
        actor: createActor(4),
        label: {
          id: "LA_bug",
          name: "bug",
        },
      },
      {
        __typename: "ClosedEvent",
        id: "CLE_closed",
        createdAt: "2026-07-31T04:30:00Z",
        actor: createActor(4),
      },
      {
        __typename: "CrossReferencedEvent",
        id: "CRE_inbound",
        createdAt: "2026-07-31T05:00:00Z",
        actor: createActor(5),
        source: createReferencedIssue("I_source", 99, "OPEN"),
        willCloseTarget: true,
      },
      {
        __typename: "ConnectedEvent",
        id: "CE_connected",
        createdAt: "2026-07-31T06:00:00Z",
        actor: createActor(6),
        subject: createReferencedIssue("I_connected", 100, "OPEN"),
      },
      {
        __typename: "DisconnectedEvent",
        id: "DE_disconnected",
        createdAt: "2026-07-31T07:00:00Z",
        actor: createActor(7),
        subject: createReferencedIssue("I_connected", 100, "OPEN"),
      },
      {
        __typename: "SubIssueAddedEvent",
        id: "SIAE_added",
        createdAt: "2026-07-31T08:00:00Z",
        actor: createActor(8),
        subIssue: createReferencedIssue("I_child", 5, "CLOSED"),
      },
      {
        __typename: "SubIssueRemovedEvent",
        id: "SIRE_removed",
        createdAt: "2026-07-31T09:00:00Z",
        actor: createActor(9),
        subIssue: createReferencedIssue("I_old_child", 6, "CLOSED"),
      },
      {
        __typename: "ParentIssueAddedEvent",
        id: "PIAE_added",
        createdAt: "2026-07-31T10:00:00Z",
        actor: createActor(10),
        parent: createReferencedIssue("I_parent", 4, "OPEN"),
      },
      {
        __typename: "ParentIssueRemovedEvent",
        id: "PIRE_removed",
        createdAt: "2026-07-31T11:00:00Z",
        actor: createActor(11),
        parent: createReferencedIssue("I_old_parent", 7, "CLOSED"),
      },
    ];
    const baseResponse = {
      item: {
        __typename: "Issue",
        id: "I_target",
        body: "Codex入力専用のIssue本文",
        lastEditedAt: null,
        userContentEdits: null,
        comments: {
          nodes: comments.slice(0, 100),
          pageInfo: createPageInfo(true, "comments-100"),
        },
        timelineItems: {
          nodes: timelineNodes,
          pageInfo: createPageInfo(false, null),
        },
        blockedBy: {
          nodes: [createReferencedIssue("I_blocker", 2, "OPEN")],
          pageInfo: createPageInfo(false, null),
        },
        blocking: {
          nodes: [createReferencedIssue("I_blocked", 3, "OPEN")],
          pageInfo: createPageInfo(false, null),
        },
        parent: createReferencedIssue("I_parent", 4, "OPEN"),
        subIssues: {
          nodes: [createReferencedIssue("I_child", 5, "CLOSED")],
          pageInfo: createPageInfo(false, null),
        },
      },
    };
    const mock = createGraphqlHttpMock((operation, variables) => {
      switch (operation) {
        case "GitHubItemDetailCapabilities":
          return createCapabilitiesResponse("available");
        case "GitHubItemDetail":
          expect(getStringVariable(variables, "itemId")).toBe("I_target");
          return baseResponse;
        case "GitHubItemCommentPage":
          expect(getStringVariable(variables, "after")).toBe("comments-100");
          return {
            item: {
              __typename: "Issue",
              id: "I_target",
              comments: {
                nodes: comments.slice(100),
                pageInfo: createPageInfo(false, null),
              },
            },
          };
        default:
          throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
      }
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });

    expect(collection.capabilities).toEqual({
      nativeDependencies: "available",
      nativeHierarchy: "available",
    });
    const detail = requireDetail(collection.items, 0);
    expect(detail.type).toBe("issue");
    if (detail.type !== "issue") {
      throw new Error("Issue detail fixtureではありません");
    }
    expect(detail.comments).toHaveLength(105);
    expect(detail.comments.map((comment) => comment.nodeId)).toEqual(
      Array.from({ length: 105 }, (_, index) => `IC_comment_${(index + 1).toString()}`),
    );
    expect(detail.comments.map((comment) => comment.sequence)).toEqual(
      Array.from({ length: 105 }, (_, index) => index),
    );
    expect(detail.comments[0]?.sourceId).toBe("github_issue_comment:IC_comment_1");
    expect(detail.comments[104]?.sourceId).toBe("github_issue_comment:IC_comment_105");
    expect(detail.timeline.map((event) => event.kind)).toEqual([
      "assigned",
      "unassigned",
      "blocked_by_added",
      "blocked_by_removed",
      "blocking_added",
      "blocking_removed",
      "labeled",
      "unlabeled",
      "closed",
      "cross_referenced",
      "connected",
      "disconnected",
      "sub_issue_added",
      "sub_issue_removed",
      "parent_issue_added",
      "parent_issue_removed",
    ]);
    const normalizedEvents = normalizeGitHubEvents({
      item,
      detail,
      isBot: () => false,
    });
    expect(normalizedEvents.map((event) => event.sourceId)).not.toEqual(
      expect.arrayContaining([
        "github_timeline_event:BBAE_added",
        "github_timeline_event:BBRE_removed",
        "github_timeline_event:BAE_added",
        "github_timeline_event:BRE_removed",
      ]),
    );
    expect(detail.timeline[0]?.sourceId).toBe("github_timeline_event:AE_assigned");
    const labeledEvent = detail.timeline.find((event) => event.kind === "labeled");
    if (labeledEvent?.kind !== "labeled" || labeledEvent.actor.status !== "identified") {
      throw new Error("Bot actor付きlabel event fixtureがありません");
    }
    expect(labeledEvent.actor.account.apiType).toBe("Bot");
    expect(
      detail.timeline.flatMap<Readonly<{ kind: string; relatedNodeId: string }>>((event) => {
        switch (event.kind) {
          case "sub_issue_added":
          case "sub_issue_removed":
            if ("status" in event.subIssue) {
              return [];
            }
            return [{ kind: event.kind, relatedNodeId: event.subIssue.nodeId }];
          case "parent_issue_added":
          case "parent_issue_removed":
            if ("status" in event.parent) {
              return [];
            }
            return [{ kind: event.kind, relatedNodeId: event.parent.nodeId }];
          default:
            return [];
        }
      }),
    ).toEqual([
      { kind: "sub_issue_added", relatedNodeId: "I_child" },
      { kind: "sub_issue_removed", relatedNodeId: "I_old_child" },
      { kind: "parent_issue_added", relatedNodeId: "I_parent" },
      { kind: "parent_issue_removed", relatedNodeId: "I_old_parent" },
    ]);
    if (detail.nativeDependencies.availability !== "available") {
      throw new Error("native dependency fixtureが利用不可です");
    }
    expect(
      detail.nativeDependencies.relations.map((relation) => ({
        authoritative: relation.authoritative,
        provenance: relation.provenance,
        direction: relation.direction,
        relatedItemNodeId: relation.relatedItem.nodeId,
      })),
    ).toEqual([
      {
        authoritative: true,
        provenance: "native",
        direction: "blocked_by",
        relatedItemNodeId: "I_blocker",
      },
      {
        authoritative: true,
        provenance: "native",
        direction: "blocking",
        relatedItemNodeId: "I_blocked",
      },
    ]);
    if (detail.nativeHierarchy.availability !== "available") {
      throw new Error("native hierarchy fixtureが利用不可です");
    }
    expect(
      detail.nativeHierarchy.relations.map((relation) => ({
        authoritative: relation.authoritative,
        provenance: relation.provenance,
        relationship: relation.relationship,
        relatedItemNodeId: relation.relatedItem.nodeId,
      })),
    ).toEqual([
      {
        authoritative: true,
        provenance: "native",
        relationship: "parent",
        relatedItemNodeId: "I_parent",
      },
      {
        authoritative: true,
        provenance: "native",
        relationship: "sub_issue",
        relatedItemNodeId: "I_child",
      },
    ]);
    expect(
      detail.inboundCrossReferences.map((candidate) => ({
        candidateOnly: candidate.candidateOnly,
        provenance: candidate.provenance,
        eventSourceId: candidate.eventSourceId,
        sourceItemNodeId: candidate.sourceItem.nodeId,
        sourceItemNumber: candidate.sourceItem.number,
        willCloseTarget: candidate.willCloseTarget,
      })),
    ).toEqual([
      {
        candidateOnly: true,
        provenance: "cross_reference",
        eventSourceId: "github_timeline_event:CRE_inbound",
        sourceItemNodeId: "I_source",
        sourceItemNumber: 99,
        willCloseTarget: true,
      },
    ]);
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubItemCommentPage",
    ]);
    expect(mock.requests[1]?.query).toContain("comments(first: 100)");
    expect(mock.requests[1]?.query).toContain("timelineItems(first: 100");
    expect(mock.requests[1]?.query).toContain("blockedBy(first: 100)");
    expect(mock.requests[1]?.query).toContain("issueState: state");
    expect(mock.requests[1]?.query).toContain("pullRequestState: state");
    expect(getFragmentDefinitionNames(getRequestQuery(mock.requests, 1))).toEqual([
      "DetailActorFields",
      "DetailAssigneeFields",
      "DetailCheckContextFields",
      "DetailHeadCommitFields",
      "DetailIssueCommentFields",
      "DetailIssueTimelineFields",
      "DetailPullRequestTimelineFields",
      "DetailReferencedItemFields",
      "DetailReviewCommentFields",
      "DetailReviewFields",
      "DetailReviewRequestTargetFields",
      "DetailReviewThreadFields",
      "DetailUserContentEditFields",
    ]);
    expect(getFragmentDefinitionNames(getRequestQuery(mock.requests, 2))).toEqual([
      "DetailActorFields",
      "DetailIssueCommentFields",
      "DetailUserContentEditFields",
    ]);
  });

  it("削除済みassigneeと参照不能なIssueをunavailableとして保持し判定根拠から除外する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_unavailable_timeline_targets", 30, "issue");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timelineNodes = [
      {
        __typename: "AssignedEvent",
        id: "AE_unavailable",
        createdAt: "2026-07-31T01:00:00Z",
        actor: createActor(1),
        assignee: null,
      },
      {
        __typename: "UnassignedEvent",
        id: "UE_unavailable",
        createdAt: "2026-07-31T02:00:00Z",
        actor: createActor(2),
        assignee: null,
      },
      {
        __typename: "BlockedByAddedEvent",
        id: "BBAE_unavailable",
        createdAt: "2026-07-31T02:30:00Z",
        actor: null,
        blockingIssue: null,
      },
      {
        __typename: "BlockedByRemovedEvent",
        id: "BBRE_unavailable",
        createdAt: "2026-07-31T02:40:00Z",
        actor: null,
        blockingIssue: null,
      },
      {
        __typename: "BlockingAddedEvent",
        id: "BAE_unavailable",
        createdAt: "2026-07-31T02:50:00Z",
        actor: null,
        blockedIssue: null,
      },
      {
        __typename: "BlockingRemovedEvent",
        id: "BRE_unavailable",
        createdAt: "2026-07-31T02:55:00Z",
        actor: null,
        blockedIssue: null,
      },
      {
        __typename: "SubIssueAddedEvent",
        id: "SIAE_unavailable",
        createdAt: "2026-07-31T03:00:00Z",
        actor: createActor(3),
        subIssue: null,
      },
      {
        __typename: "SubIssueRemovedEvent",
        id: "SIRE_unavailable",
        createdAt: "2026-07-31T04:00:00Z",
        actor: createActor(4),
        subIssue: null,
      },
      {
        __typename: "ParentIssueAddedEvent",
        id: "PIAE_unavailable",
        createdAt: "2026-07-31T05:00:00Z",
        actor: createActor(5),
        parent: null,
      },
      {
        __typename: "ParentIssueRemovedEvent",
        id: "PIRE_unavailable",
        createdAt: "2026-07-31T06:00:00Z",
        actor: createActor(6),
        parent: null,
      },
    ];
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return {
          item: {
            __typename: "Issue",
            id: "I_unavailable_timeline_targets",
            body: "本文",
            lastEditedAt: null,
            userContentEdits: null,
            comments: createEmptyConnection(),
            timelineItems: {
              nodes: timelineNodes,
              pageInfo: createPageInfo(false, null),
            },
            blockedBy: createEmptyConnection(),
            blocking: createEmptyConnection(),
            parent: null,
            subIssues: createEmptyConnection(),
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });
    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "issue") {
      throw new Error("Issue detail fixtureではありません");
    }

    expect(detail.timeline).toMatchObject([
      {
        kind: "assigned",
        assignee: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
      },
      {
        kind: "unassigned",
        assignee: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
      },
      {
        kind: "blocked_by_added",
        actor: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
        blockingIssue: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "blocked_by_removed",
        actor: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
        blockingIssue: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "blocking_added",
        actor: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
        blockedIssue: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "blocking_removed",
        actor: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
        blockedIssue: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "sub_issue_added",
        subIssue: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "sub_issue_removed",
        subIssue: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "parent_issue_added",
        parent: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
      {
        kind: "parent_issue_removed",
        parent: {
          status: "unavailable",
          reason: "github_did_not_return_item",
        },
      },
    ]);
    expect(
      normalizeGitHubEvents({
        item,
        detail,
        isBot: () => false,
      }),
    ).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "GitHubの判定根拠を除外しました item=VOICEVOX/example#30 fields=AssignedEvent.assignee,UnassignedEvent.assignee,SubIssueAddedEvent.subIssue,SubIssueRemovedEvent.subIssue,ParentIssueAddedEvent.parent,ParentIssueRemovedEvent.parent",
    );
    warning.mockRestore();
  });

  it("native APIがschemaにない場合は空配列ではなく利用不可を明示する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_no_native", 6, "issue");
    const mock = await createAuthenticatedGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        return {
          item: {
            __typename: "Issue",
            id: "I_no_native",
            body: "",
            lastEditedAt: null,
            userContentEdits: null,
            comments: createEmptyConnection(),
            timelineItems: createEmptyConnection(),
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.client.graphql,
    });

    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "issue") {
      throw new Error("Issue detail fixtureではありません");
    }
    expect(detail.nativeDependencies).toEqual({
      availability: "unavailable",
      reason: "api_not_supported",
    });
    expect(detail.nativeHierarchy).toEqual({
      availability: "unavailable",
      reason: "api_not_supported",
    });
    expect(mock.requests.map((request) => request.path)).toEqual([
      "/app/installations/123/access_tokens",
      "/graphql",
      "/graphql",
    ]);
    const detailRequest = mock.requests[2];
    if (detailRequest?.body == null) {
      throw new Error("詳細取得のHTTP request bodyがありません");
    }
    const parsedBody: unknown = JSON.parse(detailRequest.body);
    const detailPayload = graphqlHttpPayloadSchema.parse(parsedBody);
    expect(detailPayload.query).not.toContain("blockedBy(first: 100)");
    expect(detailPayload.query).not.toContain("subIssues(first: 100)");
  });
});

function createReview(
  id: string,
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED",
  index: number,
): unknown {
  return {
    id,
    url: `https://github.com/VOICEVOX/example/pull/7#pullrequestreview-${index.toString()}`,
    author: createActor(index),
    body: `レビュー${index.toString()}`,
    state,
    submittedAt: `2026-07-31T0${index.toString()}:00:00Z`,
    commit: {
      id: "C_old",
      oid: "old-head-sha",
    },
  };
}

function createReviewThread(id: string, isResolved: boolean, index: number): unknown {
  const timestamp = new Date(Date.parse("2026-07-31T00:00:00Z") + index * 60 * 1000).toISOString();
  return {
    id,
    isResolved,
    isOutdated: false,
    path: `src/file-${index.toString()}.ts`,
    resolvedBy: isResolved ? createActor(index) : null,
    comments: {
      nodes: [
        {
          id: `PRRC_comment_${index.toString()}`,
          author: createActor(index),
          body: `inline comment ${index.toString()}`,
          createdAt: timestamp,
          lastEditedAt: null,
          updatedAt: timestamp,
          userContentEdits: null,
          url: `https://github.com/VOICEVOX/example/pull/7#discussion_r${index.toString()}`,
        },
      ],
      pageInfo: createPageInfo(false, null),
    },
  };
}

function createPullRequestResponse(
  itemNodeId: string,
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN",
  mergeStateStatus:
    "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE",
  checkState: "ERROR" | "EXPECTED" | "FAILURE" | "PENDING" | "SUCCESS",
  checkContexts: readonly unknown[],
): Readonly<{
  item: Readonly<{
    userContentEdits: unknown;
    comments: unknown;
    reviewThreads: unknown;
    [key: string]: unknown;
  }>;
}> {
  const headCommit = {
    id: `C_${itemNodeId}`,
    oid: `head-${itemNodeId}`,
    committedDate: "2026-07-31T20:00:00Z",
    pushedDate: "2026-07-31T20:01:00Z",
    statusCheckRollup: {
      id: `SCR_${itemNodeId}`,
      state: checkState,
      contexts: {
        nodes: [...checkContexts],
        pageInfo: createPageInfo(false, null),
      },
    },
  };
  return {
    item: {
      __typename: "PullRequest",
      id: itemNodeId,
      body: "Codex入力専用のPull Request本文",
      lastEditedAt: null,
      userContentEdits: null,
      closingIssuesReferences: createEmptyConnection(),
      headRefOid: `head-${itemNodeId}`,
      reviewDecision: null,
      headRef: {
        target: headCommit,
      },
      mergeable,
      mergeStateStatus,
      autoMergeRequest: null,
      mergeQueueEntry: null,
      comments: createEmptyConnection(),
      reviews: createEmptyConnection(),
      reviewThreads: createEmptyConnection(),
      reviewRequests: createEmptyConnection(),
      headCommit: {
        nodes: [
          {
            commit: headCommit,
          },
        ],
      },
      timelineItems: createEmptyConnection(),
    },
  };
}

function createPullRequestUserContentEditResponse(
  itemNodeId: string,
  bodyUserContentEdits: unknown,
  comments: unknown,
  reviewThreads: unknown,
): unknown {
  const response = createPullRequestResponse(itemNodeId, "MERGEABLE", "CLEAN", "SUCCESS", []);
  return {
    ...response,
    item: {
      ...response.item,
      body: "編集履歴を持つPull Request本文",
      lastEditedAt: "2026-07-30T02:00:00Z",
      userContentEdits: bodyUserContentEdits,
      comments,
      reviewThreads,
    },
  };
}

function createHeadCommit(id: string, oid: string): unknown {
  return {
    id,
    oid,
    committedDate: "2026-07-31T20:00:00Z",
    pushedDate: "2026-07-31T20:01:00Z",
    statusCheckRollup: null,
  };
}

function createPullRequestNullableFieldResponse(
  itemNodeId: string,
  timelineNodes: readonly unknown[],
  reviewRequestNodes: readonly unknown[],
  autoMergeRequest: unknown,
): unknown {
  const headCommit = {
    id: `C_${itemNodeId}`,
    oid: `head-${itemNodeId}`,
    committedDate: "2026-07-31T20:00:00Z",
    pushedDate: "2026-07-31T20:01:00Z",
    statusCheckRollup: null,
  };
  return {
    item: {
      __typename: "PullRequest",
      id: itemNodeId,
      body: "本文",
      lastEditedAt: null,
      userContentEdits: null,
      closingIssuesReferences: createEmptyConnection(),
      headRefOid: `head-${itemNodeId}`,
      reviewDecision: null,
      headRef: {
        target: headCommit,
      },
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      autoMergeRequest,
      mergeQueueEntry: null,
      comments: createEmptyConnection(),
      reviews: createEmptyConnection(),
      reviewThreads: createEmptyConnection(),
      reviewRequests: {
        nodes: reviewRequestNodes,
        pageInfo: createPageInfo(false, null),
      },
      headCommit: {
        nodes: [
          {
            commit: headCommit,
          },
        ],
      },
      timelineItems: {
        nodes: timelineNodes,
        pageInfo: createPageInfo(false, null),
      },
    },
  };
}

async function collectPullRequestNullableFieldFixture(
  itemNodeId: string,
  number: number,
  timelineNodes: readonly unknown[],
  reviewRequestNodes: readonly unknown[],
  autoMergeRequest: unknown,
): Promise<
  Readonly<{
    item: EnumeratedGitHubItem;
    detail: Extract<GitHubItemDetail, { type: "pull_request" }>;
  }>
> {
  const allowlist = createAllowlist();
  const item = createItem(allowlist, itemNodeId, number, "pull_request");
  const response = createPullRequestNullableFieldResponse(
    itemNodeId,
    timelineNodes,
    reviewRequestNodes,
    autoMergeRequest,
  );
  const mock = createGraphqlHttpMock((operation) => {
    if (operation === "GitHubItemDetailCapabilities") {
      return createCapabilitiesResponse("available");
    }
    if (operation === "GitHubItemDetail") {
      return response;
    }
    throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
  });
  const collection = await collectGitHubItemDetails({
    allowlist,
    targets: [
      {
        item,
      },
    ],
    observedAt,
    graphql: mock.graphql,
  });
  const detail = requireDetail(collection.items, 0);
  if (detail.type !== "pull_request") {
    throw new Error("Pull Request detail fixtureではありません");
  }
  return Object.freeze({
    item,
    detail,
  });
}

function createPullRequestHeadCommitResolutionResponse(
  itemNodeId: string,
  headRefOid: string,
  headRef: unknown,
  comparisonHeadCommits: readonly unknown[],
): unknown {
  return {
    item: {
      __typename: "PullRequest",
      id: itemNodeId,
      body: "Codex入力専用のPull Request本文",
      lastEditedAt: null,
      userContentEdits: null,
      closingIssuesReferences: createEmptyConnection(),
      headRefOid,
      reviewDecision: null,
      headRef,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      autoMergeRequest: null,
      mergeQueueEntry: null,
      comments: createEmptyConnection(),
      reviews: createEmptyConnection(),
      reviewThreads: createEmptyConnection(),
      reviewRequests: createEmptyConnection(),
      headCommit: {
        nodes: comparisonHeadCommits.map((commit) => ({ commit })),
      },
      timelineItems: createEmptyConnection(),
    },
  };
}

describe("Pull Request詳細収集", () => {
  it("対象が削除された現行review requestをunavailableとして保持し判定根拠から除外する", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { item, detail } = await collectPullRequestNullableFieldFixture(
      "PR_unavailable_current_review_request",
      24,
      [],
      [
        {
          id: "RR_unavailable",
          requestedReviewer: null,
        },
      ],
      null,
    );

    expect(detail.reviewRequests.current).toMatchObject([
      {
        sourceId: "github_review_request:RR_unavailable",
        target: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
        requestedAt: {
          status: "unavailable",
          reason: "timeline_event_not_found",
        },
      },
    ]);
    const observation = normalizeObservedGitHubItem({
      item,
      detail,
      isBot: () => false,
    });
    if (observation.type !== "pull_request") {
      throw new Error("Pull Request observation fixtureではありません");
    }
    expect(observation.reviewRequests).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "GitHubの判定根拠を除外しました item=VOICEVOX/example#24 fields=ReviewRequest.requestedReviewer",
    );
    warning.mockRestore();
  });

  it("timeline上の削除済みreviewerとassigneeをunavailableとして保持し判定根拠から除外する", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timelineNodes = [
      {
        __typename: "ReviewRequestedEvent",
        id: "RRE_unavailable",
        createdAt: "2026-07-31T01:00:00Z",
        actor: createActor(1),
        requestedReviewer: null,
      },
      {
        __typename: "ReviewRequestRemovedEvent",
        id: "RRRE_unavailable",
        createdAt: "2026-07-31T02:00:00Z",
        actor: createActor(2),
        requestedReviewer: null,
      },
      {
        __typename: "AssignedEvent",
        id: "AE_unavailable_pr",
        createdAt: "2026-07-31T03:00:00Z",
        actor: createActor(3),
        assignee: null,
      },
      {
        __typename: "UnassignedEvent",
        id: "UE_unavailable_pr",
        createdAt: "2026-07-31T04:00:00Z",
        actor: createActor(4),
        assignee: null,
      },
    ];
    const { item, detail } = await collectPullRequestNullableFieldFixture(
      "PR_unavailable_timeline_actors",
      25,
      timelineNodes,
      [],
      null,
    );

    expect(detail.timeline).toMatchObject([
      {
        kind: "review_requested",
        target: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
      },
      {
        kind: "review_request_removed",
        target: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
      },
      {
        kind: "assigned",
        assignee: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
      },
      {
        kind: "unassigned",
        assignee: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
      },
    ]);
    expect(detail.reviewRequests.history).toHaveLength(2);
    expect(
      normalizeGitHubEvents({
        item,
        detail,
        isBot: () => false,
      }).map((event) => event.kind),
    ).toEqual(["push"]);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "GitHubの判定根拠を除外しました item=VOICEVOX/example#25 fields=AssignedEvent.assignee,UnassignedEvent.assignee,ReviewRequestedEvent.requestedReviewer,ReviewRequestRemovedEvent.requestedReviewer",
    );
    warning.mockRestore();
  });

  it("force push前のCommitだけが参照不能でもpushイベントを生成する", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timelineNodes = [
      {
        __typename: "HeadRefForcePushedEvent",
        id: "HRFPE_unavailable_before",
        createdAt: "2026-07-31T01:00:00Z",
        actor: createActor(1),
        beforeCommit: null,
        afterCommit: {
          oid: "after-sha",
        },
      },
    ];
    const { item, detail } = await collectPullRequestNullableFieldFixture(
      "PR_unavailable_force_push_before_commit",
      26,
      timelineNodes,
      [],
      null,
    );

    expect(detail.timeline).toMatchObject([
      {
        kind: "head_ref_force_pushed",
        beforeSha: {
          status: "unavailable",
          reason: "github_did_not_return_commit",
        },
        afterSha: "after-sha",
      },
    ]);
    const normalizedPushEvents = normalizeGitHubEvents({
      item,
      detail,
      isBot: () => false,
    }).filter((event) => event.kind === "push");
    expect(normalizedPushEvents).toHaveLength(2);
    expect(normalizedPushEvents).toContainEqual(
      expect.objectContaining({
        forcePush: true,
        headCommitSha: "after-sha",
      }),
    );
    expect(normalizedPushEvents).toContainEqual(
      expect.objectContaining({
        forcePush: false,
        headCommitSha: "head-PR_unavailable_force_push_before_commit",
      }),
    );
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("force push後のCommitが参照不能ならpushイベントを除外して警告する", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timelineNodes = [
      {
        __typename: "HeadRefForcePushedEvent",
        id: "HRFPE_unavailable_after",
        createdAt: "2026-07-31T02:00:00Z",
        actor: createActor(2),
        beforeCommit: {
          oid: "before-sha",
        },
        afterCommit: null,
      },
    ];
    const { item, detail } = await collectPullRequestNullableFieldFixture(
      "PR_unavailable_force_push_after_commit",
      27,
      timelineNodes,
      [],
      null,
    );

    expect(detail.timeline).toMatchObject([
      {
        kind: "head_ref_force_pushed",
        beforeSha: "before-sha",
        afterSha: {
          status: "unavailable",
          reason: "github_did_not_return_commit",
        },
      },
    ]);
    const normalizedPushEvents = normalizeGitHubEvents({
      item,
      detail,
      isBot: () => false,
    }).filter((event) => event.kind === "push");
    expect(normalizedPushEvents).toHaveLength(1);
    expect(normalizedPushEvents[0]).toMatchObject({
      forcePush: false,
      headCommitSha: "head-PR_unavailable_force_push_after_commit",
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "GitHubの判定根拠を除外しました item=VOICEVOX/example#27 fields=HeadRefForcePushedEvent.afterCommit",
    );
    warning.mockRestore();
  });

  it("差分commit列が0件でもheadRef.targetからhead commitを解決する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_head_ref_target", 20, "pull_request");
    const headCommit = createHeadCommit("C_head_ref_target", "head-ref-target-sha");
    const response = createPullRequestHeadCommitResolutionResponse(
      "PR_head_ref_target",
      "head-ref-target-sha",
      {
        target: headCommit,
      },
      [],
    );
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });

    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "pull_request") {
      throw new Error("Pull Request detail fixtureではありません");
    }
    expect(detail.headCommit).toMatchObject({
      nodeId: "C_head_ref_target",
      sha: "head-ref-target-sha",
    });
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
    ]);
  });

  it("headRefがnullでも差分commit列の末尾からhead commitを解決する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_comparison_head", 21, "pull_request");
    const comparisonHeadCommit = createHeadCommit("C_comparison_head", "comparison-head-sha");
    const response = createPullRequestHeadCommitResolutionResponse(
      "PR_comparison_head",
      "comparison-head-sha",
      null,
      [comparisonHeadCommit],
    );
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });

    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "pull_request") {
      throw new Error("Pull Request detail fixtureではありません");
    }
    expect(detail.headCommit).toMatchObject({
      nodeId: "C_comparison_head",
      sha: "comparison-head-sha",
    });
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
    ]);
  });

  it("既存候補のOIDが一致しない場合はrepository.objectからhead commitを解決する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_repository_object", 22, "pull_request");
    const response = createPullRequestHeadCommitResolutionResponse(
      "PR_repository_object",
      "repository-object-sha",
      {
        target: createHeadCommit("C_stale_head_ref", "stale-head-ref-sha"),
      },
      [createHeadCommit("C_stale_comparison", "stale-comparison-sha")],
    );
    const repositoryObject = createHeadCommit("C_repository_object", "repository-object-sha");
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      if (operation === "GitHubPullRequestHeadCommit") {
        expect(getStringVariable(variables, "pullRequestId")).toBe("PR_repository_object");
        expect(getStringVariable(variables, "headRefOid")).toBe("repository-object-sha");
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_repository_object",
            repository: {
              object: repositoryObject,
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });

    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "pull_request") {
      throw new Error("Pull Request detail fixtureではありません");
    }
    expect(detail.headCommit).toMatchObject({
      nodeId: "C_repository_object",
      sha: "repository-object-sha",
    });
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubPullRequestHeadCommit",
    ]);
  });

  it("head commitを解決できない場合は項目詳細収集エラーから元の型付きエラーへcauseを繋ぐ", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_unresolved_head", 23, "pull_request");
    const response = createPullRequestHeadCommitResolutionResponse(
      "PR_unresolved_head",
      "unresolved-head-sha",
      {
        target: createHeadCommit("C_unresolved_head_ref", "stale-head-ref-sha"),
      },
      [createHeadCommit("C_unresolved_comparison", "stale-comparison-sha")],
    );
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      if (operation === "GitHubPullRequestHeadCommit") {
        return {
          pullRequest: {
            __typename: "PullRequest",
            id: "PR_unresolved_head",
            repository: {
              object: null,
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    try {
      await collectGitHubItemDetails({
        allowlist,
        targets: [
          {
            item,
          },
        ],
        observedAt,
        graphql: mock.graphql,
      });
      throw new Error("GitHubItemDetailCollectionErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubItemDetailCollectionError)) {
        throw error;
      }
      if (!(error.cause instanceof GitHubResponseValidationError)) {
        throw new Error("GitHubItemDetailCollectionErrorのcauseが不正です");
      }
      expect(error.cause.message).toContain("unresolved-head-sha");
      if (!(error.cause.cause instanceof TypeError)) {
        throw new Error("GitHubResponseValidationErrorのcauseがTypeErrorではありません");
      }
      expect(error.cause.cause.message).toContain("repository.object");
    }
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubPullRequestHeadCommit",
    ]);
  });

  it("review、closing対象Issue、head更新、merge情報を区別して全ページ返す", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_target", 7, "pull_request");
    const timelineNodes = [
      {
        __typename: "ReviewRequestedEvent",
        id: "RRE_old_user",
        createdAt: "2026-07-31T01:00:00Z",
        actor: createActor(1),
        requestedReviewer: {
          __typename: "User",
          id: "U_old_reviewer",
          login: "old-reviewer",
        },
      },
      {
        __typename: "ReviewRequestRemovedEvent",
        id: "RRRE_old_user",
        createdAt: "2026-07-31T02:00:00Z",
        actor: createActor(2),
        requestedReviewer: {
          __typename: "User",
          id: "U_old_reviewer",
          login: "old-reviewer",
        },
      },
      {
        __typename: "ReviewRequestedEvent",
        id: "RRE_team",
        createdAt: "2026-07-31T03:00:00Z",
        actor: createActor(3),
        requestedReviewer: {
          __typename: "Team",
          id: "T_reviewers",
          name: "Reviewers",
          slug: "reviewers",
          organization: {
            login: "VOICEVOX",
          },
        },
      },
      {
        __typename: "ReadyForReviewEvent",
        id: "RFRE_ready",
        createdAt: "2026-07-31T04:00:00Z",
        actor: createActor(4),
      },
      {
        __typename: "PullRequestCommit",
        id: "PRC_new_head",
        commit: {
          id: "C_new",
          oid: "new-head-sha",
          committedDate: "2026-07-31T12:00:00Z",
          pushedDate: "2026-07-31T12:01:00Z",
        },
      },
      {
        __typename: "HeadRefForcePushedEvent",
        id: "HRFPE_force_push",
        createdAt: "2026-07-31T12:01:00Z",
        actor: createActor(5),
        beforeCommit: {
          oid: "old-head-sha",
        },
        afterCommit: {
          oid: "new-head-sha",
        },
      },
      {
        __typename: "AddedToMergeQueueEvent",
        id: "ATMQE_added",
        createdAt: "2026-07-31T13:00:00Z",
        actor: createActor(6),
      },
      {
        __typename: "RemovedFromMergeQueueEvent",
        id: "RFMQE_removed",
        createdAt: "2026-07-31T14:00:00Z",
        actor: createActor(7),
      },
      {
        __typename: "AutoMergeEnabledEvent",
        id: "AMEE_enabled",
        createdAt: "2026-07-31T15:00:00Z",
        actor: createActor(8),
      },
      {
        __typename: "AutoMergeDisabledEvent",
        id: "AMDE_disabled",
        createdAt: "2026-07-31T16:00:00Z",
        actor: createActor(9),
      },
    ];
    const closingIssues = Array.from({ length: 101 }, (_, index) =>
      createReferencedIssue(`I_closing_${(index + 1).toString()}`, index + 1, "OPEN"),
    );
    const baseResponse = {
      item: {
        __typename: "PullRequest",
        id: "PR_target",
        body: "Codex入力専用のPull Request本文",
        lastEditedAt: null,
        userContentEdits: null,
        closingIssuesReferences: {
          nodes: closingIssues.slice(0, 100),
          pageInfo: createPageInfo(true, "closing-issues-next"),
        },
        headRefOid: "new-head-sha",
        reviewDecision: null,
        headRef: null,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        autoMergeRequest: {
          enabledAt: "2026-07-31T15:00:00Z",
          enabledBy: createActor(8),
          mergeMethod: "SQUASH",
        },
        mergeQueueEntry: {
          id: "MQE_current",
        },
        comments: createEmptyConnection(),
        reviews: {
          nodes: [
            createReview("PRR_approved", "APPROVED", 1),
            createReview("PRR_changes", "CHANGES_REQUESTED", 2),
            createReview("PRR_commented", "COMMENTED", 3),
            createReview("PRR_dismissed", "DISMISSED", 4),
          ],
          pageInfo: createPageInfo(false, null),
        },
        reviewThreads: {
          nodes: [
            createReviewThread("PRRT_resolved", true, 1),
            createReviewThread("PRRT_unresolved", false, 2),
          ],
          pageInfo: createPageInfo(false, null),
        },
        reviewRequests: {
          nodes: [
            {
              id: "RR_team",
              requestedReviewer: {
                __typename: "Team",
                id: "T_reviewers",
                name: "Reviewers",
                slug: "reviewers",
                organization: {
                  login: "VOICEVOX",
                },
              },
            },
          ],
          pageInfo: createPageInfo(false, null),
        },
        headCommit: {
          nodes: [
            {
              commit: {
                id: "C_new",
                oid: "new-head-sha",
                committedDate: "2026-07-31T12:00:00Z",
                pushedDate: "2026-07-31T12:01:00Z",
                statusCheckRollup: {
                  id: "SCR_head",
                  state: "PENDING",
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        id: "CR_build",
                        name: "build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        completedAt: "2026-07-31T12:03:00Z",
                      },
                      {
                        __typename: "StatusContext",
                        id: "SC_external",
                        context: "external-ci",
                        state: "PENDING",
                        createdAt: "2026-07-31T12:02:00Z",
                      },
                    ],
                    pageInfo: createPageInfo(false, null),
                  },
                },
              },
            },
          ],
        },
        timelineItems: {
          nodes: timelineNodes.slice(0, -1),
          pageInfo: createPageInfo(true, "timeline-next"),
        },
      },
    };
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return baseResponse;
      }
      if (operation === "GitHubPullRequestClosingIssuePage") {
        expect(getStringVariable(variables, "after")).toBe("closing-issues-next");
        return {
          item: {
            __typename: "PullRequest",
            id: "PR_target",
            closingIssuesReferences: {
              nodes: closingIssues.slice(100),
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      if (operation === "GitHubPullRequestTimelinePage") {
        expect(getStringVariable(variables, "after")).toBe("timeline-next");
        return {
          item: {
            __typename: "PullRequest",
            id: "PR_target",
            timelineItems: {
              nodes: timelineNodes.slice(-1),
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [
        {
          item,
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });

    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "pull_request") {
      throw new Error("Pull Request detail fixtureではありません");
    }
    expect(detail.reviews.map((review) => review.state)).toEqual([
      "approved",
      "changes_requested",
      "commented",
      "dismissed",
    ]);
    expect(detail.reviews.map((review) => review.commit)).toEqual([
      expect.objectContaining({
        status: "available",
        sha: "old-head-sha",
      }),
      expect.objectContaining({
        status: "available",
        sha: "old-head-sha",
      }),
      expect.objectContaining({
        status: "available",
        sha: "old-head-sha",
      }),
      expect.objectContaining({
        status: "available",
        sha: "old-head-sha",
      }),
    ]);
    expect(
      detail.reviewThreads.map((thread) => ({
        isResolved: thread.isResolved,
        sourceId: thread.sourceId,
      })),
    ).toEqual([
      {
        isResolved: true,
        sourceId: "github_pull_request_review_thread:PRRT_resolved",
      },
      {
        isResolved: false,
        sourceId: "github_pull_request_review_thread:PRRT_unresolved",
      },
    ]);
    expect(
      detail.reviewRequests.current.map((request) => {
        if ("status" in request.target) {
          throw new Error("review request対象fixtureが取得不能です");
        }
        return {
          sourceId: request.sourceId,
          targetType: request.target.type,
          targetNodeId: request.target.nodeId,
          requestedAt: request.requestedAt,
        };
      }),
    ).toEqual([
      {
        sourceId: "github_review_request:RR_team",
        targetType: "team",
        targetNodeId: "T_reviewers",
        requestedAt: {
          status: "available",
          value: "2026-07-31T03:00:00.000Z",
        },
      },
    ]);
    expect(
      detail.reviewRequests.history.map((event) => {
        if ("status" in event.target) {
          throw new Error("review request履歴対象fixtureが取得不能です");
        }
        return {
          kind: event.kind,
          target: event.target.nodeId,
          occurredAt: event.occurredAt,
        };
      }),
    ).toEqual([
      {
        kind: "review_requested",
        target: "U_old_reviewer",
        occurredAt: "2026-07-31T01:00:00.000Z",
      },
      {
        kind: "review_request_removed",
        target: "U_old_reviewer",
        occurredAt: "2026-07-31T02:00:00.000Z",
      },
      {
        kind: "review_requested",
        target: "T_reviewers",
        occurredAt: "2026-07-31T03:00:00.000Z",
      },
    ]);
    expect(detail.nativeClosingIssues).toHaveLength(101);
    expect(detail.nativeClosingIssues[0]).toMatchObject({
      sourceId: "github_native_closing_issue:PR_target:I_closing_1",
      authoritative: true,
      provenance: "native",
      relatedItem: {
        nodeId: "I_closing_1",
      },
    });
    expect(detail.nativeClosingIssues[100]?.relatedItem.nodeId).toBe("I_closing_101");
    expect(detail.headSha).toBe("new-head-sha");
    expect(detail.headCommit).toMatchObject({
      nodeId: "C_new",
      sha: "new-head-sha",
      committedAt: "2026-07-31T12:00:00.000Z",
      pushedAt: {
        status: "available",
        value: "2026-07-31T12:01:00.000Z",
      },
    });
    const commitEvent = detail.timeline.find((event) => event.kind === "commit_added");
    if (commitEvent?.kind !== "commit_added") {
      throw new Error("commit timeline event fixtureがありません");
    }
    expect(commitEvent.commit.sha).toBe("new-head-sha");
    const forcePushEvent = detail.timeline.find((event) => event.kind === "head_ref_force_pushed");
    if (forcePushEvent?.kind !== "head_ref_force_pushed") {
      throw new Error("force push timeline event fixtureがありません");
    }
    expect({
      beforeSha: forcePushEvent.beforeSha,
      afterSha: forcePushEvent.afterSha,
    }).toEqual({
      beforeSha: "old-head-sha",
      afterSha: "new-head-sha",
    });
    expect(detail.mergeState).toMatchObject({
      mergeability: "mergeable",
      mergeState: "blocked",
      autoMerge: {
        status: "enabled",
        sourceId: "github_auto_merge_request:PR_target",
        mergeMethod: "squash",
      },
      mergeQueue: {
        status: "queued",
      },
      checks: {
        status: "configured",
        combinedState: "pending",
        contexts: [
          {
            type: "check_run",
            sourceId: "github_check_run:CR_build",
            nodeId: "CR_build",
            name: "build",
            status: "completed",
            conclusion: "success",
            completedAt: "2026-07-31T12:03:00.000Z",
          },
          {
            type: "commit_status",
            sourceId: "github_commit_status:SC_external",
            nodeId: "SC_external",
            context: "external-ci",
            state: "pending",
            createdAt: "2026-07-31T12:02:00.000Z",
          },
        ],
      },
    });
    expect(detail.mergeState.autoMerge).not.toHaveProperty("nodeId");
    expect(detail.timeline.map((event) => event.kind)).toEqual([
      "review_requested",
      "review_request_removed",
      "review_requested",
      "ready_for_review",
      "commit_added",
      "head_ref_force_pushed",
      "added_to_merge_queue",
      "removed_from_merge_queue",
      "auto_merge_enabled",
      "auto_merge_disabled",
    ]);
    expect(mock.requests[1]?.query).not.toMatch(/autoMergeRequest\s*\{\s*id\b/u);
    expect(mock.requests[1]?.query).toContain("closingIssuesReferences(first: 100)");
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubPullRequestClosingIssuePage",
      "GitHubPullRequestTimelinePage",
    ]);
    expect(getFragmentDefinitionNames(getRequestQuery(mock.requests, 2))).toEqual([
      "DetailReferencedItemFields",
    ]);
    expect(getFragmentDefinitionNames(getRequestQuery(mock.requests, 3))).toEqual([
      "DetailActorFields",
      "DetailAssigneeFields",
      "DetailPullRequestTimelineFields",
      "DetailReferencedItemFields",
      "DetailReviewRequestTargetFields",
    ]);
  });

  it("完了済みcheck runにcompletedAtが無い応答を拒否する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_missing_check_completed_at", 8, "pull_request");
    const response = createPullRequestResponse(
      "PR_missing_check_completed_at",
      "MERGEABLE",
      "BLOCKED",
      "FAILURE",
      [
        {
          __typename: "CheckRun",
          id: "CR_missing_completed_at",
          name: "test",
          status: "COMPLETED",
          conclusion: "FAILURE",
          completedAt: null,
        },
      ],
    );
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    await expect(
      collectGitHubItemDetails({
        allowlist,
        targets: [
          {
            item,
          },
        ],
        observedAt,
        graphql: mock.graphql,
      }),
    ).rejects.toThrowError(GitHubItemDetailCollectionError);
  });

  it("ready、running、failing、conflictを構成するmergeとcheck信号を保持する", async () => {
    const allowlist = createAllowlist();
    const fixtures = [
      {
        item: createItem(allowlist, "PR_ready", 10, "pull_request"),
        response: createPullRequestResponse("PR_ready", "MERGEABLE", "CLEAN", "SUCCESS", []),
      },
      {
        item: createItem(allowlist, "PR_running", 11, "pull_request"),
        response: createPullRequestResponse("PR_running", "MERGEABLE", "BLOCKED", "PENDING", []),
      },
      {
        item: createItem(allowlist, "PR_failing", 12, "pull_request"),
        response: createPullRequestResponse("PR_failing", "MERGEABLE", "BLOCKED", "FAILURE", []),
      },
      {
        item: createItem(allowlist, "PR_conflict", 13, "pull_request"),
        response: createPullRequestResponse("PR_conflict", "CONFLICTING", "DIRTY", "SUCCESS", []),
      },
    ];
    const responses = new Map(fixtures.map((fixture) => [fixture.item.nodeId, fixture.response]));
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("available");
      }
      if (operation !== "GitHubItemDetail") {
        throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
      }
      const itemNodeId = getStringVariable(variables, "itemId");
      const response = responses.get(createGitHubNodeId(itemNodeId));
      if (response == null) {
        throw new Error(`Pull Request response fixtureがありません。対象: ${itemNodeId}`);
      }
      return response;
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: fixtures.map((fixture) => ({
        item: fixture.item,
      })),
      observedAt,
      graphql: mock.graphql,
    });

    const mergeSignals = collection.items.map((detail) => {
      if (detail.type !== "pull_request") {
        throw new Error("Pull Request detail fixtureではありません");
      }
      if (detail.mergeState.checks.status !== "configured") {
        throw new Error("check rollup fixtureがありません");
      }
      return {
        mergeability: detail.mergeState.mergeability,
        mergeState: detail.mergeState.mergeState,
        checkState: detail.mergeState.checks.combinedState,
      };
    });
    expect(mergeSignals).toEqual([
      {
        mergeability: "mergeable",
        mergeState: "clean",
        checkState: "success",
      },
      {
        mergeability: "mergeable",
        mergeState: "blocked",
        checkState: "pending",
      },
      {
        mergeability: "mergeable",
        mergeState: "blocked",
        checkState: "failure",
      },
      {
        mergeability: "conflicting",
        mergeState: "dirty",
        checkState: "success",
      },
    ]);
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubItemDetail",
      "GitHubItemDetail",
      "GitHubItemDetail",
    ]);
  });

  it("review threadとコメントの複数ページを順序付きで収集する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_review_thread_pages", 205, "pull_request");
    const initialThreadPageCount = 19;
    const secondThreadPageCount = 100;
    const initialThreadPageCursor = "review-thread-page-2";
    const secondThreadPageCursor = "review-thread-page-3";
    const commentPageThreadId = "PRRT_page_20";
    const commentPageThread = {
      id: commentPageThreadId,
      isResolved: true,
      isOutdated: false,
      path: "src/page-2.ts",
      resolvedBy: createActor(2),
      comments: {
        nodes: [
          {
            id: "PRRC_page_2_1",
            author: createActor(20),
            body: "ページ2の1件目",
            createdAt: "2026-07-31T02:00:00Z",
            lastEditedAt: null,
            updatedAt: "2026-07-31T02:01:00Z",
            userContentEdits: null,
            url: "https://github.com/VOICEVOX/example/pull/205#discussion_r21",
          },
        ],
        pageInfo: createPageInfo(true, "review-thread-comment-page-2"),
      },
    };
    const initialThreads = Array.from({ length: initialThreadPageCount }, (_, index) => {
      const pageNumber = index + 1;
      return createReviewThread(
        `PRRT_page_${pageNumber.toString()}`,
        pageNumber % 2 === 0,
        pageNumber,
      );
    });
    const secondPageThreads = [
      commentPageThread,
      ...Array.from({ length: secondThreadPageCount - 1 }, (_, index) => {
        const pageNumber = index + initialThreadPageCount + 2;
        return createReviewThread(
          `PRRT_page_${pageNumber.toString()}`,
          pageNumber % 2 === 0,
          pageNumber,
        );
      }),
    ];
    const finalPageThreads = [createReviewThread("PRRT_page_120", false, 120)];
    expect(initialThreads).toHaveLength(initialThreadPageCount);
    expect(secondPageThreads).toHaveLength(secondThreadPageCount);
    expect(finalPageThreads).toHaveLength(1);
    const response = createPullRequestUserContentEditResponse(
      item.nodeId,
      null,
      createEmptyConnection(),
      {
        nodes: initialThreads,
        pageInfo: createPageInfo(true, initialThreadPageCursor),
      },
    );
    const threadPageCursors: string[] = [];
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      if (operation === "GitHubPullRequestReviewThreadPage") {
        expect(getStringVariable(variables, "itemId")).toBe(item.nodeId);
        const after = getStringVariable(variables, "after");
        threadPageCursors.push(after);
        if (after === initialThreadPageCursor) {
          return {
            item: {
              __typename: "PullRequest",
              id: item.nodeId,
              reviewThreads: {
                nodes: secondPageThreads,
                pageInfo: createPageInfo(true, secondThreadPageCursor),
              },
            },
          };
        }
        if (after === secondThreadPageCursor) {
          return {
            item: {
              __typename: "PullRequest",
              id: item.nodeId,
              reviewThreads: {
                nodes: finalPageThreads,
                pageInfo: createPageInfo(false, null),
              },
            },
          };
        }
        throw new Error(`未定義のreview thread page cursorです。対象: ${after}`);
      }
      if (operation === "GitHubPullRequestReviewThreadCommentPage") {
        expect(getStringVariable(variables, "threadId")).toBe(commentPageThreadId);
        expect(getStringVariable(variables, "after")).toBe("review-thread-comment-page-2");
        return {
          thread: {
            __typename: "PullRequestReviewThread",
            id: commentPageThreadId,
            comments: {
              nodes: [
                {
                  id: "PRRC_page_2_2",
                  author: createActor(21),
                  body: "ページ2の2件目",
                  createdAt: "2026-07-31T02:02:00Z",
                  lastEditedAt: null,
                  updatedAt: "2026-07-31T02:03:00Z",
                  userContentEdits: null,
                  url: "https://github.com/VOICEVOX/example/pull/205#discussion_r22",
                },
              ],
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [{ item }],
      observedAt,
      graphql: mock.graphql,
    });
    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "pull_request") {
      throw new Error("Pull Request detail fixtureではありません");
    }
    expect(detail.reviewThreads).toHaveLength(120);
    expect(detail.reviewThreads.map((thread) => thread.nodeId)).toEqual(
      Array.from({ length: 120 }, (_, index) =>
        createGitHubNodeId(`PRRT_page_${(index + 1).toString()}`),
      ),
    );
    expect(detail.reviewThreads.map((thread) => thread.sequence)).toEqual(
      Array.from({ length: 120 }, (_, index) => index),
    );
    expect(detail.reviewThreads[0]?.comments.map((comment) => comment.nodeId)).toEqual([
      createGitHubNodeId("PRRC_comment_1"),
    ]);
    const commentPageThreadDetail = detail.reviewThreads[19];
    if (commentPageThreadDetail == null) {
      throw new Error("review threadコメントページfixtureがありません");
    }
    expect(commentPageThreadDetail.nodeId).toBe(createGitHubNodeId(commentPageThreadId));
    expect(commentPageThreadDetail.comments.map((comment) => comment.nodeId)).toEqual([
      createGitHubNodeId("PRRC_page_2_1"),
      createGitHubNodeId("PRRC_page_2_2"),
    ]);
    expect(commentPageThreadDetail.comments.map((comment) => comment.sequence)).toEqual([0, 1]);
    expect(detail.reviewThreads[119]?.comments.map((comment) => comment.nodeId)).toEqual([
      createGitHubNodeId("PRRC_comment_120"),
    ]);
    expect(threadPageCursors).toEqual([initialThreadPageCursor, secondThreadPageCursor]);
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubPullRequestReviewThreadPage",
      "GitHubPullRequestReviewThreadPage",
      "GitHubPullRequestReviewThreadCommentPage",
    ]);
  });
});

describe("UserContentEdit収集", () => {
  it("本文の101件目以降を取得し、nullable値とコメントconnection nullを保持する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_user_content_edits", 200, "issue");
    const edits = Array.from({ length: 100 }, (_, index) => createUserContentEdit(index + 1));
    const firstEdit = edits[0];
    if (typeof firstEdit !== "object" || firstEdit == null) {
      throw new Error("UserContentEdit fixtureがありません");
    }
    const nullableEdit = {
      ...firstEdit,
      deletedAt: "2026-07-30T01:00:00Z",
      diff: null,
      editor: null,
    };
    edits[0] = nullableEdit;
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        return {
          item: {
            __typename: "Issue",
            id: item.nodeId,
            body: "本文",
            lastEditedAt: "2026-07-30T01:00:00Z",
            userContentEdits: {
              nodes: edits,
              pageInfo: createPageInfo(true, "body-100"),
            },
            comments: {
              nodes: [
                {
                  id: "IC_user_content_edits",
                  author: createActor(1),
                  body: "コメント",
                  createdAt: "2026-07-30T02:00:00Z",
                  lastEditedAt: null,
                  updatedAt: "2026-07-30T02:00:00Z",
                  userContentEdits: null,
                  url: "https://github.com/VOICEVOX/example/issues/200#issuecomment-1",
                },
              ],
              pageInfo: createPageInfo(false, null),
            },
            timelineItems: createEmptyConnection(),
          },
        };
      }
      if (operation === "GitHubUserContentEditPage") {
        expect(getStringVariable(variables, "contentId")).toBe(item.nodeId);
        expect(getStringVariable(variables, "after")).toBe("body-100");
        return {
          content: {
            __typename: "Issue",
            id: item.nodeId,
            userContentEdits: {
              nodes: [createUserContentEdit(101)],
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [{ item }],
      observedAt,
      graphql: mock.graphql,
    });
    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "issue") {
      throw new Error("Issue detail fixtureではありません");
    }
    if (detail.bodyUserContentEdits.availability !== "available") {
      throw new Error("本文編集履歴fixtureが利用できません");
    }
    expect(detail.bodyUserContentEdits.edits).toHaveLength(101);
    const normalizedNullableEdit = detail.bodyUserContentEdits.edits.find(
      (edit) => edit.sourceId === "github_user_content_edit:UCE_edit_1",
    );
    if (normalizedNullableEdit == null) {
      throw new Error("nullable UserContentEdit fixtureがありません");
    }
    expect(normalizedNullableEdit).toMatchObject({
      sourceId: "github_user_content_edit:UCE_edit_1",
      sequence: 0,
      deletedAt: "2026-07-30T01:00:00.000Z",
      diff: null,
      editor: {
        status: "unavailable",
        reason: "github_did_not_return_actor",
      },
    });
    const lastEdit = detail.bodyUserContentEdits.edits.find(
      (edit) => edit.sourceId === "github_user_content_edit:UCE_edit_101",
    );
    if (lastEdit == null) {
      throw new Error("末尾UserContentEdit fixtureがありません");
    }
    expect(lastEdit.sequence).toBe(100);
    const firstComment = detail.comments[0];
    if (firstComment == null) {
      throw new Error("Issue comment fixtureがありません");
    }
    expect(firstComment.userContentEdits).toEqual({
      availability: "unavailable",
      reason: "connection_null",
    });
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubUserContentEditPage",
    ]);
  });

  it("空の編集履歴connectionを利用可能な0件として保持する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_user_content_empty", 202, "issue");
    const mock = createGraphqlHttpMock((operation) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        return {
          item: {
            __typename: "Issue",
            id: item.nodeId,
            body: "本文",
            lastEditedAt: null,
            userContentEdits: {
              nodes: [],
              pageInfo: createPageInfo(false, null),
            },
            comments: createEmptyConnection(),
            timelineItems: createEmptyConnection(),
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });
    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [{ item }],
      observedAt,
      graphql: mock.graphql,
    });
    const detail = requireDetail(collection.items, 0);
    if (detail.bodyUserContentEdits.availability !== "available") {
      throw new Error("空の本文編集履歴fixtureが利用できません");
    }
    expect(detail.bodyUserContentEdits.edits).toEqual([]);
  });

  it("Issue commentの編集履歴を追加ページまで収集しlastEditedAtを保持する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "I_comment_user_content_edits", 203, "issue");
    const commentNodeId = "IC_comment_user_content_edits";
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        return {
          item: {
            __typename: "Issue",
            id: item.nodeId,
            body: "本文",
            lastEditedAt: null,
            userContentEdits: {
              nodes: [],
              pageInfo: createPageInfo(false, null),
            },
            comments: {
              nodes: [
                {
                  id: commentNodeId,
                  author: createActor(3),
                  body: "編集されたコメント",
                  createdAt: "2026-07-30T00:00:00Z",
                  lastEditedAt: "2026-07-30T00:30:00Z",
                  updatedAt: "2026-07-30T00:31:00Z",
                  userContentEdits: {
                    nodes: [createUserContentEdit(1)],
                    pageInfo: createPageInfo(true, "comment-1"),
                  },
                  url: "https://github.com/VOICEVOX/example/issues/203#issuecomment-1",
                },
              ],
              pageInfo: createPageInfo(false, null),
            },
            timelineItems: createEmptyConnection(),
          },
        };
      }
      if (operation === "GitHubUserContentEditPage") {
        expect(getStringVariable(variables, "contentId")).toBe(commentNodeId);
        expect(getStringVariable(variables, "after")).toBe("comment-1");
        return {
          content: {
            __typename: "IssueComment",
            id: commentNodeId,
            userContentEdits: {
              nodes: [createUserContentEdit(2)],
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [{ item }],
      observedAt,
      graphql: mock.graphql,
    });
    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "issue") {
      throw new Error("Issue detail fixtureではありません");
    }
    const comment = detail.comments[0];
    if (comment == null) {
      throw new Error("Issue comment fixtureがありません");
    }
    expect(comment.lastEditedAt).toBe("2026-07-30T00:30:00.000Z");
    if (comment.userContentEdits.availability !== "available") {
      throw new Error("Issue comment編集履歴fixtureが利用できません");
    }
    expect(comment.userContentEdits.edits.map((edit) => edit.sourceId)).toEqual([
      "github_user_content_edit:UCE_edit_1",
      "github_user_content_edit:UCE_edit_2",
    ]);
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubUserContentEditPage",
    ]);
  });

  it("Pull Request本文とreview commentの編集履歴を追加ページまで収集する", async () => {
    const allowlist = createAllowlist();
    const item = createItem(allowlist, "PR_user_content_edits", 204, "pull_request");
    const reviewCommentNodeId = "PRRC_user_content_edits";
    const pagedReviewCommentNodeId = "PRRC_user_content_edits_page_2";
    const reviewThreadNodeId = "PRRT_user_content_edits";
    const response = createPullRequestUserContentEditResponse(
      item.nodeId,
      {
        nodes: [createUserContentEdit(10)],
        pageInfo: createPageInfo(false, null),
      },
      createEmptyConnection(),
      {
        nodes: [
          {
            id: reviewThreadNodeId,
            isResolved: false,
            isOutdated: false,
            path: "src/example.ts",
            resolvedBy: null,
            comments: {
              nodes: [
                {
                  id: reviewCommentNodeId,
                  author: createActor(4),
                  body: "レビューコメント",
                  createdAt: "2026-07-30T01:00:00Z",
                  lastEditedAt: "2026-07-30T01:30:00Z",
                  updatedAt: "2026-07-30T01:31:00Z",
                  userContentEdits: {
                    nodes: [createUserContentEdit(11)],
                    pageInfo: createPageInfo(true, "review-comment-1"),
                  },
                  url: "https://github.com/VOICEVOX/example/pull/204#discussion_r1",
                },
              ],
              pageInfo: createPageInfo(true, "review-comment-page-1"),
            },
          },
        ],
        pageInfo: createPageInfo(false, null),
      },
    );
    const mock = createGraphqlHttpMock((operation, variables) => {
      if (operation === "GitHubItemDetailCapabilities") {
        return createCapabilitiesResponse("unavailable");
      }
      if (operation === "GitHubItemDetail") {
        return response;
      }
      if (operation === "GitHubPullRequestReviewThreadCommentPage") {
        expect(getStringVariable(variables, "threadId")).toBe(reviewThreadNodeId);
        expect(getStringVariable(variables, "after")).toBe("review-comment-page-1");
        return {
          thread: {
            __typename: "PullRequestReviewThread",
            id: reviewThreadNodeId,
            comments: {
              nodes: [
                {
                  id: pagedReviewCommentNodeId,
                  author: createActor(5),
                  body: "2件目のレビューコメント",
                  createdAt: "2026-07-30T01:10:00Z",
                  lastEditedAt: null,
                  updatedAt: "2026-07-30T01:11:00Z",
                  userContentEdits: {
                    nodes: [createUserContentEdit(13)],
                    pageInfo: createPageInfo(true, "review-comment-page-2"),
                  },
                  url: "https://github.com/VOICEVOX/example/pull/204#discussion_r2",
                },
              ],
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      if (operation === "GitHubUserContentEditPage") {
        const contentId = getStringVariable(variables, "contentId");
        const after = getStringVariable(variables, "after");
        if (contentId === reviewCommentNodeId) {
          expect(after).toBe("review-comment-1");
          return {
            content: {
              __typename: "PullRequestReviewComment",
              id: reviewCommentNodeId,
              userContentEdits: {
                nodes: [createUserContentEdit(12)],
                pageInfo: createPageInfo(false, null),
              },
            },
          };
        }
        expect(contentId).toBe(pagedReviewCommentNodeId);
        expect(after).toBe("review-comment-page-2");
        return {
          content: {
            __typename: "PullRequestReviewComment",
            id: pagedReviewCommentNodeId,
            userContentEdits: {
              nodes: [createUserContentEdit(14)],
              pageInfo: createPageInfo(false, null),
            },
          },
        };
      }
      throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
    });

    const collection = await collectGitHubItemDetails({
      allowlist,
      targets: [{ item }],
      observedAt,
      graphql: mock.graphql,
    });
    const detail = requireDetail(collection.items, 0);
    if (detail.type !== "pull_request") {
      throw new Error("Pull Request detail fixtureではありません");
    }
    expect(detail.lastEditedAt).toBe("2026-07-30T02:00:00.000Z");
    if (detail.bodyUserContentEdits.availability !== "available") {
      throw new Error("Pull Request本文編集履歴fixtureが利用できません");
    }
    expect(detail.bodyUserContentEdits.edits.map((edit) => edit.sourceId)).toEqual([
      "github_user_content_edit:UCE_edit_10",
    ]);
    const thread = detail.reviewThreads[0];
    if (thread == null) {
      throw new Error("review thread fixtureがありません");
    }
    const reviewComment = thread.comments[0];
    if (reviewComment == null) {
      throw new Error("review comment fixtureがありません");
    }
    expect(reviewComment.lastEditedAt).toBe("2026-07-30T01:30:00.000Z");
    if (reviewComment.userContentEdits.availability !== "available") {
      throw new Error("review comment編集履歴fixtureが利用できません");
    }
    expect(reviewComment.userContentEdits.edits.map((edit) => edit.sourceId)).toEqual([
      "github_user_content_edit:UCE_edit_11",
      "github_user_content_edit:UCE_edit_12",
    ]);
    expect(thread.comments.map((comment) => comment.nodeId)).toEqual([
      createGitHubNodeId(reviewCommentNodeId),
      createGitHubNodeId(pagedReviewCommentNodeId),
    ]);
    const pagedReviewComment = thread.comments[1];
    if (pagedReviewComment == null) {
      throw new Error("ページ取得review comment fixtureがありません");
    }
    if (pagedReviewComment.userContentEdits.availability !== "available") {
      throw new Error("ページ取得review comment編集履歴fixtureが利用できません");
    }
    expect(pagedReviewComment.userContentEdits.edits.map((edit) => edit.sourceId)).toEqual([
      "github_user_content_edit:UCE_edit_13",
      "github_user_content_edit:UCE_edit_14",
    ]);
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubPullRequestReviewThreadCommentPage",
      "GitHubUserContentEditPage",
      "GitHubUserContentEditPage",
    ]);
  });

  it("nodes null、cursor欠落、空の次ページをresponse errorとして拒否する", async () => {
    const cases = [
      {
        name: "重複ID",
        userContentEdits: {
          nodes: [createUserContentEdit(1), createUserContentEdit(1)],
          pageInfo: createPageInfo(false, null),
        },
        page: null,
      },
      {
        name: "nodes null",
        userContentEdits: {
          nodes: null,
          pageInfo: createPageInfo(false, null),
        },
        page: null,
      },
      {
        name: "cursor欠落",
        userContentEdits: {
          nodes: [],
          pageInfo: createPageInfo(true, null),
        },
        page: null,
      },
      {
        name: "空の次ページ",
        userContentEdits: {
          nodes: [],
          pageInfo: createPageInfo(true, "body-0"),
        },
        page: {
          content: {
            __typename: "Issue",
            id: "I_user_content_invalid",
            userContentEdits: {
              nodes: [],
              pageInfo: createPageInfo(false, null),
            },
          },
        },
      },
    ] as const;
    for (const testCase of cases) {
      const allowlist = createAllowlist();
      const item = createItem(allowlist, "I_user_content_invalid", 201, "issue");
      const mock = createGraphqlHttpMock((operation) => {
        if (operation === "GitHubItemDetailCapabilities") {
          return createCapabilitiesResponse("unavailable");
        }
        if (operation === "GitHubItemDetail") {
          return {
            item: {
              __typename: "Issue",
              id: item.nodeId,
              body: "本文",
              lastEditedAt: null,
              userContentEdits: testCase.userContentEdits,
              comments: createEmptyConnection(),
              timelineItems: createEmptyConnection(),
            },
          };
        }
        if (operation === "GitHubUserContentEditPage") {
          return testCase.page;
        }
        throw new Error(`未定義のGraphQL operationです。対象: ${operation}`);
      });
      try {
        await collectGitHubItemDetails({
          allowlist,
          targets: [{ item }],
          observedAt,
          graphql: mock.graphql,
        });
        throw new Error(`${testCase.name}のresponse errorが発生しませんでした`);
      } catch (error: unknown) {
        if (!(error instanceof GitHubItemDetailCollectionError)) {
          throw error;
        }
        expect(error.cause).toBeInstanceOf(GitHubResponseValidationError);
      }
    }
  });

  it("Pull Request review submission本文の編集履歴を取得しない", () => {
    const query = createItemDetailQuery({
      nativeDependencies: "unavailable",
      nativeHierarchy: "unavailable",
    });
    const reviewFragmentStart = query.indexOf("fragment DetailReviewFields");
    const reviewCommentFragmentStart = query.indexOf("fragment DetailReviewCommentFields");
    if (reviewFragmentStart < 0 || reviewCommentFragmentStart < 0) {
      throw new Error("review fragment fixtureがありません");
    }
    expect(query.slice(reviewFragmentStart, reviewCommentFragmentStart)).not.toContain(
      "userContentEdits",
    );
    expect(query.slice(reviewCommentFragmentStart)).toContain("userContentEdits(first: 1)");
  });
});

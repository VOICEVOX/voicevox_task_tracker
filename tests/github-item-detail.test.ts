import { generateKeyPairSync } from "node:crypto";

import { z } from "zod";
import { parse } from "graphql";
import { describe, expect, it } from "vitest";

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
  GitHubResponseSchemaValidationError,
  GitHubResponseValidationError,
  type CreateGitHubClientOptions,
  type EnumeratedGitHubItem,
  type GitHubClient,
  type GitHubItemDetail,
  type GitHubRetryRuntime,
  type PublicRepositoryAllowlist,
} from "../src/github/index.js";

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
    updatedAt: `2026-07-31T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
      index % 60,
    ).padStart(2, "0")}:00Z`,
    url: `https://github.com/VOICEVOX/example/issues/1#issuecomment-${index.toString()}`,
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
            eventWindow: Object.freeze({ mode: "initial" }),
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

  it("同じ詳細収集で項目ごとのtimeline取得窓を使う", async () => {
    const allowlist = createAllowlist();
    const fullHistoryItem = createItem(allowlist, "I_full_history", 1, "issue");
    const incrementalItem = createItem(allowlist, "I_incremental", 2, "issue");
    const since = createUtcIsoDateTime("2026-07-31T23:55:00Z");
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
          item: fullHistoryItem,
          eventWindow: Object.freeze({ mode: "initial" }),
        },
        {
          item: incrementalItem,
          eventWindow: Object.freeze({
            mode: "incremental",
            since,
          }),
        },
      ],
      observedAt,
      graphql: mock.graphql,
    });
    const detailRequests = mock.requests.filter(
      (request) => request.operation === "GitHubItemDetail",
    );
    const fullHistoryRequest = detailRequests.find(
      (request) => request.variables["itemId"] === fullHistoryItem.nodeId,
    );
    const incrementalRequest = detailRequests.find(
      (request) => request.variables["itemId"] === incrementalItem.nodeId,
    );
    if (fullHistoryRequest == null || incrementalRequest == null) {
      throw new Error("項目別timeline取得窓のGraphQL requestが不足しています");
    }

    expect(collection.items.map((item) => item.nodeId)).toEqual([
      fullHistoryItem.nodeId,
      incrementalItem.nodeId,
    ]);
    expect(fullHistoryRequest.variables).not.toHaveProperty("since");
    expect(fullHistoryRequest.query).not.toContain("$since");
    expect(incrementalRequest.variables).toMatchObject({ since });
    expect(incrementalRequest.query).toContain("$since");
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
        willCloseTarget: false,
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
          eventWindow: Object.freeze({ mode: "initial" }),
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
            return [{ kind: event.kind, relatedNodeId: event.subIssue.nodeId }];
          case "parent_issue_added":
          case "parent_issue_removed":
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
      })),
    ).toEqual([
      {
        candidateOnly: true,
        provenance: "cross_reference",
        eventSourceId: "github_timeline_event:CRE_inbound",
        sourceItemNodeId: "I_source",
        sourceItemNumber: 99,
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
      "DetailIssueCommentFields",
      "DetailIssueTimelineFields",
      "DetailPullRequestTimelineFields",
      "DetailReferencedItemFields",
      "DetailReviewCommentFields",
      "DetailReviewFields",
      "DetailReviewRequestTargetFields",
      "DetailReviewThreadFields",
    ]);
    expect(getFragmentDefinitionNames(getRequestQuery(mock.requests, 2))).toEqual([
      "DetailActorFields",
      "DetailIssueCommentFields",
    ]);
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
          eventWindow: Object.freeze({ mode: "initial" }),
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
          createdAt: `2026-07-31T1${index.toString()}:00:00Z`,
          updatedAt: `2026-07-31T1${index.toString()}:00:00Z`,
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
): unknown {
  return {
    item: {
      __typename: "PullRequest",
      id: itemNodeId,
      body: "Codex入力専用のPull Request本文",
      headRefOid: `head-${itemNodeId}`,
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
            commit: {
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
            },
          },
        ],
      },
      timelineItems: createEmptyConnection(),
    },
  };
}

describe("Pull Request詳細収集", () => {
  it("review、thread、review request履歴、head更新、merge情報を区別して返す", async () => {
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
    const baseResponse = {
      item: {
        __typename: "PullRequest",
        id: "PR_target",
        body: "Codex入力専用のPull Request本文",
        headRefOid: "new-head-sha",
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
          eventWindow: Object.freeze({ mode: "initial" }),
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
      detail.reviewRequests.current.map((request) => ({
        sourceId: request.sourceId,
        targetType: request.target.type,
        targetNodeId: request.target.nodeId,
        requestedAt: request.requestedAt,
      })),
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
      detail.reviewRequests.history.map((event) => ({
        kind: event.kind,
        target: event.target.nodeId,
        occurredAt: event.occurredAt,
      })),
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
    expect(mock.requests.map((request) => request.operation)).toEqual([
      "GitHubItemDetailCapabilities",
      "GitHubItemDetail",
      "GitHubPullRequestTimelinePage",
    ]);
    expect(getFragmentDefinitionNames(getRequestQuery(mock.requests, 2))).toEqual([
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
            eventWindow: Object.freeze({ mode: "initial" }),
          },
        ],
        observedAt,
        graphql: mock.graphql,
      }),
    ).rejects.toThrowError(GitHubResponseValidationError);
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
        eventWindow: Object.freeze({ mode: "initial" }),
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
});

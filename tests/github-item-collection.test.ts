import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubNodeId,
  type Repository,
} from "../src/domain/index.js";
import {
  GitHubApiBudgetExceededError,
  GitHubResponseValidationError,
  createGitHubBodyFingerprint,
  createPublicRepositoryAllowlist,
  deduplicateByStableId,
  enumerateGitHubItemsByIdentifiers,
  enumerateOpenGitHubItems,
  planIncrementalItemCollection,
  type CurrentAnalysisRulesFingerprints,
  type EnumeratedGitHubItem,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type PublicRepositoryAllowlist,
} from "../src/github/index.js";

type ItemType = "issue" | "pull_request";

type ItemMetadataOverrides = Readonly<{
  nodeId?: string;
  repositoryName?: string;
  type?: ItemType;
  title?: string;
  body?: string | null;
  updatedAt?: string;
  draft?: boolean;
  mergedAt?: string;
  discussion?: boolean;
  authorType?: "Bot" | "User";
}>;

type ItemMetadataFixture = Readonly<{
  node_id: string;
  html_url: string;
  number: number;
  state: "open";
  state_reason: null;
  title: string;
  body: string | null;
  user: Readonly<{
    node_id: string;
    login: string;
    type: "Bot" | "User";
  }>;
  labels: readonly (
    | string
    | Readonly<{
        name: string;
      }>
  )[];
  assignees: readonly Readonly<{
    node_id: string;
    login: string;
    type: "User";
  }>[];
  milestone: Readonly<{
    node_id: string;
    number: number;
    title: string;
    state: "open";
  }> | null;
  closed_at: null;
  created_at: string;
  updated_at: string;
  pull_request?: Readonly<{
    url: string;
    merged_at: string | null;
  }>;
  draft?: boolean;
  category?: Readonly<{
    name: string;
  }>;
}>;

const itemParametersSchema = z.object({
  owner: z.literal("VOICEVOX"),
  repo: z.string().min(1),
  state: z.literal("open"),
  sort: z.literal("created"),
  direction: z.literal("asc"),
  per_page: z.literal(100),
  page: z.number().int().positive(),
  headers: z.object({
    accept: z.literal("application/vnd.github.raw+json"),
    "x-github-api-version": z.literal("2022-11-28"),
  }),
});

const observedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const initialAnalysisRulesFingerprints = Object.freeze({
  issue: createGitHubBodyFingerprint("issue-rules-v1"),
  pull_request: createGitHubBodyFingerprint("pull-request-rules-v1"),
}) satisfies CurrentAnalysisRulesFingerprints;

function createPreviousCollectionItems(
  items: readonly EnumeratedGitHubItem[],
  analysisRulesFingerprints: CurrentAnalysisRulesFingerprints,
) {
  return new Map(
    items.map((item) => [
      item.nodeId,
      Object.freeze({
        itemFingerprint: item.itemFingerprint,
        analysisRulesFingerprint: Object.freeze({
          status: "available",
          fingerprint: analysisRulesFingerprints[item.type],
        }),
      }),
    ]),
  );
}

function createPreviousCollectionItemsWithoutAnalysisRulesFingerprint(
  items: readonly EnumeratedGitHubItem[],
) {
  return new Map(
    items.map((item) => [
      item.nodeId,
      Object.freeze({
        itemFingerprint: item.itemFingerprint,
        analysisRulesFingerprint: Object.freeze({
          status: "unavailable",
        }),
      }),
    ]),
  );
}

function createRepository(
  nodeId: string,
  name: string,
  visibility: Repository["visibility"],
): Repository {
  return {
    id: createGitHubRepositoryId(nodeId),
    owner: "VOICEVOX",
    name,
    visibility,
    archived: false,
    disabled: false,
    observedAt,
  };
}

function createAllowlist(
  repositoryNodeId: string,
  repositoryName: string,
): PublicRepositoryAllowlist {
  return createPublicRepositoryAllowlist([
    createRepository(repositoryNodeId, repositoryName, "public"),
  ]);
}

function createItemMetadata(index: number, overrides: ItemMetadataOverrides): ItemMetadataFixture {
  const repositoryName = overrides.repositoryName ?? "example";
  const type = overrides.type ?? "issue";
  const itemPath = type === "issue" ? "issues" : "pull";
  return {
    node_id: overrides.nodeId ?? `I_item_${index.toString()}`,
    html_url: `https://github.com/VOICEVOX/${repositoryName}/${itemPath}/${index.toString()}`,
    number: index,
    state: "open",
    state_reason: null,
    title: overrides.title ?? `項目${index.toString()}`,
    body: overrides.body ?? `本文${index.toString()}`,
    user: {
      node_id: `U_author_${index.toString()}`,
      login: `author-${index.toString()}`,
      type: overrides.authorType ?? "User",
    },
    labels: [{ name: "bug" }, "priority"],
    assignees: [
      {
        node_id: `U_assignee_b_${index.toString()}`,
        login: `assignee-b-${index.toString()}`,
        type: "User",
      },
      {
        node_id: `U_assignee_a_${index.toString()}`,
        login: `assignee-a-${index.toString()}`,
        type: "User",
      },
    ],
    milestone: {
      node_id: "M_v1",
      number: 1,
      title: "v1",
      state: "open",
    },
    closed_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: overrides.updatedAt ?? "2026-07-31T23:00:00Z",
    ...(type === "issue"
      ? {}
      : {
          pull_request: {
            url: `https://api.github.com/repos/VOICEVOX/${repositoryName}/pulls/${index.toString()}`,
            merged_at: overrides.mergedAt ?? null,
          },
          draft: overrides.draft ?? false,
        }),
    ...(overrides.discussion === true
      ? {
          category: {
            name: "一般",
          },
        }
      : {}),
  };
}

function splitIntoPages(
  items: readonly ItemMetadataFixture[],
): readonly (readonly ItemMetadataFixture[])[] {
  const pages: ItemMetadataFixture[][] = [];
  for (let offset = 0; offset < items.length; offset += 100) {
    pages.push(items.slice(offset, offset + 100));
  }
  if (items.length === 0 || items.length % 100 === 0) {
    pages.push([]);
  }
  return pages;
}

function createRestResponse(data: unknown, repositoryName: string): GitHubRestResponse {
  return {
    data,
    headers: {},
    status: 200,
    url: `https://api.github.test/repos/VOICEVOX/${repositoryName}/issues`,
  };
}

function createPagedRequest(
  pages: readonly (readonly ItemMetadataFixture[])[],
  requestedRoutes: string[],
  requestedPages: number[],
): GitHubRestRequest {
  return async (route, parameters): Promise<GitHubRestResponse> => {
    await Promise.resolve();
    const parsedParameters = itemParametersSchema.parse(parameters);
    requestedRoutes.push(route);
    requestedPages.push(parsedParameters.page);
    const page = pages.at(parsedParameters.page - 1);
    if (page == null) {
      throw new Error(`未定義のfixtureページです。page: ${parsedParameters.page.toString()}`);
    }
    return createRestResponse(page, parsedParameters.repo);
  };
}

async function enumerateFixture(
  repositoryNodeId: string,
  repositoryName: string,
  items: readonly ItemMetadataFixture[],
): Promise<readonly EnumeratedGitHubItem[]> {
  return enumerateOpenGitHubItems({
    allowlist: createAllowlist(repositoryNodeId, repositoryName),
    observedAt,
    request: createPagedRequest(splitIntoPages(items), [], []),
  });
}

describe("GitHub項目列挙", () => {
  it("open列挙にないclosed項目をURLから個別取得する", async () => {
    const metadata = {
      ...createItemMetadata(7, {}),
      state: "closed",
      state_reason: "completed",
      closed_at: "2026-07-31T23:30:00Z",
    };
    const requestedRoutes: string[] = [];
    const items = await enumerateGitHubItemsByIdentifiers({
      allowlist: createAllowlist("R_example", "example"),
      identifiers: [metadata.html_url],
      observedAt,
      request: async (route, parameters) => {
        await Promise.resolve();
        requestedRoutes.push(route);
        expect(parameters).toMatchObject({
          owner: "VOICEVOX",
          repo: "example",
          issue_number: 7,
        });
        return createRestResponse(metadata, "example");
      },
      graphql: () => Promise.reject(new TypeError("URL指定ではGraphQLを呼びません")),
    });

    expect(requestedRoutes).toEqual(["GET /repos/{owner}/{repo}/issues/{issue_number}"]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nodeId: "I_item_7",
      state: "closed",
      stateReason: "completed",
      closedAt: "2026-07-31T23:30:00.000Z",
    });
  });

  it("node IDをGitHub URLへ解決して同じ項目を個別取得する", async () => {
    const metadata = createItemMetadata(8, {});
    const items = await enumerateGitHubItemsByIdentifiers({
      allowlist: createAllowlist("R_example", "example"),
      identifiers: [metadata.node_id],
      observedAt,
      request: async (route) => {
        await Promise.resolve();
        expect(route).toBe("GET /repos/{owner}/{repo}/issues/{issue_number}");
        return createRestResponse(metadata, "example");
      },
      graphql: (query, variables) => {
        expect(query).toContain("query GitHubItemIdentifier");
        expect(variables).toEqual({ itemId: metadata.node_id });
        return Promise.resolve({
          node: {
            __typename: "Issue",
            id: metadata.node_id,
            url: metadata.html_url,
          },
        });
      },
    });

    expect(items.map((item) => item.nodeId)).toEqual([metadata.node_id]);
  });

  it("100件を超えるopen項目をrepo単位で最終ページまで取得する", async () => {
    const metadata = Array.from({ length: 205 }, (_, index) => createItemMetadata(index + 1, {}));
    const requestedRoutes: string[] = [];
    const requestedPages: number[] = [];

    const items = await enumerateOpenGitHubItems({
      allowlist: createAllowlist("R_example", "example"),
      observedAt,
      request: createPagedRequest(splitIntoPages(metadata), requestedRoutes, requestedPages),
    });

    expect(items).toHaveLength(205);
    expect(items.at(0)?.nodeId).toBe("I_item_1");
    expect(items.at(-1)?.nodeId).toBe("I_item_205");
    expect(requestedPages).toEqual([1, 2, 3]);
    expect(new Set(requestedRoutes)).toEqual(new Set(["GET /repos/{owner}/{repo}/issues"]));
  });

  it("REST issues応答内のIssueとPull Requestをmarkerで分類して二重計上しない", async () => {
    const requestedRoutes: string[] = [];
    const items = await enumerateOpenGitHubItems({
      allowlist: createAllowlist("R_example", "example"),
      observedAt,
      request: createPagedRequest(
        [
          [
            createItemMetadata(1, {}),
            createItemMetadata(2, {
              type: "pull_request",
              draft: true,
            }),
          ],
        ],
        requestedRoutes,
        [],
      ),
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.type)).toEqual(["issue", "pull_request"]);
    expect(items[0]).toMatchObject({
      type: "issue",
      draft: "not_applicable",
    });
    expect(items[1]).toMatchObject({
      type: "pull_request",
      draft: true,
      mergeStatus: "not_merged",
    });
    expect(requestedRoutes).toEqual(["GET /repos/{owner}/{repo}/issues"]);
  });

  it("個別取得したmerge済みPull Requestの状態を正規化する", async () => {
    const mergedAt = "2026-07-31T23:30:00Z";
    const metadata = {
      ...createItemMetadata(9, {
        type: "pull_request",
        mergedAt,
      }),
      state: "closed",
      state_reason: "completed",
      closed_at: mergedAt,
    };
    const items = await enumerateGitHubItemsByIdentifiers({
      allowlist: createAllowlist("R_example", "example"),
      identifiers: [metadata.html_url],
      observedAt,
      request: () => Promise.resolve(createRestResponse(metadata, "example")),
      graphql: () => Promise.reject(new TypeError("URL指定ではGraphQLを呼びません")),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "pull_request",
      state: "closed",
      mergeStatus: "merged",
      mergedAt: "2026-07-31T23:30:00.000Z",
    });
  });

  it("openなmerge済みPull Request応答を拒否する", async () => {
    await expect(
      enumerateFixture("R_example", "example", [
        createItemMetadata(10, {
          type: "pull_request",
          mergedAt: "2026-07-31T23:30:00Z",
        }),
      ]),
    ).rejects.toBeInstanceOf(GitHubResponseValidationError);
  });

  it("Discussion markerが混入した応答をfail closedで拒否する", async () => {
    await expect(
      enumerateFixture("R_example", "example", [
        createItemMetadata(1, {
          discussion: true,
        }),
      ]),
    ).rejects.toBeInstanceOf(GitHubResponseValidationError);
  });

  it("公開allowlist外のリポジトリへ項目APIを呼ばない", async () => {
    const allowlist = createPublicRepositoryAllowlist([
      createRepository("R_public", "public-repository", "public"),
      createRepository("R_private", "private-sentinel", "private"),
    ]);
    const requestedRepositories: string[] = [];
    const request: GitHubRestRequest = async (route, parameters) => {
      await Promise.resolve();
      expect(route).toBe("GET /repos/{owner}/{repo}/issues");
      const parsedParameters = itemParametersSchema.parse(parameters);
      requestedRepositories.push(parsedParameters.repo);
      return createRestResponse([], parsedParameters.repo);
    };

    const items = await enumerateOpenGitHubItems({
      allowlist,
      observedAt,
      request,
    });

    expect(items).toEqual([]);
    expect(requestedRepositories).toEqual(["public-repository"]);
  });

  it("本文を保持せず基本メタデータと再取得locatorを正規化する", async () => {
    const body = "後段で必要になる本文";
    const items = await enumerateFixture("R_example", "example", [
      createItemMetadata(42, {
        body,
      }),
    ]);
    const item = items[0];
    if (item == null) {
      throw new Error("item fixtureがありません");
    }

    expect(item).toMatchObject({
      nodeId: "I_item_42",
      repositoryId: "R_example",
      displayReference: "VOICEVOX/example#42",
      number: 42,
      url: "https://github.com/VOICEVOX/example/issues/42",
      type: "issue",
      title: "項目42",
      bodyFingerprint: createGitHubBodyFingerprint(body),
      bodyLocator: {
        kind: "github_item_body",
        repositoryId: "R_example",
        itemNodeId: "I_item_42",
        number: 42,
      },
      author: {
        kind: "account",
        account: {
          nodeId: "U_author_42",
          login: "author-42",
        },
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-31T23:00:00.000Z",
      state: "open",
      stateReason: null,
      closedAt: null,
      draft: "not_applicable",
      assignees: [
        {
          nodeId: "U_assignee_a_42",
          login: "assignee-a-42",
        },
        {
          nodeId: "U_assignee_b_42",
          login: "assignee-b-42",
        },
      ],
      labels: ["bug", "priority"],
      milestone: {
        nodeId: "M_v1",
        number: 1,
        title: "v1",
        state: "open",
      },
      observedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(item).not.toHaveProperty("body");
    expect(JSON.stringify(item)).not.toContain(body);
    expect(item.itemFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("本文が1文字変わるとfingerprintが変わる", () => {
    expect(createGitHubBodyFingerprint("本文A")).not.toBe(createGitHubBodyFingerprint("本文B"));
    expect(createGitHubBodyFingerprint("")).not.toBe(createGitHubBodyFingerprint(null));
  });

  it("GitHub APIのBot型を作成者メタデータへ保持する", async () => {
    const items = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {
        authorType: "Bot",
      }),
    ]);
    const item = items[0];
    if (item?.author.kind !== "account") {
      throw new Error("Bot作成者fixtureがありません");
    }

    expect(item.author.account.apiType).toBe("Bot");
  });

  it("rate limitの安全余裕到達時に部分的な列挙結果を返さず停止する", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => createItemMetadata(index + 1, {}));
    const requestedPages: number[] = [];
    const budgetError = new GitHubApiBudgetExceededError({
      source: "rest",
      limit: 100,
      remaining: 30,
      resetAt: "2026-08-01T01:00:00.000Z",
      observedAt: "2026-08-01T00:00:00.000Z",
      resource: "core",
    });
    const request: GitHubRestRequest = async (route, parameters) => {
      await Promise.resolve();
      expect(route).toBe("GET /repos/{owner}/{repo}/issues");
      const parsedParameters = itemParametersSchema.parse(parameters);
      requestedPages.push(parsedParameters.page);
      if (parsedParameters.page === 1) {
        return createRestResponse(firstPage, parsedParameters.repo);
      }
      throw budgetError;
    };

    await expect(
      enumerateOpenGitHubItems({
        allowlist: createAllowlist("R_example", "example"),
        observedAt,
        request,
      }),
    ).rejects.toBe(budgetError);
    expect(requestedPages).toEqual([1, 2]);
  });
});

describe("増分項目収集", () => {
  it("1000項目中の変更10件と与えられた隣接nodeだけを詳細取得対象にする", async () => {
    const previousMetadata = Array.from({ length: 1000 }, (_, index) =>
      createItemMetadata(index + 1, {}),
    );
    const currentMetadata = previousMetadata.map((item, index) =>
      (index + 1) % 100 === 0
        ? createItemMetadata(index + 1, {
            title: `${item.title}更新`,
            updatedAt: "2026-08-01T00:01:00Z",
          })
        : item,
    );
    const previousItems = await enumerateFixture("R_example", "example", previousMetadata);
    const currentItems = await enumerateFixture("R_example", "example", currentMetadata);
    const adjacentItemNodeIds = new Set<GitHubNodeId>([
      createGitHubNodeId("I_item_100"),
      createGitHubNodeId("I_adjacent_a"),
      createGitHubNodeId("I_adjacent_b"),
    ]);

    const plan = planIncrementalItemCollection({
      items: currentItems,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(previousItems, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set(previousItems.map((item) => item.nodeId)),
      currentAnalysisRulesFingerprints: initialAnalysisRulesFingerprints,
      adjacentItemNodeIds,
      overlapMilliseconds: 300_000,
    });

    expect(plan.mode).toBe("incremental");
    if (plan.mode !== "incremental") {
      throw new Error("incremental plan fixtureではありません");
    }
    expect(plan.since).toBe("2026-07-31T23:55:00.000Z");
    expect(plan.changedItemNodeIds).toHaveLength(10);
    expect(plan.detailTargets).toHaveLength(12);
    expect(new Set(plan.detailTargets.map((target) => target.nodeId))).toEqual(
      new Set([
        ...plan.changedItemNodeIds,
        createGitHubNodeId("I_adjacent_a"),
        createGitHubNodeId("I_adjacent_b"),
      ]),
    );
    expect(plan.detailTargets.map((target) => target.nodeId)).not.toContain("I_item_1");
    expect(
      plan.detailTargets
        .filter((target) => target.eventWindow.mode === "incremental")
        .every(
          (target) =>
            target.eventWindow.mode === "incremental" && target.eventWindow.since === plan.since,
        ),
    ).toBe(true);
    expect(
      plan.detailTargets
        .filter((target) => target.eventWindow.mode === "initial")
        .map((target) => target.nodeId),
    ).toEqual([createGitHubNodeId("I_adjacent_a"), createGitHubNodeId("I_adjacent_b")]);
  });

  it("repository rename後もnode IDが同じ項目を別項目へ分裂させない", async () => {
    const previousItems = await enumerateFixture("R_repository", "old-name", [
      createItemMetadata(1, {
        nodeId: "I_stable",
        repositoryName: "old-name",
      }),
    ]);
    const currentItems = await enumerateFixture("R_repository", "new-name", [
      createItemMetadata(1, {
        nodeId: "I_stable",
        repositoryName: "new-name",
      }),
    ]);
    const previousItem = previousItems[0];
    const currentItem = currentItems[0];
    if (previousItem == null || currentItem == null) {
      throw new Error("rename fixtureが不足しています");
    }

    const plan = planIncrementalItemCollection({
      items: currentItems,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(previousItems, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set(previousItems.map((item) => item.nodeId)),
      currentAnalysisRulesFingerprints: initialAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set(),
      overlapMilliseconds: 300_000,
    });

    expect(previousItem.nodeId).toBe(currentItem.nodeId);
    expect(previousItem.itemFingerprint).toBe(currentItem.itemFingerprint);
    expect(previousItem.displayReference).toBe("VOICEVOX/old-name#1");
    expect(currentItem.displayReference).toBe("VOICEVOX/new-name#1");
    expect(plan.changedItemNodeIds).toEqual([]);
    expect(plan.detailTargets).toEqual([]);
    expect(plan.currentItemFingerprints).toHaveLength(1);
  });

  it("item fingerprintが同じでも判定規則fingerprintが変われば全履歴取得対象にする", async () => {
    const items = await enumerateFixture("R_example", "example", [createItemMetadata(1, {})]);
    const item = items[0];
    if (item == null) {
      throw new Error("判定規則変更fixtureが不足しています");
    }
    const changedAnalysisRulesFingerprints = Object.freeze({
      ...initialAnalysisRulesFingerprints,
      issue: createGitHubBodyFingerprint("issue-rules-v2"),
    }) satisfies CurrentAnalysisRulesFingerprints;

    const plan = planIncrementalItemCollection({
      items,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(items, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set(items.map((item) => item.nodeId)),
      currentAnalysisRulesFingerprints: changedAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set(),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual([item.nodeId]);
    expect(plan.detailTargets).toEqual([
      {
        nodeId: item.nodeId,
        eventWindow: {
          mode: "initial",
        },
      },
    ]);
  });

  it("判定規則変更項目とupdated_at変更項目へ異なるtimeline取得窓を割り当てる", async () => {
    const previousItems = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {}),
      createItemMetadata(2, {
        type: "pull_request",
      }),
      createItemMetadata(3, {
        type: "pull_request",
      }),
    ]);
    const currentItems = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {}),
      createItemMetadata(2, {
        type: "pull_request",
        title: "更新されたPull Request",
        updatedAt: "2026-08-01T00:01:00Z",
      }),
      createItemMetadata(3, {
        type: "pull_request",
      }),
    ]);
    const rulesChangedIssue = currentItems[0];
    const updatedPullRequest = currentItems[1];
    const adjacentPullRequest = currentItems[2];
    if (rulesChangedIssue == null || updatedPullRequest == null || adjacentPullRequest == null) {
      throw new Error("取得窓混在fixtureが不足しています");
    }
    const changedAnalysisRulesFingerprints = Object.freeze({
      ...initialAnalysisRulesFingerprints,
      issue: createGitHubBodyFingerprint("issue-rules-v2"),
    }) satisfies CurrentAnalysisRulesFingerprints;

    const plan = planIncrementalItemCollection({
      items: currentItems,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(previousItems, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set(previousItems.map((item) => item.nodeId)),
      currentAnalysisRulesFingerprints: changedAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set([adjacentPullRequest.nodeId]),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual([rulesChangedIssue.nodeId, updatedPullRequest.nodeId]);
    expect(plan.detailTargets).toEqual([
      {
        nodeId: rulesChangedIssue.nodeId,
        eventWindow: {
          mode: "initial",
        },
      },
      {
        nodeId: updatedPullRequest.nodeId,
        eventWindow: {
          mode: "incremental",
          since: "2026-07-31T23:55:00.000Z",
        },
      },
      {
        nodeId: adjacentPullRequest.nodeId,
        eventWindow: {
          mode: "incremental",
          since: "2026-07-31T23:55:00.000Z",
        },
      },
    ]);
  });

  it("前回未判定の更新項目と前回enumerationにない項目を全履歴取得対象にする", async () => {
    const previousItems = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {}),
    ]);
    const currentItems = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {
        title: "初回判定前の更新項目",
        updatedAt: "2026-08-01T00:01:00Z",
      }),
      createItemMetadata(2, {
        updatedAt: "2026-08-01T00:01:00Z",
      }),
    ]);

    const plan = planIncrementalItemCollection({
      items: currentItems,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(previousItems, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set(),
      currentAnalysisRulesFingerprints: initialAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set(),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual(currentItems.map((item) => item.nodeId));
    expect(plan.detailTargets).toEqual(
      currentItems.map((item) => ({
        nodeId: item.nodeId,
        eventWindow: {
          mode: "initial",
        },
      })),
    );
  });

  it("隣接項目は前回判定済みなら増分、未判定なら全履歴で取得する", async () => {
    const items = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {}),
      createItemMetadata(2, {}),
    ]);
    const analyzedItem = items[0];
    const unanalyzedItem = items[1];
    if (analyzedItem == null || unanalyzedItem == null) {
      throw new Error("隣接項目取得窓fixtureが不足しています");
    }

    const plan = planIncrementalItemCollection({
      items,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(items, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set([analyzedItem.nodeId]),
      currentAnalysisRulesFingerprints: initialAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set([analyzedItem.nodeId, unanalyzedItem.nodeId]),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual([]);
    expect(plan.detailTargets).toEqual([
      {
        nodeId: analyzedItem.nodeId,
        eventWindow: {
          mode: "incremental",
          since: "2026-07-31T23:55:00.000Z",
        },
      },
      {
        nodeId: unanalyzedItem.nodeId,
        eventWindow: {
          mode: "initial",
        },
      },
    ]);
  });

  it("Issue規則だけが変わったときPull Requestを詳細取得対象にしない", async () => {
    const items = await enumerateFixture("R_example", "example", [
      createItemMetadata(1, {}),
      createItemMetadata(2, {
        type: "pull_request",
      }),
    ]);
    const issue = items.find((item) => item.type === "issue");
    const pullRequest = items.find((item) => item.type === "pull_request");
    if (issue == null || pullRequest == null) {
      throw new Error("種別別判定規則fixtureが不足しています");
    }
    const changedAnalysisRulesFingerprints = Object.freeze({
      ...initialAnalysisRulesFingerprints,
      issue: createGitHubBodyFingerprint("issue-rules-v2"),
    }) satisfies CurrentAnalysisRulesFingerprints;

    const plan = planIncrementalItemCollection({
      items,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItems(items, initialAnalysisRulesFingerprints),
      },
      previouslyAnalyzedItemNodeIds: new Set(items.map((item) => item.nodeId)),
      currentAnalysisRulesFingerprints: changedAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set(),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual([issue.nodeId]);
    expect(plan.detailTargets.map((target) => target.nodeId)).toEqual([issue.nodeId]);
    expect(plan.detailTargets.map((target) => target.nodeId)).not.toContain(pullRequest.nodeId);
  });

  it("前回判定済みでない項目は判定規則fingerprintが未保持でも詳細取得対象にしない", async () => {
    const items = await enumerateFixture("R_example", "example", [createItemMetadata(1, {})]);
    const item = items[0];
    if (item == null) {
      throw new Error("前回未判定fixtureが不足しています");
    }

    const plan = planIncrementalItemCollection({
      items,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItemsWithoutAnalysisRulesFingerprint(items),
      },
      previouslyAnalyzedItemNodeIds: new Set(),
      currentAnalysisRulesFingerprints: initialAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set(),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual([]);
    expect(plan.detailTargets).toEqual([]);
  });

  it("前回判定済みの項目は判定規則fingerprintが未保持なら詳細取得対象にする", async () => {
    const items = await enumerateFixture("R_example", "example", [createItemMetadata(1, {})]);
    const item = items[0];
    if (item == null) {
      throw new Error("前回判定済みfixtureが不足しています");
    }

    const plan = planIncrementalItemCollection({
      items,
      previous: {
        status: "successful",
        completedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        items: createPreviousCollectionItemsWithoutAnalysisRulesFingerprint(items),
      },
      previouslyAnalyzedItemNodeIds: new Set([item.nodeId]),
      currentAnalysisRulesFingerprints: initialAnalysisRulesFingerprints,
      adjacentItemNodeIds: new Set(),
      overlapMilliseconds: 300_000,
    });

    expect(plan.changedItemNodeIds).toEqual([item.nodeId]);
    expect(plan.detailTargets).toEqual([
      {
        nodeId: item.nodeId,
        eventWindow: {
          mode: "initial",
        },
      },
    ]);
  });
});

describe("overlap重複排除", () => {
  it("同じevent IDがoverlap範囲へ2回現れても1件に畳み込む", () => {
    const events = [
      {
        eventId: "E_event_1",
        observedAt: "2026-07-31T23:59:00Z",
      },
      {
        eventId: "E_event_2",
        observedAt: "2026-08-01T00:00:00Z",
      },
      {
        eventId: "E_event_1",
        observedAt: "2026-08-01T00:01:00Z",
      },
    ];

    const deduplicated = deduplicateByStableId(events, (event) => event.eventId);

    expect(deduplicated).toEqual([
      {
        eventId: "E_event_1",
        observedAt: "2026-08-01T00:01:00Z",
      },
      {
        eventId: "E_event_2",
        observedAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });
});

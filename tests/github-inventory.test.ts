import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createUtcIsoDateTime, type GitHubRepositoryId } from "../src/domain/index.js";
import {
  GitHubPublicBoundaryViolationError,
  GitHubRepositoryStaleFallbackUnavailableError,
  GitHubResponseValidationError,
  GitHubRetryExhaustedError,
  assertPublicRepositoryBoundary,
  collectRepositoriesWithStaleFallback,
  createPublicRepositoryAllowlist,
  discoverRepositoryInventory,
  type GitHubRestRequest,
  type GitHubRestResponse,
  type PreviousRepositoryValue,
  type PublicRepositoryId,
} from "../src/github/index.js";

type RepositoryMetadataOverrides = Readonly<{
  nodeId?: string;
  owner?: string;
  name?: string;
  visibility?: "public" | "private" | "internal";
  archived?: boolean;
  disabled?: boolean;
}>;

type RepositoryMetadataFixture = Readonly<{
  node_id: string;
  owner: Readonly<{
    login: string;
  }>;
  name: string;
  visibility: "public" | "private" | "internal";
  archived: boolean;
  disabled: boolean;
  description: string;
  issues_url: string;
}>;

const inventoryParametersSchema = z.object({
  org: z.literal("VOICEVOX"),
  type: z.literal("all"),
  sort: z.literal("full_name"),
  direction: z.literal("asc"),
  per_page: z.literal(100),
  page: z.number().int().positive(),
});

const observedAt = createUtcIsoDateTime("2026-07-31T23:00:00Z");

function createRepositoryMetadata(
  index: number,
  overrides: RepositoryMetadataOverrides,
): RepositoryMetadataFixture {
  const name = overrides.name ?? `repository-${index.toString()}`;
  return {
    node_id: overrides.nodeId ?? `R_repository_${index.toString()}`,
    owner: {
      login: overrides.owner ?? "VOICEVOX",
    },
    name,
    visibility: overrides.visibility ?? "public",
    archived: overrides.archived ?? false,
    disabled: overrides.disabled ?? false,
    description: "インベントリ結果へ保持しない説明",
    issues_url: `https://api.github.test/repos/VOICEVOX/${name}/issues{/number}`,
  };
}

function createRestResponse(
  data: unknown,
  headers: Readonly<Record<string, string | number | undefined>>,
): GitHubRestResponse {
  return {
    data,
    headers,
    status: 200,
    url: "https://api.github.test/orgs/VOICEVOX/repos",
  };
}

function createPagedRequest(
  pages: readonly (readonly unknown[])[],
  requestedPages: number[],
): GitHubRestRequest {
  return async (route, parameters): Promise<GitHubRestResponse> => {
    await Promise.resolve();
    expect(route).toBe("GET /orgs/{org}/repos");
    const parsedParameters = inventoryParametersSchema.parse(parameters);
    requestedPages.push(parsedParameters.page);
    const page = pages.at(parsedParameters.page - 1);
    if (page == null) {
      throw new Error(`未定義のfixtureページです。page: ${parsedParameters.page.toString()}`);
    }
    return createRestResponse(page, {});
  };
}

async function discoverFromPages(
  pages: readonly (readonly unknown[])[],
  requestedPages: number[],
): Promise<Awaited<ReturnType<typeof discoverRepositoryInventory>>> {
  return discoverRepositoryInventory({
    organization: "VOICEVOX",
    observedAt,
    request: createPagedRequest(pages, requestedPages),
  });
}

describe("リポジトリインベントリ", () => {
  it("100件を超えるOrganization repositoryを最終ページまで取得する", async () => {
    const repositories = Array.from({ length: 105 }, (_, index) =>
      createRepositoryMetadata(index + 1, {}),
    );
    const requestedPages: number[] = [];

    const inventory = await discoverFromPages(
      [repositories.slice(0, 100), repositories.slice(100)],
      requestedPages,
    );

    expect(inventory).toHaveLength(105);
    expect(inventory.at(0)).toEqual({
      id: "R_repository_1",
      owner: "VOICEVOX",
      name: "repository-1",
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: "2026-07-31T23:00:00.000Z",
    });
    expect(inventory.at(-1)?.id).toBe("R_repository_105");
    expect(inventory.at(0)).not.toHaveProperty("description");
    expect(inventory.at(0)).not.toHaveProperty("issues_url");
    expect(requestedPages).toEqual([1, 2]);
    expect(Object.isFrozen(inventory)).toBe(true);
  });

  it("途中ページの取得失敗では部分インベントリを返さない", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      createRepositoryMetadata(index + 1, {}),
    );
    const failure = new GitHubRetryExhaustedError(503, 4, {
      cause: new Error("一時的な取得失敗"),
    });
    const requestedPages: number[] = [];
    const request: GitHubRestRequest = async (route, parameters) => {
      await Promise.resolve();
      expect(route).toBe("GET /orgs/{org}/repos");
      const parsedParameters = inventoryParametersSchema.parse(parameters);
      requestedPages.push(parsedParameters.page);
      if (parsedParameters.page === 1) {
        return createRestResponse(firstPage, {});
      }
      throw failure;
    };

    await expect(
      discoverRepositoryInventory({
        organization: "VOICEVOX",
        observedAt,
        request,
      }),
    ).rejects.toBe(failure);
    expect(requestedPages).toEqual([1, 2]);
  });

  it("必須metadataが欠けたレスポンスをfail closedで拒否する", async () => {
    const metadata = createRepositoryMetadata(1, {});
    const invalidMetadata = {
      node_id: metadata.node_id,
      owner: metadata.owner,
      name: metadata.name,
      visibility: metadata.visibility,
      archived: metadata.archived,
    };

    await expect(discoverFromPages([[invalidMetadata]], [])).rejects.toBeInstanceOf(
      GitHubResponseValidationError,
    );
  });
});

describe("公開リポジトリallowlist", () => {
  it("private、internal、archived、disabledをmetadata取得直後に除外する", async () => {
    const requestedPages: number[] = [];
    const inventory = await discoverFromPages(
      [
        [
          createRepositoryMetadata(1, { name: "public-active" }),
          createRepositoryMetadata(2, {
            name: "private-sentinel",
            visibility: "private",
          }),
          createRepositoryMetadata(3, {
            name: "internal-sentinel",
            visibility: "internal",
          }),
          createRepositoryMetadata(4, {
            name: "archived-public",
            archived: true,
          }),
          createRepositoryMetadata(5, {
            name: "disabled-public",
            disabled: true,
          }),
        ],
      ],
      requestedPages,
    );

    const allowlist = createPublicRepositoryAllowlist(inventory);

    expect(allowlist.repositories.map((repository) => repository.name)).toEqual(["public-active"]);
    expect(requestedPages).toEqual([1]);
  });

  it("allowlist外リポジトリの解決を実行時に拒否する", async () => {
    const inventory = await discoverFromPages(
      [
        [
          createRepositoryMetadata(1, { name: "public-active" }),
          createRepositoryMetadata(2, {
            name: "private-sentinel",
            visibility: "private",
          }),
        ],
      ],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);
    const publicRepositoryId = inventory[0]?.id;
    const privateRepositoryId = inventory[1]?.id;
    if (publicRepositoryId == null || privateRepositoryId == null) {
      throw new Error("repository fixtureが不足しています");
    }

    expect(() => allowlist.require(privateRepositoryId)).toThrow(
      GitHubPublicBoundaryViolationError,
    );
    expect(allowlist.require(publicRepositoryId).id).toBe("R_repository_1");
  });

  it("公開リポジトリIDを一般のrepository IDと型で区別する", () => {
    expectTypeOf<PublicRepositoryId>().toExtend<GitHubRepositoryId>();
    expectTypeOf<GitHubRepositoryId>().not.toExtend<PublicRepositoryId>();
  });

  it("作成後に追加や削除ができる構造を公開しない", async () => {
    const inventory = await discoverFromPages(
      [[createRepositoryMetadata(1, { name: "public-active" })]],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);
    const repository = allowlist.repositories[0];
    if (repository == null) {
      throw new Error("public repository fixtureがありません");
    }

    expect(Object.isFrozen(allowlist)).toBe(true);
    expect(Object.isFrozen(allowlist.repositories)).toBe(true);
    expect(Object.isFrozen(repository)).toBe(true);
    expect(Reflect.get(allowlist, "add")).toBeUndefined();
    expect(Reflect.get(allowlist, "delete")).toBeUndefined();
    expect(Reflect.set(allowlist.repositories, 0, repository)).toBe(false);
  });

  it("次回実行時に新しいpublicリポジトリを設定変更なしで追加する", async () => {
    const firstInventory = await discoverFromPages(
      [[createRepositoryMetadata(1, { name: "existing-public" })]],
      [],
    );
    const secondInventory = await discoverFromPages(
      [
        [
          createRepositoryMetadata(1, { name: "existing-public" }),
          createRepositoryMetadata(2, { name: "new-public" }),
        ],
      ],
      [],
    );

    const firstAllowlist = createPublicRepositoryAllowlist(firstInventory);
    const secondAllowlist = createPublicRepositoryAllowlist(secondInventory);

    expect(firstAllowlist.repositories.map((repository) => repository.name)).toEqual([
      "existing-public",
    ]);
    expect(secondAllowlist.repositories.map((repository) => repository.name)).toEqual([
      "existing-public",
      "new-public",
    ]);
  });
});

describe("公開境界guard", () => {
  it.each(["state直列化直前", "Pages DTO生成直前", "Discord payload生成直前"])(
    "%sのprivate sentinelを独立に検出する",
    async () => {
      const inventory = await discoverFromPages(
        [
          [
            createRepositoryMetadata(1, { name: "public-active" }),
            createRepositoryMetadata(2, {
              nodeId: "R_private_sentinel_do_not_publish",
              name: "private-sentinel",
              visibility: "private",
            }),
          ],
        ],
        [],
      );
      const allowlist = createPublicRepositoryAllowlist(inventory);
      const repositoryIds = new Set(inventory.map((repository) => repository.id));

      expect(() => {
        assertPublicRepositoryBoundary(allowlist, repositoryIds);
      }).toThrow(GitHubPublicBoundaryViolationError);
    },
  );

  it("違反したprivate repository IDをエラー文字列へ含めない", async () => {
    const privateSentinelId = "R_private_sentinel_do_not_publish";
    const inventory = await discoverFromPages(
      [
        [
          createRepositoryMetadata(1, { name: "public-active" }),
          createRepositoryMetadata(2, {
            nodeId: privateSentinelId,
            name: "private-sentinel",
            visibility: "private",
          }),
        ],
      ],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);
    const repositoryIds = new Set(inventory.map((repository) => repository.id));

    try {
      assertPublicRepositoryBoundary(allowlist, repositoryIds);
      throw new Error("公開境界違反が検出されませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubPublicBoundaryViolationError)) {
        throw error;
      }
      expect(error.details.violationCount).toBe(1);
      expect(error.details).toEqual({
        scope: "generic",
        violationKind: "repository_set_not_allowlisted",
        violationCount: 1,
      });
      expect(error.message).not.toContain(privateSentinelId);
    }
  });

  it("allowlist内のID集合を許可する", async () => {
    const inventory = await discoverFromPages(
      [[createRepositoryMetadata(1, { name: "public-active" })]],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);
    const repositoryIds: ReadonlySet<GitHubRepositoryId> = new Set(
      inventory.map((repository) => repository.id),
    );

    expect(() => {
      assertPublicRepositoryBoundary(allowlist, repositoryIds);
      expectTypeOf(repositoryIds).toExtend<ReadonlySet<PublicRepositoryId>>();
    }).not.toThrow();
  });
});

describe("リポジトリ単位のstale処理", () => {
  it("1リポジトリの503だけを前回値付きstaleとして扱い全体を継続する", async () => {
    const inventory = await discoverFromPages(
      [
        [
          createRepositoryMetadata(1, { name: "fresh-before" }),
          createRepositoryMetadata(2, { name: "temporarily-unavailable" }),
          createRepositoryMetadata(3, { name: "fresh-after" }),
        ],
      ],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);
    const lastSuccessfulAt = createUtcIsoDateTime("2026-07-30T23:00:00Z");
    const previousValues = new Map<GitHubRepositoryId, PreviousRepositoryValue<readonly string[]>>(
      inventory.map((repository) => [
        repository.id,
        {
          value: Object.freeze([`previous:${repository.name}`]),
          observedAt: lastSuccessfulAt,
        },
      ]),
    );
    const collectedRepositories: string[] = [];

    const results = await collectRepositoriesWithStaleFallback({
      allowlist,
      observedAt,
      previousValues,
      collect: async (repository): Promise<readonly string[]> => {
        await Promise.resolve();
        collectedRepositories.push(repository.name);
        if (repository.name === "temporarily-unavailable") {
          throw new GitHubRetryExhaustedError(503, 4, {
            cause: new Error("一時的な取得失敗"),
          });
        }
        return Object.freeze([`current:${repository.name}`]);
      },
    });

    expect(collectedRepositories).toEqual([
      "fresh-before",
      "temporarily-unavailable",
      "fresh-after",
    ]);
    expect(results.map((result) => result.freshness)).toEqual(["fresh", "stale", "fresh"]);
    const staleResult = results[1];
    if (staleResult?.freshness !== "stale") {
      throw new Error("stale result fixtureがありません");
    }
    expect(staleResult.previousValue).toEqual(["previous:temporarily-unavailable"]);
    expect(staleResult.lastSuccessfulAt).toBe("2026-07-30T23:00:00.000Z");
    expect(staleResult.failedAt).toBe("2026-07-31T23:00:00.000Z");
    expect(staleResult.diagnostic.code).toBe("github_repository_temporarily_unavailable");
    expect(staleResult).not.toHaveProperty("value");
    expect(staleResult).not.toHaveProperty("observedAt");
    expect(results[2]).toMatchObject({
      freshness: "fresh",
      value: ["current:fresh-after"],
    });
  });

  it("前回値がないリポジトリの503では全体を失敗させる", async () => {
    const inventory = await discoverFromPages(
      [[createRepositoryMetadata(1, { name: "no-previous-value" })]],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);

    await expect(
      collectRepositoriesWithStaleFallback({
        allowlist,
        observedAt,
        previousValues: new Map(),
        collect: async () => {
          await Promise.resolve();
          throw new GitHubRetryExhaustedError(503, 4, {
            cause: new Error("一時的な取得失敗"),
          });
        },
      }),
    ).rejects.toBeInstanceOf(GitHubRepositoryStaleFallbackUnavailableError);
  });

  it("恒久エラーをstaleへ読み替えずに伝播する", async () => {
    const inventory = await discoverFromPages(
      [[createRepositoryMetadata(1, { name: "permanent-failure" })]],
      [],
    );
    const allowlist = createPublicRepositoryAllowlist(inventory);
    const failure = new Error("恒久的な取得失敗");
    const repositoryId = inventory[0]?.id;
    if (repositoryId == null) {
      throw new Error("repository fixtureがありません");
    }

    await expect(
      collectRepositoriesWithStaleFallback({
        allowlist,
        observedAt,
        previousValues: new Map([
          [
            repositoryId,
            {
              value: Object.freeze(["previous"]),
              observedAt: createUtcIsoDateTime("2026-07-30T23:00:00Z"),
            },
          ],
        ]),
        collect: async () => {
          await Promise.resolve();
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });
});

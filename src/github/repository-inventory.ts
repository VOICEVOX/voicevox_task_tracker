import { z } from "zod";

import { createGitHubRepositoryId, type Repository, type UtcIsoDateTime } from "../domain/index.js";
import { type GitHubRestRequest } from "./client.js";
import { GitHubRepositoryInventoryError, GitHubResponseValidationError } from "./errors.js";

const REPOSITORIES_PER_PAGE = 100;

const repositoryMetadataSchema = z
  .object({
    node_id: z.string().min(1).regex(/^\S+$/u),
    owner: z
      .object({
        login: z.string().min(1),
      })
      .loose(),
    name: z.string().min(1),
    visibility: z.enum(["public", "private", "internal"]),
    archived: z.boolean(),
    disabled: z.boolean(),
  })
  .loose();

const repositoryPageSchema = z.array(repositoryMetadataSchema).max(REPOSITORIES_PER_PAGE);

export type DiscoverRepositoryInventoryOptions = Readonly<{
  organization: string;
  observedAt: UtcIsoDateTime;
  request: GitHubRestRequest;
}>;

function getLinkHeader(
  headers: Readonly<Record<string, string | number | undefined>>,
  page: number,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "link") {
      continue;
    }
    if (value == null) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new GitHubResponseValidationError(
        `Organization repository inventory page ${page.toString()} Link header`,
        {
          cause: new TypeError("Link headerが文字列ではありません"),
        },
      );
    }
    return value;
  }
  return undefined;
}

function hasNextPage(linkHeader: string): boolean {
  return linkHeader.split(",").some((link) => /;\s*rel="next"(?:\s*;|$)/u.test(link.trim()));
}

function shouldRequestNextPage(pageLength: number, linkHeader: string | undefined): boolean {
  if (linkHeader != null) {
    return hasNextPage(linkHeader);
  }
  return pageLength === REPOSITORIES_PER_PAGE;
}

function parseRepositoryPage(
  data: unknown,
  observedAt: UtcIsoDateTime,
  page: number,
): readonly Repository[] {
  const result = repositoryPageSchema.safeParse(data);
  if (!result.success) {
    throw new GitHubResponseValidationError(
      `Organization repository inventory page ${page.toString()}`,
      {
        cause: new TypeError("repository metadataの形式が不正です"),
      },
    );
  }

  return result.data.map((repository) =>
    Object.freeze({
      id: createGitHubRepositoryId(repository.node_id),
      owner: repository.owner.login,
      name: repository.name,
      visibility: repository.visibility,
      archived: repository.archived,
      disabled: repository.disabled,
      observedAt,
    } satisfies Repository),
  );
}

function assertUniqueRepositories(repositories: readonly Repository[]): void {
  const repositoryIds = new Set<string>();
  const repositoryNames = new Set<string>();

  for (const repository of repositories) {
    const normalizedName = `${repository.owner}/${repository.name}`.toLowerCase();
    if (repositoryIds.has(repository.id) || repositoryNames.has(normalizedName)) {
      throw new GitHubRepositoryInventoryError({
        cause: new TypeError("リポジトリがインベントリ内で重複しています"),
      });
    }
    repositoryIds.add(repository.id);
    repositoryNames.add(normalizedName);
  }
}

/** Organizationの全リポジトリメタデータをページネーションして取得する。 */
export async function discoverRepositoryInventory(
  options: DiscoverRepositoryInventoryOptions,
): Promise<readonly Repository[]> {
  const repositories: Repository[] = [];

  for (let page = 1; ; page += 1) {
    const response = await options.request("GET /orgs/{org}/repos", {
      org: options.organization,
      type: "all",
      sort: "full_name",
      direction: "asc",
      per_page: REPOSITORIES_PER_PAGE,
      page,
    });
    if (response.status !== 200) {
      throw new GitHubResponseValidationError(
        `Organization repository inventory page ${page.toString()}`,
        {
          cause: new TypeError("成功以外のHTTP statusを受け取りました"),
        },
      );
    }

    const pageRepositories = parseRepositoryPage(response.data, options.observedAt, page);
    repositories.push(...pageRepositories);

    const linkHeader = getLinkHeader(response.headers, page);
    if (!shouldRequestNextPage(pageRepositories.length, linkHeader)) {
      break;
    }
    if (pageRepositories.length === 0) {
      throw new GitHubResponseValidationError(
        `Organization repository inventory page ${page.toString()}`,
        {
          cause: new TypeError("空のページに次ページへのLinkが指定されています"),
        },
      );
    }
    if (page === Number.MAX_SAFE_INTEGER) {
      throw new GitHubRepositoryInventoryError({
        cause: new RangeError("ページ番号が安全な整数の上限へ到達しました"),
      });
    }
  }

  assertUniqueRepositories(repositories);
  return Object.freeze(repositories);
}

/** 指定repositoryの現在の公開状態をGitHubから取得する。 */
export async function collectRepositoryMetadata(
  repositoryFullNames: readonly string[],
  observedAt: UtcIsoDateTime,
  request: GitHubRestRequest,
): Promise<readonly Repository[]> {
  const repositories: Repository[] = [];
  for (const fullName of repositoryFullNames) {
    const [owner, repo, extra] = fullName.split("/");
    if (owner == null || repo == null || extra != null || owner.length === 0 || repo.length === 0) {
      throw new TypeError("repository metadata取得対象の名前が不正です");
    }
    const response = await request("GET /repos/{owner}/{repo}", { owner, repo });
    if (response.status !== 200) {
      throw new GitHubResponseValidationError("repository metadata", {
        cause: new TypeError("成功以外のHTTP statusを受け取りました"),
      });
    }
    const repository = repositoryMetadataSchema.parse(response.data);
    if (`${repository.owner.login}/${repository.name}`.toLowerCase() !== fullName.toLowerCase()) {
      throw new GitHubResponseValidationError("repository metadata", {
        cause: new TypeError("取得したrepositoryが要求と一致しません"),
      });
    }
    repositories.push(
      Object.freeze({
        id: createGitHubRepositoryId(repository.node_id),
        owner: repository.owner.login,
        name: repository.name,
        visibility: repository.visibility,
        archived: repository.archived,
        disabled: repository.disabled,
        observedAt,
      }),
    );
  }
  assertUniqueRepositories(repositories);
  return Object.freeze(repositories);
}

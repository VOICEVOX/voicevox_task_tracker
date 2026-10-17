import { z } from "zod";

import type { GitHubRestRequest } from "./client.js";
import { GitHubResponseSchemaValidationError, GitHubResponseValidationError } from "./errors.js";
import type { PublicRepository } from "./public-repository-allowlist.js";

const COMMITS_PER_PAGE = 100;

const comparisonPageSchema = z.object({
  base_commit: z.object({ sha: z.string().min(1).regex(/^\S+$/u) }),
  total_commits: z.number().int().nonnegative(),
  commits: z.array(z.object({ sha: z.string().min(1).regex(/^\S+$/u) })).max(COMMITS_PER_PAGE),
});

function comparisonError(context: string, reason: string): GitHubResponseValidationError {
  return new GitHubResponseValidationError(context, { cause: new TypeError(reason) });
}

function nextPageFromLink(
  headers: Readonly<Record<string, string | number | undefined>>,
  context: string,
): boolean | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "link") continue;
    if (value == null) return undefined;
    if (typeof value !== "string") {
      throw comparisonError(context, "REST compareのLink headerが文字列ではありません");
    }
    return value.split(",").some((link) => /;\s*rel="next"(?:\s*;|$)/u.test(link.trim()));
  }
  return undefined;
}

/** 公開Pull Requestの固定baseとheadについてREST compareのcommit SHAを全ページ取得する。 */
export async function collectPullRequestComparisonShas(
  repository: PublicRepository,
  baseSha: string,
  headSha: string,
  totalCount: number,
  request: GitHubRestRequest,
  context: string,
): Promise<readonly string[]> {
  const commits: string[] = [];
  const seenShas = new Set<string>();
  for (let page = 1; commits.length < totalCount; page += 1) {
    const pageContext = `${context} REST compare page ${page.toString()}`;
    const response = await request("GET /repos/{owner}/{repo}/compare/{base}...{head}", {
      owner: repository.owner,
      repo: repository.name,
      base: baseSha,
      head: headSha,
      per_page: COMMITS_PER_PAGE,
      page,
    });
    if (response.status !== 200) {
      throw comparisonError(pageContext, "REST compareが成功以外のHTTP statusを返しました");
    }
    const parsed = comparisonPageSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new GitHubResponseSchemaValidationError(pageContext, parsed.error);
    }
    const comparison = parsed.data;
    if (comparison.base_commit.sha !== baseSha || comparison.total_commits !== totalCount) {
      throw comparisonError(
        pageContext,
        "REST compareのbaseまたは総件数がPull Requestと一致しません",
      );
    }
    if (
      comparison.commits.length === 0 ||
      commits.length + comparison.commits.length > totalCount ||
      (commits.length + comparison.commits.length < totalCount &&
        comparison.commits.length !== COMMITS_PER_PAGE)
    ) {
      throw comparisonError(pageContext, "REST compareのcommitページ件数が不正です");
    }
    for (const commit of comparison.commits) {
      if (seenShas.has(commit.sha)) {
        throw comparisonError(pageContext, "REST compareのcommit SHAが重複しています");
      }
      seenShas.add(commit.sha);
      commits.push(commit.sha);
    }
    const hasNextPage = nextPageFromLink(response.headers, pageContext);
    if (hasNextPage === true && commits.length === totalCount) {
      throw comparisonError(pageContext, "REST compareに余分な次ページがあります");
    }
    if (hasNextPage === false && commits.length < totalCount) {
      throw comparisonError(pageContext, "REST compareが総件数に達する前に終了しました");
    }
    if (page === Number.MAX_SAFE_INTEGER && commits.length < totalCount) {
      throw comparisonError(pageContext, "REST compareのページ番号が安全な整数の上限に達しました");
    }
  }
  if (commits[commits.length - 1] !== headSha) {
    throw comparisonError(context, "REST compareの末尾がPull Requestのheadと一致しません");
  }
  return Object.freeze(commits);
}

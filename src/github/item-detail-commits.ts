import { z } from "zod";

import type { GitHubRestRequest } from "./client.js";
import { GitHubResponseValidationError } from "./errors.js";
import { collectPullRequestComparisonShas } from "./item-detail-commit-compare.js";
import {
  assertNoDuplicateNodeIds,
  parseGraphqlResponse,
  requireConnectionCursor,
  requireGraphqlNode,
} from "./item-detail-connection.js";
import {
  PULL_REQUEST_COMMIT_PAGE_QUERY,
  PULL_REQUEST_COMMIT_STABILITY_QUERY,
  PULL_REQUEST_MISSING_COMMIT_QUERY,
} from "./item-detail-pagination-queries.js";
import type {
  basePullRequestSchema,
  commitSchema,
  Graphql,
} from "./item-detail-response-schema.js";
import {
  pullRequestCommitPageResponseSchema,
  pullRequestCommitStabilityResponseSchema,
  pullRequestMissingCommitResponseSchema,
} from "./item-detail-response-schema.js";
import { normalizeCommit } from "./item-detail-timeline.js";
import type { GitHubItemDetail } from "./item-detail-types.js";
import type { EnumeratedGitHubItem } from "./item-enumeration.js";
import type { PublicRepository } from "./public-repository-allowlist.js";

const GRAPHQL_COMMIT_CONNECTION_LIMIT = 250;

type Commit = z.output<typeof commitSchema>;
type CommitMembership = Extract<GitHubItemDetail, { type: "pull_request" }>["commitMembership"];
type CommitConnectionIdentity = Readonly<{
  baseRefOid: string;
  headRefOid: string;
  commits: Readonly<{ totalCount: number }>;
}>;

function membershipError(context: string, reason: string): GitHubResponseValidationError {
  return new GitHubResponseValidationError(context, { cause: new TypeError(reason) });
}

function assertCommitConnectionStable(
  current: CommitConnectionIdentity,
  original: CommitConnectionIdentity,
  context: string,
): void {
  if (
    current.baseRefOid !== original.baseRefOid ||
    current.headRefOid !== original.headRefOid ||
    current.commits.totalCount !== original.commits.totalCount
  ) {
    throw membershipError(context, "commit所属のbase、headまたは件数が途中で変化しました");
  }
}

async function restoreMissingCommits(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
  pullRequest: z.output<typeof basePullRequestSchema>,
  visibleCommits: readonly Commit[],
  graphql: Graphql,
  request: GitHubRestRequest,
  context: string,
): Promise<Commit[]> {
  const totalCount = pullRequest.commits.totalCount;
  console.warn(
    `GitHub GraphQLのcommit所属が${GRAPHQL_COMMIT_CONNECTION_LIMIT.toString()}件で終端しました。REST compareで全件を照合します。対象: ${item.displayReference}`,
  );
  const comparisonShas = await collectPullRequestComparisonShas(
    repository,
    pullRequest.baseRefOid,
    pullRequest.headRefOid,
    totalCount,
    request,
    context,
  );
  const missingCount = totalCount - visibleCommits.length;
  for (let index = 0; index < visibleCommits.length; index += 1) {
    if (comparisonShas[missingCount + index] !== visibleCommits[index]?.oid) {
      throw membershipError(context, "REST compareとGraphQLのcommit順序が一致しません");
    }
  }
  const missingCommits: Commit[] = [];
  for (const oid of comparisonShas.slice(0, missingCount)) {
    const response = await graphql(PULL_REQUEST_MISSING_COMMIT_QUERY, {
      itemId: item.nodeId,
      commitOid: oid,
    });
    const parsed = parseGraphqlResponse(pullRequestMissingCommitResponseSchema, response, context);
    const current = requireGraphqlNode(parsed.item, item.nodeId, (node) => node.id, context);
    assertCommitConnectionStable(current, pullRequest, context);
    const commit = current.repository.object;
    if (commit?.oid !== oid) {
      throw membershipError(context, "REST compareのcommitをGraphQL objectで確認できません");
    }
    missingCommits.push(commit);
  }
  return [...missingCommits, ...visibleCommits];
}

/** Pull Requestの全commit所属をheadと件数の安定を確認して取得する。 */
export async function collectPullRequestCommitMembership(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
  pullRequest: z.output<typeof basePullRequestSchema>,
  graphql: Graphql,
  request: GitHubRestRequest,
): Promise<CommitMembership> {
  const context = `${item.displayReference} commits`;
  const headSha = pullRequest.headRefOid;
  const totalCount = pullRequest.commits.totalCount;
  let commits = [...pullRequest.commits.nodes.map((node) => node.commit)];
  const seenCursors = new Set<string>();
  let pageInfo = pullRequest.commits.pageInfo;
  for (;;) {
    const cursor = requireConnectionCursor(pageInfo, context);
    if (cursor == null) break;
    if (seenCursors.has(cursor))
      throw membershipError(context, "commit pageのcursorが重複しています");
    seenCursors.add(cursor);
    const response = await graphql(PULL_REQUEST_COMMIT_PAGE_QUERY, {
      itemId: item.nodeId,
      after: cursor,
    });
    const parsed = parseGraphqlResponse(pullRequestCommitPageResponseSchema, response, context);
    const page = requireGraphqlNode(parsed.item, item.nodeId, (node) => node.id, context);
    assertCommitConnectionStable(page, pullRequest, context);
    if (page.commits.nodes.length === 0) {
      throw membershipError(context, "次ページとして空のcommits connectionを受け取りました");
    }
    commits.push(...page.commits.nodes.map((node) => node.commit));
    pageInfo = page.commits.pageInfo;
  }
  assertNoDuplicateNodeIds(
    commits.map((commit) => commit.id),
    context,
  );
  if (commits.length > 0 && commits[commits.length - 1]?.oid !== headSha) {
    throw membershipError(context, "commit所属の末尾がPull Requestのheadと一致しません");
  }
  // GraphQLが250件で終端し総件数が残る場合だけRESTで全件を照合し、制限が解消すれば通常経路へ戻す。
  if (commits.length === GRAPHQL_COMMIT_CONNECTION_LIMIT && totalCount > commits.length) {
    commits = await restoreMissingCommits(
      item,
      repository,
      pullRequest,
      commits,
      graphql,
      request,
      context,
    );
  }
  if (commits.length !== totalCount) {
    throw membershipError(context, "commit所属の取得件数がGitHubの件数と一致しません");
  }
  assertNoDuplicateNodeIds(
    commits.map((commit) => commit.id),
    context,
  );
  const stabilityResponse = await graphql(PULL_REQUEST_COMMIT_STABILITY_QUERY, {
    itemId: item.nodeId,
  });
  const stability = parseGraphqlResponse(
    pullRequestCommitStabilityResponseSchema,
    stabilityResponse,
    context,
  );
  const stableItem = requireGraphqlNode(stability.item, item.nodeId, (node) => node.id, context);
  assertCommitConnectionStable(stableItem, pullRequest, context);
  return Object.freeze({
    headSha,
    totalCount,
    commits: Object.freeze(commits.map((commit) => normalizeCommit(item.nodeId, commit))),
  });
}

import { z } from "zod";

import { GitHubResponseValidationError } from "./errors.js";
import {
  assertNoDuplicateNodeIds,
  parseGraphqlResponse,
  requireConnectionCursor,
  requireGraphqlNode,
} from "./item-detail-connection.js";
import {
  PULL_REQUEST_COMMIT_PAGE_QUERY,
  PULL_REQUEST_COMMIT_STABILITY_QUERY,
} from "./item-detail-pagination-queries.js";
import type { basePullRequestSchema, Graphql } from "./item-detail-response-schema.js";
import {
  pullRequestCommitPageResponseSchema,
  pullRequestCommitStabilityResponseSchema,
} from "./item-detail-response-schema.js";
import { normalizeCommit } from "./item-detail-timeline.js";
import type { GitHubItemDetail } from "./item-detail-types.js";
import type { EnumeratedGitHubItem } from "./item-enumeration.js";

type CommitMembership = Extract<GitHubItemDetail, { type: "pull_request" }>["commitMembership"];

function membershipError(context: string, reason: string): GitHubResponseValidationError {
  return new GitHubResponseValidationError(context, { cause: new TypeError(reason) });
}

/** Pull Requestの全commit所属をheadと件数の安定を確認して取得する。 */
export async function collectPullRequestCommitMembership(
  item: EnumeratedGitHubItem,
  pullRequest: z.output<typeof basePullRequestSchema>,
  graphql: Graphql,
): Promise<CommitMembership> {
  const context = `${item.displayReference} commits`;
  const headSha = pullRequest.headRefOid;
  const totalCount = pullRequest.commits.totalCount;
  const commits = [...pullRequest.commits.nodes.map((node) => node.commit)];
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
    if (page.headRefOid !== headSha || page.commits.totalCount !== totalCount) {
      throw membershipError(context, "commit pageのheadまたは件数が途中で変化しました");
    }
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
  if (commits.length !== totalCount) {
    throw membershipError(context, "commit所属の取得件数がGitHubの件数と一致しません");
  }
  if (commits.length > 0 && commits[commits.length - 1]?.oid !== headSha) {
    throw membershipError(context, "commit所属の末尾がPull Requestのheadと一致しません");
  }
  const stabilityResponse = await graphql(PULL_REQUEST_COMMIT_STABILITY_QUERY, {
    itemId: item.nodeId,
  });
  const stability = parseGraphqlResponse(
    pullRequestCommitStabilityResponseSchema,
    stabilityResponse,
    context,
  );
  const stableItem = requireGraphqlNode(stability.item, item.nodeId, (node) => node.id, context);
  if (stableItem.headRefOid !== headSha || stableItem.commits.totalCount !== totalCount) {
    throw membershipError(context, "commit所属の取得中にheadまたは件数が変化しました");
  }
  return Object.freeze({
    headSha,
    totalCount,
    commits: Object.freeze(commits.map((commit) => normalizeCommit(item.nodeId, commit))),
  });
}

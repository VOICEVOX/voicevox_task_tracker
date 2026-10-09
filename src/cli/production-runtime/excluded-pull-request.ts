import type { PublicRepository } from "../../github/index.js";
import type { PublicGitHubRelationItem, RelationCandidateNode } from "../../graph/index.js";

// VOICEVOX/voicevox PR #3137はHTTP 404を確認した実行だけ追跡対象から除外する。
// 正常に取得できたら、この例外とIssue #3118の初回再収集・AI cache迂回を削除する。
// https://github.com/VOICEVOX/voicevox/pull/3137
export const excludedPullRequest = Object.freeze({
  owner: "VOICEVOX",
  repository: "voicevox",
  number: 3137,
  nodeId: "PR_kwDOFz6vG88AAAABGwBrIQ",
});
export const excludedPullRequestUrl = `https://github.com/${excludedPullRequest.owner}/${excludedPullRequest.repository}/pull/${excludedPullRequest.number.toString()}`;
export const affectedIssueNodeId = "I_kwDOFz6vG88AAAABSEQjNg";

/** 対象Pull Requestのnode IDか判定する。 */
export function isExcludedPullRequestNodeId(nodeId: string): boolean {
  return nodeId === excludedPullRequest.nodeId;
}

/** 対象Pull Requestの取得識別子か判定する。 */
export function isExcludedPullRequestIdentifier(identifier: string): boolean {
  return (
    isExcludedPullRequestNodeId(identifier) ||
    identifier.toLowerCase() === excludedPullRequestUrl.toLowerCase()
  );
}

/** 対象Pull Requestの項目か判定する。 */
export function isExcludedPullRequestItem(
  item: Readonly<{ type: "issue" | "pull_request"; number: number }>,
  repository: Pick<PublicRepository, "owner" | "name">,
): boolean {
  return (
    item.type === "pull_request" &&
    item.number === excludedPullRequest.number &&
    repository.owner.toLowerCase() === excludedPullRequest.owner.toLowerCase() &&
    repository.name.toLowerCase() === excludedPullRequest.repository.toLowerCase()
  );
}

/** 対象Pull Requestの関係参照か判定する。 */
export function isExcludedPullRequestRelationItem(item: PublicGitHubRelationItem): boolean {
  return isExcludedPullRequestItem(item, {
    owner: item.repositoryOwner,
    name: item.repositoryName,
  });
}

/** 対象Pull Requestの関係端点か判定する。 */
export function isExcludedPullRequestRelationNode(node: RelationCandidateNode): boolean {
  return isExcludedPullRequestItem(
    {
      type: node.scope === "organization" ? node.kind : node.githubItemType,
      number: node.number,
    },
    { owner: node.repositoryOwner, name: node.repositoryName },
  );
}

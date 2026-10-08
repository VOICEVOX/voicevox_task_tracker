import type { GitHubNodeId } from "../../domain/index.js";
import type { PublicRepository } from "../../github/index.js";
import type { PublicGitHubRelationItem, RelationCandidateNode } from "../../graph/index.js";

// VOICEVOX/voicevox PR #3137はHTTP 404を確認した実行だけ追跡対象から除外する。
// 正常に取得できたら起動を止め、この例外を削除する。
// https://github.com/VOICEVOX/voicevox/pull/3137
export const excludedPullRequest = Object.freeze({
  owner: "VOICEVOX",
  repository: "voicevox",
  number: 3137,
  nodeId: "PR_kwDOFz6vG88AAAABGwBrIQ",
});
export const excludedPullRequestUrl = `https://github.com/${excludedPullRequest.owner}/${excludedPullRequest.repository}/pull/${excludedPullRequest.number.toString()}`;

/** 対象Pull Requestのnode IDか判定する。 */
export function isExcludedPullRequestNodeId(nodeId: string): boolean {
  return nodeId === excludedPullRequest.nodeId;
}

/** 対象Pull Requestの取得識別子か判定する。 */
export function isExcludedPullRequestIdentifier(identifier: string): boolean {
  return (
    identifier === excludedPullRequest.nodeId ||
    identifier.toLowerCase() === excludedPullRequestUrl.toLowerCase()
  );
}

/** 対象Pull Requestのsource IDか判定する。 */
export function isExcludedPullRequestSourceId(sourceId: string): boolean {
  return sourceId.split(":").includes(excludedPullRequest.nodeId);
}

/** 対象Pull Requestの構造参照が含まれるか判定する。 */
export function referencesExcludedPullRequest(
  value: unknown,
  removedRelationIds: ReadonlySet<string>,
  removedSourceIds: ReadonlySet<string>,
): boolean {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry: unknown) =>
      referencesExcludedPullRequest(entry, removedRelationIds, removedSourceIds),
    );
  }
  if (
    "kind" in value &&
    "candidateId" in value &&
    value.kind === "item" &&
    value.candidateId === excludedPullRequest.nodeId
  ) {
    return true;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      if (
        ((key === "nodeId" ||
          key === "itemNodeId" ||
          key === "fromNodeId" ||
          key === "toNodeId" ||
          key === "githubNodeId") &&
          isExcludedPullRequestNodeId(entry)) ||
        ((key === "sourceId" || key === "latestMeaningfulSourceId") &&
          (isExcludedPullRequestSourceId(entry) || removedSourceIds.has(entry))) ||
        (key === "url" && isExcludedPullRequestIdentifier(entry)) ||
        (key === "relationId" && removedRelationIds.has(entry))
      ) {
        return true;
      }
      continue;
    }
    if (Array.isArray(entry)) {
      if (
        ((key === "sourceIds" || key === "evidenceSourceIds") &&
          entry.some(
            (sourceId: unknown) =>
              typeof sourceId === "string" &&
              (isExcludedPullRequestSourceId(sourceId) || removedSourceIds.has(sourceId)),
          )) ||
        ((key === "nodeIds" || key === "endpointNodeIds") &&
          entry.some(
            (nodeId: unknown) => typeof nodeId === "string" && isExcludedPullRequestNodeId(nodeId),
          )) ||
        (key === "relationIds" &&
          entry.some(
            (relationId: unknown) =>
              typeof relationId === "string" && removedRelationIds.has(relationId),
          ))
      ) {
        return true;
      }
    }
    if (referencesExcludedPullRequest(entry, removedRelationIds, removedSourceIds)) {
      return true;
    }
  }
  return false;
}

/** 対象Pull Requestのsourceに依存する値か判定する。 */
export function referencesExcludedPullRequestSource(value: unknown): boolean {
  return referencesExcludedPullRequest(value, new Set<string>(), new Set<string>());
}

/** 対象Pull Requestの列挙項目か判定する。 */
export function isExcludedPullRequestItem(
  item: Readonly<{
    nodeId: GitHubNodeId;
    type: "issue" | "pull_request";
    number: number;
    url: string;
  }>,
  repository: Pick<PublicRepository, "owner" | "name">,
): boolean {
  return (
    item.type === "pull_request" &&
    repository.owner.toLowerCase() === excludedPullRequest.owner.toLowerCase() &&
    repository.name.toLowerCase() === excludedPullRequest.repository.toLowerCase() &&
    (isExcludedPullRequestNodeId(item.nodeId) ||
      item.number === excludedPullRequest.number ||
      isExcludedPullRequestIdentifier(item.url))
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
  if (node.scope === "organization") {
    return (
      node.kind === "pull_request" &&
      isExcludedPullRequestItem(
        { nodeId: node.nodeId, type: node.kind, number: node.number, url: node.url },
        { owner: node.repositoryOwner, name: node.repositoryName },
      )
    );
  }
  return (
    node.githubItemType === "pull_request" &&
    isExcludedPullRequestItem(
      {
        nodeId: node.githubNodeId,
        type: node.githubItemType,
        number: node.number,
        url: node.url,
      },
      { owner: node.repositoryOwner, name: node.repositoryName },
    )
  );
}

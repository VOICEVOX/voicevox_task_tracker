import type { StateSnapshot } from "../../../persistence/index.js";
import type { CollectedItems, RuntimeState } from "../contracts.js";
import { affectedIssueNodeId, excludedPullRequest } from "../excluded-pull-request.js";

/** 除外対象を保存せず、初回には接続していたIssueをfreshな収集から復元したことを確認する。 */
export function assertExcludedPullRequestSavedSnapshot(
  state: RuntimeState,
  collection: CollectedItems,
  snapshot: StateSnapshot,
): void {
  if (
    snapshot.items.some((item) => item.nodeId === excludedPullRequest.nodeId) ||
    snapshot.collection.repositories.some((repository) =>
      repository.items.some((item) => item.nodeId === excludedPullRequest.nodeId),
    ) ||
    snapshot.relations.some(
      (relation) =>
        relation.fromNodeId === excludedPullRequest.nodeId ||
        relation.toNodeId === excludedPullRequest.nodeId,
    )
  ) {
    throw new TypeError("除外対象のPull Requestが保存予定stateに残っています");
  }
  if (
    state.rawSnapshot.status !== "available" ||
    !state.rawSnapshot.snapshot.items.some((item) => item.nodeId === excludedPullRequest.nodeId)
  ) {
    return;
  }
  const repository = collection.repositoryResults.find(
    (result) =>
      result.repository.owner.toLowerCase() === excludedPullRequest.owner.toLowerCase() &&
      result.repository.name.toLowerCase() === excludedPullRequest.repository.toLowerCase(),
  );
  if (
    repository?.freshness !== "fresh" ||
    !snapshot.items.some((item) => item.nodeId === affectedIssueNodeId) ||
    !snapshot.collection.repositories.some(
      (collected) =>
        collected.repositoryId === repository.repository.id &&
        collected.items.some((item) => item.nodeId === affectedIssueNodeId),
    )
  ) {
    throw new TypeError("除外対象に接続していたIssueをfreshな収集から復元できませんでした");
  }
}

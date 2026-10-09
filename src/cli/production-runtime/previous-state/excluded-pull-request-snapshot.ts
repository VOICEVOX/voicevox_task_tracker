import {
  assertPersonalReminderEvidenceClosure,
  createStateSnapshot,
  type StateSnapshot,
} from "../../../persistence/index.js";
import { affectedIssueNodeId, excludedPullRequest } from "../excluded-pull-request.js";

/** 消失したPull Requestを含む前回stateを初回再収集用に正常化する。 */
export function projectExcludedPullRequestSnapshot(snapshot: StateSnapshot): StateSnapshot {
  if (!snapshot.items.some((item) => item.nodeId === excludedPullRequest.nodeId)) {
    return snapshot;
  }
  const removedNodeIds = new Set([excludedPullRequest.nodeId, affectedIssueNodeId]);
  const projected = createStateSnapshot({
    ...snapshot,
    collection: {
      repositories: snapshot.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.filter((item) => !removedNodeIds.has(item.nodeId)),
      })),
    },
    items: snapshot.items.filter((item) => !removedNodeIds.has(item.nodeId)),
    graphNodeStateObservations: snapshot.graphNodeStateObservations.filter(
      (observation) => !removedNodeIds.has(observation.nodeId),
    ),
    relations: snapshot.relations.filter(
      (relation) =>
        !removedNodeIds.has(relation.fromNodeId) && !removedNodeIds.has(relation.toNodeId),
    ),
  });
  assertPersonalReminderEvidenceClosure(projected);
  return projected;
}

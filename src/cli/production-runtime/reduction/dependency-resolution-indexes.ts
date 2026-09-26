import type { GitHubNodeId, GraphNodeId, SourceId, UtcIsoDateTime } from "../../../domain/index.js";
import type { EnumeratedGitHubItem, FreshObservedGitHubItem } from "../../../github/index.js";
import type {
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateAssessment,
} from "../../../graph/index.js";
import {
  snapshotEffectiveGraphStateByNodeId,
  type SnapshotGraphNodeStateObservation,
} from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { CollectedItems, GraphResult, RuntimeState } from "../contracts.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import type {
  ActiveRelation,
  DependencyResolutionIndexes,
  DependencyResolutionStaticIndexes,
  PreviousBlockerEdgesByTargetNodeId,
  RelationProgressEvent,
} from "./dependency-resolution-contracts.js";
import { relationProgressKey } from "./dependency-resolution-keys.js";
import { createDependencySourceOccurredAtById } from "./dependency-resolution-time.js";

type EnumeratedTerminal = Readonly<{
  state: "closed" | "merged";
  occurredAt: UtcIsoDateTime;
}>;

/** GitHub項目の確定した終端状態を返す。 */
export function enumeratedTerminal(
  item: EnumeratedGitHubItem | undefined,
): EnumeratedTerminal | undefined {
  if (item == null) {
    return undefined;
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return Object.freeze({
      state: "merged",
      occurredAt: item.mergedAt,
    });
  }
  if (item.state === "closed") {
    return Object.freeze({
      state: "closed",
      occurredAt: item.closedAt,
    });
  }
  return undefined;
}

/** GitHub項目の確定した終端時刻を返す。 */
export function enumeratedTerminalAt(
  item: EnumeratedGitHubItem | undefined,
): UtcIsoDateTime | undefined {
  const terminal = enumeratedTerminal(item);
  return terminal == null ? undefined : terminal.occurredAt;
}

function previousBlockerEdgesByTargetNodeId(
  state: RuntimeState,
): PreviousBlockerEdgesByTargetNodeId {
  const snapshot = previousSnapshot(state);
  assertNonNullable(snapshot, "newly unblocked項目の前回snapshotがありません");
  const previousStateByNodeId = snapshotEffectiveGraphStateByNodeId(snapshot);
  const edgesByTargetNodeId = new Map<GraphNodeId, Map<GraphNodeId, ActiveRelation[]>>();
  for (const edge of snapshot.relations) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      previousStateByNodeId.get(edge.fromNodeId) !== "open"
    ) {
      continue;
    }
    const edgesByBlockerNodeId = edgesByTargetNodeId.get(edge.toNodeId);
    if (edgesByBlockerNodeId == null) {
      edgesByTargetNodeId.set(edge.toNodeId, new Map([[edge.fromNodeId, [edge]]]));
      continue;
    }
    const edges = edgesByBlockerNodeId.get(edge.fromNodeId);
    if (edges == null) {
      edgesByBlockerNodeId.set(edge.fromNodeId, [edge]);
      continue;
    }
    edges.push(edge);
  }
  return edgesByTargetNodeId;
}

function relationProgressEventKey(event: RelationProgressEvent): string {
  if (event.target.type !== "node") {
    throw new TypeError(
      `relation progress eventのtargetがnodeではありません。対象: ${event.sourceId}`,
    );
  }
  const fromNodeId = event.direction === "from_item" ? event.itemNodeId : event.target.nodeId;
  const toNodeId = event.direction === "from_item" ? event.target.nodeId : event.itemNodeId;
  return relationProgressKey(event.relationType, event.provenance, fromNodeId, toNodeId);
}

/** 依存解消に使う固定索引を作る。 */
export function createDependencyResolutionStaticIndexes(
  state: RuntimeState,
  collection: CollectedItems,
  graph: GraphResult,
): DependencyResolutionStaticIndexes {
  const previousSnapshotValue = previousSnapshot(state);
  assertNonNullable(previousSnapshotValue, "newly unblocked項目の前回snapshotがありません");
  const previousObservedAtByNodeId = new Map<GitHubNodeId, UtcIsoDateTime>(
    previousSnapshotValue.items.map((item): [GitHubNodeId, UtcIsoDateTime] => [
      item.nodeId,
      item.observedAt,
    ]),
  );
  const previousEffectiveStateByNodeId = snapshotEffectiveGraphStateByNodeId(previousSnapshotValue);
  const enumeratedItemsByNodeId = new Map<GraphNodeId, EnumeratedGitHubItem>();
  for (const item of collection.enumeratedItems) {
    if (enumeratedItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`enumerated item ${item.nodeId}が重複しています`);
    }
    enumeratedItemsByNodeId.set(item.nodeId, item);
  }
  const observedItemsByNodeId = new Map<GraphNodeId, FreshObservedGitHubItem>();
  for (const item of collection.observedItems) {
    if (observedItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`observed item ${item.nodeId}が重複しています`);
    }
    observedItemsByNodeId.set(item.nodeId, item);
  }
  const currentNativeStateObservationsByNodeId = new Map<
    GraphNodeId,
    SnapshotGraphNodeStateObservation
  >();
  for (const observation of graph.currentNativeStateObservations) {
    if (currentNativeStateObservationsByNodeId.has(observation.nodeId)) {
      throw new TypeError(`current native state observation ${observation.nodeId}が重複しています`);
    }
    currentNativeStateObservationsByNodeId.set(observation.nodeId, observation);
  }
  const relationEventsByKey = new Map<string, RelationProgressEvent[]>();
  const relationRemovalEventsByKey = new Map<string, RelationProgressEvent>();
  for (const item of collection.observedItems) {
    for (const event of item.events) {
      if (event.kind !== "relation" || event.target.type !== "node") {
        continue;
      }
      const key = relationProgressEventKey(event);
      const relationEvents = relationEventsByKey.get(key);
      if (relationEvents == null) {
        relationEventsByKey.set(key, [event]);
      } else {
        relationEvents.push(event);
      }
      const existing = relationRemovalEventsByKey.get(key);
      if (
        existing == null ||
        event.occurredAt > existing.occurredAt ||
        (event.occurredAt === existing.occurredAt && event.sourceId > existing.sourceId)
      ) {
        relationRemovalEventsByKey.set(key, event);
      }
    }
  }
  const editedRelationSourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const detail of collection.details) {
    for (const comment of detail.comments) {
      if (comment.updatedAt === comment.createdAt) {
        continue;
      }
      const existing = editedRelationSourceOccurredAtById.get(comment.sourceId);
      if (existing == null || comment.updatedAt > existing) {
        editedRelationSourceOccurredAtById.set(comment.sourceId, comment.updatedAt);
      }
    }
  }
  const candidatesById = new Map<string, RelationCandidate>();
  for (const candidate of collection.relationCandidates) {
    if (!graph.relationCandidateAiDependencies.has(candidate.id)) {
      continue;
    }
    if (candidatesById.has(candidate.id)) {
      throw new TypeError(`関係候補 ${candidate.id}が重複しています`);
    }
    candidatesById.set(candidate.id, candidate);
  }
  const currentEdgesById = new Map<string, ReconciledGraphEdge>();
  for (const edge of graph.edges) {
    if (currentEdgesById.has(edge.id)) {
      throw new TypeError(`graph edge ${edge.id}が重複しています`);
    }
    currentEdgesById.set(edge.id, edge);
  }
  return Object.freeze({
    previousBlockerEdgesByTargetNodeId: previousBlockerEdgesByTargetNodeId(state),
    previousObservedAtByNodeId,
    previousEffectiveStateByNodeId,
    enumeratedItemsByNodeId,
    observedItemsByNodeId,
    currentNativeStateObservationsByNodeId,
    relationEventsByKey,
    sourceOccurredAtById: createDependencySourceOccurredAtById(collection),
    relationRemovalEventsByKey,
    editedRelationSourceOccurredAtById,
    candidatesById,
    relationCandidateAiDependencies: graph.relationCandidateAiDependencies,
    currentEdgesById,
  });
}

/** 関係判定を加えた依存解消索引を作る。 */
export function createDependencyResolutionIndexes(
  staticIndexes: DependencyResolutionStaticIndexes,
  relationAssessments: readonly RelationCandidateAssessment[],
): DependencyResolutionIndexes {
  const assessmentsById = new Map<string, RelationCandidateAssessment>();
  for (const assessment of relationAssessments) {
    if (assessmentsById.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI判定が重複しています`);
    }
    assessmentsById.set(assessment.candidateId, assessment);
  }
  return Object.freeze({
    ...staticIndexes,
    assessmentsById,
  });
}

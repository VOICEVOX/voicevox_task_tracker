import type { GitHubNodeId, Relation, SourceId, UtcIsoDateTime } from "../../../domain/index.js";
import type { GitHubItemDetail } from "../../../github/index.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  createCodexSourceOccurredAtById,
  latestUtcIsoDateTime,
} from "../../codex-input-projection.js";
import type { CollectedItems } from "../contracts.js";
import { createEarliestRelationSourceOccurredAtById } from "../relation-source-occurrence.js";
import type {
  DependencyResolutionIndexes,
  RelationProgressEvent,
} from "./dependency-resolution-contracts.js";
import { relationProgressKey } from "./dependency-resolution-keys.js";

/** 関係進捗に使う最新の削除イベントを返す。 */
export function latestRelationEventForProgress(
  indexes: DependencyResolutionIndexes,
  edge: Relation,
): RelationProgressEvent | undefined {
  const event = indexes.relationRemovalEventsByKey.get(
    relationProgressKey(edge.type, edge.provenance, edge.fromNodeId, edge.toNodeId),
  );
  if (event == null || event.occurredAt < edge.firstSeenAt || event.action !== "removed") {
    return undefined;
  }
  return event;
}

function editedRelationSourceOccurredAts(
  indexes: DependencyResolutionIndexes,
  edge: Relation,
): readonly UtcIsoDateTime[] {
  return Object.freeze(
    edge.evidence.flatMap((evidence) => {
      const occurredAt = indexes.editedRelationSourceOccurredAtById.get(evidence.sourceId);
      return occurredAt == null ? [] : [occurredAt];
    }),
  );
}

/** 依存解消に使うsourceごとの発生時刻を作る。 */
export function createDependencySourceOccurredAtById(
  collection: CollectedItems,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const detailsByNodeId = new Map<GitHubNodeId, GitHubItemDetail>();
  for (const detail of collection.details) {
    if (detailsByNodeId.has(detail.nodeId)) {
      throw new TypeError(`依存解消sourceの詳細が重複しています。対象: ${detail.nodeId}`);
    }
    detailsByNodeId.set(detail.nodeId, detail);
  }
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const item of collection.observedItems) {
    const detail = detailsByNodeId.get(item.nodeId);
    assertNonNullable(detail, `依存解消sourceの詳細がありません。対象: ${item.nodeId}`);
    for (const [sourceId, occurredAt] of createCodexSourceOccurredAtById(
      item,
      detail,
      createEarliestRelationSourceOccurredAtById,
    )) {
      const existingOccurredAt = sourceOccurredAtById.get(sourceId);
      if (existingOccurredAt == null || existingOccurredAt < occurredAt) {
        sourceOccurredAtById.set(sourceId, occurredAt);
      }
    }
  }
  return sourceOccurredAtById;
}

function resolvedSourceOccurredAts(
  sourceIds: readonly SourceId[],
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): readonly UtcIsoDateTime[] {
  return Object.freeze(
    [...new Set(sourceIds)].flatMap((sourceId) => {
      const occurredAt = sourceOccurredAtById.get(sourceId);
      return occurredAt == null ? [] : [occurredAt];
    }),
  );
}

/** 関係が解消した発生時刻を返す。 */
export function relationResolutionOccurredAt(
  indexes: DependencyResolutionIndexes,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  edge: Relation & Readonly<{ active: true }>,
): UtcIsoDateTime {
  const removalEvent = latestRelationEventForProgress(indexes, edge);
  if (removalEvent != null) {
    return removalEvent.occurredAt;
  }
  const currentCandidate = indexes.candidatesById.get(edge.id);
  if (currentCandidate == null) {
    const editedSourceOccurredAts = editedRelationSourceOccurredAts(indexes, edge);
    return editedSourceOccurredAts.length === 0
      ? edge.firstSeenAt
      : latestUtcIsoDateTime(editedSourceOccurredAts, `relation ${edge.id}の根拠編集`);
  }
  const currentEdge = indexes.currentEdgesById.get(edge.id);
  const currentEdgeOccurredAts = resolvedSourceOccurredAts(
    currentEdge?.evidence.map((evidence) => evidence.sourceId) ?? [],
    sourceOccurredAtById,
  );
  const assessment = indexes.assessmentsById.get(edge.id);
  const assessmentOccurredAts = resolvedSourceOccurredAts(
    assessment?.sourceIds ?? [],
    sourceOccurredAtById,
  );
  const occurredAts = [...currentEdgeOccurredAts, ...assessmentOccurredAts];
  return occurredAts.length === 0
    ? edge.firstSeenAt
    : latestUtcIsoDateTime(occurredAts, `relation ${edge.id}の再判定根拠`);
}

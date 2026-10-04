import { serializeCanonicalJson } from "../canonical-json/index.js";
import { type Repository } from "../domain/index.js";
import { StateFormatError, StateHistoryError } from "./errors.js";
import type {
  StateHistoryEvent,
  StateHistoryInputEvent,
  StateHistoryProjection,
} from "./history-contracts.js";
import { compareStrings } from "./history-contracts.js";
import {
  edgeSchema,
  inputEventsSchema,
  responsibilitySchema,
  severitySchema,
} from "./history-fields-schema.js";
import type { StateSnapshot } from "./snapshot-contracts.js";

function compareInputEvents(left: StateHistoryInputEvent, right: StateHistoryInputEvent): number {
  const occurredAtComparison = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtComparison !== 0) {
    return occurredAtComparison;
  }
  const sourceIdComparison = compareStrings(left.sourceId, right.sourceId);
  if (sourceIdComparison !== 0) {
    return sourceIdComparison;
  }
  return compareStrings(left.itemNodeId, right.itemNodeId);
}

/** 未検証の値を検証済みかつ決定論的順序の正規化入力イベントへ変換する。 */
export function createStateHistoryInputEvents(value: unknown): readonly StateHistoryInputEvent[] {
  const result = inputEventsSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state履歴の入力イベント", result.error);
  }
  return Object.freeze(
    [...result.data].sort(compareInputEvents).map((event) =>
      Object.freeze({
        ...event,
        actor: Object.freeze({ ...event.actor }),
      }),
    ),
  );
}

export function createRepositoryExclusionEvents(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  repositoryInventory: readonly Repository[],
): readonly StateHistoryEvent[] {
  if (previousSnapshot == null) {
    return Object.freeze([]);
  }
  const currentRepositoryIds = new Set(
    currentSnapshot.repositories.map((repository) => repository.id),
  );
  const inventoryById = new Map(
    repositoryInventory.map((repository) => [repository.id, repository]),
  );
  const events: StateHistoryEvent[] = [];
  for (const previousRepository of previousSnapshot.repositories) {
    if (currentRepositoryIds.has(previousRepository.id)) {
      continue;
    }
    const currentInventoryRepository = inventoryById.get(previousRepository.id);
    if (
      currentInventoryRepository?.visibility === "public" &&
      currentInventoryRepository.archived
    ) {
      events.push({
        kind: "repository_excluded",
        repositoryFullName: `${currentInventoryRepository.owner}/${currentInventoryRepository.name}`,
        reason: "archived",
      });
    }
  }
  return Object.freeze(events);
}

function snapshotInputEventItems(
  snapshot: StateSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  const itemNodeIdsBySourceId = new Map<string, Set<string>>();
  for (const item of snapshot.items) {
    for (const event of item.inputEvents) {
      const itemNodeIds = itemNodeIdsBySourceId.get(event.sourceId);
      if (itemNodeIds == null) {
        itemNodeIdsBySourceId.set(event.sourceId, new Set([item.nodeId]));
        continue;
      }
      if (itemNodeIds.has(item.nodeId)) {
        throw new StateHistoryError("snapshot内で同じ項目の入力イベントsource IDが重複しています");
      }
      itemNodeIds.add(item.nodeId);
    }
  }
  return itemNodeIdsBySourceId;
}

export function createNewInputEvents(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  value: readonly StateHistoryInputEvent[],
): readonly StateHistoryInputEvent[] {
  const inputEvents = createStateHistoryInputEvents(value);
  const previousItemNodeIdsBySourceId =
    previousSnapshot == null
      ? new Map<string, ReadonlySet<string>>()
      : snapshotInputEventItems(previousSnapshot);
  const currentItemNodeIdsBySourceId = snapshotInputEventItems(currentSnapshot);
  const events: StateHistoryInputEvent[] = [];
  for (const event of inputEvents) {
    const currentItemNodeIds = currentItemNodeIdsBySourceId.get(event.sourceId);
    if (currentItemNodeIds?.has(event.itemNodeId) !== true) {
      throw new StateHistoryError("正規化イベントが現在のsnapshotの対象項目に存在しません");
    }
    const previousItemNodeIds = previousItemNodeIdsBySourceId.get(event.sourceId);
    if (previousItemNodeIds?.has(event.itemNodeId) !== true) {
      events.push(event);
    }
  }
  return Object.freeze(events);
}

export function createProjection(snapshot: StateSnapshot): StateHistoryProjection {
  return {
    responsibilities: new Map(
      snapshot.items.map((item) => [
        item.nodeId,
        {
          status: item.status,
          waitingOn: item.waitingOn.map((waitingOn) => ({
            ...waitingOn,
            sourceIds: [...waitingOn.sourceIds],
          })),
        },
      ]),
    ),
    edges: new Map(
      snapshot.relations.map((relation) => [
        relation.id,
        relation.active
          ? Object.freeze({
              fromNodeId: relation.fromNodeId,
              toNodeId: relation.toNodeId,
              type: relation.type,
              provenance: relation.provenance,
              confidence: relation.confidence,
              evidence: relation.evidence.map((entry) => ({ ...entry })),
              contradictions: relation.contradictions.map((contradiction) => ({
                ...contradiction,
              })),
              firstSeenAt: relation.firstSeenAt,
              lastConfirmedAt: relation.lastConfirmedAt,
              active: true,
            })
          : Object.freeze({
              fromNodeId: relation.fromNodeId,
              toNodeId: relation.toNodeId,
              type: relation.type,
              provenance: relation.provenance,
              confidence: relation.confidence,
              evidence: relation.evidence.map((entry) => ({ ...entry })),
              contradictions: relation.contradictions.map((contradiction) => ({
                ...contradiction,
              })),
              firstSeenAt: relation.firstSeenAt,
              lastConfirmedAt: relation.lastConfirmedAt,
              active: false,
              removedAt: relation.removedAt,
            }),
      ]),
    ),
    severities: new Map(snapshot.items.map((item) => [item.nodeId, item.severity])),
  };
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

export function createSetAndRemoveEvents<T>(
  category: "responsibility" | "edge" | "severity",
  previous: ReadonlyMap<string, T>,
  current: ReadonlyMap<string, T>,
): StateHistoryEvent[] {
  const events: StateHistoryEvent[] = [];
  const identifiers = [...new Set([...previous.keys(), ...current.keys()])].sort(compareStrings);
  for (const identifier of identifiers) {
    const previousValue = previous.get(identifier);
    const currentValue = current.get(identifier);
    if (currentValue == null) {
      if (previousValue == null) {
        throw new StateHistoryError("履歴差分の削除対象を取得できません");
      }
      if (category === "responsibility") {
        events.push({
          kind: "responsibility_removed",
          nodeId: identifier,
        });
      } else if (category === "edge") {
        events.push({
          kind: "edge_removed",
          relationId: identifier,
        });
      } else {
        events.push({
          kind: "severity_removed",
          nodeId: identifier,
        });
      }
      continue;
    }
    if (previousValue != null && valuesEqual(previousValue, currentValue)) {
      continue;
    }
    if (category === "responsibility") {
      const result = responsibilitySchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("責務差分を検証できません");
      }
      events.push({
        kind: "responsibility_set",
        nodeId: identifier,
        value: result.data,
      });
    } else if (category === "edge") {
      const result = edgeSchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("edge差分を検証できません");
      }
      events.push({
        kind: "edge_set",
        relationId: identifier,
        value: result.data,
      });
    } else {
      const result = severitySchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("severity差分を検証できません");
      }
      events.push({
        kind: "severity_set",
        nodeId: identifier,
        value: result.data,
      });
    }
  }
  return events;
}

export function createEmptyProjection(): StateHistoryProjection {
  return {
    responsibilities: new Map(),
    edges: new Map(),
    severities: new Map(),
  };
}

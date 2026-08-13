import { z } from "zod";

import { createUtcIsoDateTime, type SourceId, type UtcIsoDateTime } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  type DependencyReplayAction,
  type DependencyReplayBatch,
  type DependencyReplayEdge,
  type DependencyReplayInputEvent,
  type DependencyReplayInterval,
  type DependencyReplayRelation,
  type DependencyReplayResult,
  type DependencyReplayTransition,
} from "./dependency-replay-types.js";

type ResolvedDependencyReplayEvent = Extract<DependencyReplayInputEvent, { status: "resolved" }>;
type UnresolvedDependencyReplayEvent = Extract<
  DependencyReplayInputEvent,
  { status: "unresolved" }
>;

type CanonicalEventGroup = Readonly<{
  edge: DependencyReplayEdge;
  action: DependencyReplayAction;
  occurredAt: UtcIsoDateTime;
  originItemNodeId: ResolvedDependencyReplayEvent["originItemNodeId"];
  sequence: number;
  sourceId: SourceId;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

interface MutableActiveInterval {
  status: "active";
  addedAt: UtcIsoDateTime;
  sourceIds: Set<SourceId>;
  lastConfirmedAt: UtcIsoDateTime;
}

interface MutableRemovedInterval {
  status: "removed";
  addedAt: UtcIsoDateTime;
  addedSourceIds: Set<SourceId>;
  removedAt: UtcIsoDateTime;
  removedSourceIds: Set<SourceId>;
}

interface MutableRelation {
  edge: DependencyReplayEdge;
  intervals: (MutableActiveInterval | MutableRemovedInterval)[];
}

const nodeIdSchema = z.string().min(1).regex(/^\S+$/u);
const sourceIdSchema = z.string().min(3);
const occurredAtSchema = z.string().min(1);
const dependencyReplayInputEventSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("resolved"),
      sourceId: sourceIdSchema,
      originItemNodeId: nodeIdSchema,
      fromNodeId: nodeIdSchema,
      toNodeId: nodeIdSchema,
      action: z.enum(["added", "removed"]),
      occurredAt: occurredAtSchema,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unresolved"),
      sourceId: sourceIdSchema,
      originItemNodeId: nodeIdSchema,
      direction: z.enum(["blocked_by", "blocking"]),
      action: z.enum(["added", "removed"]),
      occurredAt: occurredAtSchema,
      sequence: z.number().int().nonnegative(),
      reason: z.literal("related_node_unavailable"),
    })
    .strict(),
]);
const dependencyReplayInputSchema = z.array(dependencyReplayInputEventSchema);

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareEventPosition(
  left: Pick<
    DependencyReplayInputEvent,
    "occurredAt" | "originItemNodeId" | "sequence" | "sourceId"
  >,
  right: Pick<
    DependencyReplayInputEvent,
    "occurredAt" | "originItemNodeId" | "sequence" | "sourceId"
  >,
): -1 | 0 | 1 {
  const occurredAtOrder = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtOrder !== 0) {
    return occurredAtOrder;
  }
  const originNodeOrder = compareStrings(left.originItemNodeId, right.originItemNodeId);
  if (originNodeOrder !== 0) {
    return originNodeOrder;
  }
  const sequenceOrder = compareNumbers(left.sequence, right.sequence);
  if (sequenceOrder !== 0) {
    return sequenceOrder;
  }
  return compareStrings(left.sourceId, right.sourceId);
}

function validateOccurredAt(occurredAt: UtcIsoDateTime, context: string): void {
  if (createUtcIsoDateTime(occurredAt) !== occurredAt) {
    throw new TypeError(`${context}はUTCへ正規化してください`);
  }
}

function validateInputEvent(event: DependencyReplayInputEvent, index: number): void {
  const validation = dependencyReplayInputEventSchema.safeParse(event);
  if (!validation.success) {
    throw new TypeError(`依存関係リプレイ入力 ${index.toString()} が不正です`, {
      cause: validation.error,
    });
  }
  validateOccurredAt(event.occurredAt, `依存関係リプレイ入力 ${index.toString()} の発生時刻`);
  if (event.status !== "resolved") {
    return;
  }
  if (event.fromNodeId === event.toNodeId) {
    throw new TypeError(`依存関係リプレイ入力 ${index.toString()} は同じnodeを接続できません`);
  }
  if (event.originItemNodeId !== event.fromNodeId && event.originItemNodeId !== event.toNodeId) {
    throw new TypeError(
      `依存関係リプレイ入力 ${index.toString()} のorigin nodeがedgeに含まれていません`,
    );
  }
}

function eventSignature(event: DependencyReplayInputEvent): string {
  if (event.status === "resolved") {
    return JSON.stringify([
      event.status,
      event.originItemNodeId,
      event.fromNodeId,
      event.toNodeId,
      event.action,
      event.occurredAt,
    ]);
  }
  return JSON.stringify([
    event.status,
    event.originItemNodeId,
    event.direction,
    event.action,
    event.occurredAt,
    event.reason,
  ]);
}

function edgeKey(edge: DependencyReplayEdge): string {
  return JSON.stringify([edge.fromNodeId, edge.toNodeId]);
}

function transitionKey(event: ResolvedDependencyReplayEvent): string {
  return JSON.stringify([event.fromNodeId, event.toNodeId, event.action, event.occurredAt]);
}

function createSourceIdTuple(sourceIds: ReadonlySet<SourceId>): readonly [SourceId, ...SourceId[]] {
  const sortedSourceIds = [...sourceIds].sort(compareStrings);
  const [firstSourceId, ...remainingSourceIds] = sortedSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function createEdge(
  fromNodeId: DependencyReplayEdge["fromNodeId"],
  toNodeId: DependencyReplayEdge["toNodeId"],
): DependencyReplayEdge {
  return Object.freeze({ fromNodeId, toNodeId });
}

function groupResolvedEvents(
  events: readonly ResolvedDependencyReplayEvent[],
): readonly CanonicalEventGroup[] {
  const groupsByKey = new Map<
    string,
    {
      edge: DependencyReplayEdge;
      action: DependencyReplayAction;
      occurredAt: UtcIsoDateTime;
      originItemNodeId: ResolvedDependencyReplayEvent["originItemNodeId"];
      sequence: number;
      sourceId: SourceId;
      sourceIds: Set<SourceId>;
    }
  >();

  for (const event of events) {
    const edge = createEdge(event.fromNodeId, event.toNodeId);
    const key = transitionKey(event);
    const existing = groupsByKey.get(key);
    if (existing == null) {
      groupsByKey.set(key, {
        edge,
        action: event.action,
        occurredAt: event.occurredAt,
        originItemNodeId: event.originItemNodeId,
        sequence: event.sequence,
        sourceId: event.sourceId,
        sourceIds: new Set([event.sourceId]),
      });
      continue;
    }
    existing.sourceIds.add(event.sourceId);
    if (
      compareEventPosition(event, {
        occurredAt: existing.occurredAt,
        originItemNodeId: existing.originItemNodeId,
        sequence: existing.sequence,
        sourceId: existing.sourceId,
      }) < 0
    ) {
      existing.originItemNodeId = event.originItemNodeId;
      existing.sequence = event.sequence;
      existing.sourceId = event.sourceId;
    }
  }

  return Object.freeze(
    [...groupsByKey.values()]
      .map((group) =>
        Object.freeze({
          edge: group.edge,
          action: group.action,
          occurredAt: group.occurredAt,
          originItemNodeId: group.originItemNodeId,
          sequence: group.sequence,
          sourceId: group.sourceId,
          sourceIds: createSourceIdTuple(group.sourceIds),
        }),
      )
      .sort(compareCanonicalEventGroups),
  );
}

function compareCanonicalEventGroups(
  left: CanonicalEventGroup,
  right: CanonicalEventGroup,
): -1 | 0 | 1 {
  return compareEventPosition(left, right);
}

function createMutableActiveInterval(group: CanonicalEventGroup): MutableActiveInterval {
  return {
    status: "active",
    addedAt: group.occurredAt,
    sourceIds: new Set(group.sourceIds),
    lastConfirmedAt: group.occurredAt,
  };
}

function sourceIdsFromTuple(sourceIds: readonly [SourceId, ...SourceId[]]): Set<SourceId> {
  return new Set(sourceIds);
}

function applyGroup(
  group: CanonicalEventGroup,
  relationsByEdgeKey: Map<string, MutableRelation>,
): DependencyReplayTransition {
  const key = edgeKey(group.edge);
  const relation = relationsByEdgeKey.get(key);
  if (group.action === "added") {
    if (relation == null) {
      relationsByEdgeKey.set(key, {
        edge: group.edge,
        intervals: [createMutableActiveInterval(group)],
      });
      return Object.freeze({
        kind: "added",
        edge: group.edge,
        occurredAt: group.occurredAt,
        sourceIds: group.sourceIds,
      });
    }
    const lastInterval = relation.intervals.at(-1);
    assertNonNullable(lastInterval, `edge ${key}のintervalがありません`);
    if (lastInterval.status === "active") {
      for (const sourceId of group.sourceIds) {
        lastInterval.sourceIds.add(sourceId);
      }
      lastInterval.lastConfirmedAt = group.occurredAt;
      return Object.freeze({
        kind: "confirmed",
        edge: relation.edge,
        occurredAt: group.occurredAt,
        sourceIds: group.sourceIds,
      });
    }
    relation.intervals.push(createMutableActiveInterval(group));
    return Object.freeze({
      kind: "added",
      edge: relation.edge,
      occurredAt: group.occurredAt,
      sourceIds: group.sourceIds,
    });
  }

  if (relation == null) {
    return Object.freeze({
      kind: "unmatched_removed",
      edge: group.edge,
      occurredAt: group.occurredAt,
      sourceIds: group.sourceIds,
    });
  }
  const lastInterval = relation.intervals.at(-1);
  assertNonNullable(lastInterval, `edge ${key}のintervalがありません`);
  if (lastInterval.status === "removed") {
    return Object.freeze({
      kind: "unmatched_removed",
      edge: relation.edge,
      occurredAt: group.occurredAt,
      sourceIds: group.sourceIds,
    });
  }
  const removedInterval: MutableRemovedInterval = {
    status: "removed",
    addedAt: lastInterval.addedAt,
    addedSourceIds: new Set(lastInterval.sourceIds),
    removedAt: group.occurredAt,
    removedSourceIds: sourceIdsFromTuple(group.sourceIds),
  };
  relation.intervals[relation.intervals.length - 1] = removedInterval;
  return Object.freeze({
    kind: "removed",
    edge: relation.edge,
    occurredAt: group.occurredAt,
    sourceIds: group.sourceIds,
  });
}

function freezeInterval(
  interval: MutableActiveInterval | MutableRemovedInterval,
): DependencyReplayInterval {
  if (interval.status === "active") {
    return Object.freeze({
      status: "active",
      addedAt: interval.addedAt,
      sourceIds: createSourceIdTuple(interval.sourceIds),
      lastConfirmedAt: interval.lastConfirmedAt,
    });
  }
  return Object.freeze({
    status: "removed",
    addedAt: interval.addedAt,
    addedSourceIds: createSourceIdTuple(interval.addedSourceIds),
    removedAt: interval.removedAt,
    removedSourceIds: createSourceIdTuple(interval.removedSourceIds),
  });
}

function freezeRelation(relation: MutableRelation): DependencyReplayRelation {
  const intervals = relation.intervals.map(freezeInterval);
  const [firstInterval, ...remainingIntervals] = intervals;
  assertNonNullable(firstInterval, `edge ${edgeKey(relation.edge)}のintervalがありません`);
  const frozenIntervals = createIntervalTuple(firstInterval, remainingIntervals);
  const lastInterval = remainingIntervals.at(-1) ?? firstInterval;
  const current: DependencyReplayRelation["current"] =
    lastInterval.status === "active"
      ? Object.freeze({
          status: "active",
          lastConfirmedAt: lastInterval.lastConfirmedAt,
        })
      : Object.freeze({
          status: "inactive",
          removedAt: lastInterval.removedAt,
        });
  return Object.freeze({
    edge: relation.edge,
    firstSeenAt: firstInterval.addedAt,
    intervals: frozenIntervals,
    current,
  });
}

function createIntervalTuple(
  firstInterval: DependencyReplayInterval,
  remainingIntervals: readonly DependencyReplayInterval[],
): readonly [DependencyReplayInterval, ...DependencyReplayInterval[]] {
  return Object.freeze([firstInterval, ...remainingIntervals]);
}

function activeEdges(
  relationsByEdgeKey: ReadonlyMap<string, MutableRelation>,
): readonly DependencyReplayEdge[] {
  return Object.freeze(
    [...relationsByEdgeKey.values()]
      .filter((relation) => relation.intervals.at(-1)?.status === "active")
      .map((relation) => relation.edge)
      .sort(compareEdges),
  );
}

function compareEdges(left: DependencyReplayEdge, right: DependencyReplayEdge): -1 | 0 | 1 {
  const fromNodeOrder = compareStrings(left.fromNodeId, right.fromNodeId);
  return fromNodeOrder !== 0 ? fromNodeOrder : compareStrings(left.toNodeId, right.toNodeId);
}

function createBatch(
  occurredAt: UtcIsoDateTime,
  transitions: readonly DependencyReplayTransition[],
  relationsByEdgeKey: ReadonlyMap<string, MutableRelation>,
): DependencyReplayBatch {
  const [firstTransition, ...remainingTransitions] = transitions;
  assertNonNullable(firstTransition, `発生時刻 ${occurredAt} のtransitionがありません`);
  return Object.freeze({
    occurredAt,
    transitions: createTransitionTuple(firstTransition, remainingTransitions),
    activeEdges: activeEdges(relationsByEdgeKey),
  });
}

function createTransitionTuple(
  firstTransition: DependencyReplayTransition,
  remainingTransitions: readonly DependencyReplayTransition[],
): readonly [DependencyReplayTransition, ...DependencyReplayTransition[]] {
  return Object.freeze([firstTransition, ...remainingTransitions]);
}

function validateInputEvents(events: readonly DependencyReplayInputEvent[]): void {
  const validation = dependencyReplayInputSchema.safeParse(events);
  if (!validation.success) {
    throw new TypeError("依存関係リプレイ入力が不正です", {
      cause: validation.error,
    });
  }
  events.forEach(validateInputEvent);
}

/** 正規化済み依存関係イベントを時系列に適用して区間を復元する。 */
export function replayDependencyEvents(
  events: readonly DependencyReplayInputEvent[],
): DependencyReplayResult {
  validateInputEvents(events);
  const eventsBySourceId = new Map<SourceId, DependencyReplayInputEvent>();
  for (const event of events) {
    const existing = eventsBySourceId.get(event.sourceId);
    if (existing == null) {
      eventsBySourceId.set(event.sourceId, event);
      continue;
    }
    if (eventSignature(existing) !== eventSignature(event)) {
      throw new TypeError(
        `同じsource IDが異なる依存関係イベントを指しています。対象: ${event.sourceId}`,
      );
    }
    if (compareEventPosition(event, existing) < 0) {
      eventsBySourceId.set(event.sourceId, event);
    }
  }

  const resolvedEvents: ResolvedDependencyReplayEvent[] = [];
  const unresolvedEvents: UnresolvedDependencyReplayEvent[] = [];
  for (const event of eventsBySourceId.values()) {
    if (event.status === "resolved") {
      resolvedEvents.push(event);
    } else {
      unresolvedEvents.push(event);
    }
  }
  unresolvedEvents.sort(compareEventPosition);
  const groups = groupResolvedEvents(resolvedEvents);
  const relationsByEdgeKey = new Map<string, MutableRelation>();
  const batches: DependencyReplayBatch[] = [];
  let groupIndex = 0;
  while (groupIndex < groups.length) {
    const firstGroup = groups[groupIndex];
    assertNonNullable(firstGroup, "依存関係イベントgroupがありません");
    const batchGroups: CanonicalEventGroup[] = [];
    while (groupIndex < groups.length) {
      const group = groups[groupIndex];
      assertNonNullable(group, "依存関係イベントgroupがありません");
      if (group.occurredAt !== firstGroup.occurredAt) {
        break;
      }
      batchGroups.push(group);
      groupIndex += 1;
    }
    const batchTransitions = batchGroups.map((group) => applyGroup(group, relationsByEdgeKey));
    batches.push(createBatch(firstGroup.occurredAt, batchTransitions, relationsByEdgeKey));
  }

  const relations = Object.freeze(
    [...relationsByEdgeKey.values()]
      .map(freezeRelation)
      .sort((left, right) => compareEdges(left.edge, right.edge)),
  );
  const frozenBatches = Object.freeze(batches);
  return Object.freeze({
    relations,
    transitions: Object.freeze(frozenBatches.flatMap((batch) => batch.transitions)),
    batches: frozenBatches,
    unresolvedEvents: Object.freeze(unresolvedEvents),
  });
}

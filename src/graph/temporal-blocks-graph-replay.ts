import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createUtcIsoDateTime,
  type GraphNodeId,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  type DependencyReplayEdge,
  type DependencyReplayInputEvent,
} from "./dependency-replay-types.js";
import { replayDependencyEvents } from "./replay-dependency-events.js";

/** 時系列graphで扱う項目の状態。 */
export type TemporalBlocksNodeState = "open" | "closed" | "merged";

/** 現在値から作る項目node。 */
export type TemporalBlocksCurrentNode = Readonly<{
  nodeId: GraphNodeId;
  state: TemporalBlocksNodeState;
}>;

/** GitHubのstate replayから得たepoch。sequenceがない場合は0として扱う。 */
export type TemporalBlocksStateEpoch = Readonly<{
  state: TemporalBlocksNodeState;
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
  sequence?: number;
}>;

/** node state履歴の確実性。 */
export type TemporalBlocksNodeStateHistory = Readonly<{
  nodeId: GraphNodeId;
  history:
    | Readonly<{
        status: "exact";
        epochs: readonly TemporalBlocksStateEpoch[];
      }>
    | Readonly<{
        status: "unknown";
        reason: "history_unavailable";
      }>;
}>;

/** 復元不能なrelation mutationが影響し得るorigin item。 */
export type TemporalBlocksLocalRelationUnknown = Readonly<{
  originItemNodeId: GraphNodeId;
}>;

/** relation mutationの履歴入力。resolved以外は現在graphを変更しない。 */
export type TemporalBlocksRelationHistory =
  | Readonly<{
      status: "exact";
      mutations: readonly DependencyReplayInputEvent[];
      localUnknowns: readonly TemporalBlocksLocalRelationUnknown[];
    }>
  | Readonly<{
      status: "unknown";
      reason: "history_unavailable" | "connection_unavailable";
    }>;

/** 現在値と履歴をtemporal blocks graph replayへ渡す入力。 */
export type TemporalBlocksGraphReplayInput = Readonly<{
  current: Readonly<{
    nodes: readonly TemporalBlocksCurrentNode[];
    canonicalBlocksEdges: readonly DependencyReplayEdge[];
  }>;
  nodeStateHistories: readonly TemporalBlocksNodeStateHistory[];
  relationHistory: TemporalBlocksRelationHistory;
}>;

/** 現在値だけから作ったblocks graph。 */
export type TemporalBlocksCurrentGraph = Readonly<{
  nodes: readonly TemporalBlocksCurrentNode[];
  canonicalBlocksEdges: readonly DependencyReplayEdge[];
  activeBlocksEdges: readonly DependencyReplayEdge[];
}>;

/** newly unblockedの確定fact。 */
export type TemporalBlocksNewlyUnblockedFact = Readonly<{
  blockedNodeId: GraphNodeId;
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
  blockerNodeIds: readonly [GraphNodeId, ...GraphNodeId[]];
}>;

/** cycleの確定fact。 */
export type TemporalBlocksCycleCreatedFact = Readonly<{
  id: `dependency-cycle:${string}`;
  nodeIds: readonly [GraphNodeId, ...GraphNodeId[]];
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** 現在値または履歴時点のcycle。 */
export type TemporalBlocksCycle = Readonly<{
  id: `dependency-cycle:${string}`;
  nodeIds: readonly [GraphNodeId, ...GraphNodeId[]];
  edges: readonly DependencyReplayEdge[];
}>;

/** temporal factを確定できなかった理由。 */
export type TemporalBlocksUnknownReason =
  | "state_history_unavailable"
  | "state_history_current_mismatch"
  | "relation_history_unavailable"
  | "relation_history_current_mismatch"
  | "relation_mutation_unresolved";

/** exactまたはunknownのtemporal fact。 */
export type TemporalBlocksFactResult<Value> =
  | Readonly<{
      status: "exact";
      value: Value;
    }>
  | Readonly<{
      status: "unknown";
      scope: "node";
      nodeIds: readonly [GraphNodeId, ...GraphNodeId[]];
      reason: TemporalBlocksUnknownReason;
    }>
  | Readonly<{
      status: "unknown";
      scope: "global";
      nodeIds: readonly [];
      reason: TemporalBlocksUnknownReason;
    }>;

/** temporal blocks graph replayの結果。 */
export type TemporalBlocksGraphReplayResult = Readonly<{
  currentGraph: TemporalBlocksCurrentGraph;
  currentCycles: readonly TemporalBlocksCycle[];
  newlyUnblockedFacts: readonly TemporalBlocksFactResult<TemporalBlocksNewlyUnblockedFact>[];
  cycleCreatedFacts: readonly TemporalBlocksFactResult<TemporalBlocksCycleCreatedFact>[];
}>;

type UnresolvedDependencyReplayEvent = Extract<
  DependencyReplayInputEvent,
  { status: "unresolved" }
>;

type StateHistoryEntry = Readonly<{
  nodeId: GraphNodeId;
  history:
    | Readonly<{
        status: "exact";
        epochs: readonly TemporalBlocksStateEpoch[];
      }>
    | Readonly<{
        status: "unknown";
        reason: "history_unavailable";
      }>;
}>;

type StateEpochGroup = Readonly<{
  kind: "state";
  nodeId: GraphNodeId;
  state: TemporalBlocksNodeState;
  occurredAt: UtcIsoDateTime;
  sequence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

type RelationEpochGroup = Readonly<{
  kind: "relation";
  edge: DependencyReplayEdge;
  action: "added" | "removed";
  occurredAt: UtcIsoDateTime;
  originItemNodeId: GraphNodeId;
  sequence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

type TemporalEvent = StateEpochGroup | RelationEpochGroup;

type TemporalRelationState = Readonly<{
  edge: DependencyReplayEdge;
  active: boolean;
}>;

type TemporalBatch = Readonly<{
  occurredAt: UtcIsoDateTime;
  events: readonly [TemporalEvent, ...TemporalEvent[]];
}>;

type UnknownMark = Readonly<{
  scope: "node" | "global";
  nodeIds: readonly GraphNodeId[];
  reason: TemporalBlocksUnknownReason;
}>;

const nodeIdSchema = z.string().min(1).regex(/^\S+$/u);
const sourceIdSchema = z.string().min(3);
const occurredAtSchema = z.string().min(1);
const stateSchema = z.enum(["open", "closed", "merged"]);
const sourceIdsSchema = z.array(sourceIdSchema).min(1);
const stateEpochSchema = z
  .object({
    state: stateSchema,
    occurredAt: occurredAtSchema,
    sourceIds: sourceIdsSchema,
    sequence: z.number().int().nonnegative().optional(),
  })
  .strict();
const nodeStateHistorySchema = z
  .object({
    nodeId: nodeIdSchema,
    history: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("exact"),
          epochs: z.array(stateEpochSchema),
        })
        .strict(),
      z
        .object({
          status: z.literal("unknown"),
          reason: z.literal("history_unavailable"),
        })
        .strict(),
    ]),
  })
  .strict();
const resolvedRelationEventSchema = z
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
  .strict();
const unresolvedRelationEventSchema = z
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
  .strict();
const relationHistorySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("exact"),
      mutations: z.array(
        z.discriminatedUnion("status", [
          resolvedRelationEventSchema,
          unresolvedRelationEventSchema,
        ]),
      ),
      localUnknowns: z.array(
        z
          .object({
            originItemNodeId: nodeIdSchema,
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.enum(["history_unavailable", "connection_unavailable"]),
    })
    .strict(),
]);
const temporalBlocksInputSchema = z
  .object({
    current: z
      .object({
        nodes: z.array(
          z
            .object({
              nodeId: nodeIdSchema,
              state: stateSchema,
            })
            .strict(),
        ),
        canonicalBlocksEdges: z.array(
          z
            .object({
              fromNodeId: nodeIdSchema,
              toNodeId: nodeIdSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    nodeStateHistories: z.array(nodeStateHistorySchema),
    relationHistory: relationHistorySchema,
  })
  .strict();

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

function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  return compareStrings(left, right);
}

function compareEdges(left: DependencyReplayEdge, right: DependencyReplayEdge): -1 | 0 | 1 {
  const fromOrder = compareStrings(left.fromNodeId, right.fromNodeId);
  return fromOrder !== 0 ? fromOrder : compareStrings(left.toNodeId, right.toNodeId);
}

function edgeKey(edge: DependencyReplayEdge): string {
  return JSON.stringify([edge.fromNodeId, edge.toNodeId]);
}

function createEdge(fromNodeId: GraphNodeId, toNodeId: GraphNodeId): DependencyReplayEdge {
  return Object.freeze({ fromNodeId, toNodeId });
}

function createSourceIdTuple(sourceIds: ReadonlySet<SourceId>): readonly [SourceId, ...SourceId[]] {
  const sortedSourceIds = [...sourceIds].sort(compareSourceIds);
  const [firstSourceId, ...remainingSourceIds] = sortedSourceIds;
  assertNonNullable(firstSourceId, "temporal factのsource IDがありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function createSingleSourceIdTuple(sourceId: SourceId): readonly [SourceId] {
  return Object.freeze([sourceId]);
}

function createNodeIdTuple(
  nodeIds: ReadonlySet<GraphNodeId>,
  context: string,
): readonly [GraphNodeId, ...GraphNodeId[]] {
  const sortedNodeIds = [...nodeIds].sort(compareStrings);
  const [firstNodeId, ...remainingNodeIds] = sortedNodeIds;
  assertNonNullable(firstNodeId, context);
  return Object.freeze([firstNodeId, ...remainingNodeIds]);
}

function validateOccurredAt(occurredAt: UtcIsoDateTime, context: string): void {
  if (createUtcIsoDateTime(occurredAt) !== occurredAt) {
    throw new TypeError(`${context}はUTCへ正規化してください`);
  }
}

function validateInput(input: TemporalBlocksGraphReplayInput): void {
  const validation = temporalBlocksInputSchema.safeParse(input);
  if (!validation.success) {
    throw new TypeError("temporal blocks graph replay入力が不正です", {
      cause: validation.error,
    });
  }
  input.nodeStateHistories.forEach((entry, entryIndex) => {
    if (entry.history.status !== "exact") {
      return;
    }
    entry.history.epochs.forEach((epoch, epochIndex) => {
      validateOccurredAt(
        epoch.occurredAt,
        `node state epoch ${entryIndex.toString()}/${epochIndex.toString()} の発生時刻`,
      );
    });
  });
  if (input.relationHistory.status === "exact") {
    input.relationHistory.mutations.forEach((mutation, mutationIndex) => {
      validateOccurredAt(
        mutation.occurredAt,
        `relation mutation ${mutationIndex.toString()} の発生時刻`,
      );
    });
    const currentNodeIds = new Set(input.current.nodes.map((node) => node.nodeId));
    const localUnknownNodeIds = new Set<GraphNodeId>();
    for (const localUnknown of input.relationHistory.localUnknowns) {
      if (!currentNodeIds.has(localUnknown.originItemNodeId)) {
        throw new TypeError(
          `局所relation unknownが存在しないnodeを参照しています。対象: ${localUnknown.originItemNodeId}`,
        );
      }
      if (localUnknownNodeIds.has(localUnknown.originItemNodeId)) {
        throw new TypeError(
          `局所relation unknownのorigin nodeが重複しています。対象: ${localUnknown.originItemNodeId}`,
        );
      }
      localUnknownNodeIds.add(localUnknown.originItemNodeId);
    }
  }
  for (const edge of input.current.canonicalBlocksEdges) {
    if (edge.fromNodeId === edge.toNodeId) {
      throw new TypeError("current canonical blocks edgeは同じnodeを接続できません");
    }
  }
}

function compareEventPosition(left: TemporalEvent, right: TemporalEvent): -1 | 0 | 1 {
  const timeOrder = compareStrings(left.occurredAt, right.occurredAt);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  const sequenceOrder = compareNumbers(left.sequence, right.sequence);
  if (sequenceOrder !== 0) {
    return sequenceOrder;
  }
  const leftSourceId = left.sourceIds[0];
  const rightSourceId = right.sourceIds[0];
  assertNonNullable(leftSourceId, "temporal eventのsource IDがありません");
  assertNonNullable(rightSourceId, "temporal eventのsource IDがありません");
  const sourceOrder = compareSourceIds(leftSourceId, rightSourceId);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }
  const leftOrigin = left.kind === "state" ? left.nodeId : left.originItemNodeId;
  const rightOrigin = right.kind === "state" ? right.nodeId : right.originItemNodeId;
  return compareStrings(leftOrigin, rightOrigin);
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
      event.sequence,
    ]);
  }
  return JSON.stringify([
    event.status,
    event.originItemNodeId,
    event.direction,
    event.action,
    event.occurredAt,
    event.sequence,
    event.reason,
  ]);
}

function relationSourceSignature(event: DependencyReplayInputEvent): string {
  return JSON.stringify(["relation", event.originItemNodeId, event.occurredAt, event.sequence]);
}

function compareDependencyReplayEvents(
  left: DependencyReplayInputEvent,
  right: DependencyReplayInputEvent,
): -1 | 0 | 1 {
  const occurredAtOrder = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtOrder !== 0) {
    return occurredAtOrder;
  }
  const sequenceOrder = compareNumbers(left.sequence, right.sequence);
  if (sequenceOrder !== 0) {
    return sequenceOrder;
  }
  const sourceOrder = compareSourceIds(left.sourceId, right.sourceId);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }
  const originOrder = compareStrings(left.originItemNodeId, right.originItemNodeId);
  if (originOrder !== 0) {
    return originOrder;
  }
  if (left.status !== right.status) {
    return left.status === "resolved" ? -1 : 1;
  }
  if (left.status === "resolved" && right.status === "resolved") {
    const fromOrder = compareStrings(left.fromNodeId, right.fromNodeId);
    if (fromOrder !== 0) {
      return fromOrder;
    }
    const toOrder = compareStrings(left.toNodeId, right.toNodeId);
    if (toOrder !== 0) {
      return toOrder;
    }
    return left.action === right.action ? 0 : left.action === "added" ? -1 : 1;
  }
  if (left.status !== "unresolved" || right.status !== "unresolved") {
    throw new TypeError("依存関係イベントのstatusが不正です");
  }
  if (left.action !== right.action) {
    return left.action === "added" ? -1 : 1;
  }
  return left.direction === right.direction ? 0 : left.direction === "blocked_by" ? -1 : 1;
}

function stateEpochSignature(nodeId: GraphNodeId, epoch: TemporalBlocksStateEpoch): string {
  return JSON.stringify(["state", nodeId, epoch.state, epoch.occurredAt, epoch.sequence ?? 0]);
}

function sourceSignaturesForStateEpoch(
  nodeId: GraphNodeId,
  epoch: TemporalBlocksStateEpoch,
): readonly (readonly [SourceId, string])[] {
  const signature = stateEpochSignature(nodeId, epoch);
  return epoch.sourceIds.map((sourceId) => Object.freeze([sourceId, signature]));
}

function mergeSourceSignatures(
  sourceSignatures: Map<SourceId, string>,
  additions: readonly (readonly [SourceId, string])[],
): void {
  for (const [sourceId, signature] of additions) {
    const existingSignature = sourceSignatures.get(sourceId);
    if (existingSignature != null && existingSignature !== signature) {
      throw new TypeError(`同じsource IDが異なるtemporal eventを指しています。対象: ${sourceId}`);
    }
    sourceSignatures.set(sourceId, signature);
  }
}

function deduplicateRelationEvents(
  events: readonly DependencyReplayInputEvent[],
  sourceSignatures: Map<SourceId, string>,
): readonly DependencyReplayInputEvent[] {
  const eventsBySourceId = new Map<string, DependencyReplayInputEvent>();
  for (const event of events) {
    mergeSourceSignatures(sourceSignatures, [[event.sourceId, relationSourceSignature(event)]]);
    const eventKey = JSON.stringify([event.sourceId, eventSignature(event)]);
    if (!eventsBySourceId.has(eventKey)) {
      eventsBySourceId.set(eventKey, event);
    }
  }
  return Object.freeze([...eventsBySourceId.values()].sort(compareDependencyReplayEvents));
}

function compareEpochSources(
  left: TemporalBlocksStateEpoch,
  right: TemporalBlocksStateEpoch,
): -1 | 0 | 1 {
  const leftSourceId = left.sourceIds[0];
  const rightSourceId = right.sourceIds[0];
  assertNonNullable(leftSourceId, "node state epochのsource IDがありません");
  assertNonNullable(rightSourceId, "node state epochのsource IDがありません");
  return compareSourceIds(leftSourceId, rightSourceId);
}

function createStateEpochGroups(
  entries: readonly StateHistoryEntry[],
  sourceSignatures: Map<SourceId, string>,
): readonly StateEpochGroup[] {
  const groupsByKey = new Map<
    string,
    {
      nodeId: GraphNodeId;
      state: TemporalBlocksNodeState;
      occurredAt: UtcIsoDateTime;
      sequence: number;
      sourceIds: Set<SourceId>;
    }
  >();
  for (const entry of entries) {
    if (entry.history.status !== "exact") {
      continue;
    }
    for (const epoch of entry.history.epochs) {
      mergeSourceSignatures(sourceSignatures, sourceSignaturesForStateEpoch(entry.nodeId, epoch));
      const sequence = epoch.sequence ?? 0;
      const key = JSON.stringify([entry.nodeId, epoch.state, epoch.occurredAt, sequence]);
      const existing = groupsByKey.get(key);
      if (existing == null) {
        groupsByKey.set(key, {
          nodeId: entry.nodeId,
          state: epoch.state,
          occurredAt: epoch.occurredAt,
          sequence,
          sourceIds: new Set(epoch.sourceIds),
        });
        continue;
      }
      for (const sourceId of epoch.sourceIds) {
        existing.sourceIds.add(sourceId);
      }
    }
  }
  return Object.freeze(
    [...groupsByKey.values()]
      .map((group): StateEpochGroup =>
        Object.freeze({
          kind: "state",
          nodeId: group.nodeId,
          state: group.state,
          occurredAt: group.occurredAt,
          sequence: group.sequence,
          sourceIds: createSourceIdTuple(group.sourceIds),
        }),
      )
      .sort(compareEventPosition),
  );
}

function createRelationEpochGroups(
  events: readonly DependencyReplayInputEvent[],
  sourceSignatures: Map<SourceId, string>,
): Readonly<{
  groups: readonly RelationEpochGroup[];
  unresolvedEvents: readonly UnresolvedDependencyReplayEvent[];
}> {
  const deduplicatedEvents = deduplicateRelationEvents(events, sourceSignatures);
  const groupsByKey = new Map<
    string,
    {
      edge: DependencyReplayEdge;
      action: "added" | "removed";
      occurredAt: UtcIsoDateTime;
      originItemNodeId: GraphNodeId;
      sequence: number;
      sourceId: SourceId;
      sourceIds: Set<SourceId>;
    }
  >();
  const unresolvedEvents: UnresolvedDependencyReplayEvent[] = [];
  for (const event of deduplicatedEvents) {
    if (event.status === "unresolved") {
      unresolvedEvents.push(event);
      continue;
    }
    const edge = createEdge(event.fromNodeId, event.toNodeId);
    const key = JSON.stringify([event.fromNodeId, event.toNodeId, event.action, event.occurredAt]);
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
    const eventPosition: RelationEpochGroup = {
      kind: "relation",
      edge,
      action: event.action,
      occurredAt: event.occurredAt,
      originItemNodeId: event.originItemNodeId,
      sequence: event.sequence,
      sourceIds: createSingleSourceIdTuple(event.sourceId),
    };
    const existingPosition: RelationEpochGroup = {
      kind: "relation",
      edge: existing.edge,
      action: existing.action,
      occurredAt: existing.occurredAt,
      originItemNodeId: existing.originItemNodeId,
      sequence: existing.sequence,
      sourceIds: createSingleSourceIdTuple(existing.sourceId),
    };
    if (compareEventPosition(eventPosition, existingPosition) < 0) {
      existing.originItemNodeId = event.originItemNodeId;
      existing.sequence = event.sequence;
      existing.sourceId = event.sourceId;
    }
  }
  const groups = Object.freeze(
    [...groupsByKey.values()]
      .map((group): RelationEpochGroup =>
        Object.freeze({
          kind: "relation",
          edge: group.edge,
          action: group.action,
          occurredAt: group.occurredAt,
          originItemNodeId: group.originItemNodeId,
          sequence: group.sequence,
          sourceIds: createSourceIdTuple(group.sourceIds),
        }),
      )
      .sort(compareEventPosition),
  );
  unresolvedEvents.sort((left, right) => {
    const leftEvent: RelationEpochGroup = {
      kind: "relation",
      edge: createEdge(left.originItemNodeId, left.originItemNodeId),
      action: left.action,
      occurredAt: left.occurredAt,
      originItemNodeId: left.originItemNodeId,
      sequence: left.sequence,
      sourceIds: createSingleSourceIdTuple(left.sourceId),
    };
    const rightEvent: RelationEpochGroup = {
      kind: "relation",
      edge: createEdge(right.originItemNodeId, right.originItemNodeId),
      action: right.action,
      occurredAt: right.occurredAt,
      originItemNodeId: right.originItemNodeId,
      sequence: right.sequence,
      sourceIds: createSingleSourceIdTuple(right.sourceId),
    };
    return compareEventPosition(leftEvent, rightEvent);
  });
  return Object.freeze({
    groups,
    unresolvedEvents: Object.freeze(unresolvedEvents),
  });
}

function createBatches(events: readonly TemporalEvent[]): readonly TemporalBatch[] {
  const sortedEvents = [...events].sort(compareEventPosition);
  const batches: TemporalBatch[] = [];
  let index = 0;
  while (index < sortedEvents.length) {
    const firstEvent = sortedEvents[index];
    assertNonNullable(firstEvent, "temporal eventがありません");
    const batchEvents: TemporalEvent[] = [];
    while (index < sortedEvents.length) {
      const event = sortedEvents[index];
      assertNonNullable(event, "temporal eventがありません");
      if (event.occurredAt !== firstEvent.occurredAt) {
        break;
      }
      batchEvents.push(event);
      index += 1;
    }
    const [firstBatchEvent, ...remainingBatchEvents] = batchEvents;
    assertNonNullable(firstBatchEvent, "temporal batchが空です");
    const batchEventTuple: readonly [TemporalEvent, ...TemporalEvent[]] = Object.freeze([
      firstBatchEvent,
      ...remainingBatchEvents,
    ]);
    batches.push(
      Object.freeze({
        occurredAt: firstEvent.occurredAt,
        events: batchEventTuple,
      }),
    );
  }
  return Object.freeze(batches);
}

function validateStateTransitions(entries: readonly StateHistoryEntry[]): void {
  for (const entry of entries) {
    if (entry.history.status !== "exact") {
      continue;
    }
    if (entry.history.epochs.length === 0) {
      throw new TypeError(`node ${entry.nodeId} のstate epochが空です`);
    }
    const sortedEpochs = [...entry.history.epochs].sort((left, right) => {
      const leftEvent: StateEpochGroup = {
        kind: "state",
        nodeId: entry.nodeId,
        state: left.state,
        occurredAt: left.occurredAt,
        sequence: left.sequence ?? 0,
        sourceIds: left.sourceIds,
      };
      const rightEvent: StateEpochGroup = {
        kind: "state",
        nodeId: entry.nodeId,
        state: right.state,
        occurredAt: right.occurredAt,
        sequence: right.sequence ?? 0,
        sourceIds: right.sourceIds,
      };
      return compareEventPosition(leftEvent, rightEvent);
    });
    let previousState: TemporalBlocksNodeState | undefined;
    for (const epoch of sortedEpochs) {
      if (previousState === "merged" && epoch.state !== "merged") {
        throw new TypeError(`node ${entry.nodeId} のmerged後にstateが変化しています`);
      }
      previousState = epoch.state;
    }
  }
}

function currentGraph(input: TemporalBlocksGraphReplayInput): TemporalBlocksCurrentGraph {
  const nodesById = new Map<GraphNodeId, TemporalBlocksCurrentNode>();
  for (const node of input.current.nodes) {
    if (nodesById.has(node.nodeId)) {
      throw new TypeError(`current node ${node.nodeId} が重複しています`);
    }
    nodesById.set(node.nodeId, node);
  }
  const canonicalEdgesByKey = new Map<string, DependencyReplayEdge>();
  for (const edge of input.current.canonicalBlocksEdges) {
    if (!nodesById.has(edge.fromNodeId) || !nodesById.has(edge.toNodeId)) {
      throw new TypeError("current canonical blocks edgeが存在しないnodeを参照しています");
    }
    const key = edgeKey(edge);
    if (canonicalEdgesByKey.has(key)) {
      throw new TypeError(`current canonical blocks edge ${key} が重複しています`);
    }
    canonicalEdgesByKey.set(key, createEdge(edge.fromNodeId, edge.toNodeId));
  }
  const nodes: readonly TemporalBlocksCurrentNode[] = Object.freeze(
    [...nodesById.values()].sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
  );
  const canonicalBlocksEdges: readonly DependencyReplayEdge[] = Object.freeze(
    [...canonicalEdgesByKey.values()].sort(compareEdges),
  );
  const activeBlocksEdges = Object.freeze(
    canonicalBlocksEdges.filter((edge) => {
      const fromNode = nodesById.get(edge.fromNodeId);
      const toNode = nodesById.get(edge.toNodeId);
      assertNonNullable(fromNode, `edge ${edgeKey(edge)} の始点nodeがありません`);
      assertNonNullable(toNode, `edge ${edgeKey(edge)} の終点nodeがありません`);
      return fromNode.state === "open" && toNode.state === "open";
    }),
  );
  return Object.freeze({
    nodes,
    canonicalBlocksEdges,
    activeBlocksEdges,
  });
}

function activeEdgeKeys(edges: readonly DependencyReplayEdge[]): ReadonlySet<string> {
  return new Set(edges.map(edgeKey));
}

function sameEdgeSet(
  left: readonly DependencyReplayEdge[],
  right: readonly DependencyReplayEdge[],
): boolean {
  const leftKeys = activeEdgeKeys(left);
  const rightKeys = activeEdgeKeys(right);
  if (leftKeys.size !== rightKeys.size) {
    return false;
  }
  for (const key of leftKeys) {
    if (!rightKeys.has(key)) {
      return false;
    }
  }
  return true;
}

function stateMapFromCurrentNodes(
  nodes: readonly TemporalBlocksCurrentNode[],
): ReadonlyMap<GraphNodeId, TemporalBlocksNodeState> {
  return new Map(nodes.map((node) => [node.nodeId, node.state]));
}

function effectiveEdges(
  relationsByEdgeKey: ReadonlyMap<string, TemporalRelationState>,
  statesByNodeId: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
): readonly DependencyReplayEdge[] {
  const edges: DependencyReplayEdge[] = [];
  for (const relation of relationsByEdgeKey.values()) {
    if (!relation.active) {
      continue;
    }
    if (statesByNodeId.get(relation.edge.fromNodeId) !== "open") {
      continue;
    }
    if (statesByNodeId.get(relation.edge.toNodeId) !== "open") {
      continue;
    }
    edges.push(relation.edge);
  }
  return Object.freeze(edges.sort(compareEdges));
}

function incomingEdges(
  nodeId: GraphNodeId,
  edges: readonly DependencyReplayEdge[],
): readonly DependencyReplayEdge[] {
  return Object.freeze(edges.filter((edge) => edge.toNodeId === nodeId));
}

function outgoingAdjacency(
  nodeIds: readonly GraphNodeId[],
  edges: readonly DependencyReplayEdge[],
): ReadonlyMap<GraphNodeId, readonly GraphNodeId[]> {
  const adjacency = new Map<GraphNodeId, Set<GraphNodeId>>(
    nodeIds.map((nodeId) => [nodeId, new Set<GraphNodeId>()]),
  );
  for (const edge of edges) {
    const neighbors = adjacency.get(edge.fromNodeId);
    assertNonNullable(neighbors, `edge ${edgeKey(edge)} の始点nodeがありません`);
    neighbors.add(edge.toNodeId);
  }
  return new Map(
    [...adjacency.entries()].map(([nodeId, neighbors]) => [
      nodeId,
      Object.freeze([...neighbors].sort(compareStrings)),
    ]),
  );
}

function stronglyConnectedComponents(
  nodeIds: readonly GraphNodeId[],
  edges: readonly DependencyReplayEdge[],
): readonly (readonly [GraphNodeId, ...GraphNodeId[]])[] {
  const outgoing = outgoingAdjacency(nodeIds, edges);
  const incoming = outgoingAdjacency(
    nodeIds,
    edges.map((edge) => createEdge(edge.toNodeId, edge.fromNodeId)),
  );
  const visited = new Set<GraphNodeId>();
  const order: GraphNodeId[] = [];
  const visit = (nodeId: GraphNodeId): void => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const neighbors = outgoing.get(nodeId);
    assertNonNullable(neighbors, `node ${nodeId} の出辺一覧がありません`);
    for (const neighbor of neighbors) {
      visit(neighbor);
    }
    order.push(nodeId);
  };
  for (const nodeId of [...nodeIds].sort(compareStrings)) {
    visit(nodeId);
  }
  const assigned = new Set<GraphNodeId>();
  const components: (readonly [GraphNodeId, ...GraphNodeId[]])[] = [];
  for (const startNodeId of [...order].reverse()) {
    if (assigned.has(startNodeId)) {
      continue;
    }
    const component: GraphNodeId[] = [];
    const stack = [startNodeId];
    assigned.add(startNodeId);
    while (stack.length > 0) {
      const nodeId = stack.pop();
      assertNonNullable(nodeId, "強連結成分の探索stackが空です");
      component.push(nodeId);
      const neighbors = incoming.get(nodeId);
      assertNonNullable(neighbors, `node ${nodeId} の入辺一覧がありません`);
      for (const neighbor of [...neighbors].reverse()) {
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(createNodeIdTuple(new Set(component), "強連結成分にnodeがありません"));
  }
  return Object.freeze(components.sort((left, right) => compareStrings(left[0], right[0])));
}

function cycleId(nodeIds: readonly GraphNodeId[]): `dependency-cycle:${string}` {
  const digest = createHash("sha256").update(JSON.stringify(nodeIds), "utf8").digest("hex");
  return `dependency-cycle:${digest}`;
}

function cyclesForGraph(
  nodeIds: readonly GraphNodeId[],
  edges: readonly DependencyReplayEdge[],
): readonly TemporalBlocksCycle[] {
  const components = stronglyConnectedComponents(nodeIds, edges);
  const selfLoops = new Set(
    edges.filter((edge) => edge.fromNodeId === edge.toNodeId).map((edge) => edge.fromNodeId),
  );
  return Object.freeze(
    components
      .filter((component) => component.length >= 2 || selfLoops.has(component[0]))
      .map((component) => {
        const nodeSet = new Set(component);
        return Object.freeze({
          id: cycleId(component),
          nodeIds: component,
          edges: Object.freeze(
            edges
              .filter((edge) => nodeSet.has(edge.fromNodeId) && nodeSet.has(edge.toNodeId))
              .sort(compareEdges),
          ),
        });
      })
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

function createBatchSourceIds(
  events: readonly TemporalEvent[],
): readonly [SourceId, ...SourceId[]] {
  const sourceIds = new Set<SourceId>();
  for (const event of events) {
    for (const sourceId of event.sourceIds) {
      sourceIds.add(sourceId);
    }
  }
  return createSourceIdTuple(sourceIds);
}

function sourceIdsForNewlyUnblocked(
  events: readonly TemporalEvent[],
  blockers: readonly DependencyReplayEdge[],
  blockedNodeId: GraphNodeId,
  statesBefore: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
  statesAfter: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
): readonly [SourceId, ...SourceId[]] {
  const edgeKeys = new Set(blockers.map(edgeKey));
  const sourceIds = new Set<SourceId>();
  for (const event of events) {
    if (event.kind === "relation") {
      if (event.action === "removed" && edgeKeys.has(edgeKey(event.edge))) {
        for (const sourceId of event.sourceIds) {
          sourceIds.add(sourceId);
        }
      }
      continue;
    }
    const beforeState = statesBefore.get(event.nodeId);
    const afterState = statesAfter.get(event.nodeId);
    const stateChanged = beforeState !== afterState;
    const isBlockedNode = event.nodeId === blockedNodeId;
    const isBlocker = blockers.some((edge) => edge.fromNodeId === event.nodeId);
    if (stateChanged && (isBlockedNode || isBlocker)) {
      for (const sourceId of event.sourceIds) {
        sourceIds.add(sourceId);
      }
    }
  }
  if (sourceIds.size === 0) {
    return createBatchSourceIds(events);
  }
  return createSourceIdTuple(sourceIds);
}

function sourceIdsForCycleCreation(
  events: readonly TemporalEvent[],
  cycle: TemporalBlocksCycle,
  statesBefore: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
  statesAfter: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
): readonly [SourceId, ...SourceId[]] {
  const cycleEdgeKeys = new Set(cycle.edges.map(edgeKey));
  const cycleNodeIds = new Set(cycle.nodeIds);
  const sourceIds = new Set<SourceId>();
  for (const event of events) {
    if (event.kind === "relation") {
      if (event.action === "added" && cycleEdgeKeys.has(edgeKey(event.edge))) {
        for (const sourceId of event.sourceIds) {
          sourceIds.add(sourceId);
        }
      }
      continue;
    }
    const beforeState = statesBefore.get(event.nodeId);
    const afterState = statesAfter.get(event.nodeId);
    if (cycleNodeIds.has(event.nodeId) && beforeState !== "open" && afterState === "open") {
      for (const sourceId of event.sourceIds) {
        sourceIds.add(sourceId);
      }
    }
  }
  if (sourceIds.size === 0) {
    return createBatchSourceIds(events);
  }
  return createSourceIdTuple(sourceIds);
}

function createExactFact<Value>(value: Value): TemporalBlocksFactResult<Value> {
  return Object.freeze({
    status: "exact",
    value,
  });
}

function createUnknownFact(
  mark: UnknownMark,
): TemporalBlocksFactResult<TemporalBlocksNewlyUnblockedFact> {
  if (mark.scope === "global") {
    const nodeIds: readonly [] = Object.freeze([]);
    return Object.freeze({
      status: "unknown",
      scope: "global",
      nodeIds,
      reason: mark.reason,
    });
  }
  return Object.freeze({
    status: "unknown",
    scope: "node",
    nodeIds: createNodeIdTuple(new Set(mark.nodeIds), "unknown factのnodeがありません"),
    reason: mark.reason,
  });
}

function createUnknownCycleFact(
  mark: UnknownMark,
): TemporalBlocksFactResult<TemporalBlocksCycleCreatedFact> {
  if (mark.scope === "global") {
    const nodeIds: readonly [] = Object.freeze([]);
    return Object.freeze({
      status: "unknown",
      scope: "global",
      nodeIds,
      reason: mark.reason,
    });
  }
  return Object.freeze({
    status: "unknown",
    scope: "node",
    nodeIds: createNodeIdTuple(new Set(mark.nodeIds), "unknown cycle factのnodeがありません"),
    reason: mark.reason,
  });
}

function unknownMarkKey(mark: UnknownMark): string {
  return JSON.stringify([mark.scope, [...mark.nodeIds].sort(compareStrings), mark.reason]);
}

function addUnknownMark(marks: Map<string, UnknownMark>, mark: UnknownMark): void {
  const normalized: UnknownMark = Object.freeze({
    scope: mark.scope,
    nodeIds: Object.freeze([...new Set(mark.nodeIds)].sort(compareStrings)),
    reason: mark.reason,
  });
  marks.set(unknownMarkKey(normalized), normalized);
}

function sameUnknownMark(left: UnknownMark, right: UnknownMark): boolean {
  if (left.scope !== right.scope || left.reason !== right.reason) {
    return false;
  }
  if (left.nodeIds.length !== right.nodeIds.length) {
    return false;
  }
  return left.nodeIds.every((nodeId, index) => nodeId === right.nodeIds[index]);
}

function relationUnknownMarks(
  unresolvedEvents: readonly UnresolvedDependencyReplayEvent[],
): Readonly<{
  newlyUnblocked: readonly UnknownMark[];
  cycles: readonly UnknownMark[];
}> {
  const newlyUnblocked = new Map<string, UnknownMark>();
  const cycles = new Map<string, UnknownMark>();
  for (const event of unresolvedEvents) {
    if (event.direction === "blocked_by") {
      addUnknownMark(newlyUnblocked, {
        scope: "node",
        nodeIds: [event.originItemNodeId],
        reason: "relation_mutation_unresolved",
      });
      addUnknownMark(cycles, {
        scope: "global",
        nodeIds: [],
        reason: "relation_mutation_unresolved",
      });
      continue;
    }
    addUnknownMark(newlyUnblocked, {
      scope: "global",
      nodeIds: [],
      reason: "relation_mutation_unresolved",
    });
    addUnknownMark(cycles, {
      scope: "global",
      nodeIds: [],
      reason: "relation_mutation_unresolved",
    });
  }
  return Object.freeze({
    newlyUnblocked: Object.freeze([...newlyUnblocked.values()]),
    cycles: Object.freeze([...cycles.values()]),
  });
}

function currentStateByNode(
  nodes: readonly TemporalBlocksCurrentNode[],
): ReadonlyMap<GraphNodeId, TemporalBlocksNodeState> {
  return stateMapFromCurrentNodes(nodes);
}

function stateUnknownNodes(
  entries: readonly StateHistoryEntry[],
  currentNodes: readonly TemporalBlocksCurrentNode[],
): ReadonlySet<GraphNodeId> {
  const currentNodeIds = new Set(currentNodes.map((node) => node.nodeId));
  const knownEntryNodeIds = new Set<GraphNodeId>();
  const unknown = new Set<GraphNodeId>();
  for (const entry of entries) {
    if (!currentNodeIds.has(entry.nodeId)) {
      continue;
    }
    knownEntryNodeIds.add(entry.nodeId);
    if (entry.history.status === "unknown") {
      unknown.add(entry.nodeId);
    }
  }
  for (const nodeId of currentNodeIds) {
    if (!knownEntryNodeIds.has(nodeId)) {
      unknown.add(nodeId);
    }
  }
  return unknown;
}

function stateCurrentMismatchNodes(
  entries: readonly StateHistoryEntry[],
  currentNodes: readonly TemporalBlocksCurrentNode[],
): ReadonlySet<GraphNodeId> {
  const currentStateByNodeId = currentStateByNode(currentNodes);
  const mismatched = new Set<GraphNodeId>();
  for (const entry of entries) {
    if (entry.history.status !== "exact") {
      continue;
    }
    const sortedEpochs = [...entry.history.epochs].sort((left, right) => {
      const leftSequence = left.sequence ?? 0;
      const rightSequence = right.sequence ?? 0;
      const timeOrder = compareStrings(left.occurredAt, right.occurredAt);
      if (timeOrder !== 0) {
        return timeOrder;
      }
      const sequenceOrder = compareNumbers(leftSequence, rightSequence);
      return sequenceOrder !== 0 ? sequenceOrder : compareEpochSources(left, right);
    });
    const lastEpoch = sortedEpochs.at(-1);
    if (lastEpoch == null) {
      throw new TypeError(`node ${entry.nodeId} のstate epochが空です`);
    }
    const currentState = currentStateByNodeId.get(entry.nodeId);
    if (currentState != null && currentState !== lastEpoch.state) {
      mismatched.add(entry.nodeId);
    }
  }
  return mismatched;
}

function collectStateEntries(
  histories: readonly TemporalBlocksNodeStateHistory[],
): readonly StateHistoryEntry[] {
  const entriesByNodeId = new Map<GraphNodeId, StateHistoryEntry>();
  for (const entry of histories) {
    if (entriesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`node state history ${entry.nodeId} が重複しています`);
    }
    entriesByNodeId.set(entry.nodeId, entry);
  }
  return Object.freeze([...entriesByNodeId.values()]);
}

function createStateEventSignature(event: StateEpochGroup): string {
  return JSON.stringify([event.kind, event.nodeId, event.state, event.occurredAt, event.sequence]);
}

function validateStateEventSourceConflicts(
  events: readonly StateEpochGroup[],
  sourceSignatures: Map<SourceId, string>,
): void {
  for (const event of events) {
    const signature = createStateEventSignature(event);
    for (const sourceId of event.sourceIds) {
      const existing = sourceSignatures.get(sourceId);
      if (existing != null && existing !== signature) {
        throw new TypeError(`同じsource IDが異なるstate epochを指しています。対象: ${sourceId}`);
      }
      sourceSignatures.set(sourceId, signature);
    }
  }
}

function relationCurrentMismatch(
  relationHistory: TemporalBlocksRelationHistory,
  currentEdges: readonly DependencyReplayEdge[],
  currentNodeIds: ReadonlySet<GraphNodeId>,
  sourceSignatures: Map<SourceId, string>,
): Readonly<{
  groups: readonly RelationEpochGroup[];
  unresolvedEvents: readonly UnresolvedDependencyReplayEvent[];
  mismatch: boolean;
}> {
  if (relationHistory.status === "unknown") {
    return Object.freeze({
      groups: Object.freeze([]),
      unresolvedEvents: Object.freeze([]),
      mismatch: false,
    });
  }
  const deduplicatedEvents = deduplicateRelationEvents(relationHistory.mutations, sourceSignatures);
  const replayed = replayDependencyEvents(deduplicatedEvents);
  const relationGroups = createRelationEpochGroups(deduplicatedEvents, sourceSignatures);
  const localUnknownNodeIds = new Set(
    relationHistory.localUnknowns.map((localUnknown) => localUnknown.originItemNodeId),
  );
  const isComparableEdge = (edge: DependencyReplayEdge): boolean =>
    !localUnknownNodeIds.has(edge.fromNodeId) && !localUnknownNodeIds.has(edge.toNodeId);
  const replayedActiveEdges = replayed.relations
    .filter((relation) => relation.current.status === "active")
    .map((relation) => relation.edge)
    .filter(isComparableEdge);
  const comparableCurrentEdges = currentEdges.filter(isComparableEdge);
  const hasUnknownEndpoint = deduplicatedEvents.some(
    (event) =>
      event.status === "resolved" &&
      isComparableEdge(event) &&
      (!currentNodeIds.has(event.fromNodeId) || !currentNodeIds.has(event.toNodeId)),
  );
  return Object.freeze({
    groups: relationGroups.groups,
    unresolvedEvents: relationGroups.unresolvedEvents,
    mismatch: hasUnknownEndpoint || !sameEdgeSet(replayedActiveEdges, comparableCurrentEdges),
  });
}

function applyStateEvent(
  event: StateEpochGroup,
  statesByNodeId: Map<GraphNodeId, TemporalBlocksNodeState>,
): void {
  const previousState = statesByNodeId.get(event.nodeId);
  if (previousState === "merged" && event.state !== "merged") {
    throw new TypeError(`node ${event.nodeId} のmerged後にstateが変化しています`);
  }
  statesByNodeId.set(event.nodeId, event.state);
}

function applyRelationEvent(
  event: RelationEpochGroup,
  relationsByEdgeKey: Map<string, TemporalRelationState>,
): void {
  const key = edgeKey(event.edge);
  if (event.action === "added") {
    relationsByEdgeKey.set(key, Object.freeze({ edge: event.edge, active: true }));
    return;
  }
  const relation = relationsByEdgeKey.get(key);
  if (relation?.active !== true) {
    return;
  }
  relationsByEdgeKey.set(key, Object.freeze({ edge: relation.edge, active: false }));
}

function unknownStateMarkForUnblocked(
  targetNodeId: GraphNodeId,
  beforeBlockers: readonly DependencyReplayEdge[],
  unknownNodes: ReadonlySet<GraphNodeId>,
  mismatchNodes: ReadonlySet<GraphNodeId>,
): UnknownMark | undefined {
  const relevantNodes = new Set<GraphNodeId>([targetNodeId]);
  for (const edge of beforeBlockers) {
    relevantNodes.add(edge.fromNodeId);
  }
  const affectedUnknownNodes = [...relevantNodes].filter(
    (nodeId) => unknownNodes.has(nodeId) || mismatchNodes.has(nodeId),
  );
  if (affectedUnknownNodes.length === 0) {
    return undefined;
  }
  const reason = [...affectedUnknownNodes].some((nodeId) => mismatchNodes.has(nodeId))
    ? "state_history_current_mismatch"
    : "state_history_unavailable";
  return {
    scope: "node",
    nodeIds: affectedUnknownNodes,
    reason,
  };
}

function createNewlyUnblockedFact(
  nodeId: GraphNodeId,
  occurredAt: UtcIsoDateTime,
  beforeBlockers: readonly DependencyReplayEdge[],
  events: readonly TemporalEvent[],
  statesBefore: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
  statesAfter: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
): TemporalBlocksNewlyUnblockedFact {
  return Object.freeze({
    blockedNodeId: nodeId,
    occurredAt,
    sourceIds: sourceIdsForNewlyUnblocked(
      events,
      beforeBlockers,
      nodeId,
      statesBefore,
      statesAfter,
    ),
    blockerNodeIds: createNodeIdTuple(
      new Set(beforeBlockers.map((edge) => edge.fromNodeId)),
      `node ${nodeId} のblockerがありません`,
    ),
  });
}

function createCycleCreatedFact(
  cycle: TemporalBlocksCycle,
  occurredAt: UtcIsoDateTime,
  events: readonly TemporalEvent[],
  statesBefore: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
  statesAfter: ReadonlyMap<GraphNodeId, TemporalBlocksNodeState>,
): TemporalBlocksCycleCreatedFact {
  return Object.freeze({
    id: cycle.id,
    nodeIds: cycle.nodeIds,
    occurredAt,
    sourceIds: sourceIdsForCycleCreation(events, cycle, statesBefore, statesAfter),
  });
}

function replayFacts(
  input: TemporalBlocksGraphReplayInput,
  current: TemporalBlocksCurrentGraph,
  stateEntries: readonly StateHistoryEntry[],
  stateEvents: readonly StateEpochGroup[],
  relationEvents: readonly RelationEpochGroup[],
  unresolvedEvents: readonly UnresolvedDependencyReplayEvent[],
  relationMismatch: boolean,
): Readonly<{
  newlyUnblockedFacts: readonly TemporalBlocksFactResult<TemporalBlocksNewlyUnblockedFact>[];
  cycleCreatedFacts: readonly TemporalBlocksFactResult<TemporalBlocksCycleCreatedFact>[];
}> {
  const unknownNodes = stateUnknownNodes(stateEntries, current.nodes);
  const mismatchNodes = stateCurrentMismatchNodes(stateEntries, current.nodes);
  const relationNodeIds = new Set<GraphNodeId>();
  for (const edge of current.canonicalBlocksEdges) {
    relationNodeIds.add(edge.fromNodeId);
    relationNodeIds.add(edge.toNodeId);
  }
  for (const event of relationEvents) {
    relationNodeIds.add(event.edge.fromNodeId);
    relationNodeIds.add(event.edge.toNodeId);
  }
  const stateEventsBySource = new Map<SourceId, string>();
  validateStateEventSourceConflicts(stateEvents, stateEventsBySource);
  const events = Object.freeze([...stateEvents, ...relationEvents].sort(compareEventPosition));
  const batches = createBatches(events);
  const statesByNodeId = new Map<GraphNodeId, TemporalBlocksNodeState>();
  const relationsByEdgeKey = new Map<string, TemporalRelationState>();
  const newlyUnblockedFacts: TemporalBlocksFactResult<TemporalBlocksNewlyUnblockedFact>[] = [];
  const cycleCreatedFacts: TemporalBlocksFactResult<TemporalBlocksCycleCreatedFact>[] = [];
  const unknownNewlyUnblockedMarks = new Map<string, UnknownMark>();
  const unknownCycleMarks = new Map<string, UnknownMark>();
  const unresolvedMarks = relationUnknownMarks(unresolvedEvents);
  for (const mark of unresolvedMarks.newlyUnblocked) {
    addUnknownMark(unknownNewlyUnblockedMarks, mark);
  }
  for (const mark of unresolvedMarks.cycles) {
    addUnknownMark(unknownCycleMarks, mark);
  }
  if (input.relationHistory.status === "exact") {
    for (const localUnknown of input.relationHistory.localUnknowns) {
      const mark: UnknownMark = {
        scope: "node",
        nodeIds: [localUnknown.originItemNodeId],
        reason: "relation_mutation_unresolved",
      };
      addUnknownMark(unknownNewlyUnblockedMarks, mark);
      addUnknownMark(unknownCycleMarks, mark);
    }
  }

  if (input.relationHistory.status === "unknown") {
    addUnknownMark(unknownNewlyUnblockedMarks, {
      scope: "global",
      nodeIds: [],
      reason: "relation_history_unavailable",
    });
    addUnknownMark(unknownCycleMarks, {
      scope: "global",
      nodeIds: [],
      reason: "relation_history_unavailable",
    });
  }
  if (relationMismatch) {
    addUnknownMark(unknownNewlyUnblockedMarks, {
      scope: "global",
      nodeIds: [],
      reason: "relation_history_current_mismatch",
    });
    addUnknownMark(unknownCycleMarks, {
      scope: "global",
      nodeIds: [],
      reason: "relation_history_current_mismatch",
    });
  }
  for (const nodeId of unknownNodes) {
    if (!relationNodeIds.has(nodeId)) {
      continue;
    }
    addUnknownMark(unknownNewlyUnblockedMarks, {
      scope: "node",
      nodeIds: [nodeId],
      reason: "state_history_unavailable",
    });
    addUnknownMark(unknownCycleMarks, {
      scope: "node",
      nodeIds: [nodeId],
      reason: "state_history_unavailable",
    });
  }
  for (const nodeId of mismatchNodes) {
    if (!relationNodeIds.has(nodeId)) {
      continue;
    }
    addUnknownMark(unknownNewlyUnblockedMarks, {
      scope: "node",
      nodeIds: [nodeId],
      reason: "state_history_current_mismatch",
    });
    addUnknownMark(unknownCycleMarks, {
      scope: "node",
      nodeIds: [nodeId],
      reason: "state_history_current_mismatch",
    });
  }

  for (const batch of batches) {
    const statesBefore = new Map(statesByNodeId);
    const beforeEdges = effectiveEdges(relationsByEdgeKey, statesByNodeId);
    const beforeCycles = cyclesForGraph(
      [...statesByNodeId.entries()]
        .filter(([, state]) => state === "open")
        .map(([nodeId]) => nodeId),
      beforeEdges,
    );
    const beforeIncomingByNodeId = new Map<GraphNodeId, readonly DependencyReplayEdge[]>();
    for (const node of current.nodes) {
      beforeIncomingByNodeId.set(node.nodeId, incomingEdges(node.nodeId, beforeEdges));
    }
    for (const event of batch.events) {
      if (event.kind === "state") {
        applyStateEvent(event, statesByNodeId);
      } else {
        applyRelationEvent(event, relationsByEdgeKey);
      }
    }
    const afterEdges = effectiveEdges(relationsByEdgeKey, statesByNodeId);
    const afterCycles = cyclesForGraph(
      [...statesByNodeId.entries()]
        .filter(([, state]) => state === "open")
        .map(([nodeId]) => nodeId),
      afterEdges,
    );
    const beforeCycleIds = new Set(beforeCycles.map((cycle) => cycle.id));
    for (const cycle of afterCycles) {
      if (beforeCycleIds.has(cycle.id)) {
        continue;
      }
      const unknownCycleMark = [...unknownCycleMarks.values()].find(
        (mark) =>
          mark.scope === "global" || mark.nodeIds.some((nodeId) => cycle.nodeIds.includes(nodeId)),
      );
      if (unknownCycleMark != null) {
        cycleCreatedFacts.push(createUnknownCycleFact(unknownCycleMark));
        continue;
      }
      cycleCreatedFacts.push(
        createExactFact(
          createCycleCreatedFact(
            cycle,
            batch.occurredAt,
            batch.events,
            statesBefore,
            statesByNodeId,
          ),
        ),
      );
    }
    const afterIncomingByNodeId = new Map<GraphNodeId, readonly DependencyReplayEdge[]>();
    for (const node of current.nodes) {
      afterIncomingByNodeId.set(node.nodeId, incomingEdges(node.nodeId, afterEdges));
    }
    for (const node of current.nodes) {
      const beforeBlockers = beforeIncomingByNodeId.get(node.nodeId);
      const afterBlockers = afterIncomingByNodeId.get(node.nodeId);
      assertNonNullable(beforeBlockers, `node ${node.nodeId} の変更前blockerがありません`);
      assertNonNullable(afterBlockers, `node ${node.nodeId} の変更後blockerがありません`);
      const beforeState = statesBefore.get(node.nodeId);
      const afterState = statesByNodeId.get(node.nodeId);
      if (beforeBlockers.length === 0 || afterBlockers.length !== 0 || afterState !== "open") {
        continue;
      }
      if (beforeState !== "open") {
        continue;
      }
      const unknownMark = unknownStateMarkForUnblocked(
        node.nodeId,
        beforeBlockers,
        unknownNodes,
        mismatchNodes,
      );
      if (unknownMark != null) {
        addUnknownMark(unknownNewlyUnblockedMarks, unknownMark);
        newlyUnblockedFacts.push(createUnknownFact(unknownMark));
        continue;
      }
      const relationUnknownForNode = [...unknownNewlyUnblockedMarks.values()].find(
        (mark) =>
          mark.scope === "global" ||
          mark.nodeIds.some(
            (nodeId) =>
              nodeId === node.nodeId ||
              beforeBlockers.some((blocker) => blocker.fromNodeId === nodeId),
          ),
      );
      if (relationUnknownForNode != null) {
        newlyUnblockedFacts.push(createUnknownFact(relationUnknownForNode));
        continue;
      }
      newlyUnblockedFacts.push(
        createExactFact(
          createNewlyUnblockedFact(
            node.nodeId,
            batch.occurredAt,
            beforeBlockers,
            batch.events,
            statesBefore,
            statesByNodeId,
          ),
        ),
      );
    }
  }
  for (const mark of unknownNewlyUnblockedMarks.values()) {
    const alreadyReturned = newlyUnblockedFacts.some(
      (fact) =>
        fact.status === "unknown" &&
        sameUnknownMark(
          {
            scope: fact.scope,
            nodeIds: fact.nodeIds,
            reason: fact.reason,
          },
          mark,
        ),
    );
    if (!alreadyReturned) {
      newlyUnblockedFacts.push(createUnknownFact(mark));
    }
  }
  for (const mark of unknownCycleMarks.values()) {
    const alreadyReturned = cycleCreatedFacts.some(
      (fact) =>
        fact.status === "unknown" &&
        sameUnknownMark(
          {
            scope: fact.scope,
            nodeIds: fact.nodeIds,
            reason: fact.reason,
          },
          mark,
        ),
    );
    if (!alreadyReturned) {
      cycleCreatedFacts.push(createUnknownCycleFact(mark));
    }
  }
  return Object.freeze({
    newlyUnblockedFacts: Object.freeze(newlyUnblockedFacts),
    cycleCreatedFacts: Object.freeze(cycleCreatedFacts),
  });
}

/** 現在値とGitHub履歴からblocks graphのtemporal factを復元する。 */
export function replayTemporalBlocksGraph(
  input: TemporalBlocksGraphReplayInput,
): TemporalBlocksGraphReplayResult {
  validateInput(input);
  const current = currentGraph(input);
  const stateEntries = collectStateEntries(input.nodeStateHistories);
  validateStateTransitions(stateEntries);
  const sourceSignatures = new Map<SourceId, string>();
  const stateEvents = createStateEpochGroups(stateEntries, sourceSignatures);
  const relationReplay = relationCurrentMismatch(
    input.relationHistory,
    current.canonicalBlocksEdges,
    new Set(current.nodes.map((node) => node.nodeId)),
    sourceSignatures,
  );
  const relationEvents = relationReplay.groups;
  const facts = replayFacts(
    input,
    current,
    stateEntries,
    stateEvents,
    relationEvents,
    relationReplay.unresolvedEvents,
    relationReplay.mismatch,
  );
  return Object.freeze({
    currentGraph: current,
    currentCycles: cyclesForGraph(
      current.nodes.filter((node) => node.state === "open").map((node) => node.nodeId),
      current.activeBlocksEdges,
    ),
    newlyUnblockedFacts: facts.newlyUnblockedFacts,
    cycleCreatedFacts: facts.cycleCreatedFacts,
  });
}

import { type GraphNodeId, type SourceId, type UtcIsoDateTime } from "../domain/index.js";

/** 依存関係イベントが行う状態変更。 */
export type DependencyReplayAction = "added" | "removed";

/** 依存関係リプレイへ渡す正規化済みイベント。 */
export type DependencyReplayInputEvent =
  | Readonly<{
      status: "resolved";
      sourceId: SourceId;
      originItemNodeId: GraphNodeId;
      fromNodeId: GraphNodeId;
      toNodeId: GraphNodeId;
      action: DependencyReplayAction;
      occurredAt: UtcIsoDateTime;
      sequence: number;
    }>
  | Readonly<{
      status: "unresolved";
      sourceId: SourceId;
      originItemNodeId: GraphNodeId;
      direction: "blocked_by" | "blocking";
      action: DependencyReplayAction;
      occurredAt: UtcIsoDateTime;
      sequence: number;
      reason: "related_node_unavailable";
    }>;

/** 依存関係リプレイで扱うcanonicalなblocks edge。 */
export type DependencyReplayEdge = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
}>;

/** 依存関係edgeの1区間。 */
export type DependencyReplayInterval =
  | Readonly<{
      status: "active";
      addedAt: UtcIsoDateTime;
      sourceIds: readonly [SourceId, ...SourceId[]];
      lastConfirmedAt: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "removed";
      addedAt: UtcIsoDateTime;
      addedSourceIds: readonly [SourceId, ...SourceId[]];
      removedAt: UtcIsoDateTime;
      removedSourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** 依存関係edgeの全区間と現在状態。 */
export type DependencyReplayRelation = Readonly<{
  edge: DependencyReplayEdge;
  firstSeenAt: UtcIsoDateTime;
  intervals: readonly [DependencyReplayInterval, ...DependencyReplayInterval[]];
  current:
    | Readonly<{
        status: "active";
        lastConfirmedAt: UtcIsoDateTime;
      }>
    | Readonly<{
        status: "inactive";
        removedAt: UtcIsoDateTime;
      }>;
}>;

/** 1件の入力イベントを適用した結果。 */
export type DependencyReplayTransition = Readonly<{
  kind: "added" | "removed" | "confirmed" | "unmatched_removed";
  edge: DependencyReplayEdge;
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** 同時刻に発生した遷移をまとめたbatch。 */
export type DependencyReplayBatch = Readonly<{
  occurredAt: UtcIsoDateTime;
  transitions: readonly [DependencyReplayTransition, ...DependencyReplayTransition[]];
  activeEdges: readonly DependencyReplayEdge[];
}>;

/** 依存関係イベントを再生した結果。 */
export type DependencyReplayResult = Readonly<{
  relations: readonly DependencyReplayRelation[];
  transitions: readonly DependencyReplayTransition[];
  batches: readonly DependencyReplayBatch[];
  unresolvedEvents: readonly Extract<DependencyReplayInputEvent, { status: "unresolved" }>[];
}>;

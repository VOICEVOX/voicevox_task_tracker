import type { GraphNodeId, Relation } from "../../../domain/index.js";
import {
  analyzeGraph,
  type AnalyzeGraphResult,
  type GraphAnalysisSnapshot,
  type ReconciledGraphEdge,
  type RelationCandidateId,
} from "../../../graph/index.js";
import {
  snapshotEffectiveGraphStateByNodeId,
  type StateSnapshot,
} from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { RuntimeState } from "../contracts.js";
import {
  externalGraphAnalysisNode,
  graphAnalysisNodeWithEffectiveState,
} from "../graph-node-input.js";
import { previousSnapshot } from "./snapshot.js";

function persistedRelationCandidateId(value: string): RelationCandidateId {
  if (!value.startsWith("rel:") || value.length === "rel:".length) {
    throw new TypeError(`永続化済みrelation IDの形式が不正です。対象: ${value}`);
  }
  return `rel:${value.slice("rel:".length)}`;
}

function restoredRelationContradictions(relation: Relation): ReconciledGraphEdge["contradictions"] {
  return Object.freeze(
    relation.contradictions.map((contradiction) =>
      Object.freeze({
        verdict: contradiction.verdict,
        confidence: contradiction.confidence,
        evidence: Object.freeze([]),
      }),
    ),
  );
}

function previousGraphEdge(relation: Relation): ReconciledGraphEdge {
  const fields = {
    id: persistedRelationCandidateId(relation.id),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: restoredRelationContradictions(relation),
    aiDependency: relation.aiDependency,
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: relation.removedAt,
  });
}

function previousGraphSnapshot(state: RuntimeState): GraphAnalysisSnapshot | undefined {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return undefined;
  }
  const effectiveStateByNodeId = snapshotEffectiveGraphStateByNodeId(snapshot);
  return Object.freeze({
    nodes: Object.freeze([
      ...snapshot.items.map((item) =>
        graphAnalysisNodeWithEffectiveState(item, effectiveStateByNodeId),
      ),
      ...snapshot.externalReferences.map(externalGraphAnalysisNode),
    ]),
    edges: Object.freeze(snapshot.relations.map(previousGraphEdge)),
  });
}

type AvailablePreviousGraphIndex = Readonly<{
  availability: "available";
  snapshot: GraphAnalysisSnapshot;
  analysis: AnalyzeGraphResult;
  downstreamImpactByNodeId: ReadonlyMap<
    GraphNodeId,
    AnalyzeGraphResult["downstreamImpacts"][number]
  >;
}>;

type PreviousGraphIndex =
  | Readonly<{
      availability: "unavailable";
    }>
  | AvailablePreviousGraphIndex;

const UNAVAILABLE_PREVIOUS_GRAPH_INDEX: PreviousGraphIndex = Object.freeze({
  availability: "unavailable",
});
const previousGraphIndexBySnapshot = new WeakMap<StateSnapshot, AvailablePreviousGraphIndex>();

/** 前回のグラフ解析結果をスナップショット単位で参照する。 */
export function previousGraphIndex(state: RuntimeState): PreviousGraphIndex {
  const stateSnapshot = previousSnapshot(state);
  if (stateSnapshot == null) {
    return UNAVAILABLE_PREVIOUS_GRAPH_INDEX;
  }
  const cached = previousGraphIndexBySnapshot.get(stateSnapshot);
  if (cached != null) {
    return cached;
  }
  const snapshot = previousGraphSnapshot(state);
  assertNonNullable(snapshot, "前回snapshotからgraphを復元できませんでした");
  const analysis = analyzeGraph({
    current: snapshot,
    previous: {
      availability: "unavailable",
    },
  });
  const index: AvailablePreviousGraphIndex = Object.freeze({
    availability: "available",
    snapshot,
    analysis,
    downstreamImpactByNodeId: new Map(
      analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
    ),
  });
  previousGraphIndexBySnapshot.set(stateSnapshot, index);
  return index;
}

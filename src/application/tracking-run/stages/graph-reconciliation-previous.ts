import type { GraphNodeId, Relation, TrackedItemState } from "../../../domain/index.js";
import {
  analyzeGraph,
  type AnalyzeGraphResult,
  type GraphAnalysisSnapshot,
  type ReconciledGraphEdge,
  type RelationCandidateId,
} from "../../../graph/index.js";
import type { PreviousSnapshotProjection } from "../contracts/previous-state.js";
import {
  externalGraphAnalysisNode,
  graphAnalysisNodeWithEffectiveState,
} from "./graph-reconciliation-analysis-node.js";

function previousEdge(relation: Relation): ReconciledGraphEdge {
  if (!relation.id.startsWith("rel:") || relation.id.length === 4) {
    throw new TypeError(`永続化済みrelation IDの形式が不正です。対象: ${relation.id}`);
  }
  const fields = Object.freeze({
    id: `rel:${relation.id.slice(4)}` satisfies RelationCandidateId,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: Object.freeze(
      relation.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
          evidence: Object.freeze([]),
        }),
      ),
    ),
    aiDependency: relation.aiDependency,
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  });
  return relation.active
    ? Object.freeze({ ...fields, active: true })
    : Object.freeze({ ...fields, active: false, removedAt: relation.removedAt });
}

/** 前回の比較用グラフの有無と解析結果。 */
export type PreviousGraphIndex =
  | Readonly<{ availability: "unavailable" }>
  | Readonly<{
      availability: "available";
      snapshot: GraphAnalysisSnapshot;
      analysis: AnalyzeGraphResult;
      downstreamImpactByNodeId: ReadonlyMap<
        GraphNodeId,
        AnalyzeGraphResult["downstreamImpacts"][number]
      >;
    }>;

/** 前回state投影から今回の比較用グラフを一度構築する。 */
export function previousGraphIndex(previous: PreviousSnapshotProjection): PreviousGraphIndex {
  if (previous.status !== "available") {
    return Object.freeze({ availability: "unavailable" });
  }
  const stateByNodeId = new Map<GraphNodeId, TrackedItemState>(previous.effectiveGraphStates);
  if (stateByNodeId.size !== previous.effectiveGraphStates.length) {
    throw new TypeError("前回のeffective graph状態が重複しています");
  }
  const snapshot: GraphAnalysisSnapshot = Object.freeze({
    nodes: Object.freeze([
      ...previous.trackedItems.map((item) =>
        graphAnalysisNodeWithEffectiveState(item, stateByNodeId),
      ),
      ...previous.externalReferences.map(externalGraphAnalysisNode),
    ]),
    edges: Object.freeze(previous.relations.map(previousEdge)),
  });
  const analysis = analyzeGraph({
    current: snapshot,
    previous: Object.freeze({ availability: "unavailable" }),
  });
  return Object.freeze({
    availability: "available",
    snapshot,
    analysis,
    downstreamImpactByNodeId: new Map(
      analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
    ),
  });
}

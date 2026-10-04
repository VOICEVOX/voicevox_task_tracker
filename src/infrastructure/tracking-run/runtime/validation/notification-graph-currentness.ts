import type { GraphFinalItem } from "../../../../application/tracking-run/contracts/graph-final-item.js";
import type { GraphReconciliationResult } from "../../../../application/tracking-run/stages/graph-reconciliation-contracts.js";
import { previousGraphIndex } from "../../../../application/tracking-run/stages/graph-reconciliation-previous.js";
import type { GraphNodeId } from "../../../../domain/index.js";
import {
  analyzeGraph,
  type AnalyzeGraphResult,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type ReconciledGraphEdge,
} from "../../../../graph/index.js";
import { assertNonNullable } from "../../../../util/index.js";
import type { RuntimeState } from "../contracts.js";

function currentEdge(edge: ReconciledGraphEdge): boolean {
  return edge.aiDependency.status === "not_dependent" || edge.aiDependency.status === "current";
}

function graphNodes(
  items: readonly GraphFinalItem[],
  graph: GraphReconciliationResult,
): readonly GraphAnalysisNode[] {
  const states = new Map(graph.effectiveStateByNodeId);
  if (states.size !== graph.effectiveStateByNodeId.length) {
    throw new TypeError("通知対象graphの有効状態が重複しています");
  }
  const tracked = items.map((item): GraphAnalysisNode => {
    const state = states.get(item.nodeId);
    assertNonNullable(state, `通知対象 ${item.nodeId}の有効graph状態がありません`);
    return Object.freeze({
      kind: item.type,
      nodeId: item.nodeId,
      repositoryId: item.repositoryId,
      state,
      directNotification: "eligible",
    });
  });
  const external = graph.externalReferences.map((reference): GraphAnalysisNode =>
    Object.freeze({
      kind: reference.kind,
      nodeId: reference.nodeId,
      repositoryFullName: reference.repositoryFullName,
      state: reference.state,
      directNotification: reference.directNotification,
    }),
  );
  return Object.freeze([...tracked, ...external]);
}

/** 最終graphの現在値で確認済みの支持辺から通知用指標を計算する。 */
export function currentNotificationGraph(
  state: RuntimeState,
  items: readonly GraphFinalItem[],
  graph: GraphReconciliationResult,
): Readonly<{
  analysis: AnalyzeGraphResult;
  previousAnalysis: AnalyzeGraphResult | undefined;
  unverifiedOpenBlockerNodeIds: ReadonlySet<GraphNodeId>;
}> {
  const current: GraphAnalysisSnapshot = Object.freeze({
    nodes: graphNodes(items, graph),
    edges: Object.freeze(graph.edges.filter(currentEdge)),
  });
  const previousIndex = previousGraphIndex(state.previousState.snapshot);
  const previous: GraphAnalysisSnapshot | undefined =
    previousIndex.availability === "available"
      ? Object.freeze({
          nodes: previousIndex.snapshot.nodes,
          edges: Object.freeze(previousIndex.snapshot.edges.filter(currentEdge)),
        })
      : undefined;
  const analysis = analyzeGraph({
    current,
    previous:
      previous == null
        ? Object.freeze({ availability: "unavailable" })
        : Object.freeze({ availability: "available", snapshot: previous }),
  });
  const previousAnalysis =
    previous == null
      ? undefined
      : analyzeGraph({
          current: previous,
          previous: Object.freeze({ availability: "unavailable" }),
        });
  const openNodeIds = new Set<GraphNodeId>(
    current.nodes.filter((node) => node.state === "open").map((node) => node.nodeId),
  );
  const unverifiedOpenBlockerNodeIds = new Set<GraphNodeId>();
  for (const edge of graph.edges) {
    if (
      edge.active &&
      edge.type === "blocks" &&
      !currentEdge(edge) &&
      openNodeIds.has(edge.fromNodeId) &&
      openNodeIds.has(edge.toNodeId)
    ) {
      unverifiedOpenBlockerNodeIds.add(edge.toNodeId);
    }
  }
  return Object.freeze({ analysis, previousAnalysis, unverifiedOpenBlockerNodeIds });
}

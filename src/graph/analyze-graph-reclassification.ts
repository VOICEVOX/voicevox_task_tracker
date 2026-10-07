import { type Evidence, type GraphNodeId } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  compareGraphEdges,
  compareStrings,
  connectedComponentId,
  createAdjacencyEntry,
  freezeAdjacency,
  isOpenNode,
  isTrackedNode,
  nonEmptyGraphNodeIds,
  nonEmptyReclassificationReasons,
  nonEmptyRepositoryKeys,
  repositoryKey,
  type ActiveGraphEdge,
  type IndexedSnapshot,
} from "./analyze-graph-core.js";
import {
  type ConnectedComponent,
  type GraphAnalysisNode,
  type ReclassificationReason,
  type ReclassificationTarget,
  type TrackedGraphAnalysisNode,
} from "./analyze-graph-types.js";
import { type ReconciledGraphEdge } from "./reconcile-graph-types.js";

/** 連結成分をgraph結果へ投影する。 */
export function createConnectedComponents(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  activeEdges: readonly ActiveGraphEdge[],
): readonly ConnectedComponent[] {
  const activeEdgeNodeIds = new Set<GraphNodeId>(
    activeEdges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]),
  );
  const nodeIds = Object.freeze(
    [...nodesById.values()]
      .filter((node) => isTrackedNode(node) || activeEdgeNodeIds.has(node.nodeId))
      .map((node) => node.nodeId)
      .sort(compareStrings),
  );
  const adjacencyDraft = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const nodeId of nodeIds) {
    adjacencyDraft.set(nodeId, new Set());
  }
  for (const edge of activeEdges) {
    createAdjacencyEntry(adjacencyDraft, edge.fromNodeId).add(edge.toNodeId);
    createAdjacencyEntry(adjacencyDraft, edge.toNodeId).add(edge.fromNodeId);
  }
  const adjacency = freezeAdjacency(adjacencyDraft, nodeIds);
  const visited = new Set<GraphNodeId>();
  const componentNodeIdsList: (readonly [GraphNodeId, ...GraphNodeId[]])[] = [];
  const componentIndexByNodeId = new Map<GraphNodeId, number>();

  for (const startNodeId of nodeIds) {
    if (visited.has(startNodeId)) {
      continue;
    }
    visited.add(startNodeId);
    const stack = [startNodeId];
    const componentNodeIds: GraphNodeId[] = [];
    while (stack.length > 0) {
      const nodeId = stack.pop();
      assertNonNullable(nodeId, "connected componentの探索stackが空です");
      componentNodeIds.push(nodeId);
      const neighbors = adjacency.get(nodeId);
      assertNonNullable(neighbors, `node ${nodeId}の隣接一覧がありません`);
      for (let neighborIndex = neighbors.length - 1; neighborIndex >= 0; neighborIndex -= 1) {
        const neighbor: GraphNodeId | undefined = neighbors[neighborIndex];
        assertNonNullable(neighbor, `node ${nodeId}の隣接一覧に不正な値があります`);
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    componentNodeIds.sort(compareStrings);
    const component = nonEmptyGraphNodeIds(
      componentNodeIds,
      "connected componentにnodeがありません",
    );
    const componentIndex = componentNodeIdsList.length;
    componentNodeIdsList.push(component);
    for (const nodeId of component) {
      componentIndexByNodeId.set(nodeId, componentIndex);
    }
  }

  const edgesByComponent: ActiveGraphEdge[][] = componentNodeIdsList.map(() => []);
  for (const edge of activeEdges) {
    const componentIndex = componentIndexByNodeId.get(edge.fromNodeId);
    assertNonNullable(componentIndex, `edge ${edge.id}のconnected componentがありません`);
    const componentEdges = edgesByComponent[componentIndex];
    assertNonNullable(
      componentEdges,
      `connected component ${componentIndex.toString()}のedge一覧がありません`,
    );
    componentEdges.push(edge);
  }

  const components: ConnectedComponent[] = componentNodeIdsList.map(
    (componentNodeIds, componentIndex): ConnectedComponent => {
      const keys = [
        ...new Set(
          componentNodeIds.map((nodeId) => {
            const node = nodesById.get(nodeId);
            assertNonNullable(node, `node ${nodeId}がありません`);
            return repositoryKey(node);
          }),
        ),
      ].sort(compareStrings);
      const componentEdges = edgesByComponent[componentIndex];
      assertNonNullable(
        componentEdges,
        `connected component ${componentIndex.toString()}のedge一覧がありません`,
      );
      return Object.freeze({
        id: connectedComponentId(componentNodeIds),
        nodeIds: componentNodeIds,
        repositoryKeys: nonEmptyRepositoryKeys(keys, "connected componentにリポジトリがありません"),
        edges: Object.freeze(componentEdges.sort(compareGraphEdges)),
      });
    },
  );
  components.sort((left, right) => compareStrings(left.nodeIds[0], right.nodeIds[0]));
  return Object.freeze(components);
}

function evidenceSignature(evidence: Evidence): string {
  return JSON.stringify([evidence.sourceId, evidence.supports, evidence.summary]);
}

function edgeDependencySignature(edge: ReconciledGraphEdge): string {
  const contradictions = edge.contradictions
    .map((contradiction) =>
      JSON.stringify([
        contradiction.verdict,
        contradiction.confidence,
        contradiction.evidence.map(evidenceSignature).sort(compareStrings),
      ]),
    )
    .sort(compareStrings);
  return JSON.stringify([
    edge.active,
    edge.fromNodeId,
    edge.toNodeId,
    edge.type,
    edge.provenance,
    edge.confidence,
    edge.authoritative,
    edge.evidence.map(evidenceSignature).sort(compareStrings),
    contradictions,
  ]);
}

function relevantBlocksTarget(edge: ReconciledGraphEdge | undefined): GraphNodeId | undefined {
  if (edge?.active === true && edge.type === "blocks") {
    return edge.toNodeId;
  }
  return undefined;
}

function addReclassificationReason(
  reasonsByNodeId: Map<GraphNodeId, Set<ReclassificationReason>>,
  nodeId: GraphNodeId | undefined,
  reason: ReclassificationReason,
): void {
  if (nodeId == null) {
    return;
  }
  const reasons = reasonsByNodeId.get(nodeId);
  if (reasons == null) {
    reasonsByNodeId.set(nodeId, new Set([reason]));
    return;
  }
  reasons.add(reason);
}

function outgoingBlocksTargets(
  snapshot: IndexedSnapshot,
  nodeId: GraphNodeId,
): readonly GraphNodeId[] {
  return Object.freeze(
    [
      ...new Set(
        snapshot.activeEdges
          .filter((edge) => edge.type === "blocks" && edge.fromNodeId === nodeId)
          .map((edge) => edge.toNodeId),
      ),
    ].sort(compareStrings),
  );
}

function effectiveBlockersByNodeId(
  snapshot: IndexedSnapshot,
): ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>> {
  const blockers = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const edge of snapshot.effectiveBlocksEdges) {
    const existing = blockers.get(edge.toNodeId);
    if (existing == null) {
      blockers.set(edge.toNodeId, new Set([edge.fromNodeId]));
      continue;
    }
    existing.add(edge.fromNodeId);
  }
  return blockers;
}

/** 再分類が必要な対象を算出する。 */
export function createReclassificationTargets(
  current: IndexedSnapshot,
  previous: IndexedSnapshot | undefined,
): Readonly<{
  targets: readonly ReclassificationTarget[];
  newlyUnblockedNodeIds: readonly TrackedGraphAnalysisNode["nodeId"][];
}> {
  if (previous == null) {
    return Object.freeze({
      targets: Object.freeze([]),
      newlyUnblockedNodeIds: Object.freeze([]),
    });
  }

  const reasonsByNodeId = new Map<GraphNodeId, Set<ReclassificationReason>>();
  const allNodeIds = [...new Set([...previous.nodesById.keys(), ...current.nodesById.keys()])].sort(
    compareStrings,
  );
  for (const nodeId of allNodeIds) {
    const previousNode = previous.nodesById.get(nodeId);
    const currentNode = current.nodesById.get(nodeId);
    if (previousNode?.state === currentNode?.state) {
      continue;
    }
    const targets = new Set([
      ...outgoingBlocksTargets(previous, nodeId),
      ...outgoingBlocksTargets(current, nodeId),
    ]);
    for (const targetNodeId of targets) {
      addReclassificationReason(reasonsByNodeId, targetNodeId, "dependency_state_changed");
    }
  }

  const allEdgeIds = [...new Set([...previous.edgesById.keys(), ...current.edgesById.keys()])].sort(
    compareStrings,
  );
  for (const edgeId of allEdgeIds) {
    const previousEdge = previous.edgesById.get(edgeId);
    const currentEdge = current.edgesById.get(edgeId);
    if (
      previousEdge != null &&
      currentEdge != null &&
      edgeDependencySignature(previousEdge) === edgeDependencySignature(currentEdge)
    ) {
      continue;
    }
    addReclassificationReason(
      reasonsByNodeId,
      relevantBlocksTarget(previousEdge),
      "dependency_edge_changed",
    );
    addReclassificationReason(
      reasonsByNodeId,
      relevantBlocksTarget(currentEdge),
      "dependency_edge_changed",
    );
  }

  const previousBlockers = effectiveBlockersByNodeId(previous);
  const currentBlockers = effectiveBlockersByNodeId(current);
  const newlyUnblockedNodeIdsDraft: TrackedGraphAnalysisNode["nodeId"][] = [];
  for (const node of current.nodesById.values()) {
    if (
      isTrackedNode(node) &&
      isOpenNode(node) &&
      (previousBlockers.get(node.nodeId)?.size ?? 0) > 0 &&
      (currentBlockers.get(node.nodeId)?.size ?? 0) === 0
    ) {
      newlyUnblockedNodeIdsDraft.push(node.nodeId);
    }
  }
  const newlyUnblockedNodeIds = Object.freeze(newlyUnblockedNodeIdsDraft.sort(compareStrings));
  const newlyUnblockedNodeIdSet = new Set<GraphNodeId>(newlyUnblockedNodeIds);
  const reasonOrder = [
    "dependency_state_changed",
    "dependency_edge_changed",
  ] satisfies readonly ReclassificationReason[];
  const targets = Object.freeze(
    [...reasonsByNodeId.entries()]
      .filter(([nodeId]) => {
        const node = current.nodesById.get(nodeId);
        return node != null && isTrackedNode(node) && isOpenNode(node);
      })
      .sort(([leftNodeId], [rightNodeId]) => compareStrings(leftNodeId, rightNodeId))
      .map(([nodeId, reasonSet]) => {
        const node = current.nodesById.get(nodeId);
        assertNonNullable(node, `再分類対象node ${nodeId}がありません`);
        if (!isTrackedNode(node)) {
          throw new TypeError(`外部参照node ${nodeId}は再分類できません`);
        }
        const reasons = reasonOrder.filter((reason) => reasonSet.has(reason));
        return Object.freeze({
          nodeId: node.nodeId,
          reasons: nonEmptyReclassificationReasons(
            reasons,
            `再分類対象node ${nodeId}に理由がありません`,
          ),
          newlyUnblocked: newlyUnblockedNodeIdSet.has(node.nodeId),
        });
      }),
  );
  return Object.freeze({
    targets,
    newlyUnblockedNodeIds,
  });
}

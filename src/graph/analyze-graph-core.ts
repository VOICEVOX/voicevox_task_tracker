import { sha256Hex } from "../canonical-json/sha256-hex.js";
import {
  type AiAnalysisDependency,
  type GraphNodeId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  type ConnectedComponentId,
  type DependencyCycle,
  type DependencyCycleId,
  type DownstreamImpact,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type GraphRepositoryKey,
  type ReclassificationReason,
  type TrackedGraphAnalysisNode,
} from "./analyze-graph-types.js";
import {
  type ReconciledGraphEdge,
  type RelationCandidateDecisionProof,
} from "./reconcile-graph-types.js";

export type ActiveGraphEdge = ReconciledGraphEdge & Readonly<{ active: true }>;

export type IndexedSnapshot = Readonly<{
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>;
  edgesById: ReadonlyMap<string, ReconciledGraphEdge>;
  activeEdges: readonly ActiveGraphEdge[];
  effectiveBlocksEdges: readonly ActiveGraphEdge[];
}>;

export type DirectedGraph = Readonly<{
  nodeIds: readonly GraphNodeId[];
  outgoing: ReadonlyMap<GraphNodeId, readonly GraphNodeId[]>;
  incoming: ReadonlyMap<GraphNodeId, readonly GraphNodeId[]>;
}>;

export type StronglyConnectedGraph = Readonly<{
  components: readonly (readonly [GraphNodeId, ...GraphNodeId[]])[];
  componentIndexByNodeId: ReadonlyMap<GraphNodeId, number>;
}>;

export type Reachability = Readonly<{
  nodeIndexById: ReadonlyMap<GraphNodeId, number>;
  reachableNodesByComponent: readonly Uint32Array[];
  reachableRepositoriesByComponent: readonly Uint32Array[];
  repositoryMembership: ReadonlyMap<GraphRepositoryKey, Uint32Array>;
  repositoryIndexByKey: ReadonlyMap<GraphRepositoryKey, number>;
}>;

export type BlocksArc = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
}>;

export type ImpactAnalysis = Readonly<{
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>;
  edges: readonly BlocksArc[];
  graph: DirectedGraph;
  stronglyConnected: StronglyConnectedGraph;
  reachability: Reachability;
  impacts: readonly DownstreamImpact[];
}>;

export type ImpactTraversal = Readonly<{
  graph: DirectedGraph;
  stronglyConnected: StronglyConnectedGraph;
}>;

export type ImpactContributor = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
  dependency: AiAnalysisDependency;
}>;

export type PotentialBlocksArc = BlocksArc &
  Readonly<{
    candidateId: RelationCandidateDecisionProof["candidateId"];
    dependency: AiAnalysisDependency;
    affectsPresence: boolean;
    firstSeenAt:
      Readonly<{ status: "known"; value: UtcIsoDateTime }> | Readonly<{ status: "unknown" }>;
  }>;

/** 文字列を辞書順で比較する。 */
export function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 数値を昇順で比較する。 */
export function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function mapEntry<Key, Value>(key: Key, value: Value): readonly [Key, Value] {
  return Object.freeze([key, value]);
}

/** 空でないgraph node ID列を得る。 */
export function nonEmptyGraphNodeIds(
  nodeIds: readonly GraphNodeId[],
  context: string,
): readonly [GraphNodeId, ...GraphNodeId[]] {
  const [firstNodeId, ...remainingNodeIds] = nodeIds;
  assertNonNullable(firstNodeId, context);
  return Object.freeze([firstNodeId, ...remainingNodeIds]);
}

/** 空でないrepository key列を得る。 */
export function nonEmptyRepositoryKeys(
  keys: readonly GraphRepositoryKey[],
  context: string,
): readonly [GraphRepositoryKey, ...GraphRepositoryKey[]] {
  const [firstKey, ...remainingKeys] = keys;
  assertNonNullable(firstKey, context);
  return Object.freeze([firstKey, ...remainingKeys]);
}

/** 空でない再分類理由列を得る。 */
export function nonEmptyReclassificationReasons(
  reasons: readonly ReclassificationReason[],
  context: string,
): readonly [ReclassificationReason, ...ReclassificationReason[]] {
  const [firstReason, ...remainingReasons] = reasons;
  assertNonNullable(firstReason, context);
  return Object.freeze([firstReason, ...remainingReasons]);
}

/** graph nodeからrepository keyを得る。 */
export function repositoryKey(node: GraphAnalysisNode): GraphRepositoryKey {
  if (node.kind === "external_reference") {
    return `external-public:${node.repositoryFullName}`;
  }
  return `organization:${node.repositoryId}`;
}

/** graph nodeがopenかを判定する。 */
export function isOpenNode(node: GraphAnalysisNode): boolean {
  return node.state === "open";
}

/** graph nodeが追跡対象かを判定する。 */
export function isTrackedNode(node: GraphAnalysisNode): node is TrackedGraphAnalysisNode {
  return node.directNotification === "eligible";
}

function isActiveEdge(edge: ReconciledGraphEdge): edge is ActiveGraphEdge {
  return edge.active;
}

/** snapshotからgraph索引を作る。 */
export function indexSnapshot(snapshot: GraphAnalysisSnapshot, context: string): IndexedSnapshot {
  const nodesById = new Map<GraphNodeId, GraphAnalysisNode>();
  for (const node of snapshot.nodes) {
    if (nodesById.has(node.nodeId)) {
      throw new TypeError(`${context}のnode ID ${node.nodeId}が重複しています`);
    }
    nodesById.set(node.nodeId, node);
  }

  const edgesById = new Map<string, ReconciledGraphEdge>();
  for (const edge of snapshot.edges) {
    if (edgesById.has(edge.id)) {
      throw new TypeError(`${context}のedge ID ${edge.id}が重複しています`);
    }
    edgesById.set(edge.id, edge);
    if (edge.active && (!nodesById.has(edge.fromNodeId) || !nodesById.has(edge.toNodeId))) {
      throw new TypeError(`${context}のactive edge ${edge.id}が存在しないnodeを参照しています`);
    }
  }

  const activeEdges = Object.freeze(snapshot.edges.filter(isActiveEdge).sort(compareGraphEdges));
  const effectiveBlocksEdges = Object.freeze(
    activeEdges.filter((edge) => {
      if (edge.type !== "blocks") {
        return false;
      }
      const fromNode = nodesById.get(edge.fromNodeId);
      const toNode = nodesById.get(edge.toNodeId);
      assertNonNullable(fromNode, `edge ${edge.id}の始点nodeがありません`);
      assertNonNullable(toNode, `edge ${edge.id}の終点nodeがありません`);
      return isOpenNode(fromNode) && isOpenNode(toNode);
    }),
  );

  return Object.freeze({
    nodesById,
    edgesById,
    activeEdges,
    effectiveBlocksEdges,
  });
}

/** graph edgeを安定した順で比較する。 */
export function compareGraphEdges(
  left: ReconciledGraphEdge,
  right: ReconciledGraphEdge,
): -1 | 0 | 1 {
  const idOrder = compareStrings(left.id, right.id);
  if (idOrder !== 0) {
    return idOrder;
  }
  const fromOrder = compareStrings(left.fromNodeId, right.fromNodeId);
  if (fromOrder !== 0) {
    return fromOrder;
  }
  return compareStrings(left.toNodeId, right.toNodeId);
}

/** 隣接関係の初期値を作る。 */
export function createAdjacencyEntry(
  adjacency: Map<GraphNodeId, Set<GraphNodeId>>,
  nodeId: GraphNodeId,
): Set<GraphNodeId> {
  const existing = adjacency.get(nodeId);
  if (existing != null) {
    return existing;
  }
  const created = new Set<GraphNodeId>();
  adjacency.set(nodeId, created);
  return created;
}

/** 隣接関係を決定論的な順序で確定する。 */
export function freezeAdjacency(
  adjacency: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>,
  nodeIds: readonly GraphNodeId[],
): ReadonlyMap<GraphNodeId, readonly GraphNodeId[]> {
  return new Map(
    nodeIds.map((nodeId) => {
      const neighbors = adjacency.get(nodeId);
      assertNonNullable(neighbors, `node ${nodeId}の隣接一覧がありません`);
      return mapEntry(nodeId, Object.freeze([...neighbors].sort(compareStrings)));
    }),
  );
}

/** block関係の有向graphを作る。 */
export function createDirectedBlocksGraph(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly BlocksArc[],
): DirectedGraph {
  const nodeIds = Object.freeze(
    [...nodesById.values()]
      .filter(isOpenNode)
      .map((node) => node.nodeId)
      .sort(compareStrings),
  );
  const outgoingDraft = new Map<GraphNodeId, Set<GraphNodeId>>();
  const incomingDraft = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const nodeId of nodeIds) {
    outgoingDraft.set(nodeId, new Set());
    incomingDraft.set(nodeId, new Set());
  }
  for (const edge of edges) {
    createAdjacencyEntry(outgoingDraft, edge.fromNodeId).add(edge.toNodeId);
    createAdjacencyEntry(incomingDraft, edge.toNodeId).add(edge.fromNodeId);
  }
  return Object.freeze({
    nodeIds,
    outgoing: freezeAdjacency(outgoingDraft, nodeIds),
    incoming: freezeAdjacency(incomingDraft, nodeIds),
  });
}

function finishOrder(graph: DirectedGraph): readonly GraphNodeId[] {
  const visited = new Set<GraphNodeId>();
  const finished: GraphNodeId[] = [];

  for (const startNodeId of graph.nodeIds) {
    if (visited.has(startNodeId)) {
      continue;
    }
    visited.add(startNodeId);
    const stack: {
      nodeId: GraphNodeId;
      nextNeighborIndex: number;
    }[] = [{ nodeId: startNodeId, nextNeighborIndex: 0 }];

    while (stack.length > 0) {
      const frame = stack.at(-1);
      assertNonNullable(frame, "深さ優先探索のstackが空です");
      const neighbors = graph.outgoing.get(frame.nodeId);
      assertNonNullable(neighbors, `node ${frame.nodeId}の出辺一覧がありません`);
      const neighbor = neighbors[frame.nextNeighborIndex];
      if (neighbor != null) {
        frame.nextNeighborIndex += 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push({ nodeId: neighbor, nextNeighborIndex: 0 });
        }
        continue;
      }
      stack.pop();
      finished.push(frame.nodeId);
    }
  }

  return Object.freeze(finished);
}

/** 有向graphの強連結成分を求める。 */
export function stronglyConnectedComponents(graph: DirectedGraph): StronglyConnectedGraph {
  const order = finishOrder(graph);
  const assigned = new Set<GraphNodeId>();
  const components: (readonly [GraphNodeId, ...GraphNodeId[]])[] = [];

  for (let orderIndex = order.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const startNodeId = order[orderIndex];
    assertNonNullable(startNodeId, "強連結成分の探索開始nodeがありません");
    if (assigned.has(startNodeId)) {
      continue;
    }
    assigned.add(startNodeId);
    const stack = [startNodeId];
    const componentNodeIds: GraphNodeId[] = [];
    while (stack.length > 0) {
      const nodeId = stack.pop();
      assertNonNullable(nodeId, "強連結成分の探索stackが空です");
      componentNodeIds.push(nodeId);
      const neighbors = graph.incoming.get(nodeId);
      assertNonNullable(neighbors, `node ${nodeId}の入辺一覧がありません`);
      for (let neighborIndex = neighbors.length - 1; neighborIndex >= 0; neighborIndex -= 1) {
        const neighbor: GraphNodeId | undefined = neighbors[neighborIndex];
        assertNonNullable(neighbor, `node ${nodeId}の入辺に不正な値があります`);
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    componentNodeIds.sort(compareStrings);
    components.push(nonEmptyGraphNodeIds(componentNodeIds, "強連結成分にnodeがありません"));
  }

  components.sort((left, right) => compareStrings(left[0], right[0]));
  const componentIndexByNodeId = new Map<GraphNodeId, number>();
  components.forEach((component, componentIndex) => {
    for (const nodeId of component) {
      componentIndexByNodeId.set(nodeId, componentIndex);
    }
  });
  return Object.freeze({
    components: Object.freeze(components),
    componentIndexByNodeId,
  });
}

function stableDigest(values: readonly string[]): string {
  return sha256Hex(JSON.stringify(values));
}

function dependencyCycleId(nodeIds: readonly GraphNodeId[]): DependencyCycleId {
  return `dependency-cycle:${stableDigest(nodeIds)}`;
}

/** 連結成分の決定論的なIDを作る。 */
export function connectedComponentId(nodeIds: readonly GraphNodeId[]): ConnectedComponentId {
  return `connected-component:${stableDigest(nodeIds)}`;
}

/** block関係の循環を列挙する。 */
export function createDependencyCycles(
  graph: DirectedGraph,
  stronglyConnected: StronglyConnectedGraph,
  edges: readonly ActiveGraphEdge[],
): readonly DependencyCycle[] {
  const selfLoopNodeIds = new Set<GraphNodeId>();
  for (const nodeId of graph.nodeIds) {
    const outgoing = graph.outgoing.get(nodeId);
    assertNonNullable(outgoing, `node ${nodeId}の出辺一覧がありません`);
    if (outgoing.includes(nodeId)) {
      selfLoopNodeIds.add(nodeId);
    }
  }

  const cycles: DependencyCycle[] = stronglyConnected.components
    .filter((component) => component.length >= 2 || selfLoopNodeIds.has(component[0]))
    .map((component): DependencyCycle => {
      const componentNodeIds = new Set(component);
      const cycleEdges = Object.freeze(
        edges
          .filter(
            (edge) => componentNodeIds.has(edge.fromNodeId) && componentNodeIds.has(edge.toNodeId),
          )
          .sort(compareGraphEdges),
      );
      return Object.freeze({
        id: dependencyCycleId(component),
        kind: "dependency_cycle",
        nodeIds: component,
        edges: cycleEdges,
      });
    })
    .sort((left, right) => compareStrings(left.id, right.id));
  return Object.freeze(cycles);
}

/** 対応可能なfrontier nodeを列挙する。 */
export function createActionableFrontier(
  graph: DirectedGraph,
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  dependencyCycles: readonly DependencyCycle[],
): readonly TrackedGraphAnalysisNode["nodeId"][] {
  const cycleNodeIds = new Set(dependencyCycles.flatMap((cycle) => cycle.nodeIds));
  const frontier: TrackedGraphAnalysisNode["nodeId"][] = [];
  for (const nodeId of graph.nodeIds) {
    const node = nodesById.get(nodeId);
    const incoming = graph.incoming.get(nodeId);
    assertNonNullable(node, `node ${nodeId}がありません`);
    assertNonNullable(incoming, `node ${nodeId}の入辺一覧がありません`);
    if (isTrackedNode(node) && incoming.length === 0 && !cycleNodeIds.has(nodeId)) {
      frontier.push(node.nodeId);
    }
  }
  return Object.freeze(frontier);
}

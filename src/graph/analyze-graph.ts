import { createHash } from "node:crypto";

import { z } from "zod";

import { type Evidence, type GraphNodeId } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  type AnalyzeGraphInput,
  type AnalyzeGraphResult,
  type ConnectedComponent,
  type ConnectedComponentId,
  type DependencyCycle,
  type DependencyCycleId,
  type DownstreamImpact,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type GraphRepositoryKey,
  type ReclassificationReason,
  type ReclassificationTarget,
  type TrackedGraphAnalysisNode,
} from "./analyze-graph-types.js";
import { type ReconciledGraphEdge } from "./reconcile-graph-types.js";

type ActiveGraphEdge = ReconciledGraphEdge & Readonly<{ active: true }>;

type IndexedSnapshot = Readonly<{
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>;
  edgesById: ReadonlyMap<string, ReconciledGraphEdge>;
  activeEdges: readonly ActiveGraphEdge[];
  effectiveBlocksEdges: readonly ActiveGraphEdge[];
}>;

type DirectedGraph = Readonly<{
  nodeIds: readonly GraphNodeId[];
  outgoing: ReadonlyMap<GraphNodeId, readonly GraphNodeId[]>;
  incoming: ReadonlyMap<GraphNodeId, readonly GraphNodeId[]>;
}>;

type StronglyConnectedGraph = Readonly<{
  components: readonly (readonly [GraphNodeId, ...GraphNodeId[]])[];
  componentIndexByNodeId: ReadonlyMap<GraphNodeId, number>;
}>;

type Reachability = Readonly<{
  nodeIndexById: ReadonlyMap<GraphNodeId, number>;
  reachableNodesByComponent: readonly Uint32Array[];
  reachableRepositoriesByComponent: readonly Uint32Array[];
  repositoryMembership: ReadonlyMap<GraphRepositoryKey, Uint32Array>;
  repositoryIndexByKey: ReadonlyMap<GraphRepositoryKey, number>;
}>;

const nodeIdSchema = z.string().min(1, "node IDは空にできません").regex(/^\S+$/u, {
  error: "node IDに空白は使えません",
});
const repositoryIdentitySchema = z
  .string()
  .min(1, "リポジトリ識別子は空にできません")
  .regex(/^\S+$/u, {
    error: "リポジトリ識別子に空白は使えません",
  });
const trackedNodeSchema = z.object({
  kind: z.enum(["issue", "pull_request"]),
  nodeId: nodeIdSchema,
  repositoryId: repositoryIdentitySchema,
  state: z.enum(["open", "closed", "merged"]),
  directNotification: z.literal("eligible"),
});
const externalNodeSchema = z.object({
  kind: z.literal("external_reference"),
  nodeId: nodeIdSchema,
  repositoryFullName: repositoryIdentitySchema,
  state: z.enum(["open", "closed", "merged"]),
  directNotification: z.literal("not_eligible"),
});
const evidenceSchema = z.object({
  sourceId: z.string().min(1, "source IDは空にできません"),
  supports: z.enum([
    "status",
    "waiting_on",
    "relation",
    "progress",
    "notification",
    "uncertainty",
    "self_commitment",
  ]),
  summary: z.string().trim().min(1, "根拠の要約は空にできません"),
});
const contradictionSchema = z.object({
  verdict: z.enum([
    "current_is_blocked_by_target",
    "current_blocks_target",
    "current_implements_target",
    "target_is_subtask_of_current",
    "current_is_subtask_of_target",
    "duplicates",
    "related",
    "none",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
});
const graphEdgeSchema = z.object({
  id: z.string().min(1, "edge IDは空にできません"),
  fromNodeId: nodeIdSchema,
  toNodeId: nodeIdSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
    "ai_inference",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
  authoritative: z.boolean(),
  contradictions: z.array(contradictionSchema),
  active: z.boolean(),
});
const snapshotSchema = z.object({
  nodes: z.array(z.discriminatedUnion("kind", [trackedNodeSchema, externalNodeSchema])),
  edges: z.array(graphEdgeSchema),
});
const analyzeGraphInputSchema = z.object({
  current: snapshotSchema,
  previous: z.discriminatedUnion("availability", [
    z.object({
      availability: z.literal("unavailable"),
    }),
    z.object({
      availability: z.literal("available"),
      snapshot: snapshotSchema,
    }),
  ]),
});

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

function mapEntry<Key, Value>(key: Key, value: Value): readonly [Key, Value] {
  return Object.freeze([key, value]);
}

function nonEmptyGraphNodeIds(
  nodeIds: readonly GraphNodeId[],
  context: string,
): readonly [GraphNodeId, ...GraphNodeId[]] {
  const [firstNodeId, ...remainingNodeIds] = nodeIds;
  assertNonNullable(firstNodeId, context);
  return Object.freeze([firstNodeId, ...remainingNodeIds]);
}

function nonEmptyRepositoryKeys(
  keys: readonly GraphRepositoryKey[],
  context: string,
): readonly [GraphRepositoryKey, ...GraphRepositoryKey[]] {
  const [firstKey, ...remainingKeys] = keys;
  assertNonNullable(firstKey, context);
  return Object.freeze([firstKey, ...remainingKeys]);
}

function nonEmptyReclassificationReasons(
  reasons: readonly ReclassificationReason[],
  context: string,
): readonly [ReclassificationReason, ...ReclassificationReason[]] {
  const [firstReason, ...remainingReasons] = reasons;
  assertNonNullable(firstReason, context);
  return Object.freeze([firstReason, ...remainingReasons]);
}

function validateInput(input: AnalyzeGraphInput): void {
  const validation = analyzeGraphInputSchema.safeParse(input);
  if (!validation.success) {
    throw new TypeError("グラフ解析入力が不正です", {
      cause: validation.error,
    });
  }
}

function repositoryKey(node: GraphAnalysisNode): GraphRepositoryKey {
  if (node.kind === "external_reference") {
    return `external-public:${node.repositoryFullName}`;
  }
  return `organization:${node.repositoryId}`;
}

function isOpenNode(node: GraphAnalysisNode): boolean {
  return node.state === "open";
}

function isTrackedNode(node: GraphAnalysisNode): node is TrackedGraphAnalysisNode {
  return node.kind !== "external_reference";
}

function isActiveEdge(edge: ReconciledGraphEdge): edge is ActiveGraphEdge {
  return edge.active;
}

function indexSnapshot(snapshot: GraphAnalysisSnapshot, context: string): IndexedSnapshot {
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

function compareGraphEdges(left: ReconciledGraphEdge, right: ReconciledGraphEdge): -1 | 0 | 1 {
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

function createAdjacencyEntry(
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

function freezeAdjacency(
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

function createDirectedBlocksGraph(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly ActiveGraphEdge[],
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

function stronglyConnectedComponents(graph: DirectedGraph): StronglyConnectedGraph {
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
  return createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex");
}

function dependencyCycleId(nodeIds: readonly GraphNodeId[]): DependencyCycleId {
  return `dependency-cycle:${stableDigest(nodeIds)}`;
}

function connectedComponentId(nodeIds: readonly GraphNodeId[]): ConnectedComponentId {
  return `connected-component:${stableDigest(nodeIds)}`;
}

function createDependencyCycles(
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

function createActionableFrontier(
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

function setBit(bitset: Uint32Array, index: number): void {
  const wordIndex = Math.floor(index / 32);
  const word = bitset[wordIndex];
  assertNonNullable(word, `bitsetのword ${wordIndex.toString()}がありません`);
  bitset[wordIndex] = word | (1 << (index % 32));
}

function unionBitsets(target: Uint32Array, source: Uint32Array): void {
  if (target.length !== source.length) {
    throw new TypeError("結合するbitsetの長さが一致しません");
  }
  for (let wordIndex = 0; wordIndex < target.length; wordIndex += 1) {
    const targetWord = target[wordIndex];
    const sourceWord = source[wordIndex];
    assertNonNullable(targetWord, `結合先bitsetのword ${wordIndex.toString()}がありません`);
    assertNonNullable(sourceWord, `結合元bitsetのword ${wordIndex.toString()}がありません`);
    target[wordIndex] = targetWord | sourceWord;
  }
}

function popcountWord(value: number): number {
  let current = value >>> 0;
  current -= (current >>> 1) & 0x55555555;
  current = (current & 0x33333333) + ((current >>> 2) & 0x33333333);
  return (((current + (current >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function popcount(bitset: Uint32Array): number {
  let count = 0;
  for (const word of bitset) {
    count += popcountWord(word);
  }
  return count;
}

function containsOtherRepositoryNode(
  reachableNodes: Uint32Array,
  repositoryMembers: Uint32Array,
  ownNodeIndex: number,
): boolean {
  if (reachableNodes.length !== repositoryMembers.length) {
    throw new TypeError("到達nodeとリポジトリ所属nodeのbitset長が一致しません");
  }
  const ownWordIndex = Math.floor(ownNodeIndex / 32);
  const ownBit = 1 << (ownNodeIndex % 32);
  for (let wordIndex = 0; wordIndex < reachableNodes.length; wordIndex += 1) {
    const reachableWord = reachableNodes[wordIndex];
    const repositoryWord = repositoryMembers[wordIndex];
    assertNonNullable(reachableWord, `到達node bitsetのword ${wordIndex.toString()}がありません`);
    assertNonNullable(
      repositoryWord,
      `リポジトリ所属bitsetのword ${wordIndex.toString()}がありません`,
    );
    const intersection =
      wordIndex === ownWordIndex
        ? (reachableWord & repositoryWord & ~ownBit) >>> 0
        : (reachableWord & repositoryWord) >>> 0;
    if (intersection !== 0) {
      return true;
    }
  }
  return false;
}

function condensationOutgoing(
  graph: DirectedGraph,
  stronglyConnected: StronglyConnectedGraph,
): readonly (readonly number[])[] {
  const outgoingDraft = stronglyConnected.components.map(() => new Set<number>());
  for (const fromNodeId of graph.nodeIds) {
    const fromComponentIndex = stronglyConnected.componentIndexByNodeId.get(fromNodeId);
    assertNonNullable(fromComponentIndex, `node ${fromNodeId}の強連結成分がありません`);
    const outgoing = graph.outgoing.get(fromNodeId);
    assertNonNullable(outgoing, `node ${fromNodeId}の出辺一覧がありません`);
    for (const toNodeId of outgoing) {
      const toComponentIndex = stronglyConnected.componentIndexByNodeId.get(toNodeId);
      assertNonNullable(toComponentIndex, `node ${toNodeId}の強連結成分がありません`);
      if (fromComponentIndex !== toComponentIndex) {
        const componentOutgoing: Set<number> | undefined = outgoingDraft[fromComponentIndex];
        assertNonNullable(
          componentOutgoing,
          `強連結成分 ${fromComponentIndex.toString()}の出辺一覧がありません`,
        );
        componentOutgoing.add(toComponentIndex);
      }
    }
  }
  return Object.freeze(
    outgoingDraft.map((targets) => Object.freeze([...targets].sort(compareNumbers))),
  );
}

function topologicalOrder(outgoing: readonly (readonly number[])[]): readonly number[] {
  const indegrees = Array.from({ length: outgoing.length }, () => 0);
  for (const targets of outgoing) {
    for (const target of targets) {
      const indegree = indegrees[target];
      assertNonNullable(indegree, `強連結成分 ${target.toString()}の入次数がありません`);
      indegrees[target] = indegree + 1;
    }
  }
  const queue: number[] = [];
  indegrees.forEach((indegree, componentIndex) => {
    if (indegree === 0) {
      queue.push(componentIndex);
    }
  });
  const order: number[] = [];
  for (const componentIndex of queue) {
    order.push(componentIndex);
    const targets = outgoing[componentIndex];
    assertNonNullable(targets, `強連結成分 ${componentIndex.toString()}の出辺一覧がありません`);
    for (const target of targets) {
      const indegree = indegrees[target];
      assertNonNullable(indegree, `強連結成分 ${target.toString()}の入次数がありません`);
      const nextIndegree = indegree - 1;
      indegrees[target] = nextIndegree;
      if (nextIndegree === 0) {
        queue.push(target);
      }
    }
  }
  if (order.length !== outgoing.length) {
    throw new TypeError("強連結成分を縮約したgraphにcycleがあります");
  }
  return Object.freeze(order);
}

function createReachability(
  graph: DirectedGraph,
  stronglyConnected: StronglyConnectedGraph,
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
): Reachability {
  const nodeIds = graph.nodeIds;
  const nodeIndexById = new Map(nodeIds.map((nodeId, nodeIndex) => [nodeId, nodeIndex]));
  const repositoryKeys = Object.freeze(
    [
      ...new Set(
        nodeIds.map((nodeId) => {
          const node = nodesById.get(nodeId);
          assertNonNullable(node, `node ${nodeId}がありません`);
          return repositoryKey(node);
        }),
      ),
    ].sort(compareStrings),
  );
  const repositoryIndexByKey = new Map(
    repositoryKeys.map((key, repositoryIndex) => [key, repositoryIndex]),
  );
  const nodeWordCount = Math.ceil(nodeIds.length / 32);
  const repositoryWordCount = Math.ceil(repositoryKeys.length / 32);
  const reachableNodesByComponent = stronglyConnected.components.map(
    () => new Uint32Array(nodeWordCount),
  );
  const reachableRepositoriesByComponent = stronglyConnected.components.map(
    () => new Uint32Array(repositoryWordCount),
  );
  const repositoryMembership = new Map(
    repositoryKeys.map((key) => [key, new Uint32Array(nodeWordCount)]),
  );

  stronglyConnected.components.forEach((component, componentIndex) => {
    const reachableNodes = reachableNodesByComponent[componentIndex];
    const reachableRepositories = reachableRepositoriesByComponent[componentIndex];
    assertNonNullable(
      reachableNodes,
      `強連結成分 ${componentIndex.toString()}の到達node bitsetがありません`,
    );
    assertNonNullable(
      reachableRepositories,
      `強連結成分 ${componentIndex.toString()}の到達リポジトリbitsetがありません`,
    );
    for (const nodeId of component) {
      const nodeIndex = nodeIndexById.get(nodeId);
      const node = nodesById.get(nodeId);
      assertNonNullable(nodeIndex, `node ${nodeId}のindexがありません`);
      assertNonNullable(node, `node ${nodeId}がありません`);
      const key = repositoryKey(node);
      const repositoryIndex = repositoryIndexByKey.get(key);
      const repositoryMembers = repositoryMembership.get(key);
      assertNonNullable(repositoryIndex, `リポジトリ ${key}のindexがありません`);
      assertNonNullable(repositoryMembers, `リポジトリ ${key}の所属bitsetがありません`);
      setBit(reachableNodes, nodeIndex);
      setBit(reachableRepositories, repositoryIndex);
      setBit(repositoryMembers, nodeIndex);
    }
  });

  const outgoing = condensationOutgoing(graph, stronglyConnected);
  const order = topologicalOrder(outgoing);
  for (let orderIndex = order.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const componentIndex = order[orderIndex];
    assertNonNullable(componentIndex, "逆トポロジカル順序の強連結成分がありません");
    const reachableNodes = reachableNodesByComponent[componentIndex];
    const reachableRepositories = reachableRepositoriesByComponent[componentIndex];
    const targets = outgoing[componentIndex];
    assertNonNullable(
      reachableNodes,
      `強連結成分 ${componentIndex.toString()}の到達node bitsetがありません`,
    );
    assertNonNullable(
      reachableRepositories,
      `強連結成分 ${componentIndex.toString()}の到達リポジトリbitsetがありません`,
    );
    assertNonNullable(targets, `強連結成分 ${componentIndex.toString()}の出辺一覧がありません`);
    for (const target of targets) {
      const targetReachableNodes = reachableNodesByComponent[target];
      const targetReachableRepositories = reachableRepositoriesByComponent[target];
      assertNonNullable(
        targetReachableNodes,
        `強連結成分 ${target.toString()}の到達node bitsetがありません`,
      );
      assertNonNullable(
        targetReachableRepositories,
        `強連結成分 ${target.toString()}の到達リポジトリbitsetがありません`,
      );
      unionBitsets(reachableNodes, targetReachableNodes);
      unionBitsets(reachableRepositories, targetReachableRepositories);
    }
  }

  return Object.freeze({
    nodeIndexById,
    reachableNodesByComponent,
    reachableRepositoriesByComponent,
    repositoryMembership,
    repositoryIndexByKey,
  });
}

function createDownstreamImpacts(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  stronglyConnected: StronglyConnectedGraph,
  reachability: Reachability,
): readonly DownstreamImpact[] {
  const impacts = [...nodesById.values()]
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
    .map((node) => {
      if (!isOpenNode(node)) {
        return Object.freeze({
          nodeId: node.nodeId,
          openNodeCount: 0,
          repositoryCount: 0,
        });
      }
      const componentIndex = stronglyConnected.componentIndexByNodeId.get(node.nodeId);
      const nodeIndex = reachability.nodeIndexById.get(node.nodeId);
      assertNonNullable(componentIndex, `node ${node.nodeId}の強連結成分がありません`);
      assertNonNullable(nodeIndex, `node ${node.nodeId}のindexがありません`);
      const reachableNodes = reachability.reachableNodesByComponent[componentIndex];
      const reachableRepositories = reachability.reachableRepositoriesByComponent[componentIndex];
      assertNonNullable(
        reachableNodes,
        `強連結成分 ${componentIndex.toString()}の到達node bitsetがありません`,
      );
      assertNonNullable(
        reachableRepositories,
        `強連結成分 ${componentIndex.toString()}の到達リポジトリbitsetがありません`,
      );
      const key = repositoryKey(node);
      const repositoryMembers = reachability.repositoryMembership.get(key);
      const repositoryIndex = reachability.repositoryIndexByKey.get(key);
      assertNonNullable(repositoryMembers, `リポジトリ ${key}の所属bitsetがありません`);
      assertNonNullable(repositoryIndex, `リポジトリ ${key}のindexがありません`);
      const repositoryWordIndex = Math.floor(repositoryIndex / 32);
      const repositoryWord = reachableRepositories[repositoryWordIndex];
      assertNonNullable(
        repositoryWord,
        `到達リポジトリbitsetのword ${repositoryWordIndex.toString()}がありません`,
      );
      const ownRepositoryIsReachable = (repositoryWord & (1 << (repositoryIndex % 32))) !== 0;
      const ownRepositoryHasOtherNode = containsOtherRepositoryNode(
        reachableNodes,
        repositoryMembers,
        nodeIndex,
      );
      const repositoryCount =
        popcount(reachableRepositories) -
        (ownRepositoryIsReachable && !ownRepositoryHasOtherNode ? 1 : 0);
      return Object.freeze({
        nodeId: node.nodeId,
        openNodeCount: popcount(reachableNodes) - 1,
        repositoryCount,
      });
    });
  return Object.freeze(impacts);
}

function createConnectedComponents(
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

function createReclassificationTargets(
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

/** 確定graphからcycle、frontier、impact、component、隣接変化を算出する。 */
export function analyzeGraph(input: AnalyzeGraphInput): AnalyzeGraphResult {
  validateInput(input);
  const current = indexSnapshot(input.current, "現在snapshot");
  const previous =
    input.previous.availability === "available"
      ? indexSnapshot(input.previous.snapshot, "前回snapshot")
      : undefined;
  const directedBlocksGraph = createDirectedBlocksGraph(
    current.nodesById,
    current.effectiveBlocksEdges,
  );
  const stronglyConnected = stronglyConnectedComponents(directedBlocksGraph);
  const dependencyCycles = createDependencyCycles(
    directedBlocksGraph,
    stronglyConnected,
    current.effectiveBlocksEdges,
  );
  const reachability = createReachability(
    directedBlocksGraph,
    stronglyConnected,
    current.nodesById,
  );
  const reclassification = createReclassificationTargets(current, previous);

  return Object.freeze({
    dependencyCycles,
    actionableFrontier: createActionableFrontier(
      directedBlocksGraph,
      current.nodesById,
      dependencyCycles,
    ),
    downstreamImpacts: createDownstreamImpacts(current.nodesById, stronglyConnected, reachability),
    connectedComponents: createConnectedComponents(current.nodesById, current.activeEdges),
    reclassificationTargets: reclassification.targets,
    newlyUnblockedNodeIds: reclassification.newlyUnblockedNodeIds,
  });
}

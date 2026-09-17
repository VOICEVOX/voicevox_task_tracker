import { createHash } from "node:crypto";

import { z } from "zod";

import {
  aiAnalysisDependencySchema,
  aiAnalysisDependencyForRelation,
  aiAnalysisDependencyForRelationCandidate,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
  type Evidence,
  type GraphNodeId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import {
  type AnalyzeGraphInput,
  type AnalyzeGraphAiDependenciesInput,
  type AnalyzeGraphAiDependenciesResult,
  type AnalyzeGraphResult,
  type BlockerNodeAiDependency,
  type BlockerSetAiDependency,
  type ConnectedComponent,
  type ConnectedComponentId,
  type DependencyCycle,
  type DependencyCycleId,
  type DownstreamImpact,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type GraphRepositoryKey,
  type NegativeBlockerAiDependency,
  type ReclassificationReason,
  type ReclassificationTarget,
  type RelationSetAiDependency,
  type TrackedGraphAnalysisNode,
} from "./analyze-graph-types.js";
import {
  type ReconciledGraphEdge,
  type RelationCandidateDecisionProof,
} from "./reconcile-graph-types.js";

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

type BlocksArc = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
}>;

type ImpactAnalysis = Readonly<{
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>;
  edges: readonly BlocksArc[];
  graph: DirectedGraph;
  stronglyConnected: StronglyConnectedGraph;
  reachability: Reachability;
  impacts: readonly DownstreamImpact[];
}>;

type ImpactTraversal = Readonly<{
  graph: DirectedGraph;
  stronglyConnected: StronglyConnectedGraph;
}>;

type ImpactContributor = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
  dependency: AiAnalysisDependency;
}>;

type PotentialBlocksArc = BlocksArc &
  Readonly<{
    candidateId: RelationCandidateDecisionProof["candidateId"];
    dependency: AiAnalysisDependency;
    affectsPresence: boolean;
    firstSeenAt:
      Readonly<{ status: "known"; value: UtcIsoDateTime }> | Readonly<{ status: "unknown" }>;
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
const candidateOnlyNodeSchema = z.object({
  kind: z.enum(["issue", "pull_request"]),
  nodeId: nodeIdSchema,
  repositoryId: repositoryIdentitySchema,
  state: z.enum(["open", "closed", "merged"]),
  directNotification: z.literal("not_eligible"),
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
const aiDependencySchema = aiAnalysisDependencySchema;
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
  aiDependency: aiDependencySchema,
  active: z.boolean(),
});
const canonicalRelationSchema = z.strictObject({
  fromNodeId: nodeIdSchema,
  toNodeId: nodeIdSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
});
const relationCandidateResolutionSchema = z.union([
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("active"),
    edgeId: z.string().min(1),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("pending"),
    reason: z.literal("assessment_missing"),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("pending"),
    reason: z.literal("confidence_below_threshold"),
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("rejected"),
    reason: z.literal("verdict_none"),
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("rejected"),
    reason: z.literal("blocker_not_open"),
    confidence: z.number().min(0).max(1),
  }),
]);
const candidateDecisionProofSchema = z.strictObject({
  candidateId: z.string().min(1),
  endpointNodeIds: z.tuple([nodeIdSchema, nodeIdSchema]),
  authority: z.enum(["authoritative", "inferred"]),
  resolution: relationCandidateResolutionSchema,
  dependency: aiAnalysisDependencySchema,
  canonicalRelation: canonicalRelationSchema.optional(),
});
const snapshotSchema = z.object({
  nodes: z.array(z.union([trackedNodeSchema, candidateOnlyNodeSchema, externalNodeSchema])),
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
  return node.directNotification === "eligible";
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

function createImpactAnalysis(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly BlocksArc[],
): ImpactAnalysis {
  const graph = createDirectedBlocksGraph(nodesById, edges);
  const stronglyConnected = stronglyConnectedComponents(graph);
  const reachability = createReachability(graph, stronglyConnected, nodesById);
  return Object.freeze({
    nodesById,
    edges,
    graph,
    stronglyConnected,
    reachability,
    impacts: createDownstreamImpacts(nodesById, stronglyConnected, reachability),
  });
}

function createImpactTraversal(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly BlocksArc[],
): ImpactTraversal {
  const graph = createDirectedBlocksGraph(nodesById, edges);
  return Object.freeze({
    graph,
    stronglyConnected: stronglyConnectedComponents(graph),
  });
}

function downstreamImpactAiDependency(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly ActiveGraphEdge[],
  fullDependencyReachability: Readonly<{
    graph: DirectedGraph;
    stronglyConnected: StronglyConnectedGraph;
    reachability: Reachability;
  }>,
): readonly Readonly<{ nodeId: GraphNodeId; dependency: AiAnalysisDependency }>[] {
  const normalizedEdges = normalizePositiveSupportArcs(edges);
  const unknownEdges = normalizedEdges.filter((edge) => edge.aiDependency.status === "unknown");
  const unverifiedEdges = normalizedEdges.filter(
    (edge) => edge.aiDependency.status === "unverified",
  );
  const currentEdges = normalizedEdges.filter((edge) => edge.aiDependency.status === "current");
  const withoutUnknown =
    unknownEdges.length === 0
      ? fullDependencyReachability
      : createImpactTraversal(
          nodesById,
          normalizedEdges.filter((edge) => edge.aiDependency.status !== "unknown"),
        );
  const clean =
    unknownEdges.length === 0 && unverifiedEdges.length === 0
      ? fullDependencyReachability
      : createImpactTraversal(
          nodesById,
          normalizedEdges.filter(
            (edge) =>
              edge.aiDependency.status === "not_dependent" ||
              edge.aiDependency.status === "current",
          ),
        );
  const native =
    unknownEdges.length === 0 && unverifiedEdges.length === 0 && currentEdges.length === 0
      ? fullDependencyReachability
      : createImpactTraversal(
          nodesById,
          normalizedEdges.filter((edge) => edge.aiDependency.status === "not_dependent"),
        );

  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  const allOpenNodeIds = new Set(fullDependencyReachability.graph.nodeIds);
  const recordContributors = (
    candidateEdges: readonly ActiveGraphEdge[],
    reduced: ImpactTraversal,
  ): void => {
    recordImpactContributors(
      fullDependencyReachability,
      reduced,
      candidateEdges.map((edge) =>
        Object.freeze({
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          dependency: edge.aiDependency,
        }),
      ),
      allOpenNodeIds,
      dependenciesByNodeId,
    );
  };
  recordContributors(unknownEdges, withoutUnknown);
  recordContributors(unverifiedEdges, clean);
  recordContributors(currentEdges, native);

  return Object.freeze(
    [...nodesById.keys()].sort(compareStrings).map((nodeId) => {
      const dependencies = dependenciesByNodeId.get(nodeId);
      return Object.freeze({
        nodeId,
        dependency:
          dependencies == null
            ? Object.freeze({ status: "not_dependent" })
            : combineAiAnalysisDependencies(dependencies),
      });
    }),
  );
}

function aiDependencySignature(dependency: AiAnalysisDependency): string {
  const producers =
    dependency.status === "not_dependent"
      ? undefined
      : dependency.producers
          ?.map((producer) => {
            if (producer.kind === "item_element") {
              return [producer.kind, producer.nodeId, producer.element];
            }
            if (producer.kind === "relation_candidate") {
              return [
                producer.kind,
                producer.candidateId,
                producer.endpointNodeIds[0],
                producer.endpointNodeIds[1],
                producer.producer.nodeId,
                producer.producer.element,
              ];
            }
            return [
              producer.kind,
              producer.relationId,
              producer.producer.nodeId,
              producer.producer.element,
            ];
          })
          .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  return JSON.stringify({
    status: dependency.status,
    ...(dependency.status === "unknown" ? { reason: dependency.reason } : {}),
    ...(producers == null ? {} : { producers }),
  });
}

function validateCandidateDecisionProofs(
  current: IndexedSnapshot,
  proofs: readonly RelationCandidateDecisionProof[],
): readonly RelationCandidateDecisionProof[] {
  const normalized = [...proofs].sort((left, right) =>
    compareStrings(left.candidateId, right.candidateId),
  );
  const seenCandidateIds = new Set<string>();
  for (const proof of normalized) {
    const validation = candidateDecisionProofSchema.safeParse(proof);
    if (!validation.success) {
      throw new TypeError(`関係候補 ${proof.candidateId}の判定proofが不正です`, {
        cause: validation.error,
      });
    }
    if (seenCandidateIds.has(proof.candidateId)) {
      throw new TypeError(`関係候補 ${proof.candidateId}の判定proofが重複しています`);
    }
    seenCandidateIds.add(proof.candidateId);
    const [firstEndpoint, secondEndpoint] = proof.endpointNodeIds;
    if (firstEndpoint === secondEndpoint) {
      throw new TypeError(`関係候補 ${proof.candidateId}は同じendpointを指定できません`);
    }
    if (proof.resolution.candidateId !== proof.candidateId) {
      throw new TypeError(`関係候補 ${proof.candidateId}の判定proof IDが不整合です`);
    }
    if (proof.dependency.status === "unknown" && proof.dependency.reason === "stale_repository") {
      throw new TypeError(`関係候補 ${proof.candidateId}にstale repository AI依存は指定できません`);
    }
    if (proof.authority === "authoritative") {
      if (proof.dependency.status !== "not_dependent") {
        throw new TypeError(
          `authoritative relation ${proof.candidateId}のAI依存はnot_dependentでなければなりません`,
        );
      }
      if (proof.resolution.status !== "active") {
        throw new TypeError(
          `authoritative relation ${proof.candidateId}はactiveでなければなりません`,
        );
      }
    } else {
      if (proof.dependency.status === "not_dependent") {
        throw new TypeError(`推定relation ${proof.candidateId}のAI依存はnot_dependentにできません`);
      }
      const producers = proof.dependency.producers;
      if (producers == null) {
        const producerlessNotRecorded =
          proof.resolution.status !== "active" &&
          proof.dependency.status === "unknown" &&
          proof.dependency.reason === "not_recorded";
        if (!producerlessNotRecorded) {
          throw new TypeError(`推定relation ${proof.candidateId}のAI依存producerがありません`);
        }
      } else {
        const endpointNodeIds = new Set(proof.endpointNodeIds);
        for (const producer of producers) {
          if (producer.kind !== "item_element" || producer.element !== "relations") {
            throw new TypeError(`推定relation ${proof.candidateId}のAI依存producerが不正です`);
          }
          if (!endpointNodeIds.has(producer.nodeId)) {
            throw new TypeError(
              `推定relation ${proof.candidateId}のAI依存producerがendpointではありません`,
            );
          }
        }
      }
    }
    if (proof.resolution.status === "active") {
      if (proof.resolution.edgeId !== proof.candidateId) {
        throw new TypeError(`active relation ${proof.candidateId}のedge IDが不整合です`);
      }
      const canonicalRelation = proof.canonicalRelation;
      if (canonicalRelation == null) {
        throw new TypeError(`active relation ${proof.candidateId}のcanonical relationがありません`);
      }
      const endpointNodeIds = new Set(proof.endpointNodeIds);
      if (
        canonicalRelation.fromNodeId === canonicalRelation.toNodeId ||
        !endpointNodeIds.has(canonicalRelation.fromNodeId) ||
        !endpointNodeIds.has(canonicalRelation.toNodeId)
      ) {
        throw new TypeError(`関係候補 ${proof.candidateId}のcanonical relation endpointが不正です`);
      }
      const edge = current.edgesById.get(proof.candidateId);
      if (edge?.active !== true) {
        throw new TypeError(
          `active relation ${proof.candidateId}に対応するcurrent edgeがありません`,
        );
      }
      if (
        edge.fromNodeId !== canonicalRelation.fromNodeId ||
        edge.toNodeId !== canonicalRelation.toNodeId ||
        edge.type !== canonicalRelation.type
      ) {
        throw new TypeError(
          `active relation ${proof.candidateId}のcanonical relationがcurrent edgeと不一致です`,
        );
      }
      const expectedAuthoritative = proof.authority === "authoritative";
      if (edge.authoritative !== expectedAuthoritative) {
        throw new TypeError(
          `active relation ${proof.candidateId}のauthorityがcurrent edgeと不一致です`,
        );
      }
      if (expectedAuthoritative && edge.provenance !== "native") {
        throw new TypeError(`authoritative relation ${proof.candidateId}のprovenanceが不正です`);
      }
      if (!expectedAuthoritative && edge.provenance === "native") {
        throw new TypeError(`inferred relation ${proof.candidateId}のprovenanceが不正です`);
      }
      const expectedDependency = expectedAuthoritative
        ? Object.freeze({ status: "not_dependent" })
        : aiAnalysisDependencyForRelation(proof.candidateId, proof.dependency);
      if (aiDependencySignature(edge.aiDependency) !== aiDependencySignature(expectedDependency)) {
        throw new TypeError(
          `active relation ${proof.candidateId}のAI依存がcurrent edgeと不一致です`,
        );
      }
    } else if (proof.canonicalRelation != null) {
      throw new TypeError(`未採用relation ${proof.candidateId}にcanonical relationがあります`);
    } else if (current.edgesById.get(proof.candidateId)?.active === true) {
      throw new TypeError(`未採用relation ${proof.candidateId}にactiveなcurrent edgeがあります`);
    }
    for (const endpointNodeId of proof.endpointNodeIds) {
      if (!current.nodesById.has(endpointNodeId)) {
        throw new TypeError(
          `関係候補 ${proof.candidateId}のendpoint ${endpointNodeId}がcurrent graphにありません`,
        );
      }
    }
  }
  return Object.freeze(normalized);
}

function createPublicValueSensitivityIndex(
  current: IndexedSnapshot,
  candidateProofSnapshot: IndexedSnapshot,
): IndexedSnapshot {
  const nodes = [
    ...current.nodesById.values(),
    ...[...candidateProofSnapshot.nodesById.values()]
      .filter((node) => node.kind === "external_reference" && !current.nodesById.has(node.nodeId))
      .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
  ];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const edgesById = new Map(current.edgesById);
  for (const edge of candidateProofSnapshot.edgesById.values()) {
    if (!edgesById.has(edge.id) && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) {
      edgesById.set(edge.id, edge);
    }
  }
  return indexSnapshot(
    Object.freeze({
      nodes: Object.freeze(nodes),
      edges: Object.freeze([...edgesById.values()]),
    }),
    "公開値感度snapshot",
  );
}

function blocksArcKey(arc: BlocksArc): string {
  return JSON.stringify(["blocks", arc.fromNodeId, arc.toNodeId]);
}

function normalizePositiveSupportArcs(
  edges: readonly ActiveGraphEdge[],
): readonly ActiveGraphEdge[] {
  const supportsByArc = new Map<string, ActiveGraphEdge[]>();
  for (const edge of [...edges].sort(compareGraphEdges)) {
    const key = blocksArcKey(edge);
    const supports = supportsByArc.get(key);
    if (supports == null) {
      supportsByArc.set(key, [edge]);
      continue;
    }
    supports.push(edge);
  }
  const normalized: ActiveGraphEdge[] = [];
  for (const supports of supportsByArc.values()) {
    const firstSupport = supports[0];
    assertNonNullable(firstSupport, "positive supportがありません");
    let preferredPriority = dependencyStatusPriority(firstSupport.aiDependency.status);
    for (const support of supports.slice(1)) {
      const priority = dependencyStatusPriority(support.aiDependency.status);
      if (priority < preferredPriority) {
        preferredPriority = priority;
      }
    }
    const preferredSupports = supports.filter(
      (support) => dependencyStatusPriority(support.aiDependency.status) === preferredPriority,
    );
    const representative = preferredSupports[0];
    assertNonNullable(representative, "positive supportの最良supportがありません");
    normalized.push(
      Object.freeze({
        ...representative,
        aiDependency: combineAiAnalysisDependencies(
          preferredSupports.map((support) => support.aiDependency),
        ),
      }),
    );
  }
  return Object.freeze(normalized.sort(compareGraphEdges));
}

function uniqueBlocksArcs(arcs: readonly BlocksArc[]): readonly BlocksArc[] {
  return Object.freeze(
    [...new Map(arcs.map((arc) => [blocksArcKey(arc), arc])).values()].sort((left, right) =>
      compareStrings(blocksArcKey(left), blocksArcKey(right)),
    ),
  );
}

function potentialBlocksArcs(
  current: IndexedSnapshot,
  proofs: readonly RelationCandidateDecisionProof[],
): readonly PotentialBlocksArc[] {
  const existingArcKeys = new Set(
    current.effectiveBlocksEdges.map((edge) =>
      blocksArcKey({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }),
    ),
  );
  const arcs: PotentialBlocksArc[] = [];
  for (const proof of proofs) {
    if (proof.authority !== "inferred") {
      continue;
    }
    if (proof.resolution.status === "rejected" && proof.resolution.reason === "blocker_not_open") {
      continue;
    }
    const [firstEndpoint, secondEndpoint] = proof.endpointNodeIds;
    const firstNode = current.nodesById.get(firstEndpoint);
    const secondNode = current.nodesById.get(secondEndpoint);
    if (
      firstNode == null ||
      secondNode == null ||
      !isOpenNode(firstNode) ||
      !isOpenNode(secondNode)
    ) {
      continue;
    }
    const possibleArcs: readonly BlocksArc[] = Object.freeze([
      Object.freeze({ fromNodeId: firstEndpoint, toNodeId: secondEndpoint }),
      Object.freeze({ fromNodeId: secondEndpoint, toNodeId: firstEndpoint }),
    ]);
    const persistedEdge = current.edgesById.get(proof.candidateId);
    if (
      persistedEdge != null &&
      !(
        (persistedEdge.fromNodeId === firstEndpoint && persistedEdge.toNodeId === secondEndpoint) ||
        (persistedEdge.fromNodeId === secondEndpoint && persistedEdge.toNodeId === firstEndpoint)
      )
    ) {
      throw new TypeError(`関係候補 ${proof.candidateId}のendpointがcurrent edgeと一致しません`);
    }
    if (persistedEdge?.provenance === "native") {
      throw new TypeError(`関係候補 ${proof.candidateId}がnative edge IDと衝突しています`);
    }
    const firstSeenAt =
      persistedEdge == null
        ? Object.freeze({ status: "unknown" })
        : Object.freeze({ status: "known", value: persistedEdge.firstSeenAt });
    for (const arc of possibleArcs) {
      const canonicalRelation = proof.canonicalRelation;
      if (
        canonicalRelation?.type === "blocks" &&
        canonicalRelation.fromNodeId === arc.fromNodeId &&
        canonicalRelation.toNodeId === arc.toNodeId
      ) {
        continue;
      }
      arcs.push(
        Object.freeze({
          ...arc,
          candidateId: proof.candidateId,
          affectsPresence: !existingArcKeys.has(blocksArcKey(arc)),
          firstSeenAt,
          dependency: aiAnalysisDependencyForRelationCandidate(
            proof.candidateId,
            proof.endpointNodeIds,
            proof.dependency,
          ),
        }),
      );
    }
  }
  return Object.freeze(
    arcs.sort((left, right) => {
      const candidateOrder = compareStrings(left.candidateId, right.candidateId);
      if (candidateOrder !== 0) {
        return candidateOrder;
      }
      return compareStrings(blocksArcKey(left), blocksArcKey(right));
    }),
  );
}

function appendDependency(
  dependenciesByNodeId: Map<GraphNodeId, AiAnalysisDependency[]>,
  nodeId: GraphNodeId,
  dependency: AiAnalysisDependency,
): void {
  const dependencies = dependenciesByNodeId.get(nodeId);
  if (dependencies == null) {
    dependenciesByNodeId.set(nodeId, [dependency]);
    return;
  }
  dependencies.push(dependency);
}

function interactionNodeIds(
  cumulativeNodeIds: ReadonlySet<GraphNodeId>,
  lowerFamilyNodeIds: readonly ReadonlySet<GraphNodeId>[],
): ReadonlySet<GraphNodeId> {
  return new Set(
    [...cumulativeNodeIds].filter((nodeId) =>
      lowerFamilyNodeIds.every((nodeIds) => !nodeIds.has(nodeId)),
    ),
  );
}

function crossFamilyInteractionNodeIds(
  cumulativeNodeIds: ReadonlySet<GraphNodeId>,
  familyNodeIds: readonly ReadonlySet<GraphNodeId>[],
): ReadonlySet<GraphNodeId> {
  if (familyNodeIds.length < 2) {
    throw new TypeError("AI依存のfamilyが2つ未満です");
  }
  return new Set(
    [...cumulativeNodeIds].filter((nodeId) =>
      familyNodeIds.every((nodeIds) => !nodeIds.has(nodeId)),
    ),
  );
}

function propagatedContributorIndexes(
  traversal: ImpactTraversal,
  contributors: readonly Readonly<{
    fromNodeId: GraphNodeId;
    toNodeId: GraphNodeId;
  }>[],
  endpoint: "from" | "to",
): readonly ReadonlySet<number>[] {
  const contributorIndexesByComponent = traversal.stronglyConnected.components.map(
    () => new Set<number>(),
  );
  contributors.forEach((contributor, contributorIndex) => {
    const nodeId = endpoint === "from" ? contributor.fromNodeId : contributor.toNodeId;
    const componentIndex = traversal.stronglyConnected.componentIndexByNodeId.get(nodeId);
    assertNonNullable(
      componentIndex,
      `contributor ${contributorIndex.toString()}の${endpoint} componentがありません`,
    );
    const contributorIndexes = contributorIndexesByComponent[componentIndex];
    assertNonNullable(
      contributorIndexes,
      `強連結成分 ${componentIndex.toString()}のcontributor一覧がありません`,
    );
    contributorIndexes.add(contributorIndex);
  });
  const outgoing = condensationOutgoing(traversal.graph, traversal.stronglyConnected);
  const incomingDraft = outgoing.map(() => new Set<number>());
  outgoing.forEach((targets, fromComponentIndex) => {
    for (const target of targets) {
      const incoming = incomingDraft[target];
      assertNonNullable(incoming, `強連結成分 ${target.toString()}の入辺一覧がありません`);
      incoming.add(fromComponentIndex);
    }
  });
  const order = topologicalOrder(outgoing);
  for (let orderIndex = order.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const componentIndex = order[orderIndex];
    assertNonNullable(componentIndex, "逆トポロジカル順序の強連結成分がありません");
    const contributorIndexes = contributorIndexesByComponent[componentIndex];
    const predecessors = incomingDraft[componentIndex];
    assertNonNullable(
      contributorIndexes,
      `強連結成分 ${componentIndex.toString()}のcontributor一覧がありません`,
    );
    assertNonNullable(predecessors, `強連結成分 ${componentIndex.toString()}の入辺がありません`);
    for (const predecessor of predecessors) {
      const predecessorContributorIndexes = contributorIndexesByComponent[predecessor];
      assertNonNullable(
        predecessorContributorIndexes,
        `強連結成分 ${predecessor.toString()}のcontributor一覧がありません`,
      );
      for (const contributorIndex of contributorIndexes) {
        predecessorContributorIndexes.add(contributorIndex);
      }
    }
  }
  return contributorIndexesByComponent;
}

function recordImpactContributors(
  traversal: ImpactTraversal,
  exclusion: ImpactTraversal,
  contributors: readonly ImpactContributor[],
  changedNodeIds: ReadonlySet<GraphNodeId>,
  dependenciesByNodeId: Map<GraphNodeId, AiAnalysisDependency[]>,
): ReadonlySet<GraphNodeId> {
  const contributingNodeIds = new Set<GraphNodeId>();
  if (contributors.length === 0 || changedNodeIds.size === 0) {
    return contributingNodeIds;
  }
  const contributingIndexesByComponent = propagatedContributorIndexes(
    traversal,
    contributors,
    "from",
  );
  const excludedIndexesByComponent = propagatedContributorIndexes(exclusion, contributors, "to");
  for (const nodeId of changedNodeIds) {
    const contributingComponentIndex =
      traversal.stronglyConnected.componentIndexByNodeId.get(nodeId);
    const excludedComponentIndex = exclusion.stronglyConnected.componentIndexByNodeId.get(nodeId);
    assertNonNullable(contributingComponentIndex, `node ${nodeId}の到達componentがありません`);
    assertNonNullable(excludedComponentIndex, `node ${nodeId}の除外componentがありません`);
    const contributorIndexes = contributingIndexesByComponent[contributingComponentIndex];
    const excludedIndexes = excludedIndexesByComponent[excludedComponentIndex];
    assertNonNullable(contributorIndexes, `node ${nodeId}のcontributor一覧がありません`);
    assertNonNullable(excludedIndexes, `node ${nodeId}の除外contributor一覧がありません`);
    for (const contributorIndex of contributorIndexes) {
      if (!excludedIndexes.has(contributorIndex)) {
        const contributor: ImpactContributor | undefined = contributors[contributorIndex];
        assertNonNullable(contributor, `contributor ${contributorIndex.toString()}がありません`);
        contributingNodeIds.add(nodeId);
        appendDependency(dependenciesByNodeId, nodeId, contributor.dependency);
      }
    }
  }
  return contributingNodeIds;
}

function recordPositiveImpactContributors(
  base: ImpactAnalysis,
  reduced: ImpactTraversal,
  edges: readonly ActiveGraphEdge[],
  changedNodeIds: ReadonlySet<GraphNodeId>,
  dependenciesByNodeId: Map<GraphNodeId, AiAnalysisDependency[]>,
): ReadonlySet<GraphNodeId> {
  return recordImpactContributors(
    base,
    reduced,
    edges.map((edge) => Object.freeze({ ...edge, dependency: edge.aiDependency })),
    changedNodeIds,
    dependenciesByNodeId,
  );
}

function recordNegativeImpactContributors(
  base: ImpactAnalysis,
  added: ImpactTraversal,
  arcs: readonly PotentialBlocksArc[],
  changedNodeIds: ReadonlySet<GraphNodeId>,
  dependenciesByNodeId: Map<GraphNodeId, AiAnalysisDependency[]>,
): ReadonlySet<GraphNodeId> {
  return recordImpactContributors(added, base, arcs, changedNodeIds, dependenciesByNodeId);
}

type ImpactContributorAnalysis = Readonly<{
  nodeIds: ReadonlySet<GraphNodeId>;
  dependenciesByNodeId: ReadonlyMap<GraphNodeId, readonly AiAnalysisDependency[]>;
}>;

function analyzePositiveImpactContributors(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  base: ImpactAnalysis,
  retainedEdges: readonly ActiveGraphEdge[],
  removedEdges: readonly ActiveGraphEdge[],
): ImpactContributorAnalysis {
  if (removedEdges.length === 0) {
    return Object.freeze({
      nodeIds: new Set<GraphNodeId>(),
      dependenciesByNodeId: new Map<GraphNodeId, readonly AiAnalysisDependency[]>(),
    });
  }
  const reduced = createImpactTraversal(nodesById, retainedEdges);
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  const nodeIds = recordPositiveImpactContributors(
    base,
    reduced,
    removedEdges,
    new Set(base.graph.nodeIds),
    dependenciesByNodeId,
  );
  return Object.freeze({ nodeIds, dependenciesByNodeId });
}

function analyzeNegativeImpactContributors(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  base: ImpactAnalysis,
  positiveEdges: readonly ActiveGraphEdge[],
  arcs: readonly PotentialBlocksArc[],
): ImpactContributorAnalysis {
  if (arcs.length === 0) {
    return Object.freeze({
      nodeIds: new Set<GraphNodeId>(),
      dependenciesByNodeId: new Map<GraphNodeId, readonly AiAnalysisDependency[]>(),
    });
  }
  const traversal = createImpactTraversal(nodesById, uniqueBlocksArcs([...positiveEdges, ...arcs]));
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  const nodeIds = recordNegativeImpactContributors(
    base,
    traversal,
    arcs,
    new Set(base.graph.nodeIds),
    dependenciesByNodeId,
  );
  return Object.freeze({ nodeIds, dependenciesByNodeId });
}

function mergeImpactContributorAnalysis(
  target: Map<GraphNodeId, AiAnalysisDependency[]>,
  source: ImpactContributorAnalysis,
  selectedNodeIds: ReadonlySet<GraphNodeId>,
): void {
  for (const nodeId of selectedNodeIds) {
    const dependencies = source.dependenciesByNodeId.get(nodeId);
    assertNonNullable(dependencies, `node ${nodeId}のdownstream impact contributorがありません`);
    for (const dependency of dependencies) {
      appendDependency(target, nodeId, dependency);
    }
  }
}

function dependencyStatusPriority(status: AiAnalysisDependency["status"]): number {
  switch (status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(status);
  }
}

function preferIndependentAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    throw new TypeError("AI依存の選択対象がありません");
  }
  const preferredPriority = Math.min(
    ...dependencies.map((dependency) => dependencyStatusPriority(dependency.status)),
  );
  return combineAiAnalysisDependencies(
    dependencies.filter(
      (dependency) => dependencyStatusPriority(dependency.status) === preferredPriority,
    ),
  );
}

function blocksArcDependencies(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly ActiveGraphEdge[],
  potentialArcs: readonly PotentialBlocksArc[],
): Readonly<{
  blockerSetAiDependencies: readonly BlockerSetAiDependency[];
  blockerNodeAiDependencies: readonly BlockerNodeAiDependency[];
  negativeBlockerAiDependencies: readonly NegativeBlockerAiDependency[];
}> {
  const supportsByArc = new Map<
    string,
    Readonly<{ arc: BlocksArc; supports: ActiveGraphEdge[] }>
  >();
  for (const edge of edges) {
    const arc = Object.freeze({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId });
    const key = blocksArcKey(arc);
    const group = supportsByArc.get(key);
    if (group == null) {
      supportsByArc.set(key, Object.freeze({ arc, supports: [edge] }));
      continue;
    }
    group.supports.push(edge);
  }
  const candidatesByArc = new Map<
    string,
    Readonly<{ arc: BlocksArc; candidates: PotentialBlocksArc[] }>
  >();
  for (const arc of potentialArcs) {
    const key = blocksArcKey(arc);
    const group = candidatesByArc.get(key);
    if (group == null) {
      candidatesByArc.set(key, Object.freeze({ arc, candidates: [arc] }));
      continue;
    }
    group.candidates.push(arc);
  }
  const supportsByBlockedNodeId = new Map<
    GraphNodeId,
    Readonly<{ arc: BlocksArc; supports: ActiveGraphEdge[] }>[]
  >();
  for (const group of supportsByArc.values()) {
    const groups = supportsByBlockedNodeId.get(group.arc.toNodeId);
    if (groups == null) {
      supportsByBlockedNodeId.set(group.arc.toNodeId, [group]);
      continue;
    }
    groups.push(group);
  }
  const negativeByBlockedNodeId = new Map<
    GraphNodeId,
    Readonly<{ arc: BlocksArc; candidates: PotentialBlocksArc[] }>[]
  >();
  for (const group of candidatesByArc.values()) {
    if (supportsByArc.has(blocksArcKey(group.arc))) {
      continue;
    }
    const presenceCandidates = group.candidates.filter((candidate) => candidate.affectsPresence);
    if (presenceCandidates.length === 0) {
      continue;
    }
    const presenceGroup = Object.freeze({ arc: group.arc, candidates: presenceCandidates });
    const groups = negativeByBlockedNodeId.get(group.arc.toNodeId);
    if (groups == null) {
      negativeByBlockedNodeId.set(group.arc.toNodeId, [presenceGroup]);
      continue;
    }
    groups.push(presenceGroup);
  }
  const blockedNodeIds = new Set<GraphNodeId>(nodesById.keys());
  const blockerSetAiDependencies: BlockerSetAiDependency[] = [];
  const blockerNodeAiDependencies: BlockerNodeAiDependency[] = [];
  const negativeBlockerAiDependencies: NegativeBlockerAiDependency[] = [];
  for (const nodeId of [...blockedNodeIds].sort(compareStrings)) {
    const presenceDependencies: AiAnalysisDependency[] = [];
    for (const group of supportsByBlockedNodeId.get(nodeId) ?? []) {
      const potentialSupports = candidatesByArc.get(blocksArcKey(group.arc))?.candidates ?? [];
      const presence = preferIndependentAiDependencies(
        group.supports.map((support) => support.aiDependency),
      );
      presenceDependencies.push(presence);
      const maximumConfidence = Math.max(...group.supports.map((support) => support.confidence));
      const maximumConfidenceDependency = preferIndependentAiDependencies(
        group.supports
          .filter((support) => support.confidence === maximumConfidence)
          .map((support) => support.aiDependency),
      );
      const confidenceDependencies = [maximumConfidenceDependency];
      const hasHardMaximumConfidence = group.supports.some(
        (support) => support.confidence === 1 && support.aiDependency.status === "not_dependent",
      );
      if (!hasHardMaximumConfidence) {
        confidenceDependencies.push(
          ...group.supports
            .filter(
              (support) =>
                support.confidence < maximumConfidence &&
                (support.aiDependency.status === "unverified" ||
                  support.aiDependency.status === "unknown"),
            )
            .map((support) => support.aiDependency),
          ...potentialSupports.map((support) => support.dependency),
        );
      }
      const confidence = combineAiAnalysisDependencies(confidenceDependencies);
      const sourceIds = combineAiAnalysisDependencies(
        group.supports
          .map((support) => support.aiDependency)
          .concat(potentialSupports.map((support) => support.dependency)),
      );
      const nativeSupports = group.supports.filter((support) => support.provenance === "native");
      const firstSupport = group.supports[0];
      assertNonNullable(firstSupport, `blocker ${group.arc.fromNodeId}のsupportがありません`);
      const earliestFirstSeenAt = group.supports.reduce(
        (earliest, support) => (support.firstSeenAt < earliest ? support.firstSeenAt : earliest),
        firstSupport.firstSeenAt,
      );
      const currentBecameBlockingAt = preferIndependentAiDependencies(
        (nativeSupports.length === 0
          ? group.supports.filter((support) => support.firstSeenAt === earliestFirstSeenAt)
          : nativeSupports
        ).map((support) => support.aiDependency),
      );
      const becameBlockingAtPotentialDependencies =
        nativeSupports.length === 0
          ? potentialSupports
              .filter(
                (support) =>
                  support.firstSeenAt.status === "unknown" ||
                  support.firstSeenAt.value < earliestFirstSeenAt,
              )
              .map((support) => support.dependency)
          : [];
      const becameBlockingAt = combineAiAnalysisDependencies([
        currentBecameBlockingAt,
        ...becameBlockingAtPotentialDependencies,
      ]);
      blockerNodeAiDependencies.push(
        Object.freeze({
          blockedNodeId: nodeId,
          blockerNodeId: group.arc.fromNodeId,
          presence,
          confidence,
          sourceIds,
          becameBlockingAt,
        }),
      );
    }
    const negativeDependencies: AiAnalysisDependency[] = [];
    for (const group of negativeByBlockedNodeId.get(nodeId) ?? []) {
      negativeDependencies.push(
        combineAiAnalysisDependencies(group.candidates.map((arc) => arc.dependency)),
      );
    }
    const negativeDependency =
      negativeDependencies.length === 0
        ? Object.freeze({ status: "not_dependent" })
        : combineAiAnalysisDependencies(negativeDependencies);
    presenceDependencies.push(negativeDependency);
    const dependency = combineAiAnalysisDependencies(presenceDependencies);
    blockerSetAiDependencies.push(Object.freeze({ nodeId, dependency }));
    negativeBlockerAiDependencies.push(Object.freeze({ nodeId, dependency: negativeDependency }));
  }
  blockerSetAiDependencies.sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  blockerNodeAiDependencies.sort((left, right) => {
    const blockedOrder = compareStrings(left.blockedNodeId, right.blockedNodeId);
    if (blockedOrder !== 0) {
      return blockedOrder;
    }
    return compareStrings(left.blockerNodeId, right.blockerNodeId);
  });
  negativeBlockerAiDependencies.sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  return Object.freeze({
    blockerSetAiDependencies: Object.freeze(blockerSetAiDependencies),
    blockerNodeAiDependencies: Object.freeze(blockerNodeAiDependencies),
    negativeBlockerAiDependencies: Object.freeze(negativeBlockerAiDependencies),
  });
}

function relationKey(
  relation: Readonly<{
    fromNodeId: GraphNodeId;
    toNodeId: GraphNodeId;
    type: ReconciledGraphEdge["type"];
  }>,
): string {
  return JSON.stringify([relation.type, relation.fromNodeId, relation.toNodeId]);
}

function relationSetAiDependencies(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  activeEdges: readonly ActiveGraphEdge[],
  proofs: readonly RelationCandidateDecisionProof[],
): readonly RelationSetAiDependency[] {
  const proofByCandidateId = new Map(proofs.map((proof) => [proof.candidateId, proof]));
  const supportsByRelation = new Map<
    string,
    Readonly<{
      endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
      dependencies: AiAnalysisDependency[];
    }>
  >();
  const candidateDependencies: Readonly<{
    endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
    dependency: AiAnalysisDependency;
  }>[] = proofs
    .filter((proof) => proof.authority === "inferred")
    .map((proof) =>
      Object.freeze({
        endpointNodeIds: proof.endpointNodeIds,
        dependency: aiAnalysisDependencyForRelationCandidate(
          proof.candidateId,
          proof.endpointNodeIds,
          proof.dependency,
        ),
      }),
    );
  for (const proof of proofs) {
    if (proof.resolution.status !== "active") {
      continue;
    }
    const canonicalRelation = proof.canonicalRelation;
    assertNonNullable(
      canonicalRelation,
      `active relation ${proof.candidateId}のcanonical relationがありません`,
    );
    const key = relationKey(canonicalRelation);
    const dependency = aiAnalysisDependencyForRelationCandidate(
      proof.candidateId,
      proof.endpointNodeIds,
      proof.dependency,
    );
    const existing = supportsByRelation.get(key);
    if (existing == null) {
      supportsByRelation.set(
        key,
        Object.freeze({ endpointNodeIds: proof.endpointNodeIds, dependencies: [dependency] }),
      );
    } else {
      existing.dependencies.push(dependency);
    }
  }
  for (const edge of activeEdges) {
    if (proofByCandidateId.has(edge.id)) {
      continue;
    }
    const key = relationKey(edge);
    const endpointNodeIds: readonly [GraphNodeId, GraphNodeId] = [edge.fromNodeId, edge.toNodeId];
    const existing = supportsByRelation.get(key);
    if (existing == null) {
      supportsByRelation.set(
        key,
        Object.freeze({ endpointNodeIds, dependencies: [edge.aiDependency] }),
      );
    } else {
      existing.dependencies.push(edge.aiDependency);
    }
  }
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  for (const support of supportsByRelation.values()) {
    const dependency = preferIndependentAiDependencies(support.dependencies);
    for (const endpointNodeId of support.endpointNodeIds) {
      appendDependency(dependenciesByNodeId, endpointNodeId, dependency);
    }
  }
  for (const candidate of candidateDependencies) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      appendDependency(dependenciesByNodeId, endpointNodeId, candidate.dependency);
    }
  }
  return Object.freeze(
    [...nodesById.keys()].sort(compareStrings).map((nodeId) => {
      const dependencies = dependenciesByNodeId.get(nodeId);
      return Object.freeze({
        nodeId,
        dependency:
          dependencies == null
            ? Object.freeze({ status: "not_dependent" })
            : combineAiAnalysisDependencies(dependencies),
      });
    }),
  );
}

function downstreamImpactAiDependenciesWithCandidates(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  base: ImpactAnalysis,
  positiveEdges: readonly ActiveGraphEdge[],
  potentialArcs: readonly PotentialBlocksArc[],
): readonly Readonly<{ nodeId: GraphNodeId; dependency: AiAnalysisDependency }>[] {
  const negativeArcs = potentialArcs.filter((arc) => arc.affectsPresence);
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  const unknownPositiveEdges = positiveEdges.filter(
    (edge) => edge.aiDependency.status === "unknown",
  );
  const unverifiedPositiveEdges = positiveEdges.filter(
    (edge) => edge.aiDependency.status === "unverified",
  );
  const currentPositiveEdges = positiveEdges.filter(
    (edge) => edge.aiDependency.status === "current",
  );
  const unknownNegativeArcs = negativeArcs.filter((arc) => arc.dependency.status === "unknown");
  const unverifiedNegativeArcs = negativeArcs.filter(
    (arc) => arc.dependency.status === "unverified",
  );
  const currentNegativeArcs = negativeArcs.filter((arc) => arc.dependency.status === "current");

  const unknownRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status !== "unknown"),
    unknownPositiveEdges,
  );
  const unverifiedRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status !== "unverified"),
    unverifiedPositiveEdges,
  );
  const unknownUnverifiedRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter(
      (edge) => edge.aiDependency.status !== "unknown" && edge.aiDependency.status !== "unverified",
    ),
    [...unknownPositiveEdges, ...unverifiedPositiveEdges],
  );
  const currentRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status !== "current"),
    currentPositiveEdges,
  );
  const allAiRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status === "not_dependent"),
    [...unknownPositiveEdges, ...unverifiedPositiveEdges, ...currentPositiveEdges],
  );
  const unknownAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    unknownNegativeArcs,
  );
  const unverifiedAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    unverifiedNegativeArcs,
  );
  const unknownUnverifiedAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    [...unknownNegativeArcs, ...unverifiedNegativeArcs],
  );
  const currentAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    currentNegativeArcs,
  );
  const allAiAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    negativeArcs,
  );

  const changedByUnknownRemoval = unknownRemoval.nodeIds;
  const changedByUnverifiedRemoval = unverifiedRemoval.nodeIds;
  const changedByUnknownUnverifiedRemoval = unknownUnverifiedRemoval.nodeIds;
  const changedByCurrentRemoval = currentRemoval.nodeIds;
  const changedByAllAiRemoval = allAiRemoval.nodeIds;
  const changedByUnknownAddition = unknownAddition.nodeIds;
  const changedByUnverifiedAddition = unverifiedAddition.nodeIds;
  const changedByUnknownUnverifiedAddition = unknownUnverifiedAddition.nodeIds;
  const changedByCurrentAddition = currentAddition.nodeIds;
  const changedByAllAiAddition = allAiAddition.nodeIds;

  mergeImpactContributorAnalysis(dependenciesByNodeId, unknownRemoval, changedByUnknownRemoval);
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unverifiedRemoval,
    changedByUnverifiedRemoval,
  );
  mergeImpactContributorAnalysis(dependenciesByNodeId, currentRemoval, changedByCurrentRemoval);
  mergeImpactContributorAnalysis(dependenciesByNodeId, unknownAddition, changedByUnknownAddition);
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unverifiedAddition,
    changedByUnverifiedAddition,
  );
  mergeImpactContributorAnalysis(dependenciesByNodeId, currentAddition, changedByCurrentAddition);

  const unknownUnverifiedRemovalInteractionNodeIds = interactionNodeIds(
    changedByUnknownUnverifiedRemoval,
    [changedByUnknownRemoval, changedByUnverifiedRemoval],
  );
  const unknownUnverifiedAdditionInteractionNodeIds = interactionNodeIds(
    changedByUnknownUnverifiedAddition,
    [changedByUnknownAddition, changedByUnverifiedAddition],
  );
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unknownUnverifiedRemoval,
    unknownUnverifiedRemovalInteractionNodeIds,
  );
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unknownUnverifiedAddition,
    unknownUnverifiedAdditionInteractionNodeIds,
  );

  const allAiRemovalUnknownFamilyNodeIds = new Set<GraphNodeId>([
    ...changedByUnknownRemoval,
    ...changedByUnverifiedRemoval,
    ...changedByUnknownUnverifiedRemoval,
  ]);
  const allAiRemovalInteractionNodeIds = crossFamilyInteractionNodeIds(changedByAllAiRemoval, [
    allAiRemovalUnknownFamilyNodeIds,
    changedByCurrentRemoval,
  ]);
  const allAiAdditionUnknownFamilyNodeIds = new Set<GraphNodeId>([
    ...changedByUnknownAddition,
    ...changedByUnverifiedAddition,
    ...changedByUnknownUnverifiedAddition,
  ]);
  const allAiAdditionInteractionNodeIds = crossFamilyInteractionNodeIds(changedByAllAiAddition, [
    allAiAdditionUnknownFamilyNodeIds,
    changedByCurrentAddition,
  ]);
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    allAiRemoval,
    allAiRemovalInteractionNodeIds,
  );
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    allAiAddition,
    allAiAdditionInteractionNodeIds,
  );

  return Object.freeze(
    [...nodesById.keys()].sort(compareStrings).map((nodeId) => {
      const dependencies = dependenciesByNodeId.get(nodeId);
      const dependency =
        dependencies == null
          ? Object.freeze({ status: "not_dependent" })
          : combineAiAnalysisDependencies(dependencies);
      return Object.freeze({ nodeId, dependency });
    }),
  );
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
    downstreamImpactAiDependencies: downstreamImpactAiDependency(
      current.nodesById,
      current.effectiveBlocksEdges,
      Object.freeze({
        graph: directedBlocksGraph,
        stronglyConnected,
        reachability,
      }),
    ),
    connectedComponents: createConnectedComponents(current.nodesById, current.activeEdges),
    reclassificationTargets: reclassification.targets,
    newlyUnblockedNodeIds: reclassification.newlyUnblockedNodeIds,
  });
}

/** 関係候補の不在proofを含むgraphからAI依存を算出する。 */
export function analyzeGraphAiDependencies(
  input: AnalyzeGraphAiDependenciesInput,
): AnalyzeGraphAiDependenciesResult {
  const result = analyzeGraph({
    current: input.current,
    previous: input.previous,
  });
  const current = indexSnapshot(input.current, "現在snapshot");
  const candidateProofSnapshot = indexSnapshot(input.candidateProofSnapshot, "関係候補snapshot");
  const proofs = validateCandidateDecisionProofs(
    candidateProofSnapshot,
    input.candidateDecisionProofs,
  );
  const valueSensitivity = createPublicValueSensitivityIndex(current, candidateProofSnapshot);
  const valueProofs = proofs.filter((proof) =>
    proof.endpointNodeIds.every((nodeId) => valueSensitivity.nodesById.has(nodeId)),
  );
  const positiveSupportArcs = normalizePositiveSupportArcs(valueSensitivity.effectiveBlocksEdges);
  const base = createImpactAnalysis(valueSensitivity.nodesById, positiveSupportArcs);
  const potentialArcs = potentialBlocksArcs(valueSensitivity, proofs);
  const blockerDependencies = blocksArcDependencies(
    valueSensitivity.nodesById,
    valueSensitivity.effectiveBlocksEdges,
    potentialArcs,
  );
  return Object.freeze({
    ...result,
    downstreamImpactAiDependencies: Object.freeze(
      downstreamImpactAiDependenciesWithCandidates(
        valueSensitivity.nodesById,
        base,
        positiveSupportArcs,
        potentialArcs,
      ).filter((entry) => current.nodesById.has(entry.nodeId)),
    ),
    blockerSetAiDependencies: Object.freeze(
      blockerDependencies.blockerSetAiDependencies.filter((entry) =>
        current.nodesById.has(entry.nodeId),
      ),
    ),
    blockerNodeAiDependencies: Object.freeze(
      blockerDependencies.blockerNodeAiDependencies.filter((entry) =>
        current.nodesById.has(entry.blockedNodeId),
      ),
    ),
    negativeBlockerAiDependencies: Object.freeze(
      blockerDependencies.negativeBlockerAiDependencies.filter((entry) =>
        current.nodesById.has(entry.nodeId),
      ),
    ),
    relationSetAiDependencies: Object.freeze(
      relationSetAiDependencies(
        valueSensitivity.nodesById,
        valueSensitivity.activeEdges,
        valueProofs,
      ).filter((entry) => current.nodesById.has(entry.nodeId)),
    ),
  });
}

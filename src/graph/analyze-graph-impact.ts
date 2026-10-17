import { type GraphNodeId } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  containsOtherRepositoryNode,
  popcount,
  setBit,
  unionBitsets,
} from "./analyze-graph-bitset.js";
import {
  compareNumbers,
  compareStrings,
  createDirectedBlocksGraph,
  isOpenNode,
  repositoryKey,
  stronglyConnectedComponents,
  type BlocksArc,
  type DirectedGraph,
  type ImpactAnalysis,
  type ImpactTraversal,
  type Reachability,
  type StronglyConnectedGraph,
} from "./analyze-graph-core.js";
import { type DownstreamImpact, type GraphAnalysisNode } from "./analyze-graph-types.js";

/** 強連結成分を縮約したgraphの出辺を作る。 */
export function condensationOutgoing(
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

/** 縮約graphの位相順を返す。 */
export function topologicalOrder(outgoing: readonly (readonly number[])[]): readonly number[] {
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

/** graph内のnodeとrepositoryへの到達関係を作る。 */
export function createReachability(
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

/** 各nodeの下流影響を算出する。 */
export function createDownstreamImpacts(
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

/** block関係の下流影響をまとめる。 */
export function createImpactAnalysis(
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

/** 寄与解析に使うgraphの探索情報を作る。 */
export function createImpactTraversal(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly BlocksArc[],
): ImpactTraversal {
  const graph = createDirectedBlocksGraph(nodesById, edges);
  return Object.freeze({
    graph,
    stronglyConnected: stronglyConnectedComponents(graph),
  });
}

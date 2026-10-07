import {
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
  type GraphNodeId,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  compareStrings,
  type ActiveGraphEdge,
  type DirectedGraph,
  type ImpactAnalysis,
  type ImpactContributor,
  type ImpactTraversal,
  type PotentialBlocksArc,
  type Reachability,
  type StronglyConnectedGraph,
} from "./analyze-graph-core.js";
import {
  condensationOutgoing,
  createImpactTraversal,
  topologicalOrder,
} from "./analyze-graph-impact.js";
import { normalizePositiveSupportArcs, uniqueBlocksArcs } from "./analyze-graph-support-arcs.js";
import type { GraphAnalysisNode } from "./analyze-graph-types.js";

/** nodeのAI依存一覧へ根拠を追加する。 */
export function appendDependency(
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

/** 複数の影響集合が交差するnodeを求める。 */
export function interactionNodeIds(
  cumulativeNodeIds: ReadonlySet<GraphNodeId>,
  lowerFamilyNodeIds: readonly ReadonlySet<GraphNodeId>[],
): ReadonlySet<GraphNodeId> {
  return new Set(
    [...cumulativeNodeIds].filter((nodeId) =>
      lowerFamilyNodeIds.every((nodeIds) => !nodeIds.has(nodeId)),
    ),
  );
}

/** 異なる根拠familyが交差するnodeを求める。 */
export function crossFamilyInteractionNodeIds(
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

/** 下流影響を変えた根拠をnodeごとに記録する。 */
export function recordImpactContributors(
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

/** 正のblock関係が下流影響へ与えた寄与を求める。 */
export function analyzePositiveImpactContributors(
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

/** 潜在的なblock関係が下流影響へ与えた寄与を求める。 */
export function analyzeNegativeImpactContributors(
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

/** 寄与解析のAI依存を対象nodeへ結合する。 */
export function mergeImpactContributorAnalysis(
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

/** 下流影響のAI依存をnodeごとに算出する。 */
export function downstreamImpactAiDependency(
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

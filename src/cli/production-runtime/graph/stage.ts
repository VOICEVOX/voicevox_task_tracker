import type { ExternalGhostNode, GitHubNodeId, GraphNodeId } from "../../../domain/index.js";
import type { EnumeratedGitHubItem } from "../../../github/index.js";
import {
  reconcileGraph,
  type GraphAnalysisNode,
  type ReconcileGraphResult,
} from "../../../graph/index.js";
import { relationNodes } from "../../../graph/relation-candidate-endpoints.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type {
  CollectedItems,
  GraphResult,
  PendingTrackedItem,
  ProductionTypes,
  ReducedAnalysis,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import {
  externalGraphAnalysisNode,
  graphAnalysisNodeWithEffectiveState,
} from "../graph-node-input.js";
import { previousGraphIndex } from "../previous-state/graph.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { createEarliestRelationSourceOccurredAtById } from "../relation-source-occurrence.js";
import { analyzeCurrentGraph } from "./analysis.js";
import { relationAiDependenciesForCandidates } from "./candidate-dependencies.js";
import { candidateOnlyGraphAnalysisNode, currentEffectiveGraphState } from "./node-input.js";
import {
  preserveUnverifiedGraphEdges,
  retainGraphEdgesForAvailableNodes,
} from "./preserve-unverified-edges.js";

/** 現在の統合結果から暫定または最終のグラフを構築する。 */
export function reconcileCurrentGraph(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
): GraphResult {
  const previousIndex = previousGraphIndex(state);
  const previous = previousIndex.availability === "available" ? previousIndex.snapshot : undefined;
  const candidates = collection.relationCandidates;
  const relationAiDependencies = relationAiDependenciesForCandidates(
    candidates,
    reduction.items,
    reduction.relationAssessments,
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const reconciled: ReconcileGraphResult = reconcileGraph({
    previousGraph: {
      edges: previous?.edges ?? [],
      historyEvents: [],
    },
    candidates,
    assessments: reduction.relationAssessments.filter((assessment) =>
      candidateIds.has(assessment.candidateId),
    ),
    relationAiDependencies: new Map(
      candidates.map((candidate) => {
        const dependency = relationAiDependencies.get(candidate.id);
        assertNonNullable(dependency, `関係候補 ${candidate.id}のAI依存がありません`);
        return [candidate.id, dependency];
      }),
    ),
    sourceOccurredAtById: createEarliestRelationSourceOccurredAtById(collection.observedItems),
    minimumInferredConfidence: configuration.config.ai.confidence.medium,
    reconciledAt: collection.evaluatedAt,
  });
  const preservedGraph = preserveUnverifiedGraphEdges(
    collection,
    previous?.edges ?? [],
    reconciled.edges,
    candidates,
    reconciled.candidateDecisionProofs,
  );
  const reconciledEdges = preservedGraph.edges;
  const reductionItemsByNodeId = new Map<GitHubNodeId, PendingTrackedItem>();
  for (const item of reduction.items) {
    if (reductionItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`関係候補endpointのreduction itemが重複しています。対象: ${item.nodeId}`);
    }
    reductionItemsByNodeId.set(item.nodeId, item);
  }
  const enumeratedItemsByNodeId = new Map<GitHubNodeId, EnumeratedGitHubItem>();
  for (const item of collection.enumeratedItems) {
    if (enumeratedItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`関係候補endpointの列挙項目が重複しています。対象: ${item.nodeId}`);
    }
    enumeratedItemsByNodeId.set(item.nodeId, item);
  }
  const externalReferencesByNodeId = new Map<GraphNodeId, ExternalGhostNode>();
  const candidateExternalReferences = candidates.flatMap((candidate) =>
    relationNodes(candidate.relation).flatMap((node) =>
      node.scope === "external_public"
        ? [
            Object.freeze({
              kind: "external_reference",
              nodeId: node.nodeId,
              repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
              number: node.number,
              url: node.url,
              title: `${node.repositoryOwner}/${node.repositoryName}#${node.number.toString()}`,
              state: node.state,
              recursiveTracking: "not_allowed",
              directNotification: "not_eligible",
            } satisfies ExternalGhostNode),
          ]
        : [],
    ),
  );
  for (const reference of [
    ...(previousSnapshot(state)?.externalReferences ?? []),
    ...collection.externalReferences,
    ...candidateExternalReferences,
  ]) {
    externalReferencesByNodeId.set(reference.nodeId, reference);
  }
  for (const candidate of candidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope === "external_public") {
        if (!externalReferencesByNodeId.has(node.nodeId)) {
          throw new TypeError(`関係候補の外部参照nodeがありません。対象: ${node.nodeId}`);
        }
        continue;
      }
      const reductionItem = reductionItemsByNodeId.get(node.nodeId);
      if (reductionItem != null) {
        if (reductionItem.type !== node.kind) {
          throw new TypeError(`関係候補endpointのitem種別が一致しません。対象: ${node.nodeId}`);
        }
        continue;
      }
      const enumeratedItem = enumeratedItemsByNodeId.get(node.nodeId);
      if (enumeratedItem == null) {
        throw new TypeError(`関係候補endpointの列挙項目がありません。対象: ${node.nodeId}`);
      }
      if (enumeratedItem.type !== node.kind) {
        throw new TypeError(`関係候補endpointの列挙項目種別が一致しません。対象: ${node.nodeId}`);
      }
    }
  }
  const availableNodeIds = new Set<string>([
    ...reduction.items.map((item) => item.nodeId),
    ...externalReferencesByNodeId.keys(),
  ]);
  const edges = retainGraphEdgesForAvailableNodes(reconciledEdges, availableNodeIds);
  const referencedNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const externalReferences = Object.freeze(
    [...externalReferencesByNodeId.values()]
      .filter((reference) => referencedNodeIds.has(reference.nodeId))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
  const staleNodeIds = new Set(collection.staleItems.map((item) => item.nodeId));
  const effectiveGraphState = currentEffectiveGraphState(
    state,
    reduction.items,
    externalReferences,
    candidates,
    staleNodeIds,
    collection.evaluatedAt,
  );
  const currentTrackedGraphNodes = reduction.items.map((item) =>
    graphAnalysisNodeWithEffectiveState(item, effectiveGraphState.stateByNodeId),
  );
  const graphNodes = [
    ...currentTrackedGraphNodes,
    ...externalReferences.map(externalGraphAnalysisNode),
  ];
  const candidateOnlyNodesByNodeId = new Map<GraphNodeId, GraphAnalysisNode>();
  for (const candidate of candidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope !== "organization" || reductionItemsByNodeId.has(node.nodeId)) {
        continue;
      }
      const enumeratedItem = enumeratedItemsByNodeId.get(node.nodeId);
      assertNonNullable(
        enumeratedItem,
        `関係候補endpointの列挙項目がありません。対象: ${node.nodeId}`,
      );
      if (enumeratedItem.type !== node.kind) {
        throw new TypeError(`関係候補endpointの列挙項目種別が一致しません。対象: ${node.nodeId}`);
      }
      const candidateNode = candidateOnlyGraphAnalysisNode(enumeratedItem);
      const existing = candidateOnlyNodesByNodeId.get(candidateNode.nodeId);
      if (existing != null && JSON.stringify(existing) !== JSON.stringify(candidateNode)) {
        throw new TypeError(`関係候補endpointの列挙項目が一致しません。対象: ${node.nodeId}`);
      }
      candidateOnlyNodesByNodeId.set(candidateNode.nodeId, candidateNode);
    }
  }
  const aiGraphNodes = [
    ...currentTrackedGraphNodes,
    ...[...candidateOnlyNodesByNodeId.values()].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    ...[...externalReferencesByNodeId.values()]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map(externalGraphAnalysisNode),
  ];
  const aiGraphNodeIds = new Set(aiGraphNodes.map((node) => node.nodeId));
  const aiEdges = retainGraphEdgesForAvailableNodes(reconciledEdges, aiGraphNodeIds);
  const openNodeIds = new Set<GraphNodeId>(
    graphNodes.filter((node) => node.state === "open").map((node) => node.nodeId),
  );
  const { analysis, aiAnalysis } = analyzeCurrentGraph({
    graphNodes,
    aiGraphNodes,
    edges,
    aiEdges,
    previous,
    candidateDecisionProofs: preservedGraph.candidateDecisionProofs,
  });
  return Object.freeze({
    edges,
    effectiveStateByNodeId: effectiveGraphState.stateByNodeId,
    graphNodeStateObservations: effectiveGraphState.observations,
    currentNativeStateObservations: effectiveGraphState.currentNativeStateObservations,
    relationCandidateAiDependencies: preservedGraph.relationCandidateAiDependencies,
    candidateResolutions: preservedGraph.candidateResolutions,
    candidateDecisionProofs: preservedGraph.candidateDecisionProofs,
    externalReferences,
    openNodeIds,
    analysis,
    downstreamImpactAiDependencies: aiAnalysis.downstreamImpactAiDependencies,
    blockerSetAiDependencies: aiAnalysis.blockerSetAiDependencies,
    blockerNodeAiDependencies: aiAnalysis.blockerNodeAiDependencies,
    negativeBlockerAiDependencies: aiAnalysis.negativeBlockerAiDependencies,
    relationSetAiDependencies: aiAnalysis.relationSetAiDependencies,
    previousAnalysis:
      previousIndex.availability === "unavailable"
        ? Object.freeze({
            availability: "unavailable",
          })
        : Object.freeze({
            availability: "available",
            value: previousIndex.analysis,
          }),
  });
}

/** グラフ構築段階を作る。 */
export function createReconcileGraphStage(): DailyTransactionDependencies<ProductionTypes>["reconcileGraph"] {
  return ({ configuration, state, collection, reduction }) => {
    const graph = reconcileCurrentGraph(configuration, state, collection, reduction);
    return Promise.resolve(
      Object.freeze({
        value: graph,
        activeEdgeCount: graph.edges.filter((edge) => edge.active).length,
      }),
    );
  };
}

import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import {
  calculateAttention,
  calculateImportance,
  combineImportance,
  createLabelEffectsResolver,
  type GraphNodeId,
} from "../../../domain/index.js";
import type { AnalyzeGraphResult, ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { normalizeLabelRules } from "./collection-label-rules.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import { aiDependencyReconciliationContext } from "./graph-reconciliation-ai-dependency-context.js";
import { combineSelectedAiDependencies } from "./graph-reconciliation-ai-selection.js";
import { blockerValueAiDependencies } from "./graph-reconciliation-blocker-values.js";
import type { GraphFinalItem } from "../contracts/graph-final-item.js";
import type {
  GraphItemWithImportanceAssessment,
  GraphReducedItem,
  GraphWorkingCollection,
  GraphWorkingConfiguration,
  GraphWorkingInventory,
  GraphWorkingReduction,
  GraphWorkingResult,
  GraphWorkingState,
  PendingGraphTrackedItem,
} from "./graph-reconciliation-contracts.js";
import {
  blockerNodeAiDependenciesByBlockedNodeId,
  blockersAiDependenciesByNodeId,
  downstreamImpactAiDependenciesByNodeId,
  graphAiDependenciesByNodeId,
  graphAiDependencyForNode,
} from "./graph-reconciliation-graph-indexes.js";
import { previousTrackedItem } from "./graph-reconciliation-previous-items.js";
import { retainedBlockerValueAiDependenciesByNodeId } from "./graph-reconciliation-retained-blocker-dependencies.js";
import { nativeOpenBlockerNodeIdsByTargetNodeId } from "./graph-reconciliation-retained-blocker-topology.js";
import type { CurrentAiDependencyContext } from "./graph-reconciliation-retained-ai-producers.js";
import { findRepository, repositoryFullName } from "./graph-reconciliation-repositories.js";
import { sourceOccurredAtByIdForAnalysis } from "./graph-reconciliation-source-time.js";
import {
  deadlineLevelForAssessment,
  finalizedTrackedItemAiDependencies,
} from "./graph-reconciliation-snapshot-item-ai-dependencies.js";
import { trackedItemAiDependenciesForAnalysis } from "./graph-reconciliation-tracked-item.js";

function downstreamImpactsByNodeId(
  graph: GraphWorkingResult,
): ReadonlyMap<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]> {
  const impactsByNodeId = new Map<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]>();
  for (const impact of graph.analysis.downstreamImpacts) {
    if (impactsByNodeId.has(impact.nodeId)) {
      throw new TypeError(`downstream impactが重複しています。対象: ${impact.nodeId}`);
    }
    impactsByNodeId.set(impact.nodeId, impact);
  }
  return impactsByNodeId;
}

function graphMapValue<Value>(
  valuesByNodeId: ReadonlyMap<GraphNodeId, Value>,
  nodeId: GraphNodeId,
  description: string,
): Value {
  const value = valuesByNodeId.get(nodeId);
  assertNonNullable(value, `${description}がありません。対象: ${nodeId}`);
  return value;
}

function itemWithImportance(
  configuration: GraphWorkingConfiguration,
  inventory: GraphWorkingInventory,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
  item: PendingGraphTrackedItem,
  downstreamImpact: AnalyzeGraphResult["downstreamImpacts"][number],
  downstreamImpactDependency: AiAnalysisDependency,
  assessment: GraphReducedItem["importanceAssessment"],
  deadlineAssessment: GraphReducedItem["deadlineAssessment"],
): GraphItemWithImportanceAssessment {
  const repository = findRepository(inventory, item.repositoryId);
  const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
  const deterministicImportance = calculateImportance({
    priorityWeight: labelEffects.priorityWeight,
    downstreamImpact,
    weights: configuration.config.importance.weights,
    levels: configuration.config.importance.levels,
  });
  const importance = combineImportance({
    deterministic: deterministicImportance,
    naturalLanguageAssessment: assessment,
    weights: configuration.config.importance.weights,
    levels: configuration.config.importance.levels,
  });
  const naturalLanguageCanAffectImportance =
    configuration.config.importance.weights.significantFeature > 0 ||
    configuration.config.importance.weights.futureRisk > 0;
  const downstreamImpactCanAffectImportance =
    configuration.config.importance.weights.downstreamImpactMax > 0 &&
    (configuration.config.importance.weights.blockedItem > 0 ||
      configuration.config.importance.weights.blockedRepository > 0);
  const importanceDependencies = [
    ...(naturalLanguageCanAffectImportance ? [item.aiDependencies.importance] : []),
    ...(downstreamImpactCanAffectImportance ? [downstreamImpactDependency] : []),
  ];
  return Object.freeze({
    ...item,
    importanceAssessment: assessment,
    deadlineAssessment,
    importance,
    aiDependencies: Object.freeze({
      ...item.aiDependencies,
      importance: combineSelectedAiDependencies(importanceDependencies),
    }),
  });
}

/** 最終graphから個人催促前の項目値と値単位AI依存を確定する。 */
export function finalizeGraphItems(
  configuration: GraphWorkingConfiguration,
  state: GraphWorkingState,
  inventory: GraphWorkingInventory,
  collection: GraphWorkingCollection,
  reduction: GraphWorkingReduction,
  graph: GraphWorkingResult,
  adoptedItems: readonly GenericAiItemAdoption[],
): readonly GraphFinalItem[] {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentAnalysisByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const downstreamImpactByNodeId = downstreamImpactsByNodeId(graph);
  const downstreamImpactDependenciesByNodeId = downstreamImpactAiDependenciesByNodeId(graph);
  const blockersDependenciesByNodeId = blockersAiDependenciesByNodeId(graph);
  const relationSetDependenciesByNodeId = graphAiDependenciesByNodeId(
    graph.relationSetAiDependencies,
    "relation集合AI依存",
  );
  const negativeBlockerDependenciesByNodeId = graphAiDependenciesByNodeId(
    graph.negativeBlockerAiDependencies,
    "negative blocker AI依存",
  );
  const blockerNodeDependenciesByBlockedNodeId = blockerNodeAiDependenciesByBlockedNodeId(graph);
  const adoptedByNodeId = new Map(adoptedItems.map((adopted) => [adopted.nodeId, adopted]));
  const currentAiDependencyContext: CurrentAiDependencyContext = Object.freeze({
    ...aiDependencyReconciliationContext(reduction.items, collection.relationCandidates, graph),
    relationsById: new Map(
      graph.edges.map((edge): [string, ReconciledGraphEdge] => [edge.id, edge]),
    ),
    openNodeIds: graph.openNodeIds,
    nativeOpenBlockerNodeIdsByTargetNodeId: nativeOpenBlockerNodeIdsByTargetNodeId(graph),
    blockerValueDependenciesByNodeId: retainedBlockerValueAiDependenciesByNodeId(
      graph,
      reduction.items,
      configuration.config.ai.confidence.high,
      new Set(collection.staleItems.map((item) => item.nodeId)),
      collection.staleBlockerTopologyNodeIds,
    ),
  });
  return Object.freeze(
    reduction.items.map((item) => {
      const currentAnalysis = currentAnalysisByNodeId.get(item.nodeId);
      const previousItem = previousTrackedItem(state, item.nodeId);
      const downstreamImpact = graphMapValue(
        downstreamImpactByNodeId,
        item.nodeId,
        `重要度計算対象 ${item.nodeId}のdownstream impact`,
      );
      const downstreamImpactDependency = graphAiDependencyForNode(
        downstreamImpactDependenciesByNodeId,
        item.nodeId,
        "downstream impact",
      );
      const blockersDependency = graphAiDependencyForNode(
        blockersDependenciesByNodeId,
        item.nodeId,
        "blocker",
      );
      const relationSetDependency = graphAiDependencyForNode(
        relationSetDependenciesByNodeId,
        item.nodeId,
        "relation集合",
      );
      let baseItem = item;
      let finalAnalysis = currentAnalysis;
      if (currentAnalysis != null) {
        const adopted = adoptedByNodeId.get(item.nodeId);
        assertNonNullable(adopted, `最終項目 ${item.nodeId}の採用記録がありません`);
        const finalBlockerValueDependencies = blockerValueAiDependencies(
          item.nodeId,
          currentAnalysis.deterministicDecision.blockerDecisionTrace,
          blockerNodeDependenciesByBlockedNodeId,
          negativeBlockerDependenciesByNodeId,
        );
        baseItem = Object.freeze({
          ...item,
          aiDependencies: trackedItemAiDependenciesForAnalysis(
            state,
            currentAnalysis.item,
            item.nodeId,
            currentAnalysis.decision,
            currentAnalysis.deterministicDecision,
            currentAnalysis.staleness,
            currentAnalysis.statusBasis,
            currentAnalysis.responsibilityBasis,
            sourceOccurredAtByIdForAnalysis(currentAnalysis),
            item.aiAnalysis,
            adopted,
            downstreamImpactDependency,
            blockersDependency,
            finalBlockerValueDependencies,
            relationSetDependency,
          ),
        });
        finalAnalysis = Object.freeze({
          ...currentAnalysis,
          blockerValueAiDependencies: finalBlockerValueDependencies,
        });
      }
      const importanceAssessment =
        currentAnalysis?.importanceAssessment ?? previousItem?.importanceAssessment;
      assertNonNullable(importanceAssessment, `最終項目 ${item.nodeId}の重要度判定がありません`);
      const deadlineAssessment =
        currentAnalysis?.deadlineAssessment ?? previousItem?.deadlineAssessment;
      assertNonNullable(deadlineAssessment, `最終項目 ${item.nodeId}の期限判定がありません`);
      const trackedItem = itemWithImportance(
        configuration,
        inventory,
        resolveLabelEffects,
        baseItem,
        downstreamImpact,
        downstreamImpactDependency,
        importanceAssessment,
        deadlineAssessment,
      );
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `追跡項目 ${item.nodeId}のseverity再計算結果がありません`);
      const deadlineLevel = deadlineLevelForAssessment(
        trackedItem.deadlineAssessment,
        collection.evaluatedAt,
        configuration.config.staleness.timezone,
      );
      const aiDependencies = finalizedTrackedItemAiDependencies(
        trackedItem,
        finalAnalysis,
        previousItem,
        downstreamImpactDependency,
        blockersDependency,
        relationSetDependency,
        currentAiDependencyContext,
        deadlineLevel,
        staleness,
      );
      const attention = calculateAttention({
        importanceScore: trackedItem.importance.score,
        deadlineLevel,
        deadlinePoints: configuration.config.attention.deadlinePoints,
        elapsedHours: staleness.elapsedHours,
        waitClass: staleness.waitClass,
        thresholdsHours: configuration.config.staleness.thresholdsHours,
        recencyFloor: configuration.config.attention.recencyFloor,
        levels: configuration.config.attention.levels,
      });
      return Object.freeze({
        ...trackedItem,
        aiDependencies,
        deadlineLevel,
        attention,
        severity: staleness.severity,
        severityContext: staleness.severityContext,
      });
    }),
  );
}

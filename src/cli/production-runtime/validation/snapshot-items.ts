import { serializeCanonicalJson } from "../../../canonical-json/index.js";
import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import {
  calculateImportance,
  combineImportance,
  createLabelEffectsResolver,
  type Evidence,
  type GraphNodeId,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
} from "../../../domain/index.js";
import type { AnalyzeGraphResult, ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { requirePersonalReminderAnalyzedItem } from "../../personal-reminder/index.js";
import { normalizeLabelRules } from "../label-rules.js";
import { resolveDeadlineAssessment, resolveImportanceAssessment } from "../analysis-assessments.js";
import { aiDependencyReconciliationContext } from "../ai-dependencies/reconciliation-context.js";
import {
  aiDependencyForElementApplication,
  combineSelectedAiDependencies,
} from "../ai-dependencies/selection.js";
import type {
  CollectedItems,
  GraphResult,
  PendingTrackedItem,
  PersonalReminderAnalysis,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
  TrackedItemWithImportanceAssessment,
} from "../contracts.js";
import {
  blockersAiDependenciesByNodeId,
  downstreamImpactAiDependenciesByNodeId,
  graphAiDependenciesByNodeId,
  graphAiDependencyForNode,
} from "../graph-result-indexes.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { retainedBlockerValueAiDependenciesByNodeId } from "./retained-blocker-dependencies.js";
import { nativeOpenBlockerNodeIdsByTargetNodeId } from "./retained-blocker-topology.js";
import type { CurrentAiDependencyContext } from "./retained-ai-producers.js";
import {
  deadlineLevelForAssessment,
  finalizedTrackedItemAiDependencies,
} from "./snapshot-item-ai-dependencies.js";

function downstreamImpactsByNodeId(
  graph: GraphResult,
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

function graphMapValue<T>(
  valuesByNodeId: ReadonlyMap<GraphNodeId, T>,
  nodeId: GraphNodeId,
  description: string,
): T {
  const value = valuesByNodeId.get(nodeId);
  assertNonNullable(value, `${description}がありません。対象: ${nodeId}`);
  return value;
}

function createTrackedItemWithImportance(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
  item: PendingTrackedItem,
  downstreamImpact: AnalyzeGraphResult["downstreamImpacts"][number],
  downstreamImpactDependency: AiAnalysisDependency,
  naturalLanguageAssessment: NaturalLanguageImportanceAssessmentState,
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState,
): TrackedItemWithImportanceAssessment {
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
    naturalLanguageAssessment,
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
    ...(naturalLanguageCanAffectImportance
      ? [aiDependencyForElementApplication(item.nodeId, item.aiAnalysis.applications, "importance")]
      : []),
    ...(downstreamImpactCanAffectImportance ? [downstreamImpactDependency] : []),
  ];
  return Object.freeze({
    ...item,
    importanceAssessment: naturalLanguageAssessment,
    deadlineAssessment,
    importance,
    aiDependencies: Object.freeze({
      ...item.aiDependencies,
      importance: combineSelectedAiDependencies(importanceDependencies),
    }),
  });
}

/** 保存スナップショットの項目を組み立てる。 */
export function snapshotItems(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  personalReminderAnalysis: PersonalReminderAnalysis,
): readonly TrackedItemWithImportanceAssessment[] {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentAnalysisByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const previousSnapshotItems = previousSnapshot(state)?.items ?? [];
  const previousSnapshotItemByNodeId = new Map(
    previousSnapshotItems.map((item) => [item.nodeId, item]),
  );
  const downstreamImpactByNodeId = downstreamImpactsByNodeId(graph);
  const downstreamImpactDependenciesByNodeId = downstreamImpactAiDependenciesByNodeId(graph);
  const blockersDependenciesByNodeId = blockersAiDependenciesByNodeId(graph);
  const relationSetDependenciesByNodeId = graphAiDependenciesByNodeId(
    graph.relationSetAiDependencies,
    "relation集合AI依存",
  );
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
  const items = reduction.items.map((item) => {
    const currentAnalysis = currentAnalysisByNodeId.get(item.nodeId);
    const previousItem = previousSnapshotItemByNodeId.get(item.nodeId);
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
    const trackedItem = createTrackedItemWithImportance(
      configuration,
      inventory,
      resolveLabelEffects,
      item,
      downstreamImpact,
      downstreamImpactDependency,
      resolveImportanceAssessment(
        currentAnalysis?.importanceAssessment ?? previousItem?.importanceAssessment,
        undefined,
      ),
      resolveDeadlineAssessment(
        currentAnalysis?.deadlineAssessment ?? previousItem?.deadlineAssessment,
        undefined,
      ),
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
      currentAnalysis,
      previousItem,
      downstreamImpactDependency,
      blockersDependency,
      relationSetDependency,
      currentAiDependencyContext,
      deadlineLevel,
      staleness,
    );
    const personalReminderItem = requirePersonalReminderAnalyzedItem(
      personalReminderAnalysis.result,
      item.nodeId,
    );
    const evidenceByIdentity = new Map<string, Evidence>();
    for (const evidence of [...trackedItem.evidence, ...personalReminderItem.evidence]) {
      evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
    }
    const evidence = [...evidenceByIdentity.values()].sort((left, right) => {
      const leftIdentity = serializeCanonicalJson(left);
      const rightIdentity = serializeCanonicalJson(right);
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    });
    return Object.freeze({
      ...trackedItem,
      aiDependencies,
      personalReminderCauses: personalReminderItem.causeResults.map(({ cause }) => cause),
      personalReminderCausePlanning: personalReminderItem.planning,
      evidence: Object.freeze(evidence),
    });
  });
  return items;
}

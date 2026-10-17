import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  reconcileRetainedAiAnalysisDependency,
  trackedItemAiDependenciesSchema,
} from "../../../domain/ai-analysis-dependencies.js";
import {
  calculateStaleness,
  currentAiResult,
  createLabelEffectsResolver,
  resolveWaitingOnAccountIdentifiers,
  type GitHubNodeId,
} from "../../../domain/index.js";
import type { RelationCandidateAssessment } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import { adoptedOutput } from "./graph-reconciliation-adopted-output.js";
import { trackedItemAiAnalysisFromAdoption } from "./graph-reconciliation-ai-analysis.js";
import {
  blockerValueAiDependencies,
  unknownBlockerValueAiDependencies,
} from "./graph-reconciliation-blocker-values.js";
import { aiDependencyReconciliationContext } from "./graph-reconciliation-ai-dependency-context.js";
import {
  deadlineAssessmentFromAdoption,
  importanceAssessmentFromAdoption,
} from "./graph-reconciliation-assessments.js";
import type {
  GraphBlockerValueAiDependencies,
  GraphWorkingCollection,
  GraphNotificationRecommendation,
  GraphWorkingResult,
  PendingGraphTrackedItem,
  GraphWorkingReduction,
  GraphReducedItem,
  GraphWorkingInventory,
  GraphWorkingConfiguration,
  GraphWorkingState,
  GraphTrackedItemStaleness,
} from "./graph-reconciliation-contracts.js";
import {
  blockerNodeAiDependenciesByBlockedNodeId,
  blockersAiDependenciesByNodeId,
  downstreamImpactAiDependenciesByNodeId,
  graphAiDependenciesByNodeId,
  graphAiDependencyForNode,
} from "./graph-reconciliation-graph-indexes.js";
import { normalizeLabelRules } from "./collection-label-rules.js";
import { decisionFromAdoption } from "./graph-reconciliation-decision.js";
import { previousSnapshot, previousTrackedItem } from "./graph-reconciliation-previous-items.js";
import type { PreviousGraphIndex } from "./graph-reconciliation-previous.js";
import { findRepository, repositoryFullName } from "./graph-reconciliation-repositories.js";
import {
  notificationRecommendationFromAdoption,
  notificationRecommendationFromResult,
  relationAssessmentsFromAdoption,
} from "./graph-reconciliation-relations.js";
import {
  primaryWaitingOnForDecision,
  transitionBasisForDecision,
} from "./graph-reconciliation-decision-basis.js";
import { createDependencyResolutionStaticIndexes } from "./graph-reconciliation-dependency-resolution-indexes.js";
import { dependencyResolutions } from "./graph-reconciliation-dependency-resolutions.js";
import {
  createGraphBlockerIndex,
  naturalLanguageProgressAssessments,
  reassessDeterministicAnalysis,
} from "./graph-reconciliation-reassessment.js";
import { createSelfCommitmentCause } from "./graph-reconciliation-self-commitment-cause.js";
import {
  blockedParentContext,
  createBlockedParentIndex,
  previousStalenessState,
  recalculateTrackedItemStaleness,
  retainedItemNotificationClass,
  retainedItemObservedAt,
  trackedItemStaleness,
} from "./graph-reconciliation-staleness.js";
import { createTrackedItem } from "./graph-reconciliation-tracked-item.js";

/** 項目単位の解析結果を統合する。 */
export function reduceAnalysisPass(
  configuration: GraphWorkingConfiguration,
  state: GraphWorkingState,
  inventory: GraphWorkingInventory,
  collection: GraphWorkingCollection,
  adopted: GenericAiAdoptedRun,
  graph: GraphWorkingResult | undefined,
  previousIndex: PreviousGraphIndex,
): GraphWorkingReduction {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const deterministicAnalysis = adopted.data.facts;
  const adoptedByNodeId = new Map(adopted.data.items.map((item) => [item.nodeId, item]));
  const downstreamImpactDependenciesByNodeId =
    graph == null ? undefined : downstreamImpactAiDependenciesByNodeId(graph);
  const blockersDependenciesByNodeId =
    graph == null ? undefined : blockersAiDependenciesByNodeId(graph);
  const blockerNodeDependenciesByBlockedNodeId =
    graph == null ? undefined : blockerNodeAiDependenciesByBlockedNodeId(graph);
  const negativeBlockerDependenciesByNodeId =
    graph == null
      ? undefined
      : graphAiDependenciesByNodeId(graph.negativeBlockerAiDependencies, "negative blocker AI依存");
  const relationSetDependenciesByNodeId =
    graph == null
      ? undefined
      : graphAiDependenciesByNodeId(graph.relationSetAiDependencies, "relation集合AI依存");
  const dependencyResolutionStaticIndexes =
    graph == null || graph.analysis.newlyUnblockedNodeIds.length === 0
      ? undefined
      : createDependencyResolutionStaticIndexes(state, collection, graph);
  const graphBlockerIndex = graph == null ? undefined : createGraphBlockerIndex(graph);
  const blockedParentIndex = createBlockedParentIndex(state, graph, previousIndex);
  const currentItems: GraphReducedItem[] = [];
  const items: PendingGraphTrackedItem[] = [];
  const stalenessByNodeId = new Map<GitHubNodeId, GraphTrackedItemStaleness>();
  const relationAssessments: RelationCandidateAssessment[] = [];
  const retainedNotificationRecommendations = new Map<
    GitHubNodeId,
    GraphNotificationRecommendation
  >();
  let runStatus: GraphWorkingReduction["runStatus"] = "success";
  for (const originalAnalysis of deterministicAnalysis.items) {
    const adoptedItem = adoptedByNodeId.get(originalAnalysis.item.nodeId);
    assertNonNullable(
      adoptedItem,
      `汎用AIの採用項目がありません。対象: ${originalAnalysis.item.nodeId}`,
    );
    const output = adoptedOutput(adoptedItem);
    const analysis = reassessDeterministicAnalysis(
      collection.evaluatedAt,
      configuration,
      inventory,
      originalAnalysis,
      output,
      graphBlockerIndex,
    );
    const relationAssessmentsForAnalysis = relationAssessmentsFromAdoption(
      analysis.item.nodeId,
      output,
    );
    const notificationRecommendation = notificationRecommendationFromAdoption(
      output,
      configuration.config.ai.confidence,
    );
    const decision = decisionFromAdoption(
      analysis.decision,
      adoptedItem,
      configuration.config.ai.confidence,
    );
    if (adoptedItem.status === "failed" || adoptedItem.status === "deferred") {
      runStatus = "fallback";
    }
    relationAssessments.push(...relationAssessmentsForAnalysis);
    const basis = transitionBasisForDecision(analysis, decision);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const aiAnalysis = trackedItemAiAnalysisFromAdoption(adoptedItem);
    const primaryWaitingOn = primaryWaitingOnForDecision(
      analysis.decision,
      decision,
      aiAnalysis.applications.waitingOn,
    );
    const dependencyResolution = dependencyResolutions(
      collection,
      graph,
      dependencyResolutionStaticIndexes,
      relationAssessmentsForAnalysis,
      analysis,
    );
    const previousItem = previousTrackedItem(state, analysis.item.nodeId);
    const selfCommitmentCause = createSelfCommitmentCause({
      analysis,
      selfCommitmentResult: output.selfCommitment,
      previous:
        previousItem == null
          ? Object.freeze({
              availability: "not_available",
            })
          : Object.freeze({
              availability: "available",
              observedAt: previousItem.observedAt,
            }),
      evaluatedAt: collection.evaluatedAt,
      highConfidence: configuration.config.ai.confidence.high,
    });
    const staleness = calculateStaleness({
      itemType: analysis.item.type,
      createdAt: analysis.item.createdAt,
      evaluatedAt: collection.evaluatedAt,
      currentDecision: {
        status: decision.status,
        waitingOn: decision.waitingOn,
        confidence: decision.confidence,
        statusBasis: basis.statusBasis,
        responsibilityBasis: basis.responsibilityBasis,
      },
      decisionBasis: decision.origin === "deterministic" ? "deterministic" : "ai_only",
      previousState: previousStalenessState(state, analysis.item.nodeId),
      events: analysis.item.events,
      responsibleAccountIdentifiers: resolveWaitingOnAccountIdentifiers(decision.waitingOn),
      dependencyResolutions: dependencyResolution.progress,
      naturalLanguageAssessments: naturalLanguageProgressAssessments(analysis, output),
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      repositoryFullName: repositoryFullName(repository),
      currentLabels: analysis.item.labels,
      resolveLabelEffects,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      blockedParentContext: blockedParentContext(decision, blockedParentIndex),
    });
    const downstreamImpactDependency =
      graph == null
        ? undefined
        : graphAiDependencyForNode(
            downstreamImpactDependenciesByNodeId,
            analysis.item.nodeId,
            "downstream impact",
          );
    const blockersDependency =
      graph == null
        ? undefined
        : graphAiDependencyForNode(blockersDependenciesByNodeId, analysis.item.nodeId, "blocker");
    let blockerValueDependencies: GraphBlockerValueAiDependencies;
    if (graph == null) {
      blockerValueDependencies = unknownBlockerValueAiDependencies();
    } else {
      assertNonNullable(
        blockerNodeDependenciesByBlockedNodeId,
        "blocker node AI依存indexがありません",
      );
      assertNonNullable(
        negativeBlockerDependenciesByNodeId,
        "negative blocker AI依存indexがありません",
      );
      blockerValueDependencies = blockerValueAiDependencies(
        analysis.item.nodeId,
        analysis.decision.blockerDecisionTrace,
        blockerNodeDependenciesByBlockedNodeId,
        negativeBlockerDependenciesByNodeId,
      );
    }
    const relationSetDependency =
      graph == null
        ? undefined
        : graphAiDependencyForNode(
            relationSetDependenciesByNodeId,
            analysis.item.nodeId,
            "relation集合",
          );
    currentItems.push(
      Object.freeze({
        item: analysis.item,
        detail: analysis.detail,
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates,
        decision,
        deterministicDecision: analysis.decision,
        blockerValueAiDependencies: blockerValueDependencies,
        localResponsibilityDecision: analysis.localResponsibilityDecision,
        aiAnalysisApplications: aiAnalysis.applications,
        selfCommitmentCause,
        statusBasis: basis.statusBasis,
        responsibilityBasis: basis.responsibilityBasis,
        dependencyCause: dependencyResolution.cause,
        notificationRecommendation,
        primaryWaitingOn,
        staleness,
        importanceAssessment: importanceAssessmentFromAdoption(output),
        deadlineAssessment: deadlineAssessmentFromAdoption(output),
      }),
    );
    stalenessByNodeId.set(analysis.item.nodeId, trackedItemStaleness(staleness));
    items.push(
      createTrackedItem(
        state,
        analysis,
        decision,
        primaryWaitingOn,
        staleness,
        aiAnalysis,
        adoptedItem,
        downstreamImpactDependency,
        blockersDependency,
        blockerValueDependencies,
        relationSetDependency,
      ),
    );
  }
  const currentNodeIds = new Set(items.map((item) => item.nodeId));
  const currentRepositoryIds = new Set<string>(
    inventory.repositories.map((repository) => repository.id),
  );
  for (const previousItem of previousSnapshot(state)?.items ?? []) {
    if (
      !currentNodeIds.has(previousItem.nodeId) &&
      collection.trackedNodeIds.has(previousItem.nodeId) &&
      currentRepositoryIds.has(previousItem.repositoryId)
    ) {
      items.push(
        Object.freeze({
          ...previousItem,
          notificationClass: retainedItemNotificationClass(collection, previousItem),
          observedAt: retainedItemObservedAt(collection, previousItem),
        }),
      );
      stalenessByNodeId.set(
        previousItem.nodeId,
        recalculateTrackedItemStaleness(
          collection.evaluatedAt,
          configuration,
          inventory,
          previousItem,
          resolveLabelEffects,
        ),
      );
      const retainedNotification = notificationRecommendationFromResult(
        currentAiResult(previousItem.aiAnalysis, "notification"),
        configuration.config.ai.confidence,
      );
      if (retainedNotification.availability === "available") {
        retainedNotificationRecommendations.set(previousItem.nodeId, retainedNotification);
      }
    }
  }
  if (stalenessByNodeId.size !== items.length) {
    throw new TypeError("全追跡項目のseverityを再計算できませんでした");
  }
  const dependencyContext =
    graph == null
      ? undefined
      : aiDependencyReconciliationContext(items, collection.relationCandidates, graph);
  const normalizedItems = items.map((item) => {
    if (dependencyContext == null || currentNodeIds.has(item.nodeId)) {
      return item;
    }
    return Object.freeze({
      ...item,
      aiDependencies: Object.freeze(
        trackedItemAiDependenciesSchema.parse(
          Object.fromEntries(
            AI_ANALYSIS_DEPENDENCY_ELEMENTS.map((element) => [
              element,
              item.aiDependencies[element].status !== "not_dependent" &&
              item.aiDependencies[element].producers?.some(
                (producer) => producer.kind === "relation_candidate",
              ) === true
                ? reconcileRetainedAiAnalysisDependency(
                    item.aiDependencies[element],
                    dependencyContext,
                  )
                : item.aiDependencies[element],
            ]),
          ),
        ),
      ),
    });
  });
  return Object.freeze({
    items: Object.freeze(normalizedItems),
    currentItems: Object.freeze(currentItems),
    stalenessByNodeId,
    relationAssessments: Object.freeze(relationAssessments),
    retainedNotificationRecommendations,
    runStatus,
  });
}

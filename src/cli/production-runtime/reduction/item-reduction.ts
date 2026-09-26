import { reducePreservedCodexRelationsAndNotification } from "../../../codex/index.js";
import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  reconcileRetainedAiAnalysisDependency,
  trackedItemAiDependenciesSchema,
} from "../../../domain/ai-analysis-dependencies.js";
import {
  calculateStaleness,
  createLabelEffectsResolver,
  resolveWaitingOnAccountIdentifiers,
  type GitHubNodeId,
} from "../../../domain/index.js";
import type { DiscordNotificationItem } from "../../../discord/index.js";
import type { RelationCandidateAssessment } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import {
  blockerValueAiDependencies,
  unknownBlockerValueAiDependencies,
} from "../ai-dependencies/blocker-values.js";
import { aiDependencyReconciliationContext } from "../ai-dependencies/reconciliation-context.js";
import { resolveDeadlineAssessment, resolveImportanceAssessment } from "../analysis-assessments.js";
import type {
  BlockerValueAiDependencies,
  CodexAnalysis,
  CollectedItems,
  DeterministicAnalysis,
  GraphResult,
  PendingTrackedItem,
  ReducedAnalysis,
  ReducedItemAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
  TrackedItemStaleness,
} from "../contracts.js";
import {
  blockerNodeAiDependenciesByBlockedNodeId,
  blockersAiDependenciesByNodeId,
  downstreamImpactAiDependenciesByNodeId,
  graphAiDependenciesByNodeId,
  graphAiDependencyForNode,
} from "../graph-result-indexes.js";
import { normalizeLabelRules } from "../label-rules.js";
import { preservedElementsWithCompatibleRelations } from "../preserved-codex-relations.js";
import { preservedElementsForRetainedItem } from "../previous-state/saved-ai-elements.js";
import { previousSnapshot, previousTrackedItem } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import {
  currentAdoptedDeadlineAssessment,
  currentAdoptedImportanceAssessment,
} from "./assessment-adoption.js";
import { reducedDeterministicDecision, reductionForAnalysis } from "./codex-reduction.js";
import { codexOutputForConsumers } from "./consumer-output.js";
import { primaryWaitingOnForDecision, transitionBasisForDecision } from "./decision-basis.js";
import { createDependencyResolutionStaticIndexes } from "./dependency-resolution-indexes.js";
import { dependencyResolutions } from "./dependency-resolutions.js";
import {
  createGraphBlockerIndex,
  naturalLanguageProgressAssessments,
  reassessDeterministicAnalysis,
} from "./reassessment.js";
import { preservedElementsForAnalysisReduction } from "./retained-results.js";
import { createSelfCommitmentCause } from "./self-commitment-cause.js";
import {
  blockedParentContext,
  createBlockedParentIndex,
  previousStalenessState,
  recalculateTrackedItemStaleness,
  retainedItemNotificationClass,
  retainedItemObservedAt,
  trackedItemStaleness,
} from "./staleness.js";
import { createTrackedItem, trackedItemAiAnalysis } from "./tracked-item.js";

/** 項目単位の解析結果を統合する。 */
export function reduceAnalysisPass(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  graph: GraphResult | undefined,
): ReducedAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const target = forcedAiAnalysisTarget(configuration);
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
  const blockedParentIndex = createBlockedParentIndex(state, graph);
  const currentItems: ReducedItemAnalysis[] = [];
  const items: PendingTrackedItem[] = [];
  const stalenessByNodeId = new Map<GitHubNodeId, TrackedItemStaleness>();
  const relationAssessments: RelationCandidateAssessment[] = [];
  const retainedNotificationRecommendations = new Map<
    GitHubNodeId,
    DiscordNotificationItem["notificationRecommendation"]
  >();
  let runStatus: ReducedAnalysis["runStatus"] = "success";
  for (const originalAnalysis of deterministicAnalysis.items) {
    const output = codexOutputForConsumers(configuration, state, originalAnalysis, codexAnalysis);
    const analysis = reassessDeterministicAnalysis(
      collection.evaluatedAt,
      configuration,
      inventory,
      originalAnalysis,
      output,
      graphBlockerIndex,
    );
    const reduction = reductionForAnalysis(configuration, state, analysis, codexAnalysis);
    const planning = codexAnalysis.elementPlanningByNodeId.get(analysis.item.nodeId);
    assertNonNullable(planning, `AI判定要素の計画がありません。対象: ${analysis.item.nodeId}`);
    const relationNotificationReduction =
      reduction ??
      reducePreservedCodexRelationsAndNotification(
        analysis.item.nodeId,
        preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
        configuration.config.ai.confidence,
      );
    const relationAssessmentsForAnalysis = relationNotificationReduction.relationAssessments;
    const notificationRecommendation = relationNotificationReduction.notification;
    const decision = reduction?.decision ?? reducedDeterministicDecision(analysis.decision);
    if (reduction?.ai.status === "unavailable") {
      runStatus = "fallback";
    }
    relationAssessments.push(...relationAssessmentsForAnalysis);
    const basis = transitionBasisForDecision(analysis, decision);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const aiAnalysis = trackedItemAiAnalysis(
      configuration,
      state,
      analysis,
      codexAnalysis,
      reduction,
      output,
    );
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
      selfCommitmentResult: output?.selfCommitment,
      analysisInput: codexAnalysis.inputByNodeId.get(analysis.item.nodeId),
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
    let blockerValueDependencies: BlockerValueAiDependencies;
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
        blockerValueAiDependencies: blockerValueDependencies,
        localResponsibilityDecision: analysis.localResponsibilityDecision,
        aiAnalysisApplications: aiAnalysis.applications,
        selfCommitmentCause,
        statusBasis: basis.statusBasis,
        responsibilityBasis: basis.responsibilityBasis,
        dependencyCause: dependencyResolution.cause,
        notificationRecommendation:
          notificationRecommendation == null
            ? Object.freeze({
                availability: "not_available",
              })
            : Object.freeze({
                availability: "available",
                value: notificationRecommendation,
              }),
        primaryWaitingOn,
        staleness,
        importanceAssessment: resolveImportanceAssessment(
          reduction?.importanceAssessment,
          currentAdoptedImportanceAssessment(
            state,
            analysis,
            planning.candidates.importance.savedReuse?.result,
            planning,
            target,
          ),
        ),
        deadlineAssessment: resolveDeadlineAssessment(
          reduction?.deadlineAssessment,
          currentAdoptedDeadlineAssessment(
            state,
            analysis,
            planning.candidates.deadline.savedReuse?.result,
            planning,
            target,
          ),
        ),
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
        downstreamImpactDependency,
        blockersDependency,
        blockerValueDependencies,
        relationSetDependency,
      ),
    );
  }
  const currentNodeIds = new Set(items.map((item) => item.nodeId));
  const currentRepositoryIds = new Set<string>(
    inventory.allowlist.repositories.map((repository) => repository.id),
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
      const preservedElements = preservedElementsWithCompatibleRelations(
        preservedElementsForRetainedItem(previousItem),
        undefined,
      );
      const preservedReduction = reducePreservedCodexRelationsAndNotification(
        previousItem.nodeId,
        preservedElements,
        configuration.config.ai.confidence,
      );
      relationAssessments.push(...preservedReduction.relationAssessments);
      if (preservedReduction.notification != null) {
        retainedNotificationRecommendations.set(
          previousItem.nodeId,
          Object.freeze({
            availability: "available",
            value: preservedReduction.notification,
          }),
        );
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

import type { CodexAnalysisReduction, ReducedCodexDecision } from "../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
} from "../../../domain/ai-analysis-elements.js";
import type {
  AiAnalysisDependency,
  TrackedItemAiDependencies,
} from "../../../domain/ai-analysis-dependencies.js";
import {
  aggregatePullRequestCheckState,
  aggregatePullRequestReviewState,
  createTrackedItemLatestEventActor,
  isTerminalStatus,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type GitHubNodeId,
  type IssueStateDecision,
  type PrimaryWaitingOn,
  type PullRequestStateDecision,
  type SourceId,
  type StalenessResult,
  type TrackedItemAiAnalysis,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import { type FreshObservedGitHubItem } from "../../../github/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { trackedItemInputEvents } from "../../tracked-item-input-events.js";
import { aiAnalysisRunIndex, generatedElementsForNode } from "../ai-analysis-run-index.js";
import { forcedAiAnalysisTarget, isForcedUnexecutedElement } from "../ai-analysis-target.js";
import { unknownBlockerValueAiDependencies } from "../ai-dependencies/blocker-values.js";
import {
  aiDependencyForElementApplication,
  notDependentAiDependency,
  unrecordedAiDependency,
} from "../ai-dependencies/selection.js";
import { criticalSeverityWasRequested, severityAiDependency } from "../ai-dependencies/severity.js";
import { stallSinceAiDependency } from "../ai-dependencies/stall-since.js";
import type {
  BlockerValueAiDependencies,
  CodexAnalysis,
  PendingTrackedItem,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { savedEvaluationRecordForElement } from "../previous-state/saved-ai-elements.js";
import { previousTrackedItem } from "../previous-state/snapshot.js";
import { sourceOccurredAtByIdForAnalysis } from "../relation-source-occurrence.js";
import { aiAnalysisElementApplicationsForAnalysis } from "./element-applications.js";
import type { ConsumerCodexElementOutput } from "./consumer-output.js";
import {
  evaluationRecordsForAnalysis,
  evaluatedElementsForGenerations,
  forcedMigrationReuseRecordsForAnalysis,
} from "./evaluation-records.js";
import { adoptedElementsForAnalysis } from "./current-adopted-elements.js";
import {
  migratedElementsForAnalysis,
  mixedAdoptedElementsForAnalysis,
} from "./migrated-elements.js";
import { adoptedRecordsForPlanning } from "./retained-results.js";
import {
  stateAiDependencies,
  confidenceAiDependency,
  evidenceAiDependency,
  uncertaintiesAiDependency,
  lastProgressAiDependency,
} from "./state-ai-dependencies.js";
import { transitionBasisForDecision } from "./decision-basis.js";
import { trackedItemState } from "./staleness.js";

/** 追跡項目のAI解析記録を構築する。 */
export function trackedItemAiAnalysis(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
): TrackedItemAiAnalysis {
  const nodeId = analysis.item.nodeId;
  const generations = codexAnalysis.elementGenerationsByNodeId.get(nodeId);
  assertNonNullable(generations, `AI判定要素の保存結果がありません。対象: ${nodeId}`);
  const planning = codexAnalysis.elementPlanningByNodeId.get(nodeId);
  assertNonNullable(planning, `AI判定要素の計画がありません。対象: ${nodeId}`);
  const target = forcedAiAnalysisTarget(configuration);
  const run = codexAnalysis.run;
  const migratedElements = migratedElementsForAnalysis(
    state,
    analysis,
    planning,
    run,
    reduction,
    consumerOutput,
    target,
  );
  const adoptedElements = adoptedElementsForAnalysis(
    state,
    analysis,
    planning,
    run,
    migratedElements,
    reduction,
    consumerOutput,
    target,
  );
  const generatedElements = generatedElementsForNode(codexAnalysis.run, nodeId);
  const missingEvaluationElements = new Set<AiAnalysisElement>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (
      generatedElements[element] == null &&
      isForcedUnexecutedElement(analysis, element, target) &&
      planning.candidates[element].necessity === "required" &&
      savedEvaluationRecordForElement(state, nodeId, element) == null
    ) {
      missingEvaluationElements.add(element);
    }
  }
  const evaluationRecords = evaluationRecordsForAnalysis(
    state,
    analysis,
    planning,
    generations,
    run,
    adoptedElements,
    migratedElements,
    target,
  );
  const elements = evaluatedElementsForGenerations(
    generations,
    evaluationRecords,
    missingEvaluationElements,
  );
  const applications = aiAnalysisElementApplicationsForAnalysis(
    state,
    analysis,
    planning,
    run,
    reduction,
    consumerOutput,
  );
  let status: TrackedItemAiAnalysis["status"];
  if (run == null) {
    status = "disabled";
  } else {
    const runIndex = aiAnalysisRunIndex(run);
    const result = runIndex.resultByNodeId.get(nodeId);
    if (result != null) {
      status = "used";
    } else {
      const failure = runIndex.failureByNodeId.get(nodeId);
      if (failure != null) {
        status = "failed";
      } else {
        const deferred = runIndex.deferredByNodeId.get(nodeId);
        if (deferred != null) {
          status = "deferred";
        } else {
          const skipped = runIndex.skippedByNodeId.get(nodeId);
          assertNonNullable(skipped, `Codex分析候補の分類がありません。対象: ${nodeId}`);
          status = skipped.reason === "not_required" ? "not_required" : "used";
        }
      }
    }
  }
  if (Object.keys(migratedElements).length !== 0) {
    const reuseRecords = Object.freeze({
      ...adoptedRecordsForPlanning(planning),
      ...forcedMigrationReuseRecordsForAnalysis(state, analysis, planning, target),
    });
    return Object.freeze({
      origin: "migration",
      status,
      elements,
      adoptedElements: mixedAdoptedElementsForAnalysis(
        adoptedElements,
        migratedElements,
        reuseRecords,
      ),
      applications,
    });
  }
  return Object.freeze({
    origin: "current",
    status,
    elements,
    adoptedElements,
    applications,
  });
}

function trackedItemAiDependenciesForAnalysis(
  state: RuntimeState,
  item: FreshObservedGitHubItem,
  nodeId: GitHubNodeId,
  decision: ReducedCodexDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  staleness: StalenessResult,
  statusBasis: IssueStateDecision["statusBasis"],
  responsibilityBasis: IssueStateDecision["responsibilityBasis"],
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  aiAnalysis: TrackedItemAiAnalysis,
  downstreamImpactDependency: AiAnalysisDependency | undefined,
  blockersDependency: AiAnalysisDependency | undefined,
  blockerValueDependencies: BlockerValueAiDependencies | undefined,
  relationSetDependency: AiAnalysisDependency | undefined,
): TrackedItemAiDependencies {
  const applications = aiAnalysis.applications;
  const resolvedBlockerValueDependencies =
    blockerValueDependencies ?? unknownBlockerValueAiDependencies();
  const stateDependencies = stateAiDependencies(
    nodeId,
    applications,
    resolvedBlockerValueDependencies,
  );
  const previousItem = previousTrackedItem(state, nodeId);
  const resolvedDownstreamImpactDependency = downstreamImpactDependency ?? unrecordedAiDependency();
  const resolvedBlockersDependency = blockersDependency ?? unrecordedAiDependency();
  const resolvedRelationSetDependency = relationSetDependency ?? unrecordedAiDependency();
  const baseDependencies = {
    status: stateDependencies.status,
    waitingOn: stateDependencies.waitingOn,
    primaryWaitingOn: stateDependencies.primaryWaitingOn,
    nextAction: stateDependencies.nextAction,
    confidence: confidenceAiDependency(nodeId, applications, resolvedBlockerValueDependencies),
    evidence: evidenceAiDependency(
      nodeId,
      decision,
      deterministicDecision,
      applications,
      resolvedBlockerValueDependencies,
    ),
    uncertainties: uncertaintiesAiDependency(
      nodeId,
      applications,
      resolvedBlockerValueDependencies.uncertainties,
    ),
    deadline: aiDependencyForElementApplication(nodeId, applications, "deadline"),
    deadlineLevel: aiDependencyForElementApplication(nodeId, applications, "deadline"),
    lastProgressAt: lastProgressAiDependency(
      nodeId,
      item.createdAt,
      applications,
      staleness,
      previousItem,
    ),
    stallSince: notDependentAiDependency(),
    severity: notDependentAiDependency(),
    downstreamImpact: resolvedDownstreamImpactDependency,
    importance: aiDependencyForElementApplication(nodeId, applications, "importance"),
    attention: notDependentAiDependency(),
    blockers: resolvedBlockersDependency,
    relationSet: resolvedRelationSetDependency,
  } satisfies TrackedItemAiDependencies;
  const stallSince = stallSinceAiDependency(
    item,
    applications,
    sourceOccurredAtById,
    decision,
    staleness,
    baseDependencies,
    previousItem,
    statusBasis,
    responsibilityBasis,
    resolvedBlockerValueDependencies.transitionBasis,
  );
  const dependenciesWithStallSince = Object.freeze({
    ...baseDependencies,
    stallSince,
  });
  return Object.freeze({
    ...dependenciesWithStallSince,
    severity: severityAiDependency(
      decision,
      staleness,
      criticalSeverityWasRequested(staleness.severityReason),
      dependenciesWithStallSince,
    ),
  });
}

/** 追跡項目を作成する。 */
export function createTrackedItem(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
  primaryWaitingOn: PrimaryWaitingOn,
  staleness: StalenessResult,
  aiAnalysis: TrackedItemAiAnalysis,
  downstreamImpactDependency: AiAnalysisDependency | undefined,
  blockersDependency: AiAnalysisDependency | undefined,
  blockerValueDependencies: BlockerValueAiDependencies | undefined,
  relationSetDependency: AiAnalysisDependency | undefined,
): PendingTrackedItem {
  const transitionBasis = transitionBasisForDecision(analysis, decision);
  const commonFields = {
    nodeId: analysis.item.nodeId,
    type: analysis.item.type,
    repositoryId: analysis.item.repositoryId,
    displayReference: analysis.item.displayReference,
    number: analysis.item.number,
    url: analysis.item.url,
    title: analysis.item.title,
    author: analysis.item.author,
    latestEventActor: createTrackedItemLatestEventActor(analysis.item.events),
    state: trackedItemState(analysis.item, decision),
    notificationClass: analysis.notificationClass,
    primaryWaitingOn,
    nextAction: decision.nextAction,
    createdAt: analysis.item.createdAt,
    githubUpdatedAt: analysis.item.githubUpdatedAt,
    lastHumanActivityAt: staleness.lastHumanActivityAt,
    lastProgressAt: staleness.lastProgressAt,
    statusSince: staleness.statusSince,
    ownerSince: staleness.ownerSince,
    stallSince: staleness.stallSince,
    observedAt: analysis.item.observedAt,
    labels: analysis.item.labels,
    assignees: analysis.item.assignees,
    reviewState:
      analysis.item.type === "issue"
        ? "not_applicable"
        : aggregatePullRequestReviewState(analysis.item),
    checkState:
      analysis.item.type === "issue"
        ? "not_applicable"
        : aggregatePullRequestCheckState(analysis.item.mergeState),
    personalReminderCauses: Object.freeze([]),
    personalReminderCausePlanning: isTerminalStatus(decision.status)
      ? Object.freeze({
          status: "excluded",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          reason: "terminal_without_cause",
        })
      : Object.freeze({
          status: "pending",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        }),
    aiAnalysis,
    aiDependencies: trackedItemAiDependenciesForAnalysis(
      state,
      analysis.item,
      analysis.item.nodeId,
      decision,
      analysis.decision,
      staleness,
      transitionBasis.statusBasis,
      transitionBasis.responsibilityBasis,
      sourceOccurredAtByIdForAnalysis(analysis),
      aiAnalysis,
      downstreamImpactDependency,
      blockersDependency,
      blockerValueDependencies,
      relationSetDependency,
    ),
    inputEvents: trackedItemInputEvents(analysis),
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  } satisfies Omit<PendingTrackedItem, "status" | "waitingOn">;
  if (isTerminalStatus(decision.status)) {
    return Object.freeze({
      ...commonFields,
      status: decision.status,
      waitingOn: Object.freeze([] satisfies []),
    });
  }
  return Object.freeze({
    ...commonFields,
    status: decision.status,
    waitingOn: decision.waitingOn,
  });
}

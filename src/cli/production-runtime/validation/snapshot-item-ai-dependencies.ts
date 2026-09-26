import type { ReducedCodexDecision } from "../../../codex/index.js";
import type {
  AiAnalysisDependency,
  TrackedItemAiDependencies,
} from "../../../domain/ai-analysis-dependencies.js";
import {
  determineDeadlineLevel,
  type DeadlineLevel,
  type NaturalLanguageDeadlineAssessmentState,
  type StalenessResult,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import type { SnapshotTrackedItem } from "../../../persistence/index.js";
import { criticalSeverityWasRequested, severityAiDependency } from "../ai-dependencies/severity.js";
import { combineSelectedAiDependencies } from "../ai-dependencies/selection.js";
import { stallSinceAiDependency } from "../ai-dependencies/stall-since.js";
import { stateDependenciesForWaitClass } from "../ai-dependencies/stall-time.js";
import type {
  ReducedItemAnalysis,
  TrackedItemStaleness,
  TrackedItemWithImportanceAssessment,
} from "../contracts.js";
import { sourceOccurredAtByIdForAnalysis } from "../relation-source-occurrence.js";
import { revalidatedRetainedTrackedItemAiDependency } from "./retained-ai-reconciliation.js";
import type { CurrentAiDependencyContext } from "./retained-ai-producers.js";

/** 期限評価から現在の期限レベルを求める。 */
export function deadlineLevelForAssessment(
  assessment: NaturalLanguageDeadlineAssessmentState,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): DeadlineLevel {
  if (assessment.status === "not_available") {
    return "none";
  }
  return determineDeadlineLevel({
    deadlineDate: assessment.value.date,
    evaluatedAt,
    timezone,
  });
}

function attentionAiDependency(
  decision: Readonly<Pick<ReducedCodexDecision, "status" | "waitingOn" | "evidence">>,
  staleness: Readonly<Pick<StalenessResult, "waitClass">>,
  importance: TrackedItemWithImportanceAssessment["importance"],
  deadlineLevel: DeadlineLevel,
  itemDependencies: TrackedItemAiDependencies,
): AiAnalysisDependency {
  if (staleness.waitClass === "notApplicable" || staleness.waitClass === "blockedParent") {
    return itemDependencies.status;
  }
  const dependencies: AiAnalysisDependency[] = [
    itemDependencies.importance,
    itemDependencies.deadlineLevel,
  ];
  const stateDependencies = stateDependenciesForWaitClass(
    decision,
    staleness.waitClass,
    itemDependencies,
  );
  if (importance.score !== 0) {
    dependencies.push(...stateDependencies);
    dependencies.push(itemDependencies.stallSince);
  }
  if (deadlineLevel !== "none") {
    dependencies.push(...stateDependencies);
  }
  return combineSelectedAiDependencies(dependencies);
}

/** 保存項目に反映するAI依存を確定する。 */
export function finalizedTrackedItemAiDependencies(
  item: TrackedItemWithImportanceAssessment,
  currentAnalysis: ReducedItemAnalysis | undefined,
  previousItem: SnapshotTrackedItem | undefined,
  downstreamImpactDependency: AiAnalysisDependency,
  blockersDependency: AiAnalysisDependency,
  relationSetDependency: AiAnalysisDependency,
  currentAiDependencyContext: CurrentAiDependencyContext,
  deadlineLevel: DeadlineLevel,
  staleness: TrackedItemStaleness,
): TrackedItemAiDependencies {
  const dependencies = Object.freeze({
    ...item.aiDependencies,
    downstreamImpact: downstreamImpactDependency,
    blockers: blockersDependency,
    relationSet: relationSetDependency,
  });
  if (currentAnalysis == null) {
    const retainedDependencies = Object.freeze({
      ...dependencies,
      status: revalidatedRetainedTrackedItemAiDependency(
        item,
        "status",
        dependencies.status,
        currentAiDependencyContext,
      ),
      waitingOn: revalidatedRetainedTrackedItemAiDependency(
        item,
        "waitingOn",
        dependencies.waitingOn,
        currentAiDependencyContext,
      ),
      primaryWaitingOn: revalidatedRetainedTrackedItemAiDependency(
        item,
        "primaryWaitingOn",
        dependencies.primaryWaitingOn,
        currentAiDependencyContext,
      ),
      nextAction: revalidatedRetainedTrackedItemAiDependency(
        item,
        "nextAction",
        dependencies.nextAction,
        currentAiDependencyContext,
      ),
      confidence: revalidatedRetainedTrackedItemAiDependency(
        item,
        "confidence",
        dependencies.confidence,
        currentAiDependencyContext,
      ),
      evidence: revalidatedRetainedTrackedItemAiDependency(
        item,
        "evidence",
        dependencies.evidence,
        currentAiDependencyContext,
      ),
      uncertainties: revalidatedRetainedTrackedItemAiDependency(
        item,
        "uncertainties",
        dependencies.uncertainties,
        currentAiDependencyContext,
      ),
      lastProgressAt: revalidatedRetainedTrackedItemAiDependency(
        item,
        "lastProgressAt",
        dependencies.lastProgressAt,
        currentAiDependencyContext,
      ),
      stallSince: revalidatedRetainedTrackedItemAiDependency(
        item,
        "stallSince",
        dependencies.stallSince,
        currentAiDependencyContext,
      ),
    });
    return Object.freeze({
      ...retainedDependencies,
      severity: severityAiDependency(
        item,
        staleness,
        staleness.criticalRequested,
        retainedDependencies,
      ),
      attention: attentionAiDependency(
        item,
        staleness,
        item.importance,
        deadlineLevel,
        retainedDependencies,
      ),
    });
  }
  const stallSince = stallSinceAiDependency(
    currentAnalysis.item,
    item.aiAnalysis.applications,
    sourceOccurredAtByIdForAnalysis(currentAnalysis),
    currentAnalysis.decision,
    currentAnalysis.staleness,
    dependencies,
    previousItem,
    currentAnalysis.statusBasis,
    currentAnalysis.responsibilityBasis,
    currentAnalysis.blockerValueAiDependencies.transitionBasis,
  );
  const withStallSince = Object.freeze({
    ...dependencies,
    stallSince,
  });
  return Object.freeze({
    ...withStallSince,
    severity: severityAiDependency(
      currentAnalysis.decision,
      currentAnalysis.staleness,
      criticalSeverityWasRequested(currentAnalysis.staleness.severityReason),
      withStallSince,
    ),
    attention: attentionAiDependency(
      currentAnalysis.decision,
      currentAnalysis.staleness,
      item.importance,
      deadlineLevel,
      withStallSince,
    ),
  });
}

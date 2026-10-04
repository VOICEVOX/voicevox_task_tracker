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
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { DeterministicItemAnalysis } from "./deterministic-item.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import { trackedItemInputEvents } from "./graph-reconciliation-input-events.js";
import { unknownBlockerValueAiDependencies } from "./graph-reconciliation-blocker-values.js";
import {
  notDependentAiDependency,
  unrecordedAiDependency,
} from "./graph-reconciliation-ai-selection.js";
import {
  criticalSeverityWasRequested,
  severityAiDependency,
} from "./graph-reconciliation-severity.js";
import { stallSinceAiDependency } from "./graph-reconciliation-stall-since.js";
import type {
  GraphBlockerValueAiDependencies,
  GraphReducedDecision,
  PendingGraphTrackedItem,
  GraphWorkingState,
} from "./graph-reconciliation-contracts.js";
import { previousTrackedItem } from "./graph-reconciliation-previous-items.js";
import { sourceOccurredAtByIdForAnalysis } from "./graph-reconciliation-source-time.js";
import {
  stateAiDependencies,
  confidenceAiDependency,
  evidenceAiDependency,
  uncertaintiesAiDependency,
  lastProgressAiDependency,
} from "./graph-reconciliation-state-ai-dependencies.js";
import { transitionBasisForDecision } from "./graph-reconciliation-decision-basis.js";
import { trackedItemState } from "./graph-reconciliation-staleness.js";

/** 最終graphの依存から現在項目の値単位AI依存を投影する。 */
export function trackedItemAiDependenciesForAnalysis(
  state: GraphWorkingState,
  item: FreshObservedGitHubItem,
  nodeId: GitHubNodeId,
  decision: GraphReducedDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  staleness: StalenessResult,
  statusBasis: IssueStateDecision["statusBasis"],
  responsibilityBasis: IssueStateDecision["responsibilityBasis"],
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  aiAnalysis: TrackedItemAiAnalysis,
  adopted: GenericAiItemAdoption,
  downstreamImpactDependency: AiAnalysisDependency | undefined,
  blockersDependency: AiAnalysisDependency | undefined,
  blockerValueDependencies: GraphBlockerValueAiDependencies | undefined,
  relationSetDependency: AiAnalysisDependency | undefined,
): TrackedItemAiDependencies {
  const applications = aiAnalysis.applications;
  const resolvedBlockerValueDependencies =
    blockerValueDependencies ?? unknownBlockerValueAiDependencies();
  const stateDependencies = stateAiDependencies(
    adopted.elements,
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
    confidence: confidenceAiDependency(
      adopted.elements,
      applications,
      resolvedBlockerValueDependencies,
    ),
    evidence: evidenceAiDependency(
      adopted.elements,
      decision,
      deterministicDecision,
      applications,
      resolvedBlockerValueDependencies,
    ),
    uncertainties: uncertaintiesAiDependency(
      adopted.elements,
      resolvedBlockerValueDependencies.uncertainties,
    ),
    deadline: adopted.elements.deadline.aiDependency,
    deadlineLevel: adopted.elements.deadline.aiDependency,
    lastProgressAt: lastProgressAiDependency(
      nodeId,
      item.createdAt,
      adopted.elements.progress.aiDependency,
      applications,
      staleness,
      previousItem,
    ),
    stallSince: notDependentAiDependency(),
    severity: notDependentAiDependency(),
    downstreamImpact: resolvedDownstreamImpactDependency,
    importance: adopted.elements.importance.aiDependency,
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
  state: GraphWorkingState,
  analysis: DeterministicItemAnalysis,
  decision: GraphReducedDecision,
  primaryWaitingOn: PrimaryWaitingOn,
  staleness: StalenessResult,
  aiAnalysis: TrackedItemAiAnalysis,
  adopted: GenericAiItemAdoption,
  downstreamImpactDependency: AiAnalysisDependency | undefined,
  blockersDependency: AiAnalysisDependency | undefined,
  blockerValueDependencies: GraphBlockerValueAiDependencies | undefined,
  relationSetDependency: AiAnalysisDependency | undefined,
): PendingGraphTrackedItem {
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
      adopted,
      downstreamImpactDependency,
      blockersDependency,
      blockerValueDependencies,
      relationSetDependency,
    ),
    inputEvents: trackedItemInputEvents(analysis),
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  } satisfies Omit<PendingGraphTrackedItem, "status" | "waitingOn">;
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

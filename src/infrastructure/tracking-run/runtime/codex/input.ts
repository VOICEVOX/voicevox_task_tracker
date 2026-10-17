import type { DeterministicItemAnalysis } from "../../../../application/tracking-run/stages/deterministic-item.js";
import { verifiedPlannedElementResult } from "../../../../codex/element-planning.js";
import {
  type AiAnalysisTarget,
  type AnalysisElementNecessityInput,
  type AnalysisElementPlanning,
  type CodexAnalysisInput,
  type CodexPreservedElements,
} from "../../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../../domain/ai-analysis-elements.js";
import { isTerminalStatus } from "../../../../domain/index.js";
import { selectRelationAssessmentCandidates } from "../../../../graph/relation-candidate-endpoints.js";
import { deterministicElementResult } from "../analysis-identity.js";
import type { RuntimeState } from "../contracts.js";
import { preservedElementsWithCompatibleRelations } from "../preserved-codex-relations.js";
import { previousTrackedItem } from "../previous-state/snapshot.js";
import { checkFailureSourceIds } from "../source-ids.js";

/** 現在の確定判定だけをCodexの固定contextへ投影する。 */
export function deterministicPreservedElementsForAnalysis(
  analysis: DeterministicItemAnalysis,
  necessities: AnalysisElementPlanning["necessities"],
): CodexPreservedElements {
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (necessities[element] === "required") {
      continue;
    }
    const result = deterministicElementResult(analysis, element);
    if (result != null) {
      preservedElements[element] = result;
    }
  }
  return Object.freeze(preservedElements);
}

export function preservedElementsForSelection(
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
  input: CodexAnalysisInput,
): CodexPreservedElements {
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {
    ...deterministicPreservedElementsForAnalysis(analysis, planning.necessities),
  };
  const selected = new Set(planning.selection.selected.map((candidate) => candidate.element));
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (
      selected.has(element) ||
      planning.necessities[element] !== "required" ||
      preservedElements[element] != null
    ) {
      continue;
    }
    if (
      target?.nodeId !== analysis.item.nodeId &&
      !planning.selection.skipped.some(
        (skipped) => skipped.candidate.element === element && skipped.reason === "up_to_date",
      )
    ) {
      continue;
    }
    const verified = verifiedPlannedElementResult(planning, element);
    if (verified != null) {
      preservedElements[element] = verified;
    }
  }
  return preservedElementsWithCompatibleRelations(Object.freeze(preservedElements), input);
}

export function necessityInputForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  hasSelfCommitmentCandidate: boolean,
): AnalysisElementNecessityInput {
  const terminal = isTerminalStatus(analysis.decision.status);
  const unresolvedRequest =
    !terminal && analysis.item.type === "issue" && analysis.detail.type === "issue"
      ? analysis.explicitRequestCandidates.length > 0
      : false;
  const unresolvedCi =
    !terminal && analysis.item.type === "pull_request" && analysis.detail.type === "pull_request"
      ? checkFailureSourceIds(analysis.detail) != null
      : false;
  const relationAssessmentCandidates = selectRelationAssessmentCandidates(
    analysis.item.nodeId,
    analysis.relationCandidates,
  );
  const hasUnresolvedRelationCandidate = relationAssessmentCandidates.some(
    (candidate) => candidate.authority === "inferred",
  );
  const hasHumanProgressCandidate = analysis.item.events.some(
    (event) => event.kind === "comment" && event.actor.type === "human" && !event.bodyEmpty,
  );
  const hasNativeBlocker = analysis.relationCandidates.some(
    (candidate) =>
      candidate.provenance === "native" &&
      candidate.relation.type === "blocks" &&
      candidate.relation.blocked.nodeId === analysis.item.nodeId,
  );
  const notificationAiIsConsumed =
    !terminal &&
    analysis.decision.determination === "codex_candidate" &&
    !hasNativeBlocker &&
    analysis.notificationClass !== "automation_noise" &&
    !analysis.notificationsSuppressedByLabel;
  const stateDecisionNecessities = analysis.decision.aiAnalysisElementNecessities;
  const stateCandidate = {
    unresolvedRequest,
    unresolvedCi,
    effectiveAssigneeCandidate: analysis.effectiveAssigneeCandidates.length !== 0,
  };
  const allRelationCandidatesAuthoritative = relationAssessmentCandidates.every(
    (candidate) => candidate.authority === "authoritative",
  );
  const normalAiAnalysisScope =
    analysis.decision.determination !== "determined" ||
    analysis.effectiveAssigneeCandidates.length !== 0 ||
    hasHumanProgressCandidate ||
    !allRelationCandidatesAuthoritative;
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  return Object.freeze({
    state: Object.freeze({
      status: Object.freeze({
        deterministic: stateDecisionNecessities.status === "not_required",
        ...stateCandidate,
      }),
      waitingOn: Object.freeze({
        deterministic: stateDecisionNecessities.waitingOn === "not_required",
        ...stateCandidate,
      }),
      nextAction: Object.freeze({
        deterministic: stateDecisionNecessities.nextAction === "not_required",
        ...stateCandidate,
      }),
    }),
    hasUnresolvedRelationCandidate,
    hasHumanProgressCandidate,
    importance: Object.freeze({
      normalAiAnalysisScope,
      currentlyAdopted: previousItem?.importanceAssessment.status === "available",
    }),
    deadline: Object.freeze({
      normalAiAnalysisScope,
      currentlyAdopted: previousItem?.deadlineAssessment.status === "available",
    }),
    notification: Object.freeze({
      aiIsConsumed: notificationAiIsConsumed,
    }),
    selfCommitment: Object.freeze({
      hasEligibleCandidate: hasSelfCommitmentCandidate,
    }),
  });
}

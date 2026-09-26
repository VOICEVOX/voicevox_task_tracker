import {
  determineAnalysisElementReuse,
  type AiAnalysisTarget,
  type AnalysisElementNecessityInput,
  type AnalysisElementPlanning,
  type CodexAnalysisInput,
  type CodexPreservedElements,
} from "../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import { isTerminalStatus } from "../../../domain/index.js";
import { selectRelationAssessmentCandidates } from "../../../graph/relation-candidate-endpoints.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { createIssueRequestCandidates } from "../../issue-responsibility-candidates.js";
import { deterministicElementResult } from "../analysis-identity.js";
import type { RuntimeState } from "../contracts.js";
import { preservedElementsWithCompatibleRelations } from "../preserved-codex-relations.js";
import {
  verifiedCurrentAdoptedResultForElement,
  verifiedMigrationAdoptedResultForElement,
} from "../previous-state/ai-reuse.js";
import {
  currentSavedResultForElement,
  migrationAdoptedResultForElement,
} from "../previous-state/saved-ai-elements.js";
import { previousTrackedItem } from "../previous-state/snapshot.js";
import { checkFailureSourceIds } from "../source-ids.js";

function preservedElementsForForcedTargetInput(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): CodexPreservedElements {
  const selectedElements = new Set(target.elements);
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (selectedElements.has(element)) {
      continue;
    }
    const candidate = planning.candidates[element];
    const result =
      candidate.necessity === "not_required"
        ? deterministicElementResult(analysis, element)
        : (currentSavedResultForElement(state, analysis, element) ??
          migrationAdoptedResultForElement(state, analysis, element) ??
          deterministicElementResult(analysis, element));
    if (result != null) {
      preservedElements[element] = result;
    }
  }
  return Object.freeze(preservedElements);
}

export function preservedElementsForSelection(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
  input: CodexAnalysisInput,
): CodexPreservedElements {
  if (target?.nodeId === analysis.item.nodeId) {
    return preservedElementsWithCompatibleRelations(
      preservedElementsForForcedTargetInput(state, analysis, planning, target),
      input,
    );
  }
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  for (const skipped of planning.selection.skipped) {
    if (skipped.reason === "up_to_date") {
      const savedReuse = skipped.candidate.savedReuse;
      let reused: AiAnalysisElementMigrationResult | undefined;
      if (
        savedReuse != null &&
        determineAnalysisElementReuse({
          element: skipped.candidate.element,
          inputFingerprint: skipped.candidate.inputFingerprint,
          inputProjectionVersion: skipped.candidate.inputProjectionVersion,
          dependencyFingerprint: skipped.candidate.dependencyFingerprint,
          savedProof: savedReuse.proof,
        }) === "verified"
      ) {
        reused = savedReuse.result;
      }
      const adopted = verifiedCurrentAdoptedResultForElement(
        state,
        analysis,
        skipped.candidate.element,
        skipped.candidate.inputFingerprint,
        savedReuse,
      );
      const migrated = verifiedMigrationAdoptedResultForElement(
        state,
        analysis,
        skipped.candidate.element,
        skipped.candidate.inputFingerprint,
        savedReuse,
      );
      const deterministic = deterministicElementResult(analysis, skipped.candidate.element);
      const result = reused ?? adopted ?? migrated ?? deterministic;
      if (result != null) {
        preservedElements[skipped.candidate.element] = result;
      }
      continue;
    }
    const deterministic = deterministicElementResult(analysis, skipped.candidate.element);
    if (deterministic != null) {
      preservedElements[skipped.candidate.element] = deterministic;
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
      ? createIssueRequestCandidates(analysis.item, analysis.detail).length > 0
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

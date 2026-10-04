import { AI_ANALYSIS_ELEMENTS, type AiAnalysisElement } from "../domain/ai-analysis-elements.js";
import { type AiAnalysisElementSourceGeneration } from "../domain/ai-analysis-source-generations.js";
import { type RelationCandidateAssessment } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";
import { type CodexPreservedElements } from "./analysis-elements.js";
import { type CodexConfidenceThresholds } from "./confidence.js";
import { type CodexAnalysisInput } from "./input.js";
import {
  createCodexNotification,
  createDeadlineAssessment,
  createFallbackNotification,
  createImportanceAssessment,
  createRelationAssessments,
  unavailableUncertainty,
  unresolvedRelationCoverage,
} from "./reducer-assessments.js";
import type {
  AiAnalysisElementsReduction,
  CodexAnalysisAttempt,
  CodexAnalysisElementApplications,
  CodexAnalysisReduction,
  CodexRelationCoverage,
  CodexUnavailableReason,
  DeterministicCodexDecision,
  ReduceAiAnalysisElementsInput,
  ReducedCodexNotification,
  RunCodexAnalysisWithFallbackDependencies,
  RunCodexAnalysisWithFallbackInput,
} from "./reducer-contracts.js";
import { createDecision, validateDecision } from "./reducer-decision-values.js";
import type { ElementResultSelection } from "./reducer-element-selection.js";
import {
  reconcileStateSelections,
  reconcileStateValueConsistency,
  selectElementResult,
  validateElementGenerationMap,
  validatePreservedElementKeys,
  validateSelectedElements,
} from "./reducer-element-selection.js";
import { executeValidatedCodexAnalysis } from "./reducer-execution.js";
import {
  createElementApplications,
  createStateDecision,
  stateDisplayMode,
} from "./reducer-state-adoption.js";
import { listNativeRelationConstraints } from "./semantic-validation.js";

/** 保存済みの関係と通知の採用結果を変換する。 */
export function reducePreservedCodexRelationsAndNotification(
  currentNodeId: string,
  preservedElements: Pick<CodexPreservedElements, "relations" | "notification">,
  confidenceThresholds: CodexConfidenceThresholds,
): Readonly<{
  relationAssessments: readonly RelationCandidateAssessment[];
  notification: ReducedCodexNotification | undefined;
}> {
  validatePreservedElementKeys(preservedElements);
  const notificationResult = preservedElements.notification;
  return Object.freeze({
    relationAssessments:
      preservedElements.relations == null
        ? Object.freeze([])
        : createRelationAssessments(preservedElements.relations, currentNodeId),
    notification:
      notificationResult == null
        ? undefined
        : createCodexNotification(
            Object.freeze({
              result: notificationResult,
              classification: undefined,
              application: "preserved",
            }),
            confidenceThresholds,
          ),
  });
}

function reduceUnavailableCodexAnalysis(
  deterministicDecision: DeterministicCodexDecision,
  relationCandidateIds: readonly string[],
  reason: CodexUnavailableReason,
  errorType: string,
  preservedElements: CodexPreservedElements,
  applications: CodexAnalysisElementApplications,
): CodexAnalysisReduction {
  const uncertainty = unavailableUncertainty(reason);
  const importanceAssessment = createImportanceAssessment(preservedElements.importance);
  const deadlineAssessment = createDeadlineAssessment(preservedElements.deadline);
  return Object.freeze({
    decision: createDecision("deterministic", deterministicDecision, uncertainty),
    displayMode: "fallback",
    importanceAssessment,
    deadlineAssessment,
    ai: Object.freeze({
      status: "unavailable",
      reason,
      errorType,
      elements: applications,
    }),
    relationAssessments: Object.freeze([]),
    relationCoverage: unresolvedRelationCoverage(relationCandidateIds),
    notification: createFallbackNotification(uncertainty),
  });
}

/** Codex入力の検証失敗を決定論的判定へ縮退する。 */
export function reduceCodexInputValidationFailure(
  deterministicDecision: DeterministicCodexDecision,
  relationCandidateIds: readonly string[],
  errorType: string,
): CodexAnalysisReduction {
  validateDecision(deterministicDecision);
  return reduceUnavailableCodexAnalysis(
    deterministicDecision,
    relationCandidateIds,
    "input_validation_failed",
    errorType,
    Object.freeze({}),
    Object.freeze({}),
  );
}

/** 検証済みCodex出力を要素別の保存済み値と統合するpure reducer。 */
export function reduceCodexAnalysis(
  analysisInput: CodexAnalysisInput,
  deterministicDecision: DeterministicCodexDecision,
  attempt: CodexAnalysisAttempt,
  confidenceThresholds: CodexConfidenceThresholds,
  preservedElements: CodexPreservedElements,
): CodexAnalysisReduction {
  validateDecision(deterministicDecision);
  validatePreservedElementKeys(preservedElements);
  const selectedElements = new Set<string>(analysisInput.selectedElements);
  const generatedSelections = new Map<AiAnalysisElement, ElementResultSelection>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    generatedSelections.set(
      element,
      selectElementResult(
        element,
        selectedElements,
        attempt,
        preservedElements,
        confidenceThresholds,
      ),
    );
  }
  const reconciledSelections = reconcileStateSelections(
    generatedSelections,
    selectedElements,
    preservedElements,
  );
  const deterministicStatePriority =
    deterministicDecision.determination === "determined" ||
    listNativeRelationConstraints(analysisInput).some(
      (constraint) => constraint.verdict === "current_is_blocked_by_target",
    );
  const selections = reconcileStateValueConsistency(
    reconciledSelections,
    deterministicDecision,
    deterministicStatePriority,
  );

  if (attempt.status === "unavailable") {
    const applications = createElementApplications(
      selections,
      deterministicStatePriority,
      confidenceThresholds,
    );
    const unavailable = reduceUnavailableCodexAnalysis(
      deterministicDecision,
      analysisInput.candidates.relations.map((candidate) => candidate.id),
      attempt.reason,
      attempt.errorType,
      preservedElements,
      applications,
    );
    const relationSelection = selections.get("relations");
    assertNonNullable(relationSelection, "relations要素の選択結果がありません");
    const relationAssessments =
      relationSelection.result == null
        ? Object.freeze([])
        : createRelationAssessments(relationSelection.result, analysisInput.item.nodeId);
    const relationCoverage =
      relationSelection.result == null
        ? unavailable.relationCoverage
        : (Object.freeze({ status: "complete" }) satisfies CodexRelationCoverage);
    const importanceSelection = selections.get("importance");
    const deadlineSelection = selections.get("deadline");
    const notificationSelection = selections.get("notification");
    const statusSelection = selections.get("status");
    const waitingOnSelection = selections.get("waitingOn");
    const nextActionSelection = selections.get("nextAction");
    assertNonNullable(importanceSelection, "importance要素の選択結果がありません");
    assertNonNullable(deadlineSelection, "deadline要素の選択結果がありません");
    assertNonNullable(notificationSelection, "notification要素の選択結果がありません");
    assertNonNullable(statusSelection, "status要素の選択結果がありません");
    assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
    assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");
    const stateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
      ["status", statusSelection],
      ["waitingOn", waitingOnSelection],
      ["nextAction", nextActionSelection],
    ];
    return Object.freeze({
      ...unavailable,
      decision: createStateDecision(
        deterministicDecision,
        selections,
        deterministicStatePriority,
        confidenceThresholds,
      ),
      displayMode: stateDisplayMode(
        stateSelections,
        deterministicStatePriority,
        confidenceThresholds,
      ),
      importanceAssessment: createImportanceAssessment(importanceSelection.result),
      deadlineAssessment: createDeadlineAssessment(deadlineSelection.result),
      notification:
        notificationSelection.result == null
          ? unavailable.notification
          : createCodexNotification(notificationSelection, confidenceThresholds),
      relationAssessments,
      relationCoverage,
    });
  }

  const decision = createStateDecision(
    deterministicDecision,
    selections,
    deterministicStatePriority,
    confidenceThresholds,
  );
  const importanceSelection = selections.get("importance");
  const deadlineSelection = selections.get("deadline");
  const notificationSelection = selections.get("notification");
  const relationSelection = selections.get("relations");
  assertNonNullable(importanceSelection, "importance要素の選択結果がありません");
  assertNonNullable(deadlineSelection, "deadline要素の選択結果がありません");
  assertNonNullable(notificationSelection, "notification要素の選択結果がありません");
  assertNonNullable(relationSelection, "relations要素の選択結果がありません");

  const relationAssessments =
    relationSelection.result == null
      ? Object.freeze([])
      : createRelationAssessments(relationSelection.result, analysisInput.item.nodeId);
  const relationCoverage =
    relationSelection.result == null
      ? unresolvedRelationCoverage(
          analysisInput.candidates.relations.map((candidate) => candidate.id),
        )
      : (Object.freeze({ status: "complete" }) satisfies CodexRelationCoverage);
  const statusSelection = selections.get("status");
  const waitingOnSelection = selections.get("waitingOn");
  const nextActionSelection = selections.get("nextAction");
  assertNonNullable(statusSelection, "status要素の選択結果がありません");
  assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
  assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");
  const stateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
    ["status", statusSelection],
    ["waitingOn", waitingOnSelection],
    ["nextAction", nextActionSelection],
  ];
  const applications = createElementApplications(
    selections,
    deterministicStatePriority,
    confidenceThresholds,
  );
  const notification = createCodexNotification(notificationSelection, confidenceThresholds);
  return Object.freeze({
    decision,
    displayMode: stateDisplayMode(
      stateSelections,
      deterministicStatePriority,
      confidenceThresholds,
    ),
    importanceAssessment: createImportanceAssessment(importanceSelection.result),
    deadlineAssessment: createDeadlineAssessment(deadlineSelection.result),
    ai: Object.freeze({
      status: "available",
      elements: applications,
    }),
    relationAssessments,
    relationCoverage,
    notification,
  });
}

/** Codex実行、二段階検証、要素別fallback reducerを1件分実行する。 */
export async function runCodexAnalysisWithFallback(
  input: RunCodexAnalysisWithFallbackInput,
  dependencies: RunCodexAnalysisWithFallbackDependencies,
): Promise<CodexAnalysisReduction> {
  const attempt = await executeValidatedCodexAnalysis(
    input.analysisInput,
    dependencies.execute,
    dependencies.recordFailure,
  );
  return reduceCodexAnalysis(
    input.analysisInput,
    input.deterministicDecision,
    attempt,
    input.confidenceThresholds,
    input.preservedElements,
  );
}

/** 要素別の成功結果だけを反映し、選択外の保存済み結果を保持する。 */
export function reduceAiAnalysisElements(
  input: ReduceAiAnalysisElementsInput,
): AiAnalysisElementsReduction {
  const selected = validateSelectedElements(input.selectedElements);
  validateElementGenerationMap(input.generatedElements, "実生成結果");
  validateElementGenerationMap(input.preservedElements, "保持する保存済み生成結果");

  const elements: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> = {};
  let generatedCount = 0;
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generated = input.generatedElements[element];
    const preserved = input.preservedElements[element];
    if (selected.has(element)) {
      if (generated != null) {
        if (preserved != null) {
          throw new TypeError(`生成結果と保持結果を同時に指定できません。対象: ${element}`);
        }
        elements[element] = generated;
        generatedCount += 1;
      } else if (preserved != null) {
        elements[element] = preserved;
      }
      continue;
    }
    if (generated != null) {
      throw new TypeError(`選択外の要素に実生成結果があります。対象: ${element}`);
    }
    if (preserved != null) {
      elements[element] = preserved;
    }
  }

  if (generatedCount !== 0 && generatedCount !== selected.size) {
    throw new TypeError("選択したAI判定要素の生成結果を一括で反映できません");
  }

  const generatedElements = Object.freeze(
    input.selectedElements.filter((element) => input.generatedElements[element] != null),
  );
  const missingElements = Object.freeze(
    input.selectedElements.filter((element) => input.generatedElements[element] == null),
  );
  return Object.freeze({
    elements: Object.freeze(elements),
    generatedElements,
    missingElements,
  });
}

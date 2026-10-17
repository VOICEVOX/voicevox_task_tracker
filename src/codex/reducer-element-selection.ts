import { z } from "zod";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../domain/ai-analysis-elements.js";
import { isTerminalStatus, type Status, type WaitingOn } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { type CodexPreservedElements } from "./analysis-elements.js";
import {
  classifyCodexConfidence,
  type CodexConfidenceClassification,
  type CodexConfidenceThresholds,
} from "./confidence.js";
import type {
  AiAnalysisElementSourceGenerationMap,
  CodexAnalysisAttempt,
  DeterministicCodexDecision,
} from "./reducer-contracts.js";
import { copyWaitingOn } from "./reducer-decision-values.js";
import { type CodexElementOutput } from "./semantic-validation.js";

type ElementResultSource = CodexElementOutput | CodexPreservedElements;

export type ElementResultSelection = Readonly<{
  result: AiAnalysisElementMigrationResult | undefined;
  classification: CodexConfidenceClassification | undefined;
  application: "applied" | "preserved" | "deterministic_fallback";
}>;

const STATE_ANALYSIS_ELEMENTS: readonly AiAnalysisElement[] = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
]);

export const relationCandidateIdSchema = z.templateLiteral(["rel:", z.string()]);

function resultForElement(
  source: ElementResultSource,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  switch (element) {
    case "status":
      return source.status;
    case "waitingOn":
      return source.waitingOn;
    case "nextAction":
      return source.nextAction;
    case "relations":
      return source.relations;
    case "progress":
      return source.progress;
    case "importance":
      return source.importance;
    case "deadline":
      return source.deadline;
    case "notification":
      return source.notification;
    case "selfCommitment":
      return source.selfCommitment;
  }
}

export function validatePreservedElementKeys(values: CodexPreservedElements): void {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  for (const element of Object.keys(values)) {
    if (!knownElements.has(element)) {
      throw new TypeError(`保持するAI判定要素が不正です。対象: ${element}`);
    }
  }
}

/** 要素内部のconfidenceを含めた実効confidenceを算出する。 */
export function effectiveElementConfidence(
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult,
): number {
  switch (element) {
    case "waitingOn": {
      const parsed = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
      return parsed.value.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.confidence),
        parsed.confidence,
      );
    }
    case "relations": {
      const parsed = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
      return parsed.value.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.confidence),
        parsed.confidence,
      );
    }
    case "progress": {
      const parsed = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
      return Math.min(parsed.confidence, parsed.value.confidence);
    }
    case "status":
    case "nextAction":
    case "importance":
    case "deadline":
    case "notification":
      return result.confidence;
    case "selfCommitment":
      return result.confidence;
  }
}

export function classificationForSelection(
  element: AiAnalysisElement,
  selection: ElementResultSelection,
  confidenceThresholds: CodexConfidenceThresholds,
): CodexConfidenceClassification | undefined {
  if (selection.classification != null) {
    return selection.classification;
  }
  if (selection.application !== "preserved" || selection.result == null) {
    return undefined;
  }
  return classifyCodexConfidence(
    effectiveElementConfidence(element, selection.result),
    confidenceThresholds,
  );
}

export function selectElementResult(
  element: AiAnalysisElement,
  selectedElements: ReadonlySet<string>,
  attempt: CodexAnalysisAttempt,
  preservedElements: CodexPreservedElements,
  confidenceThresholds: CodexConfidenceThresholds,
): ElementResultSelection {
  const preserved = resultForElement(preservedElements, element);
  if (!selectedElements.has(element)) {
    return Object.freeze({
      result: preserved,
      classification: undefined,
      application: preserved == null ? "deterministic_fallback" : "preserved",
    });
  }

  if (attempt.status === "unavailable") {
    return Object.freeze({
      result: preserved,
      classification: undefined,
      application: preserved == null ? "deterministic_fallback" : "preserved",
    });
  }

  const generated = resultForElement(attempt.output, element);
  if (generated == null) {
    throw new TypeError(`検証済みCodex出力の${element}がありません`);
  }
  const classification = classifyCodexConfidence(
    effectiveElementConfidence(element, generated),
    confidenceThresholds,
  );
  if (classification.level === "low") {
    return Object.freeze({
      result: preserved,
      classification,
      application: preserved == null ? "deterministic_fallback" : "preserved",
    });
  }
  return Object.freeze({
    result: generated,
    classification,
    application: "applied",
  });
}

export function isAcceptedStateSelection(selection: ElementResultSelection): boolean {
  return (
    selection.result != null &&
    (selection.application === "applied" || selection.application === "preserved")
  );
}

export function reconcileStateSelections(
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  selectedElements: ReadonlySet<string>,
  preservedElements: CodexPreservedElements,
): ReadonlyMap<AiAnalysisElement, ElementResultSelection> {
  const selectedStateElements = STATE_ANALYSIS_ELEMENTS.filter((element) =>
    selectedElements.has(element),
  );
  if (selectedStateElements.length < 2) {
    return selections;
  }

  const selectedStateSelections = selectedStateElements.map((element) => {
    const selection = selections.get(element);
    assertNonNullable(selection, `${element}要素の選択結果がありません`);
    return selection;
  });
  if (selectedStateSelections.every((selection) => selection.application === "applied")) {
    return selections;
  }

  const preservedStateResults = new Map<
    AiAnalysisElement,
    AiAnalysisElementMigrationResult | undefined
  >();
  for (const element of selectedStateElements) {
    preservedStateResults.set(element, resultForElement(preservedElements, element));
  }
  const reconciled = new Map(selections);
  for (const [index, element] of selectedStateElements.entries()) {
    const selection = selectedStateSelections[index];
    assertNonNullable(selection, `${element}要素の選択結果がありません`);
    const preserved = preservedStateResults.get(element);
    reconciled.set(
      element,
      Object.freeze({
        result: preserved,
        classification: selection.classification,
        application: preserved == null ? "deterministic_fallback" : "preserved",
      }),
    );
  }
  return reconciled;
}

type StateDecisionValues = Readonly<{
  aiStateCanBeApplied: boolean;
  status: Status;
  waitingOn: readonly WaitingOn[];
  nextAction: string;
}>;

export function stateDecisionValues(
  deterministicDecision: DeterministicCodexDecision,
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  deterministicStatePriority: boolean,
): StateDecisionValues {
  const statusSelection = selections.get("status");
  const waitingOnSelection = selections.get("waitingOn");
  const nextActionSelection = selections.get("nextAction");
  assertNonNullable(statusSelection, "status要素の選択結果がありません");
  assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
  assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");

  const statusResult =
    statusSelection.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("status").parse(statusSelection.result);
  const waitingOnResult =
    waitingOnSelection.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("waitingOn").parse(waitingOnSelection.result);
  const nextActionResult =
    nextActionSelection.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("nextAction").parse(
          nextActionSelection.result,
        );
  const stateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
    ["status", statusSelection],
    ["waitingOn", waitingOnSelection],
    ["nextAction", nextActionSelection],
  ];
  const aiStateCanBeApplied = stateSelectionCanBeApplied(
    stateSelections,
    deterministicStatePriority,
  );
  const status =
    aiStateCanBeApplied && isAcceptedStateSelection(statusSelection)
      ? statusResult?.value
      : deterministicDecision.status;
  const waitingOn =
    aiStateCanBeApplied && isAcceptedStateSelection(waitingOnSelection)
      ? waitingOnResult?.value
      : deterministicDecision.waitingOn;
  const nextAction =
    aiStateCanBeApplied && isAcceptedStateSelection(nextActionSelection)
      ? nextActionResult?.value
      : deterministicDecision.nextAction;
  return Object.freeze({
    aiStateCanBeApplied,
    status: status ?? deterministicDecision.status,
    waitingOn: waitingOn == null ? deterministicDecision.waitingOn : copyWaitingOn(waitingOn),
    nextAction: nextAction ?? deterministicDecision.nextAction,
  });
}

export function isValidStateValues(status: Status, waitingOn: readonly WaitingOn[]): boolean {
  return (
    !(isTerminalStatus(status) && waitingOn.length !== 0) &&
    !(!isTerminalStatus(status) && waitingOn.length === 0)
  );
}

export function reconcileStateValueConsistency(
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  deterministicDecision: DeterministicCodexDecision,
  deterministicStatePriority: boolean,
): ReadonlyMap<AiAnalysisElement, ElementResultSelection> {
  const stateValues = stateDecisionValues(
    deterministicDecision,
    selections,
    deterministicStatePriority,
  );
  if (isValidStateValues(stateValues.status, stateValues.waitingOn)) {
    return selections;
  }

  const reconciled = new Map(selections);
  for (const element of STATE_ANALYSIS_ELEMENTS) {
    reconciled.set(
      element,
      Object.freeze({
        result: undefined,
        classification: undefined,
        application: "deterministic_fallback",
      }),
    );
  }
  return reconciled;
}

export function stateSelectionCanBeApplied(
  stateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[],
  deterministicStatePriority: boolean,
): boolean {
  if (deterministicStatePriority) {
    return false;
  }
  return stateSelections.some(([, selection]) => isAcceptedStateSelection(selection));
}

export function validateElementGenerationMap(
  values: AiAnalysisElementSourceGenerationMap,
  context: string,
): void {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  for (const element of Object.keys(values)) {
    if (!knownElements.has(element)) {
      throw new TypeError(`${context}に未知の要素があります。対象: ${element}`);
    }
  }
}

export function validateSelectedElements(
  selectedElements: readonly AiAnalysisElement[],
): Set<string> {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  const selected = new Set<string>();
  for (const element of selectedElements) {
    if (!knownElements.has(element)) {
      throw new TypeError(`選択したAI判定要素が不正です。対象: ${element}`);
    }
    if (selected.has(element)) {
      throw new TypeError(`選択したAI判定要素が重複しています。対象: ${element}`);
    }
    selected.add(element);
  }
  return selected;
}

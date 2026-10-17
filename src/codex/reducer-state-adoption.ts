import {
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../domain/ai-analysis-elements.js";
import { isTerminalStatus, type Evidence, type Status, type WaitingOn } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  type CodexConfidenceClassification,
  type CodexConfidenceThresholds,
} from "./confidence.js";
import type {
  CodexAnalysisElementApplications,
  DeterministicCodexDecision,
  ReducedCodexDecision,
} from "./reducer-contracts.js";
import { createDecision, createSourceIdTuple } from "./reducer-decision-values.js";
import type { ElementResultSelection } from "./reducer-element-selection.js";
import {
  classificationForSelection,
  effectiveElementConfidence,
  isAcceptedStateSelection,
  isValidStateValues,
  stateDecisionValues,
  stateSelectionCanBeApplied,
} from "./reducer-element-selection.js";

function createElementEvidence(
  result: AiAnalysisElementMigrationResult,
  supports: Evidence["supports"],
): readonly Evidence[] {
  return Object.freeze(
    result.evidence.map((evidence) => {
      if (evidence.supports === "self_commitment" && supports !== "waiting_on") {
        throw new TypeError("self_commitmentの根拠はwaitingOn要素にだけ指定できます");
      }
      return Object.freeze({
        sourceId: createSourceIdTuple([evidence.sourceId])[0],
        supports: evidence.supports === "self_commitment" ? "self_commitment" : supports,
        summary: evidence.summary,
      });
    }),
  );
}

export function createElementApplications(
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  deterministicStatePriority: boolean,
  confidenceThresholds: CodexConfidenceThresholds,
): CodexAnalysisElementApplications {
  const applications: Partial<
    Record<
      AiAnalysisElement,
      Readonly<{
        confidenceLevel: CodexConfidenceClassification["level"];
        application: "applied" | "preserved" | "deterministic_fallback";
      }>
    >
  > = {};
  for (const [element, selection] of selections) {
    const classification = classificationForSelection(element, selection, confidenceThresholds);
    if (classification == null) {
      continue;
    }
    const statePriority =
      deterministicStatePriority &&
      (element === "status" || element === "waitingOn" || element === "nextAction");
    applications[element] = Object.freeze({
      confidenceLevel: classification.level,
      application: statePriority ? "deterministic_fallback" : selection.application,
    });
  }
  return Object.freeze(applications);
}

export function stateDisplayMode(
  selections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[],
  deterministicStatePriority: boolean,
  confidenceThresholds: CodexConfidenceThresholds,
): CodexConfidenceClassification["displayMode"] {
  if (deterministicStatePriority) {
    return "confirmed";
  }
  if (!stateSelectionCanBeApplied(selections, deterministicStatePriority)) {
    return "fallback";
  }
  const stateClassifications = selections
    .filter(([, selection]) => isAcceptedStateSelection(selection))
    .map(([element, selection]) =>
      classificationForSelection(element, selection, confidenceThresholds),
    )
    .filter(
      (classification): classification is CodexConfidenceClassification => classification != null,
    );
  if (stateClassifications.length === 0) {
    return "fallback";
  }
  if (stateClassifications.some((classification) => classification.level === "low")) {
    return "fallback";
  }
  if (stateClassifications.some((classification) => classification.level === "medium")) {
    return "estimated";
  }
  return "confirmed";
}

function validateStateValues(status: Status, waitingOn: readonly WaitingOn[]): void {
  if (isValidStateValues(status, waitingOn)) {
    return;
  }
  if (isTerminalStatus(status)) {
    throw new TypeError("統合後のterminal状態にwaitingOnを設定できません");
  }
  throw new TypeError("統合後の継続中状態にはwaitingOnが1件以上必要です");
}

export function createStateDecision(
  deterministicDecision: DeterministicCodexDecision,
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  deterministicStatePriority: boolean,
  confidenceThresholds: CodexConfidenceThresholds,
): ReducedCodexDecision {
  const statusSelection = selections.get("status");
  const waitingOnSelection = selections.get("waitingOn");
  const nextActionSelection = selections.get("nextAction");
  assertNonNullable(statusSelection, "status要素の選択結果がありません");
  assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
  assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");

  const stateValues = stateDecisionValues(
    deterministicDecision,
    selections,
    deterministicStatePriority,
  );
  const aiStateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
    ["status", statusSelection],
    ["waitingOn", waitingOnSelection],
    ["nextAction", nextActionSelection],
  ];
  const { aiStateCanBeApplied } = stateValues;
  const aiStateApplied = aiStateCanBeApplied;
  const reducedStatus = stateValues.status;
  const reducedWaitingOn = stateValues.waitingOn;
  const reducedNextAction = stateValues.nextAction;
  validateStateValues(reducedStatus, reducedWaitingOn);

  const resultEvidence: Evidence[] = [];
  for (const [element, selection] of aiStateSelections) {
    if (
      selection.result == null ||
      (selection.application !== "applied" && selection.application !== "preserved")
    ) {
      continue;
    }
    const supports = element === "waitingOn" ? "waiting_on" : "status";
    resultEvidence.push(...createElementEvidence(selection.result, supports));
  }
  const evidence =
    aiStateApplied && resultEvidence.length > 0
      ? Object.freeze(
          aiStateSelections.every(([, selection]) => isAcceptedStateSelection(selection))
            ? resultEvidence
            : [...deterministicDecision.evidence, ...resultEvidence],
        )
      : deterministicDecision.evidence;
  const aiStateResultConfidences = aiStateSelections
    .filter(
      ([, selection]) =>
        selection.result != null &&
        (selection.application === "applied" || selection.application === "preserved"),
    )
    .map(([element, selection]) => {
      if (selection.result == null) {
        throw new TypeError(`${element}要素の採用結果がありません`);
      }
      return effectiveElementConfidence(element, selection.result);
    });
  const stateConfidence =
    aiStateResultConfidences.length === 0
      ? deterministicDecision.confidence
      : Math.min(
          ...(aiStateSelections.every(([, selection]) => isAcceptedStateSelection(selection))
            ? aiStateResultConfidences
            : [deterministicDecision.confidence, ...aiStateResultConfidences]),
        );
  const uncertainties = [...deterministicDecision.uncertainties];
  for (const [, selection] of aiStateSelections) {
    if (
      aiStateApplied &&
      (selection.application === "applied" || selection.application === "preserved") &&
      selection.result != null
    ) {
      uncertainties.push(...selection.result.uncertainties);
    }
  }
  if (
    aiStateApplied &&
    aiStateSelections.some(
      ([element, selection]) =>
        classificationForSelection(element, selection, confidenceThresholds)?.level === "medium",
    )
  ) {
    uncertainties.push("Codexによる推定表示です");
  }
  if (
    !deterministicStatePriority &&
    [statusSelection, waitingOnSelection, nextActionSelection].some(
      (selection) =>
        selection.classification?.level === "low" &&
        selection.application === "deterministic_fallback",
    )
  ) {
    uncertainties.push("Codex判定のconfidenceが低いため決定論的判定へ縮退しました");
  }

  return createDecision(
    aiStateApplied ? "codex" : "deterministic",
    {
      status: reducedStatus,
      waitingOn: reducedWaitingOn,
      nextAction: reducedNextAction,
      confidence: aiStateApplied ? stateConfidence : deterministicDecision.confidence,
      evidence,
      uncertainties,
    },
    undefined,
  );
}

import {
  AI_ANALYSIS_ELEMENTS,
  type AnalysisElement,
  type AnalysisElementExecutionFingerprint,
  type AnalysisElementGeneration,
  type AnalysisElementInputFingerprint,
  type AnalysisElementNecessity,
  type AiAnalysisElementReuseProof,
} from "./analysis-elements.js";
import {
  selectAnalysisElements,
  type AnalysisElementSelection,
  type AnalysisElementSelectionCandidate,
  type AnalysisElementSelectionCandidates,
} from "./element-selection.js";

/** 要素別AI判定の必要性を導く決定論的な入力。 */
type StateElementNecessityInput = Readonly<{
  deterministic: boolean;
  unresolvedRequest: boolean;
  unresolvedCi: boolean;
  effectiveAssigneeCandidate: boolean;
}>;

export type AnalysisElementNecessityInput = Readonly<{
  state: Readonly<{
    status: StateElementNecessityInput;
    waitingOn: StateElementNecessityInput;
    nextAction: StateElementNecessityInput;
  }>;
  hasUnresolvedRelationCandidate: boolean;
  hasHumanProgressCandidate: boolean;
  importance: Readonly<{
    normalAiAnalysisScope: boolean;
    currentlyAdopted: boolean;
  }>;
  deadline: Readonly<{
    normalAiAnalysisScope: boolean;
    currentlyAdopted: boolean;
  }>;
  notification: Readonly<{
    aiIsConsumed: boolean;
  }>;
}>;

/** 要素別AI判定の必要性を導く入力、指紋、保存済み生成結果。 */
export type AnalysisElementPlanningInput = Readonly<{
  necessities: Readonly<Record<AnalysisElement, AnalysisElementNecessity>>;
  inputFingerprints: Readonly<Record<AnalysisElement, AnalysisElementInputFingerprint>>;
  executionFingerprints: Readonly<Record<AnalysisElement, AnalysisElementExecutionFingerprint>>;
  inputProjectionVersions: Readonly<Record<AnalysisElement, number>>;
  dependencyFingerprints: Readonly<Record<AnalysisElement, AnalysisElementInputFingerprint>>;
  savedGenerations: Readonly<Partial<Record<AnalysisElement, AnalysisElementGeneration>>>;
  savedEvaluationProofs: Readonly<Partial<Record<AnalysisElement, AiAnalysisElementReuseProof>>>;
  savedReuseProofs: Readonly<Partial<Record<AnalysisElement, AiAnalysisElementReuseProof>>>;
}>;

/** 要素別AI判定の必要性と呼び出し対象をまとめた計画。 */
export type AnalysisElementPlanning = Readonly<{
  necessities: Readonly<Record<AnalysisElement, AnalysisElementNecessity>>;
  candidates: AnalysisElementSelectionCandidates;
  selection: AnalysisElementSelection;
}>;

function required(value: boolean): AnalysisElementNecessity {
  return value ? "required" : "not_required";
}

function stateElementRequired(input: StateElementNecessityInput): boolean {
  return (
    !input.deterministic ||
    input.unresolvedRequest ||
    input.unresolvedCi ||
    input.effectiveAssigneeCandidate
  );
}

function validateElementMapKeys(values: object, context: string): void {
  const keys = new Set(Object.keys(values));
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (!keys.has(element)) {
      throw new TypeError(`${context}がありません。対象: ${element}`);
    }
  }
  if (keys.size !== AI_ANALYSIS_ELEMENTS.length) {
    throw new TypeError(`${context}に未知の要素があります`);
  }
}

/** 現在の確定判定と未解決候補から8要素ごとの必要性を算出する。 */
export function determineAnalysisElementNecessities(
  input: AnalysisElementNecessityInput,
): Readonly<Record<AnalysisElement, AnalysisElementNecessity>> {
  return Object.freeze({
    status: required(stateElementRequired(input.state.status)),
    waitingOn: required(stateElementRequired(input.state.waitingOn)),
    nextAction: required(stateElementRequired(input.state.nextAction)),
    relations: required(input.hasUnresolvedRelationCandidate),
    progress: required(input.hasHumanProgressCandidate),
    importance: required(
      input.importance.normalAiAnalysisScope || input.importance.currentlyAdopted,
    ),
    deadline: required(input.deadline.normalAiAnalysisScope || input.deadline.currentlyAdopted),
    notification: required(input.notification.aiIsConsumed),
  });
}

function candidateFor(
  element: AnalysisElement,
  input: AnalysisElementPlanningInput,
): AnalysisElementSelectionCandidate {
  const savedGeneration = input.savedGenerations[element];
  return Object.freeze({
    element,
    necessity: input.necessities[element],
    inputFingerprint: input.inputFingerprints[element],
    executionFingerprint: input.executionFingerprints[element],
    inputProjectionVersion: input.inputProjectionVersions[element],
    dependencyFingerprint: input.dependencyFingerprints[element],
    ...(savedGeneration == null ? {} : { savedGeneration }),
    ...(input.savedEvaluationProofs[element] == null
      ? {}
      : { savedEvaluationProof: input.savedEvaluationProofs[element] }),
    ...(input.savedReuseProofs[element] == null
      ? {}
      : { savedReuseProof: input.savedReuseProofs[element] }),
  });
}

/** 必要性、要素別fingerprint、保存済み生成結果からAI呼び出しを計画する。 */
export function planAnalysisElements(input: AnalysisElementPlanningInput): AnalysisElementPlanning {
  validateElementMapKeys(input.necessities, "AI判定要素の必要性");
  validateElementMapKeys(input.inputFingerprints, "AI判定要素の入力fingerprint");
  validateElementMapKeys(input.executionFingerprints, "AI判定要素の実行条件fingerprint");
  validateElementMapKeys(input.inputProjectionVersions, "AI判定要素の入力投影version");
  validateElementMapKeys(input.dependencyFingerprints, "AI判定要素の依存fingerprint");
  const candidates = Object.freeze({
    status: candidateFor("status", input),
    waitingOn: candidateFor("waitingOn", input),
    nextAction: candidateFor("nextAction", input),
    relations: candidateFor("relations", input),
    progress: candidateFor("progress", input),
    importance: candidateFor("importance", input),
    deadline: candidateFor("deadline", input),
    notification: candidateFor("notification", input),
  }) satisfies AnalysisElementSelectionCandidates;
  return Object.freeze({
    necessities: input.necessities,
    candidates,
    selection: selectAnalysisElements(candidates),
  });
}

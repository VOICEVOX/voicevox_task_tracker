import { assertNonNullable } from "../util/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AnalysisElement,
  type AnalysisElementExecutionFingerprint,
  type AnalysisElementInputFingerprint,
  type AnalysisElementNecessity,
  type AnalysisElementReuseRecord,
  type AnalysisElementSourceGeneration,
} from "./analysis-elements.js";
import { determineAnalysisElementReuse } from "./analysis-reuse.js";
import type { AiAnalysisTarget } from "./analysis-selection.js";
import {
  selectAnalysisElements,
  type AnalysisElementSelection,
  type AnalysisElementSelectionCandidate,
  type AnalysisElementSelectionCandidates,
} from "./element-selection.js";
import {
  GENERIC_AI_ELEMENT_DEFINITIONS,
  type AnalysisElementNecessityInput,
} from "./generic-ai-definition.js";
export type { AnalysisElementNecessityInput } from "./generic-ai-definition.js";

/** 要素別AI判定の必要性を導く入力、指紋、保存済み生成結果。 */
export type AnalysisElementPlanningInput = Readonly<{
  necessities: Readonly<Record<AnalysisElement, AnalysisElementNecessity>>;
  inputFingerprints: Readonly<Record<AnalysisElement, AnalysisElementInputFingerprint>>;
  executionFingerprints: Readonly<Record<AnalysisElement, AnalysisElementExecutionFingerprint>>;
  inputProjectionVersions: Readonly<Record<AnalysisElement, number>>;
  dependencyFingerprints: Readonly<Record<AnalysisElement, AnalysisElementInputFingerprint>>;
  savedGenerations: Readonly<Partial<Record<AnalysisElement, AnalysisElementSourceGeneration>>>;
  savedEvaluations: Readonly<Partial<Record<AnalysisElement, AnalysisElementReuseRecord>>>;
  savedReuses: Readonly<Partial<Record<AnalysisElement, AnalysisElementReuseRecord>>>;
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

/** 現在の確定判定と未解決候補から要素ごとの必要性を算出する。 */
export function determineAnalysisElementNecessities(
  input: AnalysisElementNecessityInput,
): Readonly<Record<AnalysisElement, AnalysisElementNecessity>> {
  return Object.freeze({
    status: required(GENERIC_AI_ELEMENT_DEFINITIONS.status.required(input)),
    waitingOn: required(GENERIC_AI_ELEMENT_DEFINITIONS.waitingOn.required(input)),
    nextAction: required(GENERIC_AI_ELEMENT_DEFINITIONS.nextAction.required(input)),
    relations: required(GENERIC_AI_ELEMENT_DEFINITIONS.relations.required(input)),
    progress: required(GENERIC_AI_ELEMENT_DEFINITIONS.progress.required(input)),
    importance: required(GENERIC_AI_ELEMENT_DEFINITIONS.importance.required(input)),
    deadline: required(GENERIC_AI_ELEMENT_DEFINITIONS.deadline.required(input)),
    notification: required(GENERIC_AI_ELEMENT_DEFINITIONS.notification.required(input)),
    selfCommitment: required(GENERIC_AI_ELEMENT_DEFINITIONS.selfCommitment.required(input)),
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
    ...(input.savedEvaluations[element] == null
      ? {}
      : {
          savedEvaluation: input.savedEvaluations[element],
        }),
    ...(input.savedReuses[element] == null
      ? {}
      : {
          savedReuse: input.savedReuses[element],
        }),
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
    selfCommitment: candidateFor("selfCommitment", input),
  }) satisfies AnalysisElementSelectionCandidates;
  return Object.freeze({
    necessities: input.necessities,
    candidates,
    selection: selectAnalysisElements(candidates),
  });
}

/** 現在の意味入力で再利用を証明できる保存結果を返す。 */
export function verifiedPlannedElementResult(
  planning: AnalysisElementPlanning,
  element: AnalysisElement,
): AnalysisElementReuseRecord["result"] | undefined {
  const candidate = planning.candidates[element];
  const record = candidate.savedReuse;
  if (
    record != null &&
    determineAnalysisElementReuse({
      element,
      inputFingerprint: candidate.inputFingerprint,
      inputProjectionVersion: candidate.inputProjectionVersion,
      dependencyFingerprint: candidate.dependencyFingerprint,
      savedProof: record.proof,
    }) === "verified"
  ) {
    return record.result;
  }
  return undefined;
}

/** 強制解析では指定要素だけを既存の必要条件に従って選択する。 */
export function forceAnalysisElementSelection(
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): AnalysisElementSelection {
  const selected = target.elements.map((element) => {
    const candidate = planning.candidates[element];
    if (candidate.necessity !== "required") {
      throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
    }
    return candidate;
  });
  const selectedSet = new Set(target.elements);
  const skipped = AI_ANALYSIS_ELEMENTS.filter((element) => !selectedSet.has(element)).map(
    (element) =>
      Object.freeze({
        candidate: Object.freeze({ ...planning.candidates[element], necessity: "not_required" }),
        reason: "not_required",
      }),
  );
  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped),
    shouldCallAi: selected.length !== 0,
  });
}

/** 強制解析で未指定要素を候補から除外する。 */
export function forceAnalysisCandidateElements(
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): readonly AnalysisElementSelectionCandidate[] {
  const selectedSet = new Set(target.elements);
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.map((element) => {
      const candidate = planning.candidates[element];
      assertNonNullable(candidate, `指定したAI分析要素の候補がありません。対象: ${element}`);
      if (selectedSet.has(element) && candidate.necessity !== "required") {
        throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
      }
      const necessity: AnalysisElementNecessity = selectedSet.has(element)
        ? "required"
        : "not_required";
      return Object.freeze({ ...candidate, necessity });
    }),
  );
}

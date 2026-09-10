import { z } from "zod";

import { parseSha256Hash, serializeCanonicalJson } from "./canonical-json.js";
import {
  AI_ANALYSIS_ELEMENTS,
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  aiAnalysisElementSchema,
  type AiAnalysisElement,
} from "./analysis-elements.js";
import {
  selectAiAnalysisElements,
  type AiAnalysisElementSelection,
  type AiAnalysisElementSelectionCandidate,
} from "./element-selection.js";
import { type CodexAnalysisInput } from "./input.js";
import { type ReasoningEffort } from "../domain/index.js";

const aiAnalysisTargetSchema = z
  .strictObject({
    nodeId: z
      .string()
      .min(1, "AI分析対象のnode IDは空にできません")
      .regex(/^\S+$/u, "AI分析対象のnode IDに空白は使えません"),
    elements: z
      .array(aiAnalysisElementSchema)
      .min(1, "AI分析対象の要素を1件以上指定してください")
      .max(AI_ANALYSIS_ELEMENTS.length),
  })
  .superRefine((target, context) => {
    if (new Set(target.elements).size !== target.elements.length) {
      context.addIssue({
        code: "custom",
        path: ["elements"],
        message: "AI分析対象の要素が重複しています",
      });
    }
  });

/** 一つの項目について実推論するAI判定要素の指定。 */
export type AiAnalysisTarget = Readonly<{
  nodeId: string;
  elements: readonly AiAnalysisElement[];
}>;

/** AI分析対象の指定schema。 */
export { aiAnalysisTargetSchema };

/** 未検証の値からAI分析対象の指定を生成する。 */
export function createAiAnalysisTarget(value: unknown): AiAnalysisTarget {
  const parsed = aiAnalysisTargetSchema.parse(value);
  const elements = AI_ANALYSIS_ELEMENTS.filter((element) => parsed.elements.includes(element));
  return Object.freeze({
    nodeId: parsed.nodeId,
    elements: Object.freeze(elements),
  });
}

/** AI呼び出しの共通実行条件。要素revisionやprompt digestは含めない。 */
export type AiAnalysisRunIdentity = Readonly<{
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  schemaVersion: typeof AI_ANALYSIS_ELEMENT_SCHEMA_VERSION;
}>;

/** 予算配分に使うAI分析候補の優先順位。 */
export type AiAnalysisPriority = Readonly<{
  previouslyDeferred: boolean;
  severityCandidate: boolean;
  ownerUnknown: boolean;
  changedBlocker: boolean;
  downstreamImpact: Readonly<{
    openNodeCount: number;
    repositoryCount: number;
  }>;
}>;

/** 一つのIssueまたはPull Requestの要素別AI分析候補。 */
export type AiAnalysisCandidate = Readonly<{
  id: string;
  input: CodexAnalysisInput;
  elements: readonly AiAnalysisElementSelectionCandidate[];
  promptFingerprint: string;
  priority: AiAnalysisPriority;
  estimatedCostUsd: number;
}>;

/** 要素選別と入力文字数を確定したAI分析候補。 */
export type PreparedAiAnalysisCandidate = AiAnalysisCandidate &
  Readonly<{
    elementSelection: AiAnalysisElementSelection;
    selectedElements: readonly AiAnalysisElementSelectionCandidate[];
    normalizedInput: string;
    inputCharacters: number;
  }>;

/** AIへ送らない候補の理由。 */
export type AiAnalysisSkipReason = "not_required" | "up_to_date";

/** Codex呼び出し対象の要素別選別結果。 */
export type AiAnalysisSelection = Readonly<{
  selected: readonly PreparedAiAnalysisCandidate[];
  skipped: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }>[];
}>;

/** AI分析対象に対応する候補と要素別の実行候補。 */
export type AiAnalysisTargetSelection = Readonly<{
  candidate: PreparedAiAnalysisCandidate;
  selectedElements: readonly AiAnalysisElementSelectionCandidate[];
}>;

function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.length === 0) {
      throw new TypeError("空のUnicode文字を検出しました");
    }
    count += 1;
  }
  return count;
}

function validateCandidateId(id: string): void {
  if (id.length === 0) {
    throw new TypeError("Codex分析候補IDは空にできません");
  }
}

function validatePromptFingerprint(value: string): void {
  parseSha256Hash(value);
}

/** 要素選別、正規化入力、入力文字数を候補へ付加する。 */
export function prepareAiAnalysisCandidate(
  candidate: AiAnalysisCandidate,
): PreparedAiAnalysisCandidate {
  validateCandidateId(candidate.id);
  validatePromptFingerprint(candidate.promptFingerprint);
  const normalizedInput = `${serializeCanonicalJson(candidate.input)}\n`;
  const elementSelection = selectAiAnalysisElements(candidate.elements);
  return Object.freeze({
    ...candidate,
    elementSelection,
    selectedElements: elementSelection.selected,
    normalizedInput,
    inputCharacters: countUnicodeCharacters(normalizedInput),
  });
}

function determineSkipReason(candidate: PreparedAiAnalysisCandidate): AiAnalysisSkipReason {
  if (candidate.elementSelection.skipped.some((value) => value.reason === "up_to_date")) {
    return "up_to_date";
  }
  return "not_required";
}

/** 必要要素が残る項目だけを一回のCodex呼び出し候補として選ぶ。 */
export function selectAiAnalysisCandidates(
  candidates: readonly PreparedAiAnalysisCandidate[],
): AiAnalysisSelection {
  const candidateIds = new Set<string>();
  const selected: PreparedAiAnalysisCandidate[] = [];
  const skipped: {
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }[] = [];

  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`Codex分析候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    if (candidate.selectedElements.length > 0) {
      selected.push(candidate);
    } else {
      skipped.push({
        candidate,
        reason: determineSkipReason(candidate),
      });
    }
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped.map((value) => Object.freeze(value))),
  });
}

/** 指定した項目のrequiredな要素だけを実推論対象として選ぶ。 */
export function selectAiAnalysisTarget(
  candidates: readonly PreparedAiAnalysisCandidate[],
  target: AiAnalysisTarget,
): AiAnalysisTargetSelection {
  const normalizedTarget = createAiAnalysisTarget(target);
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`Codex分析候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
  }
  const candidate = candidates.find((value) => value.id === normalizedTarget.nodeId);
  if (candidate == null) {
    throw new TypeError(`指定したAI分析対象の項目がありません。対象: ${normalizedTarget.nodeId}`);
  }

  const candidatesByElement = new Map<AiAnalysisElement, AiAnalysisElementSelectionCandidate>();
  for (const elementCandidate of candidate.elements) {
    if (candidatesByElement.has(elementCandidate.element)) {
      throw new TypeError(`AI判定要素が重複しています。対象: ${elementCandidate.element}`);
    }
    candidatesByElement.set(elementCandidate.element, elementCandidate);
  }
  const selectedElements = normalizedTarget.elements.map((element) => {
    const elementCandidate = candidatesByElement.get(element);
    if (elementCandidate == null) {
      throw new TypeError(`指定したAI分析対象の要素候補がありません。対象: ${element}`);
    }
    if (elementCandidate.necessity !== "required") {
      throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
    }
    return elementCandidate;
  });
  return Object.freeze({
    candidate,
    selectedElements: Object.freeze(selectedElements),
  });
}

/** 選別候補からAIへ渡す要素名を安定した順序で取得する。 */
export function selectedAiAnalysisElements(
  candidate: PreparedAiAnalysisCandidate,
): readonly AiAnalysisElement[] {
  return Object.freeze(candidate.selectedElements.map((value) => value.element));
}

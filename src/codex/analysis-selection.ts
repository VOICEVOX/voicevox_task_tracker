import { parseSha256Hash, serializeCanonicalJson } from "./canonical-json.js";
import { AI_ANALYSIS_ELEMENT_SCHEMA_VERSION } from "./analysis-elements.js";
import {
  selectAiAnalysisElements,
  type AiAnalysisElementSelection,
  type AiAnalysisElementSelectionCandidate,
} from "./element-selection.js";
import { type AiAnalysisElement } from "./analysis-elements.js";
import { type CodexAnalysisInput } from "./input.js";
import { type ReasoningEffort } from "../domain/index.js";

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

/** 選別候補からAIへ渡す要素名を安定した順序で取得する。 */
export function selectedAiAnalysisElements(
  candidate: PreparedAiAnalysisCandidate,
): readonly AiAnalysisElement[] {
  return Object.freeze(candidate.selectedElements.map((value) => value.element));
}

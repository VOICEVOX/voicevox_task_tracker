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

/** IssueまたはPull RequestについてAIへ渡す要素の選別候補。 */
export type AnalysisElementSelectionCandidate = Readonly<{
  element: AnalysisElement;
  necessity: AnalysisElementNecessity;
  inputFingerprint: AnalysisElementInputFingerprint;
  executionFingerprint: AnalysisElementExecutionFingerprint;
  savedGeneration?: AnalysisElementSourceGeneration;
  inputProjectionVersion: number;
  dependencyFingerprint: AnalysisElementInputFingerprint;
  savedEvaluation?: AnalysisElementReuseRecord;
  savedReuse?: AnalysisElementReuseRecord;
}>;

/** 要素ごとの必要性候補。 */
export type AnalysisElementSelectionCandidates = Readonly<
  Record<AnalysisElement, AnalysisElementSelectionCandidate>
>;

/** AIへ渡さない要素の理由。 */
export type AnalysisElementSkipReason = "not_required" | "up_to_date";

/** AI判定要素の選別結果。 */
export type AnalysisElementSelection = Readonly<{
  selected: readonly AnalysisElementSelectionCandidate[];
  skipped: readonly Readonly<{
    candidate: AnalysisElementSelectionCandidate;
    reason: AnalysisElementSkipReason;
  }>[];
  shouldCallAi: boolean;
}>;

/** AI分析の要素別選択候補。 */
export type AiAnalysisElementSelectionCandidate = AnalysisElementSelectionCandidate;

/** AI分析の要素別選択結果。 */
export type AiAnalysisElementSelection = AnalysisElementSelection;

function validateCandidates(candidates: AnalysisElementSelectionCandidates): void {
  const candidateKeys = new Set(Object.keys(candidates));
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (!Object.hasOwn(candidates, element)) {
      throw new TypeError(`AI判定要素の必要性候補がありません。対象: ${element}`);
    }
    const candidate = candidates[element];
    if (candidate.element !== element) {
      throw new TypeError(`AI判定要素の必要性候補のキーと値が一致しません。対象: ${element}`);
    }
  }
  if (candidateKeys.size !== AI_ANALYSIS_ELEMENTS.length) {
    throw new TypeError("AI判定要素の必要性候補に未知の要素があります");
  }
}

function selectionReason(
  candidate: AnalysisElementSelectionCandidate,
): AnalysisElementSkipReason | undefined {
  if (candidate.necessity === "not_required") {
    return "not_required";
  }

  const savedProofs = [candidate.savedEvaluation?.proof, candidate.savedReuse?.proof];
  return savedProofs.some(
    (savedProof) =>
      savedProof != null &&
      determineAnalysisElementReuse({
        element: candidate.element,
        inputFingerprint: candidate.inputFingerprint,
        inputProjectionVersion: candidate.inputProjectionVersion,
        dependencyFingerprint: candidate.dependencyFingerprint,
        savedProof,
      }) === "verified",
  )
    ? "up_to_date"
    : undefined;
}

const STATE_ANALYSIS_ELEMENTS: ReadonlySet<AnalysisElement> = new Set([
  "status",
  "waitingOn",
  "nextAction",
]);

function shouldSelectStateAnalysisGroup(candidates: AnalysisElementSelectionCandidates): boolean {
  for (const element of STATE_ANALYSIS_ELEMENTS) {
    if (selectionReason(candidates[element]) == null) {
      return true;
    }
  }
  return false;
}

/** AIが必要な要素だけをrevision、入力、実行条件、未完了状態から純粋に選別する。 */
export function selectAnalysisElements(
  candidates: AnalysisElementSelectionCandidates,
): AnalysisElementSelection {
  validateCandidates(candidates);
  const shouldSelectStateGroup = shouldSelectStateAnalysisGroup(candidates);
  const selected: AnalysisElementSelectionCandidate[] = [];
  const skipped: {
    candidate: AnalysisElementSelectionCandidate;
    reason: AnalysisElementSkipReason;
  }[] = [];

  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = candidates[element];
    const reason = selectionReason(candidate);
    if (
      reason == null ||
      (shouldSelectStateGroup &&
        candidate.necessity === "required" &&
        STATE_ANALYSIS_ELEMENTS.has(element))
    ) {
      selected.push(candidate);
    } else {
      skipped.push({ candidate, reason });
    }
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped.map((value) => Object.freeze(value))),
    shouldCallAi: selected.length !== 0,
  });
}

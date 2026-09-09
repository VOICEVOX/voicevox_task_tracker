import {
  AI_ANALYSIS_ELEMENTS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  type AnalysisElement,
  type AnalysisElementExecutionFingerprint,
  type AnalysisElementGeneration,
  type AnalysisElementInputFingerprint,
  type AnalysisElementNecessity,
} from "./analysis-elements.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";

/** IssueまたはPull RequestについてAIへ渡す要素の選別候補。 */
export type AnalysisElementSelectionCandidate = Readonly<{
  element: AnalysisElement;
  necessity: AnalysisElementNecessity;
  inputFingerprint: AnalysisElementInputFingerprint;
  executionFingerprint: AnalysisElementExecutionFingerprint;
  savedGeneration?: AnalysisElementGeneration;
}>;

/** 8要素すべての必要性候補。 */
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

  const generation = candidate.savedGeneration;
  if (generation == null) {
    return undefined;
  }
  if (generation.metadata.revision !== AI_ANALYSIS_ELEMENT_REVISIONS[candidate.element]) {
    return undefined;
  }
  if (generation.metadata.inputFingerprint !== candidate.inputFingerprint) {
    return undefined;
  }
  if (generation.metadata.executionFingerprint !== candidate.executionFingerprint) {
    return undefined;
  }
  return "up_to_date";
}

/** AIが必要な要素だけをrevision、入力、実行条件、未完了状態から純粋に選別する。 */
export function selectAnalysisElements(
  candidates: AnalysisElementSelectionCandidates,
): AnalysisElementSelection {
  validateCandidates(candidates);
  const selected: AnalysisElementSelectionCandidate[] = [];
  const skipped: {
    candidate: AnalysisElementSelectionCandidate;
    reason: AnalysisElementSkipReason;
  }[] = [];

  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = candidates[element];
    const reason = selectionReason(candidate);
    if (reason == null) {
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

/** 8要素をすべて含む候補配列からAIが必要な要素だけを純粋に選別する。 */
export function selectAiAnalysisElements(
  candidates: readonly AnalysisElementSelectionCandidate[],
): AnalysisElementSelection {
  const candidatesByElement = new Map<AnalysisElement, AnalysisElementSelectionCandidate>();
  for (const candidate of candidates) {
    if (candidatesByElement.has(candidate.element)) {
      throw new TypeError(`AI判定要素が重複しています。対象: ${candidate.element}`);
    }
    candidatesByElement.set(candidate.element, candidate);
  }
  if (candidatesByElement.size !== AI_ANALYSIS_ELEMENTS.length) {
    throw new TypeError("AI判定要素の必要性候補が8要素を網羅していません");
  }
  const status = candidatesByElement.get("status");
  const waitingOn = candidatesByElement.get("waitingOn");
  const nextAction = candidatesByElement.get("nextAction");
  const relations = candidatesByElement.get("relations");
  const progress = candidatesByElement.get("progress");
  const importance = candidatesByElement.get("importance");
  const deadline = candidatesByElement.get("deadline");
  const notification = candidatesByElement.get("notification");
  assertNonNullable(status, "AI判定要素の必要性候補がありません。対象: status");
  assertNonNullable(waitingOn, "AI判定要素の必要性候補がありません。対象: waitingOn");
  assertNonNullable(nextAction, "AI判定要素の必要性候補がありません。対象: nextAction");
  assertNonNullable(relations, "AI判定要素の必要性候補がありません。対象: relations");
  assertNonNullable(progress, "AI判定要素の必要性候補がありません。対象: progress");
  assertNonNullable(importance, "AI判定要素の必要性候補がありません。対象: importance");
  assertNonNullable(deadline, "AI判定要素の必要性候補がありません。対象: deadline");
  assertNonNullable(notification, "AI判定要素の必要性候補がありません。対象: notification");
  return selectAnalysisElements({
    status,
    waitingOn,
    nextAction,
    relations,
    progress,
    importance,
    deadline,
    notification,
  });
}

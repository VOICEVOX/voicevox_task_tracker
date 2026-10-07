import type {
  GenericAiItemPlan,
  GenericAiPlan,
} from "../application/tracking-run/stages/generic-ai-plan-contracts.js";
import { createAnalysisElementExactInput } from "./analysis-element-dependencies.js";
import { AI_ANALYSIS_ELEMENTS } from "./analysis-elements.js";
import type {
  AiAnalysisRunElementResult,
  AiAnalysisRunResult,
} from "./analysis-runner-contracts.js";
import { createRunElementResult } from "./analysis-runner-results.js";
import type {
  AiAnalysisSkipReason,
  AiAnalysisTarget,
  PreparedAiAnalysisCandidate,
} from "./analysis-selection.js";

/** 計画済みのcache結果と項目を実行へ渡す。 */
export type CandidateCacheState = Readonly<{
  item: GenericAiItemPlan;
  cached: readonly AiAnalysisRunElementResult[];
}>;

export function selectPlannedCandidates(plan: GenericAiPlan): Readonly<{
  selected: readonly CandidateCacheState[];
  skipped: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }>[];
}> {
  const ids = new Set<string>();
  const selected: CandidateCacheState[] = [];
  const skipped: { candidate: PreparedAiAnalysisCandidate; reason: AiAnalysisSkipReason }[] = [];
  for (const item of plan.items) {
    if (ids.has(item.nodeId) || item.candidate.id !== item.nodeId) {
      throw new TypeError(`AI計画の候補IDが不正です。対象: ${item.nodeId}`);
    }
    ids.add(item.nodeId);
    const plannedElements = new Set(item.elements.map((value) => value.element));
    const candidateElements = new Set(item.candidate.elements.map((value) => value.element));
    if (
      item.elements.length !== AI_ANALYSIS_ELEMENTS.length ||
      plannedElements.size !== AI_ANALYSIS_ELEMENTS.length ||
      item.candidate.elements.length !== AI_ANALYSIS_ELEMENTS.length ||
      candidateElements.size !== AI_ANALYSIS_ELEMENTS.length ||
      AI_ANALYSIS_ELEMENTS.some((element) => !plannedElements.has(element))
    ) {
      throw new TypeError(`AI計画の要素集合が9要素と一致しません。対象: ${item.nodeId}`);
    }
    const selectedElements = item.candidate.selectedElements.map((value) => value.element);
    const selectedFromPlan = item.elements
      .filter((element) => element.selected)
      .map((element) => element.element);
    if (
      new Set(selectedElements).size !== selectedElements.length ||
      selectedElements.length !== item.selectedElements.length ||
      selectedElements.some((element, index) => element !== item.selectedElements[index]) ||
      selectedElements.some(
        (element, index) => element !== item.candidate.input.selectedElements[index],
      ) ||
      item.candidate.input.selectedElements.length !== selectedElements.length ||
      selectedFromPlan.length !== selectedElements.length ||
      selectedFromPlan.some((element, index) => element !== selectedElements[index])
    ) {
      throw new TypeError(`AI計画の選択要素が候補入力と一致しません。対象: ${item.nodeId}`);
    }
    for (const element of item.elements) {
      const candidate = item.candidate.elements.find((value) => value.element === element.element);
      if (candidate?.inputFingerprint !== element.inputFingerprint) {
        throw new TypeError(
          `AI計画のfingerprintが候補と一致しません。対象: ${item.nodeId}/${element.element}`,
        );
      }
      if (element.selected && element.choice !== "ai_disabled") {
        const input =
          element.choice === "execute" || element.choice === "budget_deferred"
            ? item.executionCandidate?.input
            : item.candidate.input;
        if (
          input == null ||
          createAnalysisElementExactInput(input, element.element).fingerprint !==
            element.inputFingerprint
        ) {
          throw new TypeError(
            `AI計画の厳密入力が実輸送入力と一致しません。対象: ${item.nodeId}/${element.element}`,
          );
        }
      }
    }
    const cached = item.elements
      .filter((element) => element.choice === "cache_hit")
      .map((element) =>
        createRunElementResult(
          element.element,
          "cache",
          element.entry.cacheKey,
          element.entry.generation,
        ),
      );
    const missing = item.elements
      .filter((element) => element.choice === "execute" || element.choice === "budget_deferred")
      .map((element) => element.element);
    if (
      cached.length + missing.length !== item.selectedElements.length ||
      (missing.length === 0) !== (item.executionCandidate == null) ||
      (item.executionCandidate != null &&
        (item.executionCandidate.input.selectedElements.length !== missing.length ||
          item.executionCandidate.selectedElements.length !== missing.length)) ||
      item.executionCandidate?.input.selectedElements.some(
        (element, index) => element !== missing[index],
      ) === true ||
      item.executionCandidate?.selectedElements.some(
        (candidate, index) => candidate.element !== missing[index],
      ) === true
    ) {
      throw new TypeError(`AI計画のcache判定と輸送入力が一致しません。対象: ${item.nodeId}`);
    }
    if (item.selectedElements.length === 0) {
      skipped.push({
        candidate: item.candidate,
        reason: item.planning.selection.skipped.some((value) => value.reason === "up_to_date")
          ? "up_to_date"
          : "not_required",
      });
    } else {
      selected.push(Object.freeze({ item, cached: Object.freeze(cached) }));
    }
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped.map((value) => Object.freeze(value))),
  });
}

export function assertTargetWasExecuted(run: AiAnalysisRunResult, target: AiAnalysisTarget): void {
  const result = run.results.find((candidate) => candidate.candidateId === target.nodeId);
  if (result == null) {
    const failure = run.failures.find((candidate) => candidate.candidateId === target.nodeId);
    throw new TypeError(
      `指定したAI分析対象の実推論結果がありません。対象: ${target.nodeId}`,
      failure == null ? {} : { cause: failure },
    );
  }
  for (const element of target.elements) {
    const elementResult = result.elements.find((candidate) => candidate.element === element);
    if (elementResult?.origin !== "executed") {
      throw new TypeError(
        `指定したAI分析対象の要素が実推論されていません。対象: ${target.nodeId} 要素: ${element}`,
      );
    }
  }
}

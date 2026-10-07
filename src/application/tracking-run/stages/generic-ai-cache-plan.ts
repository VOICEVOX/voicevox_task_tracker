import type { AnalysisElementExactInputMap } from "../../../codex/analysis-element-dependencies.js";
import type { AiAnalysisRunIdentity } from "../../../codex/analysis-selection.js";
import type { AnalysisElementPlanning } from "../../../codex/element-planning.js";
import { GENERIC_AI_ELEMENT_DEFINITIONS } from "../../../codex/generic-ai-definition.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
  type AiAnalysisElementInputFingerprint,
} from "../../../domain/ai-analysis-elements.js";
import type { AiAnalysisTarget } from "../../../codex/analysis-selection.js";
import type { AiCacheEntryId } from "../../../domain/types.js";

/** 計画段階のcache照合で検証済みの要素結果。 */
export type GenericAiCachedEntry = Readonly<{
  cacheKey: AiCacheEntryId;
  element: AiAnalysisElement;
  generation: AiAnalysisElementGeneration;
}>;

/** 計画段階で確定したcache照合結果。 */
export type GenericAiCacheLookup =
  Readonly<{ status: "hit"; entry: GenericAiCachedEntry }> | Readonly<{ status: "miss" | "stale" }>;

/** 要素cacheの副作用境界。 */
export type GenericAiCacheLookupPort = (
  identity: AiAnalysisRunIdentity,
  planning: AnalysisElementPlanning,
  element: AiAnalysisElement,
) => Promise<GenericAiCacheLookup>;

type GenericAiElementDecision =
  | Readonly<{ choice: "not_required"; reason: "deterministic" | "forced_target_other_element" }>
  | Readonly<{ choice: "snapshot_reuse"; reason: "current_completed_result" }>
  | Readonly<{ choice: "cache_hit"; reason: "current_input_cached"; entry: GenericAiCachedEntry }>
  | Readonly<{
      choice: "execute";
      reason: "cache_miss" | "cache_stale" | "forced_target" | "state_pair_required";
    }>
  | Readonly<{
      choice: "budget_deferred";
      reason:
        | "item_input_character_limit"
        | "call_limit"
        | "total_input_character_limit"
        | "estimated_cost_limit";
    }>
  | Readonly<{ choice: "ai_disabled"; reason: "ai_disabled" }>
  | Readonly<{ choice: "deferred"; reason: "forced_target_other_item" }>;

/** 汎用AIの1要素について確定した入力と計画理由。 */
export type GenericAiElementPlan = Readonly<{
  element: AiAnalysisElement;
  revision: number;
  inputProjectionVersion: number;
  necessity: "required" | "not_required";
  selected: boolean;
  exactInput: object;
  inputFingerprint: AiAnalysisElementInputFingerprint;
  dependencyFingerprint: AiAnalysisElementInputFingerprint;
}> &
  GenericAiElementDecision;

async function selectedElementDecision(
  identity: AiAnalysisRunIdentity,
  lookupCache: GenericAiCacheLookupPort,
  planning: AnalysisElementPlanning,
  element: AiAnalysisElement,
  forced: boolean,
): Promise<GenericAiElementDecision> {
  if (forced) {
    return Object.freeze({ choice: "execute", reason: "forced_target" });
  }
  const cached = await lookupCache(identity, planning, element);
  switch (cached.status) {
    case "hit":
      return Object.freeze({
        choice: "cache_hit",
        reason: "current_input_cached",
        entry: cached.entry,
      });
    case "miss":
      return Object.freeze({ choice: "execute", reason: "cache_miss" });
    case "stale":
      return Object.freeze({ choice: "execute", reason: "cache_stale" });
  }
}

/** 選択要素ごとのcache hitと実行要素を計画段階で確定する。 */
export async function planGenericAiCachedElements(
  exactInputs: AnalysisElementExactInputMap,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
  candidateId: string,
  aiEnabled: boolean,
  identity: AiAnalysisRunIdentity,
  lookupCache: GenericAiCacheLookupPort,
): Promise<readonly GenericAiElementPlan[]> {
  const selected = new Set(planning.selection.selected.map((value) => value.element));
  const skipped = new Map(
    planning.selection.skipped.map((value) => [value.candidate.element, value.reason]),
  );
  const elements: GenericAiElementPlan[] = [];
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const exact = exactInputs[element];
    const candidate = planning.candidates[element];
    if (exact.fingerprint !== candidate.inputFingerprint) {
      throw new TypeError(
        `AI要素の厳密入力とfingerprintが一致しません。対象: ${candidateId}/${element}`,
      );
    }
    const forcedOtherItem = target != null && target.nodeId !== candidateId;
    const forcedOtherElement = target?.nodeId === candidateId && !target.elements.includes(element);
    const selectedForExecution = selected.has(element) && !forcedOtherItem;
    let decision: GenericAiElementDecision;
    if (forcedOtherItem) {
      decision = Object.freeze({ choice: "deferred", reason: "forced_target_other_item" });
    } else if (forcedOtherElement) {
      decision = Object.freeze({ choice: "not_required", reason: "forced_target_other_element" });
    } else if (selectedForExecution) {
      decision = aiEnabled
        ? await selectedElementDecision(
            identity,
            lookupCache,
            planning,
            element,
            target?.nodeId === candidateId,
          )
        : Object.freeze({ choice: "ai_disabled", reason: "ai_disabled" });
    } else if (skipped.get(element) === "up_to_date") {
      decision = Object.freeze({ choice: "snapshot_reuse", reason: "current_completed_result" });
    } else {
      decision = Object.freeze({ choice: "not_required", reason: "deterministic" });
    }
    elements.push(
      Object.freeze({
        element,
        revision: GENERIC_AI_ELEMENT_DEFINITIONS[element].revision,
        inputProjectionVersion: GENERIC_AI_ELEMENT_DEFINITIONS[element].inputProjectionVersion,
        necessity: candidate.necessity,
        selected: selectedForExecution,
        ...decision,
        exactInput: exact.exactInput,
        inputFingerprint: exact.fingerprint,
        dependencyFingerprint: candidate.dependencyFingerprint,
      }),
    );
  }
  const status = elements.find((value) => value.element === "status");
  const waitingOn = elements.find((value) => value.element === "waitingOn");
  if (
    status?.selected === true &&
    waitingOn?.selected === true &&
    ((status.choice === "cache_hit" && waitingOn.choice === "execute") ||
      (waitingOn.choice === "cache_hit" && status.choice === "execute"))
  ) {
    const coupledExecution = Object.freeze({
      choice: "execute",
      reason: "state_pair_required",
    } satisfies GenericAiElementDecision);
    return Object.freeze(
      elements.map((value) =>
        (value.element === "status" || value.element === "waitingOn") &&
        value.choice === "cache_hit"
          ? Object.freeze({ ...value, ...coupledExecution })
          : value,
      ),
    );
  }
  return Object.freeze(elements);
}

import type {
  AiAnalysisTarget,
  AnalysisElementPlanning,
  AnalysisElementSelection,
  AnalysisElementSelectionCandidate,
} from "../../../codex/index.js";
import { AI_ANALYSIS_ELEMENTS } from "../../../domain/ai-analysis-elements.js";
import { assertNonNullable } from "../../../util/index.js";

export function forcedAnalysisSelection(
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): AnalysisElementSelection {
  const candidatesByElement = new Map(
    AI_ANALYSIS_ELEMENTS.map((element) => [element, planning.candidates[element]]),
  );
  const selected = target.elements.map((element) => {
    const candidate = candidatesByElement.get(element);
    assertNonNullable(candidate, `指定したAI分析要素の候補がありません。対象: ${element}`);
    if (candidate.necessity !== "required") {
      throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
    }
    return candidate;
  });
  const selectedSet = new Set(target.elements);
  const skipped = AI_ANALYSIS_ELEMENTS.filter((element) => !selectedSet.has(element)).map(
    (element) => {
      const candidate = candidatesByElement.get(element);
      assertNonNullable(candidate, `指定したAI分析要素の候補がありません。対象: ${element}`);
      return Object.freeze({
        candidate: Object.freeze({
          ...candidate,
          necessity: "not_required" as const,
        }),
        reason: "not_required" as const,
      });
    },
  );
  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped),
    shouldCallAi: true,
  });
}

export function forcedCandidateElements(
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): readonly AnalysisElementSelectionCandidate[] {
  const selectedSet = new Set(target.elements);
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.map((element) => {
      const candidate = planning.candidates[element];
      const selected = selectedSet.has(element);
      if (selected && candidate.necessity !== "required") {
        throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
      }
      return Object.freeze({
        ...candidate,
        necessity: selected ? ("required" as const) : ("not_required" as const),
      });
    }),
  );
}

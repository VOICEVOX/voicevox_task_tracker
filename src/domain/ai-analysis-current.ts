import type {
  AiAnalysisElement,
  AiAnalysisElementMigrationResult,
} from "./ai-analysis-elements.js";
import type {
  TrackedItemAiAnalysis,
  TrackedItemAiAnalysisCurrentAdoptedElement,
  TrackedItemAiAnalysisMigrationAdoptedElement,
  TrackedItemAiAnalysisMigrationAdoptedElements,
} from "./tracked-item-ai-analysis.js";

/** 現在の適用元に対応するAI採用値だけを返す。 */
export function currentAiAdoptedElement<Element extends AiAnalysisElement>(
  analysis: TrackedItemAiAnalysis,
  element: Element,
): TrackedItemAiAnalysisCurrentAdoptedElement<Element> | undefined {
  const current = analysis.adoptedElements[element];
  if (analysis.applications[element].status !== "current_ai") {
    if (current != null) {
      throw new TypeError(`非現在のAI要素に現在採用値があります。対象: ${element}`);
    }
    return undefined;
  }
  if (current == null) {
    throw new TypeError(`現在のAI要素に採用値がありません。対象: ${element}`);
  }
  return current;
}

/** 現在の適用元に対応するAI結果だけを返す。 */
export function currentAiResult<Element extends AiAnalysisElement>(
  analysis: TrackedItemAiAnalysis,
  element: Element,
): AiAnalysisElementMigrationResult<Element> | undefined {
  return currentAiAdoptedElement(analysis, element)?.result;
}

/** 現在の適用には使わないAI採用履歴だけを返す。 */
export function historicalAiAdoptedElement<Element extends AiAnalysisElement>(
  analysis: TrackedItemAiAnalysis,
  element: Element,
): TrackedItemAiAnalysisMigrationAdoptedElement<Element> | undefined {
  return analysis.retainedElements[element];
}

/** 再利用のために現在採用値と採用履歴を選ぶ。 */
export function reusableAiAdoptedElement<Element extends AiAnalysisElement>(
  analysis: TrackedItemAiAnalysis,
  element: Element,
):
  | TrackedItemAiAnalysisCurrentAdoptedElement<Element>
  | TrackedItemAiAnalysisMigrationAdoptedElement<Element>
  | undefined {
  return (
    currentAiAdoptedElement(analysis, element) ?? historicalAiAdoptedElement(analysis, element)
  );
}

/** 再利用計画に渡す現在採用値と採用履歴を合成する。 */
export function reusableAiAdoptedElements(
  analysis: TrackedItemAiAnalysis,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  return Object.freeze({ ...analysis.retainedElements, ...analysis.adoptedElements });
}

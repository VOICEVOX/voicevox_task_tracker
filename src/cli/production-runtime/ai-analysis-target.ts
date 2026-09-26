import { createAiAnalysisTarget, type AiAnalysisTarget } from "../../codex/index.js";
import type { AiAnalysisElement } from "../../domain/ai-analysis-elements.js";
import type { DeterministicItemAnalysis } from "../initial-item-analysis.js";
import type { RuntimeConfiguration } from "./contracts.js";

/** 強制解析設定から対象を取得する。 */
export function forcedAiAnalysisTarget(
  configuration: RuntimeConfiguration,
): AiAnalysisTarget | undefined {
  if (
    configuration.target.kind !== "sandbox" ||
    configuration.target.context.analysisMode.kind !== "forced"
  ) {
    return undefined;
  }
  return createAiAnalysisTarget(configuration.target.context.analysisMode.target);
}

/** 強制解析で実行対象外となる要素を判定する。 */
export function isForcedUnexecutedElement(
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  target: AiAnalysisTarget | undefined,
): boolean {
  return (
    target != null && (target.nodeId !== analysis.item.nodeId || !target.elements.includes(element))
  );
}

import type { PublicItemSummaryDto } from "../../src/pages/public-dto-contracts.js";
import { UnreachableError } from "../../src/util/index.js";
import type { AiUnverifiedValue } from "./model-contracts.js";
import { aiUnverifiedValueLabel, currentResponseUnverifiedValueLabel } from "./model-labels.js";

function itemAiAnalysisRunUnverifiedDescription(
  runStatus: PublicItemSummaryDto["aiAnalysis"]["runStatus"],
): string | undefined {
  switch (runStatus) {
    case "failed":
      return "今回のAI分析に失敗しました。";
    case "deferred":
      return "予算上限により今回はAI分析を実行していません。";
    case "used":
    case "not_required":
    case "disabled":
    case "not_recorded":
      return undefined;
    default:
      throw new UnreachableError(runStatus);
  }
}

function itemAiUnverifiedValueLabels(item: PublicItemSummaryDto): readonly string[] {
  const labels = new Set(
    item.aiAnalysis.unverifiedValues.map((value) => aiUnverifiedValueLabel(value)),
  );
  if (item.currentResponsesUnverified) {
    labels.add("現在の対応の集合");
  }
  for (const response of item.currentResponses) {
    for (const value of response.unverifiedValues) {
      labels.add(currentResponseUnverifiedValueLabel(value));
    }
    if (response.subjectMembershipUnverified) {
      labels.add("現在の対応者として数える対象");
    }
  }
  return [...labels];
}

/** 項目に残るAI未検証値を一覧行向けに説明する。 */
export function itemAiUnverifiedDescription(item: PublicItemSummaryDto): string | undefined {
  const runDescription = itemAiAnalysisRunUnverifiedDescription(item.aiAnalysis.runStatus);
  const valueLabels = itemAiUnverifiedValueLabels(item);
  if (runDescription == null && valueLabels.length === 0) {
    return undefined;
  }
  let description = valueLabels.length > 0 ? "現在入力で未検証のAI推定があります。" : "";
  if (runDescription != null) {
    description += runDescription;
  }
  if (valueLabels.length > 0) {
    description += `未検証の値: ${valueLabels.join("、")}。`;
  }
  return description;
}

/** 項目一覧のAI注意マークを読み上げる文言を返す。 */
export function itemAiNoticeAriaLabel(item: PublicItemSummaryDto): string {
  if (itemAiUnverifiedValueLabels(item).length > 0) {
    return "現在入力で未検証";
  }
  switch (item.aiAnalysis.runStatus) {
    case "failed":
      return "今回のAI分析に失敗";
    case "deferred":
      return "今回はAI分析を実行していません";
    case "used":
    case "not_required":
    case "disabled":
    case "not_recorded":
      throw new TypeError("AI注意マークの読み上げ対象がありません");
    default:
      throw new UnreachableError(item.aiAnalysis.runStatus);
  }
}

/** 項目のAI推定または現在の対応に未検証値があるかを返す。 */
export function hasItemAiUnverifiedValue(item: PublicItemSummaryDto): boolean {
  return itemAiUnverifiedDescription(item) != null;
}

/** 指定した表示値がAI未検証かを返す。 */
export function hasAiUnverifiedValue(
  aiAnalysis: PublicItemSummaryDto["aiAnalysis"],
  value: AiUnverifiedValue,
): boolean {
  return aiAnalysis.unverifiedValues.includes(value);
}

import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { importanceLevelLabel } from "./model.js";

type ImportanceBadgeProps = Readonly<{
  importance: PublicItemSummaryDto["importance"];
  showLow: boolean;
  showScore: boolean;
}>;

/** 重要度のレベルと必要に応じて点数を表示する。 */
export function ImportanceBadge({ importance, showLow, showScore }: ImportanceBadgeProps) {
  if (!showLow && importance.level === "low") {
    return null;
  }
  return (
    <span class={`importance-badge importance-${importance.level}`}>
      <span>{importanceLevelLabel(importance.level)}</span>
      {showScore && <strong>{importance.score.toString()}点</strong>}
    </span>
  );
}

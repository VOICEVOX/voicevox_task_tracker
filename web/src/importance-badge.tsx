import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { importanceLevelLabel } from "./model.js";
import { Pill } from "./ui.js";

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
    <Pill className={`importance-badge importance-${importance.level}`} tone={importance.level}>
      <span>{importanceLevelLabel(importance.level)}</span>
      {showScore && <strong class="tabular-nums">{importance.score.toString()}点</strong>}
    </Pill>
  );
}

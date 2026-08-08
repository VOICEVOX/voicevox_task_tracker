import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { importanceLevelLabel } from "./model.js";
import { Pill } from "./ui.js";

type ScoreWithLevel = PublicItemSummaryDto["importance"];

type ImportanceBadgeProps = Readonly<{
  importance: PublicItemSummaryDto["importance"];
  showLabel: boolean;
  showLow: boolean;
  showScore: boolean;
}>;

type AttentionBadgeProps = Readonly<{
  attention: PublicItemSummaryDto["attention"];
  showLabel: boolean;
  showLow: boolean;
  showScore: boolean;
}>;

function ScoreBadge({
  className,
  label,
  score,
  showLabel,
  showLow,
  showScore,
}: Readonly<{
  className: string;
  label: string;
  score: ScoreWithLevel;
  showLabel: boolean;
  showLow: boolean;
  showScore: boolean;
}>) {
  if (!showLow && score.level === "low") {
    return null;
  }
  return (
    <Pill className={`${className} importance-${score.level}`} tone={score.level}>
      {showLabel && <span>{label}</span>}
      <span>{importanceLevelLabel(score.level)}</span>
      {showScore && <strong class="tabular-nums">{score.score.toString()}点</strong>}
    </Pill>
  );
}

/** 重要度のレベルと必要に応じて点数を表示する。 */
export function ImportanceBadge({
  importance,
  showLabel,
  showLow,
  showScore,
}: ImportanceBadgeProps) {
  return (
    <ScoreBadge
      className="importance-badge"
      label="重要度"
      score={importance}
      showLabel={showLabel}
      showLow={showLow}
      showScore={showScore}
    />
  );
}

/** 要対応度のレベルと必要に応じて点数を表示する。 */
export function AttentionBadge({ attention, showLabel, showLow, showScore }: AttentionBadgeProps) {
  return (
    <ScoreBadge
      className="attention-badge"
      label="要対応度"
      score={attention}
      showLabel={showLabel}
      showLow={showLow}
      showScore={showScore}
    />
  );
}

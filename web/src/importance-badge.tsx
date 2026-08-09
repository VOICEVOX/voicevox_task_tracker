import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { importanceLevelLabel } from "./model.js";
import { Pill, type PillVariant } from "./ui.js";

type ScoreWithLevel = PublicItemSummaryDto["importance"];

type ImportanceBadgeProps = Readonly<{
  importance: PublicItemSummaryDto["importance"];
  showLabel: boolean;
  showScore: boolean;
}>;

type AttentionBadgeProps = Readonly<{
  attention: PublicItemSummaryDto["attention"];
  showLabel: boolean;
  showScore: boolean;
}>;

function ScoreBadge({
  className,
  label,
  score,
  showLabel,
  showScore,
  variant,
}: Readonly<{
  className: string;
  label: string;
  score: ScoreWithLevel;
  showLabel: boolean;
  showScore: boolean;
  variant: PillVariant;
}>) {
  return (
    <Pill className={`${className} importance-${score.level}`} tone={score.level} variant={variant}>
      {showLabel && <span>{label}</span>}
      <span>{importanceLevelLabel(score.level)}</span>
      {showScore && <strong class="tabular-nums">{score.score.toString()}点</strong>}
    </Pill>
  );
}

/** 重要度のレベルと必要に応じて点数を表示する。 */
export function ImportanceBadge({ importance, showLabel, showScore }: ImportanceBadgeProps) {
  return (
    <ScoreBadge
      className="importance-badge"
      label="重要度"
      score={importance}
      showLabel={showLabel}
      showScore={showScore}
      variant="outlined"
    />
  );
}

/** 要対応度のレベルと必要に応じて点数を表示する。 */
export function AttentionBadge({ attention, showLabel, showScore }: AttentionBadgeProps) {
  return (
    <ScoreBadge
      className="attention-badge"
      label="要対応度"
      score={attention}
      showLabel={showLabel}
      showScore={showScore}
      variant="filled"
    />
  );
}

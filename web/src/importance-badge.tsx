import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { importanceLevelLabel } from "./model.js";
import { Pill } from "./ui.js";

type ScoreWithLevel = PublicItemSummaryDto["importance"];
type ScoreBadgePresentation = "level_and_score" | "score";

type ImportanceBadgeProps = Readonly<{
  importance: PublicItemSummaryDto["importance"];
  presentation: ScoreBadgePresentation;
}>;

type AttentionBadgeProps = Readonly<{
  attention: PublicItemSummaryDto["attention"];
  presentation: ScoreBadgePresentation;
}>;

function ScoreBadge({
  className,
  presentation,
  score,
}: Readonly<{
  className: string;
  presentation: ScoreBadgePresentation;
  score: ScoreWithLevel;
}>) {
  return (
    <Pill
      className={`${className} importance-${score.level} font-mono tabular-nums ${presentation === "score" ? "min-w-12 justify-center" : ""}`}
      tone={score.level}
    >
      {presentation === "level_and_score" && <span>{importanceLevelLabel(score.level)}</span>}
      <strong>{score.score.toString()}点</strong>
    </Pill>
  );
}

/** 重要度を指定した一覧向けまたは詳細向けの形式で表示する。 */
export function ImportanceBadge({ importance, presentation }: ImportanceBadgeProps) {
  return <ScoreBadge className="importance-badge" presentation={presentation} score={importance} />;
}

/** 要対応度を指定した一覧向けまたは詳細向けの形式で表示する。 */
export function AttentionBadge({ attention, presentation }: AttentionBadgeProps) {
  return <ScoreBadge className="attention-badge" presentation={presentation} score={attention} />;
}

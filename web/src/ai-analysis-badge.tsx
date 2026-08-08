import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { isAiAnalysisDegraded } from "./model.js";
import { Pill } from "./ui.js";

/** AI判定を利用できなかった項目に警告を表示する。 */
export function AiAnalysisBadge({
  status,
}: Readonly<{
  status: PublicItemSummaryDto["aiAnalysis"]["status"];
}>) {
  if (!isAiAnalysisDegraded(status)) {
    return null;
  }
  return (
    <Pill className="ai-analysis-badge ai-analysis-degraded" tone="warning">
      AI判定なし
    </Pill>
  );
}

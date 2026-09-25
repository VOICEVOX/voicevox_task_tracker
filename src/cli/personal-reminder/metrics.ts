import type { AiBudgetUsage } from "../../codex/budget.js";
import { currentPersonalReminderAssessment } from "../../domain/personal-reminder-causes.js";
import type { PersonalReminderAnalysisResult } from "./analysis-result.js";

/** 個人催促causeの評価状態を数える。 */
export function personalReminderCauseAttemptCounts(
  result: PersonalReminderAnalysisResult,
): Readonly<{
  unknown: number;
  failed: number;
  deferred: number;
  notEvaluated: number;
}> {
  const causes = [...result.itemsByNodeId.values()].flatMap((item) =>
    item.causeResults.map((causeResult) => causeResult.cause),
  );
  return Object.freeze({
    unknown: causes.filter((cause) => {
      const assessment = currentPersonalReminderAssessment(cause);
      return assessment.status === "available" && assessment.result.verdict === "unknown";
    }).length,
    failed: causes.filter(
      (cause) =>
        currentPersonalReminderAssessment(cause).status !== "available" &&
        cause.latestAttempt.status === "failed",
    ).length,
    deferred: causes.filter(
      (cause) =>
        currentPersonalReminderAssessment(cause).status !== "available" &&
        cause.latestAttempt.status === "deferred",
    ).length,
    notEvaluated: causes.filter(
      (cause) =>
        currentPersonalReminderAssessment(cause).status !== "available" &&
        cause.latestAttempt.status === "not_evaluated",
    ).length,
  });
}

/** 個人催促AIの追加使用量を求める。 */
export function personalReminderUsageDelta(
  usage: AiBudgetUsage,
  initialUsage: AiBudgetUsage,
): AiBudgetUsage {
  if (
    usage.calls < initialUsage.calls ||
    usage.inputCharacters < initialUsage.inputCharacters ||
    usage.estimatedCostUsd < initialUsage.estimatedCostUsd
  ) {
    throw new TypeError("個人催促AIの累積使用量が初期使用量を下回っています");
  }
  return Object.freeze({
    calls: usage.calls - initialUsage.calls,
    inputCharacters: usage.inputCharacters - initialUsage.inputCharacters,
    estimatedCostUsd: usage.estimatedCostUsd - initialUsage.estimatedCostUsd,
  });
}

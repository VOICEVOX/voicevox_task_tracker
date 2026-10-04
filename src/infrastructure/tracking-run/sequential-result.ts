import type { CompletedRun } from "../../application/tracking-run/complete-run.js";
import type { FailedRun } from "../../application/tracking-run/failure-artifact.js";
import type { UtcIsoDateTime } from "../../domain/types.js";
import type { RunReport } from "../../publication/run-report.js";

/** 通知段階の値と送信指標。 */
export type NotificationStageResult<Value> = Readonly<{
  value: Value;
  notificationCount: number;
  discordSentAt: UtcIsoDateTime | null;
}>;

/** 日次transaction実行後に生じた副作用を表す。 */
export type DailyRunEffects = Readonly<{
  stateCommitted: boolean;
  pagesBuilt: boolean;
  discordAttempted: boolean;
  artifactWritten: boolean;
}>;

/** 日次transactionのreportと副作用実績。 */
export type DailyRunExecutionResult = Readonly<{
  report: RunReport;
  effects: DailyRunEffects;
  completedRun?: CompletedRun;
  failedRun?: FailedRun;
  failureDiagnosticRecordId?: string;
  failureEvidence?: FailedRun["evidence"];
}>;

/** 日次transactionの時刻を注入する境界。 */
export type DailyRunRuntime = Readonly<{
  now: () => Date;
}>;

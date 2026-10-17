import { type UtcIsoDateTime } from "../../domain/index.js";

/** workflow障害時に運用障害通知だけを送るCLI入力。 */
export type NotifyOperationsCliCommand = Readonly<{
  kind: "notify-operations";
  configPath: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  workflowKind: "daily" | "manual";
  failureDirectory: string;
  outputFailureDirectory: string;
  previousFailuresDirectory: string;
  failedJobs: readonly string[];
  receiptPath: string;
  previousReceiptsDirectory: string;
  occurredAt: UtcIsoDateTime;
  retryAttempts: number;
}>;

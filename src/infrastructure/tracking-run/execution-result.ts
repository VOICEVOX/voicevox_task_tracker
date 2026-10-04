import type { DailyRunExecutionResult } from "./sequential-result.js";

/** CLI実行後の終了codeとreport種別。 */
export type CliExecutionResult =
  | Readonly<{
      command: "help";
      exitCode: 0;
    }>
  | Readonly<{
      command:
        "daily" | "dry-run" | "backfill" | "collect-analyze" | "run-sequential" | "run-stage";
      exitCode: 0 | 1;
      execution: "executed" | "deduplicated";
      result: DailyRunExecutionResult;
    }>
  | Readonly<{
      command:
        | "resolve-discord-delivery"
        | "notify-operations"
        | "report-workflow"
        | "verify-checkpoint"
        | "verify-runtime-recovery"
        | "inspect-run-state"
        | "verify-receipt-chain"
        | "report-failure"
        | "run-stage"
        | "route-stage"
        | "runtime-recovery-v2";
      exitCode: 0;
    }>
  | Readonly<{
      command: "verify-state";
      exitCode: 0;
    }>;

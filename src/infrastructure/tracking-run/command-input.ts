import { type NotificationAction } from "../../application/tracking-run/contracts/closed-values.js";
import type { CliSchedule } from "./command-schedule.js";
import type { NotifyOperationsCliCommand } from "./operations-command-input.js";
import type {
  RecoverRuntimeV2CliCommand,
  RouteStageCliCommand,
  RunStageCliCommand,
} from "./split-command-input.js";

export type OnlineCommandFields = Readonly<{
  configPath: string;
  reportPath: string;
  schedule: CliSchedule;
}>;

type NotificationActionCommandFields = Readonly<{
  notificationAction: NotificationAction;
}>;

/** 通常の日次実行を表すCLI入力。 */
export type DailyCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "daily";
  }>;

/** 外部公開を行わない日次実行を表すCLI入力。 */
export type DryRunCliCommand = OnlineCommandFields &
  Readonly<{
    kind: "dry-run";
    artifactPath: string;
  }>;

/** 追跡対象を追加する日次実行を表すCLI入力。 */
export type BackfillCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "backfill";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
  }>;

/** 直列engineを使う日次またはbackfillのCLI入力。 */
export type RunSequentialCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "run-sequential";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
  }>;

/** workflowの収集と判定だけを行うCLI入力。 */
export type CollectAnalyzeCliCommand = OnlineCommandFields &
  NotificationActionCommandFields &
  Readonly<{
    kind: "collect-analyze";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
    artifactPath: string;
    sandboxContextPath: string | undefined;
  }>;

/** Discord通知の送信保留を解除するCLI入力。 */
export type ResolveDiscordDeliveryCliCommand = Readonly<{
  kind: "resolve-discord-delivery";
  configPath: string;
  runId: string;
  checkpointDigest: string;
  deliveryId: string;
  attemptId: string;
  notificationKeys: readonly string[];
  resolution: "retry" | "acknowledge";
  receiptPath: string;
}>;

/** workflow全体のjob結果をCLI reportへ統合する入力。 */
export type ReportWorkflowCliCommand = Readonly<{
  kind: "report-workflow";
  actionsJobsPath: string;
  collectAnalyzeReportPath: string;
  completionDirectory: string;
  failureDirectory: string;
  outputPath: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  trackingRunId: string | undefined;
  effectTarget: "production" | "sandbox" | "recording";
}>;

/** 指定した永続stateディレクトリを検証するCLI入力。 */
export type VerifyStateCliCommand = Readonly<{
  kind: "verify-state";
  stateDirectory: string;
  stateRevision: string;
  configPath: string;
}>;

/** v24 checkpointとexact baseの結合を検証するCLI入力。 */
export type VerifyCheckpointCliCommand = Readonly<{
  kind: "verify-checkpoint";
  configPath: string;
  artifactPath: string;
}>;

/** 固定V1 protocolでexact runtimeを検証するCLI入力。 */
export type VerifyRuntimeRecoveryCliCommand = Readonly<{
  kind: "verify-runtime-recovery";
  inputPath: string;
  bundleRoot: string | undefined;
}>;

/** 永続stateの起動またはrun指定再開を判定する入力。 */
export type InspectRunStateCliCommand = Readonly<{
  kind: "inspect-run-state";
  configPath: string;
  stateRef: string | undefined;
  recoveryIntent:
    | Readonly<{ kind: "start_new" }>
    | Readonly<{ kind: "retry_run"; runId: string; exactStateRevision: string }>;
}>;

/** receipt列の保存内容を検証する入力。 */
export type VerifyReceiptChainCliCommand = Readonly<{
  kind: "verify-receipt-chain";
  inputPath: string;
}>;

/** 記録済み失敗runから公開artifactを作る入力。 */
export type ReportFailureCliCommand = Readonly<{
  kind: "report-failure";
  inputPath: string;
  outputPath: string;
}>;

/** CLIの使用方法だけを表示する入力。 */
export type HelpCliCommand = Readonly<{
  kind: "help";
}>;

/** サポートする全サブコマンドの検証済み入力。 */
export type CliCommand =
  | DailyCliCommand
  | DryRunCliCommand
  | BackfillCliCommand
  | RunSequentialCliCommand
  | RunStageCliCommand
  | RouteStageCliCommand
  | RecoverRuntimeV2CliCommand
  | CollectAnalyzeCliCommand
  | ResolveDiscordDeliveryCliCommand
  | NotifyOperationsCliCommand
  | ReportWorkflowCliCommand
  | VerifyStateCliCommand
  | VerifyCheckpointCliCommand
  | VerifyRuntimeRecoveryCliCommand
  | InspectRunStateCliCommand
  | VerifyReceiptChainCliCommand
  | ReportFailureCliCommand
  | HelpCliCommand;

import type { CompletedRun } from "../../application/tracking-run/complete-run.js";
import type { FailedRun } from "../../application/tracking-run/failure-artifact.js";
import { createUtcIsoDateTime, type UtcIsoDateTime } from "../../domain/index.js";
import type { StateRunReport } from "../../persistence/state-run-report.js";
import {
  createRunReport,
  type RunMetrics,
  type RunReport,
  type RunStage,
} from "../../publication/run-report.js";
import { VerifiedPendingRuntimeFailureError } from "./failure-context-error.js";
import type { RunInvocation } from "./run-invocation.js";
import type { DailyRunRuntime } from "./sequential-result.js";

/** dry-runの共通完了receiptと本番効果ゼロを示す成果物。 */
export type DryRunArtifact<Value> = Readonly<{
  schemaVersion: "3";
  runId: string;
  command: "dry-run";
  status: "success" | "fallback";
  complete: true;
  result: Value;
  effectReport: Readonly<{
    effectTarget: "recording";
    stateStorage: "isolated_local_git";
    finalStateRevision: string;
    completionReceiptDigest: string;
    productionStateCommits: 0;
    productionPagesDeployments: 0;
    productionDiscordSends: 0;
  }>;
  metrics: RunMetrics;
  diagnostics: readonly string[];
}>;

/** run runtimeの現在時刻をUTC日時へ変換する。 */
export function currentTime(runtime: DailyRunRuntime): UtcIsoDateTime {
  const value = runtime.now();
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("run runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(value.toISOString());
}

/** run指標を妥当性検証して更新する。 */
export function updateMetrics(metrics: RunMetrics, values: Partial<RunMetrics>): RunMetrics {
  const updated = {
    ...metrics,
    ...values,
  };
  for (const [name, value] of Object.entries(updated)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name}は0以上の安全な整数にしてください`);
    }
  }
  return Object.freeze(updated);
}

/** dry-runの検証済みartifactを作る。 */
export function createDryRunArtifact<Value>(
  invocation: RunInvocation,
  status: "success" | "fallback",
  planned: Value,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  finishedAt: UtcIsoDateTime,
  completed: CompletedRun,
): DryRunArtifact<Value> {
  const completedMetrics = updateMetrics(metrics, {
    durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
  });
  return Object.freeze({
    schemaVersion: "3",
    runId: invocation.runId,
    command: "dry-run",
    status,
    complete: true,
    result: planned,
    effectReport: Object.freeze({
      effectTarget: "recording",
      stateStorage: "isolated_local_git",
      finalStateRevision: completed.finalStateRevision,
      completionReceiptDigest: completed.receipt.receiptDigest,
      productionStateCommits: 0,
      productionPagesDeployments: 0,
      productionDiscordSends: 0,
    }),
    metrics: completedMetrics,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

/** 完了runのreportを作る。 */
export function completedReport(
  invocation: RunInvocation,
  status: "success" | "fallback",
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "5",
    runId: invocation.runId,
    command: invocation.commandKind,
    status,
    complete: true,
    scheduledFor: invocation.scheduledFor,
    startedAt: invocation.startedAt,
    finishedAt,
    discordSentAt,
    metrics: updateMetrics(metrics, {
      durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
    }),
    diagnostics,
  });
}

/** 最終stateの保存済み値と完了receiptからCLI run reportを作る。 */
export function completedReportFromState(
  invocation: RunInvocation,
  stateReport: StateRunReport,
  completed: CompletedRun,
): RunReport {
  const sentAt = completed.chain.receipts
    .filter(
      (receipt) => receipt.receiptType === "notification_message" && receipt.status === "sent",
    )
    .map((receipt) => receipt.effectOccurredAt)
    .sort()
    .at(-1);
  return createRunReport({
    schemaVersion: "5",
    runId: stateReport.runId,
    command: invocation.commandKind,
    status: stateReport.status,
    complete: true,
    scheduledFor: stateReport.scheduledFor,
    startedAt: stateReport.startedAt,
    finishedAt: stateReport.finishedAt,
    discordSentAt:
      invocation.executionPolicy.effectTarget === "production" && sentAt != null
        ? createUtcIsoDateTime(sentAt)
        : null,
    metrics: stateReport.metrics,
    diagnostics: stateReport.diagnostics,
  });
}

/** 失敗runのreportを作る。 */
export function failureReport(
  invocation: RunInvocation,
  failedStage: RunStage,
  failureKind: Extract<RunReport, { status: "failure" }>["failureKind"],
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "5",
    runId: invocation.runId,
    command: invocation.commandKind,
    status: "failure",
    complete: false,
    failureKind,
    failedStage,
    scheduledFor: invocation.scheduledFor,
    startedAt: invocation.startedAt,
    finishedAt,
    discordSentAt,
    metrics: updateMetrics(metrics, {
      durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
    }),
    diagnostics,
  });
}

/** engine stageをCLI report stageへ対応させる。 */
export function reportStageForEngine(stage: FailedRun["failedStage"]): RunStage {
  switch (stage) {
    case "runtime_bootstrap":
    case "prepare":
    case "prepared":
      return "configuration";
    case "runtime_selection":
    case "runtime_launch":
    case "workflow_effect_observation":
      return stage;
    case "inventory_collected":
      return "repository_inventory";
    case "collected":
      return "incremental_collection";
    case "deterministically_analyzed":
      return "deterministic_analysis";
    case "generic_ai_planned":
    case "generic_ai_executed":
    case "generic_ai_adopted":
      return "codex_analysis";
    case "graph_reconciled":
      return "graph_analysis";
    case "personal_reminder_planned":
    case "personal_reminder_executed":
    case "personal_reminder_finalized":
      return "personal_reminder_analysis";
    case "validated":
      return "completeness_validation";
    case "publication_planned":
    case "checkpoint_encoding":
    case "checkpoint_binding":
    case "completed":
      return "artifact";
    case "initial_state_committed":
    case "run_finalized":
      return "state_persistence";
    case "initial_pages_prepared":
    case "initial_pages_published":
    case "notification_history_pages_prepared":
    case "notification_history_pages_published":
      return "pages";
    case "notifications_settled":
      return "discord";
  }
}

/** 検証済みpending runの失敗reportを保存済みrunへ結び付ける。 */
export function reportContextForFailure(
  invocation: RunInvocation,
  stage: FailedRun["failedStage"],
  error: unknown,
): Readonly<{ invocation: RunInvocation; stage: RunStage }> {
  if (error instanceof VerifiedPendingRuntimeFailureError) {
    return {
      invocation: Object.freeze({ ...invocation, runId: error.binding.runId }),
      stage: error.failedStage,
    };
  }
  return { invocation, stage: reportStageForEngine(stage) };
}

/** checkpoint前の失敗段階か判定する。 */
export function isPreCheckpointFailureStage(stage: RunStage): boolean {
  return (
    stage === "repository_inventory" ||
    stage === "incremental_collection" ||
    stage === "deterministic_analysis" ||
    stage === "codex_analysis" ||
    stage === "reducer" ||
    stage === "graph_analysis" ||
    stage === "personal_reminder_analysis" ||
    stage === "completeness_validation" ||
    stage === "artifact"
  );
}

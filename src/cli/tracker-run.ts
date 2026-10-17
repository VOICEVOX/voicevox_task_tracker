import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { DiagnosticsError } from "../diagnostics/errors.js";
import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createDiagnosticsRecorder } from "../diagnostics/recorder.js";
import type { CliCommand } from "../infrastructure/tracking-run/command-input.js";
import { safeErrorDiagnostic } from "../infrastructure/tracking-run/error-diagnostic.js";
import {
  CliCodexAuthenticationError,
  CliCredentialsError,
  CliExecutableError,
  CliUsageError,
  CliWorkflowArtifactError,
} from "../infrastructure/tracking-run/errors.js";
import type { CliExecutionResult } from "../infrastructure/tracking-run/execution-result.js";
import { NotificationSettlementFailureError } from "../infrastructure/tracking-run/notification-settlement.js";
import { isPublicBoundaryViolation } from "../infrastructure/tracking-run/public-boundary-error.js";
import { reportCliFailure } from "../infrastructure/tracking-run/public-failure-boundary.js";
import { type RunStage } from "../publication/run-report.js";
import { UnreachableError } from "../util/index.js";
import { parseCliArguments } from "./command.js";
import { createDefaultCliApplication } from "./composition-root.js";
import { runRuntimeRecoveryEntrypointV1 } from "./runtime-recovery-entrypoint-v1.js";
import { runRuntimeRecoveryEntrypointV2 } from "./runtime-recovery-entrypoint-v2.js";

const DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE = "VOICEVOX_TASK_TRACKER_DIAGNOSTICS_PATH";

Error.stackTraceLimit = 100;
process.setSourceMapsEnabled(true);

function topLevelDiagnosticStage(command: CliCommand): RunStage | "unknown" {
  switch (command.kind) {
    case "resolve-discord-delivery":
      return "state_persistence";
    case "notify-operations":
      return "discord";
    case "report-workflow":
      return "artifact";
    case "daily":
    case "dry-run":
    case "backfill":
    case "collect-analyze":
    case "run-sequential":
    case "run-stage":
    case "route-stage":
    case "runtime-recovery-v2":
    case "verify-state":
    case "verify-checkpoint":
    case "verify-runtime-recovery":
    case "inspect-run-state":
    case "verify-receipt-chain":
    case "report-failure":
    case "help":
      return "unknown";
    default:
      throw new UnreachableError(command);
  }
}

function writeFailureDiagnostics(result: CliExecutionResult): void {
  if (result.exitCode === 0) {
    return;
  }
  for (const diagnostic of result.result.report.diagnostics) {
    process.stderr.write(`${diagnostic}\n`);
  }
}

function safeTopLevelMessage(error: unknown): string {
  if (
    error instanceof CliCodexAuthenticationError ||
    error instanceof CliUsageError ||
    error instanceof CliCredentialsError ||
    error instanceof CliExecutableError ||
    error instanceof CliWorkflowArtifactError ||
    error instanceof NotificationSettlementFailureError
  ) {
    return error.message;
  }
  return "tracker:runの実行に失敗しました";
}

function isMainModule(moduleUrl: string, executablePath: string | undefined): boolean {
  return executablePath != null && pathToFileURL(executablePath).href === moduleUrl;
}

function writeDiagnosticsTopLevelError(error: unknown): void {
  if (error instanceof DiagnosticsError) {
    process.stderr.write(`${error.message}\n`);
    return;
  }
  process.stderr.write("diagnostics CLIの実行に失敗しました\n");
}

/** tracker-run共通entryからCLIを実行する。 */
export async function runTrackerCliMain(args: readonly string[]): Promise<number> {
  if (process.env["VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V2"] === "2") {
    if (args.length !== 0) {
      throw new TypeError("V2回復entrypointにCLI引数は指定できません");
    }
    const bundleRoot = process.env["VOICEVOX_RUNTIME_BUNDLE_ROOT"];
    if (bundleRoot == null || bundleRoot.length === 0) {
      throw new TypeError("V2回復entrypointのruntime rootがありません");
    }
    await runRuntimeRecoveryEntrypointV2(process.cwd(), bundleRoot);
    return 0;
  }
  if (process.env["VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V1"] === "1") {
    if (args.length !== 0) {
      throw new TypeError("V1回復entrypointにCLI引数は指定できません");
    }
    const bundleRoot = process.env["VOICEVOX_RUNTIME_BUNDLE_ROOT"];
    if (bundleRoot == null || bundleRoot.length === 0) {
      throw new TypeError("V1回復entrypointのruntime rootがありません");
    }
    await runRuntimeRecoveryEntrypointV1(process.cwd(), bundleRoot);
    return 0;
  }
  if (args[0] === "diagnostics") {
    const { runDiagnosticsCli } = await import("../diagnostics/cli.js");
    return runDiagnosticsCli(args.slice(1), process.env);
  }
  const invocationId = randomUUID();
  let stage: RunStage | "unknown" = "unknown";
  let command = args[0] ?? "unknown";
  let parsedCommand: CliCommand | undefined;
  let recorder: DiagnosticsJsonlRecorder | undefined;
  let result: CliExecutionResult | undefined;
  let failure: unknown;
  try {
    const diagnosticsPath = process.env[DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE];
    if (diagnosticsPath != null) {
      recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    }
    parsedCommand = parseCliArguments(args);
    command = parsedCommand.kind;
    stage = topLevelDiagnosticStage(parsedCommand);
    const executionResult = await createDefaultCliApplication(recorder).run(args, invocationId);
    result = executionResult;
    writeFailureDiagnostics(executionResult);
    if (executionResult.exitCode !== 0) {
      failure = await reportCliFailure(
        parsedCommand,
        invocationId,
        new Error("追跡runが失敗結果を返しました"),
        executionResult,
        recorder,
      );
    }
  } catch (error: unknown) {
    failure = await reportCliFailure(parsedCommand, invocationId, error, result, recorder);
  } finally {
    if (recorder != null) {
      try {
        await recorder.close();
      } catch (error: unknown) {
        failure =
          failure == null
            ? error
            : new AggregateError([failure, error], "CLI実行と診断recorderのcloseに失敗しました", {
                cause: failure,
              });
      }
    }
  }
  const githubOutputPath = process.env["GITHUB_OUTPUT"];
  if (githubOutputPath != null && command === "collect-analyze") {
    const publicBoundaryConfirmed =
      failure != null
        ? isPublicBoundaryViolation(failure)
        : result?.command === "collect-analyze" &&
          result.result.report.status === "failure" &&
          result.result.report.failureKind === "public_boundary";
    await appendFile(
      githubOutputPath,
      `public_boundary_status=${publicBoundaryConfirmed ? "confirmed" : "not_confirmed"}\n`,
      "utf8",
    );
  }
  if (failure != null) {
    if (
      githubOutputPath != null &&
      command === "settle-notifications" &&
      failure instanceof NotificationSettlementFailureError
    ) {
      const outcome = failure.outcome;
      await appendFile(
        githubOutputPath,
        [
          `notification_settlement_kind=${outcome.kind}`,
          ...(outcome.kind === "structural_failure" || outcome.kind === "state_unconfirmed"
            ? [
                `notification_marker_phase=${outcome.markerPhase}`,
                `notification_failed_operation_effect_certainty=${outcome.kind === "structural_failure" ? outcome.failedOperationEffectCertainty : outcome.effectCertainty}`,
                `notification_cas_outcome=${outcome.casOutcome}`,
                `notification_http_outcome=${outcome.httpOutcome}`,
                `notification_recovery_disposition=${outcome.recoveryDisposition}`,
                `notification_state_revision=${outcome.stateRevision}`,
                ...(outcome.lastReceipt == null
                  ? []
                  : [`notification_last_receipt_digest=${outcome.lastReceipt.receiptDigest}`]),
              ]
            : []),
        ].join("\n") + "\n",
        "utf8",
      );
    }
    if (
      githubOutputPath != null &&
      command !== "collect-analyze" &&
      isPublicBoundaryViolation(failure)
    ) {
      await appendFile(githubOutputPath, "public_boundary_violation=true\n", "utf8");
    }
    process.stderr.write(`${safeTopLevelMessage(failure)}\n`);
    process.stderr.write(`${safeErrorDiagnostic(stage, failure)}\n`);
    return 1;
  }
  if (result == null) {
    throw new Error("CLI実行結果がありません");
  }
  return result.exitCode;
}

/** CLI実行入口の終了状態と診断失敗を処理する。 */
export async function runTrackerCliEntrypoint(args: readonly string[]): Promise<void> {
  try {
    process.exitCode = await runTrackerCliMain(args);
  } catch (error: unknown) {
    if (args[0] !== "diagnostics") {
      throw error;
    }
    writeDiagnosticsTopLevelError(error);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runTrackerCliEntrypoint(process.argv.slice(2));
}

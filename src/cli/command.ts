import { z } from "zod";
import type {
  BackfillCliCommand,
  CliCommand,
  CollectAnalyzeCliCommand,
  DailyCliCommand,
  DryRunCliCommand,
  InspectRunStateCliCommand,
  OnlineCommandFields,
  ReportFailureCliCommand,
  ReportWorkflowCliCommand,
  ResolveDiscordDeliveryCliCommand,
  RunSequentialCliCommand,
  VerifyCheckpointCliCommand,
  VerifyReceiptChainCliCommand,
  VerifyRuntimeRecoveryCliCommand,
  VerifyStateCliCommand,
} from "../infrastructure/tracking-run/command-input.js";
import {
  parseBackfillMode,
  parseNotificationAction,
  parseRepositoryFilter,
  parseSchedule,
} from "./command-online-options.js";
import {
  optionalSingleOption,
  parseOptions,
  singleOption,
  usageError,
  type ParsedOptions,
} from "./command-options.js";
import { parseNotifyOperations } from "./operations-alert-command.js";
import { parseRecoverRuntimeV2, parseRouteStage, parseRunStage } from "./split-stage-command.js";

const DEFAULT_CONFIG_PATH = "config.yml";
const DEFAULT_REPORT_DIRECTORY = "artifacts/run-reports";
const DEFAULT_ARTIFACT_DIRECTORY = "artifacts";
const DEFAULT_WORKFLOW_ARTIFACT_PATH = "artifacts/workflow/validated-run.cpk";
const DEFAULT_MANUAL_RESOLUTION_RECEIPT_PATH = "artifacts/workflow/manual-resolution-receipt.json";
const DEFAULT_COLLECT_ANALYZE_REPORT_PATH = `${DEFAULT_REPORT_DIRECTORY}/collect-analyze.json`;
const DEFAULT_WORKFLOW_REPORT_PATH = `${DEFAULT_REPORT_DIRECTORY}/workflow.json`;
const DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;
const deliveryIdSchema = z.string().regex(DELIVERY_ID_PATTERN);
const resolveDiscordDeliveryResolutionSchema = z.enum(["retry", "acknowledge"]);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const checkpointDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const attemptIdSchema = z.string().regex(/^attempt:v1:[0-9a-f]{64}$/u);
const stateRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);

function requiredSingleOption(options: ParsedOptions, name: string, commandName: string): string {
  const value = optionalSingleOption(options, name);
  if (value == null) {
    throw usageError(`${commandName}には${name}が必要です`);
  }
  return value;
}

function assertDifferentOutputPaths(reportPath: string, artifactPath: string): void {
  if (reportPath === artifactPath) {
    throw usageError("--reportと--artifactには異なるパスを指定してください");
  }
}

function parseOnlineFields(
  commandName: "daily" | "dry-run" | "backfill" | "collect-analyze",
  options: ParsedOptions,
): OnlineCommandFields {
  return Object.freeze({
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    reportPath: singleOption(
      options,
      "--report",
      `${DEFAULT_REPORT_DIRECTORY}/${commandName}.json`,
    ),
    schedule: parseSchedule(options),
  });
}

function parseDaily(args: readonly string[]): DailyCliCommand {
  const options = parseOptions(
    args,
    new Set(["--config", "--notification-action", "--report", "--scheduled-for"]),
  );
  return Object.freeze({
    kind: "daily",
    ...parseOnlineFields("daily", options),
    notificationAction: parseNotificationAction(options),
  });
}

function parseDryRun(args: readonly string[]): DryRunCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--config", "--report", "--scheduled-for"]),
  );
  const fields = parseOnlineFields("dry-run", options);
  const artifactPath = singleOption(
    options,
    "--artifact",
    `${DEFAULT_ARTIFACT_DIRECTORY}/dry-run.json`,
  );
  assertDifferentOutputPaths(fields.reportPath, artifactPath);
  return Object.freeze({
    kind: "dry-run",
    ...fields,
    artifactPath,
  });
}

function parseBackfill(args: readonly string[]): BackfillCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--mode",
      "--notification-action",
      "--report",
      "--repository",
      "--scheduled-for",
    ]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  return Object.freeze({
    kind: "backfill",
    ...parseOnlineFields("backfill", options),
    notificationAction: parseNotificationAction(options),
    mode,
    repositoryFilter,
  });
}

function parseCollectAnalyze(args: readonly string[]): CollectAnalyzeCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--artifact",
      "--config",
      "--mode",
      "--notification-action",
      "--report",
      "--repository",
      "--sandbox-context",
      "--scheduled-for",
    ]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  const sandboxContextPath = optionalSingleOption(options, "--sandbox-context");
  if (sandboxContextPath != null && mode !== "none") {
    throw usageError("sandbox解析にbackfill範囲は指定できません");
  }
  const fields = parseOnlineFields("collect-analyze", options);
  const artifactPath = singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH);
  assertDifferentOutputPaths(fields.reportPath, artifactPath);
  return Object.freeze({
    kind: "collect-analyze",
    ...fields,
    notificationAction: parseNotificationAction(options),
    mode,
    repositoryFilter,
    artifactPath,
    sandboxContextPath,
  });
}

function parseRunSequential(args: readonly string[]): RunSequentialCliCommand {
  const command = parseBackfill(args);
  return Object.freeze({
    ...command,
    kind: "run-sequential",
    reportPath:
      command.reportPath === `${DEFAULT_REPORT_DIRECTORY}/backfill.json`
        ? `${DEFAULT_REPORT_DIRECTORY}/run-sequential.json`
        : command.reportPath,
  });
}

function parseResolveDiscordDelivery(args: readonly string[]): ResolveDiscordDeliveryCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--run-id",
      "--checkpoint-digest",
      "--delivery-id",
      "--attempt-id",
      "--notification-key",
      "--resolution",
      "--receipt",
    ]),
  );
  const runId = runIdSchema.safeParse(
    requiredSingleOption(options, "--run-id", "resolve-discord-delivery"),
  );
  const checkpointDigest = checkpointDigestSchema.safeParse(
    requiredSingleOption(options, "--checkpoint-digest", "resolve-discord-delivery"),
  );
  const attemptId = attemptIdSchema.safeParse(
    requiredSingleOption(options, "--attempt-id", "resolve-discord-delivery"),
  );
  const notificationKeys = options.get("--notification-key");
  if (
    !runId.success ||
    !checkpointDigest.success ||
    !attemptId.success ||
    notificationKeys == null ||
    notificationKeys.length === 0 ||
    notificationKeys.some((key) => key.length === 0) ||
    new Set(notificationKeys).size !== notificationKeys.length
  ) {
    throw usageError("手動解決には正しいrun、checkpoint、試行、notification keyが必要です");
  }
  const deliveryIdSource = requiredSingleOption(
    options,
    "--delivery-id",
    "resolve-discord-delivery",
  );
  const deliveryIdResult = deliveryIdSchema.safeParse(deliveryIdSource);
  if (!deliveryIdResult.success) {
    throw usageError(
      "--delivery-idにはdiscord-digest:v1のdelivery IDを指定してください",
      deliveryIdResult.error,
    );
  }
  const resolutionResult = resolveDiscordDeliveryResolutionSchema.safeParse(
    requiredSingleOption(options, "--resolution", "resolve-discord-delivery"),
  );
  if (!resolutionResult.success) {
    throw usageError(
      "--resolutionにはretryまたはacknowledgeを指定してください",
      resolutionResult.error,
    );
  }
  return Object.freeze({
    kind: "resolve-discord-delivery",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    runId: runId.data,
    checkpointDigest: checkpointDigest.data,
    deliveryId: deliveryIdResult.data,
    attemptId: attemptId.data,
    notificationKeys: Object.freeze([...notificationKeys]),
    resolution: resolutionResult.data,
    receiptPath: singleOption(options, "--receipt", DEFAULT_MANUAL_RESOLUTION_RECEIPT_PATH),
  });
}

function parseWorkflowRunAttempt(options: ParsedOptions): number {
  const source = requiredSingleOption(options, "--run-attempt", "report-workflow");
  const value = Number.parseInt(source, 10);
  if (!/^\d+$/u.test(source) || !Number.isSafeInteger(value) || value < 1) {
    throw usageError("--run-attemptには1以上の整数を指定してください");
  }
  return value;
}

function parseWorkflowRunId(options: ParsedOptions): string {
  const value = requiredSingleOption(options, "--run-id", "report-workflow");
  if (!/^[1-9]\d*$/u.test(value)) {
    throw usageError("--run-idには1以上の整数を指定してください");
  }
  return value;
}

function parseReportWorkflow(args: readonly string[]): ReportWorkflowCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--actions-jobs",
      "--collect-report",
      "--completion-directory",
      "--effect-target",
      "--failure-directory",
      "--output",
      "--run-attempt",
      "--run-id",
      "--tracking-run-id",
    ]),
  );
  const collectAnalyzeReportPath = singleOption(
    options,
    "--collect-report",
    DEFAULT_COLLECT_ANALYZE_REPORT_PATH,
  );
  const outputPath = singleOption(options, "--output", DEFAULT_WORKFLOW_REPORT_PATH);
  if (collectAnalyzeReportPath === outputPath) {
    throw usageError("--collect-reportと--outputには異なるパスを指定してください");
  }
  const trackingRunId = optionalSingleOption(options, "--tracking-run-id");
  if (trackingRunId != null && !/^tracker-run:[0-9a-f]{64}$/u.test(trackingRunId)) {
    throw usageError("--tracking-run-idが不正です");
  }
  const effectTarget = requiredSingleOption(options, "--effect-target", "report-workflow");
  if (effectTarget !== "production" && effectTarget !== "sandbox" && effectTarget !== "recording") {
    throw usageError("--effect-targetが不正です");
  }
  return Object.freeze({
    kind: "report-workflow",
    actionsJobsPath: requiredSingleOption(options, "--actions-jobs", "report-workflow"),
    collectAnalyzeReportPath,
    completionDirectory: singleOption(options, "--completion-directory", "artifacts/workflow/runs"),
    failureDirectory: singleOption(options, "--failure-directory", "artifacts/workflow/failures"),
    outputPath,
    workflowRunId: parseWorkflowRunId(options),
    workflowRunAttempt: parseWorkflowRunAttempt(options),
    trackingRunId,
    effectTarget,
  });
}

function parseVerifyState(args: readonly string[]): VerifyStateCliCommand {
  const options = parseOptions(
    args,
    new Set(["--state-directory", "--state-revision", "--config"]),
  );
  const stateRevision = stateRevisionSchema.safeParse(
    requiredSingleOption(options, "--state-revision", "verify-state"),
  );
  if (!stateRevision.success) {
    throw usageError("--state-revisionには40桁のGit commit SHAを指定してください");
  }
  return Object.freeze({
    kind: "verify-state",
    stateDirectory: requiredSingleOption(options, "--state-directory", "verify-state"),
    stateRevision: stateRevision.data,
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
  });
}

function parseVerifyCheckpoint(args: readonly string[]): VerifyCheckpointCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config"]));
  return Object.freeze({
    kind: "verify-checkpoint",
    artifactPath: singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH),
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
  });
}

function parseVerifyRuntimeRecovery(args: readonly string[]): VerifyRuntimeRecoveryCliCommand {
  const options = parseOptions(args, new Set(["--input", "--bundle-root"]));
  return Object.freeze({
    kind: "verify-runtime-recovery",
    inputPath: requiredSingleOption(options, "--input", "verify-runtime-recovery"),
    bundleRoot: optionalSingleOption(options, "--bundle-root"),
  });
}

function parseInspectRunState(args: readonly string[]): InspectRunStateCliCommand {
  const options = parseOptions(
    args,
    new Set(["--config", "--state-ref", "--run-id", "--state-revision"]),
  );
  const runId = optionalSingleOption(options, "--run-id");
  const revision = optionalSingleOption(options, "--state-revision");
  if ((runId == null) !== (revision == null)) {
    throw usageError("--run-idと--state-revisionは両方指定してください");
  }
  if (runId != null && !/^tracker-run:[0-9a-f]{64}$/u.test(runId)) {
    throw usageError("--run-idが不正です");
  }
  if (revision != null && !/^[0-9a-f]{40}$/u.test(revision)) {
    throw usageError("--state-revisionが不正です");
  }
  const recoveryIntent: InspectRunStateCliCommand["recoveryIntent"] =
    runId == null || revision == null
      ? { kind: "start_new" }
      : { kind: "retry_run", runId, exactStateRevision: revision };
  return Object.freeze({
    kind: "inspect-run-state",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    stateRef: optionalSingleOption(options, "--state-ref"),
    recoveryIntent,
  });
}

function parseVerifyReceiptChain(args: readonly string[]): VerifyReceiptChainCliCommand {
  const options = parseOptions(args, new Set(["--input"]));
  return Object.freeze({
    kind: "verify-receipt-chain",
    inputPath: requiredSingleOption(options, "--input", "verify-receipt-chain"),
  });
}

function parseReportFailure(args: readonly string[]): ReportFailureCliCommand {
  const options = parseOptions(args, new Set(["--input", "--output"]));
  return Object.freeze({
    kind: "report-failure",
    inputPath: requiredSingleOption(options, "--input", "report-failure"),
    outputPath: requiredSingleOption(options, "--output", "report-failure"),
  });
}

/** process argvからサブコマンドとoptionを検証して取り出す。 */
export function parseCliArguments(args: readonly string[]): CliCommand {
  const subcommand = args[0];
  if (subcommand == null) {
    throw usageError("サブコマンドが必要です");
  }
  if (subcommand === "--help" || subcommand === "help") {
    if (args.length !== 1) {
      throw usageError("helpに追加の引数は指定できません");
    }
    return Object.freeze({
      kind: "help",
    });
  }
  const options = args.slice(1);
  switch (subcommand) {
    case "run-sequential":
      return parseRunSequential(options);
    case "run-stage":
      return parseRunStage(options);
    case "route-stage":
      return parseRouteStage(options);
    case "runtime-recovery-v2":
      return parseRecoverRuntimeV2(options);
    case "daily":
      return parseDaily(options);
    case "dry-run":
      return parseDryRun(options);
    case "backfill":
      return parseBackfill(options);
    case "collect-analyze":
      return parseCollectAnalyze(options);
    case "resolve-discord-delivery":
      return parseResolveDiscordDelivery(options);
    case "notify-operations":
      return parseNotifyOperations(options);
    case "report-workflow":
      return parseReportWorkflow(options);
    case "verify-state":
      return parseVerifyState(options);
    case "verify-checkpoint":
      return parseVerifyCheckpoint(options);
    case "verify-runtime-recovery":
      return parseVerifyRuntimeRecovery(options);
    case "inspect-run-state":
      return parseInspectRunState(options);
    case "verify-receipt-chain":
      return parseVerifyReceiptChain(options);
    case "report-failure":
      return parseReportFailure(options);
    default:
      throw usageError(`未対応のサブコマンドです。対象: ${subcommand}`);
  }
}

import { pathToFileURL } from "node:url";

import { z } from "zod";

import { DiagnosticsError } from "../diagnostics/errors.js";
import { createDiagnosticsRecorder } from "../diagnostics/recorder.js";
import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { UnreachableError } from "../util/index.js";
import { type CliExecutionResult } from "./application.js";
import { notificationActionSchema, parseCliArguments, type CliCommand } from "./command.js";
import { createDefaultCliApplication } from "./composition-root.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import {
  CliCodexAuthenticationError,
  CliCredentialsError,
  CliExecutableError,
  CliUsageError,
  CliWorkflowArtifactError,
} from "./errors.js";
import { type RunStage } from "./run-report.js";

const DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE = "VOICEVOX_TASK_TRACKER_DIAGNOSTICS_PATH";

Error.stackTraceLimit = 100;
process.setSourceMapsEnabled(true);

const REPOSITORY_FILTER_SEPARATOR = ",";

type TrackerRunOptionName =
  | "--backfill"
  | "--config"
  | "--notification-action"
  | "--repository-filter"
  | "--report"
  | "--scheduled-for";

const trackerRunOptionsSchema = z.strictObject({
  "--backfill": z.enum(["none", "linked", "all-open"]),
  "--config": z.string().min(1).optional(),
  "--notification-action": notificationActionSchema.optional(),
  "--repository-filter": z.string().min(1).optional(),
  "--report": z.string().min(1).optional(),
  "--scheduled-for": z.string().min(1).optional(),
});

type TrackerRunOptions = z.output<typeof trackerRunOptionsSchema>;

function parseTrackerRunOptions(args: readonly string[]): TrackerRunOptions {
  const options: Partial<Record<TrackerRunOptionName, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name !== "--backfill" &&
      name !== "--config" &&
      name !== "--notification-action" &&
      name !== "--repository-filter" &&
      name !== "--report" &&
      name !== "--scheduled-for"
    ) {
      throw new CliUsageError(`未対応のtracker:run optionです。対象: ${name ?? ""}`, {});
    }
    if (value == null || value.startsWith("--") || value.length === 0) {
      throw new CliUsageError(`${name}には値が必要です`, {});
    }
    if (Object.hasOwn(options, name)) {
      throw new CliUsageError(`${name}は1回だけ指定してください`, {});
    }
    options[name] = value;
  }
  const result = trackerRunOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new CliUsageError("tracker:run optionが不正です", {
      cause: result.error,
    });
  }
  return result.data;
}

function appendOption(
  args: string[],
  options: TrackerRunOptions,
  trackerRunName: TrackerRunOptionName,
  cliName: string,
): void {
  const value = options[trackerRunName];
  if (value != null) {
    args.push(cliName, value);
  }
}

function parseRepositoryFilter(value: string): readonly string[] {
  const repositories = value
    .split(REPOSITORY_FILTER_SEPARATOR)
    .map((repository) => repository.trim());
  if (repositories.some((repository) => repository.length === 0)) {
    throw new CliUsageError("--repository-filterに空のrepositoryは指定できません", {});
  }
  return Object.freeze(repositories);
}

/** workflow向けoptionを日次またはbackfillサブコマンドへ変換する。 */
export function createTrackerRunCliArguments(args: readonly string[]): readonly string[] {
  if (
    args[0] === "eval" ||
    args[0] === "collect-analyze" ||
    args[0] === "persist-state" ||
    args[0] === "build-pages" ||
    args[0] === "notify-discord" ||
    args[0] === "notify-operations" ||
    args[0] === "report-workflow" ||
    args[0] === "verify-state"
  ) {
    const command = parseCliArguments(args);
    if (command.kind !== args[0]) {
      throw new TypeError("workflowサブコマンドの解析結果が一致しません");
    }
    return Object.freeze([...args]);
  }
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze(["help"]);
  }
  if (args.includes("--help")) {
    throw new CliUsageError("--helpは単独で指定してください", {});
  }
  const options = parseTrackerRunOptions(args);
  const backfillMode = options["--backfill"];
  const cliArguments = backfillMode === "none" ? ["daily"] : ["backfill", "--mode", backfillMode];
  appendOption(cliArguments, options, "--config", "--config");
  appendOption(cliArguments, options, "--notification-action", "--notification-action");
  appendOption(cliArguments, options, "--report", "--report");
  appendOption(cliArguments, options, "--scheduled-for", "--scheduled-for");

  const repositoryFilter = options["--repository-filter"];
  if (repositoryFilter != null) {
    if (backfillMode === "none") {
      throw new CliUsageError("--repository-filterはlinkedまたはall-openで指定してください", {});
    }
    for (const repository of parseRepositoryFilter(repositoryFilter)) {
      cliArguments.push("--repository", repository);
    }
  }

  const command = parseCliArguments(cliArguments);
  if (
    (backfillMode === "none" && command.kind !== "daily") ||
    (backfillMode !== "none" && command.kind !== "backfill")
  ) {
    throw new TypeError("tracker:runの変換結果が実行modeと一致しません");
  }
  return Object.freeze(cliArguments);
}

/** workflow向けoptionを検証し、既存CLIの実行境界へ渡す。 */
export async function runTrackerCommand<Result>(
  args: readonly string[],
  runCli: (args: readonly string[]) => Promise<Result>,
): Promise<Result> {
  return runCli(createTrackerRunCliArguments(args));
}

function topLevelDiagnosticStage(command: CliCommand): RunStage | "unknown" {
  switch (command.kind) {
    case "persist-state":
      return "state_persistence";
    case "build-pages":
      return "pages";
    case "notify-discord":
    case "notify-operations":
      return "discord";
    case "report-workflow":
      return "artifact";
    case "daily":
    case "dry-run":
    case "backfill":
    case "collect-analyze":
    case "replay":
    case "eval":
    case "verify-state":
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
    error instanceof CliWorkflowArtifactError
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

async function recordTopLevelError(
  recorder: DiagnosticsJsonlRecorder | undefined,
  stage: RunStage | "unknown",
  command: string,
  error: unknown,
): Promise<unknown> {
  if (recorder == null) {
    return error;
  }
  try {
    await recorder.append({
      event: "cli.unhandled_error",
      details: {
        command,
        stage,
        invocationId: `tracker-cli:${process.pid.toString()}`,
      },
      error,
    });
  } catch (diagnosticsError: unknown) {
    return new AggregateError(
      [error, diagnosticsError],
      "CLI未処理エラーと診断記録に失敗しました",
      {
        cause: error,
      },
    );
  }
  return error;
}

/** tracker-run共通entryからCLIを実行する。 */
export async function runTrackerCliMain(args: readonly string[]): Promise<number> {
  if (args[0] === "diagnostics") {
    const { runDiagnosticsCli } = await import("../diagnostics/cli.js");
    return runDiagnosticsCli(args.slice(1), process.env);
  }
  let stage: RunStage | "unknown" = "unknown";
  let command = args[0] ?? "unknown";
  let recorder: DiagnosticsJsonlRecorder | undefined;
  let result: CliExecutionResult | undefined;
  let failure: unknown;
  try {
    const diagnosticsPath = process.env[DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE];
    if (diagnosticsPath != null) {
      recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    }
    const executionResult = await runTrackerCommand(args, (commandArgs) => {
      const parsedCommand = parseCliArguments(commandArgs);
      command = parsedCommand.kind;
      stage = topLevelDiagnosticStage(parsedCommand);
      return createDefaultCliApplication(recorder).run(commandArgs);
    });
    result = executionResult;
    writeFailureDiagnostics(executionResult);
  } catch (error: unknown) {
    failure = await recordTopLevelError(recorder, stage, command, error);
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
  if (failure != null) {
    process.stderr.write(`${safeTopLevelMessage(failure)}\n`);
    process.stderr.write(`${safeErrorDiagnostic(stage, failure)}\n`);
    return 1;
  }
  if (result == null) {
    throw new Error("CLI実行結果がありません");
  }
  return result.exitCode;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
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

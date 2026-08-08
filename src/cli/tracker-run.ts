import { pathToFileURL } from "node:url";

import { z } from "zod";

import { UnreachableError } from "../util/index.js";
import { type CliExecutionResult } from "./application.js";
import { parseCliArguments, type CliCommand } from "./command.js";
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

const REPOSITORY_FILTER_SEPARATOR = ",";

type TrackerRunOptionName =
  "--backfill" | "--config" | "--repository-filter" | "--report" | "--scheduled-for";

const trackerRunOptionsSchema = z.strictObject({
  "--backfill": z.enum(["none", "linked", "all-open"]),
  "--config": z.string().min(1).optional(),
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
    args[0] === "report-workflow"
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

if (isMainModule(import.meta.url, process.argv[1])) {
  let stage: RunStage | "unknown" = "unknown";
  try {
    const result = await runTrackerCommand(process.argv.slice(2), (args) => {
      stage = topLevelDiagnosticStage(parseCliArguments(args));
      return createDefaultCliApplication().run(args);
    });
    writeFailureDiagnostics(result);
    process.exitCode = result.exitCode;
  } catch (error: unknown) {
    process.stderr.write(`${safeTopLevelMessage(error)}\n`);
    process.stderr.write(`${safeErrorDiagnostic(stage, error)}\n`);
    process.exitCode = 1;
  }
}

import {
  createUtcIsoDateTime,
  type OperationsAlertKind,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { CliUsageError } from "./errors.js";
import { type WorkflowJobResult, type WorkflowJobResults } from "./workflow-run-report.js";

const DEFAULT_CONFIG_PATH = "config.yml";
const DEFAULT_REPORT_DIRECTORY = "artifacts/run-reports";
const DEFAULT_ARTIFACT_DIRECTORY = "artifacts";
const DEFAULT_WORKFLOW_ARTIFACT_PATH = "artifacts/workflow/validated-run.json";
const DEFAULT_PAGES_OUTPUT_DIRECTORY = "artifacts/workflow/pages";
const DEFAULT_COLLECT_ANALYZE_REPORT_PATH = `${DEFAULT_REPORT_DIRECTORY}/collect-analyze.json`;
const DEFAULT_WORKFLOW_REPORT_PATH = `${DEFAULT_REPORT_DIRECTORY}/workflow.json`;
const REPOSITORY_FILTER_PATTERN = /^VOICEVOX\/[A-Za-z0-9._-]+$/u;

/** runの予定時刻を現在時刻または明示値から決める指定。 */
export type CliSchedule =
  | Readonly<{
      kind: "current_time";
    }>
  | Readonly<{
      kind: "specified";
      value: UtcIsoDateTime;
    }>;

type OnlineCommandFields = Readonly<{
  configPath: string;
  reportPath: string;
  schedule: CliSchedule;
}>;

/** 通常の日次実行を表すCLI入力。 */
export type DailyCliCommand = OnlineCommandFields &
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
  Readonly<{
    kind: "backfill";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
  }>;

/** workflowの収集と判定だけを行うCLI入力。 */
export type CollectAnalyzeCliCommand = OnlineCommandFields &
  Readonly<{
    kind: "collect-analyze";
    mode: "none" | "linked" | "all-open";
    repositoryFilter: readonly string[];
    artifactPath: string;
  }>;

/** 検証済みworkflow artifactをstate branchへ保存するCLI入力。 */
export type PersistStateCliCommand = Readonly<{
  kind: "persist-state";
  configPath: string;
  artifactPath: string;
}>;

/** 検証済みworkflow artifactからPages用データを生成するCLI入力。 */
export type BuildPagesCliCommand = Readonly<{
  kind: "build-pages";
  configPath: string;
  artifactPath: string;
  outputDirectory: string;
}>;

/** Pagesのdeploy成功後にDiscord通知を送るCLI入力。 */
export type NotifyDiscordCliCommand = Readonly<{
  kind: "notify-discord";
  configPath: string;
  artifactPath: string;
  pagesUrl: string;
}>;

/** workflow障害時に運用障害通知だけを送るCLI入力。 */
export type NotifyOperationsCliCommand = Readonly<{
  kind: "notify-operations";
  configPath: string;
  incidentKind: OperationsAlertKind;
  incidentId: string;
  occurredAt: UtcIsoDateTime;
  retryAttempts: number;
}>;

/** workflow全体のjob結果をCLI reportへ統合する入力。 */
export type ReportWorkflowCliCommand = Readonly<{
  kind: "report-workflow";
  collectAnalyzeReportPath: string;
  outputPath: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  jobResults: WorkflowJobResults;
}>;

/** 指定した永続stateディレクトリを検証するCLI入力。 */
export type VerifyStateCliCommand = Readonly<{
  kind: "verify-state";
  stateDirectory: string;
}>;

/** replayへ渡すfixtureまたは過去stateの入力元。 */
export type ReplaySource =
  | Readonly<{
      kind: "fixture";
      path: string;
    }>
  | Readonly<{
      kind: "state";
      path: string;
    }>;

/** 保存済み入力をネットワークなしで再判定するCLI入力。 */
export type ReplayCliCommand = Readonly<{
  kind: "replay";
  source: ReplaySource;
  artifactPath: string;
  reportPath: string;
  schedule: CliSchedule;
}>;

/** golden fixtureを比較するCLI入力。 */
export type EvalCliCommand = Readonly<{
  kind: "eval";
  fixturesPath: string;
  artifactPath: string;
  reportPath: string;
  schedule: CliSchedule;
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
  | CollectAnalyzeCliCommand
  | PersistStateCliCommand
  | BuildPagesCliCommand
  | NotifyDiscordCliCommand
  | NotifyOperationsCliCommand
  | ReportWorkflowCliCommand
  | VerifyStateCliCommand
  | ReplayCliCommand
  | EvalCliCommand
  | HelpCliCommand;

type ParsedOptions = ReadonlyMap<string, readonly string[]>;

function usageError(message: string, cause?: unknown): CliUsageError {
  return new CliUsageError(message, cause == null ? {} : { cause });
}

function parseOptions(args: readonly string[], allowedOptions: ReadonlySet<string>): ParsedOptions {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    assertNonNullable(name, "CLI option名を取得できませんでした");
    if (!name.startsWith("--") || !allowedOptions.has(name)) {
      throw usageError(`未対応のoptionです。対象: ${name}`);
    }
    if (value == null || value.startsWith("--")) {
      throw usageError(`${name}には値が必要です`);
    }
    const existing = values.get(name) ?? [];
    values.set(name, [...existing, value]);
  }
  return values;
}

function singleOption(options: ParsedOptions, name: string, fallback: string): string {
  const values = options.get(name);
  if (values == null) {
    return fallback;
  }
  if (values.length !== 1) {
    throw usageError(`${name}は1回だけ指定してください`);
  }
  const value = values[0];
  assertNonNullable(value, `${name}の値を取得できませんでした`);
  if (value.length === 0) {
    throw usageError(`${name}に空文字は指定できません`);
  }
  return value;
}

function optionalSingleOption(options: ParsedOptions, name: string): string | undefined {
  const values = options.get(name);
  if (values == null) {
    return undefined;
  }
  if (values.length !== 1) {
    throw usageError(`${name}は1回だけ指定してください`);
  }
  const value = values[0];
  assertNonNullable(value, `${name}の値を取得できませんでした`);
  if (value.length === 0) {
    throw usageError(`${name}に空文字は指定できません`);
  }
  return value;
}

function requiredSingleOption(options: ParsedOptions, name: string, commandName: string): string {
  const value = optionalSingleOption(options, name);
  if (value == null) {
    throw usageError(`${commandName}には${name}が必要です`);
  }
  return value;
}

function parseSchedule(options: ParsedOptions): CliSchedule {
  const value = optionalSingleOption(options, "--scheduled-for");
  if (value == null) {
    return Object.freeze({
      kind: "current_time",
    });
  }
  try {
    return Object.freeze({
      kind: "specified",
      value: createUtcIsoDateTime(value),
    });
  } catch (error: unknown) {
    throw usageError("--scheduled-forにはタイムゾーン付きISO 8601日時を指定してください", error);
  }
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
  const options = parseOptions(args, new Set(["--config", "--report", "--scheduled-for"]));
  return Object.freeze({
    kind: "daily",
    ...parseOnlineFields("daily", options),
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

function parseBackfillMode(value: string): BackfillCliCommand["mode"] {
  switch (value) {
    case "none":
    case "linked":
    case "all-open":
      return value;
    default:
      throw usageError("--modeにはnone、linked、all-openのいずれかを指定してください");
  }
}

function parseRepositoryFilter(options: ParsedOptions): readonly string[] {
  const repositoryFilter = options.get("--repository") ?? [];
  for (const repository of repositoryFilter) {
    if (!REPOSITORY_FILTER_PATTERN.test(repository)) {
      throw usageError("--repositoryにはVOICEVOX配下のowner/name形式を指定してください");
    }
  }
  if (new Set(repositoryFilter).size !== repositoryFilter.length) {
    throw usageError("--repositoryを重複して指定できません");
  }
  return Object.freeze([...repositoryFilter].sort());
}

function parseBackfill(args: readonly string[]): BackfillCliCommand {
  const options = parseOptions(
    args,
    new Set(["--config", "--mode", "--report", "--repository", "--scheduled-for"]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  return Object.freeze({
    kind: "backfill",
    ...parseOnlineFields("backfill", options),
    mode,
    repositoryFilter,
  });
}

function parseCollectAnalyze(args: readonly string[]): CollectAnalyzeCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--config", "--mode", "--report", "--repository", "--scheduled-for"]),
  );
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  const fields = parseOnlineFields("collect-analyze", options);
  const artifactPath = singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH);
  assertDifferentOutputPaths(fields.reportPath, artifactPath);
  return Object.freeze({
    kind: "collect-analyze",
    ...fields,
    mode,
    repositoryFilter,
    artifactPath,
  });
}

function parsePersistState(args: readonly string[]): PersistStateCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config"]));
  return Object.freeze({
    kind: "persist-state",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    artifactPath: singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH),
  });
}

function parseBuildPages(args: readonly string[]): BuildPagesCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config", "--output"]));
  return Object.freeze({
    kind: "build-pages",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    artifactPath: singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH),
    outputDirectory: singleOption(options, "--output", DEFAULT_PAGES_OUTPUT_DIRECTORY),
  });
}

function parsePagesUrl(options: ParsedOptions): string {
  const value = optionalSingleOption(options, "--pages-url");
  if (value == null) {
    throw usageError("notify-discordにはPages deploy成功時の--pages-urlが必要です");
  }
  if (!URL.canParse(value)) {
    throw usageError("--pages-urlには有効なHTTPS URLを指定してください");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw usageError("--pages-urlには認証情報とfragmentを含まないHTTPS URLを指定してください");
  }
  return url.href;
}

function parseNotifyDiscord(args: readonly string[]): NotifyDiscordCliCommand {
  const options = parseOptions(args, new Set(["--artifact", "--config", "--pages-url"]));
  return Object.freeze({
    kind: "notify-discord",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    artifactPath: singleOption(options, "--artifact", DEFAULT_WORKFLOW_ARTIFACT_PATH),
    pagesUrl: parsePagesUrl(options),
  });
}

function parseNotifyOperations(args: readonly string[]): NotifyOperationsCliCommand {
  const options = parseOptions(
    args,
    new Set(["--config", "--incident-id", "--kind", "--occurred-at", "--retry-attempts"]),
  );
  const incidentKind = optionalSingleOption(options, "--kind");
  if (incidentKind !== "collection" && incidentKind !== "pages" && incidentKind !== "discord") {
    throw usageError("--kindにはcollection、pages、discordのいずれかを指定してください");
  }
  const incidentId = optionalSingleOption(options, "--incident-id");
  if (incidentId == null) {
    throw usageError("notify-operationsには--incident-idが必要です");
  }
  const occurredAtSource = optionalSingleOption(options, "--occurred-at");
  if (occurredAtSource == null) {
    throw usageError("notify-operationsには--occurred-atが必要です");
  }
  let occurredAt: UtcIsoDateTime;
  try {
    occurredAt = createUtcIsoDateTime(occurredAtSource);
  } catch (error: unknown) {
    throw usageError("--occurred-atにはタイムゾーン付きISO 8601日時を指定してください", error);
  }
  const retryAttemptsSource = singleOption(options, "--retry-attempts", "1");
  const retryAttempts = Number.parseInt(retryAttemptsSource, 10);
  if (
    !/^\d+$/u.test(retryAttemptsSource) ||
    !Number.isSafeInteger(retryAttempts) ||
    retryAttempts < 1
  ) {
    throw usageError("--retry-attemptsには1以上の整数を指定してください");
  }
  return Object.freeze({
    kind: "notify-operations",
    configPath: singleOption(options, "--config", DEFAULT_CONFIG_PATH),
    incidentKind,
    incidentId,
    occurredAt,
    retryAttempts,
  });
}

function parseWorkflowJobResult(options: ParsedOptions, name: string): WorkflowJobResult {
  const value = requiredSingleOption(options, name, "report-workflow");
  switch (value) {
    case "success":
    case "failure":
    case "cancelled":
    case "skipped":
      return value;
    default:
      throw usageError(
        `${name}にはsuccess、failure、cancelled、skippedのいずれかを指定してください`,
      );
  }
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
      "--build-pages-result",
      "--collect-analyze-result",
      "--collect-report",
      "--deploy-pages-result",
      "--notify-discord-result",
      "--notify-operations-result",
      "--output",
      "--persist-state-result",
      "--run-attempt",
      "--run-id",
      "--test-eval-result",
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
  return Object.freeze({
    kind: "report-workflow",
    collectAnalyzeReportPath,
    outputPath,
    workflowRunId: parseWorkflowRunId(options),
    workflowRunAttempt: parseWorkflowRunAttempt(options),
    jobResults: Object.freeze({
      "test-eval": parseWorkflowJobResult(options, "--test-eval-result"),
      "collect-analyze": parseWorkflowJobResult(options, "--collect-analyze-result"),
      "persist-state": parseWorkflowJobResult(options, "--persist-state-result"),
      "build-pages": parseWorkflowJobResult(options, "--build-pages-result"),
      "deploy-pages": parseWorkflowJobResult(options, "--deploy-pages-result"),
      "notify-discord": parseWorkflowJobResult(options, "--notify-discord-result"),
      "notify-operations": parseWorkflowJobResult(options, "--notify-operations-result"),
    }),
  });
}

function parseVerifyState(args: readonly string[]): VerifyStateCliCommand {
  const options = parseOptions(args, new Set(["--state-directory"]));
  return Object.freeze({
    kind: "verify-state",
    stateDirectory: requiredSingleOption(options, "--state-directory", "verify-state"),
  });
}

function parseReplaySource(options: ParsedOptions): ReplaySource {
  const fixturePath = optionalSingleOption(options, "--fixture");
  const statePath = optionalSingleOption(options, "--state");
  if ((fixturePath == null) === (statePath == null)) {
    throw usageError("--fixtureまたは--stateのどちらか一方を指定してください");
  }
  if (fixturePath != null) {
    return Object.freeze({
      kind: "fixture",
      path: fixturePath,
    });
  }
  assertNonNullable(statePath, "--stateの値を取得できませんでした");
  return Object.freeze({
    kind: "state",
    path: statePath,
  });
}

function parseReplay(args: readonly string[]): ReplayCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--fixture", "--report", "--scheduled-for", "--state"]),
  );
  const reportPath = singleOption(options, "--report", `${DEFAULT_REPORT_DIRECTORY}/replay.json`);
  const artifactPath = singleOption(
    options,
    "--artifact",
    `${DEFAULT_ARTIFACT_DIRECTORY}/replay.json`,
  );
  assertDifferentOutputPaths(reportPath, artifactPath);
  return Object.freeze({
    kind: "replay",
    source: parseReplaySource(options),
    artifactPath,
    reportPath,
    schedule: parseSchedule(options),
  });
}

function parseEval(args: readonly string[]): EvalCliCommand {
  const options = parseOptions(
    args,
    new Set(["--artifact", "--fixtures", "--report", "--scheduled-for"]),
  );
  const fixturesPath = optionalSingleOption(options, "--fixtures");
  if (fixturesPath == null) {
    throw usageError("evalには--fixturesが必要です");
  }
  const reportPath = singleOption(options, "--report", `${DEFAULT_REPORT_DIRECTORY}/eval.json`);
  const artifactPath = singleOption(
    options,
    "--artifact",
    `${DEFAULT_ARTIFACT_DIRECTORY}/eval.json`,
  );
  assertDifferentOutputPaths(reportPath, artifactPath);
  return Object.freeze({
    kind: "eval",
    fixturesPath,
    artifactPath,
    reportPath,
    schedule: parseSchedule(options),
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
    case "daily":
      return parseDaily(options);
    case "dry-run":
      return parseDryRun(options);
    case "backfill":
      return parseBackfill(options);
    case "collect-analyze":
      return parseCollectAnalyze(options);
    case "persist-state":
      return parsePersistState(options);
    case "build-pages":
      return parseBuildPages(options);
    case "notify-discord":
      return parseNotifyDiscord(options);
    case "notify-operations":
      return parseNotifyOperations(options);
    case "report-workflow":
      return parseReportWorkflow(options);
    case "verify-state":
      return parseVerifyState(options);
    case "replay":
      return parseReplay(options);
    case "eval":
      return parseEval(options);
    default:
      throw usageError(`未対応のサブコマンドです。対象: ${subcommand}`);
  }
}

/** CLIで表示する簡潔な使用方法を返す。 */
export function formatCliUsage(): string {
  return [
    "使用方法:",
    "  voicevox-task-tracker daily [--config PATH] [--scheduled-for ISO] [--report PATH]",
    "  voicevox-task-tracker dry-run [--config PATH] [--artifact PATH] [--report PATH]",
    "  voicevox-task-tracker backfill [--mode none|linked|all-open] [--repository VOICEVOX/REPO]",
    "  voicevox-task-tracker collect-analyze [--mode none|linked|all-open] [--scheduled-for ISO] [--artifact PATH]",
    "  voicevox-task-tracker persist-state [--config PATH] [--artifact PATH]",
    "  voicevox-task-tracker build-pages [--config PATH] [--artifact PATH] [--output PATH]",
    "  voicevox-task-tracker notify-discord --pages-url URL [--artifact PATH]",
    "  voicevox-task-tracker notify-operations --kind collection|pages|discord --incident-id ID --occurred-at ISO",
    "  voicevox-task-tracker report-workflow --run-id ID --run-attempt NUMBER --test-eval-result RESULT --collect-analyze-result RESULT --persist-state-result RESULT --build-pages-result RESULT --deploy-pages-result RESULT --notify-discord-result RESULT --notify-operations-result RESULT",
    "  voicevox-task-tracker verify-state --state-directory PATH",
    "  voicevox-task-tracker replay (--fixture PATH | --state PATH) [--artifact PATH]",
    "  voicevox-task-tracker eval --fixtures PATH [--artifact PATH]",
  ].join("\n");
}

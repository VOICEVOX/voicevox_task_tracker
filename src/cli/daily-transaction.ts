import { createHash } from "node:crypto";

import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import { GitHubRetryExhaustedError } from "../github/index.js";
import { serializeCanonicalJson } from "../persistence/index.js";
import { UnreachableError } from "../util/index.js";
import {
  type BackfillCliCommand,
  type CollectAnalyzeCliCommand,
  type DailyCliCommand,
  type DryRunCliCommand,
} from "./command.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import { RunCoordinator, type CoordinatedRunResult } from "./run-coordinator.js";
import {
  createEmptyRunMetrics,
  createRunReport,
  type RunMetrics,
  type RunReport,
  type RunStage,
} from "./run-report.js";

/** ネットワークを利用する日次transaction系のサブコマンド。 */
export type OnlineCliCommand =
  DailyCliCommand | DryRunCliCommand | BackfillCliCommand | CollectAnalyzeCliCommand;

/** 各段階を型安全につなぐために利用する値の対応表。 */
export type DailyTransactionTypeMap = Readonly<{
  configuration: unknown;
  state: unknown;
  authentication: unknown;
  repositoryInventory: unknown;
  collection: unknown;
  deterministicAnalysis: unknown;
  codexAnalysis: unknown;
  reduction: unknown;
  graph: unknown;
  validated: unknown;
  persisted: unknown;
  pages: unknown;
  discord: unknown;
}>;

/** run内の全段階へ渡す安定した識別情報。 */
export type DailyRunInvocation = Readonly<{
  runId: string;
  command: OnlineCliCommand;
  scheduledFor: UtcIsoDateTime;
  startedAt: UtcIsoDateTime;
}>;

/** repository inventory段階の値と観測指標。 */
export type RepositoryInventoryStageResult<Value> = Readonly<{
  value: Value;
  repositoryCount: number;
  githubApiRemaining: number;
}>;

/** 増分収集段階の値と観測指標。 */
export type IncrementalCollectionStageResult<Value> = Readonly<{
  value: Value;
  itemCount: number;
  changedItemCount: number;
  githubApiRemaining: number;
  staleRepositoryCount: number;
  diagnostics: readonly string[];
}>;

/** Codex段階の値、縮退状態、予算指標。 */
export type CodexAnalysisStageResult<Value> = Readonly<{
  status: "success" | "fallback";
  value: Value;
  aiCallCount: number;
  aiCacheHitCount: number;
  aiRetainedResultCount: number;
  estimatedInputTokens: number;
  diagnostics: readonly string[];
}>;

/** graph解析段階の値とactive edge数。 */
export type GraphAnalysisStageResult<Value> = Readonly<{
  value: Value;
  activeEdgeCount: number;
}>;

/** 公開前検証が完全性を満たしたかを表す。 */
export type CompletenessValidationResult<Value> =
  | Readonly<{
      status: "complete";
      value: Value;
      diagnostics: readonly string[];
    }>
  | Readonly<{
      status: "incomplete";
      diagnostics: readonly [string, ...string[]];
    }>;

/** Discord段階の値と通知指標。 */
export type DiscordStageResult<Value> = Readonly<{
  value: Value;
  notificationCount: number;
  discordSentAt: UtcIsoDateTime | null;
}>;

/** 日次transactionの外部接続と各モジュールの結合境界。 */
export type DailyTransactionDependencies<Types extends DailyTransactionTypeMap> = Readonly<{
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  validateConfiguration: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configPath: string;
    }>,
  ) => Promise<Types["configuration"]>;
  loadState: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
    }>,
  ) => Promise<Types["state"]>;
  authenticateGitHub: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
    }>,
  ) => Promise<Types["authentication"]>;
  collectRepositoryInventory: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      authentication: Types["authentication"];
    }>,
  ) => Promise<RepositoryInventoryStageResult<Types["repositoryInventory"]>>;
  collectIncrementalItems: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      authentication: Types["authentication"];
      repositoryInventory: Types["repositoryInventory"];
    }>,
  ) => Promise<IncrementalCollectionStageResult<Types["collection"]>>;
  applyDeterministicRules: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      collection: Types["collection"];
    }>,
  ) => Promise<Types["deterministicAnalysis"]>;
  analyzeWithCodex: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      collection: Types["collection"];
      deterministicAnalysis: Types["deterministicAnalysis"];
    }>,
  ) => Promise<CodexAnalysisStageResult<Types["codexAnalysis"]>>;
  reduceAnalysis: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      collection: Types["collection"];
      deterministicAnalysis: Types["deterministicAnalysis"];
      codexAnalysis: Types["codexAnalysis"];
    }>,
  ) => Promise<Types["reduction"]>;
  reconcileGraph: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      collection: Types["collection"];
      reduction: Types["reduction"];
    }>,
  ) => Promise<GraphAnalysisStageResult<Types["graph"]>>;
  validateCompleteness: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      collection: Types["collection"];
      codexAnalysis: Types["codexAnalysis"];
      reduction: Types["reduction"];
      graph: Types["graph"];
    }>,
  ) => Promise<CompletenessValidationResult<Types["validated"]>>;
  persistState: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<Types["persisted"]>;
  buildPages: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      persisted: Types["persisted"];
    }>,
  ) => Promise<Types["pages"]>;
  sendDiscord: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      validated: Types["validated"];
      persisted: Types["persisted"];
      pages: Types["pages"];
    }>,
  ) => Promise<DiscordStageResult<Types["discord"]>>;
  completeRun: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      discord: Types["discord"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<void>;
  sendOperationsAlert: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      persisted: Types["persisted"] | undefined;
      kind: "collection" | "pages";
      retryAttempts: number;
    }>,
  ) => Promise<DiscordStageResult<Types["discord"]>>;
  writeDryRunArtifact: (
    path: string,
    artifact: DryRunArtifact<Types["validated"]>,
  ) => Promise<void>;
  writeCollectAnalyzeArtifact: (
    path: string,
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      state: Types["state"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<void>;
  writeReport: (path: string, report: RunReport) => Promise<void>;
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
}>;

/** dry-runが公開副作用の代わりに保存する検証済み成果物。 */
export type DryRunArtifact<Value> =
  | Readonly<{
      schemaVersion: "1";
      runId: string;
      command: "dry-run";
      status: "success" | "fallback";
      complete: true;
      result: Value;
      metrics: RunMetrics;
      diagnostics: readonly string[];
    }>
  | Readonly<{
      schemaVersion: "1";
      runId: string;
      command: "dry-run";
      status: "failure";
      complete: false;
      metrics: RunMetrics;
      diagnostics: readonly string[];
    }>;

/** 日次transactionの時刻を注入する境界。 */
export type DailyRunRuntime = Readonly<{
  now: () => Date;
}>;

interface MutableEffects {
  stateCommitted: boolean;
  pagesBuilt: boolean;
  discordAttempted: boolean;
  artifactWritten: boolean;
}

function currentTime(runtime: DailyRunRuntime): UtcIsoDateTime {
  const value = runtime.now();
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("run runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(value.toISOString());
}

function resolveScheduledFor(command: OnlineCliCommand, startedAt: UtcIsoDateTime): UtcIsoDateTime {
  const scheduledFor = command.schedule.kind === "specified" ? command.schedule.value : startedAt;
  if (scheduledFor > startedAt) {
    throw new RangeError("runの予定時刻は開始時刻以前にしてください");
  }
  return scheduledFor;
}

function createRunId(command: OnlineCliCommand, scheduledFor: UtcIsoDateTime): string {
  let commandIdentity: unknown;
  switch (command.kind) {
    case "daily":
      commandIdentity = {
        kind: command.kind,
        configPath: command.configPath,
        notificationAction: command.notificationAction,
        scheduledFor,
      };
      break;
    case "backfill":
    case "collect-analyze":
      commandIdentity = {
        kind: command.kind,
        configPath: command.configPath,
        mode: command.mode,
        notificationAction: command.notificationAction,
        repositoryFilter: command.repositoryFilter,
        scheduledFor,
      };
      break;
    case "dry-run":
      commandIdentity = {
        kind: command.kind,
        configPath: command.configPath,
        scheduledFor,
      };
      break;
    default:
      throw new UnreachableError(command);
  }
  const digest = createHash("sha256")
    .update(serializeCanonicalJson(commandIdentity), "utf8")
    .digest("hex");
  return `tracker-run:${digest}`;
}

function freezeEffects(effects: MutableEffects): DailyRunEffects {
  return Object.freeze({
    ...effects,
  });
}

function updateMetrics(metrics: RunMetrics, values: Partial<RunMetrics>): RunMetrics {
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

function createDryRunArtifact<Value>(
  invocation: DailyRunInvocation,
  status: "success" | "fallback",
  validation: CompletenessValidationResult<Value>,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  finishedAt: UtcIsoDateTime,
): DryRunArtifact<Value> {
  const completedMetrics = updateMetrics(metrics, {
    durationMilliseconds: Date.parse(finishedAt) - Date.parse(invocation.startedAt),
  });
  if (validation.status === "incomplete") {
    return Object.freeze({
      schemaVersion: "1",
      runId: invocation.runId,
      command: "dry-run",
      status: "failure",
      complete: false,
      metrics: completedMetrics,
      diagnostics: Object.freeze([...diagnostics]),
    });
  }
  return Object.freeze({
    schemaVersion: "1",
    runId: invocation.runId,
    command: "dry-run",
    status,
    complete: true,
    result: validation.value,
    metrics: completedMetrics,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function completedReport(
  invocation: DailyRunInvocation,
  status: "success" | "fallback",
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "1",
    runId: invocation.runId,
    command: invocation.command.kind,
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

function failureReport(
  invocation: DailyRunInvocation,
  failedStage: RunStage,
  metrics: RunMetrics,
  diagnostics: readonly string[],
  discordSentAt: UtcIsoDateTime | null,
  finishedAt: UtcIsoDateTime,
): RunReport {
  return createRunReport({
    schemaVersion: "1",
    runId: invocation.runId,
    command: invocation.command.kind,
    status: "failure",
    complete: false,
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

function initialEffects(): MutableEffects {
  return {
    stateCommitted: false,
    pagesBuilt: false,
    discordAttempted: false,
    artifactWritten: false,
  };
}

function operationsAlertKind(stage: RunStage): "collection" | "pages" | undefined {
  if (stage === "repository_inventory" || stage === "incremental_collection") {
    return "collection";
  }
  if (stage === "pages") {
    return "pages";
  }
  return undefined;
}

function operationsAlertRetryAttempts(error: unknown): number {
  return error instanceof GitHubRetryExhaustedError ? error.attempts : 1;
}

/** Daily transactionを順序保証付きで実行する。 */
export class DailyTransactionRunner<Types extends DailyTransactionTypeMap> {
  readonly #coordinator: RunCoordinator<DailyRunExecutionResult>;
  readonly #dependencies: DailyTransactionDependencies<Types>;
  readonly #runtime: DailyRunRuntime;

  public constructor(dependencies: DailyTransactionDependencies<Types>, runtime: DailyRunRuntime) {
    this.#dependencies = dependencies;
    this.#runtime = runtime;
    this.#coordinator = new RunCoordinator((result) => result.report.status !== "failure");
  }

  async #writeFailure(
    invocation: DailyRunInvocation,
    reportPath: string,
    stage: RunStage,
    metrics: RunMetrics,
    diagnostics: readonly string[],
    discordSentAt: UtcIsoDateTime | null,
    effects: MutableEffects,
  ): Promise<DailyRunExecutionResult> {
    const report = failureReport(
      invocation,
      stage,
      metrics,
      diagnostics,
      discordSentAt,
      currentTime(this.#runtime),
    );
    await this.#dependencies.writeReport(reportPath, report);
    return Object.freeze({
      report,
      effects: freezeEffects(effects),
    });
  }

  async #recordError(
    invocation: DailyRunInvocation,
    stage: RunStage,
    event: string,
    error: unknown,
  ): Promise<void> {
    const recorder = this.#dependencies.diagnosticsRecorder;
    if (recorder == null) {
      return;
    }
    try {
      await recorder.append({
        event,
        details: {
          runId: invocation.runId,
          command: invocation.command.kind,
          stage,
        },
        error,
      });
    } catch (recordingError: unknown) {
      throw new AggregateError([error, recordingError], "CLI段階エラーの診断記録に失敗しました", {
        cause: error,
      });
    }
  }

  async #execute(invocation: DailyRunInvocation): Promise<DailyRunExecutionResult> {
    let stage: RunStage = "configuration";
    let metrics = updateMetrics(createEmptyRunMetrics(), {
      scheduleDelayMilliseconds:
        Date.parse(invocation.startedAt) - Date.parse(invocation.scheduledFor),
    });
    const diagnostics: string[] = [];
    const effects = initialEffects();
    let discordSentAt: UtcIsoDateTime | null = null;
    let configuration: Types["configuration"] | undefined;
    let state: Types["state"] | undefined;
    let persisted: Types["persisted"] | undefined;

    try {
      configuration = await this.#dependencies.validateConfiguration({
        invocation,
        configPath: invocation.command.configPath,
      });
      state = await this.#dependencies.loadState({
        invocation,
        configuration,
      });

      stage = "authentication";
      const authentication = await this.#dependencies.authenticateGitHub({
        invocation,
        configuration,
      });

      stage = "repository_inventory";
      const repositoryInventory = await this.#dependencies.collectRepositoryInventory({
        invocation,
        configuration,
        state,
        authentication,
      });
      metrics = updateMetrics(metrics, {
        repositoryCount: repositoryInventory.repositoryCount,
        githubApiRemaining: repositoryInventory.githubApiRemaining,
      });

      stage = "incremental_collection";
      const collection = await this.#dependencies.collectIncrementalItems({
        invocation,
        configuration,
        state,
        authentication,
        repositoryInventory: repositoryInventory.value,
      });
      diagnostics.push(...collection.diagnostics);
      metrics = updateMetrics(metrics, {
        itemCount: collection.itemCount,
        changedItemCount: collection.changedItemCount,
        githubApiRemaining: collection.githubApiRemaining,
        staleRepositoryCount: collection.staleRepositoryCount,
      });

      stage = "deterministic_analysis";
      const deterministicAnalysis = await this.#dependencies.applyDeterministicRules({
        invocation,
        configuration,
        state,
        repositoryInventory: repositoryInventory.value,
        collection: collection.value,
      });

      stage = "codex_analysis";
      const codexAnalysis = await this.#dependencies.analyzeWithCodex({
        invocation,
        configuration,
        state,
        collection: collection.value,
        deterministicAnalysis,
      });
      diagnostics.push(...codexAnalysis.diagnostics);
      metrics = updateMetrics(metrics, {
        aiCallCount: codexAnalysis.aiCallCount,
        aiCacheHitCount: codexAnalysis.aiCacheHitCount,
        aiRetainedResultCount: codexAnalysis.aiRetainedResultCount,
        estimatedInputTokens: codexAnalysis.estimatedInputTokens,
      });
      const runStatus = codexAnalysis.status;

      stage = "reducer";
      const reduction = await this.#dependencies.reduceAnalysis({
        invocation,
        configuration,
        collection: collection.value,
        deterministicAnalysis,
        codexAnalysis: codexAnalysis.value,
      });

      stage = "graph_analysis";
      const graph = await this.#dependencies.reconcileGraph({
        invocation,
        configuration,
        state,
        collection: collection.value,
        reduction,
      });
      metrics = updateMetrics(metrics, {
        activeEdgeCount: graph.activeEdgeCount,
      });

      stage = "completeness_validation";
      const validation = await this.#dependencies.validateCompleteness({
        invocation,
        configuration,
        state,
        repositoryInventory: repositoryInventory.value,
        collection: collection.value,
        codexAnalysis: codexAnalysis.value,
        reduction,
        graph: graph.value,
      });
      diagnostics.push(...validation.diagnostics);

      if (invocation.command.kind === "dry-run") {
        stage = "artifact";
        await this.#dependencies.writeDryRunArtifact(
          invocation.command.artifactPath,
          createDryRunArtifact(
            invocation,
            runStatus,
            validation,
            metrics,
            diagnostics,
            currentTime(this.#runtime),
          ),
        );
        effects.artifactWritten = true;
      }

      if (validation.status === "incomplete") {
        return await this.#writeFailure(
          invocation,
          invocation.command.reportPath,
          "completeness_validation",
          metrics,
          diagnostics,
          discordSentAt,
          effects,
        );
      }

      if (invocation.command.kind === "collect-analyze") {
        stage = "artifact";
        await this.#dependencies.writeCollectAnalyzeArtifact(invocation.command.artifactPath, {
          invocation,
          configuration,
          state,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.artifactWritten = true;
      }

      if (invocation.command.kind !== "dry-run" && invocation.command.kind !== "collect-analyze") {
        stage = "state_persistence";
        persisted = await this.#dependencies.persistState({
          invocation,
          configuration,
          state,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.stateCommitted = true;

        stage = "pages";
        const pages = await this.#dependencies.buildPages({
          invocation,
          configuration,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
          persisted,
        });
        effects.pagesBuilt = true;

        stage = "discord";
        effects.discordAttempted = true;
        const discord = await this.#dependencies.sendDiscord({
          invocation,
          configuration,
          state,
          validated: validation.value,
          persisted,
          pages,
        });
        discordSentAt = discord.discordSentAt;
        metrics = updateMetrics(metrics, {
          notificationCount: discord.notificationCount,
        });

        stage = "state_persistence";
        await this.#dependencies.completeRun({
          invocation,
          configuration,
          state,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
          discord: discord.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
      }

      const report = completedReport(
        invocation,
        runStatus,
        metrics,
        diagnostics,
        discordSentAt,
        currentTime(this.#runtime),
      );
      await this.#dependencies.writeReport(invocation.command.reportPath, report);
      return Object.freeze({
        report,
        effects: freezeEffects(effects),
      });
    } catch (error: unknown) {
      await this.#recordError(invocation, stage, "cli.stage.failed", error);
      const alertKind = operationsAlertKind(stage);
      if (
        alertKind != null &&
        configuration != null &&
        state != null &&
        (invocation.command.kind === "daily" || invocation.command.kind === "backfill")
      ) {
        effects.discordAttempted = true;
        try {
          const alert = await this.#dependencies.sendOperationsAlert({
            invocation,
            configuration,
            state,
            persisted,
            kind: alertKind,
            retryAttempts: operationsAlertRetryAttempts(error),
          });
          discordSentAt = alert.discordSentAt;
          metrics = updateMetrics(metrics, {
            notificationCount: alert.notificationCount,
          });
        } catch (alertError: unknown) {
          await this.#recordError(invocation, "discord", "cli.operations_alert.failed", alertError);
          diagnostics.push(safeErrorDiagnostic("discord", alertError));
        }
      }
      return this.#writeFailure(
        invocation,
        invocation.command.reportPath,
        stage,
        metrics,
        [...diagnostics, safeErrorDiagnostic(stage, error)],
        discordSentAt,
        effects,
      );
    }
  }

  /** サブコマンドを排他かつ同じrun IDで冪等に実行する。 */
  public async run(
    command: OnlineCliCommand,
  ): Promise<CoordinatedRunResult<DailyRunExecutionResult>> {
    const startedAt = currentTime(this.#runtime);
    const scheduledFor = resolveScheduledFor(command, startedAt);
    const invocation = Object.freeze({
      runId: createRunId(command, scheduledFor),
      command,
      scheduledFor,
      startedAt,
    });
    return this.#coordinator.runExclusive(invocation.runId, () => this.#execute(invocation));
  }
}

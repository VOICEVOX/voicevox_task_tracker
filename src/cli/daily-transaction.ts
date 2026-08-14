import { createHash } from "node:crypto";

import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import { GitHubGraphQLRetryExhaustedError, GitHubRetryExhaustedError } from "../github/index.js";
import { serializeCanonicalJson } from "../persistence/index.js";
import {
  type BackfillCliCommand,
  type CollectAnalyzeCliCommand,
  type DailyCliCommand,
  type DryRunCliCommand,
} from "./command.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import { ResponsibilityReplayRetryExhaustedError } from "./errors.js";
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
  cache: unknown;
  authentication: unknown;
  repositoryInventory: unknown;
  collection: unknown;
  deterministicAnalysis: unknown;
  codexAnalysis: unknown;
  reduction: unknown;
  graph: unknown;
  validated: unknown;
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
  validateConfiguration: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configPath: string;
    }>,
  ) => Promise<Types["configuration"]>;
  loadCaches: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
    }>,
  ) => Promise<Types["cache"]>;
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
      authentication: Types["authentication"];
    }>,
  ) => Promise<RepositoryInventoryStageResult<Types["repositoryInventory"]>>;
  collectIncrementalItems: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      cache: Types["cache"];
      authentication: Types["authentication"];
      repositoryInventory: Types["repositoryInventory"];
    }>,
  ) => Promise<IncrementalCollectionStageResult<Types["collection"]>>;
  applyDeterministicRules: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      cache: Types["cache"];
      repositoryInventory: Types["repositoryInventory"];
      collection: Types["collection"];
    }>,
  ) => Promise<Types["deterministicAnalysis"]>;
  analyzeWithCodex: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      cache: Types["cache"];
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
      cache: Types["cache"];
      collection: Types["collection"];
      reduction: Types["reduction"];
    }>,
  ) => Promise<GraphAnalysisStageResult<Types["graph"]>>;
  validateCompleteness: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      cache: Types["cache"];
      repositoryInventory: Types["repositoryInventory"];
      collection: Types["collection"];
      deterministicAnalysis: Types["deterministicAnalysis"];
      codexAnalysis: Types["codexAnalysis"];
      reduction: Types["reduction"];
      graph: Types["graph"];
    }>,
  ) => Promise<CompletenessValidationResult<Types["validated"]>>;
  persistCache: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      cache: Types["cache"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
      discord: Types["discord"];
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<void>;
  buildPages: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      repositoryInventory: Types["repositoryInventory"];
      validated: Types["validated"];
    }>,
  ) => Promise<Types["pages"]>;
  sendDiscord: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
      cache: Types["cache"];
      validated: Types["validated"];
      pages: Types["pages"];
    }>,
  ) => Promise<DiscordStageResult<Types["discord"]>>;
  sendOperationsAlert: (
    input: Readonly<{
      invocation: DailyRunInvocation;
      configuration: Types["configuration"];
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
      cache: Types["cache"];
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
  cacheCommitted: boolean;
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
  cacheCommitted: boolean;
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
  const commandIdentity =
    command.kind === "backfill" || command.kind === "collect-analyze"
      ? {
          kind: command.kind,
          configPath: command.configPath,
          mode: command.mode,
          repositoryFilter: command.repositoryFilter,
          scheduledFor,
        }
      : {
          kind: command.kind,
          configPath: command.configPath,
          scheduledFor,
        };
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
    cacheCommitted: false,
    pagesBuilt: false,
    discordAttempted: false,
    artifactWritten: false,
  };
}

function operationsAlertKind(stage: RunStage): "collection" | "pages" | undefined {
  if (
    stage === "repository_inventory" ||
    stage === "cache_loading" ||
    stage === "incremental_collection"
  ) {
    return "collection";
  }
  if (stage === "pages") {
    return "pages";
  }
  return undefined;
}

function operationsAlertRetryAttempts(error: unknown): number {
  const retryErrorCauseDepthLimit = 5;
  const visited = new Set<Error>();
  let current: unknown = error;
  let depth = 0;
  while (current instanceof Error && depth < retryErrorCauseDepthLimit) {
    if (visited.has(current)) {
      return 1;
    }
    visited.add(current);
    if (
      current instanceof GitHubRetryExhaustedError ||
      current instanceof GitHubGraphQLRetryExhaustedError ||
      current instanceof ResponsibilityReplayRetryExhaustedError
    ) {
      return current.attempts;
    }
    current = current.cause;
    depth += 1;
  }
  return 1;
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
    let cache: Types["cache"] | undefined;

    try {
      configuration = await this.#dependencies.validateConfiguration({
        invocation,
        configPath: invocation.command.configPath,
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
        authentication,
      });
      metrics = updateMetrics(metrics, {
        repositoryCount: repositoryInventory.repositoryCount,
        githubApiRemaining: repositoryInventory.githubApiRemaining,
      });

      stage = "cache_loading";
      cache = await this.#dependencies.loadCaches({
        invocation,
        configuration,
        repositoryInventory: repositoryInventory.value,
      });

      stage = "incremental_collection";
      const collection = await this.#dependencies.collectIncrementalItems({
        invocation,
        configuration,
        cache,
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
        cache,
        repositoryInventory: repositoryInventory.value,
        collection: collection.value,
      });

      stage = "codex_analysis";
      const codexAnalysis = await this.#dependencies.analyzeWithCodex({
        invocation,
        configuration,
        cache,
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
        cache,
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
        cache,
        repositoryInventory: repositoryInventory.value,
        collection: collection.value,
        deterministicAnalysis,
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
          cache,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.artifactWritten = true;
      }

      if (invocation.command.kind !== "dry-run" && invocation.command.kind !== "collect-analyze") {
        stage = "pages";
        const pages = await this.#dependencies.buildPages({
          invocation,
          configuration,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
        });
        effects.pagesBuilt = true;

        stage = "discord";
        effects.discordAttempted = true;
        const discord = await this.#dependencies.sendDiscord({
          invocation,
          configuration,
          cache,
          validated: validation.value,
          pages,
        });
        discordSentAt = discord.discordSentAt;
        metrics = updateMetrics(metrics, {
          notificationCount: discord.notificationCount,
        });

        stage = "cache_persistence";
        await this.#dependencies.persistCache({
          invocation,
          configuration,
          cache,
          repositoryInventory: repositoryInventory.value,
          validated: validation.value,
          discord: discord.value,
          metrics,
          status: runStatus,
          diagnostics,
        });
        effects.cacheCommitted = true;
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
      const alertKind = operationsAlertKind(stage);
      if (
        alertKind != null &&
        configuration != null &&
        (invocation.command.kind === "daily" || invocation.command.kind === "backfill")
      ) {
        effects.discordAttempted = true;
        try {
          const alert = await this.#dependencies.sendOperationsAlert({
            invocation,
            configuration,
            kind: alertKind,
            retryAttempts: operationsAlertRetryAttempts(error),
          });
          discordSentAt = alert.discordSentAt;
          metrics = updateMetrics(metrics, {
            notificationCount: alert.notificationCount,
          });
        } catch (alertError: unknown) {
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

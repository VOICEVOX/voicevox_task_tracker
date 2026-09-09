import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import { evaluateGoldenRegression, type GoldenEvaluationPair } from "../eval/index.js";
import {
  parseStateSnapshot,
  serializeCanonicalJson,
  type StateSnapshot,
} from "../persistence/index.js";
import { type EvalCliCommand, type ReplayCliCommand } from "./command.js";
import { CliFixtureError } from "./errors.js";
import {
  createEmptyRunMetrics,
  createRunReport,
  type RunMetrics,
  type RunReport,
} from "./run-report.js";

const replayFixtureSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  input: z.json(),
});
const goldenFixtureSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  name: z.string().min(1).max(200),
  input: z.json(),
  expected: z.json(),
});
const pairedGoldenFixtureSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  name: z.string().min(1).max(200),
  input: z.json(),
});

/** replay用fixtureの安定した最小形式。 */
export type ReplayFixture = z.output<typeof replayFixtureSchema>;

/** eval用golden fixtureの入力と期待結果。 */
export type GoldenFixture = z.output<typeof goldenFixtureSchema>;

/** offline判定がrun reportへ返す指標。 */
export type OfflineAnalysisMetrics = Readonly<{
  repositoryCount: number;
  itemCount: number;
  changedItemCount: number;
  activeEdgeCount: number;
  aiCallCount: number;
  aiCacheHitCount: number;
  aiRetainedResultCount: number;
  estimatedInputTokens: number;
  staleRepositoryCount: number;
}>;

/** offline判定のJSON互換結果と縮退状態。 */
export type OfflineAnalysisResult = Readonly<{
  status: "success" | "fallback";
  output: unknown;
  metrics: OfflineAnalysisMetrics;
  diagnostics: readonly string[];
}>;

/** replayとevalだけが利用できるネットワーク非依存の判定境界。 */
export type OfflineAnalysisEngine = Readonly<{
  replayFixture: (fixture: ReplayFixture) => Promise<OfflineAnalysisResult>;
  replayState: (state: StateSnapshot) => Promise<OfflineAnalysisResult>;
}>;

/** offline commandが利用するファイル入出力と判定境界。 */
export type OfflineRunDependencies = Readonly<{
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  engine: OfflineAnalysisEngine;
  readReplayFixture: (path: string) => Promise<ReplayFixture>;
  readState: (path: string) => Promise<StateSnapshot>;
  readGoldenFixtures: (path: string) => Promise<readonly GoldenFixture[]>;
  writeArtifact: (path: string, value: unknown) => Promise<void>;
  writeReport: (path: string, report: RunReport) => Promise<void>;
}>;

/** offline commandの時刻を注入する境界。 */
export type OfflineRunRuntime = Readonly<{
  now: () => Date;
}>;

/** replayまたはevalのreportとartifact出力実績。 */
export type OfflineRunExecutionResult = Readonly<{
  report: RunReport;
  artifactWritten: boolean;
}>;

type EvalComparison = Readonly<{
  name: string;
  status: "passed" | "failed";
  expectedHash: string;
  actualHash: string;
}>;

function parseJson(source: string, path: string): unknown {
  try {
    const parse: (value: string) => unknown = JSON.parse;
    return parse(source);
  } catch (error: unknown) {
    throw new CliFixtureError(path, {
      cause: error,
    });
  }
}

async function readUtf8(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new CliFixtureError(path, {
      cause: error,
    });
  }
}

/** JSONファイルからreplay fixtureを検証して読む。 */
export async function readReplayFixtureFile(path: string): Promise<ReplayFixture> {
  const result = replayFixtureSchema.safeParse(parseJson(await readUtf8(path), path));
  if (!result.success) {
    throw new CliFixtureError(path, {
      cause: result.error,
    });
  }
  return Object.freeze({
    schemaVersion: "1",
    input: result.data.input,
  });
}

/** JSONファイルから過去のcanonical stateを検証して読む。 */
export async function readReplayStateFile(path: string): Promise<StateSnapshot> {
  try {
    return parseStateSnapshot(await readUtf8(path));
  } catch (error: unknown) {
    if (error instanceof CliFixtureError) {
      throw error;
    }
    throw new CliFixtureError(path, {
      cause: error,
    });
  }
}

async function listJsonFiles(path: string): Promise<readonly string[]> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error: unknown) {
    throw new CliFixtureError(path, {
      cause: error,
    });
  }
  if (metadata.isFile()) {
    if (!path.endsWith(".json")) {
      throw new CliFixtureError(path, {
        cause: new TypeError("golden fixtureは.jsonファイルにしてください"),
      });
    }
    return Object.freeze([path]);
  }
  if (!metadata.isDirectory()) {
    throw new CliFixtureError(path, {
      cause: new TypeError("golden fixtureのパスはfileまたはdirectoryにしてください"),
    });
  }

  let entries;
  try {
    entries = await readdir(path, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    throw new CliFixtureError(path, {
      cause: error,
    });
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "expected.json") {
      files.push(entryPath);
    }
  }
  return Object.freeze(files);
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** fileまたはdirectoryからgolden fixtureを決定論的順序で読む。 */
export async function readGoldenFixtureFiles(path: string): Promise<readonly GoldenFixture[]> {
  const files = await listJsonFiles(path);
  if (files.length === 0) {
    throw new CliFixtureError(path, {
      cause: new TypeError("golden fixtureがありません"),
    });
  }
  const fixtures: GoldenFixture[] = [];
  for (const file of files) {
    const value = parseJson(await readUtf8(file), file);
    if (basename(file) === "fixture.json") {
      const result = pairedGoldenFixtureSchema.safeParse(value);
      if (!result.success) {
        throw new CliFixtureError(file, {
          cause: result.error,
        });
      }
      const expectedPath = join(dirname(file), "expected.json");
      const expected = parseJson(await readUtf8(expectedPath), expectedPath);
      const expectedResult = z.json().safeParse(expected);
      if (!expectedResult.success) {
        throw new CliFixtureError(expectedPath, {
          cause: expectedResult.error,
        });
      }
      fixtures.push(
        Object.freeze({
          schemaVersion: "1",
          name: result.data.name,
          input: result.data.input,
          expected: expectedResult.data,
        }),
      );
      continue;
    }

    const result = goldenFixtureSchema.safeParse(value);
    if (!result.success) {
      throw new CliFixtureError(file, {
        cause: result.error,
      });
    }
    fixtures.push(
      Object.freeze({
        schemaVersion: "1",
        name: result.data.name,
        input: result.data.input,
        expected: result.data.expected,
      }),
    );
  }
  const names = fixtures.map((fixture) => fixture.name);
  if (new Set(names).size !== names.length) {
    throw new CliFixtureError(path, {
      cause: new TypeError("golden fixture名が重複しています"),
    });
  }
  return Object.freeze(fixtures);
}

function currentTime(runtime: OfflineRunRuntime): UtcIsoDateTime {
  const value = runtime.now();
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("offline runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(value.toISOString());
}

function resolveScheduledFor(
  command: ReplayCliCommand | EvalCliCommand,
  startedAt: UtcIsoDateTime,
): UtcIsoDateTime {
  const scheduledFor = command.schedule.kind === "specified" ? command.schedule.value : startedAt;
  if (scheduledFor > startedAt) {
    throw new RangeError("offline runの予定時刻は開始時刻以前にしてください");
  }
  return scheduledFor;
}

function createRunId(
  command: ReplayCliCommand | EvalCliCommand,
  scheduledFor: UtcIsoDateTime,
): string {
  const identity =
    command.kind === "replay"
      ? {
          kind: command.kind,
          source: command.source,
          scheduledFor,
        }
      : {
          kind: command.kind,
          fixturesPath: command.fixturesPath,
          scheduledFor,
        };
  const digest = createHash("sha256")
    .update(serializeCanonicalJson(identity), "utf8")
    .digest("hex");
  return `tracker-run:${digest}`;
}

function validateCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}は0以上の安全な整数にしてください`);
  }
}

function validateOfflineMetrics(metrics: OfflineAnalysisMetrics): void {
  for (const [name, value] of Object.entries(metrics)) {
    validateCount(value, name);
  }
}

function metricsFromAnalysis(
  analysis: OfflineAnalysisResult,
  scheduledFor: UtcIsoDateTime,
  startedAt: UtcIsoDateTime,
  finishedAt: UtcIsoDateTime,
): RunMetrics {
  validateOfflineMetrics(analysis.metrics);
  return Object.freeze({
    ...createEmptyRunMetrics(),
    ...analysis.metrics,
    scheduleDelayMilliseconds: Date.parse(startedAt) - Date.parse(scheduledFor),
    durationMilliseconds: Date.parse(finishedAt) - Date.parse(startedAt),
  });
}

function addMetrics(
  left: OfflineAnalysisMetrics,
  right: OfflineAnalysisMetrics,
): OfflineAnalysisMetrics {
  validateOfflineMetrics(right);
  const aggregate = {
    repositoryCount: left.repositoryCount + right.repositoryCount,
    itemCount: left.itemCount + right.itemCount,
    changedItemCount: left.changedItemCount + right.changedItemCount,
    activeEdgeCount: left.activeEdgeCount + right.activeEdgeCount,
    aiCallCount: left.aiCallCount + right.aiCallCount,
    aiCacheHitCount: left.aiCacheHitCount + right.aiCacheHitCount,
    aiRetainedResultCount: left.aiRetainedResultCount + right.aiRetainedResultCount,
    estimatedInputTokens: left.estimatedInputTokens + right.estimatedInputTokens,
    staleRepositoryCount: left.staleRepositoryCount + right.staleRepositoryCount,
  };
  validateOfflineMetrics(aggregate);
  return Object.freeze(aggregate);
}

function emptyOfflineMetrics(): OfflineAnalysisMetrics {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    aiRetainedResultCount: 0,
    estimatedInputTokens: 0,
    staleRepositoryCount: 0,
  });
}

function createCompletedReport(
  command: ReplayCliCommand | EvalCliCommand,
  runId: string,
  scheduledFor: UtcIsoDateTime,
  startedAt: UtcIsoDateTime,
  finishedAt: UtcIsoDateTime,
  analysis: OfflineAnalysisResult,
): RunReport {
  return createRunReport({
    schemaVersion: "1",
    runId,
    command: command.kind,
    status: analysis.status,
    complete: true,
    scheduledFor,
    startedAt,
    finishedAt,
    discordSentAt: null,
    metrics: metricsFromAnalysis(analysis, scheduledFor, startedAt, finishedAt),
    diagnostics: analysis.diagnostics,
  });
}

function createFailureReport(
  command: ReplayCliCommand | EvalCliCommand,
  runId: string,
  scheduledFor: UtcIsoDateTime,
  startedAt: UtcIsoDateTime,
  finishedAt: UtcIsoDateTime,
  metrics: OfflineAnalysisMetrics,
  diagnostic: string,
): RunReport {
  return createRunReport({
    schemaVersion: "1",
    runId,
    command: command.kind,
    status: "failure",
    complete: false,
    failedStage: command.kind,
    scheduledFor,
    startedAt,
    finishedAt,
    discordSentAt: null,
    metrics: metricsFromAnalysis(
      {
        status: "success",
        output: null,
        metrics,
        diagnostics: [],
      },
      scheduledFor,
      startedAt,
      finishedAt,
    ),
    diagnostics: [diagnostic],
  });
}

function compareGoldenFixture(fixture: GoldenFixture, actual: unknown): EvalComparison {
  const expectedSource = serializeCanonicalJson(fixture.expected);
  const actualSource = serializeCanonicalJson(actual);
  const expectedHash = createHash("sha256").update(expectedSource, "utf8").digest("hex");
  const actualHash = createHash("sha256").update(actualSource, "utf8").digest("hex");
  return Object.freeze({
    name: fixture.name,
    status: expectedSource === actualSource ? "passed" : "failed",
    expectedHash: `sha256:${expectedHash}`,
    actualHash: `sha256:${actualHash}`,
  });
}

/** replayとevalを外部接続なしで実行する。 */
export class OfflineRunRunner {
  readonly #dependencies: OfflineRunDependencies;
  readonly #runtime: OfflineRunRuntime;

  public constructor(dependencies: OfflineRunDependencies, runtime: OfflineRunRuntime) {
    this.#dependencies = dependencies;
    this.#runtime = runtime;
  }

  async #recordError(
    command: ReplayCliCommand | EvalCliCommand,
    runId: string,
    stage: "replay" | "eval",
    error: unknown,
  ): Promise<void> {
    const recorder = this.#dependencies.diagnosticsRecorder;
    if (recorder == null) {
      return;
    }
    try {
      await recorder.append({
        event: "cli.stage.failed",
        details: {
          command: command.kind,
          stage,
          runId,
        },
        error,
      });
    } catch (recordingError: unknown) {
      throw new AggregateError(
        [error, recordingError],
        "offline段階エラーの診断記録に失敗しました",
        {
          cause: error,
        },
      );
    }
  }

  async #runReplay(
    command: ReplayCliCommand,
    runId: string,
    scheduledFor: UtcIsoDateTime,
    startedAt: UtcIsoDateTime,
  ): Promise<OfflineRunExecutionResult> {
    let artifactWritten = false;
    try {
      const analysis =
        command.source.kind === "fixture"
          ? await this.#dependencies.engine.replayFixture(
              await this.#dependencies.readReplayFixture(command.source.path),
            )
          : await this.#dependencies.engine.replayState(
              await this.#dependencies.readState(command.source.path),
            );
      await this.#dependencies.writeArtifact(command.artifactPath, {
        schemaVersion: "1",
        command: "replay",
        sourceKind: command.source.kind,
        result: analysis.output,
      });
      artifactWritten = true;
      const report = createCompletedReport(
        command,
        runId,
        scheduledFor,
        startedAt,
        currentTime(this.#runtime),
        analysis,
      );
      await this.#dependencies.writeReport(command.reportPath, report);
      return Object.freeze({
        report,
        artifactWritten,
      });
    } catch (error: unknown) {
      await this.#recordError(command, runId, "replay", error);
      const errorType = error instanceof Error ? error.name : typeof error;
      const report = createFailureReport(
        command,
        runId,
        scheduledFor,
        startedAt,
        currentTime(this.#runtime),
        emptyOfflineMetrics(),
        `stage=replay errorType=${errorType}`,
      );
      await this.#dependencies.writeReport(command.reportPath, report);
      return Object.freeze({
        report,
        artifactWritten,
      });
    }
  }

  async #runEval(
    command: EvalCliCommand,
    runId: string,
    scheduledFor: UtcIsoDateTime,
    startedAt: UtcIsoDateTime,
  ): Promise<OfflineRunExecutionResult> {
    let artifactWritten = false;
    let aggregateMetrics = emptyOfflineMetrics();
    try {
      const fixtures = await this.#dependencies.readGoldenFixtures(command.fixturesPath);
      const comparisons: EvalComparison[] = [];
      const evaluationPairs: GoldenEvaluationPair[] = [];
      const diagnostics: string[] = [];
      let status: OfflineAnalysisResult["status"] = "success";
      for (const fixture of fixtures) {
        const analysis = await this.#dependencies.engine.replayFixture({
          schemaVersion: "1",
          input: fixture.input,
        });
        comparisons.push(compareGoldenFixture(fixture, analysis.output));
        evaluationPairs.push(
          Object.freeze({
            name: fixture.name,
            expected: fixture.expected,
            actual: analysis.output,
          }),
        );
        aggregateMetrics = addMetrics(aggregateMetrics, analysis.metrics);
        diagnostics.push(...analysis.diagnostics);
        if (analysis.status === "fallback") {
          status = "fallback";
        }
      }
      const failedFixtureCount = comparisons.filter(
        (comparison) => comparison.status === "failed",
      ).length;
      const regression = evaluateGoldenRegression(evaluationPairs);
      const regressionFailed = regression?.status === "failed";
      const evalFailed = failedFixtureCount > 0 || regressionFailed;
      await this.#dependencies.writeArtifact(command.artifactPath, {
        schemaVersion: "1",
        command: "eval",
        status: evalFailed ? "failed" : "passed",
        fixtureCount: comparisons.length,
        passedFixtureCount: comparisons.length - failedFixtureCount,
        failedFixtureCount,
        comparisons,
        ...(regression == null ? {} : { regression }),
      });
      artifactWritten = true;
      const finishedAt = currentTime(this.#runtime);
      const report = !evalFailed
        ? createCompletedReport(command, runId, scheduledFor, startedAt, finishedAt, {
            status,
            output: null,
            metrics: aggregateMetrics,
            diagnostics,
          })
        : createFailureReport(
            command,
            runId,
            scheduledFor,
            startedAt,
            finishedAt,
            aggregateMetrics,
            regressionFailed
              ? `golden_regression_threshold_failed critical_urgent_recall=${regression.criticalUrgentRecall.value.toString()} false_notification_rate=${regression.falseNotificationRate.value.toString()} golden_mismatch_count=${failedFixtureCount.toString()}`
              : `golden_mismatch_count=${failedFixtureCount.toString()}`,
          );
      await this.#dependencies.writeReport(command.reportPath, report);
      return Object.freeze({
        report,
        artifactWritten,
      });
    } catch (error: unknown) {
      await this.#recordError(command, runId, "eval", error);
      const errorType = error instanceof Error ? error.name : typeof error;
      const report = createFailureReport(
        command,
        runId,
        scheduledFor,
        startedAt,
        currentTime(this.#runtime),
        aggregateMetrics,
        `stage=eval errorType=${errorType}`,
      );
      await this.#dependencies.writeReport(command.reportPath, report);
      return Object.freeze({
        report,
        artifactWritten,
      });
    }
  }

  /** replayまたはevalを入力種別に応じて実行する。 */
  public async run(command: ReplayCliCommand | EvalCliCommand): Promise<OfflineRunExecutionResult> {
    const startedAt = currentTime(this.#runtime);
    const scheduledFor = resolveScheduledFor(command, startedAt);
    const runId = createRunId(command, scheduledFor);
    return command.kind === "replay"
      ? this.#runReplay(command, runId, scheduledFor, startedAt)
      : this.#runEval(command, runId, scheduledFor, startedAt);
  }
}

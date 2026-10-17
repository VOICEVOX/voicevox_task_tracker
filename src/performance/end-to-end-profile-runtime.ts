import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { parseCliArguments } from "../cli/command.js";
import type { Config } from "../config/index.js";
import type { UtcIsoDateTime } from "../domain/index.js";
import { createDailyDependencies } from "../infrastructure/tracking-run/runtime/daily-dependencies.js";
import type { DailyRunExecutionResult } from "../infrastructure/tracking-run/sequential-result.js";
import { SequentialRunRunner } from "../infrastructure/tracking-run/sequential-run.js";
import type { GeneratedPublicData } from "../pages/generate-public-data-v20.js";
import type { RunMetrics } from "../publication/run-report.js";
import {
  createPerformanceHarness,
  type PerformanceRuntimeFixture,
} from "./end-to-end-profile-adapters.js";
import { createPerformanceMemoryObserver, type PerformanceMemoryEvent } from "./memory-observer.js";

const execFileAsync = promisify(execFile);

type PerformanceRuntimeResult = Readonly<{
  metrics: RunMetrics;
  durationMilliseconds: number;
  githubApiUsed: number;
  githubApiRemaining: number;
  generatedPublicData: GeneratedPublicData;
  genericAiNodeIds: readonly string[];
  personalReminderAiNodeIds: readonly string[];
}>;

async function withPerformanceSource<Value>(
  repositoryPath: string,
  execute: (source: string) => Promise<Value>,
): Promise<Value> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-performance-"));
  try {
    const source = join(directory, "source");
    await execFileAsync("git", ["clone", "--local", "--no-hardlinks", repositoryPath, source], {
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFileAsync("git", ["-C", source, "remote", "remove", "origin"]);
    await cp(join(repositoryPath, "dist"), join(source, "dist"), { recursive: true });
    await symlink(join(repositoryPath, "node_modules"), join(source, "node_modules"), "dir");
    await appendFile(join(source, ".git/info/exclude"), "\nnode_modules\n");
    return await execute(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function requireSuccessfulRunMetrics(execution: DailyRunExecutionResult): RunMetrics {
  const report = execution.report;
  if (report.status !== "success" || execution.completedRun == null) {
    throw new TypeError(`性能profileの日次runが完了しませんでした。状態: ${report.status}`);
  }
  const metrics = report.metrics;
  if (
    metrics.personalReminderFailedCount !== 0 ||
    metrics.personalReminderDeferredCount !== 0 ||
    metrics.personalReminderNotEvaluatedCount !== 0
  ) {
    throw new TypeError("性能profileの日次runに失敗または延期した個人催促原因があります");
  }
  return metrics;
}

/** 隔離sourceと同じMemory stateで共通engineのrecording policyを2run実行する。 */
export async function runEndToEndPerformanceRuntime(
  repositoryPath: string,
  config: Config,
  fixture: PerformanceRuntimeFixture,
): Promise<PerformanceRuntimeResult> {
  return withPerformanceSource(repositoryPath, async (source) => {
    const harness = createPerformanceHarness(source, config, fixture);
    const observeMemory = createPerformanceMemoryObserver();
    let phase: PerformanceMemoryEvent["phase"] = "baseline";
    const runner = new SequentialRunRunner(
      createDailyDependencies({
        ...harness.adapters,
        observePerformanceDetail: (detail) => {
          observeMemory({ phase, boundary: "detail", ...detail });
        },
        observeInitialStateCommit: (step) => {
          observeMemory({ phase, boundary: "initial_state_commit", step });
        },
      }),
      {
        now: harness.adapters.now,
        beforeStage: (stage) => {
          observeMemory({ phase, boundary: "stage", stage });
        },
      },
    );
    const runDaily = async (runAt: UtcIsoDateTime): Promise<DailyRunExecutionResult> => {
      const command = parseCliArguments([
        "dry-run",
        "--config",
        join(source, "fixtures/performance/config.valid.yml"),
        "--report",
        join(source, "artifacts/performance", `${runAt.slice(0, 10)}-report.json`),
        "--artifact",
        join(source, "artifacts/performance", `${runAt.slice(0, 10)}-dry-run.json`),
        "--scheduled-for",
        runAt,
      ]);
      if (command.kind !== "dry-run") {
        throw new TypeError("性能profileの実行policyがrecordingではありません");
      }
      const coordinated = await runner.run(command, randomUUID());
      return coordinated.value;
    };
    observeMemory({ phase, boundary: "begin" });
    harness.beginBaseline();
    requireSuccessfulRunMetrics(await runDaily(fixture.baselineRunAt));
    observeMemory({ phase, boundary: "success" });
    phase = "second";
    observeMemory({ phase, boundary: "begin" });
    harness.beginProfile();
    const startedAt = performance.now();
    const execution = await runDaily(fixture.profileRunAt);
    const durationMilliseconds = performance.now() - startedAt;
    const metrics = requireSuccessfulRunMetrics(execution);
    observeMemory({ phase, boundary: "success" });
    return Object.freeze({
      metrics,
      durationMilliseconds,
      githubApiUsed: harness.apiBudget.used(),
      githubApiRemaining: harness.apiBudget.remaining(),
      generatedPublicData: harness.readPublicData(),
      genericAiNodeIds: harness.readGenericAiNodeIds(),
      personalReminderAiNodeIds: harness.readPersonalReminderAiNodeIds(),
    });
  });
}

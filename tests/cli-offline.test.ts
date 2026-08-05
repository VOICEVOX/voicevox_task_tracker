import { describe, expect, it, vi } from "vitest";

import {
  OfflineRunRunner,
  parseCliArguments,
  type EvalCliCommand,
  type GoldenFixture,
  type OfflineAnalysisMetrics,
  type OfflineRunDependencies,
  type ReplayCliCommand,
  type ReplayFixture,
  type RunReport,
} from "../src/cli/index.js";
import { createStateSnapshot, type StateSnapshot } from "../src/persistence/index.js";

const NOW = "2026-07-31T00:00:00.000Z";
const SCHEDULED_FOR = "2026-07-30T23:00:00.000Z";

function emptyMetrics(): OfflineAnalysisMetrics {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 1,
    changedItemCount: 1,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    estimatedInputTokens: 0,
    staleRepositoryCount: 0,
  });
}

function emptySnapshot(): StateSnapshot {
  return createStateSnapshot({
    schemaVersion: "5",
    generatedAt: NOW,
    trackingStartAt: {
      status: "fixed",
      value: SCHEDULED_FOR,
      source: "first_complete_run",
    },
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    collection: {
      repositories: [],
    },
    repositories: [],
    items: [],
    externalReferences: [],
    relations: [],
    run: {
      id: "fixture-state-run",
      status: "success",
      complete: true,
    },
  });
}

function parseReplay(args: readonly string[]): ReplayCliCommand {
  const command = parseCliArguments(args);
  if (command.kind !== "replay") {
    throw new TypeError("replay commandではありません");
  }
  return command;
}

function parseEval(args: readonly string[]): EvalCliCommand {
  const command = parseCliArguments(args);
  if (command.kind !== "eval") {
    throw new TypeError("eval commandではありません");
  }
  return command;
}

type OfflineHarness = Readonly<{
  runner: OfflineRunRunner;
  artifacts: unknown[];
  reports: RunReport[];
  replayFixture: ReturnType<typeof vi.fn>;
  replayState: ReturnType<typeof vi.fn>;
}>;

function createHarness(
  fixtures: readonly GoldenFixture[],
  analyzeFixture: (fixture: ReplayFixture) => unknown,
): OfflineHarness {
  const artifacts: unknown[] = [];
  const reports: RunReport[] = [];
  const replayFixture = vi.fn((fixture: ReplayFixture) =>
    Promise.resolve({
      status: "success" as const,
      output: analyzeFixture(fixture),
      metrics: emptyMetrics(),
      diagnostics: Object.freeze([]),
    }),
  );
  const replayState = vi.fn(() =>
    Promise.resolve({
      status: "success" as const,
      output: {
        source: "state",
      },
      metrics: {
        ...emptyMetrics(),
        itemCount: 0,
        changedItemCount: 0,
      },
      diagnostics: Object.freeze([]),
    }),
  );
  const dependencies = {
    engine: {
      replayFixture,
      replayState,
    },
    readReplayFixture: () =>
      Promise.resolve({
        schemaVersion: "1",
        input: {
          source: "fixture",
        },
      }),
    readState: () => Promise.resolve(emptySnapshot()),
    readGoldenFixtures: () => Promise.resolve(fixtures),
    writeArtifact: (_path, value) => {
      artifacts.push(value);
      return Promise.resolve();
    },
    writeReport: (_path, report) => {
      reports.push(report);
      return Promise.resolve();
    },
  } satisfies OfflineRunDependencies;
  return Object.freeze({
    runner: new OfflineRunRunner(dependencies, {
      now: () => new Date(NOW),
    }),
    artifacts,
    reports,
    replayFixture,
    replayState,
  });
}

describe("offline replay", () => {
  it("fixtureをネットワーク境界なしで再判定してartifactへ出力する", async () => {
    const harness = createHarness([], (fixture) => ({
      replayed: fixture.input,
    }));
    const result = await harness.runner.run(
      parseReplay(["replay", "--fixture", "fixture.json", "--scheduled-for", SCHEDULED_FOR]),
    );

    expect(result.report.status).toBe("success");
    expect(result.artifactWritten).toBe(true);
    expect(harness.replayFixture).toHaveBeenCalledOnce();
    expect(harness.replayState).not.toHaveBeenCalled();
    expect(harness.artifacts[0]).toEqual({
      schemaVersion: "1",
      command: "replay",
      sourceKind: "fixture",
      result: {
        replayed: {
          source: "fixture",
        },
      },
    });
  });

  it("過去stateをfixtureと区別してoffline engineへ渡す", async () => {
    const harness = createHarness([], () => null);
    const result = await harness.runner.run(
      parseReplay(["replay", "--state", "state/snapshot.json", "--scheduled-for", SCHEDULED_FOR]),
    );

    expect(result.report.status).toBe("success");
    expect(harness.replayState).toHaveBeenCalledOnce();
    expect(harness.replayFixture).not.toHaveBeenCalled();
    expect(harness.artifacts[0]).toMatchObject({
      sourceKind: "state",
      result: {
        source: "state",
      },
    });
  });
});

describe("golden eval", () => {
  it("全fixtureを比較し、不一致をhashだけ含む失敗artifactへ記録する", async () => {
    const fixtures = [
      {
        schemaVersion: "1",
        name: "一致",
        input: {
          id: "same",
        },
        expected: {
          status: "ok",
        },
      },
      {
        schemaVersion: "1",
        name: "不一致",
        input: {
          id: "different",
        },
        expected: {
          status: "expected",
        },
      },
    ] satisfies readonly GoldenFixture[];
    const harness = createHarness(fixtures, (fixture) =>
      JSON.stringify(fixture.input).includes('"same"')
        ? {
            status: "ok",
          }
        : {
            status: "actual",
          },
    );
    const result = await harness.runner.run(
      parseEval(["eval", "--fixtures", "fixtures", "--scheduled-for", SCHEDULED_FOR]),
    );

    expect(result.report).toMatchObject({
      status: "failure",
      complete: false,
      failedStage: "eval",
      diagnostics: ["golden_mismatch_count=1"],
    });
    expect(result.artifactWritten).toBe(true);
    expect(harness.replayFixture).toHaveBeenCalledTimes(2);
    expect(harness.artifacts[0]).toMatchObject({
      schemaVersion: "1",
      command: "eval",
      status: "failed",
      fixtureCount: 2,
      passedFixtureCount: 1,
      failedFixtureCount: 1,
    });
    expect(JSON.stringify(harness.artifacts[0])).not.toContain('"actual"');
    expect(JSON.stringify(harness.artifacts[0])).not.toContain('"expected"');
  });
});

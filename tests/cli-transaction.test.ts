import { describe, expect, it } from "vitest";

import {
  DailyTransactionRunner,
  parseCliArguments,
  type DailyTransactionDependencies,
  type DailyTransactionTypeMap,
  type DailyRunRuntime,
  type OnlineCliCommand,
  type RunReport,
} from "../src/cli/index.js";
import { SecretRedactor, executeWithGitHubRetry } from "../src/github/index.js";
import { createUtcIsoDateTime } from "../src/domain/index.js";

const NOW = "2026-07-31T00:00:00.000Z";
const FINISHED_AT = "2026-07-31T00:00:01.000Z";
const NOW_UTC = createUtcIsoDateTime(NOW);
const SCHEDULED_FOR = "2026-07-30T23:00:00.000Z";
const REQUIRED_METRICS = [
  "activeEdgeCount",
  "aiCacheHitCount",
  "aiCallCount",
  "aiRetainedResultCount",
  "changedItemCount",
  "durationMilliseconds",
  "estimatedInputTokens",
  "githubApiRemaining",
  "itemCount",
  "notificationCount",
  "repositoryCount",
  "scheduleDelayMilliseconds",
  "staleRepositoryCount",
] as const;

type FixtureTypes = DailyTransactionTypeMap &
  Readonly<{
    configuration: Readonly<{
      schemaVersion: 1;
    }>;
    state: Readonly<{
      lastGoodHash: string;
    }>;
    authentication: Readonly<{
      installationId: number;
    }>;
    repositoryInventory: readonly string[];
    collection: Readonly<{
      itemIds: readonly string[];
    }>;
    deterministicAnalysis: Readonly<{
      resolution: "clear" | "ambiguous";
    }>;
    codexAnalysis: Readonly<{
      applied: boolean;
    }>;
    reduction: Readonly<{
      itemCount: number;
    }>;
    graph: Readonly<{
      activeEdgeCount: number;
    }>;
    validated: Readonly<{
      snapshotHash: string;
    }>;
    persisted: Readonly<{
      revision: string;
    }>;
    pages: Readonly<{
      pagesUrl: string;
    }>;
    discord: Readonly<{
      messageIds: readonly string[];
    }>;
  }>;

type CollectionFailure =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: 429 | 503;
    }>;

type HarnessBehavior = Readonly<{
  aiStatus: "success" | "fallback";
  collectionFailure: CollectionFailure;
  completeness: "complete" | "incomplete";
  deterministicResolution: "clear" | "ambiguous";
  failConfiguration: boolean;
  failRunCompletion: boolean;
  pagesFailureCount: number;
}>;

type Harness = Readonly<{
  runner: DailyTransactionRunner<FixtureTypes>;
  events: string[];
  reports: RunReport[];
  artifactPaths: string[];
  artifacts: unknown[];
  operationsRetryAttempts: number[];
  persistedCommands: OnlineCliCommand[];
  counters: {
    apiAttempts: number;
    aiExternalCalls: number;
    discordCalls: number;
    pagesBuilds: number;
    stateCommits: number;
  };
  state: {
    lastGoodHash: string;
  };
}>;

class HttpFixtureError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`HTTP fixture ${status.toString()}`);
    this.name = "HttpFixtureError";
    this.status = status;
  }
}

function defaultBehavior(): HarnessBehavior {
  return Object.freeze({
    aiStatus: "success",
    collectionFailure: Object.freeze({
      status: "none",
    }),
    completeness: "complete",
    deterministicResolution: "clear",
    failConfiguration: false,
    failRunCompletion: false,
    pagesFailureCount: 0,
  });
}

function createRuntimeClock(): Readonly<{
  runtime: DailyRunRuntime;
  currentTime: () => typeof NOW_UTC;
}> {
  let nextTimestamp = Date.parse(NOW);
  let currentTime = NOW_UTC;
  return Object.freeze({
    runtime: Object.freeze({
      now: () => {
        const value = new Date(nextTimestamp);
        currentTime = createUtcIsoDateTime(value.toISOString());
        nextTimestamp += 1000;
        return value;
      },
    }),
    currentTime: () => currentTime,
  });
}

function createHarness(behavior: HarnessBehavior): Harness {
  const clock = createRuntimeClock();
  const events: string[] = [];
  const reports: RunReport[] = [];
  const artifactPaths: string[] = [];
  const artifacts: unknown[] = [];
  const operationsRetryAttempts: number[] = [];
  const persistedCommands: OnlineCliCommand[] = [];
  const counters = {
    apiAttempts: 0,
    aiExternalCalls: 0,
    discordCalls: 0,
    pagesBuilds: 0,
    stateCommits: 0,
  };
  const state = {
    lastGoodHash: "sha256:last-good",
  };
  let remainingPagesFailures = behavior.pagesFailureCount;

  const dependencies = {
    validateConfiguration: () => {
      events.push("configuration");
      if (behavior.failConfiguration) {
        throw new TypeError("設定fixtureが不正です");
      }
      return Promise.resolve({
        schemaVersion: 1,
      });
    },
    loadState: () => {
      events.push("state");
      return Promise.resolve({
        lastGoodHash: state.lastGoodHash,
      });
    },
    authenticateGitHub: () => {
      events.push("authentication");
      return Promise.resolve({
        installationId: 1,
      });
    },
    collectRepositoryInventory: () => {
      events.push("repository_inventory");
      return Promise.resolve({
        value: Object.freeze(["VOICEVOX/voicevox", "VOICEVOX/voicevox_engine"]),
        repositoryCount: 2,
        githubApiRemaining: 4900,
      });
    },
    collectIncrementalItems: async () => {
      events.push("incremental_collection");
      if (behavior.collectionFailure.status !== "none") {
        const failureStatus = behavior.collectionFailure.status;
        await executeWithGitHubRetry(
          () => {
            counters.apiAttempts += 1;
            return Promise.reject(new HttpFixtureError(failureStatus));
          },
          {
            maxAttempts: 3,
            initialDelaySeconds: 0,
            maxDelaySeconds: 0,
          },
          {
            sleep: () => Promise.resolve(),
            random: () => 0,
            now: () => new Date(NOW),
          },
          new SecretRedactor([]),
        );
      }
      return {
        value: {
          itemIds: Object.freeze(["I_1", "I_2", "I_3"]),
        },
        itemCount: 3,
        changedItemCount: 1,
        githubApiRemaining: 4800,
        staleRepositoryCount: 0,
        diagnostics: Object.freeze([]),
      };
    },
    applyDeterministicRules: () => {
      events.push("deterministic_analysis");
      return Promise.resolve({
        resolution: behavior.deterministicResolution,
      });
    },
    analyzeWithCodex: ({ deterministicAnalysis }) => {
      events.push("codex_analysis");
      if (deterministicAnalysis.resolution === "ambiguous") {
        counters.aiExternalCalls += 1;
      }
      return Promise.resolve({
        status: behavior.aiStatus,
        value: {
          applied:
            behavior.aiStatus === "success" && deterministicAnalysis.resolution === "ambiguous",
        },
        aiCallCount: deterministicAnalysis.resolution === "ambiguous" ? 1 : 0,
        aiCacheHitCount: 0,
        aiRetainedResultCount: 0,
        estimatedInputTokens: deterministicAnalysis.resolution === "ambiguous" ? 250 : 0,
        diagnostics:
          behavior.aiStatus === "fallback"
            ? Object.freeze(["codex_unavailable"])
            : Object.freeze([]),
      });
    },
    reduceAnalysis: ({ collection }) => {
      events.push("reducer");
      return Promise.resolve({
        itemCount: collection.itemIds.length,
      });
    },
    reconcileGraph: () => {
      events.push("graph_analysis");
      return Promise.resolve({
        value: {
          activeEdgeCount: 4,
        },
        activeEdgeCount: 4,
      });
    },
    validateCompleteness: () => {
      events.push("completeness_validation");
      if (behavior.completeness === "incomplete") {
        return Promise.resolve({
          status: "incomplete",
          diagnostics: Object.freeze(["private_sentinel_detected"]),
        });
      }
      return Promise.resolve({
        status: "complete",
        value: {
          snapshotHash: "sha256:new-state",
        },
        diagnostics: Object.freeze([]),
      });
    },
    persistState: ({ invocation, validated }) => {
      events.push("state_persistence");
      counters.stateCommits += 1;
      state.lastGoodHash = validated.snapshotHash;
      persistedCommands.push(invocation.command);
      return Promise.resolve({
        revision: `revision-${counters.stateCommits.toString()}`,
      });
    },
    buildPages: () => {
      events.push("pages");
      counters.pagesBuilds += 1;
      if (remainingPagesFailures > 0) {
        remainingPagesFailures -= 1;
        throw new TypeError("Pages build fixtureが失敗しました");
      }
      return Promise.resolve({
        pagesUrl: "https://voicevox.github.io/voicevox_task_tracker/",
      });
    },
    sendDiscord: () => {
      events.push("discord");
      counters.discordCalls += 1;
      return Promise.resolve({
        value: {
          messageIds: Object.freeze(["discord-message-1"]),
        },
        notificationCount: 1,
        discordSentAt: clock.currentTime(),
      });
    },
    completeRun: () => {
      events.push("run_completion");
      if (behavior.failRunCompletion) {
        throw new TypeError("run完了reportの保存fixtureが失敗しました");
      }
      return Promise.resolve();
    },
    sendOperationsAlert: ({ retryAttempts }) => {
      events.push("operations_alert");
      operationsRetryAttempts.push(retryAttempts);
      counters.discordCalls += 1;
      return Promise.resolve({
        value: {
          messageIds: Object.freeze(["discord-operations-message-1"]),
        },
        notificationCount: 1,
        discordSentAt: clock.currentTime(),
      });
    },
    writeDryRunArtifact: (artifactPath, artifact) => {
      events.push("artifact");
      artifactPaths.push(artifactPath);
      artifacts.push(artifact);
      return Promise.resolve();
    },
    writeCollectAnalyzeArtifact: (artifactPath, artifact) => {
      events.push("artifact");
      artifactPaths.push(artifactPath);
      artifacts.push(artifact);
      return Promise.resolve();
    },
    writeReport: (_path, report) => {
      events.push("report");
      reports.push(report);
      return Promise.resolve();
    },
  } satisfies DailyTransactionDependencies<FixtureTypes>;

  return Object.freeze({
    runner: new DailyTransactionRunner<FixtureTypes>(dependencies, clock.runtime),
    events,
    reports,
    artifactPaths,
    artifacts,
    operationsRetryAttempts,
    persistedCommands,
    counters,
    state,
  });
}

function parseOnlineCommand(args: readonly string[]): OnlineCliCommand {
  const command = parseCliArguments(args);
  if (
    command.kind !== "daily" &&
    command.kind !== "dry-run" &&
    command.kind !== "backfill" &&
    command.kind !== "collect-analyze"
  ) {
    throw new TypeError("online commandではありません");
  }
  return command;
}

function scheduledArgs(command: "daily" | "dry-run"): readonly string[] {
  return Object.freeze([command, "--scheduled-for", SCHEDULED_FOR]);
}

function expectRequiredMetrics(report: RunReport): void {
  expect(Object.keys(report.metrics).sort()).toEqual([...REQUIRED_METRICS].sort());
  for (const value of Object.values(report.metrics)) {
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

describe("Daily transaction", () => {
  it("Daily transactionの全段階を決定論、Codex、公開副作用の順に実行する", async () => {
    const harness = createHarness(defaultBehavior());
    const result = await harness.runner.run(parseOnlineCommand(scheduledArgs("daily")));

    expect(result.value.report.status).toBe("success");
    expect(result.value.effects).toEqual({
      stateCommitted: true,
      pagesBuilt: true,
      discordAttempted: true,
      artifactWritten: false,
    });
    expect(harness.events).toEqual([
      "configuration",
      "state",
      "authentication",
      "repository_inventory",
      "incremental_collection",
      "deterministic_analysis",
      "codex_analysis",
      "reducer",
      "graph_analysis",
      "completeness_validation",
      "state_persistence",
      "pages",
      "discord",
      "run_completion",
      "report",
    ]);
    expect(harness.counters.aiExternalCalls).toBe(0);
    expect(result.value.report.metrics).toMatchObject({
      repositoryCount: 2,
      itemCount: 3,
      changedItemCount: 1,
      activeEdgeCount: 4,
      aiCallCount: 0,
      notificationCount: 1,
      githubApiRemaining: 4800,
    });
  });

  it("dry-runは検証済みartifactだけを書き、state、Pages、Discordを変更しない", async () => {
    const harness = createHarness(defaultBehavior());
    const result = await harness.runner.run(
      parseOnlineCommand([
        ...scheduledArgs("dry-run"),
        "--artifact",
        "artifacts/fixture-dry-run.json",
      ]),
    );

    expect(result.value.report.status).toBe("success");
    expect(result.value.effects).toEqual({
      stateCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: true,
    });
    expect(harness.artifactPaths).toEqual(["artifacts/fixture-dry-run.json"]);
    expect(harness.artifacts[0]).toMatchObject({
      schemaVersion: "1",
      command: "dry-run",
      status: "success",
      complete: true,
      result: {
        snapshotHash: "sha256:new-state",
      },
    });
    expect(harness.artifacts[0]).not.toHaveProperty("collection");
    expect(harness.artifacts[0]).not.toHaveProperty("repositoryInventory");
    expect(harness.counters.stateCommits).toBe(0);
    expect(harness.counters.pagesBuilds).toBe(0);
    expect(harness.counters.discordCalls).toBe(0);
    expect(harness.state.lastGoodHash).toBe("sha256:last-good");
  });

  it("collect-analyzeは検証済み成果物を書き、後続stageの副作用を実行しない", async () => {
    const harness = createHarness(defaultBehavior());
    const result = await harness.runner.run(
      parseOnlineCommand([
        "collect-analyze",
        "--mode",
        "none",
        "--artifact",
        "artifacts/workflow/validated-run.json",
        "--scheduled-for",
        SCHEDULED_FOR,
      ]),
    );

    expect(result.value.report.status).toBe("success");
    expect(result.value.effects).toEqual({
      stateCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: true,
    });
    expect(harness.artifactPaths).toEqual(["artifacts/workflow/validated-run.json"]);
    expect(harness.artifacts[0]).toMatchObject({
      validated: {
        snapshotHash: "sha256:new-state",
      },
      status: "success",
    });
    expect(harness.counters.stateCommits).toBe(0);
    expect(harness.counters.pagesBuilds).toBe(0);
    expect(harness.counters.discordCalls).toBe(0);
  });

  it("不完全なrunはdry-run artifactを残しても公開副作用へ進めない", async () => {
    const harness = createHarness({
      ...defaultBehavior(),
      completeness: "incomplete",
    });
    const result = await harness.runner.run(parseOnlineCommand(scheduledArgs("dry-run")));

    expect(result.value.report).toMatchObject({
      status: "failure",
      complete: false,
      failedStage: "completeness_validation",
    });
    expect(result.value.effects).toEqual({
      stateCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: true,
    });
    expect(harness.artifacts[0]).toMatchObject({
      status: "failure",
      complete: false,
      diagnostics: ["private_sentinel_detected"],
    });
    expect(harness.artifacts[0]).not.toHaveProperty("result");
    expect(harness.state.lastGoodHash).toBe("sha256:last-good");
  });

  it("同じrunを同時実行してもstate commitと通常digestを1回にする", async () => {
    const harness = createHarness({
      ...defaultBehavior(),
      deterministicResolution: "ambiguous",
    });
    const command = parseOnlineCommand(scheduledArgs("daily"));
    const [first, second] = await Promise.all([
      harness.runner.run(command),
      harness.runner.run(command),
    ]);
    const third = await harness.runner.run(command);

    expect([first.execution, second.execution].sort()).toEqual(["deduplicated", "executed"]);
    expect(third.execution).toBe("deduplicated");
    expect(first.value.report.runId).toBe(second.value.report.runId);
    expect(second.value.report.runId).toBe(third.value.report.runId);
    expect(harness.counters.stateCommits).toBe(1);
    expect(harness.counters.pagesBuilds).toBe(1);
    expect(harness.counters.discordCalls).toBe(1);
    expect(harness.state.lastGoodHash).toBe("sha256:new-state");
  });

  it("state commit後にPagesが失敗してもstateを戻さず再実行で公開を揃える", async () => {
    const harness = createHarness({
      ...defaultBehavior(),
      pagesFailureCount: 1,
    });
    const command = parseOnlineCommand(scheduledArgs("daily"));

    const first = await harness.runner.run(command);
    expect(first.value.report).toMatchObject({
      status: "failure",
      failedStage: "pages",
    });
    expect(first.value.effects).toEqual({
      stateCommitted: true,
      pagesBuilt: false,
      discordAttempted: true,
      artifactWritten: false,
    });
    expect(harness.state.lastGoodHash).toBe("sha256:new-state");

    const second = await harness.runner.run(command);
    expect(second.value.report.status).toBe("success");
    expect(harness.counters.stateCommits).toBe(2);
    expect(harness.counters.pagesBuilds).toBe(2);
    expect(harness.counters.discordCalls).toBe(2);
    expect(harness.events).toContain("operations_alert");
    expect(harness.operationsRetryAttempts).toEqual([1]);
    expect(harness.state.lastGoodHash).toBe("sha256:new-state");
  });

  it.each([429, 503] as const)("%iのretry上限後もlast goodを維持する", async (status) => {
    const harness = createHarness({
      ...defaultBehavior(),
      collectionFailure: {
        status,
      },
    });
    const result = await harness.runner.run(parseOnlineCommand(scheduledArgs("daily")));

    expect(result.value.report).toMatchObject({
      status: "failure",
      complete: false,
      failedStage: "incremental_collection",
    });
    expect(harness.counters.apiAttempts).toBe(3);
    expect(harness.counters.stateCommits).toBe(0);
    expect(harness.counters.pagesBuilds).toBe(0);
    expect(harness.counters.discordCalls).toBe(1);
    expect(harness.events).toContain("operations_alert");
    expect(harness.operationsRetryAttempts).toEqual([3]);
    expect(harness.state.lastGoodHash).toBe("sha256:last-good");
  });

  it("dry-run後のall-open backfillだけが指定範囲をcommitする", async () => {
    const harness = createHarness(defaultBehavior());
    await harness.runner.run(parseOnlineCommand(scheduledArgs("dry-run")));
    const result = await harness.runner.run(
      parseOnlineCommand([
        "backfill",
        "--mode",
        "all-open",
        "--repository",
        "VOICEVOX/voicevox_engine",
        "--scheduled-for",
        SCHEDULED_FOR,
      ]),
    );

    expect(harness.counters.stateCommits).toBe(1);
    expect(harness.persistedCommands).toHaveLength(1);
    expect(harness.persistedCommands[0]).toMatchObject({
      kind: "backfill",
      mode: "all-open",
      repositoryFilter: ["VOICEVOX/voicevox_engine"],
    });
    expect(result.value.report.status).toBe("success");
  });
});

describe("run report", () => {
  it("通知後の永続化失敗でも実送信数と実時間をfailure reportへ残す", async () => {
    const harness = createHarness({
      ...defaultBehavior(),
      failRunCompletion: true,
    });
    const report = (await harness.runner.run(parseOnlineCommand(scheduledArgs("daily")))).value
      .report;

    expect(report).toMatchObject({
      status: "failure",
      complete: false,
      failedStage: "state_persistence",
      startedAt: NOW,
      finishedAt: FINISHED_AT,
      discordSentAt: NOW,
      metrics: {
        notificationCount: 1,
        scheduleDelayMilliseconds: 3_600_000,
        durationMilliseconds: 1000,
      },
    });
  });

  it("成功、fallback、失敗のすべてで必須指標と遅延時刻を保持する", async () => {
    const successHarness = createHarness(defaultBehavior());
    const fallbackHarness = createHarness({
      ...defaultBehavior(),
      aiStatus: "fallback",
      deterministicResolution: "ambiguous",
    });
    const failureHarness = createHarness({
      ...defaultBehavior(),
      failConfiguration: true,
    });
    const command = parseOnlineCommand(scheduledArgs("daily"));
    const reports = [
      (await successHarness.runner.run(command)).value.report,
      (await fallbackHarness.runner.run(command)).value.report,
      (await failureHarness.runner.run(command)).value.report,
    ];

    expect(reports.map((report) => report.status)).toEqual(["success", "fallback", "failure"]);
    for (const report of reports) {
      expectRequiredMetrics(report);
      expect(report.scheduledFor).toBe(SCHEDULED_FOR);
      expect(report.startedAt).toBe(NOW);
      expect(report.finishedAt).toBe(FINISHED_AT);
      expect(report.metrics.scheduleDelayMilliseconds).toBe(3_600_000);
      expect(report.metrics.durationMilliseconds).toBe(1000);
      expect(Object.hasOwn(report, "discordSentAt")).toBe(true);
    }
    expect(reports[0]?.discordSentAt).toBe(NOW);
    expect(reports[1]?.diagnostics).toContain("codex_unavailable");
    expect(reports[2]?.discordSentAt).toBeNull();
  });
});

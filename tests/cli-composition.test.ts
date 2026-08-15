import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config/index.js";
import {
  sendDiscordDigest,
  type DiscordWebhookHttpRequest,
  type DiscordWebhookPayload,
} from "../src/discord/index.js";
import {
  createCliApplication,
  createWorkflowArtifact,
  type CliCompositionAdapters,
  type WorkflowArtifact,
} from "../src/cli/index.js";
import {
  createProductionCliApplication,
  normalDigestRunContext,
  type ProductionRuntimeAdapters,
} from "../src/cli/production-runtime.js";
import { createUtcIsoDateTime } from "../src/domain/index.js";
import { createPublicSummaryDto, measurePublicSummarySize } from "../src/pages/index.js";
import { CacheOnlyPersistenceSession, type StateBranchAdapter } from "../src/persistence/index.js";

const NOW = "2026-07-31T00:00:00.000Z";
const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "canary-private-key-material",
  "-----END PRIVATE KEY-----",
].join("\n");
const OPENAI_SECRET = "canary-openai-secret";
const validConfigUrl = new URL("./fixtures/config.valid.yml", import.meta.url);

type Harness = Readonly<{
  adapters: CliCompositionAdapters;
  reportSources: string[];
  externalAdapterCalls: Readonly<{
    count: number;
  }>;
}>;

function createHarness(environment: Readonly<NodeJS.ProcessEnv>): Harness {
  const reportSources: string[] = [];
  const externalAdapterCalls = {
    count: 0,
  };
  const failExternalAdapter = (): never => {
    externalAdapterCalls.count += 1;
    throw new TypeError("認証情報検証後のadapterが呼ばれました");
  };
  return Object.freeze({
    adapters: Object.freeze({
      environment,
      repositoryPath: join(import.meta.dirname, ".."),
      pagesOutputDirectory: "unused-pages",
      createGitHubClient: failExternalAdapter,
      createStateBranchAdapter: failExternalAdapter,
      codexProcessRunner: failExternalAdapter,
      discordHttpClient: Object.freeze({
        execute: failExternalAdapter,
      }),
      now: () => new Date(NOW),
      sleep: () => Promise.resolve(),
      random: () => 0,
      writeStandardOutput: () => Promise.resolve(),
      writeJsonArtifact: () => Promise.resolve(),
      writeTextFile: (_path: string, source: string) => {
        reportSources.push(source);
        return Promise.resolve();
      },
      writePublicData: failExternalAdapter,
      sendDiscord: failExternalAdapter,
    }),
    reportSources,
    externalAdapterCalls,
  });
}

async function createTemporaryAuthJsonConfiguration(
  authJsonExists: boolean,
): Promise<Readonly<{ configPath: string; codexHome: string }>> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-task-tracker-auth-json-test-"));
  const source = await readFile(validConfigUrl, "utf8");
  const authJsonSource = source.replace("  authentication: api-key", "  authentication: auth-json");
  if (authJsonSource === source) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("認証方式を置換できませんでした");
  }
  const configPath = join(directory, "config.yml");
  await writeFile(configPath, authJsonSource, "utf8");
  if (authJsonExists) {
    await writeFile(join(directory, "auth.json"), "", "utf8");
  }
  return Object.freeze({
    configPath,
    codexHome: directory,
  });
}

function withoutExplicitIncludes(config: Config): Config {
  return {
    ...config,
    tracking: {
      ...config.tracking,
      include: [],
    },
  };
}

function createMissingStateAdapter(onCommit: () => void): StateBranchAdapter {
  return Object.freeze({
    resolveHead: () =>
      Promise.resolve(
        Object.freeze({
          status: "missing",
        }),
      ),
    readFile: () =>
      Promise.resolve(
        Object.freeze({
          status: "missing",
        }),
      ),
    listFiles: () => Promise.resolve(Object.freeze([])),
    commit: () => {
      onCommit();
      return Promise.resolve(
        Object.freeze({
          revision: "0000000000000000000000000000000000000001",
          branchCreated: true,
        }),
      );
    },
  });
}

function createMutableStateAdapter(onCommit: () => void): StateBranchAdapter &
  Readonly<{
    currentPaths: () => readonly string[];
    seedCurrentFile: (path: string, bytes: Uint8Array) => void;
  }> {
  const files = new Map<string, Uint8Array>();
  let revision: string | undefined;
  return Object.freeze({
    resolveHead: () =>
      Promise.resolve(
        revision == null
          ? Object.freeze({
              status: "missing",
            })
          : Object.freeze({
              status: "present",
              revision,
            }),
      ),
    readFile: (_resolvedRevision, path) => {
      const bytes = files.get(path);
      return Promise.resolve(
        bytes == null
          ? Object.freeze({
              status: "missing",
            })
          : Object.freeze({
              status: "present",
              bytes,
            }),
      );
    },
    listFiles: (_resolvedRevision, directory) =>
      Promise.resolve(
        Object.freeze([...files.keys()].filter((path) => path.startsWith(`${directory}/`))),
      ),
    currentPaths: () => Object.freeze([...files.keys()].sort()),
    seedCurrentFile: (path, bytes) => {
      files.set(path, Uint8Array.from(bytes));
      revision = "0000000000000000000000000000000000000001";
    },
    commit: (request) => {
      for (const update of request.updates) {
        files.set(update.path, Uint8Array.from(update.bytes));
      }
      for (const path of request.deletions) {
        files.delete(path);
      }
      revision = "0000000000000000000000000000000000000001";
      onCommit();
      return Promise.resolve(
        Object.freeze({
          revision,
          branchCreated: true,
        }),
      );
    },
  });
}

const openCacheSession: ProductionRuntimeAdapters["openCacheSession"] = (
  adapter,
  configuration,
  allowlist,
) => CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

function createUnavailableProductionRuntimeAdapters(
  harness: Harness,
  stateAdapter: StateBranchAdapter,
): ProductionRuntimeAdapters {
  return Object.freeze({
    ...harness.adapters,
    loadConfig,
    openCacheSession,
    discoverRepositoryInventory: () =>
      Promise.reject(new TypeError("GitHub inventoryは呼びません")),
    enumerateGitHubItemsByIdentifiers: () =>
      Promise.reject(new TypeError("個別項目は収集しません")),
    enumerateOpenGitHubItems: () => Promise.reject(new TypeError("項目は収集しません")),
    probeGitHubPullRequestVolatileMetadataWithRetry: () =>
      Promise.reject(new TypeError("Pull Request volatile metadataは収集しません")),
    collectGitHubItemDetails: () => Promise.reject(new TypeError("詳細は収集しません")),
    executeCodexAnalysis: () => Promise.reject(new TypeError("Codexは実行しません")),
    readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
    readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
    readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
    readWorkflowArtifact: () => Promise.reject(new TypeError("workflow artifactは読みません")),
    verifyStateDirectory: () => Promise.reject(new TypeError("永続stateは検証しません")),
    createStateBranchAdapter: () => stateAdapter,
  });
}

function createEmptyWorkflowArtifact(
  runId: string,
  reason: "no_candidates" | "manual" | "rerun",
): WorkflowArtifact {
  const repositoryId = "R_composition_fixture";
  const repositoryOwner = "VOICEVOX";
  const repositoryName = "voicevox_task_tracker";
  const summary = createPublicSummaryDto({
    schemaVersion: "5",
    runId,
    generatedAt: NOW,
    observedAt: NOW,
    timezone: "Asia/Tokyo",
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    confidenceThresholds: {
      high: 0.8,
      medium: 0.5,
    },
    repositories: [
      {
        id: repositoryId,
        name: repositoryName,
        fullName: `${repositoryOwner}/${repositoryName}`,
        freshness: {
          status: "fresh",
        },
      },
    ],
    items: [],
    graph: {
      nodes: [],
      maxNodes: 1,
    },
  });
  const metrics = {
    repositoryCount: 1,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    aiRetainedResultCount: 0,
    estimatedInputTokens: 0,
    githubApiRemaining: 0,
    staleRepositoryCount: 0,
    scheduleDelayMilliseconds: 0,
  };
  return createWorkflowArtifact({
    schemaVersion: "2",
    kind: "validated_public_run",
    repositoryAllowlist: [
      {
        id: repositoryId,
        owner: repositoryOwner,
        name: repositoryName,
      },
    ],
    snapshot: {
      schemaVersion: "8",
      generatedAt: NOW,
      trackingStartAt: {
        status: "fixed",
        value: "2025-12-31T15:00:00.000Z",
        source: "configuration",
      },
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
      collection: {
        repositories: [
          {
            repositoryId,
            successfulAt: NOW,
            items: [],
          },
        ],
      },
      repositories: [
        {
          id: repositoryId,
          owner: repositoryOwner,
          name: repositoryName,
          visibility: "public",
          archived: false,
          disabled: false,
          observedAt: NOW,
          freshness: "fresh",
        },
      ],
      items: [],
      externalReferences: [],
      relations: [],
      run: {
        id: runId,
        status: "success",
        complete: true,
      },
    },
    notificationSelection: {
      action: "skip_digest",
      reason,
      candidates: [],
    },
    runMetadata: {
      scheduledFor: NOW,
      startedAt: NOW,
      metrics,
      diagnostics: [],
    },
    pages: {
      summary,
      details: {
        schemaVersion: "5",
        runId,
        generatedAt: NOW,
        items: [],
        graph: {
          nodes: [],
          edges: [],
          frontierNodeIds: [],
        },
      },
      summarySize: measurePublicSummarySize(summary, 1_000_000),
    },
    cacheOnlyPayload: {
      repositoryCaches: [
        {
          schemaVersion: "3",
          kind: "github_repository",
          repository: {
            repositoryId,
            owner: repositoryOwner,
            name: repositoryName,
          },
          successfulAt: NOW,
          items: [],
        },
      ],
      itemCaches: [],
      latestImportanceCaches: [],
      aiCacheEntries: [],
    },
    pagesUrl: "https://voicevox.github.io/voicevox_task_tracker/",
    discordSettings: {
      enabled: true,
      webhookSecretName: "DISCORD_WEBHOOK_URL",
      operationsWebhookSecretName: "DISCORD_OPERATIONS_WEBHOOK_URL",
      mentions: {
        enabled: false,
        users: {},
      },
      retry: {
        maxAttempts: 3,
        initialDelaySeconds: 1,
        maxDelaySeconds: 10,
      },
    },
  });
}

describe("CLI合成root", () => {
  it("通常digestのworkflow環境変数を検証し、manualとscheduleを扱う", () => {
    const scheduledFor = createUtcIsoDateTime("2026-07-31T23:00:00.000Z");

    expect(() => normalDigestRunContext({ GITHUB_RUN_ATTEMPT: "1" }, scheduledFor)).toThrow(
      "GITHUB_EVENT_NAMEはworkflow_dispatchまたはscheduleを指定してください",
    );
    expect(
      normalDigestRunContext(
        { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1" },
        scheduledFor,
      ),
    ).toEqual({
      eventName: "workflow_dispatch",
      runAttempt: 1,
    });
    expect(
      normalDigestRunContext(
        { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ATTEMPT: "2" },
        scheduledFor,
      ),
    ).toEqual({
      eventName: "schedule",
      runAttempt: 2,
      scheduledFor,
    });
    expect(() =>
      normalDigestRunContext({ GITHUB_EVENT_NAME: "push", GITHUB_RUN_ATTEMPT: "1" }, scheduledFor),
    ).toThrow("GITHUB_EVENT_NAMEはworkflow_dispatchまたはscheduleを指定してください");
    expect(() => normalDigestRunContext({ GITHUB_EVENT_NAME: "schedule" }, scheduledFor)).toThrow(
      "GITHUB_RUN_ATTEMPTを指定してください",
    );
  });

  it("GitHub App認証情報が無い場合は環境変数名を示して失敗する", async () => {
    const harness = createHarness({});
    const application = createCliApplication(harness.adapters);

    const result = await application.run([
      "daily",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--report",
      "unused-report.json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.command).toBe("daily");
    expect(harness.externalAdapterCalls.count).toBe(0);
    expect(harness.reportSources).toHaveLength(1);
    if (result.command !== "daily") {
      throw new TypeError("dailyの実行結果ではありません");
    }
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "configuration",
    });
    expect(result.result.report.diagnostics.join("\n")).toContain("GH_APP_ID");
  });

  it("api-key認証でOPENAI_API_KEYが無い場合は失敗する", async () => {
    const harness = createHarness({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      HOME: "/tmp",
      PATH: "/usr/bin",
    });
    const application = createCliApplication(harness.adapters);

    const result = await application.run([
      "dry-run",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--artifact",
      "unused-artifact.json",
      "--report",
      "unused-report.json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(harness.externalAdapterCalls.count).toBe(0);
    expect(harness.reportSources.join("\n")).toContain("OPENAI_API_KEY");
  });

  it("auth-json認証ではOPENAI_API_KEY無しでCodex CLIの事前確認へ進む", async () => {
    const temporaryConfiguration = await createTemporaryAuthJsonConfiguration(true);
    try {
      const versionEnvironments: Readonly<NodeJS.ProcessEnv>[] = [];
      const harness = createHarness({
        GH_APP_ID: "123",
        GH_APP_PRIVATE_KEY: PRIVATE_KEY,
        CODEX_HOME: temporaryConfiguration.codexHome,
        HOME: "/tmp",
        PATH: "/usr/bin",
      });
      const application = createCliApplication({
        ...harness.adapters,
        codexProcessRunner: (request) => {
          versionEnvironments.push(request.environment);
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            timedOut: false,
          });
        },
      });

      const result = await application.run([
        "dry-run",
        "--config",
        temporaryConfiguration.configPath,
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
      ]);

      expect(result.exitCode).toBe(1);
      expect(versionEnvironments).toEqual([
        {
          CODEX_HOME: temporaryConfiguration.codexHome,
          HOME: "/tmp",
          PATH: "/usr/bin",
        },
      ]);
      expect(versionEnvironments[0]).not.toHaveProperty("OPENAI_API_KEY");
      expect(harness.externalAdapterCalls.count).toBe(1);
    } finally {
      await rm(temporaryConfiguration.codexHome, { recursive: true, force: true });
    }
  });

  it("auth-json認証でauth.jsonが無い場合は起動前に失敗する", async () => {
    const temporaryConfiguration = await createTemporaryAuthJsonConfiguration(false);
    try {
      const harness = createHarness({
        GH_APP_ID: "123",
        GH_APP_PRIVATE_KEY: PRIVATE_KEY,
        CODEX_HOME: temporaryConfiguration.codexHome,
        HOME: "/tmp",
        PATH: "/usr/bin",
      });
      const application = createCliApplication(harness.adapters);

      const result = await application.run([
        "dry-run",
        "--config",
        temporaryConfiguration.configPath,
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
      ]);

      expect(result.exitCode).toBe(1);
      expect(harness.externalAdapterCalls.count).toBe(0);
      expect(harness.reportSources.join("\n")).toContain("CODEX_HOME直下にauth.json");
    } finally {
      await rm(temporaryConfiguration.codexHome, { recursive: true, force: true });
    }
  });

  it("指定済みsecretを診断やreportへ出さない", async () => {
    const harness = createHarness({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      GH_APP_INSTALLATION_ID: "456",
      HOME: "/tmp",
      OPENAI_API_KEY: OPENAI_SECRET,
      PATH: "/usr/bin",
    });
    const application = createCliApplication(harness.adapters);

    const result = await application.run([
      "daily",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--report",
      "unused-report.json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(harness.externalAdapterCalls.count).toBe(0);
    const reportSource = harness.reportSources.join("\n");
    expect(reportSource).toContain("DISCORD_WEBHOOK_URL");
    expect(reportSource).not.toContain(PRIVATE_KEY);
    expect(reportSource).not.toContain(OPENAI_SECRET);
  });

  it("AI有効時にCodex CLIを起動できなければ明示的に失敗する", async () => {
    const harness = createHarness({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      HOME: "/tmp",
      OPENAI_API_KEY: OPENAI_SECRET,
      PATH: "/usr/bin",
    });
    const application = createCliApplication(harness.adapters);

    const result = await application.run([
      "dry-run",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--artifact",
      "unused-artifact.json",
      "--report",
      "unused-report.json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(harness.externalAdapterCalls.count).toBe(1);
    expect(harness.reportSources.join("\n")).toContain("実行可能ファイル");
    expect(harness.reportSources.join("\n")).toContain("codex");
  });

  it("dry-runは実行配線を完走して公開副作用を呼ばない", async () => {
    let stateCommitCount = 0;
    let pagesWriteCount = 0;
    let discordSendCount = 0;
    let codexProcessCount = 0;
    const artifacts: unknown[] = [];
    const harness = createHarness({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      HOME: "/tmp",
      OPENAI_API_KEY: OPENAI_SECRET,
      PATH: "/usr/bin",
    });
    const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
      ...harness.adapters,
      loadConfig: async (path) => withoutExplicitIncludes(await loadConfig(path)),
      openCacheSession,
      discoverRepositoryInventory: () => Promise.resolve(Object.freeze([])),
      enumerateGitHubItemsByIdentifiers: () => Promise.resolve(Object.freeze([])),
      enumerateOpenGitHubItems: () => Promise.resolve(Object.freeze([])),
      probeGitHubPullRequestVolatileMetadataWithRetry: () =>
        Promise.reject(new TypeError("Pull Request volatile metadataは収集しません")),
      collectGitHubItemDetails: () =>
        Promise.resolve(
          Object.freeze({
            capabilities: Object.freeze({
              nativeDependencies: "unavailable",
              nativeHierarchy: "unavailable",
            }),
            items: Object.freeze([]),
          }),
        ),
      executeCodexAnalysis: () => Promise.reject(new TypeError("Codex adapterは呼ばれません")),
      readWorkflowArtifact: () => Promise.reject(new TypeError("workflow artifactは読みません")),
      verifyStateDirectory: () => Promise.reject(new TypeError("永続stateは検証しません")),
      readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
      readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
      readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
      createGitHubClient: () =>
        Promise.resolve(
          Object.freeze({
            installationId: 123,
            request: () => Promise.reject(new TypeError("GitHub RESTへ接続しません")),
            graphql: () => Promise.reject(new TypeError("GitHub GraphQLへ接続しません")),
            getRateLimitSnapshot: () => undefined,
          }),
        ),
      createStateBranchAdapter: () =>
        createMissingStateAdapter(() => {
          stateCommitCount += 1;
        }),
      codexProcessRunner: (request) => {
        if (request.arguments.length === 1 && request.arguments[0] === "--version") {
          expect(request.environment).toEqual({
            HOME: "/tmp",
            OPENAI_API_KEY: OPENAI_SECRET,
            PATH: "/usr/bin",
          });
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            timedOut: false,
          });
        }
        codexProcessCount += 1;
        return Promise.reject(new TypeError("Codex subprocessは起動しません"));
      },
      writeJsonArtifact: (_path, value) => {
        artifacts.push(value);
        return Promise.resolve();
      },
      writePublicData: () => {
        pagesWriteCount += 1;
        return Promise.reject(new TypeError("Pagesは書きません"));
      },
      sendDiscord: async () => {
        discordSendCount += 1;
        return Promise.reject(new TypeError("Discordへ送信しません"));
      },
    });
    const application = createProductionCliApplication(runtimeAdapters);

    const result = await application.run([
      "dry-run",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--artifact",
      "unused-artifact.json",
      "--report",
      "unused-report.json",
      "--scheduled-for",
      "2026-07-30T23:00:00.000Z",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("dry-run");
    if (result.command !== "dry-run") {
      throw new TypeError("dry-runの実行結果ではありません");
    }
    expect(result.result.effects).toEqual({
      cacheCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: true,
    });
    expect(artifacts).toHaveLength(1);
    expect(stateCommitCount).toBe(0);
    expect(pagesWriteCount).toBe(0);
    expect(discordSendCount).toBe(0);
    expect(codexProcessCount).toBe(0);
  });

  it.each(["manual", "rerun"] satisfies readonly ["manual", "rerun"])(
    "検証済みartifactからPagesを構築し%sの空候補を通常送信しない",
    async (reason) => {
      let pagesWriteCount = 0;
      let discordHttpCallCount = 0;
      const artifact = createEmptyWorkflowArtifact(
        "tracker-run:composition-workflow-stage",
        reason,
      );
      const harness = createHarness({});
      const stateAdapter = createMutableStateAdapter(() => {
        throw new TypeError("PagesとDiscordはcacheを更新しません");
      });
      const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
        ...createUnavailableProductionRuntimeAdapters(harness, stateAdapter),
        readWorkflowArtifact: () => Promise.resolve(artifact),
        writePublicData: (_outputDirectory, data) => {
          pagesWriteCount += 1;
          expect(data).toEqual(artifact.pages);
          return Promise.resolve({
            summaryPath: "web/public/data/summary.json",
            detailsPath: "web/public/data/details.json",
            summaryBytes: 1,
            detailsBytes: 1,
          });
        },
        discordHttpClient: Object.freeze({
          execute: () => {
            discordHttpCallCount += 1;
            throw new TypeError("manualの空候補はDiscord secretを読みません");
          },
        }),
        sendDiscord: sendDiscordDigest,
      });
      const application = createProductionCliApplication(runtimeAdapters);

      const pagesResult = await application.run([
        "build-pages",
        "--config",
        "tests/fixtures/config.valid.yml",
        "--output",
        "unused-pages",
      ]);
      const notifyResult = await application.run([
        "notify-discord",
        "--config",
        "tests/fixtures/config.valid.yml",
        "--pages-url",
        "https://voicevox.github.io/voicevox_task_tracker/",
      ]);

      expect([pagesResult.exitCode, notifyResult.exitCode]).toEqual([0, 0]);
      expect(pagesWriteCount).toBe(1);
      expect(discordHttpCallCount).toBe(0);
      expect((await stateAdapter.resolveHead("tracker-state-v3")).status).toBe("missing");
      expect(harness.externalAdapterCalls.count).toBe(0);
    },
  );

  it("persist-cacheはartifactのcache-only payloadだけでbranchを完全置換する", async () => {
    let stateCommitCount = 0;
    const artifact = createEmptyWorkflowArtifact(
      "tracker-run:composition-workflow-stage",
      "manual",
    );
    const stateAdapter = createMutableStateAdapter(() => {
      stateCommitCount += 1;
    });
    for (const path of [
      "state/snapshot.json",
      "state/history/2026-07-31.jsonl",
      "state/notification-ledger.json",
      "state/run-reports/2026-07-31.json",
    ]) {
      stateAdapter.seedCurrentFile(path, new TextEncoder().encode("旧state"));
    }
    const harness = createHarness({});
    const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
      ...createUnavailableProductionRuntimeAdapters(harness, stateAdapter),
      readWorkflowArtifact: () => Promise.resolve(artifact),
    });
    const application = createProductionCliApplication(runtimeAdapters);

    const result = await application.run([
      "persist-cache",
      "--config",
      "tests/fixtures/config.valid.yml",
    ]);

    const paths = stateAdapter.currentPaths();
    expect(result.exitCode).toBe(0);
    expect(stateCommitCount).toBe(1);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^state\/github-repositories\/[^/]+\.json$/u);
    expect(paths).not.toContain("state/snapshot.json");
    expect(paths).not.toContain("state/notification-ledger.json");
    expect(paths).not.toContain("state/run-reports/2026-07-31.json");
    expect(paths).not.toContain("state/history/2026-07-31.jsonl");
    expect(harness.externalAdapterCalls.count).toBe(0);
  });

  it.each([
    {
      stateStatus: "available",
      incidentKind: "collection",
      incidentId: "workflow-run-123:collection",
      processName: "GitHub収集",
      summary: "GitHub収集がretry上限に達したため、公開処理を停止しました",
      expectedStateCommitCount: 1,
    },
    {
      stateStatus: "available",
      incidentKind: "discord",
      incidentId: "workflow-run-123:discord",
      processName: "Discord通知",
      summary: "通常digestのDiscord送信がretry上限に達しました",
      expectedStateCommitCount: 1,
    },
    {
      stateStatus: "missing_branch",
      incidentKind: "collection",
      incidentId: "workflow-run-initial:collection",
      processName: "GitHub収集",
      summary: "GitHub収集がretry上限に達したため、公開処理を停止しました",
      expectedStateCommitCount: 0,
    },
  ])(
    "$stateStatusの$incidentKind運用障害通知はcache有無に依存せず毎回送る",
    async ({
      stateStatus,
      incidentKind,
      incidentId,
      processName,
      summary,
      expectedStateCommitCount,
    }) => {
      let stateCommitCount = 0;
      const payloads: DiscordWebhookPayload[] = [];
      const artifact = createEmptyWorkflowArtifact(
        "tracker-run:composition-workflow-stage",
        "manual",
      );
      const operationsWebhookUrl =
        "https://discord.com/api/webhooks/123456789012345678/operations-fixture-token";
      const harness = createHarness({
        DISCORD_OPERATIONS_WEBHOOK_URL: operationsWebhookUrl,
      });
      const stateAdapter = createMutableStateAdapter(() => {
        stateCommitCount += 1;
      });
      const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
        ...harness.adapters,
        loadConfig,
        openCacheSession,
        discoverRepositoryInventory: () =>
          Promise.reject(new TypeError("GitHub inventoryは呼びません")),
        enumerateGitHubItemsByIdentifiers: () =>
          Promise.reject(new TypeError("個別項目は収集しません")),
        enumerateOpenGitHubItems: () => Promise.reject(new TypeError("項目は収集しません")),
        probeGitHubPullRequestVolatileMetadataWithRetry: () =>
          Promise.reject(new TypeError("Pull Request volatile metadataは収集しません")),
        collectGitHubItemDetails: () => Promise.reject(new TypeError("詳細は収集しません")),
        executeCodexAnalysis: () => Promise.reject(new TypeError("Codexは実行しません")),
        readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
        readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
        readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
        readWorkflowArtifact: () => Promise.resolve(artifact),
        verifyStateDirectory: () => Promise.reject(new TypeError("永続stateは検証しません")),
        createStateBranchAdapter: () => stateAdapter,
        discordHttpClient: Object.freeze({
          execute: (request: DiscordWebhookHttpRequest) => {
            payloads.push(request.payload);
            return Promise.resolve(
              Object.freeze({
                status: 200,
                retryAfter: undefined,
                body: Object.freeze({
                  id: "123456789012345678",
                }),
              }),
            );
          },
        }),
        sendDiscord: sendDiscordDigest,
      });
      const application = createProductionCliApplication(runtimeAdapters);

      if (stateStatus === "available") {
        await application.run(["persist-cache", "--config", "tests/fixtures/config.valid.yml"]);
      }
      const command = [
        "notify-operations",
        "--config",
        "tests/fixtures/config.valid.yml",
        "--kind",
        incidentKind,
        "--incident-id",
        incidentId,
        "--occurred-at",
        NOW,
        "--retry-attempts",
        "3",
      ];
      const first = await application.run(command);
      const second = await application.run(command);
      const head = await stateAdapter.resolveHead("tracker-state-v3");

      expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
      expect(head.status).toBe(stateStatus === "available" ? "present" : "missing");
      expect(payloads).toHaveLength(2);
      expect(payloads[0]?.content).toContain("VOICEVOX Task Tracker 運用障害");
      expect(payloads[0]?.embeds[0]?.fields).toContainEqual(
        expect.objectContaining({
          name: "処理",
          value: processName,
        }),
      );
      expect(payloads[0]?.embeds[0]?.fields).toContainEqual(
        expect.objectContaining({
          name: "概要",
          value: summary,
        }),
      );
      expect(stateCommitCount).toBe(expectedStateCommitCount);
    },
  );
});

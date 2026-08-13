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
import {
  StatePersistenceSession,
  createStateRunReport,
  type StateBranchAdapter,
} from "../src/persistence/index.js";

const NOW = "2026-07-31T00:00:00.000Z";
const COMPLETED_AT = "2026-07-31T00:05:00.000Z";
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

function createMutableStateAdapter(
  onCommit: () => void,
): StateBranchAdapter & Readonly<{ readCurrentFile: (path: string) => Uint8Array | undefined }> {
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
    readCurrentFile: (path) => files.get(path),
    commit: (request) => {
      for (const update of request.updates) {
        files.set(update.path, update.bytes);
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

function createEmptyWorkflowArtifact(runId: string): WorkflowArtifact {
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
    schemaVersion: "1",
    kind: "validated_public_run",
    repositoryAllowlist: [
      {
        id: "R_composition_fixture",
        owner: "VOICEVOX",
        name: "voicevox_task_tracker",
      },
    ],
    historyInputEvents: [],
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
        repositories: [],
      },
      repositories: [
        {
          id: "R_composition_fixture",
          owner: "VOICEVOX",
          name: "voicevox_task_tracker",
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
      reason: "no_candidates",
      candidates: [],
    },
    runMetadata: {
      scheduledFor: NOW,
      startedAt: NOW,
      metrics,
      diagnostics: [],
    },
    aiCacheEntries: [],
    pagesUrl: "https://voicevox.github.io/voicevox_task_tracker/",
    discordSettings: {
      enabled: true,
      webhookSecretName: "DISCORD_WEBHOOK_URL",
      operationsWebhookSecretName: "DISCORD_OPERATIONS_WEBHOOK_URL",
      mentions: {
        enabled: false,
        users: {
          Hiroshiba: "123456789012345678",
        },
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
  it("GITHUB_EVENT_NAME未設定はmanual扱いにし、明示されないworkflow eventは拒否する", () => {
    const scheduledFor = createUtcIsoDateTime("2026-07-31T23:00:00.000Z");

    expect(normalDigestRunContext({}, scheduledFor)).toEqual({
      eventName: "workflow_dispatch",
      runAttempt: 1,
    });
    expect(
      normalDigestRunContext({ GITHUB_EVENT_NAME: "workflow_dispatch" }, scheduledFor),
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
    expect(() => normalDigestRunContext({ GITHUB_EVENT_NAME: "push" }, scheduledFor)).toThrow(
      "通常digestに対応しないworkflow eventです: push",
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
      HOME: "/tmp",
      OPENAI_API_KEY: OPENAI_SECRET,
      PATH: "/usr/bin",
    });
    const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
      ...harness.adapters,
      loadConfig: async (path) => withoutExplicitIncludes(await loadConfig(path)),
      openStateSession: (adapter: StateBranchAdapter, configuration: Config["state"]) =>
        StatePersistenceSession.open(adapter, configuration),
      discoverRepositoryInventory: () => Promise.resolve(Object.freeze([])),
      enumerateGitHubItemsByIdentifiers: () => Promise.resolve(Object.freeze([])),
      enumerateOpenGitHubItems: () => Promise.resolve(Object.freeze([])),
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
      stateCommitted: false,
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

  it("設定されたstartAtをDiscord失敗時にも維持する", async () => {
    let stateCommitCount = 0;
    let pagesWriteCount = 0;
    let discordSendCount = 0;
    let discordFails = true;
    let artifact = createEmptyWorkflowArtifact("tracker-run:composition-workflow-stage");
    const harness = createHarness({});
    const stateAdapter = createMutableStateAdapter(() => {
      stateCommitCount += 1;
    });
    const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
      ...harness.adapters,
      loadConfig,
      openStateSession: (adapter: StateBranchAdapter, configuration: Config["state"]) =>
        StatePersistenceSession.open(adapter, configuration),
      discoverRepositoryInventory: () =>
        Promise.reject(new TypeError("GitHub inventoryは呼びません")),
      enumerateGitHubItemsByIdentifiers: () =>
        Promise.reject(new TypeError("個別項目は収集しません")),
      enumerateOpenGitHubItems: () => Promise.reject(new TypeError("項目は収集しません")),
      collectGitHubItemDetails: () => Promise.reject(new TypeError("詳細は収集しません")),
      executeCodexAnalysis: () => Promise.reject(new TypeError("Codexは実行しません")),
      readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
      readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
      readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
      readWorkflowArtifact: () => Promise.resolve(artifact),
      verifyStateDirectory: () => Promise.reject(new TypeError("永続stateは検証しません")),
      createStateBranchAdapter: () => stateAdapter,
      now: () => new Date(COMPLETED_AT),
      writePublicData: () => {
        pagesWriteCount += 1;
        return Promise.resolve({
          summaryPath: "web/public/data/summary.json",
          detailsPath: "web/public/data/details.json",
          summaryBytes: 1,
          detailsBytes: 1,
        });
      },
      sendDiscord: () => {
        discordSendCount += 1;
        if (discordFails) {
          return Promise.reject(new TypeError("Discord送信fixtureが失敗しました"));
        }
        return Promise.resolve(
          Object.freeze({
            status: "sent",
            digestId: "digest-composition",
            discordMessageIds: Object.freeze(["discord-message-composition"]),
          }),
        );
      },
    });
    const application = createProductionCliApplication(runtimeAdapters);

    const persistResult = await application.run([
      "persist-state",
      "--config",
      "tests/fixtures/config.valid.yml",
    ]);
    const pagesResult = await application.run([
      "build-pages",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--output",
      "unused-pages",
    ]);
    await expect(
      application.run([
        "notify-discord",
        "--config",
        "tests/fixtures/config.valid.yml",
        "--pages-url",
        "https://voicevox.github.io/voicevox_task_tracker/",
      ]),
    ).rejects.toThrow("Discord送信fixtureが失敗しました");
    const failedRunSession = await StatePersistenceSession.open(
      stateAdapter,
      (await loadConfig(join(import.meta.dirname, "fixtures/config.valid.yml"))).state,
    );
    const failedRunSnapshot = await failedRunSession.loadSnapshot();
    if (failedRunSnapshot.status !== "available") {
      throw new TypeError("失敗runのsnapshotがありません");
    }
    expect(failedRunSnapshot.snapshot.trackingStartAt).toEqual({
      status: "fixed",
      value: "2025-12-31T15:00:00.000Z",
      source: "configuration",
    });

    discordFails = false;
    const notifyResult = await application.run([
      "notify-discord",
      "--config",
      "tests/fixtures/config.valid.yml",
      "--pages-url",
      "https://voicevox.github.io/voicevox_task_tracker/",
    ]);
    const successfulRunSession = await StatePersistenceSession.open(
      stateAdapter,
      (await loadConfig(join(import.meta.dirname, "fixtures/config.valid.yml"))).state,
    );
    const successfulRunSnapshot = await successfulRunSession.loadSnapshot();
    if (successfulRunSnapshot.status !== "available") {
      throw new TypeError("成功runのsnapshotがありません");
    }
    const reportSource = stateAdapter.readCurrentFile("state/run-reports/2026-07-31.json");
    if (reportSource == null) {
      throw new TypeError("成功runの永続reportがありません");
    }
    const parseJson: (source: string) => unknown = JSON.parse;
    const persistedReport = createStateRunReport(parseJson(new TextDecoder().decode(reportSource)));

    expect([persistResult.exitCode, pagesResult.exitCode, notifyResult.exitCode]).toEqual([
      0, 0, 0,
    ]);
    expect(successfulRunSnapshot.snapshot.trackingStartAt).toEqual({
      status: "fixed",
      value: "2025-12-31T15:00:00.000Z",
      source: "configuration",
    });
    expect(persistedReport).toMatchObject({
      startedAt: NOW,
      finishedAt: COMPLETED_AT,
      metrics: {
        notificationCount: 0,
        durationMilliseconds: 300_000,
      },
    });
    expect(stateCommitCount).toBe(2);
    expect(pagesWriteCount).toBe(1);
    expect(discordSendCount).toBe(2);

    artifact = createEmptyWorkflowArtifact("tracker-run:different-workflow-stage");
    await expect(
      application.run([
        "notify-discord",
        "--config",
        "tests/fixtures/config.valid.yml",
        "--pages-url",
        "https://voicevox.github.io/voicevox_task_tracker/",
      ]),
    ).rejects.toThrow(
      "Discord通知対象のworkflow artifactとtracker-state branchでrunが一致しません",
    );
    expect(discordSendCount).toBe(2);
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
    "$stateStatusの$incidentKind運用障害stageは送信済み状態を保持せず毎回送る",
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
      const artifact = createEmptyWorkflowArtifact("tracker-run:composition-workflow-stage");
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
        openStateSession: (adapter, configuration) =>
          StatePersistenceSession.open(adapter, configuration),
        discoverRepositoryInventory: () =>
          Promise.reject(new TypeError("GitHub inventoryは呼びません")),
        enumerateGitHubItemsByIdentifiers: () =>
          Promise.reject(new TypeError("個別項目は収集しません")),
        enumerateOpenGitHubItems: () => Promise.reject(new TypeError("項目は収集しません")),
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
        await application.run(["persist-state", "--config", "tests/fixtures/config.valid.yml"]);
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
      const config = await loadConfig(join(import.meta.dirname, "fixtures/config.valid.yml"));
      const session = await StatePersistenceSession.open(stateAdapter, config.state);
      const snapshot = await session.loadSnapshot();

      expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
      expect(snapshot.status).toBe(stateStatus);
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

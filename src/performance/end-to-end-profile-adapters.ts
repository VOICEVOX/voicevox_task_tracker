import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { estimateAiInputCost } from "../codex/budget.js";
import type { CodexAnalysisInput } from "../codex/input.js";
import type { SchemaValidPersonalReminderAiOutput } from "../codex/personal-reminder-output.js";
import { serializeCodexTransportAnalysisInput } from "../codex/transport-alias.js";
import type { Config } from "../config/index.js";
import {
  createUtcIsoDateTime,
  type GitHubNodeId,
  type Repository,
  type UtcIsoDateTime,
} from "../domain/index.js";
import type {
  EnumeratedGitHubItem,
  GitHubItemDetail,
  GitHubRateLimitSnapshot,
} from "../github/index.js";
import {
  writeCliJsonArtifact,
  writeCliTextFile,
} from "../infrastructure/tracking-run/file-output.js";
import type { ProductionRuntimeAdapters } from "../infrastructure/tracking-run/runtime/adapters.js";
import { buildWebOutput } from "../pages/build-web-output.js";
import type { GeneratedPublicData } from "../pages/generate-public-data-v20.js";
import { writePublicDataFiles } from "../pages/write-public-data.js";
import { MemoryStateBranchAdapter } from "../persistence/memory-state-branch-adapter.js";
import { StatePersistenceSession } from "../persistence/state-persistence-session.js";
import { assertNonNullable } from "../util/index.js";

/** 性能profileの件数、時計、固定GitHub入力とAI応答。 */
export type PerformanceRuntimeFixture = Readonly<{
  baselineRunAt: UtcIsoDateTime;
  profileRunAt: UtcIsoDateTime;
  githubApiLimit: number;
  githubConnectionPageSize: number;
  createRepository: (observedAt: UtcIsoDateTime) => Repository;
  createItems: (
    observedAt: UtcIsoDateTime,
    changedVersion: 1 | 2,
  ) => readonly EnumeratedGitHubItem[];
  createDetail: (
    item: EnumeratedGitHubItem,
    itemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
    observedAt: UtcIsoDateTime,
    changedVersion: 1 | 2,
  ) => GitHubItemDetail;
  createGenericOutput: (input: CodexAnalysisInput) => unknown;
}>;

type PerformanceRun = Readonly<{
  runAt: UtcIsoDateTime;
  startedAt: number;
  items: readonly EnumeratedGitHubItem[];
}> &
  (
    | Readonly<{ kind: "baseline"; changedVersion: 1 }>
    | Readonly<{ kind: "profile"; changedVersion: 2 }>
  );

type ApiBudgetMeter = Readonly<{
  reset: () => void;
  consume: (units: number) => void;
  snapshot: (observedAt: UtcIsoDateTime) => GitHubRateLimitSnapshot;
  used: () => number;
  remaining: () => number;
}>;

type PerformanceAdapterHarness = Readonly<{
  adapters: ProductionRuntimeAdapters;
  apiBudget: ApiBudgetMeter;
  beginBaseline: () => void;
  beginProfile: () => void;
  readPublicData: () => GeneratedPublicData;
  readGenericAiNodeIds: () => readonly string[];
  readPersonalReminderAiNodeIds: () => readonly string[];
}>;

function createApiBudgetMeter(limit: number): ApiBudgetMeter {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("GitHub API上限は正の安全な整数にしてください");
  }
  let remaining = limit;
  return Object.freeze({
    reset: (): void => {
      remaining = limit;
    },
    consume: (units: number): void => {
      if (!Number.isSafeInteger(units) || units < 0) {
        throw new RangeError("GitHub API使用量は0以上の安全な整数にしてください");
      }
      if (units > remaining) {
        throw new RangeError("GitHub APIモックの残量を超えました");
      }
      remaining -= units;
    },
    snapshot: (observedAt: UtcIsoDateTime): GitHubRateLimitSnapshot =>
      Object.freeze({
        source: "graphql",
        limit,
        remaining,
        resetAt: createUtcIsoDateTime("2026-08-03T00:00:00.000Z"),
        observedAt,
        cost: 1,
      }),
    used: (): number => limit - remaining,
    remaining: (): number => remaining,
  });
}

function createPerformanceRun(
  fixture: PerformanceRuntimeFixture,
  kind: PerformanceRun["kind"],
): PerformanceRun {
  if (kind === "baseline") {
    return Object.freeze({
      kind,
      changedVersion: 1,
      runAt: fixture.baselineRunAt,
      items: fixture.createItems(fixture.baselineRunAt, 1),
      startedAt: performance.now(),
    });
  }
  return Object.freeze({
    kind,
    changedVersion: 2,
    runAt: fixture.profileRunAt,
    items: fixture.createItems(fixture.profileRunAt, 2),
    startedAt: performance.now(),
  });
}

/** 外部接続を拒否し、保存・artifact・DTO・Web生成を実行するprofile harnessを作る。 */
export function createPerformanceHarness(
  repositoryPath: string,
  config: Config,
  fixture: PerformanceRuntimeFixture,
): PerformanceAdapterHarness {
  const stateAdapter = new MemoryStateBranchAdapter();
  const apiBudget = createApiBudgetMeter(fixture.githubApiLimit);
  const genericAiNodeIds: string[] = [];
  const personalReminderAiNodeIds: string[] = [];
  let currentRun = createPerformanceRun(fixture, "baseline");
  let generatedPublicData: GeneratedPublicData | undefined;
  const now = (): Date =>
    new Date(Date.parse(currentRun.runAt) + Math.floor(performance.now() - currentRun.startedAt));
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    "performance-profile-dummy-key",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const adapters: ProductionRuntimeAdapters = Object.freeze({
    environment: Object.freeze({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_APP_INSTALLATION_ID: "456",
      HOME: "/tmp",
      OPENAI_API_KEY: "performance-profile-openai-key",
      PATH: "/usr/bin",
    }),
    repositoryPath,
    pagesOutputDirectory: join(repositoryPath, "web/public/data"),
    loadConfig: () => Promise.resolve(config),
    openStateSession: (adapter, stateConfiguration, migrationTimezone) =>
      StatePersistenceSession.open(adapter, stateConfiguration, migrationTimezone),
    discoverRepositoryInventory: () => {
      apiBudget.consume(1);
      return Promise.resolve(Object.freeze([fixture.createRepository(currentRun.runAt)]));
    },
    enumerateOpenGitHubItems: (input) => {
      if (input.allowlist.repositories.length !== 1) {
        throw new TypeError("性能profileの収集対象repositoryが1件ではありません");
      }
      apiBudget.consume(Math.ceil(currentRun.items.length / fixture.githubConnectionPageSize));
      return Promise.resolve(currentRun.items);
    },
    enumerateGitHubItemsByIdentifiers: () =>
      Promise.reject(new TypeError("性能profileでは項目の個別取得を行いません")),
    collectGitHubItemDetails: (input) => {
      apiBudget.consume(input.targets.length + 1);
      const itemsByNodeId = new Map(currentRun.items.map((item) => [item.nodeId, item]));
      const details = input.targets.map((target) =>
        fixture.createDetail(
          target.item,
          itemsByNodeId,
          currentRun.runAt,
          currentRun.changedVersion,
        ),
      );
      return Promise.resolve(
        Object.freeze({
          capabilities: Object.freeze({
            nativeDependencies: "available",
            nativeHierarchy: "available",
          }),
          items: Object.freeze(details),
        }),
      );
    },
    executeCodexAnalysis: (input, configuration, dependencies) => {
      const inputJson = serializeCodexTransportAnalysisInput(input);
      const cost = estimateAiInputCost(inputJson, configuration.inputCostUsdPerMillionTokens);
      const observer = dependencies.semanticGenerationObserver;
      assertNonNullable(observer, "性能profileの汎用AIにgeneration observerがありません");
      observer.onGenerationStarted(1);
      dependencies.attemptBudget.beginAttempt(
        dependencies.initialAttemptTicket,
        "generic_initial",
        input.item.nodeId,
        Object.freeze({
          inputCharacters: Array.from(inputJson).length,
          estimatedInputTokens: cost.estimatedInputTokens,
          estimatedCostUsd: cost.estimatedCostUsd,
        }),
      );
      observer.onProcessAttemptStarted(1, 1);
      if (currentRun.kind === "profile") {
        genericAiNodeIds.push(input.item.nodeId);
      }
      return Promise.resolve(fixture.createGenericOutput(input));
    },
    executeCodexPersonalReminderAnalysis: (batch, _configuration, dependencies) => {
      const input = batch.input;
      dependencies.attemptBudget.beginAttempt(
        dependencies.initialAttemptTicket,
        "personal_initial",
        batch.id,
        batch.reservation.charge,
      );
      if (currentRun.kind === "profile") {
        personalReminderAiNodeIds.push(input.item.nodeId);
      }
      return Promise.resolve<SchemaValidPersonalReminderAiOutput>({
        schemaVersion: "1",
        item: input.item,
        causes: input.causes.map((cause) => {
          const firstSourceRef = cause.sourceRefs[0];
          assertNonNullable(
            firstSourceRef,
            `性能profileの個人催促入力にsourceがありません。対象: ${cause.causeId}`,
          );
          return {
            causeId: cause.causeId,
            assessment: {
              verdict: "unknown",
              reason: "ambiguous_meaning",
              references: {
                itemRefs: cause.itemRefs,
                relationRefs: cause.relationRefs,
                sourceRefs: [firstSourceRef],
                reasonSummary: "性能profileでは個人催促の意味を判定しません",
              },
              confidence: 1,
            },
          };
        }),
      });
    },
    executeCodexAuthenticationPreflight: () =>
      Promise.reject(new TypeError("性能profileではCodex認証preflightを実行しません")),
    verifyStateDirectory: () =>
      Promise.reject(new TypeError("性能profileでは永続stateを検証しません")),
    createGitHubClient: () => {
      apiBudget.reset();
      return Promise.resolve(
        Object.freeze({
          installationId: 456,
          request: () => Promise.reject(new TypeError("GitHub RESTへの外部接続は禁止です")),
          graphql: () => Promise.reject(new TypeError("GitHub GraphQLへの外部接続は禁止です")),
          getRateLimitSnapshot: () => apiBudget.snapshot(createUtcIsoDateTime(now().toISOString())),
        }),
      );
    },
    createStateBranchAdapter: () => stateAdapter,
    codexProcessRunner: (request) => {
      if (request.arguments.length === 1 && request.arguments[0] === "--version") {
        return Promise.resolve({ exitCode: 0, signal: null, timedOut: false });
      }
      return Promise.reject(new TypeError("Codex subprocessへの外部接続は禁止です"));
    },
    discordHttpClient: Object.freeze({
      execute: () => Promise.reject(new TypeError("Discordへの外部接続は禁止です")),
    }),
    now,
    sleep: () => Promise.resolve(),
    random: () => 0,
    writeStandardOutput: () => Promise.resolve(),
    writeJsonArtifact: writeCliJsonArtifact,
    readArtifactBytes: readFile,
    writeTextFile: writeCliTextFile,
    buildWebOutput,
    deployProductionPages: () =>
      Promise.reject(new TypeError("性能profileではPages deployを実行しません")),
    writePublicData: (outputDirectory, data) => {
      generatedPublicData = data;
      return writePublicDataFiles(outputDirectory, data);
    },
    sendDiscord: () => Promise.reject(new TypeError("性能profileではDiscordへ送信できません")),
  });
  return Object.freeze({
    adapters,
    apiBudget,
    beginBaseline: (): void => {
      currentRun = createPerformanceRun(fixture, "baseline");
    },
    beginProfile: (): void => {
      currentRun = createPerformanceRun(fixture, "profile");
      generatedPublicData = undefined;
    },
    readPublicData: (): GeneratedPublicData => {
      assertNonNullable(generatedPublicData, "性能profileでPages公開データが生成されませんでした");
      return generatedPublicData;
    },
    readGenericAiNodeIds: (): readonly string[] => Object.freeze([...genericAiNodeIds]),
    readPersonalReminderAiNodeIds: (): readonly string[] =>
      Object.freeze([...personalReminderAiNodeIds]),
  });
}

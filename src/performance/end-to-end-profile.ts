import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { z } from "zod";

import {
  createProductionCliApplication,
  type ProductionRuntimeAdapters,
} from "../cli/production-runtime.js";
import { type CliExecutionResult } from "../cli/index.js";
import { type CodexAnalysisInput } from "../codex/index.js";
import { loadConfig, type Config } from "../config/index.js";
import { type DiscordDigestDelivery } from "../discord/index.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemDisplayReference,
  type GitHubNodeId,
  type Repository,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  createGitHubBodyFingerprint,
  createPublicRepositoryAllowlist,
  type EnumeratedGitHubItem,
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubNativeDependency,
  type GitHubRateLimitSnapshot,
  type PublicRepository,
} from "../github/index.js";
import { PUBLIC_SUMMARY_GZIP_LIMIT_BYTES, type GeneratedPublicData } from "../pages/index.js";
import {
  MemoryStateBranchAdapter,
  serializeCanonicalJson,
  StatePersistenceSession,
} from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";

const PROFILE_ITEM_COUNT = 5_000;
const PROFILE_EDGE_COUNT = 10_000;
const PROFILE_CHANGED_ITEM_COUNT = 300;
const PROFILE_REPOSITORY_NAME = "performance-profile";
const PROFILE_REPOSITORY_ID = createGitHubRepositoryId("R_performance_profile");
const PROFILE_MAINTAINER_LOGIN = "performance-maintainer";
const PROFILE_START_AT = createUtcIsoDateTime("2026-01-01T00:00:00.000Z");
const BASELINE_RUN_AT = createUtcIsoDateTime("2026-08-01T00:00:00.000Z");
const PROFILE_RUN_AT = createUtcIsoDateTime("2026-08-02T00:00:00.000Z");
const GITHUB_API_LIMIT = 15_000;
const GITHUB_CONNECTION_PAGE_SIZE = 100;
const GITHUB_API_BUDGET_RATIO = 0.7;
const THIRTY_MINUTES_MILLISECONDS = 30 * 60 * 1_000;
const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "performance-profile-dummy-key",
  "-----END PRIVATE KEY-----",
].join("\n");

const displayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nonNegativeNumberSchema = z.number().nonnegative();
const ratioSchema = z.number().min(0).max(1);

const performanceMeasurementSchema = z
  .strictObject({
    durationMilliseconds: nonNegativeNumberSchema,
    githubApi: z.strictObject({
      limit: nonNegativeIntegerSchema.positive(),
      used: nonNegativeIntegerSchema,
      remaining: nonNegativeIntegerSchema,
      usedRatio: ratioSchema,
    }),
    codex: z.strictObject({
      calls: nonNegativeIntegerSchema,
      configuredMaxCalls: nonNegativeIntegerSchema,
    }),
    webInitialSummary: z.strictObject({
      gzipBytes: nonNegativeIntegerSchema,
      limitBytes: z.literal(PUBLIC_SUMMARY_GZIP_LIMIT_BYTES),
    }),
  })
  .superRefine((measurement, context) => {
    if (
      measurement.githubApi.used + measurement.githubApi.remaining !==
      measurement.githubApi.limit
    ) {
      context.addIssue({
        code: "custom",
        path: ["githubApi"],
        message: "GitHub APIの使用量と残量が上限に一致しません",
      });
    }
    const expectedRatio = measurement.githubApi.used / measurement.githubApi.limit;
    if (Math.abs(measurement.githubApi.usedRatio - expectedRatio) > 1e-12) {
      context.addIssue({
        code: "custom",
        path: ["githubApi", "usedRatio"],
        message: "GitHub API使用率が使用量と上限に一致しません",
      });
    }
  });

const performanceProfileSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  status: z.enum(["passed", "failed"]),
  fixture: z.strictObject({
    itemCount: z.literal(PROFILE_ITEM_COUNT),
    activeEdgeCount: z.literal(PROFILE_EDGE_COUNT),
    changedItemCount: z.literal(PROFILE_CHANGED_ITEM_COUNT),
  }),
  thresholds: z.strictObject({
    durationMilliseconds: z.literal(THIRTY_MINUTES_MILLISECONDS),
    githubApiBudgetRatio: z.literal(GITHUB_API_BUDGET_RATIO),
    codexMaxCalls: nonNegativeIntegerSchema,
    summaryGzipBytes: z.literal(PUBLIC_SUMMARY_GZIP_LIMIT_BYTES),
  }),
  measurements: performanceMeasurementSchema,
  checks: z.strictObject({
    processingWithinThirtyMinutes: z.boolean(),
    githubApiBudgetWithinSeventyPercent: z.boolean(),
    codexBudgetWithinConfiguredLimit: z.boolean(),
    summaryGzipWithinOneMiB: z.boolean(),
  }),
});

/** end-to-end性能profileの実測値。 */
export type EndToEndPerformanceMeasurement = z.output<typeof performanceMeasurementSchema>;

/** OPS-004の閾値判定と証跡を含む性能profile。 */
export type EndToEndPerformanceProfile = z.output<typeof performanceProfileSchema>;

type ApiBudgetMeter = Readonly<{
  reset: () => void;
  consume: (units: number) => void;
  snapshot: (observedAt: UtcIsoDateTime) => GitHubRateLimitSnapshot;
  used: () => number;
  remaining: () => number;
}>;

type PerformanceHarness = Readonly<{
  runBaseline: () => Promise<void>;
  runProfile: () => Promise<
    Readonly<{
      execution: CliExecutionResult;
      durationMilliseconds: number;
      githubApiUsed: number;
      githubApiRemaining: number;
      generatedPublicData: GeneratedPublicData;
      config: Config;
    }>
  >;
}>;

function createApiBudgetMeter(limit: number): ApiBudgetMeter {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("GitHub API上限は正の安全な整数にしてください");
  }
  let remaining = limit;
  return Object.freeze({
    reset: () => {
      remaining = limit;
    },
    consume: (units) => {
      if (!Number.isSafeInteger(units) || units < 0) {
        throw new RangeError("GitHub API使用量は0以上の安全な整数にしてください");
      }
      if (units > remaining) {
        throw new RangeError("GitHub APIモックの残量を超えました");
      }
      remaining -= units;
    },
    snapshot: (observedAt) =>
      Object.freeze({
        source: "graphql",
        limit,
        remaining,
        resetAt: createUtcIsoDateTime("2026-08-03T00:00:00.000Z"),
        observedAt,
        cost: 1,
      }),
    used: () => limit - remaining,
    remaining: () => remaining,
  });
}

function createRepository(observedAt: UtcIsoDateTime): Repository {
  return Object.freeze({
    id: PROFILE_REPOSITORY_ID,
    owner: "VOICEVOX",
    name: PROFILE_REPOSITORY_NAME,
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt,
  });
}

function requirePublicRepository(repository: Repository): PublicRepository {
  const publicRepository = createPublicRepositoryAllowlist([repository]).repositories[0];
  assertNonNullable(publicRepository, "性能profile用repositoryが公開allowlistに入りません");
  return publicRepository;
}

function profileNodeId(index: number): GitHubNodeId {
  return createGitHubNodeId(`performance-item-${index.toString().padStart(4, "0")}`);
}

function createProfileItems(
  repository: PublicRepository,
  observedAt: UtcIsoDateTime,
  changedVersion: 1 | 2,
): readonly EnumeratedGitHubItem[] {
  return Object.freeze(
    Array.from({ length: PROFILE_ITEM_COUNT }, (_, index) => {
      const number = index + 1;
      const nodeId = profileNodeId(index);
      const changedItemVersion = index < PROFILE_CHANGED_ITEM_COUNT ? changedVersion : 1;
      const updatedAt =
        index < PROFILE_CHANGED_ITEM_COUNT && changedVersion === 2
          ? PROFILE_RUN_AT
          : BASELINE_RUN_AT;
      return Object.freeze({
        nodeId,
        repositoryId: repository.id,
        displayReference: displayReferenceSchema.parse(
          `VOICEVOX/${PROFILE_REPOSITORY_NAME}#${number.toString()}`,
        ),
        number,
        url: `https://github.com/VOICEVOX/${PROFILE_REPOSITORY_NAME}/issues/${number.toString()}`,
        title: `性能profile項目 ${number.toString().padStart(4, "0")}`,
        bodyFingerprint: createGitHubBodyFingerprint(
          `performance-body-${index.toString()}-v${changedItemVersion.toString()}`,
        ),
        bodyLocator: Object.freeze({
          kind: "github_item_body",
          repositoryId: repository.id,
          itemNodeId: nodeId,
          number,
        }),
        author: Object.freeze({
          kind: "account",
          account: Object.freeze({
            nodeId: createGitHubNodeId(`U_performance_author_${index.toString()}`),
            login: `performance-author-${index.toString()}`,
            apiType: "User",
          }),
        }),
        createdAt: createUtcIsoDateTime("2026-07-01T00:00:00.000Z"),
        updatedAt,
        assignees: Object.freeze([]),
        labels: Object.freeze([]),
        itemFingerprint: createGitHubBodyFingerprint(
          `performance-item-${index.toString()}-v${changedItemVersion.toString()}`,
        ),
        observedAt,
        state: "open",
        stateReason: null,
        closedAt: null,
        type: "issue",
        draft: "not_applicable",
      } satisfies EnumeratedGitHubItem);
    }),
  );
}

function blockerIndexes(blockedIndex: number): readonly number[] {
  if (blockedIndex <= PROFILE_CHANGED_ITEM_COUNT) {
    return Object.freeze([]);
  }
  const indexes = [blockedIndex - 1];
  if (blockedIndex >= PROFILE_CHANGED_ITEM_COUNT + 2) {
    indexes.push(blockedIndex - 2);
  }
  if (
    blockedIndex >= PROFILE_CHANGED_ITEM_COUNT + 3 &&
    blockedIndex <= PROFILE_CHANGED_ITEM_COUNT + 605
  ) {
    indexes.push(blockedIndex - 3);
  }
  return Object.freeze(indexes);
}

function createNativeDependency(
  blockedItem: EnumeratedGitHubItem,
  blockerItem: EnumeratedGitHubItem,
): GitHubNativeDependency {
  return Object.freeze({
    sourceId: buildSourceId(
      "github_native_dependency",
      `${blockedItem.nodeId}:${blockerItem.nodeId}`,
    ),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", blockerItem.nodeId),
      nodeId: blockerItem.nodeId,
      repositoryId: blockerItem.repositoryId,
      repositoryOwner: "VOICEVOX",
      repositoryName: PROFILE_REPOSITORY_NAME,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: "issue",
      number: blockerItem.number,
      url: blockerItem.url,
      createdAt: blockerItem.createdAt,
      state: "open",
    }),
  });
}

function createProfileComment(
  item: EnumeratedGitHubItem,
  changedVersion: 1 | 2,
): GitHubIssueComment {
  const commentNodeId = createGitHubNodeId(`IC_${item.nodeId}`);
  return Object.freeze({
    sourceId: buildSourceId("github_issue_comment", commentNodeId),
    nodeId: commentNodeId,
    sequence: 0,
    author: Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", `U_commenter_${item.nodeId}`),
        nodeId: createGitHubNodeId(`U_commenter_${item.nodeId}`),
        login: `commenter-${item.number.toString()}`,
        apiType: "User",
      }),
    }),
    body: `次の担当を自然言語から判定します v${changedVersion.toString()}`,
    createdAt: BASELINE_RUN_AT,
    updatedAt: changedVersion === 1 ? BASELINE_RUN_AT : PROFILE_RUN_AT,
    url: `${item.url}#issuecomment-${item.number.toString()}`,
  });
}

function createProfileDetail(
  item: EnumeratedGitHubItem,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  observedAt: UtcIsoDateTime,
  changedVersion: 1 | 2,
): GitHubItemDetail {
  const index = item.number - 1;
  const dependencies = blockerIndexes(index).map((blockerIndex) => {
    const blocker = itemsByNodeId.get(profileNodeId(blockerIndex));
    assertNonNullable(
      blocker,
      `性能profileのblockerがありません。対象: ${blockerIndex.toString()}`,
    );
    return createNativeDependency(item, blocker);
  });
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "issue",
    bodySourceId: buildSourceId("github_item_body", item.nodeId),
    body:
      index < PROFILE_CHANGED_ITEM_COUNT
        ? `自然言語判定を必要とする性能profile本文 v${changedVersion.toString()}`
        : "native dependencyだけを持つ性能profile本文",
    comments:
      index < PROFILE_CHANGED_ITEM_COUNT
        ? Object.freeze([createProfileComment(item, changedVersion)])
        : Object.freeze([]),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    nativeDependencies: Object.freeze({
      availability: "available",
      relations: Object.freeze(dependencies),
    }),
    nativeHierarchy: Object.freeze({
      availability: "available",
      relations: Object.freeze([]),
    }),
    observedAt,
  });
}

function createCodexOutput(input: CodexAnalysisInput): unknown {
  const source = input.sources.find(
    (candidate) => candidate.kind === "comment" && candidate.actorType === "human",
  );
  assertNonNullable(
    source,
    `性能profileのCodex入力にhuman commentがありません。対象: ${input.item.nodeId}`,
  );
  const authorCandidateId = input.item.authorCandidateId;
  assertNonNullable(
    authorCandidateId,
    `性能profileのCodex入力に作者候補IDがありません。対象: ${input.item.nodeId}`,
  );
  return {
    schemaVersion: "3",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: "waiting_for_work",
    waitingOn: [
      {
        kind: "user",
        candidateId: authorCandidateId,
        role: "assignee",
        reasonSummary: "モック分析では作成者を次の担当候補として扱います",
        sourceIds: [source.id],
        confidence: 0.95,
      },
    ],
    nextAction: "担当者が項目を確認する",
    relations: input.candidates.relations.map((candidate) => ({
      candidateId: candidate.id,
      verdict: "related",
      reasonSummary: "性能profileでは曖昧な関係を関連として扱います",
      sourceIds: [source.id],
      confidence: 0.95,
    })),
    progress: {
      latestMeaningfulSourceId: source.id,
      reasonSummary: "human commentを意味のある進捗として扱います",
      confidence: 0.95,
    },
    importance: {
      significantFeature: false,
      futureRisk: false,
      rationale: "性能profileでは重要度の自然言語要因を設定しません",
    },
    deadline: {
      level: "none",
      rationale: "性能profileでは期限の切迫度を設定しません",
    },
    evidence: [
      {
        sourceId: source.id,
        supports: "status",
        summary: "human commentを状態判定の根拠にしました",
      },
    ],
    confidence: 0.95,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "性能profileでは通知を推奨しません",
    },
  };
}

async function createPerformanceConfig(repositoryPath: string): Promise<Config> {
  const base = await loadConfig(join(repositoryPath, "fixtures/performance/config.valid.yml"));
  return Object.freeze({
    ...base,
    tracking: Object.freeze({
      ...base.tracking,
      startAt: PROFILE_START_AT,
      include: [],
    }),
    maintainers: Object.freeze({
      defaults: [PROFILE_MAINTAINER_LOGIN],
      repositories: Object.freeze({}),
    }),
    ai: Object.freeze({
      ...base.ai,
      enabled: true,
      budget: Object.freeze({
        ...base.ai.budget,
        maxCallsPerRun: PROFILE_CHANGED_ITEM_COUNT,
      }),
    }),
    notifications: Object.freeze({
      ...base.notifications,
      discord: Object.freeze({
        ...base.notifications.discord,
        enabled: false,
      }),
    }),
  });
}

function requireSingleRepository(repositories: readonly PublicRepository[]): PublicRepository {
  const repository = repositories[0];
  if (repository == null || repositories.length !== 1) {
    throw new TypeError("性能profileの収集対象repositoryが1件ではありません");
  }
  return repository;
}

function createPerformanceHarness(repositoryPath: string, config: Config): PerformanceHarness {
  const stateAdapter = new MemoryStateBranchAdapter();
  const apiBudget = createApiBudgetMeter(GITHUB_API_LIMIT);
  let currentRunAt = BASELINE_RUN_AT;
  let currentRunStartedAt = performance.now();
  let changedVersion: 1 | 2 = 1;
  let currentItems = createProfileItems(
    requirePublicRepository(createRepository(BASELINE_RUN_AT)),
    BASELINE_RUN_AT,
    changedVersion,
  );
  let generatedPublicData: GeneratedPublicData | undefined;

  const now = (): Date =>
    new Date(Date.parse(currentRunAt) + Math.floor(performance.now() - currentRunStartedAt));
  const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
    environment: Object.freeze({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      GH_APP_INSTALLATION_ID: "456",
      HOME: "/tmp",
      OPENAI_API_KEY: "performance-profile-openai-key",
      PATH: "/usr/bin",
    }),
    repositoryPath,
    pagesOutputDirectory: "unused-performance-pages",
    loadConfig: () => Promise.resolve(config),
    openStateSession: (adapter, stateConfiguration) =>
      StatePersistenceSession.open(adapter, stateConfiguration),
    discoverRepositoryInventory: () => {
      apiBudget.consume(1);
      return Promise.resolve(Object.freeze([createRepository(currentRunAt)]));
    },
    enumerateOpenGitHubItems: (input) => {
      requireSingleRepository(input.allowlist.repositories);
      apiBudget.consume(Math.ceil(currentItems.length / GITHUB_CONNECTION_PAGE_SIZE));
      return Promise.resolve(currentItems);
    },
    enumerateGitHubItemsByIdentifiers: () =>
      Promise.reject(new TypeError("性能profileでは項目の個別取得を行いません")),
    collectGitHubItemDetails: (input) => {
      apiBudget.consume(input.targets.length + 1);
      const itemsByNodeId = new Map(currentItems.map((item) => [item.nodeId, item]));
      const details = input.targets.map((target) =>
        createProfileDetail(target.item, itemsByNodeId, currentRunAt, changedVersion),
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
    executeCodexAnalysis: (input) => Promise.resolve(createCodexOutput(input)),
    readReplayFixture: () => Promise.reject(new TypeError("性能profileではreplayしません")),
    readReplayState: () => Promise.reject(new TypeError("性能profileではstate replayしません")),
    readGoldenFixtures: () => Promise.reject(new TypeError("性能profileではgolden evalしません")),
    readWorkflowArtifact: () =>
      Promise.reject(new TypeError("性能profileではworkflow artifactを読みません")),
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
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
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
    writeJsonArtifact: () => Promise.resolve(),
    writeTextFile: () => Promise.resolve(),
    writePublicData: (_outputDirectory, data) => {
      generatedPublicData = data;
      const summarySource = serializeCanonicalJson(data.summary);
      const detailsSource = serializeCanonicalJson(data.details);
      return Promise.resolve({
        summaryPath: "unused-performance-pages/summary.json",
        detailsPath: "unused-performance-pages/details.json",
        summaryBytes: Buffer.byteLength(summarySource, "utf8"),
        detailsBytes: Buffer.byteLength(detailsSource, "utf8"),
      });
    },
    sendDiscord: () =>
      Promise.resolve(
        Object.freeze({
          status: "disabled",
        } satisfies DiscordDigestDelivery),
      ),
  });
  const application = createProductionCliApplication(runtimeAdapters);

  const runDaily = (runAt: UtcIsoDateTime) => {
    currentRunAt = runAt;
    currentRunStartedAt = performance.now();
    return application.run([
      "daily",
      "--config",
      "unused-performance-config.yml",
      "--report",
      "unused-performance-report.json",
    ]);
  };

  return Object.freeze({
    runBaseline: async () => {
      const result = await runDaily(BASELINE_RUN_AT);
      if (result.exitCode !== 0) {
        throw new TypeError("性能profileの基準state作成に失敗しました");
      }
    },
    runProfile: async () => {
      changedVersion = 2;
      currentItems = createProfileItems(
        requirePublicRepository(createRepository(PROFILE_RUN_AT)),
        PROFILE_RUN_AT,
        changedVersion,
      );
      generatedPublicData = undefined;
      const startedAt = performance.now();
      const execution = await runDaily(PROFILE_RUN_AT);
      const durationMilliseconds = performance.now() - startedAt;
      assertNonNullable(generatedPublicData, "性能profileでPages公開データが生成されませんでした");
      return Object.freeze({
        execution,
        durationMilliseconds,
        githubApiUsed: apiBudget.used(),
        githubApiRemaining: apiBudget.remaining(),
        generatedPublicData,
        config,
      });
    },
  });
}

function requireDailyMetrics(execution: CliExecutionResult) {
  if (execution.command !== "daily") {
    throw new TypeError("性能profileがdailyコマンドを通っていません");
  }
  if (execution.exitCode !== 0 || execution.result.report.status === "failure") {
    throw new TypeError("性能profileの日次runが失敗しました");
  }
  return execution.result.report.metrics;
}

/** OPS-004の測定値を全閾値へ照合する。 */
export function evaluateEndToEndPerformanceMeasurement(
  measurement: EndToEndPerformanceMeasurement,
): EndToEndPerformanceProfile {
  const parsedMeasurement = performanceMeasurementSchema.parse(measurement);
  const checks = Object.freeze({
    processingWithinThirtyMinutes:
      parsedMeasurement.durationMilliseconds <= THIRTY_MINUTES_MILLISECONDS,
    githubApiBudgetWithinSeventyPercent:
      parsedMeasurement.githubApi.usedRatio <= GITHUB_API_BUDGET_RATIO,
    codexBudgetWithinConfiguredLimit:
      parsedMeasurement.codex.calls <= parsedMeasurement.codex.configuredMaxCalls,
    summaryGzipWithinOneMiB:
      parsedMeasurement.webInitialSummary.gzipBytes <=
      parsedMeasurement.webInitialSummary.limitBytes,
  });
  const passed = Object.values(checks).every((value) => value);
  return performanceProfileSchema.parse({
    schemaVersion: "1",
    status: passed ? "passed" : "failed",
    fixture: {
      itemCount: PROFILE_ITEM_COUNT,
      activeEdgeCount: PROFILE_EDGE_COUNT,
      changedItemCount: PROFILE_CHANGED_ITEM_COUNT,
    },
    thresholds: {
      durationMilliseconds: THIRTY_MINUTES_MILLISECONDS,
      githubApiBudgetRatio: GITHUB_API_BUDGET_RATIO,
      codexMaxCalls: parsedMeasurement.codex.configuredMaxCalls,
      summaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
    },
    measurements: parsedMeasurement,
    checks,
  });
}

/** 閾値未達の性能profileを失敗として停止する。 */
export function assertEndToEndPerformanceProfilePassed(profile: EndToEndPerformanceProfile): void {
  const parsed = performanceProfileSchema.parse(profile);
  if (parsed.status === "passed") {
    return;
  }
  const failedChecks = Object.entries(parsed.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  throw new Error(`end-to-end性能profileが閾値を満たしません。対象: ${failedChecks.join(", ")}`);
}

/** 外部接続をモックした本番daily経路でOPS-004を計測する。 */
export async function runEndToEndPerformanceProfile(
  repositoryPath: string,
): Promise<EndToEndPerformanceProfile> {
  const config = await createPerformanceConfig(repositoryPath);
  const harness = createPerformanceHarness(repositoryPath, config);
  await harness.runBaseline();
  const result = await harness.runProfile();
  const metrics = requireDailyMetrics(result.execution);
  if (
    metrics.itemCount !== PROFILE_ITEM_COUNT ||
    metrics.activeEdgeCount !== PROFILE_EDGE_COUNT ||
    metrics.changedItemCount !== PROFILE_CHANGED_ITEM_COUNT
  ) {
    throw new TypeError(
      `性能fixtureの件数が一致しません。items=${metrics.itemCount.toString()} edges=${metrics.activeEdgeCount.toString()} changed=${metrics.changedItemCount.toString()}`,
    );
  }
  if (metrics.aiCallCount !== PROFILE_CHANGED_ITEM_COUNT) {
    throw new TypeError(
      `性能fixtureのCodex呼び出し件数が一致しません。calls=${metrics.aiCallCount.toString()}`,
    );
  }
  if (metrics.githubApiRemaining !== result.githubApiRemaining) {
    throw new TypeError("run reportとGitHub APIモックの残量が一致しません");
  }
  const githubApiUsedRatio = result.githubApiUsed / GITHUB_API_LIMIT;
  return evaluateEndToEndPerformanceMeasurement(
    Object.freeze({
      durationMilliseconds: result.durationMilliseconds,
      githubApi: Object.freeze({
        limit: GITHUB_API_LIMIT,
        used: result.githubApiUsed,
        remaining: result.githubApiRemaining,
        usedRatio: githubApiUsedRatio,
      }),
      codex: Object.freeze({
        calls: metrics.aiCallCount,
        configuredMaxCalls: result.config.ai.budget.maxCallsPerRun,
      }),
      webInitialSummary: Object.freeze({
        gzipBytes: result.generatedPublicData.summarySize.gzipBytes,
        limitBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      }),
    }),
  );
}

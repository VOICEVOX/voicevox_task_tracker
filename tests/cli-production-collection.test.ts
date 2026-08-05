import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createProductionCliApplication,
  type ProductionRuntimeAdapters,
} from "../src/cli/production-runtime.js";
import {
  createAiCacheEntry,
  hashCanonicalJson,
  type CodexAnalysisInput,
} from "../src/codex/index.js";
import { loadConfig, type Config } from "../src/config/index.js";
import { type DiscordDigestDelivery } from "../src/discord/index.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  DETERMINISTIC_RULES_VERSION,
  ISSUE_DETERMINISTIC_RULES_VERSION,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type NotificationReasonCode,
  type ObservedGitHubItemState,
  type Repository,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  createGitHubBodyFingerprint,
  createPublicRepositoryAllowlist,
  GitHubRetryExhaustedError,
  type EnumeratedGitHubItem,
  type GitHubItemDetail,
  type GitHubItemDetailEventWindow,
  type GitHubItemMilestone,
  type GitHubInboundCrossReferenceCandidate,
  type GitHubIssueComment,
  type GitHubNativeDependency,
  type GitHubReferencedItem,
  type GitHubTimelineEvent,
  type PublicRepository,
} from "../src/github/index.js";
import { type RelationAssessmentVerdict } from "../src/graph/index.js";
import {
  createStateSnapshot,
  MemoryStateBranchAdapter,
  parseStateHistoryRecords,
  parseStateSnapshot,
  serializeStateSnapshot,
  StatePersistenceSession,
  type StateSnapshot,
} from "../src/persistence/index.js";
import { type GeneratedPublicData } from "../src/pages/index.js";

const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "production-collection-test-key",
  "-----END PRIVATE KEY-----",
].join("\n");
const START_AT = "2026-01-01T00:00:00.000Z";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const SECOND_RUN_AT = "2026-08-02T00:00:00.000Z";
const THIRD_RUN_AT = "2026-08-04T00:00:00.000Z";
const FOURTH_RUN_AT = "2026-08-05T00:00:00.000Z";
const OLD_ITEM_AT = "2025-12-01T00:00:00.000Z";
const displayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);

type IssueStateFixture =
  | Readonly<{
      state: "open";
    }>
  | Readonly<{
      state: "closed";
      closedAt: UtcIsoDateTime;
    }>;

interface RepositoryFixture {
  repository: Repository;
  openItems: EnumeratedGitHubItem[];
  individualItems: Map<string, EnumeratedGitHubItem>;
  details: Map<GitHubNodeId, GitHubItemDetail>;
  enumerationFailsWith503: boolean;
}

type DetailCall = Readonly<{
  targets: readonly Readonly<{
    nodeId: GitHubNodeId;
    eventWindow: GitHubItemDetailEventWindow;
  }>[];
}>;

function createRepository(id: string, name: string, observedAt: string): Repository {
  return Object.freeze({
    id: createGitHubRepositoryId(id),
    owner: "VOICEVOX",
    name,
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt: createUtcIsoDateTime(observedAt),
  });
}

function requirePublicRepository(repository: Repository): PublicRepository {
  const value = createPublicRepositoryAllowlist([repository]).repositories[0];
  if (value == null) {
    throw new TypeError("公開repository fixtureを作成できません");
  }
  return value;
}

function createIssueItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    updatedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
    state: IssueStateFixture;
  }>,
): EnumeratedGitHubItem {
  const nodeId = createGitHubNodeId(`I_${options.repository.name}_${options.number.toString()}`);
  const url =
    `https://github.com/${options.repository.owner}/${options.repository.name}/issues/${options.number.toString()}` satisfies GitHubItemUrl;
  const displayReference = displayReferenceSchema.parse(
    `${options.repository.owner}/${options.repository.name}#${options.number.toString()}`,
  );
  const stateFields: ObservedGitHubItemState =
    options.state.state === "open"
      ? Object.freeze({
          state: "open",
          stateReason: null,
          closedAt: null,
        })
      : Object.freeze({
          state: "closed",
          stateReason: "completed",
          closedAt: options.state.closedAt,
        });
  return Object.freeze({
    nodeId,
    repositoryId: options.repository.id,
    displayReference,
    number: options.number,
    url,
    title: `項目${options.number.toString()}`,
    bodyFingerprint: createGitHubBodyFingerprint(`body-${options.fingerprint}`),
    bodyLocator: Object.freeze({
      kind: "github_item_body",
      repositoryId: options.repository.id,
      itemNodeId: nodeId,
      number: options.number,
    }),
    author: Object.freeze({
      kind: "account",
      account: Object.freeze({
        nodeId: createGitHubNodeId(`U_author_${options.number.toString()}`),
        login: `author-${options.number.toString()}`,
        apiType: "User",
      }),
    }),
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00.000Z"),
    updatedAt: options.updatedAt,
    assignees: Object.freeze([]),
    labels: Object.freeze([]),
    milestone: null,
    itemFingerprint: createGitHubBodyFingerprint(`item-${options.fingerprint}`),
    observedAt: options.observedAt,
    type: "issue",
    draft: "not_applicable",
    ...stateFields,
  });
}

function replaceCreatedAt(
  item: EnumeratedGitHubItem,
  createdAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    createdAt,
  });
}

function createOldIssueItem(
  repository: PublicRepository,
  number: number,
  fingerprint: string,
  observedAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
  return replaceCreatedAt(
    createIssueItem({
      repository,
      number,
      fingerprint,
      updatedAt: oldItemAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    }),
    oldItemAt,
  );
}

function replaceWithAutomationDashboard(
  item: EnumeratedGitHubItem,
  title: string,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    title,
    author: Object.freeze({
      kind: "account",
      account: Object.freeze({
        nodeId: createGitHubNodeId("BOT_RENOVATE"),
        login: "renovate[bot]",
        apiType: "Bot",
      }),
    }),
  });
}

function createPullRequestItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    updatedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
  }>,
): EnumeratedGitHubItem {
  const issue = createIssueItem({
    ...options,
    state: Object.freeze({ state: "open" }),
  });
  return Object.freeze({
    ...issue,
    type: "pull_request",
    draft: false,
    mergeStatus: "not_merged",
    url: `https://github.com/${options.repository.owner}/${options.repository.name}/pull/${options.number.toString()}`,
  } satisfies EnumeratedGitHubItem);
}

function createMergedPullRequestItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    mergedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
  }>,
): EnumeratedGitHubItem {
  const issue = createIssueItem({
    repository: options.repository,
    number: options.number,
    fingerprint: options.fingerprint,
    updatedAt: options.mergedAt,
    observedAt: options.observedAt,
    state: Object.freeze({
      state: "closed",
      closedAt: options.mergedAt,
    }),
  });
  return Object.freeze({
    ...issue,
    type: "pull_request",
    draft: false,
    mergeStatus: "merged",
    mergedAt: options.mergedAt,
    url: `https://github.com/${options.repository.owner}/${options.repository.name}/pull/${options.number.toString()}`,
  } satisfies EnumeratedGitHubItem);
}

function createFailedCheckPullRequestDetail(
  item: EnumeratedGitHubItem,
  observedAt: UtcIsoDateTime,
): Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>> {
  const headSourceId = buildSourceId("github_commit", `${item.nodeId}:head`);
  const checkSourceId = buildSourceId("github_check_rollup", item.nodeId);
  const contextSourceId = buildSourceId("github_check_run", `${item.nodeId}:test`);
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "pull_request",
    bodySourceId: buildSourceId("github_item_body", item.nodeId),
    body: "required checkの失敗原因を判定する",
    comments: Object.freeze([]),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    reviews: Object.freeze([]),
    reviewThreads: Object.freeze([]),
    reviewRequests: Object.freeze({
      current: Object.freeze([]),
      history: Object.freeze([]),
    }),
    headSha: `head-${item.nodeId}`,
    headCommit: Object.freeze({
      sourceId: headSourceId,
      nodeId: createGitHubNodeId(`C_${item.nodeId}`),
      sha: `head-${item.nodeId}`,
      committedAt: observedAt,
      pushedAt: Object.freeze({
        status: "available",
        value: observedAt,
      }),
    }),
    mergeState: Object.freeze({
      mergeability: "mergeable",
      mergeState: "unstable",
      autoMerge: Object.freeze({
        status: "not_enabled",
      }),
      mergeQueue: Object.freeze({
        status: "not_queued",
      }),
      checks: Object.freeze({
        status: "configured",
        sourceId: checkSourceId,
        nodeId: createGitHubNodeId(`CHECKS_${item.nodeId}`),
        combinedState: "failure",
        contexts: Object.freeze([
          Object.freeze({
            type: "check_run",
            sourceId: contextSourceId,
            nodeId: createGitHubNodeId(`CHECK_${item.nodeId}`),
            name: "test",
            status: "completed",
            conclusion: "failure",
            completedAt: observedAt,
          }),
        ]),
      }),
    }),
    observedAt,
  });
}

function createDuplicateComments(
  item: EnumeratedGitHubItem,
  occurredAt: UtcIsoDateTime,
): readonly GitHubIssueComment[] {
  const nodeId = createGitHubNodeId(`IC_${item.nodeId}`);
  const comment = Object.freeze({
    sourceId: buildSourceId("github_issue_comment", nodeId),
    nodeId,
    sequence: 0,
    author: Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_commenter"),
        nodeId: createGitHubNodeId("U_commenter"),
        login: "commenter",
        apiType: "User",
      }),
    }),
    body: "overlapで重複したコメント",
    createdAt: occurredAt,
    updatedAt: occurredAt,
    url: `${item.url}#issuecomment-${nodeId}`,
  } satisfies GitHubIssueComment);
  return Object.freeze([
    comment,
    Object.freeze({
      ...comment,
      sequence: 1,
    }),
  ]);
}

function createIssueDetail(
  options: Readonly<{
    item: EnumeratedGitHubItem;
    body: string;
    observedAt: UtcIsoDateTime;
    nativeDependencies: readonly GitHubNativeDependency[];
    duplicateComments: boolean;
  }>,
): GitHubItemDetail {
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", options.item.nodeId),
    nodeId: options.item.nodeId,
    repositoryId: options.item.repositoryId,
    number: options.item.number,
    type: "issue",
    bodySourceId: buildSourceId("github_item_body", options.item.nodeId),
    body: options.body,
    comments: options.duplicateComments
      ? createDuplicateComments(options.item, options.observedAt)
      : Object.freeze([]),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    nativeDependencies: Object.freeze({
      availability: "available",
      relations: options.nativeDependencies,
    }),
    nativeHierarchy: Object.freeze({
      availability: "available",
      relations: Object.freeze([]),
    }),
    observedAt: options.observedAt,
  });
}

function createNativeBlocker(
  blocked: EnumeratedGitHubItem,
  blocker: EnumeratedGitHubItem,
): GitHubNativeDependency {
  const repositoryName = new URL(blocker.url).pathname.split("/")[2];
  if (repositoryName == null || repositoryName.length === 0) {
    throw new TypeError("blocker URLからrepository名を取得できません");
  }
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocked.nodeId}:${blocker.nodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", blocker.nodeId),
      nodeId: blocker.nodeId,
      repositoryId: blocker.repositoryId,
      repositoryOwner: "VOICEVOX",
      repositoryName,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: blocker.type,
      number: blocker.number,
      url: blocker.url,
      createdAt: blocker.createdAt,
      state:
        blocker.type === "pull_request" && blocker.mergeStatus === "merged"
          ? "merged"
          : blocker.state,
    }),
  });
}

function createReferencedItem(item: EnumeratedGitHubItem): GitHubReferencedItem {
  const urlParts = new URL(item.url).pathname.split("/");
  const repositoryOwner = urlParts[1];
  const repositoryName = urlParts[2];
  if (
    repositoryOwner == null ||
    repositoryOwner.length === 0 ||
    repositoryName == null ||
    repositoryName.length === 0
  ) {
    throw new TypeError("参照項目URLからrepository情報を取得できません");
  }
  return Object.freeze({
    sourceId: buildSourceId("github_item", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    repositoryOwner,
    repositoryName,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: item.type,
    number: item.number,
    url: item.url,
    createdAt: item.createdAt,
    state: item.type === "pull_request" && item.mergeStatus === "merged" ? "merged" : item.state,
  });
}

function createNativeBlocking(
  blocker: EnumeratedGitHubItem,
  blocked: EnumeratedGitHubItem,
): GitHubNativeDependency {
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocker.nodeId}:${blocked.nodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocking",
    relatedItem: createReferencedItem(blocked),
  });
}

function createInboundCrossReference(
  target: EnumeratedGitHubItem,
  source: EnumeratedGitHubItem,
  observedAt: UtcIsoDateTime,
): Readonly<{
  event: GitHubTimelineEvent;
  candidate: GitHubInboundCrossReferenceCandidate;
}> {
  const sourceItem = createReferencedItem(source);
  const eventNodeId = createGitHubNodeId(`CRE_${target.nodeId}_${source.nodeId}`);
  const eventSourceId = buildSourceId("github_timeline_event", eventNodeId);
  return Object.freeze({
    event: Object.freeze({
      sourceId: eventSourceId,
      nodeId: eventNodeId,
      sequence: 0,
      occurredAt: observedAt,
      actor: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      kind: "cross_referenced",
      source: sourceItem,
      willCloseTarget: false,
    } satisfies GitHubTimelineEvent),
    candidate: Object.freeze({
      sourceId: buildSourceId("github_inbound_cross_reference", `${eventNodeId}:${source.nodeId}`),
      candidateOnly: true,
      provenance: "cross_reference",
      eventSourceId,
      sourceItem,
    } satisfies GitHubInboundCrossReferenceCandidate),
  });
}

function createIssueDetailWithInboundCrossReferences(
  item: EnumeratedGitHubItem,
  sources: readonly EnumeratedGitHubItem[],
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  const references = sources.map((source) => createInboundCrossReference(item, source, observedAt));
  return Object.freeze({
    ...createIssueDetail({
      item,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
    timeline: Object.freeze(references.map((reference) => reference.event)),
    inboundCrossReferences: Object.freeze(references.map((reference) => reference.candidate)),
  });
}

function createExternalNativeBlocker(
  blocked: EnumeratedGitHubItem,
  options: Readonly<{
    state: "open" | "closed";
    repositoryArchived: boolean;
    repositoryDisabled: boolean;
  }>,
): GitHubNativeDependency {
  const externalNodeId = createGitHubNodeId("I_external_blocker");
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocked.nodeId}:${externalNodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", externalNodeId),
      nodeId: externalNodeId,
      repositoryId: createGitHubRepositoryId("R_external_public"),
      repositoryOwner: "external-owner",
      repositoryName: "external-repository",
      repositoryArchived: options.repositoryArchived,
      repositoryDisabled: options.repositoryDisabled,
      type: "issue",
      number: 42,
      url: "https://github.com/external-owner/external-repository/issues/42",
      createdAt: blocked.createdAt,
      state: options.state,
    }),
  });
}

function createRepositoryFixture(repository: Repository): RepositoryFixture {
  return {
    repository,
    openItems: [],
    individualItems: new Map(),
    details: new Map(),
    enumerationFailsWith503: false,
  };
}

async function createTestConfig(
  options: Readonly<{
    explicitIncludes: readonly string[];
    retentionDays: number;
    aiEnabled: boolean;
  }>,
): Promise<Config> {
  const base = await loadConfig(join(import.meta.dirname, "fixtures/config.valid.yml"));
  const team = Object.freeze({
    org: "VOICEVOX",
    slug: "production-test-team",
  });
  return Object.freeze({
    ...base,
    tracking: Object.freeze({
      ...base.tracking,
      startAt: START_AT,
      include: [...options.explicitIncludes],
      retentionDaysAfterTerminal: options.retentionDays,
    }),
    teams: Object.freeze({
      defaults: Object.freeze({
        maintainers: [team],
        reviewers: [team],
      }),
      repositories: Object.freeze({}),
    }),
    ai: Object.freeze({
      ...base.ai,
      enabled: options.aiEnabled,
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

function configWithBudget(
  config: Config,
  maxCallsPerRun: number,
  maxEstimatedCostUsdPerRun: number,
): Config {
  return Object.freeze({
    ...config,
    ai: Object.freeze({
      ...config.ai,
      budget: Object.freeze({
        ...config.ai.budget,
        maxCallsPerRun,
        maxEstimatedCostUsdPerRun,
      }),
    }),
  });
}

function configWithRelationExpansionLimit(config: Config, maxItemsPerRun: number): Config {
  return Object.freeze({
    ...config,
    tracking: Object.freeze({
      ...config.tracking,
      relationExpansion: Object.freeze({
        maxItemsPerRun,
      }),
    }),
  });
}

function requireSingleRepository(repositories: readonly PublicRepository[]): PublicRepository {
  const repository = repositories[0];
  if (repository == null || repositories.length !== 1) {
    throw new TypeError("repository単位の収集呼び出しではありません");
  }
  return repository;
}

function requireDryRunSnapshot(artifacts: readonly unknown[]): StateSnapshot {
  const artifact = artifacts.at(-1);
  if (typeof artifact !== "object" || artifact == null || !("result" in artifact)) {
    throw new TypeError("dry-run artifactがありません");
  }
  const result = artifact.result;
  if (typeof result !== "object" || result == null || !("snapshot" in result)) {
    throw new TypeError("dry-run artifactにsnapshotがありません");
  }
  return createStateSnapshot(result.snapshot);
}

function requireCollectionItem(
  snapshot: StateSnapshot,
  nodeId: GitHubNodeId,
): StateSnapshot["collection"]["repositories"][number]["items"][number] {
  const item = snapshot.collection.repositories
    .flatMap((repository) => repository.items)
    .find((candidate) => candidate.nodeId === nodeId);
  if (item == null) {
    throw new TypeError(`snapshotの収集項目がありません。対象: ${nodeId}`);
  }
  return item;
}

async function replaceStateSnapshot(
  adapter: MemoryStateBranchAdapter,
  snapshot: StateSnapshot,
  committedAt: UtcIsoDateTime,
): Promise<void> {
  const head = await adapter.resolveHead("tracker-state");
  if (head.status !== "present") {
    throw new TypeError("置換対象のstate branchがありません");
  }
  await adapter.commit({
    branch: "tracker-state",
    expectedHead: head,
    updates: [
      {
        path: "state/snapshot.json",
        bytes: new TextEncoder().encode(serializeStateSnapshot(snapshot)),
      },
    ],
    message: "停滞起点の保存値を置き換えるfixture",
    committedAt,
  });
}

function createCodexOutput(
  input: CodexAnalysisInput,
  options: Readonly<{
    status: "waiting_for_author" | "waiting_for_automation" | "in_progress" | "unknown";
    waitingOn: Readonly<{
      candidateId: string;
      kind: "user" | "team" | "role" | "item" | "automation" | "unknown";
      role:
        | "author"
        | "maintainer"
        | "reviewer"
        | "assignee"
        | "dependency"
        | "merge_decider"
        | "ci"
        | "unknown";
      sourceId: string;
    }>;
    latestMeaningfulSourceId: string | null;
    confidence: number;
    relationVerdict: RelationAssessmentVerdict;
    notification: Readonly<{
      recommended: boolean;
      reasonCode: NotificationReasonCode;
      reasonSummary: string;
    }>;
  }>,
): unknown {
  const evidenceSource = input.sources[0];
  if (evidenceSource == null) {
    throw new TypeError("Codex入力にsourceがありません");
  }
  return {
    schemaVersion: "1",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: options.status,
    waitingOn: [
      {
        kind: options.waitingOn.kind,
        candidateId: options.waitingOn.candidateId,
        role: options.waitingOn.role,
        reasonSummary: "本番経路fixtureの判定です",
        sourceIds: [options.waitingOn.sourceId],
        confidence: options.confidence,
      },
    ],
    nextAction: "本番経路fixtureの次の対応を行う",
    relations: input.candidates.relations.map((candidate) => ({
      candidateId: candidate.id,
      verdict: options.relationVerdict,
      reasonSummary: "本番経路fixtureの関係判定です",
      sourceIds: [evidenceSource.id],
      confidence: options.confidence,
    })),
    progress: {
      latestMeaningfulSourceId: options.latestMeaningfulSourceId,
      reasonSummary: "本番経路fixtureの進捗判定です",
      confidence: options.confidence,
    },
    evidence: [
      {
        sourceId: evidenceSource.id,
        supports: "status",
        summary: "本番経路fixtureの根拠です",
      },
    ],
    confidence: options.confidence,
    uncertainties: [],
    notification: options.notification,
  };
}

function createCollectionHarness(
  options: Readonly<{
    repositories: readonly RepositoryFixture[];
    config: Config;
    executeCodexAnalysis?: (input: CodexAnalysisInput) => Promise<unknown>;
  }>,
) {
  const stateAdapter = new MemoryStateBranchAdapter();
  const artifacts: unknown[] = [];
  const publicData: GeneratedPublicData[] = [];
  const discordCandidateNodeIds: GitHubNodeId[][] = [];
  const detailCalls: DetailCall[] = [];
  const individualCalls: string[][] = [];
  let normalDiscordCallCount = 0;
  let operationsDiscordCallCount = 0;
  let codexExecutionCount = 0;
  const codexInputs: CodexAnalysisInput[] = [];
  let currentTime = FIRST_RUN_AT;
  let inventory = options.repositories.map((fixture) => fixture.repository);
  let config = options.config;
  const fixturesByRepositoryId = new Map(
    options.repositories.map((fixture) => [fixture.repository.id, fixture]),
  );
  const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
    environment: Object.freeze({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      GH_APP_INSTALLATION_ID: "456",
      HOME: "/tmp",
      OPENAI_API_KEY: "production-collection-openai-key",
      PATH: "/usr/bin",
    }),
    repositoryPath: join(import.meta.dirname, ".."),
    pagesOutputDirectory: "unused-pages",
    loadConfig: () => Promise.resolve(config),
    openStateSession: (adapter, configuration) =>
      StatePersistenceSession.open(adapter, configuration),
    discoverRepositoryInventory: () => Promise.resolve(Object.freeze([...inventory])),
    collectGitHubTeamDirectory: () =>
      Promise.resolve(
        Object.freeze([
          Object.freeze({
            nodeId: createGitHubNodeId("T_production_test"),
            org: "VOICEVOX",
            slug: "production-test-team",
            members: Object.freeze([]),
          }),
        ]),
      ),
    enumerateOpenGitHubItems: (input) => {
      const repository = requireSingleRepository(input.allowlist.repositories);
      const fixture = fixturesByRepositoryId.get(repository.id);
      if (fixture == null) {
        throw new TypeError(`repository fixtureがありません。対象: ${repository.id}`);
      }
      if (fixture.enumerationFailsWith503) {
        throw new GitHubRetryExhaustedError(503, 4, {
          cause: new Error("repository fixture 503"),
        });
      }
      return Promise.resolve(Object.freeze([...fixture.openItems]));
    },
    enumerateGitHubItemsByIdentifiers: (input) => {
      individualCalls.push([...input.identifiers]);
      const items = input.identifiers.map((identifier) => {
        for (const fixture of options.repositories) {
          const item =
            fixture.individualItems.get(identifier) ??
            [...fixture.individualItems.values()].find(
              (candidate) => candidate.nodeId === identifier || candidate.url === identifier,
            );
          if (item != null && input.allowlist.has(item.repositoryId)) {
            return item;
          }
        }
        throw new TypeError(`個別項目fixtureがありません。対象: ${identifier}`);
      });
      return Promise.resolve(Object.freeze(items));
    },
    collectGitHubItemDetails: (input) => {
      detailCalls.push(
        Object.freeze({
          targets: Object.freeze(
            input.targets.map((target) =>
              Object.freeze({
                nodeId: target.item.nodeId,
                eventWindow: target.eventWindow,
              }),
            ),
          ),
        }),
      );
      const items = input.targets.map((target) => {
        const item = target.item;
        const fixture = fixturesByRepositoryId.get(item.repositoryId);
        const detail = fixture?.details.get(item.nodeId);
        if (detail == null) {
          throw new TypeError(`詳細fixtureがありません。対象: ${item.nodeId}`);
        }
        return detail;
      });
      return Promise.resolve(
        Object.freeze({
          capabilities: Object.freeze({
            nativeDependencies: "available",
            nativeHierarchy: "available",
          }),
          items: Object.freeze(items),
        }),
      );
    },
    executeCodexAnalysis: (input) => {
      codexExecutionCount += 1;
      codexInputs.push(input);
      return (
        options.executeCodexAnalysis?.(input) ?? Promise.reject(new TypeError("Codex失敗fixture"))
      );
    },
    readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
    readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
    readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
    readWorkflowArtifact: () => Promise.reject(new TypeError("workflow artifactは読みません")),
    createGitHubClient: () =>
      Promise.resolve(
        Object.freeze({
          installationId: 456,
          request: () => Promise.reject(new TypeError("GitHub RESTはmock adapter内だけで使います")),
          graphql: () =>
            Promise.reject(new TypeError("GitHub GraphQLはmock adapter内だけで使います")),
          getRateLimitSnapshot: () =>
            Object.freeze({
              source: "rest",
              limit: 5000,
              remaining: 4000,
              resetAt: currentTime,
              observedAt: currentTime,
              resource: "core",
            }),
        }),
      ),
    createStateBranchAdapter: () => stateAdapter,
    codexProcessRunner: (request) => {
      if (request.arguments.length === 1 && request.arguments[0] === "--version") {
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
      }
      return Promise.reject(new TypeError("Codex subprocessは起動しません"));
    },
    discordHttpClient: Object.freeze({
      execute: () => Promise.reject(new TypeError("Discord HTTPは呼びません")),
    }),
    now: () => new Date(currentTime),
    sleep: () => Promise.resolve(),
    random: () => 0,
    writeStandardOutput: () => Promise.resolve(),
    writeJsonArtifact: (_path, value) => {
      artifacts.push(value);
      return Promise.resolve();
    },
    writeTextFile: () => Promise.resolve(),
    writePublicData: (_outputDirectory, data) => {
      publicData.push(data);
      return Promise.resolve({
        summaryPath: "unused-pages/summary.json",
        detailsPath: "unused-pages/details.json",
        summaryBytes: 1,
        detailsBytes: 1,
      });
    },
    sendDiscord: (input) => {
      if (input.pagesDeployment.status === "succeeded") {
        normalDiscordCallCount += 1;
      } else {
        operationsDiscordCallCount += 1;
      }
      discordCandidateNodeIds.push(input.candidates.map((candidate) => candidate.itemNodeId));
      return Promise.resolve(
        Object.freeze({
          status: "skipped",
          reason: "no_candidates",
        } satisfies DiscordDigestDelivery),
      );
    },
  });
  const application = createProductionCliApplication(runtimeAdapters);
  return {
    artifacts,
    codexInputs,
    detailCalls,
    discordCandidateNodeIds,
    individualCalls,
    stateAdapter,
    publicData,
    codexExecutionCount: () => codexExecutionCount,
    normalDiscordCallCount: () => normalDiscordCallCount,
    operationsDiscordCallCount: () => operationsDiscordCallCount,
    setInventory: (value: readonly Repository[]) => {
      inventory = [...value];
    },
    setConfig: (value: Config) => {
      config = value;
    },
    runDaily: (at: string) => {
      currentTime = at;
      return application.run([
        "daily",
        "--config",
        "unused-config.yml",
        "--report",
        "unused-report.json",
      ]);
    },
    runAllOpenBackfill: (at: string, repositoryFullName: string) => {
      currentTime = at;
      return application.run([
        "backfill",
        "--mode",
        "all-open",
        "--repository",
        repositoryFullName,
        "--config",
        "unused-config.yml",
        "--report",
        "unused-report.json",
      ]);
    },
    runDry: (at: string) => {
      currentTime = at;
      return application.run([
        "dry-run",
        "--config",
        "unused-config.yml",
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
      ]);
    },
  };
}

function setIssueDetails(
  fixture: RepositoryFixture,
  items: readonly EnumeratedGitHubItem[],
  observedAt: UtcIsoDateTime,
): void {
  fixture.details = new Map(
    items.map((item) => [
      item.nodeId,
      createIssueDetail({
        item,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    ]),
  );
}

async function collectRelationCandidateDiagnostics(
  endpointAvailability: "resolved" | "unavailable",
): Promise<
  Readonly<{
    diagnostics: readonly string[];
    identifierCanaries: readonly string[];
  }>
> {
  const repository = createRepository(
    "R_relation_candidate_diagnostic",
    "relation-candidate-diagnostic",
    FIRST_RUN_AT,
  );
  const publicRepository = requirePublicRepository(repository);
  const unavailableRepository = requirePublicRepository(
    createRepository(
      "R_relation_candidate_unavailable",
      "relation-repository-identifier-canary",
      FIRST_RUN_AT,
    ),
  );
  const targetRepository =
    endpointAvailability === "resolved" ? publicRepository : unavailableRepository;
  const fixture = createRepositoryFixture(repository);
  const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
  const tracked = createIssueItem({
    repository: publicRepository,
    number: 1,
    fingerprint: "relation-diagnostic-root",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({ state: "open" }),
  });
  const target = Object.freeze({
    ...createOldIssueItem(targetRepository, 2, "relation-diagnostic-target", observedAt),
    title: "relation-title-identifier-canary",
  });
  const body = "relation-body-identifier-canary";
  fixture.openItems = [tracked];
  fixture.details.set(
    tracked.nodeId,
    createIssueDetail({
      item: tracked,
      body,
      observedAt,
      nativeDependencies: Object.freeze([createNativeBlocker(tracked, target)]),
      duplicateComments: false,
    }),
  );
  if (endpointAvailability === "resolved") {
    fixture.individualItems.set(target.nodeId, target);
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
  }
  const config = await createTestConfig({
    explicitIncludes: [],
    retentionDays: 180,
    aiEnabled: false,
  });
  const harness = createCollectionHarness({ repositories: [fixture], config });

  const result = await harness.runDry(FIRST_RUN_AT);
  if (result.command !== "dry-run" || result.exitCode !== 0) {
    throw new TypeError("関係候補diagnostic fixtureのrunが成功しませんでした");
  }
  return Object.freeze({
    diagnostics: result.result.report.diagnostics,
    identifierCanaries: Object.freeze([
      target.nodeId,
      target.url,
      target.title,
      targetRepository.name,
      publicRepository.name,
      body,
    ]),
  });
}

function createHistoryInputDetail(
  item: EnumeratedGitHubItem,
  occurredAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  const comment = createDuplicateComments(item, occurredAt)[0];
  if (comment == null) {
    throw new TypeError("履歴入力イベント用のコメントがありません");
  }
  const labelerNodeId = createGitHubNodeId("U_history_labeler");
  const labelEvent = Object.freeze({
    sourceId: buildSourceId("github_timeline_event", "L_history_label"),
    nodeId: createGitHubNodeId("L_history_label"),
    sequence: 1,
    occurredAt,
    actor: Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_actor", labelerNodeId),
        nodeId: labelerNodeId,
        login: "history-labeler",
        apiType: "User",
      }),
    }),
    kind: "labeled",
    label: Object.freeze({
      sourceId: buildSourceId("github_label", "LA_history"),
      nodeId: createGitHubNodeId("LA_history"),
      name: "履歴対象",
    }),
  } satisfies GitHubTimelineEvent);
  return Object.freeze({
    ...createIssueDetail({
      item,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
    comments: Object.freeze([comment]),
    timeline: Object.freeze([labelEvent]),
  });
}

describe("本番収集の接続", () => {
  it("Pull Request作成前のcommittedDateをincremental_collection相当の経路で処理できる", async () => {
    const repository = createRepository(
      "R_pre_creation_commit",
      "pre-creation-commit",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "pre-creation-commit",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        headCommit: Object.freeze({
          ...detail.headCommit,
          committedAt: createUtcIsoDateTime("2026-06-30T00:00:00.000Z"),
          pushedAt: Object.freeze({
            status: "unavailable",
            reason: "github_did_not_return_pushed_at",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
  });

  it("同じcommitを共有する複数Pull Requestを履歴と公開データへ保存する", async () => {
    const repository = createRepository("R_shared_commit", "shared-commit", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const first = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "shared-commit-first",
      updatedAt: observedAt,
      observedAt,
    });
    const second = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "shared-commit-second",
      updatedAt: observedAt,
      observedAt,
    });
    const sharedCommitNodeId = createGitHubNodeId("C_shared_commit");
    const sharedSourceId = buildSourceId("github_commit", sharedCommitNodeId);
    const sharedHeadSha = "shared-head-sha";
    const firstDetail = createFailedCheckPullRequestDetail(first, observedAt);
    const secondDetail = createFailedCheckPullRequestDetail(second, observedAt);
    const sharedHeadCommit = Object.freeze({
      ...firstDetail.headCommit,
      sourceId: sharedSourceId,
      nodeId: sharedCommitNodeId,
      sha: sharedHeadSha,
    });
    fixture.openItems = [first, second];
    fixture.details.set(
      first.nodeId,
      Object.freeze({
        ...firstDetail,
        headSha: sharedHeadSha,
        headCommit: sharedHeadCommit,
      }),
    );
    fixture.details.set(
      second.nodeId,
      Object.freeze({
        ...secondDetail,
        headSha: sharedHeadSha,
        headCommit: sharedHeadCommit,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const historyBytes = files.get("state/history/2026-08-01.jsonl");
    if (historyBytes == null) {
      throw new TypeError("共有commitの履歴がありません");
    }
    const historyRecords = parseStateHistoryRecords(new TextDecoder().decode(historyBytes));
    const sharedHistoryEvents = historyRecords
      .flatMap((record) => record.inputEvents)
      .filter((event) => event.sourceId === sharedSourceId);
    const publicData = harness.publicData.at(-1);
    if (publicData == null) {
      throw new TypeError("共有commitの公開データがありません");
    }
    const sharedPublicItems = publicData.details.items.filter((item) =>
      item.inputEvents.some((event) => event.sourceId === sharedSourceId),
    );

    expect(result.exitCode).toBe(0);
    expect(sharedHistoryEvents.map((event) => event.itemNodeId)).toEqual(
      [first.nodeId, second.nodeId].sort(),
    );
    expect(sharedPublicItems).toHaveLength(2);
    expect(
      sharedPublicItems.map((item) => ({
        nodeId: item.summary.nodeId,
        url: item.inputEvents.find((event) => event.sourceId === sharedSourceId)?.url,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          nodeId: first.nodeId,
          url: first.url,
        },
        {
          nodeId: second.nodeId,
          url: second.url,
        },
      ]),
    );
  });

  it("作成時刻が異なるPull Requestで共有するcommit sourceの最古時刻をedgeへ使う", async () => {
    const repository = createRepository(
      "R_shared_commit_occurred_at",
      "shared-commit-occurred-at",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const commitOccurredAt = createUtcIsoDateTime("2026-07-10T03:13:05.000Z");
    const earlierPullRequest = replaceCreatedAt(
      createPullRequestItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "shared-commit-occurred-at-earlier",
        updatedAt: observedAt,
        observedAt,
      }),
      createUtcIsoDateTime("2026-07-05T10:13:26.000Z"),
    );
    const laterPullRequest = replaceCreatedAt(
      createPullRequestItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "shared-commit-occurred-at-later",
        updatedAt: observedAt,
        observedAt,
      }),
      createUtcIsoDateTime("2026-07-10T07:03:33.000Z"),
    );
    const sharedCommitNodeId = createGitHubNodeId("C_shared_commit_occurred_at");
    const sharedSourceId = buildSourceId("github_commit", sharedCommitNodeId);
    const sharedHeadSha = "shared-commit-occurred-at-head";
    const earlierDetail = createFailedCheckPullRequestDetail(earlierPullRequest, observedAt);
    const laterDetail = createFailedCheckPullRequestDetail(laterPullRequest, observedAt);
    const sharedHeadCommit = Object.freeze({
      ...earlierDetail.headCommit,
      sourceId: sharedSourceId,
      nodeId: sharedCommitNodeId,
      sha: sharedHeadSha,
      committedAt: commitOccurredAt,
      pushedAt: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_pushed_at",
      }),
    });
    const crossReference = createInboundCrossReference(
      earlierPullRequest,
      laterPullRequest,
      observedAt,
    );
    fixture.openItems = [earlierPullRequest, laterPullRequest];
    fixture.details.set(
      earlierPullRequest.nodeId,
      Object.freeze({
        ...earlierDetail,
        headSha: sharedHeadSha,
        headCommit: sharedHeadCommit,
        inboundCrossReferences: Object.freeze([
          Object.freeze({
            ...crossReference.candidate,
            eventSourceId: sharedSourceId,
          }),
        ]),
      }),
    );
    fixture.details.set(
      laterPullRequest.nodeId,
      Object.freeze({
        ...laterDetail,
        headSha: sharedHeadSha,
        headCommit: sharedHeadCommit,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("共有commit時刻fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotBytes = files.get("state/snapshot.json");
    const historyBytes = files.get("state/history/2026-08-01.jsonl");
    if (snapshotBytes == null || historyBytes == null) {
      throw new TypeError("共有commit時刻のstateがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotBytes));
    const historyRecords = parseStateHistoryRecords(new TextDecoder().decode(historyBytes));
    const relation = snapshot.relations.find((candidate) =>
      candidate.evidence.some((evidence) => evidence.sourceId === sharedSourceId),
    );
    const sharedCommitOccurredAts = historyRecords
      .flatMap((record) => record.inputEvents)
      .filter((event) => event.sourceId === sharedSourceId)
      .map((event) => event.occurredAt)
      .sort();

    expect(result.exitCode).toBe(0);
    expect(sharedCommitOccurredAts).toEqual([commitOccurredAt, laterPullRequest.createdAt]);
    expect(relation).toMatchObject({
      active: true,
      firstSeenAt: commitOccurredAt,
    });
  });

  it("AI無効時の有効状態と利用可否をrun成功状態から分離して保存する", async () => {
    const repository = createRepository("R_ai_disabled", "ai-disabled", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "ai-disabled-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(snapshot.run.status).toBe("success");
    expect(snapshot.ai).toEqual({
      enabled: false,
      available: false,
      degraded: false,
    });
  });

  it("milestoneを期限と信頼できないタイトルを含めてsnapshotと公開summaryへ渡す", async () => {
    const repository = createRepository("R_milestone", "milestone", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const baseItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "milestone-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const itemMilestone = Object.freeze({
      nodeId: createGitHubNodeId("M_milestone_v1"),
      number: 1,
      title: "<script>サンプルリリース</script>",
      state: "open",
      dueOn: createUtcIsoDateTime("2026-09-01T00:00:00Z"),
    } satisfies GitHubItemMilestone);
    const item = Object.freeze({
      ...baseItem,
      milestone: itemMilestone,
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("milestoneのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));
    const expectedMilestone = {
      nodeId: "M_milestone_v1",
      number: 1,
      title: "<script>サンプルリリース</script>",
      state: "open",
      dueOn: "2026-09-01T00:00:00.000Z",
    };
    const expectedImportance = {
      score: 10,
      level: "low",
      factors: [
        {
          kind: "milestoneDeadline",
          points: 10,
          detail: "期限付きのopen milestoneで10点です",
        },
      ],
    };
    const publicData = harness.publicData.at(-1);
    if (publicData == null) {
      throw new TypeError("milestoneの公開DTOがありません");
    }

    expect(result.exitCode).toBe(0);
    expect(snapshot.schemaVersion).toBe("5");
    expect(snapshot.items[0]?.milestone).toEqual(expectedMilestone);
    expect(snapshot.items[0]?.importance).toEqual(expectedImportance);
    expect(publicData.summary.schemaVersion).toBe("3");
    expect(publicData.summary.items[0]?.milestone).toEqual(expectedMilestone);
    expect(publicData.summary.items[0]?.importance).toEqual({
      score: 10,
      level: "low",
    });
    expect(publicData.details.schemaVersion).toBe("3");
    expect(publicData.details.items[0]?.summary.milestone).toEqual(expectedMilestone);
    expect(publicData.details.items[0]?.importanceFactors).toEqual(expectedImportance.factors);
  });

  it("両側detailの同じnative依存を1候補へ統合してIssue状態を判定する", async () => {
    const repository = createRepository(
      "R_bidirectional_native_dependency",
      "bidirectional-native-dependency",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "bidirectional-native-blocked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "bidirectional-native-blocker",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blockedBy = createNativeBlocker(blocked, blocker);
    const blocking = createNativeBlocking(blocker, blocked);
    fixture.openItems = [blocked, blocker];
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: "blocker側にも同じnative依存があります",
        observedAt,
        nativeDependencies: Object.freeze([blockedBy]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      blocker.nodeId,
      createIssueDetail({
        item: blocker,
        body: "blocked側にも同じnative依存があります",
        observedAt,
        nativeDependencies: Object.freeze([blocking]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const relations = snapshot.relations.filter(
      (relation) => relation.fromNodeId === blocker.nodeId && relation.toNodeId === blocked.nodeId,
    );
    const sourceIds = [blockedBy.sourceId, blocking.sourceId].sort();

    expect(result.exitCode).toBe(0);
    expect(trackedItem).toMatchObject({
      status: "blocked",
      statusSince: blocked.createdAt,
      ownerSince: blocked.createdAt,
      waitingOn: [
        {
          candidateId: blocker.nodeId,
          sourceIds,
        },
      ],
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]?.evidence.map((evidence) => evidence.sourceId).sort()).toEqual(sourceIds);
  });

  it("同じ2 node間の複数active blocks edgeを統合してIssue状態を判定する", async () => {
    const repository = createRepository(
      "R_multiple_block_edges",
      "multiple-block-edges",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "multiple-block-edges-first",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const otherBlocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "multiple-block-edges-other-blocker",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 3,
      fingerprint: "multiple-block-edges-blocker",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const body = `推定依存候補は ${blocker.url} です`;
    fixture.openItems = [blocked, otherBlocker, blocker];
    setIssueDetails(fixture, [blocked, otherBlocker, blocker], firstObservedAt);
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body,
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("複数blocks edge fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "current_is_blocked_by_target",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("推定blocks edge作成後のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    expect(firstSnapshot.items.find((item) => item.nodeId === blocked.nodeId)?.status).not.toBe(
      "blocked",
    );

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const changedBlocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "multiple-block-edges-second",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const nativeDependency = createNativeBlocker(changedBlocked, blocker);
    const otherNativeDependency = createNativeBlocker(changedBlocked, otherBlocker);
    fixture.openItems = [changedBlocked, otherBlocker, blocker];
    fixture.details.set(
      changedBlocked.nodeId,
      createIssueDetail({
        item: changedBlocked,
        body,
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([nativeDependency, otherNativeDependency]),
        duplicateComments: false,
      }),
    );
    harness.artifacts.length = 0;

    const result = await harness.runDry(SECOND_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const relations = snapshot.relations
      .filter(
        (relation) =>
          relation.active &&
          relation.type === "blocks" &&
          relation.fromNodeId === blocker.nodeId &&
          relation.toNodeId === blocked.nodeId,
      )
      .sort((left, right) => left.provenance.localeCompare(right.provenance));
    const sourceIds = [
      buildSourceId("github_item_body", blocked.nodeId),
      buildSourceId("github_item_detail", blocked.nodeId),
      nativeDependency.sourceId,
    ].sort();

    expect(result.exitCode).toBe(0);
    expect(relations).toHaveLength(2);
    expect(relations).toMatchObject([
      {
        provenance: "explicit_text",
        confidence: 0.7,
        firstSeenAt: blocked.createdAt,
      },
      {
        provenance: "native",
        confidence: 1,
        firstSeenAt: changedBlocked.createdAt,
      },
    ]);
    expect(trackedItem).toMatchObject({
      status: "blocked",
      statusSince: changedBlocked.createdAt,
      primaryWaitingOn: {
        index: 0,
      },
      waitingOn: [
        {
          candidateId: otherBlocker.nodeId,
          role: "dependency",
          confidence: 1,
          sourceIds: [otherNativeDependency.sourceId],
        },
        {
          candidateId: blocker.nodeId,
          role: "dependency",
          confidence: 1,
          sourceIds,
        },
      ],
    });
  });

  it("native edgeに反するAI判定を維持したedgeの矛盾として永続化する", async () => {
    const repository = createRepository(
      "R_native_contradiction",
      "native-contradiction",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "native-contradiction-blocked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "native-contradiction-blocker",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [blocked, blocker];
    setIssueDetails(fixture, [blocked, blocker], observedAt);
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: "native dependencyに反する判定を検証します",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(blocked, blocker)]),
        duplicateComments: true,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        if (input.item.nodeId !== blocked.nodeId) {
          throw new TypeError("矛盾fixtureでblocked項目以外がCodex対象になりました");
        }
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("矛盾fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "current_blocks_target",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotBytes = files.get("state/snapshot.json");
    const historyBytes = files.get("state/history/2026-08-01.jsonl");
    if (snapshotBytes == null || historyBytes == null) {
      throw new TypeError("矛盾fixtureの永続化stateがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotBytes));
    const historyRecords = parseStateHistoryRecords(new TextDecoder().decode(historyBytes));
    const relation = snapshot.relations.find(
      (entry) => entry.fromNodeId === blocker.nodeId && entry.toNodeId === blocked.nodeId,
    );
    if (relation == null) {
      throw new TypeError("矛盾fixtureのnative edgeがありません");
    }
    const publicData = harness.publicData.at(-1);
    if (publicData == null) {
      throw new TypeError("矛盾fixtureの公開DTOがありません");
    }
    const historyEdgeEvent = historyRecords
      .flatMap((record) => record.events)
      .find((event) => event.kind === "edge_set" && event.relationId === relation.id);
    const publicEdge = publicData.details.graph.edges.find((edge) => edge.id === relation.id);
    const publicHistoryEvent = publicData.details.graph.history.find(
      (event) => event.relationId === relation.id,
    );

    expect(result.exitCode).toBe(0);
    expect(relation).toMatchObject({
      type: "blocks",
      provenance: "native",
      confidence: 1,
      contradictions: [
        {
          verdict: "current_blocks_target",
          confidence: 0.95,
        },
      ],
      active: true,
    });
    expect(Object.keys(relation.contradictions[0] ?? {}).sort()).toEqual(["confidence", "verdict"]);
    expect(historyEdgeEvent).toMatchObject({
      kind: "edge_set",
      relationId: relation.id,
      value: {
        provenance: "native",
        confidence: 1,
        contradictions: [
          {
            verdict: "current_blocks_target",
            confidence: 0.95,
          },
        ],
        active: true,
      },
    });
    expect(publicEdge).toMatchObject({
      id: relation.id,
      provenance: "native",
      confidence: 1,
      contradictions: [
        {
          verdict: "current_blocks_target",
          confidence: 0.95,
        },
      ],
      active: true,
    });
    expect(publicHistoryEvent).toMatchObject({
      relationId: relation.id,
      after: {
        state: "present",
        value: {
          contradictions: [
            {
              verdict: "current_blocks_target",
              confidence: 0.95,
            },
          ],
        },
      },
    });
  });

  it("同じupdated_atの正規化イベントをkind別に履歴へ一度だけ保存する", async () => {
    const repository = createRepository("R_history_events", "history-events", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "history-events-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstItem];
    fixture.details.set(
      firstItem.nodeId,
      createHistoryInputDetail(firstItem, firstObservedAt, firstObservedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstHistoryBytes = firstFiles.get("state/history/2026-08-01.jsonl");
    if (firstHistoryBytes == null) {
      throw new TypeError("正規化イベントの初回履歴がありません");
    }
    const firstRecords = parseStateHistoryRecords(new TextDecoder().decode(firstHistoryBytes));

    expect(firstRecords[0]?.inputEvents).toEqual([
      {
        sourceId: `github_issue_comment:IC_${firstItem.nodeId}`,
        itemNodeId: firstItem.nodeId,
        kind: "comment",
        actor: {
          type: "human",
          nodeId: "U_commenter",
          login: "commenter",
        },
        occurredAt: firstObservedAt,
      },
      {
        sourceId: "github_timeline_event:L_history_label",
        itemNodeId: firstItem.nodeId,
        kind: "label",
        actor: {
          type: "human",
          nodeId: "U_history_labeler",
          login: "history-labeler",
        },
        occurredAt: firstObservedAt,
      },
    ]);

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "history-events-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [secondItem];
    fixture.details.set(
      secondItem.nodeId,
      createHistoryInputDetail(secondItem, firstObservedAt, secondObservedAt),
    );

    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    const secondFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const secondHistoryBytes = secondFiles.get("state/history/2026-08-02.jsonl");
    if (secondHistoryBytes == null) {
      throw new TypeError("正規化イベントの二回目の履歴がありません");
    }
    const secondRecords = parseStateHistoryRecords(new TextDecoder().decode(secondHistoryBytes));

    expect(secondRecords[0]?.inputEvents).toEqual([]);
  });

  it("automation dashboardをgraphに残しつつ既定digestから除外する", async () => {
    const repository = createRepository("R_automation", "automation", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = replaceWithAutomationDashboard(
      createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "automation-dashboard",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      "依存更新ダッシュボード",
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      notifications: Object.freeze({
        ...baseConfig.notifications,
        automationNoiseTitles: ["依存更新ダッシュボード"],
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("automation dashboardのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

    expect(result.exitCode).toBe(0);
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        nodeId: item.nodeId,
        notificationClass: "automation_noise",
      }),
    );
    expect(harness.publicData[0]?.details.graph.nodes).toContainEqual(
      expect.objectContaining({
        nodeId: item.nodeId,
      }),
    );
    expect(harness.discordCandidateNodeIds).toEqual([[]]);
  });

  it("tracked項目の本文とコメントから参照された開始日前項目を追跡する", async () => {
    const repository = createRepository("R_outbound_reference", "outbound-reference", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const bodyReferenced = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "body-referenced",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const commentReferenced = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "comment-referenced",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const commentNodeId = createGitHubNodeId("IC_outbound_reference");
    const referenceComment = Object.freeze({
      sourceId: buildSourceId("github_issue_comment", commentNodeId),
      nodeId: commentNodeId,
      sequence: 0,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", "U_outbound_reference"),
          nodeId: createGitHubNodeId("U_outbound_reference"),
          login: "outbound-reference-author",
          apiType: "User",
        }),
      }),
      body: `${commentReferenced.url} をコメントから参照します`,
      createdAt: observedAt,
      updatedAt: observedAt,
      url: tracked.url,
    } satisfies GitHubIssueComment);
    fixture.openItems = [tracked, bodyReferenced, commentReferenced];
    setIssueDetails(fixture, fixture.openItems, observedAt);
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: tracked,
          body: `${bodyReferenced.url} を本文から参照します`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([referenceComment]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          referencesTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const trackedNodeIds = requireDryRunSnapshot(harness.artifacts).items.map(
      (item) => item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedNodeIds).toHaveLength(3);
    expect(trackedNodeIds).toEqual(
      expect.arrayContaining([tracked.nodeId, bodyReferenced.nodeId, commentReferenced.nodeId]),
    );
  });

  it("tracked項目へのcross-reference元である開始日前項目を追跡する", async () => {
    const repository = createRepository("R_inbound_reference", "inbound-reference", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "cross-reference-source",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const sourceItem = Object.freeze({
      sourceId: buildSourceId("github_item", source.nodeId),
      nodeId: source.nodeId,
      repositoryId: source.repositoryId,
      repositoryOwner: publicRepository.owner,
      repositoryName: publicRepository.name,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: source.type,
      number: source.number,
      url: source.url,
      createdAt: source.createdAt,
      state: source.state,
    } satisfies GitHubReferencedItem);
    const eventNodeId = createGitHubNodeId("CRE_inbound_reference");
    const eventSourceId = buildSourceId("github_timeline_event", eventNodeId);
    const crossReferenceEvent = Object.freeze({
      sourceId: eventSourceId,
      nodeId: eventNodeId,
      sequence: 0,
      occurredAt: observedAt,
      actor: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      kind: "cross_referenced",
      source: sourceItem,
      willCloseTarget: false,
    } satisfies GitHubTimelineEvent);
    const inboundCrossReference = Object.freeze({
      sourceId: buildSourceId("github_inbound_cross_reference", `${eventNodeId}:${source.nodeId}`),
      candidateOnly: true,
      provenance: "cross_reference",
      eventSourceId,
      sourceItem,
    } satisfies GitHubInboundCrossReferenceCandidate);
    fixture.openItems = [tracked, source];
    setIssueDetails(fixture, fixture.openItems, observedAt);
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: tracked,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        timeline: Object.freeze([crossReferenceEvent]),
        inboundCrossReferences: Object.freeze([inboundCrossReference]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          referencedByTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const trackedNodeIds = requireDryRunSnapshot(harness.artifacts).items.map(
      (item) => item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedNodeIds).toHaveLength(2);
    expect(trackedNodeIds).toEqual(expect.arrayContaining([tracked.nodeId, source.nodeId]));
  });

  it("open列挙に含まれない古い参照先を同じrunで取得して追跡候補へ入れる", async () => {
    const repository = createRepository(
      "R_relation_expansion_reference",
      "relation-expansion-reference",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-reference-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstReferenced = createOldIssueItem(
      publicRepository,
      2,
      "old-reference",
      firstObservedAt,
    );
    fixture.openItems = [firstTracked, firstReferenced];
    setIssueDetails(fixture, fixture.openItems, firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.detailCalls.length = 0;
    harness.individualCalls.length = 0;

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-reference-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondReferenced = createOldIssueItem(
      publicRepository,
      2,
      "old-reference",
      secondObservedAt,
    );
    fixture.openItems = [secondTracked];
    fixture.individualItems.set(secondReferenced.nodeId, secondReferenced);
    setIssueDetails(fixture, [secondTracked, secondReferenced], secondObservedAt);
    fixture.details.set(
      secondTracked.nodeId,
      createIssueDetail({
        item: secondTracked,
        body: "本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondTracked, secondReferenced)]),
        duplicateComments: false,
      }),
    );

    const result = await harness.runDry(SECOND_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[secondReferenced.nodeId]]);
    expect(
      harness.detailCalls.map((call) => call.targets.map((target) => target.nodeId)),
    ).toContainEqual([secondReferenced.nodeId]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([secondTracked.nodeId, secondReferenced.nodeId]),
    );
    expect(requireCollectionItem(snapshot, secondReferenced.nodeId)).toMatchObject({
      nodeId: secondReferenced.nodeId,
    });
  });

  it("open列挙に含まれないinbound cross-reference元を同じrunで追跡候補へ入れる", async () => {
    const repository = createRepository(
      "R_relation_expansion_inbound",
      "relation-expansion-inbound",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-inbound",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = createOldIssueItem(publicRepository, 2, "old-inbound-source", observedAt);
    fixture.openItems = [tracked];
    fixture.individualItems.set(source.nodeId, source);
    setIssueDetails(fixture, [tracked, source], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [source], observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[source.nodeId]]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, source.nodeId]),
    );
    expect(requireCollectionItem(snapshot, source.nodeId)).toMatchObject({
      nodeId: source.nodeId,
    });
  });

  it("merge済みPull Requestが列挙結果とcross-reference元に現れても関係候補を抽出する", async () => {
    const repository = createRepository(
      "R_merged_inbound_reference",
      "merged-inbound-reference",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-merged-inbound",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = createMergedPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "merged-inbound-source",
      mergedAt: observedAt,
      observedAt,
    });
    const sourceDetail = createFailedCheckPullRequestDetail(source, observedAt);
    fixture.openItems = [tracked];
    fixture.individualItems.set(source.nodeId, source);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [source], observedAt),
    );
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...sourceDetail,
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `ME_${source.nodeId}`),
            nodeId: createGitHubNodeId(`ME_${source.nodeId}`),
            sequence: 0,
            occurredAt: observedAt,
            actor: Object.freeze({
              status: "unavailable",
              reason: "github_did_not_return_actor",
            }),
            kind: "merged",
          } satisfies GitHubTimelineEvent),
        ]),
        mergeState: Object.freeze({
          ...sourceDetail.mergeState,
          checks: Object.freeze({
            status: "not_configured",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[source.nodeId]]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, source.nodeId]),
    );
  });

  it("後続detailで判明するnative chainを深度3まで取得して深度4を取得しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_depth",
      "relation-expansion-depth",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-depth",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const depthOne = createOldIssueItem(publicRepository, 2, "depth-one", observedAt);
    const depthTwo = createOldIssueItem(publicRepository, 3, "depth-two", observedAt);
    const depthThree = createOldIssueItem(publicRepository, 4, "depth-three", observedAt);
    const depthFour = createOldIssueItem(publicRepository, 5, "depth-four", observedAt);
    fixture.openItems = [tracked];
    for (const item of [depthOne, depthTwo, depthThree, depthFour]) {
      fixture.individualItems.set(item.nodeId, item);
    }
    setIssueDetails(fixture, [tracked, depthOne, depthTwo, depthThree, depthFour], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetail({
        item: tracked,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(tracked, depthOne)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      depthOne.nodeId,
      createIssueDetail({
        item: depthOne,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(depthOne, depthTwo)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      depthTwo.nodeId,
      createIssueDetail({
        item: depthTwo,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(depthTwo, depthThree)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      depthThree.nodeId,
      createIssueDetail({
        item: depthThree,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(depthThree, depthFour)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([
      [depthOne.nodeId],
      [depthTwo.nodeId],
      [depthThree.nodeId],
    ]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, depthOne.nodeId, depthTwo.nodeId, depthThree.nodeId]),
    );
    expect(snapshot.items.map((item) => item.nodeId)).not.toContain(depthFour.nodeId);
    expect(
      snapshot.collection.repositories.flatMap((current) =>
        current.items.map((item) => item.nodeId),
      ),
    ).not.toContain(depthFour.nodeId);
  });

  it("nativeの循環とfan-inでも各nodeを一度だけ個別取得する", async () => {
    const repository = createRepository(
      "R_relation_expansion_cycle",
      "relation-expansion-cycle",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-cycle",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const first = createOldIssueItem(publicRepository, 2, "cycle-first", observedAt);
    const second = createOldIssueItem(publicRepository, 3, "cycle-second", observedAt);
    const shared = createOldIssueItem(publicRepository, 4, "cycle-shared", observedAt);
    fixture.openItems = [tracked];
    for (const item of [first, second, shared]) {
      fixture.individualItems.set(item.nodeId, item);
    }
    setIssueDetails(fixture, [tracked, first, second, shared], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetail({
        item: tracked,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(tracked, first),
          createNativeBlocker(tracked, second),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      first.nodeId,
      createIssueDetail({
        item: first,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(first, shared)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      second.nodeId,
      createIssueDetail({
        item: second,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(second, shared)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      shared.nodeId,
      createIssueDetail({
        item: shared,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(shared, tracked)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const requestedNodeIds = harness.individualCalls.flat();

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[first.nodeId, second.nodeId], [shared.nodeId]]);
    expect(requestedNodeIds).toHaveLength(3);
    expect(new Set(requestedNodeIds).size).toBe(3);
  });

  it("参照系の連鎖を追跡根から1 hopで止めて2 hop目を取得しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_reference_depth",
      "relation-expansion-reference-depth",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-reference-depth",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstSource = createOldIssueItem(publicRepository, 2, "reference-depth-one", observedAt);
    const secondSource = createOldIssueItem(publicRepository, 3, "reference-depth-two", observedAt);
    fixture.openItems = [tracked];
    fixture.individualItems.set(firstSource.nodeId, firstSource);
    fixture.individualItems.set(secondSource.nodeId, secondSource);
    setIssueDetails(fixture, [tracked, firstSource, secondSource], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [firstSource], observedAt),
    );
    fixture.details.set(
      firstSource.nodeId,
      createIssueDetailWithInboundCrossReferences(firstSource, [secondSource], observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[firstSource.nodeId]]);
    expect(snapshot.items.map((item) => item.nodeId)).toContain(firstSource.nodeId);
    expect(snapshot.items.map((item) => item.nodeId)).not.toContain(secondSource.nodeId);
  });

  it("保持期限切れの前回追跡項目を関係先から再取得しても参照をさらに展開しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_expired_previous",
      "relation-expansion-expired-previous",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "expired-previous-root-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const expiredPrevious = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "expired-previous-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    const nextReference = createIssueItem({
      repository: publicRepository,
      number: 3,
      fingerprint: "expired-previous-next-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [tracked];
    fixture.individualItems.set(expiredPrevious.nodeId, expiredPrevious);
    fixture.individualItems.set(nextReference.nodeId, nextReference);
    setIssueDetails(fixture, [tracked, expiredPrevious, nextReference], firstObservedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [expiredPrevious], firstObservedAt),
    );
    fixture.details.set(
      expiredPrevious.nodeId,
      createIssueDetailWithInboundCrossReferences(
        expiredPrevious,
        [nextReference],
        firstObservedAt,
      ),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 1,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[expiredPrevious.nodeId]]);
    harness.individualCalls.length = 0;

    const currentObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const currentTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "expired-previous-root-v2",
      updatedAt: currentObservedAt,
      observedAt: currentObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const currentExpiredPrevious = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "expired-previous-v1",
      updatedAt: firstObservedAt,
      observedAt: currentObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    const currentNextReference = createIssueItem({
      repository: publicRepository,
      number: 3,
      fingerprint: "expired-previous-next-v1",
      updatedAt: firstObservedAt,
      observedAt: currentObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [currentTracked];
    fixture.individualItems.set(currentExpiredPrevious.nodeId, currentExpiredPrevious);
    fixture.individualItems.set(currentNextReference.nodeId, currentNextReference);
    setIssueDetails(
      fixture,
      [currentTracked, currentExpiredPrevious, currentNextReference],
      currentObservedAt,
    );
    fixture.details.set(
      currentTracked.nodeId,
      createIssueDetailWithInboundCrossReferences(
        currentTracked,
        [currentExpiredPrevious],
        currentObservedAt,
      ),
    );
    fixture.details.set(
      currentExpiredPrevious.nodeId,
      createIssueDetailWithInboundCrossReferences(
        currentExpiredPrevious,
        [currentNextReference],
        currentObservedAt,
      ),
    );

    const result = await harness.runDry(THIRD_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[currentExpiredPrevious.nodeId]]);
    expect(harness.individualCalls.flat()).not.toContain(currentNextReference.nodeId);
  });

  it("関係先展開上限に到達したrunでstateとPagesと通常Discord通知を変更しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_limit",
      "relation-expansion-limit",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "limit-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstTracked];
    setIssueDetails(fixture, [firstTracked], firstObservedAt);
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = configWithRelationExpansionLimit(baseConfig, 1);
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode).toBe(0);
    const stateBefore = new Map(await harness.stateAdapter.readBranchFiles("tracker-state"));
    const publicDataCountBefore = harness.publicData.length;
    const normalDiscordCallCountBefore = harness.normalDiscordCallCount();
    harness.individualCalls.length = 0;

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "limit-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstTarget = createOldIssueItem(
      publicRepository,
      2,
      "limit-first-target",
      secondObservedAt,
    );
    const secondTarget = createOldIssueItem(
      publicRepository,
      3,
      "limit-second-target",
      secondObservedAt,
    );
    fixture.openItems = [secondTracked];
    fixture.individualItems.set(firstTarget.nodeId, firstTarget);
    fixture.individualItems.set(secondTarget.nodeId, secondTarget);
    setIssueDetails(fixture, [secondTracked, firstTarget, secondTarget], secondObservedAt);
    fixture.details.set(
      secondTracked.nodeId,
      createIssueDetail({
        item: secondTracked,
        body: "本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(secondTracked, firstTarget),
          createNativeBlocker(secondTracked, secondTarget),
        ]),
        duplicateComments: false,
      }),
    );

    const secondResult = await harness.runDaily(SECOND_RUN_AT);
    const stateAfter = await harness.stateAdapter.readBranchFiles("tracker-state");
    if (secondResult.command !== "daily") {
      throw new TypeError("関係先展開上限fixtureがdaily結果ではありません");
    }

    expect(secondResult.exitCode).toBe(1);
    expect(secondResult.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(secondResult.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        "relationExpansionLimit=1 relationExpansionFetchedCount=0 relationExpansionUnfetchedCount=2",
      ),
    );
    expect(secondResult.result.effects).toEqual({
      stateCommitted: false,
      pagesBuilt: false,
      discordAttempted: true,
      artifactWritten: false,
    });
    expect(harness.individualCalls).toEqual([]);
    expect(stateAfter).toEqual(stateBefore);
    expect(harness.publicData).toHaveLength(publicDataCountBefore);
    expect(harness.normalDiscordCallCount()).toBe(normalDiscordCallCountBefore);
    expect(harness.operationsDiscordCallCount()).toBe(1);
  });

  it("最終状態で未取得端点を持つ関係候補の件数をdiagnosticへ出す", async () => {
    const result = await collectRelationCandidateDiagnostics("unavailable");

    expect(result.diagnostics).toContain("端点を取得できなかった関係候補を1件除外しました");
  });

  it("反復中に未完成だった関係候補が解決されればdiagnosticを出さない", async () => {
    const result = await collectRelationCandidateDiagnostics("resolved");

    expect(
      result.diagnostics.filter((diagnostic) =>
        diagnostic.startsWith("端点を取得できなかった関係候補を"),
      ),
    ).toEqual([]);
  });

  it("落とした関係候補のdiagnosticへ識別子や入力内容を出さない", async () => {
    const result = await collectRelationCandidateDiagnostics("unavailable");
    const diagnostic = result.diagnostics.find((candidate) =>
      candidate.startsWith("端点を取得できなかった関係候補を"),
    );
    if (diagnostic == null) {
      throw new TypeError("落とした関係候補のdiagnosticがありません");
    }

    for (const identifier of result.identifierCanaries) {
      expect(diagnostic).not.toContain(identifier);
    }
  });

  it("前回未追跡で判定規則fingerprint未保存の項目を再び詳細取得しない", async () => {
    const repository = createRepository(
      "R_untracked_unchanged",
      "untracked-unchanged",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createOldIssueItem(publicRepository, 1, "untracked-unchanged", firstObservedAt);
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });
    const diagnosticPrefix = "詳細未取得かつ前回未追跡の項目を追跡候補から";

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    if (firstResult.command !== "daily") {
      throw new TypeError("初回fixtureがdaily結果ではありません");
    }
    expect(firstResult.exitCode).toBe(0);
    expect(
      firstResult.result.report.diagnostics.some((diagnostic) =>
        diagnostic.startsWith(diagnosticPrefix),
      ),
    ).toBe(false);

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItem = createOldIssueItem(
      publicRepository,
      1,
      "untracked-unchanged",
      secondObservedAt,
    );
    fixture.openItems = [secondItem];
    setIssueDetails(fixture, [secondItem], secondObservedAt);
    harness.detailCalls.length = 0;

    const secondResult = await harness.runDaily(SECOND_RUN_AT);
    if (secondResult.command !== "daily") {
      throw new TypeError("増分fixtureがdaily結果ではありません");
    }
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("増分fixtureのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

    expect(secondResult.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([]);
    expect(
      secondResult.result.report.diagnostics.some((diagnostic) =>
        diagnostic.startsWith(diagnosticPrefix),
      ),
    ).toBe(true);
    expect(snapshot.items.map((candidate) => candidate.nodeId)).not.toContain(item.nodeId);
    expect(requireCollectionItem(snapshot, item.nodeId).analysisRulesFingerprint).toEqual({
      status: "unavailable",
    });
  });

  it("判定規則fingerprint未保存の未追跡項目を増分計画から除外する", async () => {
    const repository = createRepository(
      "R_enumerated_relation_expansion",
      "enumerated-relation-expansion",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstReferenced = createOldIssueItem(
      publicRepository,
      2,
      "referenced-unchanged",
      firstObservedAt,
    );
    const firstUnrelated = createOldIssueItem(
      publicRepository,
      3,
      "unrelated-unchanged",
      firstObservedAt,
    );
    fixture.openItems = [firstTracked, firstReferenced, firstUnrelated];
    setIssueDetails(fixture, fixture.openItems, firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.detailCalls.length = 0;
    harness.individualCalls.length = 0;

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondReferenced = createOldIssueItem(
      publicRepository,
      2,
      "referenced-unchanged",
      secondObservedAt,
    );
    const secondUnrelated = createOldIssueItem(
      publicRepository,
      3,
      "unrelated-unchanged",
      secondObservedAt,
    );
    fixture.openItems = [secondTracked, secondReferenced, secondUnrelated];
    setIssueDetails(fixture, fixture.openItems, secondObservedAt);
    fixture.details.set(
      secondTracked.nodeId,
      createIssueDetail({
        item: secondTracked,
        body: "本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondTracked, secondReferenced)]),
        duplicateComments: false,
      }),
    );

    const result = await harness.runDaily(SECOND_RUN_AT);
    if (result.command !== "daily") {
      throw new TypeError("列挙済み関係端点fixtureがdaily結果ではありません");
    }
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("列挙済み関係端点fixtureのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([]);
    expect(harness.detailCalls.map((call) => call.targets.map((target) => target.nodeId))).toEqual([
      [secondTracked.nodeId],
      [secondReferenced.nodeId],
    ]);
    expect(harness.detailCalls[1]?.targets[0]?.eventWindow).toEqual({
      mode: "initial",
    });
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([secondTracked.nodeId, secondReferenced.nodeId]),
    );
    expect(snapshot.items.map((item) => item.nodeId)).not.toContain(secondUnrelated.nodeId);
    expect(result.result.report.diagnostics).toContain(
      "詳細未取得かつ前回未追跡の項目を追跡候補から1件除外しました",
    );
    expect(result.result.report.diagnostics).not.toContain(
      "端点を取得できなかった関係候補を1件除外しました",
    );
  });

  it("詳細取得済み項目の活動時刻を作れないrunは失敗する", async () => {
    const repository = createRepository("R_invalid_activity", "invalid-activity", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "invalid-activity",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      createUtcIsoDateTime(SECOND_RUN_AT),
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    if (result.command !== "daily") {
      throw new TypeError("活動時刻fixtureがdaily結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(harness.detailCalls).toHaveLength(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
    });
  });

  it("all-open backfillで未変更かつ前回未追跡の項目を全履歴取得して追加する", async () => {
    const repository = createRepository("R_all_open_unchanged", "all-open-unchanged", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createOldIssueItem(publicRepository, 1, "all-open-unchanged", firstObservedAt);
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItem = createOldIssueItem(
      publicRepository,
      1,
      "all-open-unchanged",
      secondObservedAt,
    );
    fixture.openItems = [secondItem];
    setIssueDetails(fixture, [secondItem], secondObservedAt);
    harness.detailCalls.length = 0;

    const result = await harness.runAllOpenBackfill(
      SECOND_RUN_AT,
      `${publicRepository.owner}/${publicRepository.name}`,
    );
    if (result.command !== "backfill") {
      throw new TypeError("all-open fixtureがbackfill結果ではありません");
    }
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("all-open fixtureのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([
      {
        targets: [
          {
            nodeId: item.nodeId,
            eventWindow: {
              mode: "initial",
            },
          },
        ],
      },
    ]);
    expect(snapshot.items.map((candidate) => candidate.nodeId)).toContain(item.nodeId);
  });

  it("fingerprint変更項目とgraph隣接nodeだけをoverlap起点で詳細取得する", async () => {
    const repository = createRepository("R_incremental", "incremental", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItems = [1, 2, 3, 4].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `v1-${number.toString()}`,
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...firstItems];
    setIssueDetails(fixture, firstItems, firstObservedAt);
    const first = firstItems[0];
    const blocker = firstItems[2];
    if (first == null || blocker == null) {
      throw new TypeError("増分fixture項目がありません");
    }
    fixture.details.set(
      first.nodeId,
      createIssueDetail({
        item: first,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(first, blocker)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode).toBe(0);
    harness.detailCalls.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItems = firstItems.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint: item.number === 2 ? "v2-2" : `v1-${item.number.toString()}`,
        updatedAt: item.number === 2 ? secondObservedAt : firstObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...secondItems];
    setIssueDetails(fixture, secondItems, secondObservedAt);
    const changed = secondItems[1];
    if (changed == null) {
      throw new TypeError("変更項目fixtureがありません");
    }
    fixture.details.set(
      changed.nodeId,
      createIssueDetail({
        item: changed,
        body: "変更後本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: true,
      }),
    );

    const secondResult = await harness.runDry(SECOND_RUN_AT);

    if (secondResult.exitCode !== 0) {
      throw new TypeError(JSON.stringify(secondResult));
    }
    expect(secondResult).toMatchObject({ exitCode: 0 });
    expect(harness.detailCalls).toHaveLength(1);
    expect(harness.detailCalls[0]).toEqual({
      targets: [first, changed, blocker].map((item) => ({
        nodeId: item.nodeId,
        eventWindow: {
          mode: "incremental",
          since: "2026-07-31T23:55:00.000Z",
        },
      })),
    });
    expect(requireDryRunSnapshot(harness.artifacts).items).toHaveLength(4);
  });

  it("判定規則変更項目と初回判定のupdated_at変更項目を全履歴で収集する", async () => {
    const repository = createRepository("R_mixed_windows", "mixed-windows", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstUntracked = createOldIssueItem(publicRepository, 2, "untracked-v1", firstObservedAt);
    fixture.openItems = [firstTracked, firstUntracked];
    setIssueDetails(fixture, fixture.openItems, firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.detailCalls.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v1",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondUntracked = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "untracked-v2",
        updatedAt: secondObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
      createUtcIsoDateTime(OLD_ITEM_AT),
    );
    fixture.openItems = [secondTracked, secondUntracked];
    setIssueDetails(fixture, fixture.openItems, secondObservedAt);
    harness.setConfig(
      Object.freeze({
        ...config,
        ai: Object.freeze({
          ...config.ai,
          promptVersion: "mixed-windows-v2",
        }),
      }),
    );

    const result = await harness.runDry(SECOND_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([
      {
        targets: [
          {
            nodeId: secondTracked.nodeId,
            eventWindow: {
              mode: "initial",
            },
          },
          {
            nodeId: secondUntracked.nodeId,
            eventWindow: {
              mode: "initial",
            },
          },
        ],
      },
    ]);
  });

  it("503のrepositoryを前回値と最終成功時刻付きstaleとして保持して通知から除外する", async () => {
    const firstRepository = createRepository("R_fresh", "fresh", FIRST_RUN_AT);
    const secondRepository = createRepository("R_stale", "stale", FIRST_RUN_AT);
    const firstFixture = createRepositoryFixture(firstRepository);
    const secondFixture = createRepositoryFixture(secondRepository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: requirePublicRepository(firstRepository),
      number: 1,
      fingerprint: "fresh-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondItem = createIssueItem({
      repository: requirePublicRepository(secondRepository),
      number: 1,
      fingerprint: "stale-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    firstFixture.openItems = [firstItem];
    secondFixture.openItems = [secondItem];
    setIssueDetails(firstFixture, [firstItem], observedAt);
    setIssueDetails(secondFixture, [secondItem], observedAt);
    secondFixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondItem, firstItem)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [firstFixture, secondFixture],
      config,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    secondFixture.enumerationFailsWith503 = true;
    harness.artifacts.length = 0;

    const result = await harness.runDry(SECOND_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const staleRepository = snapshot.repositories.find(
      (repository) => repository.id === secondRepository.id,
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(staleRepository).toEqual({
      ...requirePublicRepository(secondRepository),
      observedAt: FIRST_RUN_AT,
      freshness: "stale",
      failedAt: SECOND_RUN_AT,
    });
    expect(snapshot.items.map((item) => item.nodeId)).toContain(secondItem.nodeId);
    expect(snapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: firstItem.nodeId,
        toNodeId: secondItem.nodeId,
        active: true,
      }),
    );
    expect(harness.artifacts.at(-1)).toMatchObject({
      metrics: {
        staleRepositoryCount: 1,
      },
      result: {
        notificationSelection: {
          candidates: [
            {
              itemNodeId: firstItem.nodeId,
              reasonCode: "blocker_overdue",
              severity: "critical",
            },
          ],
        },
      },
    });
  });

  it("stale edgeの反対側端点が保持期限を超えたらrelationを履歴付きで除外する", async () => {
    const freshRepository = createRepository(
      "R_retired_endpoint",
      "retired-endpoint",
      FIRST_RUN_AT,
    );
    const staleRepository = createRepository("R_stale_edge", "stale-edge", FIRST_RUN_AT);
    const freshFixture = createRepositoryFixture(freshRepository);
    const staleFixture = createRepositoryFixture(staleRepository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const retiredEndpoint = createIssueItem({
      repository: requirePublicRepository(freshRepository),
      number: 1,
      fingerprint: "retired-endpoint",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    const staleItem = createIssueItem({
      repository: requirePublicRepository(staleRepository),
      number: 1,
      fingerprint: "stale-edge",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    freshFixture.individualItems.set(retiredEndpoint.nodeId, retiredEndpoint);
    staleFixture.openItems = [staleItem];
    setIssueDetails(freshFixture, [retiredEndpoint], firstObservedAt);
    setIssueDetails(staleFixture, [staleItem], firstObservedAt);
    staleFixture.details.set(
      staleItem.nodeId,
      createIssueDetail({
        item: staleItem,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(staleItem, retiredEndpoint)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 1,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [freshFixture, staleFixture],
      config,
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("端点保持期限切れ前のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    const relation = firstSnapshot.relations.find(
      (candidate) =>
        candidate.fromNodeId === retiredEndpoint.nodeId &&
        candidate.toNodeId === staleItem.nodeId &&
        candidate.active,
    );
    if (relation == null) {
      throw new TypeError("端点保持期限切れ前のactive relationがありません");
    }

    staleFixture.enumerationFailsWith503 = true;
    const result = await harness.runDaily(THIRD_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    const historySource = files.get("state/history/2026-08-04.jsonl");
    if (snapshotSource == null || historySource == null) {
      throw new TypeError("端点保持期限切れ後のstateがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));
    const historyRecords = parseStateHistoryRecords(new TextDecoder().decode(historySource));

    expect(result.exitCode).toBe(0);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual([staleItem.nodeId]);
    expect(snapshot.relations).toEqual([]);
    expect(historyRecords.flatMap((record) => record.events)).toContainEqual({
      kind: "edge_removed",
      relationId: relation.id,
    });
  });

  it("open列挙にないclosed項目を明示includeから個別取得する", async () => {
    const repository = createRepository("R_explicit", "explicit", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "closed-explicit",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    fixture.individualItems.set(item.url, item);
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [item.url],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toContainEqual([item.url]);
    expect(harness.detailCalls[0]?.targets.map((target) => target.nodeId)).toEqual([item.nodeId]);
    expect(snapshot.items[0]).toMatchObject({
      nodeId: item.nodeId,
      state: "closed",
      status: "terminal_completed",
    });
  });

  it("open一覧から消えた項目をterminalへ更新し保持期間後にactive datasetから外す", async () => {
    const repository = createRepository("R_terminal", "terminal", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const openItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "open",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [openItem];
    setIssueDetails(fixture, [openItem], firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 1,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const closedItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "closed",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: secondObservedAt,
      }),
    });
    fixture.openItems = [];
    fixture.individualItems.set(closedItem.url, closedItem);
    setIssueDetails(fixture, [closedItem], secondObservedAt);
    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    const filesAfterClose = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotBytesAfterClose = filesAfterClose.get("state/snapshot.json");
    if (snapshotBytesAfterClose == null) {
      throw new TypeError("terminal遷移後のsnapshotがありません");
    }
    const snapshotAfterClose = parseStateSnapshot(
      new TextDecoder().decode(snapshotBytesAfterClose),
    );
    expect(snapshotAfterClose.items[0]).toMatchObject({
      state: "closed",
      status: "terminal_completed",
    });
    harness.individualCalls.length = 0;
    harness.artifacts.length = 0;

    expect((await harness.runDry(THIRD_RUN_AT)).exitCode).toBe(0);
    expect(harness.individualCalls).toHaveLength(0);
    expect(requireDryRunSnapshot(harness.artifacts).items).toHaveLength(0);
  });

  it("保持期間を超えて追跡から外れた項目を端点に持つrelationもsnapshotから外す", async () => {
    const repository = createRepository("R_retired_relation", "retired-relation", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const retiredEndpoint = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "retired-endpoint",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [tracked];
    fixture.individualItems.set(retiredEndpoint.nodeId, retiredEndpoint);
    setIssueDetails(fixture, [tracked, retiredEndpoint], firstObservedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetail({
        item: tracked,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(tracked, retiredEndpoint)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 1,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("relation端点退避前のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    expect(firstSnapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, retiredEndpoint.nodeId]),
    );
    expect(firstSnapshot.relations).toHaveLength(1);

    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const updatedTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v2",
      updatedAt: thirdObservedAt,
      observedAt: thirdObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [updatedTracked];
    setIssueDetails(fixture, [updatedTracked], thirdObservedAt);
    harness.artifacts.length = 0;

    const result = await harness.runDry(THIRD_RUN_AT);
    expect(result.exitCode).toBe(0);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual([updatedTracked.nodeId]);
    expect(snapshot.externalReferences).toEqual([]);
    expect(snapshot.relations).toEqual([]);
  });

  it("未更新項目をrun時刻でwatchへ進めて通知候補にする", async () => {
    const repository = createRepository("R_elapsed_severity", "elapsed-severity", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "unchanged",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
      firstObservedAt,
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("初回のseverity snapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    expect(firstSnapshot.items[0]?.severity).toBe("none");

    fixture.openItems = [
      replaceCreatedAt(
        createIssueItem({
          repository: publicRepository,
          number: 1,
          fingerprint: "unchanged",
          updatedAt: firstObservedAt,
          observedAt: createUtcIsoDateTime(THIRD_RUN_AT),
          state: Object.freeze({ state: "open" }),
        }),
        firstObservedAt,
      ),
    ];
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;

    const result = await harness.runDry(THIRD_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toHaveLength(0);
    expect(snapshot.items[0]).toMatchObject({
      nodeId: item.nodeId,
      observedAt: FIRST_RUN_AT,
      severity: "watch",
    });
    expect(harness.artifacts.at(-1)).toMatchObject({
      result: {
        notificationSelection: {
          candidates: [
            {
              itemNodeId: item.nodeId,
              reasonCode: "triage_overdue",
              severity: "watch",
            },
          ],
        },
      },
    });
  });

  it("未変更terminal項目の詳細取得とCodex再分析と停滞通知を抑止する", async () => {
    const repository = createRepository("R_suppression", "suppression", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const target = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "target",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const terminal = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "terminal",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [target];
    fixture.individualItems.set(terminal.url, terminal);
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      terminal.nodeId,
      createIssueDetail({
        item: terminal,
        body: `${target.url} を参照します`,
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [terminal.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstCodexExecutionCount = harness.codexExecutionCount();
    expect(firstCodexExecutionCount).toBeGreaterThan(0);
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const unchangedTarget = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "target",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const unchangedTerminal = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "terminal",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [unchangedTarget];
    fixture.individualItems.set(unchangedTerminal.url, unchangedTerminal);

    const result = await harness.runDry(SECOND_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toHaveLength(0);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(harness.artifacts.at(-1)).toMatchObject({
      result: {
        notificationSelection: {
          candidates: [
            {
              itemNodeId: target.nodeId,
              reasonCode: "triage_overdue",
              severity: "critical",
            },
          ],
        },
      },
    });
  });

  it("判定規則変更時に再判定したterminal項目だけを現在規則で判定済みにする", async () => {
    const repository = createRepository("R_terminal_rules", "terminal-rules", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const terminal = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "terminal-rules",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    const untracked = createOldIssueItem(publicRepository, 2, "untracked-rules", observedAt);
    fixture.openItems = [untracked];
    fixture.individualItems.set(terminal.url, terminal);
    setIssueDetails(fixture, [terminal, untracked], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [terminal.url],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("判定規則変更前のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    const firstTerminalFingerprint = requireCollectionItem(
      firstSnapshot,
      terminal.nodeId,
    ).analysisRulesFingerprint;
    if (firstTerminalFingerprint.status !== "available") {
      throw new TypeError("判定規則変更前のterminal項目にfingerprintがありません");
    }
    expect(requireCollectionItem(firstSnapshot, untracked.nodeId).analysisRulesFingerprint).toEqual(
      {
        status: "unavailable",
      },
    );
    harness.setConfig(
      Object.freeze({
        ...config,
        ai: Object.freeze({
          ...config.ai,
          promptVersion: "terminal-rules-v2",
        }),
      }),
    );
    harness.artifacts.length = 0;

    const result = await harness.runDry(SECOND_RUN_AT);
    const secondSnapshot = requireDryRunSnapshot(harness.artifacts);
    const secondTerminalFingerprint = requireCollectionItem(
      secondSnapshot,
      terminal.nodeId,
    ).analysisRulesFingerprint;
    if (secondTerminalFingerprint.status !== "available") {
      throw new TypeError("判定規則変更後のterminal項目にfingerprintがありません");
    }

    expect(result.exitCode).toBe(0);
    expect(secondTerminalFingerprint.fingerprint).not.toBe(firstTerminalFingerprint.fingerprint);
    expect(
      requireCollectionItem(secondSnapshot, untracked.nodeId).analysisRulesFingerprint,
    ).toEqual({
      status: "unavailable",
    });
  });

  it("archiveで除外したrepositoryの理由を日次履歴へ残す", async () => {
    const repository = createRepository("R_archive", "archive", FIRST_RUN_AT);
    const retainedRepository = createRepository("R_retained", "retained", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const retainedFixture = createRepositoryFixture(retainedRepository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "archive-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture, retainedFixture],
      config,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.setInventory([
      retainedRepository,
      Object.freeze({
        ...repository,
        archived: true,
        observedAt: createUtcIsoDateTime(SECOND_RUN_AT),
      }),
    ]);

    const result = await harness.runDaily(SECOND_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const historyBytes = files.get("state/history/2026-08-02.jsonl");
    const snapshotBytes = files.get("state/snapshot.json");
    if (historyBytes == null || snapshotBytes == null) {
      throw new TypeError("archive除外後のstateがありません");
    }
    const records = parseStateHistoryRecords(new TextDecoder().decode(historyBytes));
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotBytes));

    expect(result.exitCode).toBe(0);
    expect(snapshot.repositories.map((entry) => entry.id)).toEqual([retainedRepository.id]);
    expect(snapshot.items).toHaveLength(0);
    expect(records[0]?.events).toContainEqual({
      kind: "repository_excluded",
      repositoryFullName: "VOICEVOX/archive",
      reason: "archived",
    });
  });
});

describe("本番判定入力の接続", () => {
  it("reviewとcheckの集約状態をsnapshotと公開DTOへ保存する", async () => {
    const repository = createRepository("R_pr_aggregate", "pr-aggregate", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "aggregate-state",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        reviews: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_pull_request_review", "approved"),
            nodeId: createGitHubNodeId("V_approved"),
            sequence: 0,
            state: "approved",
            author: Object.freeze({
              status: "identified",
              account: Object.freeze({
                sourceId: buildSourceId("github_account", "U_reviewer"),
                nodeId: createGitHubNodeId("U_reviewer"),
                login: "reviewer",
                apiType: "User",
              }),
            }),
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "承認します",
            url: `${item.url}#pullrequestreview-1`,
          } satisfies (typeof detail.reviews)[number]),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotBytes = files.get("state/snapshot.json");
    if (snapshotBytes == null) {
      throw new TypeError("PR集約状態のsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotBytes));
    const snapshotItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);
    const publicItem = harness.publicData[0]?.details.items.find(
      (candidate) => candidate.summary.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(snapshotItem).toMatchObject({
      reviewState: "approved",
      checkState: "failing",
    });
    expect(publicItem).toMatchObject({
      reviewState: "approved",
      checkState: "failing",
    });
  });

  it("Pull Requestのreview本文をcontent付きsourceとしてCodexへ渡す", async () => {
    const repository = createRepository("R_codex_review", "codex-review", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "review-content",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    const reviewer = Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_review_content"),
        nodeId: createGitHubNodeId("U_review_content"),
        login: "review-content",
        apiType: "User",
      }),
    } satisfies (typeof detail.reviews)[number]["author"]);
    const reviewSourceId = buildSourceId("github_pull_request_review", "V_review_content");
    const emptyReviewSourceId = buildSourceId("github_pull_request_review", "V_empty_review");
    const commentSourceId = buildSourceId(
      "github_pull_request_review_comment",
      "PRRC_review_content",
    );
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        reviews: Object.freeze([
          Object.freeze({
            sourceId: reviewSourceId,
            nodeId: createGitHubNodeId("V_review_content"),
            sequence: 0,
            state: "commented",
            author: reviewer,
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "レビュー全体の確認事項です",
            url: `${item.url}#pullrequestreview-1`,
          } satisfies (typeof detail.reviews)[number]),
          Object.freeze({
            sourceId: emptyReviewSourceId,
            nodeId: createGitHubNodeId("V_empty_review"),
            sequence: 1,
            state: "dismissed",
            author: reviewer,
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "",
            url: `${item.url}#pullrequestreview-2`,
          } satisfies (typeof detail.reviews)[number]),
        ]),
        reviewThreads: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_pull_request_review_thread", "PRRT_review_content"),
            nodeId: createGitHubNodeId("PRRT_review_content"),
            sequence: 0,
            isResolved: true,
            isOutdated: false,
            path: "src/example.ts",
            resolvedBy: reviewer,
            comments: Object.freeze([
              Object.freeze({
                sourceId: commentSourceId,
                nodeId: createGitHubNodeId("PRRC_review_content"),
                sequence: 0,
                author: reviewer,
                body: "この条件は必要でしょうか",
                createdAt: observedAt,
                updatedAt: observedAt,
                url: `${item.url}#discussion_r1`,
              } satisfies (typeof detail.reviewThreads)[number]["comments"][number]),
            ]),
          } satisfies (typeof detail.reviewThreads)[number]),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) =>
        Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: commentSourceId,
            },
            latestMeaningfulSourceId: commentSourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        ),
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("review本文を確認するCodex入力がありません");
    }

    expect(result.exitCode).toBe(0);
    expect(input.sources.filter((source) => source.id === commentSourceId)).toEqual([
      {
        id: commentSourceId,
        kind: "comment",
        actorType: "human",
        createdAt: observedAt,
        content: "この条件は必要でしょうか",
      },
    ]);
    expect(input.sources.filter((source) => source.id === reviewSourceId)).toEqual([
      {
        id: reviewSourceId,
        kind: "review",
        actorType: "human",
        createdAt: observedAt,
        content: "レビュー全体の確認事項です",
      },
    ]);
    expect(input.sources.filter((source) => source.id === emptyReviewSourceId)).toEqual([
      {
        id: emptyReviewSourceId,
        kind: "review",
        actorType: "human",
        createdAt: observedAt,
        content: "",
      },
    ]);
  });

  it("mentionの明示依頼とhuman commentの意味判定を状態と進捗時刻へ反映する", async () => {
    const repository = createRepository("R_codex_issue", "codex-issue", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "mention-progress",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const meaningfulAt = createUtcIsoDateTime("2026-07-31T20:00:00.000Z");
    const commentFixture = createDuplicateComments(item, meaningfulAt)[0];
    if (commentFixture == null) {
      throw new TypeError("進捗判定用commentがありません");
    }
    const meaningfulComment = Object.freeze({
      ...commentFixture,
      body: "依頼された調査へ回答し、結論を共有しました",
    });
    const chatCommentNodeId = createGitHubNodeId(`IC_chat_${item.nodeId}`);
    const chatComment = Object.freeze({
      ...commentFixture,
      sourceId: buildSourceId("github_issue_comment", chatCommentNodeId),
      nodeId: chatCommentNodeId,
      sequence: 1,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", "U_chat_commenter"),
          nodeId: createGitHubNodeId("U_chat_commenter"),
          login: "chat-commenter",
          apiType: "User",
        }),
      }),
      body: "ありがとうございます。今日は暑いですね",
      createdAt: observedAt,
      updatedAt: observedAt,
      url: `${item.url}#issuecomment-${chatCommentNodeId}`,
    } satisfies GitHubIssueComment);
    const comments = Object.freeze([meaningfulComment, chatComment]);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "@requested-user と @VOICEVOX/reviewers に対応をお願いします",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const bodySource = input.sources.find((source) => source.kind === "body");
        if (bodySource == null) {
          throw new TypeError("Codex入力にbody sourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: "requested-user",
              kind: "user",
              role: "assignee",
              sourceId: bodySource.id,
            },
            latestMeaningfulSourceId: meaningfulComment.sourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("判定追跡情報のsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));
    const input = harness.codexInputs[0];
    const trackedItem = snapshot.items[0];
    if (trackedItem?.aiAnalysis.status !== "used") {
      throw new TypeError("判定からAI cache entryを参照できません");
    }
    const cachePath = `state/ai-cache/${trackedItem.aiAnalysis.cacheKey.slice("sha256:".length)}.json`;
    const cacheSource = files.get(cachePath);
    if (cacheSource == null) {
      throw new TypeError("判定が参照するAI cache entryがありません");
    }
    const parseJson: (source: string) => unknown = JSON.parse;
    const cacheEntry = createAiCacheEntry(parseJson(new TextDecoder().decode(cacheSource)));
    const publicItem = harness.publicData[0]?.details.items.find(
      (candidate) => candidate.summary.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(input?.candidates.waitingOn.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining(["requested-user", "VOICEVOX/reviewers"]),
    );
    const mentionedWaitingOnCandidates = z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(["user", "team"]),
        }),
      )
      .parse(input?.deterministicSignals["mentionedWaitingOnCandidates"]);
    expect(
      mentionedWaitingOnCandidates
        .map((candidate) => ({ id: candidate.id, kind: candidate.kind }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual(
      [
        { id: "requested-user", kind: "user" },
        { id: "VOICEVOX/reviewers", kind: "team" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(trackedItem).toMatchObject({
      status: "waiting_for_assignee",
      lastHumanActivityAt: FIRST_RUN_AT,
      lastProgressAt: meaningfulAt,
      author: {
        status: "identified",
        actor: {
          login: "author-1",
        },
      },
      latestEventActor: {
        status: "present",
        actor: {
          login: "chat-commenter",
        },
      },
      waitingOn: [
        expect.objectContaining({
          candidateId: "requested-user",
          kind: "user",
        }),
      ],
    });
    expect(cacheEntry.cacheKey).toBe(trackedItem.aiAnalysis.cacheKey);
    expect(cacheEntry.metadata).toEqual({
      deterministicRulesVersion: DETERMINISTIC_RULES_VERSION,
      model: config.ai.model,
      reasoningEffort: config.ai.execution.reasoningEffort,
      backendVersion: "codex-cli-0.145.0",
      promptVersion: config.ai.promptVersion,
      schemaVersion: "1",
      inputHash: cacheEntry.metadata.inputHash,
      outputHash: cacheEntry.metadata.outputHash,
      executedAt: FIRST_RUN_AT,
    });
    expect(cacheEntry.metadata.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(cacheEntry.metadata.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(trackedItem.inputEvents).toEqual(
      expect.arrayContaining([
        {
          sourceId: meaningfulComment.sourceId,
          url: meaningfulComment.url,
        },
        {
          sourceId: chatComment.sourceId,
          url: chatComment.url,
        },
      ]),
    );
    expect(publicItem).toMatchObject({
      summary: {
        author: trackedItem.author,
        assignees: trackedItem.assignees,
      },
      latestEventActor: trackedItem.latestEventActor,
      aiAnalysis: trackedItem.aiAnalysis,
      inputEvents: trackedItem.inputEvents,
    });
  });

  it("AI判定を使わない項目でも責務主体のコメントをstallSinceへ反映する", async () => {
    const repository = createRepository(
      "R_responsible_activity",
      "responsible-activity",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const commentedAt = createUtcIsoDateTime("2026-07-29T17:20:56.000Z");
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_responsible_user"),
      login: "responsible-user",
      apiType: "User",
    });
    const item = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "responsible-activity",
        updatedAt: commentedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
    });
    const commentNodeId = createGitHubNodeId("IC_responsible_activity");
    const comment = Object.freeze({
      sourceId: buildSourceId("github_issue_comment", commentNodeId),
      nodeId: commentNodeId,
      sequence: 0,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", assignee.nodeId),
          ...assignee,
        }),
      }),
      body: "責務主体が状況をコメントしました",
      createdAt: commentedAt,
      updatedAt: commentedAt,
      url: `${item.url}#issuecomment-${commentNodeId}`,
    } satisfies GitHubIssueComment);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([comment]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toEqual([]);
    expect(trackedItem).toMatchObject({
      status: "waiting_for_assignee",
      waitingOn: [
        expect.objectContaining({
          kind: "user",
          candidateId: assignee.login,
          role: "assignee",
        }),
      ],
      ownerSince: item.createdAt,
      stallSince: commentedAt,
      lastProgressAt: item.createdAt,
      lastHumanActivityAt: commentedAt,
      aiAnalysis: {
        status: "not_used",
      },
    });
  });

  it("reducerの検証済み通知提案を通知選別へ渡す", async () => {
    const repository = createRepository("R_codex_notification", "codex-notification", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const recommendedItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "notification-recommended",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const notRecommendedItem = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "notification-not-recommended",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const items = [recommendedItem, notRecommendedItem];
    fixture.openItems = items;
    for (const item of items) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "@requested-user に対応をお願いします",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
    }
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources.find((candidate) => candidate.kind === "body");
        if (source == null) {
          throw new TypeError("通知提案fixtureのbody sourceがありません");
        }
        const recommended = input.item.nodeId === recommendedItem.nodeId;
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: "requested-user",
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "related",
            notification: recommended
              ? {
                  recommended: true,
                  reasonCode: "review_overdue",
                  reasonSummary: "レビュー状況の確認が必要です",
                }
              : {
                  recommended: false,
                  reasonCode: "none",
                  reasonSummary: "通知は不要です",
                },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toHaveLength(2);
    expect(harness.artifacts.at(-1)).toMatchObject({
      result: {
        notificationSelection: {
          candidates: [
            {
              itemNodeId: recommendedItem.nodeId,
              reasonCode: "review_overdue",
            },
          ],
        },
      },
    });
  });

  it("required check失敗をCodexへ渡しコード起因だけをauthor待ちにする", async () => {
    const repository = createRepository("R_codex_pr", "codex-pr", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const codeFailure = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "code-failure",
      updatedAt: observedAt,
      observedAt,
    });
    const infrastructureFailure = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "infrastructure-failure",
      updatedAt: observedAt,
      observedAt,
    });
    fixture.openItems = [codeFailure, infrastructureFailure];
    fixture.details.set(
      codeFailure.nodeId,
      createFailedCheckPullRequestDetail(codeFailure, observedAt),
    );
    fixture.details.set(
      infrastructureFailure.nodeId,
      createFailedCheckPullRequestDetail(infrastructureFailure, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const checkSource = input.sources.find((source) => source.kind === "check_run");
        if (checkSource == null) {
          throw new TypeError("Codex入力にrequired check sourceがありません");
        }
        const codeCaused = input.item.nodeId === codeFailure.nodeId;
        return Promise.resolve(
          createCodexOutput(input, {
            status: codeCaused ? "waiting_for_author" : "unknown",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: codeCaused ? "author" : "unknown",
              sourceId: checkSource.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const codeItem = snapshot.items.find((candidate) => candidate.nodeId === codeFailure.nodeId);
    const infrastructureItem = snapshot.items.find(
      (candidate) => candidate.nodeId === infrastructureFailure.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toHaveLength(2);
    for (const input of harness.codexInputs) {
      expect(input.deterministicSignals["requiredCheckFailure"]).toMatchObject({
        status: "configured",
        combinedState: "failure",
      });
      expect(input.sources.map((source) => source.kind)).toEqual(
        expect.arrayContaining(["required_check_rollup", "check_run"]),
      );
    }
    expect(codeItem).toMatchObject({
      status: "waiting_for_author",
      waitingOn: [expect.objectContaining({ role: "author" })],
    });
    expect(infrastructureItem?.status).not.toBe("waiting_for_author");
  });

  it("同じGitHubデータなら前回stateなしの走査時刻が数ヶ月違っても全項目の停滞起点が一致する", async () => {
    const githubSignalAt = createUtcIsoDateTime("2026-07-20T12:00:00.000Z");
    const runAt = async (
      startedAt: string,
    ): Promise<
      readonly Readonly<{
        nodeId: GitHubNodeId;
        type: "issue" | "pull_request";
        status: StateSnapshot["items"][number]["status"];
        statusSince: UtcIsoDateTime;
        ownerSince: UtcIsoDateTime;
        stallSince: UtcIsoDateTime;
      }>[]
    > => {
      const observedAt = createUtcIsoDateTime(startedAt);
      const repository = createRepository(
        "R_deterministic_stall_since",
        "deterministic-stall-since",
        startedAt,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const unassignedIssue = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-unassigned",
        updatedAt: githubSignalAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const blockedIssue = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "deterministic-blocked",
        updatedAt: githubSignalAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const draftPullRequestBase = createPullRequestItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "deterministic-draft",
        updatedAt: githubSignalAt,
        observedAt,
      });
      if (draftPullRequestBase.type !== "pull_request") {
        throw new TypeError("決定論性fixtureのdraftがPull Requestではありません");
      }
      const draftPullRequest = Object.freeze({
        ...draftPullRequestBase,
        draft: true,
      });
      const failedCheckPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "deterministic-failed-check",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const conflictingPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 5,
        fingerprint: "deterministic-conflict",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const reviewWaitingPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 6,
        fingerprint: "deterministic-review-waiting",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const pendingCheckPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 7,
        fingerprint: "deterministic-pending-check",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const items = [
        unassignedIssue,
        blockedIssue,
        draftPullRequest,
        failedCheckPullRequest,
        conflictingPullRequest,
        reviewWaitingPullRequest,
        pendingCheckPullRequest,
      ];
      fixture.openItems = items;
      fixture.details.set(
        unassignedIssue.nodeId,
        createIssueDetail({
          item: unassignedIssue,
          body: "未アサインのIssueです",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
      fixture.details.set(
        blockedIssue.nodeId,
        createIssueDetail({
          item: blockedIssue,
          body: "draft Pull Requestの完了を待ちます",
          observedAt,
          nativeDependencies: Object.freeze([createNativeBlocker(blockedIssue, draftPullRequest)]),
          duplicateComments: false,
        }),
      );
      const createDetailWithoutChecks = (
        item: EnumeratedGitHubItem,
        mergeability: Extract<
          GitHubItemDetail,
          Readonly<{ type: "pull_request" }>
        >["mergeState"]["mergeability"],
        mergeState: Extract<
          GitHubItemDetail,
          Readonly<{ type: "pull_request" }>
        >["mergeState"]["mergeState"],
      ): Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>> => {
        const detail = createFailedCheckPullRequestDetail(item, githubSignalAt);
        return Object.freeze({
          ...detail,
          mergeState: Object.freeze({
            ...detail.mergeState,
            mergeability,
            mergeState,
            checks: Object.freeze({
              status: "not_configured",
            }),
          }),
          observedAt,
        });
      };
      fixture.details.set(
        draftPullRequest.nodeId,
        createDetailWithoutChecks(draftPullRequest, "unknown", "draft"),
      );
      fixture.details.set(
        failedCheckPullRequest.nodeId,
        Object.freeze({
          ...createFailedCheckPullRequestDetail(failedCheckPullRequest, githubSignalAt),
          observedAt,
        }),
      );
      fixture.details.set(
        conflictingPullRequest.nodeId,
        createDetailWithoutChecks(conflictingPullRequest, "conflicting", "dirty"),
      );
      const reviewRequestSourceId = buildSourceId(
        "github_review_request",
        reviewWaitingPullRequest.nodeId,
      );
      const reviewRequestNodeId = createGitHubNodeId(`RR_${reviewWaitingPullRequest.nodeId}`);
      const reviewerNodeId = createGitHubNodeId("U_deterministic_reviewer");
      const reviewWaitingDetail = createDetailWithoutChecks(
        reviewWaitingPullRequest,
        "mergeable",
        "blocked",
      );
      fixture.details.set(
        reviewWaitingPullRequest.nodeId,
        Object.freeze({
          ...reviewWaitingDetail,
          reviewRequests: Object.freeze({
            current: Object.freeze([
              Object.freeze({
                sourceId: reviewRequestSourceId,
                nodeId: reviewRequestNodeId,
                target: Object.freeze({
                  type: "user",
                  sourceId: buildSourceId("github_user", reviewerNodeId),
                  nodeId: reviewerNodeId,
                  login: "deterministic-reviewer",
                  apiType: "User",
                }),
                requestedAt: Object.freeze({
                  status: "unavailable",
                  reason: "timeline_event_not_found",
                }),
              }),
            ]),
            history: Object.freeze([]),
          }),
        }),
      );
      const pendingCheckDetail = createFailedCheckPullRequestDetail(
        pendingCheckPullRequest,
        githubSignalAt,
      );
      if (pendingCheckDetail.mergeState.checks.status !== "configured") {
        throw new TypeError("決定論性fixtureのrequired checksがありません");
      }
      fixture.details.set(
        pendingCheckPullRequest.nodeId,
        Object.freeze({
          ...pendingCheckDetail,
          mergeState: Object.freeze({
            ...pendingCheckDetail.mergeState,
            mergeState: "unstable",
            checks: Object.freeze({
              ...pendingCheckDetail.mergeState.checks,
              combinedState: "pending",
              contexts: Object.freeze(
                pendingCheckDetail.mergeState.checks.contexts.map((context) => {
                  if (context.type !== "check_run") {
                    throw new TypeError("決定論性fixtureのcheck runを取得できません");
                  }
                  return Object.freeze({
                    ...context,
                    status: "in_progress",
                    conclusion: "not_completed",
                    completedAt: null,
                  });
                }),
              ),
            }),
          }),
          observedAt,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        executeCodexAnalysis: (input) => {
          const failedCheck = input.item.nodeId === failedCheckPullRequest.nodeId;
          const basisSource = input.sources.find((source) =>
            failedCheck ? source.kind === "check_run" : source.kind === "body",
          );
          if (basisSource == null) {
            throw new TypeError("決定論性fixtureのCodex根拠sourceがありません");
          }
          return Promise.resolve(
            createCodexOutput(input, {
              status: "waiting_for_author",
              waitingOn: {
                candidateId: input.item.authorCandidateId,
                kind: "user",
                role: "author",
                sourceId: basisSource.id,
              },
              latestMeaningfulSourceId: null,
              confidence: failedCheck ? 0.95 : 0.1,
              relationVerdict: "related",
              notification: {
                recommended: false,
                reasonCode: "none",
                reasonSummary: "通知しません",
              },
            }),
          );
        },
      });

      const result = await harness.runDaily(startedAt);
      const files = await harness.stateAdapter.readBranchFiles("tracker-state");
      const snapshotSource = files.get("state/snapshot.json");
      if (snapshotSource == null) {
        throw new TypeError("決定論性検証のsnapshotがありません");
      }
      const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

      expect(result.exitCode).toBe(0);
      expect(harness.codexInputs.map((input) => input.item.nodeId)).toEqual([
        unassignedIssue.nodeId,
        failedCheckPullRequest.nodeId,
      ]);
      expect(snapshot.items).toHaveLength(items.length);
      expect(snapshot.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: unassignedIssue.nodeId, status: "new_untriaged" }),
          expect.objectContaining({ nodeId: blockedIssue.nodeId, status: "blocked" }),
          expect.objectContaining({ nodeId: draftPullRequest.nodeId, status: "in_progress" }),
          expect.objectContaining({
            nodeId: failedCheckPullRequest.nodeId,
            status: "waiting_for_author",
          }),
          expect.objectContaining({
            nodeId: conflictingPullRequest.nodeId,
            status: "waiting_for_author",
          }),
          expect.objectContaining({
            nodeId: reviewWaitingPullRequest.nodeId,
            status: "waiting_for_review",
          }),
          expect.objectContaining({
            nodeId: pendingCheckPullRequest.nodeId,
            status: "waiting_for_automation",
          }),
        ]),
      );
      return Object.freeze(
        snapshot.items
          .map((item) =>
            Object.freeze({
              nodeId: item.nodeId,
              type: item.type,
              status: item.status,
              statusSince: item.statusSince,
              ownerSince: item.ownerSince,
              stallSince: item.stallSince,
            }),
          )
          .toSorted((left, right) => left.nodeId.localeCompare(right.nodeId)),
      );
    };

    const first = await runAt(FIRST_RUN_AT);
    const second = await runAt("2027-02-01T00:00:00.000Z");

    expect(
      second,
      "同じGitHubデータを前回stateなしで走査したのに、run開始時刻の違いでstatusSince、ownerSince、stallSinceが変わりました。観測時刻が停滞起点へ混入しています。",
    ).toEqual(first);
  });

  it("check source時刻とCodex由来basisをrun開始時刻に依存させない", async () => {
    const headPushedAt = createUtcIsoDateTime("2026-07-30T12:00:00.000Z");
    const checkCompletedAt = createUtcIsoDateTime("2026-07-31T18:00:00.000Z");
    const runAt = async (
      startedAt: string,
    ): Promise<
      Readonly<{
        input: CodexAnalysisInput;
        item: StateSnapshot["items"][number];
      }>
    > => {
      const repository = createRepository(
        "R_deterministic_codex",
        "deterministic-codex",
        startedAt,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const item = createPullRequestItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-codex",
        updatedAt: checkCompletedAt,
        observedAt: checkCompletedAt,
      });
      const detail = createFailedCheckPullRequestDetail(item, headPushedAt);
      if (detail.mergeState.checks.status !== "configured") {
        throw new TypeError("決定論的Codex fixtureのcheckがありません");
      }
      const completedContexts = detail.mergeState.checks.contexts.map((context) => {
        if (context.type !== "check_run" || context.status !== "completed") {
          throw new TypeError("決定論的Codex fixtureに完了済みcheck run以外があります");
        }
        return Object.freeze({
          ...context,
          completedAt: checkCompletedAt,
        });
      });
      const pendingContext = Object.freeze({
        type: "check_run",
        sourceId: buildSourceId("github_check_run", `${item.nodeId}:pending`),
        nodeId: createGitHubNodeId(`CHECK_${item.nodeId}_pending`),
        name: "pending-test",
        status: "in_progress",
        conclusion: "not_completed",
        completedAt: null,
      });
      fixture.openItems = [item];
      fixture.details.set(
        item.nodeId,
        Object.freeze({
          ...detail,
          mergeState: Object.freeze({
            ...detail.mergeState,
            checks: Object.freeze({
              ...detail.mergeState.checks,
              contexts: Object.freeze([...completedContexts, pendingContext]),
            }),
          }),
          observedAt: checkCompletedAt,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        executeCodexAnalysis: (input) => {
          const checkSource = input.sources.find((source) => source.kind === "check_run");
          if (checkSource == null) {
            throw new TypeError("決定論的Codex fixtureのcheck sourceがありません");
          }
          return Promise.resolve(
            createCodexOutput(input, {
              status: "waiting_for_author",
              waitingOn: {
                candidateId: input.item.authorCandidateId,
                kind: "user",
                role: "author",
                sourceId: checkSource.id,
              },
              latestMeaningfulSourceId: null,
              confidence: 0.95,
              relationVerdict: "related",
              notification: {
                recommended: false,
                reasonCode: "none",
                reasonSummary: "通知しません",
              },
            }),
          );
        },
      });

      const result = await harness.runDry(startedAt);
      const input = harness.codexInputs[0];
      const trackedItem = requireDryRunSnapshot(harness.artifacts).items.find(
        (candidate) => candidate.nodeId === item.nodeId,
      );
      if (input == null || trackedItem == null) {
        throw new TypeError("決定論的Codex fixtureの結果がありません");
      }
      expect(result.exitCode).toBe(0);
      return Object.freeze({ input, item: trackedItem });
    };

    const first = await runAt(SECOND_RUN_AT);
    const second = await runAt(THIRD_RUN_AT);
    const sourceTimes = (input: CodexAnalysisInput): Readonly<Record<string, string>> =>
      Object.freeze(
        Object.fromEntries(
          input.sources
            .filter(
              (source) => source.kind === "required_check_rollup" || source.kind === "check_run",
            )
            .map((source) => {
              if (source.kind !== "check_run") {
                return [source.kind, source.createdAt];
              }
              const status = source["status"];
              if (typeof status !== "string") {
                throw new TypeError("check run sourceのstatusが文字列ではありません");
              }
              return [`check_run_${status}`, source.createdAt];
            }),
        ),
      );
    const transitionTimes = (item: StateSnapshot["items"][number]) =>
      Object.freeze({
        statusSince: item.statusSince,
        ownerSince: item.ownerSince,
        stallSince: item.stallSince,
      });
    const pendingCheckTime = (input: CodexAnalysisInput): string | undefined =>
      input.sources.find(
        (source) => source.kind === "check_run" && source["status"] === "in_progress",
      )?.createdAt;

    expect(first.input.now).toBe(SECOND_RUN_AT);
    expect(second.input.now).toBe(THIRD_RUN_AT);
    expect(sourceTimes(first.input)).toEqual({
      required_check_rollup: checkCompletedAt,
      check_run_completed: checkCompletedAt,
      check_run_in_progress: headPushedAt,
    });
    expect(sourceTimes(second.input)).toEqual(sourceTimes(first.input));
    expect(pendingCheckTime(first.input)).toBe(headPushedAt);
    expect(pendingCheckTime(second.input)).toBe(headPushedAt);
    expect(transitionTimes(first.item)).toEqual({
      statusSince: checkCompletedAt,
      ownerSince: checkCompletedAt,
      stallSince: checkCompletedAt,
    });
    expect(transitionTimes(second.item)).toEqual(transitionTimes(first.item));
  });

  it("primary blockerと全blockerと外部ghostをstateと公開DTOへ運ぶ", async () => {
    const repository = createRepository("R_blockers", "blockers", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const items = [1, 2, 3].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `blocker-${number.toString()}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    const blocked = items[0];
    const firstBlocker = items[1];
    const secondBlocker = items[2];
    if (blocked == null || firstBlocker == null || secondBlocker == null) {
      throw new TypeError("複数blocker fixtureがありません");
    }
    fixture.openItems = [...items];
    setIssueDetails(fixture, items, observedAt);
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: "複数の依存項目があります",
        observedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(blocked, firstBlocker),
          createNativeBlocker(blocked, secondBlocker),
          createExternalNativeBlocker(blocked, {
            state: "open",
            repositoryArchived: false,
            repositoryDisabled: false,
          }),
        ]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    const files = await harness.stateAdapter.readBranchFiles("tracker-state");
    const snapshotSource = files.get("state/snapshot.json");
    if (snapshotSource == null) {
      throw new TypeError("複数blockerのsnapshotがありません");
    }
    const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const publicItem = harness.publicData[0]?.summary.items.find(
      (item) => item.nodeId === blocked.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedItem?.waitingOn).toHaveLength(3);
    expect(trackedItem?.primaryWaitingOn.index).toBe(0);
    expect(trackedItem?.primaryWaitingOn.selectionReason).not.toBe("");
    expect(snapshot.externalReferences).toEqual([
      expect.objectContaining({
        kind: "external_reference",
        repositoryFullName: "external-owner/external-repository",
        directNotification: "not_eligible",
      }),
    ]);
    expect(publicItem?.primaryWaitingOn).toEqual(trackedItem?.primaryWaitingOn);
    expect(new Set(publicItem?.blockerNodeIds)).toEqual(
      new Set([firstBlocker.nodeId, secondBlocker.nodeId, "external:github:I_external_blocker"]),
    );
    expect(harness.publicData[0]?.details.graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "external_reference",
        displayReference: "external-owner/external-repository#42",
      }),
    );
  });

  it.each([
    {
      description: "archive済み",
      fixtureName: "archived",
      repositoryArchived: true,
      repositoryDisabled: false,
    },
    {
      description: "disabled",
      fixtureName: "disabled",
      repositoryArchived: false,
      repositoryDisabled: true,
    },
  ])(
    "Organization外の$description repositoryをstateと公開DTOへ残さない",
    async ({ fixtureName, repositoryArchived, repositoryDisabled }) => {
      const repository = createRepository(
        `R_excluded_external_${fixtureName}`,
        `excluded-external-${fixtureName}`,
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const blocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: `excluded-external-${fixtureName}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [blocked];
      fixture.details.set(
        blocked.nodeId,
        createIssueDetail({
          item: blocked,
          body: "除外対象の外部依存があります",
          observedAt,
          nativeDependencies: Object.freeze([
            createExternalNativeBlocker(blocked, {
              state: "open",
              repositoryArchived,
              repositoryDisabled,
            }),
          ]),
          duplicateComments: false,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });

      const result = await harness.runDaily(FIRST_RUN_AT);
      const files = await harness.stateAdapter.readBranchFiles("tracker-state");
      const snapshotSource = files.get("state/snapshot.json");
      if (snapshotSource == null) {
        throw new TypeError("外部repository除外後のsnapshotがありません");
      }
      const snapshot = parseStateSnapshot(new TextDecoder().decode(snapshotSource));

      expect(result.exitCode).toBe(0);
      expect(snapshot.externalReferences).toEqual([]);
      expect(snapshot.relations).toEqual([]);
      expect(harness.publicData[0]?.details.graph.nodes).not.toContainEqual(
        expect.objectContaining({
          nodeId: "external:github:I_external_blocker",
        }),
      );
      expect(harness.publicData[0]?.details.graph.edges).toEqual([]);
    },
  );

  it("prompt versionだけを変えた未変更項目を再解析して保存済みの停滞起点を引き継ぐ", async () => {
    const repository = createRepository("R_identity_change", "identity-change", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "identity-change",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const related = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "identity-change-related",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item, related];
    setIssueDetails(fixture, [item, related], observedAt);
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: `入力は変更しません。関連項目は ${related.url} です`,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("実行identity変更fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("実行identity変更前のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    const firstCollectionItem = requireCollectionItem(firstSnapshot, item.nodeId);
    const firstFingerprint = firstCollectionItem.aiAnalysisFingerprint;
    const firstAnalysisRulesFingerprint = firstCollectionItem.analysisRulesFingerprint;
    const firstDeterministicRulesVersion = firstCollectionItem.deterministicRulesVersion;
    if (firstFingerprint.status !== "available") {
      throw new TypeError("実行identity変更前のAI分析fingerprintがありません");
    }
    if (firstAnalysisRulesFingerprint.status !== "available") {
      throw new TypeError("実行identity変更前の判定規則fingerprintがありません");
    }
    if (firstDeterministicRulesVersion.status !== "available") {
      throw new TypeError("実行identity変更前の決定規則versionがありません");
    }
    const savedAt = createUtcIsoDateTime("2026-07-20T00:00:00.000Z");
    const snapshotWithSavedTimes = createStateSnapshot({
      ...firstSnapshot,
      items: firstSnapshot.items.map((candidate) =>
        candidate.nodeId === item.nodeId
          ? {
              ...candidate,
              statusSince: savedAt,
              ownerSince: savedAt,
              stallSince: savedAt,
              lastProgressAt: savedAt,
              lastHumanActivityAt: savedAt,
            }
          : candidate,
      ),
    });
    await replaceStateSnapshot(harness.stateAdapter, snapshotWithSavedTimes, observedAt);
    const firstExecutionCount = harness.codexExecutionCount();
    const firstItemExecutionCount = harness.codexInputs.filter(
      (input) => input.item.nodeId === item.nodeId,
    ).length;
    harness.setConfig(
      Object.freeze({
        ...config,
        ai: Object.freeze({
          ...config.ai,
          promptVersion: "identity-change-v2",
        }),
      }),
    );
    harness.artifacts.length = 0;

    const result = await harness.runDry(SECOND_RUN_AT);
    const secondSnapshot = requireDryRunSnapshot(harness.artifacts);
    const secondCollectionItem = requireCollectionItem(secondSnapshot, item.nodeId);
    const secondFingerprint = secondCollectionItem.aiAnalysisFingerprint;
    const secondAnalysisRulesFingerprint = secondCollectionItem.analysisRulesFingerprint;
    const secondDeterministicRulesVersion = secondCollectionItem.deterministicRulesVersion;
    if (secondFingerprint.status !== "available") {
      throw new TypeError("実行identity変更後のAI分析fingerprintがありません");
    }
    if (secondAnalysisRulesFingerprint.status !== "available") {
      throw new TypeError("実行identity変更後の判定規則fingerprintがありません");
    }
    if (secondDeterministicRulesVersion.status !== "available") {
      throw new TypeError("実行identity変更後の決定規則versionがありません");
    }
    const secondItem = secondSnapshot.items.find((candidate) => candidate.nodeId === item.nodeId);
    if (secondItem == null) {
      throw new TypeError("実行identity変更後の追跡項目がありません");
    }
    const metrics = z
      .object({
        metrics: z.object({
          aiCallCount: z.number(),
          aiCacheHitCount: z.number(),
        }),
      })
      .parse(harness.artifacts.at(-1)).metrics;

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(firstExecutionCount + metrics.aiCallCount);
    expect(metrics.aiCallCount).toBeGreaterThan(0);
    expect(metrics.aiCacheHitCount).toBe(0);
    expect(harness.codexInputs.filter((input) => input.item.nodeId === item.nodeId)).toHaveLength(
      firstItemExecutionCount + 1,
    );
    expect(secondFingerprint.fingerprint.inputHash).toBe(firstFingerprint.fingerprint.inputHash);
    expect(secondFingerprint.fingerprint.graphNeighborhoodHash).toBe(
      firstFingerprint.fingerprint.graphNeighborhoodHash,
    );
    expect(secondFingerprint.fingerprint.identityHash).not.toBe(
      firstFingerprint.fingerprint.identityHash,
    );
    expect(firstAnalysisRulesFingerprint.fingerprint).toBe(
      hashCanonicalJson({
        deterministicRulesVersion: ISSUE_DETERMINISTIC_RULES_VERSION,
        identityHash: firstFingerprint.fingerprint.identityHash,
      }),
    );
    expect(secondAnalysisRulesFingerprint.fingerprint).toBe(
      hashCanonicalJson({
        deterministicRulesVersion: ISSUE_DETERMINISTIC_RULES_VERSION,
        identityHash: secondFingerprint.fingerprint.identityHash,
      }),
    );
    expect(secondAnalysisRulesFingerprint.fingerprint).not.toBe(
      firstAnalysisRulesFingerprint.fingerprint,
    );
    expect(firstDeterministicRulesVersion.version).toBe(ISSUE_DETERMINISTIC_RULES_VERSION);
    expect(secondDeterministicRulesVersion).toEqual(firstDeterministicRulesVersion);
    expect({
      statusSince: secondItem.statusSince,
      ownerSince: secondItem.ownerSince,
      stallSince: secondItem.stallSince,
      lastProgressAt: secondItem.lastProgressAt,
      lastHumanActivityAt: secondItem.lastHumanActivityAt,
    }).toEqual({
      statusSince: savedAt,
      ownerSince: savedAt,
      stallSince: savedAt,
      lastProgressAt: savedAt,
      lastHumanActivityAt: savedAt,
    });
  });

  it.each([
    Object.freeze({
      description: "前回の決定規則versionが異なる場合",
      previousRulesVersion: Object.freeze({
        status: "available",
        version: "issue-old-version",
      }),
      previousAnalysisRulesFingerprint: Object.freeze({
        status: "available",
        fingerprint: hashCanonicalJson({ rules: "old" }),
      }),
    }),
    Object.freeze({
      description: "前回の決定規則versionが未取得の場合",
      previousRulesVersion: Object.freeze({
        status: "unavailable",
      }),
      previousAnalysisRulesFingerprint: Object.freeze({
        status: "unavailable",
      }),
    }),
  ])(
    "$descriptionは保存済みの停滞起点を引き継がない",
    async ({ previousRulesVersion, previousAnalysisRulesFingerprint }) => {
      const repository = createRepository("R_rules_change", "rules-change", FIRST_RUN_AT);
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const item = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "rules-change",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [item];
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "決定規則変更時の停滞起点を検証します",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });

      expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
      const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
      const firstSnapshotSource = firstFiles.get("state/snapshot.json");
      if (firstSnapshotSource == null) {
        throw new TypeError("決定規則変更前のsnapshotがありません");
      }
      const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
      const savedAt = createUtcIsoDateTime("2026-07-20T00:00:00.000Z");
      const snapshotWithOldRules = createStateSnapshot({
        ...firstSnapshot,
        collection: {
          repositories: firstSnapshot.collection.repositories.map((collectionRepository) => ({
            ...collectionRepository,
            items: collectionRepository.items.map((collectionItem) =>
              collectionItem.nodeId === item.nodeId
                ? {
                    ...collectionItem,
                    analysisRulesFingerprint: previousAnalysisRulesFingerprint,
                    deterministicRulesVersion: previousRulesVersion,
                  }
                : collectionItem,
            ),
          })),
        },
        items: firstSnapshot.items.map((candidate) =>
          candidate.nodeId === item.nodeId
            ? {
                ...candidate,
                statusSince: savedAt,
                ownerSince: savedAt,
                stallSince: savedAt,
                lastProgressAt: savedAt,
                lastHumanActivityAt: savedAt,
              }
            : candidate,
        ),
      });
      await replaceStateSnapshot(harness.stateAdapter, snapshotWithOldRules, observedAt);
      harness.artifacts.length = 0;
      harness.detailCalls.length = 0;

      const result = await harness.runDry(SECOND_RUN_AT);
      const secondSnapshot = requireDryRunSnapshot(harness.artifacts);
      const secondItem = secondSnapshot.items.find((candidate) => candidate.nodeId === item.nodeId);
      if (secondItem == null) {
        throw new TypeError("決定規則変更後の追跡項目がありません");
      }
      const secondRulesVersion = requireCollectionItem(
        secondSnapshot,
        item.nodeId,
      ).deterministicRulesVersion;

      expect(result.exitCode).toBe(0);
      expect(harness.detailCalls).toEqual([
        {
          targets: [
            {
              nodeId: item.nodeId,
              eventWindow: {
                mode: "initial",
              },
            },
          ],
        },
      ]);
      expect({
        statusSince: secondItem.statusSince,
        ownerSince: secondItem.ownerSince,
        stallSince: secondItem.stallSince,
        lastProgressAt: secondItem.lastProgressAt,
        lastHumanActivityAt: secondItem.lastHumanActivityAt,
      }).toEqual({
        statusSince: item.createdAt,
        ownerSince: item.createdAt,
        stallSince: item.createdAt,
        lastProgressAt: item.createdAt,
        lastHumanActivityAt: item.createdAt,
      });
      expect(secondRulesVersion).toEqual({
        status: "available",
        version: ISSUE_DETERMINISTIC_RULES_VERSION,
      });
    },
  );

  it("複数blockerのcloseとmergeとedge消失による依存解消時刻をrun開始時刻に依存させない", async () => {
    const issueClosedAt = createUtcIsoDateTime("2026-08-02T08:00:00.000Z");
    const pullRequestMergedAt = createUtcIsoDateTime("2026-08-02T16:00:00.000Z");
    const resolutionObservedAt = createUtcIsoDateTime("2026-08-03T00:00:00.000Z");
    const runResolutionAt = async (
      startedAt: string,
    ): Promise<
      Readonly<{
        lastProgressAt: UtcIsoDateTime;
        stallSince: UtcIsoDateTime;
      }>
    > => {
      const repository = createRepository(
        "R_deterministic_dependency",
        "deterministic-dependency",
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const blocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-blocked",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      const issueBlocker = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "deterministic-issue-blocker-open",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      const pullRequestBlocker = createPullRequestItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "deterministic-pr-blocker-open",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
      });
      const edgeBlocker = createIssueItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "deterministic-edge-blocker",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [blocked, issueBlocker, pullRequestBlocker, edgeBlocker];
      setIssueDetails(fixture, [blocked, issueBlocker, edgeBlocker], firstObservedAt);
      fixture.details.set(
        pullRequestBlocker.nodeId,
        createFailedCheckPullRequestDetail(pullRequestBlocker, firstObservedAt),
      );
      fixture.details.set(
        blocked.nodeId,
        createIssueDetail({
          item: blocked,
          body: "IssueとPull Requestの完了を待ちます",
          observedAt: firstObservedAt,
          nativeDependencies: Object.freeze([
            createNativeBlocker(blocked, issueBlocker),
            createNativeBlocker(blocked, pullRequestBlocker),
            createNativeBlocker(blocked, edgeBlocker),
          ]),
          duplicateComments: false,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });
      expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

      const currentBlocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-blocked",
        updatedAt: firstObservedAt,
        observedAt: resolutionObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      const closedIssueBlocker = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "deterministic-issue-blocker-closed",
        updatedAt: issueClosedAt,
        observedAt: resolutionObservedAt,
        state: Object.freeze({
          state: "closed",
          closedAt: issueClosedAt,
        }),
      });
      const mergedPullRequestBlocker = createMergedPullRequestItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "deterministic-pr-blocker-merged",
        mergedAt: pullRequestMergedAt,
        observedAt: resolutionObservedAt,
      });
      const currentEdgeBlocker = createIssueItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "deterministic-edge-blocker",
        updatedAt: firstObservedAt,
        observedAt: resolutionObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [currentBlocked, currentEdgeBlocker];
      fixture.individualItems.set(closedIssueBlocker.nodeId, closedIssueBlocker);
      fixture.individualItems.set(mergedPullRequestBlocker.nodeId, mergedPullRequestBlocker);
      setIssueDetails(
        fixture,
        [currentBlocked, closedIssueBlocker, currentEdgeBlocker],
        resolutionObservedAt,
      );
      fixture.details.set(
        mergedPullRequestBlocker.nodeId,
        createFailedCheckPullRequestDetail(mergedPullRequestBlocker, resolutionObservedAt),
      );
      fixture.details.set(
        currentBlocked.nodeId,
        createIssueDetail({
          item: currentBlocked,
          body: "IssueとPull Requestの完了を待ちます",
          observedAt: resolutionObservedAt,
          nativeDependencies: Object.freeze([
            createNativeBlocker(currentBlocked, closedIssueBlocker),
            createNativeBlocker(currentBlocked, mergedPullRequestBlocker),
          ]),
          duplicateComments: false,
        }),
      );
      harness.artifacts.length = 0;

      const result = await harness.runDry(startedAt);
      const resolvedItem = requireDryRunSnapshot(harness.artifacts).items.find(
        (item) => item.nodeId === blocked.nodeId,
      );
      if (resolvedItem == null) {
        throw new TypeError("決定論的依存解消fixtureの追跡項目がありません");
      }
      expect(result.exitCode).toBe(0);
      return Object.freeze({
        lastProgressAt: resolvedItem.lastProgressAt,
        stallSince: resolvedItem.stallSince,
      });
    };

    const first = await runResolutionAt(THIRD_RUN_AT);
    const second = await runResolutionAt(FOURTH_RUN_AT);

    expect(first).toEqual({
      lastProgressAt: pullRequestMergedAt,
      stallSince: pullRequestMergedAt,
    });
    expect(second).toEqual(first);
  });

  it("inferred edge解消時に本文未変更の隣接項目を再分類する", async () => {
    const repository = createRepository("R_reclassify", "reclassify", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "blocked-unchanged",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "blocker-open",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [blocked, blocker];
    setIssueDetails(fixture, [blocked, blocker], observedAt);
    const unchangedBody = `本文は変更しません。依存候補は ${blocker.url} です`;
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: unchangedBody,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    let relationExists = true;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("隣接再分類fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict:
              input.item.nodeId === blocked.nodeId && relationExists
                ? "current_is_blocked_by_target"
                : "none",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const firstSnapshotSource = firstFiles.get("state/snapshot.json");
    if (firstSnapshotSource == null) {
      throw new TypeError("inferred edge作成後のsnapshotがありません");
    }
    const firstSnapshot = parseStateSnapshot(new TextDecoder().decode(firstSnapshotSource));
    const firstAiFingerprint = requireCollectionItem(
      firstSnapshot,
      blocked.nodeId,
    ).aiAnalysisFingerprint;
    if (firstAiFingerprint.status !== "available") {
      throw new TypeError("初回Codex分析fingerprintが保存されていません");
    }
    expect(firstSnapshot.items.find((item) => item.nodeId === blocked.nodeId)?.status).toBe(
      "blocked",
    );
    expect(firstSnapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: blocker.nodeId,
        toNodeId: blocked.nodeId,
        provenance: "explicit_text",
        active: true,
      }),
    );

    const firstCodexExecutionCount = harness.codexExecutionCount();
    harness.artifacts.length = 0;
    const unchangedResult = await harness.runDry(SECOND_RUN_AT);
    const unchangedSnapshot = requireDryRunSnapshot(harness.artifacts);
    const secondAiFingerprint = requireCollectionItem(
      unchangedSnapshot,
      blocked.nodeId,
    ).aiAnalysisFingerprint;
    const unchangedMetrics = z
      .object({
        metrics: z.object({
          aiCallCount: z.number(),
          aiCacheHitCount: z.number(),
        }),
      })
      .parse(harness.artifacts.at(-1)).metrics;

    expect(unchangedResult.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(unchangedMetrics.aiCallCount).toBe(0);
    expect(unchangedMetrics.aiCacheHitCount).toBeGreaterThan(0);
    expect(unchangedSnapshot.items.find((item) => item.nodeId === blocked.nodeId)?.status).toBe(
      "blocked",
    );
    expect(unchangedSnapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: blocker.nodeId,
        toNodeId: blocked.nodeId,
        active: true,
      }),
    );
    const blockedInputsBeforeChange = harness.codexInputs.filter(
      (input) => input.item.nodeId === blocked.nodeId,
    );
    expect(blockedInputsBeforeChange).toHaveLength(1);
    expect(secondAiFingerprint).toEqual(firstAiFingerprint);

    relationExists = false;
    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const changedBlocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "blocked-changed",
      updatedAt: thirdObservedAt,
      observedAt: thirdObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [changedBlocked, blocker];
    fixture.details.set(
      changedBlocked.nodeId,
      createIssueDetail({
        item: changedBlocked,
        body: unchangedBody,
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: true,
      }),
    );

    expect((await harness.runDaily(THIRD_RUN_AT)).exitCode).toBe(0);
    const thirdFiles = await harness.stateAdapter.readBranchFiles("tracker-state");
    const thirdSnapshotSource = thirdFiles.get("state/snapshot.json");
    if (thirdSnapshotSource == null) {
      throw new TypeError("入力変更後のsnapshotがありません");
    }
    const thirdSnapshot = parseStateSnapshot(new TextDecoder().decode(thirdSnapshotSource));
    const thirdAiFingerprint = requireCollectionItem(
      thirdSnapshot,
      blocked.nodeId,
    ).aiAnalysisFingerprint;
    if (thirdAiFingerprint.status !== "available") {
      throw new TypeError("入力変更後のCodex分析fingerprintが保存されていません");
    }
    const reclassified = thirdSnapshot.items.find((item) => item.nodeId === blocked.nodeId);

    const blockedInputs = harness.codexInputs.filter(
      (input) => input.item.nodeId === blocked.nodeId,
    );
    expect(reclassified?.status).not.toBe("blocked");
    expect(reclassified?.lastProgressAt).toBe(blocked.createdAt);
    expect(thirdSnapshot.relations).toContainEqual(
      expect.objectContaining({
        fromNodeId: blocker.nodeId,
        toNodeId: blocked.nodeId,
        active: false,
      }),
    );
    expect(blockedInputs).toHaveLength(2);
    expect(thirdAiFingerprint.fingerprint.inputHash).not.toBe(
      firstAiFingerprint.fingerprint.inputHash,
    );
    expect(
      blockedInputs.map(
        (input) => input.sources.find((source) => source.kind === "body")?.["content"],
      ),
    ).toEqual([unchangedBody, unchangedBody]);
  });

  it("実入力の費用見積で上限を適用する", async () => {
    const repository = createRepository("R_cost", "cost", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "cost-limit",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "費用見積を行う項目です",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: true,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 10, 0);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: () => Promise.reject(new TypeError("費用上限を超えて実行されました")),
    });

    const result = await harness.runDry(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(0);
    expect(harness.artifacts.at(-1)).toMatchObject({
      diagnostics: [expect.stringContaining("estimated_cost_limit")],
      metrics: {
        aiCallCount: 0,
      },
    });
  });

  it("blocker変化をdownstream impactより優先し、同条件ではimpact順に予算配分する", async () => {
    const repository = createRepository("R_priority", "priority", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const items = [1, 2, 3, 4, 5].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `priority-${number.toString()}`,
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    const highImpact = items[0];
    const changedBlockerTarget = items[1];
    const downstream = items[2];
    const downstreamLeaf = items[3];
    const newBlocker = items[4];
    if (
      highImpact == null ||
      changedBlockerTarget == null ||
      downstream == null ||
      downstreamLeaf == null ||
      newBlocker == null
    ) {
      throw new TypeError("AI優先順位fixtureがありません");
    }
    fixture.openItems = [...items];
    setIssueDetails(fixture, items, firstObservedAt);
    for (const item of [highImpact, changedBlockerTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします",
          observedAt: firstObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: true,
        }),
      );
    }
    fixture.details.set(
      downstream.nodeId,
      createIssueDetail({
        item: downstream,
        body: "downstream項目です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(downstream, highImpact)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      downstreamLeaf.nodeId,
      createIssueDetail({
        item: downstreamLeaf,
        body: "downstream末端です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(downstreamLeaf, downstream)]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const executedNodeIds: string[] = [];
    const harness = createCollectionHarness({
      repositories: [fixture],
      config: configWithBudget(baseConfig, 10, 10),
      executeCodexAnalysis: (input) => {
        executedNodeIds.push(input.item.nodeId);
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("AI優先順位fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: input.item.authorCandidateId,
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

    executedNodeIds.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItems = items.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint:
          item.number <= 2
            ? `priority-${item.number.toString()}-second`
            : `priority-${item.number.toString()}`,
        updatedAt: item.number <= 2 ? secondObservedAt : firstObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...secondItems];
    setIssueDetails(fixture, secondItems, secondObservedAt);
    const secondByNumber = new Map(secondItems.map((item) => [item.number, item]));
    const secondHighImpact = secondByNumber.get(1);
    const secondChangedTarget = secondByNumber.get(2);
    const secondDownstream = secondByNumber.get(3);
    const secondLeaf = secondByNumber.get(4);
    if (
      secondHighImpact == null ||
      secondChangedTarget == null ||
      secondDownstream == null ||
      secondLeaf == null
    ) {
      throw new TypeError("2回目のAI優先順位fixtureがありません");
    }
    for (const item of [secondHighImpact, secondChangedTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします。入力を更新しました",
          observedAt: secondObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: true,
        }),
      );
    }
    fixture.details.set(
      secondDownstream.nodeId,
      createIssueDetail({
        item: secondDownstream,
        body: "downstream項目です",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(secondDownstream, secondHighImpact),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      secondLeaf.nodeId,
      createIssueDetail({
        item: secondLeaf,
        body: "downstream末端です",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondLeaf, secondDownstream)]),
        duplicateComments: false,
      }),
    );
    harness.setConfig(configWithBudget(baseConfig, 1, 10));
    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    expect(executedNodeIds).toEqual([highImpact.nodeId]);

    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const thirdItems = items.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint:
          item.number === 2 ? "priority-2-blocker-change" : `priority-${item.number.toString()}`,
        updatedAt: item.number === 2 ? thirdObservedAt : firstObservedAt,
        observedAt: thirdObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...thirdItems];
    setIssueDetails(fixture, thirdItems, thirdObservedAt);
    const currentByNumber = new Map(thirdItems.map((item) => [item.number, item]));
    const currentHighImpact = currentByNumber.get(1);
    const currentChangedTarget = currentByNumber.get(2);
    const currentDownstream = currentByNumber.get(3);
    const currentLeaf = currentByNumber.get(4);
    const currentNewBlocker = currentByNumber.get(5);
    if (
      currentHighImpact == null ||
      currentChangedTarget == null ||
      currentDownstream == null ||
      currentLeaf == null ||
      currentNewBlocker == null
    ) {
      throw new TypeError("更新後のAI優先順位fixtureがありません");
    }
    for (const item of [currentHighImpact, currentChangedTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします",
          observedAt: thirdObservedAt,
          nativeDependencies:
            item.nodeId === currentChangedTarget.nodeId
              ? Object.freeze([
                  createExternalNativeBlocker(currentChangedTarget, {
                    state: "closed",
                    repositoryArchived: false,
                    repositoryDisabled: false,
                  }),
                ])
              : Object.freeze([]),
          duplicateComments: true,
        }),
      );
    }
    fixture.details.set(
      currentDownstream.nodeId,
      createIssueDetail({
        item: currentDownstream,
        body: "downstream項目です",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(currentDownstream, currentHighImpact),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      currentLeaf.nodeId,
      createIssueDetail({
        item: currentLeaf,
        body: "downstream末端です",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(currentLeaf, currentDownstream)]),
        duplicateComments: false,
      }),
    );
    executedNodeIds.length = 0;

    expect((await harness.runDaily(FOURTH_RUN_AT)).exitCode).toBe(0);
    expect(executedNodeIds).toEqual([changedBlockerTarget.nodeId]);
  });
});

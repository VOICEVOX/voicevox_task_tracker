import { describe, expect, it } from "vitest";

import {
  createAiCacheEntry,
  createAiCacheKey,
  type AiCacheIdentity,
  type AiCacheEntry,
} from "../src/codex/cache.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type Repository,
} from "../src/domain/index.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";
import { GitHubPublicBoundaryViolationError } from "../src/github/errors.js";
import {
  hashCanonicalJson,
  parseSha256Hash,
  serializeCanonicalJson,
} from "../src/persistence/canonical-json.js";
import {
  CacheDocumentPublicSafetyError,
  CacheDocumentSchemaError,
  CacheDocumentSemanticError,
  createCacheTerminalExpiry,
  type AiLatestImportanceCacheDocument,
  type GitHubItemCacheDocument,
  type GitHubRepositoryCacheDocument,
} from "../src/persistence/cache-documents.js";
import { MemoryStateBranchAdapter } from "../src/persistence/memory-state-branch-adapter.js";
import {
  CacheOnlyPersistenceSession,
  type CacheOnlyPersistenceConfiguration,
  type CacheOnlyPersistenceInput,
} from "../src/persistence/cache-only-session.js";

const configuration: CacheOnlyPersistenceConfiguration = Object.freeze({
  branch: "tracker-state",
  repositoryCacheDirectory: "state/cache/repositories",
  itemCacheDirectory: "state/cache/items",
  latestImportanceDirectory: "state/cache/latest-importance",
  aiCacheDirectory: "state/ai-cache",
});
const repositoryId = createGitHubRepositoryId("R_CACHE_ONLY_PUBLIC");
const itemNodeId = createGitHubNodeId("I_CACHE_ONLY_ITEM");
const actorNodeId = createGitHubNodeId("U_CACHE_ONLY_ACTOR");
const repositoryObservedAt = createUtcIsoDateTime("2026-01-01T00:00:00Z");
const createdAt = createUtcIsoDateTime("2026-01-01T00:00:00Z");
const updatedAt = createUtcIsoDateTime("2026-01-02T00:00:00Z");
const observedAt = createUtcIsoDateTime("2026-01-11T00:00:00Z");
const terminalAt = createUtcIsoDateTime("2026-01-10T00:00:00Z");
const expiredAt = createUtcIsoDateTime("2026-07-10T00:00:00Z");
const retainedAt = createUtcIsoDateTime("2026-07-08T23:59:59Z");
const BODY_FINGERPRINT = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ITEM_FINGERPRINT = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const RULES_FINGERPRINT = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const GRAPH_HASH = parseSha256Hash(
  "sha256:7777777777777777777777777777777777777777777777777777777777777777",
);

const publicRepository: Repository = Object.freeze({
  id: repositoryId,
  owner: "VOICEVOX",
  name: "cache-only-fixture",
  visibility: "public",
  archived: false,
  disabled: false,
  observedAt: repositoryObservedAt,
});
const allowlist = createPublicRepositoryAllowlist([publicRepository]);

function documentPath(directory: string, kind: string, identifier: string): string {
  return `${directory}/${hashCanonicalJson({ identifier, kind }).slice("sha256:".length)}.json`;
}

function aiCachePath(entry: AiCacheEntry): string {
  return `${configuration.aiCacheDirectory}/${entry.cacheKey.slice("sha256:".length)}.json`;
}

function createAiOutput(
  nodeId: string,
  url: string,
  importance: AiLatestImportanceCacheDocument["importance"],
  confidence: number,
): Record<string, unknown> {
  return {
    schemaVersion: "2",
    item: {
      nodeId,
      url,
    },
    status: "terminal_completed",
    waitingOn: [],
    nextAction: "確認する",
    relations: [],
    progress: {
      latestMeaningfulSourceId: null,
      reasonSummary: "進捗を確認する",
      confidence,
    },
    importance,
    evidence: [
      {
        sourceId: "body:cache-only-fixture",
        supports: "uncertainty",
        summary: "cache-only fixture",
      },
    ],
    confidence,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知しません",
    },
  };
}

function createAiCacheFixture(): AiCacheEntry {
  const identity = {
    deterministicRulesVersion: "issue-v1",
    model: "fixture-model",
    reasoningEffort: "medium",
    backendVersion: "fixture-backend-v1",
    promptVersion: "fixture-prompt-v1",
    schemaVersion: "fixture-analysis-v1",
    inputHash: hashCanonicalJson({ fixture: "cache-only-input" }),
  } satisfies AiCacheIdentity;
  const output = createAiOutput(
    itemNodeId,
    "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
    {
      significantFeature: true,
      explicitDeadline: false,
      futureRisk: true,
      rationale: "cache-only fixtureの重要度理由です",
    },
    0.9,
  );
  return createAiCacheEntry({
    cacheKey: createAiCacheKey(identity),
    sourceHash: hashCanonicalJson({ fixture: "cache-only-source" }),
    graphNeighborhoodHash: GRAPH_HASH,
    repository: {
      repositoryId,
      owner: "VOICEVOX",
      name: "cache-only-fixture",
    },
    nodeId: itemNodeId,
    metadata: {
      ...identity,
      outputHash: hashCanonicalJson(output),
      executedAt: observedAt,
    },
    output,
  });
}

function createOrphanAiCacheFixture(): AiCacheEntry {
  const identity = {
    deterministicRulesVersion: "issue-v1",
    model: "orphan-fixture-model",
    reasoningEffort: "medium",
    backendVersion: "fixture-backend-v1",
    promptVersion: "fixture-prompt-v1",
    schemaVersion: "fixture-analysis-v1",
    inputHash: hashCanonicalJson({ fixture: "orphan-cache-input" }),
  } satisfies AiCacheIdentity;
  const output = createAiOutput(
    "I_CACHE_ONLY_ORPHAN",
    "https://github.com/VOICEVOX/cache-only-fixture/issues/3",
    {
      significantFeature: false,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "orphan cache fixtureの重要度理由です",
    },
    0.4,
  );
  return createAiCacheEntry({
    cacheKey: createAiCacheKey(identity),
    sourceHash: hashCanonicalJson({ fixture: "orphan-cache-source" }),
    graphNeighborhoodHash: GRAPH_HASH,
    repository: {
      repositoryId,
      owner: "VOICEVOX",
      name: "cache-only-fixture",
    },
    nodeId: "I_CACHE_ONLY_ORPHAN",
    metadata: {
      ...identity,
      outputHash: hashCanonicalJson(output),
      executedAt: observedAt,
    },
    output,
  });
}

function createUnreferencedRetainedAiCacheFixture(): AiCacheEntry {
  const entry = createAiCacheFixture();
  const identity = {
    deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
    model: "retained-fixture-model",
    reasoningEffort: entry.metadata.reasoningEffort,
    backendVersion: entry.metadata.backendVersion,
    promptVersion: entry.metadata.promptVersion,
    schemaVersion: entry.metadata.schemaVersion,
    inputHash: hashCanonicalJson({ fixture: "retained-cache-input" }),
  } satisfies AiCacheIdentity;
  return createAiCacheEntry({
    ...entry,
    cacheKey: createAiCacheKey(identity),
    sourceHash: hashCanonicalJson({ fixture: "retained-cache-source" }),
    metadata: {
      ...identity,
      outputHash: hashCanonicalJson(entry.output),
      executedAt: entry.metadata.executedAt,
    },
  });
}

function replaceAiCacheOutput(entry: AiCacheEntry, output: Record<string, unknown>): AiCacheEntry {
  return createAiCacheEntry({
    ...entry,
    metadata: {
      ...entry.metadata,
      outputHash: hashCanonicalJson(output),
    },
    output,
  });
}

function createItemIndex(): GitHubRepositoryCacheDocument["items"][number] {
  return {
    nodeId: itemNodeId,
    repositoryId,
    type: "issue",
    number: 1,
    url: "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
    state: "closed",
    draftState: "not_applicable",
    bodyFingerprint: BODY_FINGERPRINT,
    itemFingerprint: ITEM_FINGERPRINT,
    analysisRulesFingerprint: RULES_FINGERPRINT,
    deterministicRulesVersion: "issue-v1",
    aiAnalysisStatus: "used",
    createdAt,
    updatedAt,
    observedAt,
    lifecycle: {
      kind: "terminal",
      terminalAt,
      expiresAt: createCacheTerminalExpiry(terminalAt),
    },
  };
}

const openItemNodeId = createGitHubNodeId("I_CACHE_ONLY_OPEN");

function createOpenItemIndex(): GitHubRepositoryCacheDocument["items"][number] {
  return {
    ...createItemIndex(),
    aiAnalysisStatus: "not_required",
    nodeId: openItemNodeId,
    number: 2,
    url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
    state: "open",
    lifecycle: {
      kind: "open",
    },
  };
}

function createAiCacheReference(): GitHubItemCacheDocument["aiCacheReference"] {
  const entry = createAiCacheFixture();
  return {
    status: "available",
    cacheKey: entry.cacheKey,
    sourceHash: entry.sourceHash,
    inputHash: parseSha256Hash(entry.metadata.inputHash),
    graphNeighborhoodHash: GRAPH_HASH,
    identityHash: hashCanonicalJson({
      backendVersion: entry.metadata.backendVersion,
      deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
      model: entry.metadata.model,
      promptVersion: entry.metadata.promptVersion,
      reasoningEffort: entry.metadata.reasoningEffort,
      schemaVersion: entry.metadata.schemaVersion,
    }),
  };
}

function createItemCache(): GitHubItemCacheDocument {
  const itemSourceId = buildSourceId("github_item", itemNodeId);
  type StateEpoch = Extract<
    GitHubItemCacheDocument["replay"]["stateEpochs"],
    { status: "known" }
  >["value"][number];
  type ResponsibilityEpoch = Extract<
    GitHubItemCacheDocument["replay"]["responsibilityEpochs"],
    { status: "known" }
  >["value"][number];
  const stateEpoch: StateEpoch = {
    occurredAt: createdAt,
    sourceIds: [itemSourceId],
    state: "open",
  };
  const closedStateEpoch: StateEpoch = {
    occurredAt: terminalAt,
    sourceIds: [buildSourceId("github_event", "cache-only-event")],
    state: "closed",
  };
  const responsibilityEpoch: ResponsibilityEpoch = {
    occurredAt: createdAt,
    sourceIds: [itemSourceId],
    targets: [],
  };
  return {
    schemaVersion: "2",
    kind: "github_item",
    repository: {
      repositoryId,
      owner: "VOICEVOX",
      name: "cache-only-fixture",
    },
    ...createItemIndex(),
    currentObservation: {
      freshness: "fresh",
      sourceId: itemSourceId,
      nodeId: itemNodeId,
      repositoryId,
      type: "issue",
      number: 1,
      url: "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
      title: "cache-only fixture",
      bodySourceId: buildSourceId("github_item_body", itemNodeId),
      bodyEmpty: true,
      bodyFingerprint: BODY_FINGERPRINT,
      itemFingerprint: ITEM_FINGERPRINT,
      createdAt,
      githubUpdatedAt: updatedAt,
      observedAt,
      author: {
        status: "unavailable",
        reason: "deleted_account",
      },
      assignees: [],
      labels: [],
      milestone: null,
      events: [],
      state: "closed",
      stateReason: null,
      closedAt: terminalAt,
      draft: "not_applicable",
    },
    analysisFacts: {
      explicitRequestCandidates: [],
      mentionedWaitingOnCandidates: [],
      inputEvents: [],
      codexValidationContext: {
        schemaVersion: "1",
        purpose: "semantic_validation_only",
        now: observedAt,
        item: {
          nodeId: itemNodeId,
          url: "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
          type: "issue",
        },
        candidates: {
          waitingOn: [],
          relations: [],
        },
        sources: [
          {
            id: itemSourceId,
            kind: "item",
            actorType: "system",
            createdAt,
          },
          {
            id: buildSourceId("github_item_body", itemNodeId),
            kind: "body",
            actorType: "system",
            createdAt,
          },
        ],
        nativeRelationConstraints: [],
      },
    },
    relationCandidates: [],
    relationMutations: [],
    replay: {
      trackingStartAt: createdAt,
      currentState: "closed",
      currentDraft: { status: "not_applicable" },
      currentResponsibilities: [],
      stateEpochs: { status: "known", value: [stateEpoch, closedStateEpoch] },
      currentStateEpoch: { status: "known", value: closedStateEpoch },
      draftEpochs: { status: "not_applicable" },
      currentDraftEpoch: { status: "not_applicable" },
      responsibilityEpochs: { status: "known", value: [responsibilityEpoch] },
      currentOwnerEpoch: { status: "known", value: responsibilityEpoch },
    },
    history: {
      status: "complete",
      events: [
        {
          sourceId: buildSourceId("github_event", "cache-only-event"),
          kind: "closed",
          sequence: 0,
          occurredAt: terminalAt,
          actor: {
            status: "identified",
            nodeId: actorNodeId,
          },
          relatedNodeIds: [],
        },
      ],
    },
    aiCacheReference: createAiCacheReference(),
  };
}

function createOpenItemCache(): GitHubItemCacheDocument {
  const cache = createItemCache();
  const index = createOpenItemIndex();
  return {
    ...cache,
    ...index,
    aiCacheReference: {
      status: "unavailable",
    },
    currentObservation: {
      ...cache.currentObservation,
      nodeId: openItemNodeId,
      number: 2,
      url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
      state: "open",
      stateReason: null,
      closedAt: null,
    },
    analysisFacts: {
      ...cache.analysisFacts,
      codexValidationContext: {
        ...cache.analysisFacts.codexValidationContext,
        item: {
          nodeId: openItemNodeId,
          url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
          type: "issue",
        },
      },
    },
    relationCandidates: [
      {
        id: "rel:cache-only-endpoint",
        sourceIds: [buildSourceId("relation", "cache-only-endpoint")],
        authority: "inferred",
        provenance: "explicit_text",
        relation: {
          type: "unclassified",
          referencing: {
            scope: "organization",
            kind: "issue",
            nodeId: openItemNodeId,
            repositoryOwner: "VOICEVOX",
            repositoryName: "cache-only-fixture",
            number: 2,
            url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
            state: "open",
          },
          referenced: {
            scope: "organization",
            kind: "issue",
            nodeId: itemNodeId,
            repositoryOwner: "VOICEVOX",
            repositoryName: "cache-only-fixture",
            number: 1,
            url: "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
            state: "closed",
          },
        },
      },
    ],
    replay: {
      ...cache.replay,
      currentState: "open",
      stateEpochs: {
        status: "known",
        value: [
          {
            occurredAt: createdAt,
            sourceIds: [buildSourceId("github_item", openItemNodeId)],
            state: "open",
          },
        ],
      },
      currentStateEpoch: {
        status: "known",
        value: {
          occurredAt: createdAt,
          sourceIds: [buildSourceId("github_item", openItemNodeId)],
          state: "open",
        },
      },
      responsibilityEpochs: {
        status: "known",
        value: [
          {
            occurredAt: createdAt,
            sourceIds: [buildSourceId("github_item", openItemNodeId)],
            targets: [],
          },
        ],
      },
      currentOwnerEpoch: {
        status: "known",
        value: {
          occurredAt: createdAt,
          sourceIds: [buildSourceId("github_item", openItemNodeId)],
          targets: [],
        },
      },
    },
  };
}

function createRelationMutationResult(
  repositoryOwner: string,
  repositoryName: string,
): GitHubItemCacheDocument["relationMutations"][number] {
  return {
    status: "available",
    contentSourceId: buildSourceId("github_item_body", openItemNodeId),
    currentReferences: [
      {
        repositoryOwner,
        repositoryName,
        itemType: "issue",
        number: 3,
      },
    ],
    replayedReferences: [],
    consistency: "history_incomplete",
    temporalKnowledge: {
      status: "unknown",
      reason: "history_incomplete",
    },
    mutations: [],
    unmatchedRemovals: [],
  };
}

function createRepositoryCache(): GitHubRepositoryCacheDocument {
  return {
    schemaVersion: "2",
    kind: "github_repository",
    repository: {
      repositoryId,
      owner: "VOICEVOX",
      name: "cache-only-fixture",
    },
    successfulAt: observedAt,
    items: [createItemIndex()],
  };
}

function createRepositoryCacheWithOpenItem(): GitHubRepositoryCacheDocument {
  return {
    ...createRepositoryCache(),
    items: [createItemIndex(), createOpenItemIndex()],
  };
}

function createLatestImportanceCache(): AiLatestImportanceCacheDocument {
  const reference = createAiCacheReference();
  if (reference.status !== "available") {
    throw new TypeError("latest importance fixtureに利用可能なAI参照がありません");
  }
  return {
    schemaVersion: "2",
    kind: "ai_latest_importance",
    repository: {
      repositoryId,
      owner: "VOICEVOX",
      name: "cache-only-fixture",
    },
    nodeId: itemNodeId,
    importance: {
      significantFeature: true,
      explicitDeadline: false,
      futureRisk: true,
      rationale: "cache-only fixtureの重要度理由です",
    },
    confidence: 0.9,
    aiCacheReference: {
      status: "available",
      cacheKey: reference.cacheKey,
      sourceHash: reference.sourceHash,
      inputHash: reference.inputHash,
      identityHash: reference.identityHash,
    },
    metadata: {
      deterministicRulesVersion: "issue-v1",
      model: "fixture-model",
      reasoningEffort: "medium",
      backendVersion: "fixture-backend-v1",
      promptVersion: "fixture-prompt-v1",
      analysisSchemaVersion: "fixture-analysis-v1",
      executedAt: observedAt,
    },
  };
}

function createPersistenceInput(
  evaluatedAt: CacheOnlyPersistenceInput["evaluatedAt"],
): CacheOnlyPersistenceInput {
  return {
    evaluatedAt,
    repositoryCaches: [createRepositoryCache()],
    itemCaches: [createItemCache()],
    latestImportanceCaches: [createLatestImportanceCache()],
    aiCacheEntries: [createAiCacheFixture()],
    knownSecrets: [],
  };
}

describe("cache-only永続化session", () => {
  it("missing branchからcold startしてcache文書とAI cacheを読み戻す", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.load({
        evaluatedAt: retainedAt,
        knownSecrets: [],
      }),
    ).resolves.toEqual({
      status: "missing_branch",
    });

    const result = await session.persist(createPersistenceInput(retainedAt));
    expect(result.branchCreated).toBe(true);
    expect(result.updatedPaths).toHaveLength(4);
    expect(result.deletedPaths).toEqual([]);

    const loadedSession = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const loaded = await loadedSession.load({
      evaluatedAt: retainedAt,
      knownSecrets: [],
    });
    expect(loaded).toMatchObject({
      status: "available",
      repositoryCaches: [createRepositoryCache()],
      itemCaches: [createItemCache()],
      latestImportanceCaches: [createLatestImportanceCache()],
    });
    if (loaded.status !== "available") {
      throw new Error("cache-only branchを読み取れません");
    }
    expect(loaded.aiCacheEntries).toHaveLength(1);
    expect(loaded.aiCacheEntries[0]).toEqual(createAiCacheFixture());
  });

  it("evaluatedAtより未来のrepository successfulAtをpersistで拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const futureSuccessfulAt = createUtcIsoDateTime("2026-01-12T00:00:00Z");

    await expect(
      session.persist({
        ...createPersistenceInput(observedAt),
        repositoryCaches: [
          {
            ...createRepositoryCache(),
            successfulAt: futureSuccessfulAt,
          },
        ],
      }),
    ).rejects.toThrow("repository successfulAtはevaluatedAt以後にできません");
  });

  it("evaluatedAtより未来のcache時刻をloadで拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const futureAt = createUtcIsoDateTime("2026-01-12T00:00:00Z");
    await session.persist({
      ...createPersistenceInput(futureAt),
      repositoryCaches: [
        {
          ...createRepositoryCache(),
          successfulAt: futureAt,
        },
      ],
    });

    const loadedSession = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    await expect(
      loadedSession.load({
        evaluatedAt: observedAt,
        knownSecrets: [],
      }),
    ).rejects.toThrow("repository successfulAtはevaluatedAt以後にできません");
  });

  it("evaluatedAtより未来のlatest importance executedAtをpersistで拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const futureExecutedAt = createUtcIsoDateTime("2026-01-12T00:00:00Z");
    const futureEntry = createAiCacheFixture();

    await expect(
      session.persist({
        ...createPersistenceInput(observedAt),
        latestImportanceCaches: [
          {
            ...createLatestImportanceCache(),
            metadata: {
              ...createLatestImportanceCache().metadata,
              executedAt: futureExecutedAt,
            },
          },
        ],
        aiCacheEntries: [
          {
            ...futureEntry,
            metadata: {
              ...futureEntry.metadata,
              executedAt: futureExecutedAt,
            },
          },
        ],
      }),
    ).rejects.toThrow("latest importance executedAtはevaluatedAt以後にできません");
  });

  it("evaluatedAtより未来のAI entry executedAtをpersistで拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const futureExecutedAt = createUtcIsoDateTime("2026-01-12T00:00:00Z");
    const futureEntry = createAiCacheFixture();

    await expect(
      session.persist({
        ...createPersistenceInput(observedAt),
        latestImportanceCaches: [],
        aiCacheEntries: [
          {
            ...futureEntry,
            metadata: {
              ...futureEntry.metadata,
              executedAt: futureExecutedAt,
            },
          },
        ],
      }),
    ).rejects.toThrow("AI cache entry executedAtはevaluatedAt以後にできません");
  });

  it("完全置換commitで古いsnapshot、history、ledgerを残さない", async () => {
    const adapter = new MemoryStateBranchAdapter();
    await adapter.commit({
      branch: "tracker-state",
      expectedHead: { status: "missing" },
      updates: [
        {
          path: "state/snapshot.json",
          bytes: new TextEncoder().encode("旧snapshot\n"),
        },
        {
          path: "state/history/2026-01-01.jsonl",
          bytes: new TextEncoder().encode("旧history\n"),
        },
        {
          path: "state/notification-ledger.json",
          bytes: new TextEncoder().encode("旧ledger\n"),
        },
      ],
      deletions: [],
      message: "cache-only fixture seed",
      committedAt: retainedAt,
    });

    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const result = await session.persist(createPersistenceInput(retainedAt));
    expect(result.deletedPaths).toEqual([
      "state/history/2026-01-01.jsonl",
      "state/notification-ledger.json",
      "state/snapshot.json",
    ]);
    expect([...(await adapter.readBranchFiles("tracker-state"))].map(([path]) => path)).toEqual(
      [
        aiCachePath(createAiCacheFixture()),
        documentPath(configuration.itemCacheDirectory, "github_item", createItemCache().nodeId),
        documentPath(
          configuration.latestImportanceDirectory,
          "ai_latest_importance",
          createLatestImportanceCache().nodeId,
        ),
        documentPath(
          configuration.repositoryCacheDirectory,
          "github_repository",
          createRepositoryCache().repository.repositoryId,
        ),
      ].sort(),
    );
  });

  it("terminalAtから180日を超えたitemと関連するlatest importanceを除外する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const result = await session.persist(createPersistenceInput(expiredAt));

    expect(result.updatedPaths).toEqual(
      [
        documentPath(
          configuration.repositoryCacheDirectory,
          "github_repository",
          createRepositoryCache().repository.repositoryId,
        ),
      ].sort(),
    );
    const loaded = await session.load({
      evaluatedAt: expiredAt,
      knownSecrets: [],
    });
    if (loaded.status !== "available") {
      throw new Error("cache-only branchを読み取れません");
    }
    expect(loaded.repositoryCaches[0]?.items).toEqual([]);
    expect(loaded.itemCaches).toEqual([]);
    expect(loaded.latestImportanceCaches).toEqual([]);
    expect(loaded.aiCacheEntries).toHaveLength(0);
  });

  it("open itemが参照するterminal endpointは180日後も保持する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const input = createPersistenceInput(expiredAt);
    const result = await session.persist({
      ...input,
      repositoryCaches: [createRepositoryCacheWithOpenItem()],
      itemCaches: [createItemCache(), createOpenItemCache()],
      latestImportanceCaches: [createLatestImportanceCache()],
    });

    expect(result.updatedPaths).toHaveLength(5);
    const loaded = await session.load({
      evaluatedAt: expiredAt,
      knownSecrets: [],
    });
    if (loaded.status !== "available") {
      throw new Error("cache-only branchを読み取れません");
    }
    expect(loaded.itemCaches.map((item) => item.nodeId)).toEqual([itemNodeId, openItemNodeId]);
    expect(loaded.repositoryCaches[0]?.items.map((item) => item.nodeId)).toEqual([
      itemNodeId,
      openItemNodeId,
    ]);
    expect(loaded.latestImportanceCaches).toHaveLength(1);
  });

  it("cacheからallowlist外repositoryを検出したら読み書きを停止する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const privateRepository = {
      ...createRepositoryCache(),
      repository: {
        repositoryId: createGitHubRepositoryId("R_CACHE_ONLY_PRIVATE"),
        owner: "PRIVATE",
        name: "hidden",
      },
      items: [],
    };
    await adapter.commit({
      branch: "tracker-state",
      expectedHead: { status: "missing" },
      updates: [
        {
          path: documentPath(
            configuration.repositoryCacheDirectory,
            "github_repository",
            privateRepository.repository.repositoryId,
          ),
          bytes: new TextEncoder().encode(JSON.stringify(privateRepository)),
        },
      ],
      deletions: [],
      message: "private cache fixture seed",
      committedAt: retainedAt,
    });

    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    await expect(
      session.load({
        evaluatedAt: retainedAt,
        knownSecrets: [],
      }),
    ).rejects.toThrow("公開allowlist外");
    await expect(session.persist(createPersistenceInput(retainedAt))).rejects.toThrow(
      "公開allowlist外",
    );
  });

  it("organization relation candidateのrepositoryをallowlistへ再検証する", async () => {
    const candidate = createOpenItemCache().relationCandidates[0];
    if (candidate == null) {
      throw new Error("organization relation candidateがありません");
    }
    if (candidate.relation.type !== "unclassified") {
      throw new Error("organization relation candidateの種別が不正です");
    }
    const invalidItem = {
      ...createOpenItemCache(),
      relationCandidates: [
        {
          ...candidate,
          relation: {
            ...candidate.relation,
            referenced: {
              ...candidate.relation.referenced,
              repositoryName: "not-allowlisted",
              url: "https://github.com/VOICEVOX/not-allowlisted/issues/1",
            },
          },
        },
      ],
    };
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        itemCaches: [invalidItem],
      }),
    ).rejects.toBeInstanceOf(GitHubPublicBoundaryViolationError);
  });

  it("allowlist organization ownerを指すrelation mutationのrepositoryを再検証する", async () => {
    const invalidItem = {
      ...createOpenItemCache(),
      relationMutations: [createRelationMutationResult("VOICEVOX", "not-allowlisted")],
    };
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        itemCaches: [invalidItem],
      }),
    ).rejects.toBeInstanceOf(GitHubPublicBoundaryViolationError);
  });

  it("allowlist organization外のexternal public relation mutationは公開判定せず保持する", async () => {
    const externalItem = {
      ...createOpenItemCache(),
      relationMutations: [createRelationMutationResult("external-org", "public-project")],
    };
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        repositoryCaches: [createRepositoryCacheWithOpenItem()],
        itemCaches: [createItemCache(), externalItem],
      }),
    ).resolves.toBeDefined();
  });

  it("schemaとpublic safety検証を保存前に通す", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const unsafeRepository = {
      ...createRepositoryCache(),
      body: "保存禁止の本文",
    };
    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        repositoryCaches: [unsafeRepository],
      }),
    ).rejects.toThrow(CacheDocumentPublicSafetyError);
    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        repositoryCaches: [
          {
            ...createRepositoryCache(),
            unknown: true,
          },
        ],
      }),
    ).rejects.toThrow(CacheDocumentSchemaError);
  });

  it("repository indexとitem documentの不一致を拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const mismatchedItem = {
      ...createItemCache(),
      number: 2,
      url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
      currentObservation: {
        ...createItemCache().currentObservation,
        number: 2,
        url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
      },
      analysisFacts: {
        ...createItemCache().analysisFacts,
        codexValidationContext: {
          ...createItemCache().analysisFacts.codexValidationContext,
          item: {
            nodeId: itemNodeId,
            url: "https://github.com/VOICEVOX/cache-only-fixture/issues/2",
            type: "issue",
          },
        },
      },
    };

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        itemCaches: [mismatchedItem],
      }),
    ).rejects.toThrow(CacheDocumentSemanticError);
    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        itemCaches: [mismatchedItem],
      }),
    ).rejects.toThrow("repository indexとitem document");
  });

  it("latest importanceの孤立node IDを拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const orphan = {
      ...createLatestImportanceCache(),
      nodeId: createGitHubNodeId("I_CACHE_ONLY_ORPHAN"),
    };

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        latestImportanceCaches: [orphan],
      }),
    ).rejects.toThrow("latest importanceに対応するrepositoryとitemがありません");
  });

  it("latest importanceのmetadata不一致を拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const latest = createLatestImportanceCache();
    const mismatchedLatest = {
      ...latest,
      metadata: {
        ...latest.metadata,
        model: "different-model",
      },
    };

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        latestImportanceCaches: [mismatchedLatest],
      }),
    ).rejects.toThrow("latest importanceのmetadataがAI cache entryと一致しません");
  });

  it("AI cache entryのnode IDとAI outputのnode IDが一致しなければ拒否する", () => {
    const entry = createAiCacheFixture();
    const output = createAiOutput(
      "I_CACHE_ONLY_OTHER",
      "https://github.com/VOICEVOX/cache-only-fixture/issues/99",
      {
        significantFeature: true,
        explicitDeadline: false,
        futureRisk: true,
        rationale: "cache-only fixtureの重要度理由です",
      },
      0.9,
    );
    expect(() =>
      createAiCacheEntry({
        ...entry,
        metadata: {
          ...entry.metadata,
          outputHash: hashCanonicalJson(output),
        },
        output,
      }),
    ).toThrow("AI cache entryのnode IDが出力項目と一致しません");
  });

  it("item cacheのnode IDとAI cache entryのnode IDが一致しなければ拒否する", async () => {
    const entry = createAiCacheFixture();
    const output = createAiOutput(
      "I_CACHE_ONLY_OTHER",
      "https://github.com/VOICEVOX/cache-only-fixture/issues/99",
      entry.output.importance,
      entry.output.confidence,
    );
    const mismatchedEntry = createAiCacheEntry({
      ...entry,
      nodeId: "I_CACHE_ONLY_OTHER",
      metadata: {
        ...entry.metadata,
        outputHash: hashCanonicalJson(output),
      },
      output,
    });
    const session = await CacheOnlyPersistenceSession.open(
      new MemoryStateBranchAdapter(),
      configuration,
      allowlist,
    );

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [mismatchedEntry],
      }),
    ).rejects.toThrow("item cacheのnode IDがAI cache entryと一致しません");
  });

  it("AI cache entryのrepository identityを公開allowlistへ照合する", async () => {
    const entry = createAiCacheFixture();
    const mismatchedEntry = createAiCacheEntry({
      ...entry,
      repository: {
        ...entry.repository,
        name: "not-allowlisted",
      },
    });
    const session = await CacheOnlyPersistenceSession.open(
      new MemoryStateBranchAdapter(),
      configuration,
      allowlist,
    );

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [mismatchedEntry],
      }),
    ).rejects.toBeInstanceOf(GitHubPublicBoundaryViolationError);
  });

  it("item cacheとAI cache entryのrepositoryが一致しなければ拒否する", async () => {
    const otherRepository: Repository = {
      id: createGitHubRepositoryId("R_CACHE_ONLY_OTHER"),
      owner: "VOICEVOX",
      name: "cache-only-other",
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: repositoryObservedAt,
    };
    const entry = createAiCacheFixture();
    const mismatchedEntry = createAiCacheEntry({
      ...entry,
      repository: {
        repositoryId: otherRepository.id,
        owner: otherRepository.owner,
        name: otherRepository.name,
      },
    });
    const session = await CacheOnlyPersistenceSession.open(
      new MemoryStateBranchAdapter(),
      configuration,
      createPublicRepositoryAllowlist([publicRepository, otherRepository]),
    );

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [mismatchedEntry],
      }),
    ).rejects.toThrow("item cacheのrepositoryがAI cache entryと一致しません");
  });

  it("latest importanceのimportanceがAI outputと一致しなければ拒否する", async () => {
    const mismatchedEntry = replaceAiCacheOutput(
      createAiCacheFixture(),
      createAiOutput(
        itemNodeId,
        "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
        {
          significantFeature: false,
          explicitDeadline: false,
          futureRisk: true,
          rationale: "cache-only fixtureの重要度理由です",
        },
        0.9,
      ),
    );
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [mismatchedEntry],
      }),
    ).rejects.toThrow("latest importanceがAI cache entryのimportanceと一致しません");
  });

  it("latest importanceのconfidenceがAI outputと一致しなければ拒否する", async () => {
    const mismatchedEntry = replaceAiCacheOutput(
      createAiCacheFixture(),
      createAiOutput(
        itemNodeId,
        "https://github.com/VOICEVOX/cache-only-fixture/issues/1",
        {
          significantFeature: true,
          explicitDeadline: false,
          futureRisk: true,
          rationale: "cache-only fixtureの重要度理由です",
        },
        0.8,
      ),
    );
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [mismatchedEntry],
      }),
    ).rejects.toThrow("latest importanceがAI cache entryのconfidenceと一致しません");
  });

  it("item cacheのexact参照とAI entryのgraph近傍hash不一致を拒否する", async () => {
    const reference = createAiCacheReference();
    if (reference.status !== "available") {
      throw new TypeError("exact参照fixtureが利用可能ではありません");
    }
    const mismatchedReference = {
      ...reference,
      graphNeighborhoodHash: parseSha256Hash(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      ),
    };
    const item = {
      ...createItemCache(),
      aiCacheReference: mismatchedReference,
    };
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        itemCaches: [item],
      }),
    ).rejects.toThrow("graph近傍hashが一致しません");
  });

  it("availableなAI cache参照に対応するentryがなければ拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [],
      }),
    ).rejects.toThrow("availableなAI cache参照に対応するentryがありません");
  });

  it("保持対象itemに属する未参照AI resultをindex再構築用に保持する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const retained = createUnreferencedRetainedAiCacheFixture();

    await session.persist({
      ...createPersistenceInput(retainedAt),
      aiCacheEntries: [createAiCacheFixture(), retained],
    });
    const loaded = await session.load({
      evaluatedAt: retainedAt,
      knownSecrets: [],
    });

    expect(loaded).toMatchObject({ status: "available" });
    if (loaded.status !== "available") {
      throw new TypeError("保持対象itemのAI resultを読み取れません");
    }
    expect(loaded.aiCacheEntries.map((entry) => entry.cacheKey)).toContain(retained.cacheKey);
  });

  it("保持対象itemに属さない未参照AI cache entryをpersistで拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    const orphan = createOrphanAiCacheFixture();

    await expect(
      session.persist({
        ...createPersistenceInput(retainedAt),
        aiCacheEntries: [createAiCacheFixture(), orphan],
      }),
    ).rejects.toThrow("保持対象itemに属さない未参照AI cache entryがあります");
  });

  it("branchに残るorphan AI cache entryをloadで拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const session = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    await session.persist(createPersistenceInput(retainedAt));
    const orphan = createOrphanAiCacheFixture();
    const head = await adapter.resolveHead(configuration.branch);
    if (head.status !== "present") {
      throw new Error("cache-only branchが作成されていません");
    }
    await adapter.commit({
      branch: configuration.branch,
      expectedHead: head,
      updates: [
        {
          path: aiCachePath(orphan),
          bytes: new TextEncoder().encode(`${serializeCanonicalJson(orphan)}\n`),
        },
      ],
      deletions: [],
      message: "orphan AI cache fixture seed",
      committedAt: retainedAt,
    });

    const loadedSession = await CacheOnlyPersistenceSession.open(adapter, configuration, allowlist);
    await expect(
      loadedSession.load({
        evaluatedAt: retainedAt,
        knownSecrets: [],
      }),
    ).rejects.toThrow("保持対象itemに属さない未参照AI cache entryがあります");
  });
});

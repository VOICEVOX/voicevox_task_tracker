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
import { hashCanonicalJson, parseSha256Hash } from "../src/persistence/canonical-json.js";
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
const observedAt = createUtcIsoDateTime("2026-01-03T00:00:00Z");
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
  const output = {
    decision: "available",
  };
  return createAiCacheEntry({
    cacheKey: createAiCacheKey(identity),
    sourceHash: hashCanonicalJson({ fixture: "cache-only-source" }),
    metadata: {
      ...identity,
      outputHash: hashCanonicalJson(output),
      executedAt: observedAt,
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
  return {
    schemaVersion: "1",
    kind: "github_item",
    repository: {
      repositoryId,
      owner: "VOICEVOX",
      name: "cache-only-fixture",
    },
    ...createItemIndex(),
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

function createRepositoryCache(): GitHubRepositoryCacheDocument {
  return {
    schemaVersion: "1",
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

function createLatestImportanceCache(): AiLatestImportanceCacheDocument {
  return {
    schemaVersion: "1",
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
    aiCacheReference: createAiCacheReference(),
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
        aiCachePath(createAiCacheFixture()),
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
    expect(loaded.aiCacheEntries).toHaveLength(1);
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
});

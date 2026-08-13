import { describe, expect, it } from "vitest";

import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubNodeId,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  createAiCacheEntry,
  createAiCacheKey,
  type AiCacheIdentity,
  type AiCacheEntry,
} from "../src/codex/cache.js";
import { createCodexAnalysisInput, type CodexAnalysisInput } from "../src/codex/input.js";
import {
  hashCanonicalJson,
  parseSha256Hash,
  type Sha256Hash,
} from "../src/codex/canonical-json.js";
import {
  createImportanceCacheEntry,
  createImportanceCacheCandidate,
  resolveImportance,
  type ImportanceCacheContext,
  type ImportanceCacheEntry,
  type ImportanceCacheRepository,
  type ImportanceCacheState,
  type VerifiedImportanceResult,
} from "../src/codex/importance-cache-fallback.js";
import type { AiLatestImportanceCacheDocument } from "../src/persistence/cache-documents.js";

const REPOSITORY: ImportanceCacheRepository = {
  repositoryId: createGitHubRepositoryId("R_importance_cache"),
  owner: "VOICEVOX",
  name: "example",
};
const OTHER_REPOSITORY: ImportanceCacheRepository = {
  repositoryId: createGitHubRepositoryId("R_other_importance_cache"),
  owner: "VOICEVOX",
  name: "other",
};
const NODE_ID = createGitHubNodeId("I_importance_cache");
const OTHER_NODE_ID = createGitHubNodeId("I_other_importance_cache");
const EVALUATED_AT = createUtcIsoDateTime("2026-08-13T00:00:00Z");

type EntryFixture = Readonly<{
  entry: AiCacheEntry;
  reference: ImportanceCacheEntry;
  importance: VerifiedImportanceResult["importance"];
  identityHash: Sha256Hash;
  graphNeighborhoodHash: Sha256Hash;
}>;

type OutputOptions =
  | Readonly<{ relation: "none"; sourceId: string }>
  | Readonly<{ relation: "candidate"; sourceId: string; candidateId: string }>;

const VALID_OUTPUT_OPTIONS = {
  relation: "none",
  sourceId: "body:fixture",
} satisfies OutputOptions;

function createInput(nodeId: GitHubNodeId): CodexAnalysisInput {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: "2026-08-13T00:00:00Z",
    item: {
      nodeId,
      url: "https://github.com/VOICEVOX/example/issues/1",
      type: "issue",
      title: "fixture",
    },
    candidates: {
      waitingOn: [],
      relations: [],
    },
    sources: [
      {
        id: "body:fixture",
        kind: "body",
        actorType: "human",
        createdAt: "2026-08-12T00:00:00Z",
      },
    ],
    deterministicSignals: {},
    priorAnalysis: null,
  });
}

function createFullEntry(
  marker: string,
  executedAt: UtcIsoDateTime,
  nodeId: GitHubNodeId = NODE_ID,
  rationale: string = createImportance(marker === "current" ? "result" : marker).rationale,
  options: OutputOptions = VALID_OUTPUT_OPTIONS,
): AiCacheEntry {
  const inputHash = hashCanonicalJson({ input: marker });
  const identity = {
    deterministicRulesVersion: "issue-v1",
    model: "model-v1",
    reasoningEffort: "medium",
    backendVersion: "backend-v1",
    promptVersion: "prompt-v1",
    schemaVersion: "analysis-v1",
    inputHash,
  } satisfies AiCacheIdentity;
  const importance = {
    ...createImportance(marker === "current" ? "result" : marker),
    rationale,
  };
  const output = {
    schemaVersion: "2",
    item: {
      nodeId,
      url: "https://github.com/VOICEVOX/example/issues/1",
    },
    status: "terminal_completed",
    waitingOn: [],
    nextAction: "確認する",
    relations:
      options.relation === "none"
        ? []
        : [
            {
              candidateId: options.candidateId,
              verdict: "related",
              reasonSummary: "fixture",
              sourceIds: [options.sourceId],
              confidence: 0.8,
            },
          ],
    progress: {
      latestMeaningfulSourceId: null,
      reasonSummary: "進捗を確認する",
      confidence: 0.8,
    },
    importance,
    evidence: [
      {
        sourceId: options.sourceId,
        supports: "uncertainty",
        summary: "fixture",
      },
    ],
    confidence: 0.8,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "",
    },
  };
  return createAiCacheEntry({
    cacheKey: createAiCacheKey(identity),
    sourceHash: hashCanonicalJson({ source: marker }),
    metadata: {
      ...identity,
      outputHash: hashCanonicalJson(output),
      executedAt,
    },
    output,
  });
}

function createEntry(
  marker: string,
  executedAt: UtcIsoDateTime,
  nodeId: GitHubNodeId = NODE_ID,
  rationale: string = createImportance(marker === "current" ? "result" : marker).rationale,
  options: OutputOptions = VALID_OUTPUT_OPTIONS,
): EntryFixture {
  const entry = createFullEntry(marker, executedAt, nodeId, rationale, options);
  const reference = createImportanceCacheEntry(entry, createInput(nodeId));
  const identityHash = hashCanonicalJson({
    backendVersion: reference.metadata.backendVersion,
    deterministicRulesVersion: reference.metadata.deterministicRulesVersion,
    model: reference.metadata.model,
    promptVersion: reference.metadata.promptVersion,
    reasoningEffort: reference.metadata.reasoningEffort,
    schemaVersion: reference.metadata.schemaVersion,
  });
  return {
    entry,
    reference,
    identityHash,
    graphNeighborhoodHash: hashCanonicalJson({ graph: marker }),
    importance: reference.importance,
  };
}

function createImportance(marker: string): VerifiedImportanceResult["importance"] {
  return {
    significantFeature: marker === "new",
    explicitDeadline: true,
    futureRisk: false,
    rationale: `理由 ${marker}`,
  };
}

function createResult(
  fixture: EntryFixture,
  nodeId: GitHubNodeId = NODE_ID,
  repository: ImportanceCacheRepository = REPOSITORY,
): VerifiedImportanceResult {
  return {
    nodeId,
    repository,
    importance: fixture.importance,
    confidence: fixture.reference.confidence,
    fingerprint: {
      sourceHash: fixture.reference.sourceHash,
      inputHash: parseSha256Hash(fixture.reference.metadata.inputHash),
      graphNeighborhoodHash: fixture.graphNeighborhoodHash,
      identityHash: fixture.identityHash,
    },
    entry: fixture.reference,
  };
}

function createContext(
  aiCacheEntries: readonly ImportanceCacheEntry[] = [],
  repository: ImportanceCacheRepository = REPOSITORY,
  repositoryAllowlist: readonly ImportanceCacheRepository[] = [REPOSITORY],
  nodeId: GitHubNodeId = NODE_ID,
  evaluatedAt: UtcIsoDateTime = EVALUATED_AT,
): ImportanceCacheContext {
  return {
    nodeId,
    repository,
    repositoryAllowlist,
    evaluatedAt,
    aiCacheEntries,
  };
}

function createLatest(
  fixture: EntryFixture,
  nodeId: GitHubNodeId = NODE_ID,
  repository: ImportanceCacheRepository = REPOSITORY,
  importance: VerifiedImportanceResult["importance"] = fixture.importance,
): AiLatestImportanceCacheDocument {
  return {
    schemaVersion: "1",
    kind: "ai_latest_importance",
    repository,
    nodeId,
    importance,
    confidence: fixture.reference.confidence,
    aiCacheReference: {
      status: "available",
      cacheKey: fixture.reference.cacheKey,
      sourceHash: fixture.reference.sourceHash,
      inputHash: parseSha256Hash(fixture.reference.metadata.inputHash),
      graphNeighborhoodHash: fixture.graphNeighborhoodHash,
      identityHash: fixture.identityHash,
    },
    metadata: {
      deterministicRulesVersion: fixture.reference.metadata.deterministicRulesVersion,
      model: fixture.reference.metadata.model,
      reasoningEffort: fixture.reference.metadata.reasoningEffort,
      backendVersion: fixture.reference.metadata.backendVersion,
      promptVersion: fixture.reference.metadata.promptVersion,
      analysisSchemaVersion: fixture.reference.metadata.schemaVersion,
      executedAt: fixture.reference.metadata.executedAt,
    },
  };
}

function available(document: AiLatestImportanceCacheDocument): ImportanceCacheState {
  return { status: "available", document };
}

describe("重要度キャッシュ代替判定", () => {
  it("現在の完全一致AI結果は重要度4項目だけを通常結果として返す", () => {
    const current = createEntry("current", createUtcIsoDateTime("2026-08-12T00:00:00Z"));

    expect(
      resolveImportance({
        context: createContext(),
        current: { status: "available", result: createResult(current) },
        latest: { status: "not_available" },
      }),
    ).toEqual({
      status: "normal",
      source: "current_validated_ai",
      importance: createImportance("result"),
    });
  });

  const AI_FAILURE_STATUSES = ["execution_failed", "budget_deferred"] satisfies readonly [
    "execution_failed",
    "budget_deferred",
  ];

  it.each(AI_FAILURE_STATUSES)("%sのときだけ同じnode IDの直近重要度を使う", (status) => {
    const cached = createEntry("cached", createUtcIsoDateTime("2026-08-11T00:00:00Z"));
    const document = createLatest(cached);

    expect(
      resolveImportance({
        context: createContext([cached.reference]),
        current: { status },
        latest: available(document),
      }),
    ).toEqual({
      status: "fallback",
      source: "latest_importance_cache",
      importance: createImportance("cached"),
    });
  });

  it("キャッシュがなければnot_availableを返す", () => {
    expect(
      resolveImportance({
        context: createContext(),
        current: { status: "execution_failed" },
        latest: { status: "not_available" },
      }),
    ).toEqual({
      status: "not_available",
      reason: "latest_importance_cache_missing",
    });
  });

  it("node IDが異なるキャッシュを拒否する", () => {
    const cached = createEntry("cached", createUtcIsoDateTime("2026-08-11T00:00:00Z"));

    expect(() =>
      resolveImportance({
        context: createContext([cached.reference]),
        current: { status: "execution_failed" },
        latest: available(createLatest(cached, OTHER_NODE_ID)),
      }),
    ).toThrow();
  });

  it("allowlistと一致しないリポジトリを拒否する", () => {
    expect(() =>
      resolveImportance({
        context: createContext([], REPOSITORY, [OTHER_REPOSITORY]),
        current: { status: "execution_failed" },
        latest: { status: "not_available" },
      }),
    ).toThrow();
  });

  it("参照先のAIエントリがないキャッシュを拒否する", () => {
    const cached = createEntry("cached", createUtcIsoDateTime("2026-08-11T00:00:00Z"));

    expect(() =>
      resolveImportance({
        context: createContext(),
        current: { status: "execution_failed" },
        latest: available(createLatest(cached)),
      }),
    ).toThrow();
  });

  it("AIエントリと異なるnodeのlatest cacheを拒否する", () => {
    const otherNodeEntry = createEntry(
      "cached",
      createUtcIsoDateTime("2026-08-11T00:00:00Z"),
      OTHER_NODE_ID,
    );

    expect(() =>
      resolveImportance({
        context: createContext([otherNodeEntry.reference]),
        current: { status: "execution_failed" },
        latest: available(createLatest(otherNodeEntry, NODE_ID)),
      }),
    ).toThrow();
  });

  it("latest importanceの改ざんを拒否する", () => {
    const cached = createEntry("cached", createUtcIsoDateTime("2026-08-11T00:00:00Z"));
    const document = createLatest(cached);
    const tamperedDocument = {
      ...document,
      importance: {
        ...document.importance,
        futureRisk: !document.importance.futureRisk,
      },
    };

    expect(() =>
      resolveImportance({
        context: createContext([cached.reference]),
        current: { status: "execution_failed" },
        latest: available(tamperedDocument),
      }),
    ).toThrow();
  });

  it("latest confidenceの改ざんを拒否する", () => {
    const cached = createEntry("cached", createUtcIsoDateTime("2026-08-11T00:00:00Z"));
    const document = createLatest(cached);
    const tamperedDocument = {
      ...document,
      confidence: document.confidence === 0.8 ? 0.7 : 0.8,
    };

    expect(() =>
      resolveImportance({
        context: createContext([cached.reference]),
        current: { status: "execution_failed" },
        latest: available(tamperedDocument),
      }),
    ).toThrow();
  });

  it("現在入力の指紋がAIエントリと異なる場合は拒否する", () => {
    const current = createEntry("current", createUtcIsoDateTime("2026-08-12T00:00:00Z"));
    const other = createEntry("other", createUtcIsoDateTime("2026-08-12T00:00:00Z"));
    const result = createResult(current);

    expect(() =>
      resolveImportance({
        context: createContext(),
        current: {
          status: "available",
          result: {
            ...result,
            fingerprint: {
              ...result.fingerprint,
              sourceHash: other.reference.sourceHash,
            },
          },
        },
        latest: { status: "not_available" },
      }),
    ).toThrow();
  });

  it("現在結果のimportanceがAIエントリと異なる場合は拒否する", () => {
    const current = createEntry("current", createUtcIsoDateTime("2026-08-12T00:00:00Z"));
    const result = createResult(current);

    expect(() =>
      resolveImportance({
        context: createContext(),
        current: {
          status: "available",
          result: {
            ...result,
            importance: createImportance("tampered"),
          },
        },
        latest: { status: "not_available" },
      }),
    ).toThrow();
  });

  it("rationaleが120文字を超えるAIエントリを拒否する", () => {
    expect(() =>
      createFullEntry(
        "long",
        createUtcIsoDateTime("2026-08-12T00:00:00Z"),
        NODE_ID,
        "あ".repeat(121),
      ),
    ).toThrow();
  });

  it("入力に存在しないsource IDを持つAIエントリを拒否する", () => {
    const entry = createFullEntry(
      "unknown-source",
      createUtcIsoDateTime("2026-08-12T00:00:00Z"),
      NODE_ID,
      "理由 unknown-source",
      {
        relation: "none",
        sourceId: "body:unknown",
      },
    );

    expect(() => createImportanceCacheEntry(entry, createInput(NODE_ID))).toThrow();
  });

  it("入力候補にないrelationを持つAIエントリを拒否する", () => {
    const entry = createFullEntry(
      "unknown-relation",
      createUtcIsoDateTime("2026-08-12T00:00:00Z"),
      NODE_ID,
      "理由 unknown-relation",
      {
        relation: "candidate",
        sourceId: "body:fixture",
        candidateId: "rel:unknown",
      },
    );

    expect(() => createImportanceCacheEntry(entry, createInput(NODE_ID))).toThrow();
  });

  it("評価時刻より新しいキャッシュを拒否する", () => {
    const future = createEntry("future", createUtcIsoDateTime("2026-08-14T00:00:00Z"));

    expect(() =>
      resolveImportance({
        context: createContext([future.reference]),
        current: { status: "execution_failed" },
        latest: available(createLatest(future)),
      }),
    ).toThrow();
  });

  it("新しい検証済み結果からキャッシュ候補を作り、前回より古い結果を拒否する", () => {
    const previous = createEntry("previous", createUtcIsoDateTime("2026-08-10T00:00:00Z"));
    const current = createEntry("current", createUtcIsoDateTime("2026-08-12T00:00:00Z"));
    const previousDocument = createLatest(previous);
    const candidate = createImportanceCacheCandidate({
      context: createContext([previous.reference]),
      current: createResult(current),
      previous: available(previousDocument),
    });

    expect(candidate.nodeId).toBe(NODE_ID);
    expect(candidate.aiCacheReference.status).toBe("available");
    if (candidate.aiCacheReference.status === "available") {
      expect(candidate.aiCacheReference.cacheKey).toBe(current.reference.cacheKey);
    }
    expect(candidate.importance).toEqual(createImportance("result"));

    expect(() =>
      createImportanceCacheCandidate({
        context: createContext([previous.reference]),
        current: createResult(previous),
        previous: available(previousDocument),
      }),
    ).toThrow();
  });

  it("キャッシュ文書の余計なフィールドを拒否する", () => {
    const cached = createEntry("cached", createUtcIsoDateTime("2026-08-11T00:00:00Z"));
    const document = { ...createLatest(cached), oldStatus: "waiting_for_work" };

    expect(() =>
      resolveImportance({
        context: createContext([cached.reference]),
        current: { status: "execution_failed" },
        latest: available(document),
      }),
    ).toThrow();
  });
});

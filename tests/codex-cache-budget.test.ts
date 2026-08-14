import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  MemoryAiCacheStore,
  createAiCacheEntry,
  createAiCacheKey,
  createCodexAnalysisInput,
  createFileAiCacheStore,
  determineAiCacheReuse,
  estimateAiInputCost,
  hashCanonicalJson,
  prepareAiAnalysisCandidate as prepareCandidateWithIdentity,
  runAiAnalyses as runPreparedAiAnalyses,
  serializeCanonicalJson,
  CodexTransportAliasError,
  type AiAnalysisCandidate,
  type AiAnalysisPriority,
  type AiAnalysisRunConfiguration,
  type AiAnalysisRunDependencies,
  type AiAnalysisRunIdentity,
  type AiAnalysisRunResult,
  type AiCacheIdentity,
  type CodexAnalysisInput,
  type PreparedAiAnalysisCandidate,
  type PreviousAiAnalysisFingerprint,
  type SchemaValidCodexAnalysisOutput,
} from "../src/codex/index.js";
import { createAiBudgetReservationController } from "../src/codex/budget.js";
import { assertNonNullable } from "../src/util/index.js";

const unavailablePreviousFingerprint = Object.freeze({
  status: "unavailable",
}) satisfies PreviousAiAnalysisFingerprint;
const fixedExecutedAt = "2026-07-31T00:00:00.000Z";
const runIdentity = Object.freeze({
  deterministicRulesVersion: "rules-v1",
  model: "codex-model",
  reasoningEffort: "medium",
  backendVersion: "codex-cli-1.2.3",
  promptVersion: "prompt-v1",
  schemaVersion: "schema-v1",
}) satisfies AiAnalysisRunIdentity;

class HttpFixtureError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`HTTP fixture error ${status.toString()}`);
    this.name = "HttpFixtureError";
    this.status = status;
  }
}

function createInputAt(id: string, body: string, now: string): CodexAnalysisInput {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now,
    item: {
      nodeId: id,
      url: "https://github.com/VOICEVOX/example/issues/1",
      type: "issue",
      title: "分析対象",
      authorCandidateId: "author",
    },
    candidates: {
      waitingOn: [
        {
          id: "role:maintainer",
        },
      ],
      relations: [],
    },
    sources: [
      {
        id: "body:current",
        kind: "body",
        actorType: "human",
        createdAt: "2026-07-20T00:00:00Z",
        text: body,
      },
    ],
    deterministicSignals: {
      owner: "unknown",
    },
    priorAnalysis: null,
  });
}

function createInput(id: string, body: string): CodexAnalysisInput {
  return createInputAt(id, body, "2026-07-30T23:00:00Z");
}

function createInputWithRelation(id: string, body: string): CodexAnalysisInput {
  const input = createInput(id, body);
  return createCodexAnalysisInput({
    ...input,
    candidates: {
      ...input.candidates,
      relations: [
        {
          id: "rel:semantic-retry-unknown-source",
          targetUrl: "https://github.com/VOICEVOX/example/issues/2",
        },
      ],
    },
    deterministicSignals: {
      ...input.deterministicSignals,
      relationCandidateIds: ["rel:semantic-retry-unknown-source"],
    },
  });
}

function createSchemaValidOutput(nodeId: string): Record<string, unknown> {
  return {
    schemaVersion: "2",
    item: {
      nodeId,
      url: "https://github.com/VOICEVOX/example/issues/1",
    },
    status: "terminal_completed",
    waitingOn: [],
    nextAction: "確認する",
    relations: [],
    progress: {
      latestMeaningfulSourceId: null,
      reasonSummary: "進捗を確認する",
      confidence: 0.8,
    },
    importance: {
      significantFeature: false,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "cache fixture",
    },
    evidence: [
      {
        sourceId: "body:current",
        supports: "uncertainty",
        summary: "cache fixture",
      },
    ],
    confidence: 0.8,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知しません",
    },
  };
}

function createMemoryCacheEntry(
  nodeId: string,
  input: string,
): ReturnType<typeof createAiCacheEntry> {
  const identity = {
    ...runIdentity,
    inputHash: hashCanonicalJson({ input }),
  } satisfies AiCacheIdentity;
  const output = createSchemaValidOutput(nodeId);
  return createAiCacheEntry({
    cacheKey: createAiCacheKey(identity),
    sourceHash: hashCanonicalJson({ source: input }),
    graphNeighborhoodHash: hashCanonicalJson({ graph: input }),
    repository: {
      repositoryId: "R_cache_budget",
      owner: "VOICEVOX",
      name: "cache-budget",
    },
    nodeId,
    metadata: {
      ...identity,
      outputHash: hashCanonicalJson(output),
      executedAt: fixedExecutedAt,
    },
    output,
  });
}

function createPriority(
  kind: "deferred" | "severity" | "owner" | "blocker" | "impact" | "ordinary",
): AiAnalysisPriority {
  return Object.freeze({
    previouslyDeferred: kind === "deferred",
    severityCandidate: kind === "severity",
    ownerUnknown: kind === "owner",
    changedBlocker: kind === "blocker",
    downstreamImpact: Object.freeze({
      openNodeCount: kind === "impact" ? 100 : 0,
      repositoryCount: kind === "impact" ? 10 : 0,
    }),
  });
}

function createCandidate(options: {
  id: string;
  body: string;
  deterministicResolution: AiAnalysisCandidate["deterministicResolution"];
  previousFingerprint: PreviousAiAnalysisFingerprint;
  priority: AiAnalysisPriority;
  graphVersion: number;
  estimatedCostUsd: number;
}): AiAnalysisCandidate {
  return Object.freeze({
    id: options.id,
    repository: Object.freeze({
      repositoryId: "R_cache_budget",
      owner: "VOICEVOX",
      name: "cache-budget",
    }),
    deterministicResolution: options.deterministicResolution,
    input: createInput(options.id, options.body),
    graphNeighborhood: {
      version: options.graphVersion,
    },
    previousFingerprint: options.previousFingerprint,
    priority: options.priority,
    estimatedCostUsd: options.estimatedCostUsd,
  });
}

function createRelationCandidate(id: string, body: string): AiAnalysisCandidate {
  const candidate = createCandidate({
    id,
    body,
    deterministicResolution: "ambiguous",
    previousFingerprint: unavailablePreviousFingerprint,
    priority: createPriority("ordinary"),
    graphVersion: 1,
    estimatedCostUsd: 0.1,
  });
  return Object.freeze({
    ...candidate,
    input: createInputWithRelation(id, body),
  });
}

function createConfiguration(
  maxCallsPerRun: number,
  maxTotalInputCharactersPerRun: number,
  maxEstimatedCostUsdPerRun: number,
  maxConcurrentCalls: number,
): AiAnalysisRunConfiguration {
  return Object.freeze({
    identity: runIdentity,
    budget: Object.freeze({
      maxCallsPerRun,
      maxInputCharactersPerItem: 100_000,
      maxTotalInputCharactersPerRun,
      maxEstimatedCostUsdPerRun,
    }),
    maxConcurrentCalls,
  });
}

function createOrdinaryCandidates(candidateIds: readonly string[]): readonly AiAnalysisCandidate[] {
  return Object.freeze(
    candidateIds.map((id) =>
      createCandidate({
        id,
        body: id,
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
    ),
  );
}

function prepareAiAnalysisCandidate(candidate: AiAnalysisCandidate): PreparedAiAnalysisCandidate {
  return prepareCandidateWithIdentity(candidate, runIdentity);
}

function runAiAnalyses(
  candidates: readonly AiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  return runPreparedAiAnalyses(
    candidates.map((candidate) => prepareCandidateWithIdentity(candidate, configuration.identity)),
    configuration,
    dependencies,
  );
}

function createExecutorOutput(input: CodexAnalysisInput): SchemaValidCodexAnalysisOutput {
  const source = input.sources.at(0);
  assertNonNullable(source, "Codex分析入力のsourceがありません");
  return {
    schemaVersion: "2",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: "waiting_for_decision",
    waitingOn: [
      {
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
        reasonSummary: "maintainerの判断待ちです",
        sourceIds: [source.id],
        confidence: 0.9,
      },
    ],
    nextAction: "maintainerが方針を決める",
    relations: [],
    progress: {
      latestMeaningfulSourceId: null,
      reasonSummary: "意味のある進捗は確定できません",
      confidence: 0.8,
    },
    importance: {
      significantFeature: false,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "重要度の自然言語要因はありません",
    },
    evidence: [
      {
        sourceId: source.id,
        supports: "status",
        summary: "明確な担当者がいません",
      },
    ],
    confidence: 0.9,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知の必要性を確定できません",
    },
  };
}

function createSemanticInvalidOutput(input: CodexAnalysisInput): SchemaValidCodexAnalysisOutput {
  const output = createExecutorOutput(input);
  return {
    ...output,
    item: {
      ...output.item,
      nodeId: "I_semantic_invalid",
    },
  };
}

function createSemanticInvalidSourceOutput(
  input: CodexAnalysisInput,
): SchemaValidCodexAnalysisOutput {
  const output = createExecutorOutput(input);
  const evidence = output.evidence.at(0);
  assertNonNullable(evidence, "semantic検証fixtureのevidenceがありません");
  return {
    ...output,
    evidence: [
      {
        ...evidence,
        sourceId: "source:semantic-invalid",
      },
    ],
  };
}

function createRelationOutput(
  input: CodexAnalysisInput,
  sourceId: string,
): SchemaValidCodexAnalysisOutput {
  const output = createExecutorOutput(input);
  const relation = input.candidates.relations.at(0);
  assertNonNullable(relation, "semantic検証fixtureのrelation候補がありません");
  return {
    ...output,
    relations: [
      {
        candidateId: relation.id,
        verdict: "none",
        reasonSummary: "関係を確定できません",
        sourceIds: [sourceId],
        confidence: 0.8,
      },
    ],
  };
}

function createExecutor(): Mock<(input: CodexAnalysisInput) => Promise<unknown>> {
  return vi.fn((input: CodexAnalysisInput): Promise<unknown> =>
    Promise.resolve(createExecutorOutput(input)),
  );
}

describe("Codex分析対象の絞り込み", () => {
  it("明確または未変更の項目を呼び出さず、曖昧な変更項目だけを1回呼び出す", async () => {
    const unchangedBase = createCandidate({
      id: "I_unchanged",
      body: "未変更",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const unchangedFingerprint = prepareAiAnalysisCandidate(unchangedBase).fingerprint;
    const candidates = [
      createCandidate({
        id: "I_clear",
        body: "決定論的に確定",
        deterministicResolution: "high_confidence",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
      createCandidate({
        id: "I_unchanged",
        body: "未変更",
        deterministicResolution: "ambiguous",
        previousFingerprint: {
          status: "available",
          fingerprint: unchangedFingerprint,
        },
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
      createCandidate({
        id: "I_changed",
        body: "曖昧な変更",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 2,
        estimatedCostUsd: 0.1,
      }),
    ];
    const cache = new MemoryAiCacheStore();
    const execute = createExecutor();
    const configuration = createConfiguration(10, 1_000_000, 10, 1);
    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };
    await runAiAnalyses([unchangedBase], configuration, dependencies);
    execute.mockClear();

    const result = await runAiAnalyses(candidates, configuration, dependencies);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.results.map((value) => value.candidateId)).toEqual(["I_unchanged", "I_changed"]);
    expect(result.skipped).toEqual([
      {
        candidateId: "I_clear",
        reason: "determined_with_high_confidence",
      },
      {
        candidateId: "I_unchanged",
        reason: "unchanged",
      },
    ]);
  });

  it("未変更fingerprintに対応するcacheがなければCodexを呼ばず例外にする", async () => {
    const base = createCandidate({
      id: "I_uncached_unchanged",
      body: "未変更",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const candidate = createCandidate({
      id: "I_uncached_unchanged",
      body: "未変更",
      deterministicResolution: "ambiguous",
      previousFingerprint: {
        status: "available",
        fingerprint: prepareAiAnalysisCandidate(base).fingerprint,
      },
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const execute = createExecutor();

    await expect(
      runAiAnalyses([candidate], createConfiguration(10, 1_000_000, 10, 1), {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      }),
    ).rejects.toThrow(TypeError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("本文が同じでもグラフ隣接情報が変われば呼び出す", async () => {
    const previous = createCandidate({
      id: "I_graph_changed",
      body: "本文は同じ",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const previousFingerprint = prepareAiAnalysisCandidate(previous).fingerprint;
    const changed = createCandidate({
      id: "I_graph_changed",
      body: "本文は同じ",
      deterministicResolution: "ambiguous",
      previousFingerprint: {
        status: "available",
        fingerprint: previousFingerprint,
      },
      priority: createPriority("ordinary"),
      graphVersion: 2,
      estimatedCostUsd: 0.1,
    });
    const execute = createExecutor();

    const result = await runAiAnalyses([changed], createConfiguration(1, 1_000_000, 1, 1), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.results[0]?.candidateId).toBe("I_graph_changed");
  });

  it("入力とグラフが同じでも実行identityが変われば呼び出す", async () => {
    const base = createCandidate({
      id: "I_identity_changed",
      body: "本文は同じ",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const previousFingerprint = prepareCandidateWithIdentity(base, runIdentity).fingerprint;
    const changedIdentity = Object.freeze({
      ...runIdentity,
      promptVersion: "prompt-v2",
    });
    const configuration = Object.freeze({
      ...createConfiguration(1, 1_000_000, 1, 1),
      identity: changedIdentity,
    });
    const candidate = createCandidate({
      id: "I_identity_changed",
      body: "本文は同じ",
      deterministicResolution: "ambiguous",
      previousFingerprint: {
        status: "available",
        fingerprint: previousFingerprint,
      },
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const currentFingerprint = prepareCandidateWithIdentity(candidate, changedIdentity).fingerprint;
    const execute = createExecutor();

    const result = await runAiAnalyses([candidate], configuration, {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(currentFingerprint.inputHash).toBe(previousFingerprint.inputHash);
    expect(currentFingerprint.graphNeighborhoodHash).toBe(
      previousFingerprint.graphNeighborhoodHash,
    );
    expect(currentFingerprint.identityHash).not.toBe(previousFingerprint.identityHash);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({
      candidateId: "I_identity_changed",
      origin: "executed",
    });
    expect(result.skipped).toEqual([]);
  });
});

describe("content-addressed AI cache", () => {
  it("MemoryAiCacheStoreのnode ID indexを上書き時もcache key順で保持する", async () => {
    const cache = new MemoryAiCacheStore();
    const first = createMemoryCacheEntry("I_memory_index_first", "same-key");
    const second = createMemoryCacheEntry("I_memory_index_second", "same-key");
    const third = createMemoryCacheEntry("I_memory_index_second", "other-key");

    await cache.write(first);
    await cache.write(third);
    await cache.write(second);

    const expectedKeys = [first.cacheKey, third.cacheKey].sort();
    expect(cache.get(first.cacheKey)).toEqual(second);
    expect(cache.entries().map((entry) => entry.cacheKey)).toEqual(expectedKeys);
    expect(cache.entriesForNodeId(first.nodeId)).toEqual([]);
    expect(cache.entriesForNodeId(second.nodeId).map((entry) => entry.cacheKey)).toEqual(
      expectedKeys,
    );
  });

  it("AI cache entryのoutputはstrictなCodex schemaを必須にする", () => {
    const inputHash = hashCanonicalJson({ input: "invalid-output" });
    expect(() =>
      createAiCacheEntry({
        cacheKey: createAiCacheKey({
          deterministicRulesVersion: "rules-v1",
          model: "model-a",
          reasoningEffort: "medium",
          backendVersion: "backend-a",
          promptVersion: "prompt-a",
          schemaVersion: "schema-a",
          inputHash,
        }),
        sourceHash: hashCanonicalJson({ source: "invalid-output" }),
        graphNeighborhoodHash: hashCanonicalJson({ graph: "invalid-output" }),
        repository: {
          repositoryId: "R_cache_budget",
          owner: "VOICEVOX",
          name: "cache-budget",
        },
        nodeId: "I_invalid_output",
        metadata: {
          deterministicRulesVersion: "rules-v1",
          model: "model-a",
          reasoningEffort: "medium",
          backendVersion: "backend-a",
          promptVersion: "prompt-a",
          schemaVersion: "schema-a",
          inputHash,
          outputHash: hashCanonicalJson({ result: "invalid" }),
          executedAt: fixedExecutedAt,
        },
        output: { result: "invalid" },
      }),
    ).toThrow("Codex出力がJSON Schemaに適合しません");
  });

  it("AI cache entryのnode IDとoutput itemのnode ID不一致を拒否する", () => {
    const identity = {
      ...runIdentity,
      inputHash: hashCanonicalJson({ input: "node-mismatch" }),
    } satisfies AiCacheIdentity;
    const output = createSchemaValidOutput("I_cache_output");

    expect(() =>
      createAiCacheEntry({
        cacheKey: createAiCacheKey(identity),
        sourceHash: hashCanonicalJson({ source: "node-mismatch" }),
        graphNeighborhoodHash: hashCanonicalJson({ graph: "node-mismatch" }),
        repository: {
          repositoryId: "R_cache_budget",
          owner: "VOICEVOX",
          name: "cache-budget",
        },
        nodeId: "I_cache_entry",
        metadata: {
          ...identity,
          outputHash: hashCanonicalJson(output),
          executedAt: fixedExecutedAt,
        },
        output,
      }),
    ).toThrow("AI cache entryのnode IDが出力項目と一致しません");
  });

  it("JSONのキー順に依存せず同じhashを生成する", () => {
    const left = {
      nested: {
        second: 2,
        first: 1,
      },
      list: ["a", "b"],
    };
    const right = {
      list: ["a", "b"],
      nested: {
        first: 1,
        second: 2,
      },
    };

    expect(serializeCanonicalJson(left)).toBe(serializeCanonicalJson(right));
    expect(hashCanonicalJson(left)).toBe(hashCanonicalJson(right));
  });

  it("cache keyの構成要素を1つ変えるたびにcache missとなる", async () => {
    const inputHash = hashCanonicalJson({
      body: "本文",
    });
    const otherInputHash = hashCanonicalJson({
      body: "本文変更",
    });
    const base = {
      deterministicRulesVersion: "rules-v1",
      model: "model-a",
      reasoningEffort: "medium",
      backendVersion: "backend-a",
      promptVersion: "prompt-a",
      schemaVersion: "schema-a",
      inputHash,
    } satisfies AiCacheIdentity;
    const cacheKeys = [
      createAiCacheKey(base),
      createAiCacheKey({
        ...base,
        deterministicRulesVersion: "rules-v2",
      }),
      createAiCacheKey({
        ...base,
        model: "model-b",
      }),
      createAiCacheKey({
        ...base,
        reasoningEffort: "high",
      }),
      createAiCacheKey({
        ...base,
        backendVersion: "backend-b",
      }),
      createAiCacheKey({
        ...base,
        promptVersion: "prompt-b",
      }),
      createAiCacheKey({
        ...base,
        schemaVersion: "schema-b",
      }),
      createAiCacheKey({
        ...base,
        inputHash: otherInputHash,
      }),
    ];
    const cache = new MemoryAiCacheStore();
    const baseCacheKey = cacheKeys.at(0);
    assertNonNullable(baseCacheKey, "基準となるAI cache keyがありません");
    const output = createSchemaValidOutput("I_cache_fixture");
    await cache.write(
      createAiCacheEntry({
        cacheKey: baseCacheKey,
        sourceHash: hashCanonicalJson({
          sources: "same",
        }),
        graphNeighborhoodHash: hashCanonicalJson({ graph: "same" }),
        repository: {
          repositoryId: "R_cache_budget",
          owner: "VOICEVOX",
          name: "cache-budget",
        },
        nodeId: "I_cache_fixture",
        metadata: {
          deterministicRulesVersion: base.deterministicRulesVersion,
          model: base.model,
          reasoningEffort: base.reasoningEffort,
          backendVersion: base.backendVersion,
          promptVersion: base.promptVersion,
          schemaVersion: base.schemaVersion,
          inputHash: base.inputHash,
          outputHash: hashCanonicalJson(output),
          executedAt: fixedExecutedAt,
        },
        output,
      }),
    );

    expect(new Set(cacheKeys).size).toBe(cacheKeys.length);
    await expect(cache.read(baseCacheKey)).resolves.toMatchObject({
      status: "hit",
    });
    for (const changedKey of cacheKeys.slice(1)) {
      await expect(cache.read(changedKey)).resolves.toEqual({
        status: "miss",
      });
    }
  });

  it("判定規則versionの空文字を拒否する", () => {
    expect(() =>
      createAiCacheKey({
        deterministicRulesVersion: "",
        model: "model-a",
        reasoningEffort: "medium",
        backendVersion: "backend-a",
        promptVersion: "prompt-a",
        schemaVersion: "schema-a",
        inputHash: hashCanonicalJson({
          body: "本文",
        }),
      }),
    ).toThrow("AI cache identityのdeterministicRulesVersionは空にできません");
  });

  it("metadataの判定規則versionが異なるcache entryを再利用しない", () => {
    const identity = {
      deterministicRulesVersion: "rules-v1",
      model: "model-a",
      reasoningEffort: "medium",
      backendVersion: "backend-a",
      promptVersion: "prompt-a",
      schemaVersion: "schema-a",
      inputHash: hashCanonicalJson({
        body: "本文",
      }),
    } satisfies AiCacheIdentity;
    const sourceHash = hashCanonicalJson({
      sources: "same",
    });
    const output = createSchemaValidOutput("I_cache_fixture");
    const entry = createAiCacheEntry({
      cacheKey: createAiCacheKey(identity),
      sourceHash,
      graphNeighborhoodHash: hashCanonicalJson({ graph: "same" }),
      repository: {
        repositoryId: "R_cache_budget",
        owner: "VOICEVOX",
        name: "cache-budget",
      },
      nodeId: "I_cache_fixture",
      metadata: {
        ...identity,
        outputHash: hashCanonicalJson(output),
        executedAt: fixedExecutedAt,
      },
      output,
    });
    const versionChangedEntry = Object.freeze({
      ...entry,
      metadata: Object.freeze({
        ...entry.metadata,
        deterministicRulesVersion: "rules-v2",
      }),
    });

    expect(determineAiCacheReuse(versionChangedEntry, identity, sourceHash)).toEqual({
      status: "stale",
      reason: "deterministic_rules_version_changed",
    });
  });

  it("run開始時刻だけが異なる同一入力はcacheから再利用する", async () => {
    const cache = new MemoryAiCacheStore();
    const execute = createExecutor();
    const firstCandidate = createCandidate({
      id: "I_cache_across_runs",
      body: "同一入力",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const secondCandidate = Object.freeze({
      ...firstCandidate,
      input: createInputAt("I_cache_across_runs", "同一入力", "2026-07-31T23:00:00Z"),
      previousFingerprint: Object.freeze({
        status: "available",
        fingerprint: prepareAiAnalysisCandidate(firstCandidate).fingerprint,
      }),
    });
    const configuration = createConfiguration(10, 1_000_000, 10, 1);
    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };

    const first = await runAiAnalyses([firstCandidate], configuration, dependencies);
    const second = await runAiAnalyses([secondCandidate], configuration, dependencies);

    expect(prepareAiAnalysisCandidate(secondCandidate).fingerprint.inputHash).toBe(
      prepareAiAnalysisCandidate(firstCandidate).fingerprint.inputHash,
    );
    expect(first.results[0]?.origin).toBe("executed");
    expect(second.results[0]?.origin).toBe("cache");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("prepared candidateとrepositoryが異なるcache entryを再利用しない", async () => {
    const candidate = createCandidate({
      id: "I_cache_repository_mismatch",
      body: "同一入力",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const configuration = createConfiguration(10, 1_000_000, 10, 1);
    const seedCache = new MemoryAiCacheStore();
    await runAiAnalyses([candidate], configuration, {
      cache: seedCache,
      execute: createExecutor(),
      executedAt: () => fixedExecutedAt,
    });
    const entry = seedCache.entries()[0];
    assertNonNullable(entry, "repository不一致fixtureのAI cache entryがありません");
    const mismatchedEntry = createAiCacheEntry({
      ...entry,
      repository: {
        repositoryId: "R_other_cache_budget",
        owner: "VOICEVOX",
        name: "other-cache-budget",
      },
    });
    const cache = new MemoryAiCacheStore();
    await cache.write(mismatchedEntry);

    await expect(
      runAiAnalyses([candidate], configuration, {
        cache,
        execute: createExecutor(),
        executedAt: () => fixedExecutedAt,
      }),
    ).rejects.toThrow("AI cache entryの項目またはrepositoryが分析候補と一致しません");
  });

  it("同一入力はcacheから再利用し、本文1文字の変更後は旧結果を使わない", async () => {
    const cache = new MemoryAiCacheStore();
    const execute = createExecutor();
    const original = createCandidate({
      id: "I_cache",
      body: "本文",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const configuration = createConfiguration(10, 1_000_000, 10, 1);
    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };

    const first = await runAiAnalyses([original], configuration, dependencies);
    const cached = await runAiAnalyses([original], configuration, dependencies);
    const firstResult = first.results.at(0);
    assertNonNullable(firstResult, "初回のAI分析結果がありません");
    const changed = await runAiAnalyses(
      [
        createCandidate({
          id: "I_cache",
          body: "本文!",
          deterministicResolution: "ambiguous",
          previousFingerprint: {
            status: "available",
            fingerprint: firstResult.fingerprint,
          },
          priority: createPriority("ordinary"),
          graphVersion: 1,
          estimatedCostUsd: 0.1,
        }),
      ],
      configuration,
      dependencies,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(first.results[0]?.origin).toBe("executed");
    expect(cached.results[0]?.origin).toBe("cache");
    expect(changed.results[0]?.origin).toBe("executed");
    expect(changed.results[0]?.metadata.inputHash).not.toBe(first.results[0]?.metadata.inputHash);
  });

  it("本文変更後に予算がなければ旧結果を返さずdeferredにする", async () => {
    const cache = new MemoryAiCacheStore();
    const execute = createExecutor();
    const original = createCandidate({
      id: "I_stale_deferred",
      body: "変更前",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const first = await runAiAnalyses([original], createConfiguration(1, 1_000_000, 1, 1), {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    });
    const firstResult = first.results.at(0);
    assertNonNullable(firstResult, "変更前のAI分析結果がありません");
    const changed = createCandidate({
      id: "I_stale_deferred",
      body: "変更後",
      deterministicResolution: "ambiguous",
      previousFingerprint: {
        status: "available",
        fingerprint: firstResult.fingerprint,
      },
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });

    const deferred = await runAiAnalyses([changed], createConfiguration(0, 1_000_000, 1, 1), {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(deferred.results).toEqual([]);
    expect(deferred.deferred).toEqual([
      {
        candidateId: "I_stale_deferred",
        reason: "call_limit",
      },
    ]);
  });

  it("state.aiCacheDirectory相当のディレクトリへcacheを保存して読み戻す", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "voicevox-ai-cache-test-"));
    try {
      const cacheDirectory = join(temporaryDirectory, "state", "ai-cache");
      const cache = createFileAiCacheStore({
        aiCacheDirectory: cacheDirectory,
      });
      const execute = createExecutor();
      const candidate = createCandidate({
        id: "I_file_cache",
        body: "ファイルcache",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      });
      const configuration = createConfiguration(10, 1_000_000, 10, 1);
      const dependencies = {
        cache,
        execute,
        executedAt: () => fixedExecutedAt,
      };

      const first = await runAiAnalyses([candidate], configuration, dependencies);
      const second = await runAiAnalyses([candidate], configuration, dependencies);

      expect(first.results[0]?.origin).toBe("executed");
      expect(second.results[0]?.origin).toBe("cache");
      expect(second.results[0]?.cacheKey).toBe(first.results[0]?.cacheKey);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await readdir(cacheDirectory)).toHaveLength(1);
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("AI run予算", () => {
  it("UTF-8入力byte数とtoken単価から0ではない費用を見積もる", () => {
    expect(estimateAiInputCost("abcd", 2)).toEqual({
      estimatedInputTokens: 1,
      estimatedCostUsd: 0.000002,
    });
    expect(estimateAiInputCost("あいうえ", 1)).toEqual({
      estimatedInputTokens: 3,
      estimatedCostUsd: 0.000003,
    });
  });

  it("新しい高優先候補を前回延期された低優先候補より先に選ぶ", async () => {
    const candidates = [
      createCandidate({
        id: "new-severity",
        body: "新しい高優先候補",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("severity"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
      createCandidate({
        id: "previously-deferred",
        body: "前回延期された候補",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("deferred"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
    ];
    const execute = createExecutor();

    const result = await runAiAnalyses(candidates, createConfiguration(1, 1_000_000, 10, 1), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(result.results.map((value) => value.candidateId)).toEqual(["new-severity"]);
    expect(result.deferred).toEqual([
      {
        candidateId: "previously-deferred",
        reason: "call_limit",
      },
    ]);
  });

  it("ほかの優先条件が同じなら前回延期された候補をnode ID順より先に選ぶ", async () => {
    const candidates = [
      createCandidate({
        id: "a-new",
        body: "新しい同順位候補",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
      createCandidate({
        id: "z-deferred",
        body: "前回延期された同順位候補",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("deferred"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
    ];
    const execute = createExecutor();

    const result = await runAiAnalyses(candidates, createConfiguration(1, 1_000_000, 10, 1), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(result.results.map((value) => value.candidateId)).toEqual(["z-deferred"]);
    expect(result.deferred).toEqual([
      {
        candidateId: "a-new",
        reason: "call_limit",
      },
    ]);
  });

  it("10候補で上限3回なら優先順位どおり3件を分析して残りをdeferredにする", async () => {
    const priorities: readonly (readonly [
      string,
      "severity" | "owner" | "blocker" | "impact" | "ordinary",
    ])[] = [
      ["severity", "severity"],
      ["owner", "owner"],
      ["blocker", "blocker"],
      ["impact", "impact"],
      ["ordinary-1", "ordinary"],
      ["ordinary-2", "ordinary"],
      ["ordinary-3", "ordinary"],
      ["ordinary-4", "ordinary"],
      ["ordinary-5", "ordinary"],
      ["ordinary-6", "ordinary"],
    ];
    const candidates = priorities.map(([id, priority]) =>
      createCandidate({
        id,
        body: id,
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority(priority),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
    );
    const execute = createExecutor();

    const result = await runAiAnalyses(candidates, createConfiguration(3, 1_000_000, 10, 1), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(result.results.map((value) => value.candidateId)).toEqual([
      "severity",
      "owner",
      "blocker",
    ]);
    expect(execute.mock.calls.map(([input]) => input.item.nodeId)).toEqual([
      "severity",
      "owner",
      "blocker",
    ]);
    expect(result.deferred).toHaveLength(7);
    expect(result.deferred.map((value) => value.candidateId)).toEqual([
      "impact",
      "ordinary-1",
      "ordinary-2",
      "ordinary-3",
      "ordinary-4",
      "ordinary-5",
      "ordinary-6",
    ]);
    expect(result.deferred.every((value) => value.reason === "call_limit")).toBe(true);
    expect(result.usage.calls).toBe(3);
  });

  it("見積費用の上限に達したら追加呼び出しを停止する", async () => {
    const first = createCandidate({
      id: "cost-1",
      body: "費用1",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const second = createCandidate({
      id: "cost-2",
      body: "費用2",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.2,
    });
    const third = createCandidate({
      id: "cost-3",
      body: "費用3",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const execute = createExecutor();

    const result = await runAiAnalyses(
      [first, second, third],
      createConfiguration(10, 1_000_000, 0.3, 1),
      {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.deferred).toEqual([
      {
        candidateId: "cost-3",
        reason: "estimated_cost_limit",
      },
    ]);
    expect(result.usage.estimatedCostUsd).toBe(0.3);
  });

  it("runの入力文字数上限に達したら残りをdeferredにする", async () => {
    const first = createCandidate({
      id: "chars-1",
      body: "同じ長さ",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const second = createCandidate({
      id: "chars-2",
      body: "同じ長さ",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const firstInputCharacters = prepareAiAnalysisCandidate(first).inputCharacters;
    const execute = createExecutor();

    const result = await runAiAnalyses(
      [first, second],
      createConfiguration(10, firstInputCharacters, 10, 1),
      {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.results[0]?.candidateId).toBe("chars-1");
    expect(result.deferred).toEqual([
      {
        candidateId: "chars-2",
        reason: "total_input_character_limit",
      },
    ]);
    expect(result.usage.inputCharacters).toBe(firstInputCharacters);
  });
});

describe("AI runの並列実行", () => {
  it("同時実行数がmaxConcurrentCallsを超えない", async () => {
    const candidateIds = [
      "concurrency-1",
      "concurrency-2",
      "concurrency-3",
      "concurrency-4",
      "concurrency-5",
      "concurrency-6",
    ];
    const releaseExecutions = Promise.withResolvers<"release">();
    const concurrencyLimitReached = Promise.withResolvers<"reached">();
    let activeCalls = 0;
    let peakActiveCalls = 0;
    const execute = vi.fn(async (input: CodexAnalysisInput): Promise<unknown> => {
      activeCalls += 1;
      peakActiveCalls = Math.max(peakActiveCalls, activeCalls);
      if (activeCalls === 3) {
        concurrencyLimitReached.resolve("reached");
      }
      try {
        await releaseExecutions.promise;
        return createExecutorOutput(input);
      } finally {
        activeCalls -= 1;
      }
    });

    const run = runAiAnalyses(
      createOrdinaryCandidates(candidateIds),
      createConfiguration(candidateIds.length, 1_000_000, 10, 3),
      {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      },
    );
    await concurrencyLimitReached.promise;
    releaseExecutions.resolve("release");
    const result = await run;

    expect(result.results.map((value) => value.candidateId)).toEqual(candidateIds);
    expect(peakActiveCalls).toBe(3);
    expect(activeCalls).toBe(0);
  });

  it("逆順に完了してもresultsとfailuresを予算計画順で返す", async () => {
    const candidateIds = ["order-1", "order-2", "order-3", "order-4"];
    const failedCandidateIds = new Set(["order-1", "order-3"]);
    const allCallsStarted = Promise.withResolvers<"started">();
    const completionOrder: string[] = [];
    let startedCalls = 0;
    const execute = vi.fn(async (input: CodexAnalysisInput): Promise<unknown> => {
      const candidateIndex = candidateIds.indexOf(input.item.nodeId);
      if (candidateIndex < 0) {
        throw new TypeError(`投入順に存在しない候補です。対象: ${input.item.nodeId}`);
      }
      startedCalls += 1;
      if (startedCalls === candidateIds.length) {
        allCallsStarted.resolve("started");
      }
      await allCallsStarted.promise;
      for (
        let remainingYields = candidateIds.length - candidateIndex - 1;
        remainingYields > 0;
        remainingYields -= 1
      ) {
        await Promise.resolve();
      }
      completionOrder.push(input.item.nodeId);
      if (failedCandidateIds.has(input.item.nodeId)) {
        throw new HttpFixtureError(500);
      }
      return createExecutorOutput(input);
    });

    const result = await runAiAnalyses(
      createOrdinaryCandidates(candidateIds),
      createConfiguration(candidateIds.length, 1_000_000, 10, candidateIds.length),
      {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      },
    );

    expect(completionOrder).toEqual(["order-4", "order-3", "order-2", "order-1"]);
    expect(result.results.map((value) => value.candidateId)).toEqual(["order-2", "order-4"]);
    expect(result.failures.map((value) => value.candidateId)).toEqual(["order-1", "order-3"]);
  });

  it("maxConcurrentCallsが1なら予算計画順の逐次実行と同じ結果になる", async () => {
    const candidateIds = ["sequential-3", "sequential-1", "sequential-2"];
    const candidates = createOrdinaryCandidates(candidateIds);
    const sequentialExecute = createExecutor();
    const concurrentExecute = createExecutor();

    const sequential = await runAiAnalyses(
      candidates,
      createConfiguration(candidateIds.length, 1_000_000, 10, 1),
      {
        cache: new MemoryAiCacheStore(),
        execute: sequentialExecute,
        executedAt: () => fixedExecutedAt,
      },
    );
    const concurrent = await runAiAnalyses(
      candidates,
      createConfiguration(candidateIds.length, 1_000_000, 10, candidateIds.length),
      {
        cache: new MemoryAiCacheStore(),
        execute: concurrentExecute,
        executedAt: () => fixedExecutedAt,
      },
    );

    expect(sequentialExecute.mock.calls.map(([input]) => input.item.nodeId)).toEqual([
      "sequential-1",
      "sequential-2",
      "sequential-3",
    ]);
    expect(sequential).toEqual(concurrent);
  });

  it("worker例外後は新しい候補を始めず実行中workerを待って最小添字の例外を投げる", async () => {
    const candidateIds = ["worker-error-1", "worker-error-2", "worker-error-3"];
    const firstWorkerError = new TypeError("worker 0のcache書き込み失敗");
    const secondWorkerError = new RangeError("worker 1のcache書き込み失敗");
    const workerErrors = [firstWorkerError, secondWorkerError];
    const allWritesStarted = Promise.withResolvers<"started">();
    const memoryCache = new MemoryAiCacheStore();
    let startedWrites = 0;
    let completedWrites = 0;
    const cache: AiAnalysisRunDependencies["cache"] = Object.freeze({
      read: (cacheKey) => memoryCache.read(cacheKey),
      write: async (): Promise<void> => {
        const workerError = workerErrors.at(startedWrites);
        assertNonNullable(workerError, "実行workerに対応するcache書き込みエラーがありません");
        startedWrites += 1;
        if (startedWrites === workerErrors.length) {
          allWritesStarted.resolve("started");
        }
        await allWritesStarted.promise;
        completedWrites += 1;
        throw workerError;
      },
    });
    const execute = createExecutor();

    await expect(
      runAiAnalyses(
        createOrdinaryCandidates(candidateIds),
        createConfiguration(candidateIds.length, 1_000_000, 10, workerErrors.length),
        {
          cache,
          execute,
          executedAt: () => fixedExecutedAt,
        },
      ),
    ).rejects.toBe(firstWorkerError);

    expect(execute.mock.calls.map(([input]) => input.item.nodeId)).toEqual([
      "worker-error-1",
      "worker-error-2",
    ]);
    expect(completedWrites).toBe(2);
  });
});

describe("AI runの候補単位fallback", () => {
  it("Codex 500相当の候補があっても他の候補を検証してrunを続ける", async () => {
    const failed = createCandidate({
      id: "I_failed",
      body: "service unavailable",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const succeeded = createCandidate({
      id: "I_succeeded",
      body: "正常",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> => {
      if (input.item.nodeId === "I_failed") {
        return Promise.reject(new HttpFixtureError(500));
      }
      return Promise.resolve(createExecutorOutput(input));
    });

    const result = await runAiAnalyses(
      [failed, succeeded],
      createConfiguration(2, 1_000_000, 1, 1),
      {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.results.map((value) => value.candidateId)).toEqual(["I_succeeded"]);
    expect(result.failures).toEqual([
      {
        candidateId: "I_failed",
        reason: "service_unavailable",
        errorType: "HttpFixtureError",
      },
    ]);
  });

  it("semantic検証失敗だけを1回再試行し、成功した結果を保存する", async () => {
    const candidate = createCandidate({
      id: "I_semantic_retry",
      body: "semantic検証を再試行する",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const cache = new MemoryAiCacheStore();
    let executionCount = 0;
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> => {
      executionCount += 1;
      return Promise.resolve(
        executionCount === 1 ? createSemanticInvalidOutput(input) : createExecutorOutput(input),
      );
    });

    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };
    const result = await runAiAnalyses(
      [candidate],
      createConfiguration(2, 1_000_000, 1, 1),
      dependencies,
    );
    const cachedResult = await runAiAnalyses(
      [candidate],
      createConfiguration(2, 1_000_000, 1, 1),
      dependencies,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual({
      calls: 2,
      inputCharacters: prepareAiAnalysisCandidate(candidate).inputCharacters * 2,
      estimatedCostUsd: 0.2,
    });
    expect(result.results.map((value) => value.candidateId)).toEqual(["I_semantic_retry"]);
    expect(result.failures).toEqual([]);
    expect(cachedResult.results.map((value) => value.origin)).toEqual(["cache"]);
    expect(cachedResult.usage).toEqual({
      calls: 0,
      inputCharacters: 0,
      estimatedCostUsd: 0,
    });
  });

  it("micro USDの境界で初回費用を正確に記録し、再試行を拒否する", async () => {
    const candidate = createCandidate({
      id: "I_semantic_retry_cost_boundary",
      body: "micro USDの境界を検証する",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.000249,
    });
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> =>
      Promise.resolve(createSemanticInvalidOutput(input)),
    );

    const result = await runAiAnalyses(
      [candidate],
      createConfiguration(2, 1_000_000, 0.000497, 1),
      {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({
      calls: 1,
      inputCharacters: prepareAiAnalysisCandidate(candidate).inputCharacters,
      estimatedCostUsd: 0.000249,
    });
    expect(result.failures).toHaveLength(1);
  });

  it("項目別入力上限を超える初期候補をdeferred理由付きで拒否する", () => {
    const candidate = createCandidate({
      id: "I_initial_item_limit",
      body: "初期候補の項目別入力上限を検証する",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const prepared = prepareAiAnalysisCandidate(candidate);

    expect(() =>
      createAiBudgetReservationController(
        {
          maxCallsPerRun: 1,
          maxInputCharactersPerItem: prepared.inputCharacters - 1,
          maxTotalInputCharactersPerRun: 1_000_000,
          maxEstimatedCostUsdPerRun: 1,
        },
        [prepared],
      ),
    ).toThrow("item_input_character_limit");
  });

  it("未知のrelation source IDを含むsemantic失敗を再試行し、関係結果を保存する", async () => {
    const candidate = createRelationCandidate(
      "I_semantic_relation_retry",
      "relationのsemantic検証を再試行する",
    );
    const execute = vi
      .fn<(input: CodexAnalysisInput) => Promise<unknown>>()
      .mockImplementationOnce((input) =>
        Promise.resolve(createRelationOutput(input, "source:semantic-invalid")),
      )
      .mockImplementationOnce((input) =>
        Promise.resolve(createRelationOutput(input, "body:current")),
      );
    const cache = new MemoryAiCacheStore();
    const configuration = createConfiguration(2, 1_000_000, 1, 1);
    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };

    const result = await runAiAnalyses([candidate], configuration, dependencies);
    const cachedResult = await runAiAnalyses([candidate], configuration, dependencies);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.output.relations[0]?.sourceIds).toEqual(["body:current"]);
    expect(result.usage.calls).toBe(2);
    expect(cachedResult.results[0]?.origin).toBe("cache");
    expect(cachedResult.usage.calls).toBe(0);
  });

  it("2回ともsemantic検証に失敗した場合は2回目の失敗へ縮退する", async () => {
    const candidate = createCandidate({
      id: "I_semantic_failed",
      body: "semantic検証に2回失敗する",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    let executionCount = 0;
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> => {
      executionCount += 1;
      return Promise.resolve(
        executionCount === 1
          ? createSemanticInvalidOutput(input)
          : createSemanticInvalidSourceOutput(input),
      );
    });

    const cache = new MemoryAiCacheStore();
    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };
    const configuration = createConfiguration(2, 1_000_000, 1, 1);
    const result = await runAiAnalyses([candidate], configuration, dependencies);
    const second = await runAiAnalyses([candidate], configuration, dependencies);

    expect(execute).toHaveBeenCalledTimes(4);
    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([
      {
        candidateId: "I_semantic_failed",
        reason: "semantic_validation_failed",
        errorType: "CodexOutputSemanticValidationError",
        validationDiagnostic: {
          issueCount: 1,
          issues: [
            {
              path: "/evidence/0/sourceId",
              code: "unknown_source_id_absent_from_input",
            },
          ],
        },
      },
    ]);
    expect(result.usage).toEqual({
      calls: 2,
      inputCharacters: prepareAiAnalysisCandidate(candidate).inputCharacters * 2,
      estimatedCostUsd: 0.2,
    });
    expect(second.results).toEqual([]);
    expect(second.failures).toEqual(result.failures);
    expect(second.usage).toEqual(result.usage);
  });

  it("初回semantic検証失敗後の通常transport失敗は2回目の失敗へ縮退する", async () => {
    const candidate = createCandidate({
      id: "I_semantic_transport_failed",
      body: "semantic後のtransport失敗",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    let executionCount = 0;
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> => {
      executionCount += 1;
      if (executionCount === 1) {
        return Promise.resolve(createSemanticInvalidOutput(input));
      }
      return Promise.reject(new HttpFixtureError(503));
    });

    const result = await runAiAnalyses([candidate], createConfiguration(2, 1_000_000, 1, 1), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([
      {
        candidateId: "I_semantic_transport_failed",
        reason: "service_unavailable",
        errorType: "HttpFixtureError",
      },
    ]);
    expect(result.usage.calls).toBe(2);
  });

  it("CodexTransportAliasErrorはsemantic再試行後も呼び出し側へ伝播する", async () => {
    const candidate = createCandidate({
      id: "I_semantic_alias_failed",
      body: "semantic後のalias失敗",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    let executionCount = 0;
    const aliasError = new CodexTransportAliasError("restore", {
      cause: new Error("alias fixture"),
    });
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> => {
      executionCount += 1;
      if (executionCount === 1) {
        return Promise.resolve(createSemanticInvalidOutput(input));
      }
      return Promise.reject(aliasError);
    });

    await expect(
      runAiAnalyses([candidate], createConfiguration(2, 1_000_000, 1, 1), {
        cache: new MemoryAiCacheStore(),
        execute,
        executedAt: () => fixedExecutedAt,
      }),
    ).rejects.toBe(aliasError);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "call上限",
      maxCallsPerRun: 1,
      maxTotalInputCharactersPerRun: 1_000_000,
      maxEstimatedCostUsdPerRun: 1,
    },
    {
      name: "入力文字数上限",
      maxCallsPerRun: 2,
      maxTotalInputCharactersPerRun: 1,
      maxEstimatedCostUsdPerRun: 1,
    },
    {
      name: "費用上限",
      maxCallsPerRun: 2,
      maxTotalInputCharactersPerRun: 1_000_000,
      maxEstimatedCostUsdPerRun: 0.1,
    },
  ])(
    "予算の余力がない場合はsemantic再試行しない $name",
    async ({ maxCallsPerRun, maxTotalInputCharactersPerRun, maxEstimatedCostUsdPerRun }) => {
      const candidate = createCandidate({
        id: `I_semantic_budget_${maxCallsPerRun.toString()}_${maxEstimatedCostUsdPerRun.toString()}`,
        body: "semantic再試行の予算不足",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      });
      const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> =>
        Promise.resolve(createSemanticInvalidOutput(input)),
      );
      const prepared = prepareAiAnalysisCandidate(candidate);
      const totalInputLimit =
        maxTotalInputCharactersPerRun === 1
          ? prepared.inputCharacters
          : maxTotalInputCharactersPerRun;
      const result = await runAiAnalyses(
        [candidate],
        createConfiguration(maxCallsPerRun, totalInputLimit, maxEstimatedCostUsdPerRun, 1),
        {
          cache: new MemoryAiCacheStore(),
          execute,
          executedAt: () => fixedExecutedAt,
        },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.results).toEqual([]);
      expect(result.failures[0]?.reason).toBe("semantic_validation_failed");
      expect(result.usage).toEqual({
        calls: 1,
        inputCharacters: prepared.inputCharacters,
        estimatedCostUsd: 0.1,
      });
    },
  );

  it("並列workerのsemantic再試行は共有予算を超えない", async () => {
    const candidates = [
      createRelationCandidate("I_semantic_concurrent_1", "並列semantic失敗1"),
      createRelationCandidate("I_semantic_concurrent_2", "並列semantic失敗2"),
    ];
    const execute = vi.fn(
      (input: CodexAnalysisInput): Promise<unknown> =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(createRelationOutput(input, "source:semantic-invalid"));
          }, 0);
        }),
    );

    const result = await runAiAnalyses(candidates, createConfiguration(3, 1_000_000, 1, 2), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.usage.calls).toBe(3);
    expect(result.failures).toHaveLength(2);
  });

  it("schema検証失敗は追加再試行しない", async () => {
    const candidate = createCandidate({
      id: "I_schema_failed",
      body: "schema検証に失敗する",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> =>
      Promise.resolve({
        ...createExecutorOutput(input),
        extra: true,
      }),
    );

    const result = await runAiAnalyses([candidate], createConfiguration(1, 1_000_000, 1, 1), {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([]);
    expect(result.failures).toEqual([
      {
        candidateId: "I_schema_failed",
        reason: "schema_validation_failed",
        errorType: "CodexOutputSchemaValidationError",
        validationDiagnostic: {
          issueCount: 1,
          issues: [
            {
              path: "$",
              code: "additionalProperties",
            },
          ],
        },
      },
    ]);
    expect(result.usage).toEqual({
      calls: 1,
      inputCharacters: prepareAiAnalysisCandidate(candidate).inputCharacters,
      estimatedCostUsd: 0.1,
    });
  });

  it("schema不適合出力をcacheへ保存しない", async () => {
    const candidate = createCandidate({
      id: "I_invalid_schema",
      body: "schema不適合",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const cache = new MemoryAiCacheStore();
    const execute = vi.fn((input: CodexAnalysisInput): Promise<unknown> =>
      Promise.resolve({
        ...createExecutorOutput(input),
        extra: true,
      }),
    );
    const dependencies = {
      cache,
      execute,
      executedAt: () => fixedExecutedAt,
    };

    const first = await runAiAnalyses(
      [candidate],
      createConfiguration(1, 1_000_000, 1, 1),
      dependencies,
    );
    const second = await runAiAnalyses(
      [candidate],
      createConfiguration(1, 1_000_000, 1, 1),
      dependencies,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(first.results).toEqual([]);
    expect(second.results).toEqual([]);
    const expectedFailure = {
      candidateId: "I_invalid_schema",
      reason: "schema_validation_failed",
      errorType: "CodexOutputSchemaValidationError",
      validationDiagnostic: {
        issueCount: 1,
        issues: [
          {
            path: "$",
            code: "additionalProperties",
          },
        ],
      },
    };
    expect(first.failures).toEqual([expectedFailure]);
    expect(second.failures).toEqual([expectedFailure]);
  });
});

describe("AI結果の再現metadata", () => {
  it("任意の結果からmodel、reasoning effort、backend、prompt、schema、入出力hash、実行時刻を取得できる", async () => {
    const candidate = createCandidate({
      id: "I_metadata",
      body: "再現metadata",
      deterministicResolution: "ambiguous",
      previousFingerprint: unavailablePreviousFingerprint,
      priority: createPriority("ordinary"),
      graphVersion: 1,
      estimatedCostUsd: 0.1,
    });
    const result = await runAiAnalyses([candidate], createConfiguration(1, 1_000_000, 1, 1), {
      cache: new MemoryAiCacheStore(),
      execute: createExecutor(),
      executedAt: () => fixedExecutedAt,
    });
    const item = result.results.at(0);
    assertNonNullable(item, "再現metadataを持つAI分析結果がありません");

    expect(item.metadata).toEqual({
      deterministicRulesVersion: "rules-v1",
      model: "codex-model",
      reasoningEffort: "medium",
      backendVersion: "codex-cli-1.2.3",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      inputHash: item.fingerprint.inputHash,
      outputHash: hashCanonicalJson(item.output),
      executedAt: fixedExecutedAt,
    });
  });
});

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MemoryAiCacheStore,
  createAiCacheEntry,
  createAiCacheKey,
  createCodexAnalysisInput,
  createFileAiCacheStore,
  determineAiCacheReuse,
  determinePreviousAiResultReuse,
  estimateAiInputCost,
  hashCanonicalJson,
  prepareAiAnalysisCandidate as prepareCandidateWithIdentity,
  runAiAnalyses as runPreparedAiAnalyses,
  serializeCanonicalJson,
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
} from "../src/codex/index.js";
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
      authorCandidateId: "user:author",
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

function createPriority(
  kind: "severity" | "owner" | "blocker" | "impact" | "ordinary",
): AiAnalysisPriority {
  return Object.freeze({
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

function createExecutorOutput(input: CodexAnalysisInput) {
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

function createExecutor() {
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
    const output = {
      result: "cached",
    };
    await cache.write(
      createAiCacheEntry({
        cacheKey: baseCacheKey,
        sourceHash: hashCanonicalJson({
          sources: "same",
        }),
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
    const output = {
      result: "cached",
    };
    const entry = createAiCacheEntry({
      cacheKey: createAiCacheKey(identity),
      sourceHash,
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

  it("sourceと入力hashが一致する前回結果だけを再利用する", () => {
    const original = prepareAiAnalysisCandidate(
      createCandidate({
        id: "I_previous",
        body: "本文",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
    );
    const changed = prepareAiAnalysisCandidate(
      createCandidate({
        id: "I_previous",
        body: "本文!",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 1,
        estimatedCostUsd: 0.1,
      }),
    );
    const graphChanged = prepareAiAnalysisCandidate(
      createCandidate({
        id: "I_previous",
        body: "本文",
        deterministicResolution: "ambiguous",
        previousFingerprint: unavailablePreviousFingerprint,
        priority: createPriority("ordinary"),
        graphVersion: 2,
        estimatedCostUsd: 0.1,
      }),
    );

    expect(
      determinePreviousAiResultReuse(original.fingerprint, original.fingerprint, {
        status: "再利用可能",
      }),
    ).toEqual({
      status: "reusable",
      result: {
        status: "再利用可能",
      },
    });

    expect(
      determinePreviousAiResultReuse(changed.fingerprint, original.fingerprint, {
        status: "古い断定",
      }),
    ).toEqual({
      status: "stale",
      reason: "source_hash_changed",
    });
    expect(
      determinePreviousAiResultReuse(graphChanged.fingerprint, original.fingerprint, {
        status: "古い断定",
      }),
    ).toEqual({
      status: "stale",
      reason: "input_hash_changed",
    });
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

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createAiCacheEntry,
  createAiCacheKey,
  createCodexAnalysisInput,
  hashCanonicalJson,
  prepareAiAnalysisCandidate,
  runAiAnalyses,
  type AiAnalysisPreflight,
  type AiAnalysisRunConfiguration,
  type AiCacheIdentity,
  type AiCacheStore,
  type AiRunBudget,
  type PreparedAiAnalysisCandidate,
} from "./index.js";

const identity = {
  deterministicRulesVersion: "rules-1",
  model: "test-model",
  reasoningEffort: "none",
  backendVersion: "codex-0.145.0",
  promptVersion: "prompt-1",
  schemaVersion: "schema-1",
} as const;

function createInput(candidateId: string) {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: "2026-09-01T00:00:00.000Z",
    item: {
      nodeId: candidateId,
      url: `https://github.com/VOICEVOX/repository/issues/${candidateId.length.toString()}`,
      type: "issue",
      title: `test issue ${candidateId}`,
    },
    candidates: {
      waitingOn: [],
      relations: [],
    },
    sources: [
      {
        id: `comment:${candidateId}`,
        kind: "comment",
        actorType: "human",
        createdAt: "2026-08-31T00:00:00.000Z",
      },
    ],
    deterministicSignals: {},
    priorAnalysis: null,
  });
}

function createOutput(input: ReturnType<typeof createInput>) {
  const sourceId = input.sources[0]?.id;
  assert.ok(sourceId);
  return {
    schemaVersion: "4",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: "terminal_completed",
    waitingOn: [],
    nextAction: "完了を確認する",
    relations: [],
    progress: {
      latestMeaningfulSourceId: sourceId,
      reasonSummary: "完了しています",
      confidence: 0.9,
    },
    importance: {
      significantFeature: false,
      futureRisk: false,
      rationale: "重要な懸念はありません",
    },
    deadline: {
      date: null,
      rationale: "期限の指定はありません",
    },
    evidence: [
      {
        sourceId,
        supports: "status",
        summary: "完了を示す記録があります",
      },
    ],
    confidence: 0.9,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知は不要です",
    },
  };
}

function createCandidate(
  candidateId: string,
  estimatedCostUsd: number,
): PreparedAiAnalysisCandidate {
  return prepareAiAnalysisCandidate(
    {
      id: candidateId,
      deterministicResolution: "ambiguous",
      input: createInput(candidateId),
      graphNeighborhood: [],
      previousFingerprint: {
        status: "unavailable",
      },
      priority: {
        previouslyDeferred: false,
        severityCandidate: false,
        ownerUnknown: false,
        changedBlocker: false,
        downstreamImpact: {
          openNodeCount: 0,
          repositoryCount: 0,
        },
      },
      estimatedCostUsd,
    },
    identity,
  );
}

function createBudget(
  maxCallsPerRun: number,
  maxInputCharactersPerItem: number,
  maxTotalInputCharactersPerRun: number,
  maxEstimatedCostUsdPerRun: number,
): AiRunBudget {
  return {
    maxCallsPerRun,
    maxInputCharactersPerItem,
    maxTotalInputCharactersPerRun,
    maxEstimatedCostUsdPerRun,
  };
}

function createConfiguration(budget: AiRunBudget, maxConcurrentCalls: number) {
  return {
    identity,
    budget,
    maxConcurrentCalls,
  } satisfies AiAnalysisRunConfiguration;
}

function createMissCache(): AiCacheStore {
  return {
    read: () => Promise.resolve({ status: "miss" }),
    write: () => Promise.resolve(),
  };
}

function createPreflight(
  inputCharacters: number,
  estimatedCostUsd: number,
  execute: () => Promise<void>,
): AiAnalysisPreflight {
  return {
    inputCharacters,
    estimatedCostUsd,
    execute,
  };
}

function createDependencies(
  execute: (input: ReturnType<typeof createInput>) => Promise<unknown>,
  cache: AiCacheStore,
  preflight?: AiAnalysisPreflight,
) {
  return {
    cache,
    execute,
    executedAt: () => "2026-09-01T00:00:00.000Z",
    ...(preflight == null ? {} : { preflight }),
  };
}

function createCacheHitStore(
  candidate: PreparedAiAnalysisCandidate,
  output: unknown,
): AiCacheStore {
  const cacheIdentity: AiCacheIdentity = {
    ...identity,
    inputHash: candidate.fingerprint.inputHash,
  };
  const entry = createAiCacheEntry({
    cacheKey: createAiCacheKey(cacheIdentity),
    sourceHash: candidate.fingerprint.sourceHash,
    metadata: {
      ...cacheIdentity,
      outputHash: hashCanonicalJson(output),
      executedAt: "2026-09-01T00:00:00.000Z",
    },
    output,
  });
  return {
    read: () => Promise.resolve({ status: "hit", entry }),
    write: () => Promise.reject(new TypeError("cache hitテストでcache writeが呼ばれました")),
  };
}

void test("認証preflightの完了後に候補を実行する", async () => {
  const candidate = createCandidate("candidate-1", 0.1);
  const events: string[] = [];
  let candidateCalls = 0;
  let resolvePreflight: (() => void) | undefined;
  const preflightPromise = new Promise<void>((resolve) => {
    resolvePreflight = resolve;
  });
  const runPromise = runAiAnalyses(
    [candidate],
    createConfiguration(createBudget(4, 10_000, 10_000, 10), 4),
    createDependencies(
      (input) => {
        candidateCalls += 1;
        events.push("candidate");
        assert.deepEqual(events, ["preflight:start", "preflight:end", "candidate"]);
        return Promise.resolve(createOutput(input));
      },
      createMissCache(),
      createPreflight(1, 0.1, () => {
        events.push("preflight:start");
        return preflightPromise.then(() => {
          events.push("preflight:end");
        });
      }),
    ),
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(candidateCalls, 0);
  assert.deepEqual(events, ["preflight:start"]);
  assert.ok(resolvePreflight);
  resolvePreflight();
  const result = await runPromise;

  assert.equal(result.results.length, 1);
  assert.equal(result.usage.calls, 2);
});

void test("認証preflight失敗時は候補を実行せず元のErrorを伝播する", async () => {
  const candidate = createCandidate("candidate-1", 0.1);
  const preflightError = new Error("preflight failed");
  let candidateCalls = 0;

  await assert.rejects(
    runAiAnalyses(
      [candidate],
      createConfiguration(createBudget(4, 10_000, 10_000, 10), 4),
      createDependencies(
        (input) => {
          candidateCalls += 1;
          return Promise.resolve(createOutput(input));
        },
        createMissCache(),
        createPreflight(1, 0.1, () => Promise.reject(preflightError)),
      ),
    ),
    (error: unknown) => error === preflightError,
  );
  assert.equal(candidateCalls, 0);
});

void test("preflight後も候補実行の最大並列数を設定値に保つ", async () => {
  const candidates = Array.from({ length: 8 }, (_, index) =>
    createCandidate(`candidate-${(index + 1).toString()}`, 0.1),
  );
  let activeCalls = 0;
  let maximumActiveCalls = 0;
  let preflightCompleted = false;

  const result = await runAiAnalyses(
    candidates,
    createConfiguration(createBudget(20, 10_000, 100_000, 10), 4),
    createDependencies(
      async (input) => {
        assert.equal(preflightCompleted, true);
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        await Promise.resolve();
        activeCalls -= 1;
        return createOutput(input);
      },
      createMissCache(),
      createPreflight(1, 0.1, () => {
        preflightCompleted = true;
        return Promise.resolve();
      }),
    ),
  );

  assert.equal(result.results.length, candidates.length);
  assert.equal(maximumActiveCalls, 4);
});

void test("run call上限からpreflightの1 callを予約する", async () => {
  const candidates = [createCandidate("candidate-1", 0.1), createCandidate("candidate-2", 0.1)];
  let candidateCalls = 0;
  const result = await runAiAnalyses(
    candidates,
    createConfiguration(createBudget(2, 10_000, 100_000, 10), 4),
    createDependencies(
      (input) => {
        candidateCalls += 1;
        return Promise.resolve(createOutput(input));
      },
      createMissCache(),
      createPreflight(1, 0.1, () => Promise.resolve()),
    ),
  );

  assert.equal(candidateCalls, 1);
  assert.equal(result.usage.calls, 2);
  assert.deepEqual(result.deferred, [
    {
      candidateId: "candidate-2",
      reason: "call_limit",
    },
  ]);
});

void test("preflightの入力文字数と見積費用をrun使用量へ含める", async () => {
  const candidate = createCandidate("candidate-1", 0.75);
  const preflightInputCharacters = 3;
  const result = await runAiAnalyses(
    [candidate],
    createConfiguration(
      createBudget(
        2,
        candidate.inputCharacters,
        candidate.inputCharacters + preflightInputCharacters,
        1,
      ),
      4,
    ),
    createDependencies(
      (input) => Promise.resolve(createOutput(input)),
      createMissCache(),
      createPreflight(preflightInputCharacters, 0.25, () => Promise.resolve()),
    ),
  );

  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.inputCharacters, candidate.inputCharacters + preflightInputCharacters);
  assert.equal(result.usage.estimatedCostUsd, 1);
});

void test("preflight予約だけでrun予算上限を超える場合は実行しない", async () => {
  const cases = [
    {
      budget: createBudget(0, 10_000, 10_000, 10),
      reason: "call_limit",
    },
    {
      budget: createBudget(2, 10_000, 1, 10),
      reason: "total_input_character_limit",
    },
    {
      budget: createBudget(2, 10_000, 10_000, 0),
      reason: "estimated_cost_limit",
    },
  ] as const;

  for (const testCase of cases) {
    const candidate = createCandidate("candidate-1", 0.1);
    let candidateCalls = 0;
    let preflightCalls = 0;
    const result = await runAiAnalyses(
      [candidate],
      createConfiguration(testCase.budget, 4),
      createDependencies(
        (input) => {
          candidateCalls += 1;
          return Promise.resolve(createOutput(input));
        },
        createMissCache(),
        createPreflight(2, 0.1, () => {
          preflightCalls += 1;
          return Promise.resolve();
        }),
      ),
    );

    assert.equal(candidateCalls, 0);
    assert.equal(preflightCalls, 0);
    assert.deepEqual(result.deferred, [
      {
        candidateId: candidate.id,
        reason: testCase.reason,
      },
    ]);
    assert.deepEqual(result.usage, {
      calls: 0,
      inputCharacters: 0,
      estimatedCostUsd: 0,
    });
  }
});

void test("候補がないrunでは認証preflightを実行しない", async () => {
  let preflightCalls = 0;
  const result = await runAiAnalyses(
    [],
    createConfiguration(createBudget(2, 10_000, 10_000, 10), 4),
    createDependencies(
      (input) => Promise.resolve(createOutput(input)),
      createMissCache(),
      createPreflight(1, 0.1, () => {
        preflightCalls += 1;
        return Promise.resolve();
      }),
    ),
  );

  assert.equal(preflightCalls, 0);
  assert.deepEqual(result.usage, {
    calls: 0,
    inputCharacters: 0,
    estimatedCostUsd: 0,
  });
});

void test("全候補が予算延期されるrunでは認証preflightを実行しない", async () => {
  const candidate = createCandidate("candidate-1", 0.1);
  let preflightCalls = 0;
  const result = await runAiAnalyses(
    [candidate],
    createConfiguration(createBudget(1, 10_000, 10_000, 10), 4),
    createDependencies(
      (input) => Promise.resolve(createOutput(input)),
      createMissCache(),
      createPreflight(1, 0.1, () => {
        preflightCalls += 1;
        return Promise.resolve();
      }),
    ),
  );

  assert.equal(preflightCalls, 0);
  assert.deepEqual(result.deferred, [
    {
      candidateId: candidate.id,
      reason: "call_limit",
    },
  ]);
  assert.deepEqual(result.usage, {
    calls: 0,
    inputCharacters: 0,
    estimatedCostUsd: 0,
  });
});

void test("preflightなしのrunでは候補を通常どおり実行する", async () => {
  const candidate = createCandidate("candidate-1", 0.1);
  let candidateCalls = 0;
  const result = await runAiAnalyses(
    [candidate],
    createConfiguration(createBudget(2, 10_000, 10_000, 10), 4),
    createDependencies((input) => {
      candidateCalls += 1;
      return Promise.resolve(createOutput(input));
    }, createMissCache()),
  );

  assert.equal(candidateCalls, 1);
  assert.equal(result.usage.calls, 1);
});

void test("cache hitのみのrunでは認証preflightを実行しない", async () => {
  const candidate = createCandidate("candidate-1", 0.1);
  const output = createOutput(candidate.input);
  let preflightCalls = 0;
  const result = await runAiAnalyses(
    [candidate],
    createConfiguration(createBudget(2, 10_000, 10_000, 10), 4),
    createDependencies(
      (input) => Promise.resolve(createOutput(input)),
      createCacheHitStore(candidate, output),
      createPreflight(1, 0.1, () => {
        preflightCalls += 1;
        return Promise.resolve();
      }),
    ),
  );

  assert.equal(preflightCalls, 0);
  assert.equal(result.results[0]?.origin, "cache");
  assert.deepEqual(result.usage, {
    calls: 0,
    inputCharacters: 0,
    estimatedCostUsd: 0,
  });
});

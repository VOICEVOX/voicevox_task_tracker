import {
  selectAiAnalysisCandidates,
  type AiAnalysisFingerprint,
  type AiAnalysisRunIdentity,
  type AiAnalysisSkipReason,
  type PreparedAiAnalysisCandidate,
} from "./analysis-selection.js";
import { planAiAnalysisBudget, type AiAnalysisDeferReason, type AiRunBudget } from "./budget.js";
import {
  createAiCacheEntry,
  createAiCacheKey,
  determineAiCacheReuse,
  type AiCacheIdentity,
  type AiCacheKey,
  type AiCacheStore,
} from "./cache.js";
import { hashCanonicalJson } from "./canonical-json.js";
import {
  CodexOutputValidationError,
  type CodexNonZeroExitDiagnostic,
  type CodexOutputValidationDiagnostic,
} from "./errors.js";
import { type CodexAnalysisInput } from "./input.js";
import { type ValidatedCodexAnalysisOutput } from "./output-types.js";
import { validateCodexAnalysisOutput } from "./output-validation.js";
import { executeValidatedCodexAnalysis, type CodexUnavailableReason } from "./reducer.js";
import { createUtcIsoDateTime, type AnalysisMetadata } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

/** 1 runのAI cache、予算、実行方針の設定。 */
export type AiAnalysisRunConfiguration = Readonly<{
  identity: AiAnalysisRunIdentity;
  budget: AiRunBudget;
  maxConcurrentCalls: number;
}>;

/** AI分析runへ注入する副作用境界。 */
export type AiAnalysisRunDependencies = Readonly<{
  cache: AiCacheStore;
  execute: (input: CodexAnalysisInput) => Promise<unknown>;
  executedAt: () => string;
}>;

/** cache再利用または新規実行で取得したAI結果。 */
export type AiAnalysisRunItemResult = Readonly<{
  candidateId: string;
  origin: "cache" | "executed";
  cacheKey: AiCacheKey;
  fingerprint: AiAnalysisFingerprint;
  output: ValidatedCodexAnalysisOutput;
  metadata: AnalysisMetadata;
}>;

/** Codex実行または出力検証に失敗してfallbackする項目。 */
export type AiAnalysisRunFailure = Readonly<{
  candidateId: string;
  reason: CodexUnavailableReason;
  errorType: string;
  diagnostic?: CodexNonZeroExitDiagnostic;
  validationDiagnostic?: CodexOutputValidationDiagnostic;
}>;

/** 1 runのAI分析、抑止、延期と予算使用量。 */
export type AiAnalysisRunResult = Readonly<{
  results: readonly AiAnalysisRunItemResult[];
  failures: readonly AiAnalysisRunFailure[];
  skipped: readonly Readonly<{
    candidateId: string;
    reason: AiAnalysisSkipReason;
  }>[];
  deferred: readonly Readonly<{
    candidateId: string;
    reason: AiAnalysisDeferReason;
  }>[];
  usage: Readonly<{
    calls: number;
    inputCharacters: number;
    estimatedCostUsd: number;
  }>;
}>;

type CacheMissCandidate = Readonly<{
  candidate: PreparedAiAnalysisCandidate;
  identity: AiCacheIdentity;
}>;

type CandidateExecutionOutcome =
  | Readonly<{
      status: "result";
      result: AiAnalysisRunItemResult;
    }>
  | Readonly<{
      status: "failure";
      failure: AiAnalysisRunFailure;
    }>;

function createCacheIdentity(
  candidate: PreparedAiAnalysisCandidate,
  identity: AiAnalysisRunIdentity,
): AiCacheIdentity {
  return Object.freeze({
    ...identity,
    inputHash: candidate.fingerprint.inputHash,
  });
}

function createResult(
  candidate: PreparedAiAnalysisCandidate,
  origin: AiAnalysisRunItemResult["origin"],
  cacheKey: AiCacheKey,
  output: ValidatedCodexAnalysisOutput,
  metadata: AnalysisMetadata,
): AiAnalysisRunItemResult {
  return Object.freeze({
    candidateId: candidate.id,
    origin,
    cacheKey,
    fingerprint: candidate.fingerprint,
    output,
    metadata,
  });
}

async function resolveCacheEntries(
  candidates: readonly PreparedAiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  cache: AiCacheStore,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    misses: readonly CacheMissCandidate[];
  }>
> {
  const results: AiAnalysisRunItemResult[] = [];
  const misses: CacheMissCandidate[] = [];
  for (const candidate of candidates) {
    const identity = createCacheIdentity(candidate, configuration.identity);
    const cacheKey = createAiCacheKey(identity);
    const cached = await cache.read(cacheKey);
    if (cached.status === "hit") {
      const reuse = determineAiCacheReuse(cached.entry, identity, candidate.fingerprint.sourceHash);
      if (reuse.status === "reusable") {
        try {
          const output = validateCodexAnalysisOutput(reuse.entry.output, candidate.input);
          results.push(
            createResult(candidate, "cache", reuse.entry.cacheKey, output, reuse.entry.metadata),
          );
          continue;
        } catch (error: unknown) {
          if (!(error instanceof CodexOutputValidationError)) {
            throw error;
          }
        }
      }
    }
    misses.push(
      Object.freeze({
        candidate,
        identity,
      }),
    );
  }
  return Object.freeze({
    results: Object.freeze(results),
    misses: Object.freeze(misses),
  });
}

function findCacheMiss(
  cacheMisses: readonly CacheMissCandidate[],
  candidate: PreparedAiAnalysisCandidate,
): CacheMissCandidate {
  const cacheMiss = cacheMisses.find((value) => value.candidate.id === candidate.id);
  assertNonNullable(cacheMiss, `Codex分析候補のcache miss情報がありません。対象: ${candidate.id}`);
  return cacheMiss;
}

function assertUnchangedCandidatesAreCached(
  cacheMisses: readonly CacheMissCandidate[],
  selectedCandidateIds: ReadonlySet<string>,
): void {
  const missing = cacheMisses.find((value) => !selectedCandidateIds.has(value.candidate.id));
  if (missing != null) {
    throw new TypeError(
      `未変更のCodex分析候補に対応するcacheがありません。対象: ${missing.candidate.id}`,
    );
  }
}

async function executeSelectedCandidates(
  selected: readonly PreparedAiAnalysisCandidate[],
  cacheMisses: readonly CacheMissCandidate[],
  maxConcurrentCalls: number,
  dependencies: AiAnalysisRunDependencies,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    failures: readonly AiAnalysisRunFailure[];
  }>
> {
  if (!Number.isSafeInteger(maxConcurrentCalls) || maxConcurrentCalls <= 0) {
    throw new RangeError("Codexの最大同時呼び出し数は正の安全な整数にしてください");
  }

  const outcomes = new Map<number, CandidateExecutionOutcome>();
  let nextCandidateIndex = 0;
  let stopped = false;
  const workerCount = Math.min(maxConcurrentCalls, selected.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopped) {
      const candidateIndex = nextCandidateIndex;
      if (candidateIndex >= selected.length) {
        return;
      }
      nextCandidateIndex += 1;
      const candidate = selected.at(candidateIndex);
      assertNonNullable(candidate, "Codex分析候補を予算計画順に取得できませんでした");

      try {
        const cacheMiss = findCacheMiss(cacheMisses, candidate);
        const attempt = await executeValidatedCodexAnalysis(candidate.input, dependencies.execute);
        if (attempt.status === "unavailable") {
          outcomes.set(
            candidateIndex,
            Object.freeze({
              status: "failure",
              failure: Object.freeze({
                candidateId: candidate.id,
                reason: attempt.reason,
                errorType: attempt.errorType,
                ...(attempt.diagnostic == null ? {} : { diagnostic: attempt.diagnostic }),
                ...(attempt.validationDiagnostic == null
                  ? {}
                  : { validationDiagnostic: attempt.validationDiagnostic }),
              }),
            }),
          );
          continue;
        }
        const output = attempt.output;
        const metadata = Object.freeze({
          ...cacheMiss.identity,
          outputHash: hashCanonicalJson(output),
          executedAt: createUtcIsoDateTime(dependencies.executedAt()),
        }) satisfies AnalysisMetadata;
        const entry = createAiCacheEntry({
          cacheKey: createAiCacheKey(cacheMiss.identity),
          sourceHash: candidate.fingerprint.sourceHash,
          metadata,
          output,
        });
        await dependencies.cache.write(entry);
        outcomes.set(
          candidateIndex,
          Object.freeze({
            status: "result",
            result: createResult(candidate, "executed", entry.cacheKey, output, entry.metadata),
          }),
        );
      } catch (error: unknown) {
        stopped = true;
        throw error;
      }
    }
  });
  const settledWorkers = await Promise.allSettled(workers);
  for (const settledWorker of settledWorkers) {
    if (settledWorker.status === "rejected") {
      const reason: unknown = settledWorker.reason;
      throw reason;
    }
  }

  const results: AiAnalysisRunItemResult[] = [];
  const failures: AiAnalysisRunFailure[] = [];
  for (const candidateIndex of selected.keys()) {
    const outcome = outcomes.get(candidateIndex);
    assertNonNullable(outcome, "Codex分析候補の実行結果がありません");
    if (outcome.status === "result") {
      results.push(outcome.result);
    } else {
      failures.push(outcome.failure);
    }
  }
  return Object.freeze({
    results: Object.freeze(results),
    failures: Object.freeze(failures),
  });
}

/** 曖昧な変更項目だけをcacheとrun予算の範囲でCodex分析する。 */
export async function runAiAnalyses(
  candidates: readonly PreparedAiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  const identityHash = hashCanonicalJson(configuration.identity);
  const identityMismatch = candidates.find(
    (candidate) => candidate.fingerprint.identityHash !== identityHash,
  );
  if (identityMismatch != null) {
    throw new TypeError(
      `Codex分析候補とrunの実行identityが一致しません。対象: ${identityMismatch.id}`,
    );
  }
  const selection = selectAiAnalysisCandidates(candidates);
  const unchangedCandidates = selection.skipped.flatMap((value) =>
    value.reason === "unchanged" ? [value.candidate] : [],
  );
  const cached = await resolveCacheEntries(
    [...selection.selected, ...unchangedCandidates],
    configuration,
    dependencies.cache,
  );
  const selectedCandidateIds = new Set(selection.selected.map((candidate) => candidate.id));
  assertUnchangedCandidatesAreCached(cached.misses, selectedCandidateIds);
  const selectedCacheMisses = cached.misses.filter((value) =>
    selectedCandidateIds.has(value.candidate.id),
  );
  const budgetPlan = planAiAnalysisBudget(
    selectedCacheMisses.map((value) => value.candidate),
    configuration.budget,
  );
  const executed = await executeSelectedCandidates(
    budgetPlan.selected,
    selectedCacheMisses,
    configuration.maxConcurrentCalls,
    dependencies,
  );

  return Object.freeze({
    results: Object.freeze([...cached.results, ...executed.results]),
    failures: executed.failures,
    skipped: Object.freeze(
      selection.skipped.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    deferred: Object.freeze(
      budgetPlan.deferred.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    usage: budgetPlan.usage,
  });
}

import { summarizeAiBudgetLedger } from "../application/tracking-run/contracts/ai-budget-ledger.js";
import type { GenericAiPlan } from "../application/tracking-run/stages/generic-ai-plan-contracts.js";
import { assertNonNullable } from "../util/index.js";
import type {
  AiAnalysisRunConfiguration,
  AiAnalysisRunDependencies,
  AiAnalysisRunElementResult,
  AiAnalysisRunFailure,
  AiAnalysisRunItemResult,
  AiAnalysisRunResult,
} from "./analysis-runner-contracts.js";
import {
  assertTargetWasExecuted,
  selectPlannedCandidates,
  type CandidateCacheState,
} from "./analysis-runner-planning.js";
import {
  assertOutputItemMatchesInput,
  createCacheIdentity,
  createElementGeneration,
  createFailure,
  createRunElementResult,
  createRunItemResult,
  recordCandidateFailure,
  resultForElement,
  validateComposedOutput,
} from "./analysis-runner-results.js";
import type { AiAnalysisRunIdentity } from "./analysis-selection.js";
import {
  CodexAttemptBudgetExceededError,
  type CodexInitialAttemptTicket,
} from "./attempt-budget.js";
import { createAiCacheEntry, createAiCacheKey, type AiCacheEntry } from "./cache.js";
import { CodexAttemptError, CodexOutputValidationError } from "./errors.js";
import { validateCodexAnalysisSemantics } from "./semantic-validation.js";

export type {
  AiAnalysisExecutionContext,
  AiAnalysisPreflight,
  AiAnalysisRunConfiguration,
  AiAnalysisRunDependencies,
  AiAnalysisRunElementResult,
  AiAnalysisRunFailure,
  AiAnalysisRunItemResult,
  AiAnalysisRunResult,
} from "./analysis-runner-contracts.js";

type CandidateExecutionOutcome =
  | Readonly<{
      status: "result";
      result: AiAnalysisRunItemResult;
    }>
  | Readonly<{
      status: "failure";
      failure: AiAnalysisRunFailure;
      cached: readonly AiAnalysisRunElementResult[];
    }>
  | Readonly<{
      status: "deferred";
      candidateId: string;
      cached: readonly AiAnalysisRunElementResult[];
    }>;

async function executeCandidate(
  state: CandidateCacheState,
  identity: AiAnalysisRunIdentity,
  dependencies: AiAnalysisRunDependencies,
  ticket: CodexInitialAttemptTicket,
): Promise<CandidateExecutionOutcome> {
  const candidate = state.item.executionCandidate;
  assertNonNullable(candidate, `Codex実行入力がありません。対象: ${state.item.nodeId}`);
  try {
    const output = validateCodexAnalysisSemantics(
      await dependencies.execute(candidate.input, {
        candidateId: candidate.id,
        selectedElements: Object.freeze(candidate.selectedElements.map((value) => value.element)),
        initialAttemptTicket: ticket,
      }),
      candidate.input,
    );
    assertOutputItemMatchesInput(output, candidate.input);
    const generatedAt = dependencies.executedAt();
    const executedResults: AiAnalysisRunElementResult[] = [];
    const entries: AiCacheEntry[] = [];
    for (const elementCandidate of candidate.selectedElements) {
      const result = resultForElement(output, elementCandidate.element);
      const generation = createElementGeneration(
        candidate,
        elementCandidate,
        result,
        identity,
        generatedAt,
      );
      const cacheKey = createAiCacheKey(createCacheIdentity(identity, elementCandidate));
      const entry = createAiCacheEntry({
        cacheKey,
        element: elementCandidate.element,
        generation,
      });
      entries.push(entry);
      executedResults.push(
        createRunElementResult(
          elementCandidate.element,
          "executed",
          entry.cacheKey,
          entry.generation,
        ),
      );
    }
    const generated = new Map(executedResults.map((result) => [result.element, result]));
    const cached = new Map(state.cached.map((result) => [result.element, result]));
    const composed = state.item.selectedElements.map((element) => {
      if (generated.has(element) && cached.has(element)) {
        throw new TypeError(
          `AI分析要素のcacheと生成結果が重複しています。対象: ${candidate.id}/${element}`,
        );
      }
      const result = generated.get(element) ?? cached.get(element);
      assertNonNullable(result, `AI分析要素の結果がありません。対象: ${candidate.id}/${element}`);
      return result;
    });
    validateComposedOutput(state.item.candidate.input, composed);
    for (const entry of entries) {
      await dependencies.cache.write(entry);
    }
    return Object.freeze({
      status: "result",
      result: createRunItemResult(candidate.id, composed, true),
    });
  } catch (error: unknown) {
    if (error instanceof CodexAttemptBudgetExceededError) {
      return Object.freeze({ status: "deferred", candidateId: candidate.id, cached: state.cached });
    }
    if (!(error instanceof CodexAttemptError || error instanceof CodexOutputValidationError)) {
      throw error;
    }
    await recordCandidateFailure(dependencies.diagnostics, candidate.id, error, "execution");
    return Object.freeze({
      status: "failure",
      failure: createFailure(error, candidate.id),
      cached: state.cached,
    });
  }
}

async function executeSelectedCandidates(
  states: readonly CandidateCacheState[],
  selected: readonly Readonly<{
    candidateId: string;
    ticket: CodexInitialAttemptTicket;
  }>[],
  maxConcurrentCalls: number,
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    failures: readonly AiAnalysisRunFailure[];
    deferred: readonly string[];
  }>
> {
  if (!Number.isSafeInteger(maxConcurrentCalls) || maxConcurrentCalls <= 0) {
    throw new RangeError("Codexの最大同時呼び出し数は正の安全な整数にしてください");
  }
  const outcomes = new Map<number, CandidateExecutionOutcome>();
  let nextCandidateIndex = 0;
  let stopped = false;
  const workers = Array.from(
    { length: Math.min(maxConcurrentCalls, selected.length) },
    async () => {
      while (!stopped) {
        const candidateIndex = nextCandidateIndex;
        if (candidateIndex >= selected.length) {
          return;
        }
        nextCandidateIndex += 1;
        const reserved = selected.at(candidateIndex);
        assertNonNullable(reserved, "Codex分析候補を予算計画順に取得できませんでした");
        const { candidateId, ticket } = reserved;
        const state = states.find((value) => value.item.nodeId === candidateId);
        assertNonNullable(state, `Codex分析候補のcache stateがありません。対象: ${candidateId}`);
        try {
          outcomes.set(
            candidateIndex,
            await executeCandidate(state, configuration.identity, dependencies, ticket),
          );
        } catch (error: unknown) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  const settledWorkers = await Promise.allSettled(workers);
  for (const reserved of selected) {
    dependencies.attemptBudget.releaseInitialAttempt(reserved.ticket);
  }
  for (const settledWorker of settledWorkers) {
    if (settledWorker.status === "rejected") {
      throw settledWorker.reason;
    }
  }
  const results: AiAnalysisRunItemResult[] = [];
  const failures: AiAnalysisRunFailure[] = [];
  const deferred: string[] = [];
  for (const candidateIndex of selected.keys()) {
    const outcome = outcomes.get(candidateIndex);
    assertNonNullable(outcome, "Codex分析候補の実行結果がありません");
    if (outcome.status === "result") {
      results.push(outcome.result);
    } else if (outcome.status === "failure") {
      failures.push(outcome.failure);
      if (outcome.cached.length > 0) {
        results.push(createRunItemResult(outcome.failure.candidateId, outcome.cached, false));
      }
    } else {
      deferred.push(outcome.candidateId);
      if (outcome.cached.length > 0) {
        results.push(createRunItemResult(outcome.candidateId, outcome.cached, false));
      }
    }
  }
  return Object.freeze({
    results: Object.freeze(results),
    failures: Object.freeze(failures),
    deferred: Object.freeze(deferred),
  });
}

/** 確定済みplanの選択要素だけを項目ごとに一回のCodex呼び出しで分析する。 */
export async function runPlannedAiAnalyses(
  plan: GenericAiPlan,
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  const target = plan.target;
  if (configuration.identity !== plan.identity) {
    throw new TypeError("AI実行設定のidentityが計画と一致しません");
  }
  if (
    dependencies.attemptBudget.snapshot.ledgerId !== plan.budget.ledger.ledgerId ||
    dependencies.attemptBudget.snapshot.sequence !== plan.budget.ledger.sequence
  ) {
    throw new TypeError("AI実行時のledgerが計画時の予約と一致しません");
  }
  const selection = selectPlannedCandidates(plan);
  const selectedIds = new Set(plan.budget.selected.map((value) => value.candidateId));
  const deferredIds = new Set(plan.budget.deferred.map((value) => value.candidateId));
  if (
    selectedIds.size !== plan.budget.selected.length ||
    deferredIds.size !== plan.budget.deferred.length ||
    selection.selected.some((state) => {
      const hasExecution = state.item.executionCandidate != null;
      return (
        (hasExecution &&
          selectedIds.has(state.item.nodeId) === deferredIds.has(state.item.nodeId)) ||
        (!hasExecution &&
          (selectedIds.has(state.item.nodeId) || deferredIds.has(state.item.nodeId)))
      );
    }) ||
    [...selectedIds, ...deferredIds].some(
      (id) => !selection.selected.some((state) => state.item.nodeId === id),
    )
  ) {
    throw new TypeError("汎用AIの予約候補と計画が一致しません");
  }
  if (plan.budget.preflightTicket != null && dependencies.preflight == null) {
    throw new TypeError("汎用AIの認証preflight予約に実行境界がありません");
  }
  const cachedOnlyResults = selection.selected
    .filter((state) => state.item.executionCandidate == null)
    .map((state) => {
      validateComposedOutput(state.item.candidate.input, state.cached);
      return createRunItemResult(state.item.nodeId, state.cached, true);
    });
  const budgetDeferredResults = plan.budget.deferred.flatMap((value) => {
    const state = selection.selected.find(
      (candidate) => candidate.item.nodeId === value.candidateId,
    );
    assertNonNullable(state, `延期した汎用AI候補が計画にありません。対象: ${value.candidateId}`);
    return state.cached.length === 0
      ? []
      : [createRunItemResult(value.candidateId, state.cached, false)];
  });
  if (plan.budget.selected.length > 0) {
    try {
      await dependencies.ensureReady();
      if (plan.budget.preflightTicket != null) {
        assertNonNullable(dependencies.preflight, "汎用AIの認証preflight実行境界がありません");
        await dependencies.preflight.execute(plan.budget.preflightTicket);
      }
    } catch (error: unknown) {
      for (const reserved of plan.budget.selected) {
        dependencies.attemptBudget.releaseInitialAttempt(reserved.ticket);
      }
      throw error;
    } finally {
      if (plan.budget.preflightTicket != null) {
        dependencies.attemptBudget.releaseInitialAttempt(plan.budget.preflightTicket);
      }
    }
  }
  const executed = await executeSelectedCandidates(
    selection.selected,
    plan.budget.selected,
    configuration.maxConcurrentCalls,
    configuration,
    dependencies,
  );
  const summary = summarizeAiBudgetLedger(dependencies.attemptBudget.snapshot);
  const itemOrder = new Map<string, number>(plan.items.map((item, index) => [item.nodeId, index]));
  function byPlanOrder(left: string, right: string): number {
    const leftIndex = itemOrder.get(left);
    const rightIndex = itemOrder.get(right);
    assertNonNullable(leftIndex, `AI結果の候補が計画にありません。対象: ${left}`);
    assertNonNullable(rightIndex, `AI結果の候補が計画にありません。対象: ${right}`);
    return leftIndex - rightIndex;
  }
  const result = Object.freeze({
    results: Object.freeze(
      [...cachedOnlyResults, ...budgetDeferredResults, ...executed.results].sort((left, right) =>
        byPlanOrder(left.candidateId, right.candidateId),
      ),
    ),
    failures: Object.freeze(
      [...executed.failures].sort((left, right) =>
        byPlanOrder(left.candidateId, right.candidateId),
      ),
    ),
    skipped: Object.freeze(
      selection.skipped.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    deferred: Object.freeze(
      [
        ...plan.budget.deferred.map((value) =>
          Object.freeze({
            candidateId: value.candidateId,
            reason: value.reason,
          }),
        ),
        ...executed.deferred.map((candidateId): AiAnalysisRunResult["deferred"][number] =>
          Object.freeze({ candidateId, reason: "call_limit" }),
        ),
      ].sort((left, right) => byPlanOrder(left.candidateId, right.candidateId)),
    ),
    usage: Object.freeze({
      calls: summary.logicalCandidateCount + summary.authenticationPreflightAttemptCount,
      inputCharacters: summary.inputCharacters,
      estimatedCostUsd: summary.estimatedCostUsd,
    }),
    authenticationPreflightExecuted: plan.budget.preflightTicket != null,
  });
  if (target != null) {
    assertTargetWasExecuted(result, target);
  }
  return result;
}

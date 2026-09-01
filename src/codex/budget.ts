import { type AiAnalysisPriority, type PreparedAiAnalysisCandidate } from "./analysis-selection.js";

const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;

/** 1 runのCodex呼び出し予算。 */
export type AiRunBudget = Readonly<{
  maxCallsPerRun: number;
  maxInputCharactersPerItem: number;
  maxTotalInputCharactersPerRun: number;
  maxEstimatedCostUsdPerRun: number;
}>;

/** Codex呼び出し予算の使用見積。 */
export type AiBudgetUsage = Readonly<{
  calls: number;
  inputCharacters: number;
  estimatedCostUsd: number;
}>;

/** 正規化入力のtoken数とmodel入力単価から算出した費用見積。 */
export type AiInputCostEstimate = Readonly<{
  estimatedInputTokens: number;
  estimatedCostUsd: number;
}>;

/** 予算によりCodex分析を延期した理由。 */
export type AiAnalysisDeferReason =
  | "item_input_character_limit"
  | "call_limit"
  | "total_input_character_limit"
  | "estimated_cost_limit";

/** Codex認証preflightのrun予算見積。 */
export type AiPreflightBudget = Readonly<{
  inputCharacters: number;
  estimatedCostUsd: number;
}>;

/** Codex呼び出しの予算配分結果。 */
export type AiBudgetPlan = Readonly<{
  selected: readonly PreparedAiAnalysisCandidate[];
  deferred: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisDeferReason;
  }>[];
  usage: AiBudgetUsage;
}>;

type BudgetDecision =
  | Readonly<{
      status: "selected";
    }>
  | Readonly<{
      status: "deferred";
      reason: AiAnalysisDeferReason;
    }>;

function compareBooleanPriority(left: boolean, right: boolean): number {
  if (left === right) {
    return 0;
  }
  return left ? -1 : 1;
}

function compareNumberDescending(left: number, right: number): number {
  if (left > right) {
    return -1;
  }
  if (left < right) {
    return 1;
  }
  return 0;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function comparePriority(left: AiAnalysisPriority, right: AiAnalysisPriority): number {
  const severity = compareBooleanPriority(left.severityCandidate, right.severityCandidate);
  if (severity !== 0) {
    return severity;
  }
  const ownerUnknown = compareBooleanPriority(left.ownerUnknown, right.ownerUnknown);
  if (ownerUnknown !== 0) {
    return ownerUnknown;
  }
  const changedBlocker = compareBooleanPriority(left.changedBlocker, right.changedBlocker);
  if (changedBlocker !== 0) {
    return changedBlocker;
  }
  const openNodeCount = compareNumberDescending(
    left.downstreamImpact.openNodeCount,
    right.downstreamImpact.openNodeCount,
  );
  if (openNodeCount !== 0) {
    return openNodeCount;
  }
  const repositoryCount = compareNumberDescending(
    left.downstreamImpact.repositoryCount,
    right.downstreamImpact.repositoryCount,
  );
  if (repositoryCount !== 0) {
    return repositoryCount;
  }
  return compareBooleanPriority(left.previouslyDeferred, right.previouslyDeferred);
}

function validateNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name}は0以上の安全な整数にしてください`);
  }
}

function validatePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name}は正の安全な整数にしてください`);
  }
}

function validateFiniteNonNegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}は0以上の有限値にしてください`);
  }
}

/** UTF-8 byte数を基にCodex入力token数とmodel入力費用を保守的に見積もる。 */
export function estimateAiInputCost(
  normalizedInput: string,
  inputCostUsdPerMillionTokens: number,
): AiInputCostEstimate {
  validateFiniteNonNegativeNumber(inputCostUsdPerMillionTokens, "100万入力tokenあたりの見積費用");
  if (inputCostUsdPerMillionTokens === 0) {
    throw new RangeError("100万入力tokenあたりの見積費用は正の値にしてください");
  }
  const estimatedInputTokens = Math.ceil(new TextEncoder().encode(normalizedInput).length / 4);
  return Object.freeze({
    estimatedInputTokens,
    estimatedCostUsd: (estimatedInputTokens * inputCostUsdPerMillionTokens) / TOKENS_PER_MILLION,
  });
}

function convertEstimatedCostToMicroUsd(
  value: number,
  rounding: "budget_down" | "estimate_up",
  name: string,
): number {
  validateFiniteNonNegativeNumber(value, name);
  const scaled = value * MICRO_USD_PER_USD;
  const converted = rounding === "budget_down" ? Math.floor(scaled) : Math.ceil(scaled);
  if (!Number.isSafeInteger(converted)) {
    throw new RangeError(`${name}はmicro USDへ安全に変換できる範囲で指定してください`);
  }
  return converted;
}

function validateBudget(budget: AiRunBudget): void {
  validateNonNegativeSafeInteger(budget.maxCallsPerRun, "runあたりの最大呼び出し回数");
  validatePositiveSafeInteger(budget.maxInputCharactersPerItem, "項目あたりの最大入力文字数");
  validatePositiveSafeInteger(budget.maxTotalInputCharactersPerRun, "runあたりの最大入力文字数");
  convertEstimatedCostToMicroUsd(
    budget.maxEstimatedCostUsdPerRun,
    "budget_down",
    "runあたりの最大見積費用",
  );
}

function validateCandidate(candidate: PreparedAiAnalysisCandidate): void {
  validateNonNegativeSafeInteger(candidate.inputCharacters, "Codex分析候補の入力文字数");
  convertEstimatedCostToMicroUsd(
    candidate.estimatedCostUsd,
    "estimate_up",
    "Codex分析候補の見積費用",
  );
  validateNonNegativeSafeInteger(
    candidate.priority.downstreamImpact.openNodeCount,
    "downstream impactのopen node数",
  );
  validateNonNegativeSafeInteger(
    candidate.priority.downstreamImpact.repositoryCount,
    "downstream impactのリポジトリ数",
  );
}

function determineBudgetDecision(
  candidate: PreparedAiAnalysisCandidate,
  budget: AiRunBudget,
  usage: AiBudgetUsage,
  usedEstimatedCostMicroUsd: number,
): BudgetDecision {
  if (candidate.inputCharacters > budget.maxInputCharactersPerItem) {
    return Object.freeze({
      status: "deferred",
      reason: "item_input_character_limit",
    });
  }
  if (usage.calls >= budget.maxCallsPerRun) {
    return Object.freeze({
      status: "deferred",
      reason: "call_limit",
    });
  }
  if (usage.inputCharacters + candidate.inputCharacters > budget.maxTotalInputCharactersPerRun) {
    return Object.freeze({
      status: "deferred",
      reason: "total_input_character_limit",
    });
  }
  const candidateEstimatedCostMicroUsd = convertEstimatedCostToMicroUsd(
    candidate.estimatedCostUsd,
    "estimate_up",
    "Codex分析候補の見積費用",
  );
  const maximumEstimatedCostMicroUsd = convertEstimatedCostToMicroUsd(
    budget.maxEstimatedCostUsdPerRun,
    "budget_down",
    "runあたりの最大見積費用",
  );
  if (usedEstimatedCostMicroUsd + candidateEstimatedCostMicroUsd > maximumEstimatedCostMicroUsd) {
    return Object.freeze({
      status: "deferred",
      reason: "estimated_cost_limit",
    });
  }
  return Object.freeze({
    status: "selected",
  });
}

function validateInitialUsage(usage: AiBudgetUsage, budget: AiRunBudget): number {
  validateNonNegativeSafeInteger(usage.calls, "run予算の使用呼び出し回数");
  validateNonNegativeSafeInteger(usage.inputCharacters, "run予算の使用入力文字数");
  const usedEstimatedCostMicroUsd = convertEstimatedCostToMicroUsd(
    usage.estimatedCostUsd,
    "estimate_up",
    "run予算の使用見積費用",
  );
  if (usage.calls > budget.maxCallsPerRun) {
    throw new RangeError("run予算の使用呼び出し回数が上限を超えています");
  }
  if (usage.inputCharacters > budget.maxTotalInputCharactersPerRun) {
    throw new RangeError("run予算の使用入力文字数が上限を超えています");
  }
  const maximumEstimatedCostMicroUsd = convertEstimatedCostToMicroUsd(
    budget.maxEstimatedCostUsdPerRun,
    "budget_down",
    "runあたりの最大見積費用",
  );
  if (usedEstimatedCostMicroUsd > maximumEstimatedCostMicroUsd) {
    throw new RangeError("run予算の使用見積費用が上限を超えています");
  }
  return usedEstimatedCostMicroUsd;
}

function validatePreflightBudget(preflight: AiPreflightBudget): number {
  validateNonNegativeSafeInteger(preflight.inputCharacters, "Codex認証preflightの入力文字数");
  return convertEstimatedCostToMicroUsd(
    preflight.estimatedCostUsd,
    "estimate_up",
    "Codex認証preflightの見積費用",
  );
}

function sortAndValidateCandidates(
  candidates: readonly PreparedAiAnalysisCandidate[],
  budget: AiRunBudget,
): readonly PreparedAiAnalysisCandidate[] {
  validateBudget(budget);
  for (const candidate of candidates) {
    validateCandidate(candidate);
  }
  return [...candidates].sort((left, right) => {
    const priority = comparePriority(left.priority, right.priority);
    return priority === 0 ? compareStrings(left.id, right.id) : priority;
  });
}

function emptyBudgetUsage(): AiBudgetUsage {
  return Object.freeze({
    calls: 0,
    inputCharacters: 0,
    estimatedCostUsd: 0,
  });
}

function planAiAnalysisBudgetFromSortedCandidates(
  sortedCandidates: readonly PreparedAiAnalysisCandidate[],
  budget: AiRunBudget,
  initialUsage: AiBudgetUsage,
): AiBudgetPlan {
  let usedEstimatedCostMicroUsd = validateInitialUsage(initialUsage, budget);
  const selected: PreparedAiAnalysisCandidate[] = [];
  const deferred: {
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisDeferReason;
  }[] = [];
  let usage: AiBudgetUsage = Object.freeze({
    calls: initialUsage.calls,
    inputCharacters: initialUsage.inputCharacters,
    estimatedCostUsd: usedEstimatedCostMicroUsd / MICRO_USD_PER_USD,
  });

  for (const candidate of sortedCandidates) {
    const decision = determineBudgetDecision(candidate, budget, usage, usedEstimatedCostMicroUsd);
    if (decision.status === "deferred") {
      deferred.push({
        candidate,
        reason: decision.reason,
      });
      continue;
    }
    selected.push(candidate);
    usedEstimatedCostMicroUsd += convertEstimatedCostToMicroUsd(
      candidate.estimatedCostUsd,
      "estimate_up",
      "Codex分析候補の見積費用",
    );
    usage = Object.freeze({
      calls: usage.calls + 1,
      inputCharacters: usage.inputCharacters + candidate.inputCharacters,
      estimatedCostUsd: usedEstimatedCostMicroUsd / MICRO_USD_PER_USD,
    });
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    deferred: Object.freeze(deferred.map((value) => Object.freeze(value))),
    usage,
  });
}

/** 規定の優先順位でcache missへrun予算を配分する。 */
export function planAiAnalysisBudget(
  candidates: readonly PreparedAiAnalysisCandidate[],
  budget: AiRunBudget,
): AiBudgetPlan {
  const sortedCandidates = sortAndValidateCandidates(candidates, budget);
  return planAiAnalysisBudgetFromSortedCandidates(sortedCandidates, budget, emptyBudgetUsage());
}

function preflightBudgetLimitReason(
  preflight: AiPreflightBudget,
  budget: AiRunBudget,
  preflightEstimatedCostMicroUsd: number,
): AiAnalysisDeferReason | undefined {
  if (budget.maxCallsPerRun < 1) {
    return "call_limit";
  }
  if (preflight.inputCharacters > budget.maxTotalInputCharactersPerRun) {
    return "total_input_character_limit";
  }
  const maximumEstimatedCostMicroUsd = convertEstimatedCostToMicroUsd(
    budget.maxEstimatedCostUsdPerRun,
    "budget_down",
    "runあたりの最大見積費用",
  );
  if (preflightEstimatedCostMicroUsd > maximumEstimatedCostMicroUsd) {
    return "estimated_cost_limit";
  }
  return undefined;
}

/** Codex認証preflightを予約したうえでrun予算を配分する。 */
export function planAiAnalysisBudgetWithPreflight(
  candidates: readonly PreparedAiAnalysisCandidate[],
  budget: AiRunBudget,
  preflight: AiPreflightBudget,
): AiBudgetPlan {
  const sortedCandidates = sortAndValidateCandidates(candidates, budget);
  const preflightEstimatedCostMicroUsd = validatePreflightBudget(preflight);
  const limitReason = preflightBudgetLimitReason(preflight, budget, preflightEstimatedCostMicroUsd);
  if (limitReason != null) {
    return Object.freeze({
      selected: Object.freeze([]),
      deferred: Object.freeze(
        sortedCandidates.map((candidate) =>
          Object.freeze({
            candidate,
            reason: limitReason,
          }),
        ),
      ),
      usage: emptyBudgetUsage(),
    });
  }

  const plan = planAiAnalysisBudgetFromSortedCandidates(
    sortedCandidates,
    budget,
    Object.freeze({
      calls: 1,
      inputCharacters: preflight.inputCharacters,
      estimatedCostUsd: preflight.estimatedCostUsd,
    }),
  );
  if (plan.selected.length === 0) {
    return Object.freeze({
      ...plan,
      usage: emptyBudgetUsage(),
    });
  }
  return plan;
}

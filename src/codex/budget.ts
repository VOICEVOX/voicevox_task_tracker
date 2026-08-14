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

type BudgetUsageState = Readonly<{
  usage: AiBudgetUsage;
  usedEstimatedCostMicroUsd: number;
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

function addCandidateUsage(
  candidate: PreparedAiAnalysisCandidate,
  state: BudgetUsageState,
): BudgetUsageState {
  const candidateCostMicroUsd = convertEstimatedCostToMicroUsd(
    candidate.estimatedCostUsd,
    "estimate_up",
    "Codex分析候補の見積費用",
  );
  const usedEstimatedCostMicroUsd = state.usedEstimatedCostMicroUsd + candidateCostMicroUsd;
  return Object.freeze({
    usage: Object.freeze({
      calls: state.usage.calls + 1,
      inputCharacters: state.usage.inputCharacters + candidate.inputCharacters,
      estimatedCostUsd: usedEstimatedCostMicroUsd / MICRO_USD_PER_USD,
    }),
    usedEstimatedCostMicroUsd,
  });
}

/** 規定の優先順位でcache missへrun予算を配分する。 */
export function planAiAnalysisBudget(
  candidates: readonly PreparedAiAnalysisCandidate[],
  budget: AiRunBudget,
): AiBudgetPlan {
  validateBudget(budget);
  for (const candidate of candidates) {
    validateCandidate(candidate);
  }
  const sortedCandidates = [...candidates].sort((left, right) => {
    const priority = comparePriority(left.priority, right.priority);
    return priority === 0 ? compareStrings(left.id, right.id) : priority;
  });
  const selected: PreparedAiAnalysisCandidate[] = [];
  const deferred: {
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisDeferReason;
  }[] = [];
  let usage: AiBudgetUsage = Object.freeze({
    calls: 0,
    inputCharacters: 0,
    estimatedCostUsd: 0,
  });
  let usedEstimatedCostMicroUsd = 0;

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
    const nextState = addCandidateUsage(candidate, {
      usage,
      usedEstimatedCostMicroUsd,
    });
    usage = nextState.usage;
    usedEstimatedCostMicroUsd = nextState.usedEstimatedCostMicroUsd;
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    deferred: Object.freeze(deferred.map((value) => Object.freeze(value))),
    usage,
  });
}

/** 追加のCodex呼び出しを同一run予算へ同期的に予約する。 */
export function createAiBudgetReservationController(
  budget: AiRunBudget,
  initialCandidates: readonly PreparedAiAnalysisCandidate[],
): Readonly<{
  tryReserve: (candidate: PreparedAiAnalysisCandidate) => boolean;
  usage: () => AiBudgetUsage;
}> {
  validateBudget(budget);
  let usage: AiBudgetUsage = Object.freeze({
    calls: 0,
    inputCharacters: 0,
    estimatedCostUsd: 0,
  });
  let usedCostMicroUsd = 0;

  for (const candidate of initialCandidates) {
    validateCandidate(candidate);
    const decision = determineBudgetDecision(candidate, budget, usage, usedCostMicroUsd);
    if (decision.status === "deferred") {
      throw new RangeError(
        `初期候補がrun予算の制約でdeferredになりました。対象: ${candidate.id} 理由: ${decision.reason}`,
      );
    }
    const nextState = addCandidateUsage(candidate, {
      usage,
      usedEstimatedCostMicroUsd: usedCostMicroUsd,
    });
    usage = nextState.usage;
    usedCostMicroUsd = nextState.usedEstimatedCostMicroUsd;
  }

  return Object.freeze({
    tryReserve(candidate: PreparedAiAnalysisCandidate): boolean {
      validateCandidate(candidate);
      const decision = determineBudgetDecision(candidate, budget, usage, usedCostMicroUsd);
      if (decision.status === "deferred") {
        return false;
      }
      const nextState = addCandidateUsage(candidate, {
        usage,
        usedEstimatedCostMicroUsd: usedCostMicroUsd,
      });
      usage = nextState.usage;
      usedCostMicroUsd = nextState.usedEstimatedCostMicroUsd;
      return true;
    },
    usage(): AiBudgetUsage {
      return usage;
    },
  });
}

import type { AiAnalysisElement, AiAnalysisElementGeneration } from "./analysis-elements.js";
import type { AiAnalysisRunIdentity, AiAnalysisSkipReason } from "./analysis-selection.js";
import type { CodexAttemptBudget, CodexInitialAttemptTicket } from "./attempt-budget.js";
import type { AiAnalysisDeferReason, AiBudgetUsage, AiPreflightBudget } from "./budget.js";
import type { AiCacheKey, AiCacheStore } from "./cache.js";
import type { CodexDiagnosticsContext } from "./diagnostics.js";
import type { CodexNonZeroExitDiagnostic, CodexOutputValidationDiagnostic } from "./errors.js";
import type { CodexAnalysisInput } from "./input.js";
import type { CodexUnavailableReason } from "./reducer-contracts.js";

/** 1 runのAI cache、予算、実行方針の設定。 */
export type AiAnalysisRunConfiguration = Readonly<{
  identity: AiAnalysisRunIdentity;
  maxConcurrentCalls: number;
}>;

/** AI分析前に実行するCodex認証preflight。 */
export type AiAnalysisPreflight = Readonly<
  AiPreflightBudget & {
    execute: (ticket: CodexInitialAttemptTicket) => Promise<void>;
  }
>;

/** AI分析runへ注入する副作用境界。 */
export type AiAnalysisRunDependencies = Readonly<{
  cache: AiCacheStore;
  attemptBudget: CodexAttemptBudget;
  ensureReady: () => Promise<void>;
  execute: (input: CodexAnalysisInput, context: AiAnalysisExecutionContext) => Promise<unknown>;
  executedAt: () => string;
  preflight?: AiAnalysisPreflight;
  diagnostics?: CodexDiagnosticsContext;
}>;

/** AI分析の実行候補を識別し、今回の選択要素を伝えるcontext。 */
export type AiAnalysisExecutionContext = Readonly<{
  candidateId: string;
  selectedElements: readonly AiAnalysisElement[];
  initialAttemptTicket: CodexInitialAttemptTicket;
}>;

/** cache再利用または新規実行で取得した要素別AI結果。 */
export type AiAnalysisRunElementResult = Readonly<{
  element: AiAnalysisElement;
  origin: "cache" | "executed";
  cacheKey: AiCacheKey;
  generation: AiAnalysisElementGeneration;
}>;

/** 一つのIssueまたはPull Requestについて取得したAI結果。 */
export type AiAnalysisRunItemResult = Readonly<{
  candidateId: string;
  origin: "cache" | "executed" | "mixed";
  complete: boolean;
  elements: readonly AiAnalysisRunElementResult[];
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
  usage: AiBudgetUsage;
  authenticationPreflightExecuted: boolean;
}>;

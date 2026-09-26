import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { CodexRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { analyzeCodex } from "./execution.js";

/** Codex解析段階を既存adapterへ接続する。 */
export function createAnalyzeWithCodexStage(
  adapters: CodexRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["analyzeWithCodex"] {
  return async ({ invocation, configuration, state, collection, deterministicAnalysis }) => {
    const analysis = await analyzeCodex(
      adapters,
      invocation,
      configuration,
      state,
      collection,
      deterministicAnalysis,
    );
    return Object.freeze({
      status: analysis.status,
      value: analysis.stage,
      aiCallCount: analysis.aiCallCount,
      aiCacheHitCount: analysis.aiCacheHitCount,
      aiRetainedResultCount: analysis.aiRetainedResultCount,
      estimatedInputTokens: analysis.estimatedInputTokens,
      diagnostics: analysis.diagnostics,
    });
  };
}

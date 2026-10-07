import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { finalizeDailyRun } from "../../publication/finalization-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;
type CompletionRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "environment"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "diagnosticsRecorder"
  | "now"
  | "sleep"
  | "random"
  | "observePerformanceDetail"
>;

/** 日次runの最終CASを共通stageへ接続する。 */
export function createFinalizeRunStage(
  adapters: CompletionRuntimeAdapters,
): SequentialStageDependencies["finalizeRun"] {
  return (input) => finalizeDailyRun(adapters, input);
}

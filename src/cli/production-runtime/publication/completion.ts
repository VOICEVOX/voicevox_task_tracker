import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { completeDailyRun } from "../../run-publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { completedSnapshotTrackingStartAt } from "../tracking-start-at.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type CompletionRuntimeAdapters = Pick<ProductionRuntimeAdapters, "now">;

/** 日次runの完了保存を既存公開処理へ接続する。 */
export function createCompleteRunStage(
  adapters: CompletionRuntimeAdapters,
): ProductionDailyDependencies["completeRun"] {
  return (input) =>
    completeDailyRun(
      { adapters, resolveCompletedTrackingStartAt: completedSnapshotTrackingStartAt },
      input,
    );
}

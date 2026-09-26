import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { persistDailyState } from "../../run-publication/daily-stage-handlers.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;

/** 完全性検証済みrunの初期保存を既存公開処理へ接続する。 */
export function createPersistStateStage(): ProductionDailyDependencies["persistState"] {
  return (input) => persistDailyState(input);
}

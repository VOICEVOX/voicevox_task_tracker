import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { buildDailyPages } from "../../run-publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type PagesRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "pagesOutputDirectory" | "writePublicData"
>;

/** 初期保存済みrunのPages生成を既存公開処理へ接続する。 */
export function createBuildPagesStage(
  adapters: PagesRuntimeAdapters,
): ProductionDailyDependencies["buildPages"] {
  return (input) => buildDailyPages({ adapters, normalizeLabelRules }, input);
}

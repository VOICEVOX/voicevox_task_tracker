import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { buildDailyPages, deployDailyPages } from "../../publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;
type PagesRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "pagesOutputDirectory"
  | "writePublicData"
  | "buildWebOutput"
  | "createStateBranchAdapter"
  | "repositoryPath"
  | "now"
  | "writeJsonArtifact"
>;

/** 初期保存済みrunのPages生成を既存公開処理へ接続する。 */
export function createBuildPagesStage(
  adapters: PagesRuntimeAdapters,
): SequentialStageDependencies["buildPages"] {
  return (input) => buildDailyPages({ adapters }, input);
}

/** 初回Pages intentをproduction portまたはsandbox記録へ接続する。 */
export function createDeployPagesStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    | "repositoryPath"
    | "createStateBranchAdapter"
    | "deployProductionPages"
    | "now"
    | "writeJsonArtifact"
  >,
): SequentialStageDependencies["deployPages"] {
  return (input) => deployDailyPages({ adapters }, input);
}

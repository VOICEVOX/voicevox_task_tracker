import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import {
  buildDailyNotificationHistoryPages,
  deployDailyNotificationHistoryPages,
} from "../../publication/daily-history-pages.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;

/** 最終stateから履歴Pagesのbuildを接続する。 */
export function createBuildNotificationHistoryPagesStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    | "repositoryPath"
    | "pagesOutputDirectory"
    | "createStateBranchAdapter"
    | "writePublicData"
    | "buildWebOutput"
    | "writeJsonArtifact"
    | "now"
  >,
): SequentialStageDependencies["buildNotificationHistoryPages"] {
  return (input) => buildDailyNotificationHistoryPages(adapters, input);
}

/** 同じ履歴Pages intentの公開直前検査とeffect結果を接続する。 */
export function createDeployNotificationHistoryPagesStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    | "repositoryPath"
    | "createStateBranchAdapter"
    | "deployProductionPages"
    | "writeJsonArtifact"
    | "now"
  >,
): SequentialStageDependencies["deployNotificationHistoryPages"] {
  return (input) => deployDailyNotificationHistoryPages(adapters, input);
}

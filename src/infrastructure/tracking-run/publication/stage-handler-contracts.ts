import type { SequentialRunDependencies } from "../sequential-run-contracts.js";

/** 完全性検証後の出力・永続化stageだけを受け持つ依存。 */
export type DailyPublicationStageHandlers = Pick<
  SequentialRunDependencies,
  | "buildPages"
  | "deployPages"
  | "settleNotifications"
  | "finalizeRun"
  | "writeCollectAnalyzeArtifact"
>;

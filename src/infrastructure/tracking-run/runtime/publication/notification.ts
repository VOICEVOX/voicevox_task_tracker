import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { settleDailyNotifications } from "../../publication/notification-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;
type NotificationRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "environment"
  | "repositoryPath"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "now"
  | "sleep"
  | "random"
  | "sendDiscord"
  | "diagnosticsRecorder"
>;

/** 日次runの通知settlementを共通stageへ接続する。 */
export function createSettleNotificationsStage(
  adapters: NotificationRuntimeAdapters,
): SequentialStageDependencies["settleNotifications"] {
  return (input) => settleDailyNotifications(adapters, input);
}

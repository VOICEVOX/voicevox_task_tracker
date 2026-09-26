import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  sendDailyDiscord,
  sendDailyOperationsAlert,
} from "../../run-publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
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
>;

/** 日次runのDiscord通知を既存公開処理へ接続する。 */
export function createSendDiscordStage(
  adapters: NotificationRuntimeAdapters,
): ProductionDailyDependencies["sendDiscord"] {
  return (input) => sendDailyDiscord({ adapters, normalizeLabelRules }, input);
}

/** 日次runの障害通知を既存公開処理へ接続する。 */
export function createSendOperationsAlertStage(
  adapters: NotificationRuntimeAdapters,
): ProductionDailyDependencies["sendOperationsAlert"] {
  return (input) => sendDailyOperationsAlert({ adapters }, input);
}

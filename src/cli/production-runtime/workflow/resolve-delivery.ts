import { resolveDiscordDelivery } from "../../notification-delivery-runtime.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type DeliveryResolutionRuntimeAdapters = Pick<
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

/** workflowの送信開始済み通知解決を既存処理へ接続する。 */
export function createResolveDiscordDeliveryStage(
  adapters: DeliveryResolutionRuntimeAdapters,
): WorkflowStageDependencies["resolveDiscordDelivery"] {
  return (command) => resolveDiscordDelivery(adapters, command);
}

import type { Config } from "../../config/index.js";
import type { DiscordDeliverySettings } from "../../discord/index.js";

const PAGES_BASE_URL = "https://voicevox.github.io";

/** Discord配送へ渡す現在の設定投影。 */
export function discordDeliverySettings(config: Config): DiscordDeliverySettings {
  return Object.freeze({
    enabled: config.notifications.discord.enabled,
    webhookSecretName: config.notifications.discord.webhookSecretName,
    operationsWebhookSecretName: config.notifications.discord.operationsWebhookSecretName,
    mentions: config.notifications.discord.mentions,
    retry: config.operations.retry,
  });
}

/** configのbase pathから公開Pages URLを組み立てる。 */
export function pagesUrl(config: Config): string {
  return new URL(config.web.basePath, PAGES_BASE_URL).href;
}

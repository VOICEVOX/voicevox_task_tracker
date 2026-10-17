import type { PublicationInputs } from "../../../application/tracking-run/contracts/publication-inputs.js";
import { normalizeLabelRules } from "../../../application/tracking-run/stages/collection-label-rules.js";
import { serializeCanonicalJson } from "../../../canonical-json/index.js";
import type { Config } from "../../../config/index.js";
import type { DiscordDeliverySettings } from "../../../discord/index.js";
import { createUtcIsoDateTime } from "../../../domain/index.js";
import { PUBLIC_SUMMARY_GZIP_LIMIT_BYTES } from "../../../pages/index.js";

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

/** 設定本文から公開計画が利用する公開可能な値だけを投影する。 */
export function projectPublicationSettings(
  config: Config,
): Pick<PublicationInputs, "pages" | "discord" | "configuredTrackingStartAt"> {
  const labelRules = [...normalizeLabelRules(config)].sort((left, right) => {
    const leftKey = serializeCanonicalJson(left);
    const rightKey = serializeCanonicalJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze({
    pages: {
      url: pagesUrl(config),
      confidenceThresholds: config.ai.confidence,
      labelRules,
      maxInitialGraphNodes: config.web.graph.maxInitialNodes,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: config.staleness.timezone,
    },
    discord: discordDeliverySettings(config),
    configuredTrackingStartAt:
      config.tracking.startAt == null
        ? { status: "not_configured" }
        : { status: "configured", value: createUtcIsoDateTime(config.tracking.startAt) },
  });
}

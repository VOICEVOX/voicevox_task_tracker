import { createHash } from "node:crypto";

import { type OperationsAlertKind } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { DiscordPayloadError } from "./errors.js";
import type {
  BuildDiscordDigestPlanInput,
  DiscordDigestPlan,
  DiscordOperationsAlertPlan,
  DiscordOperationsIncident,
  DiscordWebhookPayload,
} from "./payload-contracts.js";
import { INCIDENT_ID_PATTERN } from "./payload-contracts.js";
import {
  assertDiscordWebhookPayloadWithinLimits,
  compareCategory,
  createAllowedMentions,
  createDigestContent,
  createDigestId,
  createPayloadFromDraft,
  packFields,
  validateDigestInputs,
} from "./payload-packing.js";
import { createFieldDraft } from "./payload-presentation.js";
import { createMentionLookup, formatJst, parseTimestamp } from "./payload-text.js";

/** 選別済み候補から制限内へ分割した決定論的なDiscord digest計画を生成する。 */
export function buildDiscordDigestPlan(input: BuildDiscordDigestPlanInput): DiscordDigestPlan {
  if (input.candidates.length === 0) {
    if (input.ledgerReservations.length !== 0) {
      throw new DiscordPayloadError("通知候補が0件のときledger予約は空にしてください");
    }
    return Object.freeze({
      digestId: createDigestId([]),
      messages: Object.freeze([]),
    });
  }
  const { itemsByNodeId, pagesUrl } = validateDigestInputs(input);
  const generatedTimestamp = parseTimestamp(input.generatedAt, "digest集計時刻");
  const mentionLookup = createMentionLookup(input.mentions);
  const itemReferences = new Map(input.items.map((item) => [item.nodeId, item.displayReference]));
  const fields = input.candidates
    .map((candidate) => {
      const item = itemsByNodeId.get(candidate.itemNodeId);
      assertNonNullable(item, `${candidate.itemNodeId}の追跡項目を取得できませんでした`);
      return createFieldDraft(
        candidate,
        item,
        pagesUrl,
        generatedTimestamp,
        itemReferences,
        mentionLookup,
        input.mentions.enabled,
      );
    })
    .sort((left, right) => compareCategory(left.category, right.category));
  const messageDrafts = packFields(fields);
  const digestId = createDigestId(input.candidates);
  const messages = messageDrafts.map((message, index) => {
    const payload = createPayloadFromDraft(
      message,
      createDigestContent(
        digestId,
        input.pagesUrl,
        generatedTimestamp,
        index + 1,
        messageDrafts.length,
      ),
    );
    assertDiscordWebhookPayloadWithinLimits(payload);
    return Object.freeze({
      payload,
      itemNodeIds: Object.freeze([...message.itemNodeIds]),
      notificationKeys: Object.freeze([...message.notificationKeys]),
    });
  });
  return Object.freeze({
    digestId,
    messages: Object.freeze(messages),
  });
}

function operationsKindText(kind: OperationsAlertKind): string {
  switch (kind) {
    case "collection":
      return "収集・解析の失敗";
    case "pages":
      return "Pages公開";
    case "discord":
      return "Discord通知";
  }
}

function operationsSummary(kind: OperationsAlertKind): string {
  switch (kind) {
    case "collection":
      return "収集・解析に失敗したため、公開処理を停止しました";
    case "pages":
      return "Pages公開に失敗したため、通常digestを停止しました";
    case "discord":
      return "通常digestのDiscord送信を完了できませんでした。送信結果を確認してください";
  }
}

/** 重大な運用障害を通常digestと区別した1件のDiscord payloadへ変換する。 */
export function buildDiscordOperationsAlertPlan(
  incident: DiscordOperationsIncident,
): DiscordOperationsAlertPlan {
  if (!INCIDENT_ID_PATTERN.test(incident.incidentId)) {
    throw new DiscordPayloadError("運用障害のincident IDが不正です");
  }
  if (!Number.isSafeInteger(incident.retryAttempts) || incident.retryAttempts <= 0) {
    throw new DiscordPayloadError("運用障害のretry回数は正の安全な整数にしてください");
  }
  const occurredTimestamp = parseTimestamp(incident.occurredAt, "運用障害の発生時刻");
  const alertHash = createHash("sha256")
    .update(JSON.stringify([incident.kind, incident.incidentId]))
    .digest("hex")
    .slice(0, 24);
  const alertKey = `discord-operations-alert:v1:${alertHash}`;
  const payload = Object.freeze({
    content: ["VOICEVOX Task Tracker 運用障害", `alert ID: ${alertKey}`].join("\n"),
    embeds: Object.freeze([
      Object.freeze({
        title: "運用障害",
        fields: Object.freeze([
          Object.freeze({
            name: "処理",
            value: operationsKindText(incident.kind),
            inline: false,
          }),
          Object.freeze({
            name: "発生時刻",
            value: formatJst(occurredTimestamp),
            inline: false,
          }),
          Object.freeze({
            name: "概要",
            value: operationsSummary(incident.kind),
            inline: false,
          }),
          ...(incident.kind === "collection"
            ? []
            : [
                Object.freeze({
                  name: "試行回数",
                  value: incident.retryAttempts.toString(),
                  inline: false,
                }),
              ]),
          Object.freeze({
            name: "incident ID",
            value: incident.incidentId,
            inline: false,
          }),
        ]),
      }),
    ]),
    allowed_mentions: createAllowedMentions([]),
  } satisfies DiscordWebhookPayload);
  assertDiscordWebhookPayloadWithinLimits(payload);
  return Object.freeze({
    alertKey,
    payload,
  });
}

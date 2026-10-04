import { createHash } from "node:crypto";

import { type GitHubNodeId, type TrackedItem } from "../domain/index.js";
import { DiscordPayloadError } from "./errors.js";
import type { DiscordNotificationCandidate } from "./notification-selection-contracts.js";
import type {
  BuildDiscordDigestPlanInput,
  DigestFieldDraft,
  DiscordAllowedMentions,
  DiscordDigestCategory,
  DiscordPayloadSize,
  DiscordWebhookPayload,
  MutableMessageDraft,
} from "./payload-contracts.js";
import {
  DISCORD_API_LIMITS,
  DISCORD_SAFE_LIMITS,
  DISCORD_USER_ID_PATTERN,
} from "./payload-contracts.js";
import { assertDiscordPersonalReminderSelectionMatchesItems } from "./payload-personal-reminder-validation.js";
import {
  categoryTitle,
  characterCount,
  formatJst,
  parseTimestamp,
  validateHttpsUrl,
} from "./payload-text.js";

export function validateDigestInputs(input: BuildDiscordDigestPlanInput): Readonly<{
  itemsByNodeId: ReadonlyMap<GitHubNodeId, TrackedItem>;
  pagesUrl: URL;
}> {
  parseTimestamp(input.generatedAt, "digest集計時刻");
  const pagesUrl = validateHttpsUrl(input.pagesUrl, "Pages URL");
  const itemsByNodeId = new Map(input.items.map((item) => [item.nodeId, item]));
  if (itemsByNodeId.size !== input.items.length) {
    throw new DiscordPayloadError("追跡項目のnode IDが重複しています");
  }
  const candidateNodeIds = input.candidates.map((candidate) => candidate.itemNodeId);
  if (new Set(candidateNodeIds).size !== candidateNodeIds.length) {
    throw new DiscordPayloadError("通知候補のnode IDが重複しています");
  }
  assertDiscordPersonalReminderSelectionMatchesItems(input.candidates, input.items);

  const reservationsByKey = new Map(
    input.ledgerReservations.map((reservation) => [reservation.notificationKey, reservation]),
  );
  if (reservationsByKey.size !== input.ledgerReservations.length) {
    throw new DiscordPayloadError("ledger予約のnotification keyが重複しています");
  }
  const candidateKeys: string[] = [];
  for (const candidate of input.candidates) {
    if (!itemsByNodeId.has(candidate.itemNodeId)) {
      throw new DiscordPayloadError(`通知候補 ${candidate.itemNodeId}の追跡項目がありません`);
    }
    for (const reason of candidate.reasons) {
      const reservation = reservationsByKey.get(reason.notificationKey);
      if (
        reservation?.status !== "reserved" ||
        reservation.itemNodeId !== candidate.itemNodeId ||
        reservation.reasonCode !== reason.reasonCode ||
        reservation.severity !== reason.severity
      ) {
        throw new DiscordPayloadError("通知候補とledger予約が一致しません");
      }
      candidateKeys.push(reason.notificationKey);
    }
  }
  if (
    new Set(candidateKeys).size !== candidateKeys.length ||
    candidateKeys.length !== input.ledgerReservations.length
  ) {
    throw new DiscordPayloadError("通知候補とledger予約が1対1に対応していません");
  }
  return Object.freeze({
    itemsByNodeId,
    pagesUrl,
  });
}

function emptyMessageDraft(): MutableMessageDraft {
  return {
    embeds: [],
    itemNodeIds: [],
    notificationKeys: [],
    mentionedUserIds: [],
  };
}

function appendField(
  message: MutableMessageDraft,
  fieldDraft: DigestFieldDraft,
): MutableMessageDraft {
  const embeds = message.embeds.map((embed) => ({
    category: embed.category,
    fields: [...embed.fields],
  }));
  const existingEmbed = embeds.find((embed) => embed.category === fieldDraft.category);
  if (existingEmbed == null) {
    embeds.push({
      category: fieldDraft.category,
      fields: [fieldDraft.field],
    });
  } else {
    existingEmbed.fields.push(fieldDraft.field);
  }
  return {
    embeds,
    itemNodeIds: [...message.itemNodeIds, fieldDraft.itemNodeId],
    notificationKeys: [...message.notificationKeys, ...fieldDraft.notificationKeys],
    mentionedUserIds: [
      ...new Set([...message.mentionedUserIds, ...fieldDraft.mentionedUserIds]),
    ].sort(),
  };
}

export function createAllowedMentions(userIds: readonly string[]): DiscordAllowedMentions {
  return Object.freeze({
    parse: Object.freeze([]),
    roles: Object.freeze([]),
    users: Object.freeze([...userIds]),
    replied_user: false,
  });
}

export function createPayloadFromDraft(
  message: MutableMessageDraft,
  content: string,
): DiscordWebhookPayload {
  return Object.freeze({
    content,
    embeds: Object.freeze(
      message.embeds.map((embed) =>
        Object.freeze({
          title: categoryTitle(embed.category),
          fields: Object.freeze(
            embed.fields.map((field) =>
              Object.freeze({
                ...field,
              }),
            ),
          ),
        }),
      ),
    ),
    allowed_mentions: createAllowedMentions(message.mentionedUserIds),
  });
}

export function createDigestContent(
  digestId: string,
  pagesUrl: string,
  generatedTimestamp: number,
  messageIndex: number,
  messageCount: number,
): string {
  return [
    "VOICEVOX Task Tracker 日次digest",
    `集計時刻: ${formatJst(generatedTimestamp)}`,
    `公開ページ: ${pagesUrl}`,
    `digest ID: ${digestId}`,
    `メッセージ: ${messageIndex.toString()}/${messageCount.toString()}`,
  ].join("\n");
}

export function createDigestId(candidates: readonly DiscordNotificationCandidate[]): string {
  const notificationKeys = candidates
    .flatMap((candidate) => candidate.reasons.map((reason) => reason.notificationKey))
    .sort();
  const digestHash = createHash("sha256")
    .update(JSON.stringify(notificationKeys))
    .digest("hex")
    .slice(0, 24);
  return `discord-digest:v1:${digestHash}`;
}

function fitsDiscordPayload(payload: DiscordWebhookPayload): boolean {
  try {
    assertDiscordWebhookPayloadWithinLimits(payload);
    return true;
  } catch (error: unknown) {
    if (error instanceof DiscordPayloadError) {
      return false;
    }
    throw error;
  }
}

export function packFields(fields: readonly DigestFieldDraft[]): readonly MutableMessageDraft[] {
  const messages: MutableMessageDraft[] = [];
  let current = emptyMessageDraft();
  for (const field of fields) {
    const projected = appendField(current, field);
    if (fitsDiscordPayload(createPayloadFromDraft(projected, ""))) {
      current = projected;
      continue;
    }
    if (current.itemNodeIds.length === 0) {
      throw new DiscordPayloadError(`${field.itemNodeId}を単独messageの安全上限内に収められません`);
    }
    messages.push(current);
    current = appendField(emptyMessageDraft(), field);
    assertDiscordWebhookPayloadWithinLimits(createPayloadFromDraft(current, ""));
  }
  if (current.itemNodeIds.length > 0) {
    messages.push(current);
  }
  return Object.freeze(messages);
}

export function compareCategory(
  left: DiscordDigestCategory,
  right: DiscordDigestCategory,
): -1 | 0 | 1 {
  const order = {
    blocking: 0,
    unknown_responsibility: 1,
    important_change: 2,
  } satisfies Readonly<Record<DiscordDigestCategory, number>>;
  const difference = order[left] - order[right];
  if (difference < 0) {
    return -1;
  }
  if (difference > 0) {
    return 1;
  }
  return 0;
}

/** Discord payloadのembed数、文字数、field数、mention数を計算する。 */
export function calculateDiscordPayloadSize(payload: DiscordWebhookPayload): DiscordPayloadSize {
  const fieldsPerEmbed = payload.embeds.map((embed) => embed.fields.length);
  const embedCharacters = payload.embeds.reduce(
    (messageTotal, embed) =>
      messageTotal +
      characterCount(embed.title) +
      embed.fields.reduce(
        (embedTotal, field) =>
          embedTotal + characterCount(field.name) + characterCount(field.value),
        0,
      ),
    0,
  );
  return Object.freeze({
    contentCharacters: characterCount(payload.content),
    embedCount: payload.embeds.length,
    embedCharacters,
    fieldCount: fieldsPerEmbed.reduce((total, value) => total + value, 0),
    fieldsPerEmbed: Object.freeze(fieldsPerEmbed),
    allowedMentionUserCount: payload.allowed_mentions.users.length,
  });
}

/** Discord APIのhard limitより余裕を持たせた上限へpayloadが収まることを検証する。 */
export function assertDiscordWebhookPayloadWithinLimits(payload: DiscordWebhookPayload): void {
  const size = calculateDiscordPayloadSize(payload);
  if (payload.content.length === 0 && payload.embeds.length === 0) {
    throw new DiscordPayloadError("contentまたはembedを1件以上設定してください");
  }
  if (
    size.contentCharacters > DISCORD_SAFE_LIMITS.contentCharacters ||
    size.contentCharacters > DISCORD_API_LIMITS.contentCharacters
  ) {
    throw new DiscordPayloadError("contentの文字数が安全上限を超えています");
  }
  if (size.embedCount > DISCORD_SAFE_LIMITS.embeds || size.embedCount > DISCORD_API_LIMITS.embeds) {
    throw new DiscordPayloadError("embed数が安全上限を超えています");
  }
  if (
    size.embedCharacters > DISCORD_SAFE_LIMITS.embedCharacters ||
    size.embedCharacters > DISCORD_API_LIMITS.embedCharacters
  ) {
    throw new DiscordPayloadError("embedの合計文字数が安全上限を超えています");
  }
  if (size.fieldCount > DISCORD_SAFE_LIMITS.fieldsPerMessage) {
    throw new DiscordPayloadError("message内のfield数が安全上限を超えています");
  }
  if (
    size.allowedMentionUserCount > DISCORD_SAFE_LIMITS.allowedMentionUsers ||
    size.allowedMentionUserCount > DISCORD_API_LIMITS.allowedMentionUsers
  ) {
    throw new DiscordPayloadError("許可するuser mention数が安全上限を超えています");
  }
  if (payload.allowed_mentions.parse.length !== 0 || payload.allowed_mentions.roles.length !== 0) {
    throw new DiscordPayloadError("roleとeveryoneを含む自動mentionは許可できません");
  }
  if (payload.allowed_mentions.replied_user) {
    throw new DiscordPayloadError("返信先userの自動mentionは許可できません");
  }
  if (
    new Set(payload.allowed_mentions.users).size !== payload.allowed_mentions.users.length ||
    payload.allowed_mentions.users.some((userId) => !DISCORD_USER_ID_PATTERN.test(userId))
  ) {
    throw new DiscordPayloadError("許可するuser mention IDが不正または重複しています");
  }
  for (const embed of payload.embeds) {
    if (
      characterCount(embed.title) === 0 ||
      characterCount(embed.title) > DISCORD_SAFE_LIMITS.embedTitleCharacters ||
      characterCount(embed.title) > DISCORD_API_LIMITS.embedTitleCharacters
    ) {
      throw new DiscordPayloadError("embed titleの文字数が安全上限外です");
    }
    if (
      embed.fields.length === 0 ||
      embed.fields.length > DISCORD_SAFE_LIMITS.fieldsPerEmbed ||
      embed.fields.length > DISCORD_API_LIMITS.fieldsPerEmbed
    ) {
      throw new DiscordPayloadError("embedのfield数が安全上限外です");
    }
    for (const field of embed.fields) {
      if (
        characterCount(field.name) === 0 ||
        characterCount(field.name) > DISCORD_SAFE_LIMITS.fieldNameCharacters ||
        characterCount(field.name) > DISCORD_API_LIMITS.fieldNameCharacters
      ) {
        throw new DiscordPayloadError("field名の文字数が安全上限外です");
      }
      if (
        characterCount(field.value) === 0 ||
        characterCount(field.value) > DISCORD_SAFE_LIMITS.fieldValueCharacters ||
        characterCount(field.value) > DISCORD_API_LIMITS.fieldValueCharacters
      ) {
        throw new DiscordPayloadError("field値の文字数が安全上限外です");
      }
      if (field.inline) {
        throw new DiscordPayloadError("digestのfieldはinlineにできません");
      }
    }
  }
}

import { createHash } from "node:crypto";

import { DiscordPayloadError } from "./errors.js";
import {
  type DiscordNotificationCandidate,
  type DiscordNotificationReasonCode,
} from "./notification-selection.js";
import {
  type GitHubNodeId,
  type NotificationLedgerEntry,
  notificationReasonText,
  type OperationsAlertKind,
  type TrackedItem,
  type UtcIsoDateTime,
  type WaitingOn,
  type WaitingOnRole,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

const DISCORD_API_LIMITS = Object.freeze({
  contentCharacters: 2000,
  embeds: 10,
  embedCharacters: 6000,
  embedTitleCharacters: 256,
  fieldsPerEmbed: 25,
  fieldNameCharacters: 256,
  fieldValueCharacters: 1024,
  allowedMentionUsers: 100,
});
const DISCORD_SAFE_LIMITS = Object.freeze({
  contentCharacters: 1800,
  embeds: 8,
  embedCharacters: 5500,
  embedTitleCharacters: 240,
  fieldsPerEmbed: 20,
  fieldsPerMessage: 20,
  fieldNameCharacters: 240,
  fieldValueCharacters: 1000,
  allowedMentionUsers: 90,
});
const GITHUB_URL_MAX_CHARACTERS = 400;
const TITLE_MAX_CHARACTERS = 256;
const WAITING_ON_MAX_CHARACTERS = 280;
const JST_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;
const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/u;
const INCIDENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

type DiscordDigestCategory = "blocking" | "unknown_responsibility" | "important_change";

export type DiscordAllowedMentions = Readonly<{
  parse: readonly ("everyone" | "roles" | "users")[];
  roles: readonly string[];
  users: readonly string[];
  replied_user: boolean;
}>;

export type DiscordEmbedField = Readonly<{
  name: string;
  value: string;
  inline: boolean;
}>;

export type DiscordEmbed = Readonly<{
  title: string;
  fields: readonly DiscordEmbedField[];
}>;

export type DiscordWebhookPayload = Readonly<{
  content: string;
  embeds: readonly DiscordEmbed[];
  allowed_mentions: DiscordAllowedMentions;
}>;

export type DiscordPayloadSize = Readonly<{
  contentCharacters: number;
  embedCount: number;
  embedCharacters: number;
  fieldCount: number;
  fieldsPerEmbed: readonly number[];
  allowedMentionUserCount: number;
}>;

export type DiscordMentionSettings = Readonly<{
  enabled: boolean;
  users: Readonly<Record<string, string>>;
}>;

export type BuildDiscordDigestPlanInput = Readonly<{
  candidates: readonly DiscordNotificationCandidate[];
  ledgerReservations: readonly NotificationLedgerEntry[];
  items: readonly TrackedItem[];
  pagesUrl: string;
  generatedAt: UtcIsoDateTime;
  mentions: DiscordMentionSettings;
}>;

export type PreparedDiscordDigestMessage = Readonly<{
  payload: DiscordWebhookPayload;
  itemNodeIds: readonly GitHubNodeId[];
  notificationKeys: readonly string[];
}>;

export type DiscordDigestPlan = Readonly<{
  digestId: string;
  messages: readonly PreparedDiscordDigestMessage[];
}>;

export type DiscordOperationsIncident = Readonly<{
  incidentId: string;
  kind: OperationsAlertKind;
  occurredAt: UtcIsoDateTime;
  retryAttempts: number;
}>;

export type DiscordOperationsAlertPlan = Readonly<{
  alertKey: string;
  payload: DiscordWebhookPayload;
}>;

type WaitingOnText = Readonly<{
  text: string;
  mentionedUserIds: readonly string[];
}>;

type DigestFieldDraft = Readonly<{
  category: DiscordDigestCategory;
  field: DiscordEmbedField;
  itemNodeId: GitHubNodeId;
  notificationKeys: readonly string[];
  mentionedUserIds: readonly string[];
}>;

interface MutableEmbedDraft {
  category: DiscordDigestCategory;
  fields: DiscordEmbedField[];
}

interface MutableMessageDraft {
  embeds: MutableEmbedDraft[];
  itemNodeIds: GitHubNodeId[];
  notificationKeys: string[];
  mentionedUserIds: string[];
}

function characterCount(value: string): number {
  return value.length;
}

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DiscordPayloadError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function validateHttpsUrl(value: string, context: string): URL {
  if (!URL.canParse(value)) {
    throw new DiscordPayloadError(`${context}はURLとして解釈できません`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new DiscordPayloadError(
      `${context}はcredentialとfragmentを含まないHTTPS URLにしてください`,
    );
  }
  return url;
}

function validateGitHubUrl(value: string): void {
  const url = validateHttpsUrl(value, "GitHub URL");
  if (url.hostname !== "github.com" || characterCount(value) > GITHUB_URL_MAX_CHARACTERS) {
    throw new DiscordPayloadError("GitHub URLはgithub.comのURLとして安全な長さにしてください");
  }
}

function truncateText(value: string, maximumCharacters: number): string {
  if (characterCount(value) <= maximumCharacters) {
    return value;
  }
  if (maximumCharacters <= 1) {
    throw new DiscordPayloadError("文字列の短縮上限は2文字以上にしてください");
  }
  let truncated = value.slice(0, maximumCharacters - 1);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function normalizeInlineText(value: string, context: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    throw new DiscordPayloadError(`${context}は空にできません`);
  }
  return normalized;
}

function formatJst(timestamp: number): string {
  const jstDate = new Date(timestamp + JST_OFFSET_MILLISECONDS);
  const year = jstDate.getUTCFullYear().toString();
  const month = (jstDate.getUTCMonth() + 1).toString();
  const day = jstDate.getUTCDate().toString();
  const hour = jstDate.getUTCHours().toString().padStart(2, "0");
  const minute = jstDate.getUTCMinutes().toString().padStart(2, "0");
  return `${year}年${month}月${day}日 ${hour}:${minute} JST`;
}

function formatElapsedTime(startTimestamp: number, endTimestamp: number): string {
  if (startTimestamp > endTimestamp) {
    throw new DiscordPayloadError("経過時間の起点は集計時刻以前にしてください");
  }
  const elapsedMilliseconds = endTimestamp - startTimestamp;
  const elapsedMinutes = Math.floor(elapsedMilliseconds / MILLISECONDS_PER_MINUTE);
  const elapsedHours = Math.floor(elapsedMinutes / MINUTES_PER_HOUR);
  if (elapsedHours < 1) {
    return `${elapsedMinutes.toString()}分`;
  }
  if (elapsedHours < 24) {
    return `${elapsedHours.toString()}時間`;
  }
  const elapsedDays = Math.floor(elapsedMinutes / MINUTES_PER_DAY);
  const remainingHours = Math.floor((elapsedMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  if (elapsedMilliseconds <= 7 * MINUTES_PER_DAY * MILLISECONDS_PER_MINUTE) {
    if (remainingHours === 0) {
      return `${elapsedDays.toString()}日`;
    }
    return `${elapsedDays.toString()}日 ${remainingHours.toString()}時間`;
  }
  if (elapsedMilliseconds <= 365 * MINUTES_PER_DAY * MILLISECONDS_PER_MINUTE) {
    return `${elapsedDays.toString()}日`;
  }
  const elapsedYears = Math.floor(elapsedDays / 365);
  const remainingDays = elapsedDays % 365;
  if (remainingDays === 0) {
    return `${elapsedYears.toString()}年`;
  }
  return `${elapsedYears.toString()}年 ${remainingDays.toString()}日`;
}

function categoryForReason(reasonCode: DiscordNotificationReasonCode): DiscordDigestCategory {
  switch (reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "owner_unknown":
      return "unknown_responsibility";
    case "newly_unblocked":
    case "responsibility_changed":
      return "important_change";
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "blocker_overdue":
    case "dependency_cycle":
    case "merge_overdue":
    case "automation_stuck":
      return "blocking";
  }
}

function categoryTitle(category: DiscordDigestCategory): string {
  switch (category) {
    case "blocking":
      return "停止要因";
    case "unknown_responsibility":
      return "内容確認または担当が未確定";
    case "important_change":
      return "新規解消や重要な変化";
  }
}

function roleText(role: WaitingOnRole): string {
  switch (role) {
    case "author":
      return "author";
    case "maintainer":
      return "メンテナー";
    case "reviewer":
      return "レビュワー";
    case "assignee":
      return "assignee";
    case "respondent":
      return "回答者";
    case "dependency":
      return "依存項目";
    case "merge_decider":
      return "merge判断者";
    case "ci":
      return "自動処理";
    case "unknown":
      return "不明";
  }
}

function createMentionLookup(settings: DiscordMentionSettings): ReadonlyMap<string, string> {
  const users = new Map<string, string>();
  for (const [login, userId] of Object.entries(settings.users)) {
    const normalizedLogin = normalizeInlineText(
      login,
      "Discord mentionのGitHub login",
    ).toLowerCase();
    if (!DISCORD_USER_ID_PATTERN.test(userId)) {
      throw new DiscordPayloadError("Discord mentionのuser IDは数字17桁から20桁にしてください");
    }
    const existing = users.get(normalizedLogin);
    if (existing != null && existing !== userId) {
      throw new DiscordPayloadError(
        "GitHub loginの大文字と小文字を無視するとmention設定が重複します",
      );
    }
    users.set(normalizedLogin, userId);
  }
  return users;
}

function renderWaitingOn(
  waitingOn: WaitingOn,
  itemReferences: ReadonlyMap<string, string>,
  mentionLookup: ReadonlyMap<string, string>,
  mentionsEnabled: boolean,
): Readonly<{
  text: string;
  mentionedUserId: string | undefined;
}> {
  switch (waitingOn.kind) {
    case "user": {
      const userId = mentionLookup.get(waitingOn.candidateId.toLowerCase());
      if (mentionsEnabled && userId != null) {
        return {
          text: `<@${userId}>`,
          mentionedUserId: userId,
        };
      }
      return {
        text: `@${normalizeInlineText(waitingOn.candidateId, "waitingOn user")}`,
        mentionedUserId: undefined,
      };
    }
    case "team":
      return {
        text: `チーム ${normalizeInlineText(waitingOn.candidateId, "waitingOn team")}`,
        mentionedUserId: undefined,
      };
    case "role":
      return {
        text: roleText(waitingOn.role),
        mentionedUserId: undefined,
      };
    case "item":
      return {
        text:
          itemReferences.get(waitingOn.candidateId) ??
          normalizeInlineText(waitingOn.candidateId, "waitingOn item"),
        mentionedUserId: undefined,
      };
    case "automation":
      return {
        text: `自動処理 ${normalizeInlineText(waitingOn.candidateId, "waitingOn automation")}`,
        mentionedUserId: undefined,
      };
    case "unknown":
      return {
        text: "不明",
        mentionedUserId: undefined,
      };
  }
}

function formatWaitingOn(
  waitingOnValues: readonly WaitingOn[],
  itemReferences: ReadonlyMap<string, string>,
  mentionLookup: ReadonlyMap<string, string>,
  mentionsEnabled: boolean,
): WaitingOnText {
  if (waitingOnValues.length === 0) {
    throw new DiscordPayloadError("通知項目のwaitingOnは1件以上必要です");
  }
  const rendered = waitingOnValues.map((waitingOn) =>
    renderWaitingOn(waitingOn, itemReferences, mentionLookup, mentionsEnabled),
  );
  const labels: string[] = [];
  const mentionedUserIds: string[] = [];
  for (const [index, value] of rendered.entries()) {
    const normalized = normalizeInlineText(value.text, "waitingOn表示");
    const separatorCharacters = labels.length === 0 ? 0 : 2;
    const currentCharacters = characterCount(labels.join("、"));
    const remainingCount = rendered.length - index;
    if (
      currentCharacters + separatorCharacters + characterCount(normalized) >
      WAITING_ON_MAX_CHARACTERS
    ) {
      const omitted = `ほか${remainingCount.toString()}件`;
      if (
        currentCharacters + separatorCharacters + characterCount(omitted) <=
        WAITING_ON_MAX_CHARACTERS
      ) {
        labels.push(omitted);
      }
      break;
    }
    labels.push(normalized);
    if (value.mentionedUserId != null) {
      mentionedUserIds.push(value.mentionedUserId);
    }
  }
  if (labels.length === 0) {
    const first = rendered[0];
    assertNonNullable(first, "waitingOn表示を取得できませんでした");
    labels.push(truncateText(first.text, WAITING_ON_MAX_CHARACTERS));
    if (first.mentionedUserId != null && labels[0] === first.text) {
      mentionedUserIds.push(first.mentionedUserId);
    }
  }
  return Object.freeze({
    text: labels.join("、"),
    mentionedUserIds: Object.freeze([...new Set(mentionedUserIds)].sort()),
  });
}

function createFieldName(item: TrackedItem): string {
  const reference = normalizeInlineText(item.displayReference, "表示用参照");
  if (characterCount(reference) > DISCORD_SAFE_LIMITS.fieldNameCharacters) {
    throw new DiscordPayloadError("owner/repo#numberがfield名の安全上限を超えています");
  }
  return reference;
}

function createFieldDraft(
  candidate: DiscordNotificationCandidate,
  item: TrackedItem,
  generatedTimestamp: number,
  itemReferences: ReadonlyMap<string, string>,
  mentionLookup: ReadonlyMap<string, string>,
  mentionsEnabled: boolean,
): DigestFieldDraft {
  if (candidate.itemNodeId !== item.nodeId) {
    throw new DiscordPayloadError("通知候補と追跡項目のnode IDが一致しません");
  }
  if (candidate.downstreamImpact.nodeId !== candidate.itemNodeId) {
    throw new DiscordPayloadError("通知候補のdownstream impactが別の項目を参照しています");
  }
  validateGitHubUrl(item.url);
  const stallTimestamp = parseTimestamp(item.stallSince, `${item.displayReference}のstallSince`);
  const waitingOn = formatWaitingOn(item.waitingOn, itemReferences, mentionLookup, mentionsEnabled);
  const title = truncateText(normalizeInlineText(item.title, "タイトル"), TITLE_MAX_CHARACTERS);
  const reasons = candidate.reasons.map((reason) => notificationReasonText(reason));
  const firstReason = candidate.reasons[0];
  assertNonNullable(firstReason, `${candidate.itemNodeId}の通知理由を取得できませんでした`);
  const value = [
    `タイトル: ${title}`,
    `waitingOn: ${waitingOn.text}`,
    `経過時間: ${formatElapsedTime(stallTimestamp, generatedTimestamp)}、${formatJst(stallTimestamp)}から`,
    `理由: ${reasons.join("、")}`,
    `GitHub: ${item.url}`,
  ].join("\n");
  if (characterCount(value) > DISCORD_SAFE_LIMITS.fieldValueCharacters) {
    throw new DiscordPayloadError(`${item.displayReference}のfield値が安全上限を超えています`);
  }
  return Object.freeze({
    category: categoryForReason(firstReason.reasonCode),
    field: Object.freeze({
      name: createFieldName(item),
      value,
      inline: false,
    }),
    itemNodeId: item.nodeId,
    notificationKeys: Object.freeze(candidate.reasons.map((reason) => reason.notificationKey)),
    mentionedUserIds: waitingOn.mentionedUserIds,
  });
}

function validateDigestInputs(
  input: BuildDiscordDigestPlanInput,
): ReadonlyMap<GitHubNodeId, TrackedItem> {
  parseTimestamp(input.generatedAt, "digest集計時刻");
  validateHttpsUrl(input.pagesUrl, "Pages URL");
  const itemsByNodeId = new Map(input.items.map((item) => [item.nodeId, item]));
  if (itemsByNodeId.size !== input.items.length) {
    throw new DiscordPayloadError("追跡項目のnode IDが重複しています");
  }
  const candidateNodeIds = input.candidates.map((candidate) => candidate.itemNodeId);
  if (new Set(candidateNodeIds).size !== candidateNodeIds.length) {
    throw new DiscordPayloadError("通知候補のnode IDが重複しています");
  }

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
        reservation.severity !== candidate.severity ||
        reservation.cooldownUntil !== reason.cooldownUntil
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
  return itemsByNodeId;
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

function createAllowedMentions(userIds: readonly string[]): DiscordAllowedMentions {
  return Object.freeze({
    parse: Object.freeze([]),
    roles: Object.freeze([]),
    users: Object.freeze([...userIds]),
    replied_user: false,
  });
}

function createPayloadFromDraft(
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

function createDigestContent(
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

function createDigestId(candidates: readonly DiscordNotificationCandidate[]): string {
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

function packFields(fields: readonly DigestFieldDraft[]): readonly MutableMessageDraft[] {
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

function compareCategory(left: DiscordDigestCategory, right: DiscordDigestCategory): -1 | 0 | 1 {
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
  const itemsByNodeId = validateDigestInputs(input);
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
      return "GitHub収集";
    case "pages":
      return "Pages公開";
    case "discord":
      return "Discord通知";
  }
}

function operationsSummary(kind: OperationsAlertKind): string {
  switch (kind) {
    case "collection":
      return "GitHub収集がretry上限に達したため、公開処理を停止しました";
    case "pages":
      return "Pages公開に失敗したため、通常digestを停止しました";
    case "discord":
      return "通常digestのDiscord送信がretry上限に達しました";
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
          Object.freeze({
            name: "retry回数",
            value: incident.retryAttempts.toString(),
            inline: false,
          }),
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

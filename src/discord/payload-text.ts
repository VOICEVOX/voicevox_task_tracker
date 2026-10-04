import {
  type PersonalReminderResponsible,
  type PersonalReminderTimeBasis,
  type TrackedItem,
  type UtcIsoDateTime,
  type WaitingOn,
  type WaitingOnRole,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { DiscordPayloadError } from "./errors.js";
import type { DiscordNotificationReasonCode } from "./notification-selection-contracts.js";
import type {
  DiscordDigestCategory,
  DiscordMentionSettings,
  WaitingOnReference,
  WaitingOnText,
} from "./payload-contracts.js";
import {
  DISCORD_USER_ID_PATTERN,
  GITHUB_URL_MAX_CHARACTERS,
  JST_OFFSET_MILLISECONDS,
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  PUBLIC_ITEM_DISPLAY_REFERENCE_PATTERN,
  WAITING_ON_MAX_CHARACTERS,
} from "./payload-contracts.js";

export function characterCount(value: string): number {
  return value.length;
}

export function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DiscordPayloadError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

export function validateHttpsUrl(value: string, context: string): URL {
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

export function validateGitHubUrl(value: string): void {
  const url = validateHttpsUrl(value, "GitHub URL");
  if (url.hostname !== "github.com" || characterCount(value) > GITHUB_URL_MAX_CHARACTERS) {
    throw new DiscordPayloadError("GitHub URLはgithub.comのURLとして安全な長さにしてください");
  }
}

export function createPublicItemUrl(pagesUrl: URL, item: TrackedItem): string {
  const match = PUBLIC_ITEM_DISPLAY_REFERENCE_PATTERN.exec(item.displayReference);
  if (match == null) {
    throw new DiscordPayloadError(
      `${item.displayReference}の表示参照がowner/repository#number形式ではありません`,
    );
  }
  const repositoryName = match[2];
  const numberText = match[3];
  assertNonNullable(repositoryName, "公開項目ページのrepository名を取得できませんでした");
  assertNonNullable(numberText, "公開項目ページのnumberを取得できませんでした");
  if (numberText !== item.number.toString()) {
    throw new DiscordPayloadError(
      `${item.displayReference}の表示参照numberと項目番号が一致しません`,
    );
  }
  const basePath = pagesUrl.pathname.endsWith("/") ? pagesUrl.pathname : `${pagesUrl.pathname}/`;
  const publicItemUrl = new URL(pagesUrl.href);
  publicItemUrl.pathname = `${basePath}items/${encodeURIComponent(repositoryName)}/${numberText}`;
  publicItemUrl.search = "";
  publicItemUrl.hash = "";
  return publicItemUrl.href;
}

export function truncateText(value: string, maximumCharacters: number): string {
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

export function normalizeInlineText(value: string, context: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    throw new DiscordPayloadError(`${context}は空にできません`);
  }
  return normalized;
}

export function formatJst(timestamp: number): string {
  const jstDate = new Date(timestamp + JST_OFFSET_MILLISECONDS);
  const year = jstDate.getUTCFullYear().toString();
  const month = (jstDate.getUTCMonth() + 1).toString();
  const day = jstDate.getUTCDate().toString();
  const hour = jstDate.getUTCHours().toString().padStart(2, "0");
  const minute = jstDate.getUTCMinutes().toString().padStart(2, "0");
  return `${year}年${month}月${day}日 ${hour}:${minute} JST`;
}

export function formatElapsedTime(startTimestamp: number, endTimestamp: number): string {
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

export function categoryForReason(
  reasonCode: DiscordNotificationReasonCode,
): DiscordDigestCategory {
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
    case "work_overdue":
      return "blocking";
  }
}

export function categoryTitle(category: DiscordDigestCategory): string {
  switch (category) {
    case "blocking":
      return "対応待ち・作業の停滞";
    case "unknown_responsibility":
      return "内容・対応先の確認待ち";
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

export function createMentionLookup(settings: DiscordMentionSettings): ReadonlyMap<string, string> {
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
  waitingOn: WaitingOnReference,
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

export function formatWaitingOn(
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

export function formatPersonalReminderResponsible(
  responsibleValues: readonly PersonalReminderResponsible[],
  mentionLookup: ReadonlyMap<string, string>,
  mentionsEnabled: boolean,
): WaitingOnText {
  if (responsibleValues.length === 0) {
    throw new DiscordPayloadError("個人催促の対応相手は1件以上必要です");
  }
  const rendered = responsibleValues.map((responsible) =>
    renderWaitingOn(responsible, new Map(), mentionLookup, mentionsEnabled),
  );
  const labels = rendered.map((value) => normalizeInlineText(value.text, "個人催促の対応相手"));
  const text = labels.join("、");
  if (characterCount(text) > WAITING_ON_MAX_CHARACTERS) {
    throw new DiscordPayloadError("個人催促の対応相手が表示上限を超えています");
  }
  return Object.freeze({
    text,
    mentionedUserIds: Object.freeze(
      [
        ...new Set(
          rendered.flatMap((value) =>
            value.mentionedUserId == null ? [] : [value.mentionedUserId],
          ),
        ),
      ].sort(),
    ),
  });
}

export function normalizedPersonalReminderResponsibleSignature(
  responsible: readonly PersonalReminderResponsible[],
): string {
  return JSON.stringify(
    responsible
      .map((value): readonly [string, string, string] => [
        value.kind,
        value.candidateId.toLowerCase(),
        value.role,
      ])
      .sort(),
  );
}

export function personalReminderTimeBasisSignature(basis: PersonalReminderTimeBasis): string {
  if (basis.source === "reconfirmed_observation") {
    return JSON.stringify([basis.source, basis.at, basis.previousAt, basis.sourceIds]);
  }
  if (basis.source !== "first_observation") {
    return JSON.stringify([basis.source, basis.at, basis.sourceIds]);
  }
  return JSON.stringify([basis.source, basis.at]);
}

export function throwInvalidPersonalReminderCause(item: TrackedItem, cause: unknown): never {
  const error = new DiscordPayloadError(`${item.displayReference}の個人催促causeが不正です`);
  error.cause = cause;
  throw error;
}

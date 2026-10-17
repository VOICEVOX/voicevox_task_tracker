import {
  type GitHubNodeId,
  type NotificationLedgerEntry,
  type OperationsAlertKind,
  type TrackedItem,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import type {
  DiscordNotificationCandidate,
  SelectedDiscordNotificationReason,
} from "./notification-selection-contracts.js";

export const DISCORD_API_LIMITS = Object.freeze({
  contentCharacters: 2000,
  embeds: 10,
  embedCharacters: 6000,
  embedTitleCharacters: 256,
  fieldsPerEmbed: 25,
  fieldNameCharacters: 256,
  fieldValueCharacters: 1024,
  allowedMentionUsers: 100,
});
export const DISCORD_SAFE_LIMITS = Object.freeze({
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
export const GITHUB_URL_MAX_CHARACTERS = 400;
export const TITLE_MAX_CHARACTERS = 256;
export const WAITING_ON_MAX_CHARACTERS = 280;
export const JST_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;
export const MILLISECONDS_PER_MINUTE = 60 * 1000;
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/u;
export const INCIDENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
export const PUBLIC_ITEM_DISPLAY_REFERENCE_PATTERN = /^([^/\s#?%]+)\/([^/\s#?%]+)#([1-9]\d*)$/u;

export type DiscordDigestCategory = "blocking" | "unknown_responsibility" | "important_change";

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

export type WaitingOnText = Readonly<{
  text: string;
  mentionedUserIds: readonly string[];
}>;

export type WaitingOnReference = Readonly<Pick<WaitingOn, "kind" | "candidateId" | "role">>;

export type DigestFieldDraft = Readonly<{
  category: DiscordDigestCategory;
  field: DiscordEmbedField;
  itemNodeId: GitHubNodeId;
  notificationKeys: readonly string[];
  mentionedUserIds: readonly string[];
}>;

export type PersonalReminderSelectedReason = SelectedDiscordNotificationReason &
  Readonly<{
    source: Extract<SelectedDiscordNotificationReason["source"], { kind: "personal_reminder" }>;
  }>;

export function isPersonalReminderSelectedReason(
  reason: SelectedDiscordNotificationReason,
): reason is PersonalReminderSelectedReason {
  return reason.source.kind === "personal_reminder";
}

interface MutableEmbedDraft {
  category: DiscordDigestCategory;
  fields: DiscordEmbedField[];
}

export interface MutableMessageDraft {
  embeds: MutableEmbedDraft[];
  itemNodeIds: GitHubNodeId[];
  notificationKeys: string[];
  mentionedUserIds: string[];
}

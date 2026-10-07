import {
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  type PersonalReminderCause,
  type TrackedItem,
} from "../domain/index.js";
import { DiscordPayloadError } from "./errors.js";
import type {
  DiscordNotificationCandidate,
  DiscordPersonalReminderNotificationContext,
} from "./notification-selection-contracts.js";
import type { PersonalReminderSelectedReason } from "./payload-contracts.js";
import { isPersonalReminderSelectedReason } from "./payload-contracts.js";
import {
  normalizedPersonalReminderResponsibleSignature,
  personalReminderTimeBasisSignature,
  throwInvalidPersonalReminderCause,
} from "./payload-text.js";

function assertPersonalReminderReasonMatchesCause(
  item: TrackedItem,
  reason: PersonalReminderSelectedReason,
  cause: PersonalReminderCause,
): void {
  const context: DiscordPersonalReminderNotificationContext = reason.source.context;
  if (cause.itemNodeId !== item.nodeId) {
    throw new DiscordPayloadError(
      `${item.displayReference}の個人催促causeが別の項目を参照しています`,
    );
  }
  if (cause.reasonCode !== reason.reasonCode) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促reason codeが一致しません`);
  }
  if (cause.responsibilityId !== context.responsibilityId) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促責務IDが一致しません`);
  }
  if (
    normalizedPersonalReminderResponsibleSignature(cause.responsible) !==
    normalizedPersonalReminderResponsibleSignature(context.responsible)
  ) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促対応相手が一致しません`);
  }
  if (
    cause.action.kind !== context.action.kind ||
    cause.action.summary !== context.action.summary
  ) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促行動が一致しません`);
  }
  if (
    personalReminderTimeBasisSignature(cause.obligationSince) !==
    personalReminderTimeBasisSignature(context.obligationSince)
  ) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促義務時刻が一致しません`);
  }
  if (cause.actionableClock.status !== "observed") {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促時計が観測済みではありません`);
  }
  if (
    personalReminderTimeBasisSignature(cause.actionableClock.actionableSince) !==
    personalReminderTimeBasisSignature(context.actionableSince)
  ) {
    throw new DiscordPayloadError(
      `${item.displayReference}の個人催促actionableSinceが一致しません`,
    );
  }
  if (
    personalReminderTimeBasisSignature(cause.actionableClock.stallSince) !==
    personalReminderTimeBasisSignature(context.stallSince)
  ) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促stallSinceが一致しません`);
  }
  const assessment = currentPersonalReminderAssessment(cause);
  if (assessment.status !== "available" || assessment.result.verdict !== "actionable") {
    throw new DiscordPayloadError(
      `${item.displayReference}の個人催促判定がactionableではありません`,
    );
  }
  if (reason.threshold.status !== "recorded" || reason.severity === "none") {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促severity根拠が不正です`);
  }
  if (!Number.isFinite(reason.threshold.hours) || reason.threshold.hours < 0) {
    throw new DiscordPayloadError(`${item.displayReference}の個人催促severity閾値が不正です`);
  }
}

/** 選別済み個人催促理由と送信用項目のcauseが一致することを検証する。 */
export function assertDiscordPersonalReminderSelectionMatchesItems(
  candidates: readonly DiscordNotificationCandidate[],
  items: readonly TrackedItem[],
): void {
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  if (itemsByNodeId.size !== items.length) {
    throw new DiscordPayloadError("個人催促検証対象の追跡項目node IDが重複しています");
  }
  const notificationKeys = new Set<string>();
  for (const candidate of candidates) {
    const item = itemsByNodeId.get(candidate.itemNodeId);
    if (item == null) {
      throw new DiscordPayloadError(`通知候補 ${candidate.itemNodeId}の追跡項目がありません`);
    }
    const causesById = new Map<PersonalReminderCause["causeId"], PersonalReminderCause>();
    for (const cause of item.personalReminderCauses) {
      const parsedCause = personalReminderCauseSchema.safeParse(cause);
      if (!parsedCause.success) {
        throwInvalidPersonalReminderCause(item, parsedCause.error);
      }
      if (causesById.has(parsedCause.data.causeId)) {
        throw new DiscordPayloadError(`${item.displayReference}の個人催促cause IDが重複しています`);
      }
      causesById.set(parsedCause.data.causeId, parsedCause.data);
    }
    const selectedCauseIds = new Set<PersonalReminderCause["causeId"]>();
    for (const reason of candidate.reasons) {
      if (reason.notificationKey.length === 0) {
        throw new DiscordPayloadError(`${item.displayReference}のnotification keyが空です`);
      }
      if (notificationKeys.has(reason.notificationKey)) {
        throw new DiscordPayloadError("通知候補のnotification keyが重複しています");
      }
      notificationKeys.add(reason.notificationKey);
      if (!isPersonalReminderSelectedReason(reason)) {
        continue;
      }
      const causeId = reason.source.context.causeId;
      if (selectedCauseIds.has(causeId)) {
        throw new DiscordPayloadError(
          `${item.displayReference}の個人催促causeが重複選択されています`,
        );
      }
      selectedCauseIds.add(causeId);
      const cause = causesById.get(causeId);
      if (cause == null) {
        throw new DiscordPayloadError(`${item.displayReference}の個人催促causeが見つかりません`);
      }
      assertPersonalReminderReasonMatchesCause(item, reason, cause);
    }
  }
}

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type PersonalReminderCause,
  type PersonalReminderReasonCode,
  type PersonalReminderResponsible,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { parseSourceId } from "../domain/source-id.js";
import { assertNonNullable } from "../util/index.js";
import type {
  DiscordNotificationItem,
  DiscordNotificationSelection,
  DiscordPersonalReminderSelectionValidationItem,
  ReasonSignal,
  SelectedDiscordNotificationReason,
} from "./notification-selection-contracts.js";
import { systemReasonSource } from "./notification-selection-contracts.js";
import {
  isPersonalReminderReasonCode,
  notificationReasonForSelection,
  overdueReasonCode,
  personalReminderActionKindForReason,
  waitClassForTimeReasonCode,
} from "./notification-selection-reasons.js";
import { createPersonalReminderSignals } from "./notification-selection-signals.js";
import { pendingTargetForReason } from "./notification-selection-validation.js";
import {
  normalizedResponsibilityForComparison,
  parseTimestamp,
  waitingOnComparisonSignature,
  waitingOnKeySignature,
} from "./notification-selection-values.js";

function notificationState(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  signal: ReasonSignal,
): string {
  if (signal.reason.reasonCode === "dependency_cycle") {
    return JSON.stringify([signal.reason.reasonCode, signal.stateDiscriminator]);
  }
  return JSON.stringify([
    item.nodeId,
    signal.reason.reasonCode,
    item.current.status,
    item.current.severity,
    waitingOnKeySignature(item.current.waitingOn),
    item.current.statusSince,
    item.current.ownerSince,
    item.current.stallSince,
    signal.stateDiscriminator,
  ]);
}

export function personalReminderResponsibleSignature(
  responsible: readonly PersonalReminderResponsible[],
): string {
  return JSON.stringify(normalizedResponsibilityForComparison(responsible));
}

export function personalReminderScopeIncludesItem(cause: PersonalReminderCause): boolean {
  switch (cause.responsibility.scope.kind) {
    case "item":
      return true;
    case "execution_surfaces":
      return false;
    case "item_and_execution_surfaces":
      return true;
  }
}

export function responsibilityPeriodStart(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
): UtcIsoDateTime {
  const statusSinceTimestamp = parseTimestamp(
    item.current.statusSince,
    `${item.nodeId}のstatusSince`,
  );
  const ownerSinceTimestamp = parseTimestamp(item.current.ownerSince, `${item.nodeId}のownerSince`);
  return statusSinceTimestamp >= ownerSinceTimestamp
    ? item.current.statusSince
    : item.current.ownerSince;
}

export function legacySystemSignalForPersonalReason(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  reasonCode: PersonalReminderReasonCode,
): ReasonSignal | undefined {
  if (overdueReasonCode(item.current.status, item.current.waitClass) !== reasonCode) {
    return undefined;
  }
  const reason = notificationReasonForSelection({
    item,
    reasonCode,
    source: "codex",
  });
  if (reason == null) {
    return undefined;
  }
  return Object.freeze({
    reason,
    stateDiscriminator: item.current.waitClass,
    highPriorityEligible: true,
    target: pendingTargetForReason(item, reasonCode, undefined),
    severity: item.current.severity,
    source: systemReasonSource(),
  });
}

function legacyOverdueSignalForPersonalReminder(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  signal: ReasonSignal,
): ReasonSignal | undefined {
  if (signal.source.kind !== "personal_reminder") {
    return undefined;
  }
  const reasonCode = signal.reason.reasonCode;
  if (!isPersonalReminderReasonCode(reasonCode)) {
    throw new TypeError(`個人催促通知理由 ${reasonCode}が時間系理由ではありません`);
  }
  return legacySystemSignalForPersonalReason(item, reasonCode);
}

function canReuseLegacyPersonalReminderKey(
  item: Pick<DiscordNotificationItem, "nodeId" | "current" | "personalReminderCauses">,
  signal: ReasonSignal,
  legacySignal: ReasonSignal,
): boolean {
  if (signal.source.kind !== "personal_reminder") {
    return false;
  }
  const context = signal.source.context;
  const input = item.personalReminderCauses.find(
    (candidate) => candidate.cause.causeId === context.causeId,
  );
  if (input?.cause.itemNodeId !== item.nodeId) {
    return false;
  }
  const { cause, staleness } = input;
  if (
    !personalReminderScopeIncludesItem(cause) ||
    cause.action.kind !== personalReminderActionKindForReason(cause.reasonCode) ||
    staleness.waitClass !== waitClassForTimeReasonCode(cause.reasonCode) ||
    staleness.waitClass !== item.current.waitClass ||
    signal.reason.reasonCode !== cause.reasonCode ||
    signal.severity !== item.current.severity ||
    signal.reason.threshold.status !== "recorded" ||
    legacySignal.reason.threshold.status !== "recorded" ||
    signal.reason.threshold.hours !== legacySignal.reason.threshold.hours
  ) {
    return false;
  }
  if (
    personalReminderResponsibleSignature(cause.responsible) !==
    waitingOnComparisonSignature(item.current.waitingOn)
  ) {
    return false;
  }
  if (
    context.actionableSince.source !== "event" ||
    context.stallSince.source !== "event" ||
    context.actionableSince.at !== responsibilityPeriodStart(item) ||
    context.stallSince.at !== item.current.stallSince
  ) {
    return false;
  }
  if (cause.actionableClock.status !== "observed") {
    return false;
  }
  return (
    cause.actionableClock.actionableSince.source === "event" &&
    cause.actionableClock.stallSince.source === "event" &&
    cause.actionableClock.actionableSince.at === context.actionableSince.at &&
    cause.actionableClock.stallSince.at === context.stallSince.at
  );
}

function personalReminderNotificationState(
  item: Pick<DiscordNotificationItem, "nodeId">,
  signal: ReasonSignal,
): string {
  if (signal.source.kind !== "personal_reminder") {
    throw new TypeError("個人催促通知のidentityにsystem理由を指定できません");
  }
  if (signal.reason.threshold.status !== "recorded") {
    throw new TypeError("個人催促通知のseverity閾値が未記録です");
  }
  const context = signal.source.context;
  const reviewRequestReconfirmation =
    signal.reason.reasonCode === "review_overdue" &&
    [context.obligationSince, context.actionableSince].some(
      (basis) =>
        basis.source === "reconfirmed_observation" &&
        basis.sourceIds.some(
          (sourceId) => parseSourceId(sourceId).kind === "github_review_request",
        ),
    );
  const reconfirmedBases = [
    context.obligationSince,
    context.actionableSince,
    context.stallSince,
  ].flatMap((basis, index) =>
    basis.source === "reconfirmed_observation"
      ? [[index, basis.source, basis.at, basis.previousAt, [...basis.sourceIds].sort()]]
      : [],
  );
  return JSON.stringify([
    "personal-reminder-v1",
    item.nodeId,
    signal.reason.reasonCode,
    context.causeId,
    context.responsibilityId,
    normalizedResponsibilityForComparison(context.responsible),
    context.action.kind,
    reviewRequestReconfirmation && context.actionableSince.source === "reconfirmed_observation"
      ? context.actionableSince.previousAt
      : context.actionableSince.at,
    reviewRequestReconfirmation && context.stallSince.source === "reconfirmed_observation"
      ? context.stallSince.previousAt
      : context.stallSince.at,
    signal.severity,
    signal.reason.threshold.hours,
    ...(reconfirmedBases.length === 0 || reviewRequestReconfirmation ? [] : [reconfirmedBases]),
  ]);
}

export function createNotificationKey(
  item: Pick<DiscordNotificationItem, "nodeId" | "current" | "personalReminderCauses">,
  signal: ReasonSignal,
): string {
  if (signal.source.kind === "personal_reminder") {
    const legacySignal = legacyOverdueSignalForPersonalReminder(item, signal);
    if (legacySignal != null && canReuseLegacyPersonalReminderKey(item, signal, legacySignal)) {
      return createNotificationKey(item, legacySignal);
    }
  }
  const state =
    signal.source.kind === "personal_reminder"
      ? personalReminderNotificationState(item, signal)
      : notificationState(item, signal);
  const stateHash = createHash("sha256").update(state).digest("hex");
  return `discord-notification:v1:${signal.reason.reasonCode}:${stateHash}`;
}

function assertSelectedReasonMatchesSignal(
  item: Pick<DiscordNotificationItem, "nodeId">,
  selectedReason: SelectedDiscordNotificationReason,
  expected: ReasonSignal,
): void {
  if (
    selectedReason.reasonCode !== expected.reason.reasonCode ||
    !isDeepStrictEqual(selectedReason.threshold, expected.reason.threshold) ||
    selectedReason.severity !== expected.severity ||
    !isDeepStrictEqual(selectedReason.source, expected.source)
  ) {
    throw new TypeError(`${item.nodeId}の通知理由が現在の判定結果と一致しません`);
  }
}

/** snapshotと現設定から再計算した個人催促理由を選択結果へ突合する。 */
export function assertDiscordPersonalReminderSelectionMatchesSnapshot(
  selection: DiscordNotificationSelection,
  items: readonly DiscordPersonalReminderSelectionValidationItem[],
): void {
  if (selection.action === "skip_digest") {
    return;
  }
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  if (itemsByNodeId.size !== items.length) {
    throw new TypeError("送信直前の個人催促検証対象node IDが重複しています");
  }
  for (const candidate of selection.candidates) {
    if (!candidate.reasons.some((reason) => reason.source.kind === "personal_reminder")) {
      continue;
    }
    const item = itemsByNodeId.get(candidate.itemNodeId);
    assertNonNullable(item, `${candidate.itemNodeId}の送信直前検証対象がありません`);
    const signalsByCauseId = new Map<string, ReasonSignal>();
    for (const signal of createPersonalReminderSignals(item)) {
      if (signal.source.kind !== "personal_reminder") {
        throw new TypeError("個人催促検証結果にsystem理由があります");
      }
      const causeId = signal.source.context.causeId;
      if (signalsByCauseId.has(causeId)) {
        throw new TypeError(`${causeId}の個人催促通知理由が重複しています`);
      }
      signalsByCauseId.set(causeId, signal);
    }
    for (const selectedReason of candidate.reasons) {
      if (selectedReason.source.kind !== "personal_reminder") {
        continue;
      }
      const expected = signalsByCauseId.get(selectedReason.source.context.causeId);
      assertNonNullable(
        expected,
        `${selectedReason.source.context.causeId}の個人催促判定結果が現在のsnapshotにありません`,
      );
      const expectedKey = createNotificationKey(item, expected);
      if (selectedReason.notificationKey !== expectedKey) {
        throw new TypeError(`${candidate.itemNodeId}の個人催促notification keyが一致しません`);
      }
      assertSelectedReasonMatchesSignal(item, selectedReason, expected);
    }
  }
}

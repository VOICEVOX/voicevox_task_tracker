import {
  createUtcIsoDateTime,
  type NotificationLedgerEntry,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import type {
  CandidateDraft,
  DiscordNotificationItem,
  DiscordNotificationReasonCode,
  EligibleReason,
  ReasonSignal,
  SelectDiscordNotificationsInput,
} from "./notification-selection-contracts.js";
import { RESERVATION_DURATION_MILLISECONDS } from "./notification-selection-contracts.js";
import { createNotificationKey } from "./notification-selection-key.js";
import { isTimeNotificationReasonCode } from "./notification-selection-reasons.js";
import {
  assignNewCycles,
  createSignals,
  isItemSuppressed,
  isReasonSuppressedByCause,
} from "./notification-selection-signals.js";
import { createPendingNotification } from "./notification-selection-validation.js";
import { compareStrings, parseTimestamp } from "./notification-selection-values.js";

export function isEligibleAgainstLedger(
  item: DiscordNotificationItem,
  reason: ReasonSignal,
  notificationKey: string,
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  ledger: readonly NotificationLedgerEntry[],
  evaluatedTimestamp: number,
): boolean {
  const existing = ledgerByKey.get(notificationKey);
  if (existing != null) {
    if (existing.status === "reserved") {
      if (evaluatedTimestamp < parseTimestamp(existing.expiresAt, "ledgerの予約期限")) {
        return false;
      }
    } else {
      return false;
    }
  }
  if (reason.source.kind === "personal_reminder") {
    return true;
  }
  if (
    !isTimeNotificationReasonCode(reason.reason.reasonCode) &&
    reason.reason.reasonCode !== "owner_unknown"
  ) {
    return true;
  }
  const statusSinceTimestamp = parseTimestamp(
    item.current.statusSince,
    `${item.nodeId}のstatusSince`,
  );
  const ownerSinceTimestamp = parseTimestamp(item.current.ownerSince, `${item.nodeId}のownerSince`);
  const periodStartTimestamp = Math.max(statusSinceTimestamp, ownerSinceTimestamp);
  return !ledger.some((entry) => {
    if (
      entry.itemNodeId !== item.nodeId ||
      entry.reasonCode !== reason.reason.reasonCode ||
      entry.severity !== reason.severity ||
      parseTimestamp(entry.reservedAt, "ledgerの予約時刻") < periodStartTimestamp
    ) {
      return false;
    }
    if (entry.status === "reserved") {
      return evaluatedTimestamp < parseTimestamp(entry.expiresAt, "ledgerの予約期限");
    }
    return true;
  });
}

export function reservationExpiresAt(reservedAt: UtcIsoDateTime): UtcIsoDateTime {
  const expiresTimestamp =
    parseTimestamp(reservedAt, "ledgerの予約時刻") + RESERVATION_DURATION_MILLISECONDS;
  if (!Number.isFinite(expiresTimestamp)) {
    throw new RangeError("ledgerの予約期限を計算できません");
  }
  return createUtcIsoDateTime(new Date(expiresTimestamp).toISOString());
}

function reasonPriority(reasonCode: DiscordNotificationReasonCode): number {
  switch (reasonCode) {
    case "dependency_cycle":
      return 10;
    case "blocker_overdue":
      return 9;
    case "owner_unknown":
      return 8;
    case "newly_unblocked":
      return 7;
    case "responsibility_changed":
      return 6;
    case "merge_overdue":
      return 5;
    case "revision_overdue":
      return 4;
    case "decision_overdue":
    case "reply_overdue":
    case "review_overdue":
      return 3;
    case "owner_overdue":
    case "assessment_overdue":
    case "work_overdue":
      return 2;
    case "automation_stuck":
      return 1;
  }
}

export function compareEligibleReasons(left: EligibleReason, right: EligibleReason): -1 | 0 | 1 {
  const priorityDifference =
    reasonPriority(right.signal.reason.reasonCode) - reasonPriority(left.signal.reason.reasonCode);
  if (priorityDifference !== 0) {
    return priorityDifference < 0 ? -1 : 1;
  }
  return compareStrings(left.notificationKey, right.notificationKey);
}

export function toNonEmptyReasons(
  reasons: readonly EligibleReason[],
  context: string,
): readonly [EligibleReason, ...EligibleReason[]] {
  const [first, ...rest] = reasons;
  assertNonNullable(first, context);
  return Object.freeze([first, ...rest]);
}

export function createCurrentCandidateDrafts(
  input: SelectDiscordNotificationsInput,
  evaluatedTimestamp: number,
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  ledger: readonly NotificationLedgerEntry[],
): readonly CandidateDraft[] {
  const unsuppressedItems = input.items.filter(
    (item) => !isItemSuppressed(item, evaluatedTimestamp, input.settings),
  );
  const assignedCycles = assignNewCycles(unsuppressedItems, evaluatedTimestamp);
  const drafts: CandidateDraft[] = [];

  for (const item of unsuppressedItems) {
    const signals = createSignals(
      item,
      assignedCycles.get(item.nodeId) ?? [],
      evaluatedTimestamp,
      input.settings,
    );
    const signalEntries = signals.map((signal) => {
      const notificationKey = createNotificationKey(item, signal);
      return Object.freeze({ signal, notificationKey });
    });
    const notificationKeys = signalEntries.map((entry) => entry.notificationKey);
    if (new Set(notificationKeys).size !== notificationKeys.length) {
      throw new TypeError(`${item.nodeId}の通知理由でnotificationKeyが衝突しています`);
    }
    const eligibleReasons = signalEntries
      .filter((entry) => !isReasonSuppressedByCause(item, entry.signal.reason.reasonCode))
      .map(({ signal, notificationKey }) => {
        return {
          signal,
          notificationKey,
          pendingNotification: createPendingNotification(
            item,
            signal,
            notificationKey,
            input.evaluatedAt,
          ),
        } satisfies EligibleReason;
      })
      .filter((reason) =>
        isEligibleAgainstLedger(
          item,
          reason.signal,
          reason.notificationKey,
          ledgerByKey,
          ledger,
          evaluatedTimestamp,
        ),
      )
      .sort(compareEligibleReasons);
    if (eligibleReasons.length === 0) {
      continue;
    }
    drafts.push({
      item,
      reasons: toNonEmptyReasons(eligibleReasons, `${item.nodeId}の通知理由を選択できませんでした`),
    });
  }
  return drafts;
}

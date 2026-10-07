import {
  createNotificationReason,
  type NotificationNonTimeReasonCode,
  type NotificationReason,
  type NotificationTimeReasonCode,
  type PersonalReminderActionKind,
  type PersonalReminderReasonCode,
  type StalenessWaitClass,
  type Status,
  type WaitClass,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import type {
  DiscordNotificationReasonCode,
  NotificationReasonSelectionInput,
} from "./notification-selection-contracts.js";

const TIME_REASON_WAIT_CLASS = {
  assessment_overdue: "assessment",
  owner_overdue: "owner",
  decision_overdue: "decision",
  review_overdue: "review",
  revision_overdue: "revision",
  reply_overdue: "reply",
  work_overdue: "work",
  merge_overdue: "merge",
  automation_stuck: "automation",
} satisfies Readonly<Record<NotificationTimeReasonCode, WaitClass>>;

const PERSONAL_REMINDER_REASON_CODES = [
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "work_overdue",
  "merge_overdue",
] as const satisfies readonly PersonalReminderReasonCode[];

export function isPersonalReminderReasonCode(
  reasonCode: DiscordNotificationReasonCode,
): reasonCode is PersonalReminderReasonCode {
  return PERSONAL_REMINDER_REASON_CODES.some((candidate) => candidate === reasonCode);
}

export function personalReminderActionKindForReason(
  reasonCode: PersonalReminderReasonCode,
): PersonalReminderActionKind {
  switch (reasonCode) {
    case "assessment_overdue":
      return "assessment";
    case "owner_overdue":
      return "owner";
    case "decision_overdue":
      return "decision";
    case "review_overdue":
      return "review";
    case "revision_overdue":
      return "revision";
    case "reply_overdue":
      return "reply";
    case "work_overdue":
      return "work";
    case "merge_overdue":
      return "merge";
  }
}

function isNotificationTimeReasonCodeKey(value: string): value is NotificationTimeReasonCode {
  return Object.hasOwn(TIME_REASON_WAIT_CLASS, value);
}

function timeReasonCodeForWaitClass(
  waitClass: StalenessWaitClass,
): NotificationTimeReasonCode | undefined {
  for (const [reasonCode, candidateWaitClass] of Object.entries(TIME_REASON_WAIT_CLASS)) {
    if (candidateWaitClass === waitClass) {
      if (!isNotificationTimeReasonCodeKey(reasonCode)) {
        throw new TypeError(`時間系通知理由 ${reasonCode}の型が不正です`);
      }
      return reasonCode;
    }
  }
  return undefined;
}

export function overdueReasonCode(
  status: Status,
  waitClass: StalenessWaitClass,
): DiscordNotificationReasonCode | undefined {
  if (waitClass === "owner" && status === "unknown") {
    return "owner_unknown";
  }
  if (waitClass === "work" && status !== "waiting_for_work") {
    return undefined;
  }
  return timeReasonCodeForWaitClass(waitClass);
}

export function waitClassForTimeReasonCode(reasonCode: NotificationTimeReasonCode): WaitClass {
  return TIME_REASON_WAIT_CLASS[reasonCode];
}

export function isTimeNotificationReasonCode(
  reasonCode: DiscordNotificationReasonCode,
): reasonCode is NotificationTimeReasonCode {
  return isNotificationTimeReasonCodeKey(reasonCode);
}

export function notificationReasonForNonTimeSelection(
  reasonCode: NotificationNonTimeReasonCode,
): NotificationReason {
  const reason = notificationReasonForSelection({ reasonCode });
  assertNonNullable(reason, `非時間系通知理由 ${reasonCode}を生成できません`);
  return reason;
}

export function notificationReasonForSelection(
  input: NotificationReasonSelectionInput,
): NotificationReason | undefined {
  switch (input.reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "work_overdue":
    case "merge_overdue":
    case "automation_stuck": {
      const waitClass = waitClassForTimeReasonCode(input.reasonCode);
      const current = input.item.current;
      if (current.waitClass !== waitClass) {
        if (input.source === "deterministic") {
          throw new TypeError(
            `${input.item.nodeId}の決定論的通知理由 ${input.reasonCode}とwait classが一致しません`,
          );
        }
        return undefined;
      }
      if (current.severityReason.kind !== "elapsed_threshold") {
        if (input.source === "deterministic") {
          throw new TypeError(
            `${input.item.nodeId}の時間系通知理由にseverityの時間判定根拠がありません`,
          );
        }
        return undefined;
      }
      if (current.severityReason.waitClass !== waitClass) {
        if (input.source === "deterministic") {
          throw new TypeError(
            `${input.item.nodeId}の時間系通知理由とseverityのwait classが一致しません`,
          );
        }
        return undefined;
      }
      return current.severityReason.crossedThreshold.status === "reached"
        ? createNotificationReason(input.reasonCode, {
            status: "recorded",
            hours: current.severityReason.crossedThreshold.thresholdHours,
          })
        : createNotificationReason(input.reasonCode, {
            status: "not_reached",
            elapsedHours: current.severityReason.elapsedHours,
          });
    }
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
      return createNotificationReason(input.reasonCode, {
        status: "not_applicable",
      });
  }
}

import { z } from "zod";

import { notificationReasonSchema } from "../domain/notification-reason.js";
import { confirmedPersonalReminderTimeBasisSchema } from "../domain/personal-reminder-causes.js";
import { UnreachableError } from "../util/index.js";
import {
  dateTimeSchema,
  githubUrlSchema,
  identifierSchema,
  publicPersonalReminderResponsibleSchema,
  waitingOnSchema,
} from "./public-dto-primitives.js";
import { comparePublicNotificationHistoryEntries } from "./public-history-dto-validation.js";
import {
  publicPersonalReminderActionSchema,
  publicPersonalReminderResponseSchema,
} from "./public-reminder-dto-schema.js";

type PublicPersonalReminderResponseDto = z.output<typeof publicPersonalReminderResponseSchema>;

const publicNotificationHistoryItemSchema = z.strictObject({
  nodeId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  repositoryId: identifierSchema,
  displayReference: z.string().min(4).max(600),
  number: z.number().int().positive(),
  title: z.string().max(500),
  url: githubUrlSchema,
});
const publicNotificationHistoryWaitingOnSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("team"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("role"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("item"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
    displayReference: z.string().min(4).max(600),
  }),
  z.strictObject({
    kind: z.literal("automation"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
]);
function publicNotificationReasonKey(reason: z.output<typeof notificationReasonSchema>): string {
  switch (reason.threshold.status) {
    case "recorded":
      return `${reason.reasonCode}:recorded:${reason.threshold.hours.toString()}`;
    case "not_reached":
      return `${reason.reasonCode}:not_reached:${reason.threshold.elapsedHours.toString()}`;
    case "not_recorded":
      return `${reason.reasonCode}:not_recorded`;
    case "not_applicable":
      return `${reason.reasonCode}:not_applicable`;
  }
}

function publicPersonalReminderActionForReason(
  reasonCode: z.output<typeof notificationReasonSchema>["reasonCode"],
): PublicPersonalReminderResponseDto["action"]["kind"] | undefined {
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
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
    case "automation_stuck":
      return undefined;
    default:
      throw new UnreachableError(reasonCode);
  }
}

export const publicNotificationHistoryPersonalReminderSchema = z
  .strictObject({
    notificationKey: identifierSchema,
    causeId: identifierSchema,
    responsibilityId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    reason: notificationReasonSchema,
    obligationSince: confirmedPersonalReminderTimeBasisSchema,
    actionableSince: confirmedPersonalReminderTimeBasisSchema,
    stallSince: confirmedPersonalReminderTimeBasisSchema,
    severity: z.enum(["watch", "urgent", "critical"]),
  })
  .superRefine((personalReminder, context) => {
    const expectedAction = publicPersonalReminderActionForReason(
      personalReminder.reason.reasonCode,
    );
    if (expectedAction == null) {
      context.addIssue({
        code: "custom",
        path: ["reason", "reasonCode"],
        message: "個人催促の通知理由コードが対応する時間系理由ではありません",
      });
    } else if (personalReminder.action.kind !== expectedAction) {
      context.addIssue({
        code: "custom",
        path: ["action", "kind"],
        message: "個人催促の通知理由コードと行動種別が一致しません",
      });
    }
    if (personalReminder.reason.threshold.status !== "recorded") {
      context.addIssue({
        code: "custom",
        path: ["reason", "threshold"],
        message: "個人催促の通知理由には到達済みの基準時間が必要です",
      });
    }
  });
export const publicNotificationHistoryEntrySchema = z
  .strictObject({
    item: publicNotificationHistoryItemSchema,
    waitingOn: z.array(publicNotificationHistoryWaitingOnSchema).min(1),
    reasons: z.array(notificationReasonSchema).min(1),
    personalReminders: z.array(publicNotificationHistoryPersonalReminderSchema),
    sentAt: dateTimeSchema,
  })
  .superRefine((entry, context) => {
    const notificationKeys = entry.personalReminders.map(
      (personalReminder) => personalReminder.notificationKey,
    );
    if (new Set(notificationKeys).size !== notificationKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["personalReminders"],
        message: "個人催促のnotification keyが重複しています",
      });
    }
    const eventReasonCounts = new Map<string, number>();
    const eventReasonCodeCounts = new Map<string, number>();
    for (const reason of entry.reasons) {
      const key = publicNotificationReasonKey(reason);
      eventReasonCounts.set(key, (eventReasonCounts.get(key) ?? 0) + 1);
      eventReasonCodeCounts.set(
        reason.reasonCode,
        (eventReasonCodeCounts.get(reason.reasonCode) ?? 0) + 1,
      );
    }
    const personalReasonCodeCounts = new Map<string, number>();
    for (const personalReminder of entry.personalReminders) {
      const key = publicNotificationReasonKey(personalReminder.reason);
      const personalReasonCount = entry.personalReminders.filter(
        (candidate) => publicNotificationReasonKey(candidate.reason) === key,
      ).length;
      if (personalReasonCount > (eventReasonCounts.get(key) ?? 0)) {
        context.addIssue({
          code: "custom",
          path: ["personalReminders"],
          message: "個人催促の通知理由がeventの通知理由に含まれていません",
        });
      }
      personalReasonCodeCounts.set(
        personalReminder.reason.reasonCode,
        (personalReasonCodeCounts.get(personalReminder.reason.reasonCode) ?? 0) + 1,
      );
      const obligationAt = Date.parse(personalReminder.obligationSince.at);
      const actionableAt = Date.parse(personalReminder.actionableSince.at);
      const stallAt = Date.parse(personalReminder.stallSince.at);
      const sentAt = Date.parse(entry.sentAt);
      if (
        !Number.isFinite(obligationAt) ||
        !Number.isFinite(actionableAt) ||
        !Number.isFinite(stallAt) ||
        !Number.isFinite(sentAt) ||
        obligationAt > actionableAt ||
        actionableAt > stallAt ||
        stallAt > sentAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["personalReminders"],
          message: "個人催促の時計は義務、実行可能、停滞、送信の順序にしてください",
        });
      }
    }
    for (const [reasonCode, count] of eventReasonCodeCounts) {
      if (count - (personalReasonCodeCounts.get(reasonCode) ?? 0) > 1) {
        context.addIssue({
          code: "custom",
          path: ["reasons"],
          message: "system通知理由コードが重複しています",
        });
      }
    }
    for (const [index, reason] of entry.reasons.entries()) {
      if (reason.threshold.status === "not_recorded") {
        context.addIssue({
          code: "custom",
          path: ["reasons", index, "threshold"],
          message: "公開通知履歴に基準時間未記録の理由を含めることはできません",
        });
      }
    }
  });
export const publicNotificationHistoryDtoSchema = z
  .strictObject({
    schemaVersion: z.literal("5"),
    runId: identifierSchema,
    generatedAt: dateTimeSchema,
    notifications: z.array(publicNotificationHistoryEntrySchema),
  })
  .superRefine((history, context) => {
    for (const [index, notification] of history.notifications.entries()) {
      if (notification.sentAt > history.generatedAt) {
        context.addIssue({
          code: "custom",
          path: ["notifications", index, "sentAt"],
          message: "通知送信時刻は公開データ生成時刻以前にしてください",
        });
      }
      const previous = history.notifications[index - 1];
      if (previous != null && comparePublicNotificationHistoryEntries(previous, notification) > 0) {
        context.addIssue({
          code: "custom",
          path: ["notifications", index],
          message: "通知履歴が決定論的な降順になっていません",
        });
      }
    }
  });

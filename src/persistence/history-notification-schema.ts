import { z } from "zod";

import {
  notificationReasonSchema,
  personalReminderActionKindSchema,
  personalReminderResponsibleSchema,
} from "../domain/index.js";
import { confirmedPersonalReminderTimeBasisSchema } from "../domain/personal-reminder-causes.js";
import { UnreachableError } from "../util/index.js";
import {
  dateTimeSchema,
  identifierSchema,
  notificationReasonCodeSchema,
  notificationWaitingOnRecordSchema,
  severitySchema,
} from "./history-fields-schema.js";

export const notificationSentEventCommonFieldsSchema = z.strictObject({
  kind: z.literal("notification_sent"),
  deliveryId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  itemNodeId: identifierSchema,
  repositoryId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  displayReference: z.string().min(4).max(600).regex(/^\S+$/u),
  number: z.number().int().positive(),
  title: z.string().max(500),
  url: z
    .url()
    .max(1000)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.port === "" &&
        url.username === "" &&
        url.password === ""
      );
    }),
  severity: severitySchema,
  sentAt: dateTimeSchema,
});
const notificationSentEventLegacyFieldsSchema = notificationSentEventCommonFieldsSchema.extend({
  reasonCodes: z.array(notificationReasonCodeSchema).min(1),
});
export const notificationSentEventVersion3Schema =
  notificationSentEventLegacyFieldsSchema.superRefine((event, context) => {
    if (new Set(event.reasonCodes).size !== event.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "通知理由コードが重複しています",
      });
    }
  });
export const notificationSentEventVersion4Schema = notificationSentEventLegacyFieldsSchema
  .extend({
    waitingOn: notificationWaitingOnRecordSchema,
  })
  .superRefine((event, context) => {
    if (new Set(event.reasonCodes).size !== event.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "通知理由コードが重複しています",
      });
    }
  });
export const notificationSentEventVersion6Schema = notificationSentEventCommonFieldsSchema
  .extend({
    waitingOn: notificationWaitingOnRecordSchema,
    reasons: z.array(notificationReasonSchema).min(1),
  })
  .superRefine((event, context) => {
    const reasonCodes = event.reasons.map((reason) => reason.reasonCode);
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "通知理由コードが重複しています",
      });
    }
  });
export const notificationSentPersonalReminderSchema = z
  .strictObject({
    notificationKey: identifierSchema,
    causeId: identifierSchema,
    responsibilityId: identifierSchema,
    responsible: z.array(personalReminderResponsibleSchema).nonempty().max(20),
    action: z.strictObject({
      kind: personalReminderActionKindSchema,
      summary: z.string().min(1).max(300),
    }),
    reason: notificationReasonSchema,
    obligationSince: confirmedPersonalReminderTimeBasisSchema,
    actionableSince: confirmedPersonalReminderTimeBasisSchema,
    stallSince: confirmedPersonalReminderTimeBasisSchema,
    severity: z.enum(["watch", "urgent", "critical"]),
  })
  .superRefine((personalReminder, context) => {
    const reasonCode = personalReminder.reason.reasonCode;
    const expectedAction = (() => {
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
    })();
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

function notificationReasonKey(reason: z.output<typeof notificationReasonSchema>): string {
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

function assertNotificationPersonalReminderClock(
  personalReminder: z.output<typeof notificationSentPersonalReminderSchema>,
  sentAt: string,
  context: z.RefinementCtx,
): void {
  const obligationAt = Date.parse(personalReminder.obligationSince.at);
  const actionableAt = Date.parse(personalReminder.actionableSince.at);
  const stallAt = Date.parse(personalReminder.stallSince.at);
  const sentTimestamp = Date.parse(sentAt);
  if (
    !Number.isFinite(obligationAt) ||
    !Number.isFinite(actionableAt) ||
    !Number.isFinite(stallAt) ||
    !Number.isFinite(sentTimestamp) ||
    obligationAt > actionableAt ||
    actionableAt > stallAt ||
    stallAt > sentTimestamp
  ) {
    context.addIssue({
      code: "custom",
      path: ["obligationSince"],
      message: "個人催促の時計は義務、実行可能、停滞、送信の順序にしてください",
    });
  }
}

export const notificationSentEventSchema = notificationSentEventCommonFieldsSchema
  .extend({
    waitingOn: notificationWaitingOnRecordSchema,
    reasons: z.array(notificationReasonSchema).min(1),
    personalReminders: z.array(notificationSentPersonalReminderSchema),
  })
  .superRefine((event, context) => {
    const notificationKeys = event.personalReminders.map(
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
    for (const reason of event.reasons) {
      const key = notificationReasonKey(reason);
      eventReasonCounts.set(key, (eventReasonCounts.get(key) ?? 0) + 1);
      eventReasonCodeCounts.set(
        reason.reasonCode,
        (eventReasonCodeCounts.get(reason.reasonCode) ?? 0) + 1,
      );
    }
    const personalReasonCounts = new Map<string, number>();
    const personalReasonCodeCounts = new Map<string, number>();
    for (const personalReminder of event.personalReminders) {
      const key = notificationReasonKey(personalReminder.reason);
      const count = (personalReasonCounts.get(key) ?? 0) + 1;
      personalReasonCounts.set(key, count);
      personalReasonCodeCounts.set(
        personalReminder.reason.reasonCode,
        (personalReasonCodeCounts.get(personalReminder.reason.reasonCode) ?? 0) + 1,
      );
      if (count > (eventReasonCounts.get(key) ?? 0)) {
        context.addIssue({
          code: "custom",
          path: ["personalReminders"],
          message: "個人催促の通知理由がeventの通知理由に含まれていません",
        });
      }
      assertNotificationPersonalReminderClock(personalReminder, event.sentAt, context);
    }
    for (const [reasonCode, count] of eventReasonCodeCounts) {
      const personalCount = personalReasonCodeCounts.get(reasonCode) ?? 0;
      if (count - personalCount > 1) {
        context.addIssue({
          code: "custom",
          path: ["reasons"],
          message: "system通知理由コードが重複しています",
        });
      }
    }
  });

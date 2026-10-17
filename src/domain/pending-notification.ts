import { z } from "zod";

import { notificationReasonSchema, type NotificationReason } from "./notification-reason.js";
import type {
  PersonalReminderCauseId,
  PersonalReminderResponsibilityId,
  PersonalReminderTimeBasis,
} from "./personal-reminder-causes.js";
import type { StalenessWaitClass } from "./staleness.js";
import {
  githubNodeIdSchema,
  opaqueIdSchema,
  utcIsoDateTimeSchema,
  type GitHubNodeId,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
} from "./types.js";

type PendingNotificationWaitingOn = Pick<WaitingOn, "kind" | "candidateId" | "role">;

/** 個人催促原因を対象にした送信待ち通知の対象状態。 */
export type PendingPersonalReminderTarget = Readonly<{
  kind: "personal_reminder";
  causeId: PersonalReminderCauseId;
  responsibilityId: PersonalReminderResponsibilityId;
  actionableSince: PersonalReminderTimeBasis;
  stallSince: PersonalReminderTimeBasis;
}>;

/** 通知候補の判定対象。 */
export type PendingNotificationTarget =
  | Readonly<{
      kind: "responsibility";
      waitingOn: readonly PendingNotificationWaitingOn[];
    }>
  | Readonly<{
      kind: "unblocked";
    }>
  | Readonly<{
      kind: "cycle";
      cycleId: string;
    }>
  | Readonly<{
      kind: "overdue";
      status: Status;
      waitClass: StalenessWaitClass;
      waitingOn: readonly PendingNotificationWaitingOn[];
      lastProgressAt: UtcIsoDateTime;
    }>
  | PendingPersonalReminderTarget;

/** 送信待ち通知の判定結果と公開可能な対象状態。 */
export type PendingNotification = Readonly<{
  notificationKey: string;
  itemNodeId: GitHubNodeId;
  reason: NotificationReason;
  detectedAt: UtcIsoDateTime;
  highPriorityEligible: boolean;
  target: PendingNotificationTarget;
}>;

const pendingNotificationWaitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: opaqueIdSchema,
  role: z.enum([
    "author",
    "maintainer",
    "reviewer",
    "assignee",
    "respondent",
    "dependency",
    "merge_decider",
    "ci",
    "unknown",
  ]),
});
const pendingNotificationStatusSchema = z.enum([
  "waiting_for_assessment",
  "waiting_for_owner",
  "waiting_for_decision",
  "waiting_for_review",
  "waiting_for_revision",
  "waiting_for_reply",
  "waiting_for_work",
  "waiting_for_unblock",
  "waiting_for_automation",
  "waiting_for_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
]);
const pendingNotificationWaitClassSchema = z.enum([
  "assessment",
  "owner",
  "decision",
  "review",
  "revision",
  "reply",
  "work",
  "merge",
  "automation",
  "blockedParent",
  "notApplicable",
]);
const pendingPersonalReminderCauseIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\S+$/u)
  .brand<"PersonalReminderCauseId">();
const pendingPersonalReminderResponsibilityIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\S+$/u)
  .brand<"PersonalReminderResponsibilityId">();
const pendingPersonalReminderSourceIdSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^\S+$/u)
  .brand<"SourceId">();
const pendingPersonalReminderTimeBasisSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("event"),
    at: utcIsoDateTimeSchema,
    sourceIds: z.array(pendingPersonalReminderSourceIdSchema).nonempty().max(30),
  }),
  z.strictObject({
    source: z.literal("first_observation"),
    at: utcIsoDateTimeSchema,
  }),
  z.strictObject({
    source: z.literal("reconfirmed_observation"),
    at: utcIsoDateTimeSchema,
    previousAt: utcIsoDateTimeSchema,
    sourceIds: z.array(pendingPersonalReminderSourceIdSchema).nonempty().max(30),
  }),
]);
const pendingNotificationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("responsibility"),
    waitingOn: z.array(pendingNotificationWaitingOnSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("unblocked"),
  }),
  z.strictObject({
    kind: z.literal("cycle"),
    cycleId: opaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal("overdue"),
    status: pendingNotificationStatusSchema,
    waitClass: pendingNotificationWaitClassSchema,
    waitingOn: z.array(pendingNotificationWaitingOnSchema).min(1),
    lastProgressAt: utcIsoDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal("personal_reminder"),
    causeId: pendingPersonalReminderCauseIdSchema,
    responsibilityId: pendingPersonalReminderResponsibilityIdSchema,
    actionableSince: pendingPersonalReminderTimeBasisSchema,
    stallSince: pendingPersonalReminderTimeBasisSchema,
  }),
]);

function isPersonalReminderReasonCode(
  reasonCode: Exclude<NotificationReason["reasonCode"], "none">,
): boolean {
  switch (reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "work_overdue":
    case "merge_overdue":
      return true;
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
    case "automation_stuck":
      return false;
  }
}

function pendingNotificationTargetKind(
  reasonCode: Exclude<NotificationReason["reasonCode"], "none">,
): PendingNotificationTarget["kind"] {
  switch (reasonCode) {
    case "responsibility_changed":
      return "responsibility";
    case "newly_unblocked":
      return "unblocked";
    case "dependency_cycle":
      return "cycle";
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "work_overdue":
    case "owner_unknown":
    case "blocker_overdue":
    case "merge_overdue":
    case "automation_stuck":
      return "overdue";
  }
}

/** 送信待ち通知の判定結果を検証するschema。 */
export const pendingNotificationSchema = z
  .strictObject({
    notificationKey: opaqueIdSchema,
    itemNodeId: githubNodeIdSchema,
    reason: notificationReasonSchema,
    detectedAt: utcIsoDateTimeSchema,
    highPriorityEligible: z.boolean(),
    target: pendingNotificationTargetSchema,
  })
  .superRefine((notification, context) => {
    if (
      notification.target.kind !== pendingNotificationTargetKind(notification.reason.reasonCode) &&
      !(
        notification.target.kind === "personal_reminder" &&
        isPersonalReminderReasonCode(notification.reason.reasonCode)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["target", "kind"],
        message: "通知理由と対象kindの組み合わせが不正です",
      });
    }
  });

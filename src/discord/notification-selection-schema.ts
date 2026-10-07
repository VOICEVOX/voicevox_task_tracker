import { z } from "zod";
import {
  createGitHubNodeId,
  createUtcIsoDateTime,
  notificationReasonSchema,
  pendingNotificationSchema,
  personalReminderActionKindSchema,
  personalReminderCauseIdSchema,
  personalReminderResponsibilityIdSchema,
  personalReminderResponsibleSchema,
} from "../domain/index.js";
import { confirmedPersonalReminderTimeBasisSchema } from "../domain/personal-reminder-causes.js";
const actionsSecretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => createUtcIsoDateTime(value));
const nodeIdSchema = z
  .string()
  .min(1)
  .transform((value) => createGitHubNodeId(value));
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const notificationReasonCodeSchema = z.enum([
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "work_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "merge_overdue",
  "automation_stuck",
]);
const selectedReasonSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("system"),
  }),
  z.strictObject({
    kind: z.literal("personal_reminder"),
    context: z.strictObject({
      causeId: personalReminderCauseIdSchema,
      responsibilityId: personalReminderResponsibilityIdSchema,
      responsible: z.array(personalReminderResponsibleSchema).nonempty().max(20),
      action: z.strictObject({
        kind: personalReminderActionKindSchema,
        summary: z.string().min(1).max(300),
      }),
      obligationSince: confirmedPersonalReminderTimeBasisSchema,
      actionableSince: confirmedPersonalReminderTimeBasisSchema,
      stallSince: confirmedPersonalReminderTimeBasisSchema,
    }),
  }),
]);
const selectedReasonSchema = z
  .strictObject({
    notificationKey: z.string().min(1).max(1000),
    reasonCode: notificationReasonCodeSchema,
    threshold: z.unknown(),
    severity: severitySchema,
    source: selectedReasonSourceSchema,
  })
  .transform((selectedReason, context) => {
    const reasonResult = notificationReasonSchema.safeParse({
      reasonCode: selectedReason.reasonCode,
      threshold: selectedReason.threshold,
    });
    if (!reasonResult.success) {
      for (const issue of reasonResult.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
      return z.NEVER;
    }
    return {
      ...reasonResult.data,
      notificationKey: selectedReason.notificationKey,
      severity: selectedReason.severity,
      source: selectedReason.source,
    };
  });
const notificationCandidateSchema = z.strictObject({
  itemNodeId: nodeIdSchema,
  reasons: z.array(selectedReasonSchema).min(1),
  severity: severitySchema,
  downstreamImpact: z.strictObject({
    nodeId: nodeIdSchema,
    openNodeCount: z.number().int().nonnegative(),
    repositoryCount: z.number().int().nonnegative(),
  }),
  priorityWeight: z.number(),
});
const ledgerReservationSchema = z.strictObject({
  notificationKey: z.string().min(1).max(1000),
  itemNodeId: nodeIdSchema,
  reasonCode: notificationReasonCodeSchema,
  severity: severitySchema,
  reservedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  status: z.literal("reserved"),
});
const notificationSelectionSkipReasonSchema = z.enum(["no_candidates", "held"]);
export const notificationSelectionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("skip_digest"),
    reason: notificationSelectionSkipReasonSchema,
    candidates: z.tuple([]),
    ledgerReservations: z.tuple([]),
    pendingNotifications: z.array(pendingNotificationSchema),
  }),
  z.strictObject({
    action: z.literal("create_digest"),
    candidates: z.array(notificationCandidateSchema).min(1),
    ledgerReservations: z.array(ledgerReservationSchema).min(1),
    pendingNotifications: z.array(pendingNotificationSchema),
  }),
]);
export const discordSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  webhookSecretName: actionsSecretNameSchema,
  operationsWebhookSecretName: actionsSecretNameSchema,
  mentions: z.strictObject({
    enabled: z.boolean(),
    users: z.record(z.string().min(1), z.string().regex(/^\d{17,20}$/u)),
  }),
  retry: z
    .strictObject({
      maxAttempts: z.number().int().positive(),
      initialDelaySeconds: z.number().nonnegative(),
      maxDelaySeconds: z.number().nonnegative(),
    })
    .refine((retry) => retry.initialDelaySeconds <= retry.maxDelaySeconds, {
      message: "Discord retryの初期待機時間は最大待機時間以下にしてください",
    }),
});

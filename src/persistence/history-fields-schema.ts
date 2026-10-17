import { z } from "zod";

import { type LegacyStatus } from "./legacy-enum.js";

export const STATE_HISTORY_SCHEMA_VERSION_1 = "1";
export const STATE_HISTORY_SCHEMA_VERSION_2 = "2";
export const STATE_HISTORY_SCHEMA_VERSION_3 = "3";
export const STATE_HISTORY_SCHEMA_VERSION_4 = "4";
export const STATE_HISTORY_SCHEMA_VERSION_5 = "5";
export const STATE_HISTORY_SCHEMA_VERSION_6 = "6";
export const STATE_HISTORY_SCHEMA_VERSION_7 = "7";

export const historySchemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});
export const identifierSchema = z.string().min(1).max(512).regex(/^\S+$/u);
export const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const actorSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["human", "bot"]),
    nodeId: identifierSchema,
    login: identifierSchema,
  }),
  z.strictObject({
    type: z.literal("system"),
    name: z.string().min(1).max(512),
  }),
]);
export const inputEventSchema = z.strictObject({
  sourceId: identifierSchema,
  itemNodeId: identifierSchema,
  kind: z.enum([
    "comment",
    "push",
    "review",
    "review_request",
    "label",
    "assignee",
    "state",
    "relation",
    "ready_for_review",
    "converted_to_draft",
    "added_to_merge_queue",
    "removed_from_merge_queue",
    "auto_merge_enabled",
    "auto_merge_disabled",
  ]),
  actor: actorSchema,
  occurredAt: dateTimeSchema,
});
export const inputEventsSchema = z.array(inputEventSchema).superRefine((events, context) => {
  const sourceIdsByItemNodeId = new Map<string, Set<string>>();
  for (const event of events) {
    const sourceIds = sourceIdsByItemNodeId.get(event.itemNodeId);
    if (sourceIds == null) {
      sourceIdsByItemNodeId.set(event.itemNodeId, new Set([event.sourceId]));
      continue;
    }
    if (sourceIds.has(event.sourceId)) {
      context.addIssue({
        code: "custom",
        message: "同じ項目の正規化イベントのsource IDが重複しています",
      });
      continue;
    }
    sourceIds.add(event.sourceId);
  }
});

export function isCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isCalendarDate);
export const legacyStatusSchema: z.ZodType<LegacyStatus> = z.enum([
  "new_untriaged",
  "needs_maintainer_decision",
  "waiting_for_author",
  "waiting_for_assignee",
  "blocked",
  "ready_to_merge",
  "waiting_for_owner",
  "waiting_for_review",
  "waiting_for_automation",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
]);
export const STATE_HISTORY_STATUS_VALUES = [
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
] as const;
const statusSchema = z.enum(STATE_HISTORY_STATUS_VALUES);
const waitingOnRoleSchema = z.enum([
  "author",
  "maintainer",
  "reviewer",
  "assignee",
  "respondent",
  "dependency",
  "merge_decider",
  "ci",
  "unknown",
]);
const waitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: identifierSchema,
  role: waitingOnRoleSchema,
  reasonSummary: z.string().max(1000),
  sourceIds: z.array(identifierSchema).min(1),
  confidence: z.number().min(0).max(1),
});
const notificationWaitingOnReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("team"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("role"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("item"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
    displayReference: z.string().min(4).max(600).regex(/^\S+$/u),
  }),
  z.strictObject({
    kind: z.literal("automation"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
]);
export const notificationWaitingOnRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_recorded"),
  }),
  z.strictObject({
    status: z.literal("recorded"),
    values: z.array(notificationWaitingOnReferenceSchema).min(1),
  }),
]);
export const responsibilitySchema = z.strictObject({
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
});
export const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
export const notificationReasonCodeSchema = z.enum([
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "merge_overdue",
  "automation_stuck",
]);
const legacyNotificationTimeReasonThresholdSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    hours: z.number().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("not_recorded"),
  }),
]);
const legacyNotificationNotApplicableThresholdSchema = z.strictObject({
  status: z.literal("not_applicable"),
});
export const legacyNotificationReasonSchema = z.discriminatedUnion("reasonCode", [
  z.strictObject({
    reasonCode: z.literal("assessment_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("owner_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("decision_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("review_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("revision_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("reply_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("merge_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("automation_stuck"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("owner_unknown"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("blocker_overdue"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("newly_unblocked"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("dependency_cycle"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("responsibility_changed"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
]);
const evidenceSchema = z.strictObject({
  sourceId: identifierSchema,
  supports: z.enum([
    "status",
    "waiting_on",
    "relation",
    "progress",
    "notification",
    "uncertainty",
    "self_commitment",
  ]),
  summary: z.string().max(1000),
});
const relationContradictionSchema = z.strictObject({
  verdict: z.enum([
    "current_is_blocked_by_target",
    "current_blocks_target",
    "current_implements_target",
    "target_is_subtask_of_current",
    "current_is_subtask_of_target",
    "duplicates",
    "related",
    "none",
  ]),
  confidence: z.number().min(0).max(1),
});
const edgeFieldsSchema = z.strictObject({
  fromNodeId: identifierSchema,
  toNodeId: identifierSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
    "ai_inference",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
  contradictions: z.array(relationContradictionSchema),
  firstSeenAt: dateTimeSchema,
  lastConfirmedAt: dateTimeSchema,
});
export const edgeSchema = z.discriminatedUnion("active", [
  edgeFieldsSchema.extend({
    active: z.literal(true),
  }),
  edgeFieldsSchema.extend({
    active: z.literal(false),
    removedAt: dateTimeSchema,
  }),
]);
export const stateHistoryStateEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("responsibility_set"),
    nodeId: identifierSchema,
    value: responsibilitySchema,
  }),
  z.strictObject({
    kind: z.literal("responsibility_removed"),
    nodeId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("severity_set"),
    nodeId: identifierSchema,
    value: severitySchema,
  }),
  z.strictObject({
    kind: z.literal("severity_removed"),
    nodeId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("edge_set"),
    relationId: identifierSchema,
    value: edgeSchema,
  }),
  z.strictObject({
    kind: z.literal("edge_removed"),
    relationId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("repository_excluded"),
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    reason: z.literal("archived"),
  }),
]);

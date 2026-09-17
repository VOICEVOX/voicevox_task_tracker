import { z } from "zod";

import { IMPORTANCE_FACTOR_KINDS } from "../domain/importance.js";
import { notificationReasonSchema } from "../domain/notification-reason.js";
import { personalReminderTimeBasisSchema } from "../domain/personal-reminder-causes.js";
import { isTerminalStatus } from "../domain/status.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { PublicDtoSemanticError, PublicDtoValidationError } from "./errors.js";

/** Pages公開DTOのschema version。 */
export const PUBLIC_DTO_SCHEMA_VERSION = "10";

const identifierSchema = z.string().min(1).max(512).regex(/^\S+$/u);
const shortStringSchema = z.string().max(1000);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const githubUrlSchema = z
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
  }, "GitHubのHTTPS URLを指定してください");
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const statusSchema = z.enum([
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
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const importanceLevelSchema = z.enum(["low", "medium", "high"]);
const deadlineLevelSchema = z.enum([
  "none",
  "over_30_days",
  "within_30_days",
  "within_7_days",
  "within_3_days",
  "within_1_day",
  "overdue",
]);
function isCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

const deadlineDateSchema = z.union([
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .refine(isCalendarDate, {
      message: "実在する日付を指定してください",
    }),
  z.null(),
]);
const publicImportanceSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  level: importanceLevelSchema,
});
const importanceFactorSchema = z.strictObject({
  kind: z.enum(IMPORTANCE_FACTOR_KINDS),
  points: z.number().positive(),
  detail: z.string().min(1).max(1000),
});
const waitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: identifierSchema,
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
  reasonSummary: shortStringSchema,
  confidence: z.number().min(0).max(1),
});
const primaryWaitingOnSchema = z.discriminatedUnion("index", [
  z.strictObject({
    index: z.literal(0),
    selectionReason: shortStringSchema,
  }),
  z.strictObject({
    index: z.literal("not_applicable"),
    selectionReason: shortStringSchema,
  }),
]);
const publicEvidenceSchema = z.strictObject({
  summary: shortStringSchema,
  sourceUrl: githubUrlSchema,
});
const publicPersonalReminderResponsibleSchema = z.strictObject({
  kind: z.enum(["user", "team", "role"]),
  candidateId: identifierSchema,
  role: z.enum([
    "author",
    "maintainer",
    "reviewer",
    "assignee",
    "respondent",
    "merge_decider",
    "unknown",
  ]),
});
const publicCurrentResponseSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    candidateId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("team"),
    candidateId: identifierSchema,
  }),
]);
const publicCurrentResponseSubjectChangesSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("bounded"),
    addableSubjects: z.array(publicCurrentResponseSubjectSchema),
    removableSubjects: z.array(publicCurrentResponseSubjectSchema),
  }),
  z.strictObject({
    scope: z.literal("unbounded"),
  }),
]);
const publicPersonalReminderActionSchema = z.strictObject({
  kind: z.enum(["assessment", "owner", "decision", "review", "revision", "reply", "work", "merge"]),
  summary: shortStringSchema,
});
const publicPersonalReminderUnverifiedValueSchema = z.enum([
  "status",
  "responsible",
  "action",
  "evidence",
  "waitingFor",
]);
const publicPersonalReminderUnknownReasonSchema = z.enum([
  "input_mismatch",
  "not_evaluated",
  "failed",
  "deferred",
  "incomplete_input",
  "conflicting_evidence",
  "ambiguous_meaning",
]);
const publicPersonalReminderResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    causeId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    evidence: z.array(publicEvidenceSchema).nonempty(),
    unverifiedValues: z.array(publicPersonalReminderUnverifiedValueSchema).max(5),
    subjectMembershipUnverified: z.boolean(),
    status: z.literal("actionable"),
  }),
  z.strictObject({
    causeId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    evidence: z.array(publicEvidenceSchema).nonempty(),
    unverifiedValues: z.array(publicPersonalReminderUnverifiedValueSchema).max(5),
    subjectMembershipUnverified: z.boolean(),
    status: z.literal("waiting"),
    waitingFor: z.strictObject({
      itemNodeId: identifierSchema,
      action: shortStringSchema,
    }),
  }),
  z.strictObject({
    causeId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    evidence: z.array(publicEvidenceSchema).nonempty(),
    unverifiedValues: z.array(publicPersonalReminderUnverifiedValueSchema).max(5),
    subjectMembershipUnverified: z.boolean(),
    status: z.literal("unknown"),
    reason: publicPersonalReminderUnknownReasonSchema,
  }),
]);
const publicPersonalReminderCausePlanningStatusSchema = z.enum([
  "pending",
  "completed",
  "excluded",
]);
const repositoryFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("fresh"),
  }),
  z.strictObject({
    status: z.literal("stale"),
  }),
]);
const publicRepositorySchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1).max(256),
  fullName: z.string().min(3).max(513),
  freshness: repositoryFreshnessSchema,
});
const downstreamImpactSchema = z.strictObject({
  nodeId: identifierSchema,
  openNodeCount: nonNegativeIntegerSchema,
  repositoryCount: nonNegativeIntegerSchema,
});
const accountActorSchema = z.strictObject({
  type: z.enum(["human", "bot"]),
  nodeId: identifierSchema,
  login: z.string().min(1).max(256),
});
const itemAuthorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("identified"),
    actor: accountActorSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("deleted_account"),
  }),
]);
const publicDeadlineSummarySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z
    .strictObject({
      status: z.literal("available"),
      date: deadlineDateSchema,
      level: deadlineLevelSchema,
    })
    .superRefine((deadline, context) => {
      if (deadline.date == null && deadline.level !== "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がnullの場合は切迫度をnoneにしてください",
        });
      }
      if (deadline.date != null && deadline.level === "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がある場合は切迫度をnone以外にしてください",
        });
      }
    }),
]);
const publicDeadlineDetailsSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z
    .strictObject({
      status: z.literal("available"),
      date: deadlineDateSchema,
      level: deadlineLevelSchema,
      rationale: z.string().min(1).max(120),
    })
    .superRefine((deadline, context) => {
      if (deadline.date == null && deadline.level !== "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がnullの場合は切迫度をnoneにしてください",
        });
      }
      if (deadline.date != null && deadline.level === "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がある場合は切迫度をnone以外にしてください",
        });
      }
    }),
]);
const publicItemAiAnalysisSchema = z.strictObject({
  runStatus: z.enum(["used", "failed", "deferred", "not_required", "disabled", "not_recorded"]),
  omission: z.enum(["none", "partial", "all"]),
  unverifiedValues: z
    .array(
      z.enum([
        "status",
        "waitingOn",
        "primaryWaitingOn",
        "nextAction",
        "confidence",
        "evidence",
        "uncertainties",
        "deadline",
        "staleness",
        "downstreamImpact",
        "importance",
        "attention",
        "blockers",
        "relations",
      ]),
    )
    .max(14),
});
const publicCurrentImplementationSchema = z.strictObject({
  nodeId: identifierSchema,
  repositoryId: identifierSchema,
  displayReference: z.string().min(4).max(600),
  number: z.number().int().positive(),
  url: githubUrlSchema,
  title: z.string().max(500),
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
  nextAction: shortStringSchema,
});
const publicItemSummarySchema = z.strictObject({
  nodeId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  repositoryId: identifierSchema,
  displayReference: z.string().min(4).max(600),
  number: z.number().int().positive(),
  url: githubUrlSchema,
  title: z.string().max(500),
  deadline: publicDeadlineSummarySchema,
  state: z.enum(["open", "closed", "merged"]),
  author: itemAuthorSchema,
  assignees: z.array(accountActorSchema),
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
  primaryWaitingOn: primaryWaitingOnSchema,
  nextAction: shortStringSchema,
  severity: severitySchema,
  importance: publicImportanceSchema,
  attention: publicImportanceSchema,
  priorityWeight: z.number(),
  aiAnalysis: publicItemAiAnalysisSchema,
  confidence: z.number().min(0).max(1),
  githubUpdatedAt: dateTimeSchema,
  stallSince: dateTimeSchema,
  observedAt: dateTimeSchema,
  repositoryFreshness: z.enum(["fresh", "stale"]),
  blockerNodeIds: z.array(identifierSchema),
  downstreamImpact: downstreamImpactSchema,
  currentImplementations: z.array(publicCurrentImplementationSchema),
  currentResponses: z.array(publicPersonalReminderResponseSchema),
  currentResponsesUnverified: z.boolean(),
  currentResponseSubjectChanges: publicCurrentResponseSubjectChangesSchema,
  personalReminderCausePlanningStatus: publicPersonalReminderCausePlanningStatusSchema,
});
const itemTimestampsSchema = z.strictObject({
  createdAt: dateTimeSchema,
  githubUpdatedAt: dateTimeSchema,
  stallSince: dateTimeSchema,
});
const latestEventActorValueSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["human", "bot"]),
    login: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal("system"),
    name: z.string().min(1).max(512),
  }),
]);
const latestEventActorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("absent"),
  }),
  z.strictObject({
    status: z.literal("present"),
    actor: latestEventActorValueSchema,
  }),
]);
const responsibilitySchema = z.strictObject({
  status: statusSchema,
  waitingOn: z.array(
    waitingOnSchema.omit({
      reasonSummary: true,
      confidence: true,
    }),
  ),
});
const responsibilityHistoryValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("absent"),
  }),
  z.strictObject({
    state: z.literal("present"),
    value: responsibilitySchema,
  }),
]);
const publicItemHistoryEventSchema = z.strictObject({
  kind: z.literal("responsibility_changed"),
  recordedAt: dateTimeSchema,
  before: responsibilityHistoryValueSchema,
  after: responsibilityHistoryValueSchema,
});
const publicBlockerUnverifiedReasonSchema = z.enum([
  "relation_support",
  "retained_waiting",
  "waiting_value",
]);
const publicBlockerUnverifiedReasonsSchema = z.strictObject({
  nodeId: identifierSchema,
  reasons: z.array(publicBlockerUnverifiedReasonSchema).nonempty().max(3),
});
const publicItemDetailsSchema = z.strictObject({
  summary: publicItemSummarySchema,
  blockerUnverifiedReasons: z.array(publicBlockerUnverifiedReasonsSchema),
  deadline: publicDeadlineDetailsSchema,
  importanceFactors: z.array(importanceFactorSchema),
  timestamps: itemTimestampsSchema,
  latestEventActor: latestEventActorSchema,
  labels: z.array(z.string().min(1).max(256)),
  reviewState: z.enum([
    "not_applicable",
    "not_requested",
    "requested",
    "changes_requested",
    "approved",
    "unknown",
  ]),
  checkState: z.enum([
    "not_applicable",
    "not_required",
    "pending",
    "passing",
    "failing",
    "conflict",
    "unknown",
  ]),
  evidence: z.array(publicEvidenceSchema),
  uncertainties: z.array(shortStringSchema),
  history: z.array(publicItemHistoryEventSchema),
});
const publicTrackedGraphNodeFieldsSchema = z.strictObject({
  nodeId: identifierSchema,
  repositoryId: identifierSchema,
  state: z.enum(["open", "closed", "merged"]),
  status: statusSchema,
  severity: severitySchema,
});
const publicGraphNodeSchema = z.discriminatedUnion("kind", [
  publicTrackedGraphNodeFieldsSchema.extend({
    kind: z.literal("issue"),
  }),
  publicTrackedGraphNodeFieldsSchema.extend({
    kind: z.literal("pull_request"),
  }),
  z.strictObject({
    nodeId: identifierSchema,
    kind: z.literal("external_reference"),
    repositoryFullName: z.string().min(3).max(513),
    displayReference: z.string().min(4).max(600),
    url: githubUrlSchema,
    title: z.string().max(500),
    state: z.enum(["open", "closed", "merged"]),
  }),
]);
const publicGraphEdgeFieldsSchema = z.strictObject({
  id: identifierSchema,
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
  aiCurrentness: z.enum(["not_dependent", "current", "unverified"]),
});
const publicGraphEdgeSchema = z.discriminatedUnion("active", [
  publicGraphEdgeFieldsSchema.extend({
    active: z.literal(true),
  }),
  publicGraphEdgeFieldsSchema.extend({
    active: z.literal(false),
  }),
]);
const publicInitialGraphSchema = z.strictObject({
  nodes: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        nodeId: identifierSchema,
        kind: z.literal("issue"),
      }),
      z.strictObject({
        nodeId: identifierSchema,
        kind: z.literal("pull_request"),
      }),
      z.strictObject({
        nodeId: identifierSchema,
        kind: z.literal("external_reference"),
        displayReference: z.string().min(4).max(600),
      }),
    ]),
  ),
  maxNodes: z.number().int().positive(),
});
const publicGraphSchema = z.strictObject({
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicGraphEdgeSchema),
  frontierNodeIds: z.array(identifierSchema),
});
const publicConfidenceThresholdsSchema = z
  .strictObject({
    high: z.number().min(0).max(1),
    medium: z.number().min(0).max(1),
  })
  .refine((thresholds) => thresholds.high >= thresholds.medium, {
    message: "high confidence閾値はmedium confidence閾値以上にしてください",
    path: ["high"],
  });
const publicAiStateSchema = z.union([
  z.strictObject({
    enabled: z.literal(false),
    available: z.literal(false),
    degraded: z.literal(false),
  }),
  z.strictObject({
    enabled: z.literal(true),
    available: z.literal(true),
    degraded: z.boolean(),
  }),
  z.strictObject({
    enabled: z.literal(true),
    available: z.literal(false),
    degraded: z.literal(true),
  }),
]);
const publicSummaryDtoSchema = z.strictObject({
  schemaVersion: z.literal(PUBLIC_DTO_SCHEMA_VERSION),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  observedAt: dateTimeSchema,
  timezone: identifierSchema,
  ai: publicAiStateSchema,
  confidenceThresholds: publicConfidenceThresholdsSchema,
  repositories: z.array(publicRepositorySchema),
  items: z.array(publicItemSummarySchema),
  graph: publicInitialGraphSchema,
});
const publicDetailsDtoSchema = z.strictObject({
  schemaVersion: z.literal(PUBLIC_DTO_SCHEMA_VERSION),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  items: z.array(publicItemDetailsSchema),
  graph: publicGraphSchema,
});
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

const publicNotificationHistoryPersonalReminderSchema = z
  .strictObject({
    notificationKey: identifierSchema,
    causeId: identifierSchema,
    responsibilityId: identifierSchema,
    responsible: z.array(publicPersonalReminderResponsibleSchema).nonempty().max(20),
    action: publicPersonalReminderActionSchema,
    reason: notificationReasonSchema,
    obligationSince: personalReminderTimeBasisSchema,
    actionableSince: personalReminderTimeBasisSchema,
    stallSince: personalReminderTimeBasisSchema,
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
const publicNotificationHistoryEntrySchema = z
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
const publicNotificationHistoryDtoSchema = z
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Web初期表示で共有するschema version 10の公開summary DTO。 */
export type PublicSummaryDto = z.output<typeof publicSummaryDtoSchema>;

/** Web詳細表示で共有するschema version 10の公開details DTO。 */
export type PublicDetailsDto = z.output<typeof publicDetailsDtoSchema>;

/** 公開summary DTO内の項目。 */
export type PublicItemSummaryDto = z.output<typeof publicItemSummarySchema>;

/** 公開details DTO内の項目。 */
export type PublicItemDetailsDto = z.output<typeof publicItemDetailsSchema>;

/** 個人催促の現在対応を表す公開DTO。 */
export type PublicPersonalReminderResponseDto = z.output<
  typeof publicPersonalReminderResponseSchema
>;

/** 個人催促の現在対応がunknownである理由。 */
export type PublicPersonalReminderUnknownReason = z.output<
  typeof publicPersonalReminderUnknownReasonSchema
>;

/** 現在対応の人物集計へ影響し得る主体。 */
export type PublicCurrentResponseSubjectDto = z.output<typeof publicCurrentResponseSubjectSchema>;

/** 現在対応の人物集計へ影響し得る主体の変化。 */
export type PublicCurrentResponseSubjectChangesDto = z.output<
  typeof publicCurrentResponseSubjectChangesSchema
>;

/** 公開DTO内のグラフnode。 */
export type PublicGraphNodeDto = z.output<typeof publicGraphNodeSchema>;

/** 公開DTO内のグラフedge。 */
export type PublicGraphEdgeDto = z.output<typeof publicGraphEdgeSchema>;

/** 公開DTO内の項目履歴差分。 */
export type PublicItemHistoryEventDto = z.output<typeof publicItemHistoryEventSchema>;

/** 通知履歴の公開DTO。 */
export type PublicNotificationHistoryDto = z.output<typeof publicNotificationHistoryDtoSchema>;

/** 通知履歴の公開entry。 */
export type PublicNotificationHistoryEntryDto = z.output<
  typeof publicNotificationHistoryEntrySchema
>;

/** 公開通知履歴へ保存する個人催促context。 */
export type PublicNotificationHistoryPersonalReminderDto = z.output<
  typeof publicNotificationHistoryPersonalReminderSchema
>;

/** 通知履歴entryを送信時刻降順と表示情報で比較する。 */
export function comparePublicNotificationHistoryEntries(
  left: PublicNotificationHistoryEntryDto,
  right: PublicNotificationHistoryEntryDto,
): number {
  if (left.sentAt > right.sentAt) {
    return -1;
  }
  if (left.sentAt < right.sentAt) {
    return 1;
  }
  if (left.item.displayReference < right.item.displayReference) {
    return -1;
  }
  if (left.item.displayReference > right.item.displayReference) {
    return 1;
  }
  if (left.item.url < right.item.url) {
    return -1;
  }
  if (left.item.url > right.item.url) {
    return 1;
  }
  const reasonCount = Math.min(left.reasons.length, right.reasons.length);
  for (let index = 0; index < reasonCount; index += 1) {
    const leftReason = left.reasons[index];
    const rightReason = right.reasons[index];
    if (leftReason == null || rightReason == null) {
      throw new TypeError("通知履歴の理由を取得できません");
    }
    if (leftReason.reasonCode < rightReason.reasonCode) {
      return -1;
    }
    if (leftReason.reasonCode > rightReason.reasonCode) {
      return 1;
    }
    const leftThreshold = JSON.stringify(leftReason.threshold);
    const rightThreshold = JSON.stringify(rightReason.threshold);
    if (leftThreshold < rightThreshold) {
      return -1;
    }
    if (leftThreshold > rightThreshold) {
      return 1;
    }
  }
  if (left.reasons.length < right.reasons.length) {
    return -1;
  }
  if (left.reasons.length > right.reasons.length) {
    return 1;
  }
  return 0;
}

type PublicItemDisplayIdentity = Readonly<{
  number: number;
  owner: string;
  repository: string;
}>;

type PublicItemUrlIdentity = Readonly<{
  number: number;
  owner: string;
  repository: string;
  type: "issue" | "pull_request";
}>;

function parsePublicItemDisplayReference(displayReference: string): PublicItemDisplayIdentity {
  const match = /^([^/\s#?%]+)\/([^/\s#?%]+)#([1-9]\d*)$/u.exec(displayReference);
  if (match == null) {
    throw new PublicDtoSemanticError(
      "公開項目の表示参照がowner/repository#number形式ではありません",
    );
  }
  const owner = match[1];
  const repository = match[2];
  const numberText = match[3];
  assertNonNullable(owner, "公開項目の表示参照ownerを取得できません");
  assertNonNullable(repository, "公開項目の表示参照repositoryを取得できません");
  assertNonNullable(numberText, "公開項目の表示参照numberを取得できません");
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number)) {
    throw new PublicDtoSemanticError("公開項目の表示参照numberが安全な整数ではありません");
  }
  return {
    owner,
    repository,
    number,
  };
}

function parsePublicItemUrl(urlValue: string): PublicItemUrlIdentity {
  if (urlValue.includes("?") || urlValue.includes("#") || urlValue.includes("\\")) {
    throw new PublicDtoSemanticError(
      "公開項目のURLにquery、hash、または不正な区切り文字があります",
    );
  }
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PublicDtoSemanticError("公開項目のURLがGitHubのHTTPS URLではありません");
  }
  const match = /^\/([^/\s?#%]+)\/([^/\s?#%]+)\/(issues|pull)\/([1-9]\d*)$/u.exec(url.pathname);
  if (match == null) {
    throw new PublicDtoSemanticError(
      "公開項目のURL pathがIssueまたはPull Requestの形式ではありません",
    );
  }
  const owner = match[1];
  const repository = match[2];
  const kind = match[3];
  const numberText = match[4];
  assertNonNullable(owner, "公開項目のURL ownerを取得できません");
  assertNonNullable(repository, "公開項目のURL repositoryを取得できません");
  assertNonNullable(kind, "公開項目のURL種別を取得できません");
  assertNonNullable(numberText, "公開項目のURL numberを取得できません");
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number)) {
    throw new PublicDtoSemanticError("公開項目のURL numberが安全な整数ではありません");
  }
  return {
    owner,
    repository,
    number,
    type: kind === "issues" ? "issue" : "pull_request",
  };
}

function assertPublicNotificationHistoryEntryItem(entry: PublicNotificationHistoryEntryDto): void {
  const displayIdentity = parsePublicItemDisplayReference(entry.item.displayReference);
  const urlIdentity = parsePublicItemUrl(entry.item.url);
  if (
    displayIdentity.owner !== urlIdentity.owner ||
    displayIdentity.repository !== urlIdentity.repository ||
    displayIdentity.number !== urlIdentity.number ||
    entry.item.number !== displayIdentity.number ||
    entry.item.type !== urlIdentity.type
  ) {
    throw new PublicDtoSemanticError(
      `通知履歴の表示参照とURLのitem identityが一致しません。対象: ${entry.item.nodeId}`,
    );
  }
  for (const waitingOn of entry.waitingOn) {
    if (waitingOn.kind === "item") {
      parsePublicItemDisplayReference(waitingOn.displayReference);
    }
  }
}

function comparePublicCurrentImplementations(
  left: PublicItemSummaryDto["currentImplementations"][number],
  right: PublicItemSummaryDto["currentImplementations"][number],
): number {
  if (left.nodeId < right.nodeId) {
    return -1;
  }
  if (left.nodeId > right.nodeId) {
    return 1;
  }
  return 0;
}

const publicPersonalReminderUnverifiedValueOrder: readonly PublicPersonalReminderResponseDto["unverifiedValues"][number][] =
  ["status", "responsible", "action", "evidence", "waitingFor"];

function assertPublicPersonalReminderResponses(
  itemNodeId: string,
  responses: readonly PublicPersonalReminderResponseDto[],
): void {
  for (const response of responses) {
    if (new Set(response.unverifiedValues).size !== response.unverifiedValues.length) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のpersonal reminder response ${response.causeId}のAI未検証値が重複しています`,
      );
    }
    let previousValue: PublicPersonalReminderResponseDto["unverifiedValues"][number] | undefined;
    for (const value of response.unverifiedValues) {
      if (previousValue != null) {
        const previousOrder = publicPersonalReminderUnverifiedValueOrder.indexOf(previousValue);
        const currentOrder = publicPersonalReminderUnverifiedValueOrder.indexOf(value);
        if (previousOrder >= currentOrder) {
          throw new PublicDtoSemanticError(
            `item ${itemNodeId}のpersonal reminder response ${response.causeId}のAI未検証値が固定順ではありません`,
          );
        }
      }
      previousValue = value;
    }
    if (response.status !== "waiting" && response.unverifiedValues.includes("waitingFor")) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のwaitingでないpersonal reminder responseにwaitingForのAI未検証値があります`,
      );
    }
    if (
      response.unverifiedValues.includes("waitingFor") &&
      !response.unverifiedValues.includes("status")
    ) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のpersonal reminder responseでwaitingForのAI未検証値にstatusが伴っていません`,
      );
    }
    if (
      response.unverifiedValues.includes("responsible") &&
      response.responsible.some((responsible) => responsible.kind !== "role") &&
      !response.subjectMembershipUnverified
    ) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のpersonal reminder responseでresponsibleのAI未検証値にsubject membershipの未検証が伴っていません`,
      );
    }
  }
}

function publicCurrentResponseSubjectKey(subject: PublicCurrentResponseSubjectDto): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function assertPublicCurrentResponseSubjects(
  itemNodeId: string,
  description: string,
  subjects: readonly PublicCurrentResponseSubjectDto[],
): void {
  const keys = subjects.map(publicCurrentResponseSubjectKey);
  if (new Set(keys).size !== keys.length) {
    throw new PublicDtoSemanticError(`item ${itemNodeId}の${description}が重複しています`);
  }
  let previousKey: string | undefined;
  for (const key of keys) {
    if (previousKey != null && compareStrings(previousKey, key) > 0) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}の${description}が決定論的な順序になっていません`,
      );
    }
    previousKey = key;
  }
}

function assertPublicCurrentResponseSubjectChanges(item: PublicItemSummaryDto): void {
  const changes = item.currentResponseSubjectChanges;
  if (changes.scope === "unbounded") {
    return;
  }
  assertPublicCurrentResponseSubjects(
    item.nodeId,
    "追加可能な現在対応主体",
    changes.addableSubjects,
  );
  assertPublicCurrentResponseSubjects(
    item.nodeId,
    "削除可能な現在対応主体",
    changes.removableSubjects,
  );
}

const publicUnverifiedValueOrder: readonly PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number][] =
  [
    "status",
    "waitingOn",
    "primaryWaitingOn",
    "nextAction",
    "confidence",
    "evidence",
    "uncertainties",
    "deadline",
    "staleness",
    "downstreamImpact",
    "importance",
    "attention",
    "blockers",
    "relations",
  ];

function assertPublicUnverifiedValues(
  itemNodeId: string,
  values: readonly PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number][],
): void {
  if (new Set(values).size !== values.length) {
    throw new PublicDtoSemanticError(`item ${itemNodeId}のAI未検証値が重複しています`);
  }
  let previousValue: PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number] | undefined;
  for (const value of values) {
    if (previousValue != null) {
      const previousOrder = publicUnverifiedValueOrder.indexOf(previousValue);
      const currentOrder = publicUnverifiedValueOrder.indexOf(value);
      if (previousOrder >= currentOrder) {
        throw new PublicDtoSemanticError(`item ${itemNodeId}のAI未検証値が固定順ではありません`);
      }
    }
    previousValue = value;
  }
}

function assertPublicUniqueSortedIds(ids: readonly string[], description: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new PublicDtoSemanticError(`${description}が重複しています`);
  }
  let previousId: string | undefined;
  for (const id of ids) {
    if (previousId != null && compareStrings(previousId, id) > 0) {
      throw new PublicDtoSemanticError(`${description}が決定論的な順序になっていません`);
    }
    previousId = id;
  }
}

function assertPublicItemSummarySemantics(item: PublicItemSummaryDto): void {
  assertPublicUnverifiedValues(item.nodeId, item.aiAnalysis.unverifiedValues);
  assertPublicUniqueSortedIds(item.blockerNodeIds, `item ${item.nodeId}のblocker node ID`);
  if (item.status === "waiting_for_unblock") {
    if (item.primaryWaitingOn.index !== 0) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}はwaiting_for_unblockですがprimary waitingOnがありません`,
      );
    }
    const primaryWaitingOn = item.waitingOn[0];
    if (
      primaryWaitingOn?.kind !== "item" ||
      primaryWaitingOn.role !== "dependency" ||
      !item.blockerNodeIds.includes(primaryWaitingOn.candidateId)
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のprimary waitingOnがblocker node IDに含まれていません`,
      );
    }
  }
  assertPublicPersonalReminderResponses(item.nodeId, item.currentResponses);
  assertPublicCurrentResponseSubjectChanges(item);
}

function assertPublicNativeGraphEdgeCurrentness(edges: readonly PublicGraphEdgeDto[]): void {
  for (const edge of edges) {
    if (edge.provenance === "native" && edge.aiCurrentness !== "not_dependent") {
      throw new PublicDtoSemanticError(
        `native graph edge ${edge.id}のAI現在性はnot_dependentでなければなりません`,
      );
    }
  }
}

function assertPublicUnverifiedRelationSemantics(details: PublicDetailsDto): void {
  const itemsByNodeId = new Map(details.items.map((item) => [item.summary.nodeId, item.summary]));
  const activeSupportsByMeaning = new Map<string, PublicGraphEdgeDto[]>();
  for (const edge of details.graph.edges) {
    if (!edge.active) {
      continue;
    }
    const meaningKey = JSON.stringify([edge.type, edge.fromNodeId, edge.toNodeId]);
    const supports = activeSupportsByMeaning.get(meaningKey);
    if (supports == null) {
      activeSupportsByMeaning.set(meaningKey, [edge]);
    } else {
      supports.push(edge);
    }
  }
  for (const supports of activeSupportsByMeaning.values()) {
    if (supports.some((edge) => edge.aiCurrentness !== "unverified")) {
      continue;
    }
    const firstSupport = supports[0];
    assertNonNullable(firstSupport, "active relation supportがありません");
    for (const nodeId of [firstSupport.fromNodeId, firstSupport.toNodeId]) {
      const item = itemsByNodeId.get(nodeId);
      if (item == null) {
        continue;
      }
      if (!item.aiAnalysis.unverifiedValues.includes("relations")) {
        throw new PublicDtoSemanticError(
          `AI未検証supportだけを持つactive relation ${firstSupport.id}の項目 ${nodeId}にAI未検証値relationsがありません`,
        );
      }
    }
  }
}

function assertPublicUnverifiedBlockerSemantics(details: PublicDetailsDto): void {
  const graphNodeStates = new Map<string, PublicGraphNodeDto["state"]>();
  for (const node of details.graph.nodes) {
    if (graphNodeStates.has(node.nodeId)) {
      throw new PublicDtoSemanticError(`details graphのnode ID ${node.nodeId}が重複しています`);
    }
    graphNodeStates.set(node.nodeId, node.state);
  }
  for (const item of details.items) {
    assertPublicItemSummarySemantics(item.summary);
    assertPublicUniqueSortedIds(
      item.blockerUnverifiedReasons.map((entry) => entry.nodeId),
      `item ${item.summary.nodeId}のblocker未検証理由のnode ID`,
    );
    const blockerUnverifiedReasonOrder: readonly (typeof item.blockerUnverifiedReasons)[number]["reasons"][number][] =
      ["relation_support", "retained_waiting", "waiting_value"];
    const reasonsByNodeId = new Map<
      string,
      Set<(typeof item.blockerUnverifiedReasons)[number]["reasons"][number]>
    >();
    for (const entry of item.blockerUnverifiedReasons) {
      if (new Set(entry.reasons).size !== entry.reasons.length) {
        throw new PublicDtoSemanticError(
          `item ${item.summary.nodeId}のblocker ${entry.nodeId}の未検証理由が重複しています`,
        );
      }
      let previousReason: (typeof entry.reasons)[number] | undefined;
      for (const reason of entry.reasons) {
        if (
          previousReason != null &&
          blockerUnverifiedReasonOrder.indexOf(previousReason) >=
            blockerUnverifiedReasonOrder.indexOf(reason)
        ) {
          throw new PublicDtoSemanticError(
            `item ${item.summary.nodeId}のblocker ${entry.nodeId}の未検証理由が固定順ではありません`,
          );
        }
        previousReason = reason;
      }
      reasonsByNodeId.set(entry.nodeId, new Set(entry.reasons));
    }
    const supportsByMeaning = new Map<string, PublicGraphEdgeDto[]>();
    for (const edge of details.graph.edges) {
      if (
        !edge.active ||
        edge.type !== "blocks" ||
        edge.toNodeId !== item.summary.nodeId ||
        graphNodeStates.get(edge.fromNodeId) !== "open" ||
        graphNodeStates.get(edge.toNodeId) !== "open"
      ) {
        continue;
      }
      const meaningKey = JSON.stringify([edge.type, edge.fromNodeId, edge.toNodeId]);
      const existing = supportsByMeaning.get(meaningKey);
      if (existing == null) {
        supportsByMeaning.set(meaningKey, [edge]);
      } else {
        existing.push(edge);
      }
    }
    const expectedBlockerNodeIds = new Set<string>();
    const effectiveUnverifiedBlockerNodeIds = new Set<string>();
    for (const meaningSupports of supportsByMeaning.values()) {
      const firstSupport = meaningSupports[0];
      assertNonNullable(firstSupport, "blocks supportがありません");
      expectedBlockerNodeIds.add(firstSupport.fromNodeId);
      let allUnverified = true;
      for (const support of meaningSupports) {
        if (support.aiCurrentness !== "unverified") {
          allUnverified = false;
        }
      }
      if (allUnverified) {
        effectiveUnverifiedBlockerNodeIds.add(firstSupport.fromNodeId);
      }
    }
    const waitingBlockerNodeIds = new Set<string>();
    if (item.summary.status === "waiting_for_unblock") {
      for (const waitingOn of item.summary.waitingOn) {
        if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
          continue;
        }
        if (!graphNodeStates.has(waitingOn.candidateId)) {
          throw new PublicDtoSemanticError(
            `item ${item.summary.nodeId}のwaitingOn項目 ${waitingOn.candidateId}を公開項目またはexternal referenceへ解決できません`,
          );
        }
        waitingBlockerNodeIds.add(waitingOn.candidateId);
      }
    }
    const retainedOnlyBlockerNodeIds = new Set(
      item.summary.repositoryFreshness === "stale"
        ? [...waitingBlockerNodeIds].filter((nodeId) => !expectedBlockerNodeIds.has(nodeId))
        : [],
    );
    for (const nodeId of waitingBlockerNodeIds) {
      expectedBlockerNodeIds.add(nodeId);
    }
    const expectedBlockerNodeIdValues = [...expectedBlockerNodeIds].sort(compareStrings);
    if (
      expectedBlockerNodeIdValues.length !== item.summary.blockerNodeIds.length ||
      expectedBlockerNodeIdValues.some(
        (nodeId, index) => nodeId !== item.summary.blockerNodeIds[index],
      )
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のblocker node IDが有効なblockerと保持中の待ち相手から導出した集合と一致しません`,
      );
    }
    for (const blockerNodeId of reasonsByNodeId.keys()) {
      if (!expectedBlockerNodeIds.has(blockerNodeId)) {
        throw new PublicDtoSemanticError(
          `item ${item.summary.nodeId}のblocker未検証理由のnode IDがblocker node IDの部分集合ではありません`,
        );
      }
    }
    const nodeIdsForReason = (
      reason: (typeof item.blockerUnverifiedReasons)[number]["reasons"][number],
    ): Set<string> =>
      new Set(
        [...reasonsByNodeId.entries()]
          .filter(([, reasons]) => reasons.has(reason))
          .map(([nodeId]) => nodeId),
      );
    const relationSupportReasonNodeIds = nodeIdsForReason("relation_support");
    if (
      relationSupportReasonNodeIds.size !== effectiveUnverifiedBlockerNodeIds.size ||
      [...effectiveUnverifiedBlockerNodeIds].some(
        (nodeId) => !relationSupportReasonNodeIds.has(nodeId),
      )
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のrelation_support理由がAI未検証の有効blockerと一致しません`,
      );
    }
    const retainedWaitingReasonNodeIds = nodeIdsForReason("retained_waiting");
    if (
      retainedWaitingReasonNodeIds.size !== retainedOnlyBlockerNodeIds.size ||
      [...retainedOnlyBlockerNodeIds].some((nodeId) => !retainedWaitingReasonNodeIds.has(nodeId))
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のretained_waiting理由が保持中blockerと一致しません`,
      );
    }
    const waitingValueReasonNodeIds = nodeIdsForReason("waiting_value");
    if (
      waitingValueReasonNodeIds.size !== 0 &&
      (waitingValueReasonNodeIds.size !== waitingBlockerNodeIds.size ||
        [...waitingBlockerNodeIds].some((nodeId) => !waitingValueReasonNodeIds.has(nodeId)))
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のwaiting_value理由は待ち相手すべてに付与するか省略してください`,
      );
    }
    if (
      effectiveUnverifiedBlockerNodeIds.size > 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("blockers")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のAI未検証blocks supportに対応するAI未検証値blockersがありません`,
      );
    }
    if (
      retainedOnlyBlockerNodeIds.size > 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("waitingOn")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}の保持中blockerに対応するAI未検証値waitingOnがありません`,
      );
    }
    if (
      waitingValueReasonNodeIds.size > 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("waitingOn")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のwaiting_value理由に対応するAI未検証値waitingOnがありません`,
      );
    }
    if (
      waitingBlockerNodeIds.size > 0 &&
      retainedOnlyBlockerNodeIds.size === 0 &&
      item.summary.aiAnalysis.unverifiedValues.includes("waitingOn") &&
      waitingValueReasonNodeIds.size === 0
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のAI未検証値waitingOnに対応するwaiting_value理由がありません`,
      );
    }
    const primaryWaitingOn = item.summary.waitingOn[0];
    if (
      item.summary.status === "waiting_for_unblock" &&
      primaryWaitingOn?.kind === "item" &&
      primaryWaitingOn.role === "dependency" &&
      retainedOnlyBlockerNodeIds.has(primaryWaitingOn.candidateId) &&
      (!item.summary.aiAnalysis.unverifiedValues.includes("primaryWaitingOn") ||
        !item.summary.aiAnalysis.unverifiedValues.includes("nextAction"))
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}の保持中primary blockerに対応するAI未検証値がありません`,
      );
    }
    if (
      retainedOnlyBlockerNodeIds.size > 0 &&
      supportsByMeaning.size === 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("status")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}の有効なblockerがないwaiting_for_unblockにAI未検証値statusがありません`,
      );
    }
  }
}

function assertPublicCurrentImplementations(items: readonly PublicItemSummaryDto[]): void {
  const summaryItemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  for (const item of items) {
    if (item.type !== "issue" || item.state !== "open") {
      if (item.currentImplementations.length !== 0) {
        throw new PublicDtoSemanticError(
          `Issue以外またはopenでないIssue ${item.nodeId}にcurrentImplementationsがあります`,
        );
      }
      continue;
    }
    if (item.currentImplementations.length !== 0 && isTerminalStatus(item.status)) {
      throw new PublicDtoSemanticError(
        `Issue ${item.nodeId}はGitHub stateがopenなのにterminal statusでcurrentImplementationsを持っています`,
      );
    }
    const implementationNodeIds = new Set<string>();
    for (const [index, implementation] of item.currentImplementations.entries()) {
      if (implementationNodeIds.has(implementation.nodeId)) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsにPR ${implementation.nodeId}が重複しています`,
        );
      }
      implementationNodeIds.add(implementation.nodeId);
      const previous = item.currentImplementations[index - 1];
      if (previous != null && comparePublicCurrentImplementations(previous, implementation) > 0) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsが決定論的な順序になっていません`,
        );
      }
      const implementationSummary = summaryItemsByNodeId.get(implementation.nodeId);
      if (implementationSummary?.type !== "pull_request") {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsに対応するopen PR summaryがありません`,
        );
      }
      if (implementationSummary.state !== "open") {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsに対応するopen PR summaryがありません`,
        );
      }
      if (isTerminalStatus(implementationSummary.status)) {
        throw new PublicDtoSemanticError(
          `PR ${implementation.nodeId}はGitHub stateがopenなのにterminal statusでcurrentImplementationsに含まれています`,
        );
      }
      if (
        item.repositoryFreshness !== "fresh" ||
        implementationSummary.repositoryFreshness !== "fresh"
      ) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsに対応するPR repositoryがfreshではありません`,
        );
      }
      const displayIdentity = parsePublicItemDisplayReference(implementation.displayReference);
      const urlIdentity = parsePublicItemUrl(implementation.url);
      if (
        urlIdentity.type !== "pull_request" ||
        displayIdentity.owner !== urlIdentity.owner ||
        displayIdentity.repository !== urlIdentity.repository ||
        displayIdentity.number !== urlIdentity.number ||
        implementation.number !== displayIdentity.number ||
        implementation.repositoryId !== implementationSummary.repositoryId ||
        implementation.displayReference !== implementationSummary.displayReference ||
        implementation.number !== implementationSummary.number ||
        implementation.url !== implementationSummary.url ||
        implementation.title !== implementationSummary.title ||
        implementation.status !== implementationSummary.status ||
        JSON.stringify(implementation.waitingOn) !==
          JSON.stringify(implementationSummary.waitingOn) ||
        implementation.nextAction !== implementationSummary.nextAction
      ) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsとPR ${implementation.nodeId}のsummaryが一致しません`,
        );
      }
    }
  }
}

function assertPublicSummaryWaitingOnReferences(summary: PublicSummaryDto): void {
  const summaryItemNodeIds = new Set(summary.items.map((item) => item.nodeId));
  const externalGraphNodeIds = new Set(
    summary.graph.nodes
      .filter((node) => node.kind === "external_reference")
      .map((node) => node.nodeId),
  );
  const candidateIds = new Set<string>();
  for (const item of summary.items) {
    const waitingOnValues = [
      ...item.waitingOn,
      ...item.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (waitingOn.kind === "item") {
        candidateIds.add(waitingOn.candidateId);
      }
    }
    for (const response of item.currentResponses) {
      if (response.status === "waiting") {
        candidateIds.add(response.waitingFor.itemNodeId);
      }
    }
  }
  for (const candidateId of candidateIds) {
    if (summaryItemNodeIds.has(candidateId) || externalGraphNodeIds.has(candidateId)) {
      continue;
    }
    throw new PublicDtoSemanticError(
      `waitingOn項目 ${candidateId}をsummary itemsまたはinitial graphから解決できません`,
    );
  }
}

function assertPublicDetailsWaitingOnReferences(details: PublicDetailsDto): void {
  const itemNodeIds = new Set(details.items.map((item) => item.summary.nodeId));
  const externalGraphNodeIds = new Set(
    details.graph.nodes
      .filter((node) => node.kind === "external_reference")
      .map((node) => node.nodeId),
  );
  for (const item of details.items) {
    const waitingOnValues = [
      ...item.summary.waitingOn,
      ...item.summary.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (
        waitingOn.kind === "item" &&
        !itemNodeIds.has(waitingOn.candidateId) &&
        !externalGraphNodeIds.has(waitingOn.candidateId)
      ) {
        throw new PublicDtoSemanticError(
          `waitingOn項目 ${waitingOn.candidateId}をdetailsの公開項目またはexternal referenceから解決できません`,
        );
      }
    }
  }
}

function assertPublicCurrentResponseIds(
  items: readonly Readonly<{
    nodeId: string;
    currentResponses: readonly PublicPersonalReminderResponseDto[];
  }>[],
): void {
  const causeIds = new Set<string>();
  for (const item of items) {
    let previousCauseId: string | undefined;
    for (const response of item.currentResponses) {
      if (causeIds.has(response.causeId)) {
        throw new PublicDtoSemanticError(
          `personal reminder responseのcause IDが重複しています。対象: ${response.causeId}`,
        );
      }
      if (previousCauseId != null && compareStrings(previousCauseId, response.causeId) > 0) {
        throw new PublicDtoSemanticError(
          `item ${item.nodeId}のpersonal reminder responseがcause ID順ではありません`,
        );
      }
      causeIds.add(response.causeId);
      previousCauseId = response.causeId;
    }
  }
}

function assertPublicCurrentResponsesRequireCompletedPlanning(
  items: readonly PublicItemSummaryDto[],
): void {
  for (const item of items) {
    if (item.personalReminderCausePlanningStatus === "completed") {
      continue;
    }
    if (item.currentResponsesUnverified) {
      throw new PublicDtoSemanticError(
        `個人催促planningが完了していない項目に現在の対応の未検証フラグがあります。対象: ${item.nodeId}`,
      );
    }
    if (item.currentResponses.length !== 0) {
      throw new PublicDtoSemanticError(
        `個人催促planningが完了していない項目に現在の対応があります。対象: ${item.nodeId}`,
      );
    }
    if (
      item.currentResponseSubjectChanges.scope !== "bounded" ||
      item.currentResponseSubjectChanges.addableSubjects.length !== 0 ||
      item.currentResponseSubjectChanges.removableSubjects.length !== 0
    ) {
      throw new PublicDtoSemanticError(
        `個人催促planningが完了していない項目に現在対応主体の変化があります。対象: ${item.nodeId}`,
      );
    }
  }
}

function assertPublicDetailsCurrentResponseReferences(details: PublicDetailsDto): void {
  const graphNodeIds = new Set(details.graph.nodes.map((node) => node.nodeId));
  for (const item of details.items) {
    graphNodeIds.add(item.summary.nodeId);
  }
  for (const item of details.items) {
    for (const response of item.summary.currentResponses) {
      if (response.status !== "waiting") {
        continue;
      }
      if (!graphNodeIds.has(response.waitingFor.itemNodeId)) {
        throw new PublicDtoSemanticError(
          `waiting responseの項目 ${response.waitingFor.itemNodeId}をdetailsから解決できません`,
        );
      }
    }
  }
}

/** 未検証の値を共有公開summary DTOへ変換する。 */
export function createPublicSummaryDto(value: unknown): PublicSummaryDto {
  const result = publicSummaryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("summary", {
      cause: result.error,
    });
  }
  for (const item of result.data.items) {
    assertPublicItemSummarySemantics(item);
  }
  assertPublicCurrentResponseIds(result.data.items);
  assertPublicCurrentResponsesRequireCompletedPlanning(result.data.items);
  assertPublicSummaryWaitingOnReferences(result.data);
  assertPublicCurrentImplementations(result.data.items);
  return result.data;
}

/** 未検証の値を共有公開details DTOへ変換する。 */
export function createPublicDetailsDto(value: unknown): PublicDetailsDto {
  const result = publicDetailsDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("details", {
      cause: result.error,
    });
  }
  assertPublicNativeGraphEdgeCurrentness(result.data.graph.edges);
  assertPublicUnverifiedRelationSemantics(result.data);
  assertPublicUnverifiedBlockerSemantics(result.data);
  assertPublicCurrentResponseIds(result.data.items.map((item) => item.summary));
  assertPublicCurrentResponsesRequireCompletedPlanning(
    result.data.items.map((item) => item.summary),
  );
  assertPublicDetailsWaitingOnReferences(result.data);
  assertPublicDetailsCurrentResponseReferences(result.data);
  assertPublicCurrentImplementations(result.data.items.map((item) => item.summary));
  return result.data;
}

/** 未検証の値を共有公開notification history DTOへ変換する。 */
export function createPublicNotificationHistoryDto(value: unknown): PublicNotificationHistoryDto {
  const result = publicNotificationHistoryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("notification-history", {
      cause: result.error,
    });
  }
  for (const notification of result.data.notifications) {
    assertPublicNotificationHistoryEntryItem(notification);
  }
  return result.data;
}

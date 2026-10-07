import { z } from "zod";

import {
  dateTimeSchema,
  deadlineDateSchema,
  deadlineLevelSchema,
  githubUrlSchema,
  identifierSchema,
  importanceFactorSchema,
  nonNegativeIntegerSchema,
  primaryWaitingOnSchema,
  PUBLIC_DTO_SCHEMA_VERSION,
  publicEvidenceSchema,
  publicImportanceSchema,
  severitySchema,
  shortStringSchema,
  statusSchema,
  waitingOnSchema,
} from "./public-dto-primitives.js";
import {
  publicCurrentResponseSubjectChangesSchema,
  publicPersonalReminderCausePlanningStatusSchema,
  publicPersonalReminderResponseSchema,
  repositoryFreshnessSchema,
} from "./public-reminder-dto-schema.js";

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
export const publicItemSummarySchema = z.strictObject({
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
export const publicItemHistoryEventSchema = z.strictObject({
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
export const publicItemDetailsSchema = z.strictObject({
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
export const publicGraphNodeSchema = z.discriminatedUnion("kind", [
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
export const publicGraphEdgeSchema = z.discriminatedUnion("active", [
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
export const publicSummaryDtoSchema = z.strictObject({
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
export const publicDetailsDtoSchema = z.strictObject({
  schemaVersion: z.literal(PUBLIC_DTO_SCHEMA_VERSION),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  items: z.array(publicItemDetailsSchema),
  graph: publicGraphSchema,
});

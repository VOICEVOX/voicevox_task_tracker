import { z } from "zod";

import { PublicDtoValidationError } from "./errors.js";
import { IMPORTANCE_FACTOR_KINDS } from "../domain/importance.js";

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
const publicItemMilestoneSchema = z.strictObject({
  nodeId: identifierSchema,
  number: z.number().int().positive(),
  title: z.string().max(500),
  state: z.enum(["open", "closed"]),
  dueOn: dateTimeSchema.nullable(),
});
const publicItemAiAnalysisSchema = z.strictObject({
  status: z.enum(["used", "failed", "deferred", "not_required", "disabled", "not_recorded"]),
});
const publicItemSummarySchema = z.strictObject({
  nodeId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  repositoryId: identifierSchema,
  displayReference: z.string().min(4).max(600),
  number: z.number().int().positive(),
  url: githubUrlSchema,
  title: z.string().max(500),
  milestone: publicItemMilestoneSchema.nullable(),
  state: z.enum(["open", "closed", "merged"]),
  author: itemAuthorSchema,
  assignees: z.array(accountActorSchema),
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
  primaryWaitingOn: primaryWaitingOnSchema,
  nextAction: shortStringSchema,
  severity: severitySchema,
  importance: publicImportanceSchema,
  priorityWeight: z.number(),
  aiAnalysis: publicItemAiAnalysisSchema,
  confidence: z.number().min(0).max(1),
  githubUpdatedAt: dateTimeSchema,
  stallSince: dateTimeSchema,
  observedAt: dateTimeSchema,
  repositoryFreshness: z.enum(["fresh", "stale"]),
  blockerNodeIds: z.array(identifierSchema),
  downstreamImpact: downstreamImpactSchema,
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
const publicItemDetailsSchema = z.strictObject({
  summary: publicItemSummarySchema,
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
  schemaVersion: z.literal("5"),
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
  schemaVersion: z.literal("5"),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  items: z.array(publicItemDetailsSchema),
  graph: publicGraphSchema,
});

/** Web初期表示で共有するschema version 5の公開summary DTO。 */
export type PublicSummaryDto = z.output<typeof publicSummaryDtoSchema>;

/** Web詳細表示で共有するschema version 5の公開details DTO。 */
export type PublicDetailsDto = z.output<typeof publicDetailsDtoSchema>;

/** 公開summary DTO内の項目。 */
export type PublicItemSummaryDto = z.output<typeof publicItemSummarySchema>;

/** 公開details DTO内の項目。 */
export type PublicItemDetailsDto = z.output<typeof publicItemDetailsSchema>;

/** 公開DTO内のグラフnode。 */
export type PublicGraphNodeDto = z.output<typeof publicGraphNodeSchema>;

/** 公開DTO内のグラフedge。 */
export type PublicGraphEdgeDto = z.output<typeof publicGraphEdgeSchema>;

/** 公開DTO内の項目履歴差分。 */
export type PublicItemHistoryEventDto = z.output<typeof publicItemHistoryEventSchema>;

/** 未検証の値を共有公開summary DTOへ変換する。 */
export function createPublicSummaryDto(value: unknown): PublicSummaryDto {
  const result = publicSummaryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("summary", {
      cause: result.error,
    });
  }
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
  return result.data;
}

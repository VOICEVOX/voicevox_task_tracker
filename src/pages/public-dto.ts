import { z } from "zod";

import { PublicDtoValidationError } from "./errors.js";
import { IMPORTANCE_FACTOR_KINDS } from "../domain/index.js";

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
const aiCacheKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u, "AI cache keyが不正です");
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const statusSchema = z.enum([
  "new_untriaged",
  "needs_maintainer_decision",
  "waiting_for_review",
  "waiting_for_author",
  "waiting_for_assignee",
  "blocked",
  "waiting_for_automation",
  "ready_to_merge",
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
  sourceIds: z.array(identifierSchema).min(1),
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
  sourceId: identifierSchema,
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: shortStringSchema,
  sourceUrl: githubUrlSchema,
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
const trackedItemAiAnalysisSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_used"),
  }),
  z.strictObject({
    status: z.literal("used"),
    cacheKey: aiCacheKeySchema,
  }),
]);
const trackedItemInputEventSchema = z.strictObject({
  sourceId: identifierSchema,
  url: githubUrlSchema,
});
const repositoryFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("fresh"),
  }),
  z.strictObject({
    status: z.literal("stale"),
    failedAt: dateTimeSchema,
  }),
]);
const publicRepositorySchema = z.strictObject({
  id: identifierSchema,
  owner: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  fullName: z.string().min(3).max(513),
  observedAt: dateTimeSchema,
  freshness: repositoryFreshnessSchema,
  itemCount: nonNegativeIntegerSchema,
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
  lastHumanActivityAt: dateTimeSchema,
  lastProgressAt: dateTimeSchema,
  statusSince: dateTimeSchema,
  ownerSince: dateTimeSchema,
  stallSince: dateTimeSchema,
  observedAt: dateTimeSchema,
});
const actorSchema = z.discriminatedUnion("type", [
  accountActorSchema,
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
    actor: actorSchema,
  }),
]);
const responsibilitySchema = z.strictObject({
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
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
const severityHistoryValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("absent"),
  }),
  z.strictObject({
    state: z.literal("present"),
    value: severitySchema,
  }),
]);
const publicItemHistoryEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("responsibility_changed"),
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    before: responsibilityHistoryValueSchema,
    after: responsibilityHistoryValueSchema,
  }),
  z.strictObject({
    kind: z.literal("severity_changed"),
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    before: severityHistoryValueSchema,
    after: severityHistoryValueSchema,
  }),
]);
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
  aiAnalysis: trackedItemAiAnalysisSchema,
  inputEvents: z.array(trackedItemInputEventSchema),
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
  evidence: z.array(publicEvidenceSchema),
  contradictions: z.array(relationContradictionSchema),
  firstSeenAt: dateTimeSchema,
  lastConfirmedAt: dateTimeSchema,
});
const publicGraphEdgeSchema = z.discriminatedUnion("active", [
  publicGraphEdgeFieldsSchema.extend({
    active: z.literal(true),
  }),
  publicGraphEdgeFieldsSchema.extend({
    active: z.literal(false),
    removedAt: dateTimeSchema,
  }),
]);
const publicGraphComponentSchema = z.strictObject({
  id: identifierSchema,
  nodeIds: z.array(identifierSchema).min(1),
  repositoryIds: z.array(identifierSchema).min(1),
  edgeIds: z.array(identifierSchema),
});
const publicGraphComponentSummarySchema = z.strictObject({
  id: identifierSchema,
  nodeCount: z.number().int().positive(),
  repositoryIds: z.array(identifierSchema).min(1),
  edgeCount: nonNegativeIntegerSchema,
  frontierCount: nonNegativeIntegerSchema,
  cycleCount: nonNegativeIntegerSchema,
});
const publicGraphRepositoryClusterSchema = z.strictObject({
  repositoryId: identifierSchema,
  nodeIds: z.array(identifierSchema).min(1),
  edgeIds: z.array(identifierSchema),
});
const publicGraphRepositoryClusterSummarySchema = z.strictObject({
  repositoryId: identifierSchema,
  nodeCount: z.number().int().positive(),
  edgeCount: nonNegativeIntegerSchema,
  frontierCount: nonNegativeIntegerSchema,
  cycleCount: nonNegativeIntegerSchema,
});
const publicDependencyCycleSchema = z.strictObject({
  id: identifierSchema,
  nodeIds: z.array(identifierSchema).min(1),
  edgeIds: z.array(identifierSchema).min(1),
});
const edgeHistoryEvidenceSchema = z.strictObject({
  sourceId: identifierSchema,
  supports: publicEvidenceSchema.shape.supports,
  summary: shortStringSchema,
});
const edgeHistoryFieldsSchema = z.strictObject({
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
  evidence: z.array(edgeHistoryEvidenceSchema),
  contradictions: z.array(relationContradictionSchema),
  firstSeenAt: dateTimeSchema,
  lastConfirmedAt: dateTimeSchema,
});
const edgeHistoryValueSchema = z.discriminatedUnion("active", [
  edgeHistoryFieldsSchema.extend({
    active: z.literal(true),
  }),
  edgeHistoryFieldsSchema.extend({
    active: z.literal(false),
    removedAt: dateTimeSchema,
  }),
]);
const edgeHistoryStateSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("absent"),
  }),
  z.strictObject({
    state: z.literal("present"),
    value: edgeHistoryValueSchema,
  }),
]);
const publicGraphHistoryEventSchema = z.strictObject({
  kind: z.literal("edge_changed"),
  runId: identifierSchema,
  recordedAt: dateTimeSchema,
  relationId: identifierSchema,
  before: edgeHistoryStateSchema,
  after: edgeHistoryStateSchema,
});
const publicInitialGraphEdgeSchema = z.strictObject({
  id: identifierSchema,
  fromNodeId: identifierSchema,
  toNodeId: identifierSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
});
const publicInitialGraphSchema = z.strictObject({
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicInitialGraphEdgeSchema),
  components: z.array(publicGraphComponentSummarySchema),
  clusterByRepository: z.boolean(),
  repositoryClusters: z.array(publicGraphRepositoryClusterSummarySchema),
  frontierNodeIds: z.array(identifierSchema),
  cycles: z.array(publicDependencyCycleSchema),
  maxNodes: z.number().int().positive(),
  omittedNodeCount: nonNegativeIntegerSchema,
});
const publicAggregateSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  componentCount: nonNegativeIntegerSchema,
  frontierCount: nonNegativeIntegerSchema,
  cycleCount: nonNegativeIntegerSchema,
  unknownItemCount: nonNegativeIntegerSchema,
  staleRepositoryCount: nonNegativeIntegerSchema,
  staleItemCount: nonNegativeIntegerSchema,
  statusCounts: z.strictObject({
    new_untriaged: nonNegativeIntegerSchema,
    needs_maintainer_decision: nonNegativeIntegerSchema,
    waiting_for_review: nonNegativeIntegerSchema,
    waiting_for_author: nonNegativeIntegerSchema,
    waiting_for_assignee: nonNegativeIntegerSchema,
    blocked: nonNegativeIntegerSchema,
    waiting_for_automation: nonNegativeIntegerSchema,
    ready_to_merge: nonNegativeIntegerSchema,
    in_progress: nonNegativeIntegerSchema,
    unknown: nonNegativeIntegerSchema,
    terminal_merged: nonNegativeIntegerSchema,
    terminal_completed: nonNegativeIntegerSchema,
    terminal_not_planned: nonNegativeIntegerSchema,
  }),
  severityCounts: z.strictObject({
    none: nonNegativeIntegerSchema,
    watch: nonNegativeIntegerSchema,
    urgent: nonNegativeIntegerSchema,
    critical: nonNegativeIntegerSchema,
  }),
});
const publicGraphSchema = z.strictObject({
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicGraphEdgeSchema),
  components: z.array(publicGraphComponentSchema),
  repositoryClusters: z.array(publicGraphRepositoryClusterSchema),
  frontierNodeIds: z.array(identifierSchema),
  cycles: z.array(publicDependencyCycleSchema),
  downstreamImpacts: z.array(downstreamImpactSchema),
  history: z.array(publicGraphHistoryEventSchema),
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
  schemaVersion: z.literal("3"),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  observedAt: dateTimeSchema,
  trackingStartAt: dateTimeSchema,
  timezone: identifierSchema,
  ai: publicAiStateSchema,
  confidenceThresholds: publicConfidenceThresholdsSchema,
  aggregates: publicAggregateSchema,
  repositories: z.array(publicRepositorySchema),
  items: z.array(publicItemSummarySchema),
  graph: publicInitialGraphSchema,
});
const publicDetailsDtoSchema = z.strictObject({
  schemaVersion: z.literal("3"),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  items: z.array(publicItemDetailsSchema),
  graph: publicGraphSchema,
});

/** Web初期表示で共有するschema version 3の公開summary DTO。 */
export type PublicSummaryDto = z.output<typeof publicSummaryDtoSchema>;

/** Web詳細表示で共有するschema version 3の公開details DTO。 */
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

/** 公開DTO内のグラフ履歴差分。 */
export type PublicGraphHistoryEventDto = z.output<typeof publicGraphHistoryEventSchema>;

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

import { z } from "zod";

const identifierSchema = z.string().min(1).max(300).regex(/^\S+$/u);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const actorSchema = z.strictObject({
  type: z.enum(["human", "bot"]),
  nodeId: identifierSchema,
  login: identifierSchema,
});
const systemActorSchema = z.strictObject({
  type: z.literal("system"),
  name: identifierSchema,
});
const eventActorSchema = z.union([actorSchema, systemActorSchema]);
const eventBaseSchema = z.strictObject({
  id: identifierSchema,
  occurredAt: dateTimeSchema,
  actor: eventActorSchema,
});
const commentEventSchema = eventBaseSchema.extend({
  kind: z.literal("comment"),
  bodyEmpty: z.boolean(),
});
const pushEventSchema = eventBaseSchema.extend({
  kind: z.literal("push"),
  headCommitSha: identifierSchema,
  forcePush: z.boolean(),
});
const reviewEventSchema = eventBaseSchema.extend({
  kind: z.literal("review"),
  state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
  bodyEmpty: z.boolean(),
  commitSha: identifierSchema,
});
const reviewRequestEventSchema = eventBaseSchema.extend({
  kind: z.literal("review_request"),
  target: z.strictObject({
    type: z.enum(["user", "team"]),
    nodeId: identifierSchema,
  }),
  action: z.enum(["added", "removed"]),
});
const assigneeEventSchema = eventBaseSchema.extend({
  kind: z.literal("assignee"),
  assignee: actorSchema,
  action: z.enum(["added", "removed"]),
});
const stateEventSchema = eventBaseSchema.extend({
  kind: z.literal("state"),
  state: z.enum(["open", "closed", "merged", "reopened"]),
  stateReason: z.enum(["completed", "not_planned", "duplicate", "unavailable"]).nullable(),
});
const eventSchema = z.discriminatedUnion("kind", [
  commentEventSchema,
  pushEventSchema,
  reviewEventSchema,
  reviewRequestEventSchema,
  assigneeEventSchema,
  stateEventSchema,
]);
const unavailablePreviousStateSchema = z.strictObject({
  availability: z.literal("not_available"),
});
const availablePreviousStateSchema = z.strictObject({
  availability: z.literal("available"),
  observedAt: dateTimeSchema,
  statusSince: dateTimeSchema,
  ownerSince: dateTimeSchema,
  stallSince: dateTimeSchema,
  lastProgressAt: dateTimeSchema,
  lastHumanActivityAt: dateTimeSchema,
  severity: z.enum(["none", "watch", "urgent", "critical"]),
});
const previousStateSchema = z.discriminatedUnion("availability", [
  unavailablePreviousStateSchema,
  availablePreviousStateSchema,
]);
const itemBaseSchema = z.strictObject({
  nodeId: identifierSchema,
  repositoryId: identifierSchema,
  number: z.number().int().positive(),
  title: z.string().min(1).max(300),
  state: z.enum(["open", "closed", "merged"]),
  closedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  githubUpdatedAt: dateTimeSchema,
  observedAt: dateTimeSchema,
  author: actorSchema,
  assignees: z.array(actorSchema),
  labels: z.array(z.string().min(1).max(100)),
  events: z.array(eventSchema),
  explicitRequestSourceIds: z.array(identifierSchema),
  latestChange: z.enum([
    "none",
    "human",
    "bot_only",
    "preview_update",
    "renovate_dashboard_update",
  ]),
  notificationClass: z.enum(["standard", "automation_noise"]),
  priorityWeight: z.number(),
  previousState: previousStateSchema,
});
const issueSchema = itemBaseSchema.extend({
  type: z.literal("issue"),
});
const userReviewRequestTargetSchema = z.strictObject({
  type: z.literal("user"),
  actor: actorSchema,
});
const teamReviewRequestTargetSchema = z.strictObject({
  type: z.literal("team"),
  nodeId: identifierSchema,
  slug: identifierSchema,
  name: z.string().min(1).max(100),
});
const reviewRequestSchema = z.strictObject({
  id: identifierSchema,
  target: z.discriminatedUnion("type", [
    userReviewRequestTargetSchema,
    teamReviewRequestTargetSchema,
  ]),
  requestedAt: dateTimeSchema,
});
const pullRequestSchema = itemBaseSchema.extend({
  type: z.literal("pull_request"),
  draft: z.boolean(),
  headSha: identifierSchema,
  headPushedAt: dateTimeSchema,
  reviewRequests: z.array(reviewRequestSchema),
  checks: z.enum(["not_configured", "pending", "success", "failure"]),
  mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
  mergeState: z.enum([
    "behind",
    "blocked",
    "clean",
    "dirty",
    "draft",
    "has_hooks",
    "unknown",
    "unstable",
  ]),
});
const repositorySchema = z.strictObject({
  id: identifierSchema,
  name: identifierSchema,
  visibility: z.enum(["public", "private", "internal"]),
});
const relationSchema = z.strictObject({
  id: z.string().regex(/^rel:\S+$/u),
  sourceId: identifierSchema,
  currentNodeId: identifierSchema,
  fromNodeId: identifierSchema,
  toNodeId: identifierSchema,
  candidateType: z.enum(["blocks", "parent_of", "implements", "unclassified"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
  ]),
});
const fixedAiAnalysisSchema = z.strictObject({
  itemNodeId: identifierSchema,
  input: z.json(),
  acceptedOutput: z.json(),
  rejectedOutputs: z.array(z.json()),
});
const standardGoldenInputSchema = z.strictObject({
  kind: z.literal("standard"),
  evaluatedAt: dateTimeSchema,
  repositories: z.array(repositorySchema).min(1),
  items: z.array(z.discriminatedUnion("type", [issueSchema, pullRequestSchema])).min(1),
  relations: z.array(relationSchema),
  fixedAiAnalyses: z.array(fixedAiAnalysisSchema),
  previousNodeStates: z.record(identifierSchema, z.enum(["open", "closed", "merged"])),
});
const largeGoldenInputSchema = z.strictObject({
  kind: z.literal("large"),
  evaluatedAt: dateTimeSchema,
  itemCount: z.literal(5_000),
  edgeCount: z.literal(10_000),
  changedItemCount: z.literal(300),
});

export const goldenEvalInputSchema = z.discriminatedUnion("kind", [
  standardGoldenInputSchema,
  largeGoldenInputSchema,
]);

const expectedWaitingOnSchema = z.strictObject({
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
});
const expectedItemSchema = z.strictObject({
  nodeId: identifierSchema,
  status: z.enum([
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
  ]),
  waitingOn: z.array(expectedWaitingOnSchema),
  severity: z.enum(["none", "watch", "urgent", "critical"]),
  stallSince: dateTimeSchema,
});
const expectedRelationSchema = z.strictObject({
  id: z.string().regex(/^rel:\S+$/u),
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
});
const expectedNotificationSchema = z.strictObject({
  itemNodeId: identifierSchema,
  reasonCodes: z.array(
    z.enum([
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
    ]),
  ),
});
const publishedSchema = z.strictObject({
  status: z.literal("published"),
});
const stoppedSchema = z.strictObject({
  status: z.literal("stopped"),
  reason: z.literal("private_repository_data"),
});
const standardGoldenOutputSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  kind: z.literal("standard"),
  items: z.array(expectedItemSchema),
  relations: z.array(expectedRelationSchema),
  notifications: z.array(expectedNotificationSchema),
  publication: z.discriminatedUnion("status", [publishedSchema, stoppedSchema]),
  fixedAi: z.strictObject({
    acceptedOutputCount: z.number().int().nonnegative(),
    rejectedOutputCount: z.number().int().nonnegative(),
    networkCallCount: z.literal(0),
  }),
});
const largeExpectedItemSchema = z.strictObject({
  count: z.number().int().positive(),
  status: expectedItemSchema.shape.status,
  waitingOn: z.array(expectedWaitingOnSchema),
  severity: expectedItemSchema.shape.severity,
});
const largeExpectedRelationSchema = z.strictObject({
  count: z.number().int().positive(),
  type: expectedRelationSchema.shape.type,
  provenance: expectedRelationSchema.shape.provenance,
});
const largeGoldenOutputSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  kind: z.literal("large"),
  itemCount: z.literal(5_000),
  activeEdgeCount: z.literal(10_000),
  changedItemCount: z.literal(300),
  items: z.array(largeExpectedItemSchema),
  relations: z.array(largeExpectedRelationSchema),
  notifications: z.array(expectedNotificationSchema),
  publication: publishedSchema,
  processingWithinThirtyMinutes: z.boolean(),
  summaryGzipWithinOneMiB: z.boolean(),
  githubApiBudgetWithinSeventyPercent: z.boolean(),
  codexBudgetWithinConfiguredLimit: z.boolean(),
});

export const goldenEvalOutputSchema = z.discriminatedUnion("kind", [
  standardGoldenOutputSchema,
  largeGoldenOutputSchema,
]);

export type StandardGoldenInput = z.output<typeof standardGoldenInputSchema>;
export type GoldenEvalOutput = z.output<typeof goldenEvalOutputSchema>;
export type StandardGoldenOutput = z.output<typeof standardGoldenOutputSchema>;

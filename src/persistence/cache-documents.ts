import { z } from "zod";

import { cacheValidationContextSchema } from "../codex/semantic-validation.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  REASONING_EFFORTS,
  type GitHubItemUrl,
  type GitHubNodeId,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { parseSourceId } from "../domain/source-id.js";
import {
  parseSha256Hash,
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "./canonical-json.js";
import { StateFormatError, StatePersistenceError, StatePublicSafetyError } from "./errors.js";

/** cache文書schemaのversion。 */
export const CACHE_DOCUMENT_SCHEMA_VERSION = "2";
/** terminal itemを保持する日数。 */
export const CACHE_TERMINAL_RETENTION_DAYS = 180;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MILLISECONDS = CACHE_TERMINAL_RETENTION_DAYS * MILLISECONDS_PER_DAY;
const MAX_CACHE_STRING_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_AI_IMPORTANCE_RATIONALE_LENGTH = 120;
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_NAME_PATTERN = /^[^/\s]+$/u;
const NODE_ID_PATTERN = /^\S+$/u;
const GITHUB_ITEM_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[1-9]\d*\/?$/u;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/iu,
  /\bauthorization\b\s*[:=]\s*(?:basic|bearer|token)\s+\S+/iu,
  /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,})\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/u,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/iu,
];
const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "discordwebhookurl",
  "githubtoken",
  "installationtoken",
  "openaiapikey",
  "password",
  "privatekey",
  "rawtoken",
  "secret",
  "token",
  "webhookurl",
]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "body",
  "bodytext",
  "comment",
  "commentbody",
  "comments",
  "content",
  "diff",
  "raw",
  "rawbody",
  "rawcontent",
  "rawresponse",
  "responsetext",
  "reviewbody",
  "reviewcommentbody",
  "text",
]);

const nonEmptyStringSchema = z.string().min(1).max(MAX_CACHE_STRING_LENGTH);
const boundedIdentifierSchema = nonEmptyStringSchema
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(NODE_ID_PATTERN);
const githubNodeIdSchema = boundedIdentifierSchema.transform(createGitHubNodeId);
const githubRepositoryIdSchema = boundedIdentifierSchema.transform(createGitHubRepositoryId);
const sourceIdSchema = nonEmptyStringSchema.max(MAX_IDENTIFIER_LENGTH).transform((value) => {
  const parts = parseSourceId(value);
  return buildSourceId(parts.kind, parts.originalId);
});
const sha256HashSchema = z.string().regex(SHA256_HASH_PATTERN).transform(parseSha256Hash);
const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform(createUtcIsoDateTime);
const repositoryNameSchema = nonEmptyStringSchema
  .max(MAX_REPOSITORY_NAME_LENGTH)
  .regex(REPOSITORY_NAME_PATTERN);
const githubItemUrlSchema = z.custom<GitHubItemUrl>(
  (value) =>
    typeof value === "string" &&
    value.length <= MAX_CACHE_STRING_LENGTH &&
    GITHUB_ITEM_URL_PATTERN.test(value),
  {
    error: "GitHub IssueまたはPull Request URLが不正です",
  },
);
const githubInputEventUrlSchema = z.custom<GitHubItemUrl>(
  (value) => {
    if (typeof value !== "string" || value.length > MAX_CACHE_STRING_LENGTH) {
      return false;
    }
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.port.length === 0 &&
        url.username.length === 0 &&
        url.password.length === 0
      );
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      return false;
    }
  },
  {
    error: "GitHub入力イベントURLが不正です",
  },
);
const eventKindSchema = z.enum([
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
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "review_requested",
  "review_request_removed",
  "closed",
  "reopened",
  "merged",
  "cross_referenced",
  "connected",
  "disconnected",
  "blocked_by_added",
  "blocked_by_removed",
  "blocking_added",
  "blocking_removed",
  "sub_issue_added",
  "sub_issue_removed",
  "parent_issue_added",
  "parent_issue_removed",
  "head_ref_force_pushed",
  "commit_added",
]);
const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

const cacheRepositoryIdentitySchema = z.strictObject({
  repositoryId: githubRepositoryIdSchema,
  owner: repositoryNameSchema,
  name: repositoryNameSchema,
});

const cacheLifecycleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("open"),
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    terminalAt: utcIsoDateTimeSchema,
    expiresAt: utcIsoDateTimeSchema,
  }),
]);

const cacheItemStateSchema = z.enum(["open", "closed", "merged"]);
const cacheDraftStateSchema = z.enum(["not_applicable", "draft", "ready_for_review"]);

const cacheTemporalActorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("identified"),
    nodeId: githubNodeIdSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
  }),
]);

const cacheTemporalEventSchema = z.strictObject({
  sourceId: sourceIdSchema,
  kind: eventKindSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: utcIsoDateTimeSchema,
  actor: cacheTemporalActorSchema,
  relatedNodeIds: z.array(githubNodeIdSchema),
});

const cacheAccountActorSchema = z.strictObject({
  type: z.enum(["human", "bot"]),
  nodeId: githubNodeIdSchema,
  login: nonEmptyStringSchema,
});

const cacheSystemActorSchema = z.strictObject({
  type: z.literal("system"),
  name: nonEmptyStringSchema,
});

const cacheEventActorSchema = z.union([cacheAccountActorSchema, cacheSystemActorSchema]);

const cacheItemAuthorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("identified"),
    actor: cacheAccountActorSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("deleted_account"),
  }),
]);

const cacheMilestoneSchema = z.strictObject({
  nodeId: githubNodeIdSchema,
  number: z.number().int().positive(),
  title: nonEmptyStringSchema,
  state: z.enum(["open", "closed"]),
  dueOn: utcIsoDateTimeSchema.nullable(),
});

const cacheRelationNodeSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("organization"),
    kind: z.enum(["issue", "pull_request"]),
    nodeId: githubNodeIdSchema,
    repositoryOwner: repositoryNameSchema,
    repositoryName: repositoryNameSchema,
    number: z.number().int().positive(),
    url: githubItemUrlSchema,
    state: z.enum(["open", "closed", "merged"]),
  }),
  z.strictObject({
    scope: z.literal("external_public"),
    kind: z.literal("external_reference"),
    nodeId: boundedIdentifierSchema,
    repositoryOwner: repositoryNameSchema,
    repositoryName: repositoryNameSchema,
    number: z.number().int().positive(),
    url: githubItemUrlSchema,
    state: z.enum(["open", "closed", "merged"]),
    githubNodeId: githubNodeIdSchema,
    githubItemType: z.enum(["issue", "pull_request"]),
  }),
]);

const cacheCandidateRelationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("blocks"),
    blocker: cacheRelationNodeSchema,
    blocked: cacheRelationNodeSchema,
  }),
  z.strictObject({
    type: z.literal("parent_of"),
    parent: cacheRelationNodeSchema,
    subtask: cacheRelationNodeSchema,
  }),
  z.strictObject({
    type: z.literal("implements"),
    implementation: cacheRelationNodeSchema,
    target: cacheRelationNodeSchema,
  }),
  z.strictObject({
    type: z.literal("unclassified"),
    referencing: cacheRelationNodeSchema,
    referenced: cacheRelationNodeSchema,
  }),
]);

const cacheRelationCandidateSchema = z.strictObject({
  id: z.string().regex(/^rel:\S+$/u),
  sourceIds: z.array(sourceIdSchema).min(1),
  authority: z.enum(["authoritative", "inferred"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
  ]),
  relation: cacheCandidateRelationSchema,
});

const cacheNormalizedEventBaseShape = {
  sourceId: sourceIdSchema,
  itemNodeId: githubNodeIdSchema,
  occurredAt: utcIsoDateTimeSchema,
  actor: cacheEventActorSchema,
};

const cacheNormalizedEventSchema = z.union([
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("comment"),
    bodyFingerprint: sha256HashSchema,
    bodyEmpty: z.boolean(),
    replyToCommentNodeId: githubNodeIdSchema.optional(),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("push"),
    headCommitSha: nonEmptyStringSchema,
    forcePush: z.boolean(),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("review"),
    state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
    bodyFingerprint: sha256HashSchema,
    bodyEmpty: z.boolean(),
    commitStatus: z.literal("available"),
    commitSha: nonEmptyStringSchema,
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("review"),
    state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
    bodyFingerprint: sha256HashSchema,
    bodyEmpty: z.boolean(),
    commitStatus: z.literal("unavailable"),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("review_request"),
    target: z.strictObject({
      type: z.enum(["user", "team"]),
      nodeId: githubNodeIdSchema,
    }),
    action: z.enum(["added", "removed"]),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("label"),
    labelName: nonEmptyStringSchema,
    action: z.enum(["added", "removed"]),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("assignee"),
    assignee: cacheAccountActorSchema,
    action: z.enum(["added", "removed"]),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("state"),
    state: z.enum(["open", "merged", "reopened"]),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("state"),
    state: z.literal("closed"),
    stateReason: z.enum(["completed", "not_planned", "duplicate", "unavailable"]),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.literal("relation"),
    relationType: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
    target: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("node"),
        nodeId: boundedIdentifierSchema,
      }),
      z.strictObject({
        type: z.literal("url"),
        url: githubItemUrlSchema,
      }),
    ]),
    action: z.enum(["added", "removed"]),
    provenance: z.enum([
      "native",
      "explicit_text",
      "closing_keyword",
      "checklist",
      "cross_reference",
      "ai_inference",
    ]),
    direction: z.enum(["from_item", "to_item"]),
  }),
  z.strictObject({
    ...cacheNormalizedEventBaseShape,
    kind: z.enum([
      "ready_for_review",
      "converted_to_draft",
      "added_to_merge_queue",
      "removed_from_merge_queue",
      "auto_merge_enabled",
      "auto_merge_disabled",
    ]),
  }),
]);

const cacheObservationCommonShape = {
  freshness: z.literal("fresh"),
  sourceId: sourceIdSchema,
  nodeId: githubNodeIdSchema,
  repositoryId: githubRepositoryIdSchema,
  number: z.number().int().positive(),
  url: githubItemUrlSchema,
  title: nonEmptyStringSchema,
  bodySourceId: sourceIdSchema,
  bodyEmpty: z.boolean(),
  bodyFingerprint: sha256HashSchema,
  itemFingerprint: sha256HashSchema,
  createdAt: utcIsoDateTimeSchema,
  githubUpdatedAt: utcIsoDateTimeSchema,
  observedAt: utcIsoDateTimeSchema,
  author: cacheItemAuthorSchema,
  assignees: z.array(cacheAccountActorSchema),
  labels: z.array(nonEmptyStringSchema),
  milestone: cacheMilestoneSchema.nullable(),
  events: z.array(cacheNormalizedEventSchema),
};

const cacheItemStateShape = {
  state: z.enum(["open", "closed"]),
  stateReason: z.enum(["reopened", "completed", "not_planned", "duplicate"]).nullable(),
  closedAt: utcIsoDateTimeSchema.nullable(),
};

const cacheReviewThreadSchema = z.strictObject({
  sourceId: sourceIdSchema,
  nodeId: githubNodeIdSchema,
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: nonEmptyStringSchema,
  resolvedBy: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("identified"), actor: cacheAccountActorSchema }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.literal("github_did_not_return_actor"),
    }),
  ]),
  commentSourceIds: z.array(sourceIdSchema),
});

const cacheReviewRequestSchema = z.strictObject({
  sourceId: sourceIdSchema,
  nodeId: githubNodeIdSchema,
  target: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("user"),
      actor: cacheAccountActorSchema,
    }),
    z.strictObject({
      type: z.literal("team"),
      sourceId: sourceIdSchema,
      nodeId: githubNodeIdSchema,
      organizationLogin: nonEmptyStringSchema,
      slug: nonEmptyStringSchema,
      name: nonEmptyStringSchema,
    }),
  ]),
  requestedAt: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("available"), value: utcIsoDateTimeSchema }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.literal("timeline_event_not_found"),
    }),
  ]),
});

const cacheHeadCommitSchema = z.strictObject({
  sourceId: sourceIdSchema,
  nodeId: githubNodeIdSchema,
  sha: nonEmptyStringSchema,
  committedAt: utcIsoDateTimeSchema,
  pushedAt: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("available"), value: utcIsoDateTimeSchema }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.literal("github_did_not_return_pushed_at"),
    }),
  ]),
});

const cacheMergeStateSchema = z.strictObject({
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
  autoMerge: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("enabled"),
      sourceId: sourceIdSchema,
      enabledAt: utcIsoDateTimeSchema,
      enabledBy: cacheEventActorSchema,
      mergeMethod: z.enum(["merge", "rebase", "squash"]),
    }),
    z.strictObject({ status: z.literal("not_enabled") }),
  ]),
  mergeQueue: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("queued"),
      sourceId: sourceIdSchema,
      nodeId: githubNodeIdSchema,
    }),
    z.strictObject({ status: z.literal("not_queued") }),
  ]),
  checks: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_configured") }),
    z.strictObject({
      status: z.literal("configured"),
      sourceId: sourceIdSchema,
      nodeId: githubNodeIdSchema,
      combinedState: z.enum(["error", "expected", "failure", "pending", "success"]),
      contexts: z.array(
        z.discriminatedUnion("type", [
          z.strictObject({
            type: z.literal("check_run"),
            nodeId: githubNodeIdSchema,
            name: nonEmptyStringSchema,
            sourceId: sourceIdSchema,
            status: z.enum([
              "completed",
              "queued",
              "in_progress",
              "waiting",
              "requested",
              "pending",
            ]),
            conclusion: z.enum([
              "action_required",
              "cancelled",
              "failure",
              "neutral",
              "skipped",
              "startup_failure",
              "stale",
              "success",
              "timed_out",
              "not_completed",
            ]),
            completedAt: utcIsoDateTimeSchema.nullable(),
          }),
          z.strictObject({
            type: z.literal("commit_status"),
            nodeId: githubNodeIdSchema,
            context: nonEmptyStringSchema,
            sourceId: sourceIdSchema,
            state: z.enum(["error", "expected", "failure", "pending", "success"]),
            createdAt: utcIsoDateTimeSchema,
          }),
        ]),
      ),
    }),
  ]),
});

const cacheCurrentObservationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...cacheObservationCommonShape,
    type: z.literal("issue"),
    ...cacheItemStateShape,
    draft: z.literal("not_applicable"),
  }),
  z.strictObject({
    ...cacheObservationCommonShape,
    type: z.literal("pull_request"),
    ...cacheItemStateShape,
    draft: z.boolean(),
    headSha: nonEmptyStringSchema,
    headCommit: cacheHeadCommitSchema,
    reviewThreads: z.array(cacheReviewThreadSchema),
    reviewRequests: z.array(cacheReviewRequestSchema),
    mergeState: cacheMergeStateSchema,
  }),
]);

const cacheRelationReferenceSchema = z.strictObject({
  repositoryOwner: repositoryNameSchema,
  repositoryName: repositoryNameSchema,
  itemType: z.enum(["issue", "pull_request"]).nullable(),
  number: z.number().int().positive(),
});

const cacheRelationMutationSchema = z.strictObject({
  relation: cacheRelationReferenceSchema,
  action: z.enum(["added", "removed"]),
  editedAt: utcIsoDateTimeSchema,
  sourceId: sourceIdSchema,
  contentSourceId: sourceIdSchema,
  sequence: z.number().int().nonnegative(),
});

const cacheRelationIntervalSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("active"),
    relation: cacheRelationReferenceSchema,
    addedAt: utcIsoDateTimeSchema,
    addedSourceIds: z.array(sourceIdSchema).min(1),
    lastConfirmedAt: utcIsoDateTimeSchema,
  }),
  z.strictObject({
    status: z.literal("removed"),
    relation: cacheRelationReferenceSchema,
    addedAt: utcIsoDateTimeSchema,
    addedSourceIds: z.array(sourceIdSchema).min(1),
    removedAt: utcIsoDateTimeSchema,
    removedSourceIds: z.array(sourceIdSchema).min(1),
  }),
]);

const cacheRelationTemporalKnowledgeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("exact"), intervals: z.array(cacheRelationIntervalSchema) }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.enum(["history_incomplete", "current_mismatch", "preexisting_relation"]),
  }),
]);

const cacheRelationMutationAvailableResultSchema = z.strictObject({
  status: z.literal("available"),
  contentSourceId: sourceIdSchema,
  currentReferences: z.array(cacheRelationReferenceSchema),
  replayedReferences: z.array(cacheRelationReferenceSchema),
  consistency: z.enum(["consistent", "history_incomplete", "mismatch"]),
  temporalKnowledge: cacheRelationTemporalKnowledgeSchema,
  mutations: z.array(cacheRelationMutationSchema),
  unmatchedRemovals: z.array(cacheRelationMutationSchema),
});

const cacheRelationMutationUnknownBaseShape = {
  status: z.literal("unknown"),
  contentSourceId: sourceIdSchema,
  reason: z.enum([
    "connection_unavailable",
    "current_markdown_reference_definition",
    "diff_null",
    "deleted_edit",
    "unsupported_diff_format",
    "markdown_reference_definition",
  ]),
};

const cacheRelationMutationUnknownResultSchema = z.union([
  z.strictObject(cacheRelationMutationUnknownBaseShape),
  z.strictObject({
    ...cacheRelationMutationUnknownBaseShape,
    sourceId: sourceIdSchema,
    editedAt: utcIsoDateTimeSchema,
    sequence: z.number().int().nonnegative(),
  }),
]);

const cacheRelationMutationResultSchema = z.union([
  cacheRelationMutationAvailableResultSchema,
  cacheRelationMutationUnknownResultSchema,
]);

const cacheFactSchema = z.strictObject({
  occurredAt: utcIsoDateTimeSchema,
  sourceIds: z.array(sourceIdSchema).min(1),
});
const cacheStateEpochSchema = z.strictObject({
  ...cacheFactSchema.shape,
  state: z.enum(["open", "closed", "merged"]),
});
const cacheDraftEpochSchema = z.strictObject({
  ...cacheFactSchema.shape,
  draft: z.boolean(),
});
const cacheResponsibilityTargetSchema = z.union([
  z.strictObject({ kind: z.literal("assignee"), nodeId: githubNodeIdSchema }),
  z.strictObject({
    kind: z.literal("review_request"),
    target: z.enum(["user", "team"]),
    nodeId: githubNodeIdSchema,
  }),
  z.strictObject({
    kind: z.literal("review_request"),
    status: z.literal("unavailable"),
    reason: z.literal("actor_unavailable"),
  }),
]);
const cacheResponsibilityEpochSchema = z.strictObject({
  ...cacheFactSchema.shape,
  targets: z.array(cacheResponsibilityTargetSchema),
});
const cacheStateEpochKnowledgeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), value: z.array(cacheStateEpochSchema) }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.enum(["history_unavailable", "actor_unavailable"]),
  }),
]);
const cacheCurrentStateEpochKnowledgeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), value: cacheStateEpochSchema }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.enum(["history_unavailable", "actor_unavailable"]),
  }),
]);
const cacheDraftEpochsSchema = z.union([
  z.strictObject({ status: z.literal("not_applicable") }),
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("known"), value: z.array(cacheDraftEpochSchema) }),
    z.strictObject({
      status: z.literal("unknown"),
      reason: z.enum(["history_unavailable", "actor_unavailable"]),
    }),
  ]),
]);
const cacheCurrentDraftEpochSchema = z.union([
  z.strictObject({ status: z.literal("not_applicable") }),
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("known"), value: cacheDraftEpochSchema }),
    z.strictObject({
      status: z.literal("unknown"),
      reason: z.enum(["history_unavailable", "actor_unavailable"]),
    }),
  ]),
]);
const cacheResponsibilityEpochKnowledgeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), value: z.array(cacheResponsibilityEpochSchema) }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.enum(["history_unavailable", "actor_unavailable"]),
  }),
]);
const cacheCurrentResponsibilityEpochKnowledgeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), value: cacheResponsibilityEpochSchema }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.enum(["history_unavailable", "actor_unavailable"]),
  }),
]);
const cacheReplaySchema = z.strictObject({
  trackingStartAt: utcIsoDateTimeSchema,
  currentState: z.enum(["open", "closed", "merged"]),
  currentDraft: z.union([
    z.strictObject({ status: z.literal("not_applicable") }),
    z.strictObject({ status: z.literal("known"), value: z.boolean() }),
  ]),
  currentResponsibilities: z.array(cacheResponsibilityTargetSchema),
  stateEpochs: cacheStateEpochKnowledgeSchema,
  currentStateEpoch: cacheCurrentStateEpochKnowledgeSchema,
  draftEpochs: cacheDraftEpochsSchema,
  currentDraftEpoch: cacheCurrentDraftEpochSchema,
  responsibilityEpochs: cacheResponsibilityEpochKnowledgeSchema,
  currentOwnerEpoch: cacheCurrentResponsibilityEpochKnowledgeSchema,
});

const cacheHistorySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    events: z.array(cacheTemporalEventSchema),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["not_returned", "redacted", "cache_miss"]),
  }),
]);

const cacheExplicitRequestCandidateSchema = z.strictObject({
  sourceId: sourceIdSchema,
  occurredAt: utcIsoDateTimeSchema,
});

const cacheMentionedWaitingOnCandidateSchema = z.strictObject({
  id: nonEmptyStringSchema,
  kind: z.enum(["user", "team"]),
  sourceIds: z.array(sourceIdSchema).min(1),
});

const cacheAnalysisFactsSchema = z.strictObject({
  explicitRequestCandidates: z.array(cacheExplicitRequestCandidateSchema),
  mentionedWaitingOnCandidates: z.array(cacheMentionedWaitingOnCandidateSchema),
  inputEvents: z.array(
    z.strictObject({
      sourceId: sourceIdSchema,
      url: githubInputEventUrlSchema,
    }),
  ),
  codexValidationContext: cacheValidationContextSchema,
});

const aiCacheReferenceSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    cacheKey: sha256HashSchema,
    sourceHash: sha256HashSchema,
    inputHash: sha256HashSchema,
    graphNeighborhoodHash: sha256HashSchema,
    identityHash: sha256HashSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
  }),
]);

const latestImportanceAiCacheReferenceSchema = z.strictObject({
  status: z.literal("available"),
  cacheKey: sha256HashSchema,
  sourceHash: sha256HashSchema,
  inputHash: sha256HashSchema,
  identityHash: sha256HashSchema,
});

const cacheAiAnalysisStatusSchema = z.enum([
  "used",
  "failed",
  "deferred",
  "not_required",
  "disabled",
  "not_recorded",
]);

const cacheItemIndexSchema = z.strictObject({
  nodeId: githubNodeIdSchema,
  repositoryId: githubRepositoryIdSchema,
  type: z.enum(["issue", "pull_request"]),
  number: z.number().int().positive(),
  url: githubItemUrlSchema,
  state: cacheItemStateSchema,
  draftState: cacheDraftStateSchema,
  bodyFingerprint: sha256HashSchema,
  itemFingerprint: sha256HashSchema,
  analysisRulesFingerprint: sha256HashSchema,
  deterministicRulesVersion: nonEmptyStringSchema,
  aiAnalysisStatus: cacheAiAnalysisStatusSchema,
  createdAt: utcIsoDateTimeSchema,
  updatedAt: utcIsoDateTimeSchema,
  observedAt: utcIsoDateTimeSchema,
  lifecycle: cacheLifecycleSchema,
});

const githubRepositoryCacheSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_DOCUMENT_SCHEMA_VERSION),
  kind: z.literal("github_repository"),
  repository: cacheRepositoryIdentitySchema,
  successfulAt: utcIsoDateTimeSchema,
  items: z.array(cacheItemIndexSchema),
});

const githubItemCacheSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_DOCUMENT_SCHEMA_VERSION),
  kind: z.literal("github_item"),
  repository: cacheRepositoryIdentitySchema,
  ...cacheItemIndexSchema.shape,
  currentObservation: cacheCurrentObservationSchema,
  analysisFacts: cacheAnalysisFactsSchema,
  relationCandidates: z.array(cacheRelationCandidateSchema),
  relationMutations: z.array(cacheRelationMutationResultSchema),
  replay: cacheReplaySchema,
  history: cacheHistorySchema,
  aiCacheReference: aiCacheReferenceSchema,
});

const latestImportanceSchema = z.strictObject({
  significantFeature: z.boolean(),
  explicitDeadline: z.boolean(),
  futureRisk: z.boolean(),
  rationale: z.string().min(1).max(MAX_AI_IMPORTANCE_RATIONALE_LENGTH),
});

const aiMetadataSchema = z.strictObject({
  deterministicRulesVersion: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  reasoningEffort: reasoningEffortSchema,
  backendVersion: nonEmptyStringSchema,
  promptVersion: nonEmptyStringSchema,
  analysisSchemaVersion: nonEmptyStringSchema,
  executedAt: utcIsoDateTimeSchema,
});

const aiLatestImportanceCacheSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_DOCUMENT_SCHEMA_VERSION),
  kind: z.literal("ai_latest_importance"),
  repository: cacheRepositoryIdentitySchema,
  nodeId: githubNodeIdSchema,
  importance: latestImportanceSchema,
  confidence: z.number().min(0).max(1),
  aiCacheReference: latestImportanceAiCacheReferenceSchema,
  metadata: aiMetadataSchema,
});

const cacheDocumentSchema = z.discriminatedUnion("kind", [
  githubRepositoryCacheSchema,
  githubItemCacheSchema,
  aiLatestImportanceCacheSchema,
]);

type ParsedCacheRepositoryIdentity = z.output<typeof cacheRepositoryIdentitySchema>;
type ParsedCacheLifecycle = z.output<typeof cacheLifecycleSchema>;
type ParsedCacheItemIndex = z.output<typeof cacheItemIndexSchema>;
type ParsedCacheTemporalEvent = z.output<typeof cacheTemporalEventSchema>;
type ParsedCacheHistory = z.output<typeof cacheHistorySchema>;
type ParsedAiCacheReference = z.output<typeof aiCacheReferenceSchema>;
type ParsedLatestImportanceAiCacheReference = z.output<
  typeof latestImportanceAiCacheReferenceSchema
>;
type ParsedCacheRelationCandidate = z.output<typeof cacheRelationCandidateSchema>;
type ParsedCacheNormalizedEvent = z.output<typeof cacheNormalizedEventSchema>;
type ParsedCacheRelationReference = z.output<typeof cacheRelationReferenceSchema>;
type ParsedCacheRelationMutationResult = z.output<typeof cacheRelationMutationResultSchema>;
type ParsedCacheAnalysisFacts = z.output<typeof cacheAnalysisFactsSchema>;
type ParsedCacheRelationMutation = Extract<
  ParsedCacheRelationMutationResult,
  { status: "available" }
>["mutations"][number];
type ParsedCacheRelationInterval = z.output<typeof cacheRelationIntervalSchema>;
type ParsedCacheFact = z.output<typeof cacheFactSchema>;
type ParsedCacheReplay = z.output<typeof cacheReplaySchema>;

/** キャッシュ文書へ渡すリポジトリ識別情報。公開境界の判定は別のadapterが担当する。 */
export type CacheRepositoryIdentity = ParsedCacheRepositoryIdentity;

/** cache itemのopenまたはterminal lifecycle。 */
export type CacheLifecycle = ParsedCacheLifecycle;

/** raw本文を含まない正規化済みtemporal event。 */
export type CacheTemporalEvent = ParsedCacheTemporalEvent;

/** repository cacheとitem cacheで共有する項目の現在メタデータ。 */
export type CacheItemIndex = ParsedCacheItemIndex;

/** 完全取得済みまたは取得不能な履歴。 */
export type CacheHistory = ParsedCacheHistory;

/** raw本文を含まないwarm解析用の構造化事実。 */
export type GitHubItemCacheAnalysisFacts = ParsedCacheAnalysisFacts;

/** explicit request候補のsource IDと発生時刻。 */
export type CacheExplicitRequestCandidate =
  ParsedCacheAnalysisFacts["explicitRequestCandidates"][number];

/** GitHub mentionから得たuserまたはteam候補。 */
export type CacheMentionedWaitingOnCandidate =
  ParsedCacheAnalysisFacts["mentionedWaitingOnCandidates"][number];

/** Codex出力のsemantic再検証に必要なraw非保持context。 */
export type { CodexCacheValidationContext } from "../codex/semantic-validation.js";

/** 完全一致AI cacheへの参照または利用不能状態。 */
export type AiCacheReference = ParsedAiCacheReference;

/** latest importance専用のgraph非依存AI cache参照。 */
export type LatestImportanceAiCacheReference = ParsedLatestImportanceAiCacheReference;

/** キャッシュ文書の公開検証へ渡す秘密値一覧。 */
export type CacheDocumentSafetyInput = Readonly<{
  document: unknown;
  knownSecrets: readonly string[];
}>;

/** repository cacheに保存する文書。 */
export type GitHubRepositoryCacheDocument = z.output<typeof githubRepositoryCacheSchema>;

/** item cacheに保存する文書。 */
export type GitHubItemCacheDocument = z.output<typeof githubItemCacheSchema>;

/** raw本文を含まないGitHub項目の現行正規化観測値。 */
export type GitHubItemCacheObservation = z.output<typeof cacheCurrentObservationSchema>;

/** raw本文を含まないcache用relation候補。 */
export type GitHubItemCacheRelationCandidate = z.output<typeof cacheRelationCandidateSchema>;

/** 本文差分を含まないcache用relation mutation復元結果。 */
export type GitHubItemCacheRelationMutationResult = z.output<
  typeof cacheRelationMutationResultSchema
>;

/** state、責任者、関係変化の復元に必要なcache用replay結果。 */
export type GitHubItemCacheReplay = z.output<typeof cacheReplaySchema>;

/** node ID単位の直近重要度cacheに保存する文書。 */
export type AiLatestImportanceCacheDocument = z.output<typeof aiLatestImportanceCacheSchema>;

/** cache-only branchへ保存できる文書のstrict discriminated union。 */
export type CacheDocument = z.output<typeof cacheDocumentSchema>;

/** キャッシュ文書の意味検証に失敗したことを表す。 */
export class CacheDocumentSemanticError extends StatePersistenceError {
  public constructor(message: string) {
    super(`cache文書の意味検証に失敗しました。${message}`, {});
  }
}

function normalizedFieldName(value: string): string {
  return value.replaceAll(/[-_]/gu, "").toLowerCase();
}

function includesKnownValue(value: string, knownValues: readonly string[]): boolean {
  return knownValues.some((knownValue) => value.includes(knownValue));
}

function includesSecretPattern(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function scanUnsafeValues(
  values: readonly unknown[],
  knownSecrets: readonly string[],
): readonly string[] {
  const violationCodes = new Set<string>();
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.length > MAX_CACHE_STRING_LENGTH) {
        violationCodes.add("oversized_string");
      }
      if (includesKnownValue(value, knownSecrets) || includesSecretPattern(value)) {
        violationCodes.add("secret");
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      const fieldName = normalizedFieldName(key);
      if (CREDENTIAL_FIELD_NAMES.has(fieldName)) {
        violationCodes.add("credential_field");
      }
      if (FORBIDDEN_FIELD_NAMES.has(fieldName) || fieldName.startsWith("raw")) {
        violationCodes.add("forbidden_content_field");
      }
      if (includesKnownValue(key, knownSecrets) || includesSecretPattern(key)) {
        violationCodes.add("secret");
      }
      pending.push(propertyValue);
    }
  }
  return Object.freeze([...violationCodes]);
}

function assertKnownSecrets(knownSecrets: readonly string[]): void {
  if (knownSecrets.some((secret) => secret.length === 0)) {
    throw new StatePublicSafetyError(["empty_known_secret"]);
  }
}

function parseTimestamp(value: UtcIsoDateTime, fieldName: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CacheDocumentSemanticError(`${fieldName}が有効な日時ではありません`);
  }
  return timestamp;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareSourceIdLists(left: readonly SourceId[], right: readonly SourceId[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSourceId = left[index];
    const rightSourceId = right[index];
    if (leftSourceId == null || rightSourceId == null) {
      throw new CacheDocumentSemanticError("source IDがありません");
    }
    const comparison = compareStrings(leftSourceId, rightSourceId);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return left.length - right.length;
}

function assertSourceIdList(
  sourceIds: readonly SourceId[],
  context: string,
  seenSourceIds: Set<SourceId>,
): void {
  if (sourceIds.length === 0) {
    throw new CacheDocumentSemanticError(`${context}のsource IDが空です`);
  }
  for (let index = 0; index < sourceIds.length; index += 1) {
    const sourceId = sourceIds[index];
    if (sourceId == null) {
      throw new CacheDocumentSemanticError(`${context}のsource IDがありません`);
    }
    if (seenSourceIds.has(sourceId)) {
      throw new CacheDocumentSemanticError(`${context}のsource IDが重複しています`);
    }
    seenSourceIds.add(sourceId);
    const previous = sourceIds[index - 1];
    if (previous != null && compareStrings(previous, sourceId) >= 0) {
      throw new CacheDocumentSemanticError(`${context}のsource IDが決定的な順序で並んでいません`);
    }
  }
}

function assertRelationIntervalSourceIdList(
  sourceIds: readonly SourceId[],
  context: string,
  relationKey: string,
  occurredAt: UtcIsoDateTime,
  seenSourceIds: Map<SourceId, Readonly<{ relationKey: string; occurredAt: UtcIsoDateTime }>>,
): void {
  if (sourceIds.length === 0) {
    throw new CacheDocumentSemanticError(`${context}のsource IDが空です`);
  }
  for (let index = 0; index < sourceIds.length; index += 1) {
    const sourceId = sourceIds[index];
    if (sourceId == null) {
      throw new CacheDocumentSemanticError(`${context}のsource IDがありません`);
    }
    const previous = sourceIds[index - 1];
    if (previous != null && compareStrings(previous, sourceId) >= 0) {
      throw new CacheDocumentSemanticError(`${context}のsource IDが決定的な順序で並んでいません`);
    }
    const existing = seenSourceIds.get(sourceId);
    if (existing != null) {
      if (existing.relationKey === relationKey && existing.occurredAt === occurredAt) {
        throw new CacheDocumentSemanticError(`${context}のsource IDが重複しています`);
      }
      if (existing.occurredAt !== occurredAt) {
        throw new CacheDocumentSemanticError(
          "relation intervalのsource IDが異なる時刻を指しています",
        );
      }
    }
    seenSourceIds.set(sourceId, { relationKey, occurredAt });
  }
}

function assertTimestampRange(
  value: UtcIsoDateTime,
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
  context: string,
): void {
  const timestamp = parseTimestamp(value, context);
  if (
    timestamp < parseTimestamp(createdAt, "createdAt") ||
    timestamp > parseTimestamp(observedAt, "observedAt")
  ) {
    throw new CacheDocumentSemanticError(`${context}はcreatedAtからobservedAtの範囲にしてください`);
  }
}

function compareFacts(left: ParsedCacheFact, right: ParsedCacheFact): number {
  const occurredAtComparison = compareStrings(left.occurredAt, right.occurredAt);
  return occurredAtComparison !== 0
    ? occurredAtComparison
    : compareSourceIdLists(left.sourceIds, right.sourceIds);
}

function assertFactArray(
  facts: readonly ParsedCacheFact[],
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
  context: string,
): void {
  const seenSourceIds = new Set<SourceId>();
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    if (fact == null) {
      throw new CacheDocumentSemanticError(`${context}がありません`);
    }
    assertSourceIdList(fact.sourceIds, context, seenSourceIds);
    assertTimestampRange(fact.occurredAt, createdAt, observedAt, `${context}.occurredAt`);
    const previous = facts[index - 1];
    if (previous != null && compareFacts(previous, fact) > 0) {
      throw new CacheDocumentSemanticError(`${context}が決定的な順序で並んでいません`);
    }
  }
}

function relationReferenceKey(reference: ParsedCacheRelationReference): string {
  return `${reference.repositoryOwner.toLowerCase()}/${reference.repositoryName.toLowerCase()}#${reference.number.toString()}`;
}

function compareRelationReferences(
  left: ParsedCacheRelationReference,
  right: ParsedCacheRelationReference,
): number {
  return compareStrings(relationReferenceKey(left), relationReferenceKey(right));
}

function sameReferenceSets(
  left: readonly ParsedCacheRelationReference[],
  right: readonly ParsedCacheRelationReference[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((reference, index) => {
    const other = right[index];
    return other != null && relationReferenceKey(reference) === relationReferenceKey(other);
  });
}

function responsibilityTargetKey(
  target: ParsedCacheReplay["currentResponsibilities"][number],
): string {
  if (target.kind === "assignee") {
    return `assignee:${target.nodeId}`;
  }
  if ("status" in target) {
    return "review_request:unavailable";
  }
  return `review_request:${target.target}:${target.nodeId}`;
}

function isUnavailableResponsibility(
  target: ParsedCacheReplay["currentResponsibilities"][number],
): boolean {
  return target.kind === "review_request" && "status" in target;
}

function assertResponsibilityTargets(
  targets: readonly ParsedCacheReplay["currentResponsibilities"][number][],
  context: string,
): void {
  const knownKeys = new Set<string>();
  let previousKey: string | undefined;
  for (const target of targets) {
    const key = responsibilityTargetKey(target);
    if (!isUnavailableResponsibility(target)) {
      if (knownKeys.has(key)) {
        throw new CacheDocumentSemanticError(`${context}が重複しています`);
      }
      knownKeys.add(key);
    }
    if (previousKey != null && previousKey > key) {
      throw new CacheDocumentSemanticError(`${context}が決定的な順序で並んでいません`);
    }
    previousKey = key;
  }
}

function compareTemporalEvents(
  left: ParsedCacheTemporalEvent,
  right: ParsedCacheTemporalEvent,
): number {
  const occurredAtComparison = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtComparison !== 0) {
    return occurredAtComparison;
  }
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return compareStrings(left.sourceId, right.sourceId);
}

function assertRepositoryIdentity(identity: ParsedCacheRepositoryIdentity): void {
  if (identity.owner.includes("/") || identity.name.includes("/")) {
    throw new CacheDocumentSemanticError("repository ownerとnameにslashを指定できません");
  }
}

function assertTerminalRetention(lifecycle: ParsedCacheLifecycle, createdAt: UtcIsoDateTime): void {
  if (lifecycle.kind === "open") {
    return;
  }
  const terminalTimestamp = parseTimestamp(lifecycle.terminalAt, "lifecycle.terminalAt");
  const expiresTimestamp = parseTimestamp(lifecycle.expiresAt, "lifecycle.expiresAt");
  const createdTimestamp = parseTimestamp(createdAt, "createdAt");
  if (terminalTimestamp < createdTimestamp) {
    throw new CacheDocumentSemanticError("terminalAtはcreatedAt以後にしてください");
  }
  if (expiresTimestamp !== terminalTimestamp + TERMINAL_RETENTION_MILLISECONDS) {
    throw new CacheDocumentSemanticError("expiresAtはterminalAtから180日後にしてください");
  }
}

function assertTemporalEvents(
  events: readonly ParsedCacheTemporalEvent[],
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): void {
  const sourceIds = new Set<SourceId>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event == null) {
      throw new CacheDocumentSemanticError("temporal eventがありません");
    }
    if (sourceIds.has(event.sourceId)) {
      throw new CacheDocumentSemanticError("temporal eventのsource IDが重複しています");
    }
    sourceIds.add(event.sourceId);
    assertTimestampRange(event.occurredAt, createdAt, observedAt, "temporal event.occurredAt");
    const previous = events[index - 1];
    if (previous != null && compareTemporalEvents(previous, event) > 0) {
      throw new CacheDocumentSemanticError("temporal eventが決定的な順序で並んでいません");
    }
    const relatedNodeIds = new Set(event.relatedNodeIds);
    if (relatedNodeIds.size !== event.relatedNodeIds.length) {
      throw new CacheDocumentSemanticError("temporal eventのrelated node IDが重複しています");
    }
    for (let index = 1; index < event.relatedNodeIds.length; index += 1) {
      const previousNodeId = event.relatedNodeIds[index - 1];
      const nodeId = event.relatedNodeIds[index];
      if (previousNodeId == null || nodeId == null) {
        throw new CacheDocumentSemanticError("temporal eventのrelated node IDがありません");
      }
      if (compareStrings(previousNodeId, nodeId) > 0) {
        throw new CacheDocumentSemanticError(
          "temporal eventのrelated node IDが決定的な順序で並んでいません",
        );
      }
    }
  }
}

function assertItemIndex(item: ParsedCacheItemIndex): void {
  const createdAt = parseTimestamp(item.createdAt, "item.createdAt");
  const updatedAt = parseTimestamp(item.updatedAt, "item.updatedAt");
  const observedAt = parseTimestamp(item.observedAt, "item.observedAt");
  if (createdAt > updatedAt) {
    throw new CacheDocumentSemanticError("updatedAtはcreatedAt以後にしてください");
  }
  if (updatedAt > observedAt) {
    throw new CacheDocumentSemanticError("updatedAtはobservedAt以前にしてください");
  }
  if (item.type === "issue" && item.draftState !== "not_applicable") {
    throw new CacheDocumentSemanticError("IssueのdraftStateはnot_applicableにしてください");
  }
  if (item.type === "pull_request" && item.draftState === "not_applicable") {
    throw new CacheDocumentSemanticError("Pull RequestのdraftStateがnot_applicableです");
  }
  if (item.state === "open" && item.lifecycle.kind !== "open") {
    throw new CacheDocumentSemanticError("open項目のlifecycleがterminalです");
  }
  if (item.state !== "open" && item.lifecycle.kind !== "terminal") {
    throw new CacheDocumentSemanticError("terminal項目のlifecycleがopenです");
  }
  if (item.state === "merged" && item.type !== "pull_request") {
    throw new CacheDocumentSemanticError("Issueをmerged状態で保存できません");
  }
  if (item.url.toLowerCase().includes("/issues/") !== (item.type === "issue")) {
    throw new CacheDocumentSemanticError("item typeとGitHub URLのpathが一致しません");
  }
  assertTerminalRetention(item.lifecycle, item.createdAt);
  if (item.lifecycle.kind === "terminal") {
    if (parseTimestamp(item.lifecycle.terminalAt, "lifecycle.terminalAt") > observedAt) {
      throw new CacheDocumentSemanticError("terminalAtはobservedAt以前にしてください");
    }
  }
}

function assertItemUrl(
  item: Readonly<{
    repository: ParsedCacheRepositoryIdentity;
    type: "issue" | "pull_request";
    number: number;
    url: GitHubItemUrl;
  }>,
): void {
  const parsedUrl = new URL(item.url);
  const expectedPath = `/${item.repository.owner}/${item.repository.name}/${item.type === "issue" ? "issues" : "pull"}/${item.number.toString()}`;
  if (
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
    parsedUrl.search.length !== 0 ||
    parsedUrl.hash.length !== 0
  ) {
    throw new CacheDocumentSemanticError("GitHub URLがrepository、type、numberと一致しません");
  }
}

function assertRepositoryItems(
  items: readonly ParsedCacheItemIndex[],
  repository: ParsedCacheRepositoryIdentity,
  successfulAt: UtcIsoDateTime,
): void {
  const nodeIds = new Set<GitHubNodeId>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item == null) {
      throw new CacheDocumentSemanticError("repository cache内にitemがありません");
    }
    const previousItem = items[index - 1];
    if (previousItem != null && compareStrings(previousItem.nodeId, item.nodeId) > 0) {
      throw new CacheDocumentSemanticError(
        "repository cache内のitem node IDが決定的な順序で並んでいません",
      );
    }
    if (item.repositoryId !== repository.repositoryId) {
      throw new CacheDocumentSemanticError("repository cache内のitem repositoryIdが一致しません");
    }
    if (
      parseTimestamp(item.observedAt, "repository item.observedAt") >
      parseTimestamp(successfulAt, "repository successfulAt")
    ) {
      throw new CacheDocumentSemanticError(
        "repository itemのobservedAtはsuccessfulAt以前にしてください",
      );
    }
    if (nodeIds.has(item.nodeId)) {
      throw new CacheDocumentSemanticError("repository cache内のitem node IDが重複しています");
    }
    nodeIds.add(item.nodeId);
    assertItemUrl({
      repository,
      type: item.type,
      number: item.number,
      url: item.url,
    });
    assertItemIndex(item);
  }
}

function relationCandidateNodes(
  relation: ParsedCacheRelationCandidate["relation"],
): readonly [z.output<typeof cacheRelationNodeSchema>, z.output<typeof cacheRelationNodeSchema>] {
  switch (relation.type) {
    case "blocks":
      return [relation.blocker, relation.blocked];
    case "parent_of":
      return [relation.parent, relation.subtask];
    case "implements":
      return [relation.implementation, relation.target];
    case "unclassified":
      return [relation.referencing, relation.referenced];
  }
}

function assertCacheRelationCandidates(candidates: readonly ParsedCacheRelationCandidate[]): void {
  const candidateIds = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate == null) {
      throw new CacheDocumentSemanticError("relation candidateがありません");
    }
    if (candidateIds.has(candidate.id)) {
      throw new CacheDocumentSemanticError("relation candidate IDが重複しています");
    }
    candidateIds.add(candidate.id);
    const previous = candidates[index - 1];
    if (previous != null && compareStrings(previous.id, candidate.id) > 0) {
      throw new CacheDocumentSemanticError("relation candidateが決定的な順序で並んでいません");
    }
    const sourceIds = new Set(candidate.sourceIds);
    if (sourceIds.size !== candidate.sourceIds.length) {
      throw new CacheDocumentSemanticError("relation candidateのsource IDが重複しています");
    }
    for (let sourceIndex = 1; sourceIndex < candidate.sourceIds.length; sourceIndex += 1) {
      const previousSourceId = candidate.sourceIds[sourceIndex - 1];
      const sourceId = candidate.sourceIds[sourceIndex];
      if (previousSourceId == null || sourceId == null || previousSourceId > sourceId) {
        throw new CacheDocumentSemanticError(
          "relation candidateのsource IDが決定的な順序で並んでいません",
        );
      }
    }
    if (
      (candidate.provenance === "native" && candidate.authority !== "authoritative") ||
      (candidate.provenance !== "native" && candidate.authority !== "inferred") ||
      (candidate.provenance === "explicit_text" && candidate.relation.type !== "unclassified") ||
      (candidate.provenance === "closing_keyword" && candidate.relation.type !== "implements") ||
      (candidate.provenance === "checklist" && candidate.relation.type !== "parent_of") ||
      (candidate.provenance === "cross_reference" &&
        candidate.relation.type !== "unclassified" &&
        candidate.relation.type !== "implements") ||
      (candidate.authority === "authoritative" && candidate.relation.type === "unclassified")
    ) {
      throw new CacheDocumentSemanticError("relation candidateのauthorityとprovenanceが不整合です");
    }
    const [firstNode, secondNode] = relationCandidateNodes(candidate.relation);
    if (firstNode.nodeId === secondNode.nodeId) {
      throw new CacheDocumentSemanticError("relation candidateが同じnodeを接続しています");
    }
  }
}

function assertCacheNormalizedEvents(
  events: readonly ParsedCacheNormalizedEvent[],
  itemNodeId: GitHubNodeId,
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): void {
  const sourceIds = new Set<SourceId>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event == null) {
      throw new CacheDocumentSemanticError("normalized eventがありません");
    }
    if (sourceIds.has(event.sourceId)) {
      throw new CacheDocumentSemanticError("normalized eventのsource IDが重複しています");
    }
    sourceIds.add(event.sourceId);
    if (event.itemNodeId !== itemNodeId) {
      throw new CacheDocumentSemanticError("normalized eventのitem node IDが一致しません");
    }
    assertTimestampRange(event.occurredAt, createdAt, observedAt, "normalized event.occurredAt");
    const previous = events[index - 1];
    if (
      previous != null &&
      (previous.occurredAt > event.occurredAt ||
        (previous.occurredAt === event.occurredAt && previous.sourceId > event.sourceId))
    ) {
      throw new CacheDocumentSemanticError("normalized eventが決定的な順序で並んでいません");
    }
  }
}

function compareExplicitRequestCandidates(
  left: ParsedCacheAnalysisFacts["explicitRequestCandidates"][number],
  right: ParsedCacheAnalysisFacts["explicitRequestCandidates"][number],
): number {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareStrings(left.sourceId, right.sourceId);
}

function compareMentionedCandidates(
  left: ParsedCacheAnalysisFacts["mentionedWaitingOnCandidates"][number],
  right: ParsedCacheAnalysisFacts["mentionedWaitingOnCandidates"][number],
): number {
  const leftKey = `${left.kind}:${left.id.toLowerCase()}`;
  const rightKey = `${right.kind}:${right.id.toLowerCase()}`;
  const keyComparison = compareStrings(leftKey, rightKey);
  return keyComparison !== 0
    ? keyComparison
    : compareSourceIdLists(left.sourceIds, right.sourceIds);
}

function assertCacheAnalysisFacts(
  facts: ParsedCacheAnalysisFacts,
  document: Extract<CacheDocument, { kind: "github_item" }>,
): void {
  const explicitSourceIds = new Set<SourceId>();
  const contextSourceIds = new Set(facts.codexValidationContext.sources.map((source) => source.id));
  const inputEventSourceIds = new Set<SourceId>();
  for (const inputEvent of facts.inputEvents) {
    if (inputEventSourceIds.has(inputEvent.sourceId)) {
      throw new CacheDocumentSemanticError("入力イベントのsource IDが重複しています");
    }
    const event = document.currentObservation.events.find(
      (candidate) => candidate.sourceId === inputEvent.sourceId,
    );
    if (event == null) {
      throw new CacheDocumentSemanticError("入力イベントが現在観測値のeventにありません");
    }
    if (!inputEvent.url.startsWith(document.url)) {
      throw new CacheDocumentSemanticError("入力イベントURLがitem URLと一致しません");
    }
    inputEventSourceIds.add(inputEvent.sourceId);
  }
  if (inputEventSourceIds.size !== document.currentObservation.events.length) {
    throw new CacheDocumentSemanticError("現在観測値の全eventに入力イベントURLが必要です");
  }
  for (let index = 0; index < facts.explicitRequestCandidates.length; index += 1) {
    const candidate = facts.explicitRequestCandidates[index];
    if (candidate == null) {
      throw new CacheDocumentSemanticError("explicit request候補がありません");
    }
    if (explicitSourceIds.has(candidate.sourceId)) {
      throw new CacheDocumentSemanticError("explicit request候補のsource IDが重複しています");
    }
    explicitSourceIds.add(candidate.sourceId);
    if (!contextSourceIds.has(candidate.sourceId)) {
      throw new CacheDocumentSemanticError("explicit request候補のsource IDがcontextにありません");
    }
    assertTimestampRange(
      candidate.occurredAt,
      document.createdAt,
      document.observedAt,
      "explicit request候補.occurredAt",
    );
    const previous = facts.explicitRequestCandidates[index - 1];
    if (previous != null && compareExplicitRequestCandidates(previous, candidate) > 0) {
      throw new CacheDocumentSemanticError("explicit request候補が決定的な順序で並んでいません");
    }
    if (candidate.sourceId !== document.currentObservation.bodySourceId) {
      const event = document.currentObservation.events.find(
        (value) => value.sourceId === candidate.sourceId,
      );
      if (event?.kind !== "comment") {
        throw new CacheDocumentSemanticError(
          "explicit request候補が本文またはcommentを参照していません",
        );
      }
      if (event.actor.type !== "human") {
        throw new CacheDocumentSemanticError(
          "explicit request候補のcomment actorがhumanではありません",
        );
      }
      if (event.bodyEmpty) {
        throw new CacheDocumentSemanticError("空のcommentをexplicit request候補にできません");
      }
      if (event.occurredAt !== candidate.occurredAt) {
        throw new CacheDocumentSemanticError("explicit request候補の時刻がcommentと一致しません");
      }
    } else if (document.currentObservation.bodyEmpty) {
      throw new CacheDocumentSemanticError("空の本文をexplicit request候補にできません");
    } else if (candidate.occurredAt !== document.createdAt) {
      throw new CacheDocumentSemanticError(
        "explicit request候補の本文時刻がcreatedAtと一致しません",
      );
    }
  }
  if (
    document.type === "issue" &&
    !document.currentObservation.bodyEmpty &&
    !explicitSourceIds.has(document.currentObservation.bodySourceId)
  ) {
    throw new CacheDocumentSemanticError("非空Issue本文がexplicit request候補にありません");
  }
  if (
    document.type === "issue" &&
    document.currentObservation.bodyEmpty &&
    explicitSourceIds.has(document.currentObservation.bodySourceId)
  ) {
    throw new CacheDocumentSemanticError("空Issue本文がexplicit request候補に含まれています");
  }

  const mentionedCandidateKeys = new Set<string>();
  for (let index = 0; index < facts.mentionedWaitingOnCandidates.length; index += 1) {
    const candidate = facts.mentionedWaitingOnCandidates[index];
    if (candidate == null) {
      throw new CacheDocumentSemanticError("mention候補がありません");
    }
    const key = `${candidate.kind}:${candidate.id.toLowerCase()}`;
    if (mentionedCandidateKeys.has(key)) {
      throw new CacheDocumentSemanticError("mention候補が重複しています");
    }
    mentionedCandidateKeys.add(key);
    const sourceIds = new Set<SourceId>();
    assertSourceIdList(candidate.sourceIds, "mention候補", sourceIds);
    for (const sourceId of candidate.sourceIds) {
      if (!contextSourceIds.has(sourceId)) {
        throw new CacheDocumentSemanticError("mention候補のsource IDがcontextにありません");
      }
      if (sourceId === document.currentObservation.bodySourceId) {
        if (document.currentObservation.bodyEmpty) {
          throw new CacheDocumentSemanticError("空の本文をmention候補のsourceにできません");
        }
        continue;
      }
      const event = document.currentObservation.events.find((value) => value.sourceId === sourceId);
      if (event?.kind !== "comment") {
        throw new CacheDocumentSemanticError("mention候補が本文またはcommentを参照していません");
      }
      if (event.bodyEmpty) {
        throw new CacheDocumentSemanticError("空のcommentをmention候補のsourceにできません");
      }
    }
    const previous = facts.mentionedWaitingOnCandidates[index - 1];
    if (previous != null && compareMentionedCandidates(previous, candidate) > 0) {
      throw new CacheDocumentSemanticError("mention候補が決定的な順序で並んでいません");
    }
  }

  if (
    facts.codexValidationContext.item.nodeId !== document.nodeId ||
    facts.codexValidationContext.item.url !== document.url ||
    facts.codexValidationContext.item.type !== document.type
  ) {
    throw new CacheDocumentSemanticError(
      "Codex cache validation contextのitem identityがcache itemと一致しません",
    );
  }
  for (const source of facts.codexValidationContext.sources) {
    assertTimestampRange(
      source.createdAt,
      document.createdAt,
      document.observedAt,
      "Codex cache validation context.source.createdAt",
    );
  }
}

function assertCacheObservation(document: Extract<CacheDocument, { kind: "github_item" }>): void {
  const observation = document.currentObservation;
  if (observation.events.some((event) => event.sourceId === observation.bodySourceId)) {
    throw new CacheDocumentSemanticError(
      "current observationの本文source IDがeventと重複しています",
    );
  }
  if (
    observation.nodeId !== document.nodeId ||
    observation.repositoryId !== document.repositoryId ||
    observation.type !== document.type ||
    observation.number !== document.number ||
    observation.url !== document.url ||
    observation.bodyFingerprint !== document.bodyFingerprint ||
    observation.itemFingerprint !== document.itemFingerprint ||
    observation.createdAt !== document.createdAt ||
    observation.githubUpdatedAt !== document.updatedAt ||
    observation.observedAt !== document.observedAt
  ) {
    throw new CacheDocumentSemanticError("item cacheのcurrent observationがindexと一致しません");
  }
  if (observation.state === "open") {
    if (
      observation.closedAt != null ||
      (observation.stateReason != null && observation.stateReason !== "reopened")
    ) {
      throw new CacheDocumentSemanticError("open itemのcurrent observationが不整合です");
    }
  } else if (observation.closedAt == null) {
    throw new CacheDocumentSemanticError("closed itemのcurrent observationにclosedAtがありません");
  }
  if (observation.closedAt != null) {
    assertTimestampRange(
      observation.closedAt,
      observation.createdAt,
      observation.observedAt,
      "current observation.closedAt",
    );
  }
  if (document.state === "open" && observation.state !== "open") {
    throw new CacheDocumentSemanticError("open itemのcurrent observationがclosedです");
  }
  if (document.state !== "open" && observation.state !== "closed") {
    throw new CacheDocumentSemanticError("terminal itemのcurrent observationがopenです");
  }
  if (document.type === "pull_request") {
    const expectedDraft = document.draftState === "draft";
    if (observation.draft !== expectedDraft) {
      throw new CacheDocumentSemanticError("Pull Requestのdraft stateがindexと一致しません");
    }
  }
  if (
    document.lifecycle.kind === "terminal" &&
    observation.closedAt !== document.lifecycle.terminalAt
  ) {
    throw new CacheDocumentSemanticError("terminalAtがcurrent observationのclosedAtと一致しません");
  }
  assertCacheNormalizedEvents(
    observation.events,
    document.nodeId,
    observation.createdAt,
    observation.observedAt,
  );
}

function assertRelationReferences(
  references: readonly ParsedCacheRelationReference[],
  context: string,
): void {
  const referenceKeys = new Set<string>();
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    if (reference == null) {
      throw new CacheDocumentSemanticError(`${context}がありません`);
    }
    const key = relationReferenceKey(reference);
    if (referenceKeys.has(key)) {
      throw new CacheDocumentSemanticError(`${context}が重複しています`);
    }
    referenceKeys.add(key);
    const previous = references[index - 1];
    if (previous != null && compareRelationReferences(previous, reference) > 0) {
      throw new CacheDocumentSemanticError(`${context}が決定的な順序で並んでいません`);
    }
  }
}

function compareRelationMutations(
  left: ParsedCacheRelationMutation,
  right: ParsedCacheRelationMutation,
): number {
  const editedAtComparison = compareStrings(left.editedAt, right.editedAt);
  if (editedAtComparison !== 0) {
    return editedAtComparison;
  }
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  const sourceIdComparison = compareStrings(left.sourceId, right.sourceId);
  if (sourceIdComparison !== 0) {
    return sourceIdComparison;
  }
  const relationComparison = compareRelationReferences(left.relation, right.relation);
  if (relationComparison !== 0) {
    return relationComparison;
  }
  return compareStrings(left.action, right.action);
}

interface RelationMutationSourceOccurrence {
  contentSourceId: SourceId;
  editedAt: UtcIsoDateTime;
  sequence: number;
  relationKey: string | null;
  action: "added" | "removed" | null;
}

function registerRelationMutationSource(
  candidate: Readonly<{
    sourceId: SourceId;
    contentSourceId: SourceId;
    editedAt: UtcIsoDateTime;
    sequence: number;
    relationKey: string | null;
    action: "added" | "removed" | null;
  }>,
  seenSourceIds: Map<SourceId, RelationMutationSourceOccurrence[]>,
): void {
  const occurrences = seenSourceIds.get(candidate.sourceId) ?? [];
  for (const occurrence of occurrences) {
    if (
      occurrence.contentSourceId !== candidate.contentSourceId ||
      occurrence.editedAt !== candidate.editedAt ||
      occurrence.sequence !== candidate.sequence
    ) {
      throw new CacheDocumentSemanticError(
        "relation mutationのsource IDが異なる編集を指しています",
      );
    }
    if (
      occurrence.relationKey == null ||
      candidate.relationKey == null ||
      (occurrence.relationKey === candidate.relationKey && occurrence.action === candidate.action)
    ) {
      throw new CacheDocumentSemanticError("relation mutationのedgeとactionが重複しています");
    }
  }
  occurrences.push(candidate);
  seenSourceIds.set(candidate.sourceId, occurrences);
}

function assertRelationMutationList(
  candidates: readonly ParsedCacheRelationMutation[],
  contentSourceId: SourceId,
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
  context: string,
  seenSourceIds: Map<SourceId, RelationMutationSourceOccurrence[]>,
): void {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate == null) {
      throw new CacheDocumentSemanticError(`${context}がありません`);
    }
    if (candidate.contentSourceId !== contentSourceId) {
      throw new CacheDocumentSemanticError("relation mutationのcontent source IDが一致しません");
    }
    registerRelationMutationSource(
      {
        ...candidate,
        relationKey: relationReferenceKey(candidate.relation),
        action: candidate.action,
      },
      seenSourceIds,
    );
    assertTimestampRange(candidate.editedAt, createdAt, observedAt, `${context}.editedAt`);
    const previous = candidates[index - 1];
    if (previous != null && compareRelationMutations(previous, candidate) > 0) {
      throw new CacheDocumentSemanticError(`${context}が決定的な順序で並んでいません`);
    }
  }
}

function assertRelationIntervals(
  intervals: readonly ParsedCacheRelationInterval[],
  currentReferences: readonly ParsedCacheRelationReference[],
  replayedReferences: readonly ParsedCacheRelationReference[],
  mutations: readonly ParsedCacheRelationMutation[],
  unmatchedRemovals: readonly ParsedCacheRelationMutation[],
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): void {
  const currentReferenceKeys = new Set(currentReferences.map(relationReferenceKey));
  const finalActiveReferenceKeys = new Set<string>();
  const intervalsByReference = new Map<string, ParsedCacheRelationInterval[]>();
  const intervalSourceIds = new Map<
    SourceId,
    Readonly<{ relationKey: string; occurredAt: UtcIsoDateTime }>
  >();
  const allRemovalMutations = [...mutations, ...unmatchedRemovals].filter(
    (mutation) => mutation.action === "removed",
  );
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    if (interval == null) {
      throw new CacheDocumentSemanticError("relation intervalがありません");
    }
    const relationKey = relationReferenceKey(interval.relation);
    assertRelationIntervalSourceIdList(
      interval.addedSourceIds,
      "relation intervalのaddedSourceIds",
      relationKey,
      interval.addedAt,
      intervalSourceIds,
    );
    assertTimestampRange(interval.addedAt, createdAt, observedAt, "relation interval.addedAt");
    const previous = intervals[index - 1];
    if (
      previous != null &&
      (compareRelationReferences(previous.relation, interval.relation) > 0 ||
        (relationReferenceKey(previous.relation) === relationKey &&
          previous.addedAt > interval.addedAt))
    ) {
      throw new CacheDocumentSemanticError("relation intervalが決定的な順序で並んでいません");
    }
    const referenceIntervals = intervalsByReference.get(relationKey) ?? [];
    const previousReferenceInterval = referenceIntervals.at(-1);
    if (interval.status === "active") {
      if (previousReferenceInterval?.status === "active") {
        throw new CacheDocumentSemanticError("active relation intervalが重複しています");
      }
      assertTimestampRange(
        interval.lastConfirmedAt,
        createdAt,
        observedAt,
        "relation interval.lastConfirmedAt",
      );
      if (interval.lastConfirmedAt < interval.addedAt) {
        throw new CacheDocumentSemanticError("active relation intervalの時刻順が不正です");
      }
    } else {
      if (previousReferenceInterval?.status === "removed") {
        throw new CacheDocumentSemanticError("removed relation intervalが重複しています");
      }
      assertRelationIntervalSourceIdList(
        interval.removedSourceIds,
        "relation intervalのremovedSourceIds",
        relationKey,
        interval.removedAt,
        intervalSourceIds,
      );
      assertTimestampRange(
        interval.removedAt,
        createdAt,
        observedAt,
        "relation interval.removedAt",
      );
      if (interval.removedAt < interval.addedAt) {
        throw new CacheDocumentSemanticError("removed relation intervalの時刻順が不正です");
      }
      if (
        previousReferenceInterval?.status === "active" &&
        previousReferenceInterval.lastConfirmedAt > interval.removedAt
      ) {
        throw new CacheDocumentSemanticError("relation intervalの確認時刻と削除時刻が不正です");
      }
      for (const sourceId of interval.removedSourceIds) {
        if (
          !allRemovalMutations.some(
            (mutation) =>
              mutation.sourceId === sourceId &&
              relationReferenceKey(mutation.relation) === relationKey &&
              mutation.editedAt === interval.removedAt,
          )
        ) {
          throw new CacheDocumentSemanticError(
            "removed relation intervalのmutation根拠がありません",
          );
        }
      }
    }
    if (
      previousReferenceInterval?.status === "removed" &&
      interval.status === "active" &&
      interval.addedAt < previousReferenceInterval.removedAt
    ) {
      throw new CacheDocumentSemanticError("relation intervalの再追加時刻が削除時刻より前です");
    }
    referenceIntervals.push(interval);
    intervalsByReference.set(relationKey, referenceIntervals);
  }
  for (const [relationKey, referenceIntervals] of intervalsByReference) {
    const lastInterval = referenceIntervals.at(-1);
    if (lastInterval?.status === "active") {
      finalActiveReferenceKeys.add(relationKey);
    }
    if ((lastInterval?.status === "active") !== currentReferenceKeys.has(relationKey)) {
      throw new CacheDocumentSemanticError("relation intervalとcurrent referenceが一致しません");
    }
  }
  if (!sameReferenceSets(currentReferences, replayedReferences)) {
    throw new CacheDocumentSemanticError("exact relation replayのcurrent referenceが一致しません");
  }
  if (finalActiveReferenceKeys.size !== currentReferenceKeys.size) {
    throw new CacheDocumentSemanticError(
      "active relation intervalとcurrent referenceが一致しません",
    );
  }
  for (const key of finalActiveReferenceKeys) {
    if (!currentReferenceKeys.has(key)) {
      throw new CacheDocumentSemanticError(
        "active relation intervalとcurrent referenceが一致しません",
      );
    }
  }
}

function assertCacheRelationMutations(
  mutations: readonly ParsedCacheRelationMutationResult[],
  createdAt: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): void {
  const contentSourceIds = new Set<SourceId>();
  const mutationSourceIds = new Map<SourceId, RelationMutationSourceOccurrence[]>();
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    if (mutation == null) {
      throw new CacheDocumentSemanticError("relation mutationがありません");
    }
    const contentSourceKind = parseSourceId(mutation.contentSourceId).kind;
    if (contentSourceKind !== "github_item_body" && contentSourceKind !== "github_issue_comment") {
      throw new CacheDocumentSemanticError(
        "relation mutationのcontent source kindがrelation対象外です",
      );
    }
    if (contentSourceIds.has(mutation.contentSourceId)) {
      throw new CacheDocumentSemanticError("relation mutationのcontent source IDが重複しています");
    }
    contentSourceIds.add(mutation.contentSourceId);
    const previous = mutations[index - 1];
    if (previous != null && previous.contentSourceId > mutation.contentSourceId) {
      throw new CacheDocumentSemanticError(
        "relation mutationのcontent source IDが決定的な順序で並んでいません",
      );
    }
    if (mutation.status !== "available") {
      if ("sourceId" in mutation) {
        assertTimestampRange(
          mutation.editedAt,
          createdAt,
          observedAt,
          "unknown relation mutation.editedAt",
        );
        registerRelationMutationSource(
          {
            sourceId: mutation.sourceId,
            contentSourceId: mutation.contentSourceId,
            editedAt: mutation.editedAt,
            sequence: mutation.sequence,
            relationKey: null,
            action: null,
          },
          mutationSourceIds,
        );
      }
      continue;
    }
    assertRelationReferences(mutation.currentReferences, "current relation reference");
    assertRelationReferences(mutation.replayedReferences, "replayed relation reference");
    assertRelationMutationList(
      mutation.mutations,
      mutation.contentSourceId,
      createdAt,
      observedAt,
      "relation mutation",
      mutationSourceIds,
    );
    assertRelationMutationList(
      mutation.unmatchedRemovals,
      mutation.contentSourceId,
      createdAt,
      observedAt,
      "unmatched relation removal",
      mutationSourceIds,
    );
    for (const removal of mutation.unmatchedRemovals) {
      if (removal.action !== "removed") {
        throw new CacheDocumentSemanticError(
          "unmatched relation removalのactionがremovedではありません",
        );
      }
    }
    if (mutation.temporalKnowledge.status === "exact") {
      if (mutation.consistency !== "consistent" || mutation.unmatchedRemovals.length > 0) {
        throw new CacheDocumentSemanticError("exact relation mutationのconsistencyが不正です");
      }
      assertRelationIntervals(
        mutation.temporalKnowledge.intervals,
        mutation.currentReferences,
        mutation.replayedReferences,
        mutation.mutations,
        mutation.unmatchedRemovals,
        createdAt,
        observedAt,
      );
    } else {
      const expectedConsistency =
        mutation.temporalKnowledge.reason === "current_mismatch"
          ? "mismatch"
          : mutation.temporalKnowledge.reason === "history_incomplete"
            ? "history_incomplete"
            : "consistent";
      if (mutation.consistency !== expectedConsistency) {
        throw new CacheDocumentSemanticError("unknown relation mutationのconsistencyが不正です");
      }
    }
  }
}

function assertCacheReplay(
  replay: ParsedCacheReplay,
  document: Extract<CacheDocument, { kind: "github_item" }>,
): void {
  const createdAt = document.createdAt;
  const observedAt = document.observedAt;
  if (replay.trackingStartAt > observedAt) {
    throw new CacheDocumentSemanticError("replayのtrackingStartAtはobservedAt以前にしてください");
  }
  if (replay.currentState !== document.state) {
    throw new CacheDocumentSemanticError("replayのcurrent stateがitem indexと一致しません");
  }

  if (replay.stateEpochs.status === "known") {
    if (replay.stateEpochs.value.length === 0) {
      throw new CacheDocumentSemanticError("state epochが空です");
    }
    assertFactArray(replay.stateEpochs.value, createdAt, observedAt, "state epoch");
    const latestEpoch = replay.stateEpochs.value.at(-1);
    if (latestEpoch == null) {
      throw new CacheDocumentSemanticError("state epochの末尾がありません");
    }
    if (
      replay.currentStateEpoch.status !== "known" ||
      serializeCanonicalJson(replay.currentStateEpoch.value) !== serializeCanonicalJson(latestEpoch)
    ) {
      throw new CacheDocumentSemanticError("current state epochがstate epochの末尾と一致しません");
    }
    if (latestEpoch.state !== replay.currentState) {
      throw new CacheDocumentSemanticError("current state epochがcurrent stateと一致しません");
    }
    if (document.lifecycle.kind === "terminal" && document.currentObservation.closedAt != null) {
      if (
        latestEpoch.occurredAt !== document.lifecycle.terminalAt ||
        latestEpoch.occurredAt !== document.currentObservation.closedAt
      ) {
        throw new CacheDocumentSemanticError(
          "terminal itemのcurrent state epochがterminalAtとclosedAtに一致しません",
        );
      }
    }
  } else if (
    replay.currentStateEpoch.status !== "unknown" ||
    replay.currentStateEpoch.reason !== replay.stateEpochs.reason
  ) {
    throw new CacheDocumentSemanticError("state epochのunknown状態が不整合です");
  }

  if (document.type === "issue" && replay.currentDraft.status !== "not_applicable") {
    throw new CacheDocumentSemanticError("Issue replayのdraftがnot_applicableではありません");
  }
  if (document.type === "pull_request") {
    if (replay.currentDraft.status === "not_applicable") {
      throw new CacheDocumentSemanticError("Pull Request replayのdraftがnot_applicableです");
    }
    const expectedDraft = document.draftState === "draft";
    if (replay.currentDraft.value !== expectedDraft) {
      throw new CacheDocumentSemanticError("replayのcurrent draftがitem indexと一致しません");
    }
    if (replay.draftEpochs.status === "known") {
      if (replay.draftEpochs.value.length === 0) {
        throw new CacheDocumentSemanticError("draft epochが空です");
      }
      assertFactArray(replay.draftEpochs.value, createdAt, observedAt, "draft epoch");
      const latestEpoch = replay.draftEpochs.value.at(-1);
      if (latestEpoch == null) {
        throw new CacheDocumentSemanticError("draft epochの末尾がありません");
      }
      if (
        replay.currentDraftEpoch.status !== "known" ||
        serializeCanonicalJson(replay.currentDraftEpoch.value) !==
          serializeCanonicalJson(latestEpoch)
      ) {
        throw new CacheDocumentSemanticError(
          "current draft epochがdraft epochの末尾と一致しません",
        );
      }
      if (latestEpoch.draft !== replay.currentDraft.value) {
        throw new CacheDocumentSemanticError("current draft epochがcurrent draftと一致しません");
      }
    } else if (replay.draftEpochs.status === "unknown") {
      if (
        replay.currentDraftEpoch.status !== "unknown" ||
        replay.currentDraftEpoch.reason !== replay.draftEpochs.reason
      ) {
        throw new CacheDocumentSemanticError("draft epochのunknown状態が不整合です");
      }
    } else {
      throw new CacheDocumentSemanticError("Pull Request replayのdraft epochがnot_applicableです");
    }
  } else if (
    replay.draftEpochs.status !== "not_applicable" ||
    replay.currentDraftEpoch.status !== "not_applicable"
  ) {
    throw new CacheDocumentSemanticError("Issue replayのdraft epochがnot_applicableではありません");
  }

  assertResponsibilityTargets(replay.currentResponsibilities, "replayのcurrent responsibility");
  const expectedResponsibilityKeys = new Set<string>();
  for (const assignee of document.currentObservation.assignees) {
    const key = `assignee:${assignee.nodeId}`;
    if (expectedResponsibilityKeys.has(key)) {
      throw new CacheDocumentSemanticError("current observationのassigneeが重複しています");
    }
    expectedResponsibilityKeys.add(key);
  }
  if (document.currentObservation.type === "pull_request") {
    for (const request of document.currentObservation.reviewRequests) {
      const targetKey =
        request.target.type === "user"
          ? `review_request:user:${request.target.actor.nodeId}`
          : `review_request:team:${request.target.nodeId}`;
      if (expectedResponsibilityKeys.has(targetKey)) {
        throw new CacheDocumentSemanticError("current observationのreview requestが重複しています");
      }
      expectedResponsibilityKeys.add(targetKey);
    }
  }
  const actualResponsibilityKeys = replay.currentResponsibilities
    .filter((target) => !isUnavailableResponsibility(target))
    .map(responsibilityTargetKey);
  const unavailableResponsibilityCount = replay.currentResponsibilities.filter(
    isUnavailableResponsibility,
  ).length;
  const missingResponsibilityCount = [...expectedResponsibilityKeys].filter(
    (key) => !actualResponsibilityKeys.includes(key),
  ).length;
  if (
    actualResponsibilityKeys.some((key) => !expectedResponsibilityKeys.has(key)) ||
    missingResponsibilityCount > unavailableResponsibilityCount
  ) {
    throw new CacheDocumentSemanticError(
      "replayのcurrent responsibilityがcurrent observationと一致しません",
    );
  }

  if (replay.responsibilityEpochs.status === "known") {
    if (replay.responsibilityEpochs.value.length === 0) {
      throw new CacheDocumentSemanticError("responsibility epochが空です");
    }
    assertFactArray(
      replay.responsibilityEpochs.value,
      createdAt,
      observedAt,
      "responsibility epoch",
    );
    for (const epoch of replay.responsibilityEpochs.value) {
      assertResponsibilityTargets(epoch.targets, "responsibility epochのtarget");
    }
    const latestEpoch = replay.responsibilityEpochs.value.at(-1);
    if (latestEpoch == null) {
      throw new CacheDocumentSemanticError("responsibility epochの末尾がありません");
    }
    const latestKnownResponsibilityKeys = latestEpoch.targets
      .filter((target) => !isUnavailableResponsibility(target))
      .map(responsibilityTargetKey);
    const latestUnavailableResponsibilityCount = latestEpoch.targets.filter(
      isUnavailableResponsibility,
    ).length;
    const latestMissingResponsibilityCount = [...expectedResponsibilityKeys].filter(
      (key) => !latestKnownResponsibilityKeys.includes(key),
    ).length;
    if (
      latestKnownResponsibilityKeys.some((key) => !expectedResponsibilityKeys.has(key)) ||
      latestMissingResponsibilityCount > latestUnavailableResponsibilityCount
    ) {
      throw new CacheDocumentSemanticError(
        "current responsibility epochがcurrent responsibilityと一致しません",
      );
    }
    if (
      latestKnownResponsibilityKeys.length !== actualResponsibilityKeys.length ||
      latestKnownResponsibilityKeys.some((key) => !actualResponsibilityKeys.includes(key)) ||
      latestUnavailableResponsibilityCount !== unavailableResponsibilityCount
    ) {
      throw new CacheDocumentSemanticError(
        "current responsibility epochがcurrent responsibilityと一致しません",
      );
    }
    if (unavailableResponsibilityCount > 0) {
      if (
        replay.currentOwnerEpoch.status !== "unknown" ||
        replay.currentOwnerEpoch.reason !== "actor_unavailable"
      ) {
        throw new CacheDocumentSemanticError(
          "actor unavailableのcurrent responsibility epochがunknownではありません",
        );
      }
    } else {
      if (latestUnavailableResponsibilityCount > 0 || replay.currentOwnerEpoch.status !== "known") {
        throw new CacheDocumentSemanticError(
          "current responsibility epochがresponsibility epochの末尾と一致しません",
        );
      }
      if (
        serializeCanonicalJson(replay.currentOwnerEpoch.value) !==
        serializeCanonicalJson(latestEpoch)
      ) {
        throw new CacheDocumentSemanticError(
          "current responsibility epochがresponsibility epochの末尾と一致しません",
        );
      }
    }
  } else {
    const expectedUnknownReason =
      unavailableResponsibilityCount > 0 ? "actor_unavailable" : replay.responsibilityEpochs.reason;
    if (
      replay.currentOwnerEpoch.status !== "unknown" ||
      replay.currentOwnerEpoch.reason !== expectedUnknownReason
    ) {
      throw new CacheDocumentSemanticError("responsibility epochのunknown状態が不整合です");
    }
  }
}

function assertCacheDocumentSemantics(document: CacheDocument): void {
  switch (document.kind) {
    case "github_repository":
      assertRepositoryIdentity(document.repository);
      assertRepositoryItems(document.items, document.repository, document.successfulAt);
      return;
    case "github_item":
      assertRepositoryIdentity(document.repository);
      if (document.repository.repositoryId !== document.repositoryId) {
        throw new CacheDocumentSemanticError(
          "item cacheのrepositoryIdがrepository identityと一致しません",
        );
      }
      assertItemUrl(document);
      assertItemIndex(document);
      assertCacheObservation(document);
      assertCacheAnalysisFacts(document.analysisFacts, document);
      assertCacheRelationCandidates(document.relationCandidates);
      assertCacheRelationMutations(
        document.relationMutations,
        document.createdAt,
        document.observedAt,
      );
      assertCacheReplay(document.replay, document);
      if (
        (document.aiAnalysisStatus === "used") !==
        (document.aiCacheReference.status === "available")
      ) {
        throw new CacheDocumentSemanticError(
          "item cacheのAI分析statusとAI cache参照が一致しません",
        );
      }
      if (document.history.status === "complete") {
        assertTemporalEvents(document.history.events, document.createdAt, document.observedAt);
      }
      return;
    case "ai_latest_importance":
      assertRepositoryIdentity(document.repository);
      if (document.repository.repositoryId === "") {
        throw new CacheDocumentSemanticError("latest importanceのrepositoryIdが空です");
      }
      if (document.importance.rationale.trim().length === 0) {
        throw new CacheDocumentSemanticError("latest importanceのrationaleは空にできません");
      }
      if (document.importance.rationale.length > MAX_AI_IMPORTANCE_RATIONALE_LENGTH) {
        throw new CacheDocumentSemanticError(
          "latest importanceのrationaleは120文字以内にしてください",
        );
      }
      return;
  }
}

function parseCacheDocumentValue(value: unknown): CacheDocument {
  const safetyViolations = scanUnsafeValues([value], []);
  if (safetyViolations.length > 0) {
    throw new StatePublicSafetyError(safetyViolations);
  }
  const result = cacheDocumentSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("cache文書", result.error);
  }
  assertCacheDocumentSemantics(result.data);
  return result.data;
}

/** 未検証の値をstrictなcache文書へ変換する。 */
export function createCacheDocument(value: unknown): CacheDocument {
  return parseCacheDocumentValue(value);
}

/** cache文書を意味検証する。 */
export function assertCacheDocumentSemantic(document: CacheDocument): void {
  assertCacheDocumentSemantics(document);
}

/** cache文書のsecret、credential、全文混入を再帰検査する。 */
export function assertCacheDocumentPublicSafety(input: CacheDocumentSafetyInput): void {
  assertKnownSecrets(input.knownSecrets);
  const violationCodes = scanUnsafeValues([input.document], input.knownSecrets);
  if (violationCodes.length > 0) {
    throw new StatePublicSafetyError(violationCodes);
  }
}

/** cache文書を末尾改行付きcanonical JSONへ変換する。 */
export function serializeCacheDocument(document: CacheDocument): string {
  return serializeCanonicalJsonLine(createCacheDocument(document));
}

/** canonical JSONからcache文書を検証して読み取る。 */
export function parseCacheDocument(source: string): CacheDocument {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("cache文書", {
      cause: new SyntaxError("JSON構文が不正です", { cause: error }),
    });
  }
  return createCacheDocument(value);
}

/** terminalAtからcacheの終了期限を計算する。 */
export function createCacheTerminalExpiry(terminalAt: UtcIsoDateTime): UtcIsoDateTime {
  const timestamp = parseTimestamp(terminalAt, "terminalAt");
  const expiresTimestamp = timestamp + TERMINAL_RETENTION_MILLISECONDS;
  if (!Number.isFinite(expiresTimestamp)) {
    throw new CacheDocumentSemanticError("terminalAtからexpiresAtを計算できません");
  }
  return createUtcIsoDateTime(new Date(expiresTimestamp).toISOString());
}

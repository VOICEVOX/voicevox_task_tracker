import { z } from "zod";
import type { AiAnalysisElementInputFingerprint } from "../domain/ai-analysis-elements.js";
import type { PersonalReminderCauseId } from "../domain/personal-reminder-causes.js";
import {
  PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
  personalReminderActionKindSchema,
  personalReminderCauseIdSchema,
  personalReminderInputCompletenessSchema,
  personalReminderReasonCodeSchema,
  personalReminderResponsibilitySchema,
  personalReminderResponsibleSchema,
} from "../domain/personal-reminder-causes.js";
import type { SourceId } from "../domain/source-id.js";
import { parseSourceId } from "../domain/source-id.js";
import type { GitHubNodeId, GraphNodeId } from "../domain/types.js";
import { createUtcIsoDateTime } from "../domain/types.js";

/** 個人催促AIが根拠へ付与する役割。 */
export const personalReminderEvidenceRoleSchema = z.enum([
  "obligation_candidate",
  "actionability",
  "relation",
  "resolution",
]);

/** 個人催促AIが根拠へ付与する役割。 */
export type PersonalReminderEvidenceRole = z.output<typeof personalReminderEvidenceRoleSchema>;

const opaqueIdSchema = z
  .string()
  .min(1, "IDは空にできません")
  .max(512, "IDが長すぎます")
  .regex(/^\S+$/u, "IDに空白は使えません");

const graphNodeIdSchema = z.custom<GraphNodeId>(
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 512 && /^\S+$/u.test(value),
  "node IDは空にできず空白を含められません",
);

export const githubNodeIdSchema = z.custom<GitHubNodeId>(
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 512 && /^\S+$/u.test(value),
  "GitHub node IDは空にできず空白を含められません",
);

const sourceIdSchema = z.custom<SourceId>((value) => {
  if (typeof value !== "string") {
    return false;
  }
  try {
    parseSourceId(value);
    return true;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return false;
  }
}, "正規形式のsource IDを指定してください");

const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => createUtcIsoDateTime(value));

const itemUrlSchema = z.string().regex(/^https?:\/\/\S+$/u, "HTTP URLを指定してください");

const relationTypeSchema = z.enum([
  "blocks",
  "parent_of",
  "implements",
  "related_to",
  "duplicates",
]);

const pendingRelationReasonSchema = z.enum(["assessment_missing", "confidence_below_threshold"]);

const pendingRelationEndpointNodeIdsSchema = z.tuple([graphNodeIdSchema, graphNodeIdSchema]);

const relationProvenanceSchema = z.enum([
  "native",
  "explicit_text",
  "closing_keyword",
  "checklist",
  "cross_reference",
  "ai_inference",
]);

const personalReminderCauseSemanticSeedSchema = z.strictObject({
  causeId: personalReminderCauseIdSchema,
  itemNodeId: githubNodeIdSchema,
  reasonCode: personalReminderReasonCodeSchema,
  responsible: z.array(personalReminderResponsibleSchema).nonempty().max(20),
  responsibility: personalReminderResponsibilitySchema,
  action: z.strictObject({
    kind: personalReminderActionKindSchema,
    summary: z.string().min(1).max(300),
  }),
});

/** 個人催促AIへ渡す原因の責務と行動。 */
export type PersonalReminderCauseSemanticSeed = z.output<
  typeof personalReminderCauseSemanticSeedSchema
>;

const issueItemContextSchema = z.strictObject({
  nodeId: graphNodeIdSchema,
  url: itemUrlSchema,
  title: z.string().min(1).max(1000),
  type: z.literal("issue"),
  state: z.enum(["open", "closed"]),
});

const pullRequestItemContextSchema = z.strictObject({
  nodeId: graphNodeIdSchema,
  url: itemUrlSchema,
  title: z.string().min(1).max(1000),
  type: z.literal("pull_request"),
  state: z.enum(["open", "closed_unmerged", "merged"]),
  draft: z.boolean(),
  reviewState: z.enum([
    "not_requested",
    "requested",
    "changes_requested",
    "approved",
    "mixed",
    "unknown",
  ]),
  checkState: z.enum(["not_required", "passing", "pending", "failing", "unknown"]),
  mergeState: z.enum(["not_ready", "ready", "queued", "merged", "closed_unmerged", "unknown"]),
});

const externalReferenceItemContextSchema = z.strictObject({
  nodeId: graphNodeIdSchema,
  url: itemUrlSchema,
  title: z.string().min(1).max(1000),
  type: z.literal("external_reference"),
  state: z.enum(["open", "closed", "merged", "unknown"]),
});

const personalReminderAiItemContextSchema = z.discriminatedUnion("type", [
  issueItemContextSchema,
  pullRequestItemContextSchema,
  externalReferenceItemContextSchema,
]);

/** 個人催促AIへ渡す項目の現在状態。 */
export type PersonalReminderAiItemContext = z.output<typeof personalReminderAiItemContextSchema>;

export const personalReminderAiRelationContextSchema = z.strictObject({
  id: opaqueIdSchema,
  fromNodeId: graphNodeIdSchema,
  toNodeId: graphNodeIdSchema,
  type: relationTypeSchema,
  provenance: relationProvenanceSchema,
  confidence: z.number().min(0).max(1),
  authoritative: z.boolean(),
  evidenceSourceIds: z.array(sourceIdSchema).nonempty(),
});

/** 個人催促AIへ渡す関係。 */
export type PersonalReminderAiRelationContext = z.output<
  typeof personalReminderAiRelationContextSchema
>;

const personalReminderPendingRelationSchema = z.strictObject({
  candidateId: opaqueIdSchema,
  endpointNodeIds: pendingRelationEndpointNodeIdsSchema,
  status: z.enum(["pending", "stale"]),
  reason: pendingRelationReasonSchema,
  evidenceSourceIds: z.array(sourceIdSchema).nonempty(),
});

/** 未確定relationの意味概要。AIへは送らずdeferred判定へ使う。 */
export type PersonalReminderPendingRelation = z.output<
  typeof personalReminderPendingRelationSchema
>;

const personalReminderAiSourceContextSchema = z.strictObject({
  sourceId: sourceIdSchema,
  itemNodeId: graphNodeIdSchema,
  kind: opaqueIdSchema,
  actorType: z.enum(["human", "bot", "system"]),
  actorCandidateId: opaqueIdSchema.optional(),
  occurredAt: utcIsoDateTimeSchema,
  summary: z.string().min(1),
});

/** 個人催促AIへ渡す検証済みGitHub根拠。 */
export type PersonalReminderAiSourceContext = z.output<
  typeof personalReminderAiSourceContextSchema
>;

/** 個人催促AIのitem参照。 */
export const personalReminderItemRefSchema = z
  .string()
  .regex(/^item:[0-9]+$/u, "item refが不正です")
  .brand<"PersonalReminderItemRef">();

/** 個人催促AIのrelation参照。 */
export const personalReminderRelationRefSchema = z
  .string()
  .regex(/^relation:[0-9]+$/u, "relation refが不正です")
  .brand<"PersonalReminderRelationRef">();

/** 個人催促AIのsource参照。 */
export const personalReminderSourceRefSchema = z
  .string()
  .regex(/^source:[0-9]+$/u, "source refが不正です")
  .brand<"PersonalReminderSourceRef">();

/** 個人催促AIのitem参照。 */
export type PersonalReminderItemRef = z.output<typeof personalReminderItemRefSchema>;

/** 個人催促AIのrelation参照。 */
export type PersonalReminderRelationRef = z.output<typeof personalReminderRelationRefSchema>;

/** 個人催促AIのsource参照。 */
export type PersonalReminderSourceRef = z.output<typeof personalReminderSourceRefSchema>;

const evidenceScopeSchema = z.strictObject({
  sourceId: sourceIdSchema,
  roles: z.array(personalReminderEvidenceRoleSchema).nonempty().max(4),
});

/** 原因へ許可された根拠の役割。 */
export type PersonalReminderEvidenceScope = z.output<typeof evidenceScopeSchema>;

const personalReminderTargetScopeSchema = personalReminderResponsibilitySchema.shape.scope;

/** 個人催促AIが候補原因へ引き継ぐ責務範囲。 */
export type PersonalReminderTargetScope = z.output<typeof personalReminderTargetScopeSchema>;

const waitingOptionSchema = z.strictObject({
  optionId: opaqueIdSchema,
  itemNodeId: graphNodeIdSchema,
  targetScope: personalReminderTargetScopeSchema,
  action: z.strictObject({
    kind: personalReminderActionKindSchema,
    summary: z.string().min(1).max(300),
  }),
  relationIds: z.array(opaqueIdSchema),
  evidenceSourceIds: z.array(sourceIdSchema).nonempty(),
});

/** 個人催促AIが選べる待機先。 */
export type PersonalReminderWaitingOption = z.output<typeof waitingOptionSchema>;

const duplicateOptionSchema = z.strictObject({
  canonicalCauseId: personalReminderCauseIdSchema,
  itemNodeId: githubNodeIdSchema,
  targetScope: personalReminderTargetScopeSchema,
  responsible: z.array(personalReminderResponsibleSchema).nonempty().max(20),
  action: z.strictObject({
    kind: personalReminderActionKindSchema,
    summary: z.string().min(1).max(300),
  }),
  relationIds: z.array(opaqueIdSchema).nonempty(),
  evidenceSourceIds: z.array(sourceIdSchema).nonempty(),
});

/** 個人催促AIが選べる重複原因候補。 */
export type PersonalReminderDuplicateOption = z.output<typeof duplicateOptionSchema>;

export const PERSONAL_REMINDER_AI_TRANSPORT_LIMITS = Object.freeze({
  causes: 100,
  items: 200,
  relations: 500,
  sources: 500,
  nestedReferenceIds: 30,
  waitingOptions: 20,
  duplicateOptions: 20,
});

export const personalReminderCauseSemanticInputSchema = z.strictObject({
  cause: personalReminderCauseSemanticSeedSchema,
  completeness: personalReminderInputCompletenessSchema,
  items: z.array(personalReminderAiItemContextSchema).nonempty(),
  relations: z.array(personalReminderAiRelationContextSchema),
  pendingRelations: z.array(personalReminderPendingRelationSchema),
  sources: z.array(personalReminderAiSourceContextSchema).nonempty(),
  evidenceScopes: z.array(evidenceScopeSchema).nonempty(),
  waitingOptions: z.array(waitingOptionSchema),
  duplicateOptions: z.array(duplicateOptionSchema),
});

/** 個人催促原因単位の意味入力。 */
export type PersonalReminderCauseSemanticInput = z.output<
  typeof personalReminderCauseSemanticInputSchema
>;

const personalReminderTargetScopeTransportSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("item"),
  }),
  z.strictObject({
    kind: z.literal("execution_surfaces"),
    surfaces: z
      .array(
        z.strictObject({
          kind: z.enum(["issue", "pull_request"]),
          itemRef: personalReminderItemRefSchema,
        }),
      )
      .nonempty()
      .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
  }),
  z.strictObject({
    kind: z.literal("item_and_execution_surfaces"),
    surfaces: z
      .array(
        z.strictObject({
          kind: z.enum(["issue", "pull_request"]),
          itemRef: personalReminderItemRefSchema,
        }),
      )
      .nonempty()
      .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
  }),
]);

export type PersonalReminderTargetScopeTransport = z.output<
  typeof personalReminderTargetScopeTransportSchema
>;

export const personalReminderAiCauseTransportInputSchema = z.strictObject({
  causeId: personalReminderCauseIdSchema,
  cause: personalReminderCauseSemanticSeedSchema,
  completeness: personalReminderInputCompletenessSchema,
  itemRefs: z
    .array(personalReminderItemRefSchema)
    .nonempty()
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items),
  relationRefs: z
    .array(personalReminderRelationRefSchema)
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations),
  sourceRefs: z
    .array(personalReminderSourceRefSchema)
    .nonempty()
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources),
  evidenceScopes: z
    .array(
      z.strictObject({
        sourceRef: personalReminderSourceRefSchema,
        roles: z.array(personalReminderEvidenceRoleSchema).nonempty().max(4),
      }),
    )
    .nonempty()
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources),
  waitingOptions: z
    .array(
      z.strictObject({
        optionId: opaqueIdSchema,
        itemRef: personalReminderItemRefSchema,
        targetScope: personalReminderTargetScopeTransportSchema,
        action: z.strictObject({
          kind: personalReminderActionKindSchema,
          summary: z.string().min(1).max(300),
        }),
        relationRefs: z
          .array(personalReminderRelationRefSchema)
          .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
        sourceRefs: z
          .array(personalReminderSourceRefSchema)
          .nonempty()
          .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
      }),
    )
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.waitingOptions),
  duplicateOptions: z
    .array(
      z.strictObject({
        canonicalCauseId: personalReminderCauseIdSchema,
        itemRef: personalReminderItemRefSchema,
        targetScope: personalReminderTargetScopeTransportSchema,
        responsible: z.array(personalReminderResponsibleSchema).nonempty().max(20),
        action: z.strictObject({
          kind: personalReminderActionKindSchema,
          summary: z.string().min(1).max(300),
        }),
        relationRefs: z
          .array(personalReminderRelationRefSchema)
          .nonempty()
          .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
        sourceRefs: z
          .array(personalReminderSourceRefSchema)
          .nonempty()
          .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
      }),
    )
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.duplicateOptions),
});

const personalReminderAiTransportItemSchema = z.strictObject({
  ref: personalReminderItemRefSchema,
  item: personalReminderAiItemContextSchema,
});

const personalReminderAiTransportRelationSchema = z.strictObject({
  ref: personalReminderRelationRefSchema,
  relation: personalReminderAiRelationContextSchema.extend({
    evidenceSourceIds: z
      .array(sourceIdSchema)
      .nonempty()
      .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds),
  }),
});

const personalReminderAiTransportSourceSchema = z.strictObject({
  ref: personalReminderSourceRefSchema,
  source: personalReminderAiSourceContextSchema,
});

export const personalReminderAiInputSchema = z.strictObject({
  schemaVersion: z.literal(PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION),
  item: z.strictObject({
    nodeId: githubNodeIdSchema,
    url: itemUrlSchema,
  }),
  causes: z
    .array(personalReminderAiCauseTransportInputSchema)
    .nonempty()
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.causes),
  items: z
    .array(personalReminderAiTransportItemSchema)
    .nonempty()
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items),
  relations: z
    .array(personalReminderAiTransportRelationSchema)
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations),
  sources: z
    .array(personalReminderAiTransportSourceSchema)
    .nonempty()
    .max(PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources),
});

/** 個人催促AIへ渡すlocal ref形式の入力。 */
export type PersonalReminderAiInput = z.output<typeof personalReminderAiInputSchema>;

export type PersonalReminderCanonicalRefs = Readonly<{
  items: ReadonlyMap<PersonalReminderItemRef, GraphNodeId>;
  relations: ReadonlyMap<PersonalReminderRelationRef, string>;
  sources: ReadonlyMap<PersonalReminderSourceRef, SourceId>;
}>;

/** 個人催促AIの原因ごとの入力とfingerprint。 */
export type PreparedPersonalReminderCauseInput = Readonly<{
  input: PersonalReminderCauseSemanticInput;
  inputFingerprint: AiAnalysisElementInputFingerprint;
}>;

/** 個人催促AIへ送るitem単位batch。 */
export type PreparedPersonalReminderAiBatch = Readonly<{
  id: string;
  itemNodeId: GitHubNodeId;
  input: PersonalReminderAiInput;
  normalizedInput: string;
  inputCharacters: number;
  batchInputFingerprint: AiAnalysisElementInputFingerprint;
  refs: PersonalReminderCanonicalRefs;
  causeInputs: ReadonlyMap<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>;
}>;

/** 個人催促AI batchの準備結果。 */
export type PersonalReminderAiBatchPreparation =
  | Readonly<{
      status: "prepared";
      batch: PreparedPersonalReminderAiBatch;
    }>
  | Readonly<{
      status: "over_capacity";
    }>;

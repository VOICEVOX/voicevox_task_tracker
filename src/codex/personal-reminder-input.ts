import { z } from "zod";

import { type AiAnalysisElementInputFingerprint } from "../domain/ai-analysis-elements.js";
import {
  PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  personalReminderActionKindSchema,
  personalReminderCauseIdSchema,
  personalReminderInputCompletenessSchema,
  personalReminderReasonCodeSchema,
  personalReminderResponsibleSchema,
  personalReminderResponsibilitySchema,
  type PersonalReminderCause,
  type PersonalReminderCauseAssessment,
  type PersonalReminderCauseId,
  type PersonalReminderInputCompleteness,
  type PersonalReminderResponsible,
} from "../domain/personal-reminder-causes.js";
import { createUtcIsoDateTime, type GitHubNodeId, type GraphNodeId } from "../domain/types.js";
import { parseSourceId, type SourceId } from "../domain/source-id.js";
import { assertNonNullable } from "../util/index.js";
import { hashCanonicalJson, serializeCanonicalJson } from "./canonical-json.js";

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

const githubNodeIdSchema = z.custom<GitHubNodeId>(
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

const personalReminderAiRelationContextSchema = z.strictObject({
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

const waitingOptionSchema = z.strictObject({
  optionId: opaqueIdSchema,
  itemNodeId: graphNodeIdSchema,
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

const PERSONAL_REMINDER_AI_TRANSPORT_LIMITS = Object.freeze({
  causes: 100,
  items: 200,
  relations: 500,
  sources: 500,
  nestedReferenceIds: 30,
  waitingOptions: 20,
  duplicateOptions: 20,
});

const personalReminderCauseSemanticInputSchema = z.strictObject({
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

const personalReminderAiCauseTransportInputSchema = z.strictObject({
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

const personalReminderAiInputSchema = z.strictObject({
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  const sorted = [...values].sort((left, right) => compareStrings(key(left), key(right)));
  const result: T[] = [];
  let previousKey: string | undefined;
  for (const value of sorted) {
    const currentKey = key(value);
    if (previousKey !== currentKey) {
      result.push(value);
      previousKey = currentKey;
    }
  }
  return result;
}

function canonicalEndpointNodeIds(
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
  label: string,
): [GraphNodeId, GraphNodeId] {
  const [first, second] = endpointNodeIds;
  if (first === second) {
    throw new TypeError(`${label}のendpointが同一です。対象: ${first}`);
  }
  if (first < second) {
    return [first, second];
  }
  return [second, first];
}

function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.length === 0) {
      throw new TypeError("空のUnicode文字を検出しました");
    }
    count += 1;
  }
  return count;
}

function createNonEmptyArray<T>(values: readonly T[], message: string): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  assertNonNullable(first, message);
  return [first, ...rest];
}

function createMapEntry<Key, Value>(key: Key, value: Value): readonly [Key, Value] {
  return [key, value];
}

function validateUniqueStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeError(`${label}が重複しています。対象: ${value}`);
    }
    seen.add(value);
  }
}

function responsibleKey(
  value: Readonly<{ kind: string; candidateId: string; role: string }>,
): string {
  return `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
}

function causeScopeNodeIds(
  cause: PersonalReminderCauseSemanticInput["cause"],
): ReadonlySet<string> {
  const nodeIds = new Set<string>([cause.itemNodeId]);
  if (cause.responsibility.scope.kind !== "item") {
    for (const surface of cause.responsibility.scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds;
}

function relationConnectsCauseAndTarget(
  relation: PersonalReminderAiRelationContext,
  cause: PersonalReminderCauseSemanticInput["cause"],
  targetNodeId: GraphNodeId,
): boolean {
  const causeNodeIds = causeScopeNodeIds(cause);
  return (
    (causeNodeIds.has(relation.fromNodeId) && relation.toNodeId === targetNodeId) ||
    (causeNodeIds.has(relation.toNodeId) && relation.fromNodeId === targetNodeId)
  );
}

function validateOptionRelationIntegrity<Key extends string>(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    relationIds: readonly Key[];
  }>,
  cause: PersonalReminderCauseSemanticInput["cause"],
  relationById: ReadonlyMap<Key, PersonalReminderAiRelationContext>,
  label: string,
): void {
  if (option.itemNodeId !== cause.itemNodeId && option.relationIds.length === 0) {
    throw new TypeError(`${label}の別item待機にはrelationが必要です`);
  }
  for (const relationId of option.relationIds) {
    const relation = relationById.get(relationId);
    assertNonNullable(relation, `${label}のrelationがありません。対象: ${relationId}`);
    if (relation.type === "related_to") {
      throw new TypeError(`${label}にrelated_to relationは指定できません。対象: ${relationId}`);
    }
    if (!relationConnectsCauseAndTarget(relation, cause, option.itemNodeId)) {
      throw new TypeError(`${label}のrelationがcauseと待ち先のitemを接続していません`);
    }
  }
}

function validateSemanticInputIntegrity(input: PersonalReminderCauseSemanticInput): void {
  const itemNodeIds = input.items.map((value) => value.nodeId);
  validateUniqueStrings(itemNodeIds, "item node ID");
  const itemIds = new Set(itemNodeIds);
  const relationIdValues = input.relations.map((value) => value.id);
  validateUniqueStrings(relationIdValues, "relation ID");
  const relationIds = new Set(relationIdValues);
  const pendingRelationIdValues = input.pendingRelations.map((value) => value.candidateId);
  validateUniqueStrings(pendingRelationIdValues, "pending relation candidate ID");
  const sourceIdValues = input.sources.map((value) => value.sourceId);
  validateUniqueStrings(sourceIdValues, "source ID");
  const sourceIds = new Set(sourceIdValues);
  validateUniqueStrings(
    input.evidenceScopes.map((value) => value.sourceId),
    "evidence scope source ID",
  );
  validateUniqueStrings(
    input.waitingOptions.map((value) => value.optionId),
    "waiting option ID",
  );
  validateUniqueStrings(
    input.duplicateOptions.map((value) => value.canonicalCauseId),
    "duplicate option canonical cause ID",
  );
  validateUniqueStrings(
    input.cause.responsible.map((value) => responsibleKey(value)),
    "cause responsible actor",
  );
  const allowsMissingRelatedItem =
    input.completeness.status === "incomplete" &&
    input.completeness.missing.includes("related_item");
  const allowsMissingRelationEvidence =
    input.completeness.status === "incomplete" &&
    input.completeness.missing.includes("relation_evidence");
  if (input.cause.responsibility.scope.kind !== "item") {
    validateUniqueStrings(
      input.cause.responsibility.scope.surfaces.map(
        (value) => `${value.kind}\u0000${value.nodeId}`,
      ),
      "cause execution surface",
    );
  }
  if (!itemIds.has(input.cause.itemNodeId)) {
    throw new TypeError("原因のitem node IDがitem contextにありません");
  }
  const relationById = new Map(input.relations.map((relation) => [relation.id, relation]));
  const relationEvidenceSourceIds = new Set(
    input.relations.flatMap((relation) => relation.evidenceSourceIds),
  );
  const pendingRelationEvidenceSourceIds = new Set(
    input.pendingRelations.flatMap((relation) => relation.evidenceSourceIds),
  );
  const canUseMissingRelationEvidenceSource = (sourceId: SourceId): boolean =>
    allowsMissingRelationEvidence &&
    (relationEvidenceSourceIds.has(sourceId) || pendingRelationEvidenceSourceIds.has(sourceId));
  const causeNodeIds = causeScopeNodeIds(input.cause);
  for (const relation of input.relations) {
    const hasMissingEndpoint = !itemIds.has(relation.fromNodeId) || !itemIds.has(relation.toNodeId);
    if (hasMissingEndpoint && !allowsMissingRelatedItem) {
      throw new TypeError(`relation ${relation.id}の端点がitem contextにありません`);
    }
    validateUniqueStrings(relation.evidenceSourceIds, `relation ${relation.id}のsource ID`);
    for (const sourceId of relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(`relation ${relation.id}の根拠sourceがありません。対象: ${sourceId}`);
      }
    }
  }
  if (
    input.pendingRelations.length !== 0 &&
    (input.completeness.status !== "incomplete" || !allowsMissingRelationEvidence)
  ) {
    throw new TypeError(
      "pending relationを含む入力にはrelation_evidence不足を含むincompleteが必要です",
    );
  }
  for (const relation of input.pendingRelations) {
    const [firstEndpoint, secondEndpoint] = canonicalEndpointNodeIds(
      relation.endpointNodeIds,
      `pending relation ${relation.candidateId}`,
    );
    if (!causeNodeIds.has(firstEndpoint) && !causeNodeIds.has(secondEndpoint)) {
      throw new TypeError(
        `pending relation ${relation.candidateId}がcause scopeに接続していません`,
      );
    }
    const hasMissingEndpoint = !itemIds.has(firstEndpoint) || !itemIds.has(secondEndpoint);
    if (hasMissingEndpoint && (!allowsMissingRelatedItem || !allowsMissingRelationEvidence)) {
      throw new TypeError(
        `pending relation ${relation.candidateId}の端点がitem contextにありません`,
      );
    }
    validateUniqueStrings(
      relation.evidenceSourceIds,
      `pending relation ${relation.candidateId}のsource ID`,
    );
    for (const sourceId of relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(
          `pending relation ${relation.candidateId}の根拠sourceがありません。対象: ${sourceId}`,
        );
      }
    }
  }
  for (const source of input.sources) {
    if (!itemIds.has(source.itemNodeId)) {
      const isRelationEvidence =
        relationEvidenceSourceIds.has(source.sourceId) ||
        pendingRelationEvidenceSourceIds.has(source.sourceId);
      if (!allowsMissingRelatedItem || !isRelationEvidence) {
        throw new TypeError(`source ${source.sourceId}のitem node IDがitem contextにありません`);
      }
    }
  }
  for (const scope of input.evidenceScopes) {
    validateUniqueStrings(scope.roles, `evidence scope ${scope.sourceId}のrole`);
    const sourceId = scope.sourceId;
    if (!sourceIds.has(sourceId)) {
      throw new TypeError(`evidence scopeのsourceがありません。対象: ${sourceId}`);
    }
  }
  for (const option of input.waitingOptions) {
    if (!itemIds.has(option.itemNodeId)) {
      throw new TypeError(`waiting option ${option.optionId}のitemがありません`);
    }
    validateUniqueStrings(option.relationIds, `waiting option ${option.optionId}のrelation ID`);
    validateUniqueStrings(option.evidenceSourceIds, `waiting option ${option.optionId}のsource ID`);
    for (const relationId of option.relationIds) {
      if (!relationIds.has(relationId)) {
        throw new TypeError(`waiting option ${option.optionId}のrelationがありません`);
      }
    }
    for (const sourceId of option.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(`waiting option ${option.optionId}のsourceがありません`);
      }
    }
    validateOptionRelationIntegrity(
      option,
      input.cause,
      relationById,
      `waiting option ${option.optionId}`,
    );
  }
  for (const option of input.duplicateOptions) {
    if (!itemIds.has(option.itemNodeId)) {
      throw new TypeError(`duplicate option ${option.canonicalCauseId}のitemがありません`);
    }
    validateUniqueStrings(
      option.relationIds,
      `duplicate option ${option.canonicalCauseId}のrelation ID`,
    );
    validateUniqueStrings(
      option.evidenceSourceIds,
      `duplicate option ${option.canonicalCauseId}のsource ID`,
    );
    for (const relationId of option.relationIds) {
      if (!relationIds.has(relationId)) {
        throw new TypeError(`duplicate option ${option.canonicalCauseId}のrelationがありません`);
      }
    }
    for (const sourceId of option.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(`duplicate option ${option.canonicalCauseId}のsourceがありません`);
      }
    }
    validateOptionRelationIntegrity(
      option,
      input.cause,
      relationById,
      `duplicate option ${option.canonicalCauseId}`,
    );
  }
}

/** 未検証値から個人催促原因単位の意味入力を作成する。 */
export function createPersonalReminderCauseSemanticInput(
  value: unknown,
): PersonalReminderCauseSemanticInput {
  const parsed = personalReminderCauseSemanticInputSchema.parse(value);
  const normalized: PersonalReminderCauseSemanticInput = {
    ...parsed,
    pendingRelations: parsed.pendingRelations.map((relation) => ({
      ...relation,
      endpointNodeIds: canonicalEndpointNodeIds(
        relation.endpointNodeIds,
        `pending relation ${relation.candidateId}`,
      ),
    })),
  };
  validateSemanticInputIntegrity(normalized);
  return normalized;
}

function canonicalResponsible(
  responsible: readonly PersonalReminderResponsible[],
): readonly PersonalReminderResponsible[] {
  return uniqueSorted(
    responsible.map((value) => ({
      ...value,
      candidateId: value.candidateId.toLowerCase(),
    })),
    responsibleKey,
  );
}

function canonicalSemanticInput(input: PersonalReminderCauseSemanticInput): unknown {
  const responsibility = input.cause.responsibility;
  const scope =
    responsibility.scope.kind === "item"
      ? responsibility.scope
      : {
          ...responsibility.scope,
          surfaces: uniqueSorted(
            responsibility.scope.surfaces,
            (value) => `${value.kind}\u0000${value.nodeId}`,
          ),
        };
  const completeness =
    input.completeness.status === "complete"
      ? input.completeness
      : {
          status: input.completeness.status,
          missing: uniqueSorted(input.completeness.missing, (value) => value),
        };
  const relations = uniqueSorted(input.relations, (value) => value.id).map((value) => ({
    ...value,
    evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
  }));
  const waitingOptions = uniqueSorted(input.waitingOptions, (value) => value.optionId).map(
    (value) => ({
      ...value,
      relationIds: uniqueSorted(value.relationIds, (relationId) => relationId),
      evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
    }),
  );
  const duplicateOptions = uniqueSorted(
    input.duplicateOptions,
    (value) => `${value.canonicalCauseId}\u0000${value.itemNodeId}`,
  ).map((value) => ({
    ...value,
    responsible: canonicalResponsible(value.responsible),
    relationIds: uniqueSorted(value.relationIds, (relationId) => relationId),
    evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
  }));
  return {
    cause: {
      causeId: input.cause.causeId,
      itemNodeId: input.cause.itemNodeId,
      reasonCode: input.cause.reasonCode,
      responsible: canonicalResponsible(input.cause.responsible),
      responsibility: {
        authority: responsibility.authority,
        scope,
      },
      action: {
        kind: input.cause.action.kind,
      },
    },
    completeness,
    items: uniqueSorted(input.items, (value) => value.nodeId),
    relations,
    pendingRelations: uniqueSorted(input.pendingRelations, (value) => value.candidateId).map(
      (value) => ({
        candidateId: value.candidateId,
        endpointNodeIds: canonicalEndpointNodeIds(
          value.endpointNodeIds,
          `pending relation ${value.candidateId}`,
        ),
        status: value.status,
        reason: value.reason,
        evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
      }),
    ),
    sources: uniqueSorted(input.sources, (value) => value.sourceId),
    evidenceScopes: uniqueSorted(input.evidenceScopes, (value) => value.sourceId).map((value) => ({
      sourceId: value.sourceId,
      roles: uniqueSorted(value.roles, (role) => role),
    })),
    waitingOptions,
    duplicateOptions,
  };
}

/** 個人催促原因の意味入力fingerprintを作成する。 */
export function createPersonalReminderCauseInputFingerprint(
  input: PersonalReminderCauseSemanticInput,
): AiAnalysisElementInputFingerprint {
  const parsed = createPersonalReminderCauseSemanticInput(input);
  return hashCanonicalJson(canonicalSemanticInput(parsed));
}

function toItemRef(index: number): PersonalReminderItemRef {
  return personalReminderItemRefSchema.parse(`item:${index.toString()}`);
}

function toRelationRef(index: number): PersonalReminderRelationRef {
  return personalReminderRelationRefSchema.parse(`relation:${index.toString()}`);
}

function toSourceRef(index: number): PersonalReminderSourceRef {
  return personalReminderSourceRefSchema.parse(`source:${index.toString()}`);
}

function cloneSemanticInput(
  input: PersonalReminderCauseSemanticInput,
): PersonalReminderCauseSemanticInput {
  return createPersonalReminderCauseSemanticInput(input);
}

function canonicalRelationContext(
  relation: PersonalReminderAiRelationContext,
): PersonalReminderAiRelationContext {
  return personalReminderAiRelationContextSchema.parse({
    ...relation,
    evidenceSourceIds: uniqueSorted(relation.evidenceSourceIds, (sourceId) => sourceId),
  });
}

function exceedsPersonalReminderAiTransportCapacity(
  causes: readonly z.input<typeof personalReminderAiCauseTransportInputSchema>[],
  relations: readonly PersonalReminderAiRelationContext[],
  itemCount: number,
  sourceCount: number,
): boolean {
  if (
    causes.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.causes ||
    itemCount > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items ||
    relations.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations ||
    sourceCount > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources
  ) {
    return true;
  }
  for (const relation of relations) {
    if (
      relation.evidenceSourceIds.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds
    ) {
      return true;
    }
  }
  for (const cause of causes) {
    if (
      cause.itemRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items ||
      cause.relationRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations ||
      cause.sourceRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources ||
      cause.evidenceScopes.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources ||
      cause.waitingOptions.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.waitingOptions ||
      cause.duplicateOptions.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.duplicateOptions
    ) {
      return true;
    }
    for (const option of [...cause.waitingOptions, ...cause.duplicateOptions]) {
      if (
        option.relationRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds ||
        option.sourceRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds
      ) {
        return true;
      }
    }
  }
  return false;
}

type PersonalReminderTransportInputPreparation =
  | Readonly<{
      status: "prepared";
      input: PersonalReminderAiInput;
      refs: PersonalReminderCanonicalRefs;
      causeInputs: ReadonlyMap<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>;
      itemNodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "over_capacity";
    }>;

function createTransportInput(
  inputs: readonly PersonalReminderCauseSemanticInput[],
): PersonalReminderTransportInputPreparation {
  const itemById = new Map<GraphNodeId, PersonalReminderAiItemContext>();
  const relationById = new Map<string, PersonalReminderAiRelationContext>();
  const sourceById = new Map<SourceId, PersonalReminderAiSourceContext>();
  const rootItemNodeId = inputs[0]?.cause.itemNodeId;
  assertNonNullable(rootItemNodeId, "個人催促AIの原因がありません");
  for (const input of inputs) {
    if (input.completeness.status !== "complete" || input.pendingRelations.length !== 0) {
      throw new TypeError("不完全または未確定relationを含む入力はAI batchへ送れません");
    }
    if (input.cause.itemNodeId !== rootItemNodeId) {
      throw new TypeError("同じitemの原因だけを個人催促AI batchへまとめてください");
    }
    for (const item of input.items) {
      const previous = itemById.get(item.nodeId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(item)) {
        throw new TypeError(`同じitem node IDに異なるcontextがあります。対象: ${item.nodeId}`);
      }
      itemById.set(item.nodeId, item);
    }
    for (const relation of input.relations) {
      const canonicalRelation = canonicalRelationContext(relation);
      const previous = relationById.get(canonicalRelation.id);
      if (
        previous != null &&
        serializeCanonicalJson(previous) !== serializeCanonicalJson(canonicalRelation)
      ) {
        throw new TypeError(
          `同じrelation IDに異なるcontextがあります。対象: ${canonicalRelation.id}`,
        );
      }
      relationById.set(canonicalRelation.id, canonicalRelation);
    }
    for (const source of input.sources) {
      const previous = sourceById.get(source.sourceId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(source)) {
        throw new TypeError(`同じsource IDに異なるcontextがあります。対象: ${source.sourceId}`);
      }
      sourceById.set(source.sourceId, source);
    }
  }
  const items = [...itemById.values()].sort((left, right) =>
    compareStrings(left.nodeId, right.nodeId),
  );
  const relations = [...relationById.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const sources = [...sourceById.values()].sort((left, right) =>
    compareStrings(left.sourceId, right.sourceId),
  );
  const itemRefById = new Map<GraphNodeId, PersonalReminderItemRef>();
  const relationRefById = new Map<string, PersonalReminderRelationRef>();
  const sourceRefById = new Map<SourceId, PersonalReminderSourceRef>();
  for (const [index, item] of items.entries()) {
    itemRefById.set(item.nodeId, toItemRef(index));
  }
  for (const [index, relation] of relations.entries()) {
    relationRefById.set(relation.id, toRelationRef(index));
  }
  for (const [index, source] of sources.entries()) {
    sourceRefById.set(source.sourceId, toSourceRef(index));
  }
  const rootItem = itemById.get(rootItemNodeId);
  assertNonNullable(rootItem, "原因のitem contextがありません");

  const transportCauses: z.input<typeof personalReminderAiCauseTransportInputSchema>[] = [];
  const causeInputs = new Map<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>();
  const seenCauseIds = new Set<PersonalReminderCauseId>();
  for (const sourceInput of inputs) {
    const input = cloneSemanticInput(sourceInput);
    const causeId = input.cause.causeId;
    if (seenCauseIds.has(causeId)) {
      throw new TypeError(`個人催促原因IDが重複しています。対象: ${causeId}`);
    }
    seenCauseIds.add(causeId);
    const itemRefs = uniqueSorted(input.items, (item) => item.nodeId).map((item) => {
      const ref = itemRefById.get(item.nodeId);
      assertNonNullable(ref, `item refがありません。対象: ${item.nodeId}`);
      return ref;
    });
    const relationRefs = uniqueSorted(input.relations, (relation) => relation.id).map(
      (relation) => {
        const ref = relationRefById.get(relation.id);
        assertNonNullable(ref, `relation refがありません。対象: ${relation.id}`);
        return ref;
      },
    );
    const sourceRefs = uniqueSorted(input.sources, (source) => source.sourceId).map((source) => {
      const ref = sourceRefById.get(source.sourceId);
      assertNonNullable(ref, `source refがありません。対象: ${source.sourceId}`);
      return ref;
    });
    const evidenceScopes = uniqueSorted(input.evidenceScopes, (scope) => scope.sourceId).map(
      (scope) => {
        const sourceRef = sourceRefById.get(scope.sourceId);
        assertNonNullable(
          sourceRef,
          `evidence scopeのsource refがありません。対象: ${scope.sourceId}`,
        );
        const [firstRole, ...restRoles] = createNonEmptyArray(
          uniqueSorted(scope.roles, (role) => role),
          "evidence scopeのroleがありません",
        );
        return {
          sourceRef,
          roles: [firstRole, ...restRoles],
        };
      },
    );
    const waitingOptions = uniqueSorted(input.waitingOptions, (option) => option.optionId).map(
      (option) => {
        const itemRef = itemRefById.get(option.itemNodeId);
        assertNonNullable(
          itemRef,
          `waiting optionのitem refがありません。対象: ${option.itemNodeId}`,
        );
        const relationRefsForOption = uniqueSorted(
          option.relationIds,
          (relationId) => relationId,
        ).map((relationId) => {
          const relationRef = relationRefById.get(relationId);
          assertNonNullable(
            relationRef,
            `waiting optionのrelation refがありません。対象: ${relationId}`,
          );
          return relationRef;
        });
        const sourceRefsForOption = uniqueSorted(
          option.evidenceSourceIds,
          (sourceId) => sourceId,
        ).map((sourceId) => {
          const sourceRef = sourceRefById.get(sourceId);
          assertNonNullable(sourceRef, `waiting optionのsource refがありません。対象: ${sourceId}`);
          return sourceRef;
        });
        const [firstSource, ...restSources] = createNonEmptyArray(
          sourceRefsForOption,
          "waiting optionのsourceがありません",
        );
        return {
          optionId: option.optionId,
          itemRef,
          action: option.action,
          relationRefs: relationRefsForOption,
          sourceRefs: [firstSource, ...restSources],
        };
      },
    );
    const duplicateOptions = uniqueSorted(
      input.duplicateOptions,
      (option) => option.canonicalCauseId,
    ).map((option) => {
      const itemRef = itemRefById.get(option.itemNodeId);
      assertNonNullable(
        itemRef,
        `duplicate optionのitem refがありません。対象: ${option.itemNodeId}`,
      );
      const relationRefsForOption = uniqueSorted(
        option.relationIds,
        (relationId) => relationId,
      ).map((relationId) => {
        const relationRef = relationRefById.get(relationId);
        assertNonNullable(
          relationRef,
          `duplicate optionのrelation refがありません。対象: ${relationId}`,
        );
        return relationRef;
      });
      const sourceRefsForOption = uniqueSorted(
        option.evidenceSourceIds,
        (sourceId) => sourceId,
      ).map((sourceId) => {
        const sourceRef = sourceRefById.get(sourceId);
        assertNonNullable(sourceRef, `duplicate optionのsource refがありません。対象: ${sourceId}`);
        return sourceRef;
      });
      const [firstRelation, ...restRelations] = createNonEmptyArray(
        relationRefsForOption,
        "duplicate optionのrelationがありません",
      );
      const [firstSource, ...restSources] = createNonEmptyArray(
        sourceRefsForOption,
        "duplicate optionのsourceがありません",
      );
      const [firstResponsible, ...restResponsible] = createNonEmptyArray(
        canonicalResponsible(option.responsible),
        "duplicate optionの責任主体がありません",
      );
      return {
        canonicalCauseId: option.canonicalCauseId,
        itemRef,
        responsible: [firstResponsible, ...restResponsible],
        action: option.action,
        relationRefs: [firstRelation, ...restRelations],
        sourceRefs: [firstSource, ...restSources],
      };
    });
    const [firstItemRef, ...restItemRefs] = createNonEmptyArray(
      itemRefs,
      "原因のitem refがありません",
    );
    const [firstSourceRef, ...restSourceRefs] = createNonEmptyArray(
      sourceRefs,
      "原因のsource refがありません",
    );
    transportCauses.push({
      causeId,
      cause: input.cause,
      completeness: input.completeness,
      itemRefs: [firstItemRef, ...restItemRefs],
      relationRefs,
      sourceRefs: [firstSourceRef, ...restSourceRefs],
      evidenceScopes,
      waitingOptions,
      duplicateOptions,
    });
    causeInputs.set(
      causeId,
      Object.freeze({
        input,
        inputFingerprint: createPersonalReminderCauseInputFingerprint(input),
      }),
    );
  }

  if (
    exceedsPersonalReminderAiTransportCapacity(
      transportCauses,
      relations,
      items.length,
      sources.length,
    )
  ) {
    return Object.freeze({
      status: "over_capacity",
    });
  }

  const transportInput = personalReminderAiInputSchema.parse({
    schemaVersion: PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
    item: {
      nodeId: rootItem.nodeId,
      url: rootItem.url,
    },
    causes: transportCauses,
    items: items.map((item, index) => ({
      ref: toItemRef(index),
      item,
    })),
    relations: relations.map((relation, index) => ({
      ref: toRelationRef(index),
      relation,
    })),
    sources: sources.map((source, index) => ({
      ref: toSourceRef(index),
      source,
    })),
  });
  const refs: PersonalReminderCanonicalRefs = Object.freeze({
    items: new Map(items.map((item, index) => createMapEntry(toItemRef(index), item.nodeId))),
    relations: new Map(
      relations.map((relation, index) => createMapEntry(toRelationRef(index), relation.id)),
    ),
    sources: new Map(
      sources.map((source, index) => createMapEntry(toSourceRef(index), source.sourceId)),
    ),
  });
  return Object.freeze({
    status: "prepared",
    input: transportInput,
    refs,
    causeInputs,
    itemNodeId: rootItemNodeId,
  });
}

function validateTransportInputIntegrity(input: PersonalReminderAiInput): void {
  const itemRefValues = input.items.map((value) => value.ref);
  const relationRefValues = input.relations.map((value) => value.ref);
  const sourceRefValues = input.sources.map((value) => value.ref);
  validateUniqueStrings(itemRefValues, "transport item ref");
  validateUniqueStrings(relationRefValues, "transport relation ref");
  validateUniqueStrings(sourceRefValues, "transport source ref");
  const itemRefs = new Set(itemRefValues);
  const relationRefs = new Set(relationRefValues);
  const sourceRefs = new Set(sourceRefValues);
  const itemByRef = new Map(input.items.map((value) => [value.ref, value.item]));
  const relationByRef = new Map(input.relations.map((value) => [value.ref, value.relation]));
  const sourceByRef = new Map(input.sources.map((value) => [value.ref, value.source]));
  const itemNodeIdValues = input.items.map((value) => value.item.nodeId);
  validateUniqueStrings(itemNodeIdValues, "transport item node ID");
  const itemNodeIds = new Set(itemNodeIdValues);
  const rootItem = input.items.find((value) => value.item.nodeId === input.item.nodeId);
  assertNonNullable(rootItem, "transport inputのitem identityがitemsにありません");
  if (rootItem.item.url !== input.item.url) {
    throw new TypeError("transport inputのitem URLがitemsのcontextと一致しません");
  }
  const relationIdValues = input.relations.map((value) => value.relation.id);
  const sourceIdValues = input.sources.map((value) => value.source.sourceId);
  validateUniqueStrings(relationIdValues, "transport relation ID");
  validateUniqueStrings(sourceIdValues, "transport source ID");
  const relationIds = new Set(relationIdValues);
  const sourceIds = new Set(sourceIdValues);
  for (const relation of input.relations) {
    if (
      !itemNodeIds.has(relation.relation.fromNodeId) ||
      !itemNodeIds.has(relation.relation.toNodeId)
    ) {
      throw new TypeError(`transport relation ${relation.relation.id}の端点がありません`);
    }
    validateUniqueStrings(
      relation.relation.evidenceSourceIds,
      `transport relation ${relation.relation.id}のsource ID`,
    );
    for (const sourceId of relation.relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new TypeError(`transport relationのsourceがありません。対象: ${sourceId}`);
      }
    }
  }
  for (const source of input.sources) {
    if (!itemNodeIds.has(source.source.itemNodeId)) {
      throw new TypeError(`transport sourceのitemがありません。対象: ${source.source.sourceId}`);
    }
  }
  const causeIds = new Set<string>();
  for (const cause of input.causes) {
    if (cause.completeness.status !== "complete") {
      throw new TypeError(`不完全なcauseをtransportへ含められません。対象: ${cause.causeId}`);
    }
    if (causeIds.has(cause.causeId)) {
      throw new TypeError(`transport inputのcause IDが重複しています。対象: ${cause.causeId}`);
    }
    causeIds.add(cause.causeId);
    if (cause.causeId !== cause.cause.causeId) {
      throw new TypeError(`causeの外側と内側のIDが一致しません。対象: ${cause.causeId}`);
    }
    if (cause.cause.itemNodeId !== input.item.nodeId) {
      throw new TypeError(
        `causeのitem node IDがtransport itemと一致しません。対象: ${cause.causeId}`,
      );
    }
    const causeItemRefValues = [...cause.itemRefs];
    const causeRelationRefValues = [...cause.relationRefs];
    const causeSourceRefValues = [...cause.sourceRefs];
    validateUniqueStrings(causeItemRefValues, `cause ${cause.causeId}のitem ref`);
    validateUniqueStrings(causeRelationRefValues, `cause ${cause.causeId}のrelation ref`);
    validateUniqueStrings(causeSourceRefValues, `cause ${cause.causeId}のsource ref`);
    const causeItemRefs = new Set(causeItemRefValues);
    const causeRelationRefs = new Set(causeRelationRefValues);
    const causeSourceRefs = new Set(causeSourceRefValues);
    validateUniqueStrings(
      cause.cause.responsible.map((value) => responsibleKey(value)),
      `cause ${cause.causeId}の責任主体`,
    );
    if (cause.cause.responsibility.scope.kind !== "item") {
      validateUniqueStrings(
        cause.cause.responsibility.scope.surfaces.map(
          (value) => `${value.kind}\u0000${value.nodeId}`,
        ),
        `cause ${cause.causeId}のexecution surface`,
      );
    }
    validateUniqueStrings(
      cause.evidenceScopes.map((value) => value.sourceRef),
      `cause ${cause.causeId}のevidence source ref`,
    );
    validateUniqueStrings(
      cause.waitingOptions.map((value) => value.optionId),
      `cause ${cause.causeId}のwaiting option ID`,
    );
    validateUniqueStrings(
      cause.duplicateOptions.map((value) => value.canonicalCauseId),
      `cause ${cause.causeId}のduplicate option ID`,
    );
    for (const ref of causeItemRefValues) {
      if (!itemRefs.has(ref)) {
        throw new TypeError(`causeのitem refがありません。対象: ${ref}`);
      }
    }
    for (const ref of causeRelationRefValues) {
      if (!relationRefs.has(ref)) {
        throw new TypeError(`causeのrelation refがありません。対象: ${ref}`);
      }
    }
    for (const ref of causeSourceRefValues) {
      if (!sourceRefs.has(ref)) {
        throw new TypeError(`causeのsource refがありません。対象: ${ref}`);
      }
    }
    if (!causeItemRefValues.some((ref) => itemByRef.get(ref)?.nodeId === cause.cause.itemNodeId)) {
      throw new TypeError(
        `causeのitem allowlistにsubject itemがありません。対象: ${cause.causeId}`,
      );
    }
    for (const scope of cause.evidenceScopes) {
      if (!causeSourceRefs.has(scope.sourceRef)) {
        throw new TypeError(
          `causeのevidence source refがallowlistにありません。対象: ${scope.sourceRef}`,
        );
      }
      validateUniqueStrings(scope.roles, `cause ${cause.causeId}のevidence role`);
    }
    const validateOption = (
      option: Readonly<{
        itemRef: PersonalReminderItemRef;
        relationRefs: readonly PersonalReminderRelationRef[];
        sourceRefs: readonly PersonalReminderSourceRef[];
      }>,
      label: string,
    ): void => {
      if (!causeItemRefs.has(option.itemRef)) {
        throw new TypeError(
          `${label}のitem refがcause allowlistにありません。対象: ${option.itemRef}`,
        );
      }
      validateUniqueStrings(option.relationRefs, `${label}のrelation ref`);
      validateUniqueStrings(option.sourceRefs, `${label}のsource ref`);
      for (const ref of option.relationRefs) {
        if (!causeRelationRefs.has(ref)) {
          throw new TypeError(`${label}のrelation refがcause allowlistにありません。対象: ${ref}`);
        }
      }
      for (const ref of option.sourceRefs) {
        if (!causeSourceRefs.has(ref)) {
          throw new TypeError(`${label}のsource refがcause allowlistにありません。対象: ${ref}`);
        }
      }
      const targetItem = itemByRef.get(option.itemRef);
      assertNonNullable(targetItem, `${label}のitem refがありません。対象: ${option.itemRef}`);
      validateOptionRelationIntegrity(
        {
          itemNodeId: targetItem.nodeId,
          relationIds: option.relationRefs,
        },
        cause.cause,
        relationByRef,
        label,
      );
    };
    for (const option of cause.waitingOptions) {
      validateOption(option, `waiting option ${option.optionId} of cause ${cause.causeId}`);
    }
    for (const option of cause.duplicateOptions) {
      validateUniqueStrings(
        option.responsible.map((value) => responsibleKey(value)),
        `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}の責任主体`,
      );
      validateOption(
        option,
        `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}`,
      );
    }
    for (const ref of causeRelationRefValues) {
      const relation = relationByRef.get(ref);
      assertNonNullable(relation, `causeのrelation refがありません。対象: ${ref}`);
      if (!relationIds.has(relation.id)) {
        throw new TypeError(`causeのrelation IDがtransportにありません。対象: ${relation.id}`);
      }
      if (relation.type === "related_to") {
        throw new TypeError(`causeにrelated_to relationは指定できません。対象: ${relation.id}`);
      }
    }
    for (const ref of causeSourceRefValues) {
      const source = sourceByRef.get(ref);
      assertNonNullable(source, `causeのsource refがありません。対象: ${ref}`);
      if (!sourceIds.has(source.sourceId)) {
        throw new TypeError(`causeのsource IDがtransportにありません。対象: ${source.sourceId}`);
      }
    }
  }
}

/** 未検証値から個人催促AI入力を作成する。 */
export function createPersonalReminderAiInput(value: unknown): PersonalReminderAiInput {
  const parsed = personalReminderAiInputSchema.parse(value);
  validateTransportInputIntegrity(parsed);
  return parsed;
}

/** 個人催促AI入力をcanonical JSONへ直列化する。 */
export function serializePersonalReminderAiInput(input: PersonalReminderAiInput): string {
  return `${serializeCanonicalJson(createPersonalReminderAiInput(input))}\n`;
}

/** 採用済みassessmentを再利用するか、causeをAI評価へ送るか決める。 */
export function planPersonalReminderCauseEvaluation(
  input: Readonly<{
    cause: PersonalReminderCause;
    currentInput: Readonly<{
      fingerprint: AiAnalysisElementInputFingerprint;
      rulesVersion: typeof PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION;
      completeness: PersonalReminderInputCompleteness;
    }>;
    semanticInput: PersonalReminderCauseSemanticInput;
  }>,
):
  | Readonly<{ status: "reuse"; assessment: PersonalReminderCauseAssessment }>
  | Readonly<{ status: "evaluate"; input: PersonalReminderCauseSemanticInput }> {
  const semanticInput = createPersonalReminderCauseSemanticInput(input.semanticInput);
  const fingerprint = createPersonalReminderCauseInputFingerprint(semanticInput);
  const adopted = input.cause.adoptedAssessment;
  if (
    input.currentInput.fingerprint === fingerprint &&
    adopted.status === "available" &&
    adopted.inputFingerprint === fingerprint &&
    adopted.rulesVersion === input.currentInput.rulesVersion
  ) {
    return Object.freeze({
      status: "reuse",
      assessment: adopted.result,
    });
  }
  return Object.freeze({
    status: "evaluate",
    input: semanticInput,
  });
}

/** 同じitemの原因入力を一つの専用AI batchへまとめる。 */
export function preparePersonalReminderAiBatch(
  inputs: readonly [PersonalReminderCauseSemanticInput, ...PersonalReminderCauseSemanticInput[]],
): PersonalReminderAiBatchPreparation {
  if (inputs.length === 0) {
    throw new TypeError("個人催促AI batchの原因がありません");
  }
  const normalizedInputs = inputs
    .map((value) => createPersonalReminderCauseSemanticInput(value))
    .sort((left, right) => compareStrings(left.cause.causeId, right.cause.causeId));
  const transport = createTransportInput(normalizedInputs);
  if (transport.status === "over_capacity") {
    return transport;
  }
  const normalizedInput = serializePersonalReminderAiInput(transport.input);
  const batchInputFingerprint = hashCanonicalJson(transport.input);
  return Object.freeze({
    status: "prepared",
    batch: Object.freeze({
      id: `personal-reminder-batch:${batchInputFingerprint}`,
      itemNodeId: transport.itemNodeId,
      input: transport.input,
      normalizedInput,
      inputCharacters: countUnicodeCharacters(normalizedInput),
      batchInputFingerprint,
      refs: transport.refs,
      causeInputs: transport.causeInputs,
    }),
  });
}

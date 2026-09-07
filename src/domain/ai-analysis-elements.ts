import { z } from "zod";

import { createUtcIsoDateTime } from "./types.js";

const sha256FingerprintPattern = /^sha256:[0-9a-f]{64}$/u;

/** AI分析要素の識別子schema。 */
export const aiAnalysisElementSchema = z.enum([
  "status",
  "waitingOn",
  "nextAction",
  "relations",
  "progress",
  "importance",
  "deadline",
  "notification",
]);

/** AI分析要素の識別子一覧。 */
export const AI_ANALYSIS_ELEMENTS = Object.freeze(aiAnalysisElementSchema.options);

/** AI分析要素出力のschema version。 */
export const AI_ANALYSIS_ELEMENT_SCHEMA_VERSION = "5";

/** AI分析要素の識別子。 */
export type AiAnalysisElement = z.output<typeof aiAnalysisElementSchema>;

/** AI分析要素の識別子の別名。 */
export type AnalysisElement = AiAnalysisElement;

/** AI分析要素の必要性schema。 */
export const aiAnalysisElementNecessitySchema = z.enum(["required", "not_required"]);

/** AI分析要素の必要性。 */
export type AiAnalysisElementNecessity = z.output<typeof aiAnalysisElementNecessitySchema>;

/** AI分析要素のfingerprintを検証するschema。 */
export const aiAnalysisElementFingerprintSchema = z
  .string()
  .regex(sha256FingerprintPattern, "fingerprintはSHA-256 hashにしてください");

/** AI分析要素の入力fingerprint。 */
export type AiAnalysisElementInputFingerprint = z.output<typeof aiAnalysisElementFingerprintSchema>;

/** AI分析要素の実行条件fingerprint。 */
export type AiAnalysisElementExecutionFingerprint = AiAnalysisElementInputFingerprint;

/** AI分析要素のrevisionを検証するschema。 */
export const aiAnalysisElementRevisionSchema = z
  .number()
  .int()
  .positive("revisionは正の整数にしてください");

/** AI実行で指定するreasoning effort schema。 */
export const aiAnalysisReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** AI実行で指定するreasoning effort。 */
export type AiAnalysisReasoningEffort = z.output<typeof aiAnalysisReasoningEffortSchema>;

/** AI分析要素に属する根拠schema。 */
export const aiAnalysisElementEvidenceSchema = z.strictObject({
  sourceId: z
    .string()
    .min(1, "source IDは空にできません")
    .regex(/^\S+$/u, "source IDに空白は使えません"),
  summary: z.string().min(1, "根拠のsummaryは空にできません").max(240),
});

/** AI分析要素に属する根拠。 */
export type AiAnalysisElementEvidence = z.output<typeof aiAnalysisElementEvidenceSchema>;

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

/** status要素の値schema。 */
export const aiAnalysisStatusSchema = statusSchema;

/** status要素の値。 */
export type AiAnalysisStatus = z.output<typeof aiAnalysisStatusSchema>;

const waitingOnKindSchema = z.enum(["user", "team", "role", "item", "automation", "unknown"]);
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

/** waitingOn要素の候補種別schema。 */
export const aiAnalysisWaitingOnKindSchema = waitingOnKindSchema;

/** waitingOn要素の候補種別。 */
export type AiAnalysisWaitingOnKind = z.output<typeof aiAnalysisWaitingOnKindSchema>;

/** waitingOn要素の候補役割schema。 */
export const aiAnalysisWaitingOnRoleSchema = waitingOnRoleSchema;

/** waitingOn要素の候補役割。 */
export type AiAnalysisWaitingOnRole = z.output<typeof aiAnalysisWaitingOnRoleSchema>;

const waitingOnCandidateSchema = z.strictObject({
  kind: waitingOnKindSchema,
  candidateId: z.string().min(1).max(300).regex(/^\S+$/u, "candidate IDに空白は使えません"),
  role: waitingOnRoleSchema,
  reasonSummary: z.string().min(1).max(300),
  sourceIds: z
    .array(z.string().min(1).regex(/^\S+$/u, "source IDに空白は使えません"))
    .min(1)
    .max(10),
  confidence: z.number().min(0).max(1),
});

/** waitingOn要素の値schema。 */
export const aiAnalysisWaitingOnSchema = z.array(waitingOnCandidateSchema).max(20);

/** waitingOn要素の候補。 */
export type AiAnalysisWaitingOn = z.output<typeof waitingOnCandidateSchema>;

/** waitingOn要素の値。 */
export type AiAnalysisWaitingOnValue = z.output<typeof aiAnalysisWaitingOnSchema>;

const migrationWaitingOnCandidateSchema = waitingOnCandidateSchema.extend({
  sourceIds: z.array(z.string().min(1).regex(/^\S+$/u, "source IDに空白は使えません")).min(1),
});

/** 移行済みwaitingOn要素の値schema。 */
export const aiAnalysisMigrationWaitingOnSchema = z
  .array(migrationWaitingOnCandidateSchema)
  .max(20);

/** 移行済みwaitingOn要素の値。 */
export type AiAnalysisMigrationWaitingOnValue = z.output<typeof aiAnalysisMigrationWaitingOnSchema>;

/** nextAction要素の値schema。 */
export const aiAnalysisNextActionSchema = z.string().min(1).max(300);

/** nextAction要素の値。 */
export type AiAnalysisNextAction = z.output<typeof aiAnalysisNextActionSchema>;

const relationVerdictSchema = z.enum([
  "current_is_blocked_by_target",
  "current_blocks_target",
  "current_implements_target",
  "target_is_subtask_of_current",
  "current_is_subtask_of_target",
  "duplicates",
  "related",
  "none",
]);

/** relations要素の判定値schema。 */
export const aiAnalysisRelationVerdictSchema = relationVerdictSchema;

/** relations要素の判定値。 */
export type AiAnalysisRelationVerdict = z.output<typeof aiAnalysisRelationVerdictSchema>;

const relationCandidateSchema = z.strictObject({
  candidateId: z.string().min(1).regex(/^\S+$/u, "candidate IDに空白は使えません"),
  verdict: relationVerdictSchema,
  reasonSummary: z.string().min(1).max(300),
  sourceIds: z
    .array(z.string().min(1).regex(/^\S+$/u, "source IDに空白は使えません"))
    .min(1)
    .max(10),
  confidence: z.number().min(0).max(1),
});

/** relations要素の値schema。 */
export const aiAnalysisRelationsSchema = z.array(relationCandidateSchema).max(100);

/** relations要素の候補。 */
export type AiAnalysisRelation = z.output<typeof relationCandidateSchema>;

/** relations要素の値。 */
export type AiAnalysisRelations = z.output<typeof aiAnalysisRelationsSchema>;

const progressValueSchema = z.strictObject({
  latestMeaningfulSourceId: z.union([
    z.string().min(1).regex(/^\S+$/u, "source IDに空白は使えません"),
    z.null(),
  ]),
  reasonSummary: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

/** progress要素の値schema。 */
export const aiAnalysisProgressSchema = progressValueSchema;

/** progress要素の値。 */
export type AiAnalysisProgress = z.output<typeof aiAnalysisProgressSchema>;

const importanceValueSchema = z.strictObject({
  significantFeature: z.boolean(),
  futureRisk: z.boolean(),
  rationale: z.string().min(1).max(120),
});

/** importance要素の値schema。 */
export const aiAnalysisImportanceSchema = importanceValueSchema;

/** importance要素の値。 */
export type AiAnalysisImportance = z.output<typeof aiAnalysisImportanceSchema>;

const deadlineValueSchema = z.strictObject({
  date: z.union([z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u), z.null()]),
  rationale: z.string().min(1).max(120),
});

/** deadline要素の値schema。 */
export const aiAnalysisDeadlineSchema = deadlineValueSchema;

/** deadline要素の値。 */
export type AiAnalysisDeadline = z.output<typeof aiAnalysisDeadlineSchema>;

const notificationReasonCodeSchema = z.enum([
  "none",
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

/** notification要素の理由コードschema。 */
export const aiAnalysisNotificationReasonCodeSchema = notificationReasonCodeSchema;

/** notification要素の理由コード。 */
export type AiAnalysisNotificationReasonCode = z.output<
  typeof aiAnalysisNotificationReasonCodeSchema
>;

const notificationValueSchema = z.strictObject({
  recommended: z.boolean(),
  reasonCode: notificationReasonCodeSchema,
  reasonSummary: z.string().max(240),
});

/** notification要素の値schema。 */
export const aiAnalysisNotificationSchema = notificationValueSchema;

/** notification要素の値。 */
export type AiAnalysisNotification = z.output<typeof aiAnalysisNotificationSchema>;

const aiAnalysisElementValueSchemas = {
  status: aiAnalysisStatusSchema,
  waitingOn: aiAnalysisWaitingOnSchema,
  nextAction: aiAnalysisNextActionSchema,
  relations: aiAnalysisRelationsSchema,
  progress: aiAnalysisProgressSchema,
  importance: aiAnalysisImportanceSchema,
  deadline: aiAnalysisDeadlineSchema,
  notification: aiAnalysisNotificationSchema,
};

/** 要素ごとの値schemaを取得する。 */
export function createAiAnalysisElementValueSchema<Element extends AiAnalysisElement>(
  element: Element,
): (typeof aiAnalysisElementValueSchemas)[Element] {
  return aiAnalysisElementValueSchemas[element];
}

type AiAnalysisElementValueByElement = {
  [Element in AiAnalysisElement]: z.output<(typeof aiAnalysisElementValueSchemas)[Element]>;
};

/** 要素名に対応する値の型。 */
export type AiAnalysisElementValue<Element extends AiAnalysisElement = AiAnalysisElement> =
  AiAnalysisElementValueByElement[Element];

const aiAnalysisElementResultEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema)
  .min(1)
  .max(30);
const aiAnalysisMigrationElementResultEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema)
  .min(1);

function createElementResultSchema<ValueSchema extends z.ZodType, EvidenceSchema extends z.ZodType>(
  valueSchema: ValueSchema,
  evidenceSchema: EvidenceSchema,
) {
  return z.strictObject({
    value: valueSchema,
    evidence: evidenceSchema,
    confidence: z.number().min(0).max(1),
    uncertainties: z.array(z.string().min(1).max(240)).max(20),
  });
}

const aiAnalysisElementResultSchemas = {
  status: createElementResultSchema(aiAnalysisStatusSchema, aiAnalysisElementResultEvidenceSchema),
  waitingOn: createElementResultSchema(
    aiAnalysisWaitingOnSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
  nextAction: createElementResultSchema(
    aiAnalysisNextActionSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
  relations: createElementResultSchema(
    aiAnalysisRelationsSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
  progress: createElementResultSchema(
    aiAnalysisProgressSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
  importance: createElementResultSchema(
    aiAnalysisImportanceSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
  deadline: createElementResultSchema(
    aiAnalysisDeadlineSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
  notification: createElementResultSchema(
    aiAnalysisNotificationSchema,
    aiAnalysisElementResultEvidenceSchema,
  ),
};

/** 要素ごとのresult schemaを取得する。 */
export function createAiAnalysisElementResultSchema<Element extends AiAnalysisElement>(
  element: Element,
): (typeof aiAnalysisElementResultSchemas)[Element] {
  return aiAnalysisElementResultSchemas[element];
}

type AiAnalysisElementResultByElement = {
  [Element in AiAnalysisElement]: z.output<(typeof aiAnalysisElementResultSchemas)[Element]>;
};

/** 要素の値と根拠、confidence、不確実な点。 */
export type AiAnalysisElementResult<Element extends AiAnalysisElement = AiAnalysisElement> =
  AiAnalysisElementResultByElement[Element];

const aiAnalysisMigrationElementResultSchemas = {
  status: createElementResultSchema(
    aiAnalysisStatusSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  waitingOn: createElementResultSchema(
    aiAnalysisMigrationWaitingOnSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  nextAction: createElementResultSchema(
    aiAnalysisNextActionSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  relations: createElementResultSchema(
    aiAnalysisRelationsSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  progress: createElementResultSchema(
    aiAnalysisProgressSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  importance: createElementResultSchema(
    aiAnalysisImportanceSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  deadline: createElementResultSchema(
    aiAnalysisDeadlineSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
  notification: createElementResultSchema(
    aiAnalysisNotificationSchema,
    aiAnalysisMigrationElementResultEvidenceSchema,
  ),
};

/** 移行後のruntimeで利用する要素別result schemaを取得する。 */
export function createAiAnalysisMigrationElementResultSchema<Element extends AiAnalysisElement>(
  element: Element,
): (typeof aiAnalysisMigrationElementResultSchemas)[Element] {
  return aiAnalysisMigrationElementResultSchemas[element];
}

type AiAnalysisElementMigrationResultByElement = {
  [Element in AiAnalysisElement]: z.output<
    (typeof aiAnalysisMigrationElementResultSchemas)[Element]
  >;
};

/** 移行後のruntimeで利用する要素の値と根拠、confidence、不確実な点。 */
export type AiAnalysisElementMigrationResult<
  Element extends AiAnalysisElement = AiAnalysisElement,
> = AiAnalysisElementMigrationResultByElement[Element];

/** 要素別resultのいずれかを検証するschema。 */
export const aiAnalysisElementResultSchema = z.union([
  aiAnalysisElementResultSchemas.status,
  aiAnalysisElementResultSchemas.waitingOn,
  aiAnalysisElementResultSchemas.nextAction,
  aiAnalysisElementResultSchemas.relations,
  aiAnalysisElementResultSchemas.progress,
  aiAnalysisElementResultSchemas.importance,
  aiAnalysisElementResultSchemas.deadline,
  aiAnalysisElementResultSchemas.notification,
]);

const generationMetadataShape = {
  model: z
    .string()
    .min(1, "modelは空にできません")
    .max(512, "modelが長すぎます")
    .regex(/^\S+$/u, "modelに空白は使えません"),
  reasoningEffort: aiAnalysisReasoningEffortSchema,
  backendVersion: z
    .string()
    .min(1, "backendVersionは空にできません")
    .max(512, "backendVersionが長すぎます")
    .regex(/^\S+$/u, "backendVersionに空白は使えません"),
  schemaVersion: z.literal(AI_ANALYSIS_ELEMENT_SCHEMA_VERSION),
  revision: aiAnalysisElementRevisionSchema,
  inputFingerprint: aiAnalysisElementFingerprintSchema,
  executionFingerprint: aiAnalysisElementFingerprintSchema,
  promptFingerprint: aiAnalysisElementFingerprintSchema,
  outputHash: aiAnalysisElementFingerprintSchema,
  generatedAt: z.iso
    .datetime({
      offset: true,
      error: "タイムゾーンを含むISO 8601日時を指定してください",
    })
    .transform((value) => createUtcIsoDateTime(value)),
};

/** 要素別AI判定を再現する生成metadata schema。 */
export const aiAnalysisElementMetadataSchema = z.strictObject(generationMetadataShape);

/** 要素別AI判定を再現する生成metadata。 */
export type AiAnalysisElementMetadata = z.output<typeof aiAnalysisElementMetadataSchema>;

const aiAnalysisElementGenerationSchemas = {
  status: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.status,
  }),
  waitingOn: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.waitingOn,
  }),
  nextAction: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.nextAction,
  }),
  relations: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.relations,
  }),
  progress: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.progress,
  }),
  importance: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.importance,
  }),
  deadline: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.deadline,
  }),
  notification: z.strictObject({
    metadata: aiAnalysisElementMetadataSchema,
    result: aiAnalysisElementResultSchemas.notification,
  }),
};

/** 要素ごとのgeneration schemaを取得する。 */
export function createAiAnalysisElementGenerationSchema<Element extends AiAnalysisElement>(
  element: Element,
): (typeof aiAnalysisElementGenerationSchemas)[Element] {
  return aiAnalysisElementGenerationSchemas[element];
}

type AiAnalysisElementGenerationByElement = {
  [Element in AiAnalysisElement]: z.output<(typeof aiAnalysisElementGenerationSchemas)[Element]>;
};

/** 要素別AI判定の生成記録。 */
export type AiAnalysisElementGeneration<Element extends AiAnalysisElement = AiAnalysisElement> =
  AiAnalysisElementGenerationByElement[Element];

/** 要素別generationのいずれかを検証するschema。 */
export const aiAnalysisElementGenerationSchema = z.union([
  aiAnalysisElementGenerationSchemas.status,
  aiAnalysisElementGenerationSchemas.waitingOn,
  aiAnalysisElementGenerationSchemas.nextAction,
  aiAnalysisElementGenerationSchemas.relations,
  aiAnalysisElementGenerationSchemas.progress,
  aiAnalysisElementGenerationSchemas.importance,
  aiAnalysisElementGenerationSchemas.deadline,
  aiAnalysisElementGenerationSchemas.notification,
]);

/** 未検証値から要素別AI判定の生成記録を作成する。 */
export function createAiAnalysisElementGeneration(value: unknown): AiAnalysisElementGeneration {
  return aiAnalysisElementGenerationSchema.parse(value);
}

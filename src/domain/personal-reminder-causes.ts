import { z } from "zod";

import {
  aiAnalysisElementFingerprintSchema,
  aiAnalysisElementMetadataSchema,
} from "./ai-analysis-elements.js";
import {
  type AiCacheEntryId,
  type GitHubNodeId,
  type GraphNodeId,
  createUtcIsoDateTime,
  type WaitingOnRole,
} from "./types.js";
import { type NotificationTimeReasonCode } from "./notification-reason.js";

const opaqueIdSchema = z
  .string()
  .min(1, "IDは空にできません")
  .max(512, "IDが長すぎます")
  .regex(/^\S+$/u, "IDに空白は使えません");

const sourceIdSchema = z
  .string()
  .min(3, "source IDは短すぎます")
  .max(512, "source IDが長すぎます")
  .regex(/^\S+$/u, "source IDに空白は使えません")
  .brand<"SourceId">();

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

const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => createUtcIsoDateTime(value));

const aiCacheEntryIdSchema = z.custom<AiCacheEntryId>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  "AI cache entry IDはSHA-256形式にしてください",
);

/** 個人催促原因を識別するID。 */
export const personalReminderCauseIdSchema = opaqueIdSchema.brand<"PersonalReminderCauseId">();

/** 個人催促の責務期間を識別するID。 */
export const personalReminderResponsibilityIdSchema =
  opaqueIdSchema.brand<"PersonalReminderResponsibilityId">();

/** 個人催促原因を識別するID。 */
export type PersonalReminderCauseId = z.output<typeof personalReminderCauseIdSchema>;

/** 個人催促の責務期間を識別するID。 */
export type PersonalReminderResponsibilityId = z.output<
  typeof personalReminderResponsibilityIdSchema
>;

/** 個人催促の対象となる行動種別。 */
export const personalReminderActionKindSchema = z.enum([
  "assessment",
  "owner",
  "decision",
  "review",
  "revision",
  "reply",
  "work",
  "merge",
]);

/** 個人催促の対象となる行動種別。 */
export type PersonalReminderActionKind = z.output<typeof personalReminderActionKindSchema>;

/** 個人催促原因に使う時間系の理由コードschema。 */
export const personalReminderReasonCodeSchema = z.enum([
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "work_overdue",
  "merge_overdue",
]);

/** 個人催促原因に使う時間系の理由コード。 */
export type PersonalReminderReasonCode = Exclude<NotificationTimeReasonCode, "automation_stuck">;

const personalReminderResponsibleKindSchema = z.enum(["user", "team", "role"]);
const personalReminderResponsibleRoleSchema = z.enum([
  "author",
  "maintainer",
  "reviewer",
  "assignee",
  "respondent",
  "merge_decider",
  "unknown",
] satisfies readonly Exclude<WaitingOnRole, "dependency" | "ci">[]);

/** 個人催促の責任主体。 */
export const personalReminderResponsibleSchema = z.strictObject({
  kind: personalReminderResponsibleKindSchema,
  candidateId: opaqueIdSchema,
  role: personalReminderResponsibleRoleSchema,
});

/** 個人催促の責任主体。 */
export type PersonalReminderResponsible = z.output<typeof personalReminderResponsibleSchema>;

/** 義務や実行可能性の時刻を特定する根拠。 */
export const personalReminderTimeBasisSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("event"),
    at: utcIsoDateTimeSchema,
    sourceIds: z.array(sourceIdSchema).nonempty().max(30),
  }),
  z.strictObject({
    source: z.literal("first_observation"),
    at: utcIsoDateTimeSchema,
  }),
]);

/** 義務や実行可能性の時刻を特定する根拠。 */
export type PersonalReminderTimeBasis = z.output<typeof personalReminderTimeBasisSchema>;

/** 個人催促原因の初期識別情報。 */
export const personalReminderCauseSeedSchema = z.strictObject({
  causeId: personalReminderCauseIdSchema,
  responsibilityId: personalReminderResponsibilityIdSchema,
  itemNodeId: githubNodeIdSchema,
  reasonCode: personalReminderReasonCodeSchema,
  responsible: z.array(personalReminderResponsibleSchema).nonempty().max(20),
  action: z.strictObject({
    kind: personalReminderActionKindSchema,
    summary: z.string().min(1).max(300),
  }),
  evidenceSourceIds: z.array(sourceIdSchema).nonempty().max(30),
  obligationSince: personalReminderTimeBasisSchema,
});

/** 個人催促原因の初期識別情報。 */
export type PersonalReminderCauseSeed = z.output<typeof personalReminderCauseSeedSchema>;

/** 個人催促原因の意味判定が参照した情報。 */
export const personalReminderAssessmentReferencesSchema = z.strictObject({
  nodeIds: z.array(graphNodeIdSchema).max(100),
  relationIds: z.array(opaqueIdSchema).max(100),
  sourceIds: z.array(sourceIdSchema).max(100),
  reasonSummary: z.string().min(1).max(300),
});

/** 個人催促原因の意味判定が参照した情報。 */
export type PersonalReminderAssessmentReferences = z.output<
  typeof personalReminderAssessmentReferencesSchema
>;

/** 個人催促原因の意味判定で不足している入力。 */
export const personalReminderMissingInputSchema = z.string().min(1).max(120);

/** 個人催促原因の意味判定で不足している入力。 */
export type PersonalReminderMissingInput = z.output<typeof personalReminderMissingInputSchema>;

/** 個人催促原因の意味判定へ渡した入力の完全性。 */
export const personalReminderInputCompletenessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
  }),
  z.strictObject({
    status: z.literal("incomplete"),
    missing: z.array(personalReminderMissingInputSchema).nonempty().max(30),
  }),
]);

/** 個人催促原因の意味判定へ渡した入力の完全性。 */
export type PersonalReminderInputCompleteness = z.output<
  typeof personalReminderInputCompletenessSchema
>;

const personalReminderUnknownReasonSchema = z.enum([
  "incomplete_input",
  "conflicting_evidence",
  "ambiguous_meaning",
]);

/** 個人催促原因の意味判定結果。 */
export const personalReminderCauseAssessmentSchema = z.discriminatedUnion("verdict", [
  z.strictObject({
    verdict: z.literal("actionable"),
    references: personalReminderAssessmentReferencesSchema,
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    verdict: z.literal("waiting"),
    waitingFor: z.strictObject({
      itemNodeId: graphNodeIdSchema,
      action: z.string().min(1).max(300),
    }),
    references: personalReminderAssessmentReferencesSchema,
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    verdict: z.literal("duplicate"),
    canonicalCauseId: personalReminderCauseIdSchema,
    references: personalReminderAssessmentReferencesSchema,
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    verdict: z.literal("not_required"),
    references: personalReminderAssessmentReferencesSchema,
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    verdict: z.literal("unknown"),
    reason: personalReminderUnknownReasonSchema,
    references: personalReminderAssessmentReferencesSchema,
    confidence: z.number().min(0).max(1),
  }),
]);

/** 個人催促原因の意味判定結果。 */
export type PersonalReminderCauseAssessment = z.output<
  typeof personalReminderCauseAssessmentSchema
>;

/** 個人催促原因の延期理由。 */
export const personalReminderDeferredReasonSchema = z.enum([
  "upstream_relation",
  "item_input_character_limit",
  "call_limit",
  "total_input_character_limit",
  "estimated_cost_limit",
]);

/** 個人催促原因の延期理由。 */
export type PersonalReminderDeferredReason = z.output<typeof personalReminderDeferredReasonSchema>;

/** 個人催促原因の評価を生成した経路。 */
export const personalReminderEvaluationOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("deterministic"),
    rulesVersion: opaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal("ai"),
    cacheEntryId: aiCacheEntryIdSchema,
    metadata: aiAnalysisElementMetadataSchema,
  }),
]);

/** 個人催促原因の評価を生成した経路。 */
export type PersonalReminderEvaluationOrigin = z.output<
  typeof personalReminderEvaluationOriginSchema
>;

/** 個人催促原因の最新評価試行。 */
export const personalReminderEvaluationAttemptSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_evaluated"),
  }),
  z.strictObject({
    status: z.literal("completed"),
    inputFingerprint: aiAnalysisElementFingerprintSchema,
    completedAt: utcIsoDateTimeSchema,
    origin: personalReminderEvaluationOriginSchema,
  }),
  z.strictObject({
    status: z.literal("failed"),
    inputFingerprint: aiAnalysisElementFingerprintSchema,
    failedAt: utcIsoDateTimeSchema,
    reason: z.string().min(1).max(300),
  }),
  z.strictObject({
    status: z.literal("deferred"),
    inputFingerprint: aiAnalysisElementFingerprintSchema,
    deferredAt: utcIsoDateTimeSchema,
    reason: personalReminderDeferredReasonSchema,
  }),
]);

/** 個人催促原因の最新評価試行。 */
export type PersonalReminderEvaluationAttempt = z.output<
  typeof personalReminderEvaluationAttemptSchema
>;

/** 個人催促原因へ採用した意味判定。 */
export const personalReminderAdoptedAssessmentSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z.strictObject({
    status: z.literal("available"),
    inputFingerprint: aiAnalysisElementFingerprintSchema,
    rulesVersion: opaqueIdSchema,
    result: personalReminderCauseAssessmentSchema,
    origin: personalReminderEvaluationOriginSchema,
  }),
]);

/** 個人催促原因へ採用した意味判定。 */
export type PersonalReminderAdoptedAssessment = z.output<
  typeof personalReminderAdoptedAssessmentSchema
>;

/** 個人催促原因の実行可能性時計。 */
export const personalReminderActionableClockSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_observed"),
  }),
  z.strictObject({
    status: z.literal("observed"),
    actionableSince: personalReminderTimeBasisSchema,
    stallSince: personalReminderTimeBasisSchema,
    basis: z.enum(["obligation", "dependency_resolved", "first_observation"]),
  }),
]);

/** 個人催促原因の実行可能性時計。 */
export type PersonalReminderActionableClock = z.output<
  typeof personalReminderActionableClockSchema
>;

const personalReminderReasonToAction: Readonly<
  Record<PersonalReminderReasonCode, PersonalReminderActionKind>
> = {
  assessment_overdue: "assessment",
  owner_overdue: "owner",
  decision_overdue: "decision",
  review_overdue: "review",
  revision_overdue: "revision",
  reply_overdue: "reply",
  work_overdue: "work",
  merge_overdue: "merge",
};

/** 個人催促原因の保存schema。 */
export const personalReminderCauseSchema = personalReminderCauseSeedSchema
  .extend({
    currentInput: z.strictObject({
      fingerprint: aiAnalysisElementFingerprintSchema,
      rulesVersion: opaqueIdSchema,
      completeness: personalReminderInputCompletenessSchema,
    }),
    latestAttempt: personalReminderEvaluationAttemptSchema,
    adoptedAssessment: personalReminderAdoptedAssessmentSchema,
    actionableClock: personalReminderActionableClockSchema,
  })
  .superRefine((cause, context) => {
    if (personalReminderReasonToAction[cause.reasonCode] !== cause.action.kind) {
      context.addIssue({
        code: "custom",
        path: ["action", "kind"],
        message: "個人催促原因の理由コードと行動種別が一致しません",
      });
    }
  });

/** 個人催促原因。 */
export type PersonalReminderCause = z.output<typeof personalReminderCauseSchema>;

/** 現在の入力と規則へ適合する採用済み意味判定。 */
export type CurrentPersonalReminderAssessment =
  | Readonly<{
      status: "available";
      result: PersonalReminderCauseAssessment;
    }>
  | Readonly<{
      status: "not_available";
    }>;

/** 現在の入力と規則へ適合する採用済み意味判定を取得する。 */
export function currentPersonalReminderAssessment(
  cause: PersonalReminderCause,
): CurrentPersonalReminderAssessment {
  if (cause.adoptedAssessment.status === "not_available") {
    return Object.freeze({ status: "not_available" });
  }
  if (
    cause.adoptedAssessment.inputFingerprint !== cause.currentInput.fingerprint ||
    cause.adoptedAssessment.rulesVersion !== cause.currentInput.rulesVersion
  ) {
    return Object.freeze({ status: "not_available" });
  }
  return Object.freeze({
    status: "available",
    result: cause.adoptedAssessment.result,
  });
}

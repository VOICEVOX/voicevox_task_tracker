import { z } from "zod";

import {
  personalReminderCauseIdSchema,
  PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
} from "../domain/personal-reminder-causes.js";
import {
  personalReminderItemRefSchema,
  personalReminderRelationRefSchema,
  personalReminderSourceRefSchema,
} from "./personal-reminder-input.js";

export { PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION } from "../domain/personal-reminder-causes.js";

/** 個人催促AI出力schemaの公開識別子。 */
export const PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_ID =
  "https://voicevox.github.io/voicevox_task_tracker/schemas/personal-reminder-output.schema.json";

/** 個人催促AI出力JSON Schemaの型。 */
export type PersonalReminderAiOutputJsonSchema = Readonly<Record<string, unknown>>;

const referencesSchema = z.strictObject({
  itemRefs: z.array(personalReminderItemRefSchema).max(100),
  relationRefs: z.array(personalReminderRelationRefSchema).max(100),
  sourceRefs: z.array(personalReminderSourceRefSchema).max(100),
  reasonSummary: z.string().min(1).max(300),
});

const confidenceSchema = z.number().min(0).max(1);

const personalReminderRawAssessmentSchema = z.discriminatedUnion("verdict", [
  z.strictObject({
    verdict: z.literal("actionable"),
    references: referencesSchema,
    confidence: confidenceSchema,
  }),
  z.strictObject({
    verdict: z.literal("waiting"),
    optionId: z.string().min(1).max(512).regex(/^\S+$/u),
    references: referencesSchema,
    confidence: confidenceSchema,
  }),
  z.strictObject({
    verdict: z.literal("duplicate"),
    canonicalCauseId: personalReminderCauseIdSchema,
    references: referencesSchema,
    confidence: confidenceSchema,
  }),
  z.strictObject({
    verdict: z.literal("not_required"),
    references: referencesSchema,
    confidence: confidenceSchema,
  }),
  z.strictObject({
    verdict: z.literal("unknown"),
    reason: z.enum(["incomplete_input", "conflicting_evidence", "ambiguous_meaning"]),
    references: referencesSchema,
    confidence: confidenceSchema,
  }),
]);

/** 個人催促AI出力の共通構造を検証するschema。 */
export const personalReminderAiOutputStructureSchema = z.strictObject({
  schemaVersion: z.literal(PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION),
  item: z.strictObject({
    nodeId: z.string().min(1).max(512).regex(/^\S+$/u),
    url: z.string().regex(/^https?:\/\/\S+$/u),
  }),
  causes: z
    .array(
      z.strictObject({
        causeId: personalReminderCauseIdSchema,
        assessment: personalReminderRawAssessmentSchema,
      }),
    )
    .min(1)
    .max(100),
});

/** 個人催促AI出力のJSON Schemaを作成する。 */
export function createPersonalReminderAiOutputSchema(): PersonalReminderAiOutputJsonSchema {
  const jsonSchema = z.toJSONSchema(personalReminderAiOutputStructureSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });
  return Object.freeze({
    ...jsonSchema,
    $id: PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_ID,
  });
}

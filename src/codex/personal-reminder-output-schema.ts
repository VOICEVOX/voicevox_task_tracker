import { PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION } from "../domain/personal-reminder-causes.js";

export { PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION } from "../domain/personal-reminder-causes.js";

/** 個人催促AI出力schemaの公開識別子。 */
export const PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_ID =
  "https://voicevox.github.io/voicevox_task_tracker/schemas/personal-reminder-output.schema.json";

/** 個人催促AI出力JSON Schemaの型。 */
export type PersonalReminderAiOutputJsonSchema = Readonly<Record<string, unknown>>;

const jsonSchemaDraft = "https://json-schema.org/draft/2020-12/schema";

const referenceSchema: PersonalReminderAiOutputJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["itemRefs", "relationRefs", "sourceRefs", "reasonSummary"],
  properties: {
    itemRefs: {
      type: "array",
      maxItems: 100,
      items: {
        type: "string",
        pattern: "^item:[0-9]+$",
      },
    },
    relationRefs: {
      type: "array",
      maxItems: 100,
      items: {
        type: "string",
        pattern: "^relation:[0-9]+$",
      },
    },
    sourceRefs: {
      type: "array",
      maxItems: 100,
      items: {
        type: "string",
        pattern: "^source:[0-9]+$",
      },
    },
    reasonSummary: {
      type: "string",
      minLength: 1,
      maxLength: 300,
    },
  },
});

const confidenceSchema: PersonalReminderAiOutputJsonSchema = Object.freeze({
  type: "number",
  minimum: 0,
  maximum: 1,
});

const assessmentSchemas: Readonly<Record<string, PersonalReminderAiOutputJsonSchema>> = {
  actionable: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["verdict", "references", "confidence"],
    properties: {
      verdict: { const: "actionable" },
      references: referenceSchema,
      confidence: confidenceSchema,
    },
  }),
  waiting: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["verdict", "optionId", "references", "confidence"],
    properties: {
      verdict: { const: "waiting" },
      optionId: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        pattern: "^\\S+$",
      },
      references: referenceSchema,
      confidence: confidenceSchema,
    },
  }),
  duplicate: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["verdict", "canonicalCauseId", "references", "confidence"],
    properties: {
      verdict: { const: "duplicate" },
      canonicalCauseId: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        pattern: "^\\S+$",
      },
      references: referenceSchema,
      confidence: confidenceSchema,
    },
  }),
  not_required: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["verdict", "references", "confidence"],
    properties: {
      verdict: { const: "not_required" },
      references: referenceSchema,
      confidence: confidenceSchema,
    },
  }),
  unknown: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason", "references", "confidence"],
    properties: {
      verdict: { const: "unknown" },
      reason: {
        type: "string",
        enum: ["incomplete_input", "conflicting_evidence", "ambiguous_meaning"],
      },
      references: referenceSchema,
      confidence: confidenceSchema,
    },
  }),
};

/** 個人催促AI出力のJSON Schemaを作成する。 */
export function createPersonalReminderAiOutputSchema(): PersonalReminderAiOutputJsonSchema {
  return Object.freeze({
    $schema: jsonSchemaDraft,
    $id: PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_ID,
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "item", "causes"],
    properties: {
      schemaVersion: {
        const: PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
      },
      item: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "url"],
        properties: {
          nodeId: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            pattern: "^\\S+$",
          },
          url: {
            type: "string",
            pattern: "^https?://\\S+$",
          },
        },
      },
      causes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["causeId", "assessment"],
          properties: {
            causeId: {
              type: "string",
              minLength: 1,
              maxLength: 512,
              pattern: "^\\S+$",
            },
            assessment: {
              oneOf: Object.values(assessmentSchemas),
            },
          },
        },
      },
    },
  });
}

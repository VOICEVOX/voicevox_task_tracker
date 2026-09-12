import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { z } from "zod";

import { personalReminderCauseIdSchema } from "../domain/personal-reminder-causes.js";
import {
  personalReminderItemRefSchema,
  personalReminderRelationRefSchema,
  personalReminderSourceRefSchema,
} from "./personal-reminder-input.js";
import {
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  type CodexOutputValidationIssue,
} from "./errors.js";
import {
  createPersonalReminderAiOutputSchema,
  PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
  type PersonalReminderAiOutputJsonSchema,
} from "./personal-reminder-output-schema.js";

const referencesSchema = z.strictObject({
  itemRefs: z.array(personalReminderItemRefSchema).max(100),
  relationRefs: z.array(personalReminderRelationRefSchema).max(100),
  sourceRefs: z.array(personalReminderSourceRefSchema).max(100),
  reasonSummary: z.string().min(1).max(300),
});

/** 個人催促AIが返す根拠参照。 */
export type PersonalReminderRawReferences = z.output<typeof referencesSchema>;

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

/** 個人催促AIが返す原因単位の意味判定。 */
export type PersonalReminderRawAssessment = z.output<typeof personalReminderRawAssessmentSchema>;

const personalReminderAiOutputSchema = z.strictObject({
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

/** JSON Schema検証を通った個人催促AI出力。 */
export type SchemaValidPersonalReminderAiOutput = z.output<typeof personalReminderAiOutputSchema>;

function schemaIssueMessage(keyword: string): string {
  switch (keyword) {
    case "additionalProperties":
      return "許可されていないプロパティがあります";
    case "const":
      return "固定値と一致しません";
    case "enum":
      return "許可された値ではありません";
    case "minItems":
      return "配列の要素数が不足しています";
    case "maxItems":
      return "配列の要素数が上限を超えています";
    case "minLength":
      return "文字列が短すぎます";
    case "maxLength":
      return "文字列が長すぎます";
    case "minimum":
      return "数値が下限を下回っています";
    case "maximum":
      return "数値が上限を超えています";
    case "pattern":
      return "文字列の形式が契約と一致しません";
    case "required":
      return "必須プロパティがありません";
    case "type":
      return "値の型が契約と一致しません";
    default:
      return "JSON Schemaの制約に適合しません";
  }
}

function createSchemaIssues(errors: readonly ErrorObject[]): readonly CodexOutputValidationIssue[] {
  return Object.freeze(
    errors.map((error) =>
      Object.freeze({
        path: error.instancePath.length === 0 ? "$" : error.instancePath,
        code: error.keyword,
        message: schemaIssueMessage(error.keyword),
      }),
    ),
  );
}

function createZodIssues(error: z.ZodError): readonly CodexOutputValidationIssue[] {
  return Object.freeze(
    error.issues.map((issue) =>
      Object.freeze({
        path:
          issue.path.length === 0 ? "$" : `/${issue.path.map((part) => String(part)).join("/")}`,
        code: issue.code,
        message: "個人催促AI出力の値が契約に適合しません",
      }),
    ),
  );
}

function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  });
}

function parsePersonalReminderAiOutput(value: unknown): SchemaValidPersonalReminderAiOutput {
  const parsed = personalReminderAiOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new CodexOutputSchemaValidationError(createZodIssues(parsed.error));
  }
  return parsed.data;
}

/** 個人催促AI出力を専用JSON Schemaで検証する。 */
export function validatePersonalReminderAiOutputSchema(
  value: unknown,
): SchemaValidPersonalReminderAiOutput {
  const schema: PersonalReminderAiOutputJsonSchema = createPersonalReminderAiOutputSchema();
  const validateSchema = createAjv().compile(schema);
  if (!validateSchema(value)) {
    if (validateSchema.errors == null) {
      throw new TypeError("個人催促AI出力のJSON Schema検証が失敗しましたが問題を取得できません");
    }
    throw new CodexOutputSchemaValidationError(createSchemaIssues(validateSchema.errors));
  }
  return parsePersonalReminderAiOutput(value);
}

function createItemIdentityIssue(path: string): CodexOutputValidationIssue {
  return Object.freeze({
    path,
    code: "item_identity_mismatch",
    message: "個人催促AI出力のitem identityが入力対象と一致しません",
  });
}

/** 個人催促AI出力を構造とitem identityまで検証する。 */
export function validatePersonalReminderAiOutput(
  value: unknown,
  expectedItem: Readonly<{ nodeId: string; url: string }>,
): SchemaValidPersonalReminderAiOutput {
  const output = validatePersonalReminderAiOutputSchema(value);
  const issues: CodexOutputValidationIssue[] = [];
  if (output.item.nodeId !== expectedItem.nodeId) {
    issues.push(createItemIdentityIssue("/item/nodeId"));
  }
  if (output.item.url !== expectedItem.url) {
    issues.push(createItemIdentityIssue("/item/url"));
  }
  if (issues.length !== 0) {
    throw new CodexOutputSemanticValidationError(issues);
  }
  return output;
}

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { z } from "zod";

import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementEvidence,
  type AiAnalysisElementResult,
} from "../domain/ai-analysis-elements.js";
import {
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  createCodexElementOutputSchema,
  normalizeCodexElementSelection,
} from "./element-output-schema.js";
import {
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  type CodexOutputValidationIssue,
} from "./errors.js";

/** 要素に帰属する根拠。 */
export type CodexElementEvidence = AiAnalysisElementEvidence;

/** 要素の値と、その値に帰属する検証情報。 */
export type CodexElementResult<Element extends AiAnalysisElement = AiAnalysisElement> =
  AiAnalysisElementResult<Element>;

export { CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION } from "./element-output-schema.js";

const itemSchema = z.strictObject({
  nodeId: z.string().min(1),
  url: z.string().regex(/^https:\/\/github\.com\//u),
});

const codexElementOutputSchema = z.strictObject({
  schemaVersion: z.literal(CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION),
  item: itemSchema,
  status: createAiAnalysisElementResultSchema("status").optional(),
  waitingOn: createAiAnalysisElementResultSchema("waitingOn").optional(),
  nextAction: createAiAnalysisElementResultSchema("nextAction").optional(),
  relations: createAiAnalysisElementResultSchema("relations").optional(),
  progress: createAiAnalysisElementResultSchema("progress").optional(),
  importance: createAiAnalysisElementResultSchema("importance").optional(),
  deadline: createAiAnalysisElementResultSchema("deadline").optional(),
  notification: createAiAnalysisElementResultSchema("notification").optional(),
  selfCommitment: createAiAnalysisElementResultSchema("selfCommitment").optional(),
});

/** JSON Schema検証を通った要素別Codex出力。 */
export type SchemaValidCodexElementOutput = z.output<typeof codexElementOutputSchema>;

/** 指定した要素のresultを同じ値schemaで検証する。 */
export function parseCodexElementResult(
  value: unknown,
  element: AiAnalysisElement,
): AiAnalysisElementResult {
  const parsed = createAiAnalysisElementResultSchema(element).safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`AI判定要素のresultが不正です。対象: ${element}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function schemaIssueMessage(keyword: string): string {
  switch (keyword) {
    case "additionalProperties":
      return "許可されていないプロパティがあります";
    case "const":
      return "固定値と一致しません";
    case "enum":
      return "許可された値ではありません";
    case "maxItems":
      return "配列の要素数が上限を超えています";
    case "maxLength":
      return "文字列が長すぎます";
    case "maximum":
      return "数値が上限を超えています";
    case "minItems":
      return "配列の要素数が不足しています";
    case "minLength":
      return "文字列が短すぎます";
    case "minimum":
      return "数値が下限を下回っています";
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
        message: "要素別Codex出力の値が契約に適合しません",
      }),
    ),
  );
}

function parseElementOutput(value: unknown): SchemaValidCodexElementOutput {
  const parsed = codexElementOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new CodexOutputSchemaValidationError(createZodIssues(parsed.error));
  }
  return parsed.data;
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

/** 選択した要素だけを許可するJSON SchemaでCodex出力を検証する。 */
export function validateCodexElementOutputSchema(
  value: unknown,
  selectedElements: readonly AiAnalysisElement[],
): SchemaValidCodexElementOutput {
  const normalizedElements = normalizeCodexElementSelection(selectedElements);
  const validateSchema = createAjv().compile(createCodexElementOutputSchema(normalizedElements));
  if (!validateSchema(value)) {
    if (validateSchema.errors == null) {
      throw new TypeError("要素別Codex出力のJSON Schema検証が失敗しましたが問題を取得できません");
    }
    throw new CodexOutputSchemaValidationError(createSchemaIssues(validateSchema.errors));
  }
  return parseElementOutput(value);
}

type AnyElementResult = AiAnalysisElementResult;

function getElementResult(
  output: SchemaValidCodexElementOutput,
  element: AiAnalysisElement,
): AnyElementResult | undefined {
  switch (element) {
    case "status":
      return output.status;
    case "waitingOn":
      return output.waitingOn;
    case "nextAction":
      return output.nextAction;
    case "relations":
      return output.relations;
    case "progress":
      return output.progress;
    case "importance":
      return output.importance;
    case "deadline":
      return output.deadline;
    case "notification":
      return output.notification;
    case "selfCommitment":
      return output.selfCommitment;
    default:
      throw new TypeError("未知のAI判定要素です");
  }
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateSelectedElementKeys(
  output: SchemaValidCodexElementOutput,
  selectedElements: readonly AiAnalysisElement[],
  issues: CodexOutputValidationIssue[],
): void {
  const normalizedElements = normalizeCodexElementSelection(selectedElements);
  const selectedSet = new Set<string>(normalizedElements);
  const baseKeys = new Set(["schemaVersion", "item"]);

  for (const key of Object.keys(output)) {
    if (baseKeys.has(key)) {
      continue;
    }
    if (!selectedSet.has(key)) {
      issues.push({
        path: `/${key}`,
        code: "unselected_element_present",
        message: "選択されていないAI判定要素が返されています",
      });
    }
  }
  for (const element of normalizedElements) {
    if (!hasOwnProperty(output, element) || getElementResult(output, element) == null) {
      issues.push({
        path: `/${element}`,
        code: "selected_element_missing",
        message: "選択したAI判定要素が返されていません",
      });
    }
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (!selectedSet.has(element) && hasOwnProperty(output, element)) {
      issues.push({
        path: `/${element}`,
        code: "unselected_element_present",
        message: "選択されていないAI判定要素が返されています",
      });
    }
  }
}

function validateUniqueIds(
  values: readonly string[],
  path: string,
  issues: CodexOutputValidationIssue[],
): void {
  const used = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (used.has(value)) {
      issues.push({
        path: `${path}/${index.toString()}`,
        code: "duplicate_id",
        message: "同じIDが重複しています",
      });
    }
    used.add(value);
  }
}

function validateWaitingOnValue(
  result: NonNullable<SchemaValidCodexElementOutput["waitingOn"]>,
  issues: CodexOutputValidationIssue[],
): void {
  validateUniqueIds(
    result.value.map((value) => value.candidateId),
    "/waitingOn/value",
    issues,
  );
  for (const [index, value] of result.value.entries()) {
    validateUniqueIds(value.sourceIds, `/waitingOn/value/${index.toString()}/sourceIds`, issues);
  }
}

function validateRelationsValue(
  result: NonNullable<SchemaValidCodexElementOutput["relations"]>,
  issues: CodexOutputValidationIssue[],
): void {
  validateUniqueIds(
    result.value.map((value) => value.candidateId),
    "/relations/value",
    issues,
  );
  for (const [index, value] of result.value.entries()) {
    validateUniqueIds(value.sourceIds, `/relations/value/${index.toString()}/sourceIds`, issues);
  }
}

function validateSelfCommitmentValue(
  result: NonNullable<SchemaValidCodexElementOutput["selfCommitment"]>,
  issues: CodexOutputValidationIssue[],
): void {
  validateUniqueIds(
    result.value.map((value) => value.sourceId),
    "/selfCommitment/value",
    issues,
  );
}

/** 選択要素の帰属情報と要素集合をsemantic検証する。 */
export function validateCodexElementOutputSemantics(
  value: unknown,
  selectedElements: readonly AiAnalysisElement[],
): SchemaValidCodexElementOutput {
  const output = parseElementOutput(value);
  const issues: CodexOutputValidationIssue[] = [];
  validateSelectedElementKeys(output, selectedElements, issues);
  const normalizedElements = normalizeCodexElementSelection(selectedElements);
  if (normalizedElements.includes("waitingOn") && output.waitingOn != null) {
    validateWaitingOnValue(output.waitingOn, issues);
  }
  if (normalizedElements.includes("relations") && output.relations != null) {
    validateRelationsValue(output.relations, issues);
  }
  if (normalizedElements.includes("selfCommitment") && output.selfCommitment != null) {
    validateSelfCommitmentValue(output.selfCommitment, issues);
  }
  if (issues.length > 0) {
    throw new CodexOutputSemanticValidationError(issues);
  }
  return output;
}

/** 要素別Codex出力をJSON Schemaとsemantic制約で検証する。 */
export function validateCodexElementOutput(
  value: unknown,
  selectedElements: readonly AiAnalysisElement[],
): SchemaValidCodexElementOutput {
  const schemaValidOutput = validateCodexElementOutputSchema(value, selectedElements);
  return validateCodexElementOutputSemantics(schemaValidOutput, selectedElements);
}

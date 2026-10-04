import { z } from "zod";

import {
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementSchema,
  type AnalysisElement,
} from "./analysis-elements.js";
import { GENERIC_AI_ELEMENT_DEFINITIONS } from "./generic-ai-definition.js";

/** 要素別Codex出力のschema version。 */
export const CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION = AI_ANALYSIS_ELEMENT_SCHEMA_VERSION;

/** 要素別Codex出力schemaの公開識別子。 */
export const CODEX_ELEMENT_OUTPUT_SCHEMA_ID =
  "https://voicevox.github.io/voicevox_task_tracker/schemas/codex-element-output.schema.json";

/** JSON Schemaの構造を表す読み取り専用オブジェクト。 */
export type CodexElementOutputJsonSchema = Readonly<Record<string, unknown>>;

const itemSchema = z.strictObject({
  nodeId: z.string().min(1),
  url: z.string().regex(/^https:\/\/github\.com\//u),
});

/** 要素別Codex出力の共通構造を検証するschema。 */
export const codexElementOutputStructureSchema = z.strictObject({
  schemaVersion: z.literal(CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION),
  item: itemSchema,
  status: GENERIC_AI_ELEMENT_DEFINITIONS.status.resultSchema.optional(),
  waitingOn: GENERIC_AI_ELEMENT_DEFINITIONS.waitingOn.resultSchema.optional(),
  nextAction: GENERIC_AI_ELEMENT_DEFINITIONS.nextAction.resultSchema.optional(),
  relations: GENERIC_AI_ELEMENT_DEFINITIONS.relations.resultSchema.optional(),
  progress: GENERIC_AI_ELEMENT_DEFINITIONS.progress.resultSchema.optional(),
  importance: GENERIC_AI_ELEMENT_DEFINITIONS.importance.resultSchema.optional(),
  deadline: GENERIC_AI_ELEMENT_DEFINITIONS.deadline.resultSchema.optional(),
  notification: GENERIC_AI_ELEMENT_DEFINITIONS.notification.resultSchema.optional(),
  selfCommitment: GENERIC_AI_ELEMENT_DEFINITIONS.selfCommitment.resultSchema.optional(),
});

function elementOrder(element: AnalysisElement): number {
  const order = AI_ANALYSIS_ELEMENTS.indexOf(element);
  if (order < 0) {
    throw new TypeError(`未知のAI判定要素です。対象: ${element}`);
  }
  return order;
}

/** 選択した要素を重複なく正規化し、schemaの安定した順序で返す。 */
export function normalizeCodexElementSelection(
  selectedElements: readonly AnalysisElement[],
): readonly AnalysisElement[] {
  const seen = new Set<AnalysisElement>();
  const normalized: AnalysisElement[] = [];
  for (const element of selectedElements) {
    const parsedElement = aiAnalysisElementSchema.safeParse(element);
    if (!parsedElement.success) {
      throw new TypeError("AI判定要素が不正です", { cause: parsedElement.error });
    }
    const normalizedElement = parsedElement.data;
    if (seen.has(normalizedElement)) {
      throw new TypeError(`AI判定要素が重複しています。対象: ${normalizedElement}`);
    }
    elementOrder(normalizedElement);
    seen.add(normalizedElement);
    normalized.push(normalizedElement);
  }
  normalized.sort((left, right) => elementOrder(left) - elementOrder(right));
  return Object.freeze(normalized);
}

/** 選択した要素だけを必須プロパティにしたCodex出力JSON Schemaを生成する。 */
export function createCodexElementOutputSchema(
  selectedElements: readonly AnalysisElement[],
): CodexElementOutputJsonSchema {
  const normalizedElements = normalizeCodexElementSelection(selectedElements);
  const selectedShape: Record<string, z.ZodType> = {
    schemaVersion: codexElementOutputStructureSchema.shape.schemaVersion,
    item: codexElementOutputStructureSchema.shape.item,
  };
  for (const element of normalizedElements) {
    const definition = GENERIC_AI_ELEMENT_DEFINITIONS[element];
    selectedShape[element] = definition.resultSchema.describe(definition.promptDescription);
  }
  const jsonSchema = z.toJSONSchema(z.strictObject(selectedShape), {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });
  Object.freeze(jsonSchema.required);
  Object.freeze(jsonSchema.properties);
  return Object.freeze({
    ...jsonSchema,
    $id: CODEX_ELEMENT_OUTPUT_SCHEMA_ID,
    title: "VOICEVOX Task Tracker Codex Element Output",
  });
}

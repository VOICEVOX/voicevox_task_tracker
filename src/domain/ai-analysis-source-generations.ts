import { z } from "zod";

import {
  aiAnalysisElementMetadataSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisElementResultSchema,
  type AiAnalysisElement,
} from "./ai-analysis-elements.js";

/** 旧AI分析要素出力のschema version。 */
export const AI_ANALYSIS_ELEMENT_SCHEMA_VERSION_V6 = "6";

/** 旧schema6で保存されるAI分析要素。 */
export const AI_ANALYSIS_ELEMENTS_V6 = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
  "relations",
  "progress",
  "importance",
  "deadline",
  "notification",
] satisfies readonly [
  "status",
  "waitingOn",
  "nextAction",
  "relations",
  "progress",
  "importance",
  "deadline",
  "notification",
]);

/** 旧schema6のAI分析要素識別子。 */
export type AiAnalysisElementV6 = (typeof AI_ANALYSIS_ELEMENTS_V6)[number];

const aiAnalysisElementMetadataV6Schema = aiAnalysisElementMetadataSchema.extend({
  schemaVersion: z.literal(AI_ANALYSIS_ELEMENT_SCHEMA_VERSION_V6),
});

const aiAnalysisElementGenerationV6Schemas = {
  status: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("status"),
  }),
  waitingOn: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("waitingOn"),
  }),
  nextAction: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("nextAction"),
  }),
  relations: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("relations"),
  }),
  progress: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("progress"),
  }),
  importance: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("importance"),
  }),
  deadline: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("deadline"),
  }),
  notification: z.strictObject({
    metadata: aiAnalysisElementMetadataV6Schema,
    result: createAiAnalysisElementResultSchema("notification"),
  }),
};

type AiAnalysisElementGenerationV6ByElement = {
  [Element in AiAnalysisElementV6]: z.output<
    (typeof aiAnalysisElementGenerationV6Schemas)[Element]
  >;
};

/** 旧schema6のAI分析generation。 */
export type AiAnalysisElementGenerationV6<
  Element extends AiAnalysisElementV6 = AiAnalysisElementV6,
> = AiAnalysisElementGenerationV6ByElement[Element];

/** 要素ごとの旧schema6 generation schemaを取得する。 */
export function createAiAnalysisElementGenerationSchemaV6<Element extends AiAnalysisElementV6>(
  element: Element,
): (typeof aiAnalysisElementGenerationV6Schemas)[Element] {
  return aiAnalysisElementGenerationV6Schemas[element];
}

const aiAnalysisElementSourceGenerationSchemas = {
  status: z.union([
    createAiAnalysisElementGenerationSchema("status"),
    createAiAnalysisElementGenerationSchemaV6("status"),
  ]),
  waitingOn: z.union([
    createAiAnalysisElementGenerationSchema("waitingOn"),
    createAiAnalysisElementGenerationSchemaV6("waitingOn"),
  ]),
  nextAction: z.union([
    createAiAnalysisElementGenerationSchema("nextAction"),
    createAiAnalysisElementGenerationSchemaV6("nextAction"),
  ]),
  relations: z.union([
    createAiAnalysisElementGenerationSchema("relations"),
    createAiAnalysisElementGenerationSchemaV6("relations"),
  ]),
  progress: z.union([
    createAiAnalysisElementGenerationSchema("progress"),
    createAiAnalysisElementGenerationSchemaV6("progress"),
  ]),
  importance: z.union([
    createAiAnalysisElementGenerationSchema("importance"),
    createAiAnalysisElementGenerationSchemaV6("importance"),
  ]),
  deadline: z.union([
    createAiAnalysisElementGenerationSchema("deadline"),
    createAiAnalysisElementGenerationSchemaV6("deadline"),
  ]),
  notification: z.union([
    createAiAnalysisElementGenerationSchema("notification"),
    createAiAnalysisElementGenerationSchemaV6("notification"),
  ]),
  selfCommitment: createAiAnalysisElementGenerationSchema("selfCommitment"),
};

type AiAnalysisElementSourceGenerationByElement = {
  [Element in AiAnalysisElement]: z.output<
    (typeof aiAnalysisElementSourceGenerationSchemas)[Element]
  >;
};

/** 現行generationまたは履歴として保持するschema6 generation。 */
export type AiAnalysisElementSourceGeneration<
  Element extends AiAnalysisElement = AiAnalysisElement,
> = AiAnalysisElementSourceGenerationByElement[Element];

/** 現行generationまたは履歴として保持するschema6 generationのschemaを取得する。 */
export function createAiAnalysisElementSourceGenerationSchema<Element extends AiAnalysisElement>(
  element: Element,
): (typeof aiAnalysisElementSourceGenerationSchemas)[Element] {
  return aiAnalysisElementSourceGenerationSchemas[element];
}

import {
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisNotificationReasonCodeSchema,
  aiAnalysisRelationVerdictSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnKindSchema,
  aiAnalysisWaitingOnRoleSchema,
  aiAnalysisElementSchema,
  type AnalysisElement,
} from "./analysis-elements.js";

/** 要素別Codex出力のschema version。 */
export const CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION = AI_ANALYSIS_ELEMENT_SCHEMA_VERSION;

/** 要素別Codex出力schemaの公開識別子。 */
export const CODEX_ELEMENT_OUTPUT_SCHEMA_ID =
  "https://voicevox.github.io/voicevox_task_tracker/schemas/codex-element-output.schema.json";

/** JSON Schemaの構造を表す読み取り専用オブジェクト。 */
export type CodexElementOutputJsonSchema = Readonly<Record<string, unknown>>;

const ELEMENT_OUTPUT_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

const itemSchema: CodexElementOutputJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["nodeId", "url"],
  properties: {
    nodeId: {
      type: "string",
      minLength: 1,
    },
    url: {
      type: "string",
      pattern: "^https://github\\.com/",
    },
  },
});

const evidenceSchema: CodexElementOutputJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["sourceId", "summary", "supports"],
  properties: {
    sourceId: {
      type: "string",
      minLength: 1,
      pattern: "^\\S+$",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 240,
    },
    supports: {
      type: "string",
      enum: ["element", "self_commitment"],
    },
  },
});

const elementResultProperties: CodexElementOutputJsonSchema = Object.freeze({
  evidence: {
    type: "array",
    minItems: 1,
    maxItems: 30,
    items: evidenceSchema,
  },
  confidence: {
    type: "number",
    minimum: 0,
    maximum: 1,
  },
  uncertainties: {
    type: "array",
    maxItems: 20,
    items: {
      type: "string",
      minLength: 1,
      maxLength: 240,
    },
  },
});

const elementResultMetadataSchema: CodexElementOutputJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["value", "evidence", "confidence", "uncertainties"],
  properties: elementResultProperties,
});

const waitingOnValueSchema: CodexElementOutputJsonSchema = Object.freeze({
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "candidateId", "role", "reasonSummary", "sourceIds", "confidence"],
    properties: {
      kind: {
        type: "string",
        enum: aiAnalysisWaitingOnKindSchema.options,
      },
      candidateId: {
        type: "string",
        minLength: 1,
        maxLength: 300,
        pattern: "^\\S+$",
      },
      role: {
        type: "string",
        enum: aiAnalysisWaitingOnRoleSchema.options,
      },
      reasonSummary: {
        type: "string",
        minLength: 1,
        maxLength: 300,
      },
      sourceIds: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "string",
          minLength: 1,
          pattern: "^\\S+$",
        },
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
    },
  },
});

const relationValueSchema: CodexElementOutputJsonSchema = Object.freeze({
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["candidateId", "verdict", "reasonSummary", "sourceIds", "confidence"],
    properties: {
      candidateId: {
        type: "string",
        minLength: 1,
        pattern: "^\\S+$",
      },
      verdict: {
        type: "string",
        enum: aiAnalysisRelationVerdictSchema.options,
      },
      reasonSummary: {
        type: "string",
        minLength: 1,
        maxLength: 300,
      },
      sourceIds: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "string",
          minLength: 1,
          pattern: "^\\S+$",
        },
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
    },
  },
});

function createElementResultSchema(
  value: CodexElementOutputJsonSchema,
): CodexElementOutputJsonSchema {
  return Object.freeze({
    ...elementResultMetadataSchema,
    properties: {
      ...elementResultProperties,
      value,
    },
  });
}

function createElementValueSchema(element: AnalysisElement): CodexElementOutputJsonSchema {
  switch (element) {
    case "status":
      return Object.freeze({
        type: "string",
        enum: aiAnalysisStatusSchema.options,
      });
    case "waitingOn":
      return waitingOnValueSchema;
    case "nextAction":
      return Object.freeze({
        type: "string",
        minLength: 1,
        maxLength: 300,
      });
    case "relations":
      return relationValueSchema;
    case "progress":
      return Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["latestMeaningfulSourceId", "reasonSummary", "confidence"],
        properties: {
          latestMeaningfulSourceId: {
            type: ["string", "null"],
            minLength: 1,
            pattern: "^\\S+$",
          },
          reasonSummary: {
            type: "string",
            minLength: 1,
            maxLength: 300,
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
        },
      });
    case "importance":
      return Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["significantFeature", "futureRisk", "rationale"],
        properties: {
          significantFeature: {
            type: "boolean",
          },
          futureRisk: {
            type: "boolean",
          },
          rationale: {
            type: "string",
            minLength: 1,
            maxLength: 120,
          },
        },
      });
    case "deadline":
      return Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["date", "rationale"],
        properties: {
          date: {
            type: ["string", "null"],
            pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
          },
          rationale: {
            type: "string",
            minLength: 1,
            maxLength: 120,
          },
        },
      });
    case "notification":
      return Object.freeze({
        type: "object",
        additionalProperties: false,
        required: ["recommended", "reasonCode", "reasonSummary"],
        properties: {
          recommended: {
            type: "boolean",
          },
          reasonCode: {
            type: "string",
            enum: aiAnalysisNotificationReasonCodeSchema.options,
          },
          reasonSummary: {
            type: "string",
            maxLength: 240,
          },
        },
      });
    default:
      throw new TypeError(`未知のAI判定要素です。対象: ${String(element)}`);
  }
}

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
  const properties: Record<string, unknown> = {
    schemaVersion: {
      type: "string",
      const: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    },
    item: itemSchema,
  };
  for (const element of normalizedElements) {
    properties[element] = createElementResultSchema(createElementValueSchema(element));
  }
  return Object.freeze({
    $schema: ELEMENT_OUTPUT_SCHEMA,
    $id: CODEX_ELEMENT_OUTPUT_SCHEMA_ID,
    title: "VOICEVOX Task Tracker Codex Element Output",
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["schemaVersion", "item", ...normalizedElements]),
    properties: Object.freeze(properties),
  });
}

import { z } from "zod";

import {
  aiAnalysisElementSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementApplications,
  type AiAnalysisElementMigrationResult,
} from "../domain/ai-analysis-elements.js";
import {
  AI_ANALYSIS_ELEMENTS_V6,
  createAiAnalysisElementGenerationSchemaV6,
  type AiAnalysisElementGenerationV6,
} from "../domain/ai-analysis-source-generations.js";
import {
  type TrackedItemAiAnalysisCurrentElements,
  type TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { StateFormatError, StateSnapshotSemanticError } from "./errors.js";
import {
  legacyReuseProof,
  migratedAiAnalysisElementApplications,
} from "./snapshot-migration-relations.js";
import {
  legacyAdoptedElementSchema,
  legacyElementEvidenceSchema,
  legacyElementMetadataSchema,
  legacyMigrationElementEvidenceSchema,
} from "./snapshot-migration-schema.js";

function parseLegacyElementGenerationResult(
  element: AiAnalysisElement,
  generation: unknown,
): AiAnalysisElementMigrationResult {
  const generationSchema = z.strictObject({
    metadata: legacyElementMetadataSchema,
    result: createAiAnalysisElementResultSchema(element).extend({
      evidence: legacyElementEvidenceSchema,
    }),
  });
  const parsed = generationSchema.parse(generation);
  return createAiAnalysisMigrationElementResultSchema(element).parse({
    ...parsed.result,
    evidence: parsed.result.evidence.map((evidence) => ({
      ...evidence,
      supports: "element",
    })),
  });
}

function parseLegacyElementMigrationResult(
  element: AiAnalysisElement,
  result: unknown,
): AiAnalysisElementMigrationResult {
  const resultSchema = createAiAnalysisMigrationElementResultSchema(element).extend({
    evidence: legacyMigrationElementEvidenceSchema,
  });
  const parsed = resultSchema.parse(result);
  return createAiAnalysisMigrationElementResultSchema(element).parse({
    ...parsed,
    evidence: parsed.evidence.map((evidence) => ({
      ...evidence,
      supports: "element",
    })),
  });
}

function parseV6ElementGeneration(
  element: AiAnalysisElement,
  value: unknown,
): AiAnalysisElementGenerationV6 {
  const elementResult = z.enum(AI_ANALYSIS_ELEMENTS_V6).safeParse(element);
  if (!elementResult.success) {
    throw new StateSnapshotSemanticError(
      `旧AI分析要素にschema6では扱えない要素があります。対象: ${element}`,
      { cause: elementResult.error },
    );
  }
  return createAiAnalysisElementGenerationSchemaV6(elementResult.data).parse(value);
}

function parseMigrationElementResult(
  element: AiAnalysisElement,
  value: unknown,
  origin: "current" | "migration",
  elementSchemaVersion: "5" | "6",
): AiAnalysisElementMigrationResult {
  if (origin === "current") {
    if (elementSchemaVersion === "6") {
      const generation = parseV6ElementGeneration(element, value);
      return createAiAnalysisMigrationElementResultSchema(element).parse(generation.result);
    }
    return parseLegacyElementGenerationResult(element, value);
  }
  const adoptedElement = legacyAdoptedElementSchema.parse(value);
  if (adoptedElement.origin === "current") {
    if (elementSchemaVersion === "6") {
      const generation = parseV6ElementGeneration(element, adoptedElement.generation);
      return createAiAnalysisMigrationElementResultSchema(element).parse(generation.result);
    }
    return parseLegacyElementGenerationResult(element, adoptedElement.generation);
  }
  if (elementSchemaVersion === "6") {
    return createAiAnalysisMigrationElementResultSchema(element).parse(adoptedElement.result);
  }
  return parseLegacyElementMigrationResult(element, adoptedElement.result);
}

function currentAdoptedElementEntry(
  element: AiAnalysisElement,
  generationValue: unknown,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  switch (element) {
    case "status": {
      const generation = createAiAnalysisElementGenerationSchemaV6("status").parse(generationValue);
      return Object.freeze({
        status: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("status").parse(generation.result),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "waitingOn": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("waitingOn").parse(generationValue);
      return Object.freeze({
        waitingOn: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
            generation.result,
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "nextAction": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("nextAction").parse(generationValue);
      return Object.freeze({
        nextAction: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
            generation.result,
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "relations": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("relations").parse(generationValue);
      return Object.freeze({
        relations: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("relations").parse(
            generation.result,
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "progress": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("progress").parse(generationValue);
      return Object.freeze({
        progress: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("progress").parse(generation.result),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "importance": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("importance").parse(generationValue);
      return Object.freeze({
        importance: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("importance").parse(
            generation.result,
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "deadline": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("deadline").parse(generationValue);
      return Object.freeze({
        deadline: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("deadline").parse(generation.result),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "notification": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("notification").parse(generationValue);
      return Object.freeze({
        notification: Object.freeze({
          origin: "current",
          generation,
          result: createAiAnalysisMigrationElementResultSchema("notification").parse(
            generation.result,
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    }
    case "selfCommitment":
      throw new StateSnapshotSemanticError(
        "旧snapshotのAI分析要素にselfCommitmentは指定できません",
      );
    default:
      throw new UnreachableError(element);
  }
}

function migratedAdoptedElementEntry(
  element: AiAnalysisElement,
  value: unknown,
  origin: "current" | "migration",
  elementSchemaVersion: "5" | "6",
): TrackedItemAiAnalysisMigrationAdoptedElements {
  if (elementSchemaVersion === "6") {
    if (origin === "current") {
      return currentAdoptedElementEntry(element, value);
    }
    const adoptedElement = legacyAdoptedElementSchema.parse(value);
    if (adoptedElement.origin === "current") {
      return currentAdoptedElementEntry(element, adoptedElement.generation);
    }
  }
  switch (element) {
    case "status":
      return Object.freeze({
        status: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("status").parse(
            parseMigrationElementResult("status", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "waitingOn":
      return Object.freeze({
        waitingOn: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
            parseMigrationElementResult("waitingOn", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "nextAction":
      return Object.freeze({
        nextAction: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
            parseMigrationElementResult("nextAction", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "relations":
      return Object.freeze({
        relations: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("relations").parse(
            parseMigrationElementResult("relations", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "progress":
      return Object.freeze({
        progress: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("progress").parse(
            parseMigrationElementResult("progress", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "importance":
      return Object.freeze({
        importance: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("importance").parse(
            parseMigrationElementResult("importance", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "deadline":
      return Object.freeze({
        deadline: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("deadline").parse(
            parseMigrationElementResult("deadline", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "notification":
      return Object.freeze({
        notification: Object.freeze({
          origin: "migration",
          result: createAiAnalysisMigrationElementResultSchema("notification").parse(
            parseMigrationElementResult("notification", value, origin, elementSchemaVersion),
          ),
          reuseProof: legacyReuseProof(),
        }),
      });
    case "selfCommitment":
      throw new StateSnapshotSemanticError(
        "旧snapshotのAI分析要素にselfCommitmentは指定できません",
      );
    default:
      throw new UnreachableError(element);
  }
}

function parseAdoptedElements(
  elements: unknown,
  origin: "current" | "migration",
  elementSchemaVersion: "5" | "6",
): TrackedItemAiAnalysisMigrationAdoptedElements {
  const entries = z.record(z.string(), z.unknown()).parse(elements);
  let adopted: TrackedItemAiAnalysisMigrationAdoptedElements = Object.freeze({});
  for (const [key, value] of Object.entries(entries)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`移行AI採用要素が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    adopted = Object.freeze({
      ...adopted,
      ...migratedAdoptedElementEntry(elementResult.data, value, origin, elementSchemaVersion),
    });
  }
  return Object.freeze(adopted);
}

function currentElementEntry(
  element: AiAnalysisElement,
  value: unknown,
): TrackedItemAiAnalysisCurrentElements {
  const evaluationProof = legacyReuseProof();
  switch (element) {
    case "status": {
      const generation = createAiAnalysisElementGenerationSchemaV6("status").parse(value);
      return Object.freeze({
        status: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("status").parse(generation.result),
          evaluationProof,
        }),
      });
    }
    case "waitingOn": {
      const generation = createAiAnalysisElementGenerationSchemaV6("waitingOn").parse(value);
      return Object.freeze({
        waitingOn: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
            generation.result,
          ),
          evaluationProof,
        }),
      });
    }
    case "nextAction": {
      const generation = createAiAnalysisElementGenerationSchemaV6("nextAction").parse(value);
      return Object.freeze({
        nextAction: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
            generation.result,
          ),
          evaluationProof,
        }),
      });
    }
    case "relations": {
      const generation = createAiAnalysisElementGenerationSchemaV6("relations").parse(value);
      return Object.freeze({
        relations: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("relations").parse(
            generation.result,
          ),
          evaluationProof,
        }),
      });
    }
    case "progress": {
      const generation = createAiAnalysisElementGenerationSchemaV6("progress").parse(value);
      return Object.freeze({
        progress: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("progress").parse(generation.result),
          evaluationProof,
        }),
      });
    }
    case "importance": {
      const generation = createAiAnalysisElementGenerationSchemaV6("importance").parse(value);
      return Object.freeze({
        importance: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("importance").parse(
            generation.result,
          ),
          evaluationProof,
        }),
      });
    }
    case "deadline": {
      const generation = createAiAnalysisElementGenerationSchemaV6("deadline").parse(value);
      return Object.freeze({
        deadline: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("deadline").parse(generation.result),
          evaluationProof,
        }),
      });
    }
    case "notification": {
      const generation = createAiAnalysisElementGenerationSchemaV6("notification").parse(value);
      return Object.freeze({
        notification: Object.freeze({
          generation,
          result: createAiAnalysisMigrationElementResultSchema("notification").parse(
            generation.result,
          ),
          evaluationProof,
        }),
      });
    }
    case "selfCommitment":
      throw new StateSnapshotSemanticError(
        "旧snapshotのAI分析要素にselfCommitmentは指定できません",
      );
  }
}

function parseCurrentElements(
  elements: unknown,
  elementSchemaVersion: "5" | "6",
): TrackedItemAiAnalysisCurrentElements {
  if (elementSchemaVersion !== "6") {
    throw new StateSnapshotSemanticError("schema5のAI分析要素を現行評価要素へ移行できません");
  }
  const entries = z.record(z.string(), z.unknown()).parse(elements);
  let evaluated: TrackedItemAiAnalysisCurrentElements = Object.freeze({});
  for (const [key, value] of Object.entries(entries)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`AI評価要素が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    evaluated = Object.freeze({ ...evaluated, ...currentElementEntry(elementResult.data, value) });
  }
  return Object.freeze(evaluated);
}

export function migrateAiAnalysis(
  value: unknown,
  preserveElements: boolean,
  elementSchemaVersion: "5" | "6",
): {
  origin: "migration";
  status: "used" | "failed" | "deferred" | "not_required" | "disabled" | "not_recorded";
  elements: TrackedItemAiAnalysisCurrentElements;
  adoptedElements: TrackedItemAiAnalysisMigrationAdoptedElements;
  applications: AiAnalysisElementApplications;
} {
  const aiAnalysis = z
    .object({
      origin: z.enum(["current", "migration"]),
      status: z.enum(["used", "failed", "deferred", "not_required", "disabled", "not_recorded"]),
      elements: z.unknown(),
      adoptedElements: z.unknown(),
    })
    .parse(value);
  return {
    origin: "migration",
    status: aiAnalysis.status,
    elements: preserveElements
      ? parseCurrentElements(aiAnalysis.elements, elementSchemaVersion)
      : Object.freeze({}),
    adoptedElements: parseAdoptedElements(
      aiAnalysis.adoptedElements,
      aiAnalysis.origin,
      elementSchemaVersion,
    ),
    applications: migratedAiAnalysisElementApplications(),
  };
}

export function migrationFormatError(error: unknown): StateFormatError {
  if (error instanceof StateFormatError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return StateFormatError.fromZodError("snapshot移行", error);
  }
  return new StateFormatError("snapshot移行", {
    cause: new TypeError("snapshotの移行に失敗しました", {
      cause: error,
    }),
  });
}

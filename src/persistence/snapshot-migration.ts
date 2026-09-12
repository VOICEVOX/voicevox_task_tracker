import { z } from "zod";

import {
  aiAnalysisElementEvidenceSchema,
  aiAnalysisImportanceSchema,
  aiAnalysisNextActionSchema,
  aiAnalysisNotificationSchema,
  aiAnalysisRelationsSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementSchema,
  aiAnalysisElementReuseProofSchema,
  AI_ANALYSIS_REUSE_PROOF_SCHEMA_VERSION,
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  createAiAnalysisElementValueSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisRelation,
} from "../domain/ai-analysis-elements.js";
import {
  type TrackedItemAiAnalysisCurrentElements,
  type TrackedItemAiAnalysisMigrationAdoptedElements,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  isTerminalStatus,
  type PersonalReminderCausePlanning,
} from "../domain/index.js";
import {
  AI_ANALYSIS_ELEMENTS_V6,
  createAiAnalysisElementGenerationSchemaV6,
  type AiAnalysisElementGenerationV6,
} from "../domain/ai-analysis-source-generations.js";
import { type AiCacheKey } from "../codex/cache.js";
import { type LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { parseSha256Hash, serializeCanonicalJson } from "./canonical-json.js";
import { StateFormatError, StateSnapshotSemanticError } from "./errors.js";
import { UnreachableError } from "../util/index.js";
import {
  createStateSnapshot,
  parseStateSnapshot,
  parseStateSnapshotVersion11,
  parseStateSnapshotVersion12,
  parseStateSnapshotVersion13,
  parseStateSnapshotVersion14,
  type SnapshotAnalysisPlanFingerprint,
  type StateSnapshot,
} from "./snapshot.js";

const legacyStatusSchema = aiAnalysisStatusSchema;

function legacyReuseProof() {
  return aiAnalysisElementReuseProofSchema.parse({
    status: "unknown",
    reuseSchemaVersion: AI_ANALYSIS_REUSE_PROOF_SCHEMA_VERSION,
    reason: "legacy_migration",
  });
}
const legacyWaitingOnSchema = z
  .array(
    z.strictObject({
      kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
      candidateId: z.string().min(1).max(300).regex(/^\S+$/u),
      role: z.enum([
        "author",
        "maintainer",
        "reviewer",
        "assignee",
        "respondent",
        "dependency",
        "merge_decider",
        "ci",
        "unknown",
      ]),
      reasonSummary: z.string().min(1).max(300),
      sourceIds: z.array(z.string().min(1).regex(/^\S+$/u)).min(1),
      confidence: z.number().min(0).max(1),
    }),
  )
  .max(20);
const legacyCacheKeySchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "AI cache keyが不正です")
  .transform((value) => parseSha256Hash(value));
const legacyAiAnalysisSchema = z.union([
  z.strictObject({
    status: z.literal("used"),
    cacheKey: legacyCacheKeySchema,
  }),
  z.strictObject({
    status: z.enum(["failed", "deferred", "not_required", "disabled", "not_recorded"]),
  }),
]);
const legacyEvidenceSchema = z.strictObject({
  sourceId: z.string().min(1),
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: z.string().min(1).max(240),
});
const legacyRelationContradictionSchema = z.strictObject({
  verdict: z.enum([
    "current_is_blocked_by_target",
    "current_blocks_target",
    "current_implements_target",
    "target_is_subtask_of_current",
    "current_is_subtask_of_target",
    "duplicates",
    "related",
    "none",
  ]),
  confidence: z.number().min(0).max(1),
});
const legacyRelationFieldsSchema = {
  id: z.string().min(1).regex(/^\S+$/u),
  fromNodeId: z.string().min(1).regex(/^\S+$/u),
  toNodeId: z.string().min(1).regex(/^\S+$/u),
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
    "ai_inference",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(legacyEvidenceSchema),
  contradictions: z.array(legacyRelationContradictionSchema),
  firstSeenAt: z.string().min(1),
  lastConfirmedAt: z.string().min(1),
};
const legacyRelationSchema = z.union([
  z.strictObject({
    ...legacyRelationFieldsSchema,
    active: z.literal(true),
  }),
  z.strictObject({
    ...legacyRelationFieldsSchema,
    active: z.literal(false),
    removedAt: z.string().min(1),
  }),
]);
const legacyImportanceAssessmentSchema = z.union([
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z.strictObject({
    status: z.literal("available"),
    value: aiAnalysisImportanceSchema,
  }),
]);
const legacyDeadlineValueSchema = createAiAnalysisElementValueSchema("deadline");
const legacyDeadlineAssessmentSchema = z.union([
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z.strictObject({
    status: z.literal("available"),
    value: legacyDeadlineValueSchema,
  }),
]);
const legacySeverityContextSchema = z
  .object({
    decisionBasis: z.enum(["deterministic", "ai_only"]),
  })
  .catchall(z.unknown());
const legacyTrackedItemSchema = z
  .object({
    nodeId: z.string().min(1),
    url: z.string().min(1),
    aiAnalysis: legacyAiAnalysisSchema,
    status: legacyStatusSchema,
    waitingOn: legacyWaitingOnSchema,
    nextAction: z.string().min(1).max(1000),
    importanceAssessment: legacyImportanceAssessmentSchema,
    deadlineAssessment: legacyDeadlineAssessmentSchema,
    severityContext: legacySeverityContextSchema,
    evidence: z.array(legacyEvidenceSchema),
    confidence: z.number().min(0).max(1),
  })
  .catchall(z.unknown());
const legacyIdentifiedAuthorSchema = z
  .object({
    status: z.literal("identified"),
    actor: z
      .object({
        login: z.string().min(1),
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());
const legacyCollectionItemSchema = z.strictObject({
  freshness: z.literal("fresh"),
  nodeId: z.string().min(1),
  repositoryId: z.string().min(1),
  itemFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  aiAnalysisFingerprint: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("available"),
      fingerprint: z.strictObject({
        sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        graphNeighborhoodHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        identityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      }),
    }),
  ]),
  analysisRulesFingerprint: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("available"),
      fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    }),
  ]),
  deterministicRulesVersion: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("available"),
      version: z.string().min(1),
    }),
  ]),
  observedAt: z.string().min(1),
  state: z.enum(["open", "closed"]),
  terminalAt: z.union([z.string().min(1), z.null()]),
});
const legacyCollectionRepositorySchema = z.strictObject({
  repositoryId: z.string().min(1),
  successfulAt: z.string().min(1),
  items: z.array(legacyCollectionItemSchema),
});
const legacySnapshotSchema = z.strictObject({
  schemaVersion: z.literal("10"),
  generatedAt: z.unknown(),
  trackingStartAt: z.unknown(),
  ai: z.unknown(),
  collection: z.strictObject({
    repositories: z.array(legacyCollectionRepositorySchema),
  }),
  repositories: z.array(z.unknown()),
  items: z.array(legacyTrackedItemSchema),
  externalReferences: z.array(z.unknown()),
  relations: z.array(legacyRelationSchema),
  run: z.unknown(),
});
const snapshotVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});

const legacyOutputEvidenceSchema = z.strictObject({
  sourceId: z.string().min(1),
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: z.string().min(1).max(240),
});
const legacyOutputSchema = z.strictObject({
  schemaVersion: z.literal("4"),
  item: z.strictObject({
    nodeId: z.string().min(1),
    url: z.string().min(1),
  }),
  status: aiAnalysisStatusSchema,
  waitingOn: aiAnalysisWaitingOnSchema,
  nextAction: aiAnalysisNextActionSchema,
  relations: z.json(),
  progress: z.json(),
  importance: aiAnalysisImportanceSchema,
  deadline: legacyDeadlineValueSchema,
  notification: z.json(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(legacyOutputEvidenceSchema).min(1).max(30),
  uncertainties: z.array(z.string().min(1).max(240)).max(20),
});

type LegacyTrackedItem = z.output<typeof legacyTrackedItemSchema>;
type LegacyOutput = z.output<typeof legacyOutputSchema>;
type LegacyRelation = z.output<typeof legacyRelationSchema>;
type LegacyWaitingOnCandidate = z.output<typeof legacyWaitingOnSchema>[number];
type AdoptedLegacyRelation = Readonly<{
  candidate: AiAnalysisRelation;
  relation: LegacyRelation;
}>;
type MutablePartial<Value> = {
  -readonly [Key in keyof Value]?: Value[Key];
};

const legacyElementMetadataSchema = aiAnalysisElementMetadataSchema.extend({
  schemaVersion: z.literal("5"),
});
const legacyElementEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1)
  .max(30);
const legacyMigrationElementEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1);
const legacyAdoptedElementSchema = z.discriminatedUnion("origin", [
  z.strictObject({
    origin: z.literal("current"),
    generation: z.unknown(),
  }),
  z.strictObject({
    origin: z.literal("migration"),
    result: z.unknown(),
  }),
]);

function parseJson(source: string): unknown {
  try {
    const parse: (value: string) => unknown = JSON.parse;
    return parse(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
}

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

function setCurrentAdoptedElement(
  adopted: MutablePartial<TrackedItemAiAnalysisMigrationAdoptedElements>,
  element: AiAnalysisElement,
  generationValue: unknown,
): void {
  switch (element) {
    case "status": {
      const generation = createAiAnalysisElementGenerationSchemaV6("status").parse(generationValue);
      adopted.status = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("status").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "waitingOn": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("waitingOn").parse(generationValue);
      adopted.waitingOn = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "nextAction": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("nextAction").parse(generationValue);
      adopted.nextAction = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "relations": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("relations").parse(generationValue);
      adopted.relations = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "progress": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("progress").parse(generationValue);
      adopted.progress = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("progress").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "importance": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("importance").parse(generationValue);
      adopted.importance = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("importance").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "deadline": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("deadline").parse(generationValue);
      adopted.deadline = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("deadline").parse(generation.result),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "notification": {
      const generation =
        createAiAnalysisElementGenerationSchemaV6("notification").parse(generationValue);
      adopted.notification = {
        origin: "current",
        generation,
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(
          generation.result,
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    }
    case "selfCommitment":
      throw new StateSnapshotSemanticError(
        "旧snapshotのAI分析要素にselfCommitmentは指定できません",
      );
    default:
      throw new UnreachableError(element);
  }
}

function setMigratedAdoptedElement(
  adopted: MutablePartial<TrackedItemAiAnalysisMigrationAdoptedElements>,
  element: AiAnalysisElement,
  value: unknown,
  origin: "current" | "migration",
  elementSchemaVersion: "5" | "6",
): void {
  if (elementSchemaVersion === "6") {
    if (origin === "current") {
      setCurrentAdoptedElement(adopted, element, value);
      return;
    }
    const adoptedElement = legacyAdoptedElementSchema.parse(value);
    if (adoptedElement.origin === "current") {
      setCurrentAdoptedElement(adopted, element, adoptedElement.generation);
      return;
    }
  }
  switch (element) {
    case "status":
      adopted.status = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("status").parse(
          parseMigrationElementResult("status", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "waitingOn":
      adopted.waitingOn = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
          parseMigrationElementResult("waitingOn", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "nextAction":
      adopted.nextAction = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
          parseMigrationElementResult("nextAction", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "relations":
      adopted.relations = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(
          parseMigrationElementResult("relations", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "progress":
      adopted.progress = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("progress").parse(
          parseMigrationElementResult("progress", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "importance":
      adopted.importance = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("importance").parse(
          parseMigrationElementResult("importance", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "deadline":
      adopted.deadline = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("deadline").parse(
          parseMigrationElementResult("deadline", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
    case "notification":
      adopted.notification = {
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(
          parseMigrationElementResult("notification", value, origin, elementSchemaVersion),
        ),
        reuseProof: legacyReuseProof(),
      };
      return;
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
  const adopted: MutablePartial<TrackedItemAiAnalysisMigrationAdoptedElements> = {};
  for (const [key, value] of Object.entries(entries)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`移行AI採用要素が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    setMigratedAdoptedElement(adopted, elementResult.data, value, origin, elementSchemaVersion);
  }
  return Object.freeze(adopted);
}

function parseCurrentElements(
  elements: unknown,
  elementSchemaVersion: "5" | "6",
): TrackedItemAiAnalysisCurrentElements {
  if (elementSchemaVersion !== "6") {
    throw new StateSnapshotSemanticError("schema5のAI分析要素を現行評価要素へ移行できません");
  }
  const entries = z.record(z.string(), z.unknown()).parse(elements);
  const evaluated: MutablePartial<TrackedItemAiAnalysisCurrentElements> = {};
  for (const [key, value] of Object.entries(entries)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`AI評価要素が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const evaluationProof = legacyReuseProof();
    switch (elementResult.data) {
      case "status": {
        const generation = createAiAnalysisElementGenerationSchemaV6("status").parse(value);
        evaluated.status = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("status").parse(generation.result),
          evaluationProof,
        };
        break;
      }
      case "waitingOn": {
        const generation = createAiAnalysisElementGenerationSchemaV6("waitingOn").parse(value);
        evaluated.waitingOn = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
            generation.result,
          ),
          evaluationProof,
        };
        break;
      }
      case "nextAction": {
        const generation = createAiAnalysisElementGenerationSchemaV6("nextAction").parse(value);
        evaluated.nextAction = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
            generation.result,
          ),
          evaluationProof,
        };
        break;
      }
      case "relations": {
        const generation = createAiAnalysisElementGenerationSchemaV6("relations").parse(value);
        evaluated.relations = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("relations").parse(
            generation.result,
          ),
          evaluationProof,
        };
        break;
      }
      case "progress": {
        const generation = createAiAnalysisElementGenerationSchemaV6("progress").parse(value);
        evaluated.progress = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("progress").parse(generation.result),
          evaluationProof,
        };
        break;
      }
      case "importance": {
        const generation = createAiAnalysisElementGenerationSchemaV6("importance").parse(value);
        evaluated.importance = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("importance").parse(
            generation.result,
          ),
          evaluationProof,
        };
        break;
      }
      case "deadline": {
        const generation = createAiAnalysisElementGenerationSchemaV6("deadline").parse(value);
        evaluated.deadline = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("deadline").parse(generation.result),
          evaluationProof,
        };
        break;
      }
      case "notification": {
        const generation = createAiAnalysisElementGenerationSchemaV6("notification").parse(value);
        evaluated.notification = {
          generation,
          result: createAiAnalysisMigrationElementResultSchema("notification").parse(
            generation.result,
          ),
          evaluationProof,
        };
        break;
      }
      case "selfCommitment":
        throw new StateSnapshotSemanticError(
          "旧snapshotのAI分析要素にselfCommitmentは指定できません",
        );
    }
  }
  return Object.freeze(evaluated);
}

function migrateAiAnalysis(
  value: unknown,
  preserveElements: boolean,
  elementSchemaVersion: "5" | "6",
): {
  origin: "migration";
  status: "used" | "failed" | "deferred" | "not_required" | "disabled" | "not_recorded";
  elements: TrackedItemAiAnalysisCurrentElements;
  adoptedElements: TrackedItemAiAnalysisMigrationAdoptedElements;
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
  };
}

function migrationFormatError(error: unknown): StateFormatError {
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

function resultEvidence(
  values: readonly z.output<typeof legacyEvidenceSchema>[],
): readonly z.output<typeof aiAnalysisElementEvidenceSchema>[] {
  const evidenceByKey = new Map<string, z.output<typeof aiAnalysisElementEvidenceSchema>>();
  for (const value of values) {
    const evidence = aiAnalysisElementEvidenceSchema.parse({
      sourceId: value.sourceId,
      summary: value.summary,
      supports: "element",
    });
    evidenceByKey.set(serializeCanonicalJson([evidence.sourceId, evidence.summary]), evidence);
  }
  return Object.freeze([...evidenceByKey.values()]);
}

function outputEvidenceForElement(
  output: LegacyOutput,
  element: AiAnalysisElement,
  fallback: readonly z.output<typeof legacyEvidenceSchema>[],
): readonly z.output<typeof aiAnalysisElementEvidenceSchema>[] {
  const supports =
    element === "status" || element === "nextAction"
      ? "status"
      : element === "waitingOn"
        ? "waiting_on"
        : element === "relations"
          ? "relation"
          : element === "notification"
            ? "notification"
            : undefined;
  const selected =
    supports == null
      ? output.evidence
      : output.evidence.filter((value) => value.supports === supports);
  if (selected.length !== 0) {
    return resultEvidence(selected);
  }
  return resultEvidence(element === "notification" ? output.evidence : fallback);
}

function createMigrationResult(
  element: AiAnalysisElement,
  value: unknown,
  evidence: readonly z.output<typeof aiAnalysisElementEvidenceSchema>[],
  confidence: number,
  uncertainties: readonly string[],
): AiAnalysisElementMigrationResult {
  if (evidence.length === 0) {
    throw new StateSnapshotSemanticError(`移行AI採用要素の根拠がありません。対象: ${element}`);
  }
  const common = {
    value,
    evidence,
    confidence,
    uncertainties,
  };
  switch (element) {
    case "status":
      return createAiAnalysisMigrationElementResultSchema("status").parse(common);
    case "waitingOn":
      return createAiAnalysisMigrationElementResultSchema("waitingOn").parse(common);
    case "nextAction":
      return createAiAnalysisMigrationElementResultSchema("nextAction").parse(common);
    case "relations":
      return createAiAnalysisMigrationElementResultSchema("relations").parse(common);
    case "progress":
      return createAiAnalysisMigrationElementResultSchema("progress").parse(common);
    case "importance":
      return createAiAnalysisMigrationElementResultSchema("importance").parse(common);
    case "deadline":
      return createAiAnalysisMigrationElementResultSchema("deadline").parse(common);
    case "notification":
      return createAiAnalysisMigrationElementResultSchema("notification").parse(common);
    case "selfCommitment":
      throw new StateSnapshotSemanticError(
        "旧snapshotのAI分析要素にselfCommitmentは指定できません",
      );
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return serializeCanonicalJson(left) === serializeCanonicalJson(right);
  } catch (error: unknown) {
    throw new StateSnapshotSemanticError("移行AI採用値を比較できません", {
      cause: error,
    });
  }
}

function waitingOnCandidateMeaningfullyEquals(
  item: LegacyTrackedItem,
  output: LegacyWaitingOnCandidate,
  adopted: LegacyWaitingOnCandidate,
): boolean {
  if (
    output.kind === adopted.kind &&
    output.candidateId === adopted.candidateId &&
    output.role === adopted.role
  ) {
    return true;
  }
  if (
    output.kind !== "user" ||
    output.role !== "author" ||
    adopted.kind !== "role" ||
    adopted.role !== "author" ||
    adopted.candidateId !== "author"
  ) {
    return false;
  }
  const authorResult = legacyIdentifiedAuthorSchema.safeParse(item["author"]);
  return authorResult.success && authorResult.data.actor.login === output.candidateId;
}

function waitingOnMeaningfullyEquals(
  item: LegacyTrackedItem,
  output: readonly LegacyWaitingOnCandidate[],
  adopted: readonly LegacyWaitingOnCandidate[],
): boolean {
  return (
    output.length === adopted.length &&
    output.every((candidate, index) => {
      const adoptedCandidate = adopted[index];
      return (
        adoptedCandidate != null &&
        waitingOnCandidateMeaningfullyEquals(item, candidate, adoptedCandidate)
      );
    })
  );
}

function relationMatchesCandidate(
  relation: LegacyRelation,
  itemNodeId: string,
  candidate: AiAnalysisRelation,
): boolean {
  if (
    !relation.active ||
    relation.provenance === "native" ||
    relation.id !== candidate.candidateId
  ) {
    return false;
  }
  switch (candidate.verdict) {
    case "current_is_blocked_by_target":
      return relation.type === "blocks" && relation.toNodeId === itemNodeId;
    case "current_blocks_target":
      return relation.type === "blocks" && relation.fromNodeId === itemNodeId;
    case "current_implements_target":
      return relation.type === "implements" && relation.fromNodeId === itemNodeId;
    case "target_is_subtask_of_current":
      return relation.type === "parent_of" && relation.fromNodeId === itemNodeId;
    case "current_is_subtask_of_target":
      return relation.type === "parent_of" && relation.toNodeId === itemNodeId;
    case "duplicates":
      return relation.type === "duplicates" && relation.fromNodeId === itemNodeId;
    case "related":
      return relation.type === "related_to" && relation.fromNodeId === itemNodeId;
    case "none":
      return false;
    default:
      throw new UnreachableError(candidate.verdict);
  }
}

function adoptedRelationCandidates(
  item: LegacyTrackedItem,
  output: LegacyOutput,
  legacyRelationsById: ReadonlyMap<string, LegacyRelation>,
): readonly AdoptedLegacyRelation[] {
  const candidates = aiAnalysisRelationsSchema.parse(output.relations);
  const adopted: AdoptedLegacyRelation[] = [];
  const adoptedIds = new Set<string>();
  for (const candidate of candidates) {
    const relation = legacyRelationsById.get(candidate.candidateId);
    if (relation == null || !relationMatchesCandidate(relation, item.nodeId, candidate)) {
      continue;
    }
    if (adoptedIds.has(candidate.candidateId)) {
      throw new StateSnapshotSemanticError(
        `移行AI採用relationsのcandidate IDが重複しています。対象: ${item.nodeId}`,
      );
    }
    adoptedIds.add(candidate.candidateId);
    adopted.push({ candidate, relation });
  }
  return Object.freeze(adopted);
}

function parseLegacyOutput(entry: LegacyAiCacheEntry, item: LegacyTrackedItem): LegacyOutput {
  if (entry.metadata.schemaVersion !== "4") {
    throw new StateSnapshotSemanticError(
      `参照したAI cacheのschema versionがv4ではありません。対象: ${item.nodeId}`,
    );
  }
  const output = legacyOutputSchema.parse(entry.output);
  if (output.item.nodeId !== item.nodeId || output.item.url !== item.url) {
    throw new StateSnapshotSemanticError(
      `参照したAI cacheの項目識別子がsnapshotと一致しません。対象: ${item.nodeId}`,
    );
  }
  return output;
}

function effectiveStateConfidence(output: LegacyOutput): number {
  return output.waitingOn.reduce(
    (confidence, waitingOn) => Math.min(confidence, waitingOn.confidence),
    output.confidence,
  );
}

function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "importance",
): AiAnalysisElementMigrationResult<"importance"> | undefined;
function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "deadline",
): AiAnalysisElementMigrationResult<"deadline"> | undefined;
function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "importance" | "deadline",
): AiAnalysisElementMigrationResult | undefined {
  const assessment = item[`${element}Assessment`];
  if (assessment.status !== "available") {
    return undefined;
  }
  const fallbackEvidence = resultEvidence(item.evidence);
  if (fallbackEvidence.length === 0) {
    return undefined;
  }
  const value = assessment.value;
  const outputValue = output?.[element];
  const matchedOutput = output != null && equalJson(outputValue, value) ? output : undefined;
  const result = createMigrationResult(
    element,
    value,
    matchedOutput == null
      ? fallbackEvidence
      : outputEvidenceForElement(matchedOutput, element, item.evidence),
    matchedOutput?.confidence ?? item.confidence,
    matchedOutput?.uncertainties ?? [],
  );
  return createAiAnalysisMigrationElementResultSchema(element).parse(result);
}

function createLegacyAdoptedElements(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  legacyRelationsById: ReadonlyMap<string, LegacyRelation>,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  const adopted: MutablePartial<TrackedItemAiAnalysisMigrationAdoptedElements> = {};
  const importance = createAssessmentResult(item, output, "importance");
  if (importance != null) {
    adopted.importance = {
      origin: "migration",
      result: importance,
      reuseProof: legacyReuseProof(),
    };
  }
  const deadline = createAssessmentResult(item, output, "deadline");
  if (deadline != null) {
    adopted.deadline = {
      origin: "migration",
      result: deadline,
      reuseProof: legacyReuseProof(),
    };
  }
  if (output == null) {
    return Object.freeze(adopted);
  }
  const statusMatched = equalJson(output.status, item.status);
  const waitingOnMatched = waitingOnMeaningfullyEquals(item, output.waitingOn, item.waitingOn);
  if (statusMatched) {
    adopted.status = {
      origin: "migration",
      result: createAiAnalysisMigrationElementResultSchema("status").parse(
        createMigrationResult(
          "status",
          item.status,
          outputEvidenceForElement(output, "status", item.evidence),
          output.confidence,
          output.uncertainties,
        ),
      ),
      reuseProof: legacyReuseProof(),
    };
  }
  if (waitingOnMatched) {
    adopted.waitingOn = {
      origin: "migration",
      result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
        createMigrationResult(
          "waitingOn",
          item.waitingOn,
          outputEvidenceForElement(output, "waitingOn", item.evidence),
          output.confidence,
          output.uncertainties,
        ),
      ),
      reuseProof: legacyReuseProof(),
    };
  }
  if (statusMatched && waitingOnMatched) {
    adopted.nextAction = {
      origin: "migration",
      result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
        createMigrationResult(
          "nextAction",
          item.nextAction,
          outputEvidenceForElement(output, "nextAction", item.evidence),
          output.confidence,
          output.uncertainties,
        ),
      ),
      reuseProof: legacyReuseProof(),
    };
  }
  const adoptedRelations = adoptedRelationCandidates(item, output, legacyRelationsById);
  if (adoptedRelations.length > 0) {
    adopted.relations = {
      origin: "migration",
      result: createAiAnalysisMigrationElementResultSchema("relations").parse(
        createMigrationResult(
          "relations",
          adoptedRelations.map(({ candidate }) => candidate),
          resultEvidence(adoptedRelations.flatMap(({ relation }) => relation.evidence)),
          output.confidence,
          output.uncertainties,
        ),
      ),
      reuseProof: legacyReuseProof(),
    };
  }
  if (item.severityContext.decisionBasis === "ai_only") {
    const notification = aiAnalysisNotificationSchema.parse(output.notification);
    adopted.notification = {
      origin: "migration",
      result: createAiAnalysisMigrationElementResultSchema("notification").parse(
        createMigrationResult(
          "notification",
          notification,
          outputEvidenceForElement(output, "notification", item.evidence),
          effectiveStateConfidence(output),
          output.uncertainties,
        ),
      ),
      reuseProof: legacyReuseProof(),
    };
  }
  return Object.freeze(adopted);
}

function migrateTrackedItem(
  item: LegacyTrackedItem,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  legacyRelationsById: ReadonlyMap<string, LegacyRelation>,
): Record<string, unknown> {
  let output: LegacyOutput | undefined;
  if (item.aiAnalysis.status === "used") {
    const cacheEntry = legacyEntriesByCacheKey.get(item.aiAnalysis.cacheKey);
    if (cacheEntry == null) {
      throw new StateSnapshotSemanticError(
        `AI分析がusedなのに参照cacheがありません。対象: ${item.nodeId}`,
      );
    }
    output = parseLegacyOutput(cacheEntry, item);
  }
  return {
    ...item,
    aiAnalysis: {
      origin: "migration",
      status: item.aiAnalysis.status,
      elements: {},
      adoptedElements: createLegacyAdoptedElements(item, output, legacyRelationsById),
    },
    personalReminderCauses: [],
    personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
  };
}

function migratedPersonalReminderCausePlanning(
  status: LegacyTrackedItem["status"],
): PersonalReminderCausePlanning {
  if (isTerminalStatus(status)) {
    return {
      status: "excluded",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      reason: "terminal_without_cause",
    };
  }
  return {
    status: "pending",
    planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  };
}

function migrationCollectionAiAnalysis(): Readonly<{
  origin: "migration";
  status: "not_recorded";
  elements: Readonly<Record<string, never>>;
  adoptedElements: Readonly<Record<string, never>>;
}> {
  return {
    origin: "migration",
    status: "not_recorded",
    elements: {},
    adoptedElements: {},
  };
}

function createLegacyRelationsById(
  relations: readonly LegacyRelation[],
): ReadonlyMap<string, LegacyRelation> {
  const relationsById = new Map<string, LegacyRelation>();
  for (const relation of relations) {
    if (relationsById.has(relation.id)) {
      throw new StateSnapshotSemanticError(`relation IDが重複しています。対象: ${relation.id}`);
    }
    relationsById.set(relation.id, relation);
  }
  return relationsById;
}

function migrateVersion11StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion11(source);
    return createStateSnapshot({
      ...value,
      schemaVersion: "15",
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: migrateAiAnalysis(item.aiAnalysis, false, "5"),
          })),
        })),
      },
      items: value.items.map((item) => ({
        ...item,
        aiAnalysis: migrateAiAnalysis(item.aiAnalysis, false, "5"),
        personalReminderCauses: [],
        personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
      })),
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

function migrateVersion12StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion12(source);
    return createStateSnapshot({
      ...value,
      schemaVersion: "15",
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: migrateAiAnalysis(item.aiAnalysis, false, "5"),
          })),
        })),
      },
      items: value.items.map((item) => ({
        ...item,
        aiAnalysis: migrateAiAnalysis(item.aiAnalysis, false, "5"),
        personalReminderCauses: [],
        personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
      })),
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

function migrateVersion13StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion13(source);
    return createStateSnapshot({
      ...value,
      schemaVersion: "15",
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: migrateAiAnalysis(item.aiAnalysis, true, "6"),
          })),
        })),
      },
      items: value.items.map((item) => ({
        ...item,
        aiAnalysis: migrateAiAnalysis(item.aiAnalysis, true, "6"),
        personalReminderCauses: [],
        personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
      })),
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

function migrateLegacyStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
): StateSnapshot {
  try {
    const value = legacySnapshotSchema.parse(parseJson(source));
    const legacyRelationsById = createLegacyRelationsById(value.relations);
    const migratedItems = value.items.map((item) =>
      migrateTrackedItem(item, legacyEntriesByCacheKey, legacyRelationsById),
    );
    const collectionRepositories = value.collection.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      successfulAt: repository.successfulAt,
      items: repository.items.map((item) => {
        return {
          freshness: item.freshness,
          nodeId: item.nodeId,
          repositoryId: item.repositoryId,
          itemFingerprint: item.itemFingerprint,
          analysisPlanFingerprint: {
            status: "unplanned",
            reason: "migration",
          } satisfies SnapshotAnalysisPlanFingerprint,
          aiAnalysis: migrationCollectionAiAnalysis(),
          observedAt: item.observedAt,
          state: item.state,
          terminalAt: item.terminalAt,
        };
      }),
    }));
    return createStateSnapshot({
      schemaVersion: "15",
      generatedAt: value.generatedAt,
      trackingStartAt: value.trackingStartAt,
      ai: value.ai,
      collection: {
        repositories: collectionRepositories,
      },
      repositories: value.repositories,
      items: migratedItems,
      externalReferences: value.externalReferences,
      relations: value.relations,
      run: value.run,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

function migrateVersion14StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion14(source);
    return createStateSnapshot({
      ...value,
      schemaVersion: "15",
      items: value.items.map((item) => ({
        ...item,
        personalReminderCauses: [],
        personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
      })),
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

/** snapshotをschema versionに応じて現行形式へ変換する。 */
export function migrateStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
): StateSnapshot {
  const versionResult = snapshotVersionSchema.safeParse(parseJson(source));
  if (!versionResult.success) {
    throw StateFormatError.fromZodError("snapshot", versionResult.error);
  }
  switch (versionResult.data.schemaVersion) {
    case "10":
      return migrateLegacyStateSnapshot(source, legacyEntriesByCacheKey);
    case "11":
      return migrateVersion11StateSnapshot(source);
    case "12":
      return migrateVersion12StateSnapshot(source);
    case "13":
      return migrateVersion13StateSnapshot(source);
    case "14":
      return migrateVersion14StateSnapshot(source);
    case "15":
      return parseStateSnapshot(source);
    default:
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotのschemaVersionは未対応です"),
      });
  }
}

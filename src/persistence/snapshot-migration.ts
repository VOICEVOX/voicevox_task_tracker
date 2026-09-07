import { z } from "zod";

import {
  aiAnalysisElementEvidenceSchema,
  aiAnalysisImportanceSchema,
  aiAnalysisNextActionSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisElementValueSchema,
  type AiAnalysisElement,
  type AiAnalysisElementResult,
} from "../domain/ai-analysis-elements.js";
import { type TrackedItemAiAnalysisMigrationAdoptedElements } from "../domain/index.js";
import { type AiCacheKey } from "../codex/cache.js";
import { type LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { parseSha256Hash, serializeCanonicalJson } from "./canonical-json.js";
import { StateFormatError, StateSnapshotSemanticError } from "./errors.js";
import {
  createStateSnapshot,
  parseStateSnapshot,
  type SnapshotAnalysisPlanFingerprint,
  type StateSnapshot,
} from "./snapshot.js";

const legacyStatusSchema = aiAnalysisStatusSchema;
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
  relations: z.array(z.unknown()),
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
type MutablePartial<Value> = {
  -readonly [Key in keyof Value]?: Value[Key];
};

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
  return Object.freeze(
    values.slice(0, 30).map((value) =>
      aiAnalysisElementEvidenceSchema.parse({
        sourceId: value.sourceId,
        summary: value.summary,
      }),
    ),
  );
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
        : undefined;
  const selected =
    supports == null
      ? output.evidence
      : output.evidence.filter((value) => value.supports === supports);
  return resultEvidence(selected.length === 0 ? fallback : selected);
}

function createMigrationResult(
  element: AiAnalysisElement,
  value: unknown,
  evidence: readonly z.output<typeof aiAnalysisElementEvidenceSchema>[],
  confidence: number,
  uncertainties: readonly string[],
): AiAnalysisElementResult {
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
      return createAiAnalysisElementResultSchema("status").parse(common);
    case "waitingOn":
      return createAiAnalysisElementResultSchema("waitingOn").parse(common);
    case "nextAction":
      return createAiAnalysisElementResultSchema("nextAction").parse(common);
    case "relations":
      return createAiAnalysisElementResultSchema("relations").parse(common);
    case "progress":
      return createAiAnalysisElementResultSchema("progress").parse(common);
    case "importance":
      return createAiAnalysisElementResultSchema("importance").parse(common);
    case "deadline":
      return createAiAnalysisElementResultSchema("deadline").parse(common);
    case "notification":
      return createAiAnalysisElementResultSchema("notification").parse(common);
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

function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "importance",
): AiAnalysisElementResult<"importance"> | undefined;
function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "deadline",
): AiAnalysisElementResult<"deadline"> | undefined;
function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "importance" | "deadline",
): AiAnalysisElementResult | undefined {
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
  return createAiAnalysisElementResultSchema(element).parse(result);
}

function createLegacyAdoptedElements(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  const adopted: MutablePartial<TrackedItemAiAnalysisMigrationAdoptedElements> = {};
  const importance = createAssessmentResult(item, output, "importance");
  if (importance != null) {
    adopted.importance = {
      origin: "migration",
      result: importance,
    };
  }
  const deadline = createAssessmentResult(item, output, "deadline");
  if (deadline != null) {
    adopted.deadline = {
      origin: "migration",
      result: deadline,
    };
  }
  if (output != null && item.severityContext.decisionBasis === "ai_only") {
    if (equalJson(output.status, item.status)) {
      adopted.status = {
        origin: "migration",
        result: createAiAnalysisElementResultSchema("status").parse(
          createMigrationResult(
            "status",
            item.status,
            outputEvidenceForElement(output, "status", item.evidence),
            output.confidence,
            output.uncertainties,
          ),
        ),
      };
    }
    if (equalJson(output.waitingOn, item.waitingOn)) {
      adopted.waitingOn = {
        origin: "migration",
        result: createAiAnalysisElementResultSchema("waitingOn").parse(
          createMigrationResult(
            "waitingOn",
            item.waitingOn,
            outputEvidenceForElement(output, "waitingOn", item.evidence),
            output.confidence,
            output.uncertainties,
          ),
        ),
      };
    }
    if (equalJson(output.nextAction, item.nextAction)) {
      adopted.nextAction = {
        origin: "migration",
        result: createAiAnalysisElementResultSchema("nextAction").parse(
          createMigrationResult(
            "nextAction",
            item.nextAction,
            outputEvidenceForElement(output, "nextAction", item.evidence),
            output.confidence,
            output.uncertainties,
          ),
        ),
      };
    }
  }
  return Object.freeze(adopted);
}

function migrateTrackedItem(
  item: LegacyTrackedItem,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
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
      adoptedElements: createLegacyAdoptedElements(item, output),
    },
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

function migrateLegacyStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
): StateSnapshot {
  try {
    const value = legacySnapshotSchema.parse(parseJson(source));
    const migratedItems = value.items.map((item) =>
      migrateTrackedItem(item, legacyEntriesByCacheKey),
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
      schemaVersion: "11",
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
      return parseStateSnapshot(source);
    default:
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotのschemaVersionは未対応です"),
      });
  }
}

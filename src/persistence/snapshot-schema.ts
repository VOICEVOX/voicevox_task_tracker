import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotAiDependencyVersion18Schema from "../../schemas/snapshot-ai-dependency-v18.schema.json" with { type: "json" };
import snapshotSchema from "../../schemas/snapshot.schema.json" with { type: "json" };
import {
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
import {
  AI_ANALYSIS_ELEMENTS_V6,
  createAiAnalysisElementGenerationSchemaV6,
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementV6,
} from "../domain/ai-analysis-source-generations.js";
import type {
  StateSnapshot,
  StateSnapshotVersion11,
  StateSnapshotVersion12,
  StateSnapshotVersion13,
  StateSnapshotVersion14,
  StateSnapshotVersion15,
  StateSnapshotVersion16,
  StateSnapshotVersion17,
  StateSnapshotVersion18,
} from "./snapshot-contracts.js";
import {
  SNAPSHOT_SCHEMA_VERSION_11,
  SNAPSHOT_SCHEMA_VERSION_12,
  SNAPSHOT_SCHEMA_VERSION_13,
  SNAPSHOT_SCHEMA_VERSION_14,
  SNAPSHOT_SCHEMA_VERSION_15,
  SNAPSHOT_SCHEMA_VERSION_16,
  SNAPSHOT_SCHEMA_VERSION_17,
  SNAPSHOT_SCHEMA_VERSION_18,
  SNAPSHOT_SCHEMA_VERSION_19,
} from "./snapshot-contracts.js";

export const snapshotSchemaVersion17Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_17),
});
export const snapshotSchemaVersion18Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_18),
});
export const snapshotSchemaVersion19Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_19),
});

export const snapshotSchemaVersion16Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_16),
});
export const snapshotSchemaVersion15Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_15),
});
export const snapshotSchemaVersion14Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_14),
});
export const snapshotSchemaVersion13Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_13),
});
export const snapshotSchemaVersion12Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_12),
});
export const snapshotSchemaVersion11Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_11),
});
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      return false;
    }
    return !Number.isNaN(Date.parse(value));
  },
});

const legacyElementMetadataSchema = aiAnalysisElementMetadataSchema.extend({
  schemaVersion: z.literal("5"),
});
const legacyElementEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1)
  .max(30);
const legacyElementMigrationEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1);

export type ElementSchemaVersion = "5" | "6" | "7" | "source";

function parseLegacyElement(
  element: z.output<typeof aiAnalysisElementSchema>,
): AiAnalysisElementV6 {
  const parsedElement = z.enum(AI_ANALYSIS_ELEMENTS_V6).safeParse(element);
  if (!parsedElement.success) {
    throw new TypeError(`旧形式に存在しないAI判定要素です。対象: ${element}`, {
      cause: parsedElement.error,
    });
  }
  return parsedElement.data;
}

export function createElementGenerationSchemaForVersion(
  element: z.output<typeof aiAnalysisElementSchema>,
  elementSchemaVersion: ElementSchemaVersion,
) {
  if (elementSchemaVersion === "source") {
    return createAiAnalysisElementSourceGenerationSchema(element);
  }
  if (elementSchemaVersion === "7") {
    return createAiAnalysisElementGenerationSchema(element);
  }
  if (elementSchemaVersion === "6") {
    return createAiAnalysisElementGenerationSchemaV6(parseLegacyElement(element));
  }
  const parsedElement = parseLegacyElement(element);
  return z.strictObject({
    metadata: legacyElementMetadataSchema,
    result: createAiAnalysisElementResultSchema(parsedElement).extend({
      evidence: legacyElementEvidenceSchema,
    }),
  });
}

export function createMigrationElementResultSchemaForVersion(
  element: z.output<typeof aiAnalysisElementSchema>,
  elementSchemaVersion: ElementSchemaVersion,
) {
  if (elementSchemaVersion === "5") {
    return createAiAnalysisMigrationElementResultSchema(parseLegacyElement(element)).extend({
      evidence: legacyElementMigrationEvidenceSchema,
    });
  }
  return createAiAnalysisMigrationElementResultSchema(element);
}

function snapshotSchemaForVersion(
  version: string,
  elementSchemaVersion: "5" | "6" | "source",
): object {
  const schema = Object.fromEntries(
    Object.entries(snapshotSchema).filter(([key]) => key !== "$id"),
  );
  const migrationAdoptedElement = snapshotSchema.$defs.aiAnalysisMigrationAdoptedElement;
  const trackedItemAiAnalysis = snapshotSchema.$defs.trackedItemAiAnalysis;
  const elementEvidence = snapshotSchema.$defs.aiAnalysisElementEvidence;
  const elementMetadata = snapshotSchema.$defs.aiAnalysisElementMetadata;
  const evidence = snapshotSchema.$defs.evidence;
  const currentVariant = migrationAdoptedElement.oneOf.at(0);
  const migrationResultVariant = migrationAdoptedElement.oneOf.at(1);
  const trackedItemCurrentVariant = trackedItemAiAnalysis.oneOf.at(0);
  const trackedItemMigrationVariant = trackedItemAiAnalysis.oneOf.at(1);
  const item = snapshotSchema.$defs.item;
  const relation = snapshotSchema.$defs.relation;
  const personalReminderCause = snapshotSchema.$defs.personalReminderCause;
  const personalReminderCausePlanning = snapshotSchema.$defs.personalReminderCausePlanning;
  const personalReminderEvaluationAttempt = snapshotSchema.$defs.personalReminderEvaluationAttempt;
  const personalReminderFailedVariant = personalReminderEvaluationAttempt.oneOf.at(2);
  const personalReminderDeferredVariant = personalReminderEvaluationAttempt.oneOf.at(3);
  if (currentVariant == null || migrationResultVariant == null) {
    throw new TypeError("snapshot schemaの移行要素定義が不正です");
  }
  if (trackedItemCurrentVariant == null || trackedItemMigrationVariant == null) {
    throw new TypeError("snapshot schemaのAI分析定義が不正です");
  }
  if (personalReminderFailedVariant == null || personalReminderDeferredVariant == null) {
    throw new TypeError("snapshot schemaのpersonal reminder評価定義が不正です");
  }
  const legacyPersonalReminderCause = {
    ...personalReminderCause,
    required: personalReminderCause.required.filter(
      (key) => key !== "aiDependencies" && key !== "responseMembershipAssessmentRequirement",
    ),
    properties: {
      ...Object.fromEntries(
        Object.entries(personalReminderCause.properties).filter(
          ([key]) =>
            key !== "aiDependencies" &&
            key !== "responseMembershipAssessmentRequirement" &&
            key !== "currentInput",
        ),
      ),
      currentInput: {
        ...personalReminderCause.properties.currentInput,
        required: personalReminderCause.properties.currentInput.required.filter(
          (key) => key !== "aiDependency",
        ),
        properties: Object.fromEntries(
          Object.entries(personalReminderCause.properties.currentInput.properties).filter(
            ([key]) => key !== "aiDependency",
          ),
        ),
      },
    },
  };
  const legacyPersonalReminderCausePlanning = {
    ...personalReminderCausePlanning,
    oneOf: personalReminderCausePlanning.oneOf.map((variant) => {
      if (variant.properties.status.const !== "completed") {
        return variant;
      }
      return {
        ...variant,
        required: variant.required.filter(
          (key) => key !== "causeSetAiDependency" && key !== "causeSetSubjectChanges",
        ),
        properties: Object.fromEntries(
          Object.entries(variant.properties).filter(
            ([key]) => key !== "causeSetAiDependency" && key !== "causeSetSubjectChanges",
          ),
        ),
      };
    }),
  };
  const trackedItemCurrentVariantWithoutApplications = {
    ...trackedItemCurrentVariant,
    required: trackedItemCurrentVariant.required.filter((key) => key !== "applications"),
    properties: Object.fromEntries(
      Object.entries(trackedItemCurrentVariant.properties).filter(
        ([key]) => key !== "applications",
      ),
    ),
  };
  const trackedItemMigrationVariantWithoutApplications = {
    ...trackedItemMigrationVariant,
    required: trackedItemMigrationVariant.required.filter((key) => key !== "applications"),
    properties: Object.fromEntries(
      Object.entries(trackedItemMigrationVariant.properties).filter(
        ([key]) => key !== "applications",
      ),
    ),
  };
  const trackedItemAiAnalysisWithoutApplications = {
    ...trackedItemAiAnalysis,
    oneOf: [
      trackedItemCurrentVariantWithoutApplications,
      trackedItemMigrationVariantWithoutApplications,
    ],
  };
  const versionedItem =
    version === SNAPSHOT_SCHEMA_VERSION_15 ||
    version === SNAPSHOT_SCHEMA_VERSION_16 ||
    version === SNAPSHOT_SCHEMA_VERSION_17 ||
    version === SNAPSHOT_SCHEMA_VERSION_18
      ? item
      : {
          ...item,
          required: item.required.filter(
            (key) => key !== "personalReminderCauses" && key !== "personalReminderCausePlanning",
          ),
          properties: Object.fromEntries(
            Object.entries(item.properties).filter(
              ([key]) =>
                key !== "personalReminderCauses" && key !== "personalReminderCausePlanning",
            ),
          ),
        };
  const versionedItemWithoutAiDependencies =
    version === SNAPSHOT_SCHEMA_VERSION_18
      ? versionedItem
      : {
          ...versionedItem,
          required: versionedItem.required.filter((key) => key !== "aiDependencies"),
          properties: Object.fromEntries(
            Object.entries(versionedItem.properties).filter(([key]) => key !== "aiDependencies"),
          ),
        };
  const versionedRelation =
    version === SNAPSHOT_SCHEMA_VERSION_18
      ? relation
      : {
          ...relation,
          required: relation.required.filter((key) => key !== "aiDependency"),
          properties: Object.fromEntries(
            Object.entries(relation.properties).filter(([key]) => key !== "aiDependency"),
          ),
        };
  const legacyAiAnalysisElements = {
    ...snapshotSchema.$defs.aiAnalysisElements,
    properties: {
      status: { $ref: "#/$defs/aiAnalysisGenerationStatus" },
      waitingOn: { $ref: "#/$defs/aiAnalysisGenerationWaitingOn" },
      nextAction: { $ref: "#/$defs/aiAnalysisGenerationNextAction" },
      relations: { $ref: "#/$defs/aiAnalysisGenerationRelations" },
      progress: { $ref: "#/$defs/aiAnalysisGenerationProgress" },
      importance: { $ref: "#/$defs/aiAnalysisGenerationImportance" },
      deadline: { $ref: "#/$defs/aiAnalysisGenerationDeadline" },
      notification: { $ref: "#/$defs/aiAnalysisGenerationNotification" },
    },
  };
  const legacyAiAnalysisMigrationAdoptedElements = {
    ...snapshotSchema.$defs.aiAnalysisMigrationAdoptedElements,
    properties: {
      status: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      waitingOn: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      nextAction: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      relations: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      progress: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      importance: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      deadline: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
      notification: { $ref: "#/$defs/aiAnalysisMigrationAdoptedElement" },
    },
  };
  const evidenceProperties = Object.fromEntries(
    Object.entries(elementEvidence.properties).filter(([key]) =>
      elementSchemaVersion === "5" ? key !== "supports" : true,
    ),
  );
  const evidenceRequired =
    elementSchemaVersion === "5"
      ? elementEvidence.required.filter((key) => key !== "supports")
      : elementEvidence.required;
  const versionedEvidence =
    elementSchemaVersion === "5"
      ? {
          ...evidence,
          properties: {
            ...evidence.properties,
            supports: {
              enum: ["status", "waiting_on", "relation", "progress", "notification", "uncertainty"],
            },
          },
        }
      : evidence;
  const legacyCurrentVariant = {
    ...currentVariant,
    required: currentVariant.required.filter((key) => key !== "reuseProof" && key !== "result"),
    properties: Object.fromEntries(
      Object.entries(currentVariant.properties).filter(
        ([key]) => key !== "reuseProof" && key !== "result",
      ),
    ),
  };
  const legacyMigrationResultVariant = {
    ...migrationResultVariant,
    required: migrationResultVariant.required.filter((key) => key !== "reuseProof"),
    properties: Object.fromEntries(
      Object.entries(migrationResultVariant.properties).filter(([key]) => key !== "reuseProof"),
    ),
  };
  const versionedMigrationAdoptedElement =
    version === SNAPSHOT_SCHEMA_VERSION_14 ||
    version === SNAPSHOT_SCHEMA_VERSION_15 ||
    version === SNAPSHOT_SCHEMA_VERSION_16 ||
    version === SNAPSHOT_SCHEMA_VERSION_17 ||
    version === SNAPSHOT_SCHEMA_VERSION_18
      ? migrationAdoptedElement
      : {
          ...migrationAdoptedElement,
          oneOf: [
            legacyCurrentVariant,
            version === SNAPSHOT_SCHEMA_VERSION_11
              ? {
                  ...legacyMigrationResultVariant,
                  properties: {
                    ...legacyMigrationResultVariant.properties,
                    result: {
                      $ref: "#/$defs/aiAnalysisResult",
                    },
                  },
                }
              : legacyMigrationResultVariant,
          ],
        };
  const legacyPersonalReminderFailedVariant = {
    ...personalReminderFailedVariant,
    required: personalReminderFailedVariant.required.filter((key) => key !== "rulesVersion"),
    properties: Object.fromEntries(
      Object.entries(personalReminderFailedVariant.properties).filter(
        ([key]) => key !== "rulesVersion",
      ),
    ),
  };
  const legacyPersonalReminderDeferredVariant = {
    ...personalReminderDeferredVariant,
    required: personalReminderDeferredVariant.required.filter((key) => key !== "rulesVersion"),
    properties: Object.fromEntries(
      Object.entries(personalReminderDeferredVariant.properties).filter(
        ([key]) => key !== "rulesVersion",
      ),
    ),
  };
  const legacyPersonalReminderDeferredVariantForVersion15 = {
    ...legacyPersonalReminderDeferredVariant,
    properties: {
      ...legacyPersonalReminderDeferredVariant.properties,
      reason: {
        enum: [
          "upstream_relation",
          "input_incomplete",
          "item_input_character_limit",
          "call_limit",
          "total_input_character_limit",
          "estimated_cost_limit",
        ],
      },
    },
  };
  const versionedPersonalReminderDeferredVariant =
    version === SNAPSHOT_SCHEMA_VERSION_15
      ? legacyPersonalReminderDeferredVariantForVersion15
      : legacyPersonalReminderDeferredVariant;
  const versionedPersonalReminderEvaluationAttempt =
    version === SNAPSHOT_SCHEMA_VERSION_15 ||
    version === SNAPSHOT_SCHEMA_VERSION_16 ||
    version === SNAPSHOT_SCHEMA_VERSION_17
      ? {
          ...personalReminderEvaluationAttempt,
          oneOf: [
            ...personalReminderEvaluationAttempt.oneOf.slice(0, 2),
            legacyPersonalReminderFailedVariant,
            versionedPersonalReminderDeferredVariant,
            ...personalReminderEvaluationAttempt.oneOf.slice(4),
          ],
        }
      : personalReminderEvaluationAttempt;
  let versionedTrackedItemAiAnalysis: object;
  if (version === SNAPSHOT_SCHEMA_VERSION_17 || version === SNAPSHOT_SCHEMA_VERSION_18) {
    versionedTrackedItemAiAnalysis = trackedItemAiAnalysis;
  } else if (
    version === SNAPSHOT_SCHEMA_VERSION_14 ||
    version === SNAPSHOT_SCHEMA_VERSION_15 ||
    version === SNAPSHOT_SCHEMA_VERSION_16
  ) {
    versionedTrackedItemAiAnalysis = trackedItemAiAnalysisWithoutApplications;
  } else {
    versionedTrackedItemAiAnalysis = {
      ...trackedItemAiAnalysis,
      oneOf: [
        {
          ...trackedItemCurrentVariantWithoutApplications,
          properties: {
            ...trackedItemCurrentVariantWithoutApplications.properties,
            elements: {
              $ref: "#/$defs/aiAnalysisElements",
            },
            adoptedElements: {
              $ref: "#/$defs/aiAnalysisElements",
            },
          },
        },
        {
          ...trackedItemMigrationVariantWithoutApplications,
          properties: {
            ...trackedItemMigrationVariantWithoutApplications.properties,
            elements: {
              $ref: "#/$defs/aiAnalysisElements",
            },
            adoptedElements: {
              $ref: "#/$defs/aiAnalysisMigrationAdoptedElements",
            },
          },
        },
      ],
    };
  }
  return {
    ...schema,
    required:
      version === SNAPSHOT_SCHEMA_VERSION_18
        ? snapshotSchema.required
        : snapshotSchema.required.filter((key) => key !== "graphNodeStateObservations"),
    $defs: {
      ...snapshotSchema.$defs,
      ...(version === SNAPSHOT_SCHEMA_VERSION_18 ? snapshotAiDependencyVersion18Schema : {}),
      evidence: versionedEvidence,
      personalReminderEvaluationAttempt: versionedPersonalReminderEvaluationAttempt,
      aiAnalysisElementEvidence: {
        ...elementEvidence,
        required: evidenceRequired,
        properties: evidenceProperties,
      },
      aiAnalysisElementMetadata: {
        ...elementMetadata,
        properties: {
          ...elementMetadata.properties,
          schemaVersion: {
            const: elementSchemaVersion === "source" ? "7" : elementSchemaVersion,
          },
        },
      },
      aiAnalysisMigrationAdoptedElement: versionedMigrationAdoptedElement,
      aiAnalysisElements:
        version === SNAPSHOT_SCHEMA_VERSION_14 ||
        version === SNAPSHOT_SCHEMA_VERSION_15 ||
        version === SNAPSHOT_SCHEMA_VERSION_16 ||
        version === SNAPSHOT_SCHEMA_VERSION_17 ||
        version === SNAPSHOT_SCHEMA_VERSION_18
          ? snapshotSchema.$defs.aiAnalysisElements
          : legacyAiAnalysisElements,
      aiAnalysisMigrationAdoptedElements:
        version === SNAPSHOT_SCHEMA_VERSION_14 ||
        version === SNAPSHOT_SCHEMA_VERSION_15 ||
        version === SNAPSHOT_SCHEMA_VERSION_16 ||
        version === SNAPSHOT_SCHEMA_VERSION_17 ||
        version === SNAPSHOT_SCHEMA_VERSION_18
          ? snapshotSchema.$defs.aiAnalysisMigrationAdoptedElements
          : legacyAiAnalysisMigrationAdoptedElements,
      trackedItemAiAnalysis: versionedTrackedItemAiAnalysis,
      personalReminderCause:
        version === SNAPSHOT_SCHEMA_VERSION_18
          ? personalReminderCause
          : legacyPersonalReminderCause,
      personalReminderCausePlanning:
        version === SNAPSHOT_SCHEMA_VERSION_18
          ? personalReminderCausePlanning
          : legacyPersonalReminderCausePlanning,
      item: versionedItemWithoutAiDependencies,
      relation: versionedRelation,
    },
    properties: {
      ...Object.fromEntries(
        Object.entries(snapshotSchema.properties).filter(
          ([key]) => version === SNAPSHOT_SCHEMA_VERSION_18 || key !== "graphNodeStateObservations",
        ),
      ),
      schemaVersion: {
        const: version,
      },
    },
  };
}

export const validateSnapshotVersion11Schema = ajv.compile<StateSnapshotVersion11>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_11, "5"),
);
export const validateSnapshotVersion12Schema = ajv.compile<StateSnapshotVersion12>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_12, "5"),
);
export const validateSnapshotVersion13Schema = ajv.compile<StateSnapshotVersion13>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_13, "6"),
);
export const validateSnapshotVersion14Schema = ajv.compile<StateSnapshotVersion14>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_14, "source"),
);
export const validateSnapshotVersion15Schema = ajv.compile<StateSnapshotVersion15>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_15, "source"),
);
export const validateSnapshotVersion16Schema = ajv.compile<StateSnapshotVersion16>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_16, "source"),
);
export const validateSnapshotVersion17Schema = ajv.compile<StateSnapshotVersion17>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_17, "source"),
);
export const validateSnapshotVersion18Schema = ajv.compile<StateSnapshotVersion18>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_18, "source"),
);
export const validateSnapshotVersion19Schema = ajv.compile<StateSnapshot>(snapshotSchema);

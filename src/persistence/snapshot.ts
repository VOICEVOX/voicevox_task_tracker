import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotSchema from "../../schemas/snapshot.schema.json" with { type: "json" };
import {
  hashCanonicalJson,
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "./canonical-json.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import {
  type Attention,
  type Actor,
  isTerminalStatus,
  type ExternalGhostNode,
  type GitHubAccountActor,
  type GitHubNodeId,
  type GraphNodeId,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
  currentPersonalReminderAssessment,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
  type PersonalReminderEvaluationAttempt,
  personalReminderCauseAiDependenciesSchema,
  personalReminderCauseSchema,
  personalReminderCausePlanningSchema,
  type Relation,
  type Repository,
  type Severity,
  type StalenessSeverityContext,
  type TrackingStartAtState,
  type TrackedItem,
  type TrackedItemState,
  type TrackedItemAiDependencies,
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type AiAnalysisDependencyProducer,
  type TrackedItemAiAnalysis,
  type UtcIsoDateTime,
  validateDeadlineDate,
} from "../domain/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementSchema,
  aiAnalysisElementApplicationUsesAiValue,
  type AiAnalysisElement,
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementApplicationsSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
import {
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForMissingRelationCandidateAssessment,
  aiAnalysisDependencyForRelation,
  aiAnalysisDependencyForRelationCandidate,
  aiAnalysisDependencySchema,
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
  trackedItemAiDependenciesSchema,
} from "../domain/ai-analysis-dependencies.js";
import { personalReminderCauseSetSubjectChangesAreUnbounded } from "../domain/personal-reminder-causes.js";
import {
  analyzeGraph,
  analyzeGraphAiDependencies,
  type BlockerNodeAiDependency,
  type GraphAnalysisNode,
  type ReconciledGraphEdge,
  type RelationCandidateDecisionProof,
  type RelationCandidateId,
} from "../graph/index.js";
import {
  AI_ANALYSIS_ELEMENTS_V6,
  createAiAnalysisElementGenerationSchemaV6,
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementV6,
} from "../domain/ai-analysis-source-generations.js";
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
} from "../codex/analysis-elements.js";
import { type PublicRepositoryId, type Sha256Fingerprint } from "../github/index.js";
import { UnreachableError } from "../util/index.js";

type PublicSnapshotRepositoryFields = Repository &
  Readonly<{
    visibility: "public";
    archived: false;
    disabled: false;
  }>;

/** snapshotへ保存する公開リポジトリの最新取得状態。 */
export type SnapshotRepository =
  | (PublicSnapshotRepositoryFields &
      Readonly<{
        freshness: "fresh";
      }>)
  | (PublicSnapshotRepositoryFields &
      Readonly<{
        freshness: "stale";
        failedAt: UtcIsoDateTime;
      }>);

/** snapshotへ保存するseverityと要対応度付き追跡項目。 */
export type SnapshotTrackedItem = TrackedItem &
  Readonly<{
    attention: Attention;
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
    severity: Severity;
    severityContext: StalenessSeverityContext;
  }>;

/** 次回の増分収集計画とterminal保持判定へ渡す軽量な項目観測値。 */
export type SnapshotAnalysisPlanFingerprint =
  | Readonly<{
      status: "planned";
      fingerprint: Sha256Fingerprint;
    }>
  | Readonly<{
      status: "unplanned";
      reason: "migration" | "detail_required";
    }>;

export type SnapshotCollectionItem = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  itemFingerprint: Sha256Fingerprint;
  analysisPlanFingerprint: SnapshotAnalysisPlanFingerprint;
  aiAnalysis: TrackedItemAiAnalysis;
  observedAt: UtcIsoDateTime;
}> &
  (
    | Readonly<{
        state: "open";
        terminalAt: null;
      }>
    | Readonly<{
        state: "closed";
        terminalAt: UtcIsoDateTime;
      }>
  );

/** repository単位の最終成功時刻と項目fingerprint。 */
export type SnapshotCollectionRepository = Readonly<{
  repositoryId: PublicRepositoryId;
  successfulAt: UtcIsoDateTime;
  items: readonly SnapshotCollectionItem[];
}>;

/** 次回runへ引き継ぐ本番収集の軽量state。 */
export type SnapshotCollectionState = Readonly<{
  repositories: readonly SnapshotCollectionRepository[];
}>;

/** 関係先から取得した追跡項目のgraph用状態観測。 */
export type SnapshotGraphNodeStateObservation = Readonly<{
  nodeId: GitHubNodeId;
  state: TrackedItemState;
  observedAt: UtcIsoDateTime;
}>;

/** snapshotへ保存するAIの有効状態、利用可否、縮退状態。 */
export type SnapshotAiState =
  | Readonly<{
      enabled: false;
      available: false;
      degraded: false;
    }>
  | Readonly<{
      enabled: true;
      available: true;
      degraded: boolean;
    }>
  | Readonly<{
      enabled: true;
      available: false;
      degraded: true;
    }>;

/** 完全runだけを表すsnapshot内のrun情報。 */
export type SnapshotRun = Readonly<{
  id: string;
  status: "success" | "fallback";
  complete: true;
}>;

const SNAPSHOT_SCHEMA_VERSION_11 = "11";
const SNAPSHOT_SCHEMA_VERSION_12 = "12";
export const SNAPSHOT_SCHEMA_VERSION_13 = "13";
export const SNAPSHOT_SCHEMA_VERSION_14 = "14";
export const SNAPSHOT_SCHEMA_VERSION_15 = "15";
export const SNAPSHOT_SCHEMA_VERSION_16 = "16";
export const SNAPSHOT_SCHEMA_VERSION_17 = "17";
export const SNAPSHOT_SCHEMA_VERSION_18 = "18";

type StateSnapshotFields = Readonly<{
  generatedAt: UtcIsoDateTime;
  trackingStartAt: TrackingStartAtState;
  ai: SnapshotAiState;
  collection: SnapshotCollectionState;
  repositories: readonly SnapshotRepository[];
  items: readonly SnapshotTrackedItem[];
  graphNodeStateObservations: readonly SnapshotGraphNodeStateObservation[];
  externalReferences: readonly ExternalGhostNode[];
  relations: readonly Relation[];
  run: SnapshotRun;
}>;

type LegacySnapshotTrackedItemWithoutAiDependencies = Omit<SnapshotTrackedItem, "aiDependencies">;
type LegacyRelationWithoutAiDependency = Omit<Relation, "aiDependency">;
type LegacyStateSnapshotFieldsWithoutAiDependencies = Omit<
  StateSnapshotFields,
  "items" | "graphNodeStateObservations" | "relations"
> &
  Readonly<{
    items: readonly LegacySnapshotTrackedItemWithoutAiDependencies[];
    relations: readonly LegacyRelationWithoutAiDependency[];
  }>;

type LegacyTrackedItemAiAnalysis =
  | (Omit<Extract<TrackedItemAiAnalysis, { origin: "current" }>, "applications"> &
      Readonly<{
        applications?: never;
      }>)
  | (Omit<Extract<TrackedItemAiAnalysis, { origin: "migration" }>, "applications"> &
      Readonly<{
        applications?: never;
      }>);

/** AI依存が保存される前のpersonal reminder causeのcurrent input。 */
export type LegacyPersonalReminderCauseCurrentInput = Omit<
  PersonalReminderCause["currentInput"],
  "aiDependency"
> &
  Readonly<{
    aiDependency?: never;
  }>;

type LegacyPersonalReminderEvaluationAttempt =
  | Extract<PersonalReminderEvaluationAttempt, { status: "not_evaluated" }>
  | Extract<PersonalReminderEvaluationAttempt, { status: "completed" }>
  | Omit<Extract<PersonalReminderEvaluationAttempt, { status: "failed" }>, "rulesVersion">
  | Omit<Extract<PersonalReminderEvaluationAttempt, { status: "deferred" }>, "rulesVersion">;

/** AI依存が保存される前のpersonal reminder cause。 */
export type LegacyPersonalReminderCause = Omit<
  PersonalReminderCause,
  "aiDependencies" | "responseMembershipAssessmentRequirement" | "currentInput" | "latestAttempt"
> &
  Readonly<{
    aiDependencies?: never;
    responseMembershipAssessmentRequirement?: never;
    currentInput: LegacyPersonalReminderCauseCurrentInput;
    latestAttempt: LegacyPersonalReminderEvaluationAttempt;
  }>;

/** AI依存が保存される前のcompletedなpersonal reminder cause planning。 */
export type LegacyPersonalReminderCausePlanningCompleted = Omit<
  Extract<PersonalReminderCausePlanning, { status: "completed" }>,
  "causeSetAiDependency" | "causeSetSubjectChanges"
> &
  Readonly<{
    causeSetAiDependency?: never;
    causeSetSubjectChanges?: never;
  }>;

/** AI依存が保存される前のpersonal reminder cause planning。 */
export type LegacyPersonalReminderCausePlanning =
  | Extract<PersonalReminderCausePlanning, { status: "pending" }>
  | LegacyPersonalReminderCausePlanningCompleted
  | Extract<PersonalReminderCausePlanning, { status: "excluded" }>;

type SnapshotTrackedItemPersonalReminderCommonFields = Pick<
  SnapshotTrackedItem,
  "nodeId" | "status" | "createdAt" | "observedAt"
>;
type SnapshotTrackedItemPersonalReminderFields =
  | (SnapshotTrackedItemPersonalReminderCommonFields &
      Readonly<{
        personalReminderCauses: readonly PersonalReminderCause[];
        personalReminderCausePlanning: PersonalReminderCausePlanning;
      }>)
  | (SnapshotTrackedItemPersonalReminderCommonFields &
      Readonly<{
        personalReminderCauses: readonly LegacyPersonalReminderCause[];
        personalReminderCausePlanning: LegacyPersonalReminderCausePlanning;
      }>);
type LegacySnapshotTrackedItem = Omit<
  SnapshotTrackedItem,
  "personalReminderCauses" | "personalReminderCausePlanning" | "aiAnalysis" | "aiDependencies"
> &
  Readonly<{
    aiAnalysis: LegacyTrackedItemAiAnalysis;
  }>;
type LegacySnapshotTrackedItemWithPersonalReminder = Omit<
  SnapshotTrackedItem,
  "aiAnalysis" | "aiDependencies" | "personalReminderCauses" | "personalReminderCausePlanning"
> &
  Readonly<{
    aiAnalysis: LegacyTrackedItemAiAnalysis;
    personalReminderCauses: readonly LegacyPersonalReminderCause[];
    personalReminderCausePlanning: LegacyPersonalReminderCausePlanning;
  }>;
type LegacySnapshotTrackedItemWithPersonalReminderVersion17 = Omit<
  SnapshotTrackedItem,
  "aiDependencies" | "personalReminderCauses" | "personalReminderCausePlanning"
> &
  Readonly<{
    personalReminderCauses: readonly LegacyPersonalReminderCause[];
    personalReminderCausePlanning: LegacyPersonalReminderCausePlanning;
  }>;
type SnapshotItemForRelationValidation =
  | SnapshotTrackedItem
  | LegacySnapshotTrackedItemWithoutAiDependencies
  | LegacySnapshotTrackedItem
  | LegacySnapshotTrackedItemWithPersonalReminder
  | LegacySnapshotTrackedItemWithPersonalReminderVersion17;
type LegacySnapshotCollectionItem = Omit<
  SnapshotCollectionItem,
  "aiAnalysis" | "state" | "terminalAt"
> &
  Readonly<{
    aiAnalysis: LegacyTrackedItemAiAnalysis;
  }> &
  (
    | Readonly<{
        state: "open";
        terminalAt: null;
      }>
    | Readonly<{
        state: "closed";
        terminalAt: UtcIsoDateTime;
      }>
  );
type LegacySnapshotCollectionRepository = Omit<SnapshotCollectionRepository, "items"> &
  Readonly<{
    items: readonly LegacySnapshotCollectionItem[];
  }>;
type LegacySnapshotCollectionState = Omit<SnapshotCollectionState, "repositories"> &
  Readonly<{
    repositories: readonly LegacySnapshotCollectionRepository[];
  }>;
type LegacyStateSnapshotFields = Omit<
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  "collection" | "items"
> &
  Readonly<{
    collection: LegacySnapshotCollectionState;
    items: readonly LegacySnapshotTrackedItem[];
  }>;
type LegacyStateSnapshotFieldsWithPersonalReminder = Omit<
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  "collection" | "items"
> &
  Readonly<{
    collection: LegacySnapshotCollectionState;
    items: readonly LegacySnapshotTrackedItemWithPersonalReminder[];
  }>;
type LegacyStateSnapshotFieldsWithPersonalReminderVersion17 = Omit<
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  "items"
> &
  Readonly<{
    items: readonly LegacySnapshotTrackedItemWithPersonalReminderVersion17[];
  }>;

type StateSnapshotVersion11 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_11;
  }>;
type StateSnapshotVersion12 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_12;
  }>;
type StateSnapshotVersion13 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_13;
  }>;
type StateSnapshotVersion14 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_14;
  }>;

type StateSnapshotVersion15 = LegacyStateSnapshotFieldsWithPersonalReminder &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_15;
  }>;

type StateSnapshotVersion16 = LegacyStateSnapshotFieldsWithPersonalReminder &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_16;
  }>;

type StateSnapshotVersion17 = LegacyStateSnapshotFieldsWithPersonalReminderVersion17 &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_17;
  }>;

type StateSnapshotVersion18 = StateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_18;
  }>;

/** tracker-stateへ保存するschema version 18のcurrent snapshot。 */
export type StateSnapshot = StateSnapshotVersion18;

const snapshotSchemaVersion17Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_17),
});
const snapshotSchemaVersion18Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_18),
});

const snapshotSchemaVersion16Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_16),
});
const snapshotSchemaVersion15Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_15),
});
const snapshotSchemaVersion14Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_14),
});
const snapshotSchemaVersion13Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_13),
});
const snapshotSchemaVersion12Schema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_12),
});
const snapshotSchemaVersion11Schema = z.object({
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

type ElementSchemaVersion = "5" | "6" | "7" | "source";

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

function createElementGenerationSchemaForVersion(
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

function createMigrationElementResultSchemaForVersion(
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

const validateSnapshotVersion11Schema = ajv.compile<StateSnapshotVersion11>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_11, "5"),
);
const validateSnapshotVersion12Schema = ajv.compile<StateSnapshotVersion12>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_12, "5"),
);
const validateSnapshotVersion13Schema = ajv.compile<StateSnapshotVersion13>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_13, "6"),
);
const validateSnapshotVersion14Schema = ajv.compile<StateSnapshotVersion14>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_14, "source"),
);
const validateSnapshotVersion15Schema = ajv.compile<StateSnapshotVersion15>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_15, "source"),
);
const validateSnapshotVersion16Schema = ajv.compile<StateSnapshotVersion16>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_16, "source"),
);
const validateSnapshotVersion17Schema = ajv.compile<StateSnapshotVersion17>(
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_17, "source"),
);
const validateSnapshotVersion18Schema = ajv.compile<StateSnapshotVersion18>(snapshotSchema);

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertUnique(values: readonly string[], description: string): void {
  if (new Set(values).size !== values.length) {
    throw new StateSnapshotSemanticError(`${description}が重複しています`);
  }
}

function assertUtcDateTime(value: string, description: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new StateSnapshotSemanticError(`${description}はUTCへ正規化してください`);
  }
}

type SnapshotGraphStateSource = Readonly<{
  items: readonly Pick<SnapshotTrackedItem, "nodeId" | "state">[];
  externalReferences: readonly Pick<ExternalGhostNode, "nodeId" | "state">[];
  graphNodeStateObservations?: readonly SnapshotGraphNodeStateObservation[];
}>;

function effectiveGraphStateByNodeId(
  snapshot: SnapshotGraphStateSource,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  const stateByNodeId = new Map<GraphNodeId, TrackedItemState>();
  for (const item of snapshot.items) {
    stateByNodeId.set(item.nodeId, item.state);
  }
  for (const reference of snapshot.externalReferences) {
    stateByNodeId.set(reference.nodeId, reference.state);
  }
  for (const observation of snapshot.graphNodeStateObservations ?? []) {
    stateByNodeId.set(observation.nodeId, observation.state);
  }
  return stateByNodeId;
}

function effectiveGraphStateForNode(
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
  nodeId: GraphNodeId,
): TrackedItemState {
  const state = stateByNodeId.get(nodeId);
  if (state == null) {
    throw new StateSnapshotSemanticError(`graph nodeの状態がありません。対象: ${nodeId}`);
  }
  return state;
}

/** snapshotに保存されたgraph用状態観測を反映したnode状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  return effectiveGraphStateByNodeId(snapshot);
}

function personalReminderSubjectIdentity(subject: {
  kind: "user" | "team";
  candidateId: string;
}): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function assertCanonicalPersonalReminderSubjects(
  subjects: readonly Readonly<{ kind: "user" | "team"; candidateId: string }>[],
  description: string,
): void {
  const identities = subjects.map(personalReminderSubjectIdentity);
  assertUnique(identities, description);
  for (let index = 1; index < identities.length; index += 1) {
    const previous = identities[index - 1];
    const current = identities[index];
    if (previous == null || current == null) {
      throw new StateSnapshotSemanticError(`${description}の並び順を検証できません`);
    }
    if (compareStrings(previous, current) > 0) {
      throw new StateSnapshotSemanticError(`${description}は正規順に並べてください`);
    }
  }
}

function assertPersonalReminderTimeBasis(
  value: PersonalReminderCause["obligationSince"],
  item: SnapshotTrackedItemPersonalReminderFields,
  description: string,
): void {
  assertUtcDateTime(value.at, description);
  if (value.at < item.createdAt || value.at > item.observedAt) {
    throw new StateSnapshotSemanticError(
      `${description}はitemの作成時刻以後かつ観測時刻以前にしてください`,
    );
  }
}

function assertPersonalReminderResponsibilitySemantics(
  cause: Pick<PersonalReminderCause, "responsibility">,
): void {
  if (cause.responsibility.authority === "fixed" && cause.responsibility.scope.kind !== "item") {
    throw new StateSnapshotSemanticError(
      "fixedなpersonal reminder責務はitem scopeでなければなりません",
    );
  }
  if (cause.responsibility.scope.kind === "item") {
    return;
  }
  const surfaceKeys = cause.responsibility.scope.surfaces.map(
    (surface) => `${surface.kind}:${surface.nodeId}`,
  );
  assertUnique(surfaceKeys, "personal reminder execution surface");
}

function assertPersonalReminderLastConfirmedActionability(
  cause: Pick<PersonalReminderCause, "lastConfirmedActionability">,
  assessment: CurrentPersonalReminderAssessment,
): void {
  if (assessment.status !== "available") {
    return;
  }
  if (assessment.result.verdict === "unknown") {
    return;
  }
  const last = cause.lastConfirmedActionability;
  if (assessment.result.verdict === "actionable") {
    if (last.status !== "confirmed" || last.verdict !== "actionable") {
      throw new StateSnapshotSemanticError(
        "有効なactionable判定がlastConfirmedActionabilityへ反映されていません",
      );
    }
    return;
  }
  if (assessment.result.verdict === "waiting") {
    if (
      last.status !== "confirmed" ||
      last.verdict !== "waiting" ||
      last.waitingFor.itemNodeId !== assessment.result.waitingFor.itemNodeId ||
      last.waitingFor.action !== assessment.result.waitingFor.action
    ) {
      throw new StateSnapshotSemanticError(
        "有効なwaiting判定がlastConfirmedActionabilityへ反映されていません",
      );
    }
    return;
  }
  if (last.status !== "confirmed" || last.verdict !== "not_actionable") {
    throw new StateSnapshotSemanticError(
      "有効なnot actionable判定がlastConfirmedActionabilityへ反映されていません",
    );
  }
  if (last.reason !== assessment.result.verdict) {
    throw new StateSnapshotSemanticError(
      "lastConfirmedActionabilityのnot actionable理由が一致しません",
    );
  }
}

function assertPersonalReminderCausesSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  causeIds: ReadonlySet<string>,
  legacyPersonalReminder: boolean,
): void {
  assertUnique(
    item.personalReminderCauses.map((cause) => cause.causeId),
    "itemのpersonal reminder cause ID",
  );
  assertUnique(
    item.personalReminderCauses.map((cause) => cause.responsibilityId),
    "itemのpersonal reminder responsibility ID",
  );
  for (const cause of item.personalReminderCauses) {
    if (!legacyPersonalReminder) {
      const parsedCause = personalReminderCauseSchema.safeParse(cause);
      if (!parsedCause.success) {
        throw new StateSnapshotSemanticError("personal reminder causeが不正です", {
          cause: parsedCause.error,
        });
      }
    }
    if (cause.itemNodeId !== item.nodeId) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのitemNodeIdが親itemと一致しません",
      );
    }
    assertPersonalReminderResponsibilitySemantics(cause);
    if (
      !legacyPersonalReminder &&
      "responseMembershipAssessmentRequirement" in cause &&
      cause.responsibility.authority === "semantic" &&
      cause.responseMembershipAssessmentRequirement.status !== "required"
    ) {
      throw new StateSnapshotSemanticError(
        "semanticなpersonal reminder責務の人物所属には意味判定が必要です",
      );
    }
    if (cause.latestAttempt.status === "completed" && cause.latestAttempt.origin.kind === "ai") {
      if (
        cause.latestAttempt.origin.metadata.inputFingerprint !==
        cause.latestAttempt.inputFingerprint
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIのlatest attemptとmetadataのinput fingerprintが一致しません",
        );
      }
    }
    if (
      cause.adoptedAssessment.status === "available" &&
      cause.adoptedAssessment.origin.kind === "ai"
    ) {
      if (
        cause.adoptedAssessment.origin.metadata.inputFingerprint !==
        cause.adoptedAssessment.inputFingerprint
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIの採用結果とmetadataのinput fingerprintが一致しません",
        );
      }
      if (
        cause.adoptedAssessment.origin.metadata.rulesVersion !==
        cause.adoptedAssessment.rulesVersion
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIの採用結果とmetadataのrules versionが一致しません",
        );
      }
      if (
        hashCanonicalJson(cause.adoptedAssessment.result) !==
        cause.adoptedAssessment.origin.metadata.outputHash
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIの採用結果とmetadataのoutput hashが一致しません",
        );
      }
    }
    if (
      cause.latestAttempt.status === "completed" &&
      cause.latestAttempt.origin.kind === "ai" &&
      cause.adoptedAssessment.status === "available"
    ) {
      if (cause.adoptedAssessment.origin.kind !== "ai") {
        throw new StateSnapshotSemanticError(
          "personal reminder AIのlatest attemptと採用結果のoriginが一致しません",
        );
      }
      if (
        cause.latestAttempt.origin.cacheEntryId !== cause.adoptedAssessment.origin.cacheEntryId ||
        serializeCanonicalJson(cause.latestAttempt.origin.metadata) !==
          serializeCanonicalJson(cause.adoptedAssessment.origin.metadata)
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIのlatest attemptと採用結果のmetadataが一致しません",
        );
      }
    }
    assertPersonalReminderTimeBasis(
      cause.obligationSince,
      item,
      "personal reminder obligationSince",
    );
    if (cause.actionableClock.status === "observed") {
      assertPersonalReminderTimeBasis(
        cause.actionableClock.actionableSince,
        item,
        "personal reminder actionableSince",
      );
      assertPersonalReminderTimeBasis(
        cause.actionableClock.stallSince,
        item,
        "personal reminder stallSince",
      );
    }
    const assessment = currentPersonalReminderAssessment(cause);
    if (
      assessment.status === "available" &&
      cause.responsibility.authority === "fixed" &&
      assessment.result.verdict === "not_required"
    ) {
      throw new StateSnapshotSemanticError(
        "fixedなpersonal reminder責務はnot_requiredへ変更できません",
      );
    }
    if (
      "responseMembershipAssessmentRequirement" in cause &&
      assessment.status === "available" &&
      (assessment.result.verdict === "duplicate" || assessment.result.verdict === "not_required") &&
      cause.responseMembershipAssessmentRequirement.status === "not_required"
    ) {
      throw new StateSnapshotSemanticError(
        "responseを除外するpersonal reminder判定には人物所属の意味判定が必要です",
      );
    }
    assertPersonalReminderLastConfirmedActionability(cause, assessment);
    if (assessment.status !== "available") {
      continue;
    }
    if (
      cause.currentInput.completeness.status === "incomplete" &&
      (assessment.result.verdict !== "unknown" || assessment.result.reason !== "incomplete_input")
    ) {
      throw new StateSnapshotSemanticError(
        "入力が不完全なpersonal reminder causeはincomplete_inputのunknownでなければなりません",
      );
    }
    if (cause.actionableClock.status === "observed") {
      if (cause.obligationSince.at > cause.actionableClock.actionableSince.at) {
        throw new StateSnapshotSemanticError(
          "personal reminder actionableSinceはobligationSince以後にしてください",
        );
      }
      if (cause.actionableClock.actionableSince.at > cause.actionableClock.stallSince.at) {
        throw new StateSnapshotSemanticError(
          "personal reminder stallSinceはactionableSince以後にしてください",
        );
      }
    }
    if (assessment.result.verdict === "actionable" && cause.actionableClock.status !== "observed") {
      throw new StateSnapshotSemanticError(
        "actionableなpersonal reminder causeにはactionable clockが必要です",
      );
    }
    if (assessment.result.verdict === "duplicate") {
      if (assessment.result.canonicalCauseId === cause.causeId) {
        throw new StateSnapshotSemanticError(
          "personal reminder causeが自分自身をduplicateの参照先にしています",
        );
      }
      if (!causeIds.has(assessment.result.canonicalCauseId)) {
        throw new StateSnapshotSemanticError(
          "personal reminder causeのduplicate参照先がsnapshotにありません",
        );
      }
    }
  }
}

function isLegacyPersonalReminder(item: SnapshotTrackedItemPersonalReminderFields): boolean {
  return (
    item.personalReminderCauses.some((cause) => !("aiDependencies" in cause)) ||
    (item.personalReminderCausePlanning.status === "completed" &&
      (!("causeSetAiDependency" in item.personalReminderCausePlanning) ||
        !("causeSetSubjectChanges" in item.personalReminderCausePlanning)))
  );
}

function assertPersonalReminderAiDependencySemantics(
  dependency: unknown,
  description: string,
  itemNodeId: GraphNodeId,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  restrictItemProducer: boolean,
  allowHiddenProducerlessSentinels: boolean,
): void {
  const dependencyValue = assertAiAnalysisDependencyIntegrity(dependency, description, {
    allowStaleRepository: false,
    allowProducerlessNotRecorded: true,
    allowProducerlessMigration: true,
    allowProducerlessStaleRepository: false,
    allowHiddenProducerlessNotRecorded: allowHiddenProducerlessSentinels,
    allowHiddenProducerlessMigration: allowHiddenProducerlessSentinels,
    allowHiddenProducerlessStaleRepository: false,
    dependencyForProducer: (producer, producerDescription, containingDependency) =>
      expectedAiAnalysisDependencyForProducer(
        producer,
        producerDescription,
        itemsByNodeId,
        relationsById,
        containingDependency,
      ),
  });
  if (dependencyValue.status === "not_dependent") {
    return;
  }
  for (const producer of dependencyValue.producers ?? []) {
    if (
      restrictItemProducer &&
      producer.kind === "relation_candidate" &&
      !producer.endpointNodeIds.includes(itemNodeId)
    ) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate endpointが親itemと一致しません`,
      );
    }
    if (
      restrictItemProducer &&
      producer.kind === "item_element" &&
      producer.nodeId !== itemNodeId
    ) {
      throw new StateSnapshotSemanticError(`${description}のitem producerが親itemと一致しません`);
    }
    if (restrictItemProducer && producer.kind === "relation") {
      const relation = relationsById.get(producer.relationId);
      if (
        relation == null ||
        (relation.fromNodeId !== itemNodeId && relation.toNodeId !== itemNodeId)
      ) {
        throw new StateSnapshotSemanticError(
          `${description}のrelation producer endpointが親itemと一致しません`,
        );
      }
    }
  }
}

type SnapshotPersonalReminderSubject = Readonly<{
  kind: "user" | "team";
  candidateId: string;
}>;

function normalizeSnapshotPersonalReminderSubjects(
  subjects: readonly SnapshotPersonalReminderSubject[],
): readonly SnapshotPersonalReminderSubject[] {
  const subjectsByIdentity = new Map<string, SnapshotPersonalReminderSubject>();
  for (const subject of subjects) {
    const identity = personalReminderSubjectIdentity(subject);
    const current = subjectsByIdentity.get(identity);
    if (current == null || compareStrings(subject.candidateId, current.candidateId) < 0) {
      subjectsByIdentity.set(identity, subject);
    }
  }
  return Object.freeze(
    [...subjectsByIdentity.values()].sort((left, right) =>
      compareStrings(personalReminderSubjectIdentity(left), personalReminderSubjectIdentity(right)),
    ),
  );
}

function aiAnalysisDependencyIsUnverified(dependency: AiAnalysisDependency): boolean {
  return dependency.status === "unverified" || dependency.status === "unknown";
}

type SnapshotPersonalReminderCandidateSubject =
  | Readonly<{
      status: "grounded";
      subject: SnapshotPersonalReminderSubject;
      addable: boolean;
    }>
  | Readonly<{ status: "unbounded" }>
  | Readonly<{ status: "excluded" }>;

function expectedPersonalReminderCandidateSubject(
  producer: AiAnalysisDependencyProducer,
  parentItem: SnapshotItemForRelationValidation,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  causeSetDependency: AiAnalysisDependency,
): SnapshotPersonalReminderCandidateSubject {
  const producerDependency = expectedAiAnalysisDependencyForProducer(
    producer,
    "personal reminder cause setの追加producer",
    itemsByNodeId,
    relationsById,
    causeSetDependency,
  );
  if (producer.kind !== "relation_candidate") {
    if (aiAnalysisDependencyIsUnverified(producerDependency)) {
      return Object.freeze({ status: "unbounded" });
    }
    return Object.freeze({ status: "excluded" });
  }
  if (
    parentItem.type !== "issue" ||
    parentItem.state !== "open" ||
    parentItem.assignees.length !== 0
  ) {
    return Object.freeze({ status: "excluded" });
  }
  const owner = itemsByNodeId.get(producer.producer.nodeId);
  if (owner == null) {
    return Object.freeze({ status: "excluded" });
  }
  if (!producer.endpointNodeIds.includes(parentItem.nodeId)) {
    return Object.freeze({ status: "excluded" });
  }
  if (owner.type !== "pull_request" || owner.state !== "open") {
    return Object.freeze({ status: "excluded" });
  }
  if (owner.author.status === "unavailable") {
    return Object.freeze({ status: "excluded" });
  }
  if (owner.author.actor.type !== "human") {
    return Object.freeze({ status: "excluded" });
  }
  const persistedRelation = relationsById.get(producer.candidateId);
  if (
    persistedRelation?.active === true &&
    persistedRelation.type === "implements" &&
    persistedRelation.fromNodeId === owner.nodeId &&
    persistedRelation.toNodeId === parentItem.nodeId
  ) {
    return Object.freeze({ status: "excluded" });
  }
  return Object.freeze({
    status: "grounded",
    subject: Object.freeze({
      kind: "user",
      candidateId: owner.author.actor.login,
    }),
    addable: aiAnalysisDependencyIsUnverified(producerDependency),
  });
}

function assertPersonalReminderCauseSetSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): void {
  const planning = item.personalReminderCausePlanning;
  if (
    planning.status !== "completed" ||
    !("causeSetAiDependency" in planning) ||
    !("causeSetSubjectChanges" in planning)
  ) {
    return;
  }
  const presenceDependencies: AiAnalysisDependency[] = [];
  const removableSubjects: SnapshotPersonalReminderSubject[] = [];
  for (const cause of item.personalReminderCauses) {
    if (!("aiDependencies" in cause)) {
      throw new StateSnapshotSemanticError(
        "personal reminder cause setの検証に必要なcause AI依存がありません",
      );
    }
    const presenceDependency = cause.aiDependencies.presence;
    presenceDependencies.push(presenceDependency);
    if (!aiAnalysisDependencyIsUnverified(presenceDependency)) {
      continue;
    }
    for (const responsible of cause.responsible) {
      if (responsible.kind === "user" || responsible.kind === "team") {
        removableSubjects.push(
          Object.freeze({
            kind: responsible.kind,
            candidateId: responsible.candidateId,
          }),
        );
      }
    }
  }
  const expectedPresenceDependency = combineAiAnalysisDependencies(
    presenceDependencies.length === 0
      ? [Object.freeze({ status: "not_dependent" })]
      : presenceDependencies,
  );
  if (
    planning.causeSetAiDependency.status === "unknown" &&
    planning.causeSetAiDependency.reason === "migration" &&
    planning.causeSetAiDependency.producers == null &&
    expectedPresenceDependency.status !== "not_dependent" &&
    !(
      expectedPresenceDependency.status === "unknown" &&
      expectedPresenceDependency.reason === "migration" &&
      expectedPresenceDependency.producers == null
    )
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のpersonal reminder cause set AI依存がcauseのpresenceを含んでいません`,
    );
  }
  assertAiAnalysisDependencyLowerBound(
    expectedPresenceDependency,
    planning.causeSetAiDependency,
    `item ${item.nodeId}のpersonal reminder cause set AI依存`,
  );

  let subjectChangesInputUnbounded = false;
  const presenceProducerSignatures = new Set(
    expectedPresenceDependency.status === "not_dependent"
      ? []
      : (expectedPresenceDependency.producers ?? []).map(aiAnalysisDependencyProducerSignature),
  );
  const groundedCandidateSubjects: SnapshotPersonalReminderSubject[] = [];
  const groundedAddableSubjects: SnapshotPersonalReminderSubject[] = [];
  const parentItem = itemsByNodeId.get(item.nodeId);
  if (parentItem == null) {
    throw new StateSnapshotSemanticError(
      `personal reminder cause setの親itemがありません。対象: ${item.nodeId}`,
    );
  }
  for (const producer of planning.causeSetAiDependency.status === "not_dependent"
    ? []
    : (planning.causeSetAiDependency.producers ?? [])) {
    if (presenceProducerSignatures.has(aiAnalysisDependencyProducerSignature(producer))) {
      continue;
    }
    const candidateSubject = expectedPersonalReminderCandidateSubject(
      producer,
      parentItem,
      itemsByNodeId,
      relationsById,
      planning.causeSetAiDependency,
    );
    if (candidateSubject.status === "unbounded") {
      subjectChangesInputUnbounded = true;
    } else if (candidateSubject.status === "grounded") {
      groundedCandidateSubjects.push(candidateSubject.subject);
      if (candidateSubject.addable) {
        groundedAddableSubjects.push(candidateSubject.subject);
      }
    }
  }

  const normalizedGroundedCandidateSubjects =
    normalizeSnapshotPersonalReminderSubjects(groundedCandidateSubjects);
  const normalizedGroundedAddableSubjects =
    normalizeSnapshotPersonalReminderSubjects(groundedAddableSubjects);
  const expectedRemovableSubjects = normalizeSnapshotPersonalReminderSubjects(removableSubjects);
  const subjectChangesAreUnbounded = personalReminderCauseSetSubjectChangesAreUnbounded({
    causeSetDependency: planning.causeSetAiDependency,
    presenceDependency: expectedPresenceDependency,
    negativeCandidateSubjectCount: normalizedGroundedCandidateSubjects.length,
    inputUnbounded: subjectChangesInputUnbounded,
  });
  const subjectChanges = planning.causeSetSubjectChanges;
  if (subjectChangesAreUnbounded) {
    if (subjectChanges.scope !== "unbounded") {
      throw new StateSnapshotSemanticError(
        "personal reminder cause集合の主体変化を完全に復元できない場合はunboundedにしてください",
      );
    }
    return;
  }
  if (subjectChanges.scope !== "bounded") {
    throw new StateSnapshotSemanticError(
      "personal reminder cause集合の主体変化を復元できる場合はboundedにしてください",
    );
  }
  if (
    hashCanonicalJson(subjectChanges.addableSubjects) !==
      hashCanonicalJson(normalizedGroundedAddableSubjects) ||
    hashCanonicalJson(subjectChanges.removableSubjects) !==
      hashCanonicalJson(expectedRemovableSubjects)
  ) {
    throw new StateSnapshotSemanticError(
      "personal reminder cause集合の主体変化がAI依存とcauseに一致しません",
    );
  }
}

function personalReminderResponseMembershipProducerIsAllowed(
  producer: AiAnalysisDependencyProducer,
): boolean {
  if (producer.kind === "item_element") {
    return (
      producer.element === "status" ||
      producer.element === "waitingOn" ||
      producer.element === "nextAction"
    );
  }
  if (producer.kind === "relation") {
    return producer.producer.element === "relations";
  }
  return true;
}

function assertPersonalReminderDependenciesSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): void {
  for (const cause of item.personalReminderCauses) {
    if (!("aiDependencies" in cause)) {
      continue;
    }
    if (
      cause.aiDependencies.presence.status !== "not_dependent" &&
      (cause.aiDependencies.presence.producers ?? []).some(
        (producer) => producer.kind === "relation_candidate",
      )
    ) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのpresence AI依存にrelation candidate producerは指定できません",
      );
    }
    if (
      cause.aiDependencies.responseMembership.status !== "not_dependent" &&
      (cause.aiDependencies.responseMembership.producers ?? []).some(
        (producer) => !personalReminderResponseMembershipProducerIsAllowed(producer),
      )
    ) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのresponse membership AI依存に人物所属の判定入力以外のproducerは指定できません",
      );
    }
    if (!("aiDependency" in cause.currentInput)) {
      continue;
    }
    const descriptions = [
      ["presence", cause.aiDependencies.presence],
      ["responsible", cause.aiDependencies.responsible],
      ["action", cause.aiDependencies.action],
      ["evidence", cause.aiDependencies.evidence],
    ] satisfies readonly (readonly [string, unknown])[];
    for (const [field, dependency] of descriptions) {
      assertPersonalReminderAiDependencySemantics(
        dependency,
        `personal reminder causeの${field} AI依存`,
        item.nodeId,
        itemsByNodeId,
        relationsById,
        false,
        false,
      );
    }
    assertPersonalReminderAiDependencySemantics(
      cause.aiDependencies.responseMembership,
      "personal reminder causeのresponse membership AI依存",
      item.nodeId,
      itemsByNodeId,
      relationsById,
      false,
      true,
    );
    assertPersonalReminderAiDependencySemantics(
      cause.currentInput.aiDependency,
      "personal reminder causeのcurrent input AI依存",
      item.nodeId,
      itemsByNodeId,
      relationsById,
      false,
      true,
    );
  }
  if (
    item.personalReminderCausePlanning.status === "completed" &&
    "causeSetAiDependency" in item.personalReminderCausePlanning
  ) {
    assertPersonalReminderAiDependencySemantics(
      item.personalReminderCausePlanning.causeSetAiDependency,
      "personal reminder cause setのAI依存",
      item.nodeId,
      itemsByNodeId,
      relationsById,
      true,
      true,
    );
    assertPersonalReminderCauseSetSemantics(item, itemsByNodeId, relationsById);
  }
}

function assertPersonalReminderCausePlanningSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  legacyPersonalReminder: boolean,
): void {
  if (legacyPersonalReminder) {
    const planning = item.personalReminderCausePlanning;
    if (planning.status === "completed") {
      assertUtcDateTime(planning.observedAt, "personal reminder planningの観測時刻");
      if (planning.observedAt > item.observedAt) {
        throw new StateSnapshotSemanticError(
          "personal reminder planningの観測時刻はitemの観測時刻以前にしてください",
        );
      }
      return;
    }
    if (
      planning.status === "excluded" &&
      (!isTerminalStatus(item.status) || item.personalReminderCauses.length !== 0)
    ) {
      throw new StateSnapshotSemanticError(
        "causeがある、または継続中のitemをpersonal reminder planningから除外できません",
      );
    }
    return;
  }
  const parsedPlanning = personalReminderCausePlanningSchema.safeParse(
    item.personalReminderCausePlanning,
  );
  if (!parsedPlanning.success) {
    throw new StateSnapshotSemanticError("personal reminder causeのplanningが不正です", {
      cause: parsedPlanning.error,
    });
  }
  if (parsedPlanning.data.status === "completed") {
    assertUtcDateTime(parsedPlanning.data.observedAt, "personal reminder planningの観測時刻");
    if (parsedPlanning.data.observedAt > item.observedAt) {
      throw new StateSnapshotSemanticError(
        "personal reminder planningの観測時刻はitemの観測時刻以前にしてください",
      );
    }
    const subjectChanges = parsedPlanning.data.causeSetSubjectChanges;
    if (subjectChanges.scope === "bounded") {
      assertCanonicalPersonalReminderSubjects(
        subjectChanges.addableSubjects,
        "personal reminderで追加され得る主体",
      );
      assertCanonicalPersonalReminderSubjects(
        subjectChanges.removableSubjects,
        "personal reminderで削除され得る主体",
      );
    }
    return;
  }
  if (
    parsedPlanning.data.status === "excluded" &&
    (!isTerminalStatus(item.status) || item.personalReminderCauses.length !== 0)
  ) {
    throw new StateSnapshotSemanticError(
      "causeがある、または継続中のitemをpersonal reminder planningから除外できません",
    );
  }
}

function assertGenerationBackedReuseProofSemantics(
  proof: z.output<typeof aiAnalysisElementReuseProofSchema>,
  generation: Readonly<{
    metadata: Readonly<{
      revision: number;
      inputFingerprint: string;
    }>;
    result: unknown;
  }>,
  result: unknown,
  description: string,
): void {
  if (proof.status === "unknown" || proof.source === "deterministic_update") {
    return;
  }
  if (
    proof.revision !== generation.metadata.revision ||
    proof.inputFingerprint !== generation.metadata.inputFingerprint ||
    hashCanonicalJson(result) !== hashCanonicalJson(generation.result)
  ) {
    throw new StateSnapshotSemanticError(`${description}が生成記録と一致しません`);
  }
}

function assertAiAnalysisElementMapSemantics(
  elements: unknown,
  description: string,
  elementSchemaVersion: ElementSchemaVersion,
  elementsFormat: "legacy" | "current",
): void {
  const parsedElements = z.record(z.string(), z.unknown()).safeParse(elements);
  if (!parsedElements.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedElements.error,
    });
  }
  for (const [key, value] of Object.entries(parsedElements.data)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const evaluatedElement =
      elementsFormat === "current"
        ? z
            .strictObject({
              generation: z.unknown(),
              result: z.unknown(),
              evaluationProof: aiAnalysisElementReuseProofSchema,
            })
            .safeParse(value)
        : { success: true as const, data: { generation: value } };
    if (!evaluatedElement.success) {
      throw new StateSnapshotSemanticError(`${description}の評価記録が不正です。対象: ${key}`, {
        cause: evaluatedElement.error,
      });
    }
    const generationResult = createElementGenerationSchemaForVersion(
      elementResult.data,
      elementSchemaVersion,
    ).safeParse(evaluatedElement.data.generation);
    if (!generationResult.success) {
      throw new StateSnapshotSemanticError(`${description}の生成記録が不正です。対象: ${key}`, {
        cause: generationResult.error,
      });
    }
    assertUtcDateTime(
      generationResult.data.metadata.generatedAt,
      `${description}の生成時刻。対象: ${key}`,
    );
    if (
      hashCanonicalJson(generationResult.data.result) !== generationResult.data.metadata.outputHash
    ) {
      throw new StateSnapshotSemanticError(`${description}の出力hashが一致しません。対象: ${key}`);
    }
    if ("result" in evaluatedElement.data) {
      const resultResult = createAiAnalysisMigrationElementResultSchema(
        elementResult.data,
      ).safeParse(evaluatedElement.data.result);
      if (!resultResult.success) {
        throw new StateSnapshotSemanticError(`${description}の評価結果が不正です。対象: ${key}`, {
          cause: resultResult.error,
        });
      }
      assertGenerationBackedReuseProofSemantics(
        evaluatedElement.data.evaluationProof,
        generationResult.data,
        resultResult.data,
        `${description}の評価証明。対象: ${key}`,
      );
    }
  }
}

function assertAiAnalysisMigrationAdoptedMapSemantics(
  elements: unknown,
  description: string,
  elementSchemaVersion: ElementSchemaVersion,
  requireReuseProof: boolean,
): void {
  const parsedElements = z.record(z.string(), z.unknown()).safeParse(elements);
  if (!parsedElements.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedElements.error,
    });
  }
  const adoptedElementShape = z.discriminatedUnion("origin", [
    z.strictObject({
      origin: z.literal("current"),
      generation: z.unknown(),
      result: requireReuseProof ? z.unknown() : z.unknown().optional(),
      reuseProof: requireReuseProof ? z.unknown() : z.unknown().optional(),
    }),
    z.strictObject({
      origin: z.literal("migration"),
      result: z.unknown(),
      reuseProof: requireReuseProof ? z.unknown() : z.unknown().optional(),
    }),
  ]);
  for (const key of Object.keys(parsedElements.data)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const adoptedResult = adoptedElementShape.safeParse(parsedElements.data[key]);
    if (!adoptedResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: adoptedResult.error,
      });
    }
    const adopted = adoptedResult.data;
    const reuseProof = adopted.reuseProof;
    const parsedReuseProof = aiAnalysisElementReuseProofSchema.safeParse(reuseProof);
    if (requireReuseProof) {
      if (!parsedReuseProof.success) {
        throw new StateSnapshotSemanticError(`${description}の再利用証明が不正です。対象: ${key}`, {
          cause: parsedReuseProof.error,
        });
      }
    }
    switch (adopted.origin) {
      case "current": {
        const generationSchema = createElementGenerationSchemaForVersion(
          elementResult.data,
          elementSchemaVersion,
        );
        const parsedGeneration = generationSchema.safeParse(adopted.generation);
        if (!parsedGeneration.success) {
          throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
            cause: parsedGeneration.error,
          });
        }
        if (requireReuseProof) {
          const parsedResult = createMigrationElementResultSchemaForVersion(
            elementResult.data,
            elementSchemaVersion,
          ).safeParse(adopted.result);
          if (!parsedResult.success) {
            throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
              cause: parsedResult.error,
            });
          }
          if (!parsedReuseProof.success) {
            throw new StateSnapshotSemanticError(
              `${description}の再利用証明が不正です。対象: ${key}`,
              { cause: parsedReuseProof.error },
            );
          }
          assertGenerationBackedReuseProofSemantics(
            parsedReuseProof.data,
            parsedGeneration.data,
            parsedResult.data,
            `${description}の再利用証明。対象: ${key}`,
          );
        }
        assertUtcDateTime(
          parsedGeneration.data.metadata.generatedAt,
          `${description}の生成時刻。対象: ${key}`,
        );
        if (
          hashCanonicalJson(parsedGeneration.data.result) !==
          parsedGeneration.data.metadata.outputHash
        ) {
          throw new StateSnapshotSemanticError(
            `${description}の出力hashが一致しません。対象: ${key}`,
          );
        }
        continue;
      }
      case "migration": {
        const resultSchema = createMigrationElementResultSchemaForVersion(
          elementResult.data,
          elementSchemaVersion,
        );
        const parsedResult = resultSchema.safeParse(adopted.result);
        if (!parsedResult.success) {
          throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
            cause: parsedResult.error,
          });
        }
        continue;
      }
      default:
        throw new StateSnapshotSemanticError(`${description}の生成元が不正です。対象: ${key}`);
    }
  }
}

function assertAiAnalysisCurrentAdoptedMapSemantics(
  elements: unknown,
  description: string,
  elementSchemaVersion: ElementSchemaVersion,
): void {
  const parsedElements = z.record(z.string(), z.unknown()).safeParse(elements);
  if (!parsedElements.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedElements.error,
    });
  }
  const adoptedElementShape = z.strictObject({
    origin: z.literal("current"),
    generation: z.unknown(),
    result: z.unknown(),
    reuseProof: aiAnalysisElementReuseProofSchema,
  });
  for (const [key, value] of Object.entries(parsedElements.data)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const adoptedResult = adoptedElementShape.safeParse(value);
    if (!adoptedResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: adoptedResult.error,
      });
    }
    const generationResult = createElementGenerationSchemaForVersion(
      elementResult.data,
      elementSchemaVersion,
    ).safeParse(adoptedResult.data.generation);
    if (!generationResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: generationResult.error,
      });
    }
    const resultResult = createAiAnalysisMigrationElementResultSchema(elementResult.data).safeParse(
      adoptedResult.data.result,
    );
    if (!resultResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: resultResult.error,
      });
    }
    assertUtcDateTime(
      generationResult.data.metadata.generatedAt,
      `${description}の生成時刻。対象: ${key}`,
    );
    if (
      hashCanonicalJson(generationResult.data.result) !== generationResult.data.metadata.outputHash
    ) {
      throw new StateSnapshotSemanticError(`${description}の出力hashが一致しません。対象: ${key}`);
    }
    assertGenerationBackedReuseProofSemantics(
      adoptedResult.data.reuseProof,
      generationResult.data,
      resultResult.data,
      `${description}の再利用証明。対象: ${key}`,
    );
  }
}

function assertAiAnalysisElementApplicationsSemantics(
  applications: unknown,
  description: string,
): TrackedItemAiAnalysis["applications"] {
  const parsedApplications = aiAnalysisElementApplicationsSchema.safeParse(applications);
  if (!parsedApplications.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedApplications.error,
    });
  }
  return parsedApplications.data;
}

function assertAiAnalysisApplicationsMatchStoredElements(
  aiAnalysis: TrackedItemAiAnalysis | LegacyTrackedItemAiAnalysis,
  applications: TrackedItemAiAnalysis["applications"],
  allowNotRecordedApplicationWithoutAdopted: boolean,
): void {
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const application = applications[element];
    const evaluated = aiAnalysis.elements[element];
    const adopted = aiAnalysis.adoptedElements[element];
    switch (application.status) {
      case "current_ai": {
        if (adopted?.origin !== "current") {
          throw new StateSnapshotSemanticError(
            `current_aiの${element}に現行形式の採用結果がありません`,
          );
        }
        if (adopted.reuseProof.status !== "verified") {
          throw new StateSnapshotSemanticError(
            `current_aiの${element}に検証済みの再利用証明がありません`,
          );
        }
        if (
          adopted.reuseProof.revision !== AI_ANALYSIS_ELEMENT_REVISIONS[element] ||
          adopted.reuseProof.inputProjectionVersion !==
            AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element]
        ) {
          throw new StateSnapshotSemanticError(
            `current_aiの${element}の再利用証明が現在の要素規則と一致しません`,
          );
        }
        if (application.origin === "verified_reuse") {
          if (
            (adopted.reuseProof.source === "current_generation" ||
              adopted.reuseProof.source === "structural_migration") &&
            (adopted.reuseProof.revision !== adopted.generation.metadata.revision ||
              adopted.reuseProof.inputFingerprint !==
                adopted.generation.metadata.inputFingerprint ||
              hashCanonicalJson(adopted.result) !== hashCanonicalJson(adopted.generation.result))
          ) {
            throw new StateSnapshotSemanticError(
              `verified_reuseの${element}が生成結果と一致しません`,
            );
          }
          break;
        }
        if (evaluated == null) {
          throw new StateSnapshotSemanticError(
            `実行結果を使うcurrent_aiの${element}に現行の生成記録がありません`,
          );
        }
        if (
          hashCanonicalJson(evaluated.generation) !== hashCanonicalJson(adopted.generation) ||
          adopted.reuseProof.source !== "current_generation" ||
          adopted.reuseProof.revision !== adopted.generation.metadata.revision ||
          adopted.reuseProof.inputFingerprint !== adopted.generation.metadata.inputFingerprint ||
          hashCanonicalJson(adopted.result) !== hashCanonicalJson(adopted.generation.result)
        ) {
          throw new StateSnapshotSemanticError(
            `実行結果を使うcurrent_aiの${element}が生成結果と一致しません`,
          );
        }
        break;
      }
      case "retained_ai":
        if (adopted?.origin !== "current") {
          throw new StateSnapshotSemanticError(
            `retained_aiの${element}に現行形式の採用結果がありません`,
          );
        }
        if (application.reason === "failed" && aiAnalysis.status !== "failed") {
          throw new StateSnapshotSemanticError(`retained_aiの${element}の失敗理由が不整合です`);
        }
        if (application.reason === "deferred" && aiAnalysis.status !== "deferred") {
          throw new StateSnapshotSemanticError(`retained_aiの${element}の延期理由が不整合です`);
        }
        if (application.reason === "current_evaluation_not_adopted" && evaluated == null) {
          throw new StateSnapshotSemanticError(
            `retained_aiの${element}に不採用の現行評価記録がありません`,
          );
        }
        break;
      case "unavailable":
        if (application.reason === "failed" && aiAnalysis.status !== "failed") {
          throw new StateSnapshotSemanticError(`unavailableの${element}の失敗理由が不整合です`);
        }
        if (application.reason === "deferred" && aiAnalysis.status !== "deferred") {
          throw new StateSnapshotSemanticError(`unavailableの${element}の延期理由が不整合です`);
        }
        if (application.reason === "current_evaluation_not_adopted" && evaluated == null) {
          throw new StateSnapshotSemanticError(
            `unavailableの${element}に不採用の現行評価記録がありません`,
          );
        }
        break;
      case "unknown":
        if (
          application.reason === "migration" ||
          (application.reason === "not_recorded" &&
            aiAnalysis.status === "not_recorded" &&
            allowNotRecordedApplicationWithoutAdopted)
        ) {
          break;
        }
        if (adopted == null) {
          throw new StateSnapshotSemanticError(
            `適用元不明の${element}に対応する採用結果がありません`,
          );
        }
        break;
      case "not_required":
      case "deterministic_fallback":
      case "disabled":
        break;
      default:
        throw new UnreachableError(application);
    }
  }
}

function assertAiAnalysisApplicationsMatchTrackedItemValues(item: SnapshotTrackedItem): void {
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  const values = Object.freeze({
    status: item.status,
    waitingOn: item.waitingOn,
    nextAction: item.nextAction,
  });
  const stateElements: readonly ("status" | "waitingOn" | "nextAction")[] = [
    "status",
    "waitingOn",
    "nextAction",
  ];
  for (const element of stateElements) {
    const application = item.aiAnalysis.applications[element];
    if (application.status === "unknown" && application.reason === "migration") {
      continue;
    }
    if (!aiAnalysisElementApplicationUsesAiValue(application)) {
      continue;
    }
    const adopted = item.aiAnalysis.adoptedElements[element];
    if (adopted == null) {
      throw new StateSnapshotSemanticError(`AI値を使う${element}に対応する採用結果がありません`);
    }
    if (hashCanonicalJson(adopted.result.value) !== hashCanonicalJson(values[element])) {
      throw new StateSnapshotSemanticError(`AI値を使う${element}がitemの表示値と一致しません`);
    }
  }
}

function expectedAiAnalysisDependencyForProducer(
  producer: AiAnalysisDependencyProducer,
  description: string,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  containingDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  if (producer.kind === "item_element") {
    const producerItem = itemsByNodeId.get(producer.nodeId);
    if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
      throw new StateSnapshotSemanticError(`${description}のitem producerにAI適用元がありません`);
    }
    return aiAnalysisDependencyForApplication(
      producerItem.nodeId,
      producer.element,
      producerItem.aiAnalysis.applications[producer.element],
    );
  }
  if (producer.kind === "relation_candidate") {
    const producerItem = itemsByNodeId.get(producer.producer.nodeId);
    if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate producerにAI適用元がありません`,
      );
    }
    if (!producer.endpointNodeIds.includes(producer.producer.nodeId)) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate producer nodeがendpointと一致しません`,
      );
    }
    const application = producerItem.aiAnalysis.applications.relations;
    let expected = aiAnalysisDependencyForApplication(
      producerItem.nodeId,
      "relations",
      application,
    );
    if (
      containingDependency.status === "unknown" &&
      containingDependency.reason === "proof_unknown" &&
      (expected.status === "current" || expected.status === "not_dependent")
    ) {
      expected = aiAnalysisDependencyForMissingRelationCandidateAssessment(
        producerItem.nodeId,
        application,
      );
    }
    if (expected.status === "not_dependent") {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate producerにAI依存がありません`,
      );
    }
    return aiAnalysisDependencyForRelationCandidate(
      producer.candidateId,
      producer.endpointNodeIds,
      expected,
    );
  }
  const relation = relationsById.get(producer.relationId);
  if (relation == null || !("aiDependency" in relation)) {
    throw new StateSnapshotSemanticError(`${description}のrelation producerが存在しません`);
  }
  if (producer.producer.element !== "relations") {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producer elementがrelationsではありません`,
    );
  }
  if (
    producer.producer.nodeId !== relation.fromNodeId &&
    producer.producer.nodeId !== relation.toNodeId
  ) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producer nodeがrelation endpointと一致しません`,
    );
  }
  if (relation.aiDependency.status === "not_dependent") {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerに対応するAI依存がありません`,
    );
  }
  const relationProducers = relation.aiDependency.producers;
  if (relationProducers == null) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerに対応するAI依存がありません`,
    );
  }
  const matchesRelationProducer = relationProducers.some(
    (relationProducer) =>
      relationProducer.kind === "relation" &&
      relationProducer.relationId === producer.relationId &&
      relationProducer.producer.nodeId === producer.producer.nodeId &&
      relationProducer.producer.element === producer.producer.element,
  );
  if (!matchesRelationProducer) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerがrelationのAI依存と一致しません`,
    );
  }
  return relation.aiDependency;
}

type AiAnalysisDependencyIntegrityOptions = Readonly<{
  allowStaleRepository: boolean;
  allowProducerlessNotRecorded: boolean;
  allowProducerlessMigration: boolean;
  allowProducerlessStaleRepository: boolean;
  allowHiddenProducerlessNotRecorded: boolean;
  allowHiddenProducerlessMigration: boolean;
  allowHiddenProducerlessStaleRepository: boolean;
  dependencyForProducer: (
    producer: AiAnalysisDependencyProducer,
    description: string,
    containingDependency: AiAnalysisDependency,
  ) => AiAnalysisDependency;
}>;

const producerlessNotRecordedAiAnalysisDependency = Object.freeze({
  status: "unknown",
  reason: "not_recorded",
} satisfies AiAnalysisDependency);

const producerlessMigrationAiAnalysisDependency = Object.freeze({
  status: "unknown",
  reason: "migration",
} satisfies AiAnalysisDependency);

const producerlessStaleRepositoryAiAnalysisDependency = Object.freeze({
  status: "unknown",
  reason: "stale_repository",
} satisfies AiAnalysisDependency);

function aiAnalysisDependencyMatchesExpected(
  actual: AiAnalysisDependency,
  expected: AiAnalysisDependency,
  options: Readonly<{
    allowHiddenProducerlessNotRecorded: boolean;
    allowHiddenProducerlessMigration: boolean;
    allowHiddenProducerlessStaleRepository: boolean;
  }>,
): boolean {
  if (hashCanonicalJson(expected) === hashCanonicalJson(actual)) {
    return true;
  }
  if (options.allowHiddenProducerlessNotRecorded) {
    const withNotRecorded = combineAiAnalysisDependencies([
      expected,
      producerlessNotRecordedAiAnalysisDependency,
    ]);
    if (hashCanonicalJson(withNotRecorded) === hashCanonicalJson(actual)) {
      return true;
    }
  }
  if (options.allowHiddenProducerlessMigration) {
    const withMigration = combineAiAnalysisDependencies([
      expected,
      producerlessMigrationAiAnalysisDependency,
    ]);
    if (hashCanonicalJson(withMigration) === hashCanonicalJson(actual)) {
      return true;
    }
  }
  if (options.allowHiddenProducerlessStaleRepository) {
    const withStaleRepository = combineAiAnalysisDependencies([
      expected,
      producerlessStaleRepositoryAiAnalysisDependency,
    ]);
    if (hashCanonicalJson(withStaleRepository) === hashCanonicalJson(actual)) {
      return true;
    }
  }
  return false;
}

function dependencyHasHiddenProducerlessReason(
  dependency: AiAnalysisDependency,
  reason: "not_recorded" | "migration",
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  if (
    dependency.status !== "unknown" ||
    dependency.reason !== reason ||
    dependency.producers == null
  ) {
    return false;
  }
  const visibleDependency = combineAiAnalysisDependencies(
    dependency.producers.map((producer) =>
      expectedAiAnalysisDependencyForProducer(
        producer,
        "hidden producerless AI依存",
        itemsByNodeId,
        relationsById,
        dependency,
      ),
    ),
  );
  const sentinel =
    reason === "not_recorded"
      ? producerlessNotRecordedAiAnalysisDependency
      : producerlessMigrationAiAnalysisDependency;
  return (
    hashCanonicalJson(combineAiAnalysisDependencies([visibleDependency, sentinel])) ===
    hashCanonicalJson(dependency)
  );
}

function assertAiAnalysisDependencyIntegrity(
  dependency: unknown,
  description: string,
  options: AiAnalysisDependencyIntegrityOptions,
): AiAnalysisDependency {
  const parsedDependency = aiAnalysisDependencySchema.safeParse(dependency);
  if (!parsedDependency.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedDependency.error,
    });
  }
  const dependencyValue = parsedDependency.data;
  if (
    dependencyValue.status === "unknown" &&
    dependencyValue.reason === "stale_repository" &&
    !options.allowStaleRepository
  ) {
    throw new StateSnapshotSemanticError(
      `${description}のstale_repositoryはstale itemの保持値以外に指定できません`,
    );
  }
  if (dependencyValue.status === "not_dependent") {
    return dependencyValue;
  }
  const producers = dependencyValue.producers;
  if (producers == null) {
    if (
      dependencyValue.status === "unknown" &&
      dependencyValue.reason === "not_recorded" &&
      options.allowProducerlessNotRecorded
    ) {
      return dependencyValue;
    }
    if (
      dependencyValue.status === "unknown" &&
      dependencyValue.reason === "migration" &&
      options.allowProducerlessMigration
    ) {
      return dependencyValue;
    }
    if (
      dependencyValue.status === "unknown" &&
      dependencyValue.reason === "stale_repository" &&
      options.allowProducerlessStaleRepository
    ) {
      return dependencyValue;
    }
    if (dependencyValue.status === "unknown" && dependencyValue.reason === "proof_unknown") {
      throw new StateSnapshotSemanticError(
        `${description}のproducerless proof_unknownは許可されません`,
      );
    }
    throw new StateSnapshotSemanticError(`${description}のproducerがありません`);
  }
  const expected = combineAiAnalysisDependencies(
    producers.map((producer) =>
      options.dependencyForProducer(producer, description, dependencyValue),
    ),
  );
  if (!aiAnalysisDependencyMatchesExpected(dependencyValue, expected, options)) {
    throw new StateSnapshotSemanticError(`${description}とproducerの合成結果が一致しません`);
  }
  return dependencyValue;
}

function assertRelationCandidateProducerDefinitions(
  dependencies: readonly Readonly<{
    description: string;
    dependency: AiAnalysisDependency;
    targetNodeId?: GraphNodeId;
  }>[],
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): void {
  const definitionsByCandidateId = new Map<string, string>();
  for (const entry of dependencies) {
    if (entry.dependency.status === "not_dependent") {
      continue;
    }
    for (const producer of entry.dependency.producers ?? []) {
      if (producer.kind !== "relation_candidate") {
        continue;
      }
      const firstEndpoint = producer.endpointNodeIds[0];
      const secondEndpoint = producer.endpointNodeIds[1];
      if (firstEndpoint === secondEndpoint || firstEndpoint > secondEndpoint) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate endpointが正規化されていません`,
        );
      }
      if (
        !producer.endpointNodeIds.includes(producer.producer.nodeId) ||
        (entry.targetNodeId != null && !producer.endpointNodeIds.includes(entry.targetNodeId))
      ) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate producer参照が不正です`,
        );
      }
      const producerItem = itemsByNodeId.get(producer.producer.nodeId);
      if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate producerにAI適用元がありません`,
        );
      }
      const definition = JSON.stringify([firstEndpoint, secondEndpoint, producer.producer.nodeId]);
      const previousDefinition = definitionsByCandidateId.get(producer.candidateId);
      if (previousDefinition == null) {
        definitionsByCandidateId.set(producer.candidateId, definition);
      } else if (previousDefinition !== definition) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate IDに異なるendpointまたはownerがあります`,
        );
      }
      const persistedRelation = relationsById.get(producer.candidateId);
      if (persistedRelation != null) {
        if (persistedRelation.provenance === "native") {
          throw new StateSnapshotSemanticError(
            `${entry.description}のrelation candidate IDがnative relationと衝突しています`,
          );
        }
        const sameEndpoints =
          (persistedRelation.fromNodeId === firstEndpoint &&
            persistedRelation.toNodeId === secondEndpoint) ||
          (persistedRelation.fromNodeId === secondEndpoint &&
            persistedRelation.toNodeId === firstEndpoint);
        if (!sameEndpoints) {
          throw new StateSnapshotSemanticError(
            `${entry.description}のrelation candidate endpointがpersisted relationと一致しません`,
          );
        }
        if ("aiDependency" in persistedRelation) {
          const persistedDependency = persistedRelation.aiDependency;
          if (persistedDependency.status === "not_dependent") {
            throw new StateSnapshotSemanticError(
              `${entry.description}のrelation candidate IDがAI非依存relationと衝突しています`,
            );
          }
          const producerlessMigration =
            persistedDependency.status === "unknown" &&
            persistedDependency.reason === "migration" &&
            persistedDependency.producers == null;
          if (producerlessMigration) {
            continue;
          }
          const persistedProducers = persistedDependency.producers;
          if (
            persistedProducers?.some(
              (persistedProducer) =>
                persistedProducer.kind === "relation" &&
                persistedProducer.relationId === producer.candidateId &&
                persistedProducer.producer.nodeId === producer.producer.nodeId,
            ) !== true
          ) {
            throw new StateSnapshotSemanticError(
              `${entry.description}のrelation candidate ownerがpersisted relationと一致しません`,
            );
          }
        }
      }
    }
  }
}

function directAiAnalysisDependencyProducerElement(
  element: AiAnalysisDependencyElement,
): AiAnalysisElement | undefined {
  switch (element) {
    case "status":
      return "status";
    case "waitingOn":
      return "waitingOn";
    case "nextAction":
      return "nextAction";
    case "primaryWaitingOn":
    case "uncertainties":
    case "relationSet":
      return undefined;
    case "deadline":
    case "deadlineLevel":
      return "deadline";
    case "confidence":
    case "evidence":
    case "lastProgressAt":
    case "stallSince":
    case "severity":
    case "downstreamImpact":
    case "importance":
    case "attention":
    case "blockers":
      return undefined;
    default:
      throw new UnreachableError(element);
  }
}

const BLOCKER_STATE_DEPENDENCY_ELEMENTS = Object.freeze([
  "status",
  "waitingOn",
  "primaryWaitingOn",
  "nextAction",
  "confidence",
  "evidence",
  "uncertainties",
] satisfies readonly AiAnalysisDependencyElement[]);

const STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS = Object.freeze([
  ...BLOCKER_STATE_DEPENDENCY_ELEMENTS,
  "lastProgressAt",
  "stallSince",
] satisfies readonly AiAnalysisDependencyElement[]);

const STALE_REPOSITORY_DERIVED_DEPENDENCY_ELEMENTS = Object.freeze([
  "severity",
  "attention",
] satisfies readonly AiAnalysisDependencyElement[]);

const NATIVE_BLOCKER_STATE_APPLICATION_ELEMENTS = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
] satisfies readonly AiAnalysisElement[]);

function expectedStaleBlockerTopologyDependency(
  item: SnapshotTrackedItem,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency {
  const direct = expectedDirectAiAnalysisDependency(element, item);
  return direct == null
    ? producerlessStaleRepositoryAiAnalysisDependency
    : combineAiAnalysisDependencies([direct, producerlessStaleRepositoryAiAnalysisDependency]);
}

function hasCanonicalStaleBlockerTopologyDependencies(item: SnapshotTrackedItem): boolean {
  return STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS.every(
    (element) =>
      hashCanonicalJson(item.aiDependencies[element]) ===
      hashCanonicalJson(expectedStaleBlockerTopologyDependency(item, element)),
  );
}

function staleRepositorySeverityDependency(item: SnapshotTrackedItem): AiAnalysisDependency {
  if (
    item.severityContext.waitClass === "notApplicable" ||
    item.severityContext.waitClass === "blockedParent"
  ) {
    return item.aiDependencies.status;
  }
  return combineAiAnalysisDependencies([
    item.aiDependencies.stallSince,
    item.aiDependencies.status,
    item.aiDependencies.waitingOn,
  ]);
}

function staleRepositoryAttentionDependency(item: SnapshotTrackedItem): AiAnalysisDependency {
  if (
    item.severityContext.waitClass === "notApplicable" ||
    item.severityContext.waitClass === "blockedParent"
  ) {
    return item.aiDependencies.status;
  }
  const dependencies = [item.aiDependencies.importance, item.aiDependencies.deadlineLevel];
  if (item.importance.score !== 0) {
    dependencies.push(
      item.aiDependencies.stallSince,
      item.aiDependencies.status,
      item.aiDependencies.waitingOn,
    );
  }
  if (
    item.deadlineAssessment.status === "available" &&
    item.deadlineAssessment.value.date != null
  ) {
    dependencies.push(item.aiDependencies.status, item.aiDependencies.waitingOn);
  }
  return combineAiAnalysisDependencies(dependencies);
}

function assertStaleRepositoryDerivedDependency(
  item: SnapshotTrackedItem,
  element: "severity" | "attention",
  expected: AiAnalysisDependency,
): void {
  const dependency = item.aiDependencies[element];
  if (hashCanonicalJson(dependency) !== hashCanonicalJson(expected)) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}の${element}がstale repository依存の導出結果と一致しません`,
    );
  }
}

function assertDirectAiAnalysisDependencyProducer(
  producer: AiAnalysisDependencyProducer,
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  description: string,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
): void {
  const expectedProducerElement = directAiAnalysisDependencyProducerElement(element);
  if (producer.kind === "item_element") {
    if (element === "relationSet") {
      throw new StateSnapshotSemanticError(`${description}にitem element producerは指定できません`);
    }
    if (
      expectedProducerElement != null &&
      (producer.nodeId !== item.nodeId || producer.element !== expectedProducerElement)
    ) {
      throw new StateSnapshotSemanticError(
        `${description}の直接AI依存producerが親itemと一致しません`,
      );
    }
    if (element === "primaryWaitingOn") {
      if (!("applications" in item.aiAnalysis)) {
        throw new StateSnapshotSemanticError("itemのAI適用元がありません");
      }
      if (
        aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn) &&
        (producer.nodeId !== item.nodeId || producer.element !== "waitingOn")
      ) {
        throw new StateSnapshotSemanticError(
          `${description}の直接AI依存producerが親itemのwaitingOnと一致しません`,
        );
      }
    }
    return;
  }
  const blockerDerivedElements = new Set<AiAnalysisDependencyElement>([
    "status",
    "waitingOn",
    "nextAction",
    "primaryWaitingOn",
    "confidence",
    "evidence",
    "uncertainties",
    "blockers",
  ]);
  if (producer.kind === "relation_candidate") {
    if (element === "relationSet") {
      if (!producer.endpointNodeIds.includes(item.nodeId)) {
        throw new StateSnapshotSemanticError(
          `${description}のrelation candidate endpointが親itemと一致しません`,
        );
      }
      return;
    }
    if (blockerDerivedElements.has(element)) {
      if (element === "blockers") {
        assertNegativeBlockerCandidateDirection(producer, item.nodeId, activeBlocksArcKeys);
      } else if (!producer.endpointNodeIds.includes(item.nodeId)) {
        throw new StateSnapshotSemanticError(
          `${description}のrelation candidate endpointが親itemと一致しません`,
        );
      }
      return;
    }
    return;
  }
  const relation = relationsById.get(producer.relationId);
  if (relation == null) {
    throw new StateSnapshotSemanticError(`${description}のrelation producerが存在しません`);
  }
  if (element === "relationSet") {
    if (
      !relation.active ||
      (relation.fromNodeId !== item.nodeId && relation.toNodeId !== item.nodeId)
    ) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation producerが親itemへ接続するactive relationではありません`,
      );
    }
    return;
  }
  if (
    blockerDerivedElements.has(element) &&
    (!relation.active || relation.type !== "blocks" || relation.toNodeId !== item.nodeId)
  ) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerが親itemのactive blockerではありません`,
    );
  }
}

function blockerDerivedItemElementIsValid(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "item_element" }>,
  element: AiAnalysisDependencyElement,
  itemNodeId: GraphNodeId,
): boolean {
  if (producer.nodeId !== itemNodeId) {
    return false;
  }
  switch (element) {
    case "status":
      return producer.element === "status";
    case "waitingOn":
    case "primaryWaitingOn":
      return producer.element === "waitingOn";
    case "nextAction":
      return producer.element === "nextAction";
    case "confidence":
    case "evidence":
    case "uncertainties":
      return (
        producer.element === "status" ||
        producer.element === "waitingOn" ||
        producer.element === "nextAction"
      );
    default:
      return false;
  }
}

function blockerDerivedDependencyHasHiddenProducerlessReason(
  dependency: AiAnalysisDependency,
  reason: "not_recorded" | "migration",
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
): boolean {
  if (
    dependency.status === "not_dependent" ||
    !dependencyHasHiddenProducerlessReason(dependency, reason, itemsByNodeId, relationsById)
  ) {
    return false;
  }
  for (const producer of dependency.producers ?? []) {
    if (
      producer.kind === "item_element" &&
      !blockerDerivedItemElementIsValid(producer, element, item.nodeId)
    ) {
      throw new StateSnapshotSemanticError(
        `itemのAI依存の${element}にblocker由来でないitem producerがあります`,
      );
    }
    assertDirectAiAnalysisDependencyProducer(
      producer,
      element,
      item,
      `itemのAI依存の${element}`,
      relationsById,
      activeBlocksArcKeys,
    );
  }
  return true;
}

function expectedDirectAiAnalysisDependency(
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
): AiAnalysisDependency | undefined {
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  if (
    element === "primaryWaitingOn" &&
    aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn)
  ) {
    return aiAnalysisDependencyForApplication(
      item.nodeId,
      "waitingOn",
      item.aiAnalysis.applications.waitingOn,
    );
  }
  const producerElement = directAiAnalysisDependencyProducerElement(element);
  if (producerElement == null) {
    return undefined;
  }
  return aiAnalysisDependencyForApplication(
    item.nodeId,
    producerElement,
    item.aiAnalysis.applications[producerElement],
  );
}

function directDependencyCanBeReplacedByNativeBlocker(
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  notDependentOpenBlockerNodeIdsByTargetNodeId: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>,
): boolean {
  if (element !== "status" && element !== "nextAction") {
    return false;
  }
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications[element])) {
    return false;
  }
  const blockerNodeIds = notDependentOpenBlockerNodeIdsByTargetNodeId.get(item.nodeId);
  if (blockerNodeIds == null) {
    return false;
  }
  if (element === "status") {
    return item.status === "waiting_for_unblock";
  }
  return [...blockerNodeIds].some(
    (blockerNodeId) => item.nextAction === `${blockerNodeId}の完了を待つ`,
  );
}

function directDependencyMustMatchExactly(
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
): boolean {
  if (element === "deadline" || element === "deadlineLevel" || element === "primaryWaitingOn") {
    return true;
  }
  if (element !== "status" && element !== "waitingOn" && element !== "nextAction") {
    return false;
  }
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  return aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications[element]);
}

function assertDirectAiAnalysisDependencyLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  description: string,
): void {
  const producerlessMigration =
    actual.status === "unknown" && actual.reason === "migration" && actual.producers == null;
  if (producerlessMigration) {
    throw new StateSnapshotSemanticError(`${description}にproducerless migrationは指定できません`);
  }
  if (directDependencyMustMatchExactly(element, item)) {
    if (hashCanonicalJson(expected) !== hashCanonicalJson(actual)) {
      throw new StateSnapshotSemanticError(`${description}がAI適用元と一致しません`);
    }
    return;
  }
  assertAiAnalysisDependencyLowerBound(expected, actual, `${description}のAI適用元`);
}

function assertTrackedItemAiDependenciesSemantics(
  dependencies: unknown,
  description: string,
  item: SnapshotTrackedItem,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
  notDependentOpenBlockerNodeIdsByTargetNodeId: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>,
  itemIsStale: boolean,
): void {
  const parsedDependencies = trackedItemAiDependenciesSchema.safeParse(dependencies);
  if (!parsedDependencies.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedDependencies.error,
    });
  }
  const blockerDerivedElements = new Set<AiAnalysisDependencyElement>(
    BLOCKER_STATE_DEPENDENCY_ELEMENTS,
  );
  const staleBlockerTopologyElements = new Set<AiAnalysisDependencyElement>(
    STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS,
  );
  const staleRepositoryDerivedElements = new Set<AiAnalysisDependencyElement>(
    STALE_REPOSITORY_DERIVED_DEPENDENCY_ELEMENTS,
  );
  const staleBlockerTopologyFallback =
    itemIsStale && hasCanonicalStaleBlockerTopologyDependencies(item);
  if (
    !staleBlockerTopologyFallback &&
    notDependentOpenBlockerNodeIdsByTargetNodeId.has(item.nodeId)
  ) {
    if (!("applications" in item.aiAnalysis)) {
      throw new StateSnapshotSemanticError("itemのAI適用元がありません");
    }
    for (const element of NATIVE_BLOCKER_STATE_APPLICATION_ELEMENTS) {
      if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications[element])) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}の${element}は確定blockerがある場合にAI値を使用できません`,
        );
      }
    }
  }
  const aggregateElements = new Set<AiAnalysisDependencyElement>([
    "lastProgressAt",
    "stallSince",
    "severity",
    "downstreamImpact",
    "importance",
    "attention",
    "blockers",
    "relationSet",
  ]);
  for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
    const dependencyEntry = parsedDependencies.data[element];
    if (dependencyEntry == null) {
      throw new StateSnapshotSemanticError(
        `${description}の依存要素がありません。対象: ${element}`,
      );
    }
    const elementDescription = `${description}の${element}`;
    const blockerDerivedHiddenNotRecorded =
      blockerDerivedElements.has(element) &&
      blockerDerivedDependencyHasHiddenProducerlessReason(
        dependencyEntry,
        "not_recorded",
        element,
        item,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      );
    const blockerDerivedHiddenMigration =
      blockerDerivedElements.has(element) &&
      blockerDerivedDependencyHasHiddenProducerlessReason(
        dependencyEntry,
        "migration",
        element,
        item,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      );
    const dependency = assertAiAnalysisDependencyIntegrity(dependencyEntry, elementDescription, {
      allowStaleRepository:
        staleBlockerTopologyFallback &&
        (staleBlockerTopologyElements.has(element) || staleRepositoryDerivedElements.has(element)),
      allowProducerlessNotRecorded: true,
      allowProducerlessMigration: true,
      allowProducerlessStaleRepository:
        staleBlockerTopologyFallback &&
        (staleBlockerTopologyElements.has(element) || staleRepositoryDerivedElements.has(element)),
      allowHiddenProducerlessNotRecorded:
        aggregateElements.has(element) || blockerDerivedHiddenNotRecorded,
      allowHiddenProducerlessMigration:
        aggregateElements.has(element) || blockerDerivedHiddenMigration,
      allowHiddenProducerlessStaleRepository:
        staleBlockerTopologyFallback &&
        (staleBlockerTopologyElements.has(element) || staleRepositoryDerivedElements.has(element)),
      dependencyForProducer: (producer, producerDescription, containingDependency) =>
        expectedAiAnalysisDependencyForProducer(
          producer,
          producerDescription,
          itemsByNodeId,
          relationsById,
          containingDependency,
        ),
    });
    const expectedDirectDependency = expectedDirectAiAnalysisDependency(element, item);
    if (
      expectedDirectDependency != null &&
      (!staleBlockerTopologyFallback || !staleBlockerTopologyElements.has(element))
    ) {
      const nativeBlockerOverride = directDependencyCanBeReplacedByNativeBlocker(
        element,
        item,
        notDependentOpenBlockerNodeIdsByTargetNodeId,
      );
      if (nativeBlockerOverride) {
        if (dependency.status !== "not_dependent") {
          throw new StateSnapshotSemanticError(
            `${elementDescription}は確定blockerによる上書き時はnot_dependentにしてください`,
          );
        }
      } else {
        assertDirectAiAnalysisDependencyLowerBound(
          expectedDirectDependency,
          dependency,
          element,
          item,
          elementDescription,
        );
      }
    }
    if (dependency.status === "not_dependent") {
      continue;
    }
    for (const producer of dependency.producers ?? []) {
      assertDirectAiAnalysisDependencyProducer(
        producer,
        element,
        item,
        elementDescription,
        relationsById,
        activeBlocksArcKeys,
      );
    }
  }
  if (staleBlockerTopologyFallback) {
    assertStaleRepositoryDerivedDependency(
      item,
      "severity",
      staleRepositorySeverityDependency(item),
    );
    assertStaleRepositoryDerivedDependency(
      item,
      "attention",
      staleRepositoryAttentionDependency(item),
    );
  }
}

function externalReferenceItemType(reference: ExternalGhostNode): "issue" | "pull_request" {
  let url: URL;
  try {
    url = new URL(reference.url);
  } catch (error: unknown) {
    throw new StateSnapshotSemanticError(
      `外部参照nodeのURLからitem種別を判定できません。対象: ${reference.nodeId}`,
      { cause: error },
    );
  }
  const pathSegments = url.pathname.split("/").filter((segment) => segment.length !== 0);
  const itemPathKind = pathSegments[2];
  const itemNumber = pathSegments[3];
  if (
    url.hostname !== "github.com" ||
    pathSegments.length < 4 ||
    itemNumber == null ||
    !/^[1-9][0-9]*$/u.test(itemNumber)
  ) {
    throw new StateSnapshotSemanticError(
      `外部参照nodeのURLからitem種別を判定できません。対象: ${reference.nodeId}`,
    );
  }
  if (itemPathKind === "issues") {
    return "issue";
  }
  if (itemPathKind === "pull") {
    return "pull_request";
  }
  throw new StateSnapshotSemanticError(
    `外部参照nodeのURLからitem種別を判定できません。対象: ${reference.nodeId}`,
  );
}

function snapshotGraphNodeItemType(
  nodeId: GraphNodeId,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  externalReferencesByNodeId: ReadonlyMap<string, ExternalGhostNode>,
): "issue" | "pull_request" {
  const item = itemsByNodeId.get(nodeId);
  if (item != null) {
    return item.type;
  }
  const externalReference = externalReferencesByNodeId.get(nodeId);
  if (externalReference != null) {
    return externalReferenceItemType(externalReference);
  }
  throw new StateSnapshotSemanticError(`relation endpointがsnapshotにありません。対象: ${nodeId}`);
}

function assertImplementsRelationEndpointTypes(
  relation: Relation | LegacyRelationWithoutAiDependency,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  externalReferencesByNodeId: ReadonlyMap<string, ExternalGhostNode>,
): void {
  if (relation.type !== "implements") {
    return;
  }
  const implementationType = snapshotGraphNodeItemType(
    relation.fromNodeId,
    itemsByNodeId,
    externalReferencesByNodeId,
  );
  const targetType = snapshotGraphNodeItemType(
    relation.toNodeId,
    itemsByNodeId,
    externalReferencesByNodeId,
  );
  if (implementationType !== "pull_request" || targetType !== "issue") {
    throw new StateSnapshotSemanticError(
      `implements relation ${relation.id}はPull RequestからIssueへ向けてください`,
    );
  }
}

function assertRelationAiDependencySemantics(dependency: unknown, description: string): void {
  const parsedDependency = aiAnalysisDependencySchema.safeParse(dependency);
  if (!parsedDependency.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedDependency.error,
    });
  }
  if (
    parsedDependency.data.status === "unknown" &&
    parsedDependency.data.reason === "stale_repository"
  ) {
    throw new StateSnapshotSemanticError(`${description}にstale repository依存は指定できません`);
  }
}

function assertInferredRelationAiDependencySemantics(
  relation: Relation,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  historicalDependency: boolean,
): void {
  if (relation.provenance === "native") {
    return;
  }
  const dependency = relation.aiDependency;
  if (dependency.status === "not_dependent") {
    throw new StateSnapshotSemanticError(
      `inferred relation ${relation.id}のnot_dependent AI依存は許可されません`,
    );
  }
  if (
    relation.active &&
    historicalDependency &&
    (dependency.status !== "unknown" ||
      (dependency.reason !== "proof_unknown" && dependency.reason !== "migration"))
  ) {
    throw new StateSnapshotSemanticError(
      `staleなactive inferred relation ${relation.id}のAI依存はunknownにしてください`,
    );
  }
  for (const producer of dependency.producers ?? []) {
    if (producer.kind !== "relation") {
      throw new StateSnapshotSemanticError(
        `inferred relation ${relation.id}のAI依存producer種別が不正です`,
      );
    }
    if (producer.relationId !== relation.id || producer.producer.element !== "relations") {
      throw new StateSnapshotSemanticError(
        `inferred relation ${relation.id}のAI依存producer参照が不正です`,
      );
    }
    if (
      producer.producer.nodeId !== relation.fromNodeId &&
      producer.producer.nodeId !== relation.toNodeId
    ) {
      throw new StateSnapshotSemanticError(
        `inferred relation ${relation.id}のAI依存producer nodeがendpointと一致しません`,
      );
    }
  }
  assertAiAnalysisDependencyIntegrity(dependency, `inferred relation ${relation.id}のAI依存`, {
    allowStaleRepository: false,
    allowProducerlessNotRecorded: !relation.active,
    allowProducerlessMigration: true,
    allowProducerlessStaleRepository: false,
    allowHiddenProducerlessNotRecorded: false,
    allowHiddenProducerlessMigration: false,
    allowHiddenProducerlessStaleRepository: false,
    dependencyForProducer: (producer, description) => {
      if (producer.kind !== "relation") {
        throw new StateSnapshotSemanticError(`${description}のproducer種別が不正です`);
      }
      if (historicalDependency) {
        switch (dependency.status) {
          case "current":
          case "unverified":
            return Object.freeze({
              status: dependency.status,
              producers: Object.freeze([producer]),
            });
          case "unknown":
            return Object.freeze({
              status: dependency.status,
              reason: dependency.reason,
              producers: Object.freeze([producer]),
            });
        }
      }
      const producerItem = itemsByNodeId.get(producer.producer.nodeId);
      if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
        throw new StateSnapshotSemanticError(`${description}の生成元itemにAI適用元がありません`);
      }
      const producerDependency = aiAnalysisDependencyForApplication(
        producerItem.nodeId,
        "relations",
        producerItem.aiAnalysis.applications.relations,
      );
      if (producerDependency.status === "not_dependent") {
        throw new StateSnapshotSemanticError(`${description}の生成元itemにAI依存がありません`);
      }
      return aiAnalysisDependencyForRelation(relation.id, producerDependency);
    },
  });
}

function preferredBlockerSupportDependency(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    throw new StateSnapshotSemanticError("blocker supportがありません");
  }
  if (dependencies.some((dependency) => dependency.status === "not_dependent")) {
    return Object.freeze({ status: "not_dependent" });
  }
  if (dependencies.some((dependency) => dependency.status === "current")) {
    return combineAiAnalysisDependencies(
      dependencies.filter((dependency) => dependency.status === "current"),
    );
  }
  if (dependencies.some((dependency) => dependency.status === "unverified")) {
    return combineAiAnalysisDependencies(
      dependencies.filter((dependency) => dependency.status === "unverified"),
    );
  }
  return combineAiAnalysisDependencies(
    dependencies.filter((dependency) => dependency.status === "unknown"),
  );
}

function snapshotRelationCandidateId(relationId: string): RelationCandidateId {
  if (!relationId.startsWith("rel:") || relationId.length === "rel:".length) {
    throw new StateSnapshotSemanticError(`relation IDの形式が不正です。対象: ${relationId}`);
  }
  return `rel:${relationId.slice("rel:".length)}`;
}

function snapshotGraphEdge(relation: Relation): ReconciledGraphEdge {
  const fields = {
    id: snapshotRelationCandidateId(relation.id),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: Object.freeze(
      relation.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
          evidence: Object.freeze([]),
        }),
      ),
    ),
    aiDependency: relation.aiDependency,
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return Object.freeze({ ...fields, active: true });
  }
  return Object.freeze({ ...fields, active: false, removedAt: relation.removedAt });
}

function expectedDownstreamImpactAiDependencies(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> | undefined {
  const stateByNodeId = effectiveGraphStateByNodeId(snapshot);
  const relations: ReconciledGraphEdge[] = [];
  for (const relation of snapshot.relations) {
    if (!("aiDependency" in relation)) {
      return undefined;
    }
    relations.push(snapshotGraphEdge(relation));
  }
  const nodes: GraphAnalysisNode[] = [
    ...snapshot.items.map((item) =>
      Object.freeze({
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state: effectiveGraphStateForNode(stateByNodeId, item.nodeId),
        directNotification: "eligible",
      }),
    ),
    ...snapshot.externalReferences.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        nodeId: reference.nodeId,
        repositoryFullName: reference.repositoryFullName,
        state: reference.state,
        directNotification: reference.directNotification,
      }),
    ),
  ];
  const analysis = analyzeGraph({
    current: Object.freeze({
      nodes: Object.freeze(nodes),
      edges: Object.freeze(relations),
    }),
    previous: Object.freeze({ availability: "unavailable" }),
  });
  return new Map(
    analysis.downstreamImpactAiDependencies.map((entry) => [entry.nodeId, entry.dependency]),
  );
}

function expectedBlockersAiDependencies(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const stateByNodeId = effectiveGraphStateByNodeId(snapshot);
  const openNodeIds = new Set<GraphNodeId>([
    ...snapshot.items
      .filter((item) => effectiveGraphStateForNode(stateByNodeId, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const item of snapshot.items) {
    dependenciesByNodeId.set(item.nodeId, Object.freeze({ status: "not_dependent" }));
  }
  for (const reference of snapshot.externalReferences) {
    dependenciesByNodeId.set(reference.nodeId, Object.freeze({ status: "not_dependent" }));
  }
  const supportsByNodeId = new Map<GraphNodeId, Map<string, AiAnalysisDependency[]>>();
  for (const relation of snapshot.relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      !openNodeIds.has(relation.fromNodeId) ||
      !openNodeIds.has(relation.toNodeId) ||
      !("aiDependency" in relation)
    ) {
      continue;
    }
    const supportsByMeaning = supportsByNodeId.get(relation.toNodeId);
    const key = `${relation.type}\u0000${relation.fromNodeId}\u0000${relation.toNodeId}`;
    if (supportsByMeaning == null) {
      supportsByNodeId.set(relation.toNodeId, new Map([[key, [relation.aiDependency]]]));
      continue;
    }
    const supports = supportsByMeaning.get(key);
    if (supports == null) {
      supportsByMeaning.set(key, [relation.aiDependency]);
      continue;
    }
    supports.push(relation.aiDependency);
  }
  for (const [nodeId, supportsByMeaning] of supportsByNodeId) {
    const selectedSupports = [...supportsByMeaning.values()].map((dependencies) =>
      preferredBlockerSupportDependency(dependencies),
    );
    if (selectedSupports.length !== 0) {
      dependenciesByNodeId.set(nodeId, combineAiAnalysisDependencies(selectedSupports));
    }
  }
  return dependenciesByNodeId;
}

type SnapshotBlocker = Readonly<{
  blockerNodeId: GraphNodeId;
  authority: "authoritative" | "inferred";
  confidenceValue: number;
  becameBlockingAtValue: UtcIsoDateTime;
  dependency: BlockerNodeAiDependency;
}>;

type SnapshotBlockerAnalysis = Readonly<{
  blockersByBlockedNodeId: ReadonlyMap<GraphNodeId, readonly SnapshotBlocker[]>;
  blockerSetDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>;
  negativeDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>;
}>;

type SnapshotBlockerValueAiDependencies = Readonly<{
  stateSupport: "conditional" | "authoritative_blocker";
  statusCandidates: readonly AiAnalysisDependency[] | undefined;
  waitingOn: AiAnalysisDependency | undefined;
  primaryWaitingOn: AiAnalysisDependency | undefined;
  nextAction: AiAnalysisDependency | undefined;
  confidence: AiAnalysisDependency | undefined;
  evidence: AiAnalysisDependency;
  uncertainties: AiAnalysisDependency | undefined;
}>;

type RelationCandidateProducer = Extract<
  AiAnalysisDependencyProducer,
  { kind: "relation_candidate" }
>;

function notDependentSnapshotAiDependency(): AiAnalysisDependency {
  return Object.freeze({ status: "not_dependent" });
}

function combineSnapshotAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  return dependencies.length === 0
    ? notDependentSnapshotAiDependency()
    : combineAiAnalysisDependencies(dependencies);
}

function candidateProofDependencyForProducer(
  producer: RelationCandidateProducer,
  itemsByNodeId: ReadonlyMap<string, SnapshotTrackedItem>,
): AiAnalysisDependency {
  const item = itemsByNodeId.get(producer.producer.nodeId);
  if (item == null) {
    throw new StateSnapshotSemanticError(
      `relation candidate ${producer.candidateId}の生成元itemがありません`,
    );
  }
  const application = item.aiAnalysis.applications.relations;
  const dependency = aiAnalysisDependencyForApplication(item.nodeId, "relations", application);
  return dependency.status === "not_dependent"
    ? aiAnalysisDependencyForMissingRelationCandidateAssessment(item.nodeId, application)
    : dependency;
}

function activeRelationCandidateProofDependency(
  relation: Relation,
): AiAnalysisDependency | undefined {
  const dependency = relation.aiDependency;
  if (dependency.status === "not_dependent") {
    throw new StateSnapshotSemanticError(`推定relation ${relation.id}のAI依存がnot_dependentです`);
  }
  if (dependency.producers == null) {
    return undefined;
  }
  const producers: AiAnalysisDependencyProducer[] = dependency.producers.map((producer) => {
    if (producer.kind !== "relation" || producer.relationId !== relation.id) {
      throw new StateSnapshotSemanticError(`推定relation ${relation.id}のAI依存producerが不正です`);
    }
    return Object.freeze({
      kind: "item_element",
      nodeId: producer.producer.nodeId,
      element: producer.producer.element,
    });
  });
  if (dependency.status === "unknown") {
    return normalizeAiAnalysisDependency({
      status: dependency.status,
      reason: dependency.reason,
      producers: Object.freeze(producers),
    });
  }
  return normalizeAiAnalysisDependency({
    status: dependency.status,
    producers: Object.freeze(producers),
  });
}

function candidateDecisionProofsFromSnapshot(
  items: readonly SnapshotTrackedItem[],
  relations: readonly Relation[],
): readonly RelationCandidateDecisionProof[] {
  const producersByCandidateId = new Map<string, RelationCandidateProducer>();
  for (const item of items) {
    for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
      const dependency = item.aiDependencies[element];
      if (dependency.status === "not_dependent") {
        continue;
      }
      for (const producer of dependency.producers ?? []) {
        if (producer.kind === "relation_candidate") {
          producersByCandidateId.set(producer.candidateId, producer);
        }
      }
    }
  }
  const itemsByNodeId = new Map<string, SnapshotTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const relationsById = new Map(relations.map((relation) => [relation.id, relation]));
  const proofs: RelationCandidateDecisionProof[] = [];
  for (const producer of producersByCandidateId.values()) {
    const candidateId = snapshotRelationCandidateId(producer.candidateId);
    const relation = relationsById.get(candidateId);
    if (relation?.active === true) {
      if (relation.provenance === "native") {
        throw new StateSnapshotSemanticError(
          `relation candidate ${candidateId}がnative relationと衝突しています`,
        );
      }
      const dependency = activeRelationCandidateProofDependency(relation);
      if (dependency == null) {
        continue;
      }
      proofs.push(
        Object.freeze({
          candidateId,
          endpointNodeIds: producer.endpointNodeIds,
          authority: "inferred",
          resolution: Object.freeze({
            candidateId,
            status: "active",
            edgeId: candidateId,
          }),
          dependency,
          canonicalRelation: Object.freeze({
            fromNodeId: relation.fromNodeId,
            toNodeId: relation.toNodeId,
            type: relation.type,
          }),
        }),
      );
      continue;
    }
    proofs.push(
      Object.freeze({
        candidateId,
        endpointNodeIds: producer.endpointNodeIds,
        authority: "inferred",
        resolution: Object.freeze({
          candidateId,
          status: "pending",
          reason: "assessment_missing",
        }),
        dependency: candidateProofDependencyForProducer(producer, itemsByNodeId),
      }),
    );
  }
  return Object.freeze(proofs);
}

function compareSnapshotBlockers(left: SnapshotBlocker, right: SnapshotBlocker): number {
  if (left.authority !== right.authority) {
    return left.authority === "authoritative" ? -1 : 1;
  }
  if (left.confidenceValue !== right.confidenceValue) {
    return right.confidenceValue - left.confidenceValue;
  }
  const becameBlockingAtOrder = compareStrings(
    left.becameBlockingAtValue,
    right.becameBlockingAtValue,
  );
  return becameBlockingAtOrder === 0
    ? compareStrings(left.blockerNodeId, right.blockerNodeId)
    : becameBlockingAtOrder;
}

function expectedSnapshotBlockerAnalysis(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): SnapshotBlockerAnalysis | undefined {
  const stateByNodeId = effectiveGraphStateByNodeId(snapshot);
  const items: SnapshotTrackedItem[] = [];
  for (const item of snapshot.items) {
    if (!("aiDependencies" in item)) {
      return undefined;
    }
    items.push(item);
  }
  const relations: Relation[] = [];
  for (const relation of snapshot.relations) {
    if (!("aiDependency" in relation)) {
      return undefined;
    }
    relations.push(relation);
  }
  const nodes: GraphAnalysisNode[] = [
    ...items.map(
      (item) =>
        Object.freeze({
          kind: item.type,
          nodeId: item.nodeId,
          repositoryId: item.repositoryId,
          state: effectiveGraphStateForNode(stateByNodeId, item.nodeId),
          directNotification: "eligible",
        }) satisfies GraphAnalysisNode,
    ),
    ...snapshot.externalReferences.map(
      (reference) =>
        Object.freeze({
          kind: reference.kind,
          nodeId: reference.nodeId,
          repositoryFullName: reference.repositoryFullName,
          state: reference.state,
          directNotification: "not_eligible",
        }) satisfies GraphAnalysisNode,
    ),
  ];
  const graphSnapshot = Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(relations.map(snapshotGraphEdge)),
  });
  const candidateProofNodeIds = new Set(nodes.map((node) => node.nodeId));
  const candidateDecisionProofs = candidateDecisionProofsFromSnapshot(items, relations).filter(
    (proof) => proof.endpointNodeIds.every((nodeId) => candidateProofNodeIds.has(nodeId)),
  );
  const graphAnalysis = analyzeGraphAiDependencies({
    current: graphSnapshot,
    previous: Object.freeze({ availability: "unavailable" }),
    candidateProofSnapshot: graphSnapshot,
    candidateDecisionProofs,
  });
  const primitiveByArc = new Map(
    graphAnalysis.blockerNodeAiDependencies.map((dependency) => [
      blocksArcKey(dependency.blockerNodeId, dependency.blockedNodeId),
      dependency,
    ]),
  );
  const openNodeIds = new Set<GraphNodeId>([
    ...items
      .filter((item) => effectiveGraphStateForNode(stateByNodeId, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const supportsByArc = new Map<string, Relation[]>();
  for (const relation of relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      !openNodeIds.has(relation.fromNodeId) ||
      !openNodeIds.has(relation.toNodeId)
    ) {
      continue;
    }
    const key = blocksArcKey(relation.fromNodeId, relation.toNodeId);
    const supports = supportsByArc.get(key);
    if (supports == null) {
      supportsByArc.set(key, [relation]);
    } else {
      supports.push(relation);
    }
  }
  const itemsByNodeId = new Map<string, SnapshotTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const blockersByBlockedNodeId = new Map<GraphNodeId, SnapshotBlocker[]>();
  for (const [key, supports] of supportsByArc) {
    const firstSupport = supports[0];
    if (firstSupport == null) {
      throw new StateSnapshotSemanticError("blocker supportがありません");
    }
    const dependency = primitiveByArc.get(key);
    if (dependency == null) {
      throw new StateSnapshotSemanticError(
        `blocker ${firstSupport.fromNodeId}のAI依存primitiveがありません`,
      );
    }
    const targetItem = itemsByNodeId.get(firstSupport.toNodeId);
    const becameBlockingAtValue = supports.reduce(
      (earliest, support) => {
        const value =
          support.provenance === "native" && targetItem != null
            ? targetItem.createdAt
            : support.firstSeenAt;
        return value < earliest ? value : earliest;
      },
      firstSupport.provenance === "native" && targetItem != null
        ? targetItem.createdAt
        : firstSupport.firstSeenAt,
    );
    const blocker = Object.freeze({
      blockerNodeId: firstSupport.fromNodeId,
      authority: supports.some((support) => support.provenance === "native")
        ? "authoritative"
        : "inferred",
      confidenceValue: Math.max(...supports.map((support) => support.confidence)),
      becameBlockingAtValue,
      dependency,
    }) satisfies SnapshotBlocker;
    const blockers = blockersByBlockedNodeId.get(firstSupport.toNodeId);
    if (blockers == null) {
      blockersByBlockedNodeId.set(firstSupport.toNodeId, [blocker]);
    } else {
      blockers.push(blocker);
    }
  }
  return Object.freeze({
    blockersByBlockedNodeId: new Map(
      [...blockersByBlockedNodeId].map(([nodeId, blockers]) => [
        nodeId,
        Object.freeze(blockers.sort(compareSnapshotBlockers)),
      ]),
    ),
    blockerSetDependenciesByNodeId: new Map(
      graphAnalysis.blockerSetAiDependencies.map((entry) => [entry.nodeId, entry.dependency]),
    ),
    negativeDependenciesByNodeId: new Map(
      graphAnalysis.negativeBlockerAiDependencies.map((entry) => [entry.nodeId, entry.dependency]),
    ),
  });
}

function snapshotBlockerPrimitiveDependency(
  blocker: SnapshotBlocker,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineSnapshotAiDependencies(
    primitives.map((primitive) => blocker.dependency[primitive]),
  );
}

function preferredSnapshotAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
  count: number,
): readonly AiAnalysisDependency[] {
  return Object.freeze(
    dependencies
      .map((dependency, index) => Object.freeze({ dependency, index }))
      .sort((left, right) => {
        const priorityOrder =
          aiAnalysisDependencyStatusPriority(left.dependency.status) -
          aiAnalysisDependencyStatusPriority(right.dependency.status);
        return priorityOrder === 0 ? left.index - right.index : priorityOrder;
      })
      .slice(0, count)
      .map((entry) => entry.dependency),
  );
}

function deterministicBlockerDecisionIsBlocked(
  item: SnapshotTrackedItem,
  blockers: readonly SnapshotBlocker[],
  effectiveState: TrackedItemState,
): boolean | undefined {
  if (effectiveState !== "open") {
    return undefined;
  }
  const blockerNodeIds = new Set<string>(blockers.map((blocker) => blocker.blockerNodeId));
  const results: boolean[] = [];
  const applications = item.aiAnalysis.applications;
  if (!aiAnalysisElementApplicationUsesAiValue(applications.status)) {
    results.push(item.status === "waiting_for_unblock");
  }
  if (!aiAnalysisElementApplicationUsesAiValue(applications.waitingOn)) {
    results.push(
      item.waitingOn.some(
        (waitingOn) =>
          waitingOn.kind === "item" &&
          waitingOn.role === "dependency" &&
          blockerNodeIds.has(waitingOn.candidateId),
      ),
    );
  }
  if (!aiAnalysisElementApplicationUsesAiValue(applications.nextAction)) {
    results.push(
      blockers.some((blocker) => item.nextAction === `${blocker.blockerNodeId}の完了を待つ`),
    );
  }
  const authoritativeBlockerExists = blockers.some(
    (blocker) => blocker.authority === "authoritative",
  );
  if (
    new Set(results).size > 1 ||
    (authoritativeBlockerExists && results.some((result) => !result))
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のblocker判定値が相互に矛盾しています`,
    );
  }
  const visibleDecision = results[0];
  if (visibleDecision != null) {
    return visibleDecision;
  }
  return authoritativeBlockerExists ? true : undefined;
}

function deterministicConfirmedBlockers(
  item: SnapshotTrackedItem,
  blockers: readonly SnapshotBlocker[],
  blocked: boolean,
): readonly SnapshotBlocker[] | undefined {
  if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn)) {
    return undefined;
  }
  if (!blocked) {
    return Object.freeze([]);
  }
  const blockersByNodeId = new Map<string, SnapshotBlocker>(
    blockers.map((blocker) => [blocker.blockerNodeId, blocker]),
  );
  const confirmed: SnapshotBlocker[] = [];
  for (const waitingOn of item.waitingOn) {
    if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
      throw new StateSnapshotSemanticError(`item ${item.nodeId}のblocker waitingOnが不正です`);
    }
    const blocker = blockersByNodeId.get(waitingOn.candidateId);
    if (blocker == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblocker waitingOnに対応するactive relationがありません`,
      );
    }
    confirmed.push(blocker);
  }
  if (confirmed.length === 0) {
    throw new StateSnapshotSemanticError(`item ${item.nodeId}の確定blocker waitingOnがありません`);
  }
  return Object.freeze(confirmed);
}

function assertAuthoritativeBlockerStateCompleteness(
  item: SnapshotTrackedItem,
  blockers: readonly SnapshotBlocker[],
): void {
  const authoritativeBlockerNodeIds = blockers
    .filter((blocker) => blocker.authority === "authoritative")
    .map((blocker) => blocker.blockerNodeId);
  if (authoritativeBlockerNodeIds.length === 0) {
    return;
  }
  const waitingOnNodeIds = item.waitingOn.map((waitingOn) => waitingOn.candidateId);
  if (
    authoritativeBlockerNodeIds.some((blockerNodeId) => !waitingOnNodeIds.includes(blockerNodeId))
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のwaitingOnに確定blockerが不足しています`,
    );
  }
  if (
    authoritativeBlockerNodeIds.some(
      (blockerNodeId, index) => waitingOnNodeIds[index] !== blockerNodeId,
    )
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のwaitingOn先頭が確定blockerの順序と一致しません`,
    );
  }
  const primaryAuthoritativeBlockerNodeId = authoritativeBlockerNodeIds[0];
  if (primaryAuthoritativeBlockerNodeId == null) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のprimary確定blockerを再構成できません`,
    );
  }
  if (item.nextAction !== `${primaryAuthoritativeBlockerNodeId}の完了を待つ`) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のnextActionがprimary確定blockerと一致しません`,
    );
  }
}

function blockerStatusDependencyCandidates(
  blockers: readonly SnapshotBlocker[],
  confirmedBlockers: readonly SnapshotBlocker[] | undefined,
): readonly AiAnalysisDependency[] {
  const blockerGroups =
    confirmedBlockers == null
      ? [...new Set(blockers.map((blocker) => blocker.confidenceValue))].map((threshold) =>
          blockers.filter((blocker) => blocker.confidenceValue >= threshold),
        )
      : [confirmedBlockers];
  const dependencies = new Map<string, AiAnalysisDependency>();
  for (const group of blockerGroups) {
    const dependency = preferredBlockerSupportDependency(
      group.map((blocker) =>
        snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
    );
    dependencies.set(hashCanonicalJson(dependency), dependency);
  }
  return Object.freeze([...dependencies.values()]);
}

function expectedSnapshotBlockerValueAiDependencies(
  item: SnapshotTrackedItem,
  analysis: SnapshotBlockerAnalysis,
  effectiveState: TrackedItemState,
): SnapshotBlockerValueAiDependencies {
  if (effectiveState !== "open") {
    const dependency = notDependentSnapshotAiDependency();
    return Object.freeze({
      stateSupport: "conditional",
      statusCandidates: Object.freeze([dependency]),
      waitingOn: dependency,
      primaryWaitingOn: dependency,
      nextAction: dependency,
      confidence: dependency,
      evidence: dependency,
      uncertainties: dependency,
    });
  }
  const blockers = analysis.blockersByBlockedNodeId.get(item.nodeId) ?? [];
  const negativeDependency =
    analysis.negativeDependenciesByNodeId.get(item.nodeId) ?? notDependentSnapshotAiDependency();
  const conditions = blockers.map((blocker) =>
    snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
  );
  const evidence = blockers.map((blocker) =>
    snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence", "sourceIds"]),
  );
  const selectionConditions = blockers.map((blocker) =>
    snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence", "becameBlockingAt"]),
  );
  const blocked = deterministicBlockerDecisionIsBlocked(item, blockers, effectiveState);
  if (blocked == null) {
    return Object.freeze({
      stateSupport: "conditional",
      statusCandidates: undefined,
      waitingOn: undefined,
      primaryWaitingOn: undefined,
      nextAction: undefined,
      confidence: undefined,
      evidence: combineSnapshotAiDependencies([...evidence, negativeDependency]),
      uncertainties: undefined,
    });
  }
  if (!blocked) {
    const stateDependency = combineSnapshotAiDependencies([...conditions, negativeDependency]);
    return Object.freeze({
      stateSupport: "conditional",
      statusCandidates: Object.freeze([stateDependency]),
      waitingOn: stateDependency,
      primaryWaitingOn: stateDependency,
      nextAction: stateDependency,
      confidence: stateDependency,
      evidence: combineSnapshotAiDependencies([...evidence, negativeDependency]),
      uncertainties: stateDependency,
    });
  }
  const primaryBlocker = blockers[0];
  if (primaryBlocker == null) {
    throw new StateSnapshotSemanticError(`item ${item.nodeId}のprimary blockerを再構成できません`);
  }
  const confirmedBlockers = deterministicConfirmedBlockers(item, blockers, blocked);
  const stateSupport =
    primaryBlocker.authority === "authoritative" ? "authoritative_blocker" : "conditional";
  const statusCandidates =
    stateSupport === "authoritative_blocker"
      ? Object.freeze([notDependentSnapshotAiDependency()])
      : blockerStatusDependencyCandidates(blockers, confirmedBlockers);
  let waitingOn: AiAnalysisDependency | undefined;
  let primaryWaitingOn: AiAnalysisDependency | undefined;
  if (confirmedBlockers != null) {
    const confirmedNodeIds = new Set(confirmedBlockers.map((blocker) => blocker.blockerNodeId));
    const uncertainBlockers = blockers.filter(
      (blocker) => !confirmedNodeIds.has(blocker.blockerNodeId),
    );
    waitingOn = combineSnapshotAiDependencies([
      ...confirmedBlockers.map((blocker) =>
        snapshotBlockerPrimitiveDependency(blocker, [
          "presence",
          "confidence",
          "sourceIds",
          "becameBlockingAt",
        ]),
      ),
      ...uncertainBlockers.map((blocker) =>
        snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
      negativeDependency,
    ]);
    const primarySelectionDependency =
      primaryBlocker.authority === "authoritative"
        ? notDependentSnapshotAiDependency()
        : combineSnapshotAiDependencies([...selectionConditions, negativeDependency]);
    const authoritativeConfirmedCount = confirmedBlockers.filter(
      (blocker) => blocker.authority === "authoritative",
    ).length;
    const inferredConfirmedConditions = confirmedBlockers.flatMap((blocker) =>
      blocker.authority === "inferred"
        ? [snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"])]
        : [],
    );
    const multiplicityDependency =
      confirmedBlockers.length === 1
        ? combineSnapshotAiDependencies([
            ...uncertainBlockers.map((blocker) =>
              snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
            negativeDependency,
          ])
        : combineSnapshotAiDependencies(
            preferredSnapshotAiDependencies(
              inferredConfirmedConditions,
              Math.max(0, 2 - authoritativeConfirmedCount),
            ),
          );
    primaryWaitingOn = combineSnapshotAiDependencies([
      primarySelectionDependency,
      multiplicityDependency,
    ]);
  }
  const nextAction =
    stateSupport === "authoritative_blocker"
      ? notDependentSnapshotAiDependency()
      : combineSnapshotAiDependencies([...selectionConditions, negativeDependency]);
  const confidence =
    stateSupport === "authoritative_blocker"
      ? combineSnapshotAiDependencies([
          primaryBlocker.dependency.confidence,
          ...blockers
            .filter((blocker) => blocker.authority === "inferred")
            .map((blocker) =>
              snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
          negativeDependency,
        ])
      : combineSnapshotAiDependencies([
          primaryBlocker.dependency.confidence,
          ...selectionConditions,
          negativeDependency,
        ]);
  return Object.freeze({
    stateSupport,
    statusCandidates,
    waitingOn,
    primaryWaitingOn,
    nextAction,
    confidence,
    evidence: combineSnapshotAiDependencies([...evidence, negativeDependency]),
    uncertainties: combineSnapshotAiDependencies([...conditions, negativeDependency]),
  });
}

function assertBlockerValueDependencyLowerBounds(
  item: SnapshotTrackedItem,
  expected: SnapshotBlockerValueAiDependencies,
): void {
  const applications = item.aiAnalysis.applications;
  const statusUsesAi = aiAnalysisElementApplicationUsesAiValue(applications.status);
  const waitingOnUsesAi = aiAnalysisElementApplicationUsesAiValue(applications.waitingOn);
  const nextActionUsesAi = aiAnalysisElementApplicationUsesAiValue(applications.nextAction);
  const assertLowerBound = (
    element: AiAnalysisDependencyElement,
    dependency: AiAnalysisDependency | undefined,
  ): void => {
    if (dependency == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}の${element} blocker AI依存を再構成できません`,
      );
    }
    if (!aiAnalysisDependencyContainsRecordedLowerBound(dependency, item.aiDependencies[element])) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}の${element} AI依存がblocker判定の導出元を含んでいません`,
      );
    }
  };
  if (!statusUsesAi) {
    const candidates = expected.statusCandidates;
    if (
      candidates?.some((candidate) =>
        aiAnalysisDependencyContainsRecordedLowerBound(candidate, item.aiDependencies.status),
      ) !== true
    ) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のstatus AI依存がblocker判定の導出元を含んでいません`,
      );
    }
  }
  if (!waitingOnUsesAi) {
    assertLowerBound("waitingOn", expected.waitingOn);
    assertLowerBound("primaryWaitingOn", expected.primaryWaitingOn);
  }
  if (!nextActionUsesAi) {
    assertLowerBound("nextAction", expected.nextAction);
  }
  if (
    !statusUsesAi ||
    !waitingOnUsesAi ||
    !nextActionUsesAi ||
    expected.stateSupport === "authoritative_blocker"
  ) {
    assertLowerBound("confidence", expected.confidence);
    assertLowerBound("evidence", expected.evidence);
  }
  if (expected.uncertainties != null) {
    assertLowerBound("uncertainties", expected.uncertainties);
  }
}

function expectedRelationSetAiDependencies(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const item of snapshot.items) {
    dependenciesByNodeId.set(item.nodeId, Object.freeze({ status: "not_dependent" }));
  }
  const supportsByNodeId = new Map<GraphNodeId, Map<string, AiAnalysisDependency[]>>();
  const inferredDecisionsByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  for (const relation of snapshot.relations) {
    if (!relation.active || !("aiDependency" in relation)) {
      continue;
    }
    const key = JSON.stringify([relation.type, relation.fromNodeId, relation.toNodeId]);
    for (const nodeId of [relation.fromNodeId, relation.toNodeId]) {
      if (!dependenciesByNodeId.has(nodeId)) {
        continue;
      }
      if (relation.provenance !== "native") {
        const decisions = inferredDecisionsByNodeId.get(nodeId);
        if (decisions == null) {
          inferredDecisionsByNodeId.set(nodeId, [relation.aiDependency]);
        } else {
          decisions.push(relation.aiDependency);
        }
      }
      const supportsByMeaning = supportsByNodeId.get(nodeId);
      if (supportsByMeaning == null) {
        supportsByNodeId.set(nodeId, new Map([[key, [relation.aiDependency]]]));
        continue;
      }
      const supports = supportsByMeaning.get(key);
      if (supports == null) {
        supportsByMeaning.set(key, [relation.aiDependency]);
      } else {
        supports.push(relation.aiDependency);
      }
    }
  }
  for (const [nodeId, supportsByMeaning] of supportsByNodeId) {
    const dependencies = [...supportsByMeaning.values()].map((supports) =>
      preferredBlockerSupportDependency(supports),
    );
    dependencies.push(...(inferredDecisionsByNodeId.get(nodeId) ?? []));
    dependenciesByNodeId.set(nodeId, combineAiAnalysisDependencies(dependencies));
  }
  return dependenciesByNodeId;
}

function aiAnalysisDependencyStatusPriority(status: AiAnalysisDependency["status"]): number {
  switch (status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(status);
  }
}

function blocksArcKey(fromNodeId: GraphNodeId, toNodeId: GraphNodeId): string {
  return JSON.stringify(["blocks", fromNodeId, toNodeId]);
}

function aiAnalysisDependencyProducerSignature(producer: AiAnalysisDependencyProducer): string {
  return hashCanonicalJson(producer);
}

function expectedProducersAreContained(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  const expectedProducers = expected.status === "not_dependent" ? undefined : expected.producers;
  const actualProducers = actual.status === "not_dependent" ? undefined : actual.producers;
  if (expectedProducers == null || expectedProducers.length === 0) {
    return true;
  }
  if (actualProducers == null) {
    return false;
  }
  const actualProducerSignatures = new Set(
    actualProducers.map(aiAnalysisDependencyProducerSignature),
  );
  return expectedProducers.every((producer) =>
    actualProducerSignatures.has(aiAnalysisDependencyProducerSignature(producer)),
  );
}

function assertAiAnalysisDependencyLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  description: string,
): void {
  if (!aiAnalysisDependencyContainsLowerBound(expected, actual)) {
    throw new StateSnapshotSemanticError(`${description}が導出元のAI依存を含んでいません`);
  }
}

function aiAnalysisDependencyContainsLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  const producerlessMigration =
    actual.status === "unknown" && actual.reason === "migration" && actual.producers == null;
  if (producerlessMigration || expected.status === "not_dependent") {
    return true;
  }
  if (
    aiAnalysisDependencyStatusPriority(actual.status) <
      aiAnalysisDependencyStatusPriority(expected.status) ||
    !expectedProducersAreContained(expected, actual)
  ) {
    return false;
  }
  return true;
}

function aiAnalysisDependencyContainsRecordedLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  if (expected.status === "not_dependent") {
    return true;
  }
  return (
    aiAnalysisDependencyStatusPriority(actual.status) >=
      aiAnalysisDependencyStatusPriority(expected.status) &&
    expectedProducersAreContained(expected, actual)
  );
}

function relationDerivedAiDependency(dependency: AiAnalysisDependency): AiAnalysisDependency {
  if (dependency.status === "not_dependent") {
    return dependency;
  }
  const producers = dependency.producers?.filter((producer) => producer.kind !== "item_element");
  if (producers == null || producers.length === 0) {
    return Object.freeze({ status: "not_dependent" });
  }
  if (dependency.status === "unknown") {
    return normalizeAiAnalysisDependency({
      status: dependency.status,
      reason: dependency.reason,
      producers,
    });
  }
  return normalizeAiAnalysisDependency({ status: dependency.status, producers });
}

function assertGraphDerivedAiDependencyLowerBounds(
  item: SnapshotTrackedItem,
  expectedDownstreamImpact: AiAnalysisDependency,
): void {
  assertAiAnalysisDependencyLowerBound(
    expectedDownstreamImpact,
    item.aiDependencies.downstreamImpact,
    `item ${item.nodeId}のdownstream impact AI依存`,
  );
  if (item.importance.factors.some((factor) => factor.kind === "downstreamImpact")) {
    assertAiAnalysisDependencyLowerBound(
      item.aiDependencies.downstreamImpact,
      item.aiDependencies.importance,
      `item ${item.nodeId}のimportance AI依存`,
    );
  }
  const specialWaitClass =
    item.severityContext.waitClass === "notApplicable" ||
    item.severityContext.waitClass === "blockedParent";
  const severitySource = specialWaitClass
    ? relationDerivedAiDependency(item.aiDependencies.status)
    : combineAiAnalysisDependencies([
        relationDerivedAiDependency(item.aiDependencies.stallSince),
        relationDerivedAiDependency(item.aiDependencies.status),
        relationDerivedAiDependency(item.aiDependencies.waitingOn),
      ]);
  assertAiAnalysisDependencyLowerBound(
    severitySource,
    item.aiDependencies.severity,
    `item ${item.nodeId}のseverity AI依存`,
  );
  const attentionSources = specialWaitClass
    ? [relationDerivedAiDependency(item.aiDependencies.status)]
    : [relationDerivedAiDependency(item.aiDependencies.importance)];
  if (!specialWaitClass && item.importance.score !== 0) {
    attentionSources.push(
      relationDerivedAiDependency(item.aiDependencies.stallSince),
      relationDerivedAiDependency(item.aiDependencies.status),
      relationDerivedAiDependency(item.aiDependencies.waitingOn),
    );
  }
  assertAiAnalysisDependencyLowerBound(
    combineAiAnalysisDependencies(attentionSources),
    item.aiDependencies.attention,
    `item ${item.nodeId}のattention AI依存`,
  );
}

function additionalBlockerProducers(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): readonly AiAnalysisDependencyProducer[] {
  const expectedProducerSignatures = new Set(
    expected.status === "not_dependent"
      ? []
      : (expected.producers ?? []).map(aiAnalysisDependencyProducerSignature),
  );
  const actualProducers = actual.status === "not_dependent" ? [] : (actual.producers ?? []);
  return Object.freeze(
    actualProducers.filter(
      (producer) =>
        !expectedProducerSignatures.has(aiAnalysisDependencyProducerSignature(producer)),
    ),
  );
}

function relationSetExpectedProducerIsCovered(
  expectedProducer: AiAnalysisDependencyProducer,
  actualProducers: readonly AiAnalysisDependencyProducer[],
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  const expectedSignature = aiAnalysisDependencyProducerSignature(expectedProducer);
  if (
    actualProducers.some(
      (producer) => aiAnalysisDependencyProducerSignature(producer) === expectedSignature,
    )
  ) {
    return true;
  }
  if (expectedProducer.kind !== "relation") {
    return false;
  }
  const relation = relationsById.get(expectedProducer.relationId);
  if (relation == null) {
    throw new StateSnapshotSemanticError(
      `relation set AI依存のrelation ${expectedProducer.relationId}がありません`,
    );
  }
  return actualProducers.some(
    (producer) =>
      producer.kind === "relation_candidate" &&
      producer.candidateId === expectedProducer.relationId &&
      producer.endpointNodeIds.includes(relation.fromNodeId) &&
      producer.endpointNodeIds.includes(relation.toNodeId) &&
      producer.producer.nodeId === expectedProducer.producer.nodeId,
  );
}

function relationSetActualProducersAreExpected(
  expectedProducers: readonly AiAnalysisDependencyProducer[],
  actualProducers: readonly AiAnalysisDependencyProducer[],
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  const coverageCountByExpectedSignature = new Map<string, number>();
  for (const actualProducer of actualProducers) {
    if (actualProducer.kind === "item_element") {
      return false;
    }
    const persistedRelation =
      actualProducer.kind === "relation_candidate"
        ? relationsById.get(actualProducer.candidateId)
        : relationsById.get(actualProducer.relationId);
    if (actualProducer.kind === "relation_candidate" && persistedRelation?.active !== true) {
      continue;
    }
    const matchingExpectedProducer = expectedProducers.find((expectedProducer) =>
      relationSetExpectedProducerIsCovered(expectedProducer, [actualProducer], relationsById),
    );
    if (matchingExpectedProducer == null) {
      return false;
    }
    const signature = aiAnalysisDependencyProducerSignature(matchingExpectedProducer);
    const nextCoverageCount = (coverageCountByExpectedSignature.get(signature) ?? 0) + 1;
    if (nextCoverageCount > 1) {
      return false;
    }
    coverageCountByExpectedSignature.set(signature, nextCoverageCount);
  }
  return true;
}

function relationSetDependencySatisfiesExpected(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  const hiddenSentinelOptions = Object.freeze({
    allowHiddenProducerlessNotRecorded: true,
    allowHiddenProducerlessMigration: true,
    allowHiddenProducerlessStaleRepository: false,
  });
  if (aiAnalysisDependencyMatchesExpected(actual, expected, hiddenSentinelOptions)) {
    return true;
  }
  if (
    aiAnalysisDependencyStatusPriority(actual.status) <
    aiAnalysisDependencyStatusPriority(expected.status)
  ) {
    return false;
  }
  const expectedProducers = expected.status === "not_dependent" ? [] : (expected.producers ?? []);
  const actualProducers = actual.status === "not_dependent" ? [] : (actual.producers ?? []);
  if (!relationSetActualProducersAreExpected(expectedProducers, actualProducers, relationsById)) {
    return false;
  }
  return expectedProducers.every((producer) =>
    relationSetExpectedProducerIsCovered(producer, actualProducers, relationsById),
  );
}

function assertNegativeBlockerCandidateDirection(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "relation_candidate" }>,
  blockedNodeId: GraphNodeId,
  activeBlocksArcKeys: ReadonlySet<string>,
): void {
  const [firstEndpoint, secondEndpoint] = producer.endpointNodeIds;
  let otherEndpoint: GraphNodeId | undefined;
  if (firstEndpoint === blockedNodeId) {
    otherEndpoint = secondEndpoint;
  } else if (secondEndpoint === blockedNodeId) {
    otherEndpoint = firstEndpoint;
  }
  if (otherEndpoint == null) {
    throw new StateSnapshotSemanticError(
      `item ${blockedNodeId}のblockers AI依存candidate endpointが親itemと一致しません`,
    );
  }
  if (activeBlocksArcKeys.has(blocksArcKey(otherEndpoint, blockedNodeId))) {
    throw new StateSnapshotSemanticError(
      `item ${blockedNodeId}のblockers AI依存にactiveなnegative relation candidateがあります`,
    );
  }
}

function blockerDependencySatisfiesExpected(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  itemNodeId: GraphNodeId,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
): boolean {
  const hiddenSentinelOptions = Object.freeze({
    allowHiddenProducerlessNotRecorded: true,
    allowHiddenProducerlessMigration: true,
    allowHiddenProducerlessStaleRepository: false,
  });
  if (aiAnalysisDependencyMatchesExpected(actual, expected, hiddenSentinelOptions)) {
    return true;
  }
  if (
    aiAnalysisDependencyStatusPriority(actual.status) <
    aiAnalysisDependencyStatusPriority(expected.status)
  ) {
    return false;
  }
  if (!expectedProducersAreContained(expected, actual)) {
    return false;
  }
  const additionalProducers = additionalBlockerProducers(expected, actual);
  if (additionalProducers.length !== 0) {
    for (const producer of additionalProducers) {
      if (producer.kind === "relation") {
        const relation = relationsById.get(producer.relationId);
        if (
          relation == null ||
          !relation.active ||
          relation.type !== "blocks" ||
          relation.toNodeId !== itemNodeId
        ) {
          return false;
        }
        continue;
      }
      if (producer.kind === "relation_candidate") {
        assertNegativeBlockerCandidateDirection(producer, itemNodeId, activeBlocksArcKeys);
        continue;
      }
      return false;
    }
    const reconstructed = combineAiAnalysisDependencies([
      expected,
      ...additionalProducers.map((producer) =>
        expectedAiAnalysisDependencyForProducer(
          producer,
          `item ${itemNodeId}のblockers AI依存`,
          itemsByNodeId,
          relationsById,
          actual,
        ),
      ),
    ]);
    if (hashCanonicalJson(reconstructed) === hashCanonicalJson(actual)) {
      return true;
    }
    return aiAnalysisDependencyMatchesExpected(actual, reconstructed, hiddenSentinelOptions);
  }
  return false;
}

function assertAiAnalysisSemantics(
  aiAnalysis: TrackedItemAiAnalysis | LegacyTrackedItemAiAnalysis,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
  requireApplications: boolean,
  allowNotRecordedApplicationWithoutAdopted: boolean,
): void {
  let applications: TrackedItemAiAnalysis["applications"] | undefined;
  if (requireApplications) {
    if (!("applications" in aiAnalysis)) {
      throw new StateSnapshotSemanticError("AI適用元がありません");
    }
    applications = assertAiAnalysisElementApplicationsSemantics(
      aiAnalysis.applications,
      "AI適用元",
    );
  }
  if (aiAnalysis.origin === "current") {
    if (aiAnalysis.status === "used" && Object.keys(aiAnalysis.elements).length === 0) {
      throw new StateSnapshotSemanticError("AI分析がusedなのに生成記録がありません");
    }
    assertAiAnalysisElementMapSemantics(
      aiAnalysis.elements,
      "AI判定要素",
      elementSchemaVersion,
      adoptedElementsFormat,
    );
    if (adoptedElementsFormat === "current") {
      assertAiAnalysisCurrentAdoptedMapSemantics(
        aiAnalysis.adoptedElements,
        "AI採用要素",
        elementSchemaVersion,
      );
    } else {
      assertAiAnalysisElementMapSemantics(
        aiAnalysis.adoptedElements,
        "AI採用要素",
        elementSchemaVersion,
        adoptedElementsFormat,
      );
    }
    if (applications != null) {
      assertAiAnalysisApplicationsMatchStoredElements(
        aiAnalysis,
        applications,
        allowNotRecordedApplicationWithoutAdopted,
      );
    }
    return;
  }
  assertAiAnalysisElementMapSemantics(
    aiAnalysis.elements,
    "AI判定要素",
    elementSchemaVersion,
    adoptedElementsFormat,
  );
  assertAiAnalysisMigrationAdoptedMapSemantics(
    aiAnalysis.adoptedElements,
    "移行AI採用要素",
    elementSchemaVersion,
    adoptedElementsFormat === "current",
  );
  if (applications != null) {
    assertAiAnalysisApplicationsMatchStoredElements(
      aiAnalysis,
      applications,
      allowNotRecordedApplicationWithoutAdopted,
    );
  }
}

function normalizeActor(actor: Actor): Actor {
  if (actor.type === "system") {
    return Object.freeze({
      type: actor.type,
      name: actor.name,
    });
  }
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

function normalizePersonalReminderCause(cause: PersonalReminderCause): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    aiDependencies: personalReminderCauseAiDependenciesSchema.parse({
      presence: normalizeAiAnalysisDependency(cause.aiDependencies.presence),
      responseMembership: normalizeAiAnalysisDependency(cause.aiDependencies.responseMembership),
      responsible: normalizeAiAnalysisDependency(cause.aiDependencies.responsible),
      action: normalizeAiAnalysisDependency(cause.aiDependencies.action),
      evidence: normalizeAiAnalysisDependency(cause.aiDependencies.evidence),
    }),
    currentInput: {
      ...cause.currentInput,
      aiDependency: normalizeAiAnalysisDependency(cause.currentInput.aiDependency),
    },
  });
}

function normalizePersonalReminderCausePlanning(
  planning: PersonalReminderCausePlanning,
): PersonalReminderCausePlanning {
  if (planning.status !== "completed") {
    return personalReminderCausePlanningSchema.parse(planning);
  }
  return personalReminderCausePlanningSchema.parse({
    ...planning,
    causeSetAiDependency: normalizeAiAnalysisDependency(planning.causeSetAiDependency),
  });
}

function normalizeAccountActor(actor: GitHubAccountActor): GitHubAccountActor {
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

function assertSnapshotSemantics(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
  requireApplications: boolean,
  requireImplementsEndpointTypes: boolean,
): void {
  assertUtcDateTime(snapshot.generatedAt, "generatedAt");
  if (snapshot.trackingStartAt.status === "fixed") {
    assertUtcDateTime(snapshot.trackingStartAt.value, "trackingStartAt");
  }
  assertUnique(
    snapshot.repositories.map((repository) => repository.id),
    "repository ID",
  );
  assertUnique(
    snapshot.items.map((item) => item.nodeId),
    "item node ID",
  );
  assertUnique(
    snapshot.externalReferences.map((reference) => reference.nodeId),
    "外部参照node ID",
  );
  assertUnique(
    snapshot.relations.map((relation) => relation.id),
    "relation ID",
  );

  const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.id));
  const personalReminderCauseIdValues = snapshot.items.flatMap((item) =>
    "personalReminderCauses" in item
      ? item.personalReminderCauses.map((cause) => cause.causeId)
      : [],
  );
  assertUnique(personalReminderCauseIdValues, "personal reminder cause ID");
  const personalReminderCauseIds = new Set(personalReminderCauseIdValues);
  const personalReminderResponsibilityIdValues = snapshot.items.flatMap((item) =>
    "personalReminderCauses" in item
      ? item.personalReminderCauses.map((cause) => cause.responsibilityId)
      : [],
  );
  assertUnique(personalReminderResponsibilityIdValues, "personal reminder responsibility ID");
  assertUnique(
    snapshot.collection.repositories.map((repository) => repository.repositoryId),
    "収集stateのrepository ID",
  );
  const collectionItemNodeIds = snapshot.collection.repositories.flatMap((repository) =>
    repository.items.map((item) => item.nodeId),
  );
  assertUnique(collectionItemNodeIds, "収集stateのitem node ID");
  const snapshotRepositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  for (const collectionRepository of snapshot.collection.repositories) {
    const snapshotRepository = snapshotRepositoriesById.get(collectionRepository.repositoryId);
    if (snapshotRepository == null) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertUtcDateTime(collectionRepository.successfulAt, "収集stateのrepository成功時刻");
    if (collectionRepository.successfulAt !== snapshotRepository.observedAt) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepository成功時刻がsnapshotのrepository観測時刻と一致しません",
      );
    }
    for (const item of collectionRepository.items) {
      if (item.repositoryId !== collectionRepository.repositoryId) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem repositoryIdが親repositoryと一致しません",
        );
      }
      assertUtcDateTime(item.observedAt, "収集stateのitem観測時刻");
      assertAiAnalysisSemantics(
        item.aiAnalysis,
        elementSchemaVersion,
        adoptedElementsFormat,
        requireApplications,
        true,
      );
      if (item.observedAt > collectionRepository.successfulAt) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem観測時刻はrepository成功時刻以前にしてください",
        );
      }
      if (item.state === "closed") {
        assertUtcDateTime(item.terminalAt, "収集stateのterminal遷移時刻");
        if (item.terminalAt > collectionRepository.successfulAt) {
          throw new StateSnapshotSemanticError(
            "収集stateのterminal遷移時刻はrepository成功時刻以前にしてください",
          );
        }
      }
    }
  }
  for (const repository of snapshot.repositories) {
    assertUtcDateTime(repository.observedAt, "repository observedAt");
    if (repository.freshness === "stale") {
      assertUtcDateTime(repository.failedAt, "stale repository failedAt");
      if (repository.observedAt >= repository.failedAt) {
        throw new StateSnapshotSemanticError(
          "stale repositoryのobservedAtはfailedAtより前にしてください",
        );
      }
    }
    const latestRepositoryTime =
      repository.freshness === "stale" ? repository.failedAt : repository.observedAt;
    if (latestRepositoryTime > snapshot.generatedAt) {
      throw new StateSnapshotSemanticError(
        "repositoryの観測時刻はsnapshot generatedAt以前にしてください",
      );
    }
  }
  if ("graphNodeStateObservations" in snapshot) {
    assertUnique(
      snapshot.graphNodeStateObservations.map((observation) => observation.nodeId),
      "graph node状態観測のnode ID",
    );
    const itemsByNodeId = new Map(snapshot.items.map((item) => [item.nodeId, item]));
    for (const observation of snapshot.graphNodeStateObservations) {
      const item = itemsByNodeId.get(observation.nodeId);
      if (item == null) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測のitemがありません。対象: ${observation.nodeId}`,
        );
      }
      const repository = snapshotRepositoriesById.get(item.repositoryId);
      if (repository?.freshness !== "stale") {
        throw new StateSnapshotSemanticError(
          `graph node状態観測のrepositoryはstaleでなければなりません。対象: ${observation.nodeId}`,
        );
      }
      assertUtcDateTime(observation.observedAt, "graph node状態観測時刻");
      if (observation.observedAt <= item.observedAt) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測時刻はitem観測時刻より後にしてください。対象: ${observation.nodeId}`,
        );
      }
      if (observation.observedAt > snapshot.generatedAt) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測時刻はsnapshot generatedAt以前にしてください。対象: ${observation.nodeId}`,
        );
      }
      if (observation.state === item.state) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測はitem状態と異なる場合だけ保存してください。対象: ${observation.nodeId}`,
        );
      }
      if (item.type === "issue" && observation.state === "merged") {
        throw new StateSnapshotSemanticError(
          `Issueのgraph node状態観測をmergedにはできません。対象: ${observation.nodeId}`,
        );
      }
    }
  }
  for (const item of snapshot.items) {
    if (!repositoryIds.has(item.repositoryId)) {
      throw new StateSnapshotSemanticError(
        "itemのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertAiAnalysisSemantics(
      item.aiAnalysis,
      elementSchemaVersion,
      adoptedElementsFormat,
      requireApplications,
      false,
    );
    if ("aiDependencies" in item) {
      assertAiAnalysisApplicationsMatchTrackedItemValues(item);
    }
    if ("personalReminderCauses" in item) {
      const legacyPersonalReminder = isLegacyPersonalReminder(item);
      assertPersonalReminderCausesSemantics(item, personalReminderCauseIds, legacyPersonalReminder);
      assertPersonalReminderCausePlanningSemantics(item, legacyPersonalReminder);
    }
    if (isTerminalStatus(item.status) && item.waitingOn.length !== 0) {
      throw new StateSnapshotSemanticError("terminal itemにwaitingOnを保存できません");
    }
    if (isTerminalStatus(item.status) && item.severityContext.waitClass !== "notApplicable") {
      throw new StateSnapshotSemanticError(
        "terminal itemのseverity contextはnotApplicableにしてください",
      );
    }
    if (!isTerminalStatus(item.status) && item.severityContext.waitClass === "notApplicable") {
      throw new StateSnapshotSemanticError(
        "継続中itemのseverity contextをnotApplicableにはできません",
      );
    }
    if (
      item.status === "waiting_for_unblock" &&
      item.severityContext.waitClass !== "blockedParent"
    ) {
      throw new StateSnapshotSemanticError(
        "waiting_for_unblock itemのseverity contextはblockedParentにしてください",
      );
    }
    if (
      item.status !== "waiting_for_unblock" &&
      item.severityContext.waitClass === "blockedParent"
    ) {
      throw new StateSnapshotSemanticError(
        "waiting_for_unblock以外のitemのseverity contextをblockedParentにはできません",
      );
    }
    if (item.waitingOn.length === 0 && item.primaryWaitingOn.index !== "not_applicable") {
      throw new StateSnapshotSemanticError("waitingOnがないitemにprimaryを保存できません");
    }
    if (item.waitingOn.length > 0 && item.primaryWaitingOn.index !== 0) {
      throw new StateSnapshotSemanticError("waitingOnがあるitemにはprimaryが必要です");
    }
    assertUnique(
      item.assignees.map((assignee) => assignee.nodeId),
      "itemのassignee node ID",
    );
    assertUnique(
      item.inputEvents.map((event) => event.sourceId),
      "itemの入力イベントsource ID",
    );
    for (const dateTime of [
      item.createdAt,
      item.githubUpdatedAt,
      item.lastHumanActivityAt,
      item.lastProgressAt,
      item.statusSince,
      item.ownerSince,
      item.stallSince,
      item.observedAt,
    ]) {
      assertUtcDateTime(dateTime, "itemの日時");
    }
    assertUnique(
      item.importance.factors.map((factor) => factor.kind),
      "itemのimportance factor kind",
    );
    for (let index = 1; index < item.importance.factors.length; index += 1) {
      const previousFactor = item.importance.factors[index - 1];
      const factor = item.importance.factors[index];
      if (previousFactor == null || factor == null) {
        throw new StateSnapshotSemanticError("importance factorの順序を検証できません");
      }
      if (previousFactor.points < factor.points) {
        throw new StateSnapshotSemanticError("importance factorはpointsの降順にしてください");
      }
    }
    const importanceScore = Math.min(
      100,
      Math.max(
        0,
        Math.round(item.importance.factors.reduce((sum, factor) => sum + factor.points, 0)),
      ),
    );
    if (item.importance.score !== importanceScore) {
      throw new StateSnapshotSemanticError("importance scoreがfactorの合計と一致しません");
    }
    if (item.deadlineAssessment.status === "available") {
      try {
        validateDeadlineDate(item.deadlineAssessment.value.date, "itemの期限日");
      } catch (error: unknown) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        throw new StateSnapshotSemanticError("itemの期限日は実在する日付にしてください");
      }
    }
  }
  const graphNodeIds = new Set([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  const effectiveGraphStates = effectiveGraphStateByNodeId(snapshot);
  const openGraphNodeIds = new Set<GraphNodeId>([
    ...snapshot.items
      .filter((item) => effectiveGraphStateForNode(effectiveGraphStates, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const itemsByNodeId = new Map<string, SnapshotItemForRelationValidation>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const externalReferencesByNodeId = new Map<string, ExternalGhostNode>(
    snapshot.externalReferences.map((reference) => [reference.nodeId, reference]),
  );
  const staleRepositoryIds = new Set(
    snapshot.repositories
      .filter((repository) => repository.freshness === "stale")
      .map((repository) => repository.id),
  );
  const staleGraphNodeIds = new Set<GraphNodeId>(
    snapshot.items
      .filter((item) => staleRepositoryIds.has(item.repositoryId))
      .map((item) => item.nodeId),
  );
  const relationsById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const activeBlocksArcKeys = new Set(
    snapshot.relations
      .filter((relation) => relation.active && relation.type === "blocks")
      .map((relation) => blocksArcKey(relation.fromNodeId, relation.toNodeId)),
  );
  const notDependentOpenBlockerNodeIdsByTargetNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const relation of snapshot.relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      relation.provenance !== "native" ||
      !openGraphNodeIds.has(relation.fromNodeId) ||
      !openGraphNodeIds.has(relation.toNodeId) ||
      !("aiDependency" in relation) ||
      typeof relation.aiDependency !== "object" ||
      !("status" in relation.aiDependency) ||
      relation.aiDependency.status !== "not_dependent"
    ) {
      continue;
    }
    const blockerNodeIds = notDependentOpenBlockerNodeIdsByTargetNodeId.get(relation.toNodeId);
    if (blockerNodeIds == null) {
      notDependentOpenBlockerNodeIdsByTargetNodeId.set(
        relation.toNodeId,
        new Set([relation.fromNodeId]),
      );
    } else {
      blockerNodeIds.add(relation.fromNodeId);
    }
  }
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new StateSnapshotSemanticError("relationがsnapshotにないnodeを参照しています");
    }
    if (requireImplementsEndpointTypes) {
      assertImplementsRelationEndpointTypes(relation, itemsByNodeId, externalReferencesByNodeId);
    }
    assertUtcDateTime(relation.firstSeenAt, "relation firstSeenAt");
    assertUtcDateTime(relation.lastConfirmedAt, "relation lastConfirmedAt");
    if ("aiDependency" in relation) {
      assertRelationAiDependencySemantics(relation.aiDependency, "relationのAI依存");
      if (relation.provenance === "native" && relation.aiDependency.status !== "not_dependent") {
        throw new StateSnapshotSemanticError(
          "native relationのAI依存はnot_dependentでなければなりません",
        );
      }
      assertInferredRelationAiDependencySemantics(
        relation,
        itemsByNodeId,
        !relation.active ||
          staleGraphNodeIds.has(relation.fromNodeId) ||
          staleGraphNodeIds.has(relation.toNodeId),
      );
    }
    if (!relation.active) {
      if (!("removedAt" in relation)) {
        throw new StateSnapshotSemanticError("inactive relationのremovedAtがありません");
      }
      assertUtcDateTime(relation.removedAt, "relation removedAt");
    }
  }
  const relationCandidateDependencies: {
    description: string;
    dependency: AiAnalysisDependency;
    targetNodeId?: GraphNodeId;
  }[] = [];
  for (const item of snapshot.items) {
    if ("aiDependencies" in item) {
      for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
        relationCandidateDependencies.push({
          description: `item ${item.nodeId}の${element} AI依存`,
          dependency: item.aiDependencies[element],
          ...(element === "blockers" ? { targetNodeId: item.nodeId } : {}),
        });
      }
    }
    if ("personalReminderCauses" in item) {
      for (const cause of item.personalReminderCauses) {
        if (!("aiDependencies" in cause) || !("aiDependency" in cause.currentInput)) {
          continue;
        }
        relationCandidateDependencies.push(
          {
            description: `personal reminder cause ${cause.causeId}のpresence AI依存`,
            dependency: cause.aiDependencies.presence,
          },
          {
            description: `personal reminder cause ${cause.causeId}のresponse membership AI依存`,
            dependency: cause.aiDependencies.responseMembership,
          },
          {
            description: `personal reminder cause ${cause.causeId}のresponsible AI依存`,
            dependency: cause.aiDependencies.responsible,
          },
          {
            description: `personal reminder cause ${cause.causeId}のaction AI依存`,
            dependency: cause.aiDependencies.action,
          },
          {
            description: `personal reminder cause ${cause.causeId}のevidence AI依存`,
            dependency: cause.aiDependencies.evidence,
          },
          {
            description: `personal reminder cause ${cause.causeId}のcurrent input AI依存`,
            dependency: cause.currentInput.aiDependency,
          },
        );
      }
      if (
        item.personalReminderCausePlanning.status === "completed" &&
        "causeSetAiDependency" in item.personalReminderCausePlanning
      ) {
        relationCandidateDependencies.push({
          description: `item ${item.nodeId}のpersonal reminder cause set AI依存`,
          dependency: item.personalReminderCausePlanning.causeSetAiDependency,
          targetNodeId: item.nodeId,
        });
      }
    }
  }
  for (const relation of snapshot.relations) {
    if ("aiDependency" in relation) {
      relationCandidateDependencies.push({
        description: `relation ${relation.id}のAI依存`,
        dependency: relation.aiDependency,
      });
    }
  }
  assertRelationCandidateProducerDefinitions(
    relationCandidateDependencies,
    itemsByNodeId,
    relationsById,
  );
  for (const item of snapshot.items) {
    if ("personalReminderCauses" in item) {
      assertPersonalReminderDependenciesSemantics(item, itemsByNodeId, relationsById);
    }
  }
  const expectedBlockerDependenciesByNodeId = expectedBlockersAiDependencies(snapshot);
  const expectedBlockerAnalysis = expectedSnapshotBlockerAnalysis(snapshot);
  const expectedRelationSetDependenciesByNodeId = expectedRelationSetAiDependencies(snapshot);
  const expectedDownstreamImpactDependenciesByNodeId =
    expectedDownstreamImpactAiDependencies(snapshot);
  for (const item of snapshot.items) {
    if (!("aiDependencies" in item)) {
      continue;
    }
    assertTrackedItemAiDependenciesSemantics(
      item.aiDependencies,
      "itemのAI依存",
      item,
      itemsByNodeId,
      relationsById,
      activeBlocksArcKeys,
      notDependentOpenBlockerNodeIdsByTargetNodeId,
      staleGraphNodeIds.has(item.nodeId),
    );
    if (expectedDownstreamImpactDependenciesByNodeId != null) {
      const expectedDownstreamImpact = expectedDownstreamImpactDependenciesByNodeId.get(
        item.nodeId,
      );
      if (expectedDownstreamImpact == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のdownstream impact AI依存の検証対象がありません`,
        );
      }
      assertGraphDerivedAiDependencyLowerBounds(item, expectedDownstreamImpact);
    }
    const relationSetIsProducerlessMigration =
      item.aiDependencies.relationSet.status === "unknown" &&
      item.aiDependencies.relationSet.reason === "migration" &&
      item.aiDependencies.relationSet.producers == null;
    if (!relationSetIsProducerlessMigration) {
      const expectedRelationSet = expectedRelationSetDependenciesByNodeId.get(item.nodeId);
      if (expectedRelationSet == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のrelation set AI依存の検証対象がありません`,
        );
      }
      if (
        !relationSetDependencySatisfiesExpected(
          expectedRelationSet,
          item.aiDependencies.relationSet,
          relationsById,
        )
      ) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のrelation set AI依存がactive incident relation supportと一致しません`,
        );
      }
    }
    const expectedBlockers = expectedBlockerDependenciesByNodeId.get(item.nodeId);
    if (expectedBlockers == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblockers AI依存の検証対象がありません`,
      );
    }
    if (
      !blockerDependencySatisfiesExpected(
        expectedBlockers,
        item.aiDependencies.blockers,
        item.nodeId,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      )
    ) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblockers AI依存がactive/open relation supportと一致しません`,
      );
    }
    if (expectedBlockerAnalysis != null) {
      const expectedBlockerSetDependency =
        expectedBlockerAnalysis.blockerSetDependenciesByNodeId.get(item.nodeId);
      if (expectedBlockerSetDependency == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のblocker set AI依存を再構成できません`,
        );
      }
      if (
        !aiAnalysisDependencyContainsRecordedLowerBound(
          expectedBlockerSetDependency,
          item.aiDependencies.blockers,
        )
      ) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のblockers AI依存がblocker setの導出元を含んでいません`,
        );
      }
      const staleBlockerTopologyFallback =
        staleGraphNodeIds.has(item.nodeId) && hasCanonicalStaleBlockerTopologyDependencies(item);
      if (!staleBlockerTopologyFallback) {
        assertAuthoritativeBlockerStateCompleteness(
          item,
          expectedBlockerAnalysis.blockersByBlockedNodeId.get(item.nodeId) ?? [],
        );
        assertBlockerValueDependencyLowerBounds(
          item,
          expectedSnapshotBlockerValueAiDependencies(
            item,
            expectedBlockerAnalysis,
            effectiveGraphStateForNode(effectiveGraphStates, item.nodeId),
          ),
        );
      }
    }
  }
}

function normalizeSnapshot(snapshot: StateSnapshot): StateSnapshot {
  return Object.freeze({
    ...snapshot,
    trackingStartAt: Object.freeze({
      ...snapshot.trackingStartAt,
    }),
    ai: Object.freeze({
      ...snapshot.ai,
    }),
    collection: Object.freeze({
      repositories: Object.freeze(
        [...snapshot.collection.repositories]
          .sort((left, right) => compareStrings(left.repositoryId, right.repositoryId))
          .map((repository) =>
            Object.freeze({
              ...repository,
              items: Object.freeze(
                [...repository.items]
                  .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
                  .map((item) =>
                    Object.freeze({
                      ...item,
                      aiAnalysis: normalizeTrackedItemAiAnalysis(item.aiAnalysis),
                    }),
                  ),
              ),
            }),
          ),
      ),
    }),
    repositories: Object.freeze(
      [...snapshot.repositories].sort((left, right) => compareStrings(left.id, right.id)),
    ),
    items: Object.freeze(
      [...snapshot.items]
        .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
        .map((item) =>
          Object.freeze({
            ...item,
            aiDependencies: normalizeTrackedItemAiDependencies(item.aiDependencies),
            importance: Object.freeze({
              ...item.importance,
              factors: Object.freeze(
                item.importance.factors.map((factor) =>
                  Object.freeze({
                    ...factor,
                  }),
                ),
              ),
            }),
            attention: Object.freeze({
              ...item.attention,
            }),
            importanceAssessment:
              item.importanceAssessment.status === "not_available"
                ? Object.freeze({
                    status: "not_available",
                  })
                : Object.freeze({
                    status: "available",
                    value: Object.freeze({
                      ...item.importanceAssessment.value,
                    }),
                  }),
            deadlineAssessment:
              item.deadlineAssessment.status === "not_available"
                ? Object.freeze({
                    status: "not_available",
                  })
                : Object.freeze({
                    status: "available",
                    value: Object.freeze({
                      ...item.deadlineAssessment.value,
                    }),
                  }),
            author:
              item.author.status === "unavailable"
                ? Object.freeze({ ...item.author })
                : Object.freeze({
                    ...item.author,
                    actor: normalizeAccountActor(item.author.actor),
                  }),
            latestEventActor:
              item.latestEventActor.status === "absent"
                ? Object.freeze({ ...item.latestEventActor })
                : Object.freeze({
                    ...item.latestEventActor,
                    actor: normalizeActor(item.latestEventActor.actor),
                  }),
            personalReminderCauses: Object.freeze(
              [...item.personalReminderCauses]
                .sort((left, right) => compareStrings(left.causeId, right.causeId))
                .map(normalizePersonalReminderCause),
            ),
            personalReminderCausePlanning: normalizePersonalReminderCausePlanning(
              item.personalReminderCausePlanning,
            ),
            aiAnalysis: normalizeTrackedItemAiAnalysis(item.aiAnalysis),
            inputEvents: Object.freeze(
              [...item.inputEvents]
                .sort((left, right) => compareStrings(left.sourceId, right.sourceId))
                .map((event) =>
                  Object.freeze({
                    ...event,
                  }),
                ),
            ),
            severityContext: Object.freeze({
              ...item.severityContext,
            }),
          }),
        ),
    ),
    graphNodeStateObservations: Object.freeze(
      [...snapshot.graphNodeStateObservations]
        .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
        .map((observation) => Object.freeze({ ...observation })),
    ),
    externalReferences: Object.freeze(
      [...snapshot.externalReferences].sort((left, right) =>
        compareStrings(left.nodeId, right.nodeId),
      ),
    ),
    relations: Object.freeze(
      [...snapshot.relations]
        .sort((left, right) => compareStrings(left.id, right.id))
        .map((relation) =>
          Object.freeze({
            ...relation,
            aiDependency: normalizeAiAnalysisDependency(relation.aiDependency),
          }),
        ),
    ),
    run: Object.freeze({
      ...snapshot.run,
    }),
  });
}

function normalizeTrackedItemAiAnalysis(aiAnalysis: TrackedItemAiAnalysis): TrackedItemAiAnalysis {
  const applications = Object.freeze(
    aiAnalysisElementApplicationsSchema.parse(aiAnalysis.applications),
  );
  if (aiAnalysis.origin === "current") {
    return Object.freeze({
      ...aiAnalysis,
      elements: Object.freeze({
        ...aiAnalysis.elements,
      }),
      adoptedElements: Object.freeze({
        ...aiAnalysis.adoptedElements,
      }),
      applications,
    });
  }
  return Object.freeze({
    ...aiAnalysis,
    elements: Object.freeze({
      ...aiAnalysis.elements,
    }),
    adoptedElements: Object.freeze({
      ...aiAnalysis.adoptedElements,
    }),
    applications,
  });
}

function normalizeTrackedItemAiDependencies(
  dependencies: TrackedItemAiDependencies,
): TrackedItemAiDependencies {
  return Object.freeze({
    status: normalizeAiAnalysisDependency(dependencies.status),
    waitingOn: normalizeAiAnalysisDependency(dependencies.waitingOn),
    nextAction: normalizeAiAnalysisDependency(dependencies.nextAction),
    primaryWaitingOn: normalizeAiAnalysisDependency(dependencies.primaryWaitingOn),
    confidence: normalizeAiAnalysisDependency(dependencies.confidence),
    evidence: normalizeAiAnalysisDependency(dependencies.evidence),
    uncertainties: normalizeAiAnalysisDependency(dependencies.uncertainties),
    deadline: normalizeAiAnalysisDependency(dependencies.deadline),
    deadlineLevel: normalizeAiAnalysisDependency(dependencies.deadlineLevel),
    lastProgressAt: normalizeAiAnalysisDependency(dependencies.lastProgressAt),
    stallSince: normalizeAiAnalysisDependency(dependencies.stallSince),
    severity: normalizeAiAnalysisDependency(dependencies.severity),
    downstreamImpact: normalizeAiAnalysisDependency(dependencies.downstreamImpact),
    importance: normalizeAiAnalysisDependency(dependencies.importance),
    attention: normalizeAiAnalysisDependency(dependencies.attention),
    blockers: normalizeAiAnalysisDependency(dependencies.blockers),
    relationSet: normalizeAiAnalysisDependency(dependencies.relationSet),
  });
}

/** personal reminderの根拠参照がsnapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  const evidenceSourceIds = new Set([
    ...snapshot.items.flatMap((item) => item.evidence.map((evidence) => evidence.sourceId)),
    ...snapshot.relations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    ),
  ]);
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      for (const sourceId of cause.evidenceSourceIds) {
        if (!evidenceSourceIds.has(sourceId)) {
          throw new StateSnapshotSemanticError(
            `personal reminder causeのevidence sourceをsnapshotのevidenceへ解決できません。item: ${item.nodeId} cause: ${cause.causeId} source: ${sourceId}`,
          );
        }
      }
      const assessment = currentPersonalReminderAssessment(cause);
      if (assessment.status !== "available") {
        continue;
      }
      for (const sourceId of assessment.result.references.sourceIds) {
        if (!evidenceSourceIds.has(sourceId)) {
          throw new StateSnapshotSemanticError(
            `personal reminder assessmentのevidence sourceをsnapshotのevidenceへ解決できません。item: ${item.nodeId} cause: ${cause.causeId} source: ${sourceId}`,
          );
        }
      }
    }
  }
}

function parseStateSnapshotVersion11Value(value: unknown): StateSnapshotVersion11 {
  snapshotSchemaVersion11Schema.parse(value);
  if (!validateSnapshotVersion11Schema(value)) {
    const issueCount = validateSnapshotVersion11Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "5", "legacy", false, false);
  return value;
}

function parseStateSnapshotVersion12Value(value: unknown): StateSnapshotVersion12 {
  snapshotSchemaVersion12Schema.parse(value);
  if (!validateSnapshotVersion12Schema(value)) {
    const issueCount = validateSnapshotVersion12Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "5", "legacy", false, false);
  return value;
}

function parseStateSnapshotVersion13Value(value: unknown): StateSnapshotVersion13 {
  snapshotSchemaVersion13Schema.parse(value);
  if (!validateSnapshotVersion13Schema(value)) {
    const issueCount = validateSnapshotVersion13Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "6", "legacy", false, false);
  return value;
}

function parseStateSnapshotVersion14Value(value: unknown): StateSnapshotVersion14 {
  snapshotSchemaVersion14Schema.parse(value);
  if (!validateSnapshotVersion14Schema(value)) {
    const issueCount = validateSnapshotVersion14Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", false, false);
  return value;
}

function parseStateSnapshotVersion15Value(value: unknown): StateSnapshotVersion15 {
  snapshotSchemaVersion15Schema.parse(value);
  if (!validateSnapshotVersion15Schema(value)) {
    const issueCount = validateSnapshotVersion15Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", false, false);
  return value;
}

function parseStateSnapshotVersion16Value(value: unknown): StateSnapshotVersion16 {
  snapshotSchemaVersion16Schema.parse(value);
  if (!validateSnapshotVersion16Schema(value)) {
    const issueCount = validateSnapshotVersion16Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", false, false);
  return value;
}

function parseStateSnapshotVersion17Value(value: unknown): StateSnapshotVersion17 {
  snapshotSchemaVersion17Schema.parse(value);
  if (!validateSnapshotVersion17Schema(value)) {
    const issueCount = validateSnapshotVersion17Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", true, false);
  return value;
}

function parseStateSnapshotVersion18Value(value: unknown): StateSnapshotVersion18 {
  snapshotSchemaVersion18Schema.parse(value);
  if (!validateSnapshotVersion18Schema(value)) {
    const issueCount = validateSnapshotVersion18Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", true, true);
  return value;
}

function parseVersionedStateSnapshot(value: unknown): StateSnapshot {
  const version = z.object({ schemaVersion: z.string() }).parse(value).schemaVersion;
  if (version === SNAPSHOT_SCHEMA_VERSION_18) {
    return normalizeSnapshot(parseStateSnapshotVersion18Value(value));
  }
  throw new StateSnapshotSchemaError(1);
}

/** 未検証の値をschema検証済みかつ決定論的順序のsnapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return normalizeSnapshot(parseStateSnapshotVersion18Value(value));
}

/** snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  return serializeCanonicalJsonLine(createStateSnapshot(snapshot));
}

/** canonical JSONからsnapshotを検証して読み取る。 */
export function parseStateSnapshot(source: string): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseVersionedStateSnapshot(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 11のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion11(source: string): StateSnapshotVersion11 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion11Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 12のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion12(source: string): StateSnapshotVersion12 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion12Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 13のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion13(source: string): StateSnapshotVersion13 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion13Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 14のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion14(source: string): StateSnapshotVersion14 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion14Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 15のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion15(source: string): StateSnapshotVersion15 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion15Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 16のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion16(source: string): StateSnapshotVersion16 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion16Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 17のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion17(source: string): StateSnapshotVersion17 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion17Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

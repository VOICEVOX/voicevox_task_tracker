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
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
  currentPersonalReminderAssessment,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderCause,
  personalReminderCauseSchema,
  type Relation,
  type Repository,
  type Severity,
  type StalenessSeverityContext,
  type TrackingStartAtState,
  type TrackedItem,
  type TrackedItemAiAnalysis,
  type UtcIsoDateTime,
  validateDeadlineDate,
} from "../domain/index.js";
import {
  aiAnalysisElementSchema,
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
import {
  AI_ANALYSIS_ELEMENTS_V6,
  createAiAnalysisElementGenerationSchemaV6,
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementV6,
} from "../domain/ai-analysis-source-generations.js";
import { type PublicRepositoryId, type Sha256Fingerprint } from "../github/index.js";

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

type StateSnapshotFields = Readonly<{
  generatedAt: UtcIsoDateTime;
  trackingStartAt: TrackingStartAtState;
  ai: SnapshotAiState;
  collection: SnapshotCollectionState;
  repositories: readonly SnapshotRepository[];
  items: readonly SnapshotTrackedItem[];
  externalReferences: readonly ExternalGhostNode[];
  relations: readonly Relation[];
  run: SnapshotRun;
}>;

type LegacySnapshotTrackedItem = Omit<SnapshotTrackedItem, "personalReminderCauses">;
type LegacyStateSnapshotFields = Omit<StateSnapshotFields, "items"> &
  Readonly<{
    items: readonly LegacySnapshotTrackedItem[];
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

type StateSnapshotVersion15 = StateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_15;
  }>;

/** tracker-stateへ保存するschema version 15のcurrent snapshot。 */
export type StateSnapshot = StateSnapshotVersion15;

const snapshotSchemaVersionSchema = z.object({
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
  if (currentVariant == null || migrationResultVariant == null) {
    throw new TypeError("snapshot schemaの移行要素定義が不正です");
  }
  if (trackedItemCurrentVariant == null || trackedItemMigrationVariant == null) {
    throw new TypeError("snapshot schemaのAI分析定義が不正です");
  }
  const versionedItem =
    version === SNAPSHOT_SCHEMA_VERSION_15
      ? item
      : {
          ...item,
          required: item.required.filter((key) => key !== "personalReminderCauses"),
          properties: Object.fromEntries(
            Object.entries(item.properties).filter(([key]) => key !== "personalReminderCauses"),
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
    version === SNAPSHOT_SCHEMA_VERSION_14 || version === SNAPSHOT_SCHEMA_VERSION_15
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
  return {
    ...schema,
    $defs: {
      ...snapshotSchema.$defs,
      evidence: versionedEvidence,
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
        version === SNAPSHOT_SCHEMA_VERSION_14 || version === SNAPSHOT_SCHEMA_VERSION_15
          ? snapshotSchema.$defs.aiAnalysisElements
          : legacyAiAnalysisElements,
      aiAnalysisMigrationAdoptedElements:
        version === SNAPSHOT_SCHEMA_VERSION_14 || version === SNAPSHOT_SCHEMA_VERSION_15
          ? snapshotSchema.$defs.aiAnalysisMigrationAdoptedElements
          : legacyAiAnalysisMigrationAdoptedElements,
      trackedItemAiAnalysis:
        version === SNAPSHOT_SCHEMA_VERSION_14 || version === SNAPSHOT_SCHEMA_VERSION_15
          ? trackedItemAiAnalysis
          : {
              ...trackedItemAiAnalysis,
              oneOf: [
                {
                  ...trackedItemCurrentVariant,
                  properties: {
                    ...trackedItemCurrentVariant.properties,
                    elements: {
                      $ref: "#/$defs/aiAnalysisElements",
                    },
                    adoptedElements: {
                      $ref: "#/$defs/aiAnalysisElements",
                    },
                  },
                },
                {
                  ...trackedItemMigrationVariant,
                  properties: {
                    ...trackedItemMigrationVariant.properties,
                    elements: {
                      $ref: "#/$defs/aiAnalysisElements",
                    },
                    adoptedElements: {
                      $ref: "#/$defs/aiAnalysisMigrationAdoptedElements",
                    },
                  },
                },
              ],
            },
      item: versionedItem,
    },
    properties: {
      ...snapshotSchema.properties,
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
const validateSnapshotVersion15Schema = ajv.compile<StateSnapshotVersion15>(snapshotSchema);

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

function assertPersonalReminderTimeBasis(
  value: PersonalReminderCause["obligationSince"],
  item: SnapshotTrackedItem,
  description: string,
): void {
  assertUtcDateTime(value.at, description);
  if (value.at < item.createdAt || value.at > item.observedAt) {
    throw new StateSnapshotSemanticError(
      `${description}はitemの作成時刻以後かつ観測時刻以前にしてください`,
    );
  }
}

function assertPersonalReminderResponsibilitySemantics(cause: PersonalReminderCause): void {
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
  cause: PersonalReminderCause,
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
  item: SnapshotTrackedItem,
  causeIds: ReadonlySet<string>,
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
    const parsedCause = personalReminderCauseSchema.safeParse(cause);
    if (!parsedCause.success) {
      throw new StateSnapshotSemanticError("personal reminder causeが不正です", {
        cause: parsedCause.error,
      });
    }
    if (cause.itemNodeId !== item.nodeId) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのitemNodeIdが親itemと一致しません",
      );
    }
    assertPersonalReminderResponsibilitySemantics(cause);
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
    if (requireReuseProof) {
      const parsedReuseProof = aiAnalysisElementReuseProofSchema.safeParse(reuseProof);
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
  }
}

function assertAiAnalysisSemantics(
  aiAnalysis: TrackedItemAiAnalysis,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
): void {
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

function normalizeAccountActor(actor: GitHubAccountActor): GitHubAccountActor {
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

function assertSnapshotSemantics(
  snapshot: StateSnapshotFields | LegacyStateSnapshotFields,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
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
      assertAiAnalysisSemantics(item.aiAnalysis, elementSchemaVersion, adoptedElementsFormat);
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
  for (const item of snapshot.items) {
    if (!repositoryIds.has(item.repositoryId)) {
      throw new StateSnapshotSemanticError(
        "itemのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertAiAnalysisSemantics(item.aiAnalysis, elementSchemaVersion, adoptedElementsFormat);
    if ("personalReminderCauses" in item) {
      assertPersonalReminderCausesSemantics(item, personalReminderCauseIds);
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
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new StateSnapshotSemanticError("relationがsnapshotにないnodeを参照しています");
    }
    assertUtcDateTime(relation.firstSeenAt, "relation firstSeenAt");
    assertUtcDateTime(relation.lastConfirmedAt, "relation lastConfirmedAt");
    if (!relation.active) {
      assertUtcDateTime(relation.removedAt, "relation removedAt");
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
                .map((cause) => Object.freeze({ ...cause })),
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
    externalReferences: Object.freeze(
      [...snapshot.externalReferences].sort((left, right) =>
        compareStrings(left.nodeId, right.nodeId),
      ),
    ),
    relations: Object.freeze(
      [...snapshot.relations].sort((left, right) => compareStrings(left.id, right.id)),
    ),
    run: Object.freeze({
      ...snapshot.run,
    }),
  });
}

function normalizeTrackedItemAiAnalysis(aiAnalysis: TrackedItemAiAnalysis): TrackedItemAiAnalysis {
  if (aiAnalysis.origin === "current") {
    return Object.freeze({
      ...aiAnalysis,
      elements: Object.freeze({
        ...aiAnalysis.elements,
      }),
      adoptedElements: Object.freeze({
        ...aiAnalysis.adoptedElements,
      }),
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
  });
}

function parseStateSnapshotVersion11Value(value: unknown): StateSnapshotVersion11 {
  snapshotSchemaVersion11Schema.parse(value);
  if (!validateSnapshotVersion11Schema(value)) {
    const issueCount = validateSnapshotVersion11Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "5", "legacy");
  return value;
}

function parseStateSnapshotVersion12Value(value: unknown): StateSnapshotVersion12 {
  snapshotSchemaVersion12Schema.parse(value);
  if (!validateSnapshotVersion12Schema(value)) {
    const issueCount = validateSnapshotVersion12Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "5", "legacy");
  return value;
}

function parseStateSnapshotVersion13Value(value: unknown): StateSnapshotVersion13 {
  snapshotSchemaVersion13Schema.parse(value);
  if (!validateSnapshotVersion13Schema(value)) {
    const issueCount = validateSnapshotVersion13Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "6", "legacy");
  return value;
}

function parseStateSnapshotVersion14Value(value: unknown): StateSnapshotVersion14 {
  snapshotSchemaVersion14Schema.parse(value);
  if (!validateSnapshotVersion14Schema(value)) {
    const issueCount = validateSnapshotVersion14Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current");
  return value;
}

function parseStateSnapshotVersion15Value(value: unknown): StateSnapshot {
  snapshotSchemaVersionSchema.parse(value);
  if (!validateSnapshotVersion15Schema(value)) {
    const issueCount = validateSnapshotVersion15Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current");
  return value;
}

function parseVersionedStateSnapshot(value: unknown): StateSnapshot {
  const version = z.object({ schemaVersion: z.string() }).parse(value).schemaVersion;
  if (version === SNAPSHOT_SCHEMA_VERSION_15) {
    return parseStateSnapshotVersion15Value(value);
  }
  throw new StateSnapshotSchemaError(1);
}

/** 未検証の値をschema検証済みかつ決定論的順序のsnapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return normalizeSnapshot(parseStateSnapshotVersion15Value(value));
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

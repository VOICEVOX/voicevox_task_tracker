import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotSchema from "../../schemas/snapshot.schema.json" with { type: "json" };
import { hashCanonicalJson, serializeCanonicalJsonLine } from "./canonical-json.js";
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
  type Relation,
  type Repository,
  type Severity,
  type StalenessSeverityContext,
  type TrackingStartAtState,
  type TrackedItem,
  type TrackedItemAiAnalysis,
  type TrackedItemAiAnalysisMigrationAdoptedElements,
  type UtcIsoDateTime,
  validateDeadlineDate,
} from "../domain/index.js";
import {
  aiAnalysisElementSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
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
export const SNAPSHOT_SCHEMA_VERSION_12 = "12";

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

type StateSnapshotVersion11 = StateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_11;
  }>;
type StateSnapshotVersion12 = StateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_12;
  }>;

/** tracker-stateへ保存するschema version 12のcurrent snapshot。 */
export type StateSnapshot = StateSnapshotVersion12;

const snapshotSchemaVersionSchema = z.object({
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

function snapshotSchemaForVersion(version: string): object {
  const schema = Object.fromEntries(
    Object.entries(snapshotSchema).filter(([key]) => key !== "$id"),
  );
  const migrationAdoptedElement = snapshotSchema.$defs.aiAnalysisMigrationAdoptedElement;
  const currentVariant = migrationAdoptedElement.oneOf.at(0);
  const migrationResultVariant = migrationAdoptedElement.oneOf.at(1);
  if (currentVariant == null || migrationResultVariant == null) {
    throw new TypeError("snapshot schemaの移行要素定義が不正です");
  }
  return {
    ...schema,
    $defs: {
      ...snapshotSchema.$defs,
      aiAnalysisMigrationAdoptedElement:
        version === SNAPSHOT_SCHEMA_VERSION_11
          ? {
              ...migrationAdoptedElement,
              oneOf: [
                currentVariant,
                {
                  ...migrationResultVariant,
                  properties: {
                    ...migrationResultVariant.properties,
                    result: {
                      $ref: "#/$defs/aiAnalysisResult",
                    },
                  },
                },
              ],
            }
          : migrationAdoptedElement,
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
  snapshotSchemaForVersion(SNAPSHOT_SCHEMA_VERSION_11),
);
const validateSnapshotVersion12Schema = ajv.compile<StateSnapshotVersion12>(snapshotSchema);

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

function assertAiAnalysisElementMapSemantics(
  elements: TrackedItemAiAnalysis["elements"],
  description: string,
): void {
  for (const [key, generation] of Object.entries(elements)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const generationResult = createAiAnalysisElementGenerationSchema(elementResult.data).safeParse(
      generation,
    );
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
  }
}

function assertAiAnalysisMigrationAdoptedMapSemantics(
  elements: TrackedItemAiAnalysisMigrationAdoptedElements,
  description: string,
): void {
  for (const key of Object.keys(elements)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const adopted = elements[elementResult.data];
    if (adopted == null) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`);
    }
    switch (adopted.origin) {
      case "current": {
        const generationSchema = createAiAnalysisElementGenerationSchema(elementResult.data);
        const parsedGeneration = generationSchema.safeParse(adopted.generation);
        if (!parsedGeneration.success) {
          throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
            cause: parsedGeneration.error,
          });
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
        const resultSchema = createAiAnalysisMigrationElementResultSchema(elementResult.data);
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

function assertAiAnalysisSemantics(aiAnalysis: TrackedItemAiAnalysis): void {
  if (aiAnalysis.origin === "current") {
    if (aiAnalysis.status === "used" && Object.keys(aiAnalysis.elements).length === 0) {
      throw new StateSnapshotSemanticError("AI分析がusedなのに生成記録がありません");
    }
    assertAiAnalysisElementMapSemantics(aiAnalysis.elements, "AI判定要素");
    assertAiAnalysisElementMapSemantics(aiAnalysis.adoptedElements, "AI採用要素");
    return;
  }
  assertAiAnalysisElementMapSemantics(aiAnalysis.elements, "AI判定要素");
  assertAiAnalysisMigrationAdoptedMapSemantics(aiAnalysis.adoptedElements, "移行AI採用要素");
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

function assertSnapshotSemantics(snapshot: StateSnapshotFields): void {
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
      assertAiAnalysisSemantics(item.aiAnalysis);
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
    assertAiAnalysisSemantics(item.aiAnalysis);
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
  assertSnapshotSemantics(value);
  return value;
}

function parseStateSnapshotVersion12Value(value: unknown): StateSnapshot {
  snapshotSchemaVersionSchema.parse(value);
  if (!validateSnapshotVersion12Schema(value)) {
    const issueCount = validateSnapshotVersion12Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value);
  return value;
}

function parseVersionedStateSnapshot(value: unknown): StateSnapshot {
  return parseStateSnapshotVersion12Value(value);
}

/** 未検証の値をschema検証済みかつ決定論的順序のsnapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return normalizeSnapshot(parseStateSnapshotVersion12Value(value));
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

import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotSchema from "../../schemas/snapshot.schema.json" with { type: "json" };
import { serializeCanonicalJsonLine, type Sha256Hash } from "./canonical-json.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import {
  type Actor,
  isTerminalStatus,
  type ExternalGhostNode,
  type GitHubAccountActor,
  type GitHubNodeId,
  type NaturalLanguageImportanceAssessmentState,
  type Relation,
  type Repository,
  type Severity,
  type StalenessSeverityContext,
  type TrackingStartAtState,
  type TrackedItem,
  type UtcIsoDateTime,
} from "../domain/index.js";
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

/** snapshotへ保存するseverity付き追跡項目。 */
export type SnapshotTrackedItem = TrackedItem &
  Readonly<{
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    severity: Severity;
    severityContext: StalenessSeverityContext;
  }>;

/** snapshotへ保存する前回Codex分析fingerprint。 */
export type SnapshotAiAnalysisFingerprint =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      fingerprint: Readonly<{
        sourceHash: Sha256Hash;
        inputHash: Sha256Hash;
        graphNeighborhoodHash: Sha256Hash;
        identityHash: Sha256Hash;
      }>;
    }>;

/** 項目を最後に判定したときの判定規則fingerprint。 */
export type SnapshotAnalysisRulesFingerprint =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      fingerprint: Sha256Hash;
    }>;

/** 項目を最後に判定したときの決定規則version。 */
export type SnapshotDeterministicRulesVersion =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      version: string;
    }>;

/** 次回の増分計画、terminal保持判定、Codex未変更判定へ渡す軽量な項目観測値。 */
export type SnapshotCollectionItem = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  itemFingerprint: Sha256Fingerprint;
  aiAnalysisFingerprint: SnapshotAiAnalysisFingerprint;
  analysisRulesFingerprint: SnapshotAnalysisRulesFingerprint;
  deterministicRulesVersion: SnapshotDeterministicRulesVersion;
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

const SNAPSHOT_SCHEMA_VERSION_1 = "1";
const SNAPSHOT_SCHEMA_VERSION_2 = "2";
const SNAPSHOT_SCHEMA_VERSION_3 = "3";
const SNAPSHOT_SCHEMA_VERSION_4 = "4";
const SNAPSHOT_SCHEMA_VERSION_5 = "5";
const SNAPSHOT_SCHEMA_VERSION_6 = "6";

type StateSnapshotVersion6 = Readonly<{
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_6;
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

type StateSnapshotVersionParser = (value: unknown) => StateSnapshot;

/** tracker-stateへ保存するschema version 6のcurrent snapshot。 */
export type StateSnapshot = StateSnapshotVersion6;

const snapshotSchemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});
const snapshotVersion1HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const snapshotVersion1AiAnalysisFingerprintSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("unavailable"),
  }),
  z.strictObject({
    status: z.literal("available"),
    fingerprint: z.strictObject({
      sourceHash: snapshotVersion1HashSchema,
      inputHash: snapshotVersion1HashSchema,
      graphNeighborhoodHash: snapshotVersion1HashSchema,
    }),
  }),
]);
const snapshotVersion1MigrationSchema = z.looseObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_1),
  collection: z.looseObject({
    repositories: z.array(
      z.looseObject({
        items: z.array(
          z.looseObject({
            aiAnalysisFingerprint: snapshotVersion1AiAnalysisFingerprintSchema,
          }),
        ),
      }),
    ),
  }),
});

type StateSnapshotVersion1 = z.output<typeof snapshotVersion1MigrationSchema>;
const snapshotVersion2MigrationSchema = z.looseObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_2),
  collection: z.looseObject({
    repositories: z.array(
      z.looseObject({
        items: z.array(z.looseObject({})),
      }),
    ),
  }),
});

type StateSnapshotVersion2 = z.output<typeof snapshotVersion2MigrationSchema>;
const snapshotVersion3MigrationSchema = z.looseObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_3),
  items: z.array(z.looseObject({})),
});

type StateSnapshotVersion3 = z.output<typeof snapshotVersion3MigrationSchema>;
const snapshotVersion4MigrationSchema = z.looseObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_4),
  items: z.array(z.looseObject({})),
});

type StateSnapshotVersion4 = z.output<typeof snapshotVersion4MigrationSchema>;
const snapshotVersion5AiAnalysisSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_used"),
  }),
  z.strictObject({
    status: z.literal("used"),
    cacheKey: snapshotVersion1HashSchema,
  }),
]);
const snapshotVersion5MigrationSchema = z.looseObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION_5),
  items: z.array(
    z.looseObject({
      aiAnalysis: snapshotVersion5AiAnalysisSchema,
    }),
  ),
});

type StateSnapshotVersion5 = z.output<typeof snapshotVersion5MigrationSchema>;
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
const validateSnapshotVersion6Schema = ajv.compile<StateSnapshotVersion6>(snapshotSchema);

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

function assertSnapshotSemantics(snapshot: StateSnapshot): void {
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
    if (item.milestone?.dueOn != null) {
      assertUtcDateTime(item.milestone.dueOn, "itemのmilestone期限");
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
                      aiAnalysisFingerprint:
                        item.aiAnalysisFingerprint.status === "unavailable"
                          ? Object.freeze({
                              status: "unavailable",
                            })
                          : Object.freeze({
                              status: "available",
                              fingerprint: Object.freeze({
                                ...item.aiAnalysisFingerprint.fingerprint,
                              }),
                            }),
                      analysisRulesFingerprint: Object.freeze({
                        ...item.analysisRulesFingerprint,
                      }),
                      deterministicRulesVersion: Object.freeze({
                        ...item.deterministicRulesVersion,
                      }),
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
            milestone:
              item.milestone == null
                ? null
                : Object.freeze({
                    ...item.milestone,
                  }),
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
            aiAnalysis: Object.freeze({
              ...item.aiAnalysis,
            }),
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

function parseStateSnapshotVersion1(value: unknown): StateSnapshotVersion1 {
  const result = snapshotVersion1MigrationSchema.safeParse(value);
  if (!result.success) {
    throw new StateSnapshotSchemaError(result.error.issues.length);
  }
  return result.data;
}

function migrateStateSnapshotVersion1(snapshot: StateSnapshotVersion1): StateSnapshot {
  return migrateStateSnapshotVersion2(
    parseStateSnapshotVersion2({
      ...snapshot,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_2,
      collection: {
        ...snapshot.collection,
        repositories: snapshot.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysisFingerprint: {
              status: "unavailable",
            },
            analysisRulesFingerprint: {
              status: "unavailable",
            },
          })),
        })),
      },
    }),
  );
}

function parseStateSnapshotVersion2(value: unknown): StateSnapshotVersion2 {
  const result = snapshotVersion2MigrationSchema.safeParse(value);
  if (!result.success) {
    throw new StateSnapshotSchemaError(result.error.issues.length);
  }
  return result.data;
}

function migrateStateSnapshotVersion2(snapshot: StateSnapshotVersion2): StateSnapshot {
  return migrateStateSnapshotVersion3(
    parseStateSnapshotVersion3({
      ...snapshot,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_3,
      collection: {
        ...snapshot.collection,
        repositories: snapshot.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            analysisRulesFingerprint: {
              status: "unavailable",
            },
            deterministicRulesVersion: {
              status: "unavailable",
            },
          })),
        })),
      },
    }),
  );
}

function parseStateSnapshotVersion3(value: unknown): StateSnapshotVersion3 {
  const result = snapshotVersion3MigrationSchema.safeParse(value);
  if (!result.success) {
    throw new StateSnapshotSchemaError(result.error.issues.length);
  }
  return result.data;
}

function migrateStateSnapshotVersion3(snapshot: StateSnapshotVersion3): StateSnapshot {
  return migrateStateSnapshotVersion4(
    parseStateSnapshotVersion4({
      ...snapshot,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_4,
      items: snapshot.items.map((item) => ({
        ...item,
        milestone: null,
      })),
    }),
  );
}

function parseStateSnapshotVersion4(value: unknown): StateSnapshotVersion4 {
  const result = snapshotVersion4MigrationSchema.safeParse(value);
  if (!result.success) {
    throw new StateSnapshotSchemaError(result.error.issues.length);
  }
  return result.data;
}

function migrateStateSnapshotVersion4(snapshot: StateSnapshotVersion4): StateSnapshot {
  return migrateStateSnapshotVersion5(
    parseStateSnapshotVersion5({
      ...snapshot,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_5,
      items: snapshot.items.map((item) => ({
        ...item,
        importance: {
          score: 0,
          level: "low",
          factors: [],
        },
        importanceAssessment: {
          status: "not_available",
        },
      })),
    }),
  );
}

function parseStateSnapshotVersion5(value: unknown): StateSnapshotVersion5 {
  const result = snapshotVersion5MigrationSchema.safeParse(value);
  if (!result.success) {
    throw new StateSnapshotSchemaError(result.error.issues.length);
  }
  return result.data;
}

function migrateStateSnapshotVersion5(snapshot: StateSnapshotVersion5): StateSnapshot {
  return migrateStateSnapshotVersion6(
    parseStateSnapshotVersion6({
      ...snapshot,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_6,
      items: snapshot.items.map((item) => ({
        ...item,
        aiAnalysis:
          item.aiAnalysis.status === "used"
            ? {
                status: "used",
                cacheKey: item.aiAnalysis.cacheKey,
              }
            : {
                status: "not_recorded",
              },
      })),
    }),
  );
}

function parseStateSnapshotVersion6(value: unknown): StateSnapshotVersion6 {
  if (!validateSnapshotVersion6Schema(value)) {
    const issueCount = validateSnapshotVersion6Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value);
  return value;
}

function migrateStateSnapshotVersion6(snapshot: StateSnapshotVersion6): StateSnapshot {
  return normalizeSnapshot(snapshot);
}

function createStateSnapshotVersionParser<TVersion>(
  parser: (value: unknown) => TVersion,
  migration: (snapshot: TVersion) => StateSnapshot,
): StateSnapshotVersionParser {
  return (value) => migration(parser(value));
}

const stateSnapshotVersionParsers: ReadonlyMap<string, StateSnapshotVersionParser> = new Map([
  [
    SNAPSHOT_SCHEMA_VERSION_1,
    createStateSnapshotVersionParser(parseStateSnapshotVersion1, migrateStateSnapshotVersion1),
  ],
  [
    SNAPSHOT_SCHEMA_VERSION_2,
    createStateSnapshotVersionParser(parseStateSnapshotVersion2, migrateStateSnapshotVersion2),
  ],
  [
    SNAPSHOT_SCHEMA_VERSION_3,
    createStateSnapshotVersionParser(parseStateSnapshotVersion3, migrateStateSnapshotVersion3),
  ],
  [
    SNAPSHOT_SCHEMA_VERSION_4,
    createStateSnapshotVersionParser(parseStateSnapshotVersion4, migrateStateSnapshotVersion4),
  ],
  [
    SNAPSHOT_SCHEMA_VERSION_5,
    createStateSnapshotVersionParser(parseStateSnapshotVersion5, migrateStateSnapshotVersion5),
  ],
  [
    SNAPSHOT_SCHEMA_VERSION_6,
    createStateSnapshotVersionParser(parseStateSnapshotVersion6, migrateStateSnapshotVersion6),
  ],
]);

function parseVersionedStateSnapshot(value: unknown): StateSnapshot {
  const versionResult = snapshotSchemaVersionSchema.safeParse(value);
  if (!versionResult.success) {
    throw StateFormatError.fromZodError("snapshot", versionResult.error);
  }
  const parser = stateSnapshotVersionParsers.get(versionResult.data.schemaVersion);
  if (parser == null) {
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshotのschemaVersionは未対応です"),
    });
  }
  return parser(value);
}

/** 未検証の値をschema検証済みかつ決定論的順序のsnapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return migrateStateSnapshotVersion6(parseStateSnapshotVersion6(value));
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

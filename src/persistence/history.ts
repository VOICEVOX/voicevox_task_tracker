import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "./canonical-json.js";
import { StateFormatError, StateHistoryError } from "./errors.js";
import { type StateSnapshot } from "./snapshot.js";
import { type Repository } from "../domain/index.js";

const STATE_HISTORY_SCHEMA_VERSION_1 = "1";

const historySchemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});
const identifierSchema = z.string().min(1).max(512).regex(/^\S+$/u);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const actorSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["human", "bot"]),
    nodeId: identifierSchema,
    login: identifierSchema,
  }),
  z.strictObject({
    type: z.literal("system"),
    name: z.string().min(1).max(512),
  }),
]);
const inputEventSchema = z.strictObject({
  sourceId: identifierSchema,
  itemNodeId: identifierSchema,
  kind: z.enum([
    "comment",
    "push",
    "review",
    "review_request",
    "label",
    "assignee",
    "state",
    "relation",
    "ready_for_review",
    "converted_to_draft",
    "added_to_merge_queue",
    "removed_from_merge_queue",
    "auto_merge_enabled",
    "auto_merge_disabled",
  ]),
  actor: actorSchema,
  occurredAt: dateTimeSchema,
});
const inputEventsSchema = z.array(inputEventSchema).superRefine((events, context) => {
  const sourceIdsByItemNodeId = new Map<string, Set<string>>();
  for (const event of events) {
    const sourceIds = sourceIdsByItemNodeId.get(event.itemNodeId);
    if (sourceIds == null) {
      sourceIdsByItemNodeId.set(event.itemNodeId, new Set([event.sourceId]));
      continue;
    }
    if (sourceIds.has(event.sourceId)) {
      context.addIssue({
        code: "custom",
        message: "同じ項目の正規化イベントのsource IDが重複しています",
      });
      continue;
    }
    sourceIds.add(event.sourceId);
  }
});

function isCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isCalendarDate);
const statusSchema = z.enum([
  "new_untriaged",
  "needs_maintainer_decision",
  "waiting_for_review",
  "waiting_for_author",
  "waiting_for_assignee",
  "blocked",
  "waiting_for_automation",
  "ready_to_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
]);
const waitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: identifierSchema,
  role: z.enum([
    "author",
    "maintainer",
    "reviewer",
    "assignee",
    "dependency",
    "merge_decider",
    "ci",
    "unknown",
  ]),
  reasonSummary: z.string().max(1000),
  sourceIds: z.array(identifierSchema).min(1),
  confidence: z.number().min(0).max(1),
});
const responsibilitySchema = z.strictObject({
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
});
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const evidenceSchema = z.strictObject({
  sourceId: identifierSchema,
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: z.string().max(1000),
});
const relationContradictionSchema = z.strictObject({
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
const edgeFieldsSchema = z.strictObject({
  fromNodeId: identifierSchema,
  toNodeId: identifierSchema,
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
  evidence: z.array(evidenceSchema),
  contradictions: z.array(relationContradictionSchema),
  firstSeenAt: dateTimeSchema,
  lastConfirmedAt: dateTimeSchema,
});
const edgeSchema = z.discriminatedUnion("active", [
  edgeFieldsSchema.extend({
    active: z.literal(true),
  }),
  edgeFieldsSchema.extend({
    active: z.literal(false),
    removedAt: dateTimeSchema,
  }),
]);
const historyEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("responsibility_set"),
    nodeId: identifierSchema,
    value: responsibilitySchema,
  }),
  z.strictObject({
    kind: z.literal("responsibility_removed"),
    nodeId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("severity_set"),
    nodeId: identifierSchema,
    value: severitySchema,
  }),
  z.strictObject({
    kind: z.literal("severity_removed"),
    nodeId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("edge_set"),
    relationId: identifierSchema,
    value: edgeSchema,
  }),
  z.strictObject({
    kind: z.literal("edge_removed"),
    relationId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("repository_excluded"),
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    reason: z.literal("archived"),
  }),
]);
const historyRecordVersion1Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_1),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventSchema),
  })
  .superRefine((record, context) => {
    const keys = record.events.map(historyEventKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "同じ対象と分類のeventが重複しています",
      });
    }
  });

/** 履歴へ保存する責務状態。 */
export type StateHistoryResponsibility = z.output<typeof responsibilitySchema>;

/** 履歴へ保存するedge状態。 */
export type StateHistoryEdge = z.output<typeof edgeSchema>;

/** 日次履歴の一つの変更event。 */
export type StateHistoryEvent = z.output<typeof historyEventSchema>;

/** 日次履歴へ保存する一つの正規化入力イベント。 */
export type StateHistoryInputEvent = z.output<typeof inputEventSchema>;

type StateHistoryRecordVersion1 = z.output<typeof historyRecordVersion1Schema>;
type StateHistoryRecordVersionParser = (value: unknown) => StateHistoryRecord;

/** 一つの完全runが生成した日次履歴record。 */
export type StateHistoryRecord = StateHistoryRecordVersion1;

/** 履歴を指定時点まで再生した責務・edge・severity状態。 */
export type ReplayedStateHistory = Readonly<{
  responsibilities: ReadonlyMap<string, StateHistoryResponsibility>;
  edges: ReadonlyMap<string, StateHistoryEdge>;
  severities: ReadonlyMap<string, z.output<typeof severitySchema>>;
}>;

/** 履歴差分の値が存在するかを明示する型。 */
export type StateHistoryValue<T> =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "present";
      value: T;
    }>;

/** 履歴の二時点間で変化した一つの値。 */
export type StateHistoryDifference<T> = Readonly<{
  id: string;
  before: StateHistoryValue<T>;
  after: StateHistoryValue<T>;
}>;

/** 二日間の責務・edge・severity差分。 */
export type StateHistoryDiff = Readonly<{
  fromDate: string;
  toDate: string;
  responsibilities: readonly StateHistoryDifference<StateHistoryResponsibility>[];
  edges: readonly StateHistoryDifference<StateHistoryEdge>[];
  severities: readonly StateHistoryDifference<z.output<typeof severitySchema>>[];
}>;

type StateHistoryProjection = Readonly<{
  responsibilities: ReadonlyMap<string, StateHistoryResponsibility>;
  edges: ReadonlyMap<string, StateHistoryEdge>;
  severities: ReadonlyMap<string, z.output<typeof severitySchema>>;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareInputEvents(left: StateHistoryInputEvent, right: StateHistoryInputEvent): number {
  const occurredAtComparison = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtComparison !== 0) {
    return occurredAtComparison;
  }
  const sourceIdComparison = compareStrings(left.sourceId, right.sourceId);
  if (sourceIdComparison !== 0) {
    return sourceIdComparison;
  }
  return compareStrings(left.itemNodeId, right.itemNodeId);
}

/** 未検証の値を検証済みかつ決定論的順序の正規化入力イベントへ変換する。 */
export function createStateHistoryInputEvents(value: unknown): readonly StateHistoryInputEvent[] {
  const result = inputEventsSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state履歴の入力イベント", result.error);
  }
  return Object.freeze(
    [...result.data].sort(compareInputEvents).map((event) =>
      Object.freeze({
        ...event,
        actor: Object.freeze({ ...event.actor }),
      }),
    ),
  );
}

function historyEventKey(event: StateHistoryEvent): string {
  switch (event.kind) {
    case "responsibility_set":
    case "responsibility_removed":
      return `responsibility:${event.nodeId}`;
    case "severity_set":
    case "severity_removed":
      return `severity:${event.nodeId}`;
    case "edge_set":
    case "edge_removed":
      return `edge:${event.relationId}`;
    case "repository_excluded":
      return `repository_excluded:${event.repositoryFullName}`;
  }
}

function createRepositoryExclusionEvents(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  repositoryInventory: readonly Repository[],
): readonly StateHistoryEvent[] {
  if (previousSnapshot == null) {
    return Object.freeze([]);
  }
  const currentRepositoryIds = new Set(
    currentSnapshot.repositories.map((repository) => repository.id),
  );
  const inventoryById = new Map(
    repositoryInventory.map((repository) => [repository.id, repository]),
  );
  const events: StateHistoryEvent[] = [];
  for (const previousRepository of previousSnapshot.repositories) {
    if (currentRepositoryIds.has(previousRepository.id)) {
      continue;
    }
    const currentInventoryRepository = inventoryById.get(previousRepository.id);
    if (
      currentInventoryRepository?.visibility === "public" &&
      currentInventoryRepository.archived
    ) {
      events.push({
        kind: "repository_excluded",
        repositoryFullName: `${currentInventoryRepository.owner}/${currentInventoryRepository.name}`,
        reason: "archived",
      });
    }
  }
  return Object.freeze(events);
}

function snapshotInputEventItems(
  snapshot: StateSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  const itemNodeIdsBySourceId = new Map<string, Set<string>>();
  for (const item of snapshot.items) {
    for (const event of item.inputEvents) {
      const itemNodeIds = itemNodeIdsBySourceId.get(event.sourceId);
      if (itemNodeIds == null) {
        itemNodeIdsBySourceId.set(event.sourceId, new Set([item.nodeId]));
        continue;
      }
      if (itemNodeIds.has(item.nodeId)) {
        throw new StateHistoryError("snapshot内で同じ項目の入力イベントsource IDが重複しています");
      }
      itemNodeIds.add(item.nodeId);
    }
  }
  return itemNodeIdsBySourceId;
}

function createNewInputEvents(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  value: readonly StateHistoryInputEvent[],
): readonly StateHistoryInputEvent[] {
  const inputEvents = createStateHistoryInputEvents(value);
  const previousItemNodeIdsBySourceId =
    previousSnapshot == null
      ? new Map<string, ReadonlySet<string>>()
      : snapshotInputEventItems(previousSnapshot);
  const currentItemNodeIdsBySourceId = snapshotInputEventItems(currentSnapshot);
  const events: StateHistoryInputEvent[] = [];
  for (const event of inputEvents) {
    const currentItemNodeIds = currentItemNodeIdsBySourceId.get(event.sourceId);
    if (currentItemNodeIds?.has(event.itemNodeId) !== true) {
      throw new StateHistoryError("正規化イベントが現在のsnapshotの対象項目に存在しません");
    }
    const previousItemNodeIds = previousItemNodeIdsBySourceId.get(event.sourceId);
    if (previousItemNodeIds?.has(event.itemNodeId) !== true) {
      events.push(event);
    }
  }
  return Object.freeze(events);
}

function createProjection(snapshot: StateSnapshot): StateHistoryProjection {
  return {
    responsibilities: new Map(
      snapshot.items.map((item) => [
        item.nodeId,
        {
          status: item.status,
          waitingOn: item.waitingOn.map((waitingOn) => ({
            ...waitingOn,
            sourceIds: [...waitingOn.sourceIds],
          })),
        },
      ]),
    ),
    edges: new Map(
      snapshot.relations.map((relation) => [
        relation.id,
        relation.active
          ? Object.freeze({
              fromNodeId: relation.fromNodeId,
              toNodeId: relation.toNodeId,
              type: relation.type,
              provenance: relation.provenance,
              confidence: relation.confidence,
              evidence: relation.evidence.map((entry) => ({ ...entry })),
              contradictions: relation.contradictions.map((contradiction) => ({
                ...contradiction,
              })),
              firstSeenAt: relation.firstSeenAt,
              lastConfirmedAt: relation.lastConfirmedAt,
              active: true,
            })
          : Object.freeze({
              fromNodeId: relation.fromNodeId,
              toNodeId: relation.toNodeId,
              type: relation.type,
              provenance: relation.provenance,
              confidence: relation.confidence,
              evidence: relation.evidence.map((entry) => ({ ...entry })),
              contradictions: relation.contradictions.map((contradiction) => ({
                ...contradiction,
              })),
              firstSeenAt: relation.firstSeenAt,
              lastConfirmedAt: relation.lastConfirmedAt,
              active: false,
              removedAt: relation.removedAt,
            }),
      ]),
    ),
    severities: new Map(snapshot.items.map((item) => [item.nodeId, item.severity])),
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function createSetAndRemoveEvents<T>(
  category: "responsibility" | "edge" | "severity",
  previous: ReadonlyMap<string, T>,
  current: ReadonlyMap<string, T>,
): StateHistoryEvent[] {
  const events: StateHistoryEvent[] = [];
  const identifiers = [...new Set([...previous.keys(), ...current.keys()])].sort(compareStrings);
  for (const identifier of identifiers) {
    const previousValue = previous.get(identifier);
    const currentValue = current.get(identifier);
    if (currentValue == null) {
      if (previousValue == null) {
        throw new StateHistoryError("履歴差分の削除対象を取得できません");
      }
      if (category === "responsibility") {
        events.push({
          kind: "responsibility_removed",
          nodeId: identifier,
        });
      } else if (category === "edge") {
        events.push({
          kind: "edge_removed",
          relationId: identifier,
        });
      } else {
        events.push({
          kind: "severity_removed",
          nodeId: identifier,
        });
      }
      continue;
    }
    if (previousValue != null && valuesEqual(previousValue, currentValue)) {
      continue;
    }
    if (category === "responsibility") {
      const result = responsibilitySchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("責務差分を検証できません");
      }
      events.push({
        kind: "responsibility_set",
        nodeId: identifier,
        value: result.data,
      });
    } else if (category === "edge") {
      const result = edgeSchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("edge差分を検証できません");
      }
      events.push({
        kind: "edge_set",
        relationId: identifier,
        value: result.data,
      });
    } else {
      const result = severitySchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("severity差分を検証できません");
      }
      events.push({
        kind: "severity_set",
        nodeId: identifier,
        value: result.data,
      });
    }
  }
  return events;
}

function createEmptyProjection(): StateHistoryProjection {
  return {
    responsibilities: new Map(),
    edges: new Map(),
    severities: new Map(),
  };
}

function parseStateHistoryRecordVersion1(value: unknown): StateHistoryRecordVersion1 {
  const result = historyRecordVersion1Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion1(record: StateHistoryRecordVersion1): StateHistoryRecord {
  return Object.freeze(record);
}

function createStateHistoryRecordVersionParser<TVersion>(
  parser: (value: unknown) => TVersion,
  migration: (record: TVersion) => StateHistoryRecord,
): StateHistoryRecordVersionParser {
  return (value) => migration(parser(value));
}

const stateHistoryRecordVersionParsers: ReadonlyMap<string, StateHistoryRecordVersionParser> =
  new Map([
    [
      STATE_HISTORY_SCHEMA_VERSION_1,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion1,
        migrateStateHistoryRecordVersion1,
      ),
    ],
  ]);

function parseVersionedStateHistoryRecord(value: unknown): StateHistoryRecord {
  const versionResult = historySchemaVersionSchema.safeParse(value);
  if (!versionResult.success) {
    throw StateFormatError.fromZodError("state history", versionResult.error);
  }
  const parser = stateHistoryRecordVersionParsers.get(versionResult.data.schemaVersion);
  if (parser == null) {
    throw new StateFormatError("state history", {
      cause: new TypeError("state historyのschemaVersionは未対応です"),
    });
  }
  return parser(value);
}

function validateHistoryRecord(value: unknown): StateHistoryRecord {
  return migrateStateHistoryRecordVersion1(parseStateHistoryRecordVersion1(value));
}

/** previous snapshotからcurrent snapshotへの日次履歴recordを生成する。 */
export function createStateHistoryRecord(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  date: string,
  repositoryInventory: readonly Repository[],
  inputEvents: readonly StateHistoryInputEvent[],
): StateHistoryRecord {
  if (!isCalendarDate(date)) {
    throw new StateHistoryError("履歴の日付が不正です");
  }
  const previous =
    previousSnapshot == null ? createEmptyProjection() : createProjection(previousSnapshot);
  const current = createProjection(currentSnapshot);
  const events = [
    ...createSetAndRemoveEvents(
      "responsibility",
      previous.responsibilities,
      current.responsibilities,
    ),
    ...createSetAndRemoveEvents("edge", previous.edges, current.edges),
    ...createSetAndRemoveEvents("severity", previous.severities, current.severities),
    ...createRepositoryExclusionEvents(previousSnapshot, currentSnapshot, repositoryInventory),
  ].sort((left, right) => compareStrings(historyEventKey(left), historyEventKey(right)));

  return validateHistoryRecord({
    schemaVersion: STATE_HISTORY_SCHEMA_VERSION_1,
    date,
    runId: currentSnapshot.run.id,
    recordedAt: currentSnapshot.generatedAt,
    inputEvents: createNewInputEvents(previousSnapshot, currentSnapshot, inputEvents),
    events,
  });
}

/** JSON Lines文字列から日次履歴recordを検証して読み取る。 */
export function parseStateHistoryRecords(source: string): readonly StateHistoryRecord[] {
  if (source.length === 0) {
    throw new StateFormatError("state history", {
      cause: new TypeError("state historyが空です"),
    });
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new StateFormatError("state history", {
      cause: new TypeError("空のJSON Lines recordがあります"),
    });
  }

  return Object.freeze(
    lines.map((line) => {
      let value: unknown;
      try {
        const parseJson: (text: string) => unknown = JSON.parse;
        value = parseJson(line);
      } catch (error: unknown) {
        throw new StateFormatError("state history", {
          cause: new SyntaxError("JSON Linesの構文が不正です", {
            cause: error,
          }),
        });
      }
      return parseVersionedStateHistoryRecord(value);
    }),
  );
}

/** 日次履歴recordを末尾改行付きcanonical JSON Linesへ変換する。 */
export function serializeStateHistoryRecords(records: readonly StateHistoryRecord[]): string {
  if (records.length === 0) {
    throw new StateHistoryError("保存する履歴recordがありません");
  }
  return records
    .map((record) => serializeCanonicalJsonLine(validateHistoryRecord(record)))
    .join("");
}

/** 既存の日次履歴へrun IDが一意なrecordを追加する。 */
export function appendStateHistoryRecord(
  existingSource: string | undefined,
  record: StateHistoryRecord,
): string {
  const records = existingSource == null ? [] : [...parseStateHistoryRecords(existingSource)];
  if (records.some((existing) => existing.runId === record.runId)) {
    throw new StateHistoryError("同じrun IDの履歴recordが既に存在します");
  }
  if (records.some((existing) => existing.date !== record.date)) {
    throw new StateHistoryError("日次履歴ファイルに異なる日付のrecordがあります");
  }
  records.push(validateHistoryRecord(record));
  return serializeStateHistoryRecords(records);
}

function applyHistoryEvent(
  projection: {
    responsibilities: Map<string, StateHistoryResponsibility>;
    edges: Map<string, StateHistoryEdge>;
    severities: Map<string, z.output<typeof severitySchema>>;
  },
  event: StateHistoryEvent,
): void {
  switch (event.kind) {
    case "responsibility_set":
      projection.responsibilities.set(event.nodeId, event.value);
      return;
    case "responsibility_removed":
      projection.responsibilities.delete(event.nodeId);
      return;
    case "severity_set":
      projection.severities.set(event.nodeId, event.value);
      return;
    case "severity_removed":
      projection.severities.delete(event.nodeId);
      return;
    case "edge_set":
      projection.edges.set(event.relationId, event.value);
      return;
    case "edge_removed":
      projection.edges.delete(event.relationId);
      return;
    case "repository_excluded":
      return;
  }
}

/** 履歴を指定日まで順に適用して状態を再構成する。 */
export function replayStateHistory(
  records: readonly StateHistoryRecord[],
  throughDate: string,
): ReplayedStateHistory {
  if (!isCalendarDate(throughDate)) {
    throw new StateHistoryError("再生終了日が不正です");
  }
  const duplicateRunIds = records.map((record) => record.runId);
  if (new Set(duplicateRunIds).size !== duplicateRunIds.length) {
    throw new StateHistoryError("履歴内でrun IDが重複しています");
  }
  const sortedRecords = records
    .map((record, index) => ({
      record: validateHistoryRecord(record),
      index,
    }))
    .sort((left, right) => {
      const dateComparison = compareStrings(left.record.date, right.record.date);
      if (dateComparison !== 0) {
        return dateComparison;
      }
      return left.index - right.index;
    });
  const projection = {
    responsibilities: new Map<string, StateHistoryResponsibility>(),
    edges: new Map<string, StateHistoryEdge>(),
    severities: new Map<string, z.output<typeof severitySchema>>(),
  };
  for (const { record } of sortedRecords) {
    if (record.date > throughDate) {
      break;
    }
    for (const event of record.events) {
      applyHistoryEvent(projection, event);
    }
  }
  return Object.freeze({
    responsibilities: new Map(projection.responsibilities),
    edges: new Map(projection.edges),
    severities: new Map(projection.severities),
  });
}

function createHistoryValue<T>(
  values: ReadonlyMap<string, T>,
  identifier: string,
): StateHistoryValue<T> {
  const value = values.get(identifier);
  if (value == null) {
    return Object.freeze({
      status: "absent",
    });
  }
  return Object.freeze({
    status: "present",
    value,
  });
}

function createDifferences<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
): readonly StateHistoryDifference<T>[] {
  const identifiers = [...new Set([...before.keys(), ...after.keys()])].sort(compareStrings);
  return Object.freeze(
    identifiers
      .filter((identifier) => {
        if (before.has(identifier) !== after.has(identifier)) {
          return true;
        }
        const beforeValue = before.get(identifier);
        const afterValue = after.get(identifier);
        if (beforeValue == null || afterValue == null) {
          throw new StateHistoryError("履歴差分の比較対象を取得できません");
        }
        return !valuesEqual(beforeValue, afterValue);
      })
      .map((identifier) =>
        Object.freeze({
          id: identifier,
          before: createHistoryValue(before, identifier),
          after: createHistoryValue(after, identifier),
        }),
      ),
  );
}

/** 履歴を二日分まで再生して責務・edge・severity差分を返す。 */
export function diffStateHistory(
  records: readonly StateHistoryRecord[],
  fromDate: string,
  toDate: string,
): StateHistoryDiff {
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate) || fromDate > toDate) {
    throw new StateHistoryError("比較する日付範囲が不正です");
  }
  const before = replayStateHistory(records, fromDate);
  const after = replayStateHistory(records, toDate);
  return Object.freeze({
    fromDate,
    toDate,
    responsibilities: createDifferences(before.responsibilities, after.responsibilities),
    edges: createDifferences(before.edges, after.edges),
    severities: createDifferences(before.severities, after.severities),
  });
}

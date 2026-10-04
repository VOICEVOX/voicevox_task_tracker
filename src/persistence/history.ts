import { historyEventKey } from "./history-event-key.js";
import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import { type Repository } from "../domain/index.js";
import { StateFormatError, StateHistoryError } from "./errors.js";
import type {
  ReplayedStateHistory,
  StateHistoryDiff,
  StateHistoryDifference,
  StateHistoryEdge,
  StateHistoryEvent,
  StateHistoryInputEvent,
  StateHistoryNotificationEvent,
  StateHistoryRecord,
  StateHistoryResponsibility,
  StateHistoryValue,
} from "./history-contracts.js";
import { compareStrings } from "./history-contracts.js";
import type { severitySchema } from "./history-fields-schema.js";
import { isCalendarDate, STATE_HISTORY_SCHEMA_VERSION_7 } from "./history-fields-schema.js";
import { parseVersionedStateHistoryRecord, validateHistoryRecord } from "./history-migration.js";
import { notificationSentEventSchema } from "./history-notification-schema.js";
import {
  createEmptyProjection,
  createNewInputEvents,
  createProjection,
  createRepositoryExclusionEvents,
  createSetAndRemoveEvents,
  valuesEqual,
} from "./history-projection.js";
import type { StateSnapshot } from "./snapshot-contracts.js";

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
    schemaVersion: STATE_HISTORY_SCHEMA_VERSION_7,
    date,
    runId: currentSnapshot.run.id,
    recordedAt: currentSnapshot.generatedAt,
    inputEvents: createNewInputEvents(previousSnapshot, currentSnapshot, inputEvents),
    events,
  });
}

/** 対象runの履歴recordへDiscord通知送信eventを追記する。 */
export function appendStateHistoryNotificationEvents(
  existingSource: string,
  runId: string,
  notificationEvents: readonly StateHistoryNotificationEvent[],
): string {
  const records = [...parseStateHistoryRecords(existingSource)];
  const targetRecords = records.filter((record) => record.runId === runId);
  if (targetRecords.length !== 1) {
    throw new StateHistoryError("通知履歴を追記するrun IDが一意に定まりません");
  }
  const targetRecord = targetRecords[0];
  if (targetRecord == null) {
    throw new StateHistoryError("通知履歴を追記する履歴recordを取得できません");
  }
  const validatedEvents = notificationEvents.map((event) => {
    const result = notificationSentEventSchema.safeParse(event);
    if (!result.success) {
      throw StateFormatError.fromZodError("state history notification event", result.error);
    }
    return result.data;
  });
  const existingKeys = new Set(targetRecord.events.map((event) => historyEventKey(event)));
  const newKeys = new Set<string>();
  for (const event of validatedEvents) {
    const key = historyEventKey(event);
    if (existingKeys.has(key) || newKeys.has(key)) {
      throw new StateHistoryError("同じ通知送信eventが既に存在します");
    }
    if (event.sentAt < targetRecord.recordedAt) {
      throw new StateHistoryError("通知送信時刻が履歴recordの記録時刻より前です");
    }
    newKeys.add(key);
  }
  const updatedRecord = validateHistoryRecord({
    ...targetRecord,
    schemaVersion: STATE_HISTORY_SCHEMA_VERSION_7,
    events: [...targetRecord.events, ...validatedEvents].sort((left, right) =>
      compareStrings(historyEventKey(left), historyEventKey(right)),
    ),
  });
  const updatedRecords = records.map((record) => (record.runId === runId ? updatedRecord : record));
  return serializeStateHistoryRecords(updatedRecords);
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

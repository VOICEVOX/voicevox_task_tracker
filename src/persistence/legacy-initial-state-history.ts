import { serializeCanonicalJson } from "../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import { sortByKey } from "../publication/publication-order.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";
import { createAiCacheMigrationPlan } from "./ai-cache-migration.js";
import type { StateFileReadResult, StatePersistenceConfiguration } from "./branch-adapter.js";
import { decodeStateFile } from "./state-file-codec.js";
import {
  appendStateHistoryRecord,
  createStateHistoryRecord,
  parseStateHistoryRecords,
} from "./history.js";
import type { StateHistoryInputEvent, StateHistorySnapshot } from "./history-contracts.js";
import { migrateStateSnapshot as migrateVersion21Snapshot } from "./snapshot-v21-migration.js";
import { migrateStateSnapshot as migrateVersion22Snapshot } from "./snapshot-v22-migration.js";

const MAX_OPTIONAL_ITEMS = 12;

type LegacyInitialStateHistoryExpectation = Readonly<{
  snapshot: StateHistorySnapshot &
    Readonly<{
      schemaVersion: "21" | "22" | "23";
      finalGraphProjection: Readonly<{ timezone: string }>;
    }>;
  inputEventsDigest: string;
  generatedAt: string;
  timezone: string;
}>;

function fileAt(
  files: ReadonlyMap<string, StateFileReadResult>,
  path: string,
): StateFileReadResult {
  return files.get(path) ?? { status: "missing" };
}

function source(file: StateFileReadResult, kind: string): string {
  const value = decodeStateFile(file, kind);
  assertNonNullable(value, `${kind}がありません`);
  return value;
}

function eventKey(event: Pick<StateHistoryInputEvent, "itemNodeId" | "sourceId">): string {
  return serializeCanonicalJson([event.itemNodeId, event.sourceId]);
}

function snapshotEventKeys(snapshot: StateHistorySnapshot): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const item of snapshot.items) {
    for (const event of item.inputEvents) {
      const key = eventKey({ itemNodeId: item.nodeId, sourceId: event.sourceId });
      if (keys.has(key)) {
        throw new TypeError("旧snapshotの入力eventが重複しています");
      }
      keys.add(key);
    }
  }
  return keys;
}

function parentHistoryEvents(
  configuration: StatePersistenceConfiguration,
  before: ReadonlyMap<string, StateFileReadResult>,
): ReadonlyMap<string, StateHistoryInputEvent> {
  const events = new Map<string, StateHistoryInputEvent>();
  for (const [path, file] of before) {
    if (
      file.status !== "present" ||
      !path.startsWith(`${configuration.historyDirectory}/`) ||
      !path.endsWith(".jsonl")
    ) {
      continue;
    }
    for (const record of parseStateHistoryRecords(source(file, "親履歴file"))) {
      for (const event of record.inputEvents) {
        const key = eventKey(event);
        const prior = events.get(key);
        if (prior != null && serializeCanonicalJson(prior) !== serializeCanonicalJson(event)) {
          throw new TypeError("旧初回commitの親履歴で入力event属性が競合しています");
        }
        events.set(key, event);
      }
    }
  }
  return events;
}

function legacyParentSnapshot(
  configuration: StatePersistenceConfiguration,
  version: "21" | "22",
  timezone: string,
  before: ReadonlyMap<string, StateFileReadResult>,
): StateHistorySnapshot | undefined {
  const cacheFiles = [...before].flatMap(([path, file]) => {
    if (file.status !== "present" || !path.startsWith(`${configuration.aiCacheDirectory}/`)) {
      return [];
    }
    return [{ path, source: source(file, "親AI cache") }];
  });
  const migration = createAiCacheMigrationPlan(configuration.aiCacheDirectory, cacheFiles);
  const snapshotFile = fileAt(before, configuration.snapshotPath);
  if (snapshotFile.status === "missing") {
    if (
      cacheFiles.length > 0 ||
      [...before].some(
        ([path, file]) =>
          file.status === "present" && path.startsWith(`${configuration.historyDirectory}/`),
      )
    ) {
      throw new TypeError("旧初回commitの親履歴またはcacheに対応するsnapshotがありません");
    }
    return undefined;
  }
  const snapshotSource = source(snapshotFile, "親snapshot");
  return version === "21"
    ? migrateVersion21Snapshot(snapshotSource, migration.legacyEntriesByCacheKey, timezone)
    : migrateVersion22Snapshot(snapshotSource, migration.legacyEntriesByCacheKey, timezone);
}

function candidateInputEvents(
  previousSnapshot: StateHistorySnapshot | undefined,
  currentSnapshot: StateHistorySnapshot,
  newInputEvents: readonly StateHistoryInputEvent[],
  historyEvents: ReadonlyMap<string, StateHistoryInputEvent>,
  expectedDigest: string,
): readonly StateHistoryInputEvent[] {
  const previousKeys =
    previousSnapshot == null ? new Set<string>() : snapshotEventKeys(previousSnapshot);
  for (const key of previousKeys) {
    if (!historyEvents.has(key)) {
      throw new TypeError("旧初回commitの親snapshotに対応する履歴入力event属性がありません");
    }
  }
  const newByKey = new Map<string, StateHistoryInputEvent>();
  for (const event of newInputEvents) {
    const key = eventKey(event);
    if (previousKeys.has(key) || newByKey.has(key)) {
      throw new TypeError("旧初回commitの新規履歴入力eventが親snapshotと競合しています");
    }
    const historical = historyEvents.get(key);
    if (
      historical != null &&
      serializeCanonicalJson(historical) !== serializeCanonicalJson(event)
    ) {
      throw new TypeError("旧初回commitの新規履歴入力eventが親履歴と競合しています");
    }
    newByKey.set(key, event);
  }
  const seen = new Set<string>();
  const mandatory: StateHistoryInputEvent[] = [];
  const optional: StateHistoryInputEvent[][] = [];
  for (const item of currentSnapshot.items) {
    const itemEvents: StateHistoryInputEvent[] = [];
    let hasNew = false;
    for (const reference of item.inputEvents) {
      const key = eventKey({ itemNodeId: item.nodeId, sourceId: reference.sourceId });
      if (seen.has(key)) {
        throw new TypeError("旧初回commitのsnapshot入力eventが重複しています");
      }
      seen.add(key);
      const event = previousKeys.has(key) ? historyEvents.get(key) : newByKey.get(key);
      if (event == null) {
        throw new TypeError("旧初回commitのsnapshot入力event属性を履歴から復元できません");
      }
      if (!previousKeys.has(key)) hasNew = true;
      itemEvents.push(event);
    }
    if (hasNew) {
      mandatory.push(...itemEvents);
    } else if (itemEvents.length > 0) {
      optional.push(itemEvents);
    }
  }
  if ([...newByKey.keys()].some((key) => !seen.has(key))) {
    throw new TypeError("旧初回commitの新規履歴入力eventがsnapshotにありません");
  }
  if (optional.length > MAX_OPTIONAL_ITEMS) {
    throw new TypeError("旧初回commitの履歴入力候補が列挙上限を超えています");
  }
  let matched: readonly StateHistoryInputEvent[] | undefined;
  for (let choice = 0; choice < 2 ** optional.length; choice += 1) {
    const events = [...mandatory];
    for (const [index, group] of optional.entries()) {
      if ((choice & (1 << index)) !== 0) events.push(...group);
    }
    const canonical = sortByKey(events, serializeCanonicalJson);
    if (digest.sha256Utf8(serializeCanonicalJson(canonical)) !== expectedDigest) continue;
    if (matched != null) {
      throw new TypeError("旧初回commitの履歴入力候補が一意に定まりません");
    }
    matched = events;
  }
  if (matched == null) {
    throw new TypeError("旧初回commitの履歴入力候補が保存済みdigestと一致しません");
  }
  return matched;
}

/** 旧初回commitの親tree、全入力digest、履歴byteを一つの証拠として照合する。 */
export function assertLegacyInitialStateHistory(
  configuration: StatePersistenceConfiguration,
  historyPath: string,
  expectation: LegacyInitialStateHistoryExpectation,
  before: ReadonlyMap<string, StateFileReadResult>,
  after: ReadonlyMap<string, StateFileReadResult>,
): void {
  const currentSnapshot = expectation.snapshot;
  if (currentSnapshot.schemaVersion !== "21" && currentSnapshot.schemaVersion !== "22") {
    throw new TypeError("旧初回commitのsnapshot版が不正です");
  }
  if (
    currentSnapshot.generatedAt !== expectation.generatedAt ||
    currentSnapshot.finalGraphProjection.timezone !== expectation.timezone
  ) {
    throw new TypeError("旧初回commitのsnapshot時刻またはgraph timezoneがrecordと一致しません");
  }
  const previousSnapshot = legacyParentSnapshot(
    configuration,
    currentSnapshot.schemaVersion,
    expectation.timezone,
    before,
  );
  const previousEvents = parentHistoryEvents(configuration, before);
  const prior = fileAt(before, historyPath);
  const current = fileAt(after, historyPath);
  const currentSource = source(current, "旧初回commitの履歴file");
  const actualRecord = parseStateHistoryRecords(currentSource).at(-1);
  assertNonNullable(actualRecord, "旧初回commitの履歴recordがありません");
  if (actualRecord.events.some((event) => event.kind === "repository_excluded")) {
    throw new TypeError("旧初回commitの除外repositoryを元recordから証明できません");
  }
  const inputEvents = candidateInputEvents(
    previousSnapshot,
    currentSnapshot,
    actualRecord.inputEvents,
    previousEvents,
    expectation.inputEventsDigest,
  );
  const expectedRecord = createStateHistoryRecord(
    previousSnapshot,
    currentSnapshot,
    currentSnapshot.generatedAt.slice(0, 10),
    [],
    inputEvents,
  );
  const expectedSource = appendStateHistoryRecord(
    prior.status === "present" ? source(prior, "旧初回commitの親履歴file") : undefined,
    expectedRecord,
  );
  if (currentSource !== expectedSource) {
    throw new TypeError("旧初回commitの履歴byteが親stateとsnapshotから再導出した値と一致しません");
  }
}

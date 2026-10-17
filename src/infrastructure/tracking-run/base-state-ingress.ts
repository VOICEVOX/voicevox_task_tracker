import type {
  AnalysisPreviousState,
  PreviousSnapshotProjection,
} from "../../application/tracking-run/contracts/previous-state.js";
import { parseSha256Hash } from "../../canonical-json/sha256.js";
import type { AiCacheEntry } from "../../codex/cache.js";
import {
  createPersonalReminderAiCacheEntry,
  type PersonalReminderAiCacheEntry,
} from "../../codex/personal-reminder-cache.js";
import {
  createAiCacheMigrationPlan,
  type AiCacheMigrationFile,
} from "../../persistence/ai-cache-migration.js";
import type {
  StateBranchAdapter,
  StateBranchHead,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { StateBranchConflictError, StateFormatError } from "../../persistence/errors.js";
import type { StateHistoryRecord } from "../../persistence/history-contracts.js";
import { snapshotEffectiveGraphStateByNodeId } from "../../persistence/snapshot-v23.js";
import type { StateNotificationLedger } from "../../persistence/state-documents.js";
import type { StateSnapshotReadResult } from "../../persistence/state-persistence-session.js";
import { StatePersistenceSession } from "../../persistence/state-persistence-session.js";
import { assertStateCommitChain } from "../../persistence/state-commit-chain-verification.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";

/** 現行形式へ変換したbase stateと保存session。 */
export type BaseStateIngress = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  history: readonly StateHistoryRecord[];
  aiCache: readonly AiCacheEntry[];
  personalReminderAiCache: readonly PersonalReminderAiCacheEntry[];
  notificationLedger: StateNotificationLedger;
  previousState: AnalysisPreviousState;
}>;

/** 前回snapshotから解析に必要な値だけを投影する。 */
export function projectPreviousSnapshot(
  snapshot: StateSnapshotReadResult,
): PreviousSnapshotProjection {
  if (snapshot.status !== "available") {
    return Object.freeze({ status: snapshot.status });
  }
  const value = snapshot.snapshot;
  return Object.freeze({
    status: "available",
    trackedItems: Object.freeze([...value.items]),
    collectionRepositories: Object.freeze([...value.collection.repositories]),
    externalReferences: Object.freeze([...value.externalReferences]),
    verifiedExternalReferences: Object.freeze([...value.verifiedExternalReferences]),
    relations: Object.freeze([...value.relations]),
    graphNodeStateObservations: Object.freeze([...value.graphNodeStateObservations]),
    effectiveGraphStates: Object.freeze(
      [...snapshotEffectiveGraphStateByNodeId(value)]
        .map(([nodeId, state]) =>
          Object.freeze([nodeId, state] satisfies [typeof nodeId, typeof state]),
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    trackingStartAt: value.trackingStartAt,
  });
}

function decodeStateFile(bytes: Uint8Array, kind: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new StateFormatError(kind, { cause: error });
  }
}

async function readAiCacheEntries(
  adapter: StateBranchAdapter,
  revision: string,
  directory: string,
): Promise<readonly AiCacheEntry[]> {
  const paths = await adapter.listFiles(revision, directory);
  const results = await adapter.readFiles(revision, paths);
  const files: AiCacheMigrationFile[] = paths.map((path) => {
    const result = results.get(path);
    if (result == null || result.status === "missing") {
      throw new StateFormatError("AI cache", {
        cause: new TypeError("一覧にあるAI cacheを読み取れません"),
      });
    }
    return Object.freeze({ path, source: decodeStateFile(result.bytes, "AI cache") });
  });
  const migration = createAiCacheMigrationPlan(directory, files);
  return Object.freeze([...migration.currentEntriesByCacheKey.values()]);
}

async function readPersonalReminderAiCacheEntries(
  adapter: StateBranchAdapter,
  revision: string,
  directory: string,
): Promise<readonly PersonalReminderAiCacheEntry[]> {
  const paths = await adapter.listFiles(revision, directory);
  const results = await adapter.readFiles(revision, paths);
  const prefix = `${directory}/`;
  const entries: PersonalReminderAiCacheEntry[] = [];
  for (const path of [...paths].sort()) {
    if (!path.startsWith(prefix) || !/^[0-9a-f]{64}\.json$/u.test(path.slice(prefix.length))) {
      throw new StateFormatError("personal reminder AI cache", {
        cause: new TypeError("個人催促AI cacheのpathが不正です"),
      });
    }
    const result = results.get(path);
    if (result == null || result.status === "missing") {
      throw new StateFormatError("personal reminder AI cache", {
        cause: new TypeError("一覧にある個人催促AI cacheを読み取れません"),
      });
    }
    const cacheKey = parseSha256Hash(`sha256:${path.slice(prefix.length, -".json".length)}`);
    let value: unknown;
    try {
      const parseJson: (source: string) => unknown = JSON.parse;
      value = parseJson(decodeStateFile(result.bytes, "personal reminder AI cache"));
    } catch (error: unknown) {
      throw new StateFormatError("personal reminder AI cache", { cause: error });
    }
    let entry: PersonalReminderAiCacheEntry;
    try {
      entry = createPersonalReminderAiCacheEntry(value);
    } catch (error: unknown) {
      throw new StateFormatError("personal reminder AI cache", { cause: error });
    }
    if (entry.cacheKey !== cacheKey) {
      throw new StateFormatError("personal reminder AI cache", {
        cause: new TypeError("個人催促AI cache keyがファイル名と一致しません"),
      });
    }
    entries.push(entry);
  }
  return Object.freeze(entries);
}

/** bootstrap時のexact headから全base state fileを読み込む。 */
export async function readBaseStateIngress(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  migrationTimezone: string,
  expectedHead: StateBranchHead,
): Promise<BaseStateIngress> {
  if (expectedHead.status === "present") {
    const paths = await adapter.listFiles(expectedHead.revision, "state");
    const files = await adapter.readFiles(expectedHead.revision, paths);
    const verified = verifyRunTransactionFiles(files, configuration);
    if (verified != null) {
      if (verified.marker.phase !== "run_finalized") {
        throw new TypeError("未完了runの業務stateはexact runtimeだけが読み取れます");
      }
      await assertStateCommitChain(
        adapter,
        configuration,
        expectedHead.revision,
        verified,
        verified.marker.initialStateRevision,
      );
    }
  }
  const session =
    expectedHead.status === "present"
      ? await StatePersistenceSession.openAtRevision(
          adapter,
          configuration,
          migrationTimezone,
          expectedHead.revision,
        )
      : await StatePersistenceSession.open(adapter, configuration, migrationTimezone);
  const head = await adapter.resolveHead(configuration.branch);
  if (
    head.status !== expectedHead.status ||
    (head.status === "present" &&
      expectedHead.status === "present" &&
      head.revision !== expectedHead.revision)
  ) {
    throw new StateBranchConflictError();
  }
  const [snapshot, history, notificationLedger, aiCache, personalReminderAiCache] =
    await Promise.all([
      session.loadSnapshot(),
      session.loadHistoryRecords(),
      session.loadNotificationLedger(),
      head.status === "present"
        ? readAiCacheEntries(adapter, head.revision, configuration.aiCacheDirectory)
        : Promise.resolve(Object.freeze([])),
      head.status === "present"
        ? readPersonalReminderAiCacheEntries(
            adapter,
            head.revision,
            configuration.personalReminderAiCacheDirectory,
          )
        : Promise.resolve(Object.freeze([])),
    ]);
  return Object.freeze({
    session,
    snapshot,
    history,
    aiCache,
    personalReminderAiCache,
    notificationLedger,
    previousState: Object.freeze({
      snapshot: projectPreviousSnapshot(snapshot),
      history: Object.freeze(
        history.map((record) =>
          Object.freeze({ runId: record.runId, recordedAt: record.recordedAt }),
        ),
      ),
      aiCache: Object.freeze([...aiCache]),
      personalReminderAiCache: Object.freeze([...personalReminderAiCache]),
      notificationLedger: Object.freeze({
        entries: Object.freeze([...notificationLedger.entries]),
        operationsAlerts: Object.freeze([...notificationLedger.operationsAlerts]),
        pendingNotifications: Object.freeze([...notificationLedger.pendingNotifications]),
      }),
    }),
  });
}

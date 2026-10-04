import { z } from "zod";

import type { Repository } from "../domain/index.js";
import {
  createAiCacheEntry,
  type AiCacheEntry,
  type AiCacheKey,
  type AiCacheReadResult,
  type AiCacheStore,
} from "../codex/cache.js";
import {
  createPersonalReminderAiCacheEntry,
  type PersonalReminderAiCacheEntry,
  type PersonalReminderAiCacheKey,
  type PersonalReminderAiCacheReadResult,
  type PersonalReminderAiCacheStore,
} from "../codex/personal-reminder-cache.js";
import type { AiCacheMigrationPlan } from "./ai-cache-migration.js";
import {
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateBranchConflictError, StateFormatError, StateHistoryError } from "./errors.js";
import type {
  StateHistoryDiff,
  StateHistoryRecord,
  StateHistoryInputEvent,
} from "./history-contracts.js";
import { diffStateHistory, parseStateHistoryRecords } from "./history.js";
import {
  readInitialPublicationBaseState,
  type InitialPublicationBaseState,
} from "./initial-publication-base-state.js";
import { OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 } from "./operations-alert-ledger.js";
import { migrateStateSnapshot } from "./snapshot-v23-migration.js";
import type { StateSnapshot } from "./snapshot-v23.js";
import { readAiCacheMigrationPlan } from "./state-ai-cache-migration-plan.js";
import { cachePath, personalReminderAiCachePath } from "./state-cache-paths.js";
import type { StateNotificationLedger } from "./state-documents.js";
import { decodeStateFile } from "./state-file-codec.js";
import { compareStateKeys as compareStrings } from "./state-key-order.js";
import { loadStateNotificationLedgers } from "./state-ledger-files.js";

const HISTORY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const STATE_ROOT_DIRECTORY = "state";

/** session開始時点のsnapshot読み取り結果。 */
export type StateSnapshotReadResult =
  | Readonly<{
      status: "missing_branch";
    }>
  | Readonly<{
      status: "operations_only";
    }>
  | Readonly<{
      status: "available";
      snapshot: StateSnapshot;
    }>;

/** state永続化sessionがcommitしたrevisionとファイル一覧。 */
export type PersistStateTransactionResult = StateBranchCommitResult &
  Readonly<{
    updatedPaths: readonly string[];
  }>;

function createAiCacheStateFormatError(error: unknown): StateFormatError {
  if (error instanceof z.ZodError) {
    return StateFormatError.fromZodError("AI cache", error);
  }
  return new StateFormatError("AI cache", {
    cause: new TypeError("AI cache entryの検証に失敗しました", {
      cause: error,
    }),
  });
}

function createPersonalReminderAiCacheStateFormatError(error: unknown): StateFormatError {
  if (error instanceof z.ZodError) {
    return StateFormatError.fromZodError("personal reminder AI cache", error);
  }
  return new StateFormatError("personal reminder AI cache", {
    cause: new TypeError("個人催促AI cache entryの検証に失敗しました", {
      cause: error,
    }),
  });
}

/** 同じbranch revisionを読み、全成果物を一つのcommitへまとめるsession。 */
export class StatePersistenceSession {
  readonly #adapter: StateBranchAdapter;
  readonly #configuration: StatePersistenceConfiguration;
  readonly #migrationTimezone: string;
  readonly #aiCacheMigrationPlan: AiCacheMigrationPlan;
  readonly #pendingAiCacheEntries = new Map<AiCacheKey, AiCacheEntry>();
  readonly #pendingPersonalReminderAiCacheEntries = new Map<
    PersonalReminderAiCacheKey,
    PersonalReminderAiCacheEntry
  >();
  readonly #pendingAiCacheDeletionPaths: readonly string[];
  #head: StateBranchHead;

  public readonly aiCache: AiCacheStore;
  public readonly personalReminderAiCache: PersonalReminderAiCacheStore;
  /** sessionが固定したstate branch revision。 */
  public get baseRevision(): StateBranchHead {
    return this.#head;
  }
  private constructor(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
    head: StateBranchHead,
    aiCacheMigrationPlan: AiCacheMigrationPlan,
  ) {
    this.#adapter = adapter;
    this.#configuration = Object.freeze({
      ...configuration,
    });
    this.#migrationTimezone = migrationTimezone;
    this.#head = head;
    this.#aiCacheMigrationPlan = aiCacheMigrationPlan;
    this.#pendingAiCacheDeletionPaths = aiCacheMigrationPlan.legacyCachePaths;
    this.aiCache = Object.freeze({
      read: (cacheKey) => this.#readAiCache(cacheKey),
      write: (entry) => this.#bufferAiCache(entry),
    });
    this.personalReminderAiCache = Object.freeze({
      read: (cacheKey) => this.#readPersonalReminderAiCache(cacheKey),
      write: (entry) => this.#bufferPersonalReminderAiCache(entry),
    });
  }

  /** state branchのheadを固定して新しいsessionを開始する。 */
  public static async open(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
  ): Promise<StatePersistenceSession> {
    validateStatePersistenceConfiguration(configuration);
    const head = await adapter.resolveHead(configuration.branch);
    const aiCacheMigrationPlan = await readAiCacheMigrationPlan(adapter, configuration, head);
    return new StatePersistenceSession(
      adapter,
      configuration,
      migrationTimezone,
      head,
      aiCacheMigrationPlan,
    );
  }

  /** 指定したbranch headと一致するstate sessionを開始する。 */
  public static async openAtRevision(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
    expectedRevision: string,
  ): Promise<StatePersistenceSession> {
    validateStatePersistenceConfiguration(configuration);
    const head = await adapter.resolveHead(configuration.branch);
    if (head.status !== "present" || head.revision !== expectedRevision) {
      throw new StateBranchConflictError();
    }
    const aiCacheMigrationPlan = await readAiCacheMigrationPlan(adapter, configuration, head);
    return new StatePersistenceSession(
      adapter,
      configuration,
      migrationTimezone,
      head,
      aiCacheMigrationPlan,
    );
  }

  /** 現在のsession headをリモートへ公開する。 */
  public async publish(): Promise<void> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("state branch", {
        cause: new TypeError("state branch作成前に公開できません"),
      });
    }
    await this.#adapter.publish({
      branch: this.#configuration.branch,
      revision: this.#head.revision,
    });
  }

  async #readFile(path: string): Promise<StateFileReadResult> {
    if (this.#head.status === "missing") {
      return Object.freeze({
        status: "missing",
      });
    }
    return this.#adapter.readFile(this.#head.revision, path);
  }

  async #readAiCache(cacheKey: AiCacheKey): Promise<AiCacheReadResult> {
    const pendingEntry = this.#pendingAiCacheEntries.get(cacheKey);
    if (pendingEntry != null) {
      return Object.freeze({
        status: "hit",
        entry: pendingEntry,
      });
    }
    const result = await this.#readFile(cachePath(this.#configuration, cacheKey));
    const source = decodeStateFile(result, "AI cache");
    if (source == null) {
      return Object.freeze({
        status: "miss",
      });
    }
    let value: unknown;
    try {
      const parseJson: (text: string) => unknown = JSON.parse;
      value = parseJson(source);
    } catch (error: unknown) {
      throw new StateFormatError("AI cache", {
        cause: new SyntaxError("JSON構文が不正です", {
          cause: error,
        }),
      });
    }
    try {
      const entry = createAiCacheEntry(value);
      if (entry.cacheKey !== cacheKey) {
        throw new TypeError("cache keyがファイル名と一致しません");
      }
      return Object.freeze({
        status: "hit",
        entry,
      });
    } catch (error: unknown) {
      throw createAiCacheStateFormatError(error);
    }
  }

  #bufferAiCache(entry: AiCacheEntry): Promise<void> {
    try {
      const validated = createAiCacheEntry(entry);
      this.#pendingAiCacheEntries.set(validated.cacheKey, validated);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(createAiCacheStateFormatError(error));
    }
  }

  async #readPersonalReminderAiCache(
    cacheKey: PersonalReminderAiCacheKey,
  ): Promise<PersonalReminderAiCacheReadResult> {
    const pendingEntry = this.#pendingPersonalReminderAiCacheEntries.get(cacheKey);
    if (pendingEntry != null) {
      return Object.freeze({
        status: "hit",
        entry: pendingEntry,
      });
    }
    const result = await this.#readFile(personalReminderAiCachePath(this.#configuration, cacheKey));
    const source = decodeStateFile(result, "personal reminder AI cache");
    if (source == null) {
      return Object.freeze({
        status: "miss",
      });
    }
    let value: unknown;
    try {
      const parseJson: (text: string) => unknown = JSON.parse;
      value = parseJson(source);
    } catch (error: unknown) {
      throw new StateFormatError("personal reminder AI cache", {
        cause: new SyntaxError("JSON構文が不正です", {
          cause: error,
        }),
      });
    }
    try {
      const entry = createPersonalReminderAiCacheEntry(value);
      if (entry.cacheKey !== cacheKey) {
        throw new TypeError("cache keyがファイル名と一致しません");
      }
      return Object.freeze({
        status: "hit",
        entry,
      });
    } catch (error: unknown) {
      throw createPersonalReminderAiCacheStateFormatError(error);
    }
  }

  #bufferPersonalReminderAiCache(entry: PersonalReminderAiCacheEntry): Promise<void> {
    try {
      const validated = createPersonalReminderAiCacheEntry(entry);
      this.#pendingPersonalReminderAiCacheEntries.set(validated.cacheKey, validated);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(createPersonalReminderAiCacheStateFormatError(error));
    }
  }

  /** session開始時点のcurrent snapshotを読み取る。 */
  public async loadSnapshot(): Promise<StateSnapshotReadResult> {
    if (this.#head.status === "missing") {
      return Object.freeze({
        status: "missing_branch",
      });
    }
    const result = await this.#adapter.readFile(
      this.#head.revision,
      this.#configuration.snapshotPath,
    );
    const source = decodeStateFile(result, "snapshot");
    if (source == null) {
      const [notificationLedger, statePaths] = await Promise.all([
        this.loadNotificationLedger(),
        this.#adapter.listFiles(this.#head.revision, STATE_ROOT_DIRECTORY),
      ]);
      if (
        notificationLedger.entries.length === 0 &&
        notificationLedger.operationsAlerts.length > 0 &&
        statePaths.every(
          (path) =>
            path === this.#configuration.notificationLedgerPath ||
            path === OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
        )
      ) {
        return Object.freeze({
          status: "operations_only",
        });
      }
      throw new StateFormatError("snapshot", {
        cause: new TypeError("既存state branchにsnapshotがありません"),
      });
    }
    return Object.freeze({
      status: "available",
      snapshot: migrateStateSnapshot(
        source,
        this.#aiCacheMigrationPlan.legacyEntriesByCacheKey,
        this.#migrationTimezone,
      ),
    });
  }

  /** session開始時点のnotification ledgerを読み取る。 */
  public async loadNotificationLedger(): Promise<StateNotificationLedger> {
    return loadStateNotificationLedgers(this.#adapter, this.#configuration, this.#head);
  }

  async #loadAllHistoryRecords(): Promise<readonly StateHistoryRecord[]> {
    if (this.#head.status === "missing") {
      return Object.freeze([]);
    }
    const paths = await this.#adapter.listFiles(
      this.#head.revision,
      this.#configuration.historyDirectory,
    );
    const prefix = `${this.#configuration.historyDirectory}/`;
    const records: StateHistoryRecord[] = [];
    for (const path of [...paths].sort(compareStrings)) {
      if (!path.startsWith(prefix)) {
        throw new StateHistoryError("history directory外のパスが返されました");
      }
      const fileName = path.slice(prefix.length);
      const match = HISTORY_FILE_PATTERN.exec(fileName);
      if (match == null) {
        throw new StateHistoryError("日次履歴のファイル名が不正です");
      }
      const date = match[1];
      if (date == null) {
        throw new StateHistoryError("日次履歴のファイル名から日付を取得できません");
      }
      const source = decodeStateFile(
        await this.#adapter.readFile(this.#head.revision, path),
        "state history",
      );
      if (source == null) {
        throw new StateHistoryError("一覧にある日次履歴を読み取れません");
      }
      const fileRecords = parseStateHistoryRecords(source);
      if (fileRecords.some((record) => record.date !== date)) {
        throw new StateHistoryError("日次履歴のファイル名とrecordの日付が一致しません");
      }
      records.push(...fileRecords);
    }
    return Object.freeze(records);
  }

  /** sessionの固定revisionにある全日次履歴を読み取る。 */
  public async loadHistoryRecords(): Promise<readonly StateHistoryRecord[]> {
    return this.#loadAllHistoryRecords();
  }

  /** 固定revisionと確定snapshotから初回公開の保存前提を作る。 */
  public async initialPublicationBaseState(
    snapshot: StateSnapshot,
    inventory: readonly Repository[],
    historyInputEvents: readonly StateHistoryInputEvent[],
  ): Promise<InitialPublicationBaseState> {
    const previous = await this.loadSnapshot();
    return readInitialPublicationBaseState(
      this.#adapter,
      this.#configuration,
      this.#head,
      previous.status === "available" ? previous.snapshot : undefined,
      snapshot,
      inventory,
      historyInputEvents,
      this.pendingAiCacheEntries(),
      this.pendingPersonalReminderAiCacheEntries(),
      this.#pendingAiCacheDeletionPaths,
    );
  }

  /** branch上の日次履歴を再生して任意の二日間の差分を返す。 */
  public async diffHistory(fromDate: string, toDate: string): Promise<StateHistoryDiff> {
    return diffStateHistory(await this.#loadAllHistoryRecords(), fromDate, toDate);
  }

  /** 現在のprocessで検証済みとなった未永続化AI cacheを返す。 */
  public pendingAiCacheEntries(): readonly AiCacheEntry[] {
    return Object.freeze(
      [...this.#pendingAiCacheEntries.values()].sort((left, right) =>
        compareStrings(left.cacheKey, right.cacheKey),
      ),
    );
  }

  /** 現在のprocessで検証済みとなった未永続化の個人催促AI cacheを返す。 */
  public pendingPersonalReminderAiCacheEntries(): readonly PersonalReminderAiCacheEntry[] {
    return Object.freeze(
      [...this.#pendingPersonalReminderAiCacheEntries.values()].sort((left, right) =>
        compareStrings(left.cacheKey, right.cacheKey),
      ),
    );
  }
}

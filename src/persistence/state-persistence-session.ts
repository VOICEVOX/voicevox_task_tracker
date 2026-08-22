import { z } from "zod";

import {
  createAiCacheEntry,
  type AiCacheEntry,
  type AiCacheKey,
  type AiCacheReadResult,
  type AiCacheStore,
} from "../codex/cache.js";
import { parseSha256Hash, serializeCanonicalJsonLine } from "./canonical-json.js";
import {
  joinStatePath,
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StateFileUpdate,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateFormatError, StateHistoryError, StateSnapshotSemanticError } from "./errors.js";
import {
  appendStateHistoryNotificationEvents,
  appendStateHistoryRecord,
  createStateHistoryRecord,
  diffStateHistory,
  parseStateHistoryRecords,
  type StateHistoryDiff,
  type StateHistoryInputEvent,
  type StateHistoryNotificationEvent,
  type StateHistoryRecord,
} from "./history.js";
import { assertStatePublicSafety, assertStateValuesPublicSafety } from "./public-safety.js";
import {
  createStateSnapshot,
  parseStateSnapshot,
  serializeStateSnapshot,
  type StateSnapshot,
} from "./snapshot.js";
import {
  createEmptyStateNotificationLedger,
  createStateNotificationLedger,
  createStateRunReport,
  parseStateNotificationLedger,
  serializeStateNotificationLedger,
  serializeStateRunReport,
  type StateNotificationLedger,
  type StateRunReport,
} from "./state-documents.js";
import { type Repository, type UtcIsoDateTime } from "../domain/index.js";

const CACHE_KEY_PREFIX = "sha256:";
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

/** 一つのatomic state commitへ渡す検証済みrun成果物。 */
export type PersistStateTransactionInput = Readonly<{
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  notificationLedger: StateNotificationLedger;
  repositoryInventory: readonly Repository[];
  knownSecrets: readonly string[];
}>;

/** state永続化sessionがcommitしたrevisionとファイル一覧。 */
export type PersistStateTransactionResult = StateBranchCommitResult &
  Readonly<{
    updatedPaths: readonly string[];
  }>;

/** 通知送信直後にledgerだけを更新する入力。 */
export type PersistNotificationLedgerInput = Readonly<{
  notificationLedger: StateNotificationLedger;
  committedAt: UtcIsoDateTime;
  knownSecrets: readonly string[];
}>;

/** 完全成功したrunの追跡開始時刻、通知ledger、run reportを保存する入力。 */
export type PersistRunCompletionInput = Readonly<{
  snapshot: StateSnapshot;
  notificationEvents: readonly StateHistoryNotificationEvent[];
  notificationLedger: StateNotificationLedger;
  runReport: StateRunReport;
  repositoryInventory: readonly Repository[];
  knownSecrets: readonly string[];
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

function decodeStateFile(result: StateFileReadResult, kind: string): string | undefined {
  if (result.status === "missing") {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(result.bytes);
  } catch (error: unknown) {
    throw new StateFormatError(kind, {
      cause: new TypeError("stateファイルがUTF-8ではありません", {
        cause: error,
      }),
    });
  }
}

function encodeStateFile(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

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

function cachePath(configuration: StatePersistenceConfiguration, cacheKey: AiCacheKey): string {
  parseSha256Hash(cacheKey);
  return joinStatePath(
    configuration.aiCacheDirectory,
    `${cacheKey.slice(CACHE_KEY_PREFIX.length)}.json`,
  );
}

function assertRunConsistency(snapshot: StateSnapshot, report: StateRunReport): void {
  if (
    snapshot.run.id !== report.runId ||
    snapshot.run.status !== report.status ||
    snapshot.generatedAt < report.startedAt ||
    snapshot.generatedAt > report.finishedAt
  ) {
    throw new StateSnapshotSemanticError("snapshotとrun reportのrun情報が一致しません");
  }
  const activeEdgeCount = snapshot.relations.filter((relation) => relation.active).length;
  if (
    report.metrics.repositoryCount !== snapshot.repositories.length ||
    report.metrics.itemCount !== snapshot.items.length ||
    report.metrics.activeEdgeCount !== activeEdgeCount ||
    report.metrics.staleRepositoryCount !==
      snapshot.repositories.filter((repository) => repository.freshness === "stale").length
  ) {
    throw new StateSnapshotSemanticError("snapshotとrun reportの件数が一致しません");
  }
}

/** 同じbranch revisionを読み、全成果物を一つのcommitへまとめるsession。 */
export class StatePersistenceSession {
  readonly #adapter: StateBranchAdapter;
  readonly #configuration: StatePersistenceConfiguration;
  readonly #pendingAiCacheEntries = new Map<AiCacheKey, AiCacheEntry>();
  #head: StateBranchHead;

  public readonly aiCache: AiCacheStore;

  private constructor(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    head: StateBranchHead,
  ) {
    this.#adapter = adapter;
    this.#configuration = Object.freeze({
      ...configuration,
    });
    this.#head = head;
    this.aiCache = Object.freeze({
      read: (cacheKey) => this.#readAiCache(cacheKey),
      write: (entry) => this.#bufferAiCache(entry),
    });
  }

  /** state branchのheadを固定して新しいsessionを開始する。 */
  public static async open(
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
  ): Promise<StatePersistenceSession> {
    validateStatePersistenceConfiguration(configuration);
    const head = await adapter.resolveHead(configuration.branch);
    return new StatePersistenceSession(adapter, configuration, head);
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
        statePaths.length === 1 &&
        statePaths[0] === this.#configuration.notificationLedgerPath
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
      snapshot: parseStateSnapshot(source),
    });
  }

  /** session開始時点のnotification ledgerを読み取る。 */
  public async loadNotificationLedger(): Promise<StateNotificationLedger> {
    if (this.#head.status === "missing") {
      return createEmptyStateNotificationLedger();
    }
    const result = await this.#adapter.readFile(
      this.#head.revision,
      this.#configuration.notificationLedgerPath,
    );
    const source = decodeStateFile(result, "notification ledger");
    if (source == null) {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("既存state branchにnotification ledgerがありません"),
      });
    }
    return parseStateNotificationLedger(source);
  }

  async #readHistorySource(path: string): Promise<string | undefined> {
    return decodeStateFile(await this.#readFile(path), "state history");
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

  async #commitNotificationLedger(
    input: PersistNotificationLedgerInput,
  ): Promise<PersistStateTransactionResult> {
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    assertStateValuesPublicSafety([notificationLedger], input.knownSecrets);
    const update = Object.freeze({
      path: this.#configuration.notificationLedgerPath,
      bytes: encodeStateFile(serializeStateNotificationLedger(notificationLedger)),
    } satisfies StateFileUpdate);
    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates: [update],
      message: `tracker notification ledger ${input.committedAt}`,
      committedAt: input.committedAt,
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze([update.path]),
    });
  }

  /** 通知送信結果を既存state branchのledgerへatomic commitする。 */
  public async persistNotificationLedger(
    input: PersistNotificationLedgerInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("state branch作成前にnotification ledgerだけを保存できません"),
      });
    }
    return this.#commitNotificationLedger(input);
  }

  /** 初回運用障害の通知ledgerでstate branchを作成する。 */
  public async persistInitialOperationsNotificationLedger(
    input: PersistNotificationLedgerInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status !== "missing") {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("既存state branchを初回運用障害通知で作成できません"),
      });
    }
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    if (
      notificationLedger.entries.length !== 0 ||
      notificationLedger.operationsAlerts.length !== 1
    ) {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("初回運用障害通知のledger内容が不正です"),
      });
    }
    return this.#commitNotificationLedger({
      ...input,
      notificationLedger,
    });
  }

  /** 完全成功したrunの追跡開始時刻、通知ledger、run reportをatomic commitする。 */
  public async persistRunCompletion(
    input: PersistRunCompletionInput,
  ): Promise<PersistStateTransactionResult> {
    if (this.#head.status === "missing") {
      throw new StateFormatError("run completion", {
        cause: new TypeError("state branch作成前にrun完了を保存できません"),
      });
    }
    const snapshot = createStateSnapshot(input.snapshot);
    const notificationEvents = input.notificationEvents.map((event) => ({
      ...event,
      reasonCodes: [...event.reasonCodes],
    }));
    const runReport = createStateRunReport(input.runReport);
    assertRunConsistency(snapshot, runReport);
    const currentResult = await this.loadSnapshot();
    if (currentResult.status !== "available") {
      throw new StateFormatError("run completion", {
        cause: new TypeError("state branchのsnapshotを読み取れません"),
      });
    }
    const snapshotUpdates: StateFileUpdate[] = [];
    if (currentResult.snapshot.trackingStartAt.status === "not_fixed") {
      if (snapshot.trackingStartAt.status !== "fixed") {
        throw new StateSnapshotSemanticError("完全成功したrunのtracking.startAtが確定していません");
      }
      const expectedCurrentSnapshot = createStateSnapshot({
        ...snapshot,
        trackingStartAt: currentResult.snapshot.trackingStartAt,
      });
      if (
        serializeStateSnapshot(expectedCurrentSnapshot) !==
        serializeStateSnapshot(currentResult.snapshot)
      ) {
        throw new StateSnapshotSemanticError(
          "run完了時にtracking.startAt以外のsnapshot内容が変化しています",
        );
      }
      snapshotUpdates.push({
        path: this.#configuration.snapshotPath,
        bytes: encodeStateFile(serializeStateSnapshot(snapshot)),
      });
    } else if (
      serializeStateSnapshot(snapshot) !== serializeStateSnapshot(currentResult.snapshot)
    ) {
      throw new StateSnapshotSemanticError(
        "run完了時にtracking.startAt以外のsnapshot内容が変化しています",
      );
    }
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    const historyPath = joinStatePath(
      this.#configuration.historyDirectory,
      `${runReport.date}.jsonl`,
    );
    const existingHistorySource = await this.#readHistorySource(historyPath);
    if (existingHistorySource == null) {
      throw new StateHistoryError("run完了の対象history fileを読み取れません");
    }
    const existingHistoryRecords = parseStateHistoryRecords(existingHistorySource);
    if (existingHistoryRecords.some((record) => record.date !== runReport.date)) {
      throw new StateHistoryError("日次履歴のファイル名とrecordの日付が一致しません");
    }
    const targetHistoryRecords = existingHistoryRecords.filter(
      (record) => record.runId === runReport.runId,
    );
    if (targetHistoryRecords.length !== 1) {
      throw new StateHistoryError("run完了の対象history recordが一意に定まりません");
    }
    const historySource = appendStateHistoryNotificationEvents(
      existingHistorySource,
      runReport.runId,
      notificationEvents,
    );
    const historyRecords = parseStateHistoryRecords(historySource);
    const updatedTargetHistoryRecords = historyRecords.filter(
      (record) => record.runId === runReport.runId,
    );
    if (updatedTargetHistoryRecords.length !== 1) {
      throw new StateHistoryError("run完了の対象history recordが一意に定まりません");
    }
    const targetHistoryRecord = updatedTargetHistoryRecords[0];
    if (targetHistoryRecord == null) {
      throw new StateHistoryError("run完了の対象history recordを取得できません");
    }
    if (targetHistoryRecord.date !== runReport.date) {
      throw new StateHistoryError("run reportとhistory recordの日付が一致しません");
    }
    for (const event of notificationEvents) {
      if (event.sentAt < targetHistoryRecord.recordedAt || event.sentAt > runReport.finishedAt) {
        throw new StateHistoryError("通知送信時刻がrunの記録時刻範囲外です");
      }
      const item = snapshot.items.find((candidate) => candidate.nodeId === event.itemNodeId);
      if (item == null) {
        throw new StateHistoryError("通知送信eventの対象itemがsnapshotにありません");
      }
      if (
        item.repositoryId !== event.repositoryId ||
        item.type !== event.type ||
        item.displayReference !== event.displayReference ||
        item.number !== event.number ||
        item.title !== event.title ||
        item.url !== event.url
      ) {
        throw new StateHistoryError("通知送信eventとsnapshotのitem表示情報が一致しません");
      }
    }
    assertStatePublicSafety({
      snapshot,
      repositoryInventory: input.repositoryInventory,
      additionalValues: [...historyRecords, notificationLedger, runReport],
      knownSecrets: input.knownSecrets,
    });
    const updates: StateFileUpdate[] = [
      ...snapshotUpdates,
      {
        path: this.#configuration.notificationLedgerPath,
        bytes: encodeStateFile(serializeStateNotificationLedger(notificationLedger)),
      },
      {
        path: joinStatePath(this.#configuration.runReportsDirectory, `${runReport.date}.json`),
        bytes: encodeStateFile(serializeStateRunReport(runReport)),
      },
      {
        path: historyPath,
        bytes: encodeStateFile(historySource),
      },
    ];
    updates.sort((left, right) => compareStrings(left.path, right.path));
    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      message: `tracker run completion ${snapshot.run.id}`,
      committedAt: runReport.finishedAt,
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((update) => update.path)),
    });
  }

  /** 全検証後にsnapshot・履歴・cache・ledgerをatomic commitする。 */
  public async persist(
    input: PersistStateTransactionInput,
  ): Promise<PersistStateTransactionResult> {
    const snapshot = createStateSnapshot(input.snapshot);
    const notificationLedger = createStateNotificationLedger(input.notificationLedger);
    const runDate = snapshot.generatedAt.slice(0, 10);

    const previousResult = await this.loadSnapshot();
    const previousSnapshot =
      previousResult.status === "available" ? previousResult.snapshot : undefined;
    const historyRecord = createStateHistoryRecord(
      previousSnapshot,
      snapshot,
      runDate,
      input.repositoryInventory,
      input.historyInputEvents,
    );
    const historyPath = joinStatePath(this.#configuration.historyDirectory, `${runDate}.jsonl`);
    const existingHistorySource = await this.#readHistorySource(historyPath);
    const existingHistoryRecords =
      existingHistorySource == null ? [] : parseStateHistoryRecords(existingHistorySource);
    const pendingAiCacheEntries = [...this.#pendingAiCacheEntries.values()];

    assertStatePublicSafety({
      snapshot,
      repositoryInventory: input.repositoryInventory,
      additionalValues: [
        ...existingHistoryRecords,
        historyRecord,
        ...pendingAiCacheEntries,
        notificationLedger,
      ],
      knownSecrets: input.knownSecrets,
    });

    const historySource = appendStateHistoryRecord(existingHistorySource, historyRecord);
    const updates: StateFileUpdate[] = [
      {
        path: this.#configuration.snapshotPath,
        bytes: encodeStateFile(serializeStateSnapshot(snapshot)),
      },
      {
        path: historyPath,
        bytes: encodeStateFile(historySource),
      },
      {
        path: this.#configuration.notificationLedgerPath,
        bytes: encodeStateFile(serializeStateNotificationLedger(notificationLedger)),
      },
      ...pendingAiCacheEntries.map((entry) => ({
        path: cachePath(this.#configuration, entry.cacheKey),
        bytes: encodeStateFile(serializeCanonicalJsonLine(entry)),
      })),
    ];
    updates.sort((left, right) => compareStrings(left.path, right.path));

    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      message: `tracker state ${runDate} ${snapshot.run.id}`,
      committedAt: snapshot.generatedAt,
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    this.#pendingAiCacheEntries.clear();
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((update) => update.path)),
    });
  }
}

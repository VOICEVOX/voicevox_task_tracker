import { type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  validateStatePersistenceConfiguration,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";

import { serializeCanonicalJsonLine } from "../../canonical-json/index.js";
import { createAiCacheEntry, type AiCacheKey } from "../../codex/cache.js";
import { assertPersonalReminderEvidenceClosure as assertLegacyPersonalReminderEvidenceClosure } from "../../persistence/snapshot-evidence-closure.js";
import { version19SnapshotFields, type StateSnapshot } from "../../persistence/snapshot-v23.js";
import {
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  StateFormatError,
  createAiCacheMigrationPlan,
  createStateOperationsAlertLedger,
  isCanonicalStateOperationsAlertLedgerSource,
  migrateStateSnapshot,
  parseStateHistoryRecords,
  parseStateNotificationLedger,
  parseStateOperationsAlertLedger,
  serializeStateHistoryRecords,
  serializeStateNotificationLedger,
  serializeStateOperationsAlertLedger,
  serializeStateSnapshot,
  type AiCacheMigrationFile,
  type AiCacheMigrationPlan,
  type LegacyAiCacheEntry,
} from "../../persistence/index.js";
import { CliStateVerificationError } from "./errors.js";
import { withVerifiedStateRevision } from "./state-verification-ingress.js";

const HISTORY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const AI_CACHE_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;
const schemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});

/** 一種類の永続state文書を検証した件数とschema version。 */
export type StateDocumentVerification = Readonly<{
  verifiedCount: number;
  sourceSchemaVersions: readonly string[];
  migratedSchemaVersions: readonly string[];
}>;

/** snapshotの入口検証結果と保存用形式の検証結果。 */
export type SnapshotVerification = StateDocumentVerification &
  Readonly<{
    storageValidation:
      | Readonly<{ status: "verified" }>
      | Readonly<{
          status: "clock_reconfirmation_required";
          pendingClockBasisCount: number;
        }>;
  }>;

/** AI cacheの検証結果と仮想削除件数。 */
export type AiCacheVerification = StateDocumentVerification &
  Readonly<{
    deletedCount: number;
  }>;

/** snapshot、通知ledger、履歴、AI cacheを検証した結果。 */
export type StateVerificationResult = Readonly<{
  snapshot: SnapshotVerification;
  notificationLedger: StateDocumentVerification;
  operationsAlertLedger: StateDocumentVerification;
  runTransaction: StateDocumentVerification;
  history: StateDocumentVerification;
  aiCache: AiCacheVerification;
}>;

type VerifiedAiCache = Readonly<{
  verification: AiCacheVerification;
  migrationPlan: AiCacheMigrationPlan;
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

function uniqueVersions(versions: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(versions)].sort(compareStrings));
}

function createVerification(
  verifiedCount: number,
  sourceSchemaVersions: readonly string[],
  migratedSchemaVersions: readonly string[],
): StateDocumentVerification {
  return Object.freeze({
    verifiedCount,
    sourceSchemaVersions: uniqueVersions(sourceSchemaVersions),
    migratedSchemaVersions: uniqueVersions(migratedSchemaVersions),
  });
}

function parseJson(source: string, kind: string): unknown {
  try {
    const parse: (value: string) => unknown = JSON.parse;
    return parse(source);
  } catch (error: unknown) {
    throw new StateFormatError(kind, {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
}

function schemaVersion(value: unknown, kind: string): string {
  const result = schemaVersionSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError(kind, result.error);
  }
  return result.data.schemaVersion;
}

function jsonDocumentSchemaVersion(source: string, kind: string): string {
  return schemaVersion(parseJson(source, kind), kind);
}

function jsonLinesSchemaVersions(source: string): readonly string[] {
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return Object.freeze(
    lines.map((line) => schemaVersion(parseJson(line, "state history"), "state history")),
  );
}

function verificationError(path: string, error: unknown): CliStateVerificationError {
  if (error instanceof CliStateVerificationError) {
    return error;
  }
  return new CliStateVerificationError(path, {
    cause: error,
  });
}

async function readUtf8(path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    throw verificationError(path, error);
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(bytes);
  } catch (error: unknown) {
    throw verificationError(
      path,
      new TypeError("永続stateファイルがUTF-8ではありません", {
        cause: error,
      }),
    );
  }
}

async function readOptionalBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw verificationError(path, error);
  }
}

function localStatePath(stateDirectory: string, statePath: string): string {
  return join(stateDirectory, statePath.slice("state/".length));
}

function countPendingClockBases(snapshot: StateSnapshot): number {
  let count = 0;
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      count += bases.filter((basis) => basis.source === "reconfirmation_pending").length;
    }
  }
  return count;
}

async function verifySnapshot(
  stateDirectory: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  timezone: string,
  snapshotPath: string,
): Promise<SnapshotVerification> {
  const path = localStatePath(stateDirectory, snapshotPath);
  const source = await readUtf8(path);
  try {
    const snapshot = migrateStateSnapshot(source, legacyEntriesByCacheKey, timezone);
    const verification = createVerification(
      1,
      [jsonDocumentSchemaVersion(source, "snapshot")],
      [snapshot.schemaVersion],
    );
    const pendingClockBasisCount = countPendingClockBases(snapshot);
    if (pendingClockBasisCount > 0) {
      assertLegacyPersonalReminderEvidenceClosure(version19SnapshotFields(snapshot));
      return Object.freeze({
        ...verification,
        storageValidation: Object.freeze({
          status: "clock_reconfirmation_required",
          pendingClockBasisCount,
        }),
      });
    }
    const canonicalSource = serializeStateSnapshot(snapshot);
    const reloadedSnapshot = migrateStateSnapshot(
      canonicalSource,
      legacyEntriesByCacheKey,
      timezone,
    );
    if (serializeStateSnapshot(reloadedSnapshot) !== canonicalSource) {
      throw new TypeError("snapshotをcanonical JSONへ再読み込みできません");
    }
    return Object.freeze({
      ...verification,
      storageValidation: Object.freeze({ status: "verified" }),
    });
  } catch (error: unknown) {
    throw verificationError(path, error);
  }
}

async function verifyNotificationLedger(
  stateDirectory: string,
  notificationLedgerPath: string,
): Promise<StateDocumentVerification> {
  const path = localStatePath(stateDirectory, notificationLedgerPath);
  const source = await readUtf8(path);
  try {
    const ledger = parseStateNotificationLedger(source);
    const canonicalSource = serializeStateNotificationLedger(ledger);
    const reloadedLedger = parseStateNotificationLedger(canonicalSource);
    if (serializeStateNotificationLedger(reloadedLedger) !== canonicalSource) {
      throw new TypeError("notification ledgerをcanonical JSONへ再読み込みできません");
    }
    return createVerification(
      1,
      [jsonDocumentSchemaVersion(source, "notification ledger")],
      [ledger.schemaVersion],
    );
  } catch (error: unknown) {
    throw verificationError(path, error);
  }
}

async function verifyOperationsAlertLedger(
  stateDirectory: string,
  notificationLedgerPath: string,
): Promise<StateDocumentVerification> {
  const normalPath = localStatePath(stateDirectory, notificationLedgerPath);
  const operationsPath = localStatePath(stateDirectory, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  const normalSource = await readUtf8(normalPath);
  const legacy = parseStateNotificationLedger(normalSource);
  const operationsBytes = await readOptionalBytes(operationsPath);
  if (operationsBytes == null) {
    const migrated = createStateOperationsAlertLedger({
      schemaVersion: "1",
      operationsAlerts: legacy.operationsAlerts,
    });
    const encoded = serializeStateOperationsAlertLedger(migrated);
    if (serializeStateOperationsAlertLedger(parseStateOperationsAlertLedger(encoded)) !== encoded) {
      throw verificationError(
        operationsPath,
        new TypeError("運用障害通知ledgerの移行で値を失いました"),
      );
    }
    return createVerification(
      migrated.operationsAlerts.length,
      [jsonDocumentSchemaVersion(normalSource, "notification ledger")],
      ["2"],
    );
  }
  if (legacy.operationsAlerts.length !== 0) {
    throw verificationError(
      operationsPath,
      new TypeError("通常ledgerと専用fileに運用障害通知が重複しています"),
    );
  }
  const operationsSource = new TextDecoder("utf-8", { fatal: true }).decode(operationsBytes);
  const ledger = parseStateOperationsAlertLedger(operationsSource);
  if (!isCanonicalStateOperationsAlertLedgerSource(operationsSource)) {
    throw verificationError(
      operationsPath,
      new TypeError("運用障害通知ledgerがcanonical JSONではありません"),
    );
  }
  return createVerification(
    ledger.operationsAlerts.length + ledger.deliveryReservations.length,
    [jsonDocumentSchemaVersion(operationsSource, "operations alert ledger")],
    [ledger.schemaVersion],
  );
}

async function verifyRunTransaction(
  stateDirectory: string,
  configuration: StatePersistenceConfiguration,
): Promise<StateDocumentVerification> {
  const paths = [
    configuration.snapshotPath,
    configuration.notificationLedgerPath,
    OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  ];
  const files = new Map<string, StateFileReadResult>();
  for (const path of paths) {
    const bytes = await readOptionalBytes(localStatePath(stateDirectory, path));
    files.set(path, bytes == null ? { status: "missing" } : { status: "present", bytes });
  }
  for (const directory of [configuration.historyDirectory, configuration.runReportsDirectory]) {
    const localDirectory = localStatePath(stateDirectory, directory);
    let entries: Dirent[];
    try {
      entries = await readdir(localDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw verificationError(localDirectory, error);
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw verificationError(
          localDirectory,
          new TypeError("run transaction参照先の種別が不正です"),
        );
      }
      const path = `${directory}/${entry.name}`;
      const bytes = await readOptionalBytes(localStatePath(stateDirectory, path));
      if (bytes == null) {
        throw verificationError(path, new TypeError("一覧にあるrun transaction参照先がありません"));
      }
      files.set(path, { status: "present", bytes });
    }
  }
  try {
    const verified = verifyRunTransactionFiles(files, configuration);
    return verified == null ? createVerification(0, [], []) : createVerification(1, ["1"], ["1"]);
  } catch (error: unknown) {
    throw verificationError(stateDirectory, error);
  }
}

async function readHistoryEntries(historyDirectory: string): Promise<Dirent[]> {
  try {
    return await readdir(historyDirectory, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    throw verificationError(historyDirectory, error);
  }
}

async function verifyHistory(
  stateDirectory: string,
  historyStateDirectory: string,
): Promise<StateDocumentVerification> {
  const historyDirectory = localStatePath(stateDirectory, historyStateDirectory);
  const entries = await readHistoryEntries(historyDirectory);
  const sourceSchemaVersions: string[] = [];
  const migratedSchemaVersions: string[] = [];
  let verifiedCount = 0;
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const path = join(historyDirectory, entry.name);
    const match = HISTORY_FILE_PATTERN.exec(entry.name);
    if (!entry.isFile() || match == null) {
      throw verificationError(path, new TypeError("日次履歴のファイル名または種別が不正です"));
    }
    const date = match[1];
    if (date == null) {
      throw verificationError(path, new TypeError("日次履歴のファイル名から日付を取得できません"));
    }
    const source = await readUtf8(path);
    try {
      const records = parseStateHistoryRecords(source);
      if (records.some((record) => record.date !== date)) {
        throw new TypeError("日次履歴のファイル名とrecordの日付が一致しません");
      }
      const canonicalSource = serializeStateHistoryRecords(records);
      const reloadedRecords = parseStateHistoryRecords(canonicalSource);
      if (serializeStateHistoryRecords(reloadedRecords) !== canonicalSource) {
        throw new TypeError("日次履歴をcanonical JSONへ再読み込みできません");
      }
      verifiedCount += records.length;
      sourceSchemaVersions.push(...jsonLinesSchemaVersions(source));
      migratedSchemaVersions.push(...records.map((record) => record.schemaVersion));
    } catch (error: unknown) {
      throw verificationError(path, error);
    }
  }
  return createVerification(verifiedCount, sourceSchemaVersions, migratedSchemaVersions);
}

async function readAiCacheEntries(cacheDirectory: string): Promise<Dirent[]> {
  try {
    return await readdir(cacheDirectory, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw verificationError(cacheDirectory, error);
  }
}

async function verifyAiCache(
  stateDirectory: string,
  aiCacheStateDirectory: string,
): Promise<VerifiedAiCache> {
  const cacheDirectory = localStatePath(stateDirectory, aiCacheStateDirectory);
  const entries = await readAiCacheEntries(cacheDirectory);
  const files: AiCacheMigrationFile[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const path = join(cacheDirectory, entry.name);
    const match = AI_CACHE_FILE_PATTERN.exec(entry.name);
    if (!entry.isFile() || match == null) {
      throw verificationError(path, new TypeError("AI cacheのファイル名または種別が不正です"));
    }
    const source = await readUtf8(path);
    files.push({
      path: `${aiCacheStateDirectory}/${entry.name}`,
      source,
    });
  }
  let migrationPlan: AiCacheMigrationPlan;
  try {
    migrationPlan = createAiCacheMigrationPlan(aiCacheStateDirectory, files);
  } catch (error: unknown) {
    throw verificationError(cacheDirectory, error);
  }
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  for (const entry of migrationPlan.currentEntriesByCacheKey.values()) {
    const statePath = `${aiCacheStateDirectory}/${entry.cacheKey.slice("sha256:".length)}.json`;
    const source = sourceByPath.get(statePath);
    if (source == null) {
      throw verificationError(cacheDirectory, new TypeError("AI cacheのpathを再取得できません"));
    }
    const canonicalSource = serializeCanonicalJsonLine(entry);
    if (source !== canonicalSource) {
      throw verificationError(
        join(cacheDirectory, statePath.slice(`${aiCacheStateDirectory}/`.length)),
        new TypeError("AI cacheがcanonical JSONではありません"),
      );
    }
    try {
      const reloadedEntry = createAiCacheEntry(parseJson(canonicalSource, "AI cache"));
      if (serializeCanonicalJsonLine(reloadedEntry) !== canonicalSource) {
        throw new TypeError("AI cacheをcanonical JSONへ再読み込みできません");
      }
    } catch (error: unknown) {
      throw verificationError(
        join(cacheDirectory, statePath.slice(`${aiCacheStateDirectory}/`.length)),
        error,
      );
    }
  }
  const legacyPathSet = new Set(migrationPlan.legacyCachePaths);
  const remainingFiles = files.filter((file) => !legacyPathSet.has(file.path));
  let remainingPlan: AiCacheMigrationPlan;
  try {
    remainingPlan = createAiCacheMigrationPlan(aiCacheStateDirectory, remainingFiles);
  } catch (error: unknown) {
    throw verificationError(cacheDirectory, error);
  }
  if (remainingPlan.legacyCachePaths.length !== 0) {
    throw verificationError(
      cacheDirectory,
      new TypeError("AI cacheの移行後にも旧cacheが残っています"),
    );
  }
  return Object.freeze({
    migrationPlan,
    verification: Object.freeze({
      ...createVerification(
        files.length,
        migrationPlan.sourceSchemaVersions,
        migrationPlan.migratedSchemaVersions,
      ),
      deletedCount: migrationPlan.legacyCachePaths.length,
    }),
  });
}

/** 指定したGit revisionのsnapshot、通知ledger、履歴を現行ingressで検証する。 */
export async function verifyPersistentStateDirectory(
  stateDirectory: string,
  timezone: string,
  configuration: StatePersistenceConfiguration,
  stateRevision: string,
): Promise<StateVerificationResult> {
  validateStatePersistenceConfiguration(configuration);
  return await withVerifiedStateRevision(
    stateDirectory,
    stateRevision,
    timezone,
    configuration,
    (directory) => verifyStateFiles(directory, timezone, configuration),
  );
}

async function verifyStateFiles(
  stateDirectory: string,
  timezone: string,
  configuration: StatePersistenceConfiguration,
): Promise<StateVerificationResult> {
  const verifiedAiCache = await verifyAiCache(stateDirectory, configuration.aiCacheDirectory);
  const [snapshot, notificationLedger, operationsAlertLedger, runTransaction, history] =
    await Promise.all([
      verifySnapshot(
        stateDirectory,
        verifiedAiCache.migrationPlan.legacyEntriesByCacheKey,
        timezone,
        configuration.snapshotPath,
      ),
      verifyNotificationLedger(stateDirectory, configuration.notificationLedgerPath),
      verifyOperationsAlertLedger(stateDirectory, configuration.notificationLedgerPath),
      verifyRunTransaction(stateDirectory, configuration),
      verifyHistory(stateDirectory, configuration.historyDirectory),
    ]);
  return Object.freeze({
    snapshot,
    notificationLedger,
    operationsAlertLedger,
    runTransaction,
    history,
    aiCache: verifiedAiCache.verification,
  });
}

function formatVersions(versions: readonly string[]): string {
  return versions.length === 0 ? "なし" : versions.join(", ");
}

function formatDocumentResult(name: string, result: StateDocumentVerification): string {
  return `${name}: ${result.verifiedCount.toString()}件、schema version ${formatVersions(result.sourceSchemaVersions)} -> ${formatVersions(result.migratedSchemaVersions)}`;
}

/** 永続stateの検証結果を標準出力向けに整形する。 */
export function formatStateVerificationResult(result: StateVerificationResult): string {
  return [
    formatDocumentResult("snapshot", result.snapshot),
    result.snapshot.storageValidation.status === "verified"
      ? "snapshot保存形式: serializeと再読込を検証済み"
      : `snapshot保存形式: 未検証、個人催促時計の再確認待ち${result.snapshot.storageValidation.pendingClockBasisCount.toString()}箇所`,
    formatDocumentResult("notification ledger", result.notificationLedger),
    formatDocumentResult("operations alert ledger", result.operationsAlertLedger),
    formatDocumentResult("run transaction", result.runTransaction),
    formatDocumentResult("history", result.history),
    formatDocumentResult("AI cache", result.aiCache),
    `AI cache旧形式削除予定: ${result.aiCache.deletedCount.toString()}件`,
  ].join("\n");
}

import { type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  StateFormatError,
  parseStateHistoryRecords,
  parseStateNotificationLedger,
  parseStateSnapshot,
} from "../persistence/index.js";
import { type VerifyStateCliCommand } from "./command.js";
import { CliStateVerificationError } from "./errors.js";

const HISTORY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const schemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});

/** 一種類の永続state文書を検証した件数とschema version。 */
export type StateDocumentVerification = Readonly<{
  verifiedCount: number;
  sourceSchemaVersions: readonly string[];
  migratedSchemaVersions: readonly string[];
}>;

/** snapshot、通知ledger、履歴を検証した結果。 */
export type StateVerificationResult = Readonly<{
  snapshot: StateDocumentVerification;
  notificationLedger: StateDocumentVerification;
  history: StateDocumentVerification;
}>;

/** 永続state検証が利用する読み込みと標準出力境界。 */
export type StateVerificationDependencies = Readonly<{
  verifyStateDirectory: (stateDirectory: string) => Promise<StateVerificationResult>;
  writeStandardOutput: (source: string) => Promise<void>;
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

async function verifySnapshot(stateDirectory: string): Promise<StateDocumentVerification> {
  const path = join(stateDirectory, "snapshot.json");
  const source = await readUtf8(path);
  try {
    const snapshot = parseStateSnapshot(source);
    return createVerification(
      1,
      [jsonDocumentSchemaVersion(source, "snapshot")],
      [snapshot.schemaVersion],
    );
  } catch (error: unknown) {
    throw verificationError(path, error);
  }
}

async function verifyNotificationLedger(
  stateDirectory: string,
): Promise<StateDocumentVerification> {
  const path = join(stateDirectory, "notification-ledger.json");
  const source = await readUtf8(path);
  try {
    const ledger = parseStateNotificationLedger(source);
    return createVerification(
      1,
      [jsonDocumentSchemaVersion(source, "notification ledger")],
      [ledger.schemaVersion],
    );
  } catch (error: unknown) {
    throw verificationError(path, error);
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

async function verifyHistory(stateDirectory: string): Promise<StateDocumentVerification> {
  const historyDirectory = join(stateDirectory, "history");
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
      verifiedCount += records.length;
      sourceSchemaVersions.push(...jsonLinesSchemaVersions(source));
      migratedSchemaVersions.push(...records.map((record) => record.schemaVersion));
    } catch (error: unknown) {
      throw verificationError(path, error);
    }
  }
  return createVerification(verifiedCount, sourceSchemaVersions, migratedSchemaVersions);
}

/** 指定したディレクトリのsnapshot、通知ledger、履歴を検証する。 */
export async function verifyPersistentStateDirectory(
  stateDirectory: string,
): Promise<StateVerificationResult> {
  const [snapshot, notificationLedger, history] = await Promise.all([
    verifySnapshot(stateDirectory),
    verifyNotificationLedger(stateDirectory),
    verifyHistory(stateDirectory),
  ]);
  return Object.freeze({
    snapshot,
    notificationLedger,
    history,
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
    formatDocumentResult("notification ledger", result.notificationLedger),
    formatDocumentResult("history", result.history),
  ].join("\n");
}

/** verify-stateサブコマンドを実行する。 */
export class StateVerificationRunner {
  readonly #dependencies: StateVerificationDependencies;

  public constructor(dependencies: StateVerificationDependencies) {
    this.#dependencies = dependencies;
  }

  /** 指定した永続stateを検証し、件数とschema versionを出力する。 */
  public async run(command: VerifyStateCliCommand): Promise<void> {
    const result = await this.#dependencies.verifyStateDirectory(command.stateDirectory);
    await this.#dependencies.writeStandardOutput(`${formatStateVerificationResult(result)}\n`);
  }
}

import { type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { createUtcIsoDateTime } from "../domain/index.js";
import {
  validateCacheOnlyStateFiles,
  type CacheOnlyStateFile,
  type CacheOnlyStateFiles,
  type CacheOnlyValidatedDocuments,
} from "../persistence/cache-only-session.js";
import { type VerifyStateCliCommand } from "./command.js";
import { CliStateVerificationError } from "./errors.js";

const CACHE_DIRECTORY_NAMES = Object.freeze([
  "github-repositories",
  "github-items",
  "ai-latest-importance",
  "ai-results",
] as const);
const JSON_FILE_PATTERN = /^[A-Za-z0-9._-]+\.json$/u;

type CacheDirectoryName = (typeof CACHE_DIRECTORY_NAMES)[number];

/** 一種類のcache文書を検証した件数とschema version。 */
export type StateDocumentVerification = Readonly<{
  verifiedCount: number;
  schemaVersions: readonly string[];
}>;

/** cache-only stateの4種類を検証した結果。 */
export type StateVerificationResult = Readonly<{
  repositoryCaches: StateDocumentVerification;
  itemCaches: StateDocumentVerification;
  latestImportanceCaches: StateDocumentVerification;
  aiCacheEntries: StateDocumentVerification;
}>;

/** cache-only state検証が利用する読み込みと標準出力境界。 */
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
  schemaVersions: readonly string[],
): StateDocumentVerification {
  return Object.freeze({
    verifiedCount,
    schemaVersions: uniqueVersions(schemaVersions),
  });
}

function verificationError(path: string, error: unknown): CliStateVerificationError {
  if (error instanceof CliStateVerificationError) {
    return error;
  }
  return new CliStateVerificationError(path, {
    cause: error,
  });
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error != null && "code" in error && error.code === "ENOENT";
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
      new TypeError("cache-only stateファイルがUTF-8ではありません", {
        cause: error,
      }),
    );
  }
}

function parseJson(source: string, path: string): unknown {
  try {
    const parse: (value: string) => unknown = JSON.parse;
    return parse(source);
  } catch (error: unknown) {
    throw verificationError(
      path,
      new SyntaxError("cache-only stateのJSON構文が不正です", {
        cause: error,
      }),
    );
  }
}

function cacheRelativePath(directory: CacheDirectoryName, fileName: string): string {
  return `state/${directory}/${fileName}`;
}

async function readCacheFiles(
  stateDirectory: string,
  directory: CacheDirectoryName,
): Promise<readonly CacheOnlyStateFile[]> {
  const directoryPath = join(stateDirectory, directory);
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return Object.freeze([]);
    }
    throw verificationError(directoryPath, error);
  }
  const files: CacheOnlyStateFile[] = [];
  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    const path = join(directoryPath, entry.name);
    if (!entry.isFile() || !JSON_FILE_PATTERN.test(entry.name)) {
      throw verificationError(
        path,
        new TypeError("cache-only stateのdirectory内に不正なpathがあります"),
      );
    }
    files.push({
      path: cacheRelativePath(directory, entry.name),
      value: parseJson(await readUtf8(path), path),
    });
  }
  return Object.freeze(files);
}

async function readCacheStateFiles(stateDirectory: string): Promise<CacheOnlyStateFiles> {
  let entries: Dirent[];
  try {
    entries = await readdir(stateDirectory, {
      withFileTypes: true,
    });
  } catch (error: unknown) {
    throw verificationError(stateDirectory, error);
  }
  const knownDirectories = new Set<string>(CACHE_DIRECTORY_NAMES);
  for (const entry of entries) {
    if (!entry.isDirectory() || !knownDirectories.has(entry.name)) {
      throw verificationError(
        join(stateDirectory, entry.name),
        new TypeError("cache-only stateには指定された4種類のdirectoryだけを置けます"),
      );
    }
  }
  const [repositoryCaches, itemCaches, latestImportanceCaches, aiCacheEntries] = await Promise.all([
    readCacheFiles(stateDirectory, "github-repositories"),
    readCacheFiles(stateDirectory, "github-items"),
    readCacheFiles(stateDirectory, "ai-latest-importance"),
    readCacheFiles(stateDirectory, "ai-results"),
  ]);
  return Object.freeze({
    repositoryCaches,
    itemCaches,
    latestImportanceCaches,
    aiCacheEntries,
  });
}

function documentVerification(documents: CacheOnlyValidatedDocuments): StateVerificationResult {
  return Object.freeze({
    repositoryCaches: createVerification(
      documents.repositoryCaches.length,
      documents.repositoryCaches.map((document) => document.schemaVersion),
    ),
    itemCaches: createVerification(
      documents.itemCaches.length,
      documents.itemCaches.map((document) => document.schemaVersion),
    ),
    latestImportanceCaches: createVerification(
      documents.latestImportanceCaches.length,
      documents.latestImportanceCaches.map((document) => document.schemaVersion),
    ),
    aiCacheEntries: createVerification(
      documents.aiCacheEntries.length,
      documents.aiCacheEntries.map((entry) => entry.metadata.schemaVersion),
    ),
  });
}

/** 指定したdirectoryのcache-only stateを検証する。 */
export async function verifyPersistentStateDirectory(
  stateDirectory: string,
): Promise<StateVerificationResult> {
  const files = await readCacheStateFiles(stateDirectory);
  try {
    const documents = validateCacheOnlyStateFiles({
      evaluatedAt: createUtcIsoDateTime(new Date().toISOString()),
      files,
      knownSecrets: [],
    });
    return documentVerification(documents);
  } catch (error: unknown) {
    throw verificationError(stateDirectory, error);
  }
}

function formatVersions(versions: readonly string[]): string {
  return versions.length === 0 ? "なし" : versions.join(", ");
}

function formatDocumentResult(name: string, result: StateDocumentVerification): string {
  return `${name}: ${result.verifiedCount.toString()}件、schema version ${formatVersions(result.schemaVersions)}`;
}

/** cache-only stateの検証結果を標準出力向けに整形する。 */
export function formatStateVerificationResult(result: StateVerificationResult): string {
  return [
    formatDocumentResult("github-repositories", result.repositoryCaches),
    formatDocumentResult("github-items", result.itemCaches),
    formatDocumentResult("ai-latest-importance", result.latestImportanceCaches),
    formatDocumentResult("ai-results", result.aiCacheEntries),
  ].join("\n");
}

/** verify-stateサブコマンドを実行する。 */
export class StateVerificationRunner {
  readonly #dependencies: StateVerificationDependencies;

  public constructor(dependencies: StateVerificationDependencies) {
    this.#dependencies = dependencies;
  }

  /** 指定したcache-only stateを検証し、件数とschema versionを出力する。 */
  public async run(command: VerifyStateCliCommand): Promise<void> {
    const result = await this.#dependencies.verifyStateDirectory(command.stateDirectory);
    await this.#dependencies.writeStandardOutput(`${formatStateVerificationResult(result)}\n`);
  }
}

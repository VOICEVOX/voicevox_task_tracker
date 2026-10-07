import { serializeCanonicalJson } from "../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StateBranchCommitInspection,
  StateFileReadResult,
} from "./branch-adapter.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";

type FileFingerprint =
  Readonly<{ status: "missing" }> | Readonly<{ status: "present"; length: number; digest: string }>;

/** 完全検証に使用したpath、byte digest、commit metadata。 */
export type PostSaveExactReadFootprint = Readonly<{
  listings: ReadonlyMap<string, readonly string[]>;
  files: ReadonlyMap<string, ReadonlyMap<string, FileFingerprint>>;
  commits: ReadonlyMap<string, string>;
}>;

function fingerprint(file: StateFileReadResult): FileFingerprint {
  return file.status === "missing"
    ? Object.freeze({ status: "missing" })
    : Object.freeze({
        status: "present",
        length: file.bytes.length,
        digest: nodeContentDigestPort.sha256Bytes(file.bytes),
      });
}

function sameFingerprint(expected: FileFingerprint, actual: StateFileReadResult): boolean {
  if (expected.status !== actual.status) {
    return false;
  }
  return (
    expected.status === "missing" ||
    (actual.status === "present" &&
      expected.length === actual.bytes.length &&
      expected.digest === nodeContentDigestPort.sha256Bytes(actual.bytes))
  );
}

function listingKey(revision: string, directory: string): string {
  return JSON.stringify([revision, directory]);
}

function assertSamePaths(expected: readonly string[], actual: readonly string[]): void {
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
    throw new TypeError("公開済みexact revisionのstate path一覧が証明と一致しません");
  }
}

function rememberFile(
  files: Map<string, Map<string, FileFingerprint>>,
  revision: string,
  path: string,
  file: StateFileReadResult,
): void {
  let byPath = files.get(revision);
  if (byPath == null) {
    byPath = new Map();
    files.set(revision, byPath);
  }
  const next = fingerprint(file);
  const previous = byPath.get(path);
  if (
    previous != null &&
    (previous.status !== next.status ||
      (previous.status === "present" &&
        next.status === "present" &&
        (previous.length !== next.length || previous.digest !== next.digest)))
  ) {
    throw new TypeError("公開済みexact revisionの同じpathが異なるbyteを返しました");
  }
  byPath.set(path, next);
}

/** 完全検証で使用したexact読込のpathとbyte digestを記録する。 */
export function recordPostSaveExactReads(adapter: StateBranchAdapter): Readonly<{
  adapter: StateBranchAdapter;
  footprint: PostSaveExactReadFootprint;
}> {
  const listings = new Map<string, readonly string[]>();
  const files = new Map<string, Map<string, FileFingerprint>>();
  const commits = new Map<string, string>();
  const recording: StateBranchAdapter = Object.freeze({
    resolveHead: (branch) => adapter.resolveHead(branch),
    readFile: async (revision, path) => {
      const file = await adapter.readFile(revision, path);
      rememberFile(files, revision, path, file);
      return file;
    },
    readFiles: async (revision, paths) => {
      const result = await adapter.readFiles(revision, paths);
      if (result.size !== paths.length) {
        throw new TypeError("公開済みexact revisionのfile読込数が不足しています");
      }
      for (const path of paths) {
        const file = result.get(path);
        if (file == null) {
          throw new TypeError("公開済みexact revisionのfile読込結果が不足しています");
        }
        rememberFile(files, revision, path, file);
      }
      return result;
    },
    listFiles: async (revision, directory) => {
      const paths = await adapter.listFiles(revision, directory);
      const key = listingKey(revision, directory);
      const previous = listings.get(key);
      if (previous != null) {
        assertSamePaths(previous, paths);
      }
      listings.set(key, Object.freeze([...paths]));
      return paths;
    },
    readCommit: async (revision) => {
      const commit = await adapter.readCommit(revision);
      const digest = nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(commit));
      const previous = commits.get(revision);
      if (previous != null && previous !== digest) {
        throw new TypeError("公開済みexact revisionのcommit metadataが変化しました");
      }
      commits.set(revision, digest);
      return commit;
    },
    commit: (request) => adapter.commit(request),
    publish: (request) => adapter.publish(request),
  });
  return Object.freeze({
    adapter: recording,
    footprint: Object.freeze({ listings, files, commits }),
  });
}

/** freshなpath、byte列を完全検証時の同じexact treeへ照合する。 */
export function assertPostSaveExactReadTree(
  footprint: PostSaveExactReadFootprint,
  revision: string,
  paths: readonly string[],
  files: ReadonlyMap<string, StateFileReadResult>,
): void {
  const expectedPaths = footprint.listings.get(listingKey(revision, "state"));
  const expectedFiles = footprint.files.get(revision);
  if (expectedPaths == null || expectedFiles == null || files.size !== paths.length) {
    throw new TypeError("公開済みexact revisionのtree証明が不足しています");
  }
  assertSamePaths(expectedPaths, paths);
  for (const path of paths) {
    const expected = expectedFiles.get(path);
    const actual = files.get(path);
    if (expected == null || actual == null || !sameFingerprint(expected, actual)) {
      throw new TypeError(`公開済みexact revisionのstate byteが証明と一致しません。対象: ${path}`);
    }
  }
}

/** chain検証に使用した全revisionの読込値をfreshなadapter応答と照合する。 */
export async function assertPostSaveExactReadDependencies(
  adapter: StateBranchAdapter,
  footprint: PostSaveExactReadFootprint,
  currentRevision: string,
  currentFiles: ReadonlyMap<string, StateFileReadResult>,
  currentCommit: StateBranchCommitInspection,
): Promise<void> {
  for (const [key, expected] of footprint.listings) {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new TypeError("公開済みexact revisionのpath証明が不正です");
    }
    const revision: unknown = parsed[0];
    const directory: unknown = parsed[1];
    if (typeof revision !== "string" || typeof directory !== "string") {
      throw new TypeError("公開済みexact revisionのpath証明が不正です");
    }
    if (revision === currentRevision && directory === "state") {
      continue;
    }
    assertSamePaths(expected, await adapter.listFiles(revision, directory));
  }
  for (const [revision, expectedFiles] of footprint.files) {
    const paths = [...expectedFiles.keys()].filter(
      (path) =>
        revision !== currentRevision ||
        expectedFiles.get(path)?.status === "missing" ||
        !currentFiles.has(path),
    );
    if (paths.length === 0) {
      continue;
    }
    const actualFiles = await adapter.readFiles(revision, paths);
    if (actualFiles.size !== paths.length) {
      throw new TypeError("公開済みexact revisionの依存file読込数が一致しません");
    }
    for (const path of paths) {
      const expected = expectedFiles.get(path);
      const actual = actualFiles.get(path);
      if (expected == null || actual == null || !sameFingerprint(expected, actual)) {
        throw new TypeError(`公開済みexact revisionの依存byteが証明と一致しません。対象: ${path}`);
      }
    }
  }
  for (const [revision, expectedDigest] of footprint.commits) {
    const commit =
      revision === currentRevision ? currentCommit : await adapter.readCommit(revision);
    if (nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(commit)) !== expectedDigest) {
      throw new TypeError("公開済みexact revisionのcommit metadataが証明と一致しません");
    }
  }
}

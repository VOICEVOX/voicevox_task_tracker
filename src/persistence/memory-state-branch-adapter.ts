import {
  assertValidStateDirectory,
  assertValidStatePath,
  assertValidStateStorageBranch,
  type StateBranchAdapter,
  type StateBranchCommitInspection,
  type StateBranchCommitRequest,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateBranchPublishRequest,
  type StateFileReadResult,
} from "./branch-adapter.js";
import {
  StateBranchCommitError,
  StateBranchConflictError,
  StateBranchReadError,
  StateConfigurationError,
} from "./errors.js";
import {
  createStateChangedPathManifest,
  createStateCommitMetadata,
} from "./state-commit-metadata.js";

type MemoryCommit = Readonly<{
  files: ReadonlyMap<string, Uint8Array>;
  parent: StateBranchHead;
  metadata: StateBranchCommitResult["metadata"];
  changedPathManifest: StateBranchCommitResult["changedPathManifest"];
}>;

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function headsEqual(left: StateBranchHead, right: StateBranchHead): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === "missing" || right.status === "missing") {
    return true;
  }
  return left.revision === right.revision;
}

/** 性能profile用にstate branchとcommitをメモリ上に保持するadapter。 */
export class MemoryStateBranchAdapter implements StateBranchAdapter {
  readonly #branches = new Map<string, string>();
  readonly #commits = new Map<string, MemoryCommit>();
  readonly #publishedBranches = new Map<string, string>();
  #revisionSequence = 0;

  public resolveHead(branch: string): Promise<StateBranchHead> {
    const revision = this.#branches.get(branch);
    if (revision == null) {
      return Promise.resolve(
        Object.freeze({
          status: "missing",
        }),
      );
    }
    return Promise.resolve(
      Object.freeze({
        status: "present",
        revision,
      }),
    );
  }

  public readFile(revision: string, path: string): Promise<StateFileReadResult> {
    assertValidStatePath(path);
    const commit = this.#commits.get(revision);
    if (commit == null) {
      return Promise.reject(
        new StateBranchReadError({
          cause: new TypeError("指定revisionが存在しません"),
        }),
      );
    }
    const bytes = commit.files.get(path);
    if (bytes == null) {
      return Promise.resolve(
        Object.freeze({
          status: "missing",
        }),
      );
    }
    return Promise.resolve(
      Object.freeze({
        status: "present",
        bytes: copyBytes(bytes),
      }),
    );
  }

  public readFiles(
    revision: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, StateFileReadResult>> {
    if (paths.length === 0) {
      return Promise.resolve(new Map<string, StateFileReadResult>());
    }
    if (new Set(paths).size !== paths.length) {
      throw new StateConfigurationError("読み取りpathが重複しています");
    }
    for (const path of paths) {
      assertValidStatePath(path);
    }
    const commit = this.#commits.get(revision);
    if (commit == null) {
      return Promise.reject(
        new StateBranchReadError({
          cause: new TypeError("指定revisionが存在しません"),
        }),
      );
    }
    const results = new Map<string, StateFileReadResult>();
    for (const path of paths) {
      const bytes = commit.files.get(path);
      results.set(
        path,
        bytes == null
          ? Object.freeze({
              status: "missing",
            })
          : Object.freeze({
              status: "present",
              bytes: copyBytes(bytes),
            }),
      );
    }
    return Promise.resolve(results);
  }

  public listFiles(revision: string, directory: string): Promise<readonly string[]> {
    assertValidStateDirectory(directory);
    const commit = this.#commits.get(revision);
    if (commit == null) {
      return Promise.reject(
        new StateBranchReadError({
          cause: new TypeError("指定revisionが存在しません"),
        }),
      );
    }
    const prefix = `${directory}/`;
    return Promise.resolve(
      Object.freeze(
        [...commit.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .sort((left, right) => {
            if (left < right) {
              return -1;
            }
            if (left > right) {
              return 1;
            }
            return 0;
          }),
      ),
    );
  }

  public async commit(request: StateBranchCommitRequest): Promise<StateBranchCommitResult> {
    assertValidStateStorageBranch(request.branch);
    if (request.updates.length === 0) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("commitするstateファイルがありません"),
        }),
      );
    }
    const paths = request.updates.map((update) => update.path);
    if (
      new Set([...paths, ...request.deletions]).size !==
      paths.length + request.deletions.length
    ) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("commit内でstateファイルが重複しています"),
        }),
      );
    }
    for (const path of paths) {
      assertValidStatePath(path);
    }
    for (const path of request.deletions) {
      assertValidStatePath(path);
    }

    const currentRevision = this.#branches.get(request.branch);
    const currentHead: StateBranchHead =
      currentRevision == null
        ? Object.freeze({
            status: "missing",
          })
        : Object.freeze({
            status: "present",
            revision: currentRevision,
          });
    if (!headsEqual(currentHead, request.expectedHead)) {
      return Promise.reject(new StateBranchConflictError());
    }

    const files =
      currentHead.status === "missing"
        ? new Map<string, Uint8Array>()
        : new Map(this.#commits.get(currentHead.revision)?.files);
    if (currentHead.status === "present" && this.#commits.get(currentHead.revision) == null) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("branch headのcommitが存在しません"),
        }),
      );
    }
    for (const update of request.updates) {
      files.set(update.path, copyBytes(update.bytes));
    }
    for (const path of request.deletions) {
      if (!files.has(path)) {
        return Promise.reject(
          new StateBranchCommitError({
            cause: new TypeError("commit対象の削除stateファイルが存在しません"),
          }),
        );
      }
      files.delete(path);
    }

    const changedPaths = [...new Set([...paths, ...request.deletions])];
    const previousFiles =
      currentHead.status === "missing"
        ? new Map<string, Uint8Array>()
        : this.#commits.get(currentHead.revision)?.files;
    if (previousFiles == null) {
      throw new StateBranchCommitError({ cause: new TypeError("親commitが存在しません") });
    }
    const before = new Map<string, StateFileReadResult>();
    const after = new Map<string, StateFileReadResult>();
    for (const path of changedPaths) {
      const oldBytes = previousFiles.get(path);
      const newBytes = files.get(path);
      before.set(
        path,
        oldBytes == null ? { status: "missing" } : { status: "present", bytes: oldBytes },
      );
      after.set(
        path,
        newBytes == null ? { status: "missing" } : { status: "present", bytes: newBytes },
      );
    }
    const changedPathManifest = createStateChangedPathManifest(before, after);
    const metadata = createStateCommitMetadata(request.commitIdentity, changedPathManifest);

    this.#revisionSequence += 1;
    const revision = this.#revisionSequence.toString(16).padStart(40, "0");
    this.#commits.set(
      revision,
      Object.freeze({
        files: new Map(files),
        parent: currentHead,
        metadata,
        changedPathManifest,
      }),
    );
    this.#branches.set(request.branch, revision);
    return Promise.resolve(
      Object.freeze({
        revision,
        branchCreated: currentHead.status === "missing",
        metadata,
        changedPathManifest,
      }),
    );
  }

  /** メモリ上のexact commitからmetadataと変更manifestを読む。 */
  public readCommit(revision: string): Promise<StateBranchCommitInspection> {
    const commit = this.#commits.get(revision);
    if (commit == null) {
      return Promise.reject(
        new StateBranchReadError({ cause: new TypeError("指定commitが存在しません") }),
      );
    }
    return Promise.resolve(
      Object.freeze({
        revision,
        parent: commit.parent,
        metadata: commit.metadata,
        changedPathManifest: commit.changedPathManifest,
      }),
    );
  }

  /** メモリ上のstate branchを公開済みとして扱う。 */
  public async publish(request: StateBranchPublishRequest): Promise<void> {
    assertValidStateStorageBranch(request.branch);
    if (!this.#commits.has(request.revision)) {
      return Promise.reject(
        new StateBranchReadError({
          cause: new TypeError("公開対象revisionが保存されていません"),
        }),
      );
    }
    if (this.#branches.get(request.branch) !== request.revision) {
      return Promise.reject(new StateBranchConflictError());
    }
    if (this.#publishedBranches.get(request.branch) === request.revision) {
      return Promise.resolve();
    }
    this.#publishedBranches.set(request.branch, request.revision);
    return Promise.resolve();
  }
}

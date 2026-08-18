import {
  assertValidStateDirectory,
  assertValidStatePath,
  type StateBranchAdapter,
  type StateBranchCommitRequest,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
} from "./branch-adapter.js";
import {
  StateBranchCommitError,
  StateBranchConflictError,
  StateBranchReadError,
  StateConfigurationError,
} from "./errors.js";

type MemoryCommit = Readonly<{
  files: ReadonlyMap<string, Uint8Array>;
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

  public commit(request: StateBranchCommitRequest): Promise<StateBranchCommitResult> {
    if (request.branch !== "tracker-state") {
      return Promise.reject(new StateConfigurationError("tracker-state branchだけを更新できます"));
    }
    if (request.updates.length === 0) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("commitするstateファイルがありません"),
        }),
      );
    }
    const paths = request.updates.map((update) => update.path);
    if (new Set(paths).size !== paths.length) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("commit内でstateファイルが重複しています"),
        }),
      );
    }
    for (const path of paths) {
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

    this.#revisionSequence += 1;
    const revision = `memory-state-${this.#revisionSequence.toString()}`;
    this.#commits.set(
      revision,
      Object.freeze({
        files: new Map(files),
      }),
    );
    this.#branches.set(request.branch, revision);
    return Promise.resolve(
      Object.freeze({
        revision,
        branchCreated: currentHead.status === "missing",
      }),
    );
  }
}

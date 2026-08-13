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
  revision: string;
  parent: StateBranchHead;
  files: ReadonlyMap<string, Uint8Array>;
}>;

type NextCommitBehavior =
  | Readonly<{
      status: "succeed";
    }>
  | Readonly<{
      status: "fail";
      error: Error;
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

/** テストでstate branchとcommitをメモリ上に保持するadapter。 */
export class MemoryStateBranchAdapter implements StateBranchAdapter {
  readonly #branches = new Map<string, string>();
  readonly #commits = new Map<string, MemoryCommit>();
  #nextCommitBehavior: NextCommitBehavior = {
    status: "succeed",
  };
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
    if (request.updates.length === 0 && request.deletions.length === 0) {
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
    const deletions = request.deletions;
    if (new Set(deletions).size !== deletions.length) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("commit内で削除対象のstateファイルが重複しています"),
        }),
      );
    }
    if (deletions.some((path) => paths.includes(path))) {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new TypeError("同じstateファイルを更新と削除の両方へ指定できません"),
        }),
      );
    }
    for (const path of paths) {
      assertValidStatePath(path);
    }
    for (const path of deletions) {
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
    for (const path of deletions) {
      files.delete(path);
    }

    const behavior = this.#nextCommitBehavior;
    this.#nextCommitBehavior = {
      status: "succeed",
    };
    if (behavior.status === "fail") {
      return Promise.reject(
        new StateBranchCommitError({
          cause: new Error("ref更新前にfixture failureが発生しました", {
            cause: behavior.error,
          }),
        }),
      );
    }

    this.#revisionSequence += 1;
    const revision = `memory-state-${this.#revisionSequence.toString()}`;
    this.#commits.set(
      revision,
      Object.freeze({
        revision,
        parent: currentHead,
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

  /** 次のcommitをref更新直前で失敗させる。 */
  public failNextCommit(error: Error): void {
    this.#nextCommitBehavior = Object.freeze({
      status: "fail",
      error,
    });
  }

  /** テスト検証用にbranch headの全ファイルを複製して返す。 */
  public async readBranchFiles(branch: string): Promise<ReadonlyMap<string, Uint8Array>> {
    const head = await this.resolveHead(branch);
    if (head.status === "missing") {
      return new Map();
    }
    const commit = this.#commits.get(head.revision);
    if (commit == null) {
      throw new StateBranchReadError({
        cause: new TypeError("branch headのcommitが存在しません"),
      });
    }
    return new Map([...commit.files].map(([path, bytes]) => [path, copyBytes(bytes)]));
  }

  /** テスト検証用にcommitの親revision状態を返す。 */
  public readParent(revision: string): StateBranchHead {
    const commit = this.#commits.get(revision);
    if (commit == null) {
      throw new StateBranchReadError({
        cause: new TypeError("指定revisionが存在しません"),
      });
    }
    return commit.parent;
  }
}

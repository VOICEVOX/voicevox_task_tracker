import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const TRACKER_STATE_BRANCH = "tracker-state-v4";
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

type GitCommandInput =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "present";
      bytes: Uint8Array;
    }>;

type GitCommandRequest = Readonly<{
  arguments: readonly string[];
  input: GitCommandInput;
  environment: Readonly<NodeJS.ProcessEnv>;
  acceptedExitCodes: ReadonlySet<number>;
}>;

type GitCommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
}>;

class GitCommandError extends Error {
  public readonly exitCode: number;

  public constructor(exitCode: number) {
    super(`git commandが終了code ${exitCode.toString()}で失敗しました`);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
  }
}

/** Git state branch adapterを生成するための副作用設定。 */
export type GitStateBranchAdapterOptions = Readonly<{
  repositoryPath: string;
  gitExecutable: string;
  authorName: string;
  authorEmail: string;
}>;

function compareHeads(left: StateBranchHead, right: StateBranchHead): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === "missing" || right.status === "missing") {
    return true;
  }
  return left.revision === right.revision;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(bytes);
  } catch (error: unknown) {
    throw new TypeError("git出力がUTF-8ではありません", {
      cause: error,
    });
  }
}

function parseObjectId(bytes: Uint8Array): string {
  const objectId = decodeUtf8(bytes).trim();
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new TypeError("git object IDの形式が不正です");
  }
  return objectId;
}

function validateBranch(branch: string): void {
  if (branch !== TRACKER_STATE_BRANCH) {
    throw new StateConfigurationError(`${TRACKER_STATE_BRANCH} branchだけを操作できます`);
  }
}

function validateCommitRequest(request: StateBranchCommitRequest): void {
  validateBranch(request.branch);
  if (request.updates.length === 0 && request.deletions.length === 0) {
    throw new StateConfigurationError("commitするstateファイルがありません");
  }
  if (request.message.length === 0 || request.message.length > 1000) {
    throw new StateConfigurationError("commit messageの長さが不正です");
  }
  if (new Date(request.committedAt).toISOString() !== request.committedAt) {
    throw new StateConfigurationError("commit日時をUTCへ正規化してください");
  }
  const paths = request.updates.map((update) => update.path);
  if (new Set(paths).size !== paths.length) {
    throw new StateConfigurationError("commit内でstateファイルが重複しています");
  }
  const deletions = request.deletions;
  if (new Set(deletions).size !== deletions.length) {
    throw new StateConfigurationError("commit内で削除対象のstateファイルが重複しています");
  }
  if (deletions.some((path) => paths.includes(path))) {
    throw new StateConfigurationError("同じstateファイルを更新と削除の両方へ指定できません");
  }
  for (const path of paths) {
    assertValidStatePath(path);
  }
  for (const path of deletions) {
    assertValidStatePath(path);
  }
  if (
    request.expectedHead.status === "present" &&
    !OBJECT_ID_PATTERN.test(request.expectedHead.revision)
  ) {
    throw new StateConfigurationError("expected headのobject IDが不正です");
  }
}

/** checkoutせずGit objectとrefを操作してstateをatomic commitするadapter。 */
export class GitStateBranchAdapter implements StateBranchAdapter {
  readonly #repositoryPath: string;
  readonly #gitExecutable: string;
  readonly #authorName: string;
  readonly #authorEmail: string;
  readonly #baseEnvironment: Readonly<NodeJS.ProcessEnv>;

  public constructor(options: GitStateBranchAdapterOptions) {
    if (
      options.repositoryPath.length === 0 ||
      options.gitExecutable.length === 0 ||
      options.authorName.length === 0 ||
      options.authorEmail.length === 0
    ) {
      throw new StateConfigurationError("Git adapter設定に空文字は指定できません");
    }
    const executableSearchPath = process.env["PATH"];
    if (executableSearchPath == null || executableSearchPath.length === 0) {
      throw new StateConfigurationError("gitを探索するPATHがありません");
    }
    this.#repositoryPath = resolve(options.repositoryPath);
    this.#gitExecutable = options.gitExecutable;
    this.#authorName = options.authorName;
    this.#authorEmail = options.authorEmail;
    this.#baseEnvironment = Object.freeze({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      PATH: executableSearchPath,
    });
  }

  async #runGit(request: GitCommandRequest): Promise<GitCommandResult> {
    return new Promise((resolveResult, rejectResult) => {
      const child = spawn(
        this.#gitExecutable,
        ["-C", this.#repositoryPath, "-c", "commit.gpgsign=false", ...request.arguments],
        {
          env: request.environment,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const chunks: Uint8Array[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(Uint8Array.from(chunk));
      });
      child.on("error", () => {
        rejectResult(new GitCommandError(-1));
      });
      child.on("close", (exitCode) => {
        if (exitCode == null || !request.acceptedExitCodes.has(exitCode)) {
          rejectResult(new GitCommandError(exitCode ?? -1));
          return;
        }
        resolveResult(
          Object.freeze({
            exitCode,
            stdout: Uint8Array.from(Buffer.concat(chunks)),
          }),
        );
      });
      if (request.input.status === "present") {
        child.stdin.end(request.input.bytes);
      } else {
        child.stdin.end();
      }
    });
  }

  async #resolveHead(branch: string): Promise<StateBranchHead> {
    validateBranch(branch);
    const result = await this.#runGit({
      arguments: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      input: {
        status: "none",
      },
      environment: this.#baseEnvironment,
      acceptedExitCodes: new Set([0, 1]),
    });
    if (result.exitCode === 1) {
      return Object.freeze({
        status: "missing",
      });
    }
    return Object.freeze({
      status: "present",
      revision: parseObjectId(result.stdout),
    });
  }

  public async resolveHead(branch: string): Promise<StateBranchHead> {
    try {
      return await this.#resolveHead(branch);
    } catch (error: unknown) {
      if (error instanceof StateConfigurationError) {
        throw error;
      }
      throw new StateBranchReadError({
        cause: new Error("git branch headの取得に失敗しました", {
          cause: error,
        }),
      });
    }
  }

  public async readFile(revision: string, path: string): Promise<StateFileReadResult> {
    assertValidStatePath(path);
    if (!OBJECT_ID_PATTERN.test(revision)) {
      throw new StateConfigurationError("読み取りrevisionのobject IDが不正です");
    }
    try {
      const listing = await this.#runGit({
        arguments: ["ls-tree", "-z", revision, "--", path],
        input: {
          status: "none",
        },
        environment: this.#baseEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      if (listing.stdout.length === 0) {
        return Object.freeze({
          status: "missing",
        });
      }
      const content = await this.#runGit({
        arguments: ["show", `${revision}:${path}`],
        input: {
          status: "none",
        },
        environment: this.#baseEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      return Object.freeze({
        status: "present",
        bytes: Uint8Array.from(content.stdout),
      });
    } catch (error: unknown) {
      if (error instanceof StateConfigurationError) {
        throw error;
      }
      throw new StateBranchReadError({
        cause: new Error("git treeのファイル取得に失敗しました", {
          cause: error,
        }),
      });
    }
  }

  public async listFiles(revision: string, directory: string): Promise<readonly string[]> {
    assertValidStateDirectory(directory);
    if (!OBJECT_ID_PATTERN.test(revision)) {
      throw new StateConfigurationError("一覧revisionのobject IDが不正です");
    }
    try {
      const result = await this.#runGit({
        arguments: ["ls-tree", "-r", "--name-only", "-z", revision, "--", directory],
        input: {
          status: "none",
        },
        environment: this.#baseEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      const source = decodeUtf8(result.stdout);
      if (source.length === 0) {
        return Object.freeze([]);
      }
      const paths = source.split("\0");
      if (paths.at(-1) === "") {
        paths.pop();
      }
      for (const path of paths) {
        assertValidStatePath(path);
      }
      return Object.freeze(paths);
    } catch (error: unknown) {
      if (error instanceof StateConfigurationError) {
        throw error;
      }
      throw new StateBranchReadError({
        cause: new Error("git treeのファイル一覧取得に失敗しました", {
          cause: error,
        }),
      });
    }
  }

  async #createCommitCandidate(request: StateBranchCommitRequest): Promise<string> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "voicevox-state-index-"));
    const indexPath = join(temporaryDirectory, "index");
    const indexEnvironment = Object.freeze({
      ...this.#baseEnvironment,
      GIT_INDEX_FILE: indexPath,
    });
    try {
      await this.#runGit({
        arguments:
          request.expectedHead.status === "missing"
            ? ["read-tree", "--empty"]
            : ["read-tree", request.expectedHead.revision],
        input: {
          status: "none",
        },
        environment: indexEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      for (const update of request.updates) {
        const blob = await this.#runGit({
          arguments: ["hash-object", "-w", "--stdin"],
          input: {
            status: "present",
            bytes: update.bytes,
          },
          environment: indexEnvironment,
          acceptedExitCodes: new Set([0]),
        });
        await this.#runGit({
          arguments: [
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            parseObjectId(blob.stdout),
            update.path,
          ],
          input: {
            status: "none",
          },
          environment: indexEnvironment,
          acceptedExitCodes: new Set([0]),
        });
      }
      for (const path of request.deletions) {
        await this.#runGit({
          arguments: ["update-index", "--force-remove", "--", path],
          input: {
            status: "none",
          },
          environment: indexEnvironment,
          acceptedExitCodes: new Set([0]),
        });
      }
      const tree = await this.#runGit({
        arguments: ["write-tree"],
        input: {
          status: "none",
        },
        environment: indexEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      const commitEnvironment = Object.freeze({
        ...indexEnvironment,
        GIT_AUTHOR_DATE: request.committedAt,
        GIT_AUTHOR_EMAIL: this.#authorEmail,
        GIT_AUTHOR_NAME: this.#authorName,
        GIT_COMMITTER_DATE: request.committedAt,
        GIT_COMMITTER_EMAIL: this.#authorEmail,
        GIT_COMMITTER_NAME: this.#authorName,
      });
      const commit = await this.#runGit({
        arguments:
          request.expectedHead.status === "missing"
            ? ["commit-tree", parseObjectId(tree.stdout)]
            : ["commit-tree", parseObjectId(tree.stdout), "-p", request.expectedHead.revision],
        input: {
          status: "present",
          bytes: new TextEncoder().encode(`${request.message}\n`),
        },
        environment: commitEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      return parseObjectId(commit.stdout);
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  public async commit(request: StateBranchCommitRequest): Promise<StateBranchCommitResult> {
    validateCommitRequest(request);
    let revision: string;
    try {
      revision = await this.#createCommitCandidate(request);
    } catch (error: unknown) {
      throw new StateBranchCommitError({
        cause: new Error("Git commit objectの生成に失敗しました", {
          cause: error,
        }),
      });
    }

    const expectedObjectId =
      request.expectedHead.status === "missing" ? ZERO_OBJECT_ID : request.expectedHead.revision;
    let updateResult: GitCommandResult;
    try {
      updateResult = await this.#runGit({
        arguments: ["update-ref", `refs/heads/${request.branch}`, revision, expectedObjectId],
        input: {
          status: "none",
        },
        environment: this.#baseEnvironment,
        acceptedExitCodes: new Set([0, 1, 128]),
      });
    } catch (error: unknown) {
      throw new StateBranchCommitError({
        cause: new Error("Git refの更新に失敗しました", {
          cause: error,
        }),
      });
    }
    if (updateResult.exitCode !== 0) {
      const currentHead = await this.resolveHead(request.branch);
      if (!compareHeads(currentHead, request.expectedHead)) {
        throw new StateBranchConflictError();
      }
      throw new StateBranchCommitError({
        cause: new GitCommandError(updateResult.exitCode),
      });
    }
    return Object.freeze({
      revision,
      branchCreated: request.expectedHead.status === "missing",
    });
  }
}

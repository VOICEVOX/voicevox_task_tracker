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
  type StateBranchPublishRequest,
  type StateFileReadResult,
} from "./branch-adapter.js";
import {
  StateBranchCommitError,
  StateBranchConflictError,
  StateBranchReadError,
  StateConfigurationError,
} from "./errors.js";

const TRACKER_STATE_BRANCH = "tracker-state";
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PUBLISH_MAX_ATTEMPTS = 3;
const PUBLISH_RETRY_DELAY_MILLISECONDS = 1000;

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

function parseNullSeparatedPaths(bytes: Uint8Array): readonly string[] {
  const source = decodeUtf8(bytes);
  if (source.length === 0) {
    return Object.freeze([]);
  }
  const paths = source.split("\0");
  if (paths.at(-1) === "") {
    paths.pop();
  }
  if (paths.some((path) => path.length === 0)) {
    throw new TypeError("gitの追跡path一覧が不正です");
  }
  return Object.freeze(paths);
}

function validateReadPaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) {
    throw new StateConfigurationError("読み取りpathが重複しています");
  }
  for (const path of paths) {
    assertValidStatePath(path);
  }
}

function findLineFeed(bytes: Uint8Array, offset: number): number {
  const lineFeedIndex = bytes.indexOf(0x0a, offset);
  if (lineFeedIndex < 0) {
    throw new TypeError("git cat-fileの応答headerが改行で終わっていません");
  }
  return lineFeedIndex;
}

function parseBatchSize(value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new TypeError("git cat-fileのblob byte sizeが不正です");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new TypeError("git cat-fileのblob byte sizeが大きすぎます");
  }
  return size;
}

type GitBatchObjectHeader =
  | Readonly<{
      status: "missing";
      offset: number;
    }>
  | Readonly<{
      status: "present";
      objectId: string;
      objectType: string;
      size: number;
      offset: number;
    }>;

function parseGitBatchHeader(
  bytes: Uint8Array,
  offset: number,
  expectedObjectName: string,
): GitBatchObjectHeader {
  const headerEnd = findLineFeed(bytes, offset);
  const header = decodeUtf8(bytes.slice(offset, headerEnd));
  const nextOffset = headerEnd + 1;
  const fields = header.split(" ");
  const firstField = fields[0];
  if (fields.length === 2 && fields[1] === "missing") {
    if (firstField !== expectedObjectName) {
      throw new TypeError("git cat-fileのmissing対象が要求pathと一致しません");
    }
    return Object.freeze({
      status: "missing",
      offset: nextOffset,
    });
  }
  if (fields.length !== 3 || firstField == null || fields[1] == null || fields[2] == null) {
    throw new TypeError("git cat-fileの応答headerが不正です");
  }
  if (!OBJECT_ID_PATTERN.test(firstField)) {
    throw new TypeError("git cat-fileのobject IDが不正です");
  }
  return Object.freeze({
    status: "present",
    objectId: firstField,
    objectType: fields[1],
    size: parseBatchSize(fields[2]),
    offset: nextOffset,
  });
}

function parseGitBatchResult(
  revision: string,
  paths: readonly string[],
  bytes: Uint8Array,
): ReadonlyMap<string, StateFileReadResult> {
  const results = new Map<string, StateFileReadResult>();
  const revisionHeader = parseGitBatchHeader(bytes, 0, `${revision}^{tree}`);
  if (revisionHeader.status === "missing") {
    throw new TypeError("指定revisionが存在しません");
  }
  if (revisionHeader.objectType !== "tree") {
    throw new TypeError("指定revisionがtreeとして解決できません");
  }
  let offset = revisionHeader.offset;
  for (const path of paths) {
    const objectName = `${revision}:${path}`;
    const header = parseGitBatchHeader(bytes, offset, objectName);
    offset = header.offset;
    if (header.status === "missing") {
      results.set(
        path,
        Object.freeze({
          status: "missing",
        }),
      );
      continue;
    }
    if (header.objectType !== "blob") {
      throw new TypeError("state pathがblobではありません");
    }
    const size = header.size;
    if (size > bytes.length - offset) {
      throw new TypeError("git cat-fileのblob byte sizeが応答長を超えています");
    }
    const contentEnd = offset + size;
    if (bytes[contentEnd] !== 0x0a) {
      throw new TypeError("git cat-fileのblob本文後の区切りが不正です");
    }
    results.set(
      path,
      Object.freeze({
        status: "present",
        bytes: bytes.slice(offset, contentEnd),
      }),
    );
    offset = contentEnd + 1;
  }
  if (offset !== bytes.length) {
    throw new TypeError("git cat-fileの応答に余剰データがあります");
  }
  return results;
}

function validateBranch(branch: string): void {
  if (branch !== TRACKER_STATE_BRANCH) {
    throw new StateConfigurationError(`${TRACKER_STATE_BRANCH} branchだけを操作できます`);
  }
}

function validateCommitRequest(request: StateBranchCommitRequest): void {
  validateBranch(request.branch);
  if (request.updates.length === 0) {
    throw new StateConfigurationError("commitするstateファイルがありません");
  }
  if (request.message.length === 0 || request.message.length > 1000) {
    throw new StateConfigurationError("commit messageの長さが不正です");
  }
  if (new Date(request.committedAt).toISOString() !== request.committedAt) {
    throw new StateConfigurationError("commit日時をUTCへ正規化してください");
  }
  const paths = request.updates.map((update) => update.path);
  if (new Set([...paths, ...request.deletions]).size !== paths.length + request.deletions.length) {
    throw new StateConfigurationError("commit内でstateファイルが重複しています");
  }
  for (const path of paths) {
    assertValidStatePath(path);
  }
  for (const path of request.deletions) {
    assertValidStatePath(path);
  }
  if (
    request.expectedHead.status === "present" &&
    !OBJECT_ID_PATTERN.test(request.expectedHead.revision)
  ) {
    throw new StateConfigurationError("expected headのobject IDが不正です");
  }
}

function validatePublishRequest(request: StateBranchPublishRequest): void {
  validateBranch(request.branch);
  if (!OBJECT_ID_PATTERN.test(request.revision)) {
    throw new StateConfigurationError("公開revisionのobject IDが不正です");
  }
}

function waitBeforePublishRetry(): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, PUBLISH_RETRY_DELAY_MILLISECONDS);
  });
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

  public async readFiles(
    revision: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, StateFileReadResult>> {
    if (paths.length === 0) {
      return new Map<string, StateFileReadResult>();
    }
    validateReadPaths(paths);
    if (!OBJECT_ID_PATTERN.test(revision)) {
      throw new StateConfigurationError("一括読み取りrevisionのobject IDが不正です");
    }
    const input = new TextEncoder().encode(
      [`info ${revision}^{tree}`, ...paths.map((path) => `contents ${revision}:${path}`)].join(
        "\n",
      ) + "\n",
    );
    try {
      const result = await this.#runGit({
        arguments: ["cat-file", "--batch-command"],
        input: {
          status: "present",
          bytes: input,
        },
        environment: this.#baseEnvironment,
        acceptedExitCodes: new Set([0]),
      });
      return parseGitBatchResult(revision, paths, result.stdout);
    } catch (error: unknown) {
      if (error instanceof StateConfigurationError) {
        throw error;
      }
      throw new StateBranchReadError({
        cause: new Error("git treeのstateファイル一括取得に失敗しました", {
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
      if (request.deletions.length > 0) {
        const trackedPaths = parseNullSeparatedPaths(
          (
            await this.#runGit({
              arguments: ["ls-files", "-z"],
              input: {
                status: "none",
              },
              environment: indexEnvironment,
              acceptedExitCodes: new Set([0]),
            })
          ).stdout,
        );
        const trackedPathSet = new Set(trackedPaths);
        for (const path of request.deletions) {
          if (!trackedPathSet.has(path)) {
            throw new TypeError("commit対象の削除stateファイルが存在しません");
          }
        }
        await this.#runGit({
          arguments: ["update-index", "--force-remove", "-z", "--stdin"],
          input: {
            status: "present",
            bytes: new TextEncoder().encode(`${request.deletions.join("\0")}\0`),
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

  /** state branchの指定revisionをリモートへ公開する。 */
  public async publish(request: StateBranchPublishRequest): Promise<void> {
    validatePublishRequest(request);
    for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.#runGit({
          arguments: [
            "push",
            "--no-follow-tags",
            "origin",
            `${request.revision}:refs/heads/${request.branch}`,
          ],
          input: {
            status: "none",
          },
          environment: {
            ...process.env,
            ...this.#baseEnvironment,
          },
          acceptedExitCodes: new Set([0]),
        });
        return;
      } catch (error: unknown) {
        if (attempt === PUBLISH_MAX_ATTEMPTS) {
          throw error;
        }
        await waitBeforePublishRetry();
      }
    }
    throw new TypeError("state branch公開の到達不能な分岐へ到達しました");
  }
}

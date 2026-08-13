import { StateConfigurationError } from "./errors.js";

const STATE_BRANCH = "tracker-state";
const STATE_ROOT_DIRECTORY = "state";
const STATE_PATH_PREFIX = "state/";

/** 永続化が利用する設定のstate節。 */
export type StatePersistenceConfiguration = Readonly<{
  branch: string;
  snapshotPath: string;
  historyDirectory: string;
  aiCacheDirectory: string;
  notificationLedgerPath: string;
  runReportsDirectory: string;
  canonicalJson: boolean;
}>;

/** branchが未作成か特定revisionを指すかを表す。 */
export type StateBranchHead =
  | Readonly<{
      status: "missing";
    }>
  | Readonly<{
      status: "present";
      revision: string;
    }>;

/** state branch内のファイル読み取り結果。 */
export type StateFileReadResult =
  | Readonly<{
      status: "missing";
    }>
  | Readonly<{
      status: "present";
      bytes: Uint8Array;
    }>;

/** 一つのcommitで置き換えるstateファイル。 */
export type StateFileUpdate = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

/** state branchのatomic commit要求。 */
export type StateBranchCommitRequest = Readonly<{
  branch: string;
  expectedHead: StateBranchHead;
  updates: readonly StateFileUpdate[];
  deletions: readonly string[];
  message: string;
  committedAt: string;
}>;

/** state branchのatomic commit結果。 */
export type StateBranchCommitResult = Readonly<{
  revision: string;
  branchCreated: boolean;
}>;

/** Git操作と永続化ロジックを分離するbranch adapter境界。 */
export type StateBranchAdapter = Readonly<{
  resolveHead: (branch: string) => Promise<StateBranchHead>;
  readFile: (revision: string, path: string) => Promise<StateFileReadResult>;
  listFiles: (revision: string, directory: string) => Promise<readonly string[]>;
  commit: (request: StateBranchCommitRequest) => Promise<StateBranchCommitResult>;
}>;

/** state branch内で利用できる正規化済み相対パスか検証する。 */
export function assertValidStatePath(path: string): void {
  const segments = path.split("/");
  if (
    !path.startsWith(STATE_PATH_PREFIX) ||
    path.endsWith("/") ||
    path.includes("\\") ||
    !/^[A-Za-z0-9._/-]+$/u.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new StateConfigurationError("state配下の正規化された相対パスが必要です");
  }
}

/** state配下またはstateルートの一覧取得用directoryか検証する。 */
export function assertValidStateDirectory(path: string): void {
  if (path === STATE_ROOT_DIRECTORY) {
    return;
  }
  assertValidStatePath(path);
}

/** state設定を永続化境界でも独立して検証する。 */
export function validateStatePersistenceConfiguration(
  configuration: StatePersistenceConfiguration,
): void {
  if (configuration.branch !== STATE_BRANCH) {
    throw new StateConfigurationError(`${STATE_BRANCH} branchだけを使用できます`);
  }
  if (!configuration.canonicalJson) {
    throw new StateConfigurationError("canonicalJsonを有効にしてください");
  }
  const paths = [
    configuration.snapshotPath,
    configuration.historyDirectory,
    configuration.aiCacheDirectory,
    configuration.notificationLedgerPath,
    configuration.runReportsDirectory,
  ];
  for (const path of paths) {
    assertValidStatePath(path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new StateConfigurationError("保存先パスが重複しています");
  }
}

/** state設定のdirectoryと安全なファイル名を結合する。 */
export function joinStatePath(directory: string, fileName: string): string {
  assertValidStatePath(directory);
  if (
    fileName.length === 0 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new StateConfigurationError("stateのファイル名が不正です");
  }
  const path = `${directory}/${fileName}`;
  assertValidStatePath(path);
  return path;
}

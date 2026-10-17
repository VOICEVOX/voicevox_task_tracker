import { assertValidStatePath } from "./state-path.js";
export { assertValidStatePath } from "./state-path.js";
import type {
  StateBranchHead,
  StateFileReadResult,
  StateFileUpdate,
} from "./branch-adapter-contracts.js";
export type {
  StateBranchHead,
  StateFileReadResult,
  StateFileUpdate,
} from "./branch-adapter-contracts.js";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import { StateConfigurationError } from "./errors.js";
import { OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 } from "./operations-alert-ledger.js";
import type {
  StateChangedPathManifest,
  StateCommitIdentity,
  StateCommitMetadataV1,
} from "./state-commit-metadata.js";

const STATE_ROOT_DIRECTORY = "state";
const STATE_BRANCH_PATTERN = /^(?:tracker-state|sandbox-state\/env-[1-9][0-9]*-[1-9][0-9]*)$/u;
const OPERATIONS_ALERT_BRANCH_PATTERN =
  /^(?:tracker-operations-alerts|sandbox-operations-alerts\/env-[1-9][0-9]*-[1-9][0-9]*)$/u;
export const PRODUCTION_PAGES_EFFECT_LEASE_BRANCH = "tracker-pages-effect-lease";

/** 永続化が利用する設定のstate節。 */
export type StatePersistenceConfiguration = Readonly<{
  branch: string;
  snapshotPath: string;
  historyDirectory: string;
  aiCacheDirectory: string;
  personalReminderAiCacheDirectory: string;
  notificationLedgerPath: string;
  runReportsDirectory: string;
  canonicalJson: boolean;
}>;

/** state branch adapterが解決したoriginのfetch先とpush先。 */
export type StateRemoteUrls = Readonly<{
  fetchUrls: readonly string[];
  pushUrls: readonly string[];
}>;

/** state branchのatomic commit要求。 */
export type StateBranchCommitRequest = Readonly<{
  branch: string;
  expectedHead: StateBranchHead;
  updates: readonly StateFileUpdate[];
  deletions: readonly string[];
  message: string;
  committedAt: string;
  commitIdentity: StateCommitIdentity;
}>;

/** state branchのatomic commit結果。 */
export type StateBranchCommitResult = Readonly<{
  revision: string;
  branchCreated: boolean;
  metadata: StateCommitMetadataV1;
  changedPathManifest: StateChangedPathManifest;
}>;

/** exact commitから独立して検証したstate metadata。 */
export type StateBranchCommitInspection = Readonly<{
  revision: string;
  parent: StateBranchHead;
  metadata: StateCommitMetadataV1;
  changedPathManifest: StateChangedPathManifest;
}>;

/** state branchをリモートへ公開する要求。 */
export type StateBranchPublishRequest = Readonly<{
  branch: string;
  revision: string;
}>;

/** Git操作と永続化ロジックを分離するbranch adapter境界。 */
export type StateBranchAdapter = Readonly<{
  resolveHead: (branch: string) => Promise<StateBranchHead>;
  resolveRepositoryRevision?: () => Promise<string>;
  resolveOriginUrls?: () => Promise<StateRemoteUrls>;
  readFile: (revision: string, path: string) => Promise<StateFileReadResult>;
  readFiles: (
    revision: string,
    paths: readonly string[],
  ) => Promise<ReadonlyMap<string, StateFileReadResult>>;
  listFiles: (revision: string, directory: string) => Promise<readonly string[]>;
  readCommit: (revision: string) => Promise<StateBranchCommitInspection>;
  commit: (request: StateBranchCommitRequest) => Promise<StateBranchCommitResult>;
  publish: (request: StateBranchPublishRequest) => Promise<void>;
}>;

/** stateを保存できるbranch名か検証する。 */
export function assertValidStateBranch(branch: string): void {
  if (!STATE_BRANCH_PATTERN.test(branch)) {
    throw new StateConfigurationError("tracker-stateまたはsandbox-state配下のbranchが必要です");
  }
}

/** stateまたは副作用専用branch名か検証する。 */
export function assertValidStateStorageBranch(branch: string): void {
  if (
    !STATE_BRANCH_PATTERN.test(branch) &&
    !OPERATIONS_ALERT_BRANCH_PATTERN.test(branch) &&
    branch !== PRODUCTION_PAGES_EFFECT_LEASE_BRANCH
  ) {
    throw new StateConfigurationError("stateまたは副作用専用branchが必要です");
  }
}

/** 追跡state branchに対応する運用通知専用branchを返す。 */
export function operationsAlertBranchForStateBranch(branch: string): string {
  assertValidStateBranch(branch);
  return branch === "tracker-state"
    ? "tracker-operations-alerts"
    : branch.replace(/^sandbox-state\//u, "sandbox-operations-alerts/");
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
  assertValidStateBranch(configuration.branch);
  if (!configuration.canonicalJson) {
    throw new StateConfigurationError("canonicalJsonを有効にしてください");
  }
  const paths = [
    configuration.snapshotPath,
    configuration.historyDirectory,
    configuration.aiCacheDirectory,
    configuration.personalReminderAiCacheDirectory,
    configuration.notificationLedgerPath,
    configuration.runReportsDirectory,
  ];
  for (const path of paths) {
    assertValidStatePath(path);
  }
  if (new Set(paths).size !== paths.length) {
    throw new StateConfigurationError("保存先パスが重複しています");
  }
  const fixedPaths = new Set([
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  ]);
  if (paths.some((path) => fixedPaths.has(path))) {
    throw new StateConfigurationError("保存先パスが固定run transaction pathと重複しています");
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

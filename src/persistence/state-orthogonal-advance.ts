import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import {
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateBranchConflictError } from "./errors.js";
import { assertSandboxManifestCommit } from "./sandbox-environment-manifest.js";
import { isOrthogonalStateCommitScope } from "./state-commit-metadata.js";
import {
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  isCanonicalStateOperationsAlertLedgerSource,
} from "./state-documents.js";

export const MAX_INTERVENING_COMMITS = 1024;

/** operations alert commitを挟んだCAS親の認証結果。 */
export type OrthogonalCommitAdvance = Readonly<{
  expectedTrackingStateRevision: string;
  actualParentStateRevision: string;
  interveningOperationsAlertCommits: readonly string[];
}>;

function sameFile(left: StateFileReadResult, right: StateFileReadResult): boolean {
  if (left.status !== right.status) {
    return false;
  }
  if (left.status === "missing" || right.status === "missing") {
    return true;
  }
  return (
    left.bytes.length === right.bytes.length &&
    left.bytes.every((byte, index) => byte === right.bytes[index])
  );
}

/** 全intervening commitが独立した運用通知更新だと証明する。 */
export async function authorizeAdvanceAfterOrthogonalCommits(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedTrackingRevision: string,
  observedHeadRevision: string,
): Promise<OrthogonalCommitAdvance> {
  validateStatePersistenceConfiguration(configuration);
  if (expectedTrackingRevision === observedHeadRevision) {
    return Object.freeze({
      expectedTrackingStateRevision: expectedTrackingRevision,
      actualParentStateRevision: observedHeadRevision,
      interveningOperationsAlertCommits: Object.freeze([]),
    });
  }
  const intervening: string[] = [];
  let revision = observedHeadRevision;
  try {
    while (revision !== expectedTrackingRevision) {
      if (intervening.length >= MAX_INTERVENING_COMMITS) {
        throw new TypeError("介在state commitが上限を超えています");
      }
      const commit = await adapter.readCommit(revision);
      if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
        throw new TypeError("介在commitが独立した運用通知更新ではありません");
      }
      if (commit.metadata.commitScope === "sandbox_manifest") {
        if (!configuration.branch.startsWith("sandbox-state/")) {
          throw new TypeError("本番stateにsandbox manifest commitがあります");
        }
        await assertSandboxManifestCommit(adapter, commit);
      } else {
        if (
          commit.changedPathManifest.entries.length !== 1 ||
          commit.changedPathManifest.entries[0]?.path !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1
        ) {
          throw new TypeError("運用通知commitの変更範囲が不正です");
        }
        const operationsFile = await adapter.readFile(
          revision,
          OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
        );
        if (operationsFile.status !== "present") {
          throw new TypeError("介在commitに運用通知ledgerがありません");
        }
        const source = new TextDecoder("utf-8", { fatal: true }).decode(operationsFile.bytes);
        if (!isCanonicalStateOperationsAlertLedgerSource(source)) {
          throw new TypeError("介在commitの運用通知ledgerが現行形式ではありません");
        }
        intervening.push(revision);
      }
      if (commit.parent.status === "missing") {
        if (expectedTrackingRevision !== "unborn") {
          throw new TypeError("期待revisionが観測headの祖先ではありません");
        }
        break;
      }
      revision = commit.parent.revision;
    }
    const protectedPaths = [
      configuration.snapshotPath,
      configuration.notificationLedgerPath,
      DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
      RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
    ];
    const [expectedFiles, observedFiles] = await Promise.all([
      expectedTrackingRevision === "unborn"
        ? Promise.resolve(
            new Map(
              protectedPaths.map((path) => [
                path,
                { status: "missing" } satisfies StateFileReadResult,
              ]),
            ),
          )
        : adapter.readFiles(expectedTrackingRevision, protectedPaths),
      adapter.readFiles(observedHeadRevision, protectedPaths),
    ]);
    for (const path of protectedPaths) {
      const expected = expectedFiles.get(path);
      const observed = observedFiles.get(path);
      if (expected == null || observed == null || !sameFile(expected, observed)) {
        throw new TypeError("介在commitの前後で追跡state fileが変化しています");
      }
    }
    return Object.freeze({
      expectedTrackingStateRevision: expectedTrackingRevision,
      actualParentStateRevision: observedHeadRevision,
      interveningOperationsAlertCommits: Object.freeze(intervening.reverse()),
    });
  } catch (error: unknown) {
    throw new StateBranchConflictError({ cause: error });
  }
}

export async function findInitialStateRevision(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  observedRevision: string,
  runId: string,
): Promise<string> {
  let revision = observedRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    if (!isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      if (
        commit.metadata.runId !== runId ||
        !commit.changedPathManifest.entries.some(
          (entry) => entry.path === RUN_TRANSACTION_MARKER_STATE_PATH_V1,
        )
      ) {
        throw new TypeError("初回markerを保存したcommitを一意に特定できません");
      }
      return revision;
    }
    if (commit.parent.status === "missing") {
      throw new TypeError("初回markerより前に運用通知commitの祖先がありません");
    }
    await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      commit.parent.revision,
      revision,
    );
    revision = commit.parent.revision;
  }
  throw new TypeError("初回markerの祖先探索が上限を超えています");
}

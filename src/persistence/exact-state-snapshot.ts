import {
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchHead,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";
import { migrateStateSnapshot } from "./snapshot-v23-migration.js";
import { readAiCacheMigrationPlan } from "./state-ai-cache-migration-plan.js";
import {
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseStateNotificationLedger,
  parseStateOperationsAlertLedger,
} from "./state-documents.js";
import { decodeStateFile } from "./state-file-codec.js";
import type { StateSnapshotReadResult } from "./state-persistence-session.js";

/** 指定したGit revisionのsnapshotと移行依存をそのtreeだけから読む。 */
export async function readExactStateSnapshot(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  timezone: string,
  revision: StateBranchHead,
): Promise<StateSnapshotReadResult> {
  validateStatePersistenceConfiguration(configuration);
  if (revision.status === "missing") {
    return Object.freeze({ status: "missing_branch" });
  }
  const migration = await readAiCacheMigrationPlan(adapter, configuration, revision);
  const source = decodeStateFile(
    await adapter.readFile(revision.revision, configuration.snapshotPath),
    "snapshot",
  );
  if (source == null) {
    const ledgerSource = decodeStateFile(
      await adapter.readFile(revision.revision, configuration.notificationLedgerPath),
      "notification ledger",
    );
    const operationsSource = decodeStateFile(
      await adapter.readFile(revision.revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1),
      "operations alert ledger",
    );
    if (ledgerSource == null && operationsSource == null) {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("既存state branchにnotification ledgerがありません"),
      });
    }
    const ledger = ledgerSource == null ? undefined : parseStateNotificationLedger(ledgerSource);
    const operationsLedger =
      operationsSource == null ? undefined : parseStateOperationsAlertLedger(operationsSource);
    const operationsCount =
      operationsLedger == null
        ? (ledger?.operationsAlerts.length ?? 0)
        : operationsLedger.operationsAlerts.length + operationsLedger.deliveryReservations.length;
    const paths = await adapter.listFiles(revision.revision, "state");
    if (
      (ledger?.entries.length ?? 0) === 0 &&
      (operationsCount > 0 || operationsSource != null) &&
      paths.every(
        (path) =>
          path === configuration.notificationLedgerPath ||
          path === OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
      )
    ) {
      return Object.freeze({ status: "operations_only" });
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("既存state branchにsnapshotがありません"),
    });
  }
  return Object.freeze({
    status: "available",
    snapshot: migrateStateSnapshot(source, migration.legacyEntriesByCacheKey, timezone),
  });
}

import { z } from "zod";

import {
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
  type StateFileUpdate,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";
import {
  createEmptyStateNotificationLedger,
  createStateNotificationLedger,
  createStateOperationsAlertLedger,
  NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseStateNotificationLedger,
  parseStateOperationsAlertLedger,
  serializeStateNotificationLedger,
  serializeStateOperationsAlertLedger,
  type StateNotificationLedger,
} from "./state-documents.js";
import { decodeStateFile, encodeStateFile } from "./state-file-codec.js";

/** 同じexact revisionから通常通知と運用通知を損失なく合成する。 */
export async function loadStateNotificationLedgers(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  head: StateBranchHead,
): Promise<StateNotificationLedger> {
  if (head.status === "missing") {
    return createEmptyStateNotificationLedger();
  }
  const files = await adapter.readFiles(head.revision, [
    configuration.notificationLedgerPath,
    OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  ]);
  const normalFile = files.get(configuration.notificationLedgerPath);
  const operationsFile = files.get(OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  if (normalFile == null || operationsFile == null) {
    throw new StateFormatError("notification ledger", {
      cause: new TypeError("一括読み取り結果が不足しています"),
    });
  }
  const normalSource = decodeStateFile(normalFile, "notification ledger");
  const operationsSource = decodeStateFile(operationsFile, "operations alert ledger");
  if (normalSource == null) {
    if (operationsSource == null) {
      throw new StateFormatError("notification ledger", {
        cause: new TypeError("既存state branchにnotification ledgerがありません"),
      });
    }
    return createStateNotificationLedger({
      ...createEmptyStateNotificationLedger(),
      operationsAlerts: parseStateOperationsAlertLedger(operationsSource).operationsAlerts,
    });
  }
  const normal = parseStateNotificationLedger(normalSource);
  if (operationsSource == null) {
    return normal;
  }
  if (normal.operationsAlerts.length !== 0) {
    throw new StateFormatError("notification ledger", {
      cause: new TypeError("運用障害通知ledgerが通常ledgerと専用fileで重複しています"),
    });
  }
  return createStateNotificationLedger({
    ...normal,
    operationsAlerts: parseStateOperationsAlertLedger(operationsSource).operationsAlerts,
  });
}

/** 現行の二つのledger pathへ保存する差分を作る。 */
export async function createStateLedgerUpdates(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  head: StateBranchHead,
  ledger: StateNotificationLedger,
  scope: "tracking_run" | "operations_alert" | "manual_resolution",
): Promise<readonly StateFileUpdate[]> {
  const normalFile: StateFileReadResult =
    head.status === "missing"
      ? { status: "missing" }
      : await adapter.readFile(head.revision, configuration.notificationLedgerPath);
  const normalSource = decodeStateFile(normalFile, "notification ledger");
  const legacy =
    normalSource != null &&
    z.object({ schemaVersion: z.string() }).parse(JSON.parse(normalSource)).schemaVersion !==
      NOTIFICATION_LEDGER_SCHEMA_VERSION_10;
  const current = await loadStateNotificationLedgers(adapter, configuration, head);
  const operationsFile: StateFileReadResult =
    head.status === "missing"
      ? { status: "missing" }
      : await adapter.readFile(head.revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  const operationsSource = decodeStateFile(operationsFile, "operations alert ledger");
  const currentOperationsLedger =
    operationsSource == null
      ? createStateOperationsAlertLedger({
          schemaVersion: "2",
          operationsAlerts: current.operationsAlerts,
          deliveryReservations: [],
        })
      : parseStateOperationsAlertLedger(operationsSource);
  const normal = Object.freeze({
    path: configuration.notificationLedgerPath,
    bytes: encodeStateFile(serializeStateNotificationLedger(ledger)),
  });
  const operations = Object.freeze({
    path: OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
    bytes: encodeStateFile(
      serializeStateOperationsAlertLedger(
        createStateOperationsAlertLedger({
          schemaVersion: "2",
          operationsAlerts: ledger.operationsAlerts,
          deliveryReservations: currentOperationsLedger.deliveryReservations,
        }),
      ),
    ),
  });
  if (scope === "operations_alert") {
    if (legacy) {
      throw new StateFormatError("operations alert ledger", {
        cause: new TypeError("旧形式の通常ledgerを運用障害通知commitで移行できません"),
      });
    }
    if (serializeStateNotificationLedger(current) !== serializeStateNotificationLedger(ledger)) {
      throw new StateFormatError("operations alert ledger", {
        cause: new TypeError("運用障害通知commitで通常ledgerを変更できません"),
      });
    }
    return Object.freeze([operations]);
  }
  const currentOperations = serializeStateOperationsAlertLedger(
    createStateOperationsAlertLedger({
      schemaVersion: "2",
      operationsAlerts: current.operationsAlerts,
      deliveryReservations: currentOperationsLedger.deliveryReservations,
    }),
  );
  if (currentOperations !== new TextDecoder().decode(operations.bytes)) {
    throw new StateFormatError("operations alert ledger", {
      cause: new TypeError("追跡commitで運用障害通知ledgerを変更できません"),
    });
  }
  return operationsFile.status === "missing"
    ? Object.freeze([normal, operations])
    : Object.freeze([normal]);
}

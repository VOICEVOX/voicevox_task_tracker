import { z } from "zod";

import type { OperationsAlertLedgerEntry } from "../domain/index.js";
import {
  operationsAlertBranchForStateBranch,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateBranchCommitError, StateBranchConflictError, StateFormatError } from "./errors.js";
import {
  createStateOperationsAlertLedger,
  isCanonicalStateOperationsAlertLedgerSource,
  OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1,
  OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseStateOperationsAlertLedger,
  serializeStateOperationsAlertLedger,
  type StateOperationsAlertLedger,
  type StateOperationsAlertReservation,
} from "./operations-alert-ledger.js";
import { createStateCommitOperationId } from "./state-commit-metadata.js";
import { decodeStateFile, encodeStateFile } from "./state-file-codec.js";

type OperationsAlertLedgerAtRef = Readonly<{
  head: StateBranchHead;
  ledger: StateOperationsAlertLedger;
}>;

function sameHead(left: StateBranchHead, right: StateBranchHead): boolean {
  return (
    left.status === right.status &&
    (left.status === "missing" || (right.status === "present" && left.revision === right.revision))
  );
}

/** 追跡refのcanonicalな旧ledgerを読み、専用refで通知できる状態か確認する。 */
export async function assertOperationsAlertLedgerWritable(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  head: StateBranchHead,
): Promise<void> {
  const observed = await adapter.resolveHead(configuration.branch);
  if (!sameHead(head, observed)) {
    throw new StateBranchConflictError();
  }
  if (head.status === "missing") {
    return;
  }
  const source = decodeStateFile(
    await adapter.readFile(head.revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1),
    "operations alert ledger",
  );
  if (source == null) {
    return;
  }
  const value: unknown = JSON.parse(source);
  const version = z.object({ schemaVersion: z.string() }).parse(value).schemaVersion;
  if (
    version !== OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1 &&
    version !== OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("追跡stateに旧runtimeが読めない運用通知ledgerがあります"),
    });
  }
  if (!isCanonicalStateOperationsAlertLedgerSource(source)) {
    throw new StateFormatError("operations alert ledger", {
      cause: new TypeError("追跡refの運用通知ledgerの保存byte列がcanonicalではありません"),
    });
  }
  parseStateOperationsAlertLedger(source);
}

/** 運用通知専用refのexact headからv2 ledgerを読む。 */
export async function loadOperationsAlertLedger(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
): Promise<OperationsAlertLedgerAtRef> {
  const head = await adapter.resolveHead(operationsAlertBranchForStateBranch(configuration.branch));
  if (head.status === "missing") {
    return Object.freeze({
      head,
      ledger: createStateOperationsAlertLedger({
        schemaVersion: OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2,
        operationsAlerts: [],
        deliveryReservations: [],
      }),
    });
  }
  const paths = await adapter.listFiles(head.revision, "state");
  if (paths.length !== 1 || paths[0] !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1) {
    throw new StateBranchConflictError({
      cause: new TypeError("運用通知専用refの保存pathが不正です"),
    });
  }
  const commit = await adapter.readCommit(head.revision);
  if (commit.metadata.commitScope !== "operations_alert") {
    throw new StateBranchConflictError({
      cause: new TypeError("運用通知専用refのcommit scopeが不正です"),
    });
  }
  const source = decodeStateFile(
    await adapter.readFile(head.revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1),
    "operations alert ledger",
  );
  if (source == null) {
    throw new StateFormatError("operations alert ledger", {
      cause: new TypeError("運用通知専用refにledgerがありません"),
    });
  }
  const value: unknown = JSON.parse(source);
  z.object({ schemaVersion: z.literal(OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2) }).parse(value);
  if (!isCanonicalStateOperationsAlertLedgerSource(source)) {
    throw new StateFormatError("operations alert ledger", {
      cause: new TypeError("運用通知専用refの保存byte列がcanonicalではありません"),
    });
  }
  return Object.freeze({ head, ledger: parseStateOperationsAlertLedger(source) });
}

async function commitOperationsAlertUpdate(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  alertKey: string,
  action: "reserve" | "settle" | "release",
  committedAt: string,
  update: (ledger: StateOperationsAlertLedger) => StateOperationsAlertLedger,
): Promise<StateBranchCommitResult> {
  const branch = operationsAlertBranchForStateBranch(configuration.branch);
  const atRef = await loadOperationsAlertLedger(adapter, configuration);
  if (!sameHead(atRef.head, expectedHead)) {
    throw new StateBranchConflictError();
  }
  const next = update(atRef.ledger);
  const bytes = encodeStateFile(serializeStateOperationsAlertLedger(next));
  const commitIdentity = Object.freeze({
    commitScope: "operations_alert" as const,
    operationId: createStateCommitOperationId({
      scope: "operations_alert",
      branch,
      alertKey,
      action,
    }),
  });
  const commit = await adapter.commit({
    branch,
    expectedHead,
    updates: [{ path: OPERATIONS_ALERT_LEDGER_STATE_PATH_V1, bytes }],
    deletions: [],
    message: `tracker operations alert ${action} ${alertKey}`,
    committedAt,
    commitIdentity,
  });
  const inspected = await adapter.readCommit(commit.revision);
  const paths = await adapter.listFiles(commit.revision, "state");
  const candidate = await adapter.readFile(commit.revision, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  if (
    !sameHead(inspected.parent, expectedHead) ||
    inspected.metadata.commitScope !== "operations_alert" ||
    inspected.metadata.operationId !== commitIdentity.operationId ||
    inspected.metadata.changedPathManifestDigest !== commit.metadata.changedPathManifestDigest ||
    inspected.changedPathManifest.entries.length !== 1 ||
    inspected.changedPathManifest.entries[0]?.path !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 ||
    paths.length !== 1 ||
    paths[0] !== OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 ||
    candidate.status !== "present" ||
    candidate.bytes.length !== bytes.length ||
    !candidate.bytes.every((byte, index) => byte === bytes[index])
  ) {
    throw new StateBranchCommitError({
      cause: new TypeError("運用通知専用refのcommit候補を照合できません"),
    });
  }
  try {
    await adapter.publish({ branch, revision: commit.revision });
  } catch (error: unknown) {
    const observed = await adapter.resolveHead(branch);
    if (!sameHead(observed, { status: "present", revision: commit.revision })) {
      if (!sameHead(observed, expectedHead)) {
        throw new StateBranchConflictError({ cause: error });
      }
      throw new StateBranchCommitError({ cause: error });
    }
  }
  const published = await loadOperationsAlertLedger(adapter, configuration);
  if (
    !sameHead(published.head, { status: "present", revision: commit.revision }) ||
    serializeStateOperationsAlertLedger(published.ledger) !==
      serializeStateOperationsAlertLedger(next)
  ) {
    throw new StateBranchConflictError();
  }
  return commit;
}

/** Discord HTTPより前に送信予約を運用通知専用refへCAS保存する。 */
export async function reserveOperationsAlertDelivery(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  reservation: StateOperationsAlertReservation,
): Promise<StateBranchCommitResult> {
  return commitOperationsAlertUpdate(
    adapter,
    configuration,
    expectedHead,
    reservation.alertKey,
    "reserve",
    reservation.startedAt,
    (ledger) => {
      if (
        ledger.operationsAlerts.some((entry) => entry.alertKey === reservation.alertKey) ||
        ledger.deliveryReservations.some((entry) => entry.alertKey === reservation.alertKey)
      ) {
        throw new StateBranchConflictError();
      }
      return createStateOperationsAlertLedger({
        ...ledger,
        deliveryReservations: [...ledger.deliveryReservations, reservation],
      });
    },
  );
}

/** 送信予約を同じincidentの送信済み記録へCAS確定する。 */
export async function commitOperationsAlertLedger(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  entry: OperationsAlertLedgerEntry,
): Promise<StateBranchCommitResult> {
  return commitOperationsAlertUpdate(
    adapter,
    configuration,
    expectedHead,
    entry.alertKey,
    "settle",
    entry.sentAt,
    (ledger) => {
      const reservation = ledger.deliveryReservations.find(
        (item) => item.alertKey === entry.alertKey,
      );
      if (reservation == null) {
        throw new StateBranchConflictError();
      }
      if (
        reservation.incidentId !== entry.incidentId ||
        reservation.kind !== entry.kind ||
        reservation.occurredAt !== entry.occurredAt ||
        entry.sentAt < reservation.startedAt
      ) {
        throw new StateBranchConflictError();
      }
      return createStateOperationsAlertLedger({
        ...ledger,
        operationsAlerts: [...ledger.operationsAlerts, entry],
        deliveryReservations: ledger.deliveryReservations.filter(
          (item) => item.alertKey !== entry.alertKey,
        ),
      });
    },
  );
}

/** 明確に送信されなかった通知の予約だけをCAS解除する。 */
export async function releaseOperationsAlertDelivery(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedHead: StateBranchHead,
  reservation: StateOperationsAlertReservation,
): Promise<StateBranchCommitResult> {
  return commitOperationsAlertUpdate(
    adapter,
    configuration,
    expectedHead,
    reservation.alertKey,
    "release",
    reservation.startedAt,
    (ledger) => {
      const current = ledger.deliveryReservations.find(
        (item) => item.alertKey === reservation.alertKey,
      );
      if (current == null) {
        throw new StateBranchConflictError();
      }
      if (
        current.incidentId !== reservation.incidentId ||
        current.startedAt !== reservation.startedAt
      ) {
        throw new StateBranchConflictError();
      }
      return createStateOperationsAlertLedger({
        ...ledger,
        deliveryReservations: ledger.deliveryReservations.filter(
          (item) => item.alertKey !== reservation.alertKey,
        ),
      });
    },
  );
}

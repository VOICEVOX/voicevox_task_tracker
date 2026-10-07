import { freezeJsonValue } from "../util/freeze-json-value.js";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../application/tracking-run/contracts/recovery-paths.js";
import {
  decodeInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../application/tracking-run/initial-pages-evidence-codec.js";
import {
  decodeRunTransactionMarker,
  type RunTransactionMarker,
} from "../application/tracking-run/run-transaction-marker.js";
import { hashCanonicalJson } from "../canonical-json/index.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  decodeDurablePublicationRecord,
  decodeLegacyOrCurrentDurablePublicationRecord,
  type VersionedDurablePublicationRecord,
} from "../publication/durable-record-schema.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { type StateFileReadResult, type StatePersistenceConfiguration } from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";
import type { StateSnapshot as SnapshotV21 } from "./snapshot-v21.js";
import type { StateSnapshot as SnapshotV22 } from "./snapshot-v22.js";
import type { StateSnapshot } from "./snapshot-v23.js";
import { createStateFileValidationProofs, StateFileValidation } from "./state-file-validation.js";
import {
  finalizedHistoryDigest,
  finalizedRunReportDigest,
} from "./state-transaction-finalization.js";
import {
  isCanonicalStateOperationsAlertLedgerSource,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseRunTransactionNotificationLedger,
  parseStateOperationsAlertLedger,
  type StateNotificationLedger,
} from "./state-documents.js";

const verifiedRunTransactionBrand: unique symbol = Symbol("verifiedRunTransactionFiles");

/** 一つのstate revisionで検証したrun transaction file。 */
export type VerifiedRunTransactionFiles = Readonly<{
  [verifiedRunTransactionBrand]: true;
  marker: RunTransactionMarker;
  record: VersionedDurablePublicationRecord;
  initialPagesEvidence?: InitialPagesPublicationEvidence;
  snapshotDigest: string;
  snapshotSchemaVersion: "21" | "22" | "23";
  notificationLedgerDigest: string;
  operationsAlertLedgerDigest?: string;
}>;

const transactionValues = new WeakMap<
  VerifiedRunTransactionFiles,
  Readonly<{
    snapshot: SnapshotV21 | SnapshotV22 | StateSnapshot;
    ledger: StateNotificationLedger;
  }>
>();

/** transactionと同じbyteで完全検証したsnapshotを返す。 */
export function runTransactionSnapshot(
  transaction: VerifiedRunTransactionFiles,
): SnapshotV21 | SnapshotV22 | StateSnapshot {
  const values = transactionValues.get(transaction);
  if (values == null) throw new TypeError("transactionの検証済みsnapshotがありません");
  return values.snapshot;
}

/** transactionと同じbyteで完全検証した通常ledgerを返す。 */
export function runTransactionNotificationLedger(
  transaction: VerifiedRunTransactionFiles,
): StateNotificationLedger {
  const values = transactionValues.get(transaction);
  if (values == null) throw new TypeError("transactionの検証済みledgerがありません");
  return values.ledger;
}

function retainTransactionValues(
  transaction: VerifiedRunTransactionFiles,
  snapshot: SnapshotV21 | SnapshotV22 | StateSnapshot,
  ledger: StateNotificationLedger,
): VerifiedRunTransactionFiles {
  freezeJsonValue(transaction);
  freezeJsonValue(snapshot);
  freezeJsonValue(ledger);
  transactionValues.set(transaction, { snapshot, ledger });
  return transaction;
}

function requiredFile(files: ReadonlyMap<string, StateFileReadResult>, path: string): Uint8Array {
  const file = files.get(path);
  if (file?.status !== "present") {
    throw new StateFormatError(path, { cause: new TypeError("必要なstate fileがありません") });
  }
  return file.bytes;
}

function optionalFile(
  files: ReadonlyMap<string, StateFileReadResult>,
  path: string,
): Uint8Array | undefined {
  const file = files.get(path);
  return file?.status === "present" ? file.bytes : undefined;
}

function source(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function verifyRunTransactionFilesWithLegacy(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
  fileValidation: StateFileValidation | undefined,
  allowLegacyAncestor: boolean,
): VerifiedRunTransactionFiles | undefined {
  const markerBytes = optionalFile(files, RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const recordBytes = optionalFile(files, DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  const evidenceBytes = optionalFile(files, INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1);
  if (markerBytes == null && recordBytes == null && evidenceBytes == null) {
    return undefined;
  }
  if (markerBytes == null || recordBytes == null) {
    throw new StateFormatError("run transaction", {
      cause: new TypeError("markerとrecordが同じrevisionにありません"),
    });
  }
  const validation = fileValidation ?? new StateFileValidation(createStateFileValidationProofs());
  const { snapshot, digest: snapshotDigest } = validation.snapshot(
    requiredFile(files, configuration.snapshotPath),
  );
  const snapshotVersion = snapshot.schemaVersion;
  const snapshotRunId = snapshot.run.id;
  const marker = decodeRunTransactionMarker(markerBytes);
  const record =
    snapshotVersion === "23"
      ? validation.record(recordBytes)
      : marker.phase === "run_finalized" || allowLegacyAncestor
        ? decodeLegacyOrCurrentDurablePublicationRecord(recordBytes, nodeContentDigestPort)
        : decodeDurablePublicationRecord(recordBytes, nodeContentDigestPort);
  if (
    record.runtimeRecoveryPlan.kind === "not_reproducible" &&
    record.executionPolicy.effectTarget !== "recording"
  ) {
    throw new StateFormatError("run transaction", {
      cause: new TypeError("永続stateに回復不能なruntimeを保存できません"),
    });
  }
  const ledgerSource = source(requiredFile(files, configuration.notificationLedgerPath));
  const { ledger, legacyDigestValue } = parseRunTransactionNotificationLedger(ledgerSource);
  const notificationLedgerDigest = hashCanonicalJson(
    legacyDigestValue ?? normalNotificationLedgerValue(ledger),
  );
  const operationsBytes = optionalFile(files, OPERATIONS_ALERT_LEDGER_STATE_PATH_V1);
  let operationsAlertLedgerDigest: string | undefined;
  if (operationsBytes != null) {
    const operationsSource = source(operationsBytes);
    const operationsLedger = parseStateOperationsAlertLedger(operationsSource);
    if (!isCanonicalStateOperationsAlertLedgerSource(operationsSource)) {
      throw new StateFormatError("operations alert ledger", {
        cause: new TypeError("運用通知ledgerがcanonical JSONではありません"),
      });
    }
    operationsAlertLedgerDigest = hashCanonicalJson(operationsLedger);
  }
  if (
    marker.runId !== record.runIdentity.runId ||
    marker.runId !== snapshotRunId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    marker.baseStateRevision !==
      (record.baseStateRevision.status === "missing"
        ? "unborn"
        : record.baseStateRevision.revision) ||
    marker.publicationRecordDigest !== record.recordDigest ||
    marker.snapshotDigest !== snapshotDigest ||
    marker.notificationLedgerDigest !== notificationLedgerDigest ||
    (marker.phase === "initial_state_committed" &&
      (record.initialStateContentDigests.snapshot !== snapshotDigest ||
        record.initialStateContentDigests.notificationLedger !== notificationLedgerDigest))
  ) {
    throw new StateFormatError("run transaction", {
      cause: new TypeError("marker、record、snapshot、通常ledgerのdigestが一致しません"),
    });
  }
  if (marker.phase === "run_finalized") {
    finalizedHistoryDigest(files, configuration, marker, record, fileValidation);
    finalizedRunReportDigest(files, configuration, marker, record);
  }
  if (marker.phase === "initial_state_committed") {
    if (evidenceBytes != null) {
      throw new StateFormatError("initial Pages evidence", {
        cause: new TypeError("初回commitへPages証拠を保存できません"),
      });
    }
    return retainTransactionValues(
      Object.freeze({
        [verifiedRunTransactionBrand]: true,
        marker,
        record,
        snapshotDigest,
        snapshotSchemaVersion: snapshotVersion,
        notificationLedgerDigest,
        ...(operationsAlertLedgerDigest == null ? {} : { operationsAlertLedgerDigest }),
      } satisfies VerifiedRunTransactionFiles),
      snapshot,
      ledger,
    );
  }
  if (evidenceBytes == null) {
    throw new StateFormatError("initial Pages evidence", {
      cause: new TypeError("通知開始後にPages証拠がありません"),
    });
  }
  const initialPagesEvidence = decodeInitialPagesPublicationEvidence(
    evidenceBytes,
    nodeContentDigestPort,
  );
  if (
    initialPagesEvidence.runId !== marker.runId ||
    initialPagesEvidence.checkpointDigest !== marker.checkpointDigest ||
    initialPagesEvidence.sourceStateRevision !== marker.initialStateRevision ||
    initialPagesEvidence.evidenceDigest !== marker.initialPagesPublicationEvidenceDigest
  ) {
    throw new StateFormatError("initial Pages evidence", {
      cause: new TypeError("markerとPages証拠が一致しません"),
    });
  }
  return retainTransactionValues(
    Object.freeze({
      [verifiedRunTransactionBrand]: true,
      marker,
      record,
      initialPagesEvidence,
      snapshotDigest,
      snapshotSchemaVersion: snapshotVersion,
      notificationLedgerDigest,
      ...(operationsAlertLedgerDigest == null ? {} : { operationsAlertLedgerDigest }),
    } satisfies VerifiedRunTransactionFiles),
    snapshot,
    ledger,
  );
}

/** 完了済み旧runの祖先に限り旧record形式を検証する。 */
export function verifyLegacyCompletedRunTransactionAncestor(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
  fileValidation: StateFileValidation,
): VerifiedRunTransactionFiles | undefined {
  return verifyRunTransactionFilesWithLegacy(files, configuration, fileValidation, true);
}

/** marker、record、snapshot、通常ledger、Pages証拠を同じtreeで照合する。 */
export function verifyRunTransactionFiles(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
  fileValidation?: StateFileValidation,
): VerifiedRunTransactionFiles | undefined {
  return verifyRunTransactionFilesWithLegacy(files, configuration, fileValidation, false);
}

/** 新しいstate候補のsnapshotが現行形式であることを検証する。 */
export function verifyCurrentRunTransactionFiles(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
  validation?: StateFileValidation,
): VerifiedRunTransactionFiles {
  const verified = verifyRunTransactionFiles(files, configuration, validation);
  if (verified?.snapshotSchemaVersion !== "23") {
    throw new StateFormatError("snapshot", {
      cause: new TypeError("新しいtracking state候補にはv23のrun transactionが必要です"),
    });
  }
  return verified;
}

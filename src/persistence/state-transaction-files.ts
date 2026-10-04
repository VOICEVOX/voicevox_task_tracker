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
import { z } from "zod";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  decodeDurablePublicationRecord,
  type DurablePublicationRecord,
} from "../publication/durable-record-schema.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { type StateFileReadResult, type StatePersistenceConfiguration } from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";
import {
  parseStateSnapshot as parseStateSnapshotV21,
  serializeStateSnapshot as serializeStateSnapshotV21,
} from "./snapshot-v21.js";
import {
  parseStateSnapshot as parseStateSnapshotV22,
  serializeStateSnapshot as serializeStateSnapshotV22,
} from "./snapshot-v22.js";
import { parseStateSnapshot, serializeStateSnapshot } from "./snapshot-v23.js";
import {
  finalizedHistoryDigest,
  finalizedRunReportDigest,
} from "./state-transaction-finalization.js";
import {
  isCanonicalStateOperationsAlertLedgerSource,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseRunTransactionNotificationLedger,
  parseStateOperationsAlertLedger,
} from "./state-documents.js";

/** 一つのstate revisionで検証したrun transaction file。 */
export type VerifiedRunTransactionFiles = Readonly<{
  marker: RunTransactionMarker;
  record: DurablePublicationRecord;
  initialPagesEvidence?: InitialPagesPublicationEvidence;
  snapshotDigest: string;
  snapshotSchemaVersion: "21" | "22" | "23";
  notificationLedgerDigest: string;
  operationsAlertLedgerDigest?: string;
}>;

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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** marker、record、snapshot、通常ledger、Pages証拠を同じtreeで照合する。 */
export function verifyRunTransactionFiles(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
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
  const marker = decodeRunTransactionMarker(markerBytes);
  const record = decodeDurablePublicationRecord(recordBytes, nodeContentDigestPort);
  if (
    record.runtimeRecoveryPlan.kind === "not_reproducible" &&
    record.executionPolicy.effectTarget !== "recording"
  ) {
    throw new StateFormatError("run transaction", {
      cause: new TypeError("永続stateに回復不能なruntimeを保存できません"),
    });
  }
  const snapshotSource = source(requiredFile(files, configuration.snapshotPath));
  const snapshotValue: unknown = JSON.parse(snapshotSource);
  const snapshotVersion = z
    .object({ schemaVersion: z.string() })
    .parse(snapshotValue).schemaVersion;
  let snapshotDigest: string;
  let snapshotRunId: string;
  if (snapshotVersion === "21") {
    const snapshot = parseStateSnapshotV21(snapshotSource);
    if (snapshotSource !== serializeStateSnapshotV21(snapshot)) {
      throw new StateFormatError("snapshot", {
        cause: new TypeError("旧snapshotがcanonical JSONではありません"),
      });
    }
    snapshotDigest = hashCanonicalJson(snapshot);
    snapshotRunId = snapshot.run.id;
  } else if (snapshotVersion === "22") {
    const snapshot = parseStateSnapshotV22(snapshotSource);
    if (snapshotSource !== serializeStateSnapshotV22(snapshot)) {
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotがcanonical JSONではありません"),
      });
    }
    snapshotDigest = hashCanonicalJson(snapshot);
    snapshotRunId = snapshot.run.id;
  } else if (snapshotVersion === "23") {
    const snapshot = parseStateSnapshot(snapshotSource);
    if (snapshotSource !== serializeStateSnapshot(snapshot)) {
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotがcanonical JSONではありません"),
      });
    }
    snapshotDigest = hashCanonicalJson(snapshot);
    snapshotRunId = snapshot.run.id;
  } else {
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshotのschemaVersionは未対応です"),
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
    finalizedHistoryDigest(files, configuration, marker, record);
    finalizedRunReportDigest(files, configuration, marker, record);
  }
  if (marker.phase === "initial_state_committed") {
    if (evidenceBytes != null) {
      throw new StateFormatError("initial Pages evidence", {
        cause: new TypeError("初回commitへPages証拠を保存できません"),
      });
    }
    return Object.freeze({
      marker,
      record,
      snapshotDigest,
      snapshotSchemaVersion: snapshotVersion,
      notificationLedgerDigest,
      ...(operationsAlertLedgerDigest == null ? {} : { operationsAlertLedgerDigest }),
    });
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
  return Object.freeze({
    marker,
    record,
    initialPagesEvidence,
    snapshotDigest,
    snapshotSchemaVersion: snapshotVersion,
    notificationLedgerDigest,
    ...(operationsAlertLedgerDigest == null ? {} : { operationsAlertLedgerDigest }),
  });
}

/** 新しいstate候補のsnapshotが現行形式であることを検証する。 */
export function verifyCurrentRunTransactionFiles(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
): VerifiedRunTransactionFiles {
  const verified = verifyRunTransactionFiles(files, configuration);
  if (verified?.snapshotSchemaVersion !== "23") {
    throw new StateFormatError("snapshot", {
      cause: new TypeError("新しいtracking state候補にはv23のrun transactionが必要です"),
    });
  }
  return verified;
}

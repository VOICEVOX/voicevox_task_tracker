import { hashCanonicalJson } from "../../canonical-json/index.js";
import { canonicalJsonEquals } from "../../canonical-json/value.js";
import { createStateSnapshot, type StateSnapshot } from "../../persistence/snapshot-v23.js";
import type { StateRunReport } from "../../persistence/state-run-report.js";
import { deriveFinalRunValues } from "../../persistence/state-finalization-values.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import type { NotificationMessageState } from "./notification-message-state.js";

/** settlement済みstateと保存済み規則だけから最終reportとsnapshotを作る。 */
export function finalRunValues(
  record: DurablePublicationRecord,
  settled: NotificationMessageState,
  finishedAt: string,
): Readonly<{ report: StateRunReport; snapshot: StateSnapshot; notificationCount: number }> {
  if (
    settled.transaction.marker.phase !== "notifications_settled" ||
    settled.transaction.record.recordDigest !== record.recordDigest ||
    settled.transaction.initialPagesEvidence == null
  ) {
    throw new TypeError("run finalizationのsettlement stateが一致しません");
  }
  const values = deriveFinalRunValues(record, settled.snapshot, settled.ledger, finishedAt);
  return Object.freeze({
    report: values.report,
    snapshot: createStateSnapshot({ ...settled.snapshot, trackingStartAt: values.trackingStartAt }),
    notificationCount: values.notificationCount,
  });
}

/** 最終stateがsettlement正本から作られた値と一致することを確かめる。 */
export function assertFinalRunValues(
  record: DurablePublicationRecord,
  settled: NotificationMessageState,
  finalized: NotificationMessageState,
  report: StateRunReport,
): void {
  const expected = deriveFinalRunValues(
    record,
    settled.snapshot,
    settled.ledger,
    report.finishedAt,
  );
  const expectedSnapshot = { ...settled.snapshot, trackingStartAt: expected.trackingStartAt };
  if (
    finalized.transaction.marker.phase !== "run_finalized" ||
    finalized.transaction.record.recordDigest !== record.recordDigest ||
    finalized.transaction.marker.finalRunReportDigest !== hashCanonicalJson(report) ||
    finalized.transaction.notificationLedgerDigest !==
      settled.transaction.notificationLedgerDigest ||
    !canonicalJsonEquals(finalized.snapshot, expectedSnapshot) ||
    !canonicalJsonEquals(finalized.ledger.entries, settled.ledger.entries) ||
    !canonicalJsonEquals(
      finalized.ledger.pendingNotifications,
      settled.ledger.pendingNotifications,
    ) ||
    !canonicalJsonEquals(
      finalized.transaction.initialPagesEvidence,
      settled.transaction.initialPagesEvidence,
    ) ||
    !canonicalJsonEquals(report, expected.report)
  ) {
    throw new TypeError("run finalizationのreport、ledgerまたはsnapshotがsettlementと一致しません");
  }
}

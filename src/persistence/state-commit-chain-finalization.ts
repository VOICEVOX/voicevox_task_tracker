import { canonicalJsonEquals, serializeCanonicalJson } from "../canonical-json/value.js";
import type { StatePersistenceConfiguration } from "./branch-adapter.js";
import { joinStatePath } from "./branch-adapter.js";
import { runTransactionSnapshot } from "./state-transaction-files.js";
import { parseRunTransactionNotificationLedger } from "./state-documents.js";
import { advanceFinalizationMarker, deriveFinalRunValues } from "./state-finalization-values.js";
import { createStateRunReport, serializeStateRunReport } from "./state-run-report.js";
import type { VerifiedCommitTree } from "./state-commit-chain-paths.js";

function source(tree: VerifiedCommitTree, path: string): string {
  const file = tree.files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`Git祖先の最終値に必要なstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

/** settlementのexact値から最終snapshot、report、markerを再導出して照合する。 */
export function assertFinalizationTransition(
  settled: VerifiedCommitTree,
  finalized: VerifiedCommitTree,
  configuration: StatePersistenceConfiguration,
): void {
  if (
    settled.transaction.marker.phase !== "notifications_settled" ||
    finalized.transaction.marker.phase !== "run_finalized" ||
    settled.transaction.record.recordDigest !== finalized.transaction.record.recordDigest ||
    settled.transaction.snapshotSchemaVersion !== finalized.transaction.snapshotSchemaVersion ||
    settled.transaction.initialPagesEvidence == null
  ) {
    throw new TypeError("run finalizationの親stateがsettlementと一致しません");
  }
  const record = settled.transaction.record;
  const reportPath = joinStatePath(
    configuration.runReportsDirectory,
    `${record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
  );
  const reportSource = source(finalized, reportPath);
  const report = createStateRunReport(JSON.parse(reportSource));
  const ledger = parseRunTransactionNotificationLedger(
    source(settled, configuration.notificationLedgerPath),
  ).ledger;
  const parentSnapshot = runTransactionSnapshot(settled.transaction);
  const actualSnapshot = runTransactionSnapshot(finalized.transaction);
  const expected = deriveFinalRunValues(record, parentSnapshot, ledger, report.finishedAt);
  const expectedSnapshot = { ...parentSnapshot, trackingStartAt: expected.trackingStartAt };
  if (!canonicalJsonEquals(actualSnapshot, expectedSnapshot)) {
    throw new TypeError("run finalizationのsnapshotがsettlementから導出した値と一致しません");
  }
  const expectedMarker = advanceFinalizationMarker(
    settled.transaction.marker,
    finalized.transaction.snapshotDigest,
    expected.report,
    finalized.transaction.marker.expectedParentStateRevision,
  );
  if (
    reportSource !== serializeStateRunReport(expected.report) ||
    serializeCanonicalJson(report) !== serializeCanonicalJson(expected.report) ||
    serializeCanonicalJson(finalized.transaction.marker) !== serializeCanonicalJson(expectedMarker)
  ) {
    throw new TypeError("run finalizationのsnapshot、reportまたはmarkerがsettlementと一致しません");
  }
}

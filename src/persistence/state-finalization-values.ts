import {
  parseRunTransactionMarker,
  type RunTransactionMarker,
} from "../application/tracking-run/run-transaction-marker.js";
import { hashCanonicalJson } from "../canonical-json/index.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { createUtcIsoDateTime, resolveTrackingStartAt } from "../domain/index.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";
import type { StateSnapshot } from "./snapshot-v23.js";
import type { StateNotificationLedger } from "./state-documents.js";
import { createStateRunReport, type StateRunReport } from "./state-run-report.js";

/** 固定run、settlementの値、終了時刻から最終reportと追跡開始時刻を導出する。 */
export function deriveFinalRunValues(
  record: DurablePublicationRecord,
  snapshot: Pick<StateSnapshot, "run" | "trackingStartAt">,
  ledger: Pick<StateNotificationLedger, "entries">,
  finishedAt: string,
): Readonly<{
  report: StateRunReport;
  trackingStartAt: StateSnapshot["trackingStartAt"];
  notificationCount: number;
}> {
  const policy = record.runFinalizationPolicy;
  if (
    snapshot.run.id !== policy.report.runId ||
    snapshot.run.status !== policy.report.status ||
    ledger.entries.some((entry) => entry.status === "delivery_started") ||
    serializeCanonicalJson(policy.completeSuccessRequires) !==
      serializeCanonicalJson(["initial_pages_deployed", "notifications_settled"])
  ) {
    throw new TypeError("run finalizationの保存済み規則とsettlement stateが一致しません");
  }
  const completedAt = createUtcIsoDateTime(finishedAt);
  const trackingStartAt = resolveTrackingStartAt({
    configuredStartAt: policy.configuredTrackingStartAt,
    previousState: snapshot.trackingStartAt,
    run: { outcome: "complete_success", finishedAt: completedAt },
  });
  if (trackingStartAt.status !== "fixed") {
    throw new TypeError("完了済みrunのtracking.startAtを確定できません");
  }
  const entries = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  const selectedKeys =
    record.notificationOutbox.action === "send" &&
    record.notificationOutbox.selectedContext.action === "create_digest"
      ? new Set(
          record.notificationOutbox.selectedContext.candidates.flatMap((candidate) =>
            candidate.reasons.map((reason) => reason.notificationKey),
          ),
        )
      : new Set<string>();
  const notificationCount = [...selectedKeys].filter(
    (key) => entries.get(key)?.status === "sent",
  ).length;
  const report = createStateRunReport({
    schemaVersion: "3",
    runId: policy.report.runId,
    date: policy.report.startedAt.slice(0, 10),
    status: policy.report.status,
    complete: true,
    scheduledFor: policy.report.scheduledFor,
    startedAt: policy.report.startedAt,
    finishedAt: completedAt,
    metrics: {
      ...policy.report.metrics,
      notificationCount,
      durationMilliseconds: Date.parse(completedAt) - Date.parse(policy.report.startedAt),
    },
    diagnostics: policy.report.diagnostics,
  });
  return Object.freeze({ report, trackingStartAt, notificationCount });
}

/** settlement markerと最終snapshot digest、reportからfinalization markerを作る。 */
export function advanceFinalizationMarker(
  previous: RunTransactionMarker,
  snapshotDigest: string,
  report: StateRunReport,
  parentRevision: string,
): RunTransactionMarker {
  if (previous.phase !== "notifications_settled") {
    throw new TypeError("run finalizationの親markerがsettlementではありません");
  }
  return parseRunTransactionMarker({
    ...previous,
    phase: "run_finalized",
    phaseSequence: previous.phaseSequence + 1,
    expectedParentStateRevision: parentRevision,
    snapshotDigest,
    finalRunReportDigest: hashCanonicalJson(report),
  });
}

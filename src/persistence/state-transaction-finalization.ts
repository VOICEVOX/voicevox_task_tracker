import { hashCanonicalJson } from "../canonical-json/index.js";
import type { RunTransactionMarker } from "../application/tracking-run/run-transaction-marker.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";
import {
  joinStatePath,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { parseStateHistoryRecords, serializeStateHistoryRecords } from "./history.js";
import { createStateRunReport, serializeStateRunReport } from "./state-run-report.js";

function requiredSource(files: ReadonlyMap<string, StateFileReadResult>, path: string): string {
  const file = files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`完了済みrunのstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

/** 完了済みrunの一意な日次履歴recordを正規fileから検証する。 */
export function finalizedHistoryDigest(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
  marker: RunTransactionMarker,
  record: DurablePublicationRecord,
): string {
  const date = record.initialPagesProjection.generatedAt.slice(0, 10);
  const path = joinStatePath(configuration.historyDirectory, `${date}.jsonl`);
  const source = requiredSource(files, path);
  const records = parseStateHistoryRecords(source);
  if (serializeStateHistoryRecords(records) !== source) {
    throw new TypeError("通知履歴のstate fileがcanonical JSON Linesではありません");
  }
  const matching = records.filter((entry) => entry.runId === marker.runId);
  if (matching.length !== 1 || matching[0]?.date !== date) {
    throw new TypeError("通知履歴のrun recordを一意に特定できません");
  }
  for (const [otherPath, file] of files) {
    if (
      otherPath === path ||
      !otherPath.startsWith(`${configuration.historyDirectory}/`) ||
      file.status !== "present"
    ) {
      continue;
    }
    const other = parseStateHistoryRecords(
      new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
    );
    if (other.some((entry) => entry.runId === marker.runId)) {
      throw new TypeError("完了済みrunの履歴recordが複数fileにあります");
    }
  }
  return hashCanonicalJson(matching[0]);
}

/** 完了済みrun reportの正規fileとmarker digestを照合する。 */
export function finalizedRunReportDigest(
  files: ReadonlyMap<string, StateFileReadResult>,
  configuration: StatePersistenceConfiguration,
  marker: RunTransactionMarker,
  record: DurablePublicationRecord,
): string {
  if (marker.phase !== "run_finalized") {
    throw new TypeError("完了済みrun reportにはfinalized markerが必要です");
  }
  const date = record.runFinalizationPolicy.report.startedAt.slice(0, 10);
  const path = joinStatePath(configuration.runReportsDirectory, `${date}.json`);
  const source = requiredSource(files, path);
  const value: unknown = JSON.parse(source);
  const report = createStateRunReport(value);
  const digest = hashCanonicalJson(report);
  if (
    serializeStateRunReport(report) !== source ||
    report.runId !== marker.runId ||
    report.date !== date ||
    report.scheduledFor !== record.runFinalizationPolicy.report.scheduledFor ||
    report.startedAt !== record.runFinalizationPolicy.report.startedAt ||
    report.status !== record.runFinalizationPolicy.report.status ||
    marker.finalRunReportDigest !== digest
  ) {
    throw new TypeError("最終run reportとmarker、recordの値が一致しません");
  }
  return digest;
}

import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { HistoricalEvidenceRecord } from "../contracts/evidence-catalog.js";
import type { AnalysisPreviousState } from "../contracts/previous-state.js";

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 前回snapshotのitemとrelationから保存済みEvidenceを位置ごとに取得する。 */
export function collectPreviousHistoricalEvidence(
  snapshot: AnalysisPreviousState["snapshot"],
): readonly HistoricalEvidenceRecord[] {
  if (snapshot.status !== "available") return Object.freeze([]);
  const records: HistoricalEvidenceRecord[] = [];
  for (const [itemIndex, item] of snapshot.trackedItems.entries()) {
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      records.push(
        Object.freeze({
          status: "historical",
          location: Object.freeze({
            container: "previous_snapshot",
            path: Object.freeze(["trackedItems", itemIndex, "evidence", evidenceIndex]),
          }),
          evidence,
        }),
      );
    }
  }
  for (const [relationIndex, relation] of snapshot.relations.entries()) {
    for (const [evidenceIndex, evidence] of relation.evidence.entries()) {
      records.push(
        Object.freeze({
          status: "historical",
          location: Object.freeze({
            container: "previous_snapshot",
            path: Object.freeze(["relations", relationIndex, "evidence", evidenceIndex]),
          }),
          evidence,
        }),
      );
    }
  }
  return Object.freeze(
    records.sort((left, right) =>
      compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)),
    ),
  );
}

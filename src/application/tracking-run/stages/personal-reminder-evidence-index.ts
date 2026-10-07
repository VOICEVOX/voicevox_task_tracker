import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Evidence, SourceId } from "../../../domain/index.js";
import { assertNonNullable } from "../../../util/index.js";

/** 根拠recordの完全一致だけを除きsource IDごとに索引化する。 */
export function indexPersonalReminderEvidence(
  groups: readonly (readonly Evidence[])[],
): ReadonlyMap<SourceId, readonly Evidence[]> {
  const bySourceId = new Map<SourceId, Map<string, Evidence>>();
  for (const group of groups) {
    for (const evidence of group) {
      const identity = serializeCanonicalJson(evidence);
      const records = bySourceId.get(evidence.sourceId) ?? new Map<string, Evidence>();
      records.set(identity, evidence);
      bySourceId.set(evidence.sourceId, records);
    }
  }
  const index = new Map<SourceId, readonly Evidence[]>();
  for (const sourceId of [...bySourceId.keys()].sort()) {
    const records = bySourceId.get(sourceId);
    assertNonNullable(records, `個人催促根拠のsource索引がありません。対象: ${sourceId}`);
    index.set(
      sourceId,
      Object.freeze(
        [...records.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value),
      ),
    );
  }
  return index;
}

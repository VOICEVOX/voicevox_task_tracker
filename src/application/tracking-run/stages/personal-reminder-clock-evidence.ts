import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { PersonalReminderTimeBasis } from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, NormalizedEvent, UtcIsoDateTime } from "../../../domain/types.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import {
  createPersonalReminderClockEventSources,
  type PersonalReminderClockEventSource,
} from "./personal-reminder-clock-sources.js";
import {
  collectCurrentSourceFacts,
  type CurrentSourceRecords,
} from "./evidence-catalog-source-facts.js";
import { RunCompletenessError } from "./run-completeness-error.js";

/** 今回の詳細と正規化イベントを照合する時刻根拠の索引。 */
export type CurrentClockEvidenceSources = Readonly<{
  factsBySourceId: ReadonlyMap<SourceId, readonly CurrentSourceFact[]>;
  eventsBySourceId: ReadonlyMap<SourceId, NormalizedEvent>;
  clockEventsBySourceId: ReadonlyMap<SourceId, PersonalReminderClockEventSource>;
}>;

/** 今回の収集recordから時刻根拠の検証に使うsourceを索引化する。 */
export function indexCurrentClockEvidenceSources(
  records: CurrentSourceRecords,
  evaluatedAt: UtcIsoDateTime,
): CurrentClockEvidenceSources {
  const factsBySourceId = new Map<SourceId, CurrentSourceFact[]>();
  let facts: readonly CurrentSourceFact[];
  try {
    facts = collectCurrentSourceFacts(records);
  } catch (error: unknown) {
    throw new RunCompletenessError(
      "source_id_conflict",
      "current_source_facts",
      ["sourceRecords"],
      undefined,
      error,
    );
  }
  for (const fact of facts) {
    const facts = factsBySourceId.get(fact.sourceId) ?? [];
    facts.push(fact);
    factsBySourceId.set(fact.sourceId, facts);
  }
  const eventsBySourceId = new Map<SourceId, NormalizedEvent>();
  for (const item of records.observedItems) {
    for (const event of item.events) {
      const previous = eventsBySourceId.get(event.sourceId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(event)) {
        throw new RunCompletenessError(
          "source_id_conflict",
          event.sourceId,
          ["sourceRecords", "observedItems"],
          undefined,
        );
      }
      eventsBySourceId.set(event.sourceId, event);
    }
  }
  const detailsByNodeId = new Map(records.details.map((detail) => [detail.nodeId, detail]));
  const contexts = records.observedItems.map((item) => {
    const detail = detailsByNodeId.get(item.nodeId);
    if (detail == null) {
      throw new RunCompletenessError(
        "missing_source",
        item.sourceId,
        ["sourceRecords", "details", item.nodeId],
        undefined,
      );
    }
    return Object.freeze({ item, detail });
  });
  const clockEventsBySourceId = createPersonalReminderClockEventSources(contexts, evaluatedAt);
  return Object.freeze({ factsBySourceId, eventsBySourceId, clockEventsBySourceId });
}

/** 現行Eventまたはreview requestで確認した時刻だけからEvidenceを作る。 */
export function verifiedCurrentClockEvidence(
  sourceId: SourceId,
  basis: Extract<PersonalReminderTimeBasis, { source: "event" }>,
  allowedOwnerNodeIds: ReadonlySet<string>,
  evaluatedAt: UtcIsoDateTime,
  sources: CurrentClockEvidenceSources,
): Evidence | undefined {
  const path = ["personalReminderCauses", "clock", sourceId];
  const facts = sources.factsBySourceId.get(sourceId) ?? [];
  if (facts.length === 0) return undefined;
  const event = sources.eventsBySourceId.get(sourceId);
  const clockEvent = sources.clockEventsBySourceId.get(sourceId);
  if (clockEvent == null) {
    throw new RunCompletenessError("kind_mismatch", sourceId, path, undefined);
  }
  const detailFacts = facts.filter(
    (fact) => fact.origin === "item_detail" && fact.scope === "item",
  );
  if (
    detailFacts.length === 0 ||
    (event == null && detailFacts.some((fact) => fact.sourceKind !== "github_review_request"))
  ) {
    throw new RunCompletenessError("kind_mismatch", sourceId, path, undefined);
  }
  if (event == null && detailFacts.some((fact) => fact.immutable.occurredAt == null)) {
    throw new RunCompletenessError("missing_source", sourceId, path, undefined);
  }
  if (
    event != null &&
    !facts.some((fact) => fact.origin === "normalized_item" && fact.scope === "item")
  ) {
    throw new RunCompletenessError("kind_mismatch", sourceId, path, undefined);
  }
  if (basis.at > evaluatedAt) {
    throw new RunCompletenessError("future_source", sourceId, path, undefined);
  }
  for (const fact of facts) {
    if (fact.scope !== "item" || !allowedOwnerNodeIds.has(fact.itemNodeId)) {
      throw new RunCompletenessError("wrong_owner", sourceId, path, undefined);
    }
    if (fact.immutable.occurredAt != null && fact.immutable.occurredAt !== basis.at) {
      throw new RunCompletenessError("source_id_conflict", sourceId, path, undefined);
    }
  }
  if (
    event != null &&
    (event.occurredAt !== basis.at || !allowedOwnerNodeIds.has(event.itemNodeId))
  ) {
    throw new RunCompletenessError("source_id_conflict", sourceId, path, undefined);
  }
  if (clockEvent.occurredAt !== basis.at) {
    throw new RunCompletenessError("source_id_conflict", sourceId, path, undefined);
  }
  if (!allowedOwnerNodeIds.has(clockEvent.itemNodeId)) {
    throw new RunCompletenessError("wrong_owner", sourceId, path, undefined);
  }
  return Object.freeze({
    sourceId,
    supports: "status",
    summary: "個人催促の時刻起点となるGitHub上の活動です",
  });
}

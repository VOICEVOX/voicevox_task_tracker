import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Evidence } from "../../../domain/types.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import type { CurrentSourceFact, EvidenceUseScope } from "../contracts/evidence-catalog.js";
import type {
  EvidenceClosureContext,
  EvidenceClosureOutward,
  EvidenceClosureResult,
  EvidenceUse,
  OwnedHistoricalEvidence,
  ResolvedEvidenceUse,
} from "../contracts/evidence-closure.js";
import { EvidenceCatalog } from "./evidence-catalog.js";
import { aiResultSlotForUse, collectAiResultSlots } from "./evidence-ai-results.js";
import { collectAdoptionAiResultSlots, createAiResultOrigins } from "./evidence-ai-provenance.js";
import { collectCurrentSourceFacts } from "./evidence-catalog-source-facts.js";
import { resolveEvidenceUse } from "./evidence-closure-resolve.js";
import { assertEvidenceClosureInput } from "./evidence-closure-validation.js";
import { walkOutwardEvidenceUses } from "./evidence-closure-walk-outward.js";
import { RunCompletenessError } from "./run-completeness-error.js";

/** Task15の次に確定する履歴、cache、通知参照。 */
export type EvidenceClosureAdditions = Pick<
  EvidenceClosureOutward,
  | "historyInputEvents"
  | "aiCacheAdditions"
  | "personalReminderAiCacheAdditions"
  | "notificationCauses"
  | "pendingNotifications"
>;

function canonicalSort<Value>(values: readonly Value[]): readonly Value[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      const a = serializeCanonicalJson(left);
      const b = serializeCanonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}

function canonicalOutward(value: EvidenceClosureOutward): EvidenceClosureOutward {
  return Object.freeze({
    items: canonicalSort(value.items),
    collectionAiItems: canonicalSort(value.collectionAiItems),
    relations: canonicalSort(value.relations),
    aiItems: canonicalSort(value.aiItems),
    historyInputEvents: canonicalSort(value.historyInputEvents),
    aiCacheAdditions: canonicalSort(value.aiCacheAdditions),
    personalReminderAiCacheAdditions: canonicalSort(value.personalReminderAiCacheAdditions),
    notificationCauses: canonicalSort(value.notificationCauses),
    pendingNotifications: canonicalSort(value.pendingNotifications),
  });
}

function sourceFactsById(
  facts: readonly CurrentSourceFact[],
): ReadonlyMap<string, readonly CurrentSourceFact[]> {
  const byId = new Map<string, CurrentSourceFact[]>();
  for (const fact of facts) {
    const records = byId.get(fact.sourceId) ?? [];
    records.push(fact);
    byId.set(fact.sourceId, records);
  }
  return new Map([...byId].map(([id, records]) => [id, canonicalSort(records)]));
}

function historicalById(
  historical: readonly OwnedHistoricalEvidence[],
): ReadonlyMap<string, readonly OwnedHistoricalEvidence[]> {
  const byId = new Map<string, OwnedHistoricalEvidence[]>();
  for (const value of historical) {
    const sourceId = value.record.evidence.sourceId;
    const records = byId.get(sourceId) ?? [];
    records.push(value);
    byId.set(sourceId, records);
  }
  return new Map([...byId].map(([id, records]) => [id, canonicalSort(records)]));
}

function appendEvidence(
  existing: readonly Evidence[],
  additions: readonly Evidence[],
): readonly Evidence[] {
  const records = new Map<string, Evidence>();
  for (const evidence of [...existing, ...additions]) {
    records.set(serializeCanonicalJson(evidence), evidence);
  }
  return canonicalSort([...records.values()]);
}

function evidenceAdditions(
  use: EvidenceUse,
  records: readonly OwnedHistoricalEvidence[],
  outward: EvidenceClosureOutward,
): readonly Evidence[] {
  if (records.length === 0) {
    const destination = use.destination;
    if (
      destination.kind === "item" &&
      !outward.items.some((entry) => entry.item.nodeId === destination.itemNodeId) &&
      !(
        use.path[0] === "collectionAiItems" &&
        outward.collectionAiItems.some((item) => item.nodeId === destination.itemNodeId)
      )
    ) {
      throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
    }
    return Object.freeze([]);
  }
  if (use.destination.kind === "item") {
    const itemNodeId = use.destination.itemNodeId;
    const item = outward.items.find((entry) => entry.item.nodeId === itemNodeId);
    if (item == null) {
      throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
    }
    const existing = new Set([...item.item.evidence, ...item.evidence].map(serializeCanonicalJson));
    return Object.freeze(
      records
        .map((record) => record.record.evidence)
        .filter((evidence) => !existing.has(serializeCanonicalJson(evidence))),
    );
  }
  const relationId = use.destination.relationId;
  const relation = outward.relations.find((entry) => entry.id === relationId);
  if (relation == null) return Object.freeze([]);
  const existing = new Set(relation.evidence.map(serializeCanonicalJson));
  return Object.freeze(
    records
      .map((record) => record.record.evidence)
      .filter((evidence) => !existing.has(serializeCanonicalJson(evidence))),
  );
}

function applyAdditions(
  outward: EvidenceClosureOutward,
  additions: readonly Readonly<{ destination: EvidenceUse["destination"]; evidence: Evidence }>[],
): EvidenceClosureOutward {
  const byItem = new Map<string, Evidence[]>();
  const byRelation = new Map<string, Evidence[]>();
  for (const addition of additions) {
    if (addition.destination.kind === "item") {
      const records = byItem.get(addition.destination.itemNodeId) ?? [];
      records.push(addition.evidence);
      byItem.set(addition.destination.itemNodeId, records);
    } else {
      const records = byRelation.get(addition.destination.relationId) ?? [];
      records.push(addition.evidence);
      byRelation.set(addition.destination.relationId, records);
    }
  }
  return canonicalOutward(
    Object.freeze({
      ...outward,
      items: Object.freeze(
        outward.items.map((entry) => {
          const records = byItem.get(entry.item.nodeId) ?? [];
          return records.length === 0
            ? entry
            : Object.freeze({
                ...entry,
                evidence: appendEvidence(entry.evidence, records),
              });
        }),
      ),
      relations: Object.freeze(
        outward.relations.map((relation) => {
          const records = byRelation.get(relation.id) ?? [];
          return records.length === 0
            ? relation
            : Object.freeze({
                ...relation,
                evidence: appendEvidence(relation.evidence, records),
              });
        }),
      ),
    }),
  );
}

function registerAnnotations(catalog: EvidenceCatalog, outward: EvidenceClosureOutward): void {
  for (const entry of outward.items) {
    for (const evidence of [...entry.item.evidence, ...entry.evidence]) {
      const scope: EvidenceUseScope = Object.freeze({
        kind: "tracked_item",
        id: entry.item.nodeId,
      });
      catalog.addAnnotation({ scope, evidence });
      catalog.addRole(evidence.sourceId, scope, evidence.supports);
    }
  }
  for (const relation of outward.relations) {
    for (const evidence of relation.evidence) {
      const scope: EvidenceUseScope = Object.freeze({ kind: "relation", id: relation.id });
      catalog.addAnnotation({ scope, evidence });
      catalog.addRole(evidence.sourceId, scope, evidence.supports);
    }
  }
}

function registerPreservedHistorical(
  catalog: EvidenceCatalog,
  historical: readonly OwnedHistoricalEvidence[],
  outward: EvidenceClosureOutward,
): void {
  const itemEvidence = new Map(
    outward.items.map((entry) => [
      entry.item.nodeId,
      new Set([...entry.item.evidence, ...entry.evidence].map(serializeCanonicalJson)),
    ]),
  );
  const relationEvidence = new Map<string, ReadonlySet<string>>(
    outward.relations.map((relation) => [
      relation.id,
      new Set(relation.evidence.map(serializeCanonicalJson)),
    ]),
  );
  for (const value of historical) {
    const identity = serializeCanonicalJson(value.record.evidence);
    const preserved =
      value.owner.kind === "item"
        ? itemEvidence.get(value.owner.itemNodeId)?.has(identity)
        : relationEvidence.get(value.owner.relationId)?.has(identity);
    if (preserved === true) catalog.registerHistoricalEvidence(value.record);
  }
}

/** 現行・履歴の根拠をoutward参照へ解決し、固定点まで閉包する。 */
export function closeEvidenceReferences(
  catalog: EvidenceCatalog,
  context: EvidenceClosureContext,
  initial: EvidenceClosureOutward,
): EvidenceClosureResult {
  let outward = canonicalOutward(initial);
  const currentById = sourceFactsById(catalog.snapshot().currentSources);
  assertEvidenceClosureInput(context, outward, currentById);
  const previousById = historicalById(context.historicalEvidence);
  const tracked = outward.items.map((entry, index) => ({
    item: entry.item,
    path: ["items", index, "item"],
  }));
  const collection = outward.collectionAiItems.map((item, index) => ({
    item,
    path: ["collectionAiItems", index],
  }));
  const aiOrigins = createAiResultOrigins(
    tracked,
    collection,
    outward.aiItems,
    context.historicalAiResults,
  );
  const aiSlots = [
    ...tracked.flatMap(({ item, path }) =>
      collectAiResultSlots(item.aiAnalysis, [...path, "aiAnalysis"], {
        itemNodeId: item.nodeId,
        repositoryId: item.repositoryId,
      }),
    ),
    ...collection.flatMap(({ item, path }) =>
      collectAiResultSlots(item.aiAnalysis, [...path, "aiAnalysis"], {
        itemNodeId: item.nodeId,
        repositoryId: item.repositoryId,
      }),
    ),
  ];
  const repositories = new Map(
    outward.items.map((entry) => [entry.item.nodeId, entry.item.repositoryId]),
  );
  const adoptionSlots = collectAdoptionAiResultSlots(outward.aiItems, repositories);
  aiSlots.push(...adoptionSlots.slots);
  const originByPath = new Map(
    [...aiOrigins, ...adoptionSlots.origins].map((value) => [
      serializeCanonicalJson(value.path),
      value.origin,
    ]),
  );
  const registeredHistorical = new Set<string>();
  const allAdditions = new Map<
    string,
    Readonly<{
      destination: EvidenceUse["destination"];
      evidence: Evidence;
    }>
  >();
  let uses: readonly EvidenceUse[];
  let resolvedUses: readonly ResolvedEvidenceUse[];
  for (;;) {
    uses = walkOutwardEvidenceUses(outward);
    const resolved: ResolvedEvidenceUse[] = [];
    const additions = new Map<
      string,
      Readonly<{
        destination: EvidenceUse["destination"];
        evidence: Evidence;
      }>
    >();
    for (const use of uses) {
      const slot = aiResultSlotForUse(use.path, aiSlots);
      const origin = slot == null ? undefined : originByPath.get(serializeCanonicalJson(slot.path));
      const match = resolveEvidenceUse(
        use,
        currentById,
        previousById,
        context,
        undefined,
        slot == null || origin == null ? undefined : { slot, origin },
      );
      resolved.push(match.resolved);
      for (const historical of match.historical) {
        const identity = serializeCanonicalJson(historical);
        if (!registeredHistorical.has(identity)) {
          catalog.registerHistoricalEvidence(historical.record);
          registeredHistorical.add(identity);
        }
      }
      for (const evidence of evidenceAdditions(use, match.historical, outward)) {
        const addition = Object.freeze({ destination: use.destination, evidence });
        additions.set(serializeCanonicalJson(addition), addition);
      }
    }
    resolvedUses = Object.freeze(canonicalSort(resolved));
    if (additions.size === 0) break;
    for (const [identity, addition] of additions) allAdditions.set(identity, addition);
    outward = applyAdditions(outward, [...additions.values()]);
  }
  registerPreservedHistorical(catalog, context.historicalEvidence, outward);
  registerAnnotations(catalog, outward);
  return Object.freeze({
    outward,
    catalog: catalog.snapshot(),
    uses,
    resolvedUses,
    addedEvidence: canonicalSort([...allAdditions.values()]),
  });
}

/** Task15確定値から閉包に必要な現在事実と所有付き履歴を渡す。 */
export function closeFinalizedRunEvidence(
  run: PersonalReminderFinalizedRun,
  additions: EvidenceClosureAdditions,
): EvidenceClosureResult {
  const catalog = new EvidenceCatalog();
  try {
    for (const fact of collectCurrentSourceFacts(run.data.sourceRecords)) {
      catalog.registerCurrentSource(fact);
    }
  } catch (error: unknown) {
    throw new RunCompletenessError(
      "source_id_conflict",
      "current_source_facts",
      ["sourceRecords"],
      undefined,
      error,
    );
  }
  const context: EvidenceClosureContext = Object.freeze({
    evaluatedAt: run.data.sourceRecords.evaluatedAt,
    approvedRepositories: run.data.approvedRepositories,
    historicalEvidence: run.data.historicalEvidence,
    historicalAiResults: run.data.historicalAiResults,
  });
  const outward: EvidenceClosureOutward = Object.freeze({
    items: run.data.items,
    collectionAiItems: Object.freeze(
      run.data.snapshotProjection.collectionRepositories.flatMap((repository) => repository.items),
    ),
    relations: run.data.graph.edges,
    aiItems: run.data.aiItems,
    ...additions,
  });
  return closeEvidenceReferences(catalog, context, outward);
}

/** 最終outward値の参照集合が閉包時と一致することを照合する。 */
export function assertEvidenceClosureMatches(
  closure: EvidenceClosureResult,
  outward: EvidenceClosureOutward,
): void {
  const actual = walkOutwardEvidenceUses(canonicalOutward(outward));
  if (serializeCanonicalJson(actual) !== serializeCanonicalJson(closure.uses)) {
    const differing =
      actual.find(
        (use, index) =>
          closure.uses[index] == null ||
          serializeCanonicalJson(use) !== serializeCanonicalJson(closure.uses[index]),
      ) ?? closure.uses[actual.length];
    throw new RunCompletenessError(
      "invalid_reference",
      differing?.sourceId ?? "outward_references",
      differing?.path ?? ["outward"],
      differing,
    );
  }
}

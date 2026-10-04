import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
  ReferenceOwner,
} from "./run-validation-reference-contracts.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { UtcIsoDateTime } from "../../../domain/index.js";
import { buildSourceId, parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import type {
  EvidenceClosureResult,
  HistoricalAiSnapshotInput,
  OwnedHistoricalAiResult,
  OwnedHistoricalEvidence,
  ResolvedEvidenceUse,
} from "../contracts/evidence-closure.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import { EvidenceCatalog } from "./evidence-catalog.js";
import { collectOwnedHistoricalAiResults } from "./evidence-closure-historical-ai.js";
import {
  aiResultSlotForUse,
  collectAiResultSlots,
  matchingHistoricalAiResults,
  type AiResultOrigin,
  type AiResultSlot,
} from "./evidence-ai-results.js";
import { assertAiResultOrigins, createAiResultOrigins } from "./evidence-ai-provenance.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import type { PersonalReminderPlanningInput } from "../contracts/run-core.js";
import { resolveEvidenceUse } from "./evidence-closure-resolve.js";
import {
  collectOwnedHistoricalEvidence,
  type HistoricalEvidenceSnapshotInput,
} from "./evidence-closure-historical.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  assertMaterializedReferenceBindings,
  collectMaterializedSourceUses,
} from "./run-validation-artifact-reference-binding.js";
import { assertSourceReferenceCoverage } from "./run-validation-source-audit.js";
import { isRecord, valueAtPath } from "./run-validation-reference-scope.js";
import { assertStageSourceValuesMatch } from "./run-validation-stage-source-binding.js";
import { assertRunValueMatches } from "./run-validation-compare.js";
import {
  assertPreviousPendingCauseContexts,
  createPreviousPendingCauseContexts,
  type PreviousPendingCauseContext,
} from "./run-validation-previous-ledger-history.js";
import {
  assertCacheOwnerWitness,
  createCacheOwnerWitness,
  type CacheOwnerWitness,
} from "./run-validation-cache-witness.js";
import type { EvidenceClosureAdditions } from "./evidence-closure.js";

/** 分割workflowでsourceと所有範囲を再照合する公開可能な記録。 */
export type EvidenceClosureWitness = Readonly<{
  currentSources: readonly CurrentSourceFact[];
  historicalEvidence: readonly OwnedHistoricalEvidence[];
  historicalAiResults: readonly OwnedHistoricalAiResult[];
  previousPendingCauses: readonly PreviousPendingCauseContext[];
  aiResultOrigins: readonly AiResultOrigin[];
  resolvedUses: readonly ResolvedEvidenceUse[];
  materializedReferences: readonly MaterializedEvidenceReference[];
  cacheOwners: CacheOwnerWitness;
}>;

function canonicalSort<Value>(values: readonly Value[]): readonly Value[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      const first = serializeCanonicalJson(left);
      const second = serializeCanonicalJson(right);
      return first < second ? -1 : first > second ? 1 : 0;
    }),
  );
}

function collectSavedAiResultSlots(values: MaterializedReferenceValues): readonly AiResultSlot[] {
  const slots: AiResultSlot[] = [];
  for (const [index, item] of values.snapshot.items.entries()) {
    slots.push(
      ...collectAiResultSlots(item.aiAnalysis, ["snapshot", "items", index, "aiAnalysis"], {
        itemNodeId: item.nodeId,
        repositoryId: item.repositoryId,
      }),
    );
  }
  for (const [repositoryIndex, repository] of values.snapshot.collection.repositories.entries()) {
    for (const [itemIndex, item] of repository.items.entries()) {
      if (item.repositoryId !== repository.repositoryId)
        throw new RunCompletenessError(
          "wrong_owner",
          item.nodeId,
          ["snapshot", "collection", "repositories", repositoryIndex, "items", itemIndex],
          undefined,
        );
      slots.push(
        ...collectAiResultSlots(
          item.aiAnalysis,
          [
            "snapshot",
            "collection",
            "repositories",
            repositoryIndex,
            "items",
            itemIndex,
            "aiAnalysis",
          ],
          { itemNodeId: item.nodeId, repositoryId: item.repositoryId },
        ),
      );
    }
  }
  return Object.freeze(slots);
}

function selectedHistoricalAiResults(
  slots: readonly AiResultSlot[],
  origins: readonly AiResultOrigin[],
  historical: readonly OwnedHistoricalAiResult[],
): readonly OwnedHistoricalAiResult[] {
  assertAiResultOrigins(slots, origins, historical);
  const byPath = new Map(origins.map((origin) => [serializeCanonicalJson(origin.path), origin]));
  const selected = new Map<string, OwnedHistoricalAiResult>();
  for (const slot of slots) {
    if (byPath.get(serializeCanonicalJson(slot.path))?.origin !== "historical") continue;
    for (const record of matchingHistoricalAiResults(slot, historical)) {
      selected.set(serializeCanonicalJson(record), record);
    }
  }
  return canonicalSort([...selected.values()]);
}

/** 固定base revisionで読み直した前回snapshotとAI履歴witnessを照合する。 */
export function assertHistoricalAiWitnessMatchesBaseSnapshot(
  witness: EvidenceClosureWitness,
  snapshot: HistoricalAiSnapshotInput | undefined,
): void {
  const actual = snapshot == null ? Object.freeze([]) : collectOwnedHistoricalAiResults(snapshot);
  const identities = new Set(actual.map(serializeCanonicalJson));
  for (const record of witness.historicalAiResults) {
    if (!identities.has(serializeCanonicalJson(record))) {
      throw new RunCompletenessError(
        "missing_source",
        record.owner.itemNodeId,
        record.path,
        undefined,
      );
    }
  }
}

/** 固定base revisionの前回Evidenceが公開witnessの保存位置と所有者に一致することを確認する。 */
export function assertHistoricalEvidenceWitnessMatchesBaseSnapshot(
  witness: EvidenceClosureWitness,
  snapshot: HistoricalEvidenceSnapshotInput | undefined,
): void {
  const actual =
    snapshot == null
      ? Object.freeze([])
      : collectOwnedHistoricalEvidence(snapshot.items, snapshot.relations);
  const identities = new Set(actual.map(serializeCanonicalJson));
  for (const record of witness.historicalEvidence) {
    if (!identities.has(serializeCanonicalJson(record))) {
      throw new RunCompletenessError(
        "missing_source",
        record.record.evidence.sourceId,
        record.record.location.path,
        undefined,
      );
    }
  }
}

function resolvedAiSlot(
  path: readonly (string | number)[],
  slots: readonly AiResultSlot[],
  origins: readonly AiResultOrigin[],
): Readonly<{ slot: AiResultSlot; origin: AiResultOrigin["origin"] }> | undefined {
  const slot = aiResultSlotForUse(path, slots);
  if (slot == null) {
    if (path[0] === "snapshot" && path.includes("aiAnalysis"))
      throw new RunCompletenessError("invalid_reference", "ai", path, undefined);
    return undefined;
  }
  const origin = origins.find(
    (value) => serializeCanonicalJson(value.path) === serializeCanonicalJson(slot.path),
  );
  if (origin == null)
    throw new RunCompletenessError("missing_value", slot.owner.itemNodeId, slot.path, undefined);
  return { slot, origin: origin.origin };
}

function assertSavedAiOriginShape(
  values: MaterializedReferenceValues,
  origins: readonly AiResultOrigin[],
): void {
  const byPath = new Map(
    origins.map((origin) => [serializeCanonicalJson(origin.path), origin.origin]),
  );
  for (const entry of origins) {
    const index = entry.path.indexOf("aiAnalysis");
    const section = entry.path[index + 1];
    const element = entry.path[index + 2];
    if (index < 0 || typeof element !== "string")
      throw new RunCompletenessError("invalid_reference", "ai", entry.path, undefined);
    if (section === "retainedElements" && entry.origin === "current")
      throw new RunCompletenessError("invalid_reference", "ai", entry.path, undefined);
    if (section === "adoptedElements") {
      const analysis = valueAtPath(values, entry.path.slice(0, index + 1));
      const applications = isRecord(analysis) ? analysis["applications"] : undefined;
      const application = isRecord(applications) ? applications[element] : undefined;
      if (!isRecord(application) || application["status"] !== "current_ai")
        throw new RunCompletenessError("invalid_reference", "ai", entry.path, undefined);
      const current = application["origin"] === "executed" || application["origin"] === "cache";
      if (entry.origin === "current" && !current)
        throw new RunCompletenessError("invalid_reference", "ai", entry.path, undefined);
    }
    if (entry.path[index + 3] === "generation") {
      const resultPath = [...entry.path.slice(0, index + 3), "result"];
      if (byPath.get(serializeCanonicalJson(resultPath)) !== entry.origin)
        throw new RunCompletenessError("invalid_reference", "ai", entry.path, undefined);
    }
  }
}

/** 完全性検証済み閉包から利用されたsourceの事実だけを取り出す。 */
export function createEvidenceClosureWitness(
  closure: EvidenceClosureResult,
  historicalEvidence: readonly OwnedHistoricalEvidence[],
  historicalAiResults: readonly OwnedHistoricalAiResult[],
  previousInput: PersonalReminderPlanningInput["previousBaseSnapshot"],
  aiItems: readonly GenericAiItemAdoption[],
  evaluatedAt: UtcIsoDateTime,
  approvedRepositories: readonly PublicRepository[],
  values: MaterializedReferenceValues,
  outward: Pick<EvidenceClosureAdditions, "aiCacheAdditions" | "personalReminderAiCacheAdditions">,
  digest: ContentDigestPort,
): EvidenceClosureWitness {
  assertStageSourceValuesMatch(closure, values);
  const cacheOwners = createCacheOwnerWitness(outward, values, digest);
  const materializedReferences = collectMaterializedReferences(values, cacheOwners);
  const previousPendingCauses = createPreviousPendingCauseContexts(
    values.previousNotificationLedger,
    previousInput.items,
    previousInput.relations,
  );
  const sourceUses = collectMaterializedSourceUses(
    materializedReferences,
    values,
    previousPendingCauses,
  );
  const tracked = values.snapshot.items.map((item, index) => ({
    item,
    path: ["snapshot", "items", index],
  }));
  const collection = values.snapshot.collection.repositories.flatMap(
    (repository, repositoryIndex) =>
      repository.items.map((item, itemIndex) => ({
        item,
        path: ["snapshot", "collection", "repositories", repositoryIndex, "items", itemIndex],
      })),
  );
  const aiResultOrigins = createAiResultOrigins(tracked, collection, aiItems, historicalAiResults);
  assertSavedAiOriginShape(values, aiResultOrigins);
  const aiSlots = collectSavedAiResultSlots(values);
  const selectedAi = selectedHistoricalAiResults(aiSlots, aiResultOrigins, historicalAiResults);
  const usedIds = new Set(sourceUses.map(({ use }) => use.sourceId));
  const candidateCurrentSources = canonicalSort(
    closure.catalog.currentSources.filter((fact) => usedIds.has(fact.sourceId)),
  );
  const fullContext = Object.freeze({
    evaluatedAt,
    approvedRepositories,
    historicalEvidence,
    historicalAiResults: selectedAi,
  });
  const candidateCurrentById = indexedValues(candidateCurrentSources);
  const fullHistoricalById = indexedHistorical(historicalEvidence);
  const selectedHistorical = new Map<string, OwnedHistoricalEvidence>();
  const selectedCurrentIds = new Set<string>();
  for (const { use, annotation } of sourceUses) {
    const aiSlot = resolvedAiSlot(use.path, aiSlots, aiResultOrigins);
    const actual = resolveEvidenceUse(
      use,
      candidateCurrentById,
      fullHistoricalById,
      fullContext,
      annotation,
      aiSlot,
    );
    if (actual.resolved.resolution === "current") selectedCurrentIds.add(use.sourceId);
    for (const value of actual.historical) {
      selectedHistorical.set(serializeCanonicalJson(value), value);
    }
  }
  const currentSources = canonicalSort(
    candidateCurrentSources.filter((fact) => selectedCurrentIds.has(fact.sourceId)),
  );
  const currentById = indexedValues(currentSources);
  const usedHistoricalEvidence = canonicalSort([...selectedHistorical.values()]);
  const historicalById = indexedHistorical(usedHistoricalEvidence);
  const context = Object.freeze({
    evaluatedAt,
    approvedRepositories,
    historicalEvidence: usedHistoricalEvidence,
    historicalAiResults: selectedAi,
  });
  const resolvedUses = Object.freeze(
    sourceUses.map(
      ({ use, annotation }) =>
        resolveEvidenceUse(
          use,
          currentById,
          historicalById,
          context,
          annotation,
          resolvedAiSlot(use.path, aiSlots, aiResultOrigins),
        ).resolved,
    ),
  );
  assertMaterializedReferenceBindings(sourceUses, resolvedUses);
  return Object.freeze({
    currentSources,
    historicalEvidence: usedHistoricalEvidence,
    historicalAiResults: selectedAi,
    previousPendingCauses,
    aiResultOrigins,
    resolvedUses,
    materializedReferences,
    cacheOwners,
  });
}

function canonicalSourceId(value: string): SourceId {
  const source = parseSourceId(value);
  return buildSourceId(source.kind, source.originalId);
}

function walkReferences(
  value: unknown,
  path: readonly (string | number)[],
  owner: ReferenceOwner,
  references: MaterializedEvidenceReference[],
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      walkReferences(entry, [...path, index], owner, references);
    }
    return;
  }
  if (typeof value !== "object" || value == null) return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "sourceId" || key === "latestMeaningfulSourceId") && typeof entry === "string") {
      references.push(
        Object.freeze({ sourceId: canonicalSourceId(entry), path: [...path, key], owner }),
      );
    } else if ((key === "sourceIds" || key === "evidenceSourceIds") && Array.isArray(entry)) {
      const auditOnly =
        key === "sourceIds" && "source" in value && value.source === "reconfirmed_observation";
      for (const [index, sourceId] of entry.entries()) {
        if (typeof sourceId !== "string") {
          throw new RunCompletenessError(
            "invalid_reference",
            "sourceIds",
            [...path, key, index],
            undefined,
          );
        }
        if (auditOnly) {
          canonicalSourceId(sourceId);
          continue;
        }
        references.push(
          Object.freeze({
            sourceId: canonicalSourceId(sourceId),
            path: [...path, key, index],
            owner,
          }),
        );
      }
    } else if (key === "latestMeaningfulSourceId" && entry == null) {
      continue;
    } else if (/sourceids?$/iu.test(key)) {
      throw new RunCompletenessError("invalid_reference", key, [...path, key], undefined);
    } else {
      walkReferences(entry, [...path, key], owner, references);
    }
  }
}

/** 保存値と通知値に実在するsource参照を所有位置付きで列挙する。 */
export function collectMaterializedReferences(
  values: MaterializedReferenceValues,
  cacheOwners: CacheOwnerWitness,
): readonly MaterializedEvidenceReference[] {
  const references: MaterializedEvidenceReference[] = [];
  for (const [index, item] of values.snapshot.items.entries()) {
    walkReferences(
      item,
      ["snapshot", "items", index],
      Object.freeze({ kind: "item", id: item.nodeId }),
      references,
    );
  }
  for (const [index, relation] of values.snapshot.relations.entries()) {
    walkReferences(
      relation,
      ["snapshot", "relations", index],
      Object.freeze({ kind: "relation", id: relation.id }),
      references,
    );
  }
  for (const [repositoryIndex, repository] of values.snapshot.collection.repositories.entries()) {
    for (const [itemIndex, item] of repository.items.entries()) {
      walkReferences(
        item.aiAnalysis,
        [
          "snapshot",
          "collection",
          "repositories",
          repositoryIndex,
          "items",
          itemIndex,
          "aiAnalysis",
        ],
        Object.freeze({ kind: "item", id: item.nodeId }),
        references,
      );
    }
  }
  for (const [index, event] of values.historyInputEvents.entries()) {
    walkReferences(
      event,
      ["historyInputEvents", index],
      Object.freeze({ kind: "item", id: event.itemNodeId }),
      references,
    );
  }
  for (const [index, entry] of values.aiCacheAdditions.entries()) {
    const owner = cacheOwners.generic[index];
    if (owner == null) {
      throw new RunCompletenessError(
        "missing_value",
        entry.cacheKey,
        ["cacheOwners", "generic", index],
        undefined,
      );
    }
    walkReferences(
      entry.generation.result,
      ["aiCacheAdditions", index, "generation", "result"],
      Object.freeze({ kind: "item", id: owner.itemNodeId }),
      references,
    );
  }
  for (const [index, entry] of values.personalReminderAiCacheAdditions.entries()) {
    const owner = cacheOwners.personalReminder[index];
    if (owner == null) {
      throw new RunCompletenessError(
        "missing_value",
        entry.cacheKey,
        ["cacheOwners", "personalReminder", index],
        undefined,
      );
    }
    walkReferences(
      entry.generation.result,
      ["personalReminderAiCacheAdditions", index, "generation", "result"],
      Object.freeze({ kind: "item", id: owner.itemNodeId }),
      references,
    );
  }
  for (const [index, pending] of values.previousNotificationLedger.pendingNotifications.entries()) {
    walkReferences(
      pending,
      ["previousNotificationLedger", "pendingNotifications", index],
      Object.freeze({ kind: "item", id: pending.itemNodeId }),
      references,
    );
  }
  for (const [index, pending] of values.notificationLedger.pendingNotifications.entries()) {
    walkReferences(
      pending,
      ["notificationLedger", "pendingNotifications", index],
      Object.freeze({ kind: "item", id: pending.itemNodeId }),
      references,
    );
  }
  for (const [index, candidate] of values.notificationSelection.candidates.entries()) {
    walkReferences(
      candidate,
      ["notificationSelection", "candidates", index],
      Object.freeze({ kind: "item", id: candidate.itemNodeId }),
      references,
    );
  }
  for (const [index, pending] of values.notificationSelection.pendingNotifications.entries()) {
    walkReferences(
      pending,
      ["notificationSelection", "pendingNotifications", index],
      Object.freeze({ kind: "item", id: pending.itemNodeId }),
      references,
    );
  }
  const sorted = canonicalSort(references);
  assertSourceReferenceCoverage(values, sorted);
  return sorted;
}

function indexedValues<Value extends Readonly<{ sourceId: string }>>(
  values: readonly Value[],
): ReadonlyMap<string, readonly Value[]> {
  const groups = new Map<string, Value[]>();
  for (const value of values) {
    const entries = groups.get(value.sourceId) ?? [];
    entries.push(value);
    groups.set(value.sourceId, entries);
  }
  return groups;
}

function indexedHistorical(
  values: readonly OwnedHistoricalEvidence[],
): ReadonlyMap<string, readonly OwnedHistoricalEvidence[]> {
  const groups = new Map<string, OwnedHistoricalEvidence[]>();
  for (const value of values) {
    const sourceId = value.record.evidence.sourceId;
    const entries = groups.get(sourceId) ?? [];
    entries.push(value);
    groups.set(sourceId, entries);
  }
  return groups;
}

/** 公開witnessの各参照をsource事実と所有位置から再解決する。 */
export function assertEvidenceClosureWitness(
  witness: EvidenceClosureWitness,
  summary: Readonly<{ referenceCount: number; sourceIds: readonly string[] }>,
  evaluatedAt: UtcIsoDateTime,
  approvedRepositories: readonly PublicRepository[],
  values: MaterializedReferenceValues,
  digest: ContentDigestPort,
): void {
  assertCacheOwnerWitness(witness.cacheOwners, values, digest);
  assertRunValueMatches(
    canonicalSort(witness.currentSources),
    witness.currentSources,
    ["evidenceClosureWitness", "currentSources"],
    "closure",
  );
  assertRunValueMatches(
    canonicalSort(witness.historicalEvidence),
    witness.historicalEvidence,
    ["evidenceClosureWitness", "historicalEvidence"],
    "closure",
  );
  assertRunValueMatches(
    canonicalSort(witness.historicalAiResults),
    witness.historicalAiResults,
    ["evidenceClosureWitness", "historicalAiResults"],
    "closure",
  );
  assertPreviousPendingCauseContexts(
    witness.previousPendingCauses,
    values.previousNotificationLedger,
  );
  assertRunValueMatches(
    collectMaterializedReferences(values, witness.cacheOwners),
    witness.materializedReferences,
    ["evidenceClosureWitness", "materializedReferences"],
    "closure",
  );
  const sourceUses = collectMaterializedSourceUses(
    witness.materializedReferences,
    values,
    witness.previousPendingCauses,
  );
  const aiSlots = collectSavedAiResultSlots(values);
  assertSavedAiOriginShape(values, witness.aiResultOrigins);
  assertRunValueMatches(
    selectedHistoricalAiResults(aiSlots, witness.aiResultOrigins, witness.historicalAiResults),
    witness.historicalAiResults,
    ["evidenceClosureWitness", "historicalAiResults"],
    "closure",
  );
  assertMaterializedReferenceBindings(sourceUses, witness.resolvedUses);
  const identities = witness.resolvedUses.map((value) => serializeCanonicalJson(value.use));
  if (new Set(identities).size !== identities.length) {
    throw new RunCompletenessError(
      "duplicate_id",
      "closure",
      ["evidenceClosureWitness"],
      undefined,
    );
  }
  const sourceIds = Object.freeze(
    [...new Set(witness.resolvedUses.map((resolved) => resolved.use.sourceId))].sort(),
  );
  const currentIds = new Set(
    witness.resolvedUses
      .filter((resolved) => resolved.resolution === "current")
      .map((resolved) => resolved.use.sourceId),
  );
  assertRunValueMatches(
    { referenceCount: witness.resolvedUses.length, sourceIds },
    summary,
    ["evidenceClosureSummary"],
    "closure",
  );
  const catalog = new EvidenceCatalog();
  for (const fact of witness.currentSources) catalog.registerCurrentSource(fact);
  assertRunValueMatches(
    witness.currentSources,
    catalog.snapshot().currentSources,
    ["evidenceClosureWitness", "currentSources"],
    "closure",
  );
  const currentById = indexedValues(witness.currentSources);
  const historicalById = indexedHistorical(witness.historicalEvidence);
  const context = Object.freeze({
    evaluatedAt,
    approvedRepositories,
    historicalEvidence: witness.historicalEvidence,
    historicalAiResults: witness.historicalAiResults,
  });
  const selectedHistorical = new Map<string, OwnedHistoricalEvidence>();
  for (const [index, resolved] of witness.resolvedUses.entries()) {
    assertRunValueMatches(
      [...new Set(resolved.use.allowedOwnerNodeIds)].sort(),
      resolved.use.allowedOwnerNodeIds,
      ["evidenceClosureWitness", "resolvedUses", resolved.use.sourceId, "allowedOwnerNodeIds"],
      resolved.use.sourceId,
    );
    assertRunValueMatches(
      [...new Set(resolved.use.allowedRelationIds)].sort(),
      resolved.use.allowedRelationIds,
      ["evidenceClosureWitness", "resolvedUses", resolved.use.sourceId, "allowedRelationIds"],
      resolved.use.sourceId,
    );
    const sourceUse = sourceUses[index];
    if (sourceUse == null) {
      throw new RunCompletenessError(
        "missing_value",
        resolved.use.sourceId,
        resolved.use.path,
        resolved.use,
      );
    }
    const actual = resolveEvidenceUse(
      sourceUse.use,
      currentById,
      historicalById,
      context,
      sourceUse.annotation,
      resolvedAiSlot(sourceUse.use.path, aiSlots, witness.aiResultOrigins),
    );
    assertRunValueMatches(
      actual.resolved,
      resolved,
      ["evidenceClosureWitness", "resolvedUses", resolved.use.sourceId],
      resolved.use.sourceId,
    );
    for (const value of actual.historical) {
      selectedHistorical.set(serializeCanonicalJson(value), value);
    }
  }
  for (const fact of witness.currentSources) {
    if (!currentIds.has(fact.sourceId)) {
      throw new RunCompletenessError(
        "invalid_reference",
        fact.sourceId,
        ["evidenceClosureWitness", "currentSources"],
        undefined,
      );
    }
  }
  assertRunValueMatches(
    canonicalSort([...selectedHistorical.values()]),
    witness.historicalEvidence,
    ["evidenceClosureWitness", "historicalEvidence"],
    "closure",
  );
}

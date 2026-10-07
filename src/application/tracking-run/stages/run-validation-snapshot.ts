import { AI_ANALYSIS_ELEMENTS } from "../../../domain/ai-analysis-elements.js";
import type {
  EvidenceClosureResult,
  HistoricalAiSnapshotInput,
} from "../contracts/evidence-closure.js";
import type { FinalSnapshotCandidate } from "../contracts/final-snapshot.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import { buildFinalSnapshot } from "./final-snapshot.js";
import { collectOwnedHistoricalAiResults } from "./evidence-closure-historical-ai.js";
import { adoptionProvenance } from "./generic-ai-adoption-provenance.js";
import { trackedItemAiAnalysisFromAdoption } from "./graph-reconciliation-ai-analysis.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  assertRunValueMatches,
  assertRunValuesMatch,
  runValuesById,
} from "./run-validation-compare.js";

/** 最終段階、閉包、保存候補の同じ値を識別子ごとに照合する。 */
export function assertFinalSnapshotCandidateMatches(
  run: PersonalReminderFinalizedRun,
  closure: EvidenceClosureResult,
  candidate: FinalSnapshotCandidate,
  analyzedItems: GenericAiAdoptedRun["data"]["facts"]["items"],
  previousAiSnapshot: HistoricalAiSnapshotInput,
  digest: ContentDigestPort,
): void {
  const expected = buildFinalSnapshot(run, closure, digest);
  assertRunValueMatches(expected.schemaVersion, candidate.schemaVersion, ["schemaVersion"], "run");
  assertRunValueMatches(expected.run, candidate.run, ["run"], run.core.identity.runId);
  assertRunValueMatches(expected.generatedAt, candidate.generatedAt, ["generatedAt"], "run");
  assertRunValueMatches(
    run.data.sourceRecords.evaluatedAt,
    candidate.generatedAt,
    ["generatedAt"],
    "run",
  );
  assertRunValueMatches(
    expected.trackingStartAt,
    candidate.trackingStartAt,
    ["trackingStartAt"],
    "run",
  );
  assertRunValueMatches(expected.ai, candidate.ai, ["ai"], "run");
  assertRunValueMatches(
    expected.finalGraphProjectionDigest,
    candidate.finalGraphProjectionDigest,
    ["finalGraphProjectionDigest"],
    "graph",
  );
  assertRunValueMatches(
    expected.finalGraphProjection,
    candidate.finalGraphProjection,
    ["finalGraphProjection"],
    "graph",
  );
  assertRunValuesMatch(
    expected.repositories,
    candidate.repositories,
    (repository) => repository.id,
    (repository) => repository.id,
    ["repositories"],
  );
  assertRunValuesMatch(
    expected.collection.repositories,
    candidate.collection.repositories,
    (repository) => repository.repositoryId,
    (repository) => repository.repositoryId,
    ["collection", "repositories"],
  );
  assertRunValuesMatch(
    expected.items,
    candidate.items,
    (item) => item.nodeId,
    (item) => item.nodeId,
    ["items"],
  );
  assertRunValuesMatch(
    expected.relations,
    candidate.relations,
    (relation) => relation.id,
    (relation) => relation.id,
    ["relations"],
  );
  assertRunValuesMatch(
    expected.externalReferences,
    candidate.externalReferences,
    (reference) => reference.nodeId,
    (reference) => reference.nodeId,
    ["externalReferences"],
  );
  assertRunValuesMatch(
    expected.verifiedExternalReferences,
    candidate.verifiedExternalReferences,
    (reference) => reference.url,
    (reference) => reference.url,
    ["verifiedExternalReferences"],
  );
  assertRunValuesMatch(
    expected.graphNodeStateObservations,
    candidate.graphNodeStateObservations,
    (observation) => observation.nodeId,
    (observation) => observation.nodeId,
    ["graphNodeStateObservations"],
  );
  assertRunValuesMatch(
    run.data.aiItems,
    closure.outward.aiItems,
    (item) => item.nodeId,
    (item) => item.nodeId,
    ["aiItems"],
  );
  assertRunValueMatches(
    collectOwnedHistoricalAiResults(previousAiSnapshot),
    run.data.historicalAiResults,
    ["historicalAiResults"],
    "ai",
  );
  assertFinalizedItemsMatch(run, closure, candidate);
  assertAiElementsMatch(run, candidate, analyzedItems, previousAiSnapshot);
  assertGraphRelationsMatch(run, closure);
}

function assertFinalizedItemsMatch(
  run: PersonalReminderFinalizedRun,
  closure: EvidenceClosureResult,
  candidate: FinalSnapshotCandidate,
): void {
  const finalized = runValuesById(run.data.items, (entry) => entry.item.nodeId, ["items"]);
  const closed = runValuesById(closure.outward.items, (entry) => entry.item.nodeId, ["items"]);
  const snapshot = runValuesById(candidate.items, (item) => item.nodeId, ["items"]);
  for (const [nodeId, entry] of finalized) {
    const closedEntry = closed.get(nodeId);
    const saved = snapshot.get(nodeId);
    if (closedEntry == null || saved == null) {
      throw new RunCompletenessError("missing_value", nodeId, ["items", nodeId], undefined);
    }
    assertRunValueMatches(entry.item, closedEntry.item, ["items", nodeId, "item"], nodeId);
    assertRunValueMatches(
      entry.causeResults,
      closedEntry.causeResults,
      ["items", nodeId, "causeResults"],
      nodeId,
    );
    assertRunValueMatches(
      entry.planning,
      closedEntry.planning,
      ["items", nodeId, "planning"],
      nodeId,
    );
    assertRunValueMatches(
      entry.causeResults.map((result) => result.cause),
      saved.personalReminderCauses,
      ["items", nodeId, "personalReminderCauses"],
      nodeId,
    );
    assertRunValueMatches(
      entry.planning,
      saved.personalReminderCausePlanning,
      ["items", nodeId, "personalReminderCausePlanning"],
      nodeId,
    );
  }
  if (finalized.size !== closed.size || finalized.size !== snapshot.size) {
    throw new RunCompletenessError("missing_value", "items", ["items"], undefined);
  }
}

function assertAiElementsMatch(
  run: PersonalReminderFinalizedRun,
  candidate: FinalSnapshotCandidate,
  analyzedItems: GenericAiAdoptedRun["data"]["facts"]["items"],
  previousAiSnapshot: HistoricalAiSnapshotInput,
): void {
  const saved = runValuesById(candidate.items, (item) => item.nodeId, ["items"]);
  const aiItems = runValuesById(run.data.aiItems, (item) => item.nodeId, ["aiItems"]);
  const analyzed = runValuesById(analyzedItems, (entry) => entry.item.nodeId, ["facts", "items"]);
  const previous = runValuesById(previousAiSnapshot.trackedItems, (item) => item.nodeId, [
    "previousAiSnapshot",
    "trackedItems",
  ]);
  for (const nodeId of analyzed.keys()) {
    if (!aiItems.has(nodeId)) {
      throw new RunCompletenessError("missing_value", nodeId, ["aiItems"], undefined);
    }
  }
  if (aiItems.size !== analyzed.size) {
    throw new RunCompletenessError("missing_value", "aiItems", ["aiItems"], undefined);
  }
  for (const [nodeId, aiItem] of aiItems) {
    const item = saved.get(nodeId);
    if (item == null) {
      throw new RunCompletenessError("missing_value", nodeId, ["items"], undefined);
    }
    let expectedAnalysis;
    try {
      expectedAnalysis = trackedItemAiAnalysisFromAdoption(aiItem);
    } catch (cause: unknown) {
      throw new RunCompletenessError(
        "field_mismatch",
        nodeId,
        ["aiItems", nodeId],
        undefined,
        cause,
      );
    }
    assertRunValueMatches(
      expectedAnalysis,
      item.aiAnalysis,
      ["items", nodeId, "aiAnalysis"],
      nodeId,
    );
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const adoption = aiItem.elements[element];
      if (
        adoption.element !== element ||
        adoption.producer.element !== element ||
        adoption.producer.nodeId !== nodeId
      ) {
        throw new RunCompletenessError(
          "field_mismatch",
          nodeId,
          ["aiItems", nodeId, "elements", element, "producer"],
          undefined,
        );
      }
      const expectedProvenance = adoptionProvenance(aiItem.nodeId, element, adoption.adopted);
      assertRunValueMatches(
        expectedProvenance,
        Object.freeze({
          producer: adoption.producer,
          application: adoption.application,
          aiDependency: adoption.aiDependency,
        }),
        ["aiItems", nodeId, "elements", element],
        nodeId,
      );
    }
  }
  for (const [nodeId, item] of saved) {
    if (aiItems.has(nodeId)) continue;
    const retained = previous.get(nodeId);
    if (retained == null) {
      throw new RunCompletenessError("wrong_owner", nodeId, ["items", nodeId], undefined);
    }
    assertRunValueMatches(
      retained.repositoryId,
      item.repositoryId,
      ["items", nodeId, "repositoryId"],
      nodeId,
    );
    assertRunValueMatches(
      retained.aiAnalysis,
      item.aiAnalysis,
      ["items", nodeId, "aiAnalysis"],
      nodeId,
    );
  }
}

function assertGraphRelationsMatch(
  run: PersonalReminderFinalizedRun,
  closure: EvidenceClosureResult,
): void {
  const graph = runValuesById(run.data.graph.edges, (edge) => edge.id, ["graph", "edges"]);
  const closed = runValuesById(closure.outward.relations, (edge) => edge.id, ["relations"]);
  for (const [id, edge] of graph) {
    const closedEdge = closed.get(id);
    if (closedEdge == null) {
      throw new RunCompletenessError("missing_value", id, ["relations"], undefined);
    }
    const { evidence: previousEvidence, ...graphFields } = edge;
    const { evidence: closedEvidence, ...closedFields } = closedEdge;
    void previousEvidence;
    void closedEvidence;
    assertRunValueMatches(graphFields, closedFields, ["relations", id], id);
  }
  if (graph.size !== closed.size) {
    throw new RunCompletenessError("missing_value", "relations", ["relations"], undefined);
  }
}

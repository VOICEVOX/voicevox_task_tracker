import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Evidence, Relation } from "../../../domain/index.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import type { EvidenceClosureResult } from "../contracts/evidence-closure.js";
import type { FinalSnapshotCandidate } from "../contracts/final-snapshot.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function snapshotRelation(edge: ReconciledGraphEdge): Relation {
  const fields = {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    contradictions: Object.freeze(
      edge.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
        }),
      ),
    ),
    aiDependency: edge.aiDependency,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
  };
  return edge.active
    ? Object.freeze({ ...fields, active: true })
    : Object.freeze({ ...fields, active: false, removedAt: edge.removedAt });
}

function canonicalEvidence(values: readonly Evidence[]): readonly Evidence[] {
  const records = new Map(values.map((evidence) => [serializeCanonicalJson(evidence), evidence]));
  return Object.freeze(
    [...records.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, value]) => value),
  );
}

/** 閉包済み最終値と確定projectionからv23 snapshot候補を一度だけ生成する。 */
export function buildFinalSnapshot(
  run: PersonalReminderFinalizedRun,
  closure: EvidenceClosureResult,
  digest: ContentDigestPort,
): FinalSnapshotCandidate {
  const projection = run.data.snapshotProjection;
  const items = Object.freeze(
    closure.outward.items
      .map((entry) => {
        const { deadlineLevel, ...item } = entry.item;
        void deadlineLevel;
        return Object.freeze({
          ...item,
          personalReminderCauses: Object.freeze(entry.causeResults.map(({ cause }) => cause)),
          personalReminderCausePlanning: entry.planning,
          evidence: canonicalEvidence([...entry.item.evidence, ...entry.evidence]),
        });
      })
      .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
  );
  const relations = Object.freeze(
    closure.outward.relations
      .map(snapshotRelation)
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
  const finalGraphProjection = run.data.finalGraphProjection;
  return Object.freeze({
    schemaVersion: "23",
    generatedAt: run.data.sourceRecords.evaluatedAt,
    trackingStartAt: projection.trackingStartAt,
    ai: projection.ai,
    collection: Object.freeze({ repositories: projection.collectionRepositories }),
    repositories: projection.repositories,
    items,
    graphNodeStateObservations: run.data.graph.graphNodeStateObservations,
    externalReferences: run.data.graph.externalReferences,
    verifiedExternalReferences: projection.verifiedExternalReferences,
    relations,
    finalGraphProjection,
    finalGraphProjectionDigest: digest.sha256Utf8(serializeCanonicalJson(finalGraphProjection)),
    run: Object.freeze({
      id: run.core.identity.runId,
      status:
        projection.graphRunStatus === "fallback" || run.data.personalReminderStatus === "fallback"
          ? "fallback"
          : "success",
    }),
  });
}

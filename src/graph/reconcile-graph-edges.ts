import { type Evidence, type UtcIsoDateTime } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { evidenceKey } from "./reconcile-graph-candidates.js";
import type { GraphEdgeDraft } from "./reconcile-graph-contracts.js";
import { compareStrings } from "./reconcile-graph-sources.js";
import {
  type GraphEdgeChangedField,
  type GraphEdgeHistoryEvent,
  type ReconciledGraphEdge,
  type RelationContradiction,
} from "./reconcile-graph-types.js";
import { type RelationCandidateId } from "./relation-candidate-types.js";

function createActiveEdge(
  draft: GraphEdgeDraft,
  firstSeenAt: UtcIsoDateTime,
  lastConfirmedAt: UtcIsoDateTime,
): ReconciledGraphEdge & Readonly<{ active: true }> {
  return Object.freeze({
    id: draft.id,
    fromNodeId: draft.fromNodeId,
    toNodeId: draft.toNodeId,
    type: draft.type,
    provenance: draft.provenance,
    confidence: draft.confidence,
    evidence: draft.evidence,
    authoritative: draft.authoritative,
    contradictions: draft.contradictions,
    aiDependency: draft.aiDependency,
    firstSeenAt,
    lastConfirmedAt,
    active: true,
  });
}

function createInactiveEdge(
  edge: ReconciledGraphEdge & Readonly<{ active: true }>,
  removedAt: UtcIsoDateTime,
): ReconciledGraphEdge & Readonly<{ active: false }> {
  return Object.freeze({
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    authoritative: edge.authoritative,
    contradictions: edge.contradictions,
    aiDependency: edge.aiDependency,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
    active: false,
    removedAt,
  });
}

function evidenceSignatures(evidence: readonly Evidence[]): readonly string[] {
  return evidence.map(evidenceKey).sort(compareStrings);
}

function sameEvidence(left: readonly Evidence[], right: readonly Evidence[]): boolean {
  const leftSignatures = evidenceSignatures(left);
  const rightSignatures = evidenceSignatures(right);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((signature, index) => signature === rightSignatures[index])
  );
}

function contradictionSignature(contradiction: RelationContradiction): string {
  return JSON.stringify([contradiction.verdict, contradiction.confidence]);
}

function sameContradictions(
  left: readonly RelationContradiction[],
  right: readonly RelationContradiction[],
): boolean {
  const leftSignatures = left.map(contradictionSignature).sort(compareStrings);
  const rightSignatures = right.map(contradictionSignature).sort(compareStrings);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((signature, index) => signature === rightSignatures[index])
  );
}

function changedFields(
  before: ReconciledGraphEdge,
  after: ReconciledGraphEdge,
): readonly GraphEdgeChangedField[] {
  const fields: GraphEdgeChangedField[] = [];
  if (before.fromNodeId !== after.fromNodeId || before.toNodeId !== after.toNodeId) {
    fields.push("endpoints");
  }
  if (before.type !== after.type) {
    fields.push("type");
  }
  if (before.provenance !== after.provenance) {
    fields.push("provenance");
  }
  if (before.confidence !== after.confidence) {
    fields.push("confidence");
  }
  if (!sameEvidence(before.evidence, after.evidence)) {
    fields.push("evidence");
  }
  if (before.authoritative !== after.authoritative) {
    fields.push("authoritative");
  }
  if (!sameContradictions(before.contradictions, after.contradictions)) {
    fields.push("contradictions");
  }
  return Object.freeze(fields);
}

function createChangedFieldTuple(
  fields: readonly GraphEdgeChangedField[],
): readonly [GraphEdgeChangedField, ...GraphEdgeChangedField[]] {
  const [firstField, ...remainingFields] = fields;
  assertNonNullable(firstField, "edge変更イベントには変更箇所が1件以上必要です");
  return Object.freeze([firstField, ...remainingFields]);
}

export function isActiveEdge(
  edge: ReconciledGraphEdge,
): edge is ReconciledGraphEdge & Readonly<{ active: true }> {
  return edge.active;
}

export function reconcileEdges(
  previousEdges: ReadonlyMap<RelationCandidateId, ReconciledGraphEdge>,
  edgeDrafts: ReadonlyMap<RelationCandidateId, GraphEdgeDraft>,
  reconciledAt: UtcIsoDateTime,
): Readonly<{
  edges: readonly ReconciledGraphEdge[];
  events: readonly GraphEdgeHistoryEvent[];
}> {
  const edgeIds = [...new Set([...previousEdges.keys(), ...edgeDrafts.keys()])].sort(
    compareStrings,
  );
  const edges: ReconciledGraphEdge[] = [];
  const events: GraphEdgeHistoryEvent[] = [];

  for (const edgeId of edgeIds) {
    const previousEdge = previousEdges.get(edgeId);
    const edgeDraft = edgeDrafts.get(edgeId);

    if (edgeDraft != null) {
      const activeEdge = createActiveEdge(
        edgeDraft,
        previousEdge?.firstSeenAt ?? edgeDraft.firstSeenAt,
        reconciledAt,
      );
      edges.push(activeEdge);
      if (previousEdge?.active !== true) {
        events.push(
          Object.freeze({
            kind: "added",
            edgeId,
            occurredAt: reconciledAt,
            after: activeEdge,
          }),
        );
        continue;
      }
      const fields = changedFields(previousEdge, activeEdge);
      if (fields.length > 0) {
        events.push(
          Object.freeze({
            kind: "changed",
            edgeId,
            occurredAt: reconciledAt,
            changedFields: createChangedFieldTuple(fields),
            before: previousEdge,
            after: activeEdge,
          }),
        );
      }
      continue;
    }

    assertNonNullable(previousEdge, `edge ${edgeId}の前回値がありません`);
    if (!previousEdge.active) {
      edges.push(previousEdge);
      continue;
    }
    const inactiveEdge = createInactiveEdge(previousEdge, reconciledAt);
    edges.push(inactiveEdge);
    events.push(
      Object.freeze({
        kind: "removed",
        edgeId,
        occurredAt: reconciledAt,
        before: previousEdge,
        after: inactiveEdge,
      }),
    );
  }

  return Object.freeze({
    edges: Object.freeze(edges),
    events: Object.freeze(events),
  });
}

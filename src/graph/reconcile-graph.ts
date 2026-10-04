import { type GraphNodeId } from "../domain/index.js";
import { normalizeRelationCandidates } from "./normalize-relation-candidates.js";
import {
  resolveCandidate,
  validatePreviousEdgeCandidateIdentity,
} from "./reconcile-graph-candidate-resolution.js";
import {
  relationNodes,
  validateAssessments,
  validateCandidateRelationEndpointTypes,
  validateRelationAiDependencies,
} from "./reconcile-graph-candidates.js";
import type { CandidateResolutionResult, GraphEdgeDraft } from "./reconcile-graph-contracts.js";
import { isActiveEdge, reconcileEdges } from "./reconcile-graph-edges.js";
import {
  indexPreviousEdges,
  validatePreviousHistoryEvents,
} from "./reconcile-graph-previous-edges.js";
import {
  compareStrings,
  validateConfidence,
  validateSourceOccurredAtById,
  validateUtcIsoDateTime,
} from "./reconcile-graph-sources.js";
import {
  type BlockedByEntry,
  type ReconciledGraphEdge,
  type ReconcileGraphInput,
  type ReconcileGraphResult,
  type RelationCandidateDecisionProof,
  type RelationCandidateResolution,
} from "./reconcile-graph-types.js";
import { type RelationCandidate, type RelationCandidateId } from "./relation-candidate-types.js";

function candidateEndpointNodeIds(
  candidate: RelationCandidate,
): readonly [GraphNodeId, GraphNodeId] {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  return Object.freeze([firstNode.nodeId, secondNode.nodeId]);
}

function candidateDecisionProof(
  candidate: RelationCandidate,
  result: CandidateResolutionResult,
): RelationCandidateDecisionProof {
  const proof = {
    candidateId: candidate.id,
    endpointNodeIds: candidateEndpointNodeIds(candidate),
    authority: candidate.authority,
    resolution: result.resolution,
    dependency: result.dependency,
  };
  if (result.canonicalRelation == null) {
    return Object.freeze(proof);
  }
  return Object.freeze({
    ...proof,
    canonicalRelation: result.canonicalRelation,
  });
}

/** activeなblocks edgeから項目ごとのblockedByを導出する。 */
export function deriveBlockedBy(edges: readonly ReconciledGraphEdge[]): readonly BlockedByEntry[] {
  const blockersByBlockedNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();

  for (const edge of edges) {
    if (!edge.active || edge.type !== "blocks") {
      continue;
    }
    const blockers = blockersByBlockedNodeId.get(edge.toNodeId);
    if (blockers == null) {
      blockersByBlockedNodeId.set(edge.toNodeId, new Set([edge.fromNodeId]));
      continue;
    }
    blockers.add(edge.fromNodeId);
  }

  return Object.freeze(
    [...blockersByBlockedNodeId.entries()]
      .sort(([leftNodeId], [rightNodeId]) => compareStrings(leftNodeId, rightNodeId))
      .map(([nodeId, blockers]) =>
        Object.freeze({
          nodeId,
          blockedBy: Object.freeze([...blockers].sort(compareStrings)),
        }),
      ),
  );
}

/** 前回graphと今回の候補およびAI判定をreconcileする。 */
export function reconcileGraph(input: ReconcileGraphInput): ReconcileGraphResult {
  validateConfidence(input.minimumInferredConfidence, "推定edgeの最低confidence");
  validateUtcIsoDateTime(input.reconciledAt, "reconcile時刻");
  validateSourceOccurredAtById(input.sourceOccurredAtById, input.reconciledAt);

  const candidates = normalizeRelationCandidates(input.candidates);
  for (const candidate of candidates) {
    validateCandidateRelationEndpointTypes(candidate);
  }
  const assessmentsByCandidateId = validateAssessments(candidates, input.assessments);
  validateRelationAiDependencies(candidates, input.relationAiDependencies);
  const previousEdges = indexPreviousEdges(input.previousGraph.edges, input.reconciledAt);
  validatePreviousHistoryEvents(input.previousGraph.historyEvents, input.reconciledAt);
  for (const candidate of candidates) {
    const previousEdge = previousEdges.get(candidate.id);
    if (previousEdge != null) {
      validatePreviousEdgeCandidateIdentity(candidate, previousEdge);
    }
  }

  const edgeDrafts = new Map<RelationCandidateId, GraphEdgeDraft>();
  const candidateResolutions: RelationCandidateResolution[] = [];
  const candidateDecisionProofs: RelationCandidateDecisionProof[] = [];
  for (const candidate of candidates) {
    const result = resolveCandidate(
      candidate,
      assessmentsByCandidateId.get(candidate.id),
      input.sourceOccurredAtById,
      input.minimumInferredConfidence,
      input.relationAiDependencies,
    );
    candidateResolutions.push(result.resolution);
    candidateDecisionProofs.push(candidateDecisionProof(candidate, result));
    if (result.edgeDraft != null) {
      edgeDrafts.set(candidate.id, result.edgeDraft);
    }
  }

  const reconciled = reconcileEdges(previousEdges, edgeDrafts, input.reconciledAt);
  const activeEdges = Object.freeze(reconciled.edges.filter(isActiveEdge));
  const emittedHistoryEvents = reconciled.events;
  const historyEvents = Object.freeze([
    ...input.previousGraph.historyEvents,
    ...emittedHistoryEvents,
  ]);

  return Object.freeze({
    edges: reconciled.edges,
    activeEdges,
    historyEvents,
    emittedHistoryEvents,
    candidateResolutions: Object.freeze(candidateResolutions),
    candidateDecisionProofs: Object.freeze(candidateDecisionProofs),
    blockedBy: deriveBlockedBy(activeEdges),
  });
}

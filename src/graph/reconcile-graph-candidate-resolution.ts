import {
  aiAnalysisDependencyForRelation,
  type AiAnalysisDependency,
  type Evidence,
  type GraphNodeId,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  canonicalAssessmentRelation,
  canonicalCandidateRelation,
  createContradiction,
  createEvidence,
  normalizeEvidence,
  provenanceSummary,
  relationCandidateOwnerNodeId,
  relationNodes,
  validateImplementsEndpointTypes,
  validateInferredRelationAiDependency,
} from "./reconcile-graph-candidates.js";
import type { CandidateResolutionResult } from "./reconcile-graph-contracts.js";
import { resolveCandidateFirstSeenAt } from "./reconcile-graph-sources.js";
import {
  type CanonicalRelation,
  type ReconciledGraphEdge,
  type RelationCandidateAssessment,
} from "./reconcile-graph-types.js";
import {
  type RelationCandidate,
  type RelationCandidateId,
  type RelationCandidateNode,
} from "./relation-candidate-types.js";

function createCandidateEvidence(candidate: RelationCandidate): readonly Evidence[] {
  return createEvidence(candidate.sourceIds, "relation", provenanceSummary(candidate.provenance));
}

function createInferredEvidence(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment,
): readonly Evidence[] {
  return normalizeEvidence([
    ...createCandidateEvidence(candidate),
    ...createEvidence(assessment.sourceIds, "relation", assessment.reasonSummary),
  ]);
}

function candidateNodeById(
  candidate: RelationCandidate,
  nodeId: GraphNodeId,
): RelationCandidateNode {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === nodeId) {
    return firstNode;
  }
  if (secondNode.nodeId === nodeId) {
    return secondNode;
  }
  throw new TypeError(`関係候補 ${candidate.id}にnode ${nodeId}が含まれていません`);
}

function validateCanonicalRelationEndpointTypes(
  candidate: RelationCandidate,
  relation: CanonicalRelation,
): void {
  if (relation.type !== "implements") {
    return;
  }
  validateImplementsEndpointTypes(
    candidateNodeById(candidate, relation.fromNodeId),
    candidateNodeById(candidate, relation.toNodeId),
    `implements判定 ${candidate.id}`,
  );
}

export function validatePreviousEdgeCandidateIdentity(
  candidate: RelationCandidate,
  previousEdge: ReconciledGraphEdge,
): void {
  const endpointNodeIds = new Set(relationNodes(candidate.relation).map((node) => node.nodeId));
  if (
    !endpointNodeIds.has(previousEdge.fromNodeId) ||
    !endpointNodeIds.has(previousEdge.toNodeId)
  ) {
    throw new TypeError(`関係候補 ${candidate.id}のendpointが前回edgeと一致しません`);
  }
  if (candidate.authority === "authoritative" || previousEdge.provenance === "native") {
    if (candidate.authority !== "authoritative" || previousEdge.provenance !== "native") {
      throw new TypeError(`関係候補 ${candidate.id}がnative edge IDと衝突しています`);
    }
    const relation = canonicalCandidateRelation(candidate.relation);
    if (
      previousEdge.fromNodeId !== relation.fromNodeId ||
      previousEdge.toNodeId !== relation.toNodeId ||
      previousEdge.type !== relation.type
    ) {
      throw new TypeError(`native relation ${candidate.id}の内容が前回edgeと一致しません`);
    }
    return;
  }
  const dependency = previousEdge.aiDependency;
  if (
    dependency.status === "unknown" &&
    dependency.reasons.length === 1 &&
    dependency.reasons[0] === "migration" &&
    dependency.producers == null
  ) {
    return;
  }
  if (dependency.status === "not_dependent" || dependency.producers == null) {
    throw new TypeError(`前回の推定edge ${candidate.id}にowner producerがありません`);
  }
  const ownerNodeId = relationCandidateOwnerNodeId(candidate);
  if (
    dependency.producers.some(
      (producer) =>
        producer.kind !== "relation" ||
        producer.relationId !== candidate.id ||
        producer.producer.nodeId !== ownerNodeId,
    )
  ) {
    throw new TypeError(`関係候補 ${candidate.id}のownerが前回edgeと一致しません`);
  }
}

export function resolveCandidate(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment | undefined,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  minimumInferredConfidence: number,
  relationAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
): CandidateResolutionResult {
  if (candidate.authority === "authoritative") {
    const relation = canonicalCandidateRelation(candidate.relation);
    validateCanonicalRelationEndpointTypes(candidate, relation);
    const contradictions = createContradiction(candidate, assessment);
    const evidence = normalizeEvidence([
      ...createCandidateEvidence(candidate),
      ...contradictions.flatMap((contradiction) => contradiction.evidence),
    ]);
    return Object.freeze({
      edgeDraft: Object.freeze({
        id: candidate.id,
        ...relation,
        provenance: candidate.provenance,
        confidence: 1,
        evidence,
        authoritative: true,
        contradictions,
        aiDependency: Object.freeze({ status: "not_dependent" }),
        firstSeenAt: resolveCandidateFirstSeenAt(candidate, sourceOccurredAtById),
      }),
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "active",
        edgeId: candidate.id,
      }),
      dependency: Object.freeze({ status: "not_dependent" }),
      canonicalRelation: relation,
    });
  }

  const sourceAiDependency = relationAiDependencies.get(candidate.id);
  assertNonNullable(sourceAiDependency, `推定relation ${candidate.id}のAI依存がありません`);
  validateInferredRelationAiDependency(candidate, sourceAiDependency, true);

  if (assessment == null) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "pending",
        reason: "assessment_missing",
      }),
      dependency: sourceAiDependency,
    });
  }
  if (assessment.confidence < minimumInferredConfidence) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "pending",
        reason: "confidence_below_threshold",
        confidence: assessment.confidence,
      }),
      dependency: sourceAiDependency,
    });
  }

  const relation = canonicalAssessmentRelation(candidate, assessment);
  if (relation == null) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "rejected",
        reason: "verdict_none",
        confidence: assessment.confidence,
      }),
      dependency: sourceAiDependency,
    });
  }
  validateCanonicalRelationEndpointTypes(candidate, relation);
  if (
    relation.type === "blocks" &&
    candidateNodeById(candidate, relation.fromNodeId).state !== "open"
  ) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "rejected",
        reason: "blocker_not_open",
        confidence: assessment.confidence,
      }),
      dependency: sourceAiDependency,
    });
  }

  validateInferredRelationAiDependency(candidate, sourceAiDependency, false);
  const aiDependency = aiAnalysisDependencyForRelation(candidate.id, sourceAiDependency);

  return Object.freeze({
    edgeDraft: Object.freeze({
      id: candidate.id,
      ...relation,
      provenance: candidate.provenance,
      confidence: assessment.confidence,
      evidence: createInferredEvidence(candidate, assessment),
      authoritative: false,
      contradictions: Object.freeze([]),
      aiDependency,
      firstSeenAt: resolveCandidateFirstSeenAt(candidate, sourceOccurredAtById),
    }),
    resolution: Object.freeze({
      candidateId: candidate.id,
      status: "active",
      edgeId: candidate.id,
    }),
    dependency: sourceAiDependency,
    canonicalRelation: relation,
  });
}

import {
  aiAnalysisDependencyForRelation,
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
} from "../../../domain/ai-analysis-dependencies.js";
import type { GraphNodeId } from "../../../domain/index.js";
import type { GitHubItemDetail } from "../../../github/index.js";
import type {
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateDecisionProof,
  RelationCandidateId,
  RelationCandidateNode,
  RelationCandidateResolution,
} from "../../../graph/index.js";
import {
  isOrganizationRelationCandidateNode,
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../../../graph/relation-candidate-endpoints.js";
import { assertNonNullable } from "../../../util/index.js";
import type { CollectedItems } from "../contracts.js";
import {
  nativeRelationEndpointSelection,
  nativeRelationSourceObservations,
  nativeRelationSourcesProveAbsence,
  obsoleteNativeEdgeIds,
} from "./native-edge-validity.js";

function preservedRelationSourceProducers(
  edge: ReconciledGraphEdge,
): readonly AiAnalysisDependencyProducer[] | undefined {
  if (edge.aiDependency.status === "not_dependent") {
    throw new TypeError(`推定edge ${edge.id}のAI依存がありません`);
  }
  const producers = edge.aiDependency.producers;
  if (producers == null) {
    return undefined;
  }
  return Object.freeze(
    producers.map((producer) => {
      if (
        producer.kind !== "relation" ||
        producer.relationId !== edge.id ||
        producer.producer.element !== "relations"
      ) {
        throw new TypeError(`推定edge ${edge.id}の保存済みproducerが不正です`);
      }
      return Object.freeze({
        kind: "item_element",
        nodeId: producer.producer.nodeId,
        element: "relations",
      }) satisfies AiAnalysisDependencyProducer;
    }),
  );
}

function downgradedPreservedRelationDependency(
  edge: ReconciledGraphEdge,
  currentDependency: AiAnalysisDependency | undefined,
  fallbackProducer: AiAnalysisDependencyProducer | undefined,
): AiAnalysisDependency | undefined {
  if (
    currentDependency?.status === "unknown" &&
    currentDependency.reasons.every(
      (reason) => reason === "proof_unknown" || reason === "migration",
    ) &&
    currentDependency.producers != null
  ) {
    return currentDependency;
  }
  const currentProducers =
    currentDependency != null && currentDependency.status !== "not_dependent"
      ? currentDependency.producers
      : undefined;
  const producers =
    currentProducers ??
    preservedRelationSourceProducers(edge) ??
    (fallbackProducer == null ? undefined : Object.freeze([fallbackProducer]));
  if (producers == null) {
    return undefined;
  }
  const proofUnknown: AiAnalysisDependency = Object.freeze({
    status: "unknown",
    reasons: Object.freeze(["proof_unknown"]),
    producers,
  } satisfies AiAnalysisDependency);
  return currentDependency?.status === "unknown" && currentDependency.reasons.includes("migration")
    ? combineAiAnalysisDependencies([
        proofUnknown,
        Object.freeze({
          status: "unknown",
          reasons: Object.freeze(["migration"]),
        } satisfies AiAnalysisDependency),
      ])
    : normalizeAiAnalysisDependency(proofUnknown);
}

function activeProofForPreservedEdge(
  proof: RelationCandidateDecisionProof,
  edge: ReconciledGraphEdge,
  dependency: AiAnalysisDependency,
): RelationCandidateDecisionProof {
  return Object.freeze({
    candidateId: proof.candidateId,
    endpointNodeIds: proof.endpointNodeIds,
    authority: proof.authority,
    resolution: Object.freeze({
      candidateId: proof.candidateId,
      status: "active",
      edgeId: proof.candidateId,
    }),
    dependency,
    canonicalRelation: Object.freeze({
      type: edge.type,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
    }),
  });
}

function pendingProofForPreservedInactiveEdge(
  proof: RelationCandidateDecisionProof,
  dependency: AiAnalysisDependency,
): RelationCandidateDecisionProof {
  return Object.freeze({
    candidateId: proof.candidateId,
    endpointNodeIds: proof.endpointNodeIds,
    authority: proof.authority,
    resolution: Object.freeze({
      candidateId: proof.candidateId,
      status: "pending",
      reason: "assessment_missing",
    }),
    dependency,
  });
}

/** 未確認の前回辺を保持して候補判定の証明を整える。 */
export function preserveUnverifiedGraphEdges(
  collection: CollectedItems,
  previousEdges: readonly ReconciledGraphEdge[],
  reconciledEdges: readonly ReconciledGraphEdge[],
  candidates: readonly RelationCandidate[],
  candidateDecisionProofs: readonly RelationCandidateDecisionProof[],
): Readonly<{
  edges: readonly ReconciledGraphEdge[];
  relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
  candidateResolutions: readonly RelationCandidateResolution[];
  candidateDecisionProofs: readonly RelationCandidateDecisionProof[];
}> {
  const staleNodeIds = new Set<string>(collection.staleItems.map((item) => item.nodeId));
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const detailsByNodeId = new Map<GraphNodeId, GitHubItemDetail>(
    collection.details.map((detail) => [detail.nodeId, detail]),
  );
  const selection = nativeRelationEndpointSelection(collection);
  const obsoleteEdgeIds = obsoleteNativeEdgeIds(
    collection,
    previousEdges,
    candidates,
    detailsByNodeId,
  );
  const preservedEdges = new Map(
    previousEdges
      .filter((edge) => {
        if (obsoleteEdgeIds.has(edge.id)) {
          return false;
        }
        if (edge.provenance !== "native") {
          return staleNodeIds.has(edge.fromNodeId) || staleNodeIds.has(edge.toNodeId);
        }
        if (candidatesById.has(edge.id)) {
          return false;
        }
        return !nativeRelationSourcesProveAbsence(
          nativeRelationSourceObservations(edge, detailsByNodeId, selection),
        );
      })
      .map((edge) => [edge.id, edge]),
  );
  const proofsByCandidateId = new Map(
    candidateDecisionProofs.map((proof) => [proof.candidateId, proof]),
  );
  const preservedSourceDependencies = new Map<RelationCandidateId, AiAnalysisDependency>();
  const result = reconciledEdges
    .filter((edge) => !obsoleteEdgeIds.has(edge.id))
    .map((edge) => {
      const preserved = preservedEdges.get(edge.id);
      if (preserved == null) {
        return edge;
      }
      if (preserved.provenance === "native") {
        return preserved;
      }
      const proof = proofsByCandidateId.get(preserved.id);
      const candidate = candidatesById.get(preserved.id);
      const candidateNodes: readonly RelationCandidateNode[] =
        candidate == null ? Object.freeze([]) : relationNodes(candidate.relation);
      const assessmentOwnerNodeId =
        candidate == null ? undefined : relationAssessmentOwnerNodeId(candidate);
      const assessmentOwner =
        candidate == null
          ? undefined
          : candidateNodes.find((node) => node.nodeId === assessmentOwnerNodeId);
      if (candidate != null) {
        assertNonNullable(
          assessmentOwner,
          `関係候補 ${candidate.id}のAI判定owner nodeがありません`,
        );
      }
      const organizationCandidateNodes = candidateNodes.filter(isOrganizationRelationCandidateNode);
      const fallbackProducerNode =
        organizationCandidateNodes.find((node) => node.nodeId === assessmentOwnerNodeId) ??
        organizationCandidateNodes[0];
      if (candidate != null) {
        assertNonNullable(
          fallbackProducerNode,
          `関係候補 ${candidate.id}のOrganization側nodeがありません`,
        );
      }
      const fallbackProducer =
        fallbackProducerNode == null
          ? undefined
          : Object.freeze({
              kind: "item_element",
              nodeId: fallbackProducerNode.nodeId,
              element: "relations",
            } satisfies AiAnalysisDependencyProducer);
      if (!preserved.active) {
        if (!edge.active) {
          return preserved;
        }
        const sourceDependency = downgradedPreservedRelationDependency(
          preserved,
          proof?.dependency,
          fallbackProducer,
        );
        if (sourceDependency == null) {
          return preserved;
        }
        preservedSourceDependencies.set(preserved.id, sourceDependency);
        return Object.freeze({
          ...preserved,
          aiDependency: aiAnalysisDependencyForRelation(preserved.id, sourceDependency),
        });
      }
      const sourceDependency = downgradedPreservedRelationDependency(
        preserved,
        proof?.dependency,
        fallbackProducer,
      );
      if (sourceDependency == null) {
        return preserved;
      }
      preservedSourceDependencies.set(preserved.id, sourceDependency);
      return Object.freeze({
        ...preserved,
        aiDependency: aiAnalysisDependencyForRelation(preserved.id, sourceDependency),
      });
    });
  const resultIds = new Set(result.map((edge) => edge.id));
  for (const edgeId of preservedEdges.keys()) {
    if (!resultIds.has(edgeId)) {
      throw new TypeError(`保持すべき前回edgeがありません。対象: ${edgeId}`);
    }
  }
  const normalizedCandidateDecisionProofs = candidateDecisionProofs.map((proof) => {
    const preserved = preservedEdges.get(proof.candidateId);
    if (preserved == null || preserved.provenance === "native") {
      return proof;
    }
    if (!preserved.active) {
      if (proof.resolution.status !== "active") {
        return proof;
      }
      const sourceDependency = preservedSourceDependencies.get(proof.candidateId);
      assertNonNullable(
        sourceDependency,
        `inactive stale edgeの降格済みAI依存がありません。対象: ${proof.candidateId}`,
      );
      return pendingProofForPreservedInactiveEdge(proof, sourceDependency);
    }
    const sourceDependency = preservedSourceDependencies.get(proof.candidateId);
    assertNonNullable(
      sourceDependency,
      `active stale edgeの降格済みAI依存がありません。対象: ${proof.candidateId}`,
    );
    return activeProofForPreservedEdge(proof, preserved, sourceDependency);
  });
  return Object.freeze({
    edges: Object.freeze(result),
    relationCandidateAiDependencies: new Map(
      normalizedCandidateDecisionProofs.map((proof) => [proof.candidateId, proof.dependency]),
    ),
    candidateResolutions: Object.freeze(
      normalizedCandidateDecisionProofs.map((proof) => proof.resolution),
    ),
    candidateDecisionProofs: Object.freeze(normalizedCandidateDecisionProofs),
  });
}

/** 利用可能な両端を持つグラフ辺を保持する。 */
export function retainGraphEdgesForAvailableNodes(
  edges: readonly ReconciledGraphEdge[],
  availableNodeIds: ReadonlySet<string>,
): readonly ReconciledGraphEdge[] {
  const retainedEdges: ReconciledGraphEdge[] = [];
  for (const edge of edges) {
    const endpointsAvailable =
      availableNodeIds.has(edge.fromNodeId) && availableNodeIds.has(edge.toNodeId);
    if (endpointsAvailable) {
      retainedEdges.push(edge);
    }
  }
  return Object.freeze(retainedEdges);
}

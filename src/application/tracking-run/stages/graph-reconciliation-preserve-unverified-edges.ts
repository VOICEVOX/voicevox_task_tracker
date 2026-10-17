import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import {
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForRelation,
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
} from "../../../domain/ai-analysis-dependencies.js";
import type { GraphNodeId } from "../../../domain/index.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
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
import type {
  GraphWorkingCollection,
  PendingGraphTrackedItem,
} from "./graph-reconciliation-contracts.js";
import {
  nativeRelationEndpointSelection,
  nativeRelationSourceObservations,
  nativeRelationSourcesProveAbsence,
  obsoleteNativeEdgeIds,
} from "./graph-reconciliation-native-edge-validity.js";

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

function preservedRelationDependencyMatchesCurrentOwner(
  edge: ReconciledGraphEdge,
  dependency: AiAnalysisDependency,
  candidate: RelationCandidate,
  itemsByNodeId: ReadonlyMap<GraphNodeId, PendingGraphTrackedItem>,
  staleNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  if (staleNodeIds.has(edge.fromNodeId) || staleNodeIds.has(edge.toNodeId)) {
    return true;
  }
  const owner = itemsByNodeId.get(relationAssessmentOwnerNodeId(candidate));
  if (owner == null) {
    return false;
  }
  const currentDependency = aiAnalysisDependencyForApplication(
    owner.nodeId,
    "relations",
    owner.aiAnalysis.applications.relations,
  );
  return (
    currentDependency.status !== "not_dependent" &&
    serializeCanonicalJson(dependency) ===
      serializeCanonicalJson(aiAnalysisDependencyForRelation(edge.id, currentDependency))
  );
}

/** 未確認の前回辺を保持して候補判定の証明を整える。 */
export function preserveUnverifiedGraphEdges(
  collection: GraphWorkingCollection,
  items: readonly PendingGraphTrackedItem[],
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
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const detailsByNodeId = new Map<GraphNodeId, GitHubItemDetail>(
    collection.details.map((detail) => [detail.nodeId, detail]),
  );
  const itemsByNodeId = new Map<GraphNodeId, PendingGraphTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const staleNodeIds = new Set<GraphNodeId>(collection.staleItems.map((item) => item.nodeId));
  const selection = nativeRelationEndpointSelection(collection);
  const obsoleteEdgeIds = obsoleteNativeEdgeIds(
    collection,
    previousEdges,
    candidates,
    detailsByNodeId,
  );
  const proofsByCandidateId = new Map(
    candidateDecisionProofs.map((proof) => [proof.candidateId, proof]),
  );
  const preservedEdges = new Map(
    previousEdges
      .filter((edge) => {
        if (obsoleteEdgeIds.has(edge.id)) {
          return false;
        }
        if (edge.provenance !== "native") {
          const candidate = candidatesById.get(edge.id);
          const resolution = proofsByCandidateId.get(edge.id)?.resolution;
          return (
            edge.active &&
            candidate?.authority === "inferred" &&
            resolution?.status === "pending" &&
            resolution.reason === "assessment_missing"
          );
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
      assertNonNullable(candidate, `保持対象の関係候補 ${preserved.id}がありません`);
      const candidateNodes: readonly RelationCandidateNode[] = relationNodes(candidate.relation);
      const assessmentOwnerNodeId = relationAssessmentOwnerNodeId(candidate);
      const assessmentOwner = candidateNodes.find((node) => node.nodeId === assessmentOwnerNodeId);
      assertNonNullable(assessmentOwner, `関係候補 ${candidate.id}のAI判定owner nodeがありません`);
      const organizationCandidateNodes = candidateNodes.filter(isOrganizationRelationCandidateNode);
      const fallbackProducerNode =
        organizationCandidateNodes.find((node) => node.nodeId === assessmentOwnerNodeId) ??
        organizationCandidateNodes[0];
      assertNonNullable(
        fallbackProducerNode,
        `関係候補 ${candidate.id}のOrganization側nodeがありません`,
      );
      const fallbackProducer = Object.freeze({
        kind: "item_element",
        nodeId: fallbackProducerNode.nodeId,
        element: "relations",
      } satisfies AiAnalysisDependencyProducer);
      const sourceDependency = downgradedPreservedRelationDependency(
        preserved,
        proof?.dependency,
        fallbackProducer,
      );
      assertNonNullable(
        sourceDependency,
        `active stale edgeの降格済みAI依存がありません。対象: ${preserved.id}`,
      );
      const dependency = aiAnalysisDependencyForRelation(preserved.id, sourceDependency);
      if (
        !preservedRelationDependencyMatchesCurrentOwner(
          preserved,
          dependency,
          candidate,
          itemsByNodeId,
          staleNodeIds,
        )
      ) {
        return edge;
      }
      preservedSourceDependencies.set(preserved.id, sourceDependency);
      return Object.freeze({
        ...preserved,
        aiDependency: dependency,
      });
    });
  const resultIds = new Set(result.map((edge) => edge.id));
  for (const edgeId of preservedEdges.keys()) {
    if (!resultIds.has(edgeId)) {
      throw new TypeError(`保持すべき前回edgeがありません。対象: ${edgeId}`);
    }
  }
  const normalizedCandidateDecisionProofs = candidateDecisionProofs.map((proof) => {
    const sourceDependency = preservedSourceDependencies.get(proof.candidateId);
    if (sourceDependency == null) {
      return proof;
    }
    const preserved = preservedEdges.get(proof.candidateId);
    assertNonNullable(preserved, `保持した推定edgeがありません。対象: ${proof.candidateId}`);
    return activeProofForPreservedEdge(proof, preserved, sourceDependency);
  });
  return Object.freeze({
    edges: Object.freeze(result),
    relationCandidateAiDependencies: new Map(
      candidateDecisionProofs.map((proof) => [proof.candidateId, proof.dependency]),
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

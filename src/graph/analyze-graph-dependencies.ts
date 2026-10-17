import {
  aiAnalysisDependencyForRelationCandidate,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
  type GraphNodeId,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  analyzeNegativeImpactContributors,
  analyzePositiveImpactContributors,
  appendDependency,
  crossFamilyInteractionNodeIds,
  interactionNodeIds,
  mergeImpactContributorAnalysis,
} from "./analyze-graph-contributors.js";
import {
  compareStrings,
  type ActiveGraphEdge,
  type BlocksArc,
  type ImpactAnalysis,
  type PotentialBlocksArc,
} from "./analyze-graph-core.js";
import { blocksArcKey, preferIndependentAiDependencies } from "./analyze-graph-support-arcs.js";
import {
  type BlockerNodeAiDependency,
  type BlockerSetAiDependency,
  type GraphAnalysisNode,
  type NegativeBlockerAiDependency,
  type RelationSetAiDependency,
} from "./analyze-graph-types.js";
import {
  type ReconciledGraphEdge,
  type RelationCandidateDecisionProof,
} from "./reconcile-graph-types.js";

/** block関係ごとのAI依存を算出する。 */
export function blocksArcDependencies(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  edges: readonly ActiveGraphEdge[],
  potentialArcs: readonly PotentialBlocksArc[],
): Readonly<{
  blockerSetAiDependencies: readonly BlockerSetAiDependency[];
  blockerNodeAiDependencies: readonly BlockerNodeAiDependency[];
  negativeBlockerAiDependencies: readonly NegativeBlockerAiDependency[];
}> {
  const supportsByArc = new Map<
    string,
    Readonly<{ arc: BlocksArc; supports: ActiveGraphEdge[] }>
  >();
  for (const edge of edges) {
    const arc = Object.freeze({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId });
    const key = blocksArcKey(arc);
    const group = supportsByArc.get(key);
    if (group == null) {
      supportsByArc.set(key, Object.freeze({ arc, supports: [edge] }));
      continue;
    }
    group.supports.push(edge);
  }
  const candidatesByArc = new Map<
    string,
    Readonly<{ arc: BlocksArc; candidates: PotentialBlocksArc[] }>
  >();
  for (const arc of potentialArcs) {
    const key = blocksArcKey(arc);
    const group = candidatesByArc.get(key);
    if (group == null) {
      candidatesByArc.set(key, Object.freeze({ arc, candidates: [arc] }));
      continue;
    }
    group.candidates.push(arc);
  }
  const supportsByBlockedNodeId = new Map<
    GraphNodeId,
    Readonly<{ arc: BlocksArc; supports: ActiveGraphEdge[] }>[]
  >();
  for (const group of supportsByArc.values()) {
    const groups = supportsByBlockedNodeId.get(group.arc.toNodeId);
    if (groups == null) {
      supportsByBlockedNodeId.set(group.arc.toNodeId, [group]);
      continue;
    }
    groups.push(group);
  }
  const negativeByBlockedNodeId = new Map<
    GraphNodeId,
    Readonly<{ arc: BlocksArc; candidates: PotentialBlocksArc[] }>[]
  >();
  for (const group of candidatesByArc.values()) {
    if (supportsByArc.has(blocksArcKey(group.arc))) {
      continue;
    }
    const presenceCandidates = group.candidates.filter((candidate) => candidate.affectsPresence);
    if (presenceCandidates.length === 0) {
      continue;
    }
    const presenceGroup = Object.freeze({ arc: group.arc, candidates: presenceCandidates });
    const groups = negativeByBlockedNodeId.get(group.arc.toNodeId);
    if (groups == null) {
      negativeByBlockedNodeId.set(group.arc.toNodeId, [presenceGroup]);
      continue;
    }
    groups.push(presenceGroup);
  }
  const blockedNodeIds = new Set<GraphNodeId>(nodesById.keys());
  const blockerSetAiDependencies: BlockerSetAiDependency[] = [];
  const blockerNodeAiDependencies: BlockerNodeAiDependency[] = [];
  const negativeBlockerAiDependencies: NegativeBlockerAiDependency[] = [];
  for (const nodeId of [...blockedNodeIds].sort(compareStrings)) {
    const presenceDependencies: AiAnalysisDependency[] = [];
    for (const group of supportsByBlockedNodeId.get(nodeId) ?? []) {
      const potentialSupports = candidatesByArc.get(blocksArcKey(group.arc))?.candidates ?? [];
      const presence = preferIndependentAiDependencies(
        group.supports.map((support) => support.aiDependency),
      );
      presenceDependencies.push(presence);
      const maximumConfidence = Math.max(...group.supports.map((support) => support.confidence));
      const maximumConfidenceDependency = preferIndependentAiDependencies(
        group.supports
          .filter((support) => support.confidence === maximumConfidence)
          .map((support) => support.aiDependency),
      );
      const confidenceDependencies = [maximumConfidenceDependency];
      const hasHardMaximumConfidence = group.supports.some(
        (support) => support.confidence === 1 && support.aiDependency.status === "not_dependent",
      );
      if (!hasHardMaximumConfidence) {
        confidenceDependencies.push(
          ...group.supports
            .filter(
              (support) =>
                support.confidence < maximumConfidence &&
                (support.aiDependency.status === "unverified" ||
                  support.aiDependency.status === "unknown"),
            )
            .map((support) => support.aiDependency),
          ...potentialSupports.map((support) => support.dependency),
        );
      }
      const confidence = combineAiAnalysisDependencies(confidenceDependencies);
      const sourceIds = combineAiAnalysisDependencies(
        group.supports
          .map((support) => support.aiDependency)
          .concat(potentialSupports.map((support) => support.dependency)),
      );
      const nativeSupports = group.supports.filter((support) => support.provenance === "native");
      const firstSupport = group.supports[0];
      assertNonNullable(firstSupport, `blocker ${group.arc.fromNodeId}のsupportがありません`);
      const earliestFirstSeenAt = group.supports.reduce(
        (earliest, support) => (support.firstSeenAt < earliest ? support.firstSeenAt : earliest),
        firstSupport.firstSeenAt,
      );
      const currentBecameBlockingAt = preferIndependentAiDependencies(
        (nativeSupports.length === 0
          ? group.supports.filter((support) => support.firstSeenAt === earliestFirstSeenAt)
          : nativeSupports
        ).map((support) => support.aiDependency),
      );
      const becameBlockingAtPotentialDependencies =
        nativeSupports.length === 0
          ? potentialSupports
              .filter(
                (support) =>
                  support.firstSeenAt.status === "unknown" ||
                  support.firstSeenAt.value < earliestFirstSeenAt,
              )
              .map((support) => support.dependency)
          : [];
      const becameBlockingAt = combineAiAnalysisDependencies([
        currentBecameBlockingAt,
        ...becameBlockingAtPotentialDependencies,
      ]);
      blockerNodeAiDependencies.push(
        Object.freeze({
          blockedNodeId: nodeId,
          blockerNodeId: group.arc.fromNodeId,
          presence,
          confidence,
          sourceIds,
          becameBlockingAt,
        }),
      );
    }
    const negativeDependencies: AiAnalysisDependency[] = [];
    for (const group of negativeByBlockedNodeId.get(nodeId) ?? []) {
      negativeDependencies.push(
        combineAiAnalysisDependencies(group.candidates.map((arc) => arc.dependency)),
      );
    }
    const negativeDependency =
      negativeDependencies.length === 0
        ? Object.freeze({ status: "not_dependent" })
        : combineAiAnalysisDependencies(negativeDependencies);
    presenceDependencies.push(negativeDependency);
    const dependency = combineAiAnalysisDependencies(presenceDependencies);
    blockerSetAiDependencies.push(Object.freeze({ nodeId, dependency }));
    negativeBlockerAiDependencies.push(Object.freeze({ nodeId, dependency: negativeDependency }));
  }
  blockerSetAiDependencies.sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  blockerNodeAiDependencies.sort((left, right) => {
    const blockedOrder = compareStrings(left.blockedNodeId, right.blockedNodeId);
    if (blockedOrder !== 0) {
      return blockedOrder;
    }
    return compareStrings(left.blockerNodeId, right.blockerNodeId);
  });
  negativeBlockerAiDependencies.sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  return Object.freeze({
    blockerSetAiDependencies: Object.freeze(blockerSetAiDependencies),
    blockerNodeAiDependencies: Object.freeze(blockerNodeAiDependencies),
    negativeBlockerAiDependencies: Object.freeze(negativeBlockerAiDependencies),
  });
}

function relationKey(
  relation: Readonly<{
    fromNodeId: GraphNodeId;
    toNodeId: GraphNodeId;
    type: ReconciledGraphEdge["type"];
  }>,
): string {
  return JSON.stringify([relation.type, relation.fromNodeId, relation.toNodeId]);
}

/** relation集合のAI依存を算出する。 */
export function relationSetAiDependencies(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  activeEdges: readonly ActiveGraphEdge[],
  proofs: readonly RelationCandidateDecisionProof[],
): readonly RelationSetAiDependency[] {
  const proofByCandidateId = new Map(proofs.map((proof) => [proof.candidateId, proof]));
  const supportsByRelation = new Map<
    string,
    Readonly<{
      endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
      dependencies: AiAnalysisDependency[];
    }>
  >();
  const candidateDependencies: Readonly<{
    endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
    dependency: AiAnalysisDependency;
  }>[] = proofs
    .filter((proof) => proof.authority === "inferred")
    .map((proof) =>
      Object.freeze({
        endpointNodeIds: proof.endpointNodeIds,
        dependency: aiAnalysisDependencyForRelationCandidate(
          proof.candidateId,
          proof.endpointNodeIds,
          proof.dependency,
        ),
      }),
    );
  for (const proof of proofs) {
    if (proof.resolution.status !== "active") {
      continue;
    }
    const canonicalRelation = proof.canonicalRelation;
    assertNonNullable(
      canonicalRelation,
      `active relation ${proof.candidateId}のcanonical relationがありません`,
    );
    const key = relationKey(canonicalRelation);
    const dependency = aiAnalysisDependencyForRelationCandidate(
      proof.candidateId,
      proof.endpointNodeIds,
      proof.dependency,
    );
    const existing = supportsByRelation.get(key);
    if (existing == null) {
      supportsByRelation.set(
        key,
        Object.freeze({ endpointNodeIds: proof.endpointNodeIds, dependencies: [dependency] }),
      );
    } else {
      existing.dependencies.push(dependency);
    }
  }
  for (const edge of activeEdges) {
    if (proofByCandidateId.has(edge.id)) {
      continue;
    }
    const key = relationKey(edge);
    const endpointNodeIds: readonly [GraphNodeId, GraphNodeId] = [edge.fromNodeId, edge.toNodeId];
    const existing = supportsByRelation.get(key);
    if (existing == null) {
      supportsByRelation.set(
        key,
        Object.freeze({ endpointNodeIds, dependencies: [edge.aiDependency] }),
      );
    } else {
      existing.dependencies.push(edge.aiDependency);
    }
  }
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  for (const support of supportsByRelation.values()) {
    const dependency = preferIndependentAiDependencies(support.dependencies);
    for (const endpointNodeId of support.endpointNodeIds) {
      appendDependency(dependenciesByNodeId, endpointNodeId, dependency);
    }
  }
  for (const candidate of candidateDependencies) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      appendDependency(dependenciesByNodeId, endpointNodeId, candidate.dependency);
    }
  }
  return Object.freeze(
    [...nodesById.keys()].sort(compareStrings).map((nodeId) => {
      const dependencies = dependenciesByNodeId.get(nodeId);
      return Object.freeze({
        nodeId,
        dependency:
          dependencies == null
            ? Object.freeze({ status: "not_dependent" })
            : combineAiAnalysisDependencies(dependencies),
      });
    }),
  );
}

/** 候補関係を含む下流影響のAI依存を算出する。 */
export function downstreamImpactAiDependenciesWithCandidates(
  nodesById: ReadonlyMap<GraphNodeId, GraphAnalysisNode>,
  base: ImpactAnalysis,
  positiveEdges: readonly ActiveGraphEdge[],
  potentialArcs: readonly PotentialBlocksArc[],
): readonly Readonly<{ nodeId: GraphNodeId; dependency: AiAnalysisDependency }>[] {
  const negativeArcs = potentialArcs.filter((arc) => arc.affectsPresence);
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  const unknownPositiveEdges = positiveEdges.filter(
    (edge) => edge.aiDependency.status === "unknown",
  );
  const unverifiedPositiveEdges = positiveEdges.filter(
    (edge) => edge.aiDependency.status === "unverified",
  );
  const currentPositiveEdges = positiveEdges.filter(
    (edge) => edge.aiDependency.status === "current",
  );
  const unknownNegativeArcs = negativeArcs.filter((arc) => arc.dependency.status === "unknown");
  const unverifiedNegativeArcs = negativeArcs.filter(
    (arc) => arc.dependency.status === "unverified",
  );
  const currentNegativeArcs = negativeArcs.filter((arc) => arc.dependency.status === "current");

  const unknownRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status !== "unknown"),
    unknownPositiveEdges,
  );
  const unverifiedRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status !== "unverified"),
    unverifiedPositiveEdges,
  );
  const unknownUnverifiedRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter(
      (edge) => edge.aiDependency.status !== "unknown" && edge.aiDependency.status !== "unverified",
    ),
    [...unknownPositiveEdges, ...unverifiedPositiveEdges],
  );
  const currentRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status !== "current"),
    currentPositiveEdges,
  );
  const allAiRemoval = analyzePositiveImpactContributors(
    nodesById,
    base,
    positiveEdges.filter((edge) => edge.aiDependency.status === "not_dependent"),
    [...unknownPositiveEdges, ...unverifiedPositiveEdges, ...currentPositiveEdges],
  );
  const unknownAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    unknownNegativeArcs,
  );
  const unverifiedAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    unverifiedNegativeArcs,
  );
  const unknownUnverifiedAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    [...unknownNegativeArcs, ...unverifiedNegativeArcs],
  );
  const currentAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    currentNegativeArcs,
  );
  const allAiAddition = analyzeNegativeImpactContributors(
    nodesById,
    base,
    positiveEdges,
    negativeArcs,
  );

  const changedByUnknownRemoval = unknownRemoval.nodeIds;
  const changedByUnverifiedRemoval = unverifiedRemoval.nodeIds;
  const changedByUnknownUnverifiedRemoval = unknownUnverifiedRemoval.nodeIds;
  const changedByCurrentRemoval = currentRemoval.nodeIds;
  const changedByAllAiRemoval = allAiRemoval.nodeIds;
  const changedByUnknownAddition = unknownAddition.nodeIds;
  const changedByUnverifiedAddition = unverifiedAddition.nodeIds;
  const changedByUnknownUnverifiedAddition = unknownUnverifiedAddition.nodeIds;
  const changedByCurrentAddition = currentAddition.nodeIds;
  const changedByAllAiAddition = allAiAddition.nodeIds;

  mergeImpactContributorAnalysis(dependenciesByNodeId, unknownRemoval, changedByUnknownRemoval);
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unverifiedRemoval,
    changedByUnverifiedRemoval,
  );
  mergeImpactContributorAnalysis(dependenciesByNodeId, currentRemoval, changedByCurrentRemoval);
  mergeImpactContributorAnalysis(dependenciesByNodeId, unknownAddition, changedByUnknownAddition);
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unverifiedAddition,
    changedByUnverifiedAddition,
  );
  mergeImpactContributorAnalysis(dependenciesByNodeId, currentAddition, changedByCurrentAddition);

  const unknownUnverifiedRemovalInteractionNodeIds = interactionNodeIds(
    changedByUnknownUnverifiedRemoval,
    [changedByUnknownRemoval, changedByUnverifiedRemoval],
  );
  const unknownUnverifiedAdditionInteractionNodeIds = interactionNodeIds(
    changedByUnknownUnverifiedAddition,
    [changedByUnknownAddition, changedByUnverifiedAddition],
  );
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unknownUnverifiedRemoval,
    unknownUnverifiedRemovalInteractionNodeIds,
  );
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    unknownUnverifiedAddition,
    unknownUnverifiedAdditionInteractionNodeIds,
  );

  const allAiRemovalUnknownFamilyNodeIds = new Set<GraphNodeId>([
    ...changedByUnknownRemoval,
    ...changedByUnverifiedRemoval,
    ...changedByUnknownUnverifiedRemoval,
  ]);
  const allAiRemovalInteractionNodeIds = crossFamilyInteractionNodeIds(changedByAllAiRemoval, [
    allAiRemovalUnknownFamilyNodeIds,
    changedByCurrentRemoval,
  ]);
  const allAiAdditionUnknownFamilyNodeIds = new Set<GraphNodeId>([
    ...changedByUnknownAddition,
    ...changedByUnverifiedAddition,
    ...changedByUnknownUnverifiedAddition,
  ]);
  const allAiAdditionInteractionNodeIds = crossFamilyInteractionNodeIds(changedByAllAiAddition, [
    allAiAdditionUnknownFamilyNodeIds,
    changedByCurrentAddition,
  ]);
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    allAiRemoval,
    allAiRemovalInteractionNodeIds,
  );
  mergeImpactContributorAnalysis(
    dependenciesByNodeId,
    allAiAddition,
    allAiAdditionInteractionNodeIds,
  );

  return Object.freeze(
    [...nodesById.keys()].sort(compareStrings).map((nodeId) => {
      const dependencies = dependenciesByNodeId.get(nodeId);
      const dependency =
        dependencies == null
          ? Object.freeze({ status: "not_dependent" })
          : combineAiAnalysisDependencies(dependencies);
      return Object.freeze({ nodeId, dependency });
    }),
  );
}

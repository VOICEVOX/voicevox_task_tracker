import {
  aiAnalysisDependencyForRelationCandidate,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
} from "../domain/index.js";
import { UnreachableError, assertNonNullable } from "../util/index.js";
import {
  compareGraphEdges,
  compareStrings,
  isOpenNode,
  type ActiveGraphEdge,
  type BlocksArc,
  type IndexedSnapshot,
  type PotentialBlocksArc,
} from "./analyze-graph-core.js";
import type { RelationCandidateDecisionProof } from "./reconcile-graph-types.js";

/** block関係の端点から同一性keyを作る。 */
export function blocksArcKey(arc: BlocksArc): string {
  return JSON.stringify(["blocks", arc.fromNodeId, arc.toNodeId]);
}

/** 同じblock関係を支える根拠を正規化する。 */
export function normalizePositiveSupportArcs(
  edges: readonly ActiveGraphEdge[],
): readonly ActiveGraphEdge[] {
  const supportsByArc = new Map<string, ActiveGraphEdge[]>();
  for (const edge of [...edges].sort(compareGraphEdges)) {
    const key = blocksArcKey(edge);
    const supports = supportsByArc.get(key);
    if (supports == null) {
      supportsByArc.set(key, [edge]);
      continue;
    }
    supports.push(edge);
  }
  const normalized: ActiveGraphEdge[] = [];
  for (const supports of supportsByArc.values()) {
    const firstSupport = supports[0];
    assertNonNullable(firstSupport, "positive supportがありません");
    let preferredPriority = dependencyStatusPriority(firstSupport.aiDependency.status);
    for (const support of supports.slice(1)) {
      const priority = dependencyStatusPriority(support.aiDependency.status);
      if (priority < preferredPriority) {
        preferredPriority = priority;
      }
    }
    const preferredSupports = supports.filter(
      (support) => dependencyStatusPriority(support.aiDependency.status) === preferredPriority,
    );
    const representative = preferredSupports[0];
    assertNonNullable(representative, "positive supportの最良supportがありません");
    normalized.push(
      Object.freeze({
        ...representative,
        aiDependency: combineAiAnalysisDependencies(
          preferredSupports.map((support) => support.aiDependency),
        ),
      }),
    );
  }
  return Object.freeze(normalized.sort(compareGraphEdges));
}

/** block関係を端点ごとに一意へそろえる。 */
export function uniqueBlocksArcs(arcs: readonly BlocksArc[]): readonly BlocksArc[] {
  return Object.freeze(
    [...new Map(arcs.map((arc) => [blocksArcKey(arc), arc])).values()].sort((left, right) =>
      compareStrings(blocksArcKey(left), blocksArcKey(right)),
    ),
  );
}

/** 候補判定から潜在的なblock関係を作る。 */
export function potentialBlocksArcs(
  current: IndexedSnapshot,
  proofs: readonly RelationCandidateDecisionProof[],
): readonly PotentialBlocksArc[] {
  const existingArcKeys = new Set(
    current.effectiveBlocksEdges.map((edge) =>
      blocksArcKey({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }),
    ),
  );
  const arcs: PotentialBlocksArc[] = [];
  for (const proof of proofs) {
    if (proof.authority !== "inferred") {
      continue;
    }
    if (proof.resolution.status === "rejected" && proof.resolution.reason === "blocker_not_open") {
      continue;
    }
    const [firstEndpoint, secondEndpoint] = proof.endpointNodeIds;
    const firstNode = current.nodesById.get(firstEndpoint);
    const secondNode = current.nodesById.get(secondEndpoint);
    if (
      firstNode == null ||
      secondNode == null ||
      !isOpenNode(firstNode) ||
      !isOpenNode(secondNode)
    ) {
      continue;
    }
    const possibleArcs: readonly BlocksArc[] = Object.freeze([
      Object.freeze({ fromNodeId: firstEndpoint, toNodeId: secondEndpoint }),
      Object.freeze({ fromNodeId: secondEndpoint, toNodeId: firstEndpoint }),
    ]);
    const persistedEdge = current.edgesById.get(proof.candidateId);
    if (
      persistedEdge != null &&
      !(
        (persistedEdge.fromNodeId === firstEndpoint && persistedEdge.toNodeId === secondEndpoint) ||
        (persistedEdge.fromNodeId === secondEndpoint && persistedEdge.toNodeId === firstEndpoint)
      )
    ) {
      throw new TypeError(`関係候補 ${proof.candidateId}のendpointがcurrent edgeと一致しません`);
    }
    if (persistedEdge?.provenance === "native") {
      throw new TypeError(`関係候補 ${proof.candidateId}がnative edge IDと衝突しています`);
    }
    const firstSeenAt =
      persistedEdge == null
        ? Object.freeze({ status: "unknown" })
        : Object.freeze({ status: "known", value: persistedEdge.firstSeenAt });
    for (const arc of possibleArcs) {
      const canonicalRelation = proof.canonicalRelation;
      if (
        canonicalRelation?.type === "blocks" &&
        canonicalRelation.fromNodeId === arc.fromNodeId &&
        canonicalRelation.toNodeId === arc.toNodeId
      ) {
        continue;
      }
      arcs.push(
        Object.freeze({
          ...arc,
          candidateId: proof.candidateId,
          affectsPresence: !existingArcKeys.has(blocksArcKey(arc)),
          firstSeenAt,
          dependency: aiAnalysisDependencyForRelationCandidate(
            proof.candidateId,
            proof.endpointNodeIds,
            proof.dependency,
          ),
        }),
      );
    }
  }
  return Object.freeze(
    arcs.sort((left, right) => {
      const candidateOrder = compareStrings(left.candidateId, right.candidateId);
      if (candidateOrder !== 0) {
        return candidateOrder;
      }
      return compareStrings(blocksArcKey(left), blocksArcKey(right));
    }),
  );
}

function dependencyStatusPriority(status: AiAnalysisDependency["status"]): number {
  switch (status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(status);
  }
}

/** AI依存の弱い根拠を優先して結合する。 */
export function preferIndependentAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    throw new TypeError("AI依存の選択対象がありません");
  }
  const preferredPriority = Math.min(
    ...dependencies.map((dependency) => dependencyStatusPriority(dependency.status)),
  );
  return combineAiAnalysisDependencies(
    dependencies.filter(
      (dependency) => dependencyStatusPriority(dependency.status) === preferredPriority,
    ),
  );
}

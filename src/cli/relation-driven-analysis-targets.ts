import { hashCanonicalJson } from "../canonical-json/index.js";
import type { AiAnalysisDependencyProducer } from "../domain/ai-analysis-dependencies.js";
import type { GitHubNodeId, GraphNodeId, Relation, TrackedItemState } from "../domain/index.js";
import type { FreshObservedGitHubItem, GitHubItemDetail } from "../github/index.js";
import type { RelationCandidate } from "../graph/index.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../graph/relation-candidate-endpoints.js";
import { snapshotEffectiveGraphStateByNodeId, type StateSnapshot } from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";

type PreviousRelationCandidateDependencyProducer = Extract<
  AiAnalysisDependencyProducer,
  { kind: "relation_candidate" }
>;

type PotentialBlockerRelationAnalysis = Readonly<{
  candidateId: string;
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  targetNodeIds: readonly GitHubNodeId[];
  ownerNodeId: GitHubNodeId | undefined;
  native: boolean;
}>;

type BlockerRelationAnalysisIndex = Readonly<{
  candidatesById: ReadonlyMap<string, PotentialBlockerRelationAnalysis>;
  candidateIdsByTargetNodeId: ReadonlyMap<GitHubNodeId, ReadonlySet<string>>;
}>;

type BlockerRelationAnalysisTargets = Readonly<{
  freshNodeIds: ReadonlySet<GitHubNodeId>;
  staleNodeIds: ReadonlySet<GitHubNodeId>;
}>;

type BlockerRelationAnalysisInput = Readonly<{
  snapshot: StateSnapshot | undefined;
  relationCandidates: readonly RelationCandidate[];
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  initialAnalysisNodeIds: ReadonlySet<GitHubNodeId>;
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
  observedItemsByNodeId: ReadonlyMap<GitHubNodeId, FreshObservedGitHubItem>;
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>;
  staleNodeIds: ReadonlySet<GitHubNodeId>;
  previousRelationCandidateDependencyProducers: () => readonly PreviousRelationCandidateDependencyProducer[];
  currentNativeStatesByStaleNodeId: () => ReadonlyMap<GitHubNodeId, TrackedItemState>;
  previousStaleRepositoryBlockerTopologyNodeIds: () => ReadonlySet<GitHubNodeId>;
}>;

/** blocker関係候補の端点を正規化する。 */
export function normalizedBlockerRelationEndpointNodeIds(
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
): readonly [GraphNodeId, GraphNodeId] {
  const [first, second] = endpointNodeIds;
  if (first === second) {
    throw new TypeError(`blocker関係候補の端点が重複しています。対象: ${first}`);
  }
  return first < second ? Object.freeze([first, second]) : Object.freeze([second, first]);
}

function normalizedBlockerRelationTargetNodeIds(
  targetNodeIds: readonly GitHubNodeId[],
): readonly GitHubNodeId[] {
  return Object.freeze([...new Set(targetNodeIds)].sort());
}

function addPotentialBlockerRelationAnalysis(
  candidatesById: Map<string, PotentialBlockerRelationAnalysis>,
  candidate: PotentialBlockerRelationAnalysis,
): void {
  const normalized = Object.freeze({
    ...candidate,
    endpointNodeIds: normalizedBlockerRelationEndpointNodeIds(candidate.endpointNodeIds),
    targetNodeIds: normalizedBlockerRelationTargetNodeIds(candidate.targetNodeIds),
  });
  const existing = candidatesById.get(candidate.candidateId);
  if (existing == null) {
    candidatesById.set(candidate.candidateId, normalized);
    return;
  }
  if (
    hashCanonicalJson(existing.endpointNodeIds) !== hashCanonicalJson(normalized.endpointNodeIds) ||
    hashCanonicalJson(existing.targetNodeIds) !== hashCanonicalJson(normalized.targetNodeIds) ||
    existing.native !== normalized.native
  ) {
    throw new TypeError(`blocker関係候補の定義が一致しません。対象: ${candidate.candidateId}`);
  }
  if (
    existing.ownerNodeId != null &&
    normalized.ownerNodeId != null &&
    existing.ownerNodeId !== normalized.ownerNodeId
  ) {
    throw new TypeError(`blocker関係候補のownerが一致しません。対象: ${candidate.candidateId}`);
  }
  if (existing.ownerNodeId == null && normalized.ownerNodeId != null) {
    candidatesById.set(
      candidate.candidateId,
      Object.freeze({
        ...existing,
        ownerNodeId: normalized.ownerNodeId,
      }),
    );
  }
}

function createBlockerRelationAnalysisIndex(
  candidatesById: ReadonlyMap<string, PotentialBlockerRelationAnalysis>,
): BlockerRelationAnalysisIndex {
  const candidateIdsByTargetNodeId = new Map<GitHubNodeId, Set<string>>();
  for (const candidate of candidatesById.values()) {
    for (const targetNodeId of candidate.targetNodeIds) {
      const candidateIds = candidateIdsByTargetNodeId.get(targetNodeId);
      if (candidateIds == null) {
        candidateIdsByTargetNodeId.set(targetNodeId, new Set([candidate.candidateId]));
      } else {
        candidateIds.add(candidate.candidateId);
      }
    }
  }
  return Object.freeze({
    candidatesById,
    candidateIdsByTargetNodeId,
  });
}

function previousInferredRelationOwnerNodeId(relation: Relation): GitHubNodeId | undefined {
  if (relation.aiDependency.status === "not_dependent") {
    return undefined;
  }
  const ownerNodeIds = new Set(
    (relation.aiDependency.producers ?? []).flatMap((producer) =>
      producer.kind === "relation" && producer.relationId === relation.id
        ? [producer.producer.nodeId]
        : [],
    ),
  );
  if (ownerNodeIds.size > 1) {
    throw new TypeError(`前回blocker関係候補のownerが一意ではありません。対象: ${relation.id}`);
  }
  return [...ownerNodeIds][0];
}

function previousBlockerRelationAnalysisIndex(
  snapshot: StateSnapshot | undefined,
  trackedNodeIdsByValue: ReadonlyMap<string, GitHubNodeId>,
  previousRelationCandidateDependencyProducers: () => readonly PreviousRelationCandidateDependencyProducer[],
): BlockerRelationAnalysisIndex {
  const candidatesById = new Map<string, PotentialBlockerRelationAnalysis>();
  for (const relation of snapshot?.relations ?? []) {
    if (!relation.active) {
      continue;
    }
    const endpointNodeIds = Object.freeze([
      relation.fromNodeId,
      relation.toNodeId,
    ]) satisfies readonly [GraphNodeId, GraphNodeId];
    const potentialTargetNodeIds =
      relation.provenance !== "native"
        ? endpointNodeIds
        : relation.type === "blocks"
          ? Object.freeze([relation.toNodeId])
          : Object.freeze([]);
    const targetNodeIds = potentialTargetNodeIds.flatMap((nodeId) => {
      const targetNodeId = trackedNodeIdsByValue.get(nodeId);
      return targetNodeId == null ? [] : [targetNodeId];
    });
    if (targetNodeIds.length === 0) {
      continue;
    }
    addPotentialBlockerRelationAnalysis(
      candidatesById,
      Object.freeze({
        candidateId: relation.id,
        endpointNodeIds,
        targetNodeIds,
        ownerNodeId:
          relation.provenance === "native"
            ? undefined
            : previousInferredRelationOwnerNodeId(relation),
        native: relation.provenance === "native",
      }),
    );
  }
  for (const producer of previousRelationCandidateDependencyProducers()) {
    const targetNodeIds = producer.endpointNodeIds.flatMap((nodeId) => {
      const targetNodeId = trackedNodeIdsByValue.get(nodeId);
      return targetNodeId == null ? [] : [targetNodeId];
    });
    if (targetNodeIds.length === 0) {
      continue;
    }
    addPotentialBlockerRelationAnalysis(
      candidatesById,
      Object.freeze({
        candidateId: producer.candidateId,
        endpointNodeIds: producer.endpointNodeIds,
        targetNodeIds,
        ownerNodeId: producer.producer.nodeId,
        native: false,
      }),
    );
  }
  return createBlockerRelationAnalysisIndex(candidatesById);
}

function currentBlockerRelationAnalysisIndex(
  relationCandidates: readonly RelationCandidate[],
  trackedNodeIdsByValue: ReadonlyMap<string, GitHubNodeId>,
): BlockerRelationAnalysisIndex {
  const candidatesById = new Map<string, PotentialBlockerRelationAnalysis>();
  for (const candidate of relationCandidates) {
    const nodes = relationNodes(candidate.relation);
    const endpointNodeIds = Object.freeze([nodes[0].nodeId, nodes[1].nodeId]) satisfies readonly [
      GraphNodeId,
      GraphNodeId,
    ];
    const potentialTargetNodeIds =
      candidate.authority === "inferred"
        ? endpointNodeIds
        : candidate.relation.type === "blocks"
          ? Object.freeze([candidate.relation.blocked.nodeId])
          : Object.freeze([]);
    const targetNodeIds = potentialTargetNodeIds.flatMap((nodeId) => {
      const targetNodeId = trackedNodeIdsByValue.get(nodeId);
      return targetNodeId == null ? [] : [targetNodeId];
    });
    if (targetNodeIds.length === 0) {
      continue;
    }
    const ownerNodeId =
      candidate.authority === "inferred"
        ? trackedNodeIdsByValue.get(relationAssessmentOwnerNodeId(candidate))
        : undefined;
    addPotentialBlockerRelationAnalysis(
      candidatesById,
      Object.freeze({
        candidateId: candidate.id,
        endpointNodeIds,
        targetNodeIds,
        ownerNodeId,
        native: candidate.authority === "authoritative",
      }),
    );
  }
  return createBlockerRelationAnalysisIndex(candidatesById);
}

function nativeBlockerCandidateAbsenceIsProven(
  candidate: PotentialBlockerRelationAnalysis,
  detailsByNodeId: ReadonlyMap<GraphNodeId, GitHubItemDetail>,
): boolean {
  if (!candidate.native) {
    return false;
  }
  return candidate.endpointNodeIds.some((nodeId) => {
    const detail = detailsByNodeId.get(nodeId);
    return detail?.type === "issue" && detail.nativeDependencies.availability === "available";
  });
}

function blockerRelationHasChangedRelatedEndpoint(
  candidate: PotentialBlockerRelationAnalysis,
  targetNodeId: GitHubNodeId,
  changedNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  return candidate.endpointNodeIds.some(
    (nodeId) => nodeId !== targetNodeId && changedNodeIds.has(nodeId),
  );
}

/** 関係候補の変化から再分析対象を選ぶ。 */
export function blockerRelationAnalysisTargets(
  input: BlockerRelationAnalysisInput,
): BlockerRelationAnalysisTargets {
  const trackedNodeIdsByValue = new Map<string, GitHubNodeId>(
    [...input.trackedNodeIds].map((nodeId) => [nodeId, nodeId]),
  );
  const previousIndex = previousBlockerRelationAnalysisIndex(
    input.snapshot,
    trackedNodeIdsByValue,
    input.previousRelationCandidateDependencyProducers,
  );
  const currentIndex = currentBlockerRelationAnalysisIndex(
    input.relationCandidates,
    trackedNodeIdsByValue,
  );
  const changedGraphNodeIds = new Set<GraphNodeId>(input.changedNodeIds);
  if (input.snapshot != null) {
    const previousEffectiveStates = snapshotEffectiveGraphStateByNodeId(input.snapshot);
    const currentNativeStates = input.currentNativeStatesByStaleNodeId();
    for (const [nodeId, currentState] of currentNativeStates) {
      const previousState = previousEffectiveStates.get(nodeId);
      assertNonNullable(
        previousState,
        `stale endpointの前回effective graph状態がありません。対象: ${nodeId}`,
      );
      if (previousState !== currentState) {
        changedGraphNodeIds.add(nodeId);
      }
    }
  }
  const detailsByGraphNodeId = new Map<GraphNodeId, GitHubItemDetail>(input.detailsByNodeId);
  const analysisNodeIds = new Set(input.initialAnalysisNodeIds);
  const freshNodeIds = new Set<GitHubNodeId>();
  const staleTopologyNodeIds = new Set<GitHubNodeId>();
  const addTarget = (nodeId: GitHubNodeId): boolean => {
    if (input.staleNodeIds.has(nodeId)) {
      staleTopologyNodeIds.add(nodeId);
      return false;
    }
    if (analysisNodeIds.has(nodeId)) {
      return false;
    }
    if (!input.observedItemsByNodeId.has(nodeId)) {
      throw new TypeError(`blocker関係の再分析対象を取得できません。対象: ${nodeId}`);
    }
    if (!input.detailsByNodeId.has(nodeId)) {
      throw new TypeError(`blocker関係の再分析対象の詳細がありません。対象: ${nodeId}`);
    }
    analysisNodeIds.add(nodeId);
    freshNodeIds.add(nodeId);
    return true;
  };
  const targetNodeIds = new Set([
    ...previousIndex.candidateIdsByTargetNodeId.keys(),
    ...currentIndex.candidateIdsByTargetNodeId.keys(),
  ]);
  for (const targetNodeId of targetNodeIds) {
    const previousCandidateIds =
      previousIndex.candidateIdsByTargetNodeId.get(targetNodeId) ?? new Set<string>();
    const currentCandidateIds =
      currentIndex.candidateIdsByTargetNodeId.get(targetNodeId) ?? new Set<string>();
    if ([...currentCandidateIds].some((candidateId) => !previousCandidateIds.has(candidateId))) {
      addTarget(targetNodeId);
    }
    for (const candidateId of previousCandidateIds) {
      if (currentCandidateIds.has(candidateId)) {
        continue;
      }
      const candidate = previousIndex.candidatesById.get(candidateId);
      assertNonNullable(candidate, `前回blocker関係候補の定義がありません。対象: ${candidateId}`);
      if (
        blockerRelationHasChangedRelatedEndpoint(candidate, targetNodeId, changedGraphNodeIds) ||
        (candidate.ownerNodeId != null && analysisNodeIds.has(candidate.ownerNodeId)) ||
        nativeBlockerCandidateAbsenceIsProven(candidate, detailsByGraphNodeId)
      ) {
        addTarget(targetNodeId);
      }
    }
  }
  const potentialRelationsById = new Map([
    ...previousIndex.candidatesById,
    ...currentIndex.candidatesById,
  ]);
  for (const relation of potentialRelationsById.values()) {
    for (const targetNodeId of relation.targetNodeIds) {
      if (blockerRelationHasChangedRelatedEndpoint(relation, targetNodeId, changedGraphNodeIds)) {
        addTarget(targetNodeId);
      }
    }
  }
  for (;;) {
    let targetAdded = false;
    for (const relation of potentialRelationsById.values()) {
      if (relation.ownerNodeId == null || !analysisNodeIds.has(relation.ownerNodeId)) {
        continue;
      }
      for (const targetNodeId of relation.targetNodeIds) {
        if (addTarget(targetNodeId)) {
          targetAdded = true;
        }
      }
    }
    if (!targetAdded) {
      break;
    }
  }
  for (const nodeId of input.previousStaleRepositoryBlockerTopologyNodeIds()) {
    if (input.trackedNodeIds.has(nodeId) && input.staleNodeIds.has(nodeId)) {
      staleTopologyNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    freshNodeIds,
    staleNodeIds: staleTopologyNodeIds,
  });
}

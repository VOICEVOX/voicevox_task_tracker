import type { GitHubNodeId, GraphNodeId, TrackedItemState } from "../../domain/index.js";
import type { RelationCandidate } from "../../graph/index.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../../graph/relation-candidate-endpoints.js";
import { normalizedBlockerRelationEndpointNodeIds } from "../relation-driven-analysis-targets.js";

export const EMPTY_RELATION_CANDIDATES = Object.freeze([] satisfies RelationCandidate[]);

/** 関係候補を端点のnode IDごとに索引する。 */
export function indexRelationCandidatesByNodeId(
  candidates: readonly RelationCandidate[],
): ReadonlyMap<GraphNodeId, readonly RelationCandidate[]> {
  const candidatesByNodeId = new Map<GraphNodeId, RelationCandidate[]>();
  for (const candidate of candidates) {
    const [firstNode, secondNode] = relationNodes(candidate.relation);
    const firstCandidates = candidatesByNodeId.get(firstNode.nodeId);
    if (firstCandidates == null) {
      candidatesByNodeId.set(firstNode.nodeId, [candidate]);
    } else {
      firstCandidates.push(candidate);
    }
    if (secondNode.nodeId === firstNode.nodeId) {
      continue;
    }
    const secondCandidates = candidatesByNodeId.get(secondNode.nodeId);
    if (secondCandidates == null) {
      candidatesByNodeId.set(secondNode.nodeId, [candidate]);
    } else {
      secondCandidates.push(candidate);
    }
  }
  return new Map(
    [...candidatesByNodeId].map(([nodeId, nodeCandidates]) => [
      nodeId,
      Object.freeze(nodeCandidates),
    ]),
  );
}

/** 古い項目の現行native関係候補の状態を索引する。 */
export function currentNativeCandidateStateByStaleNodeId(
  candidates: readonly RelationCandidate[],
  staleNodeIds: ReadonlySet<GitHubNodeId>,
): ReadonlyMap<GitHubNodeId, TrackedItemState> {
  const stateByNodeId = new Map<GitHubNodeId, TrackedItemState>();
  for (const candidate of candidates) {
    if (candidate.provenance !== "native") {
      continue;
    }
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope !== "organization" || !staleNodeIds.has(node.nodeId)) {
        continue;
      }
      const existing = stateByNodeId.get(node.nodeId);
      if (existing != null && existing !== node.state) {
        throw new TypeError(
          `native関係候補のstale endpoint状態が一致しません。対象: ${node.nodeId}`,
        );
      }
      stateByNodeId.set(node.nodeId, node.state);
    }
  }
  return stateByNodeId;
}

type CurrentRelationCandidate = Readonly<{
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  ownerNodeId: GraphNodeId;
}>;

/** 現行の関係候補をIDごとに索引する。 */
export function currentRelationCandidatesById(
  relationCandidates: readonly RelationCandidate[],
): ReadonlyMap<string, CurrentRelationCandidate> {
  const candidatesById = new Map<string, CurrentRelationCandidate>();
  for (const candidate of relationCandidates) {
    const [firstNode, secondNode] = relationNodes(candidate.relation);
    const endpointNodeIds: readonly [GraphNodeId, GraphNodeId] = [
      firstNode.nodeId,
      secondNode.nodeId,
    ];
    const normalized = Object.freeze({
      endpointNodeIds: normalizedBlockerRelationEndpointNodeIds(endpointNodeIds),
      ownerNodeId: relationAssessmentOwnerNodeId(candidate),
    });
    const existing = candidatesById.get(candidate.id);
    if (existing == null) {
      candidatesById.set(candidate.id, normalized);
      continue;
    }
    if (
      existing.endpointNodeIds[0] !== normalized.endpointNodeIds[0] ||
      existing.endpointNodeIds[1] !== normalized.endpointNodeIds[1] ||
      existing.ownerNodeId !== normalized.ownerNodeId
    ) {
      throw new TypeError(`現在のrelation candidate定義が一致しません。対象: ${candidate.id}`);
    }
  }
  return candidatesById;
}

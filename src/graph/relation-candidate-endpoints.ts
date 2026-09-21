import type { GraphNodeId } from "../domain/index.js";
import type {
  CandidateRelation,
  OrganizationRelationCandidateNode,
  RelationCandidate,
  RelationCandidateNode,
} from "./relation-candidate-types.js";

/** 関係候補の端点を関係種別に応じた順で返す。 */
export function relationNodes(
  relation: CandidateRelation,
): readonly [RelationCandidateNode, RelationCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return Object.freeze([relation.blocker, relation.blocked]);
    case "parent_of":
      return Object.freeze([relation.parent, relation.subtask]);
    case "implements":
      return Object.freeze([relation.implementation, relation.target]);
    case "unclassified":
      return Object.freeze([relation.referencing, relation.referenced]);
  }
}

/** 関係候補を判定する項目のnode IDを返す。 */
export function relationAssessmentOwnerNodeId(candidate: RelationCandidate): GraphNodeId {
  switch (candidate.relation.type) {
    case "blocks":
      return candidate.relation.blocked.nodeId;
    case "parent_of":
      return candidate.relation.parent.nodeId;
    case "implements":
      return candidate.relation.implementation.nodeId;
    case "unclassified":
      return candidate.relation.referencing.nodeId;
  }
}

/** 関係判定担当の候補だけを選ぶ。 */
export function selectRelationAssessmentCandidates(
  nodeId: GraphNodeId,
  candidates: readonly RelationCandidate[],
): readonly RelationCandidate[] {
  return candidates.filter((candidate) => relationAssessmentOwnerNodeId(candidate) === nodeId);
}

/** 関係候補の端点が組織内項目か判定する。 */
export function isOrganizationRelationCandidateNode(
  node: RelationCandidateNode,
): node is OrganizationRelationCandidateNode {
  return node.scope === "organization";
}

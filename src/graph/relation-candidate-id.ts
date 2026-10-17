import { sha256Hex } from "../canonical-json/sha256-hex.js";

import {
  type CandidateRelation,
  type RelationCandidate,
  type RelationCandidateId,
  type RelationCandidateNode,
} from "./relation-candidate-types.js";

function nodeIdentity(node: RelationCandidateNode): string {
  return node.nodeId;
}

function relationIdentity(relation: CandidateRelation): readonly string[] {
  switch (relation.type) {
    case "blocks":
      return ["blocks", nodeIdentity(relation.blocker), nodeIdentity(relation.blocked)];
    case "parent_of":
      return ["parent_of", nodeIdentity(relation.parent), nodeIdentity(relation.subtask)];
    case "implements":
      return ["implements", nodeIdentity(relation.implementation), nodeIdentity(relation.target)];
    case "unclassified":
      return [
        "unclassified",
        nodeIdentity(relation.referencing),
        nodeIdentity(relation.referenced),
      ];
  }
}

/** provenanceと関係内容から決定論的な候補IDを生成する。 */
export function buildRelationCandidateId(
  provenance: RelationCandidate["provenance"],
  relation: CandidateRelation,
): RelationCandidateId {
  const canonicalIdentity = JSON.stringify([provenance, ...relationIdentity(relation)]);
  const digest = sha256Hex(canonicalIdentity);
  return `rel:${digest}`;
}

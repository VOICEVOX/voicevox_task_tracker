import { type SourceId } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  type CandidateRelation,
  type RelationCandidate,
  type RelationCandidateId,
  type RelationCandidateNode,
} from "./relation-candidate-types.js";

type CandidateAccumulatorEntry = Readonly<{
  candidate: RelationCandidate;
  signature: string;
  sourceIds: Set<SourceId>;
}>;

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateSourceIds(sourceIds: readonly SourceId[], context: string): void {
  if (sourceIds.length === 0) {
    throw new TypeError(`${context}にはsource IDが1件以上必要です`);
  }
  if (sourceIds.some((sourceId) => sourceId.length === 0)) {
    throw new TypeError(`${context}のsource IDは空にできません`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError(`${context}のsource IDが重複しています`);
  }
}

function createSourceIds(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareStrings);
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function relationNodes(
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

function nodeSignature(node: RelationCandidateNode): readonly (string | number | boolean)[] {
  const commonFields = [
    node.scope,
    node.kind,
    node.nodeId,
    node.repositoryOwner,
    node.repositoryName,
    node.number,
    node.url,
    node.state,
  ];
  if (node.scope === "organization") {
    return commonFields;
  }
  return [...commonFields, node.githubNodeId, node.githubItemType];
}

function candidateSignature(candidate: RelationCandidate): string {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  return JSON.stringify([
    candidate.authority,
    candidate.provenance,
    candidate.relation.type,
    nodeSignature(firstNode),
    nodeSignature(secondNode),
  ]);
}

function relationSignature(relation: CandidateRelation): string {
  const [firstNode, secondNode] = relationNodes(relation);
  return JSON.stringify([relation.type, nodeSignature(firstNode), nodeSignature(secondNode)]);
}

function replaceCandidateSourceIds(
  candidate: RelationCandidate,
  sourceIds: readonly [SourceId, ...SourceId[]],
): RelationCandidate {
  switch (candidate.provenance) {
    case "native":
      return Object.freeze({ ...candidate, sourceIds });
    case "explicit_text":
      return Object.freeze({ ...candidate, sourceIds });
    case "closing_keyword":
      return Object.freeze({ ...candidate, sourceIds });
    case "checklist":
      return Object.freeze({ ...candidate, sourceIds });
    case "cross_reference":
      return Object.freeze({ ...candidate, sourceIds });
  }
}

/** 関係候補を候補IDごとに検証してsource IDを統合する。 */
export function normalizeRelationCandidates(
  candidates: readonly RelationCandidate[],
): readonly RelationCandidate[] {
  const candidatesById = new Map<RelationCandidateId, CandidateAccumulatorEntry>();

  for (const candidate of candidates) {
    validateSourceIds(candidate.sourceIds, `関係候補 ${candidate.id}`);
    const [firstNode, secondNode] = relationNodes(candidate.relation);
    if (firstNode.nodeId === secondNode.nodeId) {
      throw new TypeError(`関係候補 ${candidate.id}は同じnodeを接続できません`);
    }
    const signature = candidateSignature(candidate);
    const existing = candidatesById.get(candidate.id);
    if (existing == null) {
      candidatesById.set(
        candidate.id,
        Object.freeze({
          candidate,
          signature,
          sourceIds: new Set(candidate.sourceIds),
        }),
      );
      continue;
    }
    if (existing.signature !== signature) {
      throw new TypeError(`同じ候補ID ${candidate.id}に異なる関係が指定されています`);
    }
    for (const sourceId of candidate.sourceIds) {
      existing.sourceIds.add(sourceId);
    }
  }

  const normalized = [...candidatesById.values()]
    .map((entry) =>
      replaceCandidateSourceIds(entry.candidate, createSourceIds([...entry.sourceIds])),
    )
    .sort((left, right) => compareStrings(left.id, right.id));
  const authoritativeRelations = new Set(
    normalized
      .filter(
        (candidate) =>
          candidate.authority === "authoritative" && candidate.relation.type === "implements",
      )
      .map((candidate) => relationSignature(candidate.relation)),
  );
  return Object.freeze(
    normalized.filter(
      (candidate) =>
        candidate.authority === "authoritative" ||
        candidate.relation.type !== "implements" ||
        !authoritativeRelations.has(relationSignature(candidate.relation)),
    ),
  );
}

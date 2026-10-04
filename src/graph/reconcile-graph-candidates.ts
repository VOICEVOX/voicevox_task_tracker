import {
  aiAnalysisDependencySchema,
  type AiAnalysisDependency,
  type Evidence,
  type EvidenceSupport,
  type GraphNodeId,
  type SourceId,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import {
  compareStrings,
  validateConfidence,
  validateSourceIds,
} from "./reconcile-graph-sources.js";
import {
  type CanonicalRelation,
  type RelationCandidateAssessment,
  type RelationContradiction,
} from "./reconcile-graph-types.js";
import {
  type CandidateRelation,
  type RelationCandidate,
  type RelationCandidateId,
  type RelationCandidateNode,
} from "./relation-candidate-types.js";

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

export function relationCandidateOwnerNodeId(candidate: RelationCandidate): GraphNodeId {
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

function relationCandidateNodeItemType(node: RelationCandidateNode): "issue" | "pull_request" {
  return node.scope === "organization" ? node.kind : node.githubItemType;
}

export function validateImplementsEndpointTypes(
  implementation: RelationCandidateNode,
  target: RelationCandidateNode,
  context: string,
): void {
  if (
    relationCandidateNodeItemType(implementation) !== "pull_request" ||
    relationCandidateNodeItemType(target) !== "issue"
  ) {
    throw new TypeError(`${context}はPull RequestからIssueへ向けてください`);
  }
}

export function validateCandidateRelationEndpointTypes(candidate: RelationCandidate): void {
  if (candidate.relation.type !== "implements") {
    return;
  }
  validateImplementsEndpointTypes(
    candidate.relation.implementation,
    candidate.relation.target,
    `implements候補 ${candidate.id}`,
  );
}

export function canonicalCandidateRelation(relation: CandidateRelation): CanonicalRelation {
  switch (relation.type) {
    case "blocks":
      return Object.freeze({
        fromNodeId: relation.blocker.nodeId,
        toNodeId: relation.blocked.nodeId,
        type: "blocks",
      });
    case "parent_of":
      return Object.freeze({
        fromNodeId: relation.parent.nodeId,
        toNodeId: relation.subtask.nodeId,
        type: "parent_of",
      });
    case "implements":
      return Object.freeze({
        fromNodeId: relation.implementation.nodeId,
        toNodeId: relation.target.nodeId,
        type: "implements",
      });
    case "unclassified":
      return Object.freeze({
        fromNodeId: relation.referencing.nodeId,
        toNodeId: relation.referenced.nodeId,
        type: "related_to",
      });
  }
}

function otherCandidateNode(
  candidate: RelationCandidate,
  currentNodeId: GraphNodeId,
): RelationCandidateNode {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === currentNodeId) {
    return secondNode;
  }
  if (secondNode.nodeId === currentNodeId) {
    return firstNode;
  }
  throw new TypeError(`関係候補 ${candidate.id}に現在項目 ${currentNodeId}が含まれていません`);
}

export function validateAssessments(
  candidates: readonly RelationCandidate[],
  assessments: readonly RelationCandidateAssessment[],
): ReadonlyMap<RelationCandidateId, RelationCandidateAssessment> {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const assessmentsByCandidateId = new Map<RelationCandidateId, RelationCandidateAssessment>();

  for (const assessment of assessments) {
    const candidate = candidatesById.get(assessment.candidateId);
    if (candidate == null) {
      throw new TypeError(`存在しない関係候補 ${assessment.candidateId}のAI判定が指定されています`);
    }
    if (assessmentsByCandidateId.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI判定が重複しています`);
    }
    if (assessment.reasonSummary.trim().length === 0) {
      throw new TypeError(`関係候補 ${assessment.candidateId}の判定理由は空にできません`);
    }
    validateConfidence(
      assessment.confidence,
      `関係候補 ${assessment.candidateId}のAI判定confidence`,
    );
    validateSourceIds(assessment.sourceIds, `関係候補 ${assessment.candidateId}のAI判定根拠`);
    otherCandidateNode(candidate, assessment.currentNodeId);
    assessmentsByCandidateId.set(assessment.candidateId, assessment);
  }

  return assessmentsByCandidateId;
}

export function validateRelationAiDependencies(
  candidates: readonly RelationCandidate[],
  dependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
): void {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const [candidateId, dependency] of dependencies) {
    const candidate = candidatesById.get(candidateId);
    if (candidate == null) {
      throw new TypeError(`存在しない関係候補 ${candidateId}のAI依存が指定されています`);
    }
    const parsed = aiAnalysisDependencySchema.safeParse(dependency);
    if (!parsed.success) {
      throw new TypeError(`関係候補 ${candidateId}のAI依存が不正です`, {
        cause: parsed.error,
      });
    }
    if (candidate.authority === "authoritative" && dependency.status !== "not_dependent") {
      throw new TypeError(
        `authoritative relation ${candidateId}のAI依存はnot_dependentでなければなりません`,
      );
    }
  }
  for (const candidate of candidates) {
    if (candidate.authority !== "inferred") {
      continue;
    }
    const dependency = dependencies.get(candidate.id);
    if (dependency == null) {
      throw new TypeError(`推定relation ${candidate.id}のAI依存がありません`);
    }
    validateInferredRelationAiDependency(candidate, dependency, true);
  }
}

export function canonicalAssessmentRelation(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment,
): CanonicalRelation | null {
  const currentNodeId = assessment.currentNodeId;
  const targetNodeId = otherCandidateNode(candidate, currentNodeId).nodeId;

  switch (assessment.verdict) {
    case "current_is_blocked_by_target":
      return Object.freeze({
        fromNodeId: targetNodeId,
        toNodeId: currentNodeId,
        type: "blocks",
      });
    case "current_blocks_target":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "blocks",
      });
    case "current_implements_target":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "implements",
      });
    case "target_is_subtask_of_current":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "parent_of",
      });
    case "current_is_subtask_of_target":
      return Object.freeze({
        fromNodeId: targetNodeId,
        toNodeId: currentNodeId,
        type: "parent_of",
      });
    case "duplicates":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "duplicates",
      });
    case "related":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "related_to",
      });
    case "none":
      return null;
    default:
      throw new UnreachableError(assessment.verdict);
  }
}

export function provenanceSummary(provenance: RelationCandidate["provenance"]): string {
  switch (provenance) {
    case "native":
      return "GitHub native relationから関係を確定しました";
    case "explicit_text":
      return "本文またはコメントの明示参照から関係候補を抽出しました";
    case "closing_keyword":
      return "closing keywordから実装関係候補を抽出しました";
    case "checklist":
      return "Markdown checklistから階層関係候補を抽出しました";
    case "cross_reference":
      return "GitHub cross-referenceから関係候補を抽出しました";
  }
}

export function createEvidence(
  sourceIds: readonly SourceId[],
  supports: EvidenceSupport,
  summary: string,
): readonly Evidence[] {
  return Object.freeze(
    sourceIds.map((sourceId) =>
      Object.freeze({
        sourceId,
        supports,
        summary,
      }),
    ),
  );
}

export function evidenceKey(evidence: Evidence): string {
  return JSON.stringify([evidence.sourceId, evidence.supports, evidence.summary]);
}

export function normalizeEvidence(evidence: readonly Evidence[]): readonly Evidence[] {
  const evidenceByKey = new Map<string, Evidence>();
  for (const item of evidence) {
    if (item.summary.trim().length === 0) {
      throw new TypeError("edgeのevidence summaryは空にできません");
    }
    evidenceByKey.set(
      evidenceKey(item),
      Object.freeze({
        sourceId: item.sourceId,
        supports: item.supports,
        summary: item.summary,
      }),
    );
  }
  return Object.freeze(
    [...evidenceByKey.values()].sort((left, right) =>
      compareStrings(evidenceKey(left), evidenceKey(right)),
    ),
  );
}

function sameCanonicalRelation(left: CanonicalRelation, right: CanonicalRelation): boolean {
  return (
    left.fromNodeId === right.fromNodeId &&
    left.toNodeId === right.toNodeId &&
    left.type === right.type
  );
}

export function createContradiction(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment | undefined,
): readonly RelationContradiction[] {
  if (assessment == null) {
    return Object.freeze([]);
  }
  const authoritativeRelation = canonicalCandidateRelation(candidate.relation);
  const assessedRelation = canonicalAssessmentRelation(candidate, assessment);
  if (assessedRelation != null && sameCanonicalRelation(authoritativeRelation, assessedRelation)) {
    return Object.freeze([]);
  }
  const evidence = createEvidence(
    assessment.sourceIds,
    "uncertainty",
    `Codex判定はauthoritativeな関係と矛盾しています。${assessment.reasonSummary}`,
  );
  return Object.freeze([
    Object.freeze({
      verdict: assessment.verdict,
      confidence: assessment.confidence,
      evidence,
    }),
  ]);
}

export function validateInferredRelationAiDependency(
  candidate: RelationCandidate,
  dependency: AiAnalysisDependency,
  allowProducerlessNotRecorded: boolean,
): void {
  if (dependency.status === "not_dependent") {
    throw new TypeError(`推定relation ${candidate.id}のAI依存はnot_dependentにできません`);
  }
  if (dependency.status === "unknown" && dependency.reasons.includes("stale_repository")) {
    throw new TypeError(`推定relation ${candidate.id}にstale repository AI依存は指定できません`);
  }
  const producers = dependency.producers;
  if (producers == null) {
    if (
      allowProducerlessNotRecorded &&
      dependency.status === "unknown" &&
      dependency.reasons.length === 1 &&
      dependency.reasons[0] === "not_recorded"
    ) {
      return;
    }
    throw new TypeError(`推定relation ${candidate.id}のAI依存producerがありません`);
  }
  const endpointNodeIds = new Set(relationNodes(candidate.relation).map((node) => node.nodeId));
  const ownerNodeId = relationCandidateOwnerNodeId(candidate);
  for (const producer of producers) {
    if (producer.kind !== "item_element" || producer.element !== "relations") {
      throw new TypeError(`推定relation ${candidate.id}のAI依存producer elementが不正です`);
    }
    if (!endpointNodeIds.has(producer.nodeId)) {
      throw new TypeError(
        `推定relation ${candidate.id}のAI依存producer nodeがendpointではありません`,
      );
    }
    if (producer.nodeId !== ownerNodeId) {
      throw new TypeError(`推定relation ${candidate.id}のAI依存producer nodeがownerではありません`);
    }
  }
}

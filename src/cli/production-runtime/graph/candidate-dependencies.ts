import {
  aiAnalysisDependencyForMissingRelationCandidateAssessment,
  type AiAnalysisDependency,
} from "../../../domain/ai-analysis-dependencies.js";
import type { GraphNodeId } from "../../../domain/index.js";
import type {
  RelationCandidate,
  RelationCandidateAssessment,
  RelationCandidateId,
} from "../../../graph/index.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../../../graph/relation-candidate-endpoints.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  aiDependencyForElementApplication,
  unrecordedAiDependency,
} from "../ai-dependencies/selection.js";
import type { PendingTrackedItem } from "../contracts.js";

/** 関係候補ごとのAI依存を構築する。 */
export function relationAiDependenciesForCandidates(
  candidates: readonly RelationCandidate[],
  items: readonly PendingTrackedItem[],
  assessments: readonly RelationCandidateAssessment[],
): ReadonlyMap<RelationCandidateId, AiAnalysisDependency> {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const candidatesById = new Map<RelationCandidateId, RelationCandidate>();
  for (const candidate of candidates) {
    if (candidatesById.has(candidate.id)) {
      throw new TypeError(`関係候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidatesById.set(candidate.id, candidate);
  }
  const itemsByNodeId = new Map<GraphNodeId, PendingTrackedItem>();
  for (const item of items) {
    if (itemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`関係候補の生成元itemが重複しています。対象: ${item.nodeId}`);
    }
    itemsByNodeId.set(item.nodeId, item);
  }
  const assessmentsByCandidateId = new Map<RelationCandidateId, RelationCandidateAssessment>();
  for (const assessment of assessments) {
    if (!candidateIds.has(assessment.candidateId)) {
      continue;
    }
    if (assessmentsByCandidateId.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI依存が重複しています`);
    }
    const candidate = candidatesById.get(assessment.candidateId);
    assertNonNullable(candidate, `関係候補 ${assessment.candidateId}がありません`);
    const ownerNodeId = relationAssessmentOwnerNodeId(candidate);
    if (assessment.currentNodeId !== ownerNodeId) {
      throw new TypeError(
        `関係候補 ${assessment.candidateId}のAI判定ownerが一致しません。対象: ${ownerNodeId}`,
      );
    }
    assessmentsByCandidateId.set(assessment.candidateId, assessment);
  }
  const dependencies = new Map<RelationCandidateId, AiAnalysisDependency>();
  for (const candidate of candidates) {
    if (candidate.provenance === "native") {
      dependencies.set(candidate.id, Object.freeze({ status: "not_dependent" }));
      continue;
    }
    const ownerNodeId = relationAssessmentOwnerNodeId(candidate);
    const owner = itemsByNodeId.get(ownerNodeId);
    if (owner == null) {
      const ownerNode = relationNodes(candidate.relation).find(
        (node) => node.nodeId === ownerNodeId,
      );
      assertNonNullable(ownerNode, `関係候補 ${candidate.id}のowner nodeがありません`);
      dependencies.set(candidate.id, unrecordedAiDependency());
      continue;
    }
    const assessment = assessmentsByCandidateId.get(candidate.id);
    if (assessment == null) {
      dependencies.set(
        candidate.id,
        aiAnalysisDependencyForMissingRelationCandidateAssessment(
          owner.nodeId,
          owner.aiAnalysis.applications.relations,
        ),
      );
      continue;
    }
    dependencies.set(
      candidate.id,
      aiDependencyForElementApplication(owner.nodeId, owner.aiAnalysis.applications, "relations"),
    );
  }
  return dependencies;
}

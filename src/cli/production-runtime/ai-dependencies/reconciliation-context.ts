import {
  aiAnalysisDependencyForRelationCandidate,
  type AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import type { RelationCandidate } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GraphResult, PendingTrackedItem } from "../contracts.js";
import { currentRelationCandidatesById } from "../relation-candidate-index.js";

/** 現在の項目と関係からAI依存の照合文脈を作る。 */
export function aiDependencyReconciliationContext(
  items: readonly PendingTrackedItem[],
  candidates: readonly RelationCandidate[],
  graph: Pick<GraphResult, "edges" | "relationCandidateAiDependencies">,
): AiAnalysisDependencyReconciliationContext {
  const definitionsById = currentRelationCandidatesById(candidates);
  return Object.freeze({
    applicationsByNodeId: new Map(items.map((item) => [item.nodeId, item.aiAnalysis.applications])),
    relationsById: new Map(graph.edges.map((edge) => [edge.id, edge])),
    candidatesById: new Map(
      [...graph.relationCandidateAiDependencies].map(([candidateId, dependency]) => {
        const definition = definitionsById.get(candidateId);
        assertNonNullable(
          definition,
          `現在のrelation candidate定義がありません。対象: ${candidateId}`,
        );
        return [
          candidateId,
          Object.freeze({
            ...definition,
            aiDependency: aiAnalysisDependencyForRelationCandidate(
              candidateId,
              definition.endpointNodeIds,
              dependency,
            ),
          }),
        ];
      }),
    ),
  });
}

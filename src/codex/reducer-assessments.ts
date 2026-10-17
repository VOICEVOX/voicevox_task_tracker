import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
} from "../domain/ai-analysis-elements.js";
import {
  createGitHubNodeId,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
} from "../domain/index.js";
import { type RelationCandidateAssessment, type RelationCandidateId } from "../graph/index.js";
import { classifyCodexConfidence, type CodexConfidenceThresholds } from "./confidence.js";
import type {
  CodexRelationCoverage,
  CodexUnavailableReason,
  ReducedCodexNotification,
} from "./reducer-contracts.js";
import { createSourceIdTuple } from "./reducer-decision-values.js";
import type { ElementResultSelection } from "./reducer-element-selection.js";
import { relationCandidateIdSchema } from "./reducer-element-selection.js";

export function createFallbackNotification(reasonSummary: string): ReducedCodexNotification {
  return Object.freeze({
    recommended: false,
    reasonCode: "none",
    reasonSummary,
    policy: "suppressed",
    highPriorityEligible: false,
  });
}

function createUnavailableImportanceAssessment(): NaturalLanguageImportanceAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

function createUnavailableDeadlineAssessment(): NaturalLanguageDeadlineAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

export function createImportanceAssessment(
  result: AiAnalysisElementMigrationResult | undefined,
): NaturalLanguageImportanceAssessmentState {
  if (result == null) {
    return createUnavailableImportanceAssessment();
  }
  const parsed = createAiAnalysisMigrationElementResultSchema("importance").parse(result);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: parsed.value.significantFeature,
      futureRisk: parsed.value.futureRisk,
      rationale: parsed.value.rationale,
    }),
  });
}

export function createDeadlineAssessment(
  result: AiAnalysisElementMigrationResult | undefined,
): NaturalLanguageDeadlineAssessmentState {
  if (result == null) {
    return createUnavailableDeadlineAssessment();
  }
  const parsed = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      date: parsed.value.date,
      rationale: parsed.value.rationale,
    }),
  });
}

export function createCodexNotification(
  selection: ElementResultSelection,
  confidenceThresholds: CodexConfidenceThresholds,
): ReducedCodexNotification {
  if (selection.result == null) {
    return createFallbackNotification("notification要素の有効な判定がありません");
  }
  const parsed = createAiAnalysisMigrationElementResultSchema("notification").parse(
    selection.result,
  );
  const classification =
    selection.classification ?? classifyCodexConfidence(parsed.confidence, confidenceThresholds);
  return Object.freeze({
    recommended: parsed.value.recommended,
    reasonCode: parsed.value.reasonCode,
    reasonSummary: parsed.value.reasonSummary,
    policy: classification.notificationPolicy,
    highPriorityEligible:
      parsed.value.recommended && classification.notificationPolicy === "eligible",
  });
}

export function unavailableUncertainty(reason: CodexUnavailableReason): string {
  switch (reason) {
    case "input_validation_failed":
      return "Codex入力の検証に失敗したため決定論的判定だけを表示しています";
    case "timeout":
      return "Codexがtimeoutしたため決定論的判定だけを表示しています";
    case "rate_limited":
      return "Codexがrate limitに達したため決定論的判定だけを表示しています";
    case "invalid_json":
      return "Codex出力がJSONではないため決定論的判定だけを表示しています";
    case "schema_validation_failed":
      return "Codex出力がJSON Schemaに適合しないため決定論的判定だけを表示しています";
    case "semantic_validation_failed":
      return "Codex出力がsemantic検証に失敗したため決定論的判定だけを表示しています";
    case "service_unavailable":
      return "Codex serviceを利用できないため決定論的判定だけを表示しています";
    case "execution_failed":
      return "Codex分析を利用できないため決定論的判定だけを表示しています";
  }
}

export function unresolvedRelationCoverage(
  relationCandidateIds: readonly string[],
): CodexRelationCoverage {
  return Object.freeze({
    status: "fallback",
    unresolvedCandidateIds: Object.freeze([...relationCandidateIds]),
  });
}

function relationCandidateId(value: string): RelationCandidateId {
  return relationCandidateIdSchema.parse(value);
}

export function createRelationAssessments(
  result: AiAnalysisElementMigrationResult,
  currentNodeId: string,
): readonly RelationCandidateAssessment[] {
  const parsed = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
  const nodeId = createGitHubNodeId(currentNodeId);
  return Object.freeze(
    parsed.value.map((relation) =>
      Object.freeze({
        candidateId: relationCandidateId(relation.candidateId),
        currentNodeId: nodeId,
        verdict: relation.verdict,
        reasonSummary: relation.reasonSummary,
        sourceIds: createSourceIdTuple(relation.sourceIds),
        confidence: Math.min(parsed.confidence, relation.confidence),
      }),
    ),
  );
}

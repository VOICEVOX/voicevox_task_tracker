import type {
  NaturalLanguageDeadlineAssessmentState,
  NaturalLanguageImportanceAssessmentState,
} from "../../../domain/index.js";
import type { GraphAdoptedOutput } from "./graph-reconciliation-adopted-output.js";

/** 採用済みの重要度要素を項目値へ投影する。 */
export function importanceAssessmentFromAdoption(
  output: GraphAdoptedOutput,
): NaturalLanguageImportanceAssessmentState {
  const result = output.importance;
  if (result == null) {
    return Object.freeze({ status: "not_available" });
  }
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: result.value.significantFeature,
      futureRisk: result.value.futureRisk,
      rationale: result.value.rationale,
    }),
  });
}

/** 採用済みの期限要素を項目値へ投影する。 */
export function deadlineAssessmentFromAdoption(
  output: GraphAdoptedOutput,
): NaturalLanguageDeadlineAssessmentState {
  const result = output.deadline;
  if (result == null) {
    return Object.freeze({ status: "not_available" });
  }
  return Object.freeze({
    status: "available",
    value: Object.freeze({ date: result.value.date, rationale: result.value.rationale }),
  });
}

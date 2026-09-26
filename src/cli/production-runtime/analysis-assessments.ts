import type {
  NaturalLanguageDeadlineAssessmentState,
  NaturalLanguageImportanceAssessmentState,
} from "../../domain/index.js";

function unavailableImportanceAssessment(): NaturalLanguageImportanceAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

function unavailableDeadlineAssessment(): NaturalLanguageDeadlineAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

/** 利用可能な重要度判定を解決する。 */
export function resolveImportanceAssessment(
  current: NaturalLanguageImportanceAssessmentState | undefined,
  adopted: NaturalLanguageImportanceAssessmentState | undefined,
): NaturalLanguageImportanceAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return adopted ?? unavailableImportanceAssessment();
}

/** 利用可能な期限判定を解決する。 */
export function resolveDeadlineAssessment(
  current: NaturalLanguageDeadlineAssessmentState | undefined,
  adopted: NaturalLanguageDeadlineAssessmentState | undefined,
): NaturalLanguageDeadlineAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return adopted ?? unavailableDeadlineAssessment();
}

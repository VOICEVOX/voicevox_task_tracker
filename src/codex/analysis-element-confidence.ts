import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../domain/ai-analysis-elements.js";

/** 要素内部のconfidenceを含めた実効confidenceを算出する。 */
export function effectiveElementConfidence(
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult,
): number {
  switch (element) {
    case "waitingOn": {
      const parsed = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
      return parsed.value.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.confidence),
        parsed.confidence,
      );
    }
    case "relations": {
      const parsed = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
      return parsed.value.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.confidence),
        parsed.confidence,
      );
    }
    case "progress": {
      const parsed = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
      return Math.min(parsed.confidence, parsed.value.confidence);
    }
    case "status":
    case "nextAction":
    case "importance":
    case "deadline":
    case "notification":
    case "selfCommitment":
      return result.confidence;
  }
}

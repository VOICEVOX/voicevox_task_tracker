import type { AiAnalysisTarget, AnalysisElementPlanning } from "../../../codex/index.js";
import {
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type {
  NaturalLanguageDeadlineAssessmentState,
  NaturalLanguageImportanceAssessmentState,
} from "../../../domain/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { isForcedUnexecutedElement } from "../ai-analysis-target.js";
import type { RuntimeState } from "../contracts.js";
import {
  currentAdoptedResultForElement,
  currentSavedResultForElement,
  migrationAdoptedResultForElement,
} from "../previous-state/saved-ai-elements.js";
import { forcedMigrationAdoptedElementForElement } from "./evaluation-records.js";

export function currentAdoptedImportanceAssessment(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  resolvedResult: AiAnalysisElementMigrationResult | undefined,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
): NaturalLanguageImportanceAssessmentState | undefined {
  const forcedUnexecutedElement = isForcedUnexecutedElement(analysis, "importance", target);
  if (forcedUnexecutedElement && planning.candidates.importance.necessity === "not_required") {
    return undefined;
  }
  let adopted: AiAnalysisElementMigrationResult | undefined;
  if (forcedUnexecutedElement) {
    adopted = currentSavedResultForElement(state, analysis, "importance");
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      "importance",
      target,
    );
    if (adopted == null && forcedMigration != null) {
      adopted = createAiAnalysisMigrationElementResultSchema("importance").parse(
        forcedMigration.result,
      );
    }
    adopted ??= resolvedResult;
  } else {
    adopted = resolvedResult;
    adopted ??= currentAdoptedResultForElement(state, analysis, "importance");
  }
  if (adopted == null) {
    const migrated = migrationAdoptedResultForElement(state, analysis, "importance");
    if (migrated == null) {
      return undefined;
    }
    const parsed = createAiAnalysisElementResultSchema("importance").parse(migrated);
    return Object.freeze({
      status: "available",
      value: Object.freeze({
        significantFeature: parsed.value.significantFeature,
        futureRisk: parsed.value.futureRisk,
        rationale: parsed.value.rationale,
      }),
    });
  }
  const parsed = createAiAnalysisElementResultSchema("importance").parse(adopted);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: parsed.value.significantFeature,
      futureRisk: parsed.value.futureRisk,
      rationale: parsed.value.rationale,
    }),
  });
}

export function currentAdoptedDeadlineAssessment(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  resolvedResult: AiAnalysisElementMigrationResult | undefined,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
): NaturalLanguageDeadlineAssessmentState | undefined {
  const forcedUnexecutedElement = isForcedUnexecutedElement(analysis, "deadline", target);
  if (forcedUnexecutedElement && planning.candidates.deadline.necessity === "not_required") {
    return undefined;
  }
  let adopted: AiAnalysisElementMigrationResult | undefined;
  if (forcedUnexecutedElement) {
    adopted = currentSavedResultForElement(state, analysis, "deadline");
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      "deadline",
      target,
    );
    if (adopted == null && forcedMigration != null) {
      adopted = createAiAnalysisMigrationElementResultSchema("deadline").parse(
        forcedMigration.result,
      );
    }
    adopted ??= resolvedResult;
  } else {
    adopted = resolvedResult;
    adopted ??= currentAdoptedResultForElement(state, analysis, "deadline");
  }
  if (adopted == null) {
    const migrated = migrationAdoptedResultForElement(state, analysis, "deadline");
    if (migrated == null) {
      return undefined;
    }
    const parsed = createAiAnalysisElementResultSchema("deadline").parse(migrated);
    return Object.freeze({
      status: "available",
      value: Object.freeze({
        date: parsed.value.date,
        rationale: parsed.value.rationale,
      }),
    });
  }
  const parsed = createAiAnalysisElementResultSchema("deadline").parse(adopted);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      date: parsed.value.date,
      rationale: parsed.value.rationale,
    }),
  });
}

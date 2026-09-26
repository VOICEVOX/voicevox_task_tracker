import type {
  AiAnalysisElementSourceGenerationMap,
  AiAnalysisRunResult,
  AiAnalysisTarget,
  AnalysisElementPlanning,
  AnalysisElementReuseRecord,
} from "../../../codex/index.js";
import {
  isStateAnalysisElement,
  verifiedReuseProof,
} from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
} from "../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../domain/ai-analysis-source-generations.js";
import type {
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisCurrentElement,
  TrackedItemAiAnalysisCurrentElements,
  TrackedItemAiAnalysisMigrationAdoptedElement,
  TrackedItemAiAnalysisMigrationElements,
} from "../../../domain/index.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { generatedElementsForNode } from "../ai-analysis-run-index.js";
import { isForcedUnexecutedElement } from "../ai-analysis-target.js";
import { finalStateDependencyFingerprint } from "../analysis-identity.js";
import type { MutablePartial, RuntimeState } from "../contracts.js";
import { unknownReuseProof } from "../previous-state/ai-reuse.js";
import {
  savedEvaluationRecordForElement,
  savedMigrationAdoptedElementsForItem,
} from "../previous-state/saved-ai-elements.js";

export function evaluationRecordsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  generations: AiAnalysisElementSourceGenerationMap,
  run: AiAnalysisRunResult | undefined,
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
  target: AiAnalysisTarget | undefined,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const dependencyFingerprints = Object.freeze({
    status: planning.candidates.status.dependencyFingerprint,
    waitingOn: planning.candidates.waitingOn.dependencyFingerprint,
    nextAction: planning.candidates.nextAction.dependencyFingerprint,
    relations: planning.candidates.relations.dependencyFingerprint,
    progress: planning.candidates.progress.dependencyFingerprint,
    importance: planning.candidates.importance.dependencyFingerprint,
    deadline: planning.candidates.deadline.dependencyFingerprint,
    notification: planning.candidates.notification.dependencyFingerprint,
    selfCommitment: planning.candidates.selfCommitment.dependencyFingerprint,
  });
  const generated = generatedElementsForNode(run, analysis.item.nodeId);
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = generations[element];
    if (generation == null) {
      continue;
    }
    const candidate = planning.candidates[element];
    const preserveForcedUnexecutedEvaluation =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    if (generated[element] == null && preserveForcedUnexecutedEvaluation) {
      const saved = savedEvaluationRecordForElement(state, analysis.item.nodeId, element);
      if (saved != null) {
        records[element] = saved;
      }
      continue;
    }
    if (generated[element] != null) {
      const dependencyFingerprint = isStateAnalysisElement(element)
        ? finalStateDependencyFingerprint(analysis, current, migration)
        : dependencyFingerprints[element];
      records[element] = Object.freeze({
        result: createAiAnalysisMigrationElementResultSchema(element).parse(generation.result),
        proof: verifiedReuseProof(
          element,
          planning.candidates[element].inputFingerprint,
          dependencyFingerprint,
          "current_generation",
          ["current_evaluation"],
        ),
      });
      continue;
    }
    const saved = candidate.savedEvaluation;
    records[element] =
      saved ??
      Object.freeze({
        result: createAiAnalysisMigrationElementResultSchema(element).parse(generation.result),
        proof: unknownReuseProof("source_input_unavailable"),
      });
  }
  return Object.freeze(records);
}

export function forcedMigrationAdoptedElementForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  element: AiAnalysisElement,
  target: AiAnalysisTarget | undefined,
): TrackedItemAiAnalysisMigrationAdoptedElement | undefined {
  if (
    !isForcedUnexecutedElement(analysis, element, target) ||
    planning.candidates[element].necessity !== "required"
  ) {
    return undefined;
  }
  const adopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  return adopted?.origin === "migration" ? adopted : undefined;
}

export function forcedMigrationReuseRecordsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    if (adopted == null) {
      continue;
    }
    records[element] = Object.freeze({
      result: createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result),
      proof: aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
    });
  }
  return Object.freeze(records);
}

function setEvaluatedElement(
  evaluated: MutablePartial<TrackedItemAiAnalysisCurrentElements>,
  element: AiAnalysisElement,
  generation: AiAnalysisElementSourceGeneration,
  evaluation: AnalysisElementReuseRecord,
): void {
  const value: TrackedItemAiAnalysisCurrentElement = {
    generation,
    result: createAiAnalysisMigrationElementResultSchema(element).parse(evaluation.result),
    evaluationProof: aiAnalysisElementReuseProofSchema.parse(evaluation.proof),
  };
  switch (element) {
    case "status":
      evaluated.status = {
        generation: createAiAnalysisElementSourceGenerationSchema("status").parse(value.generation),
        result: createAiAnalysisMigrationElementResultSchema("status").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "waitingOn":
      evaluated.waitingOn = {
        generation: createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "nextAction":
      evaluated.nextAction = {
        generation: createAiAnalysisElementSourceGenerationSchema("nextAction").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "relations":
      evaluated.relations = {
        generation: createAiAnalysisElementSourceGenerationSchema("relations").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "progress":
      evaluated.progress = {
        generation: createAiAnalysisElementSourceGenerationSchema("progress").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("progress").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "importance":
      evaluated.importance = {
        generation: createAiAnalysisElementSourceGenerationSchema("importance").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("importance").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "deadline":
      evaluated.deadline = {
        generation: createAiAnalysisElementSourceGenerationSchema("deadline").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("deadline").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "notification":
      evaluated.notification = {
        generation: createAiAnalysisElementSourceGenerationSchema("notification").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "selfCommitment":
      evaluated.selfCommitment = {
        generation: createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    default:
      throw new UnreachableError(element);
  }
}

export function evaluatedElementsForGenerations(
  generations: AiAnalysisElementSourceGenerationMap,
  evaluations: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>,
  missingEvaluationElements: ReadonlySet<AiAnalysisElement>,
): TrackedItemAiAnalysisCurrentElements {
  const evaluated: MutablePartial<TrackedItemAiAnalysisCurrentElements> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = generations[element];
    if (generation == null) {
      continue;
    }
    const evaluation = evaluations[element];
    if (evaluation == null && missingEvaluationElements.has(element)) {
      continue;
    }
    assertNonNullable(evaluation, `AI評価のresultと再利用証明がありません。対象: ${element}`);
    setEvaluatedElement(evaluated, element, generation, evaluation);
  }
  return Object.freeze(evaluated);
}

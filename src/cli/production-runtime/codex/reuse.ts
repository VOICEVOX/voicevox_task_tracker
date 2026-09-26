import type {
  AnalysisElementReuseRecord,
  AnalysisImpactValue,
  CodexAnalysisInput,
} from "../../../codex/index.js";
import {
  analysisImpactResolutionForRole,
  type AnalysisElementDependencyFingerprintMap,
  type AnalysisElementInputFingerprintMap,
  type AnalysisImpactDecisionForDiagnostics,
} from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
} from "../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../domain/ai-analysis-source-generations.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import type { RuntimeState } from "../contracts.js";
import {
  savedAdoptionRecordsForItem,
  savedEvaluationRecordsForItem,
} from "../previous-state/ai-reuse.js";
import { previousTrackedItem } from "../previous-state/snapshot.js";

type AnalysisImpactResolutionMap = Readonly<
  Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>
>;

type AnalysisImpactResolutions = Readonly<{
  evaluation: AnalysisImpactResolutionMap;
  adopted: AnalysisImpactResolutionMap;
  decisions: readonly Readonly<{
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
}>;

function analysisImpactValue<Result>(
  result: Result | undefined,
  absentReason: "not_adopted" | "not_evaluated",
): AnalysisImpactValue<Result> {
  return result == null
    ? Object.freeze({ status: "absent", reason: absentReason })
    : Object.freeze({ status: "present", result });
}

export function analysisImpactProofsForItem(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  relatedInput: CodexAnalysisInput,
  inputFingerprints: AnalysisElementInputFingerprintMap,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisImpactResolutions {
  const evaluation = savedEvaluationRecordsForItem(
    state,
    analysis.item.nodeId,
    inputFingerprints,
    dependencyFingerprints,
  );
  const adoptedRecords = savedAdoptionRecordsForItem(
    state,
    analysis.item.nodeId,
    inputFingerprints,
    dependencyFingerprints,
  );
  const evaluationWithImpact: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {
    ...evaluation,
  };
  const adoptedWithImpact: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {
    ...adoptedRecords,
  };
  const decisions: {
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }[] = [];
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  if (previousItem == null) {
    return Object.freeze({
      evaluation: Object.freeze(evaluationWithImpact),
      adopted: Object.freeze(adoptedWithImpact),
      decisions: Object.freeze([]),
    });
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = evaluation[element];
    const adopted = adoptedRecords[element];
    const adoptedResult = analysisImpactValue(adopted?.result, "not_adopted");
    const evaluatedResult = analysisImpactValue(evaluated?.result, "not_evaluated");
    const evaluatedGeneration = previousItem.aiAnalysis.elements[element];
    const adoptedElement = previousItem.aiAnalysis.adoptedElements[element];
    const adoptedGeneration =
      adoptedElement?.origin === "current"
        ? createAiAnalysisElementSourceGenerationSchema(element).parse(adoptedElement.generation)
        : undefined;
    const roles: readonly Readonly<{
      role: "adopted" | "evaluated";
      record: AnalysisElementReuseRecord | undefined;
      generation: AiAnalysisElementSourceGeneration | undefined;
    }>[] = Object.freeze([
      Object.freeze({
        role: "evaluated",
        record: evaluated,
        generation:
          evaluatedGeneration == null
            ? undefined
            : createAiAnalysisElementSourceGenerationSchema(element).parse(
                evaluatedGeneration.generation,
              ),
      }),
      Object.freeze({ role: "adopted", record: adopted, generation: adoptedGeneration }),
    ]);
    for (const current of roles) {
      if (current.record == null) {
        continue;
      }
      const generation =
        current.generation == null
          ? undefined
          : createAiAnalysisElementSourceGenerationSchema(element).parse(current.generation);
      const impact = analysisImpactResolutionForRole(
        element,
        current.role,
        generation,
        current.record,
        adoptedResult,
        evaluatedResult,
        relatedInput,
        dependencyFingerprints,
      );
      if (impact.decision != null) {
        decisions.push({ element, role: current.role, decision: impact.decision });
      }
      if (impact.resolution != null) {
        if (current.role === "evaluated") {
          evaluationWithImpact[element] = impact.resolution;
        } else {
          adoptedWithImpact[element] = impact.resolution;
        }
      }
    }
  }
  return Object.freeze({
    evaluation: Object.freeze(evaluationWithImpact),
    adopted: Object.freeze(adoptedWithImpact),
    decisions: Object.freeze(decisions.map((value) => Object.freeze(value))),
  });
}

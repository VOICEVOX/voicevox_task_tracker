import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
} from "../../../codex/generic-ai-definition.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementReuseProofSchema,
  type AiAnalysisElement,
  type AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import { AI_ANALYSIS_DEPENDENCY_ELEMENTS } from "../../../domain/ai-analysis-dependencies.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { PreviousTrackedItem } from "../contracts/previous-state.js";

function hasCurrentAnalysisReuseProof(
  element: AiAnalysisElement,
  proof: AiAnalysisElementReuseProof,
): boolean {
  return (
    proof.status === "verified" &&
    proof.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
    proof.inputProjectionVersion === AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element]
  );
}

function staleMigrationAiAnalysisElementsForLifecycle(
  aiAnalysis: Extract<TrackedItemAiAnalysis, { origin: "migration" }>,
): readonly AiAnalysisElement[] {
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.filter((element) => {
      const evaluated = aiAnalysis.elements[element];
      const adopted = aiAnalysis.adoptedElements[element];
      const retained = aiAnalysis.retainedElements[element];
      if (evaluated == null && adopted == null && retained == null) {
        return false;
      }
      const evaluationIsCurrent =
        evaluated != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof),
        );
      const adoptionIsCurrent =
        adopted != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
        );
      return !evaluationIsCurrent && !adoptionIsCurrent;
    }),
  );
}

/** 前回のAI解析で再評価が必要な要素を参照する。 */
export function staleAiAnalysisElementsForLifecycle(
  item: PreviousTrackedItem | undefined,
): readonly AiAnalysisElement[] {
  if (item == null) {
    return Object.freeze([]);
  }
  const hasUnresolvedAiDependency = AI_ANALYSIS_DEPENDENCY_ELEMENTS.some(
    (element) => item.aiDependencies[element].status === "unknown",
  );
  if (item.aiAnalysis.status === "not_required" && !hasUnresolvedAiDependency) {
    return Object.freeze([]);
  }
  if (hasUnresolvedAiDependency) {
    const staleElements = AI_ANALYSIS_ELEMENTS.filter((element) => {
      const evaluated = item.aiAnalysis.elements[element];
      const adopted = item.aiAnalysis.adoptedElements[element];
      const retained = item.aiAnalysis.retainedElements[element];
      return evaluated != null || adopted != null || retained != null;
    });
    return Object.freeze(
      staleElements.includes("status") ? staleElements : ["status", ...staleElements],
    );
  }
  if (item.aiAnalysis.origin === "migration") {
    return staleMigrationAiAnalysisElementsForLifecycle(item.aiAnalysis);
  }
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.filter((element) => {
      const evaluated = item.aiAnalysis.elements[element];
      const adopted = item.aiAnalysis.adoptedElements[element];
      const retained = item.aiAnalysis.retainedElements[element];
      if (evaluated == null && adopted == null && retained == null) {
        return false;
      }
      const evaluationIsCurrent =
        evaluated != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof),
        );
      const adoptionIsCurrent =
        adopted != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
        );
      return !evaluationIsCurrent && !adoptionIsCurrent;
    }),
  );
}

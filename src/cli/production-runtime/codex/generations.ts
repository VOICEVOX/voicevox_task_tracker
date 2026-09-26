import {
  reduceAiAnalysisElements,
  type AiAnalysisElementSourceGenerationMap,
  type AiAnalysisRunResult,
  type AiAnalysisTarget,
  type AnalysisElementPlanning,
} from "../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
} from "../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../domain/ai-analysis-source-generations.js";
import type { GitHubNodeId } from "../../../domain/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { generatedElementsForNode } from "../ai-analysis-run-index.js";
import { isForcedUnexecutedElement } from "../ai-analysis-target.js";
import type { RuntimeState } from "../contracts.js";
import { savedGenerationsForItem } from "../previous-state/saved-ai-elements.js";

function generationsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning | undefined,
  run: AiAnalysisRunResult | undefined,
  target: AiAnalysisTarget | undefined,
): AiAnalysisElementSourceGenerationMap {
  const saved = savedGenerationsForItem(state, analysis.item.nodeId);
  if (planning == null) {
    return saved;
  }
  const generated = generatedElementsForNode(run, analysis.item.nodeId);
  const preserved: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (generated[element] != null) {
      continue;
    }
    const generation = saved[element];
    if (generation == null) {
      continue;
    }
    if (
      isForcedUnexecutedElement(analysis, element, target) &&
      planning.candidates[element].necessity === "not_required"
    ) {
      continue;
    }
    preserved[element] = createAiAnalysisElementSourceGenerationSchema(element).parse(generation);
  }
  return reduceAiAnalysisElements({
    selectedElements: planning.selection.selected.map((candidate) => candidate.element),
    generatedElements: generated,
    preservedElements: preserved,
  }).elements;
}

export function elementGenerationsByNodeId(
  state: RuntimeState,
  analyses: readonly DeterministicItemAnalysis[],
  planningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>,
  run: AiAnalysisRunResult | undefined,
  target: AiAnalysisTarget | undefined,
): ReadonlyMap<GitHubNodeId, AiAnalysisElementSourceGenerationMap> {
  const generations = new Map<GitHubNodeId, AiAnalysisElementSourceGenerationMap>();
  for (const analysis of analyses) {
    generations.set(
      analysis.item.nodeId,
      generationsForAnalysis(
        state,
        analysis,
        planningByNodeId.get(analysis.item.nodeId),
        run,
        target,
      ),
    );
  }
  return generations;
}

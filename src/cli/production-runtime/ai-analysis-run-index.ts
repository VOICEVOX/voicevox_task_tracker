import type { AiAnalysisElementGenerationMap, AiAnalysisRunResult } from "../../codex/index.js";
import {
  createAiAnalysisElementGenerationSchema,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
} from "../../domain/ai-analysis-elements.js";
import type { GitHubNodeId } from "../../domain/index.js";

type AiAnalysisRunElement = AiAnalysisRunResult["results"][number]["elements"][number];

type AiAnalysisRunIndex = Readonly<{
  resultByNodeId: ReadonlyMap<string, AiAnalysisRunResult["results"][number]>;
  failureByNodeId: ReadonlyMap<string, AiAnalysisRunResult["failures"][number]>;
  deferredByNodeId: ReadonlyMap<string, AiAnalysisRunResult["deferred"][number]>;
  skippedByNodeId: ReadonlyMap<string, AiAnalysisRunResult["skipped"][number]>;
  generatedElementsByNodeId: ReadonlyMap<string, AiAnalysisElementGenerationMap>;
}>;

const EMPTY_AI_ANALYSIS_ELEMENT_GENERATIONS = Object.freeze({});
const EMPTY_AI_ANALYSIS_RUN_INDEX: AiAnalysisRunIndex = Object.freeze({
  resultByNodeId: new Map(),
  failureByNodeId: new Map(),
  deferredByNodeId: new Map(),
  skippedByNodeId: new Map(),
  generatedElementsByNodeId: new Map(),
});
const aiAnalysisRunIndexByRun = new WeakMap<AiAnalysisRunResult, AiAnalysisRunIndex>();

function generationMapForRunElements(
  elements: readonly AiAnalysisRunElement[],
): AiAnalysisElementGenerationMap {
  const generations: Partial<Record<AiAnalysisElement, AiAnalysisElementGeneration>> = {};
  for (const elementResult of elements) {
    const element = elementResult.element;
    const generation = createAiAnalysisElementGenerationSchema(element).parse(
      elementResult.generation,
    );
    generations[element] = generation;
  }
  return Object.freeze(generations);
}

/** AI実行結果を項目IDで参照する索引を取得する。 */
export function aiAnalysisRunIndex(run: AiAnalysisRunResult | undefined): AiAnalysisRunIndex {
  if (run == null) {
    return EMPTY_AI_ANALYSIS_RUN_INDEX;
  }
  const cached = aiAnalysisRunIndexByRun.get(run);
  if (cached != null) {
    return cached;
  }
  const resultByNodeId = new Map<string, AiAnalysisRunResult["results"][number]>();
  const failureByNodeId = new Map<string, AiAnalysisRunResult["failures"][number]>();
  const deferredByNodeId = new Map<string, AiAnalysisRunResult["deferred"][number]>();
  const skippedByNodeId = new Map<string, AiAnalysisRunResult["skipped"][number]>();
  const generatedElementsByNodeId = new Map<string, AiAnalysisElementGenerationMap>();
  for (const result of run.results) {
    if (!resultByNodeId.has(result.candidateId)) {
      resultByNodeId.set(result.candidateId, result);
      generatedElementsByNodeId.set(
        result.candidateId,
        generationMapForRunElements(result.elements),
      );
    }
  }
  for (const failure of run.failures) {
    if (!failureByNodeId.has(failure.candidateId)) {
      failureByNodeId.set(failure.candidateId, failure);
    }
  }
  for (const deferred of run.deferred) {
    if (!deferredByNodeId.has(deferred.candidateId)) {
      deferredByNodeId.set(deferred.candidateId, deferred);
    }
  }
  for (const skipped of run.skipped) {
    if (!skippedByNodeId.has(skipped.candidateId)) {
      skippedByNodeId.set(skipped.candidateId, skipped);
    }
  }
  const index: AiAnalysisRunIndex = Object.freeze({
    resultByNodeId,
    failureByNodeId,
    deferredByNodeId,
    skippedByNodeId,
    generatedElementsByNodeId,
  });
  aiAnalysisRunIndexByRun.set(run, index);
  return index;
}

/** 項目に対して生成されたAI要素を取得する。 */
export function generatedElementsForNode(
  run: AiAnalysisRunResult | undefined,
  nodeId: GitHubNodeId,
): AiAnalysisElementGenerationMap {
  return (
    aiAnalysisRunIndex(run).generatedElementsByNodeId.get(nodeId) ??
    EMPTY_AI_ANALYSIS_ELEMENT_GENERATIONS
  );
}

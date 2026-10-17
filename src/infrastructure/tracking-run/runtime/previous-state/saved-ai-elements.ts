import type { DeterministicItemAnalysis } from "../../../../application/tracking-run/stages/deterministic-item.js";
import type {
  AiAnalysisElementSourceGenerationMap,
  AnalysisElementReuseRecord,
  CodexPreservedElements,
} from "../../../../codex/index.js";
import {
  currentAiAdoptedElement,
  historicalAiAdoptedElement,
} from "../../../../domain/ai-analysis-current.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../../domain/ai-analysis-source-generations.js";
import type {
  GitHubNodeId,
  TrackedItemAiAnalysisCurrentAdoptedElement,
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../../../../domain/index.js";
import type { SnapshotTrackedItem } from "../../../../persistence/index.js";
import { UnreachableError } from "../../../../util/index.js";
import type { RuntimeState } from "../contracts.js";
import { previousTrackedItem } from "./snapshot.js";

export function savedGenerationsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): AiAnalysisElementSourceGenerationMap {
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze({});
  }
  const generations: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = item.aiAnalysis.elements[element];
    if (evaluated == null) {
      continue;
    }
    generations[element] = createAiAnalysisElementSourceGenerationSchema(element).parse(
      evaluated.generation,
    );
  }
  return Object.freeze(generations);
}

function currentAdoptedElementEntry(
  element: AiAnalysisElement,
  value: TrackedItemAiAnalysisCurrentAdoptedElement,
): TrackedItemAiAnalysisCurrentAdoptedElements {
  const reuseProof = aiAnalysisElementReuseProofSchema.parse(value.reuseProof);
  switch (element) {
    case "status":
      return Object.freeze({
        status: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("status").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("status").parse(value.result),
          reuseProof,
        }),
      });
    case "waitingOn":
      return Object.freeze({
        waitingOn: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(value.result),
          reuseProof,
        }),
      });
    case "nextAction":
      return Object.freeze({
        nextAction: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("nextAction").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(value.result),
          reuseProof,
        }),
      });
    case "relations":
      return Object.freeze({
        relations: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("relations").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("relations").parse(value.result),
          reuseProof,
        }),
      });
    case "progress":
      return Object.freeze({
        progress: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("progress").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("progress").parse(value.result),
          reuseProof,
        }),
      });
    case "importance":
      return Object.freeze({
        importance: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("importance").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("importance").parse(value.result),
          reuseProof,
        }),
      });
    case "deadline":
      return Object.freeze({
        deadline: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("deadline").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("deadline").parse(value.result),
          reuseProof,
        }),
      });
    case "notification":
      return Object.freeze({
        notification: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("notification").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("notification").parse(value.result),
          reuseProof,
        }),
      });
    case "selfCommitment":
      return Object.freeze({
        selfCommitment: Object.freeze({
          origin: "current",
          generation: createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(
            value.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(
            value.result,
          ),
          reuseProof,
        }),
      });
    default:
      throw new UnreachableError(element);
  }
}

export function savedCurrentAdoptedElementsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): TrackedItemAiAnalysisCurrentAdoptedElements {
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze({});
  }
  let adopted: TrackedItemAiAnalysisCurrentAdoptedElements = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const value = currentAiAdoptedElement(item.aiAnalysis, element);
    if (value == null) {
      continue;
    }
    adopted = Object.freeze({ ...adopted, ...currentAdoptedElementEntry(element, value) });
  }
  return Object.freeze(adopted);
}

export function savedEvaluationRecordForElement(
  state: RuntimeState,
  nodeId: GitHubNodeId,
  element: AiAnalysisElement,
): AnalysisElementReuseRecord | undefined {
  const item = previousTrackedItem(state, nodeId);
  const evaluated = item?.aiAnalysis.elements[element];
  if (evaluated == null) {
    return undefined;
  }
  return Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema(element).parse(evaluated.result),
    proof: aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof),
  });
}

export function savedMigrationAdoptedElementsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  const item = previousTrackedItem(state, nodeId);
  if (item?.aiAnalysis.origin !== "migration") {
    return Object.freeze({});
  }
  return item.aiAnalysis.retainedElements;
}

export function historicalAdoptedResultForItem(
  item: SnapshotTrackedItem,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = historicalAiAdoptedElement(item.aiAnalysis, element);
  if (adopted == null) {
    return undefined;
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}

export function preservedElementsForRetainedItem(
  item: SnapshotTrackedItem,
): Pick<CodexPreservedElements, "relations" | "notification"> {
  const relations = historicalAdoptedResultForItem(item, "relations");
  const notification = historicalAdoptedResultForItem(item, "notification");
  return Object.freeze({
    ...(relations == null ? {} : { relations }),
    ...(notification == null ? {} : { notification }),
  });
}

export function currentAdoptedElementForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): TrackedItemAiAnalysisCurrentAdoptedElement | undefined {
  const adopted = savedCurrentAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted == null) {
    return undefined;
  }
  return Object.freeze({
    origin: "current",
    generation: createAiAnalysisElementSourceGenerationSchema(element).parse(adopted.generation),
    result: createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result),
    reuseProof: aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
  });
}

export function currentAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = currentAdoptedElementForElement(state, analysis, element);
  return adopted == null ? undefined : adopted.result;
}

export function currentSavedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  return currentAdoptedResultForElement(state, analysis, element);
}

export function currentSavedGenerationForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementSourceGeneration | undefined {
  return currentAdoptedElementForElement(state, analysis, element)?.generation;
}

export function migrationAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted?.origin !== "migration") {
    return undefined;
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}

import type {
  AiAnalysisElementSourceGenerationMap,
  AnalysisElementReuseRecord,
  CodexPreservedElements,
} from "../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../domain/ai-analysis-source-generations.js";
import type {
  GitHubNodeId,
  TrackedItemAiAnalysisCurrentAdoptedElement,
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../../../domain/index.js";
import type { SnapshotTrackedItem } from "../../../persistence/index.js";
import { UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import type { MutablePartial, RuntimeState } from "../contracts.js";
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

export function setCurrentAdoptedElement(
  adopted: MutablePartial<TrackedItemAiAnalysisCurrentAdoptedElements>,
  element: AiAnalysisElement,
  value: TrackedItemAiAnalysisCurrentAdoptedElement,
): void {
  const reuseProof = aiAnalysisElementReuseProofSchema.parse(value.reuseProof);
  switch (element) {
    case "status":
      adopted.status = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("status").parse(value.generation),
        result: createAiAnalysisMigrationElementResultSchema("status").parse(value.result),
        reuseProof,
      };
      return;
    case "waitingOn":
      adopted.waitingOn = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(value.result),
        reuseProof,
      };
      return;
    case "nextAction":
      adopted.nextAction = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("nextAction").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(value.result),
        reuseProof,
      };
      return;
    case "relations":
      adopted.relations = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("relations").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(value.result),
        reuseProof,
      };
      return;
    case "progress":
      adopted.progress = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("progress").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("progress").parse(value.result),
        reuseProof,
      };
      return;
    case "importance":
      adopted.importance = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("importance").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("importance").parse(value.result),
        reuseProof,
      };
      return;
    case "deadline":
      adopted.deadline = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("deadline").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("deadline").parse(value.result),
        reuseProof,
      };
      return;
    case "notification":
      adopted.notification = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("notification").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(value.result),
        reuseProof,
      };
      return;
    case "selfCommitment":
      adopted.selfCommitment = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(value.result),
        reuseProof,
      };
      return;
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
  if (item.aiAnalysis.origin === "current") {
    return item.aiAnalysis.adoptedElements;
  }
  const adopted: MutablePartial<TrackedItemAiAnalysisCurrentAdoptedElements> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const value = item.aiAnalysis.adoptedElements[element];
    if (value?.origin !== "current") {
      continue;
    }
    setCurrentAdoptedElement(adopted, element, value);
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
  return item.aiAnalysis.adoptedElements;
}

export function adoptedResultForRetainedItem(
  item: SnapshotTrackedItem,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  if (item.aiAnalysis.origin === "current") {
    const adopted = item.aiAnalysis.adoptedElements[element];
    if (adopted == null) {
      return undefined;
    }
    return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
  }
  const adopted = item.aiAnalysis.adoptedElements[element];
  if (adopted == null) {
    return undefined;
  }
  if (adopted.origin === "current") {
    return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}

export function preservedElementsForRetainedItem(
  item: SnapshotTrackedItem,
): Pick<CodexPreservedElements, "relations" | "notification"> {
  const relations = adoptedResultForRetainedItem(item, "relations");
  const notification = adoptedResultForRetainedItem(item, "notification");
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

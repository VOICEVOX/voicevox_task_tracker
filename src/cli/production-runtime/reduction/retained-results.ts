import type {
  AiAnalysisTarget,
  AnalysisElementPlanning,
  AnalysisElementReuseRecord,
  CodexPreservedElements,
} from "../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { isForcedUnexecutedElement } from "../ai-analysis-target.js";
import type { CodexAnalysis, RuntimeState } from "../contracts.js";
import { preservedElementsWithCompatibleRelations } from "../preserved-codex-relations.js";
import {
  adoptedResultForRetainedItem,
  currentSavedResultForElement,
} from "../previous-state/saved-ai-elements.js";
import { previousTrackedItem } from "../previous-state/snapshot.js";
import { forcedMigrationAdoptedElementForElement } from "./evaluation-records.js";

function preservedElementsForForcedReduction(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): CodexPreservedElements {
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = planning.candidates[element];
    if (candidate.necessity !== "required") {
      continue;
    }
    let result: AiAnalysisElementMigrationResult | undefined;
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    if (forcedMigration != null) {
      result = createAiAnalysisMigrationElementResultSchema(element).parse(forcedMigration.result);
    } else if (isForcedUnexecutedElement(analysis, element, target)) {
      result = currentSavedResultForElement(state, analysis, element);
    }
    result ??= candidate.savedReuse?.result;
    if (result == null && previousItem != null) {
      result = adoptedResultForRetainedItem(previousItem, element);
    }
    if (result != null) {
      preservedElements[element] = result;
    }
  }
  return Object.freeze(preservedElements);
}

export function adoptedRecordsForPlanning(
  planning: AnalysisElementPlanning,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const record = planning.candidates[element].savedReuse;
    if (record != null) {
      records[element] = record;
    }
  }
  return Object.freeze(records);
}

function preservedElementsForReduction(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
): CodexPreservedElements {
  let status: AiAnalysisElementMigrationResult<"status"> | undefined;
  let waitingOn: AiAnalysisElementMigrationResult<"waitingOn"> | undefined;
  let nextAction: AiAnalysisElementMigrationResult<"nextAction"> | undefined;
  let relations: AiAnalysisElementMigrationResult<"relations"> | undefined;
  let progress: AiAnalysisElementMigrationResult<"progress"> | undefined;
  let importance: AiAnalysisElementMigrationResult<"importance"> | undefined;
  let deadline: AiAnalysisElementMigrationResult<"deadline"> | undefined;
  let notification: AiAnalysisElementMigrationResult<"notification"> | undefined;
  let selfCommitment: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);

  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = planning.candidates[element];
    if (candidate.necessity !== "required") {
      continue;
    }
    const retained =
      candidate.savedReuse?.result ??
      (previousItem == null ? undefined : adoptedResultForRetainedItem(previousItem, element));
    if (retained == null) {
      continue;
    }
    switch (element) {
      case "status":
        status = createAiAnalysisMigrationElementResultSchema("status").parse(retained);
        break;
      case "waitingOn":
        waitingOn = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(retained);
        break;
      case "nextAction":
        nextAction = createAiAnalysisMigrationElementResultSchema("nextAction").parse(retained);
        break;
      case "relations":
        relations = createAiAnalysisMigrationElementResultSchema("relations").parse(retained);
        break;
      case "progress":
        progress = createAiAnalysisMigrationElementResultSchema("progress").parse(retained);
        break;
      case "importance":
        importance = createAiAnalysisMigrationElementResultSchema("importance").parse(retained);
        break;
      case "deadline":
        deadline = createAiAnalysisMigrationElementResultSchema("deadline").parse(retained);
        break;
      case "notification":
        notification = createAiAnalysisMigrationElementResultSchema("notification").parse(retained);
        break;
      case "selfCommitment":
        selfCommitment =
          createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(retained);
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze({
    ...(status == null ? {} : { status }),
    ...(waitingOn == null ? {} : { waitingOn }),
    ...(nextAction == null ? {} : { nextAction }),
    ...(relations == null ? {} : { relations }),
    ...(progress == null ? {} : { progress }),
    ...(importance == null ? {} : { importance }),
    ...(deadline == null ? {} : { deadline }),
    ...(notification == null ? {} : { notification }),
    ...(selfCommitment == null ? {} : { selfCommitment }),
  });
}

export function preservedElementsForAnalysisReduction(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
  target: AiAnalysisTarget | undefined,
): CodexPreservedElements {
  const planning = codexAnalysis.elementPlanningByNodeId.get(analysis.item.nodeId);
  assertNonNullable(planning, `AI判定要素の計画がありません。対象: ${analysis.item.nodeId}`);
  const preservedElements =
    target == null
      ? preservedElementsForReduction(state, analysis, planning)
      : preservedElementsForForcedReduction(state, analysis, planning, target);
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  return preservedElementsWithCompatibleRelations(preservedElements, input);
}

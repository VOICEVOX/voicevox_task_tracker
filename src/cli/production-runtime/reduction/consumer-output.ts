import {
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  effectiveElementConfidence,
  listNativeRelationConstraints,
  validateCodexElementOutputSchema,
  type SchemaValidCodexElementOutput,
} from "../../../codex/index.js";
import { isStateAnalysisElement } from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import { isTerminalStatus } from "../../../domain/index.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { aiAnalysisRunIndex } from "../ai-analysis-run-index.js";
import { forcedAiAnalysisTarget, isForcedUnexecutedElement } from "../ai-analysis-target.js";
import type { CodexAnalysis, RuntimeConfiguration, RuntimeState } from "../contracts.js";
import {
  currentAdoptedResultForElement,
  currentSavedResultForElement,
  migrationAdoptedResultForElement,
} from "../previous-state/saved-ai-elements.js";
import { forcedMigrationAdoptedElementForElement } from "./evaluation-records.js";

export type ConsumerCodexElementOutput = Readonly<{
  schemaVersion: typeof CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION;
  item: Readonly<{
    nodeId: string;
    url: string;
  }>;
  status?: AiAnalysisElementMigrationResult<"status"> | undefined;
  waitingOn?: AiAnalysisElementMigrationResult<"waitingOn"> | undefined;
  nextAction?: AiAnalysisElementMigrationResult<"nextAction"> | undefined;
  relations?: AiAnalysisElementMigrationResult<"relations"> | undefined;
  progress?: AiAnalysisElementMigrationResult<"progress"> | undefined;
  importance?: AiAnalysisElementMigrationResult<"importance"> | undefined;
  deadline?: AiAnalysisElementMigrationResult<"deadline"> | undefined;
  notification?: AiAnalysisElementMigrationResult<"notification"> | undefined;
  selfCommitment?: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
}>;

type MutableConsumerCodexElementOutput = {
  -readonly [Key in keyof ConsumerCodexElementOutput]: ConsumerCodexElementOutput[Key];
};

export function codexOutputForAnalysis(
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): SchemaValidCodexElementOutput | undefined {
  const result = aiAnalysisRunIndex(codexAnalysis.run).resultByNodeId.get(analysis.item.nodeId);
  if (result == null) {
    return undefined;
  }
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
  const output: Record<string, unknown> = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  for (const element of result.elements) {
    output[element.element] = element.generation.result;
  }
  return validateCodexElementOutputSchema(output, input.selectedElements);
}

export function codexElementResult(
  output: ConsumerCodexElementOutput,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  switch (element) {
    case "status":
      return output.status;
    case "waitingOn":
      return output.waitingOn;
    case "nextAction":
      return output.nextAction;
    case "relations":
      return output.relations;
    case "progress":
      return output.progress;
    case "importance":
      return output.importance;
    case "deadline":
      return output.deadline;
    case "notification":
      return output.notification;
    case "selfCommitment":
      return output.selfCommitment;
    default:
      throw new UnreachableError(element);
  }
}

function setConsumerCodexElementResult(
  output: MutableConsumerCodexElementOutput,
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult,
): void {
  switch (element) {
    case "status":
      output.status = createAiAnalysisMigrationElementResultSchema("status").parse(result);
      break;
    case "waitingOn":
      output.waitingOn = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
      break;
    case "nextAction":
      output.nextAction = createAiAnalysisMigrationElementResultSchema("nextAction").parse(result);
      break;
    case "relations":
      output.relations = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
      break;
    case "progress":
      output.progress = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
      break;
    case "importance":
      output.importance = createAiAnalysisMigrationElementResultSchema("importance").parse(result);
      break;
    case "deadline":
      output.deadline = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
      break;
    case "notification":
      output.notification =
        createAiAnalysisMigrationElementResultSchema("notification").parse(result);
      break;
    case "selfCommitment":
      output.selfCommitment =
        createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(result);
      break;
    default:
      throw new UnreachableError(element);
  }
}

export function codexOutputForConsumers(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): ConsumerCodexElementOutput | undefined {
  const rawOutput = codexOutputForAnalysis(analysis, codexAnalysis);
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  const planning = codexAnalysis.elementPlanningByNodeId.get(analysis.item.nodeId);
  if (input == null || planning == null) {
    return rawOutput;
  }
  const rawResults = new Map<AiAnalysisElement, AiAnalysisElementMigrationResult>();
  if (rawOutput != null) {
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const result = codexElementResult(rawOutput, element);
      if (result != null) {
        rawResults.set(element, result);
      }
    }
  }
  const deterministicStatePriority =
    (analysis.decision.determination === "determined" &&
      planning.necessities.status === "not_required" &&
      planning.necessities.waitingOn === "not_required" &&
      planning.necessities.nextAction === "not_required") ||
    listNativeRelationConstraints(input).some(
      (constraint) => constraint.verdict === "current_is_blocked_by_target",
    );
  const stateElementNames: readonly AiAnalysisElement[] = ["status", "waitingOn", "nextAction"];
  const selectedStateElements = stateElementNames.filter((element) =>
    input.selectedElements.includes(element),
  );
  const stateSelectionIsIncomplete =
    selectedStateElements.length >= 2 &&
    selectedStateElements.some((element) => {
      const raw = rawResults.get(element);
      return (
        raw == null ||
        effectiveElementConfidence(element, raw) < configuration.config.ai.confidence.medium
      );
    });
  const output: MutableConsumerCodexElementOutput = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  const target = forcedAiAnalysisTarget(configuration);
  const outputElements = new Set<AiAnalysisElement>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = planning.candidates[element];
    const raw = rawResults.get(element);
    const stateElement = isStateAnalysisElement(element);
    if (codexAnalysis.run == null && stateElement) {
      continue;
    }
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    let adopted: AiAnalysisElementMigrationResult | undefined;
    if (candidate.necessity === "required") {
      if (preserveForcedUnexecutedElement) {
        adopted = currentSavedResultForElement(state, analysis, element);
        if (adopted == null && forcedMigration == null) {
          adopted = candidate.savedReuse?.result;
        }
      } else {
        adopted = candidate.savedReuse?.result;
        adopted ??= currentAdoptedResultForElement(state, analysis, element);
      }
    }
    let migrated: AiAnalysisElementMigrationResult | undefined;
    if (candidate.necessity === "required") {
      if (forcedMigration != null) {
        migrated = createAiAnalysisMigrationElementResultSchema(element).parse(
          forcedMigration.result,
        );
      } else {
        migrated =
          candidate.savedReuse?.result ??
          migrationAdoptedResultForElement(state, analysis, element);
      }
    }
    const result =
      (raw != null &&
      effectiveElementConfidence(element, raw) >= configuration.config.ai.confidence.medium &&
      !(deterministicStatePriority && stateElement) &&
      !(stateSelectionIsIncomplete && stateElement)
        ? raw
        : (adopted ?? migrated)) ?? undefined;
    if (result != null) {
      setConsumerCodexElementResult(output, element, result);
      outputElements.add(element);
    }
  }
  const status = output.status?.value ?? analysis.decision.status;
  const waitingOn = output.waitingOn?.value ?? analysis.decision.waitingOn;
  const stateValuesAreConsistent = isTerminalStatus(status)
    ? waitingOn.length === 0
    : waitingOn.length !== 0;
  if (!stateValuesAreConsistent) {
    delete output.status;
    delete output.waitingOn;
    delete output.nextAction;
    for (const element of stateElementNames) {
      outputElements.delete(element);
    }
  }
  if (outputElements.size === 0) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: output.schemaVersion,
    item: output.item,
    ...(output.status == null ? {} : { status: output.status }),
    ...(output.waitingOn == null ? {} : { waitingOn: output.waitingOn }),
    ...(output.nextAction == null ? {} : { nextAction: output.nextAction }),
    ...(output.relations == null ? {} : { relations: output.relations }),
    ...(output.progress == null ? {} : { progress: output.progress }),
    ...(output.importance == null ? {} : { importance: output.importance }),
    ...(output.deadline == null ? {} : { deadline: output.deadline }),
    ...(output.notification == null ? {} : { notification: output.notification }),
    ...(output.selfCommitment == null ? {} : { selfCommitment: output.selfCommitment }),
  });
}

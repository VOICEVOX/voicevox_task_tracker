import { hashCanonicalJson } from "../../../canonical-json/index.js";
import type {
  AiAnalysisElementSourceGenerationMap,
  AiAnalysisRunResult,
  AiAnalysisTarget,
  AnalysisElementPlanning,
  CodexAnalysisReduction,
} from "../../../codex/index.js";
import {
  isStateAnalysisElement,
  verifiedReuseProof,
} from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../domain/ai-analysis-source-generations.js";
import type {
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisMigrationElements,
} from "../../../domain/index.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { generatedElementsForNode } from "../ai-analysis-run-index.js";
import { isForcedUnexecutedElement } from "../ai-analysis-target.js";
import { stateDependencyFingerprintForResults } from "../analysis-identity.js";
import type { MutablePartial, RuntimeState } from "../contracts.js";
import { unknownReuseProof } from "../previous-state/ai-reuse.js";
import {
  currentAdoptedElementForElement,
  currentSavedGenerationForElement,
  setCurrentAdoptedElement,
} from "../previous-state/saved-ai-elements.js";
import { codexElementResult, type ConsumerCodexElementOutput } from "./consumer-output.js";

function trackedAiAnalysisElementsForGenerations(
  generations: AiAnalysisElementSourceGenerationMap,
): AiAnalysisElementSourceGenerationMap {
  let status: AiAnalysisElementSourceGeneration<"status"> | undefined;
  let waitingOn: AiAnalysisElementSourceGeneration<"waitingOn"> | undefined;
  let nextAction: AiAnalysisElementSourceGeneration<"nextAction"> | undefined;
  let relations: AiAnalysisElementSourceGeneration<"relations"> | undefined;
  let progress: AiAnalysisElementSourceGeneration<"progress"> | undefined;
  let importance: AiAnalysisElementSourceGeneration<"importance"> | undefined;
  let deadline: AiAnalysisElementSourceGeneration<"deadline"> | undefined;
  let notification: AiAnalysisElementSourceGeneration<"notification"> | undefined;
  let selfCommitment: AiAnalysisElementSourceGeneration<"selfCommitment"> | undefined;
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = generations[element];
    if (generation == null) {
      continue;
    }
    switch (element) {
      case "status":
        status = createAiAnalysisElementSourceGenerationSchema("status").parse(generation);
        break;
      case "waitingOn":
        waitingOn = createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(generation);
        break;
      case "nextAction":
        nextAction = createAiAnalysisElementSourceGenerationSchema("nextAction").parse(generation);
        break;
      case "relations":
        relations = createAiAnalysisElementSourceGenerationSchema("relations").parse(generation);
        break;
      case "progress":
        progress = createAiAnalysisElementSourceGenerationSchema("progress").parse(generation);
        break;
      case "importance":
        importance = createAiAnalysisElementSourceGenerationSchema("importance").parse(generation);
        break;
      case "deadline":
        deadline = createAiAnalysisElementSourceGenerationSchema("deadline").parse(generation);
        break;
      case "notification":
        notification =
          createAiAnalysisElementSourceGenerationSchema("notification").parse(generation);
        break;
      case "selfCommitment":
        selfCommitment =
          createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(generation);
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

function adoptedGenerationForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  element: AiAnalysisElement,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  target: AiAnalysisTarget | undefined,
): AiAnalysisElementSourceGeneration | undefined {
  const candidate = planning.candidates[element];
  if (candidate.necessity === "not_required") {
    return undefined;
  }
  const generated = generatedElementsForNode(run, analysis.item.nodeId)[element];
  const application = reduction?.ai.elements[element]?.application;
  const consumerResult =
    consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
  const generatedWasConsumed =
    generated != null &&
    consumerResult != null &&
    hashCanonicalJson(consumerResult) === hashCanonicalJson(generated.result);
  const stateElement = element === "status" || element === "waitingOn" || element === "nextAction";
  const generatedWasAccepted = application === "applied" || (!stateElement && generatedWasConsumed);
  if (generatedWasAccepted) {
    assertNonNullable(generated, `採用されたAI生成結果がありません。対象: ${element}`);
    return createAiAnalysisElementGenerationSchema(element).parse(generated);
  }
  if (isForcedUnexecutedElement(analysis, element, target)) {
    return currentSavedGenerationForElement(state, analysis, element);
  }
  const retained = currentAdoptedElementForElement(state, analysis, element);
  return retained == null
    ? undefined
    : createAiAnalysisElementSourceGenerationSchema(element).parse(retained.generation);
}

export function adoptedElementsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  migration: TrackedItemAiAnalysisMigrationElements,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  target: AiAnalysisTarget | undefined,
): TrackedItemAiAnalysisCurrentAdoptedElements {
  const adoptedGenerations: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> =
    {};
  const generatedElements = generatedElementsForNode(run, analysis.item.nodeId);
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = adoptedGenerationForElement(
      state,
      analysis,
      planning,
      element,
      run,
      reduction,
      consumerOutput,
      target,
    );
    if (generation != null) {
      adoptedGenerations[element] =
        createAiAnalysisElementSourceGenerationSchema(element).parse(generation);
    }
  }
  const currentGenerations = trackedAiAnalysisElementsForGenerations(
    Object.freeze(adoptedGenerations),
  );
  const adoptedResults: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  const generatedAcceptedElements = new Set<AiAnalysisElement>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = currentGenerations[element];
    if (generation == null) {
      continue;
    }
    const retained = currentAdoptedElementForElement(state, analysis, element);
    const candidate = planning.candidates[element];
    const savedReuse = planning.candidates[element].savedReuse;
    const generated = generatedElements[element];
    const application = reduction?.ai.elements[element]?.application;
    const consumerResult =
      consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
    const generatedWasConsumed =
      generated != null &&
      consumerResult != null &&
      hashCanonicalJson(consumerResult) === hashCanonicalJson(generated.result);
    const stateElement = isStateAnalysisElement(element);
    const generatedWasAccepted =
      application === "applied" || (!stateElement && generatedWasConsumed);
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    if (generatedWasAccepted) {
      generatedAcceptedElements.add(element);
    }
    const generatedResult = createAiAnalysisMigrationElementResultSchema(element).parse(
      generation.result,
    );
    let adoptedResult: AiAnalysisElementMigrationResult;
    if (generatedWasAccepted) {
      adoptedResult = generatedResult;
    } else if (preserveForcedUnexecutedElement) {
      adoptedResult = retained?.result ?? savedReuse?.result ?? generatedResult;
    } else {
      adoptedResult = savedReuse?.result ?? retained?.result ?? generatedResult;
    }
    adoptedResults[element] = adoptedResult;
  }
  const finalResults = { ...adoptedResults };
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    if (finalResults[element] == null && migration[element] != null) {
      finalResults[element] = migration[element];
    }
  }
  const finalStateDependencyFingerprint = stateDependencyFingerprintForResults(
    analysis,
    finalResults,
  );
  const adopted: MutablePartial<TrackedItemAiAnalysisCurrentAdoptedElements> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = currentGenerations[element];
    if (generation == null) {
      continue;
    }
    const retained = currentAdoptedElementForElement(state, analysis, element);
    const candidate = planning.candidates[element];
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    let proof: AiAnalysisElementReuseProof;
    if (generatedAcceptedElements.has(element)) {
      proof = verifiedReuseProof(
        element,
        candidate.inputFingerprint,
        isStateAnalysisElement(element)
          ? finalStateDependencyFingerprint
          : hashCanonicalJson({ kind: "independent" }),
        "current_generation",
        ["current_generation"],
      );
    } else if (preserveForcedUnexecutedElement) {
      proof =
        retained?.reuseProof ??
        candidate.savedReuse?.proof ??
        unknownReuseProof("source_input_unavailable");
    } else {
      proof =
        candidate.savedReuse?.proof ??
        retained?.reuseProof ??
        unknownReuseProof("source_input_unavailable");
    }
    const adoptedResult = adoptedResults[element];
    assertNonNullable(adoptedResult, `採用されたAI結果がありません。対象: ${element}`);
    setCurrentAdoptedElement(
      adopted,
      element,
      Object.freeze({
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema(element).parse(generation),
        result: adoptedResult,
        reuseProof: proof,
      }),
    );
  }
  return Object.freeze(adopted);
}

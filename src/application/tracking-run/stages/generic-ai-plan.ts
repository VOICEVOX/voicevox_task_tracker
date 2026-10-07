import type {
  GenericAiItemPlan,
  GenericAiPlan,
  GenericAiPlannedRun,
} from "./generic-ai-plan-contracts.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import {
  elementInputFingerprints,
  createAnalysisElementExactInput,
  createAnalysisElementExactInputs,
  withExecutedAnalysisElementExactInputs,
  type AnalysisElementDependencyFingerprintMap,
  type AnalysisElementInputFingerprintMap,
  type AnalysisImpactDecisionForDiagnostics,
} from "../../../codex/analysis-element-dependencies.js";
import { estimateAiInputCost } from "../../../codex/budget.js";
import { CODEX_PROMPT_BUNDLE_VERSION } from "../../../codex/semantic-validation-issues.js";
import {
  forceAnalysisCandidateElements,
  forceAnalysisElementSelection,
  determineAnalysisElementNecessities,
  planAnalysisElements,
  verifiedPlannedElementResult,
  type AnalysisElementNecessityInput,
  type AnalysisElementPlanning,
} from "../../../codex/element-planning.js";
import {
  prepareAiAnalysisCandidate,
  type AiAnalysisCandidate,
  type AiAnalysisPriority,
  type AiAnalysisRunIdentity,
  type AiAnalysisTarget,
  type PreparedAiAnalysisCandidate,
} from "../../../codex/analysis-selection.js";
import type { AnalysisElementReuseRecord } from "../../../codex/analysis-elements.js";
import { AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS } from "../../../codex/generic-ai-definition.js";
import {
  createCodexAnalysisInput,
  serializeCodexAnalysisInput,
  type CodexAnalysisInput,
} from "../../../codex/input.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementSchema,
  aiAnalysisElementFingerprintSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
} from "../../../domain/ai-analysis-elements.js";
import { reusableAiAdoptedElements } from "../../../domain/ai-analysis-current.js";
import { z } from "zod";
import type { AiAnalysisElementSourceGeneration } from "../../../domain/ai-analysis-source-generations.js";
import type {
  TrackedItemAiAnalysisCurrentElements,
  TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../../../domain/tracked-item-ai-analysis.js";
import { createGenericAiPlannedStageProof } from "../contracts/proofs.js";
import { projectGenericAiRunCore } from "../contracts/run-core.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import { createAiAnalysisRunIdentity } from "./collection-analysis-fingerprint.js";
import { projectFinalSnapshotPlan } from "./final-snapshot-collection.js";
import type { DeterministicallyAnalyzedRun } from "./deterministic.js";
import type { DeterministicItemAnalysis } from "./deterministic-item.js";
import {
  planGenericAiCachedElements,
  type GenericAiCacheLookupPort,
} from "./generic-ai-cache-plan.js";
import type { GenericAiBudgetPlan } from "./generic-ai-budget-plan.js";

export type { GenericAiElementPlan } from "./generic-ai-cache-plan.js";

/** 旧stateから計画に必要な事実だけを投影した項目入力。 */
export type GenericAiPlanningItemSource = Readonly<{
  baseInput: CodexAnalysisInput;
  necessityInput: AnalysisElementNecessityInput;
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap;
  priority: AiAnalysisPriority;
  deterministicStatePriority: boolean;
}>;

/** 保存済み評価と採用の現在性を要素別に照合した結果。 */
export type GenericAiPreviousElements = Readonly<{
  generations: Readonly<Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>>>;
  evaluations: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>;
  reuses: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>;
  adopted: TrackedItemAiAnalysisMigrationAdoptedElements;
  evaluated: TrackedItemAiAnalysisCurrentElements;
  impacts: readonly Readonly<{
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
}>;

/** 未移行のstateと輸送入力を計画段階へ投影する境界。 */
export type GenericAiPlanningPort = Readonly<{
  digest: ContentDigestPort;
  lookupCache: GenericAiCacheLookupPort;
  reserveBudget: (candidates: readonly PreparedAiAnalysisCandidate[]) => GenericAiBudgetPlan;
  target: AiAnalysisTarget | undefined;
  prepareItem: (
    run: DeterministicallyAnalyzedRun,
    analysis: DeterministicItemAnalysis,
  ) => GenericAiPlanningItemSource;
  createCandidateInput: (
    run: DeterministicallyAnalyzedRun,
    analysis: DeterministicItemAnalysis,
    source: GenericAiPlanningItemSource,
  ) => CodexAnalysisInput;
  resolvePrevious: (
    analysis: DeterministicItemAnalysis,
    source: GenericAiPlanningItemSource,
    input: CodexAnalysisInput,
    inputFingerprints: AnalysisElementInputFingerprintMap,
  ) => GenericAiPreviousElements;
  createTransportInput: (
    run: DeterministicallyAnalyzedRun,
    analysis: DeterministicItemAnalysis,
    source: GenericAiPlanningItemSource,
    planning: AnalysisElementPlanning,
    target: AiAnalysisTarget | undefined,
  ) => CodexAnalysisInput;
  serializeTransportInput: (input: CodexAnalysisInput) => string;
  recordInputValidationFailure: (candidateId: string, error: unknown) => Promise<void>;
}>;

function executionFingerprints(
  identity: AiAnalysisRunIdentity,
  digest: ContentDigestPort,
): Readonly<Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>> {
  const values: Partial<Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    values[element] = digest.sha256Utf8(
      serializeCanonicalJson({
        element,
        model: identity.model,
        reasoningEffort: identity.reasoningEffort,
        backendVersion: identity.backendVersion,
        schemaVersion: identity.schemaVersion,
      }),
    );
  }
  return Object.freeze(
    z.record(aiAnalysisElementSchema, aiAnalysisElementFingerprintSchema).parse(values),
  );
}

function targetWithRequiredStateCompanion(
  target: AiAnalysisTarget,
  input: CodexAnalysisInput,
  planning: AnalysisElementPlanning,
): AiAnalysisTarget {
  const statusSelected = target.elements.includes("status");
  const waitingOnSelected = target.elements.includes("waitingOn");
  if (statusSelected === waitingOnSelected) {
    return target;
  }
  const counterpart = statusSelected ? "waitingOn" : "status";
  if (
    input.lockedElements[counterpart] != null ||
    verifiedPlannedElementResult(planning, counterpart) != null
  ) {
    return target;
  }
  if (planning.necessities[counterpart] !== "required") {
    throw new TypeError(`状態要素の固定値も実行候補もありません。対象: ${counterpart}`);
  }
  return Object.freeze({
    ...target,
    elements: Object.freeze(
      AI_ANALYSIS_ELEMENTS.filter(
        (element) => target.elements.includes(element) || element === counterpart,
      ),
    ),
  });
}

/** 確定済み判定から全9要素の汎用AI計画を作る。 */
export async function planGenericAi(
  analyzed: DeterministicallyAnalyzedRun,
  port: GenericAiPlanningPort,
): Promise<GenericAiPlannedRun> {
  const identity = createAiAnalysisRunIdentity(analyzed.core.config);
  const currentExecutionFingerprints = executionFingerprints(identity, port.digest);
  const promptFingerprint = port.digest.sha256Utf8(
    serializeCanonicalJson({
      bundleVersion: CODEX_PROMPT_BUNDLE_VERSION,
    }),
  );
  const target = port.target;
  if (target != null && !analyzed.core.config.ai.enabled) {
    throw new TypeError("forced sandbox実行にはAIを有効にしてください");
  }
  const items: GenericAiItemPlan[] = [];
  const failures: GenericAiPlan["failures"][number][] = [];
  const analysisImpactDecisions: GenericAiPlan["analysisImpactDecisions"][number][] = [];
  const itemIds = new Set<string>();
  for (const analysis of analyzed.data.facts.items) {
    const nodeId = analysis.item.nodeId;
    if (itemIds.has(nodeId)) {
      throw new TypeError(`AI計画の項目IDが重複しています。対象: ${nodeId}`);
    }
    itemIds.add(nodeId);
    let source: GenericAiPlanningItemSource;
    try {
      source = port.prepareItem(analyzed, analysis);
    } catch (error: unknown) {
      await port.recordInputValidationFailure(nodeId, error);
      const previous =
        analyzed.core.previousState.snapshot.status === "available"
          ? analyzed.core.previousState.snapshot.trackedItems.find((item) => item.nodeId === nodeId)
          : undefined;
      failures.push(
        Object.freeze({
          candidateId: nodeId,
          reason: "input_validation_failed",
          errorType: error instanceof Error ? error.name : typeof error,
          previousAdopted:
            previous == null ? Object.freeze({}) : reusableAiAdoptedElements(previous.aiAnalysis),
          previousEvaluated: previous?.aiAnalysis.elements ?? Object.freeze({}),
        }),
      );
      continue;
    }
    const candidateInput = port.createCandidateInput(analyzed, analysis, source);
    const candidateExactInputs = createAnalysisElementExactInputs(candidateInput);
    const candidateFingerprints = elementInputFingerprints(candidateExactInputs);
    const candidatePrevious = port.resolvePrevious(
      analysis,
      source,
      candidateInput,
      candidateFingerprints,
    );
    const preliminaryPlanning = planAnalysisElements({
      necessities: determineAnalysisElementNecessities(source.necessityInput),
      inputFingerprints: candidateFingerprints,
      executionFingerprints: currentExecutionFingerprints,
      inputProjectionVersions: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
      dependencyFingerprints: source.dependencyFingerprints,
      savedGenerations: candidatePrevious.generations,
      savedEvaluations: candidatePrevious.evaluations,
      savedReuses: candidatePrevious.reuses,
    });
    const targetForItem = target?.nodeId === nodeId ? target : undefined;
    const executionTarget =
      targetForItem == null
        ? undefined
        : targetWithRequiredStateCompanion(targetForItem, candidateInput, preliminaryPlanning);
    const preliminaryExecutionPlanning =
      target == null
        ? preliminaryPlanning
        : executionTarget != null
          ? Object.freeze({
              ...preliminaryPlanning,
              selection: forceAnalysisElementSelection(preliminaryPlanning, executionTarget),
            })
          : Object.freeze({
              ...preliminaryPlanning,
              selection: Object.freeze({
                ...preliminaryPlanning.selection,
                selected: Object.freeze([]),
                shouldCallAi: false,
              }),
            });
    let input = port.createTransportInput(
      analyzed,
      analysis,
      source,
      preliminaryExecutionPlanning,
      executionTarget,
    );
    const exactInputs = withExecutedAnalysisElementExactInputs(candidateExactInputs, input);
    const inputFingerprints = elementInputFingerprints(exactInputs);
    const previous = port.resolvePrevious(analysis, source, input, inputFingerprints);
    for (const impact of previous.impacts) {
      analysisImpactDecisions.push(Object.freeze({ candidateId: nodeId, ...impact }));
    }
    const planning = planAnalysisElements({
      necessities: determineAnalysisElementNecessities(source.necessityInput),
      inputFingerprints,
      executionFingerprints: currentExecutionFingerprints,
      inputProjectionVersions: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
      dependencyFingerprints: source.dependencyFingerprints,
      savedGenerations: previous.generations,
      savedEvaluations: previous.evaluations,
      savedReuses: previous.reuses,
    });
    const executionPlanning =
      target == null
        ? planning
        : executionTarget != null
          ? Object.freeze({
              ...planning,
              selection: forceAnalysisElementSelection(planning, executionTarget),
            })
          : Object.freeze({
              ...planning,
              selection: Object.freeze({
                ...planning.selection,
                selected: Object.freeze([]),
                shouldCallAi: false,
              }),
            });
    const selectedElements = executionPlanning.selection.selected.map((value) => value.element);
    if (selectedElements.some((element) => !input.selectedElements.includes(element))) {
      throw new TypeError(`汎用AIの確定計画に新しい選択要素があります。対象: ${nodeId}`);
    }
    if (input.selectedElements.length !== selectedElements.length) {
      input = createCodexAnalysisInput({ ...input, selectedElements });
    }
    for (const element of selectedElements) {
      if (
        createAnalysisElementExactInput(input, element).fingerprint !==
        exactInputs[element].fingerprint
      ) {
        throw new TypeError(
          `汎用AIの実輸送入力が確定済みfingerprintと一致しません。対象: ${nodeId}/${element}`,
        );
      }
    }
    const elements = await planGenericAiCachedElements(
      exactInputs,
      executionPlanning,
      executionTarget ?? target,
      nodeId,
      analyzed.core.config.ai.enabled,
      identity,
      port.lookupCache,
    );
    const candidate = prepareAiAnalysisCandidate(
      Object.freeze({
        id: nodeId,
        input,
        elements:
          executionTarget == null
            ? Object.freeze(AI_ANALYSIS_ELEMENTS.map((element) => planning.candidates[element]))
            : forceAnalysisCandidateElements(planning, executionTarget),
        promptFingerprint,
        priority: source.priority,
        estimatedCostUsd: estimateAiInputCost(
          serializeCodexAnalysisInput(input),
          analyzed.core.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        ).estimatedCostUsd,
      } satisfies AiAnalysisCandidate),
      executionPlanning.selection,
    );
    const misses = elements.filter((element) => element.choice === "execute");
    const executionInput =
      misses.length === 0
        ? undefined
        : createCodexAnalysisInput({
            ...input,
            selectedElements: misses.map((element) => element.element),
          });
    const preparedExecutionCandidate =
      executionInput == null
        ? undefined
        : prepareAiAnalysisCandidate(
            Object.freeze({
              ...candidate,
              input: executionInput,
            }),
            Object.freeze({
              ...executionPlanning.selection,
              selected: Object.freeze(
                executionPlanning.selection.selected.filter((value) =>
                  misses.some((element) => element.element === value.element),
                ),
              ),
            }),
          );
    const executionInputJson =
      executionInput == null ? undefined : port.serializeTransportInput(executionInput);
    const executionCandidate =
      preparedExecutionCandidate == null || executionInputJson == null
        ? undefined
        : Object.freeze({
            ...preparedExecutionCandidate,
            normalizedInput: executionInputJson,
            inputCharacters: Array.from(executionInputJson).length,
            estimatedCostUsd: estimateAiInputCost(
              executionInputJson,
              analyzed.core.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
            ).estimatedCostUsd,
          });
    items.push(
      Object.freeze({
        nodeId,
        selectedElements: Object.freeze(
          executionPlanning.selection.selected.map((value) => value.element),
        ),
        elements,
        planning: executionPlanning,
        previousAdopted: previous.adopted,
        previousEvaluated: previous.evaluated,
        deterministicStatePriority: source.deterministicStatePriority,
        candidate,
        ...(executionCandidate == null ? {} : { executionCandidate }),
      }),
    );
  }
  const budget = port.reserveBudget(
    items.flatMap((item) => (item.executionCandidate == null ? [] : [item.executionCandidate])),
  );
  if (
    budget.ledger.ledgerId !== analyzed.core.aiBudget.ledgerId ||
    budget.ledger.sequence < analyzed.core.aiBudget.sequence
  ) {
    throw new TypeError("汎用AIの予約ledgerが入力runと一致しません");
  }
  const deferredByCandidateId = new Map(
    budget.deferred.map((value) => [value.candidateId, value.reason]),
  );
  const budgetedItems = Object.freeze(
    items.map((item) => {
      const reason = deferredByCandidateId.get(item.nodeId);
      return reason == null
        ? item
        : Object.freeze({
            ...item,
            elements: Object.freeze(
              item.elements.map((element) =>
                element.choice === "execute"
                  ? Object.freeze({ ...element, choice: "budget_deferred" as const, reason })
                  : element,
              ),
            ),
          });
    }),
  );
  const plan = Object.freeze({
    identity,
    aiEnabled: analyzed.core.config.ai.enabled,
    minimumConfidence: analyzed.core.config.ai.confidence.medium,
    ...(target == null ? {} : { target }),
    items: budgetedItems,
    budget,
    failures: Object.freeze(failures),
    analysisImpactDecisions: Object.freeze(analysisImpactDecisions),
  }) satisfies GenericAiPlan;
  return Object.freeze({
    stage: "generic_ai_planned",
    core: Object.freeze({
      ...projectGenericAiRunCore(analyzed.core),
      aiBudget: budget.ledger,
    }),
    data: Object.freeze({
      approvedRepositories: analyzed.data.approvedRepositories,
      allowlistDigest: analyzed.data.allowlistDigest,
      collection: analyzed.data.collection,
      sourceCatalog: analyzed.data.sourceCatalog,
      facts: analyzed.data.facts,
      plan,
      snapshotPlan: projectFinalSnapshotPlan(analyzed, plan, port.digest),
    }),
    proof: createGenericAiPlannedStageProof(),
  });
}

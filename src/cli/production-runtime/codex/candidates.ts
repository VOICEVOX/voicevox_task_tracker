import { serializeCanonicalJson } from "../../../canonical-json/index.js";
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  determineAnalysisElementNecessities,
  estimateAiInputCost,
  planAnalysisElements,
  prepareAiAnalysisCandidate,
  type AiAnalysisCandidate,
  type AiAnalysisRunFailure,
  type AiAnalysisRunIdentity,
  type AnalysisElementPlanning,
  type CodexAnalysisInput,
  type PreparedAiAnalysisCandidate,
} from "../../../codex/index.js";
import {
  elementInputFingerprints,
  type AnalysisImpactDecisionForDiagnostics,
} from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  type AiAnalysisElement,
} from "../../../domain/ai-analysis-elements.js";
import type { GitHubNodeId, GraphNodeId } from "../../../domain/index.js";
import type { AnalyzeGraphResult } from "../../../graph/index.js";
import { relationNodes } from "../../../graph/relation-candidate-endpoints.js";
import { createCodexInput } from "../../codex-input-projection.js";
import {
  CODEX_PROMPT_FINGERPRINT,
  elementDependencyFingerprints,
  elementExecutionFingerprints,
} from "../analysis-identity.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import type {
  CollectedItems,
  DeterministicAnalysis,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { previousGraphIndex } from "../previous-state/graph.js";
import {
  savedAdoptionRecordsForItem,
  savedEvaluationRecordsForItem,
} from "../previous-state/ai-reuse.js";
import { savedGenerationsForItem } from "../previous-state/saved-ai-elements.js";
import { previousSnapshot, previousTrackedItem } from "../previous-state/snapshot.js";
import { createEarliestRelationSourceOccurredAtById } from "../relation-source-occurrence.js";
import { forcedAnalysisSelection, forcedCandidateElements } from "./element-planning.js";
import { necessityInputForAnalysis, preservedElementsForSelection } from "./input.js";
import { analysisImpactProofsForItem } from "./reuse.js";

/** AI解析候補と入力検証失敗を準備する。 */
export function createAiCandidates(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  identity: AiAnalysisRunIdentity,
): Readonly<{
  candidates: readonly PreparedAiAnalysisCandidate[];
  failures: readonly AiAnalysisRunFailure[];
  inputValidationFailures: readonly Readonly<{
    candidateId: string;
    error: unknown;
  }>[];
  analysisImpactDecisions: readonly Readonly<{
    candidateId: string;
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
  elementPlanningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>;
}> {
  const inputByNodeId = new Map<GitHubNodeId, CodexAnalysisInput>();
  const elementPlanningByNodeId = new Map<GitHubNodeId, AnalysisElementPlanning>();
  const failures: AiAnalysisRunFailure[] = [];
  const inputValidationFailures: {
    candidateId: string;
    error: unknown;
  }[] = [];
  const analysisImpactDecisions: {
    candidateId: string;
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }[] = [];
  const previousGraph = previousGraphIndex(state);
  const previousImpactByNodeId =
    previousGraph.availability === "available"
      ? previousGraph.downstreamImpactByNodeId
      : new Map<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]>();
  const previousRelations = previousSnapshot(state)?.relations ?? [];
  const previousAiAnalysisStatusByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item.aiAnalysis.status]),
  );
  const target = forcedAiAnalysisTarget(configuration);
  const candidates: PreparedAiAnalysisCandidate[] = [];
  for (const analysis of deterministicAnalysis.items) {
    const previousObservedAt = previousTrackedItem(state, analysis.item.nodeId)?.observedAt;
    let baseInput: CodexAnalysisInput;
    try {
      baseInput = createCodexInput(
        configuration,
        collection.evaluatedAt,
        analysis,
        [],
        {},
        previousObservedAt,
        createEarliestRelationSourceOccurredAtById,
      );
    } catch (error: unknown) {
      inputValidationFailures.push(
        Object.freeze({
          candidateId: analysis.item.nodeId,
          error,
        }),
      );
      failures.push(
        Object.freeze({
          candidateId: analysis.item.nodeId,
          reason: "input_validation_failed",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
      continue;
    }
    const savedGenerations = savedGenerationsForItem(state, analysis.item.nodeId);
    const dependencyFingerprints = elementDependencyFingerprints(state, analysis);
    const inputFingerprints = elementInputFingerprints(baseInput, dependencyFingerprints);
    const savedEvaluations = savedEvaluationRecordsForItem(
      state,
      analysis.item.nodeId,
      inputFingerprints,
      dependencyFingerprints,
    );
    const savedReuses = savedAdoptionRecordsForItem(
      state,
      analysis.item.nodeId,
      inputFingerprints,
      dependencyFingerprints,
    );
    const impactResolutions = analysisImpactProofsForItem(
      state,
      analysis,
      baseInput,
      inputFingerprints,
      dependencyFingerprints,
    );
    const planningEvaluations = Object.freeze({
      ...savedEvaluations,
      ...impactResolutions.evaluation,
    });
    const planningReuses = Object.freeze({
      ...savedReuses,
      ...impactResolutions.adopted,
    });
    for (const impact of impactResolutions.decisions) {
      analysisImpactDecisions.push(
        Object.freeze({
          candidateId: analysis.item.nodeId,
          element: impact.element,
          role: impact.role,
          decision: impact.decision,
        }),
      );
    }
    const necessities = determineAnalysisElementNecessities(
      necessityInputForAnalysis(state, analysis, baseInput.selfCommitmentCandidates.length !== 0),
    );
    const planning = planAnalysisElements({
      necessities,
      inputFingerprints,
      executionFingerprints: elementExecutionFingerprints(identity),
      inputProjectionVersions: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
      dependencyFingerprints,
      savedGenerations,
      savedEvaluations: planningEvaluations,
      savedReuses: planningReuses,
    });
    const targetForAnalysis = target?.nodeId === analysis.item.nodeId ? target : undefined;
    const executionPlanning =
      targetForAnalysis == null
        ? planning
        : Object.freeze({
            ...planning,
            selection: forcedAnalysisSelection(planning, targetForAnalysis),
          });
    elementPlanningByNodeId.set(analysis.item.nodeId, executionPlanning);
    const input = createCodexInput(
      configuration,
      collection.evaluatedAt,
      analysis,
      executionPlanning.selection.selected.map((candidate) => candidate.element),
      preservedElementsForSelection(
        state,
        analysis,
        executionPlanning,
        targetForAnalysis,
        baseInput,
      ),
      previousObservedAt,
      createEarliestRelationSourceOccurredAtById,
    );
    inputByNodeId.set(analysis.item.nodeId, input);
    const previousIncomingBlockers = new Set<string>(
      previousRelations
        .filter(
          (relation) =>
            relation.active &&
            relation.type === "blocks" &&
            relation.toNodeId === analysis.item.nodeId,
        )
        .map((relation) => relation.id),
    );
    const currentPotentialBlockers = new Set<string>(
      analysis.relationCandidates
        .filter((candidate) => {
          if (candidate.relation.type === "blocks") {
            return candidate.relation.blocked.nodeId === analysis.item.nodeId;
          }
          return candidate.authority === "inferred";
        })
        .map((candidate) => candidate.id),
    );
    const relatedNodeChanged = analysis.relationCandidates.some((candidate) =>
      relationNodes(candidate.relation).some(
        (node) =>
          node.nodeId !== analysis.item.nodeId &&
          node.scope === "organization" &&
          collection.changedNodeIds.has(node.nodeId),
      ),
    );
    const changedBlocker =
      relatedNodeChanged ||
      previousIncomingBlockers.size !== currentPotentialBlockers.size ||
      [...previousIncomingBlockers].some((id) => !currentPotentialBlockers.has(id));
    const previousImpact = previousImpactByNodeId.get(analysis.item.nodeId);
    const previousAiAnalysisStatus = previousAiAnalysisStatusByNodeId.get(analysis.item.nodeId);
    const estimatedCost = estimateAiInputCost(
      `${serializeCanonicalJson(input)}\n`,
      configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
    );
    const candidate = Object.freeze({
      id: analysis.item.nodeId,
      input,
      elements:
        targetForAnalysis == null
          ? Object.freeze(AI_ANALYSIS_ELEMENTS.map((element) => planning.candidates[element]))
          : forcedCandidateElements(planning, targetForAnalysis),
      promptFingerprint: CODEX_PROMPT_FINGERPRINT,
      priority: Object.freeze({
        previouslyDeferred: previousAiAnalysisStatus === "deferred",
        severityCandidate: analysis.decision.determination === "codex_candidate",
        ownerUnknown: analysis.decision.waitingOn.some((waitingOn) => waitingOn.kind === "unknown"),
        changedBlocker,
        downstreamImpact: Object.freeze({
          openNodeCount: previousImpact?.openNodeCount ?? 0,
          repositoryCount: previousImpact?.repositoryCount ?? 0,
        }),
      }),
      estimatedCostUsd: estimatedCost.estimatedCostUsd,
    } satisfies AiAnalysisCandidate);
    candidates.push(prepareAiAnalysisCandidate(candidate));
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    failures: Object.freeze(failures),
    inputValidationFailures: Object.freeze(inputValidationFailures),
    analysisImpactDecisions: Object.freeze(analysisImpactDecisions),
    inputByNodeId,
    elementPlanningByNodeId,
  });
}

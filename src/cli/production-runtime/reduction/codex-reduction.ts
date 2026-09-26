import {
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  createCodexAnalysisInput,
  reduceCodexAnalysis,
  reduceCodexInputValidationFailure,
  validateCodexAnalysisOutput,
  type CodexAnalysisReduction,
  type DeterministicCodexDecision,
  type ReducedCodexDecision,
} from "../../../codex/index.js";
import type { IssueStateDecision, PullRequestStateDecision } from "../../../domain/index.js";
import { deduplicateByStableId } from "../../../github/index.js";
import { selectRelationAssessmentCandidates } from "../../../graph/relation-candidate-endpoints.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { aiAnalysisRunIndex } from "../ai-analysis-run-index.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import type { CodexAnalysis, RuntimeConfiguration, RuntimeState } from "../contracts.js";
import { codexOutputForAnalysis } from "./consumer-output.js";
import { preservedElementsForAnalysisReduction } from "./retained-results.js";

function deterministicCodexDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): DeterministicCodexDecision {
  return Object.freeze({
    determination: decision.determination,
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

export function reducedDeterministicDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): ReducedCodexDecision {
  return Object.freeze({
    origin: "deterministic",
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

export function reductionForAnalysis(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): CodexAnalysisReduction | undefined {
  const run = codexAnalysis.run;
  if (run == null) {
    return undefined;
  }
  const runIndex = aiAnalysisRunIndex(run);
  const target = forcedAiAnalysisTarget(configuration);
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  const result = runIndex.resultByNodeId.get(analysis.item.nodeId);
  if (result != null) {
    assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
    const output = codexOutputForAnalysis(analysis, codexAnalysis);
    assertNonNullable(output, `Codex出力がありません。対象: ${analysis.item.nodeId}`);
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "validated",
        output,
      },
      configuration.config.ai.confidence,
      preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
    );
  }
  const failure = runIndex.failureByNodeId.get(analysis.item.nodeId);
  if (failure != null) {
    if (input == null) {
      if (failure.reason !== "input_validation_failed") {
        throw new TypeError(
          `Codex入力がない項目の失敗理由が入力検証ではありません。対象: ${analysis.item.nodeId}`,
        );
      }
      const relationCandidateIds = deduplicateByStableId(
        selectRelationAssessmentCandidates(analysis.item.nodeId, analysis.relationCandidates),
        (candidate) => candidate.id,
      ).map((candidate) => candidate.id);
      return reduceCodexInputValidationFailure(
        deterministicCodexDecision(analysis.decision),
        relationCandidateIds,
        failure.errorType,
      );
    }
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "unavailable",
        reason: failure.reason,
        errorType: failure.errorType,
      },
      configuration.config.ai.confidence,
      preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
    );
  }
  const deferred = runIndex.deferredByNodeId.get(analysis.item.nodeId);
  if (deferred != null) {
    assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "unavailable",
        reason: "execution_failed",
        errorType: `CodexBudgetDeferred:${deferred.reason}`,
      },
      configuration.config.ai.confidence,
      preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
    );
  }
  const skipped = runIndex.skippedByNodeId.get(analysis.item.nodeId);
  const forcedUnexecutedItem = target != null && target.nodeId !== analysis.item.nodeId;
  if (skipped?.reason !== "up_to_date" && !forcedUnexecutedItem) {
    return undefined;
  }
  assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
  if (!forcedUnexecutedItem && input.selectedElements.length !== 0) {
    throw new TypeError(
      `up_to_date項目のCodex入力に選択要素があります。対象: ${analysis.item.nodeId}`,
    );
  }
  const preservedElements = preservedElementsForAnalysisReduction(
    state,
    analysis,
    codexAnalysis,
    target,
  );
  if (Object.keys(preservedElements).length === 0) {
    return undefined;
  }
  const reductionInput = forcedUnexecutedItem
    ? createCodexAnalysisInput({
        ...input,
        selectedElements: [],
        lockedElements: {},
      })
    : input;
  const output = validateCodexAnalysisOutput(
    {
      schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
      item: {
        nodeId: reductionInput.item.nodeId,
        url: reductionInput.item.url,
      },
    },
    reductionInput,
  );
  return reduceCodexAnalysis(
    reductionInput,
    deterministicCodexDecision(analysis.decision),
    {
      status: "validated",
      output,
    },
    configuration.config.ai.confidence,
    preservedElements,
  );
}

import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
  createEmptyAiBudgetUsage,
  estimateAiInputCost,
  recordCodexDiagnostic,
  runAiAnalyses,
  type AiAnalysisRunFailure,
  type AiAnalysisRunResult,
  type CodexDiagnosticsContext,
  type CodexInitialAttemptTicket,
} from "../../../codex/index.js";
import {
  codexSemanticGenerationDiagnostic,
  createCodexAdapterConfiguration,
  createCodexAdapterDependencies,
  createCodexPreflightDiagnostics,
  createCodexSemanticGenerationCounter,
} from "../../codex-runtime-support.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import { safeCodexFallbackDiagnostic } from "../../error-diagnostic.js";
import type { CodexRuntimeAdapters } from "../adapters.js";
import { createAiAnalysisRunIdentity } from "../analysis-identity.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import type {
  CodexAnalysis,
  CollectedItems,
  DeterministicAnalysis,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { createAiCandidates } from "./candidates.js";
import { elementGenerationsByNodeId } from "./generations.js";

function codexFallbackDiagnostic(failure: AiAnalysisRunFailure): string {
  return safeCodexFallbackDiagnostic(
    failure.candidateId,
    failure.reason,
    failure.errorType,
    failure.diagnostic,
    failure.validationDiagnostic,
  );
}

function countRetainedAiResults(state: RuntimeState, collection: CollectedItems): number {
  return (previousSnapshot(state)?.items ?? []).filter(
    (item) =>
      item.aiAnalysis.status === "used" &&
      collection.trackedNodeIds.has(item.nodeId) &&
      !collection.analysisNodeIds.has(item.nodeId),
  ).length;
}

/** Codex解析を既存adapterで実行する。 */
export async function analyzeCodex(
  adapters: CodexRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
): Promise<
  Readonly<{
    stage: CodexAnalysis;
    status: "success" | "fallback";
    aiCallCount: number;
    aiCacheHitCount: number;
    aiRetainedResultCount: number;
    estimatedInputTokens: number;
    diagnostics: readonly string[];
  }>
> {
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const prepared = createAiCandidates(
    configuration,
    state,
    collection,
    deterministicAnalysis,
    identity,
  );
  const target = forcedAiAnalysisTarget(configuration);
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: `${invocation.runId}:codex`,
        });
  for (const impact of prepared.analysisImpactDecisions) {
    await recordCodexDiagnostic(
      diagnostics == null
        ? undefined
        : Object.freeze({
            ...diagnostics,
            candidateId: impact.candidateId,
          }),
      "codex.analysis.impact",
      {
        phase: "analysis_impact",
        element: impact.element,
        role: impact.role,
        sourceVersion: Object.freeze({
          revision: impact.decision.sourceVersion.revision,
          inputProjectionVersion: impact.decision.sourceVersion.inputProjectionVersion,
        }),
        targetVersion: Object.freeze({
          revision: impact.decision.targetVersion.revision,
          inputProjectionVersion: impact.decision.targetVersion.inputProjectionVersion,
        }),
        impact: impact.decision.impact,
        compatibilityPath: Object.freeze([...impact.decision.compatibilityPath]),
        ...(impact.decision.reason == null ? {} : { reason: impact.decision.reason }),
      },
    );
  }
  for (const failure of prepared.inputValidationFailures) {
    await recordCodexDiagnostic(
      diagnostics == null
        ? undefined
        : Object.freeze({
            ...diagnostics,
            candidateId: failure.candidateId,
          }),
      "codex.input.validation_failed",
      {
        phase: "input_validation",
        errorType: failure.error instanceof Error ? failure.error.name : typeof failure.error,
      },
      failure.error,
    );
  }
  if (!configuration.config.ai.enabled) {
    if (target != null) {
      throw new TypeError("forced sandbox実行にはAIを有効にしてください");
    }
    const fallback = prepared.failures.length > 0;
    await recordCodexDiagnostic(diagnostics, "codex.analysis.summary", {
      phase: "summary",
      candidateItemCount: prepared.candidates.length,
      aiCallCount: 0,
      deferredItemCount: 0,
      inputValidationFailureCount: prepared.inputValidationFailures.length,
    });
    return Object.freeze({
      stage: Object.freeze({
        run: undefined,
        inputByNodeId: prepared.inputByNodeId,
        elementPlanningByNodeId: prepared.elementPlanningByNodeId,
        elementGenerationsByNodeId: elementGenerationsByNodeId(
          state,
          deterministicAnalysis.items,
          prepared.elementPlanningByNodeId,
          undefined,
          target,
        ),
      }),
      status: fallback ? "fallback" : "success",
      aiCallCount: 0,
      aiCacheHitCount: 0,
      aiRetainedResultCount: countRetainedAiResults(state, collection),
      estimatedInputTokens: 0,
      diagnostics: Object.freeze(prepared.failures.map(codexFallbackDiagnostic)),
    });
  }
  const codexCredentials = configuration.credentials.codex;
  if (!codexCredentials.enabled) {
    throw new TypeError("AIが有効ですがCodex認証情報がありません");
  }
  const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
  const semanticGenerationCounter = createCodexSemanticGenerationCounter();
  const codexDependencies = createCodexAdapterDependencies(
    adapters,
    codexCredentials,
    configuration.codexAttemptBudget,
    diagnostics,
    semanticGenerationCounter.observer,
  );
  const preflightInputCost =
    codexCredentials.authentication === "auth-json"
      ? estimateAiInputCost(
          CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
          configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        )
      : undefined;
  const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
  const preflight =
    preflightInputCost == null
      ? undefined
      : Object.freeze({
          inputCharacters: CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
          estimatedCostUsd: preflightInputCost.estimatedCostUsd,
          execute: (ticket: CodexInitialAttemptTicket) =>
            adapters.executeCodexAuthenticationPreflight(
              codexConfiguration,
              Object.freeze({
                ...codexDependencies,
                initialAttemptTicket: ticket,
                ...(preflightDiagnostics == null
                  ? {}
                  : {
                      diagnostics: preflightDiagnostics,
                    }),
              }),
            ),
        });
  const executedRun = await runAiAnalyses(
    prepared.candidates,
    {
      identity,
      budget: configuration.config.ai.budget,
      initialUsage: createEmptyAiBudgetUsage(),
      maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
      ...(target == null ? {} : { target }),
    },
    {
      cache: state.session.aiCache,
      attemptBudget: configuration.codexAttemptBudget,
      ensureReady: configuration.ensureCodexReady,
      ...(preflight == null ? {} : { preflight }),
      ...(diagnostics == null ? {} : { diagnostics }),
      execute: (input, context) =>
        adapters.executeCodexAnalysis(
          input,
          codexConfiguration,
          Object.freeze({
            ...codexDependencies,
            initialAttemptTicket: context.initialAttemptTicket,
            ...(diagnostics == null
              ? {}
              : {
                  diagnostics: Object.freeze({
                    ...diagnostics,
                    invocationId: `${invocation.runId}:${context.candidateId}`,
                    candidateId: context.candidateId,
                  }),
                }),
          }),
        ),
      executedAt: () => collection.evaluatedAt,
    },
  );
  const run = Object.freeze({
    ...executedRun,
    failures: Object.freeze([...prepared.failures, ...executedRun.failures]),
    skipped:
      target == null
        ? executedRun.skipped
        : Object.freeze([
            ...executedRun.skipped,
            ...prepared.candidates
              .filter((candidate) => candidate.id !== target.nodeId)
              .map((candidate) =>
                Object.freeze({
                  candidateId: candidate.id,
                  reason: "not_required" as const,
                }),
              ),
          ]),
  }) satisfies AiAnalysisRunResult;
  await recordCodexDiagnostic(diagnostics, "codex.analysis.summary", {
    phase: "summary",
    candidateItemCount: prepared.candidates.length,
    aiCallCount: run.usage.calls,
    deferredItemCount: run.deferred.length,
    inputValidationFailureCount: prepared.inputValidationFailures.length,
  });
  const semanticGenerationCounts = semanticGenerationCounter.read();
  const semanticGenerationPublicDiagnostic =
    codexSemanticGenerationDiagnostic(semanticGenerationCounts);
  const fallback = run.failures.length > 0 || run.deferred.length > 0;
  return Object.freeze({
    stage: Object.freeze({
      run,
      inputByNodeId: prepared.inputByNodeId,
      elementPlanningByNodeId: prepared.elementPlanningByNodeId,
      elementGenerationsByNodeId: elementGenerationsByNodeId(
        state,
        deterministicAnalysis.items,
        prepared.elementPlanningByNodeId,
        run,
        target,
      ),
    }),
    status: fallback ? "fallback" : "success",
    aiCallCount: run.usage.calls,
    aiCacheHitCount: run.results.filter((result) => result.origin === "cache").length,
    aiRetainedResultCount: countRetainedAiResults(state, collection),
    estimatedInputTokens: Math.ceil(run.usage.inputCharacters / 4),
    diagnostics: Object.freeze([
      ...run.failures.map(codexFallbackDiagnostic),
      ...run.deferred.map(
        (deferred) => `codex_deferred item=${deferred.candidateId} reason=${deferred.reason}`,
      ),
      semanticGenerationPublicDiagnostic,
    ]),
  });
}

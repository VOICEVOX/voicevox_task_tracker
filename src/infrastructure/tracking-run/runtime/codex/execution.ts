import { summarizeAiBudgetLedger } from "../../../../application/tracking-run/contracts/ai-budget-ledger.js";
import {
  completeGenericAiExecution,
  type GenericAiExecutedRun,
} from "../../../../application/tracking-run/stages/generic-ai-execution.js";
import type { GenericAiPlannedRun } from "../../../../application/tracking-run/stages/generic-ai-plan-contracts.js";
import {
  recordCodexDiagnostic,
  runPlannedAiAnalyses,
  type AiAnalysisRunFailure,
  type AiAnalysisRunResult,
  type CodexDiagnosticsContext,
  type CodexInitialAttemptTicket,
} from "../../../../codex/index.js";
import {
  codexSemanticGenerationDiagnostic,
  createCodexAdapterConfiguration,
  createCodexAdapterDependencies,
  createCodexPreflightDiagnostics,
  createCodexSemanticGenerationCounter,
} from "../../codex-runtime-support.js";
import { safeCodexFallbackDiagnostic } from "../../error-diagnostic.js";
import type { RunInvocation } from "../../run-invocation.js";
import type { CodexRuntimeAdapters } from "../adapters.js";
import type { RuntimeConfiguration, RuntimeState } from "../contracts.js";
import { previousSnapshot } from "../previous-state/snapshot.js";

function codexFallbackDiagnostic(failure: AiAnalysisRunFailure): string {
  return safeCodexFallbackDiagnostic(
    failure.candidateId,
    failure.reason,
    failure.errorType,
    failure.diagnostic,
    failure.validationDiagnostic,
  );
}

function countRetainedAiResults(state: RuntimeState, planned: GenericAiPlannedRun): number {
  const trackedNodeIds = new Set(planned.data.facts.trackedNodeIds);
  const analysisNodeIds = new Set(planned.data.facts.analysisNodeIds);
  return (previousSnapshot(state)?.items ?? []).filter(
    (item) =>
      item.aiAnalysis.status === "used" &&
      trackedNodeIds.has(item.nodeId) &&
      !analysisNodeIds.has(item.nodeId),
  ).length;
}

/** Codex解析を既存adapterで実行する。 */
export async function analyzeCodex(
  adapters: CodexRuntimeAdapters,
  invocation: RunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  planned: GenericAiPlannedRun,
): Promise<
  Readonly<{
    executed: GenericAiExecutedRun;
    status: "success" | "fallback";
    aiCallCount: number;
    aiCacheHitCount: number;
    aiRetainedResultCount: number;
    estimatedInputTokens: number;
    diagnostics: readonly string[];
  }>
> {
  const identity = planned.data.plan.identity;
  const candidates = planned.data.plan.items.map((item) => item.candidate);
  const target = planned.data.plan.target;
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          stage: "codex_analysis",
        });
  for (const impact of planned.data.plan.analysisImpactDecisions) {
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
  if (!configuration.config.ai.enabled) {
    if (target != null) {
      throw new TypeError("forced sandbox実行にはAIを有効にしてください");
    }
    const fallback = planned.data.plan.failures.length > 0;
    await recordCodexDiagnostic(diagnostics, "codex.analysis.summary", {
      phase: "summary",
      candidateItemCount: candidates.length,
      aiCallCount: 0,
      deferredItemCount: 0,
      inputValidationFailureCount: planned.data.plan.failures.length,
    });
    return Object.freeze({
      executed: completeGenericAiExecution(
        planned,
        undefined,
        configuration.codexAttemptBudget.snapshot,
      ),
      status: fallback ? "fallback" : "success",
      aiCallCount: 0,
      aiCacheHitCount: 0,
      aiRetainedResultCount: countRetainedAiResults(state, planned),
      estimatedInputTokens: 0,
      diagnostics: Object.freeze(planned.data.plan.failures.map(codexFallbackDiagnostic)),
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
  const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
  const preflightCharge = planned.data.plan.budget.preflightCharge;
  if (preflightCharge != null && codexCredentials.authentication !== "auth-json") {
    throw new TypeError("汎用AIの認証preflight計画と認証方式が一致しません");
  }
  const preflight =
    preflightCharge == null
      ? undefined
      : Object.freeze({
          inputCharacters: preflightCharge.inputCharacters,
          estimatedCostUsd: preflightCharge.estimatedCostUsd,
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
  const executedRun = await runPlannedAiAnalyses(
    planned.data.plan,
    {
      identity,
      maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
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
      executedAt: () => planned.data.collection.evaluatedAt,
    },
  );
  const executed = completeGenericAiExecution(
    planned,
    executedRun,
    configuration.codexAttemptBudget.snapshot,
  );
  const run = Object.freeze({
    ...executedRun,
    failures: Object.freeze([
      ...planned.data.plan.failures.map((failure) =>
        Object.freeze({
          candidateId: failure.candidateId,
          reason: failure.reason,
          errorType: failure.errorType,
        }),
      ),
      ...executedRun.failures,
    ]),
    skipped:
      target == null
        ? executedRun.skipped
        : Object.freeze([
            ...executedRun.skipped,
            ...candidates
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
    candidateItemCount: candidates.length,
    aiCallCount: run.usage.calls,
    deferredItemCount: run.deferred.length,
    inputValidationFailureCount: planned.data.plan.failures.length,
  });
  const semanticGenerationCounts = semanticGenerationCounter.read();
  const genericAttempts = executed.core.aiBudget.events.filter(
    (event) => event.action === "consumed" && event.reservation.kind.startsWith("generic_"),
  ).length;
  if (genericAttempts !== semanticGenerationCounts.processAttemptCount) {
    throw new TypeError("汎用AIのprocess診断数とledger実試行数が一致しません");
  }
  const semanticGenerationPublicDiagnostic =
    codexSemanticGenerationDiagnostic(semanticGenerationCounts);
  const fallback = run.failures.length > 0 || run.deferred.length > 0;
  const ledgerSummary = summarizeAiBudgetLedger(executed.core.aiBudget);
  return Object.freeze({
    executed,
    status: fallback ? "fallback" : "success",
    aiCallCount:
      ledgerSummary.logicalCandidateCount + ledgerSummary.authenticationPreflightAttemptCount,
    aiCacheHitCount: run.results.filter((result) =>
      result.elements.some((element) => element.origin === "cache"),
    ).length,
    aiRetainedResultCount: countRetainedAiResults(state, planned),
    estimatedInputTokens: ledgerSummary.estimatedInputTokens,
    diagnostics: Object.freeze([
      ...run.failures.map(codexFallbackDiagnostic),
      ...run.deferred.map(
        (deferred) => `codex_deferred item=${deferred.candidateId} reason=${deferred.reason}`,
      ),
      semanticGenerationPublicDiagnostic,
    ]),
  });
}

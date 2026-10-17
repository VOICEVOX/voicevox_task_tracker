import { summarizeAiBudgetLedger } from "../../../../application/tracking-run/contracts/ai-budget-ledger.js";
import type { GraphReconciledRun } from "../../../../application/tracking-run/stages/graph-reconciliation.js";
import type { PersonalReminderExecutedRun } from "../../../../application/tracking-run/stages/personal-reminder-execution.js";
import {
  executePersonalReminders,
  type PersonalReminderExecutionPort,
} from "../../../../application/tracking-run/stages/personal-reminder-execution.js";
import type { PersonalReminderFinalizedRun } from "../../../../application/tracking-run/stages/personal-reminder-finalization.js";
import { finalizePersonalReminders } from "../../../../application/tracking-run/stages/personal-reminder-finalization.js";
import type { PersonalReminderPlannedRun } from "../../../../application/tracking-run/stages/personal-reminder-plan.js";
import { planPersonalReminders } from "../../../../application/tracking-run/stages/personal-reminder-plan.js";
import { CODEX_BACKEND_VERSION } from "../../../../codex/backend-version.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "../../../../codex/index.js";
import { executePlannedPersonalReminderBatch } from "../../../../codex/personal-reminder-runner.js";
import { assertNonNullable } from "../../../../util/index.js";
import {
  createCodexAdapterConfiguration,
  createCodexAdapterDependencies,
  createCodexPreflightDiagnostics,
} from "../../codex-runtime-support.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import {
  personalReminderCauseAttemptCounts,
  personalReminderUsageDelta,
} from "../../personal-reminder/metrics.js";
import type { RunInvocation } from "../../run-invocation.js";
import type { PersonalReminderRuntimeAdapters } from "../adapters.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import type {
  AnalysisProgress,
  AnalysisRuntimeContext,
  AnalysisStages,
} from "../analysis-contracts.js";
import type {
  PersonalReminderExecutedStage,
  PersonalReminderPlannedStage,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";

async function planPersonalReminderStage(
  adapters: PersonalReminderRuntimeAdapters,
  invocation: RunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  graphReconciled: GraphReconciledRun,
): Promise<PersonalReminderPlannedStage> {
  const collection = graphReconciled.data.collection;
  const forcedTarget = forcedAiAnalysisTarget(configuration);
  const planned = planPersonalReminders(
    graphReconciled,
    forcedTarget != null,
    nodeContentDigestPort,
  );
  const plan = planned.data.plan.causePlan;
  const continuityConflictNodeIds = new Set(
    plan.continuityConflicts.map((conflict) => conflict.itemNodeId),
  );
  const personalReminderFallbackNodeIds = new Set([
    ...graphReconciled.data.facts.unavailableConsumerNodeIds,
    ...continuityConflictNodeIds,
    ...plan.incompleteInputNodeIds,
    ...plan.deferredStructuralEndNodeIds,
  ]);
  const initialSummary = summarizeAiBudgetLedger(configuration.codexAttemptBudget.snapshot);
  const initialUsage = Object.freeze({
    calls:
      initialSummary.logicalCandidateCount + initialSummary.authenticationPreflightAttemptCount,
    inputCharacters: initialSummary.inputCharacters,
    estimatedCostUsd: initialSummary.estimatedCostUsd,
  });
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          stage: "personal_reminder_analysis",
        });
  for (const conflict of plan.continuityConflicts) {
    await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.continuity_conflict", {
      phase: "fallback",
      itemNodeId: conflict.itemNodeId,
      previousCauseIds: conflict.previousCauseIds,
    });
  }
  if (planned.data.plan.batches.length !== 0 && !configuration.credentials.codex.enabled) {
    throw new TypeError("AIが有効ですがCodex認証情報がありません");
  }
  const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
  const codexDependencies = configuration.credentials.codex.enabled
    ? createCodexAdapterDependencies(
        adapters,
        configuration.credentials.codex,
        configuration.codexAttemptBudget,
        diagnostics,
        undefined,
      )
    : undefined;
  const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
  configuration.codexAttemptBudget.adoptPlannedSnapshot(planned.core.aiBudget);
  const port: PersonalReminderExecutionPort = Object.freeze({
    snapshot: () => configuration.codexAttemptBudget.snapshot,
    ensureReady: configuration.ensureCodexReady,
    executePreflight: (reservation) => {
      assertNonNullable(codexDependencies, "個人催促AIの認証実行依存がありません");
      return adapters.executeCodexAuthenticationPreflight(
        codexConfiguration,
        Object.freeze({
          ...codexDependencies,
          initialAttemptTicket: Object.freeze({ id: reservation.id }),
          ...(preflightDiagnostics == null ? {} : { diagnostics: preflightDiagnostics }),
        }),
      );
    },
    executeBatch: (batch) => {
      assertNonNullable(codexDependencies, "個人催促AIのbatch実行依存がありません");
      return executePlannedPersonalReminderBatch(
        batch,
        planned.data.plan.causes,
        Object.freeze({
          model: configuration.config.ai.model,
          reasoningEffort: configuration.config.ai.execution.reasoningEffort,
          backendVersion: CODEX_BACKEND_VERSION,
          minimumConfidence: configuration.config.ai.confidence.high,
          generatedAt: collection.evaluatedAt,
        }),
        Object.freeze({
          cache: state.session.personalReminderAiCache,
          ...(diagnostics == null ? {} : { diagnostics }),
          execute: () =>
            adapters.executeCodexPersonalReminderAnalysis(
              batch,
              codexConfiguration,
              Object.freeze({
                ...codexDependencies,
                initialAttemptTicket: Object.freeze({ id: batch.reservation.id }),
              }),
            ),
        }),
      );
    },
    release: (reservation) => {
      configuration.codexAttemptBudget.releaseInitialAttempt(Object.freeze({ id: reservation.id }));
    },
  });
  return Object.freeze({
    planned,
    port,
    initialSummary,
    initialUsage,
    fallbackNodeIds: personalReminderFallbackNodeIds,
    diagnostics,
    configuration,
  });
}

async function executePersonalReminderStage(
  stage: PersonalReminderPlannedStage,
): Promise<PersonalReminderExecutedStage> {
  const executed = await executePersonalReminders(stage.planned, stage.port, nodeContentDigestPort);
  return Object.freeze({
    executed,
    initialSummary: stage.initialSummary,
    initialUsage: stage.initialUsage,
    fallbackNodeIds: stage.fallbackNodeIds,
    diagnostics: stage.diagnostics,
    configuration: stage.configuration,
    candidateCauseCount: stage.planned.data.plan.causes.filter(
      (cause) => cause.choice === "execute",
    ).length,
    assessmentReuseCount: stage.planned.data.plan.causes.filter(
      (cause) => cause.choice === "snapshot_reuse",
    ).length,
  });
}

async function finalizePersonalReminderStage(
  stage: PersonalReminderExecutedStage,
  progress: AnalysisProgress,
): Promise<PersonalReminderFinalizedRun> {
  const {
    executed,
    initialSummary,
    initialUsage,
    fallbackNodeIds,
    diagnostics,
    configuration,
    candidateCauseCount,
    assessmentReuseCount,
  } = stage;
  const finalized = finalizePersonalReminders(executed, nodeContentDigestPort);
  const outcomesByCauseId = new Map(
    executed.data.outcomes.map((outcome) => [outcome.cause.causeId, outcome]),
  );
  for (const item of finalized.data.items) {
    for (const { cause } of item.causeResults) {
      const outcome = outcomesByCauseId.get(cause.causeId);
      if (
        (outcome?.status === "completed" || outcome?.status === "cache_hit") &&
        cause.latestAttempt.status === "failed" &&
        cause.latestAttempt.reason === "semantic_validation_failed"
      ) {
        await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.semantic_failed", {
          phase: "adoption",
          itemNodeId: item.item.nodeId,
          causeId: cause.causeId,
          origin: outcome.status,
          reason: "semantic_validation_failed",
        });
      }
    }
  }
  const counts = personalReminderCauseAttemptCounts(finalized);
  const finalSummary = summarizeAiBudgetLedger(configuration.codexAttemptBudget.snapshot);
  const usage = Object.freeze({
    calls: finalSummary.logicalCandidateCount + finalSummary.authenticationPreflightAttemptCount,
    inputCharacters: finalSummary.inputCharacters,
    estimatedCostUsd: finalSummary.estimatedCostUsd,
  });
  const usageDelta = personalReminderUsageDelta(usage, initialUsage);
  const status =
    fallbackNodeIds.size > 0 ||
    counts.failed > 0 ||
    counts.deferred > 0 ||
    finalized.data.items.some((item) => item.planning.status === "pending")
      ? "fallback"
      : "success";
  await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.summary", {
    phase: "summary",
    candidateCauseCount,
    aiCallCount: usageDelta.calls,
    cacheHitCauseCount: executed.data.outcomes.filter((outcome) => outcome.status === "cache_hit")
      .length,
  });
  progress.record(
    {
      aiCallCount: usage.calls,
      estimatedInputTokens: finalSummary.estimatedInputTokens,
      personalReminderCauseCount: finalized.data.items.reduce(
        (count, item) => count + item.causeResults.length,
        0,
      ),
      personalReminderAiCallCount:
        finalSummary.logicalCandidateCount - initialSummary.logicalCandidateCount,
      personalReminderAiCacheHitCount: executed.data.outcomes.filter(
        (outcome) => outcome.status === "cache_hit",
      ).length,
      personalReminderAssessmentReuseCount: assessmentReuseCount,
      personalReminderUnknownCount: counts.unknown,
      personalReminderFailedCount: counts.failed,
      personalReminderDeferredCount: counts.deferred,
      personalReminderNotEvaluatedCount: counts.notEvaluated,
    },
    Object.freeze([]),
    status,
  );
  return finalized;
}

/** 個人催促の実行portをrun内に保持し、canonical stageへ接続する。 */
export function createPersonalReminderStages(
  adapters: PersonalReminderRuntimeAdapters,
  context: AnalysisRuntimeContext,
  progress: AnalysisProgress,
): Pick<
  AnalysisStages,
  "personalReminderPlanned" | "personalReminderExecuted" | "personalReminderFinalized"
> {
  const plannedContexts = new WeakMap<PersonalReminderPlannedRun, PersonalReminderPlannedStage>();
  const executedContexts = new WeakMap<
    PersonalReminderExecutedRun,
    PersonalReminderExecutedStage
  >();
  return Object.freeze({
    personalReminderPlanned: async (graph) => {
      const currentLedger = context.configuration.codexAttemptBudget.snapshot;
      if (
        currentLedger.ledgerId !== graph.core.aiBudget.ledgerId ||
        currentLedger.sequence !== graph.core.aiBudget.sequence
      ) {
        throw new TypeError("個人催促AIへ渡す共有予算がgraph確定結果と一致しません");
      }
      const stage = await planPersonalReminderStage(
        adapters,
        context.invocation,
        context.configuration,
        context.state,
        graph,
      );
      plannedContexts.set(stage.planned, stage);
      return stage.planned;
    },
    personalReminderExecuted: async (planned) => {
      const runtime = plannedContexts.get(planned);
      assertNonNullable(runtime, "個人催促の計画実行contextがありません");
      const stage = await executePersonalReminderStage(runtime);
      plannedContexts.delete(planned);
      executedContexts.set(stage.executed, stage);
      return stage.executed;
    },
    personalReminderFinalized: async (executed) => {
      const runtime = executedContexts.get(executed);
      assertNonNullable(runtime, "個人催促の最終化contextがありません");
      const finalized = await finalizePersonalReminderStage(runtime, progress);
      executedContexts.delete(executed);
      return finalized;
    },
  });
}

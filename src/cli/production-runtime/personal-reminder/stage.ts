import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
  createEmptyAiBudgetUsage,
  estimateAiInputCost,
  recordCodexDiagnostic,
  runPersonalReminderAiAnalyses,
  type CodexDiagnosticsContext,
  type CodexInitialAttemptTicket,
  type PersonalReminderAiRunConfiguration,
  type PersonalReminderAiRunResult,
} from "../../../codex/index.js";
import {
  createLabelEffectsResolver,
  type Evidence,
  type GitHubNodeId,
} from "../../../domain/index.js";
import { createPersonalReminderEvidenceSourceIndex } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  createCodexAdapterConfiguration,
  createCodexAdapterDependencies,
  createCodexPreflightDiagnostics,
} from "../../codex-runtime-support.js";
import type {
  DailyRunInvocation,
  DailyTransactionDependencies,
  PersonalReminderAnalysisStageResult,
} from "../../daily-transaction.js";
import { personalReminderRuntimeGraph } from "../../personal-reminder-graph-projection.js";
import {
  applyPersonalReminderCauseOutcomes,
  finalizePersonalReminderAnalysis,
  personalReminderAiCandidate,
  personalReminderAssessmentReuseCount,
  personalReminderCauseAttemptCounts,
  personalReminderUsageDelta,
  type PersonalReminderFinalizationItem,
} from "../../personal-reminder/index.js";
import {
  createPersonalReminderRuntimeContext,
  planPersonalReminderCauses,
} from "../../personal-reminder-runtime.js";
import type { PersonalReminderRuntimeAdapters } from "../adapters.js";
import { forcedAiAnalysisTarget } from "../ai-analysis-target.js";
import { aiDependencyReconciliationContext } from "../ai-dependencies/reconciliation-context.js";
import { CODEX_BACKEND_VERSION } from "../analysis-identity.js";
import type {
  CodexAnalysis,
  CollectedItems,
  DeterministicAnalysis,
  GraphResult,
  PersonalReminderAnalysis,
  ProductionTypes,
  ReducedAnalysis,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import { selectPersonalReminderRelationCandidateConsumers } from "../personal-reminder-relation-selection.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { personalReminderPreviousState, personalReminderRuntimeCollection } from "./context.js";

async function analyzePersonalReminders(
  adapters: PersonalReminderRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): Promise<PersonalReminderAnalysisStageResult<PersonalReminderAnalysis>> {
  const personalReminderRelationCandidateSelection =
    selectPersonalReminderRelationCandidateConsumers(state, collection, collection.trackedNodeIds);
  const unavailableConsumerNodeIds =
    personalReminderRelationCandidateSelection.unavailableConsumerNodeIds;
  const runtimeCollection = personalReminderRuntimeCollection(
    collection,
    deterministicAnalysis,
    reduction,
    graph,
    unavailableConsumerNodeIds,
  );
  const runtimeGraph = personalReminderRuntimeGraph(
    () => previousSnapshot(state),
    collection,
    reduction,
    graph,
  );
  const currentEvidenceGroups: readonly (readonly Evidence[])[] = [
    ...reduction.items.map((item) => item.evidence),
    ...graph.edges.map((edge) => edge.evidence),
  ];
  const currentEvidenceBySourceId =
    createPersonalReminderEvidenceSourceIndex(currentEvidenceGroups);
  const previousState = personalReminderPreviousState(state);
  const context = createPersonalReminderRuntimeContext({
    evaluatedAt: collection.evaluatedAt,
    state: previousState,
    collection: runtimeCollection.collection,
    graph: runtimeGraph,
    aiDependencyContext: aiDependencyReconciliationContext(
      reduction.items,
      collection.relationCandidates,
      graph,
    ),
    currentEvidenceBySourceId,
  });
  const plan = planPersonalReminderCauses(context);
  const continuityConflictNodeIds = new Set(
    plan.continuityConflicts.map((conflict) => conflict.itemNodeId),
  );
  const personalReminderFallbackNodeIds = new Set<GitHubNodeId>([
    ...unavailableConsumerNodeIds,
    ...continuityConflictNodeIds,
    ...plan.incompleteInputNodeIds,
    ...plan.deferredStructuralEndNodeIds,
  ]);
  const candidates = Object.freeze(
    plan.entries.flatMap((entry) => {
      const candidate = personalReminderAiCandidate(
        entry,
        graph.analysis.downstreamImpacts.find((impact) => impact.nodeId === entry.seed.itemNodeId),
      );
      return candidate == null ? [] : [candidate];
    }),
  );
  const initialUsage = codexAnalysis.run?.usage ?? createEmptyAiBudgetUsage();
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: `${invocation.runId}:personal-reminder`,
        });
  for (const conflict of plan.continuityConflicts) {
    await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.continuity_conflict", {
      phase: "fallback",
      itemNodeId: conflict.itemNodeId,
      previousCauseIds: conflict.previousCauseIds,
    });
  }
  const forcedTarget = forcedAiAnalysisTarget(configuration);
  let run: PersonalReminderAiRunResult | undefined;
  if (configuration.config.ai.enabled && forcedTarget == null) {
    const codexCredentials = configuration.credentials.codex;
    if (!codexCredentials.enabled) {
      throw new TypeError("AIが有効ですがCodex認証情報がありません");
    }
    const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
    const codexDependencies = createCodexAdapterDependencies(
      adapters,
      codexCredentials,
      configuration.codexAttemptBudget,
      diagnostics,
      undefined,
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
      codexAnalysis.run?.authenticationPreflightExecuted === true || preflightInputCost == null
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
    run = await runPersonalReminderAiAnalyses(
      candidates,
      {
        model: configuration.config.ai.model,
        reasoningEffort: configuration.config.ai.execution.reasoningEffort,
        backendVersion: CODEX_BACKEND_VERSION,
        budget: configuration.config.ai.budget,
        initialUsage,
        maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
        minimumConfidence: configuration.config.ai.confidence.high,
        inputCostUsdPerMillionTokens:
          configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
      } satisfies PersonalReminderAiRunConfiguration,
      {
        cache: state.session.personalReminderAiCache,
        attemptBudget: configuration.codexAttemptBudget,
        ensureReady: configuration.ensureCodexReady,
        ...(preflight == null ? {} : { preflight }),
        ...(diagnostics == null ? {} : { diagnostics }),
        execute: (input, ticket) =>
          adapters.executeCodexPersonalReminderAnalysis(
            input,
            codexConfiguration,
            Object.freeze({ ...codexDependencies, initialAttemptTicket: ticket }),
          ),
        executedAt: () => collection.evaluatedAt,
      },
    );
  }
  const application = applyPersonalReminderCauseOutcomes({
    plan,
    outcomes: run,
    evaluatedAt: collection.evaluatedAt,
  });
  const runtimeItemsByNodeId = new Map(
    runtimeCollection.collection.items.map((item) => [item.item.nodeId, item]),
  );
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const expectedItemNodeIds = reduction.items.map((item) => item.nodeId);
  const finalizationItems: PersonalReminderFinalizationItem[] = [];
  for (const item of reduction.items) {
    const observedItem = observedItemsByNodeId.get(item.nodeId);
    const previousItem = previousItemsByNodeId.get(item.nodeId);
    const repositoryId =
      observedItem?.repositoryId ?? previousItem?.repositoryId ?? item.repositoryId;
    assertNonNullable(
      repositoryId,
      `個人催促causeのrepository IDがありません。対象: ${item.nodeId}`,
    );
    const repository = findRepository(deterministicAnalysis.inventory, repositoryId);
    const repositoryName = repositoryFullName(repository);
    const currentLabels = observedItem?.labels ?? previousItem?.labels ?? item.labels;
    const runtimeItem = runtimeItemsByNodeId.get(item.nodeId);
    if (runtimeItem != null && !continuityConflictNodeIds.has(item.nodeId)) {
      finalizationItems.push(
        Object.freeze({
          kind: "evaluated",
          itemNodeId: item.nodeId,
          itemState: item.state,
          collectionCompleteness: runtimeItem.completeness.status,
          repositoryFullName: repositoryName,
          currentLabels,
        }),
      );
      continue;
    }
    assertNonNullable(
      previousItem,
      `個人催促runtime対象外の前回項目がありません。対象: ${item.nodeId}`,
    );
    finalizationItems.push(
      Object.freeze({
        kind: "retained",
        itemNodeId: item.nodeId,
        itemState: item.state,
        planningHandling: continuityConflictNodeIds.has(item.nodeId)
          ? Object.freeze({ kind: "force_pending", reason: "continuity_conflict" })
          : Object.freeze({ kind: "reconcile" }),
        previous: Object.freeze({
          causes: previousItem.personalReminderCauses,
          evidence: previousItem.evidence,
          planning: previousItem.personalReminderCausePlanning,
        }),
        repositoryFullName: repositoryName,
        currentLabels,
      }),
    );
  }
  const result = finalizePersonalReminderAnalysis({
    plan,
    application,
    expectedItemNodeIds,
    items: finalizationItems,
    evaluatedAt: collection.evaluatedAt,
    aiDependencyContext: context.aiDependencyContext,
    currentEvidenceBySourceId,
    previousEvidenceBySourceId: previousState.previousEvidenceBySourceId,
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    resolveLabelEffects: createLabelEffectsResolver(normalizeLabelRules(configuration.config)),
  });
  const counts = personalReminderCauseAttemptCounts(result);
  const usage = run?.usage ?? initialUsage;
  const usageDelta = personalReminderUsageDelta(usage, initialUsage);
  const status =
    personalReminderFallbackNodeIds.size > 0 ||
    counts.failed > 0 ||
    counts.deferred > 0 ||
    [...result.itemsByNodeId.values()].some((item) => item.planning.status === "pending")
      ? "fallback"
      : "success";
  await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.summary", {
    phase: "summary",
    candidateCauseCount: candidates.length,
    aiCallCount: usageDelta.calls,
    cacheHitCauseCount: run?.cacheHitCauseCount ?? 0,
  });
  return Object.freeze({
    status,
    value: Object.freeze({
      status,
      result,
      run,
      budgetUsage: usage,
      authenticationPreflightExecuted: run?.authenticationPreflightExecuted ?? false,
    }),
    aiCallCount: usage.calls,
    estimatedInputTokens: Math.ceil(usage.inputCharacters / 4),
    personalReminderCauseCount: [...result.itemsByNodeId.values()].reduce(
      (count, item) => count + item.causeResults.length,
      0,
    ),
    personalReminderAiCallCount: run?.executedBatchCount ?? 0,
    personalReminderAiCacheHitCount: run?.cacheHitCauseCount ?? 0,
    personalReminderAssessmentReuseCount: personalReminderAssessmentReuseCount(plan),
    personalReminderUnknownCount: counts.unknown,
    personalReminderFailedCount: counts.failed,
    personalReminderDeferredCount: counts.deferred,
    personalReminderNotEvaluatedCount: counts.notEvaluated,
    diagnostics: Object.freeze([]),
  });
}

/** 個人向けリマインダー解析段階を既存adapterへ接続する。 */
export function createAnalyzePersonalRemindersStage(
  adapters: PersonalReminderRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["analyzePersonalReminders"] {
  return ({
    invocation,
    configuration,
    state,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    reduction,
    graph,
  }) =>
    analyzePersonalReminders(
      adapters,
      invocation,
      configuration,
      state,
      collection,
      deterministicAnalysis,
      codexAnalysis,
      reduction,
      graph,
    );
}

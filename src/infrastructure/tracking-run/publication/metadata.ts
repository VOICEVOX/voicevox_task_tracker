import type { PublicationValidatedRun } from "../../../publication/publication-plan-contracts.js";
import type { RunMetrics } from "../../../publication/run-report.js";
import type { RunInvocation } from "../run-invocation.js";
import type { WorkflowRunMetadata } from "../validated-run-payload.js";
import { createWorkflowRunMetadata } from "../validated-run-payload.js";
import type {} from "./contracts.js";

/** 永続化対象のrun metricだけを現在の計算式で投影する。 */
export function persistedMetrics(
  metrics: RunMetrics,
  validated: PublicationValidatedRun,
): WorkflowRunMetadata["metrics"] {
  return Object.freeze({
    repositoryCount: validated.snapshot.repositories.length,
    itemCount: validated.snapshot.items.length,
    changedItemCount: metrics.changedItemCount,
    activeEdgeCount: validated.snapshot.relations.filter((relation) => relation.active).length,
    aiCallCount: metrics.aiCallCount,
    aiProcessAttemptCount: metrics.aiProcessAttemptCount,
    aiCacheHitCount: metrics.aiCacheHitCount,
    aiRetainedResultCount: metrics.aiRetainedResultCount,
    estimatedInputTokens: metrics.estimatedInputTokens,
    personalReminderCauseCount: metrics.personalReminderCauseCount,
    personalReminderAiCallCount: metrics.personalReminderAiCallCount,
    personalReminderAiCacheHitCount: metrics.personalReminderAiCacheHitCount,
    personalReminderAssessmentReuseCount: metrics.personalReminderAssessmentReuseCount,
    personalReminderUnknownCount: metrics.personalReminderUnknownCount,
    personalReminderFailedCount: metrics.personalReminderFailedCount,
    personalReminderDeferredCount: metrics.personalReminderDeferredCount,
    personalReminderNotEvaluatedCount: metrics.personalReminderNotEvaluatedCount,
    githubApiRemaining: metrics.githubApiRemaining,
    staleRepositoryCount: validated.snapshot.repositories.filter(
      (repository) => repository.freshness === "stale",
    ).length,
    scheduleDelayMilliseconds: metrics.scheduleDelayMilliseconds,
  });
}

/** daily run情報からworkflow共通metadataを作る入力。 */
export type CreateRunMetadataInput = Readonly<{
  invocation: RunInvocation;
  validated: PublicationValidatedRun;
  metrics: RunMetrics;
  diagnostics: readonly string[];
}>;

/** daily run情報からworkflow共通metadataを作る。 */
export function createRunMetadata(input: CreateRunMetadataInput): WorkflowRunMetadata {
  return createWorkflowRunMetadata({
    scheduledFor: input.invocation.scheduledFor,
    startedAt: input.invocation.startedAt,
    metrics: persistedMetrics(input.metrics, input.validated),
    diagnostics: input.diagnostics,
  });
}

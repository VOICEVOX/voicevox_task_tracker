import { createStateRunReport } from "../../persistence/index.js";
import type { StateRunReport, StateSnapshot } from "../../persistence/index.js";
import type { UtcIsoDateTime } from "../../domain/index.js";
import type { DailyRunInvocation } from "../daily-transaction.js";
import type { RunMetrics } from "../run-report.js";
import { createWorkflowRunMetadata } from "../workflow-artifact.js";
import type { WorkflowRunMetadata } from "../workflow-artifact.js";
import type { ValidatedRun } from "./contracts.js";

/** 永続化対象のrun metricだけを現在の計算式で投影する。 */
export function persistedMetrics(
  metrics: RunMetrics,
  validated: ValidatedRun,
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
  invocation: DailyRunInvocation;
  validated: ValidatedRun;
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

/** 完了済みrunのstate reportを作る入力。 */
export type CreatePersistedRunReportInput = Readonly<{
  snapshot: StateSnapshot;
  metadata: WorkflowRunMetadata;
  notificationCount: number;
  finishedAt: UtcIsoDateTime;
}>;

/** 完了済みrunのstate reportを作る。 */
export function createPersistedRunReport(input: CreatePersistedRunReportInput): StateRunReport {
  return createStateRunReport({
    schemaVersion: "3",
    runId: input.snapshot.run.id,
    date: input.metadata.startedAt.slice(0, 10),
    status: input.snapshot.run.status,
    complete: true,
    scheduledFor: input.metadata.scheduledFor,
    startedAt: input.metadata.startedAt,
    finishedAt: input.finishedAt,
    metrics: {
      ...input.metadata.metrics,
      notificationCount: input.notificationCount,
      durationMilliseconds: Date.parse(input.finishedAt) - Date.parse(input.metadata.startedAt),
    },
    diagnostics: input.metadata.diagnostics,
  });
}

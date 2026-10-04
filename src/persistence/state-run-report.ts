import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import { StateFormatError } from "./errors.js";

const nonEmptyStringSchema = z.string().min(1).max(1000);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => {
      const timestamp = Date.parse(`${value}T00:00:00.000Z`);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value);
    },
    {
      message: "実在する日付を指定してください",
    },
  );
const runMetricsSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  changedItemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  aiCallCount: nonNegativeIntegerSchema,
  aiProcessAttemptCount: nonNegativeIntegerSchema,
  aiCacheHitCount: nonNegativeIntegerSchema,
  aiRetainedResultCount: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  personalReminderCauseCount: nonNegativeIntegerSchema,
  personalReminderAiCallCount: nonNegativeIntegerSchema,
  personalReminderAiCacheHitCount: nonNegativeIntegerSchema,
  personalReminderAssessmentReuseCount: nonNegativeIntegerSchema,
  personalReminderUnknownCount: nonNegativeIntegerSchema,
  personalReminderFailedCount: nonNegativeIntegerSchema,
  personalReminderDeferredCount: nonNegativeIntegerSchema,
  personalReminderNotEvaluatedCount: nonNegativeIntegerSchema,
  githubApiRemaining: nonNegativeIntegerSchema,
  staleRepositoryCount: nonNegativeIntegerSchema,
  notificationCount: nonNegativeIntegerSchema,
  scheduleDelayMilliseconds: nonNegativeIntegerSchema,
  durationMilliseconds: nonNegativeIntegerSchema,
});
const runReportSchema = z
  .strictObject({
    schemaVersion: z.literal("3"),
    runId: nonEmptyStringSchema,
    date: dateSchema,
    status: z.enum(["success", "fallback"]),
    complete: z.literal(true),
    scheduledFor: dateTimeSchema,
    startedAt: dateTimeSchema,
    finishedAt: dateTimeSchema,
    metrics: runMetricsSchema,
    diagnostics: z.array(z.string().max(1000)),
  })
  .superRefine((report, context) => {
    const scheduledFor = Date.parse(report.scheduledFor);
    const startedAt = Date.parse(report.startedAt);
    const finishedAt = Date.parse(report.finishedAt);
    if (scheduledFor > startedAt) {
      context.addIssue({
        code: "custom",
        path: ["scheduledFor"],
        message: "予定時刻は開始時刻以前にしてください",
      });
    }
    if (startedAt > finishedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "終了時刻は開始時刻以後にしてください",
      });
    }
    if (report.date !== report.startedAt.slice(0, 10)) {
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: "日付は開始時刻のUTC日付に一致させてください",
      });
    }
    if (report.metrics.scheduleDelayMilliseconds !== startedAt - scheduledFor) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "scheduleDelayMilliseconds"],
        message: "schedule遅延が予定時刻と開始時刻に一致しません",
      });
    }
    if (report.metrics.durationMilliseconds !== finishedAt - startedAt) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "durationMilliseconds"],
        message: "所要時間が開始時刻と終了時刻に一致しません",
      });
    }
  });

/** 日次runの完了状態と運用metricsを保持するreport。 */
export type StateRunReport = z.output<typeof runReportSchema>;

/** 未検証の値を完了済みrun reportへ変換する。 */
export function createStateRunReport(value: unknown): StateRunReport {
  const result = runReportSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("run report", result.error);
  }
  return {
    ...result.data,
    metrics: {
      ...result.data.metrics,
    },
    diagnostics: [...result.data.diagnostics],
  };
}

/** run reportを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateRunReport(report: StateRunReport): string {
  return serializeCanonicalJsonLine(createStateRunReport(report));
}

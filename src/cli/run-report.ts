import { z } from "zod";

import { serializeCanonicalJsonLine } from "../persistence/index.js";
import { CliOutputError } from "./errors.js";

const nonEmptyStringSchema = z.string().min(1).max(1000);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const nonNegativeIntegerSchema = z.number().int().nonnegative();

const runMetricsSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  changedItemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  aiCallCount: nonNegativeIntegerSchema,
  aiCacheHitCount: nonNegativeIntegerSchema,
  aiRetainedResultCount: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  githubApiRemaining: nonNegativeIntegerSchema,
  staleRepositoryCount: nonNegativeIntegerSchema,
  notificationCount: nonNegativeIntegerSchema,
  scheduleDelayMilliseconds: nonNegativeIntegerSchema,
  durationMilliseconds: nonNegativeIntegerSchema,
});

const runReportFields = {
  schemaVersion: z.literal("1"),
  runId: nonEmptyStringSchema,
  command: z.enum(["daily", "dry-run", "backfill", "collect-analyze", "replay", "eval"]),
  scheduledFor: dateTimeSchema,
  startedAt: dateTimeSchema,
  finishedAt: dateTimeSchema,
  discordSentAt: dateTimeSchema.nullable(),
  metrics: runMetricsSchema,
  diagnostics: z.array(z.string().min(1).max(1000)),
};

const runReportSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      ...runReportFields,
      status: z.literal("success"),
      complete: z.literal(true),
    }),
    z.strictObject({
      ...runReportFields,
      status: z.literal("fallback"),
      complete: z.literal(true),
    }),
    z.strictObject({
      ...runReportFields,
      status: z.literal("failure"),
      complete: z.literal(false),
      failedStage: z.enum([
        "configuration",
        "authentication",
        "repository_inventory",
        "incremental_collection",
        "deterministic_analysis",
        "codex_analysis",
        "reducer",
        "graph_analysis",
        "completeness_validation",
        "state_persistence",
        "pages",
        "discord",
        "artifact",
        "replay",
        "eval",
      ]),
    }),
  ])
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
    if (
      report.discordSentAt != null &&
      (report.discordSentAt < report.startedAt || report.discordSentAt > report.finishedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["discordSentAt"],
        message: "Discord送信時刻はrunの開始から終了までにしてください",
      });
    }
    if (report.metrics.durationMilliseconds !== finishedAt - startedAt) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "durationMilliseconds"],
        message: "所要時間が開始時刻と終了時刻に一致しません",
      });
    }
    if (report.metrics.scheduleDelayMilliseconds !== startedAt - scheduledFor) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "scheduleDelayMilliseconds"],
        message: "schedule遅延が予定時刻と開始時刻に一致しません",
      });
    }
  });

/** run reportへ必ず記録する運用指標。 */
export type RunMetrics = z.output<typeof runMetricsSchema>;

/** 成功、縮退、失敗を同じ必須指標で表すCLI run report。 */
export type RunReport = z.output<typeof runReportSchema>;

/** run reportで識別する処理段階。 */
export type RunStage = Extract<RunReport, { status: "failure" }>["failedStage"];

/** 全必須指標を0で初期化する。 */
export function createEmptyRunMetrics(): RunMetrics {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    aiRetainedResultCount: 0,
    estimatedInputTokens: 0,
    githubApiRemaining: 0,
    staleRepositoryCount: 0,
    notificationCount: 0,
    scheduleDelayMilliseconds: 0,
    durationMilliseconds: 0,
  });
}

/** 未検証の値を時系列も検証したrun reportへ変換する。 */
export function createRunReport(value: unknown): RunReport {
  const result = runReportSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("run reportの検証に失敗しました", {
      cause: result.error,
    });
  }
  if (result.data.status === "failure") {
    return Object.freeze({
      ...result.data,
      status: "failure",
      complete: false,
      failedStage: result.data.failedStage,
      metrics: {
        ...result.data.metrics,
      },
      diagnostics: [...result.data.diagnostics],
    });
  }
  if (result.data.status === "success") {
    return Object.freeze({
      ...result.data,
      status: "success",
      complete: true,
      metrics: {
        ...result.data.metrics,
      },
      diagnostics: [...result.data.diagnostics],
    });
  }
  return Object.freeze({
    ...result.data,
    status: "fallback",
    complete: true,
    metrics: {
      ...result.data.metrics,
    },
    diagnostics: [...result.data.diagnostics],
  });
}

/** run reportをcanonical JSONへ変換する。 */
export function serializeRunReport(report: RunReport): string {
  return serializeCanonicalJsonLine(createRunReport(report));
}

/** run reportを指定されたwriterへ安全に出力する。 */
export async function writeRunReport(
  path: string,
  report: RunReport,
  write: (path: string, source: string) => Promise<void>,
): Promise<void> {
  try {
    await write(path, serializeRunReport(report));
  } catch (error: unknown) {
    throw new CliOutputError(path, {
      cause: error,
    });
  }
}

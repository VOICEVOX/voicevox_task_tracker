import { z } from "zod";

import { serializeCanonicalJsonLine } from "./canonical-json.js";
import { StateFormatError } from "./errors.js";

const nonEmptyStringSchema = z.string().min(1).max(1000);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
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
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const notificationReasonCodeSchema = z.enum([
  "none",
  "assessment_overdue",
  "review_overdue",
  "author_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "ready_to_merge_overdue",
  "automation_stuck",
]);
const operationsAlertKindSchema = z.enum(["collection", "pages", "discord"]);

const runMetricsSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  changedItemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  aiCallCount: nonNegativeIntegerSchema,
  aiCacheHitCount: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  githubApiRemaining: nonNegativeIntegerSchema,
  staleRepositoryCount: nonNegativeIntegerSchema,
  notificationCount: nonNegativeIntegerSchema,
  scheduleDelayMilliseconds: nonNegativeIntegerSchema,
  durationMilliseconds: nonNegativeIntegerSchema,
});
const runReportSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
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

const ledgerEntryBaseSchema = z.strictObject({
  notificationKey: nonEmptyStringSchema,
  itemNodeId: nonEmptyStringSchema,
  reasonCode: notificationReasonCodeSchema,
  severity: severitySchema,
  reservedAt: dateTimeSchema,
  cooldownUntil: dateTimeSchema,
});
const ledgerEntrySchema = z.discriminatedUnion("status", [
  ledgerEntryBaseSchema.extend({
    status: z.literal("reserved"),
    expiresAt: dateTimeSchema,
  }),
  ledgerEntryBaseSchema.extend({
    status: z.literal("sent"),
    sentAt: dateTimeSchema,
    discordMessageId: nonEmptyStringSchema,
  }),
]);
const operationsAlertEntrySchema = z.strictObject({
  alertKey: nonEmptyStringSchema,
  incidentId: nonEmptyStringSchema,
  kind: operationsAlertKindSchema,
  occurredAt: dateTimeSchema,
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const notificationLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    entries: z.array(ledgerEntrySchema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "運用障害通知のalertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "送信時刻は障害発生時刻以後にしてください",
        });
      }
    }
    for (const [index, entry] of ledger.entries.entries()) {
      if (entry.cooldownUntil < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "cooldownUntil"],
          message: "cooldown終了時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "expiresAt"],
          message: "予約期限は予約時刻以後にしてください",
        });
      }
      if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sentAt"],
          message: "送信時刻は予約時刻以後にしてください",
        });
      }
    }
  });

/** 日次runの完了状態と運用metricsを保持するreport。 */
export type StateRunReport = z.output<typeof runReportSchema>;

/** 通常通知の予約と送信結果、送信済み運用障害を保持するledger。 */
export type StateNotificationLedger = z.output<typeof notificationLedgerSchema>;

function createFormatError(kind: string, error: z.ZodError): StateFormatError {
  return StateFormatError.fromZodError(kind, error);
}

/** 未検証の値を完了済みrun reportへ変換する。 */
export function createStateRunReport(value: unknown): StateRunReport {
  const result = runReportSchema.safeParse(value);
  if (!result.success) {
    throw createFormatError("run report", result.error);
  }
  return {
    ...result.data,
    metrics: {
      ...result.data.metrics,
    },
    diagnostics: [...result.data.diagnostics],
  };
}

/** 未検証の値をnotification ledgerへ変換する。 */
export function createStateNotificationLedger(value: unknown): StateNotificationLedger {
  const result = notificationLedgerSchema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  const compareNotificationKeys = (
    left: StateNotificationLedger["entries"][number],
    right: StateNotificationLedger["entries"][number],
  ): number => {
    if (left.notificationKey < right.notificationKey) {
      return -1;
    }
    if (left.notificationKey > right.notificationKey) {
      return 1;
    }
    return 0;
  };
  return {
    schemaVersion: "1",
    entries: [...result.data.entries].sort(compareNotificationKeys),
    operationsAlerts: [...result.data.operationsAlerts].sort((left, right) => {
      if (left.alertKey < right.alertKey) {
        return -1;
      }
      if (left.alertKey > right.alertKey) {
        return 1;
      }
      return 0;
    }),
  };
}

/** 初回bootstrap用の空notification ledgerを生成する。 */
export function createEmptyStateNotificationLedger(): StateNotificationLedger {
  return {
    schemaVersion: "1",
    entries: [],
    operationsAlerts: [],
  };
}

/** run reportを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateRunReport(report: StateRunReport): string {
  return serializeCanonicalJsonLine(createStateRunReport(report));
}

/** notification ledgerを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateNotificationLedger(ledger: StateNotificationLedger): string {
  return serializeCanonicalJsonLine(createStateNotificationLedger(ledger));
}

/** JSONからnotification ledgerを検証して読み取る。 */
export function parseStateNotificationLedger(source: string): StateNotificationLedger {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("notification ledger", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
  return createStateNotificationLedger(value);
}

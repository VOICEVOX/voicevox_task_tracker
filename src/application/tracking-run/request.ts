import { z } from "zod";

import { createUtcIsoDateTime } from "../../domain/types.js";
import { notificationActionSchema } from "./contracts/closed-values.js";

const nonEmptyStringSchema = z.string().min(1);
const utcDateTimeSchema = z.iso.datetime({ offset: true }).transform(createUtcIsoDateTime);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const repositoryNameSchema = z.string().regex(/^VOICEVOX\/[A-Za-z0-9._-]+$/u);
const repositoryListSchema = z.array(repositoryNameSchema).superRefine((repositories, context) => {
  const sorted = [...repositories].sort();
  if (
    new Set(repositories).size !== repositories.length ||
    repositories.some((repository, index) => repository !== sorted[index])
  ) {
    context.addIssue({
      code: "custom",
      message: "backfill対象repositoryは重複なく名前順に指定してください",
    });
  }
});

const backfillRangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("linked"), repositories: repositoryListSchema }),
  z.strictObject({ kind: z.literal("all-open"), repositories: repositoryListSchema }),
]);

/** backfillで追加する公開repositoryの範囲。 */
export type BackfillRange = z.output<typeof backfillRangeSchema>;

const productionDailyPolicySchema = z.strictObject({
  kind: z.literal("production_daily"),
  executionShape: z.enum(["sequential", "split_workflow"]),
  effectTarget: z.literal("production"),
  notificationAction: notificationActionSchema,
});
const sandboxDailyPolicySchema = z.strictObject({
  kind: z.literal("sandbox_daily"),
  executionShape: z.literal("split_workflow"),
  effectTarget: z.literal("sandbox"),
  notificationAction: notificationActionSchema,
});
const dryRunPolicySchema = z.strictObject({
  kind: z.literal("dry_run"),
  executionShape: z.literal("sequential"),
  effectTarget: z.literal("recording"),
  notificationAction: z.literal("hold"),
});
const backfillPolicySchema = z.strictObject({
  kind: z.literal("backfill"),
  executionShape: z.enum(["sequential", "split_workflow"]),
  effectTarget: z.enum(["production", "sandbox"]),
  notificationAction: notificationActionSchema,
  backfillRange: backfillRangeSchema,
});

export const runExecutionPolicySchema = z.discriminatedUnion("kind", [
  productionDailyPolicySchema,
  sandboxDailyPolicySchema,
  dryRunPolicySchema,
  backfillPolicySchema,
]);

/** 実行形、作用先、通知処理の有効な組合せ。 */
export type RunExecutionPolicy = z.output<typeof runExecutionPolicySchema>;

const requestFields = {
  invocationId: z.uuid(),
  configPath: nonEmptyStringSchema,
  reportPath: nonEmptyStringSchema,
  scheduledFor: utcDateTimeSchema,
  startedAt: utcDateTimeSchema,
};

const sequentialDailyRequestSchema = z.strictObject({
  ...requestFields,
  requestKind: z.literal("sequential_daily"),
  executionPolicy: productionDailyPolicySchema.extend({
    executionShape: z.literal("sequential"),
  }),
  output: z.strictObject({ kind: z.literal("publication") }),
});
const splitDailyRequestSchema = z.strictObject({
  ...requestFields,
  requestKind: z.literal("split_daily"),
  executionPolicy: productionDailyPolicySchema.extend({
    executionShape: z.literal("split_workflow"),
  }),
  output: z.strictObject({ kind: z.literal("analysis_artifact"), path: nonEmptyStringSchema }),
});
const sandboxDailyRequestSchema = z.strictObject({
  ...requestFields,
  requestKind: z.literal("sandbox_daily"),
  executionPolicy: sandboxDailyPolicySchema,
  sandboxContextPath: nonEmptyStringSchema,
  output: z.strictObject({ kind: z.literal("analysis_artifact"), path: nonEmptyStringSchema }),
});
const dryRunRequestSchema = z.strictObject({
  ...requestFields,
  requestKind: z.literal("dry_run"),
  executionPolicy: dryRunPolicySchema,
  output: z.strictObject({ kind: z.literal("dry_run_artifact"), path: nonEmptyStringSchema }),
});
const sequentialBackfillRequestSchema = z.strictObject({
  ...requestFields,
  requestKind: z.literal("sequential_backfill"),
  executionPolicy: backfillPolicySchema.extend({
    executionShape: z.literal("sequential"),
    effectTarget: z.literal("production"),
  }),
  output: z.strictObject({ kind: z.literal("publication") }),
});
const splitBackfillRequestSchema = z.strictObject({
  ...requestFields,
  requestKind: z.literal("split_backfill"),
  executionPolicy: backfillPolicySchema.extend({
    executionShape: z.literal("split_workflow"),
    effectTarget: z.literal("production"),
  }),
  output: z.strictObject({ kind: z.literal("analysis_artifact"), path: nonEmptyStringSchema }),
});

const backfillNoneRequestSchema = sequentialDailyRequestSchema.extend({
  requestKind: z.literal("backfill_none"),
});

export const runRequestSchema = z
  .union([
    sequentialDailyRequestSchema,
    splitDailyRequestSchema,
    sandboxDailyRequestSchema,
    dryRunRequestSchema,
    sequentialBackfillRequestSchema,
    splitBackfillRequestSchema,
    backfillNoneRequestSchema,
  ])
  .superRefine((request, context) => {
    if (request.scheduledFor > request.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["scheduledFor"],
        message: "予定時刻は開始時刻以前にしてください",
      });
    }
    if (request.output.kind !== "publication" && request.output.path === request.reportPath) {
      context.addIssue({
        code: "custom",
        path: ["output", "path"],
        message: "reportとartifactには異なるpathを指定してください",
      });
    }
  });

/** CLIとworkflowから受け取る検証済みの新規run要求。 */
export type RunRequest = z.output<typeof runRequestSchema>;

export const runIdentitySchema = z.strictObject({
  runId: runIdSchema,
  invocationId: z.uuid(),
  scheduledFor: utcDateTimeSchema,
  startedAt: utcDateTimeSchema,
});

/** 一つのrunと一つの起動を区別する識別情報。 */
export type RunIdentity = z.output<typeof runIdentitySchema>;

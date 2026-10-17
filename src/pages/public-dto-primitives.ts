import { z } from "zod";

import { IMPORTANCE_FACTOR_KINDS } from "../domain/importance.js";

/** Pages公開DTOのschema version。 */
export const PUBLIC_DTO_SCHEMA_VERSION = "10";

export const identifierSchema = z.string().min(1).max(512).regex(/^\S+$/u);
export const shortStringSchema = z.string().max(1000);
export const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
export const githubUrlSchema = z
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  }, "GitHubのHTTPS URLを指定してください");
export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export const statusSchema = z.enum([
  "waiting_for_assessment",
  "waiting_for_owner",
  "waiting_for_decision",
  "waiting_for_review",
  "waiting_for_revision",
  "waiting_for_reply",
  "waiting_for_work",
  "waiting_for_unblock",
  "waiting_for_automation",
  "waiting_for_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
]);
export const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const importanceLevelSchema = z.enum(["low", "medium", "high"]);
export const deadlineLevelSchema = z.enum([
  "none",
  "over_30_days",
  "within_30_days",
  "within_7_days",
  "within_3_days",
  "within_1_day",
  "overdue",
]);
function isCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export const deadlineDateSchema = z.union([
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .refine(isCalendarDate, {
      message: "実在する日付を指定してください",
    }),
  z.null(),
]);
export const publicImportanceSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  level: importanceLevelSchema,
});
export const importanceFactorSchema = z.strictObject({
  kind: z.enum(IMPORTANCE_FACTOR_KINDS),
  points: z.number().positive(),
  detail: z.string().min(1).max(1000),
});
export const waitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: identifierSchema,
  role: z.enum([
    "author",
    "maintainer",
    "reviewer",
    "assignee",
    "respondent",
    "dependency",
    "merge_decider",
    "ci",
    "unknown",
  ]),
  reasonSummary: shortStringSchema,
  confidence: z.number().min(0).max(1),
});
export const primaryWaitingOnSchema = z.discriminatedUnion("index", [
  z.strictObject({
    index: z.literal(0),
    selectionReason: shortStringSchema,
  }),
  z.strictObject({
    index: z.literal("not_applicable"),
    selectionReason: shortStringSchema,
  }),
]);
export const publicEvidenceSchema = z.strictObject({
  summary: shortStringSchema,
  sourceUrl: githubUrlSchema,
});
export const publicPersonalReminderResponsibleSchema = z.strictObject({
  kind: z.enum(["user", "team", "role"]),
  candidateId: identifierSchema,
  role: z.enum([
    "author",
    "maintainer",
    "reviewer",
    "assignee",
    "respondent",
    "merge_decider",
    "unknown",
  ]),
});

export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

import { z } from "zod";
import { initialStateWriteManifestSchema } from "./initial-state-write-manifest.js";

import { parseSha256Hash } from "../../../canonical-json/sha256.js";
import { createUtcIsoDateTime } from "../../../domain/index.js";
import type { LabelRuleEffects } from "../../../domain/index.js";

const sha256Schema = z.string().transform(parseSha256Hash);
const statePathSchema = z
  .string()
  .regex(/^state\/[A-Za-z0-9._/-]+$/u)
  .refine(
    (value) =>
      !value.endsWith("/") &&
      !value
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === ".."),
  );
const nonNegativeNumberSchema = z.number().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const webBasePathPattern = /^\/(?:[A-Za-z0-9._~-]+\/)*$/u;
export const publicationPagesUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "voicevox.github.io" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === value &&
    webBasePathPattern.test(url.pathname) &&
    !url.pathname.split("/").some((segment) => segment === "." || segment === "..")
  );
});
const publicationFileStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({ status: z.literal("present"), digest: sha256Schema }),
]);
const labelRuleEffectsSchema = z
  .strictObject({
    priorityWeight: z.number().optional(),
    severityLift: z.number().optional(),
    requiresMaintainerDecision: z.boolean().optional(),
    suppressNotifications: z.boolean().optional(),
    countsAsProgress: z.boolean().optional(),
  })
  .transform((effects): LabelRuleEffects => {
    const value: {
      priorityWeight?: number;
      severityLift?: number;
      requiresMaintainerDecision?: boolean;
      suppressNotifications?: boolean;
      countsAsProgress?: boolean;
    } = {};
    if (effects.priorityWeight != null) value.priorityWeight = effects.priorityWeight;
    if (effects.severityLift != null) value.severityLift = effects.severityLift;
    if (effects.requiresMaintainerDecision != null) {
      value.requiresMaintainerDecision = effects.requiresMaintainerDecision;
    }
    if (effects.suppressNotifications != null) {
      value.suppressNotifications = effects.suppressNotifications;
    }
    if (effects.countsAsProgress != null) value.countsAsProgress = effects.countsAsProgress;
    return Object.freeze(value);
  });

/** 公開計画に必要な設定と固定revisionの保存前提。 */
export const publicationInputsSchema = z.strictObject({
  state: z.strictObject({
    snapshotPath: statePathSchema,
    historyPath: statePathSchema,
    notificationLedgerPath: statePathSchema,
    aiCacheDirectory: statePathSchema,
    personalReminderAiCacheDirectory: statePathSchema,
    runReportsDirectory: statePathSchema,
    oldCacheDeletionPaths: z.array(statePathSchema),
    historyBase: publicationFileStateSchema,
    initialStateWriteManifest: initialStateWriteManifestSchema,
    previousInitialPagesEvidence: publicationFileStateSchema,
  }),
  pages: z.strictObject({
    url: publicationPagesUrlSchema,
    confidenceThresholds: z.strictObject({
      high: z.number().min(0).max(1),
      medium: z.number().min(0).max(1),
    }),
    labelRules: z.array(
      z.strictObject({
        repository: z.string(),
        namePattern: z.string(),
        effects: labelRuleEffectsSchema,
      }),
    ),
    maxInitialGraphNodes: positiveIntegerSchema,
    maxSummaryGzipBytes: positiveIntegerSchema,
    timezone: z.string().min(1),
  }),
  discord: z.strictObject({
    enabled: z.boolean(),
    webhookSecretName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    operationsWebhookSecretName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    mentions: z.strictObject({
      enabled: z.boolean(),
      users: z.record(z.string(), z.string().regex(/^\d{17,20}$/u)),
    }),
    retry: z.strictObject({
      maxAttempts: positiveIntegerSchema,
      initialDelaySeconds: nonNegativeNumberSchema,
      maxDelaySeconds: nonNegativeNumberSchema,
    }),
  }),
  configuredTrackingStartAt: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_configured") }),
    z.strictObject({
      status: z.literal("configured"),
      value: z.iso.datetime({ offset: true }).transform(createUtcIsoDateTime),
    }),
  ]),
});

type ParsedPublicationInputs = z.output<typeof publicationInputsSchema>;
export type PublicationInputs = Omit<ParsedPublicationInputs, "state"> &
  Readonly<{
    state: Omit<ParsedPublicationInputs["state"], "oldCacheDeletionPaths"> &
      Readonly<{ oldCacheDeletionPaths: readonly string[] }>;
  }>;

/** 公開計画に渡す設定投影をschemaで検証する。 */
export function parsePublicationInputs(value: unknown): PublicationInputs {
  return publicationInputsSchema.parse(value);
}

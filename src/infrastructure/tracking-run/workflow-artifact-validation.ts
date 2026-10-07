import { z } from "zod";

import { publicRunDiagnosticsSchema } from "../../application/tracking-run/contracts/public-diagnostics.js";
import { publicationInputsSchema } from "../../application/tracking-run/contracts/publication-inputs.js";
import { baseStateRevisionSchema } from "../../application/tracking-run/contracts/run-core.js";
import {
  runExecutionPolicySchema,
  runIdentitySchema,
} from "../../application/tracking-run/request.js";
import { parseSha256Hash } from "../../canonical-json/sha256.js";
import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
} from "../../domain/index.js";
import { createStateNotificationLedger } from "../../persistence/index.js";
import type { PublicationValidatedRun } from "../../publication/publication-plan-contracts.js";
import { runMetricsSchema } from "../../publication/run-report.js";
import { parseWorkflowEvidenceWitness } from "./workflow-artifact-witness.js";

const sha256Schema = z.string().transform(parseSha256Hash);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const chargeSchema = z.strictObject({
  inputCharacters: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  estimatedCostUsd: z.number().nonnegative(),
});
const reservationSchema = z.strictObject({
  id: z.strictObject({ ledgerId: z.string().min(1), sequence: z.number().int().positive() }),
  kind: z.enum([
    "authentication_preflight",
    "authentication_preflight_transport_retry",
    "generic_initial",
    "generic_transport_retry",
    "generic_semantic_correction",
    "generic_semantic_correction_transport_retry",
    "personal_initial",
    "personal_transport_retry",
  ]),
  ownerId: z.string().min(1),
  charge: chargeSchema,
});
const aiBudgetSchema = z.strictObject({
  ledgerId: z.string().min(1),
  sequence: nonNegativeIntegerSchema,
  maxProcessAttempts: nonNegativeIntegerSchema,
  maxInputCharacters: nonNegativeIntegerSchema,
  maxEstimatedCostUsd: z.number().nonnegative(),
  reservations: z.array(reservationSchema),
  events: z.array(
    z.strictObject({
      sequence: z.number().int().positive(),
      action: z.enum(["reserved", "consumed", "released"]),
      reservation: reservationSchema,
      charge: chargeSchema,
    }),
  ),
});
const budgetSummarySchema = z.strictObject({
  logicalCandidateCount: nonNegativeIntegerSchema,
  processAttemptCount: nonNegativeIntegerSchema,
  authenticationPreflightAttemptCount: nonNegativeIntegerSchema,
  transportRetryCount: nonNegativeIntegerSchema,
  semanticCorrectionCount: nonNegativeIntegerSchema,
  inputCharacters: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  estimatedCostUsd: z.number().nonnegative(),
  reservedProcessAttempts: nonNegativeIntegerSchema,
  reservedInputCharacters: nonNegativeIntegerSchema,
  reservedEstimatedCostUsd: z.number().nonnegative(),
  remainingProcessAttempts: nonNegativeIntegerSchema,
  remainingInputCharacters: nonNegativeIntegerSchema,
  remainingEstimatedCostUsd: z.number().nonnegative(),
});
const validationSchema = z.strictObject({
  core: z.strictObject({
    identity: runIdentitySchema,
    executionPolicy: runExecutionPolicySchema,
    baseRevision: baseStateRevisionSchema,
    configDigest: sha256Schema,
    allowlistDigest: sha256Schema,
    generatedAt: z.iso.datetime({ offset: true }).transform(createUtcIsoDateTime),
    aiBudget: aiBudgetSchema,
    aiBudgetSummary: budgetSummarySchema,
  }),
  previousNotificationLedger: z.unknown(),
  publicationInputs: publicationInputsSchema,
  metrics: runMetricsSchema,
  diagnostics: publicRunDiagnosticsSchema,
  evidenceClosureSummary: z.strictObject({
    referenceCount: nonNegativeIntegerSchema,
    sourceIds: z.array(z.string().min(1)),
  }),
  evidenceClosureWitness: z.unknown(),
  finalItemAiLineage: z.array(
    z.strictObject({
      nodeId: z.string().min(1).transform(createGitHubNodeId),
      repositoryId: z.string().min(1).transform(createGitHubRepositoryId),
      kind: z.enum(["analyzed", "retained"]),
    }),
  ),
  publicDiagnosticsSummary: z.strictObject({
    status: z.enum(["success", "fallback"]),
    pendingNotificationCount: nonNegativeIntegerSchema,
  }),
  artifactValueDigests: z.strictObject({
    core: sha256Schema,
    snapshot: sha256Schema,
    historyInputEvents: sha256Schema,
    aiCacheAdditions: sha256Schema,
    personalReminderAiCacheAdditions: sha256Schema,
    previousNotificationLedger: sha256Schema,
    notificationLedger: sha256Schema,
    notificationSelection: sha256Schema,
    notificationPreview: sha256Schema,
    publicationInputs: sha256Schema,
    repositoryAllowlist: sha256Schema,
    metrics: sha256Schema,
    diagnostics: sha256Schema,
    evidenceClosureSummary: sha256Schema,
    evidenceClosureWitness: sha256Schema,
    finalItemAiLineage: sha256Schema,
    publicDiagnosticsSummary: sha256Schema,
  }),
});
const identityWitnessSchema = validationSchema.shape.core.pick({
  identity: true,
  executionPolicy: true,
  baseRevision: true,
  configDigest: true,
});

/** artifactとrun本体の片側変更を検出する識別情報。 */
export type WorkflowIdentityWitness = z.output<typeof identityWitnessSchema>;

/** checkpoint内の公開識別情報をschemaで読む。 */
export function parseWorkflowIdentityWitness(value: unknown): WorkflowIdentityWitness {
  return identityWitnessSchema.parse(value);
}

/** checkpoint内のrun完全性検証情報。 */
export type WorkflowValidation = Pick<
  Omit<PublicationValidatedRun, "proof">,
  | "core"
  | "previousNotificationLedger"
  | "publicationInputs"
  | "metrics"
  | "diagnostics"
  | "evidenceClosureSummary"
  | "evidenceClosureWitness"
  | "finalItemAiLineage"
  | "publicDiagnosticsSummary"
  | "artifactValueDigests"
>;

/** checkpoint内のrun完全性情報をschemaで読む。 */
export function parseWorkflowValidation(value: unknown): WorkflowValidation {
  const parsed = validationSchema.parse(value);
  z.object({ schemaVersion: z.literal("10") }).parse(parsed.previousNotificationLedger);
  return Object.freeze({
    ...parsed,
    previousNotificationLedger: createStateNotificationLedger(parsed.previousNotificationLedger),
    evidenceClosureWitness: parseWorkflowEvidenceWitness(parsed.evidenceClosureWitness),
  });
}

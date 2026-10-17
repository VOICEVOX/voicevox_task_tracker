import { z } from "zod";

import { analysisRunStageNames } from "./contracts/closed-values.js";
import { baseStateRevisionSchema } from "./contracts/run-core.js";
import { gitCommitRevisionSchema } from "./contracts/revision.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const nonEmptyStringSchema = z.string().min(1).max(1000);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const operationIdSchema = z.string().regex(/^operation:v1:[0-9a-f]{64}$/u);
const attemptIdSchema = z.string().regex(/^attempt:v1:[0-9a-f]{64}$/u);
const receiptIdSchema = z.string().regex(/^receipt:v1:[0-9a-f]{64}$/u);
const observedAtSchema = z.iso.datetime({ offset: true });
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
export const RECEIPT_SCHEMA_VERSION = 1;
export const pagesPublicUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
  );
});

export const preCheckpointFailureStageSchema = z.enum([
  ...analysisRunStageNames,
  "checkpoint_encoding",
  "checkpoint_binding",
]);

const observedFileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({ kind: z.literal("present"), fileDigest: sha256Schema }),
]);

export const receiptBindingSchema = z.discriminatedUnion("bindingKind", [
  z.strictObject({
    bindingKind: z.literal("checkpoint"),
    runId: runIdSchema,
    checkpointDigest: sha256Schema,
    checkpointFileDigest: sha256Schema,
    runtimeIdentityDigest: sha256Schema,
  }),
  z.strictObject({
    bindingKind: z.literal("run_pre_checkpoint_alert"),
    runId: runIdSchema,
    baseStateRevision: baseStateRevisionSchema,
    configDigest: sha256Schema,
    failureArtifactDigest: sha256Schema,
    failedStage: preCheckpointFailureStageSchema,
  }),
  z.strictObject({
    bindingKind: z.literal("state_bootstrap_alert"),
    observedStateRevision: gitCommitRevisionSchema,
    observedMarkerFile: observedFileSchema,
    observedRecordFile: observedFileSchema,
    failureArtifactDigest: sha256Schema,
    failedStage: z.literal("runtime_bootstrap"),
  }),
  z.strictObject({
    bindingKind: z.literal("invocation_pre_run_alert"),
    failureArtifactDigest: sha256Schema,
    failedStage: z.enum(["prepare", "runtime_bootstrap"]),
  }),
]);

export const pagesDeploymentExternalReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github_pages_actions"),
    deploymentId: nonEmptyStringSchema,
    actionsArtifact: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("identified"),
        artifactId: nonEmptyStringSchema,
        artifactDigest: sha256Schema,
      }),
      z.strictObject({
        kind: z.literal("identified_without_digest"),
        artifactId: nonEmptyStringSchema,
        limitation: z.literal("action_did_not_expose_artifact_digest"),
      }),
      z.strictObject({
        kind: z.literal("not_exposed"),
        artifactName: nonEmptyStringSchema,
        limitation: z.literal("action_did_not_expose_artifact_id_or_digest"),
      }),
    ]),
    adapterIdentityDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("sequential_production"),
    deploymentReference: nonEmptyStringSchema,
    adapterIdentityDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("recording"),
    recordingId: nonEmptyStringSchema,
    adapterIdentityDigest: sha256Schema,
    productionEffect: z.literal(false),
  }),
]);

const receiptFields = {
  schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
  binding: receiptBindingSchema,
  operationId: operationIdSchema,
  logicalTarget: nonEmptyStringSchema,
  invocationId: z.uuid(),
  localAttemptIndex: nonNegativeIntegerSchema,
  attemptId: attemptIdSchema,
  phaseSequence: positiveIntegerSchema,
  previousReceiptDigest: sha256Schema.optional(),
  expectedStateRevision: z
    .union([gitCommitRevisionSchema, z.strictObject({ status: z.literal("missing") })])
    .optional(),
  receiptKind: z.enum(["executed", "observed", "not_required", "superseded"]),
  observedAt: observedAtSchema,
  effectOccurredAt: observedAtSchema.optional(),
  publicDiagnosticCode: z
    .enum(["action_failed", "effect_unconfirmed", "state_conflict", "superseded_by_newer_run"])
    .optional(),
  receiptDigest: sha256Schema,
  receiptId: receiptIdSchema,
};

const stateParentRevisionSchema = z.union([gitCommitRevisionSchema, z.literal("unborn")]);
const stateCommitResultSchema = z.strictObject({
  expectedTrackingStateRevision: stateParentRevisionSchema,
  actualParentStateRevision: stateParentRevisionSchema,
  resultingStateRevision: gitCommitRevisionSchema,
  stateContentDigest: sha256Schema,
  commitScope: z.enum(["tracking_run", "operations_alert", "manual_resolution"]),
  commitMetadataVersion: z.literal(1),
  commitOperationId: operationIdSchema,
  commitRunId: runIdSchema,
  changedPathManifestVersion: z.literal(1),
  changedPathManifestDigest: sha256Schema,
  interveningOperationsAlertCommits: z.array(gitCommitRevisionSchema),
});

const messageCommitAdvanceSchema = z.strictObject({
  expectedTrackingStateRevision: gitCommitRevisionSchema,
  actualParentStateRevision: gitCommitRevisionSchema,
  interveningOperationsAlertCommits: z.array(gitCommitRevisionSchema),
});

const pagesBuildResultSchema = z.strictObject({
  deploymentIntentDigest: sha256Schema,
  pagesContentDigest: sha256Schema,
  outputManifestDigest: sha256Schema,
  sourceStateRevision: gitCommitRevisionSchema,
});

const pagesDeploymentResultSchema = z.strictObject({
  deploymentIntentDigest: sha256Schema,
  pagesContentDigest: sha256Schema,
  sourceStateRevision: gitCommitRevisionSchema,
  pageUrl: pagesPublicUrlSchema,
  externalReference: pagesDeploymentExternalReferenceSchema,
  observedSourceReceiptDigest: sha256Schema.optional(),
  evidenceDigest: sha256Schema.optional(),
});

export const receiptSchema = z.discriminatedUnion("receiptType", [
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("initial_state_commit"),
    stage: z.literal("initial_state_committed"),
    phase: z.literal("initial"),
    status: z.literal("committed"),
    effectCertainty: z.literal("committed"),
    result: stateCommitResultSchema,
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("pages_build"),
    stage: z.enum(["initial_pages_prepared", "notification_history_pages_prepared"]),
    phase: z.enum(["initial", "notification_history"]),
    status: z.enum(["built", "not_required"]),
    effectCertainty: z.enum(["committed", "no_effect"]),
    notRequiredReason: z
      .enum(["notification_action_held", "notification_action_acknowledged", "no_sent_history"])
      .optional(),
    result: pagesBuildResultSchema.optional(),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("pages_deployment"),
    stage: z.enum(["initial_pages_published", "notification_history_pages_published"]),
    phase: z.enum(["initial", "notification_history"]),
    status: z.enum([
      "deployed",
      "replayed_same_content",
      "not_required",
      "superseded_by_newer_run",
      "ambiguous",
    ]),
    effectCertainty: z.enum(["committed", "no_effect", "ambiguous"]),
    result: pagesDeploymentResultSchema.optional(),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("notification_message"),
    stage: z.literal("notifications_settled"),
    phase: z.literal("notification"),
    status: z.enum(["sent", "no_effect", "ambiguous"]),
    effectCertainty: z.enum(["committed", "no_effect", "ambiguous"]),
    durableAttemptSequence: positiveIntegerSchema,
    result: z.strictObject({
      deliveryId: nonEmptyStringSchema,
      notificationKeys: z.array(nonEmptyStringSchema).min(1),
      discordMessageId: nonEmptyStringSchema.optional(),
      reservationStateRevision: gitCommitRevisionSchema,
      ledgerStateRevision: gitCommitRevisionSchema,
      reservationCommit: messageCommitAdvanceSchema,
      resultCommit: messageCommitAdvanceSchema.optional(),
    }),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("notification_settlement"),
    stage: z.literal("notifications_settled"),
    phase: z.literal("notification"),
    status: z.literal("settled"),
    effectCertainty: z.literal("committed"),
    result: stateCommitResultSchema.extend({
      notificationLedgerDigest: sha256Schema,
      notificationHistoryDigest: sha256Schema,
      action: z.enum(["send", "hold", "acknowledge-current"]),
    }),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("manual_resolution"),
    stage: z.literal("notifications_settled"),
    phase: z.literal("notification"),
    status: z.literal("resolved"),
    effectCertainty: z.literal("committed"),
    result: stateCommitResultSchema.extend({
      deliveryId: nonEmptyStringSchema,
      deliveryAttemptId: attemptIdSchema,
      notificationKeys: z.array(nonEmptyStringSchema).min(1),
      decision: z.enum(["retry", "acknowledge"]),
    }),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("operations_alert"),
    stage: z.literal("operations_alert"),
    phase: z.literal("operations_alert"),
    status: z.enum(["sent", "no_effect", "ambiguous"]),
    effectCertainty: z.enum(["committed", "no_effect", "ambiguous"]),
    result: z.strictObject({
      incidentId: nonEmptyStringSchema,
      discordMessageId: nonEmptyStringSchema.optional(),
      observedOperationsLedgerState: z
        .enum(["sent", "reserved", "absent", "unverified"])
        .optional(),
      operationsLedgerRevision: gitCommitRevisionSchema.optional(),
      operationsLedgerCommitMetadata: z
        .strictObject({
          commitMetadataVersion: z.literal(1),
          commitScope: z.literal("operations_alert"),
          commitOperationId: operationIdSchema,
          commitRunId: runIdSchema.optional(),
          changedPathManifestVersion: z.literal(1),
          changedPathManifestDigest: sha256Schema,
        })
        .optional(),
    }),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("run_finalization"),
    stage: z.literal("run_finalized"),
    phase: z.literal("finalization"),
    status: z.literal("finalized"),
    effectCertainty: z.literal("committed"),
    result: stateCommitResultSchema.extend({ runReportDigest: sha256Schema }),
  }),
  z.strictObject({
    ...receiptFields,
    receiptType: z.literal("completion"),
    stage: z.literal("completed"),
    phase: z.literal("completion"),
    status: z.literal("completed"),
    effectCertainty: z.literal("no_effect"),
    result: z.strictObject({ finalStateRevision: gitCommitRevisionSchema }),
  }),
]);

/** 公開効果の開始時点で存在する識別子だけを持つ結合。 */
export type ReceiptBinding = z.output<typeof receiptBindingSchema>;

/** Pagesの外部結果を公開可能な閉じた参照で表す。 */
export type PagesDeploymentExternalReference = z.output<
  typeof pagesDeploymentExternalReferenceSchema
>;

/** 各効果の結果を判別可能にしたreceipt。 */
export type Receipt = z.output<typeof receiptSchema>;

export type InitialStateCommitReceipt = Extract<Receipt, { receiptType: "initial_state_commit" }>;
export type PagesBuildReceipt = Extract<Receipt, { receiptType: "pages_build" }>;
export type PagesDeploymentReceipt = Extract<Receipt, { receiptType: "pages_deployment" }>;
export type NotificationMessageReceipt = Extract<Receipt, { receiptType: "notification_message" }>;
export type NotificationSettlementReceipt = Extract<
  Receipt,
  { receiptType: "notification_settlement" }
>;
export type ManualResolutionReceipt = Extract<Receipt, { receiptType: "manual_resolution" }>;
export type OperationsAlertReceipt = Extract<Receipt, { receiptType: "operations_alert" }>;
export type RunFinalizationReceipt = Extract<Receipt, { receiptType: "run_finalization" }>;
export type CompletionReceipt = Extract<Receipt, { receiptType: "completion" }>;

import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { trackingRunStageNames } from "./contracts/closed-values.js";
import { baseStateRevisionSchema } from "./contracts/run-core.js";
import { preCheckpointFailureStageSchema, type Receipt } from "./receipt-schema.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const publicIdentifierSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u);
const MAX_FAILURE_BYTES = 1024 * 1024;

export const runFailureStageSchema = z.enum([
  ...trackingRunStageNames,
  "prepare",
  "runtime_bootstrap",
  "runtime_selection",
  "runtime_launch",
  "workflow_effect_observation",
  "checkpoint_encoding",
  "checkpoint_binding",
]);

export const runFailureKindSchema = z.enum([
  "invalid_input",
  "schema_validation",
  "content_integrity",
  "state_conflict",
  "external_effect",
  "runtime_unavailable",
  "public_boundary",
  "workflow_infrastructure_failure",
  "diagnostics_encryption_failure",
  "superseded_by_newer_run",
  "unexpected",
]);

const observedFileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({ kind: z.literal("present"), fileDigest: sha256Schema }),
]);

export const failureEvidenceSchema = z.discriminatedUnion("bindingKind", [
  z.strictObject({ bindingKind: z.literal("invocation_pre_run_alert") }),
  z.strictObject({
    bindingKind: z.literal("state_bootstrap_alert"),
    observedStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
    observedMarkerFile: observedFileSchema,
    observedRecordFile: observedFileSchema,
  }),
  z.strictObject({
    bindingKind: z.literal("run_pre_checkpoint_alert"),
    runId: runIdSchema,
    baseStateRevision: baseStateRevisionSchema,
    configDigest: sha256Schema,
  }),
  z.strictObject({
    bindingKind: z.literal("checkpoint"),
    runId: runIdSchema,
    checkpointDigest: sha256Schema,
    checkpointFileDigest: sha256Schema,
    runtimeIdentityDigest: sha256Schema,
    baseStateRevision: baseStateRevisionSchema.optional(),
  }),
]);

const failedRunBaseSchema = z.strictObject({
  status: z.literal("failed"),
  invocationId: z.uuid(),
  runId: runIdSchema.optional(),
  failedStage: runFailureStageSchema,
  failedOperationEffectCertainty: z.enum(["no_effect", "committed", "ambiguous"]),
  evidence: failureEvidenceSchema,
  causedByFailureArtifactDigest: sha256Schema.optional(),
  checkpointDigest: sha256Schema.optional(),
  checkpointFileDigest: sha256Schema.optional(),
  lastKnownStateRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .optional(),
  finalStateRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .optional(),
  lastReceiptDigest: sha256Schema.optional(),
  completedPhaseSequence: z.number().int().positive().optional(),
  recoveryDisposition: z.enum([
    "safe_to_retry_same_input",
    "resume_from_receipt",
    "manual_resolution_required",
    "operator_conflict_resolution",
    "not_retryable",
  ]),
  publicDiagnostics: z.strictObject({
    code: z.enum([
      "invalid_input",
      "invalid_checkpoint",
      "invalid_record",
      "state_conflict",
      "external_effect_unconfirmed",
      "runtime_unavailable",
      "public_boundary",
      "workflow_infrastructure_failure",
      "unexpected_failure",
      "diagnostics_encryption_failure",
    ]),
    incidentId: publicIdentifierSchema.optional(),
    externalActionId: publicIdentifierSchema.optional(),
  }),
});

export const failedRunSchema = z.discriminatedUnion("failureKind", [
  failedRunBaseSchema.extend({
    failureKind: runFailureKindSchema.exclude(["diagnostics_encryption_failure"]),
    encryptedDiagnosticsRecordIds: z.array(publicIdentifierSchema).nonempty(),
  }),
  failedRunBaseSchema.extend({
    failureKind: z.literal("diagnostics_encryption_failure"),
    failedOperationEffectCertainty: z.literal("no_effect"),
    publicDiagnostics: z.strictObject({ code: z.literal("diagnostics_encryption_failure") }),
  }),
]);

export const publicFailureArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("tracking_run_failure"),
  failure: failedRunSchema,
  failureArtifactDigest: sha256Schema,
});

/** 失敗したoperationと先行効果を別々に持つrun結果。 */
export type FailedRun = z.output<typeof failedRunSchema>;

/** 公開できる分類と識別子だけを持つ失敗artifact。 */
export type PublicFailureArtifact = z.output<typeof publicFailureArtifactSchema>;

/** 暗号化診断への記録担当を区別する失敗。 */
export type FailureDiagnosticState =
  | Readonly<{ kind: "unrecorded"; error: unknown }>
  | Readonly<{ kind: "recorded"; error: unknown; recordIds: readonly [string, ...string[]] }>;

/** 失敗判定時に確認できたstate headとmarkerの状態。 */
export type FailureStateObservation =
  | Readonly<{ kind: "not_observed" }>
  | Readonly<{ kind: "observed_head"; revision: string }>
  | Readonly<{ kind: "same_head_no_marker"; revision: string }>
  | Readonly<{
      kind: "consistent_pending";
      revision: string;
      runId: string;
      checkpointDigest: string;
      markerPhase:
        | "initial_state_committed"
        | "notifications_in_progress"
        | "notifications_settled"
        | "run_finalized";
    }>
  | Readonly<{ kind: "conflict"; revision: string }>;

type WithoutDerivedFailureFields<T extends FailedRun> = T extends FailedRun
  ? Omit<
      T,
      | "status"
      | "recoveryDisposition"
      | "lastReceiptDigest"
      | "completedPhaseSequence"
      | "lastKnownStateRevision"
    >
  : never;

function assertFailedRunSemantics(value: FailedRun): void {
  if (
    (value.checkpointDigest == null) !== (value.checkpointFileDigest == null) ||
    (value.lastReceiptDigest == null) !== (value.completedPhaseSequence == null) ||
    (value.checkpointDigest != null && value.runId == null) ||
    (value.failedStage === "prepare" && (value.runId != null || value.checkpointDigest != null)) ||
    (value.evidence.bindingKind === "checkpoint" &&
      (value.runId !== value.evidence.runId ||
        value.checkpointDigest !== value.evidence.checkpointDigest ||
        value.checkpointFileDigest !== value.evidence.checkpointFileDigest)) ||
    (value.evidence.bindingKind === "run_pre_checkpoint_alert" &&
      (value.runId !== value.evidence.runId ||
        value.checkpointDigest != null ||
        !preCheckpointFailureStageSchema.safeParse(value.failedStage).success)) ||
    (value.evidence.bindingKind === "state_bootstrap_alert" &&
      (value.runId != null ||
        value.checkpointDigest != null ||
        value.failedStage !== "runtime_bootstrap" ||
        value.lastKnownStateRevision !== value.evidence.observedStateRevision)) ||
    (value.evidence.bindingKind === "invocation_pre_run_alert" && value.checkpointDigest != null) ||
    (value.finalStateRevision != null &&
      (value.evidence.bindingKind !== "checkpoint" ||
        (value.failedStage !== "notification_history_pages_prepared" &&
          value.failedStage !== "notification_history_pages_published" &&
          (value.failedStage !== "workflow_effect_observation" ||
            value.failureKind !== "diagnostics_encryption_failure")) ||
        (value.failureKind === "diagnostics_encryption_failure" &&
          value.lastReceiptDigest == null))) ||
    (value.recoveryDisposition === "safe_to_retry_same_input" &&
      value.failedOperationEffectCertainty !== "no_effect") ||
    (value.failedOperationEffectCertainty === "ambiguous" &&
      value.recoveryDisposition !== "manual_resolution_required" &&
      value.recoveryDisposition !== "operator_conflict_resolution") ||
    (value.failureKind !== "diagnostics_encryption_failure" &&
      value.publicDiagnostics.code === "diagnostics_encryption_failure")
  ) {
    throw new TypeError("失敗runの識別、確度、復旧種別が一致しません");
  }
}

/** failed operationだけの確度と先行receiptから復旧種別を決める。 */
export function deriveRecoveryDisposition(
  input: Readonly<{
    failureKind: FailedRun["failureKind"];
    failedOperationEffectCertainty: FailedRun["failedOperationEffectCertainty"];
    lastVerifiedReceipt: Receipt | undefined;
    stateObservation: FailureStateObservation;
  }>,
): FailedRun["recoveryDisposition"] {
  if (input.stateObservation.kind === "conflict" || input.failureKind === "state_conflict") {
    return "operator_conflict_resolution";
  }
  if (
    input.failureKind === "invalid_input" ||
    input.failureKind === "public_boundary" ||
    input.failureKind === "superseded_by_newer_run"
  ) {
    return "not_retryable";
  }
  if (
    input.failureKind === "runtime_unavailable" &&
    input.stateObservation.kind === "consistent_pending"
  ) {
    return "manual_resolution_required";
  }
  if (input.failedOperationEffectCertainty === "ambiguous") {
    return "manual_resolution_required";
  }
  if (input.failedOperationEffectCertainty === "committed") {
    return input.lastVerifiedReceipt != null && input.stateObservation.kind === "consistent_pending"
      ? "resume_from_receipt"
      : "manual_resolution_required";
  }
  if (input.lastVerifiedReceipt != null) {
    return input.stateObservation.kind === "consistent_pending"
      ? "resume_from_receipt"
      : "manual_resolution_required";
  }
  return input.stateObservation.kind === "consistent_pending"
    ? "manual_resolution_required"
    : "safe_to_retry_same_input";
}

/** 公開可能fieldだけから失敗runと復旧種別を確定する。 */
export function createFailedRun(
  input: WithoutDerivedFailureFields<FailedRun> &
    Readonly<{
      lastVerifiedReceipt: Receipt | undefined;
      stateObservation: FailureStateObservation;
    }>,
): FailedRun {
  const { lastVerifiedReceipt, stateObservation, ...fields } = input;
  if (
    stateObservation.kind === "consistent_pending" &&
    (fields.runId !== stateObservation.runId ||
      fields.checkpointDigest !== stateObservation.checkpointDigest)
  ) {
    throw new TypeError("失敗runと確認済みpending markerの識別が一致しません");
  }
  const value = failedRunSchema.parse({
    ...fields,
    status: "failed",
    ...(stateObservation.kind === "not_observed"
      ? {}
      : { lastKnownStateRevision: stateObservation.revision }),
    ...(lastVerifiedReceipt == null
      ? {}
      : {
          lastReceiptDigest: lastVerifiedReceipt.receiptDigest,
          completedPhaseSequence: lastVerifiedReceipt.phaseSequence,
        }),
    recoveryDisposition: deriveRecoveryDisposition({
      failureKind: fields.failureKind,
      failedOperationEffectCertainty: fields.failedOperationEffectCertainty,
      lastVerifiedReceipt,
      stateObservation,
    }),
  });
  assertFailedRunSemantics(value);
  if (lastVerifiedReceipt?.binding.bindingKind === "checkpoint") {
    if (
      value.runId !== lastVerifiedReceipt.binding.runId ||
      value.checkpointDigest !== lastVerifiedReceipt.binding.checkpointDigest ||
      value.checkpointFileDigest !== lastVerifiedReceipt.binding.checkpointFileDigest
    ) {
      throw new TypeError("失敗runと最後のreceiptの識別が一致しません");
    }
  }
  return value;
}

/** 診断本文を含めず公開失敗artifactを生成する。 */
export function createPublicFailureArtifact(
  failure: FailedRun,
  digest: ContentDigestPort,
): PublicFailureArtifact {
  const checkedFailure = failedRunSchema.parse(failure);
  assertFailedRunSemantics(checkedFailure);
  const payload = { schemaVersion: 1, kind: "tracking_run_failure", failure: checkedFailure };
  return publicFailureArtifactSchema.parse({
    ...payload,
    failureArtifactDigest: digest.sha256Utf8(serializeCanonicalJson(payload)),
  });
}

/** 公開失敗artifactのshapeとcanonical digestを照合する。 */
export function parsePublicFailureArtifact(
  value: unknown,
  digest: ContentDigestPort,
): PublicFailureArtifact {
  const artifact = publicFailureArtifactSchema.parse(value);
  const { failureArtifactDigest, ...payload } = artifact;
  if (digest.sha256Utf8(serializeCanonicalJson(payload)) !== failureArtifactDigest) {
    throw new TypeError("公開失敗artifactのdigestが一致しません");
  }
  assertFailedRunSemantics(artifact.failure);
  return artifact;
}

/** canonical JSONの公開失敗artifactを読む。 */
export function decodePublicFailureArtifact(
  bytes: Uint8Array,
  digest: ContentDigestPort,
): PublicFailureArtifact {
  if (bytes.length > MAX_FAILURE_BYTES) {
    throw new TypeError("公開失敗artifactが許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("公開失敗artifactがcanonical JSONではありません");
  }
  return parsePublicFailureArtifact(raw, digest);
}

import { z } from "zod";

import { parseSha256Hash } from "../../../canonical-json/sha256.js";
import { gitCommitRevisionSchema } from "./revision.js";
import { runtimeRecoveryPlanV1Schema } from "../recovery-bootstrap.js";

const sha256Schema = z.string().transform(parseSha256Hash);

export const runtimeRecoveryInputV1Schema = z.strictObject({
  protocolVersion: z.literal(1),
  inputContract: z.literal("tracking-run-recovery-input-v1"),
  invocationId: z.uuid(),
  stateRef: z.string().min(1),
  exactStateRevision: gitCommitRevisionSchema,
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  expectedRecordDigest: sha256Schema,
  expectedRuntimeIdentityDigest: sha256Schema,
  expectedWorkflowEffectAdapterIdentityDigest: sha256Schema,
  runtimeRecoveryPlan: runtimeRecoveryPlanV1Schema,
});

export const runtimeRecoveryOutputV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    protocolVersion: z.literal(1),
    outputContract: z.literal("tracking-run-recovery-output-v1"),
    status: z.literal("ready"),
    stateRevision: gitCommitRevisionSchema,
    nextStage: z.enum([
      "initial_pages_build",
      "initial_pages_deploy",
      "notifications",
      "run_finalization",
      "notification_history_build",
      "notification_history_deploy",
    ]),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    outputContract: z.literal("tracking-run-recovery-output-v1"),
    status: z.literal("manual_resolution_required"),
    reason: z.enum(["recovery_stage_unavailable", "state_conflict", "effect_uncertain"]),
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    outputContract: z.literal("tracking-run-recovery-output-v1"),
    status: z.literal("resumed"),
    stateRevision: gitCommitRevisionSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(1),
    outputContract: z.literal("tracking-run-recovery-output-v1"),
    status: z.literal("completed"),
    stateRevision: gitCommitRevisionSchema,
  }),
]);

export const workflowEffectObservationV1Schema = z.strictObject({
  observationContract: z.literal("tracking-run-workflow-effect-observation-v1"),
  operationId: z.string().min(1),
  attemptId: z.string().min(1),
  result: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("no_effect") }),
    z.strictObject({
      kind: z.literal("confirmed"),
      receiptDigest: sha256Schema,
      externalReferenceDigest: sha256Schema,
    }),
    z.strictObject({ kind: z.literal("ambiguous"), diagnosticCode: z.string().min(1) }),
  ]),
});

/** 旧bundleへ渡す固定の回復入力。 */
export type RuntimeRecoveryInputV1 = z.output<typeof runtimeRecoveryInputV1Schema>;

/** 旧bundleから受け取る固定の回復結果。 */
export type RuntimeRecoveryOutputV1 = z.output<typeof runtimeRecoveryOutputV1Schema>;

/** workflow効果の観測結果を表す固定契約。 */
export type WorkflowEffectObservationV1 = z.output<typeof workflowEffectObservationV1Schema>;

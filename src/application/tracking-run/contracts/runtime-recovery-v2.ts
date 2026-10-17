import { z } from "zod";

import { gitCommitRevisionSchema } from "./revision.js";
import { runtimeRecoveryPlanV2Schema } from "../recovery-bootstrap.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const baseSchema = z.strictObject({
  protocolVersion: z.literal(2),
  inputContract: z.literal("tracking-run-recovery-input-v2"),
  invocationId: z.uuid(),
  configPath: z.string().min(1),
  stateRef: z.string().min(1),
  exactStateRevision: gitCommitRevisionSchema,
  runId: runIdSchema,
  runAttempt: z.number().int().positive(),
  expectedRecordDigest: sha256Schema,
  expectedRuntimeIdentityDigest: sha256Schema,
  expectedWorkflowEffectAdapterIdentityDigest: sha256Schema,
  runtimeRecoveryPlan: runtimeRecoveryPlanV2Schema,
});

export const runtimeRecoveryStageV2Schema = z.enum([
  "prepare-initial-pages",
  "preflight-initial-pages-deployment",
  "settle-notifications",
  "finalize-run",
  "prepare-history-pages",
  "preflight-history-pages-deployment",
  "complete",
]);

export const workflowEffectObservationV2Schema = z.strictObject({
  observationContract: z.literal("tracking-run-workflow-effect-observation-v2"),
  adapterVersion: z.literal("tracking-run-pages-actions-v2"),
  adapterIdentityDigest: sha256Schema,
  phase: z.enum(["initial", "notification_history"]),
  deploymentIntentDigest: sha256Schema.optional(),
  uploadOutcome: z.enum(["success", "failure", "skipped"]),
  deploymentOutcome: z.enum(["success", "failure", "skipped"]),
  artifactName: z.string().min(1),
  artifactId: z.string().min(1).optional(),
  artifactDigest: sha256Schema.optional(),
  deploymentId: z.string().min(1).optional(),
  pageUrl: z.url().optional(),
});

export const runtimeRecoveryInputV2Schema = z.discriminatedUnion("operation", [
  baseSchema.extend({ operation: z.literal("inspect") }),
  baseSchema.extend({
    operation: z.literal("resolve_manual_delivery"),
    target: z.strictObject({
      checkpointDigest: sha256Schema,
      deliveryId: z.string().regex(/^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u),
      attemptId: z.string().regex(/^attempt:v1:[0-9a-f]{64}$/u),
      notificationKeys: z.array(z.string().min(1)).min(1),
      decision: z.enum(["retry", "acknowledge"]),
    }),
  }),
  baseSchema.extend({
    operation: z.literal("execute_stage"),
    stage: runtimeRecoveryStageV2Schema,
    manualResolutionReceiptPath: z.string().min(1).optional(),
  }),
  baseSchema.extend({
    operation: z.literal("record_pages"),
    observation: workflowEffectObservationV2Schema,
  }),
]);

const outputBaseSchema = z.strictObject({
  protocolVersion: z.literal(2),
  outputContract: z.literal("tracking-run-recovery-output-v2"),
  runId: runIdSchema,
  stateRevision: gitCommitRevisionSchema,
  receiptChainDigest: sha256Schema,
  workflowEffectAdapterIdentityDigest: sha256Schema,
});

export const runtimeRecoveryOutputV2Schema = z.discriminatedUnion("status", [
  outputBaseSchema.extend({
    status: z.literal("inspected"),
    nextStage: z.enum([
      "prepare-initial-pages",
      "preflight-initial-pages-deployment",
      "settle-notifications",
      "finalize-run",
      "prepare-history-pages",
      "preflight-history-pages-deployment",
      "complete",
      "done",
    ]),
  }),
  outputBaseSchema.extend({
    status: z.literal("executed"),
    stage: runtimeRecoveryStageV2Schema,
  }),
  outputBaseSchema.extend({
    status: z.literal("pages_recorded"),
    phase: z.enum(["initial", "notification_history"]),
  }),
  outputBaseSchema.extend({
    status: z.literal("manual_resolved"),
    decision: z.enum(["retry", "acknowledge"]),
    manualResolutionReceiptDigest: sha256Schema,
    receiptKind: z.enum(["executed", "observed"]),
  }),
]);

/** V2固定入口へ渡すexact runの段階要求。 */
export type RuntimeRecoveryInputV2 = z.output<typeof runtimeRecoveryInputV2Schema>;

/** V2固定入口から受け取る段階とreceiptの結果。 */
export type RuntimeRecoveryOutputV2 = z.output<typeof runtimeRecoveryOutputV2Schema>;

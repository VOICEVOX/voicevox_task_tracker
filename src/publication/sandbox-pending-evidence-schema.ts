import { z } from "zod";
import {
  trackingRunStageNames,
  trackingRunStageSchema,
} from "../application/tracking-run/contracts/closed-values.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/** ambiguous初回のremote停止証拠を検証する。 */
export const sandboxPendingNotificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarioId: z.enum(["ambiguous-retry", "ambiguous-acknowledge"]),
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  stateRef: z.string().regex(/^sandbox-state\/env-[1-9][0-9]*-[1-9][0-9]*$/u),
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  trackingRunId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  checkpointDigest: digestSchema,
  checkpointFileDigest: digestSchema,
  baseStateRevision: revisionSchema,
  pendingStateRevision: revisionSchema,
  codeRevision: revisionSchema,
  recordDigest: digestSchema,
  markerDigest: digestSchema,
  ledgerDigest: digestSchema,
  deliveryId: z.string().regex(/^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u),
  attemptId: z.string().regex(/^attempt:v1:[0-9a-f]{64}$/u),
  deliveryOperationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
  notificationKeys: z.array(z.string().min(1)).min(1),
  selectedCandidateCount: z.number().int().positive(),
  recordingOutcome: z.literal("recorded_ambiguous"),
  originalOperationReservationCommitCount: z.literal(1),
  initialReceiptChainDigest: digestSchema,
  initialPagesReceiptDigest: digestSchema,
  analysisStageRecordDigest: digestSchema,
  markerPhase: z.literal("notifications_in_progress"),
  stages: z
    .array(z.strictObject({ stage: trackingRunStageSchema, executed: z.boolean() }))
    .length(trackingRunStageNames.length),
  unexecutedStages: z.array(trackingRunStageSchema),
  settled: z.literal(false),
  finalized: z.literal(false),
  newRunStarted: z.literal(false),
  productionPagesDeployed: z.literal(false),
  productionDiscordSent: z.literal(false),
});

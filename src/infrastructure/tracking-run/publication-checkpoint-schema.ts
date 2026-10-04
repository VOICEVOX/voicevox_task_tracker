import { z } from "zod";
import {
  analysisRunStageNames,
  analysisRunStageSchema,
} from "../../application/tracking-run/contracts/closed-values.js";

import { baseStateRevisionSchema } from "../../application/tracking-run/contracts/run-core.js";
import { runtimeIdentitySchema } from "../../application/tracking-run/contracts/runtime-identity.js";
import {
  runExecutionPolicySchema,
  runIdentitySchema,
} from "../../application/tracking-run/request.js";
import { parseSha256Hash } from "../../canonical-json/sha256.js";
import { validatedRunPayloadSchema } from "./validated-run-payload.js";

const sha256Schema = z.string().transform(parseSha256Hash);
const initialStateValueDigestsSchema = z.strictObject({
  snapshot: sha256Schema,
  historyInputEvents: sha256Schema,
  initialStateWriteManifest: sha256Schema,
  aiCacheAdditions: sha256Schema,
  personalReminderAiCacheAdditions: sha256Schema,
  notificationLedger: sha256Schema,
});

export const checkpointSnapshotReferenceSchema = z.strictObject({
  kind: z.literal("validated_snapshot"),
  digest: sha256Schema,
});

export const publicationPlanPayloadSchema = z.strictObject({
  initialStateWriteSet: z.strictObject({
    snapshot: checkpointSnapshotReferenceSchema,
    historyInputEvents: z.array(z.unknown()),
    aiCacheAdditions: z.array(z.unknown()),
    personalReminderAiCacheAdditions: z.array(z.unknown()),
    notificationLedger: z.unknown(),
    paths: z.unknown(),
    previousInitialPagesEvidence: z.unknown(),
    deletions: z.array(z.string()),
    valueDigests: initialStateValueDigestsSchema,
    markerTemplate: z.unknown(),
    durableRecordTemplate: z.unknown(),
  }),
  initialPagesProjection: z.unknown(),
  notificationOutbox: z.unknown(),
  runFinalizationPolicy: z.unknown(),
  notificationHistoryPagesPolicy: z.unknown(),
  durableRecordTemplate: z.unknown(),
  preview: z.unknown(),
});

export const publicationCheckpointSchema = z
  .strictObject({
    runIdentity: runIdentitySchema,
    executionPolicy: runExecutionPolicySchema,
    baseStateRevision: baseStateRevisionSchema,
    configDigest: sha256Schema,
    analysisCompletedStages: z.array(analysisRunStageSchema).optional(),
    validatedPayload: validatedRunPayloadSchema,
    publicationPlan: publicationPlanPayloadSchema,
  })
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.publicationPlan.initialStateWriteSet.snapshot.digest !==
      checkpoint.publicationPlan.initialStateWriteSet.valueDigests.snapshot
    ) {
      context.addIssue({
        code: "custom",
        path: ["publicationPlan", "initialStateWriteSet", "snapshot"],
        message: "初回write setのsnapshot参照digestが一致しません",
      });
    }
    if (
      checkpoint.executionPolicy.executionShape === "split_workflow" &&
      (checkpoint.analysisCompletedStages?.length !== analysisRunStageNames.length ||
        checkpoint.analysisCompletedStages.some(
          (stage, index) => stage !== analysisRunStageNames[index],
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["analysisCompletedStages"],
        message: "解析段階の実行記録がcanonical順序と一致しません",
      });
    }
    if (
      checkpoint.executionPolicy.executionShape !== "split_workflow" &&
      checkpoint.analysisCompletedStages != null
    ) {
      context.addIssue({
        code: "custom",
        path: ["analysisCompletedStages"],
        message: "直列checkpointへ分割workflowの解析記録を保存できません",
      });
    }
  });

export const publicationArtifactLogicalSchema = z.strictObject({
  schemaVersion: z.literal(23),
  kind: z.literal("publication_planned_tracking_run"),
  runtimeIdentity: runtimeIdentitySchema,
  runIdentity: runIdentitySchema,
  executionPolicy: runExecutionPolicySchema,
  baseStateRevision: baseStateRevisionSchema,
  configDigest: sha256Schema,
  analysisCompletedStages: z.array(analysisRunStageSchema).optional(),
  validatedPayload: z.unknown(),
  publicationPlan: z.unknown(),
  frames: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      uncompressedByteLength: z.number().int().positive(),
      contentDigest: sha256Schema,
    }),
  ),
});

export const publicationArtifactSchema = z.strictObject({
  logical: publicationArtifactLogicalSchema,
  checkpointDigest: sha256Schema,
  compressedByteLengths: z.array(z.number().int().positive()),
});

export const publicationArtifactSidecarSchema = z.strictObject({
  artifactFileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+\.cpk$/u),
  byteLength: z.number().int().nonnegative(),
  checkpointFileDigest: sha256Schema,
});

/** v23 checkpointの公開保存値。 */
export type PublicationCheckpoint = z.output<typeof publicationCheckpointSchema>;

/** v23 artifactのmanifest。 */
export type PublicationArtifact = z.output<typeof publicationArtifactSchema>;

/** artifact bytesを別に照合するsidecar。 */
export type PublicationArtifactSidecar = z.output<typeof publicationArtifactSidecarSchema>;

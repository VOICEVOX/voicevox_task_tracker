import { z } from "zod";

import {
  parsePagesDeploymentIntent,
  pagesDeploymentIntentSchema,
} from "../../application/tracking-run/pages-build-contracts.js";
import { pagesPublicUrlSchema } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort } from "./content-digest.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const keySchema = z.string().regex(/^[0-9a-f]{64}$/u);
const actionsRunIdSchema = z.string().regex(/^[1-9][0-9]*$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const ownerSchema = z.strictObject({
  parentRunId: actionsRunIdSchema,
  parentRunAttempt: z.number().int().positive(),
  codeRevision: revisionSchema,
});
const payloadSchema = z.strictObject({
  schemaVersion: z.literal(2),
  idempotencyKey: keySchema,
  attemptKey: keySchema,
  attemptSequence: z.number().int().positive(),
  owner: ownerSchema,
  intent: pagesDeploymentIntentSchema,
});
const observationSchema = z.strictObject({
  schemaVersion: z.literal(2),
  idempotencyKey: keySchema,
  attemptKey: keySchema,
  attemptSequence: z.number().int().positive(),
  parentRunId: actionsRunIdSchema,
  parentRunAttempt: z.number().int().positive(),
  childRunId: actionsRunIdSchema,
  childRunAttempt: z.number().int().positive(),
  codeRevision: revisionSchema,
  phase: z.enum(["initial", "notification_history"]),
  sourceStateRevision: revisionSchema,
  deploymentIntentDigest: sha256Schema,
  uploadOutcome: z.enum(["success", "failure", "skipped"]),
  deploymentOutcome: z.enum(["success", "failure", "skipped"]),
  artifactName: z.string().min(1),
  artifactId: z.string().min(1).optional(),
  artifactDigest: sha256Schema.optional(),
  deploymentId: z.string().min(1).optional(),
  pageUrl: pagesPublicUrlSchema.optional(),
});

/** Pages効果専用childへ渡す固定context。 */
export type SequentialPagesActionsPayload = z.output<typeof payloadSchema>;
/** Pages actionの実結果を親へ返す固定観測。 */
export type SequentialPagesActionsObservation = z.output<typeof observationSchema>;

/** dispatch contextをdigestとintentへ照合する。 */
export function parseSequentialPagesActionsPayload(value: unknown): SequentialPagesActionsPayload {
  const payload = payloadSchema.parse(value);
  const intent = parsePagesDeploymentIntent(payload.intent, nodeContentDigestPort);
  const key = nodeContentDigestPort
    .sha256Utf8(
      serializeCanonicalJsonLine({
        runId: intent.runId,
        phase: intent.phase,
        deploymentIntentDigest: intent.deploymentIntentDigest,
      }),
    )
    .slice("sha256:".length);
  const attemptKey = nodeContentDigestPort
    .sha256Utf8(
      serializeCanonicalJsonLine({
        operationKey: key,
        sequence: payload.attemptSequence,
      }),
    )
    .slice("sha256:".length);
  if (key !== payload.idempotencyKey || attemptKey !== payload.attemptKey) {
    throw new TypeError("Pages childのidempotency keyがintentと一致しません");
  }
  return Object.freeze({ ...payload, intent });
}

/** childの実観測をdispatch時の固定contextと照合する。 */
export function parseSequentialPagesActionsObservation(
  value: unknown,
  payload: SequentialPagesActionsPayload,
  childRunId: string,
  childRunAttempt: number,
): SequentialPagesActionsObservation {
  const observation = observationSchema.parse(value);
  if (
    observation.idempotencyKey !== payload.idempotencyKey ||
    observation.attemptKey !== payload.attemptKey ||
    observation.attemptSequence !== payload.attemptSequence ||
    observation.parentRunId !== payload.owner.parentRunId ||
    observation.parentRunAttempt !== payload.owner.parentRunAttempt ||
    observation.childRunId !== childRunId ||
    observation.childRunAttempt !== childRunAttempt ||
    observation.codeRevision !== payload.owner.codeRevision ||
    observation.phase !== payload.intent.phase ||
    observation.sourceStateRevision !== payload.intent.sourceStateRevision ||
    observation.deploymentIntentDigest !== payload.intent.deploymentIntentDigest ||
    (observation.artifactDigest != null && observation.artifactId == null)
  ) {
    throw new TypeError("Pages child観測と固定contextが一致しません");
  }
  return observation;
}

/** Actions run名へ使う固定keyを返す。 */
export function sequentialPagesChildName(attemptKey: string): string {
  return `tracking-sequential-pages-${keySchema.parse(attemptKey)}`;
}

/** 一つのchild観測artifact名を返す。 */
export function sequentialPagesChildArtifactName(attemptKey: string): string {
  return `${sequentialPagesChildName(attemptKey)}-observation`;
}

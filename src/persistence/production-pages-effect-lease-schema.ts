import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const keySchema = z.string().regex(/^[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const actionsRunIdSchema = z.string().regex(/^[1-9][0-9]*$/u);
const childSchema = z.strictObject({
  childRunId: actionsRunIdSchema,
  childRunAttempt: z.number().int().positive(),
});
const dispatchedSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  searchUntil: z.iso.datetime(),
});
const attemptIdentity = {
  sequence: z.number().int().positive(),
  key: keySchema,
};
const attemptSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...attemptIdentity, status: z.literal("reserved") }),
  z.strictObject({
    ...attemptIdentity,
    status: z.literal("dispatch_started"),
    dispatch: dispatchedSchema,
  }),
  z.strictObject({
    ...attemptIdentity,
    status: z.literal("child_bound"),
    dispatch: dispatchedSchema,
    child: childSchema,
  }),
  z.strictObject({
    ...attemptIdentity,
    status: z.literal("effect_started"),
    dispatch: dispatchedSchema,
    child: childSchema,
  }),
  z.strictObject({
    ...attemptIdentity,
    status: z.literal("committed"),
    dispatch: dispatchedSchema,
    child: childSchema,
  }),
  z.strictObject({
    ...attemptIdentity,
    status: z.literal("no_effect"),
    dispatch: dispatchedSchema,
    child: childSchema,
  }),
  z.strictObject({
    ...attemptIdentity,
    status: z.literal("unknown"),
    dispatch: dispatchedSchema.optional(),
    child: childSchema.optional(),
  }),
]);
const effectSchema = z.strictObject({
  phase: z.enum(["initial", "notification_history"]),
  sourceStateRevision: revisionSchema,
  deploymentIntentDigest: sha256Schema,
  idempotencyKey: keySchema,
});
const leaseFields = {
  status: z.enum(["active", "released"]),
  runId: runIdSchema,
  checkpointDigest: sha256Schema,
  parentRunId: actionsRunIdSchema,
  parentRunAttempt: z.number().int().positive(),
  codeRevision: revisionSchema,
};
export const productionPagesEffectLeaseSchema = z.strictObject({
  ...leaseFields,
  schemaVersion: z.literal(2),
  effect: effectSchema,
  attempt: attemptSchema,
});
const legacyLeaseSchema = z.strictObject({
  ...leaseFields,
  schemaVersion: z.literal(1),
  effect: effectSchema.extend({
    childRunId: actionsRunIdSchema.optional(),
    childRunAttempt: z.number().int().positive().optional(),
  }),
});

/** production Pages childが排他的に所有する効果の記録。 */
export type ProductionPagesEffectLease = z.output<typeof productionPagesEffectLeaseSchema>;

/** operationとdurable sequenceからattempt識別子を作る。 */
export function productionPagesAttemptKey(operationKey: string, sequence: number): string {
  return nodeContentDigestPort
    .sha256Utf8(serializeCanonicalJsonLine({ operationKey, sequence }))
    .slice("sha256:".length);
}

/** canonical lease fileを検証して読む。 */
export function parseProductionPagesEffectLease(bytes: Uint8Array): ProductionPagesEffectLease {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bytes.byteLength > 4096) {
    throw new TypeError("production Pages leaseが上限を超えています");
  }
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("production Pages leaseがcanonical JSONではありません");
  }
  const parsed = z.union([productionPagesEffectLeaseSchema, legacyLeaseSchema]).parse(raw);
  let lease: ProductionPagesEffectLease;
  if (parsed.schemaVersion === 1) {
    const { childRunId, childRunAttempt, ...effect } = parsed.effect;
    if ((childRunId == null) !== (childRunAttempt == null)) {
      throw new TypeError("production Pages leaseのchild識別子が不正です");
    }
    lease = productionPagesEffectLeaseSchema.parse({
      ...parsed,
      schemaVersion: 2,
      effect,
      attempt: {
        sequence: 1,
        key: productionPagesAttemptKey(effect.idempotencyKey, 1),
        status: "unknown",
        ...(childRunId == null ? {} : { child: { childRunId, childRunAttempt } }),
      },
    });
  } else {
    lease = parsed;
  }
  if (
    lease.effect.idempotencyKey !==
      nodeContentDigestPort
        .sha256Utf8(
          serializeCanonicalJsonLine({
            runId: lease.runId,
            phase: lease.effect.phase,
            deploymentIntentDigest: lease.effect.deploymentIntentDigest,
          }),
        )
        .slice("sha256:".length) ||
    lease.attempt.key !==
      productionPagesAttemptKey(lease.effect.idempotencyKey, lease.attempt.sequence)
  ) {
    throw new TypeError("production Pages leaseの効果識別子が不正です");
  }
  return lease;
}

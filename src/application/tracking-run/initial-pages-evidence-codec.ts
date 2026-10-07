import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { pagesDeploymentExternalReferenceSchema, pagesPublicUrlSchema } from "./receipt-schema.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION = 1;

export const initialPagesPublicationEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION),
  runId: runIdSchema,
  checkpointDigest: sha256Schema,
  sourceStateRevision: revisionSchema,
  deploymentOperationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
  deploymentReceiptDigest: sha256Schema,
  deploymentIntentDigest: sha256Schema,
  pagesContentDigest: sha256Schema,
  pageUrl: pagesPublicUrlSchema,
  effectCertainty: z.literal("committed"),
  externalReference: pagesDeploymentExternalReferenceSchema,
  observedAt: z.iso.datetime({ offset: true }),
  effectOccurredAt: z.iso.datetime({ offset: true }).optional(),
  evidenceDigest: sha256Schema,
});

/** 初回Pagesの成功をstateへ保存する公開証拠。 */
export type InitialPagesPublicationEvidence = z.output<
  typeof initialPagesPublicationEvidenceSchema
>;

export const initialPagesEvidenceStateSchema = z.strictObject({
  exactStateRevision: revisionSchema,
  marker: z.strictObject({
    runId: runIdSchema,
    checkpointDigest: sha256Schema,
    phase: z.enum(["notifications_in_progress", "notifications_settled", "run_finalized"]),
    initialPagesPublicationEvidenceDigest: sha256Schema,
    initialStateRevision: revisionSchema,
  }),
  evidence: initialPagesPublicationEvidenceSchema,
});

/** 同じexact revisionで読んだmarkerとevidenceの対応。 */
export type InitialPagesEvidenceState = z.output<typeof initialPagesEvidenceStateSchema>;

/** 保存証拠のshapeとcanonical digestを検証する。 */
export function parseInitialPagesPublicationEvidence(
  value: unknown,
  digest: ContentDigestPort,
): InitialPagesPublicationEvidence {
  const evidence = initialPagesPublicationEvidenceSchema.parse(value);
  const { evidenceDigest, ...payload } = evidence;
  if (digest.sha256Utf8(serializeCanonicalJson(payload)) !== evidenceDigest) {
    throw new TypeError("初回Pages保存証拠のdigestが一致しません");
  }
  return evidence;
}

/** canonical JSONで保存した初回Pages証拠を読む。 */
export function decodeInitialPagesPublicationEvidence(
  bytes: Uint8Array,
  digest: ContentDigestPort,
): InitialPagesPublicationEvidence {
  if (bytes.length > MAX_EVIDENCE_BYTES) {
    throw new TypeError("初回Pages証拠が許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("初回Pages証拠がcanonical JSONではありません");
  }
  return parseInitialPagesPublicationEvidence(raw, digest);
}

/** 初回Pages証拠をcanonical JSONで保存する。 */
export function serializeInitialPagesPublicationEvidence(
  evidence: InitialPagesPublicationEvidence,
  digest: ContentDigestPort,
): string {
  return serializeCanonicalJsonLine(parseInitialPagesPublicationEvidence(evidence, digest));
}

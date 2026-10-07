import { z } from "zod";

import {
  digestPagesContentManifest,
  pagesContentManifestSchema,
  pagesDeploymentIntentSchema,
  parsePagesDeploymentIntent,
} from "../../application/tracking-run/pages-build-contracts.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import { receiptSchema } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const reasonSchema = z.enum([
  "notification_action_held",
  "notification_action_acknowledged",
  "no_sent_history",
]);
const artifactSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal("built"),
    sourceStateRevision: revisionSchema,
    manifest: pagesContentManifestSchema,
    intent: pagesDeploymentIntentSchema,
    receipt: receiptSchema.options[1],
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal("not_required"),
    sourceStateRevision: revisionSchema,
    reason: reasonSchema,
    receipt: receiptSchema.options[1],
  }),
]);
const MAX_NOTIFICATION_HISTORY_BUILD_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** 通知履歴Pagesのbuiltと不要を判別できるcanonical artifact。 */
export type NotificationHistoryPagesBuildArtifact = z.output<typeof artifactSchema>;

/** build artifactのreceipt、final revision、全file manifestとintentを照合する。 */
export function parseNotificationHistoryPagesBuildArtifact(
  value: unknown,
): NotificationHistoryPagesBuildArtifact {
  const artifact = artifactSchema.parse(value);
  const receipt = parseReceipt(artifact.receipt, digest);
  if (
    receipt.receiptType !== "pages_build" ||
    receipt.phase !== "notification_history" ||
    receipt.stage !== "notification_history_pages_prepared" ||
    receipt.expectedStateRevision !== artifact.sourceStateRevision ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.previousReceiptDigest == null
  ) {
    throw new TypeError("通知履歴Pages build artifactのreceiptが一致しません");
  }
  if (artifact.status === "not_required") {
    if (
      receipt.status !== "not_required" ||
      receipt.receiptKind !== "not_required" ||
      receipt.effectCertainty !== "no_effect" ||
      receipt.notRequiredReason !== artifact.reason ||
      receipt.logicalTarget !== artifact.sourceStateRevision
    ) {
      throw new TypeError("通知履歴Pagesの不要理由とreceiptが一致しません");
    }
    return Object.freeze({ ...artifact, receipt });
  }
  const manifest = digestPagesContentManifest(artifact.manifest, digest);
  const intent = parsePagesDeploymentIntent(artifact.intent, digest);
  if (
    intent.phase !== "notification_history" ||
    intent.sourceStateRevision !== artifact.sourceStateRevision ||
    intent.runId !== receipt.binding.runId ||
    intent.checkpointDigest !== receipt.binding.checkpointDigest ||
    intent.outputManifestDigest !== manifest.outputManifestDigest ||
    intent.pagesContentDigest !== manifest.pagesContentDigest ||
    receipt.status !== "built" ||
    receipt.receiptKind !== "executed" ||
    receipt.logicalTarget !== intent.deploymentIntentDigest ||
    receipt.result?.deploymentIntentDigest !== intent.deploymentIntentDigest ||
    receipt.result.pagesContentDigest !== intent.pagesContentDigest ||
    receipt.result.outputManifestDigest !== intent.outputManifestDigest ||
    receipt.result.sourceStateRevision !== intent.sourceStateRevision
  ) {
    throw new TypeError("通知履歴Pages build artifactのmanifest、intent、receiptが一致しません");
  }
  return Object.freeze({ ...artifact, manifest: manifest.manifest, intent, receipt });
}

/** canonical JSONの通知履歴Pages build artifactを読む。 */
export function decodeNotificationHistoryPagesBuildArtifact(
  bytes: Uint8Array,
): NotificationHistoryPagesBuildArtifact {
  if (bytes.byteLength > MAX_NOTIFICATION_HISTORY_BUILD_ARTIFACT_BYTES) {
    throw new TypeError("通知履歴Pages build artifactが許容byte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("通知履歴Pages build artifactがcanonical JSONではありません");
  }
  return parseNotificationHistoryPagesBuildArtifact(raw);
}

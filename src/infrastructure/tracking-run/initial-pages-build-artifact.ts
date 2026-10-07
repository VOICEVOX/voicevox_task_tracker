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

const initialPagesBuildArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifest: pagesContentManifestSchema,
  intent: pagesDeploymentIntentSchema,
  receipt: receiptSchema.options[1],
});
const MAX_INITIAL_PAGES_BUILD_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** 初回Pagesの全file manifest、deploy指示、build receiptを運ぶartifact。 */
export type InitialPagesBuildArtifact = z.output<typeof initialPagesBuildArtifactSchema>;

/** Pages build artifactのschemaと三者のdigest、run、revisionを照合する。 */
export function parseInitialPagesBuildArtifact(value: unknown): InitialPagesBuildArtifact {
  const artifact = initialPagesBuildArtifactSchema.parse(value);
  const manifest = digestPagesContentManifest(artifact.manifest, digest);
  const intent = parsePagesDeploymentIntent(artifact.intent, digest);
  const receipt = parseReceipt(artifact.receipt, digest);
  if (
    receipt.receiptType !== "pages_build" ||
    receipt.phase !== "initial" ||
    intent.phase !== "initial" ||
    receipt.status !== "built" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== intent.runId ||
    receipt.binding.checkpointDigest !== intent.checkpointDigest ||
    receipt.expectedStateRevision !== intent.sourceStateRevision ||
    receipt.result?.sourceStateRevision !== intent.sourceStateRevision ||
    receipt.result.pagesContentDigest !== intent.pagesContentDigest ||
    receipt.result.outputManifestDigest !== intent.outputManifestDigest ||
    receipt.result.deploymentIntentDigest !== intent.deploymentIntentDigest ||
    manifest.pagesContentDigest !== intent.pagesContentDigest ||
    manifest.outputManifestDigest !== intent.outputManifestDigest
  ) {
    throw new TypeError("初回Pages build artifactのmanifest、intent、receiptが一致しません");
  }
  return Object.freeze({ schemaVersion: 1, manifest: manifest.manifest, intent, receipt });
}

/** canonical JSONのPages build artifactを読む。 */
export function decodeInitialPagesBuildArtifact(bytes: Uint8Array): InitialPagesBuildArtifact {
  if (bytes.byteLength > MAX_INITIAL_PAGES_BUILD_ARTIFACT_BYTES) {
    throw new TypeError("初回Pages build artifactが許容byte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("初回Pages build artifactがcanonical JSONではありません");
  }
  return parseInitialPagesBuildArtifact(raw);
}

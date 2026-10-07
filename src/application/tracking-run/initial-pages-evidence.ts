import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { InitialPagesPublicationEvidence } from "./initial-pages-evidence-codec.js";
import {
  INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION,
  parseInitialPagesPublicationEvidence,
} from "./initial-pages-evidence-codec.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { parseReceipt } from "./receipt-codec.js";
import { type PagesBuildReceipt, type PagesDeploymentReceipt } from "./receipt-schema.js";

/** build、deploy、intentの一致から初回Pages保存証拠を作る。 */
export function createInitialPagesPublicationEvidence(
  input: Readonly<{
    buildReceipt: PagesBuildReceipt;
    deploymentReceipt: PagesDeploymentReceipt;
    sourceStateRevision: string;
  }>,
  digest: ContentDigestPort,
): InitialPagesPublicationEvidence {
  const build = parseReceipt(input.buildReceipt, digest);
  const deployment = parseReceipt(input.deploymentReceipt, digest);
  if (
    build.receiptType !== "pages_build" ||
    build.phase !== "initial" ||
    build.status !== "built" ||
    build.receiptKind !== "executed" ||
    build.result == null ||
    deployment.receiptType !== "pages_deployment" ||
    deployment.phase !== "initial" ||
    (deployment.status !== "deployed" && deployment.status !== "replayed_same_content") ||
    deployment.receiptKind !== "executed" ||
    deployment.result == null ||
    deployment.binding.bindingKind !== "checkpoint" ||
    build.binding.bindingKind !== "checkpoint" ||
    serializeCanonicalJson(build.binding) !== serializeCanonicalJson(deployment.binding) ||
    deployment.previousReceiptDigest !== build.receiptDigest ||
    deployment.phaseSequence !== build.phaseSequence + 1 ||
    build.result.sourceStateRevision !== input.sourceStateRevision ||
    deployment.result.sourceStateRevision !== input.sourceStateRevision ||
    build.result.pagesContentDigest !== deployment.result.pagesContentDigest ||
    build.result.deploymentIntentDigest !== deployment.result.deploymentIntentDigest ||
    deployment.logicalTarget !== deployment.result.deploymentIntentDigest
  ) {
    throw new TypeError("初回Pagesのbuild、intent、deployment receiptが一致しません");
  }
  const payload = {
    schemaVersion: INITIAL_PAGES_PUBLICATION_EVIDENCE_SCHEMA_VERSION,
    runId: deployment.binding.runId,
    checkpointDigest: deployment.binding.checkpointDigest,
    sourceStateRevision: input.sourceStateRevision,
    deploymentOperationId: deployment.operationId,
    deploymentReceiptDigest: deployment.receiptDigest,
    deploymentIntentDigest: deployment.result.deploymentIntentDigest,
    pagesContentDigest: deployment.result.pagesContentDigest,
    pageUrl: deployment.result.pageUrl,
    effectCertainty: "committed",
    externalReference: deployment.result.externalReference,
    observedAt: deployment.observedAt,
    ...(deployment.effectOccurredAt == null
      ? {}
      : { effectOccurredAt: deployment.effectOccurredAt }),
  };
  return parseInitialPagesPublicationEvidence(
    { ...payload, evidenceDigest: digest.sha256Utf8(serializeCanonicalJson(payload)) },
    digest,
  );
}

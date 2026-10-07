import {
  parseInitialPagesPublicationEvidence,
  type InitialPagesEvidenceState,
} from "./initial-pages-evidence-codec.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { sealObservedReceipt } from "./receipt-core-codec.js";
import type { PagesDeploymentReceipt } from "./receipt-schema.js";

export {
  createReceipt,
  decodeReceipt,
  encodeReceipt,
  parseReceipt,
  receiptIdentifiers,
  sealObservedReceipt,
  type ReceiptDraft,
} from "./receipt-core-codec.js";

/** exact stateに保存済みの証拠だけから新しい観測試行を作る。 */
export function observeInitialPagesDeployment(
  input: Readonly<{
    state: InitialPagesEvidenceState;
    binding: Extract<PagesDeploymentReceipt["binding"], { bindingKind: "checkpoint" }>;
    invocationId: string;
    localAttemptIndex: number;
    phaseSequence: number;
    previousReceiptDigest: string;
    observedAt: string;
  }>,
  digest: ContentDigestPort,
): PagesDeploymentReceipt {
  const evidence = parseInitialPagesPublicationEvidence(input.state.evidence, digest);
  if (
    input.state.marker.initialPagesPublicationEvidenceDigest !== evidence.evidenceDigest ||
    input.state.marker.runId !== evidence.runId ||
    input.state.marker.checkpointDigest !== evidence.checkpointDigest ||
    input.state.marker.initialStateRevision !== evidence.sourceStateRevision ||
    input.binding.runId !== evidence.runId ||
    input.binding.checkpointDigest !== evidence.checkpointDigest
  ) {
    throw new TypeError("exact stateのmarkerと初回Pages証拠が一致しません");
  }
  const observed = sealObservedReceipt(
    {
      schemaVersion: 1,
      receiptType: "pages_deployment",
      stage: "initial_pages_published",
      phase: "initial",
      binding: input.binding,
      logicalTarget: evidence.deploymentIntentDigest,
      invocationId: input.invocationId,
      localAttemptIndex: input.localAttemptIndex,
      phaseSequence: input.phaseSequence,
      previousReceiptDigest: input.previousReceiptDigest,
      expectedStateRevision: input.state.exactStateRevision,
      receiptKind: "observed",
      observedAt: input.observedAt,
      ...(evidence.effectOccurredAt == null ? {} : { effectOccurredAt: evidence.effectOccurredAt }),
      status: "deployed",
      effectCertainty: "committed",
      result: {
        deploymentIntentDigest: evidence.deploymentIntentDigest,
        pagesContentDigest: evidence.pagesContentDigest,
        sourceStateRevision: evidence.sourceStateRevision,
        pageUrl: evidence.pageUrl,
        externalReference: evidence.externalReference,
        observedSourceReceiptDigest: evidence.deploymentReceiptDigest,
        evidenceDigest: evidence.evidenceDigest,
      },
    },
    digest,
  );
  if (
    observed.receiptType !== "pages_deployment" ||
    observed.operationId !== evidence.deploymentOperationId
  ) {
    throw new TypeError("再観測したPages operation IDが保存証拠と一致しません");
  }
  return observed;
}

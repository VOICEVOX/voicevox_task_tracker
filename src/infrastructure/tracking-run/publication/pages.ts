import { randomUUID } from "node:crypto";

import { createPagesDeploymentIntent } from "../../../application/tracking-run/pages-build-contracts.js";
import { createReceipt } from "../../../application/tracking-run/receipt-codec.js";
import type { InitialStateCommitReceipt } from "../../../application/tracking-run/receipt-schema.js";
import type { Config } from "../../../config/index.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../../persistence/index.js";
import { nodeContentDigestPort as digest } from "../content-digest.js";
import { readInitialPagesSource } from "../initial-pages-source.js";
import type { InitialPagesPreparedRun, RunPublicationAdapters } from "./contracts.js";
import { buildPagesOutput } from "./pages-output.js";

/** exact stateから初回Pages成果物を作る接続。 */
export type BuildPublicPagesInput = Readonly<{
  adapter: StateBranchAdapter;
  config: Config;
  stateConfiguration: StatePersistenceConfiguration;
  initialStateCommitReceipt: InitialStateCommitReceipt;
  repositoryPath: string;
  outputDirectory: string;
  knownSecrets: readonly string[];
  writePublicData: RunPublicationAdapters["writePublicData"];
  buildWebOutput: RunPublicationAdapters["buildWebOutput"];
  now: RunPublicationAdapters["now"];
}>;

/** recordと初回commit receiptのexact stateからPagesを投影、buildして固定する。 */
export async function buildPublicPages(
  input: BuildPublicPagesInput,
): Promise<InitialPagesPreparedRun> {
  const source = await readInitialPagesSource(
    input.adapter,
    input.config,
    input.stateConfiguration,
    input.initialStateCommitReceipt,
    input.knownSecrets,
    input.now,
  );
  const record = source.resume.record;
  const projection = record.initialPagesProjection;
  const output = await buildPagesOutput({
    ...input,
    phase: "initial",
    record,
    snapshot: source.snapshot,
    historyRecords: source.historyRecords,
  });
  const intent = createPagesDeploymentIntent(
    {
      phase: "initial",
      runId: record.runIdentity.runId,
      checkpointDigest: record.checkpointDigest,
      recordDigest: record.recordDigest,
      sourceStateRevision: source.resume.state.revision,
      snapshotDigest: source.resume.state.snapshotDigest,
      repositoryAllowlistDigest: projection.repositoryAllowlistDigest,
      outputManifestDigest: output.outputManifestDigest,
      pagesContentDigest: output.pagesContentDigest,
      outputDirectory: "dist/web",
      expectedPageUrl: projection.settings.url,
    },
    digest,
  );
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "pages_build",
      stage: "initial_pages_prepared",
      phase: "initial",
      binding: source.resume.initialStateCommitReceipt.binding,
      logicalTarget: intent.deploymentIntentDigest,
      invocationId: randomUUID(),
      localAttemptIndex: 0,
      phaseSequence: source.resume.initialStateCommitReceipt.phaseSequence + 1,
      previousReceiptDigest: source.resume.initialStateCommitReceipt.receiptDigest,
      expectedStateRevision: source.resume.state.revision,
      receiptKind: "executed",
      observedAt: input.now().toISOString(),
      status: "built",
      effectCertainty: "committed",
      result: {
        deploymentIntentDigest: intent.deploymentIntentDigest,
        pagesContentDigest: intent.pagesContentDigest,
        outputManifestDigest: intent.outputManifestDigest,
        sourceStateRevision: intent.sourceStateRevision,
      },
    },
    digest,
  );
  if (receipt.receiptType !== "pages_build") {
    throw new TypeError("初回Pages build receiptの種別が不正です");
  }
  return Object.freeze({
    data: output.data,
    output: output.output,
    pagesUrl: projection.settings.url,
    manifest: output.manifest,
    intent,
    receipt,
  });
}

import { randomUUID } from "node:crypto";

import { createPagesDeploymentIntent } from "../../../application/tracking-run/pages-build-contracts.js";
import { createReceipt } from "../../../application/tracking-run/receipt-codec.js";
import type {
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../../application/tracking-run/receipt-schema.js";
import { hashCanonicalJson } from "../../../canonical-json/index.js";
import type { Config } from "../../../config/index.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../../persistence/index.js";
import { nodeContentDigestPort as digest } from "../content-digest.js";
import { readNotificationHistoryPagesSource } from "../notification-history-pages-source.js";
import type { NotificationHistoryPagesPreparedRun, RunPublicationAdapters } from "./contracts.js";
import { buildPagesOutput } from "./pages-output.js";

/** 通知履歴Pagesの正本と共通builderを結ぶ入力。 */
export type BuildNotificationHistoryPagesInput = Readonly<{
  adapter: StateBranchAdapter;
  config: Config;
  stateConfiguration: StatePersistenceConfiguration;
  settlementReceipt: NotificationSettlementReceipt;
  finalizationReceipt: RunFinalizationReceipt;
  repositoryPath: string;
  outputDirectory: string;
  knownSecrets: readonly string[];
  writePublicData: RunPublicationAdapters["writePublicData"];
  buildWebOutput: RunPublicationAdapters["buildWebOutput"];
  now: RunPublicationAdapters["now"];
}>;

/** final stateの送信履歴差分に応じたPages build artifactを作る。 */
export async function buildNotificationHistoryPages(
  input: BuildNotificationHistoryPagesInput,
): Promise<NotificationHistoryPagesPreparedRun> {
  const source = await readNotificationHistoryPagesSource(
    input.adapter,
    input.config,
    input.stateConfiguration,
    input.settlementReceipt,
    input.finalizationReceipt,
    input.knownSecrets,
    input.now,
  );
  const finalization = source.finalizationReceipt;
  const common = {
    schemaVersion: 1,
    receiptType: "pages_build",
    stage: "notification_history_pages_prepared",
    phase: "notification_history",
    binding: finalization.binding,
    invocationId: randomUUID(),
    localAttemptIndex: 0,
    phaseSequence: finalization.phaseSequence + 1,
    previousReceiptDigest: finalization.receiptDigest,
    expectedStateRevision: source.revision,
    observedAt: input.now().toISOString(),
  } as const;
  if (source.requirement.kind === "not_required") {
    const receipt = createReceipt(
      {
        ...common,
        logicalTarget: source.revision,
        receiptKind: "not_required",
        status: "not_required",
        effectCertainty: "no_effect",
        notRequiredReason: source.requirement.reason,
      },
      digest,
    );
    if (receipt.receiptType !== "pages_build") {
      throw new TypeError("通知履歴Pagesの不要receiptの種別が不正です");
    }
    return Object.freeze({
      schemaVersion: 1,
      status: "not_required",
      sourceStateRevision: source.revision,
      reason: source.requirement.reason,
      receipt,
    });
  }
  const output = await buildPagesOutput({
    ...input,
    phase: "notification_history",
    record: source.record,
    snapshot: source.snapshot,
    historyRecords: source.historyRecords,
  });
  const projection = source.record.initialPagesProjection;
  const intent = createPagesDeploymentIntent(
    {
      phase: "notification_history",
      runId: source.record.runIdentity.runId,
      checkpointDigest: source.record.checkpointDigest,
      recordDigest: source.record.recordDigest,
      sourceStateRevision: source.revision,
      snapshotDigest: hashCanonicalJson(source.snapshot),
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
      ...common,
      logicalTarget: intent.deploymentIntentDigest,
      receiptKind: "executed",
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
    throw new TypeError("通知履歴Pages build receiptの種別が不正です");
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "built",
    sourceStateRevision: source.revision,
    manifest: output.manifest,
    intent,
    receipt,
  });
}

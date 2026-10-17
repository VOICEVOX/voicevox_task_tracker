import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodeReceipt } from "../../../application/tracking-run/receipt-codec.js";
import { nodeContentDigestPort as digest } from "../content-digest.js";
import { parseNotificationHistoryPagesBuildArtifact } from "../notification-history-pages-build-artifact.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import type { RunPublicationAdapters } from "./contracts.js";
import type { WorkflowNotificationHistoryPagesBuildInput } from "./history-operation-inputs.js";
import { buildNotificationHistoryPages } from "./notification-history-pages.js";

type WorkflowHistoryPagesAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "now"
  | "writeJsonArtifact"
  | "writePublicData"
  | "buildWebOutput"
>;

/** split workflowのfinal stateから通知履歴Pages build artifactを保存する。 */
export async function prepareWorkflowNotificationHistoryPages(
  adapters: WorkflowHistoryPagesAdapters,
  command: WorkflowNotificationHistoryPagesBuildInput,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const settlementReceipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.settlementReceiptPath)),
    digest,
  );
  const finalizationReceipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.finalizationReceiptPath)),
    digest,
  );
  if (
    settlementReceipt.receiptType !== "notification_settlement" ||
    finalizationReceipt.receiptType !== "run_finalization"
  ) {
    throw new TypeError("通知履歴Pages buildにsettlementとfinalizationのreceiptが必要です");
  }
  const expectedRunId = requireEnvironmentValue(adapters.environment, "VOICEVOX_EXPECTED_RUN_ID");
  if (
    finalizationReceipt.binding.bindingKind !== "checkpoint" ||
    finalizationReceipt.binding.runId !== expectedRunId
  ) {
    throw new TypeError("通知履歴Pages buildのreceiptと期待run IDが一致しません");
  }
  const artifact = await buildNotificationHistoryPages({
    adapter: adapters.createStateBranchAdapter(),
    config,
    stateConfiguration: config.state,
    settlementReceipt,
    finalizationReceipt,
    repositoryPath: adapters.repositoryPath,
    outputDirectory: resolve(adapters.repositoryPath, command.outputDirectory),
    knownSecrets: [],
    writePublicData: adapters.writePublicData,
    buildWebOutput: adapters.buildWebOutput,
    now: adapters.now,
  });
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.buildArtifactPath),
    parseNotificationHistoryPagesBuildArtifact(artifact),
  );
}

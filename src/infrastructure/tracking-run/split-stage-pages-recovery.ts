import { readFile } from "node:fs/promises";

import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "../../persistence/index.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import {
  decodeNotificationHistoryPagesDeploymentOutcome,
  parseNotificationHistoryPagesDeploymentOutcome,
} from "./notification-history-pages-deployment-outcome.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { SplitStagePaths } from "./split-stage-paths.js";
import {
  appendSplitReceipts,
  recoverSplitInitialPagesChain,
  writeSplitReceiptChain,
} from "./split-stage-receipts.js";

async function optionalArtifact(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** chainに記録済みの通知履歴Pages結果を個別fileへ復元して照合する。 */
export async function restoreSplitHistoryPagesArtifact(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  entries: readonly ReceiptChainEntry[],
): Promise<void> {
  const deployment = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_deployment" &&
      entry.receipt.phase === "notification_history",
  )?.receipt;
  if (deployment?.receiptType !== "pages_deployment") {
    return;
  }
  const artifact = decodeNotificationHistoryPagesBuildArtifact(await readFile(paths.historyBuild));
  const build = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_build" && entry.receipt.phase === "notification_history",
  )?.receipt;
  if (
    build?.receiptType !== "pages_build" ||
    build.receiptDigest !== artifact.receipt.receiptDigest
  ) {
    throw new TypeError("通知履歴Pages build fileとchainが一致しません");
  }
  const reconstructed = parseNotificationHistoryPagesDeploymentOutcome(
    {
      schemaVersion: 1,
      kind: deployment.status === "not_required" ? "not_required" : "deployed",
      sourceStateRevision: artifact.sourceStateRevision,
      buildReceipt: artifact.receipt,
      receipt: deployment,
    },
    artifact,
  );
  if (reconstructed.kind === "failure") {
    throw new TypeError("通知履歴Pages成功結果をchainから復元できません");
  }
  const existing = await optionalArtifact(paths.historyDeployment);
  if (existing == null) {
    await adapters.writeJsonArtifact(paths.historyDeployment, reconstructed);
    return;
  }
  const outcome = decodeNotificationHistoryPagesDeploymentOutcome(existing, artifact);
  if (
    outcome.kind !== reconstructed.kind ||
    outcome.receipt.receiptDigest !== reconstructed.receipt.receiptDigest
  ) {
    throw new TypeError("通知履歴Pages結果fileとchainが一致しません");
  }
}

/** 通常artifactで結果とchainの保存順が分かれた場合に元receiptを連結する。 */
export async function reconcileSplitPagesOutcomes(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  initialStateRevision: string,
  entries: readonly ReceiptChainEntry[],
): Promise<readonly ReceiptChainEntry[]> {
  let current = entries;
  const initialBytes = await optionalArtifact(paths.initialDeployment);
  if (
    initialBytes != null &&
    !current.some(
      (entry) =>
        entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
    )
  ) {
    const recovered = await recoverSplitInitialPagesChain(
      paths,
      runId,
      adapter,
      configuration,
      initialStateRevision,
    );
    if (
      recovered == null ||
      current.length > recovered.length ||
      current.some(
        (entry, index) => entry.receipt.receiptDigest !== recovered[index]?.receipt.receiptDigest,
      )
    ) {
      throw new TypeError("初回Pages結果と保存済みchainの先行receiptが一致しません");
    }
    current = recovered;
  }
  const historyBytes = await optionalArtifact(paths.historyDeployment);
  if (
    historyBytes != null &&
    !current.some(
      (entry) =>
        entry.receipt.receiptType === "pages_deployment" &&
        entry.receipt.phase === "notification_history",
    )
  ) {
    const artifact = decodeNotificationHistoryPagesBuildArtifact(
      await readFile(paths.historyBuild),
    );
    const outcome = decodeNotificationHistoryPagesDeploymentOutcome(historyBytes, artifact);
    if (outcome.kind !== "failure") {
      if (outcome.buildReceipt.receiptDigest !== artifact.receipt.receiptDigest) {
        throw new TypeError("通知履歴Pagesの元buildと結果が一致しません");
      }
      const last = current.at(-1)?.receipt;
      const additions: ReceiptChainEntry[] = [];
      if (last?.receiptDigest !== artifact.receipt.receiptDigest) {
        additions.push({ receipt: artifact.receipt, evidence: { kind: "none" } });
      }
      additions.push({ receipt: outcome.receipt, evidence: { kind: "none" } });
      current = appendSplitReceipts(current, additions, runId);
    }
  }
  if (current !== entries) {
    await writeSplitReceiptChain(paths.receiptChain, current, adapters.writeJsonArtifact);
  }
  return current;
}

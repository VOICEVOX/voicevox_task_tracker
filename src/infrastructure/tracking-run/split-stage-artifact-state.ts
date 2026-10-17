import { stat } from "node:fs/promises";

import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import type { RunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import type { SplitStagePaths } from "./split-stage-paths.js";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function allFilesPresent(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      if (!(await stat(path)).isFile()) {
        throw new TypeError("分割runの必要artifactが通常fileではありません");
      }
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return false;
      }
      throw error;
    }
  }
  return true;
}

/** remote phaseと個別artifactに照らしてchain再観測の要否を判定する。 */
export async function needsReceiptRestoration(
  entries: readonly ReceiptChainEntry[],
  markerPhase: RunTransactionMarker["phase"],
  paths: SplitStagePaths,
): Promise<boolean> {
  const last = entries.at(-1)?.receipt;
  if (last == null) {
    throw new TypeError("分割runのreceipt chainが空です");
  }
  if (
    (markerPhase === "notifications_in_progress" &&
      last.receiptType !== "notification_message" &&
      last.receiptType !== "manual_resolution" &&
      (last.receiptType !== "pages_deployment" || last.phase !== "initial")) ||
    (markerPhase === "notifications_settled" && last.receiptType !== "notification_settlement") ||
    (markerPhase === "run_finalized" &&
      last.receiptType !== "run_finalization" &&
      last.stage !== "notification_history_pages_prepared" &&
      last.stage !== "notification_history_pages_published" &&
      last.stage !== "completed")
  ) {
    return true;
  }
  const required = [paths.initialReceipt];
  if (last.stage !== "initial_state_committed") {
    required.push(paths.initialBuild);
  }
  if (last.stage !== "initial_state_committed" && last.stage !== "initial_pages_prepared") {
    const initialPages = entries.findLast(
      (entry) =>
        entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
    )?.receipt;
    if (initialPages?.receiptType !== "pages_deployment") {
      throw new TypeError("初回Pagesのreceiptがありません");
    }
    if (initialPages.receiptKind !== "observed") {
      required.push(paths.initialDeployment);
    }
  }
  if (markerPhase === "notifications_settled" || markerPhase === "run_finalized") {
    required.push(paths.settlementReceipt);
  }
  if (markerPhase === "run_finalized") {
    required.push(paths.finalizationReceipt);
  }
  if (
    last.stage === "notification_history_pages_prepared" ||
    last.stage === "notification_history_pages_published" ||
    last.stage === "completed"
  ) {
    required.push(paths.historyBuild);
  }
  if (last.stage === "notification_history_pages_published" || last.stage === "completed") {
    required.push(paths.historyDeployment);
  }
  return !(await allFilesPresent(required));
}

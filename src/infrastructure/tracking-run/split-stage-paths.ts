import { resolve } from "node:path";
import { assertNonNullable } from "../../util/index.js";
import type { RunStageCliCommand } from "./split-command-input.js";

const RUN_ID_PATTERN = /^tracker-run:([0-9a-f]{64})$/u;

/** 分割runのstage間で共有する固定path。 */
export type SplitStagePaths = Readonly<{
  root: string;
  checkpoint: string;
  report: string;
  receiptChain: string;
  initialReceipt: string;
  initialBuild: string;
  initialPreflight: string;
  initialDeployment: string;
  settlementReceipt: string;
  finalizationReceipt: string;
  historyBuild: string;
  historyPreflight: string;
  historyDeployment: string;
  completionReceipt: string;
  manualResolutionReceipt: string;
  pagesOutput: string;
}>;

/** run IDに紐づく成果物を前runのfileから分離する。 */
export function splitStagePaths(repositoryPath: string, runId: string): SplitStagePaths {
  const match = RUN_ID_PATTERN.exec(runId);
  if (match == null) {
    throw new TypeError("分割runのrun IDが不正です");
  }
  const suffix = match[1];
  assertNonNullable(suffix, "分割runのrun IDを取得できませんでした");
  const root = resolve(repositoryPath, "artifacts/workflow/runs", suffix);
  return Object.freeze({
    root,
    checkpoint: resolve(repositoryPath, "artifacts/workflow/validated-run.cpk"),
    report: resolve(root, "run-report.json"),
    receiptChain: resolve(root, "receipt-chain.json"),
    initialReceipt: resolve(root, "initial-state-commit-receipt.json"),
    initialBuild: resolve(root, "initial-pages-build.json"),
    initialPreflight: resolve(root, "initial-pages-preflight.json"),
    initialDeployment: resolve(root, "initial-pages-deployment.json"),
    settlementReceipt: resolve(root, "notification-settlement-receipt.json"),
    finalizationReceipt: resolve(root, "run-finalization-receipt.json"),
    historyBuild: resolve(root, "notification-history-pages-build.json"),
    historyPreflight: resolve(root, "notification-history-pages-preflight.json"),
    historyDeployment: resolve(root, "notification-history-pages-deployment.json"),
    completionReceipt: resolve(root, "completion-receipt.json"),
    manualResolutionReceipt: resolve(root, "manual-resolution-receipt.json"),
    pagesOutput: resolve(repositoryPath, "web/public/data"),
  });
}

/** 分割jobの公開失敗artifact名をrunと段階へ固定する。 */
export function splitStageFailureFileName(command: RunStageCliCommand): string {
  const suffix = command.runId == null ? "analyze" : RUN_ID_PATTERN.exec(command.runId)?.[1];
  assertNonNullable(suffix, "分割runの失敗artifact名を取得できませんでした");
  return `${suffix}-${command.stage}-attempt-${command.runAttempt.toString()}.json`;
}

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { assertNonNullable } from "../../util/index.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { selectPriorPagesArtifacts } from "./prior-pages-artifacts.js";
import { validateRetainedPages } from "./prior-pages-witness.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import { needsReceiptRestoration } from "./split-stage-artifact-state.js";
import { reconcileSplitPagesOutcomes } from "./split-stage-pages-recovery.js";
import type { SplitStagePaths } from "./split-stage-paths.js";
import {
  appendSplitReceipts,
  readSplitReceiptChain,
  recoverSplitInitialPagesChain,
  writeSplitReceiptChain,
} from "./split-stage-receipts.js";
import { restoreSplitReceipts, verifySplitSettlementReceipt } from "./split-stage-recovery.js";
import { type SplitState, verifySplitState } from "./split-stage-state.js";

/** file不在のエラーか判定する。 */
export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** remote stateとartifactから先行receipt chainを復旧する。 */
export async function priorReceipts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  state: SplitState,
  configPath: string,
): Promise<readonly ReceiptChainEntry[]> {
  await selectPriorPagesArtifacts(adapters, paths, runId);
  let entries: readonly ReceiptChainEntry[] | undefined;
  let chainMissing = false;
  try {
    entries = await readSplitReceiptChain(paths.receiptChain, runId);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
    chainMissing = true;
  }
  if (chainMissing) {
    entries = await recoverSplitInitialPagesChain(
      paths,
      runId,
      state.adapter,
      state.config.state,
      state.initialStateRevision,
    );
  }
  if (entries != null)
    entries = await reconcileSplitPagesOutcomes(
      adapters,
      paths,
      runId,
      state.adapter,
      state.config.state,
      state.initialStateRevision,
      entries,
    );
  if (entries != null) {
    await verifySplitState(state, runId, randomUUID(), adapters.now().toISOString(), entries);
  }
  let settlementReceipt: ReturnType<typeof decodeReceipt> | undefined;
  try {
    settlementReceipt = decodeReceipt(await readFile(paths.settlementReceipt), digest);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  const chainSettlement = entries?.findLast(
    (entry) => entry.receipt.receiptType === "notification_settlement",
  )?.receipt;
  if (settlementReceipt != null || chainSettlement != null) {
    if (state.markerPhase !== "notifications_settled" && state.markerPhase !== "run_finalized") {
      throw new TypeError("remote未確定の通知settlementをartifactが主張しています");
    }
    const recoveryState = {
      adapter: state.adapter,
      configuration: state.config.state,
      headRevision: state.headRevision,
      initialStateRevision: state.initialStateRevision,
    };
    for (const receipt of [settlementReceipt, chainSettlement]) {
      if (receipt == null) {
        continue;
      }
      if (
        receipt.receiptType !== "notification_settlement" ||
        receipt.binding.bindingKind !== "checkpoint"
      ) {
        throw new TypeError("通知settlement artifactのreceipt種別が不正です");
      }
      await verifySplitSettlementReceipt(
        recoveryState,
        runId,
        receipt.binding.checkpointDigest,
        receipt,
      );
    }
    if (
      settlementReceipt != null &&
      chainSettlement != null &&
      settlementReceipt.receiptDigest !== chainSettlement.receiptDigest
    ) {
      throw new TypeError("通知settlement fileとchainのreceipt digestが一致しません");
    }
  }
  if (entries != null) {
    await validateRetainedPages(adapters, paths, entries, runId, configPath, state);
    if (chainMissing) {
      await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
    }
  }
  if (settlementReceipt == null && chainSettlement != null) {
    await adapters.writeJsonArtifact(paths.settlementReceipt, chainSettlement);
  }
  if (entries != null && !(await needsReceiptRestoration(entries, state.markerPhase, paths))) {
    return entries;
  }
  return restoreSplitReceipts(
    adapters,
    paths,
    runId,
    configPath,
    {
      adapter: state.adapter,
      configuration: state.config.state,
      headRevision: state.headRevision,
      initialStateRevision: state.initialStateRevision,
    },
    entries,
  );
}

/** stage receipt chainを保存して結果を出力する。 */
export async function saveStageReceipts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  prior: readonly ReceiptChainEntry[],
  additions: readonly ReceiptChainEntry[],
): Promise<void> {
  const entries = appendSplitReceipts(prior, additions, runId);
  await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
  const receipt = entries.at(-1)?.receipt;
  assertNonNullable(receipt, "分割runの成功receiptがありません");
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({
      runId,
      stage: receipt.stage,
      receiptDigest: receipt.receiptDigest,
      phaseSequence: receipt.phaseSequence,
      receiptChainPath: paths.receiptChain,
    }),
  );
}

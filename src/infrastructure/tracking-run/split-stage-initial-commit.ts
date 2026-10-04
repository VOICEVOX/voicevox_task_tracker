import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runTrackingStageOnce } from "../../application/tracking-run/engine.js";
import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { inspectRunBootstrapState } from "./bootstrap-state.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { readPublicationCheckpointHeader } from "./publication-checkpoint-file.js";
import { readCommittedInitialState } from "./publication/committed-state.js";
import { persistWorkflowState } from "./publication/workflow-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { RunStageCliCommand } from "./split-command-input.js";
import type { SplitStagePaths } from "./split-stage-paths.js";
import {
  readSplitReceiptChain,
  stateCommitEvidenceForSplitReceipt,
} from "./split-stage-receipts.js";
import { isMissingFile, priorReceipts, saveStageReceipts } from "./split-stage-receipt-recovery.js";
import { inspectSplitState, verifySplitState } from "./split-stage-state.js";

/** 分割runの初回stateを保存してreceipt chainを確定する。 */
export async function commitSplitInitialState(
  adapters: ProductionRuntimeAdapters,
  command: RunStageCliCommand,
  invocationId: string,
  paths: SplitStagePaths,
  runId: string,
): Promise<void> {
  let existing: readonly ReceiptChainEntry[] | undefined;
  try {
    existing = await readSplitReceiptChain(paths.receiptChain, runId);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const stateAdapter = adapters.createStateBranchAdapter();
  const head = await stateAdapter.resolveHead(config.state.branch);
  if (head.status === "present") {
    const bootstrap = await inspectRunBootstrapState(stateAdapter, config.state.branch, {
      kind: "retry_run",
      runId,
      exactStateRevision: head.revision,
    });
    if (bootstrap.kind === "resume_with_exact_runtime") {
      const state = await inspectSplitState(adapters, command.configPath, runId);
      const receipts = await priorReceipts(adapters, paths, runId, state, command.configPath);
      await verifySplitState(state, runId, invocationId, adapters.now().toISOString(), receipts);
      const first = receipts[0]?.receipt;
      if (first?.receiptType !== "initial_state_commit") {
        throw new TypeError("保存済みreceipt chainに初回state commitがありません");
      }
      await adapters.writeJsonArtifact(paths.initialReceipt, first);
      await adapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          runId,
          stage: first.stage,
          receiptDigest: first.receiptDigest,
          phaseSequence: first.phaseSequence,
          receiptChainPath: paths.receiptChain,
        }),
      );
      return;
    }
    if (bootstrap.kind !== "operator_conflict_resolution") {
      throw new TypeError("初回commit前のstate bootstrapが不正です", {
        cause: bootstrap.kind === "manual_resolution_required" ? bootstrap.cause : undefined,
      });
    }
    const current = await inspectRunBootstrapState(stateAdapter, config.state.branch, {
      kind: "start_new",
    });
    if (current.kind !== "start_with_current_runtime") {
      throw new TypeError("別runの永続stateが初回commitを妨げています");
    }
  }
  const header = await readPublicationCheckpointHeader(paths.checkpoint);
  if (header.runIdentity.runId !== runId) {
    throw new TypeError("初回commitのcheckpointと指定run IDが一致しません");
  }
  if (
    (head.status === "missing" && header.baseStateRevision.status !== "missing") ||
    (head.status === "present" &&
      (header.baseStateRevision.status !== "present" ||
        header.baseStateRevision.revision !== head.revision))
  ) {
    throw new TypeError("初回commitのcheckpoint baseがremote headと一致しません");
  }
  if (existing != null) {
    throw new TypeError("初回receiptがあるのにremote stateに同じrunがありません");
  }
  await runTrackingStageOnce("publication_planned", "initial_state_committed", () =>
    persistWorkflowState(
      { adapters },
      {
        configPath: command.configPath,
        artifactPath: paths.checkpoint,
        receiptPath: paths.initialReceipt,
      },
    ),
  );
  const receipt = decodeReceipt(await readFile(paths.initialReceipt), digest);
  if (receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回commitのreceipt種別が不正です");
  }
  await readCommittedInitialState({
    adapter: adapters.createStateBranchAdapter(),
    configuration: config.state,
    knownSecrets: [],
    reference: {
      stateRevision: receipt.result.resultingStateRevision,
      stateContentDigest: receipt.result.stateContentDigest,
    },
    now: adapters.now,
  });
  const evidence = await stateCommitEvidenceForSplitReceipt(
    adapters.createStateBranchAdapter(),
    config.state,
    receipt,
    receipt.result.resultingStateRevision,
  );
  await saveStageReceipts(adapters, paths, runId, [], [{ receipt, evidence }]);
  return;
}

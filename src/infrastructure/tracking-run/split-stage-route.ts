import { resolve } from "node:path";

import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION } from "../../publication/durable-record-schema.js";
import { inspectRunBootstrapState } from "./bootstrap-state.js";
import { readPublicationCheckpointHeader } from "./publication-checkpoint-file.js";
import type { RecoveryStageInput } from "./recovery-stage.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { RouteStageCliCommand, RunStageCliCommand } from "./split-command-input.js";
import { splitStagePaths } from "./split-stage-paths.js";
import { priorReceipts } from "./split-stage-receipt-recovery.js";
import { inspectSplitState, scopedAdapters, verifySplitState } from "./split-stage-state.js";

function nextSplitStage(stage: RecoveryStageInput["stage"]): RunStageCliCommand["stage"] {
  switch (stage) {
    case "initial_pages_build":
      return "prepare-initial-pages";
    case "initial_pages_deploy":
      return "preflight-initial-pages-deployment";
    case "notifications":
      return "settle-notifications";
    case "run_finalization":
      return "finalize-run";
    case "notification_history_build":
      return "prepare-history-pages";
    case "notification_history_deploy":
      return "preflight-history-pages-deployment";
    case "completed":
      return "complete";
  }
}

/** remote exact stateと検証済みreceiptから次の分割段階を返す。 */
export async function routeSplitStage(
  runtimeAdapters: ProductionRuntimeAdapters,
  command: RouteStageCliCommand,
  invocationId: string,
): Promise<void> {
  const config = await runtimeAdapters.loadConfig(
    resolve(runtimeAdapters.repositoryPath, command.configPath),
  );
  if (command.stateRef !== config.state.branch) {
    throw new TypeError("route-stageのstate refと設定の保存先が一致しません");
  }
  const adapter = runtimeAdapters.createStateBranchAdapter();
  const head = await adapter.resolveHead(command.stateRef);
  if (head.status === "missing") {
    if (command.runId != null) {
      throw new TypeError("指定runのremote stateがありません");
    }
    await runtimeAdapters.writeStandardOutput(
      serializeCanonicalJsonLine({
        schemaVersion: 1,
        runId: null,
        stateRevision: "unborn",
        effectTarget: command.effectTarget,
        nextStage: "analyze",
      }),
    );
    return;
  }
  const bootstrap = await inspectRunBootstrapState(
    adapter,
    command.stateRef,
    command.runId == null
      ? { kind: "start_new" }
      : { kind: "retry_run", runId: command.runId, exactStateRevision: head.revision },
  );
  if (bootstrap.kind === "start_with_current_runtime") {
    await runtimeAdapters.writeStandardOutput(
      serializeCanonicalJsonLine({
        schemaVersion: 1,
        runId: null,
        stateRevision: head.revision,
        effectTarget: command.effectTarget,
        nextStage: "analyze",
      }),
    );
    return;
  }
  if (bootstrap.kind === "operator_conflict_resolution" && command.runId != null) {
    const current = await inspectRunBootstrapState(adapter, command.stateRef, {
      kind: "start_new",
    });
    if (current.kind === "start_with_current_runtime") {
      const checkpoint = await readPublicationCheckpointHeader(
        splitStagePaths(runtimeAdapters.repositoryPath, command.runId).checkpoint,
      );
      if (
        checkpoint.runIdentity.runId === command.runId &&
        checkpoint.executionPolicy.effectTarget === command.effectTarget &&
        checkpoint.baseStateRevision.status === "present" &&
        checkpoint.baseStateRevision.revision === head.revision
      ) {
        await runtimeAdapters.writeStandardOutput(
          serializeCanonicalJsonLine({
            schemaVersion: 1,
            runId: command.runId,
            stateRevision: head.revision,
            effectTarget: command.effectTarget,
            nextStage: "commit-initial-state",
          }),
        );
        return;
      }
    }
  }
  if (bootstrap.kind !== "resume_with_exact_runtime") {
    throw new TypeError("route-stageのremote runを安全に選べません", {
      cause: bootstrap.kind === "manual_resolution_required" ? bootstrap.cause : undefined,
    });
  }
  if (bootstrap.record.recordSchemaVersion !== DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION) {
    throw new TypeError("旧ready-only V1の副作用段階は手動解決が必要です");
  }
  const runId = bootstrap.record.runId;
  const adapters = scopedAdapters(runtimeAdapters, runId);
  const state = await inspectSplitState(adapters, command.configPath, runId);
  if (state.effectTarget !== command.effectTarget) {
    throw new TypeError("route-stageのeffect targetと永続recordが一致しません");
  }
  const paths = splitStagePaths(adapters.repositoryPath, runId);
  const entries = await priorReceipts(adapters, paths, runId, state, command.configPath);
  const stageInput = await verifySplitState(
    state,
    runId,
    invocationId,
    adapters.now().toISOString(),
    entries,
  );
  const nextStage =
    entries.at(-1)?.receipt.receiptType === "completion"
      ? "done"
      : nextSplitStage(stageInput.stage);
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({
      schemaVersion: 1,
      runId,
      stateRevision: state.headRevision,
      recordDigest: state.recordDigest,
      effectTarget: state.effectTarget,
      nextStage,
      receiptChainPath: paths.receiptChain,
    }),
  );
}

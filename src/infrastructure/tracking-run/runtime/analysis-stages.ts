import { analyzeDeterministically } from "../../../application/tracking-run/stages/deterministic.js";
import { join } from "node:path";
import {
  adoptGenericAi,
  type GenericAiAdoptedRun,
} from "../../../application/tracking-run/stages/generic-ai-adoption.js";
import type { GenericAiExecutedRun } from "../../../application/tracking-run/stages/generic-ai-execution.js";
import {
  reconcileAdoptedGraph,
  type GraphReconciledRun,
} from "../../../application/tracking-run/stages/graph-reconciliation.js";
import { assertNonNullable } from "../../../util/index.js";
import { nodeContentDigestPort } from "../content-digest.js";
import type { GitHubRunSessions } from "../github-port.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";
import type {
  AnalysisProgress,
  AnalysisRuntimeContext,
  AnalysisStages,
} from "./analysis-contracts.js";
import { analyzeCodex } from "./codex/execution.js";
import { createPlanGenericAiStage } from "./codex/stage.js";
import { createCollectItemsStage } from "./collection/stage.js";
import { createCollectInventoryStage } from "./daily-startup/inventory.js";
import { createPersonalReminderStages } from "./personal-reminder/stage.js";
import { SANDBOX_STRICT_ZERO_SOURCE_PROOF_PATH } from "./validation/sandbox-strict-zero-source-proof.js";
import { validateRunCompleteness } from "./validation/stage.js";
import {
  SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME,
  writeSandboxGenericAiInputEvidence,
} from "../sandbox-generic-ai-input-evidence.js";

/** 直列engineの解析段階をrunに閉じたadapterへ接続する。 */
export function createAnalysisStages(
  adapters: ProductionRuntimeAdapters,
  sessions: GitHubRunSessions,
  context: AnalysisRuntimeContext,
  progress: AnalysisProgress,
): AnalysisStages {
  const collectInventory = createCollectInventoryStage(adapters, sessions, context);
  const collectItems = createCollectItemsStage(adapters, sessions);
  let executed: GenericAiExecutedRun | undefined;
  let adopted: GenericAiAdoptedRun | undefined;
  let reconciled: GraphReconciledRun | undefined;
  return Object.freeze({
    inventoryCollected: async (prepared) => {
      const result = await collectInventory(prepared);
      progress.record(result.data.metrics, result.data.diagnostics, "success");
      return result;
    },
    collected: async (inventory) => {
      const result = await collectItems(inventory);
      progress.record(result.data.metrics, result.data.diagnostics, "success");
      return result;
    },
    deterministicallyAnalyzed: (collected) => Promise.resolve(analyzeDeterministically(collected)),
    genericAiPlanned: createPlanGenericAiStage(adapters, context),
    genericAiExecuted: async (planned) => {
      const result = await analyzeCodex(
        adapters,
        context.invocation,
        context.configuration,
        context.state,
        planned,
      );
      executed = result.executed;
      progress.record(
        {
          aiCallCount: result.aiCallCount,
          aiCacheHitCount: result.aiCacheHitCount,
          aiRetainedResultCount: result.aiRetainedResultCount,
          estimatedInputTokens: result.estimatedInputTokens,
        },
        result.diagnostics,
        result.status,
      );
      return executed;
    },
    genericAiAdopted: async (value) => {
      adopted = adoptGenericAi(value, nodeContentDigestPort);
      if (
        context.configuration.target.kind === "sandbox" &&
        context.configuration.target.context.analysisMode.kind !== "cache_probe"
      ) {
        await writeSandboxGenericAiInputEvidence(
          value,
          adopted,
          context.configuration.target.context,
          adapters.environment,
          join(adapters.repositoryPath, "artifacts/workflow", SANDBOX_GENERIC_AI_INPUT_BUNDLE_NAME),
        );
      }
      return adopted;
    },
    graphReconciled: (value) => {
      reconciled = reconcileAdoptedGraph(value);
      progress.record(
        { activeEdgeCount: reconciled.data.graph.edges.filter((edge) => edge.active).length },
        [],
        "success",
      );
      return Promise.resolve(reconciled);
    },
    ...createPersonalReminderStages(adapters, context, progress),
    validated: async (finalized) => {
      assertNonNullable(executed, "完全性検証に必要な汎用AI実行段階がありません");
      assertNonNullable(adopted, "完全性検証に必要な汎用AI採用段階がありません");
      assertNonNullable(reconciled, "完全性検証に必要なgraph確定段階がありません");
      try {
        return await validateRunCompleteness(
          context,
          executed,
          adopted,
          reconciled,
          finalized,
          progress,
          sessions,
          adapters.environment["SANDBOX_STRICT_ZERO_SOURCE_PROOF_PATH"] ===
            SANDBOX_STRICT_ZERO_SOURCE_PROOF_PATH
            ? async (proof) => {
                if (context.configuration.target.kind !== "sandbox") {
                  throw new TypeError("strict-zeroのsource証拠にはsandboxが必要です");
                }
                await adapters.writeTextFile(
                  join(adapters.repositoryPath, SANDBOX_STRICT_ZERO_SOURCE_PROOF_PATH),
                  proof,
                );
              }
            : undefined,
        );
      } finally {
        sessions.release(context.invocation.runId);
      }
    },
  });
}

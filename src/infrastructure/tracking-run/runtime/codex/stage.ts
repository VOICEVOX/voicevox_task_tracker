import {
  planGenericAi,
  type GenericAiPlanningPort,
} from "../../../../application/tracking-run/stages/generic-ai-plan.js";
import { join } from "node:path";
import type { CodexRuntimeAdapters } from "../adapters.js";
import type { AnalysisRuntimeContext, AnalysisStages } from "../analysis-contracts.js";
import { createGenericAiPlanningPort, readSandboxCacheProbeSource } from "./planning-source.js";
import { writeSandboxReusePlanProof } from "../../sandbox-reuse-plan-proof.js";
import { readSandboxGenericAiInputComparison } from "../../sandbox-generic-ai-input-evidence.js";

/** 決定論的な判定から汎用AIの入力と選択を確定する。 */
export function createPlanGenericAiStage(
  adapters: CodexRuntimeAdapters,
  context: AnalysisRuntimeContext,
): AnalysisStages["genericAiPlanned"] {
  const { invocation, configuration, state } = context;
  const diagnostics =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          stage: "codex_analysis",
        });
  return async (analyzed) => {
    const cacheProbeSource = await readSandboxCacheProbeSource(configuration, state);
    let inputComparison: GenericAiPlanningPort["compareCacheProbeInputCategories"];
    if (cacheProbeSource != null) {
      if (configuration.target.kind !== "sandbox") {
        throw new TypeError("cache probeの実入力比較にはsandboxが必要です");
      }
      inputComparison = await readSandboxGenericAiInputComparison(
        configuration.target.context,
        cacheProbeSource,
        adapters.environment,
      );
    }
    const planned = await planGenericAi(
      analyzed,
      createGenericAiPlanningPort(
        configuration,
        state,
        diagnostics,
        cacheProbeSource,
        inputComparison,
      ),
    );
    if (
      configuration.target.kind === "sandbox" &&
      configuration.target.context.analysisMode.kind === "cache_probe"
    ) {
      writeSandboxReusePlanProof(
        join(adapters.repositoryPath, "artifacts/workflow/sandbox-reuse-plan.json"),
        planned,
        configuration.target.context,
      );
    }
    return planned;
  };
}

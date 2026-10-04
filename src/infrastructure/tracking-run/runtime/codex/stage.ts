import { planGenericAi } from "../../../../application/tracking-run/stages/generic-ai-plan.js";
import type { CodexRuntimeAdapters } from "../adapters.js";
import type { AnalysisRuntimeContext, AnalysisStages } from "../analysis-contracts.js";
import { createGenericAiPlanningPort } from "./planning-source.js";

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
  return (analyzed) =>
    planGenericAi(analyzed, createGenericAiPlanningPort(configuration, state, diagnostics));
}

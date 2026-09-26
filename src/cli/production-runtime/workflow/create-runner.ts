import { WorkflowStageRunner } from "../../workflow-stage.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import { createBuildWorkflowPagesStage } from "./build-pages.js";
import { createNotifyWorkflowDiscordStage } from "./notify-discord.js";
import { createNotifyWorkflowOperationsStage } from "./notify-operations.js";
import { createPersistWorkflowStateStage } from "./persist-state.js";
import { reportWorkflowRun } from "./report-run.js";
import { createResolveDiscordDeliveryStage } from "./resolve-delivery.js";

/** workflowの6段階を既存実行順に接続する。 */
export function createWorkflowStageRunner(
  adapters: ProductionRuntimeAdapters,
): WorkflowStageRunner {
  return new WorkflowStageRunner({
    persistState: createPersistWorkflowStateStage(adapters),
    buildPages: createBuildWorkflowPagesStage(adapters),
    notifyDiscord: createNotifyWorkflowDiscordStage(adapters),
    notifyOperations: createNotifyWorkflowOperationsStage(adapters),
    resolveDiscordDelivery: createResolveDiscordDeliveryStage(adapters),
    reportWorkflow: (command) => reportWorkflowRun(adapters, command),
  });
}

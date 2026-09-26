import { persistWorkflowState } from "../../run-publication/workflow-stage-handlers.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";

/** workflowの状態永続化段階を既存公開処理へ接続する。 */
export function createPersistWorkflowStateStage(
  adapters: Parameters<typeof persistWorkflowState>[0]["adapters"],
): WorkflowStageDependencies["persistState"] {
  return (command) => persistWorkflowState({ adapters }, command);
}

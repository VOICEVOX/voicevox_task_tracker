import { notifyWorkflowOperations } from "../../run-publication/workflow-stage-handlers.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";

/** workflowの障害通知段階を既存公開処理へ接続する。 */
export function createNotifyWorkflowOperationsStage(
  adapters: Parameters<typeof notifyWorkflowOperations>[0]["adapters"],
): WorkflowStageDependencies["notifyOperations"] {
  return (command) => notifyWorkflowOperations({ adapters }, command);
}

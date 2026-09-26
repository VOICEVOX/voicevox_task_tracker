import { buildWorkflowPages } from "../../run-publication/workflow-stage-handlers.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";
import { normalizeLabelRules } from "../label-rules.js";

/** workflowのPages生成段階を既存公開処理へ接続する。 */
export function createBuildWorkflowPagesStage(
  adapters: Parameters<typeof buildWorkflowPages>[0]["adapters"],
): WorkflowStageDependencies["buildPages"] {
  return (command) => buildWorkflowPages({ adapters, normalizeLabelRules }, command);
}

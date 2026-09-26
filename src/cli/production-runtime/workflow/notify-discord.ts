import { notifyWorkflowDiscord } from "../../run-publication/workflow-stage-handlers.js";
import type { WorkflowStageDependencies } from "../../workflow-stage.js";
import { normalizeLabelRules } from "../label-rules.js";
import { completedSnapshotTrackingStartAt } from "../tracking-start-at.js";

/** workflowのDiscord通知段階を既存公開処理へ接続する。 */
export function createNotifyWorkflowDiscordStage(
  adapters: Parameters<typeof notifyWorkflowDiscord>[0]["adapters"],
): WorkflowStageDependencies["notifyDiscord"] {
  return (command) =>
    notifyWorkflowDiscord(
      {
        adapters,
        normalizeLabelRules,
        resolveCompletedTrackingStartAt: completedSnapshotTrackingStartAt,
      },
      command,
    );
}

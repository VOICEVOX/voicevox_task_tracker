import type { FailedRun } from "../../application/tracking-run/failure-artifact.js";
import type { RunStage } from "../../publication/run-report.js";
import type { CliCommand } from "./command-input.js";
import type { RunStageCliCommand } from "./split-command-input.js";

function stageFromSplitCommand(stage: RunStageCliCommand["stage"]): FailedRun["failedStage"] {
  switch (stage) {
    case "analyze":
      return "prepare";
    case "commit-initial-state":
      return "initial_state_committed";
    case "prepare-initial-pages":
      return "initial_pages_prepared";
    case "preflight-initial-pages-deployment":
    case "record-initial-pages-deployment":
      return "initial_pages_published";
    case "settle-notifications":
      return "notifications_settled";
    case "finalize-run":
      return "run_finalized";
    case "prepare-history-pages":
      return "notification_history_pages_prepared";
    case "preflight-history-pages-deployment":
    case "record-history-pages-deployment":
      return "notification_history_pages_published";
    case "complete":
      return "completed";
  }
}

/** run reportの段階を公開失敗段階へ写す。 */
export function stageFromReport(
  stage: RunStage,
  stateCommitted: boolean,
): FailedRun["failedStage"] {
  switch (stage) {
    case "runtime_selection":
    case "runtime_launch":
    case "workflow_effect_observation":
      return stage;
    case "configuration":
      return "prepare";
    case "authentication":
      return "prepared";
    case "repository_inventory":
      return "inventory_collected";
    case "incremental_collection":
      return "collected";
    case "deterministic_analysis":
      return "deterministically_analyzed";
    case "codex_analysis":
      return "generic_ai_executed";
    case "reducer":
    case "graph_analysis":
      return "graph_reconciled";
    case "personal_reminder_analysis":
      return "personal_reminder_executed";
    case "completeness_validation":
      return "validated";
    case "state_persistence":
      return stateCommitted ? "run_finalized" : "initial_state_committed";
    case "pages":
      return "initial_pages_published";
    case "discord":
      return "notifications_settled";
    case "artifact":
      return "checkpoint_encoding";
  }
}

/** CLI commandの段階を公開失敗段階へ写す。 */
export function stageFromCommand(command: CliCommand | undefined): FailedRun["failedStage"] {
  switch (command?.kind) {
    case "resolve-discord-delivery":
      return "notifications_settled";
    case "inspect-run-state":
    case "route-stage":
    case "verify-runtime-recovery":
      return "runtime_bootstrap";
    case "runtime-recovery-v2":
      if (command.operation === "record_pages") {
        return command.phase === "initial"
          ? "initial_pages_published"
          : "notification_history_pages_published";
      }
      if (command.operation === "execute_stage" && command.stage != null) {
        return stageFromSplitCommand(command.stage);
      }
      return "runtime_bootstrap";
    case "verify-checkpoint":
      return "checkpoint_binding";
    case "daily":
    case "dry-run":
    case "backfill":
    case "run-sequential":
    case "collect-analyze":
      return "prepare";
    case "run-stage":
      return stageFromSplitCommand(command.stage);
    case "notify-operations":
    case "report-workflow":
    case "verify-state":
    case "verify-receipt-chain":
    case "report-failure":
    case "help":
    case undefined:
      return command == null ? "prepare" : "workflow_effect_observation";
  }
}

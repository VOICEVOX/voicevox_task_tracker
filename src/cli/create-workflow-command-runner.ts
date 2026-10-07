import { createResolveDiscordDeliveryStage } from "../infrastructure/tracking-run/manual-delivery-command.js";
import { notifyWorkflowOperations } from "../infrastructure/tracking-run/publication/workflow-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../infrastructure/tracking-run/runtime/adapters.js";
import {
  inspectRunStateCommand,
  reportFailureCommand,
  verifyCheckpointCommand,
  verifyReceiptChainCommand,
  verifyRuntimeRecoveryCommand,
} from "../infrastructure/tracking-run/verify-publication.js";
import { reportWorkflowRun } from "../infrastructure/tracking-run/workflow-report-command.js";
import { WorkflowCommandRunner } from "./workflow-stage.js";
/** 観測、検証、手動判断と業務障害通知のcommandを接続する。 */
export function createWorkflowCommandRunner(
  adapters: ProductionRuntimeAdapters,
): WorkflowCommandRunner {
  return new WorkflowCommandRunner({
    notifyOperations: (command) => notifyWorkflowOperations({ adapters }, command),
    resolveDiscordDelivery: createResolveDiscordDeliveryStage(adapters),
    reportWorkflow: (command) => reportWorkflowRun(adapters, command),
    verifyCheckpoint: (command) => verifyCheckpointCommand(adapters, command),
    verifyRuntimeRecovery: (command) => verifyRuntimeRecoveryCommand(adapters, command),
    inspectRunState: (command) => inspectRunStateCommand(adapters, command),
    verifyReceiptChain: (command) => verifyReceiptChainCommand(adapters, command),
    reportFailure: (command) => reportFailureCommand(adapters, command),
  });
}

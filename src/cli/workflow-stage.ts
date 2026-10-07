import type {
  InspectRunStateCliCommand,
  ReportFailureCliCommand,
  ReportWorkflowCliCommand,
  ResolveDiscordDeliveryCliCommand,
  VerifyCheckpointCliCommand,
  VerifyReceiptChainCliCommand,
  VerifyRuntimeRecoveryCliCommand,
} from "../infrastructure/tracking-run/command-input.js";
import type { NotifyOperationsCliCommand } from "../infrastructure/tracking-run/operations-command-input.js";

/** 日次workflowの後続stageで受け付けるCLI入力。 */
export type WorkflowCliCommand =
  | ResolveDiscordDeliveryCliCommand
  | NotifyOperationsCliCommand
  | ReportWorkflowCliCommand
  | VerifyCheckpointCliCommand
  | VerifyRuntimeRecoveryCliCommand
  | InspectRunStateCliCommand
  | VerifyReceiptChainCliCommand
  | ReportFailureCliCommand;

/** workflow stageの外部副作用を注入する境界。 */
export type WorkflowCommandDependencies = Readonly<{
  resolveDiscordDelivery: (command: ResolveDiscordDeliveryCliCommand) => Promise<void>;
  notifyOperations: (command: NotifyOperationsCliCommand) => Promise<void>;
  reportWorkflow: (command: ReportWorkflowCliCommand) => Promise<void>;
  verifyCheckpoint: (command: VerifyCheckpointCliCommand) => Promise<void>;
  verifyRuntimeRecovery: (command: VerifyRuntimeRecoveryCliCommand) => Promise<void>;
  inspectRunState: (command: InspectRunStateCliCommand) => Promise<void>;
  verifyReceiptChain: (command: VerifyReceiptChainCliCommand) => Promise<void>;
  reportFailure: (command: ReportFailureCliCommand) => Promise<void>;
}>;

/** 日次workflowの後続stageを振り分ける。 */
export class WorkflowCommandRunner {
  readonly #dependencies: WorkflowCommandDependencies;

  public constructor(dependencies: WorkflowCommandDependencies) {
    this.#dependencies = dependencies;
  }

  /** 指定された一つのworkflow stageを実行する。 */
  public async run(command: WorkflowCliCommand): Promise<void> {
    switch (command.kind) {
      case "resolve-discord-delivery":
        await this.#dependencies.resolveDiscordDelivery(command);
        return;
      case "notify-operations":
        await this.#dependencies.notifyOperations(command);
        return;
      case "report-workflow":
        await this.#dependencies.reportWorkflow(command);
        return;
      case "verify-checkpoint":
        await this.#dependencies.verifyCheckpoint(command);
        return;
      case "verify-runtime-recovery":
        await this.#dependencies.verifyRuntimeRecovery(command);
        return;
      case "inspect-run-state":
        await this.#dependencies.inspectRunState(command);
        return;
      case "verify-receipt-chain":
        await this.#dependencies.verifyReceiptChain(command);
        return;
      case "report-failure":
        await this.#dependencies.reportFailure(command);
        return;
    }
  }
}

import {
  type BuildPagesCliCommand,
  type NotifyDiscordCliCommand,
  type NotifyOperationsCliCommand,
  type PersistStateCliCommand,
  type ReportWorkflowCliCommand,
} from "./command.js";

/** 日次workflowの後続stageで受け付けるCLI入力。 */
export type WorkflowStageCliCommand =
  | PersistStateCliCommand
  | BuildPagesCliCommand
  | NotifyDiscordCliCommand
  | NotifyOperationsCliCommand
  | ReportWorkflowCliCommand;

/** workflow stageの外部副作用を注入する境界。 */
export type WorkflowStageDependencies = Readonly<{
  persistState: (command: PersistStateCliCommand) => Promise<void>;
  buildPages: (command: BuildPagesCliCommand) => Promise<void>;
  notifyDiscord: (command: NotifyDiscordCliCommand) => Promise<void>;
  notifyOperations: (command: NotifyOperationsCliCommand) => Promise<void>;
  reportWorkflow: (command: ReportWorkflowCliCommand) => Promise<void>;
}>;

/** 日次workflowの後続stageを振り分ける。 */
export class WorkflowStageRunner {
  readonly #dependencies: WorkflowStageDependencies;

  public constructor(dependencies: WorkflowStageDependencies) {
    this.#dependencies = dependencies;
  }

  /** 指定された一つのworkflow stageを実行する。 */
  public async run(command: WorkflowStageCliCommand): Promise<void> {
    switch (command.kind) {
      case "persist-state":
        await this.#dependencies.persistState(command);
        return;
      case "build-pages":
        await this.#dependencies.buildPages(command);
        return;
      case "notify-discord":
        await this.#dependencies.notifyDiscord(command);
        return;
      case "notify-operations":
        await this.#dependencies.notifyOperations(command);
        return;
      case "report-workflow":
        await this.#dependencies.reportWorkflow(command);
        return;
    }
  }
}

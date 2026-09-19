import { formatCliUsage, parseCliArguments, type CliCommand } from "./command.js";
import {
  DailyTransactionRunner,
  type DailyRunExecutionResult,
  type DailyTransactionTypeMap,
} from "./daily-transaction.js";
import { StateVerificationRunner } from "./state-verification.js";
import { WorkflowStageRunner } from "./workflow-stage.js";

/** CLI実行後の終了codeとreport種別。 */
export type CliExecutionResult =
  | Readonly<{
      command: "help";
      exitCode: 0;
    }>
  | Readonly<{
      command: "daily" | "dry-run" | "backfill" | "collect-analyze";
      exitCode: 0 | 1;
      execution: "executed" | "deduplicated";
      result: DailyRunExecutionResult;
    }>
  | Readonly<{
      command:
        | "persist-state"
        | "build-pages"
        | "notify-discord"
        | "resolve-discord-delivery"
        | "notify-operations"
        | "report-workflow";
      exitCode: 0;
    }>
  | Readonly<{
      command: "verify-state";
      exitCode: 0;
    }>;

/** CLI applicationへ注入するonline、標準出力境界。 */
export type CliApplicationDependencies<Types extends DailyTransactionTypeMap> = Readonly<{
  dailyRunner: DailyTransactionRunner<Types>;
  workflowStageRunner: WorkflowStageRunner;
  stateVerificationRunner: StateVerificationRunner;
  writeStandardOutput: (source: string) => Promise<void>;
}>;

function exitCodeForStatus(status: "success" | "fallback" | "failure"): 0 | 1 {
  return status === "failure" ? 1 : 0;
}

/** 検証済みサブコマンドを対応する実行器へ振り分ける。 */
export class CliApplication<Types extends DailyTransactionTypeMap> {
  readonly #dependencies: CliApplicationDependencies<Types>;

  public constructor(dependencies: CliApplicationDependencies<Types>) {
    this.#dependencies = dependencies;
  }

  async #runCommand(command: CliCommand): Promise<CliExecutionResult> {
    switch (command.kind) {
      case "help":
        await this.#dependencies.writeStandardOutput(`${formatCliUsage()}\n`);
        return Object.freeze({
          command: "help",
          exitCode: 0,
        });
      case "daily":
      case "dry-run":
      case "backfill":
      case "collect-analyze": {
        const coordinated = await this.#dependencies.dailyRunner.run(command);
        return Object.freeze({
          command: command.kind,
          exitCode: exitCodeForStatus(coordinated.value.report.status),
          execution: coordinated.execution,
          result: coordinated.value,
        });
      }
      case "persist-state":
      case "build-pages":
      case "notify-discord":
      case "resolve-discord-delivery":
      case "notify-operations":
      case "report-workflow":
        await this.#dependencies.workflowStageRunner.run(command);
        return Object.freeze({
          command: command.kind,
          exitCode: 0,
        });
      case "verify-state":
        await this.#dependencies.stateVerificationRunner.run(command);
        return Object.freeze({
          command: command.kind,
          exitCode: 0,
        });
    }
  }

  /** process argv相当の配列を解析して一つのサブコマンドを実行する。 */
  public async run(args: readonly string[]): Promise<CliExecutionResult> {
    return this.#runCommand(parseCliArguments(args));
  }
}

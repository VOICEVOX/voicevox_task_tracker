import type { CliCommand, DryRunCliCommand } from "../infrastructure/tracking-run/command-input.js";
import type { CliExecutionResult } from "../infrastructure/tracking-run/execution-result.js";
import type { CoordinatedRunResult } from "../infrastructure/tracking-run/run-coordinator.js";
import type { DailyRunExecutionResult } from "../infrastructure/tracking-run/sequential-result.js";
import { SequentialRunRunner } from "../infrastructure/tracking-run/sequential-run.js";
import { SplitStageRunner } from "../infrastructure/tracking-run/split-stage-runner.js";
import { formatCliUsage } from "./command-usage.js";
import { parseCliArguments } from "./command.js";
import { StateVerificationRunner } from "./state-verification.js";
import type { WorkflowCommandRunner } from "./workflow-stage.js";

/** CLI applicationへ注入するonline、標準出力境界。 */
export type CliApplicationDependencies = Readonly<{
  dailyRunner: SequentialRunRunner;
  runDryRun: (
    command: DryRunCliCommand,
    invocationId: string,
  ) => Promise<CoordinatedRunResult<DailyRunExecutionResult>>;
  splitStageRunner: SplitStageRunner;
  workflowStageRunner: WorkflowCommandRunner;
  stateVerificationRunner: StateVerificationRunner;
  writeStandardOutput: (source: string) => Promise<void>;
}>;

function exitCodeForStatus(status: "success" | "fallback" | "failure"): 0 | 1 {
  return status === "failure" ? 1 : 0;
}

/** 検証済みサブコマンドを対応する実行器へ振り分ける。 */
export class CliApplication {
  readonly #dependencies: CliApplicationDependencies;

  public constructor(dependencies: CliApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  async #runCommand(command: CliCommand, invocationId: string): Promise<CliExecutionResult> {
    switch (command.kind) {
      case "help":
        await this.#dependencies.writeStandardOutput(`${formatCliUsage()}\n`);
        return Object.freeze({
          command: "help",
          exitCode: 0,
        });
      case "daily":
      case "backfill":
      case "run-sequential":
      case "collect-analyze": {
        const coordinated = await this.#dependencies.dailyRunner.run(command, invocationId);
        return Object.freeze({
          command: command.kind,
          exitCode: exitCodeForStatus(coordinated.value.report.status),
          execution: coordinated.execution,
          result: coordinated.value,
        });
      }
      case "dry-run": {
        const coordinated = await this.#dependencies.runDryRun(command, invocationId);
        return Object.freeze({
          command: command.kind,
          exitCode: exitCodeForStatus(coordinated.value.report.status),
          execution: coordinated.execution,
          result: coordinated.value,
        });
      }
      case "run-stage": {
        const outcome = await this.#dependencies.splitStageRunner.run(command, invocationId);
        if (outcome.result != null) {
          return Object.freeze({
            command: "run-stage",
            exitCode: exitCodeForStatus(outcome.result.report.status),
            execution: "executed",
            result: outcome.result,
          });
        }
        return Object.freeze({ command: "run-stage", exitCode: 0 });
      }
      case "route-stage":
        await this.#dependencies.splitStageRunner.route(command, invocationId);
        return Object.freeze({ command: "route-stage", exitCode: 0 });
      case "runtime-recovery-v2":
        await this.#dependencies.splitStageRunner.recover(command, invocationId);
        return Object.freeze({ command: "runtime-recovery-v2", exitCode: 0 });
      case "resolve-discord-delivery":
      case "notify-operations":
      case "report-workflow":
      case "verify-checkpoint":
      case "verify-runtime-recovery":
      case "inspect-run-state":
      case "verify-receipt-chain":
      case "report-failure":
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
  public async run(args: readonly string[], invocationId: string): Promise<CliExecutionResult> {
    return this.#runCommand(parseCliArguments(args), invocationId);
  }
}

import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import { SequentialRunRunner } from "./sequential-run.js";
import type {
  RecoverRuntimeV2CliCommand,
  RouteStageCliCommand,
  RunStageCliCommand,
} from "./split-command-input.js";
import { recoverSplitStageRuntime } from "./split-stage-exact-recovery.js";
import { runSplitStage, type SplitStageExecutionResult } from "./split-stage-execution.js";
import { routeSplitStage } from "./split-stage-route.js";

export type { SplitStageExecutionResult } from "./split-stage-execution.js";

/** 分割jobの一つの段階を共通stageとreceipt codecで実行する。 */
export class SplitStageRunner {
  readonly #adapters: ProductionRuntimeAdapters;
  readonly #dailyRunner: SequentialRunRunner;

  public constructor(adapters: ProductionRuntimeAdapters, dailyRunner: SequentialRunRunner) {
    this.#adapters = adapters;
    this.#dailyRunner = dailyRunner;
  }

  /** 永続bootstrapだけからV2入力を作り、exact bundleの固定入口で一段進める。 */
  public async recover(command: RecoverRuntimeV2CliCommand, invocationId: string): Promise<void> {
    await recoverSplitStageRuntime(this.#adapters, command, invocationId);
  }

  /** remote exact stateと検証済みreceiptから次の分割段階を返す。 */
  public async route(command: RouteStageCliCommand, invocationId: string): Promise<void> {
    await routeSplitStage(this.#adapters, command, invocationId);
  }

  /** 指定された分割stageを一段実行する。 */
  public async run(
    command: RunStageCliCommand,
    invocationId: string,
  ): Promise<SplitStageExecutionResult> {
    return runSplitStage(this.#adapters, this.#dailyRunner, command, invocationId);
  }
}

import { CliApplication } from "../application.js";
import { DailyTransactionRunner } from "../daily-transaction.js";
import { StateVerificationRunner } from "../state-verification.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";
import type { ProductionTypes } from "./contracts.js";
import { createDailyDependencies } from "./daily-dependencies.js";
import { createWorkflowStageRunner } from "./workflow/create-runner.js";

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createProductionCliApplication(
  adapters: ProductionRuntimeAdapters,
): CliApplication<ProductionTypes> {
  return new CliApplication({
    dailyRunner: new DailyTransactionRunner(createDailyDependencies(adapters), {
      now: adapters.now,
    }),
    workflowStageRunner: createWorkflowStageRunner(adapters),
    stateVerificationRunner: new StateVerificationRunner({
      verifyStateDirectory: adapters.verifyStateDirectory,
      writeStandardOutput: adapters.writeStandardOutput,
    }),
    writeStandardOutput: adapters.writeStandardOutput,
  });
}

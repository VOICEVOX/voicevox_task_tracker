import { runIsolatedDryRun } from "../infrastructure/tracking-run/dry-run-runtime.js";
import type { ProductionRuntimeAdapters } from "../infrastructure/tracking-run/runtime/adapters.js";
import { createDailyDependencies } from "../infrastructure/tracking-run/runtime/daily-dependencies.js";
import { SequentialRunRunner } from "../infrastructure/tracking-run/sequential-run.js";
import { SplitStageRunner } from "../infrastructure/tracking-run/split-stage-runner.js";
import { CliApplication } from "./application.js";
import { createWorkflowCommandRunner } from "./create-workflow-command-runner.js";
import { StateVerificationRunner } from "./state-verification.js";

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createProductionCliApplication(
  adapters: ProductionRuntimeAdapters,
): CliApplication {
  const dailyRunner = new SequentialRunRunner(createDailyDependencies(adapters), {
    now: adapters.now,
  });
  return new CliApplication({
    dailyRunner,
    runDryRun: (command, invocationId) => runIsolatedDryRun(adapters, command, invocationId),
    splitStageRunner: new SplitStageRunner(adapters, dailyRunner),
    workflowStageRunner: createWorkflowCommandRunner(adapters),
    stateVerificationRunner: new StateVerificationRunner({
      repositoryPath: adapters.repositoryPath,
      loadConfig: adapters.loadConfig,
      verifyStateDirectory: adapters.verifyStateDirectory,
      writeStandardOutput: adapters.writeStandardOutput,
    }),
    writeStandardOutput: adapters.writeStandardOutput,
  });
}

import { resolve } from "node:path";

import { CodexAttemptBudget } from "../../../codex/index.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  assertCodexRuntimeReady,
  readRuntimeCredentials,
  requireEnvironmentVariables,
  resolveRuntimeTarget,
} from "../../production-runtime-setup.js";
import type { ConfigurationRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;

/** AI実行試行数の読取段階を接続する。 */
export function createReadAiProcessAttemptCountStage(): ProductionDailyDependencies["readAiProcessAttemptCount"] {
  return (configuration) => configuration.codexAttemptBudget.attemptCount;
}

/** 実行設定の検証段階を既存adapterへ接続する。 */
export function createValidateConfigurationStage(
  adapters: ConfigurationRuntimeAdapters,
): ProductionDailyDependencies["validateConfiguration"] {
  return async ({ invocation, configPath }) => {
    requireEnvironmentVariables(adapters.environment, ["GH_APP_ID", "GH_APP_PRIVATE_KEY"]);
    const config = await adapters.loadConfig(resolve(adapters.repositoryPath, configPath));
    const target = await resolveRuntimeTarget(
      Object.freeze({
        repositoryPath: adapters.repositoryPath,
        ...(adapters.readSandboxContext == null
          ? {}
          : { readSandboxContext: adapters.readSandboxContext }),
        createStateBranchAdapter: adapters.createStateBranchAdapter,
      }),
      config,
      invocation.command,
    );
    const credentials = readRuntimeCredentials(
      adapters.environment,
      config,
      invocation.command,
      target.kind,
    );
    let codexReadinessPromise: Promise<void> | undefined;
    const ensureCodexReady = (): Promise<void> => {
      const codexCredentials = credentials.codex;
      if (!codexCredentials.enabled) {
        throw new TypeError("AIが有効ですがCodex認証情報がありません");
      }
      codexReadinessPromise ??= assertCodexRuntimeReady(
        Object.freeze({
          repositoryPath: adapters.repositoryPath,
          codexProcessRunner: adapters.codexProcessRunner,
        }),
        codexCredentials,
      );
      return codexReadinessPromise;
    };
    return Object.freeze({
      config,
      credentials,
      target,
      ensureCodexReady,
      codexAttemptBudget: new CodexAttemptBudget(config.ai.budget.maxCodexExecAttemptsPerRun),
    });
  };
}

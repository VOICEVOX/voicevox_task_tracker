import { resolve } from "node:path";
import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { serializeCanonicalJson } from "../../../../canonical-json/value.js";
import { CodexAttemptBudget } from "../../../../codex/index.js";
import { nodeContentDigestPort } from "../../content-digest.js";

import {
  assertCodexRuntimeReady,
  readRuntimeCredentials,
  resolveRuntimeTarget,
} from "../../production-runtime-setup.js";
import type { ConfigurationRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;

/** AI実行試行数の読取段階を接続する。 */
export function createReadAiProcessAttemptCountStage(): SequentialStageDependencies["readAiProcessAttemptCount"] {
  return (configuration) => configuration.codexAttemptBudget.attemptCount;
}

/** 実行設定の検証段階を既存adapterへ接続する。 */
export function createValidateConfigurationStage(
  adapters: ConfigurationRuntimeAdapters,
): SequentialStageDependencies["validateConfiguration"] {
  return async ({ request, baseStateHead }) => {
    const config = await adapters.loadConfig(resolve(adapters.repositoryPath, request.configPath));
    const target = await resolveRuntimeTarget(
      Object.freeze({
        repositoryPath: adapters.repositoryPath,
        ...(adapters.readSandboxContext == null
          ? {}
          : { readSandboxContext: adapters.readSandboxContext }),
        createStateBranchAdapter: adapters.createStateBranchAdapter,
      }),
      config,
      request,
    );
    const credentials = readRuntimeCredentials(adapters.environment, config, request);
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
      configDigest: nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)),
      baseStateHead,
      credentials,
      target,
      ensureCodexReady,
      codexAttemptBudget: new CodexAttemptBudget(config.ai.budget.maxCodexExecAttemptsPerRun),
    });
  };
}

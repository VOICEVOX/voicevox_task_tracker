import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import {
  executeCodexAnalysis,
  executeCodexAuthenticationPreflight,
  executeCodexPersonalReminderAnalysis,
  runCodexProcess,
} from "../codex/index.js";
import { loadConfig, type Config } from "../config/index.js";
import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createFetchDiscordWebhookHttpClient, sendDiscordDigest } from "../discord/index.js";
import {
  collectGitHubItemDetails,
  createGitHubClient,
  discoverRepositoryInventory,
  enumerateGitHubItemsByIdentifiers,
  enumerateOpenGitHubItems,
} from "../github/index.js";
import {
  writeCliJsonArtifact,
  writeCliTextFile,
} from "../infrastructure/tracking-run/file-output.js";
import type { ProductionRuntimeAdapters } from "../infrastructure/tracking-run/runtime/adapters.js";
import { parseSandboxContext } from "../infrastructure/tracking-run/sandbox-context.js";
import { deploySequentialPagesThroughActions } from "../infrastructure/tracking-run/sequential-pages-actions-port.js";
import { verifyPersistentStateDirectory } from "../infrastructure/tracking-run/state-verification.js";
import { buildWebOutput, writePublicDataFiles } from "../pages/index.js";
import { GitStateBranchAdapter, StatePersistenceSession } from "../persistence/index.js";
import type { CliApplication } from "./application.js";
import { createProductionCliApplication } from "./create-application.js";

const DEFAULT_PAGES_OUTPUT_DIRECTORY = "web/public/data";
const sandboxStateRefSchema = z.string().regex(/^sandbox-state\/env-[1-9][0-9]*-[1-9][0-9]*$/u);

async function loadTrackingConfig(
  path: string | URL,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<Config> {
  const config = await loadConfig(path);
  const effectTarget = environment["TRACKING_EFFECT_TARGET"];
  const stateRef = environment["TRACKING_STATE_REF"];
  if (effectTarget == null && stateRef == null) {
    return config;
  }
  if (
    effectTarget === "production" &&
    stateRef === "tracker-state" &&
    config.state.branch === stateRef
  ) {
    return config;
  }
  if (
    effectTarget !== "sandbox" ||
    environment["GITHUB_REPOSITORY"] !== "Hiroshiba/voicevox_task_tracker" ||
    config.state.branch !== "tracker-state"
  ) {
    throw new TypeError("workflowのeffect targetとstate設定が一致しません");
  }
  const branch = sandboxStateRefSchema.parse(stateRef);
  return Object.freeze({
    ...config,
    state: Object.freeze({ ...config.state, branch }),
  });
}

type ConcreteOperationName =
  | "collectGitHubItemDetails"
  | "discoverRepositoryInventory"
  | "enumerateGitHubItemsByIdentifiers"
  | "enumerateOpenGitHubItems"
  | "executeCodexAuthenticationPreflight"
  | "executeCodexAnalysis"
  | "executeCodexPersonalReminderAnalysis"
  | "loadConfig"
  | "openStateSession"
  | "readSandboxContext"
  | "verifyStateDirectory";

/** 合成rootへ注入する外部接続、時刻、永続化の境界。 */
export type CliCompositionAdapters = Omit<ProductionRuntimeAdapters, ConcreteOperationName>;

function createProductionAdapters(adapters: CliCompositionAdapters): ProductionRuntimeAdapters {
  return Object.freeze({
    ...adapters,
    loadConfig: (path) => loadTrackingConfig(path, adapters.environment),
    openStateSession: (adapter, configuration, migrationTimezone) =>
      StatePersistenceSession.open(adapter, configuration, migrationTimezone),
    discoverRepositoryInventory,
    enumerateGitHubItemsByIdentifiers,
    enumerateOpenGitHubItems,
    executeCodexAuthenticationPreflight,
    collectGitHubItemDetails,
    executeCodexAnalysis,
    executeCodexPersonalReminderAnalysis,
    readSandboxContext: async (path) =>
      parseSandboxContext(JSON.parse(await readFile(path, "utf8"))),
    verifyStateDirectory: verifyPersistentStateDirectory,
  });
}

/** Node.js process向けの実アダプターでexact復旧段階を組み立てる。 */
export function createDefaultProductionRuntimeAdapters(
  diagnosticsRecorder?: DiagnosticsJsonlRecorder,
): ProductionRuntimeAdapters {
  return createProductionAdapters(createDefaultCliCompositionAdapters(diagnosticsRecorder));
}

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createCliApplication(adapters: CliCompositionAdapters): CliApplication {
  return createProductionCliApplication(createProductionAdapters(adapters));
}

/** Node.js process向けの具体アダプターを生成する。 */
export function createDefaultCliCompositionAdapters(
  diagnosticsRecorder?: DiagnosticsJsonlRecorder,
): CliCompositionAdapters {
  return Object.freeze({
    environment: process.env,
    ...(diagnosticsRecorder == null ? {} : { diagnosticsRecorder }),
    repositoryPath: resolve(process.cwd()),
    pagesOutputDirectory: resolve(process.cwd(), DEFAULT_PAGES_OUTPUT_DIRECTORY),
    createGitHubClient,
    createStateBranchAdapter: () =>
      new GitStateBranchAdapter({
        repositoryPath: process.cwd(),
        gitExecutable: "git",
        authorName: "VOICEVOX Task Tracker",
        authorEmail: "voicevox-task-tracker@users.noreply.github.com",
      }),
    codexProcessRunner: runCodexProcess,
    discordHttpClient: createFetchDiscordWebhookHttpClient(),
    now: () => new Date(),
    sleep: (delayMilliseconds) =>
      new Promise<void>((resolveSleep) => {
        setTimeout(resolveSleep, delayMilliseconds);
      }),
    random: Math.random,
    writeStandardOutput: (source) => {
      process.stdout.write(source);
      return Promise.resolve();
    },
    writeJsonArtifact: writeCliJsonArtifact,
    readArtifactBytes: readFile,
    writeTextFile: writeCliTextFile,
    writePublicData: writePublicDataFiles,
    buildWebOutput,
    deployProductionPages: (intent) =>
      deploySequentialPagesThroughActions(intent, {
        environment: process.env,
        repositoryPath: resolve(process.cwd()),
        adapter: new GitStateBranchAdapter({
          repositoryPath: process.cwd(),
          gitExecutable: "git",
          authorName: "VOICEVOX Task Tracker",
          authorEmail: "voicevox-task-tracker@users.noreply.github.com",
        }),
        now: () => new Date(),
      }),
    sendDiscord: sendDiscordDigest,
  });
}

/** Node.js process向けの実アダプターでCLI applicationを組み立てる。 */
export function createDefaultCliApplication(
  diagnosticsRecorder?: DiagnosticsJsonlRecorder,
): CliApplication {
  return createCliApplication(createDefaultCliCompositionAdapters(diagnosticsRecorder));
}

import { resolve } from "node:path";

import { executeCodexAnalysis, runCodexProcess } from "../codex/index.js";
import { loadConfig } from "../config/index.js";
import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { createFetchDiscordWebhookHttpClient, sendDiscordDigest } from "../discord/index.js";
import {
  collectGitHubItemDetails,
  createGitHubClient,
  discoverRepositoryInventory,
  enumerateGitHubItemsByIdentifiers,
  enumerateOpenGitHubItems,
} from "../github/index.js";
import { writePublicDataFiles } from "../pages/index.js";
import { GitStateBranchAdapter, StatePersistenceSession } from "../persistence/index.js";
import { type CliApplication } from "./application.js";
import { writeCliJsonArtifact, writeCliTextFile } from "./file-output.js";
import {
  readGoldenFixtureFiles,
  readReplayFixtureFile,
  readReplayStateFile,
} from "./offline-runner.js";
import {
  createProductionCliApplication,
  type ProductionRuntimeAdapters,
  type ProductionTypes,
} from "./production-runtime.js";
import { verifyPersistentStateDirectory } from "./state-verification.js";
import { readWorkflowArtifactFile } from "./workflow-artifact.js";

const DEFAULT_PAGES_OUTPUT_DIRECTORY = "artifacts/workflow/pages";

type ConcreteOperationName =
  | "collectGitHubItemDetails"
  | "discoverRepositoryInventory"
  | "enumerateGitHubItemsByIdentifiers"
  | "enumerateOpenGitHubItems"
  | "executeCodexAnalysis"
  | "loadConfig"
  | "openStateSession"
  | "readGoldenFixtures"
  | "readReplayFixture"
  | "readReplayState"
  | "readWorkflowArtifact"
  | "verifyStateDirectory";

/** 合成rootへ注入する外部接続、時刻、永続化の境界。 */
export type CliCompositionAdapters = Omit<ProductionRuntimeAdapters, ConcreteOperationName>;

function createProductionAdapters(adapters: CliCompositionAdapters): ProductionRuntimeAdapters {
  return Object.freeze({
    ...adapters,
    loadConfig,
    openStateSession: (adapter, configuration) =>
      StatePersistenceSession.open(adapter, configuration),
    discoverRepositoryInventory,
    enumerateGitHubItemsByIdentifiers,
    enumerateOpenGitHubItems,
    collectGitHubItemDetails,
    executeCodexAnalysis,
    readReplayFixture: readReplayFixtureFile,
    readReplayState: readReplayStateFile,
    readGoldenFixtures: readGoldenFixtureFiles,
    readWorkflowArtifact: readWorkflowArtifactFile,
    verifyStateDirectory: verifyPersistentStateDirectory,
  });
}

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createCliApplication(
  adapters: CliCompositionAdapters,
): CliApplication<ProductionTypes> {
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
    writeTextFile: writeCliTextFile,
    writePublicData: writePublicDataFiles,
    sendDiscord: sendDiscordDigest,
  });
}

/** Node.js process向けの実アダプターでCLI applicationを組み立てる。 */
export function createDefaultCliApplication(
  diagnosticsRecorder?: DiagnosticsJsonlRecorder,
): CliApplication<ProductionTypes> {
  return createCliApplication(createDefaultCliCompositionAdapters(diagnosticsRecorder));
}

export { type ProductionTypes } from "./production-runtime.js";

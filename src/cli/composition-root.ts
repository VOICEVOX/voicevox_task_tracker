import { resolve } from "node:path";

import { executeCodexAnalysis, runCodexProcess } from "../codex/index.js";
import { loadConfig } from "../config/index.js";
import { createFetchDiscordWebhookHttpClient, sendDiscordDigest } from "../discord/index.js";
import {
  collectGitHubItemDetails,
  createGitHubClient,
  discoverRepositoryInventory,
  enumerateGitHubItemsByIdentifiers,
  enumerateOpenGitHubItems,
  probeGitHubPullRequestVolatileMetadataWithRetry,
  resolveGitHubRelationReference,
} from "../github/index.js";
import { writePublicDataFiles } from "../pages/index.js";
import { CacheOnlyPersistenceSession, GitStateBranchAdapter } from "../persistence/index.js";
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
  | "probeGitHubPullRequestVolatileMetadataWithRetry"
  | "resolveGitHubRelationReference"
  | "executeCodexAnalysis"
  | "loadConfig"
  | "openCacheSession"
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
    openCacheSession: (adapter, configuration, allowlist) =>
      CacheOnlyPersistenceSession.open(
        adapter,
        {
          branch: configuration.branch,
          repositoryCacheDirectory: configuration.repositoryCacheDirectory,
          itemCacheDirectory: configuration.itemCacheDirectory,
          latestImportanceDirectory: configuration.latestImportanceDirectory,
          aiCacheDirectory: configuration.aiCacheDirectory,
        },
        allowlist,
      ),
    discoverRepositoryInventory,
    enumerateGitHubItemsByIdentifiers,
    enumerateOpenGitHubItems,
    probeGitHubPullRequestVolatileMetadataWithRetry,
    resolveGitHubRelationReference,
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
export function createDefaultCliCompositionAdapters(): CliCompositionAdapters {
  return Object.freeze({
    environment: process.env,
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
export function createDefaultCliApplication(): CliApplication<ProductionTypes> {
  return createCliApplication(createDefaultCliCompositionAdapters());
}

export { type ProductionTypes } from "./production-runtime.js";

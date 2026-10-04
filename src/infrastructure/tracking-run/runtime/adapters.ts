import type { PagesDeploymentIntent } from "../../../application/tracking-run/pages-build-contracts.js";
import type {
  CodexAdapterConfiguration,
  CodexAdapterDependencies,
  CodexAnalysisInput,
  CodexProcessRunner,
} from "../../../codex/index.js";
import type { loadConfig } from "../../../config/index.js";
import type { DiagnosticsJsonlRecorder } from "../../../diagnostics/recorder.js";
import type { DiscordWebhookHttpClient, sendDiscordDigest } from "../../../discord/index.js";
import type {
  CreateGitHubClientOptions,
  GitHubClient,
  collectGitHubItemDetails,
  discoverRepositoryInventory,
  enumerateGitHubItemsByIdentifiers,
  enumerateOpenGitHubItems,
} from "../../../github/index.js";
import type { GeneratedPublicData, PublicDataWriteResult } from "../../../pages/index.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
  StatePersistenceSession,
} from "../../../persistence/index.js";
import type { SequentialPagesResult } from "../initial-pages-deployment.js";
import type { SandboxRunContext } from "../sandbox-context.js";
import type { verifyPersistentStateDirectory } from "../state-verification.js";

/** 日次実行配線へ注入する外部接続、時刻、永続化の境界。 */
export type ProductionRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
  ) => Promise<StatePersistenceSession>;
  readSandboxContext?: (path: string) => Promise<SandboxRunContext>;
  discoverRepositoryInventory: typeof discoverRepositoryInventory;
  enumerateGitHubItemsByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  enumerateOpenGitHubItems: typeof enumerateOpenGitHubItems;
  collectGitHubItemDetails: typeof collectGitHubItemDetails;
  executeCodexAnalysis: (
    input: CodexAnalysisInput,
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<unknown>;
  executeCodexPersonalReminderAnalysis: (
    batch: import("../../../application/tracking-run/stages/personal-reminder-plan-contracts.js").PersonalReminderPlannedBatch,
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<
    import("../../../codex/personal-reminder-output.js").SchemaValidPersonalReminderAiOutput
  >;
  executeCodexAuthenticationPreflight: (
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<void>;
  verifyStateDirectory: typeof verifyPersistentStateDirectory;
  createGitHubClient: (options: CreateGitHubClientOptions) => Promise<GitHubClient>;
  createStateBranchAdapter: () => StateBranchAdapter;
  codexProcessRunner: CodexProcessRunner;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  writeStandardOutput: (source: string) => Promise<void>;
  writeJsonArtifact: (path: string, value: unknown) => Promise<void>;
  readArtifactBytes: (path: string) => Promise<Uint8Array>;
  writeTextFile: (path: string, source: string) => Promise<void>;
  writePublicData: (
    outputDirectory: string,
    data: GeneratedPublicData,
  ) => Promise<PublicDataWriteResult>;
  buildWebOutput: (repositoryPath: string) => Promise<void>;
  deployProductionPages: (intent: PagesDeploymentIntent) => Promise<SequentialPagesResult>;
  sendDiscord: typeof sendDiscordDigest;
}>;

export type ConfigurationRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "environment"
  | "repositoryPath"
  | "loadConfig"
  | "readSandboxContext"
  | "createStateBranchAdapter"
  | "codexProcessRunner"
  | "readArtifactBytes"
>;

export type StateRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "createStateBranchAdapter" | "openStateSession"
>;

export type GitHubAuthenticationRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "createGitHubClient"
>;

export type RepositoryInventoryRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "discoverRepositoryInventory"
>;

export type CollectionRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "enumerateGitHubItemsByIdentifiers"
  | "enumerateOpenGitHubItems"
  | "collectGitHubItemDetails"
  | "now"
  | "sleep"
>;

export type CodexRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "diagnosticsRecorder"
  | "codexProcessRunner"
  | "sleep"
  | "random"
  | "executeCodexAnalysis"
  | "executeCodexAuthenticationPreflight"
>;

export type PersonalReminderRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "diagnosticsRecorder"
  | "codexProcessRunner"
  | "sleep"
  | "random"
  | "executeCodexPersonalReminderAnalysis"
  | "executeCodexAuthenticationPreflight"
>;

export type PublicationRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  | "environment"
  | "repositoryPath"
  | "pagesOutputDirectory"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "now"
  | "sleep"
  | "random"
  | "writeJsonArtifact"
  | "writePublicData"
  | "buildWebOutput"
  | "deployProductionPages"
  | "sendDiscord"
>;

export type ArtifactRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "repositoryPath" | "writeJsonArtifact" | "writeTextFile"
>;

export type WorkflowRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "repositoryPath" | "writeJsonArtifact" | "writeStandardOutput" | "verifyStateDirectory"
>;

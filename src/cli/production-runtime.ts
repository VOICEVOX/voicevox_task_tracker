import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
  createCodexEnvironment,
  createCodexAnalysisInput,
  estimateAiInputCost,
  getCodexEnvironmentVariableAllowlist,
  hashCanonicalJson,
  prepareAiAnalysisCandidate,
  recordCodexDiagnostic,
  reduceCodexAnalysis,
  reduceCodexInputValidationFailure,
  runAiAnalyses,
  serializeCanonicalJson,
  type AiAnalysisCandidate,
  type AiAnalysisRunFailure,
  type AiAnalysisRunIdentity,
  type AiAnalysisRunResult,
  type CodexAnalysisInput,
  type CodexAdapterConfiguration,
  type CodexAdapterDependencies,
  type CodexAnalysisReduction,
  type CodexProcessRunner,
  type DeterministicCodexDecision,
  type PreparedAiAnalysisCandidate,
  type ReducedCodexDecision,
  type ValidatedCodexAnalysisOutput,
} from "../codex/index.js";
import { type CodexDiagnosticsContext } from "../codex/index.js";
import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import { type Config, type loadConfig } from "../config/index.js";
import {
  aggregatePullRequestCheckState,
  aggregatePullRequestReviewState,
  calculateAttention,
  calculateImportance,
  combineImportance,
  classifyTrackingNotification,
  createNotificationReason,
  createUtcIsoDateTime,
  createGitHubNodeId,
  createGitHubBotPredicate,
  createLabelEffectsResolver,
  createTrackedItemLatestEventActor,
  createStalenessNotificationSeverityReason,
  calculateStaleness,
  determineDeadlineLevel,
  DETERMINISTIC_RULES_VERSION,
  recalculateStalenessSeverity,
  determineIssueState,
  determineMeaningfulProgress,
  determinePullRequestState,
  determineTerminalRetention,
  determineTrackedItemWork,
  isTerminalStatus,
  ISSUE_DETERMINISTIC_RULES_VERSION,
  parseSourceId,
  PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
  resolvePullRequestCommitOccurredAt,
  resolveTrackingStartAt,
  resolveRepositoryMaintainers,
  resolveWaitingOnAccountIdentifiers,
  selectTrackingItems,
  type LabelRule,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type GraphNodeId,
  type IssueBlocker,
  type IssueEffectiveAssigneeAssessment,
  type IssueEffectiveAssigneeCandidate,
  type IssueEffectiveAssigneeTarget,
  type IssueExplicitRequestAssessment,
  type IssueExplicitRequestTarget,
  type IssueStateDecision,
  type BlockedParentContext,
  type BlockerRanking,
  type NormalizedEvent,
  type OrganizationTrackingCandidate,
  type TrackingCandidate,
  type PullRequestStateDecision,
  type PullRequestCheckFailureAssessment,
  type PrimaryWaitingOn,
  type Relation,
  type RetentionItemState,
  type Repository,
  type SourceId,
  type Severity,
  type StalenessSeverityContext,
  type StalenessNotificationSeverityReason,
  type StalenessWaitClass,
  type StalenessResult,
  type NaturalLanguageProgressAssessment,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
  type DependencyResolutionProgress,
  type DeadlineLevel,
  type ExternalGhostNode,
  type TrackedItem,
  type TrackedItemAiAnalysis,
  type TrackedItemInputEvent,
  type TrackingConnection,
  type TrackingNotificationClass,
  type TrackingRunCompletion,
  type TrackingStartAtState,
  type TrackedItemWorkDecision,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  createDismissedNotificationLedgerEntries,
  selectDiscordNotifications,
  type sendDiscordDigest,
  type DiscordDigestDelivery,
  type DiscordDeliverySettings,
  type DiscordNotificationItem,
  type DiscordNotificationSelection,
  type DiscordOperationsIncident,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
import { analyzeGoldenFixture, goldenEvalInputSchema } from "../eval/index.js";
import {
  type collectGitHubItemDetails,
  collectRepositoriesWithStaleFallback,
  createPublicRepositoryAllowlist,
  deduplicateByStableId,
  type discoverRepositoryInventory,
  type enumerateGitHubItemsByIdentifiers,
  type enumerateOpenGitHubItems,
  markObservedGitHubItemsStale,
  normalizeObservedGitHubItems,
  planIncrementalItemCollection,
  parseGitHubAppCredentials,
  type CreateGitHubClientOptions,
  type CurrentAnalysisRulesFingerprints,
  type EnumeratedGitHubItem,
  type FreshObservedGitHubItem,
  type GitHubAppCredentials,
  type GitHubClient,
  type GitHubCheckContext,
  type GitHubItemDetail,
  type PublicRepository,
  type PublicRepositoryAllowlist,
  type PreviousItemCollection,
  type RepositoryCollectionResult,
  type StaleObservedGitHubItem,
} from "../github/index.js";
import {
  analyzeGraph,
  extractRelationCandidates,
  normalizeRelationCandidates,
  planRelationExpansion,
  reconcileGraph,
  type AnalyzeGraphResult,
  type CandidateRelation,
  type PublicGitHubRelationItem,
  type ReconciledGraphEdge,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type ReconcileGraphResult,
  type RelationCandidate,
  type RelationCandidateAssessment,
  type RelationCandidateNode,
  type RelationCandidateId,
} from "../graph/index.js";
import {
  generatePublicData,
  PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  type GeneratedPublicData,
  type PublicDataWriteResult,
  type PagesPublicSafetyInput,
} from "../pages/index.js";
import {
  createStateHistoryInputEvents,
  createStateNotificationLedger,
  createStateRunReport,
  createStateSnapshot,
  type StatePersistenceSession,
  type PersistStateTransactionResult,
  type SnapshotAiState,
  type SnapshotCollectionItem,
  type SnapshotCollectionRepository,
  type SnapshotRepository,
  type SnapshotTrackedItem,
  type StateBranchAdapter,
  type StateNotificationLedger,
  type StateRunReport,
  type StateHistoryRecord,
  type StateHistoryInputEvent,
  type StateHistoryNotificationEvent,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import { resolveStateHistoryNotificationItemDisplayReference } from "../persistence/history.js";
import { NOTIFICATION_LEDGER_SCHEMA_VERSION_4 } from "../persistence/state-documents.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { CliApplication } from "./application.js";
import { createTrackingBackfillRequest } from "./backfill.js";
import {
  type BuildPagesCliCommand,
  type NotifyDiscordCliCommand,
  type NotifyOperationsCliCommand,
  type PersistStateCliCommand,
  type ReportWorkflowCliCommand,
} from "./command.js";
import { type OnlineCliCommand } from "./daily-transaction.js";
import {
  DailyTransactionRunner,
  type DailyTransactionDependencies,
  type DailyTransactionTypeMap,
  type DailyRunInvocation,
} from "./daily-transaction.js";
import {
  CliCodexAuthenticationError,
  CliCredentialsError,
  CliExecutableError,
  CliRelationExpansionLimitError,
} from "./errors.js";
import { safeCodexFallbackDiagnostic } from "./error-diagnostic.js";
import {
  OfflineRunRunner,
  type readGoldenFixtureFiles,
  type readReplayFixtureFile,
  type readReplayStateFile,
  type OfflineAnalysisMetrics,
  type OfflineAnalysisResult,
  type ReplayFixture,
} from "./offline-runner.js";
import { writeRunReport, type RunMetrics } from "./run-report.js";
import {
  StateVerificationRunner,
  type verifyPersistentStateDirectory,
} from "./state-verification.js";
import {
  assertWorkflowArtifactPublicSafety,
  createWorkflowArtifact,
  createWorkflowRunMetadata,
  type readWorkflowArtifactFile,
  workflowArtifactRepositoryInventory,
  type WorkflowArtifact,
  type WorkflowRunMetadata,
} from "./workflow-artifact.js";
import { createWorkflowRunReport, readOptionalRunReportFile } from "./workflow-run-report.js";
import { WorkflowStageRunner } from "./workflow-stage.js";

const CODEX_CLI_VERSION = "0.145.0";
const CODEX_BACKEND_VERSION = `codex-cli-${CODEX_CLI_VERSION}`;
const CODEX_SCHEMA_VERSION = "4";
const PAGES_BASE_URL = "https://voicevox.github.io";
const GITHUB_MENTION_PATTERN =
  /(?<![A-Za-z0-9-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99})))?/gu;
const CURRENT_DETERMINISTIC_RULES_VERSIONS = Object.freeze({
  issue: ISSUE_DETERMINISTIC_RULES_VERSION,
  pull_request: PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
}) satisfies Readonly<Record<TrackedItem["type"], string>>;

type EnabledCodexCredentials = Readonly<{
  enabled: true;
  authentication: Config["ai"]["authentication"];
  environment: Readonly<Record<string, string>>;
}>;

type RuntimeCodexCredentials =
  | Readonly<{
      enabled: false;
    }>
  | EnabledCodexCredentials;

type RuntimeCredentials = Readonly<{
  github: GitHubAppCredentials;
  codex: RuntimeCodexCredentials;
  knownSecrets: readonly string[];
}>;

type RuntimeConfiguration = Readonly<{
  config: Config;
  credentials: RuntimeCredentials;
}>;

function createAiAnalysisRunIdentity(config: Config): AiAnalysisRunIdentity {
  return Object.freeze({
    deterministicRulesVersion: DETERMINISTIC_RULES_VERSION,
    model: config.ai.model,
    reasoningEffort: config.ai.execution.reasoningEffort,
    backendVersion: CODEX_BACKEND_VERSION,
    promptVersion: config.ai.promptVersion,
    schemaVersion: CODEX_SCHEMA_VERSION,
  });
}

function createCurrentAnalysisRulesFingerprints(config: Config): CurrentAnalysisRulesFingerprints {
  const identityHash = hashCanonicalJson(createAiAnalysisRunIdentity(config));
  return Object.freeze({
    issue: hashCanonicalJson({
      deterministicRulesVersion: CURRENT_DETERMINISTIC_RULES_VERSIONS.issue,
      identityHash,
    }),
    pull_request: hashCanonicalJson({
      deterministicRulesVersion: CURRENT_DETERMINISTIC_RULES_VERSIONS.pull_request,
      identityHash,
    }),
  });
}

type RuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  notificationLedger: StateNotificationLedger;
}>;

type RepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
}>;

type CollectedItems = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  staleItems: readonly StaleObservedGitHubItem<SnapshotCollectionItem>[];
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
  trackingNotificationClassByNodeId: ReadonlyMap<GitHubNodeId, TrackingNotificationClass>;
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  externalReferences: readonly ExternalGhostNode[];
  relationCandidates: readonly RelationCandidate[];
  repositoryResults: readonly RepositoryCollectionResult<SnapshotCollectionRepository>[];
  collectionRepositories: readonly SnapshotCollectionRepository[];
}>;

type FreshRepositoryItemCollection = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  changedNodeIds: readonly GitHubNodeId[];
}>;

type FreshRepositoryRuntimeCollection = FreshRepositoryItemCollection &
  Readonly<{
    state: SnapshotCollectionRepository;
  }>;

type FreshRuntimeCollectionAggregate = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  changedNodeIds: ReadonlySet<GitHubNodeId>;
}>;

type RelationExpandedRuntimeCollection = FreshRuntimeCollectionAggregate &
  Readonly<{
    evaluatedAt: UtcIsoDateTime;
    relationCandidates: readonly RelationCandidate[];
    droppedRelationCandidateCount: number;
    tracking: RuntimeTrackingSelection;
  }>;

type RuntimeTrackingSelection = Readonly<{
  result: ReturnType<typeof selectTrackingItems>;
  workByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemWorkDecision>;
  excludedCandidateCount: number;
}>;

type MentionedWaitingOnCandidate = Readonly<{
  id: string;
  kind: "user" | "team";
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

type EffectiveAssigneeSourceContext = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
}>;

type EffectiveAssigneeCandidateContext = Readonly<{
  candidate: IssueEffectiveAssigneeCandidate;
  sourceContexts: readonly EffectiveAssigneeSourceContext[];
}>;

type EffectiveAssigneeCollectionContext = Readonly<
  Pick<CollectedItems, "observedItems" | "details" | "trackedNodeIds">
>;

type DeterministicItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: IssueStateDecision | PullRequestStateDecision;
  notificationClass: TrackingNotificationClass;
  relationCandidates: readonly RelationCandidate[];
  effectiveAssigneeCandidates: readonly EffectiveAssigneeCandidateContext[];
}>;

type DeterministicAnalysis = Readonly<{
  items: readonly DeterministicItemAnalysis[];
  state: RuntimeState;
  inventory: RepositoryInventory;
}>;

type CodexAnalysis = Readonly<{
  run: AiAnalysisRunResult | undefined;
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
}>;

type ReducedItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: ReducedCodexDecision;
  notificationRecommendation: DiscordNotificationItem["notificationRecommendation"];
  primaryWaitingOn: PrimaryWaitingOn;
  staleness: StalenessResult;
  importanceAssessment: NaturalLanguageImportanceAssessmentState;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
}>;

type TrackedItemStaleness = Readonly<{
  elapsedHours: number;
  severity: Severity;
  severityReason: StalenessNotificationSeverityReason;
  waitClass: StalenessWaitClass;
  severityContext: StalenessSeverityContext;
}>;

type WithoutImportance<T> = T extends unknown ? Omit<T, "importance"> : never;
type PendingTrackedItem = WithoutImportance<TrackedItem>;
type TrackedItemWithImportanceAssessment = TrackedItem &
  Readonly<{
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  }>;

type ReducedAnalysis = Readonly<{
  items: readonly PendingTrackedItem[];
  currentItems: readonly ReducedItemAnalysis[];
  stalenessByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemStaleness>;
  relationAssessments: readonly RelationCandidateAssessment[];
  runStatus: "success" | "fallback";
}>;

type GraphResult = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  externalReferences: readonly ExternalGhostNode[];
  analysis: AnalyzeGraphResult;
  previousAnalysis:
    | Readonly<{
        availability: "unavailable";
      }>
    | Readonly<{
        availability: "available";
        value: AnalyzeGraphResult;
      }>;
}>;

type ValidatedRun = Readonly<{
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  notificationLedger: StateNotificationLedger;
  notificationSelection: DiscordNotificationSelection;
}>;

type PersistedRun = Readonly<{
  result: PersistStateTransactionResult;
  historyRecords: readonly StateHistoryRecord[];
  notificationLedger: StateNotificationLedger;
}>;

type PagesResult = Readonly<{
  data: GeneratedPublicData;
  output: PublicDataWriteResult;
  pagesUrl: string;
}>;

type DiscordDeliveryResult = Readonly<{
  delivery: DiscordDigestDelivery;
  notificationEvents: readonly StateHistoryNotificationEvent[];
}>;

type DiscordResult = DiscordDeliveryResult &
  Readonly<{
    notificationLedger: StateNotificationLedger;
  }>;

export type ProductionTypes = DailyTransactionTypeMap &
  Readonly<{
    configuration: RuntimeConfiguration;
    state: RuntimeState;
    authentication: GitHubClient;
    repositoryInventory: RepositoryInventory;
    collection: CollectedItems;
    deterministicAnalysis: DeterministicAnalysis;
    codexAnalysis: CodexAnalysis;
    reduction: ReducedAnalysis;
    graph: GraphResult;
    validated: ValidatedRun;
    persisted: PersistedRun;
    pages: PagesResult;
    discord: DiscordResult;
  }>;

/** 日次実行配線へ注入する外部接続、時刻、永続化の境界。 */
export type ProductionRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: Config["state"],
  ) => Promise<StatePersistenceSession>;
  discoverRepositoryInventory: typeof discoverRepositoryInventory;
  enumerateGitHubItemsByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  enumerateOpenGitHubItems: typeof enumerateOpenGitHubItems;
  collectGitHubItemDetails: typeof collectGitHubItemDetails;
  executeCodexAnalysis: (
    input: CodexAnalysisInput,
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<unknown>;
  executeCodexAuthenticationPreflight: (
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<void>;
  readReplayFixture: typeof readReplayFixtureFile;
  readReplayState: typeof readReplayStateFile;
  readGoldenFixtures: typeof readGoldenFixtureFiles;
  readWorkflowArtifact: typeof readWorkflowArtifactFile;
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
  writeTextFile: (path: string, source: string) => Promise<void>;
  writePublicData: (
    outputDirectory: string,
    data: GeneratedPublicData,
  ) => Promise<PublicDataWriteResult>;
  sendDiscord: typeof sendDiscordDigest;
}>;

function currentRuntimeTime(adapters: ProductionRuntimeAdapters): UtcIsoDateTime {
  const now = adapters.now();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("production runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(now.toISOString());
}

function requireEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableName: string,
): string {
  const value = environment[variableName];
  if (value == null || value.trim().length === 0) {
    throw new CliCredentialsError([variableName], {});
  }
  return value;
}

function requireEnvironmentVariables(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableNames: readonly string[],
): void {
  const missingVariableNames = variableNames.filter((variableName) => {
    const value = environment[variableName];
    return value == null || value.trim().length === 0;
  });
  if (missingVariableNames.length > 0) {
    throw new CliCredentialsError(missingVariableNames, {});
  }
}

function readCodexCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
  config: Config,
): RuntimeCodexCredentials {
  if (!config.ai.enabled) {
    return Object.freeze({
      enabled: false,
    });
  }
  const authentication = config.ai.authentication;
  requireEnvironmentVariables(environment, getCodexEnvironmentVariableAllowlist(authentication));
  return Object.freeze({
    enabled: true,
    authentication,
    environment: createCodexEnvironment(authentication, environment),
  });
}

function codexKnownSecrets(credentials: RuntimeCodexCredentials): readonly string[] {
  if (!credentials.enabled) {
    return Object.freeze([]);
  }
  switch (credentials.authentication) {
    case "api-key": {
      const openAiApiKey = credentials.environment["OPENAI_API_KEY"];
      assertNonNullable(openAiApiKey, "組み立て済みCodex環境にOPENAI_API_KEYがありません");
      return Object.freeze([openAiApiKey]);
    }
    case "auth-json":
      return Object.freeze([]);
    default:
      throw new UnreachableError(credentials.authentication);
  }
}

function readRuntimeCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
  config: Config,
  command: OnlineCliCommand,
): RuntimeCredentials {
  requireEnvironmentVariables(environment, ["GH_APP_ID", "GH_APP_PRIVATE_KEY"]);
  let github: GitHubAppCredentials;
  try {
    github = parseGitHubAppCredentials(environment);
  } catch (error: unknown) {
    const variableNames =
      error instanceof Error &&
      "variableNames" in error &&
      Array.isArray(error.variableNames) &&
      error.variableNames.every((value) => typeof value === "string")
        ? error.variableNames
        : ["GH_APP_ID", "GH_APP_PRIVATE_KEY"];
    throw new CliCredentialsError(variableNames, { cause: error });
  }
  const codex = readCodexCredentials(environment, config);
  const knownSecrets = [github.privateKey, ...codexKnownSecrets(codex)];
  if (config.notifications.discord.enabled) {
    switch (command.kind) {
      case "daily":
      case "backfill":
        switch (command.notificationAction) {
          case "send":
            knownSecrets.push(
              requireEnvironmentValue(environment, config.notifications.discord.webhookSecretName),
              requireEnvironmentValue(
                environment,
                config.notifications.discord.operationsWebhookSecretName,
              ),
            );
            break;
          case "dismiss-current":
            knownSecrets.push(
              requireEnvironmentValue(
                environment,
                config.notifications.discord.operationsWebhookSecretName,
              ),
            );
            break;
          default:
            throw new UnreachableError(command.notificationAction);
        }
        break;
      case "dry-run":
      case "collect-analyze":
        break;
      default:
        throw new UnreachableError(command);
    }
  }
  return Object.freeze({
    github,
    codex,
    knownSecrets: Object.freeze(knownSecrets),
  });
}

function normalizeLabelRules(config: Config): readonly LabelRule[] {
  return Object.freeze(
    config.labels.rules.map((rule) => {
      const effects: {
        priorityWeight?: number;
        severityLift?: number;
        requiresMaintainerDecision?: boolean;
        suppressNotifications?: boolean;
        countsAsProgress?: boolean;
      } = {};
      if (rule.effects.priorityWeight != null) {
        effects.priorityWeight = rule.effects.priorityWeight;
      }
      if (rule.effects.severityLift != null) {
        effects.severityLift = rule.effects.severityLift;
      }
      if (rule.effects.requiresMaintainerDecision != null) {
        effects.requiresMaintainerDecision = rule.effects.requiresMaintainerDecision;
      }
      if (rule.effects.suppressNotifications != null) {
        effects.suppressNotifications = rule.effects.suppressNotifications;
      }
      if (rule.effects.countsAsProgress != null) {
        effects.countsAsProgress = rule.effects.countsAsProgress;
      }
      return Object.freeze({
        repository: rule.repository,
        namePattern: rule.namePattern,
        effects: Object.freeze(effects),
      });
    }),
  );
}

async function assertCodexAuthenticationAvailable(
  credentials: EnabledCodexCredentials,
): Promise<void> {
  switch (credentials.authentication) {
    case "api-key":
      return;
    case "auth-json": {
      const codexHome = credentials.environment["CODEX_HOME"];
      assertNonNullable(codexHome, "組み立て済みCodex環境にCODEX_HOMEがありません");
      try {
        const authJsonStat = await stat(join(codexHome, "auth.json"));
        if (!authJsonStat.isFile()) {
          throw new TypeError("CODEX_HOME直下のauth.jsonがファイルではありません");
        }
      } catch (error: unknown) {
        throw new CliCodexAuthenticationError({ cause: error });
      }
      return;
    }
    default:
      throw new UnreachableError(credentials.authentication);
  }
}

async function assertCodexCliAvailable(
  adapters: ProductionRuntimeAdapters,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  let result: Awaited<ReturnType<CodexProcessRunner>>;
  try {
    result = await adapters.codexProcessRunner({
      command: "codex",
      arguments: ["--version"],
      workingDirectory: adapters.repositoryPath,
      environment,
      standardInput: "",
      timeoutMilliseconds: 10_000,
    });
  } catch (error: unknown) {
    throw new CliExecutableError("codex", { cause: error });
  }
  if (result.timedOut || result.exitCode !== 0 || result.signal != null) {
    throw new CliExecutableError("codex", {
      cause: new Error("Codex CLIのversion確認が正常終了しませんでした"),
    });
  }
}

function githubApiRemaining(client: GitHubClient): number {
  return client.getRateLimitSnapshot()?.remaining ?? 0;
}

function previousSnapshot(state: RuntimeState): StateSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot.snapshot : undefined;
}

function normalizeTrackingIdentifier(identifier: string): string {
  if (identifier.includes("://") && identifier.endsWith("/")) {
    return identifier.slice(0, -1);
  }
  return identifier;
}

function previousCollectionRepository(
  state: RuntimeState,
  repositoryId: GitHubRepositoryId,
): SnapshotCollectionRepository | undefined {
  return previousSnapshot(state)?.collection.repositories.find(
    (repository) => repository.repositoryId === repositoryId,
  );
}

function previousCollectionItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotCollectionItem> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item] as const),
    ),
  );
}

function createSnapshotCollectionItem(item: EnumeratedGitHubItem): SnapshotCollectionItem {
  if (item.state === "open") {
    return Object.freeze({
      freshness: "fresh",
      nodeId: item.nodeId,
      repositoryId: item.repositoryId,
      itemFingerprint: item.itemFingerprint,
      aiAnalysisFingerprint: Object.freeze({
        status: "unavailable",
      }),
      analysisRulesFingerprint: Object.freeze({
        status: "unavailable",
      }),
      deterministicRulesVersion: Object.freeze({
        status: "unavailable",
      }),
      observedAt: item.observedAt,
      state: "open",
      terminalAt: null,
    });
  }
  return Object.freeze({
    freshness: "fresh",
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    itemFingerprint: item.itemFingerprint,
    aiAnalysisFingerprint: Object.freeze({
      status: "unavailable",
    }),
    analysisRulesFingerprint: Object.freeze({
      status: "unavailable",
    }),
    deterministicRulesVersion: Object.freeze({
      status: "unavailable",
    }),
    observedAt: item.observedAt,
    state: "closed",
    terminalAt: item.closedAt,
  });
}

function createSnapshotCollectionRepository(
  repository: PublicRepository,
  successfulAt: UtcIsoDateTime,
  items: readonly EnumeratedGitHubItem[],
): SnapshotCollectionRepository {
  return Object.freeze({
    repositoryId: repository.id,
    successfulAt,
    items: Object.freeze(items.map(createSnapshotCollectionItem)),
  });
}

function previousItemCollection(
  state: RuntimeState,
  repository: PublicRepository,
): PreviousItemCollection {
  const previous = previousCollectionRepository(state, repository.id);
  if (previous == null) {
    return Object.freeze({
      status: "none",
    });
  }
  return Object.freeze({
    status: "successful",
    items: new Map(
      previous.items.map((item) => [
        item.nodeId,
        Object.freeze({
          itemFingerprint: item.itemFingerprint,
          analysisRulesFingerprint: item.analysisRulesFingerprint,
        }),
      ]),
    ),
  });
}

function previousGraphAdjacentNodeIds(state: RuntimeState): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  const snapshot = previousSnapshot(state);
  const trackedNodeIds = new Set<string>(snapshot?.items.map((item) => item.nodeId) ?? []);
  for (const relation of snapshot?.relations ?? []) {
    if (!relation.active) {
      continue;
    }
    if (trackedNodeIds.has(relation.fromNodeId)) {
      nodeIds.add(createGitHubNodeId(relation.fromNodeId));
    }
    if (trackedNodeIds.has(relation.toNodeId)) {
      nodeIds.add(createGitHubNodeId(relation.toNodeId));
    }
  }
  return nodeIds;
}

function explicitIdentifierMatchesItem(
  explicitIncludes: readonly string[],
  item: Readonly<{ nodeId: GitHubNodeId; url: string }>,
): boolean {
  return explicitIncludes
    .map(normalizeTrackingIdentifier)
    .some((identifier) => identifier === item.nodeId || identifier === item.url);
}

function previousCollectionRetentionItemState(item: SnapshotCollectionItem): RetentionItemState {
  if (item.state === "open") {
    return Object.freeze({ state: "open" });
  }
  return Object.freeze({
    state: "closed",
    terminalAt: item.terminalAt,
  });
}

function enumeratedRetentionItemState(item: EnumeratedGitHubItem): RetentionItemState {
  if (item.state === "open") {
    return Object.freeze({ state: "open" });
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return Object.freeze({
      state: "merged",
      terminalAt: item.mergedAt,
    });
  }
  return Object.freeze({
    state: "closed",
    terminalAt: item.closedAt,
  });
}

function shouldKeepPreviousTrackedItemInActiveDataset(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  item: Readonly<{ nodeId: GitHubNodeId; url: string }>,
  itemState: RetentionItemState,
): boolean {
  if (explicitIdentifierMatchesItem(configuration.config.tracking.include, item)) {
    return true;
  }
  const retention = determineTerminalRetention({
    item: itemState,
    evaluatedAt,
    retentionDays: configuration.config.tracking.retentionDaysAfterTerminal,
  });
  return retention.dataset === "active";
}

function previousTrackedItemIdentifiers(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  repository: PublicRepository,
): readonly string[] {
  const collectionItemsByNodeId = previousCollectionItemsByNodeId(state);
  const identifiers: string[] = [];
  for (const item of previousSnapshot(state)?.items ?? []) {
    if (item.repositoryId !== repository.id) {
      continue;
    }
    const collectionItem = collectionItemsByNodeId.get(item.nodeId);
    assertNonNullable(collectionItem, `既存追跡項目の収集stateがありません。対象: ${item.nodeId}`);
    const itemState = previousCollectionRetentionItemState(collectionItem);
    if (
      shouldKeepPreviousTrackedItemInActiveDataset(
        invocation.startedAt,
        configuration,
        item,
        itemState,
      )
    ) {
      identifiers.push(item.nodeId);
    }
  }
  return Object.freeze(identifiers);
}

function configuredUrlIdentifiersForRepository(
  config: Config,
  repository: PublicRepository,
): readonly string[] {
  const expectedPrefix = `https://github.com/${repository.owner}/${repository.name}/`.toLowerCase();
  return Object.freeze(
    config.tracking.include
      .map(normalizeTrackingIdentifier)
      .filter(
        (identifier) =>
          identifier.includes("://") && identifier.toLowerCase().startsWith(expectedPrefix),
      ),
  );
}

function missingIdentifiers(
  identifiers: readonly string[],
  currentItems: readonly EnumeratedGitHubItem[],
): readonly string[] {
  return Object.freeze(
    [...new Set(identifiers.map(normalizeTrackingIdentifier))].filter(
      (identifier) =>
        !currentItems.some((item) => item.nodeId === identifier || item.url === identifier),
    ),
  );
}

function repositoryFullName(repository: PublicRepository): string {
  return `${repository.owner}/${repository.name}`;
}

function requiredTrackingDetailNodeIds(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  repository: PublicRepository,
  enumeratedItems: readonly EnumeratedGitHubItem[],
): readonly GitHubNodeId[] {
  const backfill = createTrackingBackfillRequest(
    invocation.command,
    Object.freeze({ status: "start" }),
  );
  const includesAllOpenBackfill =
    backfill.mode === "all-open"
      ? backfill.repositoryFilter.length === 0 ||
        backfill.repositoryFilter.includes(repositoryFullName(repository))
      : false;
  const previouslyTrackedNodeIds = new Set(
    (previousSnapshot(state)?.items ?? []).map((item) => item.nodeId),
  );
  return Object.freeze(
    enumeratedItems
      .filter(
        (item) =>
          !previouslyTrackedNodeIds.has(item.nodeId) &&
          (explicitIdentifierMatchesItem(configuration.config.tracking.include, item) ||
            (includesAllOpenBackfill && item.state === "open")),
      )
      .map((item) => item.nodeId),
  );
}

function findRepository(
  inventory: RepositoryInventory,
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  return inventory.allowlist.require(repositoryId);
}

function findDetail(collection: CollectedItems, nodeId: GitHubNodeId): GitHubItemDetail {
  const detail = collection.details.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(detail, `GitHub詳細取得結果がありません。対象: ${nodeId}`);
  return detail;
}

function createPublicRelationItem(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
): PublicGitHubRelationItem {
  return Object.freeze({
    nodeId: item.nodeId,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: item.type,
    number: item.number,
    url: item.url,
    state: item.type === "pull_request" && item.mergeStatus === "merged" ? "merged" : item.state,
  });
}

function extractAllRelationCandidates(
  config: Config,
  allowlist: PublicRepositoryAllowlist,
  items: readonly EnumeratedGitHubItem[],
  details: readonly GitHubItemDetail[],
): readonly RelationCandidate[] {
  const knownItems = items.map((item) =>
    createPublicRelationItem(item, allowlist.require(item.repositoryId)),
  );
  const itemByNodeId = new Map(knownItems.map((item) => [item.nodeId, item]));
  const candidates: RelationCandidate[] = [];
  for (const detail of details) {
    const item = itemByNodeId.get(detail.nodeId);
    assertNonNullable(item, `関係候補抽出対象がありません。対象: ${detail.nodeId}`);
    candidates.push(
      ...extractRelationCandidates({
        organization: config.organization,
        item: {
          ...item,
          body: {
            sourceId: detail.bodySourceId,
            markdown: detail.body,
          },
          comments: detail.comments.map((comment) => ({
            sourceId: comment.sourceId,
            markdown: comment.body,
          })),
          crossReferences: detail.inboundCrossReferences.map((reference) => ({
            sourceId: reference.eventSourceId,
            sourceItem: reference.sourceItem,
            willCloseTarget: reference.willCloseTarget,
          })),
          nativeDependencies:
            detail.type === "issue" && detail.nativeDependencies.availability === "available"
              ? detail.nativeDependencies.relations
              : [],
          nativeHierarchy:
            detail.type === "issue" && detail.nativeHierarchy.availability === "available"
              ? detail.nativeHierarchy.relations
              : [],
          nativeClosingIssues: detail.type === "pull_request" ? detail.nativeClosingIssues : [],
        },
        knownItems,
      }),
    );
  }
  return normalizeRelationCandidates(candidates);
}

function relationNodes(
  relation: CandidateRelation,
): readonly [RelationCandidateNode, RelationCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return Object.freeze([relation.blocker, relation.blocked]);
    case "parent_of":
      return Object.freeze([relation.parent, relation.subtask]);
    case "implements":
      return Object.freeze([relation.implementation, relation.target]);
    case "unclassified":
      return Object.freeze([relation.referencing, relation.referenced]);
  }
}

function createTrackingConnections(
  candidates: readonly RelationCandidate[],
): readonly TrackingConnection[] {
  const connections: TrackingConnection[] = [];
  for (const candidate of candidates) {
    const sourceId = candidate.sourceIds[0];
    assertNonNullable(sourceId, `関係候補 ${candidate.id}のsource IDがありません`);
    switch (candidate.relation.type) {
      case "blocks":
        connections.push(
          Object.freeze({
            kind: "native_dependency",
            sourceId,
            blockerNodeId: candidate.relation.blocker.nodeId,
            blockedNodeId: candidate.relation.blocked.nodeId,
          }),
        );
        break;
      case "parent_of":
        if (candidate.authority === "authoritative") {
          connections.push(
            Object.freeze({
              kind: "native_sub_issue",
              sourceId,
              parentNodeId: candidate.relation.parent.nodeId,
              subIssueNodeId: candidate.relation.subtask.nodeId,
            }),
          );
          break;
        }
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.parent.nodeId,
            referencedNodeId: candidate.relation.subtask.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "parent_of",
            }),
          }),
        );
        break;
      case "implements":
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.implementation.nodeId,
            referencedNodeId: candidate.relation.target.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "implements",
            }),
          }),
        );
        break;
      case "unclassified":
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.referencing.nodeId,
            referencedNodeId: candidate.relation.referenced.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "related_to",
            }),
          }),
        );
        break;
      default:
        throw new UnreachableError(candidate.relation);
    }
  }
  return Object.freeze(connections);
}

function completeRelationCandidates(
  candidates: readonly RelationCandidate[],
  collectedCandidateNodeIds: ReadonlySet<GitHubNodeId>,
): Readonly<{
  candidates: readonly RelationCandidate[];
  droppedCount: number;
}> {
  const completeCandidates = candidates.filter((candidate) =>
    relationNodes(candidate.relation).every(
      (node) => node.scope === "external_public" || collectedCandidateNodeIds.has(node.nodeId),
    ),
  );
  return Object.freeze({
    candidates: Object.freeze(completeCandidates),
    droppedCount: candidates.length - completeCandidates.length,
  });
}

function resolveProductionTrackingStartAt(
  config: Config,
  previousState: TrackingStartAtState,
  run: TrackingRunCompletion,
): TrackingStartAtState {
  const configured = config.tracking.startAt;
  return resolveTrackingStartAt({
    configuredStartAt:
      configured == null
        ? Object.freeze({
            status: "not_configured",
          })
        : Object.freeze({
            status: "configured",
            value: createUtcIsoDateTime(configured),
          }),
    previousState,
    run,
  });
}

function trackingSelectionStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  evaluatedAt: UtcIsoDateTime,
): UtcIsoDateTime {
  const resolved = resolveProductionTrackingStartAt(
    configuration.config,
    previousSnapshot(state)?.trackingStartAt ??
      Object.freeze({
        status: "not_fixed",
      }),
    Object.freeze({
      outcome: "incomplete",
      finishedAt: evaluatedAt,
    }),
  );
  if (resolved.status === "not_fixed") {
    return evaluatedAt;
  }
  return resolved.value;
}

function pendingSnapshotTrackingStartAt(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  evaluatedAt: UtcIsoDateTime,
): TrackingStartAtState {
  return resolveProductionTrackingStartAt(
    configuration.config,
    previousSnapshot(state)?.trackingStartAt ??
      Object.freeze({
        status: "not_fixed",
      }),
    Object.freeze({
      outcome: "incomplete",
      finishedAt: evaluatedAt,
    }),
  );
}

function completedSnapshotTrackingStartAt(
  config: Config,
  snapshot: StateSnapshot,
  completedAt: UtcIsoDateTime,
): TrackingStartAtState {
  const resolved = resolveProductionTrackingStartAt(
    config,
    snapshot.trackingStartAt,
    Object.freeze({
      outcome: "complete_success",
      finishedAt: completedAt,
    }),
  );
  if (resolved.status !== "fixed") {
    throw new TypeError("完全成功したrunでtracking.startAtを確定できませんでした");
  }
  return resolved;
}

function authorType(item: FreshObservedGitHubItem): "human" | "bot" | "unknown" {
  if (item.author.status === "unavailable") {
    return "unknown";
  }
  return item.author.actor.type;
}

function enumeratedAuthorType(
  item: EnumeratedGitHubItem,
  isBot: ReturnType<typeof createGitHubBotPredicate>,
): "human" | "bot" | "unknown" {
  if (item.author.kind === "deleted_account") {
    return "unknown";
  }
  return item.author.account.apiType === "Bot" || isBot(item.author.account) ? "bot" : "human";
}

function collectTrackingCandidates(
  invocation: DailyRunInvocation,
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  observedItems: readonly FreshObservedGitHubItem[],
  relationCandidates: readonly RelationCandidate[],
): RuntimeTrackingSelection {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const previousItems = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const observedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const enumeratedItemsByNodeId = new Map(enumeratedItems.map((item) => [item.nodeId, item]));
  const isBot = createGitHubBotPredicate(configuration.config.actors.bots);
  let excludedCandidateCount = 0;
  const organizationCandidates: OrganizationTrackingCandidate[] = enumeratedItems.flatMap(
    (item): OrganizationTrackingCandidate[] => {
      const repository = findRepository(inventory, item.repositoryId);
      const fullName = repositoryFullName(repository);
      const previous = previousItems.get(item.nodeId);
      const observed = observedItemsByNodeId.get(item.nodeId);
      const activity =
        observed == null
          ? previous == null
            ? undefined
            : Object.freeze({
                lastHumanActivityAt: previous.lastHumanActivityAt,
                lastProgressAt: previous.lastProgressAt,
              })
          : determineMeaningfulProgress({
              createdAt: observed.createdAt,
              evaluatedAt,
              events: observed.events,
              dependencyResolutions: [],
              naturalLanguageAssessments: [],
              minimumAiConfidence: configuration.config.ai.confidence.medium,
              previousActivity:
                previous == null
                  ? {
                      status: "not_available",
                    }
                  : {
                      status: "available",
                      lastProgressAt: previous.lastProgressAt,
                      lastHumanActivityAt: previous.lastHumanActivityAt,
                    },
              repositoryFullName: fullName,
              resolveLabelEffects,
            });
      if (activity == null) {
        excludedCandidateCount += 1;
        return [];
      }
      const itemAuthorType = enumeratedAuthorType(item, isBot);
      const notificationClass = classifyTrackingNotification({
        authorType: itemAuthorType,
        title: item.title,
        automationNoiseTitles: configuration.config.notifications.automationNoiseTitles,
        notificationsSuppressedByLabel: resolveLabelEffects(fullName, item.labels)
          .suppressNotifications,
      });
      if (item.state === "open") {
        return [
          Object.freeze({
            scope: "organization",
            nodeId: item.nodeId,
            repositoryFullName: fullName,
            number: item.number,
            url: item.url,
            title: item.title,
            createdAt: item.createdAt,
            activity: Object.freeze({
              lastHumanActivityAt: activity.lastHumanActivityAt,
              lastProgressAt: activity.lastProgressAt,
            }),
            authorType: itemAuthorType,
            notificationClass,
            state: "open",
          }),
        ];
      }
      return [
        Object.freeze({
          scope: "organization",
          nodeId: item.nodeId,
          repositoryFullName: fullName,
          number: item.number,
          url: item.url,
          title: item.title,
          createdAt: item.createdAt,
          activity: Object.freeze({
            lastHumanActivityAt: activity.lastHumanActivityAt,
            lastProgressAt: activity.lastProgressAt,
          }),
          authorType: itemAuthorType,
          notificationClass,
          state: "closed",
          terminalAt: item.closedAt,
        }),
      ];
    },
  );
  const externalCandidates = deduplicateByStableId(
    relationCandidates.flatMap((candidate) =>
      relationNodes(candidate.relation).flatMap((node) =>
        node.scope === "external_public"
          ? [
              Object.freeze({
                scope: "external_public",
                nodeId: node.nodeId,
                repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                number: node.number,
                url: node.url,
                title: `${node.repositoryOwner}/${node.repositoryName}#${node.number.toString()}`,
                state: node.state,
              } satisfies TrackingCandidate),
            ]
          : [],
      ),
    ),
    (candidate) => candidate.nodeId,
  );
  const candidates: readonly TrackingCandidate[] = Object.freeze([
    ...organizationCandidates,
    ...externalCandidates,
  ]);
  const result = selectTrackingItems({
    startAt: trackingSelectionStartAt(configuration, state, evaluatedAt),
    evaluatedAt,
    candidates,
    connections: createTrackingConnections(relationCandidates),
    previouslyTrackedNodeIds: Object.freeze(
      [...previousItems.keys()].filter((nodeId) => {
        const currentItem = enumeratedItemsByNodeId.get(nodeId);
        if (currentItem == null) {
          return false;
        }
        const itemState = enumeratedRetentionItemState(currentItem);
        return shouldKeepPreviousTrackedItemInActiveDataset(
          evaluatedAt,
          configuration,
          currentItem,
          itemState,
        );
      }),
    ),
    explicitIncludes: configuration.config.tracking.include
      .map(normalizeTrackingIdentifier)
      .filter((identifier) =>
        candidates.some(
          (candidate) => candidate.nodeId === identifier || candidate.url === identifier,
        ),
      ),
    autoInclude: configuration.config.tracking.autoInclude,
    backfill: createTrackingBackfillRequest(
      invocation.command,
      Object.freeze({
        status: "start",
      }),
    ),
    maxBackfillItemsPerRun: configuration.config.tracking.backfill.maxItemsPerRun,
  });
  const previousCollectionItems = previousCollectionItemsByNodeId(state);
  const currentAnalysisRulesFingerprints = createCurrentAnalysisRulesFingerprints(
    configuration.config,
  );
  const workByNodeId = new Map<GitHubNodeId, TrackedItemWorkDecision>();
  for (const selected of result.trackedItems) {
    const item = enumeratedItemsByNodeId.get(selected.item.nodeId);
    assertNonNullable(item, `追跡対象の列挙値がありません。対象: ${selected.item.nodeId}`);
    const previousCollectionItem = previousCollectionItems.get(item.nodeId);
    const previousTrackedItem = previousItems.get(item.nodeId);
    workByNodeId.set(
      item.nodeId,
      determineTrackedItemWork({
        state: item.state,
        analysisInputFingerprint: item.itemFingerprint,
        analysisRulesFingerprint: currentAnalysisRulesFingerprints[item.type],
        previousAiAnalysisStatus:
          previousTrackedItem == null ? "not_available" : previousTrackedItem.aiAnalysis.status,
        previousObservation:
          previousCollectionItem == null
            ? Object.freeze({ status: "not_available" })
            : Object.freeze({
                status: "available",
                state: previousCollectionItem.state,
                analysisInputFingerprint: previousCollectionItem.itemFingerprint,
                analysisRulesFingerprint: previousCollectionItem.analysisRulesFingerprint,
              }),
      }),
    );
  }
  return Object.freeze({
    result,
    workByNodeId,
    excludedCandidateCount,
  });
}

function setMinimumNativeDepth(
  nativeDepthByNodeId: Map<GitHubNodeId, number>,
  nodeId: GitHubNodeId,
  depth: number,
): void {
  const currentDepth = nativeDepthByNodeId.get(nodeId);
  if (currentDepth == null || depth < currentDepth) {
    nativeDepthByNodeId.set(nodeId, depth);
  }
}

function relationExpansionTrackingState(tracking: RuntimeTrackingSelection): Readonly<{
  trackingRootNodeIds: ReadonlySet<GitHubNodeId>;
  nativeDepthByNodeId: ReadonlyMap<GitHubNodeId, number>;
}> {
  const trackingRootNodeIds = new Set<GitHubNodeId>();
  const nativeDepthByNodeId = new Map<GitHubNodeId, number>();
  for (const selected of tracking.result.trackedItems) {
    for (const reason of selected.reasons) {
      switch (reason.kind) {
        case "previously_tracked":
        case "created_after_start":
        case "changed_after_start":
        case "explicit_include":
          trackingRootNodeIds.add(selected.item.nodeId);
          setMinimumNativeDepth(nativeDepthByNodeId, selected.item.nodeId, 0);
          break;
        case "referenced_by_tracked":
        case "references_tracked":
          setMinimumNativeDepth(nativeDepthByNodeId, selected.item.nodeId, 0);
          break;
        case "native_relation":
          setMinimumNativeDepth(nativeDepthByNodeId, selected.item.nodeId, reason.depth);
          break;
        case "backfill":
          break;
        default:
          throw new UnreachableError(reason);
      }
    }
  }
  return Object.freeze({
    trackingRootNodeIds,
    nativeDepthByNodeId,
  });
}

function candidatesForNode(
  nodeId: GitHubNodeId,
  candidates: readonly RelationCandidate[],
): readonly RelationCandidate[] {
  return Object.freeze(
    candidates.filter((candidate) =>
      relationNodes(candidate.relation).some((node) => node.nodeId === nodeId),
    ),
  );
}

function createNativeBlockers(
  item: FreshObservedGitHubItem,
  candidates: readonly RelationCandidate[],
): readonly IssueBlocker[] {
  const blockers: IssueBlocker[] = [];
  for (const candidate of candidates) {
    if (
      candidate.authority !== "authoritative" ||
      candidate.relation.type !== "blocks" ||
      candidate.relation.blocked.nodeId !== item.nodeId
    ) {
      continue;
    }
    blockers.push(
      Object.freeze({
        candidateId: candidate.relation.blocker.nodeId,
        state: candidate.relation.blocker.state,
        authority: "authoritative",
        confidence: 1,
        sourceIds: candidate.sourceIds,
        becameBlockingAt: item.createdAt,
      }),
    );
  }
  return Object.freeze(blockers);
}

function addMirroredNativeBlockerSourceRecords(
  sourceRecords: Map<string, unknown>,
  item: FreshObservedGitHubItem,
  relationCandidates: readonly RelationCandidate[],
): void {
  for (const candidate of relationCandidates) {
    if (
      candidate.provenance !== "native" ||
      candidate.relation.type !== "blocks" ||
      candidate.relation.blocked.nodeId !== item.nodeId
    ) {
      continue;
    }
    const currentEvent = item.events.find(
      (event) =>
        event.kind === "relation" &&
        event.provenance === "native" &&
        event.relationType === "blocks" &&
        candidate.sourceIds.includes(event.sourceId),
    );
    if (currentEvent == null) {
      continue;
    }
    for (const sourceId of candidate.sourceIds) {
      if (sourceRecords.has(sourceId)) {
        continue;
      }
      sourceRecords.set(
        sourceId,
        Object.freeze({
          id: sourceId,
          kind: currentEvent.kind,
          actorType: currentEvent.actor.type,
          createdAt: currentEvent.occurredAt,
        }),
      );
    }
  }
}

function createIssueRequestCandidates(
  item: Extract<FreshObservedGitHubItem, { type: "issue" }>,
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
): readonly Readonly<{ sourceId: SourceId; occurredAt: UtcIsoDateTime }>[] {
  const candidates: Readonly<{ sourceId: SourceId; occurredAt: UtcIsoDateTime }>[] = [];
  if (detail.body.trim().length > 0) {
    candidates.push(
      Object.freeze({
        sourceId: detail.bodySourceId,
        occurredAt: item.createdAt,
      }),
    );
  }
  const humanCommentSourceIds = new Set(
    item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) => event.sourceId),
  );
  for (const comment of detail.comments) {
    if (comment.body.trim().length > 0 && humanCommentSourceIds.has(comment.sourceId)) {
      candidates.push(
        Object.freeze({
          sourceId: comment.sourceId,
          occurredAt: comment.createdAt,
        }),
      );
    }
  }
  return deduplicateByStableId(candidates, (candidate) => candidate.sourceId);
}

type EffectiveAssigneeCandidateAccumulator = Readonly<{
  candidateId: string;
  sourceIds: Set<SourceId>;
  occurredAtBySourceId: Map<SourceId, UtcIsoDateTime>;
  sourceContexts: Map<GitHubNodeId, EffectiveAssigneeSourceContext>;
}>;

type EffectiveAssigneeStateEvent = Extract<NormalizedEvent, { kind: "state" }>;

function latestEffectiveAssigneeUnassignmentAt(
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
): UtcIsoDateTime | undefined {
  let latestUnassignedAt: UtcIsoDateTime | undefined;
  for (const event of detail.timeline) {
    if (event.kind !== "unassigned") {
      continue;
    }
    if (latestUnassignedAt == null || latestUnassignedAt < event.occurredAt) {
      latestUnassignedAt = event.occurredAt;
    }
  }
  return latestUnassignedAt;
}

function resolveEffectiveAssigneePullRequestState(
  pullRequest: Extract<FreshObservedGitHubItem, { type: "pull_request" }>,
): "open" | "merged" | "closed_unmerged" {
  const stateEvents = pullRequest.events
    .filter((event): event is EffectiveAssigneeStateEvent => event.kind === "state")
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt < right.occurredAt ? -1 : 1;
      }
      if (left.sourceId === right.sourceId) {
        return 0;
      }
      return left.sourceId < right.sourceId ? -1 : 1;
    });
  const latestStateEvent = stateEvents.at(-1);
  if (pullRequest.state === "open") {
    if (latestStateEvent == null) {
      return "open";
    }
    switch (latestStateEvent.state) {
      case "open":
      case "reopened":
        return "open";
      case "closed":
      case "merged":
        throw new TypeError(
          `openなPull Requestの最新state eventが現在状態と一致しません。対象: ${pullRequest.nodeId}`,
        );
      default:
        throw new UnreachableError(latestStateEvent);
    }
  }
  assertNonNullable(
    latestStateEvent,
    `closedなPull Requestの最新state eventがありません。対象: ${pullRequest.nodeId}`,
  );
  switch (latestStateEvent.state) {
    case "merged":
      return "merged";
    case "closed":
      return "closed_unmerged";
    case "open":
    case "reopened":
      throw new TypeError(
        `closedなPull Requestの最新state eventが現在状態と一致しません。対象: ${pullRequest.nodeId}`,
      );
    default:
      throw new UnreachableError(latestStateEvent);
  }
}

function createEffectiveAssigneeCandidateContexts(
  collection: EffectiveAssigneeCollectionContext,
  item: Extract<FreshObservedGitHubItem, { type: "issue" }>,
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
  relationCandidates: readonly RelationCandidate[],
): readonly EffectiveAssigneeCandidateContext[] {
  if (item.state !== "open" || item.assignees.length !== 0) {
    return Object.freeze([]);
  }

  const currentSourceContext = Object.freeze({
    item,
    detail,
  }) satisfies EffectiveAssigneeSourceContext;
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((observedItem) => [observedItem.nodeId, observedItem]),
  );
  const detailsByNodeId = new Map(
    collection.details.map((itemDetail) => [itemDetail.nodeId, itemDetail]),
  );
  const candidatesById = new Map<string, EffectiveAssigneeCandidateAccumulator>();
  const lastUnassignedAt = latestEffectiveAssigneeUnassignmentAt(detail);

  const addCandidateEvidence = (
    candidateId: string,
    sourceId: SourceId,
    occurredAt: UtcIsoDateTime,
    sourceContext: EffectiveAssigneeSourceContext,
  ): void => {
    if (candidateId.length === 0) {
      throw new TypeError("実質担当候補のGitHub loginは空にできません");
    }
    if (lastUnassignedAt != null && occurredAt <= lastUnassignedAt) {
      return;
    }
    const key = candidateId.toLowerCase();
    const existing = candidatesById.get(key);
    if (existing == null) {
      candidatesById.set(
        key,
        Object.freeze({
          candidateId,
          sourceIds: new Set([sourceId]),
          occurredAtBySourceId: new Map([[sourceId, occurredAt]]),
          sourceContexts: new Map([[sourceContext.item.nodeId, sourceContext]]),
        }),
      );
      return;
    }
    existing.sourceIds.add(sourceId);
    const existingOccurredAt = existing.occurredAtBySourceId.get(sourceId);
    if (existingOccurredAt != null && existingOccurredAt !== occurredAt) {
      if (parseSourceId(sourceId).kind !== "github_commit") {
        throw new TypeError(`実質担当候補sourceの発生時刻が一致しません。対象: ${sourceId}`);
      }
      existing.occurredAtBySourceId.set(
        sourceId,
        existingOccurredAt < occurredAt ? existingOccurredAt : occurredAt,
      );
    } else {
      existing.occurredAtBySourceId.set(sourceId, occurredAt);
    }
    existing.sourceContexts.set(sourceContext.item.nodeId, sourceContext);
  };

  if (
    item.author.status === "identified" &&
    item.author.actor.type === "human" &&
    detail.body.trim().length > 0
  ) {
    addCandidateEvidence(
      item.author.actor.login,
      detail.bodySourceId,
      item.createdAt,
      currentSourceContext,
    );
  }

  for (const comment of detail.comments) {
    if (comment.body.trim().length === 0) {
      continue;
    }
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    if (event?.actor.type !== "human") {
      continue;
    }
    addCandidateEvidence(
      event.actor.login,
      comment.sourceId,
      comment.createdAt,
      currentSourceContext,
    );
  }

  for (const relationCandidate of relationCandidates) {
    if (
      relationCandidate.authority !== "authoritative" ||
      relationCandidate.relation.type !== "implements"
    ) {
      continue;
    }
    const implementation = relationCandidate.relation.implementation;
    const target = relationCandidate.relation.target;
    if (
      implementation.scope !== "organization" ||
      implementation.kind !== "pull_request" ||
      target.scope !== "organization" ||
      target.nodeId !== item.nodeId
    ) {
      continue;
    }
    if (!collection.trackedNodeIds.has(implementation.nodeId)) {
      continue;
    }
    const relatedItem = observedItemsByNodeId.get(implementation.nodeId);
    if (relatedItem == null) {
      continue;
    }
    if (relatedItem.type !== "pull_request") {
      throw new TypeError(
        `実装関係の対象がPull Requestではありません。対象: ${implementation.nodeId}`,
      );
    }
    const expectedObservedState = implementation.state === "open" ? "open" : "closed";
    if (relatedItem.state !== expectedObservedState) {
      throw new TypeError(
        `実装関係のPull Request状態が一致しません。対象: ${implementation.nodeId}`,
      );
    }
    const relatedDetail = detailsByNodeId.get(implementation.nodeId);
    if (relatedDetail == null) {
      continue;
    }
    if (relatedDetail.type !== "pull_request") {
      throw new TypeError(
        `実装関係の詳細がPull Requestではありません。対象: ${implementation.nodeId}`,
      );
    }
    if (relatedItem.author.status !== "identified" || relatedItem.author.actor.type !== "human") {
      continue;
    }
    const relatedSourceContext = Object.freeze({
      item: relatedItem,
      detail: relatedDetail,
    }) satisfies EffectiveAssigneeSourceContext;
    const authorLogin = relatedItem.author.actor.login;
    addCandidateEvidence(
      authorLogin,
      relatedItem.sourceId,
      relatedItem.createdAt,
      relatedSourceContext,
    );
    if (relatedDetail.body.trim().length > 0) {
      addCandidateEvidence(
        authorLogin,
        relatedDetail.bodySourceId,
        relatedItem.createdAt,
        relatedSourceContext,
      );
    }
    for (const event of relatedItem.events) {
      if (event.kind !== "push") {
        continue;
      }
      addCandidateEvidence(authorLogin, event.sourceId, event.occurredAt, relatedSourceContext);
    }
  }

  return Object.freeze(
    [...candidatesById.values()]
      .map((candidate) => {
        const orderedSourceIds = [...candidate.sourceIds].sort((left, right) => {
          const leftOccurredAt = candidate.occurredAtBySourceId.get(left);
          const rightOccurredAt = candidate.occurredAtBySourceId.get(right);
          assertNonNullable(
            leftOccurredAt,
            `実質担当候補sourceの発生時刻がありません。対象: ${left}`,
          );
          assertNonNullable(
            rightOccurredAt,
            `実質担当候補sourceの発生時刻がありません。対象: ${right}`,
          );
          if (leftOccurredAt !== rightOccurredAt) {
            return leftOccurredAt > rightOccurredAt ? -1 : 1;
          }
          return left.localeCompare(right);
        });
        const sourceIds = orderedSourceIds.slice(0, 10);
        const firstSourceId = sourceIds[0];
        assertNonNullable(
          firstSourceId,
          `実質担当候補 ${candidate.candidateId}のsource IDがありません`,
        );
        const occurredAt = candidate.occurredAtBySourceId.get(firstSourceId);
        assertNonNullable(
          occurredAt,
          `実質担当候補sourceの発生時刻がありません。対象: ${firstSourceId}`,
        );
        return Object.freeze({
          candidate: Object.freeze({
            candidateId: candidate.candidateId,
            sourceIds: Object.freeze([firstSourceId, ...sourceIds.slice(1)] satisfies [
              SourceId,
              ...SourceId[],
            ]),
            occurredAt,
          }),
          sourceContexts: Object.freeze(
            [...candidate.sourceContexts.values()].sort((left, right) =>
              left.item.nodeId.localeCompare(right.item.nodeId),
            ),
          ),
        });
      })
      .sort((left, right) => {
        const leftId = left.candidate.candidateId.toLowerCase();
        const rightId = right.candidate.candidateId.toLowerCase();
        if (leftId < rightId) {
          return -1;
        }
        if (leftId > rightId) {
          return 1;
        }
        return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
      }),
  );
}

function mentionedCandidatesInSource(
  sourceId: SourceId,
  content: string,
): readonly MentionedWaitingOnCandidate[] {
  const candidates = new Map<string, MentionedWaitingOnCandidate>();
  for (const match of content.matchAll(GITHUB_MENTION_PATTERN)) {
    const accountOrOrganization = match[1];
    assertNonNullable(accountOrOrganization, "GitHub mentionのaccountを取得できませんでした");
    const teamSlug = match[2];
    const kind = teamSlug == null ? "user" : "team";
    const id = teamSlug == null ? accountOrOrganization : `${accountOrOrganization}/${teamSlug}`;
    candidates.set(
      `${kind}:${id.toLowerCase()}`,
      Object.freeze({
        id,
        kind,
        sourceIds: Object.freeze([sourceId] satisfies [SourceId]),
      }),
    );
  }
  return Object.freeze([...candidates.values()]);
}

function createMentionedWaitingOnCandidates(
  detail: GitHubItemDetail,
): readonly MentionedWaitingOnCandidate[] {
  const sourceCandidates = [
    ...mentionedCandidatesInSource(detail.bodySourceId, detail.body),
    ...detail.comments.flatMap((comment) =>
      mentionedCandidatesInSource(comment.sourceId, comment.body),
    ),
  ];
  const grouped = new Map<
    string,
    Readonly<{
      id: string;
      kind: MentionedWaitingOnCandidate["kind"];
      sourceIds: Set<SourceId>;
    }>
  >();
  for (const candidate of sourceCandidates) {
    const key = `${candidate.kind}:${candidate.id.toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(
        key,
        Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          sourceIds: new Set(candidate.sourceIds),
        }),
      );
      continue;
    }
    for (const sourceId of candidate.sourceIds) {
      existing.sourceIds.add(sourceId);
    }
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((candidate) => {
        const sourceIds = [...candidate.sourceIds].sort();
        const firstSourceId = sourceIds[0];
        assertNonNullable(firstSourceId, `mention候補 ${candidate.id}のsource IDがありません`);
        return Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          sourceIds: Object.freeze([firstSourceId, ...sourceIds.slice(1)] satisfies [
            SourceId,
            ...SourceId[],
          ]),
        } satisfies MentionedWaitingOnCandidate);
      }),
  );
}

function applyDeterministicAnalysis(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
): DeterministicAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const items: DeterministicItemAnalysis[] = [];
  for (const item of collection.observedItems) {
    if (!collection.analysisNodeIds.has(item.nodeId)) {
      continue;
    }
    const repository = findRepository(inventory, item.repositoryId);
    const maintainers = resolveRepositoryMaintainers(
      configuration.config.maintainers,
      repositoryFullName(repository),
    );
    const detail = findDetail(collection, item.nodeId);
    const notificationClass = collection.trackingNotificationClassByNodeId.get(item.nodeId);
    assertNonNullable(notificationClass, `追跡項目の通知分類がありません。対象: ${item.nodeId}`);
    const relationCandidates = candidatesForNode(item.nodeId, collection.relationCandidates);
    const blockers = createNativeBlockers(item, relationCandidates);
    if (item.type === "issue" && detail.type === "issue") {
      const effectiveAssigneeCandidates = createEffectiveAssigneeCandidateContexts(
        collection,
        item,
        detail,
        relationCandidates,
      );
      const decision = determineIssueState({
        issue: item,
        blockers,
        explicitRequestCandidates: createIssueRequestCandidates(item, detail),
        explicitRequestAssessment: {
          status: "not_assessed",
        },
        effectiveAssigneeCandidates: effectiveAssigneeCandidates.map(
          (candidate) => candidate.candidate,
        ),
        effectiveAssigneeAssessment: {
          status: "not_assessed",
        },
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: collection.evaluatedAt,
      });
      items.push(
        Object.freeze({
          item,
          detail,
          decision,
          notificationClass,
          relationCandidates,
          effectiveAssigneeCandidates,
        }),
      );
      continue;
    }
    if (item.type === "pull_request" && detail.type === "pull_request") {
      const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
      const decision = determinePullRequestState({
        pullRequest: item,
        blockers,
        checkFailureAssessment: {
          cause: "not_assessed",
        },
        labelEffects,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: collection.evaluatedAt,
      });
      items.push(
        Object.freeze({
          item,
          detail,
          decision,
          notificationClass,
          relationCandidates,
          effectiveAssigneeCandidates: Object.freeze([]),
        }),
      );
      continue;
    }
    throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${item.nodeId}`);
  }
  return Object.freeze({
    items: Object.freeze(items),
    state,
    inventory,
  });
}

function codexActorType(item: FreshObservedGitHubItem): "human" | "bot" | "system" {
  const type = authorType(item);
  return type === "unknown" ? "system" : type;
}

function codexAuthorCandidateId(item: FreshObservedGitHubItem): string | undefined {
  if (item.author.status === "unavailable") {
    return undefined;
  }
  return item.author.actor.login;
}

function relationTargetUrl(
  nodeId: GitHubNodeId,
  candidate: RelationCandidate,
): PublicGitHubRelationItem["url"] {
  const nodes = relationNodes(candidate.relation);
  const target = nodes.find((node) => node.nodeId !== nodeId);
  assertNonNullable(target, `関係候補 ${candidate.id}の相手項目がありません`);
  return target.url;
}

function relationAssessmentOwnerNodeId(candidate: RelationCandidate): GraphNodeId {
  switch (candidate.relation.type) {
    case "blocks":
      return candidate.relation.blocked.nodeId;
    case "parent_of":
      return candidate.relation.parent.nodeId;
    case "implements":
      return candidate.relation.implementation.nodeId;
    case "unclassified":
      return candidate.relation.referencing.nodeId;
  }
}

function selectRelationAssessmentCandidates(
  nodeId: GraphNodeId,
  candidates: readonly RelationCandidate[],
): readonly RelationCandidate[] {
  return candidates.filter((candidate) => relationAssessmentOwnerNodeId(candidate) === nodeId);
}

function createNativeRelationSignals(
  currentNodeId: GitHubNodeId,
  candidates: readonly RelationCandidate[],
): Readonly<{
  nativeBlockedBy: readonly RelationCandidateId[];
  nativeBlocking: readonly RelationCandidateId[];
  nativeParent: readonly RelationCandidateId[];
  nativeSubIssues: readonly RelationCandidateId[];
}> {
  const nativeBlockedBy: RelationCandidateId[] = [];
  const nativeBlocking: RelationCandidateId[] = [];
  const nativeParent: RelationCandidateId[] = [];
  const nativeSubIssues: RelationCandidateId[] = [];
  for (const candidate of candidates) {
    if (candidate.provenance !== "native") {
      continue;
    }
    switch (candidate.relation.type) {
      case "blocks":
        if (candidate.relation.blocked.nodeId === currentNodeId) {
          nativeBlockedBy.push(candidate.id);
        } else if (candidate.relation.blocker.nodeId === currentNodeId) {
          nativeBlocking.push(candidate.id);
        } else {
          throw new TypeError(`native関係候補 ${candidate.id}に現在項目が含まれていません`);
        }
        break;
      case "parent_of":
        if (candidate.relation.subtask.nodeId === currentNodeId) {
          nativeParent.push(candidate.id);
        } else if (candidate.relation.parent.nodeId === currentNodeId) {
          nativeSubIssues.push(candidate.id);
        } else {
          throw new TypeError(`native関係候補 ${candidate.id}に現在項目が含まれていません`);
        }
        break;
      case "implements":
        break;
    }
  }
  return Object.freeze({
    nativeBlockedBy: Object.freeze(nativeBlockedBy.sort()),
    nativeBlocking: Object.freeze(nativeBlocking.sort()),
    nativeParent: Object.freeze(nativeParent.sort()),
    nativeSubIssues: Object.freeze(nativeSubIssues.sort()),
  });
}

function latestUtcIsoDateTime(values: readonly UtcIsoDateTime[], context: string): UtcIsoDateTime {
  const firstValue = values[0];
  assertNonNullable(firstValue, `${context}の時刻がありません`);
  return values.slice(1).reduce((latest, value) => (latest < value ? value : latest), firstValue);
}

function addCodexSourceOccurredAt(
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
  occurredAt: UtcIsoDateTime,
): void {
  const existingOccurredAt = sourceOccurredAtById.get(sourceId);
  if (existingOccurredAt != null && existingOccurredAt !== occurredAt) {
    if (parseSourceId(sourceId).kind !== "github_commit") {
      throw new TypeError(`同じCodex source IDに異なる発生時刻があります。対象: ${sourceId}`);
    }
    sourceOccurredAtById.set(
      sourceId,
      existingOccurredAt < occurredAt ? existingOccurredAt : occurredAt,
    );
    return;
  }
  sourceOccurredAtById.set(sourceId, occurredAt);
}

function checkContextOccurredAt(
  headOccurredAt: UtcIsoDateTime,
  context: GitHubCheckContext,
): UtcIsoDateTime {
  if (context.type === "commit_status") {
    return context.createdAt;
  }
  return context.completedAt ?? headOccurredAt;
}

function addCodexSourceOccurredAtForContext(
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
): void {
  for (const [sourceId, occurredAt] of createEarliestRelationSourceOccurredAtById([item])) {
    addCodexSourceOccurredAt(sourceOccurredAtById, sourceId, occurredAt);
  }
  addCodexSourceOccurredAt(sourceOccurredAtById, item.sourceId, item.createdAt);
  addCodexSourceOccurredAt(sourceOccurredAtById, detail.bodySourceId, item.createdAt);
  for (const comment of detail.comments) {
    addCodexSourceOccurredAt(sourceOccurredAtById, comment.sourceId, comment.createdAt);
  }
  if (detail.type !== "pull_request" || detail.mergeState.checks.status !== "configured") {
    return;
  }
  const headOccurredAt = resolvePullRequestCommitOccurredAt(detail.headCommit, item.createdAt);
  const checkOccurredAts = detail.mergeState.checks.contexts.map((context) => {
    const occurredAt = checkContextOccurredAt(headOccurredAt, context);
    addCodexSourceOccurredAt(sourceOccurredAtById, context.sourceId, occurredAt);
    return occurredAt;
  });
  addCodexSourceOccurredAt(
    sourceOccurredAtById,
    detail.mergeState.checks.sourceId,
    latestUtcIsoDateTime(
      [headOccurredAt, ...checkOccurredAts],
      `check rollup ${detail.mergeState.checks.sourceId}`,
    ),
  );
}

function createCodexSourceOccurredAtById(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  addCodexSourceOccurredAtForContext(sourceOccurredAtById, item, detail);
  return sourceOccurredAtById;
}

function addCodexSourceRecord(
  sourceRecords: Map<string, unknown>,
  sourceId: SourceId,
  record: unknown,
): void {
  if (sourceRecords.has(sourceId)) {
    return;
  }
  sourceRecords.set(sourceId, record);
}

function addCodexSourceRecordsForContext(
  sourceRecords: Map<string, unknown>,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  context: EffectiveAssigneeSourceContext,
): void {
  const { item, detail } = context;
  addCodexSourceRecord(
    sourceRecords,
    item.sourceId,
    Object.freeze({
      id: item.sourceId,
      kind: "item",
      actorType: codexActorType(item),
      createdAt: item.createdAt,
    }),
  );
  for (const event of item.events) {
    addCodexSourceRecord(
      sourceRecords,
      event.sourceId,
      Object.freeze({
        id: event.sourceId,
        kind: event.kind,
        actorType: event.actor.type,
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, event.sourceId),
      }),
    );
  }
  const itemActorType = codexActorType(item);
  addCodexSourceRecord(
    sourceRecords,
    detail.bodySourceId,
    Object.freeze({
      id: detail.bodySourceId,
      kind: "body",
      actorType: itemActorType,
      createdAt: item.createdAt,
      ...(itemActorType === "human" ? { content: detail.body } : {}),
    }),
  );
  for (const comment of detail.comments) {
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    const actorType = event?.actor.type ?? "system";
    addCodexSourceRecord(
      sourceRecords,
      comment.sourceId,
      Object.freeze({
        id: comment.sourceId,
        kind: "comment",
        actorType,
        createdAt: comment.createdAt,
        ...(actorType === "human" ? { content: comment.body } : {}),
      }),
    );
  }
  if (detail.type !== "pull_request") {
    return;
  }
  if (item.type !== "pull_request") {
    throw new TypeError("Pull Request詳細にIssueの観測値が指定されています");
  }
  for (const thread of detail.reviewThreads) {
    for (const comment of thread.comments) {
      const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
      const actorType = event?.actor.type ?? "system";
      addCodexSourceRecord(
        sourceRecords,
        comment.sourceId,
        Object.freeze({
          id: comment.sourceId,
          kind: "comment",
          actorType,
          createdAt: comment.createdAt,
          ...(actorType === "human" ? { content: comment.body } : {}),
        }),
      );
    }
  }
  for (const review of detail.reviews) {
    const event = item.events.find((candidate) => candidate.sourceId === review.sourceId);
    const actorType = event?.actor.type ?? "system";
    addCodexSourceRecord(
      sourceRecords,
      review.sourceId,
      Object.freeze({
        id: review.sourceId,
        kind: "review",
        actorType,
        createdAt: review.submittedAt,
        ...(actorType === "human" ? { content: review.body } : {}),
      }),
    );
  }
  for (const request of detail.reviewRequests.current) {
    if (request.requestedAt.status === "unavailable") {
      continue;
    }
    addCodexSourceRecord(
      sourceRecords,
      request.sourceId,
      Object.freeze({
        id: request.sourceId,
        kind: "review_request",
        actorType: "system",
        createdAt: request.requestedAt.value,
      }),
    );
  }
  if (item.mergeState.autoMerge.status === "enabled") {
    const autoMerge = item.mergeState.autoMerge;
    addCodexSourceRecord(
      sourceRecords,
      autoMerge.sourceId,
      Object.freeze({
        id: autoMerge.sourceId,
        kind: "auto_merge_request",
        actorType: autoMerge.enabledBy.type,
        createdAt: autoMerge.enabledAt,
        mergeMethod: autoMerge.mergeMethod,
      }),
    );
  }
  if (detail.mergeState.checks.status !== "configured") {
    return;
  }
  const checks = detail.mergeState.checks;
  addCodexSourceRecord(
    sourceRecords,
    checks.sourceId,
    Object.freeze({
      id: checks.sourceId,
      kind: "required_check_rollup",
      actorType: "system",
      createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, checks.sourceId),
      combinedState: checks.combinedState,
    }),
  );
  for (const check of checks.contexts) {
    addCodexSourceRecord(
      sourceRecords,
      check.sourceId,
      Object.freeze({
        id: check.sourceId,
        kind: check.type,
        actorType: "system",
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, check.sourceId),
        ...(check.type === "check_run"
          ? {
              name: check.name,
              status: check.status,
              conclusion: check.conclusion,
            }
          : {
              context: check.context,
              state: check.state,
            }),
      }),
    );
  }
}

function requireCodexSourceOccurredAt(
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
): UtcIsoDateTime {
  const occurredAt = sourceOccurredAtById.get(sourceId);
  assertNonNullable(occurredAt, `Codex sourceの発生時刻がありません。対象: ${sourceId}`);
  return occurredAt;
}

function createCodexInput(
  configuration: RuntimeConfiguration,
  evaluatedAt: UtcIsoDateTime,
  analysis: DeterministicItemAnalysis,
): CodexAnalysisInput {
  const relationCandidates = deduplicateByStableId(
    selectRelationAssessmentCandidates(analysis.item.nodeId, analysis.relationCandidates),
    (candidate) => candidate.id,
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(analysis.detail);
  const nativeRelationSignals = createNativeRelationSignals(
    analysis.item.nodeId,
    relationCandidates,
  );
  const waitingOnCandidates = new Map(
    analysis.decision.waitingOn.map((waitingOn) => [
      waitingOn.candidateId,
      Object.freeze({
        id: waitingOn.candidateId,
        kind: waitingOn.kind,
        sourceIds: waitingOn.sourceIds,
      }),
    ]),
  );
  const authorCandidateId = codexAuthorCandidateId(analysis.item);
  if (authorCandidateId != null) {
    waitingOnCandidates.set(
      authorCandidateId,
      Object.freeze({
        id: authorCandidateId,
        kind: "user",
        sourceIds: Object.freeze([analysis.item.sourceId] satisfies [SourceId]),
      }),
    );
  }
  for (const candidate of mentionedCandidates) {
    waitingOnCandidates.set(candidate.id, candidate);
  }
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    const candidate = effectiveCandidateContext.candidate;
    const existingKey = [...waitingOnCandidates.keys()].find(
      (candidateId) => candidateId.toLowerCase() === candidate.candidateId.toLowerCase(),
    );
    if (existingKey != null && existingKey !== candidate.candidateId) {
      waitingOnCandidates.delete(existingKey);
    }
    waitingOnCandidates.set(
      candidate.candidateId,
      Object.freeze({
        id: candidate.candidateId,
        kind: "user",
        sourceIds: candidate.sourceIds,
        effectiveAssigneeCandidate: true,
        effectiveAssigneeSourceIds: candidate.sourceIds,
      }),
    );
  }
  const sourceOccurredAtById = new Map(
    createCodexSourceOccurredAtById(analysis.item, analysis.detail),
  );
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    for (const sourceContext of effectiveCandidateContext.sourceContexts) {
      addCodexSourceOccurredAtForContext(
        sourceOccurredAtById,
        sourceContext.item,
        sourceContext.detail,
      );
    }
  }
  const sourceRecords = new Map<string, unknown>();
  sourceRecords.set(
    analysis.item.sourceId,
    Object.freeze({
      id: analysis.item.sourceId,
      kind: "item",
      actorType: codexActorType(analysis.item),
      createdAt: analysis.item.createdAt,
    }),
  );
  for (const event of analysis.item.events) {
    sourceRecords.set(
      event.sourceId,
      Object.freeze({
        id: event.sourceId,
        kind: event.kind,
        actorType: event.actor.type,
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, event.sourceId),
      }),
    );
  }
  addMirroredNativeBlockerSourceRecords(sourceRecords, analysis.item, relationCandidates);
  sourceRecords.set(
    analysis.detail.bodySourceId,
    Object.freeze({
      id: analysis.detail.bodySourceId,
      kind: "body",
      actorType: codexActorType(analysis.item),
      createdAt: analysis.item.createdAt,
      content: analysis.detail.body,
    }),
  );
  for (const comment of analysis.detail.comments) {
    const event = analysis.item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    sourceRecords.set(
      comment.sourceId,
      Object.freeze({
        id: comment.sourceId,
        kind: "comment",
        actorType: event?.actor.type ?? "system",
        createdAt: comment.createdAt,
        content: comment.body,
      }),
    );
  }
  if (analysis.detail.type === "pull_request") {
    if (analysis.item.type !== "pull_request") {
      throw new TypeError("Pull RequestのCodex入力にIssueの観測値が指定されています");
    }
    for (const thread of analysis.detail.reviewThreads) {
      for (const comment of thread.comments) {
        const event = analysis.item.events.find(
          (candidate) => candidate.sourceId === comment.sourceId,
        );
        sourceRecords.set(
          comment.sourceId,
          Object.freeze({
            id: comment.sourceId,
            kind: "comment",
            actorType: event?.actor.type ?? "system",
            createdAt: comment.createdAt,
            content: comment.body,
          }),
        );
      }
    }
    for (const review of analysis.detail.reviews) {
      const event = analysis.item.events.find(
        (candidate) => candidate.sourceId === review.sourceId,
      );
      sourceRecords.set(
        review.sourceId,
        Object.freeze({
          id: review.sourceId,
          kind: "review",
          actorType: event?.actor.type ?? "system",
          createdAt: review.submittedAt,
          content: review.body,
        }),
      );
    }
    for (const request of analysis.detail.reviewRequests.current) {
      if (request.requestedAt.status === "unavailable") {
        continue;
      }
      sourceRecords.set(
        request.sourceId,
        Object.freeze({
          id: request.sourceId,
          kind: "review_request",
          actorType: "system",
          createdAt: request.requestedAt.value,
        }),
      );
    }
    if (analysis.item.mergeState.autoMerge.status === "enabled") {
      const autoMerge = analysis.item.mergeState.autoMerge;
      sourceRecords.set(
        autoMerge.sourceId,
        Object.freeze({
          id: autoMerge.sourceId,
          kind: "auto_merge_request",
          actorType: autoMerge.enabledBy.type,
          createdAt: autoMerge.enabledAt,
          mergeMethod: autoMerge.mergeMethod,
        }),
      );
    }
  }
  if (
    analysis.detail.type === "pull_request" &&
    analysis.detail.mergeState.checks.status === "configured"
  ) {
    const checks = analysis.detail.mergeState.checks;
    sourceRecords.set(
      checks.sourceId,
      Object.freeze({
        id: checks.sourceId,
        kind: "required_check_rollup",
        actorType: "system",
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, checks.sourceId),
        combinedState: checks.combinedState,
      }),
    );
    for (const context of checks.contexts) {
      sourceRecords.set(
        context.sourceId,
        Object.freeze({
          id: context.sourceId,
          kind: context.type,
          actorType: "system",
          createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, context.sourceId),
          ...(context.type === "check_run"
            ? {
                name: context.name,
                status: context.status,
                conclusion: context.conclusion,
              }
            : {
                context: context.context,
                state: context.state,
              }),
        }),
      );
    }
  }
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    for (const sourceContext of effectiveCandidateContext.sourceContexts) {
      addCodexSourceRecordsForContext(sourceRecords, sourceOccurredAtById, sourceContext);
    }
  }
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: evaluatedAt,
    item: {
      nodeId: analysis.item.nodeId,
      url: analysis.item.url,
      type: analysis.item.type,
      title: analysis.item.title,
      ...(authorCandidateId == null ? {} : { authorCandidateId }),
      ...(analysis.item.type === "pull_request"
        ? {
            headSha: analysis.item.headSha,
          }
        : {}),
    },
    candidates: {
      waitingOn: [...waitingOnCandidates.values()],
      relations: relationCandidates.map((candidate) => ({
        id: candidate.id,
        targetUrl: relationTargetUrl(analysis.item.nodeId, candidate),
      })),
    },
    sources: [...sourceRecords.values()],
    deterministicSignals: {
      status: analysis.decision.status,
      waitingOn: analysis.decision.waitingOn,
      relationCandidateIds: relationCandidates.map((candidate) => candidate.id),
      ...nativeRelationSignals,
      mentionedWaitingOnCandidates: mentionedCandidates,
      requiredCheckFailure:
        analysis.detail.type === "pull_request" &&
        analysis.detail.mergeState.checks.status === "configured" &&
        (analysis.detail.mergeState.checks.combinedState === "failure" ||
          analysis.detail.mergeState.checks.combinedState === "error")
          ? analysis.detail.mergeState.checks
          : null,
      uncertainties: analysis.decision.uncertainties,
      effectiveAssigneeEligible:
        analysis.item.type === "issue" &&
        analysis.item.state === "open" &&
        analysis.item.assignees.length === 0,
      effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(({ candidate }) => ({
        candidateId: candidate.candidateId,
        sourceIds: candidate.sourceIds,
        occurredAt: candidate.occurredAt,
      })),
      effectiveAssigneeImplementations: analysis.effectiveAssigneeCandidates.flatMap(
        ({ candidate, sourceContexts }) =>
          sourceContexts.flatMap(({ item: sourceItem }) => {
            if (sourceItem.type !== "pull_request") {
              return [];
            }
            return analysis.relationCandidates.flatMap((relationCandidate) => {
              if (
                relationCandidate.relation.type !== "implements" ||
                relationCandidate.relation.implementation.nodeId !== sourceItem.nodeId ||
                relationCandidate.relation.target.nodeId !== analysis.item.nodeId
              ) {
                return [];
              }
              return [
                {
                  candidateId: candidate.candidateId,
                  pullRequestNodeId: sourceItem.nodeId,
                  pullRequestUrl: sourceItem.url,
                  pullRequestState: resolveEffectiveAssigneePullRequestState(sourceItem),
                  relationCandidateIds: [relationCandidate.id],
                },
              ];
            });
          }),
      ),
      effectiveAssigneeConfidenceThreshold: configuration.config.ai.confidence.high,
    },
    priorAnalysis: null,
  });
}

function createAiCandidates(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  identity: AiAnalysisRunIdentity,
): Readonly<{
  candidates: readonly PreparedAiAnalysisCandidate[];
  failures: readonly AiAnalysisRunFailure[];
  inputValidationFailures: readonly Readonly<{
    candidateId: string;
    error: unknown;
  }>[];
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
}> {
  const inputByNodeId = new Map<GitHubNodeId, CodexAnalysisInput>();
  const failures: AiAnalysisRunFailure[] = [];
  const inputValidationFailures: {
    candidateId: string;
    error: unknown;
  }[] = [];
  const previousGraph = previousGraphSnapshot(state);
  const previousGraphAnalysis =
    previousGraph == null
      ? undefined
      : analyzeGraph({
          current: previousGraph,
          previous: {
            availability: "unavailable",
          },
        });
  const previousImpactByNodeId = new Map(
    (previousGraphAnalysis?.downstreamImpacts ?? []).map((impact) => [impact.nodeId, impact]),
  );
  const previousRelations = previousSnapshot(state)?.relations ?? [];
  const previousAiFingerprintByNodeId = new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item.aiAnalysisFingerprint] as const),
    ),
  );
  const previousAiAnalysisStatusByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item.aiAnalysis.status]),
  );
  const candidates: PreparedAiAnalysisCandidate[] = [];
  for (const analysis of deterministicAnalysis.items) {
    let input: CodexAnalysisInput;
    try {
      input = createCodexInput(configuration, collection.evaluatedAt, analysis);
    } catch (error: unknown) {
      inputValidationFailures.push(
        Object.freeze({
          candidateId: analysis.item.nodeId,
          error,
        }),
      );
      failures.push(
        Object.freeze({
          candidateId: analysis.item.nodeId,
          reason: "input_validation_failed",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
      continue;
    }
    inputByNodeId.set(analysis.item.nodeId, input);
    const naturalLanguageProgressCandidate = analysis.item.events.some(
      (event) => event.kind === "comment" && event.actor.type === "human" && !event.bodyEmpty,
    );
    const effectiveAssigneeCandidate = analysis.effectiveAssigneeCandidates.length > 0;
    const relationAssessmentCandidates = selectRelationAssessmentCandidates(
      analysis.item.nodeId,
      analysis.relationCandidates,
    );
    const previousIncomingBlockers = new Set<string>(
      previousRelations
        .filter(
          (relation) =>
            relation.active &&
            relation.type === "blocks" &&
            relation.toNodeId === analysis.item.nodeId,
        )
        .map((relation) => relation.id),
    );
    const currentPotentialBlockers = new Set<string>(
      analysis.relationCandidates
        .filter((candidate) => {
          if (candidate.relation.type === "blocks") {
            return candidate.relation.blocked.nodeId === analysis.item.nodeId;
          }
          return candidate.authority === "inferred";
        })
        .map((candidate) => candidate.id),
    );
    const relatedNodeChanged = analysis.relationCandidates.some((candidate) =>
      relationNodes(candidate.relation).some(
        (node) =>
          node.nodeId !== analysis.item.nodeId &&
          node.scope === "organization" &&
          collection.changedNodeIds.has(node.nodeId),
      ),
    );
    const changedBlocker =
      relatedNodeChanged ||
      previousIncomingBlockers.size !== currentPotentialBlockers.size ||
      [...previousIncomingBlockers].some((id) => !currentPotentialBlockers.has(id));
    const previousImpact = previousImpactByNodeId.get(analysis.item.nodeId);
    const estimatedCost = estimateAiInputCost(
      `${serializeCanonicalJson(input)}\n`,
      configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
    );
    candidates.push(
      prepareAiAnalysisCandidate(
        Object.freeze({
          id: analysis.item.nodeId,
          deterministicResolution:
            analysis.decision.determination === "determined" &&
            !effectiveAssigneeCandidate &&
            !naturalLanguageProgressCandidate &&
            relationAssessmentCandidates.every(
              (candidate) => candidate.authority === "authoritative",
            )
              ? "high_confidence"
              : "ambiguous",
          input,
          graphNeighborhood: Object.freeze(
            analysis.relationCandidates.map((candidate) => candidate.id),
          ),
          previousFingerprint:
            previousAiFingerprintByNodeId.get(analysis.item.nodeId) ??
            Object.freeze({
              status: "unavailable",
            }),
          priority: Object.freeze({
            previouslyDeferred:
              previousAiAnalysisStatusByNodeId.get(analysis.item.nodeId) === "deferred",
            severityCandidate: analysis.decision.determination === "codex_candidate",
            ownerUnknown: analysis.decision.waitingOn.some(
              (waitingOn) => waitingOn.kind === "unknown",
            ),
            changedBlocker,
            downstreamImpact: Object.freeze({
              openNodeCount: previousImpact?.openNodeCount ?? 0,
              repositoryCount: previousImpact?.repositoryCount ?? 0,
            }),
          }),
          estimatedCostUsd: estimatedCost.estimatedCostUsd,
        } satisfies AiAnalysisCandidate),
        identity,
      ),
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    failures: Object.freeze(failures),
    inputValidationFailures: Object.freeze(inputValidationFailures),
    inputByNodeId,
  });
}

function codexFallbackDiagnostic(failure: AiAnalysisRunFailure): string {
  return safeCodexFallbackDiagnostic(
    failure.candidateId,
    failure.reason,
    failure.errorType,
    failure.diagnostic,
    failure.validationDiagnostic,
  );
}

function countRetainedAiResults(state: RuntimeState, collection: CollectedItems): number {
  return (previousSnapshot(state)?.items ?? []).filter(
    (item) =>
      item.aiAnalysis.status === "used" &&
      collection.trackedNodeIds.has(item.nodeId) &&
      !collection.analysisNodeIds.has(item.nodeId),
  ).length;
}

function createCodexAdapterConfiguration(config: Config): CodexAdapterConfiguration {
  return Object.freeze({
    authentication: config.ai.authentication,
    model: config.ai.model,
    execution: {
      timeoutSeconds: config.ai.execution.timeoutSeconds,
      maxAttempts: config.ai.execution.maxAttempts,
      sandbox: config.ai.execution.sandbox,
      approvalPolicy: config.ai.execution.approvalPolicy,
      reasoningEffort: config.ai.execution.reasoningEffort,
    },
    retry: {
      initialDelaySeconds: config.operations.retry.initialDelaySeconds,
      maxDelaySeconds: config.operations.retry.maxDelaySeconds,
    },
  }) satisfies CodexAdapterConfiguration;
}

function createCodexAdapterDependencies(
  adapters: ProductionRuntimeAdapters,
  credentials: EnabledCodexCredentials,
  diagnostics: CodexDiagnosticsContext | undefined,
): CodexAdapterDependencies {
  return Object.freeze({
    environment: credentials.environment,
    processRunner: adapters.codexProcessRunner,
    runtime: {
      sleep: adapters.sleep,
      random: adapters.random,
    },
    ...(diagnostics == null ? {} : { diagnostics }),
  });
}

function createCodexPreflightDiagnostics(
  diagnostics: CodexDiagnosticsContext | undefined,
  invocation: DailyRunInvocation,
): CodexDiagnosticsContext | undefined {
  if (diagnostics == null) {
    return undefined;
  }
  return Object.freeze({
    recorder: diagnostics.recorder,
    ...(diagnostics.runId == null ? {} : { runId: diagnostics.runId }),
    invocationId: `${invocation.runId}:codex:authentication-preflight`,
  });
}

async function analyzeCodex(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
): Promise<
  Readonly<{
    stage: CodexAnalysis;
    status: "success" | "fallback";
    aiCallCount: number;
    aiCacheHitCount: number;
    aiRetainedResultCount: number;
    estimatedInputTokens: number;
    diagnostics: readonly string[];
  }>
> {
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const prepared = createAiCandidates(
    configuration,
    state,
    collection,
    deterministicAnalysis,
    identity,
  );
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: `${invocation.runId}:codex`,
        });
  for (const failure of prepared.inputValidationFailures) {
    await recordCodexDiagnostic(
      diagnostics == null
        ? undefined
        : Object.freeze({
            ...diagnostics,
            candidateId: failure.candidateId,
          }),
      "codex.input.validation_failed",
      {
        phase: "input_validation",
        errorType: failure.error instanceof Error ? failure.error.name : typeof failure.error,
      },
      failure.error,
    );
  }
  if (!configuration.config.ai.enabled) {
    const fallback = prepared.failures.length > 0;
    return Object.freeze({
      stage: Object.freeze({
        run: undefined,
        inputByNodeId: prepared.inputByNodeId,
      }),
      status: fallback ? "fallback" : "success",
      aiCallCount: 0,
      aiCacheHitCount: 0,
      aiRetainedResultCount: countRetainedAiResults(state, collection),
      estimatedInputTokens: 0,
      diagnostics: Object.freeze(prepared.failures.map(codexFallbackDiagnostic)),
    });
  }
  const codexCredentials = configuration.credentials.codex;
  if (!codexCredentials.enabled) {
    throw new TypeError("AIが有効ですがCodex認証情報がありません");
  }
  const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
  const codexDependencies = createCodexAdapterDependencies(adapters, codexCredentials, diagnostics);
  const preflightInputCost =
    codexCredentials.authentication === "auth-json"
      ? estimateAiInputCost(
          CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
          configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        )
      : undefined;
  const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
  const preflight =
    preflightInputCost == null
      ? undefined
      : Object.freeze({
          inputCharacters: CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
          estimatedCostUsd: preflightInputCost.estimatedCostUsd,
          execute: () =>
            adapters.executeCodexAuthenticationPreflight(
              codexConfiguration,
              Object.freeze({
                ...codexDependencies,
                ...(preflightDiagnostics == null
                  ? {}
                  : {
                      diagnostics: preflightDiagnostics,
                    }),
              }),
            ),
        });
  const executedRun = await runAiAnalyses(
    prepared.candidates,
    {
      identity,
      budget: configuration.config.ai.budget,
      maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
    },
    {
      cache: state.session.aiCache,
      ...(preflight == null ? {} : { preflight }),
      ...(diagnostics == null ? {} : { diagnostics }),
      execute: (input, context) =>
        adapters.executeCodexAnalysis(
          input,
          codexConfiguration,
          Object.freeze({
            ...codexDependencies,
            ...(diagnostics == null
              ? {}
              : {
                  diagnostics: Object.freeze({
                    ...diagnostics,
                    invocationId: `${invocation.runId}:${context.candidateId}`,
                    candidateId: context.candidateId,
                  }),
                }),
          }),
        ),
      executedAt: () => collection.evaluatedAt,
    },
  );
  const run = Object.freeze({
    ...executedRun,
    failures: Object.freeze([...prepared.failures, ...executedRun.failures]),
  }) satisfies AiAnalysisRunResult;
  const fallback = run.failures.length > 0 || run.deferred.length > 0;
  return Object.freeze({
    stage: Object.freeze({
      run,
      inputByNodeId: prepared.inputByNodeId,
    }),
    status: fallback ? "fallback" : "success",
    aiCallCount: run.usage.calls,
    aiCacheHitCount: run.results.filter((result) => result.origin === "cache").length,
    aiRetainedResultCount: countRetainedAiResults(state, collection),
    estimatedInputTokens: Math.ceil(run.usage.inputCharacters / 4),
    diagnostics: Object.freeze([
      ...run.failures.map(codexFallbackDiagnostic),
      ...run.deferred.map(
        (deferred) => `codex_deferred item=${deferred.candidateId} reason=${deferred.reason}`,
      ),
    ]),
  });
}

function deterministicCodexDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): DeterministicCodexDecision {
  return Object.freeze({
    determination: decision.determination,
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

function reducedDeterministicDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): ReducedCodexDecision {
  return Object.freeze({
    origin: "deterministic",
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

function unavailableImportanceAssessment(): NaturalLanguageImportanceAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

function unavailableDeadlineAssessment(): NaturalLanguageDeadlineAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

function deadlineLevelForAssessment(
  assessment: NaturalLanguageDeadlineAssessmentState,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): DeadlineLevel {
  if (assessment.status === "not_available") {
    return "none";
  }
  return determineDeadlineLevel({
    deadlineDate: assessment.value.date,
    evaluatedAt,
    timezone,
  });
}

function resolveImportanceAssessment(
  current: NaturalLanguageImportanceAssessmentState | undefined,
  previous: NaturalLanguageImportanceAssessmentState | undefined,
): NaturalLanguageImportanceAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return previous ?? unavailableImportanceAssessment();
}

function resolveDeadlineAssessment(
  current: NaturalLanguageDeadlineAssessmentState | undefined,
  previous: NaturalLanguageDeadlineAssessmentState | undefined,
): NaturalLanguageDeadlineAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return previous ?? unavailableDeadlineAssessment();
}

function preserveDeterministicUnassignedIssueDecision(
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput,
  reduction: CodexAnalysisReduction,
): CodexAnalysisReduction {
  if (
    analysis.item.type !== "issue" ||
    analysis.item.state !== "open" ||
    analysis.item.assignees.length !== 0 ||
    output.status !== "waiting_for_work" ||
    analysis.decision.status === "waiting_for_work"
  ) {
    return reduction;
  }
  return Object.freeze({
    ...reduction,
    decision: reducedDeterministicDecision(analysis.decision),
  });
}

function reductionForAnalysis(
  configuration: RuntimeConfiguration,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): CodexAnalysisReduction | undefined {
  const run = codexAnalysis.run;
  if (run == null) {
    return undefined;
  }
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  const result = run.results.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (result != null) {
    assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
    const reduction = reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "validated",
        output: result.output,
      },
      configuration.config.ai.confidence,
    );
    return preserveDeterministicUnassignedIssueDecision(analysis, result.output, reduction);
  }
  const failure = run.failures.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (failure != null) {
    if (input == null) {
      if (failure.reason !== "input_validation_failed") {
        throw new TypeError(
          `Codex入力がない項目の失敗理由が入力検証ではありません。対象: ${analysis.item.nodeId}`,
        );
      }
      const relationCandidateIds = deduplicateByStableId(
        selectRelationAssessmentCandidates(analysis.item.nodeId, analysis.relationCandidates),
        (candidate) => candidate.id,
      ).map((candidate) => candidate.id);
      return reduceCodexInputValidationFailure(
        deterministicCodexDecision(analysis.decision),
        relationCandidateIds,
        failure.errorType,
      );
    }
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "unavailable",
        reason: failure.reason,
        errorType: failure.errorType,
      },
      configuration.config.ai.confidence,
    );
  }
  const deferred = run.deferred.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (deferred != null) {
    assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "unavailable",
        reason: "execution_failed",
        errorType: `CodexBudgetDeferred:${deferred.reason}`,
      },
      configuration.config.ai.confidence,
    );
  }
  return undefined;
}

function codexOutputForAnalysis(
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): ValidatedCodexAnalysisOutput | undefined {
  return codexAnalysis.run?.results.find(
    (candidate) => candidate.candidateId === analysis.item.nodeId,
  )?.output;
}

function nonEmptySourceIds(
  sourceIds: readonly SourceId[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort();
  const firstSourceId = uniqueSourceIds[0];
  assertNonNullable(firstSourceId, `${context}のsource IDがありません`);
  return Object.freeze([firstSourceId, ...uniqueSourceIds.slice(1)]);
}

function sourceIdSetsMatch(left: readonly SourceId[], right: readonly SourceId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftSourceIds = new Set(left);
  const rightSourceIds = new Set(right);
  return (
    leftSourceIds.size === left.length &&
    rightSourceIds.size === right.length &&
    leftSourceIds.size === rightSourceIds.size &&
    [...leftSourceIds].every((id) => rightSourceIds.has(id))
  );
}

function createEffectiveAssigneeAssessment(
  configuration: RuntimeConfiguration,
  evaluatedAt: UtcIsoDateTime,
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput | undefined,
): IssueEffectiveAssigneeAssessment {
  if (
    analysis.item.type !== "issue" ||
    analysis.item.state !== "open" ||
    analysis.item.assignees.length !== 0 ||
    analysis.effectiveAssigneeCandidates.length === 0 ||
    output?.status !== "waiting_for_work" ||
    output.waitingOn.length === 0 ||
    output.confidence < configuration.config.ai.confidence.high
  ) {
    return Object.freeze({
      status: "not_assessed",
    });
  }

  const candidatesById = new Map(
    analysis.effectiveAssigneeCandidates.map((context) => [
      context.candidate.candidateId.toLowerCase(),
      context.candidate,
    ]),
  );
  const targets: IssueEffectiveAssigneeTarget[] = [];
  const targetIds = new Set<string>();
  for (const waitingOn of output.waitingOn) {
    if (
      waitingOn.kind !== "user" ||
      waitingOn.role !== "assignee" ||
      waitingOn.confidence < configuration.config.ai.confidence.high
    ) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    const normalizedCandidateId = waitingOn.candidateId.toLowerCase();
    if (targetIds.has(normalizedCandidateId)) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    targetIds.add(normalizedCandidateId);
    const candidate = candidatesById.get(normalizedCandidateId);
    if (candidate == null) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    if (candidate.candidateId !== waitingOn.candidateId) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    if (!sourceIdSetsMatch(waitingOn.sourceIds, candidate.sourceIds)) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    targets.push(
      Object.freeze({
        kind: "user",
        candidateId: waitingOn.candidateId,
        sourceIds: waitingOn.sourceIds,
        confidence: waitingOn.confidence,
      }),
    );
  }
  const selectedCandidateSourceIds = nonEmptySourceIds(
    targets.flatMap((target) => target.sourceIds),
    "実質担当判定対象",
  );
  const candidateSourceIds = nonEmptySourceIds(
    analysis.effectiveAssigneeCandidates.flatMap(({ candidate }) => candidate.sourceIds),
    "実質担当候補",
  );
  const selectedCandidates = targets.map((target) => {
    const candidate = candidatesById.get(target.candidateId.toLowerCase());
    assertNonNullable(candidate, `実質担当候補を取得できません。対象: ${target.candidateId}`);
    return candidate;
  });
  const firstCandidate = selectedCandidates[0];
  assertNonNullable(firstCandidate, "実質担当判定の候補がありません");
  const occurredAt = selectedCandidates.reduce(
    (latest, candidate) => (latest < candidate.occurredAt ? candidate.occurredAt : latest),
    firstCandidate.occurredAt,
  );
  if (occurredAt > evaluatedAt) {
    throw new RangeError("実質担当判定の根拠時刻は判定時刻以前にしてください");
  }
  const confidence = Math.min(output.confidence, ...targets.map((target) => target.confidence));
  if (confidence < configuration.config.ai.confidence.high) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const firstTarget = targets[0];
  assertNonNullable(firstTarget, "実質担当判定の対象userがありません");
  return Object.freeze({
    status: "assessed",
    candidateSourceIds,
    verdict: "effective_assignee",
    targets: Object.freeze([firstTarget, ...targets.slice(1)] satisfies [
      IssueEffectiveAssigneeTarget,
      ...IssueEffectiveAssigneeTarget[],
    ]),
    occurredAt,
    confidence,
    sourceIds: selectedCandidateSourceIds,
  });
}

function explicitRequestAssessment(
  item: Extract<FreshObservedGitHubItem, Readonly<{ type: "issue" }>>,
  detail: Extract<GitHubItemDetail, Readonly<{ type: "issue" }>>,
  output: ValidatedCodexAnalysisOutput | undefined,
): IssueExplicitRequestAssessment {
  const candidates = createIssueRequestCandidates(item, detail);
  if (output == null || candidates.length === 0) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const candidateSourceIds = nonEmptySourceIds(
    candidates.map((candidate) => candidate.sourceId),
    "明示依頼候補",
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(detail);
  const mentionedByKey = new Map(
    mentionedCandidates.map((candidate) => [
      `${candidate.kind}:${candidate.id.toLowerCase()}`,
      candidate,
    ]),
  );
  const targets: IssueExplicitRequestTarget[] = output.waitingOn.flatMap((waitingOn) => {
    if (waitingOn.kind !== "user" && waitingOn.kind !== "team") {
      return [];
    }
    const mentioned = mentionedByKey.get(
      `${waitingOn.kind}:${waitingOn.candidateId.toLowerCase()}`,
    );
    if (
      mentioned == null ||
      !waitingOn.sourceIds.some((sourceId) => mentioned.sourceIds.includes(sourceId))
    ) {
      return [];
    }
    const role =
      waitingOn.role === "dependency" ||
      waitingOn.role === "merge_decider" ||
      waitingOn.role === "ci"
        ? "unknown"
        : waitingOn.role;
    return [
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role,
        sourceIds: waitingOn.sourceIds,
        confidence: Math.min(output.confidence, waitingOn.confidence),
      }),
    ];
  });
  if (targets.length === 0) {
    return Object.freeze({
      status: "assessed",
      candidateSourceIds,
      verdict: "no_unanswered_request",
      confidence: output.confidence,
      sourceIds: candidateSourceIds,
    });
  }
  const requestCandidate = [...candidates]
    .filter((candidate) => targets.some((target) => target.sourceIds.includes(candidate.sourceId)))
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt > right.occurredAt ? -1 : 1;
      }
      return left.sourceId.localeCompare(right.sourceId);
    })[0];
  assertNonNullable(requestCandidate, "未回答の明示依頼に対応する候補がありません");
  const latestTargets = targets.filter((target) =>
    target.sourceIds.includes(requestCandidate.sourceId),
  );
  const firstTarget = latestTargets[0];
  assertNonNullable(firstTarget, "最新の明示依頼先がありません");
  return Object.freeze({
    status: "assessed",
    candidateSourceIds,
    verdict: "unanswered_request",
    requestSourceId: requestCandidate.sourceId,
    targets: Object.freeze([firstTarget, ...latestTargets.slice(1)] satisfies [
      IssueExplicitRequestTarget,
      ...IssueExplicitRequestTarget[],
    ]),
    confidence: Math.min(output.confidence, ...latestTargets.map((target) => target.confidence)),
    sourceIds: nonEmptySourceIds(
      latestTargets.flatMap((target) => target.sourceIds),
      "未回答の明示依頼判定",
    ),
  });
}

function checkFailureSourceIds(
  detail: Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>>,
): readonly [SourceId, ...SourceId[]] | undefined {
  if (
    detail.mergeState.checks.status !== "configured" ||
    (detail.mergeState.checks.combinedState !== "failure" &&
      detail.mergeState.checks.combinedState !== "error")
  ) {
    return undefined;
  }
  const failingContextSourceIds = detail.mergeState.checks.contexts.flatMap((context) => {
    if (context.type === "commit_status") {
      return context.state === "failure" || context.state === "error" ? [context.sourceId] : [];
    }
    return context.conclusion === "failure" ||
      context.conclusion === "timed_out" ||
      context.conclusion === "startup_failure" ||
      context.conclusion === "action_required"
      ? [context.sourceId]
      : [];
  });
  return nonEmptySourceIds(
    [detail.mergeState.checks.sourceId, ...failingContextSourceIds],
    "required check失敗",
  );
}

function checkFailureAssessment(
  detail: Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>>,
  output: ValidatedCodexAnalysisOutput | undefined,
): PullRequestCheckFailureAssessment {
  const sourceIds = checkFailureSourceIds(detail);
  if (sourceIds == null || output == null) {
    return Object.freeze({
      cause: "not_assessed",
    });
  }
  const effectiveConfidence = Math.min(
    output.confidence,
    ...output.waitingOn.map((waitingOn) => waitingOn.confidence),
  );
  const authorAction =
    output.status === "waiting_for_revision" ||
    output.waitingOn.some((waitingOn) => waitingOn.role === "author");
  if (authorAction) {
    return Object.freeze({
      cause: "pull_request_change",
      confidence: effectiveConfidence,
      sourceIds,
    });
  }
  const infrastructureOrFlaky =
    output.status === "waiting_for_automation" ||
    output.status === "waiting_for_decision" ||
    output.status === "unknown" ||
    output.waitingOn.some(
      (waitingOn) =>
        waitingOn.kind === "automation" ||
        waitingOn.kind === "unknown" ||
        waitingOn.role === "ci" ||
        waitingOn.role === "maintainer" ||
        waitingOn.role === "unknown",
    );
  return Object.freeze({
    cause: infrastructureOrFlaky ? "infrastructure_or_flaky" : "ambiguous",
    confidence: effectiveConfidence,
    sourceIds,
  });
}

function naturalLanguageProgressAssessments(
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput | undefined,
): readonly NaturalLanguageProgressAssessment[] {
  if (output == null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    analysis.item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) =>
        Object.freeze({
          candidateSourceId: event.sourceId,
          verdict:
            output.progress.latestMeaningfulSourceId === event.sourceId
              ? "meaningful_progress"
              : "not_meaningful_progress",
          confidence: Math.min(output.confidence, output.progress.confidence),
          sourceIds: Object.freeze([event.sourceId] satisfies [SourceId]),
        }),
      ),
  );
}

function graphNodeState(
  state: RuntimeState,
  deterministicAnalysis: DeterministicAnalysis,
  graph: GraphResult,
  nodeId: GraphNodeId,
): TrackedItem["state"] {
  const currentItem = deterministicAnalysis.items.find(
    (analysis) => analysis.item.nodeId === nodeId,
  )?.item;
  if (currentItem != null) {
    return currentItem.state;
  }
  const externalReference = graph.externalReferences.find(
    (reference) => reference.nodeId === nodeId,
  );
  if (externalReference != null) {
    return externalReference.state;
  }
  const previousItem = previousSnapshot(state)?.items.find((item) => item.nodeId === nodeId);
  assertNonNullable(previousItem, `blocker ${nodeId}の状態がありません`);
  return previousItem.state;
}

function graphBlockers(
  state: RuntimeState,
  deterministicAnalysis: DeterministicAnalysis,
  graph: GraphResult,
  item: FreshObservedGitHubItem,
): readonly IssueBlocker[] {
  const blockersByCandidateId = new Map<GraphNodeId, IssueBlocker>();
  for (const edge of graph.edges) {
    if (!edge.active || edge.type !== "blocks" || edge.toNodeId !== item.nodeId) {
      continue;
    }
    const edgeSourceIds = nonEmptySourceIds(
      edge.evidence.map((evidence) => evidence.sourceId),
      `blocker edge ${edge.id}`,
    );
    const edgeBecameBlockingAt = edge.provenance === "native" ? item.createdAt : edge.firstSeenAt;
    const existing = blockersByCandidateId.get(edge.fromNodeId);
    if (existing == null) {
      blockersByCandidateId.set(
        edge.fromNodeId,
        Object.freeze({
          candidateId: edge.fromNodeId,
          state: graphNodeState(state, deterministicAnalysis, graph, edge.fromNodeId),
          authority: edge.authoritative ? "authoritative" : "inferred",
          confidence: edge.confidence,
          sourceIds: edgeSourceIds,
          becameBlockingAt: edgeBecameBlockingAt,
        }),
      );
      continue;
    }
    const authority =
      existing.authority === "authoritative" || edge.authoritative ? "authoritative" : "inferred";
    const becameBlockingAt =
      existing.becameBlockingAt < edgeBecameBlockingAt
        ? existing.becameBlockingAt
        : edgeBecameBlockingAt;
    blockersByCandidateId.set(
      edge.fromNodeId,
      Object.freeze({
        ...existing,
        authority,
        confidence: Math.max(existing.confidence, edge.confidence),
        sourceIds: nonEmptySourceIds(
          [...existing.sourceIds, ...edgeSourceIds],
          `blocker ${edge.fromNodeId}`,
        ),
        becameBlockingAt,
      }),
    );
  }
  return Object.freeze(
    [...blockersByCandidateId.values()].sort((left, right) =>
      left.candidateId.localeCompare(right.candidateId),
    ),
  );
}

function reassessDeterministicAnalysis(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  deterministicAnalysis: DeterministicAnalysis,
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput | undefined,
  graph: GraphResult | undefined,
): DeterministicItemAnalysis {
  const repository = findRepository(inventory, analysis.item.repositoryId);
  const maintainers = resolveRepositoryMaintainers(
    configuration.config.maintainers,
    repositoryFullName(repository),
  );
  const blockers =
    graph == null
      ? createNativeBlockers(analysis.item, analysis.relationCandidates)
      : graphBlockers(state, deterministicAnalysis, graph, analysis.item);
  if (analysis.item.type === "issue" && analysis.detail.type === "issue") {
    return Object.freeze({
      ...analysis,
      decision: determineIssueState({
        issue: analysis.item,
        blockers,
        explicitRequestCandidates: createIssueRequestCandidates(analysis.item, analysis.detail),
        explicitRequestAssessment: explicitRequestAssessment(
          analysis.item,
          analysis.detail,
          output,
        ),
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(
          (candidate) => candidate.candidate,
        ),
        effectiveAssigneeAssessment: createEffectiveAssigneeAssessment(
          configuration,
          evaluatedAt,
          analysis,
          output,
        ),
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
    });
  }
  if (analysis.item.type === "pull_request" && analysis.detail.type === "pull_request") {
    const resolveLabelEffects = createLabelEffectsResolver(
      normalizeLabelRules(configuration.config),
    );
    return Object.freeze({
      ...analysis,
      decision: determinePullRequestState({
        pullRequest: analysis.item,
        blockers,
        checkFailureAssessment: checkFailureAssessment(analysis.detail, output),
        labelEffects: resolveLabelEffects(repositoryFullName(repository), analysis.item.labels),
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
    });
  }
  throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${analysis.item.nodeId}`);
}

function enumeratedTerminalAt(item: EnumeratedGitHubItem | undefined): UtcIsoDateTime | undefined {
  if (item == null) {
    return undefined;
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return item.mergedAt;
  }
  return item.state === "closed" ? item.closedAt : undefined;
}

function previousBlockerEdges(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): ReadonlyMap<GraphNodeId, readonly (Relation & Readonly<{ active: true }>)[]> {
  const snapshot = previousSnapshot(state);
  assertNonNullable(snapshot, `newly unblocked項目 ${nodeId}の前回snapshotがありません`);
  const previousStateByNodeId = new Map<GraphNodeId, TrackedItem["state"]>([
    ...snapshot.items.map((item) => [item.nodeId, item.state] as const),
    ...snapshot.externalReferences.map((item) => [item.nodeId, item.state] as const),
  ]);
  const edgesByBlockerNodeId = new Map<GraphNodeId, (Relation & Readonly<{ active: true }>)[]>();
  for (const edge of snapshot.relations) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      edge.toNodeId !== nodeId ||
      previousStateByNodeId.get(edge.fromNodeId) !== "open"
    ) {
      continue;
    }
    const edges = edgesByBlockerNodeId.get(edge.fromNodeId);
    if (edges == null) {
      edgesByBlockerNodeId.set(edge.fromNodeId, [edge]);
    } else {
      edges.push(edge);
    }
  }
  return edgesByBlockerNodeId;
}

function relationRemovalEventOccurredAts(
  collection: CollectedItems,
  edge: Relation,
): readonly UtcIsoDateTime[] {
  const latestEvent = collection.observedItems
    .flatMap((item) => item.events)
    .filter(
      (event) =>
        event.kind === "relation" &&
        event.target.type === "node" &&
        event.relationType === edge.type &&
        event.provenance === edge.provenance &&
        event.occurredAt >= edge.firstSeenAt &&
        (event.direction === "from_item"
          ? event.itemNodeId === edge.fromNodeId && event.target.nodeId === edge.toNodeId
          : event.itemNodeId === edge.toNodeId && event.target.nodeId === edge.fromNodeId),
    )
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt.localeCompare(right.occurredAt);
      }
      return left.sourceId.localeCompare(right.sourceId);
    })
    .at(-1);
  return Object.freeze(
    latestEvent?.kind === "relation" && latestEvent.action === "removed"
      ? [latestEvent.occurredAt]
      : [],
  );
}

function editedRelationSourceOccurredAts(
  collection: CollectedItems,
  edge: Relation,
): readonly UtcIsoDateTime[] {
  const evidenceSourceIds = new Set(edge.evidence.map((evidence) => evidence.sourceId));
  return Object.freeze(
    collection.details.flatMap((detail) =>
      detail.comments.flatMap((comment) =>
        evidenceSourceIds.has(comment.sourceId) && comment.updatedAt !== comment.createdAt
          ? [comment.updatedAt]
          : [],
      ),
    ),
  );
}

function createDependencySourceOccurredAtById(
  collection: CollectedItems,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const item of collection.observedItems) {
    const detail = collection.details.find((candidate) => candidate.nodeId === item.nodeId);
    assertNonNullable(detail, `依存解消sourceの詳細がありません。対象: ${item.nodeId}`);
    for (const [sourceId, occurredAt] of createCodexSourceOccurredAtById(item, detail)) {
      const existingOccurredAt = sourceOccurredAtById.get(sourceId);
      if (existingOccurredAt == null || existingOccurredAt < occurredAt) {
        sourceOccurredAtById.set(sourceId, occurredAt);
      }
    }
  }
  return sourceOccurredAtById;
}

function resolvedSourceOccurredAts(
  sourceIds: readonly SourceId[],
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): readonly UtcIsoDateTime[] {
  return Object.freeze(
    [...new Set(sourceIds)].flatMap((sourceId) => {
      const occurredAt = sourceOccurredAtById.get(sourceId);
      return occurredAt == null ? [] : [occurredAt];
    }),
  );
}

function relationResolutionOccurredAt(
  collection: CollectedItems,
  graph: GraphResult,
  relationAssessments: readonly RelationCandidateAssessment[],
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  edge: Relation & Readonly<{ active: true }>,
): UtcIsoDateTime {
  const removalEventOccurredAts = relationRemovalEventOccurredAts(collection, edge);
  if (removalEventOccurredAts.length > 0) {
    return latestUtcIsoDateTime(removalEventOccurredAts, `relation ${edge.id}の削除イベント`);
  }
  const currentCandidate = collection.relationCandidates.find(
    (candidate) => candidate.id === edge.id,
  );
  if (currentCandidate == null) {
    const editedSourceOccurredAts = editedRelationSourceOccurredAts(collection, edge);
    return editedSourceOccurredAts.length === 0
      ? edge.firstSeenAt
      : latestUtcIsoDateTime(editedSourceOccurredAts, `relation ${edge.id}の根拠編集`);
  }
  const currentEdge = graph.edges.find((candidate) => candidate.id === edge.id);
  const currentEdgeOccurredAts = resolvedSourceOccurredAts(
    currentEdge?.evidence.map((evidence) => evidence.sourceId) ?? [],
    sourceOccurredAtById,
  );
  const assessment = relationAssessments.find((candidate) => candidate.candidateId === edge.id);
  const assessmentOccurredAts = resolvedSourceOccurredAts(
    assessment?.sourceIds ?? [],
    sourceOccurredAtById,
  );
  const occurredAts = [...currentEdgeOccurredAts, ...assessmentOccurredAts];
  return occurredAts.length === 0
    ? edge.firstSeenAt
    : latestUtcIsoDateTime(occurredAts, `relation ${edge.id}の再判定根拠`);
}

function dependencyResolutions(
  state: RuntimeState,
  collection: CollectedItems,
  graph: GraphResult | undefined,
  relationAssessments: readonly RelationCandidateAssessment[],
  analysis: DeterministicItemAnalysis,
): readonly DependencyResolutionProgress[] {
  if (graph?.analysis.newlyUnblockedNodeIds.includes(analysis.item.nodeId) !== true) {
    return Object.freeze([]);
  }
  const edgesByBlockerNodeId = previousBlockerEdges(state, analysis.item.nodeId);
  if (edgesByBlockerNodeId.size === 0) {
    throw new TypeError(`newly unblocked項目 ${analysis.item.nodeId}の前回blockerがありません`);
  }
  const enumeratedItemsByNodeId = new Map<GraphNodeId, EnumeratedGitHubItem>(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const sourceOccurredAtById = createDependencySourceOccurredAtById(collection);
  const blockerResolutionOccurredAts = [...edgesByBlockerNodeId].map(([blockerNodeId, edges]) => {
    const terminalAt = enumeratedTerminalAt(enumeratedItemsByNodeId.get(blockerNodeId));
    if (terminalAt != null) {
      return terminalAt;
    }
    return latestUtcIsoDateTime(
      edges.map((edge) =>
        relationResolutionOccurredAt(
          collection,
          graph,
          relationAssessments,
          sourceOccurredAtById,
          edge,
        ),
      ),
      `blocker ${blockerNodeId}の関係解消`,
    );
  });
  const sourceIds = [...edgesByBlockerNodeId.values()]
    .flat()
    .flatMap((edge) => edge.evidence.map((evidence) => evidence.sourceId));
  return Object.freeze([
    Object.freeze({
      occurredAt: latestUtcIsoDateTime(
        [analysis.item.createdAt, ...blockerResolutionOccurredAts],
        `newly unblocked項目 ${analysis.item.nodeId}`,
      ),
      sourceIds: nonEmptySourceIds(sourceIds, `newly unblocked項目 ${analysis.item.nodeId}`),
    }),
  ]);
}

function primaryWaitingOnForDecision(
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
): PrimaryWaitingOn {
  if (decision.origin === "deterministic") {
    return deterministicDecision.primaryWaitingOn;
  }
  if (decision.waitingOn.length === 0) {
    return Object.freeze({
      index: "not_applicable",
      selectionReason: "Codex判定に待ち相手がないためprimaryはありません",
    });
  }
  return Object.freeze({
    index: 0,
    selectionReason: "Codexが返した待ち相手の優先順でprimaryを選定しました",
  });
}

function transitionBasisForDecision(
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
): Readonly<{
  statusBasis: IssueStateDecision["statusBasis"];
  responsibilityBasis: IssueStateDecision["responsibilityBasis"];
}> {
  if (decision.origin === "deterministic") {
    return Object.freeze({
      statusBasis: analysis.decision.statusBasis,
      responsibilityBasis: analysis.decision.responsibilityBasis,
    });
  }
  const sourceIds = [
    ...decision.evidence.map((evidence) => evidence.sourceId),
    ...decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds),
  ];
  const sourceOccurredAtById = new Map(
    createCodexSourceOccurredAtById(analysis.item, analysis.detail),
  );
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    for (const sourceContext of effectiveCandidateContext.sourceContexts) {
      addCodexSourceOccurredAtForContext(
        sourceOccurredAtById,
        sourceContext.item,
        sourceContext.detail,
      );
    }
  }
  const resolvedOccurredAts = [...new Set(sourceIds)].flatMap((sourceId) => {
    const occurredAt = sourceOccurredAtById.get(sourceId);
    return occurredAt == null ? [] : [occurredAt];
  });
  const basisSourceIds =
    sourceIds.length === 0
      ? Object.freeze([analysis.item.sourceId] satisfies [SourceId])
      : nonEmptySourceIds(sourceIds, `Codex判定 ${analysis.item.nodeId}`);
  const basis = Object.freeze({
    sourceIds: basisSourceIds,
    occurredAt:
      resolvedOccurredAts.length === 0
        ? analysis.item.createdAt
        : latestUtcIsoDateTime(
            [analysis.item.createdAt, ...resolvedOccurredAts],
            `Codex判定 ${analysis.item.nodeId}`,
          ),
    precision: "inferred",
  });
  return Object.freeze({
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function previousStalenessState(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): Parameters<typeof calculateStaleness>[0]["previousState"] {
  const snapshot = previousSnapshot(state);
  const previous = snapshot?.items.find((item) => item.nodeId === nodeId);
  const previousCollectionItem = snapshot?.collection.repositories
    .flatMap((repository) => repository.items)
    .find((item) => item.nodeId === nodeId);
  const previousRulesVersion = previousCollectionItem?.deterministicRulesVersion;
  if (
    previous == null ||
    previousRulesVersion == null ||
    previousRulesVersion.status === "unavailable"
  ) {
    return Object.freeze({
      availability: "not_available",
    });
  }
  return Object.freeze({
    availability: "available",
    value: Object.freeze({
      status: previous.status,
      waitingOn: previous.waitingOn,
      statusSince: previous.statusSince,
      ownerSince: previous.ownerSince,
      stallSince: previous.stallSince,
      lastProgressAt: previous.lastProgressAt,
      lastHumanActivityAt: previous.lastHumanActivityAt,
    }),
  });
}

function trackedItemState(
  item: FreshObservedGitHubItem,
  decision: ReducedCodexDecision,
): TrackedItem["state"] {
  if (decision.status === "terminal_merged") {
    return "merged";
  }
  return item.state;
}

function inputCommentUrl(
  analysis: DeterministicItemAnalysis,
  sourceId: SourceId,
): TrackedItemInputEvent["url"] {
  const sourceKind = parseSourceId(sourceId).kind;
  if (sourceKind === "github_issue_comment") {
    const comment = analysis.detail.comments.find((candidate) => candidate.sourceId === sourceId);
    assertNonNullable(comment, `Issue commentのURLがありません。対象: ${sourceId}`);
    return comment.url;
  }
  if (sourceKind === "github_pull_request_review_comment") {
    if (analysis.detail.type !== "pull_request") {
      throw new TypeError(`IssueにPull Request review commentがあります。対象: ${sourceId}`);
    }
    const comment = analysis.detail.reviewThreads
      .flatMap((thread) => thread.comments)
      .find((candidate) => candidate.sourceId === sourceId);
    assertNonNullable(comment, `Pull Request review commentのURLがありません。対象: ${sourceId}`);
    return comment.url;
  }
  throw new TypeError(`commentイベントのsource ID種別が不正です。対象: ${sourceId}`);
}

function inputReviewUrl(
  analysis: DeterministicItemAnalysis,
  sourceId: SourceId,
): TrackedItemInputEvent["url"] {
  if (parseSourceId(sourceId).kind !== "github_pull_request_review") {
    throw new TypeError(`reviewイベントのsource ID種別が不正です。対象: ${sourceId}`);
  }
  if (analysis.detail.type !== "pull_request") {
    throw new TypeError(`IssueにPull Request reviewがあります。対象: ${sourceId}`);
  }
  const review = analysis.detail.reviews.find((candidate) => candidate.sourceId === sourceId);
  assertNonNullable(review, `Pull Request reviewのURLがありません。対象: ${sourceId}`);
  return review.url;
}

function trackedItemInputEventUrl(
  analysis: DeterministicItemAnalysis,
  event: FreshObservedGitHubItem["events"][number],
): TrackedItemInputEvent["url"] {
  switch (event.kind) {
    case "comment":
      return inputCommentUrl(analysis, event.sourceId);
    case "review":
      return inputReviewUrl(analysis, event.sourceId);
    default:
      return analysis.item.url;
  }
}

function trackedItemInputEvents(
  analysis: DeterministicItemAnalysis,
): readonly TrackedItemInputEvent[] {
  return Object.freeze(
    analysis.item.events.map((event) =>
      Object.freeze({
        sourceId: event.sourceId,
        url: trackedItemInputEventUrl(analysis, event),
      }),
    ),
  );
}

function trackedItemAiAnalysis(
  codexAnalysis: CodexAnalysis,
  nodeId: GitHubNodeId,
): TrackedItemAiAnalysis {
  const run = codexAnalysis.run;
  if (run == null) {
    return Object.freeze({
      status: "disabled",
    });
  }
  const result = run.results.find((candidate) => candidate.candidateId === nodeId);
  if (result != null) {
    return Object.freeze({
      status: "used",
      cacheKey: result.cacheKey,
    });
  }
  const failure = run.failures.find((candidate) => candidate.candidateId === nodeId);
  if (failure != null) {
    return Object.freeze({
      status: "failed",
    });
  }
  const deferred = run.deferred.find((candidate) => candidate.candidateId === nodeId);
  if (deferred != null) {
    return Object.freeze({
      status: "deferred",
    });
  }
  const skipped = run.skipped.find((candidate) => candidate.candidateId === nodeId);
  assertNonNullable(skipped, `Codex分析候補の分類がありません。対象: ${nodeId}`);
  if (skipped.reason === "unchanged") {
    throw new TypeError("未変更項目のCodex cache結果がありません");
  }
  return Object.freeze({
    status: "not_required",
  });
}

function createTrackedItem(
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
  primaryWaitingOn: PrimaryWaitingOn,
  staleness: StalenessResult,
  codexAnalysis: CodexAnalysis,
): PendingTrackedItem {
  const commonFields = {
    nodeId: analysis.item.nodeId,
    type: analysis.item.type,
    repositoryId: analysis.item.repositoryId,
    displayReference: analysis.item.displayReference,
    number: analysis.item.number,
    url: analysis.item.url,
    title: analysis.item.title,
    author: analysis.item.author,
    latestEventActor: createTrackedItemLatestEventActor(analysis.item.events),
    state: trackedItemState(analysis.item, decision),
    notificationClass: analysis.notificationClass,
    primaryWaitingOn,
    nextAction: decision.nextAction,
    createdAt: analysis.item.createdAt,
    githubUpdatedAt: analysis.item.githubUpdatedAt,
    lastHumanActivityAt: staleness.lastHumanActivityAt,
    lastProgressAt: staleness.lastProgressAt,
    statusSince: staleness.statusSince,
    ownerSince: staleness.ownerSince,
    stallSince: staleness.stallSince,
    observedAt: analysis.item.observedAt,
    labels: analysis.item.labels,
    assignees: analysis.item.assignees,
    reviewState:
      analysis.item.type === "issue"
        ? "not_applicable"
        : aggregatePullRequestReviewState(analysis.item),
    checkState:
      analysis.item.type === "issue"
        ? "not_applicable"
        : aggregatePullRequestCheckState(analysis.item.mergeState),
    aiAnalysis: trackedItemAiAnalysis(codexAnalysis, analysis.item.nodeId),
    inputEvents: trackedItemInputEvents(analysis),
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  } satisfies Omit<PendingTrackedItem, "status" | "waitingOn">;
  if (isTerminalStatus(decision.status)) {
    return Object.freeze({
      ...commonFields,
      status: decision.status,
      waitingOn: Object.freeze([] satisfies []),
    });
  }
  return Object.freeze({
    ...commonFields,
    status: decision.status,
    waitingOn: decision.waitingOn,
  });
}

function blockedParentContext(
  state: RuntimeState,
  decision: ReducedCodexDecision,
  graph: GraphResult | undefined,
): BlockedParentContext {
  if (decision.status !== "waiting_for_unblock") {
    return Object.freeze({
      status: "not_applicable",
    });
  }
  const firstWaitingOn = decision.waitingOn[0];
  assertNonNullable(firstWaitingOn, "blocked項目にwaitingOnがありません");
  const previousSeverityByNodeId = new Map<string, Severity>(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item.severity]),
  );
  const previousGraph = previousGraphSnapshot(state);
  const previousImpact =
    previousGraph == null
      ? Object.freeze([])
      : analyzeGraph({
          current: previousGraph,
          previous: {
            availability: "unavailable",
          },
        }).downstreamImpacts;
  const downstreamImpactByNodeId = new Map<string, number>(
    (graph?.analysis.downstreamImpacts ?? previousImpact).map((impact) => [
      impact.nodeId,
      impact.openNodeCount,
    ]),
  );
  const createRanking = (waitingOn: ReducedCodexDecision["waitingOn"][number]): BlockerRanking =>
    Object.freeze({
      candidateId: waitingOn.candidateId,
      severity: previousSeverityByNodeId.get(waitingOn.candidateId) ?? "none",
      downstreamImpact: downstreamImpactByNodeId.get(waitingOn.candidateId) ?? 0,
    });
  const blockers: [BlockerRanking, ...BlockerRanking[]] = [
    createRanking(firstWaitingOn),
    ...decision.waitingOn.slice(1).map(createRanking),
  ];
  return Object.freeze({
    status: "available",
    blockers: Object.freeze(blockers),
  });
}

function trackedItemStaleness(staleness: StalenessResult): TrackedItemStaleness {
  return Object.freeze({
    elapsedHours: staleness.elapsedHours.stall,
    severity: staleness.severity,
    severityReason: createStalenessNotificationSeverityReason(staleness.severityReason),
    waitClass: staleness.waitClass,
    severityContext: staleness.severityContext,
  });
}

function recalculateTrackedItemStaleness(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  item: SnapshotTrackedItem,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
): TrackedItemStaleness {
  const repository = findRepository(inventory, item.repositoryId);
  const recalculated = recalculateStalenessSeverity({
    evaluatedAt,
    stallSince: item.stallSince,
    confidence: item.confidence,
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    repositoryFullName: repositoryFullName(repository),
    currentLabels: item.labels,
    resolveLabelEffects,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    severityContext: item.severityContext,
  });
  return Object.freeze({
    elapsedHours: recalculated.elapsedHours,
    severity: recalculated.severity,
    severityReason: recalculated.severityReason,
    waitClass: recalculated.waitClass,
    severityContext: recalculated.severityContext,
  });
}

function retainedItemNotificationClass(
  collection: CollectedItems,
  item: SnapshotTrackedItem,
): TrackingNotificationClass {
  const currentClass = collection.trackingNotificationClassByNodeId.get(item.nodeId);
  if (currentClass != null) {
    return currentClass;
  }
  const repositoryResult = collection.repositoryResults.find(
    (result) => result.repository.id === item.repositoryId,
  );
  assertNonNullable(
    repositoryResult,
    `保持項目のrepository収集結果がありません。対象: ${item.nodeId}`,
  );
  if (repositoryResult.freshness === "fresh") {
    throw new TypeError(`保持項目の通知分類がありません。対象: ${item.nodeId}`);
  }
  return item.notificationClass;
}

function retainedItemObservedAt(
  collection: CollectedItems,
  item: SnapshotTrackedItem,
): UtcIsoDateTime {
  const repositoryResult = collection.repositoryResults.find(
    (result) => result.repository.id === item.repositoryId,
  );
  assertNonNullable(
    repositoryResult,
    `保持項目のrepository収集結果がありません。対象: ${item.nodeId}`,
  );
  return repositoryResult.freshness === "fresh" ? collection.evaluatedAt : item.observedAt;
}

function reduceAnalysisPass(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  graph: GraphResult | undefined,
): ReducedAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentItems: ReducedItemAnalysis[] = [];
  const items: PendingTrackedItem[] = [];
  const stalenessByNodeId = new Map<GitHubNodeId, TrackedItemStaleness>();
  const relationAssessments: RelationCandidateAssessment[] = [];
  const previousSnapshotItems = previousSnapshot(state)?.items ?? [];
  const previousImportanceAssessmentByNodeId = new Map(
    previousSnapshotItems.map((item) => [item.nodeId, item.importanceAssessment]),
  );
  const previousDeadlineAssessmentByNodeId = new Map(
    previousSnapshotItems.map((item) => [item.nodeId, item.deadlineAssessment]),
  );
  let runStatus: ReducedAnalysis["runStatus"] = "success";
  for (const originalAnalysis of deterministicAnalysis.items) {
    const output = codexOutputForAnalysis(originalAnalysis, codexAnalysis);
    const analysis = reassessDeterministicAnalysis(
      collection.evaluatedAt,
      configuration,
      state,
      inventory,
      deterministicAnalysis,
      originalAnalysis,
      output,
      graph,
    );
    const reduction = reductionForAnalysis(configuration, analysis, codexAnalysis);
    const decision = reduction?.decision ?? reducedDeterministicDecision(analysis.decision);
    const primaryWaitingOn = primaryWaitingOnForDecision(analysis.decision, decision);
    if (reduction?.ai.status === "unavailable") {
      runStatus = "fallback";
    }
    relationAssessments.push(...(reduction?.relationAssessments ?? []));
    const basis = transitionBasisForDecision(analysis, decision);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const staleness = calculateStaleness({
      createdAt: analysis.item.createdAt,
      evaluatedAt: collection.evaluatedAt,
      currentDecision: {
        status: decision.status,
        waitingOn: decision.waitingOn,
        confidence: decision.confidence,
        statusBasis: basis.statusBasis,
        responsibilityBasis: basis.responsibilityBasis,
      },
      decisionBasis: decision.origin === "deterministic" ? "deterministic" : "ai_only",
      previousState: previousStalenessState(state, analysis.item.nodeId),
      events: analysis.item.events,
      responsibleAccountIdentifiers: resolveWaitingOnAccountIdentifiers(decision.waitingOn),
      dependencyResolutions: dependencyResolutions(
        state,
        collection,
        graph,
        reduction?.relationAssessments ?? [],
        analysis,
      ),
      naturalLanguageAssessments: naturalLanguageProgressAssessments(analysis, output),
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      repositoryFullName: repositoryFullName(repository),
      currentLabels: analysis.item.labels,
      resolveLabelEffects,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      blockedParentContext: blockedParentContext(state, decision, graph),
    });
    currentItems.push(
      Object.freeze({
        item: analysis.item,
        detail: analysis.detail,
        decision,
        notificationRecommendation:
          reduction == null
            ? Object.freeze({
                availability: "not_available",
              })
            : Object.freeze({
                availability: "available",
                value: reduction.notification,
              }),
        primaryWaitingOn,
        staleness,
        importanceAssessment: resolveImportanceAssessment(
          reduction?.importanceAssessment,
          previousImportanceAssessmentByNodeId.get(analysis.item.nodeId),
        ),
        deadlineAssessment: resolveDeadlineAssessment(
          reduction?.deadlineAssessment,
          previousDeadlineAssessmentByNodeId.get(analysis.item.nodeId),
        ),
      }),
    );
    stalenessByNodeId.set(analysis.item.nodeId, trackedItemStaleness(staleness));
    items.push(createTrackedItem(analysis, decision, primaryWaitingOn, staleness, codexAnalysis));
  }
  const currentNodeIds = new Set(items.map((item) => item.nodeId));
  const currentRepositoryIds = new Set<string>(
    inventory.allowlist.repositories.map((repository) => repository.id),
  );
  for (const previousItem of previousSnapshot(state)?.items ?? []) {
    if (
      !currentNodeIds.has(previousItem.nodeId) &&
      collection.trackedNodeIds.has(previousItem.nodeId) &&
      currentRepositoryIds.has(previousItem.repositoryId)
    ) {
      items.push(
        Object.freeze({
          ...previousItem,
          notificationClass: retainedItemNotificationClass(collection, previousItem),
          observedAt: retainedItemObservedAt(collection, previousItem),
        }),
      );
      stalenessByNodeId.set(
        previousItem.nodeId,
        recalculateTrackedItemStaleness(
          collection.evaluatedAt,
          configuration,
          inventory,
          previousItem,
          resolveLabelEffects,
        ),
      );
    }
  }
  if (stalenessByNodeId.size !== items.length) {
    throw new TypeError("全追跡項目のseverityを再計算できませんでした");
  }
  return Object.freeze({
    items: Object.freeze(items),
    currentItems: Object.freeze(currentItems),
    stalenessByNodeId,
    relationAssessments: Object.freeze(relationAssessments),
    runStatus,
  });
}

function reduceAllAnalyses(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
): ReducedAnalysis {
  const initialReduction = reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    undefined,
  );
  const provisionalGraph = reconcileCurrentGraph(
    configuration,
    state,
    collection,
    initialReduction,
  );
  return reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    provisionalGraph,
  );
}

function graphAnalysisNode(item: PendingTrackedItem): GraphAnalysisNode {
  return Object.freeze({
    kind: item.type,
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    state: item.state,
    directNotification: "eligible",
  });
}

function externalGraphAnalysisNode(reference: ExternalGhostNode): GraphAnalysisNode {
  return Object.freeze({
    kind: reference.kind,
    nodeId: reference.nodeId,
    repositoryFullName: reference.repositoryFullName,
    state: reference.state,
    directNotification: reference.directNotification,
  });
}

function persistedRelationCandidateId(value: string): RelationCandidateId {
  if (!value.startsWith("rel:") || value.length === "rel:".length) {
    throw new TypeError(`永続化済みrelation IDの形式が不正です。対象: ${value}`);
  }
  return `rel:${value.slice("rel:".length)}`;
}

function restoredRelationContradictions(relation: Relation): ReconciledGraphEdge["contradictions"] {
  return Object.freeze(
    relation.contradictions.map((contradiction) =>
      Object.freeze({
        verdict: contradiction.verdict,
        confidence: contradiction.confidence,
        evidence: Object.freeze([]),
      }),
    ),
  );
}

function previousGraphEdge(relation: Relation): ReconciledGraphEdge {
  const fields = {
    id: persistedRelationCandidateId(relation.id),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: restoredRelationContradictions(relation),
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: relation.removedAt,
  });
}

function previousGraphSnapshot(state: RuntimeState): GraphAnalysisSnapshot | undefined {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return undefined;
  }
  return Object.freeze({
    nodes: Object.freeze([
      ...snapshot.items.map(graphAnalysisNode),
      ...snapshot.externalReferences.map(externalGraphAnalysisNode),
    ]),
    edges: Object.freeze(snapshot.relations.map(previousGraphEdge)),
  });
}

function preserveStaleGraphEdges(
  collection: CollectedItems,
  previousEdges: readonly ReconciledGraphEdge[],
  reconciledEdges: readonly ReconciledGraphEdge[],
): readonly ReconciledGraphEdge[] {
  const staleNodeIds = new Set<string>(collection.staleItems.map((item) => item.nodeId));
  const preservedEdges = new Map(
    previousEdges
      .filter((edge) => staleNodeIds.has(edge.fromNodeId) || staleNodeIds.has(edge.toNodeId))
      .map((edge) => [edge.id, edge]),
  );
  const result = reconciledEdges.map((edge) => preservedEdges.get(edge.id) ?? edge);
  const resultIds = new Set(result.map((edge) => edge.id));
  for (const edgeId of preservedEdges.keys()) {
    if (!resultIds.has(edgeId)) {
      throw new TypeError(`stale repositoryの前回edgeがありません。対象: ${edgeId}`);
    }
  }
  return Object.freeze(result);
}

function retainGraphEdgesForAvailableNodes(
  edges: readonly ReconciledGraphEdge[],
  availableNodeIds: ReadonlySet<string>,
): readonly ReconciledGraphEdge[] {
  const retainedEdges: ReconciledGraphEdge[] = [];
  for (const edge of edges) {
    const endpointsAvailable =
      availableNodeIds.has(edge.fromNodeId) && availableNodeIds.has(edge.toNodeId);
    if (endpointsAvailable) {
      retainedEdges.push(edge);
    }
  }
  return Object.freeze(retainedEdges);
}

function setEarliestRelationSourceOccurredAt(
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
  occurredAt: UtcIsoDateTime,
): void {
  const existingOccurredAt = sourceOccurredAtById.get(sourceId);
  if (existingOccurredAt == null || occurredAt < existingOccurredAt) {
    sourceOccurredAtById.set(sourceId, occurredAt);
  }
}

function createEarliestRelationSourceOccurredAtById(
  items: readonly FreshObservedGitHubItem[],
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const item of items) {
    setEarliestRelationSourceOccurredAt(sourceOccurredAtById, item.bodySourceId, item.createdAt);
    for (const event of item.events) {
      setEarliestRelationSourceOccurredAt(sourceOccurredAtById, event.sourceId, event.occurredAt);
    }
  }
  return sourceOccurredAtById;
}

function reconcileCurrentGraph(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
): GraphResult {
  const previous = previousGraphSnapshot(state);
  const nodeIds = new Set(reduction.items.map((item) => item.nodeId));
  const candidates = collection.relationCandidates.filter((candidate) => {
    const nodes = relationNodes(candidate.relation);
    return (
      nodes.some((node) => node.scope === "organization" && nodeIds.has(node.nodeId)) &&
      nodes.every((node) => node.scope === "external_public" || nodeIds.has(node.nodeId))
    );
  });
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const reconciled: ReconcileGraphResult = reconcileGraph({
    previousGraph: {
      edges: previous?.edges ?? [],
      historyEvents: [],
    },
    candidates,
    assessments: reduction.relationAssessments.filter((assessment) =>
      candidateIds.has(assessment.candidateId),
    ),
    sourceOccurredAtById: createEarliestRelationSourceOccurredAtById(collection.observedItems),
    minimumInferredConfidence: configuration.config.ai.confidence.medium,
    reconciledAt: collection.evaluatedAt,
  });
  const reconciledEdges = preserveStaleGraphEdges(
    collection,
    previous?.edges ?? [],
    reconciled.edges,
  );
  const externalReferencesByNodeId = new Map(
    [
      ...(previousSnapshot(state)?.externalReferences ?? []),
      ...collection.externalReferences,
      ...candidates.flatMap((candidate) =>
        relationNodes(candidate.relation).flatMap((node) =>
          node.scope === "external_public"
            ? [
                Object.freeze({
                  kind: "external_reference",
                  nodeId: node.nodeId,
                  repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                  number: node.number,
                  url: node.url,
                  title: `${node.repositoryOwner}/${node.repositoryName}#${node.number.toString()}`,
                  state: node.state,
                  recursiveTracking: "not_allowed",
                  directNotification: "not_eligible",
                } satisfies ExternalGhostNode),
              ]
            : [],
        ),
      ),
    ].map((reference) => [reference.nodeId, reference]),
  );
  const availableNodeIds = new Set<string>([
    ...reduction.items.map((item) => item.nodeId),
    ...externalReferencesByNodeId.keys(),
  ]);
  const edges = retainGraphEdgesForAvailableNodes(reconciledEdges, availableNodeIds);
  const referencedNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const externalReferences = Object.freeze(
    [...externalReferencesByNodeId.values()]
      .filter((reference) => referencedNodeIds.has(reference.nodeId))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
  const graphNodes = [
    ...reduction.items.map(graphAnalysisNode),
    ...externalReferences.map(externalGraphAnalysisNode),
  ];
  const analysis = analyzeGraph({
    current: {
      nodes: graphNodes,
      edges,
    },
    previous:
      previous == null
        ? {
            availability: "unavailable",
          }
        : {
            availability: "available",
            snapshot: previous,
          },
  });
  return Object.freeze({
    edges,
    externalReferences,
    analysis,
    previousAnalysis:
      previous == null
        ? Object.freeze({
            availability: "unavailable",
          })
        : Object.freeze({
            availability: "available",
            value: analyzeGraph({
              current: previous,
              previous: {
                availability: "unavailable",
              },
            }),
          }),
  });
}

function toStateRelation(edge: ReconciledGraphEdge): Relation {
  const fields = {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    contradictions: Object.freeze(
      edge.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
        }),
      ),
    ),
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
  };
  if (edge.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: edge.removedAt,
  });
}

function snapshotRepositories(collection: CollectedItems): readonly SnapshotRepository[] {
  return Object.freeze(
    collection.repositoryResults.map((result) => {
      if (result.freshness === "fresh") {
        return Object.freeze({
          ...result.repository,
          observedAt: result.observedAt,
          freshness: "fresh",
        });
      }
      return Object.freeze({
        ...result.repository,
        observedAt: result.lastSuccessfulAt,
        freshness: "stale",
        failedAt: result.failedAt,
      });
    }),
  );
}

function notificationLedgerEntries(
  state: RuntimeState,
  items: readonly PendingTrackedItem[],
): readonly NotificationLedgerEntry[] {
  const itemsByNodeId = new Map<string, PendingTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const entries: NotificationLedgerEntry[] = [];
  for (const entry of state.notificationLedger.entries) {
    const item = itemsByNodeId.get(entry.itemNodeId);
    if (item == null) {
      continue;
    }
    const fields = {
      notificationKey: entry.notificationKey,
      itemNodeId: item.nodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: createUtcIsoDateTime(entry.reservedAt),
    };
    if (entry.status === "reserved") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "reserved",
          expiresAt: createUtcIsoDateTime(entry.expiresAt),
        }),
      );
    } else if (entry.status === "sent") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "sent",
          sentAt: createUtcIsoDateTime(entry.sentAt),
          discordMessageId: entry.discordMessageId,
        }),
      );
    } else {
      entries.push(
        Object.freeze({
          ...fields,
          status: "dismissed",
          dismissedAt: createUtcIsoDateTime(entry.dismissedAt),
        }),
      );
    }
  }
  return Object.freeze(entries);
}

function notificationLatestChange(
  current: ReducedItemAnalysis,
  previous: TrackedItem | undefined,
): DiscordNotificationItem["latestChange"] {
  if (previous == null || current.item.githubUpdatedAt === previous.githubUpdatedAt) {
    return "none";
  }
  return current.item.events.some(
    (event) => event.actor.type === "human" && event.occurredAt > previous.observedAt,
  )
    ? "human"
    : "bot_only";
}

type NotificationAnalysisState =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: ReducedItemAnalysis;
    }>;

function notificationDecisionBasis(
  item: PendingTrackedItem,
  staleness: TrackedItemStaleness,
  analysisState: NotificationAnalysisState,
): DiscordNotificationItem["decisionBasis"] {
  if (analysisState.availability === "available") {
    return analysisState.value.decision.origin === "deterministic"
      ? Object.freeze({
          source: "deterministic",
        })
      : Object.freeze({
          source: "ai_only",
          confidence: analysisState.value.decision.confidence,
        });
  }
  return staleness.severityContext.decisionBasis === "deterministic"
    ? Object.freeze({
        source: "deterministic",
      })
    : Object.freeze({
        source: "ai_only",
        confidence: item.confidence,
      });
}

function notificationDraftState(
  item: PendingTrackedItem,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
): DiscordNotificationItem["draftState"] {
  const observed = enumeratedItemsByNodeId.get(item.nodeId);
  assertNonNullable(observed, `通知対象 ${item.nodeId}の列挙値がありません`);
  if (observed.type !== item.type) {
    throw new TypeError(`通知対象 ${item.nodeId}の項目種別が前回値と一致しません`);
  }
  return observed.type === "issue"
    ? "not_applicable"
    : observed.draft
      ? "draft"
      : "ready_for_review";
}

function notificationItem(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  graph: GraphResult,
  item: PendingTrackedItem,
  staleness: TrackedItemStaleness,
  analysisState: NotificationAnalysisState,
): DiscordNotificationItem {
  const repository = findRepository(inventory, item.repositoryId);
  const previous = previousSnapshot(state)?.items.find(
    (candidate) => candidate.nodeId === item.nodeId,
  );
  const downstreamImpact = graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === item.nodeId,
  );
  assertNonNullable(downstreamImpact, `通知対象 ${item.nodeId}のdownstream impactがありません`);
  const labelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config))(
    repositoryFullName(repository),
    item.labels,
  );
  const cycleIds = graph.analysis.dependencyCycles
    .filter((cycle) => cycle.nodeIds.includes(item.nodeId))
    .map((cycle) => cycle.id);
  const previousDependencyCycles: DiscordNotificationItem["graph"]["previousDependencyCycles"] =
    graph.previousAnalysis.availability === "unavailable"
      ? Object.freeze({
          availability: "not_available",
        })
      : Object.freeze({
          availability: "available",
          cycleIds: Object.freeze(
            graph.previousAnalysis.value.dependencyCycles
              .filter((cycle) => cycle.nodeIds.includes(item.nodeId))
              .map((cycle) => cycle.id),
          ),
        });
  return Object.freeze({
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    draftState: notificationDraftState(item, enumeratedItemsByNodeId),
    repositoryFreshness: "fresh",
    notificationClass: item.notificationClass,
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
    latestChange:
      analysisState.availability === "available"
        ? notificationLatestChange(analysisState.value, previous)
        : "none",
    decisionBasis: notificationDecisionBasis(item, staleness, analysisState),
    notificationRecommendation:
      analysisState.availability === "available"
        ? analysisState.value.notificationRecommendation
        : Object.freeze({
            availability: "not_available",
          }),
    priorityWeight: labelEffects.priorityWeight,
    current: {
      status: item.status,
      waitingOn: item.waitingOn,
      severity: staleness.severity,
      severityReason: staleness.severityReason,
      waitClass: staleness.waitClass,
      statusSince: item.statusSince,
      ownerSince: item.ownerSince,
      stallSince: item.stallSince,
      lastProgressAt: item.lastProgressAt,
    },
    previous:
      previous == null
        ? Object.freeze({
            availability: "not_available",
          })
        : Object.freeze({
            availability: "available",
            value: Object.freeze({
              status: previous.status,
              waitingOn: previous.waitingOn,
              severity: previous.severity,
              stallSince: previous.stallSince,
              observedAt: previous.observedAt,
            }),
          }),
    graph: Object.freeze({
      downstreamImpact,
      newlyUnblocked: graph.analysis.newlyUnblockedNodeIds.includes(item.nodeId),
      currentDependencyCycleIds: cycleIds,
      previousDependencyCycles,
    }),
  });
}

function notificationItems(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): readonly DiscordNotificationItem[] {
  const staleRepositoryIds = new Set<GitHubRepositoryId>(
    collection.repositoryResults
      .filter((result) => result.freshness === "stale")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    reduction.currentItems.map((current) => [current.item.nodeId, current]),
  );
  const enumeratedItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    reduction.items.flatMap((item) => {
      if (staleRepositoryIds.has(item.repositoryId)) {
        return [];
      }
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `通知対象 ${item.nodeId}のseverity再計算結果がありません`);
      const current = currentItemsByNodeId.get(item.nodeId);
      return [
        notificationItem(
          configuration,
          state,
          inventory,
          enumeratedItemsByNodeId,
          graph,
          item,
          staleness,
          current == null
            ? Object.freeze({
                availability: "not_available",
              })
            : Object.freeze({
                availability: "available",
                value: current,
              }),
        ),
      ];
    }),
  );
}

function mergeNotificationLedger(
  state: RuntimeState,
  entriesToMerge: readonly NotificationLedgerEntry[],
): StateNotificationLedger {
  const entries = new Map(
    state.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  for (const entry of entriesToMerge) {
    entries.set(entry.notificationKey, entry);
  }
  return createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_4,
    entries: [...entries.values()],
    operationsAlerts: state.notificationLedger.operationsAlerts,
  });
}

function snapshotAiState(config: Config, codexAnalysis: CodexAnalysis): SnapshotAiState {
  if (!config.ai.enabled) {
    if (codexAnalysis.run != null) {
      throw new TypeError("AIが無効ですがCodex分析結果があります");
    }
    return Object.freeze({
      enabled: false,
      available: false,
      degraded: false,
    });
  }
  const run = codexAnalysis.run;
  assertNonNullable(run, "AIが有効ですがCodex分析結果がありません");
  const degraded = run.failures.length > 0 || run.deferred.length > 0;
  if (run.results.length > 0 || !degraded) {
    return Object.freeze({
      enabled: true,
      available: true,
      degraded,
    });
  }
  return Object.freeze({
    enabled: true,
    available: false,
    degraded: true,
  });
}

function stateHistoryInputEvents(reduction: ReducedAnalysis): readonly StateHistoryInputEvent[] {
  return createStateHistoryInputEvents(
    reduction.currentItems.flatMap((analysis) =>
      analysis.item.events.map(
        (event) =>
          ({
            sourceId: event.sourceId,
            itemNodeId: event.itemNodeId,
            kind: event.kind,
            actor: event.actor,
            occurredAt: event.occurredAt,
          }) satisfies StateHistoryInputEvent,
      ),
    ),
  );
}

function createTrackedItemWithImportance(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  graph: GraphResult,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
  item: PendingTrackedItem,
  naturalLanguageAssessment: NaturalLanguageImportanceAssessmentState,
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState,
): TrackedItemWithImportanceAssessment {
  const repository = findRepository(inventory, item.repositoryId);
  const downstreamImpact = graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === item.nodeId,
  );
  assertNonNullable(
    downstreamImpact,
    `重要度計算対象 ${item.nodeId}のdownstream impactがありません`,
  );
  const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
  const deterministicImportance = calculateImportance({
    priorityWeight: labelEffects.priorityWeight,
    downstreamImpact,
    weights: configuration.config.importance.weights,
    levels: configuration.config.importance.levels,
  });
  return Object.freeze({
    ...item,
    importanceAssessment: naturalLanguageAssessment,
    deadlineAssessment,
    importance: combineImportance({
      deterministic: deterministicImportance,
      naturalLanguageAssessment,
      weights: configuration.config.importance.weights,
      levels: configuration.config.importance.levels,
    }),
  });
}

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): ValidatedRun {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentAnalysisByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const previousSnapshotItems = previousSnapshot(state)?.items ?? [];
  const previousImportanceAssessmentByNodeId = new Map(
    previousSnapshotItems.map((item) => [item.nodeId, item.importanceAssessment]),
  );
  const previousDeadlineAssessmentByNodeId = new Map(
    previousSnapshotItems.map((item) => [item.nodeId, item.deadlineAssessment]),
  );
  const items = reduction.items.map((item) => {
    const currentAnalysis = currentAnalysisByNodeId.get(item.nodeId);
    return createTrackedItemWithImportance(
      configuration,
      inventory,
      graph,
      resolveLabelEffects,
      item,
      resolveImportanceAssessment(
        currentAnalysis?.importanceAssessment,
        previousImportanceAssessmentByNodeId.get(item.nodeId),
      ),
      resolveDeadlineAssessment(
        currentAnalysis?.deadlineAssessment,
        previousDeadlineAssessmentByNodeId.get(item.nodeId),
      ),
    );
  });
  const previousCollectionItems = previousCollectionItemsByNodeId(state);
  const currentAnalysisRulesFingerprints = createCurrentAnalysisRulesFingerprints(
    configuration.config,
  );
  const aiFingerprintByNodeId = new Map(
    (codexAnalysis.run?.results ?? []).map((result) => [
      result.candidateId,
      Object.freeze({
        status: "available",
        fingerprint: result.fingerprint,
      }),
    ]),
  );
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const analysisRulesFingerprintByNodeId = new Map(
    [...collection.analysisNodeIds].map((nodeId) => {
      const item = observedItemsByNodeId.get(nodeId);
      assertNonNullable(item, `再判定対象の観測項目がありません。対象: ${nodeId}`);
      return [
        nodeId,
        Object.freeze({
          status: "available",
          fingerprint: currentAnalysisRulesFingerprints[item.type],
        }),
      ] as const;
    }),
  );
  const deterministicRulesVersionByNodeId = new Map(
    [...collection.analysisNodeIds].map((nodeId) => {
      const item = observedItemsByNodeId.get(nodeId);
      assertNonNullable(item, `再判定対象の観測項目がありません。対象: ${nodeId}`);
      return [
        nodeId,
        Object.freeze({
          status: "available",
          version: CURRENT_DETERMINISTIC_RULES_VERSIONS[item.type],
        }),
      ] as const;
    }),
  );
  const persistedAiFingerprintNodeIds = new Set<string>();
  const persistedAnalysisRulesFingerprintNodeIds = new Set<string>();
  const persistedDeterministicRulesVersionNodeIds = new Set<string>();
  const snapshot = createStateSnapshot({
    schemaVersion: "10",
    generatedAt: collection.evaluatedAt,
    trackingStartAt: pendingSnapshotTrackingStartAt(configuration, state, collection.evaluatedAt),
    ai: snapshotAiState(configuration.config, codexAnalysis),
    collection: {
      repositories: collection.collectionRepositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => {
          const currentAiFingerprint = aiFingerprintByNodeId.get(item.nodeId);
          if (currentAiFingerprint != null) {
            persistedAiFingerprintNodeIds.add(item.nodeId);
          }
          const previousItem = previousCollectionItems.get(item.nodeId);
          const currentAnalysisRulesFingerprint = analysisRulesFingerprintByNodeId.get(item.nodeId);
          if (currentAnalysisRulesFingerprint != null) {
            persistedAnalysisRulesFingerprintNodeIds.add(item.nodeId);
          }
          const currentDeterministicRulesVersion = deterministicRulesVersionByNodeId.get(
            item.nodeId,
          );
          if (currentDeterministicRulesVersion != null) {
            persistedDeterministicRulesVersionNodeIds.add(item.nodeId);
          }
          return {
            ...item,
            aiAnalysisFingerprint:
              currentAiFingerprint ??
              (previousItem == null
                ? item.aiAnalysisFingerprint
                : previousItem.aiAnalysisFingerprint),
            analysisRulesFingerprint:
              currentAnalysisRulesFingerprint ??
              (previousItem == null
                ? item.analysisRulesFingerprint
                : previousItem.analysisRulesFingerprint),
            deterministicRulesVersion:
              currentDeterministicRulesVersion ??
              (previousItem == null
                ? item.deterministicRulesVersion
                : previousItem.deterministicRulesVersion),
          };
        }),
      })),
    },
    repositories: snapshotRepositories(collection),
    items: items.map((item) => {
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `追跡項目 ${item.nodeId}のseverity再計算結果がありません`);
      return {
        ...item,
        attention: calculateAttention({
          importanceScore: item.importance.score,
          deadlineLevel: deadlineLevelForAssessment(
            item.deadlineAssessment,
            collection.evaluatedAt,
            configuration.config.staleness.timezone,
          ),
          deadlinePoints: configuration.config.attention.deadlinePoints,
          elapsedHours: staleness.elapsedHours,
          waitClass: staleness.waitClass,
          thresholdsHours: configuration.config.staleness.thresholdsHours,
          recencyFloor: configuration.config.attention.recencyFloor,
          levels: configuration.config.attention.levels,
        }),
        severity: staleness.severity,
        severityContext: staleness.severityContext,
      };
    }),
    externalReferences: graph.externalReferences,
    relations: graph.edges.map(toStateRelation),
    run: {
      id: invocation.runId,
      status: reduction.runStatus,
      complete: true,
    },
  });
  for (const nodeId of aiFingerprintByNodeId.keys()) {
    if (!persistedAiFingerprintNodeIds.has(nodeId)) {
      throw new TypeError(`AI分析fingerprintの保存対象項目がありません。対象: ${nodeId}`);
    }
  }
  for (const nodeId of analysisRulesFingerprintByNodeId.keys()) {
    if (!persistedAnalysisRulesFingerprintNodeIds.has(nodeId)) {
      throw new TypeError(`判定規則fingerprintの保存対象項目がありません。対象: ${nodeId}`);
    }
  }
  for (const nodeId of deterministicRulesVersionByNodeId.keys()) {
    if (!persistedDeterministicRulesVersionNodeIds.has(nodeId)) {
      throw new TypeError(`決定規則versionの保存対象項目がありません。対象: ${nodeId}`);
    }
  }
  const notificationInput = {
    evaluatedAt: collection.evaluatedAt,
    items: notificationItems(configuration, state, inventory, collection, reduction, graph),
    ledger: notificationLedgerEntries(state, reduction.items),
    settings: {
      maxItemsPerDigest: configuration.config.notifications.discord.maxItemsPerDigest,
      recentProgressGraceHours: configuration.config.staleness.recentProgressGraceHours,
      minimumAiConfidence: configuration.config.ai.confidence.medium,
    },
  };
  const notificationAction =
    invocation.command.kind === "dry-run" ? "send" : invocation.command.notificationAction;
  const emptyCandidates: readonly [] = Object.freeze([]);
  const emptyLedgerReservations: readonly [] = Object.freeze([]);
  const notificationSelection: DiscordNotificationSelection =
    notificationAction === "dismiss-current"
      ? Object.freeze({
          action: "skip_digest",
          reason: "no_candidates",
          candidates: emptyCandidates,
          ledgerReservations: emptyLedgerReservations,
        })
      : selectDiscordNotifications(notificationInput);
  const notificationLedgerEntriesToMerge =
    notificationAction === "dismiss-current"
      ? createDismissedNotificationLedgerEntries(notificationInput)
      : notificationSelection.ledgerReservations;
  return Object.freeze({
    snapshot,
    historyInputEvents: stateHistoryInputEvents(reduction),
    notificationLedger: mergeNotificationLedger(state, notificationLedgerEntriesToMerge),
    notificationSelection,
  });
}

function persistedMetrics(
  metrics: RunMetrics,
  validated: ValidatedRun,
): WorkflowRunMetadata["metrics"] {
  return Object.freeze({
    repositoryCount: validated.snapshot.repositories.length,
    itemCount: validated.snapshot.items.length,
    changedItemCount: metrics.changedItemCount,
    activeEdgeCount: validated.snapshot.relations.filter((relation) => relation.active).length,
    aiCallCount: metrics.aiCallCount,
    aiCacheHitCount: metrics.aiCacheHitCount,
    aiRetainedResultCount: metrics.aiRetainedResultCount,
    estimatedInputTokens: metrics.estimatedInputTokens,
    githubApiRemaining: metrics.githubApiRemaining,
    staleRepositoryCount: validated.snapshot.repositories.filter(
      (repository) => repository.freshness === "stale",
    ).length,
    scheduleDelayMilliseconds: metrics.scheduleDelayMilliseconds,
  });
}

function createRunMetadata(
  invocation: DailyRunInvocation,
  validated: ValidatedRun,
  metrics: RunMetrics,
  diagnostics: readonly string[],
): WorkflowRunMetadata {
  return createWorkflowRunMetadata({
    scheduledFor: invocation.scheduledFor,
    startedAt: invocation.startedAt,
    metrics: persistedMetrics(metrics, validated),
    diagnostics,
  });
}

function createPersistedRunReport(
  snapshot: StateSnapshot,
  metadata: WorkflowRunMetadata,
  notificationCount: number,
  finishedAt: UtcIsoDateTime,
): StateRunReport {
  return createStateRunReport({
    schemaVersion: "1",
    runId: snapshot.run.id,
    date: metadata.startedAt.slice(0, 10),
    status: snapshot.run.status,
    complete: true,
    scheduledFor: metadata.scheduledFor,
    startedAt: metadata.startedAt,
    finishedAt,
    metrics: {
      ...metadata.metrics,
      notificationCount,
      durationMilliseconds: Date.parse(finishedAt) - Date.parse(metadata.startedAt),
    },
    diagnostics: metadata.diagnostics,
  });
}

function discordDeliverySettings(config: Config): DiscordDeliverySettings {
  return Object.freeze({
    enabled: config.notifications.discord.enabled,
    webhookSecretName: config.notifications.discord.webhookSecretName,
    operationsWebhookSecretName: config.notifications.discord.operationsWebhookSecretName,
    mentions: config.notifications.discord.mentions,
    retry: config.operations.retry,
  });
}

function createCollectAnalyzeArtifact(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  validated: ValidatedRun,
  metrics: RunMetrics,
  diagnostics: readonly string[],
): WorkflowArtifact {
  if (invocation.command.kind !== "collect-analyze") {
    throw new TypeError("collect-analyze以外のrunからworkflow artifactを生成できません");
  }
  const artifact = createWorkflowArtifact({
    schemaVersion: "6",
    kind: "validated_public_run",
    notificationAction: invocation.command.notificationAction,
    repositoryAllowlist: inventory.allowlist.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
    })),
    snapshot: validated.snapshot,
    historyInputEvents: validated.historyInputEvents,
    notificationLedger: validated.notificationLedger,
    notificationSelection: validated.notificationSelection,
    runMetadata: createRunMetadata(invocation, validated, metrics, diagnostics),
    aiCacheEntries: state.session.pendingAiCacheEntries(),
    pagesUrl: pagesUrl(configuration.config),
    discordSettings: discordDeliverySettings(configuration.config),
  });
  assertWorkflowArtifactPublicSafety(
    artifact,
    inventory.inventory,
    configuration.credentials.knownSecrets,
  );
  return artifact;
}

async function persistValidatedRun(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  validated: ValidatedRun,
): Promise<PersistedRun> {
  const result = await state.session.persist({
    snapshot: validated.snapshot,
    historyInputEvents: validated.historyInputEvents,
    notificationLedger: validated.notificationLedger,
    repositoryInventory: inventory.inventory,
    knownSecrets: configuration.credentials.knownSecrets,
  });
  const historyRecords = await state.session.loadHistoryRecords();
  return Object.freeze({
    result,
    historyRecords,
    notificationLedger: validated.notificationLedger,
  });
}

function pagesUrl(config: Config): string {
  return new URL(config.web.basePath, PAGES_BASE_URL).href;
}

async function buildPublicPages(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  inventory: readonly Repository[],
  repositoryAllowlist: PagesPublicSafetyInput["repositoryAllowlist"],
  validated: ValidatedRun,
  historyRecords: readonly StateHistoryRecord[],
  outputDirectory: string,
  knownSecrets: readonly string[],
): Promise<PagesResult> {
  const data = generatePublicData({
    snapshot: validated.snapshot,
    historyRecords,
    repositoryAllowlist,
    repositoryInventory: inventory,
    knownSecrets,
    options: {
      confidenceThresholds: config.ai.confidence,
      labelRules: normalizeLabelRules(config),
      maxInitialGraphNodes: config.web.graph.maxInitialNodes,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: config.staleness.timezone,
    },
  });
  const output = await adapters.writePublicData(outputDirectory, data);
  return Object.freeze({
    data,
    output,
    pagesUrl: pagesUrl(config),
  });
}

function environmentSecretProvider(
  environment: Readonly<NodeJS.ProcessEnv>,
): DiscordSecretProvider {
  return Object.freeze({
    read: (name) => requireEnvironmentValue(environment, name),
  });
}

function operationsAlertLedgerEntry(
  entry: StateNotificationLedger["operationsAlerts"][number],
): OperationsAlertLedgerEntry {
  return Object.freeze({
    ...entry,
    occurredAt: createUtcIsoDateTime(entry.occurredAt),
    sentAt: createUtcIsoDateTime(entry.sentAt),
  });
}

function createNotificationWaitingOn(
  item: StateSnapshot["items"][number],
  snapshot: StateSnapshot,
): StateHistoryNotificationEvent["waitingOn"] {
  if (item.waitingOn.length === 0) {
    throw new TypeError("通知送信eventの対象itemにwaitingOnがありません");
  }
  type NotificationWaitingOnReference = Extract<
    StateHistoryNotificationEvent["waitingOn"],
    Readonly<{ status: "recorded" }>
  >["values"][number];
  const values = item.waitingOn.map((waitingOn): NotificationWaitingOnReference => {
    switch (waitingOn.kind) {
      case "user":
        return {
          kind: "user",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "team":
        return {
          kind: "team",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "role":
        return {
          kind: "role",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "item": {
        return {
          kind: "item",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
          displayReference: resolveStateHistoryNotificationItemDisplayReference(
            snapshot,
            waitingOn.candidateId,
          ),
        };
      }
      case "automation":
        return {
          kind: "automation",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "unknown":
        return {
          kind: "unknown",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      default:
        throw new UnreachableError(waitingOn.kind);
    }
  });
  return {
    status: "recorded",
    values,
  };
}

function createNotificationHistoryEvents(
  snapshot: StateSnapshot,
  selection: DiscordNotificationSelection,
  delivery: DiscordDigestDelivery,
): readonly StateHistoryNotificationEvent[] {
  if (delivery.status !== "sent") {
    return Object.freeze([]);
  }
  const candidateByNodeId = new Map(
    selection.candidates.map((candidate) => [candidate.itemNodeId, candidate]),
  );
  if (candidateByNodeId.size !== selection.candidates.length) {
    throw new TypeError("通知候補のitem node IDが重複しています");
  }
  const itemByNodeId = new Map<GitHubNodeId, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  if (itemByNodeId.size !== snapshot.items.length) {
    throw new TypeError("snapshotのitem node IDが重複しています");
  }
  type SentNotificationLedgerEntry = Extract<NotificationLedgerEntry, { status: "sent" }>;
  const entriesByMessageAndItem = new Map<
    string,
    Map<GitHubNodeId, SentNotificationLedgerEntry[]>
  >();
  const sentNotificationKeys = new Set<string>();
  for (const entry of delivery.ledgerEntries) {
    if (entry.status !== "sent") {
      throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
    }
    if (sentNotificationKeys.has(entry.notificationKey)) {
      throw new TypeError("Discord送信結果のnotification keyが重複しています");
    }
    sentNotificationKeys.add(entry.notificationKey);
    let entriesByItem = entriesByMessageAndItem.get(entry.discordMessageId);
    if (entriesByItem == null) {
      entriesByItem = new Map();
      entriesByMessageAndItem.set(entry.discordMessageId, entriesByItem);
    }
    const entries = entriesByItem.get(entry.itemNodeId);
    if (entries == null) {
      entriesByItem.set(entry.itemNodeId, [entry]);
    } else {
      entries.push(entry);
    }
  }
  if (delivery.ledgerEntries.length === 0) {
    throw new TypeError("Discord送信成功結果にledger entryがありません");
  }
  const candidateMessageIds = new Map<GitHubNodeId, string>();
  const deliveryMessageIds = new Set(delivery.discordMessageIds);
  if (deliveryMessageIds.size !== delivery.discordMessageIds.length) {
    throw new TypeError("Discord送信結果のmessage IDが重複しています");
  }
  const events: StateHistoryNotificationEvent[] = [];
  for (const [discordMessageId, entriesByItem] of entriesByMessageAndItem) {
    if (!deliveryMessageIds.has(discordMessageId)) {
      throw new TypeError("Discord送信結果のledgerにないmessage IDがあります");
    }
    for (const [itemNodeId, entries] of entriesByItem) {
      const candidate = candidateByNodeId.get(itemNodeId);
      if (candidate == null) {
        throw new TypeError("Discord送信結果のitemが通知候補にありません");
      }
      const previousMessageId = candidateMessageIds.get(itemNodeId);
      if (previousMessageId != null) {
        throw new TypeError("同じitemが複数のDiscord messageへ送信されています");
      }
      candidateMessageIds.set(itemNodeId, discordMessageId);
      const candidateReasonsByKey = new Map(
        candidate.reasons.map((reason) => [reason.notificationKey, reason]),
      );
      if (candidateReasonsByKey.size !== candidate.reasons.length) {
        throw new TypeError("通知候補のnotification keyが重複しています");
      }
      const reasonsByKey = new Map<string, (typeof candidate.reasons)[number]>();
      let sentAt: UtcIsoDateTime | undefined;
      for (const entry of entries) {
        if (entry.itemNodeId !== candidate.itemNodeId || entry.severity !== candidate.severity) {
          throw new TypeError("Discord送信結果と通知候補のitemまたはseverityが一致しません");
        }
        const candidateReason = candidateReasonsByKey.get(entry.notificationKey);
        if (entry.reasonCode === "none" || candidateReason?.reasonCode !== entry.reasonCode) {
          throw new TypeError("Discord送信結果の通知理由が候補と一致しません");
        }
        if (reasonsByKey.has(entry.notificationKey)) {
          throw new TypeError("Discord送信結果の通知理由が重複しています");
        }
        assertNonNullable(candidateReason, "Discord送信結果の通知理由を取得できません");
        reasonsByKey.set(entry.notificationKey, candidateReason);
        if (sentAt == null) {
          sentAt = entry.sentAt;
        } else if (sentAt !== entry.sentAt) {
          throw new TypeError("同じDiscord messageの通知送信時刻が一致しません");
        }
      }
      if (reasonsByKey.size !== candidateReasonsByKey.size) {
        throw new TypeError("Discord送信結果の通知理由数が候補と一致しません");
      }
      const reasons = candidate.reasons.map((reason) => {
        const selectedReason = reasonsByKey.get(reason.notificationKey);
        if (selectedReason == null) {
          throw new TypeError("Discord送信結果の通知理由順序を候補から解決できません");
        }
        return createNotificationReason(selectedReason.reasonCode, selectedReason.threshold);
      });
      const item = itemByNodeId.get(itemNodeId);
      assertNonNullable(item, "通知送信eventの対象itemがsnapshotにありません");
      assertNonNullable(sentAt, "通知送信eventの送信時刻がありません");
      events.push({
        kind: "notification_sent",
        deliveryId: hashCanonicalJson([
          "notification-history-v1",
          snapshot.run.id,
          discordMessageId,
          itemNodeId,
        ]),
        itemNodeId: item.nodeId,
        repositoryId: item.repositoryId,
        type: item.type,
        displayReference: item.displayReference,
        number: item.number,
        title: item.title,
        url: item.url,
        waitingOn: createNotificationWaitingOn(item, snapshot),
        reasons,
        severity: candidate.severity,
        sentAt,
      });
    }
  }
  if (candidateMessageIds.size !== candidateByNodeId.size) {
    throw new TypeError("Discord送信結果のitem数が通知候補と一致しません");
  }
  if (deliveryMessageIds.size !== entriesByMessageAndItem.size) {
    throw new TypeError("Discord送信結果のmessage数がledgerと一致しません");
  }
  return Object.freeze(events);
}

async function deliverDiscord(
  adapters: ProductionRuntimeAdapters,
  settings: DiscordDeliverySettings,
  validated: ValidatedRun,
  deployedPagesUrl: string,
): Promise<
  Readonly<{
    value: DiscordDeliveryResult;
    notificationEvents: readonly StateHistoryNotificationEvent[];
    notificationLedger: StateNotificationLedger;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const sentNotificationEntries: NotificationLedgerEntry[] = [];
  const notificationEntriesByKey = new Map(
    validated.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    validated.notificationLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  const delivery = await adapters.sendDiscord({
    candidates: validated.notificationSelection.candidates,
    ledgerReservations: validated.notificationSelection.ledgerReservations,
    items: validated.snapshot.items,
    generatedAt: validated.snapshot.generatedAt,
    pagesDeployment: {
      status: "succeeded",
      pagesUrl: deployedPagesUrl,
    },
    settings,
    dependencies: {
      secretProvider: environmentSecretProvider(adapters.environment),
      httpClient: adapters.discordHttpClient,
      runtime: {
        now: adapters.now,
        sleep: adapters.sleep,
        random: adapters.random,
      },
      ledger: {
        hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
        recordNotifications: (entries) => {
          sentNotificationEntries.push(...entries);
          for (const entry of entries) {
            notificationEntriesByKey.set(entry.notificationKey, entry);
          }
          return Promise.resolve();
        },
        recordOperationsAlert: (entry) => {
          operationsAlertsByKey.set(entry.alertKey, entry);
          return Promise.resolve();
        },
      },
    },
  });
  let sentAt: UtcIsoDateTime | null = null;
  const notificationEvents = createNotificationHistoryEvents(
    validated.snapshot,
    validated.notificationSelection,
    delivery,
  );
  if (delivery.status === "sent") {
    const entries = delivery.ledgerEntries.filter((entry) => entry.status === "sent");
    const firstEntry = entries[0];
    assertNonNullable(firstEntry, "Discord送信結果に送信済みledger entryがありません");
    sentAt = entries.reduce(
      (latest, entry) => (entry.sentAt > latest ? entry.sentAt : latest),
      firstEntry.sentAt,
    );
  }
  return Object.freeze({
    value: Object.freeze({
      delivery,
      notificationEvents,
    }),
    notificationEvents,
    notificationLedger: createStateNotificationLedger({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_4,
      entries: [...notificationEntriesByKey.values()],
      operationsAlerts: [...operationsAlertsByKey.values()],
    }),
    notificationCount: sentNotificationEntries.length,
    discordSentAt: sentAt,
  });
}

async function persistSuccessfulRunCompletion(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  state: RuntimeState,
  repositoryInventory: readonly Repository[],
  validated: ValidatedRun,
  runMetadata: WorkflowRunMetadata,
  delivery: Readonly<{
    notificationLedger: StateNotificationLedger;
    notificationCount: number;
    notificationEvents: readonly StateHistoryNotificationEvent[];
  }>,
  knownSecrets: readonly string[],
): Promise<void> {
  const completedAt = createUtcIsoDateTime(adapters.now().toISOString());
  const trackingStartAt = completedSnapshotTrackingStartAt(config, validated.snapshot, completedAt);
  await state.session.persistRunCompletion({
    snapshot: createStateSnapshot({
      ...validated.snapshot,
      trackingStartAt,
    }),
    notificationEvents: delivery.notificationEvents,
    notificationLedger: delivery.notificationLedger,
    runReport: createPersistedRunReport(
      validated.snapshot,
      runMetadata,
      delivery.notificationCount,
      completedAt,
    ),
    repositoryInventory,
    knownSecrets,
  });
}

async function deliverOperationsAlert(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  knownSecrets: readonly string[],
  state: RuntimeState,
  incident: DiscordOperationsIncident,
): Promise<
  Readonly<{
    value: DiscordResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const notificationEntriesByKey = new Map(
    state.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    state.notificationLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  const delivery = await adapters.sendDiscord({
    candidates: [],
    ledgerReservations: [],
    items: previousSnapshot(state)?.items ?? [],
    generatedAt: incident.occurredAt,
    pagesDeployment: {
      status: "failed",
      incidentId: incident.incidentId,
      kind: incident.kind,
      failedAt: incident.occurredAt,
      retryAttempts: incident.retryAttempts,
    },
    settings: discordDeliverySettings(config),
    dependencies: {
      secretProvider: environmentSecretProvider(adapters.environment),
      httpClient: adapters.discordHttpClient,
      runtime: {
        now: adapters.now,
        sleep: adapters.sleep,
        random: adapters.random,
      },
      ledger: {
        hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
        recordNotifications: (entries) => {
          for (const entry of entries) {
            notificationEntriesByKey.set(entry.notificationKey, entry);
          }
          return Promise.resolve();
        },
        recordOperationsAlert: (entry) => {
          operationsAlertsByKey.set(entry.alertKey, entry);
          return Promise.resolve();
        },
      },
    },
  });
  if (delivery.status !== "skipped" || delivery.reason !== "pages_deployment_failed") {
    return Object.freeze({
      value: Object.freeze({
        delivery,
        notificationEvents: Object.freeze([]),
        notificationLedger: state.notificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const operationsDelivery = delivery.operationsAlert;
  if (operationsDelivery.status !== "sent") {
    return Object.freeze({
      value: Object.freeze({
        delivery,
        notificationEvents: Object.freeze([]),
        notificationLedger: state.notificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_4,
    entries: [...notificationEntriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
  });
  const persistenceInput = Object.freeze({
    notificationLedger,
    committedAt: operationsDelivery.ledgerEntry.sentAt,
    knownSecrets,
  });
  if (state.snapshot.status === "missing_branch") {
    await state.session.persistInitialOperationsNotificationLedger(persistenceInput);
  } else {
    await state.session.persistNotificationLedger(persistenceInput);
  }
  return Object.freeze({
    value: Object.freeze({
      delivery,
      notificationEvents: Object.freeze([]),
      notificationLedger,
    }),
    notificationCount: 1,
    discordSentAt: operationsDelivery.ledgerEntry.sentAt,
  });
}

function configuredNodeIdentifiers(config: Config): readonly string[] {
  return Object.freeze(config.tracking.include.filter((identifier) => !identifier.includes("://")));
}

function previousRepositoryValues(state: RuntimeState): ReadonlyMap<
  GitHubRepositoryId,
  Readonly<{
    value: SnapshotCollectionRepository;
    observedAt: UtcIsoDateTime;
  }>
> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).map((repository) => [
      repository.repositoryId,
      Object.freeze({
        value: repository,
        observedAt: repository.successfulAt,
      }),
    ]),
  );
}

async function collectFreshRepositoryItemObservations(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
): Promise<FreshRepositoryItemCollection> {
  const allowlist = createPublicRepositoryAllowlist([repository]);
  const currentNodeIds = new Set(enumeratedItems.map((item) => item.nodeId));
  const previousAiAnalysisStatusesByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map(
      (item) => [item.nodeId, item.aiAnalysis.status] as const,
    ),
  );
  const plan = planIncrementalItemCollection({
    items: enumeratedItems,
    previous: previousItemCollection(state, repository),
    previousAiAnalysisStatusesByNodeId,
    currentAnalysisRulesFingerprints: createCurrentAnalysisRulesFingerprints(configuration.config),
    adjacentItemNodeIds: new Set(
      [...adjacentNodeIds].filter((nodeId) => currentNodeIds.has(nodeId)),
    ),
  });
  const detailNodeIds = new Set([
    ...plan.detailItemNodeIds,
    ...requiredTrackingDetailNodeIds(invocation, configuration, state, repository, enumeratedItems),
  ]);
  const detailItems = enumeratedItems.filter((item) => detailNodeIds.has(item.nodeId));
  const detailTargets = Object.freeze(detailItems.map((item) => Object.freeze({ item })));
  const details =
    detailTargets.length === 0
      ? Object.freeze([])
      : (
          await adapters.collectGitHubItemDetails({
            allowlist,
            targets: detailTargets,
            observedAt: invocation.startedAt,
            graphql: authentication.graphql,
          })
        ).items;
  const observedItems = normalizeObservedGitHubItems({
    items: detailItems,
    details,
    isBot: createGitHubBotPredicate(configuration.config.actors.bots),
  });
  return Object.freeze({
    enumeratedItems: Object.freeze([...enumeratedItems]),
    details,
    observedItems,
    changedNodeIds: plan.changedItemNodeIds,
  });
}

async function collectFreshRepositoryItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  explicitNodeItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
): Promise<FreshRepositoryRuntimeCollection> {
  const allowlist = createPublicRepositoryAllowlist([repository]);
  const openItems = await adapters.enumerateOpenGitHubItems({
    allowlist,
    observedAt: invocation.startedAt,
    request: authentication.request,
  });
  const resolvedNodeItems = explicitNodeItems.filter((item) => item.repositoryId === repository.id);
  const identifiers = missingIdentifiers(
    [
      ...configuredUrlIdentifiersForRepository(configuration.config, repository),
      ...previousTrackedItemIdentifiers(invocation, configuration, state, repository),
    ],
    [...openItems, ...resolvedNodeItems],
  );
  const individuallyEnumeratedItems =
    identifiers.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist,
          identifiers,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  const enumeratedItems = deduplicateByStableId(
    [...openItems, ...resolvedNodeItems, ...individuallyEnumeratedItems],
    (item) => item.nodeId,
  );
  const itemCollection = await collectFreshRepositoryItemObservations(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repository,
    enumeratedItems,
    adjacentNodeIds,
  );
  return Object.freeze({
    state: createSnapshotCollectionRepository(repository, invocation.startedAt, enumeratedItems),
    ...itemCollection,
  });
}

function validateRelationExpansionEnumeration(
  repository: PublicRepository,
  requestedNodeIds: readonly GitHubNodeId[],
  enumeratedItems: readonly EnumeratedGitHubItem[],
): void {
  const requestedNodeIdSet = new Set(requestedNodeIds);
  if (
    requestedNodeIdSet.size !== requestedNodeIds.length ||
    enumeratedItems.length !== requestedNodeIds.length
  ) {
    throw new TypeError("関係先の個別列挙結果と要求node IDの件数が一致しません");
  }
  for (const item of enumeratedItems) {
    if (item.repositoryId !== repository.id || !requestedNodeIdSet.has(item.nodeId)) {
      throw new TypeError("関係先の個別列挙結果が要求したrepositoryとnode IDに一致しません");
    }
  }
}

async function collectAdditionalRelationItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  requestedNodeIds: readonly GitHubNodeId[],
  current: FreshRepositoryRuntimeCollection,
): Promise<FreshRepositoryRuntimeCollection> {
  const currentItemsByNodeId = new Map(current.enumeratedItems.map((item) => [item.nodeId, item]));
  const missingNodeIds = requestedNodeIds.filter((nodeId) => !currentItemsByNodeId.has(nodeId));
  const individuallyEnumeratedItems =
    missingNodeIds.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist: createPublicRepositoryAllowlist([repository]),
          identifiers: missingNodeIds,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  validateRelationExpansionEnumeration(repository, missingNodeIds, individuallyEnumeratedItems);
  const individuallyEnumeratedItemsByNodeId = new Map(
    individuallyEnumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailTargets = requestedNodeIds.map((nodeId) => {
    const item =
      currentItemsByNodeId.get(nodeId) ?? individuallyEnumeratedItemsByNodeId.get(nodeId);
    assertNonNullable(item, `関係先追加取得対象の列挙値がありません。対象: ${nodeId}`);
    return item;
  });
  validateRelationExpansionEnumeration(repository, requestedNodeIds, detailTargets);
  const additions = await collectFreshRepositoryItemObservations(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repository,
    detailTargets,
    new Set(requestedNodeIds),
  );
  const mergedEnumeratedItems = deduplicateByStableId(
    [...current.enumeratedItems, ...additions.enumeratedItems],
    (item) => item.nodeId,
  );
  const mergedDetails = deduplicateByStableId(
    [...current.details, ...additions.details],
    (detail) => detail.nodeId,
  );
  const mergedObservedItems = deduplicateByStableId(
    [...current.observedItems, ...additions.observedItems],
    (item) => item.nodeId,
  );
  const changedNodeIds = new Set([...current.changedNodeIds, ...additions.changedNodeIds]);
  return Object.freeze({
    state: createSnapshotCollectionRepository(
      repository,
      invocation.startedAt,
      mergedEnumeratedItems,
    ),
    enumeratedItems: mergedEnumeratedItems,
    details: mergedDetails,
    observedItems: mergedObservedItems,
    changedNodeIds: Object.freeze([...changedNodeIds]),
  });
}

function aggregateFreshRepositoryCollections(
  allowlist: PublicRepositoryAllowlist,
  freshCollectionsByRepositoryId: ReadonlyMap<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
): FreshRuntimeCollectionAggregate {
  const enumeratedItems: EnumeratedGitHubItem[] = [];
  const details: GitHubItemDetail[] = [];
  const observedItems: FreshObservedGitHubItem[] = [];
  const changedNodeIds = new Set<GitHubNodeId>();
  for (const repository of allowlist.repositories) {
    const collection = freshCollectionsByRepositoryId.get(repository.id);
    if (collection == null) {
      continue;
    }
    enumeratedItems.push(...collection.enumeratedItems);
    details.push(...collection.details);
    observedItems.push(...collection.observedItems);
    for (const nodeId of collection.changedNodeIds) {
      changedNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    enumeratedItems: deduplicateByStableId(enumeratedItems, (item) => item.nodeId),
    details: deduplicateByStableId(details, (detail) => detail.nodeId),
    observedItems: deduplicateByStableId(observedItems, (item) => item.nodeId),
    changedNodeIds,
  });
}

function collectedTrackingCandidateNodeIds(
  state: RuntimeState,
  aggregate: FreshRuntimeCollectionAggregate,
): ReadonlySet<GitHubNodeId> {
  const enumeratedNodeIds = new Set(aggregate.enumeratedItems.map((item) => item.nodeId));
  const candidateNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  for (const item of previousSnapshot(state)?.items ?? []) {
    if (enumeratedNodeIds.has(item.nodeId)) {
      candidateNodeIds.add(item.nodeId);
    }
  }
  return candidateNodeIds;
}

function relationExpansionRepositoriesByNodeId(
  candidates: readonly RelationCandidate[],
  allowlist: PublicRepositoryAllowlist,
): ReadonlyMap<GitHubNodeId, PublicRepository> {
  const repositoriesByNodeId = new Map<GitHubNodeId, PublicRepository>();
  for (const candidate of candidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope !== "organization") {
        continue;
      }
      const repository = allowlist.repositories.find(
        (current) =>
          current.owner.toLowerCase() === node.repositoryOwner.toLowerCase() &&
          current.name.toLowerCase() === node.repositoryName.toLowerCase(),
      );
      if (repository == null) {
        continue;
      }
      const existing = repositoriesByNodeId.get(node.nodeId);
      if (existing != null && existing.id !== repository.id) {
        throw new TypeError("同じ関係先node IDに異なるallowlist repositoryが指定されています");
      }
      repositoriesByNodeId.set(node.nodeId, repository);
    }
  }
  return repositoriesByNodeId;
}

function changedTrackedImplementationTargetNodeIds(
  aggregate: FreshRuntimeCollectionAggregate,
  tracking: RuntimeTrackingSelection,
  candidates: readonly RelationCandidate[],
  requestedNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  const enumeratedItemsByNodeId = new Map(
    aggregate.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const candidate of candidates) {
    if (candidate.authority !== "authoritative" || candidate.relation.type !== "implements") {
      continue;
    }
    const implementation = candidate.relation.implementation;
    const target = candidate.relation.target;
    if (
      implementation.scope !== "organization" ||
      implementation.kind !== "pull_request" ||
      target.scope !== "organization" ||
      target.kind !== "issue" ||
      !aggregate.changedNodeIds.has(implementation.nodeId) ||
      !tracking.workByNodeId.has(implementation.nodeId) ||
      !tracking.workByNodeId.has(target.nodeId) ||
      detailNodeIds.has(target.nodeId) ||
      requestedNodeIds.has(target.nodeId)
    ) {
      continue;
    }
    const targetItem = enumeratedItemsByNodeId.get(target.nodeId);
    assertNonNullable(targetItem, `実装関係先の列挙値がありません。対象: ${target.nodeId}`);
    if (targetItem.type !== "issue" || targetItem.state !== "open") {
      continue;
    }
    targetNodeIds.add(target.nodeId);
  }
  return Object.freeze([...targetNodeIds].sort());
}

type EffectiveAssigneeImplementationRelation = Readonly<{
  implementationNodeId: GitHubNodeId;
  targetNodeId: GitHubNodeId;
}>;

function effectiveAssigneeImplementationRelationKey(
  relation: EffectiveAssigneeImplementationRelation,
): string {
  return `${relation.implementationNodeId}\u0000${relation.targetNodeId}`;
}

function previousAuthoritativeImplementationRelations(
  state: RuntimeState,
): readonly EffectiveAssigneeImplementationRelation[] {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return Object.freeze([]);
  }
  const itemsByNodeId = new Map<GraphNodeId, SnapshotTrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    snapshot.relations.flatMap((relation) => {
      if (!relation.active || relation.provenance !== "native" || relation.type !== "implements") {
        return [];
      }
      const implementation = itemsByNodeId.get(relation.fromNodeId);
      const target = itemsByNodeId.get(relation.toNodeId);
      if (implementation?.type !== "pull_request" || target?.type !== "issue") {
        return [];
      }
      return [
        Object.freeze({
          implementationNodeId: implementation.nodeId,
          targetNodeId: target.nodeId,
        }),
      ];
    }),
  );
}

function trackedAuthoritativeImplementationRelationKeys(
  relationCandidates: readonly RelationCandidate[],
  tracking: RuntimeTrackingSelection,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const candidate of relationCandidates) {
    if (candidate.authority !== "authoritative" || candidate.relation.type !== "implements") {
      continue;
    }
    const implementation = candidate.relation.implementation;
    const target = candidate.relation.target;
    if (
      implementation.scope !== "organization" ||
      implementation.kind !== "pull_request" ||
      target.scope !== "organization" ||
      target.kind !== "issue" ||
      !tracking.workByNodeId.has(implementation.nodeId) ||
      !tracking.workByNodeId.has(target.nodeId)
    ) {
      continue;
    }
    keys.add(
      effectiveAssigneeImplementationRelationKey({
        implementationNodeId: implementation.nodeId,
        targetNodeId: target.nodeId,
      }),
    );
  }
  return keys;
}

function effectiveAssigneeRelationChangeTargetNodeIds(
  state: RuntimeState,
  observedItems: readonly FreshObservedGitHubItem[],
  relationCandidates: readonly RelationCandidate[],
  tracking: RuntimeTrackingSelection,
): ReadonlySet<GitHubNodeId> {
  const observedPullRequestNodeIds = new Set(
    observedItems
      .filter(
        (item): item is Extract<FreshObservedGitHubItem, { type: "pull_request" }> =>
          item.type === "pull_request",
      )
      .map((item) => item.nodeId),
  );
  const currentRelationKeys = trackedAuthoritativeImplementationRelationKeys(
    relationCandidates,
    tracking,
  );
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const relation of previousAuthoritativeImplementationRelations(state)) {
    if (!observedPullRequestNodeIds.has(relation.implementationNodeId)) {
      continue;
    }
    if (!currentRelationKeys.has(effectiveAssigneeImplementationRelationKey(relation))) {
      targetNodeIds.add(relation.targetNodeId);
    }
  }
  return targetNodeIds;
}

function staleEffectiveAssigneeTargetsToRetain(
  state: RuntimeState,
  observedItems: readonly FreshObservedGitHubItem[],
  staleRepositoryIds: ReadonlySet<GitHubRepositoryId>,
): ReadonlySet<GitHubNodeId> {
  const snapshot = previousSnapshot(state);
  if (snapshot == null || staleRepositoryIds.size === 0) {
    return new Set<GitHubNodeId>();
  }
  const previousItemsByNodeId = new Map<GraphNodeId, SnapshotTrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const previousEffectiveAssigneeIssueNodeIds = new Set(
    snapshot.items
      .filter(
        (item) =>
          item.type === "issue" &&
          item.state === "open" &&
          item.assignees.length === 0 &&
          item.status === "waiting_for_work" &&
          item.waitingOn.some(
            (waitingOn) => waitingOn.kind === "user" && waitingOn.role === "assignee",
          ),
      )
      .map((item) => item.nodeId),
  );
  const observedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const relation of previousAuthoritativeImplementationRelations(state)) {
    const implementation = previousItemsByNodeId.get(relation.implementationNodeId);
    const target = previousItemsByNodeId.get(relation.targetNodeId);
    assertNonNullable(
      implementation,
      `前回実質担当relationのPRがありません。対象: ${relation.implementationNodeId}`,
    );
    assertNonNullable(
      target,
      `前回実質担当relationのIssueがありません。対象: ${relation.targetNodeId}`,
    );
    if (
      !staleRepositoryIds.has(implementation.repositoryId) ||
      !previousEffectiveAssigneeIssueNodeIds.has(target.nodeId)
    ) {
      continue;
    }
    const current = observedItemsByNodeId.get(target.nodeId);
    if (current?.type !== "issue" || current.state !== "open" || current.assignees.length !== 0) {
      continue;
    }
    targetNodeIds.add(target.nodeId);
  }
  return targetNodeIds;
}

async function collectRelationExpansionBatch(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  allowlist: PublicRepositoryAllowlist,
  targetNodeIdsByRepositoryId: ReadonlyMap<GitHubRepositoryId, readonly GitHubNodeId[]>,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<void> {
  const targetRepositories = allowlist.repositories.filter((repository) =>
    targetNodeIdsByRepositoryId.has(repository.id),
  );
  const expandedCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const results = await collectRepositoriesWithStaleFallback({
    allowlist: createPublicRepositoryAllowlist(targetRepositories),
    observedAt: invocation.startedAt,
    previousValues: previousRepositoryValues(state),
    collect: async (repository) => {
      const requestedNodeIds = targetNodeIdsByRepositoryId.get(repository.id);
      assertNonNullable(requestedNodeIds, "関係先追加取得対象のnode IDがありません");
      const current = freshCollectionsByRepositoryId.get(repository.id);
      assertNonNullable(current, "関係先追加取得対象の最新repository収集結果がありません");
      const expanded = await collectAdditionalRelationItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        requestedNodeIds,
        current,
      );
      expandedCollectionsByRepositoryId.set(repository.id, expanded);
      return expanded.state;
    },
  });
  for (const result of results) {
    repositoryResultsById.set(result.repository.id, result);
    if (result.freshness === "stale") {
      freshCollectionsByRepositoryId.delete(result.repository.id);
      continue;
    }
    const expanded = expandedCollectionsByRepositoryId.get(result.repository.id);
    assertNonNullable(expanded, "関係先追加後の最新repository収集結果がありません");
    freshCollectionsByRepositoryId.set(result.repository.id, expanded);
  }
}

async function collectRelationExpandedItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repositoryInventory: RepositoryInventory,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<RelationExpandedRuntimeCollection> {
  const requestedNodeIds = new Set<GitHubNodeId>();
  const expandedNodeIds = new Set<GitHubNodeId>();
  for (;;) {
    const aggregate = aggregateFreshRepositoryCollections(
      repositoryInventory.allowlist,
      freshCollectionsByRepositoryId,
    );
    const discoveredRelationCandidates = extractAllRelationCandidates(
      configuration.config,
      repositoryInventory.allowlist,
      aggregate.enumeratedItems,
      aggregate.details,
    );
    const collectedCandidateNodeIds = collectedTrackingCandidateNodeIds(state, aggregate);
    const completedRelationCandidates = completeRelationCandidates(
      discoveredRelationCandidates,
      collectedCandidateNodeIds,
    );
    const evaluatedAt = currentRuntimeTime(adapters);
    const tracking = collectTrackingCandidates(
      invocation,
      evaluatedAt,
      configuration,
      state,
      repositoryInventory,
      aggregate.enumeratedItems,
      aggregate.observedItems,
      completedRelationCandidates.candidates,
    );
    const trackingState = relationExpansionTrackingState(tracking);
    const plannedRequests = planRelationExpansion({
      collectedCandidateNodeIds,
      trackingRootNodeIds: trackingState.trackingRootNodeIds,
      relationCandidates: discoveredRelationCandidates,
      nativeDepthByNodeId: trackingState.nativeDepthByNodeId,
      requestedNodeIds,
      maximumNativeDepth: configuration.config.tracking.autoInclude.nativeRelations
        ? configuration.config.tracking.autoInclude.relationDepth
        : 0,
    });
    const effectiveAssigneeTargetNodeIds = changedTrackedImplementationTargetNodeIds(
      aggregate,
      tracking,
      discoveredRelationCandidates,
      requestedNodeIds,
    );
    const requestsByNodeId = new Map(plannedRequests.map((request) => [request.nodeId, request]));
    for (const nodeId of effectiveAssigneeTargetNodeIds) {
      if (requestsByNodeId.has(nodeId)) {
        continue;
      }
      requestsByNodeId.set(
        nodeId,
        Object.freeze({
          nodeId,
          nativeDepth: 0,
        }),
      );
    }
    const nextRequests = [...requestsByNodeId.values()];
    if (nextRequests.length === 0) {
      return Object.freeze({
        ...aggregate,
        evaluatedAt,
        relationCandidates: completedRelationCandidates.candidates,
        droppedRelationCandidateCount: completedRelationCandidates.droppedCount,
        tracking,
      });
    }
    const repositoriesByNodeId = relationExpansionRepositoriesByNodeId(
      discoveredRelationCandidates,
      repositoryInventory.allowlist,
    );
    const targetNodeIdsByRepositoryId = new Map<GitHubRepositoryId, GitHubNodeId[]>();
    for (const request of nextRequests) {
      requestedNodeIds.add(request.nodeId);
      const repository = repositoriesByNodeId.get(request.nodeId);
      if (repository == null) {
        continue;
      }
      const repositoryResult = repositoryResultsById.get(repository.id);
      assertNonNullable(repositoryResult, "関係先追加取得対象のrepository収集結果がありません");
      if (repositoryResult.freshness === "stale") {
        continue;
      }
      const currentNodeIds = targetNodeIdsByRepositoryId.get(repository.id);
      if (currentNodeIds == null) {
        targetNodeIdsByRepositoryId.set(repository.id, [request.nodeId]);
      } else {
        currentNodeIds.push(request.nodeId);
      }
    }
    const targetNodeIds = [...targetNodeIdsByRepositoryId.values()].flat();
    const maximumItemCount = configuration.config.tracking.relationExpansion.maxItemsPerRun;
    if (expandedNodeIds.size + targetNodeIds.length > maximumItemCount) {
      throw new CliRelationExpansionLimitError(
        maximumItemCount,
        expandedNodeIds.size,
        targetNodeIds.length,
        {},
      );
    }
    for (const nodeId of targetNodeIds) {
      expandedNodeIds.add(nodeId);
    }
    if (targetNodeIds.length === 0) {
      continue;
    }
    await collectRelationExpansionBatch(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repositoryInventory.allowlist,
      targetNodeIdsByRepositoryId,
      freshCollectionsByRepositoryId,
      repositoryResultsById,
    );
  }
}

function finalizeEnumeratedItemObservation(
  item: EnumeratedGitHubItem,
  evaluatedAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    observedAt: evaluatedAt,
  } satisfies EnumeratedGitHubItem);
}

function finalizeItemDetailObservation(
  detail: GitHubItemDetail,
  evaluatedAt: UtcIsoDateTime,
): GitHubItemDetail {
  return Object.freeze({
    ...detail,
    observedAt: evaluatedAt,
  } satisfies GitHubItemDetail);
}

function finalizeObservedItemObservation(
  item: FreshObservedGitHubItem,
  evaluatedAt: UtcIsoDateTime,
): FreshObservedGitHubItem {
  return Object.freeze({
    ...item,
    observedAt: evaluatedAt,
  } satisfies FreshObservedGitHubItem);
}

function finalizeSnapshotCollectionRepository(
  repository: SnapshotCollectionRepository,
  evaluatedAt: UtcIsoDateTime,
): SnapshotCollectionRepository {
  return Object.freeze({
    ...repository,
    successfulAt: evaluatedAt,
    items: Object.freeze(
      repository.items.map((item) =>
        Object.freeze({
          ...item,
          observedAt: evaluatedAt,
        } satisfies SnapshotCollectionItem),
      ),
    ),
  });
}

function finalizeRepositoryCollectionResult(
  result: RepositoryCollectionResult<SnapshotCollectionRepository>,
  evaluatedAt: UtcIsoDateTime,
): RepositoryCollectionResult<SnapshotCollectionRepository> {
  if (result.freshness === "fresh") {
    return Object.freeze({
      ...result,
      value: finalizeSnapshotCollectionRepository(result.value, evaluatedAt),
      observedAt: evaluatedAt,
    });
  }
  return result;
}

async function collectProductionItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repositoryInventory: RepositoryInventory,
): Promise<
  Readonly<{
    value: CollectedItems;
    changedItemCount: number;
    staleRepositoryCount: number;
    diagnostics: readonly string[];
  }>
> {
  const nodeIdentifiers = configuredNodeIdentifiers(configuration.config);
  const explicitNodeItems =
    nodeIdentifiers.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist: repositoryInventory.allowlist,
          identifiers: nodeIdentifiers,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  const adjacentNodeIds = previousGraphAdjacentNodeIds(state);
  const freshCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const initialRepositoryResults = await collectRepositoriesWithStaleFallback({
    allowlist: repositoryInventory.allowlist,
    observedAt: invocation.startedAt,
    previousValues: previousRepositoryValues(state),
    collect: async (repository) => {
      const collected = await collectFreshRepositoryItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        explicitNodeItems,
        adjacentNodeIds,
      );
      freshCollectionsByRepositoryId.set(repository.id, collected);
      return collected.state;
    },
  });
  const repositoryResultsById = new Map(
    initialRepositoryResults.map((result) => [result.repository.id, result]),
  );
  const expanded = await collectRelationExpandedItems(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repositoryInventory,
    freshCollectionsByRepositoryId,
    repositoryResultsById,
  );
  const repositoryResults = Object.freeze(
    repositoryInventory.allowlist.repositories.map((repository) => {
      const result = repositoryResultsById.get(repository.id);
      assertNonNullable(result, `repository収集結果がありません。対象: ${repository.id}`);
      return finalizeRepositoryCollectionResult(result, expanded.evaluatedAt);
    }),
  );

  const staleItems: StaleObservedGitHubItem<SnapshotCollectionItem>[] = [];
  const collectionRepositories: SnapshotCollectionRepository[] = [];
  const staleRepositoryIds = new Set<GitHubRepositoryId>();
  const diagnostics: string[] = [];
  for (const result of repositoryResults) {
    if (result.freshness === "fresh") {
      collectionRepositories.push(result.value);
      continue;
    }
    staleRepositoryIds.add(result.repository.id);
    collectionRepositories.push(result.previousValue);
    staleItems.push(
      ...markObservedGitHubItemsStale({
        previousItems: result.previousValue.items,
        failedAt: result.failedAt,
        diagnostic: result.diagnostic,
      }),
    );
    diagnostics.push(result.diagnostic.message);
  }
  if (expanded.droppedRelationCandidateCount > 0) {
    diagnostics.push(
      `端点を取得できなかった関係候補を${expanded.droppedRelationCandidateCount.toString()}件除外しました`,
    );
  }
  if (expanded.tracking.excludedCandidateCount > 0) {
    diagnostics.push(
      `詳細未取得かつ前回未追跡の項目を追跡候補から${expanded.tracking.excludedCandidateCount.toString()}件除外しました`,
    );
  }

  const uniqueEnumeratedItems = Object.freeze(
    expanded.enumeratedItems.map((item) =>
      finalizeEnumeratedItemObservation(item, expanded.evaluatedAt),
    ),
  );
  const uniqueDetails = Object.freeze(
    expanded.details.map((detail) => finalizeItemDetailObservation(detail, expanded.evaluatedAt)),
  );
  const uniqueObservedItems = Object.freeze(
    expanded.observedItems.map((item) =>
      finalizeObservedItemObservation(item, expanded.evaluatedAt),
    ),
  );
  const changedNodeIds = expanded.changedNodeIds;
  const relationCandidates = expanded.relationCandidates;
  const tracking = expanded.tracking;
  const trackedNodeIds = new Set(
    tracking.result.trackedItems.map((selected) => selected.item.nodeId),
  );
  const trackingNotificationClassByNodeId = new Map(
    tracking.result.trackedItems.map((selected) => [
      selected.item.nodeId,
      selected.item.notificationClass,
    ]),
  );
  for (const previousItem of previousSnapshot(state)?.items ?? []) {
    if (staleRepositoryIds.has(previousItem.repositoryId)) {
      trackedNodeIds.add(previousItem.nodeId);
    }
  }
  const observedNodeIds = new Set(uniqueObservedItems.map((item) => item.nodeId));
  const analysisNodeIds = new Set<GitHubNodeId>(
    [...tracking.workByNodeId].flatMap(([nodeId, work]) =>
      work.codexAnalysis.action === "analyze" && observedNodeIds.has(nodeId) ? [nodeId] : [],
    ),
  );
  const effectiveAssigneeRelationChangeTargets = effectiveAssigneeRelationChangeTargetNodeIds(
    state,
    uniqueObservedItems,
    relationCandidates,
    tracking,
  );
  const staleEffectiveAssigneeTargets = staleEffectiveAssigneeTargetsToRetain(
    state,
    uniqueObservedItems,
    staleRepositoryIds,
  );
  for (const nodeId of staleEffectiveAssigneeTargets) {
    analysisNodeIds.delete(nodeId);
  }
  for (const [nodeId, work] of tracking.workByNodeId) {
    if (staleEffectiveAssigneeTargets.has(nodeId)) {
      continue;
    }
    if (work.codexAnalysis.action === "analyze") {
      continue;
    }
    const item = uniqueObservedItems.find((candidate) => candidate.nodeId === nodeId);
    if (item?.type !== "issue" || item.state !== "open" || item.assignees.length !== 0) {
      continue;
    }
    const issueRelationCandidates = candidatesForNode(item.nodeId, relationCandidates);
    const hasAnalyzedImplementation = issueRelationCandidates.some((candidate) => {
      if (candidate.relation.type !== "implements") {
        return false;
      }
      if (candidate.authority !== "authoritative") {
        return false;
      }
      const implementation = candidate.relation.implementation;
      const target = candidate.relation.target;
      if (
        implementation.scope !== "organization" ||
        implementation.kind !== "pull_request" ||
        target.scope !== "organization" ||
        target.kind !== "issue" ||
        target.nodeId !== item.nodeId
      ) {
        return false;
      }
      const implementationWork = tracking.workByNodeId.get(implementation.nodeId);
      return implementationWork?.codexAnalysis.action === "analyze";
    });
    const hasChangedImplementationRelation = effectiveAssigneeRelationChangeTargets.has(
      item.nodeId,
    );
    if (!hasAnalyzedImplementation && !hasChangedImplementationRelation) {
      continue;
    }
    const detail = uniqueDetails.find((candidate) => candidate.nodeId === item.nodeId);
    assertNonNullable(detail, `実質担当候補抽出対象の詳細がありません。対象: ${item.nodeId}`);
    if (detail.type !== "issue") {
      throw new TypeError(`Issueの詳細種別が一致しません。対象: ${item.nodeId}`);
    }
    analysisNodeIds.add(item.nodeId);
  }
  return Object.freeze({
    value: Object.freeze({
      evaluatedAt: expanded.evaluatedAt,
      enumeratedItems: uniqueEnumeratedItems,
      details: uniqueDetails,
      observedItems: uniqueObservedItems,
      staleItems: Object.freeze(staleItems),
      trackedNodeIds,
      trackingNotificationClassByNodeId,
      analysisNodeIds,
      changedNodeIds,
      externalReferences: tracking.result.ghostNodes,
      relationCandidates,
      repositoryResults,
      collectionRepositories: Object.freeze(collectionRepositories),
    }),
    changedItemCount: [...changedNodeIds].filter((nodeId) => trackedNodeIds.has(nodeId)).length,
    staleRepositoryCount: staleRepositoryIds.size,
    diagnostics: Object.freeze(diagnostics),
  });
}

function createDailyDependencies(
  adapters: ProductionRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes> {
  return Object.freeze({
    ...(adapters.diagnosticsRecorder == null
      ? {}
      : { diagnosticsRecorder: adapters.diagnosticsRecorder }),
    validateConfiguration: async ({ invocation, configPath }) => {
      requireEnvironmentVariables(adapters.environment, ["GH_APP_ID", "GH_APP_PRIVATE_KEY"]);
      const config = await adapters.loadConfig(resolve(adapters.repositoryPath, configPath));
      const credentials = readRuntimeCredentials(adapters.environment, config, invocation.command);
      if (credentials.codex.enabled) {
        await assertCodexAuthenticationAvailable(credentials.codex);
        await assertCodexCliAvailable(adapters, credentials.codex.environment);
      }
      return Object.freeze({
        config,
        credentials,
      });
    },
    loadState: async ({ configuration }) => {
      const session = await adapters.openStateSession(
        adapters.createStateBranchAdapter(),
        configuration.config.state,
      );
      const [snapshot, notificationLedger] = await Promise.all([
        session.loadSnapshot(),
        session.loadNotificationLedger(),
      ]);
      return Object.freeze({
        session,
        snapshot,
        notificationLedger,
      });
    },
    authenticateGitHub: ({ configuration }) =>
      adapters.createGitHubClient({
        organization: configuration.config.organization,
        credentials: configuration.credentials.github,
        operations: configuration.config.operations,
      }),
    collectRepositoryInventory: async ({ invocation, configuration, authentication }) => {
      const inventory = await adapters.discoverRepositoryInventory({
        organization: configuration.config.organization,
        observedAt: invocation.startedAt,
        request: authentication.request,
      });
      const allowlist = createPublicRepositoryAllowlist(inventory);
      return Object.freeze({
        value: Object.freeze({
          inventory,
          allowlist,
        }),
        repositoryCount: allowlist.repositories.length,
        githubApiRemaining: githubApiRemaining(authentication),
      });
    },
    collectIncrementalItems: async ({
      invocation,
      configuration,
      state,
      authentication,
      repositoryInventory,
    }) => {
      const collection = await collectProductionItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repositoryInventory,
      );
      return Object.freeze({
        value: collection.value,
        itemCount: collection.value.trackedNodeIds.size,
        changedItemCount: collection.changedItemCount,
        githubApiRemaining: githubApiRemaining(authentication),
        staleRepositoryCount: collection.staleRepositoryCount,
        diagnostics: collection.diagnostics,
      });
    },
    applyDeterministicRules: ({ configuration, state, repositoryInventory, collection }) =>
      Promise.resolve(
        applyDeterministicAnalysis(configuration, state, repositoryInventory, collection),
      ),
    analyzeWithCodex: async ({
      invocation,
      configuration,
      state,
      collection,
      deterministicAnalysis,
    }) => {
      const analysis = await analyzeCodex(
        adapters,
        invocation,
        configuration,
        state,
        collection,
        deterministicAnalysis,
      );
      return Object.freeze({
        status: analysis.status,
        value: analysis.stage,
        aiCallCount: analysis.aiCallCount,
        aiCacheHitCount: analysis.aiCacheHitCount,
        aiRetainedResultCount: analysis.aiRetainedResultCount,
        estimatedInputTokens: analysis.estimatedInputTokens,
        diagnostics: analysis.diagnostics,
      });
    },
    reduceAnalysis: ({ configuration, collection, deterministicAnalysis, codexAnalysis }) =>
      Promise.resolve(
        reduceAllAnalyses(
          configuration,
          deterministicAnalysis.state,
          deterministicAnalysis.inventory,
          collection,
          deterministicAnalysis,
          codexAnalysis,
        ),
      ),
    reconcileGraph: ({ configuration, state, collection, reduction }) => {
      const graph = reconcileCurrentGraph(configuration, state, collection, reduction);
      return Promise.resolve(
        Object.freeze({
          value: graph,
          activeEdgeCount: graph.edges.filter((edge) => edge.active).length,
        }),
      );
    },
    validateCompleteness: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      collection,
      codexAnalysis,
      reduction,
      graph,
    }) =>
      Promise.resolve(
        Object.freeze({
          status: "complete",
          value: validateRunCompleteness(
            invocation,
            configuration,
            state,
            repositoryInventory,
            collection,
            codexAnalysis,
            reduction,
            graph,
          ),
          diagnostics: Object.freeze([]),
        }),
      ),
    persistState: ({ configuration, state, repositoryInventory, validated }) =>
      persistValidatedRun(configuration, state, repositoryInventory, validated),
    buildPages: ({ configuration, repositoryInventory, validated, persisted }) =>
      buildPublicPages(
        adapters,
        configuration.config,
        repositoryInventory.inventory,
        repositoryInventory.allowlist.repositories,
        validated,
        persisted.historyRecords,
        adapters.pagesOutputDirectory,
        configuration.credentials.knownSecrets,
      ),
    sendDiscord: async ({ invocation, configuration, validated, pages }) => {
      if (
        invocation.command.kind !== "dry-run" &&
        invocation.command.notificationAction === "dismiss-current"
      ) {
        return Object.freeze({
          value: Object.freeze({
            delivery: Object.freeze({
              status: "skipped",
              reason: "no_candidates",
            }),
            notificationEvents: Object.freeze([]),
            notificationLedger: validated.notificationLedger,
          }),
          notificationCount: 0,
          discordSentAt: null,
        });
      }
      const result = await deliverDiscord(
        adapters,
        discordDeliverySettings(configuration.config),
        validated,
        pages.pagesUrl,
      );
      return Object.freeze({
        value: Object.freeze({
          ...result.value,
          notificationLedger: result.notificationLedger,
        }),
        notificationCount: result.notificationCount,
        discordSentAt: result.discordSentAt,
      });
    },
    completeRun: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      validated,
      discord,
      metrics,
      diagnostics,
    }) =>
      persistSuccessfulRunCompletion(
        adapters,
        configuration.config,
        state,
        repositoryInventory.inventory,
        validated,
        createRunMetadata(invocation, validated, metrics, diagnostics),
        {
          notificationLedger: discord.notificationLedger,
          notificationCount: metrics.notificationCount,
          notificationEvents: discord.notificationEvents,
        },
        configuration.credentials.knownSecrets,
      ),
    sendOperationsAlert: ({ invocation, configuration, state, persisted, kind, retryAttempts }) =>
      deliverOperationsAlert(
        adapters,
        configuration.config,
        configuration.credentials.knownSecrets,
        persisted == null
          ? state
          : Object.freeze({
              ...state,
              notificationLedger: persisted.notificationLedger,
            }),
        {
          incidentId: `${invocation.runId}:${kind}`,
          kind,
          occurredAt: invocation.startedAt,
          retryAttempts,
        },
      ),
    writeDryRunArtifact: (path, artifact) => adapters.writeJsonArtifact(path, artifact),
    writeCollectAnalyzeArtifact: (path, input) =>
      adapters.writeJsonArtifact(
        path,
        createCollectAnalyzeArtifact(
          input.invocation,
          input.configuration,
          input.state,
          input.repositoryInventory,
          input.validated,
          input.metrics,
          input.diagnostics,
        ),
      ),
    writeReport: (path, report) => writeRunReport(path, report, adapters.writeTextFile),
  });
}

function validatedRunFromArtifact(artifact: WorkflowArtifact): ValidatedRun {
  return Object.freeze({
    snapshot: artifact.snapshot,
    historyInputEvents: artifact.historyInputEvents,
    notificationLedger: artifact.notificationLedger,
    notificationSelection: artifact.notificationSelection,
  });
}

async function persistWorkflowState(
  adapters: ProductionRuntimeAdapters,
  command: PersistStateCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  for (const entry of artifact.aiCacheEntries) {
    await session.aiCache.write(entry);
  }
  await session.persist({
    snapshot: artifact.snapshot,
    historyInputEvents: artifact.historyInputEvents,
    notificationLedger: artifact.notificationLedger,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    knownSecrets: [],
  });
}

async function buildWorkflowPages(
  adapters: ProductionRuntimeAdapters,
  command: BuildPagesCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  if (pagesUrl(config) !== artifact.pagesUrl) {
    throw new TypeError("workflow artifactと現在の設定でPages URLが一致しません");
  }
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (
    persistedSnapshot.status !== "available" ||
    persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id
  ) {
    throw new TypeError("Pages生成対象のrunがtracker-state branchにありません");
  }
  const historyRecords = await session.loadHistoryRecords();
  await buildPublicPages(
    adapters,
    config,
    workflowArtifactRepositoryInventory(artifact),
    artifact.repositoryAllowlist,
    validatedRunFromArtifact(artifact),
    historyRecords,
    resolve(adapters.repositoryPath, command.outputDirectory),
    [],
  );
}

async function notifyWorkflowDiscord(
  adapters: ProductionRuntimeAdapters,
  command: NotifyDiscordCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord通知対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id) {
    throw new TypeError(
      "Discord通知対象のworkflow artifactとtracker-state branchでrunが一致しません",
    );
  }
  const state = Object.freeze({
    session,
    snapshot: persistedSnapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  if (artifact.notificationAction === "dismiss-current") {
    await persistSuccessfulRunCompletion(
      adapters,
      config,
      state,
      workflowArtifactRepositoryInventory(artifact),
      validatedRunFromArtifact(artifact),
      artifact.runMetadata,
      {
        notificationLedger: state.notificationLedger,
        notificationCount: 0,
        notificationEvents: Object.freeze([]),
      },
      [],
    );
    return;
  }
  const result = await deliverDiscord(
    adapters,
    artifact.discordSettings,
    Object.freeze({
      snapshot: artifact.snapshot,
      historyInputEvents: artifact.historyInputEvents,
      notificationLedger: state.notificationLedger,
      notificationSelection: artifact.notificationSelection,
    }),
    command.pagesUrl,
  );
  await persistSuccessfulRunCompletion(
    adapters,
    config,
    state,
    workflowArtifactRepositoryInventory(artifact),
    validatedRunFromArtifact(artifact),
    artifact.runMetadata,
    result,
    [],
  );
}

async function notifyWorkflowOperations(
  adapters: ProductionRuntimeAdapters,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const snapshot = await session.loadSnapshot();
  const state = Object.freeze({
    session,
    snapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const knownSecrets = config.notifications.discord.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          adapters.environment,
          config.notifications.discord.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  await deliverOperationsAlert(adapters, config, knownSecrets, state, {
    incidentId: command.incidentId,
    kind: command.incidentKind,
    occurredAt: command.occurredAt,
    retryAttempts: command.retryAttempts,
  });
}

async function reportWorkflowRun(
  adapters: ProductionRuntimeAdapters,
  command: ReportWorkflowCliCommand,
): Promise<void> {
  const collectAnalyzeReport = await readOptionalRunReportFile(
    resolve(adapters.repositoryPath, command.collectAnalyzeReportPath),
  );
  const report = createWorkflowRunReport({
    workflowRunId: command.workflowRunId,
    workflowRunAttempt: command.workflowRunAttempt,
    jobs: command.jobResults,
    collectAnalyzeReport,
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outputPath), report);
}

function createWorkflowStageRunner(adapters: ProductionRuntimeAdapters): WorkflowStageRunner {
  return new WorkflowStageRunner({
    persistState: (command) => persistWorkflowState(adapters, command),
    buildPages: (command) => buildWorkflowPages(adapters, command),
    notifyDiscord: (command) => notifyWorkflowDiscord(adapters, command),
    notifyOperations: (command) => notifyWorkflowOperations(adapters, command),
    reportWorkflow: (command) => reportWorkflowRun(adapters, command),
  });
}

function emptyOfflineMetrics(): OfflineAnalysisMetrics {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    aiRetainedResultCount: 0,
    estimatedInputTokens: 0,
    staleRepositoryCount: 0,
  });
}

function createOfflineRunner(adapters: ProductionRuntimeAdapters): OfflineRunRunner {
  return new OfflineRunRunner(
    {
      ...(adapters.diagnosticsRecorder == null
        ? {}
        : { diagnosticsRecorder: adapters.diagnosticsRecorder }),
      engine: {
        replayFixture: (fixture: ReplayFixture): Promise<OfflineAnalysisResult> => {
          const goldenInput = goldenEvalInputSchema.safeParse(fixture.input);
          if (!goldenInput.success) {
            return Promise.resolve(
              Object.freeze({
                status: "success",
                output: fixture.input,
                metrics: emptyOfflineMetrics(),
                diagnostics: Object.freeze([]),
              }),
            );
          }
          const analysis = analyzeGoldenFixture(goldenInput.data);
          return Promise.resolve(
            Object.freeze({
              status: "success",
              output: analysis.output,
              metrics: analysis.metrics,
              diagnostics: analysis.diagnostics,
            }),
          );
        },
        replayState: (state): Promise<OfflineAnalysisResult> =>
          Promise.resolve(
            Object.freeze({
              status: "success",
              output: state,
              metrics: Object.freeze({
                ...emptyOfflineMetrics(),
                repositoryCount: state.repositories.length,
                itemCount: state.items.length,
                activeEdgeCount: state.relations.filter((relation) => relation.active).length,
                staleRepositoryCount: state.repositories.filter(
                  (repository) => repository.freshness === "stale",
                ).length,
              }),
              diagnostics: Object.freeze([]),
            }),
          ),
      },
      readReplayFixture: adapters.readReplayFixture,
      readState: adapters.readReplayState,
      readGoldenFixtures: adapters.readGoldenFixtures,
      writeArtifact: adapters.writeJsonArtifact,
      writeReport: (path, report) => writeRunReport(path, report, adapters.writeTextFile),
    },
    {
      now: adapters.now,
    },
  );
}

/** 注入済みの具体アダプターから全サブコマンドを実行するapplicationを組み立てる。 */
export function createProductionCliApplication(
  adapters: ProductionRuntimeAdapters,
): CliApplication<ProductionTypes> {
  return new CliApplication({
    dailyRunner: new DailyTransactionRunner(createDailyDependencies(adapters), {
      now: adapters.now,
    }),
    workflowStageRunner: createWorkflowStageRunner(adapters),
    offlineRunner: createOfflineRunner(adapters),
    stateVerificationRunner: new StateVerificationRunner({
      verifyStateDirectory: adapters.verifyStateDirectory,
      writeStandardOutput: adapters.writeStandardOutput,
    }),
    writeStandardOutput: adapters.writeStandardOutput,
  });
}

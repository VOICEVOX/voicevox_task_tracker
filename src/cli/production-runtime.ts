import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  createCodexEnvironment,
  createCodexAnalysisInput,
  createCodexCacheValidationContext,
  createImportanceCacheCandidate,
  createImportanceCacheEntry,
  createImportanceCacheEntryFromAiResult,
  createImportanceCacheEntryFromCacheContext,
  createImportanceCacheEntryFromLatest,
  CodexOutputValidationError,
  parseCodexCacheValidationContext,
  parseSha256Hash,
  estimateAiInputCost,
  getCodexEnvironmentVariableAllowlist,
  hashCanonicalJson,
  prepareAiAnalysisCandidate,
  reduceCachedCodexAnalysis,
  reduceCodexAnalysis,
  reduceCodexInputValidationFailure,
  resolveImportance,
  runAiAnalyses,
  selectCodexImportanceAssessment,
  selectLatestImportanceCacheEntry,
  serializeCanonicalJson,
  MemoryAiCacheStore,
  type AiAnalysisCandidate,
  type AiAnalysisFingerprint,
  type AiCacheEntry,
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
  type ImportanceCacheContext,
  type ImportanceCacheEntry,
  type ImportanceCacheState,
  type ReducedCodexDecision,
  type VerifiedImportanceResult,
  type ValidatedCodexAnalysisOutput,
} from "../codex/index.js";
import { type Config, type loadConfig } from "../config/index.js";
import {
  aggregatePullRequestCheckState,
  aggregatePullRequestReviewState,
  buildSourceId,
  calculateAttention,
  calculateImportance,
  combineImportance,
  classifyTrackingNotification,
  createGitHubNodeId,
  createUtcIsoDateTime,
  createGitHubBotPredicate,
  createLabelEffectsResolver,
  createTrackedItemLatestEventActor,
  DETERMINISTIC_RULES_VERSION,
  determineIssueState,
  determineMeaningfulProgress,
  determinePullRequestState,
  determineTerminalRetention,
  determineTrackedItemWork,
  isTerminalStatus,
  ISSUE_DETERMINISTIC_RULES_VERSION,
  createExternalReferenceNodeId,
  parseSourceId,
  PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
  resolvePullRequestCheckContextOccurredAt,
  resolvePullRequestCommitOccurredAt,
  resolveRepositoryMaintainers,
  resolveWaitingOnAccountIdentifiers,
  ResponsibilityReplayMismatchError,
  selectTrackingItems,
  type LabelRule,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type GraphNodeId,
  type IssueBlocker,
  type IssueExplicitRequestCandidate,
  type IssueExplicitRequestAssessment,
  type IssueExplicitRequestTarget,
  type IssueStateDecision,
  type BlockedParentContext,
  type BlockerRanking,
  type OrganizationTrackingCandidate,
  type TrackingCandidate,
  type PullRequestStateDecision,
  type PullRequestCheckFailureAssessment,
  type PrimaryWaitingOn,
  type Relation,
  type ReplayItemHistoryResult,
  type RetentionItemState,
  type Repository,
  type SourceId,
  type Severity,
  type StalenessSeverityContext,
  type StalenessWaitClass,
  type StalenessResult,
  type NaturalLanguageProgressAssessment,
  type NaturalLanguageImportanceAssessmentState,
  type DependencyResolutionProgress,
  type ExternalGhostNode,
  type GitHubItemDisplayReference,
  type ImportanceDownstreamImpact,
  type NormalizedEvent,
  type TrackedItem,
  type TrackedItemAiAnalysis,
  type TrackedItemInputEvent,
  type TrackingConnection,
  type TrackingNotificationClass,
  type TrackingStartAtState,
  type TrackedItemWorkDecision,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  evaluateNormalDigestRun,
  isOneTimeNotificationDue,
  selectDiscordNotifications,
  type sendDiscordDigest,
  type DiscordDigestDelivery,
  type DiscordDeliverySettings,
  type DiscordNotificationItem,
  type DiscordNotificationEvent,
  type DiscordNotificationSelection,
  type DiscordOperationsIncident,
  type NormalDigestRunContext,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
import { analyzeGoldenFixture, goldenEvalInputSchema } from "../eval/index.js";
import {
  type collectGitHubItemDetails,
  collectRepositoriesWithStaleFallback,
  createPublicRepositoryAllowlist,
  deduplicateByStableId,
  finalizeGitHubItemsWithVolatileMetadata,
  type discoverRepositoryInventory,
  type enumerateGitHubItemsByIdentifiers,
  type enumerateOpenGitHubItems,
  normalizeObservedGitHubItems,
  planIncrementalItemCollection,
  parseGitHubAppCredentials,
  type probeGitHubPullRequestVolatileMetadataWithRetry,
  type CreateGitHubClientOptions,
  type CurrentAnalysisRulesFingerprints,
  type EnumeratedGitHubItem,
  type FreshObservedGitHubItem,
  type GitHubAppCredentials,
  type GitHubClient,
  type GitHubDetailActor,
  type GitHubItemDetail,
  type PublicRepository,
  type PublicRepositoryId,
  type PublicRepositoryAllowlist,
  type PreviousItemCollection,
  type RepositoryCollectionResult,
  assertCacheItemRelationPublicBoundary,
  adaptGitHubItemDetailRelationMutations,
  adaptMixedTemporalBlocksGraph,
  replayGitHubItemHistory,
  createGitHubItemCacheDocument,
  createGitHubPullRequestVolatileMetadataFromDetail,
  GitHubPublicBoundaryViolationError,
  restoreGitHubItemCacheForAnalysis,
  replaceGitHubItemCacheRelationData,
  sanitizeRelationMutationsForPublicBoundary,
  validateGitHubItemCacheAiEntry,
  type GitHubItemCacheAnalysisObservation,
  type GitHubItemCacheAnalysisSource,
  type GitHubRelationReferenceResult,
  type ResolveGitHubRelationReferenceOptions,
} from "../github/index.js";
import {
  analyzeGraph,
  buildRelationCandidateId,
  extractRelationCandidates,
  normalizeRelationCandidates,
  planRelationExpansion,
  reconcileGraph,
  replayDependencyEvents,
  replayTemporalBlocksGraph,
  RelationReferenceConflictError,
  type AnalyzeGraphResult,
  type CandidateRelation,
  type PublicGitHubRelationItem,
  type ReconciledGraphEdge,
  type GraphAnalysisNode,
  type ReconcileGraphResult,
  type TemporalBlocksGraphReplayResult,
  type RelationCandidate,
  type RelationCandidateAssessment,
  type RelationAssessmentVerdict,
  type RelationCandidateNode,
  type RelationCandidateId,
  type RelationExtractionItem,
  type RelationMutationResult,
} from "../graph/index.js";
import {
  parseRelationTextReferences,
  type RelationTextReference,
} from "../graph/extract-relation-candidates.js";
import { type ExternalRelationCandidateNode } from "../graph/relation-candidate-types.js";
import { createRelationMutationReferenceKey } from "../graph/relation-mutation.js";
import {
  generatePublicData,
  PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  type GeneratedPublicData,
  type PublicDataWriteResult,
  type PagesPublicSafetyInput,
} from "../pages/index.js";
import {
  createStateSnapshot,
  CacheOnlyPersistenceSession,
  type CacheOnlyLoadedState,
  type CacheOnlyPersistenceResult,
  type SnapshotAiState,
  type SnapshotCollectionItem,
  type SnapshotCollectionRepository,
  type SnapshotRepository,
  type SnapshotTrackedItem,
  type StateBranchAdapter,
  type StateSnapshot,
  CACHE_DOCUMENT_SCHEMA_VERSION,
  type GitHubRepositoryCacheDocument,
  type CacheItemIndex,
  createCacheDocument,
  createCacheTerminalExpiry,
  validateCacheOnlyPersistenceInput,
  type AiLatestImportanceCacheDocument,
  type CacheHistory,
  type CacheRepositoryIdentity,
  type CacheOnlyValidatedDocuments,
  type GitHubItemCacheDocument,
} from "../persistence/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { CliApplication } from "./application.js";
import { createTrackingBackfillRequest } from "./backfill.js";
import {
  type BuildPagesCliCommand,
  type NotifyDiscordCliCommand,
  type NotifyOperationsCliCommand,
  type PersistCacheCliCommand,
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
  ResponsibilityReplayRetryExhaustedError,
} from "./errors.js";
import { safeCodexFallbackDiagnostic } from "./error-diagnostic.js";
import { calculateStalenessForItem } from "./staleness-reduction.js";
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
const CODEX_SCHEMA_VERSION = "2";
const PAGES_BASE_URL = "https://voicevox.github.io";
const GITHUB_MENTION_PATTERN =
  /(?<![A-Za-z0-9-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99})))?/gu;
const GITHUB_ITEM_DISPLAY_REFERENCE_SCHEMA = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);
const normalDigestEnvironmentSchema = z.strictObject({
  GITHUB_EVENT_NAME: z.enum(["workflow_dispatch", "schedule"], {
    error: "GITHUB_EVENT_NAMEはworkflow_dispatchまたはscheduleを指定してください",
  }),
  GITHUB_RUN_ATTEMPT: z
    .string({ error: "GITHUB_RUN_ATTEMPTを指定してください" })
    .regex(/^[1-9]\d*$/u, "GITHUB_RUN_ATTEMPTは正の整数文字列にしてください")
    .refine(
      (value) => Number.isSafeInteger(Number(value)),
      "GITHUB_RUN_ATTEMPTは安全な整数の範囲内にしてください",
    ),
});
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
  session: CacheOnlyPersistenceSession;
  loaded: CacheOnlyLoadedState;
  aiCache: MemoryAiCacheStore;
  allowlist: PublicRepositoryAllowlist;
}>;

type RepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
}>;

type CachedObservedGitHubItem = GitHubItemCacheAnalysisObservation &
  Readonly<{
    repositoryId: PublicRepositoryId;
    displayReference: EnumeratedGitHubItem["displayReference"];
  }>;

type RuntimeObservedGitHubItem = FreshObservedGitHubItem | CachedObservedGitHubItem;

type ExactCachedAiAnalysis = Readonly<{
  entry: AiCacheEntry;
  output: ValidatedCodexAnalysisOutput;
  fingerprint: AiAnalysisFingerprint;
}>;

type RuntimeItemAnalysisSource =
  | Readonly<{
      kind: "fresh";
      item: FreshObservedGitHubItem;
      detail: GitHubItemDetail;
      relationMutations: readonly RelationMutationResult[];
      replay: ReplayItemHistoryResult;
    }>
  | Readonly<{
      kind: "cached";
      item: CachedObservedGitHubItem;
      document: GitHubItemCacheDocument;
      analysis: GitHubItemCacheAnalysisSource;
      exactAi: ExactCachedAiAnalysis | undefined;
    }>;

type StaleDisplayItemAnalysisSource = Readonly<{
  kind: "stale_display";
  item: CachedObservedGitHubItem;
  repositoryIndex: CacheItemIndex;
  document: GitHubItemCacheDocument;
  analysis: GitHubItemCacheAnalysisSource;
  failedAt: UtcIsoDateTime;
}>;

type CachedItemAnalysisRestoreResult =
  | Readonly<{
      status: "restored";
      source: RuntimeItemAnalysisSource;
    }>
  | Readonly<{
      status: "detail_required";
      reason: "cache_miss" | "exact_ai_refresh" | "relation_public_boundary_revalidation";
      diagnostics: readonly string[];
    }>;

type ExactAiRelationNotificationHistory = Readonly<{
  exactBlocksEdges: readonly Readonly<{
    fromNodeId: GraphNodeId;
    toNodeId: GraphNodeId;
  }>[];
  relationCandidates: readonly RelationCandidate[];
}>;

type CollectedItems = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly RuntimeObservedGitHubItem[];
  analysisSources: readonly RuntimeItemAnalysisSource[];
  staleDisplaySources: readonly StaleDisplayItemAnalysisSource[];
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
  trackingNotificationClassByNodeId: ReadonlyMap<GitHubNodeId, TrackingNotificationClass>;
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  relationPublicBoundaryRevalidationNodeIds: ReadonlySet<GitHubNodeId>;
  externalReferences: readonly ExternalGhostNode[];
  relationCandidates: readonly RelationCandidate[];
  exactAiRelationNotificationHistory: ExactAiRelationNotificationHistory;
  repositoryResults: readonly RepositoryCollectionResult<SnapshotCollectionRepository>[];
  collectionRepositories: readonly SnapshotCollectionRepository[];
}>;

type FreshRepositoryItemCollection = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  reenumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly RuntimeObservedGitHubItem[];
  analysisSources: readonly RuntimeItemAnalysisSource[];
  changedNodeIds: readonly GitHubNodeId[];
  diagnostics: readonly string[];
}>;

type FreshRepositoryRuntimeCollection = FreshRepositoryItemCollection &
  Readonly<{
    provisionalEnumeratedItems: readonly EnumeratedGitHubItem[];
    state: SnapshotCollectionRepository;
  }>;

type FreshRuntimeCollectionAggregate = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly RuntimeObservedGitHubItem[];
  analysisSources: readonly RuntimeItemAnalysisSource[];
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  diagnostics: readonly string[];
}>;

type RelationExpansionTarget = Readonly<{
  nodeId: GitHubNodeId;
  type: "issue" | "pull_request";
  number: number;
  url: PublicGitHubRelationItem["url"];
}>;

type RelationExpandedRuntimeCollection = FreshRuntimeCollectionAggregate &
  Readonly<{
    evaluatedAt: UtcIsoDateTime;
    relationCandidates: readonly RelationCandidate[];
    droppedRelationCandidateCount: number;
    relationPublicBoundaryRevalidationNodeIds: ReadonlySet<GitHubNodeId>;
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

type DeterministicItemAnalysis = Readonly<{
  item: RuntimeObservedGitHubItem;
  source: RuntimeItemAnalysisSource;
  decision: IssueStateDecision | PullRequestStateDecision;
  notificationClass: TrackingNotificationClass;
  relationCandidates: readonly RelationCandidate[];
}>;

type DeterministicAnalysis = Readonly<{
  items: readonly DeterministicItemAnalysis[];
  state: RuntimeState;
  inventory: RepositoryInventory;
}>;

type CodexAnalysis = Readonly<{
  run: AiAnalysisRunResult | undefined;
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
  exactCachedByNodeId: ReadonlyMap<GitHubNodeId, ExactCachedAiAnalysis>;
  latestImportanceByNodeId: ReadonlyMap<GitHubNodeId, AiLatestImportanceCacheDocument>;
  fallbackImportanceByNodeId: ReadonlyMap<
    GitHubNodeId,
    Extract<NaturalLanguageImportanceAssessmentState, { status: "available" }>
  >;
  rejectedAiCacheKeys: ReadonlySet<AiCacheEntry["cacheKey"]>;
}>;

type ReducedItemAnalysis = Readonly<{
  item: RuntimeObservedGitHubItem;
  decision: ReducedCodexDecision;
  notificationRecommendation: DiscordNotificationItem["notificationRecommendation"];
  aiNotificationEvents: readonly DiscordNotificationEvent[];
  primaryWaitingOn: PrimaryWaitingOn;
  staleness: StalenessResult;
  importanceAssessment: NaturalLanguageImportanceAssessmentState;
}>;

type TrackedItemStaleness = Readonly<{
  elapsedHours: number;
  severity: Severity;
  waitClass: StalenessWaitClass;
  severityContext: StalenessSeverityContext;
}>;

type WithoutImportance<T> = T extends unknown ? Omit<T, "importance"> : never;
type PendingTrackedItem = WithoutImportance<TrackedItem>;
type TrackedItemWithImportanceAssessment = TrackedItem &
  Readonly<{
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
  }>;

type ReducedAnalysis = Readonly<{
  items: readonly PendingTrackedItem[];
  currentItems: readonly ReducedItemAnalysis[];
  stalenessByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemStaleness>;
  relationAssessments: readonly RelationCandidateAssessment[];
  unresolvedAiRelationCandidateIds: readonly RelationCandidateId[];
  runStatus: "success" | "fallback";
}>;

type GraphResult = Readonly<{
  displayEdges: readonly ReconciledGraphEdge[];
  analysisEdges: readonly ReconciledGraphEdge[];
  externalReferences: readonly ExternalGhostNode[];
  analysis: AnalyzeGraphResult;
  temporal: TemporalBlocksGraphReplayResult;
  activeBlockIntervalsByEdgeKey: ReadonlyMap<
    string,
    Readonly<{
      addedAt: UtcIsoDateTime;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>
  >;
}>;

type RuntimeCachePayload = CacheOnlyValidatedDocuments;

type ValidatedRun = Readonly<{
  snapshot: StateSnapshot;
  notificationSelection: DiscordNotificationSelection;
  cacheOnlyPayload: RuntimeCachePayload;
}>;

type ValidatedNotificationRun = Readonly<{
  snapshot: StateSnapshot;
  notificationSelection: DiscordNotificationSelection;
}>;

type PersistedRun = Readonly<{
  result: CacheOnlyPersistenceResult;
}>;

type PagesResult = Readonly<{
  data: GeneratedPublicData;
  output: PublicDataWriteResult;
  pagesUrl: string;
}>;

type DiscordDeliveryResult = Readonly<{
  delivery: DiscordDigestDelivery;
}>;

type DiscordResult = DiscordDeliveryResult;

export type ProductionTypes = DailyTransactionTypeMap &
  Readonly<{
    configuration: RuntimeConfiguration;
    cache: RuntimeState;
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
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openCacheSession: (
    adapter: StateBranchAdapter,
    configuration: Config["state"],
    allowlist: PublicRepositoryAllowlist,
  ) => Promise<CacheOnlyPersistenceSession>;
  discoverRepositoryInventory: typeof discoverRepositoryInventory;
  enumerateGitHubItemsByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  enumerateOpenGitHubItems: typeof enumerateOpenGitHubItems;
  probeGitHubPullRequestVolatileMetadataWithRetry: typeof probeGitHubPullRequestVolatileMetadataWithRetry;
  collectGitHubItemDetails: typeof collectGitHubItemDetails;
  resolveGitHubRelationReference: (
    options: ResolveGitHubRelationReferenceOptions,
  ) => Promise<GitHubRelationReferenceResult>;
  executeCodexAnalysis: (
    input: CodexAnalysisInput,
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<unknown>;
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
  if (
    command.kind !== "dry-run" &&
    command.kind !== "collect-analyze" &&
    config.notifications.discord.enabled
  ) {
    knownSecrets.push(
      requireEnvironmentValue(environment, config.notifications.discord.webhookSecretName),
      requireEnvironmentValue(
        environment,
        config.notifications.discord.operationsWebhookSecretName,
      ),
    );
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

function loadedItemCacheDocuments(state: RuntimeState): readonly GitHubItemCacheDocument[] {
  return state.loaded.status === "available" ? state.loaded.itemCaches : [];
}

function loadedRepositoryCacheDocuments(
  state: RuntimeState,
): readonly GitHubRepositoryCacheDocument[] {
  return state.loaded.status === "available" ? state.loaded.repositoryCaches : [];
}

function loadedLatestImportanceCacheDocuments(
  state: RuntimeState,
): readonly AiLatestImportanceCacheDocument[] {
  return state.loaded.status === "available" ? state.loaded.latestImportanceCaches : [];
}

function snapshotCollectionItemFromCache(
  index: CacheItemIndex,
  repositoryId: PublicRepositoryId,
): SnapshotCollectionItem {
  const lifecycle = index.lifecycle;
  if (lifecycle.kind === "open") {
    return Object.freeze({
      freshness: "fresh",
      nodeId: index.nodeId,
      repositoryId,
      itemFingerprint: index.itemFingerprint,
      aiAnalysisFingerprint: Object.freeze({ status: "unavailable" }),
      analysisRulesFingerprint: Object.freeze({
        status: "available",
        fingerprint: index.analysisRulesFingerprint,
      }),
      deterministicRulesVersion: Object.freeze({
        status: "available",
        version: index.deterministicRulesVersion,
      }),
      observedAt: index.observedAt,
      state: "open",
      terminalAt: null,
    });
  }
  return Object.freeze({
    freshness: "fresh",
    nodeId: index.nodeId,
    repositoryId,
    itemFingerprint: index.itemFingerprint,
    aiAnalysisFingerprint: Object.freeze({ status: "unavailable" }),
    analysisRulesFingerprint: Object.freeze({
      status: "available",
      fingerprint: index.analysisRulesFingerprint,
    }),
    deterministicRulesVersion: Object.freeze({
      status: "available",
      version: index.deterministicRulesVersion,
    }),
    observedAt: index.observedAt,
    state: "closed",
    terminalAt: lifecycle.terminalAt,
  });
}

function cacheCollectionRepository(
  state: RuntimeState,
  repositoryId: PublicRepositoryId,
): SnapshotCollectionRepository | undefined {
  const repository = loadedRepositoryCacheDocuments(state).find(
    (candidate) => candidate.repository.repositoryId === repositoryId,
  );
  if (repository == null) {
    return undefined;
  }
  return Object.freeze({
    repositoryId,
    successfulAt: repository.successfulAt,
    items: Object.freeze(
      repository.items.map((item) => snapshotCollectionItemFromCache(item, repositoryId)),
    ),
  });
}

function normalizeTrackingIdentifier(identifier: string): string {
  if (identifier.includes("://") && identifier.endsWith("/")) {
    return identifier.slice(0, -1);
  }
  return identifier;
}

function previousCollectionRepository(
  state: RuntimeState,
  repositoryId: PublicRepositoryId,
): SnapshotCollectionRepository | undefined {
  return cacheCollectionRepository(state, repositoryId);
}

function previousCollectionItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotCollectionItem> {
  return new Map(
    loadedRepositoryCacheDocuments(state).flatMap((repository) =>
      repository.items.map((item) => {
        const publicRepository = state.allowlist.require(repository.repository.repositoryId);
        const collectionItem = snapshotCollectionItemFromCache(item, publicRepository.id);
        const pair: readonly [GitHubNodeId, SnapshotCollectionItem] = [item.nodeId, collectionItem];
        return pair;
      }),
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

function previousGraphAdjacentNodeIds(
  state: RuntimeState,
  changedNodeIds: ReadonlySet<GitHubNodeId>,
): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  for (const document of loadedItemCacheDocuments(state)) {
    for (const candidate of document.relationCandidates) {
      const nodes = (() => {
        switch (candidate.relation.type) {
          case "blocks":
            return [candidate.relation.blocker, candidate.relation.blocked];
          case "parent_of":
            return [candidate.relation.parent, candidate.relation.subtask];
          case "implements":
            return [candidate.relation.implementation, candidate.relation.target];
          case "unclassified":
            return [candidate.relation.referencing, candidate.relation.referenced];
        }
      })();
      if (!nodes.some((node) => node.scope === "organization" && changedNodeIds.has(node.nodeId))) {
        continue;
      }
      for (const node of nodes) {
        if (node.scope === "organization") {
          nodeIds.add(node.nodeId);
        }
      }
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
  for (const item of loadedItemCacheDocuments(state)) {
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
        item.currentObservation,
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
    loadedItemCacheDocuments(state).map((item) => item.nodeId),
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

function findEnumeratedItem(
  collection: CollectedItems,
  nodeId: GitHubNodeId,
): EnumeratedGitHubItem {
  const item = collection.enumeratedItems.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(item, `GitHub列挙結果がありません。対象: ${nodeId}`);
  return item;
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

function currentRelationCandidateNode(
  node: RelationCandidateNode,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem>,
  organization: string,
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>,
): RelationCandidateNode {
  const reference = createRelationTextReference(node);
  const aliasedItem = relationReferenceAliases.get(createRelationMutationReferenceKey(reference));
  if (aliasedItem != null) {
    if (aliasedItem.type !== reference.itemType || aliasedItem.number !== reference.number) {
      throw new TypeError("relation reference aliasの項目種別または番号が一致しません");
    }
    if (aliasedItem.repositoryOwner.toLowerCase() === organization.toLowerCase()) {
      return Object.freeze({
        scope: "organization",
        kind: aliasedItem.type,
        nodeId: aliasedItem.nodeId,
        repositoryOwner: aliasedItem.repositoryOwner,
        repositoryName: aliasedItem.repositoryName,
        number: aliasedItem.number,
        url: aliasedItem.url,
        state: aliasedItem.state,
      });
    }
    return Object.freeze({
      scope: "external_public",
      kind: "external_reference",
      nodeId: createExternalReferenceNodeId(`external:github:${aliasedItem.nodeId}`),
      githubNodeId: aliasedItem.nodeId,
      githubItemType: aliasedItem.type,
      repositoryOwner: aliasedItem.repositoryOwner,
      repositoryName: aliasedItem.repositoryName,
      number: aliasedItem.number,
      url: aliasedItem.url,
      state: aliasedItem.state,
    });
  }
  if (node.scope === "external_public") {
    const item = itemsByNodeId.get(node.githubNodeId);
    if (item == null) {
      return node;
    }
    assertExternalRelationCandidateMetadata(node, item, false);
    if (item.repositoryOwner.toLowerCase() === organization.toLowerCase()) {
      return Object.freeze({
        scope: "organization",
        kind: item.type,
        nodeId: item.nodeId,
        repositoryOwner: item.repositoryOwner,
        repositoryName: item.repositoryName,
        number: item.number,
        url: item.url,
        state: item.state,
      });
    }
    return Object.freeze({
      ...node,
      repositoryOwner: item.repositoryOwner,
      repositoryName: item.repositoryName,
      githubItemType: item.type,
      number: item.number,
      url: item.url,
      state: item.state,
    });
  }
  const item = itemsByNodeId.get(node.nodeId);
  if (item == null) {
    return node;
  }
  if (
    item.nodeId !== node.nodeId ||
    item.type !== node.kind ||
    item.number !== node.number ||
    item.repositoryOwner.toLowerCase() !== node.repositoryOwner.toLowerCase() ||
    item.repositoryName.toLowerCase() !== node.repositoryName.toLowerCase() ||
    item.url !== node.url
  ) {
    throw new TypeError("relation候補の既知metadataが一致しません");
  }
  if (item.repositoryOwner.toLowerCase() !== organization.toLowerCase()) {
    return Object.freeze({
      scope: "external_public",
      kind: "external_reference",
      nodeId: createExternalReferenceNodeId(`external:github:${item.nodeId}`),
      githubNodeId: item.nodeId,
      githubItemType: item.type,
      repositoryOwner: item.repositoryOwner,
      repositoryName: item.repositoryName,
      number: item.number,
      url: item.url,
      state: item.state,
    });
  }
  return Object.freeze({
    scope: "organization",
    kind: item.type,
    nodeId: item.nodeId,
    repositoryOwner: item.repositoryOwner,
    repositoryName: item.repositoryName,
    number: item.number,
    url: item.url,
    state: item.state,
  });
}

function currentCandidateRelation(
  relation: CandidateRelation,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem>,
  organization: string,
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>,
): CandidateRelation {
  switch (relation.type) {
    case "blocks":
      return {
        type: "blocks",
        blocker: currentRelationCandidateNode(
          relation.blocker,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
        blocked: currentRelationCandidateNode(
          relation.blocked,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
      };
    case "parent_of":
      return {
        type: "parent_of",
        parent: currentRelationCandidateNode(
          relation.parent,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
        subtask: currentRelationCandidateNode(
          relation.subtask,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
      };
    case "implements":
      return {
        type: "implements",
        implementation: currentRelationCandidateNode(
          relation.implementation,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
        target: currentRelationCandidateNode(
          relation.target,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
      };
    case "unclassified":
      return {
        type: "unclassified",
        referencing: currentRelationCandidateNode(
          relation.referencing,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
        referenced: currentRelationCandidateNode(
          relation.referenced,
          itemsByNodeId,
          organization,
          relationReferenceAliases,
        ),
      };
  }
}

function currentRelationCandidate(
  candidate: RelationCandidate,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem>,
  organization: string,
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>,
): RelationCandidate {
  const relation = currentCandidateRelation(
    candidate.relation,
    itemsByNodeId,
    organization,
    relationReferenceAliases,
  );
  const id = buildRelationCandidateId(candidate.provenance, relation);
  switch (candidate.provenance) {
    case "native":
      if (relation.type === "unclassified") {
        throw new TypeError(`native relation候補 ${candidate.id}の型が不正です`);
      }
      return Object.freeze({ ...candidate, id, relation });
    case "explicit_text":
      if (relation.type !== "unclassified") {
        throw new TypeError(`explicit text relation候補 ${candidate.id}の型が不正です`);
      }
      return Object.freeze({ ...candidate, id, relation });
    case "closing_keyword":
      if (relation.type !== "implements") {
        throw new TypeError(`closing keyword relation候補 ${candidate.id}の型が不正です`);
      }
      return Object.freeze({ ...candidate, id, relation });
    case "checklist":
      if (relation.type !== "parent_of") {
        throw new TypeError(`checklist relation候補 ${candidate.id}の型が不正です`);
      }
      return Object.freeze({ ...candidate, id, relation });
    case "cross_reference":
      if (relation.type !== "unclassified" && relation.type !== "implements") {
        throw new TypeError(`cross reference relation候補 ${candidate.id}の型が不正です`);
      }
      return Object.freeze({ ...candidate, id, relation });
  }
}

function currentExternalRelationCandidate(
  candidate: RelationCandidate,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem>,
  organization: string,
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>,
): RelationCandidate {
  return relationNodes(candidate.relation).some(
    (node) =>
      node.scope === "external_public" ||
      relationReferenceAliases.has(
        createRelationMutationReferenceKey(createRelationTextReference(node)),
      ),
  )
    ? currentRelationCandidate(candidate, itemsByNodeId, organization, relationReferenceAliases)
    : candidate;
}

function assertExternalRelationCandidateMetadata(
  node: ExternalRelationCandidateNode,
  item: PublicGitHubRelationItem,
  compareState: boolean,
): void {
  if (
    node.nodeId !== createExternalReferenceNodeId(`external:github:${item.nodeId}`) ||
    item.nodeId !== node.githubNodeId ||
    item.type !== node.githubItemType ||
    item.number !== node.number ||
    item.repositoryOwner.toLowerCase() !== node.repositoryOwner.toLowerCase() ||
    item.repositoryName.toLowerCase() !== node.repositoryName.toLowerCase() ||
    item.url !== node.url ||
    (compareState && item.state !== node.state)
  ) {
    throw new TypeError("外部relation候補と公開metadataが一致しません");
  }
}

function extractRelationCandidatesForDetail(
  config: Config,
  itemByNodeId: ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem>,
  knownItems: readonly PublicGitHubRelationItem[],
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>,
  detail: GitHubItemDetail,
): readonly RelationCandidate[] {
  const item = itemByNodeId.get(detail.nodeId);
  assertNonNullable(item, `関係候補抽出対象がありません。対象: ${detail.nodeId}`);
  const extractionItem: RelationExtractionItem = {
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
  };
  return extractRelationCandidates({
    organization: config.organization,
    item: extractionItem,
    knownItems,
    relationReferenceAliases,
  });
}

type RelationCandidateOriginProof = Readonly<{
  sourceItemNodeId: GitHubNodeId;
  sourceId: SourceId;
  provenance: "native" | "cross_reference";
  relationType: CandidateRelation["type"];
  endpoint: 0 | 1;
  reference: RelationTextReference;
  stableNodeId: GitHubNodeId;
  itemType: "issue" | "pull_request";
  number: number;
}>;

type RelationCandidateOrigin = Readonly<{
  sourceId: SourceId;
  reference: RelationTextReference;
  stableNodeId: GitHubNodeId;
  itemType: "issue" | "pull_request";
  number: number;
}>;

function createRelationCandidateOriginReference(
  item: Readonly<{
    repositoryOwner: string;
    repositoryName: string;
    type: "issue" | "pull_request";
    number: number;
  }>,
): RelationTextReference {
  return Object.freeze({
    repositoryOwner: item.repositoryOwner,
    repositoryName: item.repositoryName,
    itemType: item.type,
    number: item.number,
  });
}

function relationCandidateNodeIdentity(node: RelationCandidateNode): Readonly<{
  stableNodeId: GitHubNodeId;
  itemType: "issue" | "pull_request";
  number: number;
}> {
  if (node.scope === "external_public") {
    return Object.freeze({
      stableNodeId: node.githubNodeId,
      itemType: node.githubItemType,
      number: node.number,
    });
  }
  return Object.freeze({
    stableNodeId: node.nodeId,
    itemType: node.kind,
    number: node.number,
  });
}

function detailRelationCandidateOrigins(
  detail: GitHubItemDetail,
): readonly RelationCandidateOrigin[] {
  const origins: RelationCandidateOrigin[] = [];
  const add = (
    sourceId: SourceId,
    item: Readonly<{
      nodeId: GitHubNodeId;
      repositoryOwner: string;
      repositoryName: string;
      type: "issue" | "pull_request";
      number: number;
    }>,
  ): void => {
    const origin = Object.freeze({
      sourceId,
      reference: createRelationCandidateOriginReference(item),
      stableNodeId: item.nodeId,
      itemType: item.type,
      number: item.number,
    });
    const existing = origins.find((candidate) => candidate.sourceId === sourceId);
    if (existing != null) {
      if (
        existing.stableNodeId !== origin.stableNodeId ||
        existing.reference.repositoryOwner.toLowerCase() !==
          origin.reference.repositoryOwner.toLowerCase() ||
        existing.reference.repositoryName.toLowerCase() !==
          origin.reference.repositoryName.toLowerCase() ||
        existing.itemType !== origin.itemType ||
        existing.number !== origin.number
      ) {
        throw new TypeError("relation候補のorigin source IDが衝突しています");
      }
      return;
    }
    origins.push(origin);
  };
  for (const reference of detail.inboundCrossReferences) {
    add(reference.eventSourceId, reference.sourceItem);
  }
  if (detail.type === "issue") {
    if (detail.nativeDependencies.availability === "available") {
      for (const relation of detail.nativeDependencies.relations) {
        add(relation.sourceId, relation.relatedItem);
      }
    }
    if (detail.nativeHierarchy.availability === "available") {
      for (const relation of detail.nativeHierarchy.relations) {
        add(relation.sourceId, relation.relatedItem);
      }
    }
  } else {
    for (const relation of detail.nativeClosingIssues) {
      add(relation.sourceId, relation.relatedItem);
    }
  }
  return Object.freeze(origins);
}

function createRelationCandidateOriginProofs(
  detail: GitHubItemDetail,
  candidates: readonly RelationCandidate[],
): readonly RelationCandidateOriginProof[] {
  const originsBySourceId = new Map(
    detailRelationCandidateOrigins(detail).map((origin) => [origin.sourceId, origin]),
  );
  const proofs: RelationCandidateOriginProof[] = [];
  for (const candidate of candidates) {
    if (candidate.provenance !== "native" && candidate.provenance !== "cross_reference") {
      continue;
    }
    const nodes = relationNodes(candidate.relation);
    for (const endpoint of [0, 1]) {
      const node = nodes[endpoint];
      assertNonNullable(node, "relation候補のorigin endpointがありません");
      const identity = relationCandidateNodeIdentity(node);
      for (const sourceId of candidate.sourceIds) {
        const origin = originsBySourceId.get(sourceId);
        if (origin == null) {
          continue;
        }
        if (
          origin.stableNodeId !== identity.stableNodeId ||
          origin.itemType !== identity.itemType ||
          origin.number !== identity.number
        ) {
          continue;
        }
        const proof = Object.freeze({
          sourceItemNodeId: detail.nodeId,
          sourceId,
          provenance: candidate.provenance,
          relationType: candidate.relation.type,
          endpoint: endpoint === 0 ? 0 : 1,
          reference: origin.reference,
          stableNodeId: origin.stableNodeId,
          itemType: origin.itemType,
          number: origin.number,
        });
        if (
          !proofs.some(
            (existing) =>
              existing.sourceItemNodeId === proof.sourceItemNodeId &&
              existing.sourceId === proof.sourceId &&
              existing.provenance === proof.provenance &&
              existing.relationType === proof.relationType &&
              existing.endpoint === proof.endpoint,
          )
        ) {
          proofs.push(proof);
        }
      }
    }
  }
  return Object.freeze(proofs);
}

function extractRelationCandidatesOnce(
  config: Config,
  knownItems: readonly PublicGitHubRelationItem[],
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>,
  details: readonly GitHubItemDetail[],
  analysisSources: readonly RuntimeItemAnalysisSource[],
): Readonly<{
  candidates: readonly RelationCandidate[];
  originProofs: readonly RelationCandidateOriginProof[];
}> {
  const itemByNodeId = new Map(knownItems.map((item) => [item.nodeId, item]));
  const candidates: RelationCandidate[] = [];
  const originProofs: RelationCandidateOriginProof[] = [];
  for (const detail of details) {
    const extracted = extractRelationCandidatesForDetail(
      config,
      itemByNodeId,
      knownItems,
      relationReferenceAliases,
      detail,
    );
    candidates.push(...extracted);
    originProofs.push(...createRelationCandidateOriginProofs(detail, extracted));
  }
  for (const source of analysisSources) {
    if (source.kind === "cached") {
      candidates.push(
        ...source.analysis.relationCandidates.map((candidate) =>
          currentRelationCandidate(
            candidate,
            itemByNodeId,
            config.organization,
            relationReferenceAliases,
          ),
        ),
      );
    }
  }
  return Object.freeze({
    candidates: normalizeRelationCandidates(
      candidates.map((candidate) =>
        currentExternalRelationCandidate(
          candidate,
          itemByNodeId,
          config.organization,
          relationReferenceAliases,
        ),
      ),
    ),
    originProofs: Object.freeze(originProofs),
  });
}

function findRelationReferenceRepository(
  allowlist: PublicRepositoryAllowlist,
  reference: PublicGitHubRelationItem,
): PublicRepository | undefined {
  return allowlist.repositories.find(
    (repository) =>
      repository.owner.toLowerCase() === reference.repositoryOwner.toLowerCase() &&
      repository.name.toLowerCase() === reference.repositoryName.toLowerCase(),
  );
}

function validateRelationReferenceRefresh(
  repository: PublicRepository,
  expected: PublicGitHubRelationItem,
  item: EnumeratedGitHubItem,
  cause: RelationReferenceConflictError,
): EnumeratedGitHubItem {
  if (
    expected.repositoryOwner.toLowerCase() !== repository.owner.toLowerCase() ||
    expected.repositoryName.toLowerCase() !== repository.name.toLowerCase() ||
    expected.repositoryArchived !== repository.archived ||
    expected.repositoryDisabled !== repository.disabled ||
    item.repositoryId !== repository.id ||
    item.nodeId !== expected.nodeId ||
    item.number !== expected.number ||
    item.type !== expected.type ||
    item.url !== expected.url
  ) {
    throw new TypeError(
      `関係参照競合の再取得結果が要求項目と一致しません。対象: ${expected.nodeId}`,
      { cause },
    );
  }
  return item;
}

type RelationReferenceRefreshTarget = Readonly<{
  repository: PublicRepository;
  expected: PublicGitHubRelationItem;
}>;

type RelationReferenceRefreshCollection = Readonly<{
  repository: PublicRepository;
  items: readonly EnumeratedGitHubItem[];
}>;

interface RelationReferenceRetryBudget {
  readonly maxRefreshes: number;
  refreshes: number;
}

type ExtractedRelationCandidates = Readonly<{
  candidates: readonly RelationCandidate[];
  originProofs: readonly RelationCandidateOriginProof[];
  aggregate: FreshRuntimeCollectionAggregate;
  externalRelationResolution: ExternalRelationResolution;
}>;

type RelationReferenceOccurrence =
  | Readonly<{
      kind: "content";
      sourceItemNodeId: GitHubNodeId;
      contentSourceId: SourceId;
      reference: RelationTextReference;
    }>
  | Readonly<{
      kind: "candidate";
      sourceItemNodeId: GitHubNodeId;
      candidate: RelationCandidateNode;
      reference: RelationTextReference;
    }>;

type ExternalRelationResolutionCacheEntry = Readonly<{
  itemType: RelationTextReference["itemType"];
  result: GitHubRelationReferenceResult;
}>;

type ExternalRelationResolutionCache = Map<string, ExternalRelationResolutionCacheEntry>;

type CurrentRelationReferences =
  | Readonly<{
      status: "available";
      references: readonly RelationTextReference[];
    }>
  | Readonly<{
      status: "unknown";
    }>
  | Readonly<{
      status: "candidate_derived";
      references: readonly RelationTextReference[];
    }>;

type PublicCurrentRelationReferences = Exclude<
  CurrentRelationReferences,
  { status: "candidate_derived" }
>;

type ExternalRelationResolution = Readonly<{
  knownItems: readonly PublicGitHubRelationItem[];
  resolvedItemsByNodeId: ReadonlyMap<
    GitHubNodeId,
    Extract<GitHubRelationReferenceResult, { status: "public" }>["item"]
  >;
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>;
  canonicalReferencesByReferenceKey: ReadonlyMap<string, RelationTextReference>;
  currentReferencesBySourceItemNodeId: ReadonlyMap<
    GitHubNodeId,
    ReadonlyMap<SourceId, PublicCurrentRelationReferences>
  >;
  verifiedExternalReferencesBySourceItemNodeId: ReadonlyMap<
    GitHubNodeId,
    ReadonlyMap<SourceId, readonly RelationTextReference[]>
  >;
  resultsByReferenceKey: ReadonlyMap<string, GitHubRelationReferenceResult>;
}>;

interface ExternalRelationReferenceGroup {
  itemType: RelationTextReference["itemType"];
  occurrences: RelationReferenceOccurrence[];
}

function relationMutationResultsForSource(
  source: RuntimeItemAnalysisSource,
): readonly RelationMutationResult[] {
  return source.kind === "fresh" ? source.relationMutations : source.analysis.relationMutations;
}

function createRelationTextReference(node: RelationCandidateNode): RelationTextReference {
  return Object.freeze({
    repositoryOwner: node.repositoryOwner,
    repositoryName: node.repositoryName,
    itemType: node.scope === "external_public" ? node.githubItemType : node.kind,
    number: node.number,
  });
}

function addReferenceToContentSourceMap(
  referencesByContentSource: Map<SourceId, CurrentRelationReferences>,
  contentSourceId: SourceId,
  reference: RelationTextReference,
): void {
  const current = referencesByContentSource.get(contentSourceId);
  if (current == null) {
    throw new TypeError("relation mutationのcontent sourceがありません");
  }
  if (current.status === "unknown") {
    referencesByContentSource.set(
      contentSourceId,
      Object.freeze({ status: "candidate_derived", references: Object.freeze([reference]) }),
    );
    return;
  }
  const key = createRelationMutationReferenceKey(reference);
  if (current.status === "candidate_derived") {
    if (
      current.references.some((candidate) => createRelationMutationReferenceKey(candidate) === key)
    ) {
      return;
    }
    referencesByContentSource.set(
      contentSourceId,
      Object.freeze({
        status: "candidate_derived",
        references: Object.freeze([...current.references, reference]),
      }),
    );
    return;
  }
  if (
    !current.references.some((candidate) => createRelationMutationReferenceKey(candidate) === key)
  ) {
    throw new TypeError("relation mutationのcurrent参照とcandidateが一致しません");
  }
}

function normalizeCurrentRelationReferences(
  references: CurrentRelationReferences,
): PublicCurrentRelationReferences {
  if (references.status !== "candidate_derived") {
    return references;
  }
  return Object.freeze({
    status: "available",
    references: references.references,
  });
}

function createCurrentReferenceMap(
  source: RuntimeItemAnalysisSource,
): Map<SourceId, CurrentRelationReferences> {
  const referencesByContentSource = new Map<SourceId, CurrentRelationReferences>();
  if (source.kind === "fresh") {
    const textSources = [
      Object.freeze({ contentSourceId: source.detail.bodySourceId, markdown: source.detail.body }),
      ...source.detail.comments.map((comment) =>
        Object.freeze({ contentSourceId: comment.sourceId, markdown: comment.body }),
      ),
    ];
    for (const textSource of textSources) {
      const parsed = parseRelationTextReferences(textSource.markdown);
      if (parsed.status === "unknown") {
        referencesByContentSource.set(
          textSource.contentSourceId,
          Object.freeze({ status: "unknown" }),
        );
        continue;
      }
      referencesByContentSource.set(
        textSource.contentSourceId,
        Object.freeze({ status: "available", references: parsed.references }),
      );
    }
    for (const result of source.relationMutations) {
      if (!referencesByContentSource.has(result.contentSourceId)) {
        throw new TypeError("relation mutationのcontent sourceがありません");
      }
    }
    return referencesByContentSource;
  }
  for (const result of source.analysis.relationMutations) {
    if (result.status === "available") {
      referencesByContentSource.set(
        result.contentSourceId,
        Object.freeze({ status: "available", references: result.currentReferences }),
      );
    } else {
      referencesByContentSource.set(result.contentSourceId, Object.freeze({ status: "unknown" }));
    }
  }
  return referencesByContentSource;
}

function createCurrentTextReferenceOccurrences(
  source: RuntimeItemAnalysisSource,
  referencesByContentSource: ReadonlyMap<SourceId, CurrentRelationReferences>,
): readonly RelationReferenceOccurrence[] {
  const occurrences: RelationReferenceOccurrence[] = [];
  for (const [contentSourceId, current] of referencesByContentSource.entries()) {
    if (current.status !== "available") {
      continue;
    }
    for (const reference of current.references) {
      occurrences.push(
        Object.freeze({
          kind: "content",
          sourceItemNodeId: source.item.nodeId,
          contentSourceId,
          reference,
        }),
      );
    }
  }
  return Object.freeze(occurrences);
}

function collectCachedExternalRelationCandidateOccurrences(
  source: RuntimeItemAnalysisSource,
  allowlist: PublicRepositoryAllowlist,
): readonly RelationReferenceOccurrence[] {
  if (source.kind !== "cached") {
    return Object.freeze([]);
  }
  const contentSourceIds = new Set(
    source.analysis.relationMutations.map((result) => result.contentSourceId),
  );
  const occurrences: RelationReferenceOccurrence[] = [];
  for (const candidate of source.analysis.relationCandidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (
        node.scope === "organization" &&
        allowlist.repositories.some(
          (repository) =>
            repository.owner.toLowerCase() === node.repositoryOwner.toLowerCase() &&
            repository.name.toLowerCase() === node.repositoryName.toLowerCase(),
        )
      ) {
        continue;
      }
      const reference = createRelationTextReference(node);
      occurrences.push(
        Object.freeze({
          kind: "candidate",
          sourceItemNodeId: source.item.nodeId,
          candidate: node,
          reference,
        }),
      );
      if (node.scope === "external_public") {
        for (const sourceId of candidate.sourceIds) {
          if (contentSourceIds.has(sourceId)) {
            occurrences.push(
              Object.freeze({
                kind: "content",
                sourceItemNodeId: source.item.nodeId,
                contentSourceId: sourceId,
                reference,
              }),
            );
          }
        }
      }
    }
  }
  return Object.freeze(occurrences);
}

function collectExternalRelationCandidateOccurrences(
  analysisSources: readonly RuntimeItemAnalysisSource[],
  relationCandidates: readonly RelationCandidate[],
  originProofs: readonly RelationCandidateOriginProof[],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): readonly RelationReferenceOccurrence[] {
  const occurrences: RelationReferenceOccurrence[] = [];
  for (const source of analysisSources) {
    for (const candidate of candidatesForNode(source.item.nodeId, relationCandidates)) {
      const nodes = relationNodes(candidate.relation);
      for (const endpoint of [0, 1]) {
        const node = nodes[endpoint];
        assertNonNullable(node, "relation候補のresolver endpointがありません");
        const proofs = originProofs.filter(
          (proof) =>
            proof.sourceItemNodeId === source.item.nodeId &&
            proof.provenance === candidate.provenance &&
            proof.relationType === candidate.relation.type &&
            proof.endpoint === (endpoint === 0 ? 0 : 1) &&
            candidate.sourceIds.includes(proof.sourceId),
        );
        if (proofs.length > 0) {
          for (const proof of proofs) {
            if (isExactAllowlistedInternalOriginProof(node, proof, organization, allowlist)) {
              continue;
            }
            occurrences.push(
              Object.freeze({
                kind: "candidate",
                sourceItemNodeId: source.item.nodeId,
                candidate: node,
                reference: proof.reference,
              }),
            );
          }
          continue;
        }
        if (
          source.kind === "fresh" &&
          (candidate.provenance === "native" || candidate.provenance === "cross_reference")
        ) {
          continue;
        }
        if (node.scope !== "external_public") {
          continue;
        }
        occurrences.push(
          Object.freeze({
            kind: "candidate",
            sourceItemNodeId: source.item.nodeId,
            candidate: node,
            reference: createRelationTextReference(node),
          }),
        );
      }
    }
  }
  return Object.freeze(occurrences);
}

function createPublicExternalRelationItem(
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
): PublicGitHubRelationItem {
  return Object.freeze({
    nodeId: item.nodeId,
    repositoryOwner: item.repositoryOwner,
    repositoryName: item.repositoryName,
    repositoryArchived: item.repositoryArchived,
    repositoryDisabled: item.repositoryDisabled,
    type: item.type,
    number: item.number,
    url: item.url,
    state: item.state,
  });
}

function createCanonicalRelationReference(
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
): RelationTextReference {
  return Object.freeze({
    repositoryOwner: item.repositoryOwner,
    repositoryName: item.repositoryName,
    itemType: item.type,
    number: item.number,
  });
}

function isAllowlistedCanonicalRelationItem(
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): boolean {
  if (item.repositoryOwner.toLowerCase() !== organization.toLowerCase()) {
    return true;
  }
  const repository = allowlist.repositories.find((candidate) => candidate.id === item.repositoryId);
  return (
    repository?.owner.toLowerCase() === item.repositoryOwner.toLowerCase() &&
    repository.name.toLowerCase() === item.repositoryName.toLowerCase()
  );
}

function isCanonicalOrganizationRelationItem(
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): boolean {
  if (item.repositoryOwner.toLowerCase() !== organization.toLowerCase()) {
    return false;
  }
  const repository = allowlist.repositories.find((candidate) => candidate.id === item.repositoryId);
  return repository?.owner === item.repositoryOwner && repository.name === item.repositoryName;
}

function assertResolvedExternalRelationItem(
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
): void {
  const itemType: unknown = item.type;
  const itemState: unknown = item.state;
  if (
    typeof item.nodeId !== "string" ||
    item.nodeId.length === 0 ||
    typeof item.repositoryId !== "string" ||
    item.repositoryId.length === 0 ||
    typeof item.repositoryOwner !== "string" ||
    item.repositoryOwner.length === 0 ||
    typeof item.repositoryName !== "string" ||
    item.repositoryName.length === 0 ||
    typeof item.number !== "number" ||
    !Number.isSafeInteger(item.number) ||
    item.number <= 0 ||
    typeof item.repositoryArchived !== "boolean" ||
    typeof item.repositoryDisabled !== "boolean" ||
    (itemType !== "issue" && itemType !== "pull_request") ||
    (itemState !== "open" && itemState !== "closed" && itemState !== "merged") ||
    typeof item.url !== "string"
  ) {
    throw new TypeError("外部relation公開metadataが不正です");
  }
  if (itemType === "issue" && itemState === "merged") {
    throw new TypeError("外部relation公開metadataのIssue状態が不正です");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(item.url);
  } catch (error: unknown) {
    throw new TypeError("外部relation公開metadataのURLが不正です", { cause: error });
  }
  const itemPath = item.type === "issue" ? "issues" : "pull";
  const expectedPath = `/${item.repositoryOwner}/${item.repositoryName}/${itemPath}/${item.number.toString()}`;
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname.toLowerCase() !== "github.com" ||
    parsedUrl.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
    parsedUrl.search.length !== 0 ||
    parsedUrl.hash.length !== 0
  ) {
    throw new TypeError("外部relation公開metadataのURLが一致しません");
  }
}

function normalizeExternalRelationReferenceResult(
  result: GitHubRelationReferenceResult,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): GitHubRelationReferenceResult {
  if (result.status === "public") {
    assertResolvedExternalRelationItem(result.item);
    if (!isAllowlistedCanonicalRelationItem(result.item, organization, allowlist)) {
      return Object.freeze({ status: "unverified" });
    }
  }
  return result;
}

function samePublicRelationItem(
  left: PublicGitHubRelationItem,
  right: PublicGitHubRelationItem,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.repositoryOwner.toLowerCase() === right.repositoryOwner.toLowerCase() &&
    left.repositoryName.toLowerCase() === right.repositoryName.toLowerCase() &&
    left.repositoryArchived === right.repositoryArchived &&
    left.repositoryDisabled === right.repositoryDisabled &&
    left.type === right.type &&
    left.number === right.number &&
    left.url === right.url &&
    left.state === right.state
  );
}

type PublicRelationItemWithRepository = Readonly<{
  item: PublicGitHubRelationItem;
  repositoryId: GitHubRepositoryId;
}>;

function createRelationItemsByNodeId(
  internalItems: readonly PublicRelationItemWithRepository[],
  externalItems: ReadonlyMap<
    GitHubNodeId,
    Extract<GitHubRelationReferenceResult, { status: "public" }>["item"]
  >,
): ReadonlyMap<GitHubNodeId, PublicGitHubRelationItem> {
  const itemsByNodeId = new Map<GitHubNodeId, PublicRelationItemWithRepository>();
  const addItem = (entry: PublicRelationItemWithRepository): void => {
    const existing = itemsByNodeId.get(entry.item.nodeId);
    if (
      existing != null &&
      (existing.repositoryId !== entry.repositoryId ||
        !samePublicRelationItem(existing.item, entry.item))
    ) {
      throw new TypeError("relation公開metadataのnode IDが衝突しています");
    }
    itemsByNodeId.set(entry.item.nodeId, entry);
  };
  for (const entry of internalItems) {
    addItem(entry);
  }
  for (const item of externalItems.values()) {
    addItem({
      item: createPublicExternalRelationItem(item),
      repositoryId: item.repositoryId,
    });
  }
  return new Map([...itemsByNodeId].map(([nodeId, entry]) => [nodeId, entry.item]));
}

function sameResolvedRelationItem(
  left: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
  right: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.repositoryId === right.repositoryId &&
    left.repositoryOwner.toLowerCase() === right.repositoryOwner.toLowerCase() &&
    left.repositoryName.toLowerCase() === right.repositoryName.toLowerCase() &&
    left.repositoryArchived === right.repositoryArchived &&
    left.repositoryDisabled === right.repositoryDisabled &&
    left.type === right.type &&
    left.number === right.number &&
    left.url === right.url &&
    left.state === right.state
  );
}

function assertRelationReferenceResolutionResultsCompatible(
  left: GitHubRelationReferenceResult,
  right: GitHubRelationReferenceResult,
): void {
  if (left.status !== right.status) {
    throw new TypeError("同じrelation参照keyに異なる公開検証結果があります");
  }
  if (left.status === "public") {
    if (right.status !== "public" || !sameResolvedRelationItem(left.item, right.item)) {
      throw new TypeError("同じrelation参照keyに異なる公開metadataがあります");
    }
  }
}

function canReuseExternalRelationResolution(
  entry: ExternalRelationResolutionCacheEntry,
  itemType: RelationTextReference["itemType"],
): boolean {
  if (entry.itemType === itemType) {
    return true;
  }
  return (
    entry.result.status === "public" && (itemType == null || entry.result.item.type === itemType)
  );
}

async function resolveExternalRelationReferences(
  resolveRelationReference: ProductionRuntimeAdapters["resolveGitHubRelationReference"],
  authentication: GitHubClient,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  analysisSources: readonly RuntimeItemAnalysisSource[],
  resolutionCache: ExternalRelationResolutionCache,
  additionalCandidateOccurrences: readonly RelationReferenceOccurrence[],
): Promise<ExternalRelationResolution> {
  const groups = new Map<string, ExternalRelationReferenceGroup>();
  const relationReferenceAliases = new Map<string, PublicGitHubRelationItem>();
  const canonicalReferencesByReferenceKey = new Map<string, RelationTextReference>();
  const currentBySourceItemNodeId = new Map<
    GitHubNodeId,
    Map<SourceId, CurrentRelationReferences>
  >();
  const verifiedBySourceItemNodeId = new Map<
    GitHubNodeId,
    Map<SourceId, RelationTextReference[]>
  >();
  const addOccurrence = (occurrence: RelationReferenceOccurrence): void => {
    if (
      allowlist.repositories.some(
        (repository) =>
          repository.owner.toLowerCase() === occurrence.reference.repositoryOwner.toLowerCase() &&
          repository.name.toLowerCase() === occurrence.reference.repositoryName.toLowerCase(),
      )
    ) {
      return;
    }
    const key = createRelationMutationReferenceKey(occurrence.reference);
    const existing = groups.get(key);
    if (existing == null) {
      groups.set(key, {
        itemType: occurrence.reference.itemType,
        occurrences: [occurrence],
      });
      return;
    }
    if (
      existing.itemType != null &&
      occurrence.reference.itemType != null &&
      existing.itemType !== occurrence.reference.itemType
    ) {
      throw new TypeError("同じ外部relation参照に異なる項目種別が指定されています");
    }
    if (existing.itemType == null && occurrence.reference.itemType != null) {
      existing.itemType = occurrence.reference.itemType;
    }
    existing.occurrences.push(occurrence);
  };
  for (const source of analysisSources) {
    const referencesByContentSource = createCurrentReferenceMap(source);
    currentBySourceItemNodeId.set(source.item.nodeId, referencesByContentSource);
    verifiedBySourceItemNodeId.set(
      source.item.nodeId,
      new Map(
        [...referencesByContentSource.keys()].map((contentSourceId) => [contentSourceId, []]),
      ),
    );
    for (const occurrence of createCurrentTextReferenceOccurrences(
      source,
      referencesByContentSource,
    )) {
      addOccurrence(occurrence);
    }
    for (const occurrence of collectCachedExternalRelationCandidateOccurrences(source, allowlist)) {
      if (occurrence.kind === "content") {
        addReferenceToContentSourceMap(
          referencesByContentSource,
          occurrence.contentSourceId,
          occurrence.reference,
        );
      }
      addOccurrence(occurrence);
    }
  }
  for (const occurrence of additionalCandidateOccurrences) {
    addOccurrence(occurrence);
  }

  const publicItemsByNodeId = new Map<GitHubNodeId, PublicGitHubRelationItem>();
  const resolvedItemsByNodeId = new Map<
    GitHubNodeId,
    Extract<GitHubRelationReferenceResult, { status: "public" }>["item"]
  >();
  const resultsByReferenceKey = new Map<string, GitHubRelationReferenceResult>();
  const registerResult = (key: string, result: GitHubRelationReferenceResult): void => {
    const existing = resultsByReferenceKey.get(key);
    if (existing != null) {
      assertRelationReferenceResolutionResultsCompatible(existing, result);
    }
    resultsByReferenceKey.set(key, result);
  };
  const registerCacheResult = (
    key: string,
    itemType: RelationTextReference["itemType"],
    result: GitHubRelationReferenceResult,
  ): void => {
    const existing = resolutionCache.get(key);
    if (existing != null) {
      assertRelationReferenceResolutionResultsCompatible(existing.result, result);
    }
    resolutionCache.set(key, Object.freeze({ itemType, result }));
  };
  const registerAlias = (key: string, item: PublicGitHubRelationItem): void => {
    const existing = relationReferenceAliases.get(key);
    if (existing != null && !samePublicRelationItem(existing, item)) {
      throw new TypeError("relation reference aliasが衝突しています");
    }
    relationReferenceAliases.set(key, item);
  };
  const registerPublicResult = (
    key: string,
    result: Extract<GitHubRelationReferenceResult, { status: "public" }>,
  ): void => {
    const publicItem = createPublicExternalRelationItem(result.item);
    const existingResolvedItem = resolvedItemsByNodeId.get(result.item.nodeId);
    if (
      existingResolvedItem != null &&
      !sameResolvedRelationItem(existingResolvedItem, result.item)
    ) {
      throw new TypeError("外部relation公開metadataのnode IDが衝突しています");
    }
    resolvedItemsByNodeId.set(result.item.nodeId, result.item);
    const existingPublicItem = publicItemsByNodeId.get(publicItem.nodeId);
    if (existingPublicItem != null && !samePublicRelationItem(existingPublicItem, publicItem)) {
      throw new TypeError("外部relation公開metadataのnode IDが衝突しています");
    }
    publicItemsByNodeId.set(publicItem.nodeId, publicItem);
    const canonicalReference = createCanonicalRelationReference(result.item);
    const canonicalKey = createRelationMutationReferenceKey(canonicalReference);
    registerAlias(key, publicItem);
    registerAlias(canonicalKey, publicItem);
    canonicalReferencesByReferenceKey.set(key, canonicalReference);
    canonicalReferencesByReferenceKey.set(canonicalKey, canonicalReference);
    registerCacheResult(canonicalKey, result.item.type, result);
    registerResult(canonicalKey, result);
  };
  for (const [key, cached] of [...resolutionCache.entries()]) {
    registerResult(key, cached.result);
    if (cached.result.status === "public") {
      registerPublicResult(key, cached.result);
    }
  }
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => compareStrings(left, right));
  for (const [key, group] of sortedGroups) {
    const firstOccurrence = group.occurrences[0];
    assertNonNullable(firstOccurrence, "外部relation参照のoccurrenceがありません");
    const reference = Object.freeze({
      ...firstOccurrence.reference,
      itemType: group.itemType,
    });
    const cached = resolutionCache.get(key);
    const result = normalizeExternalRelationReferenceResult(
      cached != null && canReuseExternalRelationResolution(cached, group.itemType)
        ? cached.result
        : await resolveRelationReference({
            reference,
            graphql: authentication.graphql,
          }),
      organization,
      allowlist,
    );
    if (
      result.status === "public" &&
      group.itemType != null &&
      result.item.type !== group.itemType
    ) {
      throw new TypeError("外部relation参照の項目種別が要求値と一致しません");
    }
    registerCacheResult(key, group.itemType, result);
    registerResult(key, result);
    if (result.status !== "public") {
      continue;
    }
    registerPublicResult(key, result);
    for (const occurrence of group.occurrences) {
      if (occurrence.kind !== "content") {
        continue;
      }
      const referencesByContentSource = verifiedBySourceItemNodeId.get(occurrence.sourceItemNodeId);
      assertNonNullable(referencesByContentSource, "外部relation参照のsourceがありません");
      const references = referencesByContentSource.get(occurrence.contentSourceId);
      assertNonNullable(references, "外部relation参照のcontent sourceがありません");
      references.push(occurrence.reference);
    }
  }

  return Object.freeze({
    knownItems: Object.freeze([...publicItemsByNodeId.values()]),
    resolvedItemsByNodeId,
    relationReferenceAliases,
    canonicalReferencesByReferenceKey,
    currentReferencesBySourceItemNodeId: new Map<
      GitHubNodeId,
      ReadonlyMap<SourceId, PublicCurrentRelationReferences>
    >(
      [...currentBySourceItemNodeId.entries()].map(([sourceItemNodeId, byContentSource]) => [
        sourceItemNodeId,
        new Map<SourceId, PublicCurrentRelationReferences>(
          [...byContentSource.entries()].map(([contentSourceId, references]) => [
            contentSourceId,
            normalizeCurrentRelationReferences(references),
          ]),
        ),
      ]),
    ),
    verifiedExternalReferencesBySourceItemNodeId: new Map(
      [...verifiedBySourceItemNodeId.entries()].map(([sourceItemNodeId, byContentSource]) => [
        sourceItemNodeId,
        new Map(
          [...byContentSource.entries()].map(([contentSourceId, references]) => [
            contentSourceId,
            Object.freeze(references),
          ]),
        ),
      ]),
    ),
    resultsByReferenceKey,
  });
}

function detailReferencesNode(detail: GitHubItemDetail, nodeId: GitHubNodeId): boolean {
  if (detail.timeline.some((event) => timelineRelatedNodeIds(event).includes(nodeId))) {
    return true;
  }
  if (detail.inboundCrossReferences.some((reference) => reference.sourceItem.nodeId === nodeId)) {
    return true;
  }
  if (detail.type === "issue") {
    if (
      detail.nativeDependencies.availability === "available" &&
      detail.nativeDependencies.relations.some((relation) => relation.relatedItem.nodeId === nodeId)
    ) {
      return true;
    }
    return (
      detail.nativeHierarchy.availability === "available" &&
      detail.nativeHierarchy.relations.some((relation) => relation.relatedItem.nodeId === nodeId)
    );
  }
  return detail.nativeClosingIssues.some((relation) => relation.relatedItem.nodeId === nodeId);
}

function relationReferenceRefreshTargets(
  aggregate: FreshRuntimeCollectionAggregate,
  error: RelationReferenceConflictError,
  allowlist: PublicRepositoryAllowlist,
): readonly RelationReferenceRefreshTarget[] {
  const nodeIds = new Set<GitHubNodeId>([error.existing.nodeId]);
  for (const detail of aggregate.details) {
    if (detailReferencesNode(detail, error.existing.nodeId)) {
      nodeIds.add(detail.nodeId);
    }
  }
  const enumeratedItemsByNodeId = new Map(
    aggregate.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const targets: RelationReferenceRefreshTarget[] = [];
  for (const nodeId of nodeIds) {
    const enumeratedItem = enumeratedItemsByNodeId.get(nodeId);
    if (enumeratedItem == null) {
      if (nodeId !== error.existing.nodeId) {
        throw new TypeError("関係参照競合の親詳細に対応する列挙項目がありません", { cause: error });
      }
      const repository = findRelationReferenceRepository(allowlist, error.existing);
      if (repository == null) {
        throw error;
      }
      targets.push(Object.freeze({ repository, expected: error.existing }));
      continue;
    }
    const repository = allowlist.repositories.find(
      (candidate) => candidate.id === enumeratedItem.repositoryId,
    );
    if (repository == null) {
      throw new TypeError("関係参照競合の親詳細repositoryを公開allowlistへ解決できません", {
        cause: error,
      });
    }
    targets.push(
      Object.freeze({
        repository,
        expected: createPublicRelationItem(enumeratedItem, repository),
      }),
    );
  }
  return Object.freeze(targets);
}

async function refreshRelationReferences(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  authentication: GitHubClient,
  targets: readonly RelationReferenceRefreshTarget[],
  error: RelationReferenceConflictError,
): Promise<readonly RelationReferenceRefreshCollection[]> {
  const targetsByRepositoryId = new Map<
    PublicRepositoryId,
    Readonly<{
      repository: PublicRepository;
      targets: RelationReferenceRefreshTarget[];
    }>
  >();
  for (const target of targets) {
    const current = targetsByRepositoryId.get(target.repository.id);
    if (current == null) {
      targetsByRepositoryId.set(target.repository.id, {
        repository: target.repository,
        targets: [target],
      });
    } else {
      current.targets.push(target);
    }
  }
  const refreshedCollections: RelationReferenceRefreshCollection[] = [];
  for (const { repository, targets: repositoryTargets } of targetsByRepositoryId.values()) {
    const items = await adapters.enumerateGitHubItemsByIdentifiers({
      allowlist: createPublicRepositoryAllowlist([repository]),
      identifiers: repositoryTargets.map((target) => target.expected.url),
      observedAt: invocation.startedAt,
      request: authentication.request,
      graphql: authentication.graphql,
    });
    if (items.length !== repositoryTargets.length) {
      throw new TypeError("関係参照競合の再取得結果件数が不正です", { cause: error });
    }
    const expectedByNodeId = new Map(
      repositoryTargets.map((target) => [target.expected.nodeId, target.expected]),
    );
    const refreshedByNodeId = new Map<GitHubNodeId, EnumeratedGitHubItem>();
    for (const item of items) {
      if (!expectedByNodeId.has(item.nodeId) || refreshedByNodeId.has(item.nodeId)) {
        throw new TypeError("関係参照競合の再取得結果が要求項目と一致しません", { cause: error });
      }
      refreshedByNodeId.set(item.nodeId, item);
    }
    const refreshedItems = repositoryTargets.map((target) => {
      const item = refreshedByNodeId.get(target.expected.nodeId);
      if (item == null) {
        throw new TypeError("関係参照競合の再取得結果が不足しています", { cause: error });
      }
      return validateRelationReferenceRefresh(repository, target.expected, item, error);
    });
    refreshedCollections.push(
      Object.freeze({
        repository,
        items: Object.freeze(refreshedItems),
      }),
    );
  }
  return Object.freeze(refreshedCollections);
}

async function refreshRelationReferenceRuntimeCollections(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  refreshedCollections: readonly RelationReferenceRefreshCollection[],
  error: RelationReferenceConflictError,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
): Promise<void> {
  for (const refreshed of refreshedCollections) {
    const current = freshCollectionsByRepositoryId.get(refreshed.repository.id);
    if (current == null) {
      throw new TypeError("関係参照競合の再取得対象repository収集結果がありません", {
        cause: error,
      });
    }
    const additions = await collectRepositoryItemObservationsWithVolatileMetadata(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      refreshed.repository,
      refreshed.items,
      new Set(refreshed.items.map((item) => item.nodeId)),
    );
    freshCollectionsByRepositoryId.set(
      refreshed.repository.id,
      mergeFreshRepositoryRuntimeCollection(
        refreshed.repository,
        invocation,
        current,
        refreshed.items,
        additions,
      ),
    );
  }
}

async function extractAllRelationCandidates(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  config: Config,
  allowlist: PublicRepositoryAllowlist,
  retryBudget: RelationReferenceRetryBudget,
  resolutionCache: ExternalRelationResolutionCache,
): Promise<ExtractedRelationCandidates> {
  for (;;) {
    const aggregate = aggregateFreshRepositoryCollections(
      allowlist,
      freshCollectionsByRepositoryId,
    );
    const internalRelationItems = aggregate.enumeratedItems.map((item) => ({
      item: createPublicRelationItem(item, allowlist.require(item.repositoryId)),
      repositoryId: item.repositoryId,
    }));
    const externalRelationResolution = await resolveExternalRelationReferences(
      adapters.resolveGitHubRelationReference,
      authentication,
      config.organization,
      allowlist,
      aggregate.analysisSources,
      resolutionCache,
      Object.freeze([]),
    );
    try {
      const knownItemsByNodeId = createRelationItemsByNodeId(
        internalRelationItems,
        externalRelationResolution.resolvedItemsByNodeId,
      );
      const extractedCandidates = extractRelationCandidatesOnce(
        config,
        [...knownItemsByNodeId.values()],
        externalRelationResolution.relationReferenceAliases,
        aggregate.details,
        aggregate.analysisSources,
      );
      const completedExternalRelationResolution = await resolveExternalRelationReferences(
        adapters.resolveGitHubRelationReference,
        authentication,
        config.organization,
        allowlist,
        aggregate.analysisSources,
        resolutionCache,
        collectExternalRelationCandidateOccurrences(
          aggregate.analysisSources,
          extractedCandidates.candidates,
          extractedCandidates.originProofs,
          config.organization,
          allowlist,
        ),
      );
      const resolvedItemsByNodeId = createRelationItemsByNodeId(
        internalRelationItems,
        completedExternalRelationResolution.resolvedItemsByNodeId,
      );
      return Object.freeze({
        candidates: normalizeRelationCandidates(
          extractedCandidates.candidates.map((candidate) =>
            currentExternalRelationCandidate(
              candidate,
              resolvedItemsByNodeId,
              config.organization,
              completedExternalRelationResolution.relationReferenceAliases,
            ),
          ),
        ),
        originProofs: extractedCandidates.originProofs,
        aggregate,
        externalRelationResolution: completedExternalRelationResolution,
      });
    } catch (error: unknown) {
      if (!(error instanceof RelationReferenceConflictError) || !error.isStateOnlyConflict) {
        throw error;
      }
      if (retryBudget.refreshes >= retryBudget.maxRefreshes) {
        throw error;
      }
      const targets = relationReferenceRefreshTargets(aggregate, error, allowlist);
      const retryNumber = retryBudget.refreshes + 1;
      await adapters.sleep(
        calculateRetryDelayMilliseconds(retryNumber, configuration.config.operations.retry),
      );
      retryBudget.refreshes = retryNumber;
      const refreshed = await refreshRelationReferences(
        adapters,
        invocation,
        authentication,
        targets,
        error,
      );
      await refreshRelationReferenceRuntimeCollections(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        refreshed,
        error,
        freshCollectionsByRepositoryId,
      );
    }
  }
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

function configuredTrackingStartAt(config: Config): TrackingStartAtState {
  return Object.freeze({
    status: "fixed",
    value: createUtcIsoDateTime(config.tracking.startAt),
    source: "configuration",
  });
}

function trackingSelectionStartAt(configuration: RuntimeConfiguration): UtcIsoDateTime {
  return configuredTrackingStartAt(configuration.config).value;
}

function pendingSnapshotTrackingStartAt(configuration: RuntimeConfiguration): TrackingStartAtState {
  return configuredTrackingStartAt(configuration.config);
}

function authorType(item: RuntimeObservedGitHubItem): "human" | "bot" | "unknown" {
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
  observedItems: readonly RuntimeObservedGitHubItem[],
  relationCandidates: readonly RelationCandidate[],
): RuntimeTrackingSelection {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const previousItemCachesByNodeId = new Map(
    loadedItemCacheDocuments(state).map((item) => [item.nodeId, item]),
  );
  const observedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const enumeratedItemsByNodeId = new Map(enumeratedItems.map((item) => [item.nodeId, item]));
  const isBot = createGitHubBotPredicate(configuration.config.actors.bots);
  let excludedCandidateCount = 0;
  const organizationCandidates: OrganizationTrackingCandidate[] = enumeratedItems.flatMap(
    (item): OrganizationTrackingCandidate[] => {
      const repository = findRepository(inventory, item.repositoryId);
      const fullName = repositoryFullName(repository);
      const observed = observedItemsByNodeId.get(item.nodeId);
      const activity =
        observed == null
          ? undefined
          : determineMeaningfulProgress({
              createdAt: observed.createdAt,
              evaluatedAt,
              events: observed.events,
              dependencyResolutions: [],
              naturalLanguageAssessments: [],
              minimumAiConfidence: configuration.config.ai.confidence.medium,
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
    startAt: trackingSelectionStartAt(configuration),
    evaluatedAt,
    candidates,
    connections: createTrackingConnections(relationCandidates),
    previouslyTrackedNodeIds: Object.freeze(
      [...previousItemCachesByNodeId.keys()].filter((nodeId) => {
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
    const previousItemCache = previousItemCachesByNodeId.get(item.nodeId);
    workByNodeId.set(
      item.nodeId,
      determineTrackedItemWork({
        state: item.state,
        analysisInputFingerprint: item.itemFingerprint,
        analysisRulesFingerprint: currentAnalysisRulesFingerprints[item.type],
        previousAiAnalysisStatus:
          previousItemCache == null ? "not_available" : previousItemCache.aiAnalysisStatus,
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

type FreshItemRelationBoundaryInput = Readonly<{
  sourceItemNodeId: GitHubNodeId;
  relationCandidates: readonly RelationCandidate[];
  relationMutations: readonly RelationMutationResult[];
}>;

function createItemRelationBoundaryInput(
  source: RuntimeItemAnalysisSource,
  relationCandidates: readonly RelationCandidate[],
): FreshItemRelationBoundaryInput {
  return Object.freeze({
    sourceItemNodeId: source.item.nodeId,
    relationCandidates: candidatesForNode(source.item.nodeId, relationCandidates),
    relationMutations: relationMutationResultsForSource(source),
  });
}

function sanitizeAnalysisSourceForPublicBoundary(
  source: RuntimeItemAnalysisSource,
  relationCandidates: readonly RelationCandidate[],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  currentReferencesBySourceItemNodeId: ReadonlyMap<
    GitHubNodeId,
    ReadonlyMap<SourceId, PublicCurrentRelationReferences>
  >,
  verifiedExternalReferencesBySourceItemNodeId: ReadonlyMap<
    GitHubNodeId,
    ReadonlyMap<SourceId, readonly RelationTextReference[]>
  >,
  canonicalReferencesByReferenceKey: ReadonlyMap<string, RelationTextReference>,
  currentBoundaryUnknownContentSourceIds: ReadonlySet<SourceId>,
): Readonly<{
  source: RuntimeItemAnalysisSource;
  unknownContentSourceCount: number;
  requiresRelationPublicBoundaryRevalidation: boolean;
}> {
  const verifiedExternalReferencesByContentSource =
    verifiedExternalReferencesBySourceItemNodeId.get(source.item.nodeId);
  assertNonNullable(
    verifiedExternalReferencesByContentSource,
    "relation mutationのsource別公開参照証明がありません",
  );
  const currentReferencesByContentSource = currentReferencesBySourceItemNodeId.get(
    source.item.nodeId,
  );
  assertNonNullable(
    currentReferencesByContentSource,
    "relation mutationのsource別現在参照がありません",
  );
  const sanitized = sanitizeRelationMutationsForPublicBoundary({
    sourceItemNodeId: source.item.nodeId,
    organization,
    allowlist,
    currentReferencesByContentSource,
    currentBoundaryUnknownContentSourceIds,
    verifiedExternalReferencesByContentSource,
    canonicalReferencesByReferenceKey,
    relationMutations: relationMutationResultsForSource(source),
  });
  if (source.kind === "fresh") {
    return Object.freeze({
      source: Object.freeze({
        ...source,
        relationMutations: sanitized.relationMutations,
      }),
      unknownContentSourceCount: sanitized.unknownContentSourceCount,
      requiresRelationPublicBoundaryRevalidation: currentBoundaryUnknownContentSourceIds.size > 0,
    });
  }
  const document = replaceGitHubItemCacheRelationData(
    source.document,
    candidatesForNode(source.item.nodeId, relationCandidates),
    sanitized.relationMutations,
  );
  return Object.freeze({
    source: Object.freeze({
      ...source,
      document,
      analysis: Object.freeze({
        ...source.analysis,
        relationCandidates: candidatesForNode(source.item.nodeId, relationCandidates),
        relationMutations: sanitized.relationMutations,
      }),
    }),
    unknownContentSourceCount: sanitized.unknownContentSourceCount,
    requiresRelationPublicBoundaryRevalidation: false,
  });
}

function cachedRelationCandidatesForCurrentCandidate(
  source: RuntimeItemAnalysisSource,
  candidate: RelationCandidate,
): readonly RelationCandidate[] {
  if (source.kind !== "cached") {
    return Object.freeze([]);
  }
  const matches = source.analysis.relationCandidates.filter(
    (originalCandidate) =>
      originalCandidate.provenance === candidate.provenance &&
      originalCandidate.sourceIds.some((sourceId) => candidate.sourceIds.includes(sourceId)),
  );
  if (
    matches.some((originalCandidate) => originalCandidate.relation.type !== candidate.relation.type)
  ) {
    throw new TypeError("cached relation候補の元relation種別が一致しません");
  }
  return Object.freeze(matches);
}

function isExactAllowlistedRelationReference(
  reference: RelationTextReference,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): boolean {
  return (
    reference.repositoryOwner.toLowerCase() === organization.toLowerCase() &&
    allowlist.repositories.some(
      (repository) =>
        repository.owner.toLowerCase() === reference.repositoryOwner.toLowerCase() &&
        repository.name.toLowerCase() === reference.repositoryName.toLowerCase(),
    )
  );
}

function isExactAllowlistedInternalOriginProof(
  node: RelationCandidateNode,
  proof: RelationCandidateOriginProof,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): boolean {
  return (
    node.scope === "organization" &&
    isExactAllowlistedRelationReference(proof.reference, organization, allowlist) &&
    node.nodeId === proof.stableNodeId &&
    node.kind === proof.itemType &&
    node.number === proof.number &&
    node.repositoryOwner.toLowerCase() === proof.reference.repositoryOwner.toLowerCase() &&
    node.repositoryName.toLowerCase() === proof.reference.repositoryName.toLowerCase()
  );
}

const CONTENT_RELATION_PROVENANCES = new Set<RelationCandidate["provenance"]>([
  "explicit_text",
  "closing_keyword",
  "checklist",
]);

type CurrentContentBoundaryUnknownSources = ReadonlyMap<GitHubNodeId, ReadonlySet<SourceId>>;

function freshContentSourceIds(source: RuntimeItemAnalysisSource): ReadonlySet<SourceId> {
  if (source.kind !== "fresh") {
    return new Set();
  }
  return new Set([
    source.detail.bodySourceId,
    ...source.detail.comments.map((comment) => comment.sourceId),
  ]);
}

function createBoundaryViolation(
  sourceItemNodeId: GitHubNodeId,
  violationKind: "cache_relation_candidate" | "cache_relation_mutation",
): GitHubPublicBoundaryViolationError {
  return new GitHubPublicBoundaryViolationError({
    scope: "cache_item_relation",
    sourceItemNodeId,
    violationKind,
    violationCount: 1,
  });
}

function collectCurrentContentBoundaryUnknownSources(
  analysisSources: readonly RuntimeItemAnalysisSource[],
  relationCandidates: readonly RelationCandidate[],
  resolution: ExternalRelationResolution,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): CurrentContentBoundaryUnknownSources {
  const unknownSourcesByNodeId = new Map<GitHubNodeId, Set<SourceId>>();
  const unverifiedReferenceKeys = new Set<string>();
  for (const source of analysisSources) {
    const currentReferencesByContentSource = resolution.currentReferencesBySourceItemNodeId.get(
      source.item.nodeId,
    );
    assertNonNullable(
      currentReferencesByContentSource,
      "relation mutationのsource別現在参照がありません",
    );
    const contentSourceIds = freshContentSourceIds(source);
    for (const [contentSourceId, current] of currentReferencesByContentSource) {
      if (current.status !== "available") {
        continue;
      }
      const unknownReferenceKeys = new Set<string>();
      for (const reference of current.references) {
        if (isExactAllowlistedRelationReference(reference, organization, allowlist)) {
          continue;
        }
        const key = createRelationMutationReferenceKey(reference);
        const result = resolution.resultsByReferenceKey.get(key);
        if (result == null) {
          throw new TypeError("現在の外部relation参照の公開検証結果がありません");
        }
        if (result.status !== "public") {
          unknownReferenceKeys.add(key);
          unverifiedReferenceKeys.add(key);
        }
      }
      if (unknownReferenceKeys.size === 0) {
        continue;
      }
      if (source.kind !== "fresh" || !contentSourceIds.has(contentSourceId)) {
        throw createBoundaryViolation(source.item.nodeId, "cache_relation_mutation");
      }
      unknownSourcesByNodeId.set(
        source.item.nodeId,
        new Set([...(unknownSourcesByNodeId.get(source.item.nodeId) ?? []), contentSourceId]),
      );
    }
  }

  for (const source of analysisSources) {
    const unknownSources = unknownSourcesByNodeId.get(source.item.nodeId);
    for (const candidate of candidatesForNode(source.item.nodeId, relationCandidates)) {
      for (const node of relationNodes(candidate.relation)) {
        const key = createRelationMutationReferenceKey(createRelationTextReference(node));
        if (!unverifiedReferenceKeys.has(key)) {
          continue;
        }
        if (
          source.kind !== "fresh" ||
          !CONTENT_RELATION_PROVENANCES.has(candidate.provenance) ||
          unknownSources == null ||
          candidate.sourceIds.some((sourceId) => !freshContentSourceIds(source).has(sourceId))
        ) {
          throw createBoundaryViolation(source.item.nodeId, "cache_relation_candidate");
        }
      }
    }
  }
  return new Map(
    [...unknownSourcesByNodeId.entries()].map(([nodeId, sourceIds]) => [nodeId, sourceIds]),
  );
}

function maskCurrentContentBoundaryUnknownSources(
  currentReferencesBySourceItemNodeId: ReadonlyMap<
    GitHubNodeId,
    ReadonlyMap<SourceId, CurrentRelationReferences>
  >,
  unknownSourcesByNodeId: CurrentContentBoundaryUnknownSources,
): ReadonlyMap<GitHubNodeId, ReadonlyMap<SourceId, CurrentRelationReferences>> {
  return new Map(
    [...currentReferencesBySourceItemNodeId.entries()].map(
      ([sourceItemNodeId, referencesByContentSource]) => {
        const unknownSourceIds = unknownSourcesByNodeId.get(sourceItemNodeId);
        return [
          sourceItemNodeId,
          new Map(
            [...referencesByContentSource.entries()].map(([contentSourceId, references]) => [
              contentSourceId,
              unknownSourceIds?.has(contentSourceId)
                ? Object.freeze({ status: "unknown" } satisfies CurrentRelationReferences)
                : references,
            ]),
          ),
        ];
      },
    ),
  );
}

function sanitizeRelationCandidatesForCurrentContentBoundary(
  relationCandidates: readonly RelationCandidate[],
  unknownSourcesByNodeId: CurrentContentBoundaryUnknownSources,
): readonly RelationCandidate[] {
  const unknownSourceIds = new Set<SourceId>();
  for (const sourceIds of unknownSourcesByNodeId.values()) {
    for (const sourceId of sourceIds) {
      unknownSourceIds.add(sourceId);
    }
  }
  const sanitizedCandidates: RelationCandidate[] = [];
  for (const candidate of relationCandidates) {
    const unknownSourceCount = candidate.sourceIds.filter((sourceId) =>
      unknownSourceIds.has(sourceId),
    ).length;
    if (unknownSourceCount === 0) {
      sanitizedCandidates.push(candidate);
      continue;
    }
    if (unknownSourceCount === candidate.sourceIds.length) {
      continue;
    }
    const sourceItemNodeIdEntry = [...unknownSourcesByNodeId.entries()].find(([, sourceIds]) =>
      candidate.sourceIds.some((sourceId) => sourceIds.has(sourceId)),
    );
    assertNonNullable(sourceItemNodeIdEntry, "関係候補のunknown source itemがありません");
    throw createBoundaryViolation(sourceItemNodeIdEntry[0], "cache_relation_candidate");
  }
  return Object.freeze(sanitizedCandidates);
}

function assertRelationCandidateNodeMetadata(
  node: RelationCandidateNode,
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
  organization: string,
): void {
  if (node.scope === "external_public") {
    assertExternalRelationCandidateMetadata(node, item, true);
    return;
  }
  if (
    node.nodeId !== item.nodeId ||
    node.kind !== item.type ||
    node.number !== item.number ||
    node.state !== item.state ||
    item.repositoryOwner.toLowerCase() !== organization.toLowerCase()
  ) {
    throw new TypeError("relation候補と公開metadataが一致しません");
  }
}

function originProofsForCandidateEndpoint(
  sourceItemNodeId: GitHubNodeId,
  candidate: RelationCandidate,
  endpoint: 0 | 1,
  originProofs: readonly RelationCandidateOriginProof[],
): readonly RelationCandidateOriginProof[] {
  return Object.freeze(
    originProofs.filter(
      (proof) =>
        proof.sourceItemNodeId === sourceItemNodeId &&
        proof.provenance === candidate.provenance &&
        proof.relationType === candidate.relation.type &&
        proof.endpoint === endpoint &&
        candidate.sourceIds.includes(proof.sourceId),
    ),
  );
}

function assertRelationCandidateMatchesOriginProof(
  node: RelationCandidateNode,
  proof: RelationCandidateOriginProof,
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
  organization: string,
): void {
  if (
    item.nodeId !== proof.stableNodeId ||
    item.type !== proof.itemType ||
    item.number !== proof.number
  ) {
    throw new TypeError("relation候補のorigin proofと公開metadataが一致しません");
  }
  if (node.scope === "external_public") {
    if (
      node.githubNodeId !== item.nodeId ||
      node.githubItemType !== item.type ||
      node.number !== item.number ||
      node.repositoryOwner.toLowerCase() !== item.repositoryOwner.toLowerCase() ||
      node.repositoryName.toLowerCase() !== item.repositoryName.toLowerCase() ||
      node.url !== item.url
    ) {
      throw new TypeError("relation候補のorigin proofとcanonical nodeが一致しません");
    }
    assertExternalRelationCandidateMetadata(node, createPublicExternalRelationItem(item), true);
    return;
  }
  if (
    item.repositoryOwner.toLowerCase() !== organization.toLowerCase() ||
    node.nodeId !== item.nodeId ||
    node.kind !== item.type ||
    node.number !== item.number ||
    node.repositoryOwner.toLowerCase() !== item.repositoryOwner.toLowerCase() ||
    node.repositoryName.toLowerCase() !== item.repositoryName.toLowerCase() ||
    node.url !== item.url ||
    node.state !== item.state
  ) {
    throw new TypeError("relation候補のorigin proofとcanonical nodeが一致しません");
  }
}

function assertRelationCandidateMatchesInternalOriginProof(
  node: RelationCandidateNode,
  proof: RelationCandidateOriginProof,
  organization: string,
): void {
  if (
    node.scope !== "organization" ||
    node.nodeId !== proof.stableNodeId ||
    node.kind !== proof.itemType ||
    node.number !== proof.number ||
    node.repositoryOwner.toLowerCase() !== organization.toLowerCase() ||
    node.repositoryOwner.toLowerCase() !== proof.reference.repositoryOwner.toLowerCase() ||
    node.repositoryName.toLowerCase() !== proof.reference.repositoryName.toLowerCase()
  ) {
    throw new TypeError("relation候補の内部origin proofが一致しません");
  }
}

function assertFreshRelationCandidateOriginResolution(
  relationCandidates: readonly RelationCandidate[],
  originProofs: readonly RelationCandidateOriginProof[],
  resultsByReferenceKey: ReadonlyMap<string, GitHubRelationReferenceResult>,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): void {
  for (const proof of originProofs) {
    const candidate = candidatesForNode(proof.sourceItemNodeId, relationCandidates).find(
      (current) =>
        current.provenance === proof.provenance &&
        current.relation.type === proof.relationType &&
        current.sourceIds.includes(proof.sourceId),
    );
    if (candidate == null) {
      throw new TypeError("fresh relation候補のorigin proof対象がありません");
    }
    const node = relationNodes(candidate.relation)[proof.endpoint];
    assertNonNullable(node, "fresh relation候補のorigin endpointがありません");
    if (isExactAllowlistedInternalOriginProof(node, proof, organization, allowlist)) {
      continue;
    }
    const result = resultsByReferenceKey.get(createRelationMutationReferenceKey(proof.reference));
    if (result == null) {
      throw new TypeError("fresh relation候補のorigin proofを解決できません");
    }
    if (result.status !== "public") {
      if (node.scope === "organization") {
        throw new TypeError("fresh relation候補のorigin proofを解決できません");
      }
      continue;
    }
    assertRelationCandidateMatchesOriginProof(node, proof, result.item, organization);
  }
}

function assertExternalRelationCandidatesPublicBoundary(
  source: RuntimeItemAnalysisSource,
  originalSource: RuntimeItemAnalysisSource,
  relationCandidates: readonly RelationCandidate[],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  resultsByReferenceKey: ReadonlyMap<string, GitHubRelationReferenceResult>,
  originProofs: readonly RelationCandidateOriginProof[],
): void {
  let violationCount = 0;
  for (const candidate of candidatesForNode(source.item.nodeId, relationCandidates)) {
    const nodes = relationNodes(candidate.relation);
    const originalCandidates = cachedRelationCandidatesForCurrentCandidate(
      originalSource,
      candidate,
    );
    for (const [index, node] of nodes.entries()) {
      const typedEndpoint: 0 | 1 = index === 0 ? 0 : 1;
      const currentOriginProofs = originProofsForCandidateEndpoint(
        source.item.nodeId,
        candidate,
        typedEndpoint,
        originProofs,
      );
      if (
        originalSource.kind === "fresh" &&
        (candidate.provenance === "native" || candidate.provenance === "cross_reference") &&
        currentOriginProofs.length > 0
      ) {
        let candidateViolation = false;
        for (const proof of currentOriginProofs) {
          if (isExactAllowlistedRelationReference(proof.reference, organization, allowlist)) {
            assertRelationCandidateMatchesInternalOriginProof(node, proof, organization);
            continue;
          }
          const result = resultsByReferenceKey.get(
            createRelationMutationReferenceKey(proof.reference),
          );
          if (result?.status !== "public") {
            candidateViolation = true;
            continue;
          }
          assertRelationCandidateMatchesOriginProof(node, proof, result.item, organization);
        }
        if (candidateViolation) {
          violationCount += 1;
        }
        continue;
      }
      if (
        originalSource.kind === "fresh" &&
        (candidate.provenance === "native" || candidate.provenance === "cross_reference") &&
        currentOriginProofs.length === 0 &&
        node.scope === "external_public"
      ) {
        throw new TypeError("fresh relation候補のorigin proofがありません");
      }
      if (originalCandidates.length === 0 && node.scope !== "external_public") {
        continue;
      }
      const referencesByKey = new Map<string, RelationTextReference>();
      for (const originalCandidate of originalCandidates) {
        const originalNode = relationNodes(originalCandidate.relation)[index];
        assertNonNullable(originalNode, "cached relation候補の元nodeがありません");
        const originalReference = createRelationTextReference(originalNode);
        referencesByKey.set(
          createRelationMutationReferenceKey(originalReference),
          originalReference,
        );
      }
      if (originalCandidates.length === 0 && originalSource.kind !== "cached") {
        const reference = createRelationTextReference(node);
        referencesByKey.set(createRelationMutationReferenceKey(reference), reference);
      }
      if (referencesByKey.size === 0) {
        throw new TypeError("cached relation候補の元nodeがありません");
      }
      const references = Object.freeze([...referencesByKey.values()]);
      let candidateViolation = false;
      for (const originalReference of references) {
        if (isExactAllowlistedRelationReference(originalReference, organization, allowlist)) {
          continue;
        }
        const result = resultsByReferenceKey.get(
          createRelationMutationReferenceKey(originalReference),
        );
        if (result?.status !== "public") {
          candidateViolation = true;
          continue;
        }
        assertRelationCandidateNodeMetadata(node, result.item, organization);
      }
      if (candidateViolation) {
        violationCount += 1;
      }
    }
  }
  if (violationCount > 0) {
    throw new GitHubPublicBoundaryViolationError({
      scope: "cache_item_relation",
      sourceItemNodeId: source.item.nodeId,
      violationKind: "cache_relation_candidate",
      violationCount,
    });
  }
}

function assertItemRelationPublicBoundary(
  analysisSources: readonly RuntimeItemAnalysisSource[],
  originalAnalysisSources: readonly RuntimeItemAnalysisSource[],
  relationCandidates: readonly RelationCandidate[],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  resultsByReferenceKey: ReadonlyMap<string, GitHubRelationReferenceResult>,
  originProofs: readonly RelationCandidateOriginProof[],
): void {
  const originalSourcesByNodeId = new Map(
    originalAnalysisSources.map((source) => [source.item.nodeId, source]),
  );
  for (const source of analysisSources) {
    const originalSource = originalSourcesByNodeId.get(source.item.nodeId);
    assertNonNullable(originalSource, "relation境界検証対象の元sourceがありません");
    assertExternalRelationCandidatesPublicBoundary(
      source,
      originalSource,
      relationCandidates,
      organization,
      allowlist,
      resultsByReferenceKey,
      originProofs,
    );
    assertCacheItemRelationPublicBoundary(
      allowlist,
      createItemRelationBoundaryInput(source, relationCandidates),
    );
  }
}

function createNativeBlockers(
  item: RuntimeObservedGitHubItem,
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
  item: RuntimeObservedGitHubItem,
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

function issueRequestCandidatesForSource(
  source: RuntimeItemAnalysisSource,
): readonly IssueExplicitRequestCandidate[] {
  if (source.item.type !== "issue") {
    throw new TypeError(`Issue解析sourceではありません。対象: ${source.item.nodeId}`);
  }
  if (source.kind === "cached") {
    return source.analysis.analysisFacts.explicitRequestCandidates;
  }
  if (source.detail.type !== "issue") {
    throw new TypeError(`IssueにPull Request詳細が指定されています。対象: ${source.item.nodeId}`);
  }
  return createIssueRequestCandidates(source.item, source.detail);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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
    [...grouped.entries()]
      .sort(([leftKey], [rightKey]) => compareStrings(leftKey, rightKey))
      .map(([, candidate]) => {
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
  for (const source of collection.analysisSources) {
    const item = source.item;
    if (!collection.analysisNodeIds.has(item.nodeId)) {
      continue;
    }
    const repository = findRepository(inventory, item.repositoryId);
    const maintainers = resolveRepositoryMaintainers(
      configuration.config.maintainers,
      repositoryFullName(repository),
    );
    const notificationClass = collection.trackingNotificationClassByNodeId.get(item.nodeId);
    assertNonNullable(notificationClass, `追跡項目の通知分類がありません。対象: ${item.nodeId}`);
    const relationCandidates = candidatesForNode(item.nodeId, collection.relationCandidates);
    const blockers = createNativeBlockers(item, relationCandidates);
    if (item.type === "issue") {
      const decision = determineIssueState({
        issue: item,
        blockers,
        explicitRequestCandidates: issueRequestCandidatesForSource(source),
        explicitRequestAssessment: {
          status: "not_assessed",
        },
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: collection.evaluatedAt,
      });
      items.push(
        Object.freeze({
          item,
          source,
          decision,
          notificationClass,
          relationCandidates,
        }),
      );
      continue;
    }
    if (source.kind === "fresh" && source.detail.type !== "pull_request") {
      throw new TypeError(`Pull RequestにIssue詳細が指定されています。対象: ${item.nodeId}`);
    }
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
        source,
        decision,
        notificationClass,
        relationCandidates,
      }),
    );
  }
  return Object.freeze({
    items: Object.freeze(items),
    state,
    inventory,
  });
}

function codexActorType(item: RuntimeObservedGitHubItem): "human" | "bot" | "system" {
  const type = authorType(item);
  return type === "unknown" ? "system" : type;
}

function codexAuthorCandidateId(item: RuntimeObservedGitHubItem): string | undefined {
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
    throw new TypeError(`同じCodex source IDに異なる発生時刻があります。対象: ${sourceId}`);
  }
  sourceOccurredAtById.set(sourceId, occurredAt);
}

function createCodexSourceOccurredAtById(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  const currentContentSourceIds = new Set<SourceId>([
    detail.bodySourceId,
    ...detail.comments.map((comment) => comment.sourceId),
    ...(detail.type === "pull_request"
      ? [
          ...detail.reviews.map((review) => review.sourceId),
          ...detail.reviewThreads.flatMap((thread) =>
            thread.comments.map((comment) => comment.sourceId),
          ),
        ]
      : []),
  ]);
  for (const event of item.events) {
    if (currentContentSourceIds.has(event.sourceId)) {
      continue;
    }
    setEarliestRelationSourceOccurredAt(sourceOccurredAtById, event.sourceId, event.occurredAt);
  }
  addCodexSourceOccurredAt(sourceOccurredAtById, item.sourceId, item.createdAt);
  addCodexSourceOccurredAt(
    sourceOccurredAtById,
    detail.bodySourceId,
    detail.lastEditedAt ?? item.createdAt,
  );
  for (const comment of detail.comments) {
    addCodexSourceOccurredAt(
      sourceOccurredAtById,
      comment.sourceId,
      comment.lastEditedAt ?? comment.createdAt,
    );
  }
  if (detail.type !== "pull_request") {
    return sourceOccurredAtById;
  }
  for (const review of detail.reviews) {
    addCodexSourceOccurredAt(sourceOccurredAtById, review.sourceId, review.submittedAt);
  }
  for (const thread of detail.reviewThreads) {
    for (const comment of thread.comments) {
      addCodexSourceOccurredAt(
        sourceOccurredAtById,
        comment.sourceId,
        comment.lastEditedAt ?? comment.createdAt,
      );
    }
  }
  if (detail.mergeState.checks.status !== "configured") {
    return sourceOccurredAtById;
  }
  const headOccurredAt = resolvePullRequestCommitOccurredAt(detail.headCommit, item.createdAt);
  const checkOccurredAts = detail.mergeState.checks.contexts.map((context) => {
    const occurredAt = resolvePullRequestCheckContextOccurredAt(context, headOccurredAt);
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
  return sourceOccurredAtById;
}

function analysisSourceOccurredAtById(
  analysis: DeterministicItemAnalysis,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  if (analysis.source.kind === "fresh") {
    return createCodexSourceOccurredAtById(analysis.source.item, analysis.source.detail);
  }
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const source of analysis.source.analysis.analysisFacts.codexValidationContext.sources) {
    const parts = parseSourceId(source.id);
    sourceOccurredAtById.set(buildSourceId(parts.kind, parts.originalId), source.createdAt);
  }
  return sourceOccurredAtById;
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
  evaluatedAt: UtcIsoDateTime,
  analysis: DeterministicItemAnalysis,
): CodexAnalysisInput {
  if (analysis.source.kind !== "fresh") {
    throw new TypeError(
      `cached解析sourceからCodex入力は生成できません。対象: ${analysis.item.nodeId}`,
    );
  }
  const item = analysis.source.item;
  const detail = analysis.source.detail;
  const relationCandidates = deduplicateByStableId(
    selectRelationAssessmentCandidates(item.nodeId, analysis.relationCandidates),
    (candidate) => candidate.id,
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(detail);
  const nativeRelationSignals = createNativeRelationSignals(item.nodeId, relationCandidates);
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
  const authorCandidateId = codexAuthorCandidateId(item);
  if (authorCandidateId != null) {
    waitingOnCandidates.set(
      authorCandidateId,
      Object.freeze({
        id: authorCandidateId,
        kind: "user",
        sourceIds: Object.freeze([item.sourceId] satisfies [SourceId]),
      }),
    );
  }
  for (const candidate of mentionedCandidates) {
    waitingOnCandidates.set(candidate.id, candidate);
  }
  const sourceOccurredAtById = createCodexSourceOccurredAtById(item, detail);
  const sourceRecords = new Map<string, unknown>();
  sourceRecords.set(
    item.sourceId,
    Object.freeze({
      id: item.sourceId,
      kind: "item",
      actorType: codexActorType(item),
      createdAt: item.createdAt,
    }),
  );
  for (const event of item.events) {
    sourceRecords.set(
      event.sourceId,
      Object.freeze({
        id: event.sourceId,
        kind: event.kind,
        actorType: event.actor.type,
        createdAt: event.occurredAt,
      }),
    );
  }
  addMirroredNativeBlockerSourceRecords(sourceRecords, item, relationCandidates);
  sourceRecords.set(
    detail.bodySourceId,
    Object.freeze({
      id: detail.bodySourceId,
      kind: "body",
      actorType: codexActorType(item),
      createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, detail.bodySourceId),
      content: detail.body,
    }),
  );
  for (const comment of detail.comments) {
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    sourceRecords.set(
      comment.sourceId,
      Object.freeze({
        id: comment.sourceId,
        kind: "comment",
        actorType: event?.actor.type ?? "system",
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, comment.sourceId),
        content: comment.body,
      }),
    );
  }
  if (detail.type === "pull_request") {
    if (item.type !== "pull_request") {
      throw new TypeError("Pull RequestのCodex入力にIssueの観測値が指定されています");
    }
    for (const thread of detail.reviewThreads) {
      for (const comment of thread.comments) {
        const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
        sourceRecords.set(
          comment.sourceId,
          Object.freeze({
            id: comment.sourceId,
            kind: "comment",
            actorType: event?.actor.type ?? "system",
            createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, comment.sourceId),
            content: comment.body,
          }),
        );
      }
    }
    for (const review of detail.reviews) {
      const event = item.events.find((candidate) => candidate.sourceId === review.sourceId);
      sourceRecords.set(
        review.sourceId,
        Object.freeze({
          id: review.sourceId,
          kind: "review",
          actorType: event?.actor.type ?? "system",
          createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, review.sourceId),
          content: review.body,
        }),
      );
    }
    for (const request of detail.reviewRequests.current) {
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
    if (item.mergeState.autoMerge.status === "enabled") {
      const autoMerge = item.mergeState.autoMerge;
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
  if (detail.type === "pull_request" && detail.mergeState.checks.status === "configured") {
    const checks = detail.mergeState.checks;
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
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: evaluatedAt,
    item: {
      nodeId: item.nodeId,
      url: item.url,
      type: item.type,
      title: item.title,
      ...(authorCandidateId == null ? {} : { authorCandidateId }),
      ...(item.type === "pull_request"
        ? {
            headSha: item.headSha,
          }
        : {}),
    },
    candidates: {
      waitingOn: [...waitingOnCandidates.values()],
      relations: relationCandidates.map((candidate) => ({
        id: candidate.id,
        targetUrl: relationTargetUrl(item.nodeId, candidate),
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
        detail.type === "pull_request" &&
        detail.mergeState.checks.status === "configured" &&
        (detail.mergeState.checks.combinedState === "failure" ||
          detail.mergeState.checks.combinedState === "error")
          ? detail.mergeState.checks
          : null,
      uncertainties: analysis.decision.uncertainties,
    },
    priorAnalysis: null,
  });
}

function freshRepositoryIds(collection: CollectedItems): ReadonlySet<GitHubRepositoryId> {
  return new Set(
    collection.repositoryResults.flatMap((result) =>
      result.freshness === "fresh" ? [result.repository.id] : [],
    ),
  );
}

function createCurrentPlanningGraphAnalysis(
  configuration: RuntimeConfiguration,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
): AnalyzeGraphResult {
  const freshRepositoryIdSet = freshRepositoryIds(collection);
  const items = deterministicAnalysis.items.filter((analysis) =>
    freshRepositoryIdSet.has(analysis.item.repositoryId),
  );
  const nodeIds = new Set<GraphNodeId>(items.map((analysis) => analysis.item.nodeId));
  const candidates = collection.relationCandidates.filter((candidate) =>
    relationNodes(candidate.relation).every(
      (node) => node.scope === "organization" && nodeIds.has(node.nodeId),
    ),
  );
  const reconciled = reconcileGraph({
    previousGraph: {
      edges: [],
      historyEvents: [],
    },
    candidates,
    assessments: [],
    sourceOccurredAtById: createEarliestRelationSourceOccurredAtById(collection.observedItems),
    minimumInferredConfidence: configuration.config.ai.confidence.medium,
    reconciledAt: collection.evaluatedAt,
  });
  return analyzeGraph({
    current: {
      nodes: items.map((analysis) => ({
        kind: analysis.item.type,
        nodeId: analysis.item.nodeId,
        repositoryId: analysis.item.repositoryId,
        state: analysis.item.state,
        directNotification: "eligible",
      })),
      edges: reconciled.edges,
    },
    previous: {
      availability: "unavailable",
    },
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
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
}> {
  const inputByNodeId = new Map<GitHubNodeId, CodexAnalysisInput>();
  const failures: AiAnalysisRunFailure[] = [];
  const currentPlanningGraphAnalysis = createCurrentPlanningGraphAnalysis(
    configuration,
    collection,
    deterministicAnalysis,
  );
  const currentImpactByNodeId = new Map(
    currentPlanningGraphAnalysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
  );
  const loadedCandidatesByNodeId = new Map(
    loadedItemCacheDocuments(state).map((document) => [
      document.nodeId,
      new Set(
        document.relationCandidates
          .filter(
            (candidate) =>
              candidate.relation.type === "blocks" &&
              candidate.relation.blocked.nodeId === document.nodeId,
          )
          .map((candidate) => candidate.id),
      ),
    ]),
  );
  const previousAiFingerprintByNodeId = new Map<
    GitHubNodeId,
    SnapshotCollectionItem["aiAnalysisFingerprint"]
  >(
    loadedItemCacheDocuments(state).flatMap((item) => {
      if (item.aiCacheReference.status !== "available") {
        return [];
      }
      const fingerprint: SnapshotCollectionItem["aiAnalysisFingerprint"] = Object.freeze({
        status: "available",
        fingerprint: Object.freeze({
          sourceHash: item.aiCacheReference.sourceHash,
          inputHash: item.aiCacheReference.inputHash,
          graphNeighborhoodHash: item.aiCacheReference.graphNeighborhoodHash,
          identityHash: item.aiCacheReference.identityHash,
        }),
      });
      const pair: readonly [GitHubNodeId, SnapshotCollectionItem["aiAnalysisFingerprint"]] = [
        item.nodeId,
        fingerprint,
      ];
      return [pair];
    }),
  );
  const previousAiAnalysisStatusByNodeId = new Map<GitHubNodeId, TrackedItemAiAnalysis["status"]>(
    loadedItemCacheDocuments(state).map((item) => [item.nodeId, item.aiAnalysisStatus]),
  );
  const candidates: PreparedAiAnalysisCandidate[] = [];
  for (const analysis of deterministicAnalysis.items) {
    if (analysis.source.kind === "cached") {
      continue;
    }
    let input: CodexAnalysisInput;
    try {
      input = createCodexInput(collection.evaluatedAt, analysis);
    } catch (error: unknown) {
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
    const relationAssessmentCandidates = selectRelationAssessmentCandidates(
      analysis.item.nodeId,
      analysis.relationCandidates,
    );
    const loadedIncomingBlockers =
      loadedCandidatesByNodeId.get(analysis.item.nodeId) ?? new Set<string>();
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
      loadedIncomingBlockers.size !== currentPotentialBlockers.size ||
      [...loadedIncomingBlockers].some((id) => !currentPotentialBlockers.has(id));
    const currentImpact = currentImpactByNodeId.get(analysis.item.nodeId);
    const estimatedCost = estimateAiInputCost(
      `${serializeCanonicalJson(input)}\n`,
      configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
    );
    candidates.push(
      prepareAiAnalysisCandidate(
        Object.freeze({
          id: analysis.item.nodeId,
          repository: cacheRepositoryIdentity(
            findRepository(deterministicAnalysis.inventory, analysis.item.repositoryId),
          ),
          deterministicResolution:
            analysis.decision.determination === "determined" &&
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
              openNodeCount: currentImpact?.openNodeCount ?? 0,
              repositoryCount: currentImpact?.repositoryCount ?? 0,
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

function exactCachedAiByNodeId(
  deterministicAnalysis: DeterministicAnalysis,
): ReadonlyMap<GitHubNodeId, ExactCachedAiAnalysis> {
  return new Map(
    deterministicAnalysis.items.flatMap((analysis) => {
      if (analysis.source.kind !== "cached" || analysis.source.exactAi == null) {
        return [];
      }
      return [[analysis.item.nodeId, analysis.source.exactAi]];
    }),
  );
}

type PreparedImportanceCaches = Readonly<{
  latestImportanceByNodeId: ReadonlyMap<GitHubNodeId, AiLatestImportanceCacheDocument>;
  fallbackImportanceByNodeId: ReadonlyMap<
    GitHubNodeId,
    Extract<NaturalLanguageImportanceAssessmentState, { status: "available" }>
  >;
  rejectedAiCacheKeys: ReadonlySet<AiCacheEntry["cacheKey"]>;
  diagnostics: readonly string[];
}>;

function importanceCacheState(
  document: AiLatestImportanceCacheDocument | undefined,
): ImportanceCacheState {
  return document == null
    ? Object.freeze({ status: "not_available" })
    : Object.freeze({ status: "available", document });
}

function runtimeImportanceCacheContext(
  inventory: RepositoryInventory,
  evaluatedAt: UtcIsoDateTime,
  nodeId: GitHubNodeId,
  repository: PublicRepository,
  aiCacheEntries: readonly ImportanceCacheEntry[],
): ImportanceCacheContext {
  return Object.freeze({
    nodeId,
    repository: cacheRepositoryIdentity(repository),
    repositoryAllowlist: Object.freeze(
      inventory.allowlist.repositories.map(cacheRepositoryIdentity),
    ),
    evaluatedAt,
    aiCacheEntries,
  });
}

function requireRuntimeAiCacheEntry(
  state: RuntimeState,
  cacheKey: AiCacheEntry["cacheKey"],
): AiCacheEntry {
  const entry = state.aiCache.get(cacheKey);
  assertNonNullable(entry, `重要度cacheが参照するAI entryがありません。対象: ${cacheKey}`);
  return entry;
}

function verifiedImportanceResult(
  nodeId: GitHubNodeId,
  repository: PublicRepository,
  entry: ImportanceCacheEntry,
  fingerprint: Omit<AiAnalysisFingerprint, "graphNeighborhoodHash">,
): VerifiedImportanceResult {
  return Object.freeze({
    nodeId,
    repository: cacheRepositoryIdentity(repository),
    importance: entry.importance,
    confidence: entry.confidence,
    fingerprint: Object.freeze({
      sourceHash: fingerprint.sourceHash,
      inputHash: fingerprint.inputHash,
      identityHash: fingerprint.identityHash,
    }),
    entry,
  });
}

function currentVerifiedImportanceResult(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  analysis: DeterministicItemAnalysis,
  run: AiAnalysisRunResult | undefined,
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>,
  exactCachedByNodeId: ReadonlyMap<GitHubNodeId, ExactCachedAiAnalysis>,
): VerifiedImportanceResult | undefined {
  const nodeId = analysis.item.nodeId;
  const repository = findRepository(inventory, analysis.item.repositoryId);
  const exact = exactCachedByNodeId.get(nodeId);
  if (exact != null) {
    if (analysis.source.kind !== "cached") {
      throw new TypeError(`fresh解析sourceにwarm AI結果があります。対象: ${nodeId}`);
    }
    if (
      selectCodexImportanceAssessment(exact.output, configuration.config.ai.confidence).status ===
      "not_available"
    ) {
      return undefined;
    }
    const entry = createImportanceCacheEntryFromCacheContext(
      exact.entry,
      analysis.source.analysis.analysisFacts.codexValidationContext,
    );
    return verifiedImportanceResult(nodeId, repository, entry, exact.fingerprint);
  }
  const result = run?.results.find((candidate) => candidate.candidateId === nodeId);
  if (result == null) {
    return undefined;
  }
  if (
    selectCodexImportanceAssessment(result.output, configuration.config.ai.confidence).status ===
    "not_available"
  ) {
    return undefined;
  }
  const input = inputByNodeId.get(nodeId);
  assertNonNullable(input, `重要度cache生成用のCodex入力がありません。対象: ${nodeId}`);
  const fullEntry = requireRuntimeAiCacheEntry(state, result.cacheKey);
  const entry = createImportanceCacheEntry(fullEntry, input);
  if (
    entry.cacheKey !== result.cacheKey ||
    entry.metadata.outputHash !== hashCanonicalJson(result.output)
  ) {
    throw new TypeError(`Codex実行結果と重要度cache用AI entryが一致しません。対象: ${nodeId}`);
  }
  return verifiedImportanceResult(nodeId, repository, entry, result.fingerprint);
}

function importanceEntryForLatestDocument(
  state: RuntimeState,
  document: AiLatestImportanceCacheDocument,
): ImportanceCacheEntry {
  const reference = document.aiCacheReference;
  return createImportanceCacheEntryFromLatest(
    requireRuntimeAiCacheEntry(state, reference.cacheKey),
    document,
  );
}

function aiEntryMatchesRunIdentity(entry: AiCacheEntry, identity: AiAnalysisRunIdentity): boolean {
  return (
    entry.metadata.deterministicRulesVersion === identity.deterministicRulesVersion &&
    entry.metadata.model === identity.model &&
    entry.metadata.reasoningEffort === identity.reasoningEffort &&
    entry.metadata.backendVersion === identity.backendVersion &&
    entry.metadata.promptVersion === identity.promptVersion &&
    entry.metadata.schemaVersion === identity.schemaVersion
  );
}

function historicalImportanceEntryDiagnostic(
  configuration: RuntimeConfiguration,
  identity: AiAnalysisRunIdentity,
  entry: AiCacheEntry,
): string | undefined {
  if (!aiEntryMatchesRunIdentity(entry, identity)) {
    return `過去の重要度AI entryは現在の解析versionと互換性がないため除外します。node ID: ${entry.nodeId}。cache key: ${entry.cacheKey}`;
  }
  if (
    selectCodexImportanceAssessment(entry.output, configuration.config.ai.confidence).status ===
    "not_available"
  ) {
    return `過去の重要度AI entryは現在のconfidence閾値を満たさないため除外します。node ID: ${entry.nodeId}。cache key: ${entry.cacheKey}`;
  }
  return undefined;
}

function validateLoadedImportanceCacheSources(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  identity: AiAnalysisRunIdentity,
  preservedNodeIds: ReadonlySet<GitHubNodeId>,
): Readonly<{
  documents: readonly AiLatestImportanceCacheDocument[];
  rejectedAiCacheKeys: ReadonlySet<AiCacheEntry["cacheKey"]>;
  diagnostics: readonly string[];
}> {
  const rejectedAiCacheKeys = new Set<AiCacheEntry["cacheKey"]>();
  const diagnostics: string[] = [];
  for (const item of loadedItemCacheDocuments(state)) {
    if (preservedNodeIds.has(item.nodeId)) {
      continue;
    }
    const reference = item.aiCacheReference;
    if (reference.status !== "available") {
      continue;
    }
    const entry = requireRuntimeAiCacheEntry(state, reference.cacheKey);
    try {
      const validation = validateGitHubItemCacheAiEntry(item, {
        status: "available",
        value: entry,
      });
      if (validation.status !== "validated") {
        throw new TypeError("利用可能なAI参照を検証済みにできません");
      }
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputValidationError)) {
        throw error;
      }
      rejectedAiCacheKeys.add(reference.cacheKey);
      diagnostics.push(
        `warm cacheのAI semantic validationに失敗したためlatest importanceから除外します。node ID: ${item.nodeId}。cache key: ${reference.cacheKey}。原因: ${error.message}`,
      );
    }
  }
  const documents: AiLatestImportanceCacheDocument[] = [];
  for (const document of loadedLatestImportanceCacheDocuments(state)) {
    if (preservedNodeIds.has(document.nodeId)) {
      documents.push(document);
      continue;
    }
    const cacheKey = document.aiCacheReference.cacheKey;
    importanceEntryForLatestDocument(state, document);
    if (rejectedAiCacheKeys.has(cacheKey)) {
      continue;
    }
    const diagnostic = historicalImportanceEntryDiagnostic(
      configuration,
      identity,
      requireRuntimeAiCacheEntry(state, cacheKey),
    );
    if (diagnostic != null) {
      diagnostics.push(diagnostic);
      continue;
    }
    documents.push(document);
  }
  return Object.freeze({
    documents: Object.freeze(documents),
    rejectedAiCacheKeys,
    diagnostics: Object.freeze([...new Set(diagnostics)]),
  });
}

function reconstructLatestImportanceFromAiEntries(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  evaluatedAt: UtcIsoDateTime,
  nodeId: GitHubNodeId,
  repository: PublicRepository,
  rejectedAiCacheKeys: ReadonlySet<AiCacheEntry["cacheKey"]>,
  identity: AiAnalysisRunIdentity,
): Readonly<{
  document: AiLatestImportanceCacheDocument | undefined;
  diagnostics: readonly string[];
}> {
  const diagnostics: string[] = [];
  const candidates = state.aiCache
    .entriesForNodeId(nodeId)
    .filter(
      (entry) =>
        !rejectedAiCacheKeys.has(entry.cacheKey) &&
        entry.repository.repositoryId === repository.id &&
        entry.repository.owner === repository.owner &&
        entry.repository.name === repository.name,
    )
    .flatMap((fullEntry) => {
      const diagnostic = historicalImportanceEntryDiagnostic(configuration, identity, fullEntry);
      if (diagnostic != null) {
        diagnostics.push(diagnostic);
        return [];
      }
      const entry = createImportanceCacheEntryFromAiResult(fullEntry);
      return [entry];
    });
  const selection = selectLatestImportanceCacheEntry(candidates);
  if (selection.status === "not_available") {
    return Object.freeze({ document: undefined, diagnostics: Object.freeze(diagnostics) });
  }
  const latest = selection.entry;
  const document = createImportanceCacheCandidate({
    context: runtimeImportanceCacheContext(
      inventory,
      evaluatedAt,
      nodeId,
      repository,
      Object.freeze([]),
    ),
    current: verifiedImportanceResult(nodeId, repository, latest, {
      sourceHash: latest.sourceHash,
      inputHash: parseSha256Hash(latest.metadata.inputHash),
      identityHash: hashCanonicalJson({
        backendVersion: latest.metadata.backendVersion,
        deterministicRulesVersion: latest.metadata.deterministicRulesVersion,
        model: latest.metadata.model,
        promptVersion: latest.metadata.promptVersion,
        reasoningEffort: latest.metadata.reasoningEffort,
        schemaVersion: latest.metadata.schemaVersion,
      }),
    }),
    previous: Object.freeze({ status: "not_available" }),
  });
  return Object.freeze({ document, diagnostics: Object.freeze(diagnostics) });
}

function prepareImportanceCaches(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  run: AiAnalysisRunResult | undefined,
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>,
  exactCachedByNodeId: ReadonlyMap<GitHubNodeId, ExactCachedAiAnalysis>,
): PreparedImportanceCaches {
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const staleDisplayNodeIds = new Set(
    collection.staleDisplaySources.map((source) => source.item.nodeId),
  );
  const loaded = validateLoadedImportanceCacheSources(
    configuration,
    state,
    identity,
    staleDisplayNodeIds,
  );
  const diagnostics = [...loaded.diagnostics];
  const rejectedAiCacheKeys = new Set(loaded.rejectedAiCacheKeys);
  for (const result of run?.results ?? []) {
    if (result.origin === "executed") {
      rejectedAiCacheKeys.delete(result.cacheKey);
    }
  }
  const latestImportanceByNodeId = new Map(
    loaded.documents
      .filter((document) => collection.trackedNodeIds.has(document.nodeId))
      .map((document) => [document.nodeId, document]),
  );
  for (const analysis of deterministicAnalysis.items) {
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const reconstructed = reconstructLatestImportanceFromAiEntries(
      configuration,
      state,
      inventory,
      collection.evaluatedAt,
      analysis.item.nodeId,
      repository,
      rejectedAiCacheKeys,
      identity,
    );
    diagnostics.push(...reconstructed.diagnostics);
    if (reconstructed.document != null) {
      latestImportanceByNodeId.set(analysis.item.nodeId, reconstructed.document);
    } else {
      latestImportanceByNodeId.delete(analysis.item.nodeId);
    }
  }
  for (const analysis of deterministicAnalysis.items) {
    const current = currentVerifiedImportanceResult(
      configuration,
      state,
      inventory,
      analysis,
      run,
      inputByNodeId,
      exactCachedByNodeId,
    );
    if (current == null) {
      continue;
    }
    const previous = latestImportanceByNodeId.get(analysis.item.nodeId);
    if (
      previous != null &&
      Date.parse(current.entry.metadata.executedAt) < Date.parse(previous.metadata.executedAt)
    ) {
      continue;
    }
    const previousEntries =
      previous == null
        ? Object.freeze([])
        : Object.freeze([importanceEntryForLatestDocument(state, previous)]);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const context = runtimeImportanceCacheContext(
      inventory,
      collection.evaluatedAt,
      analysis.item.nodeId,
      repository,
      previousEntries,
    );
    latestImportanceByNodeId.set(
      analysis.item.nodeId,
      createImportanceCacheCandidate({
        context,
        current,
        previous: importanceCacheState(previous),
      }),
    );
  }

  const fallbackImportanceByNodeId = new Map<
    GitHubNodeId,
    Extract<NaturalLanguageImportanceAssessmentState, { status: "available" }>
  >();
  for (const analysis of deterministicAnalysis.items) {
    const nodeId = analysis.item.nodeId;
    const failure = run?.failures.find((candidate) => candidate.candidateId === nodeId);
    const deferred = run?.deferred.find((candidate) => candidate.candidateId === nodeId);
    if (failure == null && deferred == null) {
      continue;
    }
    const latest = latestImportanceByNodeId.get(nodeId);
    const latestEntries =
      latest == null
        ? Object.freeze([])
        : Object.freeze([importanceEntryForLatestDocument(state, latest)]);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const resolution = resolveImportance({
      context: runtimeImportanceCacheContext(
        inventory,
        collection.evaluatedAt,
        nodeId,
        repository,
        latestEntries,
      ),
      current:
        failure != null
          ? Object.freeze({ status: "execution_failed" })
          : Object.freeze({ status: "budget_deferred" }),
      latest: importanceCacheState(latest),
    });
    if (resolution.status === "fallback") {
      fallbackImportanceByNodeId.set(
        nodeId,
        Object.freeze({
          status: "available",
          value: resolution.importance,
        }),
      );
    }
  }
  return Object.freeze({
    latestImportanceByNodeId,
    fallbackImportanceByNodeId,
    rejectedAiCacheKeys,
    diagnostics: Object.freeze([...new Set(diagnostics)]),
  });
}

async function analyzeCodex(
  adapters: ProductionRuntimeAdapters,
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
  const exactCachedByNodeId = exactCachedAiByNodeId(deterministicAnalysis);
  const prepared = createAiCandidates(
    configuration,
    state,
    collection,
    deterministicAnalysis,
    identity,
  );
  if (!configuration.config.ai.enabled) {
    const fallback = prepared.failures.length > 0;
    const importanceCaches = prepareImportanceCaches(
      configuration,
      state,
      deterministicAnalysis.inventory,
      collection,
      deterministicAnalysis,
      undefined,
      prepared.inputByNodeId,
      exactCachedByNodeId,
    );
    const { diagnostics: importanceDiagnostics, ...importanceCacheStage } = importanceCaches;
    return Object.freeze({
      stage: Object.freeze({
        run: undefined,
        inputByNodeId: prepared.inputByNodeId,
        exactCachedByNodeId,
        ...importanceCacheStage,
      }),
      status: fallback ? "fallback" : "success",
      aiCallCount: 0,
      aiCacheHitCount: 0,
      aiRetainedResultCount: exactCachedByNodeId.size,
      estimatedInputTokens: 0,
      diagnostics: Object.freeze([
        ...prepared.failures.map(codexFallbackDiagnostic),
        ...importanceDiagnostics,
      ]),
    });
  }
  const codexCredentials = configuration.credentials.codex;
  if (!codexCredentials.enabled) {
    throw new TypeError("AIが有効ですがCodex認証情報がありません");
  }
  const executedRun = await runAiAnalyses(
    prepared.candidates,
    {
      identity,
      budget: configuration.config.ai.budget,
      maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
    },
    {
      cache: state.aiCache,
      execute: (input) =>
        adapters.executeCodexAnalysis(
          input,
          {
            authentication: configuration.config.ai.authentication,
            model: configuration.config.ai.model,
            execution: {
              timeoutSeconds: configuration.config.ai.execution.timeoutSeconds,
              maxAttempts: configuration.config.ai.execution.maxAttempts,
              sandbox: configuration.config.ai.execution.sandbox,
              approvalPolicy: configuration.config.ai.execution.approvalPolicy,
              reasoningEffort: configuration.config.ai.execution.reasoningEffort,
            },
            retry: {
              initialDelaySeconds: configuration.config.operations.retry.initialDelaySeconds,
              maxDelaySeconds: configuration.config.operations.retry.maxDelaySeconds,
            },
          },
          {
            environment: codexCredentials.environment,
            processRunner: adapters.codexProcessRunner,
            runtime: {
              sleep: adapters.sleep,
              random: adapters.random,
            },
          },
        ),
      executedAt: () => collection.evaluatedAt,
    },
  );
  const run = Object.freeze({
    ...executedRun,
    failures: Object.freeze([...prepared.failures, ...executedRun.failures]),
  }) satisfies AiAnalysisRunResult;
  const importanceCaches = prepareImportanceCaches(
    configuration,
    state,
    deterministicAnalysis.inventory,
    collection,
    deterministicAnalysis,
    run,
    prepared.inputByNodeId,
    exactCachedByNodeId,
  );
  const { diagnostics: importanceDiagnostics, ...importanceCacheStage } = importanceCaches;
  const fallback = run.failures.length > 0 || run.deferred.length > 0;
  return Object.freeze({
    stage: Object.freeze({
      run,
      inputByNodeId: prepared.inputByNodeId,
      exactCachedByNodeId,
      ...importanceCacheStage,
    }),
    status: fallback ? "fallback" : "success",
    aiCallCount: run.usage.calls,
    aiCacheHitCount:
      run.results.filter((result) => result.origin === "cache").length + exactCachedByNodeId.size,
    aiRetainedResultCount: exactCachedByNodeId.size,
    estimatedInputTokens: Math.ceil(run.usage.inputCharacters / 4),
    diagnostics: Object.freeze([
      ...run.failures.map(codexFallbackDiagnostic),
      ...run.deferred.map(
        (deferred) => `codex_deferred item=${deferred.candidateId} reason=${deferred.reason}`,
      ),
      ...importanceDiagnostics,
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

function resolveImportanceAssessment(
  current: NaturalLanguageImportanceAssessmentState | undefined,
  previous: NaturalLanguageImportanceAssessmentState | undefined,
): NaturalLanguageImportanceAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return previous ?? unavailableImportanceAssessment();
}

function reductionForAnalysis(
  configuration: RuntimeConfiguration,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): CodexAnalysisReduction | undefined {
  const exactCached = codexAnalysis.exactCachedByNodeId.get(analysis.item.nodeId);
  if (exactCached != null) {
    if (analysis.source.kind !== "cached") {
      throw new TypeError(`fresh解析sourceにwarm AI結果があります。対象: ${analysis.item.nodeId}`);
    }
    return reduceCachedCodexAnalysis(
      analysis.source.analysis.analysisFacts.codexValidationContext,
      deterministicCodexDecision(analysis.decision),
      exactCached.output,
      configuration.config.ai.confidence,
    );
  }
  const run = codexAnalysis.run;
  if (run == null) {
    return undefined;
  }
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  const result = run.results.find((candidate) => candidate.candidateId === analysis.item.nodeId);
  if (result != null) {
    assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "validated",
        output: result.output,
      },
      configuration.config.ai.confidence,
    );
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
  return (
    codexAnalysis.exactCachedByNodeId.get(analysis.item.nodeId)?.output ??
    codexAnalysis.run?.results.find((candidate) => candidate.candidateId === analysis.item.nodeId)
      ?.output
  );
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

function explicitRequestAssessment(
  source: RuntimeItemAnalysisSource,
  output: ValidatedCodexAnalysisOutput | undefined,
): IssueExplicitRequestAssessment {
  const candidates = issueRequestCandidatesForSource(source);
  if (output == null || candidates.length === 0) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const candidateSourceIds = nonEmptySourceIds(
    candidates.map((candidate) => candidate.sourceId),
    "明示依頼候補",
  );
  const mentionedCandidates =
    source.kind === "cached"
      ? source.analysis.analysisFacts.mentionedWaitingOnCandidates
      : createMentionedWaitingOnCandidates(source.detail);
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
  item: Extract<RuntimeObservedGitHubItem, Readonly<{ type: "pull_request" }>>,
): readonly [SourceId, ...SourceId[]] | undefined {
  if (
    item.mergeState.checks.status !== "configured" ||
    (item.mergeState.checks.combinedState !== "failure" &&
      item.mergeState.checks.combinedState !== "error")
  ) {
    return undefined;
  }
  const failingContextSourceIds = item.mergeState.checks.contexts.flatMap((context) => {
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
    [item.mergeState.checks.sourceId, ...failingContextSourceIds],
    "required check失敗",
  );
}

function checkFailureAssessment(
  item: Extract<RuntimeObservedGitHubItem, Readonly<{ type: "pull_request" }>>,
  output: ValidatedCodexAnalysisOutput | undefined,
): PullRequestCheckFailureAssessment {
  const sourceIds = checkFailureSourceIds(item);
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
  throw new TypeError(`blocker ${nodeId}の現行状態がありません`);
}

function graphBlockers(
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  graph: GraphResult,
  item: RuntimeObservedGitHubItem,
): readonly IssueBlocker[] {
  const blockersByCandidateId = new Map<GraphNodeId, IssueBlocker>();
  const sourceOccurredAtById = createDependencySourceOccurredAtById(collection);
  for (const edge of graph.analysisEdges) {
    if (!edge.active || edge.type !== "blocks" || edge.toNodeId !== item.nodeId) {
      continue;
    }
    const activeInterval = graph.activeBlockIntervalsByEdgeKey.get(
      temporalEdgeKey(edge.fromNodeId, edge.toNodeId),
    );
    const edgeSourceIds =
      activeInterval?.sourceIds ??
      nonEmptySourceIds(
        edge.evidence.map((evidence) => evidence.sourceId),
        `blocker edge ${edge.id}`,
      );
    const edgeBecameBlockingAt =
      activeInterval?.addedAt ??
      earliestDependencySourceOccurredAt(sourceOccurredAtById, edge.id, edgeSourceIds);
    const existing = blockersByCandidateId.get(edge.fromNodeId);
    if (existing == null) {
      blockersByCandidateId.set(
        edge.fromNodeId,
        Object.freeze({
          candidateId: edge.fromNodeId,
          state: graphNodeState(deterministicAnalysis, graph, edge.fromNodeId),
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

function earliestDependencySourceOccurredAt(
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  edgeId: ReconciledGraphEdge["id"],
  sourceIds: readonly [SourceId, ...SourceId[]],
): UtcIsoDateTime {
  const occurredAts = sourceIds.map((sourceId) => {
    const occurredAt = sourceOccurredAtById.get(sourceId);
    assertNonNullable(
      occurredAt,
      `blocker edge ${edgeId}の根拠発生時刻がありません。対象: ${sourceId}`,
    );
    return occurredAt;
  });
  const firstOccurredAt = occurredAts[0];
  assertNonNullable(firstOccurredAt, `blocker edge ${edgeId}の根拠発生時刻がありません`);
  return occurredAts.reduce(
    (earliest, occurredAt) => (occurredAt < earliest ? occurredAt : earliest),
    firstOccurredAt,
  );
}

function reassessDeterministicAnalysis(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  collection: CollectedItems,
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
      : graphBlockers(collection, deterministicAnalysis, graph, analysis.item);
  if (analysis.item.type === "issue") {
    return Object.freeze({
      ...analysis,
      decision: determineIssueState({
        issue: analysis.item,
        blockers,
        explicitRequestCandidates: issueRequestCandidatesForSource(analysis.source),
        explicitRequestAssessment: explicitRequestAssessment(analysis.source, output),
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
    });
  }
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  return Object.freeze({
    ...analysis,
    decision: determinePullRequestState({
      pullRequest: analysis.item,
      blockers,
      checkFailureAssessment: checkFailureAssessment(analysis.item, output),
      labelEffects: resolveLabelEffects(repositoryFullName(repository), analysis.item.labels),
      maintainers,
      confidenceThresholds: configuration.config.ai.confidence,
      evaluatedAt,
    }),
  });
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

function createDependencySourceOccurredAtById(
  collection: CollectedItems,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const source of collection.analysisSources) {
    const currentSourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
    if (source.kind === "fresh") {
      for (const [sourceId, occurredAt] of createCodexSourceOccurredAtById(
        source.item,
        source.detail,
      )) {
        currentSourceOccurredAtById.set(sourceId, occurredAt);
      }
    } else {
      for (const record of source.analysis.analysisFacts.codexValidationContext.sources) {
        const parts = parseSourceId(record.id);
        currentSourceOccurredAtById.set(
          buildSourceId(parts.kind, parts.originalId),
          record.createdAt,
        );
      }
    }
    for (const [sourceId, occurredAt] of currentSourceOccurredAtById) {
      const existingOccurredAt = sourceOccurredAtById.get(sourceId);
      if (existingOccurredAt == null || existingOccurredAt < occurredAt) {
        sourceOccurredAtById.set(sourceId, occurredAt);
      }
    }
  }
  return sourceOccurredAtById;
}

function dependencyResolutions(
  graph: GraphResult | undefined,
  analysis: DeterministicItemAnalysis,
): readonly DependencyResolutionProgress[] {
  if (graph == null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    graph.temporal.newlyUnblockedFacts.flatMap((fact) =>
      fact.status === "exact" && fact.value.blockedNodeId === analysis.item.nodeId
        ? [
            Object.freeze({
              occurredAt: fact.value.occurredAt,
              sourceIds: fact.value.sourceIds,
            }),
          ]
        : [],
    ),
  );
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
      selectionReason: "Codex判定にwaitingOnがないためprimaryはありません",
    });
  }
  return Object.freeze({
    index: 0,
    selectionReason: "Codexが返したwaitingOnの優先順でprimaryを選定しました",
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
  const sourceOccurredAtById = analysisSourceOccurredAtById(analysis);
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

function trackedItemState(
  item: RuntimeObservedGitHubItem,
  decision: ReducedCodexDecision,
): TrackedItem["state"] {
  if (decision.status === "terminal_merged") {
    return "merged";
  }
  return item.state;
}

function inputCommentUrl(
  detail: GitHubItemDetail,
  sourceId: SourceId,
): TrackedItemInputEvent["url"] {
  const sourceKind = parseSourceId(sourceId).kind;
  if (sourceKind === "github_issue_comment") {
    const comment = detail.comments.find((candidate) => candidate.sourceId === sourceId);
    assertNonNullable(comment, `Issue commentのURLがありません。対象: ${sourceId}`);
    return comment.url;
  }
  if (sourceKind === "github_pull_request_review_comment") {
    if (detail.type !== "pull_request") {
      throw new TypeError(`IssueにPull Request review commentがあります。対象: ${sourceId}`);
    }
    const comment = detail.reviewThreads
      .flatMap((thread) => thread.comments)
      .find((candidate) => candidate.sourceId === sourceId);
    assertNonNullable(comment, `Pull Request review commentのURLがありません。対象: ${sourceId}`);
    return comment.url;
  }
  throw new TypeError(`commentイベントのsource ID種別が不正です。対象: ${sourceId}`);
}

function inputReviewUrl(
  detail: GitHubItemDetail,
  sourceId: SourceId,
): TrackedItemInputEvent["url"] {
  if (parseSourceId(sourceId).kind !== "github_pull_request_review") {
    throw new TypeError(`reviewイベントのsource ID種別が不正です。対象: ${sourceId}`);
  }
  if (detail.type !== "pull_request") {
    throw new TypeError(`IssueにPull Request reviewがあります。対象: ${sourceId}`);
  }
  const review = detail.reviews.find((candidate) => candidate.sourceId === sourceId);
  assertNonNullable(review, `Pull Request reviewのURLがありません。対象: ${sourceId}`);
  return review.url;
}

function trackedItemInputEventUrl(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
  event: FreshObservedGitHubItem["events"][number],
): TrackedItemInputEvent["url"] {
  switch (event.kind) {
    case "comment":
      return inputCommentUrl(detail, event.sourceId);
    case "review":
      return inputReviewUrl(detail, event.sourceId);
    default:
      return item.url;
  }
}

function trackedItemInputEvents(
  analysis: DeterministicItemAnalysis,
): readonly TrackedItemInputEvent[] {
  if (analysis.source.kind === "cached") {
    return Object.freeze(
      analysis.source.analysis.analysisFacts.inputEvents.map((event) =>
        Object.freeze({ ...event }),
      ),
    );
  }
  const source = analysis.source;
  return Object.freeze(
    source.item.events.map((event) =>
      Object.freeze({
        sourceId: event.sourceId,
        url: trackedItemInputEventUrl(source.item, source.detail, event),
      }),
    ),
  );
}

function trackedItemAiAnalysis(
  codexAnalysis: CodexAnalysis,
  analysis: DeterministicItemAnalysis,
): TrackedItemAiAnalysis {
  const nodeId = analysis.item.nodeId;
  const exactCached = codexAnalysis.exactCachedByNodeId.get(nodeId);
  if (exactCached != null) {
    return Object.freeze({
      status: "used",
      cacheKey: exactCached.entry.cacheKey,
    });
  }
  const run = codexAnalysis.run;
  if (run == null) {
    return Object.freeze({
      status: "disabled",
    });
  }
  if (analysis.source.kind === "cached") {
    const status = analysis.source.document.aiAnalysisStatus;
    if (status === "used") {
      throw new TypeError(`warm AI cache結果がありません。対象: ${nodeId}`);
    }
    return Object.freeze({
      status,
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

function createTrackedItemFromAnalysis(
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
  primaryWaitingOn: PrimaryWaitingOn,
  staleness: StalenessResult,
  aiAnalysis: TrackedItemAiAnalysis,
): PendingTrackedItem {
  const commonFields = {
    nodeId: analysis.item.nodeId,
    type: analysis.item.type,
    repositoryId: analysis.item.repositoryId,
    displayReference: analysis.item.displayReference,
    number: analysis.item.number,
    url: analysis.item.url,
    title: analysis.item.title,
    milestone: analysis.item.milestone,
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
    aiAnalysis,
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

function createTrackedItem(
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
  primaryWaitingOn: PrimaryWaitingOn,
  staleness: StalenessResult,
  codexAnalysis: CodexAnalysis,
): PendingTrackedItem {
  return createTrackedItemFromAnalysis(
    analysis,
    decision,
    primaryWaitingOn,
    staleness,
    trackedItemAiAnalysis(codexAnalysis, analysis),
  );
}

function blockedParentContext(
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
  const previousSeverityByNodeId = new Map<string, Severity>();
  const downstreamImpactByNodeId = new Map<string, number>(
    (graph?.analysis.downstreamImpacts ?? []).map((impact) => [
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
    waitClass: staleness.waitClass,
    severityContext: staleness.severityContext,
  });
}

function reduceAnalysisPass(
  configuration: RuntimeConfiguration,
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
  const unresolvedAiRelationCandidateIds = new Set<RelationCandidateId>();
  let runStatus: ReducedAnalysis["runStatus"] = "success";
  for (const originalAnalysis of deterministicAnalysis.items) {
    const output = codexOutputForAnalysis(originalAnalysis, codexAnalysis);
    const analysis = reassessDeterministicAnalysis(
      collection.evaluatedAt,
      configuration,
      collection,
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
    const inferredRelationCandidateIds = new Set(
      selectRelationAssessmentCandidates(analysis.item.nodeId, analysis.relationCandidates)
        .filter((candidate) => candidate.authority === "inferred")
        .map((candidate) => candidate.id),
    );
    if (reduction == null) {
      for (const candidateId of inferredRelationCandidateIds) {
        unresolvedAiRelationCandidateIds.add(candidateId);
      }
    } else if (reduction.relationCoverage.status === "fallback") {
      for (const candidateId of inferredRelationCandidateIds) {
        if (reduction.relationCoverage.unresolvedCandidateIds.includes(candidateId)) {
          unresolvedAiRelationCandidateIds.add(candidateId);
        }
      }
    }
    const basis = transitionBasisForDecision(analysis, decision);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const staleness = calculateStalenessForItem(analysis.item.nodeId, {
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
      events: analysis.item.events,
      responsibleAccountIdentifiers: resolveWaitingOnAccountIdentifiers(decision.waitingOn),
      dependencyResolutions: dependencyResolutions(graph, analysis),
      naturalLanguageAssessments: naturalLanguageProgressAssessments(analysis, output),
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      repositoryFullName: repositoryFullName(repository),
      currentLabels: analysis.item.labels,
      resolveLabelEffects,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      blockedParentContext: blockedParentContext(decision, graph),
    });
    const notificationRecommendation =
      reduction == null
        ? Object.freeze({
            availability: "not_available",
          } satisfies DiscordNotificationItem["notificationRecommendation"])
        : Object.freeze({
            availability: "available",
            value: reduction.notification,
          } satisfies DiscordNotificationItem["notificationRecommendation"]);
    currentItems.push(
      Object.freeze({
        item: analysis.item,
        decision,
        notificationRecommendation,
        aiNotificationEvents: createAiNotificationEvents(
          analysis,
          output,
          notificationRecommendation,
        ),
        primaryWaitingOn,
        staleness,
        importanceAssessment: resolveImportanceAssessment(
          reduction?.importanceAssessment,
          codexAnalysis.fallbackImportanceByNodeId.get(analysis.item.nodeId),
        ),
      }),
    );
    stalenessByNodeId.set(analysis.item.nodeId, trackedItemStaleness(staleness));
    items.push(createTrackedItem(analysis, decision, primaryWaitingOn, staleness, codexAnalysis));
  }
  if (stalenessByNodeId.size !== items.length) {
    throw new TypeError("全追跡項目のseverityを再計算できませんでした");
  }
  return Object.freeze({
    items: Object.freeze(items),
    currentItems: Object.freeze(currentItems),
    stalenessByNodeId,
    relationAssessments: Object.freeze(relationAssessments),
    unresolvedAiRelationCandidateIds: Object.freeze([...unresolvedAiRelationCandidateIds].sort()),
    runStatus,
  });
}

function reduceAllAnalyses(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
): ReducedAnalysis {
  const initialReduction = reduceAnalysisPass(
    configuration,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    undefined,
  );
  const provisionalGraph = reconcileCurrentGraph(configuration, collection, initialReduction);
  return reduceAnalysisPass(
    configuration,
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
  items: readonly RuntimeObservedGitHubItem[],
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

function temporalEdgeKey(fromNodeId: GraphNodeId, toNodeId: GraphNodeId): string {
  return `${fromNodeId}\u0000${toNodeId}`;
}

function currentTerminalAt(collection: CollectedItems, nodeId: GraphNodeId): UtcIsoDateTime {
  const enumerated = collection.enumeratedItems.find((item) => item.nodeId === nodeId);
  const enumeratedAt = enumeratedTerminalAt(enumerated);
  if (enumeratedAt != null) {
    return enumeratedAt;
  }
  const source = collection.analysisSources.find((candidate) => candidate.item.nodeId === nodeId);
  if (source?.kind === "cached" && source.document.lifecycle.kind === "terminal") {
    return source.document.lifecycle.terminalAt;
  }
  throw new TypeError(`terminal nodeの確定時刻がありません。対象: ${nodeId}`);
}

function applyTemporalBlockActivity(
  collection: CollectedItems,
  edges: readonly ReconciledGraphEdge[],
  temporal: TemporalBlocksGraphReplayResult,
): readonly ReconciledGraphEdge[] {
  const activeKeys = new Set(
    temporal.currentGraph.activeBlocksEdges.map((edge) =>
      temporalEdgeKey(edge.fromNodeId, edge.toNodeId),
    ),
  );
  const stateByNodeId = new Map(
    temporal.currentGraph.nodes.map((node) => [node.nodeId, node.state]),
  );
  return Object.freeze(
    edges.map((edge): ReconciledGraphEdge => {
      if (edge.type !== "blocks") {
        return edge;
      }
      if (!stateByNodeId.has(edge.fromNodeId) || !stateByNodeId.has(edge.toNodeId)) {
        return edge;
      }
      const key = temporalEdgeKey(edge.fromNodeId, edge.toNodeId);
      if (activeKeys.has(key)) {
        return edge;
      }
      const terminalNodeIds = [edge.fromNodeId, edge.toNodeId].filter(
        (nodeId) => stateByNodeId.get(nodeId) !== "open",
      );
      const firstTerminalNodeId = terminalNodeIds[0];
      assertNonNullable(
        firstTerminalNodeId,
        `inactive blocks edge ${edge.id}のterminal nodeがありません`,
      );
      const terminalAts = terminalNodeIds.map((nodeId) => currentTerminalAt(collection, nodeId));
      const firstTerminalAt = terminalAts[0];
      assertNonNullable(firstTerminalAt, `inactive blocks edge ${edge.id}の確定時刻がありません`);
      const removedAt = terminalAts.reduce(
        (earliest, terminalAt) => (terminalAt < earliest ? terminalAt : earliest),
        firstTerminalAt,
      );
      return Object.freeze({
        ...edge,
        active: false,
        removedAt,
      });
    }),
  );
}

function createTemporalGraphReplay(
  collection: CollectedItems,
  eligibleItems: readonly PendingTrackedItem[],
  currentEdges: readonly ReconciledGraphEdge[],
  relationCandidates: readonly RelationCandidate[],
): Readonly<{
  replay: TemporalBlocksGraphReplayResult;
  activeBlockIntervalsByEdgeKey: GraphResult["activeBlockIntervalsByEdgeKey"];
}> {
  const currentNodeIds = new Set<GraphNodeId>(eligibleItems.map((item) => item.nodeId));
  const canonicalEdgesByKey = new Map<
    string,
    Readonly<{ fromNodeId: GraphNodeId; toNodeId: GraphNodeId }>
  >();
  for (const edge of currentEdges) {
    if (
      edge.type !== "blocks" ||
      !currentNodeIds.has(edge.fromNodeId) ||
      !currentNodeIds.has(edge.toNodeId)
    ) {
      continue;
    }
    const key = temporalEdgeKey(edge.fromNodeId, edge.toNodeId);
    canonicalEdgesByKey.set(
      key,
      Object.freeze({ fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }),
    );
  }
  const sourceByNodeId = new Map(
    collection.analysisSources.map((source) => [source.item.nodeId, source]),
  );
  const items = eligibleItems.map((item) => {
    const source = sourceByNodeId.get(item.nodeId);
    assertNonNullable(source, `temporal replay対象の解析sourceがありません。対象: ${item.nodeId}`);
    return source.kind === "fresh"
      ? Object.freeze({
          kind: "fresh",
          detail: source.detail,
          relationMutations: source.relationMutations,
          replay: source.replay,
        })
      : Object.freeze({
          kind: "cached",
          document: source.document,
        });
  });
  const adapter = adaptMixedTemporalBlocksGraph({
    current: {
      scope: "eligible_tracked_items_only",
      nodes: eligibleItems.map((item) => ({ nodeId: item.nodeId, state: item.state })),
      canonicalBlocksEdges: Object.freeze([...canonicalEdgesByKey.values()]),
    },
    notificationHistory: collection.exactAiRelationNotificationHistory,
    relationCandidates: relationCandidates.filter((candidate) =>
      relationNodes(candidate.relation).every(
        (node) => node.scope === "organization" && currentNodeIds.has(node.nodeId),
      ),
    ),
    items,
  });
  const replay = replayTemporalBlocksGraph(adapter.input);
  const activeBlockIntervalsByEdgeKey = new Map<
    string,
    Readonly<{
      addedAt: UtcIsoDateTime;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>
  >();
  if (adapter.input.relationHistory.status === "exact") {
    const activeEdgeKeys = new Set(
      replay.currentGraph.activeBlocksEdges.map((edge) =>
        temporalEdgeKey(edge.fromNodeId, edge.toNodeId),
      ),
    );
    for (const relation of replayDependencyEvents(adapter.input.relationHistory.mutations)
      .relations) {
      const key = temporalEdgeKey(relation.edge.fromNodeId, relation.edge.toNodeId);
      const currentInterval = relation.intervals.at(-1);
      assertNonNullable(currentInterval, `active blocks edge ${key}のintervalがありません`);
      if (currentInterval.status !== "active" || !activeEdgeKeys.has(key)) {
        continue;
      }
      activeBlockIntervalsByEdgeKey.set(
        key,
        Object.freeze({
          addedAt: currentInterval.addedAt,
          sourceIds: currentInterval.sourceIds,
        }),
      );
    }
  }
  return Object.freeze({ replay, activeBlockIntervalsByEdgeKey });
}

function reconcileCurrentGraph(
  configuration: RuntimeConfiguration,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
): GraphResult {
  const freshRepositoryIdSet = freshRepositoryIds(collection);
  const eligibleItems = reduction.items.filter((item) =>
    freshRepositoryIdSet.has(item.repositoryId),
  );
  const nodeIds = new Set<GraphNodeId>(eligibleItems.map((item) => item.nodeId));
  const candidates = collection.relationCandidates.filter((candidate) => {
    const nodes = relationNodes(candidate.relation);
    if (candidate.relation.type === "blocks") {
      return nodes.every((node) => node.scope === "organization" && nodeIds.has(node.nodeId));
    }
    return (
      nodes.some((node) => node.scope === "organization" && nodeIds.has(node.nodeId)) &&
      nodes.every((node) => node.scope === "external_public" || nodeIds.has(node.nodeId))
    );
  });
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const reconciled: ReconcileGraphResult = reconcileGraph({
    previousGraph: {
      edges: [],
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
  const temporalContext = createTemporalGraphReplay(
    collection,
    eligibleItems,
    reconciled.activeEdges,
    candidates,
  );
  const temporal = temporalContext.replay;
  const externalReferencesByNodeId = new Map(
    [
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
    ...eligibleItems.map((item) => item.nodeId),
    ...externalReferencesByNodeId.keys(),
  ]);
  const currentEdges = retainGraphEdgesForAvailableNodes(reconciled.edges, availableNodeIds);
  const eligibleCurrentEdges = currentEdges.filter(
    (edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
  );
  const analysisEdges = applyTemporalBlockActivity(collection, eligibleCurrentEdges, temporal);
  const analysisEdgesById = new Map(analysisEdges.map((edge) => [edge.id, edge]));
  const edges = Object.freeze(currentEdges.map((edge) => analysisEdgesById.get(edge.id) ?? edge));
  const referencedNodeIds = new Set(edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
  const externalReferences = Object.freeze(
    [...externalReferencesByNodeId.values()]
      .filter((reference) => referencedNodeIds.has(reference.nodeId))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  );
  const graphNodes = eligibleItems.map(graphAnalysisNode);
  const analysis = analyzeGraph({
    current: {
      nodes: graphNodes,
      edges: analysisEdges,
    },
    previous: {
      availability: "unavailable",
    },
  });
  return Object.freeze({
    displayEdges: edges,
    analysisEdges,
    externalReferences,
    analysis,
    temporal,
    activeBlockIntervalsByEdgeKey: temporalContext.activeBlockIntervalsByEdgeKey,
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

function notificationLatestChange(
  events: readonly NormalizedEvent[],
  referenceAt: UtcIsoDateTime,
): DiscordNotificationItem["latestChange"] {
  const windowEvents = events.filter((event) =>
    isOneTimeNotificationDue({
      eventAt: event.occurredAt,
      referenceAt,
    }),
  );
  if (windowEvents.length === 0) {
    return "none";
  }
  return windowEvents.some((event) => event.actor.type === "human") ? "human" : "bot_only";
}

function responsibilityChangedEvents(
  source: RuntimeItemAnalysisSource,
): readonly DiscordNotificationEvent[] {
  const epochs =
    source.kind === "fresh"
      ? source.replay.responsibilityEpochs
      : source.document.replay.responsibilityEpochs;
  if (epochs.status === "unknown") {
    return Object.freeze([]);
  }
  const normalizedEpochs = epochs.value.map((epoch) =>
    Object.freeze({
      targetSignature: serializeCanonicalJson(epoch.targets),
      occurredAt: epoch.occurredAt,
      sourceIds: epoch.sourceIds,
    }),
  );
  const events: DiscordNotificationEvent[] = [];
  for (let index = 1; index < normalizedEpochs.length; index += 1) {
    const previous = normalizedEpochs[index - 1];
    const current = normalizedEpochs[index];
    assertNonNullable(previous, "責務epochの直前値がありません");
    assertNonNullable(current, "責務epochの現在値がありません");
    if (previous.targetSignature === current.targetSignature) {
      continue;
    }
    nonEmptySourceIds(current.sourceIds, `責務変更 ${source.item.nodeId}`);
    events.push(
      Object.freeze({
        kind: "responsibility_changed",
        occurredAt: current.occurredAt,
      }),
    );
  }
  return Object.freeze(events);
}

function createAiNotificationEvents(
  analysis: DeterministicItemAnalysis,
  output: ValidatedCodexAnalysisOutput | undefined,
  recommendation: DiscordNotificationItem["notificationRecommendation"],
): readonly DiscordNotificationEvent[] {
  if (
    output == null ||
    recommendation.availability !== "available" ||
    !recommendation.value.recommended ||
    recommendation.value.reasonCode === "none"
  ) {
    return Object.freeze([]);
  }
  const notificationEvidence = output.evidence.filter(
    (evidence) => evidence.supports === "notification",
  );
  if (notificationEvidence.length === 0) {
    return Object.freeze([]);
  }
  const sourceOccurredAtById = analysisSourceOccurredAtById(analysis);
  const occurredAts: UtcIsoDateTime[] = [];
  for (const evidence of notificationEvidence) {
    const occurredAt = sourceOccurredAtById.get(evidence.sourceId);
    if (occurredAt == null) {
      return Object.freeze([]);
    }
    occurredAts.push(occurredAt);
  }
  return Object.freeze([
    Object.freeze({
      kind: "ai_notification",
      reasonCode: recommendation.value.reasonCode,
      occurredAt: latestUtcIsoDateTime(occurredAts, `AI通知 ${analysis.item.nodeId}`),
    }),
  ]);
}

function temporalNotificationEvents(
  graph: GraphResult,
  source: RuntimeItemAnalysisSource,
  aiNotificationEvents: readonly DiscordNotificationEvent[],
): readonly DiscordNotificationEvent[] {
  const newlyUnblockedEvents = graph.temporal.newlyUnblockedFacts.flatMap(
    (fact): DiscordNotificationEvent[] =>
      fact.status === "exact" && fact.value.blockedNodeId === source.item.nodeId
        ? [
            Object.freeze({
              kind: "newly_unblocked",
              occurredAt: fact.value.occurredAt,
            }),
          ]
        : [],
  );
  return Object.freeze([
    ...newlyUnblockedEvents,
    ...responsibilityChangedEvents(source),
    ...aiNotificationEvents,
  ]);
}

function temporalDependencyCycles(
  graph: GraphResult,
  nodeId: GitHubNodeId,
): DiscordNotificationItem["graph"]["dependencyCycles"] {
  return Object.freeze(
    graph.temporal.cycleCreatedFacts.flatMap((fact) =>
      fact.status === "exact" && fact.value.nodeIds.includes(nodeId)
        ? [
            Object.freeze({
              cycleId: fact.value.id,
              occurredAt: fact.value.occurredAt,
            }),
          ]
        : [],
    ),
  );
}

function notificationItem(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  graph: GraphResult,
  item: PendingTrackedItem,
  staleness: TrackedItemStaleness,
  analysisState: NotificationAnalysisState,
  source: RuntimeItemAnalysisSource,
  currentEvents: readonly NormalizedEvent[],
  referenceAt: UtcIsoDateTime,
): DiscordNotificationItem {
  const repository = findRepository(inventory, item.repositoryId);
  const downstreamImpact = graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === item.nodeId,
  );
  assertNonNullable(downstreamImpact, `通知対象 ${item.nodeId}のdownstream impactがありません`);
  const labelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config))(
    repositoryFullName(repository),
    item.labels,
  );
  return Object.freeze({
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    draftState: notificationDraftState(item, enumeratedItemsByNodeId),
    repositoryFreshness: "fresh",
    notificationClass: item.notificationClass,
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
    latestChange: notificationLatestChange(currentEvents, referenceAt),
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
      waitClass: staleness.waitClass,
      statusSince: item.statusSince,
      ownerSince: item.ownerSince,
      stallSince: item.stallSince,
      lastProgressAt: item.lastProgressAt,
    },
    events: temporalNotificationEvents(
      graph,
      source,
      analysisState.availability === "available"
        ? analysisState.value.aiNotificationEvents
        : Object.freeze([]),
    ),
    graph: Object.freeze({
      downstreamImpact,
      dependencyCycles: temporalDependencyCycles(graph, item.nodeId),
    }),
  });
}

function notificationItems(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  referenceAt: UtcIsoDateTime,
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
  const currentEventsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item.events]),
  );
  const sourceByNodeId = new Map(
    collection.analysisSources.map((source) => [source.item.nodeId, source]),
  );
  return Object.freeze(
    reduction.items.flatMap((item) => {
      if (staleRepositoryIds.has(item.repositoryId)) {
        return [];
      }
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `通知対象 ${item.nodeId}のseverity再計算結果がありません`);
      const current = currentItemsByNodeId.get(item.nodeId);
      const source = sourceByNodeId.get(item.nodeId);
      assertNonNullable(source, `通知対象 ${item.nodeId}の解析sourceがありません`);
      return [
        notificationItem(
          configuration,
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
          source,
          currentEventsByNodeId.get(item.nodeId) ?? Object.freeze([]),
          referenceAt,
        ),
      ];
    }),
  );
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

function createTrackedItemWithResolvedImportance(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
  item: PendingTrackedItem,
  downstreamImpact: ImportanceDownstreamImpact,
  naturalLanguageAssessment: NaturalLanguageImportanceAssessmentState,
): TrackedItemWithImportanceAssessment {
  const repository = findRepository(inventory, item.repositoryId);
  const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
  const deterministicImportance = calculateImportance({
    priorityWeight: labelEffects.priorityWeight,
    downstreamImpact,
    milestone: item.milestone,
    evaluatedAt,
    weights: configuration.config.importance.weights,
    dueSoonDays: configuration.config.importance.dueSoonDays,
    levels: configuration.config.importance.levels,
  });
  return Object.freeze({
    ...item,
    importanceAssessment: naturalLanguageAssessment,
    importance: combineImportance({
      deterministic: deterministicImportance,
      naturalLanguageAssessment,
      weights: configuration.config.importance.weights,
      levels: configuration.config.importance.levels,
    }),
  });
}

function createTrackedItemWithImportance(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  graph: GraphResult,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
  item: PendingTrackedItem,
  naturalLanguageAssessment: NaturalLanguageImportanceAssessmentState,
): TrackedItemWithImportanceAssessment {
  const downstreamImpact = graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === item.nodeId,
  );
  assertNonNullable(
    downstreamImpact,
    `重要度計算対象 ${item.nodeId}のdownstream impactがありません`,
  );
  return createTrackedItemWithResolvedImportance(
    evaluatedAt,
    configuration,
    inventory,
    resolveLabelEffects,
    item,
    downstreamImpact,
    naturalLanguageAssessment,
  );
}

function staleDisplayRuntimeAnalysisSource(
  source: StaleDisplayItemAnalysisSource,
): Extract<RuntimeItemAnalysisSource, { kind: "cached" }> {
  return Object.freeze({
    kind: "cached",
    item: source.item,
    document: source.document,
    analysis: source.analysis,
    exactAi: undefined,
  });
}

function createStaleDisplayDeterministicAnalysis(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  source: StaleDisplayItemAnalysisSource,
): DeterministicItemAnalysis {
  if (source.analysis.replay.currentState !== source.repositoryIndex.state) {
    throw new TypeError(
      `stale item cacheのreplayとrepository indexの状態が一致しません。対象: ${source.item.nodeId}`,
    );
  }
  const item = source.item;
  const repository = findRepository(inventory, item.repositoryId);
  const repositoryName = repositoryFullName(repository);
  const maintainers = resolveRepositoryMaintainers(
    configuration.config.maintainers,
    repositoryName,
  );
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const labelEffects = resolveLabelEffects(repositoryName, item.labels);
  const notificationClass = classifyTrackingNotification({
    authorType: authorType(item),
    title: item.title,
    automationNoiseTitles: configuration.config.notifications.automationNoiseTitles,
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
  });
  const runtimeSource = staleDisplayRuntimeAnalysisSource(source);
  const relationCandidates = candidatesForNode(item.nodeId, source.analysis.relationCandidates);
  const blockers = createNativeBlockers(item, relationCandidates);
  if (item.type === "issue") {
    return Object.freeze({
      item,
      source: runtimeSource,
      decision: determineIssueState({
        issue: item,
        blockers,
        explicitRequestCandidates: issueRequestCandidatesForSource(runtimeSource),
        explicitRequestAssessment: Object.freeze({ status: "not_assessed" }),
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
      notificationClass,
      relationCandidates,
    });
  }
  return Object.freeze({
    item,
    source: runtimeSource,
    decision: determinePullRequestState({
      pullRequest: item,
      blockers,
      checkFailureAssessment: Object.freeze({ cause: "not_assessed" }),
      labelEffects,
      maintainers,
      confidenceThresholds: configuration.config.ai.confidence,
      evaluatedAt,
    }),
    notificationClass,
    relationCandidates,
  });
}

function staleDisplayItemRetentionState(
  source: StaleDisplayItemAnalysisSource,
): RetentionItemState {
  const lifecycle = source.repositoryIndex.lifecycle;
  if (lifecycle.kind === "open") {
    return Object.freeze({ state: "open" });
  }
  return Object.freeze({
    state: source.repositoryIndex.state === "merged" ? "merged" : "closed",
    terminalAt: lifecycle.terminalAt,
  });
}

function createStaleSnapshotTrackedItem(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  source: StaleDisplayItemAnalysisSource,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
): SnapshotTrackedItem {
  const analysis = createStaleDisplayDeterministicAnalysis(
    evaluatedAt,
    configuration,
    inventory,
    source,
  );
  const decision = reducedDeterministicDecision(analysis.decision);
  const primaryWaitingOn = primaryWaitingOnForDecision(analysis.decision, decision);
  const basis = transitionBasisForDecision(analysis, decision);
  const repository = findRepository(inventory, analysis.item.repositoryId);
  const staleness = calculateStalenessForItem(analysis.item.nodeId, {
    createdAt: analysis.item.createdAt,
    evaluatedAt,
    currentDecision: {
      status: decision.status,
      waitingOn: decision.waitingOn,
      confidence: decision.confidence,
      statusBasis: basis.statusBasis,
      responsibilityBasis: basis.responsibilityBasis,
    },
    decisionBasis: "deterministic",
    events: analysis.item.events,
    responsibleAccountIdentifiers: resolveWaitingOnAccountIdentifiers(decision.waitingOn),
    dependencyResolutions: Object.freeze([]),
    naturalLanguageAssessments: Object.freeze([]),
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    repositoryFullName: repositoryFullName(repository),
    currentLabels: analysis.item.labels,
    resolveLabelEffects,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    blockedParentContext: blockedParentContext(decision, undefined),
  });
  const pending = createTrackedItemFromAnalysis(
    analysis,
    decision,
    primaryWaitingOn,
    staleness,
    configuration.config.ai.enabled
      ? Object.freeze({ status: "not_recorded" })
      : Object.freeze({ status: "disabled" }),
  );
  const item = createTrackedItemWithResolvedImportance(
    evaluatedAt,
    configuration,
    inventory,
    resolveLabelEffects,
    pending,
    Object.freeze({ openNodeCount: 0, repositoryCount: 0 }),
    unavailableImportanceAssessment(),
  );
  const trackedStaleness = trackedItemStaleness(staleness);
  return Object.freeze({
    ...item,
    attention: calculateAttention({
      importanceScore: item.importance.score,
      elapsedHours: trackedStaleness.elapsedHours,
      waitClass: trackedStaleness.waitClass,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      recencyFloor: configuration.config.attention.recencyFloor,
      levels: configuration.config.attention.levels,
    }),
    severity: trackedStaleness.severity,
    severityContext: trackedStaleness.severityContext,
  });
}

function createStaleSnapshotTrackedItems(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  freshNodeIds: ReadonlySet<GitHubNodeId>,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
): readonly SnapshotTrackedItem[] {
  const items: SnapshotTrackedItem[] = [];
  for (const source of collection.staleDisplaySources) {
    if (freshNodeIds.has(source.item.nodeId)) {
      throw new TypeError(
        `fresh項目とstale表示項目のnode IDが重複しています。対象: ${source.item.nodeId}`,
      );
    }
    if (
      !shouldKeepPreviousTrackedItemInActiveDataset(
        evaluatedAt,
        configuration,
        source.item,
        staleDisplayItemRetentionState(source),
      )
    ) {
      continue;
    }
    items.push(
      createStaleSnapshotTrackedItem(
        evaluatedAt,
        configuration,
        inventory,
        source,
        resolveLabelEffects,
      ),
    );
  }
  return Object.freeze(items.sort((left, right) => left.nodeId.localeCompare(right.nodeId)));
}

type CompleteCacheHistory = Extract<CacheHistory, { status: "complete" }>;
type CacheTemporalEvent = CompleteCacheHistory["events"][number];

function cacheTemporalActor(actor: GitHubDetailActor): CacheTemporalEvent["actor"] {
  if (actor.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  return Object.freeze({
    status: "identified",
    nodeId: actor.account.nodeId,
  });
}

function timelineRelatedNodeIds(event: GitHubItemDetail["timeline"][number]): GitHubNodeId[] {
  const relatedNodeIds: GitHubNodeId[] = [];
  switch (event.kind) {
    case "assigned":
    case "unassigned":
      if (!("status" in event.assignee)) {
        relatedNodeIds.push(event.assignee.account.nodeId);
      }
      break;
    case "review_requested":
    case "review_request_removed":
      if (!("status" in event.target)) {
        relatedNodeIds.push(event.target.nodeId);
      }
      break;
    case "cross_referenced":
      relatedNodeIds.push(event.source.nodeId);
      break;
    case "connected":
    case "disconnected":
      relatedNodeIds.push(event.subject.nodeId);
      break;
    case "blocked_by_added":
    case "blocked_by_removed":
      if (!("status" in event.blockingIssue)) {
        relatedNodeIds.push(event.blockingIssue.nodeId);
      }
      break;
    case "blocking_added":
    case "blocking_removed":
      if (!("status" in event.blockedIssue)) {
        relatedNodeIds.push(event.blockedIssue.nodeId);
      }
      break;
    case "sub_issue_added":
    case "sub_issue_removed":
      if (!("status" in event.subIssue)) {
        relatedNodeIds.push(event.subIssue.nodeId);
      }
      break;
    case "parent_issue_added":
    case "parent_issue_removed":
      if (!("status" in event.parent)) {
        relatedNodeIds.push(event.parent.nodeId);
      }
      break;
    case "labeled":
    case "unlabeled":
    case "closed":
    case "reopened":
    case "merged":
    case "ready_for_review":
    case "converted_to_draft":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
    case "head_ref_force_pushed":
      break;
    case "commit_added":
      relatedNodeIds.push(event.commit.nodeId);
      break;
  }
  return relatedNodeIds;
}

function createCacheHistory(item: EnumeratedGitHubItem, detail: GitHubItemDetail): CacheHistory {
  const events = detail.timeline.map((event): CacheTemporalEvent => {
    const occurredAt =
      "occurredAt" in event
        ? event.occurredAt
        : resolvePullRequestCommitOccurredAt(event.commit, item.createdAt);
    return Object.freeze({
      sourceId: event.sourceId,
      kind: event.kind,
      sequence: event.sequence,
      occurredAt,
      actor:
        "actor" in event
          ? cacheTemporalActor(event.actor)
          : Object.freeze({ status: "unavailable" }),
      relatedNodeIds: timelineRelatedNodeIds(event),
    });
  });
  events.sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
  });
  return Object.freeze({
    status: "complete",
    events,
  });
}

function createCacheValidationContext(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
  analysis: DeterministicItemAnalysis | undefined,
): import("../codex/index.js").CodexCacheValidationContext {
  if (analysis != null) {
    return createCodexCacheValidationContext(createCodexInput(item.observedAt, analysis));
  }
  const sourceOccurredAtById = createCodexSourceOccurredAtById(item, detail);
  const sourceRecords = [
    {
      id: item.sourceId,
      kind: "item",
      actorType: codexActorType(item),
      createdAt: item.createdAt,
    },
    {
      id: detail.bodySourceId,
      kind: "item_body",
      actorType: codexActorType(item),
      createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, detail.bodySourceId),
    },
    ...detail.comments.map((comment) => {
      const event: NormalizedEvent | undefined = item.events.find(
        (candidate) => candidate.sourceId === comment.sourceId,
      );
      assertNonNullable(
        event,
        `commentに対応するactor eventがありません。対象: ${comment.sourceId}`,
      );
      return {
        id: comment.sourceId,
        kind: "comment",
        actorType: event.actor.type,
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, comment.sourceId),
      };
    }),
  ];
  return parseCodexCacheValidationContext({
    schemaVersion: "1",
    purpose: "semantic_validation_only",
    now: item.observedAt,
    item: {
      nodeId: item.nodeId,
      url: item.url,
      type: item.type,
    },
    candidates: {
      waitingOn: [],
      relations: [],
    },
    sources: sourceRecords,
    nativeRelationConstraints: [],
  });
}

function cacheLifecycleForItem(item: EnumeratedGitHubItem): CacheItemIndex["lifecycle"] {
  const terminalAt = enumeratedTerminalAt(item);
  if (terminalAt == null) {
    return Object.freeze({ kind: "open" });
  }
  return Object.freeze({
    kind: "terminal",
    terminalAt,
    expiresAt: createCacheTerminalExpiry(terminalAt),
  });
}

function cacheItemState(item: EnumeratedGitHubItem): CacheItemIndex["state"] {
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return "merged";
  }
  return item.state;
}

function cacheDraftState(item: EnumeratedGitHubItem): CacheItemIndex["draftState"] {
  return item.type === "issue" ? "not_applicable" : item.draft ? "draft" : "ready_for_review";
}

function cacheRepositoryIdentity(repository: PublicRepository): CacheRepositoryIdentity {
  return Object.freeze({
    repositoryId: repository.id,
    owner: repository.owner,
    name: repository.name,
  });
}

function cacheItemIndexFromDocument(
  document: GitHubItemCacheDocument,
): GitHubRepositoryCacheDocument["items"][number] {
  return Object.freeze({
    nodeId: document.nodeId,
    repositoryId: document.repositoryId,
    type: document.type,
    number: document.number,
    url: document.url,
    state: document.state,
    draftState: document.draftState,
    bodyFingerprint: document.bodyFingerprint,
    itemFingerprint: document.itemFingerprint,
    analysisRulesFingerprint: document.analysisRulesFingerprint,
    deterministicRulesVersion: document.deterministicRulesVersion,
    aiAnalysisStatus: document.aiAnalysisStatus,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    observedAt: document.observedAt,
    lifecycle: document.lifecycle,
  });
}

function createRepositoryCacheDocument(
  repository: PublicRepository,
  successfulAt: UtcIsoDateTime,
  items: readonly GitHubItemCacheDocument[],
): GitHubRepositoryCacheDocument {
  const document = createCacheDocument({
    schemaVersion: CACHE_DOCUMENT_SCHEMA_VERSION,
    kind: "github_repository",
    repository: cacheRepositoryIdentity(repository),
    successfulAt,
    items: [...items]
      .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
      .map(cacheItemIndexFromDocument),
  });
  if (document.kind !== "github_repository") {
    throw new TypeError("repository cache文書を生成できません");
  }
  return document;
}

function createItemCacheDocuments(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
): readonly GitHubItemCacheDocument[] {
  const deterministicByNodeId = new Map(
    deterministicAnalysis.items.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const aiResultsByNodeId = new Map(
    (codexAnalysis.run?.results ?? []).map((result) => [result.candidateId, result]),
  );
  const rules = createCurrentAnalysisRulesFingerprints(configuration.config);
  const documents: GitHubItemCacheDocument[] = [];
  for (const source of collection.analysisSources) {
    if (source.kind === "cached") {
      continue;
    }
    const observation = source.item;
    const detail = source.detail;
    const relationBoundaryInput = createItemRelationBoundaryInput(
      source,
      collection.relationCandidates,
    );
    const enumeratedItem = findEnumeratedItem(collection, observation.nodeId);
    const repository = findRepository(inventory, observation.repositoryId);
    const explicitRequestCandidates =
      observation.type === "issue" && detail.type === "issue"
        ? createIssueRequestCandidates(observation, detail)
        : [];
    const mentionedWaitingOnCandidates = createMentionedWaitingOnCandidates(detail);
    const deterministic = deterministicByNodeId.get(observation.nodeId);
    const aiAnalysis =
      deterministic == null
        ? Object.freeze({ status: "not_recorded" } satisfies TrackedItemAiAnalysis)
        : trackedItemAiAnalysis(codexAnalysis, deterministic);
    const aiResult = aiResultsByNodeId.get(observation.nodeId);
    const aiCacheReference: GitHubItemCacheDocument["aiCacheReference"] =
      aiResult == null
        ? Object.freeze({ status: "unavailable" })
        : Object.freeze({
            status: "available",
            cacheKey: aiResult.cacheKey,
            sourceHash: aiResult.fingerprint.sourceHash,
            inputHash: aiResult.fingerprint.inputHash,
            graphNeighborhoodHash: aiResult.fingerprint.graphNeighborhoodHash,
            identityHash: aiResult.fingerprint.identityHash,
          });
    const document = createGitHubItemCacheDocument({
      repository: cacheRepositoryIdentity(repository),
      observation,
      state: cacheItemState(enumeratedItem),
      draftState: cacheDraftState(enumeratedItem),
      analysisRulesFingerprint: rules[observation.type],
      deterministicRulesVersion: CURRENT_DETERMINISTIC_RULES_VERSIONS[observation.type],
      aiAnalysisStatus: aiAnalysis.status,
      lifecycle: cacheLifecycleForItem(enumeratedItem),
      relationPublicBoundaryValidation: collection.relationPublicBoundaryRevalidationNodeIds.has(
        observation.nodeId,
      )
        ? Object.freeze({ status: "required" })
        : Object.freeze({ status: "not_required" }),
      relationCandidates: relationBoundaryInput.relationCandidates,
      relationMutations: relationBoundaryInput.relationMutations,
      replay: source.replay,
      history: createCacheHistory(enumeratedItem, detail),
      analysisFacts: {
        bodyEmpty: detail.body.length === 0,
        explicitRequestCandidates,
        mentionedWaitingOnCandidates: mentionedWaitingOnCandidates.map((candidate) => ({
          ...candidate,
          sourceIds: [...candidate.sourceIds],
        })),
        inputEvents: observation.events.map((event) => ({
          sourceId: event.sourceId,
          url: trackedItemInputEventUrl(observation, detail, event),
        })),
        codexValidationContext: createCacheValidationContext(observation, detail, deterministic),
      },
      aiCacheReference,
    });
    documents.push(document);
  }
  return Object.freeze(documents);
}

function createRuntimeCachePayload(
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  state: RuntimeState,
): RuntimeCachePayload {
  const freshItemCaches = createItemCacheDocuments(
    configuration,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
  );
  const freshItemCachesByNodeId = new Map(
    freshItemCaches.map((document) => [document.nodeId, document]),
  );
  if (freshItemCachesByNodeId.size !== freshItemCaches.length) {
    throw new TypeError("fresh item cacheのnode IDが重複しています");
  }
  const revalidatedCachedItemCachesByNodeId = new Map<GitHubNodeId, GitHubItemCacheDocument>();
  for (const source of collection.analysisSources) {
    if (source.kind === "cached") {
      revalidatedCachedItemCachesByNodeId.set(source.item.nodeId, source.document);
    }
  }
  const loadedRepositoryCaches = loadedRepositoryCacheDocuments(state);
  const loadedRepositoryCachesById = new Map(
    loadedRepositoryCaches.map((document) => [document.repository.repositoryId, document]),
  );
  const loadedItemCaches = loadedItemCacheDocuments(state);
  const loadedItemCachesByNodeId = new Map(
    loadedItemCaches.map((document) => [document.nodeId, document]),
  );
  const repositoryCaches: GitHubRepositoryCacheDocument[] = [];
  const itemCaches: GitHubItemCacheDocument[] = [];
  const retainedNodeIds = new Set<GitHubNodeId>();

  const retainItemCache = (
    document: GitHubItemCacheDocument,
    repositoryId: GitHubRepositoryId,
  ): void => {
    if (document.repositoryId !== repositoryId) {
      throw new TypeError(`item cacheのrepository IDが一致しません。対象: ${document.nodeId}`);
    }
    if (retainedNodeIds.has(document.nodeId)) {
      throw new TypeError(`item cacheのnode IDが重複しています。対象: ${document.nodeId}`);
    }
    retainedNodeIds.add(document.nodeId);
    itemCaches.push(document);
  };

  for (const result of collection.repositoryResults) {
    if (result.freshness === "stale") {
      const repositoryCache = loadedRepositoryCachesById.get(result.repository.id);
      assertNonNullable(
        repositoryCache,
        `stale repositoryのcache文書がありません。対象: ${result.repository.id}`,
      );
      repositoryCaches.push(repositoryCache);
      for (const item of repositoryCache.items) {
        const itemCache = loadedItemCachesByNodeId.get(item.nodeId);
        assertNonNullable(
          itemCache,
          `stale repositoryのitem cache文書がありません。対象: ${item.nodeId}`,
        );
        retainItemCache(itemCache, result.repository.id);
      }
      continue;
    }

    const repositoryItemCaches = result.value.items.map((item) => {
      const itemCache =
        freshItemCachesByNodeId.get(item.nodeId) ??
        revalidatedCachedItemCachesByNodeId.get(item.nodeId) ??
        loadedItemCachesByNodeId.get(item.nodeId);
      assertNonNullable(
        itemCache,
        `fresh repositoryのitem cache文書がありません。対象: ${item.nodeId}`,
      );
      retainItemCache(itemCache, result.repository.id);
      return itemCache;
    });
    repositoryCaches.push(
      createRepositoryCacheDocument(result.repository, result.observedAt, repositoryItemCaches),
    );
  }

  for (const document of freshItemCaches) {
    if (!retainedNodeIds.has(document.nodeId)) {
      throw new TypeError(
        `fresh item cacheに対応するrepository indexがありません。対象: ${document.nodeId}`,
      );
    }
  }

  const referencedAiCacheKeys = new Set(
    itemCaches.flatMap((document) =>
      document.aiCacheReference.status === "available" ? [document.aiCacheReference.cacheKey] : [],
    ),
  );
  const latestImportanceCaches = [...codexAnalysis.latestImportanceByNodeId.values()]
    .filter((document) => retainedNodeIds.has(document.nodeId))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  for (const document of latestImportanceCaches) {
    referencedAiCacheKeys.add(document.aiCacheReference.cacheKey);
  }
  const retainedItemCachesByNodeId = new Map(
    itemCaches.map((document) => [document.nodeId, document]),
  );
  const aiCacheEntries = state.aiCache.entries().filter((entry) => {
    if (codexAnalysis.rejectedAiCacheKeys.has(entry.cacheKey)) {
      return false;
    }
    const item = retainedItemCachesByNodeId.get(entry.nodeId);
    if (item?.repository.repositoryId !== entry.repository.repositoryId) {
      return false;
    }
    return (
      item.repository.owner === entry.repository.owner &&
      item.repository.name === entry.repository.name
    );
  });
  const aiCacheEntryKeys = new Set(aiCacheEntries.map((entry) => entry.cacheKey));
  for (const cacheKey of referencedAiCacheKeys) {
    if (!aiCacheEntryKeys.has(cacheKey)) {
      throw new TypeError(`cache文書が参照するAI cache entryがありません。対象: ${cacheKey}`);
    }
  }

  return validateCacheOnlyPersistenceInput(
    {
      evaluatedAt: collection.evaluatedAt,
      repositoryCaches,
      itemCaches,
      latestImportanceCaches,
      aiCacheEntries,
      knownSecrets: configuration.credentials.knownSecrets,
    },
    inventory.allowlist,
  );
}

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  digestRunContext: NormalDigestRunContext,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): ValidatedRun {
  if (reduction.unresolvedAiRelationCandidateIds.length > 0) {
    throw new TypeError(
      `現在の推定relationをAIで確定できませんでした。対象: ${reduction.unresolvedAiRelationCandidateIds.join(",")}`,
    );
  }
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentAnalysisByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const items = reduction.items.map((item) => {
    const currentAnalysis = currentAnalysisByNodeId.get(item.nodeId);
    return createTrackedItemWithImportance(
      collection.evaluatedAt,
      configuration,
      inventory,
      graph,
      resolveLabelEffects,
      item,
      resolveImportanceAssessment(currentAnalysis?.importanceAssessment, undefined),
    );
  });
  const freshSnapshotItems = items.map((item): SnapshotTrackedItem => {
    const staleness = reduction.stalenessByNodeId.get(item.nodeId);
    assertNonNullable(staleness, `追跡項目 ${item.nodeId}のseverity再計算結果がありません`);
    return Object.freeze({
      ...item,
      attention: calculateAttention({
        importanceScore: item.importance.score,
        elapsedHours: staleness.elapsedHours,
        waitClass: staleness.waitClass,
        thresholdsHours: configuration.config.staleness.thresholdsHours,
        recencyFloor: configuration.config.attention.recencyFloor,
        levels: configuration.config.attention.levels,
      }),
      severity: staleness.severity,
      severityContext: staleness.severityContext,
    });
  });
  const staleSnapshotItems = createStaleSnapshotTrackedItems(
    collection.evaluatedAt,
    configuration,
    inventory,
    collection,
    new Set(freshSnapshotItems.map((item) => item.nodeId)),
    resolveLabelEffects,
  );
  const previousCollectionItems = previousCollectionItemsByNodeId(state);
  const currentAnalysisRulesFingerprints = createCurrentAnalysisRulesFingerprints(
    configuration.config,
  );
  const aiFingerprintByNodeId = new Map<
    GitHubNodeId,
    SnapshotCollectionItem["aiAnalysisFingerprint"]
  >();
  for (const result of codexAnalysis.run?.results ?? []) {
    aiFingerprintByNodeId.set(
      createGitHubNodeId(result.candidateId),
      Object.freeze({
        status: "available",
        fingerprint: result.fingerprint,
      }),
    );
  }
  for (const [nodeId, exact] of codexAnalysis.exactCachedByNodeId) {
    aiFingerprintByNodeId.set(
      nodeId,
      Object.freeze({
        status: "available",
        fingerprint: exact.fingerprint,
      }),
    );
  }
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const analysisRulesFingerprintByNodeId = new Map<
    GitHubNodeId,
    SnapshotCollectionItem["analysisRulesFingerprint"]
  >(
    [...collection.analysisNodeIds].map((nodeId) => {
      const item = observedItemsByNodeId.get(nodeId);
      assertNonNullable(item, `再判定対象の観測項目がありません。対象: ${nodeId}`);
      const fingerprint: SnapshotCollectionItem["analysisRulesFingerprint"] = Object.freeze({
        status: "available",
        fingerprint: currentAnalysisRulesFingerprints[item.type],
      });
      const pair: readonly [GitHubNodeId, SnapshotCollectionItem["analysisRulesFingerprint"]] = [
        nodeId,
        fingerprint,
      ];
      return pair;
    }),
  );
  const deterministicRulesVersionByNodeId = new Map<
    GitHubNodeId,
    SnapshotCollectionItem["deterministicRulesVersion"]
  >(
    [...collection.analysisNodeIds].map((nodeId) => {
      const item = observedItemsByNodeId.get(nodeId);
      assertNonNullable(item, `再判定対象の観測項目がありません。対象: ${nodeId}`);
      const version: SnapshotCollectionItem["deterministicRulesVersion"] = Object.freeze({
        status: "available",
        version: CURRENT_DETERMINISTIC_RULES_VERSIONS[item.type],
      });
      const pair: readonly [GitHubNodeId, SnapshotCollectionItem["deterministicRulesVersion"]] = [
        nodeId,
        version,
      ];
      return pair;
    }),
  );
  const persistedAiFingerprintNodeIds = new Set<string>();
  const persistedAnalysisRulesFingerprintNodeIds = new Set<string>();
  const persistedDeterministicRulesVersionNodeIds = new Set<string>();
  const snapshot = createStateSnapshot({
    schemaVersion: "8",
    generatedAt: collection.evaluatedAt,
    trackingStartAt: pendingSnapshotTrackingStartAt(configuration),
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
    items: Object.freeze([...freshSnapshotItems, ...staleSnapshotItems]),
    externalReferences: graph.externalReferences,
    relations: graph.displayEdges.map(toStateRelation),
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
  const notificationItemsForRun = evaluateNormalDigestRun(digestRunContext).allowed
    ? notificationItems(
        configuration,
        inventory,
        collection,
        reduction,
        graph,
        invocation.scheduledFor,
      )
    : Object.freeze([]);
  const notificationSelection = selectDiscordNotifications({
    referenceAt: invocation.scheduledFor,
    runContext: digestRunContext,
    items: notificationItemsForRun,
    settings: {
      maxItemsPerDigest: configuration.config.notifications.discord.maxItemsPerDigest,
      repeatDays: configuration.config.notifications.discord.repeatDays,
      recentProgressGraceHours: configuration.config.staleness.recentProgressGraceHours,
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      severityThresholds: configuration.config.staleness.thresholdsHours,
    },
  });
  const cacheOnlyPayload = createRuntimeCachePayload(
    configuration,
    inventory,
    collection,
    deterministicAnalysis,
    codexAnalysis,
    state,
  );
  return Object.freeze({
    snapshot,
    notificationSelection,
    cacheOnlyPayload,
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

function discordDeliverySettings(config: Config): DiscordDeliverySettings {
  return Object.freeze({
    enabled: config.notifications.discord.enabled,
    webhookSecretName: config.notifications.discord.webhookSecretName,
    operationsWebhookSecretName: config.notifications.discord.operationsWebhookSecretName,
    mentions: config.notifications.discord.mentions,
    retry: config.operations.retry,
  });
}

/** 環境変数と予定時刻から通常digestのworkflow contextを作成する。 */
export function normalDigestRunContext(
  environment: Readonly<NodeJS.ProcessEnv>,
  scheduledFor: UtcIsoDateTime,
): NormalDigestRunContext {
  const parsedEnvironment = normalDigestEnvironmentSchema.parse({
    GITHUB_EVENT_NAME: environment["GITHUB_EVENT_NAME"],
    GITHUB_RUN_ATTEMPT: environment["GITHUB_RUN_ATTEMPT"],
  });
  const runAttempt = Number(parsedEnvironment.GITHUB_RUN_ATTEMPT);
  if (parsedEnvironment.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return Object.freeze({
      eventName: "workflow_dispatch",
      runAttempt,
    });
  }
  return Object.freeze({
    eventName: "schedule",
    runAttempt,
    scheduledFor,
  });
}

function createCollectAnalyzeArtifact(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  validated: ValidatedRun,
  metrics: RunMetrics,
  diagnostics: readonly string[],
): WorkflowArtifact {
  const pages = generatePublicData({
    snapshot: validated.snapshot,
    repositoryAllowlist: inventory.allowlist.repositories,
    repositoryInventory: inventory.inventory,
    knownSecrets: configuration.credentials.knownSecrets,
    options: {
      confidenceThresholds: configuration.config.ai.confidence,
      labelRules: normalizeLabelRules(configuration.config),
      maxInitialGraphNodes: configuration.config.web.graph.maxInitialNodes,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: configuration.config.staleness.timezone,
    },
  });
  const artifact = createWorkflowArtifact({
    schemaVersion: "2",
    kind: "validated_public_run",
    repositoryAllowlist: inventory.allowlist.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
    })),
    snapshot: validated.snapshot,
    notificationSelection: validated.notificationSelection,
    runMetadata: createRunMetadata(invocation, validated, metrics, diagnostics),
    pages,
    cacheOnlyPayload: validated.cacheOnlyPayload,
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
  validated: ValidatedRun,
): Promise<PersistedRun> {
  const result = await state.session.persist({
    evaluatedAt: validated.snapshot.generatedAt,
    ...validated.cacheOnlyPayload,
    knownSecrets: configuration.credentials.knownSecrets,
  });
  return Object.freeze({
    result,
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
  outputDirectory: string,
  knownSecrets: readonly string[],
): Promise<PagesResult> {
  const data = generatePublicData({
    snapshot: validated.snapshot,
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

async function deliverDiscord(
  adapters: ProductionRuntimeAdapters,
  settings: DiscordDeliverySettings,
  validated: ValidatedNotificationRun,
  deployedPagesUrl: string,
): Promise<
  Readonly<{
    value: DiscordDeliveryResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const delivery = await adapters.sendDiscord({
    candidates: validated.notificationSelection.candidates,
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
    },
  });
  let sentAt: UtcIsoDateTime | null = null;
  if (delivery.status === "sent") {
    sentAt = currentRuntimeTime(adapters);
  }
  return Object.freeze({
    value: Object.freeze({
      delivery,
    }),
    notificationCount:
      delivery.status === "sent" ? validated.notificationSelection.candidates.length : 0,
    discordSentAt: sentAt,
  });
}

async function deliverOperationsAlert(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  incident: DiscordOperationsIncident,
): Promise<
  Readonly<{
    value: DiscordResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const delivery = await adapters.sendDiscord({
    candidates: [],
    items: [],
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
    },
  });
  return Object.freeze({
    value: Object.freeze({
      delivery,
    }),
    notificationCount:
      delivery.status === "skipped" &&
      delivery.reason === "pages_deployment_failed" &&
      delivery.operationsAlert.status === "sent"
        ? 1
        : 0,
    discordSentAt:
      delivery.status === "skipped" &&
      delivery.reason === "pages_deployment_failed" &&
      delivery.operationsAlert.status === "sent"
        ? currentRuntimeTime(adapters)
        : null,
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
    loadedRepositoryCacheDocuments(state).map((repository) => [
      repository.repository.repositoryId,
      Object.freeze({
        value: Object.freeze({
          repositoryId: state.allowlist.require(repository.repository.repositoryId).id,
          successfulAt: repository.successfulAt,
          items: Object.freeze(
            repository.items.map((item) =>
              snapshotCollectionItemFromCache(
                item,
                state.allowlist.require(repository.repository.repositoryId).id,
              ),
            ),
          ),
        }),
        observedAt: repository.successfulAt,
      }),
    ]),
  );
}

function createStaleDisplayReference(
  repository: PublicRepository,
  number: number,
): GitHubItemDisplayReference {
  return GITHUB_ITEM_DISPLAY_REFERENCE_SCHEMA.parse(
    `${repository.owner}/${repository.name}#${number.toString()}`,
  );
}

function assertStaleRepositoryCacheIdentity(
  result: Extract<RepositoryCollectionResult<SnapshotCollectionRepository>, { freshness: "stale" }>,
  repositoryCache: GitHubRepositoryCacheDocument,
): void {
  const repository = result.repository;
  if (
    repositoryCache.repository.repositoryId !== repository.id ||
    repositoryCache.repository.owner !== repository.owner ||
    repositoryCache.repository.name !== repository.name
  ) {
    throw new TypeError(
      `stale repositoryの公開識別情報とcache文書が一致しません。対象: ${repository.id}`,
    );
  }
  if (
    repositoryCache.successfulAt !== result.lastSuccessfulAt ||
    result.previousValue.successfulAt !== result.lastSuccessfulAt ||
    result.previousValue.repositoryId !== repository.id
  ) {
    throw new TypeError(
      `stale repositoryの最終成功時刻またはrepository IDが一致しません。対象: ${repository.id}`,
    );
  }
  if (result.failedAt < result.lastSuccessfulAt) {
    throw new RangeError(
      `stale repositoryの失敗時刻は最終成功時刻以後にしてください。対象: ${repository.id}`,
    );
  }
  const previousItemsByNodeId = new Map(
    result.previousValue.items.map((item) => [item.nodeId, item]),
  );
  if (previousItemsByNodeId.size !== repositoryCache.items.length) {
    throw new TypeError(
      `stale repositoryの前回項目とrepository indexの件数が一致しません。対象: ${repository.id}`,
    );
  }
  for (const index of repositoryCache.items) {
    const previous = previousItemsByNodeId.get(index.nodeId);
    assertNonNullable(
      previous,
      `stale repository indexに対応する前回項目がありません。対象: ${index.nodeId}`,
    );
    const terminalAt = index.lifecycle.kind === "open" ? null : index.lifecycle.terminalAt;
    const state = index.lifecycle.kind === "open" ? "open" : "closed";
    if (
      previous.repositoryId !== repository.id ||
      previous.itemFingerprint !== index.itemFingerprint ||
      previous.observedAt !== index.observedAt ||
      previous.state !== state ||
      previous.terminalAt !== terminalAt
    ) {
      throw new TypeError(
        `stale repositoryの前回項目とrepository indexが一致しません。対象: ${index.nodeId}`,
      );
    }
  }
}

function assertStaleItemCacheIdentity(
  repository: PublicRepository,
  repositoryIndex: CacheItemIndex,
  document: GitHubItemCacheDocument,
): void {
  if (
    document.repository.repositoryId !== repository.id ||
    document.repository.owner !== repository.owner ||
    document.repository.name !== repository.name ||
    document.repositoryId !== repository.id
  ) {
    throw new TypeError(
      `stale item cacheのrepository識別情報が一致しません。対象: ${repositoryIndex.nodeId}`,
    );
  }
  if (
    serializeCanonicalJson(repositoryIndex) !==
    serializeCanonicalJson(cacheItemIndexFromDocument(document))
  ) {
    throw new TypeError(
      `stale repository indexとitem cache文書が一致しません。対象: ${repositoryIndex.nodeId}`,
    );
  }
}

function restoreStaleDisplayItemSources(
  state: RuntimeState,
  repositoryResults: readonly RepositoryCollectionResult<SnapshotCollectionRepository>[],
): readonly StaleDisplayItemAnalysisSource[] {
  const repositoryCachesById = new Map(
    loadedRepositoryCacheDocuments(state).map((document) => [
      document.repository.repositoryId,
      document,
    ]),
  );
  const itemCachesByNodeId = new Map(
    loadedItemCacheDocuments(state).map((document) => [document.nodeId, document]),
  );
  const restoredNodeIds = new Set<GitHubNodeId>();
  const sources: StaleDisplayItemAnalysisSource[] = [];
  for (const result of repositoryResults) {
    if (result.freshness === "fresh") {
      continue;
    }
    const repositoryCache = repositoryCachesById.get(result.repository.id);
    assertNonNullable(
      repositoryCache,
      `stale repositoryのcache文書がありません。対象: ${result.repository.id}`,
    );
    assertStaleRepositoryCacheIdentity(result, repositoryCache);
    for (const repositoryIndex of repositoryCache.items) {
      if (restoredNodeIds.has(repositoryIndex.nodeId)) {
        throw new TypeError(
          `stale repository indexのnode IDが重複しています。対象: ${repositoryIndex.nodeId}`,
        );
      }
      const itemCache = itemCachesByNodeId.get(repositoryIndex.nodeId);
      assertNonNullable(
        itemCache,
        `stale repository indexに対応するitem cache文書がありません。対象: ${repositoryIndex.nodeId}`,
      );
      assertStaleItemCacheIdentity(result.repository, repositoryIndex, itemCache);
      const restored = restoreGitHubItemCacheForAnalysis(itemCache, {
        mode: "stale",
        failedAt: result.failedAt,
      });
      if (restored.status !== "hit" || restored.freshness !== "stale") {
        throw new TypeError(
          `stale item cacheを表示用に復元できません。対象: ${repositoryIndex.nodeId}`,
        );
      }
      const observation = restored.source.observation;
      if (
        observation.nodeId !== repositoryIndex.nodeId ||
        observation.repositoryId !== result.repository.id ||
        observation.type !== repositoryIndex.type ||
        observation.number !== repositoryIndex.number ||
        observation.url !== repositoryIndex.url ||
        observation.observedAt !== repositoryIndex.observedAt
      ) {
        throw new TypeError(
          `stale item cacheの観測値とrepository indexが一致しません。対象: ${repositoryIndex.nodeId}`,
        );
      }
      restoredNodeIds.add(repositoryIndex.nodeId);
      sources.push(
        Object.freeze({
          kind: "stale_display",
          item: Object.freeze({
            ...observation,
            repositoryId: result.repository.id,
            displayReference: createStaleDisplayReference(
              result.repository,
              repositoryIndex.number,
            ),
          }),
          repositoryIndex,
          document: restored.document,
          analysis: restored.source,
          failedAt: restored.failedAt,
        }),
      );
    }
  }
  return Object.freeze(
    sources.sort((left, right) => left.item.nodeId.localeCompare(right.item.nodeId)),
  );
}

function staleRelationMutationReferences(
  result: Extract<RelationMutationResult, { status: "available" }>,
): readonly RelationTextReference[] {
  const references: RelationTextReference[] = [
    ...result.currentReferences,
    ...result.replayedReferences,
    ...result.mutations.map((mutation) => mutation.relation),
    ...result.unmatchedRemovals.map((mutation) => mutation.relation),
  ];
  if (result.temporalKnowledge.status === "exact") {
    references.push(...result.temporalKnowledge.intervals.map((interval) => interval.relation));
  }
  return Object.freeze(references);
}

function assertStaleRelationMutationCanonicalMetadata(
  relationMutations: readonly RelationMutationResult[],
  resolution: ExternalRelationResolution,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): void {
  for (const result of relationMutations) {
    if (result.status !== "available") {
      continue;
    }
    for (const reference of staleRelationMutationReferences(result)) {
      if (isExactAllowlistedRelationReference(reference, organization, allowlist)) {
        continue;
      }
      const resolved = resolution.resultsByReferenceKey.get(
        createRelationMutationReferenceKey(reference),
      );
      if (resolved?.status !== "public") {
        continue;
      }
      const canonical = createCanonicalRelationReference(resolved.item);
      if (
        reference.repositoryOwner !== canonical.repositoryOwner ||
        reference.repositoryName !== canonical.repositoryName ||
        reference.itemType !== canonical.itemType ||
        reference.number !== canonical.number
      ) {
        throw new TypeError("stale relation mutationのcanonical metadataが一致しません");
      }
    }
  }
}

function assertStaleRelationCandidateCanonicalMetadata(
  node: RelationCandidateNode,
  item: Extract<GitHubRelationReferenceResult, { status: "public" }>["item"],
  organization: string,
  allowlist: PublicRepositoryAllowlist,
): void {
  if (node.scope === "organization") {
    if (
      !isCanonicalOrganizationRelationItem(item, organization, allowlist) ||
      node.nodeId !== item.nodeId ||
      node.kind !== item.type ||
      node.number !== item.number ||
      node.repositoryOwner !== item.repositoryOwner ||
      node.repositoryName !== item.repositoryName ||
      node.url !== item.url
    ) {
      throw new TypeError("stale relation候補のcanonical metadataが一致しません");
    }
    return;
  }
  if (
    isCanonicalOrganizationRelationItem(item, organization, allowlist) ||
    node.githubNodeId !== item.nodeId ||
    node.githubItemType !== item.type ||
    node.number !== item.number ||
    node.repositoryOwner !== item.repositoryOwner ||
    node.repositoryName !== item.repositoryName ||
    node.url !== item.url
  ) {
    throw new TypeError("stale relation候補のcanonical metadataが一致しません");
  }
}

async function validateStaleDisplayExternalRelationCandidates(
  resolveRelationReference: ProductionRuntimeAdapters["resolveGitHubRelationReference"],
  authentication: GitHubClient,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  staleDisplaySources: readonly StaleDisplayItemAnalysisSource[],
  resolutionCache: ExternalRelationResolutionCache,
): Promise<readonly StaleDisplayItemAnalysisSource[]> {
  const sources = staleDisplaySources.map(staleDisplayRuntimeAnalysisSource);
  if (sources.length === 0) {
    return Object.freeze([]);
  }
  const resolution = await resolveExternalRelationReferences(
    resolveRelationReference,
    authentication,
    organization,
    allowlist,
    sources,
    resolutionCache,
    Object.freeze([]),
  );
  for (const source of sources) {
    const currentReferencesByContentSource = resolution.currentReferencesBySourceItemNodeId.get(
      source.item.nodeId,
    );
    assertNonNullable(
      currentReferencesByContentSource,
      "stale relation mutationのsource別現在参照がありません",
    );
    const verifiedExternalReferencesByContentSource =
      resolution.verifiedExternalReferencesBySourceItemNodeId.get(source.item.nodeId);
    assertNonNullable(
      verifiedExternalReferencesByContentSource,
      "stale relation mutationのsource別公開参照証明がありません",
    );
    assertStaleRelationMutationCanonicalMetadata(
      source.analysis.relationMutations,
      resolution,
      organization,
      allowlist,
    );
    const sanitizedMutations = sanitizeRelationMutationsForPublicBoundary({
      sourceItemNodeId: source.item.nodeId,
      organization,
      allowlist,
      currentReferencesByContentSource,
      currentBoundaryUnknownContentSourceIds: new Set<SourceId>(),
      verifiedExternalReferencesByContentSource,
      canonicalReferencesByReferenceKey: resolution.canonicalReferencesByReferenceKey,
      relationMutations: source.analysis.relationMutations,
    });
    if (sanitizedMutations.unknownContentSourceCount > 0) {
      throw new TypeError("stale item cacheのrelation mutationを再保存できません");
    }
    let violationCount = 0;
    for (const candidate of source.analysis.relationCandidates) {
      for (const node of relationNodes(candidate.relation)) {
        if (
          node.scope === "organization" &&
          isExactAllowlistedRelationReference(
            createRelationTextReference(node),
            organization,
            allowlist,
          )
        ) {
          continue;
        }
        const reference = createRelationTextReference(node);
        const result = resolution.resultsByReferenceKey.get(
          createRelationMutationReferenceKey(reference),
        );
        if (result?.status !== "public") {
          violationCount += 1;
          continue;
        }
        assertStaleRelationCandidateCanonicalMetadata(node, result.item, organization, allowlist);
      }
    }
    if (violationCount > 0) {
      throw new GitHubPublicBoundaryViolationError({
        scope: "cache_item_relation",
        sourceItemNodeId: source.item.nodeId,
        violationKind: "cache_relation_candidate",
        violationCount,
      });
    }
  }
  return staleDisplaySources;
}

function cachedObservedItem(
  item: EnumeratedGitHubItem,
  source: GitHubItemCacheAnalysisSource,
): CachedObservedGitHubItem {
  const observation = source.observation;
  if (
    observation.nodeId !== item.nodeId ||
    observation.repositoryId !== item.repositoryId ||
    observation.type !== item.type ||
    observation.number !== item.number ||
    observation.url !== item.url ||
    observation.bodyFingerprint !== item.bodyFingerprint ||
    observation.itemFingerprint !== item.itemFingerprint
  ) {
    throw new TypeError(`item cacheの観測値が現在の列挙結果と一致しません。対象: ${item.nodeId}`);
  }
  return Object.freeze({
    ...observation,
    repositoryId: item.repositoryId,
    displayReference: item.displayReference,
    observedAt: item.observedAt,
  });
}

function requiresExactCachedAi(source: GitHubItemCacheAnalysisSource): boolean {
  const assessedRelationIds = new Set(
    source.analysisFacts.codexValidationContext.candidates.relations.map(
      (candidate) => candidate.id,
    ),
  );
  return source.relationCandidates.some(
    (candidate) => candidate.authority === "inferred" && assessedRelationIds.has(candidate.id),
  );
}

function cachedGraphNeighborhoodHash(source: GitHubItemCacheAnalysisSource): string {
  const relationCandidateIds = source.relationCandidates.map((candidate) => candidate.id).sort();
  return hashCanonicalJson(relationCandidateIds);
}

function restoreCachedItemAnalysisSource(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  item: EnumeratedGitHubItem,
  document: GitHubItemCacheDocument,
): CachedItemAnalysisRestoreResult {
  const rules = createCurrentAnalysisRulesFingerprints(configuration.config);
  const restored = restoreGitHubItemCacheForAnalysis(document, {
    mode: "fresh",
    bodyFingerprint: item.bodyFingerprint,
    itemFingerprint: item.itemFingerprint,
    analysisRulesFingerprint: rules[item.type],
  });
  if (restored.status === "cache_miss") {
    return Object.freeze({
      status: "detail_required",
      reason: "cache_miss",
      diagnostics: Object.freeze([]),
    });
  }
  if (restored.status === "detail_required") {
    return Object.freeze({
      status: "detail_required",
      reason: "relation_public_boundary_revalidation",
      diagnostics: Object.freeze([]),
    });
  }
  const observedItem = cachedObservedItem(item, restored.source);
  const requiresFreshAiAnalysis =
    restored.document.aiAnalysisStatus === "disabled" ||
    restored.document.aiAnalysisStatus === "not_recorded" ||
    restored.document.aiAnalysisStatus === "failed" ||
    restored.document.aiAnalysisStatus === "deferred";
  if (configuration.config.ai.enabled && requiresFreshAiAnalysis) {
    return Object.freeze({
      status: "detail_required",
      reason: "exact_ai_refresh",
      diagnostics: Object.freeze([
        `warm cacheのAI分析statusが再判定を要求するためfresh詳細を再取得します。対象: ${item.nodeId}。status: ${restored.document.aiAnalysisStatus}`,
      ]),
    });
  }
  let exactAi: ExactCachedAiAnalysis | undefined;
  try {
    const reference = restored.document.aiCacheReference;
    const entry =
      reference.status === "available" ? state.aiCache.get(reference.cacheKey) : undefined;
    const validation = validateGitHubItemCacheAiEntry(
      restored.document,
      entry == null ? { status: "missing" } : { status: "available", value: entry },
    );
    if (validation.status === "validated") {
      if (reference.status !== "available") {
        throw new TypeError(`検証済みAI entryのcache参照がありません。対象: ${item.nodeId}`);
      }
      if (
        configuration.config.ai.enabled &&
        !aiEntryMatchesRunIdentity(
          validation.entry,
          createAiAnalysisRunIdentity(configuration.config),
        )
      ) {
        return Object.freeze({
          status: "detail_required",
          reason: "exact_ai_refresh",
          diagnostics: Object.freeze([
            `warm cacheが参照するAI entryは現在の解析versionと互換性がないためfresh詳細を再取得します。対象: ${item.nodeId}。cache key: ${reference.cacheKey}`,
          ]),
        });
      }
      if (reference.graphNeighborhoodHash !== cachedGraphNeighborhoodHash(restored.source)) {
        return Object.freeze({
          status: "detail_required",
          reason: "exact_ai_refresh",
          diagnostics: Object.freeze([
            `warm cacheのAI graph近傍が現在の関係候補と一致しないためfresh詳細を再取得します。対象: ${item.nodeId}`,
          ]),
        });
      }
      if (configuration.config.ai.enabled) {
        exactAi = Object.freeze({
          entry: validation.entry,
          output: validation.output,
          fingerprint: Object.freeze({
            sourceHash: reference.sourceHash,
            inputHash: reference.inputHash,
            graphNeighborhoodHash: reference.graphNeighborhoodHash,
            identityHash: reference.identityHash,
          }),
        });
      }
    } else if (reference.status === "available") {
      return Object.freeze({
        status: "detail_required",
        reason: "exact_ai_refresh",
        diagnostics: Object.freeze([
          `warm cacheが参照するAI entryを取得できないためfresh詳細を再取得します。対象: ${item.nodeId}`,
        ]),
      });
    }
  } catch (error: unknown) {
    if (!(error instanceof CodexOutputValidationError)) {
      throw error;
    }
    return Object.freeze({
      status: "detail_required",
      reason: "exact_ai_refresh",
      diagnostics: Object.freeze([
        `warm cacheのAI semantic validationに失敗したためfresh詳細を再取得します。対象: ${item.nodeId}。理由: ${error.message}`,
      ]),
    });
  }
  if (!configuration.config.ai.enabled) {
    return Object.freeze({
      status: "restored",
      source: Object.freeze({
        kind: "cached",
        item: observedItem,
        document: restored.document,
        analysis: restored.source,
        exactAi: undefined,
      }),
    });
  }
  if (exactAi == null && requiresExactCachedAi(restored.source)) {
    return Object.freeze({
      status: "detail_required",
      reason: "exact_ai_refresh",
      diagnostics: Object.freeze([
        `warm cacheの関係判定に必要なexact AI参照がないためfresh詳細を再取得します。対象: ${item.nodeId}`,
      ]),
    });
  }
  return Object.freeze({
    status: "restored",
    source: Object.freeze({
      kind: "cached",
      item: observedItem,
      document: restored.document,
      analysis: restored.source,
      exactAi,
    }),
  });
}

function historicalExactBlockEdge(
  candidate: RelationCandidate,
  currentNodeId: GitHubNodeId,
  verdict: RelationAssessmentVerdict,
): Readonly<{ fromNodeId: GraphNodeId; toNodeId: GraphNodeId }> | undefined {
  if (candidate.authority !== "inferred") {
    return undefined;
  }
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  let targetNode: RelationCandidateNode | undefined;
  if (firstNode.nodeId === currentNodeId) {
    targetNode = secondNode;
  } else if (secondNode.nodeId === currentNodeId) {
    targetNode = firstNode;
  }
  assertNonNullable(
    targetNode,
    `過去のexact AI relation候補に現在項目がありません。対象: ${candidate.id}`,
  );
  if (verdict === "current_is_blocked_by_target") {
    return Object.freeze({ fromNodeId: targetNode.nodeId, toNodeId: currentNodeId });
  }
  if (verdict === "current_blocks_target") {
    return Object.freeze({ fromNodeId: currentNodeId, toNodeId: targetNode.nodeId });
  }
  return undefined;
}

function createExactAiRelationNotificationHistory(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  evaluatedAt: UtcIsoDateTime,
  trackedNodeIds: ReadonlySet<GitHubNodeId>,
  staleRepositoryIds: ReadonlySet<GitHubRepositoryId>,
  diagnostics: string[],
): ExactAiRelationNotificationHistory {
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const edgesByKey = new Map<
    string,
    Readonly<{ fromNodeId: GraphNodeId; toNodeId: GraphNodeId }>
  >();
  const candidatesById = new Map<RelationCandidateId, RelationCandidate>();
  for (const document of loadedItemCacheDocuments(state)) {
    if (
      !trackedNodeIds.has(document.nodeId) ||
      staleRepositoryIds.has(document.repositoryId) ||
      document.relationPublicBoundaryValidation.status === "required" ||
      document.aiCacheReference.status !== "available"
    ) {
      continue;
    }
    const reference = document.aiCacheReference;
    const entry = state.aiCache.get(reference.cacheKey);
    if (entry == null) {
      diagnostics.push(
        `過去のexact AI relation参照先がないため一回通知から除外します。node ID: ${document.nodeId}。cache key: ${reference.cacheKey}`,
      );
      continue;
    }
    if (!aiEntryMatchesRunIdentity(entry, identity)) {
      diagnostics.push(
        `過去のexact AI relationは現在の解析versionと互換性がないため一回通知から除外します。node ID: ${document.nodeId}。cache key: ${reference.cacheKey}`,
      );
      continue;
    }
    let validation: ReturnType<typeof validateGitHubItemCacheAiEntry>;
    try {
      validation = validateGitHubItemCacheAiEntry(document, {
        status: "available",
        value: entry,
      });
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputValidationError)) {
        throw error;
      }
      diagnostics.push(
        `過去のexact AI relationのsemantic validationに失敗したため一回通知から除外します。node ID: ${document.nodeId}。cache key: ${reference.cacheKey}。原因: ${error.message}`,
      );
      continue;
    }
    if (validation.status !== "validated") {
      throw new TypeError(
        `利用可能な過去のexact AI relation参照を検証済みにできません。対象: ${document.nodeId}`,
      );
    }
    const restored = restoreGitHubItemCacheForAnalysis(document, {
      mode: "stale",
      failedAt: evaluatedAt,
    });
    if (restored.status !== "hit") {
      throw new TypeError(`過去のitem cacheを履歴用に復元できません。対象: ${document.nodeId}`);
    }
    const candidatesByCurrentId = new Map(
      restored.source.relationCandidates.map((candidate) => [candidate.id, candidate]),
    );
    for (const relation of validation.output.relations) {
      if (
        Math.min(validation.output.confidence, relation.confidence) <
        configuration.config.ai.confidence.medium
      ) {
        continue;
      }
      const candidate = candidatesByCurrentId.get(relation.candidateId);
      assertNonNullable(
        candidate,
        `検証済みAI relationの候補がitem cacheにありません。対象: ${relation.candidateId}`,
      );
      if (
        !relationNodes(candidate.relation).every(
          (node) => node.scope === "organization" && trackedNodeIds.has(node.nodeId),
        )
      ) {
        continue;
      }
      const edge = historicalExactBlockEdge(candidate, document.nodeId, relation.verdict);
      if (edge == null) {
        continue;
      }
      edgesByKey.set(temporalEdgeKey(edge.fromNodeId, edge.toNodeId), edge);
      candidatesById.set(candidate.id, candidate);
    }
  }
  return Object.freeze({
    exactBlocksEdges: Object.freeze(
      [...edgesByKey.values()].sort((left, right) =>
        temporalEdgeKey(left.fromNodeId, left.toNodeId).localeCompare(
          temporalEdgeKey(right.fromNodeId, right.toNodeId),
        ),
      ),
    ),
    relationCandidates: Object.freeze(
      [...candidatesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

type FreshReplaySource = Extract<RuntimeItemAnalysisSource, { kind: "fresh" }>;

type FreshReplayResolution =
  | Readonly<{
      reenumeration: "not_performed";
      item: EnumeratedGitHubItem;
      detail: GitHubItemDetail;
      observation: FreshObservedGitHubItem;
      source: FreshReplaySource;
    }>
  | Readonly<{
      reenumeration: "performed";
      item: EnumeratedGitHubItem;
      detail: GitHubItemDetail;
      observation: FreshObservedGitHubItem;
      source: FreshReplaySource;
      reenumeratedItem: EnumeratedGitHubItem;
    }>;

function calculateRetryDelayMilliseconds(
  retryNumber: number,
  settings: Config["operations"]["retry"],
): number {
  if (!Number.isSafeInteger(retryNumber) || retryNumber < 1) {
    throw new TypeError("retry番号には1以上の安全な整数を指定してください");
  }
  return Math.min(
    settings.maxDelaySeconds * 1000,
    settings.initialDelaySeconds * 1000 * 2 ** (retryNumber - 1),
  );
}

function createFreshReplaySource(
  item: EnumeratedGitHubItem,
  detail: GitHubItemDetail,
  observation: FreshObservedGitHubItem,
  configuration: RuntimeConfiguration,
  isBot: ReturnType<typeof createGitHubBotPredicate>,
): FreshReplaySource {
  return Object.freeze({
    kind: "fresh",
    item: observation,
    detail,
    relationMutations: Object.freeze(
      adaptGitHubItemDetailRelationMutations(detail, item.createdAt).map((result) => result.result),
    ),
    replay: replayGitHubItemHistory({
      item,
      detail,
      trackingStartAt: trackingSelectionStartAt(configuration),
      isBot,
    }),
  });
}

function validateResponsibilityReplayRetryEnumeration(
  repository: PublicRepository,
  expectedItem: EnumeratedGitHubItem,
  items: readonly EnumeratedGitHubItem[],
): EnumeratedGitHubItem {
  if (items.length !== 1) {
    throw new TypeError(
      `責務再生retryの再列挙結果件数が不正です。対象: ${expectedItem.nodeId} 件数: ${items.length.toString()}`,
    );
  }
  const item = items[0];
  assertNonNullable(item, `責務再生retryの再列挙結果がありません。対象: ${expectedItem.nodeId}`);
  if (
    item.repositoryId !== repository.id ||
    item.nodeId !== expectedItem.nodeId ||
    item.number !== expectedItem.number ||
    item.type !== expectedItem.type
  ) {
    throw new TypeError(
      `責務再生retryの再列挙結果が要求項目と一致しません。対象: ${expectedItem.nodeId}`,
    );
  }
  return item;
}

async function collectResponsibilityReplayRetryItem(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  authentication: GitHubClient,
  repository: PublicRepository,
  expectedItem: EnumeratedGitHubItem,
  isBot: ReturnType<typeof createGitHubBotPredicate>,
): Promise<
  Readonly<{
    item: EnumeratedGitHubItem;
    detail: GitHubItemDetail;
    observation: FreshObservedGitHubItem;
  }>
> {
  const allowlist = createPublicRepositoryAllowlist([repository]);
  const enumeratedItems = await adapters.enumerateGitHubItemsByIdentifiers({
    allowlist,
    identifiers: [expectedItem.nodeId],
    observedAt: invocation.startedAt,
    request: authentication.request,
    graphql: authentication.graphql,
  });
  const item = validateResponsibilityReplayRetryEnumeration(
    repository,
    expectedItem,
    enumeratedItems,
  );
  const details = (
    await adapters.collectGitHubItemDetails({
      allowlist,
      targets: Object.freeze([Object.freeze({ item })]),
      observedAt: invocation.startedAt,
      graphql: authentication.graphql,
    })
  ).items;
  if (details.length !== 1) {
    throw new TypeError(
      `責務再生retryの詳細取得結果件数が不正です。対象: ${item.nodeId} 件数: ${details.length.toString()}`,
    );
  }
  const detail = details[0];
  assertNonNullable(detail, `責務再生retryの詳細取得結果がありません。対象: ${item.nodeId}`);
  const observations = normalizeObservedGitHubItems({
    items: Object.freeze([item]),
    details: Object.freeze([detail]),
    isBot,
  });
  const observation = observations[0];
  assertNonNullable(observation, `責務再生retryの観測値がありません。対象: ${item.nodeId}`);
  return Object.freeze({ item, detail, observation });
}

async function replayFreshItemWithResponsibilityRetry(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  authentication: GitHubClient,
  repository: PublicRepository,
  item: EnumeratedGitHubItem,
  detail: GitHubItemDetail,
  observation: FreshObservedGitHubItem,
  isBot: ReturnType<typeof createGitHubBotPredicate>,
): Promise<FreshReplayResolution> {
  try {
    return Object.freeze({
      reenumeration: "not_performed",
      item,
      detail,
      observation,
      source: createFreshReplaySource(item, detail, observation, configuration, isBot),
    });
  } catch (error: unknown) {
    if (!(error instanceof ResponsibilityReplayMismatchError)) {
      throw error;
    }
    let lastError = error;
    for (
      let retryNumber = 1;
      retryNumber < configuration.config.operations.retry.maxAttempts;
      retryNumber += 1
    ) {
      await adapters.sleep(
        calculateRetryDelayMilliseconds(retryNumber, configuration.config.operations.retry),
      );
      const refreshed = await collectResponsibilityReplayRetryItem(
        adapters,
        invocation,
        authentication,
        repository,
        item,
        isBot,
      );
      try {
        return Object.freeze({
          ...refreshed,
          reenumeration: "performed",
          source: createFreshReplaySource(
            refreshed.item,
            refreshed.detail,
            refreshed.observation,
            configuration,
            isBot,
          ),
          reenumeratedItem: refreshed.item,
        });
      } catch (retryError: unknown) {
        if (!(retryError instanceof ResponsibilityReplayMismatchError)) {
          throw retryError;
        }
        lastError = retryError;
      }
    }
    throw new ResponsibilityReplayRetryExhaustedError(
      item.nodeId,
      configuration.config.operations.retry.maxAttempts,
      {
        cause: lastError,
      },
    );
  }
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
    loadedItemCacheDocuments(state).map((item) => [item.nodeId, item.aiAnalysisStatus]),
  );
  const plan = planIncrementalItemCollection({
    items: enumeratedItems,
    previous: previousItemCollection(state, repository),
    previousAiAnalysisStatusesByNodeId,
    currentAnalysisRulesFingerprints: createCurrentAnalysisRulesFingerprints(configuration.config),
    adjacentItemNodeIds: new Set<GitHubNodeId>(),
  });
  const changedAdjacentNodeIds = previousGraphAdjacentNodeIds(
    state,
    new Set(plan.changedItemNodeIds),
  );
  const detailNodeIds = new Set([
    ...plan.detailItemNodeIds,
    ...[...changedAdjacentNodeIds].filter((nodeId) => currentNodeIds.has(nodeId)),
    ...[...adjacentNodeIds].filter((nodeId) => currentNodeIds.has(nodeId)),
    ...requiredTrackingDetailNodeIds(invocation, configuration, state, repository, enumeratedItems),
  ]);
  const loadedDocumentsByNodeId = new Map(
    loadedItemCacheDocuments(state)
      .filter((document) => document.repositoryId === repository.id)
      .map((document) => [document.nodeId, document]),
  );
  const cachedSourcesByNodeId = new Map<GitHubNodeId, RuntimeItemAnalysisSource>();
  const diagnostics: string[] = [];
  const exactAiRefreshNodeIds = new Set<GitHubNodeId>();
  for (const item of enumeratedItems) {
    const document = loadedDocumentsByNodeId.get(item.nodeId);
    const restoration =
      document == null
        ? Object.freeze({
            status: "detail_required",
            reason: "cache_miss",
            diagnostics: Object.freeze([]),
          } satisfies CachedItemAnalysisRestoreResult)
        : restoreCachedItemAnalysisSource(configuration, state, item, document);
    if (restoration.status === "detail_required") {
      detailNodeIds.add(item.nodeId);
      if (restoration.reason === "exact_ai_refresh") {
        exactAiRefreshNodeIds.add(item.nodeId);
      }
      diagnostics.push(...restoration.diagnostics);
      continue;
    }
    cachedSourcesByNodeId.set(item.nodeId, restoration.source);
  }
  const detailItems = enumeratedItems.filter((item) => detailNodeIds.has(item.nodeId));
  const detailTargets = Object.freeze(detailItems.map((item) => Object.freeze({ item })));
  let details: readonly GitHubItemDetail[];
  try {
    details =
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
  } catch (error: unknown) {
    if (exactAiRefreshNodeIds.size === 0) {
      throw error;
    }
    throw new TypeError(
      `exact AIのfresh再判定に必要な詳細を取得できません。対象: ${[...exactAiRefreshNodeIds].join(",")}`,
      { cause: error },
    );
  }
  const observedItems = normalizeObservedGitHubItems({
    items: detailItems,
    details,
    isBot: createGitHubBotPredicate(configuration.config.actors.bots),
  });
  const isBot = createGitHubBotPredicate(configuration.config.actors.bots);
  const freshObservedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const detailsByNodeId = new Map(details.map((detail) => [detail.nodeId, detail]));
  const enumeratedItemsByNodeId = new Map(enumeratedItems.map((item) => [item.nodeId, item]));
  const reenumeratedItemsByNodeId = new Map<GitHubNodeId, EnumeratedGitHubItem>();
  const analysisSources: RuntimeItemAnalysisSource[] = [];
  for (const item of enumeratedItems) {
    if (detailNodeIds.has(item.nodeId)) {
      const observation = freshObservedItemsByNodeId.get(item.nodeId);
      const detail = detailsByNodeId.get(item.nodeId);
      assertNonNullable(observation, `fresh観測値がありません。対象: ${item.nodeId}`);
      assertNonNullable(detail, `fresh詳細がありません。対象: ${item.nodeId}`);
      const resolved = await replayFreshItemWithResponsibilityRetry(
        adapters,
        invocation,
        configuration,
        authentication,
        repository,
        item,
        detail,
        observation,
        isBot,
      );
      analysisSources.push(resolved.source);
      detailsByNodeId.set(resolved.detail.nodeId, resolved.detail);
      freshObservedItemsByNodeId.set(resolved.observation.nodeId, resolved.observation);
      if (resolved.reenumeration === "performed") {
        enumeratedItemsByNodeId.set(resolved.reenumeratedItem.nodeId, resolved.reenumeratedItem);
        reenumeratedItemsByNodeId.set(resolved.reenumeratedItem.nodeId, resolved.reenumeratedItem);
      }
      continue;
    }
    const source = cachedSourcesByNodeId.get(item.nodeId);
    assertNonNullable(source, `warm解析sourceがありません。対象: ${item.nodeId}`);
    analysisSources.push(source);
  }
  const finalDetails = details.map((detail) => {
    const replacement = detailsByNodeId.get(detail.nodeId);
    assertNonNullable(replacement, `fresh詳細の最終値がありません。対象: ${detail.nodeId}`);
    return replacement;
  });
  const changedNodeIds = new Set(plan.changedItemNodeIds);
  for (const nodeId of reenumeratedItemsByNodeId.keys()) {
    changedNodeIds.add(nodeId);
  }
  return Object.freeze({
    enumeratedItems: Object.freeze(
      enumeratedItems.map((item) => {
        const replacement = enumeratedItemsByNodeId.get(item.nodeId);
        assertNonNullable(replacement, `fresh列挙値の最終値がありません。対象: ${item.nodeId}`);
        return replacement;
      }),
    ),
    reenumeratedItems: Object.freeze([...reenumeratedItemsByNodeId.values()]),
    details: Object.freeze(finalDetails),
    observedItems: Object.freeze(analysisSources.map((source) => source.item)),
    analysisSources: Object.freeze(analysisSources),
    changedNodeIds: Object.freeze([...changedNodeIds]),
    diagnostics: Object.freeze(diagnostics),
  });
}

function rebaseFreshRepositoryItemCollectionWithDetailVolatileMetadata(
  provisionalItems: readonly EnumeratedGitHubItem[],
  probeFinalized: ReturnType<typeof finalizeGitHubItemsWithVolatileMetadata>,
  collection: FreshRepositoryItemCollection,
  configuration: RuntimeConfiguration,
): FreshRepositoryItemCollection {
  const volatileMetadataByNodeId = new Map(probeFinalized.volatileMetadataByNodeId);
  for (const detail of collection.details) {
    if (detail.type !== "pull_request") {
      continue;
    }
    const metadata = volatileMetadataByNodeId.get(detail.nodeId);
    assertNonNullable(
      metadata,
      `詳細取得したPull Requestのvolatile metadataがありません。対象: ${detail.nodeId}`,
    );
    volatileMetadataByNodeId.set(
      detail.nodeId,
      createGitHubPullRequestVolatileMetadataFromDetail(detail),
    );
  }
  const baseItemsByNodeId = new Map(provisionalItems.map((item) => [item.nodeId, item]));
  for (const item of collection.reenumeratedItems) {
    baseItemsByNodeId.set(item.nodeId, item);
  }
  const finalized = finalizeGitHubItemsWithVolatileMetadata({
    items: [...baseItemsByNodeId.values()],
    volatileMetadata: [...volatileMetadataByNodeId.values()],
  });
  const finalizedItemsByNodeId = new Map(finalized.items.map((item) => [item.nodeId, item]));
  const freshSources = collection.analysisSources.filter(
    (source): source is Extract<RuntimeItemAnalysisSource, { kind: "fresh" }> =>
      source.kind === "fresh",
  );
  const freshItems = freshSources.map((source) => {
    const item = finalizedItemsByNodeId.get(source.item.nodeId);
    assertNonNullable(item, `詳細取得したitemの最終値がありません。対象: ${source.item.nodeId}`);
    return item;
  });
  const freshObservedItems = normalizeObservedGitHubItems({
    items: freshItems,
    details: freshSources.map((source) => source.detail),
    isBot: createGitHubBotPredicate(configuration.config.actors.bots),
  });
  const freshObservedItemsByNodeId = new Map(freshObservedItems.map((item) => [item.nodeId, item]));
  const previousItemsByNodeId = new Map(probeFinalized.items.map((item) => [item.nodeId, item]));
  const changedNodeIds = new Set(collection.changedNodeIds);
  const analysisSources = collection.analysisSources.map((source): RuntimeItemAnalysisSource => {
    if (source.kind === "cached") {
      return source;
    }
    const item = finalizedItemsByNodeId.get(source.item.nodeId);
    const observation = freshObservedItemsByNodeId.get(source.item.nodeId);
    const previousItem = previousItemsByNodeId.get(source.item.nodeId);
    assertNonNullable(item, `詳細取得したitemの最終値がありません。対象: ${source.item.nodeId}`);
    assertNonNullable(
      observation,
      `詳細取得したfresh観測値がありません。対象: ${source.item.nodeId}`,
    );
    assertNonNullable(previousItem, `probe後のitemがありません。対象: ${source.item.nodeId}`);
    if (item.itemFingerprint !== previousItem.itemFingerprint) {
      changedNodeIds.add(source.item.nodeId);
    }
    return Object.freeze({
      kind: "fresh",
      item: observation,
      detail: source.detail,
      relationMutations: source.relationMutations,
      replay: replayGitHubItemHistory({
        item,
        detail: source.detail,
        trackingStartAt: trackingSelectionStartAt(configuration),
        isBot: createGitHubBotPredicate(configuration.config.actors.bots),
      }),
    });
  });
  return Object.freeze({
    enumeratedItems: finalized.items,
    reenumeratedItems: collection.reenumeratedItems,
    details: collection.details,
    observedItems: Object.freeze(analysisSources.map((source) => source.item)),
    analysisSources: Object.freeze(analysisSources),
    changedNodeIds: Object.freeze([...changedNodeIds]),
    diagnostics: collection.diagnostics,
  });
}

async function collectRepositoryItemObservationsWithVolatileMetadata(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  provisionalItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
): Promise<FreshRepositoryItemCollection> {
  const pullRequestNodeIds = provisionalItems.flatMap((item) =>
    item.type === "pull_request" ? [item.nodeId] : [],
  );
  if (pullRequestNodeIds.length === 0) {
    return collectFreshRepositoryItemObservations(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repository,
      provisionalItems,
      adjacentNodeIds,
    );
  }
  let successfulCollection: FreshRepositoryItemCollection | undefined;
  await adapters.probeGitHubPullRequestVolatileMetadataWithRetry({
    pullRequestNodeIds,
    graphql: authentication.graphql,
    runtime: {
      sleep: adapters.sleep,
    },
    validateDetail: async (probe) => {
      const probeFinalized = finalizeGitHubItemsWithVolatileMetadata({
        items: provisionalItems,
        volatileMetadata: probe.items,
      });
      const collection = await collectFreshRepositoryItemObservations(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        probeFinalized.items,
        adjacentNodeIds,
      );
      successfulCollection = rebaseFreshRepositoryItemCollectionWithDetailVolatileMetadata(
        provisionalItems,
        probeFinalized,
        collection,
        configuration,
      );
    },
  });
  assertNonNullable(
    successfulCollection,
    "Pull Request volatile metadataのdetail照合結果がありません",
  );
  return successfulCollection;
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
  const itemCollection = await collectRepositoryItemObservationsWithVolatileMetadata(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repository,
    enumeratedItems,
    adjacentNodeIds,
  );
  const provisionalItemsByNodeId = new Map(enumeratedItems.map((item) => [item.nodeId, item]));
  for (const item of itemCollection.reenumeratedItems) {
    provisionalItemsByNodeId.set(item.nodeId, item);
  }
  return Object.freeze({
    state: createSnapshotCollectionRepository(
      repository,
      invocation.startedAt,
      itemCollection.enumeratedItems,
    ),
    provisionalEnumeratedItems: Object.freeze([...provisionalItemsByNodeId.values()]),
    ...itemCollection,
  });
}

function validateRelationExpansionEnumeration(
  repository: PublicRepository,
  requestedTargets: readonly RelationExpansionTarget[],
  enumeratedItems: readonly EnumeratedGitHubItem[],
): void {
  const requestedTargetsByNodeId = new Map<GitHubNodeId, RelationExpansionTarget>();
  for (const target of requestedTargets) {
    if (requestedTargetsByNodeId.has(target.nodeId)) {
      throw new TypeError("関係先の個別取得対象node IDが重複しています");
    }
    requestedTargetsByNodeId.set(target.nodeId, target);
  }
  if (enumeratedItems.length !== requestedTargets.length) {
    throw new TypeError("関係先の個別列挙結果と要求対象の件数が一致しません");
  }
  for (const item of enumeratedItems) {
    const target = requestedTargetsByNodeId.get(item.nodeId);
    if (
      target == null ||
      item.repositoryId !== repository.id ||
      item.type !== target.type ||
      item.number !== target.number ||
      item.url !== target.url
    ) {
      throw new TypeError(
        "関係先の個別列挙結果が要求したrepository、node ID、種別、番号、URLに一致しません",
      );
    }
  }
}

function mergeFreshRepositoryRuntimeCollection(
  repository: PublicRepository,
  invocation: DailyRunInvocation,
  current: FreshRepositoryRuntimeCollection,
  provisionalItems: readonly EnumeratedGitHubItem[],
  additions: FreshRepositoryItemCollection,
): FreshRepositoryRuntimeCollection {
  const mergedEnumeratedItems = deduplicateByStableId(
    [...current.enumeratedItems, ...additions.enumeratedItems],
    (item) => item.nodeId,
  );
  const mergedProvisionalEnumeratedItems = deduplicateByStableId(
    [
      ...current.provisionalEnumeratedItems,
      ...provisionalItems,
      ...additions.enumeratedItems,
      ...additions.reenumeratedItems,
    ],
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
  const mergedAnalysisSources = deduplicateByStableId(
    [...current.analysisSources, ...additions.analysisSources],
    (source) => source.item.nodeId,
  );
  const changedNodeIds = new Set([...current.changedNodeIds, ...additions.changedNodeIds]);
  return Object.freeze({
    state: createSnapshotCollectionRepository(
      repository,
      invocation.startedAt,
      mergedEnumeratedItems,
    ),
    provisionalEnumeratedItems: mergedProvisionalEnumeratedItems,
    reenumeratedItems: deduplicateByStableId(
      [...current.reenumeratedItems, ...additions.reenumeratedItems],
      (item) => item.nodeId,
    ),
    enumeratedItems: mergedEnumeratedItems,
    details: mergedDetails,
    observedItems: mergedObservedItems,
    analysisSources: mergedAnalysisSources,
    changedNodeIds: Object.freeze([...changedNodeIds]),
    diagnostics: Object.freeze([...current.diagnostics, ...additions.diagnostics]),
  });
}

function synchronizeFreshRepositoryCollectionResults(
  freshCollectionsByRepositoryId: ReadonlyMap<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): void {
  for (const [repositoryId, collection] of freshCollectionsByRepositoryId) {
    const result = repositoryResultsById.get(repositoryId);
    assertNonNullable(
      result,
      `関係候補抽出後のrepository収集結果がありません。対象: ${repositoryId}`,
    );
    if (result.freshness === "stale") {
      throw new TypeError(`関係候補抽出後のrepository収集結果がstaleです。対象: ${repositoryId}`);
    }
    repositoryResultsById.set(
      repositoryId,
      Object.freeze({
        ...result,
        value: collection.state,
      }),
    );
  }
}

async function collectAdditionalRelationItems(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  requestedTargets: readonly RelationExpansionTarget[],
  preEnumeratedItems: readonly EnumeratedGitHubItem[],
  current: FreshRepositoryRuntimeCollection,
): Promise<FreshRepositoryRuntimeCollection> {
  const currentItemsByNodeId = new Map(current.enumeratedItems.map((item) => [item.nodeId, item]));
  const currentProvisionalItemsByNodeId = new Map(
    current.provisionalEnumeratedItems.map((item) => [item.nodeId, item]),
  );
  const preEnumeratedItemsByNodeId = new Map(preEnumeratedItems.map((item) => [item.nodeId, item]));
  if (preEnumeratedItemsByNodeId.size !== preEnumeratedItems.length) {
    throw new TypeError("関係先のpre-enumerated item node IDが重複しています");
  }
  const targetsMissingFromCurrent = requestedTargets.filter(
    (target) => !currentItemsByNodeId.has(target.nodeId),
  );
  const missingTargets = targetsMissingFromCurrent.filter(
    (target) => !preEnumeratedItemsByNodeId.has(target.nodeId),
  );
  const individuallyEnumeratedItems =
    missingTargets.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist: createPublicRepositoryAllowlist([repository]),
          identifiers: missingTargets.map((target) => target.url),
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  validateRelationExpansionEnumeration(repository, missingTargets, individuallyEnumeratedItems);
  const individuallyEnumeratedItemsByNodeId = new Map(
    individuallyEnumeratedItems.map((item) => [item.nodeId, item]),
  );
  const preEnumeratedAndIndividuallyEnumeratedItemsByNodeId = new Map([
    ...preEnumeratedItemsByNodeId,
    ...individuallyEnumeratedItemsByNodeId,
  ]);
  const missingItems = targetsMissingFromCurrent.map((target) => {
    const item = preEnumeratedAndIndividuallyEnumeratedItemsByNodeId.get(target.nodeId);
    assertNonNullable(item, `関係先追加取得対象の列挙値がありません。対象: ${target.nodeId}`);
    return item;
  });
  validateRelationExpansionEnumeration(repository, targetsMissingFromCurrent, missingItems);
  const detailTargets = requestedTargets.map((target) => {
    const item =
      currentProvisionalItemsByNodeId.get(target.nodeId) ??
      preEnumeratedAndIndividuallyEnumeratedItemsByNodeId.get(target.nodeId);
    assertNonNullable(item, `関係先追加取得対象の列挙値がありません。対象: ${target.nodeId}`);
    return item;
  });
  validateRelationExpansionEnumeration(repository, requestedTargets, detailTargets);
  const additions = await collectRepositoryItemObservationsWithVolatileMetadata(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repository,
    detailTargets,
    new Set(requestedTargets.map((target) => target.nodeId)),
  );
  return mergeFreshRepositoryRuntimeCollection(
    repository,
    invocation,
    current,
    detailTargets,
    additions,
  );
}

function aggregateFreshRepositoryCollections(
  allowlist: PublicRepositoryAllowlist,
  freshCollectionsByRepositoryId: ReadonlyMap<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
): FreshRuntimeCollectionAggregate {
  const enumeratedItems: EnumeratedGitHubItem[] = [];
  const details: GitHubItemDetail[] = [];
  const observedItems: RuntimeObservedGitHubItem[] = [];
  const analysisSources: RuntimeItemAnalysisSource[] = [];
  const changedNodeIds = new Set<GitHubNodeId>();
  const diagnostics: string[] = [];
  for (const repository of allowlist.repositories) {
    const collection = freshCollectionsByRepositoryId.get(repository.id);
    if (collection == null) {
      continue;
    }
    enumeratedItems.push(...collection.enumeratedItems);
    details.push(...collection.details);
    observedItems.push(...collection.observedItems);
    analysisSources.push(...collection.analysisSources);
    diagnostics.push(...collection.diagnostics);
    for (const nodeId of collection.changedNodeIds) {
      changedNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    enumeratedItems: deduplicateByStableId(enumeratedItems, (item) => item.nodeId),
    details: deduplicateByStableId(details, (detail) => detail.nodeId),
    observedItems: deduplicateByStableId(observedItems, (item) => item.nodeId),
    analysisSources: deduplicateByStableId(analysisSources, (source) => source.item.nodeId),
    changedNodeIds,
    diagnostics: Object.freeze(diagnostics),
  });
}

function collectedTrackingCandidateNodeIds(
  state: RuntimeState,
  aggregate: FreshRuntimeCollectionAggregate,
): ReadonlySet<GitHubNodeId> {
  const enumeratedNodeIds = new Set(aggregate.enumeratedItems.map((item) => item.nodeId));
  const candidateNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  for (const item of loadedItemCacheDocuments(state)) {
    if (enumeratedNodeIds.has(item.nodeId)) {
      candidateNodeIds.add(item.nodeId);
    }
  }
  return candidateNodeIds;
}

function exactAiRefreshNodeIds(
  aggregate: FreshRuntimeCollectionAggregate,
  candidates: readonly RelationCandidate[],
): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  for (const source of aggregate.analysisSources) {
    if (source.kind !== "cached") {
      continue;
    }
    const currentCandidates = candidatesForNode(source.item.nodeId, candidates);
    const currentCandidateIds = currentCandidates.map((candidate) => candidate.id).sort();
    const inferredCandidateIds = new Set(
      selectRelationAssessmentCandidates(source.item.nodeId, currentCandidates)
        .filter((candidate) => candidate.authority === "inferred")
        .map((candidate) => candidate.id),
    );
    if (source.exactAi == null) {
      if (inferredCandidateIds.size > 0) {
        nodeIds.add(source.item.nodeId);
      }
      continue;
    }
    const assessedCandidateIds = new Set(
      source.exactAi.output.relations.map((relation) => relation.candidateId),
    );
    if (
      source.exactAi.fingerprint.graphNeighborhoodHash !== hashCanonicalJson(currentCandidateIds) ||
      [...inferredCandidateIds].some((candidateId) => !assessedCandidateIds.has(candidateId))
    ) {
      nodeIds.add(source.item.nodeId);
    }
  }
  return nodeIds;
}

type RelationExpansionTargetSelection = Readonly<{
  repository: PublicRepository;
  target: RelationExpansionTarget;
}>;

type RelationExpansionBatchRepositoryInput = Readonly<{
  targets: readonly RelationExpansionTarget[];
  preEnumeratedItems: readonly EnumeratedGitHubItem[];
}>;

function relationExpansionTargetFromCandidate(
  node: Extract<RelationCandidateNode, { scope: "organization" }>,
): RelationExpansionTarget {
  return Object.freeze({
    nodeId: node.nodeId,
    type: node.kind,
    number: node.number,
    url: node.url,
  });
}

function relationExpansionTargetFromItem(item: EnumeratedGitHubItem): RelationExpansionTarget {
  return Object.freeze({
    nodeId: item.nodeId,
    type: item.type,
    number: item.number,
    url: item.url,
  });
}

function sameRelationExpansionTarget(
  left: RelationExpansionTarget,
  right: RelationExpansionTarget,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.type === right.type &&
    left.number === right.number &&
    left.url === right.url
  );
}

function relationExpansionTargetsByNodeId(
  candidates: readonly RelationCandidate[],
  allowlist: PublicRepositoryAllowlist,
): ReadonlyMap<GitHubNodeId, RelationExpansionTargetSelection> {
  const targetsByNodeId = new Map<GitHubNodeId, RelationExpansionTargetSelection>();
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
      const target = relationExpansionTargetFromCandidate(node);
      const existing = targetsByNodeId.get(node.nodeId);
      if (
        existing != null &&
        (existing.repository.id !== repository.id ||
          !sameRelationExpansionTarget(existing.target, target))
      ) {
        throw new TypeError("同じ関係先node IDに異なるrepositoryまたはURLが指定されています");
      }
      targetsByNodeId.set(node.nodeId, Object.freeze({ repository, target }));
    }
  }
  return targetsByNodeId;
}

type AllowlistedCurrentRelationReferenceGroup = Readonly<{
  key: string;
  repository: PublicRepository;
  references: readonly RelationTextReference[];
}>;

function relationReferenceKeyForEnumeratedItem(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
): string {
  return createRelationMutationReferenceKey({
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    itemType: item.type,
    number: item.number,
  });
}

function collectAllowlistedCurrentRelationReferenceGroups(
  currentReferencesBySourceItemNodeId: ReadonlyMap<
    GitHubNodeId,
    ReadonlyMap<SourceId, CurrentRelationReferences>
  >,
  canonicalReferencesByReferenceKey: ReadonlyMap<string, RelationTextReference>,
  aggregate: FreshRuntimeCollectionAggregate,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  repositoryResultsById: ReadonlyMap<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
  requestedKeys: ReadonlySet<string>,
): readonly AllowlistedCurrentRelationReferenceGroup[] {
  const knownReferenceTargets = new Map<
    string,
    Readonly<{
      repository: PublicRepository;
      item: EnumeratedGitHubItem;
    }>
  >();
  for (const item of aggregate.enumeratedItems) {
    const repository = allowlist.require(item.repositoryId);
    const key = relationReferenceKeyForEnumeratedItem(item, repository);
    const existing = knownReferenceTargets.get(key);
    if (existing != null && existing.item.nodeId !== item.nodeId) {
      throw new TypeError("既知の関係参照keyに異なる項目が対応しています");
    }
    knownReferenceTargets.set(key, Object.freeze({ repository, item }));
  }

  const groups = new Map<
    string,
    {
      repository: PublicRepository;
      references: RelationTextReference[];
    }
  >();
  for (const referencesByContentSource of currentReferencesBySourceItemNodeId.values()) {
    for (const current of referencesByContentSource.values()) {
      if (current.status !== "available") {
        continue;
      }
      for (const reference of current.references) {
        if (reference.repositoryOwner.toLowerCase() !== organization.toLowerCase()) {
          continue;
        }
        let canonicalReference = canonicalReferencesByReferenceKey.get(
          createRelationMutationReferenceKey(reference),
        );
        if (canonicalReference == null) {
          if (!isExactAllowlistedRelationReference(reference, organization, allowlist)) {
            continue;
          }
          canonicalReference = reference;
        }
        const repository = allowlist.repositories.find(
          (candidate) =>
            candidate.owner.toLowerCase() === canonicalReference.repositoryOwner.toLowerCase() &&
            candidate.name.toLowerCase() === canonicalReference.repositoryName.toLowerCase(),
        );
        if (repository == null) {
          continue;
        }
        const repositoryResult = repositoryResultsById.get(repository.id);
        assertNonNullable(repositoryResult, "current関係参照のrepository収集結果がありません");
        if (repositoryResult.freshness === "stale") {
          continue;
        }
        const key = createRelationMutationReferenceKey(canonicalReference);
        const knownReferenceTarget = knownReferenceTargets.get(key);
        if (knownReferenceTarget != null) {
          assertAllowlistedCurrentRelationItem(
            knownReferenceTarget.repository,
            canonicalReference,
            knownReferenceTarget.item,
          );
          continue;
        }
        if (requestedKeys.has(key)) {
          throw new TypeError(`関係参照の個別取得後も列挙結果がありません。対象: ${key}`);
        }
        const existing = groups.get(key);
        if (existing == null) {
          groups.set(key, {
            repository,
            references: [canonicalReference],
          });
          continue;
        }
        if (existing.repository.id !== repository.id) {
          throw new TypeError(`関係参照keyに異なるrepositoryが対応しています。対象: ${key}`);
        }
        if (
          existing.references.some(
            (candidate) =>
              candidate.itemType != null &&
              canonicalReference.itemType != null &&
              candidate.itemType !== canonicalReference.itemType,
          )
        ) {
          throw new TypeError(`同じ関係参照に異なる項目種別が指定されています。対象: ${key}`);
        }
        if (
          !existing.references.some(
            (candidate) => createRelationMutationReferenceKey(candidate) === key,
          )
        ) {
          existing.references.push(canonicalReference);
        } else if (
          existing.references[0]?.itemType == null &&
          canonicalReference.itemType != null
        ) {
          existing.references[0] = canonicalReference;
        }
      }
    }
  }
  return Object.freeze(
    [...groups.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, group]) =>
        Object.freeze({
          key,
          repository: group.repository,
          references: Object.freeze(group.references),
        }),
      ),
  );
}

function assertAllowlistedCurrentRelationItem(
  repository: PublicRepository,
  reference: RelationTextReference,
  item: EnumeratedGitHubItem,
): void {
  if (
    item.repositoryId !== repository.id ||
    item.number !== reference.number ||
    (reference.itemType != null && item.type !== reference.itemType)
  ) {
    throw new TypeError("関係参照の個別列挙結果が要求したrepository、番号、種別に一致しません");
  }
  const expectedUrl = `https://github.com/${repository.owner}/${repository.name}/${
    item.type === "issue" ? "issues" : "pull"
  }/${reference.number.toString()}`;
  if (item.url.toLowerCase() !== expectedUrl.toLowerCase()) {
    throw new TypeError("関係参照の個別列挙結果のowner、repository名、URLが一致しません");
  }
}

async function enumerateAllowlistedCurrentRelationReferences(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  authentication: GitHubClient,
  groups: readonly AllowlistedCurrentRelationReferenceGroup[],
): Promise<ReadonlyMap<GitHubRepositoryId, RelationExpansionBatchRepositoryInput>> {
  const groupsByRepositoryId = new Map<
    GitHubRepositoryId,
    AllowlistedCurrentRelationReferenceGroup[]
  >();
  for (const group of groups) {
    const repositoryGroups = groupsByRepositoryId.get(group.repository.id);
    if (repositoryGroups == null) {
      groupsByRepositoryId.set(group.repository.id, [group]);
    } else {
      repositoryGroups.push(group);
    }
  }

  const inputsByRepositoryId = new Map<
    GitHubRepositoryId,
    {
      targets: RelationExpansionTarget[];
      preEnumeratedItems: EnumeratedGitHubItem[];
    }
  >();
  const enumeratedNodeIds = new Set<GitHubNodeId>();
  for (const repositoryGroups of groupsByRepositoryId.values()) {
    const repository = repositoryGroups[0]?.repository;
    assertNonNullable(repository, "allowlist内current関係参照のrepositoryがありません");
    const identifiers = repositoryGroups.map((group) => {
      const reference = group.references[0];
      assertNonNullable(reference, "allowlist内current関係参照のreferenceがありません");
      return `https://github.com/${repository.owner}/${repository.name}/issues/${reference.number.toString()}`;
    });
    const items = await adapters.enumerateGitHubItemsByIdentifiers({
      allowlist: createPublicRepositoryAllowlist([repository]),
      identifiers,
      observedAt: invocation.startedAt,
      request: authentication.request,
      graphql: authentication.graphql,
    });
    if (items.length !== repositoryGroups.length) {
      throw new TypeError("allowlist内current関係参照の個別列挙結果件数が一致しません");
    }
    const groupsByNumber = new Map<number, AllowlistedCurrentRelationReferenceGroup>();
    for (const group of repositoryGroups) {
      const reference = group.references[0];
      assertNonNullable(reference, "allowlist内current関係参照のreferenceがありません");
      if (groupsByNumber.has(reference.number)) {
        throw new TypeError("allowlist内current関係参照の番号が重複しています");
      }
      groupsByNumber.set(reference.number, group);
    }
    const itemsByGroupKey = new Map<string, EnumeratedGitHubItem>();
    for (const item of items) {
      const group = groupsByNumber.get(item.number);
      assertNonNullable(group, "allowlist内current関係参照の列挙結果番号が不正です");
      const reference = group.references[0];
      assertNonNullable(reference, "allowlist内current関係参照のreferenceがありません");
      assertAllowlistedCurrentRelationItem(repository, reference, item);
      if (itemsByGroupKey.has(group.key)) {
        throw new TypeError("allowlist内current関係参照の列挙結果が重複しています");
      }
      itemsByGroupKey.set(group.key, item);
    }
    if (itemsByGroupKey.size !== repositoryGroups.length) {
      throw new TypeError("allowlist内current関係参照の列挙結果が不足しています");
    }
    const input: {
      targets: RelationExpansionTarget[];
      preEnumeratedItems: EnumeratedGitHubItem[];
    } = {
      targets: [],
      preEnumeratedItems: [],
    };
    for (const group of repositoryGroups) {
      const item = itemsByGroupKey.get(group.key);
      assertNonNullable(
        item,
        `allowlist内current関係参照の列挙結果がありません。対象: ${group.key}`,
      );
      if (enumeratedNodeIds.has(item.nodeId)) {
        throw new TypeError("allowlist内current関係参照の列挙結果node IDが重複しています");
      }
      enumeratedNodeIds.add(item.nodeId);
      input.preEnumeratedItems.push(item);
      input.targets.push(relationExpansionTargetFromItem(item));
    }
    inputsByRepositoryId.set(repository.id, input);
  }
  return new Map(
    [...inputsByRepositoryId.entries()].map(([repositoryId, input]) => [
      repositoryId,
      Object.freeze({
        targets: Object.freeze(input.targets),
        preEnumeratedItems: Object.freeze(input.preEnumeratedItems),
      }),
    ]),
  );
}

async function collectRelationExpansionBatch(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  allowlist: PublicRepositoryAllowlist,
  inputsByRepositoryId: ReadonlyMap<GitHubRepositoryId, RelationExpansionBatchRepositoryInput>,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<void> {
  const targetRepositories = allowlist.repositories.filter((repository) =>
    inputsByRepositoryId.has(repository.id),
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
      const input = inputsByRepositoryId.get(repository.id);
      assertNonNullable(input, "関係先追加取得対象がありません");
      const current = freshCollectionsByRepositoryId.get(repository.id);
      assertNonNullable(current, "関係先追加取得対象の最新repository収集結果がありません");
      const expanded = await collectAdditionalRelationItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        input.targets,
        input.preEnumeratedItems,
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

async function collectAllowlistedCurrentRelationExpansionBatch(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  allowlist: PublicRepositoryAllowlist,
  groupsByRepositoryId: ReadonlyMap<
    GitHubRepositoryId,
    readonly AllowlistedCurrentRelationReferenceGroup[]
  >,
  expandedNodeIds: Set<GitHubNodeId>,
  maximumItemCount: number,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<void> {
  const targetRepositories = allowlist.repositories.filter((repository) => {
    if (!groupsByRepositoryId.has(repository.id)) {
      return false;
    }
    const result = repositoryResultsById.get(repository.id);
    assertNonNullable(result, "allowlist内current関係参照のrepository収集結果がありません");
    return result.freshness === "fresh";
  });
  const expandedCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const results = await collectRepositoriesWithStaleFallback({
    allowlist: createPublicRepositoryAllowlist(targetRepositories),
    observedAt: invocation.startedAt,
    previousValues: previousRepositoryValues(state),
    collect: async (repository) => {
      const groups = groupsByRepositoryId.get(repository.id);
      assertNonNullable(groups, "allowlist内current関係参照の対象がありません");
      const enumeratedInputs = await enumerateAllowlistedCurrentRelationReferences(
        adapters,
        invocation,
        authentication,
        groups,
      );
      const input = enumeratedInputs.get(repository.id);
      assertNonNullable(input, "allowlist内current関係参照の個別列挙結果がありません");
      const targets = input.targets.filter((target) => !expandedNodeIds.has(target.nodeId));
      if (expandedNodeIds.size + targets.length > maximumItemCount) {
        throw new CliRelationExpansionLimitError(
          maximumItemCount,
          expandedNodeIds.size,
          targets.length,
          {},
        );
      }
      for (const target of targets) {
        expandedNodeIds.add(target.nodeId);
      }
      const current = freshCollectionsByRepositoryId.get(repository.id);
      assertNonNullable(current, "allowlist内current関係参照の最新repository収集結果がありません");
      const expanded = await collectAdditionalRelationItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        input.targets,
        input.preEnumeratedItems,
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
    assertNonNullable(expanded, "allowlist内current関係参照後の収集結果がありません");
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
  externalRelationResolutionCache: ExternalRelationResolutionCache,
): Promise<RelationExpandedRuntimeCollection> {
  const requestedNodeIds = new Set<GitHubNodeId>();
  const expandedNodeIds = new Set<GitHubNodeId>();
  const requestedInternalRelationReferenceKeys = new Set<string>();
  const relationReferenceRetryBudget: RelationReferenceRetryBudget = {
    maxRefreshes: Math.min(2, configuration.config.operations.retry.maxAttempts - 1),
    refreshes: 0,
  };
  for (;;) {
    const extractedRelations = await extractAllRelationCandidates(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      freshCollectionsByRepositoryId,
      configuration.config,
      repositoryInventory.allowlist,
      relationReferenceRetryBudget,
      externalRelationResolutionCache,
    );
    const discoveredRelationCandidates = extractedRelations.candidates;
    const aggregate = extractedRelations.aggregate;
    const currentContentBoundaryUnknownSources = collectCurrentContentBoundaryUnknownSources(
      aggregate.analysisSources,
      discoveredRelationCandidates,
      extractedRelations.externalRelationResolution,
      configuration.config.organization,
      repositoryInventory.allowlist,
    );
    const sanitizedRelationCandidates = sanitizeRelationCandidatesForCurrentContentBoundary(
      discoveredRelationCandidates,
      currentContentBoundaryUnknownSources,
    );
    const currentReferencesForExpansion = maskCurrentContentBoundaryUnknownSources(
      extractedRelations.externalRelationResolution.currentReferencesBySourceItemNodeId,
      currentContentBoundaryUnknownSources,
    );
    const allowlistedCurrentRelationGroups = collectAllowlistedCurrentRelationReferenceGroups(
      currentReferencesForExpansion,
      extractedRelations.externalRelationResolution.canonicalReferencesByReferenceKey,
      aggregate,
      configuration.config.organization,
      repositoryInventory.allowlist,
      repositoryResultsById,
      requestedInternalRelationReferenceKeys,
    );
    if (allowlistedCurrentRelationGroups.length > 0) {
      const groupsByRepositoryId = new Map<
        GitHubRepositoryId,
        AllowlistedCurrentRelationReferenceGroup[]
      >();
      for (const group of allowlistedCurrentRelationGroups) {
        const groups = groupsByRepositoryId.get(group.repository.id);
        if (groups == null) {
          groupsByRepositoryId.set(group.repository.id, [group]);
        } else {
          groups.push(group);
        }
      }
      await collectAllowlistedCurrentRelationExpansionBatch(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repositoryInventory.allowlist,
        groupsByRepositoryId,
        expandedNodeIds,
        configuration.config.tracking.relationExpansion.maxItemsPerRun,
        freshCollectionsByRepositoryId,
        repositoryResultsById,
      );
      for (const group of allowlistedCurrentRelationGroups) {
        const result = repositoryResultsById.get(group.repository.id);
        assertNonNullable(result, "allowlist内current関係参照のrepository収集結果がありません");
        if (result.freshness === "fresh") {
          requestedInternalRelationReferenceKeys.add(group.key);
        }
      }
      continue;
    }
    const collectedCandidateNodeIds = collectedTrackingCandidateNodeIds(state, aggregate);
    assertFreshRelationCandidateOriginResolution(
      discoveredRelationCandidates,
      extractedRelations.originProofs,
      extractedRelations.externalRelationResolution.resultsByReferenceKey,
      configuration.config.organization,
      repositoryInventory.allowlist,
    );
    const completedRelationCandidates = completeRelationCandidates(
      sanitizedRelationCandidates,
      collectedCandidateNodeIds,
    );
    const exactAiRefreshes = exactAiRefreshNodeIds(
      aggregate,
      completedRelationCandidates.candidates,
    );
    if (exactAiRefreshes.size > 0) {
      const inputsByRepositoryId = new Map<
        GitHubRepositoryId,
        RelationExpansionBatchRepositoryInput
      >();
      for (const nodeId of exactAiRefreshes) {
        const item = aggregate.enumeratedItems.find((candidate) => candidate.nodeId === nodeId);
        assertNonNullable(item, `exact AI再判定対象の列挙値がありません。対象: ${nodeId}`);
        const target = relationExpansionTargetFromItem(item);
        const input = inputsByRepositoryId.get(item.repositoryId);
        if (input == null) {
          inputsByRepositoryId.set(item.repositoryId, {
            targets: Object.freeze([target]),
            preEnumeratedItems: Object.freeze([]),
          });
        } else {
          inputsByRepositoryId.set(item.repositoryId, {
            targets: Object.freeze([...input.targets, target]),
            preEnumeratedItems: input.preEnumeratedItems,
          });
        }
      }
      await collectRelationExpansionBatch(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repositoryInventory.allowlist,
        inputsByRepositoryId,
        freshCollectionsByRepositoryId,
        repositoryResultsById,
      );
      continue;
    }
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
    const nextRequests = planRelationExpansion({
      collectedCandidateNodeIds,
      trackingRootNodeIds: trackingState.trackingRootNodeIds,
      relationCandidates: sanitizedRelationCandidates,
      nativeDepthByNodeId: trackingState.nativeDepthByNodeId,
      requestedNodeIds,
      maximumNativeDepth: configuration.config.tracking.autoInclude.nativeRelations
        ? configuration.config.tracking.autoInclude.relationDepth
        : 0,
    });
    if (nextRequests.length === 0) {
      const diagnostics = [...aggregate.diagnostics];
      const relationPublicBoundaryRevalidationNodeIds = new Set<GitHubNodeId>();
      const analysisSources = aggregate.analysisSources.map((source) => {
        const currentBoundaryUnknownContentSourceIds =
          currentContentBoundaryUnknownSources.get(source.item.nodeId) ?? new Set<SourceId>();
        const sanitized = sanitizeAnalysisSourceForPublicBoundary(
          source,
          completedRelationCandidates.candidates,
          configuration.config.organization,
          repositoryInventory.allowlist,
          extractedRelations.externalRelationResolution.currentReferencesBySourceItemNodeId,
          extractedRelations.externalRelationResolution
            .verifiedExternalReferencesBySourceItemNodeId,
          extractedRelations.externalRelationResolution.canonicalReferencesByReferenceKey,
          currentBoundaryUnknownContentSourceIds,
        );
        if (sanitized.requiresRelationPublicBoundaryRevalidation) {
          relationPublicBoundaryRevalidationNodeIds.add(source.item.nodeId);
        }
        if (sanitized.unknownContentSourceCount > 0) {
          diagnostics.push(
            `relationMutationUnknown sourceItemNodeId=${source.item.nodeId} reason=repository_public_boundary_unverified count=${sanitized.unknownContentSourceCount.toString()}`,
          );
        }
        return sanitized.source;
      });
      const sanitizedAggregate = Object.freeze({
        ...aggregate,
        analysisSources: Object.freeze(analysisSources),
        diagnostics: Object.freeze(diagnostics),
      });
      assertItemRelationPublicBoundary(
        sanitizedAggregate.analysisSources,
        aggregate.analysisSources,
        completedRelationCandidates.candidates,
        configuration.config.organization,
        repositoryInventory.allowlist,
        extractedRelations.externalRelationResolution.resultsByReferenceKey,
        extractedRelations.originProofs,
      );
      synchronizeFreshRepositoryCollectionResults(
        freshCollectionsByRepositoryId,
        repositoryResultsById,
      );
      return Object.freeze({
        ...sanitizedAggregate,
        evaluatedAt,
        relationCandidates: completedRelationCandidates.candidates,
        droppedRelationCandidateCount: completedRelationCandidates.droppedCount,
        relationPublicBoundaryRevalidationNodeIds,
        tracking,
      });
    }
    const expansionTargetsByNodeId = relationExpansionTargetsByNodeId(
      sanitizedRelationCandidates,
      repositoryInventory.allowlist,
    );
    const inputsByRepositoryId = new Map<
      GitHubRepositoryId,
      RelationExpansionBatchRepositoryInput
    >();
    for (const request of nextRequests) {
      requestedNodeIds.add(request.nodeId);
      const selection = expansionTargetsByNodeId.get(request.nodeId);
      if (selection == null) {
        continue;
      }
      const { repository, target } = selection;
      const repositoryResult = repositoryResultsById.get(repository.id);
      assertNonNullable(repositoryResult, "関係先追加取得対象のrepository収集結果がありません");
      if (repositoryResult.freshness === "stale") {
        continue;
      }
      const input = inputsByRepositoryId.get(repository.id);
      if (input == null) {
        inputsByRepositoryId.set(repository.id, {
          targets: Object.freeze([target]),
          preEnumeratedItems: Object.freeze([]),
        });
      } else {
        inputsByRepositoryId.set(repository.id, {
          targets: Object.freeze([...input.targets, target]),
          preEnumeratedItems: input.preEnumeratedItems,
        });
      }
    }
    const targets = [...inputsByRepositoryId.values()].flatMap((input) => input.targets);
    const maximumItemCount = configuration.config.tracking.relationExpansion.maxItemsPerRun;
    if (expandedNodeIds.size + targets.length > maximumItemCount) {
      throw new CliRelationExpansionLimitError(
        maximumItemCount,
        expandedNodeIds.size,
        targets.length,
        {},
      );
    }
    for (const target of targets) {
      expandedNodeIds.add(target.nodeId);
    }
    if (targets.length === 0) {
      continue;
    }
    await collectRelationExpansionBatch(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repositoryInventory.allowlist,
      inputsByRepositoryId,
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

function finalizeFreshObservedItemObservation(
  item: FreshObservedGitHubItem,
  evaluatedAt: UtcIsoDateTime,
): FreshObservedGitHubItem {
  return Object.freeze({
    ...item,
    observedAt: evaluatedAt,
  } satisfies FreshObservedGitHubItem);
}

function finalizeCachedObservedItemObservation(
  item: CachedObservedGitHubItem,
  evaluatedAt: UtcIsoDateTime,
): CachedObservedGitHubItem {
  return Object.freeze({
    ...item,
    observedAt: evaluatedAt,
  } satisfies CachedObservedGitHubItem);
}

function finalizeRuntimeItemAnalysisSource(
  source: RuntimeItemAnalysisSource,
  evaluatedAt: UtcIsoDateTime,
): RuntimeItemAnalysisSource {
  if (source.kind === "fresh") {
    return Object.freeze({
      kind: "fresh",
      item: finalizeFreshObservedItemObservation(source.item, evaluatedAt),
      detail: finalizeItemDetailObservation(source.detail, evaluatedAt),
      relationMutations: source.relationMutations,
      replay: source.replay,
    });
  }
  return Object.freeze({
    ...source,
    item: finalizeCachedObservedItemObservation(source.item, evaluatedAt),
  });
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
  const adjacentNodeIds = new Set<GitHubNodeId>();
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
  const externalRelationResolutionCache: ExternalRelationResolutionCache = new Map();
  const expanded = await collectRelationExpandedItems(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repositoryInventory,
    freshCollectionsByRepositoryId,
    repositoryResultsById,
    externalRelationResolutionCache,
  );
  const repositoryResults = Object.freeze(
    repositoryInventory.allowlist.repositories.map((repository) => {
      const result = repositoryResultsById.get(repository.id);
      assertNonNullable(result, `repository収集結果がありません。対象: ${repository.id}`);
      return finalizeRepositoryCollectionResult(result, expanded.evaluatedAt);
    }),
  );

  const collectionRepositories: SnapshotCollectionRepository[] = [];
  const staleRepositoryIds = new Set<GitHubRepositoryId>();
  const diagnostics: string[] = [...expanded.diagnostics];
  for (const result of repositoryResults) {
    if (result.freshness === "fresh") {
      collectionRepositories.push(result.value);
      continue;
    }
    staleRepositoryIds.add(result.repository.id);
    collectionRepositories.push(result.previousValue);
    diagnostics.push(result.diagnostic.message);
  }
  const restoredStaleDisplaySources = restoreStaleDisplayItemSources(state, repositoryResults);
  const staleDisplaySources = await validateStaleDisplayExternalRelationCandidates(
    adapters.resolveGitHubRelationReference,
    authentication,
    configuration.config.organization,
    repositoryInventory.allowlist,
    restoredStaleDisplaySources,
    externalRelationResolutionCache,
  );
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
  const uniqueAnalysisSources = Object.freeze(
    expanded.analysisSources.map((source) =>
      finalizeRuntimeItemAnalysisSource(source, expanded.evaluatedAt),
    ),
  );
  const uniqueObservedItems = Object.freeze(uniqueAnalysisSources.map((source) => source.item));
  const freshNodeIds = new Set(uniqueObservedItems.map((item) => item.nodeId));
  for (const source of staleDisplaySources) {
    if (freshNodeIds.has(source.item.nodeId)) {
      throw new TypeError(
        `fresh項目とstale表示項目のnode IDが重複しています。対象: ${source.item.nodeId}`,
      );
    }
  }
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
  for (const source of staleDisplaySources) {
    trackedNodeIds.add(source.item.nodeId);
  }
  const exactAiRelationNotificationHistory = createExactAiRelationNotificationHistory(
    configuration,
    state,
    expanded.evaluatedAt,
    trackedNodeIds,
    staleRepositoryIds,
    diagnostics,
  );
  const observedNodeIds = new Set(uniqueObservedItems.map((item) => item.nodeId));
  const analysisNodeIds = new Set<GitHubNodeId>();
  for (const [nodeId] of tracking.workByNodeId) {
    if (observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    value: Object.freeze({
      evaluatedAt: expanded.evaluatedAt,
      enumeratedItems: uniqueEnumeratedItems,
      details: uniqueDetails,
      observedItems: uniqueObservedItems,
      analysisSources: uniqueAnalysisSources,
      staleDisplaySources,
      trackedNodeIds,
      trackingNotificationClassByNodeId,
      analysisNodeIds,
      changedNodeIds,
      relationPublicBoundaryRevalidationNodeIds: expanded.relationPublicBoundaryRevalidationNodeIds,
      externalReferences: tracking.result.ghostNodes,
      relationCandidates,
      exactAiRelationNotificationHistory,
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
    loadCaches: async ({ invocation, configuration, repositoryInventory }) => {
      const session = await adapters.openCacheSession(
        adapters.createStateBranchAdapter(),
        configuration.config.state,
        repositoryInventory.allowlist,
      );
      const loaded = await session.load({
        evaluatedAt: invocation.startedAt,
        knownSecrets: configuration.credentials.knownSecrets,
      });
      const aiCache = new MemoryAiCacheStore();
      if (loaded.status === "available") {
        for (const entry of loaded.aiCacheEntries) {
          await aiCache.write(entry);
        }
      }
      return Object.freeze({
        session,
        loaded,
        aiCache,
        allowlist: repositoryInventory.allowlist,
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
      cache: state,
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
    applyDeterministicRules: ({ configuration, cache: state, repositoryInventory, collection }) =>
      Promise.resolve(
        applyDeterministicAnalysis(configuration, state, repositoryInventory, collection),
      ),
    analyzeWithCodex: async ({
      configuration,
      cache: state,
      collection,
      deterministicAnalysis,
    }) => {
      const analysis = await analyzeCodex(
        adapters,
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
          deterministicAnalysis.inventory,
          collection,
          deterministicAnalysis,
          codexAnalysis,
        ),
      ),
    reconcileGraph: ({ configuration, collection, reduction }) => {
      const graph = reconcileCurrentGraph(configuration, collection, reduction);
      return Promise.resolve(
        Object.freeze({
          value: graph,
          activeEdgeCount: graph.analysisEdges.filter((edge) => edge.active).length,
        }),
      );
    },
    validateCompleteness: ({
      invocation,
      configuration,
      cache: state,
      repositoryInventory,
      collection,
      deterministicAnalysis,
      codexAnalysis,
      reduction,
      graph,
    }) =>
      Promise.resolve(
        Object.freeze({
          status: "complete",
          value: validateRunCompleteness(
            invocation,
            normalDigestRunContext(adapters.environment, invocation.scheduledFor),
            configuration,
            state,
            repositoryInventory,
            collection,
            deterministicAnalysis,
            codexAnalysis,
            reduction,
            graph,
          ),
          diagnostics: Object.freeze([]),
        }),
      ),
    persistCache: async ({ configuration, cache: state, validated }) => {
      await persistValidatedRun(configuration, state, validated);
    },
    buildPages: ({ configuration, repositoryInventory, validated }) =>
      buildPublicPages(
        adapters,
        configuration.config,
        repositoryInventory.inventory,
        repositoryInventory.allowlist.repositories,
        validated,
        adapters.pagesOutputDirectory,
        configuration.credentials.knownSecrets,
      ),
    sendDiscord: async ({ configuration, validated, pages }) => {
      const result = await deliverDiscord(
        adapters,
        discordDeliverySettings(configuration.config),
        validated,
        pages.pagesUrl,
      );
      return Object.freeze({
        value: Object.freeze({
          ...result.value,
        }),
        notificationCount: result.notificationCount,
        discordSentAt: result.discordSentAt,
      });
    },
    sendOperationsAlert: ({ invocation, configuration, kind, retryAttempts }) =>
      deliverOperationsAlert(adapters, configuration.config, {
        incidentId: `${invocation.runId}:${kind}`,
        kind,
        occurredAt: invocation.startedAt,
        retryAttempts,
      }),
    writeDryRunArtifact: (path, artifact) => adapters.writeJsonArtifact(path, artifact),
    writeCollectAnalyzeArtifact: (path, input) =>
      adapters.writeJsonArtifact(
        path,
        createCollectAnalyzeArtifact(
          input.invocation,
          input.configuration,
          input.repositoryInventory,
          input.validated,
          input.metrics,
          input.diagnostics,
        ),
      ),
    writeReport: (path, report) => writeRunReport(path, report, adapters.writeTextFile),
  });
}

async function persistWorkflowCache(
  adapters: ProductionRuntimeAdapters,
  command: PersistCacheCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const allowlist = createPublicRepositoryAllowlist(workflowArtifactRepositoryInventory(artifact));
  const session = await adapters.openCacheSession(
    adapters.createStateBranchAdapter(),
    config.state,
    allowlist,
  );
  await session.persist({
    evaluatedAt: artifact.snapshot.generatedAt,
    repositoryCaches: artifact.cacheOnlyPayload.repositoryCaches,
    itemCaches: artifact.cacheOnlyPayload.itemCaches,
    latestImportanceCaches: artifact.cacheOnlyPayload.latestImportanceCaches,
    aiCacheEntries: artifact.cacheOnlyPayload.aiCacheEntries,
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
  await adapters.writePublicData(
    resolve(adapters.repositoryPath, command.outputDirectory),
    artifact.pages,
  );
}

async function notifyWorkflowDiscord(
  adapters: ProductionRuntimeAdapters,
  command: NotifyDiscordCliCommand,
): Promise<void> {
  const artifact = await adapters.readWorkflowArtifact(
    resolve(adapters.repositoryPath, command.artifactPath),
  );
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  await deliverDiscord(
    adapters,
    artifact.discordSettings,
    Object.freeze({
      snapshot: artifact.snapshot,
      notificationSelection: artifact.notificationSelection,
    }),
    command.pagesUrl,
  );
}

async function notifyWorkflowOperations(
  adapters: ProductionRuntimeAdapters,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  await deliverOperationsAlert(adapters, config, {
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
    persistCache: (command) => persistWorkflowCache(adapters, command),
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

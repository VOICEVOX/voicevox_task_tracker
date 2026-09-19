import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
  CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
  CODEX_PROMPT_BUNDLE_VERSION,
  createEmptyAiBudgetUsage,
  createAiAnalysisTarget,
  assessAnalysisImpact,
  createCodexEnvironment,
  createCodexAnalysisInput,
  CodexOutputValidationError,
  createPersonalReminderCauseInputFingerprint,
  determineAnalysisElementNecessities,
  determineAnalysisElementReuse,
  estimateAiInputCost,
  effectiveElementConfidence,
  getCodexEnvironmentVariableAllowlist,
  hashCanonicalJson,
  listNativeRelationConstraints,
  prepareAiAnalysisCandidate,
  planAnalysisElements,
  projectCodexLockedElements,
  recordCodexDiagnostic,
  reduceAiAnalysisElements,
  reduceCodexAnalysis,
  reduceCodexInputValidationFailure,
  reducePreservedCodexRelationsAndNotification,
  runAiAnalyses,
  runPersonalReminderAiAnalyses,
  serializeCanonicalJson,
  validateCodexAnalysisOutput,
  validateCodexElementOutputSchema,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  type AiAnalysisCandidate,
  type AiAnalysisTarget,
  type AnalysisImpactAssessment,
  type AnalysisImpactCurrentInputProjection,
  type AnalysisImpactDeclaration,
  type AnalysisImpactRecord,
  type AnalysisImpactValue,
  type AnalysisImpactVersion,
  type AnalysisElementReuseRecord,
  type AnalysisElementPlanning,
  type AnalysisElementSelection,
  type AnalysisElementSelectionCandidate,
  type AnalysisElementNecessityInput,
  type AiAnalysisRunFailure,
  type AiAnalysisRunIdentity,
  type AiAnalysisRunResult,
  type AiBudgetUsage,
  type PersonalReminderAiRunResult,
  type PersonalReminderAiEvaluationCandidate,
  type PersonalReminderAiRunConfiguration,
  type AiAnalysisElementGenerationMap,
  type AiAnalysisElementSourceGenerationMap,
  type CodexAnalysisInput,
  type CodexPreservedElements,
  type CodexAdapterConfiguration,
  type CodexAdapterDependencies,
  type CodexAnalysisReduction,
  type CodexProcessRunner,
  type CodexSemanticGenerationObserver,
  type DeterministicCodexDecision,
  type PreparedAiAnalysisCandidate,
  type ReducedCodexDecision,
  type SchemaValidCodexElementOutput,
} from "../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  aiAnalysisElementApplicationUsesAiValue,
  aiAnalysisElementApplicationsSchema,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementApplication,
  type AiAnalysisElementEvidence,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementExecutionFingerprint,
  type AiAnalysisElementGeneration,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementReuseProof,
} from "../domain/ai-analysis-elements.js";
import type {
  AiAnalysisDependency,
  AiAnalysisDependencyElement,
  AiAnalysisDependencyProducer,
  AiAnalysisDependencyReconciliationContext,
  TrackedItemAiDependencies,
} from "../domain/ai-analysis-dependencies.js";
import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForMissingRelationCandidateAssessment,
  aiAnalysisDependencyForRelation,
  aiAnalysisDependencyForRelationCandidate,
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
  reconcileRetainedAiAnalysisDependency,
  trackedItemAiDependenciesSchema,
} from "../domain/ai-analysis-dependencies.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../domain/ai-analysis-source-generations.js";
import { isExcludedFromProgressAndHumanActivity } from "../domain/meaningful-progress.js";
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
  createExternalReferenceNodeId,
  createNotificationReason,
  createUtcIsoDateTime,
  createGitHubNodeId,
  createGitHubBotPredicate,
  buildSourceId,
  createLabelEffectsResolver,
  createTrackedItemLatestEventActor,
  createStalenessNotificationSeverityReason,
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  calculateStaleness,
  calculatePersonalReminderStaleness,
  determineDeadlineLevel,
  determinePotentialPersonalReminderContinuityConflictNodeIds,
  recalculateStalenessSeverity,
  determineIssueState,
  determineIssueLocalResponsibility,
  determineMeaningfulProgress,
  determinePullRequestState,
  determinePullRequestLocalResponsibility,
  determineTerminalRetention,
  determineTrackedItemWork,
  isTerminalStatus,
  ISSUE_DETERMINISTIC_RULES_VERSION,
  parseSourceId,
  PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
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
  type PendingNotification,
  type IssueBlocker,
  type IssueEffectiveAssigneeAssessment,
  type IssueEffectiveAssigneeCandidate,
  type IssueEffectiveAssigneeTarget,
  type IssueExplicitRequestAssessment,
  type IssueExplicitRequestTarget,
  type IssueStateDecision,
  type BlockedParentContext,
  type BlockerDecisionTrace,
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
  type TrackedItemState,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
  type NaturalLanguageProgressAssessment,
  type DependencyResolutionProgress,
  type DeadlineLevel,
  type ExternalGhostNode,
  type Evidence,
  type PersonalReminderCause,
  type PersonalReminderStaleness,
  type TrackedItem,
  type TrackedItemAiAnalysis,
  type TrackedItemAiAnalysisApplications,
  type TrackedItemAiAnalysisCurrentAdoptedElement,
  type TrackedItemAiAnalysisCurrentAdoptedElements,
  type TrackedItemAiAnalysisCurrentElement,
  type TrackedItemAiAnalysisCurrentElements,
  type TrackedItemAiAnalysisMigrationAdoptedElement,
  type TrackedItemAiAnalysisMigrationAdoptedElements,
  type TrackedItemAiAnalysisMigrationElements,
  type TrackedItemInputEvent,
  type TrackingConnection,
  type TrackingNotificationClass,
  type TrackingRunCompletion,
  type TrackingStartAtState,
  type TrackedItemWorkDecision,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  applyPersonalReminderCauseOutcomes,
  createPersonalReminderRuntimeContext,
  planPersonalReminderCauses,
  reconcileRetainedPersonalReminderCause,
  reconcileRetainedPersonalReminderPlanning,
  type PersonalReminderRuntimeCollectedItem,
  type PersonalReminderRuntimeCandidateEndpointItem,
  type PersonalReminderRuntimeGraph,
  type PersonalReminderRuntimeLocalDecision,
  type PersonalReminderRuntimeRelatedContext,
  type PersonalReminderRuntimeState,
  type PersonalReminderCauseRuntimePlanEntry,
} from "./personal-reminder-runtime.js";
import {
  assertDiscordPersonalReminderSelectionMatchesSnapshot,
  calculateDiscordNotificationCandidateSeverity,
  createAcknowledgedNotificationLedgerEntries,
  createNotificationCauses,
  selectDiscordNotifications,
  type sendDiscordDigest,
  type DiscordDigestDelivery,
  type DiscordDeliverySettings,
  type DiscordNotificationCandidate,
  type DiscordNotificationItem,
  type NotificationCause,
  type NotificationCauseEvidence,
  type NotificationDependencyCause,
  type NotificationCauses,
  type DiscordNotificationSelection,
  type DiscordPersonalReminderSelectionValidationItem,
  type DiscordOperationsIncident,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
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
  type EnumeratedGitHubItem,
  type FreshObservedGitHubItem,
  type GitHubAppCredentials,
  type GitHubClient,
  type GitHubCheckContext,
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubPullRequestReviewComment,
  type GitHubReferencedItem,
  type PublicRepository,
  type PublicRepositoryAllowlist,
  type PreviousItemCollection,
  type RepositoryCollectionResult,
  type Sha256Fingerprint,
  type StaleObservedGitHubItem,
} from "../github/index.js";
import {
  analyzeGraph,
  analyzeGraphAiDependencies,
  extractRelationCandidatesForItems,
  planRelationExpansion,
  reconcileGraph,
  RelationReferenceConflictError,
  type AnalyzeGraphResult,
  type BlockerNodeAiDependency,
  type BlockerSetAiDependency,
  type NegativeBlockerAiDependency,
  type RelationSetAiDependency,
  type CandidateRelation,
  type PublicGitHubRelationItem,
  type ReconciledGraphEdge,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type OrganizationRelationCandidateNode,
  type ReconcileGraphResult,
  type RelationCandidate,
  type RelationCandidateAssessment,
  type RelationCandidateDecisionProof,
  type RelationCandidateNode,
  type RelationCandidateId,
  type RelationCandidateResolution,
  type RelationExtractionItem,
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
  assertPersonalReminderEvidenceClosure,
  snapshotEffectiveGraphStateByNodeId,
  StateBranchConflictError,
  NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
  assertStatePublicSafety,
  StatePersistenceSession,
  type PersistStateTransactionResult,
  type SnapshotAiState,
  type SnapshotAnalysisPlanFingerprint,
  type SnapshotCollectionItem,
  type SnapshotCollectionRepository,
  type SnapshotGraphNodeStateObservation,
  type SnapshotRepository,
  type SnapshotTrackedItem,
  type StateBranchAdapter,
  type StateNotificationLedger,
  type StatePersistenceConfiguration,
  type StateRunReport,
  type StateHistoryRecord,
  type StateHistoryInputEvent,
  type StateHistoryNotificationEvent,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import { resolveStateHistoryNotificationItemDisplayReference } from "../persistence/history.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { CliApplication } from "./application.js";
import { createTrackingBackfillRequest } from "./backfill.js";
import {
  type BuildPagesCliCommand,
  type NotifyDiscordCliCommand,
  type NotifyOperationsCliCommand,
  type PersistStateCliCommand,
  type ReportWorkflowCliCommand,
  type ResolveDiscordDeliveryCliCommand,
} from "./command.js";
import {
  type OnlineCliCommand,
  type PersonalReminderAnalysisStageResult,
} from "./daily-transaction.js";
import {
  assertSandboxManifestMatchesContext,
  assertSandboxOrigin,
  parseSandboxManifest,
  sandboxBranchForEnvironment,
  SANDBOX_MANIFEST_PATH,
  type SandboxManifest,
  type SandboxRunContext,
} from "./sandbox-context.js";
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
const CODEX_PROMPT_FINGERPRINT = hashCanonicalJson({
  bundleVersion: CODEX_PROMPT_BUNDLE_VERSION,
});
const PAGES_BASE_URL = "https://voicevox.github.io";
const DISCORD_DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;
const GITHUB_MENTION_PATTERN =
  /(?<![A-Za-z0-9-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99})))?/gu;
const STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS = Object.freeze([
  "status",
  "waitingOn",
  "primaryWaitingOn",
  "nextAction",
  "confidence",
  "evidence",
  "uncertainties",
  "lastProgressAt",
  "stallSince",
] satisfies readonly AiAnalysisDependencyElement[]);
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
  target: RuntimeExecutionTarget;
}>;

type RuntimeExecutionTarget =
  | Readonly<{
      kind: "production";
      state: Config["state"];
    }>
  | Readonly<{
      kind: "sandbox";
      state: StatePersistenceConfiguration;
      manifest: SandboxManifest;
      context: SandboxRunContext;
    }>;

function createAiAnalysisRunIdentity(config: Config): AiAnalysisRunIdentity {
  return Object.freeze({
    model: config.ai.model,
    reasoningEffort: config.ai.execution.reasoningEffort,
    backendVersion: CODEX_BACKEND_VERSION,
    schemaVersion: AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
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
  staleBlockerTopologyNodeIds: ReadonlySet<GitHubNodeId>;
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
  analysisPlanChangedNodeIds: readonly GitHubNodeId[];
  personalReminderReplanNodeIds: ReadonlySet<GitHubNodeId>;
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
  analysisPlanChangedNodeIds: ReadonlySet<GitHubNodeId>;
  personalReminderReplanNodeIds: ReadonlySet<GitHubNodeId>;
}>;

type RelationReferenceRefreshTarget = Readonly<{
  repository: PublicRepository;
  expected: PublicGitHubRelationItem;
}>;

interface RelationReferenceRetryBudget {
  readonly maxRefreshes: number;
  refreshes: number;
}

type ExtractedRelationCandidates = Readonly<{
  candidates: readonly RelationCandidate[];
  aggregate: FreshRuntimeCollectionAggregate;
}>;

type RelationExpandedRuntimeCollection = FreshRuntimeCollectionAggregate &
  Readonly<{
    evaluatedAt: UtcIsoDateTime;
    relationCandidates: readonly RelationCandidate[];
    blockerTopologyRelationCandidates: readonly RelationCandidate[];
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

type CodexWaitingOnCandidate = Readonly<{
  id: string;
}>;

type CodexSelfCommitmentCandidate = Readonly<{
  id: string;
  sourceIds: readonly SourceId[];
}>;

type CodexSourceAuthor = CodexAnalysisInput["sources"][number]["author"];

type EffectiveAssigneeSourceContext = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
}>;

type EffectiveAssigneeCandidateContext = Readonly<{
  candidate: IssueEffectiveAssigneeCandidate;
  sourceContexts: readonly EffectiveAssigneeSourceContext[];
}>;

type EffectiveAssigneeCollectionContext = Readonly<{
  observedItemsByNodeId: ReadonlyMap<GitHubNodeId, FreshObservedGitHubItem>;
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>;
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
}>;

type DeterministicItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: IssueStateDecision | PullRequestStateDecision;
  localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  notificationClass: TrackingNotificationClass;
  notificationsSuppressedByLabel: boolean;
  relationCandidates: readonly RelationCandidate[];
  effectiveAssigneeCandidates: readonly EffectiveAssigneeCandidateContext[];
}>;

const EMPTY_RELATION_CANDIDATES = Object.freeze([] satisfies RelationCandidate[]);

type DeterministicAnalysis = Readonly<{
  items: readonly DeterministicItemAnalysis[];
  state: RuntimeState;
  inventory: RepositoryInventory;
}>;

type CodexAnalysis = Readonly<{
  run: AiAnalysisRunResult | undefined;
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
  elementPlanningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>;
  elementGenerationsByNodeId: ReadonlyMap<GitHubNodeId, AiAnalysisElementSourceGenerationMap>;
}>;

type ReducedItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  effectiveAssigneeCandidates: readonly EffectiveAssigneeCandidateContext[];
  decision: ReducedCodexDecision;
  blockerValueAiDependencies: BlockerValueAiDependencies;
  localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  aiAnalysisApplications: TrackedItemAiAnalysisApplications;
  selfCommitmentCause: NotificationCause;
  statusBasis: IssueStateDecision["statusBasis"];
  responsibilityBasis: IssueStateDecision["responsibilityBasis"];
  dependencyCause: NotificationDependencyCause;
  notificationRecommendation: DiscordNotificationItem["notificationRecommendation"];
  primaryWaitingOn: PrimaryWaitingOn;
  staleness: StalenessResult;
  importanceAssessment: NaturalLanguageImportanceAssessmentState;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
}>;

type DependencyResolutionResult = Readonly<{
  progress: readonly DependencyResolutionProgress[];
  cause: NotificationDependencyCause;
}>;

type NotificationCauseEvidenceList = readonly [
  NotificationCauseEvidence,
  ...NotificationCauseEvidence[],
];

type TrackedItemStaleness = Readonly<{
  elapsedHours: number;
  severity: Severity;
  severityReason: StalenessNotificationSeverityReason;
  criticalSuppressed: boolean;
  criticalRequested: boolean;
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
  retainedNotificationRecommendations: ReadonlyMap<
    GitHubNodeId,
    DiscordNotificationItem["notificationRecommendation"]
  >;
  runStatus: "success" | "fallback";
}>;

type GraphResult = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  effectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
  graphNodeStateObservations: readonly SnapshotGraphNodeStateObservation[];
  currentNativeStateObservations: readonly SnapshotGraphNodeStateObservation[];
  relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
  candidateResolutions: ReconcileGraphResult["candidateResolutions"];
  candidateDecisionProofs: ReconcileGraphResult["candidateDecisionProofs"];
  externalReferences: readonly ExternalGhostNode[];
  openNodeIds: ReadonlySet<GraphNodeId>;
  analysis: AnalyzeGraphResult;
  downstreamImpactAiDependencies: AnalyzeGraphResult["downstreamImpactAiDependencies"];
  blockerSetAiDependencies: readonly BlockerSetAiDependency[];
  blockerNodeAiDependencies: readonly BlockerNodeAiDependency[];
  negativeBlockerAiDependencies: readonly NegativeBlockerAiDependency[];
  relationSetAiDependencies: readonly RelationSetAiDependency[];
  previousAnalysis:
    | Readonly<{
        availability: "unavailable";
      }>
    | Readonly<{
        availability: "available";
        value: AnalyzeGraphResult;
      }>;
}>;

type PersonalReminderAnalysis = Readonly<{
  status: "success" | "fallback";
  causesByNodeId: ReadonlyMap<GitHubNodeId, readonly PersonalReminderCause[]>;
  evidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  stalenessByCauseId: ReadonlyMap<PersonalReminderCause["causeId"], PersonalReminderStaleness>;
  planningByNodeId: ReadonlyMap<GitHubNodeId, SnapshotTrackedItem["personalReminderCausePlanning"]>;
  run: PersonalReminderAiRunResult | undefined;
  budgetUsage: AiBudgetUsage;
  authenticationPreflightExecuted: boolean;
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
    personalReminderAnalysis: PersonalReminderAnalysis;
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
    configuration: StatePersistenceConfiguration,
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
    input: import("../codex/personal-reminder-input.js").PersonalReminderAiInput,
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<import("../codex/personal-reminder-output.js").SchemaValidPersonalReminderAiOutput>;
  executeCodexAuthenticationPreflight: (
    configuration: CodexAdapterConfiguration,
    dependencies: CodexAdapterDependencies,
  ) => Promise<void>;
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
  executionTargetKind: RuntimeExecutionTarget["kind"],
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
  if (config.notifications.discord.enabled && executionTargetKind === "production") {
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
          case "hold":
          case "acknowledge-current":
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

function parseSandboxManifestBytes(bytes: Uint8Array): SandboxManifest {
  return parseSandboxManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

async function resolveRuntimeTarget(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  command: OnlineCliCommand,
): Promise<RuntimeExecutionTarget> {
  const sandboxContextPath = command.kind === "daily" ? command.sandboxContextPath : undefined;
  if (sandboxContextPath == null) {
    return Object.freeze({
      kind: "production",
      state: config.state,
    });
  }
  if (command.kind !== "daily") {
    throw new TypeError("sandbox contextはdaily commandでだけ指定できます");
  }
  if (command.notificationAction !== "hold") {
    throw new TypeError("sandbox実行のnotification-actionはholdにしてください");
  }
  const readSandboxContext = adapters.readSandboxContext;
  if (readSandboxContext == null) {
    throw new TypeError("sandbox contextの読み取りadapterがありません");
  }
  const context = await readSandboxContext(resolve(adapters.repositoryPath, sandboxContextPath));
  const branch = sandboxBranchForEnvironment(context.environmentId);
  const stateAdapter = adapters.createStateBranchAdapter();
  const head = await stateAdapter.resolveHead(branch);
  if (head.status === "missing") {
    throw new StateBranchConflictError();
  }
  if (head.revision !== context.baseStateRevision) {
    throw new StateBranchConflictError();
  }
  const manifestResult = await stateAdapter.readFile(head.revision, SANDBOX_MANIFEST_PATH);
  if (manifestResult.status === "missing") {
    throw new TypeError("sandbox environment manifestがありません");
  }
  const manifest = parseSandboxManifestBytes(manifestResult.bytes);
  assertSandboxManifestMatchesContext(manifest, context);
  assertNonNullable(
    stateAdapter.resolveRepositoryRevision,
    "checkout repositoryのcommit SHA取得adapterがありません",
  );
  const repositoryRevision = await stateAdapter.resolveRepositoryRevision();
  if (repositoryRevision !== context.codeRevision) {
    throw new TypeError("sandbox contextとcheckout repositoryのcommit SHAが一致しません");
  }
  assertNonNullable(stateAdapter.resolveOriginUrls, "origin URL取得adapterがありません");
  const originUrls = await stateAdapter.resolveOriginUrls();
  for (const originUrl of [...originUrls.fetchUrls, ...originUrls.pushUrls]) {
    assertSandboxOrigin(originUrl);
  }
  const state = Object.freeze({
    ...config.state,
    branch,
  }) satisfies StatePersistenceConfiguration;
  return Object.freeze({
    kind: "sandbox",
    state,
    manifest,
    context,
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

const previousTrackedItemsBySnapshot = new WeakMap<
  StateSnapshot,
  ReadonlyMap<GitHubNodeId, SnapshotTrackedItem>
>();

function previousTrackedItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotTrackedItem> {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return new Map();
  }
  const cached = previousTrackedItemsBySnapshot.get(snapshot);
  if (cached != null) {
    return cached;
  }
  const itemsByNodeId = new Map<GitHubNodeId, SnapshotTrackedItem>();
  for (const item of snapshot.items) {
    if (itemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`前回snapshotの追跡項目が重複しています。対象: ${item.nodeId}`);
    }
    itemsByNodeId.set(item.nodeId, item);
  }
  previousTrackedItemsBySnapshot.set(snapshot, itemsByNodeId);
  return itemsByNodeId;
}

function previousTrackedItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): SnapshotTrackedItem | undefined {
  return previousTrackedItemsByNodeId(state).get(nodeId);
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

function hasCurrentAnalysisReuseProof(
  element: AiAnalysisElement,
  proof: AiAnalysisElementReuseProof,
): boolean {
  return (
    proof.status === "verified" &&
    proof.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
    proof.inputProjectionVersion === AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element]
  );
}

function staleAiAnalysisElementsForLifecycle(
  item: SnapshotTrackedItem | undefined,
): readonly AiAnalysisElement[] {
  if (item == null) {
    return Object.freeze([]);
  }
  const hasUnresolvedAiDependency = AI_ANALYSIS_DEPENDENCY_ELEMENTS.some(
    (element) => item.aiDependencies[element].status === "unknown",
  );
  if (item.aiAnalysis.status === "not_required" && !hasUnresolvedAiDependency) {
    return Object.freeze([]);
  }
  if (hasUnresolvedAiDependency) {
    const staleElements = AI_ANALYSIS_ELEMENTS.filter((element) => {
      const evaluated = item.aiAnalysis.elements[element];
      const adopted = item.aiAnalysis.adoptedElements[element];
      return evaluated != null || adopted != null;
    });
    return Object.freeze(
      staleElements.includes("status") ? staleElements : ["status", ...staleElements],
    );
  }
  if (item.aiAnalysis.origin === "migration") {
    return staleMigrationAiAnalysisElementsForLifecycle(item.aiAnalysis);
  }
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.filter((element) => {
      const evaluated = item.aiAnalysis.elements[element];
      const adopted = item.aiAnalysis.adoptedElements[element];
      if (evaluated == null && adopted == null) {
        return false;
      }
      const evaluationIsCurrent =
        evaluated != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof),
        );
      const adoptionIsCurrent =
        adopted != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
        );
      return !evaluationIsCurrent && !adoptionIsCurrent;
    }),
  );
}

function staleMigrationAiAnalysisElementsForLifecycle(
  aiAnalysis: Extract<TrackedItemAiAnalysis, { origin: "migration" }>,
): readonly AiAnalysisElement[] {
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.filter((element) => {
      const evaluated = aiAnalysis.elements[element];
      const adopted = aiAnalysis.adoptedElements[element];
      if (evaluated == null && adopted == null) {
        return false;
      }
      const evaluationIsCurrent =
        evaluated != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof),
        );
      const adoptionIsCurrent =
        adopted != null &&
        hasCurrentAnalysisReuseProof(
          element,
          aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
        );
      return !evaluationIsCurrent && !adoptionIsCurrent;
    }),
  );
}

function deterministicRulesVersionForItem(item: EnumeratedGitHubItem): string {
  switch (item.type) {
    case "issue":
      return ISSUE_DETERMINISTIC_RULES_VERSION;
    case "pull_request":
      return PULL_REQUEST_DETERMINISTIC_RULES_VERSION;
  }
}

function analysisPlanFingerprintForItem(
  item: EnumeratedGitHubItem,
  identity: AiAnalysisRunIdentity,
): Sha256Fingerprint {
  return hashCanonicalJson({
    itemType: item.type,
    deterministicRulesVersion: deterministicRulesVersionForItem(item),
    elementRevisions: AI_ANALYSIS_ELEMENT_REVISIONS,
    execution: {
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      backendVersion: identity.backendVersion,
      schemaVersion: identity.schemaVersion,
    },
  });
}

function createSnapshotCollectionItem(
  item: EnumeratedGitHubItem,
  analysisPlanFingerprint: SnapshotAnalysisPlanFingerprint,
): SnapshotCollectionItem {
  const applications = Object.freeze(
    aiAnalysisElementApplicationsSchema.parse(
      Object.fromEntries(
        AI_ANALYSIS_ELEMENTS.map((element) => [
          element,
          Object.freeze({
            status: "unknown",
            reason: "not_recorded",
          }),
        ]),
      ),
    ),
  );
  if (item.state === "open") {
    return Object.freeze({
      freshness: "fresh",
      nodeId: item.nodeId,
      repositoryId: item.repositoryId,
      itemFingerprint: item.itemFingerprint,
      analysisPlanFingerprint,
      aiAnalysis: Object.freeze({
        origin: "current",
        status: "not_recorded",
        elements: Object.freeze({}),
        adoptedElements: Object.freeze({}),
        applications,
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
    analysisPlanFingerprint,
    aiAnalysis: Object.freeze({
      origin: "current",
      status: "not_recorded",
      elements: Object.freeze({}),
      adoptedElements: Object.freeze({}),
      applications,
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
    items: Object.freeze(
      items.map((item) =>
        createSnapshotCollectionItem(item, {
          status: "unplanned",
          reason: "detail_required",
        }),
      ),
    ),
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
          analysisPlanFingerprint: item.analysisPlanFingerprint,
        }),
      ]),
    ),
  });
}

type PreviousRelationCandidateDependencyProducer = Extract<
  AiAnalysisDependencyProducer,
  { kind: "relation_candidate" }
>;

type PreviousPersonalReminderRelationCandidateDependency = Readonly<{
  consumerNodeId: GitHubNodeId;
  producer: PreviousRelationCandidateDependencyProducer;
}>;

function personalReminderAiDependencies(
  item: SnapshotTrackedItem,
): readonly AiAnalysisDependency[] {
  return Object.freeze([
    ...(item.personalReminderCausePlanning.status === "completed"
      ? [item.personalReminderCausePlanning.causeSetAiDependency]
      : []),
    ...item.personalReminderCauses.flatMap((cause) => [
      ...Object.values(cause.aiDependencies),
      cause.currentInput.aiDependency,
    ]),
  ]);
}

function previousRelationCandidateDependencyProducers(
  state: RuntimeState,
): readonly PreviousRelationCandidateDependencyProducer[] {
  const producersByCandidateId = new Map<string, PreviousRelationCandidateDependencyProducer>();
  const snapshot = previousSnapshot(state);
  const dependencies = [
    ...(snapshot?.items ?? []).flatMap((item) => [
      ...Object.values(item.aiDependencies),
      ...personalReminderAiDependencies(item),
    ]),
    ...(snapshot?.relations ?? []).map((relation) => relation.aiDependency),
  ];
  for (const dependency of dependencies) {
    if (dependency.status === "not_dependent" || dependency.producers == null) {
      continue;
    }
    for (const producer of dependency.producers) {
      if (producer.kind !== "relation_candidate") {
        continue;
      }
      const existing = producersByCandidateId.get(producer.candidateId);
      if (existing != null && hashCanonicalJson(existing) !== hashCanonicalJson(producer)) {
        throw new TypeError(
          `前回snapshotのrelation candidate producer定義が一致しません。対象: ${producer.candidateId}`,
        );
      }
      producersByCandidateId.set(producer.candidateId, producer);
    }
  }
  return Object.freeze([...producersByCandidateId.values()]);
}

function previousPersonalReminderRelationCandidateDependencies(
  state: RuntimeState,
): readonly PreviousPersonalReminderRelationCandidateDependency[] {
  const producersByCandidateId = new Map<string, PreviousRelationCandidateDependencyProducer>();
  const dependenciesByConsumerAndCandidate = new Map<
    string,
    PreviousPersonalReminderRelationCandidateDependency
  >();
  for (const item of previousSnapshot(state)?.items ?? []) {
    const dependencies = personalReminderAiDependencies(item);
    for (const dependency of dependencies) {
      if (dependency.status === "not_dependent" || dependency.producers == null) {
        continue;
      }
      for (const producer of dependency.producers) {
        if (producer.kind !== "relation_candidate") {
          continue;
        }
        const endpointNodeIds = normalizedBlockerRelationEndpointNodeIds(producer.endpointNodeIds);
        if (!endpointNodeIds.includes(producer.producer.nodeId)) {
          throw new TypeError(
            `前回snapshotのpersonal reminder relation candidate producer nodeがendpointと一致しません。対象: ${producer.candidateId}`,
          );
        }
        const normalizedProducer = Object.freeze({ ...producer, endpointNodeIds });
        const existingProducer = producersByCandidateId.get(producer.candidateId);
        if (existingProducer != null) {
          if (
            existingProducer.producer.nodeId !== normalizedProducer.producer.nodeId ||
            existingProducer.endpointNodeIds[0] !== normalizedProducer.endpointNodeIds[0] ||
            existingProducer.endpointNodeIds[1] !== normalizedProducer.endpointNodeIds[1]
          ) {
            throw new TypeError(
              `前回snapshotのpersonal reminder relation candidate producer定義が一致しません。対象: ${producer.candidateId}`,
            );
          }
        } else {
          producersByCandidateId.set(producer.candidateId, normalizedProducer);
        }
        const dependencyKey = JSON.stringify([item.nodeId, producer.candidateId]);
        if (!dependenciesByConsumerAndCandidate.has(dependencyKey)) {
          dependenciesByConsumerAndCandidate.set(
            dependencyKey,
            Object.freeze({
              consumerNodeId: item.nodeId,
              producer: normalizedProducer,
            }),
          );
        }
      }
    }
  }
  return Object.freeze(
    [...dependenciesByConsumerAndCandidate.values()].sort((left, right) => {
      const candidateOrder = left.producer.candidateId.localeCompare(right.producer.candidateId);
      return candidateOrder !== 0
        ? candidateOrder
        : left.consumerNodeId.localeCompare(right.consumerNodeId);
    }),
  );
}

function previousPersonalReminderRelationCandidateConsumerNodeIds(
  state: RuntimeState,
): ReadonlySet<GitHubNodeId> {
  return new Set(
    previousPersonalReminderRelationCandidateDependencies(state).map(
      (dependency) => dependency.consumerNodeId,
    ),
  );
}

function previousStaleRepositoryBlockerTopologyNodeIds(
  state: RuntimeState,
): ReadonlySet<GitHubNodeId> {
  const nodeIds = new Set<GitHubNodeId>();
  for (const item of previousSnapshot(state)?.items ?? []) {
    const hasMarker = STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS.every((element) => {
      const dependency = item.aiDependencies[element];
      return dependency.status === "unknown" && dependency.reasons.includes("stale_repository");
    });
    if (hasMarker) {
      nodeIds.add(item.nodeId);
    }
  }
  return nodeIds;
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
  for (const producer of previousRelationCandidateDependencyProducers(state)) {
    for (const endpointNodeId of producer.endpointNodeIds) {
      if (trackedNodeIds.has(endpointNodeId)) {
        nodeIds.add(createGitHubNodeId(endpointNodeId));
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
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    enumeratedItems
      .filter((item) => {
        if (!previouslyTrackedNodeIds.has(item.nodeId)) {
          return (
            explicitIdentifierMatchesItem(configuration.config.tracking.include, item) ||
            (includesAllOpenBackfill && item.state === "open")
          );
        }
        const previousItem = previousItemsByNodeId.get(item.nodeId);
        return staleAiAnalysisElementsForLifecycle(previousItem).length !== 0;
      })
      .map((item) => item.nodeId),
  );
}

function findRepository(
  inventory: RepositoryInventory,
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  return inventory.allowlist.require(repositoryId);
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

function extractRelationCandidatesOnce(
  config: Config,
  allowlist: PublicRepositoryAllowlist,
  items: readonly EnumeratedGitHubItem[],
  details: readonly GitHubItemDetail[],
): readonly RelationCandidate[] {
  const knownItems = items.map((item) =>
    createPublicRelationItem(item, allowlist.require(item.repositoryId)),
  );
  const itemByNodeId = new Map(knownItems.map((item) => [item.nodeId, item]));
  const extractionItems = details.map((detail) => {
    const item = itemByNodeId.get(detail.nodeId);
    assertNonNullable(item, `関係候補抽出対象がありません。対象: ${detail.nodeId}`);
    return Object.freeze({
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
    }) satisfies RelationExtractionItem;
  });
  return extractRelationCandidatesForItems({
    organization: config.organization,
    items: extractionItems,
    knownItems,
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

function detailReferencesRelationNode(detail: GitHubItemDetail, nodeId: GitHubNodeId): boolean {
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
    if (detailReferencesRelationNode(detail, error.existing.nodeId)) {
      nodeIds.add(detail.nodeId);
    }
  }
  const enumeratedItemsByNodeId = new Map(
    aggregate.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const targets: RelationReferenceRefreshTarget[] = [];
  for (const nodeId of nodeIds) {
    if (nodeId === error.existing.nodeId) {
      const repository = findRelationReferenceRepository(allowlist, error.existing);
      if (repository == null) {
        throw error;
      }
      targets.push(Object.freeze({ repository, expected: error.existing }));
      continue;
    }
    const enumeratedItem = enumeratedItemsByNodeId.get(nodeId);
    if (enumeratedItem == null) {
      throw new TypeError("関係参照競合の親詳細に対応する列挙項目がありません", { cause: error });
    }
    if (!allowlist.has(enumeratedItem.repositoryId)) {
      throw error;
    }
    const repository = allowlist.require(enumeratedItem.repositoryId);
    targets.push(
      Object.freeze({
        repository,
        expected: createPublicRelationItem(enumeratedItem, repository),
      }),
    );
  }
  return Object.freeze(targets);
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
    item.type !== expected.type ||
    item.number !== expected.number ||
    item.url !== expected.url
  ) {
    throw new TypeError(
      `関係参照競合の再取得結果が要求項目と一致しません。対象: ${expected.nodeId}`,
      { cause },
    );
  }
  return item;
}

function mergeFreshRepositoryRuntimeCollection(
  repository: PublicRepository,
  invocation: DailyRunInvocation,
  current: FreshRepositoryRuntimeCollection,
  additions: FreshRepositoryItemCollection,
): FreshRepositoryRuntimeCollection {
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
  const analysisPlanChangedNodeIds = new Set([
    ...current.analysisPlanChangedNodeIds,
    ...additions.analysisPlanChangedNodeIds,
  ]);
  const personalReminderReplanNodeIds = new Set([
    ...current.personalReminderReplanNodeIds,
    ...additions.personalReminderReplanNodeIds,
  ]);
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
    analysisPlanChangedNodeIds: Object.freeze([...analysisPlanChangedNodeIds]),
    personalReminderReplanNodeIds,
  });
}

async function refreshRelationReferences(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  targets: readonly RelationReferenceRefreshTarget[],
  error: RelationReferenceConflictError,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<void> {
  const targetsByRepositoryId = new Map<
    GitHubRepositoryId,
    Readonly<{
      repository: PublicRepository;
      targets: readonly RelationReferenceRefreshTarget[];
    }>
  >();
  for (const target of targets) {
    const current = targetsByRepositoryId.get(target.repository.id);
    if (current == null) {
      targetsByRepositoryId.set(target.repository.id, {
        repository: target.repository,
        targets: [target],
      });
      continue;
    }
    targetsByRepositoryId.set(target.repository.id, {
      repository: current.repository,
      targets: [...current.targets, target],
    });
  }
  for (const { repository, targets: repositoryTargets } of targetsByRepositoryId.values()) {
    const identifiers = repositoryTargets.map((target) => target.expected.url);
    if (new Set(identifiers).size !== identifiers.length) {
      throw new TypeError("関係参照競合の再取得対象URLが重複しています", { cause: error });
    }
    const items = await adapters.enumerateGitHubItemsByIdentifiers({
      allowlist: createPublicRepositoryAllowlist([repository]),
      identifiers,
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
    const current = freshCollectionsByRepositoryId.get(repository.id);
    if (current == null) {
      throw new TypeError("関係参照競合の再取得対象repository収集結果がありません", {
        cause: error,
      });
    }
    const additions = await collectFreshRepositoryItemObservations(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repository,
      refreshedItems,
      new Set(refreshedItems.map((item) => item.nodeId)),
      new Set(refreshedItems.map((item) => item.nodeId)),
    );
    const refreshedCollection = mergeFreshRepositoryRuntimeCollection(
      repository,
      invocation,
      current,
      additions,
    );
    freshCollectionsByRepositoryId.set(repository.id, refreshedCollection);
    const repositoryResult = repositoryResultsById.get(repository.id);
    if (repositoryResult == null || repositoryResult.freshness === "stale") {
      throw new TypeError("関係参照競合の再取得対象repository結果がfreshではありません", {
        cause: error,
      });
    }
    repositoryResultsById.set(
      repository.id,
      Object.freeze({
        freshness: "fresh",
        repository,
        value: refreshedCollection.state,
        observedAt: invocation.startedAt,
      }),
    );
  }
}

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

async function extractAllRelationCandidates(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
  config: Config,
  allowlist: PublicRepositoryAllowlist,
  retryBudget: RelationReferenceRetryBudget,
): Promise<ExtractedRelationCandidates> {
  for (;;) {
    const aggregate = aggregateFreshRepositoryCollections(
      allowlist,
      freshCollectionsByRepositoryId,
    );
    try {
      return Object.freeze({
        candidates: extractRelationCandidatesOnce(
          config,
          allowlist,
          aggregate.enumeratedItems,
          aggregate.details,
        ),
        aggregate,
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
      await refreshRelationReferences(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        targets,
        error,
        freshCollectionsByRepositoryId,
        repositoryResultsById,
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
  staleTrackedNodeIds: ReadonlySet<GitHubNodeId>,
): Readonly<{
  candidates: readonly RelationCandidate[];
  droppedCount: number;
}> {
  const completeCandidates = candidates.filter((candidate) =>
    relationNodes(candidate.relation).every(
      (node) =>
        node.scope === "external_public" ||
        collectedCandidateNodeIds.has(node.nodeId) ||
        (candidate.provenance === "native" && staleTrackedNodeIds.has(node.nodeId)),
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
        requiredAiAnalysisElements: staleAiAnalysisElementsForLifecycle(previousTrackedItem),
        previousAiAnalysisStatus:
          previousTrackedItem == null ? "not_available" : previousTrackedItem.aiAnalysis.status,
        previousObservation:
          previousCollectionItem == null
            ? Object.freeze({ status: "not_available" })
            : Object.freeze({
                status: "available",
                state: previousCollectionItem.state,
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

function indexRelationCandidatesByNodeId(
  candidates: readonly RelationCandidate[],
): ReadonlyMap<GraphNodeId, readonly RelationCandidate[]> {
  const candidatesByNodeId = new Map<GraphNodeId, RelationCandidate[]>();
  for (const candidate of candidates) {
    const [firstNode, secondNode] = relationNodes(candidate.relation);
    const firstCandidates = candidatesByNodeId.get(firstNode.nodeId);
    if (firstCandidates == null) {
      candidatesByNodeId.set(firstNode.nodeId, [candidate]);
    } else {
      firstCandidates.push(candidate);
    }
    if (secondNode.nodeId === firstNode.nodeId) {
      continue;
    }
    const secondCandidates = candidatesByNodeId.get(secondNode.nodeId);
    if (secondCandidates == null) {
      candidatesByNodeId.set(secondNode.nodeId, [candidate]);
    } else {
      secondCandidates.push(candidate);
    }
  }
  return new Map(
    [...candidatesByNodeId].map(([nodeId, nodeCandidates]) => [
      nodeId,
      Object.freeze(nodeCandidates),
    ]),
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
          author: createUnavailableCodexSourceAuthor(),
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
    const relatedItem = collection.observedItemsByNodeId.get(implementation.nodeId);
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
    const relatedDetail = collection.detailsByNodeId.get(implementation.nodeId);
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
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const detailsByNodeId = new Map(collection.details.map((detail) => [detail.nodeId, detail]));
  const relationCandidatesByNodeId = indexRelationCandidatesByNodeId(collection.relationCandidates);
  const effectiveAssigneeCollectionContext = Object.freeze({
    observedItemsByNodeId,
    detailsByNodeId,
    trackedNodeIds: collection.trackedNodeIds,
  }) satisfies EffectiveAssigneeCollectionContext;
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
    const detail = detailsByNodeId.get(item.nodeId);
    assertNonNullable(detail, `GitHub詳細取得結果がありません。対象: ${item.nodeId}`);
    const notificationClass = collection.trackingNotificationClassByNodeId.get(item.nodeId);
    assertNonNullable(notificationClass, `追跡項目の通知分類がありません。対象: ${item.nodeId}`);
    const notificationsSuppressedByLabel = resolveLabelEffects(
      repositoryFullName(repository),
      item.labels,
    ).suppressNotifications;
    const relationCandidates =
      relationCandidatesByNodeId.get(item.nodeId) ?? EMPTY_RELATION_CANDIDATES;
    const blockers = createNativeBlockers(item, relationCandidates);
    if (item.type === "issue" && detail.type === "issue") {
      const effectiveAssigneeCandidates = createEffectiveAssigneeCandidateContexts(
        effectiveAssigneeCollectionContext,
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
      const localResponsibilityDecision = determineIssueLocalResponsibility({
        issue: item,
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
          localResponsibilityDecision,
          notificationClass,
          notificationsSuppressedByLabel,
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
      const localResponsibilityDecision = determinePullRequestLocalResponsibility({
        pullRequest: item,
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
          localResponsibilityDecision,
          notificationClass,
          notificationsSuppressedByLabel,
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

function createUnavailableCodexSourceAuthor(): CodexSourceAuthor {
  return Object.freeze({
    status: "unavailable",
  });
}

function codexCommentSources(
  detail: GitHubItemDetail,
): readonly (GitHubIssueComment | GitHubPullRequestReviewComment)[] {
  if (detail.type === "issue") {
    return detail.comments;
  }
  return Object.freeze([
    ...detail.comments,
    ...detail.reviewThreads.flatMap((thread) => thread.comments),
  ]);
}

function createCodexCommentAuthor(
  item: FreshObservedGitHubItem,
  comment: GitHubIssueComment | GitHubPullRequestReviewComment,
):
  | Readonly<{
      candidate: CodexWaitingOnCandidate;
      sourceAuthor: CodexSourceAuthor;
    }>
  | undefined {
  const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
  if (comment.author.status !== "identified" || event?.actor.type !== "human") {
    return undefined;
  }
  assertNonNullable(event, `comment ${comment.sourceId}のeventがありません`);
  if (event.actor.nodeId !== comment.author.account.nodeId) {
    return undefined;
  }
  const candidate: CodexWaitingOnCandidate = Object.freeze({
    id: comment.author.account.login,
  });
  const sourceAuthor: CodexSourceAuthor =
    comment.createdAt === comment.updatedAt
      ? Object.freeze({
          status: "identified",
          candidateId: candidate.id,
          nodeId: comment.author.account.nodeId,
        })
      : createUnavailableCodexSourceAuthor();
  return Object.freeze({
    candidate,
    sourceAuthor,
  });
}

function selfCommitmentCandidates(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
  previousObservedAt: UtcIsoDateTime | undefined,
  evaluatedAt: UtcIsoDateTime,
): readonly CodexSelfCommitmentCandidate[] {
  if (previousObservedAt == null) {
    return Object.freeze([]);
  }
  const sourceIdsByCandidateId = new Map<string, SourceId[]>();
  for (const comment of codexCommentSources(detail)) {
    const commentAuthor = createCodexCommentAuthor(item, comment);
    if (commentAuthor?.sourceAuthor.status !== "identified") {
      continue;
    }
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    assertNonNullable(event, `comment ${comment.sourceId}のeventがありません`);
    if (
      event.kind !== "comment" ||
      event.actor.type !== "human" ||
      event.actor.nodeId !== commentAuthor.sourceAuthor.nodeId ||
      event.occurredAt !== comment.createdAt ||
      event.occurredAt <= previousObservedAt ||
      event.occurredAt > evaluatedAt
    ) {
      continue;
    }
    const sourceIds = sourceIdsByCandidateId.get(commentAuthor.sourceAuthor.candidateId);
    if (sourceIds == null) {
      sourceIdsByCandidateId.set(commentAuthor.sourceAuthor.candidateId, [comment.sourceId]);
    } else {
      sourceIds.push(comment.sourceId);
    }
  }
  return Object.freeze(
    [...sourceIdsByCandidateId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, sourceIds]) =>
        Object.freeze({
          id,
          sourceIds: Object.freeze([...new Set(sourceIds)].sort()),
        }),
      ),
  );
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

function isOrganizationRelationCandidateNode(
  node: RelationCandidateNode,
): node is OrganizationRelationCandidateNode {
  return node.scope === "organization";
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
      author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
      author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
          author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
      author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
  selectedElements: readonly AiAnalysisElement[],
  preservedElements: CodexPreservedElements,
  previousObservedAt: UtcIsoDateTime | undefined,
): CodexAnalysisInput {
  const relationCandidates = deduplicateByStableId(
    selectRelationAssessmentCandidates(analysis.item.nodeId, analysis.relationCandidates),
    (candidate) => candidate.id,
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(analysis.detail);
  const selfCandidates = selfCommitmentCandidates(
    analysis.item,
    analysis.detail,
    previousObservedAt,
    evaluatedAt,
  );
  const nativeRelationSignals = createNativeRelationSignals(
    analysis.item.nodeId,
    relationCandidates,
  );
  const waitingOnCandidates = new Map<string, CodexWaitingOnCandidate>(
    analysis.decision.waitingOn.map(
      (waitingOn) =>
        [
          waitingOn.candidateId,
          Object.freeze({
            id: waitingOn.candidateId,
          }),
        ] satisfies readonly [string, CodexWaitingOnCandidate],
    ),
  );
  const authorCandidateId = codexAuthorCandidateId(analysis.item);
  if (authorCandidateId != null) {
    waitingOnCandidates.set(
      authorCandidateId,
      Object.freeze({
        id: authorCandidateId,
      }),
    );
  }
  for (const candidate of mentionedCandidates) {
    waitingOnCandidates.set(candidate.id, Object.freeze({ id: candidate.id }));
  }
  const commentAuthorBySourceId = new Map<SourceId, CodexSourceAuthor>();
  for (const comment of codexCommentSources(analysis.detail)) {
    const commentAuthor = createCodexCommentAuthor(analysis.item, comment);
    if (commentAuthor == null) {
      continue;
    }
    waitingOnCandidates.set(commentAuthor.candidate.id, commentAuthor.candidate);
    commentAuthorBySourceId.set(comment.sourceId, commentAuthor.sourceAuthor);
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
      author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
      author: createUnavailableCodexSourceAuthor(),
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
        author:
          commentAuthorBySourceId.get(comment.sourceId) ?? createUnavailableCodexSourceAuthor(),
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
            author:
              commentAuthorBySourceId.get(comment.sourceId) ?? createUnavailableCodexSourceAuthor(),
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
          author: createUnavailableCodexSourceAuthor(),
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
          author: createUnavailableCodexSourceAuthor(),
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
          author: createUnavailableCodexSourceAuthor(),
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
        author: createUnavailableCodexSourceAuthor(),
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
          author: createUnavailableCodexSourceAuthor(),
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
    schemaVersion: "5",
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
    selfCommitmentCandidates: selfCandidates,
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
    selectedElements,
    lockedElements: projectCodexLockedElements(preservedElements),
  });
}

type AnalysisElementInputFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>
>;

type AnalysisElementExecutionFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementExecutionFingerprint>
>;

type AnalysisElementDependencyFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>
>;

type AnalysisImpactResolutionMap = Readonly<
  Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>
>;

type AnalysisImpactResolutions = Readonly<{
  evaluation: AnalysisImpactResolutionMap;
  adopted: AnalysisImpactResolutionMap;
  decisions: readonly Readonly<{
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
}>;

type AnalysisImpactDecisionForDiagnostics = Readonly<{
  impact: "unaffected" | "deterministic" | "interpretation_required" | "unknown";
  sourceVersion: AnalysisImpactVersion;
  targetVersion: AnalysisImpactVersion;
  compatibilityPath: readonly string[];
  reason?: string;
}>;

type AnalysisImpactInputProjectionContext = Readonly<{
  input: CodexAnalysisInput;
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap;
}>;

const WAITING_ON_ANALYSIS_IMPACT_DECLARATIONS: readonly AnalysisImpactDeclaration<
  AiAnalysisElementMigrationResult,
  CodexAnalysisInput
>[] = Object.freeze([
  Object.freeze({
    element: "waitingOn",
    changeId: "waitingOn-revision-2-to-3",
    from: Object.freeze({ revision: 2, inputProjectionVersion: 1 }),
    to: Object.freeze({ revision: 3, inputProjectionVersion: 1 }),
    assess: (): AnalysisImpactAssessment<AiAnalysisElementMigrationResult> =>
      Object.freeze({ impact: "unaffected" }),
  }),
]);

const NO_ANALYSIS_IMPACT_DECLARATIONS: readonly AnalysisImpactDeclaration<
  AiAnalysisElementMigrationResult,
  CodexAnalysisInput
>[] = Object.freeze([]);

const ANALYSIS_IMPACT_DECLARATIONS: Readonly<
  Record<
    AiAnalysisElement,
    readonly AnalysisImpactDeclaration<AiAnalysisElementMigrationResult, CodexAnalysisInput>[]
  >
> = Object.freeze({
  status: NO_ANALYSIS_IMPACT_DECLARATIONS,
  waitingOn: WAITING_ON_ANALYSIS_IMPACT_DECLARATIONS,
  nextAction: NO_ANALYSIS_IMPACT_DECLARATIONS,
  relations: NO_ANALYSIS_IMPACT_DECLARATIONS,
  progress: NO_ANALYSIS_IMPACT_DECLARATIONS,
  importance: NO_ANALYSIS_IMPACT_DECLARATIONS,
  deadline: NO_ANALYSIS_IMPACT_DECLARATIONS,
  notification: NO_ANALYSIS_IMPACT_DECLARATIONS,
  selfCommitment: NO_ANALYSIS_IMPACT_DECLARATIONS,
});

function analysisImpactVersionsEqual(
  left: AnalysisImpactVersion,
  right: AnalysisImpactVersion,
): boolean {
  return (
    left.revision === right.revision && left.inputProjectionVersion === right.inputProjectionVersion
  );
}

function impactDeclarationsForElement(
  element: AiAnalysisElement,
  sourceVersion: AnalysisImpactVersion,
  targetVersion: AnalysisImpactVersion,
): readonly AnalysisImpactDeclaration<AiAnalysisElementMigrationResult, CodexAnalysisInput>[] {
  const declarations = ANALYSIS_IMPACT_DECLARATIONS[element];
  const path: AnalysisImpactDeclaration<AiAnalysisElementMigrationResult, CodexAnalysisInput>[] =
    [];
  const visited = new Set<string>();
  let currentVersion = sourceVersion;
  while (!analysisImpactVersionsEqual(currentVersion, targetVersion)) {
    const versionKey = `${currentVersion.revision.toString()}:${currentVersion.inputProjectionVersion.toString()}`;
    if (visited.has(versionKey)) {
      return Object.freeze([]);
    }
    visited.add(versionKey);
    const declaration = declarations.find((candidate) =>
      analysisImpactVersionsEqual(candidate.from, currentVersion),
    );
    if (declaration == null) {
      return Object.freeze([]);
    }
    path.push(declaration);
    currentVersion = declaration.to;
  }
  return Object.freeze(path);
}

function analysisImpactTargetVersion(element: AiAnalysisElement): AnalysisImpactVersion {
  return Object.freeze({
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[element],
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
  });
}

function analysisImpactSourceVersion(
  element: AiAnalysisElement,
  generation: AiAnalysisElementSourceGeneration | undefined,
  reuseProof: AiAnalysisElementReuseProof,
): AnalysisImpactVersion | undefined {
  if (reuseProof.status === "verified") {
    return Object.freeze({
      revision: reuseProof.revision,
      inputProjectionVersion: reuseProof.inputProjectionVersion,
    });
  }
  if (generation == null) {
    return undefined;
  }
  return Object.freeze({
    revision: generation.metadata.revision,
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
  });
}

type AnalysisImpactInputProjectionProjector = (
  context: AnalysisImpactInputProjectionContext,
) => AnalysisImpactCurrentInputProjection;

function createAnalysisImpactInputProjectionProjector(
  element: AiAnalysisElement,
  inputProjectionVersion: number,
): AnalysisImpactInputProjectionProjector {
  return ({ input, dependencyFingerprints }) =>
    Object.freeze({
      inputProjectionVersion,
      fingerprint: analysisImpactInputFingerprintV1(input, element),
      dependencyFingerprint: dependencyFingerprints[element],
    });
}

const ANALYSIS_IMPACT_INPUT_PROJECTORS: Readonly<
  Record<AiAnalysisElement, Readonly<Record<number, AnalysisImpactInputProjectionProjector>>>
> = Object.freeze({
  status: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("status", 1),
  }),
  waitingOn: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("waitingOn", 1),
  }),
  nextAction: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("nextAction", 1),
  }),
  relations: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("relations", 1),
  }),
  progress: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("progress", 1),
  }),
  importance: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("importance", 1),
  }),
  deadline: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("deadline", 1),
  }),
  notification: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("notification", 1),
  }),
  selfCommitment: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("selfCommitment", 1),
  }),
});

function analysisImpactInputProjection(
  element: AiAnalysisElement,
  version: AnalysisImpactVersion,
  input: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisImpactCurrentInputProjection | undefined {
  return ANALYSIS_IMPACT_INPUT_PROJECTORS[element][version.inputProjectionVersion]?.(
    Object.freeze({ input, dependencyFingerprints }),
  );
}

function analysisImpactValue<Result>(
  result: Result | undefined,
  absentReason: "not_adopted" | "not_evaluated",
): AnalysisImpactValue<Result> {
  return result == null
    ? Object.freeze({ status: "absent", reason: absentReason })
    : Object.freeze({ status: "present", result });
}

function analysisImpactResolutionForRole(
  element: AiAnalysisElement,
  role: "adopted" | "evaluated",
  generation: AiAnalysisElementSourceGeneration | undefined,
  roleRecord: AnalysisElementReuseRecord,
  adoptedResult: AnalysisImpactValue<AiAnalysisElementMigrationResult>,
  evaluatedResult: AnalysisImpactValue<AiAnalysisElementMigrationResult>,
  relatedInput: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): Readonly<{
  resolution: AnalysisElementReuseRecord | undefined;
  decision: AnalysisImpactDecisionForDiagnostics | undefined;
}> {
  const sourceVersion = analysisImpactSourceVersion(element, generation, roleRecord.proof);
  if (sourceVersion == null) {
    return Object.freeze({ resolution: undefined, decision: undefined });
  }
  const targetVersion = analysisImpactTargetVersion(element);
  if (
    sourceVersion.revision === targetVersion.revision &&
    sourceVersion.inputProjectionVersion === targetVersion.inputProjectionVersion
  ) {
    return Object.freeze({ resolution: undefined, decision: undefined });
  }
  const currentSourceInputProjection = analysisImpactInputProjection(
    element,
    sourceVersion,
    relatedInput,
    dependencyFingerprints,
  );
  const currentTargetInputProjection = analysisImpactInputProjection(
    element,
    targetVersion,
    relatedInput,
    dependencyFingerprints,
  );
  if (currentSourceInputProjection == null || currentTargetInputProjection == null) {
    return Object.freeze({
      resolution: undefined,
      decision: Object.freeze({
        impact: "unknown",
        sourceVersion,
        targetVersion,
        compatibilityPath: Object.freeze([]),
        reason: "input_projection_unavailable",
      }),
    });
  }
  const record: AnalysisImpactRecord<AiAnalysisElementMigrationResult, CodexAnalysisInput> =
    Object.freeze({
      element,
      role,
      sourceVersion,
      targetVersion,
      adoptedResult,
      evaluatedResult,
      currentSourceInputProjection,
      currentTargetInputProjection,
      reuseProof: roleRecord.proof,
      relatedInput,
    });
  const decision = assessAnalysisImpact(
    record,
    impactDeclarationsForElement(element, sourceVersion, targetVersion),
  );
  const diagnostic: AnalysisImpactDecisionForDiagnostics = Object.freeze({
    impact: decision.impact,
    sourceVersion: decision.sourceVersion,
    targetVersion: decision.targetVersion,
    compatibilityPath: decision.compatibilityPath,
    ...(decision.impact === "unknown" ? { reason: decision.reason } : {}),
  });
  if (decision.result.status !== "present") {
    return Object.freeze({ resolution: undefined, decision: diagnostic });
  }
  if (
    decision.impact === "deterministic" &&
    isStateAnalysisElement(element) &&
    hashCanonicalJson(decision.result.result) !== hashCanonicalJson(roleRecord.result)
  ) {
    return Object.freeze({
      resolution: undefined,
      decision: Object.freeze({
        ...diagnostic,
        impact: "interpretation_required",
      }),
    });
  }
  const result = createAiAnalysisMigrationElementResultSchema(element).parse(
    decision.result.result,
  );
  return Object.freeze({
    resolution: Object.freeze({
      result,
      proof: verifiedReuseProof(
        element,
        currentTargetInputProjection.fingerprint,
        currentTargetInputProjection.dependencyFingerprint,
        "deterministic_update",
        decision.compatibilityPath,
      ),
    }),
    decision: diagnostic,
  });
}

function analysisImpactProofsForItem(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  relatedInput: CodexAnalysisInput,
  inputFingerprints: AnalysisElementInputFingerprintMap,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisImpactResolutions {
  const evaluation = savedEvaluationRecordsForItem(
    state,
    analysis.item.nodeId,
    inputFingerprints,
    dependencyFingerprints,
  );
  const adoptedRecords = savedAdoptionRecordsForItem(
    state,
    analysis.item.nodeId,
    inputFingerprints,
    dependencyFingerprints,
  );
  const evaluationWithImpact: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {
    ...evaluation,
  };
  const adoptedWithImpact: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {
    ...adoptedRecords,
  };
  const decisions: {
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }[] = [];
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  if (previousItem == null) {
    return Object.freeze({
      evaluation: Object.freeze(evaluationWithImpact),
      adopted: Object.freeze(adoptedWithImpact),
      decisions: Object.freeze([]),
    });
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = evaluation[element];
    const adopted = adoptedRecords[element];
    const adoptedResult = analysisImpactValue(adopted?.result, "not_adopted");
    const evaluatedResult = analysisImpactValue(evaluated?.result, "not_evaluated");
    const evaluatedGeneration = previousItem.aiAnalysis.elements[element];
    const adoptedElement = previousItem.aiAnalysis.adoptedElements[element];
    const adoptedGeneration =
      adoptedElement?.origin === "current"
        ? createAiAnalysisElementSourceGenerationSchema(element).parse(adoptedElement.generation)
        : undefined;
    const roles: readonly Readonly<{
      role: "adopted" | "evaluated";
      record: AnalysisElementReuseRecord | undefined;
      generation: AiAnalysisElementSourceGeneration | undefined;
    }>[] = Object.freeze([
      Object.freeze({
        role: "evaluated",
        record: evaluated,
        generation:
          evaluatedGeneration == null
            ? undefined
            : createAiAnalysisElementSourceGenerationSchema(element).parse(
                evaluatedGeneration.generation,
              ),
      }),
      Object.freeze({ role: "adopted", record: adopted, generation: adoptedGeneration }),
    ]);
    for (const current of roles) {
      if (current.record == null) {
        continue;
      }
      const generation =
        current.generation == null
          ? undefined
          : createAiAnalysisElementSourceGenerationSchema(element).parse(current.generation);
      const impact = analysisImpactResolutionForRole(
        element,
        current.role,
        generation,
        current.record,
        adoptedResult,
        evaluatedResult,
        relatedInput,
        dependencyFingerprints,
      );
      if (impact.decision != null) {
        decisions.push({ element, role: current.role, decision: impact.decision });
      }
      if (impact.resolution != null) {
        if (current.role === "evaluated") {
          evaluationWithImpact[element] = impact.resolution;
        } else {
          adoptedWithImpact[element] = impact.resolution;
        }
      }
    }
  }
  return Object.freeze({
    evaluation: Object.freeze(evaluationWithImpact),
    adopted: Object.freeze(adoptedWithImpact),
    decisions: Object.freeze(decisions.map((value) => Object.freeze(value))),
  });
}

function codexNaturalLanguageSources(input: CodexAnalysisInput): readonly object[] {
  return input.sources.filter(
    (source) => source.kind === "body" || source.kind === "comment" || source.kind === "review",
  );
}

function codexRelationSources(input: CodexAnalysisInput): readonly object[] {
  return input.sources.filter((source) => source.kind === "relation");
}

function codexTextItem(input: CodexAnalysisInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    nodeId: input.item.nodeId,
    url: input.item.url,
    type: input.item.type,
    title: input.item.title,
    ...(input.item.authorCandidateId == null
      ? {}
      : { authorCandidateId: input.item.authorCandidateId }),
  });
}

function deterministicSignalProjection(
  signals: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const projection: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(signals, key)) {
      projection[key] = signals[key];
    }
  }
  return Object.freeze(projection);
}

function analysisImpactInputFingerprintV1(
  input: CodexAnalysisInput,
  element: AiAnalysisElement,
): AiAnalysisElementInputFingerprint {
  const naturalLanguageSources = codexNaturalLanguageSources(input);
  const relationSources = [...codexRelationSources(input), ...naturalLanguageSources];
  const stateInput = {
    item: input.item,
    candidates: input.candidates.waitingOn,
    sources: naturalLanguageSources,
    deterministicSignals: deterministicSignalProjection(input.deterministicSignals, [
      "status",
      "waitingOn",
      "requiredCheckFailure",
      "effectiveAssigneeCandidates",
      "effectiveAssigneeImplementations",
      "mentionedWaitingOnCandidates",
      "uncertainties",
    ]),
  };
  const relationInput = {
    item: codexTextItem(input),
    candidates: input.candidates.relations,
    sources: relationSources,
    deterministicSignals: deterministicSignalProjection(input.deterministicSignals, [
      "relationCandidateIds",
      "nativeBlockedBy",
      "nativeBlocking",
      "nativeParent",
      "nativeSubIssues",
    ]),
  };
  const textInput = {
    item: codexTextItem(input),
    sources: naturalLanguageSources,
  };
  const notificationInput = {
    item: codexTextItem(input),
    candidates: input.candidates,
    sources: naturalLanguageSources,
    deterministicSignals: deterministicSignalProjection(input.deterministicSignals, [
      "status",
      "waitingOn",
      "requiredCheckFailure",
      "effectiveAssigneeCandidates",
      "effectiveAssigneeImplementations",
      "mentionedWaitingOnCandidates",
      "uncertainties",
    ]),
  };
  switch (element) {
    case "status":
    case "waitingOn":
    case "nextAction":
      return hashCanonicalJson(stateInput);
    case "relations":
      return hashCanonicalJson(relationInput);
    case "progress":
    case "importance":
    case "deadline":
      return hashCanonicalJson(textInput);
    case "notification":
      return hashCanonicalJson(notificationInput);
    case "selfCommitment":
      return hashCanonicalJson({
        item: input.item,
        candidates: input.selfCommitmentCandidates,
        sources: naturalLanguageSources,
      });
    default:
      throw new UnreachableError(element);
  }
}

function elementInputFingerprints(
  input: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisElementInputFingerprintMap {
  const fingerprintFor = (element: AiAnalysisElement): AiAnalysisElementInputFingerprint => {
    const projection = analysisImpactInputProjection(
      element,
      analysisImpactTargetVersion(element),
      input,
      dependencyFingerprints,
    );
    assertNonNullable(projection, `AI判定要素の入力投影がありません。対象: ${element}`);
    return projection.fingerprint;
  };
  return Object.freeze({
    status: fingerprintFor("status"),
    waitingOn: fingerprintFor("waitingOn"),
    nextAction: fingerprintFor("nextAction"),
    relations: fingerprintFor("relations"),
    progress: fingerprintFor("progress"),
    importance: fingerprintFor("importance"),
    deadline: fingerprintFor("deadline"),
    notification: fingerprintFor("notification"),
    selfCommitment: fingerprintFor("selfCommitment"),
  });
}

function elementExecutionFingerprints(
  identity: AiAnalysisRunIdentity,
): AnalysisElementExecutionFingerprintMap {
  const createFingerprint = (element: AiAnalysisElement): AiAnalysisElementExecutionFingerprint =>
    hashCanonicalJson({
      element,
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      backendVersion: identity.backendVersion,
      schemaVersion: identity.schemaVersion,
    });
  return Object.freeze({
    status: createFingerprint("status"),
    waitingOn: createFingerprint("waitingOn"),
    nextAction: createFingerprint("nextAction"),
    relations: createFingerprint("relations"),
    progress: createFingerprint("progress"),
    importance: createFingerprint("importance"),
    deadline: createFingerprint("deadline"),
    notification: createFingerprint("notification"),
    selfCommitment: createFingerprint("selfCommitment"),
  });
}

function savedGenerationsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): AiAnalysisElementSourceGenerationMap {
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze({});
  }
  const generations: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = item.aiAnalysis.elements[element];
    if (evaluated == null) {
      continue;
    }
    generations[element] = createAiAnalysisElementSourceGenerationSchema(element).parse(
      evaluated.generation,
    );
  }
  return Object.freeze(generations);
}

function setCurrentAdoptedElement(
  adopted: MutablePartial<TrackedItemAiAnalysisCurrentAdoptedElements>,
  element: AiAnalysisElement,
  value: TrackedItemAiAnalysisCurrentAdoptedElement,
): void {
  const reuseProof = aiAnalysisElementReuseProofSchema.parse(value.reuseProof);
  switch (element) {
    case "status":
      adopted.status = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("status").parse(value.generation),
        result: createAiAnalysisMigrationElementResultSchema("status").parse(value.result),
        reuseProof,
      };
      return;
    case "waitingOn":
      adopted.waitingOn = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(value.result),
        reuseProof,
      };
      return;
    case "nextAction":
      adopted.nextAction = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("nextAction").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(value.result),
        reuseProof,
      };
      return;
    case "relations":
      adopted.relations = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("relations").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(value.result),
        reuseProof,
      };
      return;
    case "progress":
      adopted.progress = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("progress").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("progress").parse(value.result),
        reuseProof,
      };
      return;
    case "importance":
      adopted.importance = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("importance").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("importance").parse(value.result),
        reuseProof,
      };
      return;
    case "deadline":
      adopted.deadline = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("deadline").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("deadline").parse(value.result),
        reuseProof,
      };
      return;
    case "notification":
      adopted.notification = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("notification").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(value.result),
        reuseProof,
      };
      return;
    case "selfCommitment":
      adopted.selfCommitment = {
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(value.result),
        reuseProof,
      };
      return;
    default:
      throw new UnreachableError(element);
  }
}

function savedCurrentAdoptedElementsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): TrackedItemAiAnalysisCurrentAdoptedElements {
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze({});
  }
  if (item.aiAnalysis.origin === "current") {
    return item.aiAnalysis.adoptedElements;
  }
  const adopted: MutablePartial<TrackedItemAiAnalysisCurrentAdoptedElements> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const value = item.aiAnalysis.adoptedElements[element];
    if (value?.origin !== "current") {
      continue;
    }
    setCurrentAdoptedElement(adopted, element, value);
  }
  return Object.freeze(adopted);
}

function savedEvaluationRecordsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
  inputFingerprints: AnalysisElementInputFingerprintMap,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze(records);
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = item.aiAnalysis.elements[element];
    if (evaluated == null) {
      continue;
    }
    const result = createAiAnalysisMigrationElementResultSchema(element).parse(evaluated.result);
    const proof = aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof);
    let normalizedProof = proof;
    if (proof.status === "verified") {
      normalizedProof = proof;
    } else if (proof.reason !== "legacy_migration") {
      normalizedProof = proof;
    } else {
      const generation = createAiAnalysisElementSourceGenerationSchema(element).parse(
        evaluated.generation,
      );
      if (
        generation.metadata.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
        generation.metadata.inputFingerprint === inputFingerprints[element]
      ) {
        normalizedProof = isStateAnalysisElement(element)
          ? unknownReuseProof("dependency_input_unavailable")
          : verifiedReuseProof(
              element,
              inputFingerprints[element],
              dependencyFingerprints[element],
              "structural_migration",
              ["legacy_evaluation_generation_input_match"],
            );
      }
    }
    records[element] = Object.freeze({ result, proof: normalizedProof });
  }
  return Object.freeze(records);
}

function savedEvaluationRecordForElement(
  state: RuntimeState,
  nodeId: GitHubNodeId,
  element: AiAnalysisElement,
): AnalysisElementReuseRecord | undefined {
  const item = previousTrackedItem(state, nodeId);
  const evaluated = item?.aiAnalysis.elements[element];
  if (evaluated == null) {
    return undefined;
  }
  return Object.freeze({
    result: createAiAnalysisMigrationElementResultSchema(element).parse(evaluated.result),
    proof: aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof),
  });
}

function savedAdoptionRecordsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
  inputFingerprints: AnalysisElementInputFingerprintMap,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze(records);
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = item.aiAnalysis.adoptedElements[element];
    if (adopted == null) {
      continue;
    }
    const result = createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
    const proof = aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof);
    let normalizedProof = proof;
    if (proof.status === "verified") {
      normalizedProof = proof;
    } else if (adopted.origin !== "current" || proof.reason !== "legacy_migration") {
      normalizedProof = proof;
    } else {
      const generation = createAiAnalysisElementSourceGenerationSchema(element).parse(
        adopted.generation,
      );
      if (
        generation.metadata.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
        generation.metadata.inputFingerprint === inputFingerprints[element]
      ) {
        normalizedProof = isStateAnalysisElement(element)
          ? unknownReuseProof("dependency_input_unavailable")
          : verifiedReuseProof(
              element,
              inputFingerprints[element],
              dependencyFingerprints[element],
              "structural_migration",
              ["legacy_current_generation_input_match"],
            );
      }
    }
    records[element] = Object.freeze({ result, proof: normalizedProof });
  }
  return Object.freeze(records);
}

function savedMigrationAdoptedElementsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  const item = previousTrackedItem(state, nodeId);
  if (item?.aiAnalysis.origin !== "migration") {
    return Object.freeze({});
  }
  return item.aiAnalysis.adoptedElements;
}

function adoptedResultForRetainedItem(
  item: SnapshotTrackedItem,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  if (item.aiAnalysis.origin === "current") {
    const adopted = item.aiAnalysis.adoptedElements[element];
    if (adopted == null) {
      return undefined;
    }
    return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
  }
  const adopted = item.aiAnalysis.adoptedElements[element];
  if (adopted == null) {
    return undefined;
  }
  if (adopted.origin === "current") {
    return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}

function preservedElementsForRetainedItem(
  item: SnapshotTrackedItem,
): Pick<CodexPreservedElements, "relations" | "notification"> {
  const relations = adoptedResultForRetainedItem(item, "relations");
  const notification = adoptedResultForRetainedItem(item, "notification");
  return Object.freeze({
    ...(relations == null ? {} : { relations }),
    ...(notification == null ? {} : { notification }),
  });
}

function deterministicElementResult(
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const evidence: readonly AiAnalysisElementEvidence[] = Object.freeze([
    Object.freeze({
      sourceId: analysis.item.sourceId,
      summary: "決定論的な判定結果です",
      supports: "element",
    }),
  ]);
  const common = {
    evidence,
    confidence: analysis.decision.confidence,
    uncertainties: analysis.decision.uncertainties,
  };
  switch (element) {
    case "status":
      return createAiAnalysisElementResultSchema("status").parse({
        ...common,
        value: analysis.decision.status,
      });
    case "waitingOn":
      return createAiAnalysisMigrationElementResultSchema("waitingOn").parse({
        ...common,
        value: analysis.decision.waitingOn,
      });
    case "nextAction":
      return createAiAnalysisElementResultSchema("nextAction").parse({
        ...common,
        value: analysis.decision.nextAction,
      });
    case "relations":
    case "progress":
    case "importance":
    case "deadline":
    case "notification":
    case "selfCommitment":
      return undefined;
    default:
      throw new UnreachableError(element);
  }
}

function dependencyResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const item = previousTrackedItem(state, analysis.item.nodeId);
  return item == null ? undefined : adoptedResultForRetainedItem(item, element);
}

function isStateAnalysisElement(element: AiAnalysisElement): boolean {
  return element === "status" || element === "waitingOn" || element === "nextAction";
}

function stateDependencyFingerprintForResults(
  analysis: DeterministicItemAnalysis,
  results: Readonly<Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>>>,
): AiAnalysisElementInputFingerprint {
  const elements = Object.fromEntries(
    (["status", "waitingOn", "nextAction"] as const).map((element) => {
      const savedResult = results[element];
      const result =
        savedResult == null
          ? deterministicElementResult(analysis, element)
          : createAiAnalysisMigrationElementResultSchema(element).parse(savedResult);
      return [
        element,
        result == null
          ? { status: "unavailable" }
          : {
              status: "available",
              value: result.value,
              confidence: result.confidence,
              uncertainties: result.uncertainties,
            },
      ];
    }),
  );
  return hashCanonicalJson({ kind: "state", elements });
}

function stateDependencyFingerprint(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
): AiAnalysisElementInputFingerprint {
  const results: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    const result = dependencyResultForElement(state, analysis, element);
    if (result != null) {
      results[element] = result;
    }
  }
  return stateDependencyFingerprintForResults(analysis, results);
}

function finalStateDependencyFingerprint(
  analysis: DeterministicItemAnalysis,
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
): AiAnalysisElementInputFingerprint {
  const results: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    const currentElement = current[element];
    if (currentElement != null) {
      results[element] = currentElement.result;
      continue;
    }
    const migrationResult = migration[element];
    if (migrationResult != null) {
      results[element] = migrationResult;
    }
  }
  return stateDependencyFingerprintForResults(analysis, results);
}

function elementDependencyFingerprints(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
): AnalysisElementDependencyFingerprintMap {
  const stateFingerprint = stateDependencyFingerprint(state, analysis);
  const independentFingerprint = hashCanonicalJson({ kind: "independent" });
  return Object.freeze({
    status: stateFingerprint,
    waitingOn: stateFingerprint,
    nextAction: stateFingerprint,
    relations: independentFingerprint,
    progress: independentFingerprint,
    importance: independentFingerprint,
    deadline: independentFingerprint,
    notification: independentFingerprint,
    selfCommitment: independentFingerprint,
  });
}

function unknownReuseProof(
  reason:
    | "legacy_migration"
    | "source_input_unavailable"
    | "source_contract_unavailable"
    | "dependency_input_unavailable"
    | "compatibility_route_missing"
    | "semantic_impact_unknown",
): AiAnalysisElementReuseProof {
  return aiAnalysisElementReuseProofSchema.parse({
    status: "unknown",
    reuseSchemaVersion: "1",
    reason,
  });
}

function verifiedReuseProof(
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  dependencyFingerprint: AiAnalysisElementInputFingerprint,
  source: "current_generation" | "structural_migration" | "deterministic_update",
  compatibilityPath: readonly string[],
): AiAnalysisElementReuseProof {
  return aiAnalysisElementReuseProofSchema.parse({
    status: "verified",
    reuseSchemaVersion: "1",
    source,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[element],
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
    inputFingerprint,
    dependencyFingerprint,
    compatibilityPath,
  });
}

function evaluationRecordsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  generations: AiAnalysisElementSourceGenerationMap,
  run: AiAnalysisRunResult | undefined,
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
  target: AiAnalysisTarget | undefined,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const dependencyFingerprints = Object.freeze({
    status: planning.candidates.status.dependencyFingerprint,
    waitingOn: planning.candidates.waitingOn.dependencyFingerprint,
    nextAction: planning.candidates.nextAction.dependencyFingerprint,
    relations: planning.candidates.relations.dependencyFingerprint,
    progress: planning.candidates.progress.dependencyFingerprint,
    importance: planning.candidates.importance.dependencyFingerprint,
    deadline: planning.candidates.deadline.dependencyFingerprint,
    notification: planning.candidates.notification.dependencyFingerprint,
    selfCommitment: planning.candidates.selfCommitment.dependencyFingerprint,
  });
  const generated = generatedElementsForNode(run, analysis.item.nodeId);
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = generations[element];
    if (generation == null) {
      continue;
    }
    const candidate = planning.candidates[element];
    const preserveForcedUnexecutedEvaluation =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    if (generated[element] == null && preserveForcedUnexecutedEvaluation) {
      const saved = savedEvaluationRecordForElement(state, analysis.item.nodeId, element);
      if (saved != null) {
        records[element] = saved;
      }
      continue;
    }
    if (generated[element] != null) {
      const dependencyFingerprint = isStateAnalysisElement(element)
        ? finalStateDependencyFingerprint(analysis, current, migration)
        : dependencyFingerprints[element];
      records[element] = Object.freeze({
        result: createAiAnalysisMigrationElementResultSchema(element).parse(generation.result),
        proof: verifiedReuseProof(
          element,
          planning.candidates[element].inputFingerprint,
          dependencyFingerprint,
          "current_generation",
          ["current_evaluation"],
        ),
      });
      continue;
    }
    const saved = candidate.savedEvaluation;
    records[element] =
      saved ??
      Object.freeze({
        result: createAiAnalysisMigrationElementResultSchema(element).parse(generation.result),
        proof: unknownReuseProof("source_input_unavailable"),
      });
  }
  return Object.freeze(records);
}

function currentAdoptedGenerationForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  savedRecord: AnalysisElementReuseRecord | undefined,
): AiAnalysisElementSourceGeneration | undefined {
  const adopted = savedCurrentAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted == null) {
    return undefined;
  }
  const dependencyFingerprint = elementDependencyFingerprints(state, analysis)[element];
  if (
    determineAnalysisElementReuse({
      element,
      inputFingerprint,
      inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
      dependencyFingerprint,
      savedProof: savedRecord?.proof ?? adopted.reuseProof,
    }) !== "verified"
  ) {
    return undefined;
  }
  const parsedGeneration = createAiAnalysisElementSourceGenerationSchema(element).parse(
    adopted.generation,
  );
  return parsedGeneration;
}

function currentAdoptedElementForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): TrackedItemAiAnalysisCurrentAdoptedElement | undefined {
  const adopted = savedCurrentAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted == null) {
    return undefined;
  }
  return Object.freeze({
    origin: "current",
    generation: createAiAnalysisElementSourceGenerationSchema(element).parse(adopted.generation),
    result: createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result),
    reuseProof: aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
  });
}

function currentAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = currentAdoptedElementForElement(state, analysis, element);
  return adopted == null ? undefined : adopted.result;
}

function verifiedCurrentAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  savedRecord: AnalysisElementReuseRecord | undefined,
): AiAnalysisElementMigrationResult | undefined {
  if (
    currentAdoptedGenerationForElement(state, analysis, element, inputFingerprint, savedRecord) ==
    null
  ) {
    return undefined;
  }
  return currentAdoptedResultForElement(state, analysis, element);
}

function forcedAiAnalysisTarget(configuration: RuntimeConfiguration): AiAnalysisTarget | undefined {
  if (
    configuration.target.kind !== "sandbox" ||
    configuration.target.context.analysisMode.kind !== "forced"
  ) {
    return undefined;
  }
  return createAiAnalysisTarget(configuration.target.context.analysisMode.target);
}

function isForcedUnexecutedElement(
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  target: AiAnalysisTarget | undefined,
): boolean {
  return (
    target != null && (target.nodeId !== analysis.item.nodeId || !target.elements.includes(element))
  );
}

function currentSavedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  return currentAdoptedResultForElement(state, analysis, element);
}

function currentSavedGenerationForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementSourceGeneration | undefined {
  return currentAdoptedElementForElement(state, analysis, element)?.generation;
}

function forcedMigrationAdoptedElementForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  element: AiAnalysisElement,
  target: AiAnalysisTarget | undefined,
): TrackedItemAiAnalysisMigrationAdoptedElement | undefined {
  if (
    !isForcedUnexecutedElement(analysis, element, target) ||
    planning.candidates[element].necessity !== "required"
  ) {
    return undefined;
  }
  const adopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  return adopted?.origin === "migration" ? adopted : undefined;
}

function forcedMigrationReuseRecordsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    if (adopted == null) {
      continue;
    }
    records[element] = Object.freeze({
      result: createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result),
      proof: aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof),
    });
  }
  return Object.freeze(records);
}

function preservedElementsForForcedTargetInput(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): CodexPreservedElements {
  const selectedElements = new Set(target.elements);
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (selectedElements.has(element)) {
      continue;
    }
    const candidate = planning.candidates[element];
    const result =
      candidate.necessity === "not_required"
        ? deterministicElementResult(analysis, element)
        : (currentSavedResultForElement(state, analysis, element) ??
          migrationAdoptedResultForElement(state, analysis, element) ??
          deterministicElementResult(analysis, element));
    if (result != null) {
      preservedElements[element] = result;
    }
  }
  return Object.freeze(preservedElements);
}

function preservedElementsForForcedReduction(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): CodexPreservedElements {
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = planning.candidates[element];
    if (candidate.necessity !== "required") {
      continue;
    }
    let result: AiAnalysisElementMigrationResult | undefined;
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    if (forcedMigration != null) {
      result = createAiAnalysisMigrationElementResultSchema(element).parse(forcedMigration.result);
    } else if (isForcedUnexecutedElement(analysis, element, target)) {
      result = currentSavedResultForElement(state, analysis, element);
    }
    result ??= candidate.savedReuse?.result;
    if (result == null && previousItem != null) {
      result = adoptedResultForRetainedItem(previousItem, element);
    }
    if (result != null) {
      preservedElements[element] = result;
    }
  }
  return Object.freeze(preservedElements);
}

function migrationAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted?.origin !== "migration") {
    return undefined;
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}

function verifiedMigrationAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  savedRecord: AnalysisElementReuseRecord | undefined,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted == null) {
    return undefined;
  }
  const dependencyFingerprint = elementDependencyFingerprints(state, analysis)[element];
  if (
    determineAnalysisElementReuse({
      element,
      inputFingerprint,
      inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
      dependencyFingerprint,
      savedProof: savedRecord?.proof ?? adopted.reuseProof,
    }) !== "verified"
  ) {
    return undefined;
  }
  if (adopted.origin === "current") {
    return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}

function preservedElementsWithCompatibleRelations(
  preservedElements: CodexPreservedElements,
  input: CodexAnalysisInput | undefined,
): CodexPreservedElements {
  const relations = preservedElements.relations;
  if (relations == null) {
    return preservedElements;
  }
  if (input != null) {
    const relationValidationInput = createCodexAnalysisInput({
      ...input,
      selectedElements: ["relations"],
      lockedElements: {},
    });
    try {
      validateCodexAnalysisOutput(
        {
          schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
          item: {
            nodeId: relationValidationInput.item.nodeId,
            url: relationValidationInput.item.url,
          },
          relations,
        },
        relationValidationInput,
      );
      return preservedElements;
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputValidationError)) {
        throw error;
      }
    }
  }
  const compatibleElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {
    ...preservedElements,
  };
  delete compatibleElements.relations;
  return Object.freeze(compatibleElements);
}

function preservedElementsForSelection(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
  input: CodexAnalysisInput,
): CodexPreservedElements {
  if (target?.nodeId === analysis.item.nodeId) {
    return preservedElementsWithCompatibleRelations(
      preservedElementsForForcedTargetInput(state, analysis, planning, target),
      input,
    );
  }
  const preservedElements: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> =
    {};
  for (const skipped of planning.selection.skipped) {
    if (skipped.reason === "up_to_date") {
      const savedReuse = skipped.candidate.savedReuse;
      let reused: AiAnalysisElementMigrationResult | undefined;
      if (
        savedReuse != null &&
        determineAnalysisElementReuse({
          element: skipped.candidate.element,
          inputFingerprint: skipped.candidate.inputFingerprint,
          inputProjectionVersion: skipped.candidate.inputProjectionVersion,
          dependencyFingerprint: skipped.candidate.dependencyFingerprint,
          savedProof: savedReuse.proof,
        }) === "verified"
      ) {
        reused = savedReuse.result;
      }
      const adopted = verifiedCurrentAdoptedResultForElement(
        state,
        analysis,
        skipped.candidate.element,
        skipped.candidate.inputFingerprint,
        savedReuse,
      );
      const migrated = verifiedMigrationAdoptedResultForElement(
        state,
        analysis,
        skipped.candidate.element,
        skipped.candidate.inputFingerprint,
        savedReuse,
      );
      const deterministic = deterministicElementResult(analysis, skipped.candidate.element);
      const result = reused ?? adopted ?? migrated ?? deterministic;
      if (result != null) {
        preservedElements[skipped.candidate.element] = result;
      }
      continue;
    }
    const deterministic = deterministicElementResult(analysis, skipped.candidate.element);
    if (deterministic != null) {
      preservedElements[skipped.candidate.element] = deterministic;
    }
  }
  return preservedElementsWithCompatibleRelations(Object.freeze(preservedElements), input);
}

function necessityInputForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  hasSelfCommitmentCandidate: boolean,
): AnalysisElementNecessityInput {
  const terminal = isTerminalStatus(analysis.decision.status);
  const unresolvedRequest =
    !terminal && analysis.item.type === "issue" && analysis.detail.type === "issue"
      ? createIssueRequestCandidates(analysis.item, analysis.detail).length > 0
      : false;
  const unresolvedCi =
    !terminal && analysis.item.type === "pull_request" && analysis.detail.type === "pull_request"
      ? checkFailureSourceIds(analysis.detail) != null
      : false;
  const relationAssessmentCandidates = selectRelationAssessmentCandidates(
    analysis.item.nodeId,
    analysis.relationCandidates,
  );
  const hasUnresolvedRelationCandidate = relationAssessmentCandidates.some(
    (candidate) => candidate.authority === "inferred",
  );
  const hasHumanProgressCandidate = analysis.item.events.some(
    (event) => event.kind === "comment" && event.actor.type === "human" && !event.bodyEmpty,
  );
  const hasNativeBlocker = analysis.relationCandidates.some(
    (candidate) =>
      candidate.provenance === "native" &&
      candidate.relation.type === "blocks" &&
      candidate.relation.blocked.nodeId === analysis.item.nodeId,
  );
  const notificationAiIsConsumed =
    !terminal &&
    analysis.decision.determination === "codex_candidate" &&
    !hasNativeBlocker &&
    analysis.notificationClass !== "automation_noise" &&
    !analysis.notificationsSuppressedByLabel;
  const stateDecisionNecessities = analysis.decision.aiAnalysisElementNecessities;
  const stateCandidate = {
    unresolvedRequest,
    unresolvedCi,
    effectiveAssigneeCandidate: analysis.effectiveAssigneeCandidates.length !== 0,
  };
  const allRelationCandidatesAuthoritative = relationAssessmentCandidates.every(
    (candidate) => candidate.authority === "authoritative",
  );
  const normalAiAnalysisScope =
    analysis.decision.determination !== "determined" ||
    analysis.effectiveAssigneeCandidates.length !== 0 ||
    hasHumanProgressCandidate ||
    !allRelationCandidatesAuthoritative;
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);
  return Object.freeze({
    state: Object.freeze({
      status: Object.freeze({
        deterministic: stateDecisionNecessities.status === "not_required",
        ...stateCandidate,
      }),
      waitingOn: Object.freeze({
        deterministic: stateDecisionNecessities.waitingOn === "not_required",
        ...stateCandidate,
      }),
      nextAction: Object.freeze({
        deterministic: stateDecisionNecessities.nextAction === "not_required",
        ...stateCandidate,
      }),
    }),
    hasUnresolvedRelationCandidate,
    hasHumanProgressCandidate,
    importance: Object.freeze({
      normalAiAnalysisScope,
      currentlyAdopted: previousItem?.importanceAssessment.status === "available",
    }),
    deadline: Object.freeze({
      normalAiAnalysisScope,
      currentlyAdopted: previousItem?.deadlineAssessment.status === "available",
    }),
    notification: Object.freeze({
      aiIsConsumed: notificationAiIsConsumed,
    }),
    selfCommitment: Object.freeze({
      hasEligibleCandidate: hasSelfCommitmentCandidate,
    }),
  });
}

function forcedAnalysisSelection(
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): AnalysisElementSelection {
  const candidatesByElement = new Map(
    AI_ANALYSIS_ELEMENTS.map((element) => [element, planning.candidates[element]]),
  );
  const selected = target.elements.map((element) => {
    const candidate = candidatesByElement.get(element);
    assertNonNullable(candidate, `指定したAI分析要素の候補がありません。対象: ${element}`);
    if (candidate.necessity !== "required") {
      throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
    }
    return candidate;
  });
  const selectedSet = new Set(target.elements);
  const skipped = AI_ANALYSIS_ELEMENTS.filter((element) => !selectedSet.has(element)).map(
    (element) => {
      const candidate = candidatesByElement.get(element);
      assertNonNullable(candidate, `指定したAI分析要素の候補がありません。対象: ${element}`);
      return Object.freeze({
        candidate: Object.freeze({
          ...candidate,
          necessity: "not_required" as const,
        }),
        reason: "not_required" as const,
      });
    },
  );
  return Object.freeze({
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped),
    shouldCallAi: true,
  });
}

function forcedCandidateElements(
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget,
): readonly AnalysisElementSelectionCandidate[] {
  const selectedSet = new Set(target.elements);
  return Object.freeze(
    AI_ANALYSIS_ELEMENTS.map((element) => {
      const candidate = planning.candidates[element];
      const selected = selectedSet.has(element);
      if (selected && candidate.necessity !== "required") {
        throw new TypeError(`指定したAI分析対象の要素はrequiredではありません。対象: ${element}`);
      }
      return Object.freeze({
        ...candidate,
        necessity: selected ? ("required" as const) : ("not_required" as const),
      });
    }),
  );
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
  analysisImpactDecisions: readonly Readonly<{
    candidateId: string;
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
  elementPlanningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>;
}> {
  const inputByNodeId = new Map<GitHubNodeId, CodexAnalysisInput>();
  const elementPlanningByNodeId = new Map<GitHubNodeId, AnalysisElementPlanning>();
  const failures: AiAnalysisRunFailure[] = [];
  const inputValidationFailures: {
    candidateId: string;
    error: unknown;
  }[] = [];
  const analysisImpactDecisions: {
    candidateId: string;
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }[] = [];
  const previousGraph = previousGraphIndex(state);
  const previousImpactByNodeId =
    previousGraph.availability === "available"
      ? previousGraph.downstreamImpactByNodeId
      : new Map<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]>();
  const previousRelations = previousSnapshot(state)?.relations ?? [];
  const previousAiAnalysisStatusByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item.aiAnalysis.status]),
  );
  const target = forcedAiAnalysisTarget(configuration);
  const candidates: PreparedAiAnalysisCandidate[] = [];
  for (const analysis of deterministicAnalysis.items) {
    const previousObservedAt = previousTrackedItem(state, analysis.item.nodeId)?.observedAt;
    let baseInput: CodexAnalysisInput;
    try {
      baseInput = createCodexInput(
        configuration,
        collection.evaluatedAt,
        analysis,
        [],
        {},
        previousObservedAt,
      );
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
    const savedGenerations = savedGenerationsForItem(state, analysis.item.nodeId);
    const dependencyFingerprints = elementDependencyFingerprints(state, analysis);
    const inputFingerprints = elementInputFingerprints(baseInput, dependencyFingerprints);
    const savedEvaluations = savedEvaluationRecordsForItem(
      state,
      analysis.item.nodeId,
      inputFingerprints,
      dependencyFingerprints,
    );
    const savedReuses = savedAdoptionRecordsForItem(
      state,
      analysis.item.nodeId,
      inputFingerprints,
      dependencyFingerprints,
    );
    const impactResolutions = analysisImpactProofsForItem(
      state,
      analysis,
      baseInput,
      inputFingerprints,
      dependencyFingerprints,
    );
    const planningEvaluations = Object.freeze({
      ...savedEvaluations,
      ...impactResolutions.evaluation,
    });
    const planningReuses = Object.freeze({
      ...savedReuses,
      ...impactResolutions.adopted,
    });
    for (const impact of impactResolutions.decisions) {
      analysisImpactDecisions.push(
        Object.freeze({
          candidateId: analysis.item.nodeId,
          element: impact.element,
          role: impact.role,
          decision: impact.decision,
        }),
      );
    }
    const necessities = determineAnalysisElementNecessities(
      necessityInputForAnalysis(state, analysis, baseInput.selfCommitmentCandidates.length !== 0),
    );
    const planning = planAnalysisElements({
      necessities,
      inputFingerprints,
      executionFingerprints: elementExecutionFingerprints(identity),
      inputProjectionVersions: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
      dependencyFingerprints,
      savedGenerations,
      savedEvaluations: planningEvaluations,
      savedReuses: planningReuses,
    });
    const targetForAnalysis = target?.nodeId === analysis.item.nodeId ? target : undefined;
    const executionPlanning =
      targetForAnalysis == null
        ? planning
        : Object.freeze({
            ...planning,
            selection: forcedAnalysisSelection(planning, targetForAnalysis),
          });
    elementPlanningByNodeId.set(analysis.item.nodeId, executionPlanning);
    const input = createCodexInput(
      configuration,
      collection.evaluatedAt,
      analysis,
      executionPlanning.selection.selected.map((candidate) => candidate.element),
      preservedElementsForSelection(
        state,
        analysis,
        executionPlanning,
        targetForAnalysis,
        baseInput,
      ),
      previousObservedAt,
    );
    inputByNodeId.set(analysis.item.nodeId, input);
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
    const previousAiAnalysisStatus = previousAiAnalysisStatusByNodeId.get(analysis.item.nodeId);
    const estimatedCost = estimateAiInputCost(
      `${serializeCanonicalJson(input)}\n`,
      configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
    );
    const candidate = Object.freeze({
      id: analysis.item.nodeId,
      input,
      elements:
        targetForAnalysis == null
          ? Object.freeze(AI_ANALYSIS_ELEMENTS.map((element) => planning.candidates[element]))
          : forcedCandidateElements(planning, targetForAnalysis),
      promptFingerprint: CODEX_PROMPT_FINGERPRINT,
      priority: Object.freeze({
        previouslyDeferred: previousAiAnalysisStatus === "deferred",
        severityCandidate: analysis.decision.determination === "codex_candidate",
        ownerUnknown: analysis.decision.waitingOn.some((waitingOn) => waitingOn.kind === "unknown"),
        changedBlocker,
        downstreamImpact: Object.freeze({
          openNodeCount: previousImpact?.openNodeCount ?? 0,
          repositoryCount: previousImpact?.repositoryCount ?? 0,
        }),
      }),
      estimatedCostUsd: estimatedCost.estimatedCostUsd,
    } satisfies AiAnalysisCandidate);
    candidates.push(prepareAiAnalysisCandidate(candidate));
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    failures: Object.freeze(failures),
    inputValidationFailures: Object.freeze(inputValidationFailures),
    analysisImpactDecisions: Object.freeze(analysisImpactDecisions),
    inputByNodeId,
    elementPlanningByNodeId,
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

type AiAnalysisRunElement = AiAnalysisRunResult["results"][number]["elements"][number];

type AiAnalysisRunIndex = Readonly<{
  resultByNodeId: ReadonlyMap<string, AiAnalysisRunResult["results"][number]>;
  failureByNodeId: ReadonlyMap<string, AiAnalysisRunResult["failures"][number]>;
  deferredByNodeId: ReadonlyMap<string, AiAnalysisRunResult["deferred"][number]>;
  skippedByNodeId: ReadonlyMap<string, AiAnalysisRunResult["skipped"][number]>;
  generatedElementsByNodeId: ReadonlyMap<string, AiAnalysisElementGenerationMap>;
}>;

const EMPTY_AI_ANALYSIS_ELEMENT_GENERATIONS = Object.freeze({});
const EMPTY_AI_ANALYSIS_RUN_INDEX: AiAnalysisRunIndex = Object.freeze({
  resultByNodeId: new Map(),
  failureByNodeId: new Map(),
  deferredByNodeId: new Map(),
  skippedByNodeId: new Map(),
  generatedElementsByNodeId: new Map(),
});
const aiAnalysisRunIndexByRun = new WeakMap<AiAnalysisRunResult, AiAnalysisRunIndex>();

type MutablePartial<Value> = {
  -readonly [Key in keyof Value]?: Value[Key];
};

type ConsumerCodexElementOutput = Readonly<{
  schemaVersion: typeof CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION;
  item: Readonly<{
    nodeId: string;
    url: string;
  }>;
  status?: AiAnalysisElementMigrationResult<"status"> | undefined;
  waitingOn?: AiAnalysisElementMigrationResult<"waitingOn"> | undefined;
  nextAction?: AiAnalysisElementMigrationResult<"nextAction"> | undefined;
  relations?: AiAnalysisElementMigrationResult<"relations"> | undefined;
  progress?: AiAnalysisElementMigrationResult<"progress"> | undefined;
  importance?: AiAnalysisElementMigrationResult<"importance"> | undefined;
  deadline?: AiAnalysisElementMigrationResult<"deadline"> | undefined;
  notification?: AiAnalysisElementMigrationResult<"notification"> | undefined;
  selfCommitment?: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
}>;

type MutableConsumerCodexElementOutput = {
  -readonly [Key in keyof ConsumerCodexElementOutput]: ConsumerCodexElementOutput[Key];
};

function generationMapForRunElements(
  elements: readonly AiAnalysisRunElement[],
): AiAnalysisElementGenerationMap {
  const generations: Partial<Record<AiAnalysisElement, AiAnalysisElementGeneration>> = {};
  for (const elementResult of elements) {
    const element = elementResult.element;
    const generation = createAiAnalysisElementGenerationSchema(element).parse(
      elementResult.generation,
    );
    generations[element] = generation;
  }
  return Object.freeze(generations);
}

function aiAnalysisRunIndex(run: AiAnalysisRunResult | undefined): AiAnalysisRunIndex {
  if (run == null) {
    return EMPTY_AI_ANALYSIS_RUN_INDEX;
  }
  const cached = aiAnalysisRunIndexByRun.get(run);
  if (cached != null) {
    return cached;
  }
  const resultByNodeId = new Map<string, AiAnalysisRunResult["results"][number]>();
  const failureByNodeId = new Map<string, AiAnalysisRunResult["failures"][number]>();
  const deferredByNodeId = new Map<string, AiAnalysisRunResult["deferred"][number]>();
  const skippedByNodeId = new Map<string, AiAnalysisRunResult["skipped"][number]>();
  const generatedElementsByNodeId = new Map<string, AiAnalysisElementGenerationMap>();
  for (const result of run.results) {
    if (!resultByNodeId.has(result.candidateId)) {
      resultByNodeId.set(result.candidateId, result);
      generatedElementsByNodeId.set(
        result.candidateId,
        generationMapForRunElements(result.elements),
      );
    }
  }
  for (const failure of run.failures) {
    if (!failureByNodeId.has(failure.candidateId)) {
      failureByNodeId.set(failure.candidateId, failure);
    }
  }
  for (const deferred of run.deferred) {
    if (!deferredByNodeId.has(deferred.candidateId)) {
      deferredByNodeId.set(deferred.candidateId, deferred);
    }
  }
  for (const skipped of run.skipped) {
    if (!skippedByNodeId.has(skipped.candidateId)) {
      skippedByNodeId.set(skipped.candidateId, skipped);
    }
  }
  const index: AiAnalysisRunIndex = Object.freeze({
    resultByNodeId,
    failureByNodeId,
    deferredByNodeId,
    skippedByNodeId,
    generatedElementsByNodeId,
  });
  aiAnalysisRunIndexByRun.set(run, index);
  return index;
}

function trackedAiAnalysisElementsForGenerations(
  generations: AiAnalysisElementSourceGenerationMap,
): AiAnalysisElementSourceGenerationMap {
  let status: AiAnalysisElementSourceGeneration<"status"> | undefined;
  let waitingOn: AiAnalysisElementSourceGeneration<"waitingOn"> | undefined;
  let nextAction: AiAnalysisElementSourceGeneration<"nextAction"> | undefined;
  let relations: AiAnalysisElementSourceGeneration<"relations"> | undefined;
  let progress: AiAnalysisElementSourceGeneration<"progress"> | undefined;
  let importance: AiAnalysisElementSourceGeneration<"importance"> | undefined;
  let deadline: AiAnalysisElementSourceGeneration<"deadline"> | undefined;
  let notification: AiAnalysisElementSourceGeneration<"notification"> | undefined;
  let selfCommitment: AiAnalysisElementSourceGeneration<"selfCommitment"> | undefined;
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = generations[element];
    if (generation == null) {
      continue;
    }
    switch (element) {
      case "status":
        status = createAiAnalysisElementSourceGenerationSchema("status").parse(generation);
        break;
      case "waitingOn":
        waitingOn = createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(generation);
        break;
      case "nextAction":
        nextAction = createAiAnalysisElementSourceGenerationSchema("nextAction").parse(generation);
        break;
      case "relations":
        relations = createAiAnalysisElementSourceGenerationSchema("relations").parse(generation);
        break;
      case "progress":
        progress = createAiAnalysisElementSourceGenerationSchema("progress").parse(generation);
        break;
      case "importance":
        importance = createAiAnalysisElementSourceGenerationSchema("importance").parse(generation);
        break;
      case "deadline":
        deadline = createAiAnalysisElementSourceGenerationSchema("deadline").parse(generation);
        break;
      case "notification":
        notification =
          createAiAnalysisElementSourceGenerationSchema("notification").parse(generation);
        break;
      case "selfCommitment":
        selfCommitment =
          createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(generation);
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze({
    ...(status == null ? {} : { status }),
    ...(waitingOn == null ? {} : { waitingOn }),
    ...(nextAction == null ? {} : { nextAction }),
    ...(relations == null ? {} : { relations }),
    ...(progress == null ? {} : { progress }),
    ...(importance == null ? {} : { importance }),
    ...(deadline == null ? {} : { deadline }),
    ...(notification == null ? {} : { notification }),
    ...(selfCommitment == null ? {} : { selfCommitment }),
  });
}

function generatedElementsForNode(
  run: AiAnalysisRunResult | undefined,
  nodeId: GitHubNodeId,
): AiAnalysisElementGenerationMap {
  return (
    aiAnalysisRunIndex(run).generatedElementsByNodeId.get(nodeId) ??
    EMPTY_AI_ANALYSIS_ELEMENT_GENERATIONS
  );
}

function setEvaluatedElement(
  evaluated: MutablePartial<TrackedItemAiAnalysisCurrentElements>,
  element: AiAnalysisElement,
  generation: AiAnalysisElementSourceGeneration,
  evaluation: AnalysisElementReuseRecord,
): void {
  const value: TrackedItemAiAnalysisCurrentElement = {
    generation,
    result: createAiAnalysisMigrationElementResultSchema(element).parse(evaluation.result),
    evaluationProof: aiAnalysisElementReuseProofSchema.parse(evaluation.proof),
  };
  switch (element) {
    case "status":
      evaluated.status = {
        generation: createAiAnalysisElementSourceGenerationSchema("status").parse(value.generation),
        result: createAiAnalysisMigrationElementResultSchema("status").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "waitingOn":
      evaluated.waitingOn = {
        generation: createAiAnalysisElementSourceGenerationSchema("waitingOn").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "nextAction":
      evaluated.nextAction = {
        generation: createAiAnalysisElementSourceGenerationSchema("nextAction").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "relations":
      evaluated.relations = {
        generation: createAiAnalysisElementSourceGenerationSchema("relations").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "progress":
      evaluated.progress = {
        generation: createAiAnalysisElementSourceGenerationSchema("progress").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("progress").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "importance":
      evaluated.importance = {
        generation: createAiAnalysisElementSourceGenerationSchema("importance").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("importance").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "deadline":
      evaluated.deadline = {
        generation: createAiAnalysisElementSourceGenerationSchema("deadline").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("deadline").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "notification":
      evaluated.notification = {
        generation: createAiAnalysisElementSourceGenerationSchema("notification").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    case "selfCommitment":
      evaluated.selfCommitment = {
        generation: createAiAnalysisElementSourceGenerationSchema("selfCommitment").parse(
          value.generation,
        ),
        result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(value.result),
        evaluationProof: aiAnalysisElementReuseProofSchema.parse(value.evaluationProof),
      };
      return;
    default:
      throw new UnreachableError(element);
  }
}

function evaluatedElementsForGenerations(
  generations: AiAnalysisElementSourceGenerationMap,
  evaluations: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>,
  missingEvaluationElements: ReadonlySet<AiAnalysisElement>,
): TrackedItemAiAnalysisCurrentElements {
  const evaluated: MutablePartial<TrackedItemAiAnalysisCurrentElements> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = generations[element];
    if (generation == null) {
      continue;
    }
    const evaluation = evaluations[element];
    if (evaluation == null && missingEvaluationElements.has(element)) {
      continue;
    }
    assertNonNullable(evaluation, `AI評価のresultと再利用証明がありません。対象: ${element}`);
    setEvaluatedElement(evaluated, element, generation, evaluation);
  }
  return Object.freeze(evaluated);
}

function generationsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning | undefined,
  run: AiAnalysisRunResult | undefined,
  target: AiAnalysisTarget | undefined,
): AiAnalysisElementSourceGenerationMap {
  const saved = savedGenerationsForItem(state, analysis.item.nodeId);
  if (planning == null) {
    return saved;
  }
  const generated = generatedElementsForNode(run, analysis.item.nodeId);
  const preserved: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (generated[element] != null) {
      continue;
    }
    const generation = saved[element];
    if (generation == null) {
      continue;
    }
    if (
      isForcedUnexecutedElement(analysis, element, target) &&
      planning.candidates[element].necessity === "not_required"
    ) {
      continue;
    }
    preserved[element] = createAiAnalysisElementSourceGenerationSchema(element).parse(generation);
  }
  return reduceAiAnalysisElements({
    selectedElements: planning.selection.selected.map((candidate) => candidate.element),
    generatedElements: generated,
    preservedElements: preserved,
  }).elements;
}

function adoptedGenerationForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  element: AiAnalysisElement,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  target: AiAnalysisTarget | undefined,
): AiAnalysisElementSourceGeneration | undefined {
  const candidate = planning.candidates[element];
  if (candidate.necessity === "not_required") {
    return undefined;
  }
  const generated = generatedElementsForNode(run, analysis.item.nodeId)[element];
  const application = reduction?.ai.elements[element]?.application;
  const consumerResult =
    consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
  const generatedWasConsumed =
    generated != null &&
    consumerResult != null &&
    hashCanonicalJson(consumerResult) === hashCanonicalJson(generated.result);
  const stateElement = element === "status" || element === "waitingOn" || element === "nextAction";
  const generatedWasAccepted = application === "applied" || (!stateElement && generatedWasConsumed);
  if (generatedWasAccepted) {
    assertNonNullable(generated, `採用されたAI生成結果がありません。対象: ${element}`);
    return createAiAnalysisElementGenerationSchema(element).parse(generated);
  }
  if (isForcedUnexecutedElement(analysis, element, target)) {
    return currentSavedGenerationForElement(state, analysis, element);
  }
  const retained = currentAdoptedElementForElement(state, analysis, element);
  return retained == null
    ? undefined
    : createAiAnalysisElementSourceGenerationSchema(element).parse(retained.generation);
}

function adoptedElementsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  migration: TrackedItemAiAnalysisMigrationElements,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  target: AiAnalysisTarget | undefined,
): TrackedItemAiAnalysisCurrentAdoptedElements {
  const adoptedGenerations: Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>> =
    {};
  const generatedElements = generatedElementsForNode(run, analysis.item.nodeId);
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = adoptedGenerationForElement(
      state,
      analysis,
      planning,
      element,
      run,
      reduction,
      consumerOutput,
      target,
    );
    if (generation != null) {
      adoptedGenerations[element] =
        createAiAnalysisElementSourceGenerationSchema(element).parse(generation);
    }
  }
  const currentGenerations = trackedAiAnalysisElementsForGenerations(
    Object.freeze(adoptedGenerations),
  );
  const adoptedResults: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  const generatedAcceptedElements = new Set<AiAnalysisElement>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = currentGenerations[element];
    if (generation == null) {
      continue;
    }
    const retained = currentAdoptedElementForElement(state, analysis, element);
    const candidate = planning.candidates[element];
    const savedReuse = planning.candidates[element].savedReuse;
    const generated = generatedElements[element];
    const application = reduction?.ai.elements[element]?.application;
    const consumerResult =
      consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
    const generatedWasConsumed =
      generated != null &&
      consumerResult != null &&
      hashCanonicalJson(consumerResult) === hashCanonicalJson(generated.result);
    const stateElement = isStateAnalysisElement(element);
    const generatedWasAccepted =
      application === "applied" || (!stateElement && generatedWasConsumed);
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    if (generatedWasAccepted) {
      generatedAcceptedElements.add(element);
    }
    const generatedResult = createAiAnalysisMigrationElementResultSchema(element).parse(
      generation.result,
    );
    let adoptedResult: AiAnalysisElementMigrationResult;
    if (generatedWasAccepted) {
      adoptedResult = generatedResult;
    } else if (preserveForcedUnexecutedElement) {
      adoptedResult = retained?.result ?? savedReuse?.result ?? generatedResult;
    } else {
      adoptedResult = savedReuse?.result ?? retained?.result ?? generatedResult;
    }
    adoptedResults[element] = adoptedResult;
  }
  const finalResults = { ...adoptedResults };
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    if (finalResults[element] == null && migration[element] != null) {
      finalResults[element] = migration[element];
    }
  }
  const finalStateDependencyFingerprint = stateDependencyFingerprintForResults(
    analysis,
    finalResults,
  );
  const adopted: MutablePartial<TrackedItemAiAnalysisCurrentAdoptedElements> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generation = currentGenerations[element];
    if (generation == null) {
      continue;
    }
    const retained = currentAdoptedElementForElement(state, analysis, element);
    const candidate = planning.candidates[element];
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    let proof: AiAnalysisElementReuseProof;
    if (generatedAcceptedElements.has(element)) {
      proof = verifiedReuseProof(
        element,
        candidate.inputFingerprint,
        isStateAnalysisElement(element)
          ? finalStateDependencyFingerprint
          : hashCanonicalJson({ kind: "independent" }),
        "current_generation",
        ["current_generation"],
      );
    } else if (preserveForcedUnexecutedElement) {
      proof =
        retained?.reuseProof ??
        candidate.savedReuse?.proof ??
        unknownReuseProof("source_input_unavailable");
    } else {
      proof =
        candidate.savedReuse?.proof ??
        retained?.reuseProof ??
        unknownReuseProof("source_input_unavailable");
    }
    const adoptedResult = adoptedResults[element];
    assertNonNullable(adoptedResult, `採用されたAI結果がありません。対象: ${element}`);
    setCurrentAdoptedElement(
      adopted,
      element,
      Object.freeze({
        origin: "current",
        generation: createAiAnalysisElementSourceGenerationSchema(element).parse(generation),
        result: adoptedResult,
        reuseProof: proof,
      }),
    );
  }
  return Object.freeze(adopted);
}

function migratedElementsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  target: AiAnalysisTarget | undefined,
): TrackedItemAiAnalysisMigrationElements {
  const saved = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId);
  const migrated: MutablePartial<TrackedItemAiAnalysisMigrationElements> = {};
  const generated = generatedElementsForNode(run, analysis.item.nodeId);
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const savedResult = saved[element];
    if (savedResult?.origin !== "migration") {
      continue;
    }
    const candidate = planning.candidates[element];
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    if (candidate.necessity === "not_required") {
      continue;
    }
    const application = reduction?.ai.elements[element]?.application;
    const consumerResult =
      consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
    const generatedResult = generated[element];
    const generatedWasConsumed =
      generatedResult != null &&
      consumerResult != null &&
      hashCanonicalJson(consumerResult) === hashCanonicalJson(generatedResult.result);
    const stateElement =
      element === "status" || element === "waitingOn" || element === "nextAction";
    const generatedWasAccepted =
      application === "applied" || (!stateElement && generatedWasConsumed);
    if (generatedWasAccepted) {
      continue;
    }
    const currentAdopted = preserveForcedUnexecutedElement
      ? currentSavedResultForElement(state, analysis, element)
      : currentAdoptedGenerationForElement(
          state,
          analysis,
          element,
          candidate.inputFingerprint,
          candidate.savedReuse,
        );
    if (currentAdopted != null) {
      continue;
    }
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    let result: AiAnalysisElementMigrationResult;
    if (forcedMigration != null) {
      result = createAiAnalysisMigrationElementResultSchema(element).parse(forcedMigration.result);
    } else {
      const savedReuse = planning.candidates[element].savedReuse;
      const migrationReuse =
        savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element]?.origin ===
        "migration"
          ? savedReuse
          : undefined;
      result = migrationReuse?.result ?? savedResult.result;
    }
    switch (element) {
      case "status":
        migrated.status = createAiAnalysisMigrationElementResultSchema("status").parse(result);
        break;
      case "waitingOn":
        migrated.waitingOn =
          createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
        break;
      case "nextAction":
        migrated.nextAction =
          createAiAnalysisMigrationElementResultSchema("nextAction").parse(result);
        break;
      case "relations":
        migrated.relations =
          createAiAnalysisMigrationElementResultSchema("relations").parse(result);
        break;
      case "progress":
        migrated.progress = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
        break;
      case "importance":
        migrated.importance =
          createAiAnalysisMigrationElementResultSchema("importance").parse(result);
        break;
      case "deadline":
        migrated.deadline = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
        break;
      case "notification":
        migrated.notification =
          createAiAnalysisMigrationElementResultSchema("notification").parse(result);
        break;
      case "selfCommitment":
        migrated.selfCommitment =
          createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(result);
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze(migrated);
}

function mixedAdoptedElementsForAnalysis(
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
  reuseRecords: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  let status: TrackedItemAiAnalysisMigrationAdoptedElement<"status"> | undefined;
  let waitingOn: TrackedItemAiAnalysisMigrationAdoptedElement<"waitingOn"> | undefined;
  let nextAction: TrackedItemAiAnalysisMigrationAdoptedElement<"nextAction"> | undefined;
  let relations: TrackedItemAiAnalysisMigrationAdoptedElement<"relations"> | undefined;
  let progress: TrackedItemAiAnalysisMigrationAdoptedElement<"progress"> | undefined;
  let importance: TrackedItemAiAnalysisMigrationAdoptedElement<"importance"> | undefined;
  let deadline: TrackedItemAiAnalysisMigrationAdoptedElement<"deadline"> | undefined;
  let notification: TrackedItemAiAnalysisMigrationAdoptedElement<"notification"> | undefined;
  let selfCommitment: TrackedItemAiAnalysisMigrationAdoptedElement<"selfCommitment"> | undefined;
  for (const element of AI_ANALYSIS_ELEMENTS) {
    switch (element) {
      case "status":
        if (current.status != null) {
          status = current.status;
        } else if (migration.status != null) {
          status = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("status").parse(
              reuseRecords.status?.result ?? migration.status,
            ),
            reuseProof: reuseRecords.status?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "waitingOn":
        if (current.waitingOn != null) {
          waitingOn = current.waitingOn;
        } else if (migration.waitingOn != null) {
          waitingOn = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
              reuseRecords.waitingOn?.result ?? migration.waitingOn,
            ),
            reuseProof: reuseRecords.waitingOn?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "nextAction":
        if (current.nextAction != null) {
          nextAction = current.nextAction;
        } else if (migration.nextAction != null) {
          nextAction = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
              reuseRecords.nextAction?.result ?? migration.nextAction,
            ),
            reuseProof: reuseRecords.nextAction?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "relations":
        if (current.relations != null) {
          relations = current.relations;
        } else if (migration.relations != null) {
          relations = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("relations").parse(
              reuseRecords.relations?.result ?? migration.relations,
            ),
            reuseProof: reuseRecords.relations?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "progress":
        if (current.progress != null) {
          progress = current.progress;
        } else if (migration.progress != null) {
          progress = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("progress").parse(
              reuseRecords.progress?.result ?? migration.progress,
            ),
            reuseProof: reuseRecords.progress?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "importance":
        if (current.importance != null) {
          importance = current.importance;
        } else if (migration.importance != null) {
          importance = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("importance").parse(
              reuseRecords.importance?.result ?? migration.importance,
            ),
            reuseProof: reuseRecords.importance?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "deadline":
        if (current.deadline != null) {
          deadline = current.deadline;
        } else if (migration.deadline != null) {
          deadline = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("deadline").parse(
              reuseRecords.deadline?.result ?? migration.deadline,
            ),
            reuseProof: reuseRecords.deadline?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "notification":
        if (current.notification != null) {
          notification = current.notification;
        } else if (migration.notification != null) {
          notification = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("notification").parse(
              reuseRecords.notification?.result ?? migration.notification,
            ),
            reuseProof: reuseRecords.notification?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "selfCommitment":
        if (current.selfCommitment != null) {
          selfCommitment = current.selfCommitment;
        } else if (migration.selfCommitment != null) {
          selfCommitment = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(
              reuseRecords.selfCommitment?.result ?? migration.selfCommitment,
            ),
            reuseProof: reuseRecords.selfCommitment?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze({
    ...(status == null ? {} : { status }),
    ...(waitingOn == null ? {} : { waitingOn }),
    ...(nextAction == null ? {} : { nextAction }),
    ...(relations == null ? {} : { relations }),
    ...(progress == null ? {} : { progress }),
    ...(importance == null ? {} : { importance }),
    ...(deadline == null ? {} : { deadline }),
    ...(notification == null ? {} : { notification }),
    ...(selfCommitment == null ? {} : { selfCommitment }),
  });
}

function adoptedRecordsForPlanning(
  planning: AnalysisElementPlanning,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const record = planning.candidates[element].savedReuse;
    if (record != null) {
      records[element] = record;
    }
  }
  return Object.freeze(records);
}

function preservedElementsForReduction(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
): CodexPreservedElements {
  let status: AiAnalysisElementMigrationResult<"status"> | undefined;
  let waitingOn: AiAnalysisElementMigrationResult<"waitingOn"> | undefined;
  let nextAction: AiAnalysisElementMigrationResult<"nextAction"> | undefined;
  let relations: AiAnalysisElementMigrationResult<"relations"> | undefined;
  let progress: AiAnalysisElementMigrationResult<"progress"> | undefined;
  let importance: AiAnalysisElementMigrationResult<"importance"> | undefined;
  let deadline: AiAnalysisElementMigrationResult<"deadline"> | undefined;
  let notification: AiAnalysisElementMigrationResult<"notification"> | undefined;
  let selfCommitment: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
  const previousItem = previousTrackedItem(state, analysis.item.nodeId);

  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = planning.candidates[element];
    if (candidate.necessity !== "required") {
      continue;
    }
    const retained =
      candidate.savedReuse?.result ??
      (previousItem == null ? undefined : adoptedResultForRetainedItem(previousItem, element));
    if (retained == null) {
      continue;
    }
    switch (element) {
      case "status":
        status = createAiAnalysisMigrationElementResultSchema("status").parse(retained);
        break;
      case "waitingOn":
        waitingOn = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(retained);
        break;
      case "nextAction":
        nextAction = createAiAnalysisMigrationElementResultSchema("nextAction").parse(retained);
        break;
      case "relations":
        relations = createAiAnalysisMigrationElementResultSchema("relations").parse(retained);
        break;
      case "progress":
        progress = createAiAnalysisMigrationElementResultSchema("progress").parse(retained);
        break;
      case "importance":
        importance = createAiAnalysisMigrationElementResultSchema("importance").parse(retained);
        break;
      case "deadline":
        deadline = createAiAnalysisMigrationElementResultSchema("deadline").parse(retained);
        break;
      case "notification":
        notification = createAiAnalysisMigrationElementResultSchema("notification").parse(retained);
        break;
      case "selfCommitment":
        selfCommitment =
          createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(retained);
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze({
    ...(status == null ? {} : { status }),
    ...(waitingOn == null ? {} : { waitingOn }),
    ...(nextAction == null ? {} : { nextAction }),
    ...(relations == null ? {} : { relations }),
    ...(progress == null ? {} : { progress }),
    ...(importance == null ? {} : { importance }),
    ...(deadline == null ? {} : { deadline }),
    ...(notification == null ? {} : { notification }),
    ...(selfCommitment == null ? {} : { selfCommitment }),
  });
}

function preservedElementsForAnalysisReduction(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
  target: AiAnalysisTarget | undefined,
): CodexPreservedElements {
  const planning = codexAnalysis.elementPlanningByNodeId.get(analysis.item.nodeId);
  assertNonNullable(planning, `AI判定要素の計画がありません。対象: ${analysis.item.nodeId}`);
  const preservedElements =
    target == null
      ? preservedElementsForReduction(state, analysis, planning)
      : preservedElementsForForcedReduction(state, analysis, planning, target);
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  return preservedElementsWithCompatibleRelations(preservedElements, input);
}

function elementGenerationsByNodeId(
  state: RuntimeState,
  analyses: readonly DeterministicItemAnalysis[],
  planningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>,
  run: AiAnalysisRunResult | undefined,
  target: AiAnalysisTarget | undefined,
): ReadonlyMap<GitHubNodeId, AiAnalysisElementSourceGenerationMap> {
  const generations = new Map<GitHubNodeId, AiAnalysisElementSourceGenerationMap>();
  for (const analysis of analyses) {
    generations.set(
      analysis.item.nodeId,
      generationsForAnalysis(
        state,
        analysis,
        planningByNodeId.get(analysis.item.nodeId),
        run,
        target,
      ),
    );
  }
  return generations;
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
      maxSemanticGenerations: config.ai.execution.maxSemanticGenerations,
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
  semanticGenerationObserver: CodexSemanticGenerationObserver | undefined,
): CodexAdapterDependencies {
  return Object.freeze({
    environment: credentials.environment,
    processRunner: adapters.codexProcessRunner,
    runtime: {
      sleep: adapters.sleep,
      random: adapters.random,
    },
    ...(diagnostics == null ? {} : { diagnostics }),
    ...(semanticGenerationObserver == null ? {} : { semanticGenerationObserver }),
  });
}

type CodexSemanticGenerationCounts = Readonly<{
  generationCount: number;
  correctionStartedCount: number;
  correctionSucceededCount: number;
  correctionExhaustedCount: number;
  processAttemptCount: number;
}>;

type CodexSemanticGenerationCounter = Readonly<{
  observer: CodexSemanticGenerationObserver;
  read: () => CodexSemanticGenerationCounts;
}>;

function assertSemanticGenerationNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) {
    throw new RangeError("Codex semantic generationは1から3の整数にしてください");
  }
}

function createCodexSemanticGenerationCounter(): CodexSemanticGenerationCounter {
  const counts = {
    generationCount: 0,
    correctionStartedCount: 0,
    correctionSucceededCount: 0,
    correctionExhaustedCount: 0,
    processAttemptCount: 0,
  };
  const observer = Object.freeze({
    onGenerationStarted: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.generationCount += 1;
    },
    onCorrectionStarted: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.correctionStartedCount += 1;
    },
    onCorrectionSucceeded: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.correctionSucceededCount += 1;
    },
    onCorrectionExhausted: (generation: number): void => {
      assertSemanticGenerationNumber(generation);
      counts.correctionExhaustedCount += 1;
    },
    onProcessAttemptStarted: (generation: number, attempt: number): void => {
      assertSemanticGenerationNumber(generation);
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new RangeError("Codex process attemptは正の整数にしてください");
      }
      counts.processAttemptCount += 1;
    },
  }) satisfies CodexSemanticGenerationObserver;
  return Object.freeze({
    observer,
    read: (): CodexSemanticGenerationCounts => Object.freeze({ ...counts }),
  });
}

function codexSemanticGenerationDiagnostic(counts: CodexSemanticGenerationCounts): string {
  return [
    "codex_semantic_generations",
    `generationCount=${counts.generationCount.toString()}`,
    `correctionStartedCount=${counts.correctionStartedCount.toString()}`,
    `correctionSucceededCount=${counts.correctionSucceededCount.toString()}`,
    `correctionExhaustedCount=${counts.correctionExhaustedCount.toString()}`,
    `processAttemptCount=${counts.processAttemptCount.toString()}`,
  ].join(" ");
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
  const target = forcedAiAnalysisTarget(configuration);
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: `${invocation.runId}:codex`,
        });
  for (const impact of prepared.analysisImpactDecisions) {
    await recordCodexDiagnostic(
      diagnostics == null
        ? undefined
        : Object.freeze({
            ...diagnostics,
            candidateId: impact.candidateId,
          }),
      "codex.analysis.impact",
      {
        phase: "analysis_impact",
        element: impact.element,
        role: impact.role,
        sourceVersion: Object.freeze({
          revision: impact.decision.sourceVersion.revision,
          inputProjectionVersion: impact.decision.sourceVersion.inputProjectionVersion,
        }),
        targetVersion: Object.freeze({
          revision: impact.decision.targetVersion.revision,
          inputProjectionVersion: impact.decision.targetVersion.inputProjectionVersion,
        }),
        impact: impact.decision.impact,
        compatibilityPath: Object.freeze([...impact.decision.compatibilityPath]),
        ...(impact.decision.reason == null ? {} : { reason: impact.decision.reason }),
      },
    );
  }
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
    if (target != null) {
      throw new TypeError("forced sandbox実行にはAIを有効にしてください");
    }
    const fallback = prepared.failures.length > 0;
    await recordCodexDiagnostic(diagnostics, "codex.analysis.summary", {
      phase: "summary",
      candidateItemCount: prepared.candidates.length,
      aiCallCount: 0,
      deferredItemCount: 0,
      inputValidationFailureCount: prepared.inputValidationFailures.length,
    });
    return Object.freeze({
      stage: Object.freeze({
        run: undefined,
        inputByNodeId: prepared.inputByNodeId,
        elementPlanningByNodeId: prepared.elementPlanningByNodeId,
        elementGenerationsByNodeId: elementGenerationsByNodeId(
          state,
          deterministicAnalysis.items,
          prepared.elementPlanningByNodeId,
          undefined,
          target,
        ),
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
  const semanticGenerationCounter = createCodexSemanticGenerationCounter();
  const codexDependencies = createCodexAdapterDependencies(
    adapters,
    codexCredentials,
    diagnostics,
    semanticGenerationCounter.observer,
  );
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
      initialUsage: createEmptyAiBudgetUsage(),
      maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
      ...(target == null ? {} : { target }),
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
    skipped:
      target == null
        ? executedRun.skipped
        : Object.freeze([
            ...executedRun.skipped,
            ...prepared.candidates
              .filter((candidate) => candidate.id !== target.nodeId)
              .map((candidate) =>
                Object.freeze({
                  candidateId: candidate.id,
                  reason: "not_required" as const,
                }),
              ),
          ]),
  }) satisfies AiAnalysisRunResult;
  await recordCodexDiagnostic(diagnostics, "codex.analysis.summary", {
    phase: "summary",
    candidateItemCount: prepared.candidates.length,
    aiCallCount: run.usage.calls,
    deferredItemCount: run.deferred.length,
    inputValidationFailureCount: prepared.inputValidationFailures.length,
  });
  const semanticGenerationCounts = semanticGenerationCounter.read();
  const semanticGenerationPublicDiagnostic =
    codexSemanticGenerationDiagnostic(semanticGenerationCounts);
  const fallback = run.failures.length > 0 || run.deferred.length > 0;
  return Object.freeze({
    stage: Object.freeze({
      run,
      inputByNodeId: prepared.inputByNodeId,
      elementPlanningByNodeId: prepared.elementPlanningByNodeId,
      elementGenerationsByNodeId: elementGenerationsByNodeId(
        state,
        deterministicAnalysis.items,
        prepared.elementPlanningByNodeId,
        run,
        target,
      ),
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
      semanticGenerationPublicDiagnostic,
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

function currentAdoptedImportanceAssessment(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  resolvedResult: AiAnalysisElementMigrationResult | undefined,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
): NaturalLanguageImportanceAssessmentState | undefined {
  const forcedUnexecutedElement = isForcedUnexecutedElement(analysis, "importance", target);
  if (forcedUnexecutedElement && planning.candidates.importance.necessity === "not_required") {
    return undefined;
  }
  let adopted: AiAnalysisElementMigrationResult | undefined;
  if (forcedUnexecutedElement) {
    adopted = currentSavedResultForElement(state, analysis, "importance");
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      "importance",
      target,
    );
    if (adopted == null && forcedMigration != null) {
      adopted = createAiAnalysisMigrationElementResultSchema("importance").parse(
        forcedMigration.result,
      );
    }
    adopted ??= resolvedResult;
  } else {
    adopted = resolvedResult;
    adopted ??= currentAdoptedResultForElement(state, analysis, "importance");
  }
  if (adopted == null) {
    const migrated = migrationAdoptedResultForElement(state, analysis, "importance");
    if (migrated == null) {
      return undefined;
    }
    const parsed = createAiAnalysisElementResultSchema("importance").parse(migrated);
    return Object.freeze({
      status: "available",
      value: Object.freeze({
        significantFeature: parsed.value.significantFeature,
        futureRisk: parsed.value.futureRisk,
        rationale: parsed.value.rationale,
      }),
    });
  }
  const parsed = createAiAnalysisElementResultSchema("importance").parse(adopted);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: parsed.value.significantFeature,
      futureRisk: parsed.value.futureRisk,
      rationale: parsed.value.rationale,
    }),
  });
}

function currentAdoptedDeadlineAssessment(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  resolvedResult: AiAnalysisElementMigrationResult | undefined,
  planning: AnalysisElementPlanning,
  target: AiAnalysisTarget | undefined,
): NaturalLanguageDeadlineAssessmentState | undefined {
  const forcedUnexecutedElement = isForcedUnexecutedElement(analysis, "deadline", target);
  if (forcedUnexecutedElement && planning.candidates.deadline.necessity === "not_required") {
    return undefined;
  }
  let adopted: AiAnalysisElementMigrationResult | undefined;
  if (forcedUnexecutedElement) {
    adopted = currentSavedResultForElement(state, analysis, "deadline");
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      "deadline",
      target,
    );
    if (adopted == null && forcedMigration != null) {
      adopted = createAiAnalysisMigrationElementResultSchema("deadline").parse(
        forcedMigration.result,
      );
    }
    adopted ??= resolvedResult;
  } else {
    adopted = resolvedResult;
    adopted ??= currentAdoptedResultForElement(state, analysis, "deadline");
  }
  if (adopted == null) {
    const migrated = migrationAdoptedResultForElement(state, analysis, "deadline");
    if (migrated == null) {
      return undefined;
    }
    const parsed = createAiAnalysisElementResultSchema("deadline").parse(migrated);
    return Object.freeze({
      status: "available",
      value: Object.freeze({
        date: parsed.value.date,
        rationale: parsed.value.rationale,
      }),
    });
  }
  const parsed = createAiAnalysisElementResultSchema("deadline").parse(adopted);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      date: parsed.value.date,
      rationale: parsed.value.rationale,
    }),
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
  adopted: NaturalLanguageImportanceAssessmentState | undefined,
): NaturalLanguageImportanceAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return adopted ?? unavailableImportanceAssessment();
}

function resolveDeadlineAssessment(
  current: NaturalLanguageDeadlineAssessmentState | undefined,
  adopted: NaturalLanguageDeadlineAssessmentState | undefined,
): NaturalLanguageDeadlineAssessmentState {
  if (current?.status === "available") {
    return current;
  }
  return adopted ?? unavailableDeadlineAssessment();
}

function reductionForAnalysis(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): CodexAnalysisReduction | undefined {
  const run = codexAnalysis.run;
  if (run == null) {
    return undefined;
  }
  const runIndex = aiAnalysisRunIndex(run);
  const target = forcedAiAnalysisTarget(configuration);
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  const result = runIndex.resultByNodeId.get(analysis.item.nodeId);
  if (result != null) {
    assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
    const output = codexOutputForAnalysis(analysis, codexAnalysis);
    assertNonNullable(output, `Codex出力がありません。対象: ${analysis.item.nodeId}`);
    return reduceCodexAnalysis(
      input,
      deterministicCodexDecision(analysis.decision),
      {
        status: "validated",
        output,
      },
      configuration.config.ai.confidence,
      preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
    );
  }
  const failure = runIndex.failureByNodeId.get(analysis.item.nodeId);
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
      preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
    );
  }
  const deferred = runIndex.deferredByNodeId.get(analysis.item.nodeId);
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
      preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
    );
  }
  const skipped = runIndex.skippedByNodeId.get(analysis.item.nodeId);
  const forcedUnexecutedItem = target != null && target.nodeId !== analysis.item.nodeId;
  if (skipped?.reason !== "up_to_date" && !forcedUnexecutedItem) {
    return undefined;
  }
  assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
  if (!forcedUnexecutedItem && input.selectedElements.length !== 0) {
    throw new TypeError(
      `up_to_date項目のCodex入力に選択要素があります。対象: ${analysis.item.nodeId}`,
    );
  }
  const preservedElements = preservedElementsForAnalysisReduction(
    state,
    analysis,
    codexAnalysis,
    target,
  );
  if (Object.keys(preservedElements).length === 0) {
    return undefined;
  }
  const reductionInput = forcedUnexecutedItem
    ? createCodexAnalysisInput({
        ...input,
        selectedElements: [],
        lockedElements: {},
      })
    : input;
  const output = validateCodexAnalysisOutput(
    {
      schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
      item: {
        nodeId: reductionInput.item.nodeId,
        url: reductionInput.item.url,
      },
    },
    reductionInput,
  );
  return reduceCodexAnalysis(
    reductionInput,
    deterministicCodexDecision(analysis.decision),
    {
      status: "validated",
      output,
    },
    configuration.config.ai.confidence,
    preservedElements,
  );
}

function codexOutputForAnalysis(
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): SchemaValidCodexElementOutput | undefined {
  const result = aiAnalysisRunIndex(codexAnalysis.run).resultByNodeId.get(analysis.item.nodeId);
  if (result == null) {
    return undefined;
  }
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  assertNonNullable(input, `Codex入力がありません。対象: ${analysis.item.nodeId}`);
  const output: Record<string, unknown> = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  for (const element of result.elements) {
    output[element.element] = element.generation.result;
  }
  return validateCodexElementOutputSchema(output, input.selectedElements);
}

function codexElementResult(
  output: ConsumerCodexElementOutput,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  switch (element) {
    case "status":
      return output.status;
    case "waitingOn":
      return output.waitingOn;
    case "nextAction":
      return output.nextAction;
    case "relations":
      return output.relations;
    case "progress":
      return output.progress;
    case "importance":
      return output.importance;
    case "deadline":
      return output.deadline;
    case "notification":
      return output.notification;
    case "selfCommitment":
      return output.selfCommitment;
    default:
      throw new UnreachableError(element);
  }
}

function setConsumerCodexElementResult(
  output: MutableConsumerCodexElementOutput,
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult,
): void {
  switch (element) {
    case "status":
      output.status = createAiAnalysisMigrationElementResultSchema("status").parse(result);
      break;
    case "waitingOn":
      output.waitingOn = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
      break;
    case "nextAction":
      output.nextAction = createAiAnalysisMigrationElementResultSchema("nextAction").parse(result);
      break;
    case "relations":
      output.relations = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
      break;
    case "progress":
      output.progress = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
      break;
    case "importance":
      output.importance = createAiAnalysisMigrationElementResultSchema("importance").parse(result);
      break;
    case "deadline":
      output.deadline = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
      break;
    case "notification":
      output.notification =
        createAiAnalysisMigrationElementResultSchema("notification").parse(result);
      break;
    case "selfCommitment":
      output.selfCommitment =
        createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(result);
      break;
    default:
      throw new UnreachableError(element);
  }
}

function codexOutputForConsumers(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
): ConsumerCodexElementOutput | undefined {
  const rawOutput = codexOutputForAnalysis(analysis, codexAnalysis);
  const input = codexAnalysis.inputByNodeId.get(analysis.item.nodeId);
  const planning = codexAnalysis.elementPlanningByNodeId.get(analysis.item.nodeId);
  if (input == null || planning == null) {
    return rawOutput;
  }
  const rawResults = new Map<AiAnalysisElement, AiAnalysisElementMigrationResult>();
  if (rawOutput != null) {
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const result = codexElementResult(rawOutput, element);
      if (result != null) {
        rawResults.set(element, result);
      }
    }
  }
  const deterministicStatePriority =
    (analysis.decision.determination === "determined" &&
      planning.necessities.status === "not_required" &&
      planning.necessities.waitingOn === "not_required" &&
      planning.necessities.nextAction === "not_required") ||
    listNativeRelationConstraints(input).some(
      (constraint) => constraint.verdict === "current_is_blocked_by_target",
    );
  const stateElementNames: readonly AiAnalysisElement[] = ["status", "waitingOn", "nextAction"];
  const selectedStateElements = stateElementNames.filter((element) =>
    input.selectedElements.includes(element),
  );
  const stateSelectionIsIncomplete =
    selectedStateElements.length >= 2 &&
    selectedStateElements.some((element) => {
      const raw = rawResults.get(element);
      return (
        raw == null ||
        effectiveElementConfidence(element, raw) < configuration.config.ai.confidence.medium
      );
    });
  const output: MutableConsumerCodexElementOutput = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  const target = forcedAiAnalysisTarget(configuration);
  const outputElements = new Set<AiAnalysisElement>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const candidate = planning.candidates[element];
    const raw = rawResults.get(element);
    const stateElement = isStateAnalysisElement(element);
    if (codexAnalysis.run == null && stateElement) {
      continue;
    }
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    let adopted: AiAnalysisElementMigrationResult | undefined;
    if (candidate.necessity === "required") {
      if (preserveForcedUnexecutedElement) {
        adopted = currentSavedResultForElement(state, analysis, element);
        if (adopted == null && forcedMigration == null) {
          adopted = candidate.savedReuse?.result;
        }
      } else {
        adopted = candidate.savedReuse?.result;
        adopted ??= currentAdoptedResultForElement(state, analysis, element);
      }
    }
    let migrated: AiAnalysisElementMigrationResult | undefined;
    if (candidate.necessity === "required") {
      if (forcedMigration != null) {
        migrated = createAiAnalysisMigrationElementResultSchema(element).parse(
          forcedMigration.result,
        );
      } else {
        migrated =
          candidate.savedReuse?.result ??
          migrationAdoptedResultForElement(state, analysis, element);
      }
    }
    const result =
      (raw != null &&
      effectiveElementConfidence(element, raw) >= configuration.config.ai.confidence.medium &&
      !(deterministicStatePriority && stateElement) &&
      !(stateSelectionIsIncomplete && stateElement)
        ? raw
        : (adopted ?? migrated)) ?? undefined;
    if (result != null) {
      setConsumerCodexElementResult(output, element, result);
      outputElements.add(element);
    }
  }
  const status = output.status?.value ?? analysis.decision.status;
  const waitingOn = output.waitingOn?.value ?? analysis.decision.waitingOn;
  const stateValuesAreConsistent = isTerminalStatus(status)
    ? waitingOn.length === 0
    : waitingOn.length !== 0;
  if (!stateValuesAreConsistent) {
    delete output.status;
    delete output.waitingOn;
    delete output.nextAction;
    for (const element of stateElementNames) {
      outputElements.delete(element);
    }
  }
  if (outputElements.size === 0) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: output.schemaVersion,
    item: output.item,
    ...(output.status == null ? {} : { status: output.status }),
    ...(output.waitingOn == null ? {} : { waitingOn: output.waitingOn }),
    ...(output.nextAction == null ? {} : { nextAction: output.nextAction }),
    ...(output.relations == null ? {} : { relations: output.relations }),
    ...(output.progress == null ? {} : { progress: output.progress }),
    ...(output.importance == null ? {} : { importance: output.importance }),
    ...(output.deadline == null ? {} : { deadline: output.deadline }),
    ...(output.notification == null ? {} : { notification: output.notification }),
    ...(output.selfCommitment == null ? {} : { selfCommitment: output.selfCommitment }),
  });
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

function outputSourceIds(
  sourceIds: readonly string[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  return nonEmptySourceIds(
    sourceIds.map((sourceId) => {
      const parts = parseSourceId(sourceId);
      return buildSourceId(parts.kind, parts.originalId);
    }),
    context,
  );
}

function createEffectiveAssigneeAssessment(
  configuration: RuntimeConfiguration,
  evaluatedAt: UtcIsoDateTime,
  analysis: DeterministicItemAnalysis,
  output: ConsumerCodexElementOutput | undefined,
): IssueEffectiveAssigneeAssessment {
  if (
    analysis.item.type !== "issue" ||
    analysis.item.state !== "open" ||
    analysis.item.assignees.length !== 0 ||
    analysis.effectiveAssigneeCandidates.length === 0 ||
    output?.status == null ||
    output.waitingOn == null ||
    output.status.value !== "waiting_for_work" ||
    output.waitingOn.value.length === 0 ||
    output.status.confidence < configuration.config.ai.confidence.high ||
    output.waitingOn.confidence < configuration.config.ai.confidence.high
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
  for (const waitingOn of output.waitingOn.value) {
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
    const sourceIds = outputSourceIds(
      waitingOn.sourceIds,
      `実質担当判定 ${waitingOn.candidateId}のsource ID`,
    );
    if (!sourceIdSetsMatch(sourceIds, candidate.sourceIds)) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    targets.push(
      Object.freeze({
        kind: "user",
        candidateId: waitingOn.candidateId,
        sourceIds,
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
  const confidence = Math.min(
    output.status.confidence,
    output.waitingOn.confidence,
    ...targets.map((target) => target.confidence),
  );
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
  output: ConsumerCodexElementOutput | undefined,
): IssueExplicitRequestAssessment {
  const candidates = createIssueRequestCandidates(item, detail);
  const waitingOnResult = output?.waitingOn;
  if (waitingOnResult == null || candidates.length === 0) {
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
  const targets: IssueExplicitRequestTarget[] = waitingOnResult.value.flatMap((waitingOn) => {
    const sourceIds = outputSourceIds(
      waitingOn.sourceIds,
      `明示依頼 ${waitingOn.candidateId}のsource ID`,
    );
    if (waitingOn.kind !== "user" && waitingOn.kind !== "team") {
      return [];
    }
    const mentioned = mentionedByKey.get(
      `${waitingOn.kind}:${waitingOn.candidateId.toLowerCase()}`,
    );
    if (
      mentioned == null ||
      !sourceIds.some((sourceId) => mentioned.sourceIds.includes(sourceId))
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
        sourceIds,
        confidence: Math.min(waitingOnResult.confidence, waitingOn.confidence),
      }),
    ];
  });
  if (targets.length === 0) {
    return Object.freeze({
      status: "assessed",
      candidateSourceIds,
      verdict: "no_unanswered_request",
      confidence: waitingOnResult.confidence,
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
    confidence: Math.min(
      waitingOnResult.confidence,
      ...latestTargets.map((target) => target.confidence),
    ),
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
  output: ConsumerCodexElementOutput | undefined,
): PullRequestCheckFailureAssessment {
  const sourceIds = checkFailureSourceIds(detail);
  if (sourceIds == null || output?.status == null || output.waitingOn == null) {
    return Object.freeze({
      cause: "not_assessed",
    });
  }
  const effectiveConfidence = Math.min(
    output.status.confidence,
    output.waitingOn.confidence,
    ...output.waitingOn.value.map((waitingOn) => waitingOn.confidence),
  );
  const authorAction =
    output.status.value === "waiting_for_revision" ||
    output.waitingOn.value.some((waitingOn) => waitingOn.role === "author");
  if (authorAction) {
    return Object.freeze({
      cause: "pull_request_change",
      confidence: effectiveConfidence,
      sourceIds,
    });
  }
  const infrastructureOrFlaky =
    output.status.value === "waiting_for_automation" ||
    output.status.value === "waiting_for_decision" ||
    output.status.value === "unknown" ||
    output.waitingOn.value.some(
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
  output: ConsumerCodexElementOutput | undefined,
): readonly NaturalLanguageProgressAssessment[] {
  const progressResult = output?.progress;
  if (progressResult == null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    analysis.item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) =>
        Object.freeze({
          candidateSourceId: event.sourceId,
          verdict:
            progressResult.value.latestMeaningfulSourceId === event.sourceId
              ? "meaningful_progress"
              : "not_meaningful_progress",
          confidence: Math.min(progressResult.confidence, progressResult.value.confidence),
          sourceIds: Object.freeze([event.sourceId] satisfies [SourceId]),
        }),
      ),
  );
}

type GraphBlockerIndex = Readonly<{
  blockingEdgesByTargetNodeId: ReadonlyMap<GraphNodeId, readonly ReconciledGraphEdge[]>;
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItem["state"]>;
}>;

function createGraphBlockerIndex(graph: GraphResult): GraphBlockerIndex {
  const mutableBlockingEdgesByTargetNodeId = new Map<GraphNodeId, ReconciledGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!edge.active || edge.type !== "blocks") {
      continue;
    }
    const edges = mutableBlockingEdgesByTargetNodeId.get(edge.toNodeId) ?? [];
    edges.push(edge);
    mutableBlockingEdgesByTargetNodeId.set(edge.toNodeId, edges);
  }
  const blockingEdgesByTargetNodeId = new Map<GraphNodeId, readonly ReconciledGraphEdge[]>(
    [...mutableBlockingEdgesByTargetNodeId].map(([nodeId, edges]) => [
      nodeId,
      Object.freeze(edges),
    ]),
  );
  return Object.freeze({
    blockingEdgesByTargetNodeId,
    stateByNodeId: graph.effectiveStateByNodeId,
  });
}

function graphBlockers(
  index: GraphBlockerIndex,
  item: FreshObservedGitHubItem,
): readonly IssueBlocker[] {
  const blockersByCandidateId = new Map<GraphNodeId, IssueBlocker>();
  for (const edge of index.blockingEdgesByTargetNodeId.get(item.nodeId) ?? []) {
    const edgeSourceIds = nonEmptySourceIds(
      edge.evidence.map((evidence) => evidence.sourceId),
      `blocker edge ${edge.id}`,
    );
    const edgeBecameBlockingAt = edge.provenance === "native" ? item.createdAt : edge.firstSeenAt;
    const existing = blockersByCandidateId.get(edge.fromNodeId);
    if (existing == null) {
      const blockerState = index.stateByNodeId.get(edge.fromNodeId);
      assertNonNullable(blockerState, `blocker ${edge.fromNodeId}の状態がありません`);
      blockersByCandidateId.set(
        edge.fromNodeId,
        Object.freeze({
          candidateId: edge.fromNodeId,
          state: blockerState,
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
  inventory: RepositoryInventory,
  analysis: DeterministicItemAnalysis,
  output: ConsumerCodexElementOutput | undefined,
  graphBlockerIndex: GraphBlockerIndex | undefined,
): DeterministicItemAnalysis {
  const repository = findRepository(inventory, analysis.item.repositoryId);
  const maintainers = resolveRepositoryMaintainers(
    configuration.config.maintainers,
    repositoryFullName(repository),
  );
  const blockers =
    graphBlockerIndex == null
      ? createNativeBlockers(analysis.item, analysis.relationCandidates)
      : graphBlockers(graphBlockerIndex, analysis.item);
  if (analysis.item.type === "issue" && analysis.detail.type === "issue") {
    const explicitRequestAssessmentValue = explicitRequestAssessment(
      analysis.item,
      analysis.detail,
      output,
    );
    const effectiveAssigneeAssessmentValue = createEffectiveAssigneeAssessment(
      configuration,
      evaluatedAt,
      analysis,
      output,
    );
    return Object.freeze({
      ...analysis,
      decision: determineIssueState({
        issue: analysis.item,
        blockers,
        explicitRequestCandidates: createIssueRequestCandidates(analysis.item, analysis.detail),
        explicitRequestAssessment: explicitRequestAssessmentValue,
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(
          (candidate) => candidate.candidate,
        ),
        effectiveAssigneeAssessment: effectiveAssigneeAssessmentValue,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
      localResponsibilityDecision: determineIssueLocalResponsibility({
        issue: analysis.item,
        explicitRequestCandidates: createIssueRequestCandidates(analysis.item, analysis.detail),
        explicitRequestAssessment: explicitRequestAssessmentValue,
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(
          (candidate) => candidate.candidate,
        ),
        effectiveAssigneeAssessment: effectiveAssigneeAssessmentValue,
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
    const checkFailureAssessmentValue = checkFailureAssessment(analysis.detail, output);
    const labelEffects = resolveLabelEffects(repositoryFullName(repository), analysis.item.labels);
    return Object.freeze({
      ...analysis,
      decision: determinePullRequestState({
        pullRequest: analysis.item,
        blockers,
        checkFailureAssessment: checkFailureAssessmentValue,
        labelEffects,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
      localResponsibilityDecision: determinePullRequestLocalResponsibility({
        pullRequest: analysis.item,
        checkFailureAssessment: checkFailureAssessmentValue,
        labelEffects,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
    });
  }
  throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${analysis.item.nodeId}`);
}

type EnumeratedTerminal = Readonly<{
  state: "closed" | "merged";
  occurredAt: UtcIsoDateTime;
}>;

function enumeratedTerminal(
  item: EnumeratedGitHubItem | undefined,
): EnumeratedTerminal | undefined {
  if (item == null) {
    return undefined;
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return Object.freeze({
      state: "merged",
      occurredAt: item.mergedAt,
    });
  }
  if (item.state === "closed") {
    return Object.freeze({
      state: "closed",
      occurredAt: item.closedAt,
    });
  }
  return undefined;
}

function enumeratedTerminalAt(item: EnumeratedGitHubItem | undefined): UtcIsoDateTime | undefined {
  const terminal = enumeratedTerminal(item);
  return terminal == null ? undefined : terminal.occurredAt;
}

type ActiveRelation = Relation & Readonly<{ active: true }>;

type PreviousBlockerEdgesByTargetNodeId = ReadonlyMap<
  GraphNodeId,
  ReadonlyMap<GraphNodeId, readonly ActiveRelation[]>
>;

function previousBlockerEdgesByTargetNodeId(
  state: RuntimeState,
): PreviousBlockerEdgesByTargetNodeId {
  const snapshot = previousSnapshot(state);
  assertNonNullable(snapshot, "newly unblocked項目の前回snapshotがありません");
  const previousStateByNodeId = snapshotEffectiveGraphStateByNodeId(snapshot);
  const edgesByTargetNodeId = new Map<GraphNodeId, Map<GraphNodeId, ActiveRelation[]>>();
  for (const edge of snapshot.relations) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      previousStateByNodeId.get(edge.fromNodeId) !== "open"
    ) {
      continue;
    }
    const edgesByBlockerNodeId = edgesByTargetNodeId.get(edge.toNodeId);
    if (edgesByBlockerNodeId == null) {
      edgesByTargetNodeId.set(edge.toNodeId, new Map([[edge.fromNodeId, [edge]]]));
      continue;
    }
    const edges = edgesByBlockerNodeId.get(edge.fromNodeId);
    if (edges == null) {
      edgesByBlockerNodeId.set(edge.fromNodeId, [edge]);
      continue;
    }
    edges.push(edge);
  }
  return edgesByTargetNodeId;
}

type RelationProgressEvent = Extract<NormalizedEvent, { kind: "relation" }>;

type DependencyResolutionIndexes = Readonly<{
  previousBlockerEdgesByTargetNodeId: PreviousBlockerEdgesByTargetNodeId;
  previousObservedAtByNodeId: ReadonlyMap<GitHubNodeId, UtcIsoDateTime>;
  previousEffectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>;
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>;
  currentNativeStateObservationsByNodeId: ReadonlyMap<
    GraphNodeId,
    SnapshotGraphNodeStateObservation
  >;
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>;
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  relationRemovalEventsByKey: ReadonlyMap<string, RelationProgressEvent>;
  editedRelationSourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  candidatesById: ReadonlyMap<string, RelationCandidate>;
  relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
  assessmentsById: ReadonlyMap<string, RelationCandidateAssessment>;
  currentEdgesById: ReadonlyMap<string, ReconciledGraphEdge>;
}>;

function relationProgressKey(
  relationType: Relation["type"],
  provenance: Relation["provenance"],
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
): string {
  return JSON.stringify([relationType, provenance, fromNodeId, toNodeId]);
}

function relationMeaningKey(
  relationType: Relation["type"],
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
): string {
  return JSON.stringify([relationType, fromNodeId, toNodeId]);
}

function relationProgressEventKey(event: RelationProgressEvent): string {
  if (event.target.type !== "node") {
    throw new TypeError(
      `relation progress eventのtargetがnodeではありません。対象: ${event.sourceId}`,
    );
  }
  const fromNodeId = event.direction === "from_item" ? event.itemNodeId : event.target.nodeId;
  const toNodeId = event.direction === "from_item" ? event.target.nodeId : event.itemNodeId;
  return relationProgressKey(event.relationType, event.provenance, fromNodeId, toNodeId);
}

type DependencyResolutionStaticIndexes = Omit<DependencyResolutionIndexes, "assessmentsById">;

function createDependencyResolutionStaticIndexes(
  state: RuntimeState,
  collection: CollectedItems,
  graph: GraphResult,
): DependencyResolutionStaticIndexes {
  const previousSnapshotValue = previousSnapshot(state);
  assertNonNullable(previousSnapshotValue, "newly unblocked項目の前回snapshotがありません");
  const previousObservedAtByNodeId = new Map<GitHubNodeId, UtcIsoDateTime>(
    previousSnapshotValue.items.map((item): [GitHubNodeId, UtcIsoDateTime] => [
      item.nodeId,
      item.observedAt,
    ]),
  );
  const previousEffectiveStateByNodeId = snapshotEffectiveGraphStateByNodeId(previousSnapshotValue);
  const enumeratedItemsByNodeId = new Map<GraphNodeId, EnumeratedGitHubItem>();
  for (const item of collection.enumeratedItems) {
    if (enumeratedItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`enumerated item ${item.nodeId}が重複しています`);
    }
    enumeratedItemsByNodeId.set(item.nodeId, item);
  }
  const observedItemsByNodeId = new Map<GraphNodeId, FreshObservedGitHubItem>();
  for (const item of collection.observedItems) {
    if (observedItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`observed item ${item.nodeId}が重複しています`);
    }
    observedItemsByNodeId.set(item.nodeId, item);
  }
  const currentNativeStateObservationsByNodeId = new Map<
    GraphNodeId,
    SnapshotGraphNodeStateObservation
  >();
  for (const observation of graph.currentNativeStateObservations) {
    if (currentNativeStateObservationsByNodeId.has(observation.nodeId)) {
      throw new TypeError(`current native state observation ${observation.nodeId}が重複しています`);
    }
    currentNativeStateObservationsByNodeId.set(observation.nodeId, observation);
  }
  const relationEventsByKey = new Map<string, RelationProgressEvent[]>();
  const relationRemovalEventsByKey = new Map<string, RelationProgressEvent>();
  for (const item of collection.observedItems) {
    for (const event of item.events) {
      if (event.kind !== "relation" || event.target.type !== "node") {
        continue;
      }
      const key = relationProgressEventKey(event);
      const relationEvents = relationEventsByKey.get(key);
      if (relationEvents == null) {
        relationEventsByKey.set(key, [event]);
      } else {
        relationEvents.push(event);
      }
      const existing = relationRemovalEventsByKey.get(key);
      if (
        existing == null ||
        event.occurredAt > existing.occurredAt ||
        (event.occurredAt === existing.occurredAt && event.sourceId > existing.sourceId)
      ) {
        relationRemovalEventsByKey.set(key, event);
      }
    }
  }
  const editedRelationSourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const detail of collection.details) {
    for (const comment of detail.comments) {
      if (comment.updatedAt === comment.createdAt) {
        continue;
      }
      const existing = editedRelationSourceOccurredAtById.get(comment.sourceId);
      if (existing == null || comment.updatedAt > existing) {
        editedRelationSourceOccurredAtById.set(comment.sourceId, comment.updatedAt);
      }
    }
  }
  const candidatesById = new Map<string, RelationCandidate>();
  for (const candidate of collection.relationCandidates) {
    if (!graph.relationCandidateAiDependencies.has(candidate.id)) {
      continue;
    }
    if (candidatesById.has(candidate.id)) {
      throw new TypeError(`関係候補 ${candidate.id}が重複しています`);
    }
    candidatesById.set(candidate.id, candidate);
  }
  const currentEdgesById = new Map<string, ReconciledGraphEdge>();
  for (const edge of graph.edges) {
    if (currentEdgesById.has(edge.id)) {
      throw new TypeError(`graph edge ${edge.id}が重複しています`);
    }
    currentEdgesById.set(edge.id, edge);
  }
  return Object.freeze({
    previousBlockerEdgesByTargetNodeId: previousBlockerEdgesByTargetNodeId(state),
    previousObservedAtByNodeId,
    previousEffectiveStateByNodeId,
    enumeratedItemsByNodeId,
    observedItemsByNodeId,
    currentNativeStateObservationsByNodeId,
    relationEventsByKey,
    sourceOccurredAtById: createDependencySourceOccurredAtById(collection),
    relationRemovalEventsByKey,
    editedRelationSourceOccurredAtById,
    candidatesById,
    relationCandidateAiDependencies: graph.relationCandidateAiDependencies,
    currentEdgesById,
  });
}

function createDependencyResolutionIndexes(
  staticIndexes: DependencyResolutionStaticIndexes,
  relationAssessments: readonly RelationCandidateAssessment[],
): DependencyResolutionIndexes {
  const assessmentsById = new Map<string, RelationCandidateAssessment>();
  for (const assessment of relationAssessments) {
    if (assessmentsById.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI判定が重複しています`);
    }
    assessmentsById.set(assessment.candidateId, assessment);
  }
  return Object.freeze({
    ...staticIndexes,
    assessmentsById,
  });
}

function latestRelationEventForProgress(
  indexes: DependencyResolutionIndexes,
  edge: Relation,
): RelationProgressEvent | undefined {
  const event = indexes.relationRemovalEventsByKey.get(
    relationProgressKey(edge.type, edge.provenance, edge.fromNodeId, edge.toNodeId),
  );
  if (event == null || event.occurredAt < edge.firstSeenAt || event.action !== "removed") {
    return undefined;
  }
  return event;
}

function editedRelationSourceOccurredAts(
  indexes: DependencyResolutionIndexes,
  edge: Relation,
): readonly UtcIsoDateTime[] {
  return Object.freeze(
    edge.evidence.flatMap((evidence) => {
      const occurredAt = indexes.editedRelationSourceOccurredAtById.get(evidence.sourceId);
      return occurredAt == null ? [] : [occurredAt];
    }),
  );
}

function createDependencySourceOccurredAtById(
  collection: CollectedItems,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const detailsByNodeId = new Map<GitHubNodeId, GitHubItemDetail>();
  for (const detail of collection.details) {
    if (detailsByNodeId.has(detail.nodeId)) {
      throw new TypeError(`依存解消sourceの詳細が重複しています。対象: ${detail.nodeId}`);
    }
    detailsByNodeId.set(detail.nodeId, detail);
  }
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const item of collection.observedItems) {
    const detail = detailsByNodeId.get(item.nodeId);
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
  indexes: DependencyResolutionIndexes,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  edge: Relation & Readonly<{ active: true }>,
): UtcIsoDateTime {
  const removalEvent = latestRelationEventForProgress(indexes, edge);
  if (removalEvent != null) {
    return removalEvent.occurredAt;
  }
  const currentCandidate = indexes.candidatesById.get(edge.id);
  if (currentCandidate == null) {
    const editedSourceOccurredAts = editedRelationSourceOccurredAts(indexes, edge);
    return editedSourceOccurredAts.length === 0
      ? edge.firstSeenAt
      : latestUtcIsoDateTime(editedSourceOccurredAts, `relation ${edge.id}の根拠編集`);
  }
  const currentEdge = indexes.currentEdgesById.get(edge.id);
  const currentEdgeOccurredAts = resolvedSourceOccurredAts(
    currentEdge?.evidence.map((evidence) => evidence.sourceId) ?? [],
    sourceOccurredAtById,
  );
  const assessment = indexes.assessmentsById.get(edge.id);
  const assessmentOccurredAts = resolvedSourceOccurredAts(
    assessment?.sourceIds ?? [],
    sourceOccurredAtById,
  );
  const occurredAts = [...currentEdgeOccurredAts, ...assessmentOccurredAts];
  return occurredAts.length === 0
    ? edge.firstSeenAt
    : latestUtcIsoDateTime(occurredAts, `relation ${edge.id}の再判定根拠`);
}

type DependencyBlockerCause =
  | Readonly<{
      status: "complete";
      evidence: readonly NotificationCauseEvidence[];
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

function notificationCauseEvidenceForEvent(
  event: NormalizedEvent,
): NotificationCauseEvidence | undefined {
  const actor = event.actor;
  if (actor.type !== "human") {
    return undefined;
  }
  const humanActor: NotificationCauseEvidence["actor"] = Object.freeze({
    type: "human",
    nodeId: actor.nodeId,
    login: actor.login,
  });
  return Object.freeze({
    sourceId: event.sourceId,
    occurredAt: event.occurredAt,
    actor: humanActor,
  });
}

type RelationCauseResolution =
  | Readonly<{
      status: "not_applicable";
      evidence: readonly NotificationCauseEvidence[];
    }>
  | Readonly<{
      status: "complete";
      evidence: readonly NotificationCauseEvidence[];
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

function nonEmptyNotificationCauseEvidence(
  evidence: readonly NotificationCauseEvidence[],
): NotificationCauseEvidenceList | undefined {
  const evidenceBySourceId = new Map<SourceId, NotificationCauseEvidence>();
  for (const entry of evidence) {
    evidenceBySourceId.set(entry.sourceId, entry);
  }
  const sortedEvidence = [...evidenceBySourceId.values()].sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return left.sourceId.localeCompare(right.sourceId);
  });
  const [first, ...rest] = sortedEvidence;
  if (first == null) {
    return undefined;
  }
  return Object.freeze([first, ...rest]);
}

function terminalCauseForBlocker(
  collection: CollectedItems,
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>,
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>,
  blockerNodeId: GraphNodeId,
  previousObservedAt: UtcIsoDateTime,
): DependencyBlockerCause | undefined {
  const terminal = enumeratedTerminal(enumeratedItemsByNodeId.get(blockerNodeId));
  if (terminal == null) {
    return undefined;
  }
  if (terminal.occurredAt <= previousObservedAt || terminal.occurredAt > collection.evaluatedAt) {
    return Object.freeze({ status: "indeterminate" });
  }
  const observed = observedItemsByNodeId.get(blockerNodeId);
  if (observed == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  const matchingEvents = observed.events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "state" }> =>
      event.kind === "state" &&
      event.itemNodeId === blockerNodeId &&
      event.state === terminal.state &&
      event.occurredAt === terminal.occurredAt &&
      event.occurredAt > previousObservedAt &&
      event.occurredAt <= collection.evaluatedAt,
  );
  if (matchingEvents.length !== 1) {
    return Object.freeze({ status: "indeterminate" });
  }
  const event = matchingEvents[0];
  assertNonNullable(event, `blocker ${blockerNodeId}のterminal state eventがありません`);
  const evidence = notificationCauseEvidenceForEvent(event);
  if (evidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    evidence: Object.freeze([evidence]),
  });
}

function relationCauseForEdge(
  collection: CollectedItems,
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>,
  edge: Relation,
  previousObservedAt: UtcIsoDateTime,
): RelationCauseResolution {
  const matchingEvents = (
    relationEventsByKey.get(
      relationProgressKey(edge.type, edge.provenance, edge.fromNodeId, edge.toNodeId),
    ) ?? []
  )
    .filter(
      (event) =>
        event.target.type === "node" &&
        event.relationType === edge.type &&
        event.provenance === edge.provenance &&
        event.occurredAt >= edge.firstSeenAt &&
        event.occurredAt > previousObservedAt &&
        event.occurredAt <= collection.evaluatedAt &&
        (event.direction === "from_item"
          ? event.itemNodeId === edge.fromNodeId && event.target.nodeId === edge.toNodeId
          : event.itemNodeId === edge.toNodeId && event.target.nodeId === edge.fromNodeId),
    )
    .sort((left, right) => {
      if (left.occurredAt < right.occurredAt) {
        return -1;
      }
      if (left.occurredAt > right.occurredAt) {
        return 1;
      }
      return left.sourceId.localeCompare(right.sourceId);
    });
  const latestEvent = matchingEvents.at(-1);
  if (latestEvent == null) {
    return Object.freeze({ status: "not_applicable", evidence: Object.freeze([]) });
  }
  const latestEvents = matchingEvents.filter(
    (event) => event.occurredAt === latestEvent.occurredAt,
  );
  const hasAddedEvent = latestEvents.some((event) => event.action === "added");
  const hasRemovedEvent = latestEvents.some((event) => event.action === "removed");
  if (hasAddedEvent && hasRemovedEvent) {
    return Object.freeze({ status: "indeterminate" });
  }
  if (!hasRemovedEvent) {
    return Object.freeze({ status: "not_applicable", evidence: Object.freeze([]) });
  }
  const evidence: NotificationCauseEvidence[] = [];
  for (const event of matchingEvents) {
    if (event.action !== "removed") {
      continue;
    }
    const eventEvidence = notificationCauseEvidenceForEvent(event);
    if (eventEvidence == null) {
      return Object.freeze({ status: "indeterminate" });
    }
    evidence.push(eventEvidence);
  }
  return Object.freeze({ status: "complete", evidence: Object.freeze(evidence) });
}

function dependencyCauseForBlocker(
  collection: CollectedItems,
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>,
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>,
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>,
  blockerNodeId: GraphNodeId,
  edges: readonly (Relation & Readonly<{ active: true }>)[],
  previousObservedAt: UtcIsoDateTime,
): DependencyBlockerCause {
  const terminalCause = terminalCauseForBlocker(
    collection,
    enumeratedItemsByNodeId,
    observedItemsByNodeId,
    blockerNodeId,
    previousObservedAt,
  );
  if (terminalCause?.status === "indeterminate") {
    return terminalCause;
  }
  const relationEvidence: NotificationCauseEvidence[] = [];
  let allRelationsRemoved = true;
  for (const edge of edges) {
    const relationCause = relationCauseForEdge(
      collection,
      relationEventsByKey,
      edge,
      previousObservedAt,
    );
    if (relationCause.status === "indeterminate") {
      return Object.freeze({ status: "indeterminate" });
    }
    if (relationCause.status === "not_applicable") {
      allRelationsRemoved = false;
    } else {
      relationEvidence.push(...relationCause.evidence);
    }
  }
  if (terminalCause == null && !allRelationsRemoved) {
    return Object.freeze({ status: "indeterminate" });
  }
  const completeEvidence = nonEmptyNotificationCauseEvidence([
    ...(terminalCause?.status === "complete" ? terminalCause.evidence : []),
    ...relationEvidence,
  ]);
  if (completeEvidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({ status: "complete", evidence: completeEvidence });
}

function dependencyCauseForBlockers(
  collection: CollectedItems,
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>,
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>,
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>,
  edgesByBlockerNodeId: ReadonlyMap<
    GraphNodeId,
    readonly (Relation & Readonly<{ active: true }>)[]
  >,
  previousObservedAt: UtcIsoDateTime,
): NotificationDependencyCause {
  const evidence: NotificationCauseEvidence[] = [];
  for (const [blockerNodeId, edges] of edgesByBlockerNodeId) {
    const blockerCause = dependencyCauseForBlocker(
      collection,
      enumeratedItemsByNodeId,
      observedItemsByNodeId,
      relationEventsByKey,
      blockerNodeId,
      edges,
      previousObservedAt,
    );
    if (blockerCause.status === "indeterminate") {
      return Object.freeze({ status: "indeterminate" });
    }
    evidence.push(...blockerCause.evidence);
  }
  const completeEvidence = nonEmptyNotificationCauseEvidence(evidence);
  if (completeEvidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    evidence: completeEvidence,
  });
}

function dependencyResolutionSupport(
  indexes: DependencyResolutionIndexes,
  edge: Relation & Readonly<{ active: true }>,
  occurredAt: UtcIsoDateTime,
): AiAnalysisDependency {
  const resolutionDependencies: AiAnalysisDependency[] = [];
  resolutionDependencies.push(edge.aiDependency);
  const removalEvent = latestRelationEventForProgress(indexes, edge);
  if (removalEvent?.occurredAt === occurredAt) {
    resolutionDependencies.push(notDependentAiDependency());
  }
  const currentCandidate = indexes.candidatesById.get(edge.id);
  if (currentCandidate != null) {
    const candidateDependency = indexes.relationCandidateAiDependencies.get(currentCandidate.id);
    assertNonNullable(candidateDependency, `関係候補 ${currentCandidate.id}のAI依存がありません`);
    resolutionDependencies.push(aiAnalysisDependencyForRelation(edge.id, candidateDependency));
  } else {
    const currentEdge = indexes.currentEdgesById.get(edge.id);
    if (currentEdge != null) {
      resolutionDependencies.push(currentEdge.aiDependency);
    }
  }
  return combineAiAnalysisDependencies(resolutionDependencies);
}

type DependencyResolutionRelationGroup = Readonly<{
  occurredAt: UtcIsoDateTime;
  edges: readonly (Relation & Readonly<{ active: true }>)[];
  supportDependency: AiAnalysisDependency;
  dependency: AiAnalysisDependency;
}>;

function relationResolutionGroups(
  edges: readonly (Relation & Readonly<{ active: true }>)[],
): readonly (readonly (Relation & Readonly<{ active: true }>)[])[] {
  const groups = new Map<string, (Relation & Readonly<{ active: true }>)[]>();
  for (const edge of edges) {
    const key = relationMeaningKey(edge.type, edge.fromNodeId, edge.toNodeId);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [edge]);
    } else {
      group.push(edge);
    }
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze(group)));
}

function dependencyResolutionRelationGroup(
  indexes: DependencyResolutionIndexes,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  edges: readonly (Relation & Readonly<{ active: true }>)[],
): DependencyResolutionRelationGroup {
  const supportDependency = preferIndependentAiDependency(edges.map((edge) => edge.aiDependency));
  const occurredAts = edges.map((edge) =>
    relationResolutionOccurredAt(indexes, sourceOccurredAtById, edge),
  );
  const occurredAt = latestUtcIsoDateTime(occurredAts, "関係supportの解消");
  const dependencies = edges.map((edge) =>
    dependencyResolutionSupport(
      indexes,
      edge,
      relationResolutionOccurredAt(indexes, sourceOccurredAtById, edge),
    ),
  );
  if (dependencies.length === 0) {
    throw new TypeError("関係supportの解消依存がありません");
  }
  return Object.freeze({
    occurredAt,
    edges: Object.freeze(edges),
    supportDependency,
    dependency: combineAiAnalysisDependencies(dependencies),
  });
}

function dependencyResolutions(
  collection: CollectedItems,
  graph: GraphResult | undefined,
  staticIndexes: DependencyResolutionStaticIndexes | undefined,
  relationAssessments: readonly RelationCandidateAssessment[],
  analysis: DeterministicItemAnalysis,
): DependencyResolutionResult {
  if (graph?.analysis.newlyUnblockedNodeIds.includes(analysis.item.nodeId) !== true) {
    return Object.freeze({
      progress: Object.freeze([]),
      cause: Object.freeze({ status: "not_applicable" }),
    });
  }
  assertNonNullable(staticIndexes, "newly unblocked項目の依存解消indexがありません");
  const edgesByBlockerNodeId = staticIndexes.previousBlockerEdgesByTargetNodeId.get(
    analysis.item.nodeId,
  );
  assertNonNullable(
    edgesByBlockerNodeId,
    `newly unblocked項目 ${analysis.item.nodeId}の前回blockerがありません`,
  );
  if (edgesByBlockerNodeId.size === 0) {
    throw new TypeError(`newly unblocked項目 ${analysis.item.nodeId}の前回blockerがありません`);
  }
  const previousObservedAt = staticIndexes.previousObservedAtByNodeId.get(analysis.item.nodeId);
  const enumeratedItemsByNodeId = staticIndexes.enumeratedItemsByNodeId;
  const cause: NotificationDependencyCause =
    previousObservedAt == null
      ? Object.freeze({ status: "indeterminate" })
      : dependencyCauseForBlockers(
          collection,
          enumeratedItemsByNodeId,
          staticIndexes.observedItemsByNodeId,
          staticIndexes.relationEventsByKey,
          edgesByBlockerNodeId,
          previousObservedAt,
        );
  const sourceOccurredAtById = staticIndexes.sourceOccurredAtById;
  const indexes = createDependencyResolutionIndexes(staticIndexes, relationAssessments);
  const blockerResolutions = [...edgesByBlockerNodeId].map(([blockerNodeId, edges]) => {
    const exactTerminalAt = enumeratedTerminalAt(enumeratedItemsByNodeId.get(blockerNodeId));
    const previousEffectiveState = staticIndexes.previousEffectiveStateByNodeId.get(blockerNodeId);
    const stateObservation =
      staticIndexes.currentNativeStateObservationsByNodeId.get(blockerNodeId);
    const indirectTerminalObservedAt =
      previousEffectiveState !== "open" ||
      stateObservation == null ||
      stateObservation.state === "open"
        ? undefined
        : stateObservation.observedAt;
    const terminalResolutionOccurredAt = exactTerminalAt ?? indirectTerminalObservedAt;
    const groups = relationResolutionGroups(edges).map((group) =>
      dependencyResolutionRelationGroup(indexes, sourceOccurredAtById, group),
    );
    const occurredAt =
      terminalResolutionOccurredAt ??
      latestUtcIsoDateTime(
        groups.map((group) => group.occurredAt),
        `blocker ${blockerNodeId}の関係解消`,
      );
    const selectedGroups = groups.filter((group) => group.occurredAt === occurredAt);
    const selectedEdges =
      terminalResolutionOccurredAt == null ? selectedGroups.flatMap((group) => group.edges) : [];
    const dependencies =
      terminalResolutionOccurredAt != null
        ? groups.map((group) =>
            combineSelectedAiDependencies([group.supportDependency, notDependentAiDependency()]),
          )
        : groups.map((group) => group.dependency);
    if (dependencies.length === 0) {
      throw new TypeError(`blocker ${blockerNodeId}の関係解消依存がありません`);
    }
    return Object.freeze({
      blockerNodeId,
      occurredAt,
      edges: Object.freeze(selectedEdges),
      dependencies: Object.freeze([combineAiAnalysisDependencies(dependencies)]),
    });
  });
  const resolutionOccurredAt = latestUtcIsoDateTime(
    [analysis.item.createdAt, ...blockerResolutions.map((resolution) => resolution.occurredAt)],
    `newly unblocked項目 ${analysis.item.nodeId}`,
  );
  const resolutionDependencies = blockerResolutions.flatMap(
    (resolution) => resolution.dependencies,
  );
  if (resolutionDependencies.length === 0) {
    throw new TypeError(`newly unblocked項目 ${analysis.item.nodeId}の依存解消根拠がありません`);
  }
  const sourceIds = [...edgesByBlockerNodeId.values()]
    .flat()
    .flatMap((edge) => edge.evidence.map((evidence) => evidence.sourceId));
  return Object.freeze({
    progress: Object.freeze([
      Object.freeze({
        occurredAt: resolutionOccurredAt,
        sourceIds: nonEmptySourceIds(sourceIds, `newly unblocked項目 ${analysis.item.nodeId}`),
        aiDependency: combineAiAnalysisDependencies(resolutionDependencies),
      }),
    ]),
    cause,
  });
}

function primaryWaitingOnForDecision(
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
  application: AiAnalysisElementApplication,
): PrimaryWaitingOn {
  if (!aiAnalysisElementApplicationUsesAiValue(application)) {
    return deterministicDecision.primaryWaitingOn;
  }
  const selectionSource = (() => {
    switch (application.status) {
      case "current_ai":
        return "現在の入力で検証したAI判定";
      case "retained_ai":
        return "保持しているAI判定";
      case "unknown":
        return "適用元を確認できないAI判定";
      case "not_required":
      case "deterministic_fallback":
      case "unavailable":
      case "disabled":
        throw new TypeError("AIを適用していないwaitingOnからAI向けのprimaryを作成できません");
      default:
        throw new UnreachableError(application);
    }
  })();
  if (decision.waitingOn.length === 0) {
    return Object.freeze({
      index: "not_applicable",
      selectionReason: `${selectionSource}に待ち相手がないためprimaryはありません`,
    });
  }
  return Object.freeze({
    index: 0,
    selectionReason: `${selectionSource}が返した待ち相手の優先順でprimaryを選定しました`,
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
  const sourceOccurredAtById = sourceOccurredAtByIdForAnalysis(analysis);
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

function sourceOccurredAtByIdForAnalysis(
  analysis: Readonly<
    Pick<DeterministicItemAnalysis, "item" | "detail" | "effectiveAssigneeCandidates">
  >,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
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
  return sourceOccurredAtById;
}

function previousStalenessState(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): Parameters<typeof calculateStaleness>[0]["previousState"] {
  const previous = previousTrackedItem(state, nodeId);
  if (previous == null) {
    return Object.freeze({
      availability: "not_available",
    });
  }
  return Object.freeze({
    availability: "available",
    stallSincePolicy: "inherit",
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

function notDependentAiDependency(): AiAnalysisDependency {
  return Object.freeze({ status: "not_dependent" });
}

function unrecordedAiDependency(): AiAnalysisDependency {
  return Object.freeze({
    status: "unknown",
    reasons: Object.freeze(["not_recorded"]),
  } satisfies AiAnalysisDependency);
}

function staleRepositoryAiDependency(): AiAnalysisDependency {
  return Object.freeze({
    status: "unknown",
    reasons: Object.freeze(["stale_repository"]),
  } satisfies AiAnalysisDependency);
}

function historicalAiDependencyHistory(
  dependency: AiAnalysisDependency,
): readonly AiAnalysisDependency[] {
  const reasons =
    dependency.status === "unknown"
      ? dependency.reasons.filter((reason) => reason === "migration" || reason === "not_recorded")
      : [];
  const [firstReason, ...remainingReasons] = reasons;
  return firstReason == null
    ? []
    : [
        normalizeAiAnalysisDependency({
          status: "unknown",
          reasons: [firstReason, ...remainingReasons],
        }),
      ];
}

function historicalAiDependencyFallback(dependency: AiAnalysisDependency): AiAnalysisDependency {
  const history = historicalAiDependencyHistory(dependency);
  return history.length === 0 ? unrecordedAiDependency() : combineAiAnalysisDependencies(history);
}

function revalidatedHistoricalAiDependencyForExpected(
  dependency: AiAnalysisDependency,
  expectedDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  const normalizedDependency = normalizeAiAnalysisDependency(dependency);
  if (normalizedDependency.status === "not_dependent") {
    return normalizedDependency;
  }
  if (normalizedDependency.producers == null) {
    return historicalAiDependencyFallback(normalizedDependency);
  }
  if (
    expectedDependency.status === "not_dependent" ||
    expectedDependency.producers == null ||
    hashCanonicalJson(normalizedDependency.producers) !==
      hashCanonicalJson(expectedDependency.producers)
  ) {
    return combineAiAnalysisDependencies([
      ...historicalAiDependencyHistory(normalizedDependency),
      unrecordedAiDependency(),
    ]);
  }
  return combineAiAnalysisDependencies([
    expectedDependency,
    ...historicalAiDependencyHistory(normalizedDependency),
  ]);
}

function revalidatedHistoricalAiDependency(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  dependency: AiAnalysisDependency,
): AiAnalysisDependency {
  return reconcileRetainedAiAnalysisDependency(dependency, {
    applicationsByNodeId: new Map([[nodeId, applications]]),
    relationsById: new Map(),
    candidatesById: new Map(),
  });
}

type RetainedBlockerValueAiDependencies = Readonly<{
  statusCandidates: readonly AiAnalysisDependency[] | undefined;
  waitingOn: AiAnalysisDependency | undefined;
  primaryWaitingOn: AiAnalysisDependency | undefined;
  nextAction: AiAnalysisDependency | undefined;
  confidence: AiAnalysisDependency | undefined;
  evidence: AiAnalysisDependency | undefined;
  uncertainties: AiAnalysisDependency | undefined;
  blockerStateRetainedWithoutCurrentTopology: boolean;
}>;

function aiDependencyReconciliationContext(
  items: readonly PendingTrackedItem[],
  candidates: readonly RelationCandidate[],
  graph: Pick<GraphResult, "edges" | "relationCandidateAiDependencies">,
): AiAnalysisDependencyReconciliationContext {
  const definitionsById = currentRelationCandidatesById(candidates);
  return Object.freeze({
    applicationsByNodeId: new Map(items.map((item) => [item.nodeId, item.aiAnalysis.applications])),
    relationsById: new Map(graph.edges.map((edge) => [edge.id, edge])),
    candidatesById: new Map(
      [...graph.relationCandidateAiDependencies].map(([candidateId, dependency]) => {
        const definition = definitionsById.get(candidateId);
        assertNonNullable(
          definition,
          `現在のrelation candidate定義がありません。対象: ${candidateId}`,
        );
        return [
          candidateId,
          Object.freeze({
            ...definition,
            aiDependency: aiAnalysisDependencyForRelationCandidate(
              candidateId,
              definition.endpointNodeIds,
              dependency,
            ),
          }),
        ];
      }),
    ),
  });
}

type CurrentAiDependencyContext = Omit<AiAnalysisDependencyReconciliationContext, "relationsById"> &
  Readonly<{
    relationsById: ReadonlyMap<string, ReconciledGraphEdge>;
    openNodeIds: ReadonlySet<GraphNodeId>;
    nativeOpenBlockerNodeIdsByTargetNodeId: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>;
    blockerValueDependenciesByNodeId: ReadonlyMap<GraphNodeId, RetainedBlockerValueAiDependencies>;
  }>;

function retainedElementUsesBlockerDependency(element: AiAnalysisDependencyElement): boolean {
  return (
    element === "status" ||
    element === "waitingOn" ||
    element === "primaryWaitingOn" ||
    element === "nextAction" ||
    element === "confidence" ||
    element === "evidence" ||
    element === "uncertainties"
  );
}

function retainedElementUsesStaleBlockerTopologyFallback(
  element: AiAnalysisDependencyElement,
): boolean {
  return (
    retainedElementUsesBlockerDependency(element) ||
    element === "lastProgressAt" ||
    element === "stallSince"
  );
}

function retainedBlockerItemElementProducerIsValid(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "item_element" }>,
  itemNodeId: GitHubNodeId,
  element: AiAnalysisDependencyElement,
): boolean {
  if (producer.nodeId !== itemNodeId) {
    return false;
  }
  switch (element) {
    case "status":
      return producer.element === "status";
    case "waitingOn":
    case "primaryWaitingOn":
      return producer.element === "waitingOn";
    case "nextAction":
      return producer.element === "nextAction";
    case "confidence":
    case "evidence":
    case "uncertainties":
      return (
        producer.element === "status" ||
        producer.element === "waitingOn" ||
        producer.element === "nextAction"
      );
    default:
      return true;
  }
}

function currentAiDependencyForProducer(
  producer: AiAnalysisDependencyProducer,
  itemNodeId: GitHubNodeId,
  element: AiAnalysisDependencyElement,
  context: CurrentAiDependencyContext,
): AiAnalysisDependency | undefined {
  const usesBlockerDependency = retainedElementUsesBlockerDependency(element);
  switch (producer.kind) {
    case "item_element": {
      if (
        usesBlockerDependency &&
        !retainedBlockerItemElementProducerIsValid(producer, itemNodeId, element)
      ) {
        return undefined;
      }
      const applications = context.applicationsByNodeId.get(producer.nodeId);
      if (applications == null) {
        return undefined;
      }
      return aiDependencyForElementApplication(producer.nodeId, applications, producer.element);
    }
    case "relation": {
      const relation = context.relationsById.get(producer.relationId);
      if (
        relation == null ||
        !relation.active ||
        (usesBlockerDependency &&
          (relation.type !== "blocks" ||
            relation.toNodeId !== itemNodeId ||
            !context.openNodeIds.has(relation.fromNodeId) ||
            !context.openNodeIds.has(relation.toNodeId)))
      ) {
        return undefined;
      }
      const dependency = relation.aiDependency;
      if (dependency.status === "not_dependent") {
        return dependency;
      }
      const matchesProducer = dependency.producers?.some(
        (currentProducer) =>
          currentProducer.kind === "relation" &&
          currentProducer.relationId === producer.relationId &&
          currentProducer.producer.nodeId === producer.producer.nodeId &&
          currentProducer.producer.element === producer.producer.element,
      );
      return matchesProducer === true ? dependency : undefined;
    }
    case "relation_candidate": {
      if (usesBlockerDependency && !producer.endpointNodeIds.includes(itemNodeId)) {
        return undefined;
      }
      return reconcileRetainedAiAnalysisDependency(
        Object.freeze({ status: "current", producers: Object.freeze([producer]) }),
        context,
      );
    }
    default:
      throw new UnreachableError(producer);
  }
}

function revalidatedHistoricalAiDependencyWithCurrentContext(
  itemNodeId: GitHubNodeId,
  element: AiAnalysisDependencyElement,
  dependency: AiAnalysisDependency,
  context: CurrentAiDependencyContext,
): AiAnalysisDependency {
  const normalizedDependency = normalizeAiAnalysisDependency(dependency);
  if (normalizedDependency.status === "not_dependent") {
    return normalizedDependency;
  }
  const producers = normalizedDependency.producers;
  if (producers == null) {
    return historicalAiDependencyFallback(normalizedDependency);
  }
  const resolvedDependencies: AiAnalysisDependency[] = [];
  let allProducersResolved = true;
  for (const producer of producers) {
    const resolved = currentAiDependencyForProducer(producer, itemNodeId, element, context);
    if (resolved == null || resolved.status === "not_dependent" || resolved.producers == null) {
      allProducersResolved = false;
      continue;
    }
    resolvedDependencies.push(resolved);
  }
  if (allProducersResolved) {
    const expectedDependency = combineAiAnalysisDependencies(resolvedDependencies);
    return combineAiAnalysisDependencies([
      expectedDependency,
      ...historicalAiDependencyHistory(normalizedDependency),
    ]);
  }
  return combineAiAnalysisDependencies([
    ...resolvedDependencies,
    ...historicalAiDependencyHistory(normalizedDependency),
    unrecordedAiDependency(),
  ]);
}

function currentDirectAiDependencyForRetainedElement(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency | undefined {
  let applicationElement: AiAnalysisElement | undefined;
  switch (element) {
    case "status":
    case "waitingOn":
    case "nextAction":
      applicationElement = element;
      break;
    case "primaryWaitingOn":
      applicationElement = "waitingOn";
      break;
    default:
      return undefined;
  }
  const application = item.aiAnalysis.applications[applicationElement];
  if (aiAnalysisElementApplicationUsesAiValue(application)) {
    return aiAnalysisDependencyForApplication(item.nodeId, applicationElement, application);
  }
  return undefined;
}

function staleBlockerTopologyDirectAiDependency(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency | undefined {
  if (element === "primaryWaitingOn") {
    const application = item.aiAnalysis.applications.waitingOn;
    return aiAnalysisElementApplicationUsesAiValue(application)
      ? aiAnalysisDependencyForApplication(item.nodeId, "waitingOn", application)
      : undefined;
  }
  if (element === "status" || element === "waitingOn" || element === "nextAction") {
    return aiAnalysisDependencyForApplication(
      item.nodeId,
      element,
      item.aiAnalysis.applications[element],
    );
  }
  return undefined;
}

function staleBlockerTopologyFallbackDependency(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency {
  const staleRepository = staleRepositoryAiDependency();
  const direct = staleBlockerTopologyDirectAiDependency(item, element);
  return direct == null
    ? staleRepository
    : combineAiAnalysisDependencies([direct, staleRepository]);
}

function retainedElementMatchesNativeOpenBlocker(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
  context: CurrentAiDependencyContext,
): boolean {
  const blockerNodeIds = context.nativeOpenBlockerNodeIdsByTargetNodeId.get(item.nodeId);
  if (blockerNodeIds == null) {
    return false;
  }
  if (element === "status") {
    return item.status === "waiting_for_unblock";
  }
  if (element === "nextAction") {
    return [...blockerNodeIds].some(
      (blockerNodeId) => item.nextAction === `${blockerNodeId}の完了を待つ`,
    );
  }
  return false;
}

function retainedBlockerExpectedDependencies(
  dependencies: RetainedBlockerValueAiDependencies,
  element: AiAnalysisDependencyElement,
): readonly AiAnalysisDependency[] {
  switch (element) {
    case "status":
      return dependencies.statusCandidates ?? Object.freeze([]);
    case "waitingOn":
      return dependencies.waitingOn == null
        ? Object.freeze([])
        : Object.freeze([dependencies.waitingOn]);
    case "primaryWaitingOn":
      return dependencies.primaryWaitingOn == null
        ? Object.freeze([])
        : Object.freeze([dependencies.primaryWaitingOn]);
    case "nextAction":
      return dependencies.nextAction == null
        ? Object.freeze([])
        : Object.freeze([dependencies.nextAction]);
    case "confidence":
      return dependencies.confidence == null
        ? Object.freeze([])
        : Object.freeze([dependencies.confidence]);
    case "evidence":
      return dependencies.evidence == null
        ? Object.freeze([])
        : Object.freeze([dependencies.evidence]);
    case "uncertainties":
      return dependencies.uncertainties == null
        ? Object.freeze([])
        : Object.freeze([dependencies.uncertainties]);
    default:
      return Object.freeze([]);
  }
}

function aiDependencyContainsLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  if (expected.status === "not_dependent") {
    return true;
  }
  if (aiDependencyIndependencePriority(actual) < aiDependencyIndependencePriority(expected)) {
    return false;
  }
  const actualProducerSignatures = new Set(
    actual.status === "not_dependent"
      ? []
      : (actual.producers ?? []).map((producer) => hashCanonicalJson(producer)),
  );
  return (
    expected.producers?.every((producer) =>
      actualProducerSignatures.has(hashCanonicalJson(producer)),
    ) ?? true
  );
}

function aiDependencyHasOnlyExpectedGraphProducers(
  dependency: AiAnalysisDependency,
  expected: AiAnalysisDependency,
): boolean {
  const expectedProducerSignatures = new Set(
    expected.status === "not_dependent"
      ? []
      : (expected.producers ?? []).map((producer) => hashCanonicalJson(producer)),
  );
  if (dependency.status === "not_dependent") {
    return true;
  }
  return (dependency.producers ?? []).every(
    (producer) =>
      producer.kind === "item_element" ||
      expectedProducerSignatures.has(hashCanonicalJson(producer)),
  );
}

function currentRetainedItemElementDependencies(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
  dependency: AiAnalysisDependency,
  context: CurrentAiDependencyContext,
): readonly AiAnalysisDependency[] {
  if (dependency.status === "not_dependent" || dependency.producers == null) {
    return Object.freeze([]);
  }
  const dependencies: AiAnalysisDependency[] = [];
  for (const producer of dependency.producers) {
    if (producer.kind !== "item_element") {
      continue;
    }
    const current = currentAiDependencyForProducer(producer, item.nodeId, element, context);
    if (current != null && current.status !== "not_dependent" && current.producers != null) {
      dependencies.push(current);
    }
  }
  return Object.freeze(dependencies);
}

function revalidatedRetainedTrackedItemAiDependency(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
  dependency: AiAnalysisDependency,
  context: CurrentAiDependencyContext,
): AiAnalysisDependency {
  const blockerDependencies = context.blockerValueDependenciesByNodeId.get(item.nodeId);
  assertNonNullable(
    blockerDependencies,
    `retained itemのblocker値AI依存がありません。対象: ${item.nodeId}`,
  );
  const directDependency = currentDirectAiDependencyForRetainedElement(item, element);
  const matchesNativeOpenBlocker = retainedElementMatchesNativeOpenBlocker(item, element, context);
  if (
    blockerDependencies.blockerStateRetainedWithoutCurrentTopology &&
    retainedElementUsesStaleBlockerTopologyFallback(element)
  ) {
    return staleBlockerTopologyFallbackDependency(item, element);
  }
  if (directDependency != null) {
    return directDependency;
  }
  if (matchesNativeOpenBlocker) {
    return notDependentAiDependency();
  }
  const historical = revalidatedHistoricalAiDependencyWithCurrentContext(
    item.nodeId,
    element,
    dependency,
    context,
  );
  const expectedCandidates = retainedBlockerExpectedDependencies(blockerDependencies, element);
  if (
    (element === "status" || element === "nextAction") &&
    expectedCandidates.length === 1 &&
    expectedCandidates[0]?.status === "not_dependent"
  ) {
    return notDependentAiDependency();
  }
  let revalidated = historical;
  const matchedExpected = expectedCandidates.find(
    (expected) =>
      aiDependencyContainsLowerBound(expected, historical) &&
      aiDependencyHasOnlyExpectedGraphProducers(historical, expected),
  );
  if (expectedCandidates.length !== 0 && matchedExpected == null) {
    const expected =
      expectedCandidates.find((candidate) =>
        aiDependencyContainsLowerBound(candidate, historical),
      ) ?? expectedCandidates[0];
    assertNonNullable(
      expected,
      `retained itemのblocker AI依存候補がありません。対象: ${item.nodeId} element: ${element}`,
    );
    const currentItemDependencies = currentRetainedItemElementDependencies(
      item,
      element,
      dependency,
      context,
    );
    revalidated = combineAiAnalysisDependencies([
      expected,
      ...currentItemDependencies,
      historicalAiDependencyFallback(dependency),
    ]);
  }
  if (
    (element === "status" || element === "waitingOn" || element === "nextAction") &&
    revalidated.status === "unknown" &&
    revalidated.reasons.length === 1 &&
    revalidated.reasons[0] === "migration" &&
    revalidated.producers == null
  ) {
    return unrecordedAiDependency();
  }
  return revalidated;
}

function aiDependencyForElementApplication(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  element: AiAnalysisElement,
): AiAnalysisDependency {
  const application = applications[element];
  assertNonNullable(application, `AI適用元がありません。対象: ${nodeId} element: ${element}`);
  return aiAnalysisDependencyForApplication(nodeId, element, application);
}

function combineSelectedAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    return notDependentAiDependency();
  }
  return combineAiAnalysisDependencies(dependencies);
}

function aiDependencyIndependencePriority(dependency: AiAnalysisDependency): number {
  switch (dependency.status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(dependency);
  }
}

function preferIndependentAiDependency(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    return notDependentAiDependency();
  }
  const preferredPriority = Math.min(...dependencies.map(aiDependencyIndependencePriority));
  const preferred = dependencies.filter(
    (dependency) => aiDependencyIndependencePriority(dependency) === preferredPriority,
  );
  return combineSelectedAiDependencies(preferred);
}

function preferredAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
  count: number,
): readonly AiAnalysisDependency[] {
  if (count < 0 || !Number.isInteger(count)) {
    throw new TypeError("選択するAI依存数は0以上の整数でなければなりません");
  }
  if (count > dependencies.length) {
    throw new TypeError("選択するAI依存数が候補数を超えています");
  }
  return Object.freeze(
    dependencies
      .map((dependency, index) => Object.freeze({ dependency, index }))
      .sort((left, right) => {
        const priorityOrder =
          aiDependencyIndependencePriority(left.dependency) -
          aiDependencyIndependencePriority(right.dependency);
        return priorityOrder === 0 ? left.index - right.index : priorityOrder;
      })
      .slice(0, count)
      .map((entry) => entry.dependency),
  );
}

function downstreamImpactAiDependenciesByNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of graph.downstreamImpactAiDependencies) {
    if (dependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`downstream impact AI依存が重複しています。対象: ${entry.nodeId}`);
    }
    dependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return dependenciesByNodeId;
}

function downstreamImpactsByNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]> {
  const impactsByNodeId = new Map<GraphNodeId, AnalyzeGraphResult["downstreamImpacts"][number]>();
  for (const impact of graph.analysis.downstreamImpacts) {
    if (impactsByNodeId.has(impact.nodeId)) {
      throw new TypeError(`downstream impactが重複しています。対象: ${impact.nodeId}`);
    }
    impactsByNodeId.set(impact.nodeId, impact);
  }
  return impactsByNodeId;
}

function blockersAiDependenciesByNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of graph.blockerSetAiDependencies) {
    if (dependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`blocker AI依存のnodeが重複しています。対象: ${entry.nodeId}`);
    }
    dependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return dependenciesByNodeId;
}

type BlockerNodeAiDependenciesByBlockedNodeId = ReadonlyMap<
  GraphNodeId,
  ReadonlyMap<string, BlockerNodeAiDependency>
>;

function blockerNodeAiDependenciesByBlockedNodeId(
  graph: GraphResult,
): BlockerNodeAiDependenciesByBlockedNodeId {
  const dependenciesByBlockedNodeId = new Map<GraphNodeId, Map<string, BlockerNodeAiDependency>>();
  for (const entry of graph.blockerNodeAiDependencies) {
    const dependenciesByBlockerNodeId = dependenciesByBlockedNodeId.get(entry.blockedNodeId);
    if (dependenciesByBlockerNodeId == null) {
      dependenciesByBlockedNodeId.set(entry.blockedNodeId, new Map([[entry.blockerNodeId, entry]]));
      continue;
    }
    if (dependenciesByBlockerNodeId.has(entry.blockerNodeId)) {
      throw new TypeError(
        `blocker node AI依存が重複しています。対象: ${entry.blockedNodeId} blocker: ${entry.blockerNodeId}`,
      );
    }
    dependenciesByBlockerNodeId.set(entry.blockerNodeId, entry);
  }
  return dependenciesByBlockedNodeId;
}

function graphAiDependenciesByNodeId(
  entries: readonly Readonly<{
    nodeId: GraphNodeId;
    dependency: AiAnalysisDependency;
  }>[],
  description: string,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of entries) {
    if (dependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`${description}が重複しています。対象: ${entry.nodeId}`);
    }
    dependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return dependenciesByNodeId;
}

type BlockerValueAiDependencies = Readonly<{
  stateSupport: "conditional" | "authoritative_blocker";
  status: AiAnalysisDependency;
  waitingOn: AiAnalysisDependency;
  primaryWaitingOn: AiAnalysisDependency;
  nextAction: AiAnalysisDependency;
  confidence: AiAnalysisDependency;
  evidence: AiAnalysisDependency;
  uncertainties: AiAnalysisDependency;
  transitionBasis: AiAnalysisDependency;
}>;

function notDependentBlockerValueAiDependencies(): BlockerValueAiDependencies {
  const dependency = notDependentAiDependency();
  return Object.freeze({
    stateSupport: "conditional",
    status: dependency,
    waitingOn: dependency,
    primaryWaitingOn: dependency,
    nextAction: dependency,
    confidence: dependency,
    evidence: dependency,
    uncertainties: dependency,
    transitionBasis: dependency,
  });
}

function unknownBlockerValueAiDependencies(): BlockerValueAiDependencies {
  return Object.freeze({
    stateSupport: "conditional",
    status: unrecordedAiDependency(),
    waitingOn: unrecordedAiDependency(),
    primaryWaitingOn: unrecordedAiDependency(),
    nextAction: unrecordedAiDependency(),
    confidence: unrecordedAiDependency(),
    evidence: unrecordedAiDependency(),
    uncertainties: unrecordedAiDependency(),
    transitionBasis: unrecordedAiDependency(),
  });
}

function blockerNodeAiDependencyForTrace(
  dependenciesByBlockedNodeId: BlockerNodeAiDependenciesByBlockedNodeId,
  blockedNodeId: GraphNodeId,
  blockerNodeId: string,
): BlockerNodeAiDependency {
  const dependenciesByBlockerNodeId = dependenciesByBlockedNodeId.get(blockedNodeId);
  assertNonNullable(
    dependenciesByBlockerNodeId,
    `blocker node AI依存indexがありません。対象: ${blockedNodeId}`,
  );
  const dependency = dependenciesByBlockerNodeId.get(blockerNodeId);
  assertNonNullable(
    dependency,
    `blocker node AI依存がありません。対象: ${blockedNodeId} blocker: ${blockerNodeId}`,
  );
  return dependency;
}

function combineBlockerPrimitiveDependencies(
  dependency: BlockerNodeAiDependency,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineSelectedAiDependencies(primitives.map((primitive) => dependency[primitive]));
}

type RetainedBlocker = Readonly<{
  blockerNodeId: GraphNodeId;
  authority: "authoritative" | "inferred";
  confidence: number;
  becameBlockingAt: UtcIsoDateTime;
  dependency: BlockerNodeAiDependency;
}>;

function compareRetainedBlockers(left: RetainedBlocker, right: RetainedBlocker): number {
  if (left.authority !== right.authority) {
    return left.authority === "authoritative" ? -1 : 1;
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  if (left.becameBlockingAt !== right.becameBlockingAt) {
    return left.becameBlockingAt < right.becameBlockingAt ? -1 : 1;
  }
  if (left.blockerNodeId === right.blockerNodeId) {
    return 0;
  }
  return left.blockerNodeId < right.blockerNodeId ? -1 : 1;
}

function nativeOpenBlockerNodeIdsByTargetNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>> {
  const blockerNodeIdsByTargetNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const edge of graph.edges) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      edge.provenance !== "native" ||
      edge.aiDependency.status !== "not_dependent" ||
      !graph.openNodeIds.has(edge.fromNodeId) ||
      !graph.openNodeIds.has(edge.toNodeId)
    ) {
      continue;
    }
    const blockerNodeIds = blockerNodeIdsByTargetNodeId.get(edge.toNodeId);
    if (blockerNodeIds == null) {
      blockerNodeIdsByTargetNodeId.set(edge.toNodeId, new Set([edge.fromNodeId]));
    } else {
      blockerNodeIds.add(edge.fromNodeId);
    }
  }
  return blockerNodeIdsByTargetNodeId;
}

function retainedBlockersByBlockedNodeId(
  graph: GraphResult,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PendingTrackedItem>,
): ReadonlyMap<GraphNodeId, readonly RetainedBlocker[]> {
  const supportsByBlockedNodeId = new Map<GraphNodeId, Map<GraphNodeId, ReconciledGraphEdge[]>>();
  for (const edge of graph.edges) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      !graph.openNodeIds.has(edge.fromNodeId) ||
      !graph.openNodeIds.has(edge.toNodeId)
    ) {
      continue;
    }
    const supportsByBlockerNodeId = supportsByBlockedNodeId.get(edge.toNodeId);
    if (supportsByBlockerNodeId == null) {
      supportsByBlockedNodeId.set(edge.toNodeId, new Map([[edge.fromNodeId, [edge]]]));
      continue;
    }
    const supports = supportsByBlockerNodeId.get(edge.fromNodeId);
    if (supports == null) {
      supportsByBlockerNodeId.set(edge.fromNodeId, [edge]);
    } else {
      supports.push(edge);
    }
  }
  const blockerDependenciesByNodeId = blockerNodeAiDependenciesByBlockedNodeId(graph);
  const blockersByBlockedNodeId = new Map<GraphNodeId, readonly RetainedBlocker[]>();
  for (const targetItem of itemsByNodeId.values()) {
    const blockedNodeId = targetItem.nodeId;
    const dependenciesByBlockerNodeId = blockerDependenciesByNodeId.get(blockedNodeId);
    const supportsByBlockerNodeId = supportsByBlockedNodeId.get(blockedNodeId);
    const blockers: RetainedBlocker[] = [];
    for (const [blockerNodeId, supports] of supportsByBlockerNodeId ?? []) {
      assertNonNullable(
        dependenciesByBlockerNodeId,
        `retained blockerのAI依存がありません。対象: ${blockedNodeId}`,
      );
      const dependency = dependenciesByBlockerNodeId.get(blockerNodeId);
      assertNonNullable(
        dependency,
        `retained blockerのAI依存がありません。対象: ${blockedNodeId} blocker: ${blockerNodeId}`,
      );
      const confidence = Math.max(...supports.map((support) => support.confidence));
      const becameBlockingAt = supports
        .map((support) =>
          support.provenance === "native" ? targetItem.createdAt : support.firstSeenAt,
        )
        .reduce((earliest, occurredAt) => (occurredAt < earliest ? occurredAt : earliest));
      blockers.push(
        Object.freeze({
          blockerNodeId,
          authority: supports.some((support) => support.provenance === "native")
            ? "authoritative"
            : "inferred",
          confidence,
          becameBlockingAt,
          dependency,
        }),
      );
    }
    blockersByBlockedNodeId.set(
      blockedNodeId,
      Object.freeze(blockers.sort(compareRetainedBlockers)),
    );
  }
  return blockersByBlockedNodeId;
}

type RetainedBlockerDecision =
  | Readonly<{ status: "consistent"; blocked: boolean | undefined }>
  | Readonly<{ status: "inconsistent" }>;

function retainedBlockerDecision(
  item: PendingTrackedItem,
  blockers: readonly RetainedBlocker[],
  minimumInferredConfidence: number,
): RetainedBlockerDecision {
  const blockerNodeIds = new Set<string>(blockers.map((blocker) => blocker.blockerNodeId));
  const results: boolean[] = [];
  const applications = item.aiAnalysis.applications;
  if (!aiAnalysisElementApplicationUsesAiValue(applications.status)) {
    results.push(item.status === "waiting_for_unblock");
  }
  if (!aiAnalysisElementApplicationUsesAiValue(applications.waitingOn)) {
    results.push(
      item.waitingOn.some(
        (waitingOn) =>
          waitingOn.kind === "item" &&
          waitingOn.role === "dependency" &&
          blockerNodeIds.has(waitingOn.candidateId),
      ),
    );
  }
  if (!aiAnalysisElementApplicationUsesAiValue(applications.nextAction)) {
    results.push(
      blockers.some((blocker) => item.nextAction === `${blocker.blockerNodeId}の完了を待つ`),
    );
  }
  const confirmedBlockerExists = blockers.some(
    (blocker) =>
      blocker.authority === "authoritative" || blocker.confidence >= minimumInferredConfidence,
  );
  if (new Set(results).size > 1 || (confirmedBlockerExists && results.some((result) => !result))) {
    return Object.freeze({ status: "inconsistent" });
  }
  const visibleDecision = results[0];
  if (visibleDecision != null) {
    return Object.freeze({ status: "consistent", blocked: visibleDecision });
  }
  return Object.freeze({
    status: "consistent",
    blocked: confirmedBlockerExists ? true : undefined,
  });
}

type RetainedConfirmedBlockers =
  | Readonly<{ status: "not_evaluated" }>
  | Readonly<{ status: "consistent"; blockers: readonly RetainedBlocker[] }>
  | Readonly<{ status: "inconsistent" }>;

function retainedConfirmedBlockers(
  item: PendingTrackedItem,
  blockers: readonly RetainedBlocker[],
): RetainedConfirmedBlockers {
  if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn)) {
    return Object.freeze({ status: "not_evaluated" });
  }
  const blockersByNodeId = new Map<string, RetainedBlocker>(
    blockers.map((blocker) => [blocker.blockerNodeId, blocker]),
  );
  const confirmed: RetainedBlocker[] = [];
  for (const waitingOn of item.waitingOn) {
    if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
      return Object.freeze({ status: "inconsistent" });
    }
    const blocker = blockersByNodeId.get(waitingOn.candidateId);
    if (blocker == null) {
      return Object.freeze({ status: "inconsistent" });
    }
    confirmed.push(blocker);
  }
  if (confirmed.length === 0) {
    return Object.freeze({ status: "inconsistent" });
  }
  return Object.freeze({
    status: "consistent",
    blockers: Object.freeze(confirmed),
  });
}

function retainedBlockerPrimitiveDependency(
  blocker: RetainedBlocker,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineBlockerPrimitiveDependencies(blocker.dependency, primitives);
}

function retainedBlockerStatusDependencyCandidates(
  blockers: readonly RetainedBlocker[],
  confirmedBlockers: readonly RetainedBlocker[] | undefined,
): readonly AiAnalysisDependency[] {
  const blockerGroups =
    confirmedBlockers == null
      ? [...new Set(blockers.map((blocker) => blocker.confidence))].map((threshold) =>
          blockers.filter((blocker) => blocker.confidence >= threshold),
        )
      : [confirmedBlockers];
  const dependenciesByHash = new Map<string, AiAnalysisDependency>();
  for (const group of blockerGroups) {
    const dependency = preferIndependentAiDependency(
      group.map((blocker) =>
        retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
    );
    dependenciesByHash.set(hashCanonicalJson(dependency), dependency);
  }
  return Object.freeze([...dependenciesByHash.values()]);
}

function retainedBlockerValueAiDependenciesWithoutCurrentTopology(): RetainedBlockerValueAiDependencies {
  const dependency = staleRepositoryAiDependency();
  return Object.freeze({
    statusCandidates: Object.freeze([dependency]),
    waitingOn: dependency,
    primaryWaitingOn: dependency,
    nextAction: dependency,
    confidence: dependency,
    evidence: dependency,
    uncertainties: dependency,
    blockerStateRetainedWithoutCurrentTopology: true,
  });
}

function retainedBlockerValueAiDependencies(
  item: PendingTrackedItem,
  blockers: readonly RetainedBlocker[],
  negativeDependency: AiAnalysisDependency,
  minimumInferredConfidence: number,
  itemIsStale: boolean,
  blockerTopologyChangedWhileStale: boolean,
): RetainedBlockerValueAiDependencies {
  if (item.state !== "open") {
    const dependency = notDependentAiDependency();
    return Object.freeze({
      statusCandidates: Object.freeze([dependency]),
      waitingOn: dependency,
      primaryWaitingOn: dependency,
      nextAction: dependency,
      confidence: dependency,
      evidence: dependency,
      uncertainties: dependency,
      blockerStateRetainedWithoutCurrentTopology: false,
    });
  }
  if (blockerTopologyChangedWhileStale) {
    if (!itemIsStale) {
      throw new TypeError(
        `fresh item ${item.nodeId}をstale blocker topology保持対象にはできません`,
      );
    }
    return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
  }
  const conditions = blockers.map((blocker) =>
    retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
  );
  const evidenceDependencies = blockers.map((blocker) =>
    retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence", "sourceIds"]),
  );
  const selectionConditions = blockers.map((blocker) =>
    retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence", "becameBlockingAt"]),
  );
  const evidence = combineSelectedAiDependencies([...evidenceDependencies, negativeDependency]);
  const decision = retainedBlockerDecision(item, blockers, minimumInferredConfidence);
  if (decision.status === "inconsistent") {
    if (itemIsStale) {
      return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
    }
    throw new TypeError(`retained item ${item.nodeId}のblocker判定値が相互に矛盾しています`);
  }
  const blocked = decision.blocked;
  if (blocked == null) {
    return Object.freeze({
      statusCandidates: undefined,
      waitingOn: undefined,
      primaryWaitingOn: undefined,
      nextAction: undefined,
      confidence: undefined,
      evidence: undefined,
      uncertainties: undefined,
      blockerStateRetainedWithoutCurrentTopology: false,
    });
  }
  if (!blocked) {
    const dependency = combineSelectedAiDependencies([...conditions, negativeDependency]);
    return Object.freeze({
      statusCandidates: Object.freeze([dependency]),
      waitingOn: dependency,
      primaryWaitingOn: dependency,
      nextAction: dependency,
      confidence: dependency,
      evidence,
      uncertainties: dependency,
      blockerStateRetainedWithoutCurrentTopology: false,
    });
  }
  const primaryBlocker = blockers[0];
  if (primaryBlocker == null) {
    if (itemIsStale) {
      return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
    }
    throw new TypeError(`retained item ${item.nodeId}のprimary blockerを再構成できません`);
  }
  const confirmedBlockerResult = retainedConfirmedBlockers(item, blockers);
  if (confirmedBlockerResult.status === "inconsistent") {
    if (itemIsStale) {
      return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
    }
    throw new TypeError(`retained item ${item.nodeId}のblocker waitingOnが不正です`);
  }
  const confirmedBlockers =
    confirmedBlockerResult.status === "consistent" ? confirmedBlockerResult.blockers : undefined;
  const statusCandidates =
    primaryBlocker.authority === "authoritative"
      ? Object.freeze([notDependentAiDependency()])
      : retainedBlockerStatusDependencyCandidates(blockers, confirmedBlockers);
  let waitingOn: AiAnalysisDependency | undefined;
  let primaryWaitingOn: AiAnalysisDependency | undefined;
  if (confirmedBlockers != null) {
    const confirmedNodeIds = new Set(confirmedBlockers.map((blocker) => blocker.blockerNodeId));
    const uncertainBlockers = blockers.filter(
      (blocker) => !confirmedNodeIds.has(blocker.blockerNodeId),
    );
    waitingOn = combineSelectedAiDependencies([
      ...confirmedBlockers.map((blocker) =>
        retainedBlockerPrimitiveDependency(blocker, [
          "presence",
          "confidence",
          "sourceIds",
          "becameBlockingAt",
        ]),
      ),
      ...uncertainBlockers.map((blocker) =>
        retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
      negativeDependency,
    ]);
    const primarySelectionDependency =
      primaryBlocker.authority === "authoritative"
        ? notDependentAiDependency()
        : combineSelectedAiDependencies([...selectionConditions, negativeDependency]);
    const authoritativeConfirmedCount = confirmedBlockers.filter(
      (blocker) => blocker.authority === "authoritative",
    ).length;
    const inferredConfirmedConditions = confirmedBlockers.flatMap((blocker) =>
      blocker.authority === "inferred"
        ? [retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"])]
        : [],
    );
    const multiplicityDependency =
      confirmedBlockers.length === 1
        ? combineSelectedAiDependencies([
            ...uncertainBlockers.map((blocker) =>
              retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
            negativeDependency,
          ])
        : combineSelectedAiDependencies(
            preferredAiDependencies(
              inferredConfirmedConditions,
              Math.max(0, 2 - authoritativeConfirmedCount),
            ),
          );
    primaryWaitingOn = combineSelectedAiDependencies([
      primarySelectionDependency,
      multiplicityDependency,
    ]);
  }
  const nextAction =
    primaryBlocker.authority === "authoritative"
      ? notDependentAiDependency()
      : combineSelectedAiDependencies([...selectionConditions, negativeDependency]);
  const confidence =
    primaryBlocker.authority === "authoritative"
      ? combineSelectedAiDependencies([
          primaryBlocker.dependency.confidence,
          ...blockers
            .filter((blocker) => blocker.authority === "inferred")
            .map((blocker) =>
              retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
          negativeDependency,
        ])
      : combineSelectedAiDependencies([
          primaryBlocker.dependency.confidence,
          ...selectionConditions,
          negativeDependency,
        ]);
  return Object.freeze({
    statusCandidates,
    waitingOn,
    primaryWaitingOn,
    nextAction,
    confidence,
    evidence,
    uncertainties: combineSelectedAiDependencies([...conditions, negativeDependency]),
    blockerStateRetainedWithoutCurrentTopology: false,
  });
}

function retainedBlockerValueAiDependenciesByNodeId(
  graph: GraphResult,
  items: readonly PendingTrackedItem[],
  minimumInferredConfidence: number,
  staleNodeIds: ReadonlySet<string>,
  staleBlockerTopologyNodeIds: ReadonlySet<GitHubNodeId>,
): ReadonlyMap<GraphNodeId, RetainedBlockerValueAiDependencies> {
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const blockersByBlockedNodeId = retainedBlockersByBlockedNodeId(graph, itemsByNodeId);
  const negativeDependenciesByNodeId = graphAiDependenciesByNodeId(
    graph.negativeBlockerAiDependencies,
    "negative blocker AI依存",
  );
  const dependenciesByNodeId = new Map<GraphNodeId, RetainedBlockerValueAiDependencies>();
  for (const item of items) {
    if (dependenciesByNodeId.has(item.nodeId)) {
      throw new TypeError(`retained blocker値AI依存のnodeが重複しています。対象: ${item.nodeId}`);
    }
    const negativeDependency = graphAiDependencyForNode(
      negativeDependenciesByNodeId,
      item.nodeId,
      "negative blocker AI依存",
    );
    dependenciesByNodeId.set(
      item.nodeId,
      retainedBlockerValueAiDependencies(
        item,
        blockersByBlockedNodeId.get(item.nodeId) ?? Object.freeze([]),
        negativeDependency,
        minimumInferredConfidence,
        staleNodeIds.has(item.nodeId),
        staleBlockerTopologyNodeIds.has(item.nodeId),
      ),
    );
  }
  return dependenciesByNodeId;
}

function blockerValueAiDependencies(
  nodeId: GraphNodeId,
  trace: BlockerDecisionTrace,
  dependenciesByBlockedNodeId: BlockerNodeAiDependenciesByBlockedNodeId,
  negativeDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>,
): BlockerValueAiDependencies {
  if (trace.status === "not_evaluated") {
    return notDependentBlockerValueAiDependencies();
  }
  const negativeDependency = graphAiDependencyForNode(
    negativeDependenciesByNodeId,
    nodeId,
    "negative blocker",
  );
  const uncertainDependencies = trace.uncertainBlockerIds.map((blockerNodeId) =>
    blockerNodeAiDependencyForTrace(dependenciesByBlockedNodeId, nodeId, blockerNodeId),
  );
  const uncertainConditions = uncertainDependencies.map((dependency) =>
    combineBlockerPrimitiveDependencies(dependency, ["presence", "confidence"]),
  );
  const uncertainEvidence = uncertainDependencies.map((dependency) =>
    combineBlockerPrimitiveDependencies(dependency, ["presence", "confidence", "sourceIds"]),
  );
  if (trace.result === "fallthrough") {
    const stateDependency = combineSelectedAiDependencies([
      ...uncertainConditions,
      negativeDependency,
    ]);
    const evidenceDependency = combineSelectedAiDependencies([
      ...uncertainEvidence,
      negativeDependency,
    ]);
    return Object.freeze({
      stateSupport: "conditional",
      status: stateDependency,
      waitingOn: stateDependency,
      primaryWaitingOn: stateDependency,
      nextAction: stateDependency,
      confidence: stateDependency,
      evidence: evidenceDependency,
      uncertainties: stateDependency,
      transitionBasis: stateDependency,
    });
  }

  const confirmedDependencies = trace.confirmedBlockers.map((blocker) =>
    Object.freeze({
      ...blocker,
      dependency: blockerNodeAiDependencyForTrace(
        dependenciesByBlockedNodeId,
        nodeId,
        blocker.candidateId,
      ),
    }),
  );
  const primaryBlocker = confirmedDependencies.find(
    (blocker) => blocker.candidateId === trace.primaryBlockerId,
  );
  assertNonNullable(primaryBlocker, `primary blockerのAI依存がありません。対象: ${nodeId}`);
  const confirmedConditions = confirmedDependencies.map((blocker) =>
    combineBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"]),
  );
  const confirmedEvidence = confirmedDependencies.map((blocker) =>
    combineBlockerPrimitiveDependencies(blocker.dependency, [
      "presence",
      "confidence",
      "sourceIds",
    ]),
  );
  const confirmedWaitingOn = confirmedDependencies.map((blocker) =>
    combineBlockerPrimitiveDependencies(blocker.dependency, [
      "presence",
      "confidence",
      "sourceIds",
      "becameBlockingAt",
    ]),
  );
  const selectionConditions = [
    ...confirmedDependencies.map((blocker) =>
      combineBlockerPrimitiveDependencies(blocker.dependency, [
        "presence",
        "confidence",
        "becameBlockingAt",
      ]),
    ),
    ...uncertainDependencies.map((dependency) =>
      combineBlockerPrimitiveDependencies(dependency, [
        "presence",
        "confidence",
        "becameBlockingAt",
      ]),
    ),
    negativeDependency,
  ];
  const primarySelectionDependency =
    primaryBlocker.authority === "authoritative"
      ? notDependentAiDependency()
      : combineSelectedAiDependencies(selectionConditions);
  const authoritativeConfirmedDependencies = confirmedDependencies.filter(
    (blocker) => blocker.authority === "authoritative",
  );
  const inferredConfirmedConditions = confirmedDependencies.flatMap((blocker) =>
    blocker.authority === "inferred"
      ? [combineBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"])]
      : [],
  );
  const requiredInferredBlockersForMultiplicity = Math.max(
    0,
    2 - authoritativeConfirmedDependencies.length,
  );
  const multiplicityDependency =
    confirmedDependencies.length === 1
      ? combineSelectedAiDependencies([...uncertainConditions, negativeDependency])
      : combineSelectedAiDependencies(
          preferredAiDependencies(
            inferredConfirmedConditions,
            requiredInferredBlockersForMultiplicity,
          ),
        );
  const primaryWaitingOnDependency = combineSelectedAiDependencies([
    primarySelectionDependency,
    multiplicityDependency,
  ]);
  const confidenceConditions =
    primaryBlocker.authority === "authoritative"
      ? confirmedDependencies
          .filter(
            (blocker) =>
              blocker.candidateId !== primaryBlocker.candidateId &&
              blocker.authority === "inferred",
          )
          .map((blocker) =>
            combineBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"]),
          )
          .concat(uncertainConditions, [negativeDependency])
      : selectionConditions;
  return Object.freeze({
    stateSupport:
      primaryBlocker.authority === "authoritative" ? "authoritative_blocker" : "conditional",
    status: preferIndependentAiDependency(confirmedConditions),
    waitingOn: combineSelectedAiDependencies([
      ...confirmedWaitingOn,
      ...uncertainConditions,
      negativeDependency,
    ]),
    primaryWaitingOn: primaryWaitingOnDependency,
    nextAction: primarySelectionDependency,
    confidence: combineSelectedAiDependencies([
      primaryBlocker.dependency.confidence,
      ...confidenceConditions,
    ]),
    evidence: combineSelectedAiDependencies([
      ...confirmedEvidence,
      ...uncertainEvidence,
      negativeDependency,
    ]),
    uncertainties: combineSelectedAiDependencies([
      ...confirmedConditions,
      ...uncertainConditions,
      negativeDependency,
    ]),
    transitionBasis: combineSelectedAiDependencies([
      primarySelectionDependency,
      primaryBlocker.dependency.becameBlockingAt,
    ]),
  });
}

function graphAiDependencyForNode(
  dependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency> | undefined,
  nodeId: GraphNodeId,
  description: string,
): AiAnalysisDependency {
  assertNonNullable(dependenciesByNodeId, `${description}のAI依存indexがありません`);
  const dependency = dependenciesByNodeId.get(nodeId);
  assertNonNullable(dependency, `${description}のAI依存がありません。対象: ${nodeId}`);
  return dependency;
}

function graphMapValue<T>(
  valuesByNodeId: ReadonlyMap<GraphNodeId, T>,
  nodeId: GraphNodeId,
  description: string,
): T {
  const value = valuesByNodeId.get(nodeId);
  assertNonNullable(value, `${description}がありません。対象: ${nodeId}`);
  return value;
}

function stateDependenciesForWaitClass(
  decision: Readonly<Pick<ReducedCodexDecision, "status" | "waitingOn" | "evidence">>,
  waitClass: StalenessWaitClass,
  dependencies: Readonly<{
    status: AiAnalysisDependency;
    waitingOn: AiAnalysisDependency;
    evidence: AiAnalysisDependency;
  }>,
): readonly AiAnalysisDependency[] {
  if (waitClass === "notApplicable" || waitClass === "blockedParent") {
    return Object.freeze([dependencies.status]);
  }
  const primaryWaitingOn = decision.waitingOn[0];
  assertNonNullable(primaryWaitingOn, "継続中状態のprimary waitingOnがありません");
  const precedingConditions = [dependencies.status, dependencies.waitingOn];
  const withPrecedingConditions = (route: AiAnalysisDependency): AiAnalysisDependency =>
    combineSelectedAiDependencies([...precedingConditions, route]);
  switch (waitClass) {
    case "owner":
      if (primaryWaitingOn.kind === "unknown" || primaryWaitingOn.role === "unknown") {
        return Object.freeze([withPrecedingConditions(dependencies.waitingOn)]);
      }
      if (decision.status === "waiting_for_owner" || decision.status === "unknown") {
        return Object.freeze([withPrecedingConditions(dependencies.status)]);
      }
      throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
    case "automation": {
      const routes: AiAnalysisDependency[] = [];
      if (decision.status === "waiting_for_automation") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.kind === "automation") {
        routes.push(dependencies.waitingOn);
      }
      if (routes.length === 0) {
        throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
      }
      return Object.freeze([withPrecedingConditions(preferIndependentAiDependency(routes))]);
    }
    case "review": {
      const routes: AiAnalysisDependency[] = [];
      if (decision.status === "waiting_for_review") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.role === "reviewer") {
        routes.push(dependencies.waitingOn);
      }
      if (routes.length === 0) {
        throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
      }
      return Object.freeze([withPrecedingConditions(preferIndependentAiDependency(routes))]);
    }
    case "assessment":
    case "decision":
    case "merge":
    case "reply":
      return Object.freeze([withPrecedingConditions(dependencies.status)]);
    case "revision": {
      if (decision.status !== "waiting_for_revision") {
        throw new TypeError(`wait class ${waitClass}とstatusの組み合わせが不正です`);
      }
      const revisionConditionDependencies = [
        dependencies.status,
        dependencies.waitingOn,
        dependencies.evidence,
      ];
      return Object.freeze([
        combineSelectedAiDependencies([...precedingConditions, ...revisionConditionDependencies]),
      ]);
    }
    case "work":
      if (decision.status === "waiting_for_revision") {
        const revisionConditionDependencies = [
          dependencies.status,
          dependencies.waitingOn,
          dependencies.evidence,
        ];
        return Object.freeze([
          combineSelectedAiDependencies([...precedingConditions, ...revisionConditionDependencies]),
        ]);
      }
      if (decision.status === "waiting_for_work" || decision.status === "in_progress") {
        return Object.freeze([withPrecedingConditions(dependencies.status)]);
      }
      throw new TypeError(`wait class ${waitClass}とstatusの組み合わせが不正です`);
    default:
      throw new UnreachableError(waitClass);
  }
}

function latestEventTime(
  events: readonly NormalizedEvent[],
  predicate: (event: NormalizedEvent) => boolean,
): UtcIsoDateTime | undefined {
  let latest: UtcIsoDateTime | undefined;
  for (const event of events) {
    if (!predicate(event)) {
      continue;
    }
    if (latest == null || event.occurredAt > latest) {
      latest = event.occurredAt;
    }
  }
  return latest;
}

type ReducedWaitingOn = readonly ReducedCodexDecision["waitingOn"][number][];

function sameWaitingOnEntities(left: ReducedWaitingOn, right: ReducedWaitingOn): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((waitingOn, index) => {
    const other = right[index];
    assertNonNullable(other, "比較対象のwaitingOnがありません");
    return (
      waitingOn.kind === other.kind &&
      waitingOn.candidateId === other.candidateId &&
      waitingOn.role === other.role
    );
  });
}

function lastResponsibleHumanActivityAt(
  item: FreshObservedGitHubItem,
  waitingOn: ReducedWaitingOn,
): UtcIsoDateTime | undefined {
  const accountIdentifiers = resolveWaitingOnAccountIdentifiers(waitingOn);
  return latestEventTime(
    item.events,
    (event) =>
      !isExcludedFromProgressAndHumanActivity(event) &&
      event.actor.type === "human" &&
      (accountIdentifiers.has(event.actor.login) || accountIdentifiers.has(event.actor.nodeId)),
  );
}

function lastHumanReviewAt(item: FreshObservedGitHubItem): UtcIsoDateTime | undefined {
  return latestEventTime(
    item.events,
    (event) => event.kind === "review" && event.actor.type === "human",
  );
}

function isPullRequestReviewWait(
  item: FreshObservedGitHubItem,
  decision: Readonly<Pick<ReducedCodexDecision, "status">>,
): boolean {
  return (
    item.type === "pull_request" &&
    (decision.status === "waiting_for_owner" || decision.status === "waiting_for_review")
  );
}

type AiDependencyTimeCandidate = Readonly<{
  occurredAt: UtcIsoDateTime;
  dependency: AiAnalysisDependency;
}>;

function transitionBasisAiDependency(
  item: FreshObservedGitHubItem,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  decision: ReducedCodexDecision,
  basis: Readonly<{
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  itemDependencies: TrackedItemAiDependencies,
  deterministicDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  if (decision.origin === "deterministic") {
    return deterministicDependency;
  }
  const evidenceSourceIds = new Set<string>(decision.evidence.map((evidence) => evidence.sourceId));
  const waitingOnSourceIds = new Set<string>(
    decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds),
  );
  const sourceIdsAtBasis = basis.sourceIds.filter(
    (sourceId) => sourceOccurredAtById.get(sourceId) === basis.occurredAt,
  );
  const dependencies: AiAnalysisDependency[] = [];
  if (basis.occurredAt === item.createdAt) {
    dependencies.push(notDependentAiDependency());
  }
  if (sourceIdsAtBasis.some((sourceId) => evidenceSourceIds.has(sourceId))) {
    dependencies.push(itemDependencies.evidence);
  }
  if (sourceIdsAtBasis.some((sourceId) => waitingOnSourceIds.has(sourceId))) {
    dependencies.push(itemDependencies.waitingOn);
  }
  return dependencies.length === 0
    ? unrecordedAiDependency()
    : preferIndependentAiDependency(dependencies);
}

function candidateAiDependency(
  dependency: AiAnalysisDependency,
  conditionDependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  return combineSelectedAiDependencies([dependency, ...conditionDependencies]);
}

const STATE_AI_ANALYSIS_ELEMENTS: readonly ["status", "waitingOn", "nextAction"] = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
]);

function stallSinceAiDependency(
  item: FreshObservedGitHubItem,
  applications: TrackedItemAiAnalysisApplications,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  decision: ReducedCodexDecision,
  staleness: StalenessResult,
  itemDependencies: TrackedItemAiDependencies,
  previousItem: SnapshotTrackedItem | undefined,
  statusBasis: Readonly<{
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  responsibilityBasis: Readonly<{
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  deterministicTransitionDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  const stateDependencies = {
    status: itemDependencies.status,
    waitingOn: itemDependencies.waitingOn,
    evidence: itemDependencies.evidence,
  };
  const statusTransitionDependency = transitionBasisAiDependency(
    item,
    sourceOccurredAtById,
    decision,
    statusBasis,
    itemDependencies,
    deterministicTransitionDependency,
  );
  const responsibilityTransitionDependency = transitionBasisAiDependency(
    item,
    sourceOccurredAtById,
    decision,
    responsibilityBasis,
    itemDependencies,
    deterministicTransitionDependency,
  );
  const statusBasisDependency = candidateAiDependency(statusTransitionDependency, [
    stateDependencies.status,
  ]);
  const responsibilityBasisDependency = candidateAiDependency(responsibilityTransitionDependency, [
    stateDependencies.waitingOn,
  ]);
  const candidates: AiDependencyTimeCandidate[] = [];
  const add = (
    occurredAt: UtcIsoDateTime,
    dependency: AiAnalysisDependency,
    conditionDependencies: readonly AiAnalysisDependency[],
  ): void => {
    candidates.push(
      Object.freeze({
        occurredAt,
        dependency: candidateAiDependency(dependency, conditionDependencies),
      }),
    );
  };
  const reviewWait = isPullRequestReviewWait(item, decision);
  const previousStatusChanged = previousItem != null && previousItem.status !== decision.status;
  const previousResponsibilityChanged =
    previousItem != null && !sameWaitingOnEntities(previousItem.waitingOn, decision.waitingOn);
  const previousStateDependencies =
    previousItem == null
      ? undefined
      : Object.freeze({
          status: revalidatedHistoricalAiDependencyForExpected(
            previousItem.aiDependencies.status,
            stateDependencies.status,
          ),
          waitingOn: revalidatedHistoricalAiDependencyForExpected(
            previousItem.aiDependencies.waitingOn,
            stateDependencies.waitingOn,
          ),
        });
  const reviewWaitConditions = item.type === "pull_request" ? [stateDependencies.status] : [];
  const previousStateComparisonConditions: readonly AiAnalysisDependency[] =
    previousStateDependencies == null
      ? []
      : [
          stateDependencies.status,
          previousStateDependencies.status,
          stateDependencies.waitingOn,
          previousStateDependencies.waitingOn,
        ];
  if (previousItem == null) {
    add(staleness.statusSince, statusBasisDependency, reviewWaitConditions);
    add(responsibilityBasis.occurredAt, responsibilityBasisDependency, reviewWaitConditions);
  } else if (previousStatusChanged && previousResponsibilityChanged) {
    add(staleness.statusSince, statusBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
    add(responsibilityBasis.occurredAt, responsibilityBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
  } else if (previousStatusChanged) {
    add(staleness.statusSince, statusBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
  } else if (previousResponsibilityChanged) {
    add(responsibilityBasis.occurredAt, responsibilityBasisDependency, [
      ...previousStateComparisonConditions,
      ...reviewWaitConditions,
    ]);
  }

  if (!reviewWait) {
    const progressConditions = item.type === "pull_request" ? [stateDependencies.status] : [];
    add(staleness.lastProgressAt, itemDependencies.lastProgressAt, progressConditions);
  }
  const responsibleActivityAt = lastResponsibleHumanActivityAt(item, decision.waitingOn);
  if (responsibleActivityAt != null) {
    add(responsibleActivityAt, notDependentAiDependency(), [stateDependencies.waitingOn]);
  }
  const humanReviewAt = lastHumanReviewAt(item);
  if (reviewWait && humanReviewAt != null) {
    add(humanReviewAt, notDependentAiDependency(), reviewWaitConditions);
  }

  if (
    previousItem != null &&
    (reviewWait || (!previousStatusChanged && !previousResponsibilityChanged))
  ) {
    const previousStallConditions = reviewWait
      ? reviewWaitConditions
      : previousStateComparisonConditions;
    add(
      previousItem.stallSince,
      revalidatedHistoricalAiDependency(
        item.nodeId,
        applications,
        previousItem.aiDependencies.stallSince,
      ),
      previousStallConditions,
    );
  }

  if (
    previousItem != null &&
    item.type === "pull_request" &&
    decision.status === "waiting_for_review"
  ) {
    const basisSourceIds = new Set(responsibilityBasis.sourceIds);
    const explicitReviewRequestAt = latestEventTime(
      item.events,
      (event) =>
        event.kind === "review_request" &&
        event.action === "added" &&
        basisSourceIds.has(event.sourceId) &&
        event.occurredAt === staleness.ownerSince &&
        event.occurredAt > previousItem.ownerSince,
    );
    if (explicitReviewRequestAt != null) {
      assertNonNullable(
        previousStateDependencies,
        `過去の状態比較に使うAI依存がありません。対象: ${item.nodeId}`,
      );
      add(explicitReviewRequestAt, notDependentAiDependency(), [
        stateDependencies.status,
        responsibilityTransitionDependency,
        previousStateDependencies.status,
        previousStateDependencies.waitingOn,
      ]);
    }
  }

  const selectedCandidates = candidates.filter(
    (candidate) => candidate.occurredAt === staleness.stallSince,
  );
  if (selectedCandidates.length === 0) {
    throw new TypeError(`stallSinceのAI依存候補がありません。対象: ${item.nodeId}`);
  }
  return preferIndependentAiDependency(selectedCandidates.map((candidate) => candidate.dependency));
}

function severityAiDependency(
  decision: Readonly<
    Pick<ReducedCodexDecision, "status" | "waitingOn" | "confidence" | "evidence">
  >,
  staleness: Readonly<Pick<StalenessResult, "waitClass">>,
  criticalRequested: boolean,
  itemDependencies: TrackedItemAiDependencies,
): AiAnalysisDependency {
  if (staleness.waitClass === "notApplicable" || staleness.waitClass === "blockedParent") {
    return itemDependencies.status;
  }
  const stateDependencies = stateDependenciesForWaitClass(
    decision,
    staleness.waitClass,
    itemDependencies,
  );
  const dependencies = [itemDependencies.stallSince, ...stateDependencies];
  if (criticalRequested) {
    dependencies.push(itemDependencies.confidence);
  }
  return combineSelectedAiDependencies(dependencies);
}

function criticalSeverityWasRequested(reason: StalenessResult["severityReason"]): boolean {
  if (reason.kind !== "elapsed_threshold") {
    return false;
  }
  return (
    reason.baseSeverity === "critical" ||
    (reason.baseSeverity === "urgent" && reason.labelLiftRequested === 1)
  );
}

function attentionAiDependency(
  decision: Readonly<Pick<ReducedCodexDecision, "status" | "waitingOn" | "evidence">>,
  staleness: Readonly<Pick<StalenessResult, "waitClass">>,
  importance: TrackedItemWithImportanceAssessment["importance"],
  deadlineLevel: DeadlineLevel,
  itemDependencies: TrackedItemAiDependencies,
): AiAnalysisDependency {
  if (staleness.waitClass === "notApplicable" || staleness.waitClass === "blockedParent") {
    return itemDependencies.status;
  }
  const dependencies: AiAnalysisDependency[] = [
    itemDependencies.importance,
    itemDependencies.deadlineLevel,
  ];
  const stateDependencies = stateDependenciesForWaitClass(
    decision,
    staleness.waitClass,
    itemDependencies,
  );
  if (importance.score !== 0) {
    dependencies.push(...stateDependencies);
    dependencies.push(itemDependencies.stallSince);
  }
  if (deadlineLevel !== "none") {
    dependencies.push(...stateDependencies);
  }
  return combineSelectedAiDependencies(dependencies);
}

function stateAiDependencies(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: BlockerValueAiDependencies,
): Readonly<{
  status: AiAnalysisDependency;
  waitingOn: AiAnalysisDependency;
  primaryWaitingOn: AiAnalysisDependency;
  nextAction: AiAnalysisDependency;
}> {
  const stateApplicationDependency = (
    element: "status" | "waitingOn" | "nextAction",
  ): AiAnalysisDependency => aiDependencyForElementApplication(nodeId, applications, element);
  const stateValueDependency = (
    element: "status" | "waitingOn" | "nextAction",
    blockerDependency: AiAnalysisDependency,
  ): AiAnalysisDependency => {
    const application = applications[element];
    const dependency = stateApplicationDependency(element);
    if (aiAnalysisElementApplicationUsesAiValue(application)) {
      return dependency;
    }
    if (
      blockerDependencies.stateSupport === "authoritative_blocker" &&
      (element === "status" || element === "nextAction")
    ) {
      return blockerDependency;
    }
    return combineSelectedAiDependencies([dependency, blockerDependency]);
  };
  const waitingOn = stateValueDependency("waitingOn", blockerDependencies.waitingOn);
  const primaryWaitingOn = (() => {
    if (aiAnalysisElementApplicationUsesAiValue(applications.waitingOn)) {
      return stateApplicationDependency("waitingOn");
    }
    if (blockerDependencies.stateSupport === "authoritative_blocker") {
      return blockerDependencies.primaryWaitingOn;
    }
    return combineSelectedAiDependencies([
      stateApplicationDependency("waitingOn"),
      blockerDependencies.primaryWaitingOn,
    ]);
  })();
  return Object.freeze({
    status: stateValueDependency("status", blockerDependencies.status),
    waitingOn,
    primaryWaitingOn,
    nextAction: stateValueDependency("nextAction", blockerDependencies.nextAction),
  });
}

function confidenceAiDependency(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: BlockerValueAiDependencies,
): AiAnalysisDependency {
  if (blockerDependencies.stateSupport === "authoritative_blocker") {
    return blockerDependencies.confidence;
  }
  const dependencies: AiAnalysisDependency[] = [];
  const allStateValuesUseAi = STATE_AI_ANALYSIS_ELEMENTS.every((element) =>
    aiAnalysisElementApplicationUsesAiValue(applications[element]),
  );
  if (!allStateValuesUseAi) {
    dependencies.push(blockerDependencies.confidence);
  }
  for (const element of STATE_AI_ANALYSIS_ELEMENTS) {
    if (
      !aiAnalysisElementApplicationUsesAiValue(applications[element]) &&
      applications[element].status !== "unavailable"
    ) {
      continue;
    }
    dependencies.push(aiDependencyForElementApplication(nodeId, applications, element));
  }
  return combineSelectedAiDependencies(dependencies);
}

function evidenceAiDependency(
  nodeId: GitHubNodeId,
  decision: ReducedCodexDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: BlockerValueAiDependencies,
): AiAnalysisDependency {
  if (blockerDependencies.stateSupport === "authoritative_blocker") {
    return blockerDependencies.evidence;
  }
  const dependencies: AiAnalysisDependency[] = [];
  for (const element of STATE_AI_ANALYSIS_ELEMENTS) {
    if (
      aiAnalysisElementApplicationUsesAiValue(applications[element]) ||
      applications[element].status === "unavailable"
    ) {
      dependencies.push(aiDependencyForElementApplication(nodeId, applications, element));
    }
  }
  const deterministicEvidence = new Set(
    deterministicDecision.evidence.map((evidence) => serializeCanonicalJson(evidence)),
  );
  if (
    decision.evidence.some((evidence) =>
      deterministicEvidence.has(serializeCanonicalJson(evidence)),
    )
  ) {
    dependencies.push(blockerDependencies.evidence);
  }
  return combineSelectedAiDependencies(dependencies);
}

function uncertaintiesAiDependency(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  return combineSelectedAiDependencies([
    ...STATE_AI_ANALYSIS_ELEMENTS.map((element) =>
      aiDependencyForElementApplication(nodeId, applications, element),
    ),
    blockerDependency,
  ]);
}

function lastProgressAiDependency(
  nodeId: GitHubNodeId,
  createdAt: UtcIsoDateTime,
  applications: TrackedItemAiAnalysisApplications,
  staleness: StalenessResult,
  previousItem: SnapshotTrackedItem | undefined,
): AiAnalysisDependency {
  const deterministicAtLatest = staleness.meaningfulProgress.some(
    (progress) =>
      progress.occurredAt === staleness.lastProgressAt &&
      progress.determination === "deterministic" &&
      (progress.kind !== "dependency_resolved" || progress.aiDependency.status === "not_dependent"),
  );
  const currentProgressDependency = staleness.meaningfulProgress.some(
    (progress) =>
      progress.occurredAt === staleness.lastProgressAt && progress.determination === "ai",
  )
    ? aiDependencyForElementApplication(nodeId, applications, "progress")
    : undefined;
  const previousProgressDependency =
    previousItem?.lastProgressAt === staleness.lastProgressAt
      ? revalidatedHistoricalAiDependency(
          nodeId,
          applications,
          previousItem.aiDependencies.lastProgressAt,
        )
      : undefined;
  const selectedDependencies = [
    ...(createdAt === staleness.lastProgressAt ? [notDependentAiDependency()] : []),
    ...staleness.meaningfulProgress.flatMap((progress) => {
      if (
        progress.occurredAt !== staleness.lastProgressAt ||
        progress.kind !== "dependency_resolved"
      ) {
        return [];
      }
      return [progress.aiDependency];
    }),
    ...(deterministicAtLatest ? [notDependentAiDependency()] : []),
    ...(currentProgressDependency == null ? [] : [currentProgressDependency]),
    ...(previousProgressDependency == null ? [] : [previousProgressDependency]),
  ];
  const selectedDependency = preferIndependentAiDependency(
    selectedDependencies.length === 0 ? [notDependentAiDependency()] : selectedDependencies,
  );
  const hasNewerNaturalLanguageCandidate = staleness.naturalLanguageProgressCandidates.some(
    (candidate) => candidate.occurredAt > staleness.lastProgressAt,
  );
  return combineSelectedAiDependencies([
    selectedDependency,
    ...(hasNewerNaturalLanguageCandidate
      ? [aiDependencyForElementApplication(nodeId, applications, "progress")]
      : []),
  ]);
}

type AiAnalysisElementApplicationReason = Extract<
  AiAnalysisElementApplication,
  { status: "retained_ai" }
>["reason"];

function sameAiAnalysisElementResult(
  left: AiAnalysisElementMigrationResult | undefined,
  right: AiAnalysisElementMigrationResult | undefined,
): boolean {
  return left != null && right != null && hashCanonicalJson(left) === hashCanonicalJson(right);
}

function aiAnalysisElementApplicationReason(
  run: AiAnalysisRunResult | undefined,
  nodeId: GitHubNodeId,
  generated: AiAnalysisElementSourceGeneration | undefined,
): AiAnalysisElementApplicationReason {
  const runIndex = aiAnalysisRunIndex(run);
  if (runIndex.failureByNodeId.has(nodeId)) {
    return "failed";
  }
  if (runIndex.deferredByNodeId.has(nodeId)) {
    return "deferred";
  }
  if (generated != null) {
    return "current_evaluation_not_adopted";
  }
  return "proof_unknown";
}

function aiAnalysisElementApplicationForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  element: AiAnalysisElement,
): AiAnalysisElementApplication {
  const candidate = planning.candidates[element];
  if (candidate.necessity === "not_required") {
    return Object.freeze({
      status: "not_required",
    });
  }

  const generated = generatedElementsForNode(run, analysis.item.nodeId)[element];
  const consumerResult =
    consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
  const reductionApplication = reduction?.ai.elements[element]?.application;
  const stateElement = isStateAnalysisElement(element);
  if (stateElement && run == null) {
    return Object.freeze({
      status: "disabled",
    });
  }
  if (stateElement) {
    switch (reductionApplication) {
      case "applied":
        break;
      case "preserved":
        if (reduction?.decision.origin !== "codex") {
          throw new TypeError(`保持AI判定が最終stateへ寄与していません。対象: ${element}`);
        }
        assertNonNullable(consumerResult, `保持AI判定の最終値がありません。対象: ${element}`);
        break;
      case "deterministic_fallback":
        if (reduction?.ai.status === "unavailable") {
          return Object.freeze({
            status: "unavailable",
            reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
          });
        }
        return Object.freeze({
          status: "deterministic_fallback",
        });
      case undefined:
        if (
          reduction?.ai.status === "unavailable" ||
          (reduction == null && generated == null && consumerResult == null)
        ) {
          return Object.freeze({
            status: "unavailable",
            reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
          });
        }
        return Object.freeze({
          status: "deterministic_fallback",
        });
      default:
        throw new UnreachableError(reductionApplication);
    }
  }
  if (reductionApplication === "deterministic_fallback") {
    return Object.freeze({
      status: "deterministic_fallback",
    });
  }

  const generatedWasConsumed = sameAiAnalysisElementResult(
    consumerResult,
    generated?.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema(element).parse(generated.result),
  );
  const generatedWasApplied =
    reductionApplication === "applied" || (!stateElement && generatedWasConsumed);
  if (generatedWasApplied) {
    assertNonNullable(generated, `適用されたAI生成要素がありません。対象: ${element}`);
    const runResult = aiAnalysisRunIndex(run).resultByNodeId.get(analysis.item.nodeId);
    const runElement = runResult?.elements.find((result) => result.element === element);
    assertNonNullable(runElement, `適用されたAI生成要素の実行記録がありません。対象: ${element}`);
    return Object.freeze({
      status: "current_ai",
      origin: runElement.origin,
    });
  }

  const verifiedSavedReuse = candidate.savedReuse;
  const savedReuseIsVerified =
    verifiedSavedReuse != null &&
    determineAnalysisElementReuse({
      element,
      inputFingerprint: candidate.inputFingerprint,
      inputProjectionVersion: candidate.inputProjectionVersion,
      dependencyFingerprint: candidate.dependencyFingerprint,
      savedProof: verifiedSavedReuse.proof,
    }) === "verified" &&
    sameAiAnalysisElementResult(consumerResult, verifiedSavedReuse.result);
  const verifiedCurrent = verifiedCurrentAdoptedResultForElement(
    state,
    analysis,
    element,
    candidate.inputFingerprint,
    candidate.savedReuse,
  );
  const verifiedMigration = verifiedMigrationAdoptedResultForElement(
    state,
    analysis,
    element,
    candidate.inputFingerprint,
    candidate.savedReuse,
  );
  if (
    savedReuseIsVerified ||
    sameAiAnalysisElementResult(consumerResult, verifiedCurrent) ||
    sameAiAnalysisElementResult(consumerResult, verifiedMigration)
  ) {
    return Object.freeze({
      status: "current_ai",
      origin: "verified_reuse",
    });
  }

  const currentAdopted = currentAdoptedElementForElement(state, analysis, element);
  const migrationAdopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[
    element
  ];
  const currentResult = currentAdopted?.result;
  const migrationResult =
    migrationAdopted?.origin === "migration" ? migrationAdopted.result : undefined;
  if (sameAiAnalysisElementResult(consumerResult, currentResult)) {
    return Object.freeze({
      status: "retained_ai",
      reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
    });
  }
  if (sameAiAnalysisElementResult(consumerResult, migrationResult)) {
    return Object.freeze({
      status: "unknown",
      reason: "migration",
    });
  }

  const deterministicResult = deterministicElementResult(analysis, element);
  if (sameAiAnalysisElementResult(consumerResult, deterministicResult)) {
    return Object.freeze({
      status: "deterministic_fallback",
    });
  }
  if (consumerResult == null) {
    if (run == null) {
      return Object.freeze({
        status: "disabled",
      });
    }
    return Object.freeze({
      status: "unavailable",
      reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
    });
  }
  if (
    candidate.savedReuse != null &&
    sameAiAnalysisElementResult(consumerResult, candidate.savedReuse.result)
  ) {
    throw new TypeError(`AI採用元の現行形式を特定できません。対象: ${element}`);
  }
  throw new TypeError(`AI判定要素の最終適用元を特定できません。対象: ${element}`);
}

function aiAnalysisElementApplicationsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
): TrackedItemAiAnalysisApplications {
  const applications: Partial<Record<AiAnalysisElement, AiAnalysisElementApplication>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    applications[element] = aiAnalysisElementApplicationForAnalysis(
      state,
      analysis,
      planning,
      run,
      reduction,
      consumerOutput,
      element,
    );
  }
  return Object.freeze(aiAnalysisElementApplicationsSchema.parse(applications));
}

function trackedItemAiAnalysis(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  codexAnalysis: CodexAnalysis,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
): TrackedItemAiAnalysis {
  const nodeId = analysis.item.nodeId;
  const generations = codexAnalysis.elementGenerationsByNodeId.get(nodeId);
  assertNonNullable(generations, `AI判定要素の保存結果がありません。対象: ${nodeId}`);
  const planning = codexAnalysis.elementPlanningByNodeId.get(nodeId);
  assertNonNullable(planning, `AI判定要素の計画がありません。対象: ${nodeId}`);
  const target = forcedAiAnalysisTarget(configuration);
  const run = codexAnalysis.run;
  const migratedElements = migratedElementsForAnalysis(
    state,
    analysis,
    planning,
    run,
    reduction,
    consumerOutput,
    target,
  );
  const adoptedElements = adoptedElementsForAnalysis(
    state,
    analysis,
    planning,
    run,
    migratedElements,
    reduction,
    consumerOutput,
    target,
  );
  const generatedElements = generatedElementsForNode(codexAnalysis.run, nodeId);
  const missingEvaluationElements = new Set<AiAnalysisElement>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (
      generatedElements[element] == null &&
      isForcedUnexecutedElement(analysis, element, target) &&
      planning.candidates[element].necessity === "required" &&
      savedEvaluationRecordForElement(state, nodeId, element) == null
    ) {
      missingEvaluationElements.add(element);
    }
  }
  const evaluationRecords = evaluationRecordsForAnalysis(
    state,
    analysis,
    planning,
    generations,
    run,
    adoptedElements,
    migratedElements,
    target,
  );
  const elements = evaluatedElementsForGenerations(
    generations,
    evaluationRecords,
    missingEvaluationElements,
  );
  const applications = aiAnalysisElementApplicationsForAnalysis(
    state,
    analysis,
    planning,
    run,
    reduction,
    consumerOutput,
  );
  let status: TrackedItemAiAnalysis["status"];
  if (run == null) {
    status = "disabled";
  } else {
    const runIndex = aiAnalysisRunIndex(run);
    const result = runIndex.resultByNodeId.get(nodeId);
    if (result != null) {
      status = "used";
    } else {
      const failure = runIndex.failureByNodeId.get(nodeId);
      if (failure != null) {
        status = "failed";
      } else {
        const deferred = runIndex.deferredByNodeId.get(nodeId);
        if (deferred != null) {
          status = "deferred";
        } else {
          const skipped = runIndex.skippedByNodeId.get(nodeId);
          assertNonNullable(skipped, `Codex分析候補の分類がありません。対象: ${nodeId}`);
          status = skipped.reason === "not_required" ? "not_required" : "used";
        }
      }
    }
  }
  if (Object.keys(migratedElements).length !== 0) {
    const reuseRecords = Object.freeze({
      ...adoptedRecordsForPlanning(planning),
      ...forcedMigrationReuseRecordsForAnalysis(state, analysis, planning, target),
    });
    return Object.freeze({
      origin: "migration",
      status,
      elements,
      adoptedElements: mixedAdoptedElementsForAnalysis(
        adoptedElements,
        migratedElements,
        reuseRecords,
      ),
      applications,
    });
  }
  return Object.freeze({
    origin: "current",
    status,
    elements,
    adoptedElements,
    applications,
  });
}

function trackedItemAiDependenciesForAnalysis(
  state: RuntimeState,
  item: FreshObservedGitHubItem,
  nodeId: GitHubNodeId,
  decision: ReducedCodexDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  staleness: StalenessResult,
  statusBasis: IssueStateDecision["statusBasis"],
  responsibilityBasis: IssueStateDecision["responsibilityBasis"],
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  aiAnalysis: TrackedItemAiAnalysis,
  downstreamImpactDependency: AiAnalysisDependency | undefined,
  blockersDependency: AiAnalysisDependency | undefined,
  blockerValueDependencies: BlockerValueAiDependencies | undefined,
  relationSetDependency: AiAnalysisDependency | undefined,
): TrackedItemAiDependencies {
  const applications = aiAnalysis.applications;
  const resolvedBlockerValueDependencies =
    blockerValueDependencies ?? unknownBlockerValueAiDependencies();
  const stateDependencies = stateAiDependencies(
    nodeId,
    applications,
    resolvedBlockerValueDependencies,
  );
  const previousItem = previousTrackedItem(state, nodeId);
  const resolvedDownstreamImpactDependency = downstreamImpactDependency ?? unrecordedAiDependency();
  const resolvedBlockersDependency = blockersDependency ?? unrecordedAiDependency();
  const resolvedRelationSetDependency = relationSetDependency ?? unrecordedAiDependency();
  const baseDependencies = {
    status: stateDependencies.status,
    waitingOn: stateDependencies.waitingOn,
    primaryWaitingOn: stateDependencies.primaryWaitingOn,
    nextAction: stateDependencies.nextAction,
    confidence: confidenceAiDependency(nodeId, applications, resolvedBlockerValueDependencies),
    evidence: evidenceAiDependency(
      nodeId,
      decision,
      deterministicDecision,
      applications,
      resolvedBlockerValueDependencies,
    ),
    uncertainties: uncertaintiesAiDependency(
      nodeId,
      applications,
      resolvedBlockerValueDependencies.uncertainties,
    ),
    deadline: aiDependencyForElementApplication(nodeId, applications, "deadline"),
    deadlineLevel: aiDependencyForElementApplication(nodeId, applications, "deadline"),
    lastProgressAt: lastProgressAiDependency(
      nodeId,
      item.createdAt,
      applications,
      staleness,
      previousItem,
    ),
    stallSince: notDependentAiDependency(),
    severity: notDependentAiDependency(),
    downstreamImpact: resolvedDownstreamImpactDependency,
    importance: aiDependencyForElementApplication(nodeId, applications, "importance"),
    attention: notDependentAiDependency(),
    blockers: resolvedBlockersDependency,
    relationSet: resolvedRelationSetDependency,
  } satisfies TrackedItemAiDependencies;
  const stallSince = stallSinceAiDependency(
    item,
    applications,
    sourceOccurredAtById,
    decision,
    staleness,
    baseDependencies,
    previousItem,
    statusBasis,
    responsibilityBasis,
    resolvedBlockerValueDependencies.transitionBasis,
  );
  const dependenciesWithStallSince = Object.freeze({
    ...baseDependencies,
    stallSince,
  });
  return Object.freeze({
    ...dependenciesWithStallSince,
    severity: severityAiDependency(
      decision,
      staleness,
      criticalSeverityWasRequested(staleness.severityReason),
      dependenciesWithStallSince,
    ),
  });
}

function createTrackedItem(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
  primaryWaitingOn: PrimaryWaitingOn,
  staleness: StalenessResult,
  aiAnalysis: TrackedItemAiAnalysis,
  downstreamImpactDependency: AiAnalysisDependency | undefined,
  blockersDependency: AiAnalysisDependency | undefined,
  blockerValueDependencies: BlockerValueAiDependencies | undefined,
  relationSetDependency: AiAnalysisDependency | undefined,
): PendingTrackedItem {
  const transitionBasis = transitionBasisForDecision(analysis, decision);
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
    personalReminderCauses: Object.freeze([]),
    personalReminderCausePlanning: isTerminalStatus(decision.status)
      ? Object.freeze({
          status: "excluded",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          reason: "terminal_without_cause",
        })
      : Object.freeze({
          status: "pending",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        }),
    aiAnalysis,
    aiDependencies: trackedItemAiDependenciesForAnalysis(
      state,
      analysis.item,
      analysis.item.nodeId,
      decision,
      analysis.decision,
      staleness,
      transitionBasis.statusBasis,
      transitionBasis.responsibilityBasis,
      sourceOccurredAtByIdForAnalysis(analysis),
      aiAnalysis,
      downstreamImpactDependency,
      blockersDependency,
      blockerValueDependencies,
      relationSetDependency,
    ),
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

type BlockedParentIndex = Readonly<{
  previousSeverityByNodeId: ReadonlyMap<string, Severity>;
  downstreamImpactByNodeId: ReadonlyMap<string, number>;
}>;

function createBlockedParentIndex(
  state: RuntimeState,
  graph: GraphResult | undefined,
): BlockedParentIndex {
  const previousSeverityByNodeId = new Map<string, Severity>(
    [...previousTrackedItemsByNodeId(state).values()].map((item) => [item.nodeId, item.severity]),
  );
  let downstreamImpacts: AnalyzeGraphResult["downstreamImpacts"];
  if (graph != null) {
    downstreamImpacts = graph.analysis.downstreamImpacts;
  } else {
    const previousGraph = previousGraphIndex(state);
    downstreamImpacts =
      previousGraph.availability === "available"
        ? previousGraph.analysis.downstreamImpacts
        : Object.freeze([]);
  }
  return Object.freeze({
    previousSeverityByNodeId,
    downstreamImpactByNodeId: new Map(
      downstreamImpacts.map((impact) => [impact.nodeId, impact.openNodeCount]),
    ),
  });
}

function blockedParentContext(
  decision: ReducedCodexDecision,
  index: BlockedParentIndex,
): BlockedParentContext {
  if (decision.status !== "waiting_for_unblock") {
    return Object.freeze({
      status: "not_applicable",
    });
  }
  const firstWaitingOn = decision.waitingOn[0];
  assertNonNullable(firstWaitingOn, "blocked項目にwaitingOnがありません");
  const createRanking = (waitingOn: ReducedCodexDecision["waitingOn"][number]): BlockerRanking =>
    Object.freeze({
      candidateId: waitingOn.candidateId,
      severity: index.previousSeverityByNodeId.get(waitingOn.candidateId) ?? "none",
      downstreamImpact: index.downstreamImpactByNodeId.get(waitingOn.candidateId) ?? 0,
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
    criticalSuppressed:
      staleness.severityReason.kind === "elapsed_threshold" &&
      staleness.severityReason.criticalSuppressed,
    criticalRequested: criticalSeverityWasRequested(staleness.severityReason),
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
  const highConfidenceSeverity =
    recalculated.severityReason.kind === "elapsed_threshold"
      ? recalculateStalenessSeverity({
          evaluatedAt,
          stallSince: item.stallSince,
          confidence: 1,
          minimumAiConfidence: configuration.config.ai.confidence.medium,
          repositoryFullName: repositoryFullName(repository),
          currentLabels: item.labels,
          resolveLabelEffects,
          thresholdsHours: configuration.config.staleness.thresholdsHours,
          severityContext: item.severityContext,
        }).severity
      : recalculated.severity;
  return Object.freeze({
    elapsedHours: recalculated.elapsedHours,
    severity: recalculated.severity,
    severityReason: recalculated.severityReason,
    criticalSuppressed:
      recalculated.severityReason.kind === "elapsed_threshold" &&
      recalculated.severity === "urgent" &&
      highConfidenceSeverity === "critical",
    criticalRequested:
      recalculated.severity === "critical" ||
      (recalculated.severity === "urgent" && highConfidenceSeverity === "critical"),
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

type SelfCommitmentPreviousObservation =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      observedAt: UtcIsoDateTime;
    }>;

type SelfCommitmentCauseInput = Readonly<{
  analysis: DeterministicItemAnalysis;
  selfCommitmentResult: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
  analysisInput: CodexAnalysisInput | undefined;
  previous: SelfCommitmentPreviousObservation;
  evaluatedAt: UtcIsoDateTime;
  highConfidence: number;
}>;

type SelfCommitmentCauseEvidence = Extract<
  NotificationCause,
  Readonly<{ status: "complete" }>
>["evidence"][number];

function createSelfCommitmentCause(input: SelfCommitmentCauseInput): NotificationCause {
  if (
    input.selfCommitmentResult == null ||
    effectiveElementConfidence("selfCommitment", input.selfCommitmentResult) <
      input.highConfidence ||
    input.analysisInput == null ||
    input.previous.availability !== "available"
  ) {
    return Object.freeze({ status: "indeterminate" });
  }
  const result = createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(
    input.selfCommitmentResult,
  );
  if (result.value.length === 0 || result.evidence.length === 0) {
    return Object.freeze({ status: "indeterminate" });
  }
  const candidateSourceIds = new Set(
    input.analysisInput.selfCommitmentCandidates.flatMap((candidate) => candidate.sourceIds),
  );
  const valueSourceIds = new Set<string>();
  const evidenceBySourceId = new Map<SourceId, SelfCommitmentCauseEvidence>();
  for (const commitment of result.value) {
    if (valueSourceIds.has(commitment.sourceId) || !candidateSourceIds.has(commitment.sourceId)) {
      return Object.freeze({ status: "indeterminate" });
    }
    valueSourceIds.add(commitment.sourceId);
    const sourceEvidence = result.evidence.filter(
      (evidence) =>
        evidence.sourceId === commitment.sourceId && evidence.supports === "self_commitment",
    );
    if (sourceEvidence.length !== 1) {
      return Object.freeze({ status: "indeterminate" });
    }
    const sourceEvidenceEntry = sourceEvidence[0];
    assertNonNullable(sourceEvidenceEntry, "self_commitmentの根拠がありません");
    const source = input.analysisInput.sources.find(
      (candidate) => candidate.id === sourceEvidenceEntry.sourceId,
    );
    if (source?.kind !== "comment") {
      return Object.freeze({ status: "indeterminate" });
    }
    if (source.actorType !== "human") {
      return Object.freeze({ status: "indeterminate" });
    }
    if (source.author.status !== "identified") {
      return Object.freeze({ status: "indeterminate" });
    }
    const sourceAuthor = source.author;
    if (
      !input.analysisInput.selfCommitmentCandidates.some(
        (candidate) =>
          candidate.id === sourceAuthor.candidateId && candidate.sourceIds.includes(source.id),
      )
    ) {
      return Object.freeze({ status: "indeterminate" });
    }
    const comment = codexCommentSources(input.analysis.detail).find(
      (candidate) => candidate.sourceId === source.id,
    );
    if (
      comment?.author.status !== "identified" ||
      comment.author.account.login !== source.author.candidateId ||
      comment.author.account.nodeId !== source.author.nodeId ||
      comment.updatedAt !== comment.createdAt ||
      source.createdAt !== comment.createdAt
    ) {
      return Object.freeze({ status: "indeterminate" });
    }
    const event = input.analysis.item.events.find((candidate) => candidate.sourceId === source.id);
    if (
      event?.kind !== "comment" ||
      event.actor.type !== "human" ||
      event.actor.nodeId !== source.author.nodeId ||
      event.occurredAt !== source.createdAt ||
      event.occurredAt <= input.previous.observedAt ||
      event.occurredAt > input.evaluatedAt
    ) {
      return Object.freeze({ status: "indeterminate" });
    }
    const actor: SelfCommitmentCauseEvidence["actor"] = Object.freeze({
      type: "human",
      nodeId: event.actor.nodeId,
      login: comment.author.account.login,
    });
    evidenceBySourceId.set(
      event.sourceId,
      Object.freeze({
        sourceId: event.sourceId,
        occurredAt: event.occurredAt,
        actor,
      }),
    );
  }
  if (evidenceBySourceId.size !== result.evidence.length) {
    return Object.freeze({ status: "indeterminate" });
  }
  const evidence = [...evidenceBySourceId.values()].sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return left.sourceId.localeCompare(right.sourceId);
  });
  const firstEvidence = evidence[0];
  assertNonNullable(
    firstEvidence,
    `self_commitmentの根拠がありません。対象: ${input.analysis.item.nodeId}`,
  );
  if (evidence.some((candidate) => candidate.actor.nodeId !== firstEvidence.actor.nodeId)) {
    return Object.freeze({ status: "indeterminate" });
  }
  const causeEvidence = Object.freeze([firstEvidence, ...evidence.slice(1)] satisfies [
    SelfCommitmentCauseEvidence,
    ...SelfCommitmentCauseEvidence[],
  ]);
  return Object.freeze({
    status: "complete",
    responsible: firstEvidence.actor,
    evidence: causeEvidence,
  });
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
  const target = forcedAiAnalysisTarget(configuration);
  const downstreamImpactDependenciesByNodeId =
    graph == null ? undefined : downstreamImpactAiDependenciesByNodeId(graph);
  const blockersDependenciesByNodeId =
    graph == null ? undefined : blockersAiDependenciesByNodeId(graph);
  const blockerNodeDependenciesByBlockedNodeId =
    graph == null ? undefined : blockerNodeAiDependenciesByBlockedNodeId(graph);
  const negativeBlockerDependenciesByNodeId =
    graph == null
      ? undefined
      : graphAiDependenciesByNodeId(graph.negativeBlockerAiDependencies, "negative blocker AI依存");
  const relationSetDependenciesByNodeId =
    graph == null
      ? undefined
      : graphAiDependenciesByNodeId(graph.relationSetAiDependencies, "relation集合AI依存");
  const dependencyResolutionStaticIndexes =
    graph == null || graph.analysis.newlyUnblockedNodeIds.length === 0
      ? undefined
      : createDependencyResolutionStaticIndexes(state, collection, graph);
  const graphBlockerIndex = graph == null ? undefined : createGraphBlockerIndex(graph);
  const blockedParentIndex = createBlockedParentIndex(state, graph);
  const currentItems: ReducedItemAnalysis[] = [];
  const items: PendingTrackedItem[] = [];
  const stalenessByNodeId = new Map<GitHubNodeId, TrackedItemStaleness>();
  const relationAssessments: RelationCandidateAssessment[] = [];
  const retainedNotificationRecommendations = new Map<
    GitHubNodeId,
    DiscordNotificationItem["notificationRecommendation"]
  >();
  let runStatus: ReducedAnalysis["runStatus"] = "success";
  for (const originalAnalysis of deterministicAnalysis.items) {
    const output = codexOutputForConsumers(configuration, state, originalAnalysis, codexAnalysis);
    const analysis = reassessDeterministicAnalysis(
      collection.evaluatedAt,
      configuration,
      inventory,
      originalAnalysis,
      output,
      graphBlockerIndex,
    );
    const reduction = reductionForAnalysis(configuration, state, analysis, codexAnalysis);
    const planning = codexAnalysis.elementPlanningByNodeId.get(analysis.item.nodeId);
    assertNonNullable(planning, `AI判定要素の計画がありません。対象: ${analysis.item.nodeId}`);
    const relationNotificationReduction =
      reduction ??
      reducePreservedCodexRelationsAndNotification(
        analysis.item.nodeId,
        preservedElementsForAnalysisReduction(state, analysis, codexAnalysis, target),
        configuration.config.ai.confidence,
      );
    const relationAssessmentsForAnalysis = relationNotificationReduction.relationAssessments;
    const notificationRecommendation = relationNotificationReduction.notification;
    const decision = reduction?.decision ?? reducedDeterministicDecision(analysis.decision);
    if (reduction?.ai.status === "unavailable") {
      runStatus = "fallback";
    }
    relationAssessments.push(...relationAssessmentsForAnalysis);
    const basis = transitionBasisForDecision(analysis, decision);
    const repository = findRepository(inventory, analysis.item.repositoryId);
    const aiAnalysis = trackedItemAiAnalysis(
      configuration,
      state,
      analysis,
      codexAnalysis,
      reduction,
      output,
    );
    const primaryWaitingOn = primaryWaitingOnForDecision(
      analysis.decision,
      decision,
      aiAnalysis.applications.waitingOn,
    );
    const dependencyResolution = dependencyResolutions(
      collection,
      graph,
      dependencyResolutionStaticIndexes,
      relationAssessmentsForAnalysis,
      analysis,
    );
    const previousItem = previousTrackedItem(state, analysis.item.nodeId);
    const selfCommitmentCause = createSelfCommitmentCause({
      analysis,
      selfCommitmentResult: output?.selfCommitment,
      analysisInput: codexAnalysis.inputByNodeId.get(analysis.item.nodeId),
      previous:
        previousItem == null
          ? Object.freeze({
              availability: "not_available",
            })
          : Object.freeze({
              availability: "available",
              observedAt: previousItem.observedAt,
            }),
      evaluatedAt: collection.evaluatedAt,
      highConfidence: configuration.config.ai.confidence.high,
    });
    const staleness = calculateStaleness({
      itemType: analysis.item.type,
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
      dependencyResolutions: dependencyResolution.progress,
      naturalLanguageAssessments: naturalLanguageProgressAssessments(analysis, output),
      minimumAiConfidence: configuration.config.ai.confidence.medium,
      repositoryFullName: repositoryFullName(repository),
      currentLabels: analysis.item.labels,
      resolveLabelEffects,
      thresholdsHours: configuration.config.staleness.thresholdsHours,
      blockedParentContext: blockedParentContext(decision, blockedParentIndex),
    });
    const downstreamImpactDependency =
      graph == null
        ? undefined
        : graphAiDependencyForNode(
            downstreamImpactDependenciesByNodeId,
            analysis.item.nodeId,
            "downstream impact",
          );
    const blockersDependency =
      graph == null
        ? undefined
        : graphAiDependencyForNode(blockersDependenciesByNodeId, analysis.item.nodeId, "blocker");
    let blockerValueDependencies: BlockerValueAiDependencies;
    if (graph == null) {
      blockerValueDependencies = unknownBlockerValueAiDependencies();
    } else {
      assertNonNullable(
        blockerNodeDependenciesByBlockedNodeId,
        "blocker node AI依存indexがありません",
      );
      assertNonNullable(
        negativeBlockerDependenciesByNodeId,
        "negative blocker AI依存indexがありません",
      );
      blockerValueDependencies = blockerValueAiDependencies(
        analysis.item.nodeId,
        analysis.decision.blockerDecisionTrace,
        blockerNodeDependenciesByBlockedNodeId,
        negativeBlockerDependenciesByNodeId,
      );
    }
    const relationSetDependency =
      graph == null
        ? undefined
        : graphAiDependencyForNode(
            relationSetDependenciesByNodeId,
            analysis.item.nodeId,
            "relation集合",
          );
    currentItems.push(
      Object.freeze({
        item: analysis.item,
        detail: analysis.detail,
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates,
        decision,
        blockerValueAiDependencies: blockerValueDependencies,
        localResponsibilityDecision: analysis.localResponsibilityDecision,
        aiAnalysisApplications: aiAnalysis.applications,
        selfCommitmentCause,
        statusBasis: basis.statusBasis,
        responsibilityBasis: basis.responsibilityBasis,
        dependencyCause: dependencyResolution.cause,
        notificationRecommendation:
          notificationRecommendation == null
            ? Object.freeze({
                availability: "not_available",
              })
            : Object.freeze({
                availability: "available",
                value: notificationRecommendation,
              }),
        primaryWaitingOn,
        staleness,
        importanceAssessment: resolveImportanceAssessment(
          reduction?.importanceAssessment,
          currentAdoptedImportanceAssessment(
            state,
            analysis,
            planning.candidates.importance.savedReuse?.result,
            planning,
            target,
          ),
        ),
        deadlineAssessment: resolveDeadlineAssessment(
          reduction?.deadlineAssessment,
          currentAdoptedDeadlineAssessment(
            state,
            analysis,
            planning.candidates.deadline.savedReuse?.result,
            planning,
            target,
          ),
        ),
      }),
    );
    stalenessByNodeId.set(analysis.item.nodeId, trackedItemStaleness(staleness));
    items.push(
      createTrackedItem(
        state,
        analysis,
        decision,
        primaryWaitingOn,
        staleness,
        aiAnalysis,
        downstreamImpactDependency,
        blockersDependency,
        blockerValueDependencies,
        relationSetDependency,
      ),
    );
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
      const preservedElements = preservedElementsWithCompatibleRelations(
        preservedElementsForRetainedItem(previousItem),
        undefined,
      );
      const preservedReduction = reducePreservedCodexRelationsAndNotification(
        previousItem.nodeId,
        preservedElements,
        configuration.config.ai.confidence,
      );
      relationAssessments.push(...preservedReduction.relationAssessments);
      if (preservedReduction.notification != null) {
        retainedNotificationRecommendations.set(
          previousItem.nodeId,
          Object.freeze({
            availability: "available",
            value: preservedReduction.notification,
          }),
        );
      }
    }
  }
  if (stalenessByNodeId.size !== items.length) {
    throw new TypeError("全追跡項目のseverityを再計算できませんでした");
  }
  const dependencyContext =
    graph == null
      ? undefined
      : aiDependencyReconciliationContext(items, collection.relationCandidates, graph);
  const normalizedItems = items.map((item) => {
    if (dependencyContext == null || currentNodeIds.has(item.nodeId)) {
      return item;
    }
    return Object.freeze({
      ...item,
      aiDependencies: Object.freeze(
        trackedItemAiDependenciesSchema.parse(
          Object.fromEntries(
            AI_ANALYSIS_DEPENDENCY_ELEMENTS.map((element) => [
              element,
              item.aiDependencies[element].status !== "not_dependent" &&
              item.aiDependencies[element].producers?.some(
                (producer) => producer.kind === "relation_candidate",
              ) === true
                ? reconcileRetainedAiAnalysisDependency(
                    item.aiDependencies[element],
                    dependencyContext,
                  )
                : item.aiDependencies[element],
            ]),
          ),
        ),
      ),
    });
  });
  return Object.freeze({
    items: Object.freeze(normalizedItems),
    currentItems: Object.freeze(currentItems),
    stalenessByNodeId,
    relationAssessments: Object.freeze(relationAssessments),
    retainedNotificationRecommendations,
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

function graphAnalysisStateForEnumeratedItem(item: EnumeratedGitHubItem): TrackedItemState {
  if (item.state === "open") {
    return "open";
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return "merged";
  }
  return "closed";
}

function candidateOnlyGraphAnalysisNode(item: EnumeratedGitHubItem): GraphAnalysisNode {
  return Object.freeze({
    kind: item.type,
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    state: graphAnalysisStateForEnumeratedItem(item),
    directNotification: "not_eligible",
  });
}

function currentNativeCandidateStateByStaleNodeId(
  candidates: readonly RelationCandidate[],
  staleNodeIds: ReadonlySet<GitHubNodeId>,
): ReadonlyMap<GitHubNodeId, TrackedItemState> {
  const stateByNodeId = new Map<GitHubNodeId, TrackedItemState>();
  for (const candidate of candidates) {
    if (candidate.provenance !== "native") {
      continue;
    }
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope !== "organization" || !staleNodeIds.has(node.nodeId)) {
        continue;
      }
      const existing = stateByNodeId.get(node.nodeId);
      if (existing != null && existing !== node.state) {
        throw new TypeError(
          `native関係候補のstale endpoint状態が一致しません。対象: ${node.nodeId}`,
        );
      }
      stateByNodeId.set(node.nodeId, node.state);
    }
  }
  return stateByNodeId;
}

function graphAnalysisNodeWithEffectiveState(
  item: PendingTrackedItem,
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
): GraphAnalysisNode {
  const node = graphAnalysisNode(item);
  const currentState = stateByNodeId.get(item.nodeId);
  assertNonNullable(
    currentState,
    `追跡項目のeffective graph状態がありません。対象: ${item.nodeId}`,
  );
  return Object.freeze({
    ...node,
    state: currentState,
  });
}

type CurrentEffectiveGraphState = Readonly<{
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
  observations: readonly SnapshotGraphNodeStateObservation[];
  currentNativeStateObservations: readonly SnapshotGraphNodeStateObservation[];
}>;

function currentEffectiveGraphState(
  state: RuntimeState,
  items: readonly PendingTrackedItem[],
  externalReferences: readonly ExternalGhostNode[],
  candidates: readonly RelationCandidate[],
  staleNodeIds: ReadonlySet<GitHubNodeId>,
  observedAt: UtcIsoDateTime,
): CurrentEffectiveGraphState {
  const currentNativeStates = currentNativeCandidateStateByStaleNodeId(candidates, staleNodeIds);
  const previousObservationsByNodeId = new Map(
    (previousSnapshot(state)?.graphNodeStateObservations ?? []).map((observation) => [
      observation.nodeId,
      observation,
    ]),
  );
  const stateByNodeId = new Map<GraphNodeId, TrackedItemState>();
  const observations: SnapshotGraphNodeStateObservation[] = [];
  const currentNativeStateObservations: SnapshotGraphNodeStateObservation[] = [];
  for (const item of items) {
    let effectiveState = item.state;
    let effectiveObservedAt: UtcIsoDateTime | undefined;
    if (staleNodeIds.has(item.nodeId)) {
      const currentNativeState = currentNativeStates.get(item.nodeId);
      const previousObservation = previousObservationsByNodeId.get(item.nodeId);
      if (currentNativeState != null) {
        effectiveState = currentNativeState;
        effectiveObservedAt = observedAt;
        currentNativeStateObservations.push(
          Object.freeze({
            nodeId: item.nodeId,
            state: currentNativeState,
            observedAt,
          }),
        );
      } else if (previousObservation != null) {
        effectiveState = previousObservation.state;
        effectiveObservedAt = previousObservation.observedAt;
      }
    }
    if (item.type === "issue" && effectiveState === "merged") {
      throw new TypeError(`Issueのeffective graph状態をmergedにはできません。対象: ${item.nodeId}`);
    }
    stateByNodeId.set(item.nodeId, effectiveState);
    if (effectiveState === item.state) {
      continue;
    }
    assertNonNullable(
      effectiveObservedAt,
      `item状態と異なるeffective graph状態の観測時刻がありません。対象: ${item.nodeId}`,
    );
    observations.push(
      Object.freeze({
        nodeId: item.nodeId,
        state: effectiveState,
        observedAt: effectiveObservedAt,
      }),
    );
  }
  for (const reference of externalReferences) {
    stateByNodeId.set(reference.nodeId, reference.state);
  }
  return Object.freeze({
    stateByNodeId,
    observations: Object.freeze(
      observations.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    ),
    currentNativeStateObservations: Object.freeze(
      currentNativeStateObservations.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    ),
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
    aiDependency: relation.aiDependency,
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
  const effectiveStateByNodeId = snapshotEffectiveGraphStateByNodeId(snapshot);
  return Object.freeze({
    nodes: Object.freeze([
      ...snapshot.items.map((item) =>
        graphAnalysisNodeWithEffectiveState(item, effectiveStateByNodeId),
      ),
      ...snapshot.externalReferences.map(externalGraphAnalysisNode),
    ]),
    edges: Object.freeze(snapshot.relations.map(previousGraphEdge)),
  });
}

type AvailablePreviousGraphIndex = Readonly<{
  availability: "available";
  snapshot: GraphAnalysisSnapshot;
  analysis: AnalyzeGraphResult;
  downstreamImpactByNodeId: ReadonlyMap<
    GraphNodeId,
    AnalyzeGraphResult["downstreamImpacts"][number]
  >;
}>;

type PreviousGraphIndex =
  | Readonly<{
      availability: "unavailable";
    }>
  | AvailablePreviousGraphIndex;

const UNAVAILABLE_PREVIOUS_GRAPH_INDEX: PreviousGraphIndex = Object.freeze({
  availability: "unavailable",
});
const previousGraphIndexBySnapshot = new WeakMap<StateSnapshot, AvailablePreviousGraphIndex>();

function previousGraphIndex(state: RuntimeState): PreviousGraphIndex {
  const stateSnapshot = previousSnapshot(state);
  if (stateSnapshot == null) {
    return UNAVAILABLE_PREVIOUS_GRAPH_INDEX;
  }
  const cached = previousGraphIndexBySnapshot.get(stateSnapshot);
  if (cached != null) {
    return cached;
  }
  const snapshot = previousGraphSnapshot(state);
  assertNonNullable(snapshot, "前回snapshotからgraphを復元できませんでした");
  const analysis = analyzeGraph({
    current: snapshot,
    previous: {
      availability: "unavailable",
    },
  });
  const index: AvailablePreviousGraphIndex = Object.freeze({
    availability: "available",
    snapshot,
    analysis,
    downstreamImpactByNodeId: new Map(
      analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
    ),
  });
  previousGraphIndexBySnapshot.set(stateSnapshot, index);
  return index;
}

function preservedRelationSourceProducers(
  edge: ReconciledGraphEdge,
): readonly AiAnalysisDependencyProducer[] | undefined {
  if (edge.aiDependency.status === "not_dependent") {
    throw new TypeError(`推定edge ${edge.id}のAI依存がありません`);
  }
  const producers = edge.aiDependency.producers;
  if (producers == null) {
    return undefined;
  }
  return Object.freeze(
    producers.map((producer) => {
      if (
        producer.kind !== "relation" ||
        producer.relationId !== edge.id ||
        producer.producer.element !== "relations"
      ) {
        throw new TypeError(`推定edge ${edge.id}の保存済みproducerが不正です`);
      }
      return Object.freeze({
        kind: "item_element",
        nodeId: producer.producer.nodeId,
        element: "relations",
      }) satisfies AiAnalysisDependencyProducer;
    }),
  );
}

function downgradedPreservedRelationDependency(
  edge: ReconciledGraphEdge,
  currentDependency: AiAnalysisDependency | undefined,
  fallbackProducer: AiAnalysisDependencyProducer | undefined,
): AiAnalysisDependency | undefined {
  if (
    currentDependency?.status === "unknown" &&
    currentDependency.reasons.every(
      (reason) => reason === "proof_unknown" || reason === "migration",
    ) &&
    currentDependency.producers != null
  ) {
    return currentDependency;
  }
  const currentProducers =
    currentDependency != null && currentDependency.status !== "not_dependent"
      ? currentDependency.producers
      : undefined;
  const producers =
    currentProducers ??
    preservedRelationSourceProducers(edge) ??
    (fallbackProducer == null ? undefined : Object.freeze([fallbackProducer]));
  if (producers == null) {
    return undefined;
  }
  const proofUnknown: AiAnalysisDependency = Object.freeze({
    status: "unknown",
    reasons: Object.freeze(["proof_unknown"]),
    producers,
  } satisfies AiAnalysisDependency);
  return currentDependency?.status === "unknown" && currentDependency.reasons.includes("migration")
    ? combineAiAnalysisDependencies([
        proofUnknown,
        Object.freeze({
          status: "unknown",
          reasons: Object.freeze(["migration"]),
        } satisfies AiAnalysisDependency),
      ])
    : normalizeAiAnalysisDependency(proofUnknown);
}

function activeProofForPreservedEdge(
  proof: RelationCandidateDecisionProof,
  edge: ReconciledGraphEdge,
  dependency: AiAnalysisDependency,
): RelationCandidateDecisionProof {
  return Object.freeze({
    candidateId: proof.candidateId,
    endpointNodeIds: proof.endpointNodeIds,
    authority: proof.authority,
    resolution: Object.freeze({
      candidateId: proof.candidateId,
      status: "active",
      edgeId: proof.candidateId,
    }),
    dependency,
    canonicalRelation: Object.freeze({
      type: edge.type,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
    }),
  });
}

function pendingProofForPreservedInactiveEdge(
  proof: RelationCandidateDecisionProof,
  dependency: AiAnalysisDependency,
): RelationCandidateDecisionProof {
  return Object.freeze({
    candidateId: proof.candidateId,
    endpointNodeIds: proof.endpointNodeIds,
    authority: proof.authority,
    resolution: Object.freeze({
      candidateId: proof.candidateId,
      status: "pending",
      reason: "assessment_missing",
    }),
    dependency,
  });
}

type NativeRelationSourceObservation =
  "unavailable" | "eligible_present" | "ineligible_present" | "absent";

type NativeRelationEndpointSelection = Readonly<{
  organizationOwners: ReadonlySet<string>;
  selectedRepositoryIds: ReadonlySet<GitHubRepositoryId>;
}>;

function nativeRelationEndpointSelection(
  collection: CollectedItems,
): NativeRelationEndpointSelection {
  return Object.freeze({
    organizationOwners: new Set(
      collection.repositoryResults.map((result) => result.repository.owner.toLowerCase()),
    ),
    selectedRepositoryIds: new Set(
      collection.repositoryResults.map((result) => result.repository.id),
    ),
  });
}

function nativeRelatedItemIsEligible(
  item: GitHubReferencedItem,
  selection: NativeRelationEndpointSelection,
): boolean {
  if (item.repositoryArchived || item.repositoryDisabled) {
    return false;
  }
  return (
    !selection.organizationOwners.has(item.repositoryOwner.toLowerCase()) ||
    selection.selectedRepositoryIds.has(item.repositoryId)
  );
}

function nativeRelatedItemMatchesGraphNodeId(
  relatedNodeId: GitHubNodeId,
  graphNodeId: GraphNodeId,
): boolean {
  return (
    graphNodeId === relatedNodeId ||
    graphNodeId === createExternalReferenceNodeId(`external:github:${relatedNodeId}`)
  );
}

function nativeRelatedItemsSourceObservation(
  relatedItems: readonly GitHubReferencedItem[],
  relatedNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  const matchingItems = relatedItems.filter((item) =>
    nativeRelatedItemMatchesGraphNodeId(item.nodeId, relatedNodeId),
  );
  if (matchingItems.length === 0) {
    return "absent";
  }
  const eligibility = new Set(
    matchingItems.map((item) => nativeRelatedItemIsEligible(item, selection)),
  );
  if (eligibility.size !== 1) {
    throw new TypeError(`native関係先の収集対象判定が一致しません。対象: ${relatedNodeId}`);
  }
  return eligibility.has(true) ? "eligible_present" : "ineligible_present";
}

function nativeIssueDependencySourceObservation(
  detail: GitHubItemDetail | undefined,
  direction: "blocked_by" | "blocking",
  relatedNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "issue" || detail.nativeDependencies.availability !== "available") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.nativeDependencies.relations
      .filter((relation) => relation.direction === direction)
      .map((relation) => relation.relatedItem),
    relatedNodeId,
    selection,
  );
}

function nativeIssueHierarchySourceObservation(
  detail: GitHubItemDetail | undefined,
  relationship: "parent" | "sub_issue",
  relatedNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "issue" || detail.nativeHierarchy.availability !== "available") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.nativeHierarchy.relations
      .filter((relation) => relation.relationship === relationship)
      .map((relation) => relation.relatedItem),
    relatedNodeId,
    selection,
  );
}

function nativeClosingIssueSourceObservation(
  detail: GitHubItemDetail | undefined,
  targetNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "pull_request") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.nativeClosingIssues.map((relation) => relation.relatedItem),
    targetNodeId,
    selection,
  );
}

function nativeInboundImplementationSourceObservation(
  detail: GitHubItemDetail | undefined,
  implementationNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "issue") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.inboundCrossReferences
      .filter((reference) => reference.willCloseTarget)
      .map((reference) => reference.sourceItem),
    implementationNodeId,
    selection,
  );
}

function nativeRelationSourcesProveAbsence(
  observations: readonly NativeRelationSourceObservation[],
): boolean {
  return (
    observations.includes("absent") &&
    !observations.includes("eligible_present") &&
    !observations.includes("ineligible_present")
  );
}

function nativeRelationSourcesProveIneligibility(
  observations: readonly NativeRelationSourceObservation[],
): boolean {
  if (observations.includes("eligible_present") && observations.includes("ineligible_present")) {
    throw new TypeError("native関係先の収集対象判定がauthority間で一致しません");
  }
  return observations.includes("ineligible_present");
}

function nativeRelationSourceObservations(
  edge: ReconciledGraphEdge,
  detailsByNodeId: ReadonlyMap<GraphNodeId, GitHubItemDetail>,
  selection: NativeRelationEndpointSelection,
): readonly NativeRelationSourceObservation[] {
  if (edge.provenance !== "native") {
    throw new TypeError(`native relation欠落証明の対象 ${edge.id}がnativeではありません`);
  }
  switch (edge.type) {
    case "blocks":
      return Object.freeze([
        nativeIssueDependencySourceObservation(
          detailsByNodeId.get(edge.fromNodeId),
          "blocking",
          edge.toNodeId,
          selection,
        ),
        nativeIssueDependencySourceObservation(
          detailsByNodeId.get(edge.toNodeId),
          "blocked_by",
          edge.fromNodeId,
          selection,
        ),
      ]);
    case "parent_of":
      return Object.freeze([
        nativeIssueHierarchySourceObservation(
          detailsByNodeId.get(edge.fromNodeId),
          "sub_issue",
          edge.toNodeId,
          selection,
        ),
        nativeIssueHierarchySourceObservation(
          detailsByNodeId.get(edge.toNodeId),
          "parent",
          edge.fromNodeId,
          selection,
        ),
      ]);
    case "implements":
      return Object.freeze([
        nativeClosingIssueSourceObservation(
          detailsByNodeId.get(edge.fromNodeId),
          edge.toNodeId,
          selection,
        ),
        nativeInboundImplementationSourceObservation(
          detailsByNodeId.get(edge.toNodeId),
          edge.fromNodeId,
          selection,
        ),
      ]);
    case "related_to":
    case "duplicates":
      throw new TypeError(`native relation ${edge.id}の種別 ${edge.type}が不正です`);
  }
}

function relationCandidateNodeGitHubNodeId(node: RelationCandidateNode): GitHubNodeId {
  return node.scope === "organization" ? node.nodeId : node.githubNodeId;
}

function nativeRelationCandidateMatchesEdgeIdentity(
  candidate: Extract<RelationCandidate, { provenance: "native" }>,
  edge: ReconciledGraphEdge,
): boolean {
  switch (candidate.relation.type) {
    case "blocks":
      return (
        edge.type === "blocks" &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.blocker),
          edge.fromNodeId,
        ) &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.blocked),
          edge.toNodeId,
        )
      );
    case "parent_of":
      return (
        edge.type === "parent_of" &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.parent),
          edge.fromNodeId,
        ) &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.subtask),
          edge.toNodeId,
        )
      );
    case "implements":
      return (
        edge.type === "implements" &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.implementation),
          edge.fromNodeId,
        ) &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.target),
          edge.toNodeId,
        )
      );
  }
}

function obsoleteNativeEdgeIds(
  collection: CollectedItems,
  previousEdges: readonly ReconciledGraphEdge[],
  candidates: readonly RelationCandidate[],
  detailsByNodeId: ReadonlyMap<GraphNodeId, GitHubItemDetail>,
): ReadonlySet<RelationCandidateId> {
  const selection = nativeRelationEndpointSelection(collection);
  const nativeCandidates = candidates.filter(
    (candidate): candidate is Extract<RelationCandidate, { provenance: "native" }> =>
      candidate.provenance === "native",
  );
  const edgeIds = new Set<RelationCandidateId>();
  for (const edge of previousEdges) {
    if (edge.provenance !== "native") {
      continue;
    }
    if (
      nativeCandidates.some(
        (candidate) =>
          candidate.id !== edge.id && nativeRelationCandidateMatchesEdgeIdentity(candidate, edge),
      ) ||
      nativeRelationSourcesProveIneligibility(
        nativeRelationSourceObservations(edge, detailsByNodeId, selection),
      )
    ) {
      edgeIds.add(edge.id);
    }
  }
  return edgeIds;
}

function preserveUnverifiedGraphEdges(
  collection: CollectedItems,
  previousEdges: readonly ReconciledGraphEdge[],
  reconciledEdges: readonly ReconciledGraphEdge[],
  candidates: readonly RelationCandidate[],
  candidateDecisionProofs: readonly RelationCandidateDecisionProof[],
): Readonly<{
  edges: readonly ReconciledGraphEdge[];
  relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
  candidateResolutions: readonly RelationCandidateResolution[];
  candidateDecisionProofs: readonly RelationCandidateDecisionProof[];
}> {
  const staleNodeIds = new Set<string>(collection.staleItems.map((item) => item.nodeId));
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const detailsByNodeId = new Map<GraphNodeId, GitHubItemDetail>(
    collection.details.map((detail) => [detail.nodeId, detail]),
  );
  const selection = nativeRelationEndpointSelection(collection);
  const obsoleteEdgeIds = obsoleteNativeEdgeIds(
    collection,
    previousEdges,
    candidates,
    detailsByNodeId,
  );
  const preservedEdges = new Map(
    previousEdges
      .filter((edge) => {
        if (obsoleteEdgeIds.has(edge.id)) {
          return false;
        }
        if (edge.provenance !== "native") {
          return staleNodeIds.has(edge.fromNodeId) || staleNodeIds.has(edge.toNodeId);
        }
        if (candidatesById.has(edge.id)) {
          return false;
        }
        return !nativeRelationSourcesProveAbsence(
          nativeRelationSourceObservations(edge, detailsByNodeId, selection),
        );
      })
      .map((edge) => [edge.id, edge]),
  );
  const proofsByCandidateId = new Map(
    candidateDecisionProofs.map((proof) => [proof.candidateId, proof]),
  );
  const preservedSourceDependencies = new Map<RelationCandidateId, AiAnalysisDependency>();
  const result = reconciledEdges
    .filter((edge) => !obsoleteEdgeIds.has(edge.id))
    .map((edge) => {
      const preserved = preservedEdges.get(edge.id);
      if (preserved == null) {
        return edge;
      }
      if (preserved.provenance === "native") {
        return preserved;
      }
      const proof = proofsByCandidateId.get(preserved.id);
      const candidate = candidatesById.get(preserved.id);
      const candidateNodes: readonly RelationCandidateNode[] =
        candidate == null ? Object.freeze([]) : relationNodes(candidate.relation);
      const assessmentOwnerNodeId =
        candidate == null ? undefined : relationAssessmentOwnerNodeId(candidate);
      const assessmentOwner =
        candidate == null
          ? undefined
          : candidateNodes.find((node) => node.nodeId === assessmentOwnerNodeId);
      if (candidate != null) {
        assertNonNullable(
          assessmentOwner,
          `関係候補 ${candidate.id}のAI判定owner nodeがありません`,
        );
      }
      const organizationCandidateNodes = candidateNodes.filter(isOrganizationRelationCandidateNode);
      const fallbackProducerNode =
        organizationCandidateNodes.find((node) => node.nodeId === assessmentOwnerNodeId) ??
        organizationCandidateNodes[0];
      if (candidate != null) {
        assertNonNullable(
          fallbackProducerNode,
          `関係候補 ${candidate.id}のOrganization側nodeがありません`,
        );
      }
      const fallbackProducer =
        fallbackProducerNode == null
          ? undefined
          : Object.freeze({
              kind: "item_element",
              nodeId: fallbackProducerNode.nodeId,
              element: "relations",
            } satisfies AiAnalysisDependencyProducer);
      if (!preserved.active) {
        if (!edge.active) {
          return preserved;
        }
        const sourceDependency = downgradedPreservedRelationDependency(
          preserved,
          proof?.dependency,
          fallbackProducer,
        );
        if (sourceDependency == null) {
          return preserved;
        }
        preservedSourceDependencies.set(preserved.id, sourceDependency);
        return Object.freeze({
          ...preserved,
          aiDependency: aiAnalysisDependencyForRelation(preserved.id, sourceDependency),
        });
      }
      const sourceDependency = downgradedPreservedRelationDependency(
        preserved,
        proof?.dependency,
        fallbackProducer,
      );
      if (sourceDependency == null) {
        return preserved;
      }
      preservedSourceDependencies.set(preserved.id, sourceDependency);
      return Object.freeze({
        ...preserved,
        aiDependency: aiAnalysisDependencyForRelation(preserved.id, sourceDependency),
      });
    });
  const resultIds = new Set(result.map((edge) => edge.id));
  for (const edgeId of preservedEdges.keys()) {
    if (!resultIds.has(edgeId)) {
      throw new TypeError(`保持すべき前回edgeがありません。対象: ${edgeId}`);
    }
  }
  const normalizedCandidateDecisionProofs = candidateDecisionProofs.map((proof) => {
    const preserved = preservedEdges.get(proof.candidateId);
    if (preserved == null || preserved.provenance === "native") {
      return proof;
    }
    if (!preserved.active) {
      if (proof.resolution.status !== "active") {
        return proof;
      }
      const sourceDependency = preservedSourceDependencies.get(proof.candidateId);
      assertNonNullable(
        sourceDependency,
        `inactive stale edgeの降格済みAI依存がありません。対象: ${proof.candidateId}`,
      );
      return pendingProofForPreservedInactiveEdge(proof, sourceDependency);
    }
    const sourceDependency = preservedSourceDependencies.get(proof.candidateId);
    assertNonNullable(
      sourceDependency,
      `active stale edgeの降格済みAI依存がありません。対象: ${proof.candidateId}`,
    );
    return activeProofForPreservedEdge(proof, preserved, sourceDependency);
  });
  return Object.freeze({
    edges: Object.freeze(result),
    relationCandidateAiDependencies: new Map(
      normalizedCandidateDecisionProofs.map((proof) => [proof.candidateId, proof.dependency]),
    ),
    candidateResolutions: Object.freeze(
      normalizedCandidateDecisionProofs.map((proof) => proof.resolution),
    ),
    candidateDecisionProofs: Object.freeze(normalizedCandidateDecisionProofs),
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

function relationAiDependenciesForCandidates(
  candidates: readonly RelationCandidate[],
  items: readonly PendingTrackedItem[],
  assessments: readonly RelationCandidateAssessment[],
): ReadonlyMap<RelationCandidateId, AiAnalysisDependency> {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const candidatesById = new Map<RelationCandidateId, RelationCandidate>();
  for (const candidate of candidates) {
    if (candidatesById.has(candidate.id)) {
      throw new TypeError(`関係候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidatesById.set(candidate.id, candidate);
  }
  const itemsByNodeId = new Map<GraphNodeId, PendingTrackedItem>();
  for (const item of items) {
    if (itemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`関係候補の生成元itemが重複しています。対象: ${item.nodeId}`);
    }
    itemsByNodeId.set(item.nodeId, item);
  }
  const assessmentsByCandidateId = new Map<RelationCandidateId, RelationCandidateAssessment>();
  for (const assessment of assessments) {
    if (!candidateIds.has(assessment.candidateId)) {
      continue;
    }
    if (assessmentsByCandidateId.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI依存が重複しています`);
    }
    const candidate = candidatesById.get(assessment.candidateId);
    assertNonNullable(candidate, `関係候補 ${assessment.candidateId}がありません`);
    const ownerNodeId = relationAssessmentOwnerNodeId(candidate);
    if (assessment.currentNodeId !== ownerNodeId) {
      throw new TypeError(
        `関係候補 ${assessment.candidateId}のAI判定ownerが一致しません。対象: ${ownerNodeId}`,
      );
    }
    assessmentsByCandidateId.set(assessment.candidateId, assessment);
  }
  const dependencies = new Map<RelationCandidateId, AiAnalysisDependency>();
  for (const candidate of candidates) {
    if (candidate.provenance === "native") {
      dependencies.set(candidate.id, Object.freeze({ status: "not_dependent" }));
      continue;
    }
    const ownerNodeId = relationAssessmentOwnerNodeId(candidate);
    const owner = itemsByNodeId.get(ownerNodeId);
    if (owner == null) {
      const ownerNode = relationNodes(candidate.relation).find(
        (node) => node.nodeId === ownerNodeId,
      );
      assertNonNullable(ownerNode, `関係候補 ${candidate.id}のowner nodeがありません`);
      dependencies.set(candidate.id, unrecordedAiDependency());
      continue;
    }
    const assessment = assessmentsByCandidateId.get(candidate.id);
    if (assessment == null) {
      dependencies.set(
        candidate.id,
        aiAnalysisDependencyForMissingRelationCandidateAssessment(
          owner.nodeId,
          owner.aiAnalysis.applications.relations,
        ),
      );
      continue;
    }
    dependencies.set(
      candidate.id,
      aiDependencyForElementApplication(owner.nodeId, owner.aiAnalysis.applications, "relations"),
    );
  }
  return dependencies;
}

function reconcileCurrentGraph(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
): GraphResult {
  const previousIndex = previousGraphIndex(state);
  const previous = previousIndex.availability === "available" ? previousIndex.snapshot : undefined;
  const candidates = collection.relationCandidates;
  const relationAiDependencies = relationAiDependenciesForCandidates(
    candidates,
    reduction.items,
    reduction.relationAssessments,
  );
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
    relationAiDependencies: new Map(
      candidates.map((candidate) => {
        const dependency = relationAiDependencies.get(candidate.id);
        assertNonNullable(dependency, `関係候補 ${candidate.id}のAI依存がありません`);
        return [candidate.id, dependency];
      }),
    ),
    sourceOccurredAtById: createEarliestRelationSourceOccurredAtById(collection.observedItems),
    minimumInferredConfidence: configuration.config.ai.confidence.medium,
    reconciledAt: collection.evaluatedAt,
  });
  const preservedGraph = preserveUnverifiedGraphEdges(
    collection,
    previous?.edges ?? [],
    reconciled.edges,
    candidates,
    reconciled.candidateDecisionProofs,
  );
  const reconciledEdges = preservedGraph.edges;
  const reductionItemsByNodeId = new Map<GitHubNodeId, PendingTrackedItem>();
  for (const item of reduction.items) {
    if (reductionItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`関係候補endpointのreduction itemが重複しています。対象: ${item.nodeId}`);
    }
    reductionItemsByNodeId.set(item.nodeId, item);
  }
  const enumeratedItemsByNodeId = new Map<GitHubNodeId, EnumeratedGitHubItem>();
  for (const item of collection.enumeratedItems) {
    if (enumeratedItemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`関係候補endpointの列挙項目が重複しています。対象: ${item.nodeId}`);
    }
    enumeratedItemsByNodeId.set(item.nodeId, item);
  }
  const externalReferencesByNodeId = new Map<GraphNodeId, ExternalGhostNode>();
  const candidateExternalReferences = candidates.flatMap((candidate) =>
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
  );
  for (const reference of [
    ...(previousSnapshot(state)?.externalReferences ?? []),
    ...collection.externalReferences,
    ...candidateExternalReferences,
  ]) {
    externalReferencesByNodeId.set(reference.nodeId, reference);
  }
  for (const candidate of candidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope === "external_public") {
        if (!externalReferencesByNodeId.has(node.nodeId)) {
          throw new TypeError(`関係候補の外部参照nodeがありません。対象: ${node.nodeId}`);
        }
        continue;
      }
      const reductionItem = reductionItemsByNodeId.get(node.nodeId);
      if (reductionItem != null) {
        if (reductionItem.type !== node.kind) {
          throw new TypeError(`関係候補endpointのitem種別が一致しません。対象: ${node.nodeId}`);
        }
        continue;
      }
      const enumeratedItem = enumeratedItemsByNodeId.get(node.nodeId);
      if (enumeratedItem == null) {
        throw new TypeError(`関係候補endpointの列挙項目がありません。対象: ${node.nodeId}`);
      }
      if (enumeratedItem.type !== node.kind) {
        throw new TypeError(`関係候補endpointの列挙項目種別が一致しません。対象: ${node.nodeId}`);
      }
    }
  }
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
  const staleNodeIds = new Set(collection.staleItems.map((item) => item.nodeId));
  const effectiveGraphState = currentEffectiveGraphState(
    state,
    reduction.items,
    externalReferences,
    candidates,
    staleNodeIds,
    collection.evaluatedAt,
  );
  const currentTrackedGraphNodes = reduction.items.map((item) =>
    graphAnalysisNodeWithEffectiveState(item, effectiveGraphState.stateByNodeId),
  );
  const graphNodes = [
    ...currentTrackedGraphNodes,
    ...externalReferences.map(externalGraphAnalysisNode),
  ];
  const candidateOnlyNodesByNodeId = new Map<GraphNodeId, GraphAnalysisNode>();
  for (const candidate of candidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope !== "organization" || reductionItemsByNodeId.has(node.nodeId)) {
        continue;
      }
      const enumeratedItem = enumeratedItemsByNodeId.get(node.nodeId);
      assertNonNullable(
        enumeratedItem,
        `関係候補endpointの列挙項目がありません。対象: ${node.nodeId}`,
      );
      if (enumeratedItem.type !== node.kind) {
        throw new TypeError(`関係候補endpointの列挙項目種別が一致しません。対象: ${node.nodeId}`);
      }
      const candidateNode = candidateOnlyGraphAnalysisNode(enumeratedItem);
      const existing = candidateOnlyNodesByNodeId.get(candidateNode.nodeId);
      if (existing != null && JSON.stringify(existing) !== JSON.stringify(candidateNode)) {
        throw new TypeError(`関係候補endpointの列挙項目が一致しません。対象: ${node.nodeId}`);
      }
      candidateOnlyNodesByNodeId.set(candidateNode.nodeId, candidateNode);
    }
  }
  const aiGraphNodes = [
    ...currentTrackedGraphNodes,
    ...[...candidateOnlyNodesByNodeId.values()].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    ...[...externalReferencesByNodeId.values()]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map(externalGraphAnalysisNode),
  ];
  const aiGraphNodeIds = new Set(aiGraphNodes.map((node) => node.nodeId));
  const aiEdges = retainGraphEdgesForAvailableNodes(reconciledEdges, aiGraphNodeIds);
  const openNodeIds = new Set<GraphNodeId>(
    graphNodes.filter((node) => node.state === "open").map((node) => node.nodeId),
  );
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
  const aiAnalysis = analyzeGraphAiDependencies({
    current: {
      nodes: graphNodes,
      edges,
    },
    candidateProofSnapshot: {
      nodes: aiGraphNodes,
      edges: aiEdges,
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
    candidateDecisionProofs: preservedGraph.candidateDecisionProofs,
  });
  return Object.freeze({
    edges,
    effectiveStateByNodeId: effectiveGraphState.stateByNodeId,
    graphNodeStateObservations: effectiveGraphState.observations,
    currentNativeStateObservations: effectiveGraphState.currentNativeStateObservations,
    relationCandidateAiDependencies: preservedGraph.relationCandidateAiDependencies,
    candidateResolutions: preservedGraph.candidateResolutions,
    candidateDecisionProofs: preservedGraph.candidateDecisionProofs,
    externalReferences,
    openNodeIds,
    analysis,
    downstreamImpactAiDependencies: aiAnalysis.downstreamImpactAiDependencies,
    blockerSetAiDependencies: aiAnalysis.blockerSetAiDependencies,
    blockerNodeAiDependencies: aiAnalysis.blockerNodeAiDependencies,
    negativeBlockerAiDependencies: aiAnalysis.negativeBlockerAiDependencies,
    relationSetAiDependencies: aiAnalysis.relationSetAiDependencies,
    previousAnalysis:
      previousIndex.availability === "unavailable"
        ? Object.freeze({
            availability: "unavailable",
          })
        : Object.freeze({
            availability: "available",
            value: previousIndex.analysis,
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
    aiDependency: edge.aiDependency,
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
    } else if (entry.status === "delivery_started") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "delivery_started",
          deliveryId: entry.deliveryId,
          startedAt: createUtcIsoDateTime(entry.startedAt),
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
          status: "acknowledged",
          acknowledgedAt: createUtcIsoDateTime(entry.acknowledgedAt),
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
  repositoryFreshness: DiscordNotificationItem["repositoryFreshness"],
): DiscordNotificationItem["draftState"] {
  const observed = enumeratedItemsByNodeId.get(item.nodeId);
  if (observed == null && repositoryFreshness === "stale") {
    return item.type === "issue" ? "not_applicable" : "ready_for_review";
  }
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

function hasUnobservedPullRequestHeadChange(
  item: FreshObservedGitHubItem,
  previous: SnapshotTrackedItem | undefined,
  evaluatedAt: UtcIsoDateTime,
): boolean {
  if (item.type !== "pull_request" || previous == null) {
    return false;
  }
  if (previous.inputEvents.some((event) => event.sourceId === item.headCommit.sourceId)) {
    return item.githubUpdatedAt !== previous.githubUpdatedAt;
  }
  const headEvent = item.events.find(
    (event): event is Extract<NormalizedEvent, { kind: "push" }> =>
      event.kind === "push" &&
      event.sourceId === item.headCommit.sourceId &&
      event.headCommitSha === item.headCommit.sha &&
      !event.forcePush,
  );
  assertNonNullable(headEvent, `Pull Request ${item.nodeId}のhead commit eventがありません`);
  return headEvent.occurredAt <= previous.observedAt || headEvent.occurredAt > evaluatedAt;
}

function hasOpenBlockers(
  itemNodeId: GitHubNodeId,
  graph: GraphResult,
  nodeStateById: ReadonlyMap<GraphNodeId, PendingTrackedItem["state"]>,
): boolean {
  for (const edge of graph.edges) {
    if (!edge.active || edge.type !== "blocks" || edge.toNodeId !== itemNodeId) {
      continue;
    }
    const sourceState = nodeStateById.get(edge.fromNodeId);
    assertNonNullable(sourceState, `blocks関係元 ${edge.fromNodeId}の状態がありません`);
    if (sourceState === "open") {
      return true;
    }
  }
  return false;
}

function notificationItem(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  graph: GraphResult,
  evaluatedAt: UtcIsoDateTime,
  nodeStateById: ReadonlyMap<GraphNodeId, PendingTrackedItem["state"]>,
  item: PendingTrackedItem,
  staleness: TrackedItemStaleness,
  analysisState: NotificationAnalysisState,
  personalReminderAnalysis: PersonalReminderAnalysis,
  retainedNotificationRecommendation:
    DiscordNotificationItem["notificationRecommendation"] | undefined,
  repositoryFreshness: DiscordNotificationItem["repositoryFreshness"],
): DiscordNotificationItem {
  const repository = findRepository(inventory, item.repositoryId);
  const previous = previousTrackedItem(state, item.nodeId);
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
  const notificationRecommendation =
    analysisState.availability === "available"
      ? analysisState.value.notificationRecommendation
      : (retainedNotificationRecommendation ?? Object.freeze({ availability: "not_available" }));
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
  const causes: NotificationCauses =
    analysisState.availability === "available"
      ? createNotificationCauses({
          item: analysisState.value.item,
          currentWaitingOn: item.waitingOn,
          previous:
            previous == null
              ? Object.freeze({
                  availability: "not_available",
                })
              : Object.freeze({
                  availability: "available",
                  value: Object.freeze({
                    waitingOn: previous.waitingOn,
                    observedAt: previous.observedAt,
                  }),
                }),
          currentResponsibilityBasis: analysisState.value.responsibilityBasis,
          dependencyCause: analysisState.value.dependencyCause,
          selfCommitmentCause: analysisState.value.selfCommitmentCause,
          hasUnobservedHeadChange: hasUnobservedPullRequestHeadChange(
            analysisState.value.item,
            previous,
            evaluatedAt,
          ),
          evaluatedAt,
        })
      : Object.freeze({
          responsibility_changed: Object.freeze({ status: "indeterminate" }),
          newly_unblocked: Object.freeze({ status: "indeterminate" }),
        });
  const causesForPersonalReminder = personalReminderAnalysis.causesByNodeId.get(item.nodeId);
  assertNonNullable(
    causesForPersonalReminder,
    `通知対象 ${item.nodeId}の個人催促causeがありません`,
  );
  const personalReminderCausePlanning = personalReminderAnalysis.planningByNodeId.get(item.nodeId);
  assertNonNullable(
    personalReminderCausePlanning,
    `通知対象 ${item.nodeId}の個人催促cause planningがありません`,
  );
  const personalReminderCauses = Object.freeze(
    causesForPersonalReminder.map((cause) => {
      const personalStaleness = personalReminderAnalysis.stalenessByCauseId.get(cause.causeId);
      assertNonNullable(
        personalStaleness,
        `個人催促causeのstalenessがありません。対象: ${cause.causeId}`,
      );
      return Object.freeze({ cause, staleness: personalStaleness });
    }),
  );
  return Object.freeze({
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    draftState: notificationDraftState(item, enumeratedItemsByNodeId, repositoryFreshness),
    repositoryFreshness,
    notificationClass: item.notificationClass,
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
    latestChange:
      analysisState.availability === "available"
        ? notificationLatestChange(analysisState.value, previous)
        : "none",
    decisionBasis: notificationDecisionBasis(item, staleness, analysisState),
    notificationRecommendation,
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
    causes,
    personalReminderCauses,
    personalReminderCausePlanning,
    graph: Object.freeze({
      downstreamImpact,
      newlyUnblocked: graph.analysis.newlyUnblockedNodeIds.includes(item.nodeId),
      hasOpenBlockers: hasOpenBlockers(item.nodeId, graph, nodeStateById),
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
  personalReminderAnalysis: PersonalReminderAnalysis,
): readonly DiscordNotificationItem[] {
  const staleRepositoryIds = new Set<GitHubRepositoryId>(
    collection.repositoryResults
      .filter((result) => result.freshness === "stale")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    reduction.currentItems.map((current) => [current.item.nodeId, current]),
  );
  const nodeStateById = graph.effectiveStateByNodeId;
  const enumeratedItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    reduction.items.flatMap((item) => {
      const repositoryFreshness = staleRepositoryIds.has(item.repositoryId) ? "stale" : "fresh";
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
          collection.evaluatedAt,
          nodeStateById,
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
          personalReminderAnalysis,
          reduction.retainedNotificationRecommendations.get(item.nodeId),
          repositoryFreshness,
        ),
      ];
    }),
  );
}

function mergeNotificationLedger(
  state: RuntimeState,
  entriesToMerge: readonly NotificationLedgerEntry[],
  pendingNotifications: readonly PendingNotification[],
): StateNotificationLedger {
  const entries = new Map(
    state.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  for (const entry of entriesToMerge) {
    const existing = entries.get(entry.notificationKey);
    if (
      entry.status === "acknowledged" &&
      (existing?.status === "sent" || existing?.status === "acknowledged")
    ) {
      continue;
    }
    entries.set(entry.notificationKey, entry);
  }
  return createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: [...entries.values()],
    operationsAlerts: state.notificationLedger.operationsAlerts,
    pendingNotifications,
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
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
  item: PendingTrackedItem,
  downstreamImpact: AnalyzeGraphResult["downstreamImpacts"][number],
  downstreamImpactDependency: AiAnalysisDependency,
  naturalLanguageAssessment: NaturalLanguageImportanceAssessmentState,
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState,
): TrackedItemWithImportanceAssessment {
  const repository = findRepository(inventory, item.repositoryId);
  const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
  const deterministicImportance = calculateImportance({
    priorityWeight: labelEffects.priorityWeight,
    downstreamImpact,
    weights: configuration.config.importance.weights,
    levels: configuration.config.importance.levels,
  });
  const importance = combineImportance({
    deterministic: deterministicImportance,
    naturalLanguageAssessment,
    weights: configuration.config.importance.weights,
    levels: configuration.config.importance.levels,
  });
  const naturalLanguageCanAffectImportance =
    configuration.config.importance.weights.significantFeature > 0 ||
    configuration.config.importance.weights.futureRisk > 0;
  const downstreamImpactCanAffectImportance =
    configuration.config.importance.weights.downstreamImpactMax > 0 &&
    (configuration.config.importance.weights.blockedItem > 0 ||
      configuration.config.importance.weights.blockedRepository > 0);
  const importanceDependencies = [
    ...(naturalLanguageCanAffectImportance
      ? [aiDependencyForElementApplication(item.nodeId, item.aiAnalysis.applications, "importance")]
      : []),
    ...(downstreamImpactCanAffectImportance ? [downstreamImpactDependency] : []),
  ];
  return Object.freeze({
    ...item,
    importanceAssessment: naturalLanguageAssessment,
    deadlineAssessment,
    importance,
    aiDependencies: Object.freeze({
      ...item.aiDependencies,
      importance: combineSelectedAiDependencies(importanceDependencies),
    }),
  });
}

function finalizedTrackedItemAiDependencies(
  item: TrackedItemWithImportanceAssessment,
  currentAnalysis: ReducedItemAnalysis | undefined,
  previousItem: SnapshotTrackedItem | undefined,
  downstreamImpactDependency: AiAnalysisDependency,
  blockersDependency: AiAnalysisDependency,
  relationSetDependency: AiAnalysisDependency,
  currentAiDependencyContext: CurrentAiDependencyContext,
  deadlineLevel: DeadlineLevel,
  staleness: TrackedItemStaleness,
): TrackedItemAiDependencies {
  const dependencies = Object.freeze({
    ...item.aiDependencies,
    downstreamImpact: downstreamImpactDependency,
    blockers: blockersDependency,
    relationSet: relationSetDependency,
  });
  if (currentAnalysis == null) {
    const retainedDependencies = Object.freeze({
      ...dependencies,
      status: revalidatedRetainedTrackedItemAiDependency(
        item,
        "status",
        dependencies.status,
        currentAiDependencyContext,
      ),
      waitingOn: revalidatedRetainedTrackedItemAiDependency(
        item,
        "waitingOn",
        dependencies.waitingOn,
        currentAiDependencyContext,
      ),
      primaryWaitingOn: revalidatedRetainedTrackedItemAiDependency(
        item,
        "primaryWaitingOn",
        dependencies.primaryWaitingOn,
        currentAiDependencyContext,
      ),
      nextAction: revalidatedRetainedTrackedItemAiDependency(
        item,
        "nextAction",
        dependencies.nextAction,
        currentAiDependencyContext,
      ),
      confidence: revalidatedRetainedTrackedItemAiDependency(
        item,
        "confidence",
        dependencies.confidence,
        currentAiDependencyContext,
      ),
      evidence: revalidatedRetainedTrackedItemAiDependency(
        item,
        "evidence",
        dependencies.evidence,
        currentAiDependencyContext,
      ),
      uncertainties: revalidatedRetainedTrackedItemAiDependency(
        item,
        "uncertainties",
        dependencies.uncertainties,
        currentAiDependencyContext,
      ),
      lastProgressAt: revalidatedRetainedTrackedItemAiDependency(
        item,
        "lastProgressAt",
        dependencies.lastProgressAt,
        currentAiDependencyContext,
      ),
      stallSince: revalidatedRetainedTrackedItemAiDependency(
        item,
        "stallSince",
        dependencies.stallSince,
        currentAiDependencyContext,
      ),
    });
    return Object.freeze({
      ...retainedDependencies,
      severity: severityAiDependency(
        item,
        staleness,
        staleness.criticalRequested,
        retainedDependencies,
      ),
      attention: attentionAiDependency(
        item,
        staleness,
        item.importance,
        deadlineLevel,
        retainedDependencies,
      ),
    });
  }
  const stallSince = stallSinceAiDependency(
    currentAnalysis.item,
    item.aiAnalysis.applications,
    sourceOccurredAtByIdForAnalysis(currentAnalysis),
    currentAnalysis.decision,
    currentAnalysis.staleness,
    dependencies,
    previousItem,
    currentAnalysis.statusBasis,
    currentAnalysis.responsibilityBasis,
    currentAnalysis.blockerValueAiDependencies.transitionBasis,
  );
  const withStallSince = Object.freeze({
    ...dependencies,
    stallSince,
  });
  return Object.freeze({
    ...withStallSince,
    severity: severityAiDependency(
      currentAnalysis.decision,
      currentAnalysis.staleness,
      criticalSeverityWasRequested(currentAnalysis.staleness.severityReason),
      withStallSince,
    ),
    attention: attentionAiDependency(
      currentAnalysis.decision,
      currentAnalysis.staleness,
      item.importance,
      deadlineLevel,
      withStallSince,
    ),
  });
}

function personalReminderRuntimeLocalDecision(
  analysis: Readonly<{
    item: FreshObservedGitHubItem;
    localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  }>,
): PersonalReminderRuntimeLocalDecision {
  const decision = analysis.localResponsibilityDecision;
  if (decision.deterministicRulesVersion === ISSUE_DETERMINISTIC_RULES_VERSION) {
    if (analysis.item.type !== "issue") {
      throw new TypeError(`Issueのlocal decision種別が一致しません。対象: ${analysis.item.nodeId}`);
    }
    return Object.freeze({ itemType: "issue", value: decision });
  }
  if (analysis.item.type !== "pull_request") {
    throw new TypeError(
      `Pull Requestのlocal decision種別が一致しません。対象: ${analysis.item.nodeId}`,
    );
  }
  return Object.freeze({ itemType: "pull_request", value: decision });
}

function personalReminderRuntimeItem(
  collection: CollectedItems,
  item: FreshObservedGitHubItem,
): PersonalReminderRuntimeCollectedItem["item"] {
  const enumerated = collection.enumeratedItems.find(
    (candidate) => candidate.nodeId === item.nodeId,
  );
  assertNonNullable(enumerated, `個人催促対象の列挙値がありません。対象: ${item.nodeId}`);
  return Object.freeze({
    ...item,
    url: enumerated.url,
    title: enumerated.title,
  });
}

function personalReminderRuntimeEndpointState(
  item: Readonly<{
    type: FreshObservedGitHubItem["type"];
    state: "open" | "closed" | "merged";
    events: readonly NormalizedEvent[];
  }>,
): "open" | "closed" | "merged" {
  if (item.state === "open") {
    return "open";
  }
  if (
    item.type === "pull_request" &&
    item.events.some((event) => event.kind === "state" && event.state === "merged")
  ) {
    return "merged";
  }
  return "closed";
}

function personalReminderRuntimeCandidateRelation(
  candidate: RelationCandidate,
  aiDependenciesByCandidateId: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
  proof: RelationCandidateDecisionProof,
  resolution: RelationCandidateResolution,
): PersonalReminderRuntimeGraph["candidateRelations"][number] {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === secondNode.nodeId) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.id}`);
  }
  const endpointNodeIds = [firstNode.nodeId, secondNode.nodeId].sort((left, right) =>
    left.localeCompare(right),
  );
  const firstEndpoint = endpointNodeIds[0];
  const secondEndpoint = endpointNodeIds[1];
  assertNonNullable(
    firstEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  assertNonNullable(
    secondEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  const normalizedSourceIds = [...new Set(candidate.sourceIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const firstSourceId = normalizedSourceIds[0];
  assertNonNullable(
    firstSourceId,
    `個人催促relation候補のsourceがありません。対象: ${candidate.id}`,
  );
  const endpointTuple: readonly [GraphNodeId, GraphNodeId] = [firstEndpoint, secondEndpoint];
  const sourceTuple: readonly [SourceId, ...SourceId[]] = [
    firstSourceId,
    ...normalizedSourceIds.slice(1),
  ];
  const aiDependency = aiDependenciesByCandidateId.get(candidate.id);
  assertNonNullable(
    aiDependency,
    `個人催促relation候補のAI依存がありません。対象: ${candidate.id}`,
  );
  if (proof.candidateId !== candidate.id || resolution.candidateId !== candidate.id) {
    throw new TypeError(`個人催促relation候補のproof IDが一致しません。対象: ${candidate.id}`);
  }
  if (proof.authority !== candidate.authority) {
    throw new TypeError(
      `個人催促relation候補のproof authorityが一致しません。対象: ${candidate.id}`,
    );
  }
  if (
    proof.endpointNodeIds[0] !== firstNode.nodeId ||
    proof.endpointNodeIds[1] !== secondNode.nodeId
  ) {
    throw new TypeError(
      `個人催促relation候補のproof endpointが一致しません。対象: ${candidate.id}`,
    );
  }
  if (proof.resolution.status !== resolution.status) {
    throw new TypeError(`個人催促relation候補のresolutionが一致しません。対象: ${candidate.id}`);
  }
  if (serializeCanonicalJson(proof.resolution) !== serializeCanonicalJson(resolution)) {
    throw new TypeError(
      `個人催促relation候補のresolution内容が一致しません。対象: ${candidate.id}`,
    );
  }
  if (serializeCanonicalJson(proof.dependency) !== serializeCanonicalJson(aiDependency)) {
    throw new TypeError(`個人催促relation候補のproof AI依存が一致しません。対象: ${candidate.id}`);
  }
  return Object.freeze({
    candidateId: candidate.id,
    endpointNodeIds: Object.freeze(endpointTuple),
    ownerNodeId: relationAssessmentOwnerNodeId(candidate),
    relationType: candidate.relation.type,
    authority: candidate.authority,
    provenance: candidate.provenance,
    resolution,
    ...(proof.canonicalRelation == null ? {} : { canonicalRelation: proof.canonicalRelation }),
    evidenceSourceIds: Object.freeze(sourceTuple),
    aiDependency,
  });
}

function personalReminderRuntimeGraph(
  state: RuntimeState,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): PersonalReminderRuntimeGraph {
  const endpointStates = new Map<GraphNodeId, "open" | "closed" | "merged" | "missing">();
  for (const item of previousSnapshot(state)?.items ?? []) {
    endpointStates.set(
      item.nodeId,
      item.state === "merged" ? "merged" : item.state === "open" ? "open" : "closed",
    );
  }
  for (const reference of graph.externalReferences) {
    endpointStates.set(reference.nodeId, reference.state);
  }
  for (const item of collection.observedItems) {
    endpointStates.set(item.nodeId, personalReminderRuntimeEndpointState(item));
  }
  for (const item of reduction.items) {
    endpointStates.set(
      item.nodeId,
      item.state === "merged" ? "merged" : item.state === "open" ? "open" : "closed",
    );
  }
  for (const [nodeId, effectiveState] of graph.effectiveStateByNodeId) {
    endpointStates.set(nodeId, effectiveState);
  }
  const candidateEndpointItemsByNodeId = personalReminderCandidateEndpointItems(
    state,
    collection,
    reduction,
    graph.effectiveStateByNodeId,
  );
  const candidateRelations = graphCandidateRelations(
    collection.relationCandidates.filter((candidate) =>
      graph.relationCandidateAiDependencies.has(candidate.id),
    ),
    graph.relationCandidateAiDependencies,
    graph.candidateDecisionProofs,
    graph.candidateResolutions,
  );
  for (const candidate of candidateRelations) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      if (!endpointStates.has(endpointNodeId)) {
        endpointStates.set(endpointNodeId, "missing");
      }
    }
  }
  for (const edge of graph.edges) {
    for (const endpointNodeId of [edge.fromNodeId, edge.toNodeId]) {
      if (!endpointStates.has(endpointNodeId)) {
        endpointStates.set(endpointNodeId, "missing");
      }
    }
  }
  return Object.freeze({
    activeRelations: Object.freeze(
      graph.edges.filter(
        (edge): edge is ReconciledGraphEdge & Readonly<{ active: true }> => edge.active,
      ),
    ),
    candidateRelations,
    candidateResolutions: Object.freeze(graph.candidateResolutions),
    endpointStates,
    candidateEndpointItemsByNodeId,
    externalReferences: Object.freeze(
      graph.externalReferences.map((reference) =>
        Object.freeze({
          nodeId: reference.nodeId,
          url: reference.url,
          title: reference.title,
          state: reference.state,
        }),
      ),
    ),
  });
}

function personalReminderCandidateEndpointItem(
  item: Pick<TrackedItem, "nodeId" | "type" | "state" | "author">,
): PersonalReminderRuntimeCandidateEndpointItem {
  return Object.freeze({
    nodeId: item.nodeId,
    type: item.type,
    state: item.state,
    author:
      item.author.status === "identified"
        ? Object.freeze({
            status: "identified",
            type: item.author.actor.type,
            login: item.author.actor.login,
          })
        : Object.freeze({ status: "unavailable" }),
  });
}

function personalReminderCandidateEndpointItems(
  state: RuntimeState,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  effectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
): ReadonlyMap<GraphNodeId, PersonalReminderRuntimeCandidateEndpointItem> {
  const itemsByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCandidateEndpointItem>();
  for (const item of previousSnapshot(state)?.items ?? []) {
    itemsByNodeId.set(item.nodeId, personalReminderCandidateEndpointItem(item));
  }
  for (const item of collection.observedItems) {
    itemsByNodeId.set(item.nodeId, personalReminderCandidateEndpointItem(item));
  }
  for (const item of reduction.items) {
    itemsByNodeId.set(item.nodeId, personalReminderCandidateEndpointItem(item));
  }
  for (const [nodeId, effectiveState] of effectiveStateByNodeId) {
    const item = itemsByNodeId.get(nodeId);
    if (item == null) {
      continue;
    }
    itemsByNodeId.set(
      nodeId,
      Object.freeze({
        ...item,
        state: effectiveState,
      }),
    );
  }
  return itemsByNodeId;
}

function graphCandidateRelations(
  candidates: readonly RelationCandidate[],
  aiDependenciesByCandidateId: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
  proofs: readonly RelationCandidateDecisionProof[],
  resolutions: readonly RelationCandidateResolution[],
): readonly PersonalReminderRuntimeGraph["candidateRelations"][number][] {
  const proofsByCandidateId = new Map<RelationCandidateId, RelationCandidateDecisionProof>();
  for (const proof of proofs) {
    if (proofsByCandidateId.has(proof.candidateId)) {
      throw new TypeError(
        `個人催促relation候補のproof IDが重複しています。対象: ${proof.candidateId}`,
      );
    }
    proofsByCandidateId.set(proof.candidateId, proof);
  }
  const resolutionsByCandidateId = new Map<RelationCandidateId, RelationCandidateResolution>();
  for (const resolution of resolutions) {
    if (resolutionsByCandidateId.has(resolution.candidateId)) {
      throw new TypeError(
        `個人催促relation候補のresolution IDが重複しています。対象: ${resolution.candidateId}`,
      );
    }
    resolutionsByCandidateId.set(resolution.candidateId, resolution);
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidateId of candidateIds) {
    if (!proofsByCandidateId.has(candidateId) || !resolutionsByCandidateId.has(candidateId)) {
      throw new TypeError(
        `個人催促relation候補のproofまたはresolutionがありません。対象: ${candidateId}`,
      );
    }
  }
  for (const candidateId of proofsByCandidateId.keys()) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`個人催促relation候補のproof対象がありません。対象: ${candidateId}`);
    }
  }
  for (const candidateId of resolutionsByCandidateId.keys()) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`個人催促relation候補のresolution対象がありません。対象: ${candidateId}`);
    }
  }
  return Object.freeze(
    candidates.map((candidate) => {
      const proof = proofsByCandidateId.get(candidate.id);
      const resolution = resolutionsByCandidateId.get(candidate.id);
      assertNonNullable(proof, `個人催促relation候補のproofがありません。対象: ${candidate.id}`);
      assertNonNullable(
        resolution,
        `個人催促relation候補のresolutionがありません。対象: ${candidate.id}`,
      );
      return personalReminderRuntimeCandidateRelation(
        candidate,
        aiDependenciesByCandidateId,
        proof,
        resolution,
      );
    }),
  );
}

type PersonalReminderRelatedContextProjection = Readonly<{
  contexts: readonly PersonalReminderRuntimeRelatedContext[];
}>;

function personalReminderRelatedContexts(
  analysis: Readonly<{
    item: FreshObservedGitHubItem;
    localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  }>,
  collection: CollectedItems,
  graph: GraphResult,
  analysesByNodeId: ReadonlyMap<
    GitHubNodeId,
    Readonly<{
      item: FreshObservedGitHubItem;
      localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
    }>
  >,
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>,
): PersonalReminderRelatedContextProjection {
  const relatedNodeIds = new Set<GitHubNodeId>();
  const isGitHubNode = (nodeId: GraphNodeId): nodeId is GitHubNodeId =>
    !graph.externalReferences.some((reference) => reference.nodeId === nodeId);
  for (const edge of graph.edges) {
    if (!edge.active || edge.type === "related_to") {
      continue;
    }
    if (edge.fromNodeId === analysis.item.nodeId) {
      if (!isGitHubNode(edge.toNodeId)) {
        continue;
      }
      const relatedItem =
        analysesByNodeId.get(edge.toNodeId)?.item ??
        collection.observedItems.find((item) => item.nodeId === edge.toNodeId);
      if (relatedItem != null) {
        relatedNodeIds.add(relatedItem.nodeId);
      }
    }
    if (edge.toNodeId === analysis.item.nodeId) {
      if (!isGitHubNode(edge.fromNodeId)) {
        continue;
      }
      const relatedItem =
        analysesByNodeId.get(edge.fromNodeId)?.item ??
        collection.observedItems.find((item) => item.nodeId === edge.fromNodeId);
      if (relatedItem != null) {
        relatedNodeIds.add(relatedItem.nodeId);
      }
    }
  }
  const contexts: PersonalReminderRuntimeRelatedContext[] = [];
  for (const nodeId of [...relatedNodeIds].sort()) {
    const relatedAnalysis = analysesByNodeId.get(nodeId);
    const detail = detailsByNodeId.get(nodeId);
    const relatedItem =
      relatedAnalysis?.item ?? collection.observedItems.find((item) => item.nodeId === nodeId);
    if (detail == null || relatedItem == null) {
      continue;
    }
    contexts.push(
      Object.freeze({
        item: personalReminderRuntimeItem(collection, relatedItem),
        detail,
        localDecision:
          relatedAnalysis == null
            ? undefined
            : personalReminderRuntimeLocalDecision(relatedAnalysis),
      }),
    );
  }
  return Object.freeze({
    contexts: Object.freeze(contexts),
  });
}

type PersonalReminderEndpointAvailability =
  "github_observed" | "github_stale" | "external_public" | "unknown";

function addPersonalReminderEndpointAvailability(
  availabilityByNodeId: Map<GraphNodeId, PersonalReminderEndpointAvailability>,
  nodeId: GraphNodeId,
  availability: PersonalReminderEndpointAvailability,
): void {
  const existing = availabilityByNodeId.get(nodeId);
  if (existing != null && existing !== availability) {
    throw new TypeError(
      `個人催促relation endpointのavailabilityが複数区分に所属します。対象: ${nodeId}`,
    );
  }
  availabilityByNodeId.set(nodeId, availability);
}

function personalReminderEndpointAvailabilityByNodeId(
  collection: Pick<CollectedItems, "observedItems" | "staleItems" | "relationCandidates">,
): ReadonlyMap<GraphNodeId, PersonalReminderEndpointAvailability> {
  const availabilityByNodeId = new Map<GraphNodeId, PersonalReminderEndpointAvailability>();
  for (const item of collection.observedItems) {
    addPersonalReminderEndpointAvailability(availabilityByNodeId, item.nodeId, "github_observed");
  }
  for (const item of collection.staleItems) {
    addPersonalReminderEndpointAvailability(availabilityByNodeId, item.nodeId, "github_stale");
  }
  for (const candidate of collection.relationCandidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope === "external_public") {
        addPersonalReminderEndpointAvailability(
          availabilityByNodeId,
          node.nodeId,
          "external_public",
        );
      }
    }
  }
  return availabilityByNodeId;
}

type PersonalReminderRelationCandidateSelection = Readonly<{
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>;
}>;

type CurrentRelationCandidate = Readonly<{
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  ownerNodeId: GraphNodeId;
}>;

function currentRelationCandidatesById(
  relationCandidates: readonly RelationCandidate[],
): ReadonlyMap<string, CurrentRelationCandidate> {
  const candidatesById = new Map<string, CurrentRelationCandidate>();
  for (const candidate of relationCandidates) {
    const [firstNode, secondNode] = relationNodes(candidate.relation);
    const endpointNodeIds: readonly [GraphNodeId, GraphNodeId] = [
      firstNode.nodeId,
      secondNode.nodeId,
    ];
    const normalized = Object.freeze({
      endpointNodeIds: normalizedBlockerRelationEndpointNodeIds(endpointNodeIds),
      ownerNodeId: relationAssessmentOwnerNodeId(candidate),
    });
    const existing = candidatesById.get(candidate.id);
    if (existing == null) {
      candidatesById.set(candidate.id, normalized);
      continue;
    }
    if (
      existing.endpointNodeIds[0] !== normalized.endpointNodeIds[0] ||
      existing.endpointNodeIds[1] !== normalized.endpointNodeIds[1] ||
      existing.ownerNodeId !== normalized.ownerNodeId
    ) {
      throw new TypeError(`現在のrelation candidate定義が一致しません。対象: ${candidate.id}`);
    }
  }
  return candidatesById;
}

function selectPersonalReminderRelationCandidateConsumers(
  state: RuntimeState,
  collection: Pick<CollectedItems, "observedItems" | "staleItems" | "relationCandidates">,
  trackedNodeIds: ReadonlySet<GitHubNodeId>,
): PersonalReminderRelationCandidateSelection {
  const endpointAvailabilityByNodeId = personalReminderEndpointAvailabilityByNodeId(collection);
  const currentCandidatesById = currentRelationCandidatesById(collection.relationCandidates);
  const freshObservedNodeIds = new Set<GitHubNodeId>(
    collection.observedItems.map((item) => item.nodeId),
  );
  const trackedGraphNodeIds = new Set<GraphNodeId>(trackedNodeIds);
  const selectionByConsumerNodeId = new Map<
    GitHubNodeId,
    {
      available: boolean;
      ownerNodeIds: Set<GitHubNodeId>;
    }
  >();
  for (const dependency of previousPersonalReminderRelationCandidateDependencies(state)) {
    if (
      !freshObservedNodeIds.has(dependency.consumerNodeId) ||
      !trackedNodeIds.has(dependency.consumerNodeId)
    ) {
      continue;
    }
    let selection = selectionByConsumerNodeId.get(dependency.consumerNodeId);
    if (selection == null) {
      selection = {
        available: true,
        ownerNodeIds: new Set<GitHubNodeId>(),
      };
      selectionByConsumerNodeId.set(dependency.consumerNodeId, selection);
    }
    const endpointComplete = dependency.producer.endpointNodeIds.every((endpointNodeId) => {
      const availability = endpointAvailabilityByNodeId.get(endpointNodeId);
      return availability === "github_observed" || availability === "external_public";
    });
    if (!endpointComplete) {
      selection.available = false;
    }
    const currentCandidate = currentCandidatesById.get(dependency.producer.candidateId);
    const previousEndpointNodeIds = normalizedBlockerRelationEndpointNodeIds(
      dependency.producer.endpointNodeIds,
    );
    if (
      currentCandidate != null &&
      (currentCandidate.endpointNodeIds[0] !== previousEndpointNodeIds[0] ||
        currentCandidate.endpointNodeIds[1] !== previousEndpointNodeIds[1] ||
        currentCandidate.ownerNodeId !== dependency.producer.producer.nodeId)
    ) {
      throw new TypeError(
        `前回と現在のpersonal reminder relation candidate定義が一致しません。対象: ${dependency.producer.candidateId}`,
      );
    }
    const ownerItem = collection.observedItems.find(
      (item) => item.nodeId === dependency.producer.producer.nodeId,
    );
    if (ownerItem == null || !trackedGraphNodeIds.has(ownerItem.nodeId)) {
      selection.available = false;
      continue;
    }
    selection.ownerNodeIds.add(ownerItem.nodeId);
  }
  const analysisNodeIds = new Set<GitHubNodeId>();
  const unavailableConsumerNodeIds = new Set<GitHubNodeId>();
  for (const [consumerNodeId, selection] of selectionByConsumerNodeId) {
    if (!selection.available) {
      unavailableConsumerNodeIds.add(consumerNodeId);
      continue;
    }
    analysisNodeIds.add(consumerNodeId);
    for (const ownerNodeId of selection.ownerNodeIds) {
      analysisNodeIds.add(ownerNodeId);
    }
  }
  return Object.freeze({
    analysisNodeIds,
    unavailableConsumerNodeIds,
  });
}

function personalReminderRuntimeCollection(
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>,
): Readonly<{
  collection: Readonly<{
    items: readonly PersonalReminderRuntimeCollectedItem[];
    staleNodeIds: ReadonlySet<GitHubNodeId>;
  }>;
  analyses: ReadonlyMap<GitHubNodeId, ReducedItemAnalysis>;
}> {
  const analysesByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const detailsByNodeId = new Map(collection.details.map((detail) => [detail.nodeId, detail]));
  const staleNodeIds = new Set(collection.staleItems.map((item) => item.nodeId));
  const items: PersonalReminderRuntimeCollectedItem[] = [];
  for (const analysis of deterministicAnalysis.items) {
    if (unavailableConsumerNodeIds.has(analysis.item.nodeId)) {
      continue;
    }
    const currentAnalysis = analysesByNodeId.get(analysis.item.nodeId);
    assertNonNullable(
      currentAnalysis,
      `個人催促対象のgeneric採用後分析がありません。対象: ${analysis.item.nodeId}`,
    );
    const detail = detailsByNodeId.get(analysis.item.nodeId);
    assertNonNullable(detail, `個人催促対象の詳細がありません。対象: ${analysis.item.nodeId}`);
    if (detail.type !== analysis.item.type) {
      throw new TypeError(`個人催促対象の詳細種別が一致しません。対象: ${analysis.item.nodeId}`);
    }
    const relatedProjection = personalReminderRelatedContexts(
      currentAnalysis,
      collection,
      graph,
      analysesByNodeId,
      detailsByNodeId,
    );
    items.push(
      Object.freeze({
        item: personalReminderRuntimeItem(collection, analysis.item),
        detail,
        localDecision: personalReminderRuntimeLocalDecision(currentAnalysis),
        aiAnalysisApplications: currentAnalysis.aiAnalysisApplications,
        relatedContexts: relatedProjection.contexts,
        completeness: Object.freeze({ status: "complete" }),
        repositoryFullName: repositoryFullName(
          findRepository(deterministicAnalysis.inventory, analysis.item.repositoryId),
        ),
        currentLabels: analysis.item.labels,
      }),
    );
  }
  return Object.freeze({
    collection: Object.freeze({
      items: Object.freeze(items),
      staleNodeIds,
    }),
    analyses: analysesByNodeId,
  });
}

function personalReminderPreviousState(state: RuntimeState): PersonalReminderRuntimeState {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return Object.freeze({
      previousCausesByNodeId: new Map(),
      previousEvidenceByNodeId: new Map(),
    });
  }
  return Object.freeze({
    previousCausesByNodeId: new Map(
      snapshot.items.map((item) => [
        item.nodeId,
        Object.freeze({ observedAt: item.observedAt, causes: item.personalReminderCauses }),
      ]),
    ),
    previousEvidenceByNodeId: new Map(snapshot.items.map((item) => [item.nodeId, item.evidence])),
  });
}

function personalReminderPlaceholderCause(
  entry: PersonalReminderCauseRuntimePlanEntry,
): PersonalReminderCause {
  const inputFingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
  return personalReminderCauseSchema.parse({
    ...entry.seed,
    responseMembershipAssessmentRequirement: entry.responseMembershipAssessmentRequirement,
    currentInput: {
      fingerprint: inputFingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      completeness: entry.semanticInput.completeness,
      aiDependency: entry.currentInputAiDependency,
    },
    latestAttempt: { status: "not_evaluated" },
    adoptedAssessment: { status: "not_available" },
    actionableClock: { status: "not_observed" },
  });
}

function hasCurrentPersonalReminderAssessment(
  cause: PersonalReminderCause | undefined,
  inputFingerprint: string,
): boolean {
  if (cause == null) {
    return false;
  }
  return (
    cause.currentInput.fingerprint === inputFingerprint &&
    cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
    currentPersonalReminderAssessment(cause).status === "available"
  );
}

function personalReminderAiCandidate(
  entry: PersonalReminderCauseRuntimePlanEntry,
  graph: GraphResult,
): PersonalReminderAiEvaluationCandidate | undefined {
  const inputFingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
  if (entry.semanticInput.completeness.status === "complete") {
    if (entry.deterministicAssessment != null) {
      return undefined;
    }
    if (hasCurrentPersonalReminderAssessment(entry.previousCause, inputFingerprint)) {
      return undefined;
    }
  }
  const downstreamImpact = graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === entry.seed.itemNodeId,
  );
  const previousAttempt = entry.previousCause?.latestAttempt.status;
  return Object.freeze({
    cause: entry.previousCause ?? personalReminderPlaceholderCause(entry),
    input: entry.semanticInput,
    inputFingerprint,
    priority: Object.freeze({
      previouslyDeferred: previousAttempt === "deferred",
      severityCandidate: true,
      ownerUnknown: entry.seed.responsible.some((responsible) => responsible.kind === "role"),
      changedBlocker:
        entry.semanticInput.relations.length !== 0 ||
        entry.semanticInput.pendingRelations.length !== 0,
      downstreamImpact:
        downstreamImpact == null
          ? Object.freeze({ openNodeCount: 0, repositoryCount: 0 })
          : Object.freeze({
              openNodeCount: downstreamImpact.openNodeCount,
              repositoryCount: downstreamImpact.repositoryCount,
            }),
    }),
  });
}

function personalReminderAssessmentReuseCount(
  plan: ReturnType<typeof planPersonalReminderCauses>,
): number {
  return plan.entries.filter((entry) => {
    if (entry.previousCause == null || entry.deterministicAssessment != null) {
      return false;
    }
    const inputFingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
    return hasCurrentPersonalReminderAssessment(entry.previousCause, inputFingerprint);
  }).length;
}

function personalReminderCauseAttemptCounts(
  causesByNodeId: ReadonlyMap<GitHubNodeId, readonly PersonalReminderCause[]>,
): Readonly<{
  unknown: number;
  failed: number;
  deferred: number;
  notEvaluated: number;
}> {
  const causes = [...causesByNodeId.values()].flat();
  return Object.freeze({
    unknown: causes.filter((cause) => {
      const assessment = currentPersonalReminderAssessment(cause);
      return assessment.status === "available" && assessment.result.verdict === "unknown";
    }).length,
    failed: causes.filter(
      (cause) =>
        currentPersonalReminderAssessment(cause).status !== "available" &&
        cause.latestAttempt.status === "failed",
    ).length,
    deferred: causes.filter(
      (cause) =>
        currentPersonalReminderAssessment(cause).status !== "available" &&
        cause.latestAttempt.status === "deferred",
    ).length,
    notEvaluated: causes.filter(
      (cause) =>
        currentPersonalReminderAssessment(cause).status !== "available" &&
        cause.latestAttempt.status === "not_evaluated",
    ).length,
  });
}

function personalReminderUsageDelta(
  usage: AiBudgetUsage,
  initialUsage: AiBudgetUsage,
): AiBudgetUsage {
  if (
    usage.calls < initialUsage.calls ||
    usage.inputCharacters < initialUsage.inputCharacters ||
    usage.estimatedCostUsd < initialUsage.estimatedCostUsd
  ) {
    throw new TypeError("個人催促AIの累積使用量が初期使用量を下回っています");
  }
  return Object.freeze({
    calls: usage.calls - initialUsage.calls,
    inputCharacters: usage.inputCharacters - initialUsage.inputCharacters,
    estimatedCostUsd: usage.estimatedCostUsd - initialUsage.estimatedCostUsd,
  });
}

async function analyzePersonalReminders(
  adapters: ProductionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
): Promise<PersonalReminderAnalysisStageResult<PersonalReminderAnalysis>> {
  const personalReminderRelationCandidateSelection =
    selectPersonalReminderRelationCandidateConsumers(state, collection, collection.trackedNodeIds);
  const unavailableConsumerNodeIds =
    personalReminderRelationCandidateSelection.unavailableConsumerNodeIds;
  const runtimeCollection = personalReminderRuntimeCollection(
    collection,
    deterministicAnalysis,
    reduction,
    graph,
    unavailableConsumerNodeIds,
  );
  const runtimeGraph = personalReminderRuntimeGraph(state, collection, reduction, graph);
  const snapshotEvidenceSourceIds = new Set<SourceId>([
    ...reduction.items.flatMap((item) => item.evidence.map((evidence) => evidence.sourceId)),
    ...graph.edges.flatMap((edge) => edge.evidence.map((evidence) => evidence.sourceId)),
  ]);
  const context = createPersonalReminderRuntimeContext({
    evaluatedAt: collection.evaluatedAt,
    state: personalReminderPreviousState(state),
    collection: runtimeCollection.collection,
    graph: runtimeGraph,
    aiDependencyContext: aiDependencyReconciliationContext(
      reduction.items,
      collection.relationCandidates,
      graph,
    ),
    snapshotEvidenceSourceIds,
  });
  const plan = planPersonalReminderCauses(context);
  const continuityConflictNodeIds = new Set(
    plan.continuityConflicts.map((conflict) => conflict.itemNodeId),
  );
  const personalReminderFallbackNodeIds = new Set<GitHubNodeId>([
    ...unavailableConsumerNodeIds,
    ...continuityConflictNodeIds,
  ]);
  const candidates = Object.freeze(
    plan.entries.flatMap((entry) => {
      const candidate = personalReminderAiCandidate(entry, graph);
      return candidate == null ? [] : [candidate];
    }),
  );
  const initialUsage = codexAnalysis.run?.usage ?? createEmptyAiBudgetUsage();
  const diagnostics: CodexDiagnosticsContext | undefined =
    adapters.diagnosticsRecorder == null
      ? undefined
      : Object.freeze({
          recorder: adapters.diagnosticsRecorder,
          runId: invocation.runId,
          invocationId: `${invocation.runId}:personal-reminder`,
        });
  for (const conflict of plan.continuityConflicts) {
    await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.continuity_conflict", {
      phase: "fallback",
      itemNodeId: conflict.itemNodeId,
      previousCauseIds: conflict.previousCauseIds,
    });
  }
  const forcedTarget = forcedAiAnalysisTarget(configuration);
  let run: PersonalReminderAiRunResult | undefined;
  if (configuration.config.ai.enabled && forcedTarget == null) {
    const codexCredentials = configuration.credentials.codex;
    if (!codexCredentials.enabled) {
      throw new TypeError("AIが有効ですがCodex認証情報がありません");
    }
    const codexConfiguration = createCodexAdapterConfiguration(configuration.config);
    const codexDependencies = createCodexAdapterDependencies(
      adapters,
      codexCredentials,
      diagnostics,
      undefined,
    );
    const preflightInputCost =
      codexCredentials.authentication === "auth-json"
        ? estimateAiInputCost(
            CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
            configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
          )
        : undefined;
    const preflightDiagnostics = createCodexPreflightDiagnostics(diagnostics, invocation);
    const preflight =
      codexAnalysis.run?.authenticationPreflightExecuted === true || preflightInputCost == null
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
    run = await runPersonalReminderAiAnalyses(
      candidates,
      {
        model: configuration.config.ai.model,
        reasoningEffort: configuration.config.ai.execution.reasoningEffort,
        backendVersion: CODEX_BACKEND_VERSION,
        budget: configuration.config.ai.budget,
        initialUsage,
        maxConcurrentCalls: configuration.config.ai.execution.maxConcurrentCalls,
        minimumConfidence: configuration.config.ai.confidence.high,
        inputCostUsdPerMillionTokens:
          configuration.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
      } satisfies PersonalReminderAiRunConfiguration,
      {
        cache: state.session.personalReminderAiCache,
        ...(preflight == null ? {} : { preflight }),
        ...(diagnostics == null ? {} : { diagnostics }),
        execute: (input) =>
          adapters.executeCodexPersonalReminderAnalysis(
            input,
            codexConfiguration,
            codexDependencies,
          ),
        executedAt: () => collection.evaluatedAt,
      },
    );
  }
  const application = applyPersonalReminderCauseOutcomes({
    plan,
    outcomes: run,
    evaluatedAt: collection.evaluatedAt,
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    resolveLabelEffects: createLabelEffectsResolver(normalizeLabelRules(configuration.config)),
  });
  const runtimeNodeIds = new Set(
    runtimeCollection.collection.items.map((item) => item.item.nodeId),
  );
  for (const nodeId of continuityConflictNodeIds) {
    runtimeNodeIds.delete(nodeId);
  }
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const causesByNodeId = new Map<GitHubNodeId, readonly PersonalReminderCause[]>();
  const evidenceByNodeId = new Map<GitHubNodeId, readonly Evidence[]>();
  const planningByNodeId = new Map<
    GitHubNodeId,
    SnapshotTrackedItem["personalReminderCausePlanning"]
  >();
  for (const item of reduction.items) {
    if (runtimeNodeIds.has(item.nodeId)) {
      continue;
    }
    const previous = previousItemsByNodeId.get(item.nodeId);
    assertNonNullable(
      previous,
      `個人催促runtime対象外の前回項目がありません。対象: ${item.nodeId}`,
    );
    const causes = Object.freeze(
      previous.personalReminderCauses.map((cause) =>
        reconcileRetainedPersonalReminderCause(cause, context.aiDependencyContext),
      ),
    );
    causesByNodeId.set(item.nodeId, causes);
    evidenceByNodeId.set(item.nodeId, previous.evidence);
    planningByNodeId.set(
      item.nodeId,
      reconcileRetainedPersonalReminderPlanning(
        item.state,
        item.observedAt,
        previous.personalReminderCausePlanning,
        causes,
        context.aiDependencyContext,
      ),
    );
  }
  for (const [nodeId, causes] of application.causesByNodeId) {
    causesByNodeId.set(nodeId, causes);
  }
  for (const [nodeId, evidence] of application.evidenceByNodeId) {
    evidenceByNodeId.set(nodeId, evidence);
  }
  for (const item of runtimeCollection.collection.items) {
    if (continuityConflictNodeIds.has(item.item.nodeId)) {
      continue;
    }
    const causes = causesByNodeId.get(item.item.nodeId);
    if (causes == null) {
      causesByNodeId.set(item.item.nodeId, Object.freeze([]));
    }
    if (!evidenceByNodeId.has(item.item.nodeId)) {
      evidenceByNodeId.set(item.item.nodeId, Object.freeze([]));
    }
    const plannedCauses = causesByNodeId.get(item.item.nodeId);
    assertNonNullable(
      plannedCauses,
      `個人催促causeの計画結果がありません。対象: ${item.item.nodeId}`,
    );
    let planning: SnapshotTrackedItem["personalReminderCausePlanning"];
    if (
      item.item.state === "open" &&
      (item.completeness.status === "incomplete" ||
        plan.unrecordedDependencyNodeIds.has(item.item.nodeId))
    ) {
      planning = Object.freeze({
        status: "pending",
        planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      });
    } else if (plannedCauses.length === 0 && item.item.state !== "open") {
      planning = Object.freeze({
        status: "excluded",
        planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        reason: "terminal_without_cause",
      });
    } else {
      const causeSetAiDependency = plan.causeSetAiDependencyByNodeId.get(item.item.nodeId);
      assertNonNullable(
        causeSetAiDependency,
        `個人催促cause集合のAI依存がありません。対象: ${item.item.nodeId}`,
      );
      const causeSetSubjectChanges = plan.causeSetSubjectChangesByNodeId.get(item.item.nodeId);
      assertNonNullable(
        causeSetSubjectChanges,
        `個人催促cause集合の主体変化範囲がありません。対象: ${item.item.nodeId}`,
      );
      planning = Object.freeze({
        status: "completed",
        planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        observedAt: collection.evaluatedAt,
        causeSetAiDependency,
        causeSetSubjectChanges,
      });
    }
    planningByNodeId.set(item.item.nodeId, planning);
  }
  const stalenessByCauseId = new Map(application.stalenessByCauseId);
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const reductionItemsByNodeId = new Map(reduction.items.map((item) => [item.nodeId, item]));
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  for (const [nodeId, causes] of causesByNodeId) {
    const observedItem = observedItemsByNodeId.get(nodeId);
    const previousItem = previousItemsByNodeId.get(nodeId);
    const reductionItem = reductionItemsByNodeId.get(nodeId);
    assertNonNullable(reductionItem, `個人催促causeの追跡項目がありません。対象: ${nodeId}`);
    const repositoryId =
      observedItem?.repositoryId ?? previousItem?.repositoryId ?? reductionItem.repositoryId;
    assertNonNullable(repositoryId, `個人催促causeのrepository IDがありません。対象: ${nodeId}`);
    const repository = findRepository(deterministicAnalysis.inventory, repositoryId);
    const labels = observedItem?.labels ?? previousItem?.labels ?? reductionItem.labels;
    for (const cause of causes) {
      if (stalenessByCauseId.has(cause.causeId)) {
        continue;
      }
      stalenessByCauseId.set(
        cause.causeId,
        calculatePersonalReminderStaleness({
          cause,
          evaluatedAt: collection.evaluatedAt,
          minimumAiConfidence: configuration.config.ai.confidence.medium,
          repositoryFullName: repositoryFullName(repository),
          currentLabels: labels,
          resolveLabelEffects,
          thresholdsHours: configuration.config.staleness.thresholdsHours,
        }),
      );
    }
  }
  const counts = personalReminderCauseAttemptCounts(causesByNodeId);
  const usage = run?.usage ?? initialUsage;
  const usageDelta = personalReminderUsageDelta(usage, initialUsage);
  const status =
    personalReminderFallbackNodeIds.size > 0 ||
    counts.failed > 0 ||
    counts.deferred > 0 ||
    [...planningByNodeId.values()].some((planning) => planning.status === "pending")
      ? "fallback"
      : "success";
  await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.summary", {
    phase: "summary",
    candidateCauseCount: candidates.length,
    aiCallCount: usageDelta.calls,
    cacheHitCauseCount: run?.cacheHitCauseCount ?? 0,
  });
  return Object.freeze({
    status,
    value: Object.freeze({
      status,
      causesByNodeId,
      evidenceByNodeId,
      planningByNodeId,
      stalenessByCauseId,
      run,
      budgetUsage: usage,
      authenticationPreflightExecuted: run?.authenticationPreflightExecuted ?? false,
    }),
    aiCallCount: usage.calls,
    estimatedInputTokens: Math.ceil(usage.inputCharacters / 4),
    personalReminderCauseCount: [...causesByNodeId.values()].reduce(
      (count, causes) => count + causes.length,
      0,
    ),
    personalReminderAiCallCount: run?.executedBatchCount ?? 0,
    personalReminderAiCacheHitCount: run?.cacheHitCauseCount ?? 0,
    personalReminderAssessmentReuseCount: personalReminderAssessmentReuseCount(plan),
    personalReminderUnknownCount: counts.unknown,
    personalReminderFailedCount: counts.failed,
    personalReminderDeferredCount: counts.deferred,
    personalReminderNotEvaluatedCount: counts.notEvaluated,
    diagnostics: Object.freeze([]),
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
  personalReminderAnalysis: PersonalReminderAnalysis,
): ValidatedRun {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const currentAnalysisByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const previousSnapshotItems = previousSnapshot(state)?.items ?? [];
  const previousSnapshotItemByNodeId = new Map(
    previousSnapshotItems.map((item) => [item.nodeId, item]),
  );
  const downstreamImpactByNodeId = downstreamImpactsByNodeId(graph);
  const downstreamImpactDependenciesByNodeId = downstreamImpactAiDependenciesByNodeId(graph);
  const blockersDependenciesByNodeId = blockersAiDependenciesByNodeId(graph);
  const relationSetDependenciesByNodeId = graphAiDependenciesByNodeId(
    graph.relationSetAiDependencies,
    "relation集合AI依存",
  );
  const currentAiDependencyContext: CurrentAiDependencyContext = Object.freeze({
    ...aiDependencyReconciliationContext(reduction.items, collection.relationCandidates, graph),
    relationsById: new Map(
      graph.edges.map((edge): [string, ReconciledGraphEdge] => [edge.id, edge]),
    ),
    openNodeIds: graph.openNodeIds,
    nativeOpenBlockerNodeIdsByTargetNodeId: nativeOpenBlockerNodeIdsByTargetNodeId(graph),
    blockerValueDependenciesByNodeId: retainedBlockerValueAiDependenciesByNodeId(
      graph,
      reduction.items,
      configuration.config.ai.confidence.high,
      new Set(collection.staleItems.map((item) => item.nodeId)),
      collection.staleBlockerTopologyNodeIds,
    ),
  });
  const items = reduction.items.map((item) => {
    const currentAnalysis = currentAnalysisByNodeId.get(item.nodeId);
    const previousItem = previousSnapshotItemByNodeId.get(item.nodeId);
    const downstreamImpact = graphMapValue(
      downstreamImpactByNodeId,
      item.nodeId,
      `重要度計算対象 ${item.nodeId}のdownstream impact`,
    );
    const downstreamImpactDependency = graphAiDependencyForNode(
      downstreamImpactDependenciesByNodeId,
      item.nodeId,
      "downstream impact",
    );
    const blockersDependency = graphAiDependencyForNode(
      blockersDependenciesByNodeId,
      item.nodeId,
      "blocker",
    );
    const relationSetDependency = graphAiDependencyForNode(
      relationSetDependenciesByNodeId,
      item.nodeId,
      "relation集合",
    );
    const trackedItem = createTrackedItemWithImportance(
      configuration,
      inventory,
      resolveLabelEffects,
      item,
      downstreamImpact,
      downstreamImpactDependency,
      resolveImportanceAssessment(
        currentAnalysis?.importanceAssessment ?? previousItem?.importanceAssessment,
        undefined,
      ),
      resolveDeadlineAssessment(
        currentAnalysis?.deadlineAssessment ?? previousItem?.deadlineAssessment,
        undefined,
      ),
    );
    const staleness = reduction.stalenessByNodeId.get(item.nodeId);
    assertNonNullable(staleness, `追跡項目 ${item.nodeId}のseverity再計算結果がありません`);
    const deadlineLevel = deadlineLevelForAssessment(
      trackedItem.deadlineAssessment,
      collection.evaluatedAt,
      configuration.config.staleness.timezone,
    );
    const aiDependencies = finalizedTrackedItemAiDependencies(
      trackedItem,
      currentAnalysis,
      previousItem,
      downstreamImpactDependency,
      blockersDependency,
      relationSetDependency,
      currentAiDependencyContext,
      deadlineLevel,
      staleness,
    );
    const causes = personalReminderAnalysis.causesByNodeId.get(item.nodeId);
    assertNonNullable(causes, `個人催促causeがありません。対象: ${item.nodeId}`);
    const personalEvidence = personalReminderAnalysis.evidenceByNodeId.get(item.nodeId);
    assertNonNullable(personalEvidence, `個人催促evidenceがありません。対象: ${item.nodeId}`);
    const planning = personalReminderAnalysis.planningByNodeId.get(item.nodeId);
    assertNonNullable(planning, `個人催促cause planningがありません。対象: ${item.nodeId}`);
    const evidenceByIdentity = new Map<string, Evidence>();
    for (const evidence of [...trackedItem.evidence, ...personalEvidence]) {
      evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
    }
    return Object.freeze({
      ...trackedItem,
      aiDependencies,
      personalReminderCauses: causes,
      personalReminderCausePlanning: planning,
      evidence: Object.freeze([...evidenceByIdentity.values()]),
    });
  });
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const snapshot = createStateSnapshot({
    schemaVersion: "19",
    generatedAt: collection.evaluatedAt,
    trackingStartAt: pendingSnapshotTrackingStartAt(configuration, state, collection.evaluatedAt),
    ai: snapshotAiState(configuration.config, codexAnalysis),
    collection: {
      repositories: validatedCollectionRepositories(
        state,
        configuration,
        collection,
        codexAnalysis,
        itemsByNodeId,
      ),
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
    graphNodeStateObservations: graph.graphNodeStateObservations,
    externalReferences: graph.externalReferences,
    relations: graph.edges.map(toStateRelation),
    run: {
      id: invocation.runId,
      status:
        reduction.runStatus === "fallback" || personalReminderAnalysis.status === "fallback"
          ? "fallback"
          : "success",
      complete: true,
    },
  });
  assertPersonalReminderEvidenceClosure(snapshot);
  const notificationInput = {
    evaluatedAt: collection.evaluatedAt,
    items: notificationItems(
      configuration,
      state,
      inventory,
      collection,
      reduction,
      graph,
      personalReminderAnalysis,
    ),
    ledger: notificationLedgerEntries(state, reduction.items),
    pendingNotifications: state.notificationLedger.pendingNotifications,
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
  const acknowledgedNotificationLedgerEntries =
    notificationAction === "acknowledge-current"
      ? createAcknowledgedNotificationLedgerEntries(notificationInput)
      : Object.freeze([]);
  const recalculatedSelection = selectDiscordNotifications(notificationInput);
  let notificationSelection: DiscordNotificationSelection;
  if (notificationAction === "acknowledge-current") {
    const acknowledgedKeys = new Set(
      acknowledgedNotificationLedgerEntries.map((entry) => entry.notificationKey),
    );
    const pendingNotifications = recalculatedSelection.pendingNotifications.filter(
      (pending) => !acknowledgedKeys.has(pending.notificationKey),
    );
    notificationSelection = Object.freeze({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: emptyCandidates,
      ledgerReservations: emptyLedgerReservations,
      pendingNotifications: Object.freeze(pendingNotifications),
    });
  } else if (notificationAction === "hold") {
    notificationSelection = Object.freeze({
      action: "skip_digest",
      reason: "held",
      candidates: emptyCandidates,
      ledgerReservations: emptyLedgerReservations,
      pendingNotifications: recalculatedSelection.pendingNotifications,
    });
  } else {
    notificationSelection = recalculatedSelection;
  }
  const notificationLedgerEntriesToMerge =
    notificationAction === "acknowledge-current"
      ? acknowledgedNotificationLedgerEntries
      : notificationSelection.ledgerReservations;
  const notificationPendingToMerge = notificationSelection.pendingNotifications;
  return Object.freeze({
    snapshot,
    historyInputEvents: stateHistoryInputEvents(reduction),
    notificationLedger: mergeNotificationLedger(
      state,
      notificationLedgerEntriesToMerge,
      notificationPendingToMerge,
    ),
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
    personalReminderCauseCount: metrics.personalReminderCauseCount,
    personalReminderAiCallCount: metrics.personalReminderAiCallCount,
    personalReminderAiCacheHitCount: metrics.personalReminderAiCacheHitCount,
    personalReminderAssessmentReuseCount: metrics.personalReminderAssessmentReuseCount,
    personalReminderUnknownCount: metrics.personalReminderUnknownCount,
    personalReminderFailedCount: metrics.personalReminderFailedCount,
    personalReminderDeferredCount: metrics.personalReminderDeferredCount,
    personalReminderNotEvaluatedCount: metrics.personalReminderNotEvaluatedCount,
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
    schemaVersion: "2",
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
    schemaVersion: "12",
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
    personalReminderAiCacheEntries: state.session.pendingPersonalReminderAiCacheEntries(),
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
  if (configuration.target.kind === "sandbox") {
    await state.session.publish();
  }
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

function notificationLedgerEntry(
  entry: StateNotificationLedger["entries"][number],
): NotificationLedgerEntry {
  const fields = {
    notificationKey: entry.notificationKey,
    itemNodeId: createGitHubNodeId(entry.itemNodeId),
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    reservedAt: createUtcIsoDateTime(entry.reservedAt),
  };
  if (entry.status === "reserved") {
    return Object.freeze({
      ...fields,
      status: "reserved",
      expiresAt: createUtcIsoDateTime(entry.expiresAt),
    });
  }
  if (entry.status === "delivery_started") {
    return Object.freeze({
      ...fields,
      status: "delivery_started",
      deliveryId: entry.deliveryId,
      startedAt: createUtcIsoDateTime(entry.startedAt),
    });
  }
  if (entry.status === "sent") {
    return Object.freeze({
      ...fields,
      status: "sent",
      sentAt: createUtcIsoDateTime(entry.sentAt),
      discordMessageId: entry.discordMessageId,
    });
  }
  return Object.freeze({
    ...fields,
    status: "acknowledged",
    acknowledgedAt: createUtcIsoDateTime(entry.acknowledgedAt),
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

type NotificationHistoryContext = Readonly<{
  candidateByNodeId: ReadonlyMap<GitHubNodeId, DiscordNotificationCandidate>;
  itemByNodeId: ReadonlyMap<GitHubNodeId, StateSnapshot["items"][number]>;
  candidateMessageIds: Map<GitHubNodeId, string>;
  sentNotificationKeys: Set<string>;
}>;

function createNotificationHistoryContext(
  snapshot: StateSnapshot,
  selection: DiscordNotificationSelection,
): NotificationHistoryContext {
  const candidateByNodeId = new Map<GitHubNodeId, DiscordNotificationCandidate>(
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
  return {
    candidateByNodeId,
    itemByNodeId,
    candidateMessageIds: new Map(),
    sentNotificationKeys: new Set(),
  };
}

type SentNotificationLedgerEntry = Extract<NotificationLedgerEntry, { status: "sent" }>;

function createNotificationHistoryEventsForMessage(
  snapshot: StateSnapshot,
  context: NotificationHistoryContext,
  entries: readonly NotificationLedgerEntry[],
): readonly StateHistoryNotificationEvent[] {
  const firstEntry = entries[0];
  assertNonNullable(firstEntry, "Discord送信結果にledger entryがありません");
  if (firstEntry.status !== "sent") {
    throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
  }
  const discordMessageId = firstEntry.discordMessageId;
  const entriesByMessageAndItem = new Map<GitHubNodeId, SentNotificationLedgerEntry[]>();
  const messageNotificationKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "sent") {
      throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
    }
    if (entry.discordMessageId !== discordMessageId) {
      throw new TypeError("同じDiscord messageの送信結果に異なるmessage IDがあります");
    }
    if (
      context.sentNotificationKeys.has(entry.notificationKey) ||
      messageNotificationKeys.has(entry.notificationKey)
    ) {
      throw new TypeError("Discord送信結果のnotification keyが重複しています");
    }
    messageNotificationKeys.add(entry.notificationKey);
    const itemEntries = entriesByMessageAndItem.get(entry.itemNodeId);
    if (itemEntries == null) {
      entriesByMessageAndItem.set(entry.itemNodeId, [entry]);
    } else {
      itemEntries.push(entry);
    }
  }
  const candidateMessageIds = new Map<GitHubNodeId, string>();
  const events: StateHistoryNotificationEvent[] = [];
  for (const [itemNodeId, itemEntries] of entriesByMessageAndItem) {
    const candidate = context.candidateByNodeId.get(itemNodeId);
    if (candidate == null) {
      throw new TypeError("Discord送信結果のitemが通知候補にありません");
    }
    const previousMessageId = context.candidateMessageIds.get(itemNodeId);
    if (previousMessageId != null) {
      throw new TypeError("同じitemが複数のDiscord messageへ送信されています");
    }
    const candidateReasonsByKey = new Map(
      candidate.reasons.map((reason) => [reason.notificationKey, reason]),
    );
    if (candidateReasonsByKey.size !== candidate.reasons.length) {
      throw new TypeError("通知候補のnotification keyが重複しています");
    }
    const reasonsByKey = new Map<string, (typeof candidate.reasons)[number]>();
    let sentAt: UtcIsoDateTime | undefined;
    for (const entry of itemEntries) {
      if (entry.itemNodeId !== candidate.itemNodeId) {
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
      if (entry.severity !== candidateReason.severity) {
        throw new TypeError("Discord送信結果と通知理由のseverityが一致しません");
      }
      reasonsByKey.set(entry.notificationKey, candidateReason);
      if (sentAt == null) {
        sentAt = entry.sentAt;
      } else if (sentAt !== entry.sentAt) {
        throw new TypeError("同じDiscord messageの通知送信時刻が一致しません");
      }
    }
    if (reasonsByKey.size === 0) {
      throw new TypeError("Discord送信結果の通知理由がありません");
    }
    const sentReasons = candidate.reasons.filter((reason) =>
      reasonsByKey.has(reason.notificationKey),
    );
    const reasons = sentReasons.map((reason) =>
      createNotificationReason(reason.reasonCode, reason.threshold),
    );
    const item = context.itemByNodeId.get(itemNodeId);
    assertNonNullable(item, "通知送信eventの対象itemがsnapshotにありません");
    assertNonNullable(sentAt, "Discord送信eventの送信時刻がありません");
    const personalReminders = sentReasons.flatMap((reason) => {
      if (reason.source.kind !== "personal_reminder") {
        return [];
      }
      if (reason.severity === "none") {
        throw new TypeError("個人催促通知理由のseverityがnoneです");
      }
      const context = reason.source.context;
      return [
        Object.freeze({
          notificationKey: reason.notificationKey,
          causeId: context.causeId,
          responsibilityId: context.responsibilityId,
          responsible: [...context.responsible],
          action: context.action,
          reason: createNotificationReason(reason.reasonCode, reason.threshold),
          obligationSince: context.obligationSince,
          actionableSince: context.actionableSince,
          stallSince: context.stallSince,
          severity: reason.severity,
        }),
      ];
    });
    candidateMessageIds.set(itemNodeId, discordMessageId);
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
      personalReminders,
      severity: calculateDiscordNotificationCandidateSeverity(sentReasons),
      sentAt,
    });
  }
  for (const notificationKey of messageNotificationKeys) {
    context.sentNotificationKeys.add(notificationKey);
  }
  for (const [itemNodeId] of candidateMessageIds) {
    context.candidateMessageIds.set(itemNodeId, discordMessageId);
  }
  return Object.freeze(events);
}

function createNotificationHistoryEvents(
  snapshot: StateSnapshot,
  selection: DiscordNotificationSelection,
  delivery: DiscordDigestDelivery,
): readonly StateHistoryNotificationEvent[] {
  if (delivery.status !== "sent") {
    return Object.freeze([]);
  }
  const context = createNotificationHistoryContext(snapshot, selection);
  if (delivery.ledgerEntries.length === 0) {
    throw new TypeError("Discord送信成功結果にledger entryがありません");
  }
  const entriesByMessage = new Map<string, SentNotificationLedgerEntry[]>();
  for (const entry of delivery.ledgerEntries) {
    if (entry.status !== "sent") {
      throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
    }
    const entries = entriesByMessage.get(entry.discordMessageId);
    if (entries == null) {
      entriesByMessage.set(entry.discordMessageId, [entry]);
    } else {
      entries.push(entry);
    }
  }
  const deliveryMessageIds = new Set(delivery.discordMessageIds);
  if (deliveryMessageIds.size !== delivery.discordMessageIds.length) {
    throw new TypeError("Discord送信結果のmessage IDが重複しています");
  }
  const events: StateHistoryNotificationEvent[] = [];
  for (const [discordMessageId, entries] of entriesByMessage) {
    if (!deliveryMessageIds.has(discordMessageId)) {
      throw new TypeError("Discord送信結果のledgerにないmessage IDがあります");
    }
    events.push(...createNotificationHistoryEventsForMessage(snapshot, context, entries));
  }
  if (context.candidateMessageIds.size !== context.candidateByNodeId.size) {
    throw new TypeError("Discord送信結果のitem数が通知候補と一致しません");
  }
  if (deliveryMessageIds.size !== entriesByMessage.size) {
    throw new TypeError("Discord送信結果のmessage数がledgerと一致しません");
  }
  return Object.freeze(events);
}

type DiscordDigestSelection = Extract<DiscordNotificationSelection, { action: "create_digest" }>;
type SkippedDiscordDigestSelection = Extract<
  DiscordNotificationSelection,
  { action: "skip_digest" }
>;

function nonEmptyNotificationReasons(
  reasons: readonly DiscordNotificationCandidate["reasons"][number][],
  itemNodeId: GitHubNodeId,
): DiscordNotificationCandidate["reasons"] {
  const [first, ...rest] = reasons;
  assertNonNullable(first, `${itemNodeId}の通知理由がありません`);
  return Object.freeze([first, ...rest]);
}

function nonEmptyNotificationCandidates(
  candidates: readonly DiscordDigestSelection["candidates"][number][],
): DiscordDigestSelection["candidates"] {
  const [first, ...rest] = candidates;
  assertNonNullable(first, "通知候補がありません");
  return Object.freeze([first, ...rest]);
}

function nonEmptyNotificationReservations(
  reservations: readonly DiscordDigestSelection["ledgerReservations"][number][],
): DiscordDigestSelection["ledgerReservations"] {
  const [first, ...rest] = reservations;
  assertNonNullable(first, "通知候補に対応するledger予約がありません");
  return Object.freeze([first, ...rest]);
}

function filterNotificationSelectionForLedger(
  selection: DiscordNotificationSelection,
  ledgerEntries: ReadonlyMap<string, NotificationLedgerEntry>,
): DiscordNotificationSelection {
  const emptyCandidates: SkippedDiscordDigestSelection["candidates"] = Object.freeze([]);
  const emptyReservations: SkippedDiscordDigestSelection["ledgerReservations"] = Object.freeze([]);
  const pendingNotifications = Object.freeze(
    selection.pendingNotifications.filter((pending) => {
      const entry = ledgerEntries.get(pending.notificationKey);
      return entry?.status !== "sent" && entry?.status !== "acknowledged";
    }),
  );
  if (selection.action === "skip_digest") {
    return Object.freeze({
      action: "skip_digest",
      reason: selection.reason,
      candidates: emptyCandidates,
      ledgerReservations: emptyReservations,
      pendingNotifications,
    });
  }
  const candidates = selection.candidates.flatMap((candidate) => {
    const reasons = candidate.reasons.filter((reason) => {
      const entry = ledgerEntries.get(reason.notificationKey);
      return entry?.status !== "sent" && entry?.status !== "acknowledged";
    });
    if (reasons.length === 0) {
      return [];
    }
    const nonEmptyReasons = nonEmptyNotificationReasons(reasons, candidate.itemNodeId);
    return [
      Object.freeze({
        ...candidate,
        reasons: nonEmptyReasons,
        severity: calculateDiscordNotificationCandidateSeverity(nonEmptyReasons),
      }),
    ];
  });
  const candidateKeys = new Set(
    candidates.flatMap((candidate) => candidate.reasons.map((reason) => reason.notificationKey)),
  );
  const ledgerReservations = selection.ledgerReservations.filter((reservation) =>
    candidateKeys.has(reservation.notificationKey),
  );
  if (candidates.length === 0) {
    return Object.freeze({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: emptyCandidates,
      ledgerReservations: emptyReservations,
      pendingNotifications,
    });
  }
  return Object.freeze({
    action: "create_digest",
    candidates: nonEmptyNotificationCandidates(candidates),
    ledgerReservations: nonEmptyNotificationReservations(ledgerReservations),
    pendingNotifications,
  });
}

function notificationLedgerEntryIdentityMatches(
  left: NotificationLedgerEntry,
  right: NotificationLedgerEntry,
): boolean {
  return (
    left.notificationKey === right.notificationKey &&
    left.itemNodeId === right.itemNodeId &&
    left.reasonCode === right.reasonCode &&
    left.severity === right.severity &&
    left.reservedAt === right.reservedAt
  );
}

function assertNotificationDeliveryBatch(
  selection: DiscordDigestSelection,
  currentEntriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  entries: readonly NotificationLedgerEntry[],
): void {
  const firstEntry = entries[0];
  assertNonNullable(firstEntry, "Discord送信結果にledger entryがありません");
  if (firstEntry.status === "acknowledged") {
    throw new TypeError("Discord送信callbackに確認済みledger entryを渡せません");
  }
  for (const entry of entries) {
    if (entry.status !== firstEntry.status) {
      throw new TypeError("Discord送信callbackのledger statusが一致しません");
    }
  }

  const candidateByKey = new Map<
    string,
    Readonly<{
      candidate: DiscordNotificationCandidate;
      reason: DiscordNotificationCandidate["reasons"][number];
    }>
  >();
  for (const candidate of selection.candidates) {
    for (const reason of candidate.reasons) {
      if (candidateByKey.has(reason.notificationKey)) {
        throw new TypeError("通知候補のnotification keyが重複しています");
      }
      candidateByKey.set(reason.notificationKey, { candidate, reason });
    }
  }

  const reservationByKey = new Map<
    string,
    Extract<NotificationLedgerEntry, { status: "reserved" }>
  >();
  for (const reservation of selection.ledgerReservations) {
    if (reservationByKey.has(reservation.notificationKey)) {
      throw new TypeError("通知予約のnotification keyが重複しています");
    }
    reservationByKey.set(reservation.notificationKey, reservation);
  }
  if (candidateByKey.size !== reservationByKey.size) {
    throw new TypeError("通知候補とledger予約の件数が一致しません");
  }
  for (const notificationKey of candidateByKey.keys()) {
    if (!reservationByKey.has(notificationKey)) {
      throw new TypeError("通知候補とledger予約が一致しません");
    }
  }

  const keysByItemNodeId = new Map<GitHubNodeId, Set<string>>();
  for (const entry of entries) {
    const candidateEntry = candidateByKey.get(entry.notificationKey);
    if (candidateEntry == null) {
      throw new TypeError("Discord送信結果のnotification keyが通知候補にありません");
    }
    const reservation = reservationByKey.get(entry.notificationKey);
    assertNonNullable(reservation, "Discord送信結果に対応する通知予約がありません");
    if (
      !notificationLedgerEntryIdentityMatches(entry, reservation) ||
      entry.itemNodeId !== candidateEntry.candidate.itemNodeId ||
      entry.reasonCode !== candidateEntry.reason.reasonCode ||
      entry.severity !== candidateEntry.reason.severity ||
      reservation.severity !== candidateEntry.reason.severity
    ) {
      throw new TypeError("Discord送信結果と通知候補またはledger予約が一致しません");
    }
    const currentEntry = currentEntriesByKey.get(entry.notificationKey);
    assertNonNullable(currentEntry, "Discord送信結果の現在ledger entryがありません");
    if (!notificationLedgerEntryIdentityMatches(currentEntry, entry)) {
      throw new TypeError("Discord送信結果と現在の通知ledgerが一致しません");
    }
    let itemKeys = keysByItemNodeId.get(entry.itemNodeId);
    if (itemKeys == null) {
      itemKeys = new Set<string>();
      keysByItemNodeId.set(entry.itemNodeId, itemKeys);
    }
    if (itemKeys.has(entry.notificationKey)) {
      throw new TypeError("Discord送信callbackのnotification keyが重複しています");
    }
    itemKeys.add(entry.notificationKey);

    if (firstEntry.status === "delivery_started") {
      if (entry.status !== "delivery_started") {
        throw new TypeError("Discord送信callbackのledger statusが一致しません");
      }
      if (currentEntry.status !== "reserved") {
        throw new TypeError("送信開始callbackは対応する通知予約から遷移させてください");
      }
      if (!notificationLedgerEntryIdentityMatches(currentEntry, reservation)) {
        throw new TypeError("送信開始callbackは対応する通知予約から遷移させてください");
      }
      if (
        currentEntry.expiresAt !== reservation.expiresAt ||
        entry.startedAt < entry.reservedAt ||
        entry.startedAt > reservation.expiresAt ||
        !DISCORD_DELIVERY_ID_PATTERN.test(entry.deliveryId)
      ) {
        throw new TypeError("送信開始callbackは対応する通知予約から遷移させてください");
      }
      if (entry.deliveryId !== firstEntry.deliveryId || entry.startedAt !== firstEntry.startedAt) {
        throw new TypeError("同じDiscord messageの送信開始時刻が一致しません");
      }
    } else if (firstEntry.status === "sent") {
      if (entry.status !== "sent") {
        throw new TypeError("Discord送信callbackのledger statusが一致しません");
      }
      if (
        currentEntry.status !== "delivery_started" ||
        currentEntry.startedAt < currentEntry.reservedAt ||
        entry.sentAt < currentEntry.startedAt
      ) {
        throw new TypeError("送信済みcallbackは送信開始済み通知から遷移させてください");
      }
      const firstCurrentEntry = currentEntriesByKey.get(firstEntry.notificationKey);
      assertNonNullable(firstCurrentEntry, "Discord送信結果の先頭entryが現在ledgerにありません");
      if (
        firstCurrentEntry.status !== "delivery_started" ||
        currentEntry.deliveryId !== firstCurrentEntry.deliveryId ||
        currentEntry.startedAt !== firstCurrentEntry.startedAt ||
        entry.sentAt !== firstEntry.sentAt ||
        entry.discordMessageId !== firstEntry.discordMessageId
      ) {
        throw new TypeError("同じDiscord messageの送信結果が一致しません");
      }
    } else {
      if (entry.status !== "reserved") {
        throw new TypeError("Discord送信callbackのledger statusが一致しません");
      }
      if (currentEntry.status !== "delivery_started" || entry.expiresAt !== reservation.expiresAt) {
        throw new TypeError("予約復帰callbackは送信開始済み通知から遷移させてください");
      }
      const firstCurrentEntry = currentEntriesByKey.get(firstEntry.notificationKey);
      assertNonNullable(firstCurrentEntry, "Discord送信結果の先頭entryが現在ledgerにありません");
      if (
        firstCurrentEntry.status !== "delivery_started" ||
        currentEntry.deliveryId !== firstCurrentEntry.deliveryId ||
        currentEntry.startedAt !== firstCurrentEntry.startedAt
      ) {
        throw new TypeError("同じDiscord messageの予約復帰結果が一致しません");
      }
    }
  }

  for (const [itemNodeId, itemKeys] of keysByItemNodeId) {
    const candidate = selection.candidates.find((value) => value.itemNodeId === itemNodeId);
    assertNonNullable(candidate, "Discord送信結果のitemが通知候補にありません");
    const candidateKeys = new Set(candidate.reasons.map((reason) => reason.notificationKey));
    if (
      itemKeys.size !== candidateKeys.size ||
      [...candidateKeys].some((notificationKey) => !itemKeys.has(notificationKey))
    ) {
      throw new TypeError("Discord送信結果の通知理由数が候補と一致しません");
    }
  }
}

function assertNoStartedNotificationDelivery(
  selection: DiscordNotificationSelection,
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): void {
  for (const candidate of selection.candidates) {
    for (const reason of candidate.reasons) {
      const entry = entriesByKey.get(reason.notificationKey);
      if (entry?.status === "delivery_started") {
        throw new TypeError(
          `通知 ${reason.notificationKey} は送信開始済みです。delivery ID: ${entry.deliveryId}。手動解決を実行してください: resolve-discord-delivery --delivery-id ${entry.deliveryId} --resolution retry または acknowledge`,
        );
      }
    }
  }
}

function createNotificationLedgerFromMaps(
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  operationsAlertsByKey: ReadonlyMap<string, OperationsAlertLedgerEntry>,
  pendingNotifications: readonly PendingNotification[],
): StateNotificationLedger {
  return createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: [...entriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
    pendingNotifications,
  });
}

function assertNotificationDeliveryLedgerConsistency(
  delivery: DiscordDigestDelivery,
  savedEntries: readonly NotificationLedgerEntry[],
): void {
  if (delivery.status !== "sent") {
    if (savedEntries.length !== 0) {
      throw new TypeError("Discord送信結果がないのに送信済みledger entryがあります");
    }
    return;
  }
  const savedEntriesByKey = new Map(savedEntries.map((entry) => [entry.notificationKey, entry]));
  if (savedEntriesByKey.size !== savedEntries.length) {
    throw new TypeError("callbackで保存したDiscord送信結果のnotification keyが重複しています");
  }
  if (delivery.ledgerEntries.length !== savedEntries.length) {
    throw new TypeError("Discord送信結果とcallbackで保存したledgerの件数が一致しません");
  }
  for (const entry of delivery.ledgerEntries) {
    const savedEntry = savedEntriesByKey.get(entry.notificationKey);
    if (
      savedEntry == null ||
      serializeCanonicalJson(savedEntry) !== serializeCanonicalJson(entry)
    ) {
      throw new TypeError("Discord送信結果とcallbackで保存したledgerが一致しません");
    }
  }
}

function notificationCountForSelection(
  selection: DiscordNotificationSelection,
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): number {
  const notificationKeys = new Set(
    selection.candidates.flatMap((candidate) =>
      candidate.reasons.map((reason) => reason.notificationKey),
    ),
  );
  let count = 0;
  for (const notificationKey of notificationKeys) {
    if (entriesByKey.get(notificationKey)?.status === "sent") {
      count += 1;
    }
  }
  return count;
}

function latestSentAtForSelection(
  selection: DiscordNotificationSelection,
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): UtcIsoDateTime | null {
  const notificationKeys = new Set(
    selection.candidates.flatMap((candidate) =>
      candidate.reasons.map((reason) => reason.notificationKey),
    ),
  );
  let latestSentAt: UtcIsoDateTime | null = null;
  for (const notificationKey of notificationKeys) {
    const entry = entriesByKey.get(notificationKey);
    if (entry?.status !== "sent") {
      continue;
    }
    if (latestSentAt == null || entry.sentAt > latestSentAt) {
      latestSentAt = entry.sentAt;
    }
  }
  return latestSentAt;
}

function snapshotPersonalReminderSelectionValidationItems(
  snapshot: StateSnapshot,
  config: Config,
): readonly DiscordPersonalReminderSelectionValidationItem[] {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(config));
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  if (repositoriesById.size !== snapshot.repositories.length) {
    throw new TypeError("送信直前検証対象のsnapshot repository IDが重複しています");
  }
  return Object.freeze(
    snapshot.items.map((item) => {
      const repository = repositoriesById.get(item.repositoryId);
      assertNonNullable(repository, `${item.nodeId}のsnapshot repositoryがありません`);
      const repositoryName = `${repository.owner}/${repository.name}`;
      const staleness = recalculateStalenessSeverity({
        evaluatedAt: snapshot.generatedAt,
        stallSince: item.stallSince,
        confidence: item.confidence,
        minimumAiConfidence: config.ai.confidence.medium,
        repositoryFullName: repositoryName,
        currentLabels: item.labels,
        resolveLabelEffects,
        thresholdsHours: config.staleness.thresholdsHours,
        severityContext: item.severityContext,
      });
      const personalReminderCauses = Object.freeze(
        item.personalReminderCauses.map((cause) =>
          Object.freeze({
            cause,
            staleness: calculatePersonalReminderStaleness({
              cause,
              evaluatedAt: snapshot.generatedAt,
              minimumAiConfidence: config.ai.confidence.medium,
              repositoryFullName: repositoryName,
              currentLabels: item.labels,
              resolveLabelEffects,
              thresholdsHours: config.staleness.thresholdsHours,
            }),
          }),
        ),
      );
      return Object.freeze({
        nodeId: item.nodeId,
        current: Object.freeze({
          status: item.status,
          waitingOn: item.waitingOn,
          severity: staleness.severity,
          severityReason: staleness.severityReason,
          waitClass: staleness.waitClass,
          statusSince: item.statusSince,
          ownerSince: item.ownerSince,
          stallSince: item.stallSince,
          lastProgressAt: item.lastProgressAt,
        }),
        personalReminderCauses,
        personalReminderCausePlanning: item.personalReminderCausePlanning,
      });
    }),
  );
}

async function deliverDiscord(
  adapters: ProductionRuntimeAdapters,
  config: Config,
  settings: DiscordDeliverySettings,
  state: RuntimeState,
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
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
  const persistedSnapshot = await state.session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord通知対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== validated.snapshot.run.id) {
    throw new TypeError("Discord通知対象のrunがstate snapshotと一致しません");
  }
  const snapshot = persistedSnapshot.snapshot;
  const persistedLedger = await state.session.loadNotificationLedger();
  let notificationEntriesByKey = new Map<string, NotificationLedgerEntry>(
    persistedLedger.entries.map((entry): readonly [string, NotificationLedgerEntry] => {
      const normalizedEntry = notificationLedgerEntry(entry);
      return [normalizedEntry.notificationKey, normalizedEntry];
    }),
  );
  let operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    persistedLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  let pendingNotifications: readonly PendingNotification[] = Object.freeze(
    persistedLedger.pendingNotifications.filter((pending) => {
      const entry = notificationEntriesByKey.get(pending.notificationKey);
      return entry?.status !== "sent" && entry?.status !== "acknowledged";
    }),
  );
  assertNoStartedNotificationDelivery(validated.notificationSelection, notificationEntriesByKey);
  const notificationSelection = filterNotificationSelectionForLedger(
    validated.notificationSelection,
    notificationEntriesByKey,
  );
  if (notificationSelection.action === "create_digest") {
    assertDiscordPersonalReminderSelectionMatchesSnapshot(
      notificationSelection,
      snapshotPersonalReminderSelectionValidationItems(snapshot, config),
    );
  }
  const notificationHistoryContext = createNotificationHistoryContext(
    snapshot,
    notificationSelection,
  );
  const sentNotificationEntries: SentNotificationLedgerEntry[] = [];
  const notificationEvents: StateHistoryNotificationEvent[] = [];

  const persistDelivery = async (
    notificationLedger: StateNotificationLedger,
    events: readonly StateHistoryNotificationEvent[],
    committedAt: UtcIsoDateTime,
  ): Promise<void> => {
    await state.session.persistNotificationDelivery({
      snapshot,
      notificationEvents: events,
      notificationLedger,
      committedAt,
      repositoryInventory,
      knownSecrets,
    });
    await state.session.publish();
  };

  const delivery = await adapters.sendDiscord({
    candidates: notificationSelection.candidates,
    ledgerReservations: notificationSelection.ledgerReservations,
    items: snapshot.items,
    generatedAt: snapshot.generatedAt,
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
        recordNotifications: async (entries) => {
          const firstEntry = entries[0];
          assertNonNullable(firstEntry, "Discord送信結果にledger entryがありません");
          if (notificationSelection.action !== "create_digest") {
            throw new TypeError("通知候補がないdigestから通知ledger callbackを呼び出せません");
          }
          assertNotificationDeliveryBatch(notificationSelection, notificationEntriesByKey, entries);
          let messageEvents: readonly StateHistoryNotificationEvent[] = Object.freeze([]);
          let committedAt: UtcIsoDateTime;
          switch (firstEntry.status) {
            case "delivery_started":
              committedAt = firstEntry.startedAt;
              break;
            case "reserved":
              committedAt = createUtcIsoDateTime(adapters.now().toISOString());
              break;
            case "sent":
              messageEvents = createNotificationHistoryEventsForMessage(
                snapshot,
                notificationHistoryContext,
                entries,
              );
              committedAt = firstEntry.sentAt;
              break;
            case "acknowledged":
              throw new TypeError("Discord送信callbackに確認済みledger entryを渡せません");
          }
          const nextEntriesByKey = new Map(notificationEntriesByKey);
          for (const entry of entries) {
            nextEntriesByKey.set(entry.notificationKey, entry);
          }
          const sentKeys = new Set(
            firstEntry.status === "sent" ? entries.map((entry) => entry.notificationKey) : [],
          );
          const nextPendingNotifications = Object.freeze(
            pendingNotifications.filter((pending) => !sentKeys.has(pending.notificationKey)),
          );
          const notificationLedger = createNotificationLedgerFromMaps(
            nextEntriesByKey,
            operationsAlertsByKey,
            nextPendingNotifications,
          );
          await persistDelivery(notificationLedger, messageEvents, committedAt);
          notificationEntriesByKey = nextEntriesByKey;
          pendingNotifications = nextPendingNotifications;
          if (firstEntry.status === "sent") {
            for (const entry of entries) {
              if (entry.status !== "sent") {
                throw new TypeError("Discord送信結果のstatusが一致しません");
              }
              sentNotificationEntries.push(entry);
            }
          }
          notificationEvents.push(...messageEvents);
        },
        recordOperationsAlert: async (entry) => {
          const nextOperationsAlertsByKey = new Map(operationsAlertsByKey);
          nextOperationsAlertsByKey.set(entry.alertKey, entry);
          const notificationLedger = createNotificationLedgerFromMaps(
            notificationEntriesByKey,
            nextOperationsAlertsByKey,
            pendingNotifications,
          );
          await persistDelivery(notificationLedger, Object.freeze([]), entry.sentAt);
          operationsAlertsByKey = nextOperationsAlertsByKey;
        },
      },
    },
  });
  const sentAt = latestSentAtForSelection(notificationSelection, notificationEntriesByKey);
  assertNotificationDeliveryLedgerConsistency(delivery, sentNotificationEntries);
  const returnedNotificationEvents = createNotificationHistoryEvents(
    snapshot,
    notificationSelection,
    delivery,
  );
  if (
    serializeCanonicalJson(returnedNotificationEvents) !==
    serializeCanonicalJson(notificationEvents)
  ) {
    throw new TypeError("Discord送信結果とcallbackで保存した通知履歴が一致しません");
  }
  const notificationLedger = createNotificationLedgerFromMaps(
    notificationEntriesByKey,
    operationsAlertsByKey,
    pendingNotifications,
  );
  return Object.freeze({
    value: Object.freeze({
      delivery,
      notificationEvents: Object.freeze(notificationEvents),
    }),
    notificationEvents: Object.freeze(notificationEvents),
    notificationLedger,
    notificationCount: notificationCountForSelection(
      notificationSelection,
      notificationEntriesByKey,
    ),
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
  const persistedSnapshot = await state.session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("run完了対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== validated.snapshot.run.id) {
    throw new TypeError("run完了対象のrunがstate snapshotと一致しません");
  }
  const snapshot = persistedSnapshot.snapshot;
  const trackingStartAt = completedSnapshotTrackingStartAt(config, snapshot, completedAt);
  await state.session.persistRunCompletion({
    snapshot: createStateSnapshot({
      ...snapshot,
      trackingStartAt,
    }),
    notificationEvents: Object.freeze([]),
    notificationLedger: delivery.notificationLedger,
    runReport: createPersistedRunReport(
      snapshot,
      runMetadata,
      delivery.notificationCount,
      completedAt,
    ),
    repositoryInventory,
    knownSecrets,
  });
  await state.session.publish();
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
  const currentNotificationLedger = await state.session.loadNotificationLedger();
  const notificationEntriesByKey = new Map<string, NotificationLedgerEntry>(
    currentNotificationLedger.entries.map((entry): readonly [string, NotificationLedgerEntry] => {
      const normalizedEntry = notificationLedgerEntry(entry);
      return [normalizedEntry.notificationKey, normalizedEntry];
    }),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    currentNotificationLedger.operationsAlerts.map((entry) => [
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
        notificationLedger: currentNotificationLedger,
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
        notificationLedger: currentNotificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: [...notificationEntriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
    pendingNotifications: currentNotificationLedger.pendingNotifications,
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
  await state.session.publish();
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

function personalReminderDetailNodeIdsForCollection(
  state: RuntimeState,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  aiEnabled: boolean,
): ReadonlySet<GitHubNodeId> {
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const relationCandidateConsumerNodeIds =
    previousPersonalReminderRelationCandidateConsumerNodeIds(state);
  const potentialContinuityConflictNodeIds =
    determinePotentialPersonalReminderContinuityConflictNodeIds(
      [...previousItemsByNodeId.values()].flatMap((item) => item.personalReminderCauses),
    );
  const nodeIds = new Set<GitHubNodeId>();
  for (const item of enumeratedItems) {
    const previous = previousItemsByNodeId.get(item.nodeId);
    if (previous == null) {
      continue;
    }
    if (potentialContinuityConflictNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    if (relationCandidateConsumerNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    if (
      previous.personalReminderCausePlanning.status === "pending" ||
      previous.personalReminderCausePlanning.planningVersion !==
        PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
    ) {
      if (item.state === "open") {
        nodeIds.add(item.nodeId);
      }
    }
    if (previous.personalReminderCauses.length !== 0) {
      if (item.state !== "open") {
        nodeIds.add(item.nodeId);
      }
      if (aiEnabled) {
        for (const cause of previous.personalReminderCauses) {
          if (currentPersonalReminderAssessment(cause).status !== "available") {
            nodeIds.add(item.nodeId);
            break;
          }
        }
      }
    }
  }
  return nodeIds;
}

function personalReminderReplanNodeIdsForCollection(
  state: RuntimeState,
  enumeratedItems: readonly EnumeratedGitHubItem[],
): ReadonlySet<GitHubNodeId> {
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const potentialContinuityConflictNodeIds =
    determinePotentialPersonalReminderContinuityConflictNodeIds(
      [...previousItemsByNodeId.values()].flatMap((item) => item.personalReminderCauses),
    );
  const nodeIds = new Set<GitHubNodeId>();
  for (const item of enumeratedItems) {
    const previous = previousItemsByNodeId.get(item.nodeId);
    if (previous == null) {
      continue;
    }
    if (potentialContinuityConflictNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    if (item.state !== "open") {
      continue;
    }
    if (
      previous.personalReminderCausePlanning.status === "pending" ||
      previous.personalReminderCausePlanning.planningVersion !==
        PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
    ) {
      nodeIds.add(item.nodeId);
    }
  }
  return nodeIds;
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
  forcedDetailNodeIds: ReadonlySet<GitHubNodeId>,
): Promise<FreshRepositoryItemCollection> {
  const allowlist = createPublicRepositoryAllowlist([repository]);
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const currentNodeIds = new Set(enumeratedItems.map((item) => item.nodeId));
  const previousAiAnalysisStatusesByNodeId = new Map(
    (previousSnapshot(state)?.items ?? []).map(
      (item) => [item.nodeId, item.aiAnalysis.status] as const,
    ),
  );
  const currentAnalysisPlanFingerprintsByNodeId = new Map(
    enumeratedItems.map((item) => [item.nodeId, analysisPlanFingerprintForItem(item, identity)]),
  );
  const plan = planIncrementalItemCollection({
    items: enumeratedItems,
    previous: previousItemCollection(state, repository),
    previousAiAnalysisStatusesByNodeId,
    currentAnalysisPlanFingerprintsByNodeId,
    adjacentItemNodeIds: new Set(
      [...adjacentNodeIds].filter((nodeId) => currentNodeIds.has(nodeId)),
    ),
  });
  const personalReminderDetailNodeIds = personalReminderDetailNodeIdsForCollection(
    state,
    enumeratedItems,
    configuration.config.ai.enabled,
  );
  const personalReminderReplanNodeIds = personalReminderReplanNodeIdsForCollection(
    state,
    enumeratedItems,
  );
  const staleRepositoryBlockerTopologyNodeIds =
    previousStaleRepositoryBlockerTopologyNodeIds(state);
  const detailNodeIds = new Set([
    ...plan.detailItemNodeIds,
    ...requiredTrackingDetailNodeIds(invocation, configuration, state, repository, enumeratedItems),
    ...personalReminderDetailNodeIds,
    ...staleRepositoryBlockerTopologyNodeIds,
    ...forcedDetailNodeIds,
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
    analysisPlanChangedNodeIds: plan.analysisPlanChangedItemNodeIds,
    personalReminderReplanNodeIds,
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
    new Set<GitHubNodeId>(),
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
    new Set(requestedNodeIds),
  );
  return mergeFreshRepositoryRuntimeCollection(repository, invocation, current, additions);
}

function aggregateFreshRepositoryCollections(
  allowlist: PublicRepositoryAllowlist,
  freshCollectionsByRepositoryId: ReadonlyMap<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
): FreshRuntimeCollectionAggregate {
  const enumeratedItems: EnumeratedGitHubItem[] = [];
  const details: GitHubItemDetail[] = [];
  const observedItems: FreshObservedGitHubItem[] = [];
  const changedNodeIds = new Set<GitHubNodeId>();
  const analysisPlanChangedNodeIds = new Set<GitHubNodeId>();
  const personalReminderReplanNodeIds = new Set<GitHubNodeId>();
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
    for (const nodeId of collection.analysisPlanChangedNodeIds) {
      analysisPlanChangedNodeIds.add(nodeId);
    }
    for (const nodeId of collection.personalReminderReplanNodeIds) {
      personalReminderReplanNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    enumeratedItems: deduplicateByStableId(enumeratedItems, (item) => item.nodeId),
    details: deduplicateByStableId(details, (detail) => detail.nodeId),
    observedItems: deduplicateByStableId(observedItems, (item) => item.nodeId),
    changedNodeIds,
    analysisPlanChangedNodeIds,
    personalReminderReplanNodeIds,
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

function staleTrackedNodeIdsForRelationExpansion(
  state: RuntimeState,
  repositoryResultsById: ReadonlyMap<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): ReadonlySet<GitHubNodeId> {
  const staleRepositoryIds = new Set<GitHubRepositoryId>(
    [...repositoryResultsById.values()]
      .filter((result) => result.freshness === "stale")
      .map((result) => result.repository.id),
  );
  return new Set(
    (previousSnapshot(state)?.items ?? [])
      .filter((item) => staleRepositoryIds.has(item.repositoryId))
      .map((item) => item.nodeId),
  );
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

function personalReminderRelationExpansionRepositoriesByNodeId(
  state: RuntimeState,
  aggregate: FreshRuntimeCollectionAggregate,
  tracking: RuntimeTrackingSelection,
  relationCandidates: readonly RelationCandidate[],
  allowlist: PublicRepositoryAllowlist,
): ReadonlyMap<GitHubNodeId, PublicRepository> {
  const freshObservedNodeIds = new Set<string>(aggregate.observedItems.map((item) => item.nodeId));
  const trackedNodeIds = new Set<string>(tracking.workByNodeId.keys());
  const previousItemsByNodeId = new Map<string, SnapshotCollectionItem>();
  for (const [nodeId, item] of previousCollectionItemsByNodeId(state)) {
    previousItemsByNodeId.set(nodeId, item);
  }
  const externalEndpointNodeIds = new Set<string>();
  for (const candidate of relationCandidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope === "external_public") {
        externalEndpointNodeIds.add(node.nodeId);
      }
    }
  }
  const repositoriesByNodeId = new Map<GitHubNodeId, PublicRepository>();
  for (const dependency of previousPersonalReminderRelationCandidateDependencies(state)) {
    if (
      !freshObservedNodeIds.has(dependency.consumerNodeId) ||
      !trackedNodeIds.has(dependency.consumerNodeId)
    ) {
      continue;
    }
    for (const endpointNodeId of dependency.producer.endpointNodeIds) {
      if (freshObservedNodeIds.has(endpointNodeId) || externalEndpointNodeIds.has(endpointNodeId)) {
        continue;
      }
      const previousCollectionItem = previousItemsByNodeId.get(endpointNodeId);
      if (previousCollectionItem == null) {
        continue;
      }
      const repository = allowlist.repositories.find(
        (candidate) => candidate.id === previousCollectionItem.repositoryId,
      );
      if (repository == null) {
        continue;
      }
      const existing = repositoriesByNodeId.get(previousCollectionItem.nodeId);
      if (existing != null && existing.id !== repository.id) {
        throw new TypeError(
          "個人催促relation candidateの同じendpoint node IDに異なるallowlist repositoryが指定されています",
        );
      }
      repositoriesByNodeId.set(previousCollectionItem.nodeId, repository);
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

function trackedPotentialBlockerTargetNodeIds(
  aggregate: FreshRuntimeCollectionAggregate,
  tracking: RuntimeTrackingSelection,
  candidates: readonly RelationCandidate[],
  requestedNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  const detailNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const candidate of candidates) {
    const potentialTargets =
      candidate.authority === "inferred"
        ? relationNodes(candidate.relation)
        : candidate.relation.type === "blocks"
          ? Object.freeze([candidate.relation.blocked])
          : Object.freeze([]);
    for (const node of potentialTargets) {
      if (
        node.scope !== "organization" ||
        !tracking.workByNodeId.has(node.nodeId) ||
        detailNodeIds.has(node.nodeId) ||
        requestedNodeIds.has(node.nodeId)
      ) {
        continue;
      }
      targetNodeIds.add(node.nodeId);
    }
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

type PotentialBlockerRelationAnalysis = Readonly<{
  candidateId: string;
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  targetNodeIds: readonly GitHubNodeId[];
  ownerNodeId: GitHubNodeId | undefined;
  native: boolean;
}>;

type BlockerRelationAnalysisIndex = Readonly<{
  candidatesById: ReadonlyMap<string, PotentialBlockerRelationAnalysis>;
  candidateIdsByTargetNodeId: ReadonlyMap<GitHubNodeId, ReadonlySet<string>>;
}>;

type BlockerRelationAnalysisTargets = Readonly<{
  freshNodeIds: ReadonlySet<GitHubNodeId>;
  staleNodeIds: ReadonlySet<GitHubNodeId>;
}>;

function normalizedBlockerRelationEndpointNodeIds(
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
): readonly [GraphNodeId, GraphNodeId] {
  const [first, second] = endpointNodeIds;
  if (first === second) {
    throw new TypeError(`blocker関係候補の端点が重複しています。対象: ${first}`);
  }
  return first < second ? Object.freeze([first, second]) : Object.freeze([second, first]);
}

function normalizedBlockerRelationTargetNodeIds(
  targetNodeIds: readonly GitHubNodeId[],
): readonly GitHubNodeId[] {
  return Object.freeze([...new Set(targetNodeIds)].sort());
}

function addPotentialBlockerRelationAnalysis(
  candidatesById: Map<string, PotentialBlockerRelationAnalysis>,
  candidate: PotentialBlockerRelationAnalysis,
): void {
  const normalized = Object.freeze({
    ...candidate,
    endpointNodeIds: normalizedBlockerRelationEndpointNodeIds(candidate.endpointNodeIds),
    targetNodeIds: normalizedBlockerRelationTargetNodeIds(candidate.targetNodeIds),
  });
  const existing = candidatesById.get(candidate.candidateId);
  if (existing == null) {
    candidatesById.set(candidate.candidateId, normalized);
    return;
  }
  if (
    hashCanonicalJson(existing.endpointNodeIds) !== hashCanonicalJson(normalized.endpointNodeIds) ||
    hashCanonicalJson(existing.targetNodeIds) !== hashCanonicalJson(normalized.targetNodeIds) ||
    existing.native !== normalized.native
  ) {
    throw new TypeError(`blocker関係候補の定義が一致しません。対象: ${candidate.candidateId}`);
  }
  if (
    existing.ownerNodeId != null &&
    normalized.ownerNodeId != null &&
    existing.ownerNodeId !== normalized.ownerNodeId
  ) {
    throw new TypeError(`blocker関係候補のownerが一致しません。対象: ${candidate.candidateId}`);
  }
  if (existing.ownerNodeId == null && normalized.ownerNodeId != null) {
    candidatesById.set(
      candidate.candidateId,
      Object.freeze({
        ...existing,
        ownerNodeId: normalized.ownerNodeId,
      }),
    );
  }
}

function createBlockerRelationAnalysisIndex(
  candidatesById: ReadonlyMap<string, PotentialBlockerRelationAnalysis>,
): BlockerRelationAnalysisIndex {
  const candidateIdsByTargetNodeId = new Map<GitHubNodeId, Set<string>>();
  for (const candidate of candidatesById.values()) {
    for (const targetNodeId of candidate.targetNodeIds) {
      const candidateIds = candidateIdsByTargetNodeId.get(targetNodeId);
      if (candidateIds == null) {
        candidateIdsByTargetNodeId.set(targetNodeId, new Set([candidate.candidateId]));
      } else {
        candidateIds.add(candidate.candidateId);
      }
    }
  }
  return Object.freeze({
    candidatesById,
    candidateIdsByTargetNodeId,
  });
}

function previousInferredRelationOwnerNodeId(relation: Relation): GitHubNodeId | undefined {
  if (relation.aiDependency.status === "not_dependent") {
    return undefined;
  }
  const ownerNodeIds = new Set(
    (relation.aiDependency.producers ?? []).flatMap((producer) =>
      producer.kind === "relation" && producer.relationId === relation.id
        ? [producer.producer.nodeId]
        : [],
    ),
  );
  if (ownerNodeIds.size > 1) {
    throw new TypeError(`前回blocker関係候補のownerが一意ではありません。対象: ${relation.id}`);
  }
  return [...ownerNodeIds][0];
}

function previousBlockerRelationAnalysisIndex(
  state: RuntimeState,
  trackedNodeIdsByValue: ReadonlyMap<string, GitHubNodeId>,
): BlockerRelationAnalysisIndex {
  const candidatesById = new Map<string, PotentialBlockerRelationAnalysis>();
  for (const relation of previousSnapshot(state)?.relations ?? []) {
    if (!relation.active) {
      continue;
    }
    const endpointNodeIds = Object.freeze([
      relation.fromNodeId,
      relation.toNodeId,
    ]) satisfies readonly [GraphNodeId, GraphNodeId];
    const potentialTargetNodeIds =
      relation.provenance !== "native"
        ? endpointNodeIds
        : relation.type === "blocks"
          ? Object.freeze([relation.toNodeId])
          : Object.freeze([]);
    const targetNodeIds = potentialTargetNodeIds.flatMap((nodeId) => {
      const targetNodeId = trackedNodeIdsByValue.get(nodeId);
      return targetNodeId == null ? [] : [targetNodeId];
    });
    if (targetNodeIds.length === 0) {
      continue;
    }
    addPotentialBlockerRelationAnalysis(
      candidatesById,
      Object.freeze({
        candidateId: relation.id,
        endpointNodeIds,
        targetNodeIds,
        ownerNodeId:
          relation.provenance === "native"
            ? undefined
            : previousInferredRelationOwnerNodeId(relation),
        native: relation.provenance === "native",
      }),
    );
  }
  for (const producer of previousRelationCandidateDependencyProducers(state)) {
    const targetNodeIds = producer.endpointNodeIds.flatMap((nodeId) => {
      const targetNodeId = trackedNodeIdsByValue.get(nodeId);
      return targetNodeId == null ? [] : [targetNodeId];
    });
    if (targetNodeIds.length === 0) {
      continue;
    }
    addPotentialBlockerRelationAnalysis(
      candidatesById,
      Object.freeze({
        candidateId: producer.candidateId,
        endpointNodeIds: producer.endpointNodeIds,
        targetNodeIds,
        ownerNodeId: producer.producer.nodeId,
        native: false,
      }),
    );
  }
  return createBlockerRelationAnalysisIndex(candidatesById);
}

function currentBlockerRelationAnalysisIndex(
  relationCandidates: readonly RelationCandidate[],
  trackedNodeIdsByValue: ReadonlyMap<string, GitHubNodeId>,
): BlockerRelationAnalysisIndex {
  const candidatesById = new Map<string, PotentialBlockerRelationAnalysis>();
  for (const candidate of relationCandidates) {
    const nodes = relationNodes(candidate.relation);
    const endpointNodeIds = Object.freeze([nodes[0].nodeId, nodes[1].nodeId]) satisfies readonly [
      GraphNodeId,
      GraphNodeId,
    ];
    const potentialTargetNodeIds =
      candidate.authority === "inferred"
        ? endpointNodeIds
        : candidate.relation.type === "blocks"
          ? Object.freeze([candidate.relation.blocked.nodeId])
          : Object.freeze([]);
    const targetNodeIds = potentialTargetNodeIds.flatMap((nodeId) => {
      const targetNodeId = trackedNodeIdsByValue.get(nodeId);
      return targetNodeId == null ? [] : [targetNodeId];
    });
    if (targetNodeIds.length === 0) {
      continue;
    }
    const ownerNodeId =
      candidate.authority === "inferred"
        ? trackedNodeIdsByValue.get(relationAssessmentOwnerNodeId(candidate))
        : undefined;
    addPotentialBlockerRelationAnalysis(
      candidatesById,
      Object.freeze({
        candidateId: candidate.id,
        endpointNodeIds,
        targetNodeIds,
        ownerNodeId,
        native: candidate.authority === "authoritative",
      }),
    );
  }
  return createBlockerRelationAnalysisIndex(candidatesById);
}

function nativeBlockerCandidateAbsenceIsProven(
  candidate: PotentialBlockerRelationAnalysis,
  detailsByNodeId: ReadonlyMap<GraphNodeId, GitHubItemDetail>,
): boolean {
  if (!candidate.native) {
    return false;
  }
  return candidate.endpointNodeIds.some((nodeId) => {
    const detail = detailsByNodeId.get(nodeId);
    return detail?.type === "issue" && detail.nativeDependencies.availability === "available";
  });
}

function blockerRelationHasChangedRelatedEndpoint(
  candidate: PotentialBlockerRelationAnalysis,
  targetNodeId: GitHubNodeId,
  changedNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  return candidate.endpointNodeIds.some(
    (nodeId) => nodeId !== targetNodeId && changedNodeIds.has(nodeId),
  );
}

function blockerRelationAnalysisTargets(
  state: RuntimeState,
  relationCandidates: readonly RelationCandidate[],
  changedNodeIds: ReadonlySet<GitHubNodeId>,
  initialAnalysisNodeIds: ReadonlySet<GitHubNodeId>,
  trackedNodeIds: ReadonlySet<GitHubNodeId>,
  observedItemsByNodeId: ReadonlyMap<GitHubNodeId, FreshObservedGitHubItem>,
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>,
  staleNodeIds: ReadonlySet<GitHubNodeId>,
): BlockerRelationAnalysisTargets {
  const trackedNodeIdsByValue = new Map<string, GitHubNodeId>(
    [...trackedNodeIds].map((nodeId) => [nodeId, nodeId]),
  );
  const previousIndex = previousBlockerRelationAnalysisIndex(state, trackedNodeIdsByValue);
  const currentIndex = currentBlockerRelationAnalysisIndex(
    relationCandidates,
    trackedNodeIdsByValue,
  );
  const changedGraphNodeIds = new Set<GraphNodeId>(changedNodeIds);
  const previous = previousSnapshot(state);
  if (previous != null) {
    const previousEffectiveStates = snapshotEffectiveGraphStateByNodeId(previous);
    const currentNativeStates = currentNativeCandidateStateByStaleNodeId(
      relationCandidates,
      staleNodeIds,
    );
    for (const [nodeId, currentState] of currentNativeStates) {
      const previousState = previousEffectiveStates.get(nodeId);
      assertNonNullable(
        previousState,
        `stale endpointの前回effective graph状態がありません。対象: ${nodeId}`,
      );
      if (previousState !== currentState) {
        changedGraphNodeIds.add(nodeId);
      }
    }
  }
  const detailsByGraphNodeId = new Map<GraphNodeId, GitHubItemDetail>(detailsByNodeId);
  const analysisNodeIds = new Set(initialAnalysisNodeIds);
  const freshNodeIds = new Set<GitHubNodeId>();
  const staleTopologyNodeIds = new Set<GitHubNodeId>();
  const addTarget = (nodeId: GitHubNodeId): boolean => {
    if (staleNodeIds.has(nodeId)) {
      staleTopologyNodeIds.add(nodeId);
      return false;
    }
    if (analysisNodeIds.has(nodeId)) {
      return false;
    }
    if (!observedItemsByNodeId.has(nodeId)) {
      throw new TypeError(`blocker関係の再分析対象を取得できません。対象: ${nodeId}`);
    }
    if (!detailsByNodeId.has(nodeId)) {
      throw new TypeError(`blocker関係の再分析対象の詳細がありません。対象: ${nodeId}`);
    }
    analysisNodeIds.add(nodeId);
    freshNodeIds.add(nodeId);
    return true;
  };
  const targetNodeIds = new Set([
    ...previousIndex.candidateIdsByTargetNodeId.keys(),
    ...currentIndex.candidateIdsByTargetNodeId.keys(),
  ]);
  for (const targetNodeId of targetNodeIds) {
    const previousCandidateIds =
      previousIndex.candidateIdsByTargetNodeId.get(targetNodeId) ?? new Set<string>();
    const currentCandidateIds =
      currentIndex.candidateIdsByTargetNodeId.get(targetNodeId) ?? new Set<string>();
    if ([...currentCandidateIds].some((candidateId) => !previousCandidateIds.has(candidateId))) {
      addTarget(targetNodeId);
    }
    for (const candidateId of previousCandidateIds) {
      if (currentCandidateIds.has(candidateId)) {
        continue;
      }
      const candidate = previousIndex.candidatesById.get(candidateId);
      assertNonNullable(candidate, `前回blocker関係候補の定義がありません。対象: ${candidateId}`);
      if (
        blockerRelationHasChangedRelatedEndpoint(candidate, targetNodeId, changedGraphNodeIds) ||
        (candidate.ownerNodeId != null && analysisNodeIds.has(candidate.ownerNodeId)) ||
        nativeBlockerCandidateAbsenceIsProven(candidate, detailsByGraphNodeId)
      ) {
        addTarget(targetNodeId);
      }
    }
  }
  const potentialRelationsById = new Map([
    ...previousIndex.candidatesById,
    ...currentIndex.candidatesById,
  ]);
  for (const relation of potentialRelationsById.values()) {
    for (const targetNodeId of relation.targetNodeIds) {
      if (blockerRelationHasChangedRelatedEndpoint(relation, targetNodeId, changedGraphNodeIds)) {
        addTarget(targetNodeId);
      }
    }
  }
  for (;;) {
    let targetAdded = false;
    for (const relation of potentialRelationsById.values()) {
      if (relation.ownerNodeId == null || !analysisNodeIds.has(relation.ownerNodeId)) {
        continue;
      }
      for (const targetNodeId of relation.targetNodeIds) {
        if (addTarget(targetNodeId)) {
          targetAdded = true;
        }
      }
    }
    if (!targetAdded) {
      break;
    }
  }
  for (const nodeId of previousStaleRepositoryBlockerTopologyNodeIds(state)) {
    if (trackedNodeIds.has(nodeId) && staleNodeIds.has(nodeId)) {
      staleTopologyNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    freshNodeIds,
    staleNodeIds: staleTopologyNodeIds,
  });
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
      repositoryResultsById,
      configuration.config,
      repositoryInventory.allowlist,
      relationReferenceRetryBudget,
    );
    const discoveredRelationCandidates = extractedRelations.candidates;
    const refreshedAggregate = extractedRelations.aggregate;
    const collectedCandidateNodeIds = collectedTrackingCandidateNodeIds(state, refreshedAggregate);
    const staleTrackedNodeIds = staleTrackedNodeIdsForRelationExpansion(
      state,
      repositoryResultsById,
    );
    const completedTrackingRelationCandidates = completeRelationCandidates(
      discoveredRelationCandidates,
      collectedCandidateNodeIds,
      new Set<GitHubNodeId>(),
    );
    const completedRelationCandidates = completeRelationCandidates(
      discoveredRelationCandidates,
      collectedCandidateNodeIds,
      staleTrackedNodeIds,
    );
    const evaluatedAt = currentRuntimeTime(adapters);
    const tracking = collectTrackingCandidates(
      invocation,
      evaluatedAt,
      configuration,
      state,
      repositoryInventory,
      refreshedAggregate.enumeratedItems,
      refreshedAggregate.observedItems,
      completedTrackingRelationCandidates.candidates,
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
    const repositoriesByNodeId = new Map(
      relationExpansionRepositoriesByNodeId(
        discoveredRelationCandidates,
        repositoryInventory.allowlist,
      ),
    );
    const observedNodeIds = new Set<string>(
      refreshedAggregate.observedItems.map((item) => item.nodeId),
    );
    const personalReminderSeedRepositoriesByNodeId =
      personalReminderRelationExpansionRepositoriesByNodeId(
        state,
        refreshedAggregate,
        tracking,
        discoveredRelationCandidates,
        repositoryInventory.allowlist,
      );
    const effectiveAssigneeTargetNodeIds = changedTrackedImplementationTargetNodeIds(
      refreshedAggregate,
      tracking,
      discoveredRelationCandidates,
      requestedNodeIds,
    );
    const potentialBlockerTargetNodeIds = trackedPotentialBlockerTargetNodeIds(
      refreshedAggregate,
      tracking,
      discoveredRelationCandidates,
      requestedNodeIds,
    );
    const requestsByNodeId = new Map(plannedRequests.map((request) => [request.nodeId, request]));
    for (const nodeId of [...effectiveAssigneeTargetNodeIds, ...potentialBlockerTargetNodeIds]) {
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
    for (const [nodeId, repository] of personalReminderSeedRepositoriesByNodeId) {
      const existingRequest = requestsByNodeId.get(nodeId);
      const existingRepository = repositoriesByNodeId.get(nodeId);
      if (existingRepository != null && existingRepository.id !== repository.id) {
        throw new TypeError("関係先追加取得対象の同じnode IDに異なるrepositoryが指定されています");
      }
      if (existingRequest != null) {
        if (existingRepository == null) {
          repositoriesByNodeId.set(nodeId, repository);
        }
        continue;
      }
      if (requestedNodeIds.has(nodeId) || observedNodeIds.has(nodeId)) {
        continue;
      }
      repositoriesByNodeId.set(nodeId, repository);
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
        ...refreshedAggregate,
        evaluatedAt,
        relationCandidates: completedRelationCandidates.candidates,
        blockerTopologyRelationCandidates: discoveredRelationCandidates,
        droppedRelationCandidateCount: completedRelationCandidates.droppedCount,
        tracking,
      });
    }
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

function analysisPlanFingerprintForValidatedCollectionItem(
  item: SnapshotCollectionItem,
  currentItem: EnumeratedGitHubItem,
  previousItem: SnapshotCollectionItem | undefined,
  identity: AiAnalysisRunIdentity,
  detailNodeIds: ReadonlySet<GitHubNodeId>,
  trackedNodeIds: ReadonlySet<GitHubNodeId>,
  plannedNodeIds: ReadonlySet<GitHubNodeId>,
): SnapshotAnalysisPlanFingerprint {
  const currentFingerprint = analysisPlanFingerprintForItem(currentItem, identity);
  if (
    previousItem != null &&
    previousItem.itemFingerprint !== item.itemFingerprint &&
    !detailNodeIds.has(item.nodeId)
  ) {
    throw new TypeError(`項目fingerprintが変化した項目の詳細がありません。対象: ${item.nodeId}`);
  }
  if (plannedNodeIds.has(item.nodeId)) {
    if (!detailNodeIds.has(item.nodeId)) {
      throw new TypeError(`AI判定計画の詳細がありません。対象: ${item.nodeId}`);
    }
    return {
      status: "planned",
      fingerprint: currentFingerprint,
    };
  }
  if (detailNodeIds.has(item.nodeId) && !trackedNodeIds.has(item.nodeId)) {
    return {
      status: "planned",
      fingerprint: currentFingerprint,
    };
  }
  if (previousItem != null) {
    return previousItem.analysisPlanFingerprint;
  }
  return {
    status: "unplanned",
    reason: "detail_required",
  };
}

function validatedCollectionRepositories(
  state: RuntimeState,
  configuration: RuntimeConfiguration,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PendingTrackedItem>,
): readonly SnapshotCollectionRepository[] {
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const freshRepositoryIds = new Set(
    collection.repositoryResults
      .filter((result) => result.freshness === "fresh")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailNodeIds = new Set(collection.details.map((detail) => detail.nodeId));
  const trackedNodeIds = collection.trackedNodeIds;
  const plannedNodeIds = new Set(codexAnalysis.elementPlanningByNodeId.keys());
  const previousItemsByNodeId = previousCollectionItemsByNodeId(state);
  return Object.freeze(
    collection.collectionRepositories.map((repository) => {
      if (!freshRepositoryIds.has(repository.repositoryId)) {
        return repository;
      }
      return Object.freeze({
        ...repository,
        items: Object.freeze(
          repository.items.map((item) => {
            const currentItem = currentItemsByNodeId.get(item.nodeId);
            assertNonNullable(
              currentItem,
              `fresh収集項目の列挙値がありません。対象: ${item.nodeId}`,
            );
            const previousItem = previousItemsByNodeId.get(item.nodeId);
            const currentTrackedItem = itemsByNodeId.get(item.nodeId);
            const analysisPlanFingerprint = analysisPlanFingerprintForValidatedCollectionItem(
              item,
              currentItem,
              previousItem,
              identity,
              detailNodeIds,
              trackedNodeIds,
              plannedNodeIds,
            );
            return Object.freeze({
              ...item,
              analysisPlanFingerprint,
              aiAnalysis:
                currentTrackedItem?.aiAnalysis ?? previousItem?.aiAnalysis ?? item.aiAnalysis,
            });
          }),
        ),
      });
    }),
  );
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
  const observedItemsByNodeId = new Map(uniqueObservedItems.map((item) => [item.nodeId, item]));
  const detailsByNodeId = new Map(uniqueDetails.map((detail) => [detail.nodeId, detail]));
  const relationCandidatesByNodeId = indexRelationCandidatesByNodeId(relationCandidates);
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
  for (const nodeId of changedNodeIds) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  for (const nodeId of expanded.analysisPlanChangedNodeIds) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  for (const nodeId of expanded.personalReminderReplanNodeIds) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
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
  const personalReminderRelationCandidateSelection =
    selectPersonalReminderRelationCandidateConsumers(
      state,
      {
        observedItems: uniqueObservedItems,
        staleItems,
        relationCandidates,
      },
      trackedNodeIds,
    );
  for (const nodeId of personalReminderRelationCandidateSelection.analysisNodeIds) {
    analysisNodeIds.add(nodeId);
  }
  for (const nodeId of staleEffectiveAssigneeTargets) {
    analysisNodeIds.delete(nodeId);
  }
  for (const nodeId of previousStaleRepositoryBlockerTopologyNodeIds(state)) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  for (const [nodeId, work] of tracking.workByNodeId) {
    if (staleEffectiveAssigneeTargets.has(nodeId)) {
      continue;
    }
    if (work.codexAnalysis.action === "analyze") {
      continue;
    }
    const item = observedItemsByNodeId.get(nodeId);
    if (item?.type !== "issue" || item.state !== "open" || item.assignees.length !== 0) {
      continue;
    }
    const issueRelationCandidates =
      relationCandidatesByNodeId.get(item.nodeId) ?? EMPTY_RELATION_CANDIDATES;
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
    const detail = detailsByNodeId.get(item.nodeId);
    assertNonNullable(detail, `実質担当候補抽出対象の詳細がありません。対象: ${item.nodeId}`);
    if (detail.type !== "issue") {
      throw new TypeError(`Issueの詳細種別が一致しません。対象: ${item.nodeId}`);
    }
    analysisNodeIds.add(item.nodeId);
  }
  const staleNodeIds = new Set(staleItems.map((item) => item.nodeId));
  const blockerTargets = blockerRelationAnalysisTargets(
    state,
    expanded.blockerTopologyRelationCandidates,
    changedNodeIds,
    analysisNodeIds,
    trackedNodeIds,
    observedItemsByNodeId,
    detailsByNodeId,
    staleNodeIds,
  );
  for (const nodeId of blockerTargets.freshNodeIds) {
    analysisNodeIds.add(nodeId);
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
      staleBlockerTopologyNodeIds: blockerTargets.staleNodeIds,
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
      const target = await resolveRuntimeTarget(adapters, config, invocation.command);
      const credentials = readRuntimeCredentials(
        adapters.environment,
        config,
        invocation.command,
        target.kind,
      );
      if (credentials.codex.enabled) {
        await assertCodexAuthenticationAvailable(credentials.codex);
        await assertCodexCliAvailable(adapters, credentials.codex.environment);
      }
      return Object.freeze({
        config,
        credentials,
        target,
      });
    },
    loadState: async ({ configuration }) => {
      const stateAdapter = adapters.createStateBranchAdapter();
      const session =
        configuration.target.kind === "sandbox"
          ? await StatePersistenceSession.openAtRevision(
              stateAdapter,
              configuration.target.state,
              configuration.target.context.baseStateRevision,
            )
          : await adapters.openStateSession(stateAdapter, configuration.target.state);
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
    analyzePersonalReminders: ({
      invocation,
      configuration,
      state,
      collection,
      deterministicAnalysis,
      codexAnalysis,
      reduction,
      graph,
    }) =>
      analyzePersonalReminders(
        adapters,
        invocation,
        configuration,
        state,
        collection,
        deterministicAnalysis,
        codexAnalysis,
        reduction,
        graph,
      ),
    validateCompleteness: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      collection,
      codexAnalysis,
      reduction,
      graph,
      personalReminderAnalysis,
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
            personalReminderAnalysis,
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
    sendDiscord: async ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      validated,
      pages,
    }) => {
      if (
        invocation.command.kind !== "dry-run" &&
        (invocation.command.notificationAction === "acknowledge-current" ||
          invocation.command.notificationAction === "hold")
      ) {
        return Object.freeze({
          value: Object.freeze({
            delivery: Object.freeze({
              status: "skipped",
              reason: invocation.command.notificationAction === "hold" ? "held" : "no_candidates",
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
        configuration.config,
        discordDeliverySettings(configuration.config),
        state,
        repositoryInventory.inventory,
        configuration.credentials.knownSecrets,
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
    sendOperationsAlert: async ({
      invocation,
      configuration,
      state,
      persisted,
      kind,
      retryAttempts,
    }) => {
      if (configuration.target.kind === "sandbox") {
        return Object.freeze({
          value: Object.freeze({
            delivery: Object.freeze({
              status: "disabled",
            }),
            notificationEvents: Object.freeze([]),
            notificationLedger:
              persisted == null ? state.notificationLedger : persisted.notificationLedger,
          }),
          notificationCount: 0,
          discordSentAt: null,
        });
      }
      let persistedState = state;
      if (persisted != null) {
        persistedState = Object.freeze({
          ...state,
          notificationLedger: persisted.notificationLedger,
        });
      }
      return deliverOperationsAlert(
        adapters,
        configuration.config,
        configuration.credentials.knownSecrets,
        persistedState,
        {
          incidentId: `${invocation.runId}:${kind}`,
          kind,
          occurredAt: invocation.startedAt,
          retryAttempts,
        },
      );
    },
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
  for (const entry of artifact.personalReminderAiCacheEntries) {
    await session.personalReminderAiCache.write(entry);
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
  if (
    artifact.notificationAction === "acknowledge-current" ||
    artifact.notificationAction === "hold"
  ) {
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
  const knownSecrets = artifact.discordSettings.enabled
    ? Object.freeze([
        requireEnvironmentValue(adapters.environment, artifact.discordSettings.webhookSecretName),
        requireEnvironmentValue(
          adapters.environment,
          artifact.discordSettings.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  const result = await deliverDiscord(
    adapters,
    config,
    artifact.discordSettings,
    state,
    workflowArtifactRepositoryInventory(artifact),
    knownSecrets,
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
    knownSecrets,
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

function acknowledgeDeliveryStartedEntry(
  entry: Extract<NotificationLedgerEntry, { status: "delivery_started" }>,
  acknowledgedAt: UtcIsoDateTime,
): NotificationLedgerEntry {
  return Object.freeze({
    notificationKey: entry.notificationKey,
    itemNodeId: entry.itemNodeId,
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    reservedAt: entry.reservedAt,
    status: "acknowledged",
    acknowledgedAt,
  });
}

async function resolveDiscordDelivery(
  adapters: ProductionRuntimeAdapters,
  command: ResolveDiscordDeliveryCliCommand,
): Promise<void> {
  if (!DISCORD_DELIVERY_ID_PATTERN.test(command.deliveryId)) {
    throw new TypeError("Discord送信のdelivery IDが不正です");
  }
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord送信の手動解決対象となるstate snapshotがありません");
  }
  const currentLedger = await session.loadNotificationLedger();
  const entries = currentLedger.entries.map(notificationLedgerEntry);
  const matchingEntries = entries.filter(
    (entry): entry is Extract<NotificationLedgerEntry, { status: "delivery_started" }> =>
      entry.status === "delivery_started" && entry.deliveryId === command.deliveryId,
  );
  if (matchingEntries.length === 0) {
    throw new TypeError(`指定されたdelivery IDの送信開始記録がありません: ${command.deliveryId}`);
  }
  const matchingKeys = new Set(matchingEntries.map((entry) => entry.notificationKey));
  const resolvedAt = createUtcIsoDateTime(adapters.now().toISOString());
  if (matchingEntries.some((entry) => resolvedAt < entry.startedAt)) {
    throw new TypeError("Discord送信の解決時刻は送信開始時刻以後にしてください");
  }
  let nextEntries: readonly NotificationLedgerEntry[];
  let pendingNotifications: readonly PendingNotification[];
  if (command.resolution === "retry") {
    nextEntries = Object.freeze(
      entries.filter((entry) => !matchingKeys.has(entry.notificationKey)),
    );
    pendingNotifications = currentLedger.pendingNotifications;
  } else {
    nextEntries = Object.freeze(
      entries.map((entry) => {
        if (entry.status !== "delivery_started" || entry.deliveryId !== command.deliveryId) {
          return entry;
        }
        return acknowledgeDeliveryStartedEntry(entry, resolvedAt);
      }),
    );
    pendingNotifications = Object.freeze(
      currentLedger.pendingNotifications.filter(
        (pending) => !matchingKeys.has(pending.notificationKey),
      ),
    );
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: nextEntries,
    operationsAlerts: currentLedger.operationsAlerts,
    pendingNotifications,
  });
  const repositoryInventory = workflowArtifactRepositoryInventory({
    snapshot: persistedSnapshot.snapshot,
  });
  assertStatePublicSafety({
    snapshot: persistedSnapshot.snapshot,
    repositoryInventory,
    additionalValues: [currentLedger, notificationLedger],
    knownSecrets: [],
  });
  await session.persistNotificationLedger({
    notificationLedger,
    committedAt: resolvedAt,
    knownSecrets: [],
  });
  await session.publish();
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
    resolveDiscordDelivery: (command) => resolveDiscordDelivery(adapters, command),
    reportWorkflow: (command) => reportWorkflowRun(adapters, command),
  });
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
    stateVerificationRunner: new StateVerificationRunner({
      verifyStateDirectory: adapters.verifyStateDirectory,
      writeStandardOutput: adapters.writeStandardOutput,
    }),
    writeStandardOutput: adapters.writeStandardOutput,
  });
}

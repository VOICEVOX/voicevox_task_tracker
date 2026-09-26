import type {
  AiAnalysisRunResult,
  AiBudgetUsage,
  AnalysisElementPlanning,
  CodexAnalysisInput,
  CodexAttemptBudget,
  PersonalReminderAiRunResult,
  ReducedCodexDecision,
  AiAnalysisElementSourceGenerationMap,
} from "../../codex/index.js";
import type { Config } from "../../config/index.js";
import type { AiAnalysisDependency } from "../../domain/ai-analysis-dependencies.js";
import type {
  ExternalGhostNode,
  GitHubNodeId,
  GraphNodeId,
  IssueStateDecision,
  NaturalLanguageDeadlineAssessmentState,
  NaturalLanguageImportanceAssessmentState,
  PrimaryWaitingOn,
  PullRequestStateDecision,
  Repository,
  Severity,
  StalenessNotificationSeverityReason,
  StalenessResult,
  StalenessSeverityContext,
  StalenessWaitClass,
  TrackedItem,
  TrackedItemAiAnalysisApplications,
  TrackedItemState,
  TrackingNotificationClass,
  UtcIsoDateTime,
} from "../../domain/index.js";
import type {
  DiscordNotificationItem,
  NotificationCause,
  NotificationDependencyCause,
} from "../../discord/index.js";
import type {
  EnumeratedGitHubItem,
  FreshObservedGitHubItem,
  GitHubClient,
  GitHubItemDetail,
  PublicRepositoryAllowlist,
  RepositoryCollectionResult,
  StaleObservedGitHubItem,
} from "../../github/index.js";
import type {
  AnalyzeGraphResult,
  BlockerNodeAiDependency,
  BlockerSetAiDependency,
  NegativeBlockerAiDependency,
  ReconcileGraphResult,
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateAssessment,
  RelationCandidateId,
  RelationSetAiDependency,
} from "../../graph/index.js";
import type {
  SnapshotCollectionItem,
  SnapshotCollectionRepository,
  SnapshotGraphNodeStateObservation,
  StateNotificationLedger,
  StatePersistenceSession,
  StateSnapshotReadResult,
} from "../../persistence/index.js";
import type { DailyTransactionTypeMap } from "../daily-transaction.js";
import type { DeterministicItemAnalysis } from "../initial-item-analysis.js";
import type { EffectiveAssigneeCandidateContext } from "../issue-responsibility-candidates.js";
import type { PersonalReminderAnalysisResult } from "../personal-reminder/index.js";
import type { RuntimeCredentials, RuntimeExecutionTarget } from "../production-runtime-setup.js";
import type {
  DiscordResult,
  PagesResult,
  PersistedRun,
  ValidatedRun,
} from "../run-publication/contracts.js";

export type MutablePartial<Value> = {
  -readonly [Key in keyof Value]?: Value[Key];
};

export type RuntimeConfiguration = Readonly<{
  config: Config;
  credentials: RuntimeCredentials;
  target: RuntimeExecutionTarget;
  ensureCodexReady: () => Promise<void>;
  codexAttemptBudget: CodexAttemptBudget;
}>;

export type RuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  notificationLedger: StateNotificationLedger;
}>;

export type RepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
}>;

export type CollectedItems = Readonly<{
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

export type DeterministicAnalysis = Readonly<{
  items: readonly DeterministicItemAnalysis[];
  state: RuntimeState;
  inventory: RepositoryInventory;
}>;

export type CodexAnalysis = Readonly<{
  run: AiAnalysisRunResult | undefined;
  inputByNodeId: ReadonlyMap<GitHubNodeId, CodexAnalysisInput>;
  elementPlanningByNodeId: ReadonlyMap<GitHubNodeId, AnalysisElementPlanning>;
  elementGenerationsByNodeId: ReadonlyMap<GitHubNodeId, AiAnalysisElementSourceGenerationMap>;
}>;

export type ReducedItemAnalysis = Readonly<{
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

export type TrackedItemStaleness = Readonly<{
  elapsedHours: number;
  severity: Severity;
  severityReason: StalenessNotificationSeverityReason;
  criticalSuppressed: boolean;
  criticalRequested: boolean;
  waitClass: StalenessWaitClass;
  severityContext: StalenessSeverityContext;
}>;

type WithoutImportance<T> = T extends unknown ? Omit<T, "importance"> : never;
export type PendingTrackedItem = WithoutImportance<TrackedItem>;
export type TrackedItemWithImportanceAssessment = TrackedItem &
  Readonly<{
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  }>;

export type ReducedAnalysis = Readonly<{
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

export type GraphResult = Readonly<{
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

export type PersonalReminderAnalysis = Readonly<{
  status: "success" | "fallback";
  result: PersonalReminderAnalysisResult;
  run: PersonalReminderAiRunResult | undefined;
  budgetUsage: AiBudgetUsage;
  authenticationPreflightExecuted: boolean;
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

export type BlockerValueAiDependencies = Readonly<{
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

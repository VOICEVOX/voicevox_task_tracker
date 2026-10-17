import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import type { TrackedItemAiAnalysisApplications } from "../../../domain/tracked-item-ai-analysis.js";
import type {
  ExternalGhostNode,
  GitHubAccountActor,
  GitHubNodeId,
  GraphNodeId,
  IssueStateDecision,
  NaturalLanguageDeadlineAssessmentState,
  NaturalLanguageImportanceAssessmentState,
  NotificationReasonCode,
  PrimaryWaitingOn,
  PullRequestStateDecision,
  Severity,
  SourceId,
  StalenessNotificationSeverityReason,
  StalenessResult,
  StalenessSeverityContext,
  StalenessWaitClass,
  TrackedItem,
  TrackedItemState,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type {
  AnalyzeGraphResult,
  BlockerNodeAiDependency,
  BlockerSetAiDependency,
  NegativeBlockerAiDependency,
  ReconcileGraphResult,
  ReconciledGraphEdge,
  RelationCandidateAssessment,
  RelationCandidateId,
  RelationSetAiDependency,
} from "../../../graph/index.js";
import type { EffectiveAssigneeCandidateContext } from "./deterministic-responsibility.js";
import type { CollectedItemObservations } from "./collection-production.js";
import type { GraphReconciliationInput } from "../contracts/run-core.js";
import type { GraphFinalItem } from "../contracts/graph-final-item.js";
import type {
  PreviousSnapshotProjection,
  PreviousTrackedItem,
} from "../contracts/previous-state.js";

export type GraphWorkingCollection = CollectedItemObservations;
export type GraphWorkingConfiguration = Readonly<{
  config: GraphReconciliationInput["config"];
}>;
type AvailablePreviousSnapshot = Extract<PreviousSnapshotProjection, { status: "available" }>;
export type GraphWorkingSnapshot = Omit<AvailablePreviousSnapshot, "trackedItems"> &
  Readonly<{ items: AvailablePreviousSnapshot["trackedItems"] }>;
export type GraphWorkingState = Readonly<{
  previousSnapshot: PreviousSnapshotProjection;
  snapshot: Readonly<{ status: "missing_branch" | "operations_only" }> | GraphWorkingSnapshot;
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PreviousTrackedItem>;
}>;
export type GraphWorkingInventory = Readonly<{ repositories: readonly PublicRepository[] }>;

/** 状態、待ち相手、根拠を採用記録から確定した判定。 */
export type GraphReducedDecision = Readonly<{
  origin: "deterministic" | "codex";
  status: TrackedItem["status"];
  waitingOn: TrackedItem["waitingOn"];
  nextAction: string;
  confidence: number;
  evidence: TrackedItem["evidence"];
  uncertainties: readonly string[];
}>;

type GraphCauseActor = GitHubAccountActor & Readonly<{ type: "human" }>;
type GraphCauseEvidence = Readonly<{
  sourceId: SourceId;
  occurredAt: UtcIsoDateTime;
  actor: GraphCauseActor;
}>;
type GraphCauseEvidenceList = readonly [GraphCauseEvidence, ...GraphCauseEvidence[]];

/** 自己コミットメントの確定原因。 */
export type GraphSelfCommitmentCause =
  | Readonly<{ status: "indeterminate" }>
  | Readonly<{
      status: "complete";
      responsible: GraphCauseActor;
      evidence: GraphCauseEvidenceList;
    }>;

/** 関係解消で確定した原因。 */
export type GraphDependencyCause =
  | Readonly<{ status: "not_applicable" | "indeterminate" }>
  | Readonly<{ status: "complete"; evidence: GraphCauseEvidenceList }>;

/** 項目状態に対するグラフ由来AI依存。 */
export type GraphBlockerValueAiDependencies = Readonly<{
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

/** 一項目の二回目の統合後に確定した値。 */
export type GraphReducedItem = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  effectiveAssigneeCandidates: readonly EffectiveAssigneeCandidateContext[];
  decision: GraphReducedDecision;
  deterministicDecision: IssueStateDecision | PullRequestStateDecision;
  blockerValueAiDependencies: GraphBlockerValueAiDependencies;
  localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  aiAnalysisApplications: TrackedItemAiAnalysisApplications;
  selfCommitmentCause: GraphSelfCommitmentCause;
  statusBasis: IssueStateDecision["statusBasis"];
  responsibilityBasis: IssueStateDecision["responsibilityBasis"];
  dependencyCause: GraphDependencyCause;
  notificationRecommendation: GraphNotificationRecommendation;
  primaryWaitingOn: PrimaryWaitingOn;
  staleness: StalenessResult;
  importanceAssessment: NaturalLanguageImportanceAssessmentState;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
}>;

/** 汎用AIの通知提案を採用した結果。 */
export type GraphNotificationRecommendation =
  | Readonly<{ availability: "not_available" }>
  | Readonly<{
      availability: "available";
      value: Readonly<{
        recommended: boolean;
        reasonCode: NotificationReasonCode;
        reasonSummary: string;
        policy: "eligible" | "normal_priority_only" | "suppressed";
        highPriorityEligible: boolean;
      }>;
    }>;

/** 二回目の統合結果だけを保持する。 */
export type GraphReduction = Readonly<{
  items: readonly GraphFinalItem[];
  currentItems: readonly GraphReducedItem[];
  stalenessByNodeId: readonly (readonly [GitHubNodeId, GraphTrackedItemStaleness])[];
  relationAssessments: readonly RelationCandidateAssessment[];
  retainedNotificationRecommendations: readonly (readonly [
    GitHubNodeId,
    GraphNotificationRecommendation,
  ])[];
  runStatus: "success" | "fallback";
}>;

export type GraphWorkingReduction = Omit<
  GraphReduction,
  "items" | "stalenessByNodeId" | "retainedNotificationRecommendations"
> &
  Readonly<{
    items: readonly PendingGraphTrackedItem[];
    stalenessByNodeId: ReadonlyMap<GitHubNodeId, GraphTrackedItemStaleness>;
    retainedNotificationRecommendations: ReadonlyMap<GitHubNodeId, GraphNotificationRecommendation>;
  }>;

type WithoutImportance<Item> = Item extends TrackedItem ? Omit<Item, "importance"> : never;
export type PendingGraphTrackedItem = WithoutImportance<TrackedItem>;

/** 最終graphの重要度を反映した項目。 */
export type GraphItemWithImportanceAssessment = TrackedItem &
  Readonly<{
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  }>;

/** 停滞判定を保存値へ反映するための結果。 */
export type GraphTrackedItemStaleness = Readonly<{
  elapsedHours: number;
  severity: Severity;
  severityReason: StalenessNotificationSeverityReason;
  criticalSuppressed: boolean;
  criticalRequested: boolean;
  waitClass: StalenessWaitClass;
  severityContext: StalenessSeverityContext;
}>;

/** 関係の確定値と最終グラフの指標。 */
export type GraphReconciliationResult = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  effectiveStateByNodeId: readonly (readonly [GraphNodeId, TrackedItemState])[];
  graphNodeStateObservations: readonly GraphNodeStateObservation[];
  currentNativeStateObservations: readonly GraphNodeStateObservation[];
  relationCandidateAiDependencies: readonly (readonly [
    RelationCandidateId,
    AiAnalysisDependency,
  ])[];
  candidateResolutions: ReconcileGraphResult["candidateResolutions"];
  candidateDecisionProofs: ReconcileGraphResult["candidateDecisionProofs"];
  externalReferences: readonly ExternalGhostNode[];
  openNodeIds: readonly GraphNodeId[];
  analysis: AnalyzeGraphResult;
  downstreamImpactAiDependencies: AnalyzeGraphResult["downstreamImpactAiDependencies"];
  blockerSetAiDependencies: readonly BlockerSetAiDependency[];
  blockerNodeAiDependencies: readonly BlockerNodeAiDependency[];
  negativeBlockerAiDependencies: readonly NegativeBlockerAiDependency[];
  relationSetAiDependencies: readonly RelationSetAiDependency[];
  previousAnalysis:
    | Readonly<{ availability: "unavailable" }>
    | Readonly<{ availability: "available"; value: AnalyzeGraphResult }>;
}>;

export type GraphWorkingResult = Omit<
  GraphReconciliationResult,
  "effectiveStateByNodeId" | "relationCandidateAiDependencies" | "openNodeIds"
> &
  Readonly<{
    effectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
    relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
    openNodeIds: ReadonlySet<GraphNodeId>;
  }>;

/** 関係先から得た追跡項目の状態観測。 */
export type GraphNodeStateObservation = Readonly<{
  nodeId: GitHubNodeId;
  state: TrackedItemState;
  observedAt: UtcIsoDateTime;
}>;

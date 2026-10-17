import type {
  PersonalReminderAiItemContext,
  PersonalReminderAiRelationContext,
  PersonalReminderAiSourceContext,
  PersonalReminderCauseSemanticInput,
  PersonalReminderDuplicateOption,
  PersonalReminderEvidenceRole,
  PersonalReminderEvidenceScope,
  PersonalReminderPendingRelation,
  PersonalReminderWaitingOption,
} from "../../../codex/personal-reminder-input-contracts.js";
import type {
  AiAnalysisDependency,
  AiAnalysisDependencyInput,
  AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import type { IssueStateDecision } from "../../../domain/issue-state-contracts.js";
import type {
  PersonalReminderActionKind,
  PersonalReminderCause,
  PersonalReminderCauseAssessment,
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
  PersonalReminderCauseSetSubjectChanges,
  PersonalReminderMissingInput,
  PersonalReminderResponseMembershipAssessmentRequirement,
  PersonalReminderResponsibility,
  PersonalReminderSubject,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseDraft,
  PersonalReminderCauseSeedOrigin,
  PersonalReminderItem,
  PersonalReminderLocalDecision,
  PersonalReminderReviewRequestTarget,
  PreviousPersonalReminderCauses,
} from "../../../domain/personal-reminder-planning.js";
import { reconcilePersonalReminderCauseSeeds } from "../../../domain/personal-reminder-planning.js";
import type { PullRequestStateDecision } from "../../../domain/pull-request-state-contracts.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, GitHubNodeId, GraphNodeId, UtcIsoDateTime } from "../../../domain/types.js";
import type { TrackedItemAiAnalysisApplications } from "../../../domain/tracked-item-ai-analysis.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type {
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateDecisionProof,
  RelationCandidateId,
  RelationCandidateResolution,
} from "../../../graph/index.js";

export type PersonalReminderDecisionWaitingOn = PersonalReminderLocalDecision["waitingOn"][number];

export type PersonalReminderResponsibleWaitingOn = Omit<
  PersonalReminderDecisionWaitingOn,
  "kind" | "role"
> &
  Readonly<{
    kind: "user" | "team" | "role";
    role: Exclude<PersonalReminderDecisionWaitingOn["role"], "dependency" | "ci">;
  }>;

/** item種別と一致するblock適用前のlocal decision。 */
export type PersonalReminderRuntimeLocalDecision =
  | Readonly<{ itemType: "issue"; value: IssueStateDecision }>
  | Readonly<{ itemType: "pull_request"; value: PullRequestStateDecision }>;

/** runtimeへ渡すfresh itemの表示情報を含むraw観測値。 */
export type PersonalReminderRuntimeItem = PersonalReminderItem &
  Readonly<{
    url: string;
    title: string;
  }>;

/** runtimeへ渡すfresh itemとdetailのraw context。 */
export type PersonalReminderRuntimeRelatedContext = Readonly<{
  item: PersonalReminderRuntimeItem;
  detail: GitHubItemDetail;
  localDecision: PersonalReminderRuntimeLocalDecision | undefined;
}>;

/** runtimeが受け取る収集完全性。 */
export type PersonalReminderRuntimeCollectionCompleteness =
  | Readonly<{ status: "complete" }>
  | Readonly<{
      status: "incomplete";
      missing: readonly [PersonalReminderMissingInput, ...PersonalReminderMissingInput[]];
    }>;

/** runtimeが検証済みsourceへ付与する役割付き投影。 */
export type PersonalReminderRuntimeSource = Readonly<{
  source: PersonalReminderAiSourceContext;
  roles: readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]];
  evidence: readonly Evidence[];
  causalPush: boolean;
}>;

/** runtimeがcauseごとに保持する活動と時計入力。 */
export type PersonalReminderRuntimeActivity = Readonly<{
  relevantProgress: readonly PersonalReminderTimeBasis[];
  responsibleActivity: readonly PersonalReminderTimeBasis[];
  humanReviewActivity: readonly PersonalReminderTimeBasis[];
  actionabilityStartByAction: ReadonlyMap<
    PersonalReminderActionKind,
    PersonalReminderTimeBasis | undefined
  >;
}>;

/** runtimeが収集済みの一項目へ付与する入力射影。 */
export type PersonalReminderRuntimeCollectedItem = Readonly<{
  item: PersonalReminderRuntimeItem;
  detail: GitHubItemDetail;
  localDecision: PersonalReminderRuntimeLocalDecision;
  aiAnalysisApplications: TrackedItemAiAnalysisApplications;
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[];
  completeness: PersonalReminderRuntimeCollectionCompleteness;
  repositoryFullName: string;
  currentLabels: readonly string[];
}>;

/** runtimeが受け取るfresh item、stale item、保存値の集合。 */
export type PersonalReminderRuntimeCollection = Readonly<{
  items: readonly PersonalReminderRuntimeCollectedItem[];
  staleNodeIds: ReadonlySet<GitHubNodeId>;
}>;

/** runtime stateから参照する個人催促の保存値。 */
export type PersonalReminderRuntimeState = Readonly<{
  previousCausesByNodeId: ReadonlyMap<GitHubNodeId, PreviousPersonalReminderCauses>;
  previousEvidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
}>;

/** final graphのrelation候補とendpoint状態。 */
export type PersonalReminderRuntimeGraph = Readonly<{
  activeRelations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[];
  candidateRelations: readonly PersonalReminderRuntimeCandidateRelation[];
  candidateResolutions: readonly RelationCandidateResolution[];
  endpointStates: ReadonlyMap<GraphNodeId, "open" | "closed" | "merged" | "missing">;
  externalReferences: readonly PersonalReminderRuntimeExternalReference[];
  candidateEndpointItemsByNodeId: ReadonlyMap<
    GraphNodeId,
    PersonalReminderRuntimeCandidateEndpointItem
  >;
}>;

/** graphの外部参照をcause入力へ射影する最小shape。 */
export type PersonalReminderRuntimeExternalReference = Readonly<{
  nodeId: GraphNodeId;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
}>;

/** graph candidateをcause入力へ射影する最小shape。 */
export type PersonalReminderRuntimeCandidateRelation = Readonly<{
  candidateId: RelationCandidateId;
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  ownerNodeId: GraphNodeId;
  relationType?: RelationCandidate["relation"]["type"];
  authority?: RelationCandidate["authority"];
  provenance?: RelationCandidate["provenance"];
  resolution?: RelationCandidateResolution;
  canonicalRelation?: RelationCandidateDecisionProof["canonicalRelation"];
  evidenceSourceIds: readonly [SourceId, ...SourceId[]];
  aiDependency: AiAnalysisDependency;
}>;

/** 関係候補endpointから個人催促へ渡す追跡項目の作成者情報。 */
export type PersonalReminderRuntimeCandidateEndpointItem = Readonly<{
  nodeId: GitHubNodeId;
  type: "issue" | "pull_request";
  state: "open" | "closed" | "merged";
  author:
    | Readonly<{
        status: "identified";
        type: "human" | "bot";
        login: string;
      }>
    | Readonly<{
        status: "unavailable";
      }>;
}>;

/** deterministic local responsibilityを含むruntime入力。 */
export type PersonalReminderRuntimeDeterministicAnalysis = Readonly<{
  items: readonly PersonalReminderRuntimeCollectedItem[];
}>;

/** generic inputから再利用する検証済みsource索引。 */
export type PersonalReminderRuntimeCodexAnalysis = Readonly<{
  sourceContextsByNodeId: ReadonlyMap<GitHubNodeId, readonly PersonalReminderRuntimeSource[]>;
}>;

/** reduce段階からcause時計へ渡す活動索引。 */
export type PersonalReminderRuntimeReduction = Readonly<{
  activityByNodeId: ReadonlyMap<GitHubNodeId, PersonalReminderRuntimeActivity>;
}>;

/** cause runtimeが参照するpure context。 */
export type PersonalReminderRuntimeContext = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  state: PersonalReminderRuntimeState;
  items: readonly PersonalReminderRuntimeContextItem[];
  graph: PersonalReminderRuntimeGraph;
  aiDependencyContext: AiAnalysisDependencyReconciliationContext;
  candidateRelationsByTargetNodeId: ReadonlyMap<
    GraphNodeId,
    readonly PersonalReminderRuntimeCandidateRelation[]
  >;
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
}>;

export type PersonalReminderRuntimeContextItem = Omit<
  PersonalReminderRuntimeCollectedItem,
  "localDecision"
> &
  Readonly<{
    localDecision: PersonalReminderLocalDecision;
    previous: PreviousPersonalReminderCauses;
    sources: readonly PersonalReminderRuntimeSource[];
    activity: PersonalReminderRuntimeActivity;
    stale: boolean;
    currentReviewRequestTargets: readonly PersonalReminderReviewRequestTarget[];
    executionSurfaceStates: ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge">;
    sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
    clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>;
    seedEvidence: readonly Evidence[];
    evidenceScopes: readonly PersonalReminderEvidenceScope[];
    itemContext: PersonalReminderAiItemContext;
    relatedItemContexts: readonly PersonalReminderAiItemContext[];
    externalItemContexts: readonly PersonalReminderAiItemContext[];
    endpointStates: ReadonlyMap<GraphNodeId, "open" | "closed" | "merged" | "missing">;
    responsibilities: readonly PersonalReminderResponsibility[];
  }>;

export type PersonalReminderRuntimeReconciledItem = Readonly<{
  item: PersonalReminderRuntimeContextItem;
  previousById: ReadonlyMap<PersonalReminderCauseId, PersonalReminderCause>;
  reconciliation: Extract<
    ReturnType<typeof reconcilePersonalReminderCauseSeeds>,
    Readonly<{ status: "available" }>
  >;
}>;

export type PersonalReminderCauseContinuityConflict = Omit<
  Extract<
    ReturnType<typeof reconcilePersonalReminderCauseSeeds>,
    Readonly<{ status: "continuity_conflict" }>
  >,
  "status" | "reason"
>;

export type PersonalReminderCauseNewDraftIdCollision = Extract<
  ReturnType<typeof reconcilePersonalReminderCauseSeeds>,
  Readonly<{ status: "continuity_conflict"; reason: "new_draft_id_collision" }>
>;

export type PersonalReminderRuntimeCurrentSeed = Readonly<{
  seed: PersonalReminderCauseSeed;
  item: PersonalReminderRuntimeContextItem;
  origin: "current_draft" | "retained_without_draft";
  constructionOrigin: PersonalReminderCauseSeedOrigin;
  draft: PersonalReminderCauseDraft | undefined;
  draftIdentity: string | undefined;
  projectionKey: string;
  probe: boolean;
  previousCause: PersonalReminderCause | undefined;
}>;

export type PersonalReminderRuntimeActiveRelation = ReconciledGraphEdge &
  Readonly<{ active: true }>;

export type PersonalReminderRuntimePlanningIndexes = Readonly<{
  candidateRelationById: ReadonlyMap<RelationCandidateId, PersonalReminderRuntimeCandidateRelation>;
  activeRelationsByNodeId: ReadonlyMap<
    GraphNodeId,
    readonly PersonalReminderRuntimeActiveRelation[]
  >;
  currentSeedByCauseId: ReadonlyMap<PersonalReminderCauseId, PersonalReminderRuntimeCurrentSeed>;
  currentSeedsByItemNodeId: ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeCurrentSeed[]>;
  currentSeedsByScopeNodeId: ReadonlyMap<
    GraphNodeId,
    readonly PersonalReminderRuntimeCurrentSeed[]
  >;
}>;

export type PersonalReminderConnectedSeedRelations = Readonly<{
  currentSeed: PersonalReminderRuntimeCurrentSeed;
  relations: readonly PersonalReminderRuntimeActiveRelation[];
}>;

export type PersonalReminderRuntimeOptionProjection = Readonly<{
  options: readonly PersonalReminderWaitingOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  missing: readonly PersonalReminderMissingInput[];
  aiDependencyInputsByOptionId: ReadonlyMap<string, readonly AiAnalysisDependencyInput[]>;
}>;

type PersonalReminderRuntimeDuplicateOptionProjection = Readonly<{
  options: readonly PersonalReminderDuplicateOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  aiDependencyInputsByCanonicalCauseId: ReadonlyMap<string, readonly AiAnalysisDependencyInput[]>;
}>;

export type PersonalReminderGraphDraftProjection = Readonly<{
  drafts: readonly PersonalReminderCauseDraft[];
}>;

export type PersonalReminderRuntimeSourceProjection = Readonly<{
  sources: readonly PersonalReminderRuntimeSource[];
  missingSourceIds: readonly SourceId[];
}>;

export type PersonalReminderRuntimeActivityProjection = Readonly<{
  activity: PersonalReminderRuntimeActivity;
  missing: readonly PersonalReminderMissingInput[];
}>;

export type PersonalReminderCauseSemanticProjection = Readonly<{
  currentSeed: PersonalReminderRuntimeCurrentSeed;
  relationEdges: readonly PersonalReminderRuntimeActiveRelation[];
  pendingRelations: readonly PersonalReminderPendingRelation[];
  waitingProjection: PersonalReminderRuntimeOptionProjection;
  duplicateProjection: PersonalReminderRuntimeDuplicateOptionProjection;
  relations: readonly PersonalReminderAiRelationContext[];
  relationSources: PersonalReminderRuntimeSourceProjection;
  optionSources: readonly PersonalReminderRuntimeSource[];
  additionalItemContexts: readonly PersonalReminderAiItemContext[];
  activityProjection: PersonalReminderRuntimeActivityProjection;
  semanticInput: PersonalReminderCauseSemanticInput;
}>;

export type PersonalReminderRuntimeDraftedItem = Readonly<{
  item: PersonalReminderRuntimeContextItem;
  drafts: readonly PersonalReminderCauseDraft[];
  negativeCandidateDependencies: readonly PersonalReminderRuntimeSubjectDependency[];
}>;

export type PersonalReminderRuntimeSubjectDependency = Readonly<{
  subject: PersonalReminderSubject;
  inputs: readonly AiAnalysisDependencyInput[];
}>;

export type PersonalReminderRuntimeCauseSetSubjectChangeInput = Readonly<{
  addableSubjects: readonly PersonalReminderSubject[];
  removableSubjects: readonly PersonalReminderSubject[];
  presenceInputs: readonly AiAnalysisDependencyInput[];
  negativeCandidateSubjectCount: number;
  unbounded: boolean;
}>;

/** cause seedと意味入力を時計適用へ渡す計画要素。 */
export type PersonalReminderCauseRuntimePlanEntry = Readonly<{
  seed: PersonalReminderCauseSeed;
  responseMembershipAssessmentRequirement: PersonalReminderResponseMembershipAssessmentRequirement;
  semanticInput: PersonalReminderCauseSemanticInput;
  deterministicAssessment: PersonalReminderCauseAssessment | undefined;
  previousCause: PersonalReminderCause | undefined;
  sourceEvidence: readonly Evidence[];
  activity: PersonalReminderRuntimeActivity;
  repositoryFullName: string;
  currentLabels: readonly string[];
  currentInputAiDependency: AiAnalysisDependency;
}>;

/** cause runtimeのreconcile結果とAI入力計画。 */
export type PersonalReminderCauseRuntimePlan = Readonly<{
  entries: readonly PersonalReminderCauseRuntimePlanEntry[];
  applicableItemNodeIds: readonly GitHubNodeId[];
  preservedCauses: readonly PersonalReminderCause[];
  preservedEvidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  continuityConflicts: readonly PersonalReminderCauseContinuityConflict[];
  endedCauseIds: readonly PersonalReminderCauseId[];
  pendingCauseIds: readonly PersonalReminderCauseId[];
  incompleteInputNodeIds: ReadonlySet<GitHubNodeId>;
  deferredStructuralEndNodeIds: ReadonlySet<GitHubNodeId>;
  unrecordedDependencyNodeIds: ReadonlySet<GitHubNodeId>;
  causeSetAiDependencyByNodeId: ReadonlyMap<GitHubNodeId, AiAnalysisDependency>;
  causeSetSubjectChangesByNodeId: ReadonlyMap<GitHubNodeId, PersonalReminderCauseSetSubjectChanges>;
}>;

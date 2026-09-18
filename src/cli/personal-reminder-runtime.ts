import {
  createPersonalReminderCauseSemanticInput,
  createPersonalReminderCauseInputFingerprint,
  type PersonalReminderAiItemContext,
  type PersonalReminderAiRelationContext,
  type PersonalReminderAiSourceContext,
  type PersonalReminderCauseSemanticInput,
  type PersonalReminderDuplicateOption,
  type PersonalReminderEvidenceRole,
  type PersonalReminderEvidenceScope,
  type PersonalReminderPendingRelation,
  type PersonalReminderTargetScope,
  type PersonalReminderWaitingOption,
} from "../codex/personal-reminder-input.js";
import { serializeCanonicalJson } from "../codex/canonical-json.js";
import {
  type PersonalReminderAiCauseRunOutcome,
  type PersonalReminderAiRunResult,
} from "../codex/personal-reminder-runner.js";
import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  personalReminderCauseSeedSchema,
  personalReminderCauseSetSubjectChangesAreUnbounded,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderActionKind,
  type PersonalReminderCause,
  type PersonalReminderCauseAiDependencies,
  type PersonalReminderCauseAssessment,
  type PersonalReminderCauseId,
  type PersonalReminderCausePlanning,
  type PersonalReminderCauseSeed,
  type PersonalReminderCauseSetSubjectChanges,
  type PersonalReminderExecutionSurface,
  type PersonalReminderInputCompleteness,
  type PersonalReminderMissingInput,
  type PersonalReminderResponsibility,
  type PersonalReminderResponseMembershipAssessmentRequirement,
  type PersonalReminderResponsible,
  type PersonalReminderSubject,
  type PersonalReminderTimeBasis,
} from "../domain/personal-reminder-causes.js";
import {
  combineReconciledAiAnalysisDependencies,
  aiAnalysisDependencyForRelationCandidate,
  reconcileRetainedAiAnalysisDependency,
  type AiAnalysisDependency,
  type AiAnalysisDependencyInput,
  type AiAnalysisDependencyReconciliationContext,
} from "../domain/ai-analysis-dependencies.js";
import {
  createPersonalReminderCauseDraft,
  personalReminderCauseAiDependenciesForDecision,
  determineStructurallyEndedPersonalReminderCauses,
  reconcilePersonalReminderCauseSeeds,
  relationAffectsPersonalReminderCause,
  type PersonalReminderCauseDraft,
  type PersonalReminderItem,
  type PersonalReminderLocalDecision,
  type PersonalReminderReviewRequestTarget,
  type PreviousPersonalReminderCauses,
} from "../domain/personal-reminder-planning.js";
import {
  determineIssuePersonalReminderResponsibilityAuthority,
  type IssueStateDecision,
} from "../domain/issue-state-machine.js";
import {
  determinePullRequestPersonalReminderResponsibilityAuthority,
  isPullRequestRevisionResponsibilityResolved,
  type PullRequestStateDecision,
} from "../domain/pull-request-state-machine.js";
import {
  updatePersonalReminderActionableClock,
  updatePersonalReminderLastConfirmedActionability,
  calculatePersonalReminderStaleness,
  type PersonalReminderStaleness,
  type PreviousPersonalReminderClockState,
} from "../domain/personal-reminder-staleness.js";
import { isExcludedFromProgressAndHumanActivity } from "../domain/meaningful-progress.js";
import { type LabelEffectsResolver } from "../domain/label-resolution.js";
import { type SeverityThresholds } from "../domain/severity.js";
import { type SourceId } from "../domain/source-id.js";
import { resolvePullRequestCommitOccurredAt } from "../domain/github-item-observation.js";
import {
  type Evidence,
  type GitHubNodeId,
  type GraphNodeId,
  type NormalizedEvent,
  type TrackedItemAiAnalysisApplications,
  type UtcIsoDateTime,
} from "../domain/types.js";
import {
  type GitHubCheckContext,
  type GitHubDetailActor,
  type GitHubItemDetail,
} from "../github/item-detail-types.js";
import {
  type PendingRelationCandidateResolution,
  type ReconciledGraphEdge,
  type RelationCandidate,
  type RelationCandidateDecisionProof,
  type RelationCandidateId,
  type RelationCandidateResolution,
} from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  createPersonalReminderAiCacheKey,
  type PersonalReminderAiCacheKey,
} from "../codex/personal-reminder-cache.js";

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
  snapshotEvidenceSourceIds: ReadonlySet<SourceId>;
}>;

type PersonalReminderRuntimeContextItem = Omit<
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
    seedEvidence: readonly Evidence[];
    evidenceScopes: readonly PersonalReminderEvidenceScope[];
    itemContext: PersonalReminderAiItemContext;
    relatedItemContexts: readonly PersonalReminderAiItemContext[];
    externalItemContexts: readonly PersonalReminderAiItemContext[];
    endpointStates: ReadonlyMap<GraphNodeId, "open" | "closed" | "merged" | "missing">;
    responsibilities: readonly PersonalReminderResponsibility[];
  }>;

type PersonalReminderRuntimeReconciledItem = Readonly<{
  item: PersonalReminderRuntimeContextItem;
  previousById: ReadonlyMap<PersonalReminderCauseId, PersonalReminderCause>;
  reconciliation: Extract<
    ReturnType<typeof reconcilePersonalReminderCauseSeeds>,
    Readonly<{ status: "available" }>
  >;
}>;

type PersonalReminderCauseContinuityConflict = Readonly<{
  itemNodeId: GitHubNodeId;
  previousCauseIds: readonly [
    PersonalReminderCauseId,
    PersonalReminderCauseId,
    ...PersonalReminderCauseId[],
  ];
}>;

type PersonalReminderRuntimeCurrentSeed = Readonly<{
  seed: PersonalReminderCauseSeed;
  item: PersonalReminderRuntimeContextItem;
  origin: "current_draft" | "retained_without_draft";
  previousCause: PersonalReminderCause | undefined;
}>;

type PersonalReminderRuntimeActiveRelation = ReconciledGraphEdge & Readonly<{ active: true }>;

type PersonalReminderRuntimePlanningIndexes = Readonly<{
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
  scopeNodeIdsByCauseId: ReadonlyMap<PersonalReminderCauseId, ReadonlySet<GraphNodeId>>;
}>;

type PersonalReminderConnectedSeedRelations = Readonly<{
  currentSeed: PersonalReminderRuntimeCurrentSeed;
  relations: readonly PersonalReminderRuntimeActiveRelation[];
}>;

type PersonalReminderRuntimeOptionProjection = Readonly<{
  options: readonly PersonalReminderWaitingOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  missing: readonly PersonalReminderMissingInput[];
  aiDependencyInputsByOptionId: ReadonlyMap<string, readonly AiAnalysisDependencyInput[]>;
}>;

type PersonalReminderGraphDraftProjection = Readonly<{
  drafts: readonly PersonalReminderCauseDraft[];
}>;

type PersonalReminderRuntimeSourceProjection = Readonly<{
  sources: readonly PersonalReminderRuntimeSource[];
  missingSourceIds: readonly SourceId[];
}>;

type PersonalReminderRuntimeActivityProjection = Readonly<{
  activity: PersonalReminderRuntimeActivity;
  missing: readonly PersonalReminderMissingInput[];
}>;

type PersonalReminderRuntimeSubjectDependency = Readonly<{
  subject: PersonalReminderSubject;
  inputs: readonly AiAnalysisDependencyInput[];
}>;

type PersonalReminderRuntimeCauseSetSubjectChangeInput = Readonly<{
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
  preservedCauses: readonly PersonalReminderCause[];
  preservedEvidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  continuityConflicts: readonly PersonalReminderCauseContinuityConflict[];
  endedCauseIds: readonly PersonalReminderCauseId[];
  pendingCauseIds: readonly PersonalReminderCauseId[];
  unrecordedDependencyNodeIds: ReadonlySet<GitHubNodeId>;
  causeSetAiDependencyByNodeId: ReadonlyMap<GitHubNodeId, AiAnalysisDependency>;
  causeSetSubjectChangesByNodeId: ReadonlyMap<GitHubNodeId, PersonalReminderCauseSetSubjectChanges>;
}>;

/** snapshot組立へ渡すcauseと根拠。 */
export type PersonalReminderAnalysisApplication = Readonly<{
  causesByNodeId: ReadonlyMap<GitHubNodeId, readonly PersonalReminderCause[]>;
  evidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  stalenessByCauseId: ReadonlyMap<PersonalReminderCauseId, PersonalReminderStaleness>;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareSourceIds(left: SourceId, right: SourceId): number {
  return compareStrings(left, right);
}

function aiAnalysisDependencyIsUnverified(dependency: AiAnalysisDependency): boolean {
  return dependency.status === "unverified" || dependency.status === "unknown";
}

function currentAiDependencyInput(dependency: AiAnalysisDependency): AiAnalysisDependencyInput {
  return Object.freeze({ origin: "current", dependency, relationCandidateAssessment: "graph" });
}

function retainedAiDependencyInput(dependency: AiAnalysisDependency): AiAnalysisDependencyInput {
  return Object.freeze({ origin: "retained", dependency });
}

function seedAiDependencyInput(
  dependency: AiAnalysisDependency,
  origin: PersonalReminderRuntimeCurrentSeed["origin"],
): AiAnalysisDependencyInput {
  return origin === "current_draft"
    ? currentAiDependencyInput(dependency)
    : retainedAiDependencyInput(dependency);
}

function combineCauseSetAiDependency(
  inputs: readonly AiAnalysisDependencyInput[],
  presenceInputs: readonly AiAnalysisDependencyInput[],
  context: AiAnalysisDependencyReconciliationContext,
): AiAnalysisDependency {
  const dependency = combineReconciledAiAnalysisDependencies(inputs, context);
  if (
    dependency.status === "unknown" &&
    dependency.reasons.includes("not_recorded") &&
    dependency.producers == null
  ) {
    return combineReconciledAiAnalysisDependencies(
      [retainedAiDependencyInput(dependency), ...presenceInputs],
      context,
    );
  }
  return dependency;
}

function personalReminderSubjectKey(subject: PersonalReminderSubject): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function normalizePersonalReminderSubjects(
  subjects: readonly PersonalReminderSubject[],
): PersonalReminderSubject[] {
  const subjectsByKey = new Map<string, PersonalReminderSubject>();
  for (const subject of subjects) {
    const key = personalReminderSubjectKey(subject);
    const existing = subjectsByKey.get(key);
    if (existing == null || compareStrings(subject.candidateId, existing.candidateId) < 0) {
      subjectsByKey.set(key, subject);
    }
  }
  return [...subjectsByKey.values()].sort((left, right) =>
    compareStrings(personalReminderSubjectKey(left), personalReminderSubjectKey(right)),
  );
}

function createCauseSetSubjectChanges(
  dependency: AiAnalysisDependency,
  input: PersonalReminderRuntimeCauseSetSubjectChangeInput,
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCauseSetSubjectChanges {
  if (
    personalReminderCauseSetSubjectChangesAreUnbounded({
      causeSetDependency: dependency,
      presenceDependency: combineReconciledAiAnalysisDependencies(input.presenceInputs, context),
      negativeCandidateSubjectCount: input.negativeCandidateSubjectCount,
      inputUnbounded: input.unbounded,
    })
  ) {
    return Object.freeze({ scope: "unbounded" });
  }
  if (!aiAnalysisDependencyIsUnverified(dependency)) {
    return Object.freeze({
      scope: "bounded",
      addableSubjects: [],
      removableSubjects: [],
    });
  }
  const addableSubjects = normalizePersonalReminderSubjects(input.addableSubjects);
  const removableSubjects = normalizePersonalReminderSubjects(input.removableSubjects);
  return Object.freeze({
    scope: "bounded",
    addableSubjects,
    removableSubjects,
  });
}

function createNonEmptySourceIds(
  sourceIds: readonly SourceId[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const first = uniqueSourceIds[0];
  assertNonNullable(first, `${context}のsource IDがありません`);
  return Object.freeze([first, ...uniqueSourceIds.slice(1)]);
}

function createPreviousCauses(
  state: PersonalReminderRuntimeState,
  item: PersonalReminderRuntimeCollectedItem,
): PreviousPersonalReminderCauses {
  const previous = state.previousCausesByNodeId.get(item.item.nodeId);
  if (previous != null) {
    return previous;
  }
  return Object.freeze({ observedAt: item.item.createdAt, causes: Object.freeze([]) });
}

/** 保持原因の値を変えずにAI依存を最終適用元へ照合する。 */
export function reconcileRetainedPersonalReminderCause(
  cause: PersonalReminderCause,
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    aiDependencies: {
      presence: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.presence, context),
      responseMembership: reconcileRetainedAiAnalysisDependency(
        cause.aiDependencies.responseMembership,
        context,
      ),
      responsible: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.responsible, context),
      action: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.action, context),
      evidence: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.evidence, context),
    },
    currentInput: {
      ...cause.currentInput,
      aiDependency: reconcileRetainedAiAnalysisDependency(cause.currentInput.aiDependency, context),
    },
  });
}

/** 保持原因の列挙計画を最終依存へ合わせ、open項目を再計画へ戻す。 */
export function reconcileRetainedPersonalReminderPlanning(
  itemState: "open" | "closed" | "merged",
  observedAt: UtcIsoDateTime,
  planning: PersonalReminderCausePlanning,
  causes: readonly PersonalReminderCause[],
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCausePlanning {
  if (itemState === "open") {
    return Object.freeze({
      status: "pending",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
    });
  }
  if (causes.length === 0) {
    return Object.freeze({
      status: "excluded",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      reason: "terminal_without_cause",
    });
  }
  const presenceInputs = causes.map((cause) =>
    retainedAiDependencyInput(cause.aiDependencies.presence),
  );
  const presenceDependency = combineReconciledAiAnalysisDependencies(presenceInputs, context);
  const causeSetAiDependency = combineCauseSetAiDependency(
    [
      retainedAiDependencyInput(
        planning.status === "completed"
          ? planning.causeSetAiDependency
          : Object.freeze({
              status: "unknown",
              reasons: Object.freeze(["not_recorded"]),
            } satisfies AiAnalysisDependency),
      ),
      ...presenceInputs,
    ],
    presenceInputs,
    context,
  );
  const presenceProducerSignatures = new Set(
    presenceDependency.status === "not_dependent"
      ? []
      : (presenceDependency.producers ?? []).map((producer) => serializeCanonicalJson(producer)),
  );
  const additionalProducers =
    causeSetAiDependency.status === "not_dependent"
      ? []
      : (causeSetAiDependency.producers ?? []).filter(
          (producer) =>
            producer.kind !== "relation_candidate" &&
            !presenceProducerSignatures.has(serializeCanonicalJson(producer)),
        );
  const removableSubjects = causes.flatMap((cause) =>
    aiAnalysisDependencyIsUnverified(cause.aiDependencies.presence)
      ? cause.responsible.flatMap((responsible) =>
          responsible.kind === "role"
            ? []
            : [Object.freeze({ kind: responsible.kind, candidateId: responsible.candidateId })],
        )
      : [],
  );
  return Object.freeze({
    status: "completed",
    planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
    observedAt,
    causeSetAiDependency,
    causeSetSubjectChanges: createCauseSetSubjectChanges(
      causeSetAiDependency,
      {
        addableSubjects: Object.freeze([]),
        removableSubjects,
        presenceInputs,
        negativeCandidateSubjectCount: 0,
        unbounded: additionalProducers.some((producer) =>
          aiAnalysisDependencyIsUnverified(
            reconcileRetainedAiAnalysisDependency(
              Object.freeze({ status: "current", producers: Object.freeze([producer]) }),
              context,
            ),
          ),
        ),
      },
      context,
    ),
  });
}

function determineLocalDecision(
  input: PersonalReminderRuntimeLocalDecision,
): PersonalReminderLocalDecision {
  if (input.itemType === "issue") {
    return input.value;
  }
  return input.value;
}

function validateLocalDecision(
  itemType: PersonalReminderRuntimeItem["type"],
  localDecision: PersonalReminderRuntimeLocalDecision | undefined,
  context: string,
): boolean {
  if (localDecision == null) {
    return false;
  }
  if (localDecision.itemType !== itemType) {
    throw new TypeError(`${context}のlocal decision種別が一致しません`);
  }
  return true;
}

function validateCollectedItem(item: PersonalReminderRuntimeCollectedItem): void {
  if (item.detail.nodeId !== item.item.nodeId || item.detail.type !== item.item.type) {
    throw new TypeError(`個人催促runtimeのitemとdetailが一致しません。対象: ${item.item.nodeId}`);
  }
  if (item.repositoryFullName.length === 0) {
    throw new TypeError("個人催促runtimeのrepository full nameは空にできません");
  }
  if (item.completeness.status === "incomplete" && item.completeness.missing.length === 0) {
    throw new TypeError("不完全な個人催促runtime入力には不足項目が必要です");
  }
}

function actorTypeForItem(item: PersonalReminderItem): "human" | "bot" | "system" {
  if (item.author.status === "unavailable") {
    return "system";
  }
  return item.author.actor.type;
}

function actorCandidateId(actor: PersonalReminderItem["author"]): string | undefined {
  if (actor.status === "unavailable") {
    return undefined;
  }
  return actor.actor.login;
}

function eventActorType(event: NormalizedEvent): "human" | "bot" | "system" {
  return event.actor.type;
}

function eventActorCandidateId(event: NormalizedEvent): string | undefined {
  return event.actor.type === "system" ? undefined : event.actor.login;
}

function sourceRolesForKind(
  kind: string,
): readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] {
  if (kind === "item" || kind === "body" || kind === "comment") {
    return ["obligation_candidate", "actionability"];
  }
  if (kind === "push" || kind === "commit_added") {
    return ["resolution", "actionability"];
  }
  if (kind === "relation") {
    return ["relation", "resolution"];
  }
  if (kind === "review" || kind === "review_request") {
    return ["obligation_candidate", "actionability", "resolution"];
  }
  return ["actionability", "resolution"];
}

function createRuntimeSourceRoles(
  roles: readonly PersonalReminderEvidenceRole[],
): readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] {
  const sortedRoles = [...new Set(roles)].sort(compareStrings);
  const firstRole = sortedRoles[0];
  assertNonNullable(firstRole, "個人催促runtime sourceのroleがありません");
  return Object.freeze([firstRole, ...sortedRoles.slice(1)]);
}

function sourceSummaryForEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "review":
      return `GitHub review ${event.state} ${event.commitStatus === "available" ? event.commitSha : "commit-unavailable"}`;
    case "review_request":
      return `GitHub review request ${event.action} ${event.target.type}:${event.target.nodeId}`;
    case "assignee":
      return `GitHub assignee ${event.action} ${event.assignee.login}`;
    case "label":
      return `GitHub label ${event.action} ${event.labelName}`;
    case "state":
      return `GitHub state ${event.state}${event.state === "closed" ? `:${event.stateReason}` : ""}`;
    case "relation":
      return `GitHub relation ${event.action} ${event.relationType} ${event.direction} ${
        event.target.type === "node" ? event.target.nodeId : event.target.url
      } ${event.provenance}`;
    case "push":
      return `GitHub push ${event.forcePush ? "force" : "normal"} ${event.headCommitSha}`;
    case "comment":
      return `GitHub comment ${event.bodyEmpty ? "empty" : "body"}`;
    case "ready_for_review":
    case "converted_to_draft":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return `GitHub ${event.kind} event`;
  }
}

type PersonalReminderRuntimeReviewRequest = Extract<
  GitHubItemDetail,
  { type: "pull_request" }
>["reviewRequests"]["current"][number];

function sourceSummaryForReviewRequest(request: PersonalReminderRuntimeReviewRequest): string {
  if ("status" in request.target) {
    return "GitHub review request target unavailable";
  }
  if (request.target.type === "user") {
    return `GitHub review request user:${request.target.login}`;
  }
  return `GitHub review request team:${request.target.organizationLogin}/${request.target.slug}`;
}

function addRuntimeSource(
  sources: Map<SourceId, PersonalReminderRuntimeSource>,
  source: PersonalReminderRuntimeSource,
): void {
  const previous = sources.get(source.source.sourceId);
  if (previous == null) {
    sources.set(source.source.sourceId, source);
    return;
  }
  if (
    previous.source.itemNodeId !== source.source.itemNodeId ||
    previous.source.kind !== source.source.kind ||
    previous.source.actorType !== source.source.actorType ||
    previous.source.actorCandidateId !== source.source.actorCandidateId ||
    previous.source.occurredAt !== source.source.occurredAt ||
    previous.source.summary !== source.source.summary
  ) {
    throw new TypeError(
      `個人催促runtime sourceの実体が重複しています。対象: ${source.source.sourceId}`,
    );
  }
  const roles = [...new Set([...previous.roles, ...source.roles])].sort(compareStrings);
  if (roles.length === 0) {
    throw new TypeError(
      `個人催促runtime sourceのroleがありません。対象: ${source.source.sourceId}`,
    );
  }
  const firstRole = roles[0];
  assertNonNullable(
    firstRole,
    `個人催促runtime sourceのroleがありません。対象: ${source.source.sourceId}`,
  );
  const roleTuple: readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] = [
    firstRole,
    ...roles.slice(1),
  ];
  sources.set(
    source.source.sourceId,
    Object.freeze({
      source: previous.source,
      roles: Object.freeze(roleTuple),
      evidence: Object.freeze(
        [
          ...new Map(
            [...previous.evidence, ...source.evidence].map((value) => [
              evidenceIdentity(value),
              value,
            ]),
          ).values(),
        ].sort((left, right) => compareStrings(evidenceIdentity(left), evidenceIdentity(right))),
      ),
      causalPush: previous.causalPush || source.causalPush,
    }),
  );
}

function sourceContext(
  itemNodeId: GitHubNodeId,
  sourceId: SourceId,
  kind: string,
  actorType: "human" | "bot" | "system",
  actorCandidate: string | undefined,
  occurredAt: UtcIsoDateTime,
  summary: string,
  causalPush: boolean,
): PersonalReminderRuntimeSource {
  const roles = sourceRolesForKind(kind);
  const source: PersonalReminderAiSourceContext = {
    sourceId,
    itemNodeId,
    kind,
    actorType,
    ...(actorCandidate == null ? {} : { actorCandidateId: actorCandidate }),
    occurredAt,
    summary,
  };
  return Object.freeze({
    source: Object.freeze(source),
    roles: Object.freeze(roles),
    evidence: Object.freeze([]),
    causalPush,
  });
}

function detailActorType(actor: GitHubDetailActor): "human" | "bot" | "system" {
  if (actor.status === "unavailable") {
    return "system";
  }
  return actor.account.apiType === "Bot" ? "bot" : "human";
}

function detailActorCandidateId(actor: GitHubDetailActor): string | undefined {
  return actor.status === "identified" ? actor.account.login : undefined;
}

function createRuntimeSources(
  item: PersonalReminderItem,
  detail: GitHubItemDetail,
  localDecision: PersonalReminderRuntimeLocalDecision,
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): Readonly<{
  sources: readonly PersonalReminderRuntimeSource[];
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  seedEvidence: readonly Evidence[];
  evidenceScopes: readonly PersonalReminderEvidenceScope[];
}> {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  const seedEvidence = new Map<SourceId, Evidence>();
  const contexts = [Object.freeze({ item, detail, localDecision }), ...relatedContexts];
  for (const context of contexts) {
    const contextItem = context.item;
    const contextDetail = context.detail;
    const contextDecision =
      context.localDecision == null ? undefined : determineLocalDecision(context.localDecision);
    const contextActionKind =
      contextDecision == null ? undefined : actionKindForDecision(contextDecision);
    const statusSourceIds = new Set([
      ...(contextDecision?.statusBasis.sourceIds ?? []),
      ...(contextDecision?.responsibilityBasis.sourceIds ?? []),
    ]);
    if (contextItem.nodeId !== contextDetail.nodeId || contextItem.type !== contextDetail.type) {
      throw new TypeError(
        `個人催促runtimeのitemとdetailが一致しません。対象: ${contextItem.nodeId}`,
      );
    }
    addRuntimeSource(
      sources,
      sourceContext(
        contextItem.nodeId,
        contextItem.sourceId,
        "item",
        actorTypeForItem(contextItem),
        actorCandidateId(contextItem.author),
        contextItem.createdAt,
        "GitHub item",
        false,
      ),
    );
    sourceOccurredAtById.set(contextItem.sourceId, contextItem.createdAt);
    if (contextDetail.body.length !== 0) {
      addRuntimeSource(
        sources,
        sourceContext(
          contextItem.nodeId,
          contextDetail.bodySourceId,
          "body",
          actorTypeForItem(contextItem),
          actorCandidateId(contextItem.author),
          contextItem.createdAt,
          contextDetail.body,
          false,
        ),
      );
      sourceOccurredAtById.set(contextDetail.bodySourceId, contextItem.createdAt);
    }
    const detailContentSourceIds = new Set<SourceId>([
      ...contextDetail.comments.map((comment) => comment.sourceId),
      ...(contextDetail.type === "pull_request"
        ? [
            ...contextDetail.reviews.map((review) => review.sourceId),
            ...contextDetail.reviewThreads.flatMap((thread) =>
              thread.comments.map((comment) => comment.sourceId),
            ),
          ]
        : []),
    ]);
    for (const event of contextItem.events) {
      if (detailContentSourceIds.has(event.sourceId)) {
        continue;
      }
      const causalPush =
        contextActionKind === "revision" &&
        statusSourceIds.has(event.sourceId) &&
        event.kind === "push";
      addRuntimeSource(
        sources,
        sourceContext(
          contextItem.nodeId,
          event.sourceId,
          event.kind,
          eventActorType(event),
          eventActorCandidateId(event),
          event.occurredAt,
          sourceSummaryForEvent(event),
          causalPush,
        ),
      );
      sourceOccurredAtById.set(event.sourceId, event.occurredAt);
    }
    for (const comment of contextDetail.comments) {
      if (comment.body.length === 0) {
        continue;
      }
      addRuntimeSource(
        sources,
        sourceContext(
          contextItem.nodeId,
          comment.sourceId,
          "comment",
          detailActorType(comment.author),
          detailActorCandidateId(comment.author),
          comment.createdAt,
          comment.body,
          false,
        ),
      );
      sourceOccurredAtById.set(comment.sourceId, comment.createdAt);
    }
    if (contextDetail.type === "pull_request") {
      for (const thread of contextDetail.reviewThreads) {
        for (const comment of thread.comments) {
          if (comment.body.length === 0) {
            continue;
          }
          addRuntimeSource(
            sources,
            sourceContext(
              contextItem.nodeId,
              comment.sourceId,
              "review_comment",
              detailActorType(comment.author),
              detailActorCandidateId(comment.author),
              comment.createdAt,
              comment.body,
              false,
            ),
          );
          sourceOccurredAtById.set(comment.sourceId, comment.createdAt);
        }
      }
      for (const review of contextDetail.reviews) {
        const reviewCommit =
          review.commit.status === "available" ? review.commit.sha : "commit-unavailable";
        addRuntimeSource(
          sources,
          sourceContext(
            contextItem.nodeId,
            review.sourceId,
            "review",
            detailActorType(review.author),
            detailActorCandidateId(review.author),
            review.submittedAt,
            `GitHub review ${review.state} ${reviewCommit}: ${review.body}`,
            false,
          ),
        );
        sourceOccurredAtById.set(review.sourceId, review.submittedAt);
      }
      for (const request of contextDetail.reviewRequests.current) {
        if (request.requestedAt.status === "unavailable") {
          continue;
        }
        if (sources.has(request.sourceId)) {
          continue;
        }
        addRuntimeSource(
          sources,
          sourceContext(
            contextItem.nodeId,
            request.sourceId,
            "review_request",
            "system",
            undefined,
            request.requestedAt.value,
            sourceSummaryForReviewRequest(request),
            false,
          ),
        );
        sourceOccurredAtById.set(request.sourceId, request.requestedAt.value);
      }
      addRuntimePullRequestSources(
        sources,
        sourceOccurredAtById,
        contextItem,
        contextDetail,
        statusSourceIds,
        contextActionKind,
      );
    }
    if (contextDecision != null) {
      for (const evidence of contextDecision.evidence) {
        if (evidence.sourceId === contextItem.sourceId || sources.has(evidence.sourceId)) {
          seedEvidence.set(evidence.sourceId, evidence);
        }
      }
    }
  }
  const evidenceScopes = [...sources.values()].map((entry) =>
    Object.freeze({ sourceId: entry.source.sourceId, roles: [...entry.roles] }),
  );
  return Object.freeze({
    sources: Object.freeze(
      [...sources.values()].sort((left, right) =>
        compareSourceIds(left.source.sourceId, right.source.sourceId),
      ),
    ),
    sourceOccurredAtById,
    seedEvidence: Object.freeze([...seedEvidence.values()]),
    evidenceScopes: Object.freeze(evidenceScopes),
  });
}

function addRuntimePullRequestSources(
  sources: Map<SourceId, PersonalReminderRuntimeSource>,
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  item: PersonalReminderItem,
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  causalSourceIds: ReadonlySet<SourceId>,
  actionKind: PersonalReminderActionKind | undefined,
): void {
  const headOccurredAt = resolvePullRequestCommitOccurredAt(detail.headCommit, item.createdAt);
  const causalPush =
    actionKind === "revision" &&
    detail.headCommit.pushedAt.status === "available" &&
    causalSourceIds.has(detail.headCommit.sourceId);
  const existingHead = sources.get(detail.headCommit.sourceId);
  if (existingHead == null) {
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        detail.headCommit.sourceId,
        "commit_added",
        "system",
        undefined,
        headOccurredAt,
        "GitHub head commit",
        causalPush,
      ),
    );
    sourceOccurredAtById.set(detail.headCommit.sourceId, headOccurredAt);
  } else {
    if (causalPush && !existingHead.causalPush) {
      addRuntimeSource(sources, Object.freeze({ ...existingHead, causalPush: true }));
    }
    sourceOccurredAtById.set(detail.headCommit.sourceId, existingHead.source.occurredAt);
  }

  if (detail.mergeState.autoMerge.status === "enabled") {
    const autoMerge = detail.mergeState.autoMerge;
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        autoMerge.sourceId,
        "auto_merge_request",
        detailActorType(autoMerge.enabledBy),
        detailActorCandidateId(autoMerge.enabledBy),
        autoMerge.enabledAt,
        `GitHub auto-merge ${autoMerge.mergeMethod}`,
        false,
      ),
    );
    sourceOccurredAtById.set(autoMerge.sourceId, autoMerge.enabledAt);
  }
  if (detail.mergeState.checks.status !== "configured") {
    return;
  }
  const checkOccurredAts: UtcIsoDateTime[] = [];
  for (const check of detail.mergeState.checks.contexts) {
    const occurredAt = checkContextOccurredAt(headOccurredAt, check);
    let summary: string;
    if (check.type === "check_run") {
      summary = `GitHub check_run ${check.name} ${check.conclusion}`;
    } else {
      summary = `GitHub commit_status ${check.context} ${check.state}`;
    }
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        check.sourceId,
        check.type,
        "system",
        undefined,
        occurredAt,
        summary,
        false,
      ),
    );
    sourceOccurredAtById.set(check.sourceId, occurredAt);
    checkOccurredAts.push(occurredAt);
  }
  const rollup = detail.mergeState.checks;
  const rollupOccurredAt = latestUtcIsoDateTime(
    [headOccurredAt, ...checkOccurredAts],
    `required check rollup ${rollup.sourceId}`,
  );
  addRuntimeSource(
    sources,
    sourceContext(
      item.nodeId,
      rollup.sourceId,
      "required_check_rollup",
      "system",
      undefined,
      rollupOccurredAt,
      `GitHub required checks ${rollup.combinedState}`,
      false,
    ),
  );
  sourceOccurredAtById.set(rollup.sourceId, rollupOccurredAt);
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

function latestUtcIsoDateTime(values: readonly UtcIsoDateTime[], context: string): UtcIsoDateTime {
  const firstValue = values[0];
  assertNonNullable(firstValue, `${context}の時刻がありません`);
  return values.slice(1).reduce((latest, value) => (latest < value ? value : latest), firstValue);
}

function basisFromEvent(event: NormalizedEvent): PersonalReminderTimeBasis {
  return Object.freeze({ source: "event", at: event.occurredAt, sourceIds: [event.sourceId] });
}

function timeBasisFromTransitionBasis(
  basis: Readonly<{
    sourceIds: readonly SourceId[];
    occurredAt: UtcIsoDateTime;
    precision: "event" | "inferred";
  }>,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderTimeBasis | undefined {
  if (basis.precision !== "event") {
    return undefined;
  }
  const sourceIds = basis.sourceIds.filter(
    (sourceId) => sourceOccurredAtById.get(sourceId) === basis.occurredAt,
  );
  if (sourceIds.length === 0) {
    return undefined;
  }
  return Object.freeze({
    source: "event",
    at: basis.occurredAt,
    sourceIds,
  });
}

function actionKindForDecision(
  decision: PersonalReminderLocalDecision,
): PersonalReminderActionKind | undefined {
  switch (decision.status) {
    case "waiting_for_assessment":
      return "assessment";
    case "waiting_for_owner":
      return "owner";
    case "waiting_for_decision":
      return "decision";
    case "waiting_for_review":
      return "review";
    case "waiting_for_revision":
      return "revision";
    case "waiting_for_reply":
      return "reply";
    case "waiting_for_work":
    case "in_progress":
      return "work";
    case "waiting_for_merge":
      return "merge";
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "unknown":
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return undefined;
  }
}

type PersonalReminderDecisionWaitingOn = PersonalReminderLocalDecision["waitingOn"][number];
type PersonalReminderResponsibleWaitingOn = Omit<
  PersonalReminderDecisionWaitingOn,
  "kind" | "role"
> &
  Readonly<{
    kind: "user" | "team" | "role";
    role: Exclude<PersonalReminderDecisionWaitingOn["role"], "dependency" | "ci">;
  }>;

function isPersonalReminderResponsibleWaitingOn(
  waitingOn: PersonalReminderDecisionWaitingOn,
): waitingOn is PersonalReminderResponsibleWaitingOn {
  return (
    (waitingOn.kind === "user" || waitingOn.kind === "team" || waitingOn.kind === "role") &&
    waitingOn.role !== "dependency" &&
    waitingOn.role !== "ci"
  );
}

function isRelevantProgressEvent(
  event: NormalizedEvent,
  actionKind: PersonalReminderActionKind | undefined,
): boolean {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return false;
  }
  if (actionKind === "work") {
    return event.kind === "push" || event.kind === "state";
  }
  if (actionKind === "reply") {
    return false;
  }
  if (actionKind === "review" || actionKind === "revision") {
    return event.kind === "review" && event.actor.type === "human";
  }
  if (actionKind === "owner") {
    return event.kind === "state" || event.kind === "label";
  }
  if (actionKind === "merge") {
    return event.kind === "state";
  }
  return (
    event.kind === "state" ||
    (event.kind === "relation" && event.relationType === "blocks" && event.action === "removed")
  );
}

function isResponsibleActivityEvent(
  event: NormalizedEvent,
  actionKind: PersonalReminderActionKind | undefined,
): boolean {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return false;
  }
  switch (actionKind) {
    case "work":
    case "revision":
      return event.kind === "push" || event.kind === "state";
    case "review":
      return event.kind === "review" && event.actor.type === "human";
    case "reply":
      return (
        (event.kind === "comment" && !event.bodyEmpty) ||
        (event.kind === "review" && event.state === "commented" && !event.bodyEmpty)
      );
    case "owner":
      return event.kind === "assignee" || event.kind === "label" || event.kind === "state";
    case "merge":
      return event.kind === "state";
    case "assessment":
    case "decision":
    case undefined:
      return false;
  }
}

function createActionActivity(
  item: PersonalReminderItem,
  actionKind: PersonalReminderActionKind | undefined,
  responsibleCandidateIds: ReadonlySet<string>,
): PersonalReminderRuntimeActivity {
  const relevantProgress = item.events
    .filter((event) => isRelevantProgressEvent(event, actionKind))
    .map(basisFromEvent);
  const responsibleActivity = item.events
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        responsibleCandidateIds.has(event.actor.login.toLowerCase()) &&
        isResponsibleActivityEvent(event, actionKind),
    )
    .map(basisFromEvent);
  const humanReviewActivity = item.events
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        event.kind === "review",
    )
    .map(basisFromEvent);
  return Object.freeze({
    relevantProgress: Object.freeze(relevantProgress),
    responsibleActivity: Object.freeze(responsibleActivity),
    humanReviewActivity: Object.freeze(humanReviewActivity),
    actionabilityStartByAction: new Map(),
  });
}

function createRuntimeActivity(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderRuntimeActivity {
  const actionKind = actionKindForDecision(decision);
  const responsibleCandidateIds = new Set(
    decision.waitingOn
      .filter(isPersonalReminderResponsibleWaitingOn)
      .map((waitingOn) => waitingOn.candidateId.toLowerCase()),
  );
  const activity = createActionActivity(item, actionKind, responsibleCandidateIds);
  if (actionKind == null) {
    return activity;
  }
  const actionabilityStartByAction = new Map(activity.actionabilityStartByAction);
  actionabilityStartByAction.set(
    actionKind,
    timeBasisFromTransitionBasis(decision.responsibilityBasis, sourceOccurredAtById),
  );
  return Object.freeze({ ...activity, actionabilityStartByAction });
}

function responsibilitySignature(value: PersonalReminderResponsible): string {
  return `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
}

function createResponsibilityScope(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sources: readonly PersonalReminderRuntimeSource[],
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): PersonalReminderResponsibility {
  const waitingSourceIds = new Set(decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds));
  const surfaces = new Map<GitHubNodeId, PersonalReminderExecutionSurface>();
  let hasSubjectSource = false;
  for (const source of sources) {
    if (!waitingSourceIds.has(source.source.sourceId)) {
      continue;
    }
    if (source.source.itemNodeId === item.nodeId) {
      hasSubjectSource = true;
      continue;
    }
    const related = relatedContexts.find(
      (context) => context.item.nodeId === source.source.itemNodeId,
    )?.item;
    if (related?.type === "pull_request" || related?.type === "issue") {
      surfaces.set(related.nodeId, Object.freeze({ kind: related.type, nodeId: related.nodeId }));
    }
  }
  const sortedSurfaces = [...surfaces.values()].sort((left, right) =>
    compareStrings(left.nodeId, right.nodeId),
  );
  const firstSurface = sortedSurfaces[0];
  const authority = responsibilityAuthority(item, decision);
  if (firstSurface == null) {
    return Object.freeze({ authority, scope: Object.freeze({ kind: "item" }) });
  }
  const surfaceTuple: readonly [
    PersonalReminderExecutionSurface,
    ...PersonalReminderExecutionSurface[],
  ] = [firstSurface, ...sortedSurfaces.slice(1)];
  const scope = hasSubjectSource
    ? Object.freeze({ kind: "item_and_execution_surfaces", surfaces: surfaceTuple })
    : Object.freeze({ kind: "execution_surfaces", surfaces: surfaceTuple });
  return Object.freeze({ authority, scope });
}

function responsibilityAuthority(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
): "fixed" | "semantic" {
  if (item.type === "issue" && decision.deterministicRulesVersion === "issue-v14") {
    return determineIssuePersonalReminderResponsibilityAuthority({ issue: item, decision });
  }
  if (item.type === "pull_request" && decision.deterministicRulesVersion === "pull-request-v12") {
    return determinePullRequestPersonalReminderResponsibilityAuthority(decision);
  }
  throw new TypeError(`個人催促責務のitemとstate decisionが一致しません。対象: ${item.nodeId}`);
}

function createResponsibilities(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sources: readonly PersonalReminderRuntimeSource[],
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): readonly [PersonalReminderResponsibility, ...PersonalReminderResponsibility[]] | undefined {
  const responsibles = decision.waitingOn
    .filter(isPersonalReminderResponsibleWaitingOn)
    .map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  const firstResponsible = responsibles[0];
  if (firstResponsible == null) {
    return undefined;
  }
  const unique = new Map<string, PersonalReminderResponsible>();
  for (const responsible of responsibles) {
    unique.set(responsibilitySignature(responsible), responsible);
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(responsibilitySignature(left), responsibilitySignature(right)),
  );
  const first = sorted[0];
  assertNonNullable(first, `個人催促runtimeの責任主体がありません。対象: ${item.nodeId}`);
  const scope = createResponsibilityScope(item, decision, sources, relatedContexts);
  return Object.freeze([scope]);
}

function executionSurfaceStates(
  graph: PersonalReminderRuntimeGraph,
  contexts: readonly PersonalReminderRuntimeRelatedContext[],
): ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge"> {
  const states = new Map<GitHubNodeId, "open" | "merged" | "closed_without_merge">();
  for (const context of contexts) {
    const state = graph.endpointStates.get(context.item.nodeId);
    if (state === "open") {
      states.set(context.item.nodeId, "open");
    } else if (state === "merged") {
      states.set(context.item.nodeId, "merged");
    } else if (state === "closed") {
      states.set(context.item.nodeId, "closed_without_merge");
    }
  }
  return states;
}

function pullRequestReviewState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_requested" | "requested" | "changes_requested" | "approved" | "mixed" | "unknown" {
  const reviewStates = item.events
    .filter((event) => event.kind === "review")
    .map((event) => event.state);
  const hasChangesRequested = reviewStates.includes("changes_requested");
  const hasApproved = reviewStates.includes("approved");
  if (hasChangesRequested && hasApproved) {
    return "mixed";
  }
  if (hasChangesRequested) {
    return "changes_requested";
  }
  if (hasApproved) {
    return "approved";
  }
  return item.reviewRequests.length === 0 ? "not_requested" : "requested";
}

function pullRequestCheckState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_required" | "passing" | "pending" | "failing" | "unknown" {
  if (item.mergeState.checks.status !== "configured") {
    return "not_required";
  }
  switch (item.mergeState.checks.combinedState) {
    case "success":
      return "passing";
    case "expected":
    case "pending":
      return "pending";
    case "error":
    case "failure":
      return "failing";
  }
}

function pullRequestMergeState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_ready" | "ready" | "queued" | "merged" | "closed_unmerged" | "unknown" {
  if (item.events.some((event) => event.kind === "state" && event.state === "merged")) {
    return "merged";
  }
  if (item.state === "closed") {
    return "closed_unmerged";
  }
  if (item.mergeState.mergeQueue.status === "queued") {
    return "queued";
  }
  if (item.mergeState.mergeState === "clean" && item.mergeState.mergeability === "mergeable") {
    return "ready";
  }
  if (item.mergeState.mergeability === "unknown" || item.mergeState.mergeState === "unknown") {
    return "unknown";
  }
  return "not_ready";
}

function createItemContext(item: PersonalReminderRuntimeItem): PersonalReminderAiItemContext {
  if (item.type === "issue") {
    return {
      nodeId: item.nodeId,
      url: item.url,
      title: item.title,
      type: "issue",
      state: item.state,
    };
  }
  const mergeState = pullRequestMergeState(item);
  let state: "open" | "closed_unmerged" | "merged" = "closed_unmerged";
  if (item.state === "open") {
    state = "open";
  } else if (mergeState === "merged") {
    state = "merged";
  }
  return {
    nodeId: item.nodeId,
    url: item.url,
    title: item.title,
    type: "pull_request",
    state,
    draft: item.draft,
    reviewState: pullRequestReviewState(item),
    checkState: pullRequestCheckState(item),
    mergeState,
  };
}

function createExternalReferenceItemContext(
  reference: PersonalReminderRuntimeExternalReference,
): PersonalReminderAiItemContext {
  return Object.freeze({
    nodeId: reference.nodeId,
    url: reference.url,
    title: reference.title,
    type: "external_reference",
    state: reference.state,
  });
}

function contextItemByNodeId(
  context: PersonalReminderRuntimeContext,
  nodeId: GraphNodeId,
): PersonalReminderRuntimeContextItem | undefined {
  return context.items.find((value) => value.item.nodeId === nodeId);
}

function candidateEndpointItemByNodeId(
  context: PersonalReminderRuntimeContext,
  nodeId: GraphNodeId,
): PersonalReminderRuntimeCandidateEndpointItem | undefined {
  return context.graph.candidateEndpointItemsByNodeId.get(nodeId);
}

function indexCandidateRelationsByTargetNodeId(
  graph: PersonalReminderRuntimeGraph,
): ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeCandidateRelation[]> {
  const candidatesByTargetNodeId = new Map<
    GraphNodeId,
    PersonalReminderRuntimeCandidateRelation[]
  >();
  for (const candidate of graph.candidateRelations) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      const endpoint = graph.candidateEndpointItemsByNodeId.get(endpointNodeId);
      if (endpoint?.type !== "issue") {
        continue;
      }
      const candidates = candidatesByTargetNodeId.get(endpointNodeId);
      if (candidates == null) {
        candidatesByTargetNodeId.set(endpointNodeId, [candidate]);
      } else {
        candidates.push(candidate);
      }
    }
  }
  return new Map(
    [...candidatesByTargetNodeId.entries()].map(([nodeId, candidates]) => [
      nodeId,
      Object.freeze(candidates),
    ]),
  );
}

/** 収集済み値から個人催促cause判定用のpure contextを作る。 */
export function createPersonalReminderRuntimeContext(
  input: Readonly<{
    evaluatedAt: UtcIsoDateTime;
    state: PersonalReminderRuntimeState;
    collection: PersonalReminderRuntimeCollection;
    graph: PersonalReminderRuntimeGraph;
    aiDependencyContext: AiAnalysisDependencyReconciliationContext;
    snapshotEvidenceSourceIds: ReadonlySet<SourceId>;
  }>,
): PersonalReminderRuntimeContext {
  const items: PersonalReminderRuntimeContextItem[] = [];
  const graph = Object.freeze({
    ...input.graph,
    candidateRelations: Object.freeze(
      input.graph.candidateRelations.map((candidate) =>
        Object.freeze({
          ...candidate,
          aiDependency: aiAnalysisDependencyForRelationCandidate(
            candidate.candidateId,
            candidate.endpointNodeIds,
            candidate.aiDependency,
          ),
        }),
      ),
    ),
  });
  const nodeIds = new Set<GitHubNodeId>();
  const externalNodeIds = new Set<GraphNodeId>();
  const externalItemContexts = input.graph.externalReferences.map((reference) => {
    if (externalNodeIds.has(reference.nodeId)) {
      throw new TypeError(`外部参照node IDが重複しています。対象: ${reference.nodeId}`);
    }
    externalNodeIds.add(reference.nodeId);
    return createExternalReferenceItemContext(reference);
  });
  for (const item of input.collection.items) {
    validateCollectedItem(item);
    if (nodeIds.has(item.item.nodeId)) {
      throw new TypeError(
        `個人催促runtime item node IDが重複しています。対象: ${item.item.nodeId}`,
      );
    }
    nodeIds.add(item.item.nodeId);
    if (item.localDecision.itemType !== item.item.type) {
      throw new TypeError(
        `個人催促runtimeのlocal decision種別が一致しません。対象: ${item.item.nodeId}`,
      );
    }
    const relatedNodeIds = new Set<GitHubNodeId>();
    for (const related of item.relatedContexts) {
      validateLocalDecision(
        related.item.type,
        related.localDecision,
        `個人催促runtimeの関連項目 ${related.item.nodeId}`,
      );
      if (
        related.detail.nodeId !== related.item.nodeId ||
        related.detail.type !== related.item.type
      ) {
        throw new TypeError(
          `個人催促runtimeの関連itemとdetailが一致しません。対象: ${related.item.nodeId}`,
        );
      }
      if (relatedNodeIds.has(related.item.nodeId) || related.item.nodeId === item.item.nodeId) {
        throw new TypeError(
          `個人催促runtimeの関連item node IDが重複しています。対象: ${related.item.nodeId}`,
        );
      }
      relatedNodeIds.add(related.item.nodeId);
    }
    const localDecision = determineLocalDecision(item.localDecision);
    const sourceProjection = createRuntimeSources(
      item.item,
      item.detail,
      item.localDecision,
      item.relatedContexts,
    );
    const responsibilities = createResponsibilities(
      item.item,
      localDecision,
      sourceProjection.sources,
      item.relatedContexts,
    );
    const previousCauses = createPreviousCauses(input.state, item);
    const previous = Object.freeze({
      ...previousCauses,
      causes: Object.freeze(
        previousCauses.causes.map((cause) =>
          reconcileRetainedPersonalReminderCause(cause, input.aiDependencyContext),
        ),
      ),
    });
    const activity = createRuntimeActivity(
      item.item,
      localDecision,
      sourceProjection.sourceOccurredAtById,
    );
    const allContexts = [
      Object.freeze({ item: item.item, detail: item.detail, localDecision: item.localDecision }),
      ...item.relatedContexts,
    ];
    const itemContext = createItemContext(item.item);
    const relatedItemContexts = Object.freeze(
      item.relatedContexts.map((context) => createItemContext(context.item)),
    );
    items.push(
      Object.freeze({
        ...item,
        localDecision,
        previous,
        sources: sourceProjection.sources,
        activity,
        stale: input.collection.staleNodeIds.has(item.item.nodeId),
        currentReviewRequestTargets: currentReviewTargetFromItem(item.item),
        executionSurfaceStates: executionSurfaceStates(graph, allContexts),
        sourceOccurredAtById: sourceProjection.sourceOccurredAtById,
        seedEvidence: sourceProjection.seedEvidence,
        evidenceScopes: sourceProjection.evidenceScopes,
        responsibilities: responsibilities ?? Object.freeze([]),
        itemContext,
        relatedItemContexts,
        externalItemContexts: Object.freeze(externalItemContexts),
        endpointStates: graph.endpointStates,
      }),
    );
  }
  const candidateRelationsByTargetNodeId = indexCandidateRelationsByTargetNodeId(graph);
  return Object.freeze({
    evaluatedAt: input.evaluatedAt,
    state: input.state,
    items: Object.freeze(items),
    graph,
    aiDependencyContext: input.aiDependencyContext,
    candidateRelationsByTargetNodeId,
    snapshotEvidenceSourceIds: input.snapshotEvidenceSourceIds,
  });
}

function endpointIsOpen(
  graph: PersonalReminderRuntimeGraph,
  relation: Readonly<{ fromNodeId: GraphNodeId; toNodeId: GraphNodeId }>,
): boolean {
  const fromState = graph.endpointStates.get(relation.fromNodeId);
  const toState = graph.endpointStates.get(relation.toNodeId);
  if (fromState == null || toState == null) {
    throw new TypeError("graph relationのendpoint stateがありません");
  }
  return fromState === "open" && toState === "open";
}

function endpointStateAllowsRelation(
  graph: PersonalReminderRuntimeGraph,
  nodeId: GraphNodeId,
): boolean {
  const state = graph.endpointStates.get(nodeId);
  if (state == null) {
    throw new TypeError(`graph relationのendpoint stateがありません。対象: ${nodeId}`);
  }
  return state === "open" || state === "missing";
}

function relationEndpointsAllowPending(
  graph: PersonalReminderRuntimeGraph,
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
): boolean {
  return (
    endpointStateAllowsRelation(graph, endpointNodeIds[0]) &&
    endpointStateAllowsRelation(graph, endpointNodeIds[1])
  );
}

function activeRelationIsEffective(
  graph: PersonalReminderRuntimeGraph,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): boolean {
  return endpointIsOpen(graph, relation);
}

function candidateAffectsCause(
  candidate: PersonalReminderRuntimeCandidateRelation,
  cause: PersonalReminderCauseSeed,
): boolean {
  const scopeNodeIds = seedScopeNodeIds(cause);
  return candidate.endpointNodeIds.some((nodeId) => scopeNodeIds.has(nodeId));
}

function scopeNodeIds(
  itemNodeId: GraphNodeId,
  scope: PersonalReminderTargetScope,
): ReadonlySet<GraphNodeId> {
  const nodeIds = new Set<GraphNodeId>([itemNodeId]);
  if (scope.kind !== "item") {
    for (const surface of scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds;
}

function seedScopeNodeIds(seed: PersonalReminderCauseSeed): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(seed.itemNodeId, seed.responsibility.scope);
}

function optionTargetScopeNodeIds(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
  }>,
): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(option.itemNodeId, option.targetScope);
}

function targetScopeForSeed(seed: PersonalReminderCauseSeed): PersonalReminderTargetScope {
  return seed.responsibility.scope;
}

function relationConnectsScopes(
  relation: PersonalReminderRuntimeActiveRelation,
  leftNodeIds: ReadonlySet<GraphNodeId>,
  rightNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  return (
    (leftNodeIds.has(relation.fromNodeId) && rightNodeIds.has(relation.toNodeId)) ||
    (leftNodeIds.has(relation.toNodeId) && rightNodeIds.has(relation.fromNodeId))
  );
}

function createPersonalReminderPlanningIndexes(
  context: PersonalReminderRuntimeContext,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimePlanningIndexes {
  const activeRelationsByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeActiveRelation[]>();
  for (const relation of context.graph.activeRelations) {
    const fromRelations = activeRelationsByNodeId.get(relation.fromNodeId);
    if (fromRelations == null) {
      activeRelationsByNodeId.set(relation.fromNodeId, [relation]);
    } else {
      fromRelations.push(relation);
    }
    if (relation.toNodeId === relation.fromNodeId) {
      continue;
    }
    const toRelations = activeRelationsByNodeId.get(relation.toNodeId);
    if (toRelations == null) {
      activeRelationsByNodeId.set(relation.toNodeId, [relation]);
    } else {
      toRelations.push(relation);
    }
  }

  const currentSeedByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderRuntimeCurrentSeed
  >();
  const currentSeedsByItemNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCurrentSeed[]>();
  const currentSeedsByScopeNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCurrentSeed[]>();
  const scopeNodeIdsByCauseId = new Map<PersonalReminderCauseId, ReadonlySet<GraphNodeId>>();
  for (const currentSeed of currentSeeds) {
    if (currentSeedByCauseId.has(currentSeed.seed.causeId)) {
      throw new TypeError(`current seed IDが重複しています。対象: ${currentSeed.seed.causeId}`);
    }
    currentSeedByCauseId.set(currentSeed.seed.causeId, currentSeed);
    const itemSeeds = currentSeedsByItemNodeId.get(currentSeed.seed.itemNodeId);
    if (itemSeeds == null) {
      currentSeedsByItemNodeId.set(currentSeed.seed.itemNodeId, [currentSeed]);
    } else {
      itemSeeds.push(currentSeed);
    }
    const nodeIds = seedScopeNodeIds(currentSeed.seed);
    scopeNodeIdsByCauseId.set(currentSeed.seed.causeId, nodeIds);
    for (const nodeId of nodeIds) {
      const scopedSeeds = currentSeedsByScopeNodeId.get(nodeId);
      if (scopedSeeds == null) {
        currentSeedsByScopeNodeId.set(nodeId, [currentSeed]);
      } else {
        scopedSeeds.push(currentSeed);
      }
    }
  }

  return Object.freeze({
    activeRelationsByNodeId: new Map(
      [...activeRelationsByNodeId].map(([nodeId, relations]) => [nodeId, Object.freeze(relations)]),
    ),
    currentSeedByCauseId,
    currentSeedsByItemNodeId: new Map(
      [...currentSeedsByItemNodeId].map(([nodeId, seeds]) => [nodeId, Object.freeze(seeds)]),
    ),
    currentSeedsByScopeNodeId: new Map(
      [...currentSeedsByScopeNodeId].map(([nodeId, seeds]) => [nodeId, Object.freeze(seeds)]),
    ),
    scopeNodeIdsByCauseId,
  });
}

function scopeNodeIdsForSeed(
  indexes: PersonalReminderRuntimePlanningIndexes,
  seed: PersonalReminderCauseSeed,
): ReadonlySet<GraphNodeId> {
  const nodeIds = indexes.scopeNodeIdsByCauseId.get(seed.causeId);
  assertNonNullable(nodeIds, `current seedのscopeがありません。対象: ${seed.causeId}`);
  return nodeIds;
}

function relationsIncidentToScope(
  indexes: PersonalReminderRuntimePlanningIndexes,
  nodeIds: ReadonlySet<GraphNodeId>,
): readonly PersonalReminderRuntimeActiveRelation[] {
  const relationsById = new Map<string, PersonalReminderRuntimeActiveRelation>();
  for (const nodeId of nodeIds) {
    for (const relation of indexes.activeRelationsByNodeId.get(nodeId) ?? []) {
      relationsById.set(relation.id, relation);
    }
  }
  return Object.freeze([...relationsById.values()]);
}

function connectedSeedRelations(
  indexes: PersonalReminderRuntimePlanningIndexes,
  seed: PersonalReminderCauseSeed,
  relations: readonly PersonalReminderRuntimeActiveRelation[],
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderConnectedSeedRelations> {
  const seedNodeIds = scopeNodeIdsForSeed(indexes, seed);
  const relationsByCauseId = new Map<
    PersonalReminderCauseId,
    Readonly<{
      currentSeed: PersonalReminderRuntimeCurrentSeed;
      relationsById: Map<string, PersonalReminderRuntimeActiveRelation>;
    }>
  >();
  for (const relation of relations) {
    const candidateSeeds: PersonalReminderRuntimeCurrentSeed[] = [];
    if (seedNodeIds.has(relation.fromNodeId)) {
      candidateSeeds.push(...(indexes.currentSeedsByScopeNodeId.get(relation.toNodeId) ?? []));
    }
    if (seedNodeIds.has(relation.toNodeId)) {
      candidateSeeds.push(...(indexes.currentSeedsByScopeNodeId.get(relation.fromNodeId) ?? []));
    }
    for (const candidate of candidateSeeds) {
      if (
        !relationConnectsScopes(relation, seedNodeIds, scopeNodeIdsForSeed(indexes, candidate.seed))
      ) {
        continue;
      }
      const existing = relationsByCauseId.get(candidate.seed.causeId);
      if (existing == null) {
        relationsByCauseId.set(
          candidate.seed.causeId,
          Object.freeze({
            currentSeed: candidate,
            relationsById: new Map([[relation.id, relation]]),
          }),
        );
      } else {
        existing.relationsById.set(relation.id, relation);
      }
    }
  }
  return new Map(
    [...relationsByCauseId]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([causeId, value]) => [
        causeId,
        Object.freeze({
          currentSeed: value.currentSeed,
          relations: Object.freeze(
            [...value.relationsById.values()].sort((left, right) =>
              compareStrings(left.id, right.id),
            ),
          ),
        }),
      ]),
  );
}

function seedRepresentsImplementsSource(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): boolean {
  if (relation.type !== "implements") {
    return false;
  }
  const item = contextItemByNodeId(context, seed.itemNodeId);
  return item?.item.type === "pull_request" && relation.fromNodeId === seed.itemNodeId;
}

function duplicateCanonicalSeed(
  context: PersonalReminderRuntimeContext,
  left: PersonalReminderRuntimeCurrentSeed,
  right: PersonalReminderRuntimeCurrentSeed,
  relations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
): PersonalReminderRuntimeCurrentSeed {
  const implementsRelation = relations.find((relation) => relation.type === "implements");
  if (implementsRelation != null) {
    const leftIsImplementation = seedRepresentsImplementsSource(
      context,
      left.seed,
      implementsRelation,
    );
    const rightIsImplementation = seedRepresentsImplementsSource(
      context,
      right.seed,
      implementsRelation,
    );
    if (leftIsImplementation !== rightIsImplementation) {
      return leftIsImplementation ? left : right;
    }
  }
  return compareStrings(left.seed.causeId, right.seed.causeId) <= 0 ? left : right;
}

function relationContextFromEdge(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): PersonalReminderAiRelationContext {
  const evidenceSourceIds = createNonEmptySourceIds(
    relation.evidence.map((evidence) => evidence.sourceId),
    `relation ${relation.id}`,
  );
  return Object.freeze({
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    authoritative: relation.authoritative,
    evidenceSourceIds: [...evidenceSourceIds],
  });
}

function relationSourcesFromEdge(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  canonicalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
): PersonalReminderRuntimeSourceProjection {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missingSourceIds = new Set<SourceId>();
  for (const evidence of relation.evidence) {
    const canonicalSource = canonicalSourcesById.get(evidence.sourceId);
    if (canonicalSource == null) {
      missingSourceIds.add(evidence.sourceId);
      continue;
    }
    addRuntimeSource(
      sources,
      Object.freeze({
        source: canonicalSource.source,
        roles: createRuntimeSourceRoles([...canonicalSource.roles, "relation"]),
        evidence: Object.freeze([evidence]),
        causalPush: canonicalSource.causalPush,
      }),
    );
  }
  return Object.freeze({
    sources: Object.freeze([...sources.values()]),
    missingSourceIds: Object.freeze([...missingSourceIds].sort(compareStrings)),
  });
}

function relationSourceProjectionForEdges(
  relations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  canonicalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
): PersonalReminderRuntimeSourceProjection {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missingSourceIds = new Set<SourceId>();
  for (const relation of relations) {
    const projection = relationSourcesFromEdge(relation, canonicalSourcesById);
    for (const source of projection.sources) {
      addRuntimeSource(sources, source);
    }
    for (const sourceId of projection.missingSourceIds) {
      missingSourceIds.add(sourceId);
    }
  }
  return Object.freeze({
    sources: Object.freeze([...sources.values()]),
    missingSourceIds: Object.freeze([...missingSourceIds].sort(compareStrings)),
  });
}

function pendingRelationContext(
  candidate: PersonalReminderRuntimeCandidateRelation,
  resolution: PendingRelationCandidateResolution,
): PersonalReminderPendingRelation {
  const endpointNodeIds: [GraphNodeId, GraphNodeId] = [
    candidate.endpointNodeIds[0],
    candidate.endpointNodeIds[1],
  ];
  return Object.freeze({
    candidateId: candidate.candidateId,
    endpointNodeIds,
    status: "pending",
    reason: resolution.reason,
    evidenceSourceIds: [...candidate.evidenceSourceIds],
  });
}

function currentReviewTargetFromItem(
  item: PersonalReminderItem,
): readonly PersonalReminderReviewRequestTarget[] {
  if (item.type !== "pull_request") {
    return Object.freeze([]);
  }
  return Object.freeze(
    item.reviewRequests.map((request) =>
      request.target.type === "user"
        ? Object.freeze({ kind: "user", candidateId: request.target.actor.login })
        : Object.freeze({
            kind: "team",
            candidateId: `${request.target.organizationLogin}/${request.target.slug}`,
          }),
    ),
  );
}

function graphRelationSupportRank(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): number {
  if (relation.authoritative) {
    return 0;
  }
  switch (relation.aiDependency.status) {
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    case "not_dependent":
      return 4;
    default:
      throw new TypeError(`implements relationのAI依存状態が不正です。対象: ${relation.id}`);
  }
}

function compareGraphRelationSupport(
  left: ReconciledGraphEdge & Readonly<{ active: true }>,
  right: ReconciledGraphEdge & Readonly<{ active: true }>,
): number {
  const rankDifference = graphRelationSupportRank(left) - graphRelationSupportRank(right);
  return rankDifference === 0 ? compareStrings(left.id, right.id) : rankDifference;
}

function graphRelationAiDependencies(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): PersonalReminderCauseAiDependencies {
  return Object.freeze({
    presence: relation.aiDependency,
    responseMembership: Object.freeze({ status: "not_dependent" }),
    responsible: relation.aiDependency,
    action: Object.freeze({ status: "not_dependent" }),
    evidence: relation.aiDependency,
  });
}

function personalReminderCauseSeedAiDependencyInputs(
  currentSeed: PersonalReminderRuntimeCurrentSeed,
): readonly AiAnalysisDependencyInput[] {
  const seed = currentSeed.seed;
  return Object.freeze([
    seedAiDependencyInput(seed.aiDependencies.presence, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.responsible, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.action, currentSeed.origin),
    seedAiDependencyInput(seed.aiDependencies.evidence, currentSeed.origin),
  ]);
}

function makeGraphDraft(
  item: PersonalReminderItem,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  authorLogin: string,
  surfaces: readonly PersonalReminderExecutionSurface[],
): PersonalReminderCauseDraft {
  const sourceIds = createNonEmptySourceIds(
    relation.evidence.map((evidence) => evidence.sourceId),
    `implements relation ${relation.id}`,
  );
  const firstSurface = surfaces[0];
  assertNonNullable(
    firstSurface,
    `implements relationのexecution surfaceがありません。対象: ${relation.id}`,
  );
  const surfaceTuple: readonly [
    PersonalReminderExecutionSurface,
    ...PersonalReminderExecutionSurface[],
  ] = [firstSurface, ...surfaces.slice(1)];
  const responsible: PersonalReminderResponsible = Object.freeze({
    kind: "user",
    candidateId: authorLogin,
    role: "assignee",
  });
  const responsibleTuple: readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] =
    [responsible];
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode: "work_overdue",
    responsible: responsibleTuple,
    action: Object.freeze({ kind: "work", summary: "実装項目を進める" }),
    evidenceSourceIds: sourceIds,
    responsibilityBasis: Object.freeze({
      sourceIds,
      occurredAt: relation.firstSeenAt,
      precision: "event",
    }),
    responsibility: Object.freeze({
      authority: "semantic",
      scope: Object.freeze({
        kind: "execution_surfaces",
        surfaces: surfaceTuple,
      }),
    }),
    aiDependencies: graphRelationAiDependencies(relation),
  });
}

function graphDerivedDrafts(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
): PersonalReminderGraphDraftProjection {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze({
      drafts: Object.freeze([]),
    });
  }
  const grouped = new Map<
    string,
    { login: string; relations: (ReconciledGraphEdge & Readonly<{ active: true }>)[] }
  >();
  for (const relation of context.graph.activeRelations) {
    if (!activeRelationIsEffective(context.graph, relation) || relation.type !== "implements") {
      continue;
    }
    if (relation.toNodeId !== item.item.nodeId) {
      continue;
    }
    const implementation = candidateEndpointItemByNodeId(context, relation.fromNodeId);
    if (implementation?.type !== "pull_request" || implementation.state !== "open") {
      continue;
    }
    if (implementation.author.status !== "identified" || implementation.author.type !== "human") {
      continue;
    }
    const login = implementation.author.login;
    const key = login.toLowerCase();
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, { login, relations: [relation] });
    } else {
      existing.relations.push(relation);
    }
  }
  const localWorkActors = new Set(
    localDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const drafts: PersonalReminderCauseDraft[] = [];
  for (const group of [...grouped.values()].sort((left, right) =>
    compareStrings(left.login, right.login),
  )) {
    const firstRelation = [...group.relations].sort(compareGraphRelationSupport)[0];
    assertNonNullable(firstRelation, "graph由来責務のrelationがありません");
    if (localWorkActors.has(group.login.toLowerCase())) {
      continue;
    }
    const surfacesByNodeId = new Map<GitHubNodeId, PersonalReminderExecutionSurface>();
    for (const relation of group.relations) {
      const implementation = candidateEndpointItemByNodeId(context, relation.fromNodeId);
      assertNonNullable(
        implementation,
        `implements relationの実装項目がありません。対象: ${relation.id}`,
      );
      if (implementation.type !== "pull_request") {
        throw new TypeError(`implements relationの実装項目種別が不正です。対象: ${relation.id}`);
      }
      surfacesByNodeId.set(
        implementation.nodeId,
        Object.freeze({ kind: implementation.type, nodeId: implementation.nodeId }),
      );
    }
    const surfaces = [...surfacesByNodeId.values()].sort((left, right) =>
      compareStrings(left.nodeId, right.nodeId),
    );
    drafts.push(makeGraphDraft(item.item, firstRelation, group.login, surfaces));
  }
  return Object.freeze({
    drafts: Object.freeze(drafts),
  });
}

function candidateIsActualPositiveImplements(
  candidate: PersonalReminderRuntimeCandidateRelation,
  implementationNodeId: GraphNodeId,
  targetNodeId: GraphNodeId,
): boolean {
  const resolution = candidate.resolution;
  const canonicalRelation = candidate.canonicalRelation;
  return (
    resolution?.status === "active" &&
    canonicalRelation?.type === "implements" &&
    canonicalRelation.fromNodeId === implementationNodeId &&
    canonicalRelation.toNodeId === targetNodeId
  );
}

function candidateTargetNodeId(candidate: PersonalReminderRuntimeCandidateRelation): GraphNodeId {
  const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
  if (firstNodeId === secondNodeId) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.candidateId}`);
  }
  if (candidate.ownerNodeId === firstNodeId) {
    return secondNodeId;
  }
  if (candidate.ownerNodeId === secondNodeId) {
    return firstNodeId;
  }
  throw new TypeError(
    `個人催促relation候補のownerがendpointではありません。対象: ${candidate.candidateId}`,
  );
}

function negativeWorkCandidateEndpoints(
  context: PersonalReminderRuntimeContext,
  candidate: PersonalReminderRuntimeCandidateRelation,
):
  | Readonly<{
      implementation: PersonalReminderRuntimeCandidateEndpointItem;
      target: PersonalReminderRuntimeCandidateEndpointItem;
    }>
  | undefined {
  if (candidate.authority !== "inferred") {
    return undefined;
  }
  const resolution = candidate.resolution;
  if (
    resolution == null ||
    (resolution.status === "rejected" && resolution.reason === "blocker_not_open")
  ) {
    return undefined;
  }
  const implementation = candidateEndpointItemByNodeId(context, candidate.ownerNodeId);
  const target = candidateEndpointItemByNodeId(context, candidateTargetNodeId(candidate));
  if (implementation?.type !== "pull_request" || target?.type !== "issue") {
    return undefined;
  }
  if (implementation.author.status !== "identified" || implementation.author.type !== "human") {
    return undefined;
  }
  if (
    implementation.state !== "open" ||
    target.state !== "open" ||
    !endpointIsOpen(context.graph, {
      fromNodeId: implementation.nodeId,
      toNodeId: target.nodeId,
    }) ||
    candidateIsActualPositiveImplements(candidate, implementation.nodeId, target.nodeId)
  ) {
    return undefined;
  }
  return Object.freeze({ implementation, target });
}

function negativeCandidateDependenciesForIssue(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
  positiveDrafts: readonly PersonalReminderCauseDraft[],
): readonly PersonalReminderRuntimeSubjectDependency[] {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze([]);
  }
  const localWorkActors = new Set(
    localDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const positiveGraphActors = new Set(
    positiveDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const grouped = new Map<
    string,
    Readonly<{
      login: string;
      candidates: PersonalReminderRuntimeCandidateRelation[];
    }>
  >();
  for (const candidate of context.candidateRelationsByTargetNodeId.get(item.item.nodeId) ?? []) {
    const endpoints = negativeWorkCandidateEndpoints(context, candidate);
    if (endpoints?.target.nodeId !== item.item.nodeId) {
      continue;
    }
    const author = endpoints.implementation.author;
    if (author.status !== "identified" || author.type !== "human") {
      continue;
    }
    const login = author.login;
    const key = login.toLowerCase();
    if (localWorkActors.has(key) || positiveGraphActors.has(key)) {
      continue;
    }
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, { login, candidates: [candidate] });
    } else {
      existing.candidates.push(candidate);
    }
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => compareStrings(left.login, right.login))
      .map((group) =>
        Object.freeze({
          subject: Object.freeze({ kind: "user", candidateId: group.login }),
          inputs: Object.freeze(
            group.candidates.map((candidate) => currentAiDependencyInput(candidate.aiDependency)),
          ),
        }),
      ),
  );
}

function sourceIdsForRelationContexts(
  relations: readonly PersonalReminderAiRelationContext[],
): readonly SourceId[] {
  return relations.flatMap((relation) => relation.evidenceSourceIds);
}

function sourceIdsForPendingRelations(
  relations: readonly PersonalReminderPendingRelation[],
): readonly SourceId[] {
  return relations.flatMap((relation) => relation.evidenceSourceIds);
}

function completenessForCause(
  item: PersonalReminderRuntimeContextItem,
  pendingRelations: readonly PersonalReminderPendingRelation[],
  additionalMissing: readonly PersonalReminderMissingInput[],
): PersonalReminderInputCompleteness {
  if (
    item.completeness.status === "complete" &&
    pendingRelations.length === 0 &&
    additionalMissing.length === 0
  ) {
    return Object.freeze({ status: "complete" });
  }
  const missing = item.completeness.status === "incomplete" ? [...item.completeness.missing] : [];
  if (pendingRelations.length !== 0 && !missing.includes("relation_evidence")) {
    missing.push("relation_evidence");
  }
  for (const value of additionalMissing) {
    if (!missing.includes(value)) {
      missing.push(value);
    }
  }
  const first = missing[0];
  assertNonNullable(first, "不完全cause入力の不足項目がありません");
  return Object.freeze({
    status: "incomplete",
    missing: [first, ...missing.slice(1)],
  });
}

function createCauseSemanticInput(
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  globalCausalSourcesByNodeId: ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeSource[]>,
  globalItemContextsByNodeId: ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext>,
  seed: PersonalReminderCauseSeed,
  relationContexts: readonly PersonalReminderAiRelationContext[],
  pendingRelations: readonly PersonalReminderPendingRelation[],
  waitingOptions: readonly PersonalReminderWaitingOption[],
  duplicateOptions: readonly PersonalReminderDuplicateOption[],
  relationSources: readonly PersonalReminderRuntimeSource[],
  optionSources: readonly PersonalReminderRuntimeSource[],
  additionalItemContexts: readonly PersonalReminderAiItemContext[],
  additionalMissing: readonly PersonalReminderMissingInput[],
): PersonalReminderCauseSemanticInput {
  const seedScope = seedScopeNodeIds(seed);
  const itemContextNodeIds = new Set(seedScope);
  for (const relation of relationContexts) {
    itemContextNodeIds.add(relation.fromNodeId);
    itemContextNodeIds.add(relation.toNodeId);
  }
  for (const relation of pendingRelations) {
    const [firstEndpoint, secondEndpoint] = relation.endpointNodeIds;
    itemContextNodeIds.add(firstEndpoint);
    itemContextNodeIds.add(secondEndpoint);
  }
  for (const option of [...waitingOptions, ...duplicateOptions]) {
    for (const nodeId of optionTargetScopeNodeIds(option)) {
      itemContextNodeIds.add(nodeId);
    }
  }
  for (const context of additionalItemContexts) {
    itemContextNodeIds.add(context.nodeId);
  }
  const seedSourceIds = new Set(seed.evidenceSourceIds);
  const nonSeedRequiredSourceIds = new Set<SourceId>([
    ...sourceIdsForRelationContexts(relationContexts),
    ...sourceIdsForPendingRelations(pendingRelations),
    ...waitingOptions.flatMap((option) => option.evidenceSourceIds),
    ...duplicateOptions.flatMap((option) => option.evidenceSourceIds),
  ]);
  const relationEvidenceSourceIds = new Set<SourceId>([
    ...sourceIdsForRelationContexts(relationContexts),
    ...sourceIdsForPendingRelations(pendingRelations),
  ]);
  const requiredSourceIds = new Set<SourceId>([...seedSourceIds, ...nonSeedRequiredSourceIds]);
  const allSources = new Map<SourceId, PersonalReminderRuntimeSource>();
  for (const source of item.sources) {
    addRuntimeSource(allSources, source);
  }
  for (const source of relationSources) {
    if (!allSources.has(source.source.sourceId)) {
      addRuntimeSource(allSources, source);
    }
  }
  for (const source of optionSources) {
    if (!allSources.has(source.source.sourceId)) {
      addRuntimeSource(allSources, source);
    }
  }
  for (const sourceId of requiredSourceIds) {
    const source = globalSourcesById.get(sourceId);
    if (source != null) {
      addRuntimeSource(allSources, source);
    }
  }
  const requiredSourceOwnerNodeIds = new Set<GraphNodeId>();
  for (const sourceId of requiredSourceIds) {
    const source = globalSourcesById.get(sourceId);
    if (source != null) {
      requiredSourceOwnerNodeIds.add(source.source.itemNodeId);
      itemContextNodeIds.add(source.source.itemNodeId);
    }
  }
  const availableContextNodeIds = new Set(
    [
      item.itemContext,
      ...item.relatedItemContexts,
      ...item.externalItemContexts,
      ...additionalItemContexts,
    ].map((context) => context.nodeId),
  );
  for (const nodeId of requiredSourceOwnerNodeIds) {
    if (globalItemContextsByNodeId.has(nodeId)) {
      availableContextNodeIds.add(nodeId);
    }
  }
  for (const nodeId of itemContextNodeIds) {
    if (!availableContextNodeIds.has(nodeId)) {
      continue;
    }
    for (const source of globalCausalSourcesByNodeId.get(nodeId) ?? []) {
      addRuntimeSource(allSources, source);
    }
  }
  const sourceById = allSources;
  for (const sourceId of seedSourceIds) {
    const source = sourceById.get(sourceId);
    if (
      source != null &&
      (source.source.kind === "push" || source.source.kind === "commit_added") &&
      !source.causalPush &&
      !nonSeedRequiredSourceIds.has(sourceId)
    ) {
      requiredSourceIds.delete(sourceId);
    }
  }
  const missingSeedSourceIds = new Set<SourceId>();
  const missingRelationEvidenceSourceIds = new Set<SourceId>();
  const sources = [...allSources.values()]
    .filter((entry) => {
      if (
        requiredSourceIds.has(entry.source.sourceId) ||
        (entry.causalPush &&
          itemContextNodeIds.has(entry.source.itemNodeId) &&
          availableContextNodeIds.has(entry.source.itemNodeId))
      ) {
        return true;
      }
      if (!availableContextNodeIds.has(entry.source.itemNodeId)) {
        return false;
      }
      if (
        entry.source.kind === "push" ||
        entry.source.kind === "commit_added" ||
        entry.source.kind === "check_run" ||
        entry.source.kind === "commit_status"
      ) {
        return false;
      }
      return seedScope.has(entry.source.itemNodeId);
    })
    .map((entry) => entry.source);
  for (const sourceId of requiredSourceIds) {
    if (!sourceById.has(sourceId)) {
      if (relationEvidenceSourceIds.has(sourceId)) {
        missingRelationEvidenceSourceIds.add(sourceId);
        continue;
      }
      if (seedSourceIds.has(sourceId) && !nonSeedRequiredSourceIds.has(sourceId)) {
        missingSeedSourceIds.add(sourceId);
        continue;
      }
      throw new TypeError(`causeに必要なsourceがありません。対象: ${sourceId}`);
    }
  }
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  for (const sourceId of requiredSourceIds) {
    if (!sourceIds.has(sourceId)) {
      if (relationEvidenceSourceIds.has(sourceId)) {
        missingRelationEvidenceSourceIds.add(sourceId);
        continue;
      }
      if (missingSeedSourceIds.has(sourceId)) {
        continue;
      }
      throw new TypeError(`causeに必要なsourceが公開入力へ投影されていません。対象: ${sourceId}`);
    }
  }
  const evidenceScopesBySourceId = new Map<SourceId, Set<PersonalReminderEvidenceRole>>();
  for (const scope of item.evidenceScopes) {
    if (!sourceIds.has(scope.sourceId)) {
      continue;
    }
    evidenceScopesBySourceId.set(scope.sourceId, new Set(scope.roles));
  }
  for (const source of relationSources) {
    if (!sourceIds.has(source.source.sourceId)) {
      continue;
    }
    const roles = evidenceScopesBySourceId.get(source.source.sourceId) ?? new Set();
    for (const role of source.roles) {
      roles.add(role);
    }
    evidenceScopesBySourceId.set(source.source.sourceId, roles);
  }
  for (const relation of pendingRelations) {
    for (const sourceId of relation.evidenceSourceIds) {
      const source = sourceById.get(sourceId);
      if (source == null) {
        missingRelationEvidenceSourceIds.add(sourceId);
        continue;
      }
      if (!sourceIds.has(sourceId)) {
        continue;
      }
      const roles = evidenceScopesBySourceId.get(sourceId) ?? new Set();
      roles.add("relation");
      for (const role of source.roles) {
        roles.add(role);
      }
      evidenceScopesBySourceId.set(sourceId, roles);
    }
  }
  for (const source of optionSources) {
    if (!sourceIds.has(source.source.sourceId)) {
      continue;
    }
    const roles = evidenceScopesBySourceId.get(source.source.sourceId) ?? new Set();
    for (const role of source.roles) {
      roles.add(role);
    }
    evidenceScopesBySourceId.set(source.source.sourceId, roles);
  }
  const evidenceScopes = [...evidenceScopesBySourceId.entries()]
    .sort(([left], [right]) => compareSourceIds(left, right))
    .map(([sourceId, roles]) => {
      const sortedRoles = [...roles].sort(compareStrings);
      const firstRole = sortedRoles[0];
      assertNonNullable(firstRole, `source roleがありません。対象: ${sourceId}`);
      return {
        sourceId,
        roles: [firstRole, ...sortedRoles.slice(1)],
      };
    });
  if (sources.length === 0 || evidenceScopes.length === 0) {
    throw new TypeError(`causeのsource role投影がありません。対象: ${seed.causeId}`);
  }
  const itemContextsByNodeId = new Map(
    [
      item.itemContext,
      ...item.relatedItemContexts,
      ...item.externalItemContexts,
      ...additionalItemContexts,
    ]
      .filter((value) => itemContextNodeIds.has(value.nodeId))
      .map((value) => [value.nodeId, value]),
  );
  for (const nodeId of requiredSourceOwnerNodeIds) {
    const itemContext = globalItemContextsByNodeId.get(nodeId);
    if (itemContext != null) {
      itemContextsByNodeId.set(nodeId, itemContext);
    }
  }
  const items = [...itemContextsByNodeId.values()];
  const missing: PersonalReminderMissingInput[] = [...additionalMissing];
  const itemContextIds = new Set(items.map((value) => value.nodeId));
  const externalContextNodeIds = new Set(
    item.externalItemContexts.map((context) => context.nodeId),
  );
  const addMissing = (value: PersonalReminderMissingInput): void => {
    if (!missing.includes(value)) {
      missing.push(value);
    }
  };
  for (const nodeId of requiredSourceOwnerNodeIds) {
    if (!itemContextIds.has(nodeId)) {
      addMissing("related_item");
    }
  }
  if (missingRelationEvidenceSourceIds.size !== 0) {
    addMissing("relation_evidence");
  }
  for (const relation of relationContexts) {
    const missingEndpoint = [relation.fromNodeId, relation.toNodeId].find(
      (nodeId) => !itemContextIds.has(nodeId),
    );
    if (missingEndpoint != null) {
      addMissing("related_item");
      const endpointState = item.endpointStates.get(missingEndpoint);
      if (endpointState == null) {
        throw new TypeError(`relation endpointのstateがありません。対象: ${missingEndpoint}`);
      }
      if (endpointState !== "missing") {
        addMissing("related_timeline");
      }
    }
    if (
      externalContextNodeIds.has(relation.fromNodeId) ||
      externalContextNodeIds.has(relation.toNodeId)
    ) {
      const externalNodeId = externalContextNodeIds.has(relation.fromNodeId)
        ? relation.fromNodeId
        : relation.toNodeId;
      const externalContext = item.externalItemContexts.find(
        (context) => context.nodeId === externalNodeId,
      );
      if (externalContext?.type !== "external_reference") {
        throw new TypeError(`外部参照contextがありません。対象: ${externalNodeId}`);
      }
      if (externalContext.state === "open") {
        addMissing("related_timeline");
      }
    }
  }
  for (const relation of pendingRelations) {
    const endpointNodeIds = relation.endpointNodeIds;
    const hasMissingEndpoint = endpointNodeIds.some((nodeId) => !itemContextIds.has(nodeId));
    if (hasMissingEndpoint) {
      addMissing("related_item");
      addMissing("relation_evidence");
    }
    const externalNodeId = endpointNodeIds.find((nodeId) => externalContextNodeIds.has(nodeId));
    if (externalNodeId != null) {
      const externalContext = item.externalItemContexts.find(
        (context) => context.nodeId === externalNodeId,
      );
      if (externalContext?.type !== "external_reference") {
        throw new TypeError(`外部参照contextがありません。対象: ${externalNodeId}`);
      }
      if (externalContext.state === "open") {
        addMissing("related_timeline");
      }
    }
  }
  if (missingSeedSourceIds.size !== 0) {
    addMissing("item_timeline");
  }
  const input = {
    cause: {
      causeId: seed.causeId,
      itemNodeId: seed.itemNodeId,
      reasonCode: seed.reasonCode,
      responsible: seed.responsible,
      responsibility: seed.responsibility,
      action: seed.action,
    },
    completeness: completenessForCause(item, pendingRelations, missing),
    items,
    relations: [...relationContexts],
    pendingRelations: [...pendingRelations],
    sources,
    evidenceScopes,
    waitingOptions: [...waitingOptions],
    duplicateOptions: [...duplicateOptions],
  } satisfies PersonalReminderCauseSemanticInput;
  return createPersonalReminderCauseSemanticInput(input);
}

function previousCauseById(
  previous: PreviousPersonalReminderCauses,
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderCause> {
  const causes = new Map<PersonalReminderCauseId, PersonalReminderCause>();
  for (const cause of previous.causes) {
    if (causes.has(cause.causeId)) {
      throw new TypeError(`前回cause IDが重複しています。対象: ${cause.causeId}`);
    }
    causes.set(cause.causeId, cause);
  }
  return causes;
}

function selectedRelationEdges(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): readonly PersonalReminderRuntimeActiveRelation[] {
  const relations = relationsIncidentToScope(indexes, scopeNodeIdsForSeed(indexes, seed));
  return Object.freeze(
    relations
      .filter((relation) => relationAffectsPersonalReminderCause(relation, seed))
      .filter(
        (relation) =>
          endpointStateAllowsRelation(context.graph, relation.fromNodeId) &&
          endpointStateAllowsRelation(context.graph, relation.toNodeId),
      )
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

function selectedPendingRelations(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
): readonly PersonalReminderPendingRelation[] {
  const candidateById = new Map(
    context.graph.candidateRelations.map((candidate) => [candidate.candidateId, candidate]),
  );
  const pending: PersonalReminderPendingRelation[] = [];
  for (const resolution of context.graph.candidateResolutions) {
    if (resolution.status !== "pending") {
      continue;
    }
    const candidate = candidateById.get(resolution.candidateId);
    assertNonNullable(
      candidate,
      `pending relation candidateがありません。対象: ${resolution.candidateId}`,
    );
    if (
      candidateAffectsCause(candidate, seed) &&
      negativeWorkCandidateEndpoints(context, candidate) == null &&
      relationEndpointsAllowPending(context.graph, candidate.endpointNodeIds)
    ) {
      pending.push(pendingRelationContext(candidate, resolution));
    }
  }
  return Object.freeze(
    pending.sort((left, right) => compareStrings(left.candidateId, right.candidateId)),
  );
}

function deterministicAssessment(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  semanticInput: PersonalReminderCauseSemanticInput,
  origin: PersonalReminderRuntimeCurrentSeed["origin"],
): PersonalReminderCauseAssessment | undefined {
  if (
    origin !== "current_draft" ||
    seed.responsibility.authority !== "fixed" ||
    semanticInput.relations.length !== 0 ||
    semanticInput.pendingRelations.length !== 0 ||
    semanticInput.waitingOptions.length !== 0 ||
    semanticInput.duplicateOptions.length !== 0 ||
    semanticInput.completeness.status !== "complete" ||
    item.localDecision.aiAnalysisElementNecessities.status !== "not_required" ||
    item.localDecision.aiAnalysisElementNecessities.waitingOn !== "not_required" ||
    item.localDecision.aiAnalysisElementNecessities.nextAction !== "not_required"
  ) {
    return undefined;
  }
  const sourceIds = seed.evidenceSourceIds.filter((sourceId) =>
    semanticInput.sources.some((source) => source.sourceId === sourceId),
  );
  return {
    verdict: "actionable",
    references: {
      nodeIds: [seed.itemNodeId],
      relationIds: [],
      sourceIds,
      reasonSummary: "決定論的な責務と実行可能性が確認されています",
    },
    confidence: 1,
  };
}

type PersonalReminderAuthorReplyProjection = Readonly<{
  option: PersonalReminderWaitingOption | undefined;
  sources: readonly PersonalReminderRuntimeSource[];
  missing: readonly PersonalReminderMissingInput[];
}>;

function hasNonEmptyDetailConversationSource(
  detail: GitHubItemDetail,
  sourceId: SourceId,
): boolean {
  if (
    detail.comments.some((comment) => comment.sourceId === sourceId && comment.body.length !== 0)
  ) {
    return true;
  }
  if (detail.type !== "pull_request") {
    return false;
  }
  if (detail.reviews.some((review) => review.sourceId === sourceId && review.body.length !== 0)) {
    return true;
  }
  return detail.reviewThreads.some((thread) =>
    thread.comments.some((comment) => comment.sourceId === sourceId && comment.body.length !== 0),
  );
}

function authorReplyWaitingProjection(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  currentSeed: PersonalReminderRuntimeCurrentSeed,
): PersonalReminderAuthorReplyProjection | undefined {
  if (
    currentSeed.origin !== "current_draft" ||
    seed.responsibility.authority !== "fixed" ||
    seed.action.kind !== "revision" ||
    item.item.type !== "pull_request" ||
    item.localDecision.status !== "waiting_for_revision" ||
    (item.localDecision.aiAnalysisElementNecessities.status !== "required" &&
      item.localDecision.aiAnalysisElementNecessities.waitingOn !== "required" &&
      item.localDecision.aiAnalysisElementNecessities.nextAction !== "required")
  ) {
    return undefined;
  }
  const responsibilitySourceIds = new Set(item.localDecision.responsibilityBasis.sourceIds);
  const changesRequested = item.item.events
    .filter(
      (event): event is Extract<NormalizedEvent, { kind: "review" }> =>
        event.kind === "review" &&
        event.state === "changes_requested" &&
        responsibilitySourceIds.has(event.sourceId),
    )
    .sort(compareEventOccurrence);
  const latestChangesRequested = changesRequested.at(-1);
  if (latestChangesRequested == null) {
    return undefined;
  }
  const uncertaintyEvidence = item.localDecision.evidence.filter(
    (evidence) => evidence.supports === "uncertainty",
  );
  const uncertaintySourceIds = new Set(uncertaintyEvidence.map((evidence) => evidence.sourceId));
  const possibleAuthorSpeech = item.item.events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "comment" | "review" }> =>
      (event.kind === "comment" || event.kind === "review") &&
      event.actor.type === "human" &&
      !event.bodyEmpty &&
      event.occurredAt > latestChangesRequested.occurredAt &&
      uncertaintySourceIds.has(latestChangesRequested.sourceId) &&
      uncertaintySourceIds.has(event.sourceId),
  );
  if (possibleAuthorSpeech.length === 0) {
    return undefined;
  }
  const author = item.item.author;
  const authorActor = author.status === "identified" ? author.actor : undefined;
  if (authorActor == null) {
    return Object.freeze({
      option: undefined,
      sources: Object.freeze([]),
      missing: Object.freeze([
        "item_conversation",
      ] satisfies readonly PersonalReminderMissingInput[]),
    });
  }
  if (authorActor.type !== "human") {
    return undefined;
  }
  const authorSpeech = possibleAuthorSpeech.filter(
    (event) => event.actor.type === "human" && event.actor.nodeId === authorActor.nodeId,
  );
  if (authorSpeech.length === 0) {
    return undefined;
  }
  const sourceById = new Map(
    item.sources
      .filter(
        (source) =>
          (source.source.kind === "comment" ||
            source.source.kind === "review" ||
            source.source.kind === "review_comment") &&
          source.source.actorType === "human" &&
          source.source.actorCandidateId?.toLowerCase() === authorActor.login.toLowerCase(),
      )
      .map((source) => [source.source.sourceId, source]),
  );
  const rawAuthorSpeech = authorSpeech.filter(
    (event) =>
      sourceById.has(event.sourceId) &&
      hasNonEmptyDetailConversationSource(item.detail, event.sourceId),
  );
  if (rawAuthorSpeech.length !== authorSpeech.length) {
    return Object.freeze({
      option: undefined,
      sources: Object.freeze([]),
      missing: Object.freeze([
        "item_conversation",
      ] satisfies readonly PersonalReminderMissingInput[]),
    });
  }
  const evidenceSourceIds = createNonEmptySourceIds(
    [latestChangesRequested.sourceId, ...rawAuthorSpeech.map((event) => event.sourceId)],
    `author reply waiting option ${seed.causeId}`,
  );
  const optionSources: PersonalReminderRuntimeSource[] = [];
  for (const sourceId of evidenceSourceIds) {
    const source =
      sourceById.get(sourceId) ?? item.sources.find((value) => value.source.sourceId === sourceId);
    if (source == null) {
      return Object.freeze({
        option: undefined,
        sources: Object.freeze([]),
        missing: Object.freeze([
          "item_conversation",
        ] satisfies readonly PersonalReminderMissingInput[]),
      });
    }
    optionSources.push(source);
  }
  return Object.freeze({
    option: Object.freeze({
      optionId: `${seed.causeId}:waiting:author-reply`,
      itemNodeId: seed.itemNodeId,
      targetScope: { kind: "item" } satisfies PersonalReminderTargetScope,
      action: Object.freeze({ kind: "reply", summary: "PR作者の質問や反論へ回答する" }),
      relationIds: [],
      evidenceSourceIds: [...evidenceSourceIds],
    }),
    sources: Object.freeze(optionSources),
    missing: Object.freeze([]),
  });
}

function waitingOptionsForCause(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  seed: PersonalReminderCauseSeed,
  relationEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  currentSeed: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): PersonalReminderRuntimeOptionProjection {
  const options: PersonalReminderWaitingOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missing = new Set<PersonalReminderMissingInput>();
  const aiDependencyInputsByOptionId = new Map<string, readonly AiAnalysisDependencyInput[]>();
  const connected = connectedSeedRelations(indexes, seed, relationEdges);
  const candidateSeedsByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderRuntimeCurrentSeed
  >([...connected].map(([causeId, value]) => [causeId, value.currentSeed]));
  if (currentSeed.origin === "retained_without_draft") {
    for (const candidate of indexes.currentSeedsByItemNodeId.get(seed.itemNodeId) ?? []) {
      candidateSeedsByCauseId.set(candidate.seed.causeId, candidate);
    }
  }
  const candidateSeeds = [...candidateSeedsByCauseId.values()].sort((left, right) =>
    compareStrings(left.seed.causeId, right.seed.causeId),
  );
  for (const candidate of candidateSeeds) {
    if (candidate.origin !== "current_draft" || candidate.seed.causeId === seed.causeId) {
      continue;
    }
    const matchingRelations = connected.get(candidate.seed.causeId)?.relations ?? [];
    if (candidate.seed.itemNodeId === seed.itemNodeId) {
      if (
        currentSeed.origin !== "retained_without_draft" ||
        candidate.seed.action.kind === seed.action.kind
      ) {
        continue;
      }
    } else if (matchingRelations.length === 0) {
      continue;
    }
    const relationIds = matchingRelations.map((relation) => relation.id);
    const relationSources = relationSourceProjectionForEdges(matchingRelations, globalSourcesById);
    const relationSourceIds = matchingRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    if (relationSources.missingSourceIds.length !== 0) {
      missing.add("relation_evidence");
    }
    const sourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `waiting option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (sourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSources.sources) {
      addRuntimeSource(sources, source);
    }
    const option = Object.freeze({
      optionId: `${seed.causeId}:waiting:${candidate.seed.causeId}`,
      itemNodeId: candidate.seed.itemNodeId,
      targetScope: targetScopeForSeed(candidate.seed),
      action: { kind: candidate.seed.action.kind, summary: candidate.seed.action.summary },
      relationIds,
      evidenceSourceIds: [...sourceIds],
    });
    options.push(option);
    aiDependencyInputsByOptionId.set(
      option.optionId,
      Object.freeze([
        ...personalReminderCauseSeedAiDependencyInputs(candidate),
        ...matchingRelations.map((relation) => currentAiDependencyInput(relation.aiDependency)),
      ]),
    );
  }
  const representedRelationIds = new Set(
    [...connected]
      .filter(([causeId]) => causeId !== seed.causeId)
      .flatMap(([, value]) => value.relations.map((relation) => relation.id)),
  );
  const subjectScope = scopeNodeIdsForSeed(indexes, seed);
  for (const relation of relationEdges) {
    if (representedRelationIds.has(relation.id)) {
      continue;
    }
    let endpoint: GraphNodeId | undefined;
    if (subjectScope.has(relation.fromNodeId)) {
      endpoint = relation.toNodeId;
    } else if (subjectScope.has(relation.toNodeId)) {
      endpoint = relation.fromNodeId;
    }
    if (endpoint == null) {
      continue;
    }
    const endpointItem = contextItemByNodeId(context, endpoint);
    if (endpointItem == null) {
      missing.add("related_item");
      continue;
    }
    const relatedContext = item.relatedContexts.find((value) => value.item.nodeId === endpoint);
    if (relatedContext?.localDecision == null) {
      missing.add("related_timeline");
    }
  }
  const authorReply = authorReplyWaitingProjection(item, seed, currentSeed);
  if (authorReply != null) {
    for (const source of authorReply.sources) {
      addRuntimeSource(sources, source);
    }
    for (const value of authorReply.missing) {
      missing.add(value);
    }
    if (authorReply.option != null) {
      options.push(authorReply.option);
      aiDependencyInputsByOptionId.set(
        authorReply.option.optionId,
        Object.freeze([currentAiDependencyInput(Object.freeze({ status: "not_dependent" }))]),
      );
    }
  }
  return Object.freeze({
    options: Object.freeze(
      options.sort((left, right) => compareStrings(left.optionId, right.optionId)),
    ),
    sources: Object.freeze([...sources.values()]),
    missing: Object.freeze([...missing]),
    aiDependencyInputsByOptionId,
  });
}

function duplicateOptionsForCause(
  context: PersonalReminderRuntimeContext,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  current: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): Readonly<{
  options: readonly PersonalReminderDuplicateOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  aiDependencyInputsByCanonicalCauseId: ReadonlyMap<string, readonly AiAnalysisDependencyInput[]>;
}> {
  const options: PersonalReminderDuplicateOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const aiDependencyInputsByCanonicalCauseId = new Map<
    string,
    readonly AiAnalysisDependencyInput[]
  >();
  const effectiveRelations = relationsIncidentToScope(
    indexes,
    scopeNodeIdsForSeed(indexes, current.seed),
  ).filter(
    (relation) =>
      relation.type !== "related_to" && activeRelationIsEffective(context.graph, relation),
  );
  const connected = connectedSeedRelations(indexes, current.seed, effectiveRelations);
  for (const { currentSeed: candidate, relations: directRelations } of connected.values()) {
    if (!seedCanBeDuplicateCandidate(current, candidate)) {
      continue;
    }
    const relationIds = directRelations.map((relation) => relation.id);
    const canonical =
      current.origin === "retained_without_draft"
        ? candidate
        : duplicateCanonicalSeed(context, current, candidate, directRelations);
    if (canonical.seed.causeId !== candidate.seed.causeId) {
      continue;
    }
    const relationSourceEntries = relationSourceProjectionForEdges(
      directRelations,
      globalSourcesById,
    );
    const relationSourceIds = directRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    const evidenceSourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `duplicate option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (evidenceSourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSourceEntries.sources) {
      addRuntimeSource(sources, source);
    }
    const option = Object.freeze({
      canonicalCauseId: candidate.seed.causeId,
      itemNodeId: candidate.seed.itemNodeId,
      targetScope: targetScopeForSeed(candidate.seed),
      responsible: [...candidate.seed.responsible],
      action: { ...candidate.seed.action },
      relationIds,
      evidenceSourceIds: [...evidenceSourceIds],
    });
    options.push(option);
    if (aiDependencyInputsByCanonicalCauseId.has(option.canonicalCauseId)) {
      throw new TypeError(
        `duplicate optionのcanonical cause IDが重複しています。対象: ${option.canonicalCauseId}`,
      );
    }
    aiDependencyInputsByCanonicalCauseId.set(
      option.canonicalCauseId,
      Object.freeze([
        ...personalReminderCauseSeedAiDependencyInputs(candidate),
        ...directRelations.map((relation) => currentAiDependencyInput(relation.aiDependency)),
      ]),
    );
  }
  return Object.freeze({
    options: Object.freeze(options),
    sources: Object.freeze([...sources.values()]),
    aiDependencyInputsByCanonicalCauseId,
  });
}

function seedCanBeDuplicateCandidate(
  current: PersonalReminderRuntimeCurrentSeed,
  candidate: PersonalReminderRuntimeCurrentSeed,
): boolean {
  return (
    candidate.seed.causeId !== current.seed.causeId &&
    candidate.origin === "current_draft" &&
    candidate.seed.action.kind === current.seed.action.kind &&
    sameResponsibleValues(candidate.seed.responsible, current.seed.responsible)
  );
}

function relationCandidateConnectsScopes(
  candidate: PersonalReminderRuntimeCandidateRelation,
  leftNodeIds: ReadonlySet<GraphNodeId>,
  rightNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
  return (
    (leftNodeIds.has(firstNodeId) && rightNodeIds.has(secondNodeId)) ||
    (leftNodeIds.has(secondNodeId) && rightNodeIds.has(firstNodeId))
  );
}

function pendingRelationCanHideCauseAsDuplicate(
  current: PersonalReminderRuntimeCurrentSeed,
  candidateSeed: PersonalReminderRuntimeCurrentSeed,
  relationCandidate: PersonalReminderRuntimeCandidateRelation,
  indexes: PersonalReminderRuntimePlanningIndexes,
): boolean {
  if (
    !relationCandidateConnectsScopes(
      relationCandidate,
      scopeNodeIdsForSeed(indexes, current.seed),
      scopeNodeIdsForSeed(indexes, candidateSeed.seed),
    )
  ) {
    return false;
  }
  if (current.origin === "retained_without_draft") {
    return true;
  }
  if (compareStrings(candidateSeed.seed.causeId, current.seed.causeId) < 0) {
    return true;
  }
  const currentIsImplementation =
    current.item.item.type === "pull_request" &&
    relationCandidate.ownerNodeId === current.seed.itemNodeId;
  const candidateIsImplementation =
    candidateSeed.item.item.type === "pull_request" &&
    relationCandidate.ownerNodeId === candidateSeed.seed.itemNodeId;
  return candidateIsImplementation && !currentIsImplementation;
}

function pendingResponseMembershipDependencyInputs(
  context: PersonalReminderRuntimeContext,
  current: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): readonly AiAnalysisDependencyInput[] {
  const dependencies: AiAnalysisDependencyInput[] = [];
  for (const resolution of context.graph.candidateResolutions) {
    if (resolution.status !== "pending") {
      continue;
    }
    const candidate = context.graph.candidateRelations.find(
      (value) => value.candidateId === resolution.candidateId,
    );
    assertNonNullable(
      candidate,
      `pending relation candidateがありません。対象: ${resolution.candidateId}`,
    );
    if (
      candidate.authority !== "inferred" ||
      !relationEndpointsAllowPending(context.graph, candidate.endpointNodeIds)
    ) {
      continue;
    }
    const currentScopeNodeIds = scopeNodeIdsForSeed(indexes, current.seed);
    const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
    const duplicateCandidatesByCauseId = new Map<
      PersonalReminderCauseId,
      PersonalReminderRuntimeCurrentSeed
    >();
    if (currentScopeNodeIds.has(firstNodeId)) {
      for (const duplicateCandidate of indexes.currentSeedsByScopeNodeId.get(secondNodeId) ?? []) {
        duplicateCandidatesByCauseId.set(duplicateCandidate.seed.causeId, duplicateCandidate);
      }
    }
    if (currentScopeNodeIds.has(secondNodeId)) {
      for (const duplicateCandidate of indexes.currentSeedsByScopeNodeId.get(firstNodeId) ?? []) {
        duplicateCandidatesByCauseId.set(duplicateCandidate.seed.causeId, duplicateCandidate);
      }
    }
    const matchingDuplicateCandidates = [...duplicateCandidatesByCauseId.values()].filter(
      (duplicateCandidate) =>
        seedCanBeDuplicateCandidate(current, duplicateCandidate) &&
        pendingRelationCanHideCauseAsDuplicate(current, duplicateCandidate, candidate, indexes),
    );
    if (matchingDuplicateCandidates.length === 0) {
      continue;
    }
    if (candidate.aiDependency.status === "not_dependent") {
      throw new TypeError(
        `推定pending relation candidateのAI依存はnot_dependentにできません。対象: ${candidate.candidateId}`,
      );
    }
    dependencies.push(
      Object.freeze({
        origin: "current",
        dependency: candidate.aiDependency,
        relationCandidateAssessment: "missing",
      }),
      ...matchingDuplicateCandidates.flatMap((duplicateCandidate) => [
        seedAiDependencyInput(
          duplicateCandidate.seed.aiDependencies.presence,
          duplicateCandidate.origin,
        ),
        seedAiDependencyInput(
          duplicateCandidate.seed.aiDependencies.responsible,
          duplicateCandidate.origin,
        ),
      ]),
    );
  }
  return Object.freeze(dependencies);
}

function responseMembershipAssessmentRequirement(
  seed: PersonalReminderCauseSeed,
  duplicateOptions: readonly PersonalReminderDuplicateOption[],
): PersonalReminderResponseMembershipAssessmentRequirement {
  if (seed.responsibility.authority === "semantic" || duplicateOptions.length !== 0) {
    return Object.freeze({ status: "required" });
  }
  return Object.freeze({ status: "not_required" });
}

function sameResponsibleValues(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftValues = left
    .map((value) => `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`)
    .sort(compareStrings);
  const rightValues = right
    .map((value) => `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`)
    .sort(compareStrings);
  return leftValues.every((value, index) => value === rightValues[index]);
}

function firstObservationBasis(at: UtcIsoDateTime): PersonalReminderTimeBasis {
  return Object.freeze({ source: "first_observation", at });
}

type PersonalReminderWaitingTarget = Readonly<{
  item: PersonalReminderRuntimeItem;
  actionKind: PersonalReminderActionKind;
  responsible: readonly PersonalReminderResponsible[];
}>;

function waitingTargetForCause(
  item: PersonalReminderRuntimeContextItem,
  waitingFor: Readonly<{ itemNodeId: GraphNodeId; action: string }>,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderWaitingTarget | undefined {
  const seededTargets = currentSeeds.filter(
    (currentSeed) =>
      currentSeed.origin === "current_draft" &&
      currentSeed.seed.itemNodeId === waitingFor.itemNodeId &&
      currentSeed.seed.action.summary === waitingFor.action,
  );
  if (seededTargets.length > 1) {
    return undefined;
  }
  const seededTarget = seededTargets[0];
  if (seededTarget != null) {
    return Object.freeze({
      item: seededTarget.item.item,
      actionKind: seededTarget.seed.action.kind,
      responsible: seededTarget.seed.responsible,
    });
  }
  const related = [
    Object.freeze({ item: item.item, localDecision: item.localDecision }),
    ...item.relatedContexts.map((context) =>
      Object.freeze({
        item: context.item,
        localDecision:
          context.localDecision == null ? undefined : determineLocalDecision(context.localDecision),
      }),
    ),
  ].filter((context) => context.item.nodeId === waitingFor.itemNodeId);
  if (related.length !== 1) {
    return undefined;
  }
  const target = related[0];
  assertNonNullable(target, "待機先itemを取得できませんでした");
  if (target.localDecision?.nextAction !== waitingFor.action) {
    return undefined;
  }
  const actionKind = actionKindForDecision(target.localDecision);
  if (actionKind == null) {
    return undefined;
  }
  const responsible = target.localDecision.waitingOn
    .filter(isPersonalReminderResponsibleWaitingOn)
    .map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  return Object.freeze({ item: target.item, actionKind, responsible });
}

function eventActorMatchesResponsible(
  event: NormalizedEvent,
  responsible: readonly PersonalReminderResponsible[],
): boolean {
  const actor = event.actor;
  if (actor.type !== "human") {
    return false;
  }
  return responsible.some(
    (value) =>
      value.kind === "user" && value.candidateId.toLowerCase() === actor.login.toLowerCase(),
  );
}

function isStructuredWaitingResolutionEvent(
  event: NormalizedEvent,
  target: PersonalReminderWaitingTarget,
): boolean {
  if (!eventActorMatchesResponsible(event, target.responsible)) {
    if (target.actionKind !== "work" && target.actionKind !== "merge") {
      return false;
    }
  }
  switch (target.actionKind) {
    case "review":
      return event.kind === "review" && event.actor.type === "human" && event.state !== "commented";
    case "revision":
      return event.kind === "push";
    case "reply":
      return false;
    case "owner":
      return event.kind === "assignee" && event.action === "added";
    case "work":
      return event.kind === "state" && (event.state === "closed" || event.state === "merged");
    case "merge":
      return event.kind === "state" && event.state === "merged";
    case "assessment":
    case "decision":
      return false;
  }
}

function compareEventOccurrence(left: NormalizedEvent, right: NormalizedEvent): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new TypeError("待機解消イベントの時刻が不正です");
  }
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

function scopedActivityForCause(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
): PersonalReminderRuntimeActivityProjection {
  const responsibleCandidateIds = new Set(
    seed.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
  );
  const activities: PersonalReminderRuntimeActivity[] = [];
  const missing = new Set<PersonalReminderMissingInput>();
  if (seed.responsibility.scope.kind !== "execution_surfaces") {
    activities.push(createActionActivity(item.item, seed.action.kind, responsibleCandidateIds));
  }
  for (const surface of seed.responsibility.scope.kind === "item"
    ? []
    : seed.responsibility.scope.surfaces) {
    const related = item.relatedContexts.find((context) => context.item.nodeId === surface.nodeId);
    if (related == null) {
      missing.add("related_item");
      continue;
    }
    if (related.item.type !== surface.kind) {
      throw new TypeError(`causeのexecution surface種別が一致しません。対象: ${surface.nodeId}`);
    }
    if (related.localDecision == null) {
      missing.add("related_timeline");
    }
    activities.push(createActionActivity(related.item, seed.action.kind, responsibleCandidateIds));
  }
  return Object.freeze({
    activity: Object.freeze({
      relevantProgress: Object.freeze(activities.flatMap((value) => value.relevantProgress)),
      responsibleActivity: Object.freeze(activities.flatMap((value) => value.responsibleActivity)),
      humanReviewActivity: Object.freeze(activities.flatMap((value) => value.humanReviewActivity)),
      actionabilityStartByAction: new Map<
        PersonalReminderActionKind,
        PersonalReminderTimeBasis | undefined
      >(),
    }),
    missing: Object.freeze([...missing]),
  });
}

function actionabilityEventForCause(
  item: PersonalReminderRuntimeContextItem,
  previousCause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderTimeBasis | undefined {
  if (
    previousCause.lastConfirmedActionability.status !== "confirmed" ||
    previousCause.lastConfirmedActionability.verdict !== "waiting"
  ) {
    return undefined;
  }
  const waitingFor = previousCause.lastConfirmedActionability.waitingFor;
  const target = waitingTargetForCause(item, waitingFor, currentSeeds);
  if (target?.item.nodeId !== waitingFor.itemNodeId) {
    return undefined;
  }
  const previousTimestamp = Date.parse(previousObservedAt);
  if (!Number.isFinite(previousTimestamp)) {
    throw new TypeError("前回の観測時刻が不正です");
  }
  const events = target.item.events
    .filter((event) => {
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isFinite(occurredAt)) {
        throw new TypeError(`待機解消イベントの時刻が不正です。対象: ${event.sourceId}`);
      }
      return occurredAt > previousTimestamp;
    })
    .filter((event) => isStructuredWaitingResolutionEvent(event, target))
    .sort(compareEventOccurrence);
  if (target.actionKind === "revision" && target.item.type === "pull_request") {
    const resolved = isPullRequestRevisionResponsibilityResolved({
      pullRequest: target.item,
      previousResponsibilityBasis: {
        sourceIds: createNonEmptySourceIds([target.item.sourceId], "revision待機起点"),
        occurredAt: previousObservedAt,
        precision: "inferred",
      },
    });
    if (!resolved) {
      return undefined;
    }
  }
  const event = events.at(-1);
  return event == null ? undefined : basisFromEvent(event);
}

function activityForCause(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  previousCause: PersonalReminderCause | undefined,
  evaluatedAt: UtcIsoDateTime,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimeActivityProjection {
  const projection = scopedActivityForCause(item, seed);
  const actionabilityStartByAction = new Map(projection.activity.actionabilityStartByAction);
  if (previousCause == null) {
    const actionabilityStart =
      seed.responsibility.authority === "fixed" && seed.obligationSince.source === "event"
        ? seed.obligationSince
        : firstObservationBasis(evaluatedAt);
    actionabilityStartByAction.set(seed.action.kind, actionabilityStart);
  } else if (
    previousCause.lastConfirmedActionability.status === "confirmed" &&
    previousCause.lastConfirmedActionability.verdict === "waiting"
  ) {
    actionabilityStartByAction.set(
      seed.action.kind,
      actionabilityEventForCause(item, previousCause, item.previous.observedAt, currentSeeds) ??
        firstObservationBasis(evaluatedAt),
    );
  } else {
    actionabilityStartByAction.set(
      seed.action.kind,
      previousCause.actionableClock.status === "not_observed"
        ? firstObservationBasis(evaluatedAt)
        : undefined,
    );
  }
  return Object.freeze({
    activity: Object.freeze({
      relevantProgress: projection.activity.relevantProgress,
      responsibleActivity: projection.activity.responsibleActivity,
      humanReviewActivity: projection.activity.humanReviewActivity,
      actionabilityStartByAction,
    }),
    missing: projection.missing,
  });
}

function createGlobalItemContextIndex(
  context: PersonalReminderRuntimeContext,
): ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext> {
  const itemContextsByNodeId = new Map<GraphNodeId, PersonalReminderAiItemContext>();
  const addContext = (itemContext: PersonalReminderAiItemContext): void => {
    const previous = itemContextsByNodeId.get(itemContext.nodeId);
    if (
      previous != null &&
      serializeCanonicalJson(previous) !== serializeCanonicalJson(itemContext)
    ) {
      if (previous.type === "external_reference" && itemContext.type !== "external_reference") {
        itemContextsByNodeId.set(itemContext.nodeId, itemContext);
        return;
      }
      if (previous.type !== "external_reference" && itemContext.type === "external_reference") {
        return;
      }
      throw new TypeError(`同じitem node IDに異なるcontextがあります。対象: ${itemContext.nodeId}`);
    }
    itemContextsByNodeId.set(itemContext.nodeId, itemContext);
  };
  for (const item of context.items) {
    addContext(item.itemContext);
    for (const related of item.relatedItemContexts) {
      addContext(related);
    }
    for (const external of item.externalItemContexts) {
      addContext(external);
    }
  }
  return itemContextsByNodeId;
}

function createCauseSourceEvidence(
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  semanticInput: PersonalReminderCauseSemanticInput,
  snapshotEvidenceSourceIds: ReadonlySet<SourceId>,
  seed: PersonalReminderCauseSeed,
): readonly Evidence[] {
  const evidenceByIdentity = new Map<string, Evidence>();
  const existingSourceIds = new Set<SourceId>([...snapshotEvidenceSourceIds]);
  for (const evidence of item.seedEvidence) {
    evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    existingSourceIds.add(evidence.sourceId);
  }
  const semanticSourceIds = new Set(semanticInput.sources.map((source) => source.sourceId));
  for (const sourceId of [...new Set(seed.evidenceSourceIds)].sort(compareStrings)) {
    if (existingSourceIds.has(sourceId)) {
      continue;
    }
    if (!globalSourcesById.has(sourceId) && !semanticSourceIds.has(sourceId)) {
      throw new TypeError(
        `個人催促causeのsource evidenceに必要なruntime sourceがありません。item: ${item.item.nodeId} cause: ${seed.causeId} source: ${sourceId}`,
      );
    }
    const evidence: Evidence = Object.freeze({
      sourceId,
      supports: "waiting_on",
      summary: `担当する対応: ${seed.action.summary}`,
    });
    evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    existingSourceIds.add(sourceId);
  }
  return Object.freeze(
    [...evidenceByIdentity.values()].sort((left, right) =>
      compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
    ),
  );
}

/** fresh itemのcause候補をgraphと前回causeへreconcileする。 */
export function planPersonalReminderCauses(
  context: PersonalReminderRuntimeContext,
): PersonalReminderCauseRuntimePlan {
  const entries: PersonalReminderCauseRuntimePlanEntry[] = [];
  const preservedCauses: PersonalReminderCause[] = [];
  const preservedEvidenceByNodeId = new Map<GitHubNodeId, readonly Evidence[]>();
  const continuityConflicts: PersonalReminderCauseContinuityConflict[] = [];
  const endedCauseIds = new Set<PersonalReminderCauseId>();
  const pendingCauseIds = new Set<PersonalReminderCauseId>();
  const unrecordedDependencyNodeIds = new Set<GitHubNodeId>();
  const causeSetAiDependencyInputsByNodeId = new Map<GitHubNodeId, AiAnalysisDependencyInput[]>();
  const causeSetSubjectChangeInputsByNodeId = new Map<
    GitHubNodeId,
    PersonalReminderRuntimeCauseSetSubjectChangeInput
  >();
  const reconciledItems: PersonalReminderRuntimeReconciledItem[] = [];
  const globalSourcesById = new Map<SourceId, PersonalReminderRuntimeSource>();
  const globalItemContextsByNodeId = createGlobalItemContextIndex(context);
  for (const item of context.items) {
    for (const source of item.sources) {
      addRuntimeSource(globalSourcesById, source);
    }
  }
  const globalCausalSourcesByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeSource[]>();
  for (const source of globalSourcesById.values()) {
    if (!source.causalPush) {
      continue;
    }
    const sources = globalCausalSourcesByNodeId.get(source.source.itemNodeId);
    if (sources == null) {
      globalCausalSourcesByNodeId.set(source.source.itemNodeId, [source]);
    } else {
      sources.push(source);
    }
  }
  const globalSources = globalSourcesById;
  for (const item of context.items) {
    const previous = item.previous;
    if (item.stale) {
      for (const cause of previous.causes) {
        preservedCauses.push(cause);
      }
      const evidence = context.state.previousEvidenceByNodeId.get(item.item.nodeId);
      if (evidence != null) {
        preservedEvidenceByNodeId.set(item.item.nodeId, evidence);
      }
      continue;
    }
    const localDrafts: PersonalReminderCauseDraft[] = [];
    for (const responsibility of item.responsibilities) {
      const draft = createPersonalReminderCauseDraft(
        item.item,
        item.localDecision,
        responsibility,
        item.aiAnalysisApplications,
      );
      if ("status" in draft) {
        continue;
      }
      localDrafts.push(draft);
    }
    const graphDraftProjection = graphDerivedDrafts(context, item, localDrafts);
    const negativeCandidateDependencies = negativeCandidateDependenciesForIssue(
      context,
      item,
      localDrafts,
      graphDraftProjection.drafts,
    );
    const drafts = [...localDrafts, ...graphDraftProjection.drafts];
    const structuralEnded = determineStructurallyEndedPersonalReminderCauses({
      item: item.item,
      previous,
      currentDrafts: drafts,
      currentDecisionStatus: item.localDecision.status,
      complete: item.completeness.status === "complete",
      currentReviewRequestTargets: item.currentReviewRequestTargets,
      executionSurfaceStates: item.executionSurfaceStates,
    });
    const sourceOccurredAtById = new Map(item.sourceOccurredAtById);
    const reconciliation = reconcilePersonalReminderCauseSeeds({
      item: item.item,
      drafts,
      previous,
      currentObservedAt: context.evaluatedAt,
      sourceOccurredAtById,
      confirmedEndedCauseIds: new Set(structuralEnded),
    });
    if (reconciliation.status === "continuity_conflict") {
      for (const cause of previous.causes) {
        preservedCauses.push(cause);
      }
      const evidence = context.state.previousEvidenceByNodeId.get(item.item.nodeId);
      if (evidence != null) {
        preservedEvidenceByNodeId.set(item.item.nodeId, evidence);
      }
      continuityConflicts.push(
        Object.freeze({
          itemNodeId: reconciliation.itemNodeId,
          previousCauseIds: reconciliation.previousCauseIds,
        }),
      );
      continue;
    }
    const previousById = previousCauseById(previous);
    const causeSetDependencies = negativeCandidateDependencies.flatMap(
      (candidate) => candidate.inputs,
    );
    const presenceInputs: AiAnalysisDependencyInput[] = [];
    const negativeCandidateSubjects = negativeCandidateDependencies.map((candidate) =>
      Object.freeze({
        subject: candidate.subject,
        dependency: combineReconciledAiAnalysisDependencies(
          candidate.inputs,
          context.aiDependencyContext,
        ),
      }),
    );
    const negativeCandidateSubjectCount = negativeCandidateSubjects.filter(
      (candidate) => candidate.dependency.status !== "not_dependent",
    ).length;
    const addableSubjects = negativeCandidateSubjects
      .filter((candidate) => aiAnalysisDependencyIsUnverified(candidate.dependency))
      .map((candidate) => candidate.subject);
    const removableSubjects: PersonalReminderSubject[] = [];
    let subjectChangesUnbounded = false;
    for (const seed of reconciliation.seeds) {
      const previousCause = previousById.get(seed.causeId);
      let presenceInput: AiAnalysisDependencyInput;
      if (reconciliation.retainedWithoutDraftCauseIds.includes(seed.causeId)) {
        assertNonNullable(previousCause, `保持した前回causeがありません。対象: ${seed.causeId}`);
        presenceInput = retainedAiDependencyInput(previousCause.aiDependencies.presence);
      } else {
        presenceInput = currentAiDependencyInput(seed.aiDependencies.presence);
      }
      causeSetDependencies.push(presenceInput);
      presenceInputs.push(presenceInput);
      const presenceDependency = combineReconciledAiAnalysisDependencies(
        [presenceInput],
        context.aiDependencyContext,
      );
      if (!aiAnalysisDependencyIsUnverified(presenceDependency)) {
        continue;
      }
      for (const responsible of seed.responsible) {
        if (responsible.kind === "role") {
          continue;
        }
        removableSubjects.push(
          Object.freeze({
            kind: responsible.kind,
            candidateId: responsible.candidateId,
          }),
        );
      }
    }
    if (reconciliation.seeds.length === 0) {
      const fallbackPresenceDependency = personalReminderCauseAiDependenciesForDecision(
        item.item.nodeId,
        item.localDecision,
        item.aiAnalysisApplications,
      ).presence;
      const fallbackPresenceInput = currentAiDependencyInput(fallbackPresenceDependency);
      causeSetDependencies.push(fallbackPresenceInput);
      presenceInputs.push(fallbackPresenceInput);
      if (aiAnalysisDependencyIsUnverified(fallbackPresenceDependency)) {
        subjectChangesUnbounded = true;
      }
    }
    causeSetAiDependencyInputsByNodeId.set(item.item.nodeId, causeSetDependencies);
    causeSetSubjectChangeInputsByNodeId.set(
      item.item.nodeId,
      Object.freeze({
        addableSubjects: Object.freeze(addableSubjects),
        removableSubjects: Object.freeze(removableSubjects),
        presenceInputs: Object.freeze(presenceInputs),
        negativeCandidateSubjectCount,
        unbounded: subjectChangesUnbounded,
      }),
    );
    for (const causeId of reconciliation.endedCauseIds) {
      endedCauseIds.add(causeId);
    }
    reconciledItems.push(
      Object.freeze({
        item,
        previousById,
        reconciliation,
      }),
    );
  }

  const currentSeeds = reconciledItems.flatMap((value) =>
    value.reconciliation.seeds.map((seed) =>
      Object.freeze({
        seed,
        item: value.item,
        origin: value.reconciliation.retainedWithoutDraftCauseIds.includes(seed.causeId)
          ? "retained_without_draft"
          : "current_draft",
        previousCause: value.previousById.get(seed.causeId),
      }),
    ),
  );
  currentSeeds.sort((left, right) => compareStrings(left.seed.causeId, right.seed.causeId));
  const planningIndexes = createPersonalReminderPlanningIndexes(context, currentSeeds);

  for (const reconciled of reconciledItems) {
    const item = reconciled.item;
    for (const seed of reconciled.reconciliation.seeds) {
      const currentSeed = planningIndexes.currentSeedByCauseId.get(seed.causeId);
      assertNonNullable(currentSeed, `current seedがありません。対象: ${seed.causeId}`);
      const relationEdges = selectedRelationEdges(context, seed, planningIndexes);
      const pendingRelations = selectedPendingRelations(context, seed);
      const waitingProjection = waitingOptionsForCause(
        context,
        item,
        globalSourcesById,
        seed,
        relationEdges,
        currentSeed,
        planningIndexes,
      );
      const duplicateProjection = duplicateOptionsForCause(
        context,
        globalSourcesById,
        currentSeed,
        planningIndexes,
      );
      const duplicateRelationIds = new Set(
        duplicateProjection.options.flatMap((option) => option.relationIds),
      );
      const duplicateRelationEdges = context.graph.activeRelations.filter(
        (relation) =>
          duplicateRelationIds.has(relation.id) &&
          activeRelationIsEffective(context.graph, relation),
      );
      const relationEdgesForInput = [
        ...new Map(
          [...relationEdges, ...duplicateRelationEdges].map((relation) => [relation.id, relation]),
        ).values(),
      ].sort((left, right) => compareStrings(left.id, right.id));
      const relations = relationEdgesForInput.map(relationContextFromEdge);
      const relationSources = relationSourceProjectionForEdges(
        relationEdgesForInput,
        globalSourcesById,
      );
      const optionSources = [...waitingProjection.sources, ...duplicateProjection.sources];
      const relationDependencies = relationEdgesForInput.map((relation) =>
        currentAiDependencyInput(relation.aiDependency),
      );
      const pendingRelationDependencies = pendingRelations.flatMap((relation) => {
        const candidate = context.graph.candidateRelations.find(
          (value) => value.candidateId === relation.candidateId,
        );
        assertNonNullable(
          candidate,
          `pending relation candidateがありません。対象: ${relation.candidateId}`,
        );
        return [currentAiDependencyInput(candidate.aiDependency)];
      });
      const waitingOptionDependencies = waitingProjection.options.flatMap((option) => {
        const dependency = waitingProjection.aiDependencyInputsByOptionId.get(option.optionId);
        assertNonNullable(
          dependency,
          `waiting optionのAI依存がありません。対象: ${option.optionId}`,
        );
        return dependency;
      });
      const duplicateOptionDependencies = duplicateProjection.options.flatMap((option) => {
        const dependency = duplicateProjection.aiDependencyInputsByCanonicalCauseId.get(
          option.canonicalCauseId,
        );
        assertNonNullable(
          dependency,
          `duplicate optionのAI依存がありません。対象: ${option.canonicalCauseId}`,
        );
        return dependency;
      });
      const pendingMembershipInputs = pendingResponseMembershipDependencyInputs(
        context,
        currentSeed,
        planningIndexes,
      );
      const semanticDependencies = [
        ...relationDependencies,
        ...pendingRelationDependencies,
        ...waitingOptionDependencies,
        ...duplicateOptionDependencies,
      ];
      const membershipAssessmentRequirement = responseMembershipAssessmentRequirement(
        seed,
        duplicateProjection.options,
      );
      const responseMembershipAiDependency = combineReconciledAiAnalysisDependencies(
        [
          currentSeed.origin === "retained_without_draft"
            ? retainedAiDependencyInput(seed.aiDependencies.responseMembership)
            : currentAiDependencyInput(Object.freeze({ status: "not_dependent" })),
          ...(membershipAssessmentRequirement.status === "required"
            ? [
                seedAiDependencyInput(seed.aiDependencies.action, currentSeed.origin),
                seedAiDependencyInput(seed.aiDependencies.evidence, currentSeed.origin),
              ]
            : []),
          ...duplicateOptionDependencies,
          ...pendingMembershipInputs,
        ],
        context.aiDependencyContext,
      );
      const seedWithResponseMembershipDependency = personalReminderCauseSeedSchema.parse({
        ...seed,
        aiDependencies: {
          ...seed.aiDependencies,
          responseMembership: responseMembershipAiDependency,
        },
      });
      const currentInputAiDependency = combineReconciledAiAnalysisDependencies(
        [...personalReminderCauseSeedAiDependencyInputs(currentSeed), ...semanticDependencies],
        context.aiDependencyContext,
      );
      if (
        [
          ...Object.values(seed.aiDependencies),
          responseMembershipAiDependency,
          currentInputAiDependency,
        ].some(
          (dependency) =>
            dependency.status === "unknown" && dependency.reasons.includes("not_recorded"),
        )
      ) {
        unrecordedDependencyNodeIds.add(seed.itemNodeId);
      }
      const targetScopeNodeIds = new Set<GraphNodeId>();
      for (const option of [...waitingProjection.options, ...duplicateProjection.options]) {
        for (const nodeId of optionTargetScopeNodeIds(option)) {
          targetScopeNodeIds.add(nodeId);
        }
      }
      const additionalItemContexts = [...targetScopeNodeIds].sort(compareStrings).map((nodeId) => {
        const itemContext = globalItemContextsByNodeId.get(nodeId);
        assertNonNullable(itemContext, `target scopeのitem contextがありません。対象: ${nodeId}`);
        return itemContext;
      });
      const activityProjection = activityForCause(
        item,
        seed,
        currentSeed.previousCause,
        context.evaluatedAt,
        currentSeeds,
      );
      const relationMissing: readonly PersonalReminderMissingInput[] =
        relationSources.missingSourceIds.length === 0 ? [] : ["relation_evidence"];
      const additionalMissing: PersonalReminderMissingInput[] = [
        ...waitingProjection.missing,
        ...activityProjection.missing,
        ...relationMissing,
      ];
      const semanticInput = createCauseSemanticInput(
        item,
        globalSources,
        globalCausalSourcesByNodeId,
        globalItemContextsByNodeId,
        seed,
        relations,
        pendingRelations,
        waitingProjection.options,
        duplicateProjection.options,
        relationSources.sources,
        optionSources,
        additionalItemContexts,
        additionalMissing,
      );
      const sourceEvidence = createCauseSourceEvidence(
        item,
        globalSourcesById,
        semanticInput,
        context.snapshotEvidenceSourceIds,
        seed,
      );
      if (pendingRelations.length !== 0) {
        pendingCauseIds.add(seed.causeId);
      }
      entries.push(
        Object.freeze({
          seed: seedWithResponseMembershipDependency,
          responseMembershipAssessmentRequirement: membershipAssessmentRequirement,
          semanticInput,
          deterministicAssessment: deterministicAssessment(
            item,
            seed,
            semanticInput,
            currentSeed.origin,
          ),
          previousCause: currentSeed.previousCause,
          sourceEvidence,
          activity: activityProjection.activity,
          repositoryFullName: item.repositoryFullName,
          currentLabels: item.currentLabels,
          currentInputAiDependency,
        }),
      );
    }
  }
  const causeSetAiDependencyByNodeId = new Map<GitHubNodeId, AiAnalysisDependency>();
  const causeSetSubjectChangesByNodeId = new Map<
    GitHubNodeId,
    PersonalReminderCauseSetSubjectChanges
  >();
  for (const [nodeId, dependencies] of causeSetAiDependencyInputsByNodeId) {
    const subjectChangeInput = causeSetSubjectChangeInputsByNodeId.get(nodeId);
    assertNonNullable(
      subjectChangeInput,
      `個人催促cause集合の主体変化入力がありません。対象: ${nodeId}`,
    );
    const dependency = combineCauseSetAiDependency(
      dependencies,
      subjectChangeInput.presenceInputs,
      context.aiDependencyContext,
    );
    if (dependency.status === "unknown" && dependency.reasons.includes("not_recorded")) {
      unrecordedDependencyNodeIds.add(nodeId);
    }
    causeSetAiDependencyByNodeId.set(nodeId, dependency);
    causeSetSubjectChangesByNodeId.set(
      nodeId,
      createCauseSetSubjectChanges(dependency, subjectChangeInput, context.aiDependencyContext),
    );
  }
  return Object.freeze({
    entries: Object.freeze(
      entries.sort((left, right) => compareStrings(left.seed.causeId, right.seed.causeId)),
    ),
    preservedCauses: Object.freeze(preservedCauses),
    preservedEvidenceByNodeId,
    continuityConflicts: Object.freeze(
      continuityConflicts.sort((left, right) => compareStrings(left.itemNodeId, right.itemNodeId)),
    ),
    endedCauseIds: Object.freeze([...endedCauseIds].sort(compareStrings)),
    pendingCauseIds: Object.freeze([...pendingCauseIds].sort(compareStrings)),
    unrecordedDependencyNodeIds,
    causeSetAiDependencyByNodeId,
    causeSetSubjectChangesByNodeId,
  });
}

function currentAssessmentFromCause(
  cause: PersonalReminderCause | undefined,
  fingerprint: string,
): CurrentPersonalReminderAssessment {
  if (
    cause?.currentInput.fingerprint !== fingerprint ||
    cause.currentInput.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION
  ) {
    return Object.freeze({ status: "not_available" });
  }
  return currentPersonalReminderAssessment(cause);
}

function originFromGeneration(
  generation: NonNullable<
    Extract<PersonalReminderAiCauseRunOutcome, { status: "accepted" }>["generation"]
  >,
  causeId: PersonalReminderCauseId,
): Readonly<{
  origin: Readonly<{
    kind: "ai";
    cacheEntryId: PersonalReminderAiCacheKey;
    metadata: typeof generation.metadata;
  }>;
  latestAttempt: Readonly<{
    status: "completed";
    inputFingerprint: typeof generation.metadata.inputFingerprint;
    completedAt: UtcIsoDateTime;
    origin: Readonly<{
      kind: "ai";
      cacheEntryId: PersonalReminderAiCacheKey;
      metadata: typeof generation.metadata;
    }>;
  }>;
}> {
  if (generation.metadata.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION) {
    throw new TypeError(`個人催促AI generationのrules versionが不一致です。対象: ${causeId}`);
  }
  const cacheKey = createPersonalReminderAiCacheKey({
    causeId,
    revision: PERSONAL_REMINDER_AI_REVISION,
    rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
    model: generation.metadata.model,
    reasoningEffort: generation.metadata.reasoningEffort,
    backendVersion: generation.metadata.backendVersion,
    schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
    inputFingerprint: generation.metadata.inputFingerprint,
    executionFingerprint: generation.metadata.executionFingerprint,
  });
  const origin = Object.freeze({
    kind: "ai" as const,
    cacheEntryId: cacheKey,
    metadata: generation.metadata,
  });
  return Object.freeze({
    origin,
    latestAttempt: Object.freeze({
      status: "completed" as const,
      inputFingerprint: generation.metadata.inputFingerprint,
      completedAt: generation.metadata.generatedAt,
      origin,
    }),
  });
}

function latestAttemptForOutcome(
  outcome: PersonalReminderAiCauseRunOutcome | undefined,
  fingerprint: string,
  attemptedAt: UtcIsoDateTime,
): PersonalReminderCause["latestAttempt"] | undefined {
  if (outcome?.status === "failed") {
    return Object.freeze({
      status: "failed",
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      failedAt: attemptedAt,
      reason: outcome.reason,
    });
  }
  if (outcome?.status === "deferred") {
    return Object.freeze({
      status: "deferred",
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      deferredAt: attemptedAt,
      reason: outcome.reason,
    });
  }
  return undefined;
}

function unavailableAdoptedAssessment(): PersonalReminderCause["adoptedAssessment"] {
  return Object.freeze({ status: "not_available" });
}

function notEvaluatedAttempt(): PersonalReminderCause["latestAttempt"] {
  return Object.freeze({ status: "not_evaluated" });
}

function assessmentForEntry(
  entry: PersonalReminderCauseRuntimePlanEntry,
  outcome: PersonalReminderAiCauseRunOutcome | undefined,
  fingerprint: string,
  attemptedAt: UtcIsoDateTime,
): Readonly<{
  assessment: CurrentPersonalReminderAssessment;
  adoptedAssessment: PersonalReminderCause["adoptedAssessment"];
  latestAttempt: PersonalReminderCause["latestAttempt"];
}> {
  const deterministic = entry.deterministicAssessment;
  if (deterministic != null) {
    const origin = Object.freeze({
      kind: "deterministic" as const,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
    });
    const adoptedAssessment = Object.freeze({
      status: "available" as const,
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      result: deterministic,
      origin,
    });
    return Object.freeze({
      assessment: Object.freeze({ status: "available", result: deterministic }),
      adoptedAssessment,
      latestAttempt:
        latestAttemptForOutcome(outcome, fingerprint, attemptedAt) ??
        Object.freeze({
          status: "completed" as const,
          inputFingerprint: fingerprint,
          completedAt: attemptedAt,
          origin,
        }),
    });
  }
  if (outcome?.status === "accepted") {
    const generated = originFromGeneration(outcome.generation, entry.seed.causeId);
    const adoptedAssessment = Object.freeze({
      status: "available" as const,
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      result: outcome.generation.result,
      origin: generated.origin,
    });
    return Object.freeze({
      assessment: Object.freeze({ status: "available", result: outcome.generation.result }),
      adoptedAssessment,
      latestAttempt: generated.latestAttempt,
    });
  }
  const previousAssessment = currentAssessmentFromCause(entry.previousCause, fingerprint);
  const latestAttempt = latestAttemptForOutcome(outcome, fingerprint, attemptedAt);
  const adoptedAssessment =
    entry.previousCause?.adoptedAssessment ?? unavailableAdoptedAssessment();
  if (latestAttempt != null) {
    return Object.freeze({
      assessment: previousAssessment,
      adoptedAssessment,
      latestAttempt,
    });
  }
  if (entry.previousCause != null) {
    return Object.freeze({
      assessment: previousAssessment,
      adoptedAssessment,
      latestAttempt: entry.previousCause.latestAttempt,
    });
  }
  return Object.freeze({
    assessment: Object.freeze({ status: "not_available" }),
    adoptedAssessment,
    latestAttempt: notEvaluatedAttempt(),
  });
}

function createCauseEvidence(
  entry: PersonalReminderCauseRuntimePlanEntry,
  assessment: CurrentPersonalReminderAssessment,
): readonly Evidence[] {
  const evidenceByIdentity = new Map<string, Evidence>();
  for (const evidence of entry.sourceEvidence) {
    evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
  }
  if (assessment.status === "available") {
    for (const sourceId of assessment.result.references.sourceIds) {
      if (!entry.semanticInput.sources.some((source) => source.sourceId === sourceId)) {
        throw new TypeError(`assessmentがallowlist外sourceを参照しています。対象: ${sourceId}`);
      }
      const evidence: Evidence = Object.freeze({
        sourceId,
        supports: "notification",
        summary: assessment.result.references.reasonSummary,
      });
      evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    }
  }
  return Object.freeze(
    [...evidenceByIdentity.values()].sort((left, right) =>
      compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
    ),
  );
}

function evidenceIdentity(evidence: Evidence): string {
  return JSON.stringify([evidence.sourceId, evidence.supports, evidence.summary]);
}

function previousClock(
  cause: PersonalReminderCause | undefined,
): PreviousPersonalReminderClockState {
  if (cause == null) {
    return Object.freeze({ availability: "not_available" });
  }
  return Object.freeze({ availability: "available", value: cause.actionableClock });
}

/** causeの評価結果を時計、staleness、snapshot evidenceへ適用する。 */
export function applyPersonalReminderCauseOutcomes(
  input: Readonly<{
    plan: PersonalReminderCauseRuntimePlan;
    outcomes: PersonalReminderAiRunResult | undefined;
    evaluatedAt: UtcIsoDateTime;
    minimumAiConfidence: number;
    thresholdsHours: SeverityThresholds;
    resolveLabelEffects: LabelEffectsResolver;
  }>,
): PersonalReminderAnalysisApplication {
  const causesByNodeId = new Map<GitHubNodeId, readonly PersonalReminderCause[]>();
  const evidenceByNodeId = new Map<GitHubNodeId, readonly Evidence[]>();
  const stalenessByCauseId = new Map<PersonalReminderCauseId, PersonalReminderStaleness>();
  for (const cause of input.plan.preservedCauses) {
    const causes = [...(causesByNodeId.get(cause.itemNodeId) ?? [])];
    causes.push(cause);
    causesByNodeId.set(cause.itemNodeId, causes);
  }
  for (const [nodeId, evidence] of input.plan.preservedEvidenceByNodeId) {
    evidenceByNodeId.set(nodeId, evidence);
  }
  for (const entry of input.plan.entries) {
    const fingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
    const outcome = input.outcomes?.outcomesByCauseId.get(entry.seed.causeId);
    const evaluation = assessmentForEntry(entry, outcome, fingerprint, input.evaluatedAt);
    const clock = updatePersonalReminderActionableClock({
      cause: personalReminderCauseSeedSchema.parse({
        ...entry.seed,
        lastConfirmedActionability: entry.seed.lastConfirmedActionability,
      }),
      assessment: evaluation.assessment,
      previous: previousClock(entry.previousCause),
      actionabilityStart: entry.activity.actionabilityStartByAction.get(entry.seed.action.kind),
      relevantProgress: entry.activity.relevantProgress,
      responsibleActivity: entry.activity.responsibleActivity,
      humanReviewActivity: entry.activity.humanReviewActivity,
      currentObservedAt: input.evaluatedAt,
    });
    const lastConfirmedActionability = updatePersonalReminderLastConfirmedActionability(
      evaluation.assessment,
      entry.seed.lastConfirmedActionability,
    );
    const cause = personalReminderCauseSchema.parse({
      ...entry.seed,
      responseMembershipAssessmentRequirement: entry.responseMembershipAssessmentRequirement,
      lastConfirmedActionability,
      currentInput: {
        fingerprint,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
        completeness: entry.semanticInput.completeness,
        aiDependency: entry.currentInputAiDependency,
      },
      latestAttempt: evaluation.latestAttempt,
      adoptedAssessment: evaluation.adoptedAssessment,
      actionableClock: clock,
    });
    const causes = [...(causesByNodeId.get(cause.itemNodeId) ?? [])];
    causes.push(cause);
    causesByNodeId.set(cause.itemNodeId, causes);
    const evidence = createCauseEvidence(entry, evaluation.assessment);
    const existingEvidence = evidenceByNodeId.get(cause.itemNodeId) ?? [];
    const evidenceByIdentity = new Map(
      existingEvidence.map((value) => [evidenceIdentity(value), value]),
    );
    for (const value of evidence) {
      evidenceByIdentity.set(evidenceIdentity(value), value);
    }
    evidenceByNodeId.set(cause.itemNodeId, Object.freeze([...evidenceByIdentity.values()]));
    stalenessByCauseId.set(
      cause.causeId,
      calculatePersonalReminderStaleness({
        cause,
        evaluatedAt: input.evaluatedAt,
        minimumAiConfidence: input.minimumAiConfidence,
        repositoryFullName: entry.repositoryFullName,
        currentLabels: entry.currentLabels,
        resolveLabelEffects: input.resolveLabelEffects,
        thresholdsHours: input.thresholdsHours,
      }),
    );
  }
  for (const [nodeId, causes] of causesByNodeId) {
    const sortedCauses = [...causes].sort((left, right) =>
      compareStrings(left.causeId, right.causeId),
    );
    causesByNodeId.set(nodeId, Object.freeze(sortedCauses));
  }
  for (const [nodeId, evidence] of evidenceByNodeId) {
    evidenceByNodeId.set(
      nodeId,
      Object.freeze(
        [...evidence].sort((left, right) =>
          compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
        ),
      ),
    );
  }
  return Object.freeze({
    causesByNodeId,
    evidenceByNodeId,
    stalenessByCauseId,
  });
}

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
  type PersonalReminderWaitingOption,
} from "../codex/personal-reminder-input.js";
import {
  type PersonalReminderAiCauseRunOutcome,
  type PersonalReminderAiRunResult,
} from "../codex/personal-reminder-runner.js";
import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  personalReminderCauseSeedSchema,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderActionKind,
  type PersonalReminderCause,
  type PersonalReminderCauseAssessment,
  type PersonalReminderCauseId,
  type PersonalReminderCauseSeed,
  type PersonalReminderExecutionSurface,
  type PersonalReminderInputCompleteness,
  type PersonalReminderMissingInput,
  type PersonalReminderResponsibility,
  type PersonalReminderResponsible,
  type PersonalReminderTimeBasis,
} from "../domain/personal-reminder-causes.js";
import {
  createPersonalReminderCauseDraft,
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
import {
  type Evidence,
  type GitHubNodeId,
  type GraphNodeId,
  type NormalizedEvent,
  type UtcIsoDateTime,
} from "../domain/types.js";
import { type GitHubDetailActor, type GitHubItemDetail } from "../github/item-detail-types.js";
import {
  type PendingRelationCandidateResolution,
  type ReconciledGraphEdge,
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
  evidenceSourceIds: readonly [SourceId, ...SourceId[]];
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
  reconciliation: ReturnType<typeof reconcilePersonalReminderCauseSeeds>;
}>;

type PersonalReminderRuntimeCurrentSeed = Readonly<{
  seed: PersonalReminderCauseSeed;
  item: PersonalReminderRuntimeContextItem;
  origin: "current_draft" | "retained_without_draft";
  previousCause: PersonalReminderCause | undefined;
}>;

type PersonalReminderRuntimeOptionProjection = Readonly<{
  options: readonly PersonalReminderWaitingOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  missing: readonly PersonalReminderMissingInput[];
}>;

type PersonalReminderRuntimeActivityProjection = Readonly<{
  activity: PersonalReminderRuntimeActivity;
  missing: readonly PersonalReminderMissingInput[];
}>;

/** cause seedと意味入力を時計適用へ渡す計画要素。 */
export type PersonalReminderCauseRuntimePlanEntry = Readonly<{
  seed: PersonalReminderCauseSeed;
  semanticInput: PersonalReminderCauseSemanticInput;
  deterministicAssessment: PersonalReminderCauseAssessment | undefined;
  previousCause: PersonalReminderCause | undefined;
  sourceEvidence: readonly Evidence[];
  activity: PersonalReminderRuntimeActivity;
  repositoryFullName: string;
  currentLabels: readonly string[];
}>;

/** cause runtimeのreconcile結果とAI入力計画。 */
export type PersonalReminderCauseRuntimePlan = Readonly<{
  entries: readonly PersonalReminderCauseRuntimePlanEntry[];
  preservedCauses: readonly PersonalReminderCause[];
  preservedEvidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  endedCauseIds: readonly PersonalReminderCauseId[];
  pendingCauseIds: readonly PersonalReminderCauseId[];
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
      evidence: Object.freeze([
        ...new Map(
          [...previous.evidence, ...source.evidence].map((value) => [value.sourceId, value]),
        ).values(),
      ]),
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
  if (
    actionKind === "revision" &&
    detail.headCommit.pushedAt.status === "available" &&
    causalSourceIds.has(detail.headCommit.sourceId) &&
    !sources.has(detail.headCommit.sourceId)
  ) {
    const occurredAt = detail.headCommit.pushedAt.value;
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        detail.headCommit.sourceId,
        "commit_added",
        "system",
        undefined,
        occurredAt,
        "GitHub head commit",
        true,
      ),
    );
    sourceOccurredAtById.set(detail.headCommit.sourceId, occurredAt);
  }
  if (detail.mergeState.checks.status !== "configured") {
    return;
  }
  for (const check of detail.mergeState.checks.contexts) {
    let checkProjection: Readonly<{
      occurredAt: UtcIsoDateTime;
      summary: string;
    }>;
    if (check.type === "check_run") {
      if (check.status !== "completed") {
        continue;
      }
      checkProjection = Object.freeze({
        occurredAt: check.completedAt,
        summary: `GitHub check_run ${check.name} ${check.conclusion}`,
      });
    } else {
      if (check.state === "pending" || check.state === "expected") {
        continue;
      }
      checkProjection = Object.freeze({
        occurredAt: check.createdAt,
        summary: `GitHub commit_status ${check.context} ${check.state}`,
      });
    }
    if (sources.has(check.sourceId)) {
      continue;
    }
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        check.sourceId,
        check.type,
        "system",
        undefined,
        checkProjection.occurredAt,
        checkProjection.summary,
        false,
      ),
    );
    sourceOccurredAtById.set(check.sourceId, checkProjection.occurredAt);
  }
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

/** 収集済み値から個人催促cause判定用のpure contextを作る。 */
export function createPersonalReminderRuntimeContext(
  input: Readonly<{
    evaluatedAt: UtcIsoDateTime;
    state: PersonalReminderRuntimeState;
    collection: PersonalReminderRuntimeCollection;
    graph: PersonalReminderRuntimeGraph;
  }>,
): PersonalReminderRuntimeContext {
  const items: PersonalReminderRuntimeContextItem[] = [];
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
    const previous = createPreviousCauses(input.state, item);
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
        executionSurfaceStates: executionSurfaceStates(input.graph, allContexts),
        sourceOccurredAtById: sourceProjection.sourceOccurredAtById,
        seedEvidence: sourceProjection.seedEvidence,
        evidenceScopes: sourceProjection.evidenceScopes,
        responsibilities: responsibilities ?? Object.freeze([]),
        itemContext,
        relatedItemContexts,
        externalItemContexts: Object.freeze(externalItemContexts),
        endpointStates: input.graph.endpointStates,
      }),
    );
  }
  return Object.freeze({
    evaluatedAt: input.evaluatedAt,
    state: input.state,
    items: Object.freeze(items),
    graph: input.graph,
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

function seedScopeNodeIds(seed: PersonalReminderCauseSeed): ReadonlySet<GraphNodeId> {
  const nodeIds = new Set<GraphNodeId>([seed.itemNodeId]);
  if (seed.responsibility.scope.kind !== "item") {
    for (const surface of seed.responsibility.scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds;
}

function relationConnectsSeeds(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  left: PersonalReminderCauseSeed,
  right: PersonalReminderCauseSeed,
): boolean {
  const leftNodeIds = seedScopeNodeIds(left);
  const rightNodeIds = seedScopeNodeIds(right);
  return (
    (leftNodeIds.has(relation.fromNodeId) && rightNodeIds.has(relation.toNodeId)) ||
    (leftNodeIds.has(relation.toNodeId) && rightNodeIds.has(relation.fromNodeId))
  );
}

function effectiveRelationsBetweenSeeds(
  context: PersonalReminderRuntimeContext,
  left: PersonalReminderCauseSeed,
  right: PersonalReminderCauseSeed,
): readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[] {
  return Object.freeze(
    context.graph.activeRelations
      .filter((relation) => activeRelationIsEffective(context.graph, relation))
      .filter((relation) => relation.type !== "related_to")
      .filter((relation) => relationConnectsSeeds(relation, left, right))
      .sort((first, second) => compareStrings(first.id, second.id)),
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
): readonly PersonalReminderRuntimeSource[] {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  for (const evidence of relation.evidence) {
    addRuntimeSource(
      sources,
      Object.freeze({
        source: Object.freeze({
          sourceId: evidence.sourceId,
          itemNodeId: relation.toNodeId,
          kind: "relation",
          actorType: "system",
          occurredAt: relation.firstSeenAt,
          summary: evidence.summary,
        }),
        roles: sourceRolesForKind("relation"),
        evidence: Object.freeze([evidence]),
        causalPush: false,
      }),
    );
  }
  return Object.freeze([...sources.values()]);
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
  });
}

function graphDerivedDrafts(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
): readonly PersonalReminderCauseDraft[] {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze([]);
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
    const implementation = contextItemByNodeId(context, relation.fromNodeId);
    if (implementation?.item.type !== "pull_request" || implementation.item.state !== "open") {
      continue;
    }
    if (
      relation.authoritative ||
      implementation.item.author.status !== "identified" ||
      implementation.item.author.actor.type !== "human"
    ) {
      continue;
    }
    const login = implementation.item.author.actor.login;
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
    if (localWorkActors.has(group.login.toLowerCase())) {
      continue;
    }
    const surfaces = group.relations.map((relation) => {
      const implementation = contextItemByNodeId(context, relation.fromNodeId);
      assertNonNullable(
        implementation,
        `implements relationの実装項目がありません。対象: ${relation.id}`,
      );
      return Object.freeze({ kind: implementation.item.type, nodeId: implementation.item.nodeId });
    });
    const firstRelation = group.relations[0];
    assertNonNullable(firstRelation, "graph由来責務のrelationがありません");
    drafts.push(makeGraphDraft(item.item, firstRelation, group.login, surfaces));
  }
  return Object.freeze(drafts);
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
  const itemContextNodeIds = new Set(seedScopeNodeIds(seed));
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
    itemContextNodeIds.add(option.itemNodeId);
  }
  for (const context of additionalItemContexts) {
    itemContextNodeIds.add(context.nodeId);
  }
  const availableContextNodeIds = new Set(
    [
      item.itemContext,
      ...item.relatedItemContexts,
      ...item.externalItemContexts,
      ...additionalItemContexts,
    ].map((context) => context.nodeId),
  );
  const seedSourceIds = new Set(seed.evidenceSourceIds);
  const nonSeedRequiredSourceIds = new Set<SourceId>([
    ...sourceIdsForRelationContexts(relationContexts),
    ...sourceIdsForPendingRelations(pendingRelations),
    ...waitingOptions.flatMap((option) => option.evidenceSourceIds),
    ...duplicateOptions.flatMap((option) => option.evidenceSourceIds),
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
      return seedScopeNodeIds(seed).has(entry.source.itemNodeId);
    })
    .map((entry) => entry.source);
  for (const sourceId of requiredSourceIds) {
    if (!sourceById.has(sourceId)) {
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
      assertNonNullable(source, `pending relationのsourceがありません。対象: ${sourceId}`);
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
    missing.push("item_timeline");
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
): readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[] {
  return Object.freeze(
    context.graph.activeRelations
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
    semanticInput.completeness.status !== "complete"
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

function waitingOptionsForCause(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  relationEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  currentSeed: PersonalReminderRuntimeCurrentSeed,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimeOptionProjection {
  const options: PersonalReminderWaitingOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missing = new Set<PersonalReminderMissingInput>();
  for (const candidate of currentSeeds) {
    if (candidate.origin !== "current_draft" || candidate.seed.causeId === seed.causeId) {
      continue;
    }
    const matchingRelations = relationEdges.filter((relation) =>
      relationConnectsSeeds(relation, seed, candidate.seed),
    );
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
    const relationSources = matchingRelations.flatMap(relationSourcesFromEdge);
    const relationSourceIds = matchingRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    const sourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `waiting option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (sourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSources) {
      addRuntimeSource(sources, source);
    }
    options.push({
      optionId: `${seed.causeId}:waiting:${candidate.seed.causeId}`,
      itemNodeId: candidate.seed.itemNodeId,
      action: { kind: candidate.seed.action.kind, summary: candidate.seed.action.summary },
      relationIds,
      evidenceSourceIds: [...sourceIds],
    });
  }
  for (const relation of relationEdges) {
    if (
      currentSeeds.some(
        (candidate) =>
          candidate.seed.causeId !== seed.causeId &&
          relationConnectsSeeds(relation, seed, candidate.seed),
      )
    ) {
      continue;
    }
    const subjectScope = seedScopeNodeIds(seed);
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
  return Object.freeze({
    options: Object.freeze(options),
    sources: Object.freeze([...sources.values()]),
    missing: Object.freeze([...missing]),
  });
}

function duplicateOptionsForCause(
  context: PersonalReminderRuntimeContext,
  current: PersonalReminderRuntimeCurrentSeed,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): Readonly<{
  options: readonly PersonalReminderDuplicateOption[];
  sources: readonly PersonalReminderRuntimeSource[];
}> {
  const options: PersonalReminderDuplicateOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  for (const candidate of currentSeeds) {
    if (
      candidate.seed.causeId === current.seed.causeId ||
      candidate.origin !== "current_draft" ||
      candidate.seed.action.kind !== current.seed.action.kind ||
      !sameResponsibleValues(candidate.seed.responsible, current.seed.responsible)
    ) {
      continue;
    }
    const directRelations = effectiveRelationsBetweenSeeds(context, current.seed, candidate.seed);
    const relationIds = directRelations.map((relation) => relation.id);
    if (relationIds.length === 0) {
      continue;
    }
    const canonical =
      current.origin === "retained_without_draft"
        ? candidate
        : duplicateCanonicalSeed(context, current, candidate, directRelations);
    if (canonical.seed.causeId !== candidate.seed.causeId) {
      continue;
    }
    const relationSourceEntries = directRelations.flatMap(relationSourcesFromEdge);
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
    for (const source of relationSourceEntries) {
      addRuntimeSource(sources, source);
    }
    options.push({
      canonicalCauseId: candidate.seed.causeId,
      itemNodeId: candidate.seed.itemNodeId,
      responsible: [...candidate.seed.responsible],
      action: { ...candidate.seed.action },
      relationIds,
      evidenceSourceIds: [...evidenceSourceIds],
    });
  }
  return Object.freeze({
    options: Object.freeze(options),
    sources: Object.freeze([...sources.values()]),
  });
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

/** fresh itemのcause候補をgraphと前回causeへreconcileする。 */
export function planPersonalReminderCauses(
  context: PersonalReminderRuntimeContext,
): PersonalReminderCauseRuntimePlan {
  const entries: PersonalReminderCauseRuntimePlanEntry[] = [];
  const preservedCauses: PersonalReminderCause[] = [];
  const preservedEvidenceByNodeId = new Map<GitHubNodeId, readonly Evidence[]>();
  const endedCauseIds = new Set<PersonalReminderCauseId>();
  const pendingCauseIds = new Set<PersonalReminderCauseId>();
  const reconciledItems: PersonalReminderRuntimeReconciledItem[] = [];
  const globalSourcesById = new Map<SourceId, PersonalReminderRuntimeSource>();
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
      const draft = createPersonalReminderCauseDraft(item.item, item.localDecision, responsibility);
      if ("status" in draft) {
        continue;
      }
      localDrafts.push(draft);
    }
    const drafts = [...localDrafts, ...graphDerivedDrafts(context, item, localDrafts)];
    const structuralEnded = determineStructurallyEndedPersonalReminderCauses({
      item: item.item,
      previous,
      currentDrafts: drafts,
      currentDecisionStatus: item.localDecision.status,
      complete: item.completeness.status === "complete",
      currentReviewRequestTargets: item.currentReviewRequestTargets,
      executionSurfaceStates: item.executionSurfaceStates,
    });
    const reconciliation = reconcilePersonalReminderCauseSeeds({
      item: item.item,
      drafts,
      previous,
      currentObservedAt: context.evaluatedAt,
      sourceOccurredAtById: item.sourceOccurredAtById,
      confirmedEndedCauseIds: new Set(structuralEnded),
    });
    for (const causeId of reconciliation.endedCauseIds) {
      endedCauseIds.add(causeId);
    }
    const previousById = previousCauseById(previous);
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

  for (const reconciled of reconciledItems) {
    const item = reconciled.item;
    for (const seed of reconciled.reconciliation.seeds) {
      const currentSeed = currentSeeds.find((value) => value.seed.causeId === seed.causeId);
      assertNonNullable(currentSeed, `current seedがありません。対象: ${seed.causeId}`);
      const relationEdges = selectedRelationEdges(context, seed);
      const pendingRelations = selectedPendingRelations(context, seed);
      const waitingProjection = waitingOptionsForCause(
        context,
        item,
        seed,
        relationEdges,
        currentSeed,
        currentSeeds,
      );
      const duplicateProjection = duplicateOptionsForCause(context, currentSeed, currentSeeds);
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
      const relationSources = relationEdgesForInput.flatMap(relationSourcesFromEdge);
      const optionSources = [...waitingProjection.sources, ...duplicateProjection.sources];
      const additionalItemContexts = currentSeeds
        .filter((value) =>
          [...waitingProjection.options, ...duplicateProjection.options].some(
            (option) => option.itemNodeId === value.seed.itemNodeId,
          ),
        )
        .map((value) => value.item.itemContext);
      const activityProjection = activityForCause(
        item,
        seed,
        currentSeed.previousCause,
        context.evaluatedAt,
        currentSeeds,
      );
      const semanticInput = createCauseSemanticInput(
        item,
        globalSources,
        globalCausalSourcesByNodeId,
        seed,
        relations,
        pendingRelations,
        waitingProjection.options,
        duplicateProjection.options,
        relationSources,
        optionSources,
        additionalItemContexts,
        [...waitingProjection.missing, ...activityProjection.missing],
      );
      if (pendingRelations.length !== 0) {
        pendingCauseIds.add(seed.causeId);
      }
      entries.push(
        Object.freeze({
          seed,
          semanticInput,
          deterministicAssessment: deterministicAssessment(seed, semanticInput, currentSeed.origin),
          previousCause: currentSeed.previousCause,
          sourceEvidence: Object.freeze([...item.seedEvidence]),
          activity: activityProjection.activity,
          repositoryFullName: item.repositoryFullName,
          currentLabels: item.currentLabels,
        }),
      );
    }
  }
  return Object.freeze({
    entries: Object.freeze(
      entries.sort((left, right) => compareStrings(left.seed.causeId, right.seed.causeId)),
    ),
    preservedCauses: Object.freeze(preservedCauses),
    preservedEvidenceByNodeId,
    endedCauseIds: Object.freeze([...endedCauseIds].sort(compareStrings)),
    pendingCauseIds: Object.freeze([...pendingCauseIds].sort(compareStrings)),
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
      failedAt: attemptedAt,
      reason: outcome.reason,
    });
  }
  if (outcome?.status === "deferred") {
    return Object.freeze({
      status: "deferred",
      inputFingerprint: fingerprint,
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
      lastConfirmedActionability,
      currentInput: {
        fingerprint,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
        completeness: entry.semanticInput.completeness,
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

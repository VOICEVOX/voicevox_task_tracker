import {
  type Actor,
  type FreshObservedGitHubItemBase,
  type FreshObservedGitHubIssue as DomainFreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type NormalizedEvent,
  type ObservedGitHubAutoMerge,
  type ObservedGitHubItemAuthor,
  type ObservedGitHubItemState,
  type ObservedGitHubPullRequestMergeState,
  type ObservedGitHubReviewRequest,
  type ObservedGitHubReviewRequestTarget,
  type ObservedGitHubReviewThread,
  resolvePullRequestCommitOccurredAt,
  type SourceId,
  type SystemActor,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { UnreachableError, assertNonNullable } from "../util/index.js";
import { type GitHubApiAccountType } from "./account-types.js";
import {
  type GitHubCurrentReviewRequest,
  type GitHubDetailActor,
  type GitHubHeadChecks,
  type GitHubInboundCrossReferenceCandidate,
  type GitHubItemDetail,
  type GitHubNativeDependencyCollection,
  type GitHubNativeHierarchy,
  type GitHubNativeHierarchyCollection,
  type GitHubPullRequestCommit,
  type GitHubPullRequestMergeState,
  type GitHubReviewRequestTarget,
  type GitHubTimelineEvent,
} from "./item-detail-types.js";
import {
  createGitHubBodyFingerprint,
  type EnumeratedGitHubItem,
  type GitHubItemAuthor,
  type GitHubItemMilestone,
  type Sha256Fingerprint,
} from "./item-enumeration.js";
import { type PublicRepositoryId } from "./public-repository-allowlist.js";
import { deduplicateByStableId } from "./stable-id.js";

const GITHUB_SYSTEM_ACTOR = Object.freeze({
  type: "system",
  name: "github",
} satisfies SystemActor);

/** 設定によるbot判定へ渡すGitHubアカウント情報。 */
export type GitHubBotPredicateInput = Readonly<{
  nodeId: GitHubNodeId;
  login: string;
  apiType: GitHubApiAccountType;
}>;

/** GitHubアカウントをbotとして扱うか判定する純粋関数。 */
export type GitHubBotPredicate = (account: GitHubBotPredicateInput) => boolean;

type GitHubActorObservation =
  | Readonly<{
      status: "identified";
      actor: GitHubAccountActor;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_actor";
    }>;

type GitHubReviewThreadNormalizationResult = ObservedGitHubReviewThread &
  Readonly<{
    path: string;
    resolvedBy: GitHubActorObservation;
  }>;

type GitHubPullRequestMergeStateNormalizationResult = ObservedGitHubPullRequestMergeState &
  Readonly<{
    checks: GitHubHeadChecks;
  }>;

type FreshObservedGitHubItemMetadata = Readonly<{
  repositoryId: PublicRepositoryId;
  displayReference: GitHubItemDisplayReference;
  number: number;
  url: GitHubItemUrl;
  title: string;
  bodySourceId: SourceId;
  bodyFingerprint: Sha256Fingerprint;
  itemFingerprint: Sha256Fingerprint;
  createdAt: UtcIsoDateTime;
  githubUpdatedAt: UtcIsoDateTime;
  labels: readonly string[];
  milestone: GitHubItemMilestone | null;
  inboundCrossReferences: readonly GitHubInboundCrossReferenceCandidate[];
}>;

/** 最新取得に成功したIssueの判定前観測値。 */
export type FreshObservedGitHubIssue = DomainFreshObservedGitHubIssue &
  FreshObservedGitHubItemMetadata &
  Readonly<{
    draft: "not_applicable";
    nativeDependencies: GitHubNativeDependencyCollection;
    nativeHierarchy: GitHubNativeHierarchyCollection;
  }>;

type GitHubPullRequestNormalizationResult = FreshObservedGitHubPullRequest &
  FreshObservedGitHubItemMetadata &
  Readonly<{
    reviewThreads: readonly GitHubReviewThreadNormalizationResult[];
    mergeState: GitHubPullRequestMergeStateNormalizationResult;
  }>;

/** 最新取得に成功したGitHub項目の判定前観測値。 */
export type FreshObservedGitHubItem =
  FreshObservedGitHubIssue | GitHubPullRequestNormalizationResult;

/** stale化に必要な前回観測値の最小契約。 */
export type FreshObservedGitHubItemReference = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  observedAt: UtcIsoDateTime;
}>;

/** 取得失敗により前回観測値だけを保持するGitHub項目。 */
export type StaleObservedGitHubItem<
  PreviousObservation extends FreshObservedGitHubItemReference = FreshObservedGitHubItem,
> = Readonly<{
  freshness: "stale";
  nodeId: GitHubNodeId;
  repositoryId: PreviousObservation["repositoryId"];
  previousObservation: PreviousObservation;
  lastSuccessfulAt: UtcIsoDateTime;
  failedAt: UtcIsoDateTime;
  diagnostic: Readonly<{
    code: "github_repository_temporarily_unavailable";
    message: string;
  }>;
}>;

export type NormalizeGitHubEventsOptions = Readonly<{
  item: EnumeratedGitHubItem;
  detail: GitHubItemDetail;
  isBot: GitHubBotPredicate;
}>;

export type NormalizeObservedGitHubItemOptions = NormalizeGitHubEventsOptions;

export type NormalizeObservedGitHubItemsOptions = Readonly<{
  items: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  isBot: GitHubBotPredicate;
}>;

export type MarkObservedGitHubItemsStaleOptions<
  PreviousObservation extends FreshObservedGitHubItemReference = FreshObservedGitHubItem,
> = Readonly<{
  previousItems: readonly PreviousObservation[];
  failedAt: UtcIsoDateTime;
  diagnostic: Readonly<{
    code: "github_repository_temporarily_unavailable";
    message: string;
  }>;
}>;

function normalizeAccountActor(
  account: GitHubBotPredicateInput,
  isBot: GitHubBotPredicate,
): GitHubAccountActor {
  const actorType = account.apiType === "Bot" || isBot(account) ? "bot" : "human";
  return Object.freeze({
    type: actorType,
    nodeId: account.nodeId,
    login: account.login,
  });
}

/** GitHub APIが返したアクターをhuman、bot、systemへ正規化する。 */
export function normalizeGitHubActor(actor: GitHubDetailActor, isBot: GitHubBotPredicate): Actor {
  if (actor.status === "unavailable") {
    return GITHUB_SYSTEM_ACTOR;
  }
  return normalizeAccountActor(actor.account, isBot);
}

function normalizeObservedActor(
  actor: GitHubDetailActor,
  isBot: GitHubBotPredicate,
): GitHubActorObservation {
  if (actor.status === "unavailable") {
    return Object.freeze({
      status: "unavailable",
      reason: actor.reason,
    });
  }
  return Object.freeze({
    status: "identified",
    actor: normalizeAccountActor(actor.account, isBot),
  });
}

function normalizeItemAuthor(
  author: GitHubItemAuthor,
  isBot: GitHubBotPredicate,
): ObservedGitHubItemAuthor {
  if (author.kind === "deleted_account") {
    return Object.freeze({
      status: "unavailable",
      reason: "deleted_account",
    });
  }
  return Object.freeze({
    status: "identified",
    actor: normalizeAccountActor(author.account, isBot),
  });
}

function validateItemAndDetail(item: EnumeratedGitHubItem, detail: GitHubItemDetail): void {
  if (item.nodeId !== detail.nodeId) {
    throw new TypeError("列挙結果と詳細取得結果のitem node IDが一致しません");
  }
  if (item.repositoryId !== detail.repositoryId) {
    throw new TypeError("列挙結果と詳細取得結果のrepository IDが一致しません");
  }
  if (item.number !== detail.number) {
    throw new TypeError("列挙結果と詳細取得結果のitem numberが一致しません");
  }
  if (item.type !== detail.type) {
    throw new TypeError("列挙結果と詳細取得結果のitem種別が一致しません");
  }
  if (item.observedAt !== detail.observedAt) {
    throw new TypeError("列挙結果と詳細取得結果の観測時刻が一致しません");
  }
}

function normalizeCommentEvent(
  itemNodeId: GitHubNodeId,
  sourceId: SourceId,
  body: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubDetailActor,
  isBot: GitHubBotPredicate,
): NormalizedEvent {
  return Object.freeze({
    kind: "comment",
    sourceId,
    itemNodeId,
    occurredAt,
    actor: normalizeGitHubActor(actor, isBot),
    bodyFingerprint: createGitHubBodyFingerprint(body),
    bodyEmpty: body.length === 0,
  });
}

function normalizePushEvent(
  itemNodeId: GitHubNodeId,
  itemCreatedAt: UtcIsoDateTime,
  commit: GitHubPullRequestCommit,
): NormalizedEvent {
  return Object.freeze({
    kind: "push",
    sourceId: commit.sourceId,
    itemNodeId,
    occurredAt: resolvePullRequestCommitOccurredAt(commit, itemCreatedAt),
    actor: GITHUB_SYSTEM_ACTOR,
    headCommitSha: commit.sha,
    forcePush: false,
  });
}

function normalizeReviewEvent(
  itemNodeId: GitHubNodeId,
  review: Extract<GitHubItemDetail, { type: "pull_request" }>["reviews"][number],
  isBot: GitHubBotPredicate,
): NormalizedEvent {
  const fields: Readonly<{
    kind: "review";
    sourceId: SourceId;
    itemNodeId: GitHubNodeId;
    occurredAt: UtcIsoDateTime;
    actor: Actor;
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    bodyFingerprint: Sha256Fingerprint;
    bodyEmpty: boolean;
  }> = {
    kind: "review",
    sourceId: review.sourceId,
    itemNodeId,
    occurredAt: review.submittedAt,
    actor: normalizeGitHubActor(review.author, isBot),
    state: review.state,
    bodyFingerprint: createGitHubBodyFingerprint(review.body),
    bodyEmpty: review.body.length === 0,
  };
  if (review.commit.status === "unavailable") {
    return Object.freeze({
      ...fields,
      commitStatus: "unavailable",
    });
  }
  return Object.freeze({
    ...fields,
    commitStatus: "available",
    commitSha: review.commit.sha,
  });
}

function normalizeReviewRequestTarget(
  target: GitHubReviewRequestTarget,
): Extract<NormalizedEvent, { kind: "review_request" }>["target"] {
  return Object.freeze({
    type: target.type,
    nodeId: target.nodeId,
  });
}

function normalizeClosedStateReason(
  item: EnumeratedGitHubItem,
  event: Readonly<{
    occurredAt: UtcIsoDateTime;
  }>,
): "completed" | "not_planned" | "duplicate" | "unavailable" {
  if (item.state !== "closed" || item.closedAt !== event.occurredAt) {
    return "unavailable";
  }
  if (item.stateReason == null) {
    return "unavailable";
  }
  return item.stateReason;
}

function normalizeTimelineEvent(
  item: EnumeratedGitHubItem,
  detail: GitHubItemDetail,
  event: GitHubTimelineEvent,
  isBot: GitHubBotPredicate,
): readonly NormalizedEvent[] {
  switch (event.kind) {
    case "assigned":
    case "unassigned":
      return Object.freeze([
        Object.freeze({
          kind: "assignee",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          assignee: normalizeAccountActor(event.assignee.account, isBot),
          action: event.kind === "assigned" ? "added" : "removed",
        }),
      ]);
    case "labeled":
    case "unlabeled":
      return Object.freeze([
        Object.freeze({
          kind: "label",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          labelName: event.label.name,
          action: event.kind === "labeled" ? "added" : "removed",
        }),
      ]);
    case "review_requested":
    case "review_request_removed":
      return Object.freeze([
        Object.freeze({
          kind: "review_request",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          target: normalizeReviewRequestTarget(event.target),
          action: event.kind === "review_requested" ? "added" : "removed",
        }),
      ]);
    case "closed":
      return Object.freeze([
        Object.freeze({
          kind: "state",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          state: "closed",
          stateReason: normalizeClosedStateReason(item, event),
        }),
      ]);
    case "reopened":
    case "merged":
      return Object.freeze([
        Object.freeze({
          kind: "state",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          state: event.kind,
        }),
      ]);
    case "cross_referenced":
      return Object.freeze([
        Object.freeze({
          kind: "relation",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          relationType: event.willCloseTarget ? "implements" : "related_to",
          target: Object.freeze({
            type: "node",
            nodeId: event.source.nodeId,
          }),
          action: "added",
          provenance: "cross_reference",
          direction: event.willCloseTarget ? "to_item" : "from_item",
        }),
      ]);
    case "connected":
    case "disconnected":
      return Object.freeze([
        Object.freeze({
          kind: "relation",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          relationType: "related_to",
          target: Object.freeze({
            type: "node",
            nodeId: event.subject.nodeId,
          }),
          action: event.kind === "connected" ? "added" : "removed",
          provenance: "native",
          direction: "from_item",
        }),
      ]);
    case "sub_issue_added":
    case "sub_issue_removed":
    case "parent_issue_added":
    case "parent_issue_removed":
      return Object.freeze([]);
    case "head_ref_force_pushed":
      return Object.freeze([
        Object.freeze({
          kind: "push",
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
          headCommitSha: event.afterSha,
          forcePush: true,
        }),
      ]);
    case "commit_added":
      return Object.freeze([normalizePushEvent(detail.nodeId, item.createdAt, event.commit)]);
    case "ready_for_review":
    case "converted_to_draft":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return Object.freeze([
        Object.freeze({
          kind: event.kind,
          sourceId: event.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: event.occurredAt,
          actor: normalizeGitHubActor(event.actor, isBot),
        }),
      ]);
    default:
      throw new UnreachableError(event);
  }
}

function normalizeNativeDependencyEvents(
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
  itemCreatedAt: UtcIsoDateTime,
): readonly NormalizedEvent[] {
  if (detail.nativeDependencies.availability === "unavailable") {
    return Object.freeze([]);
  }
  return Object.freeze(
    detail.nativeDependencies.relations.map((relation) =>
      Object.freeze({
        kind: "relation",
        sourceId: relation.sourceId,
        itemNodeId: detail.nodeId,
        occurredAt:
          itemCreatedAt > relation.relatedItem.createdAt
            ? itemCreatedAt
            : relation.relatedItem.createdAt,
        actor: GITHUB_SYSTEM_ACTOR,
        relationType: "blocks",
        target: Object.freeze({
          type: "node",
          nodeId: relation.relatedItem.nodeId,
        }),
        action: "added",
        provenance: "native",
        direction: relation.direction === "blocked_by" ? "to_item" : "from_item",
      } satisfies NormalizedEvent),
    ),
  );
}

type GitHubNativeHierarchyTimelineEvent = Extract<
  GitHubTimelineEvent,
  {
    kind: "sub_issue_added" | "sub_issue_removed" | "parent_issue_added" | "parent_issue_removed";
  }
>;

function isNativeHierarchyTimelineEvent(
  event: GitHubTimelineEvent,
): event is GitHubNativeHierarchyTimelineEvent {
  return (
    event.kind === "sub_issue_added" ||
    event.kind === "sub_issue_removed" ||
    event.kind === "parent_issue_added" ||
    event.kind === "parent_issue_removed"
  );
}

function compareNativeHierarchyTimelineEvents(
  left: GitHubNativeHierarchyTimelineEvent,
  right: GitHubNativeHierarchyTimelineEvent,
): number {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  if (left.sequence < right.sequence) {
    return -1;
  }
  if (left.sequence > right.sequence) {
    return 1;
  }
  if (left.sourceId < right.sourceId) {
    return -1;
  }
  if (left.sourceId > right.sourceId) {
    return 1;
  }
  return 0;
}

function hierarchyEventMatchesRelation(
  event: GitHubNativeHierarchyTimelineEvent,
  relation: GitHubNativeHierarchy,
): boolean {
  switch (event.kind) {
    case "sub_issue_added":
    case "sub_issue_removed":
      return (
        relation.relationship === "sub_issue" &&
        event.subIssue.nodeId === relation.relatedItem.nodeId
      );
    case "parent_issue_added":
    case "parent_issue_removed":
      return (
        relation.relationship === "parent" && event.parent.nodeId === relation.relatedItem.nodeId
      );
    default:
      throw new UnreachableError(event);
  }
}

function resolveNativeHierarchyOccurredAt(
  events: readonly GitHubNativeHierarchyTimelineEvent[],
  relation: GitHubNativeHierarchy,
  itemCreatedAt: UtcIsoDateTime,
): UtcIsoDateTime {
  let currentInterval:
    | Readonly<{
        status: "active";
        startedAt: UtcIsoDateTime;
      }>
    | Readonly<{
        status: "inactive";
      }> = Object.freeze({ status: "inactive" });
  for (const event of events) {
    if (!hierarchyEventMatchesRelation(event, relation)) {
      continue;
    }
    if (event.kind === "sub_issue_added" || event.kind === "parent_issue_added") {
      if (currentInterval.status === "inactive") {
        currentInterval = Object.freeze({
          status: "active",
          startedAt: event.occurredAt,
        });
      }
    } else {
      currentInterval = Object.freeze({ status: "inactive" });
    }
  }
  if (currentInterval.status === "active") {
    return currentInterval.startedAt;
  }
  return itemCreatedAt > relation.relatedItem.createdAt
    ? itemCreatedAt
    : relation.relatedItem.createdAt;
}

function normalizeNativeHierarchyEvents(
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
  itemCreatedAt: UtcIsoDateTime,
): readonly NormalizedEvent[] {
  if (detail.nativeHierarchy.availability === "unavailable") {
    return Object.freeze([]);
  }
  const hierarchyTimeline = detail.timeline
    .filter(isNativeHierarchyTimelineEvent)
    .toSorted(compareNativeHierarchyTimelineEvents);
  return Object.freeze(
    detail.nativeHierarchy.relations.map((relation) =>
      Object.freeze({
        kind: "relation",
        sourceId: relation.sourceId,
        itemNodeId: detail.nodeId,
        occurredAt: resolveNativeHierarchyOccurredAt(hierarchyTimeline, relation, itemCreatedAt),
        actor: GITHUB_SYSTEM_ACTOR,
        relationType: "parent_of",
        target: Object.freeze({
          type: "node",
          nodeId: relation.relatedItem.nodeId,
        }),
        action: "added",
        provenance: "native",
        direction: relation.relationship === "parent" ? "to_item" : "from_item",
      } satisfies NormalizedEvent),
    ),
  );
}

function normalizeCurrentReviewRequestSnapshots(
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  pullRequestCreatedAt: UtcIsoDateTime,
): readonly NormalizedEvent[] {
  return Object.freeze(
    detail.reviewRequests.current
      .filter((request) => request.requestedAt.status === "unavailable")
      .map((request) =>
        Object.freeze({
          kind: "review_request",
          sourceId: request.sourceId,
          itemNodeId: detail.nodeId,
          occurredAt: pullRequestCreatedAt,
          actor: GITHUB_SYSTEM_ACTOR,
          target: normalizeReviewRequestTarget(request.target),
          action: "added",
        } satisfies NormalizedEvent),
      ),
  );
}

function compareNormalizedEvents(left: NormalizedEvent, right: NormalizedEvent): number {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  if (left.sourceId < right.sourceId) {
    return -1;
  }
  if (left.sourceId > right.sourceId) {
    return 1;
  }
  return 0;
}

function assertSourceIdsDoNotCrossKinds(events: readonly NormalizedEvent[]): void {
  const kindsBySourceId = new Map<SourceId, NormalizedEvent["kind"]>();
  for (const event of events) {
    const previousKind = kindsBySourceId.get(event.sourceId);
    if (previousKind != null && previousKind !== event.kind) {
      throw new TypeError(
        `同じsource IDが異なるイベント種別を指しています。対象: ${event.sourceId}`,
      );
    }
    kindsBySourceId.set(event.sourceId, event.kind);
  }
}

function normalizeEvents(options: NormalizeGitHubEventsOptions): readonly NormalizedEvent[] {
  const events: NormalizedEvent[] = options.detail.comments.map((comment) =>
    normalizeCommentEvent(
      options.detail.nodeId,
      comment.sourceId,
      comment.body,
      comment.createdAt,
      comment.author,
      options.isBot,
    ),
  );
  for (const event of options.detail.timeline) {
    events.push(...normalizeTimelineEvent(options.item, options.detail, event, options.isBot));
  }
  if (options.detail.type === "issue") {
    events.push(...normalizeNativeDependencyEvents(options.detail, options.item.createdAt));
    events.push(...normalizeNativeHierarchyEvents(options.detail, options.item.createdAt));
  } else {
    for (const review of options.detail.reviews) {
      events.push(normalizeReviewEvent(options.detail.nodeId, review, options.isBot));
    }
    for (const thread of options.detail.reviewThreads) {
      for (const comment of thread.comments) {
        events.push(
          normalizeCommentEvent(
            options.detail.nodeId,
            comment.sourceId,
            comment.body,
            comment.createdAt,
            comment.author,
            options.isBot,
          ),
        );
      }
    }
    events.push(...normalizeCurrentReviewRequestSnapshots(options.detail, options.item.createdAt));
    events.push(
      normalizePushEvent(options.detail.nodeId, options.item.createdAt, options.detail.headCommit),
    );
  }
  assertSourceIdsDoNotCrossKinds(events);
  const deduplicated = deduplicateByStableId(events, (event) => event.sourceId);
  return Object.freeze([...deduplicated].sort(compareNormalizedEvents));
}

/** 詳細取得結果をsource IDで重複排除した決定論的な正規化イベント列へ変換する。 */
export function normalizeGitHubEvents(
  options: NormalizeGitHubEventsOptions,
): readonly NormalizedEvent[] {
  validateItemAndDetail(options.item, options.detail);
  return normalizeEvents(options);
}

function normalizeReviewRequestTargetObservation(
  target: GitHubReviewRequestTarget,
  isBot: GitHubBotPredicate,
): ObservedGitHubReviewRequestTarget {
  if (target.type === "user") {
    return Object.freeze({
      type: "user",
      actor: normalizeAccountActor(target, isBot),
    });
  }
  return Object.freeze({
    type: "team",
    sourceId: target.sourceId,
    nodeId: target.nodeId,
    organizationLogin: target.organizationLogin,
    slug: target.slug,
    name: target.name,
  });
}

function normalizeReviewRequestObservation(
  request: GitHubCurrentReviewRequest,
  isBot: GitHubBotPredicate,
): ObservedGitHubReviewRequest {
  return Object.freeze({
    sourceId: request.sourceId,
    nodeId: request.nodeId,
    target: normalizeReviewRequestTargetObservation(request.target, isBot),
    requestedAt: request.requestedAt,
  });
}

function normalizeReviewThreads(
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  isBot: GitHubBotPredicate,
): readonly GitHubReviewThreadNormalizationResult[] {
  return Object.freeze(
    detail.reviewThreads.map((thread) =>
      Object.freeze({
        sourceId: thread.sourceId,
        nodeId: thread.nodeId,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path,
        resolvedBy: normalizeObservedActor(thread.resolvedBy, isBot),
        commentSourceIds: Object.freeze(thread.comments.map((comment) => comment.sourceId)),
      }),
    ),
  );
}

function normalizeAutoMerge(
  autoMerge: GitHubPullRequestMergeState["autoMerge"],
  isBot: GitHubBotPredicate,
): ObservedGitHubAutoMerge {
  if (autoMerge.status === "not_enabled") {
    return Object.freeze({
      status: "not_enabled",
    });
  }
  return Object.freeze({
    status: "enabled",
    sourceId: autoMerge.sourceId,
    enabledAt: autoMerge.enabledAt,
    enabledBy: normalizeGitHubActor(autoMerge.enabledBy, isBot),
    mergeMethod: autoMerge.mergeMethod,
  });
}

function normalizeMergeState(
  mergeState: GitHubPullRequestMergeState,
  isBot: GitHubBotPredicate,
): GitHubPullRequestMergeStateNormalizationResult {
  return Object.freeze({
    mergeability: mergeState.mergeability,
    mergeState: mergeState.mergeState,
    autoMerge: normalizeAutoMerge(mergeState.autoMerge, isBot),
    mergeQueue: mergeState.mergeQueue,
    checks: mergeState.checks,
  });
}

function createItemState(item: EnumeratedGitHubItem): ObservedGitHubItemState {
  if (item.state === "open") {
    return Object.freeze({
      state: item.state,
      stateReason: item.stateReason,
      closedAt: item.closedAt,
    });
  }
  return Object.freeze({
    state: item.state,
    stateReason: item.stateReason,
    closedAt: item.closedAt,
  });
}

function createFreshItemFields(
  options: NormalizeObservedGitHubItemOptions,
): FreshObservedGitHubItemBase & FreshObservedGitHubItemMetadata & ObservedGitHubItemState {
  return Object.freeze({
    freshness: "fresh",
    sourceId: options.detail.sourceId,
    nodeId: options.item.nodeId,
    repositoryId: options.item.repositoryId,
    displayReference: options.item.displayReference,
    number: options.item.number,
    url: options.item.url,
    title: options.item.title,
    bodySourceId: options.detail.bodySourceId,
    bodyFingerprint: createGitHubBodyFingerprint(options.detail.body),
    itemFingerprint: options.item.itemFingerprint,
    author: normalizeItemAuthor(options.item.author, options.isBot),
    createdAt: options.item.createdAt,
    githubUpdatedAt: options.item.updatedAt,
    ...createItemState(options.item),
    assignees: Object.freeze(
      options.item.assignees.map((assignee) => normalizeAccountActor(assignee, options.isBot)),
    ),
    labels: Object.freeze([...options.item.labels]),
    milestone:
      options.item.milestone == null
        ? null
        : Object.freeze({
            nodeId: options.item.milestone.nodeId,
            number: options.item.milestone.number,
            title: options.item.milestone.title,
            state: options.item.milestone.state,
            dueOn: options.item.milestone.dueOn,
          }),
    inboundCrossReferences: Object.freeze([...options.detail.inboundCrossReferences]),
    events: normalizeEvents(options),
    observedAt: options.detail.observedAt,
  });
}

/** 列挙結果と詳細取得結果を判定前の本文非保持な最新観測値へ変換する。 */
export function normalizeObservedGitHubItem(
  options: NormalizeObservedGitHubItemOptions,
): FreshObservedGitHubItem {
  validateItemAndDetail(options.item, options.detail);
  const fields = createFreshItemFields(options);
  if (options.item.type === "issue" && options.detail.type === "issue") {
    return Object.freeze({
      ...fields,
      type: "issue",
      draft: options.item.draft,
      nativeDependencies: options.detail.nativeDependencies,
      nativeHierarchy: options.detail.nativeHierarchy,
    });
  }
  if (options.item.type === "pull_request" && options.detail.type === "pull_request") {
    return Object.freeze({
      ...fields,
      type: "pull_request",
      draft: options.item.draft,
      headSha: options.detail.headSha,
      headCommit: options.detail.headCommit,
      reviewThreads: normalizeReviewThreads(options.detail, options.isBot),
      reviewRequests: Object.freeze(
        options.detail.reviewRequests.current.map((request) =>
          normalizeReviewRequestObservation(request, options.isBot),
        ),
      ),
      mergeState: normalizeMergeState(options.detail.mergeState, options.isBot),
    });
  }
  throw new TypeError("列挙結果と詳細取得結果のitem種別が一致しません");
}

function assertUniqueItemNodeIds(
  values: readonly Readonly<{ nodeId: GitHubNodeId }>[],
  context: string,
): void {
  const nodeIds = new Set(values.map((value) => value.nodeId));
  if (nodeIds.size !== values.length) {
    throw new TypeError(`${context}のitem node IDが重複しています`);
  }
}

/** 列挙順を保って詳細取得結果を判定前の最新観測値へ変換する。 */
export function normalizeObservedGitHubItems(
  options: NormalizeObservedGitHubItemsOptions,
): readonly FreshObservedGitHubItem[] {
  assertUniqueItemNodeIds(options.items, "列挙結果");
  assertUniqueItemNodeIds(options.details, "詳細取得結果");
  if (options.items.length !== options.details.length) {
    throw new TypeError("列挙結果と詳細取得結果の件数が一致しません");
  }
  const detailsByNodeId = new Map(options.details.map((detail) => [detail.nodeId, detail]));
  return Object.freeze(
    options.items.map((item) => {
      const detail = detailsByNodeId.get(item.nodeId);
      assertNonNullable(detail, `詳細取得結果がありません。対象: ${item.nodeId}`);
      return normalizeObservedGitHubItem({
        item,
        detail,
        isBot: options.isBot,
      });
    }),
  );
}

/** 前回の最新観測値を現在値へ昇格させずstale項目として保持する。 */
export function markObservedGitHubItemsStale<
  PreviousObservation extends FreshObservedGitHubItemReference,
>(
  options: MarkObservedGitHubItemsStaleOptions<PreviousObservation>,
): readonly StaleObservedGitHubItem<PreviousObservation>[] {
  assertUniqueItemNodeIds(options.previousItems, "前回観測値");
  return Object.freeze(
    options.previousItems.map((previousObservation) => {
      if (options.failedAt < previousObservation.observedAt) {
        throw new RangeError("取得失敗時刻は前回成功時刻以後にしてください");
      }
      return Object.freeze({
        freshness: "stale",
        nodeId: previousObservation.nodeId,
        repositoryId: previousObservation.repositoryId,
        previousObservation,
        lastSuccessfulAt: previousObservation.observedAt,
        failedAt: options.failedAt,
        diagnostic: Object.freeze({
          code: options.diagnostic.code,
          message: options.diagnostic.message,
        }),
      });
    }),
  );
}

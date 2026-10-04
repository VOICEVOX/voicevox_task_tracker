import type { Config } from "../../../config/schema.js";
import {
  currentPersonalReminderAssessment,
  determinePotentialPersonalReminderContinuityConflictNodeIds,
  determineTerminalRetention,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type GitHubNodeId,
  type RetentionItemState,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import { personalReminderCauseNeedsClockReconfirmation } from "../../../domain/personal-reminder-causes.js";
import { parseSourceId } from "../../../domain/source-id.js";
import {
  planIncrementalItemCollection,
  type IncrementalItemCollectionPlan,
} from "../../../github/incremental-item-collection.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { RunExecutionPolicy } from "../request.js";
import type { AnalysisPreviousState, PreviousCollectionItem } from "../contracts/previous-state.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import {
  analysisPlanFingerprintForItem,
  createAiAnalysisRunIdentity,
} from "./collection-analysis-fingerprint.js";
import { staleAiAnalysisElementsForLifecycle } from "./collection-lifecycle.js";
import { personalReminderCauseSourceIds } from "./personal-reminder-cause-references.js";
import { personalReminderCauseScope } from "./personal-reminder-related-scope.js";

export type CollectionPlanningReferences = Readonly<{
  adjacentNodeIds: ReadonlySet<GitHubNodeId>;
  personalReminderRelationCandidateConsumerNodeIds: ReadonlySet<GitHubNodeId>;
  staleBlockerTopologyNodeIds: ReadonlySet<GitHubNodeId>;
}>;

export type CollectionPlanningContext = Readonly<{
  startedAt: UtcIsoDateTime;
  config: Config;
  executionPolicy: RunExecutionPolicy;
  previousState: AnalysisPreviousState;
  references: CollectionPlanningReferences;
  digest: ContentDigestPort;
}>;

function previousSnapshot(
  state: AnalysisPreviousState,
): Extract<AnalysisPreviousState["snapshot"], { status: "available" }> | undefined {
  return state.snapshot.status === "available" ? state.snapshot : undefined;
}

function previousCollectionItemsByNodeId(
  state: AnalysisPreviousState,
): ReadonlyMap<GitHubNodeId, PreviousCollectionItem> {
  return new Map(
    (previousSnapshot(state)?.collectionRepositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item] as const),
    ),
  );
}

function previousItemCollection(
  state: AnalysisPreviousState,
  repository: PublicRepository,
): Parameters<typeof planIncrementalItemCollection>[0]["previous"] {
  const previous = previousSnapshot(state)?.collectionRepositories.find(
    (item) => item.repositoryId === repository.id,
  );
  if (previous == null) {
    return Object.freeze({ status: "none" });
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

/** 追跡対象の識別子を正規化する。 */
export function normalizeTrackingIdentifier(identifier: string): string {
  if (identifier.includes("://") && identifier.endsWith("/")) {
    return identifier.slice(0, -1);
  }
  return identifier;
}

function explicitIdentifierMatchesItem(
  explicitIncludes: readonly string[],
  item: Readonly<{ nodeId: GitHubNodeId; url: string }>,
): boolean {
  return explicitIncludes
    .map(normalizeTrackingIdentifier)
    .some((identifier) => identifier === item.nodeId || identifier === item.url);
}

function previousCollectionRetentionItemState(item: PreviousCollectionItem): RetentionItemState {
  if (item.state === "open") {
    return Object.freeze({ state: "open" });
  }
  return Object.freeze({
    state: "closed",
    terminalAt: item.terminalAt,
  });
}

/** 列挙項目の保持判定用状態を返す。 */
export function enumeratedRetentionItemState(item: EnumeratedGitHubItem): RetentionItemState {
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

/** 前回追跡項目を今回も保持するか判定する。 */
export function shouldKeepPreviousTrackedItemInActiveDataset(
  evaluatedAt: UtcIsoDateTime,
  config: Config,
  item: Readonly<{ nodeId: GitHubNodeId; url: string }>,
  itemState: RetentionItemState,
): boolean {
  if (explicitIdentifierMatchesItem(config.tracking.include, item)) {
    return true;
  }
  const retention = determineTerminalRetention({
    item: itemState,
    evaluatedAt,
    retentionDays: config.tracking.retentionDaysAfterTerminal,
  });
  return retention.dataset === "active";
}

/** 前回追跡項目の再取得識別子を返す。 */
export function previousTrackedItemIdentifiers(
  context: CollectionPlanningContext,
  repository: PublicRepository,
): readonly string[] {
  const collectionItemsByNodeId = previousCollectionItemsByNodeId(context.previousState);
  const identifiers: string[] = [];
  for (const item of previousSnapshot(context.previousState)?.trackedItems ?? []) {
    if (item.repositoryId !== repository.id) {
      continue;
    }
    const collectionItem = collectionItemsByNodeId.get(item.nodeId);
    if (collectionItem == null) {
      throw new TypeError(`既存追跡項目の収集stateがありません。対象: ${item.nodeId}`);
    }
    const itemState = previousCollectionRetentionItemState(collectionItem);
    if (
      shouldKeepPreviousTrackedItemInActiveDataset(
        context.startedAt,
        context.config,
        item,
        itemState,
      )
    ) {
      identifiers.push(item.nodeId);
    }
  }
  return Object.freeze(identifiers);
}

/** 設定されたリポジトリのURL識別子を返す。 */
export function configuredUrlIdentifiersForRepository(
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

/** 未列挙の識別子を返す。 */
export function missingIdentifiers(
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

/** 追跡条件に必要な詳細取得対象を返す。 */
export function requiredTrackingDetailNodeIds(
  context: CollectionPlanningContext,
  repository: PublicRepository,
  enumeratedItems: readonly EnumeratedGitHubItem[],
): readonly GitHubNodeId[] {
  const backfill =
    context.executionPolicy.kind === "backfill" ? context.executionPolicy.backfillRange : undefined;
  const includesAllOpenBackfill =
    backfill?.kind === "all-open"
      ? backfill.repositories.length === 0 ||
        backfill.repositories.includes(`${repository.owner}/${repository.name}`)
      : false;
  const previouslyTrackedNodeIds = new Set(
    (previousSnapshot(context.previousState)?.trackedItems ?? []).map((item) => item.nodeId),
  );
  const previousItemsByNodeId = new Map(
    (previousSnapshot(context.previousState)?.trackedItems ?? []).map((item) => [
      item.nodeId,
      item,
    ]),
  );
  return Object.freeze(
    enumeratedItems
      .filter((item) => {
        if (!previouslyTrackedNodeIds.has(item.nodeId)) {
          return (
            explicitIdentifierMatchesItem(context.config.tracking.include, item) ||
            (includesAllOpenBackfill && item.state === "open")
          );
        }
        const previousItem = previousItemsByNodeId.get(item.nodeId);
        return staleAiAnalysisElementsForLifecycle(previousItem).length !== 0;
      })
      .map((item) => item.nodeId),
  );
}

/** 設定されたnode識別子を返す。 */
export function configuredNodeIdentifiers(config: Config): readonly string[] {
  return Object.freeze(config.tracking.include.filter((identifier) => !identifier.includes("://")));
}

/** 個人催促の詳細取得対象を返す。 */
export function personalReminderDetailNodeIdsForCollection(
  state: AnalysisPreviousState,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  aiEnabled: boolean,
  relationCandidateConsumerNodeIds: ReadonlySet<GitHubNodeId>,
): ReadonlySet<GitHubNodeId> {
  const snapshot = previousSnapshot(state);
  const previousItemsByNodeId = new Map(
    (snapshot?.trackedItems ?? []).map((item) => [item.nodeId, item]),
  );
  const previousEvidenceSourceIds = new Set([
    ...(snapshot?.trackedItems ?? []).flatMap((item) =>
      item.evidence.map((evidence) => evidence.sourceId),
    ),
    ...(snapshot?.relations ?? []).flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    ),
  ]);
  const missingCauseSourceIds = new Set(
    [...previousItemsByNodeId.values()]
      .flatMap((item) => item.personalReminderCauses)
      .flatMap(personalReminderCauseSourceIds)
      .filter((sourceId) => !previousEvidenceSourceIds.has(sourceId)),
  );
  const missingReviewRequestOwnerNodeIds = new Set<string>();
  const clockReconfirmationOwnerNodeIds = new Set<string>();
  const previousRelationsById = new Map(
    (snapshot?.relations ?? []).map((relation) => [relation.id, relation]),
  );
  for (const previous of previousItemsByNodeId.values()) {
    for (const cause of previous.personalReminderCauses) {
      if (
        personalReminderCauseNeedsClockReconfirmation(cause) ||
        [
          cause.obligationSince,
          ...(cause.actionableClock.status === "observed"
            ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
            : []),
        ].some((basis) => basis.source === "reconfirmed_observation")
      ) {
        const scope = personalReminderCauseScope(cause, previousRelationsById, [
          "previousSnapshot",
          "items",
          previous.nodeId,
          "personalReminderCauses",
          cause.causeId,
        ]);
        for (const nodeId of scope.nodeIds) clockReconfirmationOwnerNodeIds.add(nodeId);
      }
      if (
        !personalReminderCauseSourceIds(cause).some(
          (sourceId) =>
            missingCauseSourceIds.has(sourceId) &&
            parseSourceId(sourceId).kind === "github_review_request",
        )
      ) {
        continue;
      }
      const scope = personalReminderCauseScope(cause, previousRelationsById, [
        "previousSnapshot",
        "items",
        previous.nodeId,
        "personalReminderCauses",
        cause.causeId,
      ]);
      for (const nodeId of scope.nodeIds) missingReviewRequestOwnerNodeIds.add(nodeId);
    }
  }
  const potentialContinuityConflictNodeIds =
    determinePotentialPersonalReminderContinuityConflictNodeIds(
      [...previousItemsByNodeId.values()].flatMap((item) => item.personalReminderCauses),
    );
  const nodeIds = new Set<GitHubNodeId>();
  for (const item of enumeratedItems) {
    if (clockReconfirmationOwnerNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    if (item.type === "pull_request" && missingReviewRequestOwnerNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    const previous = previousItemsByNodeId.get(item.nodeId);
    if (previous == null) {
      continue;
    }
    if (potentialContinuityConflictNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    if (previous.personalReminderCauses.some(personalReminderCauseNeedsClockReconfirmation)) {
      nodeIds.add(item.nodeId);
    }
    if (relationCandidateConsumerNodeIds.has(item.nodeId)) {
      nodeIds.add(item.nodeId);
    }
    if (previous.inputEvents.some((event) => missingCauseSourceIds.has(event.sourceId))) {
      nodeIds.add(item.nodeId);
    }
    if (
      previous.personalReminderCausePlanning.status === "pending" ||
      previous.personalReminderCausePlanning.planningVersion !==
        PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
    ) {
      if (item.state === "open" || previous.personalReminderCauses.length !== 0) {
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

/** 個人催促の再計画対象を返す。 */
export function personalReminderReplanNodeIdsForCollection(
  state: AnalysisPreviousState,
  enumeratedItems: readonly EnumeratedGitHubItem[],
): ReadonlySet<GitHubNodeId> {
  const previousItemsByNodeId = new Map(
    (previousSnapshot(state)?.trackedItems ?? []).map((item) => [item.nodeId, item]),
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
    if (previous.personalReminderCauses.some(personalReminderCauseNeedsClockReconfirmation)) {
      nodeIds.add(item.nodeId);
    }
    if (item.state !== "open") {
      if (previous.personalReminderCauses.length !== 0) {
        nodeIds.add(item.nodeId);
      }
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

type RepositoryItemDetailPlan = Readonly<{
  collectionPlan: IncrementalItemCollectionPlan;
  detailNodeIds: ReadonlySet<GitHubNodeId>;
  personalReminderReplanNodeIds: ReadonlySet<GitHubNodeId>;
}>;

/** リポジトリ項目の増分詳細取得を計画する。 */
export function planRepositoryItemDetails(
  context: CollectionPlanningContext,
  repository: PublicRepository,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
  forcedDetailNodeIds: ReadonlySet<GitHubNodeId>,
): RepositoryItemDetailPlan {
  const identity = createAiAnalysisRunIdentity(context.config);
  const currentNodeIds = new Set(enumeratedItems.map((item) => item.nodeId));
  const previousAiAnalysisStatusesByNodeId = new Map(
    (previousSnapshot(context.previousState)?.trackedItems ?? []).map(
      (item) => [item.nodeId, item.aiAnalysis.status] as const,
    ),
  );
  const currentAnalysisPlanFingerprintsByNodeId = new Map(
    enumeratedItems.map((item) => [
      item.nodeId,
      analysisPlanFingerprintForItem(item, identity, context.digest),
    ]),
  );
  const plan = planIncrementalItemCollection({
    items: enumeratedItems,
    previous: previousItemCollection(context.previousState, repository),
    previousAiAnalysisStatusesByNodeId,
    currentAnalysisPlanFingerprintsByNodeId,
    adjacentItemNodeIds: new Set(
      [...adjacentNodeIds].filter((nodeId) => currentNodeIds.has(nodeId)),
    ),
  });
  const personalReminderDetailNodeIds = personalReminderDetailNodeIdsForCollection(
    context.previousState,
    enumeratedItems,
    context.config.ai.enabled,
    context.references.personalReminderRelationCandidateConsumerNodeIds,
  );
  const personalReminderReplanNodeIds = personalReminderReplanNodeIdsForCollection(
    context.previousState,
    enumeratedItems,
  );
  const detailNodeIds = new Set([
    ...plan.detailItemNodeIds,
    ...requiredTrackingDetailNodeIds(context, repository, enumeratedItems),
    ...personalReminderDetailNodeIds,
    ...context.references.staleBlockerTopologyNodeIds,
    ...forcedDetailNodeIds,
  ]);
  return Object.freeze({
    collectionPlan: plan,
    detailNodeIds,
    personalReminderReplanNodeIds,
  });
}

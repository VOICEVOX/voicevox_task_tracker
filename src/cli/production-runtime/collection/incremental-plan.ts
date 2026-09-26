import type { Config } from "../../../config/index.js";
import {
  currentPersonalReminderAssessment,
  determinePotentialPersonalReminderContinuityConflictNodeIds,
  determineTerminalRetention,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type GitHubNodeId,
  type RetentionItemState,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import {
  planIncrementalItemCollection,
  type EnumeratedGitHubItem,
  type IncrementalItemCollectionPlan,
  type PublicRepository,
} from "../../../github/index.js";
import type { SnapshotCollectionItem } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { createTrackingBackfillRequest } from "../../backfill.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import {
  analysisPlanFingerprintForItem,
  createAiAnalysisRunIdentity,
} from "../analysis-identity.js";
import type { RuntimeConfiguration, RuntimeState } from "../contracts.js";
import {
  previousCollectionItemsByNodeId,
  previousItemCollection,
} from "../previous-state/collection.js";
import {
  previousPersonalReminderRelationCandidateConsumerNodeIds,
  previousStaleRepositoryBlockerTopologyNodeIds,
  staleAiAnalysisElementsForLifecycle,
} from "../previous-state/analysis.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { repositoryFullName } from "../repository-lookup.js";

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

function previousCollectionRetentionItemState(item: SnapshotCollectionItem): RetentionItemState {
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

/** 前回追跡項目の再取得識別子を返す。 */
export function previousTrackedItemIdentifiers(
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

/** 設定されたnode識別子を返す。 */
export function configuredNodeIdentifiers(config: Config): readonly string[] {
  return Object.freeze(config.tracking.include.filter((identifier) => !identifier.includes("://")));
}

/** 個人催促の詳細取得対象を返す。 */
export function personalReminderDetailNodeIdsForCollection(
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
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  repository: PublicRepository,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
  forcedDetailNodeIds: ReadonlySet<GitHubNodeId>,
): RepositoryItemDetailPlan {
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
  return Object.freeze({
    collectionPlan: plan,
    detailNodeIds,
    personalReminderReplanNodeIds,
  });
}

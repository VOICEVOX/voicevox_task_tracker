import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
} from "../../../domain/ai-analysis-elements.js";
import {
  createGitHubBotPredicate,
  type GitHubNodeId,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import {
  createPublicRepositoryAllowlist,
  deduplicateByStableId,
  normalizeObservedGitHubItems,
  type EnumeratedGitHubItem,
  type FreshObservedGitHubItem,
  type GitHubClient,
  type GitHubItemDetail,
  type PublicRepository,
} from "../../../github/index.js";
import type {
  SnapshotAnalysisPlanFingerprint,
  SnapshotCollectionItem,
  SnapshotCollectionRepository,
} from "../../../persistence/index.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import type { CollectionRuntimeAdapters } from "../adapters.js";
import type { RuntimeConfiguration, RuntimeState } from "../contracts.js";
import {
  configuredUrlIdentifiersForRepository,
  missingIdentifiers,
  planRepositoryItemDetails,
  previousTrackedItemIdentifiers,
} from "./incremental-plan.js";

export type FreshRepositoryItemCollection = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  changedNodeIds: readonly GitHubNodeId[];
  analysisPlanChangedNodeIds: readonly GitHubNodeId[];
  personalReminderReplanNodeIds: ReadonlySet<GitHubNodeId>;
}>;

export type FreshRepositoryRuntimeCollection = FreshRepositoryItemCollection &
  Readonly<{
    state: SnapshotCollectionRepository;
  }>;

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

/** リポジトリ収集結果へ追加取得分を統合する。 */
export function mergeFreshRepositoryRuntimeCollection(
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

/** 列挙項目の詳細と観測値を収集する。 */
export async function collectFreshRepositoryItemObservations(
  adapters: CollectionRuntimeAdapters,
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
  const detailPlan = planRepositoryItemDetails(
    invocation,
    configuration,
    state,
    repository,
    enumeratedItems,
    adjacentNodeIds,
    forcedDetailNodeIds,
  );
  const detailItems = enumeratedItems.filter((item) => detailPlan.detailNodeIds.has(item.nodeId));
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
    changedNodeIds: detailPlan.collectionPlan.changedItemNodeIds,
    analysisPlanChangedNodeIds: detailPlan.collectionPlan.analysisPlanChangedItemNodeIds,
    personalReminderReplanNodeIds: detailPlan.personalReminderReplanNodeIds,
  });
}

/** リポジトリの項目を収集する。 */
export async function collectFreshRepositoryItems(
  adapters: CollectionRuntimeAdapters,
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

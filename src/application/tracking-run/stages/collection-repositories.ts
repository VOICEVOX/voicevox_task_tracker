import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
} from "../../../domain/ai-analysis-elements.js";
import { createGitHubBotPredicate } from "../../../domain/actor-resolution.js";
import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/types.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import { deduplicateByStableId } from "../../../github/stable-id.js";
import type {
  PreviousCollectionItem,
  PreviousCollectionRepository,
} from "../contracts/previous-state.js";
import type { InventoryCollectedRun } from "./inventory.js";
import type { CollectionGitHubReadPort } from "../ports.js";
import { collectRepositoryValues, type RepositoryCollectionResult } from "./collection-stale.js";
import {
  configuredNodeIdentifiers,
  configuredUrlIdentifiersForRepository,
  missingIdentifiers,
  planRepositoryItemDetails,
  previousTrackedItemIdentifiers,
  type CollectionPlanningContext,
} from "./collection-incremental-plan.js";

/** 最新取得できたリポジトリ項目と再解析対象。 */
export type FreshRepositoryItemCollection = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  changedNodeIds: readonly GitHubNodeId[];
  analysisPlanChangedNodeIds: readonly GitHubNodeId[];
  personalReminderReplanNodeIds: ReadonlySet<GitHubNodeId>;
}>;

/** 最新取得できたリポジトリの保存用値。 */
export type FreshRepositoryRuntimeCollection = FreshRepositoryItemCollection &
  Readonly<{ state: PreviousCollectionRepository }>;

/** 初期収集後に関係閉包へ渡すリポジトリ別結果。 */
export type InitialRepositoryCollection = Readonly<{
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>;
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<PreviousCollectionRepository>
  >;
}>;

function createSnapshotCollectionItem(
  item: EnumeratedGitHubItem,
  analysisPlanFingerprint: PreviousCollectionItem["analysisPlanFingerprint"],
): PreviousCollectionItem {
  const applications = Object.freeze(
    aiAnalysisElementApplicationsSchema.parse(
      Object.fromEntries(
        AI_ANALYSIS_ELEMENTS.map((element) => [
          element,
          Object.freeze({ status: "unknown", reason: "not_recorded" }),
        ]),
      ),
    ),
  );
  const common = {
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
      retainedElements: Object.freeze({}),
      applications,
    }),
    observedAt: item.observedAt,
  } satisfies Omit<PreviousCollectionItem, "state" | "terminalAt">;
  if (item.state === "open") {
    return Object.freeze({ ...common, state: "open", terminalAt: null });
  }
  return Object.freeze({ ...common, state: "closed", terminalAt: item.closedAt });
}

function createSnapshotCollectionRepository(
  repository: PublicRepository,
  context: CollectionPlanningContext,
  items: readonly EnumeratedGitHubItem[],
): PreviousCollectionRepository {
  return Object.freeze({
    repositoryId: repository.id,
    successfulAt: context.startedAt,
    items: Object.freeze(
      items.map((item) =>
        createSnapshotCollectionItem(item, { status: "unplanned", reason: "detail_required" }),
      ),
    ),
  });
}

/** リポジトリ収集結果へ関係先の追加取得分を統合する。 */
export function mergeFreshRepositoryRuntimeCollection(
  repository: PublicRepository,
  context: CollectionPlanningContext,
  current: FreshRepositoryRuntimeCollection,
  additions: FreshRepositoryItemCollection,
): FreshRepositoryRuntimeCollection {
  const enumeratedItems = deduplicateByStableId(
    [...current.enumeratedItems, ...additions.enumeratedItems],
    (item) => item.nodeId,
  );
  const details = deduplicateByStableId(
    [...current.details, ...additions.details],
    (detail) => detail.nodeId,
  );
  const observedItems = deduplicateByStableId(
    [...current.observedItems, ...additions.observedItems],
    (item) => item.nodeId,
  );
  return Object.freeze({
    state: createSnapshotCollectionRepository(repository, context, enumeratedItems),
    enumeratedItems,
    details,
    observedItems,
    changedNodeIds: Object.freeze([
      ...new Set([...current.changedNodeIds, ...additions.changedNodeIds]),
    ]),
    analysisPlanChangedNodeIds: Object.freeze([
      ...new Set([...current.analysisPlanChangedNodeIds, ...additions.analysisPlanChangedNodeIds]),
    ]),
    personalReminderReplanNodeIds: new Set([
      ...current.personalReminderReplanNodeIds,
      ...additions.personalReminderReplanNodeIds,
    ]),
  });
}

/** 列挙項目の詳細と正規化済み観測値を収集する。 */
export async function collectRepositoryItemObservations(
  read: CollectionGitHubReadPort,
  context: CollectionPlanningContext,
  repository: PublicRepository,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  adjacentNodeIds: ReadonlySet<GitHubNodeId>,
  forcedDetailNodeIds: ReadonlySet<GitHubNodeId>,
): Promise<FreshRepositoryItemCollection> {
  const detailPlan = planRepositoryItemDetails(
    context,
    repository,
    enumeratedItems,
    adjacentNodeIds,
    forcedDetailNodeIds,
  );
  const detailItems = enumeratedItems.filter((item) => detailPlan.detailNodeIds.has(item.nodeId));
  const result =
    detailItems.length === 0
      ? Object.freeze({ details: Object.freeze([]), observedItems: Object.freeze([]) })
      : await read.collectDetails(
          Object.freeze(detailItems.map((item) => Object.freeze({ item }))),
          context.startedAt,
          createGitHubBotPredicate(context.config.actors.bots),
        );
  return Object.freeze({
    enumeratedItems: Object.freeze([...enumeratedItems]),
    details: result.details,
    observedItems: result.observedItems,
    changedNodeIds: detailPlan.collectionPlan.changedItemNodeIds,
    analysisPlanChangedNodeIds: detailPlan.collectionPlan.analysisPlanChangedItemNodeIds,
    personalReminderReplanNodeIds: detailPlan.personalReminderReplanNodeIds,
  });
}

async function collectFreshRepository(
  read: CollectionGitHubReadPort,
  context: CollectionPlanningContext,
  repository: PublicRepository,
  explicitNodeItems: readonly EnumeratedGitHubItem[],
): Promise<FreshRepositoryRuntimeCollection> {
  const openItems = await read.enumerateOpen(Object.freeze([repository]), context.startedAt);
  const resolvedNodeItems = explicitNodeItems.filter((item) => item.repositoryId === repository.id);
  const identifiers = missingIdentifiers(
    [
      ...configuredUrlIdentifiersForRepository(context.config, repository),
      ...previousTrackedItemIdentifiers(context, repository),
    ],
    [...openItems, ...resolvedNodeItems],
  );
  const individuallyEnumeratedItems =
    identifiers.length === 0
      ? Object.freeze([])
      : await read.enumerateByIdentifiers(identifiers, context.startedAt);
  const enumeratedItems = deduplicateByStableId(
    [...openItems, ...resolvedNodeItems, ...individuallyEnumeratedItems],
    (item) => item.nodeId,
  );
  const itemCollection = await collectRepositoryItemObservations(
    read,
    context,
    repository,
    enumeratedItems,
    context.references.adjacentNodeIds,
    new Set<GitHubNodeId>(),
  );
  return Object.freeze({
    state: createSnapshotCollectionRepository(repository, context, enumeratedItems),
    ...itemCollection,
  });
}

/** 公開リポジトリごとに増分収集し、503時だけ前回値を保持する。 */
export async function collectInitialRepositoryItems(
  inventory: InventoryCollectedRun,
  read: CollectionGitHubReadPort,
  context: CollectionPlanningContext,
): Promise<InitialRepositoryCollection> {
  const nodeIdentifiers = configuredNodeIdentifiers(context.config);
  const explicitNodeItems =
    nodeIdentifiers.length === 0
      ? Object.freeze([])
      : await read.enumerateByIdentifiers(nodeIdentifiers, context.startedAt);
  const previousRepositories =
    context.previousState.snapshot.status === "available"
      ? context.previousState.snapshot.collectionRepositories
      : Object.freeze([]);
  const previousValues = new Map(
    previousRepositories.map((repository) => [
      repository.repositoryId,
      Object.freeze({ value: repository, observedAt: repository.successfulAt }),
    ]),
  );
  const freshCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const results = await collectRepositoryValues({
    repositories: inventory.data.allowlist.repositories,
    observedAt: context.startedAt,
    previousValues,
    collect: async (repository) => {
      const collected = await collectFreshRepository(read, context, repository, explicitNodeItems);
      freshCollectionsByRepositoryId.set(repository.id, collected);
      return collected.state;
    },
  });
  return Object.freeze({
    freshCollectionsByRepositoryId,
    repositoryResultsById: new Map(results.map((result) => [result.repository.id, result])),
  });
}

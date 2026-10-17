import type { Config } from "../../../config/schema.js";
import type { CollectionGitHubReadPort, DelayPort } from "../ports.js";
import type { CollectionPlanningContext } from "./collection-incremental-plan.js";
import type { RepositoryCollectionResult } from "./collection-stale.js";
import {
  collectRepositoryItemObservations,
  mergeFreshRepositoryRuntimeCollection,
  type FreshRepositoryRuntimeCollection,
} from "./collection-repositories.js";
import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/types.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import {
  RelationReferenceConflictError,
  type PublicGitHubRelationItem,
  type RelationCandidate,
} from "../../../graph/index.js";
import type { PreviousCollectionRepository } from "../contracts/previous-state.js";
import {
  aggregateFreshRepositoryCollections,
  createPublicRelationItem,
  extractRelationCandidatesOnce,
  type FreshRuntimeCollectionAggregate,
} from "./collection-relation-candidates.js";

type RelationReferenceRefreshTarget = Readonly<{
  repository: PublicRepository;
  expected: PublicGitHubRelationItem;
}>;

export interface RelationReferenceRetryBudget {
  readonly maxRefreshes: number;
  refreshes: number;
}

type ExtractedRelationCandidates = Readonly<{
  candidates: readonly RelationCandidate[];
  aggregate: FreshRuntimeCollectionAggregate;
}>;

function findRelationReferenceRepository(
  allowlist: readonly PublicRepository[],
  reference: PublicGitHubRelationItem,
): PublicRepository | undefined {
  return allowlist.find(
    (repository) =>
      repository.owner.toLowerCase() === reference.repositoryOwner.toLowerCase() &&
      repository.name.toLowerCase() === reference.repositoryName.toLowerCase(),
  );
}

function requireRepository(
  repositories: readonly PublicRepository[],
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  const repository = repositories.find((item) => item.id === repositoryId);
  if (repository == null) {
    throw new TypeError(`公開repositoryがありません。対象: ${repositoryId}`);
  }
  return repository;
}

function detailReferencesRelationNode(detail: GitHubItemDetail, nodeId: GitHubNodeId): boolean {
  if (detail.inboundCrossReferences.some((reference) => reference.sourceItem.nodeId === nodeId)) {
    return true;
  }
  if (detail.type === "issue") {
    if (
      detail.nativeDependencies.availability === "available" &&
      detail.nativeDependencies.relations.some((relation) => relation.relatedItem.nodeId === nodeId)
    ) {
      return true;
    }
    return (
      detail.nativeHierarchy.availability === "available" &&
      detail.nativeHierarchy.relations.some((relation) => relation.relatedItem.nodeId === nodeId)
    );
  }
  return detail.nativeClosingIssues.some((relation) => relation.relatedItem.nodeId === nodeId);
}

function relationReferenceRefreshTargets(
  aggregate: FreshRuntimeCollectionAggregate,
  error: RelationReferenceConflictError,
  allowlist: readonly PublicRepository[],
): readonly RelationReferenceRefreshTarget[] {
  const nodeIds = new Set<GitHubNodeId>([error.existing.nodeId]);
  for (const detail of aggregate.details) {
    if (detailReferencesRelationNode(detail, error.existing.nodeId)) {
      nodeIds.add(detail.nodeId);
    }
  }
  const enumeratedItemsByNodeId = new Map(
    aggregate.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const targets: RelationReferenceRefreshTarget[] = [];
  for (const nodeId of nodeIds) {
    if (nodeId === error.existing.nodeId) {
      const repository = findRelationReferenceRepository(allowlist, error.existing);
      if (repository == null) {
        throw error;
      }
      targets.push(Object.freeze({ repository, expected: error.existing }));
      continue;
    }
    const enumeratedItem = enumeratedItemsByNodeId.get(nodeId);
    if (enumeratedItem == null) {
      throw new TypeError("関係参照競合の親詳細に対応する列挙項目がありません", { cause: error });
    }
    if (!allowlist.some((repository) => repository.id === enumeratedItem.repositoryId)) {
      throw error;
    }
    const repository = requireRepository(allowlist, enumeratedItem.repositoryId);
    targets.push(
      Object.freeze({
        repository,
        expected: createPublicRelationItem(enumeratedItem, repository),
      }),
    );
  }
  return Object.freeze(targets);
}

function validateRelationReferenceRefresh(
  repository: PublicRepository,
  expected: PublicGitHubRelationItem,
  item: EnumeratedGitHubItem,
  cause: RelationReferenceConflictError,
): EnumeratedGitHubItem {
  if (
    expected.repositoryOwner.toLowerCase() !== repository.owner.toLowerCase() ||
    expected.repositoryName.toLowerCase() !== repository.name.toLowerCase() ||
    expected.repositoryArchived !== repository.archived ||
    expected.repositoryDisabled !== repository.disabled ||
    item.repositoryId !== repository.id ||
    item.nodeId !== expected.nodeId ||
    item.type !== expected.type ||
    item.number !== expected.number ||
    item.url !== expected.url
  ) {
    throw new TypeError(
      `関係参照競合の再取得結果が要求項目と一致しません。対象: ${expected.nodeId}`,
      { cause },
    );
  }
  return item;
}

async function refreshRelationReferences(
  read: CollectionGitHubReadPort,
  context: CollectionPlanningContext,
  targets: readonly RelationReferenceRefreshTarget[],
  error: RelationReferenceConflictError,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<PreviousCollectionRepository>
  >,
): Promise<void> {
  const targetsByRepositoryId = new Map<
    GitHubRepositoryId,
    Readonly<{
      repository: PublicRepository;
      targets: readonly RelationReferenceRefreshTarget[];
    }>
  >();
  for (const target of targets) {
    const current = targetsByRepositoryId.get(target.repository.id);
    if (current == null) {
      targetsByRepositoryId.set(target.repository.id, {
        repository: target.repository,
        targets: [target],
      });
      continue;
    }
    targetsByRepositoryId.set(target.repository.id, {
      repository: current.repository,
      targets: [...current.targets, target],
    });
  }
  for (const { repository, targets: repositoryTargets } of targetsByRepositoryId.values()) {
    const identifiers = repositoryTargets.map((target) => target.expected.url);
    if (new Set(identifiers).size !== identifiers.length) {
      throw new TypeError("関係参照競合の再取得対象URLが重複しています", { cause: error });
    }
    const items = await read.enumerateByIdentifiers(identifiers, context.startedAt);
    if (items.length !== repositoryTargets.length) {
      throw new TypeError("関係参照競合の再取得結果件数が不正です", { cause: error });
    }
    const expectedByNodeId = new Map(
      repositoryTargets.map((target) => [target.expected.nodeId, target.expected]),
    );
    const refreshedByNodeId = new Map<GitHubNodeId, EnumeratedGitHubItem>();
    for (const item of items) {
      if (!expectedByNodeId.has(item.nodeId) || refreshedByNodeId.has(item.nodeId)) {
        throw new TypeError("関係参照競合の再取得結果が要求項目と一致しません", { cause: error });
      }
      refreshedByNodeId.set(item.nodeId, item);
    }
    const refreshedItems = repositoryTargets.map((target) => {
      const item = refreshedByNodeId.get(target.expected.nodeId);
      if (item == null) {
        throw new TypeError("関係参照競合の再取得結果が不足しています", { cause: error });
      }
      return validateRelationReferenceRefresh(repository, target.expected, item, error);
    });
    const current = freshCollectionsByRepositoryId.get(repository.id);
    if (current == null) {
      throw new TypeError("関係参照競合の再取得対象repository収集結果がありません", {
        cause: error,
      });
    }
    const additions = await collectRepositoryItemObservations(
      read,
      context,
      repository,
      refreshedItems,
      new Set(refreshedItems.map((item) => item.nodeId)),
      new Set(refreshedItems.map((item) => item.nodeId)),
    );
    const refreshedCollection = mergeFreshRepositoryRuntimeCollection(
      repository,
      context,
      current,
      additions,
    );
    freshCollectionsByRepositoryId.set(repository.id, refreshedCollection);
    const repositoryResult = repositoryResultsById.get(repository.id);
    if (repositoryResult == null || repositoryResult.freshness === "stale") {
      throw new TypeError("関係参照競合の再取得対象repository結果がfreshではありません", {
        cause: error,
      });
    }
    repositoryResultsById.set(
      repository.id,
      Object.freeze({
        freshness: "fresh",
        repository,
        value: refreshedCollection.state,
        observedAt: context.startedAt,
      }),
    );
  }
}

function calculateRetryDelayMilliseconds(
  retryNumber: number,
  settings: Config["operations"]["retry"],
): number {
  if (!Number.isSafeInteger(retryNumber) || retryNumber < 1) {
    throw new TypeError("retry番号には1以上の安全な整数を指定してください");
  }
  return Math.min(
    settings.maxDelaySeconds * 1000,
    settings.initialDelaySeconds * 1000 * 2 ** (retryNumber - 1),
  );
}

/** 関係参照競合を限定的に再取得して候補を抽出する。 */
export async function extractAllRelationCandidates(
  read: CollectionGitHubReadPort,
  delay: DelayPort,
  context: CollectionPlanningContext,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<PreviousCollectionRepository>
  >,
  allowlist: readonly PublicRepository[],
  retryBudget: RelationReferenceRetryBudget,
): Promise<ExtractedRelationCandidates> {
  for (;;) {
    const aggregate = aggregateFreshRepositoryCollections(
      allowlist,
      freshCollectionsByRepositoryId,
    );
    try {
      return Object.freeze({
        candidates: extractRelationCandidatesOnce(
          context.config,
          allowlist,
          aggregate.enumeratedItems,
          aggregate.details,
        ),
        aggregate,
      });
    } catch (error: unknown) {
      if (!(error instanceof RelationReferenceConflictError) || !error.isStateOnlyConflict) {
        throw error;
      }
      if (retryBudget.refreshes >= retryBudget.maxRefreshes) {
        throw error;
      }
      const targets = relationReferenceRefreshTargets(aggregate, error, allowlist);
      const retryNumber = retryBudget.refreshes + 1;
      await delay.sleep(
        calculateRetryDelayMilliseconds(retryNumber, context.config.operations.retry),
      );
      retryBudget.refreshes = retryNumber;
      await refreshRelationReferences(
        read,
        context,
        targets,
        error,
        freshCollectionsByRepositoryId,
        repositoryResultsById,
      );
    }
  }
}

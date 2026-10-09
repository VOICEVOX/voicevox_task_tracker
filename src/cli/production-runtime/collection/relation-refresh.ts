import type { Config } from "../../../config/index.js";
import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/index.js";
import {
  createPublicRepositoryAllowlist,
  type EnumeratedGitHubItem,
  type GitHubClient,
  type GitHubItemDetail,
  type PublicRepository,
  type PublicRepositoryAllowlist,
  type RepositoryCollectionResult,
} from "../../../github/index.js";
import {
  RelationReferenceConflictError,
  type PublicGitHubRelationItem,
  type RelationCandidate,
} from "../../../graph/index.js";
import type { SnapshotCollectionRepository } from "../../../persistence/index.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import type { CollectionRuntimeAdapters } from "../adapters.js";
import type { RuntimeConfiguration, RuntimeState } from "../contracts.js";
import {
  aggregateFreshRepositoryCollections,
  createPublicRelationItem,
  extractRelationCandidatesOnce,
  type FreshRuntimeCollectionAggregate,
} from "./relation-candidates.js";
import {
  collectFreshRepositoryItemObservations,
  mergeFreshRepositoryRuntimeCollection,
  type FreshRepositoryRuntimeCollection,
} from "./repository-collection.js";

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
  allowlist: PublicRepositoryAllowlist,
  reference: PublicGitHubRelationItem,
): PublicRepository | undefined {
  return allowlist.repositories.find(
    (repository) =>
      repository.owner.toLowerCase() === reference.repositoryOwner.toLowerCase() &&
      repository.name.toLowerCase() === reference.repositoryName.toLowerCase(),
  );
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
  allowlist: PublicRepositoryAllowlist,
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
    if (!allowlist.has(enumeratedItem.repositoryId)) {
      throw error;
    }
    const repository = allowlist.require(enumeratedItem.repositoryId);
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
  adapters: CollectionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  targets: readonly RelationReferenceRefreshTarget[],
  error: RelationReferenceConflictError,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
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
    const items = await adapters.enumerateGitHubItemsByIdentifiers({
      allowlist: createPublicRepositoryAllowlist([repository]),
      identifiers,
      observedAt: invocation.startedAt,
      request: authentication.request,
      graphql: authentication.graphql,
    });
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
    const additions = await collectFreshRepositoryItemObservations(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repository,
      refreshedItems,
      new Set(refreshedItems.map((item) => item.nodeId)),
      new Set(refreshedItems.map((item) => item.nodeId)),
    );
    const refreshedCollection = mergeFreshRepositoryRuntimeCollection(
      repository,
      invocation,
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
        observedAt: invocation.startedAt,
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
  adapters: CollectionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
  config: Config,
  allowlist: PublicRepositoryAllowlist,
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
          config,
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
      await adapters.sleep(
        calculateRetryDelayMilliseconds(retryNumber, configuration.config.operations.retry),
      );
      retryBudget.refreshes = retryNumber;
      await refreshRelationReferences(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        targets,
        error,
        freshCollectionsByRepositoryId,
        repositoryResultsById,
      );
    }
  }
}

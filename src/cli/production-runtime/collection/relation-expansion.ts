import type { GitHubNodeId, GitHubRepositoryId, UtcIsoDateTime } from "../../../domain/index.js";
import {
  collectRepositoriesWithStaleFallback,
  createPublicRepositoryAllowlist,
  type EnumeratedGitHubItem,
  type GitHubClient,
  type PublicRepository,
  type PublicRepositoryAllowlist,
  type RepositoryCollectionResult,
} from "../../../github/index.js";
import { planRelationExpansion, type RelationCandidate } from "../../../graph/index.js";
import type { SnapshotCollectionRepository } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import { CliRelationExpansionLimitError } from "../../errors.js";
import type { CollectionRuntimeAdapters } from "../adapters.js";
import { currentRuntimeTime } from "../clock.js";
import type { RepositoryInventory, RuntimeConfiguration, RuntimeState } from "../contracts.js";
import { previousRepositoryValues } from "../previous-state/collection.js";
import {
  collectedTrackingCandidateNodeIds,
  completeRelationCandidates,
  staleTrackedNodeIdsForRelationExpansion,
  type FreshRuntimeCollectionAggregate,
} from "./relation-candidates.js";
import {
  relationExpansionRepositoriesByNodeId,
  personalReminderRelationExpansionRepositoriesByNodeId,
  changedTrackedImplementationTargetNodeIds,
  trackedPotentialBlockerTargetNodeIds,
} from "./relation-expansion-targets.js";
import {
  extractAllRelationCandidates,
  type RelationReferenceRetryBudget,
} from "./relation-refresh.js";
import {
  collectFreshRepositoryItemObservations,
  mergeFreshRepositoryRuntimeCollection,
  type FreshRepositoryRuntimeCollection,
} from "./repository-collection.js";
import {
  collectTrackingCandidates,
  relationExpansionTrackingState,
  type RuntimeTrackingSelection,
} from "./tracking-selection.js";

type RelationExpandedRuntimeCollection = FreshRuntimeCollectionAggregate &
  Readonly<{
    evaluatedAt: UtcIsoDateTime;
    relationCandidates: readonly RelationCandidate[];
    blockerTopologyRelationCandidates: readonly RelationCandidate[];
    droppedRelationCandidateCount: number;
    tracking: RuntimeTrackingSelection;
  }>;

function validateRelationExpansionEnumeration(
  repository: PublicRepository,
  requestedNodeIds: readonly GitHubNodeId[],
  enumeratedItems: readonly EnumeratedGitHubItem[],
): void {
  const requestedNodeIdSet = new Set(requestedNodeIds);
  if (
    requestedNodeIdSet.size !== requestedNodeIds.length ||
    enumeratedItems.length !== requestedNodeIds.length
  ) {
    throw new TypeError("関係先の個別列挙結果と要求node IDの件数が一致しません");
  }
  for (const item of enumeratedItems) {
    if (item.repositoryId !== repository.id || !requestedNodeIdSet.has(item.nodeId)) {
      throw new TypeError("関係先の個別列挙結果が要求したrepositoryとnode IDに一致しません");
    }
  }
}

/** 関係先の追加項目を収集する。 */
async function collectAdditionalRelationItems(
  adapters: CollectionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repository: PublicRepository,
  requestedNodeIds: readonly GitHubNodeId[],
  current: FreshRepositoryRuntimeCollection,
): Promise<FreshRepositoryRuntimeCollection> {
  const currentItemsByNodeId = new Map(current.enumeratedItems.map((item) => [item.nodeId, item]));
  const missingNodeIds = requestedNodeIds.filter((nodeId) => !currentItemsByNodeId.has(nodeId));
  const individuallyEnumeratedItems =
    missingNodeIds.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist: createPublicRepositoryAllowlist([repository]),
          identifiers: missingNodeIds,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  validateRelationExpansionEnumeration(repository, missingNodeIds, individuallyEnumeratedItems);
  const individuallyEnumeratedItemsByNodeId = new Map(
    individuallyEnumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailTargets = requestedNodeIds.map((nodeId) => {
    const item =
      currentItemsByNodeId.get(nodeId) ?? individuallyEnumeratedItemsByNodeId.get(nodeId);
    assertNonNullable(item, `関係先追加取得対象の列挙値がありません。対象: ${nodeId}`);
    return item;
  });
  validateRelationExpansionEnumeration(repository, requestedNodeIds, detailTargets);
  const additions = await collectFreshRepositoryItemObservations(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repository,
    detailTargets,
    new Set(requestedNodeIds),
    new Set(requestedNodeIds),
  );
  return mergeFreshRepositoryRuntimeCollection(repository, invocation, current, additions);
}

async function collectRelationExpansionBatch(
  adapters: CollectionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  allowlist: PublicRepositoryAllowlist,
  targetNodeIdsByRepositoryId: ReadonlyMap<GitHubRepositoryId, readonly GitHubNodeId[]>,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<void> {
  const targetRepositories = allowlist.repositories.filter((repository) =>
    targetNodeIdsByRepositoryId.has(repository.id),
  );
  const expandedCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const results = await collectRepositoriesWithStaleFallback({
    allowlist: createPublicRepositoryAllowlist(targetRepositories),
    observedAt: invocation.startedAt,
    previousValues: previousRepositoryValues(state),
    collect: async (repository) => {
      const requestedNodeIds = targetNodeIdsByRepositoryId.get(repository.id);
      assertNonNullable(requestedNodeIds, "関係先追加取得対象のnode IDがありません");
      const current = freshCollectionsByRepositoryId.get(repository.id);
      assertNonNullable(current, "関係先追加取得対象の最新repository収集結果がありません");
      const expanded = await collectAdditionalRelationItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        requestedNodeIds,
        current,
      );
      expandedCollectionsByRepositoryId.set(repository.id, expanded);
      return expanded.state;
    },
  });
  for (const result of results) {
    repositoryResultsById.set(result.repository.id, result);
    if (result.freshness === "stale") {
      freshCollectionsByRepositoryId.delete(result.repository.id);
      continue;
    }
    const expanded = expandedCollectionsByRepositoryId.get(result.repository.id);
    assertNonNullable(expanded, "関係先追加後の最新repository収集結果がありません");
    freshCollectionsByRepositoryId.set(result.repository.id, expanded);
  }
}

/** 関係先を追加取得して収集結果を展開する。 */
export async function collectRelationExpandedItems(
  adapters: CollectionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repositoryInventory: RepositoryInventory,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<SnapshotCollectionRepository>
  >,
): Promise<RelationExpandedRuntimeCollection> {
  const requestedNodeIds = new Set<GitHubNodeId>();
  const expandedNodeIds = new Set<GitHubNodeId>();
  const relationReferenceRetryBudget: RelationReferenceRetryBudget = {
    maxRefreshes: Math.min(2, configuration.config.operations.retry.maxAttempts - 1),
    refreshes: 0,
  };
  for (;;) {
    const extractedRelations = await extractAllRelationCandidates(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      freshCollectionsByRepositoryId,
      repositoryResultsById,
      configuration.config,
      repositoryInventory.allowlist,
      relationReferenceRetryBudget,
    );
    const discoveredRelationCandidates = extractedRelations.candidates;
    const refreshedAggregate = extractedRelations.aggregate;
    const collectedCandidateNodeIds = collectedTrackingCandidateNodeIds(state, refreshedAggregate);
    const staleTrackedNodeIds = staleTrackedNodeIdsForRelationExpansion(
      state,
      repositoryResultsById,
    );
    const completedTrackingRelationCandidates = completeRelationCandidates(
      discoveredRelationCandidates,
      collectedCandidateNodeIds,
      new Set<GitHubNodeId>(),
    );
    const completedRelationCandidates = completeRelationCandidates(
      discoveredRelationCandidates,
      collectedCandidateNodeIds,
      staleTrackedNodeIds,
    );
    const evaluatedAt = currentRuntimeTime(adapters);
    const tracking = collectTrackingCandidates(
      invocation,
      evaluatedAt,
      configuration,
      state,
      repositoryInventory,
      refreshedAggregate.enumeratedItems,
      refreshedAggregate.observedItems,
      completedTrackingRelationCandidates.candidates,
    );
    const trackingState = relationExpansionTrackingState(tracking);
    const plannedRequests = planRelationExpansion({
      collectedCandidateNodeIds,
      trackingRootNodeIds: trackingState.trackingRootNodeIds,
      relationCandidates: discoveredRelationCandidates,
      nativeDepthByNodeId: trackingState.nativeDepthByNodeId,
      requestedNodeIds,
      maximumNativeDepth: configuration.config.tracking.autoInclude.nativeRelations
        ? configuration.config.tracking.autoInclude.relationDepth
        : 0,
    });
    const repositoriesByNodeId = new Map(
      relationExpansionRepositoriesByNodeId(
        discoveredRelationCandidates,
        repositoryInventory.allowlist,
      ),
    );
    const observedNodeIds = new Set<string>(
      refreshedAggregate.observedItems.map((item) => item.nodeId),
    );
    const personalReminderSeedRepositoriesByNodeId =
      personalReminderRelationExpansionRepositoriesByNodeId(
        state,
        refreshedAggregate,
        tracking,
        discoveredRelationCandidates,
        repositoryInventory.allowlist,
      );
    const effectiveAssigneeTargetNodeIds = changedTrackedImplementationTargetNodeIds(
      refreshedAggregate,
      tracking,
      discoveredRelationCandidates,
      requestedNodeIds,
    );
    const potentialBlockerTargetNodeIds = trackedPotentialBlockerTargetNodeIds(
      refreshedAggregate,
      tracking,
      discoveredRelationCandidates,
      requestedNodeIds,
    );
    const requestsByNodeId = new Map(plannedRequests.map((request) => [request.nodeId, request]));
    for (const nodeId of [...effectiveAssigneeTargetNodeIds, ...potentialBlockerTargetNodeIds]) {
      if (requestsByNodeId.has(nodeId)) {
        continue;
      }
      requestsByNodeId.set(
        nodeId,
        Object.freeze({
          nodeId,
          nativeDepth: 0,
        }),
      );
    }
    for (const [nodeId, repository] of personalReminderSeedRepositoriesByNodeId) {
      const existingRequest = requestsByNodeId.get(nodeId);
      const existingRepository = repositoriesByNodeId.get(nodeId);
      if (existingRepository != null && existingRepository.id !== repository.id) {
        throw new TypeError("関係先追加取得対象の同じnode IDに異なるrepositoryが指定されています");
      }
      if (existingRequest != null) {
        if (existingRepository == null) {
          repositoriesByNodeId.set(nodeId, repository);
        }
        continue;
      }
      if (requestedNodeIds.has(nodeId) || observedNodeIds.has(nodeId)) {
        continue;
      }
      repositoriesByNodeId.set(nodeId, repository);
      requestsByNodeId.set(
        nodeId,
        Object.freeze({
          nodeId,
          nativeDepth: 0,
        }),
      );
    }
    const nextRequests = [...requestsByNodeId.values()];
    if (nextRequests.length === 0) {
      return Object.freeze({
        ...refreshedAggregate,
        evaluatedAt,
        relationCandidates: completedRelationCandidates.candidates,
        blockerTopologyRelationCandidates: discoveredRelationCandidates,
        droppedRelationCandidateCount: completedRelationCandidates.droppedCount,
        tracking,
      });
    }
    const targetNodeIdsByRepositoryId = new Map<GitHubRepositoryId, GitHubNodeId[]>();
    for (const request of nextRequests) {
      requestedNodeIds.add(request.nodeId);
      const repository = repositoriesByNodeId.get(request.nodeId);
      if (repository == null) {
        continue;
      }
      const repositoryResult = repositoryResultsById.get(repository.id);
      assertNonNullable(repositoryResult, "関係先追加取得対象のrepository収集結果がありません");
      if (repositoryResult.freshness === "stale") {
        continue;
      }
      const currentNodeIds = targetNodeIdsByRepositoryId.get(repository.id);
      if (currentNodeIds == null) {
        targetNodeIdsByRepositoryId.set(repository.id, [request.nodeId]);
      } else {
        currentNodeIds.push(request.nodeId);
      }
    }
    const targetNodeIds = [...targetNodeIdsByRepositoryId.values()].flat();
    const maximumItemCount = configuration.config.tracking.relationExpansion.maxItemsPerRun;
    if (expandedNodeIds.size + targetNodeIds.length > maximumItemCount) {
      throw new CliRelationExpansionLimitError(
        maximumItemCount,
        expandedNodeIds.size,
        targetNodeIds.length,
        {},
      );
    }
    for (const nodeId of targetNodeIds) {
      expandedNodeIds.add(nodeId);
    }
    if (targetNodeIds.length === 0) {
      continue;
    }
    await collectRelationExpansionBatch(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repositoryInventory.allowlist,
      targetNodeIdsByRepositoryId,
      freshCollectionsByRepositoryId,
      repositoryResultsById,
    );
  }
}

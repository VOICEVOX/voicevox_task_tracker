import { provisionalCollectionEvaluationTime } from "../../../domain/collection-evaluation-time.js";
import type { RunEvaluatedAt } from "../contracts/evaluation-time.js";
import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/types.js";
import { collectRepositoryValues, type RepositoryCollectionResult } from "./collection-stale.js";
import {
  collectRepositoryItemObservations,
  mergeFreshRepositoryRuntimeCollection,
  type FreshRepositoryRuntimeCollection,
} from "./collection-repositories.js";
import type { CollectionPlanningContext } from "./collection-incremental-plan.js";
import type { CollectionGitHubReadPort, DelayPort } from "../ports.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import { planRelationExpansion, type RelationCandidate } from "../../../graph/index.js";
import type { PreviousCollectionRepository } from "../contracts/previous-state.js";
import { assertNonNullable } from "../../../util/index.js";
import { CollectionRelationExpansionLimitError } from "./collection-errors.js";
import {
  collectedTrackingCandidateNodeIds,
  completeRelationCandidates,
  staleTrackedNodeIdsForRelationExpansion,
  type FreshRuntimeCollectionAggregate,
} from "./collection-relation-candidates.js";
import {
  relationExpansionRepositoriesByNodeId,
  personalReminderRelationExpansionRepositoriesByNodeId,
  changedTrackedImplementationTargetNodeIds,
  trackedPotentialBlockerTargetNodeIds,
} from "./collection-relation-targets.js";
import {
  extractAllRelationCandidates,
  type RelationReferenceRetryBudget,
} from "./collection-relation-refresh.js";
import {
  collectTrackingCandidates,
  relationExpansionTrackingState,
  type RuntimeTrackingSelection,
} from "./collection-tracking.js";

type RelationExpandedRuntimeCollection = FreshRuntimeCollectionAggregate &
  Readonly<{
    evaluatedAt: RunEvaluatedAt;
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
  read: CollectionGitHubReadPort,
  context: CollectionPlanningContext,
  repository: PublicRepository,
  requestedNodeIds: readonly GitHubNodeId[],
  current: FreshRepositoryRuntimeCollection,
): Promise<FreshRepositoryRuntimeCollection> {
  const currentItemsByNodeId = new Map(current.enumeratedItems.map((item) => [item.nodeId, item]));
  const missingNodeIds = requestedNodeIds.filter((nodeId) => !currentItemsByNodeId.has(nodeId));
  const individuallyEnumeratedItems =
    missingNodeIds.length === 0
      ? Object.freeze([])
      : await read.enumerateByIdentifiers(missingNodeIds, context.startedAt);
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
  const additions = await collectRepositoryItemObservations(
    read,
    context,
    repository,
    detailTargets,
    new Set(requestedNodeIds),
    new Set(requestedNodeIds),
  );
  return mergeFreshRepositoryRuntimeCollection(repository, context, current, additions);
}

async function collectRelationExpansionBatch(
  read: CollectionGitHubReadPort,
  context: CollectionPlanningContext,
  allowlist: readonly PublicRepository[],
  targetNodeIdsByRepositoryId: ReadonlyMap<GitHubRepositoryId, readonly GitHubNodeId[]>,
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<PreviousCollectionRepository>
  >,
): Promise<void> {
  const targetRepositories = allowlist.filter((repository) =>
    targetNodeIdsByRepositoryId.has(repository.id),
  );
  const expandedCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const results = await collectRepositoryValues({
    repositories: targetRepositories,
    observedAt: context.startedAt,
    previousValues: new Map(
      (context.previousState.snapshot.status === "available"
        ? context.previousState.snapshot.collectionRepositories
        : []
      ).map((repository) => [
        repository.repositoryId,
        Object.freeze({ value: repository, observedAt: repository.successfulAt }),
      ]),
    ),
    collect: async (repository) => {
      const requestedNodeIds = targetNodeIdsByRepositoryId.get(repository.id);
      assertNonNullable(requestedNodeIds, "関係先追加取得対象のnode IDがありません");
      const current = freshCollectionsByRepositoryId.get(repository.id);
      assertNonNullable(current, "関係先追加取得対象の最新repository収集結果がありません");
      const expanded = await collectAdditionalRelationItems(
        read,
        context,
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
  read: CollectionGitHubReadPort,
  delay: DelayPort,
  context: CollectionPlanningContext,
  repositories: readonly PublicRepository[],
  freshCollectionsByRepositoryId: Map<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
  repositoryResultsById: Map<
    GitHubRepositoryId,
    RepositoryCollectionResult<PreviousCollectionRepository>
  >,
  captureEvaluationTime: () => RunEvaluatedAt,
): Promise<RelationExpandedRuntimeCollection> {
  const requestedNodeIds = new Set<GitHubNodeId>();
  const expandedNodeIds = new Set<GitHubNodeId>();
  const relationReferenceRetryBudget: RelationReferenceRetryBudget = {
    maxRefreshes: Math.min(2, context.config.operations.retry.maxAttempts - 1),
    refreshes: 0,
  };
  for (;;) {
    const extractedRelations = await extractAllRelationCandidates(
      read,
      delay,
      context,
      freshCollectionsByRepositoryId,
      repositoryResultsById,
      repositories,
      relationReferenceRetryBudget,
    );
    const discoveredRelationCandidates = extractedRelations.candidates;
    const refreshedAggregate = extractedRelations.aggregate;
    const collectedCandidateNodeIds = collectedTrackingCandidateNodeIds(
      context.previousState,
      refreshedAggregate,
    );
    const staleTrackedNodeIds = staleTrackedNodeIdsForRelationExpansion(
      context.previousState,
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
    const provisionalTime = provisionalCollectionEvaluationTime(
      context.startedAt,
      refreshedAggregate.enumeratedItems,
      refreshedAggregate.observedItems,
    );
    const tracking = collectTrackingCandidates(
      provisionalTime,
      context.config,
      context.executionPolicy,
      context.previousState,
      repositories,
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
      maximumNativeDepth: context.config.tracking.autoInclude.nativeRelations
        ? context.config.tracking.autoInclude.relationDepth
        : 0,
    });
    const repositoriesByNodeId = new Map(
      relationExpansionRepositoriesByNodeId(discoveredRelationCandidates, repositories),
    );
    const observedNodeIds = new Set<string>(
      refreshedAggregate.observedItems.map((item) => item.nodeId),
    );
    const personalReminderSeedRepositoriesByNodeId =
      personalReminderRelationExpansionRepositoriesByNodeId(
        context.previousState,
        refreshedAggregate,
        tracking,
        discoveredRelationCandidates,
        repositories,
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
      const evaluatedAt = captureEvaluationTime();
      const finalTracking = collectTrackingCandidates(
        evaluatedAt,
        context.config,
        context.executionPolicy,
        context.previousState,
        repositories,
        refreshedAggregate.enumeratedItems,
        refreshedAggregate.observedItems,
        completedTrackingRelationCandidates.candidates,
      );
      return Object.freeze({
        ...refreshedAggregate,
        evaluatedAt,
        relationCandidates: completedRelationCandidates.candidates,
        blockerTopologyRelationCandidates: discoveredRelationCandidates,
        droppedRelationCandidateCount: completedRelationCandidates.droppedCount,
        tracking: finalTracking,
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
    const maximumItemCount = context.config.tracking.relationExpansion.maxItemsPerRun;
    if (expandedNodeIds.size + targetNodeIds.length > maximumItemCount) {
      throw new CollectionRelationExpansionLimitError(
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
      read,
      context,
      repositories,
      targetNodeIdsByRepositoryId,
      freshCollectionsByRepositoryId,
      repositoryResultsById,
    );
  }
}

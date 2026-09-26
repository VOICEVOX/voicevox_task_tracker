import { type GitHubNodeId, type GitHubRepositoryId } from "../../../domain/index.js";
import {
  collectRepositoriesWithStaleFallback,
  markObservedGitHubItemsStale,
  type GitHubClient,
  type StaleObservedGitHubItem,
} from "../../../github/index.js";
import type {
  SnapshotCollectionItem,
  SnapshotCollectionRepository,
} from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DailyRunInvocation, DailyTransactionDependencies } from "../../daily-transaction.js";
import { blockerRelationAnalysisTargets } from "../../relation-driven-analysis-targets.js";
import type { CollectionRuntimeAdapters } from "../adapters.js";
import type {
  CollectedItems,
  ProductionTypes,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { githubApiRemaining } from "../github-rate-limit.js";
import { selectPersonalReminderRelationCandidateConsumers } from "../personal-reminder-relation-selection.js";
import {
  previousGraphAdjacentNodeIds,
  previousRelationCandidateDependencyProducers,
  previousStaleRepositoryBlockerTopologyNodeIds,
} from "../previous-state/analysis.js";
import { previousRepositoryValues } from "../previous-state/collection.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import {
  EMPTY_RELATION_CANDIDATES,
  currentNativeCandidateStateByStaleNodeId,
  indexRelationCandidatesByNodeId,
} from "../relation-candidate-index.js";
import { configuredNodeIdentifiers } from "./incremental-plan.js";
import {
  effectiveAssigneeRelationChangeTargetNodeIds,
  staleEffectiveAssigneeTargetsToRetain,
} from "./relation-expansion-targets.js";
import { collectRelationExpandedItems } from "./relation-expansion.js";
import {
  collectFreshRepositoryItems,
  type FreshRepositoryRuntimeCollection,
} from "./repository-collection.js";
import {
  finalizeEnumeratedItemObservation,
  finalizeItemDetailObservation,
  finalizeObservedItemObservation,
  finalizeRepositoryCollectionResult,
} from "./repository-observation.js";

async function collectProductionItems(
  adapters: CollectionRuntimeAdapters,
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  authentication: GitHubClient,
  repositoryInventory: RepositoryInventory,
): Promise<
  Readonly<{
    value: CollectedItems;
    changedItemCount: number;
    staleRepositoryCount: number;
    diagnostics: readonly string[];
  }>
> {
  const nodeIdentifiers = configuredNodeIdentifiers(configuration.config);
  const explicitNodeItems =
    nodeIdentifiers.length === 0
      ? Object.freeze([])
      : await adapters.enumerateGitHubItemsByIdentifiers({
          allowlist: repositoryInventory.allowlist,
          identifiers: nodeIdentifiers,
          observedAt: invocation.startedAt,
          request: authentication.request,
          graphql: authentication.graphql,
        });
  const adjacentNodeIds = previousGraphAdjacentNodeIds(state);
  const freshCollectionsByRepositoryId = new Map<
    GitHubRepositoryId,
    FreshRepositoryRuntimeCollection
  >();
  const initialRepositoryResults = await collectRepositoriesWithStaleFallback({
    allowlist: repositoryInventory.allowlist,
    observedAt: invocation.startedAt,
    previousValues: previousRepositoryValues(state),
    collect: async (repository) => {
      const collected = await collectFreshRepositoryItems(
        adapters,
        invocation,
        configuration,
        state,
        authentication,
        repository,
        explicitNodeItems,
        adjacentNodeIds,
      );
      freshCollectionsByRepositoryId.set(repository.id, collected);
      return collected.state;
    },
  });
  const repositoryResultsById = new Map(
    initialRepositoryResults.map((result) => [result.repository.id, result]),
  );
  const expanded = await collectRelationExpandedItems(
    adapters,
    invocation,
    configuration,
    state,
    authentication,
    repositoryInventory,
    freshCollectionsByRepositoryId,
    repositoryResultsById,
  );
  const repositoryResults = Object.freeze(
    repositoryInventory.allowlist.repositories.map((repository) => {
      const result = repositoryResultsById.get(repository.id);
      assertNonNullable(result, `repository収集結果がありません。対象: ${repository.id}`);
      return finalizeRepositoryCollectionResult(result, expanded.evaluatedAt);
    }),
  );

  const staleItems: StaleObservedGitHubItem<SnapshotCollectionItem>[] = [];
  const collectionRepositories: SnapshotCollectionRepository[] = [];
  const staleRepositoryIds = new Set<GitHubRepositoryId>();
  const diagnostics: string[] = [];
  for (const result of repositoryResults) {
    if (result.freshness === "fresh") {
      collectionRepositories.push(result.value);
      continue;
    }
    staleRepositoryIds.add(result.repository.id);
    collectionRepositories.push(result.previousValue);
    staleItems.push(
      ...markObservedGitHubItemsStale({
        previousItems: result.previousValue.items,
        failedAt: result.failedAt,
        diagnostic: result.diagnostic,
      }),
    );
    diagnostics.push(result.diagnostic.message);
  }
  if (expanded.droppedRelationCandidateCount > 0) {
    diagnostics.push(
      `端点を取得できなかった関係候補を${expanded.droppedRelationCandidateCount.toString()}件除外しました`,
    );
  }
  if (expanded.tracking.excludedCandidateCount > 0) {
    diagnostics.push(
      `詳細未取得かつ前回未追跡の項目を追跡候補から${expanded.tracking.excludedCandidateCount.toString()}件除外しました`,
    );
  }

  const uniqueEnumeratedItems = Object.freeze(
    expanded.enumeratedItems.map((item) =>
      finalizeEnumeratedItemObservation(item, expanded.evaluatedAt),
    ),
  );
  const uniqueDetails = Object.freeze(
    expanded.details.map((detail) => finalizeItemDetailObservation(detail, expanded.evaluatedAt)),
  );
  const uniqueObservedItems = Object.freeze(
    expanded.observedItems.map((item) =>
      finalizeObservedItemObservation(item, expanded.evaluatedAt),
    ),
  );
  const changedNodeIds = expanded.changedNodeIds;
  const relationCandidates = expanded.relationCandidates;
  const tracking = expanded.tracking;
  const observedItemsByNodeId = new Map(uniqueObservedItems.map((item) => [item.nodeId, item]));
  const detailsByNodeId = new Map(uniqueDetails.map((detail) => [detail.nodeId, detail]));
  const relationCandidatesByNodeId = indexRelationCandidatesByNodeId(relationCandidates);
  const trackedNodeIds = new Set(
    tracking.result.trackedItems.map((selected) => selected.item.nodeId),
  );
  const trackingNotificationClassByNodeId = new Map(
    tracking.result.trackedItems.map((selected) => [
      selected.item.nodeId,
      selected.item.notificationClass,
    ]),
  );
  for (const previousItem of previousSnapshot(state)?.items ?? []) {
    if (staleRepositoryIds.has(previousItem.repositoryId)) {
      trackedNodeIds.add(previousItem.nodeId);
    }
  }
  const observedNodeIds = new Set(uniqueObservedItems.map((item) => item.nodeId));
  const analysisNodeIds = new Set<GitHubNodeId>(
    [...tracking.workByNodeId].flatMap(([nodeId, work]) =>
      work.codexAnalysis.action === "analyze" && observedNodeIds.has(nodeId) ? [nodeId] : [],
    ),
  );
  for (const nodeId of changedNodeIds) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  for (const nodeId of expanded.analysisPlanChangedNodeIds) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  for (const nodeId of expanded.personalReminderReplanNodeIds) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  const effectiveAssigneeRelationChangeTargets = effectiveAssigneeRelationChangeTargetNodeIds(
    state,
    uniqueObservedItems,
    relationCandidates,
    tracking,
  );
  const staleEffectiveAssigneeTargets = staleEffectiveAssigneeTargetsToRetain(
    state,
    uniqueObservedItems,
    staleRepositoryIds,
  );
  const personalReminderRelationCandidateSelection =
    selectPersonalReminderRelationCandidateConsumers(
      state,
      {
        observedItems: uniqueObservedItems,
        staleItems,
        relationCandidates,
      },
      trackedNodeIds,
    );
  for (const nodeId of personalReminderRelationCandidateSelection.analysisNodeIds) {
    analysisNodeIds.add(nodeId);
  }
  for (const nodeId of staleEffectiveAssigneeTargets) {
    analysisNodeIds.delete(nodeId);
  }
  for (const nodeId of previousStaleRepositoryBlockerTopologyNodeIds(state)) {
    if (trackedNodeIds.has(nodeId) && observedNodeIds.has(nodeId)) {
      analysisNodeIds.add(nodeId);
    }
  }
  for (const [nodeId, work] of tracking.workByNodeId) {
    if (staleEffectiveAssigneeTargets.has(nodeId)) {
      continue;
    }
    if (work.codexAnalysis.action === "analyze") {
      continue;
    }
    const item = observedItemsByNodeId.get(nodeId);
    if (item?.type !== "issue" || item.state !== "open" || item.assignees.length !== 0) {
      continue;
    }
    const issueRelationCandidates =
      relationCandidatesByNodeId.get(item.nodeId) ?? EMPTY_RELATION_CANDIDATES;
    const hasAnalyzedImplementation = issueRelationCandidates.some((candidate) => {
      if (candidate.relation.type !== "implements") {
        return false;
      }
      if (candidate.authority !== "authoritative") {
        return false;
      }
      const implementation = candidate.relation.implementation;
      const target = candidate.relation.target;
      if (
        implementation.scope !== "organization" ||
        implementation.kind !== "pull_request" ||
        target.scope !== "organization" ||
        target.kind !== "issue" ||
        target.nodeId !== item.nodeId
      ) {
        return false;
      }
      const implementationWork = tracking.workByNodeId.get(implementation.nodeId);
      return implementationWork?.codexAnalysis.action === "analyze";
    });
    const hasChangedImplementationRelation = effectiveAssigneeRelationChangeTargets.has(
      item.nodeId,
    );
    if (!hasAnalyzedImplementation && !hasChangedImplementationRelation) {
      continue;
    }
    const detail = detailsByNodeId.get(item.nodeId);
    assertNonNullable(detail, `実質担当候補抽出対象の詳細がありません。対象: ${item.nodeId}`);
    if (detail.type !== "issue") {
      throw new TypeError(`Issueの詳細種別が一致しません。対象: ${item.nodeId}`);
    }
    analysisNodeIds.add(item.nodeId);
  }
  const staleNodeIds = new Set(staleItems.map((item) => item.nodeId));
  const blockerTargets = blockerRelationAnalysisTargets({
    snapshot: previousSnapshot(state),
    relationCandidates: expanded.blockerTopologyRelationCandidates,
    changedNodeIds,
    initialAnalysisNodeIds: analysisNodeIds,
    trackedNodeIds,
    observedItemsByNodeId,
    detailsByNodeId,
    staleNodeIds,
    previousRelationCandidateDependencyProducers: () =>
      previousRelationCandidateDependencyProducers(state),
    currentNativeStatesByStaleNodeId: () =>
      currentNativeCandidateStateByStaleNodeId(
        expanded.blockerTopologyRelationCandidates,
        staleNodeIds,
      ),
    previousStaleRepositoryBlockerTopologyNodeIds: () =>
      previousStaleRepositoryBlockerTopologyNodeIds(state),
  });
  for (const nodeId of blockerTargets.freshNodeIds) {
    analysisNodeIds.add(nodeId);
  }
  return Object.freeze({
    value: Object.freeze({
      evaluatedAt: expanded.evaluatedAt,
      enumeratedItems: uniqueEnumeratedItems,
      details: uniqueDetails,
      observedItems: uniqueObservedItems,
      staleItems: Object.freeze(staleItems),
      trackedNodeIds,
      trackingNotificationClassByNodeId,
      analysisNodeIds,
      staleBlockerTopologyNodeIds: blockerTargets.staleNodeIds,
      changedNodeIds,
      externalReferences: tracking.result.ghostNodes,
      relationCandidates,
      repositoryResults,
      collectionRepositories: Object.freeze(collectionRepositories),
    }),
    changedItemCount: [...changedNodeIds].filter((nodeId) => trackedNodeIds.has(nodeId)).length,
    staleRepositoryCount: staleRepositoryIds.size,
    diagnostics: Object.freeze(diagnostics),
  });
}

/** 増分収集段階を既存adapterへ接続する。 */
export function createCollectIncrementalItemsStage(
  adapters: CollectionRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["collectIncrementalItems"] {
  return async ({ invocation, configuration, state, authentication, repositoryInventory }) => {
    const collection = await collectProductionItems(
      adapters,
      invocation,
      configuration,
      state,
      authentication,
      repositoryInventory,
    );
    return Object.freeze({
      value: collection.value,
      itemCount: collection.value.trackedNodeIds.size,
      changedItemCount: collection.changedItemCount,
      githubApiRemaining: githubApiRemaining(authentication),
      staleRepositoryCount: collection.staleRepositoryCount,
      diagnostics: collection.diagnostics,
    });
  };
}

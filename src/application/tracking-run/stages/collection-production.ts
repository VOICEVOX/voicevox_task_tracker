import type { VerifiedExternalReference } from "../../../domain/verified-external-reference.js";
import { collectVerifiedExternalReferences } from "../verified-external-references.js";
import type {
  GitHubNodeId,
  GitHubRepositoryId,
  TrackingNotificationClass,
} from "../../../domain/types.js";
import type { ExternalGhostNode } from "../../../domain/tracking-selection.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type {
  GitHubItemDetail,
  LegacyReviewRequestInspection,
} from "../../../github/item-detail-types.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { RelationCandidate } from "../../../graph/relation-candidate-types.js";
import type { RunEvaluatedAt } from "../contracts/evaluation-time.js";
import type {
  PreviousCollectionItem,
  PreviousCollectionRepository,
} from "../contracts/previous-state.js";
import type { CollectionPlanningContext } from "./collection-incremental-plan.js";
import type { InitialRepositoryCollection } from "./collection-repositories.js";
import type { CollectionGitHubReadPort, DelayPort } from "../ports.js";
import {
  retainStaleObservedItems,
  type RepositoryCollectionResult,
  type StaleObservedGitHubItem,
} from "./collection-stale.js";
import { assertNonNullable } from "../../../util/index.js";
import { blockerRelationAnalysisTargets } from "./collection-analysis-targets.js";
import { selectPersonalReminderRelationCandidateConsumers } from "./collection-reminder-selection.js";
import {
  previousRelationCandidateDependencyProducers,
  previousStaleRepositoryBlockerTopologyNodeIds,
} from "./collection-previous-state.js";
import {
  EMPTY_RELATION_CANDIDATES,
  currentNativeCandidateStateByStaleNodeId,
  indexRelationCandidatesByNodeId,
} from "./collection-relation-index.js";
import {
  effectiveAssigneeRelationChangeTargetNodeIds,
  staleEffectiveAssigneeTargetsToRetain,
} from "./collection-relation-targets.js";
import { collectRelationExpandedItems } from "./collection-relation-closure.js";
import {
  finalizeEnumeratedItemObservation,
  finalizeItemDetailObservation,
  finalizeObservedItemObservation,
  finalizeRepositoryCollectionResult,
} from "./collection-observations.js";

/** 収集完了時に確定する正規化済み項目と再分析対象。 */
export type CollectedItemObservations = Readonly<{
  evaluatedAt: RunEvaluatedAt;
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  legacyReviewRequests: readonly LegacyReviewRequestInspection[];
  observedItems: readonly FreshObservedGitHubItem[];
  staleItems: readonly StaleObservedGitHubItem<PreviousCollectionItem>[];
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
  trackingNotificationClassByNodeId: ReadonlyMap<GitHubNodeId, TrackingNotificationClass>;
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  staleBlockerTopologyNodeIds: ReadonlySet<GitHubNodeId>;
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>;
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  externalReferences: readonly ExternalGhostNode[];
  verifiedExternalReferences: readonly VerifiedExternalReference[];
  relationCandidates: readonly RelationCandidate[];
  repositoryResults: readonly RepositoryCollectionResult<PreviousCollectionRepository>[];
  collectionRepositories: readonly PreviousCollectionRepository[];
}>;

/** 関係閉包から追跡対象と再分析対象を確定する。 */
export async function collectProductionItems(
  read: CollectionGitHubReadPort,
  delay: DelayPort,
  context: CollectionPlanningContext,
  repositories: readonly PublicRepository[],
  initial: InitialRepositoryCollection,
  captureEvaluationTime: () => RunEvaluatedAt,
): Promise<
  Readonly<{
    value: CollectedItemObservations;
    changedItemCount: number;
    staleRepositoryCount: number;
    diagnostics: readonly string[];
  }>
> {
  const { freshCollectionsByRepositoryId, repositoryResultsById } = initial;
  const expanded = await collectRelationExpandedItems(
    read,
    delay,
    context,
    repositories,
    freshCollectionsByRepositoryId,
    repositoryResultsById,
    captureEvaluationTime,
  );
  const repositoryResults = Object.freeze(
    repositories.map((repository) => {
      const result = repositoryResultsById.get(repository.id);
      assertNonNullable(result, `repository収集結果がありません。対象: ${repository.id}`);
      return finalizeRepositoryCollectionResult(result, expanded.evaluatedAt);
    }),
  );

  const staleItems: StaleObservedGitHubItem<PreviousCollectionItem>[] = [];
  const collectionRepositories: PreviousCollectionRepository[] = [];
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
      ...retainStaleObservedItems(result.previousValue.items, result.failedAt, result.diagnostic),
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
  for (const previousItem of context.previousState.snapshot.status === "available"
    ? context.previousState.snapshot.trackedItems
    : []) {
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
    context.previousState,
    uniqueObservedItems,
    relationCandidates,
    tracking,
  );
  const staleEffectiveAssigneeTargets = staleEffectiveAssigneeTargetsToRetain(
    context.previousState,
    uniqueObservedItems,
    staleRepositoryIds,
  );
  const personalReminderRelationCandidateSelection =
    selectPersonalReminderRelationCandidateConsumers(
      context.previousState,
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
  for (const nodeId of previousStaleRepositoryBlockerTopologyNodeIds(context.previousState)) {
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
    snapshot:
      context.previousState.snapshot.status === "available"
        ? context.previousState.snapshot
        : undefined,
    relationCandidates: expanded.blockerTopologyRelationCandidates,
    changedNodeIds,
    initialAnalysisNodeIds: analysisNodeIds,
    trackedNodeIds,
    observedItemsByNodeId,
    detailsByNodeId,
    staleNodeIds,
    previousRelationCandidateDependencyProducers: () =>
      previousRelationCandidateDependencyProducers(context.previousState),
    currentNativeStatesByStaleNodeId: () =>
      currentNativeCandidateStateByStaleNodeId(
        expanded.blockerTopologyRelationCandidates,
        staleNodeIds,
      ),
    previousStaleRepositoryBlockerTopologyNodeIds: () =>
      previousStaleRepositoryBlockerTopologyNodeIds(context.previousState),
  });
  for (const nodeId of blockerTargets.freshNodeIds) {
    analysisNodeIds.add(nodeId);
  }
  const previousSnapshot = context.previousState.snapshot;
  const verifiedExternalReferences = await collectVerifiedExternalReferences(
    read,
    expanded.evaluatedAt,
    previousSnapshot.status === "available" ? previousSnapshot.verifiedExternalReferences : [],
    relationCandidates,
    uniqueDetails,
  );
  return Object.freeze({
    value: Object.freeze({
      evaluatedAt: expanded.evaluatedAt,
      enumeratedItems: uniqueEnumeratedItems,
      details: uniqueDetails,
      legacyReviewRequests: Object.freeze([]),
      observedItems: uniqueObservedItems,
      staleItems: Object.freeze(staleItems),
      trackedNodeIds,
      trackingNotificationClassByNodeId,
      analysisNodeIds,
      staleBlockerTopologyNodeIds: blockerTargets.staleNodeIds,
      unavailableConsumerNodeIds:
        personalReminderRelationCandidateSelection.unavailableConsumerNodeIds,
      changedNodeIds,
      externalReferences: tracking.result.ghostNodes,
      verifiedExternalReferences,
      relationCandidates,
      repositoryResults,
      collectionRepositories: Object.freeze(collectionRepositories),
    }),
    changedItemCount: [...changedNodeIds].filter((nodeId) => trackedNodeIds.has(nodeId)).length,
    staleRepositoryCount: staleRepositoryIds.size,
    diagnostics: Object.freeze(diagnostics),
  });
}

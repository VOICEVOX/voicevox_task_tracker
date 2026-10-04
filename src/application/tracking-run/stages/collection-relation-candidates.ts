import type { Config } from "../../../config/index.js";
import type { RepositoryCollectionResult } from "./collection-stale.js";
import type { FreshRepositoryRuntimeCollection } from "./collection-repositories.js";
import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/index.js";
import { deduplicateByStableId } from "../../../github/stable-id.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import {
  extractRelationCandidatesForItems,
  type PublicGitHubRelationItem,
  type RelationCandidate,
  type RelationExtractionItem,
} from "../../../graph/index.js";
import { relationNodes } from "../../../graph/relation-candidate-endpoints.js";
import type {
  PreviousCollectionRepository,
  AnalysisPreviousState,
} from "../contracts/previous-state.js";
import { assertNonNullable } from "../../../util/index.js";

export type FreshRuntimeCollectionAggregate = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
  changedNodeIds: ReadonlySet<GitHubNodeId>;
  analysisPlanChangedNodeIds: ReadonlySet<GitHubNodeId>;
  personalReminderReplanNodeIds: ReadonlySet<GitHubNodeId>;
}>;

function requireRepository(
  repositories: readonly PublicRepository[],
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  const repository = repositories.find((item) => item.id === repositoryId);
  assertNonNullable(repository, `公開repositoryがありません。対象: ${repositoryId}`);
  return repository;
}

/** 公開関係項目を構築する。 */
export function createPublicRelationItem(
  item: EnumeratedGitHubItem,
  repository: PublicRepository,
): PublicGitHubRelationItem {
  return Object.freeze({
    nodeId: item.nodeId,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: item.type,
    number: item.number,
    url: item.url,
    state: item.type === "pull_request" && item.mergeStatus === "merged" ? "merged" : item.state,
  });
}

/** 取得済み詳細から関係候補を抽出する。 */
export function extractRelationCandidatesOnce(
  config: Config,
  allowlist: readonly PublicRepository[],
  items: readonly EnumeratedGitHubItem[],
  details: readonly GitHubItemDetail[],
): readonly RelationCandidate[] {
  const knownItems = items.map((item) =>
    createPublicRelationItem(item, requireRepository(allowlist, item.repositoryId)),
  );
  const itemByNodeId = new Map(knownItems.map((item) => [item.nodeId, item]));
  const extractionItems = details.map((detail) => {
    const item = itemByNodeId.get(detail.nodeId);
    assertNonNullable(item, `関係候補抽出対象がありません。対象: ${detail.nodeId}`);
    return Object.freeze({
      ...item,
      body: {
        sourceId: detail.bodySourceId,
        markdown: detail.body,
      },
      comments: detail.comments.map((comment) => ({
        sourceId: comment.sourceId,
        markdown: comment.body,
      })),
      crossReferences: detail.inboundCrossReferences.map((reference) => ({
        sourceId: reference.eventSourceId,
        sourceItem: reference.sourceItem,
        willCloseTarget: reference.willCloseTarget,
      })),
      nativeDependencies:
        detail.type === "issue" && detail.nativeDependencies.availability === "available"
          ? detail.nativeDependencies.relations
          : [],
      nativeHierarchy:
        detail.type === "issue" && detail.nativeHierarchy.availability === "available"
          ? detail.nativeHierarchy.relations
          : [],
      nativeClosingIssues: detail.type === "pull_request" ? detail.nativeClosingIssues : [],
    }) satisfies RelationExtractionItem;
  });
  return extractRelationCandidatesForItems({
    organization: config.organization,
    items: extractionItems,
    knownItems,
  });
}

/** 端点を収集できた関係候補を選ぶ。 */
export function completeRelationCandidates(
  candidates: readonly RelationCandidate[],
  collectedCandidateNodeIds: ReadonlySet<GitHubNodeId>,
  staleTrackedNodeIds: ReadonlySet<GitHubNodeId>,
): Readonly<{
  candidates: readonly RelationCandidate[];
  droppedCount: number;
}> {
  const completeCandidates = candidates.filter((candidate) =>
    relationNodes(candidate.relation).every(
      (node) =>
        node.scope === "external_public" ||
        collectedCandidateNodeIds.has(node.nodeId) ||
        (candidate.provenance === "native" && staleTrackedNodeIds.has(node.nodeId)),
    ),
  );
  return Object.freeze({
    candidates: Object.freeze(completeCandidates),
    droppedCount: candidates.length - completeCandidates.length,
  });
}

/** 収集済みの追跡候補端点を返す。 */
export function collectedTrackingCandidateNodeIds(
  state: AnalysisPreviousState,
  aggregate: FreshRuntimeCollectionAggregate,
): ReadonlySet<GitHubNodeId> {
  const enumeratedNodeIds = new Set(aggregate.enumeratedItems.map((item) => item.nodeId));
  const candidateNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  for (const item of state.snapshot.status === "available" ? state.snapshot.trackedItems : []) {
    if (enumeratedNodeIds.has(item.nodeId)) {
      candidateNodeIds.add(item.nodeId);
    }
  }
  return candidateNodeIds;
}

/** 前回値を保持した追跡端点を返す。 */
export function staleTrackedNodeIdsForRelationExpansion(
  state: AnalysisPreviousState,
  repositoryResultsById: ReadonlyMap<
    GitHubRepositoryId,
    RepositoryCollectionResult<PreviousCollectionRepository>
  >,
): ReadonlySet<GitHubNodeId> {
  const staleRepositoryIds = new Set<GitHubRepositoryId>(
    [...repositoryResultsById.values()]
      .filter((result) => result.freshness === "stale")
      .map((result) => result.repository.id),
  );
  return new Set(
    (state.snapshot.status === "available" ? state.snapshot.trackedItems : [])
      .filter((item) => staleRepositoryIds.has(item.repositoryId))
      .map((item) => item.nodeId),
  );
}

/** 公開リポジトリの収集結果を集約する。 */
export function aggregateFreshRepositoryCollections(
  allowlist: readonly PublicRepository[],
  freshCollectionsByRepositoryId: ReadonlyMap<GitHubRepositoryId, FreshRepositoryRuntimeCollection>,
): FreshRuntimeCollectionAggregate {
  const enumeratedItems: EnumeratedGitHubItem[] = [];
  const details: GitHubItemDetail[] = [];
  const observedItems: FreshObservedGitHubItem[] = [];
  const changedNodeIds = new Set<GitHubNodeId>();
  const analysisPlanChangedNodeIds = new Set<GitHubNodeId>();
  const personalReminderReplanNodeIds = new Set<GitHubNodeId>();
  for (const repository of allowlist) {
    const collection = freshCollectionsByRepositoryId.get(repository.id);
    if (collection == null) {
      continue;
    }
    enumeratedItems.push(...collection.enumeratedItems);
    details.push(...collection.details);
    observedItems.push(...collection.observedItems);
    for (const nodeId of collection.changedNodeIds) {
      changedNodeIds.add(nodeId);
    }
    for (const nodeId of collection.analysisPlanChangedNodeIds) {
      analysisPlanChangedNodeIds.add(nodeId);
    }
    for (const nodeId of collection.personalReminderReplanNodeIds) {
      personalReminderReplanNodeIds.add(nodeId);
    }
  }
  return Object.freeze({
    enumeratedItems: deduplicateByStableId(enumeratedItems, (item) => item.nodeId),
    details: deduplicateByStableId(details, (detail) => detail.nodeId),
    observedItems: deduplicateByStableId(observedItems, (item) => item.nodeId),
    changedNodeIds,
    analysisPlanChangedNodeIds,
    personalReminderReplanNodeIds,
  });
}

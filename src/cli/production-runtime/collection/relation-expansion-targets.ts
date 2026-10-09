import type { GitHubNodeId, GitHubRepositoryId, GraphNodeId } from "../../../domain/index.js";
import type {
  FreshObservedGitHubItem,
  PublicRepository,
  PublicRepositoryAllowlist,
} from "../../../github/index.js";
import type { RelationCandidate } from "../../../graph/index.js";
import { relationNodes } from "../../../graph/relation-candidate-endpoints.js";
import type { SnapshotCollectionItem, SnapshotTrackedItem } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { RuntimeState } from "../contracts.js";
import { previousPersonalReminderRelationCandidateDependencies } from "../previous-state/analysis.js";
import { previousCollectionItemsByNodeId } from "../previous-state/collection.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import type { FreshRuntimeCollectionAggregate } from "./relation-candidates.js";
import type { RuntimeTrackingSelection } from "./tracking-selection.js";

/** 関係候補の端点を公開リポジトリへ対応付ける。 */
export function relationExpansionRepositoriesByNodeId(
  candidates: readonly RelationCandidate[],
  allowlist: PublicRepositoryAllowlist,
): ReadonlyMap<GitHubNodeId, PublicRepository> {
  const repositoriesByNodeId = new Map<GitHubNodeId, PublicRepository>();
  for (const candidate of candidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope !== "organization") {
        continue;
      }
      const repository = allowlist.repositories.find(
        (current) =>
          current.owner.toLowerCase() === node.repositoryOwner.toLowerCase() &&
          current.name.toLowerCase() === node.repositoryName.toLowerCase(),
      );
      if (repository == null) {
        continue;
      }
      const existing = repositoriesByNodeId.get(node.nodeId);
      if (existing != null && existing.id !== repository.id) {
        throw new TypeError("同じ関係先node IDに異なるallowlist repositoryが指定されています");
      }
      repositoriesByNodeId.set(node.nodeId, repository);
    }
  }
  return repositoriesByNodeId;
}

/** 個人催促の関係先追加取得対象を公開リポジトリへ対応付ける。 */
export function personalReminderRelationExpansionRepositoriesByNodeId(
  state: RuntimeState,
  aggregate: FreshRuntimeCollectionAggregate,
  tracking: RuntimeTrackingSelection,
  relationCandidates: readonly RelationCandidate[],
  allowlist: PublicRepositoryAllowlist,
): ReadonlyMap<GitHubNodeId, PublicRepository> {
  const freshObservedNodeIds = new Set<string>(aggregate.observedItems.map((item) => item.nodeId));
  const trackedNodeIds = new Set<string>(tracking.workByNodeId.keys());
  const previousItemsByNodeId = new Map<string, SnapshotCollectionItem>();
  for (const [nodeId, item] of previousCollectionItemsByNodeId(state)) {
    previousItemsByNodeId.set(nodeId, item);
  }
  const externalEndpointNodeIds = new Set<string>();
  for (const candidate of relationCandidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope === "external_public") {
        externalEndpointNodeIds.add(node.nodeId);
      }
    }
  }
  const repositoriesByNodeId = new Map<GitHubNodeId, PublicRepository>();
  for (const dependency of previousPersonalReminderRelationCandidateDependencies(state)) {
    if (
      !freshObservedNodeIds.has(dependency.consumerNodeId) ||
      !trackedNodeIds.has(dependency.consumerNodeId)
    ) {
      continue;
    }
    for (const endpointNodeId of dependency.producer.endpointNodeIds) {
      if (freshObservedNodeIds.has(endpointNodeId) || externalEndpointNodeIds.has(endpointNodeId)) {
        continue;
      }
      const previousCollectionItem = previousItemsByNodeId.get(endpointNodeId);
      if (previousCollectionItem == null) {
        continue;
      }
      const repository = allowlist.repositories.find(
        (candidate) => candidate.id === previousCollectionItem.repositoryId,
      );
      if (repository == null) {
        continue;
      }
      const existing = repositoriesByNodeId.get(previousCollectionItem.nodeId);
      if (existing != null && existing.id !== repository.id) {
        throw new TypeError(
          "個人催促relation candidateの同じendpoint node IDに異なるallowlist repositoryが指定されています",
        );
      }
      repositoriesByNodeId.set(previousCollectionItem.nodeId, repository);
    }
  }
  return repositoriesByNodeId;
}

/** 変更された実装関係の追跡先を追加取得対象に選ぶ。 */
export function changedTrackedImplementationTargetNodeIds(
  aggregate: FreshRuntimeCollectionAggregate,
  tracking: RuntimeTrackingSelection,
  candidates: readonly RelationCandidate[],
  requestedNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  const enumeratedItemsByNodeId = new Map(
    aggregate.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const candidate of candidates) {
    if (candidate.authority !== "authoritative" || candidate.relation.type !== "implements") {
      continue;
    }
    const implementation = candidate.relation.implementation;
    const target = candidate.relation.target;
    if (
      implementation.scope !== "organization" ||
      implementation.kind !== "pull_request" ||
      target.scope !== "organization" ||
      target.kind !== "issue" ||
      !aggregate.changedNodeIds.has(implementation.nodeId) ||
      !tracking.workByNodeId.has(implementation.nodeId) ||
      !tracking.workByNodeId.has(target.nodeId) ||
      detailNodeIds.has(target.nodeId) ||
      requestedNodeIds.has(target.nodeId)
    ) {
      continue;
    }
    const targetItem = enumeratedItemsByNodeId.get(target.nodeId);
    assertNonNullable(targetItem, `実装関係先の列挙値がありません。対象: ${target.nodeId}`);
    if (targetItem.type !== "issue" || targetItem.state !== "open") {
      continue;
    }
    targetNodeIds.add(target.nodeId);
  }
  return Object.freeze([...targetNodeIds].sort());
}

/** 追跡中の潜在的なブロック先を追加取得対象に選ぶ。 */
export function trackedPotentialBlockerTargetNodeIds(
  aggregate: FreshRuntimeCollectionAggregate,
  tracking: RuntimeTrackingSelection,
  candidates: readonly RelationCandidate[],
  requestedNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  const detailNodeIds = new Set(aggregate.details.map((detail) => detail.nodeId));
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const candidate of candidates) {
    const potentialTargets =
      candidate.authority === "inferred"
        ? relationNodes(candidate.relation)
        : candidate.relation.type === "blocks"
          ? Object.freeze([candidate.relation.blocked])
          : Object.freeze([]);
    for (const node of potentialTargets) {
      if (
        node.scope !== "organization" ||
        !tracking.workByNodeId.has(node.nodeId) ||
        detailNodeIds.has(node.nodeId) ||
        requestedNodeIds.has(node.nodeId)
      ) {
        continue;
      }
      targetNodeIds.add(node.nodeId);
    }
  }
  return Object.freeze([...targetNodeIds].sort());
}

type EffectiveAssigneeImplementationRelation = Readonly<{
  implementationNodeId: GitHubNodeId;
  targetNodeId: GitHubNodeId;
}>;

function effectiveAssigneeImplementationRelationKey(
  relation: EffectiveAssigneeImplementationRelation,
): string {
  return `${relation.implementationNodeId}\u0000${relation.targetNodeId}`;
}

function previousAuthoritativeImplementationRelations(
  state: RuntimeState,
): readonly EffectiveAssigneeImplementationRelation[] {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return Object.freeze([]);
  }
  const itemsByNodeId = new Map<GraphNodeId, SnapshotTrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    snapshot.relations.flatMap((relation) => {
      if (!relation.active || relation.provenance !== "native" || relation.type !== "implements") {
        return [];
      }
      const implementation = itemsByNodeId.get(relation.fromNodeId);
      const target = itemsByNodeId.get(relation.toNodeId);
      if (implementation?.type !== "pull_request" || target?.type !== "issue") {
        return [];
      }
      return [
        Object.freeze({
          implementationNodeId: implementation.nodeId,
          targetNodeId: target.nodeId,
        }),
      ];
    }),
  );
}

function trackedAuthoritativeImplementationRelationKeys(
  relationCandidates: readonly RelationCandidate[],
  tracking: RuntimeTrackingSelection,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const candidate of relationCandidates) {
    if (candidate.authority !== "authoritative" || candidate.relation.type !== "implements") {
      continue;
    }
    const implementation = candidate.relation.implementation;
    const target = candidate.relation.target;
    if (
      implementation.scope !== "organization" ||
      implementation.kind !== "pull_request" ||
      target.scope !== "organization" ||
      target.kind !== "issue" ||
      !tracking.workByNodeId.has(implementation.nodeId) ||
      !tracking.workByNodeId.has(target.nodeId)
    ) {
      continue;
    }
    keys.add(
      effectiveAssigneeImplementationRelationKey({
        implementationNodeId: implementation.nodeId,
        targetNodeId: target.nodeId,
      }),
    );
  }
  return keys;
}

/** 実質担当関係が変わったIssueを再評価対象に選ぶ。 */
export function effectiveAssigneeRelationChangeTargetNodeIds(
  state: RuntimeState,
  observedItems: readonly FreshObservedGitHubItem[],
  relationCandidates: readonly RelationCandidate[],
  tracking: RuntimeTrackingSelection,
): ReadonlySet<GitHubNodeId> {
  const observedPullRequestNodeIds = new Set(
    observedItems
      .filter(
        (item): item is Extract<FreshObservedGitHubItem, { type: "pull_request" }> =>
          item.type === "pull_request",
      )
      .map((item) => item.nodeId),
  );
  const currentRelationKeys = trackedAuthoritativeImplementationRelationKeys(
    relationCandidates,
    tracking,
  );
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const relation of previousAuthoritativeImplementationRelations(state)) {
    if (!observedPullRequestNodeIds.has(relation.implementationNodeId)) {
      continue;
    }
    if (!currentRelationKeys.has(effectiveAssigneeImplementationRelationKey(relation))) {
      targetNodeIds.add(relation.targetNodeId);
    }
  }
  return targetNodeIds;
}

/** 収集が古い実質担当関係のIssueを保持対象に選ぶ。 */
export function staleEffectiveAssigneeTargetsToRetain(
  state: RuntimeState,
  observedItems: readonly FreshObservedGitHubItem[],
  staleRepositoryIds: ReadonlySet<GitHubRepositoryId>,
): ReadonlySet<GitHubNodeId> {
  const snapshot = previousSnapshot(state);
  if (snapshot == null || staleRepositoryIds.size === 0) {
    return new Set<GitHubNodeId>();
  }
  const previousItemsByNodeId = new Map<GraphNodeId, SnapshotTrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const previousEffectiveAssigneeIssueNodeIds = new Set(
    snapshot.items
      .filter(
        (item) =>
          item.type === "issue" &&
          item.state === "open" &&
          item.assignees.length === 0 &&
          item.status === "waiting_for_work" &&
          item.waitingOn.some(
            (waitingOn) => waitingOn.kind === "user" && waitingOn.role === "assignee",
          ),
      )
      .map((item) => item.nodeId),
  );
  const observedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const targetNodeIds = new Set<GitHubNodeId>();
  for (const relation of previousAuthoritativeImplementationRelations(state)) {
    const implementation = previousItemsByNodeId.get(relation.implementationNodeId);
    const target = previousItemsByNodeId.get(relation.targetNodeId);
    assertNonNullable(
      implementation,
      `前回実質担当relationのPRがありません。対象: ${relation.implementationNodeId}`,
    );
    assertNonNullable(
      target,
      `前回実質担当relationのIssueがありません。対象: ${relation.targetNodeId}`,
    );
    if (
      !staleRepositoryIds.has(implementation.repositoryId) ||
      !previousEffectiveAssigneeIssueNodeIds.has(target.nodeId)
    ) {
      continue;
    }
    const current = observedItemsByNodeId.get(target.nodeId);
    if (current?.type !== "issue" || current.state !== "open" || current.assignees.length !== 0) {
      continue;
    }
    targetNodeIds.add(target.nodeId);
  }
  return targetNodeIds;
}

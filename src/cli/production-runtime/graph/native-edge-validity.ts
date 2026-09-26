import {
  createExternalReferenceNodeId,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type GraphNodeId,
} from "../../../domain/index.js";
import type { GitHubItemDetail, GitHubReferencedItem } from "../../../github/index.js";
import type {
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateId,
  RelationCandidateNode,
} from "../../../graph/index.js";
import type { CollectedItems } from "../contracts.js";

type NativeRelationSourceObservation =
  "unavailable" | "eligible_present" | "ineligible_present" | "absent";

type NativeRelationEndpointSelection = Readonly<{
  organizationOwners: ReadonlySet<string>;
  selectedRepositoryIds: ReadonlySet<GitHubRepositoryId>;
}>;

/** 今回選定されたnative関係先の範囲を取得する。 */
export function nativeRelationEndpointSelection(
  collection: CollectedItems,
): NativeRelationEndpointSelection {
  return Object.freeze({
    organizationOwners: new Set(
      collection.repositoryResults.map((result) => result.repository.owner.toLowerCase()),
    ),
    selectedRepositoryIds: new Set(
      collection.repositoryResults.map((result) => result.repository.id),
    ),
  });
}

function nativeRelatedItemIsEligible(
  item: GitHubReferencedItem,
  selection: NativeRelationEndpointSelection,
): boolean {
  if (item.repositoryArchived || item.repositoryDisabled) {
    return false;
  }
  return (
    !selection.organizationOwners.has(item.repositoryOwner.toLowerCase()) ||
    selection.selectedRepositoryIds.has(item.repositoryId)
  );
}

function nativeRelatedItemMatchesGraphNodeId(
  relatedNodeId: GitHubNodeId,
  graphNodeId: GraphNodeId,
): boolean {
  return (
    graphNodeId === relatedNodeId ||
    graphNodeId === createExternalReferenceNodeId(`external:github:${relatedNodeId}`)
  );
}

function nativeRelatedItemsSourceObservation(
  relatedItems: readonly GitHubReferencedItem[],
  relatedNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  const matchingItems = relatedItems.filter((item) =>
    nativeRelatedItemMatchesGraphNodeId(item.nodeId, relatedNodeId),
  );
  if (matchingItems.length === 0) {
    return "absent";
  }
  const eligibility = new Set(
    matchingItems.map((item) => nativeRelatedItemIsEligible(item, selection)),
  );
  if (eligibility.size !== 1) {
    throw new TypeError(`native関係先の収集対象判定が一致しません。対象: ${relatedNodeId}`);
  }
  return eligibility.has(true) ? "eligible_present" : "ineligible_present";
}

function nativeIssueDependencySourceObservation(
  detail: GitHubItemDetail | undefined,
  direction: "blocked_by" | "blocking",
  relatedNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "issue" || detail.nativeDependencies.availability !== "available") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.nativeDependencies.relations
      .filter((relation) => relation.direction === direction)
      .map((relation) => relation.relatedItem),
    relatedNodeId,
    selection,
  );
}

function nativeIssueHierarchySourceObservation(
  detail: GitHubItemDetail | undefined,
  relationship: "parent" | "sub_issue",
  relatedNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "issue" || detail.nativeHierarchy.availability !== "available") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.nativeHierarchy.relations
      .filter((relation) => relation.relationship === relationship)
      .map((relation) => relation.relatedItem),
    relatedNodeId,
    selection,
  );
}

function nativeClosingIssueSourceObservation(
  detail: GitHubItemDetail | undefined,
  targetNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "pull_request") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.nativeClosingIssues.map((relation) => relation.relatedItem),
    targetNodeId,
    selection,
  );
}

function nativeInboundImplementationSourceObservation(
  detail: GitHubItemDetail | undefined,
  implementationNodeId: GraphNodeId,
  selection: NativeRelationEndpointSelection,
): NativeRelationSourceObservation {
  if (detail?.type !== "issue") {
    return "unavailable";
  }
  return nativeRelatedItemsSourceObservation(
    detail.inboundCrossReferences
      .filter((reference) => reference.willCloseTarget)
      .map((reference) => reference.sourceItem),
    implementationNodeId,
    selection,
  );
}

/** native関係の欠落を観測から判定する。 */
export function nativeRelationSourcesProveAbsence(
  observations: readonly NativeRelationSourceObservation[],
): boolean {
  return (
    observations.includes("absent") &&
    !observations.includes("eligible_present") &&
    !observations.includes("ineligible_present")
  );
}

function nativeRelationSourcesProveIneligibility(
  observations: readonly NativeRelationSourceObservation[],
): boolean {
  if (observations.includes("eligible_present") && observations.includes("ineligible_present")) {
    throw new TypeError("native関係先の収集対象判定がauthority間で一致しません");
  }
  return observations.includes("ineligible_present");
}

/** native関係の各authorityで得た観測を取得する。 */
export function nativeRelationSourceObservations(
  edge: ReconciledGraphEdge,
  detailsByNodeId: ReadonlyMap<GraphNodeId, GitHubItemDetail>,
  selection: NativeRelationEndpointSelection,
): readonly NativeRelationSourceObservation[] {
  if (edge.provenance !== "native") {
    throw new TypeError(`native relation欠落証明の対象 ${edge.id}がnativeではありません`);
  }
  switch (edge.type) {
    case "blocks":
      return Object.freeze([
        nativeIssueDependencySourceObservation(
          detailsByNodeId.get(edge.fromNodeId),
          "blocking",
          edge.toNodeId,
          selection,
        ),
        nativeIssueDependencySourceObservation(
          detailsByNodeId.get(edge.toNodeId),
          "blocked_by",
          edge.fromNodeId,
          selection,
        ),
      ]);
    case "parent_of":
      return Object.freeze([
        nativeIssueHierarchySourceObservation(
          detailsByNodeId.get(edge.fromNodeId),
          "sub_issue",
          edge.toNodeId,
          selection,
        ),
        nativeIssueHierarchySourceObservation(
          detailsByNodeId.get(edge.toNodeId),
          "parent",
          edge.fromNodeId,
          selection,
        ),
      ]);
    case "implements":
      return Object.freeze([
        nativeClosingIssueSourceObservation(
          detailsByNodeId.get(edge.fromNodeId),
          edge.toNodeId,
          selection,
        ),
        nativeInboundImplementationSourceObservation(
          detailsByNodeId.get(edge.toNodeId),
          edge.fromNodeId,
          selection,
        ),
      ]);
    case "related_to":
    case "duplicates":
      throw new TypeError(`native relation ${edge.id}の種別 ${edge.type}が不正です`);
  }
}

function relationCandidateNodeGitHubNodeId(node: RelationCandidateNode): GitHubNodeId {
  return node.scope === "organization" ? node.nodeId : node.githubNodeId;
}

function nativeRelationCandidateMatchesEdgeIdentity(
  candidate: Extract<RelationCandidate, { provenance: "native" }>,
  edge: ReconciledGraphEdge,
): boolean {
  switch (candidate.relation.type) {
    case "blocks":
      return (
        edge.type === "blocks" &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.blocker),
          edge.fromNodeId,
        ) &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.blocked),
          edge.toNodeId,
        )
      );
    case "parent_of":
      return (
        edge.type === "parent_of" &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.parent),
          edge.fromNodeId,
        ) &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.subtask),
          edge.toNodeId,
        )
      );
    case "implements":
      return (
        edge.type === "implements" &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.implementation),
          edge.fromNodeId,
        ) &&
        nativeRelatedItemMatchesGraphNodeId(
          relationCandidateNodeGitHubNodeId(candidate.relation.target),
          edge.toNodeId,
        )
      );
  }
}

/** 現行候補と観測から失効したnative辺のIDを取得する。 */
export function obsoleteNativeEdgeIds(
  collection: CollectedItems,
  previousEdges: readonly ReconciledGraphEdge[],
  candidates: readonly RelationCandidate[],
  detailsByNodeId: ReadonlyMap<GraphNodeId, GitHubItemDetail>,
): ReadonlySet<RelationCandidateId> {
  const selection = nativeRelationEndpointSelection(collection);
  const nativeCandidates = candidates.filter(
    (candidate): candidate is Extract<RelationCandidate, { provenance: "native" }> =>
      candidate.provenance === "native",
  );
  const edgeIds = new Set<RelationCandidateId>();
  for (const edge of previousEdges) {
    if (edge.provenance !== "native") {
      continue;
    }
    if (
      nativeCandidates.some(
        (candidate) =>
          candidate.id !== edge.id && nativeRelationCandidateMatchesEdgeIdentity(candidate, edge),
      ) ||
      nativeRelationSourcesProveIneligibility(
        nativeRelationSourceObservations(edge, detailsByNodeId, selection),
      )
    ) {
      edgeIds.add(edge.id);
    }
  }
  return edgeIds;
}

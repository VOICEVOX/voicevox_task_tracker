import type { UtcIsoDateTime } from "../../domain/types.js";
import { GitHubPublicBoundaryViolationError } from "../../github/errors.js";
import { isEligiblePublicRepository } from "../../github/public-repository-allowlist.js";
import type { CollectionGitHubReadPort } from "./ports.js";
import {
  normalizeVerifiedExternalReferences,
  type VerifiedExternalReference,
} from "../../domain/verified-external-reference.js";
import type {
  GitHubItemDetail,
  GitHubReferencedItem,
  GitHubTimelineEvent,
} from "../../github/item-detail-types.js";
import type { RelationCandidate } from "../../graph/index.js";
import { relationNodes } from "../../graph/relation-candidate-endpoints.js";

function timelineReferencedItems(event: GitHubTimelineEvent): readonly GitHubReferencedItem[] {
  if (event.kind === "cross_referenced") return [event.source];
  if (event.kind === "connected" || event.kind === "disconnected") return [event.subject];
  if (event.kind === "sub_issue_added" || event.kind === "sub_issue_removed") {
    return "status" in event.subIssue ? [] : [event.subIssue];
  }
  if (event.kind === "parent_issue_added" || event.kind === "parent_issue_removed") {
    return "status" in event.parent ? [] : [event.parent];
  }
  return [];
}

function referencedItems(detail: GitHubItemDetail): readonly GitHubReferencedItem[] {
  return Object.freeze([
    ...detail.timeline.flatMap(timelineReferencedItems),
    ...detail.inboundCrossReferences.map((reference) => reference.sourceItem),
    ...(detail.type === "issue"
      ? [
          ...(detail.nativeDependencies.availability === "available"
            ? detail.nativeDependencies.relations.map((relation) => relation.relatedItem)
            : []),
          ...(detail.nativeHierarchy.availability === "available"
            ? detail.nativeHierarchy.relations.map((relation) => relation.relatedItem)
            : []),
        ]
      : detail.nativeClosingIssues.map((relation) => relation.relatedItem)),
  ]);
}

/** 保持する外部参照を今回取得した公開repository metadataで検証して固定する。 */
export async function collectVerifiedExternalReferences(
  read: CollectionGitHubReadPort,
  observedAt: UtcIsoDateTime,
  previous: readonly VerifiedExternalReference[],
  candidates: readonly RelationCandidate[],
  details: readonly GitHubItemDetail[],
): Promise<readonly VerifiedExternalReference[]> {
  const excludedRepositories = new Set(
    details
      .flatMap(referencedItems)
      .filter((item) => item.repositoryArchived || item.repositoryDisabled)
      .map((item) => `${item.repositoryOwner}/${item.repositoryName}`.toLowerCase()),
  );
  const references = normalizeVerifiedExternalReferences([
    ...previous,
    ...candidates.flatMap((candidate) =>
      relationNodes(candidate.relation).flatMap((node) =>
        node.scope === "external_public" &&
        !excludedRepositories.has(`${node.repositoryOwner}/${node.repositoryName}`.toLowerCase())
          ? [
              {
                repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                number: node.number,
                url: node.url,
              },
            ]
          : [],
      ),
    ),
  ]);
  const fullNames = Object.freeze(
    [...new Set(references.map((reference) => reference.repositoryFullName.toLowerCase()))].sort(),
  );
  const repositories = await read.collectRepositoryMetadata(fullNames, observedAt);
  const byFullName = new Map(
    repositories.map((repository) => [
      `${repository.owner}/${repository.name}`.toLowerCase(),
      repository,
    ]),
  );
  if (repositories.length !== fullNames.length || byFullName.size !== fullNames.length) {
    throw new GitHubPublicBoundaryViolationError(1);
  }
  for (const fullName of fullNames) {
    const repository = byFullName.get(fullName);
    if (
      repository?.observedAt !== observedAt ||
      !isEligiblePublicRepository(repository) ||
      excludedRepositories.has(fullName)
    ) {
      throw new GitHubPublicBoundaryViolationError(1);
    }
  }
  return references;
}

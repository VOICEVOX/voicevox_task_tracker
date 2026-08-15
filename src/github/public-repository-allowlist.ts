import { z } from "zod";

import {
  createGitHubRepositoryId,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type Repository,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { GitHubPublicBoundaryViolationError, GitHubRepositoryInventoryError } from "./errors.js";

const publicRepositoryIdSchema = z
  .string()
  .transform((value) => createGitHubRepositoryId(value))
  .brand<"PublicRepositoryId">();

/** 公開allowlistを通過したGitHubリポジトリID。 */
export type PublicRepositoryId = z.output<typeof publicRepositoryIdSchema>;

/** 公開かつ稼働中であることを検証済みのリポジトリ。 */
export type PublicRepository = Readonly<{
  id: PublicRepositoryId;
  owner: string;
  name: string;
  visibility: "public";
  archived: false;
  disabled: false;
  observedAt: UtcIsoDateTime;
}>;

type EligiblePublicRepository = Repository &
  Readonly<{
    visibility: "public";
    archived: false;
    disabled: false;
  }>;

/** リポジトリが公開allowlistの条件を満たすか判定する。 */
export function isEligiblePublicRepository(
  repository: Repository,
): repository is EligiblePublicRepository {
  return repository.visibility === "public" && !repository.archived && !repository.disabled;
}

function createPublicRepository(repository: EligiblePublicRepository): PublicRepository {
  return Object.freeze({
    id: publicRepositoryIdSchema.parse(repository.id),
    owner: repository.owner,
    name: repository.name,
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt: repository.observedAt,
  });
}

/** 1回のrunで固定された公開リポジトリ集合。 */
export class PublicRepositoryAllowlist {
  readonly #repositories: readonly PublicRepository[];
  readonly #repositoriesById: ReadonlyMap<GitHubRepositoryId, PublicRepository>;

  private constructor(repositories: readonly PublicRepository[]) {
    this.#repositories = Object.freeze([...repositories]);
    this.#repositoriesById = new Map(
      this.#repositories.map((repository) => [repository.id, repository]),
    );
    Object.freeze(this);
  }

  /** リポジトリインベントリから変更不能な公開allowlistを生成する。 */
  public static create(inventory: readonly Repository[]): PublicRepositoryAllowlist {
    const repositories = inventory.filter(isEligiblePublicRepository).map(createPublicRepository);
    const repositoryIds = new Set(repositories.map((repository) => repository.id));
    if (repositoryIds.size !== repositories.length) {
      throw new GitHubRepositoryInventoryError({
        cause: new TypeError("公開リポジトリIDが重複しています"),
      });
    }
    return new PublicRepositoryAllowlist(repositories);
  }

  /** allowlist内の公開リポジトリを変更不能な配列で返す。 */
  public get repositories(): readonly PublicRepository[] {
    return this.#repositories;
  }

  /** リポジトリIDがallowlistに含まれるか判定する。 */
  public has(repositoryId: GitHubRepositoryId): repositoryId is PublicRepositoryId {
    return this.#repositoriesById.has(repositoryId);
  }

  /** リポジトリIDを公開リポジトリへ解決し、allowlist外なら失敗する。 */
  public require(repositoryId: GitHubRepositoryId): PublicRepository {
    const repository = this.#repositoriesById.get(repositoryId);
    if (repository == null) {
      throw new GitHubPublicBoundaryViolationError({
        scope: "generic",
        violationKind: "repository_id_not_allowlisted",
        violationCount: 1,
      });
    }
    return repository;
  }
}

/** インベントリからrun内で固定する公開allowlistを生成する。 */
export function createPublicRepositoryAllowlist(
  inventory: readonly Repository[],
): PublicRepositoryAllowlist {
  return PublicRepositoryAllowlist.create(inventory);
}

/** リポジトリID集合がすべて公開allowlist内であることを検証する。 */
export function assertPublicRepositoryBoundary(
  allowlist: PublicRepositoryAllowlist,
  repositoryIds: ReadonlySet<GitHubRepositoryId>,
): asserts repositoryIds is ReadonlySet<PublicRepositoryId> {
  let violationCount = 0;
  for (const repositoryId of repositoryIds) {
    if (!allowlist.has(repositoryId)) {
      violationCount += 1;
    }
  }
  if (violationCount > 0) {
    throw new GitHubPublicBoundaryViolationError({
      scope: "generic",
      violationKind: "repository_set_not_allowlisted",
      violationCount,
    });
  }
}

type CacheItemRelationBoundaryNode = Readonly<{
  scope: "organization" | "external_public";
  repositoryOwner: string;
  repositoryName: string;
}>;

type CacheItemRelationBoundaryRelation =
  | Readonly<{
      type: "blocks";
      blocker: CacheItemRelationBoundaryNode;
      blocked: CacheItemRelationBoundaryNode;
    }>
  | Readonly<{
      type: "parent_of";
      parent: CacheItemRelationBoundaryNode;
      subtask: CacheItemRelationBoundaryNode;
    }>
  | Readonly<{
      type: "implements";
      implementation: CacheItemRelationBoundaryNode;
      target: CacheItemRelationBoundaryNode;
    }>
  | Readonly<{
      type: "unclassified";
      referencing: CacheItemRelationBoundaryNode;
      referenced: CacheItemRelationBoundaryNode;
    }>;

type CacheItemRelationBoundaryReference = Readonly<{
  repositoryOwner: string;
  repositoryName: string;
}>;

type CacheItemRelationBoundaryMutation =
  | Readonly<{
      status: "unknown";
    }>
  | Readonly<{
      status: "available";
      currentReferences: readonly CacheItemRelationBoundaryReference[];
      replayedReferences: readonly CacheItemRelationBoundaryReference[];
      mutations: readonly Readonly<{
        relation: CacheItemRelationBoundaryReference;
      }>[];
      unmatchedRemovals: readonly Readonly<{
        relation: CacheItemRelationBoundaryReference;
      }>[];
      temporalKnowledge:
        | Readonly<{
            status: "exact";
            intervals: readonly Readonly<{
              relation: CacheItemRelationBoundaryReference;
            }>[];
          }>
        | Readonly<{
            status: "unknown";
          }>;
    }>;

type CacheItemRelationPublicBoundaryInput = Readonly<{
  sourceItemNodeId: GitHubNodeId;
  relationCandidates: readonly Readonly<{
    relation: CacheItemRelationBoundaryRelation;
  }>[];
  relationMutations: readonly CacheItemRelationBoundaryMutation[];
}>;

function isAllowlistedRepository(
  allowlist: PublicRepositoryAllowlist,
  owner: string,
  name: string,
): boolean {
  return allowlist.repositories.some(
    (repository) =>
      repository.owner.toLowerCase() === owner.toLowerCase() &&
      repository.name.toLowerCase() === name.toLowerCase(),
  );
}

function isAllowlistedOrganizationOwner(
  allowlist: PublicRepositoryAllowlist,
  owner: string,
): boolean {
  return allowlist.repositories.some(
    (repository) => repository.owner.toLowerCase() === owner.toLowerCase(),
  );
}

function relationCandidateNodes(
  relation: CacheItemRelationBoundaryRelation,
): readonly CacheItemRelationBoundaryNode[] {
  switch (relation.type) {
    case "blocks":
      return [relation.blocker, relation.blocked];
    case "parent_of":
      return [relation.parent, relation.subtask];
    case "implements":
      return [relation.implementation, relation.target];
    case "unclassified":
      return [relation.referencing, relation.referenced];
  }
}

function relationMutationReferences(
  result: Extract<CacheItemRelationBoundaryMutation, { status: "available" }>,
): readonly CacheItemRelationBoundaryReference[] {
  const references: CacheItemRelationBoundaryReference[] = [
    ...result.currentReferences,
    ...result.replayedReferences,
    ...result.mutations.map((mutation) => mutation.relation),
    ...result.unmatchedRemovals.map((mutation) => mutation.relation),
  ];
  if (result.temporalKnowledge.status === "exact") {
    references.push(...result.temporalKnowledge.intervals.map((interval) => interval.relation));
  }
  return references;
}

/** relation候補とmutationが公開allowlist内を参照することを検証する。 */
export function assertCacheItemRelationPublicBoundary(
  allowlist: PublicRepositoryAllowlist,
  input: CacheItemRelationPublicBoundaryInput,
): void {
  let candidateViolationCount = 0;
  for (const candidate of input.relationCandidates) {
    for (const node of relationCandidateNodes(candidate.relation)) {
      if (
        node.scope === "organization" &&
        !isAllowlistedRepository(allowlist, node.repositoryOwner, node.repositoryName)
      ) {
        candidateViolationCount += 1;
      }
    }
  }
  let mutationViolationCount = 0;
  for (const result of input.relationMutations) {
    if (result.status !== "available") {
      continue;
    }
    for (const reference of relationMutationReferences(result)) {
      if (
        isAllowlistedOrganizationOwner(allowlist, reference.repositoryOwner) &&
        !isAllowlistedRepository(allowlist, reference.repositoryOwner, reference.repositoryName)
      ) {
        mutationViolationCount += 1;
      }
    }
  }
  const violationCount = candidateViolationCount + mutationViolationCount;
  if (violationCount > 0) {
    let violationKind:
      | "cache_relation_candidate"
      | "cache_relation_mutation"
      | "cache_relation_candidate_and_mutation";
    if (candidateViolationCount > 0 && mutationViolationCount > 0) {
      violationKind = "cache_relation_candidate_and_mutation";
    } else if (candidateViolationCount > 0) {
      violationKind = "cache_relation_candidate";
    } else {
      violationKind = "cache_relation_mutation";
    }
    throw new GitHubPublicBoundaryViolationError({
      scope: "cache_item_relation",
      sourceItemNodeId: input.sourceItemNodeId,
      violationKind,
      violationCount,
    });
  }
}

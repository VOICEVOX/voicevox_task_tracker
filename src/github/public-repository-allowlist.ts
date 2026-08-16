import { z } from "zod";

import {
  createGitHubRepositoryId,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type Repository,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  createRelationMutationReferenceKey,
  type RelationMutationResult,
} from "../graph/relation-mutation.js";
import { type RelationTextReference } from "../graph/extract-relation-candidates.js";
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

type RelationMutationPublicBoundarySanitizerInput = Readonly<{
  sourceItemNodeId: GitHubNodeId;
  organization: string;
  allowlist: PublicRepositoryAllowlist;
  currentReferencesByContentSource: ReadonlyMap<
    SourceId,
    | Readonly<{
        status: "available";
        references: readonly RelationTextReference[];
      }>
    | Readonly<{
        status: "unknown";
      }>
  >;
  verifiedExternalReferencesByContentSource: ReadonlyMap<
    SourceId,
    readonly RelationTextReference[]
  >;
  canonicalReferencesByReferenceKey: ReadonlyMap<string, RelationTextReference>;
  relationMutations: readonly RelationMutationResult[];
}>;

type RelationMutationPublicBoundaryValidationInput = Omit<
  RelationMutationPublicBoundarySanitizerInput,
  "canonicalReferencesByReferenceKey"
>;

type AvailableRelationMutationResult = Extract<RelationMutationResult, { status: "available" }>;

type RelationMutationReference = AvailableRelationMutationResult["currentReferences"][number];

function isRelationPublicBoundaryViolation(
  allowlist: PublicRepositoryAllowlist,
  organization: string,
  verifiedExternalReferenceKeys: ReadonlySet<string>,
  reference: RelationMutationReference,
): boolean {
  if (reference.repositoryOwner.toLowerCase() === organization.toLowerCase()) {
    if (isAllowlistedRepository(allowlist, reference.repositoryOwner, reference.repositoryName)) {
      return false;
    }
  }
  return !verifiedExternalReferenceKeys.has(createRelationMutationReferenceKey(reference));
}

function canonicalRelationMutationReference(
  reference: RelationMutationReference,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  canonicalReferencesByReferenceKey: ReadonlyMap<string, RelationTextReference>,
): RelationMutationReference {
  const canonicalReference = canonicalReferencesByReferenceKey.get(
    createRelationMutationReferenceKey(reference),
  );
  if (canonicalReference != null) {
    return canonicalReference;
  }
  if (
    reference.repositoryOwner.toLowerCase() === organization.toLowerCase() &&
    isAllowlistedRepository(allowlist, reference.repositoryOwner, reference.repositoryName)
  ) {
    return reference;
  }
  throw new TypeError("relation mutationのcanonical参照証明がありません");
}

function canonicalizeRelationMutationResult(
  result: AvailableRelationMutationResult,
  organization: string,
  allowlist: PublicRepositoryAllowlist,
  canonicalReferencesByReferenceKey: ReadonlyMap<string, RelationTextReference>,
): AvailableRelationMutationResult {
  const currentReferences = Object.freeze(
    result.currentReferences.map((reference) =>
      canonicalRelationMutationReference(
        reference,
        organization,
        allowlist,
        canonicalReferencesByReferenceKey,
      ),
    ),
  );
  const replayedReferences = Object.freeze(
    result.replayedReferences.map((reference) =>
      canonicalRelationMutationReference(
        reference,
        organization,
        allowlist,
        canonicalReferencesByReferenceKey,
      ),
    ),
  );
  const mutations = Object.freeze(
    result.mutations.map((mutation) =>
      Object.freeze({
        ...mutation,
        relation: canonicalRelationMutationReference(
          mutation.relation,
          organization,
          allowlist,
          canonicalReferencesByReferenceKey,
        ),
      }),
    ),
  );
  const unmatchedRemovals = Object.freeze(
    result.unmatchedRemovals.map((mutation) =>
      Object.freeze({
        ...mutation,
        relation: canonicalRelationMutationReference(
          mutation.relation,
          organization,
          allowlist,
          canonicalReferencesByReferenceKey,
        ),
      }),
    ),
  );
  if (result.temporalKnowledge.status === "exact") {
    return Object.freeze({
      status: "available",
      contentSourceId: result.contentSourceId,
      currentReferences,
      replayedReferences,
      consistency: "consistent",
      temporalKnowledge: Object.freeze({
        status: "exact",
        intervals: Object.freeze(
          result.temporalKnowledge.intervals.map((interval) =>
            Object.freeze({
              ...interval,
              relation: canonicalRelationMutationReference(
                interval.relation,
                organization,
                allowlist,
                canonicalReferencesByReferenceKey,
              ),
            }),
          ),
        ),
      }),
      mutations,
      unmatchedRemovals,
    });
  }
  return Object.freeze({
    status: "available",
    contentSourceId: result.contentSourceId,
    currentReferences,
    replayedReferences,
    consistency: result.consistency,
    temporalKnowledge: Object.freeze({
      status: "unknown",
      reason: result.temporalKnowledge.reason,
    }),
    mutations,
    unmatchedRemovals,
  });
}

function relationMutationHistoryReferences(
  result: AvailableRelationMutationResult,
): readonly RelationMutationReference[] {
  const references: RelationMutationReference[] = [
    ...result.replayedReferences,
    ...result.mutations.map((mutation) => mutation.relation),
    ...result.unmatchedRemovals.map((mutation) => mutation.relation),
  ];
  if (result.temporalKnowledge.status === "exact") {
    references.push(...result.temporalKnowledge.intervals.map((interval) => interval.relation));
  }
  return references;
}

function unknownRelationMutationResult(
  contentSourceId: AvailableRelationMutationResult["contentSourceId"],
): RelationMutationResult {
  return Object.freeze({
    status: "unknown",
    contentSourceId,
    reason: "repository_public_boundary_unverified",
    edit: Object.freeze({ status: "unavailable" }),
  });
}

function validateRelationMutationsForPublicBoundary(
  input: RelationMutationPublicBoundaryValidationInput,
): Readonly<{ unknownContentSourceCount: number }> {
  const mutationContentSourceIds = new Set(
    input.relationMutations.map((result) => result.contentSourceId),
  );
  if (
    mutationContentSourceIds.size !== input.relationMutations.length ||
    mutationContentSourceIds.size !== input.currentReferencesByContentSource.size ||
    [...input.currentReferencesByContentSource.keys()].some(
      (contentSourceId) => !mutationContentSourceIds.has(contentSourceId),
    )
  ) {
    throw new TypeError("relation mutationの現在参照sourceが一致しません");
  }
  const currentViolationKeys = new Set<string>();
  for (const result of input.relationMutations) {
    const currentReferences = input.currentReferencesByContentSource.get(result.contentSourceId);
    if (currentReferences == null) {
      throw new TypeError("relation mutationの現在参照がありません");
    }
    if (currentReferences.status === "unknown") {
      if (result.status === "available") {
        throw new TypeError("relation mutationの現在参照を検証できません");
      }
      continue;
    }
    const verifiedExternalReferences = input.verifiedExternalReferencesByContentSource.get(
      result.contentSourceId,
    );
    if (verifiedExternalReferences == null) {
      throw new TypeError("relation mutationの公開参照証明がありません");
    }
    const verifiedExternalReferenceKeys = new Set(
      verifiedExternalReferences.map(createRelationMutationReferenceKey),
    );
    const references = new Map<string, RelationMutationReference>();
    for (const reference of currentReferences.references) {
      references.set(createRelationMutationReferenceKey(reference), reference);
    }
    if (result.status === "available") {
      for (const reference of result.currentReferences) {
        references.set(createRelationMutationReferenceKey(reference), reference);
      }
    }
    for (const reference of references.values()) {
      if (
        isRelationPublicBoundaryViolation(
          input.allowlist,
          input.organization,
          verifiedExternalReferenceKeys,
          reference,
        )
      ) {
        currentViolationKeys.add(createRelationMutationReferenceKey(reference));
      }
    }
  }
  if (currentViolationKeys.size > 0) {
    throw new GitHubPublicBoundaryViolationError({
      scope: "cache_item_relation",
      sourceItemNodeId: input.sourceItemNodeId,
      violationKind: "cache_relation_mutation",
      violationCount: currentViolationKeys.size,
    });
  }

  const unknownContentSourceIds = new Set<AvailableRelationMutationResult["contentSourceId"]>();
  for (const result of input.relationMutations) {
    if (result.status !== "available") {
      continue;
    }
    const verifiedExternalReferences = input.verifiedExternalReferencesByContentSource.get(
      result.contentSourceId,
    );
    if (verifiedExternalReferences == null) {
      throw new TypeError("relation mutationの公開参照証明がありません");
    }
    const verifiedExternalReferenceKeys = new Set(
      verifiedExternalReferences.map(createRelationMutationReferenceKey),
    );
    if (
      relationMutationHistoryReferences(result).some((reference) =>
        isRelationPublicBoundaryViolation(
          input.allowlist,
          input.organization,
          verifiedExternalReferenceKeys,
          reference,
        ),
      )
    ) {
      unknownContentSourceIds.add(result.contentSourceId);
    }
  }

  return Object.freeze({ unknownContentSourceCount: unknownContentSourceIds.size });
}

/** relation mutationの現在違反を拒否し、履歴だけの未証明参照をunknownへ変換する。 */
export function sanitizeRelationMutationsForPublicBoundary(
  input: RelationMutationPublicBoundarySanitizerInput,
): Readonly<{
  relationMutations: readonly RelationMutationResult[];
  unknownContentSourceCount: number;
}> {
  const validation = validateRelationMutationsForPublicBoundary(input);
  const relationMutations = input.relationMutations.map((result) => {
    if (result.status !== "available") {
      return result;
    }
    const verifiedExternalReferences = input.verifiedExternalReferencesByContentSource.get(
      result.contentSourceId,
    );
    if (verifiedExternalReferences == null) {
      throw new TypeError("relation mutationの公開参照証明がありません");
    }
    const verifiedExternalReferenceKeys = new Set(
      verifiedExternalReferences.map(createRelationMutationReferenceKey),
    );
    if (
      relationMutationHistoryReferences(result).some((reference) =>
        isRelationPublicBoundaryViolation(
          input.allowlist,
          input.organization,
          verifiedExternalReferenceKeys,
          reference,
        ),
      )
    ) {
      return unknownRelationMutationResult(result.contentSourceId);
    }
    return canonicalizeRelationMutationResult(
      result,
      input.organization,
      input.allowlist,
      input.canonicalReferencesByReferenceKey,
    );
  });

  return Object.freeze({
    relationMutations: Object.freeze(relationMutations),
    unknownContentSourceCount: validation.unknownContentSourceCount,
  });
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
function assertCacheItemRelationPublicBoundaryInternal(
  allowlist: PublicRepositoryAllowlist,
  input: CacheItemRelationPublicBoundaryInput,
  mode: "strict" | "production_pending",
): void {
  let candidateViolationCount = 0;
  for (const candidate of input.relationCandidates) {
    for (const node of relationCandidateNodes(candidate.relation)) {
      if (
        node.scope === "organization" &&
        mode === "strict" &&
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
        mode === "strict" &&
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

/** relation候補とmutationの未検証aliasをresolver前提で検証する。 */
export function assertCacheItemRelationPublicBoundary(
  allowlist: PublicRepositoryAllowlist,
  input: CacheItemRelationPublicBoundaryInput,
): void {
  assertCacheItemRelationPublicBoundaryInternal(allowlist, input, "strict");
}

/** cache読み込み時のresolver前提relation aliasを検証する。 */
export function assertCacheItemRelationPublicBoundaryForCacheLoad(
  allowlist: PublicRepositoryAllowlist,
  input: CacheItemRelationPublicBoundaryInput,
): void {
  assertCacheItemRelationPublicBoundaryInternal(allowlist, input, "production_pending");
}

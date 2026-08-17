import { z } from "zod";

import {
  createGitHubRepositoryId,
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
      throw new GitHubPublicBoundaryViolationError(1);
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
    throw new GitHubPublicBoundaryViolationError(violationCount);
  }
}

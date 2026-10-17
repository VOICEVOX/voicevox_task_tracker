import type { GitHubRepositoryId } from "../../../domain/index.js";
import type { PublicRepository } from "../../../github/index.js";
import { assertNonNullable } from "../../../util/index.js";

/** リポジトリの完全名を返す。 */
export function repositoryFullName(repository: PublicRepository): string {
  return `${repository.owner}/${repository.name}`;
}

/** 公開allowlistからリポジトリを取得する。 */
export function findRepository(
  repositories: readonly PublicRepository[],
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  const repository = repositories.find((value) => value.id === repositoryId);
  assertNonNullable(repository, `公開repository集合に対象がありません。対象: ${repositoryId}`);
  return repository;
}

import type { GitHubRepositoryId } from "../../../domain/index.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GraphWorkingInventory } from "./graph-reconciliation-contracts.js";

/** 公開リポジトリの完全名を返す。 */
export function repositoryFullName(repository: PublicRepository): string {
  return `${repository.owner}/${repository.name}`;
}

/** 選定済みの公開リポジトリを取得する。 */
export function findRepository(
  inventory: GraphWorkingInventory,
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  const repository = inventory.repositories.find((item) => item.id === repositoryId);
  assertNonNullable(repository, `公開repositoryがありません。対象: ${repositoryId}`);
  return repository;
}

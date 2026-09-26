import type { GitHubRepositoryId } from "../../domain/index.js";
import type { PublicRepository } from "../../github/index.js";
import type { RepositoryInventory } from "./contracts.js";

/** リポジトリの完全名を返す。 */
export function repositoryFullName(repository: PublicRepository): string {
  return `${repository.owner}/${repository.name}`;
}

/** 公開allowlistからリポジトリを取得する。 */
export function findRepository(
  inventory: RepositoryInventory,
  repositoryId: GitHubRepositoryId,
): PublicRepository {
  return inventory.allowlist.require(repositoryId);
}

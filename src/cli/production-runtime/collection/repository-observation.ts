import type { UtcIsoDateTime } from "../../../domain/index.js";
import type {
  EnumeratedGitHubItem,
  FreshObservedGitHubItem,
  GitHubItemDetail,
  RepositoryCollectionResult,
} from "../../../github/index.js";
import type {
  SnapshotCollectionItem,
  SnapshotCollectionRepository,
} from "../../../persistence/index.js";

/** 列挙項目の観測時刻を確定する。 */
export function finalizeEnumeratedItemObservation(
  item: EnumeratedGitHubItem,
  evaluatedAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    observedAt: evaluatedAt,
  } satisfies EnumeratedGitHubItem);
}

/** 詳細項目の観測時刻を確定する。 */
export function finalizeItemDetailObservation(
  detail: GitHubItemDetail,
  evaluatedAt: UtcIsoDateTime,
): GitHubItemDetail {
  return Object.freeze({
    ...detail,
    observedAt: evaluatedAt,
  } satisfies GitHubItemDetail);
}

/** 観測項目の観測時刻を確定する。 */
export function finalizeObservedItemObservation(
  item: FreshObservedGitHubItem,
  evaluatedAt: UtcIsoDateTime,
): FreshObservedGitHubItem {
  return Object.freeze({
    ...item,
    observedAt: evaluatedAt,
  } satisfies FreshObservedGitHubItem);
}

function finalizeSnapshotCollectionRepository(
  repository: SnapshotCollectionRepository,
  evaluatedAt: UtcIsoDateTime,
): SnapshotCollectionRepository {
  return Object.freeze({
    ...repository,
    successfulAt: evaluatedAt,
    items: Object.freeze(
      repository.items.map((item) =>
        Object.freeze({
          ...item,
          observedAt: evaluatedAt,
        } satisfies SnapshotCollectionItem),
      ),
    ),
  });
}

/** リポジトリ収集結果の観測時刻を確定する。 */
export function finalizeRepositoryCollectionResult(
  result: RepositoryCollectionResult<SnapshotCollectionRepository>,
  evaluatedAt: UtcIsoDateTime,
): RepositoryCollectionResult<SnapshotCollectionRepository> {
  if (result.freshness === "fresh") {
    return Object.freeze({
      ...result,
      value: finalizeSnapshotCollectionRepository(result.value, evaluatedAt),
      observedAt: evaluatedAt,
    });
  }
  return result;
}

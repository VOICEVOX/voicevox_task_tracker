import type { UtcIsoDateTime } from "../../../domain/index.js";
import type { RepositoryCollectionResult } from "./collection-stale.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type {
  PreviousCollectionItem,
  PreviousCollectionRepository,
} from "../contracts/previous-state.js";

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

function finalizePreviousCollectionRepository(
  repository: PreviousCollectionRepository,
  evaluatedAt: UtcIsoDateTime,
): PreviousCollectionRepository {
  return Object.freeze({
    ...repository,
    successfulAt: evaluatedAt,
    items: Object.freeze(
      repository.items.map((item) =>
        Object.freeze({
          ...item,
          observedAt: evaluatedAt,
        } satisfies PreviousCollectionItem),
      ),
    ),
  });
}

/** リポジトリ収集結果の観測時刻を確定する。 */
export function finalizeRepositoryCollectionResult(
  result: RepositoryCollectionResult<PreviousCollectionRepository>,
  evaluatedAt: UtcIsoDateTime,
): RepositoryCollectionResult<PreviousCollectionRepository> {
  if (result.freshness === "fresh") {
    return Object.freeze({
      ...result,
      value: finalizePreviousCollectionRepository(result.value, evaluatedAt),
      observedAt: evaluatedAt,
    });
  }
  return result;
}

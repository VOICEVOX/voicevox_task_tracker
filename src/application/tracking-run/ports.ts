import type { Repository } from "../../domain/index.js";
import type { BotPredicate } from "../../domain/actor-resolution.js";
import type { GitHubNodeId, GitHubRepositoryId, UtcIsoDateTime } from "../../domain/types.js";
import type { PublicRepository } from "../../github/public-repository-allowlist.js";
import type { EnumeratedGitHubItem } from "../../github/item-enumeration.js";
import type {
  GitHubItemDetail,
  LegacyReviewRequestInspection,
} from "../../github/item-detail-types.js";
import type { FreshObservedGitHubItem } from "../../github/item-normalization.js";
import type { SourceId } from "../../domain/source-id.js";
import type { GitHubRateLimitSnapshot } from "../../github/errors.js";

/** 判定に用いる現在時刻を供給する。 */
export type ClockPort = Readonly<{
  now: () => UtcIsoDateTime;
}>;

/** 再試行までの待機を実行する。 */
export type DelayPort = Readonly<{
  sleep: (delayMilliseconds: number) => Promise<void>;
}>;

type GitHubReadItem = Readonly<{
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
}>;

type GitHubReadDetail = Readonly<{ nodeId: GitHubNodeId }>;

/** 固定済み公開repository集合のGitHub読取結果だけを返す。 */
export type GitHubReadPort<
  Item extends GitHubReadItem,
  Detail extends GitHubReadDetail,
  ObservedItem extends GitHubReadItem,
  RateLimitSnapshot extends Readonly<{ source: "rest" | "graphql"; remaining: number }>,
> = Readonly<{
  enumerateOpen: (
    repositories: readonly PublicRepository[],
    observedAt: UtcIsoDateTime,
  ) => Promise<readonly Item[]>;
  enumerateByIdentifiers: (
    identifiers: readonly string[],
    observedAt: UtcIsoDateTime,
  ) => Promise<readonly Item[]>;
  collectDetails: (
    targets: readonly Readonly<{ item: Item }>[],
    observedAt: UtcIsoDateTime,
    isBot: BotPredicate,
  ) => Promise<Readonly<{ details: readonly Detail[]; observedItems: readonly ObservedItem[] }>>;
  rateLimitSnapshot: () => RateLimitSnapshot | undefined;
}>;

/** 収集段階が使う正規化済みGitHub読取境界。 */
export type CollectionGitHubReadPort = GitHubReadPort<
  EnumeratedGitHubItem,
  GitHubItemDetail,
  FreshObservedGitHubItem,
  GitHubRateLimitSnapshot
> &
  Readonly<{
    collectRepositoryMetadata: (
      repositoryFullNames: readonly string[],
      observedAt: UtcIsoDateTime,
    ) => Promise<readonly Repository[]>;
    inspectLegacyReviewRequests: (
      sourceIds: readonly SourceId[],
    ) => Promise<readonly LegacyReviewRequestInspection[]>;
  }>;

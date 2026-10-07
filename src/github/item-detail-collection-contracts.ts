import { type UtcIsoDateTime } from "../domain/index.js";
import type { Graphql } from "./item-detail-response-schema.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import { type PublicRepositoryAllowlist } from "./public-repository-allowlist.js";

/** 詳細取得対象のGitHub項目。 */
export type GitHubItemDetailTarget = Readonly<{
  item: EnumeratedGitHubItem;
}>;

export type CollectGitHubItemDetailsOptions = Readonly<{
  allowlist: PublicRepositoryAllowlist;
  targets: readonly GitHubItemDetailTarget[];
  observedAt: UtcIsoDateTime;
  graphql: Graphql;
}>;

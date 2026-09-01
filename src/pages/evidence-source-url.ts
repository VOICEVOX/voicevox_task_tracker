import {
  parseSourceId,
  type GitHubNodeId,
  type GitHubItemUrl,
  type SourceId,
  type TrackedItemInputEvent,
} from "../domain/index.js";
import {
  isProductionSourceIdKind,
  type ProductionSourceIdKind,
} from "../github/production-source-id.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

type EvidenceSourceUrlInput = TrackedItemInputEvent &
  Readonly<{
    itemNodeId: GitHubNodeId;
    itemUrl: GitHubItemUrl;
  }>;

type EvidenceSourceItem = Readonly<{
  nodeId: GitHubNodeId;
  url: GitHubItemUrl;
}>;

type EvidenceSourceOwner = Readonly<{
  itemNodeId: GitHubNodeId;
  itemUrl: GitHubItemUrl;
  sourceUrl: GitHubItemUrl;
}>;

export type EvidenceSourceUrlMap = ReadonlyMap<SourceId, readonly EvidenceSourceOwner[]>;

function directSourceUrl(
  sourceId: SourceId,
  sourceOwnersById: EvidenceSourceUrlMap,
  fragmentPrefix: string,
): GitHubItemUrl {
  const sourceOwners = sourceOwnersById.get(sourceId);
  if (sourceOwners == null || sourceOwners.length === 0) {
    throw new TypeError(`個別sourceを所有する項目がありません。source: ${sourceId}`);
  }
  if (sourceOwners.length !== 1) {
    throw new TypeError(
      `個別sourceを所有する項目が複数あります。source: ${sourceId}、所有項目: ${sourceOwners.map((owner) => owner.itemNodeId).join("、")}`,
    );
  }
  const sourceOwner = sourceOwners[0];
  assertNonNullable(sourceOwner, `個別sourceの所有項目がありません。source: ${sourceId}`);
  const item = new URL(sourceOwner.itemUrl);
  const source = new URL(sourceOwner.sourceUrl);
  if (source.origin !== item.origin || source.pathname !== item.pathname) {
    throw new TypeError(`個別sourceのURLが項目URLと一致しません。対象: ${sourceId}`);
  }
  if (!source.hash.startsWith(fragmentPrefix) || source.hash.length === fragmentPrefix.length) {
    throw new TypeError(`個別sourceのURLに対応するanchorがありません。対象: ${sourceId}`);
  }
  return sourceOwner.sourceUrl;
}

function itemSourceUrl(
  sourceId: SourceId,
  sourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): GitHubItemUrl {
  const sourceOwners = sourceOwnersById.get(sourceId);
  if (sourceOwners != null) {
    for (const sourceItem of sourceItems) {
      if (sourceOwners.some((owner) => owner.itemNodeId === sourceItem.nodeId)) {
        return sourceItem.url;
      }
    }
  }
  const sourceItem = sourceItems[0];
  assertNonNullable(
    sourceItem,
    `sourceに対応するOrganization内itemがありません。source: ${sourceId}`,
  );
  return sourceItem.url;
}

/** 入力イベントをsource IDごとの所有項目とURLのMapへ変換する。 */
export function createEvidenceSourceUrlMap(
  inputEvents: readonly EvidenceSourceUrlInput[],
): EvidenceSourceUrlMap {
  const sourceOwnersById = new Map<SourceId, EvidenceSourceOwner[]>();
  for (const event of inputEvents) {
    let sourceOwners = sourceOwnersById.get(event.sourceId);
    if (sourceOwners == null) {
      sourceOwners = [];
      sourceOwnersById.set(event.sourceId, sourceOwners);
    }
    const previousOwner = sourceOwners.find((owner) => owner.itemNodeId === event.itemNodeId);
    if (previousOwner == null) {
      sourceOwners.push({
        itemNodeId: event.itemNodeId,
        itemUrl: event.itemUrl,
        sourceUrl: event.url,
      });
      continue;
    }
    if (previousOwner.sourceUrl !== event.url) {
      throw new TypeError(
        `同じ項目とsource IDの組に異なるURLがあります。対象項目: ${event.itemNodeId}、source: ${event.sourceId}`,
      );
    }
    throw new TypeError(
      `同じ項目とsource IDの入力イベントが複数あります。対象項目: ${event.itemNodeId}、source: ${event.sourceId}`,
    );
  }
  return sourceOwnersById;
}

function resolveProductionEvidenceSourceUrl(
  kind: ProductionSourceIdKind,
  sourceId: SourceId,
  sourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): GitHubItemUrl {
  if (kind === "github_item" || kind === "github_item_body" || kind === "github_item_detail") {
    const itemNodeId = parseSourceId(sourceId).originalId;
    const item = sourceItems.find((sourceItem) => sourceItem.nodeId === itemNodeId);
    if (item != null) {
      return item.url;
    }
  }
  switch (kind) {
    case "github_issue_comment":
      return directSourceUrl(sourceId, sourceOwnersById, "#issuecomment-");
    case "github_pull_request_review":
      return directSourceUrl(sourceId, sourceOwnersById, "#pullrequestreview-");
    case "github_pull_request_review_comment":
      return directSourceUrl(sourceId, sourceOwnersById, "#discussion_r");
    case "github_actor":
    case "github_user":
    case "github_team":
    case "github_item":
    case "github_commit":
    case "github_timeline_event":
    case "github_label":
    case "github_inbound_cross_reference":
    case "github_pull_request_review_thread":
    case "github_review_request":
    case "github_native_closing_issue":
    case "github_native_dependency":
    case "github_native_hierarchy":
    case "github_check_run":
    case "github_commit_status":
    case "github_status_check_rollup":
    case "github_auto_merge_request":
    case "github_merge_queue_entry":
    case "github_item_detail":
    case "github_item_body":
      return itemSourceUrl(sourceId, sourceItems, sourceOwnersById);
    default:
      throw new UnreachableError(kind);
  }
}

/** source IDの種別から公開evidenceが参照するGitHub URLを解決する。 */
export function resolveEvidenceSourceUrl(
  sourceId: SourceId,
  sourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): GitHubItemUrl {
  const { kind } = parseSourceId(sourceId);
  if (isProductionSourceIdKind(kind)) {
    return resolveProductionEvidenceSourceUrl(kind, sourceId, sourceItems, sourceOwnersById);
  }
  switch (kind) {
    case "github_account":
    case "github_check_rollup":
    case "body":
    case "golden_event":
    case "golden_item":
    case "golden_review_request":
    case "golden_team":
    case "golden_checks":
    case "golden_commit":
    case "golden_relation":
    case "golden_ai_source":
    case "golden_large":
    case "golden_large_edge":
      return itemSourceUrl(sourceId, sourceItems, sourceOwnersById);
    default:
      throw new TypeError(`公開evidence URLへ解決できないsource ID種別です。対象: ${kind}`);
  }
}

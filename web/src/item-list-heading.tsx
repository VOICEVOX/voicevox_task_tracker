import { UnreachableError } from "../../src/util/index.js";
import { AiAnalysisNoticeIcon } from "./ai-analysis-notice-icon.js";
import { GitHubIconButton } from "./github-icon-button.js";
import { ItemDetailsLink } from "./item-details.js";
import { aiAnalysisNotice, type ItemTableRow } from "./model.js";
import { Pill } from "./ui.js";

type ItemListHeadingProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  onSelectItem: (nodeId: string) => void;
  row: ItemTableRow;
  showFreshnessBadge: boolean;
}>;

function itemTypeTone(type: ItemTableRow["item"]["type"]): "info" | "success" {
  switch (type) {
    case "issue":
      return "success";
    case "pull_request":
      return "info";
    default:
      throw new UnreachableError(type);
  }
}

/** 一覧に共通する項目タイトルと補助情報を表示する。 */
export function ItemListHeading({
  createItemHref,
  onSelectItem,
  row,
  showFreshnessBadge,
}: ItemListHeadingProps) {
  return (
    <div class="item-list-heading grid min-w-0 gap-1">
      <h3 class="item-list-title m-0 flex min-w-0 items-start gap-1 text-base leading-6 font-semibold">
        <span class="min-w-0 flex-1 wrap-anywhere">
          <ItemDetailsLink
            href={createItemHref(row.item.nodeId)}
            nodeId={row.item.nodeId}
            onSelect={onSelectItem}
          >
            {row.item.title}
          </ItemDetailsLink>
        </span>
        <AiAnalysisNoticeIcon notice={aiAnalysisNotice(row.item.aiAnalysis.status)} />
        <GitHubIconButton href={row.item.url} />
      </h3>
      <p class="item-list-meta m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 font-normal text-text-muted wrap-anywhere">
        <span class="inline-flex min-w-0 flex-wrap items-center gap-1">
          <span>{row.item.displayReference}</span>
          <span aria-hidden="true">・</span>
          <Pill
            className={`item-type-badge item-type-${row.item.type}`}
            tone={itemTypeTone(row.item.type)}
          >
            {row.typeText}
          </Pill>
        </span>
        {showFreshnessBadge && row.item.repositoryFreshness === "stale" && (
          <Pill className="freshness-badge freshness-stale" tone="warning">
            古い観測値
          </Pill>
        )}
      </p>
    </div>
  );
}

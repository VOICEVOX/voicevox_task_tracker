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
        <span>
          <span>{row.item.displayReference}</span>・<span>{row.typeText}</span>
        </span>
        {showFreshnessBadge && row.item.repositoryFreshness === "stale" && (
          <Pill className="freshness-badge freshness-stale" tone="warning" variant="filled">
            古い観測値
          </Pill>
        )}
      </p>
    </div>
  );
}

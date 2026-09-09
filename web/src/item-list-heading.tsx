import { type ComponentChildren } from "preact";

import { UnreachableError } from "../../src/util/index.js";
import { AiAnalysisNoticeIcon } from "./ai-analysis-notice-icon.js";
import { GitHubIconButton } from "./github-icon-button.js";
import { ItemDetailsLink } from "./item-details.js";
import { aiAnalysisNotice, type ItemTableRow } from "./model.js";
import { Pill } from "./ui.js";

type ItemHeadingItem = Readonly<{
  displayReference: string;
  nodeId: string;
  title: string;
  type: "issue" | "pull_request";
  url: string;
}>;

export type ItemHeadingLink =
  | Readonly<{
      createItemHref: (nodeId: string) => string;
      kind: "internal";
      onSelectItem: (nodeId: string) => void;
    }>
  | Readonly<{
      kind: "text";
    }>;

type ItemHeadingProps = Readonly<{
  item: ItemHeadingItem;
  link: ItemHeadingLink;
  metaAccessory: ComponentChildren;
  titleAccessory: ComponentChildren;
}>;

type ItemListHeadingProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  onSelectItem: (nodeId: string) => void;
  row: ItemTableRow;
  showFreshnessBadge: boolean;
}>;

function itemTypeTone(type: ItemHeadingItem["type"]): "info" | "success" {
  switch (type) {
    case "issue":
      return "success";
    case "pull_request":
      return "info";
    default:
      throw new UnreachableError(type);
  }
}

function itemTypeLabel(type: ItemHeadingItem["type"]): string {
  switch (type) {
    case "issue":
      return "Issue";
    case "pull_request":
      return "Pull Request";
    default:
      throw new UnreachableError(type);
  }
}

/** 項目見出しに共通するタイトルと補助情報を表示する。 */
export function ItemHeading({ item, link, metaAccessory, titleAccessory }: ItemHeadingProps) {
  let title: ComponentChildren;
  switch (link.kind) {
    case "internal":
      title = (
        <ItemDetailsLink
          href={link.createItemHref(item.nodeId)}
          nodeId={item.nodeId}
          onSelect={link.onSelectItem}
        >
          {item.title}
        </ItemDetailsLink>
      );
      break;
    case "text":
      title = item.title;
      break;
    default:
      throw new UnreachableError(link);
  }

  return (
    <div class="item-list-heading grid min-w-0 gap-1">
      <h3 class="item-list-title m-0 flex min-w-0 items-start gap-1 text-base leading-6 font-semibold">
        <span class="min-w-0 flex-1 wrap-anywhere">{title}</span>
        {titleAccessory}
        <GitHubIconButton href={item.url} />
      </h3>
      <p class="item-list-meta m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 font-normal text-text-muted wrap-anywhere">
        <span class="inline-flex min-w-0 flex-wrap items-center gap-1">
          <span>{item.displayReference}</span>
          <span aria-hidden="true">・</span>
          <Pill className={`item-type-badge item-type-${item.type}`} tone={itemTypeTone(item.type)}>
            {itemTypeLabel(item.type)}
          </Pill>
        </span>
        {metaAccessory}
      </p>
    </div>
  );
}

/** 一覧に共通する項目タイトルと補助情報を表示する。 */
export function ItemListHeading({
  createItemHref,
  onSelectItem,
  row,
  showFreshnessBadge,
}: ItemListHeadingProps) {
  return (
    <ItemHeading
      item={row.item}
      link={{
        createItemHref,
        kind: "internal",
        onSelectItem,
      }}
      metaAccessory={
        showFreshnessBadge && row.item.repositoryFreshness === "stale" ? (
          <Pill className="freshness-badge freshness-stale" tone="warning">
            古い観測値
          </Pill>
        ) : null
      }
      titleAccessory={
        <AiAnalysisNoticeIcon notice={aiAnalysisNotice(row.item.aiAnalysis.status)} />
      }
    />
  );
}

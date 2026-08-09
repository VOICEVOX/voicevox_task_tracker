import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { ItemListHeading } from "./item-list-heading.js";
import { ContentState, PageSection } from "./layout.js";
import { ListCountSummary } from "./list-count-summary.js";
import {
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  filterAttentionItems,
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  formatWaitingOn,
  formatWaitingOnCandidate,
  selectPrimaryWaitingOnCandidate,
  type ItemSort,
  type ItemSortKey,
  type ItemTableRow,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { ITEM_SORT_OPTIONS, SortControls } from "./sort-controls.js";

const MAX_STALE_REPOSITORY_NAMES = 3;
const OVERVIEW_NOTICE_CLASS_NAME =
  "notice m-0 rounded-md border-l-2 bg-surface-card px-3 py-2 text-sm leading-5 text-text-secondary";

type OverviewPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  locale: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  onSortChange: (key: ItemSortKey) => void;
  sort: ItemSort;
  summary: PublicSummaryDto;
}>;

type RelativeTimeDisplayProps = Readonly<{
  locale: string;
  now: Date;
  timezone: string;
  value: string;
}>;

function RelativeTimeDisplay({ locale, now, timezone, value }: RelativeTimeDisplayProps) {
  return (
    <time class="font-bold" dateTime={value} title={formatDateTime(value, timezone, locale)}>
      {formatRelativeTime(value, now, locale)}
    </time>
  );
}

function AiStateNotice() {
  return (
    <p
      class={`${OVERVIEW_NOTICE_CLASS_NAME} ai-state-notice border-state-info-border`}
      role="status"
    >
      AI分析は設定で無効です。確定ルールで表示しています。
    </p>
  );
}

function formatStaleRepositoryNames(
  repositories: PublicSummaryDto["repositories"],
  locale: string,
): string {
  const visibleNames = repositories
    .slice(0, MAX_STALE_REPOSITORY_NAMES)
    .map((repository) => repository.fullName);
  const remainingCount = repositories.length - visibleNames.length;
  if (remainingCount === 0) {
    return visibleNames.join("、");
  }
  return `${visibleNames.join("、")}、ほか${remainingCount.toLocaleString(locale)}件`;
}

function sortAttentionItems(
  summary: PublicSummaryDto,
  now: Date,
  sort: ItemSort,
): readonly ItemTableRow[] {
  const attentionItems = filterAttentionItems(summary.items);
  const attentionItemNodeIds = new Set(attentionItems.map((item) => item.nodeId));
  return filterAndSortTableRows(
    createItemTableRows(summary, now).filter((row) => attentionItemNodeIds.has(row.item.nodeId)),
    createEmptyTableFilters(),
    sort,
  );
}

function attentionRowPresentation(row: ItemTableRow): ResponsiveListRowPresentation {
  return {
    cardClassName: "attention-item bg-surface-card",
    dataAttributes: {
      "data-node-id": row.item.nodeId,
    },
    key: row.item.nodeId,
    tableClassName: "attention-row",
  };
}

function OverviewWaitingOn({
  locale,
  row,
  summary,
}: Readonly<{
  locale: string;
  row: ItemTableRow;
  summary: PublicSummaryDto;
}>) {
  const primaryWaitingOn = selectPrimaryWaitingOnCandidate(row.item);
  const primaryWaitingOnLabel =
    primaryWaitingOn == null
      ? formatWaitingOn(row.item, summary)
      : formatWaitingOnCandidate(primaryWaitingOn, row.item, summary);
  const otherWaitingOnCount = primaryWaitingOn == null ? 0 : row.item.waitingOn.length - 1;
  return (
    <div class="attention-waiting-on min-w-0">
      <span class="attention-waiting-on-summary flex min-w-0 items-baseline gap-2">
        <strong class="attention-primary-waiting-on min-w-0 flex-1 leading-snug wrap-anywhere">
          {primaryWaitingOnLabel}
        </strong>
        {otherWaitingOnCount > 0 && (
          <span class="attention-other-waiting-on flex-none text-xs text-text-muted whitespace-nowrap">
            ほか{otherWaitingOnCount.toLocaleString(locale)}件
          </span>
        )}
      </span>
      {primaryWaitingOn != null && (
        <span
          class="attention-waiting-reason mt-1 block min-w-0 text-sm leading-5 text-text-muted wrap-anywhere"
          title={primaryWaitingOn.reasonSummary}
        >
          {primaryWaitingOn.reasonSummary}
        </span>
      )}
    </div>
  );
}

function AttentionQueue({
  attentionItems,
  createItemHref,
  locale,
  now,
  onSelectItem,
  onSortChange,
  sort,
  summary,
}: OverviewPageProps &
  Readonly<{
    attentionItems: readonly ItemTableRow[];
  }>) {
  const tableColumns = [
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "row_header",
      headerClassName: "whitespace-nowrap",
      key: "item",
      label: "項目",
      renderCell: (row: ItemTableRow) => (
        <ItemListHeading
          createItemHref={createItemHref}
          onSelectItem={onSelectItem}
          row={row}
          showFreshnessBadge={false}
        />
      ),
      widthClassName: "w-[36%]",
    },
    {
      ariaSort: sort.key === "attention" ? sort.direction : "none",
      cellClassName: "attention-cell whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "attention",
      label: "要対応度",
      onSort: () => {
        onSortChange("attention");
      },
      renderCell: (row: ItemTableRow) => (
        <AttentionBadge attention={row.item.attention} showLabel={false} showScore={false} />
      ),
      widthClassName: "w-[13%]",
    },
    {
      ariaSort: sort.key === "importance" ? sort.direction : "none",
      cellClassName: "importance-cell whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "importance",
      label: "重要度",
      onSort: () => {
        onSortChange("importance");
      },
      renderCell: (row: ItemTableRow) => (
        <ImportanceBadge importance={row.item.importance} showLabel={false} showScore={false} />
      ),
      widthClassName: "w-[11%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "leading-6 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "waitingOn",
      label: "待ち相手",
      renderCell: (row: ItemTableRow) => (
        <OverviewWaitingOn locale={locale} row={row} summary={summary} />
      ),
      widthClassName: "w-[27%]",
    },
    {
      ariaSort: sort.key === "stall" ? sort.direction : "none",
      cellClassName: "whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "stall",
      label: "停滞時間",
      onSort: () => {
        onSortChange("stall");
      },
      renderCell: (row: ItemTableRow) => (
        <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
      ),
      widthClassName: "w-[13%]",
    },
  ] satisfies readonly ResponsiveTableColumn<ItemTableRow>[];
  const cardFields = [
    {
      className: "",
      key: "attention",
      label: "要対応度",
      renderValue: (row: ItemTableRow) => (
        <AttentionBadge attention={row.item.attention} showLabel={false} showScore={false} />
      ),
      valueClassName: "font-semibold text-text-primary",
    },
    {
      className: "",
      key: "importance",
      label: "重要度",
      renderValue: (row: ItemTableRow) => (
        <ImportanceBadge importance={row.item.importance} showLabel={false} showScore={false} />
      ),
      valueClassName: "font-semibold text-text-primary",
    },
    {
      className: "col-span-full border-t border-border-subtle pt-3",
      key: "waitingOn",
      label: "待ち相手",
      renderValue: (row: ItemTableRow) => (
        <OverviewWaitingOn locale={locale} row={row} summary={summary} />
      ),
      valueClassName: "leading-6 text-text-primary",
    },
    {
      className: "",
      key: "stall",
      label: "停滞時間",
      renderValue: (row: ItemTableRow) => formatStallDuration(row.item.stallSince, now),
      valueClassName: "font-semibold text-text-primary tabular-nums",
    },
  ] satisfies readonly ResponsiveCardField<ItemTableRow>[];

  return (
    <PageSection
      className="attention-section"
      description="要対応度は、重要度が高く、かつ最近動きがあった項目ほど高くなります。高または中の項目を表示します。"
      heading="対応が必要な項目"
      headingAccessory={
        <div class="attention-heading attention-heading-metadata max-shell:-mt-2">
          <p class="overview-observed-time m-0 grid justify-items-end text-right max-shell:justify-items-start max-shell:text-left">
            <span class="time-label text-xs font-bold text-text-muted">データ観測</span>
            <RelativeTimeDisplay
              value={summary.observedAt}
              now={now}
              timezone={summary.timezone}
              locale={locale}
            />
          </p>
        </div>
      }
      headingId="attention-heading"
    >
      <div class="item-list-controls mb-4 flex flex-wrap items-end justify-between gap-4">
        <ListCountSummary
          className="item-list-count attention-summary"
          count={attentionItems.length}
          locale={locale}
          sort={sort}
        />
        <SortControls
          className="item-list-sort-controls overview-sort-controls grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 sm:w-auto sm:min-w-64"
          onSortChange={onSortChange}
          options={ITEM_SORT_OPTIONS}
          selectId="overview-sort-key"
          sort={sort}
        />
      </div>
      {attentionItems.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在、対応が必要な項目はありません。"
          status="empty"
        />
      ) : (
        <ResponsiveTableCardList
          breakpoint="lg"
          cardAriaLabel="対応が必要な項目一覧"
          cardFields={cardFields}
          cardListClassName="attention-list"
          columns={tableColumns}
          getRowPresentation={attentionRowPresentation}
          rows={attentionItems}
          tableCaption="対応が必要な項目の一覧"
          tableClassName="attention-table"
          renderCardHeading={(row) => (
            <div class="attention-title min-w-0">
              <ItemListHeading
                createItemHref={createItemHref}
                onSelectItem={onSelectItem}
                row={row}
                showFreshnessBadge={false}
              />
            </div>
          )}
          renderCardFooter={() => null}
        />
      )}
    </PageSection>
  );
}

/** 対応が必要な項目を表示する。 */
export function OverviewPage(props: OverviewPageProps) {
  const attentionItems = sortAttentionItems(props.summary, props.now, props.sort);
  const staleRepositories = props.summary.repositories.filter(
    (repository) => repository.freshness.status === "stale",
  );
  const aiStateNoticeVisible = !props.summary.ai.enabled;
  const statusNoticesVisible = aiStateNoticeVisible || staleRepositories.length > 0;
  return (
    <>
      {statusNoticesVisible && (
        <div class="overview-notices grid gap-2">
          {aiStateNoticeVisible && <AiStateNotice />}
          {staleRepositories.length > 0 && (
            <p
              class={`${OVERVIEW_NOTICE_CLASS_NAME} notice-warning repository-freshness-notice border-state-warning-border`}
              role="status"
            >
              次のリポジトリの情報を取得できなかったため、前回の値を表示しています。対象:{" "}
              <span class="repository-freshness-targets font-bold wrap-anywhere">
                {formatStaleRepositoryNames(staleRepositories, props.locale)}
              </span>
            </p>
          )}
        </div>
      )}
      <AttentionQueue {...props} attentionItems={attentionItems} />
    </>
  );
}

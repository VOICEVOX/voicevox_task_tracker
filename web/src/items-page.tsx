import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { type PublicDetailsLoader } from "./details-loader.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { ItemListHeading } from "./item-list-heading.js";
import { ContentState, PageSection } from "./layout.js";
import { ListCountSummary } from "./list-count-summary.js";
import {
  createItemDetailsMap,
  createItemTableRows,
  filterAndSortTableRows,
  formatStallDuration,
  formatWaitingOn,
  isTableSelectFilterKey,
  searchItemNodeIds,
  statusLabel,
  type TableFilterOptions,
  type TableFilterKey,
  type ItemTableRow,
  type ItemSort,
  type ItemSortKey,
  type TableFilters,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { ITEM_SORT_OPTIONS, SortControls } from "./sort-controls.js";
import { ActionButton, FORM_CONTROL_CLASS_NAME, Pill } from "./ui.js";

const TABLE_PAGE_SIZE = 50;

type ItemsPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  filterOptions: TableFilterOptions;
  filters: TableFilters;
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  onFilterChange: (key: TableFilterKey, value: string) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectItem: (nodeId: string) => void;
  onSortChange: (key: ItemSortKey) => void;
  searchQuery: string;
  sort: ItemSort;
  summary: PublicSummaryDto;
}>;

type ItemTableProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  filterOptions: TableFilterOptions;
  filters: TableFilters;
  locale: string;
  now: Date;
  onClearSearch: () => void;
  onFilterChange: (key: TableFilterKey, value: string) => void;
  onRetryDetails: () => void;
  onSearchQueryChange: (query: string) => void;
  onSelectItem: (nodeId: string) => void;
  onSortChange: (key: ItemSortKey) => void;
  searchQuery: string;
  searchState: ItemSearchState;
  sort: ItemSort;
  summary: PublicSummaryDto;
}>;

type TableFilterDefinition = Readonly<{
  key: TableFilterKey;
  label: string;
}>;

type SearchDetailsState =
  | Readonly<{
      status: "not_requested";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      itemsByNodeId: ReturnType<typeof createItemDetailsMap>;
    }>
  | Readonly<{
      status: "failed";
    }>;

type ItemSearchState =
  | Readonly<{
      status: "inactive";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "available";
      nodeIds: readonly string[];
    }>
  | Readonly<{
      status: "failed";
    }>;

const TABLE_FILTERS: readonly TableFilterDefinition[] = [
  {
    key: "repository",
    label: "リポジトリ",
  },
  {
    key: "type",
    label: "種別",
  },
  {
    key: "status",
    label: "状態",
  },
  {
    key: "importance",
    label: "重要度",
  },
  {
    key: "waitingOn",
    label: "待ち相手",
  },
  {
    key: "stall",
    label: "停滞時間",
  },
  {
    key: "aiAnalysis",
    label: "AI利用状況",
  },
];

function AiStateNotice() {
  return (
    <p
      class="notice ai-state-notice m-0 rounded-md border-l-2 border-state-info-border bg-surface-card px-3 py-2 text-sm leading-5 text-text-secondary"
      role="status"
    >
      AI分析は設定で無効です。確定ルールで表示しています。
    </p>
  );
}

function ItemSearch({
  onClearSearch,
  onSearchQueryChange,
  searchQuery,
}: Readonly<{
  onClearSearch: () => void;
  onSearchQueryChange: (query: string) => void;
  searchQuery: string;
}>) {
  return (
    <div class="item-search min-w-0" role="search" aria-labelledby="item-search-label">
      <h3 id="item-search-heading" class="m-0 text-lg font-bold">
        項目検索
      </h3>
      <label
        class="mt-2 block text-sm font-bold text-text-secondary"
        id="item-search-label"
        for="item-search-input"
      >
        リポジトリ、番号、タイトル、アクター、team、ラベルで検索
      </label>
      <div class="search-input-row mt-2 grid grid-cols-[minmax(12rem,1fr)_auto] gap-2 max-narrow:grid-cols-1">
        <input
          class={`${FORM_CONTROL_CLASS_NAME} w-full`}
          id="item-search-input"
          type="search"
          value={searchQuery}
          maxLength={200}
          placeholder="空白で区切った語をすべて含む項目を検索"
          onInput={(event) => {
            onSearchQueryChange(event.currentTarget.value);
          }}
        />
        <ActionButton type="button" disabled={searchQuery.length === 0} onClick={onClearSearch}>
          検索をクリア
        </ActionButton>
      </div>
    </div>
  );
}

function ItemsEmptyState({
  onRetryDetails,
  searchState,
}: Readonly<{
  onRetryDetails: () => void;
  searchState: ItemSearchState;
}>) {
  switch (searchState.status) {
    case "loading":
      return (
        <ContentState
          className="empty-state"
          message="検索用の公開詳細データを読み込んでいます。"
          status="loading"
        />
      );
    case "failed":
      return (
        <ContentState
          className="empty-state search-load-failure"
          message="検索用の公開詳細データを取得できませんでした。"
          status="failed"
        >
          <ActionButton type="button" onClick={onRetryDetails}>
            再取得
          </ActionButton>
        </ContentState>
      );
    case "inactive":
    case "available":
      return (
        <ContentState
          className="empty-state"
          message="条件に一致する項目はありません。"
          status="empty"
        />
      );
    default:
      throw new UnreachableError(searchState);
  }
}

function itemRowPresentation(row: ItemTableRow): ResponsiveListRowPresentation {
  const stale = row.item.repositoryFreshness === "stale";
  return {
    cardClassName: stale ? "stale-card bg-state-warning-background/40" : "bg-surface-card",
    dataAttributes: {
      "data-freshness": row.item.repositoryFreshness,
      "data-node-id": row.item.nodeId,
    },
    key: row.item.nodeId,
    tableClassName: stale ? "stale-row bg-state-warning-background/40" : "",
  };
}

function ItemTable({
  createItemHref,
  filterOptions,
  filters,
  locale,
  now,
  onClearSearch,
  onFilterChange,
  onRetryDetails,
  onSearchQueryChange,
  onSelectItem,
  onSortChange,
  searchQuery,
  searchState,
  sort,
  summary,
}: ItemTableProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const rows = useMemo(() => createItemTableRows(summary, now), [summary, now]);
  const searchedRows = useMemo(() => {
    switch (searchState.status) {
      case "inactive":
        return rows;
      case "available": {
        const matchingNodeIds = new Set(searchState.nodeIds);
        return rows.filter((row) => matchingNodeIds.has(row.item.nodeId));
      }
      case "loading":
      case "failed":
        return [];
      default:
        throw new UnreachableError(searchState);
    }
  }, [rows, searchState]);
  const filteredRows = useMemo(
    () => filterAndSortTableRows(searchedRows, filters, sort),
    [searchedRows, filters, sort],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / TABLE_PAGE_SIZE));
  const firstRowIndex = pageIndex * TABLE_PAGE_SIZE;
  const visibleRows = filteredRows.slice(firstRowIndex, firstRowIndex + TABLE_PAGE_SIZE);
  const activeFilterCount = TABLE_FILTERS.filter((filter) => filters[filter.key].length > 0).length;

  function updateFilter(key: TableFilterKey, value: string): void {
    onFilterChange(key, value);
    setPageIndex(0);
  }

  function updateSort(key: ItemSortKey): void {
    onSortChange(key);
    setPageIndex(0);
  }

  useEffect(() => {
    setPageIndex(0);
  }, [filters, searchState, sort]);

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
          showFreshnessBadge={true}
        />
      ),
      widthClassName: "w-[32%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "status",
      label: "状態",
      renderCell: (row: ItemTableRow) => statusLabel(row.item.status),
      widthClassName: "w-[12%]",
    },
    {
      ariaSort: sort.key === "attention" ? sort.direction : "none",
      cellClassName: "attention-cell whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "attention",
      label: "要対応度",
      onSort: () => {
        updateSort("attention");
      },
      renderCell: (row: ItemTableRow) => (
        <AttentionBadge attention={row.item.attention} showLabel={false} showScore={false} />
      ),
      widthClassName: "w-[11%]",
    },
    {
      ariaSort: sort.key === "importance" ? sort.direction : "none",
      cellClassName: "importance-cell whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "importance",
      label: "重要度",
      onSort: () => {
        updateSort("importance");
      },
      renderCell: (row: ItemTableRow) => (
        <ImportanceBadge importance={row.item.importance} showLabel={false} showScore={false} />
      ),
      widthClassName: "w-[10%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "leading-6 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "waitingOn",
      label: "待ち相手",
      renderCell: (row: ItemTableRow) => formatWaitingOn(row.item, summary),
      widthClassName: "w-[23%]",
    },
    {
      ariaSort: sort.key === "stall" ? sort.direction : "none",
      cellClassName: "whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "stall",
      label: "停滞時間",
      onSort: () => {
        updateSort("stall");
      },
      renderCell: (row: ItemTableRow) => (
        <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
      ),
      widthClassName: "w-[12%]",
    },
  ] satisfies readonly ResponsiveTableColumn<ItemTableRow>[];
  const cardFields = [
    {
      className: "",
      key: "status",
      label: "状態",
      renderValue: (row: ItemTableRow) => statusLabel(row.item.status),
      valueClassName: "font-semibold text-text-primary",
    },
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
      renderValue: (row: ItemTableRow) => formatWaitingOn(row.item, summary),
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
      className="item-workspace scroll-mt-4"
      heading="項目一覧"
      headingId="items-heading"
    >
      {!summary.ai.enabled && (
        <div class="item-list-notices mb-4">
          <AiStateNotice />
        </div>
      )}
      <div class="item-list-toolbar mb-4 grid gap-4 rounded-xl border border-border-subtle bg-surface-sunken p-4">
        <ItemSearch
          searchQuery={searchQuery}
          onClearSearch={onClearSearch}
          onSearchQueryChange={onSearchQueryChange}
        />
        <details class="item-filters border-t border-border-subtle pt-2">
          <summary class="min-h-11 cursor-pointer py-2 text-sm font-bold text-text-secondary marker:text-text-muted">
            <span class="ml-1 inline-flex max-w-[calc(100%_-_2rem)] flex-wrap items-center gap-x-3 gap-y-1 align-middle">
              <span>列ごとの絞り込み</span>
              <Pill className="filter-summary-count" tone="neutral" variant="filled">
                {activeFilterCount === 0 ? "条件なし" : `${activeFilterCount.toString()}件適用中`}
              </Pill>
            </span>
          </summary>
          <div class="item-filter-content pt-3">
            <p class="mt-0 mb-3 text-sm text-text-muted">
              列の値を選択します。待ち相手は入力した文字を含む項目を表示します。
            </p>
            <div class="item-filter-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {TABLE_FILTERS.map((filter) => (
                <label key={filter.key} class="grid gap-1 text-xs font-bold text-text-secondary">
                  <span>{filter.label}</span>
                  {isTableSelectFilterKey(filter.key) ? (
                    <select
                      class={`${FORM_CONTROL_CLASS_NAME} w-full`}
                      value={filters[filter.key]}
                      aria-label={`${filter.label}で絞り込み`}
                      onChange={(event) => {
                        updateFilter(filter.key, event.currentTarget.value);
                      }}
                    >
                      <option value="">すべて</option>
                      {filterOptions[filter.key].map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      class={`${FORM_CONTROL_CLASS_NAME} w-full`}
                      type="search"
                      value={filters.waitingOn}
                      maxLength={200}
                      aria-label={`${filter.label}で絞り込み`}
                      placeholder="部分一致で絞り込み"
                      onInput={(event) => {
                        updateFilter(filter.key, event.currentTarget.value);
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        </details>
      </div>
      <div class="item-list-controls mb-4 flex flex-wrap items-end justify-between gap-4">
        <ListCountSummary
          className="item-list-count items-item-count"
          count={filteredRows.length}
          locale={locale}
          sort={sort}
        />
        <SortControls
          className="item-list-sort-controls item-sort-controls grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 sm:w-auto sm:min-w-64"
          onSortChange={updateSort}
          options={ITEM_SORT_OPTIONS}
          selectId="item-sort-key"
          sort={sort}
        />
      </div>
      {filteredRows.length === 0 ? (
        <ItemsEmptyState searchState={searchState} onRetryDetails={onRetryDetails} />
      ) : (
        <>
          <ResponsiveTableCardList
            breakpoint="lg"
            cardAriaLabel="項目一覧"
            cardFields={cardFields}
            cardListClassName=""
            columns={tableColumns}
            getRowPresentation={itemRowPresentation}
            rows={visibleRows}
            tableCaption="追跡中の全項目の一覧"
            tableClassName="items-table"
            renderCardHeading={(row) => (
              <ItemListHeading
                createItemHref={createItemHref}
                onSelectItem={onSelectItem}
                row={row}
                showFreshnessBadge={true}
              />
            )}
            renderCardFooter={() => null}
          />
          <nav
            aria-label="一覧のページ送り"
            class="pagination mt-4 flex flex-wrap items-center justify-center gap-3"
          >
            <ActionButton
              type="button"
              disabled={pageIndex === 0}
              onClick={() => {
                setPageIndex((currentPage) => currentPage - 1);
              }}
            >
              前のページ
            </ActionButton>
            <p class="m-0 tabular-nums" aria-live="polite">
              {pageIndex + 1} / {pageCount}ページ
            </p>
            <ActionButton
              type="button"
              disabled={pageIndex + 1 >= pageCount}
              onClick={() => {
                setPageIndex((currentPage) => currentPage + 1);
              }}
            >
              次のページ
            </ActionButton>
          </nav>
        </>
      )}
    </PageSection>
  );
}

/** 検索、列絞り込み、並び替え、ページ送りを備えた項目一覧を表示する。 */
export function ItemsPage({
  createItemHref,
  filterOptions,
  filters,
  loadDetails,
  locale,
  now,
  onFilterChange,
  onSearchQueryChange,
  onSelectItem,
  onSortChange,
  searchQuery,
  sort,
  summary,
}: ItemsPageProps) {
  const [detailsState, setDetailsState] = useState<SearchDetailsState>({
    status: "not_requested",
  });
  const detailsNeeded = searchQuery.trim().length > 0;

  useEffect(() => {
    if (!detailsNeeded || detailsState.status !== "not_requested") {
      return;
    }
    setDetailsState({
      status: "loading",
    });
    void loadDetails()
      .then((details) => {
        setDetailsState({
          status: "loaded",
          itemsByNodeId: createItemDetailsMap(summary, details),
        });
      })
      .catch((error: unknown) => {
        console.error("項目検索の公開データ取得に失敗しました", error);
        setDetailsState({
          status: "failed",
        });
      });
  }, [detailsNeeded, detailsState.status, loadDetails, summary]);

  const searchState = useMemo<ItemSearchState>(() => {
    if (!detailsNeeded) {
      return {
        status: "inactive",
      };
    }
    switch (detailsState.status) {
      case "not_requested":
      case "loading":
        return {
          status: "loading",
        };
      case "loaded":
        return {
          status: "available",
          nodeIds: searchItemNodeIds(summary, detailsState.itemsByNodeId, searchQuery),
        };
      case "failed":
        return {
          status: "failed",
        };
      default:
        throw new UnreachableError(detailsState);
    }
  }, [detailsNeeded, detailsState, searchQuery, summary]);

  return (
    <ItemTable
      createItemHref={createItemHref}
      filterOptions={filterOptions}
      filters={filters}
      locale={locale}
      now={now}
      searchQuery={searchQuery}
      searchState={searchState}
      sort={sort}
      summary={summary}
      onClearSearch={() => {
        onSearchQueryChange("");
      }}
      onFilterChange={onFilterChange}
      onRetryDetails={() => {
        setDetailsState({
          status: "not_requested",
        });
      }}
      onSearchQueryChange={onSearchQueryChange}
      onSelectItem={onSelectItem}
      onSortChange={onSortChange}
    />
  );
}

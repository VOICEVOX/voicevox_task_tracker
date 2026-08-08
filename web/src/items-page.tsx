import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { type PublicDetailsLoader } from "./details-loader.js";
import { ImportanceBadge } from "./importance-badge.js";
import { ItemDetailsLink } from "./item-details.js";
import { ContentState, PageSection } from "./layout.js";
import {
  createItemDetailsMap,
  createItemTableRows,
  filterAndSortTableRows,
  formatStallDuration,
  formatWaitingOn,
  isAiAnalysisDegraded,
  isTableSelectFilterKey,
  searchItemNodeIds,
  statusLabel,
  type TableFilterOptions,
  type TableFilterKey,
  type ItemTableRow,
  type TableColumnKey,
  type TableFilters,
  type TableSort,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { SafeGitHubLink } from "./safe-link.js";
import { SortControls } from "./sort-controls.js";
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
  onSortChange: (key: TableColumnKey) => void;
  searchQuery: string;
  sort: TableSort;
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
  onSortChange: (key: TableColumnKey) => void;
  searchQuery: string;
  searchState: ItemSearchState;
  sort: TableSort;
  summary: PublicSummaryDto;
}>;

type TableColumnDefinition = Readonly<{
  key: TableColumnKey;
  label: string;
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

const TABLE_COLUMNS: readonly TableColumnDefinition[] = [
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
    label: "status",
  },
  {
    key: "importance",
    label: "重要度",
  },
  {
    key: "waitingOn",
    label: "waitingOn",
  },
  {
    key: "stall",
    label: "停滞時間",
  },
];

const TABLE_FILTERS: readonly TableFilterDefinition[] = [
  ...TABLE_COLUMNS,
  {
    key: "aiAnalysis",
    label: "AI利用状況",
  },
];

function AiAnalysisBadge({
  status,
}: Readonly<{
  status: PublicItemSummaryDto["aiAnalysis"]["status"];
}>) {
  if (!isAiAnalysisDegraded(status)) {
    return null;
  }
  return (
    <Pill className="ai-analysis-badge ai-analysis-degraded" tone="warning">
      AI判定なし
    </Pill>
  );
}

function ItemTitleLink({
  createItemHref,
  onSelectItem,
  row,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  onSelectItem: (nodeId: string) => void;
  row: ItemTableRow;
}>) {
  return (
    <ItemDetailsLink
      href={createItemHref(row.item.nodeId)}
      nodeId={row.item.nodeId}
      onSelect={onSelectItem}
    >
      {row.item.title}
    </ItemDetailsLink>
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
    () => filterAndSortTableRows(searchedRows, filters, sort, locale),
    [searchedRows, filters, sort, locale],
  );
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / TABLE_PAGE_SIZE));
  const firstRowIndex = pageIndex * TABLE_PAGE_SIZE;
  const visibleRows = filteredRows.slice(firstRowIndex, firstRowIndex + TABLE_PAGE_SIZE);
  const activeFilterCount = TABLE_FILTERS.filter((filter) => filters[filter.key].length > 0).length;

  function updateFilter(key: TableFilterKey, value: string): void {
    onFilterChange(key, value);
    setPageIndex(0);
  }

  function updateSort(key: TableColumnKey): void {
    onSortChange(key);
    setPageIndex(0);
  }

  useEffect(() => {
    setPageIndex(0);
  }, [filters, searchState, sort]);

  const tableColumns = [
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
        <ImportanceBadge importance={row.item.importance} showLow={false} showScore={false} />
      ),
      widthClassName: "w-[10%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "row_header",
      headerClassName: "whitespace-nowrap",
      key: "item",
      label: "項目",
      renderCell: (row: ItemTableRow) => (
        <div class="grid min-w-0 gap-1.5">
          <span class="item-list-meta text-xs leading-5 text-text-muted wrap-anywhere">
            {row.item.displayReference}・{row.typeText}
          </span>
          <span class="min-w-0 wrap-anywhere">
            <ItemTitleLink createItemHref={createItemHref} onSelectItem={onSelectItem} row={row} />
          </span>
          <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-normal">
            <SafeGitHubLink href={row.item.url} variant="subtle">
              GitHubで開く
            </SafeGitHubLink>
            {row.item.repositoryFreshness === "stale" && (
              <Pill className="freshness-badge freshness-stale" tone="warning">
                古い観測値
              </Pill>
            )}
            <AiAnalysisBadge status={row.item.aiAnalysis.status} />
          </span>
        </div>
      ),
      widthClassName: "w-[34%]",
    },
    {
      ariaSort: sort.key === "status" ? sort.direction : "none",
      cellClassName: "whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "status",
      label: "状態",
      onSort: () => {
        updateSort("status");
      },
      renderCell: (row: ItemTableRow) => statusLabel(row.item.status),
      widthClassName: "w-[18%]",
    },
    {
      ariaSort: sort.key === "waitingOn" ? sort.direction : "none",
      cellClassName: "leading-6 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "waitingOn",
      label: "次の担当",
      onSort: () => {
        updateSort("waitingOn");
      },
      renderCell: (row: ItemTableRow) => formatWaitingOn(row.item, summary),
      widthClassName: "w-[26%]",
    },
    {
      ariaSort: sort.key === "stall" ? sort.direction : "none",
      cellClassName: "whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "stall",
      label: "停滞",
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
      key: "stall",
      label: "停滞",
      renderValue: (row: ItemTableRow) => formatStallDuration(row.item.stallSince, now),
      valueClassName: "font-semibold text-text-primary tabular-nums",
    },
    {
      className: "col-span-full border-t border-border-subtle pt-3",
      key: "waitingOn",
      label: "次の担当",
      renderValue: (row: ItemTableRow) => formatWaitingOn(row.item, summary),
      valueClassName: "leading-6 text-text-primary",
    },
  ] satisfies readonly ResponsiveCardField<ItemTableRow>[];

  return (
    <PageSection
      className="item-workspace scroll-mt-4"
      description={`${filteredRows.length.toLocaleString(locale)}件を表示対象にしています。`}
      heading="全項目一覧"
      headingId="items-heading"
    >
      <div class="item-list-toolbar mb-4 grid gap-4 rounded-xl border border-border-subtle bg-surface-sunken p-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <ItemSearch
          searchQuery={searchQuery}
          onClearSearch={onClearSearch}
          onSearchQueryChange={onSearchQueryChange}
        />
        <SortControls
          className="item-sort-controls grid grid-cols-[minmax(0,1fr)_auto] content-end gap-2 md:min-w-64"
          onSortChange={updateSort}
          options={TABLE_COLUMNS}
          selectId="item-sort-key"
          sort={sort}
        />
        <details class="item-filters border-t border-border-subtle pt-2 md:col-span-2">
          <summary class="min-h-11 cursor-pointer py-2 text-sm font-bold text-text-secondary marker:text-text-muted">
            <span class="ml-1 inline-flex max-w-[calc(100%_-_2rem)] flex-wrap items-center gap-x-3 gap-y-1 align-middle">
              <span>列ごとの絞り込み</span>
              <Pill className="filter-summary-count" tone="neutral">
                {activeFilterCount === 0 ? "条件なし" : `${activeFilterCount.toString()}件適用中`}
              </Pill>
            </span>
          </summary>
          <div class="item-filter-content pt-3">
            <p class="mt-0 mb-3 text-sm text-text-muted">
              列の値を選択します。次の担当は入力した文字を含む項目を表示します。
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
      <ResponsiveTableCardList
        cardAriaLabel="項目一覧"
        cardFields={cardFields}
        cardListClassName=""
        columns={tableColumns}
        getRowPresentation={itemRowPresentation}
        rows={visibleRows}
        tableCaption="追跡中の全項目の一覧"
        tableClassName="items-table"
        renderCardHeading={(row) => {
          const showsFreshnessBadge = row.item.repositoryFreshness === "stale";
          const showsAiAnalysisBadge = isAiAnalysisDegraded(row.item.aiAnalysis.status);
          return (
            <div class="grid min-w-0 gap-2">
              <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <p class="item-list-meta m-0 min-w-0 flex-1 text-sm leading-5 text-text-muted wrap-anywhere">
                  {row.item.displayReference}・{row.typeText}
                </p>
                {(showsFreshnessBadge || showsAiAnalysisBadge) && (
                  <span class="flex flex-wrap justify-end gap-1.5">
                    {showsFreshnessBadge && (
                      <Pill className="freshness-badge freshness-stale" tone="warning">
                        古い観測値
                      </Pill>
                    )}
                    <AiAnalysisBadge status={row.item.aiAnalysis.status} />
                  </span>
                )}
              </div>
              <h3 class="item-title-with-importance m-0 flex min-w-0 items-start gap-1.5 text-base leading-6 font-bold">
                <ImportanceBadge
                  importance={row.item.importance}
                  showLow={false}
                  showScore={false}
                />
                <span class="min-w-0 wrap-anywhere">
                  <ItemTitleLink
                    createItemHref={createItemHref}
                    onSelectItem={onSelectItem}
                    row={row}
                  />
                </span>
              </h3>
            </div>
          );
        }}
        renderCardFooter={(row) => (
          <div class="border-t border-border-subtle pt-3">
            <SafeGitHubLink href={row.item.url} variant="button">
              GitHubで開く
            </SafeGitHubLink>
          </div>
        )}
      />
      {visibleRows.length === 0 && (
        <ItemsEmptyState searchState={searchState} onRetryDetails={onRetryDetails} />
      )}
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

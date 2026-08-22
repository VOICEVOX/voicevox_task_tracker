import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { type PublicDetailsLoader } from "./details-loader.js";
import { createItemCardFields, createItemTableColumns } from "./item-list-fields.js";
import { ItemListHeading } from "./item-list-heading.js";
import { ContentState, PageSection } from "./layout.js";
import {
  createItemDetailsMap,
  createItemTableRows,
  filterAndSortTableRows,
  isTableSelectFilterKey,
  searchItemNodeIds,
  selectPrimaryWaitingOnCandidate,
  type TableFilterOptions,
  type TableFilterKey,
  type ItemTableRow,
  type ItemSort,
  type ItemSortKey,
  type TableFilters,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveListRowPresentation,
} from "./responsive-table-card-list.js";
import { ITEM_SORT_OPTIONS, SortControls } from "./sort-controls.js";
import { ActionButton, FORM_CONTROL_CLASS_NAME, Pill } from "./ui.js";
import { type PersonNavigation } from "./waiting-on-display.js";

const TABLE_PAGE_SIZE = 50;

type ItemsPageProps = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    filterOptions: TableFilterOptions;
    filters: TableFilters;
    loadDetails: PublicDetailsLoader;
    now: Date;
    onFilterChange: (key: TableFilterKey, value: string) => void;
    onSearchQueryChange: (query: string) => void;
    onSelectItem: (nodeId: string) => void;
    onSortChange: (key: ItemSortKey) => void;
    searchQuery: string;
    sort: ItemSort;
    summary: PublicSummaryDto;
  }>;

type ItemTableProps = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    filterOptions: TableFilterOptions;
    filters: TableFilters;
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
      class="notice ai-state-notice m-0 rounded-xl border-l-2 border-state-info-border bg-surface-card px-3 py-2 text-sm leading-5 text-text-secondary"
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
      <label
        class="block text-sm font-bold text-text-secondary"
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
    cardClassName: stale
      ? "stale-card bg-state-warning-background/40 [&_a]:text-accent-link-hover"
      : "bg-surface-card",
    dataAttributes: {
      "data-freshness": row.item.repositoryFreshness,
      "data-node-id": row.item.nodeId,
    },
    key: row.item.nodeId,
    tableClassName: stale
      ? "stale-row bg-state-warning-background/40 [&_a]:text-accent-link-hover"
      : "",
  };
}

function ItemTable({
  createItemHref,
  createPersonHref,
  filterOptions,
  filters,
  now,
  onClearSearch,
  onFilterChange,
  onRetryDetails,
  onSearchQueryChange,
  onSelectItem,
  onSelectPerson,
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
  const activeConditionCount = activeFilterCount + (searchQuery.length > 0 ? 1 : 0);
  const [isToolbarOpen, setIsToolbarOpen] = useState(activeConditionCount > 0);

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

  const itemListFieldOptions = {
    createItemHref,
    createPersonHref,
    now,
    onSelectItem,
    onSelectPerson,
    onSortChange: updateSort,
    selectPrimaryWaitingOn: (row: ItemTableRow) => selectPrimaryWaitingOnCandidate(row.item),
    sort,
    summary,
  };
  const tableColumns = createItemTableColumns(itemListFieldOptions);
  const cardFields = createItemCardFields(itemListFieldOptions);

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
      <details
        class="item-list-toolbar mb-4 rounded-2xl border border-border-default bg-surface-sunken p-4"
        open={isToolbarOpen}
        onToggle={(event) => {
          setIsToolbarOpen(event.currentTarget.open);
        }}
      >
        <summary class="min-h-11 cursor-pointer py-2 text-sm font-bold text-text-secondary marker:text-text-muted">
          <span class="ml-1 inline-flex max-w-[calc(100%_-_2rem)] flex-wrap items-center gap-x-3 gap-y-1 align-middle">
            <span>検索と絞り込み</span>
            <Pill className="filter-summary-count font-mono tabular-nums" tone="neutral">
              {activeConditionCount === 0
                ? "完了済みを非表示"
                : `${activeConditionCount.toString()}件適用中`}
            </Pill>
          </span>
        </summary>
        <div class="item-filter-content grid gap-4 pt-3">
          <ItemSearch
            searchQuery={searchQuery}
            onClearSearch={onClearSearch}
            onSearchQueryChange={onSearchQueryChange}
          />
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
                    <option value="">{filter.key === "status" ? "未完了" : "すべて"}</option>
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
      <SortControls
        className="item-list-sort-controls item-sort-controls mb-4 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 sm:w-auto sm:min-w-64 lg:hidden"
        onSortChange={updateSort}
        options={ITEM_SORT_OPTIONS}
        selectId="item-sort-key"
        sort={sort}
      />
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
            tableCaption="追跡項目の一覧"
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
            <p class="m-0 font-mono tabular-nums" aria-live="polite">
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
  createPersonHref,
  filterOptions,
  filters,
  loadDetails,
  now,
  onFilterChange,
  onSearchQueryChange,
  onSelectItem,
  onSelectPerson,
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
      createPersonHref={createPersonHref}
      filterOptions={filterOptions}
      filters={filters}
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
      onSelectPerson={onSelectPerson}
      onSortChange={onSortChange}
    />
  );
}

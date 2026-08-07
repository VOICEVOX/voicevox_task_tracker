import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
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
  isTableSelectColumnKey,
  searchItemNodeIds,
  statusLabel,
  type TableFilterOptions,
  type ItemTableRow,
  type TableColumnKey,
  type TableFilters,
  type TableSort,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import { ActionButton, FORM_CONTROL_CLASS_NAME, Pill } from "./ui.js";

const TABLE_PAGE_SIZE = 50;

type ItemsPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  filterOptions: TableFilterOptions;
  filters: TableFilters;
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  onFilterChange: (key: TableColumnKey, value: string) => void;
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
  onFilterChange: (key: TableColumnKey, value: string) => void;
  onRetryDetails: () => void;
  onSelectItem: (nodeId: string) => void;
  onSortChange: (key: TableColumnKey) => void;
  searchState: ItemSearchState;
  sort: TableSort;
  summary: PublicSummaryDto;
}>;

type TableColumnDefinition = Readonly<{
  key: TableColumnKey;
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
    <PageSection className="item-workspace" heading="項目検索" headingId="item-search-heading">
      <div class="item-search" role="search" aria-labelledby="item-search-label">
        <label id="item-search-label" for="item-search-input">
          リポジトリ、番号、タイトル、アクター、team、ラベルで検索
        </label>
        <div class="search-input-row">
          <input
            class={FORM_CONTROL_CLASS_NAME}
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
    </PageSection>
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

function ItemTable({
  createItemHref,
  filterOptions,
  filters,
  locale,
  now,
  onFilterChange,
  onRetryDetails,
  onSelectItem,
  onSortChange,
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
  const activeFilterCount = TABLE_COLUMNS.filter((column) => filters[column.key].length > 0).length;

  function updateFilter(key: TableColumnKey, value: string): void {
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

  return (
    <PageSection
      description={`${filteredRows.length.toLocaleString(locale)}件を表示対象にしています。`}
      heading="全項目一覧"
      headingId="items-heading"
    >
      <div class="item-list-toolbar">
        <details class="item-filters">
          <summary>
            <span>列ごとの絞り込み</span>
            <span class="filter-summary-count">
              {activeFilterCount === 0 ? "条件なし" : `${activeFilterCount.toString()}件適用中`}
            </span>
          </summary>
          <div class="item-filter-content">
            <p>列の値を選択します。次の担当は入力した文字を含む項目を表示します。</p>
            <div class="item-filter-grid">
              {TABLE_COLUMNS.map((column) => (
                <label key={column.key}>
                  <span>{column.label}</span>
                  {isTableSelectColumnKey(column.key) ? (
                    <select
                      class={FORM_CONTROL_CLASS_NAME}
                      value={filters[column.key]}
                      aria-label={`${column.label}で絞り込み`}
                      onChange={(event) => {
                        updateFilter(column.key, event.currentTarget.value);
                      }}
                    >
                      <option value="">すべて</option>
                      {filterOptions[column.key].map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      class={FORM_CONTROL_CLASS_NAME}
                      type="search"
                      value={filters.waitingOn}
                      maxLength={200}
                      aria-label={`${column.label}で絞り込み`}
                      placeholder="部分一致で絞り込み"
                      onInput={(event) => {
                        updateFilter(column.key, event.currentTarget.value);
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        </details>
        <div class="item-sort-controls">
          <label for="item-sort-key">並び順</label>
          <select
            class={FORM_CONTROL_CLASS_NAME}
            id="item-sort-key"
            value={sort.key}
            onChange={(event) => {
              const selectedColumn = TABLE_COLUMNS.find(
                (column) => column.key === event.currentTarget.value,
              );
              assertNonNullable(selectedColumn, "選択された並び順がありません");
              updateSort(selectedColumn.key);
            }}
          >
            {TABLE_COLUMNS.map((column) => (
              <option key={column.key} value={column.key}>
                {column.label}
              </option>
            ))}
          </select>
          <ActionButton
            type="button"
            aria-label={`並び順を${sort.direction === "ascending" ? "降順" : "昇順"}に変更`}
            onClick={() => {
              updateSort(sort.key);
            }}
          >
            {sort.direction === "ascending" ? "昇順 ↑" : "降順 ↓"}
          </ActionButton>
        </div>
      </div>
      <div class="items-table-region">
        <table class="items-table">
          <caption class="visually-hidden">追跡中の全項目の一覧</caption>
          <colgroup>
            <col class="importance-column" />
            <col class="item-column" />
            <col class="status-column" />
            <col class="waiting-column" />
            <col class="stall-column" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" aria-sort={sort.key === "importance" ? sort.direction : undefined}>
                重要度
              </th>
              <th scope="col" aria-sort={sort.key === "repository" ? sort.direction : undefined}>
                項目
              </th>
              <th scope="col" aria-sort={sort.key === "status" ? sort.direction : undefined}>
                状態
              </th>
              <th scope="col" aria-sort={sort.key === "waitingOn" ? sort.direction : undefined}>
                次の担当
              </th>
              <th scope="col" aria-sort={sort.key === "stall" ? sort.direction : undefined}>
                停滞
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.item.nodeId}
                data-node-id={row.item.nodeId}
                data-freshness={row.item.repositoryFreshness}
                class={row.item.repositoryFreshness === "stale" ? "stale-row" : ""}
              >
                <td class="importance-cell">
                  <ImportanceBadge
                    importance={row.item.importance}
                    showLow={false}
                    showScore={false}
                  />
                </td>
                <th scope="row">
                  <span class="item-list-meta">
                    {row.item.displayReference}・{row.typeText}
                  </span>
                  <ItemTitleLink
                    createItemHref={createItemHref}
                    onSelectItem={onSelectItem}
                    row={row}
                  />
                  <SafeGitHubLink href={row.item.url}>GitHub</SafeGitHubLink>
                  {row.item.repositoryFreshness === "stale" && (
                    <Pill className="freshness-badge freshness-stale" tone="warning">
                      古い観測値
                    </Pill>
                  )}
                </th>
                <td>{statusLabel(row.item.status)}</td>
                <td>{formatWaitingOn(row.item, summary)}</td>
                <td>
                  <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ol class="items-card-list" aria-label="項目一覧">
        {visibleRows.map((row) => (
          <li
            key={row.item.nodeId}
            data-node-id={row.item.nodeId}
            data-freshness={row.item.repositoryFreshness}
            class={row.item.repositoryFreshness === "stale" ? "stale-card" : ""}
          >
            <article>
              <div class="item-card-heading">
                <div>
                  <p class="item-list-meta">
                    {row.item.displayReference}・{row.typeText}
                  </p>
                  <h3 class="item-title-with-importance">
                    <ImportanceBadge
                      importance={row.item.importance}
                      showLow={false}
                      showScore={false}
                    />
                    <ItemTitleLink
                      createItemHref={createItemHref}
                      onSelectItem={onSelectItem}
                      row={row}
                    />
                  </h3>
                </div>
                {row.item.repositoryFreshness === "stale" && (
                  <Pill className="freshness-badge freshness-stale" tone="warning">
                    古い観測値
                  </Pill>
                )}
              </div>
              <dl class="item-card-summary">
                <div>
                  <dt>状態</dt>
                  <dd>{statusLabel(row.item.status)}</dd>
                </div>
                <div>
                  <dt>次の担当</dt>
                  <dd>{formatWaitingOn(row.item, summary)}</dd>
                </div>
                <div>
                  <dt>停滞</dt>
                  <dd>{formatStallDuration(row.item.stallSince, now)}</dd>
                </div>
              </dl>
              <SafeGitHubLink href={row.item.url}>GitHubで開く</SafeGitHubLink>
            </article>
          </li>
        ))}
      </ol>
      {visibleRows.length === 0 && (
        <ItemsEmptyState searchState={searchState} onRetryDetails={onRetryDetails} />
      )}
      <nav aria-label="一覧のページ送り" class="pagination">
        <ActionButton
          type="button"
          disabled={pageIndex === 0}
          onClick={() => {
            setPageIndex((currentPage) => currentPage - 1);
          }}
        >
          前のページ
        </ActionButton>
        <p aria-live="polite">
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

/** 検索、列filter、sort、ページ送りを備えた項目一覧を表示する。 */
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
    <>
      <ItemSearch
        searchQuery={searchQuery}
        onClearSearch={() => {
          onSearchQueryChange("");
        }}
        onSearchQueryChange={onSearchQueryChange}
      />
      <ItemTable
        createItemHref={createItemHref}
        filterOptions={filterOptions}
        filters={filters}
        locale={locale}
        now={now}
        searchState={searchState}
        sort={sort}
        summary={summary}
        onFilterChange={onFilterChange}
        onRetryDetails={() => {
          setDetailsState({
            status: "not_requested",
          });
        }}
        onSelectItem={onSelectItem}
        onSortChange={onSortChange}
      />
    </>
  );
}

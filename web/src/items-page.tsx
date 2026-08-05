import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { type PublicDetailsLoader } from "./dependency-graph.js";
import { ItemDetailsLink } from "./item-details.js";
import {
  createItemDetailsMap,
  createItemTableRows,
  filterAndSortTableRows,
  formatStallDuration,
  formatWaitingOn,
  importanceLevelLabel,
  searchItemNodeIds,
  statusLabel,
  type ItemTableRow,
  type TableColumnKey,
  type TableFilters,
  type TableSort,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";

const TABLE_PAGE_SIZE = 50;

type ItemsPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
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
  filters: TableFilters;
  locale: string;
  now: Date;
  onFilterChange: (key: TableColumnKey, value: string) => void;
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
  {
    key: "blocker",
    label: "blocker",
  },
  {
    key: "updated",
    label: "更新日時",
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

function SearchStatus({
  onRetryDetails,
  searchState,
  summary,
}: Readonly<{
  onRetryDetails: () => void;
  searchState: ItemSearchState;
  summary: PublicSummaryDto;
}>) {
  switch (searchState.status) {
    case "inactive":
      return (
        <p class="search-status" role="status" aria-live="polite">
          全{summary.items.length.toLocaleString()}件を表示しています。
        </p>
      );
    case "loading":
      return (
        <p class="search-status" role="status" aria-live="polite">
          検索用の公開詳細データを読み込んでいます。
        </p>
      );
    case "available":
      return (
        <p class="search-status" role="status" aria-live="polite">
          {searchState.nodeIds.length.toLocaleString()}件が検索条件に一致しました。
        </p>
      );
    case "failed":
      return (
        <div class="search-load-failure" role="alert">
          <p>検索用の公開詳細データを取得できませんでした。</p>
          <button type="button" onClick={onRetryDetails}>
            再取得
          </button>
        </div>
      );
    default:
      throw new UnreachableError(searchState);
  }
}

function ItemSearch({
  onClearSearch,
  onRetryDetails,
  onSearchQueryChange,
  searchQuery,
  searchState,
  summary,
}: Readonly<{
  onClearSearch: () => void;
  onRetryDetails: () => void;
  onSearchQueryChange: (query: string) => void;
  searchQuery: string;
  searchState: ItemSearchState;
  summary: PublicSummaryDto;
}>) {
  return (
    <section aria-labelledby="item-search-heading" class="section-card item-workspace">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Search</p>
          <h2 id="item-search-heading">項目検索</h2>
        </div>
        <p>公開済みデータだけを使い、項目を検索します。</p>
      </div>
      <div class="item-search" role="search" aria-labelledby="item-search-label">
        <label id="item-search-label" for="item-search-input">
          リポジトリ、番号、タイトル、アクター、team、ラベルで検索
        </label>
        <div class="search-input-row">
          <input
            id="item-search-input"
            type="search"
            value={searchQuery}
            maxLength={200}
            aria-describedby="item-search-description"
            onInput={(event) => {
              onSearchQueryChange(event.currentTarget.value);
            }}
          />
          <button type="button" disabled={searchQuery.length === 0} onClick={onClearSearch}>
            検索をクリア
          </button>
        </div>
        <p id="item-search-description">
          空白で区切った語をすべて含む項目を、外部問い合わせなしで検索します。
        </p>
        <SearchStatus searchState={searchState} summary={summary} onRetryDetails={onRetryDetails} />
      </div>
    </section>
  );
}

function ItemTable({
  createItemHref,
  filters,
  locale,
  now,
  onFilterChange,
  onSelectItem,
  onSortChange,
  searchState,
  sort,
  summary,
}: ItemTableProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const rows = useMemo(() => createItemTableRows(summary, now, locale), [summary, now, locale]);
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
    <section aria-labelledby="items-heading" class="section-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">All items</p>
          <h2 id="items-heading">全項目一覧</h2>
        </div>
        <p>{filteredRows.length.toLocaleString(locale)}件を表示対象にしています。</p>
      </div>
      <div class="item-list-toolbar">
        <details class="item-filters">
          <summary>
            <span>列ごとの絞り込み</span>
            <span class="filter-summary-count">
              {activeFilterCount === 0 ? "条件なし" : `${activeFilterCount.toString()}件適用中`}
            </span>
          </summary>
          <div class="item-filter-content">
            <p>入力した文字を含む項目だけを表示します。</p>
            <div class="item-filter-grid">
              {TABLE_COLUMNS.map((column) => (
                <label key={column.key}>
                  <span>{column.label}</span>
                  <input
                    type="search"
                    value={filters[column.key]}
                    maxLength={200}
                    aria-label={`${column.label}で絞り込み`}
                    placeholder="部分一致で絞り込み"
                    onInput={(event) => {
                      updateFilter(column.key, event.currentTarget.value);
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        </details>
        <div class="item-sort-controls">
          <label for="item-sort-key">並び順</label>
          <select
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
          <button
            type="button"
            aria-label={`並び順を${sort.direction === "ascending" ? "降順" : "昇順"}に変更`}
            onClick={() => {
              updateSort(sort.key);
            }}
          >
            {sort.direction === "ascending" ? "昇順 ↑" : "降順 ↓"}
          </button>
        </div>
      </div>
      <div class="items-table-region">
        <table class="items-table">
          <caption class="visually-hidden">全追跡項目をグラフなしで確認できる一覧</caption>
          <colgroup>
            <col class="item-column" />
            <col class="status-column" />
            <col class="importance-column" />
            <col class="waiting-column" />
            <col class="stall-column" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" aria-sort={sort.key === "repository" ? sort.direction : undefined}>
                項目
              </th>
              <th scope="col" aria-sort={sort.key === "status" ? sort.direction : undefined}>
                状態
              </th>
              <th scope="col" aria-sort={sort.key === "importance" ? sort.direction : undefined}>
                重要度
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
                    <span class="freshness-badge freshness-stale">古い観測値</span>
                  )}
                </th>
                <td>{statusLabel(row.item.status)}</td>
                <td class="importance-cell" data-importance-score={row.item.importance.score}>
                  <span class={`importance-badge importance-${row.item.importance.level}`}>
                    <span>{importanceLevelLabel(row.item.importance.level)}</span>
                    <strong>{row.item.importance.score.toString()}点</strong>
                  </span>
                </td>
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
                  <h3>
                    <ItemTitleLink
                      createItemHref={createItemHref}
                      onSelectItem={onSelectItem}
                      row={row}
                    />
                  </h3>
                </div>
                {row.item.repositoryFreshness === "stale" && (
                  <span class="freshness-badge freshness-stale">古い観測値</span>
                )}
              </div>
              <dl class="item-card-summary">
                <div>
                  <dt>状態</dt>
                  <dd>{statusLabel(row.item.status)}</dd>
                </div>
                <div>
                  <dt>重要度</dt>
                  <dd>
                    <span class={`importance-badge importance-${row.item.importance.level}`}>
                      <span>{importanceLevelLabel(row.item.importance.level)}</span>
                      <strong>{row.item.importance.score.toString()}点</strong>
                    </span>
                  </dd>
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
        <p class="empty-state">
          {searchState.status === "loading"
            ? "検索用の公開詳細データを読み込んでいます。"
            : searchState.status === "failed"
              ? "検索用の公開詳細データを取得できませんでした。"
              : "条件に一致する項目はありません。"}
        </p>
      )}
      <nav aria-label="一覧のページ送り" class="pagination">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => {
            setPageIndex((currentPage) => currentPage - 1);
          }}
        >
          前のページ
        </button>
        <p aria-live="polite">
          {pageIndex + 1} / {pageCount}ページ
        </p>
        <button
          type="button"
          disabled={pageIndex + 1 >= pageCount}
          onClick={() => {
            setPageIndex((currentPage) => currentPage + 1);
          }}
        >
          次のページ
        </button>
      </nav>
    </section>
  );
}

/** 検索、列filter、sort、ページ送りを備えた項目一覧を表示する。 */
export function ItemsPage({
  createItemHref,
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
        searchState={searchState}
        summary={summary}
        onClearSearch={() => {
          onSearchQueryChange("");
        }}
        onRetryDetails={() => {
          setDetailsState({
            status: "not_requested",
          });
        }}
        onSearchQueryChange={onSearchQueryChange}
      />
      <ItemTable
        createItemHref={createItemHref}
        filters={filters}
        locale={locale}
        now={now}
        searchState={searchState}
        sort={sort}
        summary={summary}
        onFilterChange={onFilterChange}
        onSelectItem={onSelectItem}
        onSortChange={onSortChange}
      />
    </>
  );
}

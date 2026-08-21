import { type ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { createSharedDetailsLoader, type PublicDetailsLoader } from "./details-loader.js";
import { ItemDetailsPage } from "./item-details-page.js";
import { ItemsPage } from "./items-page.js";
import { LogicGuidePage } from "./logic-guide-page.js";
import {
  collectWaitingTeamIds,
  createTableFilterOptions,
  formatDateTime,
  formatRelativeTime,
  ITEM_NATURAL_SORT_DIRECTIONS,
  type ItemSort,
  type ItemSortKey,
  type TableFilterKey,
  waitingSubjectKey,
} from "./model.js";
import { PeoplePage } from "./people-page.js";
import { PersonPage } from "./person-page.js";
import { NotificationConditionsPage } from "./notification-conditions-page.js";
import {
  createItemRouteTargets,
  createWebViewHref,
  createWebViewState,
  parseWebViewState,
  type ParsedWebViewState,
  type ValidWebRouteTargets,
  type WebRoute,
  type WebViewState,
} from "./url-state.js";
import {
  createViewerIdentityStore,
  isViewerLogin,
  type ViewerIdentity,
} from "./viewer-identity.js";

type AppProps = Readonly<{
  basePath: string;
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
  title: string;
}>;

type NavigationPage = "items" | "people" | "guide" | "notifications";

type RelativeTimeDisplayProps = Readonly<{
  locale: string;
  now: Date;
  timezone: string;
  value: string;
}>;

const SHELL_WIDTH_CLASS = "mx-auto w-[calc(100%_-_2rem)] max-narrow:w-[calc(100%_-_1rem)]";
const SHELL_CONTAINER_CLASS = `${SHELL_WIDTH_CLASS} max-w-shell`;

const NAVIGATION_PAGES: readonly Readonly<{
  label: string;
  page: NavigationPage;
}>[] = [
  {
    label: "項目一覧",
    page: "items",
  },
  {
    label: "担当者",
    page: "people",
  },
  {
    label: "指標の見方",
    page: "guide",
  },
  {
    label: "通知条件",
    page: "notifications",
  },
];

function RelativeTimeDisplay({ locale, now, timezone, value }: RelativeTimeDisplayProps) {
  return (
    <time
      class="font-mono font-bold tabular-nums"
      dateTime={value}
      title={formatDateTime(value, timezone, locale)}
    >
      {formatRelativeTime(value, now, locale)}
    </time>
  );
}

function routeForNavigationPage(page: NavigationPage): WebRoute {
  switch (page) {
    case "items":
      return {
        page: "items",
      };
    case "people":
      return {
        page: "people",
      };
    case "guide":
      return {
        page: "guide",
      };
    case "notifications":
      return {
        page: "notifications",
      };
  }
}

function isCurrentNavigationPage(route: WebRoute, page: NavigationPage): boolean {
  if (route.page === "item-details") {
    return page === "items";
  }
  if (route.page === "person") {
    return page === "people";
  }
  return route.page === page;
}

function replaceWebViewUrl(basePath: string, state: WebViewState): void {
  window.history.replaceState(
    {},
    "",
    `${createWebViewHref(basePath, state)}${window.location.hash}`,
  );
}

function nextSort<Key extends string>(
  currentSort: Readonly<{
    key: Key;
    direction: ItemSort["direction"];
  }>,
  key: Key,
  naturalDirection: ItemSort["direction"],
): Readonly<{
  key: Key;
  direction: ItemSort["direction"];
}> {
  return {
    key,
    direction:
      currentSort.key === key
        ? currentSort.direction === "ascending"
          ? "descending"
          : "ascending"
        : naturalDirection,
  };
}

/** 公開summary DTOをpathnameで選択したページとして表示する。 */
export function App({ basePath, loadDetails, locale, now, summary, title }: AppProps) {
  const itemTargets = useMemo(() => createItemRouteTargets(summary.items), [summary.items]);
  const itemTargetsByNodeId = useMemo(
    () => new Map(itemTargets.map((target) => [target.nodeId, target])),
    [itemTargets],
  );
  const validTeamIds = useMemo(() => collectWaitingTeamIds(summary), [summary]);
  const validTeamKeys = useMemo(
    () => new Set(validTeamIds.map((teamId) => waitingSubjectKey({ kind: "team", teamId }))),
    [validTeamIds],
  );
  const tableFilterOptions = useMemo(() => createTableFilterOptions(summary), [summary]);
  const validTargets = useMemo<ValidWebRouteTargets>(
    () => ({
      items: itemTargets,
      tableFilterOptions,
      teamIds: validTeamIds,
    }),
    [itemTargets, tableFilterOptions, validTeamIds],
  );
  const sharedLoadDetails = useMemo(() => createSharedDetailsLoader(loadDetails), [loadDetails]);
  const viewerIdentityStore = useMemo(createViewerIdentityStore, []);
  const [viewerIdentityState, setViewerIdentityState] = useState(() => viewerIdentityStore.read());
  const [navigationState, setNavigationState] = useState<ParsedWebViewState>(() =>
    parseWebViewState(window.location, basePath, validTargets),
  );
  const showItemHeadingFocusRing = useRef(false);
  const viewState = navigationState.state;
  const viewerIdentity =
    viewerIdentityState.status === "available" ? viewerIdentityState.identity : undefined;

  useEffect(() => {
    if (navigationState.status !== "valid") {
      replaceWebViewUrl(basePath, navigationState.state);
    }
  }, [basePath, navigationState]);

  useEffect(() => {
    function applyBrowserHistory(): void {
      const parsedState = parseWebViewState(window.location, basePath, validTargets);
      if (parsedState.status !== "valid") {
        replaceWebViewUrl(basePath, parsedState.state);
      }
      showItemHeadingFocusRing.current = false;
      setNavigationState(parsedState);
    }
    window.addEventListener("popstate", applyBrowserHistory);
    return () => {
      window.removeEventListener("popstate", applyBrowserHistory);
    };
  }, [basePath, validTargets]);

  function navigate(nextState: WebViewState, mode: "push" | "replace"): void {
    const href = createWebViewHref(basePath, nextState);
    if (mode === "push") {
      window.history.pushState({}, "", href);
    } else {
      window.history.replaceState({}, "", href);
    }
    setNavigationState({
      status: "valid",
      state: nextState,
    });
  }

  function selectItem(nodeId: string): void {
    const target = itemTargetsByNodeId.get(nodeId);
    if (target == null) {
      throw new TypeError(`選択できない項目です: ${nodeId}`);
    }
    const activeElement = document.activeElement;
    showItemHeadingFocusRing.current =
      activeElement instanceof HTMLElement && activeElement.matches(":focus-visible");
    navigate(
      createWebViewState({
        page: "item-details",
        target,
      }),
      "push",
    );
  }

  function replaceSearchQuery(searchQuery: string): void {
    if (viewState.route.page !== "items") {
      throw new TypeError("項目一覧以外では検索条件を変更できません");
    }
    navigate(
      {
        ...viewState,
        searchQuery,
      },
      "replace",
    );
  }

  function replaceTableFilter(key: TableFilterKey, value: string): void {
    if (viewState.route.page !== "items") {
      throw new TypeError("項目一覧以外では表の絞り込み条件を変更できません");
    }
    navigate(
      {
        ...viewState,
        tableFilters: {
          ...viewState.tableFilters,
          [key]: value,
        },
      },
      "replace",
    );
  }

  function replaceTableSort(key: ItemSortKey): void {
    if (viewState.route.page !== "items" && viewState.route.page !== "person") {
      throw new TypeError("項目一覧と担当者ページ以外では表の並び順を変更できません");
    }
    navigate(
      {
        ...viewState,
        tableSort: nextSort(viewState.tableSort, key, ITEM_NATURAL_SORT_DIRECTIONS[key]),
      },
      "replace",
    );
  }

  function replacePersonTeamIds(teamIds: readonly string[]): void {
    if (viewState.route.page !== "person") {
      throw new TypeError("人ごとのページ以外では所属チームを変更できません");
    }
    const personRoute = viewState.route;
    navigate(
      {
        ...viewState,
        route: {
          ...personRoute,
          teamIds,
        },
      },
      "replace",
    );
    if (
      viewerIdentityState.status === "available" &&
      isViewerLogin(personRoute.login, viewerIdentityState.identity?.login)
    ) {
      setViewerIdentityState(
        viewerIdentityStore.save({
          login: personRoute.login,
          teamIds,
        }),
      );
    }
  }

  function selectPerson(login: string): void {
    navigate(
      createWebViewState({
        page: "person",
        login,
        teamIds: [],
      }),
      "push",
    );
  }

  function filterValidViewerTeamIds(teamIds: readonly string[]): readonly string[] {
    return teamIds.filter((teamId) =>
      validTeamKeys.has(waitingSubjectKey({ kind: "team", teamId })),
    );
  }

  function selectViewerIdentity(identity: ViewerIdentity): void {
    navigate(
      createWebViewState({
        page: "person",
        login: identity.login,
        teamIds: filterValidViewerTeamIds(identity.teamIds),
      }),
      "push",
    );
  }

  function toggleViewerIdentity(): void {
    if (viewState.route.page !== "person") {
      throw new TypeError("人ごとのページ以外では閲覧者情報を変更できません");
    }
    if (viewerIdentityState.status === "unavailable") {
      throw new TypeError("閲覧者情報の記憶機能は利用できません");
    }
    if (isViewerLogin(viewState.route.login, viewerIdentityState.identity?.login)) {
      setViewerIdentityState(viewerIdentityStore.clear());
      return;
    }
    setViewerIdentityState(
      viewerIdentityStore.save({
        login: viewState.route.login,
        teamIds: viewState.route.teamIds,
      }),
    );
  }

  function createItemHref(nodeId: string): string {
    const target = itemTargetsByNodeId.get(nodeId);
    if (target == null) {
      throw new TypeError(`deep linkを作成できない項目です: ${nodeId}`);
    }
    return createWebViewHref(
      basePath,
      createWebViewState({
        page: "item-details",
        target,
      }),
    );
  }

  function createPersonHref(login: string): string {
    return createWebViewHref(
      basePath,
      createWebViewState({
        page: "person",
        login,
        teamIds: [],
      }),
    );
  }

  function createViewerIdentityHref(identity: ViewerIdentity): string {
    return createWebViewHref(
      basePath,
      createWebViewState({
        page: "person",
        login: identity.login,
        teamIds: filterValidViewerTeamIds(identity.teamIds),
      }),
    );
  }

  function renderPage(): ComponentChildren {
    switch (viewState.route.page) {
      case "items":
        return (
          <ItemsPage
            createItemHref={createItemHref}
            createPersonHref={createPersonHref}
            filterOptions={tableFilterOptions}
            filters={viewState.tableFilters}
            loadDetails={sharedLoadDetails}
            now={now}
            searchQuery={viewState.searchQuery}
            sort={viewState.tableSort}
            summary={summary}
            onFilterChange={replaceTableFilter}
            onSearchQueryChange={replaceSearchQuery}
            onSelectItem={selectItem}
            onSelectPerson={selectPerson}
            onSortChange={replaceTableSort}
          />
        );
      case "item-details":
        return (
          <ItemDetailsPage
            key={viewState.route.target.nodeId}
            clearSelectionHref={createWebViewHref(
              basePath,
              createWebViewState({
                page: "items",
              }),
            )}
            createItemHref={createItemHref}
            createPersonHref={createPersonHref}
            showHeadingFocusRing={showItemHeadingFocusRing.current}
            loadDetails={sharedLoadDetails}
            locale={locale}
            now={now}
            summary={summary}
            target={viewState.route.target}
            onClearSelection={() => {
              navigate(
                createWebViewState({
                  page: "items",
                }),
                "push",
              );
            }}
            onSelectItem={selectItem}
            onSelectPerson={selectPerson}
          />
        );
      case "people":
        return (
          <PeoplePage
            createPersonHref={createPersonHref}
            locale={locale}
            now={now}
            summary={summary}
            viewerLogin={viewerIdentity?.login}
            onSelectPerson={selectPerson}
          />
        );
      case "guide":
        return <LogicGuidePage />;
      case "notifications":
        return <NotificationConditionsPage />;
      case "person":
        return (
          <PersonPage
            createItemHref={createItemHref}
            createPersonHref={createPersonHref}
            isViewerIdentity={isViewerLogin(viewState.route.login, viewerIdentity?.login)}
            login={viewState.route.login}
            now={now}
            peopleHref={createWebViewHref(
              basePath,
              createWebViewState({
                page: "people",
              }),
            )}
            selectedTeamIds={viewState.route.teamIds}
            sort={viewState.tableSort}
            summary={summary}
            viewerIdentityAvailable={viewerIdentityState.status === "available"}
            onSelectItem={selectItem}
            onSelectPerson={selectPerson}
            onSelectPeople={() => {
              navigate(
                createWebViewState({
                  page: "people",
                }),
                "push",
              );
            }}
            onSortChange={replaceTableSort}
            onTeamIdsChange={replacePersonTeamIds}
            onViewerIdentityToggle={toggleViewerIdentity}
          />
        );
      default:
        throw new UnreachableError(viewState.route);
    }
  }

  function navigateToPage(page: NavigationPage): void {
    navigate(createWebViewState(routeForNavigationPage(page)), "push");
  }

  return (
    <>
      <a
        class="skip-link absolute top-3 left-3 -translate-y-[180%] rounded-xl bg-text-primary px-4 py-2.5 text-text-inverse focus:translate-y-0"
        href="#main-content"
      >
        本文へ移動
      </a>
      <header
        class={`site-header ${SHELL_CONTAINER_CLASS} grid grid-cols-[max-content_minmax(0,1fr)_max-content] items-center gap-4 py-3 max-shell:grid-cols-[minmax(0,1fr)_max-content] max-shell:gap-x-4 max-shell:gap-y-1 max-narrow:py-2`}
      >
        <div class="site-identity min-w-0">
          <h1 class="m-0 font-display text-base leading-tight font-semibold tracking-tight">
            {title}
          </h1>
        </div>
        <nav
          class="global-navigation min-w-0 justify-self-center max-shell:col-span-2 max-shell:col-start-1 max-shell:row-start-2 max-shell:justify-self-start"
          aria-label="グローバルナビゲーション"
        >
          <ul class="m-0 flex list-none flex-wrap justify-center gap-1.5 p-0 max-shell:justify-start">
            {NAVIGATION_PAGES.map((navigationPage) => {
              const route = routeForNavigationPage(navigationPage.page);
              const href = createWebViewHref(basePath, createWebViewState(route));
              const current = isCurrentNavigationPage(viewState.route, navigationPage.page);
              return (
                <li key={navigationPage.page}>
                  <a
                    class={`flex min-h-11 items-center rounded-full px-2.5 py-1.5 text-action-text no-underline hover:bg-surface-emphasis hover:text-accent-link-hover max-narrow:px-2 ${
                      current ? "bg-surface-emphasis font-bold text-text-primary" : ""
                    }`}
                    href={href}
                    aria-current={current ? "page" : undefined}
                    onClick={(event) => {
                      if (!shouldHandleClientNavigation(event)) {
                        return;
                      }
                      event.preventDefault();
                      navigateToPage(navigationPage.page);
                    }}
                  >
                    {navigationPage.label}
                  </a>
                </li>
              );
            })}
            {viewerIdentity != null && (
              <li>
                <a
                  class="viewer-navigation-link flex min-h-11 items-center rounded-full bg-surface-emphasis px-2.5 py-1.5 font-bold text-text-primary no-underline hover:bg-surface-emphasis hover:text-accent-link-hover max-narrow:px-2"
                  href={createViewerIdentityHref(viewerIdentity)}
                  onClick={(event) => {
                    if (!shouldHandleClientNavigation(event)) {
                      return;
                    }
                    event.preventDefault();
                    selectViewerIdentity(viewerIdentity);
                  }}
                >
                  自分の担当 @{viewerIdentity.login}
                </a>
              </li>
            )}
          </ul>
        </nav>
        <p class="site-observed-time m-0 flex flex-wrap items-baseline justify-end gap-x-2 text-right max-shell:col-start-2 max-shell:row-start-1">
          <span class="time-label text-xs font-bold text-text-muted">最新更新</span>
          <RelativeTimeDisplay
            value={summary.observedAt}
            now={now}
            timezone={summary.timezone}
            locale={locale}
          />
        </p>
      </header>
      <main id="main-content" class={`${SHELL_CONTAINER_CLASS} grid gap-5`}>
        {navigationState.status === "sanitized" && (
          <p
            class="notice notice-warning url-state-notice my-4 rounded-xl border-l-4 border-state-warning-border bg-state-warning-background px-4 py-3.5 text-state-warning-text"
            role="status"
            aria-live="polite"
          >
            URLに含まれる不正または未対応の表示条件を無視しました。
          </p>
        )}
        {renderPage()}
      </main>
      <footer class={`${SHELL_CONTAINER_CLASS} mt-auto py-6 text-sm text-text-muted`}>
        <small class="footer-run-id block font-mono text-xs wrap-anywhere">
          Run {summary.runId}
        </small>
      </footer>
    </>
  );
}

/** 公開DTOを読み込めなかったことを画面へ通知する。 */
export function DataLoadFailure() {
  return (
    <main
      class={`load-failure ${SHELL_WIDTH_CLASS} mt-16 block max-w-2xl rounded-2xl border border-border-default bg-surface-card p-8`}
    >
      <h1 class="mt-0 mb-4 font-display text-lg font-semibold">データを表示できません</h1>
      <p class="m-0">
        公開データの読み込みまたは検証に失敗しました。時間を置いて再度確認してください。
      </p>
    </main>
  );
}

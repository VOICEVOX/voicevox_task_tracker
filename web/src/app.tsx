import { type ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { createSharedDetailsLoader, type PublicDetailsLoader } from "./details-loader.js";
import { ItemDetailsPage } from "./item-details-page.js";
import { ItemsPage } from "./items-page.js";
import { collectWaitingTeamIds, type TableColumnKey, waitingSubjectKey } from "./model.js";
import { OverviewPage } from "./overview-page.js";
import { PeoplePage } from "./people-page.js";
import { PersonPage } from "./person-page.js";
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

type NavigationPage = "overview" | "items" | "people";

const NAVIGATION_PAGES: readonly Readonly<{
  label: string;
  page: NavigationPage;
}>[] = [
  {
    label: "概要",
    page: "overview",
  },
  {
    label: "項目一覧",
    page: "items",
  },
  {
    label: "担当者",
    page: "people",
  },
];

function routeForNavigationPage(page: NavigationPage): WebRoute {
  switch (page) {
    case "overview":
      return {
        page: "overview",
      };
    case "items":
      return {
        page: "items",
      };
    case "people":
      return {
        page: "people",
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
  const validTargets = useMemo<ValidWebRouteTargets>(
    () => ({
      items: itemTargets,
      teamIds: validTeamIds,
    }),
    [itemTargets, validTeamIds],
  );
  const sharedLoadDetails = useMemo(() => createSharedDetailsLoader(loadDetails), [loadDetails]);
  const viewerIdentityStore = useMemo(createViewerIdentityStore, []);
  const [viewerIdentityState, setViewerIdentityState] = useState(() => viewerIdentityStore.read());
  const [navigationState, setNavigationState] = useState<ParsedWebViewState>(() =>
    parseWebViewState(window.location, basePath, validTargets),
  );
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

  function replaceTableFilter(key: TableColumnKey, value: string): void {
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

  function replaceTableSort(key: TableColumnKey): void {
    if (viewState.route.page !== "items") {
      throw new TypeError("項目一覧以外では表の並び順を変更できません");
    }
    navigate(
      {
        ...viewState,
        tableSort: {
          key,
          direction:
            viewState.tableSort.key === key && viewState.tableSort.direction === "ascending"
              ? "descending"
              : "ascending",
        },
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
      case "overview":
        return (
          <OverviewPage
            createItemHref={createItemHref}
            locale={locale}
            now={now}
            summary={summary}
            onSelectItem={selectItem}
          />
        );
      case "items":
        return (
          <ItemsPage
            createItemHref={createItemHref}
            filters={viewState.tableFilters}
            loadDetails={sharedLoadDetails}
            locale={locale}
            now={now}
            searchQuery={viewState.searchQuery}
            sort={viewState.tableSort}
            summary={summary}
            onFilterChange={replaceTableFilter}
            onSearchQueryChange={replaceSearchQuery}
            onSelectItem={selectItem}
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
      case "person":
        return (
          <PersonPage
            createItemHref={createItemHref}
            isViewerIdentity={isViewerLogin(viewState.route.login, viewerIdentity?.login)}
            locale={locale}
            login={viewState.route.login}
            now={now}
            selectedTeamIds={viewState.route.teamIds}
            summary={summary}
            viewerIdentityAvailable={viewerIdentityState.status === "available"}
            onSelectItem={selectItem}
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
      <a class="skip-link" href="#main-content">
        本文へ移動
      </a>
      <header class="site-header">
        <div class="site-identity">
          <p class="eyebrow">VOICEVOX Organization</p>
          <h1>{title}</h1>
        </div>
        <nav class="global-navigation" aria-label="グローバルナビゲーション">
          <ul>
            {NAVIGATION_PAGES.map((navigationPage) => {
              const route = routeForNavigationPage(navigationPage.page);
              const href = createWebViewHref(basePath, createWebViewState(route));
              return (
                <li key={navigationPage.page}>
                  <a
                    href={href}
                    aria-current={
                      isCurrentNavigationPage(viewState.route, navigationPage.page)
                        ? "page"
                        : undefined
                    }
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
                  class="viewer-navigation-link"
                  href={createViewerIdentityHref(viewerIdentity)}
                  onClick={(event) => {
                    if (!shouldHandleClientNavigation(event)) {
                      return;
                    }
                    event.preventDefault();
                    selectViewerIdentity(viewerIdentity);
                  }}
                >
                  自分の担当
                </a>
              </li>
            )}
          </ul>
        </nav>
        <details class="run-details">
          <summary>実行情報</summary>
          <p class="run-id">Run {summary.runId}</p>
        </details>
      </header>
      <main id="main-content">
        {navigationState.status === "sanitized" && (
          <p class="notice notice-warning url-state-notice" role="status" aria-live="polite">
            URLに含まれる不正または未対応の表示条件を無視しました。
          </p>
        )}
        {renderPage()}
      </main>
      <footer>
        <p>GitHubの公開情報を読み取り専用で整理しています。</p>
      </footer>
    </>
  );
}

/** 公開DTOを読み込めなかったことを画面へ通知する。 */
export function DataLoadFailure() {
  return (
    <main class="load-failure">
      <h1>データを表示できません</h1>
      <p>公開データの読み込みまたは検証に失敗しました。時間を置いて再度確認してください。</p>
    </main>
  );
}

import axe from "axe-core";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import indexHtml from "../index.html?raw";
import sampleDetailsSource from "../public/data/details.json";
import sampleSummarySource from "../public/data/summary.json";
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { App } from "./app.js";
import { createGitHubAvatarUrl } from "./github-avatar.js";
import {
  aiAnalysisNotice,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  type ItemSortKey,
  type TableFilterKey,
  type TableFilters,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import { VIEWER_IDENTITY_STORAGE_KEY } from "./viewer-identity.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const LOCALE = "ja-JP";
const TITLE = "VOICEVOX Task Tracker";
const BASE_PATH = "/voicevox_task_tracker/";
const sampleDetails = createPublicDetailsDto(sampleDetailsSource);
const sampleSummary = createPublicSummaryDto(sampleSummarySource);
const ITEM_SORT_KEYS: readonly ItemSortKey[] = ["attention", "importance", "stall"];

let container: HTMLDivElement | undefined;

function currentContainer(): HTMLDivElement {
  assertNonNullable(container, "テスト用の描画先がありません");
  return container;
}

function renderApp(summary: PublicSummaryDto): void {
  renderAppWithDetails(summary, sampleDetails);
}

function storeViewerIdentity(login: string, teamIds: readonly string[]): void {
  window.localStorage.setItem(
    VIEWER_IDENTITY_STORAGE_KEY,
    JSON.stringify({
      login,
      teamIds,
    }),
  );
}

function renderAppWithDetails(summary: PublicSummaryDto, details: PublicDetailsDto): void {
  renderAppWithLoader(summary, () => Promise.resolve(details));
}

function renderAppWithLoader(
  summary: PublicSummaryDto,
  loadDetails: () => Promise<PublicDetailsDto>,
): void {
  act(() => {
    render(
      <App
        basePath={BASE_PATH}
        loadDetails={loadDetails}
        locale={LOCALE}
        now={NOW}
        summary={summary}
        title={TITLE}
      />,
      currentContainer(),
    );
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  });
}

async function enterSearch(value: string): Promise<void> {
  const search = requiredElement<HTMLInputElement>("#item-search-input");
  await act(async () => {
    search.value = value;
    search.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
      }),
    );
    await Promise.resolve();
  });
  await flushUi();
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = currentContainer().querySelector<ElementType>(selector);
  assertNonNullable(element, `要素がありません: ${selector}`);
  return element;
}

function expectGitHubAvatar(
  scope: ParentNode,
  expectedLogin: string,
  expectedSize: number,
  expectedSizeClassName: string,
): HTMLImageElement {
  const expectedSource = createGitHubAvatarUrl(expectedLogin);
  const avatars = [...scope.querySelectorAll<HTMLImageElement>("img")].filter(
    (image) => image.getAttribute("src") === expectedSource,
  );
  expect(avatars).toHaveLength(1);
  const avatar = avatars[0];
  assertNonNullable(avatar, "GitHubアバターがありません");
  expect(avatar.getAttribute("alt")).toBe("");
  expect(avatar.getAttribute("loading")).toBe("lazy");
  expect(avatar.getAttribute("decoding")).toBe("async");
  expect(avatar.getAttribute("width")).toBe(expectedSize.toString());
  expect(avatar.getAttribute("height")).toBe(expectedSize.toString());
  expect([...avatar.classList]).toEqual(
    expect.arrayContaining([
      expectedSizeClassName,
      "rounded-full",
      "border",
      "border-border-default",
      "bg-surface-page",
    ]),
  );
  return avatar;
}

function expectGitHubIconButton(scope: ParentNode, expectedHref: string): HTMLAnchorElement {
  const links = scope.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]');
  expect(links).toHaveLength(1);
  const link = links[0];
  assertNonNullable(link, "GitHubアイコンボタンがありません");
  expect(link.getAttribute("href")).toBe(expectedHref);
  expect(link.getAttribute("aria-label")).toBe("GitHubで開く");
  expect(link.title).toBe("GitHubで開く");
  expect(link.textContent).toBe("");
  expect([...link.classList]).toEqual(expect.arrayContaining(["size-11", "min-h-11", "min-w-11"]));
  expect(link.classList).toContain("hover:bg-surface-emphasis");
  expect(link.classList).toContain("focus-visible:bg-surface-emphasis");
  expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  return link;
}

function expectItemListHeading(
  scope: ParentNode,
  expectedMeta: string,
  expectedGitHubHref: string,
): void {
  const heading = scope.querySelector<HTMLElement>(".item-list-heading");
  assertNonNullable(heading, "項目の共通見出しがありません");
  const title = heading.querySelector<HTMLElement>(":scope > .item-list-title");
  const meta = heading.querySelector<HTMLElement>(":scope > .item-list-meta");
  assertNonNullable(title, "共通見出しのタイトル行がありません");
  assertNonNullable(meta, "共通見出しの補助情報行がありません");
  expect(heading.firstElementChild).toBe(title);
  expect(title.nextElementSibling).toBe(meta);
  expect([...title.classList]).toEqual(expect.arrayContaining(["text-base", "font-semibold"]));
  expect(title.classList).not.toContain("text-lg");
  expect(title.classList).not.toContain("font-bold");
  expect([...meta.classList]).toEqual(expect.arrayContaining(["text-xs", "text-text-muted"]));
  expect(meta.textContent).toBe(expectedMeta);
  const typeBadge = meta.querySelector<HTMLElement>(".item-type-badge");
  assertNonNullable(typeBadge, "項目種別のバッジがありません");
  expect(typeBadge.classList).toContain("rounded-full");
  if (typeBadge.textContent === "Issue") {
    expect([...typeBadge.classList]).toEqual(
      expect.arrayContaining(["bg-state-success-background", "text-state-success-text"]),
    );
  } else {
    expect(typeBadge.textContent).toBe("Pull Request");
    expect([...typeBadge.classList]).toEqual(
      expect.arrayContaining(["bg-state-info-background", "text-state-info-text"]),
    );
  }
  const aiNotice = title.querySelector(".ai-analysis-notice-icon");
  const githubLink = expectGitHubIconButton(scope, expectedGitHubHref);
  expect(title.lastElementChild).toBe(githubLink);
  if (aiNotice != null) {
    expect(aiNotice.nextElementSibling).toBe(githubLink);
  }
}

function itemRowNodeIds(): readonly string[] {
  return [...currentContainer().querySelectorAll<HTMLTableRowElement>(".items-table tbody tr")].map(
    (row) => row.dataset["nodeId"] ?? "",
  );
}

function createPersonPageSummary(): PublicSummaryDto {
  const reviewerItem = sampleSummary.items.find((item) => item.nodeId === "sample-item-engine-202");
  assertNonNullable(reviewerItem, "人ページテスト用のレビュー項目がありません");
  const reviewerWaitingOn = reviewerItem.waitingOn[0];
  assertNonNullable(reviewerWaitingOn, "人ページテスト用のwaitingOnがありません");
  return createPublicSummaryDto({
    ...sampleSummary,
    items: sampleSummary.items.map((item) => {
      switch (item.nodeId) {
        case "sample-item-editor-101":
          return {
            ...item,
            waitingOn: [
              {
                ...reviewerWaitingOn,
                kind: "user",
                candidateId: "aoirint",
                reasonSummary: "aoirintさんの確認を待っています",
              },
              {
                ...reviewerWaitingOn,
                kind: "user",
                candidateId: "HiHo",
                reasonSummary: "HiHoさんの確認を待っています",
              },
            ],
          };
        case "sample-item-engine-202":
          return {
            ...item,
            waitingOn: [
              {
                ...reviewerWaitingOn,
                candidateId: "VOICEVOX/Maintainers",
              },
            ],
          };
        case "sample-item-editor-103":
          return {
            ...item,
            waitingOn: [
              {
                ...reviewerWaitingOn,
                candidateId: "VOICEVOX/Reviewers",
                reasonSummary: "レビューチームの確認を待っています",
              },
            ],
          };
        default:
          return item;
      }
    }),
  });
}

function createPersonPageSummaryWithLowImportance(): PublicSummaryDto {
  const summary = createPersonPageSummary();
  const directItem = summary.items.find((item) => item.nodeId === "sample-item-editor-101");
  assertNonNullable(directItem, "担当者ページテスト用の直接担当項目がありません");
  const directWaitingOn = directItem.waitingOn.find(
    (waitingOn) => waitingOn.candidateId.toLowerCase() === "hiho",
  );
  assertNonNullable(directWaitingOn, "担当者ページテスト用の直接担当がありません");
  return createPublicSummaryDto({
    ...summary,
    items: summary.items.map((item) =>
      item.nodeId === "sample-item-engine-204"
        ? {
            ...item,
            waitingOn: [
              {
                ...directWaitingOn,
                reasonSummary: "HiHoさんの対応を待っています",
              },
            ],
          }
        : item,
    ),
  });
}

function createPeoplePageSummary(): PublicSummaryDto {
  const summary = createPersonPageSummary();
  const hihoItem = summary.items.find((item) => item.nodeId === "sample-item-editor-101");
  assertNonNullable(hihoItem, "担当者一覧テスト用の項目がありません");
  const hihoWaitingOn = hihoItem.waitingOn[0];
  assertNonNullable(hihoWaitingOn, "担当者一覧テスト用のwaitingOnがありません");
  return createPublicSummaryDto({
    ...summary,
    items: summary.items.map((item) =>
      item.nodeId === "sample-item-editor-103"
        ? {
            ...item,
            waitingOn: [
              ...item.waitingOn,
              {
                ...hihoWaitingOn,
                candidateId: "HiHo",
                reasonSummary: "HiHoさんの確認を待っています",
              },
            ],
          }
        : item,
    ),
  });
}

function filtersWith(key: TableFilterKey, value: string): TableFilters {
  return {
    ...createEmptyTableFilters(),
    [key]: value,
  };
}

function colorChannel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  return (
    0.2126 * colorChannel(hex, 0) + 0.7152 * colorChannel(hex, 2) + 0.0722 * colorChannel(hex, 4)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/voicevox_task_tracker/");
  container = document.createElement("div");
  document.body.replaceChildren(currentContainer());
});

afterEach(() => {
  render(null, currentContainer());
  document.body.replaceChildren();
  container = undefined;
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Web UI", () => {
  it("loginをencodeしてGitHubアバターのURLを組み立てる", () => {
    expect(createGitHubAvatarUrl("sample/name")).toBe(
      "https://github.com/sample%2Fname.png?size=48",
    );
  });

  it("トップページに全項目を要対応度の降順で表示する", () => {
    renderApp(sampleSummary);

    expect(requiredElement<HTMLHeadingElement>("#items-heading").textContent).toBe("項目一覧");
    expect(currentContainer().querySelector(".item-workspace .section-heading p")).toBeNull();
    expect(itemRowNodeIds()).toEqual(
      filterAndSortTableRows(createItemTableRows(sampleSummary, NOW), createEmptyTableFilters(), {
        key: "attention",
        direction: "descending",
      }).map((row) => row.item.nodeId),
    );
    expect(itemRowNodeIds()).toHaveLength(sampleSummary.items.length);
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("attention");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    const observedTime = requiredElement<HTMLTimeElement>(".site-observed-time time");
    expect(observedTime.closest(".site-header")).not.toBeNull();
    expect(observedTime.dateTime).toBe(sampleSummary.observedAt);
    expect(observedTime.textContent).toBe("1日前");
    expect(observedTime.title).toContain("JST");
    expect(requiredElement<HTMLElement>(".time-label").textContent).toBe("最新更新");
    expect(currentContainer().querySelector(".attention-section")).toBeNull();
  });

  it("項目一覧の個人loginとアバターから人ごとのページへ遷移しチームはリンクにしない", () => {
    renderApp(sampleSummary);

    const personLink = requiredElement<HTMLAnchorElement>(
      '.items-table tr[data-node-id="sample-item-core-305"] .item-primary-waiting-on .person-link',
    );
    expect(personLink.textContent).toBe("@sample-bug-author");
    expect(personLink.getAttribute("href")).toBe("/voicevox_task_tracker/people/sample-bug-author");
    const personWaitingOn = personLink.closest<HTMLElement>(".item-primary-waiting-on");
    assertNonNullable(personWaitingOn, "個人の待ち相手表示がありません");
    expect(personWaitingOn.textContent).toBe("推定: 作成者 @sample-bug-author");
    const avatar = expectGitHubAvatar(personWaitingOn, "sample-bug-author", 20, "size-5");
    expect(avatar.parentElement).toBe(personLink);
    const teamWaitingOn = requiredElement<HTMLElement>(
      '.items-table tr[data-node-id="sample-item-engine-202"] .item-primary-waiting-on',
    );
    expect(teamWaitingOn.textContent).toBe("レビュワー チーム sample-reviewers");
    expect(teamWaitingOn.querySelector("a")).toBeNull();
    expect(teamWaitingOn.querySelector("img")).toBeNull();

    act(() => {
      avatar.click();
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/people/sample-bug-author");
    expect(requiredElement<HTMLHeadingElement>("#person-page-heading").textContent).toBe(
      "@sample-bug-author を待っている項目",
    );
  });

  it.each([
    {
      headingSelector: "#items-heading",
      pageName: "項目一覧",
      path: "/voicevox_task_tracker/",
    },
    {
      headingSelector: "#item-details-page-heading",
      pageName: "項目詳細",
      path: "/voicevox_task_tracker/items/sample-editor/101",
    },
    {
      headingSelector: "#people-page-heading",
      pageName: "担当者一覧",
      path: "/voicevox_task_tracker/people",
    },
    {
      headingSelector: "#person-page-heading",
      pageName: "担当者個別",
      path: "/voicevox_task_tracker/people/HiHo",
    },
  ])("$pageNameページで見出し階層と文字の大きさを統一する", ({ headingSelector, path }) => {
    window.history.replaceState({}, "", path);
    renderAppWithLoader(sampleSummary, () => new Promise<PublicDetailsDto>(() => {}));

    const siteTitle = requiredElement<HTMLHeadingElement>(".site-identity h1");
    const pageHeading = requiredElement<HTMLHeadingElement>(headingSelector);
    expect(siteTitle.tagName).toBe("H1");
    expect([...siteTitle.classList]).toEqual(
      expect.arrayContaining(["font-display", "text-base", "font-semibold"]),
    );
    expect(siteTitle.classList).not.toContain("font-bold");
    expect(pageHeading.tagName).toBe("H2");
    expect([...pageHeading.classList]).toEqual(
      expect.arrayContaining(["font-display", "text-lg", "font-semibold"]),
    );
    expect(pageHeading.classList).not.toContain("font-bold");
    expect(pageHeading.classList).not.toContain("max-narrow:text-base");
    const pageSection = pageHeading.closest<HTMLElement>(".section-card");
    assertNonNullable(pageSection, "ページ見出しを囲むセクションがありません");
    expect([...pageSection.classList]).toEqual(
      expect.arrayContaining(["rounded-2xl", "border", "border-border-default", "bg-surface-card"]),
    );
    expect(pageSection.classList).not.toContain("shadow-card");
  });

  it("AIが設定で無効なときはトップ項目一覧へ全体通知を表示する", () => {
    renderApp({
      ...sampleSummary,
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
    });

    const notice = requiredElement<HTMLElement>(".ai-state-notice");
    const notices = requiredElement<HTMLElement>(".item-workspace > .item-list-notices");
    const sectionHeading = requiredElement<HTMLElement>(".item-workspace > .section-heading");
    const toolbar = requiredElement<HTMLElement>(".item-workspace > .item-list-toolbar");
    expect(notice.textContent).toBe("AI分析は設定で無効です。確定ルールで表示しています。");
    expect(sectionHeading.nextElementSibling).toBe(notices);
    expect(notices.firstElementChild).toBe(notice);
    expect(notices.nextElementSibling).toBe(toolbar);
  });

  it.each([
    ["利用不可", { enabled: true, available: false, degraded: true }],
    ["縮退", { enabled: true, available: true, degraded: true }],
  ] as const)("AIの%sだけではトップ項目一覧へ全体通知を表示しない", (_state, ai) => {
    renderApp({
      ...sampleSummary,
      ai,
    });

    expect(currentContainer().querySelector(".ai-state-notice")).toBeNull();
    expect(currentContainer().textContent).not.toContain(
      "AI分析は設定で無効です。確定ルールで表示しています。",
    );
  });

  it.each([
    {
      pageName: "項目一覧",
      path: "/voicevox_task_tracker/",
    },
    {
      pageName: "項目詳細",
      path: "/voicevox_task_tracker/items/sample-editor/101",
    },
    {
      pageName: "担当者一覧",
      path: "/voicevox_task_tracker/people",
    },
    {
      pageName: "担当者個別",
      path: "/voicevox_task_tracker/people/HiHo",
    },
  ])("$pageNameページで観測時刻を共通ヘッダーだけに表示する", ({ path }) => {
    window.history.replaceState({}, "", path);
    renderAppWithLoader(sampleSummary, () => new Promise<PublicDetailsDto>(() => {}));

    const observedDisplays = currentContainer().querySelectorAll(".site-observed-time");
    expect(observedDisplays).toHaveLength(1);
    const observedTime = requiredElement<HTMLTimeElement>(".site-observed-time time");
    expect(observedTime.closest(".site-header")).not.toBeNull();
    expect(currentContainer().querySelector("main .site-observed-time")).toBeNull();
    expect(observedTime.dateTime).toBe(sampleSummary.observedAt);
    expect(observedTime.textContent).toBe("1日前");
    expect(observedTime.title).toContain("JST");
  });

  it.each([
    {
      pageName: "項目一覧",
      path: "/voicevox_task_tracker/",
      summary: sampleSummary,
      tableSelector: ".items-table",
    },
    {
      pageName: "担当者一覧",
      path: "/voicevox_task_tracker/people",
      summary: createPeoplePageSummary(),
      tableSelector: ".people-table",
    },
    {
      pageName: "担当者個別",
      path: "/voicevox_task_tracker/people/hiho",
      summary: createPersonPageSummary(),
      tableSelector: ".person-items-table",
    },
  ])(
    "$pageNameページの表で全列見出しを不透明な背景と下境界付きで固定する",
    ({ path, summary, tableSelector }) => {
      window.history.replaceState({}, "", path);
      renderApp(summary);

      const tableHeaders = currentContainer().querySelectorAll(`${tableSelector} thead th`);
      expect(tableHeaders.length).toBeGreaterThan(0);
      for (const tableHeader of tableHeaders) {
        expect([...tableHeader.classList]).toEqual(
          expect.arrayContaining([
            "sticky",
            "top-0",
            "border-b",
            "border-border-subtle",
            "bg-surface-sunken",
          ]),
        );
      }
    },
  );

  it.each([
    {
      controlsSelector: ".item-sort-controls",
      pageName: "項目一覧",
      pageSelector: ".item-workspace",
      path: "/voicevox_task_tracker/",
      summary: sampleSummary,
    },
    {
      controlsSelector: ".person-sort-controls",
      pageName: "担当者個別",
      pageSelector: ".person-page",
      path: "/voicevox_task_tracker/people/hiho",
      summary: createPersonPageSummary(),
    },
  ])(
    "$pageNameページの並び順UIをカード表示幅だけに出す",
    ({ controlsSelector, pageSelector, path, summary }) => {
      window.history.replaceState({}, "", path);
      renderApp(summary);

      const page = requiredElement<HTMLElement>(pageSelector);
      const controls = requiredElement<HTMLElement>(controlsSelector);
      const tableRegion = requiredElement<HTMLElement>(`${pageSelector} > .items-table-region`);
      const cardList = requiredElement<HTMLElement>(`${pageSelector} > .items-card-list`);
      expect(page.contains(controls)).toBe(true);
      expect(controls.classList).toContain("grid");
      expect(controls.classList).toContain("lg:hidden");
      expect(controls.classList).not.toContain("hidden");
      expect(tableRegion.classList).toContain("lg:block");
      expect(cardList.classList).toContain("lg:hidden");
      for (const listFrame of [tableRegion, cardList]) {
        expect([...listFrame.classList]).toEqual(
          expect.arrayContaining([
            "overflow-hidden",
            "rounded-2xl",
            "border",
            "border-border-default",
            "bg-surface-card",
            "shadow-[0_8px_24px_rgba(34,52,45,0.04)]",
          ]),
        );
      }
    },
  );

  it("グローバルナビゲーションを実リンクとして表示しpathごとにページを切り替える", () => {
    const loadDetails = vi.fn(() => Promise.resolve(sampleDetails));
    renderAppWithLoader(sampleSummary, loadDetails);

    const itemsLink = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/"]',
    );
    const peopleLink = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/people"]',
    );
    expect(
      [...currentContainer().querySelectorAll(".global-navigation a")].map(
        (link) => link.textContent,
      ),
    ).toEqual(["項目一覧", "担当者"]);
    expect(itemsLink.getAttribute("aria-current")).toBe("page");
    const header = requiredElement<HTMLElement>(".site-header");
    expect(header.textContent).not.toContain("VOICEVOX Organization");
    expect(header.textContent).not.toContain("実行情報");
    const footer = requiredElement<HTMLElement>("footer");
    expect(footer.textContent).not.toContain("GitHubの公開情報を読み取り専用で整理しています。");
    expect(footer.children).toHaveLength(1);
    expect(requiredElement<HTMLElement>(".footer-run-id").textContent).toBe(
      `Run ${sampleSummary.runId}`,
    );
    expect(currentContainer().querySelector(".items-table")).not.toBeNull();

    act(() => {
      peopleLink.click();
    });
    expect(window.location.pathname).toBe("/voicevox_task_tracker/people");
    expect(currentContainer().textContent).toContain("担当者一覧");

    act(() => {
      itemsLink.click();
    });
    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
    expect(itemsLink.getAttribute("aria-current")).toBe("page");
    expect(currentContainer().querySelector(".items-table")).not.toBeNull();
    expect(loadDetails).not.toHaveBeenCalled();
  });

  it("担当者一覧を項目数の降順で描画する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people");

    renderApp(createPeoplePageSummary());

    expect(requiredElement<HTMLHeadingElement>("#people-page-heading").textContent).toBe(
      "担当者一覧",
    );
    expect(
      [...currentContainer().querySelectorAll(".people-table thead th")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["待ち相手", "待たせている項目数", "最長停滞時間"]);
    expect(
      [...currentContainer().querySelectorAll(".people-table tbody tr")].map((row) => ({
        itemCount: row.querySelector("td")?.textContent,
        subject: row.querySelector("th")?.textContent,
      })),
    ).toEqual([
      { subject: "@sample-workflow-contributor", itemCount: "3" },
      { subject: "@HiHo", itemCount: "2" },
      { subject: "@aoirint", itemCount: "1" },
      { subject: "@sample-bug-author", itemCount: "1" },
      { subject: "@sample-maintainer", itemCount: "1" },
      { subject: "チーム VOICEVOX/Maintainers", itemCount: "1" },
      { subject: "チーム VOICEVOX/Reviewers", itemCount: "1" },
    ]);
    expect(
      requiredElement<HTMLTableRowElement>(".people-table tbody tr:last-child").querySelector("a"),
    ).toBeNull();
    const hihoLink = requiredElement<HTMLAnchorElement>(
      '.people-table a[href="/voicevox_task_tracker/people/HiHo"]',
    );
    const hihoRow = hihoLink.closest<HTMLTableRowElement>("tr");
    assertNonNullable(hihoRow, "HiHoの担当者行がありません");
    const hihoAvatar = expectGitHubAvatar(hihoRow, "HiHo", 20, "size-5");
    expect(hihoAvatar.parentElement).toBe(hihoLink);
    expect(
      requiredElement<HTMLTableRowElement>(".people-table tbody tr:last-child").querySelector(
        "img",
      ),
    ).toBeNull();
    expect(
      requiredElement<HTMLElement>(".people-page > .items-table-region").querySelector(
        ".people-table",
      ),
    ).not.toBeNull();
    expect(requiredElement<HTMLElement>(".people-page > .items-table-region").classList).toContain(
      "md:block",
    );
    expect(requiredElement<HTMLElement>(".people-card-list").classList).toContain("md:hidden");
    expect(
      [...currentContainer().querySelectorAll(".people-card-list h3")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      "@sample-workflow-contributor",
      "@HiHo",
      "@aoirint",
      "@sample-bug-author",
      "@sample-maintainer",
      "チーム VOICEVOX/Maintainers",
      "チーム VOICEVOX/Reviewers",
    ]);
    expect(
      [
        ...requiredElement<HTMLElement>(".people-card-list li:first-child").querySelectorAll("dt"),
      ].map((heading) => heading.textContent),
    ).toEqual(["待たせている項目数", "最長停滞時間"]);
    expect(currentContainer().textContent).not.toContain(
      "チーム宛の待ちは、担当者ページで所属チームを選ぶとその人の担当に加わります。",
    );
    expect(currentContainer().textContent).toContain(
      "レビュワーの誰か待ちなど、待ち相手を特定できない項目が4件あります。",
    );
  });

  it("人の行から人ごとのページへ遷移し担当者一覧へ戻る", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people");
    renderApp(createPeoplePageSummary());
    const peopleNavigation = requiredElement<HTMLAnchorElement>(
      '.global-navigation a[href="/voicevox_task_tracker/people"]',
    );
    const hihoLink = requiredElement<HTMLAnchorElement>(
      '.people-table a[href="/voicevox_task_tracker/people/HiHo"]',
    );

    expect(peopleNavigation.getAttribute("aria-current")).toBe("page");
    act(() => {
      hihoLink.click();
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/people/HiHo");
    expect(requiredElement<HTMLHeadingElement>("#person-page-heading").textContent).toBe(
      "@HiHo を待っている項目",
    );
    expect(peopleNavigation.getAttribute("aria-current")).toBe("page");
    const backLink = requiredElement<HTMLAnchorElement>(".person-back-link");
    expect(backLink.getAttribute("href")).toBe("/voicevox_task_tracker/people");

    act(() => {
      backLink.click();
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/people");
    expect(currentContainer().querySelector(".people-table")).not.toBeNull();
  });

  it("待ち相手の行がないときは空であることを表示する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people");

    renderApp({
      ...sampleSummary,
      items: [],
    });

    expect(currentContainer().querySelector(".people-table")).toBeNull();
    expect(requiredElement<HTMLElement>(".people-page .empty-state").textContent).toBe(
      "現在、担当者を特定できる止まっている項目はありません。",
    );
    expect(currentContainer().textContent).not.toContain("待ち相手を特定できない項目");
  });

  it("廃止した項目一覧pathを未対応URLとして無視する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items");

    renderApp(sampleSummary);

    expect(currentContainer().querySelector(".items-table")).not.toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).not.toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
  });

  it("末尾スラッシュ付きの担当者一覧pathを警告なしで表示してURLを正規化する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/");

    renderApp(sampleSummary);

    expect(currentContainer().querySelector(".people-table")).not.toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/people");
  });

  it("末尾スラッシュ付きの項目詳細pathを警告なしで表示してURLを正規化する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103/");

    renderApp(sampleSummary);
    await flushUi();

    expect(
      currentContainer().querySelector('.item-details-card[data-node-id="sample-item-editor-103"]'),
    ).not.toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/items/sample-editor/103");
  });

  it("人ごとのページを描画してloginのURL表現を正規化する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/%68iho");

    const personSummary = createPersonPageSummary();
    const personItem = personSummary.items.find((item) => item.nodeId === "sample-item-editor-101");
    assertNonNullable(personItem, "担当者ページのAI推定表示テスト用項目がありません");
    const aiNotice = aiAnalysisNotice(personItem.aiAnalysis.status);
    if (aiNotice.kind !== "outdated") {
      throw new TypeError("担当者ページのAI推定が最新です");
    }
    renderApp(personSummary);

    expect(requiredElement<HTMLHeadingElement>("#person-page-heading").textContent).toBe(
      "@hiho を待っている項目",
    );
    const personHeading = requiredElement<HTMLHeadingElement>("#person-page-heading");
    const personAvatar = expectGitHubAvatar(personHeading, "hiho", 40, "size-10");
    expect(personAvatar.nextElementSibling?.textContent).toBe("@hiho を待っている項目");
    const githubProfileLink = [...currentContainer().querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "GitHubプロフィール",
    );
    assertNonNullable(githubProfileLink, "GitHubプロフィールへのリンクがありません");
    expect(githubProfileLink.getAttribute("href")).toBe("https://github.com/hiho");
    expect(githubProfileLink.getAttribute("target")).toBe("_blank");
    expect(githubProfileLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(githubProfileLink.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(currentContainer().querySelector(".person-page .eyebrow")).toBeNull();
    expect(
      [...currentContainer().querySelectorAll(".person-items-table thead th")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["項目", "待ち相手と状態", "要対応度↓", "重要度", "停滞時間"]);
    expect(itemRowNodeIds()).toEqual(["sample-item-editor-101"]);
    const itemCell = requiredElement<HTMLTableCellElement>(
      '.person-items-table tr[data-node-id="sample-item-editor-101"] th[scope="row"]',
    );
    expectItemListHeading(
      itemCell,
      "VOICEVOX/sample-editor#101・Pull Request",
      "https://github.com/VOICEVOX/sample-editor/pull/101",
    );
    expect(
      requiredElement<HTMLElement>(
        '.person-items-table tr[data-node-id="sample-item-editor-101"] .attention-cell',
      ).textContent,
    ).toBe("25点");
    expect(
      requiredElement<HTMLElement>(
        '.person-items-table tr[data-node-id="sample-item-editor-101"] .importance-cell',
      ).textContent,
    ).toBe("63点");
    const tableAiNoticeIcon = itemCell.querySelector<HTMLElement>(".ai-analysis-notice-icon");
    assertNonNullable(tableAiNoticeIcon, "担当者ページの表にAI推定の警告アイコンがありません");
    const directWaitingOn = requiredElement<HTMLElement>(
      '.person-items-table tr[data-node-id="sample-item-editor-101"] .item-waiting-on-status',
    );
    const directWaitingOnCandidates = [
      ...directWaitingOn.querySelectorAll<HTMLElement>(".item-waiting-on-candidate"),
    ];
    expect(
      directWaitingOnCandidates.map(
        (candidate) => candidate.querySelector(".item-waiting-on-candidate-label")?.textContent,
      ),
    ).toEqual(["レビュワー @HiHo", "レビュワー @aoirint"]);
    expect(
      directWaitingOnCandidates.map(
        (candidate) => candidate.querySelector(".item-waiting-reason")?.textContent,
      ),
    ).toEqual(["HiHoさんの確認を待っています", "aoirintさんの確認を待っています"]);
    expect(directWaitingOnCandidates[0]?.querySelector(".item-primary-waiting-on")).not.toBeNull();
    expect(directWaitingOnCandidates[1]?.querySelector(".item-primary-waiting-on")).toBeNull();
    expect(directWaitingOn.querySelector(".item-waiting-status")?.textContent).toBe("マージ待ち");
    expect(currentContainer().querySelector(".person-item-count")).toBeNull();
    const personControls = requiredElement<HTMLElement>(".person-page > .person-sort-controls");
    expect(requiredElement<HTMLElement>(".person-team-selection").nextElementSibling).toBe(
      personControls,
    );
    expect(personControls.classList).toContain("lg:hidden");
    expect(currentContainer().querySelector(".person-page .section-heading p")).toBeNull();
    expect(currentContainer().textContent).not.toContain(
      "所属チームを選ぶと、そのチーム宛の待ちも加わります。",
    );
    expect(
      requiredElement<HTMLAnchorElement>(
        '.person-items-table tr[data-node-id="sample-item-editor-101"] a',
      ).pathname,
    ).toBe("/voicevox_task_tracker/items/sample-editor/101");
    const itemCard = requiredElement<HTMLElement>(
      '.items-card-list li[data-node-id="sample-item-editor-101"]',
    );
    expectItemListHeading(
      itemCard,
      "VOICEVOX/sample-editor#101・Pull Request",
      "https://github.com/VOICEVOX/sample-editor/pull/101",
    );
    expect([...itemCard.querySelectorAll("dt")].map((heading) => heading.textContent)).toEqual([
      "待ち相手と状態",
      "要対応度",
      "重要度",
      "停滞時間",
    ]);
    expect(itemCard.querySelector(".item-primary-waiting-on")?.textContent).toBe(
      "レビュワー @HiHo",
    );
    expect(itemCard.querySelector(".item-waiting-reason")?.textContent).toBe(
      "HiHoさんの確認を待っています",
    );
    const personTableRegion = requiredElement<HTMLElement>(".person-page > .items-table-region");
    const personCardList = requiredElement<HTMLOListElement>(".person-page > .items-card-list");
    expect(personControls.nextElementSibling).toBe(personTableRegion);
    expect(personTableRegion.classList).toContain("lg:block");
    expect(personCardList.classList).toContain("lg:hidden");
    const cardAiNoticeIcon = itemCard.querySelector<HTMLElement>(".ai-analysis-notice-icon");
    assertNonNullable(cardAiNoticeIcon, "担当者ページのカードにAI推定の警告アイコンがありません");
    for (const icon of [tableAiNoticeIcon, cardAiNoticeIcon]) {
      expect(icon.title).toBe(aiNotice.description);
      expect(icon.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(icon.querySelector(".sr-only")?.textContent).toBe(aiNotice.description);
    }
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/people/hiho");
    expect(window.location.search).toBe("");
  });

  it("担当者ページの表とカードに古い観測値を表示する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/sample-bug-author");

    renderApp(sampleSummary);

    const staleRow = requiredElement<HTMLTableRowElement>(
      '.person-items-table tr[data-node-id="sample-item-core-305"]',
    );
    expect(staleRow.dataset["freshness"]).toBe("stale");
    expect(staleRow.textContent).toContain("古い観測値");
    expect(staleRow.textContent).toContain("VOICEVOX/sample-core#305・Pull Request");
    const staleCard = requiredElement<HTMLElement>(
      '.items-card-list li[data-node-id="sample-item-core-305"]',
    );
    expect(staleCard.dataset["freshness"]).toBe("stale");
    expect(staleCard.textContent).toContain("古い観測値");
  });

  it("担当者ページの表とカードで固定した列順に要対応度と重要度を表示する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");

    renderApp(createPersonPageSummaryWithLowImportance());

    const highTableRow = requiredElement<HTMLTableRowElement>(
      '.person-items-table tr[data-node-id="sample-item-editor-101"]',
    );
    const highTableAttentionBadge = requiredElement<HTMLElement>(
      '.person-items-table tr[data-node-id="sample-item-editor-101"] .attention-badge',
    );
    const highTableBadge = requiredElement<HTMLElement>(
      '.person-items-table tr[data-node-id="sample-item-editor-101"] .importance-badge',
    );
    expect(highTableRow.children[0]?.querySelector(".item-list-heading")).not.toBeNull();
    expect(highTableRow.children[1]?.querySelector(".item-waiting-on-status")).not.toBeNull();
    expect(highTableRow.children[2]?.firstElementChild).toBe(highTableAttentionBadge);
    expect(highTableRow.children[3]?.firstElementChild).toBe(highTableBadge);
    expect(highTableRow.children[4]?.textContent).toBe("12日");
    expect(highTableAttentionBadge.textContent).toBe("25点");
    expect(highTableAttentionBadge.classList).toContain("bg-importance-medium-background");
    expect(highTableBadge.textContent).toBe("63点");
    expect(highTableBadge.classList).toContain("bg-importance-high-background");
    expect(
      requiredElement<HTMLElement>(
        '.person-items-table tr[data-node-id="sample-item-engine-204"] .attention-badge',
      ).textContent,
    ).toBe("0点");
    expect(
      requiredElement<HTMLElement>(
        '.person-items-table tr[data-node-id="sample-item-engine-204"] .importance-badge',
      ).textContent,
    ).toBe("12点");

    const highCard = requiredElement<HTMLElement>(
      '.items-card-list li[data-node-id="sample-item-editor-101"]',
    );
    const highCardHeading = requiredElement<HTMLElement>(
      '.items-card-list li[data-node-id="sample-item-editor-101"] .item-card-heading',
    );
    const highCardSummary = requiredElement<HTMLElement>(
      '.items-card-list li[data-node-id="sample-item-editor-101"] .item-card-summary',
    );
    expect(highCardHeading.nextElementSibling).toBe(highCardSummary);
    expect([...highCard.querySelectorAll("dt")].map((heading) => heading.textContent)).toEqual([
      "待ち相手と状態",
      "要対応度",
      "重要度",
      "停滞時間",
    ]);
    expect(highCard.querySelector(".attention-badge")?.textContent).toBe("25点");
    expect(highCard.querySelector(".importance-badge")?.textContent).toBe("63点");
    expect(
      requiredElement<HTMLElement>(
        '.items-card-list li[data-node-id="sample-item-engine-204"] .importance-badge',
      ).textContent,
    ).toBe("12点");
    expect(highCard.querySelector(".item-score-badges")).toBeNull();
  });

  it("担当者ページの表ヘッダで並び替え、同じ列の再操作で方向を反転する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");
    renderApp(createPersonPageSummaryWithLowImportance());

    expect(itemRowNodeIds()).toEqual(["sample-item-editor-101", "sample-item-engine-204"]);
    expect(currentContainer().querySelectorAll(".person-items-table thead th button")).toHaveLength(
      3,
    );
    expect(
      requiredElement<HTMLTableCellElement>(
        ".person-items-table thead th:nth-child(2)",
      ).getAttribute("aria-sort"),
    ).toBeNull();
    expect(
      requiredElement<HTMLTableCellElement>(
        ".person-items-table thead th:nth-child(3)",
      ).getAttribute("aria-sort"),
    ).toBe("descending");
    expect(
      requiredElement<HTMLTableCellElement>(
        ".person-items-table thead th:first-child",
      ).querySelector("button"),
    ).toBeNull();
    expect(
      requiredElement<HTMLTableCellElement>(
        ".person-items-table thead th:nth-child(2)",
      ).querySelector("button"),
    ).toBeNull();

    act(() => {
      requiredElement<HTMLButtonElement>(
        ".person-items-table thead th:nth-child(5) button",
      ).click();
    });

    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204", "sample-item-editor-101"]);
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("stall");
    expect(new URL(window.location.href).searchParams.get("direction")).toBeNull();
    expect(
      requiredElement<HTMLTableCellElement>('.person-items-table thead th[aria-sort="descending"]')
        .textContent,
    ).toBe("停滞時間↓");

    act(() => {
      requiredElement<HTMLButtonElement>(
        ".person-items-table thead th:nth-child(5) button",
      ).click();
    });

    expect(itemRowNodeIds()).toEqual(["sample-item-editor-101", "sample-item-engine-204"]);
    expect(new URL(window.location.href).searchParams.get("direction")).toBe("ascending");
  });

  it("担当者ページの並び替え状態をURLへ反映して開き直したときに復元する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");
    const summary = createPersonPageSummaryWithLowImportance();
    renderApp(summary);
    const sortKey = requiredElement<HTMLSelectElement>("#person-sort-key");

    expect([...sortKey.options].map((option) => option.textContent)).toEqual([
      "要対応度",
      "重要度",
      "停滞時間",
    ]);
    expect([...sortKey.options].map((option) => option.value)).toEqual(ITEM_SORT_KEYS);
    expect(sortKey.value).toBe("attention");

    act(() => {
      sortKey.value = "importance";
      sortKey.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(itemRowNodeIds()).toEqual(["sample-item-editor-101", "sample-item-engine-204"]);
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("importance");
    expect(new URL(window.location.href).searchParams.get("direction")).toBeNull();

    act(() => {
      render(null, currentContainer());
    });
    renderApp(summary);

    expect(requiredElement<HTMLSelectElement>("#person-sort-key").value).toBe("importance");
    expect(
      requiredElement<HTMLButtonElement>(".person-sort-controls button").textContent,
    ).toContain("降順");
    expect(itemRowNodeIds()).toEqual(["sample-item-editor-101", "sample-item-engine-204"]);
  });

  it("担当者ページで所属チームと並び替え状態を同時に保つ", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMaintainers&sort=importance&direction=ascending",
    );
    renderApp(createPersonPageSummary());
    const maintainers = requiredElement<HTMLInputElement>(
      '.person-team-selection input[value="VOICEVOX/Maintainers"]',
    );

    expect(maintainers.checked).toBe(true);
    expect(requiredElement<HTMLSelectElement>("#person-sort-key").value).toBe("importance");
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");

    act(() => {
      requiredElement<HTMLButtonElement>(".person-sort-controls button").click();
    });

    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("importance");
    expect(new URL(window.location.href).searchParams.get("direction")).toBeNull();

    act(() => {
      maintainers.click();
    });

    expect(new URL(window.location.href).searchParams.get("teams")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("importance");
    expect(requiredElement<HTMLSelectElement>("#person-sort-key").value).toBe("importance");
  });

  it("担当者ページの古い並び替えキーを既定値へ戻す", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMaintainers&sort=status",
    );
    renderApp(createPersonPageSummary());

    expect(requiredElement<HTMLSelectElement>("#person-sort-key").value).toBe("attention");
    expect(
      requiredElement<HTMLButtonElement>(".person-sort-controls button").textContent,
    ).toContain("降順");
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-202", "sample-item-editor-101"]);
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
    expect(new URL(window.location.href).searchParams.get("sort")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("direction")).toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).not.toBeNull();
  });

  it.each([
    "/voicevox_task_tracker/people/-hiho",
    "/voicevox_task_tracker/people/hiho-",
    "/voicevox_task_tracker/people/hi--ho",
    `/voicevox_task_tracker/people/${"a".repeat(40)}`,
    "/voicevox_task_tracker/people/hi_ho",
    "/voicevox_task_tracker/people/hiho/extra",
  ])("不正なloginを含むpath %s を担当者一覧へ戻す", (path) => {
    window.history.replaceState({}, "", path);

    renderApp(createPersonPageSummary());

    expect(currentContainer().textContent).toContain("担当者一覧");
    expect(currentContainer().querySelector(".person-page")).toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).not.toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/people");
  });

  it("所属チームの選択を履歴を増やさずURLと対象項目へ反映する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");
    renderApp(createPersonPageSummary());
    const historyLength = window.history.length;

    expect(itemRowNodeIds()).toEqual(["sample-item-editor-101"]);
    const maintainers = requiredElement<HTMLInputElement>(
      '.person-team-selection input[value="VOICEVOX/Maintainers"]',
    );
    expect(requiredElement<HTMLElement>(".person-team-selection").textContent).not.toContain(
      "件の待ちがあります",
    );
    act(() => {
      maintainers.click();
    });

    expect(itemRowNodeIds()).toEqual(["sample-item-engine-202", "sample-item-editor-101"]);
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
    expect(window.history.length).toBe(historyLength);
    expect(currentContainer().querySelector(".person-item-count")).toBeNull();
    const teamWaitingOn = requiredElement<HTMLElement>(
      '.person-items-table tr[data-node-id="sample-item-engine-202"] .item-waiting-on-status',
    );
    expect(teamWaitingOn.querySelector(".item-primary-waiting-on")?.textContent).toBe(
      "レビュワー チーム VOICEVOX/Maintainers",
    );
    expect(teamWaitingOn.querySelector(".item-waiting-reason")?.textContent).toBe(
      "レビューチームへレビューが依頼されています",
    );
    const teamWaitingCard = requiredElement<HTMLElement>(
      '.items-card-list li[data-node-id="sample-item-engine-202"] .item-waiting-on-status',
    );
    expect(teamWaitingCard.querySelector(".item-primary-waiting-on")?.textContent).toBe(
      "レビュワー チーム VOICEVOX/Maintainers",
    );
    expect(teamWaitingCard.querySelector(".item-waiting-reason")?.textContent).toBe(
      "レビューチームへレビューが依頼されています",
    );
  });

  it("自分を記憶するとヘッダーから所属チーム付きの自分のページへ移動できる", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMaintainers",
    );
    renderApp(createPersonPageSummary());

    expect(currentContainer().querySelector(".viewer-navigation-link")).toBeNull();
    const rememberButton = requiredElement<HTMLButtonElement>(".person-identity-button");
    expect(rememberButton.disabled).toBe(false);
    expect(rememberButton.textContent).toBe("自分として記憶する");
    act(() => {
      rememberButton.click();
    });

    expect(window.localStorage.getItem(VIEWER_IDENTITY_STORAGE_KEY)).toBe(
      JSON.stringify({
        login: "hiho",
        teamIds: ["VOICEVOX/Maintainers"],
      }),
    );
    expect(requiredElement<HTMLButtonElement>(".person-identity-button").textContent).toBe(
      "自分の記憶を解除する",
    );
    expect(requiredElement<HTMLAnchorElement>(".viewer-navigation-link").getAttribute("href")).toBe(
      "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMaintainers",
    );
    expect(requiredElement<HTMLAnchorElement>(".viewer-navigation-link").textContent).toBe(
      "自分の担当 @hiho",
    );

    act(() => {
      requiredElement<HTMLAnchorElement>(
        '.global-navigation a[href="/voicevox_task_tracker/"]',
      ).click();
    });
    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
    act(() => {
      requiredElement<HTMLAnchorElement>(".viewer-navigation-link").click();
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/people/hiho");
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
  });

  it("公開データにないチームを記憶していても自分の担当のリンク先に含めない", () => {
    storeViewerIdentity("hiho", ["VOICEVOX/Missing", "voicevox/maintainers"]);

    renderApp(createPersonPageSummary());

    const viewerLink = requiredElement<HTMLAnchorElement>(".viewer-navigation-link");
    expect(viewerLink.getAttribute("href")).toBe(
      "/voicevox_task_tracker/people/hiho?teams=voicevox%2Fmaintainers",
    );
    act(() => {
      viewerLink.click();
    });
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("voicevox/maintainers");
  });

  it("自分の記憶を解除すると保存値とヘッダーリンクが消える", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");
    renderApp(createPersonPageSummary());

    act(() => {
      requiredElement<HTMLButtonElement>(".person-identity-button").click();
    });
    expect(currentContainer().querySelector(".viewer-navigation-link")).not.toBeNull();
    act(() => {
      requiredElement<HTMLButtonElement>(".person-identity-button").click();
    });

    expect(window.localStorage.getItem(VIEWER_IDENTITY_STORAGE_KEY)).toBeNull();
    expect(currentContainer().querySelector(".viewer-navigation-link")).toBeNull();
    expect(requiredElement<HTMLButtonElement>(".person-identity-button").textContent).toBe(
      "自分として記憶する",
    );
  });

  it.each([
    {
      description: "JSONとして壊れた値",
      storedValue: "{",
    },
    {
      description: "未対応のプロパティを含む値",
      storedValue: JSON.stringify({
        version: 1,
        login: "hiho",
        teamIds: [],
      }),
    },
  ])("$descriptionを破棄して警告し通常どおり描画する", ({ storedValue }) => {
    window.localStorage.setItem(VIEWER_IDENTITY_STORAGE_KEY, storedValue);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderApp(sampleSummary);

    expect(window.localStorage.getItem(VIEWER_IDENTITY_STORAGE_KEY)).toBeNull();
    expect(warning).toHaveBeenCalledWith(
      "保存されていた閲覧者情報が不正なため破棄しました。",
      expect.anything(),
    );
    expect(currentContainer().textContent).toContain("項目一覧");
    expect(currentContainer().querySelector(".viewer-navigation-link")).toBeNull();
  });

  it("記憶済みのアカウントで所属チームを変えるとURLを正として記憶を更新する", () => {
    storeViewerIdentity("hiho", ["VOICEVOX/Reviewers"]);
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");
    renderApp(createPersonPageSummary());

    expect(requiredElement<HTMLButtonElement>(".person-identity-button").textContent).toBe(
      "自分の記憶を解除する",
    );
    act(() => {
      requiredElement<HTMLInputElement>(
        '.person-team-selection input[value="VOICEVOX/Maintainers"]',
      ).click();
    });

    expect(window.localStorage.getItem(VIEWER_IDENTITY_STORAGE_KEY)).toBe(
      JSON.stringify({
        login: "hiho",
        teamIds: ["VOICEVOX/Maintainers"],
      }),
    );
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
    expect(requiredElement<HTMLAnchorElement>(".viewer-navigation-link").getAttribute("href")).toBe(
      "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMaintainers",
    );
  });

  it("localStorageへアクセスできないときは記憶機能だけを無効にする", () => {
    const failure = new DOMException("利用できません", "SecurityError");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw failure;
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/people/hiho");

    renderApp(createPersonPageSummary());

    const rememberButton = requiredElement<HTMLButtonElement>(".person-identity-button");
    expect(rememberButton.disabled).toBe(true);
    expect(rememberButton.getAttribute("aria-describedby")).toBe(
      "person-identity-unavailable-reason",
    );
    expect(requiredElement("#person-identity-unavailable-reason").textContent).toBe(
      "このブラウザーでは記憶を利用できません。",
    );
    expect(currentContainer().querySelector(".viewer-navigation-link")).toBeNull();
    expect(requiredElement<HTMLHeadingElement>("#person-page-heading").textContent).toBe(
      "@hiho を待っている項目",
    );
    act(() => {
      requiredElement<HTMLInputElement>(
        '.person-team-selection input[value="VOICEVOX/Maintainers"]',
      ).click();
    });
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
    expect(warning).toHaveBeenCalledWith(
      "localStorageへアクセスできないため、閲覧者情報の記憶機能を無効にしました。",
      failure,
    );
  });

  it("担当者一覧で自分の行を視覚表示と支援技術向けテキストで示す", () => {
    storeViewerIdentity("hiho", ["VOICEVOX/Maintainers"]);
    window.history.replaceState({}, "", "/voicevox_task_tracker/people");

    renderApp(createPeoplePageSummary());

    const viewerRow = requiredElement<HTMLTableRowElement>(".viewer-person-row");
    expect(viewerRow.querySelector("a")?.textContent).toBe("@HiHo");
    expect(viewerRow.querySelector('[aria-hidden="true"]')?.textContent).toBe("自分");
    expect(viewerRow.querySelector(".visually-hidden")?.textContent).toBe("自分のアカウントです");
    expect(currentContainer().querySelectorAll(".viewer-person-row")).toHaveLength(1);
    const viewerCard = requiredElement<HTMLElement>(".viewer-person-card");
    expect(viewerCard.querySelector("a")?.textContent).toBe("@HiHo");
    expect(viewerCard.querySelector('[aria-hidden="true"]')?.textContent).toBe("自分");
    expect(viewerCard.querySelector(".visually-hidden")?.textContent).toBe("自分のアカウントです");
    expect(currentContainer().querySelectorAll(".viewer-person-card")).toHaveLength(1);
  });

  it("summaryにないチームと空要素と重複を捨ててURL状態の注意を表示する", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMissing%2C%2CVOICEVOX%2FMaintainers%2Cvoicevox%2Fmaintainers",
    );

    renderApp(createPersonPageSummary());

    expect(itemRowNodeIds()).toEqual(["sample-item-engine-202", "sample-item-editor-101"]);
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
    expect(currentContainer().querySelector(".url-state-notice")).not.toBeNull();
  });

  it("末尾スラッシュ付きの人ページを警告なしで表示してURLを正規化する", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/people/hiho/?teams=VOICEVOX%2FMaintainers",
    );

    renderApp(createPersonPageSummary());

    expect(currentContainer().querySelector(".person-page")).not.toBeNull();
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-202", "sample-item-editor-101"]);
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/people/hiho");
    expect(new URL(window.location.href).searchParams.get("teams")).toBe("VOICEVOX/Maintainers");
  });

  it("スキップリンクのhashが付いたURLを補正対象にしない", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/#main-content");

    renderApp(sampleSummary);

    expect(currentContainer().querySelector(".items-table")).not.toBeNull();
    expect(currentContainer().querySelector(".url-state-notice")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
    expect(window.location.hash).toBe("#main-content");
  });

  it("popstateでpathnameと項目一覧queryを復元する", () => {
    renderApp(sampleSummary);
    window.history.pushState(
      {},
      "",
      "/voicevox_task_tracker/?repo=VOICEVOX%2Fsample-core&sort=stall&direction=descending",
    );

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
    expect(
      requiredElement<HTMLSelectElement>('select[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("VOICEVOX/sample-core");
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("stall");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
  });

  it("最新更新時刻のtitleへ公開DTOのtimezoneを反映する", () => {
    const newYorkFixture = createPublicSummaryDto({
      ...sampleSummary,
      timezone: "America/New_York",
    });

    renderApp(newYorkFixture);

    const observedTime = requiredElement<HTMLTimeElement>(
      `.site-observed-time time[datetime="${newYorkFixture.observedAt}"]`,
    );
    expect(observedTime.textContent).toBe("1日前");
    expect(observedTime.title).toBe("2026/07/30 20:00:00 GMT-4");
    expect(currentContainer().querySelector(".absolute-time")).toBeNull();
  });

  it("公開DTOのtimezoneを必須とする", () => {
    expect(() =>
      createPublicSummaryDto({
        ...sampleSummary,
        timezone: undefined,
      }),
    ).toThrow();
  });

  it("一覧の識別子、待ち相手、AI利用状況で絞り込み、3キーで並び替える", () => {
    const rows = createItemTableRows(sampleSummary, NOW);
    const filterCases: readonly Readonly<{
      key: TableFilterKey;
      value: string;
      expectedNodeIds: readonly string[];
    }>[] = [
      {
        key: "repository",
        value: "VOICEVOX/sample-core",
        expectedNodeIds: ["sample-item-core-305"],
      },
      {
        key: "type",
        value: "issue",
        expectedNodeIds: ["sample-item-editor-103", "sample-item-engine-204"],
      },
      {
        key: "status",
        value: "waiting_for_merge",
        expectedNodeIds: ["sample-item-editor-101"],
      },
      {
        key: "importance",
        value: "medium",
        expectedNodeIds: ["sample-item-engine-202"],
      },
      {
        key: "waitingOn",
        value: "レビュワー チーム sample-reviewers",
        expectedNodeIds: ["sample-item-engine-202"],
      },
      {
        key: "stall",
        value: "30d",
        expectedNodeIds: ["sample-item-engine-204"],
      },
      {
        key: "aiAnalysis",
        value: "outdated",
        expectedNodeIds: [
          "sample-item-engine-202",
          "sample-item-editor-103",
          "sample-item-editor-101",
          "sample-item-core-305",
        ],
      },
      {
        key: "aiAnalysis",
        value: "skipped",
        expectedNodeIds: ["sample-item-engine-204"],
      },
    ];

    for (const filterCase of filterCases) {
      const filtered = filterAndSortTableRows(rows, filtersWith(filterCase.key, filterCase.value), {
        key: "attention",
        direction: "descending",
      });
      expect(filtered.map((row) => row.item.nodeId)).toEqual(filterCase.expectedNodeIds);
    }

    const hiddenValueCases: readonly Readonly<{
      key: TableFilterKey;
      value: string;
    }>[] = [
      {
        key: "repository",
        value: "サンプル配布処理を実装する",
      },
      {
        key: "status",
        value: "マージ待ち",
      },
      {
        key: "importance",
        value: "39点",
      },
      {
        key: "waitingOn",
        value: "レビューチームへレビューが依頼されています",
      },
    ];
    for (const filterCase of hiddenValueCases) {
      const filtered = filterAndSortTableRows(rows, filtersWith(filterCase.key, filterCase.value), {
        key: "stall",
        direction: "descending",
      });
      expect(filtered).toEqual([]);
    }

    for (const key of ITEM_SORT_KEYS) {
      const ascending = filterAndSortTableRows(rows, createEmptyTableFilters(), {
        key,
        direction: "ascending",
      });
      const descending = filterAndSortTableRows(rows, createEmptyTableFilters(), {
        key,
        direction: "descending",
      });
      expect(ascending[0]?.item.nodeId).not.toBe(descending[0]?.item.nodeId);
    }

    const importanceAscending = filterAndSortTableRows(rows, createEmptyTableFilters(), {
      key: "importance",
      direction: "ascending",
    });
    const importanceDescending = filterAndSortTableRows(rows, createEmptyTableFilters(), {
      key: "importance",
      direction: "descending",
    });
    expect(importanceAscending.map((row) => row.item.importance.score)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 12, 39, 41, 44, 63,
    ]);
    expect(importanceDescending.map((row) => row.item.importance.score)).toEqual([
      63, 44, 41, 39, 12, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("一覧に要対応度を表示し、選択と入力で絞り込み並び替える", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);
    expect(requiredElement<HTMLTableCaptionElement>(".items-table caption").textContent).toBe(
      "追跡中の全項目の一覧",
    );
    expect(
      [...currentContainer().querySelectorAll(".items-table thead th")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["項目", "待ち相手と状態", "要対応度↓", "重要度", "停滞時間"]);
    expect(
      [...currentContainer().querySelectorAll(".items-card-list li:first-child dt")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["待ち相手と状態", "要対応度", "重要度", "停滞時間"]);
    const itemsControls = requiredElement<HTMLElement>(".item-workspace > .item-sort-controls");
    const itemsTableRegion = requiredElement<HTMLElement>(".item-workspace > .items-table-region");
    const itemsCardList = requiredElement<HTMLOListElement>(".item-workspace > .items-card-list");
    expect(requiredElement<HTMLElement>(".item-list-toolbar").nextElementSibling).toBe(
      itemsControls,
    );
    expect(itemsControls.nextElementSibling).toBe(itemsTableRegion);
    expect(itemsTableRegion.classList).toContain("lg:block");
    expect(itemsTableRegion.classList).not.toContain("md:block");
    expect(itemsCardList.classList).toContain("lg:hidden");
    expect(itemsCardList.classList).not.toContain("md:hidden");
    expect(itemsControls.classList).toContain("lg:hidden");
    expect(currentContainer().textContent).not.toContain(
      "列の値を選択します。待ち相手は入力した文字を含む項目を表示します。",
    );
    const itemsTable = requiredElement<HTMLTableElement>(".items-table");
    expect(itemsTable.classList).toContain("table-fixed");
    expect(
      [...itemsTable.querySelectorAll("colgroup col")].map((column) => column.className),
    ).toEqual(["w-[39%]", "w-[31%]", "w-[10.5%]", "w-[9%]", "w-[10.5%]"]);
    const itemCell = requiredElement<HTMLTableCellElement>(
      '.items-table tr[data-node-id="sample-item-editor-101"] th[scope="row"]',
    );
    const waitingOnStatusCell = itemCell.nextElementSibling;
    const attentionCell = requiredElement<HTMLTableCellElement>(
      '.items-table tr[data-node-id="sample-item-editor-101"] .attention-cell',
    );
    expect(attentionCell.textContent).toBe("25点");
    const highImportanceCell = requiredElement<HTMLTableCellElement>(
      '.items-table tr[data-node-id="sample-item-editor-101"] .importance-cell',
    );
    const highImportanceBadge = requiredElement<HTMLElement>(
      '.items-table tr[data-node-id="sample-item-editor-101"] .importance-badge',
    );
    expect(waitingOnStatusCell?.querySelector(".item-primary-waiting-on")?.textContent).toBe(
      "マージ判断者 @sample-maintainer",
    );
    expect(waitingOnStatusCell?.querySelector(".item-waiting-status")?.textContent).toBe(
      "マージ待ち",
    );
    const statusBadge = waitingOnStatusCell?.querySelector<HTMLElement>(".item-waiting-status");
    assertNonNullable(statusBadge, "一覧に状態のバッジがありません");
    expect([...statusBadge.classList]).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "bg-state-neutral-background",
        "text-state-neutral-text",
      ]),
    );
    expect(waitingOnStatusCell?.querySelector(".item-waiting-reason")?.textContent).toBe(
      "確認が完了し、sample-maintainerさんのマージ判断を待っています",
    );
    expect(waitingOnStatusCell?.nextElementSibling).toBe(attentionCell);
    expect(attentionCell.nextElementSibling).toBe(highImportanceCell);
    expect(highImportanceCell.textContent).toBe("63点");
    expect(highImportanceBadge.classList).toContain("border-importance-high-border");
    expect([...highImportanceBadge.classList]).toEqual(
      expect.arrayContaining(["font-mono", "tabular-nums"]),
    );
    const commonHeadingScopes = [
      itemCell,
      requiredElement<HTMLElement>('.items-card-list li[data-node-id="sample-item-editor-101"]'),
    ];
    for (const scope of commonHeadingScopes) {
      expectItemListHeading(
        scope,
        "VOICEVOX/sample-editor#101・Pull Request",
        "https://github.com/VOICEVOX/sample-editor/pull/101",
      );
    }
    expect(
      requiredElement<HTMLTableCellElement>(
        '.items-table tr[data-node-id="sample-item-engine-204"] .attention-cell',
      ).textContent,
    ).toBe("0点");
    expect(
      requiredElement<HTMLTableCellElement>(
        '.items-table tr[data-node-id="sample-item-engine-204"] .importance-cell',
      ).textContent,
    ).toBe("12点");
    const multipleWaitingOn = requiredElement<HTMLElement>(
      '.items-table tr[data-node-id="sample-item-engine-204"] .item-waiting-on-status',
    );
    const waitingOnCandidates = [
      ...multipleWaitingOn.querySelectorAll<HTMLElement>(".item-waiting-on-candidate"),
    ];
    expect(
      waitingOnCandidates.map(
        (candidate) => candidate.querySelector(".item-waiting-on-candidate-label")?.textContent,
      ),
    ).toEqual(["VOICEVOX/sample-editor#103", "推定: example/sample-distribution#42"]);
    expect(
      waitingOnCandidates.map(
        (candidate) => candidate.querySelector(".item-waiting-reason")?.textContent,
      ),
    ).toEqual(["配布方針の決定を待っています", "外部配布ツールの対応を待っています"]);
    expect(waitingOnCandidates[0]?.querySelector(".item-primary-waiting-on")).not.toBeNull();
    expect(waitingOnCandidates[1]?.querySelector(".item-primary-waiting-on")).toBeNull();
    expect(
      waitingOnCandidates.map((candidate) =>
        candidate.querySelector(".item-waiting-reason")?.classList.contains("line-clamp-2"),
      ),
    ).toEqual([true, true]);
    expect(
      waitingOnCandidates.map(
        (candidate) => candidate.querySelector<HTMLElement>(".item-waiting-reason")?.title,
      ),
    ).toEqual(["配布方針の決定を待っています", "外部配布ツールの対応を待っています"]);
    expect(multipleWaitingOn.querySelectorAll(".item-waiting-reason")).toHaveLength(2);
    expect(multipleWaitingOn.querySelector(".item-waiting-on-list")).not.toBeNull();
    expect(multipleWaitingOn.querySelector(".item-primary-waiting-on")?.textContent).toBe(
      "VOICEVOX/sample-editor#103",
    );
    expect(
      requiredElement<HTMLElement>(
        '.items-table tr[data-node-id="sample-item-engine-204"] .attention-badge',
      ).classList,
    ).toContain("bg-importance-low-background");
    expect(
      requiredElement<HTMLElement>(
        '.items-table tr[data-node-id="sample-item-engine-204"] .importance-badge',
      ).classList,
    ).toContain("bg-importance-low-background");
    expect(
      [...currentContainer().querySelectorAll(".items-table .importance-badge")].every(
        (badge) => badge.textContent?.endsWith("点") === true,
      ),
    ).toBe(true);
    expect(
      [...currentContainer().querySelectorAll(".items-card-list .importance-badge")].every(
        (badge) => badge.textContent?.endsWith("点") === true,
      ),
    ).toBe(true);
    expect(
      requiredElement<HTMLElement>(
        '.items-card-list li[data-node-id="sample-item-engine-204"] .importance-badge',
      ).textContent,
    ).toBe("12点");
    expect(
      requiredElement<HTMLElement>(
        '.items-card-list li[data-node-id="sample-item-engine-204"] .attention-badge',
      ).textContent,
    ).toBe("0点");
    const filterDetails = requiredElement<HTMLDetailsElement>(".item-list-toolbar");
    expect(filterDetails.tagName).toBe("DETAILS");
    expect(filterDetails.open).toBe(false);
    expect(filterDetails.querySelector("details")).toBeNull();
    expect(filterDetails.querySelectorAll("select")).toHaveLength(6);
    expect(filterDetails.querySelectorAll('input[type="search"]')).toHaveLength(2);
    expect(filterDetails.querySelector("#item-search-heading")).toBeNull();
    expect(requiredElement<HTMLElement>(".item-list-toolbar > summary").textContent).toContain(
      "検索と絞り込み",
    );
    expect(requiredElement<HTMLElement>(".filter-summary-count").textContent).toBe("条件なし");
    act(() => {
      requiredElement<HTMLElement>(".item-list-toolbar > summary").click();
    });
    expect(filterDetails.open).toBe(true);
    const repositoryFilter = requiredElement<HTMLSelectElement>(
      'select[aria-label="リポジトリで絞り込み"]',
    );
    expect([...repositoryFilter.options].map((option) => option.textContent)).toEqual([
      "すべて",
      "VOICEVOX/sample-core",
      "VOICEVOX/sample-editor",
      "VOICEVOX/sample-engine",
      "example/sample-workflow",
    ]);
    expect([...repositoryFilter.options].map((option) => option.value)).toEqual([
      "",
      "VOICEVOX/sample-core",
      "VOICEVOX/sample-editor",
      "VOICEVOX/sample-engine",
      "example/sample-workflow",
    ]);
    const typeFilter = requiredElement<HTMLSelectElement>('select[aria-label="種別で絞り込み"]');
    expect([...typeFilter.options].map((option) => option.textContent)).toEqual([
      "すべて",
      "Issue",
      "Pull Request",
    ]);
    expect([...typeFilter.options].map((option) => option.value)).toEqual([
      "",
      "issue",
      "pull_request",
    ]);
    const statusFilter = requiredElement<HTMLSelectElement>('select[aria-label="状態で絞り込み"]');
    expect([...statusFilter.options].map((option) => option.textContent)).toEqual([
      "すべて",
      "内容確認待ち",
      "担当決め待ち",
      "方針判断待ち",
      "レビュー待ち",
      "修正待ち",
      "返答待ち",
      "作業待ち",
      "ブロック解消待ち",
      "自動処理待ち",
      "マージ待ち",
      "作業中",
      "待ち先不明",
    ]);
    expect([...statusFilter.options].map((option) => option.value)).toEqual([
      "",
      "waiting_for_assessment",
      "waiting_for_owner",
      "waiting_for_decision",
      "waiting_for_review",
      "waiting_for_revision",
      "waiting_for_reply",
      "waiting_for_work",
      "waiting_for_unblock",
      "waiting_for_automation",
      "waiting_for_merge",
      "in_progress",
      "unknown",
    ]);
    const importanceFilter = requiredElement<HTMLSelectElement>(
      'select[aria-label="重要度で絞り込み"]',
    );
    expect([...importanceFilter.options].map((option) => option.textContent)).toEqual([
      "すべて",
      "低",
      "中",
      "高",
    ]);
    expect([...importanceFilter.options].map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
    ]);
    const stallFilter = requiredElement<HTMLSelectElement>(
      'select[aria-label="停滞時間で絞り込み"]',
    );
    expect([...stallFilter.options].map((option) => option.textContent)).toEqual([
      "すべて",
      "1日以上",
      "3日以上",
      "7日以上",
      "30日以上",
    ]);
    expect([...stallFilter.options].map((option) => option.value)).toEqual([
      "",
      "1d",
      "3d",
      "7d",
      "30d",
    ]);
    const aiAnalysisFilter = requiredElement<HTMLSelectElement>(
      'select[aria-label="AI利用状況で絞り込み"]',
    );
    expect([...aiAnalysisFilter.options].map((option) => option.textContent)).toEqual([
      "すべて",
      "AI推定が最新でない",
      "AI推定を省略",
    ]);
    expect([...aiAnalysisFilter.options].map((option) => option.value)).toEqual([
      "",
      "outdated",
      "skipped",
    ]);

    act(() => {
      repositoryFilter.value = "VOICEVOX/sample-core";
      repositoryFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(itemRowNodeIds()).toEqual(["sample-item-core-305"]);
    expect(filterDetails.open).toBe(true);
    expect(requiredElement<HTMLElement>(".filter-summary-count").textContent).toBe("1件適用中");

    act(() => {
      requiredElement<HTMLElement>(".item-list-toolbar > summary").click();
    });
    expect(filterDetails.open).toBe(false);

    act(() => {
      repositoryFilter.value = "";
      repositoryFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(filterDetails.open).toBe(false);
    expect(requiredElement<HTMLElement>(".filter-summary-count").textContent).toBe("条件なし");
    act(() => {
      aiAnalysisFilter.value = "outdated";
      aiAnalysisFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(filterDetails.open).toBe(false);
    expect(requiredElement<HTMLElement>(".filter-summary-count").textContent).toBe("1件適用中");
    expect(itemRowNodeIds()).toEqual([
      "sample-item-engine-202",
      "sample-item-editor-103",
      "sample-item-editor-101",
      "sample-item-core-305",
    ]);
    expect(new URL(window.location.href).searchParams.get("ai")).toBe("outdated");
    act(() => {
      aiAnalysisFilter.value = "skipped";
      aiAnalysisFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);
    expect(new URL(window.location.href).searchParams.get("ai")).toBe("skipped");
    act(() => {
      aiAnalysisFilter.value = "";
      aiAnalysisFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const sortKey = requiredElement<HTMLSelectElement>("#item-sort-key");
    expect([...sortKey.options].map((option) => option.textContent)).toEqual([
      "要対応度",
      "重要度",
      "停滞時間",
    ]);
    expect([...sortKey.options].map((option) => option.value)).toEqual(ITEM_SORT_KEYS);
    expect(sortKey.value).toBe("attention");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    expect(itemRowNodeIds()).toEqual([
      "sample-item-engine-202",
      "sample-item-editor-103",
      "sample-item-editor-101",
      "sample-item-core-305",
      "sample-item-engine-204",
      "sample-item-workflow-401",
      "sample-item-workflow-402",
      "sample-item-workflow-403",
      "sample-item-workflow-404",
      "sample-item-workflow-405",
      "sample-item-workflow-406",
      "sample-item-workflow-407",
    ]);

    act(() => {
      sortKey.value = "importance";
      sortKey.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(itemRowNodeIds()[0]).toBe("sample-item-editor-101");
    expect(new URL(window.location.href).searchParams.get("sort")).toBe("importance");
    expect(
      requiredElement<HTMLTableCellElement>('.items-table thead th[aria-sort="descending"]')
        .textContent,
    ).toBe("重要度↓");

    const directionButton = requiredElement<HTMLButtonElement>(".item-sort-controls button");
    act(() => {
      directionButton.click();
    });
    expect(itemRowNodeIds()[0]).toBe("sample-item-workflow-401");
    expect(new URL(window.location.href).searchParams.get("direction")).toBe("ascending");
    expect(requiredElement<HTMLAnchorElement>('.items-table tbody a[target="_blank"]').rel).toBe(
      "noopener noreferrer",
    );
  });

  it("別のキーへ切り替えると3キーとも降順で始まり、同じキーで反転する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);
    const sortKey = requiredElement<HTMLSelectElement>("#item-sort-key");

    act(() => {
      sortKey.value = "importance";
      sortKey.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      requiredElement<HTMLTableCellElement>('.items-table thead th[aria-sort="descending"]')
        .textContent,
    ).toBe("重要度↓");

    act(() => {
      sortKey.value = "stall";
      sortKey.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(
      requiredElement<HTMLTableCellElement>('.items-table thead th[aria-sort="descending"]')
        .textContent,
    ).toBe("停滞時間↓");

    act(() => {
      requiredElement<HTMLButtonElement>(".items-table thead th:nth-child(5) button").click();
    });

    expect(
      requiredElement<HTMLTableCellElement>('.items-table thead th[aria-sort="ascending"]')
        .textContent,
    ).toBe("停滞時間↑");
  });

  it("項目一覧の表ヘッダで並び替え、同じ列の再操作で方向を反転する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);

    expect(
      currentContainer().querySelectorAll('.items-table thead th[aria-sort="descending"]'),
    ).toHaveLength(1);
    expect(
      currentContainer().querySelectorAll('.items-table thead th[aria-sort="none"]'),
    ).toHaveLength(2);

    act(() => {
      requiredElement<HTMLButtonElement>(".items-table thead th:nth-child(4) button").click();
    });

    expect(itemRowNodeIds()).toEqual([
      "sample-item-editor-101",
      "sample-item-core-305",
      "sample-item-editor-103",
      "sample-item-engine-202",
      "sample-item-engine-204",
      "sample-item-workflow-401",
      "sample-item-workflow-402",
      "sample-item-workflow-403",
      "sample-item-workflow-404",
      "sample-item-workflow-405",
      "sample-item-workflow-406",
      "sample-item-workflow-407",
    ]);
    expect(
      requiredElement<HTMLTableCellElement>('.items-table thead th[aria-sort="descending"]')
        .textContent,
    ).toBe("重要度↓");
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("importance");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    expect(
      currentContainer().querySelectorAll(
        '.items-table thead th[aria-sort="ascending"], .items-table thead th[aria-sort="descending"]',
      ),
    ).toHaveLength(1);
    expect(
      currentContainer().querySelectorAll('.items-table thead th[aria-sort="none"]'),
    ).toHaveLength(2);

    act(() => {
      requiredElement<HTMLButtonElement>(".items-table thead th:nth-child(4) button").click();
    });

    expect(itemRowNodeIds()).toEqual([
      "sample-item-workflow-401",
      "sample-item-workflow-402",
      "sample-item-workflow-403",
      "sample-item-workflow-404",
      "sample-item-workflow-405",
      "sample-item-workflow-406",
      "sample-item-workflow-407",
      "sample-item-engine-204",
      "sample-item-engine-202",
      "sample-item-editor-103",
      "sample-item-core-305",
      "sample-item-editor-101",
    ]);
    expect(
      requiredElement<HTMLTableCellElement>('.items-table thead th[aria-sort="ascending"]')
        .textContent,
    ).toBe("重要度↑");
    expect(
      currentContainer().querySelectorAll(
        '.items-table thead th[aria-sort="ascending"], .items-table thead th[aria-sort="descending"]',
      ),
    ).toHaveLength(1);
    expect(
      currentContainer().querySelectorAll('.items-table thead th[aria-sort="none"]'),
    ).toHaveLength(2);
  });

  it("項目一覧の項目列ヘッダは並び替え操作を持たない", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);

    const itemHeader = requiredElement<HTMLTableCellElement>(".items-table thead th:first-child");
    expect(itemHeader.textContent).toBe("項目");
    expect(itemHeader.querySelector("button")).toBeNull();
    expect(itemHeader.getAttribute("aria-sort")).toBeNull();
    expect(currentContainer().querySelectorAll(".items-table thead th button")).toHaveLength(3);
  });

  it("GitHub由来のHTMLを文字列として描画し危険URLを遷移不能にする", () => {
    const xssTitle = '<img src="x" onerror="globalThis.__xssExecuted = true">';
    const xssSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              title: xssTitle,
            }
          : item,
      ),
    });
    renderApp(xssSummary);

    expect(currentContainer().querySelector('img[src="x"]')).toBeNull();
    const renderedImages = currentContainer().querySelectorAll<HTMLImageElement>("img");
    expect(renderedImages.length).toBeGreaterThan(0);
    for (const image of renderedImages) {
      expect(image.getAttribute("src")?.startsWith("https://github.com/")).toBe(true);
      expect(image.getAttribute("onerror")).toBeNull();
    }
    expect(currentContainer().textContent).toContain(xssTitle);

    const dangerousUrlSource = {
      ...sampleSummary,
      items: sampleSummary.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              url: "javascript:alert(1)",
            }
          : item,
      ),
    };
    expect(() => createPublicSummaryDto(dangerousUrlSource)).toThrow();

    act(() => {
      render(
        <SafeGitHubLink href="https://example.com/VOICEVOX/sample" variant="inline">
          危険リンク
        </SafeGitHubLink>,
        currentContainer(),
      );
    });
    expect(currentContainer().querySelector('a[href^="https://example.com"]')).toBeNull();
    expect(currentContainer().textContent).toContain("安全でないリンクを無効化しました");
  });

  it("古い観測値の項目を一覧に表示する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);
    const staleItem = requiredElement<HTMLTableRowElement>(
      '.items-table tr[data-node-id="sample-item-core-305"]',
    );
    expect(staleItem.dataset["freshness"]).toBe("stale");
    expect(staleItem.textContent).toContain("古い観測値");
    expect(staleItem.textContent).toContain("推定: 作成者 @sample-bug-author");
  });

  it("AI推定が最新でない項目だけ表とカードに警告アイコンを表示する", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);

    for (const nodeId of [
      "sample-item-editor-101",
      "sample-item-engine-202",
      "sample-item-editor-103",
      "sample-item-core-305",
    ]) {
      const item = sampleSummary.items.find((candidate) => candidate.nodeId === nodeId);
      assertNonNullable(item, `AI推定の表示テスト用項目 ${nodeId} がありません`);
      const notice = aiAnalysisNotice(item.aiAnalysis.status);
      if (notice.kind !== "outdated") {
        throw new TypeError(`項目 ${nodeId} のAI推定が最新です`);
      }
      const tableIcon = requiredElement<HTMLElement>(
        `.items-table tr[data-node-id="${nodeId}"] .ai-analysis-notice-icon`,
      );
      const cardIcon = requiredElement<HTMLElement>(
        `.items-card-list li[data-node-id="${nodeId}"] .ai-analysis-notice-icon`,
      );
      for (const icon of [tableIcon, cardIcon]) {
        expect(icon.title).toBe(notice.description);
        expect(icon.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(icon.querySelector(".sr-only")?.textContent).toBe(notice.description);
      }
    }
    expect(
      requiredElement<HTMLElement>(
        '.items-table tr[data-node-id="sample-item-engine-204"]',
      ).querySelector(".ai-analysis-notice-icon"),
    ).toBeNull();
    expect(
      requiredElement<HTMLElement>(
        '.items-card-list li[data-node-id="sample-item-engine-204"]',
      ).querySelector(".ai-analysis-notice-icon"),
    ).toBeNull();
  });

  it("表示対象が0件なら一覧とページ送りを描画しない", () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp({
      ...sampleSummary,
      items: [],
    });

    expect(currentContainer().querySelector(".items-table")).toBeNull();
    expect(currentContainer().querySelector(".items-card-list")).toBeNull();
    expect(
      currentContainer().querySelector('.pagination[aria-label="一覧のページ送り"]'),
    ).toBeNull();
    expect(requiredElement<HTMLElement>(".item-workspace .empty-state").textContent).toBe(
      "条件に一致する項目はありません。",
    );
  });

  it("AI推定が最新でない状態以外では一覧アイコンを表示しない", () => {
    const statuses: readonly PublicItemSummaryDto["aiAnalysis"]["status"][] = [
      "used",
      "not_required",
      "disabled",
      "not_recorded",
      "used",
      "not_required",
      "disabled",
      "not_recorded",
      "used",
      "not_required",
      "disabled",
      "not_recorded",
    ];
    const summary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item, index) => {
        const status = statuses[index];
        assertNonNullable(status, "AI利用状況のテスト値がありません");
        return {
          ...item,
          aiAnalysis: {
            status,
          },
        };
      }),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/");

    renderApp(summary);

    expect(currentContainer().querySelector(".ai-analysis-notice-icon")).toBeNull();
  });

  it.each([
    [
      "failed",
      "/voicevox_task_tracker/items/sample-editor/101",
      "AI推定に失敗したため、状態、待ち相手、重要度、停滞に最新のAI推定を反映できていません。",
    ],
    [
      "deferred",
      "/voicevox_task_tracker/items/sample-engine/202",
      "AI推定を今回実行しなかったため、状態、待ち相手、重要度、停滞に最新のAI推定を反映できていません。",
    ],
  ])("AI利用状況が%sの項目詳細に最新でない旨を警告表示する", async (_status, path, description) => {
    window.history.replaceState({}, "", path);
    renderApp(sampleSummary);
    await flushUi();

    const notice = requiredElement<HTMLElement>(".ai-analysis-notice-outdated");
    expect(notice.textContent).toBe(description);
    expect(notice.classList).toContain("bg-state-warning-background");
    expect(currentContainer().querySelector(".ai-analysis-notice-skipped")).toBeNull();
  });

  it("AI推定を省いた項目詳細に警告ではない情報を表示する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderApp(sampleSummary);
    await flushUi();

    const notice = requiredElement<HTMLElement>(".ai-analysis-notice-skipped");
    expect(notice.textContent).toBe("確定ルールだけで判定できたため、AI推定を省いています。");
    expect(notice.classList).toContain("bg-state-info-background");
    expect(currentContainer().querySelector(".ai-analysis-notice-outdated")).toBeNull();
  });

  it("選択項目の状況と次の行動を先に表示して詳細を2つの折りたたみにまとめる", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderApp(sampleSummary);
    await flushUi();

    const details = requiredElement<HTMLElement>(
      '.item-details-card[data-node-id="sample-item-engine-204"]',
    );
    expect(details.querySelector(".ai-analysis-notice-skipped")).not.toBeNull();
    expect(currentContainer().querySelector(".eyebrow")).toBeNull();
    expect(currentContainer().textContent).not.toContain(
      "公開済みデータだけを使い、項目の判定根拠と変更履歴まで確認できます。",
    );
    expect(
      requiredElement<HTMLAnchorElement>(
        '.global-navigation a[href="/voicevox_task_tracker/"]',
      ).getAttribute("aria-current"),
    ).toBe("page");
    expect(details.textContent).toContain("GitHubで開く");
    const currentAction = requiredElement<HTMLElement>(".current-action-panel");
    expect(currentAction.textContent).toContain("現在の状態");
    expect(currentAction.textContent).toContain("ブロック解消待ち");
    expect(currentAction.textContent).toContain("待ち相手");
    expect(currentAction.textContent).toContain("VOICEVOX/sample-editor#103");
    expect(currentAction.textContent).toContain("次の行動");
    expect(currentAction.textContent).toContain("31日");
    expect(currentAction.textContent).toContain("低");
    expect(currentAction.textContent).toContain("12点");
    expect(currentAction.textContent).not.toContain("レビュー");
    expect(currentAction.textContent).not.toContain("チェック");
    expect([...currentAction.querySelectorAll("h5")].map((heading) => heading.textContent)).toEqual(
      ["待ち相手", "次の行動"],
    );
    expect(currentAction.querySelectorAll(".waiting-on-list > li")).toHaveLength(2);
    expect(
      [...currentAction.querySelectorAll(".waiting-on-list > li strong")].map(
        (label) => label.textContent,
      ),
    ).toEqual([
      "VOICEVOX/sample-editor#103 サンプル配布方針を決める",
      "example/sample-distribution#42 配布ツールの新形式へ対応する",
    ]);
    expect(
      [...currentAction.querySelectorAll(".waiting-on-confidence")].map(
        (confidence) => confidence.textContent,
      ),
    ).toEqual(["確度区分: 確定", "確度区分: 確度の高い推定"]);
    expect(currentAction.querySelectorAll(".primary-blocker-badge")).toHaveLength(1);
    expect(currentAction.querySelector(".other-waiting-on-candidates")).toBeNull();
    expect(currentAction.querySelector(".blocker-list")).toBeNull();
    expect(currentAction.textContent?.match(/VOICEVOX\/sample-editor#103/gu)).toHaveLength(1);

    const disclosures = [...details.querySelectorAll<HTMLDetailsElement>(".detail-disclosure")];
    expect(disclosures).toHaveLength(2);
    expect(disclosures.every((disclosure) => !disclosure.open)).toBe(true);
    expect(
      disclosures.map((disclosure) => disclosure.querySelector("summary h4 > span")?.textContent),
    ).toEqual(["判定の根拠", "履歴"]);
    expect(
      [...details.querySelectorAll("h3, h4")].map(
        (heading) => heading.querySelector("span:first-child")?.textContent ?? heading.textContent,
      ),
    ).toEqual([
      "サンプル配布処理を実装する",
      "現在の状況と次の行動",
      "依存関係",
      "判定の根拠",
      "履歴",
    ]);
    expect(
      [...details.querySelectorAll("h3, h4")].every((heading) =>
        heading.classList.contains("font-display"),
      ),
    ).toBe(true);
    const currentStatus = requiredElement<HTMLElement>(".current-status-badge");
    expect([...currentStatus.classList]).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "bg-state-neutral-background",
        "text-state-neutral-text",
      ]),
    );
    expect(currentStatus.textContent).toBe("ブロック解消待ち");
    expect(requiredElement<HTMLDetailsElement>(".decision-details").open).toBe(false);
    expect(requiredElement<HTMLDetailsElement>(".history-details").open).toBe(false);
    expect(details.textContent).not.toContain("各種時刻");
    expect(details.textContent).not.toContain("作成時刻");
    expect(details.textContent).not.toContain("GitHubの更新時刻");
    expect(details.textContent).not.toContain("停滞開始時刻");
    expect(details.textContent).not.toContain("補足情報");
    expect(details.textContent).not.toContain("GitHub上の状態");
    expect(details.textContent).not.toContain("assignee");
    expect([...details.querySelectorAll("dt")].map((term) => term.textContent)).not.toContain(
      "ラベル",
    );
    expect(details.textContent).toContain("複数blockerから影響度が最も高い項目を選びました");
    expect(details.textContent).toContain("VOICEVOX/sample-editor#103");
    expect(details.textContent).toContain("example/sample-distribution#42");
    expect(details.textContent).toContain("判定の根拠");
    expect(details.textContent).toContain("GitHub上の根拠を開く");
    const decisionDetails = requiredElement<HTMLDetailsElement>(".decision-details");
    expect(
      [...decisionDetails.querySelectorAll("summary h4 > span")].map((part) => part.textContent),
    ).toEqual(["判定の根拠", "確度、重要度の加点、状態と行動の根拠"]);
    expect(
      [...decisionDetails.querySelectorAll(".detail-disclosure-content h5")].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["主要ブロッカーの選定理由", "重要度の加点内訳", "状態と次の行動の根拠"]);
    expect(decisionDetails.querySelector(".decision-candidate-list")).toBeNull();
    expect(decisionDetails.textContent).not.toContain("VOICEVOX/sample-editor#103");
    expect(decisionDetails.textContent).not.toContain("example/sample-distribution#42");
    expect(decisionDetails.textContent).toContain("判定: 確定");
    expect(decisionDetails.textContent).not.toContain("confidence");
    expect(decisionDetails.textContent).not.toContain("candidate ID");
    expect(decisionDetails.textContent).not.toContain("source ID");
    const evidenceItem = requiredElement<HTMLElement>(".evidence-list li");
    expect(evidenceItem.querySelector("code")).toBeNull();
    expect(evidenceItem.querySelector("span")).toBeNull();
    const historyDetails = requiredElement<HTMLDetailsElement>(".history-details");
    expect(historyDetails.querySelector("summary h4 > span")?.textContent).toBe("履歴");
    expect(historyDetails.querySelectorAll(".history-event")).toHaveLength(1);
    expect(historyDetails.querySelector(".history-event h5")?.textContent).toBe(
      "状態と待ち相手の変更",
    );
    expect(historyDetails.textContent).not.toContain("前回との差分");
    expect(historyDetails.textContent).not.toContain("Run ");
    expect(historyDetails.textContent).toContain("作業中・当時の担当者");
    expect(historyDetails.textContent).not.toContain("担当者 @sample-implementer");
    expect(historyDetails.textContent).toContain(
      "ブロック解消待ち・VOICEVOX/sample-editor#103、example/sample-distribution#42",
    );
    expect(historyDetails.textContent).not.toContain("severity");
    expect(historyDetails.querySelector(".history-expand-button")).toBeNull();
    expect(details.textContent).not.toContain("最終human activity");
    expect(details.textContent).not.toContain("最終進捗");
    expect(details.textContent).not.toContain("現在statusの開始");
    expect(details.textContent).not.toContain("現在waitingOnの開始");
    expect(details.textContent).not.toContain("項目観測");
    expect(details.querySelector<HTMLAnchorElement>(".evidence-list a")?.rel).toBe(
      "noopener noreferrer",
    );
    expect(document.activeElement?.textContent).toBe("サンプル配布処理を実装する");
  });

  it("Pull Requestだけ現在の状況にレビューとチェックを表示する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/101");
    renderApp(sampleSummary);
    await flushUi();

    const currentState = requiredElement<HTMLElement>(".current-state-grid");
    const reviewState = [...currentState.querySelectorAll(":scope > div")].find(
      (field) => field.querySelector("dt")?.textContent === "レビュー",
    );
    const checkState = [...currentState.querySelectorAll(":scope > div")].find(
      (field) => field.querySelector("dt")?.textContent === "チェック",
    );
    assertNonNullable(reviewState, "レビュー状態の表示がありません");
    assertNonNullable(checkState, "チェック状態の表示がありません");
    expect(reviewState.querySelector("dd")?.textContent).toBe("承認済み");
    expect(checkState.querySelector("dd")?.textContent).toBe("成功");
  });

  it("項目詳細の個人loginから人ごとのページへ遷移する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-core/305");
    renderApp(sampleSummary);
    await flushUi();

    const personLink = requiredElement<HTMLAnchorElement>(".current-responsibility .person-link");
    expect(personLink.textContent).toBe("@sample-bug-author");
    expect(personLink.getAttribute("href")).toBe("/voicevox_task_tracker/people/sample-bug-author");
    expect(personLink.parentElement?.textContent).toBe("作成者 @sample-bug-author");

    act(() => {
      personLink.click();
    });

    expect(window.location.pathname).toBe("/voicevox_task_tracker/people/sample-bug-author");
    expect(requiredElement<HTMLHeadingElement>("#person-page-heading").textContent).toBe(
      "@sample-bug-author を待っている項目",
    );
  });

  it("項目詳細の待ち相手がチームならリンクにしない", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/202");
    renderApp(sampleSummary);
    await flushUi();

    const waitingOn = requiredElement<HTMLElement>(
      ".current-responsibility .waiting-on-list > li strong",
    );
    expect(waitingOn.textContent).toBe("レビュワー チーム sample-reviewers");
    expect(waitingOn.querySelector("a")).toBeNull();
  });

  it("待ち相手が4件以上なら主候補以外を折りたたみ、primaryがなければ先頭を主候補にする", async () => {
    const targetNodeId = "sample-item-editor-103";
    const sourceItem = sampleSummary.items.find((item) => item.nodeId === targetNodeId);
    assertNonNullable(sourceItem, "候補折りたたみテスト用の項目がありません");
    const sourceWaitingOn = sourceItem.waitingOn[0];
    assertNonNullable(sourceWaitingOn, "候補折りたたみテスト用のwaitingOnがありません");
    const candidateIds = ["candidate-one", "candidate-two", "candidate-three"];
    const configuredSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item) =>
        item.nodeId === targetNodeId
          ? {
              ...item,
              waitingOn: [
                sourceWaitingOn,
                ...candidateIds.map((candidateId) => ({
                  ...sourceWaitingOn,
                  kind: "user",
                  candidateId,
                  reasonSummary: `${candidateId}の判断を待っています`,
                })),
              ],
              primaryWaitingOn: {
                index: "not_applicable",
                selectionReason: "primary waitingOnはありません",
              },
            }
          : item,
      ),
    });
    const configuredItem = configuredSummary.items.find((item) => item.nodeId === targetNodeId);
    assertNonNullable(configuredItem, "候補折りたたみテスト用の変更後項目がありません");
    const configuredDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === targetNodeId
          ? {
              ...details,
              summary: configuredItem,
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103");
    renderAppWithDetails(configuredSummary, configuredDetails);
    await flushUi();

    const primaryCandidates = requiredElement<HTMLUListElement>(".primary-waiting-on-list");
    expect(primaryCandidates.querySelectorAll(":scope > li")).toHaveLength(1);
    expect(primaryCandidates.textContent).toContain(sourceWaitingOn.reasonSummary);
    expect(primaryCandidates.querySelectorAll(".waiting-on-confidence")).toHaveLength(1);
    const otherCandidates = requiredElement<HTMLDetailsElement>(".other-waiting-on-candidates");
    expect(otherCandidates.open).toBe(false);
    expect(otherCandidates.querySelector("summary")?.textContent).toBe("その他の候補3件を表示");
    expect(otherCandidates.querySelectorAll(".waiting-on-list > li")).toHaveLength(3);
    act(() => {
      otherCandidates.querySelector("summary")?.click();
    });
    expect(otherCandidates.open).toBe(true);
  });

  it("履歴を新しい順の5件まで表示し、残りがあれば全件へ展開する", async () => {
    const targetNodeId = "sample-item-engine-204";
    const sourceDetails = sampleDetails.items.find(
      (details) => details.summary.nodeId === targetNodeId,
    );
    assertNonNullable(sourceDetails, "履歴展開テスト用の項目詳細がありません");
    const sourceHistory = sourceDetails.history[0];
    assertNonNullable(sourceHistory, "履歴展開テスト用の履歴がありません");
    const history = Array.from({ length: 7 }, (_, index) => ({
      ...sourceHistory,
      recordedAt: new Date(Date.UTC(2026, 6, 25 + index, 0, 5)).toISOString(),
    }));
    const configuredDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === targetNodeId
          ? {
              ...details,
              history,
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderAppWithDetails(sampleSummary, configuredDetails);
    await flushUi();

    const historyDetails = requiredElement<HTMLDetailsElement>(".history-details");
    act(() => {
      historyDetails.open = true;
    });
    const newestFirst = history.map((event) => event.recordedAt).reverse();
    expect(
      [...historyDetails.querySelectorAll<HTMLTimeElement>(".history-list time")].map(
        (time) => time.dateTime,
      ),
    ).toEqual(newestFirst.slice(0, 5));
    const expandButton = requiredElement<HTMLButtonElement>(".history-expand-button");
    expect(expandButton.textContent).toBe("すべての履歴を表示");
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      expandButton.click();
    });
    expect(
      [...historyDetails.querySelectorAll<HTMLTimeElement>(".history-list time")].map(
        (time) => time.dateTime,
      ),
    ).toEqual(newestFirst);
    expect(expandButton.textContent).toBe("最新5件のみ表示");
    expect(expandButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("項目詳細の依存グラフで中心項目を示し他の項目へ遷移する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    const loadDetails = vi.fn(() => Promise.resolve(sampleDetails));
    renderAppWithLoader(sampleSummary, loadDetails);
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    const graphSection = requiredElement<HTMLElement>(".item-dependency-graph");
    const centerNode = requiredElement<SVGGElement>(
      '.item-dependency-graph [data-node-id="sample-item-engine-204"]',
    );
    expect(graphSection.textContent).toContain("依存関係");
    expect(requiredElement<HTMLElement>(".graph-selection-summary").textContent).toBe(
      "この項目と現在有効な依存関係で直接つながる項目だけを、中心項目を含めて3件表示します。",
    );
    expect(graphSection.textContent).not.toContain("表示上限外の隣接項目");
    expect(graphSection.querySelector(".graph-node-size-description")).toBeNull();
    expect(requiredElement<HTMLElement>(".dependency-graph-legend").textContent).toContain(
      "ノードの形IssuePull Request外部参照",
    );
    expect(requiredElement<HTMLElement>(".graph-legend-edges").textContent).toBe(
      "線種確定関係推定関係",
    );
    expect(requiredElement<HTMLElement>(".graph-legend-direction").textContent).toBe(
      "矢印の向き矢印は依存関係の始点から終点へ向き、ブロック関係はブロック元からブロックされる項目へ向きます。",
    );
    expect(requiredElement<SVGDescElement>("#item-dependency-graph-description").textContent).toBe(
      "VOICEVOX/sample-engine#204を中心項目として示します。",
    );
    expect(centerNode.dataset["central"]).toBe("true");
    expect(centerNode.querySelector(".graph-central-label")).toBeNull();
    expect(centerNode.querySelector("rect")?.getAttribute("class")).toContain(
      "stroke-graph-node-central-accent",
    );
    expect(centerNode.getAttribute("aria-label")).toContain("中心項目");
    const neighborLink = requiredElement<SVGAElement>(
      '.item-dependency-graph a[href="/voicevox_task_tracker/items/sample-editor/103"]',
    );

    act(() => {
      neighborLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
        }),
      );
    });
    await flushUi();

    expect(window.location.pathname).toBe("/voicevox_task_tracker/items/sample-editor/103");
    expect(
      requiredElement<HTMLElement>('.item-details-card[data-node-id="sample-item-editor-103"]'),
    ).not.toBeNull();
    expect(loadDetails).toHaveBeenCalledTimes(1);
  });

  it("項目詳細の依存グラフで表示上限外の隣接項目数を同じ補足に示す", async () => {
    const limitedSummary = createPublicSummaryDto({
      ...sampleSummary,
      graph: {
        ...sampleSummary.graph,
        maxNodes: 2,
      },
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderApp(limitedSummary);
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    expect(requiredElement<HTMLElement>(".graph-selection-summary").textContent).toBe(
      "この項目と現在有効な依存関係で直接つながる項目だけを、中心項目を含めて2件表示します。表示上限外の隣接項目が1件あります。",
    );
  });

  it("依存関係がない項目の詳細では依存グラフセクションを表示しない", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/101");
    renderApp(sampleSummary);
    await flushUi();

    expect(currentContainer().querySelector(".item-dependency-graph")).toBeNull();
    expect(currentContainer().querySelector(".dependency-graph-legend")).toBeNull();
  });

  it("要対応度と重要度を表示し、重要度の加点要因を区別する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/101");
    renderApp(sampleSummary);
    await flushUi();

    const currentAction = requiredElement<HTMLElement>(".current-action-panel");
    expect(currentAction.textContent).not.toContain("停滞の深刻さ");
    expect(currentAction.textContent).toContain("要対応度中25点重要度と直近の動きから決まる値");
    expect(currentAction.textContent).toContain("重要度高63点項目自体の重要さ");

    const importanceEvidence = requiredElement<HTMLElement>(".importance-evidence");
    expect(importanceEvidence.querySelector("h5")?.textContent).toBe("重要度の加点内訳");
    expect(importanceEvidence.textContent).not.toContain("重要度 高・63点");
    expect(
      [...importanceEvidence.querySelectorAll(".importance-factor-source")].map(
        (source) => source.textContent,
      ),
    ).toEqual(["決定論", "Codex判定", "決定論", "決定論"]);
    expect(
      [...importanceEvidence.querySelectorAll(".importance-factor-list li")].map(
        (factor) => factor.textContent,
      ),
    ).toEqual([
      "決定論優先度ラベル+25点優先度ラベルの重みで25点を加算します",
      "Codex判定重要な機能+20点Codex判定で20点です。利用者へ広く影響する重要な機能です",
      "決定論マイルストーン期限+10点期限付きのopen milestoneで10点です",
      "決定論依存先への影響+8点open項目1件とリポジトリ1件への影響で8点です",
    ]);
  });

  it("リポジトリ、番号、タイトル、アクター、team、ラベルを公開DTO内で検索する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);
    const searchInput = requiredElement<HTMLInputElement>("#item-search-input");
    expect(searchInput.placeholder).toBe("空白で区切った語をすべて含む項目を検索");
    expect(searchInput.getAttribute("aria-describedby")).toBeNull();
    expect(requiredElement<HTMLLabelElement>("#item-search-label").textContent).toBe(
      "リポジトリ、番号、タイトル、アクター、team、ラベルで検索",
    );
    expect(currentContainer().querySelector("#item-search-description")).toBeNull();
    expect(currentContainer().textContent).not.toContain(
      "公開済みデータだけを使い、項目を検索します。",
    );
    const cases = [
      {
        query: "sample-core",
        nodeIds: ["sample-item-core-305"],
      },
      {
        query: "#202",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "方針を決める",
        nodeIds: ["sample-item-editor-103"],
      },
      {
        query: "hiho",
        nodeIds: ["sample-item-editor-103"],
      },
      {
        query: "sample-dictionary-author",
        nodeIds: ["sample-item-editor-101"],
      },
      {
        query: "sample-review-actor",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "sample-reviewers",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "レビュワー チーム",
        nodeIds: ["sample-item-engine-202"],
      },
      {
        query: "blocked",
        nodeIds: ["sample-item-engine-204"],
      },
    ] satisfies readonly Readonly<{
      query: string;
      nodeIds: readonly string[];
    }>[];

    for (const searchCase of cases) {
      await enterSearch(searchCase.query);
      expect(itemRowNodeIds()).toEqual(searchCase.nodeIds);
      expect(new URL(window.location.href).searchParams.get("q")).toBe(searchCase.query);
    }
  });

  it("検索データの読み込み中メッセージを一覧の空状態だけに表示する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderAppWithLoader(
      sampleSummary,
      () =>
        new Promise<PublicDetailsDto>(() => {
          return;
        }),
    );

    await enterSearch("blocked");

    const message = "検索用の公開詳細データを読み込んでいます。";
    expect(
      [...currentContainer().querySelectorAll("p")].filter(
        (paragraph) => paragraph.textContent === message,
      ),
    ).toHaveLength(1);
    expect(
      requiredElement<HTMLElement>('[aria-labelledby="items-heading"] .empty-state').textContent,
    ).toBe(message);
    expect(requiredElement<HTMLElement>(".item-search").textContent).not.toContain(message);
  });

  it("検索データの取得失敗と再取得を一覧の空状態だけに表示する", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    const loadDetails = vi
      .fn<() => Promise<PublicDetailsDto>>()
      .mockRejectedValueOnce(new Error("取得失敗"))
      .mockResolvedValue(sampleDetails);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderAppWithLoader(sampleSummary, loadDetails);

    await enterSearch("blocked");

    const message = "検索用の公開詳細データを取得できませんでした。";
    expect(
      [...currentContainer().querySelectorAll("p")].filter(
        (paragraph) => paragraph.textContent === message,
      ),
    ).toHaveLength(1);
    const failure = requiredElement<HTMLElement>(
      '[aria-labelledby="items-heading"] .search-load-failure',
    );
    expect(failure.textContent).toContain(message);
    expect(requiredElement<HTMLElement>(".item-search").textContent).not.toContain(message);

    act(() => {
      requiredElement<HTMLButtonElement>(".search-load-failure button").click();
    });
    await flushUi();

    expect(loadDetails).toHaveBeenCalledTimes(2);
    expect(currentContainer().querySelector(".search-load-failure")).toBeNull();
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);
  });

  it("検索後も一覧件数とソートキー名を表示しない", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);

    await enterSearch("blocked");

    const itemsSection = requiredElement<HTMLElement>('[aria-labelledby="items-heading"]');
    const controls = requiredElement<HTMLElement>(".item-workspace > .item-sort-controls");
    expect(itemsSection.querySelector(".section-heading p")).toBeNull();
    expect(currentContainer().querySelector(".items-item-count")).toBeNull();
    expect(currentContainer().querySelector(".item-list-count")).toBeNull();
    expect(requiredElement<HTMLElement>(".item-list-toolbar").nextElementSibling).toBe(controls);
    expect(controls.classList).toContain("lg:hidden");
    expect(currentContainer().querySelector(".search-status")).toBeNull();
    expect(currentContainer().textContent).not.toContain("件が検索条件に一致しました。");
  });

  it("検索、表filter、並び順を項目一覧のdeep linkから再現する", async () => {
    const deepLink =
      "/voicevox_task_tracker/?q=blocked&repo=VOICEVOX%2Fsample-engine&status=waiting_for_unblock&sort=stall&direction=descending";
    window.history.replaceState({}, "", deepLink);
    renderApp(sampleSummary);
    await flushUi();

    const filterDetails = requiredElement<HTMLDetailsElement>(".item-list-toolbar");
    expect(filterDetails.open).toBe(true);
    expect(requiredElement<HTMLElement>(".filter-summary-count").textContent).toBe("3件適用中");
    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("blocked");
    expect(
      requiredElement<HTMLSelectElement>('select[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("VOICEVOX/sample-engine");
    expect(requiredElement<HTMLSelectElement>('select[aria-label="状態で絞り込み"]').value).toBe(
      "waiting_for_unblock",
    );
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("stall");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);

    act(() => {
      render(null, currentContainer());
    });
    renderApp(sampleSummary);
    await flushUi();

    expect(requiredElement<HTMLDetailsElement>(".item-list-toolbar").open).toBe(true);
    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("blocked");
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-204"]);
  });

  it("重要度のfilterとscore順を項目一覧のdeep linkから再現する", () => {
    const deepLink = "/voicevox_task_tracker/?importance=high&sort=importance&direction=descending";
    window.history.replaceState({}, "", deepLink);
    renderApp(sampleSummary);

    expect(requiredElement<HTMLDetailsElement>(".item-list-toolbar").open).toBe(true);
    expect(requiredElement<HTMLElement>(".filter-summary-count").textContent).toBe("1件適用中");
    expect(requiredElement<HTMLSelectElement>('select[aria-label="重要度で絞り込み"]').value).toBe(
      "high",
    );
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("importance");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    expect(itemRowNodeIds()).toEqual([
      "sample-item-editor-101",
      "sample-item-core-305",
      "sample-item-editor-103",
    ]);
    expect(window.location.pathname + window.location.search).toBe(deepLink);
  });

  it("削除済みの条件と古い並び替えキーをURL状態から除去する", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/?repo=VOICEVOX%2Fsample-core&blocker=sample-editor%23103&updated=2026-07-29&sort=repository",
    );
    renderApp(sampleSummary);

    expect(currentContainer().textContent).toContain("URLに含まれる不正または未対応");
    expect(
      requiredElement<HTMLSelectElement>('select[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("VOICEVOX/sample-core");
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("attention");
    expect(window.location.pathname + window.location.search).toBe(
      "/voicevox_task_tracker/?repo=VOICEVOX%2Fsample-core",
    );
  });

  it("識別子の選択肢にないURLの絞り込み値だけを既定値へ戻す", () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/?repo=VOICEVOX%2Fmissing&type=Issue&status=%E3%83%96%E3%83%AD%E3%83%83%E3%82%AF%E4%B8%AD&importance=%E9%AB%98&waitingOn=sample-reviewers&stall=30%E6%97%A5%E4%BB%A5%E4%B8%8A",
    );
    renderApp(sampleSummary);

    expect(currentContainer().textContent).toContain("URLに含まれる不正または未対応");
    expect(
      [...currentContainer().querySelectorAll<HTMLSelectElement>(".item-filter-grid select")].map(
        (select) => select.value,
      ),
    ).toEqual(["", "", "", "", "", ""]);
    expect(requiredElement<HTMLInputElement>('input[aria-label="待ち相手で絞り込み"]').value).toBe(
      "sample-reviewers",
    );
    expect(itemRowNodeIds()).toEqual(["sample-item-engine-202"]);
    expect(window.location.pathname + window.location.search).toBe(
      "/voicevox_task_tracker/?waitingOn=sample-reviewers",
    );
  });

  it("不正なURL状態を個別に無視して安全な既定状態へ戻す", async () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/items/missing/999?q=first&q=second&repo=%00&sort=invalid&direction=sideways&item=missing&unexpected=value#item-details",
    );
    renderApp(sampleSummary);
    await flushUi();

    expect(currentContainer().textContent).toContain("URLに含まれる不正または未対応");
    expect(requiredElement<HTMLInputElement>("#item-search-input").value).toBe("");
    expect(
      requiredElement<HTMLSelectElement>('select[aria-label="リポジトリで絞り込み"]').value,
    ).toBe("");
    expect(requiredElement<HTMLSelectElement>("#item-sort-key").value).toBe("attention");
    expect(requiredElement<HTMLButtonElement>(".item-sort-controls button").textContent).toContain(
      "降順",
    );
    expect(requiredElement<HTMLTableCellElement>('th[aria-sort="descending"]').textContent).toBe(
      "要対応度↓",
    );
    expect(currentContainer().querySelector(".item-details-card")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#item-details");
  });

  it("低confidenceの状態、waitingOn、次の行動を候補として表示する", async () => {
    const lowConfidenceSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item) =>
        item.nodeId === "sample-item-editor-103"
          ? {
              ...item,
              confidence: 0.5,
              waitingOn: item.waitingOn.map((waitingOn) => ({
                ...waitingOn,
                confidence: 0.5,
              })),
            }
          : item,
      ),
    });
    const lowConfidenceItem = lowConfidenceSummary.items.find(
      (item) => item.nodeId === "sample-item-editor-103",
    );
    assertNonNullable(lowConfidenceItem, "低confidenceのsummary項目がありません");
    const lowConfidenceDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === lowConfidenceItem.nodeId
          ? {
              ...details,
              summary: lowConfidenceItem,
              uncertainties: ["判断者を確定できる根拠が不足しています"],
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103");
    renderAppWithDetails(lowConfidenceSummary, lowConfidenceDetails);
    await flushUi();

    const details = requiredElement<HTMLElement>(".item-details-card");
    expect(details.querySelector(".confidence-uncertain")).not.toBeNull();
    expect(details.textContent).toContain("判定: 未確定");
    expect(details.textContent).toContain("現在の状態候補");
    expect(details.textContent).toContain("待ち相手候補");
    expect(details.textContent).toContain("次の行動候補");
    expect(details.textContent).toContain("判断者を確定できる根拠が不足");
    expect(details.querySelector(".current-action-panel .waiting-on-confidence")?.textContent).toBe(
      "確度区分: 未確定",
    );
    expect(details.querySelector(".decision-details .uncertainty-list")).not.toBeNull();
    expect(details.querySelector(".context-details")).toBeNull();
  });

  it("公開DTOのconfidence閾値を表示区分へ反映する", async () => {
    const targetNodeId = "sample-item-editor-103";
    const configuredSummary = createPublicSummaryDto({
      ...sampleSummary,
      confidenceThresholds: {
        high: 0.9,
        medium: 0.7,
      },
      items: sampleSummary.items.map((item) =>
        item.nodeId === targetNodeId
          ? {
              ...item,
              confidence: 0.8,
              waitingOn: item.waitingOn.map((waitingOn) => ({
                ...waitingOn,
                confidence: 0.8,
              })),
            }
          : item,
      ),
    });
    const configuredItem = configuredSummary.items.find((item) => item.nodeId === targetNodeId);
    assertNonNullable(configuredItem, "閾値確認用のsummary項目がありません");
    const configuredDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === targetNodeId
          ? {
              ...details,
              summary: configuredItem,
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/103");

    renderAppWithDetails(configuredSummary, configuredDetails);
    await flushUi();

    const details = requiredElement<HTMLElement>(".item-details-card");
    expect(details.querySelector(".confidence-estimate")).not.toBeNull();
    expect(details.querySelector(".confidence-high_estimate")).toBeNull();
    expect(details.textContent).toContain("判定: 推定");
  });

  it("keyboard focusで全列を絞り込み、link activationで詳細を開いて閉じる", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/");
    renderApp(sampleSummary);
    const filterDetails = requiredElement<HTMLDetailsElement>(".item-list-toolbar");
    act(() => {
      filterDetails.open = true;
    });
    const filterControls = [
      ...filterDetails.querySelectorAll<HTMLElement>(
        ".item-filter-grid select, .item-filter-grid input",
      ),
    ];
    expect(filterControls).toHaveLength(7);
    for (const filterControl of filterControls) {
      filterControl.focus();
      expect(document.activeElement).toBe(filterControl);
    }
    const search = requiredElement<HTMLInputElement>("#item-search-input");
    search.focus();
    expect(document.activeElement).toBe(search);
    await enterSearch("blocked");

    const detailsLink = requiredElement<HTMLAnchorElement>(
      '.items-table tr[data-node-id="sample-item-engine-204"] a[href="/voicevox_task_tracker/items/sample-engine/204"]',
    );
    detailsLink.focus();
    expect(document.activeElement).toBe(detailsLink);
    await act(async () => {
      detailsLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    await flushUi();

    expect(window.location.pathname).toBe("/voicevox_task_tracker/items/sample-engine/204");
    expect(document.activeElement?.textContent).toBe("サンプル配布処理を実装する");
    const closeLink = requiredElement<HTMLAnchorElement>(
      '.item-details-actions a[href="/voicevox_task_tracker/"]',
    );
    closeLink.focus();
    expect(document.activeElement).toBe(closeLink);
    await act(async () => {
      closeLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(currentContainer().querySelector(".item-details-card")).toBeNull();
    expect(window.location.pathname).toBe("/voicevox_task_tracker/");
  });

  it("詳細内のGitHub由来文字列をHTMLとして実行しない", async () => {
    const xssText = '<img src="x" onerror="globalThis.__detailXss = true">';
    const xssSummary = createPublicSummaryDto({
      ...sampleSummary,
      items: sampleSummary.items.map((item) =>
        item.nodeId === "sample-item-editor-101"
          ? {
              ...item,
              title: xssText,
            }
          : item,
      ),
    });
    const xssItem = xssSummary.items.find((item) => item.nodeId === "sample-item-editor-101");
    assertNonNullable(xssItem, "XSSテストのsummary項目がありません");
    const xssDetails = createPublicDetailsDto({
      ...sampleDetails,
      items: sampleDetails.items.map((details) =>
        details.summary.nodeId === xssItem.nodeId
          ? {
              ...details,
              summary: xssItem,
              labels: [xssText],
              evidence: details.evidence.map((evidence) => ({
                ...evidence,
                summary: xssText,
              })),
              uncertainties: [xssText],
            }
          : details,
      ),
    });
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-editor/101");
    renderAppWithDetails(xssSummary, xssDetails);
    await flushUi();

    expect(currentContainer().querySelector("img")).toBeNull();
    expect(currentContainer().querySelector("script")).toBeNull();
    expect(currentContainer().textContent).toContain(xssText);
  });

  it("CSPを維持し、危険なinline実行を許可しない", () => {
    expect(indexHtml).toContain("default-src 'self'");
    expect(indexHtml).toContain("base-uri 'none'");
    expect(indexHtml).toContain("form-action 'none'");
    expect(indexHtml).toContain("object-src 'none'");
    expect(indexHtml).toContain(
      "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
    );
    expect(indexHtml).toContain('<link rel="stylesheet" href="/src/styles.css" />');
    expect(indexHtml).not.toContain("'unsafe-inline'");
    expect(indexHtml).not.toContain("'unsafe-eval'");
  });

  it("主要な文字色と背景色がWCAG AAのコントラスト比を満たす", () => {
    const colorPairs = [
      ["162521", "f4f1e8"],
      ["162521", "fffcf5"],
      ["fffcf5", "162521"],
      ["3c4a45", "fffcf5"],
      ["3c4a45", "efece1"],
      ["3c4a45", "dff3e9"],
      ["5d6964", "f4f1e8"],
      ["5d6964", "fffcf5"],
      ["5d6964", "efece1"],
      ["5d6964", "dff3e9"],
      ["5d6964", "fdf0d5"],
      ["16815d", "fffcf5"],
      ["0d5a40", "f4f1e8"],
      ["0d5a40", "fffcf5"],
      ["0d5a40", "efece1"],
      ["0d5a40", "dff3e9"],
      ["0d5a40", "fdf0d5"],
      ["1e4b7a", "e4eef8"],
      ["0d5a40", "dff3e9"],
      ["6b4400", "fdf0d5"],
      ["7a2727", "fbe9e6"],
      ["4b5a55", "eceadf"],
      ["7a2727", "fbe0da"],
      ["7a2727", "fffcf5"],
      ["162521", "dff3e9"],
      ["162521", "efece1"],
      ["162521", "fdf0d5"],
      ["162521", "fbe9e6"],
      ["162521", "eceadf"],
      ["162521", "cfe9dc"],
      ["0d5a40", "eceadf"],
      ["0d5a40", "cfe9dc"],
      ["0d5a40", "fdf0d5"],
      ["7a2727", "fffcf5"],
    ] satisfies readonly Readonly<[string, string]>[];

    for (const [foreground, background] of colorPairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("WCAG 2.2 AA対象の重大な自動a11y違反がない", async () => {
    window.history.replaceState({}, "", "/voicevox_task_tracker/items/sample-engine/204");
    renderApp(sampleSummary);
    await flushUi();

    const results = await axe.run(document.body, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      rules: {
        "color-contrast": {
          enabled: false,
        },
      },
    });
    const seriousViolations = results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(
      seriousViolations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target),
      })),
    ).toEqual([]);
  });

  it.each([
    ["担当者一覧", "/voicevox_task_tracker/people"],
    ["人ごと", "/voicevox_task_tracker/people/hiho?teams=VOICEVOX%2FMaintainers"],
  ])("%sページに重大な自動a11y違反がない", async (_pageName, path) => {
    storeViewerIdentity("hiho", ["VOICEVOX/Maintainers"]);
    window.history.replaceState({}, "", path);
    renderApp(createPersonPageSummary());

    const results = await axe.run(document.body, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      rules: {
        "color-contrast": {
          enabled: false,
        },
      },
    });
    const seriousViolations = results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious",
    );
    expect(
      seriousViolations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target),
      })),
    ).toEqual([]);
  });
});

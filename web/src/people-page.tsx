import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { createGitHubAvatarUrl } from "./github-avatar.js";
import { ContentState, PageSection } from "./layout.js";
import { collectWaitingSubjectRows, resolveWaitingSubjects, waitingSubjectKey } from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { Pill } from "./ui.js";
import { isViewerLogin } from "./viewer-identity.js";
import { PersonLink, type PersonNavigation } from "./waiting-on-display.js";

type PeoplePageProps = PersonNavigation &
  Readonly<{
    locale: string;
    now: Date;
    summary: PublicSummaryDto;
    viewerLogin: string | undefined;
  }>;

type WaitingSubjectRow = ReturnType<typeof collectWaitingSubjectRows>[number];

function isViewerRow(row: WaitingSubjectRow, viewerLogin: string | undefined): boolean {
  return row.subject.kind === "user" && isViewerLogin(row.subject.login, viewerLogin);
}

function WaitingSubjectName({
  createPersonHref,
  onSelectPerson,
  row,
  viewerLogin,
}: Readonly<{
  createPersonHref: (login: string) => string;
  onSelectPerson: (login: string) => void;
  row: WaitingSubjectRow;
  viewerLogin: string | undefined;
}>) {
  const viewer = isViewerRow(row, viewerLogin);
  return (
    <span class="flex min-w-0 flex-wrap items-center gap-2">
      {row.subject.kind === "user" ? (
        <span class="flex min-w-0 items-center gap-2">
          <img
            alt=""
            class="size-6 shrink-0 rounded-full border border-border-default bg-surface-page"
            decoding="async"
            height={24}
            loading="lazy"
            src={createGitHubAvatarUrl(row.subject.login)}
            width={24}
          />
          <PersonLink
            createPersonHref={createPersonHref}
            login={row.subject.login}
            onSelectPerson={onSelectPerson}
          />
        </span>
      ) : (
        <span class="min-w-0 text-text-primary wrap-anywhere">{row.label}</span>
      )}
      {viewer && (
        <Pill className="viewer-person-badge" tone="neutral" variant="filled">
          <span aria-hidden="true">自分</span>
          <span class="visually-hidden sr-only">自分のアカウントです</span>
        </Pill>
      )}
    </span>
  );
}

function waitingSubjectRowPresentation(
  row: WaitingSubjectRow,
  viewerLogin: string | undefined,
): ResponsiveListRowPresentation {
  const viewer = isViewerRow(row, viewerLogin);
  return {
    cardClassName: viewer
      ? "viewer-person-card bg-surface-emphasis [&_a]:text-accent-link-hover"
      : "bg-surface-card",
    dataAttributes: {},
    key: waitingSubjectKey(row.subject),
    tableClassName: viewer
      ? "viewer-person-row bg-surface-emphasis [&_a]:text-accent-link-hover"
      : "",
  };
}

/** 項目への対応を待たれている人とチームの集計を表示する。 */
export function PeoplePage({
  createPersonHref,
  locale,
  now,
  onSelectPerson,
  summary,
  viewerLogin,
}: PeoplePageProps) {
  const rows = useMemo(() => collectWaitingSubjectRows(summary, now), [now, summary]);
  const unidentifiedItemCount = useMemo(
    () =>
      summary.items.filter(
        (item) => item.waitingOn.length > 0 && resolveWaitingSubjects(item).length === 0,
      ).length,
    [summary.items],
  );
  const tableColumns = [
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "row_header",
      headerClassName: "",
      key: "subject",
      label: "待ち相手",
      renderCell: (row: WaitingSubjectRow) => (
        <WaitingSubjectName
          createPersonHref={createPersonHref}
          onSelectPerson={onSelectPerson}
          row={row}
          viewerLogin={viewerLogin}
        />
      ),
      widthClassName: "w-[52%]",
    },
    {
      ariaSort: "descending",
      cellClassName: "font-mono whitespace-nowrap text-right tabular-nums",
      cellKind: "data",
      headerClassName: "text-right",
      key: "itemCount",
      label: "待たせている項目数",
      renderCell: (row: WaitingSubjectRow) => row.itemCount.toLocaleString(locale),
      widthClassName: "w-[26%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "font-mono whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "longestStallDuration",
      label: "最長停滞時間",
      renderCell: (row: WaitingSubjectRow) => row.longestStallDuration,
      widthClassName: "w-[22%]",
    },
  ] satisfies readonly ResponsiveTableColumn<WaitingSubjectRow>[];
  const cardFields = [
    {
      className: "",
      key: "itemCount",
      label: "待たせている項目数",
      renderValue: (row: WaitingSubjectRow) => row.itemCount.toLocaleString(locale),
      valueClassName: "font-mono font-semibold text-text-primary tabular-nums",
    },
    {
      className: "",
      key: "longestStallDuration",
      label: "最長停滞時間",
      renderValue: (row: WaitingSubjectRow) => row.longestStallDuration,
      valueClassName: "font-mono font-semibold text-text-primary tabular-nums",
    },
  ] satisfies readonly ResponsiveCardField<WaitingSubjectRow>[];

  return (
    <PageSection className="people-page" heading="担当者一覧" headingId="people-page-heading">
      {rows.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在、担当者を特定できる止まっている項目はありません。"
          status="empty"
        />
      ) : (
        <ResponsiveTableCardList
          breakpoint="md"
          cardAriaLabel="担当者一覧"
          cardFields={cardFields}
          cardListClassName="people-card-list"
          columns={tableColumns}
          getRowPresentation={(row) => waitingSubjectRowPresentation(row, viewerLogin)}
          rows={rows}
          tableCaption="待ち相手ごとの待たせている項目数と最長停滞時間"
          tableClassName="people-table"
          renderCardHeading={(row) => (
            <h3 class="m-0 min-w-0 text-base leading-6 font-semibold">
              <WaitingSubjectName
                createPersonHref={createPersonHref}
                onSelectPerson={onSelectPerson}
                row={row}
                viewerLogin={viewerLogin}
              />
            </h3>
          )}
          renderCardFooter={() => null}
        />
      )}
      {unidentifiedItemCount > 0 && (
        <p class="mt-4 mb-0 max-w-3xl text-sm text-text-muted">
          {"レビュワーの誰か待ちなど、待ち相手を特定できない項目が"}
          <span class="font-mono tabular-nums">{unidentifiedItemCount.toLocaleString(locale)}</span>
          {"件あります。"}
        </p>
      )}
    </PageSection>
  );
}

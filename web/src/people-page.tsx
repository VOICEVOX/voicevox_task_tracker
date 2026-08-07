import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
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

type PeoplePageProps = Readonly<{
  createPersonHref: (login: string) => string;
  locale: string;
  now: Date;
  onSelectPerson: (login: string) => void;
  summary: PublicSummaryDto;
  viewerLogin: string | undefined;
}>;

type WaitingSubjectRow = ReturnType<typeof collectWaitingSubjectRows>[number];

function PersonLink({
  href,
  label,
  login,
  onSelect,
}: Readonly<{
  href: string;
  label: string;
  login: string;
  onSelect: (login: string) => void;
}>) {
  return (
    <a
      class="inline-flex min-h-11 min-w-0 items-center py-2 text-text-primary decoration-accent-link decoration-1 hover:text-accent-link-hover md:min-h-0 md:py-0"
      href={href}
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) {
          return;
        }
        event.preventDefault();
        onSelect(login);
      }}
    >
      {label}
    </a>
  );
}

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
        <PersonLink
          href={createPersonHref(row.subject.login)}
          label={row.label}
          login={row.subject.login}
          onSelect={onSelectPerson}
        />
      ) : (
        <span class="min-w-0 text-text-primary [overflow-wrap:anywhere]">{row.label}</span>
      )}
      {viewer && (
        <Pill className="viewer-person-badge" tone="neutral">
          <span aria-hidden="true">自分</span>
          <span class="visually-hidden">自分のアカウントです</span>
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
    cardClassName: viewer ? "viewer-person-card bg-surface-emphasis" : "bg-surface-card",
    dataAttributes: {},
    key: waitingSubjectKey(row.subject),
    tableClassName: viewer
      ? "viewer-person-row [&>th]:bg-surface-emphasis [&>td]:bg-surface-emphasis"
      : "",
  };
}

/** 項目を待たせている人とチームの集計を表示する。 */
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
      cellClassName: "whitespace-nowrap text-right tabular-nums",
      cellKind: "data",
      headerClassName: "text-right",
      key: "itemCount",
      label: "待たせている項目数",
      renderCell: (row: WaitingSubjectRow) => row.itemCount.toLocaleString(locale),
      widthClassName: "w-[26%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "whitespace-nowrap tabular-nums",
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
      valueClassName: "font-semibold text-text-primary tabular-nums",
    },
    {
      className: "",
      key: "longestStallDuration",
      label: "最長停滞時間",
      renderValue: (row: WaitingSubjectRow) => row.longestStallDuration,
      valueClassName: "font-semibold text-text-primary tabular-nums",
    },
  ] satisfies readonly ResponsiveCardField<WaitingSubjectRow>[];

  return (
    <PageSection
      className="people-page w-full max-w-4xl justify-self-start"
      heading="担当者一覧"
      headingId="people-page-heading"
    >
      {rows.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在、担当者を特定できる止まっている項目はありません。"
          status="empty"
        />
      ) : (
        <ResponsiveTableCardList
          cardAriaLabel="担当者一覧"
          cardFields={cardFields}
          cardListClassName="people-card-list"
          columns={tableColumns}
          getRowPresentation={(row) => waitingSubjectRowPresentation(row, viewerLogin)}
          rows={rows}
          tableCaption="待ち相手ごとの待たせている項目数と最長停滞時間"
          tableClassName="people-table max-w-3xl"
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
          レビュワーの誰か待ちなど、待ち相手を特定できない項目が
          {unidentifiedItemCount.toLocaleString(locale)}件あります。
        </p>
      )}
    </PageSection>
  );
}

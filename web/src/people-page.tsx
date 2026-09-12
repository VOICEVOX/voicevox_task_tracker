import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { ContentState, PageSection } from "./layout.js";
import {
  collectCurrentResponseSubjectRows,
  currentResponseSubjectKey,
  resolveCurrentResponseSubjects,
} from "./model.js";
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

type CurrentResponseSubjectRow = ReturnType<typeof collectCurrentResponseSubjectRows>[number];

function isViewerRow(row: CurrentResponseSubjectRow, viewerLogin: string | undefined): boolean {
  return row.subject.kind === "user" && isViewerLogin(row.subject.login, viewerLogin);
}

function CurrentResponseSubjectName({
  createPersonHref,
  onSelectPerson,
  row,
  viewerLogin,
}: Readonly<{
  createPersonHref: (login: string) => string;
  onSelectPerson: (login: string) => void;
  row: CurrentResponseSubjectRow;
  viewerLogin: string | undefined;
}>) {
  const viewer = isViewerRow(row, viewerLogin);
  return (
    <span class="flex min-w-0 flex-wrap items-center gap-2">
      {row.subject.kind === "user" ? (
        <PersonLink
          createPersonHref={createPersonHref}
          login={row.subject.login}
          onSelectPerson={onSelectPerson}
          showAvatar={true}
        />
      ) : (
        <span class="min-w-0 text-text-primary wrap-anywhere">{row.label}</span>
      )}
      {viewer && (
        <Pill className="viewer-person-badge" tone="neutral">
          <span aria-hidden="true">自分</span>
          <span class="visually-hidden sr-only">自分のアカウントです</span>
        </Pill>
      )}
    </span>
  );
}

function currentResponseSubjectRowPresentation(
  row: CurrentResponseSubjectRow,
  viewerLogin: string | undefined,
): ResponsiveListRowPresentation {
  const viewer = isViewerRow(row, viewerLogin);
  return {
    cardClassName: viewer
      ? "viewer-person-card bg-surface-emphasis [&_a]:text-accent-link-hover"
      : "bg-surface-card",
    dataAttributes: {},
    key: currentResponseSubjectKey(row.subject),
    tableClassName: viewer
      ? "viewer-person-row bg-surface-emphasis [&_a]:text-accent-link-hover"
      : "",
  };
}

/** 現在の対応者である人とチームの集計を表示する。 */
export function PeoplePage({
  createPersonHref,
  locale,
  now,
  onSelectPerson,
  summary,
  viewerLogin,
}: PeoplePageProps) {
  const rows = useMemo(() => collectCurrentResponseSubjectRows(summary, now), [now, summary]);
  const unidentifiedItemCount = useMemo(
    () =>
      summary.items.filter(
        (item) =>
          item.currentResponses.length > 0 && resolveCurrentResponseSubjects(item).length === 0,
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
      label: "現在の対応者",
      renderCell: (row: CurrentResponseSubjectRow) => (
        <CurrentResponseSubjectName
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
      label: "対応中の項目数",
      renderCell: (row: CurrentResponseSubjectRow) => row.itemCount.toLocaleString(locale),
      widthClassName: "w-[26%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "font-mono whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "longestStallDuration",
      label: "項目の最長停滞時間",
      renderCell: (row: CurrentResponseSubjectRow) => row.longestStallDuration,
      widthClassName: "w-[22%]",
    },
  ] satisfies readonly ResponsiveTableColumn<CurrentResponseSubjectRow>[];
  const cardFields = [
    {
      className: "",
      key: "itemCount",
      label: "対応中の項目数",
      renderValue: (row: CurrentResponseSubjectRow) => row.itemCount.toLocaleString(locale),
      valueClassName: "font-mono font-semibold text-text-primary tabular-nums",
    },
    {
      className: "",
      key: "longestStallDuration",
      label: "項目の最長停滞時間",
      renderValue: (row: CurrentResponseSubjectRow) => row.longestStallDuration,
      valueClassName: "font-mono font-semibold text-text-primary tabular-nums",
    },
  ] satisfies readonly ResponsiveCardField<CurrentResponseSubjectRow>[];

  return (
    <PageSection className="people-page" heading="現在の対応者一覧" headingId="people-page-heading">
      {rows.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在の対応者を特定できる項目はありません。"
          status="empty"
        />
      ) : (
        <ResponsiveTableCardList
          breakpoint="md"
          cardAriaLabel="担当者一覧"
          cardFields={cardFields}
          cardListClassName="people-card-list"
          columns={tableColumns}
          getRowPresentation={(row) => currentResponseSubjectRowPresentation(row, viewerLogin)}
          rows={rows}
          tableCaption="現在の対応者ごとの対応中の項目数と項目の最長停滞時間"
          tableClassName="people-table"
          renderCardHeading={(row) => (
            <h3 class="m-0 min-w-0 text-base leading-6 font-semibold">
              <CurrentResponseSubjectName
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
          {"役割だけで示された現在の対応など、人物やチームを特定できない項目が"}
          <span class="font-mono tabular-nums">{unidentifiedItemCount.toLocaleString(locale)}</span>
          {"件あります。"}
        </p>
      )}
    </PageSection>
  );
}

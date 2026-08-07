import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { ImportanceBadge } from "./importance-badge.js";
import { ItemDetailsLink } from "./item-details.js";
import { ContentState, PageSection } from "./layout.js";
import {
  collectWaitingTeamIds,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  formatStallDuration,
  selectWaitingSubjectItemNodeIds,
  selectWaitingSubjectReasons,
  statusLabel,
  waitingSubjectKey,
  type ItemTableRow,
  type TableSort,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { ActionButton, Pill } from "./ui.js";

type PersonPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  isViewerIdentity: boolean;
  locale: string;
  login: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  onSelectPeople: () => void;
  onTeamIdsChange: (teamIds: readonly string[]) => void;
  onViewerIdentityToggle: () => void;
  peopleHref: string;
  selectedTeamIds: readonly string[];
  summary: PublicSummaryDto;
  viewerIdentityAvailable: boolean;
}>;

const LONGEST_STALL_FIRST_SORT = {
  key: "stall",
  direction: "descending",
} satisfies TableSort;

function waitingReason(row: ItemTableRow, login: string, teamIds: readonly string[]): string {
  return selectWaitingSubjectReasons(row.item, login, teamIds).join("、");
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

/** 指定したGitHubアカウントを待っている項目を表示する。 */
export function PersonPage({
  createItemHref,
  isViewerIdentity,
  locale,
  login,
  now,
  onSelectItem,
  onSelectPeople,
  onTeamIdsChange,
  onViewerIdentityToggle,
  peopleHref,
  selectedTeamIds,
  summary,
  viewerIdentityAvailable,
}: PersonPageProps) {
  const teamOptions = useMemo(() => collectWaitingTeamIds(summary), [summary]);
  const selectedTeamKeys = useMemo(
    () => new Set(selectedTeamIds.map((teamId) => waitingSubjectKey({ kind: "team", teamId }))),
    [selectedTeamIds],
  );
  const selectedNodeIds = useMemo(
    () => selectWaitingSubjectItemNodeIds(summary, login, selectedTeamIds),
    [login, selectedTeamIds, summary],
  );
  const rows = useMemo(
    () =>
      filterAndSortTableRows(
        createItemTableRows(summary, now).filter((row) => selectedNodeIds.has(row.item.nodeId)),
        createEmptyTableFilters(),
        LONGEST_STALL_FIRST_SORT,
        locale,
      ),
    [locale, now, selectedNodeIds, summary],
  );
  function changeTeam(teamId: string, selected: boolean): void {
    const nextTeamKeys = new Set(selectedTeamKeys);
    const teamKey = waitingSubjectKey({ kind: "team", teamId });
    if (selected) {
      nextTeamKeys.add(teamKey);
    } else {
      nextTeamKeys.delete(teamKey);
    }
    onTeamIdsChange(
      teamOptions.filter((teamId) => nextTeamKeys.has(waitingSubjectKey({ kind: "team", teamId }))),
    );
  }
  const tableColumns = [
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "row_header",
      headerClassName: "",
      key: "item",
      label: "項目",
      renderCell: (row: ItemTableRow) => (
        <div class="grid min-w-0 gap-1.5">
          <span class="item-list-meta text-xs leading-5 text-text-muted [overflow-wrap:anywhere]">
            {row.item.displayReference}・{row.typeText}
          </span>
          <span class="item-title-with-importance flex min-w-0 items-start [overflow-wrap:anywhere]">
            <ImportanceBadge importance={row.item.importance} showLow={false} showScore={false} />
            <span class="min-w-0 [overflow-wrap:anywhere]">
              <ItemTitleLink
                createItemHref={createItemHref}
                onSelectItem={onSelectItem}
                row={row}
              />
            </span>
          </span>
          {row.item.repositoryFreshness === "stale" && (
            <span class="flex">
              <Pill className="freshness-badge freshness-stale" tone="warning">
                古い観測値
              </Pill>
            </span>
          )}
        </div>
      ),
      widthClassName: "w-[52%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "[overflow-wrap:anywhere]",
      cellKind: "data",
      headerClassName: "",
      key: "status",
      label: "status",
      renderCell: (row: ItemTableRow) => statusLabel(row.item.status),
      widthClassName: "w-[14%]",
    },
    {
      ariaSort: "descending",
      cellClassName: "whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "stall",
      label: "停滞時間",
      renderCell: (row: ItemTableRow) => (
        <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
      ),
      widthClassName: "w-[12%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "[overflow-wrap:anywhere]",
      cellKind: "data",
      headerClassName: "",
      key: "reason",
      label: "待ち理由",
      renderCell: (row: ItemTableRow) => waitingReason(row, login, selectedTeamIds),
      widthClassName: "w-[22%]",
    },
  ] satisfies readonly ResponsiveTableColumn<ItemTableRow>[];
  const cardFields = [
    {
      className: "",
      key: "status",
      label: "status",
      renderValue: (row: ItemTableRow) => statusLabel(row.item.status),
      valueClassName: "font-semibold text-text-primary",
    },
    {
      className: "",
      key: "stall",
      label: "停滞時間",
      renderValue: (row: ItemTableRow) => formatStallDuration(row.item.stallSince, now),
      valueClassName: "font-semibold text-text-primary tabular-nums",
    },
    {
      className: "col-span-full border-t border-border-subtle pt-3",
      key: "reason",
      label: "待ち理由",
      renderValue: (row: ItemTableRow) => waitingReason(row, login, selectedTeamIds),
      valueClassName: "leading-6 text-text-primary",
    },
  ] satisfies readonly ResponsiveCardField<ItemTableRow>[];

  return (
    <PageSection
      className="person-page flex min-h-[calc(100svh-14rem)] flex-col [&>.section-heading]:mb-4 [&>.section-heading]:flex-col [&>.section-heading]:items-start [&>.section-heading]:gap-3"
      heading={`@${login} を待っている項目`}
      headingAccessory={
        <div class="grid w-full gap-3">
          <p class="person-item-count m-0 max-w-3xl text-text-muted" aria-live="polite">
            {rows.length.toLocaleString(locale)}
            件を表示しています。所属チームを選ぶと、そのチーム宛の待ちも加わります。
          </p>
          <div class="person-identity-action flex flex-wrap items-center gap-x-4 gap-y-2">
            <ActionButton
              aria-describedby={
                viewerIdentityAvailable ? undefined : "person-identity-unavailable-reason"
              }
              className="person-identity-button max-narrow:w-full"
              type="button"
              disabled={!viewerIdentityAvailable}
              onClick={onViewerIdentityToggle}
            >
              {isViewerIdentity ? "自分の記憶を解除する" : "自分として記憶する"}
            </ActionButton>
            <a
              class="person-back-link inline-flex min-h-11 items-center"
              href={peopleHref}
              onClick={(event) => {
                if (!shouldHandleClientNavigation(event)) {
                  return;
                }
                event.preventDefault();
                onSelectPeople();
              }}
            >
              担当者一覧へ戻る
            </a>
            {!viewerIdentityAvailable && (
              <p
                class="m-0 w-full text-sm text-state-warning-text"
                id="person-identity-unavailable-reason"
              >
                このブラウザーでは記憶を利用できません。
              </p>
            )}
          </div>
        </div>
      }
      headingId="person-page-heading"
    >
      {teamOptions.length > 0 && (
        <fieldset class="person-team-selection mb-4 flex flex-wrap gap-2 rounded-xl border border-border-default bg-surface-sunken px-3 pt-2 pb-3 text-text-secondary">
          <legend class="px-1 font-bold">所属チーム</legend>
          {teamOptions.map((teamId) => (
            <label
              class="flex min-h-11 flex-[1_1_18rem] cursor-pointer items-start gap-2 rounded-md border border-border-default bg-surface-card px-3 py-2"
              key={waitingSubjectKey({ kind: "team", teamId })}
            >
              <input
                class="mt-1 size-4 shrink-0 accent-action-border"
                type="checkbox"
                name="person-team"
                value={teamId}
                checked={selectedTeamKeys.has(waitingSubjectKey({ kind: "team", teamId }))}
                onChange={(event) => {
                  changeTeam(teamId, event.currentTarget.checked);
                }}
              />
              <span class="min-w-0 leading-5 [overflow-wrap:anywhere]">
                <strong>{teamId}</strong>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {rows.length === 0 ? (
        <ContentState
          className="empty-state flex-1"
          message={`@${login} を待っている項目はありません。`}
          status="empty"
        />
      ) : (
        <ResponsiveTableCardList
          cardAriaLabel="待っている項目一覧"
          cardFields={cardFields}
          cardListClassName=""
          columns={tableColumns}
          getRowPresentation={itemRowPresentation}
          rows={rows}
          tableCaption={`@${login} を待っている項目の一覧`}
          tableClassName="items-table person-items-table"
          renderCardHeading={(row) => (
            <div class="grid min-w-0 gap-2">
              <div class="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <p class="item-list-meta m-0 min-w-0 flex-1 text-sm leading-5 text-text-muted [overflow-wrap:anywhere]">
                  {row.item.displayReference}・{row.typeText}
                </p>
                {row.item.repositoryFreshness === "stale" && (
                  <Pill className="freshness-badge freshness-stale" tone="warning">
                    古い観測値
                  </Pill>
                )}
              </div>
              <h3 class="item-title-with-importance m-0 flex min-w-0 items-start text-base leading-6 font-bold">
                <ImportanceBadge
                  importance={row.item.importance}
                  showLow={false}
                  showScore={false}
                />
                <span class="min-w-0 [overflow-wrap:anywhere]">
                  <ItemTitleLink
                    createItemHref={createItemHref}
                    onSelectItem={onSelectItem}
                    row={row}
                  />
                </span>
              </h3>
            </div>
          )}
          renderCardFooter={() => null}
        />
      )}
    </PageSection>
  );
}

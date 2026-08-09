import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { ItemListHeading } from "./item-list-heading.js";
import { ContentState, PageSection } from "./layout.js";
import { ListCountSummary } from "./list-count-summary.js";
import {
  collectWaitingTeamIds,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  formatStallDuration,
  resolveWaitingSubjects,
  selectWaitingSubjectItemNodeIds,
  selectWaitingSubjectReasons,
  statusLabel,
  waitingSubjectKey,
  waitingSubjectLabel,
  type ItemSort,
  type ItemSortKey,
  type ItemTableRow,
  type WaitingSubject,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { ITEM_SORT_OPTIONS, SortControls } from "./sort-controls.js";
import { ActionButton } from "./ui.js";

type PersonPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  isViewerIdentity: boolean;
  locale: string;
  login: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  onSelectPeople: () => void;
  onSortChange: (key: ItemSortKey) => void;
  onTeamIdsChange: (teamIds: readonly string[]) => void;
  onViewerIdentityToggle: () => void;
  peopleHref: string;
  selectedTeamIds: readonly string[];
  sort: ItemSort;
  summary: PublicSummaryDto;
  viewerIdentityAvailable: boolean;
}>;

function selectWaitingDestinations(
  row: ItemTableRow,
  login: string,
  teamIds: readonly string[],
): readonly WaitingSubject[] {
  const selectedSubjectKeys = new Set([
    waitingSubjectKey({ kind: "user", login }),
    ...teamIds.map((teamId) => waitingSubjectKey({ kind: "team", teamId })),
  ]);
  const destinations = resolveWaitingSubjects(row.item).filter((subject) =>
    selectedSubjectKeys.has(waitingSubjectKey(subject)),
  );
  if (destinations.length === 0) {
    throw new TypeError(`項目 ${row.item.nodeId} に選択中の待ち相手がありません`);
  }
  return destinations;
}

function waitingDestinationLabel(subject: WaitingSubject): string {
  return subject.kind === "user"
    ? `本人 ${waitingSubjectLabel(subject)}`
    : `選択した${waitingSubjectLabel(subject)}`;
}

function PersonWaitingOn({
  login,
  row,
  teamIds,
}: Readonly<{
  login: string;
  row: ItemTableRow;
  teamIds: readonly string[];
}>) {
  const destinations = selectWaitingDestinations(row, login, teamIds);
  const reasons = selectWaitingSubjectReasons(row.item, login, teamIds);
  if (reasons.length === 0) {
    throw new TypeError(`項目 ${row.item.nodeId} に選択中の待ち理由がありません`);
  }
  return (
    <div class="person-waiting-on grid gap-1">
      <strong class="person-waiting-destinations wrap-anywhere">
        {destinations.map(waitingDestinationLabel).join("、")}
      </strong>
      <span class="person-waiting-reasons text-sm text-text-muted wrap-anywhere">
        {reasons.join("、")}
      </span>
    </div>
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

/** 指定したGitHubアカウントの対応を待っている項目を表示する。 */
export function PersonPage({
  createItemHref,
  isViewerIdentity,
  locale,
  login,
  now,
  onSelectItem,
  onSelectPeople,
  onSortChange,
  onTeamIdsChange,
  onViewerIdentityToggle,
  peopleHref,
  selectedTeamIds,
  sort,
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
        sort,
      ),
    [now, selectedNodeIds, sort, summary],
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
      headerClassName: "whitespace-nowrap",
      key: "item",
      label: "項目",
      renderCell: (row: ItemTableRow) => (
        <ItemListHeading
          createItemHref={createItemHref}
          onSelectItem={onSelectItem}
          row={row}
          showFreshnessBadge={true}
        />
      ),
      widthClassName: "w-[32%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "status",
      label: "状態",
      renderCell: (row: ItemTableRow) => statusLabel(row.item.status),
      widthClassName: "w-[12%]",
    },
    {
      ariaSort: sort.key === "attention" ? sort.direction : "none",
      cellClassName: "attention-cell whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "attention",
      label: "要対応度",
      onSort: () => {
        onSortChange("attention");
      },
      renderCell: (row: ItemTableRow) => (
        <AttentionBadge attention={row.item.attention} showLabel={false} showScore={false} />
      ),
      widthClassName: "w-[11%]",
    },
    {
      ariaSort: sort.key === "importance" ? sort.direction : "none",
      cellClassName: "importance-cell whitespace-nowrap",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "importance",
      label: "重要度",
      onSort: () => {
        onSortChange("importance");
      },
      renderCell: (row: ItemTableRow) => (
        <ImportanceBadge importance={row.item.importance} showLabel={false} showScore={false} />
      ),
      widthClassName: "w-[10%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "leading-6 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "waitingOn",
      label: "待ち相手",
      renderCell: (row: ItemTableRow) => (
        <PersonWaitingOn login={login} row={row} teamIds={selectedTeamIds} />
      ),
      widthClassName: "w-[23%]",
    },
    {
      ariaSort: sort.key === "stall" ? sort.direction : "none",
      cellClassName: "whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "stall",
      label: "停滞時間",
      onSort: () => {
        onSortChange("stall");
      },
      renderCell: (row: ItemTableRow) => (
        <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
      ),
      widthClassName: "w-[12%]",
    },
  ] satisfies readonly ResponsiveTableColumn<ItemTableRow>[];
  const cardFields = [
    {
      className: "",
      key: "status",
      label: "状態",
      renderValue: (row: ItemTableRow) => statusLabel(row.item.status),
      valueClassName: "font-semibold text-text-primary",
    },
    {
      className: "",
      key: "attention",
      label: "要対応度",
      renderValue: (row: ItemTableRow) => (
        <AttentionBadge attention={row.item.attention} showLabel={false} showScore={false} />
      ),
      valueClassName: "font-semibold text-text-primary",
    },
    {
      className: "",
      key: "importance",
      label: "重要度",
      renderValue: (row: ItemTableRow) => (
        <ImportanceBadge importance={row.item.importance} showLabel={false} showScore={false} />
      ),
      valueClassName: "font-semibold text-text-primary",
    },
    {
      className: "col-span-full border-t border-border-subtle pt-3",
      key: "waitingOn",
      label: "待ち相手",
      renderValue: (row: ItemTableRow) => (
        <PersonWaitingOn login={login} row={row} teamIds={selectedTeamIds} />
      ),
      valueClassName: "leading-6 text-text-primary",
    },
    {
      className: "",
      key: "stall",
      label: "停滞時間",
      renderValue: (row: ItemTableRow) => formatStallDuration(row.item.stallSince, now),
      valueClassName: "font-semibold text-text-primary tabular-nums",
    },
  ] satisfies readonly ResponsiveCardField<ItemTableRow>[];

  return (
    <PageSection
      className="person-page"
      description={
        teamOptions.length > 0 ? "所属チームを選ぶと、そのチーム宛の待ちも加わります。" : undefined
      }
      heading={`@${login} を待っている項目`}
      headingId="person-page-heading"
    >
      <div class="person-identity-action mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
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
              <span class="min-w-0 leading-5 wrap-anywhere">
                <strong>{teamId}</strong>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div class="item-list-controls mb-4 flex flex-wrap items-end justify-between gap-4">
        <ListCountSummary
          className="item-list-count person-item-count"
          count={rows.length}
          locale={locale}
          sort={sort}
        />
        <SortControls
          className="item-list-sort-controls person-sort-controls grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 sm:w-auto sm:min-w-64"
          onSortChange={onSortChange}
          options={ITEM_SORT_OPTIONS}
          selectId="person-sort-key"
          sort={sort}
        />
      </div>
      {rows.length === 0 ? (
        <ContentState
          className="empty-state"
          message={`@${login} を待っている項目はありません。`}
          status="empty"
        />
      ) : (
        <ResponsiveTableCardList
          breakpoint="lg"
          cardAriaLabel="待っている項目一覧"
          cardFields={cardFields}
          cardListClassName=""
          columns={tableColumns}
          getRowPresentation={itemRowPresentation}
          rows={rows}
          tableCaption={`@${login} を待っている項目の一覧`}
          tableClassName="items-table person-items-table"
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
      )}
    </PageSection>
  );
}

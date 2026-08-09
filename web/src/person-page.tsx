import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { createItemCardFields, createItemTableColumns } from "./item-list-fields.js";
import { ItemListHeading } from "./item-list-heading.js";
import { ContentState, PageSection } from "./layout.js";
import {
  collectWaitingTeamIds,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  selectWaitingSubjectItemNodeIds,
  selectWaitingSubjectPrimaryCandidate,
  waitingSubjectKey,
  type ItemSort,
  type ItemSortKey,
  type ItemTableRow,
} from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveListRowPresentation,
} from "./responsive-table-card-list.js";
import { ITEM_SORT_OPTIONS, SortControls } from "./sort-controls.js";
import { ActionButton } from "./ui.js";
import { type PersonNavigation } from "./waiting-on-display.js";

type PersonPageProps = PersonNavigation &
  Readonly<{
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
  createPersonHref,
  isViewerIdentity,
  locale,
  login,
  now,
  onSelectItem,
  onSelectPerson,
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
  const itemListFieldOptions = {
    createItemHref,
    createPersonHref,
    locale,
    now,
    onSelectItem,
    onSelectPerson,
    onSortChange,
    selectPrimaryWaitingOn: (row: ItemTableRow) =>
      selectWaitingSubjectPrimaryCandidate(row.item, login, selectedTeamIds),
    sort,
    summary,
  };
  const tableColumns = createItemTableColumns(itemListFieldOptions);
  const cardFields = createItemCardFields(itemListFieldOptions);

  return (
    <PageSection
      className="person-page"
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
      <SortControls
        className="item-list-sort-controls person-sort-controls mb-4 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 sm:w-auto sm:min-w-64 lg:hidden"
        onSortChange={onSortChange}
        options={ITEM_SORT_OPTIONS}
        selectId="person-sort-key"
        sort={sort}
      />
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

import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { ImportanceBadge } from "./importance-badge.js";
import { ItemDetailsLink } from "./item-details.js";
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

type PersonPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  isViewerIdentity: boolean;
  locale: string;
  login: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  onTeamIdsChange: (teamIds: readonly string[]) => void;
  onViewerIdentityToggle: () => void;
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

/** 指定したGitHubアカウントを待っている項目を表示する。 */
export function PersonPage({
  createItemHref,
  isViewerIdentity,
  locale,
  login,
  now,
  onSelectItem,
  onTeamIdsChange,
  onViewerIdentityToggle,
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

  return (
    <section aria-labelledby="person-page-heading" class="section-card person-page">
      <div class="section-heading">
        <div>
          <h2 id="person-page-heading">@{login} を待っている項目</h2>
        </div>
        <p class="person-item-count" aria-live="polite">
          {rows.length.toLocaleString(locale)}
          件を表示しています。所属チームを選ぶと、そのチーム宛の待ちも加わります。
        </p>
      </div>
      <div class="person-identity-action">
        <button
          aria-describedby={
            viewerIdentityAvailable ? undefined : "person-identity-unavailable-reason"
          }
          class="person-identity-button"
          type="button"
          disabled={!viewerIdentityAvailable}
          onClick={onViewerIdentityToggle}
        >
          {isViewerIdentity ? "自分の記憶を解除する" : "自分として記憶する"}
        </button>
        {!viewerIdentityAvailable && (
          <p id="person-identity-unavailable-reason">このブラウザーでは記憶を利用できません。</p>
        )}
      </div>
      {teamOptions.length > 0 && (
        <fieldset class="person-team-selection">
          <legend>所属チーム</legend>
          {teamOptions.map((teamId) => (
            <label key={waitingSubjectKey({ kind: "team", teamId })}>
              <input
                type="checkbox"
                name="person-team"
                value={teamId}
                checked={selectedTeamKeys.has(waitingSubjectKey({ kind: "team", teamId }))}
                onChange={(event) => {
                  changeTeam(teamId, event.currentTarget.checked);
                }}
              />
              <span>
                <strong>{teamId}</strong>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {rows.length === 0 ? (
        <p class="empty-state">@{login} を待っている項目はありません。</p>
      ) : (
        <>
          <div class="items-table-region">
            <table class="items-table person-items-table">
              <caption class="visually-hidden">@{login} を待っている項目の一覧</caption>
              <colgroup>
                <col class="item-column" />
                <col class="status-column" />
                <col class="stall-column" />
                <col class="reason-column" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">項目</th>
                  <th scope="col">status</th>
                  <th scope="col" aria-sort="descending">
                    停滞時間
                  </th>
                  <th scope="col">待ち理由</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
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
                      <span class="item-title-with-importance">
                        <ImportanceBadge
                          importance={row.item.importance}
                          showLow={false}
                          showScore={false}
                        />
                        <ItemTitleLink
                          createItemHref={createItemHref}
                          onSelectItem={onSelectItem}
                          row={row}
                        />
                      </span>
                      {row.item.repositoryFreshness === "stale" && (
                        <span class="freshness-badge freshness-stale">古い観測値</span>
                      )}
                    </th>
                    <td>{statusLabel(row.item.status)}</td>
                    <td>
                      <strong>{formatStallDuration(row.item.stallSince, now)}</strong>
                    </td>
                    <td>{waitingReason(row, login, selectedTeamIds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ol class="items-card-list" aria-label="待っている項目一覧">
            {rows.map((row) => (
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
                      <h3 class="item-title-with-importance">
                        <ImportanceBadge
                          importance={row.item.importance}
                          showLow={false}
                          showScore={false}
                        />
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
                      <dt>status</dt>
                      <dd>{statusLabel(row.item.status)}</dd>
                    </div>
                    <div>
                      <dt>停滞時間</dt>
                      <dd>{formatStallDuration(row.item.stallSince, now)}</dd>
                    </div>
                    <div>
                      <dt>待ち理由</dt>
                      <dd>{waitingReason(row, login, selectedTeamIds)}</dd>
                    </div>
                  </dl>
                </article>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

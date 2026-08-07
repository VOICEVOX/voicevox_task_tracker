import { useMemo } from "preact/hooks";

import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { ContentState, PageSection } from "./layout.js";
import { collectWaitingSubjectRows, resolveWaitingSubjects, waitingSubjectKey } from "./model.js";
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

  return (
    <PageSection className="people-page" heading="担当者一覧" headingId="people-page-heading">
      {rows.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在、担当者を特定できる止まっている項目はありません。"
          status="empty"
        />
      ) : (
        <>
          <div
            class="items-table-region table-scroll"
            tabIndex={0}
            role="region"
            aria-label="担当者一覧表の横スクロール領域"
          >
            <table class="people-table">
              <caption class="visually-hidden">
                待ち相手ごとの待たせている項目数と最長停滞時間
              </caption>
              <thead>
                <tr>
                  <th scope="col">待ち相手</th>
                  <th scope="col" aria-sort="descending">
                    待たせている項目数
                  </th>
                  <th scope="col">最長停滞時間</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const viewerRow =
                    row.subject.kind === "user" && isViewerLogin(row.subject.login, viewerLogin);
                  return (
                    <tr
                      key={waitingSubjectKey(row.subject)}
                      class={viewerRow ? "viewer-person-row" : undefined}
                    >
                      <th scope="row">
                        {row.subject.kind === "user" ? (
                          <PersonLink
                            href={createPersonHref(row.subject.login)}
                            label={row.label}
                            login={row.subject.login}
                            onSelect={onSelectPerson}
                          />
                        ) : (
                          row.label
                        )}
                        {viewerRow && (
                          <>
                            {" "}
                            <Pill className="viewer-person-badge" tone="neutral">
                              <span aria-hidden="true">自分</span>
                              <span class="visually-hidden">自分のアカウントです</span>
                            </Pill>
                          </>
                        )}
                      </th>
                      <td>{row.itemCount.toLocaleString(locale)}</td>
                      <td>{row.longestStallDuration}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ol class="items-card-list people-card-list" aria-label="担当者一覧">
            {rows.map((row) => {
              const viewerCard =
                row.subject.kind === "user" && isViewerLogin(row.subject.login, viewerLogin);
              return (
                <li
                  key={waitingSubjectKey(row.subject)}
                  class={viewerCard ? "viewer-person-card" : undefined}
                >
                  <article>
                    <div class="item-card-heading">
                      <h3>
                        {row.subject.kind === "user" ? (
                          <PersonLink
                            href={createPersonHref(row.subject.login)}
                            label={row.label}
                            login={row.subject.login}
                            onSelect={onSelectPerson}
                          />
                        ) : (
                          row.label
                        )}
                        {viewerCard && (
                          <>
                            {" "}
                            <Pill className="viewer-person-badge" tone="neutral">
                              <span aria-hidden="true">自分</span>
                              <span class="visually-hidden">自分のアカウントです</span>
                            </Pill>
                          </>
                        )}
                      </h3>
                    </div>
                    <dl class="item-card-summary">
                      <div>
                        <dt>待たせている項目数</dt>
                        <dd>{row.itemCount.toLocaleString(locale)}</dd>
                      </div>
                      <div>
                        <dt>最長停滞時間</dt>
                        <dd>{row.longestStallDuration}</dd>
                      </div>
                    </dl>
                  </article>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {unidentifiedItemCount > 0 && (
        <p>
          レビュワーの誰か待ちなど、待ち相手を特定できない項目が
          {unidentifiedItemCount.toLocaleString(locale)}件あります。
        </p>
      )}
    </PageSection>
  );
}

import { type ComponentChildren } from "preact";

import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { ItemDetailsLink } from "./item-details.js";
import {
  attentionPriority,
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  formatWaitingOn,
  selectAttentionItems,
  severityLabel,
  statusLabel,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";

type OverviewPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  itemsHref: string;
  locale: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  onSelectItems: () => void;
  onSelectRepositories: () => void;
  repositoriesHref: string;
  summary: PublicSummaryDto;
}>;

type OverviewPageLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
  onSelect: () => void;
}>;

type RelativeTimeDisplayProps = Readonly<{
  locale: string;
  now: Date;
  timezone: string;
  value: string;
}>;

const STATUS_VALUES: readonly PublicItemSummaryDto["status"][] = [
  "new_untriaged",
  "needs_maintainer_decision",
  "waiting_for_review",
  "waiting_for_author",
  "waiting_for_assignee",
  "blocked",
  "waiting_for_automation",
  "ready_to_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
];

const SEVERITY_VALUES: readonly PublicItemSummaryDto["severity"][] = [
  "critical",
  "urgent",
  "watch",
  "none",
];

function OverviewPageLink({ children, href, onSelect }: OverviewPageLinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }
        event.preventDefault();
        onSelect();
      }}
    >
      {children}
    </a>
  );
}

function RelativeTimeDisplay({ locale, now, timezone, value }: RelativeTimeDisplayProps) {
  return (
    <span class="relative-time-display">
      <time dateTime={value}>{formatRelativeTime(value, now, locale)}</time>
      <span class="absolute-time">{formatDateTime(value, timezone, locale)}</span>
    </span>
  );
}

function Dashboard({
  locale,
  now,
  onSelectRepositories,
  repositoriesHref,
  summary,
}: Readonly<
  Pick<
    OverviewPageProps,
    "locale" | "now" | "onSelectRepositories" | "repositoriesHref" | "summary"
  >
>) {
  const aggregates = summary.aggregates;
  const statusesWithItems = STATUS_VALUES.filter((status) => aggregates.statusCounts[status] > 0);
  const severitiesWithItems = SEVERITY_VALUES.filter(
    (severity) => aggregates.severityCounts[severity] > 0,
  );

  return (
    <section aria-labelledby="overview-heading" class="section-card overview">
      <div class="section-heading overview-heading">
        <div>
          <p class="eyebrow">Overview</p>
          <h2 id="overview-heading">全体の状況</h2>
        </div>
        <p class="overview-observed-time">
          <span class="time-label">データ観測</span>
          <RelativeTimeDisplay
            value={summary.observedAt}
            now={now}
            timezone={summary.timezone}
            locale={locale}
          />
        </p>
      </div>

      <AiStateNotice ai={summary.ai} />

      <dl class="metric-grid">
        <div class="metric">
          <dt>リポジトリ</dt>
          <dd>
            <span class="metric-value">{aggregates.repositoryCount.toLocaleString(locale)}</span>
            <span class="metric-unit">件</span>
          </dd>
        </div>
        <div class="metric">
          <dt>項目</dt>
          <dd>
            <span class="metric-value">{aggregates.itemCount.toLocaleString(locale)}</span>
            <span class="metric-unit">件</span>
          </dd>
        </div>
        <div class="metric metric-with-link">
          <dt>鮮度要確認</dt>
          <dd>
            <span>
              <span class="metric-value">
                {aggregates.staleRepositoryCount.toLocaleString(locale)}
              </span>
              <span class="metric-unit">リポジトリ</span>
            </span>
            <OverviewPageLink href={repositoriesHref} onSelect={onSelectRepositories}>
              鮮度を確認
            </OverviewPageLink>
          </dd>
        </div>
      </dl>

      <details class="aggregate-details">
        <summary>詳しい集計と生成情報</summary>
        <div class="aggregate-details-content">
          <section aria-labelledby="supporting-count-heading">
            <h3 id="supporting-count-heading">補助指標</h3>
            <dl class="count-list">
              <div>
                <dt>unknown項目</dt>
                <dd>{aggregates.unknownItemCount.toLocaleString(locale)}</dd>
              </div>
              <div>
                <dt>古い観測値の項目</dt>
                <dd>{aggregates.staleItemCount.toLocaleString(locale)}</dd>
              </div>
            </dl>
          </section>
          <section aria-labelledby="status-count-heading">
            <h3 id="status-count-heading">status別</h3>
            {statusesWithItems.length === 0 ? (
              <p class="no-counts">該当する分類はありません。</p>
            ) : (
              <dl class="count-list">
                {statusesWithItems.map((status) => (
                  <div key={status}>
                    <dt>{statusLabel(status)}</dt>
                    <dd>{aggregates.statusCounts[status].toLocaleString(locale)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section aria-labelledby="severity-count-heading">
            <h3 id="severity-count-heading">停滞の深刻さ別</h3>
            {severitiesWithItems.length === 0 ? (
              <p class="no-counts">該当する分類はありません。</p>
            ) : (
              <dl class="count-list">
                {severitiesWithItems.map((severity) => (
                  <div key={severity}>
                    <dt>
                      <span class={`severity-badge severity-${severity}`}>
                        {severityLabel(severity)}
                      </span>
                    </dt>
                    <dd>{aggregates.severityCounts[severity].toLocaleString(locale)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section aria-labelledby="generation-heading">
            <h3 id="generation-heading">生成情報</h3>
            <dl class="count-list">
              <div>
                <dt>生成時刻</dt>
                <dd>
                  <RelativeTimeDisplay
                    value={summary.generatedAt}
                    now={now}
                    timezone={summary.timezone}
                    locale={locale}
                  />
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </details>
    </section>
  );
}

function AiStateNotice({ ai }: Readonly<{ ai: PublicSummaryDto["ai"] }>) {
  if (!ai.enabled) {
    return (
      <p class="notice ai-state-notice" role="status">
        AI分析は設定で無効です。確定ルールで表示しています。
      </p>
    );
  }
  if (!ai.available) {
    return (
      <p class="notice notice-warning ai-state-notice" role="status">
        AIを利用できなかったため、確定ルールと利用可能な前回結果で表示しています。
      </p>
    );
  }
  if (ai.degraded) {
    return (
      <p class="notice notice-warning ai-state-notice" role="status">
        AI分析の一部が縮退したため、確定ルールと利用可能な前回結果を併用しています。
      </p>
    );
  }
  return null;
}

function AttentionQueue({
  attentionItems,
  createItemHref,
  itemsHref,
  locale,
  now,
  onSelectItem,
  onSelectItems,
  summary,
}: OverviewPageProps &
  Readonly<{
    attentionItems: readonly PublicItemSummaryDto[];
  }>) {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );

  return (
    <section aria-labelledby="attention-heading" class="section-card attention-section">
      <div class="section-heading attention-heading">
        <div>
          <p class="eyebrow">Action first</p>
          <h2 id="attention-heading">対応が必要な項目</h2>
        </div>
        <p class="attention-summary">
          <strong>{attentionItems.length.toLocaleString(locale)}件</strong>
          <span>優先度の高い順</span>
        </p>
      </div>
      {attentionItems.length === 0 ? (
        <p class="empty-state">現在、対応が必要な項目はありません。</p>
      ) : (
        <ol class="attention-list">
          {attentionItems.map((item) => {
            const repository = repositoriesById.get(item.repositoryId);
            assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
            const priority = attentionPriority(item);
            return (
              <li key={item.nodeId} data-node-id={item.nodeId}>
                <article class="attention-item">
                  <div class="attention-title">
                    <div class="attention-title-row">
                      <h3>{item.title}</h3>
                      <span class={`severity-badge severity-${item.severity}`}>
                        {severityLabel(item.severity)}
                      </span>
                    </div>
                    <p class="item-reference">
                      {repository.fullName} #{item.number.toString()}
                    </p>
                  </div>
                  <dl class="attention-primary-details">
                    <div>
                      <dt>待っている相手</dt>
                      <dd>{formatWaitingOn(item, summary)}</dd>
                    </div>
                    <div>
                      <dt>停滞時間</dt>
                      <dd>{formatStallDuration(item.stallSince, now)}</dd>
                    </div>
                  </dl>
                  <div class="item-actions">
                    <ItemDetailsLink
                      href={createItemHref(item.nodeId)}
                      nodeId={item.nodeId}
                      onSelect={onSelectItem}
                    >
                      詳細を開く
                    </ItemDetailsLink>
                    <SafeGitHubLink href={item.url}>GitHubで開く</SafeGitHubLink>
                  </div>
                  <details class="attention-more">
                    <summary>補助情報</summary>
                    <dl class="attention-secondary-details">
                      <div>
                        <dt>対応優先度</dt>
                        <dd>{priority.label}</dd>
                      </div>
                      <div>
                        <dt>影響範囲</dt>
                        <dd>
                          {item.downstreamImpact.repositoryCount.toLocaleString(locale)}
                          リポジトリ・
                          {item.downstreamImpact.openNodeCount.toLocaleString(locale)}
                          項目
                        </dd>
                      </div>
                      <div class="attention-reason">
                        <dt>理由</dt>
                        <dd>
                          {item.waitingOn.map((waitingOn) => waitingOn.reasonSummary).join("、")}
                        </dd>
                      </div>
                      <div>
                        <dt>項目観測</dt>
                        <dd>
                          <RelativeTimeDisplay
                            value={item.observedAt}
                            now={now}
                            timezone={summary.timezone}
                            locale={locale}
                          />
                        </dd>
                      </div>
                    </dl>
                  </details>
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {summary.aggregates.staleItemCount > 0 && (
        <p class="notice attention-stale-notice">
          古い観測値の項目は現在の要対応一覧から除外しています。
          <OverviewPageLink href={itemsHref} onSelect={onSelectItems}>
            項目一覧で確認
          </OverviewPageLink>
        </p>
      )}
    </section>
  );
}

/** 対応が必要な項目と概要を表示する。 */
export function OverviewPage(props: OverviewPageProps) {
  const attentionItems = selectAttentionItems(props.summary.items);
  return (
    <>
      <AttentionQueue {...props} attentionItems={attentionItems} />
      <Dashboard
        locale={props.locale}
        now={props.now}
        onSelectRepositories={props.onSelectRepositories}
        repositoriesHref={props.repositoriesHref}
        summary={props.summary}
      />
    </>
  );
}

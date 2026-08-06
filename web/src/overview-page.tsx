import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { ImportanceBadge } from "./importance-badge.js";
import { ItemDetailsLink } from "./item-details.js";
import {
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  formatWaitingOn,
  selectAttentionItems,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";

type OverviewPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  locale: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
}>;

type RelativeTimeDisplayProps = Readonly<{
  locale: string;
  now: Date;
  timezone: string;
  value: string;
}>;

function RelativeTimeDisplay({ locale, now, timezone, value }: RelativeTimeDisplayProps) {
  return (
    <time dateTime={value} title={formatDateTime(value, timezone, locale)}>
      {formatRelativeTime(value, now, locale)}
    </time>
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
  locale,
  now,
  onSelectItem,
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
        <div class="attention-heading-metadata">
          <p class="overview-observed-time">
            <span class="time-label">データ観測</span>
            <RelativeTimeDisplay
              value={summary.observedAt}
              now={now}
              timezone={summary.timezone}
              locale={locale}
            />
          </p>
          <p class="attention-summary">
            <strong>{attentionItems.length.toLocaleString(locale)}件</strong>
            <span>停滞が深刻な順</span>
          </p>
        </div>
      </div>
      {attentionItems.length === 0 ? (
        <p class="empty-state">現在、対応が必要な項目はありません。</p>
      ) : (
        <ol class="attention-list">
          {attentionItems.map((item) => {
            const repository = repositoriesById.get(item.repositoryId);
            assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
            return (
              <li key={item.nodeId} data-node-id={item.nodeId}>
                <article class="attention-item">
                  <div class="attention-title">
                    <h3 class="item-title-with-importance">
                      <ImportanceBadge
                        importance={item.importance}
                        showLow={false}
                        showScore={false}
                      />
                      {item.title}
                    </h3>
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
                        <dt>待ち理由</dt>
                        <dd>
                          {item.waitingOn.map((waitingOn) => waitingOn.reasonSummary).join("、")}
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
    </section>
  );
}

/** 対応が必要な項目を表示する。 */
export function OverviewPage(props: OverviewPageProps) {
  const attentionItems = selectAttentionItems(props.summary.items);
  const hasStaleRepository = props.summary.repositories.some(
    (repository) => repository.freshness.status === "stale",
  );
  return (
    <>
      <AiStateNotice ai={props.summary.ai} />
      {hasStaleRepository && (
        <p class="notice notice-warning repository-freshness-notice" role="status">
          一部リポジトリの情報を取得できなかったため、前回の値を表示しています。
        </p>
      )}
      <AttentionQueue {...props} attentionItems={attentionItems} />
    </>
  );
}

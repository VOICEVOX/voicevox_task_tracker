import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { ImportanceBadge } from "./importance-badge.js";
import { ItemDetailsLink } from "./item-details.js";
import { ContentState, PageSection } from "./layout.js";
import {
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  formatWaitingOn,
  formatWaitingOnCandidate,
  selectAttentionItems,
  selectPrimaryWaitingOnCandidate,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";

const MAX_STALE_REPOSITORY_NAMES = 3;

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
      <p
        class="notice ai-state-notice my-4 rounded-md border-l-4 border-state-info-border bg-state-info-background px-4 py-3.5 text-state-info-text"
        role="status"
      >
        AI分析は設定で無効です。確定ルールで表示しています。
      </p>
    );
  }
  if (!ai.available) {
    return (
      <p
        class="notice notice-warning ai-state-notice my-4 rounded-md border-l-4 border-state-warning-border bg-state-warning-background px-4 py-3.5 text-state-warning-text"
        role="status"
      >
        AIを利用できなかったため、確定ルールと利用可能な前回結果で表示しています。
      </p>
    );
  }
  if (ai.degraded) {
    return (
      <p
        class="notice notice-warning ai-state-notice my-4 rounded-md border-l-4 border-state-warning-border bg-state-warning-background px-4 py-3.5 text-state-warning-text"
        role="status"
      >
        AI分析の一部が縮退したため、確定ルールと利用可能な前回結果を併用しています。
      </p>
    );
  }
  return null;
}

function formatStaleRepositoryNames(
  repositories: PublicSummaryDto["repositories"],
  locale: string,
): string {
  const visibleNames = repositories
    .slice(0, MAX_STALE_REPOSITORY_NAMES)
    .map((repository) => repository.fullName);
  const remainingCount = repositories.length - visibleNames.length;
  if (remainingCount === 0) {
    return visibleNames.join("、");
  }
  return `${visibleNames.join("、")}、ほか${remainingCount.toLocaleString(locale)}件`;
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
    <PageSection
      className="attention-section"
      heading="対応が必要な項目"
      headingAccessory={
        <div class="attention-heading attention-heading-metadata">
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
            <span>対応が必要な順</span>
          </p>
        </div>
      }
      headingId="attention-heading"
    >
      {attentionItems.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在、対応が必要な項目はありません。"
          status="empty"
        />
      ) : (
        <ol class="attention-list">
          {attentionItems.map((item) => {
            const repository = repositoriesById.get(item.repositoryId);
            assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
            const primaryWaitingOn = selectPrimaryWaitingOnCandidate(item);
            const primaryWaitingOnLabel =
              primaryWaitingOn == null
                ? formatWaitingOn(item, summary)
                : formatWaitingOnCandidate(primaryWaitingOn, item, summary);
            const otherWaitingOnCount = primaryWaitingOn == null ? 0 : item.waitingOn.length - 1;
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
                      <ItemDetailsLink
                        href={createItemHref(item.nodeId)}
                        nodeId={item.nodeId}
                        onSelect={onSelectItem}
                      >
                        {item.title}
                      </ItemDetailsLink>
                    </h3>
                    <p class="item-reference">
                      {repository.fullName} #{item.number.toString()}
                    </p>
                  </div>
                  <dl class="attention-primary-details">
                    <div class="attention-waiting-on">
                      <dt>主な待ち相手</dt>
                      <dd>
                        <span class="attention-waiting-on-summary">
                          <span class="attention-primary-waiting-on">{primaryWaitingOnLabel}</span>
                          {otherWaitingOnCount > 0 && (
                            <span class="attention-other-waiting-on">
                              ほか{otherWaitingOnCount.toLocaleString(locale)}件
                            </span>
                          )}
                        </span>
                        {primaryWaitingOn != null && (
                          <span
                            class="attention-waiting-reason"
                            title={primaryWaitingOn.reasonSummary}
                          >
                            {primaryWaitingOn.reasonSummary}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>停滞時間</dt>
                      <dd>{formatStallDuration(item.stallSince, now)}</dd>
                    </div>
                  </dl>
                  <div class="item-actions">
                    <SafeGitHubLink href={item.url}>GitHubで開く</SafeGitHubLink>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </PageSection>
  );
}

/** 対応が必要な項目を表示する。 */
export function OverviewPage(props: OverviewPageProps) {
  const attentionItems = selectAttentionItems(props.summary.items);
  const staleRepositories = props.summary.repositories.filter(
    (repository) => repository.freshness.status === "stale",
  );
  return (
    <>
      <AiStateNotice ai={props.summary.ai} />
      {staleRepositories.length > 0 && (
        <p
          class="notice notice-warning repository-freshness-notice my-4 rounded-md border-l-4 border-state-warning-border bg-state-warning-background px-4 py-3.5 text-state-warning-text"
          role="status"
        >
          次のリポジトリの情報を取得できなかったため、前回の値を表示しています。対象:{" "}
          <span class="repository-freshness-targets">
            {formatStaleRepositoryNames(staleRepositories, props.locale)}
          </span>
        </p>
      )}
      <AttentionQueue {...props} attentionItems={attentionItems} />
    </>
  );
}

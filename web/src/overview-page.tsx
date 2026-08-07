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
const OVERVIEW_NOTICE_CLASS_NAME =
  "notice m-0 rounded-md border-l-2 bg-surface-card px-3 py-2 text-sm leading-5 text-text-secondary";

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
    <time class="font-bold" dateTime={value} title={formatDateTime(value, timezone, locale)}>
      {formatRelativeTime(value, now, locale)}
    </time>
  );
}

function hasAiStateNotice(ai: PublicSummaryDto["ai"]): boolean {
  return !ai.enabled || !ai.available || ai.degraded;
}

function AiStateNotice({ ai }: Readonly<{ ai: PublicSummaryDto["ai"] }>) {
  if (!ai.enabled) {
    return (
      <p
        class={`${OVERVIEW_NOTICE_CLASS_NAME} ai-state-notice border-state-info-border`}
        role="status"
      >
        AI分析は設定で無効です。確定ルールで表示しています。
      </p>
    );
  }
  if (!ai.available) {
    return (
      <p
        class={`${OVERVIEW_NOTICE_CLASS_NAME} notice-warning ai-state-notice border-state-warning-border`}
        role="status"
      >
        AIを利用できなかったため、確定ルールと利用可能な前回結果で表示しています。
      </p>
    );
  }
  if (ai.degraded) {
    return (
      <p
        class={`${OVERVIEW_NOTICE_CLASS_NAME} notice-warning ai-state-notice border-state-warning-border`}
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
        <div class="attention-heading attention-heading-metadata flex flex-wrap items-end gap-4 max-shell:-mt-2 max-shell:items-start">
          <p class="overview-observed-time m-0 grid justify-items-end text-right max-shell:justify-items-start max-shell:text-left">
            <span class="time-label text-xs font-bold text-text-muted">データ観測</span>
            <RelativeTimeDisplay
              value={summary.observedAt}
              now={now}
              timezone={summary.timezone}
              locale={locale}
            />
          </p>
          <p class="attention-summary m-0 grid justify-items-end text-right max-shell:justify-items-start max-shell:text-left">
            <strong class="text-xl leading-tight text-text-primary">
              {attentionItems.length.toLocaleString(locale)}件
            </strong>
            <span class="text-xs">対応が必要な順</span>
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
        <ol class="attention-list m-0 grid list-none gap-3 p-0">
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
                <article class="attention-item grid min-w-0 grid-cols-[minmax(14rem,0.8fr)_minmax(22rem,1.4fr)_auto] items-start gap-4 rounded-xl border border-border-subtle bg-surface-card p-4 max-shell:grid-cols-1 max-shell:gap-3">
                  <div class="attention-title min-w-0">
                    <h3 class="item-title-with-importance m-0 grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 text-lg leading-snug font-bold max-narrow:text-base">
                      <span class="attention-importance-slot mt-0.5 flex min-h-5 items-start">
                        <ImportanceBadge
                          importance={item.importance}
                          showLow={false}
                          showScore={false}
                        />
                      </span>
                      <span class="min-w-0 wrap-anywhere">
                        <ItemDetailsLink
                          href={createItemHref(item.nodeId)}
                          nodeId={item.nodeId}
                          onSelect={onSelectItem}
                        >
                          {item.title}
                        </ItemDetailsLink>
                      </span>
                    </h3>
                    <p class="item-reference mt-1.5 mb-0 text-xs text-text-muted">
                      {repository.fullName} #{item.number.toString()}
                    </p>
                  </div>
                  <dl class="attention-primary-details m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 max-narrow:gap-2">
                    <div class="attention-waiting-on relative min-w-0 border-l-2 border-border-default pl-3">
                      <dt class="text-xs font-bold text-text-muted">主な待ち相手</dt>
                      <dd class="mt-0.5 mb-0 font-bold">
                        <span class="attention-waiting-on-summary flex min-w-0 items-baseline gap-2">
                          <span class="attention-primary-waiting-on min-w-0 flex-1 text-base leading-snug wrap-anywhere">
                            {primaryWaitingOnLabel}
                          </span>
                          {otherWaitingOnCount > 0 && (
                            <span class="attention-other-waiting-on flex-none text-xs text-text-muted whitespace-nowrap max-narrow:absolute max-narrow:top-0 max-narrow:right-0">
                              ほか{otherWaitingOnCount.toLocaleString(locale)}件
                            </span>
                          )}
                        </span>
                        {primaryWaitingOn != null && (
                          <span
                            class="attention-waiting-reason mt-1 block min-w-0 text-sm leading-5 font-normal text-text-muted wrap-anywhere"
                            title={primaryWaitingOn.reasonSummary}
                          >
                            {primaryWaitingOn.reasonSummary}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div class="min-w-24 border-l-2 border-border-default pl-3">
                      <dt class="text-xs font-bold text-text-muted">停滞時間</dt>
                      <dd class="mt-0.5 mb-0 font-bold whitespace-nowrap">
                        {formatStallDuration(item.stallSince, now)}
                      </dd>
                    </div>
                  </dl>
                  <div class="item-actions grid justify-self-end gap-2 text-sm whitespace-nowrap max-shell:justify-self-end [&>a]:inline-flex [&>a]:min-h-11 [&>a]:items-center">
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
  const aiStateNoticeVisible = hasAiStateNotice(props.summary.ai);
  const statusNoticesVisible = aiStateNoticeVisible || staleRepositories.length > 0;
  return (
    <>
      {statusNoticesVisible && (
        <div class="overview-notices grid gap-2">
          {aiStateNoticeVisible && <AiStateNotice ai={props.summary.ai} />}
          {staleRepositories.length > 0 && (
            <p
              class={`${OVERVIEW_NOTICE_CLASS_NAME} notice-warning repository-freshness-notice border-state-warning-border`}
              role="status"
            >
              次のリポジトリの情報を取得できなかったため、前回の値を表示しています。対象:{" "}
              <span class="repository-freshness-targets font-bold wrap-anywhere">
                {formatStaleRepositoryNames(staleRepositories, props.locale)}
              </span>
            </p>
          )}
        </div>
      )}
      <AttentionQueue {...props} attentionItems={attentionItems} />
    </>
  );
}

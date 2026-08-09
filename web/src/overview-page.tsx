import { type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { AiAnalysisNoticeIcon } from "./ai-analysis-notice-icon.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { ItemDetailsLink } from "./item-details.js";
import { ContentState, PageSection } from "./layout.js";
import { ListCountSummary } from "./list-count-summary.js";
import {
  aiAnalysisNotice,
  createEmptyTableFilters,
  createItemTableRows,
  filterAndSortTableRows,
  filterAttentionItems,
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  formatWaitingOn,
  formatWaitingOnCandidate,
  selectPrimaryWaitingOnCandidate,
  type ItemSort,
  type ItemSortKey,
  type ItemTableRow,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import { ITEM_SORT_OPTIONS, SortControls } from "./sort-controls.js";

const MAX_STALE_REPOSITORY_NAMES = 3;
const OVERVIEW_NOTICE_CLASS_NAME =
  "notice m-0 rounded-md border-l-2 bg-surface-card px-3 py-2 text-sm leading-5 text-text-secondary";

type OverviewPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  locale: string;
  now: Date;
  onSelectItem: (nodeId: string) => void;
  onSortChange: (key: ItemSortKey) => void;
  sort: ItemSort;
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

function AiStateNotice() {
  return (
    <p
      class={`${OVERVIEW_NOTICE_CLASS_NAME} ai-state-notice border-state-info-border`}
      role="status"
    >
      AI分析は設定で無効です。確定ルールで表示しています。
    </p>
  );
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

function sortAttentionItems(
  summary: PublicSummaryDto,
  now: Date,
  sort: ItemSort,
): readonly ItemTableRow[] {
  const attentionItems = filterAttentionItems(summary.items);
  const attentionItemNodeIds = new Set(attentionItems.map((item) => item.nodeId));
  return filterAndSortTableRows(
    createItemTableRows(summary, now).filter((row) => attentionItemNodeIds.has(row.item.nodeId)),
    createEmptyTableFilters(),
    sort,
  );
}

function AttentionQueue({
  attentionItems,
  createItemHref,
  locale,
  now,
  onSelectItem,
  onSortChange,
  sort,
  summary,
}: OverviewPageProps &
  Readonly<{
    attentionItems: readonly ItemTableRow[];
  }>) {
  return (
    <PageSection
      className="attention-section"
      description="要対応度は、重要度が高く、かつ最近動きがあった項目ほど高くなります。高または中の項目を表示します。"
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
          <ListCountSummary
            className="attention-summary"
            count={attentionItems.length}
            locale={locale}
            sort={sort}
          />
        </div>
      }
      headingId="attention-heading"
    >
      <SortControls
        className="overview-sort-controls mb-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:max-w-sm"
        onSortChange={onSortChange}
        options={ITEM_SORT_OPTIONS}
        selectId="overview-sort-key"
        sort={sort}
      />
      {attentionItems.length === 0 ? (
        <ContentState
          className="empty-state"
          message="現在、対応が必要な項目はありません。"
          status="empty"
        />
      ) : (
        <ol class="attention-list m-0 grid list-none gap-3 p-0">
          {attentionItems.map((row) => {
            const { item } = row;
            const primaryWaitingOn = selectPrimaryWaitingOnCandidate(item);
            const primaryWaitingOnLabel =
              primaryWaitingOn == null
                ? formatWaitingOn(item, summary)
                : formatWaitingOnCandidate(primaryWaitingOn, item, summary);
            const otherWaitingOnCount = primaryWaitingOn == null ? 0 : item.waitingOn.length - 1;
            return (
              <li key={item.nodeId} data-node-id={item.nodeId}>
                <article class="attention-item grid min-w-0 grid-cols-[minmax(14rem,0.8fr)_minmax(22rem,1.4fr)_auto] items-start gap-4 rounded-xl border border-border-subtle bg-surface-card p-4 max-shell:grid-cols-1 max-shell:gap-3">
                  <div class="attention-title grid min-w-0 gap-2">
                    <p class="item-list-meta m-0 min-w-0 text-sm leading-5 text-text-muted wrap-anywhere">
                      {item.displayReference}・{row.typeText}
                    </p>
                    <h3 class="item-title-with-scores m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 text-lg leading-snug font-bold max-narrow:grid-cols-1 max-narrow:text-base">
                      <span class="attention-score-badges mt-0.5 flex min-h-5 flex-wrap items-start gap-1.5">
                        <AttentionBadge
                          attention={item.attention}
                          showLabel={true}
                          showLow={true}
                          showScore={true}
                        />
                        <ImportanceBadge
                          importance={item.importance}
                          showLabel={true}
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
                        </ItemDetailsLink>{" "}
                        <AiAnalysisNoticeIcon notice={aiAnalysisNotice(item.aiAnalysis.status)} />
                      </span>
                    </h3>
                  </div>
                  <dl class="attention-primary-details m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_8rem] gap-3 max-narrow:gap-2">
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
                  <div class="item-actions grid justify-self-end gap-2 text-sm whitespace-nowrap max-shell:w-full max-shell:justify-self-stretch">
                    <SafeGitHubLink href={item.url} variant="responsive-button">
                      GitHubで開く
                    </SafeGitHubLink>
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
  const attentionItems = sortAttentionItems(props.summary, props.now, props.sort);
  const staleRepositories = props.summary.repositories.filter(
    (repository) => repository.freshness.status === "stale",
  );
  const aiStateNoticeVisible = !props.summary.ai.enabled;
  const statusNoticesVisible = aiStateNoticeVisible || staleRepositories.length > 0;
  return (
    <>
      {statusNoticesVisible && (
        <div class="overview-notices grid gap-2">
          {aiStateNoticeVisible && <AiStateNotice />}
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

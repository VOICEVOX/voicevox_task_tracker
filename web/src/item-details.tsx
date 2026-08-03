import { type ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

import {
  type PublicGraphNodeDto,
  type PublicItemDetailsDto,
  type PublicItemHistoryEventDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import {
  attentionPriority,
  confidencePresentation,
  formatConfidence,
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  severityLabel,
  statusLabel,
  waitingOnHistoryLabel,
  waitingOnLabel,
  type ConfidencePresentation,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";

type ItemDetailsLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
  nodeId: string;
  onSelect: (nodeId: string) => void;
}>;

type ItemDetailsProps = Readonly<{
  clearSelectionHref: string;
  createItemHref: (nodeId: string) => string;
  details: PublicItemDetailsDto;
  graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
  locale: string;
  now: Date;
  onClearSelection: () => void;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
}>;

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];

type SeverityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "severity_changed" }>
>["before"];

type WaitingOnCandidate = PublicItemDetailsDto["summary"]["waitingOn"][number];

const REVIEW_STATE_LABELS = {
  not_applicable: "対象外",
  not_requested: "未依頼",
  requested: "依頼済み",
  changes_requested: "変更要求あり",
  approved: "承認済み",
  unknown: "不明",
} satisfies Readonly<Record<PublicItemDetailsDto["reviewState"], string>>;

const CHECK_STATE_LABELS = {
  not_applicable: "対象外",
  not_required: "不要",
  pending: "実行中",
  passing: "成功",
  failing: "失敗",
  conflict: "競合あり",
  unknown: "不明",
} satisfies Readonly<Record<PublicItemDetailsDto["checkState"], string>>;

const EVIDENCE_SUPPORT_LABELS = {
  status: "状態",
  waiting_on: "waitingOn",
  relation: "依存関係",
  progress: "進捗",
  notification: "通知",
  uncertainty: "不確実性",
} satisfies Readonly<Record<PublicItemDetailsDto["evidence"][number]["supports"], string>>;

/** 項目詳細pageへ遷移し、通常のリンク操作も維持する。 */
export function ItemDetailsLink({ children, href, nodeId, onSelect }: ItemDetailsLinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) {
          return;
        }
        event.preventDefault();
        onSelect(nodeId);
      }}
    >
      {children}
    </a>
  );
}

function confidenceDescription(presentation: ConfidencePresentation): string {
  switch (presentation.level) {
    case "confirmed":
      return "GitHubの確定情報とルールに基づく判定です。";
    case "high_estimate":
      return "確度の高い推定です。根拠からGitHubの情報を確認できます。";
    case "estimate":
      return "推定を含む判定です。根拠からGitHubの情報を確認してください。";
    case "uncertain":
      return "根拠が不足しているため、状態や次の行動は候補として示しています。";
    default:
      throw new UnreachableError(presentation.level);
  }
}

function decisionFieldLabel(label: string, presentation: ConfidencePresentation): string {
  switch (presentation.fieldQualifier) {
    case "":
      return label;
    case "推定":
      return `推定${label}`;
    case "候補":
      return `${label}候補`;
    default:
      throw new UnreachableError(presentation.fieldQualifier);
  }
}

function ConfidenceDisplay({
  confidence,
  locale,
  thresholds,
}: Readonly<{
  confidence: number;
  locale: string;
  thresholds: PublicSummaryDto["confidenceThresholds"];
}>) {
  const presentation = confidencePresentation(confidence, thresholds);
  return (
    <div
      class={`confidence-panel confidence-${presentation.level}`}
      data-confidence-level={presentation.level}
      role="status"
    >
      <strong>
        判定: {presentation.label}・confidence {formatConfidence(confidence, locale)}
      </strong>
      <span>{confidenceDescription(presentation)}</span>
    </div>
  );
}

function DetailTime({
  label,
  locale,
  now,
  timezone,
  value,
}: Readonly<{ label: string; locale: string; now: Date; timezone: string; value: string }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <time dateTime={value}>{formatDateTime(value, timezone, locale)}</time>
        <span class="relative-time">{formatRelativeTime(value, now, locale)}</span>
      </dd>
    </div>
  );
}

function formatResponsibilityHistoryValue(
  value: ResponsibilityHistoryValue,
  item: PublicItemDetailsDto["summary"],
  summary: PublicSummaryDto,
): string {
  if (value.state === "absent") {
    return "記録なし";
  }
  const waitingOn =
    value.value.waitingOn.length === 0
      ? "対応完了"
      : value.value.waitingOn
          .map((candidate) => waitingOnHistoryLabel(candidate, item, summary))
          .join("、");
  return `${statusLabel(value.value.status)}・${waitingOn}`;
}

function formatSeverityHistoryValue(value: SeverityHistoryValue): string {
  return value.state === "absent" ? "記録なし" : severityLabel(value.value);
}

function HistoryEvent({
  event,
  item,
  locale,
  summary,
}: Readonly<{
  event: PublicItemHistoryEventDto;
  item: PublicItemDetailsDto["summary"];
  locale: string;
  summary: PublicSummaryDto;
}>) {
  let label: string;
  let before: string;
  let after: string;
  switch (event.kind) {
    case "responsibility_changed":
      label = "状態とwaitingOnの変更";
      before = formatResponsibilityHistoryValue(event.before, item, summary);
      after = formatResponsibilityHistoryValue(event.after, item, summary);
      break;
    case "severity_changed":
      label = "severityの変更";
      before = formatSeverityHistoryValue(event.before);
      after = formatSeverityHistoryValue(event.after);
      break;
    default:
      throw new UnreachableError(event);
  }
  return (
    <article class="history-event" data-history-kind={event.kind}>
      <div>
        <h4>{label}</h4>
        <time dateTime={event.recordedAt}>
          {formatDateTime(event.recordedAt, summary.timezone, locale)}
        </time>
      </div>
      <p>
        <span>{before}</span>
        <span aria-hidden="true">→</span>
        <span class="visually-hidden">から</span>
        <strong>{after}</strong>
      </p>
      <p class="history-run-id">Run {event.runId}</p>
    </article>
  );
}

function ItemHistory({
  history,
  item,
  locale,
  summary,
}: Readonly<{
  history: readonly PublicItemHistoryEventDto[];
  item: PublicItemDetailsDto["summary"];
  locale: string;
  summary: PublicSummaryDto;
}>) {
  const latestEvent = history.at(-1);
  return (
    <div class="item-history-content">
      {latestEvent == null ? (
        <p>前回から状態、waitingOn、severityに記録された差分はありません。</p>
      ) : (
        <>
          <div class="latest-difference">
            <h4>前回との差分</h4>
            <HistoryEvent event={latestEvent} item={item} locale={locale} summary={summary} />
          </div>
          <details class="history-list">
            <summary>全履歴を表示</summary>
            <ol>
              {[...history].reverse().map((event) => (
                <li key={`${event.runId}:${event.kind}:${event.recordedAt}`}>
                  <HistoryEvent event={event} item={item} locale={locale} summary={summary} />
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </div>
  );
}

function RelatedItemReference({
  createItemHref,
  graphNodesByNodeId,
  itemsByNodeId,
  nodeId,
  onSelectItem,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
  itemsByNodeId: ReadonlyMap<string, PublicItemDetailsDto["summary"]>;
  nodeId: string;
  onSelectItem: (nodeId: string) => void;
}>) {
  const relatedItem = itemsByNodeId.get(nodeId);
  if (relatedItem != null) {
    return (
      <ItemDetailsLink href={createItemHref(nodeId)} nodeId={nodeId} onSelect={onSelectItem}>
        {relatedItem.displayReference} {relatedItem.title}
      </ItemDetailsLink>
    );
  }
  const graphNode = graphNodesByNodeId.get(nodeId);
  assertNonNullable(graphNode, `blocker ${nodeId}の公開graph nodeがありません`);
  if (graphNode.kind !== "external_reference") {
    throw new TypeError(`blocker ${nodeId}の公開項目詳細がありません`);
  }
  return (
    <SafeGitHubLink href={graphNode.url}>
      {graphNode.displayReference} {graphNode.title}
    </SafeGitHubLink>
  );
}

function WaitingOnCandidateReference({
  candidate,
  createItemHref,
  graphNodesByNodeId,
  item,
  itemsByNodeId,
  onSelectItem,
  summary,
}: Readonly<{
  candidate: WaitingOnCandidate;
  createItemHref: (nodeId: string) => string;
  graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
  item: PublicItemDetailsDto["summary"];
  itemsByNodeId: ReadonlyMap<string, PublicItemDetailsDto["summary"]>;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
}>) {
  if (candidate.kind === "item") {
    return (
      <RelatedItemReference
        createItemHref={createItemHref}
        graphNodesByNodeId={graphNodesByNodeId}
        itemsByNodeId={itemsByNodeId}
        nodeId={candidate.candidateId}
        onSelectItem={onSelectItem}
      />
    );
  }
  return <>{waitingOnLabel(candidate, item, summary)}</>;
}

/** 選択した項目の判定根拠と変更履歴を表示する。 */
export function ItemDetailsContent({
  clearSelectionHref,
  createItemHref,
  details,
  graphNodesByNodeId,
  locale,
  now,
  onClearSelection,
  onSelectItem,
  summary,
}: ItemDetailsProps) {
  const item = details.summary;
  const heading = useRef<HTMLHeadingElement>(null);
  const presentation = confidencePresentation(item.confidence, summary.confidenceThresholds);
  const itemsByNodeId = new Map(
    summary.items.map((summaryItem) => [summaryItem.nodeId, summaryItem]),
  );
  let primaryBlockerNodeId: string | undefined;
  if (item.status === "blocked") {
    if (item.primaryWaitingOn.index !== 0) {
      throw new TypeError(`block中の項目 ${item.nodeId}にprimary blockerがありません`);
    }
    const primaryWaitingOn = item.waitingOn[0];
    assertNonNullable(primaryWaitingOn, `項目 ${item.nodeId}のprimary waitingOnがありません`);
    if (
      primaryWaitingOn.kind !== "item" ||
      !item.blockerNodeIds.includes(primaryWaitingOn.candidateId)
    ) {
      throw new TypeError(`項目 ${item.nodeId}のprimary blockerがblocker一覧にありません`);
    }
    primaryBlockerNodeId = primaryWaitingOn.candidateId;
  }
  const waitingOnBlockerNodeIds = new Set(
    item.waitingOn.flatMap((candidate) =>
      candidate.kind === "item" && item.blockerNodeIds.includes(candidate.candidateId)
        ? [candidate.candidateId]
        : [],
    ),
  );
  const additionalBlockerNodeIds = item.blockerNodeIds.filter(
    (nodeId) => !waitingOnBlockerNodeIds.has(nodeId),
  );
  const timestampFields = [
    {
      label: "作成",
      value: details.timestamps.createdAt,
    },
    {
      label: "GitHub更新",
      value: details.timestamps.githubUpdatedAt,
    },
    {
      label: "最終human activity",
      value: details.timestamps.lastHumanActivityAt,
    },
    {
      label: "最終進捗",
      value: details.timestamps.lastProgressAt,
    },
    {
      label: "現在statusの開始",
      value: details.timestamps.statusSince,
    },
    {
      label: "現在waitingOnの開始",
      value: details.timestamps.ownerSince,
    },
    {
      label: "停滞開始",
      value: details.timestamps.stallSince,
    },
    {
      label: "項目観測",
      value: details.timestamps.observedAt,
    },
  ];
  useEffect(() => {
    heading.current?.focus();
  }, [item.nodeId]);

  return (
    <article class="item-details-card" data-node-id={item.nodeId}>
      <div class="item-details-heading">
        <div>
          <p class="item-reference">{item.displayReference}</p>
          <h3 ref={heading} tabIndex={-1}>
            {item.title}
          </h3>
        </div>
        <div class="item-details-actions">
          <SafeGitHubLink href={item.url}>GitHubで項目を開く</SafeGitHubLink>
          <a
            href={clearSelectionHref}
            onClick={(event) => {
              if (!shouldHandleClientNavigation(event)) {
                return;
              }
              event.preventDefault();
              onClearSelection();
            }}
          >
            一覧へ戻る
          </a>
        </div>
      </div>

      <section aria-labelledby="current-action-heading" class="current-action-panel">
        <div class="current-action-heading">
          <p class="eyebrow">Current action</p>
          <h3 id="current-action-heading">現在の状況と次の行動</h3>
        </div>
        <dl class="current-state-grid">
          <div>
            <dt>{decisionFieldLabel("現在のstatus", presentation)}</dt>
            <dd>
              <strong>{statusLabel(item.status)}</strong>
              <span class={`severity-badge severity-${item.severity}`}>
                {severityLabel(item.severity)}
              </span>
            </dd>
          </div>
          <div>
            <dt>停滞</dt>
            <dd>
              <strong>{formatStallDuration(item.stallSince, now)}</strong>
              <span>
                <time dateTime={item.stallSince}>
                  {formatDateTime(item.stallSince, summary.timezone, locale)}
                </time>
                から
              </span>
            </dd>
          </div>
        </dl>

        <div class="current-responsibility">
          <h4 id="item-waiting-on-heading">
            {decisionFieldLabel("次の担当", presentation)}
            <span>waitingOn</span>
          </h4>
          {item.waitingOn.length === 0 ? (
            <p>対応完了</p>
          ) : (
            <ul class="waiting-on-list">
              {item.waitingOn.map((candidate, index) => (
                <li key={`${candidate.kind}:${candidate.candidateId}:${candidate.role}`}>
                  <div>
                    <strong>
                      <WaitingOnCandidateReference
                        candidate={candidate}
                        createItemHref={createItemHref}
                        graphNodesByNodeId={graphNodesByNodeId}
                        item={item}
                        itemsByNodeId={itemsByNodeId}
                        onSelectItem={onSelectItem}
                        summary={summary}
                      />
                    </strong>
                    {primaryBlockerNodeId === candidate.candidateId &&
                      item.primaryWaitingOn.index === index && (
                        <span class="primary-blocker-badge">主要blocker</span>
                      )}
                  </div>
                  <p>{candidate.reasonSummary}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div class="next-action-card">
          <h4>{decisionFieldLabel("次の行動", presentation)}</h4>
          <p class={presentation.level === "uncertain" ? "uncertain-value" : ""}>
            {item.nextAction}
          </p>
        </div>

        {additionalBlockerNodeIds.length > 0 && (
          <div class="additional-blockers">
            <h4>その他のblocker</h4>
            <ul class="blocker-list">
              {additionalBlockerNodeIds.map((nodeId) => (
                <li key={nodeId}>
                  <RelatedItemReference
                    createItemHref={createItemHref}
                    graphNodesByNodeId={graphNodesByNodeId}
                    itemsByNodeId={itemsByNodeId}
                    nodeId={nodeId}
                    onSelectItem={onSelectItem}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <details class="detail-disclosure decision-details">
        <summary>
          <span>判定情報</span>
          <span>confidenceとsource ID</span>
        </summary>
        <div class="detail-disclosure-content">
          <ConfidenceDisplay
            confidence={item.confidence}
            locale={locale}
            thresholds={summary.confidenceThresholds}
          />
          {item.waitingOn.length > 0 && (
            <div class="candidate-decision-details">
              <h4>waitingOn候補の判定情報</h4>
              <ol class="decision-candidate-list">
                {item.waitingOn.map((candidate) => {
                  const candidatePresentation = confidencePresentation(
                    candidate.confidence,
                    summary.confidenceThresholds,
                  );
                  return (
                    <li key={`${candidate.kind}:${candidate.candidateId}:${candidate.role}`}>
                      <strong>
                        <WaitingOnCandidateReference
                          candidate={candidate}
                          createItemHref={createItemHref}
                          graphNodesByNodeId={graphNodesByNodeId}
                          item={item}
                          itemsByNodeId={itemsByNodeId}
                          onSelectItem={onSelectItem}
                          summary={summary}
                        />
                      </strong>
                      <dl>
                        <div>
                          <dt>確度区分</dt>
                          <dd>{candidatePresentation.label}</dd>
                        </div>
                        <div>
                          <dt>confidence</dt>
                          <dd>{formatConfidence(candidate.confidence, locale)}</dd>
                        </div>
                        <div>
                          <dt>candidate ID</dt>
                          <dd class="source-id-list">{candidate.candidateId}</dd>
                        </div>
                        <div>
                          <dt>source ID</dt>
                          <dd class="source-id-list">{candidate.sourceIds.join("、")}</dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {primaryBlockerNodeId != null && (
            <div class="primary-selection-reason">
              <h4>primary blockerの選定理由</h4>
              <p>{item.primaryWaitingOn.selectionReason}</p>
            </div>
          )}
        </div>
      </details>

      <details class="detail-disclosure timestamp-details">
        <summary>
          <span>各種時刻</span>
          <span>{timestampFields.length.toString()}件</span>
        </summary>
        <div class="detail-disclosure-content">
          <dl class="timestamp-grid">
            {timestampFields.map((field) => (
              <DetailTime
                key={field.label}
                label={field.label}
                value={field.value}
                now={now}
                timezone={summary.timezone}
                locale={locale}
              />
            ))}
          </dl>
        </div>
      </details>

      <details class="detail-disclosure evidence-details">
        <summary>
          <span>判定根拠</span>
          <span>{details.evidence.length.toString()}件</span>
        </summary>
        <div class="detail-disclosure-content">
          {details.evidence.length === 0 ? (
            <p>公開できる判定根拠はありません。</p>
          ) : (
            <ol class="evidence-list">
              {details.evidence.map((evidence) => (
                <li key={`${evidence.sourceId}:${evidence.supports}`}>
                  <div>
                    <span>{EVIDENCE_SUPPORT_LABELS[evidence.supports]}</span>
                    <code>{evidence.sourceId}</code>
                  </div>
                  <p>{evidence.summary}</p>
                  <SafeGitHubLink href={evidence.sourceUrl}>GitHub上の根拠を開く</SafeGitHubLink>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>

      <details class="detail-disclosure context-details">
        <summary>
          <span>補足情報</span>
          <span>GitHub、review、ラベルなど</span>
        </summary>
        <div class="detail-disclosure-content">
          <dl class="detail-context-grid">
            <div>
              <dt>種別</dt>
              <dd>{item.type === "issue" ? "Issue" : "Pull Request"}</dd>
            </div>
            <div>
              <dt>GitHub上の状態</dt>
              <dd>{item.state}</dd>
            </div>
            <div>
              <dt>review</dt>
              <dd>{REVIEW_STATE_LABELS[details.reviewState]}</dd>
            </div>
            <div>
              <dt>checks</dt>
              <dd>{CHECK_STATE_LABELS[details.checkState]}</dd>
            </div>
            <div>
              <dt>対応優先度</dt>
              <dd>{attentionPriority(item).label}</dd>
            </div>
            <div>
              <dt>ラベル</dt>
              <dd>{details.labels.length === 0 ? "なし" : details.labels.join("、")}</dd>
            </div>
            <div>
              <dt>assignee</dt>
              <dd>
                {item.assignees.length === 0
                  ? "なし"
                  : item.assignees.map((assignee) => `@${assignee.login}`).join("、")}
              </dd>
            </div>
          </dl>
          {details.uncertainties.length > 0 && (
            <div class="uncertainty-list">
              <h4>不確実な点</h4>
              <ul>
                {details.uncertainties.map((uncertainty) => (
                  <li key={uncertainty}>{uncertainty}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>

      <details class="detail-disclosure history-details">
        <summary>
          <span>前回との差分と履歴</span>
          <span>{details.history.length.toString()}件</span>
        </summary>
        <div class="detail-disclosure-content">
          <ItemHistory history={details.history} item={item} locale={locale} summary={summary} />
        </div>
      </details>
    </article>
  );
}

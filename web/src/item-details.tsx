import { type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  type PublicGraphNodeDto,
  type PublicItemDetailsDto,
  type PublicItemHistoryEventDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import { DependencyGraphDiagram } from "./dependency-graph-diagram.js";
import { type ItemGraphView } from "./graph-model.js";
import { ImportanceBadge } from "./importance-badge.js";
import {
  confidencePresentation,
  formatDateTime,
  formatRelativeTime,
  formatStallDuration,
  isAiAnalysisDegraded,
  statusLabel,
  waitingOnHistoryLabel,
  waitingOnLabel,
  type ConfidencePresentation,
} from "./model.js";
import { SafeGitHubLink } from "./safe-link.js";
import { ActionButton, Pill } from "./ui.js";

type ItemDetailsLinkProps = Readonly<{
  children: ComponentChildren;
  href: string;
  nodeId: string;
  onSelect: (nodeId: string) => void;
}>;

type ItemDetailsProps = Readonly<{
  clearSelectionHref: string;
  createItemHref: (nodeId: string) => string;
  dependencyGraphView: ItemGraphView;
  details: PublicItemDetailsDto;
  graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
  locale: string;
  now: Date;
  onClearSelection: () => void;
  onSelectItem: (nodeId: string) => void;
  showHeadingFocusRing: boolean;
  summary: PublicSummaryDto;
}>;

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];

type WaitingOnCandidate = PublicItemDetailsDto["summary"]["waitingOn"][number];
type ImportanceFactor = PublicItemDetailsDto["importanceFactors"][number];

type ImportanceFactorSource = Readonly<{
  kind: "deterministic" | "codex";
  label: string;
  tone: "success" | "high";
}>;

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

const IMPORTANCE_FACTOR_LABELS = {
  priorityLabel: "優先度ラベル",
  downstreamImpact: "依存先への影響",
  milestoneDeadline: "マイルストーン期限",
  significantFeature: "重要な機能",
  explicitDeadline: "明示された期限",
  futureRisk: "将来リスク",
} satisfies Readonly<Record<ImportanceFactor["kind"], string>>;

const HISTORY_PREVIEW_LIMIT = 5;
const WAITING_ON_LIST_CLASS_NAME = "waiting-on-list m-0 grid list-none gap-3 p-0";
const CONFIDENCE_LEVEL_CLASS_NAMES = {
  confirmed: "border-state-success-border bg-state-success-background text-state-success-text",
  high_estimate: "border-state-info-border bg-state-info-background text-state-info-text",
  estimate: "border-state-warning-border bg-state-warning-background text-state-warning-text",
  uncertain: "border-state-danger-border bg-state-danger-background text-state-danger-text",
} satisfies Readonly<Record<ConfidencePresentation["level"], string>>;
const DISCLOSURE_SUMMARY_CLASS_NAME =
  "grid min-h-12 cursor-pointer list-none grid-cols-[0.75rem_minmax(0,1fr)] items-start gap-x-2 py-3 text-text-secondary marker:content-none before:mt-0.5 before:text-text-muted before:content-['▸'] group-open:before:content-['▾'] [&::-webkit-details-marker]:hidden";
const DISCLOSURE_HEADING_CLASS_NAME =
  "m-0 flex min-w-0 items-baseline justify-between gap-x-4 gap-y-1 text-base font-bold max-narrow:flex-col";

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

function importanceFactorSource(kind: ImportanceFactor["kind"]): ImportanceFactorSource {
  switch (kind) {
    case "priorityLabel":
    case "downstreamImpact":
    case "milestoneDeadline":
      return {
        kind: "deterministic",
        label: "決定論",
        tone: "success",
      };
    case "significantFeature":
    case "explicitDeadline":
    case "futureRisk":
      return {
        kind: "codex",
        label: "Codex判定",
        tone: "high",
      };
    default:
      throw new UnreachableError(kind);
  }
}

function ConfidenceDisplay({
  presentation,
}: Readonly<{
  presentation: ConfidencePresentation;
}>) {
  return (
    <div
      class={`confidence-panel confidence-${presentation.level} grid gap-1 rounded-md border-l-4 px-3 py-2 text-sm ${CONFIDENCE_LEVEL_CLASS_NAMES[presentation.level]}`}
      data-confidence-level={presentation.level}
      role="status"
    >
      <strong>判定: {presentation.label}</strong>
      <span>{confidenceDescription(presentation)}</span>
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

function HistoryEvent({
  event,
  item,
  locale,
  now,
  summary,
}: Readonly<{
  event: PublicItemHistoryEventDto;
  item: PublicItemDetailsDto["summary"];
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
}>) {
  const before = formatResponsibilityHistoryValue(event.before, item, summary);
  const after = formatResponsibilityHistoryValue(event.after, item, summary);
  return (
    <article class="history-event grid gap-2 py-3" data-history-kind={event.kind}>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h5 class="m-0 font-bold">状態と次の担当の変更</h5>
        <time
          class="text-xs text-text-muted"
          dateTime={event.recordedAt}
          title={formatDateTime(event.recordedAt, summary.timezone, locale)}
        >
          {formatRelativeTime(event.recordedAt, now, locale)}
        </time>
      </div>
      <p class="m-0 flex flex-wrap gap-2">
        <span>{before}</span>
        <span aria-hidden="true">→</span>
        <span class="visually-hidden sr-only">から</span>
        <strong>{after}</strong>
      </p>
    </article>
  );
}

function ItemHistory({
  history,
  item,
  locale,
  now,
  summary,
}: Readonly<{
  history: readonly PublicItemHistoryEventDto[];
  item: PublicItemDetailsDto["summary"];
  locale: string;
  now: Date;
  summary: PublicSummaryDto;
}>) {
  const [showAll, setShowAll] = useState(false);
  const newestFirstHistory = [...history].reverse();
  const visibleHistory = showAll
    ? newestFirstHistory
    : newestFirstHistory.slice(0, HISTORY_PREVIEW_LIMIT);
  return (
    <div class="item-history-content">
      {history.length === 0 ? (
        <p class="m-0">状態と次の担当の変更履歴はありません。</p>
      ) : (
        <>
          <ol class="history-list m-0 grid list-none divide-y divide-border-subtle p-0">
            {visibleHistory.map((event, index) => (
              <li key={`${event.kind}:${event.recordedAt}:${index.toString()}`}>
                <HistoryEvent
                  event={event}
                  item={item}
                  locale={locale}
                  now={now}
                  summary={summary}
                />
              </li>
            ))}
          </ol>
          {history.length > HISTORY_PREVIEW_LIMIT && (
            <ActionButton
              aria-expanded={showAll}
              className="history-expand-button mt-3"
              type="button"
              onClick={() => {
                setShowAll((current) => !current);
              }}
            >
              {showAll ? "最新5件のみ表示" : "すべての履歴を表示"}
            </ActionButton>
          )}
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
    <SafeGitHubLink href={graphNode.url} variant="inline">
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

function WaitingOnCandidateItem({
  candidate,
  candidateIndex,
  createItemHref,
  graphNodesByNodeId,
  item,
  itemsByNodeId,
  onSelectItem,
  primaryBlockerNodeId,
  summary,
}: Readonly<{
  candidate: WaitingOnCandidate;
  candidateIndex: number;
  createItemHref: (nodeId: string) => string;
  graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
  item: PublicItemDetailsDto["summary"];
  itemsByNodeId: ReadonlyMap<string, PublicItemDetailsDto["summary"]>;
  onSelectItem: (nodeId: string) => void;
  primaryBlockerNodeId: string | undefined;
  summary: PublicSummaryDto;
}>) {
  const candidatePresentation = confidencePresentation(
    candidate.confidence,
    summary.confidenceThresholds,
  );
  return (
    <li class="min-w-0 border-l-2 border-border-default pl-3">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong class="min-w-0 wrap-anywhere">
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
          item.primaryWaitingOn.index === candidateIndex && (
            <Pill className="primary-blocker-badge" tone="danger">
              主要ブロッカー
            </Pill>
          )}
        <small class="waiting-on-confidence text-xs font-bold text-text-muted whitespace-nowrap">
          確度区分: {candidatePresentation.label}
        </small>
      </div>
      <p class="mt-1 mb-0 text-sm text-text-secondary">{candidate.reasonSummary}</p>
    </li>
  );
}

function WaitingOnCandidates({
  createItemHref,
  graphNodesByNodeId,
  item,
  itemsByNodeId,
  onSelectItem,
  primaryBlockerNodeId,
  summary,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
  item: PublicItemDetailsDto["summary"];
  itemsByNodeId: ReadonlyMap<string, PublicItemDetailsDto["summary"]>;
  onSelectItem: (nodeId: string) => void;
  primaryBlockerNodeId: string | undefined;
  summary: PublicSummaryDto;
}>) {
  if (item.waitingOn.length === 0) {
    throw new TypeError(`項目 ${item.nodeId}のwaitingOn候補がありません`);
  }
  const candidates = item.waitingOn.map((candidate, index) => ({ candidate, index }));
  if (candidates.length < 4) {
    return (
      <ul class={WAITING_ON_LIST_CLASS_NAME}>
        {candidates.map(({ candidate, index }) => (
          <WaitingOnCandidateItem
            key={`${candidate.kind}:${candidate.candidateId}:${candidate.role}`}
            candidate={candidate}
            candidateIndex={index}
            createItemHref={createItemHref}
            graphNodesByNodeId={graphNodesByNodeId}
            item={item}
            itemsByNodeId={itemsByNodeId}
            onSelectItem={onSelectItem}
            primaryBlockerNodeId={primaryBlockerNodeId}
            summary={summary}
          />
        ))}
      </ul>
    );
  }

  const primaryIndex =
    item.primaryWaitingOn.index === "not_applicable" ? 0 : item.primaryWaitingOn.index;
  const primaryCandidate = candidates[primaryIndex] ?? candidates[0];
  assertNonNullable(primaryCandidate, `項目 ${item.nodeId}の主候補がありません`);
  const otherCandidates = candidates.filter(({ index }) => index !== primaryCandidate.index);
  return (
    <>
      <ul class={`${WAITING_ON_LIST_CLASS_NAME} primary-waiting-on-list`}>
        <WaitingOnCandidateItem
          candidate={primaryCandidate.candidate}
          candidateIndex={primaryCandidate.index}
          createItemHref={createItemHref}
          graphNodesByNodeId={graphNodesByNodeId}
          item={item}
          itemsByNodeId={itemsByNodeId}
          onSelectItem={onSelectItem}
          primaryBlockerNodeId={primaryBlockerNodeId}
          summary={summary}
        />
      </ul>
      <details class="other-waiting-on-candidates mt-3">
        <summary class="min-h-11 cursor-pointer py-2 text-sm font-bold text-text-secondary marker:text-text-muted">
          その他の候補{otherCandidates.length.toLocaleString()}件を表示
        </summary>
        <ul class={`${WAITING_ON_LIST_CLASS_NAME} mt-3`}>
          {otherCandidates.map(({ candidate, index }) => (
            <WaitingOnCandidateItem
              key={`${candidate.kind}:${candidate.candidateId}:${candidate.role}`}
              candidate={candidate}
              candidateIndex={index}
              createItemHref={createItemHref}
              graphNodesByNodeId={graphNodesByNodeId}
              item={item}
              itemsByNodeId={itemsByNodeId}
              onSelectItem={onSelectItem}
              primaryBlockerNodeId={primaryBlockerNodeId}
              summary={summary}
            />
          ))}
        </ul>
      </details>
    </>
  );
}

function hasItemDependencies(view: ItemGraphView): boolean {
  return view.sourceEdges.length > 0 || view.omittedSourceNodeCount > 0;
}

/** 選択した項目の判定根拠と変更履歴を表示する。 */
export function ItemDetailsContent({
  clearSelectionHref,
  createItemHref,
  dependencyGraphView,
  details,
  graphNodesByNodeId,
  locale,
  now,
  onClearSelection,
  onSelectItem,
  showHeadingFocusRing,
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
  useEffect(() => {
    heading.current?.focus({ focusVisible: showHeadingFocusRing });
  }, [item.nodeId, showHeadingFocusRing]);

  return (
    <article class="item-details-card grid min-w-0 gap-6" data-node-id={item.nodeId}>
      <div class="item-details-heading flex min-w-0 items-start justify-between gap-4 max-shell:flex-col">
        <div class="min-w-0">
          <p class="item-reference m-0 text-sm leading-5 text-text-muted">
            {item.displayReference}
          </p>
          <h3
            class="mt-1 mb-0 text-item-title leading-tight font-bold wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-focus-ring"
            ref={heading}
            tabIndex={-1}
          >
            {item.title}
          </h3>
        </div>
        <div class="item-details-actions flex flex-wrap justify-end gap-x-4 gap-y-2 max-shell:justify-start">
          <SafeGitHubLink href={item.url} variant="action">
            GitHubで開く
          </SafeGitHubLink>
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

      {isAiAnalysisDegraded(item.aiAnalysis.status) && (
        <p
          class="ai-analysis-notice m-0 rounded-md border-l-4 border-state-warning-border bg-state-warning-background px-4 py-3 text-sm leading-5 text-state-warning-text"
          role="status"
        >
          AI判定を利用できなかったため、確定ルールで表示しています。
        </p>
      )}

      <section
        aria-labelledby="current-action-heading"
        class="current-action-panel grid min-w-0 gap-5 border-t border-border-subtle pt-5 lg:grid-cols-2"
      >
        <div class="current-action-heading lg:col-span-2">
          <h4 id="current-action-heading" class="m-0 text-subsection-title leading-snug font-bold">
            現在の状況と次の行動
          </h4>
        </div>
        <dl class="current-state-grid m-0 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-4 gap-y-3 lg:col-span-2">
          <div class="min-w-0 border-l-2 border-border-default pl-3">
            <dt class="text-xs font-bold text-text-muted">
              {decisionFieldLabel("現在の状態", presentation)}
            </dt>
            <dd class="mt-1 mb-0 grid justify-items-start gap-1">
              <strong class="text-lg text-text-primary">{statusLabel(item.status)}</strong>
            </dd>
          </div>
          <div class="min-w-0 border-l-2 border-border-default pl-3">
            <dt class="text-xs font-bold text-text-muted">重要度</dt>
            <dd class="mt-1 mb-0 grid justify-items-start gap-1">
              <ImportanceBadge importance={item.importance} showLow={true} showScore={true} />
              <span class="text-xs text-text-muted">項目自体の重要さ</span>
            </dd>
          </div>
          <div class="min-w-0 border-l-2 border-border-default pl-3">
            <dt class="text-xs font-bold text-text-muted">停滞時間</dt>
            <dd class="mt-1 mb-0 grid justify-items-start gap-1">
              <strong class="text-lg text-text-primary">
                <time
                  dateTime={item.stallSince}
                  title={formatDateTime(item.stallSince, summary.timezone, locale)}
                >
                  {formatStallDuration(item.stallSince, now)}
                </time>
              </strong>
              <span class="text-xs text-text-muted">停滞開始からの経過</span>
            </dd>
          </div>
          {item.type === "pull_request" && (
            <>
              <div class="min-w-0 border-l-2 border-border-default pl-3">
                <dt class="text-xs font-bold text-text-muted">レビュー</dt>
                <dd class="mt-1 mb-0 grid justify-items-start gap-1">
                  <strong class="text-lg text-text-primary">
                    {REVIEW_STATE_LABELS[details.reviewState]}
                  </strong>
                </dd>
              </div>
              <div class="min-w-0 border-l-2 border-border-default pl-3">
                <dt class="text-xs font-bold text-text-muted">チェック</dt>
                <dd class="mt-1 mb-0 grid justify-items-start gap-1">
                  <strong class="text-lg text-text-primary">
                    {CHECK_STATE_LABELS[details.checkState]}
                  </strong>
                </dd>
              </div>
            </>
          )}
        </dl>

        <div class="current-responsibility min-w-0">
          <h5 id="item-waiting-on-heading" class="mt-0 mb-3 text-base font-bold">
            {decisionFieldLabel("次の担当", presentation)}
          </h5>
          {item.waitingOn.length === 0 ? (
            <p class="m-0">対応完了</p>
          ) : (
            <WaitingOnCandidates
              createItemHref={createItemHref}
              graphNodesByNodeId={graphNodesByNodeId}
              item={item}
              itemsByNodeId={itemsByNodeId}
              onSelectItem={onSelectItem}
              primaryBlockerNodeId={primaryBlockerNodeId}
              summary={summary}
            />
          )}
        </div>

        <div class="next-action-card min-w-0 border-l-2 border-state-info-border pl-3">
          <h5 class="mt-0 mb-3 text-base font-bold">
            {decisionFieldLabel("次の行動", presentation)}
          </h5>
          <p
            class={
              presentation.level === "uncertain"
                ? "uncertain-value m-0 rounded-md border-2 border-dashed border-state-danger-border bg-state-danger-background p-3 text-lg font-bold text-text-primary"
                : "m-0 text-lg font-bold text-text-primary"
            }
          >
            {item.nextAction}
          </p>
        </div>

        {additionalBlockerNodeIds.length > 0 && (
          <div class="additional-blockers min-w-0 lg:col-span-2">
            <h5 class="mt-0 mb-3 text-base font-bold">その他のブロッカー</h5>
            <ul class="blocker-list m-0 grid list-none gap-2 p-0">
              {additionalBlockerNodeIds.map((nodeId) => (
                <li
                  class="min-w-0 border-l-4 border-state-danger-border py-1 pl-3 wrap-anywhere"
                  key={nodeId}
                >
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

      {hasItemDependencies(dependencyGraphView) && (
        <section
          aria-labelledby="item-dependency-graph-heading"
          class="item-dependency-graph grid min-w-0 gap-3 border-t border-border-subtle pt-5"
        >
          <h4
            id="item-dependency-graph-heading"
            class="item-dependency-graph-heading m-0 text-subsection-title leading-snug font-bold"
          >
            依存関係
          </h4>
          <p class="graph-selection-summary m-0 text-sm text-text-secondary" aria-live="polite">
            {`この項目と現在有効な依存関係で直接つながる項目だけを、中心項目を含めて${dependencyGraphView.representedSourceNodeCount.toLocaleString(locale)}件表示します。${
              dependencyGraphView.omittedSourceNodeCount > 0
                ? `表示上限外の隣接項目が${dependencyGraphView.omittedSourceNodeCount.toLocaleString(locale)}件あります。`
                : ""
            }`}
          </p>
          <DependencyGraphDiagram
            description={`${item.displayReference}を中心項目として示します。`}
            idPrefix="item-dependency-graph"
            navigation={{
              status: "item_details",
              createItemHref,
              onSelectItem,
            }}
            title={`${item.displayReference}を中心にした依存グラフ`}
            view={dependencyGraphView}
          />
        </section>
      )}

      <details class="detail-disclosure decision-details group border-t border-border-subtle">
        <summary class={DISCLOSURE_SUMMARY_CLASS_NAME}>
          <h4 class={DISCLOSURE_HEADING_CLASS_NAME}>
            <span>判定の根拠</span>
            <span class="text-xs font-semibold text-text-muted">
              確度、重要度の加点、状態と行動の根拠
            </span>
          </h4>
        </summary>
        <div class="detail-disclosure-content grid gap-4 pb-4">
          <ConfidenceDisplay presentation={presentation} />
          {details.uncertainties.length > 0 && (
            <div class="uncertainty-list rounded-md border border-state-danger-border bg-state-danger-background p-3 text-state-danger-text">
              <h5 class="m-0 font-bold">不確実な点</h5>
              <ul class="mt-2 mb-0 list-disc pl-6">
                {details.uncertainties.map((uncertainty) => (
                  <li key={uncertainty}>{uncertainty}</li>
                ))}
              </ul>
            </div>
          )}
          {primaryBlockerNodeId != null && (
            <div class="primary-selection-reason border-l-4 border-border-strong bg-surface-sunken py-2 pl-3">
              <h5 class="mt-0 mb-2 text-base font-bold">主要ブロッカーの選定理由</h5>
              <p class="m-0">{item.primaryWaitingOn.selectionReason}</p>
            </div>
          )}
          <section class="importance-evidence" aria-labelledby="importance-evidence-heading">
            <h5 id="importance-evidence-heading" class="mt-0 mb-3 text-base font-bold">
              重要度の加点内訳
            </h5>
            {details.importanceFactors.length === 0 ? (
              <p class="m-0 text-sm text-text-muted">重要度の加点要因はありません。</p>
            ) : (
              <ol class="importance-factor-list m-0 grid list-none divide-y divide-border-subtle p-0">
                {details.importanceFactors.map((factor) => {
                  const source = importanceFactorSource(factor.kind);
                  return (
                    <li class="py-3" key={factor.kind}>
                      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <Pill
                          className={`importance-factor-source source-${source.kind}`}
                          tone={source.tone}
                        >
                          {source.label}
                        </Pill>
                        <code>{IMPORTANCE_FACTOR_LABELS[factor.kind]}</code>
                        <strong class="ml-auto text-importance-high-text tabular-nums">
                          +{factor.points.toLocaleString(locale)}点
                        </strong>
                      </div>
                      <p class="mt-1 mb-0">{factor.detail}</p>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
          <section class="decision-evidence" aria-labelledby="decision-evidence-heading">
            <h5 id="decision-evidence-heading" class="mt-0 mb-3 text-base font-bold">
              状態と次の行動の根拠
            </h5>
            {details.evidence.length === 0 ? (
              <p class="m-0">公開できる判定根拠はありません。</p>
            ) : (
              <ol class="evidence-list m-0 grid list-none divide-y divide-border-subtle p-0">
                {details.evidence.map((evidence, index) => (
                  <li class="py-3" key={`${evidence.sourceUrl}:${index.toString()}`}>
                    <p class="mt-0 mb-2">{evidence.summary}</p>
                    <SafeGitHubLink href={evidence.sourceUrl} variant="inline">
                      GitHub上の根拠を開く
                    </SafeGitHubLink>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </details>

      <details class="detail-disclosure history-details group border-t border-border-subtle">
        <summary class={DISCLOSURE_SUMMARY_CLASS_NAME}>
          <h4 class={DISCLOSURE_HEADING_CLASS_NAME}>
            <span>履歴</span>
            <span class="text-xs font-semibold text-text-muted">
              {details.history.length.toString()}件
            </span>
          </h4>
        </summary>
        <div class="detail-disclosure-content pb-4">
          <ItemHistory
            key={item.nodeId}
            history={details.history}
            item={item}
            locale={locale}
            now={now}
            summary={summary}
          />
        </div>
      </details>
    </article>
  );
}

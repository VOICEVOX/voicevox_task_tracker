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
  milestoneDeadline: "milestone期限",
  significantFeature: "重要な機能",
  explicitDeadline: "明示された期限",
  futureRisk: "将来リスク",
} satisfies Readonly<Record<ImportanceFactor["kind"], string>>;

const HISTORY_PREVIEW_LIMIT = 5;

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
      class={`confidence-panel confidence-${presentation.level}`}
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
    <article class="history-event" data-history-kind={event.kind}>
      <div>
        <h4>状態とwaitingOnの変更</h4>
        <time
          dateTime={event.recordedAt}
          title={formatDateTime(event.recordedAt, summary.timezone, locale)}
        >
          {formatRelativeTime(event.recordedAt, now, locale)}
        </time>
      </div>
      <p>
        <span>{before}</span>
        <span aria-hidden="true">→</span>
        <span class="visually-hidden">から</span>
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
        <p>状態とwaitingOnの変更履歴はありません。</p>
      ) : (
        <>
          <ol class="history-list">
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
              className="history-expand-button"
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
    <li>
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
          item.primaryWaitingOn.index === candidateIndex && (
            <Pill className="primary-blocker-badge" tone="danger">
              主要blocker
            </Pill>
          )}
        <small class="waiting-on-confidence">確度区分: {candidatePresentation.label}</small>
      </div>
      <p>{candidate.reasonSummary}</p>
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
      <ul class="waiting-on-list">
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
      <ul class="waiting-on-list primary-waiting-on-list">
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
      <details class="other-waiting-on-candidates">
        <summary>その他の候補{otherCandidates.length.toLocaleString()}件を表示</summary>
        <ul class="waiting-on-list">
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
          <h3 id="current-action-heading">現在の状況と次の行動</h3>
        </div>
        <dl class="current-state-grid">
          <div>
            <dt>{decisionFieldLabel("現在のstatus", presentation)}</dt>
            <dd>
              <strong>{statusLabel(item.status)}</strong>
            </dd>
          </div>
          <div>
            <dt>重要度</dt>
            <dd>
              <ImportanceBadge importance={item.importance} showLow={true} showScore={true} />
              <span>項目自体の重要さ</span>
            </dd>
          </div>
          <div>
            <dt>停滞時間</dt>
            <dd>
              <strong>
                <time
                  dateTime={item.stallSince}
                  title={formatDateTime(item.stallSince, summary.timezone, locale)}
                >
                  {formatStallDuration(item.stallSince, now)}
                </time>
              </strong>
              <span>停滞開始からの経過</span>
            </dd>
          </div>
          {item.type === "pull_request" && (
            <>
              <div>
                <dt>review</dt>
                <dd>
                  <strong>{REVIEW_STATE_LABELS[details.reviewState]}</strong>
                </dd>
              </div>
              <div>
                <dt>checks</dt>
                <dd>
                  <strong>{CHECK_STATE_LABELS[details.checkState]}</strong>
                </dd>
              </div>
            </>
          )}
        </dl>

        <div class="current-responsibility">
          <h4 id="item-waiting-on-heading">
            {decisionFieldLabel("次の担当", presentation)}
            <span>waitingOn</span>
          </h4>
          {item.waitingOn.length === 0 ? (
            <p>対応完了</p>
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

      {hasItemDependencies(dependencyGraphView) && (
        <section aria-labelledby="item-dependency-graph-heading" class="item-dependency-graph">
          <h3 id="item-dependency-graph-heading" class="item-dependency-graph-heading">
            依存関係
          </h3>
          <p class="graph-selection-summary" aria-live="polite">
            {`この項目と現在有効な依存関係で直接つながる項目だけを、中心項目を含めて${dependencyGraphView.representedSourceNodeCount.toLocaleString(locale)}件表示します。${
              dependencyGraphView.omittedSourceNodeCount > 0
                ? `表示上限外の隣接項目が${dependencyGraphView.omittedSourceNodeCount.toLocaleString(locale)}件あります。`
                : ""
            }`}
          </p>
          <DependencyGraphDiagram
            description={`${item.displayReference}を中心項目として示します。矢印は依存関係の始点から終点へ向き、ブロック関係はブロック元からブロックされる項目へ向きます。`}
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

      <details class="detail-disclosure decision-details">
        <summary>
          <span>判定の根拠</span>
          <span>確度、重要度の加点、状態と行動の根拠</span>
        </summary>
        <div class="detail-disclosure-content">
          <ConfidenceDisplay presentation={presentation} />
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
          {primaryBlockerNodeId != null && (
            <div class="primary-selection-reason">
              <h4>primary blockerの選定理由</h4>
              <p>{item.primaryWaitingOn.selectionReason}</p>
            </div>
          )}
          <section class="importance-evidence" aria-labelledby="importance-evidence-heading">
            <h4 id="importance-evidence-heading">重要度の加点内訳</h4>
            {details.importanceFactors.length === 0 ? (
              <p>重要度の加点要因はありません。</p>
            ) : (
              <ol class="importance-factor-list">
                {details.importanceFactors.map((factor) => {
                  const source = importanceFactorSource(factor.kind);
                  return (
                    <li key={factor.kind}>
                      <div>
                        <Pill
                          className={`importance-factor-source source-${source.kind}`}
                          tone={source.tone}
                        >
                          {source.label}
                        </Pill>
                        <code>{IMPORTANCE_FACTOR_LABELS[factor.kind]}</code>
                        <strong>+{factor.points.toLocaleString(locale)}点</strong>
                      </div>
                      <p>{factor.detail}</p>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
          <section class="decision-evidence" aria-labelledby="decision-evidence-heading">
            <h4 id="decision-evidence-heading">状態と次の行動の根拠</h4>
            {details.evidence.length === 0 ? (
              <p>公開できる判定根拠はありません。</p>
            ) : (
              <ol class="evidence-list">
                {details.evidence.map((evidence, index) => (
                  <li key={`${evidence.sourceUrl}:${index.toString()}`}>
                    <p>{evidence.summary}</p>
                    <SafeGitHubLink href={evidence.sourceUrl}>GitHub上の根拠を開く</SafeGitHubLink>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </details>

      <details class="detail-disclosure history-details">
        <summary>
          <span>履歴</span>
          <span>{details.history.length.toString()}件</span>
        </summary>
        <div class="detail-disclosure-content">
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

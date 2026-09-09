import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { GitHubIconButton } from "./github-icon-button.js";
import { ItemDetailsLink } from "./item-details.js";
import { formatWaitingOnCandidateParts, formatWaitingOnParts, statusLabel } from "./model.js";
import { Pill } from "./ui.js";
import { WaitingOnDisplay, type PersonNavigation } from "./waiting-on-display.js";

type CurrentImplementation = PublicItemSummaryDto["currentImplementations"][number];

type CurrentImplementationsProps = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    currentImplementations: readonly CurrentImplementation[];
    onSelectItem: (nodeId: string) => void;
    summary: PublicSummaryDto;
    variant: "compact" | "detail";
  }>;

function findImplementationItem(
  implementation: CurrentImplementation,
  summary: PublicSummaryDto,
): PublicItemSummaryDto {
  const item = summary.items.find((summaryItem) => summaryItem.nodeId === implementation.nodeId);
  assertNonNullable(item, `現在の実装PR ${implementation.nodeId} がsummaryにありません`);
  if (item.type !== "pull_request") {
    throw new TypeError(`現在の実装 ${implementation.nodeId} がPull Requestではありません`);
  }
  return item;
}

function ImplementationWaitingOn({
  createPersonHref,
  implementation,
  implementationItem,
  onSelectPerson,
  summary,
}: PersonNavigation &
  Readonly<{
    implementation: CurrentImplementation;
    implementationItem: PublicItemSummaryDto;
    summary: PublicSummaryDto;
  }>) {
  if (implementation.waitingOn.length === 0) {
    return (
      <WaitingOnDisplay
        createPersonHref={createPersonHref}
        onSelectPerson={onSelectPerson}
        parts={formatWaitingOnParts(implementationItem, summary)}
        showAvatar={false}
      />
    );
  }
  return (
    <ul class="current-implementation-waiting-on m-0 grid list-none gap-1 p-0">
      {implementation.waitingOn.map((candidate, index) => (
        <li
          class="grid min-w-0 gap-0.5"
          key={`${candidate.kind}:${candidate.role}:${candidate.candidateId}:${index.toString()}`}
        >
          <span class="wrap-anywhere">
            <WaitingOnDisplay
              createPersonHref={createPersonHref}
              onSelectPerson={onSelectPerson}
              parts={formatWaitingOnCandidateParts(candidate, implementationItem, summary)}
              showAvatar={false}
            />
          </span>
          {candidate.reasonSummary.length > 0 && (
            <span class="text-xs leading-5 text-text-muted wrap-anywhere">
              {candidate.reasonSummary}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

type CurrentImplementationRowProps = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    implementation: CurrentImplementation;
    onSelectItem: (nodeId: string) => void;
    summary: PublicSummaryDto;
    variant: "compact" | "detail";
  }>;

function CurrentImplementationRow({
  createItemHref,
  createPersonHref,
  implementation,
  onSelectItem,
  onSelectPerson,
  summary,
  variant,
}: CurrentImplementationRowProps) {
  const implementationItem = findImplementationItem(implementation, summary);
  const reference = (
    <ItemDetailsLink
      href={createItemHref(implementation.nodeId)}
      nodeId={implementation.nodeId}
      onSelect={onSelectItem}
    >
      {implementation.displayReference}
    </ItemDetailsLink>
  );
  const status = (
    <Pill className="current-implementation-status" tone="neutral">
      {statusLabel(implementation.status)}
    </Pill>
  );
  if (variant === "compact") {
    return (
      <li class="current-implementation-compact-item min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span class="min-w-0 wrap-anywhere">{reference}</span>
          <GitHubIconButton href={implementation.url} />
          {status}
        </div>
      </li>
    );
  }
  return (
    <li class="current-implementation-detail-item min-w-0 border-l-2 border-border-default pl-3">
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <strong class="min-w-0 wrap-anywhere">{reference}</strong>
        <GitHubIconButton href={implementation.url} />
        {status}
      </div>
      <p class="mt-1 mb-0 text-text-primary wrap-anywhere">{implementation.title}</p>
      <dl class="mt-3 mb-0 grid min-w-0 gap-3 sm:grid-cols-2">
        <div class="min-w-0">
          <dt class="text-xs font-bold text-text-muted">待ち相手</dt>
          <dd class="mt-1 mb-0 min-w-0 wrap-anywhere">
            <ImplementationWaitingOn
              createPersonHref={createPersonHref}
              implementation={implementation}
              implementationItem={implementationItem}
              onSelectPerson={onSelectPerson}
              summary={summary}
            />
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs font-bold text-text-muted">次の行動</dt>
          <dd class="mt-1 mb-0 text-text-primary wrap-anywhere">{implementation.nextAction}</dd>
        </div>
      </dl>
    </li>
  );
}

/** 関連する実装Pull Requestを一覧と詳細へ表示する。 */
export function CurrentImplementations({
  createItemHref,
  createPersonHref,
  currentImplementations,
  onSelectItem,
  onSelectPerson,
  summary,
  variant,
}: CurrentImplementationsProps) {
  if (currentImplementations.length === 0) {
    return null;
  }
  const items = (
    <ul
      class={`current-implementations-list m-0 grid list-none p-0 ${variant === "compact" ? "gap-1" : "gap-4"}`}
    >
      {currentImplementations.map((implementation) => (
        <CurrentImplementationRow
          key={implementation.nodeId}
          createItemHref={createItemHref}
          createPersonHref={createPersonHref}
          implementation={implementation}
          onSelectItem={onSelectItem}
          onSelectPerson={onSelectPerson}
          summary={summary}
          variant={variant}
        />
      ))}
    </ul>
  );
  if (variant === "compact") {
    return (
      <div class="current-implementations-compact grid min-w-0 gap-1 border-t border-border-subtle pt-1">
        <strong class="text-xs leading-5 text-text-muted">現在の実装</strong>
        {items}
      </div>
    );
  }
  return (
    <section
      aria-labelledby="current-implementations-heading"
      class="current-implementations-detail grid min-w-0 gap-3 border-t border-border-subtle pt-5"
    >
      <h4
        id="current-implementations-heading"
        class="m-0 font-display text-base leading-snug font-semibold"
      >
        現在の実装
      </h4>
      {items}
    </section>
  );
}

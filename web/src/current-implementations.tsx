import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { CurrentResponses } from "./current-responses.js";
import { GitHubIconButton } from "./github-icon-button.js";
import { ItemDetailsLink } from "./item-details.js";
import { statusLabel } from "./model.js";
import { Pill } from "./ui.js";
import { type PersonNavigation } from "./waiting-on-display.js";

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
        <CurrentResponses
          createItemHref={createItemHref}
          createPersonHref={createPersonHref}
          onSelectItem={onSelectItem}
          onSelectPerson={onSelectPerson}
          responses={implementationItem.currentResponses}
          summary={summary}
          variant="compact"
        />
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
      <CurrentResponses
        createItemHref={createItemHref}
        createPersonHref={createPersonHref}
        onSelectItem={onSelectItem}
        onSelectPerson={onSelectPerson}
        responses={implementationItem.currentResponses}
        summary={summary}
        variant="nested"
      />
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

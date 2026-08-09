import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { ItemListHeading } from "./item-list-heading.js";
import {
  formatStallDuration,
  formatWaitingOnCandidateParts,
  formatWaitingOnParts,
  statusLabel,
  type ItemSort,
  type ItemSortKey,
  type ItemTableRow,
} from "./model.js";
import {
  type ResponsiveCardField,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { Pill } from "./ui.js";
import { WaitingOnDisplay, type PersonNavigation } from "./waiting-on-display.js";

type WaitingOnCandidate = PublicItemSummaryDto["waitingOn"][number];

type ItemListFieldOptions = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    locale: string;
    now: Date;
    onSelectItem: (nodeId: string) => void;
    onSortChange: (key: ItemSortKey) => void;
    selectPrimaryWaitingOn: (row: ItemTableRow) => WaitingOnCandidate | undefined;
    sort: ItemSort;
    summary: PublicSummaryDto;
  }>;

const NUMERIC_HEADER_CLASS_NAME =
  "text-center whitespace-nowrap [&>button]:w-full [&>button]:justify-center [&>button]:px-1";

function WaitingOnStatus({
  createPersonHref,
  locale,
  onSelectPerson,
  primaryWaitingOn,
  row,
  summary,
}: Readonly<{
  locale: string;
  createPersonHref: (login: string) => string;
  onSelectPerson: (login: string) => void;
  primaryWaitingOn: WaitingOnCandidate | undefined;
  row: ItemTableRow;
  summary: PublicSummaryDto;
}>) {
  const primaryWaitingOnParts =
    primaryWaitingOn == null
      ? formatWaitingOnParts(row.item, summary)
      : formatWaitingOnCandidateParts(primaryWaitingOn, row.item, summary);
  const otherWaitingOnCount = primaryWaitingOn == null ? 0 : row.item.waitingOn.length - 1;
  const reason = primaryWaitingOn?.reasonSummary;
  return (
    <div class="item-waiting-on-status grid min-w-0 gap-1">
      <span class="item-waiting-on-summary flex min-w-0 items-baseline gap-2">
        <strong class="item-primary-waiting-on min-w-0 flex-1 leading-5 font-semibold text-text-primary wrap-anywhere">
          <WaitingOnDisplay
            createPersonHref={createPersonHref}
            onSelectPerson={onSelectPerson}
            parts={primaryWaitingOnParts}
            showAvatar={true}
          />
        </strong>
        {otherWaitingOnCount > 0 && (
          <span class="item-other-waiting-on flex-none font-mono text-xs text-text-muted whitespace-nowrap tabular-nums">
            ほか{otherWaitingOnCount.toLocaleString(locale)}件
          </span>
        )}
      </span>
      <Pill className="item-waiting-status" tone="neutral" variant="filled">
        {statusLabel(row.item.status)}
      </Pill>
      {reason != null && reason.length > 0 && (
        <span
          class="item-waiting-reason line-clamp-2 text-xs leading-5 text-text-muted wrap-anywhere"
          title={reason}
        >
          {reason}
        </span>
      )}
    </div>
  );
}

/** 項目一覧で共通利用する表の列を作る。 */
export function createItemTableColumns({
  createItemHref,
  createPersonHref,
  locale,
  now,
  onSelectItem,
  onSelectPerson,
  onSortChange,
  selectPrimaryWaitingOn,
  sort,
  summary,
}: ItemListFieldOptions): readonly ResponsiveTableColumn<ItemTableRow>[] {
  return [
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "row_header",
      headerClassName: "whitespace-nowrap",
      key: "item",
      label: "項目",
      renderCell: (row) => (
        <ItemListHeading
          createItemHref={createItemHref}
          onSelectItem={onSelectItem}
          row={row}
          showFreshnessBadge={true}
        />
      ),
      widthClassName: "w-[39%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "waitingOnStatus",
      label: "待ち相手と状態",
      renderCell: (row) => (
        <WaitingOnStatus
          createPersonHref={createPersonHref}
          locale={locale}
          onSelectPerson={onSelectPerson}
          primaryWaitingOn={selectPrimaryWaitingOn(row)}
          row={row}
          summary={summary}
        />
      ),
      widthClassName: "w-[31%]",
    },
    {
      ariaSort: sort.key === "attention" ? sort.direction : "none",
      cellClassName: "attention-cell text-center font-mono whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: NUMERIC_HEADER_CLASS_NAME,
      key: "attention",
      label: "要対応度",
      onSort: () => {
        onSortChange("attention");
      },
      renderCell: (row) => <AttentionBadge attention={row.item.attention} presentation="score" />,
      widthClassName: "w-[10.5%]",
    },
    {
      ariaSort: sort.key === "importance" ? sort.direction : "none",
      cellClassName: "importance-cell text-center font-mono whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: NUMERIC_HEADER_CLASS_NAME,
      key: "importance",
      label: "重要度",
      onSort: () => {
        onSortChange("importance");
      },
      renderCell: (row) => (
        <ImportanceBadge importance={row.item.importance} presentation="score" />
      ),
      widthClassName: "w-[9%]",
    },
    {
      ariaSort: sort.key === "stall" ? sort.direction : "none",
      cellClassName: "text-center font-mono whitespace-nowrap tabular-nums",
      cellKind: "data",
      headerClassName: NUMERIC_HEADER_CLASS_NAME,
      key: "stall",
      label: "停滞時間",
      onSort: () => {
        onSortChange("stall");
      },
      renderCell: (row) => (
        <strong class="font-mono tabular-nums">
          {formatStallDuration(row.item.stallSince, now)}
        </strong>
      ),
      widthClassName: "w-[10.5%]",
    },
  ];
}

/** 項目一覧で共通利用するカードのフィールドを作る。 */
export function createItemCardFields({
  createPersonHref,
  locale,
  now,
  onSelectPerson,
  selectPrimaryWaitingOn,
  summary,
}: ItemListFieldOptions): readonly ResponsiveCardField<ItemTableRow>[] {
  return [
    {
      className: "col-span-full border-b border-border-subtle pb-3",
      key: "waitingOnStatus",
      label: "待ち相手と状態",
      renderValue: (row) => (
        <WaitingOnStatus
          createPersonHref={createPersonHref}
          locale={locale}
          onSelectPerson={onSelectPerson}
          primaryWaitingOn={selectPrimaryWaitingOn(row)}
          row={row}
          summary={summary}
        />
      ),
      valueClassName: "text-text-primary",
    },
    {
      className: "",
      key: "attention",
      label: "要対応度",
      renderValue: (row) => <AttentionBadge attention={row.item.attention} presentation="score" />,
      valueClassName: "font-mono text-text-primary tabular-nums",
    },
    {
      className: "",
      key: "importance",
      label: "重要度",
      renderValue: (row) => (
        <ImportanceBadge importance={row.item.importance} presentation="score" />
      ),
      valueClassName: "font-mono text-text-primary tabular-nums",
    },
    {
      className: "",
      key: "stall",
      label: "停滞時間",
      renderValue: (row) => formatStallDuration(row.item.stallSince, now),
      valueClassName: "font-mono font-semibold text-text-primary tabular-nums",
    },
  ];
}

import {
  type PublicItemSummaryDto,
  type PublicPersonalReminderResponseDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { CurrentResponses } from "./current-responses.js";
import { CurrentImplementations } from "./current-implementations.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { DeadlineDisplay } from "./deadline-display.js";
import { ItemListHeading } from "./item-list-heading.js";
import {
  formatStallDuration,
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
import { type PersonNavigation } from "./waiting-on-display.js";

type ItemListFieldOptions = PersonNavigation &
  Readonly<{
    createItemHref: (nodeId: string) => string;
    now: Date;
    onSelectItem: (nodeId: string) => void;
    onSortChange: (key: ItemSortKey) => void;
    selectPrimaryCurrentResponse: (
      row: ItemTableRow,
    ) => PublicPersonalReminderResponseDto | undefined;
    sort: ItemSort;
    summary: PublicSummaryDto;
  }>;

const NUMERIC_HEADER_CLASS_NAME =
  "text-center whitespace-nowrap [&>button]:w-full [&>button]:justify-center [&>button]:px-1";

function orderCurrentResponses(
  item: PublicItemSummaryDto,
  primaryResponse: PublicPersonalReminderResponseDto | undefined,
): readonly PublicPersonalReminderResponseDto[] {
  if (primaryResponse == null) {
    return item.currentResponses;
  }
  const primaryResponseIndex = item.currentResponses.indexOf(primaryResponse);
  if (primaryResponseIndex < 0) {
    throw new TypeError(`項目 ${item.nodeId} のprimary current responseが候補にありません`);
  }
  return [
    primaryResponse,
    ...item.currentResponses.slice(0, primaryResponseIndex),
    ...item.currentResponses.slice(primaryResponseIndex + 1),
  ];
}

function CurrentResponseStatus({
  createItemHref,
  createPersonHref,
  onSelectItem,
  onSelectPerson,
  primaryResponse,
  row,
  summary,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  createPersonHref: (login: string) => string;
  onSelectItem: (nodeId: string) => void;
  onSelectPerson: (login: string) => void;
  primaryResponse: PublicPersonalReminderResponseDto | undefined;
  row: ItemTableRow;
  summary: PublicSummaryDto;
}>) {
  const responses = orderCurrentResponses(row.item, primaryResponse);
  return (
    <div class="item-waiting-on-status grid min-w-0 gap-1">
      <CurrentResponses
        createItemHref={createItemHref}
        createPersonHref={createPersonHref}
        onSelectItem={onSelectItem}
        onSelectPerson={onSelectPerson}
        planningStatus={row.item.personalReminderCausePlanningStatus}
        responses={responses}
        summary={summary}
        variant="compact"
      />
      <Pill className="item-waiting-status" tone="neutral">
        {statusLabel(row.item.status)}
      </Pill>
      <CurrentImplementations
        createItemHref={createItemHref}
        createPersonHref={createPersonHref}
        currentImplementations={row.item.currentImplementations}
        onSelectItem={onSelectItem}
        onSelectPerson={onSelectPerson}
        summary={summary}
        variant="compact"
      />
    </div>
  );
}

/** 項目一覧で共通利用する表の列を作る。 */
export function createItemTableColumns({
  createItemHref,
  createPersonHref,
  now,
  onSelectItem,
  onSelectPerson,
  onSortChange,
  selectPrimaryCurrentResponse,
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
      widthClassName: "w-[32%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "currentResponseStatus",
      label: "現在の対応と状態",
      renderCell: (row) => (
        <CurrentResponseStatus
          createItemHref={createItemHref}
          createPersonHref={createPersonHref}
          onSelectItem={onSelectItem}
          onSelectPerson={onSelectPerson}
          primaryResponse={selectPrimaryCurrentResponse(row)}
          row={row}
          summary={summary}
        />
      ),
      widthClassName: "w-[24%]",
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
      ariaSort: sort.key === "deadline" ? sort.direction : "none",
      cellClassName: "min-w-0 wrap-anywhere",
      cellKind: "data",
      headerClassName: "whitespace-nowrap",
      key: "deadline",
      label: "期限",
      onSort: () => {
        onSortChange("deadline");
      },
      renderCell: (row) => <DeadlineDisplay dateClassName="text-xs" deadline={row.item.deadline} />,
      widthClassName: "w-[14%]",
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
  createItemHref,
  createPersonHref,
  now,
  onSelectItem,
  onSelectPerson,
  selectPrimaryCurrentResponse,
  summary,
}: ItemListFieldOptions): readonly ResponsiveCardField<ItemTableRow>[] {
  return [
    {
      className: "col-span-full border-b border-border-subtle pb-3",
      key: "currentResponseStatus",
      label: "現在の対応と状態",
      renderValue: (row) => (
        <CurrentResponseStatus
          createItemHref={createItemHref}
          createPersonHref={createPersonHref}
          onSelectItem={onSelectItem}
          onSelectPerson={onSelectPerson}
          primaryResponse={selectPrimaryCurrentResponse(row)}
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
      key: "deadline",
      label: "期限",
      renderValue: (row) => (
        <DeadlineDisplay dateClassName="text-xs" deadline={row.item.deadline} />
      ),
      valueClassName: "text-text-primary",
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

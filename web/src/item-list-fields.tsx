import { type PublicItemSummaryDto, type PublicSummaryDto } from "../../src/pages/public-dto.js";
import { AttentionBadge, ImportanceBadge } from "./importance-badge.js";
import { DeadlineDisplay } from "./deadline-display.js";
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
    now: Date;
    onSelectItem: (nodeId: string) => void;
    onSortChange: (key: ItemSortKey) => void;
    selectPrimaryWaitingOn: (row: ItemTableRow) => WaitingOnCandidate | undefined;
    sort: ItemSort;
    summary: PublicSummaryDto;
  }>;

const NUMERIC_HEADER_CLASS_NAME =
  "text-center whitespace-nowrap [&>button]:w-full [&>button]:justify-center [&>button]:px-1";

function orderWaitingOnCandidates(
  item: PublicItemSummaryDto,
  primaryWaitingOn: WaitingOnCandidate | undefined,
): readonly WaitingOnCandidate[] {
  if (primaryWaitingOn == null) {
    return item.waitingOn;
  }
  const primaryWaitingOnIndex = item.waitingOn.indexOf(primaryWaitingOn);
  if (primaryWaitingOnIndex < 0) {
    throw new TypeError(`項目 ${item.nodeId} のprimary waitingOnが候補にありません`);
  }
  return [
    primaryWaitingOn,
    ...item.waitingOn.slice(0, primaryWaitingOnIndex),
    ...item.waitingOn.slice(primaryWaitingOnIndex + 1),
  ];
}

function WaitingOnStatus({
  createPersonHref,
  onSelectPerson,
  primaryWaitingOn,
  row,
  summary,
}: Readonly<{
  createPersonHref: (login: string) => string;
  onSelectPerson: (login: string) => void;
  primaryWaitingOn: WaitingOnCandidate | undefined;
  row: ItemTableRow;
  summary: PublicSummaryDto;
}>) {
  const waitingOnCandidates = orderWaitingOnCandidates(row.item, primaryWaitingOn);
  return (
    <div class="item-waiting-on-status grid min-w-0 gap-1">
      {waitingOnCandidates.length === 0 ? (
        <strong class="item-waiting-on-summary item-primary-waiting-on min-w-0 leading-5 font-semibold text-text-primary wrap-anywhere">
          <WaitingOnDisplay
            createPersonHref={createPersonHref}
            onSelectPerson={onSelectPerson}
            parts={formatWaitingOnParts(row.item, summary)}
            showAvatar={true}
          />
        </strong>
      ) : (
        <ul class="item-waiting-on-list m-0 grid min-w-0 list-none gap-2 p-0">
          {waitingOnCandidates.map((candidate, index) => {
            const primary = primaryWaitingOn != null && index === 0;
            const reason = candidate.reasonSummary;
            const waitingOnDisplay = (
              <WaitingOnDisplay
                createPersonHref={createPersonHref}
                onSelectPerson={onSelectPerson}
                parts={formatWaitingOnCandidateParts(candidate, row.item, summary)}
                showAvatar={true}
              />
            );
            return (
              <li
                class="item-waiting-on-candidate grid min-w-0 gap-0.5"
                key={`${candidate.kind}:${candidate.role}:${candidate.candidateId}:${index.toString()}`}
              >
                {primary ? (
                  <strong class="item-waiting-on-candidate-label item-primary-waiting-on min-w-0 leading-5 font-semibold text-text-primary wrap-anywhere">
                    {waitingOnDisplay}
                  </strong>
                ) : (
                  <span class="item-waiting-on-candidate-label min-w-0 leading-5 wrap-anywhere">
                    {waitingOnDisplay}
                  </span>
                )}
                {reason != null && reason.length > 0 && (
                  <span
                    class="item-waiting-reason line-clamp-2 text-xs leading-5 text-text-muted wrap-anywhere"
                    title={reason}
                  >
                    {reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pill className="item-waiting-status" tone="neutral">
        {statusLabel(row.item.status)}
      </Pill>
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
      widthClassName: "w-[32%]",
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
          onSelectPerson={onSelectPerson}
          primaryWaitingOn={selectPrimaryWaitingOn(row)}
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
  createPersonHref,
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

import { useEffect, useState } from "preact/hooks";

import {
  type PublicNotificationHistoryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { notificationReasonText } from "../../src/domain/notification-reason.js";
import { UnreachableError } from "../../src/util/index.js";
import { ResponseResponsible } from "./current-responses.js";
import { ItemHeading, type ItemHeadingLink } from "./item-list-heading.js";
import { ContentState, PageSection } from "./layout.js";
import { formatDateTime, notificationWaitingOnLabelParts } from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { ActionButton } from "./ui.js";
import { type PublicNotificationHistoryLoader } from "./notification-history-loader.js";
import { WaitingOnDisplay, type PersonNavigation } from "./waiting-on-display.js";

type NotificationHistoryPageProps = Readonly<{
  createItemHref: (nodeId: string) => string;
  createPersonHref: (login: string) => string;
  currentItemNodeIds: ReadonlySet<string>;
  loadNotificationHistory: PublicNotificationHistoryLoader;
  locale: string;
  onSelectItem: (nodeId: string) => void;
  onSelectPerson: (login: string) => void;
  summary: PublicSummaryDto;
}>;

type NotificationHistoryRow = PublicNotificationHistoryDto["notifications"][number];
type NotificationHistoryPersonalReminder = NotificationHistoryRow["personalReminders"][number];
type NotificationHistoryReason = NotificationHistoryRow["reasons"][number];

type NotificationHistoryState =
  | Readonly<{
      status: "not_requested";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      history: PublicNotificationHistoryDto;
    }>
  | Readonly<{
      status: "failed";
    }>;

function NotificationItem({
  createItemHref,
  currentItemNodeIds,
  item,
  onSelectItem,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  currentItemNodeIds: ReadonlySet<string>;
  item: NotificationHistoryRow["item"];
  onSelectItem: (nodeId: string) => void;
}>) {
  const link: ItemHeadingLink = currentItemNodeIds.has(item.nodeId)
    ? {
        createItemHref,
        kind: "internal",
        onSelectItem,
      }
    : {
        kind: "text",
      };
  return <ItemHeading item={item} link={link} metaAccessory={null} titleAccessory={null} />;
}

function notificationReasonKey(reason: NotificationHistoryReason): string {
  switch (reason.threshold.status) {
    case "recorded":
      return `${reason.reasonCode}:recorded:${reason.threshold.hours.toString()}`;
    case "not_reached":
      return `${reason.reasonCode}:not_reached:${reason.threshold.elapsedHours.toString()}`;
    case "not_recorded":
      return `${reason.reasonCode}:not_recorded`;
    case "not_applicable":
      return `${reason.reasonCode}:not_applicable`;
    default:
      throw new UnreachableError(reason.threshold);
  }
}

function notificationSystemReasons(
  row: NotificationHistoryRow,
): readonly NotificationHistoryReason[] {
  const personalReasonKeys = row.personalReminders.map((reminder) =>
    notificationReasonKey(reminder.reason),
  );
  return row.reasons.filter((reason) => {
    const personalReasonIndex = personalReasonKeys.indexOf(notificationReasonKey(reason));
    if (personalReasonIndex < 0) {
      return true;
    }
    personalReasonKeys.splice(personalReasonIndex, 1);
    return false;
  });
}

function NotificationReasons({
  reasons,
}: Readonly<{ reasons: NotificationHistoryRow["reasons"] }>) {
  return (
    <ul class="m-0 grid list-disc gap-1 pl-5">
      {reasons.map((reason, index) => (
        <li key={`${notificationReasonKey(reason)}:${index.toString()}`}>
          {notificationReasonText(reason)}
        </li>
      ))}
    </ul>
  );
}

function NotificationHistoricalWaitingOn({
  createPersonHref,
  onSelectPerson,
  waitingOn,
}: Readonly<{
  createPersonHref: (login: string) => string;
  onSelectPerson: (login: string) => void;
  waitingOn: NotificationHistoryRow["waitingOn"];
}>) {
  return (
    <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <WaitingOnDisplay
        createPersonHref={createPersonHref}
        onSelectPerson={onSelectPerson}
        parts={notificationWaitingOnLabelParts(waitingOn)}
        showAvatar={false}
      />
    </span>
  );
}

function NotificationPersonalReminderResponsibleList({
  createPersonHref,
  onSelectPerson,
  responsible,
}: PersonNavigation &
  Readonly<{
    responsible: NotificationHistoryPersonalReminder["responsible"];
  }>) {
  return (
    <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {responsible.map((candidate, index) => (
        <span
          class="inline-flex min-w-0 items-center gap-1.5"
          key={`${candidate.kind}:${candidate.candidateId}:${candidate.role}`}
        >
          {index > 0 && <span aria-hidden="true">、</span>}
          <ResponseResponsible
            createPersonHref={createPersonHref}
            onSelectPerson={onSelectPerson}
            responsible={candidate}
          />
        </span>
      ))}
    </span>
  );
}

function NotificationPersonalReminder({
  createPersonHref,
  locale,
  onSelectPerson,
  reminder,
  summary,
}: PersonNavigation &
  Readonly<{
    locale: string;
    reminder: NotificationHistoryPersonalReminder;
    summary: PublicSummaryDto;
  }>) {
  return (
    <li class="grid min-w-0 gap-1 border-l-2 border-border-default pl-3">
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <strong class="text-xs text-text-muted">対応相手</strong>
        <NotificationPersonalReminderResponsibleList
          createPersonHref={createPersonHref}
          onSelectPerson={onSelectPerson}
          responsible={reminder.responsible}
        />
      </div>
      <p class="m-0 min-w-0 wrap-anywhere text-sm text-text-primary">
        <strong class="text-xs text-text-muted">次の行動</strong> {reminder.action.summary}
      </p>
      <p class="m-0 min-w-0 wrap-anywhere text-xs text-text-secondary">
        <strong class="text-xs text-text-muted">停滞開始</strong>{" "}
        <time
          dateTime={reminder.stallSince.at}
          title={formatDateTime(reminder.stallSince.at, summary.timezone, locale)}
        >
          {formatDateTime(reminder.stallSince.at, summary.timezone, locale)}
        </time>
      </p>
    </li>
  );
}

function NotificationPersonalReminders({
  createPersonHref,
  locale,
  onSelectPerson,
  reminders,
  summary,
}: PersonNavigation &
  Readonly<{
    locale: string;
    reminders: readonly NotificationHistoryPersonalReminder[];
    summary: PublicSummaryDto;
  }>) {
  return (
    <div class="grid min-w-0 gap-2">
      <strong class="text-xs text-text-muted">送信時の個人対応</strong>
      <ul class="m-0 grid min-w-0 list-none gap-2 p-0">
        {reminders.map((reminder) => (
          <NotificationPersonalReminder
            createPersonHref={createPersonHref}
            key={reminder.notificationKey}
            locale={locale}
            onSelectPerson={onSelectPerson}
            reminder={reminder}
            summary={summary}
          />
        ))}
      </ul>
    </div>
  );
}

function NotificationWaitingOn({
  createPersonHref,
  locale,
  onSelectPerson,
  row,
  summary,
}: PersonNavigation &
  Readonly<{
    locale: string;
    row: NotificationHistoryRow;
    summary: PublicSummaryDto;
  }>) {
  if (row.personalReminders.length === 0) {
    return (
      <NotificationHistoricalWaitingOn
        createPersonHref={createPersonHref}
        onSelectPerson={onSelectPerson}
        waitingOn={row.waitingOn}
      />
    );
  }
  const systemReasons = notificationSystemReasons(row);
  return (
    <div class="grid min-w-0 gap-3">
      <NotificationPersonalReminders
        createPersonHref={createPersonHref}
        locale={locale}
        onSelectPerson={onSelectPerson}
        reminders={row.personalReminders}
        summary={summary}
      />
      {systemReasons.length > 0 && (
        <div class="grid min-w-0 gap-1 border-t border-border-subtle pt-2">
          <strong class="text-xs text-text-muted">項目全体の待ち相手</strong>
          <NotificationHistoricalWaitingOn
            createPersonHref={createPersonHref}
            onSelectPerson={onSelectPerson}
            waitingOn={row.waitingOn}
          />
        </div>
      )}
    </div>
  );
}

function notificationRowPresentation(
  row: NotificationHistoryRow,
  index: number,
): ResponsiveListRowPresentation {
  return {
    cardClassName: "bg-surface-card",
    dataAttributes: {
      "data-notification-index": index.toString(),
    },
    key: `${row.sentAt}-${row.item.url}-${index.toString()}`,
    tableClassName: "",
  };
}

function NotificationHistoryTable({
  createItemHref,
  createPersonHref,
  currentItemNodeIds,
  locale,
  onSelectItem,
  onSelectPerson,
  rows,
  summary,
}: Readonly<{
  createItemHref: (nodeId: string) => string;
  createPersonHref: (login: string) => string;
  currentItemNodeIds: ReadonlySet<string>;
  locale: string;
  onSelectItem: (nodeId: string) => void;
  onSelectPerson: (login: string) => void;
  rows: readonly NotificationHistoryRow[];
  summary: PublicSummaryDto;
}>) {
  const columns = [
    {
      ariaSort: undefined,
      cellClassName: "font-mono whitespace-normal break-words tabular-nums",
      cellKind: "row_header",
      headerClassName: "whitespace-nowrap",
      key: "sentAt",
      label: "通知日時",
      renderCell: (row: NotificationHistoryRow) => (
        <time dateTime={row.sentAt} title={formatDateTime(row.sentAt, summary.timezone, locale)}>
          {formatDateTime(row.sentAt, summary.timezone, locale)}
        </time>
      ),
      widthClassName: "w-[22%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "data",
      headerClassName: "",
      key: "item",
      label: "項目",
      renderCell: (row: NotificationHistoryRow) => (
        <NotificationItem
          createItemHref={createItemHref}
          currentItemNodeIds={currentItemNodeIds}
          item={row.item}
          onSelectItem={onSelectItem}
        />
      ),
      widthClassName: "w-[35%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "data",
      headerClassName: "",
      key: "waitingOn",
      label: "待ち相手",
      renderCell: (row: NotificationHistoryRow) => (
        <NotificationWaitingOn
          createPersonHref={createPersonHref}
          locale={locale}
          onSelectPerson={onSelectPerson}
          row={row}
          summary={summary}
        />
      ),
      widthClassName: "w-[20%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "data",
      headerClassName: "",
      key: "reasons",
      label: "通知理由",
      renderCell: (row: NotificationHistoryRow) => <NotificationReasons reasons={row.reasons} />,
      widthClassName: "w-[23%]",
    },
  ] satisfies readonly ResponsiveTableColumn<NotificationHistoryRow>[];
  const cardFields = [
    {
      className: "",
      key: "sentAt",
      label: "通知日時",
      renderValue: (row: NotificationHistoryRow) => (
        <time dateTime={row.sentAt} title={formatDateTime(row.sentAt, summary.timezone, locale)}>
          {formatDateTime(row.sentAt, summary.timezone, locale)}
        </time>
      ),
      valueClassName: "font-mono font-semibold text-text-primary tabular-nums",
    },
    {
      className: "col-span-2",
      key: "waitingOn",
      label: "待ち相手",
      renderValue: (row: NotificationHistoryRow) => (
        <NotificationWaitingOn
          createPersonHref={createPersonHref}
          locale={locale}
          onSelectPerson={onSelectPerson}
          row={row}
          summary={summary}
        />
      ),
      valueClassName: "text-text-primary",
    },
    {
      className: "col-span-2",
      key: "reasons",
      label: "通知理由",
      renderValue: (row: NotificationHistoryRow) => <NotificationReasons reasons={row.reasons} />,
      valueClassName: "text-text-primary",
    },
  ] satisfies readonly ResponsiveCardField<NotificationHistoryRow>[];

  return (
    <ResponsiveTableCardList
      breakpoint="md"
      cardAriaLabel="通知履歴"
      cardFields={cardFields}
      cardListClassName="notification-history-card-list"
      columns={columns}
      getRowPresentation={notificationRowPresentation}
      rows={rows}
      tableCaption="Discord通知の履歴"
      tableClassName="notification-history-table"
      renderCardHeading={(row) => (
        <NotificationItem
          createItemHref={createItemHref}
          currentItemNodeIds={currentItemNodeIds}
          item={row.item}
          onSelectItem={onSelectItem}
        />
      )}
      renderCardFooter={() => null}
    />
  );
}

/** Discord通知の送信履歴を遅延取得して表示する。 */
export function NotificationHistoryPage({
  createItemHref,
  createPersonHref,
  currentItemNodeIds,
  loadNotificationHistory,
  locale,
  onSelectItem,
  onSelectPerson,
  summary,
}: NotificationHistoryPageProps) {
  const [historyState, setHistoryState] = useState<NotificationHistoryState>({
    status: "not_requested",
  });

  useEffect(() => {
    if (historyState.status !== "not_requested") {
      return;
    }
    setHistoryState({
      status: "loading",
    });
    void loadNotificationHistory()
      .then((history) => {
        setHistoryState({
          status: "loaded",
          history,
        });
      })
      .catch((error: unknown) => {
        console.error("通知履歴の公開データ取得に失敗しました", error);
        setHistoryState({
          status: "failed",
        });
      });
  }, [historyState.status, loadNotificationHistory]);

  let content;
  switch (historyState.status) {
    case "not_requested":
    case "loading":
      content = (
        <ContentState
          className="notification-history-placeholder"
          message="通知履歴を読み込んでいます。"
          status="loading"
        />
      );
      break;
    case "failed":
      content = (
        <ContentState
          className="notification-history-placeholder"
          message="通知履歴を取得できませんでした。"
          status="failed"
        >
          <ActionButton
            type="button"
            onClick={() => {
              setHistoryState({
                status: "not_requested",
              });
            }}
          >
            再取得
          </ActionButton>
        </ContentState>
      );
      break;
    case "loaded":
      content =
        historyState.history.notifications.length === 0 ? (
          <ContentState
            className="notification-history-empty"
            message="表示できる通知履歴はありません。"
            status="empty"
          />
        ) : (
          <NotificationHistoryTable
            createItemHref={createItemHref}
            createPersonHref={createPersonHref}
            currentItemNodeIds={currentItemNodeIds}
            locale={locale}
            onSelectItem={onSelectItem}
            onSelectPerson={onSelectPerson}
            rows={historyState.history.notifications}
            summary={summary}
          />
        );
      break;
    default:
      throw new UnreachableError(historyState);
  }

  return (
    <PageSection
      className="notification-history-page"
      heading="通知履歴"
      headingId="notification-history-page-heading"
    >
      {content}
    </PageSection>
  );
}

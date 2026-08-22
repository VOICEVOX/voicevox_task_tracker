import { useEffect, useState } from "preact/hooks";

import {
  type PublicNotificationHistoryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { notificationReasonText } from "../../src/domain/notification-reason.js";
import { UnreachableError } from "../../src/util/index.js";
import { GitHubIconButton } from "./github-icon-button.js";
import { ContentState, PageSection } from "./layout.js";
import { formatDateTime } from "./model.js";
import {
  ResponsiveTableCardList,
  type ResponsiveCardField,
  type ResponsiveListRowPresentation,
  type ResponsiveTableColumn,
} from "./responsive-table-card-list.js";
import { SafeGitHubLink } from "./safe-link.js";
import { ActionButton, Pill } from "./ui.js";
import { type PublicNotificationHistoryLoader } from "./notification-history-loader.js";

type NotificationHistoryPageProps = Readonly<{
  loadNotificationHistory: PublicNotificationHistoryLoader;
  locale: string;
  summary: PublicSummaryDto;
}>;

type NotificationHistoryRow = PublicNotificationHistoryDto["notifications"][number];

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

function notificationTypeLabel(type: NotificationHistoryRow["item"]["type"]): string {
  switch (type) {
    case "issue":
      return "Issue";
    case "pull_request":
      return "Pull Request";
    default:
      throw new UnreachableError(type);
  }
}

function NotificationItem({ item }: Readonly<{ item: NotificationHistoryRow["item"] }>) {
  return (
    <div class="grid min-w-0 gap-1">
      <h3 class="m-0 flex min-w-0 items-start gap-1 text-base leading-6 font-semibold">
        <span class="min-w-0 flex-1 wrap-anywhere">
          <SafeGitHubLink href={item.url} variant="inline">
            {item.title}
          </SafeGitHubLink>
        </span>
        <GitHubIconButton href={item.url} />
      </h3>
      <p class="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-text-muted wrap-anywhere">
        <span>{item.displayReference}</span>
        <span aria-hidden="true">・</span>
        <Pill
          className={`notification-item-type notification-item-type-${item.type}`}
          tone={item.type === "issue" ? "success" : "info"}
        >
          {notificationTypeLabel(item.type)}
        </Pill>
      </p>
    </div>
  );
}

function NotificationReasons({
  reasonCodes,
}: Readonly<{ reasonCodes: NotificationHistoryRow["reasonCodes"] }>) {
  return (
    <ul class="m-0 grid list-disc gap-1 pl-5">
      {reasonCodes.map((reasonCode) => (
        <li key={reasonCode}>{notificationReasonText(reasonCode)}</li>
      ))}
    </ul>
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
  locale,
  rows,
  summary,
}: Readonly<{
  locale: string;
  rows: readonly NotificationHistoryRow[];
  summary: PublicSummaryDto;
}>) {
  const columns = [
    {
      ariaSort: undefined,
      cellClassName: "font-mono whitespace-nowrap tabular-nums",
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
      renderCell: (row: NotificationHistoryRow) => <NotificationItem item={row.item} />,
      widthClassName: "w-[43%]",
    },
    {
      ariaSort: undefined,
      cellClassName: "min-w-0",
      cellKind: "data",
      headerClassName: "",
      key: "reasonCodes",
      label: "通知理由",
      renderCell: (row: NotificationHistoryRow) => (
        <NotificationReasons reasonCodes={row.reasonCodes} />
      ),
      widthClassName: "w-[35%]",
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
      key: "reasonCodes",
      label: "通知理由",
      renderValue: (row: NotificationHistoryRow) => (
        <NotificationReasons reasonCodes={row.reasonCodes} />
      ),
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
      renderCardHeading={(row) => <NotificationItem item={row.item} />}
      renderCardFooter={() => null}
    />
  );
}

/** Discord通知の送信履歴を遅延取得して表示する。 */
export function NotificationHistoryPage({
  loadNotificationHistory,
  locale,
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
            locale={locale}
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

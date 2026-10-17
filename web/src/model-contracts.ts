import type {
  PublicItemDetailsDto,
  PublicItemSummaryDto,
  PublicNotificationHistoryEntryDto,
  PublicPersonalReminderResponseDto,
  PublicSummaryDto,
} from "../../src/pages/public-dto-contracts.js";

export type ConfidenceThresholds = PublicSummaryDto["confidenceThresholds"];
export type ItemType = PublicItemSummaryDto["type"];
export type Status = PublicItemSummaryDto["status"];
export type ImportanceLevel = PublicItemSummaryDto["importance"]["level"];
export type DeadlineLevel = Extract<
  PublicItemSummaryDto["deadline"],
  { status: "available" }
>["level"];
export type AiUnverifiedValue = PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number];
export type CurrentResponseUnverifiedValue =
  PublicPersonalReminderResponseDto["unverifiedValues"][number];
export type CurrentResponseStatus = PublicPersonalReminderResponseDto["status"];
export type CurrentResponseUnknownReason = Extract<
  PublicPersonalReminderResponseDto,
  Readonly<{ status: "unknown" }>
>["reason"];
export type CurrentResponseResponsible = PublicPersonalReminderResponseDto["responsible"][number];
export type CurrentResponseRole = CurrentResponseResponsible["role"];
export type WaitingOnCandidate = PublicItemSummaryDto["waitingOn"][number];
export type WaitingOnReference = Pick<WaitingOnCandidate, "candidateId" | "kind" | "role">;
export type NotificationWaitingOnReference = PublicNotificationHistoryEntryDto["waitingOn"][number];
export type WaitingOnRole = WaitingOnReference["role"];
export type CurrentRoleResolution =
  | Readonly<{
      kind: "accounts";
      logins: readonly string[];
    }>
  | Readonly<{
      kind: "deleted_account";
    }>
  | Readonly<{
      kind: "unassigned";
    }>
  | Readonly<{
      kind: "unresolved";
    }>;
export type PublicActor = Extract<
  PublicItemDetailsDto["latestEventActor"],
  Readonly<{ status: "present" }>
>["actor"];

/** 一覧表で絞り込みの対象にする項目。 */
export type TableFilterKey =
  | "repository"
  | "type"
  | "status"
  | "importance"
  | "waitingOn"
  | "responseStatus"
  | "stall"
  | "aiAnalysis";

/** 一覧表で選択式の絞り込みにする列。 */
export type TableSelectFilterKey = Exclude<TableFilterKey, "waitingOn">;

/** 項目一覧で並び替えの対象にするキー。 */
export type ItemSortKey = "attention" | "importance" | "stall" | "deadline";

/** 項目一覧の並び順。 */
export type ItemSort = Readonly<{
  key: ItemSortKey;
  direction: "ascending" | "descending";
}>;

/** 別のキーを選んだときの自然な並び順。 */
export const ITEM_NATURAL_SORT_DIRECTIONS: Readonly<Record<ItemSortKey, ItemSort["direction"]>> = {
  attention: "descending",
  importance: "descending",
  stall: "descending",
  deadline: "descending",
};

/** 一覧表の列別絞り込み値。 */
export type TableFilters = Readonly<Record<TableFilterKey, string>>;

/** 一覧表の選択式絞り込みへ表示する選択肢。 */
export type TableFilterOption = Readonly<{
  label: string;
  value: string;
}>;

/** 公開データから選べる一覧表の絞り込み値。 */
export type TableFilterOptions = Readonly<
  Record<TableSelectFilterKey, readonly TableFilterOption[]>
>;

/** 一覧表へ表示する項目の導出値。 */
export type ItemTableRow = Readonly<{
  item: PublicItemSummaryDto;
  repositoryText: string;
  currentResponseText: string;
  stallDurationMilliseconds: number;
}>;

/** 許可済みGitHub URLの検証結果。 */
export type GitHubUrlResult =
  | Readonly<{
      allowed: true;
      url: string;
    }>
  | Readonly<{
      allowed: false;
    }>;

/** confidenceに応じた判定表示。 */
export type ConfidencePresentation = Readonly<{
  level: "confirmed" | "high_estimate" | "estimate" | "uncertain";
  label: string;
  fieldQualifier: "" | "推定" | "候補";
}>;

/** 現在の対応者を表す人またはチーム。 */
export type CurrentResponseSubject =
  Readonly<{ kind: "user"; login: string }> | Readonly<{ kind: "team"; teamId: string }>;

/** 現在の対応者ごとの集計行。 */
export type CurrentResponseSubjectRow = Readonly<{
  subject: CurrentResponseSubject;
  label: string;
  itemCount: number;
  itemCountUnverified: boolean;
  longestStallDuration: string;
  longestStallUnverified: boolean;
}>;

/** 待ち相手表示を構成する文字列またはGitHub login。 */
export type WaitingOnDisplayPart =
  Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "login"; login: string }>;

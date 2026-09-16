import {
  type PublicDetailsDto,
  type PublicItemDetailsDto,
  type PublicItemSummaryDto,
  type PublicNotificationHistoryEntryDto,
  type PublicPersonalReminderResponseDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { isTerminalStatus } from "../../src/domain/status.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";

type ConfidenceThresholds = PublicSummaryDto["confidenceThresholds"];
type ItemType = PublicItemSummaryDto["type"];
type Status = PublicItemSummaryDto["status"];
type ImportanceLevel = PublicItemSummaryDto["importance"]["level"];
type DeadlineLevel = Extract<PublicItemSummaryDto["deadline"], { status: "available" }>["level"];
type AiUnverifiedValue = PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number];
type CurrentResponseUnverifiedValue = PublicPersonalReminderResponseDto["unverifiedValues"][number];
type CurrentResponseStatus = PublicPersonalReminderResponseDto["status"];
type CurrentResponseUnknownReason = Extract<
  PublicPersonalReminderResponseDto,
  Readonly<{ status: "unknown" }>
>["reason"];
type CurrentResponseResponsible = PublicPersonalReminderResponseDto["responsible"][number];
type CurrentResponseRole = CurrentResponseResponsible["role"];
type WaitingOnCandidate = PublicItemSummaryDto["waitingOn"][number];
type WaitingOnReference = Pick<WaitingOnCandidate, "candidateId" | "kind" | "role">;
type NotificationWaitingOnReference = PublicNotificationHistoryEntryDto["waitingOn"][number];
type WaitingOnRole = WaitingOnReference["role"];
type CurrentRoleResolution =
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
type PublicActor = Extract<
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

const STATUS_LABELS = {
  waiting_for_assessment: "内容確認待ち",
  waiting_for_owner: "担当決め待ち",
  waiting_for_decision: "方針判断待ち",
  waiting_for_review: "レビュー待ち",
  waiting_for_revision: "修正待ち",
  waiting_for_reply: "返答待ち",
  waiting_for_work: "作業待ち",
  waiting_for_unblock: "ブロック解消待ち",
  waiting_for_automation: "自動処理待ち",
  waiting_for_merge: "マージ待ち",
  in_progress: "作業中",
  unknown: "待ち先不明",
  terminal_merged: "マージ済み",
  terminal_completed: "完了",
  terminal_not_planned: "対応しない",
} satisfies Readonly<Record<Status, string>>;

const ITEM_TYPE_LABELS = {
  issue: "Issue",
  pull_request: "Pull Request",
} satisfies Readonly<Record<ItemType, string>>;

const IMPORTANCE_LEVEL_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
} satisfies Readonly<Record<ImportanceLevel, string>>;

const DEADLINE_LEVEL_LABELS = {
  none: "期限なし",
  over_30_days: "30日超",
  within_30_days: "30日以内",
  within_7_days: "7日以内",
  within_3_days: "3日以内",
  within_1_day: "1日以内",
  overdue: "期限超過",
} satisfies Readonly<Record<DeadlineLevel, string>>;

const DEADLINE_LEVEL_SORT_SCORES = {
  none: 1,
  over_30_days: 2,
  within_30_days: 3,
  within_7_days: 4,
  within_3_days: 5,
  within_1_day: 6,
  overdue: 7,
} satisfies Readonly<Record<DeadlineLevel, number>>;

type StallFilterDefinition = Readonly<{
  label: string;
  thresholdMilliseconds: number;
  value: string;
}>;

const STALL_FILTER_DEFINITIONS = [
  {
    label: "1日以上",
    thresholdMilliseconds: 1 * 24 * 60 * 60 * 1000,
    value: "1d",
  },
  {
    label: "3日以上",
    thresholdMilliseconds: 3 * 24 * 60 * 60 * 1000,
    value: "3d",
  },
  {
    label: "7日以上",
    thresholdMilliseconds: 7 * 24 * 60 * 60 * 1000,
    value: "7d",
  },
  {
    label: "30日以上",
    thresholdMilliseconds: 30 * 24 * 60 * 60 * 1000,
    value: "30d",
  },
] satisfies readonly StallFilterDefinition[];

const AI_ANALYSIS_FILTER_OPTIONS = [
  {
    label: "未検証値・分析失敗・未実行",
    value: "unverified",
  },
  {
    label: "AI推定が一部不要",
    value: "partial",
  },
  {
    label: "AI推定がすべて不要",
    value: "all",
  },
] satisfies readonly TableFilterOption[];

const CURRENT_RESPONSE_STATUS_LABELS = {
  actionable: "対応可能",
  waiting: "待機中",
  unknown: "不明",
} satisfies Readonly<Record<CurrentResponseStatus, string>>;

const CURRENT_RESPONSE_UNKNOWN_REASON_LABELS = {
  input_mismatch: "入力が一致しない",
  not_evaluated: "未評価",
  failed: "判定に失敗",
  deferred: "今回はAI判定を実行していません",
  incomplete_input: "入力不足",
  conflicting_evidence: "根拠が競合",
  ambiguous_meaning: "意味が曖昧",
} satisfies Readonly<Record<CurrentResponseUnknownReason, string>>;

const dateTimeFormatters = new Map<string, Map<string, Intl.DateTimeFormat>>();
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

const ROLE_LABELS = {
  author: "作成者",
  maintainer: "メンテナー",
  reviewer: "レビュワー",
  assignee: "担当者",
  respondent: "回答者",
  dependency: "依存項目",
  merge_decider: "マージ判断者",
  ci: "CI",
  unknown: "不明",
} satisfies Readonly<Record<WaitingOnRole, string>>;

/** 一覧表の既定の絞り込み条件を作る。 */
export function createDefaultTableFilters(): TableFilters {
  return {
    repository: "",
    type: "",
    status: "",
    importance: "",
    waitingOn: "",
    responseStatus: "",
    stall: "",
    aiAnalysis: "",
  };
}

/** 現在の対応状態の日本語表示名を返す。 */
export function currentResponseStatusLabel(status: CurrentResponseStatus): string {
  return CURRENT_RESPONSE_STATUS_LABELS[status];
}

/** 現在の対応がunknownである理由の日本語表示名を返す。 */
export function currentResponseUnknownReasonLabel(reason: CurrentResponseUnknownReason): string {
  return CURRENT_RESPONSE_UNKNOWN_REASON_LABELS[reason];
}

/** 個人催促の責任主体に付いた役割の日本語表示名を返す。 */
export function currentResponseRoleLabel(role: CurrentResponseRole): string {
  return ROLE_LABELS[role];
}

/** 列が選択式の絞り込み対象かを返す。 */
export function isTableSelectFilterKey(key: TableFilterKey): key is TableSelectFilterKey {
  return key !== "waitingOn";
}

const AI_UNVERIFIED_VALUE_LABELS = {
  status: "現在の状態",
  waitingOn: "待ち相手",
  primaryWaitingOn: "主要な待ち相手",
  nextAction: "次の行動",
  confidence: "判定の確度",
  evidence: "状態と次の行動の根拠",
  uncertainties: "不確実な点",
  deadline: "期限",
  staleness: "停滞時間",
  downstreamImpact: "影響",
  importance: "重要度",
  attention: "要対応度",
  blockers: "ブロッカー",
  relations: "依存関係",
} satisfies Readonly<Record<AiUnverifiedValue, string>>;

const CURRENT_RESPONSE_UNVERIFIED_VALUE_LABELS = {
  status: "現在の対応の状態",
  responsible: "現在の対応者",
  action: "現在の対応内容",
  evidence: "現在の対応の根拠",
  waitingFor: "待機先",
} satisfies Readonly<Record<CurrentResponseUnverifiedValue, string>>;

/** AI未検証値の日本語表示名を返す。 */
export function aiUnverifiedValueLabel(value: AiUnverifiedValue): string {
  return AI_UNVERIFIED_VALUE_LABELS[value];
}

/** 現在の対応のAI未検証値の日本語表示名を返す。 */
export function currentResponseUnverifiedValueLabel(value: CurrentResponseUnverifiedValue): string {
  return CURRENT_RESPONSE_UNVERIFIED_VALUE_LABELS[value];
}

/** 現在の対応全体がAI未検証であることの説明文を返す。 */
export function currentResponsesUnverifiedDescription(): string {
  return "現在対応の件数・構成は現在入力で未検証で、表示内容が増減する可能性があります。";
}

/** 表示中の対応者を現在の対応者として数えるかがAI未検証であることの説明文を返す。 */
export function currentResponseSubjectCountUnverifiedDescription(): string {
  return "現在入力に対して、表示中の対応者を現在の対応者として数えるかが未検証で、対応中の項目数が増減する可能性があります。";
}

/** 現在の対応者一覧に未検証の対応者判定があることの説明文を返す。 */
export function currentResponseSubjectsUnverifiedDescription(): string {
  return "現在の対応者一覧は現在入力で未検証で、表示する人物やチームが増減する可能性があります。";
}

function itemAiAnalysisRunUnverifiedDescription(
  runStatus: PublicItemSummaryDto["aiAnalysis"]["runStatus"],
): string | undefined {
  switch (runStatus) {
    case "failed":
      return "今回のAI分析に失敗しました。";
    case "deferred":
      return "予算上限により今回はAI分析を実行していません。";
    case "used":
    case "not_required":
    case "disabled":
    case "not_recorded":
      return undefined;
    default:
      throw new UnreachableError(runStatus);
  }
}

function itemAiUnverifiedValueLabels(item: PublicItemSummaryDto): readonly string[] {
  const labels = new Set(
    item.aiAnalysis.unverifiedValues.map((value) => aiUnverifiedValueLabel(value)),
  );
  if (item.currentResponsesUnverified) {
    labels.add("現在の対応の集合");
  }
  for (const response of item.currentResponses) {
    for (const value of response.unverifiedValues) {
      labels.add(currentResponseUnverifiedValueLabel(value));
    }
    if (response.subjectMembershipUnverified) {
      labels.add("現在の対応者として数える対象");
    }
  }
  return [...labels];
}

/** 項目に残るAI未検証値を一覧行向けに説明する。 */
export function itemAiUnverifiedDescription(item: PublicItemSummaryDto): string | undefined {
  const runDescription = itemAiAnalysisRunUnverifiedDescription(item.aiAnalysis.runStatus);
  const valueLabels = itemAiUnverifiedValueLabels(item);
  if (runDescription == null && valueLabels.length === 0) {
    return undefined;
  }
  let description = valueLabels.length > 0 ? "現在入力で未検証のAI推定があります。" : "";
  if (runDescription != null) {
    description += runDescription;
  }
  if (valueLabels.length > 0) {
    description += `未検証の値: ${valueLabels.join("、")}。`;
  }
  return description;
}

/** 項目一覧のAI注意マークを読み上げる文言を返す。 */
export function itemAiNoticeAriaLabel(item: PublicItemSummaryDto): string {
  if (itemAiUnverifiedValueLabels(item).length > 0) {
    return "現在入力で未検証";
  }
  switch (item.aiAnalysis.runStatus) {
    case "failed":
      return "今回のAI分析に失敗";
    case "deferred":
      return "今回はAI分析を実行していません";
    case "used":
    case "not_required":
    case "disabled":
    case "not_recorded":
      throw new TypeError("AI注意マークの読み上げ対象がありません");
    default:
      throw new UnreachableError(item.aiAnalysis.runStatus);
  }
}

/** 項目のAI推定または現在の対応に未検証値があるかを返す。 */
export function hasItemAiUnverifiedValue(item: PublicItemSummaryDto): boolean {
  return itemAiUnverifiedDescription(item) != null;
}

/** 指定した表示値がAI未検証かを返す。 */
export function hasAiUnverifiedValue(
  aiAnalysis: PublicItemSummaryDto["aiAnalysis"],
  value: AiUnverifiedValue,
): boolean {
  return aiAnalysis.unverifiedValues.includes(value);
}

/** statusの日本語表示名を返す。 */
export function statusLabel(status: Status): string {
  return STATUS_LABELS[status];
}

/** 重要度levelの日本語表示名を返す。 */
export function importanceLevelLabel(level: ImportanceLevel): string {
  return IMPORTANCE_LEVEL_LABELS[level];
}

/** 期限の切迫度levelの日本語表示名を返す。 */
export function deadlineLevelLabel(level: DeadlineLevel): string {
  return DEADLINE_LEVEL_LABELS[level];
}

/** 期限日を日本語の年月日へ整形する。 */
export function formatDeadlineDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match == null) {
    throw new TypeError(`期限日を解釈できません: ${value}`);
  }
  const year = match[1];
  const month = match[2];
  const day = match[3];
  assertNonNullable(year, "期限日から年を取得できませんでした");
  assertNonNullable(month, "期限日から月を取得できませんでした");
  assertNonNullable(day, "期限日から日を取得できませんでした");
  return `${year}年${Number(month).toString()}月${Number(day).toString()}日`;
}

function createPresentTableFilterOptions(
  labels: Readonly<Record<string, string>>,
  presentValues: ReadonlySet<string>,
): readonly TableFilterOption[] {
  return Object.entries(labels)
    .filter(([value]) => presentValues.has(value))
    .map(([value, label]) => ({ label, value }));
}

/** 公開summaryに実在する一覧表の選択肢を作る。 */
export function createTableFilterOptions(summary: PublicSummaryDto): TableFilterOptions {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  const repositoryValues = new Set<string>();
  const typeValues = new Set<string>();
  const statusValues = new Set<string>();
  const importanceValues = new Set<string>();
  const responseStatusValues = new Set<string>();

  for (const item of summary.items) {
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
    repositoryValues.add(repository.fullName);
    typeValues.add(item.type);
    statusValues.add(item.status);
    importanceValues.add(item.importance.level);
    for (const response of item.currentResponses) {
      responseStatusValues.add(response.status);
    }
  }

  return {
    repository: [...repositoryValues]
      .sort(compareStrings)
      .map((value) => ({ label: value, value })),
    type: createPresentTableFilterOptions(ITEM_TYPE_LABELS, typeValues),
    status: [
      { label: "すべて", value: "all" },
      ...createPresentTableFilterOptions(STATUS_LABELS, statusValues),
    ],
    importance: createPresentTableFilterOptions(IMPORTANCE_LEVEL_LABELS, importanceValues),
    responseStatus: createPresentTableFilterOptions(
      CURRENT_RESPONSE_STATUS_LABELS,
      responseStatusValues,
    ),
    stall: STALL_FILTER_DEFINITIONS.map(({ label, value }) => ({ label, value })),
    aiAnalysis: AI_ANALYSIS_FILTER_OPTIONS,
  };
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`日時を解釈できません: ${value}`);
  }
  return timestamp;
}

function dateTimeFormatter(timezone: string, locale: string): Intl.DateTimeFormat {
  const localeFormatters = dateTimeFormatters.get(locale);
  const cached = localeFormatters?.get(timezone);
  if (cached != null) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  if (localeFormatters == null) {
    dateTimeFormatters.set(locale, new Map([[timezone, formatter]]));
  } else {
    localeFormatters.set(timezone, formatter);
  }
  return formatter;
}

function relativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeTimeFormatters.get(locale);
  if (cached != null) {
    return cached;
  }
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "always",
    style: "narrow",
  });
  relativeTimeFormatters.set(locale, formatter);
  return formatter;
}

/** 日時を指定timezoneの絶対時刻へ整形する。 */
export function formatDateTime(value: string, timezone: string, locale: string): string {
  const timestamp = parseTimestamp(value);
  return dateTimeFormatter(timezone, locale).format(timestamp);
}

/** 日時を現在時刻からの相対時間へ整形する。 */
export function formatRelativeTime(value: string, now: Date, locale: string): string {
  const differenceMilliseconds = parseTimestamp(value) - now.getTime();
  const absoluteMilliseconds = Math.abs(differenceMilliseconds);
  let divisor: number;
  let unit: Intl.RelativeTimeFormatUnit;

  if (absoluteMilliseconds < 60 * 1000) {
    divisor = 1000;
    unit = "second";
  } else if (absoluteMilliseconds < 60 * 60 * 1000) {
    divisor = 60 * 1000;
    unit = "minute";
  } else if (absoluteMilliseconds < 24 * 60 * 60 * 1000) {
    divisor = 60 * 60 * 1000;
    unit = "hour";
  } else {
    divisor = 24 * 60 * 60 * 1000;
    unit = "day";
  }

  return relativeTimeFormatter(locale).format(Math.round(differenceMilliseconds / divisor), unit);
}

/** stallSinceから現在までの停滞時間を整形する。 */
export function formatStallDuration(stallSince: string, now: Date): string {
  const elapsedMilliseconds = now.getTime() - parseTimestamp(stallSince);
  if (elapsedMilliseconds < 0) {
    throw new RangeError("stallSinceは現在時刻より後にできません");
  }
  const elapsedHours = Math.floor(elapsedMilliseconds / (60 * 60 * 1000));
  if (elapsedHours < 1) {
    const elapsedMinutes = Math.floor(elapsedMilliseconds / (60 * 1000));
    return `${elapsedMinutes.toString()}分`;
  }
  if (elapsedHours < 24) {
    return `${elapsedHours.toString()}時間`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  const remainingHours = elapsedHours % 24;
  if (elapsedMilliseconds <= 7 * 24 * 60 * 60 * 1000) {
    if (remainingHours === 0) {
      return `${elapsedDays.toString()}日`;
    }
    return `${elapsedDays.toString()}日 ${remainingHours.toString()}時間`;
  }
  if (elapsedMilliseconds <= 365 * 24 * 60 * 60 * 1000) {
    return `${elapsedDays.toString()}日`;
  }
  const elapsedYears = Math.floor(elapsedDays / 365);
  const remainingDays = elapsedDays % 365;
  if (remainingDays === 0) {
    return `${elapsedYears.toString()}年`;
  }
  return `${elapsedYears.toString()}年 ${remainingDays.toString()}日`;
}

function waitingOnRoleName(role: WaitingOnRole): string {
  return ROLE_LABELS[role];
}

function waitingOnItemLabel(candidateId: string, summary: PublicSummaryDto): string {
  const relatedItem = summary.items.find((item) => item.nodeId === candidateId);
  if (relatedItem != null) {
    return relatedItem.displayReference;
  }
  const graphNode = summary.graph.nodes.find((node) => node.nodeId === candidateId);
  assertNonNullable(graphNode, `waitingOn項目 ${candidateId} がありません`);
  if (graphNode.kind !== "external_reference") {
    throw new TypeError(`waitingOn項目 ${candidateId} の表示名がありません`);
  }
  return graphNode.displayReference;
}

function textWaitingOnPart(text: string): WaitingOnDisplayPart {
  return { kind: "text", text };
}

function loginWaitingOnPart(login: string): WaitingOnDisplayPart {
  return { kind: "login", login };
}

function joinWaitingOnParts(
  groups: readonly (readonly WaitingOnDisplayPart[])[],
  separator: string,
): readonly WaitingOnDisplayPart[] {
  const parts: WaitingOnDisplayPart[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) {
      parts.push(textWaitingOnPart(separator));
    }
    parts.push(...group);
  }
  return parts;
}

function waitingOnPartsText(parts: readonly WaitingOnDisplayPart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case "text":
          return part.text;
        case "login":
          return `@${part.login}`;
        default:
          throw new UnreachableError(part);
      }
    })
    .join("");
}

function waitingOnKindParts(
  waitingOn: WaitingOnReference,
  summary: PublicSummaryDto,
  roleParts: (role: WaitingOnRole) => readonly WaitingOnDisplayPart[],
): readonly WaitingOnDisplayPart[] {
  switch (waitingOn.kind) {
    case "user":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} `),
        loginWaitingOnPart(waitingOn.candidateId),
      ];
    case "team":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} チーム ${waitingOn.candidateId}`),
      ];
    case "role":
      return roleParts(waitingOn.role);
    case "item":
      return [textWaitingOnPart(waitingOnItemLabel(waitingOn.candidateId, summary))];
    case "automation":
      return [textWaitingOnPart(`自動処理 ${waitingOn.candidateId}`)];
    case "unknown":
      return [textWaitingOnPart("不明")];
    default:
      throw new UnreachableError(waitingOn.kind);
  }
}

function resolveCurrentRole(
  role: WaitingOnRole,
  item: PublicItemSummaryDto,
): CurrentRoleResolution {
  switch (role) {
    case "author":
      switch (item.author.status) {
        case "identified":
          return { kind: "accounts", logins: [item.author.actor.login] };
        case "unavailable":
          return { kind: "deleted_account" };
        default:
          throw new UnreachableError(item.author);
      }
    case "assignee":
      if (item.assignees.length === 0) {
        return { kind: "unassigned" };
      }
      return { kind: "accounts", logins: item.assignees.map((assignee) => assignee.login) };
    case "maintainer":
    case "reviewer":
    case "merge_decider":
    case "ci":
    case "dependency":
    case "respondent":
    case "unknown":
      return { kind: "unresolved" };
    default:
      throw new UnreachableError(role);
  }
}

function unresolvedCurrentWaitingOnRoleParts(
  role: Exclude<WaitingOnRole, "author" | "assignee">,
): readonly WaitingOnDisplayPart[] {
  switch (role) {
    case "maintainer":
    case "reviewer":
    case "merge_decider":
      return [textWaitingOnPart(`${waitingOnRoleName(role)}の誰か`)];
    case "ci":
    case "dependency":
    case "respondent":
    case "unknown":
      return [textWaitingOnPart(waitingOnRoleName(role))];
    default:
      throw new UnreachableError(role);
  }
}

function currentWaitingOnRoleParts(
  role: WaitingOnRole,
  item: PublicItemSummaryDto,
): readonly WaitingOnDisplayPart[] {
  const resolution = resolveCurrentRole(role, item);
  switch (resolution.kind) {
    case "accounts":
      return [
        textWaitingOnPart(`${waitingOnRoleName(role)} `),
        ...joinWaitingOnParts(
          resolution.logins.map((login) => [loginWaitingOnPart(login)]),
          "、",
        ),
      ];
    case "deleted_account":
      return [textWaitingOnPart(`${waitingOnRoleName(role)} アカウント削除済み`)];
    case "unassigned":
      return [textWaitingOnPart(`${waitingOnRoleName(role)} 未割り当て`)];
    case "unresolved":
      if (role === "author" || role === "assignee") {
        throw new TypeError(`waitingOnの未解決roleが不正です: ${role}`);
      }
      return unresolvedCurrentWaitingOnRoleParts(role);
    default:
      throw new UnreachableError(resolution);
  }
}

function historyWaitingOnRoleParts(
  role: WaitingOnRole,
  item: PublicItemSummaryDto,
): readonly WaitingOnDisplayPart[] {
  if (role === "assignee") {
    return [textWaitingOnPart(`当時の${waitingOnRoleName(role)}`)];
  }
  return currentWaitingOnRoleParts(role, item);
}

/** 現在のwaitingOn候補を役割と対象がわかる表示断片へ変換する。 */
export function waitingOnLabelParts(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): readonly WaitingOnDisplayPart[] {
  return waitingOnKindParts(waitingOn, summary, (role) => currentWaitingOnRoleParts(role, item));
}

/** 現在のwaitingOn候補を役割と対象がわかる表示文字列へ変換する。 */
export function waitingOnLabel(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  return waitingOnPartsText(waitingOnLabelParts(waitingOn, item, summary));
}

/** 過去のwaitingOn候補を対象がわかる表示文字列へ変換する。 */
export function waitingOnHistoryLabel(
  waitingOn: WaitingOnReference,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  return waitingOnPartsText(
    waitingOnKindParts(waitingOn, summary, (role) => historyWaitingOnRoleParts(role, item)),
  );
}

function notificationWaitingOnCandidateLabelParts(
  waitingOn: NotificationWaitingOnReference,
): readonly WaitingOnDisplayPart[] {
  switch (waitingOn.kind) {
    case "user":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} `),
        loginWaitingOnPart(waitingOn.candidateId),
      ];
    case "team":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} チーム ${waitingOn.candidateId}`),
      ];
    case "role":
      return [textWaitingOnPart(waitingOnRoleName(waitingOn.role))];
    case "item":
      return [textWaitingOnPart(waitingOn.displayReference)];
    case "automation":
      return [textWaitingOnPart(`自動処理 ${waitingOn.candidateId}`)];
    case "unknown":
      return [textWaitingOnPart("不明")];
    default:
      throw new UnreachableError(waitingOn);
  }
}

/** 通知履歴の保存済みwaitingOnを表示用の断片へ変換する。 */
export function notificationWaitingOnLabelParts(
  waitingOn: readonly NotificationWaitingOnReference[],
): readonly WaitingOnDisplayPart[] {
  if (waitingOn.length === 0) {
    throw new TypeError("通知履歴のwaitingOnが空です");
  }
  return joinWaitingOnParts(waitingOn.map(notificationWaitingOnCandidateLabelParts), "、");
}

/** confidenceを確定、推定、候補の表示へ変換する。 */
export function confidencePresentation(
  confidence: number,
  thresholds: ConfidenceThresholds,
): ConfidencePresentation {
  if (confidence < 0 || confidence > 1) {
    throw new RangeError("confidenceは0以上1以下でなければなりません");
  }
  if (confidence === 1) {
    return {
      level: "confirmed",
      label: "確定",
      fieldQualifier: "",
    };
  }
  if (confidence >= thresholds.high) {
    return {
      level: "high_estimate",
      label: "確度の高い推定",
      fieldQualifier: "推定",
    };
  }
  if (confidence >= thresholds.medium) {
    return {
      level: "estimate",
      label: "推定",
      fieldQualifier: "推定",
    };
  }
  return {
    level: "uncertain",
    label: "未確定",
    fieldQualifier: "候補",
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 現在の対応者を大文字小文字を区別しないキーへ変換する。 */
export function currentResponseSubjectKey(subject: CurrentResponseSubject): string {
  switch (subject.kind) {
    case "user":
      return `user:${subject.login.toLowerCase()}`;
    case "team":
      return `team:${subject.teamId.toLowerCase()}`;
    default:
      throw new UnreachableError(subject);
  }
}

function currentResponseSubjectLabel(subject: CurrentResponseSubject): string {
  switch (subject.kind) {
    case "user":
      return `@${subject.login}`;
    case "team":
      return `チーム ${subject.teamId}`;
    default:
      throw new UnreachableError(subject);
  }
}

function currentResponseRoleDisplayLabel(
  role: CurrentResponseRole,
  item: PublicItemSummaryDto,
): string {
  const roleName = currentResponseRoleLabel(role);
  const resolution = resolveCurrentRole(role, item);
  switch (resolution.kind) {
    case "accounts":
      return `${roleName} ${resolution.logins.map((login) => `@${login}`).join("、")}`;
    case "deleted_account":
      return `${roleName} アカウント削除済み`;
    case "unassigned":
      return `${roleName} 未割り当て`;
    case "unresolved":
      return `${roleName}の役割`;
    default:
      throw new UnreachableError(resolution);
  }
}

/** 現在の対応者を項目の確定情報を含む表示文字列へ変換する。 */
export function currentResponseResponsibleLabel(
  responsible: CurrentResponseResponsible,
  item: PublicItemSummaryDto,
): string {
  const responsibleKind = responsible.kind;
  switch (responsibleKind) {
    case "user":
      return `@${responsible.candidateId} ${currentResponseRoleLabel(responsible.role)}`;
    case "team":
      return `チーム ${responsible.candidateId} ${currentResponseRoleLabel(responsible.role)}`;
    case "role":
      return currentResponseRoleDisplayLabel(responsible.role, item);
    default:
      throw new UnreachableError(responsibleKind);
  }
}

function formatCurrentResponseText(item: PublicItemSummaryDto): string {
  return item.currentResponses
    .flatMap((response) =>
      response.responsible.map((responsible) => currentResponseResponsibleLabel(responsible, item)),
    )
    .join("\n");
}

function currentResponseSubjectFromResponsible(
  responsible: CurrentResponseResponsible,
): CurrentResponseSubject | undefined {
  switch (responsible.kind) {
    case "user":
      return { kind: "user", login: responsible.candidateId };
    case "team":
      return { kind: "team", teamId: responsible.candidateId };
    case "role":
      return undefined;
  }
}

type CurrentResponseSubjectMembership =
  "verified" | "unverified_displayed" | "unverified_missing" | "absent";

type CurrentResponseSubjectSupport = Readonly<{
  subject: CurrentResponseSubject;
  verified: boolean;
}>;

interface CurrentResponseSubjectRowAccumulator {
  subject: CurrentResponseSubject;
  label: string;
  itemCount: number;
  hasUnverifiedDisplayedMembership: boolean;
  currentItemNodeIds: Set<string>;
  longestStallSince: string;
  longestMembershipVerified: boolean;
  stalenessUnverified: boolean;
}

type PotentialCurrentResponseSubjectItem = Readonly<{
  nodeId: string;
  stallTimestamp: number;
  stalenessUnverified: boolean;
}>;

type CurrentResponseSubjectChange = Extract<
  PublicItemSummaryDto["currentResponseSubjectChanges"],
  Readonly<{ scope: "bounded" }>
>["addableSubjects"][number];

function currentResponseSubjectFromChange(
  subject: CurrentResponseSubjectChange,
): CurrentResponseSubject {
  switch (subject.kind) {
    case "user":
      return { kind: "user", login: subject.candidateId };
    case "team":
      return { kind: "team", teamId: subject.candidateId };
    default:
      throw new UnreachableError(subject);
  }
}

function currentResponseSubjectChangeMatches(
  subject: CurrentResponseSubjectChange,
  subjectKeys: ReadonlySet<string>,
): boolean {
  return subjectKeys.has(currentResponseSubjectKey(currentResponseSubjectFromChange(subject)));
}

function currentResponseSubjectCanBeAdded(
  item: PublicItemSummaryDto,
  subjectKeys: ReadonlySet<string>,
): boolean {
  const changes = item.currentResponseSubjectChanges;
  if (changes.scope === "unbounded") {
    return true;
  }
  return changes.addableSubjects.some((subject) =>
    currentResponseSubjectChangeMatches(subject, subjectKeys),
  );
}

function currentResponseSubjectMembershipFor(
  item: PublicItemSummaryDto,
  subjectKeys: ReadonlySet<string>,
): CurrentResponseSubjectMembership {
  let unverifiedDisplayed = false;
  for (const response of item.currentResponses) {
    if (
      !response.responsible.some((responsible) =>
        responseResponsibleMatchesSubjects(responsible, subjectKeys),
      )
    ) {
      continue;
    }
    if (!response.subjectMembershipUnverified) {
      return "verified";
    }
    unverifiedDisplayed = true;
  }
  if (unverifiedDisplayed) {
    return "unverified_displayed";
  }
  return currentResponseSubjectCanBeAdded(item, subjectKeys) ? "unverified_missing" : "absent";
}

/** 現在の対応者から、人物一覧へ表示する人とチームを重複なく返す。 */
export function resolveCurrentResponseSubjects(
  item: PublicItemSummaryDto,
): readonly CurrentResponseSubject[] {
  const subjects: CurrentResponseSubject[] = [];
  const subjectKeys = new Set<string>();
  for (const response of item.currentResponses) {
    for (const responsible of response.responsible) {
      const subject = currentResponseSubjectFromResponsible(responsible);
      if (subject == null) {
        continue;
      }
      const key = currentResponseSubjectKey(subject);
      if (subjectKeys.has(key)) {
        continue;
      }
      subjectKeys.add(key);
      subjects.push(subject);
    }
  }
  return subjects;
}

/** 公開summaryから現在の対応者のチーム識別子を昇順で集める。 */
export function collectCurrentResponseTeamIds(summary: PublicSummaryDto): readonly string[] {
  const teamIds = new Map<string, string>();
  for (const item of summary.items) {
    for (const subject of resolveCurrentResponseSubjects(item)) {
      if (subject.kind !== "team") {
        continue;
      }
      const key = currentResponseSubjectKey(subject);
      if (!teamIds.has(key)) {
        teamIds.set(key, subject.teamId);
      }
    }
  }
  return [...teamIds.values()].sort(compareStrings);
}

function hasCurrentResponseSubjectSetUnverified(
  summary: PublicSummaryDto,
  kind: CurrentResponseSubject["kind"] | undefined,
): boolean {
  const globalSupports = new Map<string, CurrentResponseSubjectSupport>();
  for (const item of summary.items) {
    if (item.currentResponseSubjectChanges.scope === "unbounded") {
      return true;
    }
    const itemSupports = currentResponseSubjectSupportsForItem(item);
    for (const [key, support] of itemSupports) {
      const previous = globalSupports.get(key);
      globalSupports.set(key, {
        subject: support.subject,
        verified: (previous?.verified ?? false) || support.verified,
      });
    }
  }
  for (const support of globalSupports.values()) {
    if ((kind == null || support.subject.kind === kind) && !support.verified) {
      return true;
    }
  }
  for (const item of summary.items) {
    if (item.currentResponseSubjectChanges.scope === "unbounded") {
      throw new TypeError("現在対応主体のunboundedな変化を集約後に処理できません");
    }
    for (const subjectChange of item.currentResponseSubjectChanges.addableSubjects) {
      const subject = currentResponseSubjectFromChange(subjectChange);
      if (kind != null && subject.kind !== kind) {
        continue;
      }
      if (!globalSupports.get(currentResponseSubjectKey(subject))?.verified) {
        return true;
      }
    }
    for (const subjectChange of item.currentResponseSubjectChanges.removableSubjects) {
      const subject = currentResponseSubjectFromChange(subjectChange);
      if (kind != null && subject.kind !== kind) {
        continue;
      }
      const support = globalSupports.get(currentResponseSubjectKey(subject));
      if (support != null && !support.verified) {
        return true;
      }
    }
  }
  return false;
}

function addPotentialCurrentResponseSubjectItem(
  itemsBySubjectKey: Map<string, PotentialCurrentResponseSubjectItem[]>,
  subject: CurrentResponseSubject,
  item: PotentialCurrentResponseSubjectItem,
): void {
  const key = currentResponseSubjectKey(subject);
  const items = itemsBySubjectKey.get(key);
  if (items == null) {
    itemsBySubjectKey.set(key, [item]);
    return;
  }
  if (!items.some((candidate) => candidate.nodeId === item.nodeId)) {
    items.push(item);
  }
}

function potentialCurrentResponseSubjectItem(
  item: PublicItemSummaryDto,
): PotentialCurrentResponseSubjectItem {
  return {
    nodeId: item.nodeId,
    stallTimestamp: parseTimestamp(item.stallSince),
    stalenessUnverified: item.aiAnalysis.unverifiedValues.includes("staleness"),
  };
}

function currentResponseSubjectSupportsForItem(
  item: PublicItemSummaryDto,
): ReadonlyMap<string, CurrentResponseSubjectSupport> {
  const supports = new Map<string, CurrentResponseSubjectSupport>();
  for (const response of item.currentResponses) {
    for (const responsible of response.responsible) {
      const subject = currentResponseSubjectFromResponsible(responsible);
      if (subject == null) {
        continue;
      }
      const key = currentResponseSubjectKey(subject);
      const previous = supports.get(key);
      supports.set(key, {
        subject,
        verified: (previous?.verified ?? false) || !response.subjectMembershipUnverified,
      });
    }
  }
  return supports;
}

/** 現在の対応者一覧に現在入力で未検証の人物またはチームがあるかを返す。 */
export function hasCurrentResponseSubjectListingUnverified(summary: PublicSummaryDto): boolean {
  return hasCurrentResponseSubjectSetUnverified(summary, undefined);
}

/** 所属チームの選択肢に現在入力で未検証のチームがあるかを返す。 */
export function hasCurrentResponseTeamOptionsUnverified(summary: PublicSummaryDto): boolean {
  return hasCurrentResponseSubjectSetUnverified(summary, "team");
}

/** 公開summaryから現在の対応者ごとの集計行を作る。 */
export function collectCurrentResponseSubjectRows(
  summary: PublicSummaryDto,
  now: Date,
): readonly CurrentResponseSubjectRow[] {
  const accumulators = new Map<string, CurrentResponseSubjectRowAccumulator>();
  const addableItemsBySubjectKey = new Map<string, PotentialCurrentResponseSubjectItem[]>();
  const unboundedItems: PotentialCurrentResponseSubjectItem[] = [];
  for (const item of summary.items) {
    const potentialItem = potentialCurrentResponseSubjectItem(item);
    const changes = item.currentResponseSubjectChanges;
    if (changes.scope === "unbounded") {
      unboundedItems.push(potentialItem);
    } else {
      for (const subjectChange of changes.addableSubjects) {
        addPotentialCurrentResponseSubjectItem(
          addableItemsBySubjectKey,
          currentResponseSubjectFromChange(subjectChange),
          potentialItem,
        );
      }
    }
    const itemSupports = currentResponseSubjectSupportsForItem(item);
    for (const [key, support] of itemSupports) {
      const membershipVerified = support.verified;
      const stalenessUnverified = item.aiAnalysis.unverifiedValues.includes("staleness");
      const accumulator = accumulators.get(key);
      if (accumulator == null) {
        accumulators.set(key, {
          subject: support.subject,
          label: currentResponseSubjectLabel(support.subject),
          itemCount: 1,
          hasUnverifiedDisplayedMembership: !membershipVerified,
          currentItemNodeIds: new Set([item.nodeId]),
          longestStallSince: item.stallSince,
          longestMembershipVerified: membershipVerified,
          stalenessUnverified,
        });
        continue;
      }
      accumulator.itemCount += 1;
      accumulator.hasUnverifiedDisplayedMembership ||= !membershipVerified;
      accumulator.currentItemNodeIds.add(item.nodeId);
      accumulator.stalenessUnverified ||= stalenessUnverified;
      const stallTimestamp = parseTimestamp(item.stallSince);
      const longestTimestamp = parseTimestamp(accumulator.longestStallSince);
      if (stallTimestamp < longestTimestamp) {
        accumulator.longestStallSince = item.stallSince;
        accumulator.longestMembershipVerified = membershipVerified;
      } else if (stallTimestamp === longestTimestamp) {
        accumulator.longestMembershipVerified ||= membershipVerified;
      }
    }
  }

  return [...accumulators.values()]
    .map((accumulator) => {
      const addableItems = new Map<string, PotentialCurrentResponseSubjectItem>();
      for (const item of unboundedItems) {
        if (!accumulator.currentItemNodeIds.has(item.nodeId)) {
          addableItems.set(item.nodeId, item);
        }
      }
      const subjectKey = currentResponseSubjectKey(accumulator.subject);
      for (const item of addableItemsBySubjectKey.get(subjectKey) ?? []) {
        if (!accumulator.currentItemNodeIds.has(item.nodeId)) {
          addableItems.set(item.nodeId, item);
        }
      }
      const longestTimestamp = parseTimestamp(accumulator.longestStallSince);
      const addableMembershipCanChangeLongest = [...addableItems.values()].some(
        (item) => item.stalenessUnverified || item.stallTimestamp < longestTimestamp,
      );
      return {
        subject: accumulator.subject,
        label: accumulator.label,
        itemCount: accumulator.itemCount,
        itemCountUnverified: addableItems.size > 0 || accumulator.hasUnverifiedDisplayedMembership,
        longestStallDuration: formatStallDuration(accumulator.longestStallSince, now),
        longestStallUnverified:
          addableMembershipCanChangeLongest ||
          !accumulator.longestMembershipVerified ||
          accumulator.stalenessUnverified,
      };
    })
    .sort((left, right) => {
      const itemCountOrder = right.itemCount - left.itemCount;
      return itemCountOrder === 0 ? compareStrings(left.label, right.label) : itemCountOrder;
    });
}

function currentResponseSubjectKeys(
  login: string,
  teamIds: readonly string[],
): ReadonlySet<string> {
  return new Set([
    currentResponseSubjectKey({ kind: "user", login }),
    ...teamIds.map((teamId) => currentResponseSubjectKey({ kind: "team", teamId })),
  ]);
}

function responseResponsibleMatchesSubjects(
  responsible: CurrentResponseResponsible,
  subjectKeys: ReadonlySet<string>,
): boolean {
  if (responsible.kind === "user") {
    return subjectKeys.has(
      currentResponseSubjectKey({ kind: "user", login: responsible.candidateId }),
    );
  }
  if (responsible.kind === "team") {
    return subjectKeys.has(
      currentResponseSubjectKey({ kind: "team", teamId: responsible.candidateId }),
    );
  }
  return false;
}

function currentResponseSelectedSubjectMembership(
  item: PublicItemSummaryDto,
  subjectKeys: ReadonlySet<string>,
): CurrentResponseSubjectMembership {
  return currentResponseSubjectMembershipFor(item, subjectKeys);
}

/** loginまたは所属teamの項目集合が現在入力で未検証かを返す。 */
export function hasCurrentResponseSubjectItemsUnverified(
  summary: PublicSummaryDto,
  login: string,
  teamIds: readonly string[],
): boolean {
  const subjectKeys = currentResponseSubjectKeys(login, teamIds);
  return summary.items.some((item) => {
    const membership = currentResponseSelectedSubjectMembership(item, subjectKeys);
    return membership === "unverified_displayed" || membership === "unverified_missing";
  });
}

/** loginまたは所属teamが現在の対応者に含まれる項目のnode ID集合を返す。 */
export function selectCurrentResponseSubjectItemNodeIds(
  summary: PublicSummaryDto,
  login: string,
  teamIds: readonly string[],
): ReadonlySet<string> {
  const subjectKeys = currentResponseSubjectKeys(login, teamIds);
  return new Set(
    summary.items
      .filter((item) =>
        item.currentResponses.some((response) =>
          response.responsible.some((responsible) =>
            responseResponsibleMatchesSubjects(responsible, subjectKeys),
          ),
        ),
      )
      .map((item) => item.nodeId),
  );
}

/** loginまたは所属teamに対応する現在のresponseを返す。 */
export function selectCurrentResponseSubjectPrimaryResponse(
  item: PublicItemSummaryDto,
  login: string,
  teamIds: readonly string[],
): PublicPersonalReminderResponseDto {
  const subjectKeys = currentResponseSubjectKeys(login, teamIds);
  const matchingResponses = item.currentResponses.filter((candidate) =>
    candidate.responsible.some((responsible) =>
      responseResponsibleMatchesSubjects(responsible, subjectKeys),
    ),
  );
  const response =
    matchingResponses.find((candidate) => !candidate.subjectMembershipUnverified) ??
    matchingResponses[0];
  assertNonNullable(response, `項目 ${item.nodeId} に選択中の現在の対応がありません`);
  return response;
}

/** URLがhttps://github.com配下かを検証する。 */
export function validateGitHubUrl(value: string): GitHubUrlResult {
  if (!URL.canParse(value)) {
    return {
      allowed: false,
    };
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return {
      allowed: false,
    };
  }
  return {
    allowed: true,
    url: url.toString(),
  };
}

/** 公開summaryから一覧表の表示行を作る。 */
export function createItemTableRows(summary: PublicSummaryDto, now: Date): readonly ItemTableRow[] {
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );

  return summary.items.map((item) => {
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
    const stallDurationMilliseconds = now.getTime() - parseTimestamp(item.stallSince);
    if (stallDurationMilliseconds < 0) {
      throw new RangeError("stallSinceは現在時刻より後にできません");
    }
    return {
      item,
      repositoryText: repository.fullName,
      currentResponseText: formatCurrentResponseText(item),
      stallDurationMilliseconds,
    };
  });
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** summaryとdetailsの項目を検証してnode IDで引けるようにする。 */
export function createItemDetailsMap(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
): ReadonlyMap<string, PublicItemDetailsDto> {
  if (summary.runId !== details.runId || summary.generatedAt !== details.generatedAt) {
    throw new TypeError("summaryとdetailsの生成runが一致しません");
  }
  const summaryByNodeId = new Map(summary.items.map((item) => [item.nodeId, item]));
  const detailsByNodeId = new Map<string, PublicItemDetailsDto>();
  for (const itemDetails of details.items) {
    if (detailsByNodeId.has(itemDetails.summary.nodeId)) {
      throw new TypeError(`detailsの項目 ${itemDetails.summary.nodeId} が重複しています`);
    }
    const summaryItem = summaryByNodeId.get(itemDetails.summary.nodeId);
    assertNonNullable(
      summaryItem,
      `detailsの項目 ${itemDetails.summary.nodeId} がsummaryにありません`,
    );
    if (JSON.stringify(summaryItem) !== JSON.stringify(itemDetails.summary)) {
      throw new TypeError(`summaryとdetailsの項目 ${itemDetails.summary.nodeId} が一致しません`);
    }
    detailsByNodeId.set(itemDetails.summary.nodeId, itemDetails);
  }
  for (const item of summary.items) {
    if (!detailsByNodeId.has(item.nodeId)) {
      throw new TypeError(`summaryの項目 ${item.nodeId} がdetailsにありません`);
    }
  }
  return detailsByNodeId;
}

function actorSearchName(actor: PublicActor): string {
  return actor.type === "system" ? actor.name : actor.login;
}

/** 公開DTO内のリポジトリ、番号、タイトル、アクター、team、ラベルを検索する。 */
export function searchItemNodeIds(
  summary: PublicSummaryDto,
  detailsByNodeId: ReadonlyMap<string, PublicItemDetailsDto>,
  query: string,
): readonly string[] {
  const tokens = normalizedSearchText(query).trim().split(/\s+/u);
  if (tokens.length === 1 && tokens[0] === "") {
    return summary.items.map((item) => item.nodeId);
  }
  const repositoriesById = new Map(
    summary.repositories.map((repository) => [repository.id, repository]),
  );
  return summary.items
    .filter((item) => {
      const repository = repositoriesById.get(item.repositoryId);
      const details = detailsByNodeId.get(item.nodeId);
      assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
      assertNonNullable(details, `項目 ${item.nodeId} のdetailsがありません`);
      const searchText = normalizedSearchText(
        [
          repository.fullName,
          repository.name,
          item.number.toString(),
          `#${item.number.toString()}`,
          item.displayReference,
          item.title,
          ...item.waitingOn.flatMap((waitingOn) => [
            waitingOnLabel(waitingOn, item, summary),
            waitingOn.candidateId,
            waitingOn.reasonSummary,
          ]),
          ...item.currentResponses.flatMap((response) => [
            currentResponseStatusLabel(response.status),
            response.action.summary,
            ...response.responsible.flatMap((responsible) => [
              currentResponseResponsibleLabel(responsible, item),
              responsible.candidateId,
            ]),
            ...response.evidence.map((evidence) => evidence.summary),
            ...(response.status === "waiting" ? [response.waitingFor.action] : []),
          ]),
          ...(item.author.status === "identified" ? [item.author.actor.login] : []),
          ...(details.latestEventActor.status === "present"
            ? [actorSearchName(details.latestEventActor.actor)]
            : []),
          ...item.assignees.map((assignee) => assignee.login),
          ...details.labels,
        ].join("\n"),
      );
      return tokens.every((token) => searchText.includes(token));
    })
    .map((item) => item.nodeId);
}

function rowMatchesTableFilter(row: ItemTableRow, key: TableFilterKey, value: string): boolean {
  switch (key) {
    case "repository":
      return row.repositoryText === value;
    case "type":
      return row.item.type === value;
    case "status":
      if (value === "all") {
        return true;
      }
      return row.item.status === value;
    case "importance":
      return row.item.importance.level === value;
    case "waitingOn":
      return normalizedSearchText(row.currentResponseText).includes(normalizedSearchText(value));
    case "responseStatus":
      return row.item.currentResponses.some((response) => response.status === value);
    case "stall": {
      const definition = STALL_FILTER_DEFINITIONS.find((candidate) => candidate.value === value);
      assertNonNullable(definition, `未対応の停滞時間の絞り込みです: ${value}`);
      return row.stallDurationMilliseconds >= definition.thresholdMilliseconds;
    }
    case "aiAnalysis":
      if (value === "unverified") {
        return hasItemAiUnverifiedValue(row.item);
      }
      if (value === "partial") {
        return row.item.aiAnalysis.omission === "partial";
      }
      if (value === "all") {
        return row.item.aiAnalysis.omission === "all";
      }
      throw new TypeError(`未対応のAI利用状況の絞り込みです: ${value}`);
    default:
      throw new UnreachableError(key);
  }
}

function compareDeadlineRows(
  left: ItemTableRow,
  right: ItemTableRow,
  direction: ItemSort["direction"],
): number {
  const leftDeadline = left.item.deadline;
  const rightDeadline = right.item.deadline;
  if (leftDeadline.status !== rightDeadline.status) {
    return leftDeadline.status === "not_available" ? 1 : -1;
  }
  if (leftDeadline.status === "not_available" || rightDeadline.status === "not_available") {
    return 0;
  }
  const directionMultiplier = direction === "ascending" ? 1 : -1;
  const levelOrder =
    (DEADLINE_LEVEL_SORT_SCORES[leftDeadline.level] -
      DEADLINE_LEVEL_SORT_SCORES[rightDeadline.level]) *
    directionMultiplier;
  if (levelOrder !== 0) {
    return levelOrder;
  }
  if (leftDeadline.date == null || rightDeadline.date == null) {
    return 0;
  }
  return compareStrings(leftDeadline.date, rightDeadline.date) * -directionMultiplier;
}

function compareTableRows(
  left: ItemTableRow,
  right: ItemTableRow,
  key: ItemSortKey,
  direction: ItemSort["direction"],
): number {
  switch (key) {
    case "attention":
      return left.item.attention.score - right.item.attention.score;
    case "importance":
      return left.item.importance.score - right.item.importance.score;
    case "stall":
      return left.stallDurationMilliseconds - right.stallDurationMilliseconds;
    case "deadline":
      return compareDeadlineRows(left, right, direction);
    default:
      throw new UnreachableError(key);
  }
}

function compareTableRowTieBreakers(
  left: ItemTableRow,
  right: ItemTableRow,
  key: ItemSortKey,
): number {
  switch (key) {
    case "attention": {
      const stallOrder = right.stallDurationMilliseconds - left.stallDurationMilliseconds;
      if (stallOrder !== 0) {
        return stallOrder;
      }
      break;
    }
    case "importance": {
      const attentionOrder = right.item.attention.score - left.item.attention.score;
      if (attentionOrder !== 0) {
        return attentionOrder;
      }
      break;
    }
    case "stall":
      break;
    case "deadline":
      break;
    default:
      throw new UnreachableError(key);
  }
  return compareStrings(left.item.nodeId, right.item.nodeId);
}

/** 一覧表の全列filterとsortを適用する。 */
export function filterAndSortTableRows(
  rows: readonly ItemTableRow[],
  filters: TableFilters,
  sort: ItemSort,
): readonly ItemTableRow[] {
  const filteredRows = rows.filter((row) =>
    Object.entries(filters).every(([key, value]) => {
      if (value.length === 0) {
        if (key === "status") {
          return !isTerminalStatus(row.item.status);
        }
        return true;
      }
      if (
        key !== "repository" &&
        key !== "type" &&
        key !== "status" &&
        key !== "importance" &&
        key !== "waitingOn" &&
        key !== "responseStatus" &&
        key !== "stall" &&
        key !== "aiAnalysis"
      ) {
        throw new TypeError(`未対応の表列です: ${key}`);
      }
      return rowMatchesTableFilter(row, key, value);
    }),
  );
  const direction = sort.direction === "ascending" ? 1 : -1;
  return filteredRows.sort((left, right) => {
    const order = compareTableRows(left, right, sort.key, sort.direction);
    if (order !== 0) {
      return sort.key === "deadline" ? order : order * direction;
    }
    return compareTableRowTieBreakers(left, right, sort.key);
  });
}

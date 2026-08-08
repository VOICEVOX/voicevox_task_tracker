import {
  type PublicDetailsDto,
  type PublicItemDetailsDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";

type PublicRepositoryDto = PublicSummaryDto["repositories"][number];
type ConfidenceThresholds = PublicSummaryDto["confidenceThresholds"];
type ItemType = PublicItemSummaryDto["type"];
type Status = PublicItemSummaryDto["status"];
type Severity = PublicItemSummaryDto["severity"];
type ImportanceLevel = PublicItemSummaryDto["importance"]["level"];
type AiAnalysisStatus = PublicItemSummaryDto["aiAnalysis"]["status"];
type WaitingOnCandidate = PublicItemSummaryDto["waitingOn"][number];
type WaitingOnReference = Pick<WaitingOnCandidate, "candidateId" | "kind" | "role">;
type WaitingOnRole = WaitingOnCandidate["role"];
type PublicActor = Extract<
  PublicItemDetailsDto["latestEventActor"],
  Readonly<{ status: "present" }>
>["actor"];

/** attention queueで使う対応優先度。 */
export type AttentionPriority = Readonly<{
  label: string;
  rank: number;
}>;

/** 一覧表で並び替えと絞り込みの対象にする列。 */
export type TableColumnKey =
  "repository" | "type" | "status" | "importance" | "waitingOn" | "stall";

/** 概要の対応が必要な項目で並び替えの対象にするキー。 */
export type OverviewSortKey = "attention" | TableColumnKey;

/** 一覧表で絞り込みの対象にする項目。 */
export type TableFilterKey = TableColumnKey | "aiAnalysis";

/** 一覧表で選択式の絞り込みにする列。 */
export type TableSelectFilterKey = Exclude<TableFilterKey, "waitingOn">;

/** 一覧表の並び順。 */
export type TableSort = Readonly<{
  key: TableColumnKey;
  direction: "ascending" | "descending";
}>;

/** 概要の対応が必要な項目の並び順。 */
export type OverviewSort = Readonly<{
  key: OverviewSortKey;
  direction: TableSort["direction"];
}>;

/** 一覧表で別の列を選んだときの自然な並び順。 */
export const TABLE_COLUMN_NATURAL_SORT_DIRECTIONS: Readonly<
  Record<TableColumnKey, TableSort["direction"]>
> = {
  repository: "ascending",
  type: "ascending",
  status: "ascending",
  importance: "descending",
  waitingOn: "ascending",
  stall: "descending",
};

/** 概要で別の並び順を選んだときの自然な方向。 */
export const OVERVIEW_NATURAL_SORT_DIRECTIONS: Readonly<
  Record<OverviewSortKey, OverviewSort["direction"]>
> = {
  attention: "descending",
  ...TABLE_COLUMN_NATURAL_SORT_DIRECTIONS,
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
  repository: PublicRepositoryDto;
  repositoryText: string;
  typeText: string;
  statusText: string;
  importanceText: string;
  waitingOnText: string;
  stallText: string;
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

/** 特定できた待ち相手。 */
export type WaitingSubject =
  Readonly<{ kind: "user"; login: string }> | Readonly<{ kind: "team"; teamId: string }>;

/** 待ち相手ごとの集計行。 */
export type WaitingSubjectRow = Readonly<{
  subject: WaitingSubject;
  label: string;
  itemCount: number;
  longestStallDuration: string;
}>;

interface WaitingSubjectRowAccumulator {
  subject: WaitingSubject;
  label: string;
  itemCount: number;
  longestStallSince: string;
}

const STATUS_LABELS = {
  waiting_for_assessment: "内容確認待ち",
  waiting_for_owner: "担当決め待ち",
  waiting_for_decision: "方針判断待ち",
  waiting_for_review: "レビュー待ち",
  waiting_for_revision: "修正待ち",
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

/** AI判定を利用できず縮退した項目を表す絞り込み値。 */
export const AI_ANALYSIS_DEGRADED_FILTER_VALUE = "degraded";

const AI_ANALYSIS_FILTER_OPTIONS = [
  {
    label: "AI判定を利用できず",
    value: AI_ANALYSIS_DEGRADED_FILTER_VALUE,
  },
] satisfies readonly TableFilterOption[];

const SEVERITY_RANKS = {
  none: 0,
  watch: 1,
  urgent: 2,
  critical: 3,
} satisfies Readonly<Record<Severity, number>>;

const dateTimeFormatters = new Map<string, Map<string, Intl.DateTimeFormat>>();
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

const ROLE_LABELS = {
  author: "作成者",
  maintainer: "メンテナー",
  reviewer: "レビュワー",
  assignee: "担当者",
  dependency: "依存項目",
  merge_decider: "マージ判断者",
  ci: "CI",
  unknown: "不明",
} satisfies Readonly<Record<WaitingOnRole, string>>;

/** 一覧表の空の絞り込み条件を作る。 */
export function createEmptyTableFilters(): TableFilters {
  return {
    repository: "",
    type: "",
    status: "",
    importance: "",
    waitingOn: "",
    stall: "",
    aiAnalysis: "",
  };
}

/** 列が選択式の絞り込み対象かを返す。 */
export function isTableSelectFilterKey(key: TableFilterKey): key is TableSelectFilterKey {
  return key !== "waitingOn";
}

/** AI判定を利用できず縮退した状態かを返す。 */
export function isAiAnalysisDegraded(status: AiAnalysisStatus): boolean {
  switch (status) {
    case "failed":
    case "deferred":
      return true;
    case "used":
    case "not_required":
    case "disabled":
    case "not_recorded":
      return false;
    default:
      throw new UnreachableError(status);
  }
}

function itemTypeLabel(type: ItemType): string {
  return ITEM_TYPE_LABELS[type];
}

/** statusの日本語表示名を返す。 */
export function statusLabel(status: Status): string {
  return STATUS_LABELS[status];
}

/** 重要度levelの日本語表示名を返す。 */
export function importanceLevelLabel(level: ImportanceLevel): string {
  return IMPORTANCE_LEVEL_LABELS[level];
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

  for (const item of summary.items) {
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `項目 ${item.nodeId} のrepositoryがありません`);
    repositoryValues.add(repository.fullName);
    typeValues.add(item.type);
    statusValues.add(item.status);
    importanceValues.add(item.importance.level);
  }

  return {
    repository: [...repositoryValues]
      .sort(compareStrings)
      .map((value) => ({ label: value, value })),
    type: createPresentTableFilterOptions(ITEM_TYPE_LABELS, typeValues),
    status: createPresentTableFilterOptions(STATUS_LABELS, statusValues),
    importance: createPresentTableFilterOptions(IMPORTANCE_LEVEL_LABELS, importanceValues),
    stall: STALL_FILTER_DEFINITIONS.map(({ label, value }) => ({ label, value })),
    aiAnalysis: AI_ANALYSIS_FILTER_OPTIONS,
  };
}

/** 設定済みラベルルールのpriorityWeightをqueue表示へ変換する。 */
export function attentionPriority(item: PublicItemSummaryDto): AttentionPriority {
  return {
    label: item.priorityWeight === 0 ? "標準" : item.priorityWeight.toString(),
    rank: item.priorityWeight,
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

function waitingOnKindLabel(
  waitingOn: WaitingOnReference,
  summary: PublicSummaryDto,
  roleLabel: (role: WaitingOnRole) => string,
): string {
  switch (waitingOn.kind) {
    case "user":
      return `${waitingOnRoleName(waitingOn.role)} @${waitingOn.candidateId}`;
    case "team":
      return `${waitingOnRoleName(waitingOn.role)} チーム ${waitingOn.candidateId}`;
    case "role":
      return roleLabel(waitingOn.role);
    case "item":
      return waitingOnItemLabel(waitingOn.candidateId, summary);
    case "automation":
      return `自動処理 ${waitingOn.candidateId}`;
    case "unknown":
      return "不明";
    default:
      throw new UnreachableError(waitingOn.kind);
  }
}

function currentWaitingOnRoleLabel(role: WaitingOnRole, item: PublicItemSummaryDto): string {
  switch (role) {
    case "author":
      switch (item.author.status) {
        case "identified":
          return `${waitingOnRoleName(role)} @${item.author.actor.login}`;
        case "unavailable":
          return `${waitingOnRoleName(role)} アカウント削除済み`;
        default:
          throw new UnreachableError(item.author);
      }
    case "assignee":
      return item.assignees.length === 0
        ? `${waitingOnRoleName(role)} 未割り当て`
        : `${waitingOnRoleName(role)} ${item.assignees
            .map((assignee) => `@${assignee.login}`)
            .join("、")}`;
    case "maintainer":
    case "reviewer":
    case "merge_decider":
      return `${waitingOnRoleName(role)}の誰か`;
    case "ci":
    case "dependency":
    case "unknown":
      return waitingOnRoleName(role);
    default:
      throw new UnreachableError(role);
  }
}

/** 待ち相手を大文字小文字を区別しないキーへ変換する。 */
export function waitingSubjectKey(subject: WaitingSubject): string {
  switch (subject.kind) {
    case "user":
      return `user:${subject.login.toLowerCase()}`;
    case "team":
      return `team:${subject.teamId.toLowerCase()}`;
    default:
      throw new UnreachableError(subject);
  }
}

/** 待ち相手を画面表示用の日本語ラベルへ変換する。 */
export function waitingSubjectLabel(subject: WaitingSubject): string {
  switch (subject.kind) {
    case "user":
      return `@${subject.login}`;
    case "team":
      return `チーム ${subject.teamId}`;
    default:
      throw new UnreachableError(subject);
  }
}

function historyWaitingOnRoleLabel(role: WaitingOnRole, item: PublicItemSummaryDto): string {
  if (role === "assignee") {
    return `当時の${waitingOnRoleName(role)}`;
  }
  return currentWaitingOnRoleLabel(role, item);
}

/** 現在のwaitingOn候補を役割と対象がわかる表示文字列へ変換する。 */
export function waitingOnLabel(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  return waitingOnKindLabel(waitingOn, summary, (role) => currentWaitingOnRoleLabel(role, item));
}

/** 過去のwaitingOn候補を対象がわかる表示文字列へ変換する。 */
export function waitingOnHistoryLabel(
  waitingOn: WaitingOnReference,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  return waitingOnKindLabel(waitingOn, summary, (role) => historyWaitingOnRoleLabel(role, item));
}

/** waitingOn候補から特定できる待ち相手を返す。 */
function resolveWaitingOnCandidateSubjects(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
): readonly WaitingSubject[] {
  switch (waitingOn.kind) {
    case "user":
      return [{ kind: "user", login: waitingOn.candidateId }];
    case "team":
      return [{ kind: "team", teamId: waitingOn.candidateId }];
    case "role":
      switch (waitingOn.role) {
        case "author":
          switch (item.author.status) {
            case "identified":
              return [{ kind: "user", login: item.author.actor.login }];
            case "unavailable":
              return [];
            default:
              throw new UnreachableError(item.author);
          }
        case "assignee":
          return item.assignees.map((assignee) => ({ kind: "user", login: assignee.login }));
        case "maintainer":
        case "reviewer":
        case "merge_decider":
        case "ci":
        case "dependency":
        case "unknown":
          return [];
        default:
          throw new UnreachableError(waitingOn.role);
      }
    case "item":
    case "automation":
    case "unknown":
      return [];
    default:
      throw new UnreachableError(waitingOn.kind);
  }
}

/** 項目のwaitingOnから特定できる待ち相手を入力順で返す。 */
export function resolveWaitingSubjects(item: PublicItemSummaryDto): readonly WaitingSubject[] {
  const subjectKeys = new Set<string>();
  return item.waitingOn
    .flatMap((waitingOn) => resolveWaitingOnCandidateSubjects(waitingOn, item))
    .filter((subject) => {
      const key = waitingSubjectKey(subject);
      if (subjectKeys.has(key)) {
        return false;
      }
      subjectKeys.add(key);
      return true;
    });
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

/** waitingOn配列を日本語の表示文字列へ変換する。 */
export function formatWaitingOn(item: PublicItemSummaryDto, summary: PublicSummaryDto): string {
  if (item.waitingOn.length === 0) {
    if (
      item.status !== "terminal_merged" &&
      item.status !== "terminal_completed" &&
      item.status !== "terminal_not_planned"
    ) {
      throw new TypeError(`非terminal項目 ${item.nodeId} にwaitingOnがありません`);
    }
    return "対応完了";
  }
  return item.waitingOn
    .map((waitingOn) => formatWaitingOnCandidate(waitingOn, item, summary))
    .join("、");
}

/** waitingOn候補を確度区分付きの表示文字列へ変換する。 */
export function formatWaitingOnCandidate(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  const presentation = confidencePresentation(waitingOn.confidence, summary.confidenceThresholds);
  return presentation.fieldQualifier.length === 0
    ? waitingOnLabel(waitingOn, item, summary)
    : `${presentation.fieldQualifier}: ${waitingOnLabel(waitingOn, item, summary)}`;
}

/** primaryWaitingOnが指す候補を返し、未選定なら先頭候補を返す。 */
export function selectPrimaryWaitingOnCandidate(
  item: PublicItemSummaryDto,
): WaitingOnCandidate | undefined {
  if (item.waitingOn.length === 0) {
    return undefined;
  }
  if (item.primaryWaitingOn.index === "not_applicable") {
    return item.waitingOn[0];
  }
  const waitingOn = item.waitingOn[item.primaryWaitingOn.index];
  assertNonNullable(waitingOn, `項目 ${item.nodeId} のprimary waitingOnがありません`);
  return waitingOn;
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

/** 公開summaryから待ち相手のチーム識別子を昇順で集める。 */
export function collectWaitingTeamIds(summary: PublicSummaryDto): readonly string[] {
  const teamIds = new Map<string, string>();
  for (const item of summary.items) {
    for (const subject of resolveWaitingSubjects(item)) {
      if (subject.kind === "team") {
        const key = waitingSubjectKey(subject);
        if (!teamIds.has(key)) {
          teamIds.set(key, subject.teamId);
        }
      }
    }
  }
  return [...teamIds.values()].sort(compareStrings);
}

/** 公開summaryから待ち相手ごとの集計行を作る。 */
export function collectWaitingSubjectRows(
  summary: PublicSummaryDto,
  now: Date,
): readonly WaitingSubjectRow[] {
  const accumulators = new Map<string, WaitingSubjectRowAccumulator>();
  for (const item of summary.items) {
    for (const subject of resolveWaitingSubjects(item)) {
      const key = waitingSubjectKey(subject);
      const accumulator = accumulators.get(key);
      if (accumulator == null) {
        accumulators.set(key, {
          subject,
          label: waitingSubjectLabel(subject),
          itemCount: 1,
          longestStallSince: item.stallSince,
        });
        continue;
      }
      accumulator.itemCount += 1;
      if (parseTimestamp(item.stallSince) < parseTimestamp(accumulator.longestStallSince)) {
        accumulator.longestStallSince = item.stallSince;
      }
    }
  }

  return [...accumulators.values()]
    .map((accumulator) => ({
      subject: accumulator.subject,
      label: accumulator.label,
      itemCount: accumulator.itemCount,
      longestStallDuration: formatStallDuration(accumulator.longestStallSince, now),
    }))
    .sort((left, right) => {
      const itemCountOrder = right.itemCount - left.itemCount;
      return itemCountOrder === 0 ? compareStrings(left.label, right.label) : itemCountOrder;
    });
}

/** loginまたは所属teamに対応する待ち理由を入力順で返す。 */
export function selectWaitingSubjectReasons(
  item: PublicItemSummaryDto,
  login: string,
  teamIds: readonly string[],
): readonly string[] {
  const subjectKeys = new Set([
    waitingSubjectKey({ kind: "user", login }),
    ...teamIds.map((teamId) => waitingSubjectKey({ kind: "team", teamId })),
  ]);
  const reasons = new Set<string>();
  return item.waitingOn
    .filter((waitingOn) =>
      resolveWaitingOnCandidateSubjects(waitingOn, item).some((subject) =>
        subjectKeys.has(waitingSubjectKey(subject)),
      ),
    )
    .map((waitingOn) => waitingOn.reasonSummary)
    .filter((reason) => {
      if (reasons.has(reason)) {
        return false;
      }
      reasons.add(reason);
      return true;
    });
}

/** loginまたは所属teamを待っている項目のnode ID集合を返す。 */
export function selectWaitingSubjectItemNodeIds(
  summary: PublicSummaryDto,
  login: string,
  teamIds: readonly string[],
): ReadonlySet<string> {
  const subjectKeys = new Set([
    waitingSubjectKey({ kind: "user", login }),
    ...teamIds.map((teamId) => waitingSubjectKey({ kind: "team", teamId })),
  ]);
  return new Set(
    summary.items
      .filter((item) =>
        item.waitingOn.some((waitingOn) =>
          resolveWaitingOnCandidateSubjects(waitingOn, item).some((subject) =>
            subjectKeys.has(waitingSubjectKey(subject)),
          ),
        ),
      )
      .map((item) => item.nodeId),
  );
}

/** attention queueの決定論的な優先順を比較する。 */
export function compareAttentionItems(
  left: PublicItemSummaryDto,
  right: PublicItemSummaryDto,
): number {
  const severityOrder = SEVERITY_RANKS[right.severity] - SEVERITY_RANKS[left.severity];
  if (severityOrder !== 0) {
    return severityOrder;
  }
  const priorityOrder = attentionPriority(right).rank - attentionPriority(left).rank;
  if (priorityOrder !== 0) {
    return priorityOrder;
  }
  const repositoryImpactOrder =
    right.downstreamImpact.repositoryCount - left.downstreamImpact.repositoryCount;
  if (repositoryImpactOrder !== 0) {
    return repositoryImpactOrder;
  }
  const itemImpactOrder =
    right.downstreamImpact.openNodeCount - left.downstreamImpact.openNodeCount;
  if (itemImpactOrder !== 0) {
    return itemImpactOrder;
  }
  const stallOrder = compareStrings(left.stallSince, right.stallSince);
  if (stallOrder !== 0) {
    return stallOrder;
  }
  return compareStrings(left.nodeId, right.nodeId);
}

function isTerminalStatus(status: Status): boolean {
  return (
    status === "terminal_merged" ||
    status === "terminal_completed" ||
    status === "terminal_not_planned"
  );
}

/** staleとterminalを除いた要対応項目を優先順で返す。 */
export function selectAttentionItems(
  items: readonly PublicItemSummaryDto[],
): readonly PublicItemSummaryDto[] {
  return items
    .filter(
      (item) =>
        item.severity !== "none" &&
        item.repositoryFreshness === "fresh" &&
        !isTerminalStatus(item.status),
    )
    .sort(compareAttentionItems);
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
      repository,
      repositoryText: repository.fullName,
      typeText: itemTypeLabel(item.type),
      statusText: statusLabel(item.status),
      importanceText: importanceLevelLabel(item.importance.level),
      waitingOnText: formatWaitingOn(item, summary),
      stallText: formatStallDuration(item.stallSince, now),
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
      return row.item.status === value;
    case "importance":
      return row.item.importance.level === value;
    case "waitingOn":
      return normalizedSearchText(row.waitingOnText).includes(normalizedSearchText(value));
    case "stall": {
      const definition = STALL_FILTER_DEFINITIONS.find((candidate) => candidate.value === value);
      assertNonNullable(definition, `未対応の停滞時間の絞り込みです: ${value}`);
      return row.stallDurationMilliseconds >= definition.thresholdMilliseconds;
    }
    case "aiAnalysis":
      if (value !== AI_ANALYSIS_DEGRADED_FILTER_VALUE) {
        throw new TypeError(`未対応のAI利用状況の絞り込みです: ${value}`);
      }
      return isAiAnalysisDegraded(row.item.aiAnalysis.status);
    default:
      throw new UnreachableError(key);
  }
}

function compareTableRows(
  left: ItemTableRow,
  right: ItemTableRow,
  key: TableColumnKey,
  locale: string,
): number {
  switch (key) {
    case "repository":
      return left.repositoryText.localeCompare(right.repositoryText, locale);
    case "type":
      return left.typeText.localeCompare(right.typeText, locale);
    case "status":
      return left.statusText.localeCompare(right.statusText, locale);
    case "importance":
      return left.item.importance.score - right.item.importance.score;
    case "waitingOn":
      return left.waitingOnText.localeCompare(right.waitingOnText, locale);
    case "stall":
      return left.stallDurationMilliseconds - right.stallDurationMilliseconds;
    default:
      throw new UnreachableError(key);
  }
}

/** 一覧表の全列filterとsortを適用する。 */
export function filterAndSortTableRows(
  rows: readonly ItemTableRow[],
  filters: TableFilters,
  sort: TableSort,
  locale: string,
): readonly ItemTableRow[] {
  const filteredRows = rows.filter((row) =>
    Object.entries(filters).every(([key, value]) => {
      if (value.length === 0) {
        return true;
      }
      if (
        key !== "repository" &&
        key !== "type" &&
        key !== "status" &&
        key !== "importance" &&
        key !== "waitingOn" &&
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
    const order = compareTableRows(left, right, sort.key, locale);
    if (order !== 0) {
      return order * direction;
    }
    return compareStrings(left.item.nodeId, right.item.nodeId);
  });
}

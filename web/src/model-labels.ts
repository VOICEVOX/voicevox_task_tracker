import { assertNonNullable } from "../../src/util/index.js";
import type {
  AiUnverifiedValue,
  CurrentResponseRole,
  CurrentResponseStatus,
  CurrentResponseUnknownReason,
  CurrentResponseUnverifiedValue,
  DeadlineLevel,
  ImportanceLevel,
  ItemType,
  Status,
  TableFilterKey,
  TableFilterOption,
  TableFilters,
  TableSelectFilterKey,
  WaitingOnRole,
} from "./model-contracts.js";

export const STATUS_LABELS = {
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

export const ITEM_TYPE_LABELS = {
  issue: "Issue",
  pull_request: "Pull Request",
} satisfies Readonly<Record<ItemType, string>>;

export const IMPORTANCE_LEVEL_LABELS = {
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

export const DEADLINE_LEVEL_SORT_SCORES = {
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

export const STALL_FILTER_DEFINITIONS = [
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

export const AI_ANALYSIS_FILTER_OPTIONS = [
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

export const CURRENT_RESPONSE_STATUS_LABELS = {
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

export const ROLE_LABELS = {
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

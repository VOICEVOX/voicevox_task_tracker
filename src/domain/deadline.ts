/** 期限の切迫度。 */
export type DeadlineLevel =
  | "none"
  | "over_30_days"
  | "within_30_days"
  | "within_7_days"
  | "within_3_days"
  | "within_1_day"
  | "overdue";

/** 期限の切迫度を設定順に並べた一覧。 */
export const DEADLINE_LEVELS = [
  "none",
  "over_30_days",
  "within_30_days",
  "within_7_days",
  "within_3_days",
  "within_1_day",
  "overdue",
] as const satisfies readonly DeadlineLevel[];

/** AIが判定した期限日と根拠。 */
export type NaturalLanguageDeadlineAssessment = Readonly<{
  date: string | null;
  rationale: string;
}>;

/** 自然言語による期限判定を利用できるかを表す。 */
export type NaturalLanguageDeadlineAssessmentState =
  | Readonly<{
      status: "not_available";
    }>
  | Readonly<{
      status: "available";
      value: NaturalLanguageDeadlineAssessment;
    }>;

/** 期限日から切迫度を決定する入力。 */
export type DetermineDeadlineLevelInput = Readonly<{
  deadlineDate: string | null;
  evaluatedAt: string;
  timezone: string;
}>;

const DEADLINE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDeadlineDate(value: string, description: string): Date {
  const match = DEADLINE_DATE_PATTERN.exec(value);
  if (match == null) {
    throw new RangeError(`${description}はYYYY-MM-DD形式で指定してください`);
  }
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText == null || monthText == null || dayText == null) {
    throw new TypeError(`${description}を解析できませんでした`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`${description}は実在する日付を指定してください`);
  }
  return date;
}

/** 期限日が厳密なYYYY-MM-DD形式の実在日付であることを検証する。 */
export function validateDeadlineDate(value: string | null, description: string): void {
  if (value == null) {
    return;
  }
  parseDeadlineDate(value, description);
}

function calendarDateFromInstant(value: string, timezone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("判定時刻は有効な日時を指定してください");
  }
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (year == null || month == null || day == null) {
    throw new TypeError("設定timezoneからカレンダー日付を取得できませんでした");
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

function calendarDateOrdinal(value: string, description: string): number {
  return parseDeadlineDate(value, description).getTime() / MILLISECONDS_PER_DAY;
}

/** 設定timezoneのカレンダー日付差から期限の切迫度を決定する。 */
export function determineDeadlineLevel(input: DetermineDeadlineLevelInput): DeadlineLevel {
  const evaluatedDate = calendarDateFromInstant(input.evaluatedAt, input.timezone);
  validateDeadlineDate(input.deadlineDate, "期限日");
  if (input.deadlineDate == null) {
    return "none";
  }

  const remainingDays =
    calendarDateOrdinal(input.deadlineDate, "期限日") -
    calendarDateOrdinal(evaluatedDate, "判定時刻のカレンダー日付");
  if (remainingDays < 0) {
    return "overdue";
  }
  if (remainingDays <= 1) {
    return "within_1_day";
  }
  if (remainingDays <= 3) {
    return "within_3_days";
  }
  if (remainingDays <= 7) {
    return "within_7_days";
  }
  if (remainingDays <= 30) {
    return "within_30_days";
  }
  return "over_30_days";
}

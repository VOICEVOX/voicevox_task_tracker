import { z } from "zod";

import { createUtcIsoDateTime, type Severity, type UtcIsoDateTime } from "../domain/index.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const JST_OFFSET_MILLISECONDS = 9 * MILLISECONDS_PER_HOUR;
const JST_NOTIFICATION_HOUR = 8;

/** Discord通知の決定論的判定規則version。 */
export const DISCORD_NOTIFICATION_DETERMINISTIC_RULES_VERSION = "discord-notification-v3";

/** 決定論的な再通知間隔の日数。 */
export type DeterministicNotificationRepeatDays = Readonly<{
  urgent: number;
  critical: number;
}>;

/** 一回限りの通知枠を判定する入力。 */
export type OneTimeNotificationWindowInput = Readonly<{
  eventAt: UtcIsoDateTime;
  referenceAt: UtcIsoDateTime;
}>;

/** 停滞通知の最初の正規通知枠を求める入力。 */
export type StallNotificationScheduleInput = Readonly<{
  stallSince: UtcIsoDateTime;
  severity: Extract<Severity, "urgent" | "critical">;
  thresholdHours: number;
  repeatDays: DeterministicNotificationRepeatDays;
}>;

/** 停滞通知の正規通知枠。 */
export type StallNotificationSchedule = Readonly<{
  severity: Extract<Severity, "urgent" | "critical">;
  thresholdReachedAt: UtcIsoDateTime;
  firstNotificationAt: UtcIsoDateTime;
  repeatDays: number;
}>;

/** 停滞通知の正規枠判定入力。 */
export type StallNotificationWindowInput = Readonly<{
  schedule: StallNotificationSchedule;
  referenceAt: UtcIsoDateTime;
}>;

/** 停滞通知の正規枠判定結果。 */
export type StallNotificationWindowResult =
  | Readonly<{
      status: "eligible";
      kind: "first" | "repeat";
      scheduledAt: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "not_due";
      reason: "before_first_notification" | "outside_repeat_cycle";
    }>;

/** 通常digestを実行できるworkflow実行の入力。 */
export type NormalDigestRunContext =
  | Readonly<{
      eventName: "schedule";
      runAttempt: number;
      scheduledFor: UtcIsoDateTime;
    }>
  | Readonly<{
      eventName: "workflow_dispatch";
      runAttempt: number;
    }>;

/** 通常digestのworkflow実行可否。 */
export type NormalDigestRunDecision =
  | Readonly<{
      allowed: true;
      reason: "schedule";
      scheduledFor: UtcIsoDateTime;
    }>
  | Readonly<{
      allowed: false;
      reason: "manual" | "rerun";
    }>;

const repeatDaysSchema = z.strictObject({
  urgent: z.number().int().positive(),
  critical: z.number().int().positive(),
});
const oneTimeNotificationWindowInputSchema = z.strictObject({
  eventAt: z.iso.datetime({ offset: true }),
  referenceAt: z.iso.datetime({ offset: true }),
});
const stallNotificationScheduleInputSchema = z.strictObject({
  stallSince: z.iso.datetime({ offset: true }),
  severity: z.enum(["urgent", "critical"]),
  thresholdHours: z.number().nonnegative(),
  repeatDays: repeatDaysSchema,
});
const stallNotificationScheduleSchema = z.strictObject({
  severity: z.enum(["urgent", "critical"]),
  thresholdReachedAt: z.iso.datetime({ offset: true }),
  firstNotificationAt: z.iso.datetime({ offset: true }),
  repeatDays: z.number().int().positive(),
});
const stallNotificationWindowInputSchema = z.strictObject({
  schedule: stallNotificationScheduleSchema,
  referenceAt: z.iso.datetime({ offset: true }),
});
const normalDigestRunContextSchema = z.discriminatedUnion("eventName", [
  z.strictObject({
    eventName: z.literal("schedule"),
    runAttempt: z.number().int().positive(),
    scheduledFor: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    eventName: z.literal("workflow_dispatch"),
    runAttempt: z.number().int().positive(),
  }),
]);

function parseDateTime(
  value: string,
  context: string,
): Readonly<{
  normalized: UtcIsoDateTime;
  timestamp: number;
}> {
  const normalized = createUtcIsoDateTime(value);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return Object.freeze({ normalized, timestamp });
}

function validateInput<T>(schema: z.ZodType<T>, input: unknown, context: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new TypeError(`${context}が不正です`, { cause: result.error });
  }
  return result.data;
}

function validateReferenceAt(
  value: string,
  context: string,
): Readonly<{
  normalized: UtcIsoDateTime;
  timestamp: number;
}> {
  const parsed = parseDateTime(value, context);
  const jstDate = new Date(parsed.timestamp + JST_OFFSET_MILLISECONDS);
  if (
    jstDate.getUTCHours() !== JST_NOTIFICATION_HOUR ||
    jstDate.getUTCMinutes() !== 0 ||
    jstDate.getUTCSeconds() !== 0 ||
    jstDate.getUTCMilliseconds() !== 0
  ) {
    throw new RangeError(`${context}は08:00 JSTの正規通知時刻にしてください`);
  }
  return parsed;
}

function createDateTime(
  timestamp: number,
  context: string,
): Readonly<{
  normalized: UtcIsoDateTime;
  timestamp: number;
}> {
  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`${context}が日時の範囲を超えています`);
  }
  return parseDateTime(new Date(timestamp).toISOString(), context);
}

function addMilliseconds(timestamp: number, milliseconds: number, context: string): number {
  const result = timestamp + milliseconds;
  if (!Number.isFinite(result)) {
    throw new RangeError(`${context}が日時の範囲を超えています`);
  }
  return result;
}

function firstDailyNotificationTimestamp(thresholdReachedTimestamp: number): number {
  const jstThreshold = new Date(thresholdReachedTimestamp + JST_OFFSET_MILLISECONDS);
  const jstMidnight = new Date(0);
  jstMidnight.setUTCFullYear(
    jstThreshold.getUTCFullYear(),
    jstThreshold.getUTCMonth(),
    jstThreshold.getUTCDate(),
  );
  jstMidnight.setUTCHours(0, 0, 0, 0);
  const jstMidnightTimestamp = jstMidnight.getTime();
  const sameDayNotificationTimestamp =
    jstMidnightTimestamp - JST_OFFSET_MILLISECONDS + JST_NOTIFICATION_HOUR * MILLISECONDS_PER_HOUR;
  return sameDayNotificationTimestamp >= thresholdReachedTimestamp
    ? sameDayNotificationTimestamp
    : sameDayNotificationTimestamp + MILLISECONDS_PER_DAY;
}

function repeatDaysForSeverity(
  severity: Extract<Severity, "urgent" | "critical">,
  repeatDays: DeterministicNotificationRepeatDays,
): number {
  return severity === "urgent" ? repeatDays.urgent : repeatDays.critical;
}

/** 基準時刻の直前24時間を含まない一回限り通知枠を判定する。 */
export function isOneTimeNotificationDue(input: OneTimeNotificationWindowInput): boolean {
  const validated = validateInput(
    oneTimeNotificationWindowInputSchema,
    input,
    "一回限り通知枠の入力",
  );
  const reference = validateReferenceAt(validated.referenceAt, "基準通知時刻");
  const event = parseDateTime(validated.eventAt, "イベント時刻");
  const windowStart = reference.timestamp - MILLISECONDS_PER_DAY;
  return event.timestamp > windowStart && event.timestamp <= reference.timestamp;
}

/** stallSinceとseverity閾値から最初の正規通知枠を求める。 */
export function calculateStallNotificationSchedule(
  input: StallNotificationScheduleInput,
): StallNotificationSchedule {
  const validated = validateInput(
    stallNotificationScheduleInputSchema,
    input,
    "停滞通知スケジュールの入力",
  );
  const stallSince = parseDateTime(validated.stallSince, "stallSince");
  const thresholdReachedTimestamp = addMilliseconds(
    stallSince.timestamp,
    validated.thresholdHours * MILLISECONDS_PER_HOUR,
    "severity閾値到達時刻",
  );
  const firstNotificationTimestamp = firstDailyNotificationTimestamp(thresholdReachedTimestamp);
  const thresholdReachedAt = createDateTime(
    thresholdReachedTimestamp,
    "severity閾値到達時刻",
  ).normalized;
  const firstNotificationAt = createDateTime(
    firstNotificationTimestamp,
    "最初の正規通知枠",
  ).normalized;
  return Object.freeze({
    severity: validated.severity,
    thresholdReachedAt,
    firstNotificationAt,
    repeatDays: repeatDaysForSeverity(validated.severity, validated.repeatDays),
  });
}

/** 正規通知枠の起点とrepeatDaysから今回の停滞通知枠を判定する。 */
export function evaluateStallNotificationWindow(
  input: StallNotificationWindowInput,
): StallNotificationWindowResult {
  const validated = validateInput(stallNotificationWindowInputSchema, input, "停滞通知枠の入力");
  const reference = validateReferenceAt(validated.referenceAt, "基準通知時刻");
  const schedule = {
    ...validated.schedule,
    thresholdReachedAt: parseDateTime(validated.schedule.thresholdReachedAt, "severity閾値到達時刻")
      .normalized,
    firstNotificationAt: validateReferenceAt(
      validated.schedule.firstNotificationAt,
      "最初の正規通知枠",
    ).normalized,
  } satisfies StallNotificationSchedule;
  const thresholdReached = parseDateTime(schedule.thresholdReachedAt, "severity閾値到達時刻");
  const firstNotification = parseDateTime(schedule.firstNotificationAt, "最初の正規通知枠");
  if (firstNotification.timestamp !== firstDailyNotificationTimestamp(thresholdReached.timestamp)) {
    throw new TypeError("最初の正規通知枠がseverity閾値到達時刻から決定できません");
  }
  if (reference.timestamp < firstNotification.timestamp) {
    return Object.freeze({
      status: "not_due",
      reason: "before_first_notification",
    });
  }
  const elapsedMilliseconds = reference.timestamp - firstNotification.timestamp;
  const elapsedDays = elapsedMilliseconds / MILLISECONDS_PER_DAY;
  if (!Number.isInteger(elapsedDays) || elapsedDays % schedule.repeatDays !== 0) {
    return Object.freeze({
      status: "not_due",
      reason: "outside_repeat_cycle",
    });
  }
  return Object.freeze({
    status: "eligible",
    kind: elapsedDays === 0 ? "first" : "repeat",
    scheduledAt: reference.normalized,
  });
}

/** scheduleの初回かつrun_attempt 1だけ通常digestを許可する。 */
export function evaluateNormalDigestRun(input: NormalDigestRunContext): NormalDigestRunDecision {
  const validated = validateInput(normalDigestRunContextSchema, input, "通常digest実行context");
  if (validated.eventName === "workflow_dispatch") {
    return Object.freeze({ allowed: false, reason: "manual" });
  }
  const scheduledFor = validateReferenceAt(validated.scheduledFor, "scheduleの基準通知時刻");
  if (validated.runAttempt !== 1) {
    return Object.freeze({ allowed: false, reason: "rerun" });
  }
  return Object.freeze({
    allowed: true,
    reason: "schedule",
    scheduledFor: scheduledFor.normalized,
  });
}

const dateTimeFormatters = new Map<string, Map<string, Intl.DateTimeFormat>>();
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

export function parseTimestamp(value: string): number {
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

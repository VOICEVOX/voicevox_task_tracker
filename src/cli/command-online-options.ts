import type { CliSchedule } from "../infrastructure/tracking-run/command-schedule.js";
import {
  notificationActionSchema,
  type NotificationAction,
} from "../application/tracking-run/contracts/closed-values.js";
import { createUtcIsoDateTime } from "../domain/index.js";
import type { BackfillCliCommand } from "../infrastructure/tracking-run/command-input.js";
import {
  optionalSingleOption,
  singleOption,
  usageError,
  type ParsedOptions,
} from "./command-options.js";

const REPOSITORY_FILTER_PATTERN = /^VOICEVOX\/[A-Za-z0-9._-]+$/u;

/** CLIの予定時刻を解析する。 */
export function parseSchedule(options: ParsedOptions): CliSchedule {
  const value = optionalSingleOption(options, "--scheduled-for");
  if (value == null) {
    return Object.freeze({ kind: "current_time" });
  }
  try {
    return Object.freeze({ kind: "specified", value: createUtcIsoDateTime(value) });
  } catch (error: unknown) {
    throw usageError("--scheduled-forにはタイムゾーン付きISO 8601日時を指定してください", error);
  }
}

/** CLIの通知actionを解析する。 */
export function parseNotificationAction(options: ParsedOptions): NotificationAction {
  const result = notificationActionSchema.safeParse(
    singleOption(options, "--notification-action", "send"),
  );
  if (!result.success) {
    throw usageError(
      "--notification-actionにはsend、holdまたはacknowledge-currentを指定してください",
      result.error,
    );
  }
  return result.data;
}

/** backfill対象の広がりを解析する。 */
export function parseBackfillMode(value: string): BackfillCliCommand["mode"] {
  switch (value) {
    case "none":
    case "linked":
    case "all-open":
      return value;
    default:
      throw usageError("--modeにはnone、linked、all-openのいずれかを指定してください");
  }
}

/** repository指定を重複なく名前順へ正規化する。 */
export function parseRepositoryFilter(options: ParsedOptions): readonly string[] {
  const repositoryFilter = options.get("--repository") ?? [];
  for (const repository of repositoryFilter) {
    if (!REPOSITORY_FILTER_PATTERN.test(repository)) {
      throw usageError("--repositoryにはVOICEVOX配下のowner/name形式を指定してください");
    }
  }
  if (new Set(repositoryFilter).size !== repositoryFilter.length) {
    throw usageError("--repositoryを重複して指定できません");
  }
  return Object.freeze([...repositoryFilter].sort());
}

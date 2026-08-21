import { type PublicItemSummaryDto } from "../../src/pages/public-dto.js";
import { UnreachableError } from "../../src/util/index.js";
import { deadlineLevelLabel, formatDeadlineDate } from "./model.js";
import { Pill } from "./ui.js";

type DeadlineTone = "neutral" | "low" | "medium" | "danger" | "warning";

type DeadlineDisplayProps = Readonly<{
  dateClassName: string;
  deadline: PublicItemSummaryDto["deadline"];
}>;

function deadlineLevelTone(deadline: PublicItemSummaryDto["deadline"]): DeadlineTone {
  if (deadline.status === "not_available") {
    return "neutral";
  }
  switch (deadline.level) {
    case "none":
      return "neutral";
    case "over_30_days":
      return "low";
    case "within_30_days":
      return "medium";
    case "within_7_days":
    case "within_3_days":
      return "warning";
    case "within_1_day":
    case "overdue":
      return "danger";
    default:
      throw new UnreachableError(deadline.level);
  }
}

function deadlineLabel(deadline: PublicItemSummaryDto["deadline"]): string {
  if (deadline.status === "not_available") {
    return "期限不明";
  }
  return deadlineLevelLabel(deadline.level);
}

/** 期限の切迫度と期限日を共通表示する。 */
export function DeadlineDisplay({ dateClassName, deadline }: DeadlineDisplayProps) {
  return (
    <div class="deadline-status grid min-w-0 justify-items-start gap-1">
      <Pill className="deadline-badge" tone={deadlineLevelTone(deadline)}>
        {deadlineLabel(deadline)}
      </Pill>
      {deadline.status === "available" && deadline.date != null && (
        <time
          class={`font-mono text-text-primary tabular-nums wrap-anywhere ${dateClassName}`}
          dateTime={deadline.date}
        >
          {formatDeadlineDate(deadline.date)}
        </time>
      )}
    </div>
  );
}

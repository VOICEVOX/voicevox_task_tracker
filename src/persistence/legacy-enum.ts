import {
  type NotificationReasonCode,
  type StalenessWaitClass,
  type Status,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";

export type LegacyStatus =
  | "new_untriaged"
  | "needs_maintainer_decision"
  | "waiting_for_author"
  | "waiting_for_assignee"
  | "blocked"
  | "ready_to_merge"
  | "waiting_for_owner"
  | "waiting_for_review"
  | "waiting_for_automation"
  | "in_progress"
  | "unknown"
  | "terminal_merged"
  | "terminal_completed"
  | "terminal_not_planned";

export type LegacyWaitClass =
  | "maintainerTriage"
  | "ownerUnknown"
  | "reviewer"
  | "authorAfterChangesRequested"
  | "assigneeOrInProgress"
  | "readyToMerge"
  | "decision"
  | "automation"
  | "blockedParent"
  | "notApplicable";

export type LegacyNotificationReasonCode =
  | "none"
  | "triage_overdue"
  | "review_overdue"
  | "author_overdue"
  | "owner_unknown"
  | "blocker_overdue"
  | "newly_unblocked"
  | "dependency_cycle"
  | "responsibility_changed"
  | "ready_to_merge_overdue"
  | "automation_stuck";

/** 旧Statusを現行値へ変換する。 */
export function migrateLegacyStatus(value: LegacyStatus): Status {
  switch (value) {
    case "new_untriaged":
      return "waiting_for_assessment";
    case "needs_maintainer_decision":
      return "waiting_for_decision";
    case "waiting_for_author":
      return "waiting_for_revision";
    case "waiting_for_assignee":
      return "waiting_for_work";
    case "blocked":
      return "waiting_for_unblock";
    case "ready_to_merge":
      return "waiting_for_merge";
    case "waiting_for_owner":
    case "waiting_for_review":
    case "waiting_for_automation":
    case "in_progress":
    case "unknown":
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return value;
    default:
      throw new UnreachableError(value);
  }
}

/** 旧WaitClassを現行値へ変換する。 */
export function migrateLegacyWaitClass(value: LegacyWaitClass): StalenessWaitClass {
  switch (value) {
    case "maintainerTriage":
      return "assessment";
    case "ownerUnknown":
      return "owner";
    case "reviewer":
      return "review";
    case "authorAfterChangesRequested":
      return "revision";
    case "assigneeOrInProgress":
      return "work";
    case "readyToMerge":
      return "merge";
    case "decision":
    case "automation":
    case "blockedParent":
    case "notApplicable":
      return value;
    default:
      throw new UnreachableError(value);
  }
}

/** 旧NotificationReasonCodeを現行値へ変換する。 */
export function migrateLegacyNotificationReasonCode(
  value: LegacyNotificationReasonCode,
): NotificationReasonCode {
  switch (value) {
    case "triage_overdue":
      return "assessment_overdue";
    case "author_overdue":
      return "revision_overdue";
    case "ready_to_merge_overdue":
      return "merge_overdue";
    case "none":
    case "review_overdue":
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
    case "automation_stuck":
      return value;
    default:
      throw new UnreachableError(value);
  }
}

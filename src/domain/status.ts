import { type Status, type TerminalStatus } from "./types.js";

/** statusが人の対応を必要としない終了状態か判定する。 */
export function isTerminalStatus(status: Status): status is TerminalStatus {
  switch (status) {
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return true;
    case "waiting_for_assessment":
    case "waiting_for_owner":
    case "waiting_for_decision":
    case "waiting_for_review":
    case "waiting_for_revision":
    case "waiting_for_reply":
    case "waiting_for_work":
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "waiting_for_merge":
    case "in_progress":
    case "unknown":
      return false;
  }
}

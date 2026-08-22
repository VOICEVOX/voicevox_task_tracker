import { type NotificationReasonCode } from "./types.js";

/** 通知理由コードの日本語表示名を返す。 */
export function notificationReasonText(
  reasonCode: Exclude<NotificationReasonCode, "none">,
): string {
  switch (reasonCode) {
    case "assessment_overdue":
      return "内容確認待ちが基準時間を超えました";
    case "owner_overdue":
      return "担当決め待ちが基準時間を超えました";
    case "decision_overdue":
      return "方針判断待ちが基準時間を超えました";
    case "review_overdue":
      return "レビュー待ちが基準時間を超えました";
    case "revision_overdue":
      return "修正待ちが基準時間を超えました";
    case "reply_overdue":
      return "返答待ちが基準時間を超えました";
    case "owner_unknown":
      return "待ち先不明です";
    case "blocker_overdue":
      return "下流を止める項目が長期化しています";
    case "newly_unblocked":
      return "依存が解消して再開可能になりました";
    case "dependency_cycle":
      return "新しい依存cycleを検出しました";
    case "responsibility_changed":
      return "長期停止後に責務が移りました";
    case "merge_overdue":
      return "マージ待ちが基準時間を超えました";
    case "automation_stuck":
      return "自動処理待ちが基準時間を超えました";
  }
}

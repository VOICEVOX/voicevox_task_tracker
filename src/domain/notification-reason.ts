import { z } from "zod";

import { type NotificationReasonCode } from "./types.js";

/** 通知理由に対応する時間系理由コード。 */
export type NotificationTimeReasonCode =
  | "assessment_overdue"
  | "owner_overdue"
  | "decision_overdue"
  | "review_overdue"
  | "revision_overdue"
  | "reply_overdue"
  | "merge_overdue"
  | "automation_stuck";

/** 通知理由に対応する非時間系理由コード。 */
export type NotificationNonTimeReasonCode = Exclude<
  NotificationReasonCode,
  "none" | NotificationTimeReasonCode
>;

/** 通知理由の基準時間の記録状態。 */
export type NotificationReasonThreshold =
  | Readonly<{
      status: "recorded";
      hours: number;
    }>
  | Readonly<{
      status: "not_recorded";
    }>
  | Readonly<{
      status: "not_applicable";
    }>;

/** 通知理由と通知時点の基準時間。 */
export type NotificationReason =
  | Readonly<{
      reasonCode: NotificationTimeReasonCode;
      threshold: Extract<NotificationReasonThreshold, { status: "recorded" | "not_recorded" }>;
    }>
  | Readonly<{
      reasonCode: NotificationNonTimeReasonCode;
      threshold: Extract<NotificationReasonThreshold, { status: "not_applicable" }>;
    }>;

const notificationTimeReasonThresholdSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    hours: z.number().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("not_recorded"),
  }),
]);
const notificationNotApplicableThresholdSchema = z.strictObject({
  status: z.literal("not_applicable"),
});

/** 通知理由の構造化データschema。 */
export const notificationReasonSchema = z.discriminatedUnion("reasonCode", [
  z.strictObject({
    reasonCode: z.literal("assessment_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("owner_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("decision_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("review_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("revision_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("reply_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("merge_overdue"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("automation_stuck"),
    threshold: notificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("owner_unknown"),
    threshold: notificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("blocker_overdue"),
    threshold: notificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("newly_unblocked"),
    threshold: notificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("dependency_cycle"),
    threshold: notificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("responsibility_changed"),
    threshold: notificationNotApplicableThresholdSchema,
  }),
]);

function isTimeReasonCode(
  reasonCode: Exclude<NotificationReasonCode, "none">,
): reasonCode is NotificationTimeReasonCode {
  switch (reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "merge_overdue":
    case "automation_stuck":
      return true;
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
      return false;
  }
}

/** 理由コードと基準時間の記録状態から通知理由を生成する。 */
export function createNotificationReason(
  reasonCode: Exclude<NotificationReasonCode, "none">,
  threshold: NotificationReasonThreshold,
): NotificationReason {
  if (isTimeReasonCode(reasonCode)) {
    if (threshold.status === "recorded") {
      if (!Number.isFinite(threshold.hours) || threshold.hours < 0) {
        throw new RangeError("通知理由の基準時間は0以上の有限値にしてください");
      }
      return Object.freeze({
        reasonCode,
        threshold: Object.freeze({
          status: "recorded",
          hours: threshold.hours,
        }),
      });
    }
    if (threshold.status === "not_recorded") {
      return Object.freeze({
        reasonCode,
        threshold: Object.freeze({
          status: "not_recorded",
        }),
      });
    }
    throw new TypeError("時間系通知理由には基準時間を記録するか未記録を指定してください");
  }
  if (threshold.status !== "not_applicable") {
    throw new TypeError("非時間系通知理由には基準時間を適用できません");
  }
  return Object.freeze({
    reasonCode,
    threshold: Object.freeze({
      status: "not_applicable",
    }),
  });
}

function overdueReasonText(label: string, reason: NotificationReason): string {
  if (reason.threshold.status === "recorded") {
    return `${label}が基準となる${reason.threshold.hours.toString()}時間を超えました`;
  }
  return `${label}が基準時間を超えました`;
}

/** 通知理由の日本語表示名を返す。 */
export function notificationReasonText(reason: NotificationReason): string {
  switch (reason.reasonCode) {
    case "assessment_overdue":
      return overdueReasonText("内容確認待ち", reason);
    case "owner_overdue":
      return overdueReasonText("担当決め待ち", reason);
    case "decision_overdue":
      return overdueReasonText("方針判断待ち", reason);
    case "review_overdue":
      return overdueReasonText("レビュー待ち", reason);
    case "revision_overdue":
      return overdueReasonText("修正待ち", reason);
    case "reply_overdue":
      return overdueReasonText("返答待ち", reason);
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
      return overdueReasonText("マージ待ち", reason);
    case "automation_stuck":
      return overdueReasonText("自動処理待ち", reason);
  }
}

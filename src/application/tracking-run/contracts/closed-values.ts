import { z } from "zod";

export const notificationActionSchema = z.enum(["send", "hold", "acknowledge-current"]);

/** 日次通知の実行方針。 */
export type NotificationAction = z.output<typeof notificationActionSchema>;

export const analysisRunStageNames = [
  "prepared",
  "inventory_collected",
  "collected",
  "deterministically_analyzed",
  "generic_ai_planned",
  "generic_ai_executed",
  "generic_ai_adopted",
  "graph_reconciled",
  "personal_reminder_planned",
  "personal_reminder_executed",
  "personal_reminder_finalized",
  "validated",
  "publication_planned",
] as const;

export const analysisRunStageSchema = z.enum(analysisRunStageNames);

/** coreと段階名を対応させる解析段階。 */
export type AnalysisRunStageName = z.output<typeof analysisRunStageSchema>;

export const trackingRunStageNames = [
  ...analysisRunStageNames,
  "initial_state_committed",
  "initial_pages_prepared",
  "initial_pages_published",
  "notifications_settled",
  "run_finalized",
  "notification_history_pages_prepared",
  "notification_history_pages_published",
  "completed",
] as const;

export const trackingRunStageSchema = z.enum(trackingRunStageNames);

/** 追跡runの確定済み段階名。 */
export type TrackingRunStageName = z.output<typeof trackingRunStageSchema>;

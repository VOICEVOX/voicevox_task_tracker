import { z } from "zod";
import { runtimeRecoveryStageV2Schema } from "../../application/tracking-run/contracts/runtime-recovery-v2.js";

import type { NotificationAction } from "../../application/tracking-run/contracts/closed-values.js";
import type { CliSchedule } from "./command-schedule.js";

export const splitTrackingStageNames = [
  "analyze",
  "commit-initial-state",
  "prepare-initial-pages",
  "preflight-initial-pages-deployment",
  "record-initial-pages-deployment",
  "settle-notifications",
  "finalize-run",
  "prepare-history-pages",
  "preflight-history-pages-deployment",
  "record-history-pages-deployment",
  "complete",
] as const;

/** 一つの分割run段階を進めるCLI入力。 */
export type RunStageCliCommand = Readonly<{
  kind: "run-stage";
  stage: (typeof splitTrackingStageNames)[number];
  configPath: string;
  runId: string | undefined;
  runAttempt: number;
  schedule: CliSchedule;
  notificationAction: NotificationAction;
  mode: "none" | "linked" | "all-open";
  repositoryFilter: readonly string[];
  manualResolutionReceiptPath: string | undefined;
  sandboxContextPath: string | undefined;
}>;

/** remote stateから次の分割段階を選ぶCLI入力。 */
export type RouteStageCliCommand = Readonly<{
  kind: "route-stage";
  configPath: string;
  stateRef: string;
  runId: string | undefined;
  effectTarget: "production" | "sandbox" | "recording";
}>;

/** V2固定入口へ渡す分割runの操作。 */
export type RecoverRuntimeV2CliCommand = Readonly<{
  kind: "runtime-recovery-v2";
  operation: "inspect" | "execute_stage" | "record_pages";
  configPath: string;
  stateRef: string;
  runId: string;
  runAttempt: number;
  stage: z.output<typeof runtimeRecoveryStageV2Schema> | undefined;
  observationPath: string | undefined;
  phase: "initial" | "notification_history" | undefined;
  manualResolutionReceiptPath: string | undefined;
  bundleRoot: string | undefined;
}>;

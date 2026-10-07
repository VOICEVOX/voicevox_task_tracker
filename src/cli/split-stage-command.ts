import { z } from "zod";
import { runtimeRecoveryStageV2Schema } from "../application/tracking-run/contracts/runtime-recovery-v2.js";

import type {
  RecoverRuntimeV2CliCommand,
  RouteStageCliCommand,
  RunStageCliCommand,
} from "../infrastructure/tracking-run/split-command-input.js";
import { splitTrackingStageNames } from "../infrastructure/tracking-run/split-command-input.js";
import {
  parseBackfillMode,
  parseNotificationAction,
  parseRepositoryFilter,
  parseSchedule,
} from "./command-online-options.js";
import { optionalSingleOption, parseOptions, singleOption, usageError } from "./command-options.js";

/** V2固定入口の操作と観測fileを検証する。 */
export function parseRecoverRuntimeV2(args: readonly string[]): RecoverRuntimeV2CliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--operation",
      "--config",
      "--state-ref",
      "--run-id",
      "--run-attempt",
      "--stage",
      "--observation",
      "--phase",
      "--manual-resolution-receipt",
      "--bundle-root",
    ]),
  );
  const operation = z
    .enum(["inspect", "execute_stage", "record_pages"])
    .parse(optionalSingleOption(options, "--operation"));
  const stateRef = z
    .string()
    .regex(/^(?:tracker-state|sandbox-state\/env-[1-9][0-9]*-[1-9][0-9]*)$/u)
    .parse(optionalSingleOption(options, "--state-ref"));
  const runId = z
    .string()
    .regex(/^tracker-run:[0-9a-f]{64}$/u)
    .parse(optionalSingleOption(options, "--run-id"));
  const runAttempt = z.coerce
    .number()
    .int()
    .positive()
    .parse(singleOption(options, "--run-attempt", "1"));
  const stageValue = optionalSingleOption(options, "--stage");
  const stage = stageValue == null ? undefined : runtimeRecoveryStageV2Schema.parse(stageValue);
  const observationPath = optionalSingleOption(options, "--observation");
  const phaseValue = optionalSingleOption(options, "--phase");
  const phase =
    phaseValue == null ? undefined : z.enum(["initial", "notification_history"]).parse(phaseValue);
  const manualResolutionReceiptPath = optionalSingleOption(options, "--manual-resolution-receipt");
  if (
    (operation === "execute_stage") !== (stage != null) ||
    (operation === "record_pages") !== (observationPath != null) ||
    (operation === "record_pages") !== (phase != null) ||
    (manualResolutionReceiptPath != null &&
      (operation !== "execute_stage" || stage !== "settle-notifications"))
  ) {
    throw usageError("V2固定入口の操作と段階または観測fileが一致しません");
  }
  return Object.freeze({
    kind: "runtime-recovery-v2",
    operation,
    configPath: singleOption(options, "--config", "config.yml"),
    stateRef,
    runId,
    runAttempt,
    stage,
    observationPath,
    phase,
    manualResolutionReceiptPath,
    bundleRoot: optionalSingleOption(options, "--bundle-root"),
  });
}

/** route-stageのstate ref、run、外部効果先を検証する。 */
export function parseRouteStage(args: readonly string[]): RouteStageCliCommand {
  const options = parseOptions(
    args,
    new Set(["--config", "--state-ref", "--run-id", "--effect-target"]),
  );
  const stateRef = z
    .string()
    .regex(/^(?:tracker-state|sandbox-state\/env-[1-9][0-9]*-[1-9][0-9]*)$/u)
    .safeParse(optionalSingleOption(options, "--state-ref"));
  if (!stateRef.success) {
    throw usageError("route-stageには正しい--state-refが必要です", stateRef.error);
  }
  const runId = z
    .string()
    .regex(/^tracker-run:[0-9a-f]{64}$/u)
    .optional()
    .safeParse(optionalSingleOption(options, "--run-id"));
  if (!runId.success) {
    throw usageError("--run-idが不正です", runId.error);
  }
  const effectTarget = optionalSingleOption(options, "--effect-target");
  const target = z.enum(["production", "sandbox", "recording"]).safeParse(effectTarget);
  if (!target.success) {
    throw usageError("route-stageには正しい--effect-targetが必要です", target.error);
  }
  return Object.freeze({
    kind: "route-stage",
    configPath: singleOption(options, "--config", "config.yml"),
    stateRef: stateRef.data,
    runId: runId.data,
    effectTarget: target.data,
  });
}

/** 一段の分割run入力を解析する。 */
export function parseRunStage(args: readonly string[]): RunStageCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--stage",
      "--config",
      "--run-id",
      "--run-attempt",
      "--scheduled-for",
      "--notification-action",
      "--mode",
      "--repository",
      "--sandbox-context",
      "--manual-resolution-receipt",
    ]),
  );
  const stageValue = optionalSingleOption(options, "--stage");
  if (stageValue == null) {
    throw usageError("run-stageには--stageが必要です");
  }
  const stage = z.enum(splitTrackingStageNames).safeParse(stageValue);
  if (!stage.success) {
    throw usageError("--stageが不正です", stage.error);
  }
  const runId = optionalSingleOption(options, "--run-id");
  if ((stage.data === "analyze") !== (runId == null)) {
    throw usageError("analyze以外のrun-stageには--run-idが必要です");
  }
  if (runId != null && !/^tracker-run:[0-9a-f]{64}$/u.test(runId)) {
    throw usageError("--run-idが不正です");
  }
  const runAttempt = Number(singleOption(options, "--run-attempt", "1"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw usageError("--run-attemptには1以上の整数を指定してください");
  }
  const mode = parseBackfillMode(singleOption(options, "--mode", "none"));
  const repositoryFilter = parseRepositoryFilter(options);
  if (mode === "none" && repositoryFilter.length !== 0) {
    throw usageError("--modeがnoneのとき--repositoryは指定できません");
  }
  const sandboxContextPath = optionalSingleOption(options, "--sandbox-context");
  if (sandboxContextPath != null && (stage.data !== "analyze" || mode !== "none")) {
    throw usageError("--sandbox-contextは通常範囲の解析段階だけに指定してください");
  }
  if (
    stage.data !== "analyze" &&
    (options.has("--scheduled-for") ||
      options.has("--notification-action") ||
      options.has("--mode") ||
      options.has("--repository"))
  ) {
    throw usageError("解析用optionはanalyze段階だけに指定してください");
  }
  const manualResolutionReceiptPath = optionalSingleOption(options, "--manual-resolution-receipt");
  if (manualResolutionReceiptPath != null && stage.data !== "settle-notifications") {
    throw usageError("--manual-resolution-receiptは通知段階だけに指定してください");
  }
  return Object.freeze({
    kind: "run-stage",
    stage: stage.data,
    configPath: singleOption(options, "--config", "config.yml"),
    runId,
    runAttempt,
    schedule: parseSchedule(options),
    notificationAction: parseNotificationAction(options),
    mode,
    repositoryFilter,
    manualResolutionReceiptPath,
    sandboxContextPath,
  });
}

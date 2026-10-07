import { appendFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

const priorNotificationScenarioSchema = z.strictObject({
  scenarioId: z.enum(["send-clear-rejection", "hold", "acknowledge-current", "ambiguous-retry"]),
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  finalStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  coverageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

const recordingControlSchema = z
  .strictObject({
    outcome: z.enum(["recorded_success", "recorded_clear_rejection", "recorded_ambiguous"]),
    messageIndex: z.number().int().nonnegative(),
    continuity: z
      .discriminatedUnion("phase", [
        z.strictObject({ phase: z.literal("first") }),
        z.strictObject({
          phase: z.literal("second"),
          firstRunId: z.string().regex(/^[1-9][0-9]*$/u),
          firstRunAttempt: z.number().int().positive(),
          firstTrackingRunId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
          firstFinalStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
          firstCodeRevision: z.string().regex(/^[0-9a-f]{40}$/u),
        }),
      ])
      .optional(),
    notification: z
      .discriminatedUnion("phase", [
        z.strictObject({
          phase: z.literal("first"),
          prior: z.array(priorNotificationScenarioSchema).max(4),
        }),
        z.strictObject({
          phase: z.literal("resolution"),
          prior: z.array(priorNotificationScenarioSchema).max(4),
          firstRunId: z.string().regex(/^[1-9][0-9]*$/u),
          firstRunAttempt: z.number().int().positive(),
          firstTrackingRunId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
          firstPendingRevision: z.string().regex(/^[0-9a-f]{40}$/u),
          firstDeliveryOperationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
          decision: z.enum(["retry", "acknowledge"]),
        }),
      ])
      .optional(),
  })
  .refine((control) => control.continuity == null || control.notification == null, {
    message: "continuityとnotification scenarioは同時に指定できません",
  })
  .refine((control) => control.outcome !== "recorded_success" || control.messageIndex === 0, {
    message: "recorded_successのmessageIndexは0にしてください",
  });

const rawControl = process.env["SANDBOX_RECORDING_CONTROL"];
if (rawControl == null) {
  throw new TypeError("sandbox通知portの入力がありません");
}
const control = recordingControlSchema.parse(JSON.parse(rawControl));
const operation = process.env["SANDBOX_OPERATION"];
const action = process.env["SANDBOX_NOTIFICATION_ACTION"];
const scenarioId = process.env["SANDBOX_SCENARIO_ID"];
const environmentId = process.env["SANDBOX_ENVIRONMENT_ID"];
const resetSource = process.env["SANDBOX_RESET_SOURCE"];
if ((scenarioId === "continuity") !== (control.continuity != null)) {
  throw new TypeError("continuity scenarioにはcontinuity controlが必要です");
}
const notificationScenarios = {
  "send-clear-rejection": { action: "send", outcome: "recorded_clear_rejection" },
  hold: { action: "hold", outcome: "recorded_success" },
  "acknowledge-current": { action: "acknowledge-current", outcome: "recorded_success" },
  "ambiguous-retry": { action: "send", outcome: "recorded_ambiguous", decision: "retry" },
  "ambiguous-acknowledge": {
    action: "send",
    outcome: "recorded_ambiguous",
    decision: "acknowledge",
  },
};
const scenario = Object.hasOwn(notificationScenarios, scenarioId)
  ? notificationScenarios[scenarioId]
  : undefined;
if ((scenario != null) !== (control.notification != null)) {
  throw new TypeError("notification scenarioにはnotification controlが必要です");
}
if (scenario != null && control.notification != null) {
  const notification = control.notification;
  const expectedPrior = [
    "send-clear-rejection",
    "hold",
    "acknowledge-current",
    "ambiguous-retry",
  ].slice(0, Object.keys(notificationScenarios).indexOf(scenarioId));
  if (
    notification.prior.length !== expectedPrior.length ||
    notification.prior.some((entry, index) => entry.scenarioId !== expectedPrior[index]) ||
    new Set(notification.prior.map((entry) => entry.environmentId)).size !==
      notification.prior.length
  ) {
    throw new TypeError("notification scenarioの先行結果が順番どおりではありません");
  }
  if (action !== scenario.action || control.messageIndex !== 0) {
    throw new TypeError("notification scenarioのactionまたはmessage位置が一致しません");
  }
  if (notification.phase === "first") {
    if (
      operation !== "reset" ||
      resetSource !== "seed" ||
      environmentId == null ||
      environmentId === "" ||
      control.outcome !== scenario.outcome
    ) {
      throw new TypeError("notification scenarioの初回はseedからresetしてください");
    }
  } else if (
    scenario.decision == null ||
    (operation !== "continue" && operation !== "resume-preparing") ||
    notification.decision !== scenario.decision ||
    control.outcome !== "recorded_success" ||
    environmentId !== `env-${notification.firstRunId}-${notification.firstRunAttempt}`
  ) {
    throw new TypeError("notification scenarioの手動解決入力が一致しません");
  }
}
if (operation === "resume-preparing" && control.notification?.phase !== "resolution") {
  throw new TypeError("準備中環境の再開には通知の手動解決入力が必要です");
}
if (control.continuity != null) {
  if (
    scenarioId !== "continuity" ||
    action !== "send" ||
    control.outcome !== "recorded_success" ||
    control.messageIndex !== 0
  ) {
    throw new TypeError("continuityにはsendとrecorded_successを指定してください");
  }
  if (control.continuity.phase === "first" && operation !== "create" && operation !== "reset") {
    throw new TypeError("continuity firstにはcreateまたはresetを指定してください");
  }
  if (control.continuity.phase === "second") {
    if (operation !== "continue") {
      throw new TypeError("continuity secondにはcontinueを指定してください");
    }
    if (
      environmentId !== `env-${control.continuity.firstRunId}-${control.continuity.firstRunAttempt}`
    ) {
      throw new TypeError("continuity secondのenvironment IDがfirstと一致しません");
    }
  }
}

const outputPath = process.env["GITHUB_OUTPUT"];
if (outputPath == null) {
  throw new TypeError("GitHub Actionsの出力先がありません");
}
appendFileSync(
  outputPath,
  [
    `recording_outcome=${control.outcome}`,
    `recording_message_index=${control.messageIndex}`,
    `continuity_phase=${control.continuity?.phase ?? "none"}`,
    `first_run_id=${control.continuity?.phase === "second" ? control.continuity.firstRunId : ""}`,
    `first_run_attempt=${control.continuity?.phase === "second" ? control.continuity.firstRunAttempt : ""}`,
    `first_tracking_run_id=${control.continuity?.phase === "second" ? control.continuity.firstTrackingRunId : ""}`,
    `first_final_state_revision=${control.continuity?.phase === "second" ? control.continuity.firstFinalStateRevision : ""}`,
    `first_code_revision=${control.continuity?.phase === "second" ? control.continuity.firstCodeRevision : ""}`,
    `notification_phase=${control.notification?.phase ?? "none"}`,
    `notification_source_run_id=${control.notification?.phase === "resolution" ? control.notification.firstRunId : ""}`,
    `notification_source_run_attempt=${control.notification?.phase === "resolution" ? control.notification.firstRunAttempt : ""}`,
    `notification_first_tracking_run_id=${control.notification?.phase === "resolution" ? control.notification.firstTrackingRunId : ""}`,
    `notification_first_pending_revision=${control.notification?.phase === "resolution" ? control.notification.firstPendingRevision : ""}`,
    `notification_first_delivery_operation_id=${control.notification?.phase === "resolution" ? control.notification.firstDeliveryOperationId : ""}`,
    `notification_decision=${control.notification?.phase === "resolution" ? control.notification.decision : ""}`,
    `notification_prior_json=${JSON.stringify(control.notification?.prior ?? [])}`,
    "",
  ].join("\n"),
);

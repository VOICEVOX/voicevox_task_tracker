import { z } from "zod";

import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  PagesBuildReceipt,
  PagesDeploymentReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { receiptSchema } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import type { NotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const outcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("deployed"),
    sourceStateRevision: revisionSchema,
    buildReceipt: receiptSchema.options[1],
    receipt: receiptSchema.options[2],
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("not_required"),
    sourceStateRevision: revisionSchema,
    buildReceipt: receiptSchema.options[1],
    receipt: receiptSchema.options[2],
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("failure"),
    reason: z.enum(["action_failed", "effect_unconfirmed", "superseded_by_newer_run"]),
    failedOperationEffectCertainty: z.enum(["no_effect", "committed", "ambiguous"]),
    recoveryDisposition: z.enum(["retryable", "manual_resolution", "not_retryable"]),
    finalStateCommitted: z.literal(true),
    sourceStateRevision: revisionSchema,
    observedHeadRevision: revisionSchema,
    runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
    checkpointDigest: sha256Schema,
    deploymentIntentDigest: sha256Schema.optional(),
    receipt: receiptSchema.options[2].optional(),
  }),
]);

/** 通知履歴Pagesの確定結果または外部効果別の型付き失敗。 */
export type NotificationHistoryPagesDeploymentOutcome = z.output<typeof outcomeSchema>;

/** 保存済み結果を現行buildの同じfinal stateとcontentへ照合する。 */
export function parseNotificationHistoryPagesDeploymentOutcome(
  value: unknown,
  artifact: NotificationHistoryPagesBuildArtifact,
): NotificationHistoryPagesDeploymentOutcome {
  const outcome = outcomeSchema.parse(value);
  if (outcome.sourceStateRevision !== artifact.sourceStateRevision) {
    throw new TypeError("通知履歴Pages結果とfinal revisionが一致しません");
  }
  if (outcome.kind === "failure") {
    const binding = artifact.receipt.binding;
    if (
      binding.bindingKind !== "checkpoint" ||
      outcome.runId !== binding.runId ||
      outcome.checkpointDigest !== binding.checkpointDigest ||
      outcome.deploymentIntentDigest !==
        (artifact.status === "built" ? artifact.intent.deploymentIntentDigest : undefined) ||
      (outcome.reason === "superseded_by_newer_run") !== (outcome.receipt != null) ||
      (outcome.reason === "superseded_by_newer_run" &&
        (outcome.failedOperationEffectCertainty !== "no_effect" ||
          outcome.recoveryDisposition !== "not_retryable")) ||
      (outcome.reason === "action_failed" &&
        (outcome.failedOperationEffectCertainty !== "no_effect" ||
          outcome.recoveryDisposition !== "retryable")) ||
      (outcome.reason === "effect_unconfirmed" &&
        ((outcome.failedOperationEffectCertainty !== "ambiguous" &&
          outcome.failedOperationEffectCertainty !== "committed") ||
          outcome.recoveryDisposition !== "manual_resolution"))
    ) {
      throw new TypeError("通知履歴Pages失敗とbuild artifactが一致しません");
    }
    if (outcome.receipt != null) {
      const receipt = parseReceipt(outcome.receipt, digest);
      if (
        receipt.receiptType !== "pages_deployment" ||
        receipt.phase !== "notification_history" ||
        receipt.status !== "superseded_by_newer_run" ||
        receipt.previousReceiptDigest !== artifact.receipt.receiptDigest ||
        receipt.phaseSequence !== artifact.receipt.phaseSequence + 1 ||
        receipt.expectedStateRevision !== artifact.sourceStateRevision ||
        serializeCanonicalJson(receipt.binding) !==
          serializeCanonicalJson(artifact.receipt.binding) ||
        receipt.logicalTarget !==
          (artifact.status === "built"
            ? artifact.intent.deploymentIntentDigest
            : artifact.sourceStateRevision)
      ) {
        throw new TypeError("通知履歴Pages無効化receiptが一致しません");
      }
    }
    return outcome;
  }
  const build = parseReceipt(outcome.buildReceipt, digest);
  const deployment = parseReceipt(outcome.receipt, digest);
  if (build.receiptType !== "pages_build" || deployment.receiptType !== "pages_deployment") {
    throw new TypeError("通知履歴Pages結果のreceipt種別が不正です");
  }
  if (
    (outcome.kind === "not_required") !== (artifact.status === "not_required") ||
    (outcome.kind === "not_required") !== (deployment.status === "not_required")
  ) {
    throw new TypeError("通知履歴Pages結果の公開要否が一致しません");
  }
  assertDeploymentChain(build, deployment, artifact);
  return outcome;
}

function assertDeploymentChain(
  build: PagesBuildReceipt,
  deployment: PagesDeploymentReceipt,
  artifact: NotificationHistoryPagesBuildArtifact,
): void {
  const sameBuild =
    build.phase === "notification_history" &&
    build.stage === "notification_history_pages_prepared" &&
    build.status === artifact.receipt.status &&
    build.previousReceiptDigest != null &&
    build.phaseSequence === artifact.receipt.phaseSequence &&
    build.expectedStateRevision === artifact.sourceStateRevision &&
    serializeCanonicalJson(build.binding) === serializeCanonicalJson(artifact.receipt.binding);
  if (
    !sameBuild ||
    deployment.phase !== "notification_history" ||
    deployment.stage !== "notification_history_pages_published" ||
    deployment.previousReceiptDigest !== build.receiptDigest ||
    deployment.phaseSequence !== build.phaseSequence + 1 ||
    deployment.expectedStateRevision !== artifact.sourceStateRevision ||
    serializeCanonicalJson(deployment.binding) !== serializeCanonicalJson(build.binding)
  ) {
    throw new TypeError("通知履歴Pages結果のreceipt連鎖が一致しません");
  }
  if (artifact.status === "not_required") {
    if (
      build.receiptKind !== "not_required" ||
      build.notRequiredReason !== artifact.reason ||
      build.logicalTarget !== artifact.sourceStateRevision ||
      deployment.status !== "not_required" ||
      deployment.receiptKind !== "not_required" ||
      deployment.effectCertainty !== "no_effect" ||
      deployment.logicalTarget !== artifact.sourceStateRevision ||
      deployment.result != null
    ) {
      throw new TypeError("通知履歴Pages不要結果と理由が一致しません");
    }
  } else if (
    build.receiptKind !== "executed" ||
    build.logicalTarget !== artifact.intent.deploymentIntentDigest ||
    build.result?.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest ||
    build.result.pagesContentDigest !== artifact.intent.pagesContentDigest ||
    build.result.outputManifestDigest !== artifact.intent.outputManifestDigest ||
    build.result.sourceStateRevision !== artifact.sourceStateRevision ||
    deployment.logicalTarget !== artifact.intent.deploymentIntentDigest ||
    deployment.receiptKind !== "executed" ||
    (deployment.status !== "deployed" && deployment.status !== "replayed_same_content") ||
    deployment.effectCertainty !== "committed" ||
    deployment.result?.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest ||
    deployment.result.pagesContentDigest !== artifact.intent.pagesContentDigest ||
    deployment.result.sourceStateRevision !== artifact.sourceStateRevision ||
    deployment.result.pageUrl !== artifact.intent.expectedPageUrl
  ) {
    throw new TypeError("通知履歴Pages公開結果とintentが一致しません");
  }
  verifyReceiptChain(
    [
      { receipt: build, evidence: { kind: "none" } },
      { receipt: deployment, evidence: { kind: "none" } },
    ],
    digest,
  );
}

/** canonical JSONの通知履歴Pages公開結果を読む。 */
export function decodeNotificationHistoryPagesDeploymentOutcome(
  bytes: Uint8Array,
  artifact: NotificationHistoryPagesBuildArtifact,
): NotificationHistoryPagesDeploymentOutcome {
  if (bytes.byteLength > 1024 * 1024) {
    throw new TypeError("通知履歴Pages公開結果が許容byte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("通知履歴Pages公開結果がcanonical JSONではありません");
  }
  return parseNotificationHistoryPagesDeploymentOutcome(raw, artifact);
}

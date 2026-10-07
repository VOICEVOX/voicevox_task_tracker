import { randomUUID } from "node:crypto";

import { z } from "zod";

import { createReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  PagesDeploymentExternalReference,
  PagesDeploymentReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { pagesDeploymentExternalReferenceSchema } from "../../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import type { NotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import { parseNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import {
  parseNotificationHistoryPagesDeploymentOutcome,
  type NotificationHistoryPagesDeploymentOutcome,
} from "./notification-history-pages-deployment-outcome.js";
import {
  parseNotificationHistoryPagesDeploymentPreflight,
  type NotificationHistoryPagesDeploymentPreflight,
} from "./notification-history-pages-deployment.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const workflowObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal("notification_history"),
  deploymentIntentDigest: sha256Schema.optional(),
  uploadOutcome: z.enum(["success", "failure", "skipped"]),
  deploymentOutcome: z.enum(["success", "failure", "skipped"]),
  artifactName: z.string().min(1),
  artifactId: z.string().min(1).optional(),
  artifactDigest: sha256Schema.optional(),
  deploymentId: z.string().min(1).optional(),
  pageUrl: z.url().optional(),
});

const sequentialResultSchema = z.strictObject({
  deploymentReference: z.string().min(1),
  pageUrl: z.url(),
  adapterIdentityDigest: sha256Schema,
  actionsArtifact: pagesDeploymentExternalReferenceSchema.options[0].shape.actionsArtifact,
  effectOccurredAt: z.iso.datetime({ offset: true }).optional(),
});

function deploymentReceipt(
  artifact: NotificationHistoryPagesBuildArtifact,
  status: "deployed" | "replayed_same_content" | "not_required" | "superseded_by_newer_run",
  observedAt: string,
  result?: PagesDeploymentReceipt["result"],
  effectOccurredAt?: string,
): PagesDeploymentReceipt {
  const build = artifact.receipt;
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "pages_deployment",
      stage: "notification_history_pages_published",
      phase: "notification_history",
      binding: build.binding,
      logicalTarget:
        artifact.status === "built"
          ? artifact.intent.deploymentIntentDigest
          : artifact.sourceStateRevision,
      invocationId: randomUUID(),
      localAttemptIndex: 0,
      phaseSequence: build.phaseSequence + 1,
      previousReceiptDigest: build.receiptDigest,
      expectedStateRevision: artifact.sourceStateRevision,
      receiptKind:
        status === "not_required"
          ? "not_required"
          : status === "superseded_by_newer_run"
            ? "superseded"
            : "executed",
      observedAt,
      ...(effectOccurredAt == null ? {} : { effectOccurredAt }),
      status,
      effectCertainty:
        status === "not_required" || status === "superseded_by_newer_run"
          ? "no_effect"
          : "committed",
      ...(status === "superseded_by_newer_run"
        ? { publicDiagnosticCode: "superseded_by_newer_run" }
        : {}),
      ...(result == null ? {} : { result }),
    },
    digest,
  );
  if (receipt.receiptType !== "pages_deployment") {
    throw new TypeError("通知履歴Pages deployment receiptの種別が不正です");
  }
  return receipt;
}

function failure(
  artifact: NotificationHistoryPagesBuildArtifact,
  preflight: NotificationHistoryPagesDeploymentPreflight,
  reason: "action_failed" | "effect_unconfirmed" | "superseded_by_newer_run",
  effectCertainty: "no_effect" | "committed" | "ambiguous",
  observedAt: string,
): NotificationHistoryPagesDeploymentOutcome {
  const binding = artifact.receipt.binding;
  if (binding.bindingKind !== "checkpoint") {
    throw new TypeError("通知履歴Pages build receiptにcheckpoint結合がありません");
  }
  return parseNotificationHistoryPagesDeploymentOutcome(
    {
      schemaVersion: 1,
      kind: "failure",
      reason,
      failedOperationEffectCertainty: effectCertainty,
      recoveryDisposition:
        reason === "effect_unconfirmed"
          ? "manual_resolution"
          : reason === "superseded_by_newer_run"
            ? "not_retryable"
            : "retryable",
      finalStateCommitted: true,
      sourceStateRevision: artifact.sourceStateRevision,
      observedHeadRevision: preflight.observedHeadRevision,
      runId: binding.runId,
      checkpointDigest: binding.checkpointDigest,
      ...(artifact.status === "built"
        ? { deploymentIntentDigest: artifact.intent.deploymentIntentDigest }
        : {}),
      ...(reason === "superseded_by_newer_run"
        ? { receipt: deploymentReceipt(artifact, "superseded_by_newer_run", observedAt) }
        : {}),
    },
    artifact,
  );
}

/** 直列portの未実行または応答不明を履歴Pages失敗へ記録する。 */
export function recordNotificationHistorySequentialFailure(
  artifact: NotificationHistoryPagesBuildArtifact,
  preflight: NotificationHistoryPagesDeploymentPreflight,
  effectCertainty: "no_effect" | "ambiguous",
  observedAt: string,
): NotificationHistoryPagesDeploymentOutcome {
  if (preflight.kind !== "ready") {
    throw new TypeError("履歴Pages公開を開始していないpreflightへeffect失敗を付けられません");
  }
  return failure(
    artifact,
    preflight,
    effectCertainty === "no_effect" ? "action_failed" : "effect_unconfirmed",
    effectCertainty,
    observedAt,
  );
}

/** actionの実outputから履歴専用receiptまたは型付き失敗を確定する。 */
export function recordNotificationHistoryWorkflowDeployment(
  input: Readonly<{
    artifact: NotificationHistoryPagesBuildArtifact;
    preflight: NotificationHistoryPagesDeploymentPreflight;
    observation: unknown;
    adapterIdentityDigest: string;
    observedAt: string;
  }>,
): NotificationHistoryPagesDeploymentOutcome {
  const artifact = parseNotificationHistoryPagesBuildArtifact(input.artifact);
  const preflight = parseNotificationHistoryPagesDeploymentPreflight(input.preflight, artifact);
  const parsed = workflowObservationSchema.safeParse(input.observation);
  if (!parsed.success) {
    return failure(artifact, preflight, "effect_unconfirmed", "ambiguous", input.observedAt);
  }
  const observation = parsed.data;
  if (
    observation.deploymentIntentDigest !==
    (artifact.status === "built" ? artifact.intent.deploymentIntentDigest : undefined)
  ) {
    return failure(artifact, preflight, "effect_unconfirmed", "ambiguous", input.observedAt);
  }
  if (preflight.kind !== "ready") {
    if (observation.uploadOutcome !== "skipped" || observation.deploymentOutcome !== "skipped") {
      return failure(artifact, preflight, "effect_unconfirmed", "ambiguous", input.observedAt);
    }
    if (preflight.kind === "observed") {
      return parseNotificationHistoryPagesDeploymentOutcome(preflight.outcome, artifact);
    }
    if (preflight.kind === "superseded") {
      return failure(artifact, preflight, "superseded_by_newer_run", "no_effect", input.observedAt);
    }
    return parseNotificationHistoryPagesDeploymentOutcome(
      {
        schemaVersion: 1,
        kind: "not_required",
        sourceStateRevision: artifact.sourceStateRevision,
        buildReceipt: artifact.receipt,
        receipt: deploymentReceipt(artifact, "not_required", input.observedAt),
      },
      artifact,
    );
  }
  if (artifact.status !== "built") {
    throw new TypeError("通知履歴Pagesのready判定に公開対象がありません");
  }
  if (observation.uploadOutcome !== "success" || observation.deploymentOutcome !== "success") {
    const confirmed =
      observation.deploymentOutcome === "success" &&
      observation.deploymentId != null &&
      observation.pageUrl != null;
    return failure(
      artifact,
      preflight,
      observation.deploymentOutcome === "failure" || observation.deploymentOutcome === "success"
        ? "effect_unconfirmed"
        : "action_failed",
      confirmed
        ? "committed"
        : observation.deploymentOutcome === "skipped"
          ? "no_effect"
          : "ambiguous",
      input.observedAt,
    );
  }
  if (
    observation.deploymentId == null ||
    observation.pageUrl !== artifact.intent.expectedPageUrl ||
    (observation.artifactDigest != null && observation.artifactId == null)
  ) {
    return failure(
      artifact,
      preflight,
      "effect_unconfirmed",
      observation.deploymentId != null && observation.pageUrl != null ? "committed" : "ambiguous",
      input.observedAt,
    );
  }
  const actionsArtifact: Extract<
    PagesDeploymentExternalReference,
    { kind: "github_pages_actions" }
  >["actionsArtifact"] =
    observation.artifactId == null
      ? {
          kind: "not_exposed",
          artifactName: observation.artifactName,
          limitation: "action_did_not_expose_artifact_id_or_digest",
        }
      : observation.artifactDigest == null
        ? {
            kind: "identified_without_digest",
            artifactId: observation.artifactId,
            limitation: "action_did_not_expose_artifact_digest",
          }
        : {
            kind: "identified",
            artifactId: observation.artifactId,
            artifactDigest: observation.artifactDigest,
          };
  const receipt = deploymentReceipt(
    artifact,
    preflight.replay ? "replayed_same_content" : "deployed",
    input.observedAt,
    {
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      pagesContentDigest: artifact.intent.pagesContentDigest,
      sourceStateRevision: artifact.sourceStateRevision,
      pageUrl: observation.pageUrl,
      externalReference: {
        kind: "github_pages_actions",
        deploymentId: observation.deploymentId,
        actionsArtifact,
        adapterIdentityDigest: sha256Schema.parse(input.adapterIdentityDigest),
      },
    },
  );
  return parseNotificationHistoryPagesDeploymentOutcome(
    {
      schemaVersion: 1,
      kind: "deployed",
      sourceStateRevision: artifact.sourceStateRevision,
      buildReceipt: artifact.receipt,
      receipt,
    },
    artifact,
  );
}

/** 同じ履歴Pages intentをsequential productionまたはrecordingへ結び付ける。 */
export function recordNotificationHistorySequentialDeployment(
  input: Readonly<{
    artifact: NotificationHistoryPagesBuildArtifact;
    preflight: NotificationHistoryPagesDeploymentPreflight;
    target: "production" | "recording";
    productionResult?: unknown;
    recordingId?: string;
    observedAt: string;
  }>,
): NotificationHistoryPagesDeploymentOutcome {
  const artifact = parseNotificationHistoryPagesBuildArtifact(input.artifact);
  const preflight = parseNotificationHistoryPagesDeploymentPreflight(input.preflight, artifact);
  if (preflight.kind === "superseded") {
    return failure(artifact, preflight, "superseded_by_newer_run", "no_effect", input.observedAt);
  }
  if (preflight.kind === "observed") {
    const outcome = parseNotificationHistoryPagesDeploymentOutcome(preflight.outcome, artifact);
    if (
      outcome.kind !== "deployed" ||
      (input.target === "production" &&
        outcome.receipt.result?.externalReference.kind !== "github_pages_actions") ||
      (input.target === "recording" &&
        outcome.receipt.result?.externalReference.kind !== "recording")
    ) {
      throw new TypeError("通知履歴Pages保存証拠とadapterが一致しません");
    }
    return outcome;
  }
  if (preflight.kind === "not_required") {
    if (input.productionResult != null) {
      throw new TypeError("不要な通知履歴Pagesへproduction結果を付けられません");
    }
    return parseNotificationHistoryPagesDeploymentOutcome(
      {
        schemaVersion: 1,
        kind: "not_required",
        sourceStateRevision: artifact.sourceStateRevision,
        buildReceipt: artifact.receipt,
        receipt: deploymentReceipt(artifact, "not_required", input.observedAt),
      },
      artifact,
    );
  }
  if (artifact.status !== "built") {
    throw new TypeError("通知履歴Pagesのready判定に公開対象がありません");
  }
  let pageUrl = artifact.intent.expectedPageUrl;
  let effectOccurredAt: string | undefined;
  let externalReference: PagesDeploymentExternalReference;
  if (input.target === "production") {
    const result = sequentialResultSchema.parse(input.productionResult);
    pageUrl = result.pageUrl;
    effectOccurredAt = result.effectOccurredAt;
    externalReference = {
      kind: "github_pages_actions",
      deploymentId: result.deploymentReference,
      actionsArtifact: result.actionsArtifact,
      adapterIdentityDigest: result.adapterIdentityDigest,
    };
  } else {
    if (
      input.productionResult != null ||
      input.recordingId == null ||
      input.recordingId.length === 0
    ) {
      throw new TypeError("recording Pagesへproduction結果を付けられません");
    }
    externalReference = {
      kind: "recording",
      recordingId: input.recordingId,
      adapterIdentityDigest: digest.sha256Utf8("notification-history-pages-recording-adapter-v1"),
      productionEffect: false,
    };
  }
  if (pageUrl !== artifact.intent.expectedPageUrl) {
    throw new TypeError("通知履歴Pages公開URLがintentと一致しません");
  }
  return parseNotificationHistoryPagesDeploymentOutcome(
    {
      schemaVersion: 1,
      kind: "deployed",
      sourceStateRevision: artifact.sourceStateRevision,
      buildReceipt: artifact.receipt,
      receipt: deploymentReceipt(
        artifact,
        preflight.replay ? "replayed_same_content" : "deployed",
        input.observedAt,
        {
          deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
          pagesContentDigest: artifact.intent.pagesContentDigest,
          sourceStateRevision: artifact.sourceStateRevision,
          pageUrl,
          externalReference,
        },
        effectOccurredAt,
      ),
    },
    artifact,
  );
}

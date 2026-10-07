import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { parseSha256Hash } from "../../canonical-json/sha256.js";
import { loadConfig } from "../../config/index.js";
import { GitStateBranchAdapter } from "../../persistence/index.js";
import { sandboxPendingNotificationSchema } from "../../publication/sandbox-pending-evidence-schema.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  decodePublicationArtifact,
  MAX_CHECKPOINT_FILE_BYTES,
  MAX_CHECKPOINT_MANIFEST_BYTES,
} from "./publication-checkpoint-codec.js";
import { nodeCheckpointCompressionPort } from "./publication-checkpoint-gzip.js";
import { verifyManualResolutionReceipt } from "./manual-resolution.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { countSandboxReservationCommits } from "./sandbox-reservation-commits.js";
import {
  assertPendingSandboxStageCoverage,
  createSandboxStageCoverage,
} from "./sandbox-stage-coverage.js";
import { readSplitReceiptChain } from "./split-stage-receipts.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const environmentIdSchema = z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u);

function required(name: string): string {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function same(actual: string | number, expected: string | number, label: string): void {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readOptionalFile(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const file = await stat(path);
    if (file.size > maxBytes) throw new TypeError("checkpoint fileのbyte数が上限を超えています");
    return await readFile(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function state() {
  same(required("GITHUB_REPOSITORY"), "Hiroshiba/voicevox_task_tracker", "sandbox repository");
  const environmentId = environmentIdSchema.parse(required("SANDBOX_ENVIRONMENT_ID"));
  const branch = `sandbox-state/${environmentId}`;
  same(required("SANDBOX_STATE_BRANCH"), branch, "sandbox state branch");
  const config = await loadConfig(resolve("config.yml"));
  same(config.state.branch, "tracker-state", "sandbox元configのstate branch");
  const adapter = new GitStateBranchAdapter({
    repositoryPath: process.cwd(),
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const head = await adapter.resolveHead(branch);
  if (head.status !== "present") {
    throw new TypeError("sandbox state branchがありません");
  }
  const current = await readNotificationMessageState(
    adapter,
    { ...config.state, branch },
    head.revision,
  );
  return { adapter, configuration: { ...config.state, branch }, current, environmentId, branch };
}

async function inspectPending(): Promise<void> {
  const { adapter, configuration, current, environmentId, branch } = await state();
  const { marker, record } = current.transaction;
  const scenarioId = z
    .enum(["ambiguous-retry", "ambiguous-acknowledge"])
    .parse(required("SANDBOX_SCENARIO_ID"));
  same(required("SANDBOX_RECORDING_OUTCOME"), "recorded_ambiguous", "ambiguous recording outcome");
  const actionsRunId = required("GITHUB_RUN_ID");
  const actionsRunAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
  same(environmentId, `env-${actionsRunId}-${actionsRunAttempt.toString()}`, "初回environment ID");
  const codeRevision = revisionSchema.parse(required("GITHUB_SHA"));
  if (
    marker.phase !== "notifications_in_progress" ||
    record.executionPolicy.effectTarget !== "sandbox" ||
    record.notificationOutbox.action !== "send" ||
    record.notificationOutbox.delivery !== "send" ||
    record.notificationOutbox.selectedContext.action !== "create_digest" ||
    record.notificationOutbox.selectedContext.candidates.length === 0 ||
    record.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
    record.runtimeRecoveryPlan.workflowRunId !== actionsRunId ||
    record.runtimeRecoveryPlan.codeRevision !== codeRevision ||
    marker.lastMessageDeliveryId == null ||
    current.transaction.initialPagesEvidence == null ||
    current.snapshot.run.id !== marker.runId
  ) {
    throw new TypeError("ambiguous初回のremote pending stateが成立していません");
  }
  const started = current.ledger.entries.filter((entry) => entry.status === "delivery_started");
  const attempt = started[0]?.lastDeliveryAttempt;
  if (
    started.length === 0 ||
    attempt?.result !== "started" ||
    started.some(
      (entry) =>
        entry.deliveryId !== marker.lastMessageDeliveryId ||
        entry.lastDeliveryAttempt?.attemptId !== attempt.attemptId ||
        entry.manualResolution != null,
    ) ||
    started.length !== attempt.notificationKeys.length ||
    started.some((entry) => !attempt.notificationKeys.includes(entry.notificationKey))
  ) {
    throw new TypeError("ambiguous初回の開始済み送達が一意ではありません");
  }
  const count = await countSandboxReservationCommits(
    adapter,
    current.revision,
    marker.initialStateRevision,
    marker.runId,
    attempt.operationId,
    attempt.attemptId,
  );
  same(count, 1, "元送達操作のreservation commit回数");
  if (record.schemaVersion !== 3) {
    throw new TypeError("旧V2永続recordに解析段階の実行証拠がありません");
  }
  const analysis = record.analysisStageRecord;
  const checkpointBytes = await readOptionalFile(
    required("SANDBOX_CHECKPOINT_PATH"),
    MAX_CHECKPOINT_FILE_BYTES,
  );
  const sidecarBytes = await readOptionalFile(
    required("SANDBOX_SIDECAR_PATH"),
    MAX_CHECKPOINT_MANIFEST_BYTES,
  );
  if ((checkpointBytes == null) !== (sidecarBytes == null)) {
    throw new TypeError("checkpoint artifactとsidecarの片方だけがあります");
  }
  if (checkpointBytes != null && sidecarBytes != null) {
    const checkpoint = decodePublicationArtifact(
      checkpointBytes,
      sidecarBytes,
      {
        runtimeIdentity: record.runtimeIdentity,
        expectedRunId: record.runIdentity.runId,
        baseStateRevision: record.baseStateRevision,
        configDigest: parseSha256Hash(record.configDigest),
        artifactFileName: "validated-run.cpk",
      },
      nodeContentDigestPort,
      nodeCheckpointCompressionPort,
    );
    if (
      checkpoint.checkpointDigest !== record.checkpointDigest ||
      checkpoint.checkpointFileDigest !== record.checkpointFileDigest ||
      checkpoint.checkpoint.runIdentity.invocationId !== analysis.invocationId ||
      serializeCanonicalJson(checkpoint.checkpoint.analysisCompletedStages) !==
        serializeCanonicalJson(analysis.completedStages)
    ) {
      throw new TypeError("checkpoint artifactと永続解析記録が一致しません");
    }
  }
  same(analysis.checkpointDigest, marker.checkpointDigest, "解析記録 checkpoint digest");
  same(analysis.runId, marker.runId, "解析記録 run ID");
  const initialChainPath = join(
    required("SANDBOX_INITIAL_RECEIPT_CHAIN_ROOT"),
    marker.runId.slice("tracker-run:".length),
    "receipt-chain.json",
  );
  const initialChainBytes = await readFile(initialChainPath);
  const initialEntries = await readSplitReceiptChain(initialChainPath, marker.runId);
  const initialReceipts = initialEntries.map((entry) => entry.receipt);
  const initialPagesReceipt = initialReceipts.at(-1);
  if (
    initialPagesReceipt?.receiptType !== "pages_deployment" ||
    initialPagesReceipt.phase !== "initial" ||
    (initialPagesReceipt.status !== "deployed" &&
      initialPagesReceipt.status !== "replayed_same_content") ||
    initialPagesReceipt.result?.externalReference.kind !== "recording" ||
    initialPagesReceipt.binding.bindingKind !== "checkpoint" ||
    initialPagesReceipt.binding.checkpointDigest !== marker.checkpointDigest
  ) {
    throw new TypeError("ambiguous初回のPages receipt chainがありません");
  }
  const markerFile = current.files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const ledgerFile = current.files.get(configuration.notificationLedgerPath);
  if (markerFile?.status !== "present" || ledgerFile?.status !== "present") {
    throw new TypeError("ambiguous初回のremote markerまたはledgerがありません");
  }
  const markerBytes = markerFile.bytes;
  const ledgerBytes = ledgerFile.bytes;
  const stageCoverage = createSandboxStageCoverage({
    durableRecord: record,
    receiptEntries: initialEntries,
    runId: marker.runId,
    invocationId: analysis.invocationId,
    checkpointDigest: marker.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    baseStateRevision: record.baseStateRevision,
  });
  assertPendingSandboxStageCoverage(stageCoverage);
  const pending = sandboxPendingNotificationSchema.parse({
    schemaVersion: 1,
    scenarioId,
    environmentId,
    stateRef: branch,
    actionsRunId,
    actionsRunAttempt,
    trackingRunId: marker.runId,
    checkpointDigest: marker.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    baseStateRevision: revisionSchema.parse(marker.baseStateRevision),
    pendingStateRevision: current.revision,
    codeRevision,
    recordDigest: record.recordDigest,
    markerDigest: sha256(markerBytes),
    ledgerDigest: sha256(ledgerBytes),
    deliveryId: marker.lastMessageDeliveryId,
    attemptId: attempt.attemptId,
    deliveryOperationId: attempt.operationId,
    notificationKeys: attempt.notificationKeys,
    selectedCandidateCount: record.notificationOutbox.selectedContext.candidates.length,
    recordingOutcome: "recorded_ambiguous",
    originalOperationReservationCommitCount: count,
    initialReceiptChainDigest: sha256(initialChainBytes),
    initialPagesReceiptDigest: initialPagesReceipt.receiptDigest,
    analysisStageRecordDigest: stageCoverage.analysisStageRecordDigest,
    markerPhase: marker.phase,
    stages: stageCoverage.stages.map(({ stage, executed }) => ({ stage, executed })),
    unexecutedStages: stageCoverage.unexecutedStages,
    settled: false,
    finalized: false,
    newRunStarted: false,
    productionPagesDeployed: false,
    productionDiscordSent: false,
  });
  await writeFile(required("SANDBOX_PENDING_OUTPUT_PATH"), `${JSON.stringify(pending)}\n`);
  const outputPath = required("GITHUB_OUTPUT");
  await writeFile(
    outputPath,
    `tracking_run_id=${pending.trackingRunId}\npending_revision=${pending.pendingStateRevision}\ndelivery_operation_id=${pending.deliveryOperationId}\n`,
    { flag: "a" },
  );
}

async function readPending(): Promise<z.output<typeof sandboxPendingNotificationSchema>> {
  const pending = sandboxPendingNotificationSchema.parse(
    JSON.parse(await readFile(required("SANDBOX_PENDING_REPORT_PATH"), "utf8")),
  );
  same(pending.scenarioId, required("SANDBOX_SCENARIO_ID"), "pending scenario ID");
  same(pending.environmentId, required("SANDBOX_ENVIRONMENT_ID"), "pending environment ID");
  same(pending.stateRef, required("SANDBOX_STATE_BRANCH"), "pending state branch");
  same(pending.actionsRunId, required("SANDBOX_SOURCE_RUN_ID"), "pending Actions run ID");
  same(
    pending.actionsRunAttempt,
    Number(required("SANDBOX_SOURCE_RUN_ATTEMPT")),
    "pending Actions run attempt",
  );
  same(pending.trackingRunId, required("SANDBOX_FIRST_TRACKING_RUN_ID"), "pending tracking run ID");
  same(
    pending.pendingStateRevision,
    required("SANDBOX_FIRST_PENDING_REVISION"),
    "pending revision",
  );
  same(
    pending.deliveryOperationId,
    required("SANDBOX_FIRST_DELIVERY_OPERATION_ID"),
    "pending operation ID",
  );
  same(pending.codeRevision, required("GITHUB_SHA"), "pending code revision");
  return pending;
}

async function inspectTarget(): Promise<void> {
  const pending = await readPending();
  const { adapter, current } = await state();
  same(current.revision, pending.pendingStateRevision, "手動解決前のremote revision");
  if (current.transaction.marker.phase !== "notifications_in_progress") {
    throw new TypeError("手動解決前のmarker phaseが不正です");
  }
  same(current.transaction.marker.runId, pending.trackingRunId, "手動解決前のrun ID");
  same(current.transaction.record.recordDigest, pending.recordDigest, "手動解決前のrecord digest");
  same(
    current.transaction.marker.lastMessageDeliveryId ?? "",
    pending.deliveryId,
    "手動解決前のdelivery ID",
  );
  const count = await countSandboxReservationCommits(
    adapter,
    current.revision,
    current.transaction.marker.initialStateRevision,
    pending.trackingRunId,
    pending.deliveryOperationId,
    pending.attemptId,
  );
  same(count, 1, "手動解決前の元送達操作適用回数");
  await writeFile(
    required("SANDBOX_TARGET_OUTPUT_PATH"),
    `${JSON.stringify({
      runId: pending.trackingRunId,
      checkpointDigest: pending.checkpointDigest,
      deliveryId: pending.deliveryId,
      attemptId: pending.attemptId,
      notificationKeys: pending.notificationKeys,
      decision: required("SANDBOX_RESOLUTION_DECISION"),
    })}\n`,
  );
}

async function verifyResolved(): Promise<void> {
  const pending = await readPending();
  const { adapter, configuration, current } = await state();
  if (current.transaction.marker.phase !== "notifications_in_progress") {
    throw new TypeError("手動解決後のmarker phaseが不正です");
  }
  same(current.transaction.marker.runId, pending.trackingRunId, "手動解決後のrun ID");
  const receipt = decodeReceipt(
    await readFile(required("SANDBOX_MANUAL_RECEIPT_PATH")),
    nodeContentDigestPort,
  );
  const verified = await verifyManualResolutionReceipt(
    { adapter, configuration, knownSecrets: [], now: () => new Date() },
    receipt,
    current.revision,
  );
  if (
    receipt.receiptType !== "manual_resolution" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== pending.trackingRunId ||
    receipt.binding.checkpointDigest !== pending.checkpointDigest ||
    receipt.result.deliveryId !== pending.deliveryId ||
    receipt.result.deliveryAttemptId !== pending.attemptId ||
    receipt.result.decision !== required("SANDBOX_RESOLUTION_DECISION") ||
    verified.stateRevision !== current.revision
  ) {
    throw new TypeError("手動解決receiptが同じpending runに結合していません");
  }
  const count = await countSandboxReservationCommits(
    adapter,
    current.revision,
    current.transaction.marker.initialStateRevision,
    pending.trackingRunId,
    pending.deliveryOperationId,
    pending.attemptId,
  );
  same(count, 1, "手動解決後の元送達操作適用回数");
  await writeFile(required("GITHUB_OUTPUT"), `resolution_revision=${current.revision}\n`, {
    flag: "a",
  });
}

async function verifyCompleted(): Promise<void> {
  const pending = await readPending();
  const { adapter, configuration, current } = await state();
  if (current.transaction.marker.phase !== "run_finalized") {
    throw new TypeError("手動解決後のrunがfinalizeされていません");
  }
  same(current.transaction.marker.runId, pending.trackingRunId, "完了run ID");
  same(current.transaction.record.recordDigest, pending.recordDigest, "完了record digest");
  const receipt = decodeReceipt(
    await readFile(required("SANDBOX_MANUAL_RECEIPT_PATH")),
    nodeContentDigestPort,
  );
  if (
    receipt.receiptType !== "manual_resolution" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== pending.trackingRunId ||
    receipt.binding.checkpointDigest !== pending.checkpointDigest ||
    receipt.result.deliveryId !== pending.deliveryId ||
    receipt.result.deliveryAttemptId !== pending.attemptId ||
    receipt.result.decision !== required("SANDBOX_RESOLUTION_DECISION")
  ) {
    throw new TypeError("完了runの手動解決receiptが元送達と一致しません");
  }
  await verifyManualResolutionReceipt(
    { adapter, configuration, knownSecrets: [], now: () => new Date() },
    receipt,
    current.revision,
  );
  let revision = current.revision;
  let manualCommitCount = 0;
  let reachedPending = false;
  for (let index = 0; index < 200; index += 1) {
    if (revision === pending.pendingStateRevision) {
      reachedPending = true;
      break;
    }
    const commit = await adapter.readCommit(revision);
    if (
      commit.metadata.commitScope !== "operations_alert" &&
      commit.metadata.runId !== pending.trackingRunId
    ) {
      throw new TypeError("手動解決後に別runがstateへ保存されました");
    }
    if (commit.metadata.operationId === receipt.operationId) {
      same(commit.metadata.commitScope, "manual_resolution", "手動解決commit scope");
      manualCommitCount += 1;
    }
    if (commit.parent.status !== "present") {
      break;
    }
    revision = commit.parent.revision;
  }
  if (!reachedPending || manualCommitCount !== 1) {
    throw new TypeError("同じpending runから一度だけ手動解決していません");
  }
  const originalCount = await countSandboxReservationCommits(
    adapter,
    current.revision,
    current.transaction.marker.initialStateRevision,
    pending.trackingRunId,
    pending.deliveryOperationId,
    pending.attemptId,
  );
  same(originalCount, 1, "完了後の元送達操作適用回数");
  await writeFile(
    required("SANDBOX_COMPLETED_PROOF_PATH"),
    `${JSON.stringify({
      schemaVersion: 1,
      trackingRunId: pending.trackingRunId,
      pendingStateRevision: pending.pendingStateRevision,
      finalStateRevision: current.revision,
      originalDeliveryOperationId: pending.deliveryOperationId,
      originalOperationReservationCommitCount: originalCount,
      manualResolutionCommitCount: manualCommitCount,
      pendingAncestorOfFinal: true,
      newRunStarted: false,
    })}\n`,
  );
}

/** sandboxの実stateとreceiptから停止または完了の証拠を記録する。 */
export async function runSandboxNotificationEvidence(
  command: "pending" | "target" | "resolved" | "completed",
): Promise<void> {
  switch (command) {
    case "pending":
      await inspectPending();
      return;
    case "target":
      await inspectTarget();
      return;
    case "resolved":
      await verifyResolved();
      return;
    case "completed":
      await verifyCompleted();
      return;
  }
}

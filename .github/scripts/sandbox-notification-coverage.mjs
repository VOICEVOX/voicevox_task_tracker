import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

import { sandboxPendingNotificationSchema } from "../../dist/publication/sandbox-pending-evidence-schema.js";
import {
  assertCompleteSandboxStageCoverage,
  assertPendingSandboxStageCoverage,
  createSandboxStageCoverage,
} from "../../dist/infrastructure/tracking-run/sandbox-stage-coverage.js";
import { sha256 } from "./sandbox-continuity-result.mjs";
import {
  readSandboxCheckpointEvidence,
  unavailableLegacyStageCoverage,
} from "./sandbox-checkpoint-evidence.mjs";
import {
  countApplications,
  countPersonal,
  stateCommits,
  validateNotification,
  verifyPreviousSentMetadata,
} from "./sandbox-notification-coverage-checks.mjs";

const revision = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runId = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const scenario = z.enum([
  "send-clear-rejection",
  "hold",
  "acknowledge-current",
  "ambiguous-retry",
  "ambiguous-acknowledge",
]);
const completedProofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  trackingRunId: runId,
  pendingStateRevision: revision,
  finalStateRevision: revision,
  originalDeliveryOperationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
  originalOperationReservationCommitCount: z.literal(1),
  manualResolutionCommitCount: z.literal(1),
  pendingAncestorOfFinal: z.literal(true),
  newRunStarted: z.literal(false),
});
function required(name) {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function same(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function singleReceipt(receipts, type, phase) {
  const matches = receipts.filter(
    (receipt) => receipt.receiptType === type && (phase == null || receipt.phase === phase),
  );
  if (matches.length !== 1) {
    throw new TypeError(`${type} ${phase ?? ""} receiptが一意ではありません`);
  }
  return matches[0];
}

function main() {
  const context = readJson(required("SANDBOX_CONTEXT_PATH"));
  const control = readJson(required("SANDBOX_CONTROL_PATH"));
  const chainBytes = readFileSync(required("SANDBOX_RECEIPT_CHAIN_PATH"));
  const chain = readJson(required("SANDBOX_RECEIPT_CHAIN_PATH"));
  const evidence = readSandboxCheckpointEvidence(
    readJson(required("SANDBOX_RECORD_PATH")),
    required("SANDBOX_CHECKPOINT_PATH"),
    required("SANDBOX_SIDECAR_PATH"),
  );
  if (evidence.kind === "legacy_without_analysis_proof") {
    writeFileSync(
      required("SANDBOX_COVERAGE_OUTPUT_PATH"),
      `${JSON.stringify(unavailableLegacyStageCoverage(evidence.record, scenario.parse(required("SANDBOX_SCENARIO_ID"))))}\n`,
    );
    throw new TypeError("旧V2 runには永続化された解析段階証拠がありません");
  }
  const { record, analysis } = evidence;
  const metrics = record.runFinalizationPolicy.report.metrics;
  const markerBytes = readFileSync(required("SANDBOX_MARKER_PATH"));
  const marker = readJson(required("SANDBOX_MARKER_PATH"));
  const ledger = readJson(required("SANDBOX_LEDGER_PATH"));
  const snapshot = readJson(required("SANDBOX_SNAPSHOT_PATH"));
  const verification = readFileSync(required("SANDBOX_STATE_VERIFICATION_PATH"), "utf8");
  const scenarioId = scenario.parse(required("SANDBOX_SCENARIO_ID"));
  const phase = z.enum(["first", "resolution"]).parse(required("SANDBOX_NOTIFICATION_PHASE"));
  const trackingRunId = runId.parse(record.runIdentity.runId);
  const finalStateRevision = revision.parse(required("SANDBOX_FINAL_REVISION"));
  const receipts = chain.entries.map((entry) => entry.receipt);
  const initial = singleReceipt(receipts, "initial_state_commit");
  const initialBuild = singleReceipt(receipts, "pages_build", "initial");
  const initialPages = singleReceipt(receipts, "pages_deployment", "initial");
  const settlement = singleReceipt(receipts, "notification_settlement");
  const finalization = singleReceipt(receipts, "run_finalization");
  const historyBuild = singleReceipt(receipts, "pages_build", "notification_history");
  const historyPages = singleReceipt(receipts, "pages_deployment", "notification_history");
  const completion = singleReceipt(receipts, "completion");
  const pending =
    phase === "resolution"
      ? sandboxPendingNotificationSchema.parse(readJson(required("SANDBOX_PENDING_REPORT_PATH")))
      : null;
  const manualArtifact =
    phase === "resolution" ? readJson(required("SANDBOX_MANUAL_RECEIPT_PATH")) : null;
  const completedProof =
    phase === "resolution"
      ? completedProofSchema.parse(readJson(required("SANDBOX_COMPLETED_PROOF_PATH")))
      : null;
  const stageCoverage = createSandboxStageCoverage({
    durableRecord: record,
    receiptEntries: chain.entries,
    runId: trackingRunId,
    invocationId: analysis.invocationId,
    checkpointDigest: record.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    baseStateRevision: analysis.baseStateRevision,
  });
  assertCompleteSandboxStageCoverage(stageCoverage);
  const analysisSourceActionsRunId = required("SANDBOX_ANALYSIS_SOURCE_RUN_ID");
  if (
    record.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
    record.runtimeRecoveryPlan.workflowRunId !== analysisSourceActionsRunId ||
    record.runtimeRecoveryPlan.codeRevision !== context.codeRevision
  ) {
    throw new TypeError("解析段階記録の元Actions runまたはcode revisionが一致しません");
  }
  if (pending != null) {
    assertPendingSandboxStageCoverage(pending);
    same(
      pending.analysisStageRecordDigest,
      stageCoverage.analysisStageRecordDigest,
      "再開前の解析段階記録",
    );
    same(pending.actionsRunId, analysisSourceActionsRunId, "再開前の解析元Actions run");
    const initialPagesReceipt = receipts.find(
      (receipt) => receipt.receiptType === "pages_deployment" && receipt.phase === "initial",
    );
    if (
      initialPagesReceipt?.receiptDigest !== pending.initialPagesReceiptDigest &&
      initialPagesReceipt?.result?.observedSourceReceiptDigest !== pending.initialPagesReceiptDigest
    ) {
      throw new TypeError("再開後の初回Pages receiptが停止時のreceiptに結合していません");
    }
  }
  if (
    verification.includes("snapshot:") === false ||
    verification.includes("notification ledger:") === false ||
    initialBuild.status !== "built" ||
    (initialPages.status !== "deployed" && initialPages.status !== "replayed_same_content") ||
    initialPages.result?.externalReference.kind !== "recording" ||
    ((historyPages.status === "deployed" || historyPages.status === "replayed_same_content") &&
      historyPages.result?.externalReference.kind !== "recording") ||
    marker.phase !== "run_finalized" ||
    marker.runId !== trackingRunId ||
    record.runIdentity.runId !== trackingRunId ||
    record.executionPolicy.effectTarget !== "sandbox" ||
    record.executionPolicy.executionShape !== "split_workflow" ||
    snapshot.run.id !== trackingRunId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    marker.publicationRecordDigest !== record.recordDigest ||
    settlement.result.action !== record.notificationOutbox.action ||
    finalization.result.resultingStateRevision !== finalStateRevision ||
    completion.result.finalStateRevision !== finalStateRevision ||
    initial.result.resultingStateRevision !== marker.initialStateRevision ||
    context.codeRevision !== required("GITHUB_SHA") ||
    context.sourceRepository !== "Hiroshiba/voicevox_task_tracker" ||
    context.environmentId !== required("SANDBOX_ENVIRONMENT_ID") ||
    context.baseStateRevision !== required("SANDBOX_BASE_REVISION") ||
    control.scenarioId !== scenarioId ||
    control.notificationAction !== record.notificationOutbox.action ||
    control.environmentId !== context.environmentId ||
    control.stateRef !== required("SANDBOX_STATE_BRANCH") ||
    control.baseStateRevision !== context.baseStateRevision
  ) {
    throw new TypeError("notification scenarioのstate、artifactまたはreceipt chainが一致しません");
  }
  const { recordDigest: storedDigest, ...recordPayload } = record;
  same(storedDigest, sha256(Buffer.from(canonicalJson(recordPayload))), "durable record digest");
  const storedCheckpointDigest = record.checkpointDigest;
  for (const receipt of receipts) {
    same(receipt.binding.runId, trackingRunId, "receipt run ID");
    same(receipt.binding.checkpointDigest, storedCheckpointDigest, "receipt checkpoint digest");
    same(
      receipt.binding.checkpointFileDigest,
      record.checkpointFileDigest,
      "receipt checkpoint file digest",
    );
  }
  if (phase === "first") {
    same(context.baseStateRevision, record.baseStateRevision.revision, "初回seed revision");
    same(control.recordingOutcome, required("SANDBOX_RECORDING_OUTCOME"), "初回recording outcome");
  } else {
    same(
      context.baseStateRevision,
      revision.parse(pending.pendingStateRevision),
      "手動解決のremote base revision",
    );
    same(record.baseStateRevision.revision, pending.baseStateRevision, "元runのseed revision");
    same(trackingRunId, pending.trackingRunId, "手動解決後のtracking run ID");
    same(storedDigest, pending.recordDigest, "手動解決後のdurable record digest");
    same(storedCheckpointDigest, pending.checkpointDigest, "手動解決後のcheckpoint digest");
    same(context.environmentId, pending.environmentId, "手動解決後のenvironment ID");
    same(completedProof.finalStateRevision, finalStateRevision, "手動解決後のfinal revision");
    same(control.recordingOutcome, "recorded_success", "再開時recording outcome");
  }
  const notification = validateNotification({
    scenarioId,
    phase,
    record,
    ledger,
    receipts,
    historyPages,
    historyBuild,
    pending,
    manualArtifact,
    completedProof,
  });
  if (
    receipts.some(
      (receipt) =>
        receipt.receiptType === "notification_message" &&
        receipt.status === "sent" &&
        !receipt.result.discordMessageId?.startsWith("recording:v1:"),
    )
  ) {
    throw new TypeError("sandboxの送信成功がrecording port由来ではありません");
  }
  const commits = stateCommits(receipts);
  const previousSentCount = verifyPreviousSentMetadata(record, ledger);
  const applications = countApplications(snapshot.items);
  const personal = countPersonal(snapshot.items);
  const coverage = {
    schemaVersion: 2,
    scenarioId,
    notificationPhase: phase,
    run: {
      actionsRunId: required("GITHUB_RUN_ID"),
      actionsRunAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
      trackingRunId,
      environmentId: context.environmentId,
      stateRef: required("SANDBOX_STATE_BRANCH"),
      codeRevision: revision.parse(context.codeRevision),
      invocationBaseStateRevision: revision.parse(context.baseStateRevision),
      originalBaseStateRevision: revision.parse(record.baseStateRevision.revision),
      finalStateRevision,
    },
    ...stageCoverage,
    stageLineage: {
      analysisSourceActionsRunId,
      analysisStageRecordDigest: stageCoverage.analysisStageRecordDigest,
      finalReceiptChainDigest: sha256(chainBytes),
      pendingReceiptChainDigest: pending?.initialReceiptChainDigest ?? null,
    },
    checkpoint: {
      checkpointDigest: digest.parse(storedCheckpointDigest),
      checkpointFileDigest: digest.parse(record.checkpointFileDigest),
      sidecarByteLength: evidence.kind === "artifact_cross_checked" ? evidence.byteLength : null,
      evidenceSource: evidence.kind,
    },
    state: {
      verification,
      markerPhase: marker.phase,
      markerDigest: sha256(markerBytes),
      publicationRecordDigest: record.recordDigest,
      initialStateRevision: marker.initialStateRevision,
      stateCommitRevisions: commits,
      stateCommitCount: new Set(commits).size,
      previousSentMetadataPreservedCount: previousSentCount,
      notificationLedgerSchemaVersion: ledger.schemaVersion,
      snapshotSchemaVersion: snapshot.schemaVersion,
    },
    receiptChain: {
      digest: sha256(chainBytes),
      count: receipts.length,
      receiptDigests: receipts.map((receipt) => receipt.receiptDigest),
      notificationCommitRevisions: stateCommits(
        receipts.filter((receipt) => receipt.receiptType === "notification_message"),
      ),
    },
    analysis: {
      genericAi: {
        plannedLogicalCandidateCount: analysis.plannedLogicalCandidateCount,
        processAttemptCount: metrics.aiProcessAttemptCount,
        cacheHitCount: metrics.aiCacheHitCount,
        retainedResultCount: metrics.aiRetainedResultCount,
        applications,
      },
      personalReminderAi: {
        plannedCauseCount: personal.planned,
        processCallCount: metrics.personalReminderAiCallCount,
        cacheHitCount: metrics.personalReminderAiCacheHitCount,
        reusedAssessmentCount: metrics.personalReminderAssessmentReuseCount,
        unknownCount: metrics.personalReminderUnknownCount,
        failedCount: personal.failed,
        deferredCount: personal.deferred,
      },
    },
    notification: {
      ...notification,
      recordingOutcome: control.recordingOutcome,
      settlementRevision: settlement.result.resultingStateRevision,
    },
    pages: {
      initial: {
        buildStatus: initialBuild.status,
        status: initialPages.status,
        externalReference: initialPages.result.externalReference,
      },
      notificationHistory: {
        buildStatus: historyBuild.status,
        status: historyPages.status,
        externalReference: historyPages.result?.externalReference ?? null,
      },
    },
    ambiguousInitial: pending,
    completedResolutionProof: completedProof,
    productionAdapters: { pagesDeployExecuted: false, discordSendExecuted: false },
    unexecutedBranches: [
      { branch: "production_pages_deploy", reason: "sandbox recording port" },
      { branch: "production_discord_send", reason: "sandbox recording port" },
      ...[
        "send_clear_rejection",
        "hold",
        "acknowledge_current",
        "ambiguous_retry",
        "ambiguous_acknowledge",
      ]
        .filter((branch) => branch !== scenarioId.replaceAll("-", "_"))
        .map((branch) => ({ branch, reason: "別の通知scenarioで確認する" })),
    ],
  };
  const coverageSource = `${JSON.stringify(coverage)}\n`;
  writeFileSync(required("SANDBOX_COVERAGE_OUTPUT_PATH"), coverageSource);
  writeFileSync(
    required("SANDBOX_RESULT_OUTPUT_PATH"),
    `${JSON.stringify({
      schemaVersion: 2,
      environmentId: context.environmentId,
      scenarioId,
      actionsRunId: required("GITHUB_RUN_ID"),
      actionsRunAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
      trackingRunId,
      baseStateRevision: context.baseStateRevision,
      finalStateRevision,
      checkpointDigest: storedCheckpointDigest,
      checkpointFileDigest: record.checkpointFileDigest,
      publicationRecordDigest: record.recordDigest,
      receiptChainDigest: sha256(chainBytes),
      markerDigest: sha256(markerBytes),
      coverageDigest: sha256(Buffer.from(coverageSource)),
      productionPagesDeployed: false,
      productionDiscordSent: false,
    })}\n`,
  );
}

main();

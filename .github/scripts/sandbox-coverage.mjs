import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";
import {
  assertCompleteSandboxStageCoverage,
  createSandboxStageCoverage,
} from "../../dist/infrastructure/tracking-run/sandbox-stage-coverage.js";
import { readVerifiedFirstResult, resultSchema, sha256 } from "./sandbox-continuity-result.mjs";
import {
  readSandboxCheckpointEvidence,
  unavailableLegacyStageCoverage,
} from "./sandbox-checkpoint-evidence.mjs";

const revision = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runId = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);

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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function countApplications(items) {
  const counts = { executed: 0, cache: 0, reused: 0, retained: 0, failed: 0, deferred: 0 };
  for (const item of items) {
    for (const application of Object.values(item.aiAnalysis.applications)) {
      if (application.status === "current_ai") {
        counts[application.origin === "verified_reuse" ? "reused" : application.origin] += 1;
      }
      if (application.status === "retained_ai") {
        counts.retained += 1;
      }
      if (application.reason === "failed" || application.reason === "deferred") {
        counts[application.reason] += 1;
      }
    }
  }
  return counts;
}

function countPersonal(items) {
  const counts = { planned: 0, failed: 0, deferred: 0, unknown: 0 };
  for (const item of items) {
    for (const cause of item.personalReminderCauses) {
      counts.planned += 1;
      const status = cause.latestAttempt.status;
      if (status === "failed" || status === "deferred") {
        counts[status] += 1;
      }
      if (cause.adoptedAssessment.status === "not_available") {
        counts.unknown += 1;
      }
    }
  }
  return counts;
}

function stateCommits(receipts) {
  return receipts.flatMap((receipt) => {
    if (
      receipt.receiptType === "initial_state_commit" ||
      receipt.receiptType === "notification_settlement" ||
      receipt.receiptType === "run_finalization" ||
      receipt.receiptType === "manual_resolution"
    ) {
      return [receipt.result.resultingStateRevision];
    }
    if (receipt.receiptType === "notification_message") {
      return [receipt.result.reservationStateRevision, receipt.result.ledgerStateRevision];
    }
    return [];
  });
}

function createCoverage() {
  const context = readJson(required("SANDBOX_CONTEXT_PATH"));
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
      `${JSON.stringify(unavailableLegacyStageCoverage(evidence.record, "continuity"))}\n`,
    );
    throw new TypeError("旧V2 runには永続化された解析段階証拠がありません");
  }
  const { record, analysis } = evidence;
  const metrics = record.runFinalizationPolicy.report.metrics;
  const marker = readJson(required("SANDBOX_MARKER_PATH"));
  const snapshot = readJson(required("SANDBOX_SNAPSHOT_PATH"));
  const ledger = readJson(required("SANDBOX_LEDGER_PATH"));
  const stateVerification = readFileSync(required("SANDBOX_STATE_VERIFICATION_PATH"), "utf8");
  if (
    !stateVerification.includes("snapshot:") ||
    !stateVerification.includes("notification ledger:")
  ) {
    throw new TypeError("state検証結果がありません");
  }
  const receipts = chain.entries.map((entry) => entry.receipt);
  const receipt = (type, phase) => {
    const matches = receipts.filter(
      (entry) => entry.receiptType === type && (phase == null || entry.phase === phase),
    );
    if (matches.length !== 1) {
      throw new TypeError(`${type} ${phase ?? ""} receiptが一意ではありません`);
    }
    return matches[0];
  };
  const checkpointDigest = digest.parse(record.checkpointDigest);
  const checkpointFileDigest = digest.parse(record.checkpointFileDigest);
  const trackingRunId = runId.parse(record.runIdentity.runId);
  const baseStateRevision = revision.parse(context.baseStateRevision);
  const finalStateRevision = revision.parse(required("SANDBOX_FINAL_REVISION"));
  assertEqual(context.codeRevision, required("GITHUB_SHA"), "sandbox code revision");
  assertEqual(context.environmentId, required("SANDBOX_ENVIRONMENT_ID"), "sandbox environment ID");
  const { recordDigest: storedRecordDigest, ...recordPayload } = record;
  assertEqual(storedRecordDigest, sha256(canonicalJson(recordPayload)), "durable record digest");
  assertEqual(record.runIdentity.runId, trackingRunId, "durable record run ID");
  assertEqual(record.checkpointDigest, checkpointDigest, "durable record checkpoint digest");
  assertEqual(
    record.checkpointFileDigest,
    checkpointFileDigest,
    "durable record checkpoint file digest",
  );
  if (
    record.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
    record.runtimeRecoveryPlan.workflowRunId !== required("SANDBOX_ANALYSIS_SOURCE_RUN_ID")
  ) {
    throw new TypeError("解析段階記録の元Actions runが一致しません");
  }
  assertEqual(marker.runId, trackingRunId, "marker run ID");
  assertEqual(marker.checkpointDigest, checkpointDigest, "marker checkpoint digest");
  assertEqual(marker.publicationRecordDigest, record.recordDigest, "marker record digest");
  assertEqual(marker.phase, "run_finalized", "marker phase");
  assertEqual(snapshot.run.id, trackingRunId, "snapshot run ID");
  assertEqual(analysis.baseStateRevision.revision, baseStateRevision, "checkpoint base revision");
  assertEqual(record.baseStateRevision.revision, baseStateRevision, "record base revision");
  assertEqual(marker.baseStateRevision, baseStateRevision, "marker base revision");
  assertEqual(
    receipt("completion").result.finalStateRevision,
    finalStateRevision,
    "completion final revision",
  );
  assertEqual(
    receipt("run_finalization").result.resultingStateRevision,
    finalStateRevision,
    "finalization revision",
  );
  assertEqual(
    receipt("initial_state_commit").result.resultingStateRevision,
    marker.initialStateRevision,
    "initial marker revision",
  );
  for (const entry of receipts) {
    assertEqual(entry.binding.runId, trackingRunId, "receipt run ID");
    assertEqual(entry.binding.checkpointDigest, checkpointDigest, "receipt checkpoint digest");
    assertEqual(
      entry.binding.checkpointFileDigest,
      checkpointFileDigest,
      "receipt checkpoint file digest",
    );
  }
  const initialBuild = receipt("pages_build", "initial");
  const initialPages = receipt("pages_deployment", "initial");
  const historyBuild = receipt("pages_build", "notification_history");
  const historyPages = receipt("pages_deployment", "notification_history");
  const settlement = receipt("notification_settlement");
  const messageReceipts = receipts.filter((entry) => entry.receiptType === "notification_message");
  const sentKeys = ledger.entries
    .filter((entry) => entry.status === "sent")
    .map((entry) => entry.notificationKey);
  const sentLedgerKeyDigests = sentKeys.map((key) => sha256(key)).sort();
  const applications = countApplications(snapshot.items);
  const personal = countPersonal(snapshot.items);
  const continuityPhase = required("SANDBOX_CONTINUITY_PHASE");
  const first = continuityPhase === "second" ? readVerifiedFirstResult() : null;
  const firstCoverage = first == null ? null : readJson(required("SANDBOX_FIRST_COVERAGE_PATH"));
  if (continuityPhase !== "first" && continuityPhase !== "second") {
    throw new TypeError("coverageにはcontinuity phaseが必要です");
  }
  if (continuityPhase === "first") {
    if (
      messageReceipts.filter((entry) => entry.status === "sent").length < 1 ||
      historyPages.status !== "deployed"
    ) {
      throw new TypeError("first runにrecorded sentと通知履歴Pagesがありません");
    }
  } else {
    assertCompleteSandboxStageCoverage(firstCoverage);
    assertEqual(baseStateRevision, first.finalStateRevision, "second baseとfirst final revision");
    if (
      trackingRunId === first.trackingRunId ||
      record.notificationOutbox.delivery !== "no_candidates" ||
      messageReceipts.length !== 0 ||
      historyPages.status !== "not_required" ||
      sentKeys.length < 1 ||
      !Array.isArray(firstCoverage.state.sentLedgerKeyDigests) ||
      firstCoverage.state.sentLedgerKeyDigests.length < 1 ||
      firstCoverage.state.sentLedgerKeyDigests.some((key) => !sentLedgerKeyDigests.includes(key))
    ) {
      throw new TypeError("second runのsame-key suppressionとsend 0件を確認できません");
    }
  }
  if (
    initialBuild.status !== "built" ||
    initialPages.result?.externalReference?.kind !== "recording" ||
    (historyPages.status === "deployed" &&
      historyPages.result?.externalReference?.kind !== "recording") ||
    settlement.result.action !== "send"
  ) {
    throw new TypeError("sandbox Pagesと通知の記録結果が不正です");
  }
  const stages = createSandboxStageCoverage({
    durableRecord: record,
    receiptEntries: chain.entries,
    runId: trackingRunId,
    invocationId: analysis.invocationId,
    checkpointDigest,
    checkpointFileDigest,
    baseStateRevision: analysis.baseStateRevision,
  });
  assertCompleteSandboxStageCoverage(stages);
  const coverage = {
    schemaVersion: 2,
    scenarioId: "continuity",
    continuityPhase,
    run: {
      actionsRunId: required("GITHUB_RUN_ID"),
      actionsRunAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
      trackingRunId,
      codeRevision: revision.parse(context.codeRevision),
      environmentId: context.environmentId,
      stateRef: required("SANDBOX_STATE_BRANCH"),
      baseStateRevision,
      finalStateRevision,
    },
    ...stages,
    stageLineage: {
      analysisSourceActionsRunId: required("SANDBOX_ANALYSIS_SOURCE_RUN_ID"),
      analysisStageRecordDigest: stages.analysisStageRecordDigest,
      finalReceiptChainDigest: sha256(chainBytes),
    },
    checkpoint: {
      checkpointDigest,
      checkpointFileDigest,
      sidecarByteLength: evidence.kind === "artifact_cross_checked" ? evidence.byteLength : null,
      evidenceSource: evidence.kind,
    },
    state: {
      verification: stateVerification,
      snapshotSchemaVersion: snapshot.schemaVersion,
      notificationLedgerSchemaVersion: ledger.schemaVersion,
      markerPhase: marker.phase,
      markerDigest: sha256(readFileSync(required("SANDBOX_MARKER_PATH"))),
      publicationRecordDigest: record.recordDigest,
      initialStateRevision: marker.initialStateRevision,
      stateCommitRevisions: stateCommits(receipts),
      stateCommitCount: new Set(stateCommits(receipts)).size,
      sentLedgerEntryCount: sentKeys.length,
      sentLedgerKeyDigests,
    },
    receiptChain: {
      digest: sha256(chainBytes),
      count: receipts.length,
      receiptDigests: receipts.map((entry) => entry.receiptDigest),
      notificationCommitRevisions: stateCommits(messageReceipts),
    },
    analysis: {
      incrementalCollection: {
        changedItemCount: metrics.changedItemCount,
        itemCount: metrics.itemCount,
      },
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
      action: settlement.result.action,
      recordingOutcome: required("SANDBOX_RECORDING_OUTCOME"),
      selectedDelivery: record.notificationOutbox.delivery,
      selectedCandidateCount: record.notificationOutbox.selectedContext?.candidates?.length ?? 0,
      recordedSendCount: messageReceipts.filter((entry) => entry.status === "sent").length,
      messageSendCount: messageReceipts.length,
      settlementRevision: settlement.result.resultingStateRevision,
      sameKeySuppressionConsistent:
        continuityPhase === "second" &&
        firstCoverage.state.sentLedgerKeyDigests.every((key) =>
          sentLedgerKeyDigests.includes(key),
        ) &&
        messageReceipts.length === 0,
      branchCounts: {
        recordedSuccess: messageReceipts.filter((entry) => entry.status === "sent").length,
        recordedClearRejection: 0,
        recordedAmbiguous: 0,
        noCandidates: record.notificationOutbox.delivery === "no_candidates" ? 1 : 0,
      },
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
    continuity: first == null ? null : { firstResult: first, remoteBaseReloaded: true },
    productionAdapters: { pagesDeployExecuted: false, discordSendExecuted: false },
    unexecutedBranches: [
      { branch: "production_pages_deploy", reason: "sandbox recording port" },
      { branch: "production_discord_send", reason: "sandbox recording port" },
      { branch: "clear_rejection", reason: "notification scenario matrixで確認する" },
      { branch: "hold", reason: "notification scenario matrixで確認する" },
      { branch: "acknowledge_current", reason: "notification scenario matrixで確認する" },
      { branch: "ambiguous_resolution", reason: "notification scenario matrixで確認する" },
    ],
  };
  const coverageSource = `${JSON.stringify(coverage)}\n`;
  writeFileSync(required("SANDBOX_COVERAGE_OUTPUT_PATH"), coverageSource);
  const result = resultSchema.parse({
    schemaVersion: 2,
    environmentId: context.environmentId,
    scenarioId: "continuity",
    continuityPhase,
    actionsRunId: required("GITHUB_RUN_ID"),
    actionsRunAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    codeRevision: context.codeRevision,
    trackingRunId,
    baseStateRevision,
    finalStateRevision,
    checkpointDigest,
    checkpointFileDigest,
    publicationRecordDigest: record.recordDigest,
    receiptChainDigest: sha256(chainBytes),
    markerDigest: sha256(readFileSync(required("SANDBOX_MARKER_PATH"))),
    coverageDigest: sha256(Buffer.from(coverageSource)),
    productionPagesDeployed: false,
    productionDiscordSent: false,
  });
  writeFileSync(required("SANDBOX_RESULT_OUTPUT_PATH"), `${JSON.stringify(result)}\n`);
}

if (process.argv[2] === "verify-first") {
  readVerifiedFirstResult();
} else if (process.argv[2] === "report") {
  createCoverage();
} else {
  throw new TypeError("sandbox coverage commandが不正です");
}

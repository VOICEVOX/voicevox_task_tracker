import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";
import { parseStateNotificationLedger } from "../../dist/persistence/state-documents.js";
import {
  assertCompleteSandboxStageCoverage,
  createSandboxStageCoverage,
} from "../../dist/infrastructure/tracking-run/sandbox-stage-coverage.js";
import { parseSandboxReusePlanProof } from "../../dist/infrastructure/tracking-run/sandbox-reuse-plan-proof.js";
import { copySandboxCheckpointInputEvidence } from "../../dist/infrastructure/tracking-run/sandbox-generic-ai-input-evidence.js";
import { readVerifiedFirstResult, resultSchema, sha256 } from "./sandbox-continuity-result.mjs";
import { plannedSnapshotReuseWitness, verifyCacheProbeAdoption } from "./sandbox-reuse-witness.mjs";
import { firstFileCacheProbeSource } from "./sandbox-cache-probe-source.mjs";
import { assertSecondNotificationCoverage } from "./sandbox-continuity-notification.mjs";
import {
  assertStrictZeroNotificationCoverage,
  bindStrictZeroSourceProof,
} from "./sandbox-strict-zero-coverage.mjs";
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

async function createCoverage() {
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
  const sentMessageReceipts = messageReceipts.filter((entry) => entry.status === "sent");
  const recordedSendKeyDigests = sentMessageReceipts
    .flatMap((entry) => entry.result.notificationKeys.map((key) => sha256(key)))
    .sort();
  const sentKeys = ledger.entries
    .filter((entry) => entry.status === "sent")
    .map((entry) => entry.notificationKey);
  const sentLedgerKeyDigests = sentKeys.map((key) => sha256(key)).sort();
  const applications = countApplications(snapshot.items);
  const personal = countPersonal(snapshot.items);
  const scenarioId = required("SANDBOX_SCENARIO_ID");
  if (scenarioId !== "continuity" && scenarioId !== "continuity-strict-zero") {
    throw new TypeError("continuity scenarioが不正です");
  }
  const strictZero = scenarioId === "continuity-strict-zero";
  const continuityPhase = required("SANDBOX_CONTINUITY_PHASE");
  const first = continuityPhase === "second" ? readVerifiedFirstResult() : null;
  const firstCoverage = first == null ? null : readJson(required("SANDBOX_FIRST_COVERAGE_PATH"));
  const firstSnapshot = first == null ? null : readJson(required("SANDBOX_FIRST_SNAPSHOT_PATH"));
  const suppressedKeyDigests =
    evidence.kind === "artifact_cross_checked"
      ? evidence.validatedPayload.sentSuppressedCandidateKeys.map((key) => sha256(key)).sort()
      : [];
  let sameKeySuppressionConsistent = false;
  let snapshotReuses = [];
  let snapshotReuseWitness = null;
  let reusePlanProofDigest = null;
  let selectedCacheProbe = null;
  if (continuityPhase !== "first" && continuityPhase !== "second") {
    throw new TypeError("coverageにはcontinuity phaseが必要です");
  }
  if (continuityPhase === "first") {
    if (
      context.analysisMode.kind !== "normal" ||
      z.number().int().nonnegative().parse(applications.executed) < 1 ||
      z.number().int().nonnegative().parse(metrics.aiProcessAttemptCount) < 1 ||
      messageReceipts.filter((entry) => entry.status === "sent").length < 1 ||
      recordedSendKeyDigests.some((key) => !sentLedgerKeyDigests.includes(key)) ||
      historyPages.status !== "deployed"
    ) {
      throw new TypeError("first runに採用済み実AI、recorded sentまたは通知履歴Pagesがありません");
    }
  } else {
    if (context.analysisMode.kind !== "cache_probe") {
      throw new TypeError("second runにcache probeの実行contextがありません");
    }
    assertCompleteSandboxStageCoverage(firstCoverage);
    if (baseStateRevision === first.finalStateRevision) {
      throw new TypeError("second baseにはfirst ready revisionが必要です");
    }
    assertEqual(firstSnapshot.run.id, first.trackingRunId, "first snapshot run ID");
    const reference = context.analysisMode.probe;
    assertEqual(
      reference.firstFinalStateRevision,
      first.finalStateRevision,
      "cache probeのF1 revision",
    );
    assertEqual(reference.firstTrackingRunId, first.trackingRunId, "cache probeのfirst run ID");
    const source = await firstFileCacheProbeSource(
      required("SANDBOX_STATE_REPOSITORY_PATH"),
      first.finalStateRevision,
      first.trackingRunId,
    );
    assertEqual(source.candidateDigest, reference.candidateDigest, "F1の実file cache候補集合");
    const reusePlanProofPath = required("SANDBOX_REUSE_PLAN_PATH");
    const reusePlanProof = parseSandboxReusePlanProof(readJson(reusePlanProofPath));
    assertEqual(
      reusePlanProof.actionsRunId,
      required("GITHUB_RUN_ID"),
      "再利用計画のActions run ID",
    );
    assertEqual(
      reusePlanProof.actionsRunAttempt,
      Number(required("GITHUB_RUN_ATTEMPT")),
      "再利用計画のActions run attempt",
    );
    assertEqual(reusePlanProof.runId, trackingRunId, "再利用計画のtracking run ID");
    assertEqual(reusePlanProof.invocationId, analysis.invocationId, "再利用計画のinvocation ID");
    assertEqual(reusePlanProof.codeRevision, context.codeRevision, "再利用計画のcode revision");
    assertEqual(reusePlanProof.baseStateRevision, baseStateRevision, "再利用計画のbase revision");
    assertEqual(
      reusePlanProof.cacheProbeSourceDigest,
      reference.candidateDigest,
      "再利用計画のcache probe候補集合",
    );
    const probe = reusePlanProof.cacheProbe;
    const firstCandidate = source.candidates.find((candidate) => candidate.nodeId === probe.nodeId);
    if (
      firstCandidate == null ||
      probe.elements.some(
        (element) =>
          !firstCandidate.elements.some(
            (candidate) => canonicalJson(candidate) === canonicalJson(element),
          ),
      )
    ) {
      throw new TypeError("再利用計画のcache probeがF1の実file cache候補にありません");
    }
    selectedCacheProbe = probe;
    reusePlanProofDigest = sha256(readFileSync(reusePlanProofPath));
    ({ snapshotReuses, snapshotReuseWitness } = plannedSnapshotReuseWitness(
      firstSnapshot.items,
      snapshot.items,
      firstSnapshot.generatedAt,
      reusePlanProof.choices,
      probe.nodeId,
    ));
    verifyCacheProbeAdoption(firstSnapshot.items, snapshot.items, probe);
    const firstSentKeyDigests = z
      .array(digest)
      .min(1)
      .parse(firstCoverage.state.sentLedgerKeyDigests);
    const firstRecordedSendKeyDigests = z
      .array(digest)
      .min(1)
      .parse(firstCoverage.receiptChain.recordedSendKeyDigests);
    const firstExecutedCount = z
      .number()
      .int()
      .nonnegative()
      .parse(firstCoverage.analysis.genericAi.applications.executed);
    const cacheApplicationCount = z.number().int().nonnegative().parse(applications.cache);
    const cacheHitCount = z.number().int().nonnegative().parse(metrics.aiCacheHitCount);
    const firstLedger = parseStateNotificationLedger(
      execFileSync(
        "git",
        [
          "-C",
          required("SANDBOX_STATE_REPOSITORY_PATH"),
          "show",
          `${first.finalStateRevision}:state/notification-ledger.json`,
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    assertSecondNotificationCoverage({
      firstLedger,
      ledger,
      firstSentKeyDigests,
      firstRecordedSendKeyDigests,
      suppressedKeyDigests,
      outbox: record.notificationOutbox,
      messageReceipts,
      historyBuild,
      historyPages,
    });
    sameKeySuppressionConsistent = true;
    if (
      trackingRunId === first.trackingRunId ||
      evidence.kind !== "artifact_cross_checked" ||
      firstExecutedCount < 1 ||
      snapshotReuses.length < 1 ||
      cacheApplicationCount < 1 ||
      cacheHitCount < 1 ||
      sentKeys.length < 1
    ) {
      throw new TypeError("second runの再利用とAI cache hitを確認できません");
    }
  }
  if (
    initialBuild.status !== "built" ||
    initialPages.status !== "deployed" ||
    initialPages.result?.externalReference?.kind !== "recording" ||
    (historyPages.status === "deployed" && historyBuild.status !== "built") ||
    (historyPages.status === "deployed" &&
      historyPages.result?.externalReference?.kind !== "recording") ||
    (historyPages.status === "not_required" && historyBuild.status !== "not_required") ||
    settlement.result.action !== "send" ||
    required("SANDBOX_RECORDING_OUTCOME") !== "recorded_success" ||
    messageReceipts.length !== sentMessageReceipts.length
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
  const strictZeroSourceProof = strictZero
    ? bindStrictZeroSourceProof({
        evidence,
        unboundProofPath: required("SANDBOX_STRICT_ZERO_UNBOUND_PROOF_PATH"),
        outputPath: required("SANDBOX_STRICT_ZERO_SOURCE_PROOF_OUTPUT_PATH"),
        runId: trackingRunId,
        record,
        snapshot,
        finalStateRevision,
      })
    : null;
  const strictZeroCoverage =
    strictZeroSourceProof == null
      ? null
      : assertStrictZeroNotificationCoverage({
          phase: continuityPhase,
          record,
          ledger,
          messageReceipts,
          historyBuild,
          historyPages,
          baseStateRevision,
          stateRepositoryPath: required("SANDBOX_STATE_REPOSITORY_PATH"),
          first,
          sourceProof: strictZeroSourceProof,
          firstSourceProofPath:
            continuityPhase === "second" ? required("SANDBOX_FIRST_SOURCE_PROOF_PATH") : null,
          metrics,
        });
  const coverage = {
    schemaVersion: 2,
    scenarioId,
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
      recordedSendKeyDigests,
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
      sentSuppressedCandidateKeyDigests: suppressedKeyDigests,
      sameKeySuppressionConsistent,
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
    continuity:
      first == null
        ? null
        : {
            firstResult: first,
            firstSnapshotDigest: sha256(readFileSync(required("SANDBOX_FIRST_SNAPSHOT_PATH"))),
            snapshotReuses,
            snapshotReuseWitness,
            reusePlanProofDigest,
            cacheProbe: selectedCacheProbe,
            remoteBaseReloaded: true,
          },
    ...(strictZeroCoverage == null ? {} : { strictZero: strictZeroCoverage }),
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
    scenarioId,
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
  if (continuityPhase === "first") {
    await copySandboxCheckpointInputEvidence(
      required("SANDBOX_CHECKPOINT_PATH"),
      required("SANDBOX_RESULT_OUTPUT_PATH"),
    );
  }
  writeFileSync(required("SANDBOX_RESULT_OUTPUT_PATH"), `${JSON.stringify(result)}\n`);
}

if (process.argv[2] === "verify-first") {
  readVerifiedFirstResult();
} else if (process.argv[2] === "report") {
  await createCoverage();
} else {
  throw new TypeError("sandbox coverage commandが不正です");
}

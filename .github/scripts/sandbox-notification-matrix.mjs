import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import { readDurablePublicationRecoveryBootstrapV2 } from "../../dist/application/tracking-run/recovery-bootstrap.js";
import { verifyReceiptChain } from "../../dist/application/tracking-run/receipt-chain.js";
import { nodeContentDigestPort } from "../../dist/infrastructure/tracking-run/content-digest.js";
import { verifyRecoveryBundle } from "../../dist/infrastructure/tracking-run/publication-runtime-manifest.js";
import { decodeDurablePublicationRecord } from "../../dist/publication/durable-record-schema.js";
import {
  assertCompleteSandboxStageCoverage,
  assertPendingSandboxStageCoverage,
  assertSandboxStageReceiptLineage,
} from "../../dist/infrastructure/tracking-run/sandbox-stage-coverage.js";
import { parseSandboxEnvironmentManifest } from "../../dist/persistence/sandbox-environment-manifest.js";

import { resultSchema, sha256 } from "./sandbox-continuity-result.mjs";
import { verifyCacheProbeAdoption } from "./sandbox-reuse-witness.mjs";

const scenarioIds = [
  "send-clear-rejection",
  "hold",
  "acknowledge-current",
  "ambiguous-retry",
  "ambiguous-acknowledge",
];
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const workflowRunSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  status: z.literal("completed"),
  conclusion: z.string().min(1),
  event: z.literal("workflow_dispatch"),
  head_sha: revisionSchema,
  head_branch: z.string().min(1),
  display_title: z.string().min(1),
});
const priorSchema = z.strictObject({
  scenarioId: z.enum(scenarioIds.slice(0, 4)),
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  finalStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  coverageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

function required(name) {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function same(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readRevision(path) {
  return revisionSchema.parse(readFileSync(path, "utf8").trim());
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

function assertReadyScenario(scenario) {
  const { coverage, result, manifest, proofRoot } = scenario;
  const ready = parseSandboxEnvironmentManifest(
    readFileSync(join(proofRoot, "ready-environment.json"), "utf8"),
  );
  const creation = parseSandboxEnvironmentManifest(
    readFileSync(join(proofRoot, "creation-environment.json"), "utf8"),
  );
  if (
    ready.schemaVersion !== 2 ||
    ready.lifecycle.status !== "ready" ||
    creation.schemaVersion !== 2 ||
    creation.lifecycle.status !== "preparing"
  ) {
    throw new TypeError("通知matrixのscenario作成またはready manifestが不正です");
  }
  same(ready.environmentId, manifest.environmentId, "通知matrixのready環境");
  same(ready.seedRevision, manifest.seedRevision, "通知matrixのready seed");
  same(
    canonicalJson(ready.lifecycle.owner),
    canonicalJson(manifest.lifecycle.owner),
    "通知matrixのready owner",
  );
  same(
    canonicalJson(ready.lifecycle.creation),
    canonicalJson(manifest.lifecycle.creation),
    "通知matrixのready作成元",
  );
  same(
    ready.lifecycle.completion.finalStateRevision,
    result.finalStateRevision,
    "通知matrixのready親",
  );
  same(ready.lifecycle.completion.trackingRunId, result.trackingRunId, "通知matrixのready run");
  same(
    ready.lifecycle.completion.actionsRunId,
    result.actionsRunId,
    "通知matrixのready Actions run",
  );
  same(
    ready.lifecycle.completion.actionsRunAttempt,
    result.actionsRunAttempt,
    "通知matrixのready attempt",
  );
  same(
    ready.lifecycle.completion.resultDigest,
    sha256(readFileSync(join(proofRoot, "sandbox-result.json"))),
    "通知matrixのready result digest",
  );
  same(ready.lifecycle.completion.coverage.kind, "verified", "通知matrixのready coverage種別");
  same(
    ready.lifecycle.completion.coverage.digest,
    result.coverageDigest,
    "通知matrixのready coverage digest",
  );
  same(creation.environmentId, manifest.environmentId, "通知matrixの作成環境");
  same(creation.seedRevision, manifest.seedRevision, "通知matrixの作成seed");
  same(creation.sourceRepository, manifest.sourceRepository, "通知matrixの作成repository");
  same(creation.sourceRef, manifest.sourceRef, "通知matrixの作成source branch");
  same(
    creation.lifecycle.creation.sourceEnvironmentId,
    manifest.lifecycle.creation.sourceEnvironmentId,
    "通知matrixの作成reset元環境",
  );
  same(
    creation.lifecycle.creation.sourceHeadRevision,
    manifest.lifecycle.creation.sourceHeadRevision,
    "通知matrixの作成reset元HEAD",
  );
  same(
    creation.lifecycle.owner.actionsRunId,
    manifest.lifecycle.owner.actionsRunId,
    "通知matrixの作成owner run",
  );
  same(
    creation.lifecycle.owner.actionsRunAttempt,
    manifest.lifecycle.owner.actionsRunAttempt,
    "通知matrixの作成owner attempt",
  );
  same(
    coverage.run.originalBaseStateRevision,
    readRevision(join(proofRoot, "creation-revision.txt")),
    "通知matrixの物理seed子",
  );
  return readRevision(join(proofRoot, "ready-head-revision.txt"));
}

function assertContinuityRun(root, phase, result, coverage, run) {
  resultSchema.parse(result);
  assertCompleteSandboxStageCoverage(coverage);
  assertSandboxStageReceiptLineage(coverage, coverage.receiptChain.receiptDigests);
  same(result.continuityPhase, phase, "通知matrixの連続run段階");
  same(coverage.continuityPhase, phase, "通知matrixの連続coverage段階");
  same(
    sha256(readFileSync(join(root, `continuity-${phase}-coverage/sandbox-coverage.json`))),
    result.coverageDigest,
    "通知matrixの連続coverage digest",
  );
  same(coverage.run.actionsRunId, result.actionsRunId, "通知matrixの連続coverage Actions run");
  same(coverage.run.trackingRunId, result.trackingRunId, "通知matrixの連続coverage run");
  same(coverage.run.baseStateRevision, result.baseStateRevision, "通知matrixの連続coverage base");
  same(
    coverage.run.finalStateRevision,
    result.finalStateRevision,
    "通知matrixの連続coverage final",
  );
  same(
    coverage.stageLineage.finalReceiptChainDigest,
    result.receiptChainDigest,
    "通知matrixの連続coverage receipt chain",
  );
  const markerPath = join(root, `continuity-${phase}-marker.json`);
  const marker = readJson(markerPath);
  const record = decodeDurablePublicationRecord(
    readFileSync(join(root, `continuity-${phase}-record.json`)),
    nodeContentDigestPort,
  );
  const receiptPath = join(
    root,
    `continuity-${phase}-receipts`,
    result.trackingRunId.slice("tracker-run:".length),
    "receipt-chain.json",
  );
  const receiptBytes = readFileSync(receiptPath);
  const receipts = verifyReceiptChain(
    readJson(receiptPath).entries,
    nodeContentDigestPort,
  ).receipts;
  same(sha256(receiptBytes), result.receiptChainDigest, "通知matrixの連続receipt chain digest");
  same(
    canonicalJson(receipts.map((receipt) => receipt.receiptDigest)),
    canonicalJson(coverage.receiptChain.receiptDigests),
    "通知matrixの連続coverage receipt列",
  );
  same(sha256(readFileSync(markerPath)), result.markerDigest, "通知matrixの連続marker digest");
  same(record.recordDigest, result.publicationRecordDigest, "通知matrixの連続record digest");
  same(record.runIdentity.runId, result.trackingRunId, "通知matrixの連続record run");
  same(
    record.runtimeRecoveryPlan.workflowRunId,
    result.actionsRunId,
    "通知matrixの連続runtime元run",
  );
  same(
    record.runtimeRecoveryPlan.workflowRunAttempt,
    result.actionsRunAttempt,
    "通知matrixの連続runtime元attempt",
  );
  same(
    record.runtimeRecoveryPlan.codeRevision,
    result.codeRevision,
    "通知matrixの連続runtime code revision",
  );
  same(record.baseStateRevision.revision, result.baseStateRevision, "通知matrixの連続record base");
  same(marker.runId, result.trackingRunId, "通知matrixの連続marker run");
  same(marker.baseStateRevision, result.baseStateRevision, "通知matrixの連続marker base");
  same(marker.publicationRecordDigest, record.recordDigest, "通知matrixの連続marker record");
  same(marker.phase, "run_finalized", "通知matrixの連続marker段階");
  same(
    receipts.find((receipt) => receipt.receiptType === "run_finalization")?.result
      .resultingStateRevision,
    result.finalStateRevision,
    "通知matrixの連続finalization receipt",
  );
  same(
    receipts.find((receipt) => receipt.receiptType === "completion")?.result.finalStateRevision,
    result.finalStateRevision,
    "通知matrixの連続completion receipt",
  );
  same(run.id.toString(), result.actionsRunId, "通知matrixの連続Actions run ID");
  same(run.run_attempt, result.actionsRunAttempt, "通知matrixの連続Actions attempt");
  same(run.head_sha, result.codeRevision, "通知matrixの連続code revision");
  same(run.head_branch, required("GITHUB_REF_NAME"), "通知matrixの連続source branch");
  same(run.conclusion, "success", "通知matrixの連続Actions結果");
}

function assertContinuitySource(sourceManifest, proofRoot) {
  const firstReady = parseSandboxEnvironmentManifest(
    readFileSync(join(proofRoot, "continuity-first-ready-environment.json"), "utf8"),
  );
  const first = readJson(join(proofRoot, "continuity-first-result/sandbox-result.json"));
  const second = readJson(join(proofRoot, "continuity-second-result/sandbox-result.json"));
  const firstCoverage = readJson(
    join(proofRoot, "continuity-first-coverage/sandbox-coverage.json"),
  );
  const secondCoverage = readJson(
    join(proofRoot, "continuity-second-coverage/sandbox-coverage.json"),
  );
  const firstRun = workflowRunSchema.parse(readJson(join(proofRoot, "continuity-first-run.json")));
  const secondRun = workflowRunSchema.parse(
    readJson(join(proofRoot, "continuity-second-run.json")),
  );
  const creation = parseSandboxEnvironmentManifest(
    readFileSync(join(proofRoot, "continuity-creation-environment.json"), "utf8"),
  );
  const firstSnapshot = readJson(join(proofRoot, "continuity-first-snapshot.json"));
  const secondSnapshot = readJson(join(proofRoot, "continuity-second-snapshot.json"));
  if (
    sourceManifest.schemaVersion !== 2 ||
    sourceManifest.lifecycle.status !== "ready" ||
    firstReady.schemaVersion !== 2 ||
    firstReady.lifecycle.status !== "ready" ||
    creation.schemaVersion !== 2 ||
    creation.lifecycle.status !== "preparing" ||
    !["create", "reset"].includes(creation.lifecycle.creation.kind)
  ) {
    throw new TypeError("通知matrixの連続run環境が不正です");
  }
  assertContinuityRun(proofRoot, "first", first, firstCoverage, firstRun);
  assertContinuityRun(proofRoot, "second", second, secondCoverage, secondRun);
  same(first.environmentId, sourceManifest.environmentId, "通知matrixのfirst環境");
  same(second.environmentId, sourceManifest.environmentId, "通知matrixのsecond環境");
  same(first.codeRevision, second.codeRevision, "通知matrixの連続run code revision");
  same(creation.environmentId, sourceManifest.environmentId, "通知matrixの初回作成環境");
  same(creation.seedRevision, sourceManifest.seedRevision, "通知matrixの初回物理seed");
  same(
    canonicalJson(creation.lifecycle.owner),
    canonicalJson(sourceManifest.lifecycle.owner),
    "通知matrixの初回owner",
  );
  same(
    canonicalJson(creation.lifecycle.creation),
    canonicalJson(sourceManifest.lifecycle.creation),
    "通知matrixの初回作成元",
  );
  same(firstReady.seedRevision, sourceManifest.seedRevision, "通知matrixのR1 seed");
  same(firstReady.sourceRef, sourceManifest.sourceRef, "通知matrixのR1 source branch");
  same(
    canonicalJson(sourceManifest),
    canonicalJson(firstReady),
    "通知matrixのF2 manifestとR1 manifest",
  );
  same(
    second.finalStateRevision,
    readRevision(join(proofRoot, "source-head-revision.txt")),
    "通知matrixのF2 reset元HEAD",
  );
  same(firstSnapshot.run.id, first.trackingRunId, "通知matrixのF1 snapshot run");
  same(secondSnapshot.run.id, second.trackingRunId, "通知matrixのF2 snapshot run");
  same(
    secondCoverage.continuity?.firstSnapshotDigest,
    sha256(readFileSync(join(proofRoot, "continuity-first-snapshot.json"))),
    "通知matrixのF1 snapshot digest",
  );
  same(
    first.baseStateRevision,
    readRevision(join(proofRoot, "continuity-creation-revision.txt")),
    "通知matrixのfirst base",
  );
  same(
    second.baseStateRevision,
    readRevision(join(proofRoot, "continuity-first-ready-revision.txt")),
    "通知matrixのsecond ready base",
  );
  same(
    firstReady.lifecycle.completion.finalStateRevision,
    first.finalStateRevision,
    "通知matrixのF1とR1",
  );
  same(
    firstReady.lifecycle.completion.trackingRunId,
    first.trackingRunId,
    "通知matrixのR1 tracking run",
  );
  same(
    firstReady.lifecycle.completion.resultDigest,
    sha256(readFileSync(join(proofRoot, "continuity-first-result/sandbox-result.json"))),
    "通知matrixのfirst result digest",
  );
  same(firstReady.lifecycle.completion.coverage.kind, "verified", "通知matrixのfirst coverage種別");
  same(
    firstReady.lifecycle.completion.coverage.digest,
    first.coverageDigest,
    "通知matrixのfirst coverage digest",
  );
  same(sourceManifest.lifecycle.owner.actionsRunId, first.actionsRunId, "通知matrixのfirst owner");
  same(firstReady.lifecycle.owner.actionsRunId, first.actionsRunId, "通知matrixのR1 owner");
  same(
    firstReady.lifecycle.completion.actionsRunId,
    first.actionsRunId,
    "通知matrixのR1 completion",
  );
  same(
    firstReady.lifecycle.completion.actionsRunAttempt,
    first.actionsRunAttempt,
    "通知matrixのR1 completion attempt",
  );
  const firstSentKeyDigests = z
    .array(digestSchema)
    .min(1)
    .parse(firstCoverage.receiptChain.recordedSendKeyDigests);
  const secondSentKeyDigests = z
    .array(digestSchema)
    .parse(secondCoverage.receiptChain.recordedSendKeyDigests);
  const secondMessageSendCount = z
    .number()
    .int()
    .nonnegative()
    .parse(secondCoverage.notification.messageSendCount);
  const secondRecordedSendCount = z
    .number()
    .int()
    .nonnegative()
    .parse(secondCoverage.notification.recordedSendCount);
  const hasNewSentHistory = secondSentKeyDigests.length > 0;
  if (
    firstCoverage.analysis.genericAi.applications.executed < 1 ||
    firstCoverage.analysis.genericAi.processAttemptCount < 1 ||
    firstCoverage.notification.recordedSendCount < 1 ||
    secondCoverage.notification.sameKeySuppressionConsistent !== true ||
    secondMessageSendCount !== secondRecordedSendCount ||
    secondSentKeyDigests.length < secondRecordedSendCount ||
    new Set(secondSentKeyDigests).size !== secondSentKeyDigests.length ||
    secondSentKeyDigests.some((key) => firstSentKeyDigests.includes(key)) ||
    (hasNewSentHistory
      ? secondRecordedSendCount < 1 ||
        secondCoverage.pages.notificationHistory.buildStatus !== "built" ||
        secondCoverage.pages.notificationHistory.status !== "deployed" ||
        secondCoverage.pages.notificationHistory.externalReference?.kind !== "recording"
      : secondRecordedSendCount !== 0 ||
        secondCoverage.pages.notificationHistory.buildStatus !== "not_required" ||
        secondCoverage.pages.notificationHistory.status !== "not_required")
  ) {
    throw new TypeError("通知matrixの実AI採用、同一key抑止または履歴Pagesがありません");
  }
  same(
    secondRun.display_title,
    `sandbox-continue-${sourceManifest.environmentId}`,
    "通知matrixのsecond操作",
  );
  const firstTitle =
    creation.lifecycle.creation.kind === "create"
      ? `sandbox-create-${sourceManifest.environmentId}`
      : `sandbox-reset-${creation.lifecycle.creation.sourceEnvironmentId}`;
  same(firstRun.display_title, firstTitle, "通知matrixのfirst操作");
  same(
    JSON.stringify(secondCoverage.continuity?.firstResult),
    JSON.stringify(first),
    "通知matrixのsecond first参照",
  );
  if (
    !Array.isArray(secondCoverage.continuity?.snapshotReuses) ||
    secondCoverage.continuity.snapshotReuses.length < 1 ||
    secondCoverage.analysis.genericAi.applications.cache < 1 ||
    secondCoverage.analysis.genericAi.cacheHitCount < 1
  ) {
    throw new TypeError("通知matrixのsecondにsnapshot再利用とAI cache hitがありません");
  }
  const firstItems = new Map(firstSnapshot.items.map((item) => [item.nodeId, item]));
  const secondItems = new Map(secondSnapshot.items.map((item) => [item.nodeId, item]));
  const probe = secondCoverage.continuity?.cacheProbe;
  if (probe == null || !Array.isArray(probe.elements) || probe.elements.length < 1) {
    throw new TypeError("通知matrixのcache probe対象が不正です");
  }
  same(
    verifyCacheProbeAdoption(firstSnapshot.items, secondSnapshot.items, probe),
    probe.elements.length,
    "通知matrixの実file cache採用要素数",
  );
  const reuse = secondCoverage.continuity.snapshotReuseWitness;
  if (
    digestSchema.safeParse(secondCoverage.continuity.reusePlanProofDigest).success !== true ||
    reuse == null ||
    reuse.choice !== "snapshot_reuse" ||
    reuse.nodeId === probe.nodeId ||
    !secondCoverage.continuity.snapshotReuses.some(
      (entry) =>
        entry.nodeId === reuse.nodeId &&
        entry.element === reuse.element &&
        entry.inputFingerprint === reuse.inputFingerprint,
    )
  ) {
    throw new TypeError("通知matrixの別nodeに計画済みsnapshot再利用がありません");
  }
  for (const reuse of secondCoverage.continuity.snapshotReuses) {
    const firstItem = firstItems.get(reuse.nodeId);
    const secondItem = secondItems.get(reuse.nodeId);
    const firstAdopted = firstItem?.aiAnalysis.adoptedElements[reuse.element];
    const secondAdopted = secondItem?.aiAnalysis.adoptedElements[reuse.element];
    if (
      firstItem?.aiAnalysis.applications[reuse.element]?.origin !== "executed" ||
      secondItem?.aiAnalysis.applications[reuse.element]?.origin !== "verified_reuse" ||
      firstItem.aiAnalysis.elements[reuse.element] == null ||
      firstAdopted?.reuseProof.status !== "verified" ||
      secondAdopted?.reuseProof.status !== "verified" ||
      firstAdopted.generation.metadata.generatedAt !== firstSnapshot.generatedAt
    ) {
      throw new TypeError("通知matrixのsnapshot再利用対象が一致しません");
    }
    same(
      canonicalJson(firstAdopted.generation),
      canonicalJson(firstItem.aiAnalysis.elements[reuse.element].generation),
      "通知matrixの実AI採用生成値",
    );
    same(
      firstAdopted.reuseProof.inputFingerprint,
      reuse.inputFingerprint,
      "通知matrixの再利用入力fingerprint",
    );
    same(
      firstAdopted.generation.metadata.inputFingerprint,
      reuse.inputFingerprint,
      "通知matrixの初回生成入力fingerprint",
    );
    same(
      secondAdopted.generation.metadata.inputFingerprint,
      reuse.inputFingerprint,
      "通知matrixの再利用生成入力fingerprint",
    );
    same(
      canonicalJson(secondAdopted.reuseProof),
      canonicalJson(firstAdopted.reuseProof),
      "通知matrixの再利用proof",
    );
    same(
      canonicalJson(secondAdopted.generation),
      canonicalJson(firstAdopted.generation),
      "通知matrixの再利用generation",
    );
    same(
      canonicalJson(secondAdopted.result),
      canonicalJson(firstAdopted.result),
      "通知matrixの再利用result",
    );
  }
  const cacheApplications = secondSnapshot.items.flatMap((item) =>
    Object.values(item.aiAnalysis.applications).filter(
      (application) => application.status === "current_ai" && application.origin === "cache",
    ),
  ).length;
  same(
    secondCoverage.analysis.genericAi.applications.cache,
    cacheApplications,
    "通知matrixのAI cache採用件数",
  );
  const secondRecord = decodeDurablePublicationRecord(
    readFileSync(join(proofRoot, "continuity-second-record.json")),
    nodeContentDigestPort,
  );
  same(
    secondCoverage.analysis.genericAi.cacheHitCount,
    secondRecord.runFinalizationPolicy.report.metrics.aiCacheHitCount,
    "通知matrixのAI cache hit件数",
  );
}

/** 通知scenarioのcoverageと完了情報の結合を検証する。 */
export async function assertScenario(coverage, result, scenarioId, proofRoot, isCurrent) {
  assertCompleteSandboxStageCoverage(coverage);
  assertSandboxStageReceiptLineage(coverage, coverage.receiptChain.receiptDigests);
  same(coverage.schemaVersion, 2, "通知matrixのcoverage schema version");
  same(
    coverage.stageLineage.analysisStageRecordDigest,
    coverage.analysisStageRecordDigest,
    "通知matrixの解析段階記録digest",
  );
  same(
    coverage.stageLineage.finalReceiptChainDigest,
    result.receiptChainDigest,
    "通知matrixの段階receipt chain digest",
  );
  if (coverage.ambiguousInitial != null) {
    assertPendingSandboxStageCoverage(coverage.ambiguousInitial);
    same(
      coverage.ambiguousInitial.analysisStageRecordDigest,
      coverage.analysisStageRecordDigest,
      "通知matrixの再開元解析段階記録",
    );
    same(
      coverage.stageLineage.analysisSourceActionsRunId,
      coverage.ambiguousInitial.actionsRunId,
      "通知matrixの再開元Actions run ID",
    );
    same(
      coverage.stageLineage.pendingReceiptChainDigest,
      coverage.ambiguousInitial.initialReceiptChainDigest,
      "通知matrixの初回receipt chain digest",
    );
    same(
      coverage.ambiguousInitial.codeRevision,
      coverage.run.codeRevision,
      "通知matrixの再開元code revision",
    );
  } else if (scenarioId === "ambiguous-retry" || scenarioId === "ambiguous-acknowledge") {
    throw new TypeError("通知matrixにambiguous初回の停止証拠がありません");
  } else {
    same(
      coverage.stageLineage.analysisSourceActionsRunId,
      result.actionsRunId,
      "通知matrixの解析元Actions run ID",
    );
    same(coverage.stageLineage.pendingReceiptChainDigest, null, "通知matrixの初回chain参照");
  }
  same(coverage.scenarioId, scenarioId, "通知matrixのscenario ID");
  same(result.scenarioId, scenarioId, "通知matrixのresult scenario ID");
  const codeRevision = revisionSchema.parse(coverage.run.codeRevision);
  const source = workflowRunSchema.parse(readJson(join(proofRoot, "source-run.json")));
  const sourceRunId = coverage.stageLineage.analysisSourceActionsRunId;
  const sourceRunAttempt = coverage.ambiguousInitial?.actionsRunAttempt ?? result.actionsRunAttempt;
  const manifest = parseSandboxEnvironmentManifest(
    readFileSync(join(proofRoot, "sandbox-environment.json"), "utf8"),
  );
  const record = readDurablePublicationRecoveryBootstrapV2(
    readFileSync(join(proofRoot, "durable-publication-record-v1.json")),
    nodeContentDigestPort,
  );
  if (
    manifest.schemaVersion !== 2 ||
    manifest.lifecycle.status !== "preparing" ||
    manifest.lifecycle.creation.kind !== "reset" ||
    record.runtimeRecoveryPlan.kind !== "workflow_bundle"
  ) {
    throw new TypeError("通知matrixのmanifestまたはruntime回復計画が不正です");
  }
  same(manifest.environmentId, coverage.run.environmentId, "通知matrixのmanifest environment ID");
  same(manifest.sourceRef, required("GITHUB_REF_NAME"), "通知matrixのmanifest source branch");
  same(manifest.lifecycle.owner.actionsRunId, sourceRunId, "通知matrixのmanifest owner run ID");
  same(
    manifest.lifecycle.owner.actionsRunAttempt,
    sourceRunAttempt,
    "通知matrixのmanifest owner attempt",
  );
  same(manifest.lifecycle.owner.codeRevision, codeRevision, "通知matrixのmanifest code revision");
  same(record.runId, coverage.run.trackingRunId, "通知matrixの永続run ID");
  same(record.checkpointDigest, result.checkpointDigest, "通知matrixの永続checkpoint digest");
  same(
    record.checkpointFileDigest,
    result.checkpointFileDigest,
    "通知matrixの永続checkpoint file digest",
  );
  same(record.recordDigest, result.publicationRecordDigest, "通知matrixの永続record digest");
  same(record.runtimeRecoveryPlan.workflowRunId, sourceRunId, "通知matrixのruntime元run ID");
  same(
    record.runtimeRecoveryPlan.workflowRunAttempt,
    sourceRunAttempt,
    "通知matrixのruntime元attempt",
  );
  same(record.runtimeRecoveryPlan.codeRevision, codeRevision, "通知matrixのruntime code revision");
  await verifyRecoveryBundle(join(proofRoot, "runtime"), record.runtimeRecoveryPlan);
  same(source.id.toString(), sourceRunId, "通知matrixの解析元Actions run ID");
  same(source.run_attempt, sourceRunAttempt, "通知matrixの解析元Actions attempt");
  same(source.head_sha, codeRevision, "通知matrixの解析元code revision");
  same(source.head_branch, required("GITHUB_REF_NAME"), "通知matrixの解析元branch");
  same(
    source.display_title,
    `sandbox-reset-${manifest.lifecycle.creation.sourceEnvironmentId}`,
    "通知matrixの解析元reset run",
  );
  same(
    coverage.run.environmentId,
    `env-${sourceRunId}-${sourceRunAttempt}`,
    "通知matrixの解析元environment ID",
  );
  if (isCurrent) {
    same(result.actionsRunId, required("GITHUB_RUN_ID"), "通知matrixの最終Actions run ID");
    same(
      result.actionsRunAttempt,
      Number(required("GITHUB_RUN_ATTEMPT")),
      "通知matrixの最終Actions attempt",
    );
  } else {
    const completion = workflowRunSchema.parse(readJson(join(proofRoot, "completion-run.json")));
    same(completion.id.toString(), result.actionsRunId, "通知matrixの完了Actions run ID");
    same(completion.run_attempt, result.actionsRunAttempt, "通知matrixの完了Actions attempt");
    same(completion.conclusion, "success", "通知matrixの完了Actions run結果");
    same(completion.head_branch, required("GITHUB_REF_NAME"), "通知matrixの完了branch");
    if (coverage.ambiguousInitial == null) {
      same(completion.id, source.id, "通知matrixの初回と完了Actions run");
      same(completion.head_sha, codeRevision, "通知matrixの完了code revision");
    } else {
      same(
        completion.display_title,
        `sandbox-resume-preparing-${coverage.run.environmentId}`,
        "通知matrixの再開Actions run",
      );
    }
  }
  same(coverage.run.actionsRunId, result.actionsRunId, "通知matrixのActions run ID");
  same(coverage.run.actionsRunAttempt, result.actionsRunAttempt, "通知matrixのActions attempt");
  same(coverage.run.environmentId, result.environmentId, "通知matrixのenvironment ID");
  same(
    coverage.run.stateRef,
    `sandbox-state/${coverage.run.environmentId}`,
    "通知matrixのsandbox state branch",
  );
  same(
    coverage.run.invocationBaseStateRevision,
    result.baseStateRevision,
    "通知matrixのbase state revision",
  );
  same(coverage.run.trackingRunId, result.trackingRunId, "通知matrixのtracking run ID");
  same(coverage.run.finalStateRevision, result.finalStateRevision, "通知matrixのfinal revision");
  same(
    digestSchema.parse(coverage.checkpoint.checkpointDigest),
    result.checkpointDigest,
    "通知matrixのcheckpoint digest",
  );
  same(
    digestSchema.parse(coverage.checkpoint.checkpointFileDigest),
    result.checkpointFileDigest,
    "通知matrixのcheckpoint file digest",
  );
  same(
    digestSchema.parse(coverage.state.publicationRecordDigest),
    result.publicationRecordDigest,
    "通知matrixのrecord digest",
  );
  same(
    digestSchema.parse(coverage.receiptChain.digest),
    result.receiptChainDigest,
    "通知matrixのreceipt chain digest",
  );
  same(
    digestSchema.parse(coverage.state.markerDigest),
    result.markerDigest,
    "通知matrixのmarker digest",
  );
  z.array(revisionSchema).min(3).parse(coverage.state.stateCommitRevisions);
  if (
    coverage.notification.selectedCandidateCount === 0 ||
    coverage.productionAdapters.pagesDeployExecuted !== false ||
    coverage.productionAdapters.discordSendExecuted !== false ||
    result.productionPagesDeployed !== false ||
    result.productionDiscordSent !== false
  ) {
    throw new TypeError("通知matrixのstage、候補またはproduction隔離が不正です");
  }
  const branches = coverage.notification.branchCounts;
  switch (scenarioId) {
    case "send-clear-rejection":
      if (branches.recordedClearRejection < 1) {
        throw new TypeError("通知matrixにclear rejectionがありません");
      }
      break;
    case "hold":
      same(branches.hold, 1, "通知matrixのhold回数");
      break;
    case "acknowledge-current":
      same(branches.acknowledgeCurrent, 1, "通知matrixのacknowledge-current回数");
      break;
    case "ambiguous-retry":
      if (
        branches.recordedAmbiguous !== 1 ||
        branches.manualRetry !== 1 ||
        branches.recordedSuccess < 1 ||
        coverage.completedResolutionProof?.originalOperationReservationCommitCount !== 1
      ) {
        throw new TypeError("通知matrixにambiguous retryと成功結果がありません");
      }
      break;
    case "ambiguous-acknowledge":
      if (
        branches.recordedAmbiguous !== 1 ||
        branches.manualAcknowledge !== 1 ||
        coverage.completedResolutionProof?.originalOperationReservationCommitCount !== 1
      ) {
        throw new TypeError("通知matrixにambiguous acknowledgeがありません");
      }
      break;
    default:
      throw new TypeError("通知matrixのscenario IDが不正です");
  }
  return { manifest, runtimeBundleDigest: record.runtimeRecoveryPlan.bundleSha256 };
}

function assertScenarioSource(manifest, proofRoot, previous) {
  const creation = manifest.lifecycle.creation;
  const sourceRevision = readRevision(join(proofRoot, "source-head-revision.txt"));
  same(creation.sourceHeadRevision, sourceRevision, "通知matrixのreset元HEAD");
  const sourceManifest = parseSandboxEnvironmentManifest(
    readFileSync(join(proofRoot, "source-environment.json"), "utf8"),
  );
  if (sourceManifest.schemaVersion !== 2 || sourceManifest.lifecycle.status !== "ready") {
    throw new TypeError("通知matrixのreset元manifestがreadyではありません");
  }
  same(
    sourceManifest.environmentId,
    creation.sourceEnvironmentId,
    "通知matrixのreset元environment ID",
  );
  same(sourceManifest.seedRevision, manifest.seedRevision, "通知matrixのreset元seed revision");
  same(sourceManifest.sourceRef, manifest.sourceRef, "通知matrixのreset元source branch");
  same(sourceManifest.sourceRepository, manifest.sourceRepository, "通知matrixのreset元repository");
  if (previous == null) {
    assertContinuitySource(sourceManifest, proofRoot);
  } else {
    same(
      sourceRevision,
      readRevision(join(previous.proofRoot, "ready-head-revision.txt")),
      "通知matrixの先行ready HEAD",
    );
    same(sourceManifest.lifecycle.creation.kind, "reset", "通知matrixの先行reset");
    same(sourceManifest.environmentId, previous.manifest.environmentId, "通知matrixの先行環境");
    same(
      sourceManifest.seedRevision,
      previous.manifest.seedRevision,
      "通知matrixの先行seed revision",
    );
    same(
      sourceManifest.lifecycle.owner.actionsRunId,
      previous.manifest.lifecycle.owner.actionsRunId,
      "通知matrixの先行owner run ID",
    );
    same(
      sourceManifest.lifecycle.owner.actionsRunAttempt,
      previous.manifest.lifecycle.owner.actionsRunAttempt,
      "通知matrixの先行owner attempt",
    );
    same(
      sourceManifest.lifecycle.owner.codeRevision,
      previous.manifest.lifecycle.owner.codeRevision,
      "通知matrixの先行owner code revision",
    );
    same(
      sourceManifest.lifecycle.creation.sourceEnvironmentId,
      previous.manifest.lifecycle.creation.sourceEnvironmentId,
      "通知matrixの先行reset元環境",
    );
    same(
      sourceManifest.lifecycle.creation.sourceHeadRevision,
      previous.manifest.lifecycle.creation.sourceHeadRevision,
      "通知matrixの先行reset元HEAD",
    );
    same(
      sourceManifest.lifecycle.completion.finalStateRevision,
      previous.result.finalStateRevision,
      "通知matrixの先行final revision",
    );
    same(
      sourceManifest.lifecycle.completion.trackingRunId,
      previous.result.trackingRunId,
      "通知matrixの先行tracking run ID",
    );
    same(
      sourceManifest.lifecycle.completion.actionsRunId,
      previous.result.actionsRunId,
      "通知matrixの先行完了Actions run ID",
    );
    same(
      sourceManifest.lifecycle.completion.actionsRunAttempt,
      previous.result.actionsRunAttempt,
      "通知matrixの先行完了Actions attempt",
    );
    if (sourceManifest.lifecycle.completion.coverage.kind !== "verified") {
      throw new TypeError("通知matrixの先行ready manifestにcoverageがありません");
    }
    same(
      sourceManifest.lifecycle.completion.coverage.digest,
      previous.result.coverageDigest,
      "通知matrixの先行coverage digest",
    );
    same(
      sourceManifest.lifecycle.completion.resultDigest,
      sha256(readFileSync(join(previous.proofRoot, "sandbox-result.json"))),
      "通知matrixの先行result digest",
    );
  }
  return sourceManifest;
}

async function main() {
  const control = readJson(required("SANDBOX_CONTROL_PATH"));
  const prior = z.array(priorSchema).length(4).parse(control.notificationPrior);
  const priorRoot = required("SANDBOX_PRIOR_ROOT");
  const entries = [];
  for (const [index, reference] of prior.entries()) {
    same(reference.scenarioId, scenarioIds[index], "通知matrixのscenario順");
    const directory = join(priorRoot, reference.scenarioId);
    const coverageBytes = readFileSync(join(directory, "sandbox-coverage.json"));
    same(sha256(coverageBytes), reference.coverageDigest, "通知matrixの先行coverage digest");
    const coverage = JSON.parse(coverageBytes.toString("utf8"));
    const result = readJson(join(directory, "sandbox-result.json"));
    same(result.coverageDigest, reference.coverageDigest, "通知matrixの先行result digest");
    same(result.actionsRunId, reference.actionsRunId, "通知matrixの先行Actions run ID");
    same(result.actionsRunAttempt, reference.actionsRunAttempt, "通知matrixの先行Actions attempt");
    same(result.environmentId, reference.environmentId, "通知matrixの先行environment ID");
    same(result.finalStateRevision, reference.finalStateRevision, "通知matrixの先行final revision");
    const { manifest, runtimeBundleDigest } = await assertScenario(
      coverage,
      result,
      reference.scenarioId,
      directory,
      false,
    );
    entries.push({ coverage, result, manifest, runtimeBundleDigest });
  }
  const currentBytes = readFileSync(required("SANDBOX_CURRENT_COVERAGE_PATH"));
  const current = JSON.parse(currentBytes.toString("utf8"));
  const currentResult = readJson(required("SANDBOX_CURRENT_RESULT_PATH"));
  const { manifest: currentManifest, runtimeBundleDigest: currentRuntimeBundleDigest } =
    await assertScenario(
      current,
      currentResult,
      "ambiguous-acknowledge",
      required("SANDBOX_CURRENT_PROOF_ROOT"),
      true,
    );
  same(currentResult.coverageDigest, sha256(currentBytes), "通知matrixの最終coverage digest");
  same(currentResult.actionsRunId, required("GITHUB_RUN_ID"), "通知matrixの最終Actions run ID");
  const environmentIds = [...prior.map((entry) => entry.environmentId), current.run.environmentId];
  if (new Set(environmentIds).size !== 5) {
    throw new TypeError("通知matrixのsandbox branchがscenarioごとに分離されていません");
  }
  const scenarios = [
    ...entries.map(({ coverage, result, manifest, runtimeBundleDigest }) => ({
      coverage,
      result,
      manifest,
      runtimeBundleDigest,
      proofRoot: join(priorRoot, coverage.scenarioId),
    })),
    {
      coverage: current,
      result: currentResult,
      manifest: currentManifest,
      runtimeBundleDigest: currentRuntimeBundleDigest,
      proofRoot: required("SANDBOX_CURRENT_PROOF_ROOT"),
    },
  ];
  const origin = assertScenarioSource(scenarios[0].manifest, scenarios[0].proofRoot, null);
  for (const scenario of scenarios) {
    scenario.readyHeadRevision = assertReadyScenario(scenario);
  }
  for (const [index, scenario] of scenarios.slice(1).entries()) {
    assertScenarioSource(scenario.manifest, scenario.proofRoot, scenarios[index]);
    same(scenario.manifest.seedRevision, origin.seedRevision, "通知matrixの共通seed revision");
  }
  const coverages = scenarios.map(({ coverage }) => coverage);
  const branchCounts = {
    recordedSuccess: 0,
    recordedClearRejection: 0,
    recordedAmbiguous: 0,
    hold: 0,
    acknowledgeCurrent: 0,
    manualRetry: 0,
    manualAcknowledge: 0,
  };
  for (const coverage of coverages) {
    for (const branch of Object.keys(branchCounts)) {
      branchCounts[branch] += coverage.notification.branchCounts[branch];
    }
  }
  const matrix = {
    schemaVersion: 2,
    scenarioIds,
    seedRevision: origin.seedRevision,
    originEnvironmentId: origin.environmentId,
    results: scenarios.map(({ coverage, manifest, runtimeBundleDigest }) => ({
      scenarioId: coverage.scenarioId,
      sourceEnvironmentId: manifest.lifecycle.creation.sourceEnvironmentId,
      sourceHeadRevision: manifest.lifecycle.creation.sourceHeadRevision,
      actionsRunId: coverage.run.actionsRunId,
      actionsRunAttempt: coverage.run.actionsRunAttempt,
      environmentId: coverage.run.environmentId,
      stateRef: coverage.run.stateRef,
      trackingRunId: coverage.run.trackingRunId,
      codeRevision: coverage.run.codeRevision,
      runtimeBundleDigest,
      baseStateRevision: coverage.run.originalBaseStateRevision,
      finalStateRevision: coverage.run.finalStateRevision,
      selectedCandidateCount: coverage.notification.selectedCandidateCount,
      stages: coverage.stages,
      unexecutedStages: coverage.unexecutedStages,
      checkpoint: coverage.checkpoint,
      publicationRecordDigest: coverage.state.publicationRecordDigest,
      receiptChainDigest: coverage.receiptChain.digest,
      markerDigest: coverage.state.markerDigest,
      stateCommitRevisions: coverage.state.stateCommitRevisions,
      notificationHistoryPagesStatus: coverage.pages.notificationHistory.status,
      coverageDigest:
        coverage.scenarioId === "ambiguous-acknowledge"
          ? sha256(currentBytes)
          : prior.find((entry) => entry.scenarioId === coverage.scenarioId).coverageDigest,
      manualResolutionDecision: coverage.notification.manualResolutionDecision,
      originalDeliveryOperationId: coverage.notification.originalDeliveryOperationId,
      originalOperationReservationCommitCount:
        coverage.notification.originalOperationReservationCommitCount,
    })),
    branchCounts,
    productionAdapters: { pagesDeployExecuted: false, discordSendExecuted: false },
    allCanonicalStagesExecuted: coverages.every(
      (coverage) => coverage.unexecutedStages.length === 0,
    ),
    allSandboxBranchesIsolated: true,
  };
  writeFileSync(required("SANDBOX_MATRIX_OUTPUT_PATH"), `${JSON.stringify(matrix)}\n`);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import { readDurablePublicationRecoveryBootstrapV2 } from "../../dist/application/tracking-run/recovery-bootstrap.js";
import { nodeContentDigestPort } from "../../dist/infrastructure/tracking-run/content-digest.js";
import { verifyRecoveryBundle } from "../../dist/infrastructure/tracking-run/publication-runtime-manifest.js";
import {
  assertCompleteSandboxStageCoverage,
  assertPendingSandboxStageCoverage,
  assertSandboxStageReceiptLineage,
} from "../../dist/infrastructure/tracking-run/sandbox-stage-coverage.js";
import { parseSandboxEnvironmentManifest } from "../../dist/persistence/sandbox-environment-manifest.js";

import { sha256 } from "./sandbox-continuity-result.mjs";

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
  return record.runtimeRecoveryPlan.bundleSha256;
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
    const runtimeBundleDigest = await assertScenario(
      coverage,
      result,
      reference.scenarioId,
      directory,
      false,
    );
    entries.push({ reference, coverage, runtimeBundleDigest });
  }
  const currentBytes = readFileSync(required("SANDBOX_CURRENT_COVERAGE_PATH"));
  const current = JSON.parse(currentBytes.toString("utf8"));
  const currentResult = readJson(required("SANDBOX_CURRENT_RESULT_PATH"));
  const currentRuntimeBundleDigest = await assertScenario(
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
  const validated = [
    ...entries.map(({ coverage, runtimeBundleDigest }) => ({ coverage, runtimeBundleDigest })),
    { coverage: current, runtimeBundleDigest: currentRuntimeBundleDigest },
  ];
  const coverages = validated.map(({ coverage }) => coverage);
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
    results: validated.map(({ coverage, runtimeBundleDigest }) => ({
      scenarioId: coverage.scenarioId,
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

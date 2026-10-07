import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

import { z } from "zod";
import {
  assertCompleteSandboxStageCoverage,
  assertSandboxStageReceiptLineage,
} from "../../dist/infrastructure/tracking-run/sandbox-stage-coverage.js";

const revision = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runId = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);

/** continuity runの完了情報を検証するschema。 */
export const resultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  scenarioId: z.literal("continuity"),
  continuityPhase: z.enum(["first", "second"]),
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  codeRevision: revision,
  trackingRunId: runId,
  baseStateRevision: revision,
  finalStateRevision: revision,
  checkpointDigest: digest,
  checkpointFileDigest: digest,
  publicationRecordDigest: digest,
  receiptChainDigest: digest,
  markerDigest: digest,
  coverageDigest: digest,
  productionPagesDeployed: z.literal(false),
  productionDiscordSent: z.literal(false),
});

function required(name) {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new TypeError(`${name}が必要です`);
  }
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

/** artifact bytesのSHA-256を返す。 */
export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** firstの完了artifactとcoverageを入力と照合する。 */
export function readVerifiedFirstResult() {
  const result = resultSchema.parse(
    JSON.parse(readFileSync(required("SANDBOX_FIRST_RESULT_PATH"), "utf8")),
  );
  assertEqual(result.environmentId, required("SANDBOX_ENVIRONMENT_ID"), "first environment ID");
  assertEqual(result.continuityPhase, "first", "first continuity phase");
  assertEqual(result.actionsRunId, required("SANDBOX_FIRST_RUN_ID"), "first Actions run ID");
  assertEqual(
    result.actionsRunAttempt,
    Number(required("SANDBOX_FIRST_RUN_ATTEMPT")),
    "first Actions run attempt",
  );
  assertEqual(
    result.trackingRunId,
    required("SANDBOX_FIRST_TRACKING_RUN_ID"),
    "first tracking run ID",
  );
  assertEqual(
    result.finalStateRevision,
    required("SANDBOX_FIRST_FINAL_REVISION"),
    "first final revision",
  );
  assertEqual(result.codeRevision, required("SANDBOX_FIRST_CODE_REVISION"), "first code revision");
  assertEqual(result.codeRevision, required("GITHUB_SHA"), "firstとsecondのworkflow SHA");
  const coverageBytes = readFileSync(required("SANDBOX_FIRST_COVERAGE_PATH"));
  assertEqual(sha256(coverageBytes), result.coverageDigest, "first coverage digest");
  const coverage = JSON.parse(coverageBytes.toString("utf8"));
  assertCompleteSandboxStageCoverage(coverage);
  assertSandboxStageReceiptLineage(coverage, coverage.receiptChain.receiptDigests);
  assertEqual(coverage.schemaVersion, 2, "first coverage schema version");
  assertEqual(
    coverage.stageLineage.finalReceiptChainDigest,
    result.receiptChainDigest,
    "first stage chain",
  );
  assertEqual(
    coverage.stageLineage.analysisSourceActionsRunId,
    result.actionsRunId,
    "first解析元run",
  );
  assertEqual(
    coverage.stageLineage.analysisStageRecordDigest,
    coverage.analysisStageRecordDigest,
    "first解析段階記録digest",
  );
  assertEqual(coverage.run.trackingRunId, result.trackingRunId, "first coverage run ID");
  assertEqual(
    coverage.run.finalStateRevision,
    result.finalStateRevision,
    "first coverage final revision",
  );
  if (coverage.unexecutedStages.length !== 0 || coverage.notification.recordedSendCount < 1) {
    throw new TypeError("first coverageが完了したrecorded sendを示していません");
  }
  return result;
}

import { existsSync, readFileSync, statSync } from "node:fs";

import { parseDurablePublicationRecord } from "../../dist/publication/durable-record-schema.js";
import {
  decodePublicationArtifact,
  MAX_CHECKPOINT_FILE_BYTES,
  MAX_CHECKPOINT_MANIFEST_BYTES,
} from "../../dist/infrastructure/tracking-run/publication-checkpoint-codec.js";
import { nodeContentDigestPort } from "../../dist/infrastructure/tracking-run/content-digest.js";
import { nodeCheckpointCompressionPort } from "../../dist/infrastructure/tracking-run/publication-checkpoint-gzip.js";
import { trackingRunStageNames } from "../../dist/application/tracking-run/contracts/closed-values.js";
import { serializeCanonicalJson } from "../../dist/canonical-json/value.js";

function same(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`${label}が一致しません`);
  }
}

/** remote exact stateの実行記録を正本とし、残るcheckpoint artifactを照合する。 */
export function readSandboxCheckpointEvidence(recordValue, checkpointPath, sidecarPath) {
  const record = parseDurablePublicationRecord(recordValue, nodeContentDigestPort);
  if (record.schemaVersion === 2) {
    return { kind: "legacy_without_analysis_proof", record };
  }
  if (record.schemaVersion !== 3) {
    throw new TypeError("V1永続recordからsandbox coverageを作成できません");
  }
  const analysis = record.analysisStageRecord;
  const checkpointExists = existsSync(checkpointPath);
  const sidecarExists = existsSync(sidecarPath);
  if (checkpointExists !== sidecarExists) {
    throw new TypeError("checkpoint artifactとsidecarの片方だけがあります");
  }
  if (!checkpointExists) {
    return { kind: "remote_exact_state", record, analysis };
  }
  if (
    statSync(checkpointPath).size > MAX_CHECKPOINT_FILE_BYTES ||
    statSync(sidecarPath).size > MAX_CHECKPOINT_MANIFEST_BYTES
  ) {
    throw new TypeError("checkpoint artifactまたはsidecarがbyte上限を超えています");
  }
  const bytes = readFileSync(checkpointPath);
  const checkpoint = decodePublicationArtifact(
    bytes,
    readFileSync(sidecarPath),
    {
      runtimeIdentity: record.runtimeIdentity,
      expectedRunId: record.runIdentity.runId,
      baseStateRevision: record.baseStateRevision,
      configDigest: record.configDigest,
      artifactFileName: "validated-run.cpk",
    },
    nodeContentDigestPort,
    nodeCheckpointCompressionPort,
  );
  same(checkpoint.checkpointDigest, record.checkpointDigest, "永続record checkpoint digest");
  same(
    checkpoint.checkpointFileDigest,
    record.checkpointFileDigest,
    "永続record checkpoint file digest",
  );
  same(checkpoint.checkpoint.runIdentity.runId, analysis.runId, "解析記録 run ID");
  same(
    checkpoint.checkpoint.runIdentity.invocationId,
    analysis.invocationId,
    "解析記録 invocation ID",
  );
  same(
    serializeCanonicalJson(checkpoint.checkpoint.baseStateRevision),
    serializeCanonicalJson(analysis.baseStateRevision),
    "解析記録 parent revision",
  );
  same(
    serializeCanonicalJson(checkpoint.checkpoint.analysisCompletedStages),
    serializeCanonicalJson(analysis.completedStages),
    "解析段階の実行順序",
  );
  const metrics = checkpoint.validatedPayload.runMetadata.metrics;
  same(
    checkpoint.validatedPayload.validation.core.aiBudgetSummary.logicalCandidateCount,
    analysis.plannedLogicalCandidateCount,
    "解析候補数",
  );
  for (const key of [
    "itemCount",
    "changedItemCount",
    "aiProcessAttemptCount",
    "aiCacheHitCount",
    "aiRetainedResultCount",
    "personalReminderAiCallCount",
    "personalReminderAiCacheHitCount",
    "personalReminderAssessmentReuseCount",
    "personalReminderUnknownCount",
  ]) {
    same(metrics[key], record.runFinalizationPolicy.report.metrics[key], `解析件数 ${key}`);
  }
  return { kind: "artifact_cross_checked", record, analysis, byteLength: bytes.length };
}

/** 旧V2 runの解析段階が検証不能であることを公開reportへ示す。 */
export function unavailableLegacyStageCoverage(record, scenarioId) {
  return {
    schemaVersion: 2,
    scenarioId,
    analysisEvidenceStatus: "unavailable_legacy_v2",
    trackingRunId: record.runIdentity.runId,
    checkpointDigest: record.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    stages: trackingRunStageNames.map((stage) => ({ stage, executed: null, evidence: null })),
    unverifiedStages: [...trackingRunStageNames],
    productionAdapters: { pagesDeployExecuted: false, discordSendExecuted: false },
  };
}

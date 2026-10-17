import type { InitialStateWriteManifest } from "../../application/tracking-run/contracts/initial-state-write-manifest.js";
import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  durablePublicationRecordTemplateSchema,
  parseDurablePublicationRecord,
  type DurablePublicationRecord,
} from "../../publication/durable-record-schema.js";
import { createAnalysisStageRecord } from "../../publication/analysis-stage-record.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "./publication-checkpoint-binding.js";
/** 検証済みcheckpointの業務値とbindingから永続recordを作る。 */
export function materializeDurablePublicationRecord(
  bound: BoundPublicationCheckpoint,
  digest: ContentDigestPort,
  initialStateWriteManifest: InitialStateWriteManifest,
): DurablePublicationRecord {
  assertBoundPublicationCheckpoint(bound);
  const template = durablePublicationRecordTemplateSchema.parse(
    bound.publicationPlan.durableRecordTemplate,
  );
  if (
    serializeCanonicalJson(template) !==
      serializeCanonicalJson(bound.publicationPlan.initialStateWriteSet.durableRecordTemplate) ||
    serializeCanonicalJson(template.runIdentity) !==
      serializeCanonicalJson(bound.checkpoint.runIdentity) ||
    serializeCanonicalJson(template.executionPolicy) !==
      serializeCanonicalJson(bound.checkpoint.executionPolicy) ||
    serializeCanonicalJson(template.baseStateRevision) !==
      serializeCanonicalJson(bound.checkpoint.baseStateRevision) ||
    template.configDigest !== bound.checkpoint.configDigest ||
    digest.sha256Utf8(serializeCanonicalJson(initialStateWriteManifest)) !==
      template.initialStateValueDigests.initialStateWriteManifest ||
    bound.bindingProof.checkpointDigest !== bound.checkpointDigest ||
    bound.bindingProof.checkpointFileDigest !== bound.binding.checkpointFileDigest ||
    bound.bindingProof.runtimeIdentityDigest !==
      digest.sha256Utf8(serializeCanonicalJson(bound.runtimeIdentity)) ||
    bound.bindingProof.runtimeRecoveryPlanDigest !==
      digest.sha256Utf8(serializeCanonicalJson(bound.binding.runtimeRecoveryPlan))
  ) {
    throw new TypeError("checkpointと永続record templateの結合が一致しません");
  }
  const schemaVersion = template.executionPolicy.executionShape === "split_workflow" ? 3 : 1;
  if (bound.binding.runtimeRecoveryPlan.schemaVersion !== (schemaVersion === 3 ? 2 : 1)) {
    throw new TypeError("永続recordの版と回復計画の版が一致しません");
  }
  let analysisStageRecord: ReturnType<typeof createAnalysisStageRecord> | undefined;
  if (schemaVersion === 3) {
    const completedStages = bound.checkpoint.analysisCompletedStages;
    assertNonNullable(completedStages, "分割checkpointの解析段階記録がありません");
    analysisStageRecord = createAnalysisStageRecord({
      schemaVersion: 2,
      runId: bound.checkpoint.runIdentity.runId,
      invocationId: bound.checkpoint.runIdentity.invocationId,
      checkpointDigest: bound.checkpointDigest,
      checkpointFileDigest: bound.binding.checkpointFileDigest,
      baseStateRevision: bound.checkpoint.baseStateRevision,
      completedStages,
      plannedLogicalCandidateCount: bound.logicalCandidateCount,
    });
  }
  const payload = {
    recoveryBootstrapVersion: 1,
    schemaVersion,
    runIdentity: template.runIdentity,
    executionPolicy: template.executionPolicy,
    checkpointDigest: bound.checkpointDigest,
    checkpointFileDigest: bound.binding.checkpointFileDigest,
    runtimeIdentity: bound.runtimeIdentity,
    runtimeRecoveryPlan: bound.binding.runtimeRecoveryPlan,
    configDigest: template.configDigest,
    baseStateRevision: template.baseStateRevision,
    initialStateContentDigests: template.initialStateValueDigests,
    initialStateWriteManifest,
    initialPagesProjection: template.initialPagesProjection,
    notificationOutbox: template.notificationOutbox,
    runFinalizationPolicy: template.runFinalizationPolicy,
    notificationHistoryPagesPolicy: template.notificationHistoryPagesPolicy,
    ...(analysisStageRecord == null ? {} : { analysisStageRecord }),
  };
  return parseDurablePublicationRecord(
    { ...payload, recordDigest: digest.sha256Utf8(serializeCanonicalJson(payload)) },
    digest,
  );
}

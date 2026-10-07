import { z } from "zod";

import {
  baseStateRevisionSchema,
  type BaseStateRevision,
} from "../../application/tracking-run/contracts/run-core.js";
import type { RuntimeIdentity } from "../../application/tracking-run/contracts/runtime-identity.js";
import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import { runtimeRecoveryPlanSchema } from "../../application/tracking-run/recovery-bootstrap.js";
import {
  assertHistoricalAiWitnessMatchesBaseSnapshot,
  assertHistoricalEvidenceWitnessMatchesBaseSnapshot,
} from "../../application/tracking-run/stages/run-validation-artifact-witness.js";
import { assertRetainedItemAiAnalysisMatchesBase } from "../../application/tracking-run/stages/run-validation-ai-lineage.js";
import { assertPreviousPendingCausesMatchBase } from "../../application/tracking-run/stages/run-validation-previous-ledger-history.js";
import { assertValidatedRun } from "../../application/tracking-run/stages/validate-run.js";
import { parseSha256Hash, type Sha256Hash } from "../../canonical-json/sha256.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { createStateHistoryRecord } from "../../persistence/history.js";
import { validatedRunPayloadRepositoryInventory } from "./validated-run-payload.js";
import type { StateNotificationLedger } from "../../persistence/state-documents.js";
import type { StateSnapshotReadResult } from "../../persistence/state-persistence-session.js";
import {
  assertDecodedPublicationArtifact,
  type DecodedPublicationArtifact,
} from "./publication-checkpoint-codec.js";

const checkpointBindingProofBrand: unique symbol = Symbol("checkpointBindingProof");
const issuedBindings = new WeakSet<object>();
const sha256Schema = z.string().transform(parseSha256Hash);

export const checkpointBindingMetadataSchema = z.strictObject({
  checkpointFileDigest: sha256Schema,
  runtimeRecoveryPlan: runtimeRecoveryPlanSchema,
});

/** checkpointのtransportと回復計画だけを追加する結合情報。 */
export type CheckpointBindingMetadata = z.output<typeof checkpointBindingMetadataSchema>;

/** binderだけが発行するcheckpoint結合証明。 */
export type CheckpointBindingProof = Readonly<{
  checkpointDigest: Sha256Hash;
  checkpointFileDigest: Sha256Hash;
  runtimeIdentityDigest: Sha256Hash;
  runtimeRecoveryPlanDigest: Sha256Hash;
  readonly [checkpointBindingProofBrand]: true;
}>;

/** 後続のstate commitへ渡す単一の検証済み入力。 */
export type BoundPublicationCheckpoint = Readonly<{
  checkpoint: DecodedPublicationArtifact["checkpoint"];
  repositoryInventory: DecodedPublicationArtifact["validatedPayload"]["repositoryInventory"];
  logicalCandidateCount: number;
  publicationInputs: DecodedPublicationArtifact["validated"]["publicationInputs"];
  publicationPlan: DecodedPublicationArtifact["publicationPlan"];
  runtimeIdentity: RuntimeIdentity;
  checkpointDigest: Sha256Hash;
  binding: CheckpointBindingMetadata;
  bindingProof: CheckpointBindingProof;
}>;

/** exact base treeから読んだ前回snapshotと通知管理記録。 */
export type CheckpointBaseWitness = Readonly<{
  revision: BaseStateRevision;
  previousSnapshot: StateSnapshotReadResult;
  previousNotificationLedger: StateNotificationLedger;
}>;

function assertRecoveryPlanMatchesRuntime(
  runtime: RuntimeIdentity,
  plan: CheckpointBindingMetadata["runtimeRecoveryPlan"],
  digest: ContentDigestPort,
): void {
  if (plan.kind === "workflow_bundle") {
    if (
      runtime.kind !== "workflow_bundle" ||
      plan.codeRevision !== runtime.codeRevision ||
      plan.bundleSha256 !== runtime.bundleSha256 ||
      plan.lockfileSha256 !== runtime.lockfileSha256 ||
      serializeCanonicalJson(plan.toolchain) !== serializeCanonicalJson(runtime.toolchain)
    ) {
      throw new TypeError("workflow bundleの回復計画がruntime identityと一致しません");
    }
    return;
  }
  if (plan.kind === "rebuild_exact") {
    if (
      runtime.kind !== "source_process" ||
      plan.codeRevision !== runtime.codeRevision ||
      plan.expectedRuntimeManifestSha256 !== runtime.runtimeManifestSha256 ||
      plan.lockfileSha256 !== runtime.lockfileSha256 ||
      serializeCanonicalJson(plan.toolchain) !== serializeCanonicalJson(runtime.toolchain)
    ) {
      throw new TypeError("source processの回復計画がruntime identityと一致しません");
    }
    return;
  }
  if (plan.runtimeIdentityDigest !== digest.sha256Utf8(serializeCanonicalJson(runtime))) {
    throw new TypeError("回復不能計画のruntime identity digestが一致しません");
  }
}

/** artifact、sidecar、exact base、前回AI、回復計画を結合する。 */
export function bindPublicationCheckpoint(
  decoded: DecodedPublicationArtifact,
  metadataValue: unknown,
  baseWitness: CheckpointBaseWitness,
  digest: ContentDigestPort,
): BoundPublicationCheckpoint {
  assertDecodedPublicationArtifact(decoded);
  const metadata = checkpointBindingMetadataSchema.parse(metadataValue);
  const revision = baseStateRevisionSchema.parse(baseWitness.revision);
  if (
    decoded.checkpointFileDigest !== metadata.checkpointFileDigest ||
    serializeCanonicalJson(decoded.checkpoint.baseStateRevision) !==
      serializeCanonicalJson(revision)
  ) {
    throw new TypeError("checkpointとsidecarまたはexact base revisionが一致しません");
  }
  if (
    (revision.status === "missing") !==
    (baseWitness.previousSnapshot.status === "missing_branch")
  ) {
    throw new TypeError("exact base revisionと前回snapshotの有無が一致しません");
  }
  const snapshot =
    baseWitness.previousSnapshot.status === "available"
      ? baseWitness.previousSnapshot.snapshot
      : undefined;
  const writeSet = decoded.publicationPlan.initialStateWriteSet;
  const expectedHistoryRecord = createStateHistoryRecord(
    snapshot,
    writeSet.snapshot,
    writeSet.snapshot.generatedAt.slice(0, 10),
    validatedRunPayloadRepositoryInventory(decoded.validatedPayload),
    writeSet.historyInputEvents,
  );
  if (
    digest.sha256Utf8(serializeCanonicalJson(expectedHistoryRecord)) !==
    writeSet.paths.initialStateWriteManifest.history.recordDigest
  ) {
    throw new TypeError("初回履歴の期待値がexact baseとcheckpointの業務値に一致しません");
  }
  assertHistoricalAiWitnessMatchesBaseSnapshot(
    decoded.validated.evidenceClosureWitness,
    snapshot == null
      ? undefined
      : {
          trackedItems: snapshot.items,
          collectionRepositories: snapshot.collection.repositories,
        },
  );
  assertRetainedItemAiAnalysisMatchesBase(
    decoded.validated.snapshot,
    decoded.validated.finalItemAiLineage,
    snapshot,
  );
  assertHistoricalEvidenceWitnessMatchesBaseSnapshot(
    decoded.validated.evidenceClosureWitness,
    snapshot == null ? undefined : { items: snapshot.items, relations: snapshot.relations },
  );
  assertPreviousPendingCausesMatchBase(
    decoded.validated.evidenceClosureWitness.previousPendingCauses,
    decoded.validated.previousNotificationLedger,
    baseWitness.previousNotificationLedger,
    snapshot == null ? undefined : { items: snapshot.items, relations: snapshot.relations },
  );
  assertRecoveryPlanMatchesRuntime(decoded.runtimeIdentity, metadata.runtimeRecoveryPlan, digest);
  if (
    metadata.runtimeRecoveryPlan.kind === "not_reproducible" &&
    decoded.checkpoint.executionPolicy.effectTarget !== "recording"
  ) {
    throw new TypeError("永続効果のあるrunに回復不能なruntimeは使えません");
  }
  const proof = Object.freeze<CheckpointBindingProof>({
    checkpointDigest: decoded.checkpointDigest,
    checkpointFileDigest: decoded.checkpointFileDigest,
    runtimeIdentityDigest: digest.sha256Utf8(serializeCanonicalJson(decoded.runtimeIdentity)),
    runtimeRecoveryPlanDigest: digest.sha256Utf8(
      serializeCanonicalJson(metadata.runtimeRecoveryPlan),
    ),
    [checkpointBindingProofBrand]: true,
  });
  assertValidatedRun(decoded.validated);
  const bound = Object.freeze({
    checkpoint: decoded.checkpoint,
    repositoryInventory: validatedRunPayloadRepositoryInventory(decoded.validatedPayload),
    publicationInputs: decoded.validated.publicationInputs,
    logicalCandidateCount:
      decoded.validatedPayload.validation.core.aiBudgetSummary.logicalCandidateCount,
    publicationPlan: decoded.publicationPlan,
    runtimeIdentity: decoded.runtimeIdentity,
    checkpointDigest: decoded.checkpointDigest,
    binding: metadata,
    bindingProof: proof,
  });
  issuedBindings.add(bound);
  return bound;
}

/** 後続stageへ偽造されたcheckpointを渡さない。 */
export function assertBoundPublicationCheckpoint(value: BoundPublicationCheckpoint): void {
  if (!issuedBindings.has(value)) {
    throw new TypeError("checkpointがbinderで検証されていません");
  }
}

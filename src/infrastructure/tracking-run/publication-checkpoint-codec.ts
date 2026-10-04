import type { AnalysisRunStageName } from "../../application/tracking-run/contracts/closed-values.js";
import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import type { RuntimeIdentity } from "../../application/tracking-run/contracts/runtime-identity.js";
import type { Sha256Hash } from "../../canonical-json/sha256.js";
import {
  canonicalJsonEquals,
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "../../canonical-json/value.js";
import { planPublication } from "../../publication/plan-publication.js";
import type {
  PublicationPlan,
  PublicationPlannedRun,
} from "../../publication/publication-plan-contracts.js";
import {
  publicationArtifactSchema,
  publicationArtifactSidecarSchema,
  publicationCheckpointSchema,
  publicationPlanPayloadSchema,
  type PublicationArtifact,
  type PublicationArtifactSidecar,
  type PublicationCheckpoint,
} from "./publication-checkpoint-schema.js";
import {
  createCheckpointFrameEncoder,
  decodeCheckpointFrames,
  MAX_CHECKPOINT_FRAME_BYTES,
  MAX_CHECKPOINT_TOTAL_UNCOMPRESSED_BYTES,
  type CheckpointCompressionPort,
} from "./publication-checkpoint-frames.js";
import {
  parseValidatedRunPayload,
  validatedRunSerializablePayload,
  type ValidatedRunPayload,
} from "./validated-run-payload.js";

export const MAX_CHECKPOINT_MANIFEST_BYTES = 1024 * 1024;
export const MAX_CHECKPOINT_FILE_BYTES = 128 * 1024 * 1024;
const CHECKPOINT_MAGIC = new TextEncoder().encode("VVCPK23\n");
const HEADER_BYTE_LENGTH = CHECKPOINT_MAGIC.length + 4;
const issuedArtifacts = new WeakSet<object>();

/** 保存前のv23 checkpoint入力。 */
export type EncodePublicationCheckpointInput = Readonly<{
  planned: PublicationPlannedRun;
  validatedPayload: ValidatedRunPayload;
  runtimeIdentity: RuntimeIdentity;
  artifactFileName: string;
  analysisCompletedStages?: readonly AnalysisRunStageName[];
}>;

/** sidecarとruntimeを照合して復元したartifact。 */
export type DecodedPublicationArtifact = Readonly<{
  checkpoint: PublicationCheckpoint;
  validatedPayload: ValidatedRunPayload;
  validated: ValidatedRunPayload["validated"];
  publicationPlan: PublicationPlan;
  runtimeIdentity: RuntimeIdentity;
  checkpointDigest: Sha256Hash;
  checkpointFileDigest: Sha256Hash;
  artifactFileName: string;
}>;

/** 保存先へ渡すartifactとsidecar bytes。 */
export type EncodedPublicationCheckpoint = Readonly<{
  artifactBytes: Uint8Array;
  sidecarBytes: Uint8Array;
}>;

/** 外部から期待するrun、base、設定、runtimeの識別。 */
export type ExpectedPublicationCheckpoint = Readonly<{
  runtimeIdentity: RuntimeIdentity;
  expectedRunId: string;
  baseStateRevision: BaseStateRevision;
  configDigest: Sha256Hash;
  artifactFileName: string;
}>;

function parseCanonicalLine(bytes: Uint8Array, label: string): unknown {
  if (bytes.length > MAX_CHECKPOINT_MANIFEST_BYTES) {
    throw new TypeError(`${label}が許容するbyte数を超えています`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(value)) {
    throw new TypeError(`${label}がcanonical JSONではありません`);
  }
  return value;
}

function assertSameValue(actual: unknown, expected: unknown, label: string): void {
  if (!canonicalJsonEquals(actual, expected)) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function checkpointStoredPlan(plan: PublicationPlan): PublicationCheckpoint["publicationPlan"] {
  return publicationPlanPayloadSchema.parse({
    ...plan,
    initialStateWriteSet: {
      ...plan.initialStateWriteSet,
      snapshot: {
        kind: "validated_snapshot",
        digest: plan.initialStateWriteSet.valueDigests.snapshot,
      },
    },
  });
}

function parsePublicationCheckpoint(
  value: unknown,
  digest: ContentDigestPort,
): Readonly<{
  checkpoint: PublicationCheckpoint;
  validatedPayload: ValidatedRunPayload;
  validated: ValidatedRunPayload["validated"];
  publicationPlan: PublicationPlan;
}> {
  const checkpoint = publicationCheckpointSchema.parse(value);
  const validatedPayload = parseValidatedRunPayload(checkpoint.validatedPayload, digest);
  const validated = validatedPayload.validated;
  assertSameValue(checkpoint.runIdentity, validated.core.identity, "checkpointのrun identity");
  assertSameValue(
    checkpoint.executionPolicy,
    validated.core.executionPolicy,
    "checkpointの実行policy",
  );
  assertSameValue(
    checkpoint.baseStateRevision,
    validated.core.baseRevision,
    "checkpointのbase revision",
  );
  assertSameValue(checkpoint.configDigest, validated.core.configDigest, "checkpointの設定digest");
  const publicationPlan = planPublication(validated, digest).publicationPlan;
  assertSameValue(checkpoint.publicationPlan, checkpointStoredPlan(publicationPlan), "公開計画");
  if (publicationPlan.initialStateWriteSet.snapshot !== validated.snapshot) {
    throw new TypeError("checkpointのsnapshot参照が検証済みsnapshotと一致しません");
  }
  return Object.freeze({ checkpoint, validatedPayload, validated, publicationPlan });
}

/** v23 .cpkのcanonical manifestとframe境界を読む。 */
export function readPublicationArtifactManifest(artifactBytes: Uint8Array): Readonly<{
  artifact: PublicationArtifact;
  frameOffset: number;
}> {
  if (
    artifactBytes.length > MAX_CHECKPOINT_FILE_BYTES ||
    artifactBytes.length < HEADER_BYTE_LENGTH
  ) {
    throw new TypeError("checkpoint artifactのbyte数が不正です");
  }
  if (!CHECKPOINT_MAGIC.every((byte, index) => artifactBytes[index] === byte)) {
    throw new TypeError("checkpoint artifactのversionがv23ではありません");
  }
  const header = new DataView(artifactBytes.buffer, artifactBytes.byteOffset, HEADER_BYTE_LENGTH);
  const manifestByteLength = header.getUint32(CHECKPOINT_MAGIC.length, false);
  if (manifestByteLength === 0 || manifestByteLength > MAX_CHECKPOINT_MANIFEST_BYTES) {
    throw new TypeError("checkpoint manifestのbyte数が上限外です");
  }
  const frameOffset = HEADER_BYTE_LENGTH + manifestByteLength;
  if (frameOffset > artifactBytes.length)
    throw new TypeError("checkpoint manifestが途中で終わっています");
  const artifact = publicationArtifactSchema.parse(
    parseCanonicalLine(
      artifactBytes.subarray(HEADER_BYTE_LENGTH, frameOffset),
      "checkpoint manifest",
    ),
  );
  if (artifact.logical.frames.length !== artifact.compressedByteLengths.length) {
    throw new TypeError("checkpointのframe件数がmanifestと一致しません");
  }
  let totalUncompressedBytes = 0;
  let totalCompressedBytes = 0;
  for (const [index, frame] of artifact.logical.frames.entries()) {
    if (frame.index !== index || frame.uncompressedByteLength > MAX_CHECKPOINT_FRAME_BYTES) {
      throw new TypeError("checkpoint frameの順序またはbyte数が不正です");
    }
    totalUncompressedBytes += frame.uncompressedByteLength;
    totalCompressedBytes += artifact.compressedByteLengths[index] ?? 0;
  }
  if (
    artifact.logical.frames.length > 1024 ||
    totalUncompressedBytes > MAX_CHECKPOINT_TOTAL_UNCOMPRESSED_BYTES ||
    frameOffset + totalCompressedBytes !== artifactBytes.length
  ) {
    throw new TypeError("checkpoint frameの総byte数または余剰byteが不正です");
  }
  return { artifact, frameOffset };
}

function frameBytes(
  artifactBytes: Uint8Array,
  frameOffset: number,
  lengths: readonly number[],
): readonly Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = frameOffset;
  for (const length of lengths) {
    frames.push(artifactBytes.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

/** v23 checkpointとsidecarを同じcodecから生成する。 */
export function encodePublicationCheckpoint(
  input: EncodePublicationCheckpointInput,
  digest: ContentDigestPort,
  compression: CheckpointCompressionPort,
): EncodedPublicationCheckpoint {
  assertSameValue(
    input.validatedPayload.validated.core,
    input.planned.validated.core,
    "公開計画のrun",
  );
  const validated = input.validatedPayload.validated;
  const publicationPlan = planPublication(validated, digest).publicationPlan;
  assertSameValue(
    checkpointStoredPlan(input.planned.publicationPlan),
    checkpointStoredPlan(publicationPlan),
    "公開計画",
  );
  const storedPlan = checkpointStoredPlan(publicationPlan);
  const validatedPayloadValue = validatedRunSerializablePayload(input.validatedPayload);
  const encoder = createCheckpointFrameEncoder(digest, compression);
  const validatedPayloadNode = encoder.encode(validatedPayloadValue);
  const publicationPlanNode = encoder.encode(storedPlan);
  const logical = {
    schemaVersion: 23,
    kind: "publication_planned_tracking_run",
    runtimeIdentity: input.runtimeIdentity,
    runIdentity: validated.core.identity,
    executionPolicy: validated.core.executionPolicy,
    baseStateRevision: validated.core.baseRevision,
    configDigest: validated.core.configDigest,
    ...(input.analysisCompletedStages == null
      ? {}
      : { analysisCompletedStages: input.analysisCompletedStages }),
    validatedPayload: validatedPayloadNode,
    publicationPlan: publicationPlanNode,
    frames: encoder.frames,
  };
  const checkpointDigest = digest.sha256Utf8(serializeCanonicalJson(logical));
  const artifact = publicationArtifactSchema.parse({
    logical,
    checkpointDigest,
    compressedByteLengths: encoder.compressedFrames.map((frame) => frame.length),
  });
  const manifestBytes = new TextEncoder().encode(serializeCanonicalJsonLine(artifact));
  if (manifestBytes.length > MAX_CHECKPOINT_MANIFEST_BYTES) {
    throw new TypeError("checkpoint manifestが上限を超えています");
  }
  const totalBytes =
    HEADER_BYTE_LENGTH +
    manifestBytes.length +
    encoder.compressedFrames.reduce((sum, frame) => sum + frame.length, 0);
  if (totalBytes > MAX_CHECKPOINT_FILE_BYTES) {
    throw new TypeError("checkpoint artifactが圧縮file上限を超えています");
  }
  const artifactBytes = new Uint8Array(totalBytes);
  artifactBytes.set(CHECKPOINT_MAGIC);
  new DataView(artifactBytes.buffer).setUint32(
    CHECKPOINT_MAGIC.length,
    manifestBytes.length,
    false,
  );
  artifactBytes.set(manifestBytes, HEADER_BYTE_LENGTH);
  let offset = HEADER_BYTE_LENGTH + manifestBytes.length;
  for (const frame of encoder.compressedFrames) {
    artifactBytes.set(frame, offset);
    offset += frame.length;
  }
  const sidecar = publicationArtifactSidecarSchema.parse({
    artifactFileName: input.artifactFileName,
    byteLength: artifactBytes.length,
    checkpointFileDigest: digest.sha256Bytes(artifactBytes),
  });
  const sidecarBytes = new TextEncoder().encode(serializeCanonicalJsonLine(sidecar));
  return Object.freeze({ artifactBytes, sidecarBytes });
}

/** sidecar、二重digest、識別、canonical frameと参照閉包を検証する。 */
export function decodePublicationArtifact(
  artifactBytes: Uint8Array,
  sidecarBytes: Uint8Array,
  expected: ExpectedPublicationCheckpoint,
  digest: ContentDigestPort,
  compression: CheckpointCompressionPort,
): DecodedPublicationArtifact {
  const sidecar: PublicationArtifactSidecar = publicationArtifactSidecarSchema.parse(
    parseCanonicalLine(sidecarBytes, "checkpoint sidecar"),
  );
  if (
    sidecar.artifactFileName !== expected.artifactFileName ||
    sidecar.byteLength !== artifactBytes.length ||
    sidecar.checkpointFileDigest !== digest.sha256Bytes(artifactBytes)
  ) {
    throw new TypeError("checkpoint sidecarとartifact bytesが一致しません");
  }
  const { artifact, frameOffset } = readPublicationArtifactManifest(artifactBytes);
  const logical = artifact.logical;
  if (artifact.checkpointDigest !== digest.sha256Utf8(serializeCanonicalJson(logical))) {
    throw new TypeError("checkpoint digestが論理manifestと一致しません");
  }
  assertSameValue(
    logical.runtimeIdentity,
    expected.runtimeIdentity,
    "checkpointのruntime identity",
  );
  if (logical.runIdentity.runId !== expected.expectedRunId) {
    throw new TypeError("checkpointのrun IDが期待値と一致しません");
  }
  assertSameValue(
    logical.baseStateRevision,
    expected.baseStateRevision,
    "checkpointのbase revision",
  );
  assertSameValue(logical.configDigest, expected.configDigest, "checkpointの設定digest");
  const [validatedPayloadValue, publicationPlanValue] = decodeCheckpointFrames(
    [logical.validatedPayload, logical.publicationPlan],
    logical.frames,
    frameBytes(artifactBytes, frameOffset, artifact.compressedByteLengths),
    digest,
    compression,
  );
  const parsed = parsePublicationCheckpoint(
    {
      runIdentity: logical.runIdentity,
      executionPolicy: logical.executionPolicy,
      baseStateRevision: logical.baseStateRevision,
      configDigest: logical.configDigest,
      ...(logical.analysisCompletedStages == null
        ? {}
        : { analysisCompletedStages: logical.analysisCompletedStages }),
      validatedPayload: validatedPayloadValue,
      publicationPlan: publicationPlanValue,
    },
    digest,
  );
  const decoded = Object.freeze({
    checkpoint: parsed.checkpoint,
    validatedPayload: parsed.validatedPayload,
    validated: parsed.validated,
    publicationPlan: parsed.publicationPlan,
    runtimeIdentity: logical.runtimeIdentity,
    checkpointDigest: artifact.checkpointDigest,
    checkpointFileDigest: sidecar.checkpointFileDigest,
    artifactFileName: sidecar.artifactFileName,
  });
  issuedArtifacts.add(decoded);
  return decoded;
}

/** binderへ渡せる復元済みartifactだけを許可する。 */
export function assertDecodedPublicationArtifact(value: DecodedPublicationArtifact): void {
  if (!issuedArtifacts.has(value)) {
    throw new TypeError("checkpoint artifactがcodecで検証されていません");
  }
}

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import type { RunExecutionPolicy, RunIdentity } from "../../application/tracking-run/request.js";
import type { Sha256Hash } from "../../canonical-json/sha256.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { CliWorkflowArtifactError } from "./errors.js";
import {
  bindPublicationCheckpoint,
  type BoundPublicationCheckpoint,
  type CheckpointBaseWitness,
} from "./publication-checkpoint-binding.js";
import {
  decodePublicationArtifact,
  MAX_CHECKPOINT_FILE_BYTES,
  MAX_CHECKPOINT_MANIFEST_BYTES,
  readPublicationArtifactManifest,
  type EncodedPublicationCheckpoint,
} from "./publication-checkpoint-codec.js";
import { nodeCheckpointCompressionPort } from "./publication-checkpoint-gzip.js";
import type { PublicationRuntimeContext } from "./publication-runtime.js";

/** 読込前の効果境界で照合する外部識別。 */
export type PublicationCheckpointFileExpectation = Readonly<{
  expectedRunId: string;
  baseStateRevision: BaseStateRevision;
  configDigest: Sha256Hash;
  runtime: PublicationRuntimeContext;
  baseWitness: CheckpointBaseWitness;
}>;

/** sidecarの固定path。 */
export function publicationCheckpointSidecarPath(path: string): string {
  return `${path}.sidecar.json`;
}

function artifactFileError(path: string, error: unknown): CliWorkflowArtifactError {
  const missing =
    typeof error === "object" && error != null && "code" in error && error.code === "ENOENT";
  return new CliWorkflowArtifactError(path, missing ? "missing" : "invalid", { cause: error });
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  const file = await stat(path);
  if (file.size > maxBytes) throw new TypeError("checkpoint fileのbyte数が上限を超えています");
  return readFile(path);
}

/** checkpoint artifactとsidecarを同じ保存先へ書く。 */
export async function writePublicationCheckpointFile(
  path: string,
  encoded: EncodedPublicationCheckpoint,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, encoded.artifactBytes, { flag: "w" });
    await writeFile(publicationCheckpointSidecarPath(path), encoded.sidecarBytes, { flag: "w" });
  } catch (error: unknown) {
    throw artifactFileError(path, error);
  }
}

/** 効果前の期待値を組み立てるため、未結合の識別だけを読む。 */
export async function readPublicationCheckpointHeader(path: string): Promise<
  Readonly<{
    runIdentity: RunIdentity;
    executionPolicy: RunExecutionPolicy;
    baseStateRevision: BaseStateRevision;
  }>
> {
  try {
    const bytes = await readBoundedFile(path, MAX_CHECKPOINT_FILE_BYTES);
    const { artifact } = readPublicationArtifactManifest(bytes);
    return Object.freeze({
      runIdentity: artifact.logical.runIdentity,
      executionPolicy: artifact.logical.executionPolicy,
      baseStateRevision: artifact.logical.baseStateRevision,
    });
  } catch (error: unknown) {
    throw artifactFileError(path, error);
  }
}

/** v23 artifactとsidecarを検証し、exact baseへ結合して返す。 */
export async function readPublicationCheckpointFile(
  path: string,
  expected: PublicationCheckpointFileExpectation,
): Promise<BoundPublicationCheckpoint> {
  try {
    const [artifactBytes, sidecarBytes] = await Promise.all([
      readBoundedFile(path, MAX_CHECKPOINT_FILE_BYTES),
      readBoundedFile(publicationCheckpointSidecarPath(path), MAX_CHECKPOINT_MANIFEST_BYTES),
    ]);
    const decoded = decodePublicationArtifact(
      artifactBytes,
      sidecarBytes,
      {
        runtimeIdentity: expected.runtime.runtimeIdentity,
        expectedRunId: expected.expectedRunId,
        baseStateRevision: expected.baseStateRevision,
        configDigest: expected.configDigest,
        artifactFileName: basename(path),
      },
      nodeContentDigestPort,
      nodeCheckpointCompressionPort,
    );
    return bindPublicationCheckpoint(
      decoded,
      {
        checkpointFileDigest: decoded.checkpointFileDigest,
        runtimeRecoveryPlan: expected.runtime.runtimeRecoveryPlan,
      },
      expected.baseWitness,
      nodeContentDigestPort,
    );
  } catch (error: unknown) {
    throw artifactFileError(path, error);
  }
}

import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import type {
  FailedRun,
  FailureStateObservation,
} from "../../application/tracking-run/failure-artifact.js";
import {
  readDurablePublicationRecordSchemaVersion,
  readDurablePublicationRecoveryBootstrap,
  readDurablePublicationRecoveryBootstrapV2,
  readRunTransactionMarkerRecoveryBootstrap,
} from "../../application/tracking-run/recovery-bootstrap.js";
import { loadConfig } from "../../config/index.js";
import type { StateFileReadResult } from "../../persistence/branch-adapter.js";
import { GitStateBranchAdapter } from "../../persistence/index.js";
import { nodeContentDigestPort } from "./content-digest.js";

export type BootstrapFailureObservation = Readonly<{
  evidence?: FailedRun["evidence"];
  runId?: string;
  checkpointDigest?: string;
  checkpointFileDigest?: string;
  stateObservation: FailureStateObservation;
  bootstrapError?: unknown;
}>;

type CheckpointFailureEvidence = Extract<FailedRun["evidence"], { bindingKind: "checkpoint" }>;

function observedFile(
  file: StateFileReadResult,
): Readonly<{ kind: "missing" }> | Readonly<{ kind: "present"; fileDigest: string }> {
  return file.status === "missing"
    ? { kind: "missing" }
    : { kind: "present", fileDigest: nodeContentDigestPort.sha256Bytes(file.bytes) };
}

/** exact state headのmarkerとrecordから失敗時点の実証済み結合を観測する。 */
export async function observeBootstrap(
  configPath: string,
  expectedRunId: string | undefined,
  expectedCheckpoint?: CheckpointFailureEvidence,
): Promise<BootstrapFailureObservation | undefined> {
  const config = await loadConfig(configPath);
  const adapter = new GitStateBranchAdapter({
    repositoryPath: process.cwd(),
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status === "missing") {
    return undefined;
  }
  const files = await adapter.readFiles(head.revision, [
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  ]);
  const markerFile = files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const recordFile = files.get(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  if (markerFile == null || recordFile == null) {
    throw new TypeError("失敗観測のstate bootstrap fileが不足しています");
  }
  if (markerFile.status === "missing" && recordFile.status === "missing") {
    return { stateObservation: { kind: "same_head_no_marker", revision: head.revision } };
  }
  try {
    if (markerFile.status === "missing" || recordFile.status === "missing") {
      throw new TypeError("markerとrecordの片方がありません");
    }
    const marker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
    const recordVersion = readDurablePublicationRecordSchemaVersion(recordFile.bytes);
    let record;
    if (recordVersion === 1) {
      record = readDurablePublicationRecoveryBootstrap(recordFile.bytes, nodeContentDigestPort);
    } else if (recordVersion === 2 || recordVersion === 3) {
      record = readDurablePublicationRecoveryBootstrapV2(recordFile.bytes, nodeContentDigestPort);
    } else {
      throw new TypeError("未対応のdurable record schemaです");
    }
    if (
      marker.runId !== record.runId ||
      marker.checkpointDigest !== record.checkpointDigest ||
      marker.publicationRecordDigest !== record.recordDigest
    ) {
      throw new TypeError("markerとrecordのbootstrap識別が一致しません");
    }
    if (
      expectedCheckpoint != null &&
      (marker.runId !== expectedCheckpoint.runId ||
        marker.checkpointDigest !== expectedCheckpoint.checkpointDigest ||
        record.checkpointFileDigest !== expectedCheckpoint.checkpointFileDigest ||
        record.runtimeIdentityDigest !== expectedCheckpoint.runtimeIdentityDigest)
    ) {
      return { stateObservation: { kind: "conflict", revision: head.revision } };
    }
    if (expectedRunId != null && marker.runId !== expectedRunId) {
      return {
        stateObservation: {
          kind: marker.phase === "run_finalized" ? "observed_head" : "conflict",
          revision: head.revision,
        },
      };
    }
    return {
      evidence: {
        bindingKind: "checkpoint",
        runId: marker.runId,
        checkpointDigest: marker.checkpointDigest,
        checkpointFileDigest: record.checkpointFileDigest,
        runtimeIdentityDigest: record.runtimeIdentityDigest,
      },
      runId: marker.runId,
      checkpointDigest: marker.checkpointDigest,
      checkpointFileDigest: record.checkpointFileDigest,
      stateObservation: {
        kind: "consistent_pending",
        revision: head.revision,
        runId: marker.runId,
        checkpointDigest: marker.checkpointDigest,
        markerPhase: marker.phase,
      },
    };
  } catch (bootstrapError: unknown) {
    return {
      evidence: {
        bindingKind: "state_bootstrap_alert",
        observedStateRevision: head.revision,
        observedMarkerFile: observedFile(markerFile),
        observedRecordFile: observedFile(recordFile),
      },
      stateObservation: { kind: "observed_head", revision: head.revision },
      bootstrapError,
    };
  }
}

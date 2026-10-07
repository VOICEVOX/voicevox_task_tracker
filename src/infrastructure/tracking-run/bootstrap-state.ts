import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  runtimeRecoveryInputV1Schema,
  type RuntimeRecoveryInputV1,
} from "../../application/tracking-run/contracts/runtime-recovery-v1.js";
import {
  readDurablePublicationRecordSchemaVersion,
  readDurablePublicationRecoveryBootstrap,
  readDurablePublicationRecoveryBootstrapV2,
  readRunTransactionMarkerRecoveryBootstrap,
  type DurablePublicationRecoveryBootstrapV1,
  type DurablePublicationRecoveryBootstrapV2,
  type RunTransactionMarkerRecoveryBootstrapV1,
} from "../../application/tracking-run/recovery-bootstrap.js";
import type { StateBranchAdapter, StateBranchHead } from "../../persistence/branch-adapter.js";
import { nodeContentDigestPort } from "./content-digest.js";

/** 同じstate revisionのbootstrapだけから選ぶ起動経路。 */
export type RuntimeLaunchDecision =
  | Readonly<{
      kind: "start_with_current_runtime";
      observedStateHead: StateBranchHead;
    }>
  | Readonly<{
      kind: "resume_with_exact_runtime";
      observedStateHead: Extract<StateBranchHead, { status: "present" }>;
      marker: RunTransactionMarkerRecoveryBootstrapV1;
      record: DurablePublicationRecoveryBootstrapV1 | DurablePublicationRecoveryBootstrapV2;
    }>
  | Readonly<{
      kind: "manual_resolution_required";
      observedStateHead: Extract<StateBranchHead, { status: "present" }>;
      cause: Error;
    }>
  | Readonly<{
      kind: "operator_conflict_resolution";
      observedStateHead: StateBranchHead;
      reason: "different_run" | "state_head_changed" | "superseded_by_newer_run";
    }>;

/** 通常起動と既存runを指定した再開を区別する。 */
export type RunRecoveryIntent =
  | Readonly<{ kind: "start_new" }>
  | Readonly<{ kind: "retry_run"; runId: string; exactStateRevision: string }>;

function manualResolution(
  observedStateHead: Extract<StateBranchHead, { status: "present" }>,
  cause: Error,
): RuntimeLaunchDecision {
  return Object.freeze({ kind: "manual_resolution_required", observedStateHead, cause });
}

/** markerとrecordを一つのexact revisionから読み、現行runtimeを起動できるか判定する。 */
export async function inspectRunBootstrapState(
  adapter: StateBranchAdapter,
  branch: string,
  intent: RunRecoveryIntent,
): Promise<RuntimeLaunchDecision> {
  const observedStateHead = await adapter.resolveHead(branch);
  if (observedStateHead.status === "missing") {
    if (intent.kind === "retry_run") {
      return Object.freeze({
        kind: "operator_conflict_resolution",
        observedStateHead,
        reason: "different_run",
      });
    }
    return Object.freeze({ kind: "start_with_current_runtime", observedStateHead });
  }
  const revision =
    intent.kind === "retry_run" ? intent.exactStateRevision : observedStateHead.revision;
  const files = await adapter.readFiles(revision, [
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  ]);
  const markerFile = files.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
  const recordFile = files.get(DURABLE_PUBLICATION_RECORD_STATE_PATH_V1);
  if (markerFile == null || recordFile == null) {
    throw new TypeError("state bootstrapの一括読取結果が不足しています");
  }
  if (markerFile.status === "missing" && recordFile.status === "missing") {
    if (intent.kind === "retry_run") {
      return Object.freeze({
        kind: "operator_conflict_resolution",
        observedStateHead,
        reason: "different_run",
      });
    }
    return Object.freeze({ kind: "start_with_current_runtime", observedStateHead });
  }
  if (markerFile.status === "missing" || recordFile.status === "missing") {
    return manualResolution(
      observedStateHead,
      new TypeError("transaction markerとdurable recordの片方がありません"),
    );
  }
  let marker: RunTransactionMarkerRecoveryBootstrapV1;
  let record: DurablePublicationRecoveryBootstrapV1 | DurablePublicationRecoveryBootstrapV2;
  try {
    marker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
    const recordVersion = readDurablePublicationRecordSchemaVersion(recordFile.bytes);
    if (recordVersion === 1) {
      record = readDurablePublicationRecoveryBootstrap(recordFile.bytes, nodeContentDigestPort);
    } else if (recordVersion === 2 || recordVersion === 3) {
      record = readDurablePublicationRecoveryBootstrapV2(recordFile.bytes, nodeContentDigestPort);
    } else {
      throw new TypeError("未対応のdurable record schemaです");
    }
  } catch (error: unknown) {
    return manualResolution(
      observedStateHead,
      new TypeError("state bootstrapの検証に失敗しました", { cause: error }),
    );
  }
  if (
    marker.runId !== record.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    marker.publicationRecordDigest !== record.recordDigest
  ) {
    return manualResolution(
      observedStateHead,
      new TypeError("transaction markerとdurable recordが一致しません"),
    );
  }
  if (intent.kind === "retry_run" && marker.runId !== intent.runId) {
    return Object.freeze({
      kind: "operator_conflict_resolution",
      observedStateHead,
      reason: "different_run",
    });
  }
  if (marker.phase === "run_finalized" && intent.kind === "start_new") {
    return Object.freeze({ kind: "start_with_current_runtime", observedStateHead });
  }
  if (record.runtimeRecoveryPlan.kind === "not_reproducible") {
    return manualResolution(observedStateHead, new TypeError("未完了runのruntimeを再現できません"));
  }
  if (intent.kind === "retry_run" && revision !== observedStateHead.revision) {
    const headFiles = await adapter.readFiles(observedStateHead.revision, [
      RUN_TRANSACTION_MARKER_STATE_PATH_V1,
    ]);
    const headMarkerFile = headFiles.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
    if (headMarkerFile?.status !== "present") {
      return manualResolution(observedStateHead, new TypeError("現在headのmarkerがありません"));
    }
    let headMarker: RunTransactionMarkerRecoveryBootstrapV1;
    try {
      headMarker = readRunTransactionMarkerRecoveryBootstrap(headMarkerFile.bytes);
    } catch (error: unknown) {
      return manualResolution(
        observedStateHead,
        new TypeError("現在headのmarkerが不正です", { cause: error }),
      );
    }
    return Object.freeze({
      kind: "operator_conflict_resolution",
      observedStateHead,
      reason: headMarker.runId === intent.runId ? "state_head_changed" : "superseded_by_newer_run",
    });
  }
  return Object.freeze({ kind: "resume_with_exact_runtime", observedStateHead, marker, record });
}

/** bootstrapが選んだ旧runtimeへ渡す固定V1入力を作る。 */
export function createRuntimeRecoveryInputV1(
  decision: Extract<RuntimeLaunchDecision, { kind: "resume_with_exact_runtime" }>,
  stateRef: string,
  invocationId: string,
): RuntimeRecoveryInputV1 {
  const plan = decision.record.runtimeRecoveryPlan;
  if (plan.kind === "not_reproducible" || plan.schemaVersion !== 1) {
    throw new TypeError("回復不能なruntimeへV1入力を作れません");
  }
  return runtimeRecoveryInputV1Schema.parse({
    protocolVersion: 1,
    inputContract: "tracking-run-recovery-input-v1",
    invocationId,
    stateRef,
    exactStateRevision: decision.observedStateHead.revision,
    runId: decision.record.runId,
    expectedRecordDigest: decision.record.recordDigest,
    expectedRuntimeIdentityDigest: decision.record.runtimeIdentityDigest,
    expectedWorkflowEffectAdapterIdentityDigest:
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: plan,
  });
}

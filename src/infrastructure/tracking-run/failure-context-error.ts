import type { FailedRun } from "../../application/tracking-run/failure-artifact.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";

/** 結合済みcheckpoint後の元エラーと公開可能な識別だけを運ぶ。 */
export class BoundPublicationFailureError extends Error {
  public readonly binding: Readonly<{
    runId: string;
    checkpointDigest: string;
    checkpointFileDigest: string;
    runtimeIdentityDigest: string;
    baseStateRevision: BoundPublicationCheckpoint["checkpoint"]["baseStateRevision"];
  }>;

  public constructor(bound: BoundPublicationCheckpoint, cause: unknown) {
    super("結合済みcheckpoint後の初回state commitに失敗しました", { cause });
    this.binding = Object.freeze({
      runId: bound.checkpoint.runIdentity.runId,
      checkpointDigest: bound.checkpointDigest,
      checkpointFileDigest: bound.bindingProof.checkpointFileDigest,
      runtimeIdentityDigest: bound.bindingProof.runtimeIdentityDigest,
      baseStateRevision: bound.checkpoint.baseStateRevision,
    });
  }
}

/** 運用障害通知の送達確度を保ったままreceipt保存失敗を運ぶ。 */
export class OperationsAlertReceiptFailureError extends Error {
  public readonly effectCertainty: "no_effect" | "committed" | "ambiguous";

  public constructor(effectCertainty: "no_effect" | "committed" | "ambiguous", cause: unknown) {
    super("運用障害通知receiptを保存できませんでした", { cause });
    this.effectCertainty = effectCertainty;
  }
}

/** 検証済みpending runの起動失敗とcheckpoint結合を保持する。 */
export class VerifiedPendingRuntimeFailureError extends Error {
  public readonly failedStage: Extract<
    FailedRun["failedStage"],
    "runtime_selection" | "runtime_launch" | "workflow_effect_observation"
  >;
  public readonly binding: Extract<FailedRun["evidence"], { bindingKind: "checkpoint" }>;

  public constructor(
    failedStage: VerifiedPendingRuntimeFailureError["failedStage"],
    binding: VerifiedPendingRuntimeFailureError["binding"],
    cause: unknown,
  ) {
    super("検証済みpending runの起動または観測に失敗しました", { cause });
    this.failedStage = failedStage;
    this.binding = binding;
  }
}

import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import type { ProductionPagesEffectLease } from "../../persistence/production-pages-effect-lease-schema.js";
import type { RecoveryStageInput } from "./recovery-stage.js";
import { readNotificationMessageState } from "./notification-message-state.js";

/** exact stateと復旧段階からPages leaseの同一run継続を検証する。 */
export async function assertSequentialPagesLeaseContinuation(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  lease: ProductionPagesEffectLease,
  stage: RecoveryStageInput,
): Promise<void> {
  const plan = stage.record.runtimeRecoveryPlan;
  if (
    lease.status !== "active" ||
    lease.runId !== stage.record.runIdentity.runId ||
    lease.checkpointDigest !== stage.record.checkpointDigest ||
    stage.marker.runId !== lease.runId ||
    stage.marker.checkpointDigest !== lease.checkpointDigest ||
    stage.record.executionPolicy.effectTarget !== "production" ||
    stage.record.executionPolicy.executionShape !== "sequential" ||
    plan.kind === "not_reproducible" ||
    plan.codeRevision !== lease.codeRevision
  ) {
    throw new TypeError("production Pages leaseとexact復旧runが一致しません");
  }
  const state = await readNotificationMessageState(
    adapter,
    configuration,
    stage.exactStateRevision,
  );
  if (
    state.transaction.record.recordDigest !== stage.record.recordDigest ||
    state.transaction.marker.phase !== stage.marker.phase
  ) {
    throw new TypeError("production Pages leaseの復旧stateが一致しません");
  }
  if (lease.effect.phase === "initial") {
    if (lease.effect.sourceStateRevision !== stage.initialStateRevision) {
      throw new TypeError("production Pages leaseの初回state revisionが一致しません");
    }
    if (stage.marker.phase !== "initial_state_committed") {
      const evidence = state.transaction.initialPagesEvidence;
      if (
        evidence?.runId !== lease.runId ||
        evidence.checkpointDigest !== lease.checkpointDigest ||
        evidence.sourceStateRevision !== lease.effect.sourceStateRevision ||
        evidence.deploymentIntentDigest !== lease.effect.deploymentIntentDigest
      ) {
        throw new TypeError("production Pages leaseと初回公開のstate証拠が一致しません");
      }
    }
    return;
  }
  if (stage.marker.phase !== "run_finalized") {
    throw new TypeError("履歴Pages leaseにfinalized stateがありません");
  }
  const finalization =
    stage.stage === "notification_history_build" || stage.stage === "notification_history_deploy"
      ? stage.resumeInput.runFinalizationReceipt
      : stage.receiptChain.findLast((receipt) => receipt.receiptType === "run_finalization");
  if (
    finalization?.receiptType !== "run_finalization" ||
    finalization.binding.bindingKind !== "checkpoint" ||
    finalization.binding.runId !== lease.runId ||
    finalization.binding.checkpointDigest !== lease.checkpointDigest ||
    finalization.result.resultingStateRevision !== lease.effect.sourceStateRevision
  ) {
    throw new TypeError("履歴Pages leaseとrun finalization receiptが一致しません");
  }
}

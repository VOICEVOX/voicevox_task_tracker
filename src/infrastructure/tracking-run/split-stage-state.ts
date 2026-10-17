import { resolve } from "node:path";

import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { findInitialStateRevision } from "../../persistence/state-orthogonal-advance.js";
import { DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION } from "../../publication/durable-record-schema.js";
import { inspectRunBootstrapState } from "./bootstrap-state.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { inspectRunState } from "./inspect-run-state.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import {
  assertRecordedWorkflowAdapterIdentityV2,
  assertRecoveryToolchain,
  verifyRecoveryBundle,
} from "./publication-runtime.js";
import { projectPublicationSettings } from "./publication/settings.js";
import type { RecoveryStageInput } from "./recovery-stage.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";

export type SplitState = Readonly<{
  config: Awaited<ReturnType<ProductionRuntimeAdapters["loadConfig"]>>;
  adapter: ReturnType<ProductionRuntimeAdapters["createStateBranchAdapter"]>;
  headRevision: string;
  initialStateRevision: string;
  markerPhase:
    | "initial_state_committed"
    | "notifications_in_progress"
    | "notifications_settled"
    | "run_finalized";
  effectTarget: "production" | "sandbox" | "recording";
  recordDigest: string;
  runtimeIdentityDigest: string;
  workflowEffectAdapterIdentityDigest: string;
  runtimeRecoveryPlan: Extract<
    Awaited<ReturnType<typeof inspectRunBootstrapState>>,
    { kind: "resume_with_exact_runtime" }
  >["record"]["runtimeRecoveryPlan"];
}>;

/** 指定run IDをworkflow adapterの環境へ固定する。 */
export function scopedAdapters(
  adapters: ProductionRuntimeAdapters,
  runId: string,
): ProductionRuntimeAdapters {
  const expected = adapters.environment["VOICEVOX_EXPECTED_RUN_ID"];
  if (expected != null && expected !== runId) {
    throw new TypeError("workflowの期待run IDとrun-stage指定が一致しません");
  }
  return Object.freeze({
    ...adapters,
    environment: Object.freeze({ ...adapters.environment, VOICEVOX_EXPECTED_RUN_ID: runId }),
  });
}

/** 永続stateとexact runtimeを照合して分割runの状態を読む。 */
export async function inspectSplitState(
  adapters: ProductionRuntimeAdapters,
  configPath: string,
  runId: string,
): Promise<SplitState> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, configPath));
  const adapter = adapters.createStateBranchAdapter();
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status !== "present") {
    throw new TypeError("分割runの永続stateがありません");
  }
  const bootstrap = await inspectRunBootstrapState(adapter, config.state.branch, {
    kind: "retry_run",
    runId,
    exactStateRevision: head.revision,
  });
  if (bootstrap.kind !== "resume_with_exact_runtime") {
    throw new TypeError("分割runのcheckpointに結合したexact runtimeを選べません", {
      cause: bootstrap.kind === "manual_resolution_required" ? bootstrap.cause : undefined,
    });
  }
  if (bootstrap.record.recordSchemaVersion !== DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION) {
    throw new TypeError("分割runの永続record schemaが現行形式ではありません");
  }
  const plan = bootstrap.record.runtimeRecoveryPlan;
  if (plan.kind !== "workflow_bundle" || plan.artifactName !== "workflow-cli-runtime") {
    throw new TypeError("分割runのexact runtimeを再現できません");
  }
  await verifyRecoveryBundle(resolve(adapters.repositoryPath, "artifacts/workflow/runtime"), plan);
  await assertRecoveryToolchain(adapters.repositoryPath, plan);
  await assertRecordedWorkflowAdapterIdentityV2(
    adapters.repositoryPath,
    plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    digest,
  );
  const state = await readNotificationMessageState(adapter, config.state, head.revision);
  const record = state.transaction.record;
  if (
    record.executionPolicy.executionShape !== "split_workflow" ||
    state.transaction.marker.runId !== runId ||
    record.runIdentity.runId !== runId ||
    record.recordDigest !== bootstrap.record.recordDigest ||
    serializeCanonicalJson(projectPublicationSettings(config).pages) !==
      serializeCanonicalJson(record.initialPagesProjection.settings) ||
    digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) !==
      bootstrap.record.runtimeIdentityDigest
  ) {
    throw new TypeError("分割runの永続recordと選択runtimeが一致しません");
  }
  const initialStateRevision =
    state.transaction.marker.phase === "initial_state_committed"
      ? await findInitialStateRevision(adapter, config.state, head.revision, runId)
      : state.transaction.marker.initialStateRevision;
  return {
    config,
    adapter,
    headRevision: head.revision,
    initialStateRevision,
    markerPhase: state.transaction.marker.phase,
    effectTarget: record.executionPolicy.effectTarget,
    recordDigest: bootstrap.record.recordDigest,
    runtimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
    workflowEffectAdapterIdentityDigest: plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: plan,
  };
}

/** 分割runのexact stateとreceipt chainを検証する。 */
export async function verifySplitState(
  state: SplitState,
  runId: string,
  invocationId: string,
  observedAt: string,
  entries: readonly ReceiptChainEntry[],
): Promise<RecoveryStageInput> {
  const decision = await inspectRunState(state.adapter, state.config.state, {
    kind: "resume_run",
    runtime: "exact",
    runId,
    exactStateRevision: state.headRevision,
    expectedRecordDigest: state.recordDigest,
    expectedRuntimeIdentityDigest: state.runtimeIdentityDigest,
    expectedWorkflowEffectAdapterIdentityDigest: state.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: state.runtimeRecoveryPlan,
    observation: { invocationId, observedAt },
    receipts: entries,
  });
  if (decision.kind === "manual_resolution_required") {
    throw new TypeError("分割runのexact stateまたはreceipt chainが不正です", {
      cause: decision.cause,
    });
  }
  if (decision.kind !== "resume_pending") {
    throw new TypeError("分割runのexact stateを再開できません");
  }
  return decision.stageInput;
}

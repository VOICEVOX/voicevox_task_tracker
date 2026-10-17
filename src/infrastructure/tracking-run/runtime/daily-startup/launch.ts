import { resolve } from "node:path";
import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { completeTrackingRun } from "../../../../application/tracking-run/complete-run.js";
import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
} from "../../../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../../../application/tracking-run/receipt-chain.js";
import { serializeCanonicalJsonLine } from "../../../../canonical-json/value.js";
import {
  assertNoProductionPagesEffectLease,
  readProductionPagesEffectLease,
} from "../../../../persistence/production-pages-effect-lease.js";
import { assertNonNullable } from "../../../../util/assert-non-nullable.js";
import {
  createRuntimeRecoveryInputV1,
  inspectRunBootstrapState,
  type RunRecoveryIntent,
} from "../../bootstrap-state.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import { inspectRunState } from "../../inspect-run-state.js";

import { VerifiedPendingRuntimeFailureError } from "../../failure-context-error.js";
import { resolveRuntimeTarget } from "../../production-runtime-setup.js";
import {
  RuntimeRecoveryLaunchError,
  RuntimeRecoveryObservationError,
  recoverSequentialRuntimeV1,
} from "../../runtime-recovery-acquisition.js";
import { sequentialReceiptPath } from "../../sequential-receipt-path.js";
import { requireSequentialPagesActionsContext } from "../../sequential-pages-actions-port.js";
import { assertSequentialPagesLeaseContinuation } from "../../sequential-pages-lease-continuation.js";
import type { ConfigurationRuntimeAdapters, ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;

/** 保存済みreceipt列をcanonical形式と連鎖規則で再読込する。 */
export async function readSequentialReceipts(
  repositoryPath: string,
  runId: string,
  readArtifactBytes: ConfigurationRuntimeAdapters["readArtifactBytes"],
): Promise<ReturnType<typeof receiptChainEnvelopeSchema.parse>["entries"]> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      await readArtifactBytes(sequentialReceiptPath(repositoryPath, runId)),
    );
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("保存済みreceipt chainがcanonical JSONではありません");
  }
  const envelope = receiptChainEnvelopeSchema.parse(raw);
  verifyReceiptChain(envelope.entries, nodeContentDigestPort);
  return envelope.entries;
}

/** state bootstrapとexact runtimeを照合して新規開始またはpending再開を選ぶ。 */
export function createInspectLaunchStage(
  adapters: ConfigurationRuntimeAdapters & Pick<ProductionRuntimeAdapters, "writeJsonArtifact">,
  now: () => Date,
): SequentialStageDependencies["inspectLaunch"] {
  return async (request, invocationId, intent) => {
    if (
      request.executionPolicy.effectTarget === "production" &&
      request.executionPolicy.executionShape === "sequential"
    ) {
      requireSequentialPagesActionsContext(adapters.environment);
    }
    const config = await adapters.loadConfig(resolve(adapters.repositoryPath, request.configPath));
    const target = await resolveRuntimeTarget(
      Object.freeze({
        repositoryPath: adapters.repositoryPath,
        ...(adapters.readSandboxContext == null
          ? {}
          : { readSandboxContext: adapters.readSandboxContext }),
        createStateBranchAdapter: adapters.createStateBranchAdapter,
      }),
      config,
      request,
    );
    const adapter = adapters.createStateBranchAdapter();
    let recoveryIntent: RunRecoveryIntent;
    const configuredRunId = adapters.environment["VOICEVOX_EXPECTED_RUN_ID"];
    const expectedRunId =
      configuredRunId == null || configuredRunId.length === 0 ? undefined : configuredRunId;
    if (expectedRunId != null && !/^tracker-run:[0-9a-f]{64}$/u.test(expectedRunId)) {
      throw new TypeError("再開対象のrun IDが不正です");
    }
    if (adapters.environment["VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V1"] === "1") {
      const runId = adapters.environment["VOICEVOX_RUNTIME_RECOVERY_RUN_ID"];
      if (runId == null) {
        throw new TypeError("固定V1復旧のrun IDがありません");
      }
      const head = await adapter.resolveHead(target.state.branch);
      if (head.status !== "present") {
        throw new TypeError("固定V1復旧のstate headがありません");
      }
      recoveryIntent = { kind: "retry_run", runId, exactStateRevision: head.revision };
    } else if (intent.kind === "start_new" && expectedRunId == null) {
      recoveryIntent = intent;
    } else {
      const head = await adapter.resolveHead(target.state.branch);
      if (head.status !== "present") {
        throw new TypeError("再開するrunのstate headがありません");
      }
      const runId = intent.kind === "start_new" ? expectedRunId : intent.runId;
      assertNonNullable(runId, "再開対象のrun IDがありません");
      recoveryIntent = {
        kind: "retry_run",
        runId,
        exactStateRevision: head.revision,
      };
    }
    const bootstrap = await inspectRunBootstrapState(adapter, target.state.branch, recoveryIntent);
    if (bootstrap.kind === "start_with_current_runtime") {
      if (intent.kind !== "start_new" || expectedRunId != null) {
        throw new TypeError("再開するrunのstate bootstrapがありません");
      }
      if (target.kind === "production" && request.executionPolicy.executionShape === "sequential") {
        await assertNoProductionPagesEffectLease(adapter, target.state.branch);
      }
      return Object.freeze({
        runtime: "current",
        decision: Object.freeze({ kind: "start_new", baseRevision: bootstrap.observedStateHead }),
      });
    }
    if (bootstrap.kind === "manual_resolution_required") {
      throw new TypeError("state bootstrapが不整合のため手動解決が必要です", {
        cause: bootstrap.cause,
      });
    }
    if (bootstrap.kind === "operator_conflict_resolution") {
      throw new TypeError("state bootstrapのrunが起動要求と一致しません");
    }
    if (expectedRunId != null && bootstrap.record.runId !== expectedRunId) {
      throw new TypeError("再開対象のrun IDがstate bootstrapと一致しません");
    }
    if (target.kind === "production" && request.executionPolicy.executionShape === "sequential") {
      const lease = await readProductionPagesEffectLease(adapter);
      if (lease?.status === "active") {
        const plan = bootstrap.record.runtimeRecoveryPlan;
        if (
          plan.kind === "not_reproducible" ||
          lease.runId !== bootstrap.record.runId ||
          lease.checkpointDigest !== bootstrap.record.checkpointDigest ||
          lease.codeRevision !== plan.codeRevision ||
          bootstrap.marker.runId !== lease.runId ||
          (lease.effect.phase === "notification_history" &&
            bootstrap.marker.phase !== "run_finalized")
        ) {
          throw new TypeError("production Pages leaseと再開するexact runが一致しません");
        }
      }
    }
    const binding = {
      bindingKind: "checkpoint" as const,
      runId: bootstrap.record.runId,
      checkpointDigest: bootstrap.record.checkpointDigest,
      checkpointFileDigest: bootstrap.record.checkpointFileDigest,
      runtimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
    };
    const plan = bootstrap.record.runtimeRecoveryPlan;
    if (plan.schemaVersion !== 1) {
      throw new VerifiedPendingRuntimeFailureError(
        "runtime_selection",
        binding,
        new TypeError("分割workflowのV2 runtimeは直列入口から再開できません"),
      );
    }
    if (adapters.environment["VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V1"] === "1") {
      if (plan.kind === "not_reproducible") {
        throw new VerifiedPendingRuntimeFailureError(
          "runtime_selection",
          binding,
          new TypeError("未完了runのruntimeを再現できません"),
        );
      }
      const entries = await readSequentialReceipts(
        adapters.repositoryPath,
        bootstrap.record.runId,
        adapters.readArtifactBytes,
      );
      const decision = await inspectRunState(adapter, target.state, {
        kind: "resume_run",
        runtime: "exact",
        runId: bootstrap.record.runId,
        exactStateRevision: bootstrap.observedStateHead.revision,
        expectedRecordDigest: bootstrap.record.recordDigest,
        expectedRuntimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
        expectedWorkflowEffectAdapterIdentityDigest:
          plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
        runtimeRecoveryPlan: plan,
        observation: { invocationId, observedAt: now().toISOString() },
        receipts: entries,
      });
      if (decision.kind !== "resume_pending") {
        throw new VerifiedPendingRuntimeFailureError(
          "workflow_effect_observation",
          binding,
          decision.kind === "manual_resolution_required"
            ? decision.cause
            : new TypeError("pending runのstateが変わりました"),
        );
      }
      if (target.kind === "production" && request.executionPolicy.executionShape === "sequential") {
        const lease = await readProductionPagesEffectLease(adapter);
        if (lease?.status === "active") {
          await assertSequentialPagesLeaseContinuation(
            adapter,
            target.state,
            lease,
            decision.stageInput,
          );
        }
      }
      return Object.freeze({
        runtime: "exact",
        decision: Object.freeze({ kind: "resume_pending", pending: decision.stageInput }),
      });
    }
    if (plan.kind === "not_reproducible") {
      throw new VerifiedPendingRuntimeFailureError(
        "runtime_selection",
        binding,
        new TypeError("未完了runのruntimeを再現できません"),
      );
    }
    const input = createRuntimeRecoveryInputV1(bootstrap, target.state.branch, invocationId);
    let attempt: Awaited<ReturnType<typeof recoverSequentialRuntimeV1>>;
    try {
      attempt = await recoverSequentialRuntimeV1(
        adapters.repositoryPath,
        adapters.environment["VOICEVOX_RUNTIME_BUNDLE_ROOT"],
        input,
      );
    } catch (error: unknown) {
      const stage =
        error instanceof RuntimeRecoveryObservationError
          ? "workflow_effect_observation"
          : error instanceof RuntimeRecoveryLaunchError
            ? "runtime_launch"
            : "runtime_selection";
      throw new VerifiedPendingRuntimeFailureError(stage, binding, error);
    }
    if (attempt.output.status !== "completed") {
      throw new VerifiedPendingRuntimeFailureError(
        attempt.output.status === "ready" ? "runtime_launch" : "workflow_effect_observation",
        binding,
        new TypeError("固定V1 runtimeがpending runの完了証拠を返しませんでした"),
      );
    }
    try {
      const observed = await inspectRunBootstrapState(adapter, target.state.branch, {
        kind: "retry_run",
        runId: binding.runId,
        exactStateRevision: attempt.output.stateRevision,
      });
      if (
        observed.kind !== "resume_with_exact_runtime" ||
        observed.observedStateHead.revision !== attempt.output.stateRevision ||
        observed.marker.phase !== "run_finalized" ||
        observed.record.recordDigest !== bootstrap.record.recordDigest ||
        observed.record.checkpointDigest !== binding.checkpointDigest ||
        observed.record.runtimeIdentityDigest !== binding.runtimeIdentityDigest
      ) {
        throw new TypeError("固定V1 runtimeの完了stateが旧runのcheckpointと一致しません");
      }
      const inspected = await inspectRunState(adapter, target.state, {
        kind: "resume_run",
        runtime: "exact",
        runId: binding.runId,
        exactStateRevision: attempt.output.stateRevision,
        expectedRecordDigest: observed.record.recordDigest,
        expectedRuntimeIdentityDigest: binding.runtimeIdentityDigest,
        expectedWorkflowEffectAdapterIdentityDigest:
          plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
        runtimeRecoveryPlan: plan,
        observation: { invocationId, observedAt: now().toISOString() },
        receipts: attempt.receiptEntries,
      });
      if (inspected.kind !== "resume_pending" || inspected.stageInput.stage !== "completed") {
        throw new TypeError("固定V1 runtimeのreceipt chainが完了していません");
      }
      const finalization = attempt.receiptEntries.findLast(
        (entry) => entry.receipt.receiptType === "run_finalization",
      )?.receipt;
      if (finalization?.receiptType !== "run_finalization") {
        throw new TypeError("固定V1 runtimeの最終state receiptがありません");
      }
      const completed = completeTrackingRun(
        {
          entries: attempt.receiptEntries,
          finalStateRevision: finalization.result.resultingStateRevision,
          invocationId,
          observedAt: now().toISOString(),
        },
        nodeContentDigestPort,
      );
      await adapters.writeJsonArtifact(
        sequentialReceiptPath(adapters.repositoryPath, binding.runId),
        receiptChainEnvelopeSchema.parse({
          schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION,
          entries: attempt.receiptEntries,
        }),
      );
      return Object.freeze({
        runtime: "exact",
        decision: Object.freeze({ kind: "completed", completed, runId: binding.runId }),
      });
    } catch (error: unknown) {
      throw new VerifiedPendingRuntimeFailureError("workflow_effect_observation", binding, error);
    }
  };
}

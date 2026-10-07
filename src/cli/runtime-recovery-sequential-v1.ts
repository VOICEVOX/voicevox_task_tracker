import { resolve } from "node:path";

import type {
  RuntimeRecoveryInputV1,
  RuntimeRecoveryOutputV1,
} from "../application/tracking-run/contracts/runtime-recovery-v1.js";
import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
} from "../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../application/tracking-run/receipt-chain.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import {
  createDiagnosticsRecorder,
  type DiagnosticsJsonlRecorder,
} from "../diagnostics/recorder.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  inspectRunState,
  type RunStateDecision,
} from "../infrastructure/tracking-run/inspect-run-state.js";
import type { ProductionRuntimeAdapters } from "../infrastructure/tracking-run/runtime/adapters.js";
import { readSequentialReceipts } from "../infrastructure/tracking-run/runtime/daily-startup/launch.js";
import { sequentialReceiptPath } from "../infrastructure/tracking-run/sequential-receipt-path.js";
import { splitStagePaths } from "../infrastructure/tracking-run/split-stage-paths.js";
import { restoreSplitReceipts } from "../infrastructure/tracking-run/split-stage-recovery.js";
import { createDefaultProductionRuntimeAdapters } from "./composition-root.js";
import { createProductionCliApplication } from "./create-application.js";

function exactAdapters(
  runId: string,
  recorder: DiagnosticsJsonlRecorder | undefined,
): ProductionRuntimeAdapters {
  const adapters = createDefaultProductionRuntimeAdapters(recorder);
  return Object.freeze({
    ...adapters,
    environment: Object.freeze({
      ...adapters.environment,
      VOICEVOX_EXPECTED_RUN_ID: runId,
      VOICEVOX_RUNTIME_RECOVERY_RUN_ID: runId,
    }),
  });
}

function sequentialArguments(
  decision: Extract<RunStateDecision, { kind: "resume_pending" }>,
): string[] {
  const policy = decision.stageInput.record.executionPolicy;
  if (policy.executionShape !== "sequential" || policy.effectTarget !== "production") {
    throw new TypeError("固定V1直列復旧で分割runの効果を実行できません");
  }
  const arguments_ = [
    "run-sequential",
    "--config",
    "config.yml",
    "--notification-action",
    policy.notificationAction,
    "--scheduled-for",
    decision.stageInput.record.runIdentity.scheduledFor,
    "--report",
    `artifacts/run-reports/recovery-${decision.stageInput.record.runIdentity.runId.slice("tracker-run:".length)}.json`,
  ];
  if (policy.kind === "backfill") {
    arguments_.push("--mode", policy.backfillRange.kind);
    for (const repository of policy.backfillRange.repositories) {
      arguments_.push("--repository", repository);
    }
  }
  return arguments_;
}

async function restoreDurableReceipts(
  repositoryPath: string,
  input: RuntimeRecoveryInputV1,
  decision: Extract<RunStateDecision, { kind: "resume_pending" }>,
): Promise<void> {
  const adapters = exactAdapters(input.runId, undefined);
  const saved = await readSequentialReceipts(
    repositoryPath,
    input.runId,
    adapters.readArtifactBytes,
  );
  if (saved.length !== 0 || decision.stageInput.marker.phase === "initial_state_committed") {
    return;
  }
  const config = await adapters.loadConfig(resolve(repositoryPath, "config.yml"));
  if (config.state.branch !== input.stateRef) {
    throw new TypeError("固定V1復旧のstate refと設定が一致しません");
  }
  const restored = await restoreSplitReceipts(
    adapters,
    splitStagePaths(repositoryPath, input.runId),
    input.runId,
    "config.yml",
    {
      adapter: adapters.createStateBranchAdapter(),
      configuration: config.state,
      headRevision: input.exactStateRevision,
      initialStateRevision: decision.stageInput.initialStateRevision,
    },
  );
  verifyReceiptChain(restored, nodeContentDigestPort);
  await adapters.writeJsonArtifact(
    sequentialReceiptPath(repositoryPath, input.runId),
    receiptChainEnvelopeSchema.parse({
      schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION,
      entries: restored,
    }),
  );
}

/** 固定V1入力だけからexact runtimeの直列pending effectを実行する。 */
export async function resumeExactSequentialRunV1(
  repositoryPath: string,
  input: RuntimeRecoveryInputV1,
  decision: Extract<RunStateDecision, { kind: "resume_pending" }>,
): Promise<RuntimeRecoveryOutputV1> {
  const arguments_ = sequentialArguments(decision);
  await restoreDurableReceipts(repositoryPath, input, decision);
  const recorder = await createDiagnosticsRecorder({
    path: resolve(repositoryPath, "artifacts/workflow/runtime-recovery-diagnostics.jsonl"),
  });
  try {
    const result = await createProductionCliApplication(exactAdapters(input.runId, recorder)).run(
      arguments_,
      input.invocationId,
    );
    if (
      result.command !== "run-sequential" ||
      result.exitCode !== 0 ||
      result.result.completedRun == null
    ) {
      return {
        protocolVersion: 1,
        outputContract: "tracking-run-recovery-output-v1",
        status: "manual_resolution_required",
        reason: "effect_uncertain",
      };
    }
    const adapters = createDefaultProductionRuntimeAdapters();
    const config = await adapters.loadConfig(resolve(repositoryPath, "config.yml"));
    const head = await adapters.createStateBranchAdapter().resolveHead(input.stateRef);
    if (head.status !== "present") {
      throw new TypeError("固定V1復旧後のstate headがありません");
    }
    const entries = await readSequentialReceipts(
      repositoryPath,
      input.runId,
      adapters.readArtifactBytes,
    );
    const inspected = await inspectRunState(adapters.createStateBranchAdapter(), config.state, {
      kind: "resume_run",
      runtime: "exact",
      runId: input.runId,
      exactStateRevision: head.revision,
      expectedRecordDigest: input.expectedRecordDigest,
      expectedRuntimeIdentityDigest: input.expectedRuntimeIdentityDigest,
      expectedWorkflowEffectAdapterIdentityDigest:
        input.expectedWorkflowEffectAdapterIdentityDigest,
      runtimeRecoveryPlan: input.runtimeRecoveryPlan,
      observation: { invocationId: input.invocationId, observedAt: new Date().toISOString() },
      receipts: entries,
    });
    if (
      inspected.kind !== "resume_pending" ||
      inspected.stageInput.stage !== "completed" ||
      serializeCanonicalJson(inspected.stageInput.record.executionPolicy) !==
        serializeCanonicalJson(decision.stageInput.record.executionPolicy)
    ) {
      throw new TypeError("固定V1復旧後のstateとreceiptが完了条件を満たしません");
    }
    return {
      protocolVersion: 1,
      outputContract: "tracking-run-recovery-output-v1",
      status: "completed",
      stateRevision: head.revision,
    };
  } finally {
    await recorder.close();
  }
}

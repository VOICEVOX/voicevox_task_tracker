import { resolve } from "node:path";

import {
  runtimeRecoveryInputV1Schema,
  runtimeRecoveryOutputV1Schema,
  type RuntimeRecoveryOutputV1,
} from "../application/tracking-run/contracts/runtime-recovery-v1.js";
import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { loadConfig } from "../config/index.js";
import {
  inspectRunState,
  type RunStateDecision,
} from "../infrastructure/tracking-run/inspect-run-state.js";
import { GitStateBranchAdapter } from "../persistence/index.js";

import { assertRecoveryRuntime } from "../infrastructure/tracking-run/runtime-recovery-launcher-v1.js";
const MAX_PROTOCOL_BYTES = 1024 * 1024;
function recoveryDecisionOutput(decision: RunStateDecision): RuntimeRecoveryOutputV1 {
  if (decision.kind === "resume_pending") {
    if (decision.stageInput.stage === "completed") {
      return runtimeRecoveryOutputV1Schema.parse({
        protocolVersion: 1,
        outputContract: "tracking-run-recovery-output-v1",
        status: "completed",
        stateRevision: decision.stageInput.exactStateRevision,
      });
    }
    return runtimeRecoveryOutputV1Schema.parse({
      protocolVersion: 1,
      outputContract: "tracking-run-recovery-output-v1",
      status: "ready",
      stateRevision: decision.stageInput.exactStateRevision,
      nextStage: decision.stageInput.stage,
    });
  }
  return runtimeRecoveryOutputV1Schema.parse({
    protocolVersion: 1,
    outputContract: "tracking-run-recovery-output-v1",
    status: "manual_resolution_required",
    reason:
      decision.kind === "operator_conflict_resolution" ? "state_conflict" : "effect_uncertain",
  });
}

/** exact runtime内の固定V1入力を受理し、効果実行前に識別を照合する。 */
export async function runRuntimeRecoveryEntrypointV1(
  repositoryPath: string,
  bundleRoot: string,
): Promise<void> {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += String(chunk);
    if (Buffer.byteLength(source, "utf8") > MAX_PROTOCOL_BYTES) {
      throw new TypeError("V1回復入力が許容するbyte数を超えています");
    }
  }
  const value: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(value)) {
    throw new TypeError("V1回復入力がcanonical JSONではありません");
  }
  const input = runtimeRecoveryInputV1Schema.parse(value);
  await assertRecoveryRuntime(repositoryPath, bundleRoot, input);
  const config = await loadConfig(resolve(repositoryPath, "config.yml"));
  const adapter = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const decision = await inspectRunState(
    adapter,
    { ...config.state, branch: input.stateRef },
    {
      kind: "resume_run",
      runtime: "exact",
      runId: input.runId,
      exactStateRevision: input.exactStateRevision,
      expectedRecordDigest: input.expectedRecordDigest,
      expectedRuntimeIdentityDigest: input.expectedRuntimeIdentityDigest,
      expectedWorkflowEffectAdapterIdentityDigest:
        input.expectedWorkflowEffectAdapterIdentityDigest,
      runtimeRecoveryPlan: input.runtimeRecoveryPlan,
      observation: { invocationId: input.invocationId, observedAt: new Date().toISOString() },
      receipts: [],
    },
  );
  const output =
    decision.kind === "resume_pending" &&
    decision.stageInput.record.executionPolicy.executionShape === "sequential"
      ? await (
          await import("./runtime-recovery-sequential-v1.js")
        ).resumeExactSequentialRunV1(repositoryPath, input, decision)
      : recoveryDecisionOutput(decision);
  process.stdout.write(serializeCanonicalJsonLine(output));
}

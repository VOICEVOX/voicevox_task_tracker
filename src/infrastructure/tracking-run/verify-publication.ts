import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createPublicFailureArtifact,
  failedRunSchema,
} from "../../application/tracking-run/failure-artifact.js";
import { receiptChainEnvelopeSchema } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { assertValidStateBranch } from "../../persistence/branch-adapter.js";
import { createRuntimeRecoveryInputV1, inspectRunBootstrapState } from "./bootstrap-state.js";
import type {
  InspectRunStateCliCommand,
  ReportFailureCliCommand,
  VerifyCheckpointCliCommand,
  VerifyReceiptChainCliCommand,
  VerifyRuntimeRecoveryCliCommand,
} from "./command-input.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { writeCliJsonArtifact } from "./file-output.js";
import { verifyWorkflowCheckpoint } from "./publication/workflow-stage-handlers.js";
import { verifyAcquiredRuntimeV1 } from "./runtime-recovery-acquisition.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";

/** v23 checkpointの実fileとexact baseへの結合を検証する。 */
export async function verifyCheckpointCommand(
  adapters: ProductionRuntimeAdapters,
  command: VerifyCheckpointCliCommand,
): Promise<void> {
  await verifyWorkflowCheckpoint({ adapters }, command);
  await adapters.writeStandardOutput("checkpointの検証に成功しました\n");
}

/** 固定V1入力でexact runtimeの回復protocolを検証する。 */
export async function verifyRuntimeRecoveryCommand(
  adapters: ProductionRuntimeAdapters,
  command: VerifyRuntimeRecoveryCliCommand,
): Promise<void> {
  const source = await readFile(resolve(adapters.repositoryPath, command.inputPath), "utf8");
  const value: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(value)) {
    throw new TypeError("V1回復入力がcanonical JSONではありません");
  }
  await verifyAcquiredRuntimeV1(
    adapters.repositoryPath,
    command.bundleRoot == null ? undefined : resolve(adapters.repositoryPath, command.bundleRoot),
    value,
  );
  await adapters.writeStandardOutput("固定V1 runtimeの検証に成功しました\n");
}

/** state refのbootstrapから起動runtimeと固定回復入力を判定する。 */
export async function inspectRunStateCommand(
  adapters: ProductionRuntimeAdapters,
  command: InspectRunStateCliCommand,
): Promise<void> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const stateRef = command.stateRef ?? config.state.branch;
  assertValidStateBranch(stateRef);
  const decision = await inspectRunBootstrapState(
    adapters.createStateBranchAdapter(),
    stateRef,
    command.recoveryIntent,
  );
  if (decision.kind === "resume_with_exact_runtime") {
    if (decision.record.recordSchemaVersion === 2 || decision.record.recordSchemaVersion === 3) {
      const plan = decision.record.runtimeRecoveryPlan;
      if (plan.kind !== "workflow_bundle" || plan.schemaVersion !== 2) {
        throw new TypeError("V2 bootstrapの回復計画が不正です");
      }
      await adapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          kind: decision.kind,
          recoveryInput: {
            protocolVersion: 2,
            exactStateRevision: decision.observedStateHead.revision,
            runId: decision.record.runId,
            checkpointDigest: decision.record.checkpointDigest,
            checkpointFileDigest: decision.record.checkpointFileDigest,
            expectedRecordDigest: decision.record.recordDigest,
            expectedRuntimeIdentityDigest: decision.record.runtimeIdentityDigest,
            runtimeRecoveryPlan: plan,
            expectedWorkflowEffectAdapterIdentityDigest:
              plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
          },
        }),
      );
      return;
    }
    await adapters.writeStandardOutput(
      serializeCanonicalJsonLine({
        kind: decision.kind,
        recoveryInput: createRuntimeRecoveryInputV1(decision, stateRef, randomUUID()),
      }),
    );
    return;
  }
  if (decision.kind === "manual_resolution_required") {
    await adapters.writeStandardOutput(serializeCanonicalJsonLine({ kind: decision.kind }));
    return;
  }
  await adapters.writeStandardOutput(serializeCanonicalJsonLine(decision));
}

/** 保存したreceipt列を実codecと同じ規則で検証する。 */
export async function verifyReceiptChainCommand(
  adapters: ProductionRuntimeAdapters,
  command: VerifyReceiptChainCliCommand,
): Promise<void> {
  const source = await readFile(resolve(adapters.repositoryPath, command.inputPath), "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("receipt chainがcanonical JSONではありません");
  }
  const input = receiptChainEnvelopeSchema.parse(raw);
  const verified = verifyReceiptChain(input.entries, nodeContentDigestPort);
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({
      lastReceiptDigest: verified.proof.lastReceiptDigest,
      completedPhaseSequence: verified.proof.completedPhaseSequence,
    }),
  );
}

/** 記録済み失敗runから公開可能fieldだけのartifactを出力する。 */
export async function reportFailureCommand(
  adapters: ProductionRuntimeAdapters,
  command: ReportFailureCliCommand,
): Promise<void> {
  const source = await readFile(resolve(adapters.repositoryPath, command.inputPath), "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("失敗runがcanonical JSONではありません");
  }
  const failure = failedRunSchema.parse(raw);
  const artifact = createPublicFailureArtifact(failure, nodeContentDigestPort);
  await writeCliJsonArtifact(resolve(adapters.repositoryPath, command.outputPath), artifact);
  await adapters.writeStandardOutput(
    serializeCanonicalJsonLine({ failureArtifactDigest: artifact.failureArtifactDigest }),
  );
}

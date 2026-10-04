import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  runtimeRecoveryInputV2Schema,
  workflowEffectObservationV2Schema,
} from "../../application/tracking-run/contracts/runtime-recovery-v2.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION } from "../../publication/durable-record-schema.js";
import { assertNonNullable } from "../../util/index.js";
import { inspectRunBootstrapState } from "./bootstrap-state.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { inspectRunState } from "./inspect-run-state.js";
import { recoverSplitRuntimeV2 } from "./runtime-recovery-acquisition.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { RecoverRuntimeV2CliCommand } from "./split-command-input.js";
import { splitStagePaths } from "./split-stage-paths.js";
import { readSplitReceiptChain } from "./split-stage-receipts.js";

/** 永続bootstrapだけからV2入力を作り、exact bundleの固定入口で一段進める。 */
export async function recoverSplitStageRuntime(
  adapters: ProductionRuntimeAdapters,
  command: RecoverRuntimeV2CliCommand,
  invocationId: string,
): Promise<void> {
  if (
    command.manualResolutionReceiptPath != null &&
    resolve(adapters.repositoryPath, command.manualResolutionReceiptPath) !==
      splitStagePaths(adapters.repositoryPath, command.runId).manualResolutionReceipt
  ) {
    throw new TypeError("V2手動解決receiptはrun別の固定pathが必要です");
  }
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  if (config.state.branch !== command.stateRef) {
    throw new TypeError("V2回復のstate refと設定が一致しません");
  }
  const adapter = adapters.createStateBranchAdapter();
  const head = await adapter.resolveHead(command.stateRef);
  if (head.status !== "present") {
    throw new TypeError("V2回復のexact stateがありません");
  }
  const bootstrap = await inspectRunBootstrapState(adapter, command.stateRef, {
    kind: "retry_run",
    runId: command.runId,
    exactStateRevision: head.revision,
  });
  if (
    bootstrap.kind !== "resume_with_exact_runtime" ||
    bootstrap.record.recordSchemaVersion !== DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION ||
    bootstrap.record.runtimeRecoveryPlan.schemaVersion !== 2 ||
    bootstrap.record.runtimeRecoveryPlan.kind !== "workflow_bundle"
  ) {
    throw new TypeError("V2固定入口を持つ未完了runを選べません");
  }
  const plan = bootstrap.record.runtimeRecoveryPlan;
  let observation: unknown;
  if (command.operation === "record_pages") {
    assertNonNullable(command.observationPath, "V2 Pages観測fileがありません");
    const source = await readFile(
      resolve(adapters.repositoryPath, command.observationPath),
      "utf8",
    );
    const raw: unknown = JSON.parse(source);
    if (source !== serializeCanonicalJsonLine(raw)) {
      throw new TypeError("V2 Pages観測fileがcanonical JSONではありません");
    }
    const parsedObservation = workflowEffectObservationV2Schema.parse(raw);
    if (parsedObservation.phase !== command.phase) {
      throw new TypeError("V2 Pages観測fileと指定phaseが一致しません");
    }
    observation = parsedObservation;
  }
  const input = runtimeRecoveryInputV2Schema.parse({
    protocolVersion: 2,
    inputContract: "tracking-run-recovery-input-v2",
    operation: command.operation,
    invocationId,
    configPath: command.configPath,
    stateRef: command.stateRef,
    exactStateRevision: head.revision,
    runId: command.runId,
    runAttempt: command.runAttempt,
    expectedRecordDigest: bootstrap.record.recordDigest,
    expectedRuntimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
    expectedWorkflowEffectAdapterIdentityDigest:
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: plan,
    ...(command.operation === "execute_stage"
      ? {
          stage: command.stage,
          ...(command.manualResolutionReceiptPath == null
            ? {}
            : { manualResolutionReceiptPath: command.manualResolutionReceiptPath }),
        }
      : {}),
    ...(command.operation === "record_pages" ? { observation } : {}),
  });
  const output = await recoverSplitRuntimeV2(
    adapters.repositoryPath,
    command.bundleRoot == null ? undefined : resolve(adapters.repositoryPath, command.bundleRoot),
    input,
  );
  const entries = await readSplitReceiptChain(
    splitStagePaths(adapters.repositoryPath, command.runId).receiptChain,
    command.runId,
  );
  if (
    output.runId !== command.runId ||
    output.workflowEffectAdapterIdentityDigest !==
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest ||
    output.receiptChainDigest !== digest.sha256Utf8(serializeCanonicalJson(entries))
  ) {
    throw new TypeError("V2固定入口の結果とreceipt chainが一致しません");
  }
  const state = await inspectRunBootstrapState(adapter, command.stateRef, {
    kind: "retry_run",
    runId: command.runId,
    exactStateRevision: output.stateRevision,
  });
  if (
    state.kind !== "resume_with_exact_runtime" ||
    state.record.recordDigest !== bootstrap.record.recordDigest
  ) {
    throw new TypeError("V2固定入口の結果と永続recordが一致しません");
  }
  const verified = await inspectRunState(adapter, config.state, {
    kind: "resume_run",
    runtime: "exact",
    runId: command.runId,
    exactStateRevision: output.stateRevision,
    expectedRecordDigest: bootstrap.record.recordDigest,
    expectedRuntimeIdentityDigest: bootstrap.record.runtimeIdentityDigest,
    expectedWorkflowEffectAdapterIdentityDigest:
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: plan,
    observation: { invocationId, observedAt: adapters.now().toISOString() },
    receipts: entries,
  });
  if (verified.kind !== "resume_pending") {
    throw new TypeError("V2固定入口のreceiptとexact stateを検証できません");
  }
  await adapters.writeStandardOutput(serializeCanonicalJsonLine(output));
}

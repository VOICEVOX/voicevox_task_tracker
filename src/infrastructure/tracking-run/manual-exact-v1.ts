import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { RuntimeRecoveryInputV1 } from "../../application/tracking-run/contracts/runtime-recovery-v1.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { loadConfig } from "../../config/index.js";
import { GitStateBranchAdapter } from "../../persistence/git-state-branch-adapter.js";
import { readActiveProductionPagesEffectLease } from "../../persistence/production-pages-effect-lease.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import type { ResolveDiscordDeliveryCliCommand } from "./command-input.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { writeCliTextFile } from "./file-output.js";
import { verifyManualResolutionReceipt } from "./manual-resolution.js";
import { startedManualResolutionAttempt } from "./manual-resolution-state.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { classifyNotificationRecovery } from "./notification-recovery.js";
import { observeInitialPagesFromState } from "./publication-resume-inputs.js";
import { verifyRuntimeRecoveryV1 } from "./runtime-recovery-launcher-v1.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

type ManualSelection = Readonly<{
  sourceRunId: string;
  runId: string;
  checkpointDigest: string;
  checkpointFileDigest: string;
  runtimeIdentityDigest: string;
  codeRevision: string;
  stateRevision: string;
}>;

function stateAdapter(checkout: string): GitStateBranchAdapter {
  return new GitStateBranchAdapter({
    repositoryPath: checkout,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
}

async function assertSelectedState(
  checkout: string,
  selected: RuntimeRecoveryInputV1,
  sourceRunId: string,
): Promise<{
  adapter: GitStateBranchAdapter;
  configuration: Awaited<ReturnType<typeof loadConfig>>["state"];
  state: Awaited<ReturnType<typeof readNotificationMessageState>>;
}> {
  const config = await loadConfig(resolve(checkout, "config.yml"));
  if (config.state.branch !== selected.stateRef || config.state.branch !== "tracker-state") {
    throw new TypeError("V1手動解決のstate refと固定設定が一致しません");
  }
  const adapter = stateAdapter(checkout);
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status !== "present" || head.revision !== selected.exactStateRevision) {
    throw new TypeError("V1手動解決のexact state revisionが変わりました");
  }
  const state = await readNotificationMessageState(adapter, config.state, head.revision);
  const { record, marker, initialPagesEvidence } = state.transaction;
  const plan = selected.runtimeRecoveryPlan;
  if (plan.kind !== "rebuild_exact") {
    throw new TypeError("V1手動解決には固定sourceの再構築計画が必要です");
  }
  assertNonNullable(initialPagesEvidence, "V1手動解決の初回Pages証拠がありません");
  const lease = await readActiveProductionPagesEffectLease(adapter);
  if (
    marker.phase !== "notifications_in_progress" ||
    marker.runId !== selected.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    record.recordDigest !== selected.expectedRecordDigest ||
    record.runIdentity.runId !== selected.runId ||
    digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) !==
      selected.expectedRuntimeIdentityDigest ||
    serializeCanonicalJson(record.runtimeRecoveryPlan) !== serializeCanonicalJson(plan) ||
    record.executionPolicy.effectTarget !== "production" ||
    record.executionPolicy.executionShape !== "sequential" ||
    state.snapshot.run.id !== selected.runId ||
    initialPagesEvidence.externalReference.adapterIdentityDigest !==
      selected.expectedWorkflowEffectAdapterIdentityDigest ||
    lease.runId !== selected.runId ||
    lease.checkpointDigest !== record.checkpointDigest ||
    lease.parentRunId !== sourceRunId ||
    lease.codeRevision !== plan.codeRevision ||
    lease.effect.phase !== "initial" ||
    !("child" in lease.attempt) ||
    lease.attempt.child == null ||
    lease.effect.sourceStateRevision !== marker.initialStateRevision ||
    lease.effect.sourceStateRevision !== initialPagesEvidence.sourceStateRevision ||
    lease.effect.deploymentIntentDigest !== initialPagesEvidence.deploymentIntentDigest
  ) {
    throw new TypeError("V1手動解決のruntime、Pages leaseまたは同じrunのstateが一致しません");
  }
  return { adapter, configuration: config.state, state };
}

/** 固定V1 sourceとleaseが同じ保留runを指すことを選択前に検証する。 */
export async function selectManualRuntimeV1(
  checkout: string,
  selected: RuntimeRecoveryInputV1,
  expected: ManualSelection,
): Promise<void> {
  const plan = selected.runtimeRecoveryPlan;
  if (
    plan.kind !== "rebuild_exact" ||
    selected.runId !== expected.runId ||
    selected.exactStateRevision !== expected.stateRevision ||
    selected.expectedRuntimeIdentityDigest !== expected.runtimeIdentityDigest ||
    plan.codeRevision !== expected.codeRevision
  ) {
    throw new TypeError("V1手動解決の固定runtime選択が指定したrunと一致しません");
  }
  await verifyRuntimeRecoveryV1(checkout, resolve(checkout, "dist"), selected);
  const { state } = await assertSelectedState(checkout, selected, expected.sourceRunId);
  if (
    state.transaction.record.checkpointDigest !== expected.checkpointDigest ||
    state.transaction.record.checkpointFileDigest !== expected.checkpointFileDigest
  ) {
    throw new TypeError("V1手動解決のcheckpoint結合が一致しません");
  }
  await writeCliTextFile(
    "artifacts/workflow/manual-recovery-input.json",
    serializeCanonicalJsonLine(selected),
  );
}

/** 選択済みV1 runtimeへ一つの手動判断を渡し、Git stateとreceiptを再観測する。 */
export async function resolveSelectedManualRuntimeV1(
  checkout: string,
  selected: RuntimeRecoveryInputV1,
  sourceRunId: string,
  command: ResolveDiscordDeliveryCliCommand,
  execute: (entrypoint: string, args: readonly string[]) => Promise<void>,
): Promise<void> {
  const plan = selected.runtimeRecoveryPlan;
  if (
    plan.kind !== "rebuild_exact" ||
    selected.runId !== command.runId ||
    command.configPath !== "config.yml" ||
    resolve(checkout, command.receiptPath) !==
      resolve(checkout, "artifacts/workflow/manual-resolution-receipt.json")
  ) {
    throw new TypeError("V1手動解決の選択入力と判断対象が一致しません");
  }
  await verifyRuntimeRecoveryV1(checkout, resolve(checkout, "dist"), selected);
  const { adapter, configuration, state } = await assertSelectedState(
    checkout,
    selected,
    sourceRunId,
  );
  const { marker, record, initialPagesEvidence } = state.transaction;
  if (marker.phase !== "notifications_in_progress") {
    throw new TypeError("V1手動解決の通知phaseが不正です");
  }
  if (record.checkpointDigest !== command.checkpointDigest || initialPagesEvidence == null) {
    throw new TypeError("V1手動解決のcheckpointまたは初回Pages証拠が一致しません");
  }
  const target = {
    runId: command.runId,
    checkpointDigest: command.checkpointDigest,
    deliveryId: command.deliveryId,
    attemptId: command.attemptId,
    notificationKeys: command.notificationKeys,
    decision: command.resolution,
  };
  const existing = state.ledger.entries.some(
    (entry) =>
      entry.notificationKey === target.notificationKeys[0] &&
      entry.manualResolution?.deliveryId === target.deliveryId &&
      entry.manualResolution.attemptId === target.attemptId,
  );
  if (!existing) {
    startedManualResolutionAttempt(state, target);
    const initial = await observeStateCommitAtRevision(
      adapter,
      configuration,
      marker.initialStateRevision,
      marker.initialStateRevision,
      "initial_state_commit",
      {
        invocationId: randomUUID(),
        observedAt: new Date().toISOString(),
        position: { kind: "first" },
      },
    );
    if (initial.receipt.receiptType !== "initial_state_commit") {
      throw new TypeError("V1手動解決の初回state receiptがありません");
    }
    const pagesReceipt = observeInitialPagesFromState(
      {
        record,
        marker,
        exactStateRevision: state.revision,
        evidence: initialPagesEvidence,
        invocationId: randomUUID(),
        localAttemptIndex: 0,
        phaseSequence: 1,
        previousReceiptDigest: initialPagesEvidence.deploymentReceiptDigest,
        observedAt: new Date().toISOString(),
      },
      digest,
    );
    const recovery = await classifyNotificationRecovery(
      {
        record,
        initialStateReceipt: initial.receipt,
        pagesReceipt,
        pagesEvidence: initialPagesEvidence,
        casOutcome: "observed",
        httpOutcome: "ambiguous",
      },
      adapter,
      configuration,
    );
    if (
      recovery.recoveryDisposition !== "manual_resolution_required" ||
      recovery.stateRevision !== state.revision
    ) {
      throw new TypeError("V1手動解決の開始済み送達をGit祖先から確認できません");
    }
  }
  await execute(resolve(checkout, "dist", plan.recoveryProtocol.entrypointRelativePath), [
    "resolve-discord-delivery",
    "--run-id",
    command.runId,
    "--checkpoint-digest",
    command.checkpointDigest,
    "--delivery-id",
    command.deliveryId,
    "--attempt-id",
    command.attemptId,
    "--resolution",
    command.resolution,
    ...command.notificationKeys.flatMap((key) => ["--notification-key", key]),
  ]);
  const receiptSource = await readFile(command.receiptPath, "utf8");
  const receiptRaw: unknown = JSON.parse(receiptSource);
  if (receiptSource !== serializeCanonicalJsonLine(receiptRaw)) {
    throw new TypeError("V1手動解決receiptがcanonical JSONではありません");
  }
  const receipt = parseReceipt(receiptRaw, digest);
  const head = await adapter.resolveHead(configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("V1手動解決後のstate headがありません");
  }
  const verified = await verifyManualResolutionReceipt(
    { adapter, configuration, knownSecrets: [], now: () => new Date() },
    receipt,
    head.revision,
  );
  if (
    verified.receipt.binding.bindingKind !== "checkpoint" ||
    verified.receipt.binding.runId !== command.runId ||
    verified.receipt.binding.checkpointDigest !== command.checkpointDigest ||
    verified.receipt.binding.runtimeIdentityDigest !== selected.expectedRuntimeIdentityDigest ||
    verified.receipt.result.deliveryId !== command.deliveryId ||
    verified.receipt.result.deliveryAttemptId !== command.attemptId ||
    verified.receipt.result.decision !== command.resolution ||
    serializeCanonicalJson(verified.receipt.result.notificationKeys) !==
      serializeCanonicalJson(command.notificationKeys)
  ) {
    throw new TypeError("V1手動判断の結果と同じrunのreceiptが一致しません");
  }
}

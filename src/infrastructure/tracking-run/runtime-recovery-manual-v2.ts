import { resolve } from "node:path";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";

import type { RuntimeRecoveryInputV2 } from "../../application/tracking-run/contracts/runtime-recovery-v2.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { StateBranchAdapter } from "../../persistence/branch-adapter.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { writeCliJsonArtifact } from "./file-output.js";
import { startedManualResolutionAttempt } from "./manual-resolution-state.js";
import { resolveManualNotificationDelivery } from "./manual-resolution.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { classifyNotificationRecovery } from "./notification-recovery.js";
import { splitStagePaths } from "./split-stage-paths.js";
import { restoreSplitReceipts } from "./split-stage-recovery.js";

type ManualInput = Extract<RuntimeRecoveryInputV2, { operation: "resolve_manual_delivery" }>;

/** exact stateとreceiptを照合し、開始済みの一送達だけを同じrunで解決する。 */
export async function resolveExactManualDeliveryV2(
  repositoryPath: string,
  input: ManualInput,
  adapter: StateBranchAdapter,
  adapters: ProductionRuntimeAdapters,
): Promise<
  Readonly<{
    stateRevision: string;
    receiptChainDigest: string;
    manualResolutionReceiptDigest: string;
    receiptKind: "executed" | "observed";
  }>
> {
  const config = await adapters.loadConfig(resolve(repositoryPath, input.configPath));
  if (config.state.branch !== input.stateRef) {
    throw new TypeError("V2手動解決のstate設定が固定入力と一致しません");
  }
  const state = await readNotificationMessageState(adapter, config.state, input.exactStateRevision);
  const { marker, record, initialPagesEvidence } = state.transaction;
  if (
    marker.phase !== "notifications_in_progress" ||
    marker.runId !== input.runId ||
    marker.checkpointDigest !== input.target.checkpointDigest ||
    record.recordDigest !== input.expectedRecordDigest ||
    record.runIdentity.runId !== input.runId ||
    record.checkpointDigest !== input.target.checkpointDigest ||
    digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) !==
      input.expectedRuntimeIdentityDigest ||
    serializeCanonicalJson(record.runtimeRecoveryPlan) !==
      serializeCanonicalJson(input.runtimeRecoveryPlan) ||
    state.snapshot.run.id !== input.runId ||
    initialPagesEvidence == null
  ) {
    throw new TypeError("V2手動解決のrecord、marker、snapshotまたはPages証拠が一致しません");
  }
  if (new Set(input.target.notificationKeys).size !== input.target.notificationKeys.length) {
    throw new TypeError("V2手動解決のnotification keyが重複しています");
  }
  const target = {
    runId: input.runId,
    checkpointDigest: input.target.checkpointDigest,
    deliveryId: input.target.deliveryId,
    attemptId: input.target.attemptId,
    notificationKeys: input.target.notificationKeys,
    decision: input.target.decision,
  };
  const paths = splitStagePaths(repositoryPath, input.runId);
  const entries = await restoreSplitReceipts(adapters, paths, input.runId, input.configPath, {
    adapter,
    configuration: config.state,
    headRevision: input.exactStateRevision,
    initialStateRevision: marker.initialStateRevision,
  });
  const initialReceipt = entries[0]?.receipt;
  const pagesReceipt = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
  )?.receipt;
  if (
    initialReceipt?.receiptType !== "initial_state_commit" ||
    pagesReceipt?.receiptType !== "pages_deployment" ||
    pagesReceipt.phase !== "initial"
  ) {
    throw new TypeError("V2手動解決の初回stateまたはPages receiptがありません");
  }
  const port = {
    adapter,
    configuration: config.state,
    knownSecrets: [],
    now: adapters.now,
  };
  const existing = state.ledger.entries.some(
    (entry) =>
      entry.notificationKey === target.notificationKeys[0] &&
      entry.manualResolution?.deliveryId === target.deliveryId &&
      entry.manualResolution.attemptId === target.attemptId,
  );
  if (!existing) {
    startedManualResolutionAttempt(state, target);
    const decision = await classifyNotificationRecovery(
      {
        record,
        initialStateReceipt: initialReceipt,
        pagesReceipt,
        pagesEvidence: initialPagesEvidence,
        casOutcome: "observed",
        httpOutcome: "ambiguous",
      },
      adapter,
      config.state,
    );
    if (decision.recoveryDisposition !== "manual_resolution_required") {
      throw new TypeError("V2手動解決のGit祖先と開始済み送達を検証できません");
    }
  }
  const resolved = await resolveManualNotificationDelivery(port, target);
  const completedEntries = await restoreSplitReceipts(
    adapters,
    paths,
    input.runId,
    input.configPath,
    {
      adapter,
      configuration: config.state,
      headRevision: resolved.stateRevision,
      initialStateRevision: marker.initialStateRevision,
    },
  );
  const linked = completedEntries.find(
    (entry) =>
      entry.receipt.receiptType === "manual_resolution" &&
      entry.receipt.operationId === resolved.receipt.operationId &&
      entry.receipt.result.resultingStateRevision === resolved.stateRevision,
  )?.receipt;
  if (
    linked?.receiptType !== "manual_resolution" ||
    (linked.receiptKind !== "executed" && linked.receiptKind !== "observed") ||
    serializeCanonicalJson(linked.result) !== serializeCanonicalJson(resolved.receipt.result)
  ) {
    throw new TypeError("V2手動解決receiptが復元した通知履歴と一致しません");
  }
  const decision = await classifyNotificationRecovery(
    {
      record,
      initialStateReceipt: initialReceipt,
      pagesReceipt,
      pagesEvidence: initialPagesEvidence,
      lastVerifiedReceipt: linked,
      casOutcome: "observed",
      httpOutcome: "ambiguous",
    },
    adapter,
    config.state,
  );
  if (decision.recoveryDisposition !== "resume_from_receipt") {
    throw new TypeError("V2手動解決後のGit祖先とreceiptを検証できません");
  }
  await writeCliJsonArtifact(paths.manualResolutionReceipt, linked);
  return {
    stateRevision: resolved.stateRevision,
    receiptChainDigest: digest.sha256Utf8(serializeCanonicalJson(completedEntries)),
    manualResolutionReceiptDigest: linked.receiptDigest,
    receiptKind: linked.receiptKind,
  };
}

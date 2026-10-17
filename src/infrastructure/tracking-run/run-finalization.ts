import type {
  FinalizeRunInput,
  FinalizeRunPort,
  FinalizeRunOutcome,
} from "./run-finalization-contracts.js";
import { randomUUID } from "node:crypto";

import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { createReceipt, parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { StateRunReport } from "../../persistence/state-run-report.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import type {} from "../../application/tracking-run/receipt-schema.js";
import { hashCanonicalJson } from "../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  joinStatePath,
  type StateBranchCommitInspection,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import { isOrthogonalStateCommitScope } from "../../persistence/state-commit-metadata.js";
import {
  createStateRunReport,
  serializeStateRunReport,
} from "../../persistence/state-run-report.js";
import { parseDurablePublicationRecord } from "../../publication/durable-record-schema.js";
import {
  exactStateValidationOrigin,
  exactStateValidationSession,
} from "../../persistence/exact-state-validation-session.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { verifyInitialStateCommitReceiptAtRevision } from "./initial-pages-source.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { commitRunFinalization } from "./run-finalization-commit.js";
import { assertFinalRunValues } from "./run-finalization-state.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

function validationPort(port: FinalizeRunPort): FinalizeRunPort {
  const session = exactStateValidationSession(
    exactStateValidationOrigin(port.adapter),
    port.configuration,
    port.observePerformanceDetail,
  );
  return Object.freeze({ ...port, adapter: session.adapter });
}

async function settledState(
  input: FinalizeRunInput,
  port: FinalizeRunPort,
): Promise<Readonly<{ state: NotificationMessageState; evidence: ReceiptChainEvidence }>> {
  port = validationPort(port);
  const initial = parseReceipt(input.initialStateReceipt, digest);
  const settlement = parseReceipt(input.settlementReceipt, digest);
  const record = parseDurablePublicationRecord(input.record, digest);
  if (
    initial.receiptType !== "initial_state_commit" ||
    settlement.receiptType !== "notification_settlement" ||
    initial.binding.bindingKind !== "checkpoint" ||
    serializeCanonicalJson(initial.binding) !== serializeCanonicalJson(settlement.binding) ||
    initial.binding.runId !== record.runIdentity.runId ||
    initial.binding.checkpointDigest !== record.checkpointDigest ||
    initial.binding.checkpointFileDigest !== record.checkpointFileDigest ||
    settlement.result.action !== record.notificationOutbox.action ||
    settlement.previousReceiptDigest == null
  ) {
    throw new TypeError("run finalizationのreceiptとdurable recordが一致しません");
  }
  await verifyInitialStateCommitReceiptAtRevision(
    port.adapter,
    port.configuration,
    initial,
    port.now().toISOString(),
    port.observePerformanceDetail,
  );
  const observed = await observeStateCommitAtRevision(
    port.adapter,
    port.configuration,
    settlement.result.resultingStateRevision,
    initial.result.resultingStateRevision,
    "notification_settlement",
    {
      invocationId: randomUUID(),
      observedAt: port.now().toISOString(),
      position: {
        kind: "after",
        previousReceiptDigest: settlement.previousReceiptDigest,
        previousPhaseSequence: settlement.phaseSequence - 1,
      },
    },
    port.observePerformanceDetail,
  );
  if (
    observed.receipt.receiptType !== "notification_settlement" ||
    serializeCanonicalJson(settlement.result) !== serializeCanonicalJson(observed.receipt.result) ||
    serializeCanonicalJson(settlement.binding) !==
      serializeCanonicalJson(observed.receipt.binding) ||
    settlement.operationId !== observed.receipt.operationId ||
    settlement.expectedStateRevision !== observed.receipt.expectedStateRevision
  ) {
    throw new TypeError("run finalizationのsettlement receiptがexact commitと一致しません");
  }
  const evidence: ReceiptChainEvidence =
    settlement.receiptKind === "observed"
      ? { kind: "state_commit", state: observed.evidence }
      : { kind: "none" };
  verifyReceiptChain([{ receipt: settlement, evidence }], digest);
  const state = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    settlement.result.resultingStateRevision,
  );
  if (
    state.transaction.marker.phase !== "notifications_settled" ||
    state.transaction.record.recordDigest !== record.recordDigest ||
    state.transaction.marker.initialStateRevision !== initial.result.resultingStateRevision ||
    state.transaction.notificationLedgerDigest !== settlement.result.notificationLedgerDigest ||
    state.transaction.initialPagesEvidence?.sourceStateRevision !==
      initial.result.resultingStateRevision ||
    state.snapshot.run.id !== record.runIdentity.runId
  ) {
    throw new TypeError("run finalizationのsettlement stateがreceiptと一致しません");
  }
  port.observePerformanceDetail?.({
    step: "run_finalization_settlement_verified",
    count: state.files.size,
  });
  return { state, evidence };
}

async function finalizationRevision(
  input: FinalizeRunInput,
  port: FinalizeRunPort,
  headRevision: string,
): Promise<string> {
  const operationId = stateCommitReceiptOperationId(
    "run_finalization",
    input.record.runIdentity.runId,
    input.record.checkpointDigest,
    digest,
  );
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await port.adapter.readCommit(revision);
    if (isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      if (commit.parent.status !== "present") {
        throw new TypeError("run finalization後の運用通知commitに親がありません");
      }
      await authorizeAdvanceAfterOrthogonalCommits(
        port.adapter,
        port.configuration,
        commit.parent.revision,
        revision,
      );
      revision = commit.parent.revision;
      continue;
    }
    if (
      commit.metadata.commitScope !== "tracking_run" ||
      commit.metadata.runId !== input.record.runIdentity.runId ||
      commit.metadata.operationId !== operationId
    ) {
      throw new TypeError("run finalizationのGit祖先に対象commitがありません");
    }
    return revision;
  }
  throw new TypeError("run finalizationのGit祖先探索が上限を超えています");
}

function readFinalReport(
  state: NotificationMessageState,
  port: FinalizeRunPort,
  record: DurablePublicationRecord,
): StateRunReport {
  const path = joinStatePath(
    port.configuration.runReportsDirectory,
    `${record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
  );
  const file = state.files.get(path);
  if (file?.status !== "present") {
    throw new TypeError("run finalizationの保存済みreportがありません");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  const report = createStateRunReport(JSON.parse(source));
  if (source !== serializeStateRunReport(report)) {
    throw new TypeError("run finalizationの保存済みreportがcanonical JSONではありません");
  }
  return report;
}

function assertFinalizationManifest(
  commit: StateBranchCommitInspection,
  configuration: StatePersistenceConfiguration,
  record: DurablePublicationRecord,
): void {
  const reportPath = joinStatePath(
    configuration.runReportsDirectory,
    `${record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
  );
  const allowed = new Set([
    configuration.snapshotPath,
    reportPath,
    RUN_TRANSACTION_MARKER_STATE_PATH_V1,
  ]);
  const changed = new Set(commit.changedPathManifest.entries.map((entry) => entry.path));
  if (
    !changed.has(reportPath) ||
    !changed.has(RUN_TRANSACTION_MARKER_STATE_PATH_V1) ||
    commit.changedPathManifest.entries.some(
      (entry) => !allowed.has(entry.path) || entry.kind === "deleted",
    )
  ) {
    throw new TypeError("run finalization commitがreport、snapshot、marker以外を変更しました");
  }
}

async function finalizationReceipt(
  input: FinalizeRunInput,
  port: FinalizeRunPort,
  settled: NotificationMessageState,
  settlementEvidence: ReceiptChainEvidence,
  revision: string,
  invocationId: string,
  executed: boolean,
): Promise<Extract<FinalizeRunOutcome, { kind: "finalized" }>> {
  port = validationPort(port);
  port.observePerformanceDetail?.({ step: "run_finalization_receipt_started" });
  assertFinalizationManifest(
    await port.adapter.readCommit(revision),
    port.configuration,
    input.record,
  );
  const final = await readNotificationMessageState(port.adapter, port.configuration, revision);
  const report = readFinalReport(final, port, input.record);
  assertFinalRunValues(input.record, settled, final, report);
  const observed = await observeStateCommitAtRevision(
    port.adapter,
    port.configuration,
    revision,
    input.initialStateReceipt.result.resultingStateRevision,
    "run_finalization",
    {
      invocationId,
      observedAt: port.now().toISOString(),
      position: {
        kind: "after",
        previousReceiptDigest: input.settlementReceipt.receiptDigest,
        previousPhaseSequence: input.settlementReceipt.phaseSequence,
      },
    },
    port.observePerformanceDetail,
  );
  if (
    observed.receipt.receiptType !== "run_finalization" ||
    observed.evidence.receiptType !== "run_finalization" ||
    observed.receipt.result.runReportDigest !== hashCanonicalJson(report) ||
    observed.receipt.result.expectedTrackingStateRevision !==
      input.settlementReceipt.result.resultingStateRevision
  ) {
    throw new TypeError("run finalizationの観測receiptと最終stateが一致しません");
  }
  const receipt = executed
    ? createReceipt(
        {
          schemaVersion: 1,
          receiptType: "run_finalization",
          stage: "run_finalized",
          phase: "finalization",
          binding: observed.receipt.binding,
          logicalTarget: input.record.checkpointDigest,
          invocationId,
          localAttemptIndex: 0,
          phaseSequence: input.settlementReceipt.phaseSequence + 1,
          previousReceiptDigest: input.settlementReceipt.receiptDigest,
          expectedStateRevision: input.settlementReceipt.result.resultingStateRevision,
          receiptKind: "executed",
          observedAt: observed.receipt.observedAt,
          status: "finalized",
          effectCertainty: "committed",
          result: observed.receipt.result,
        },
        digest,
      )
    : observed.receipt;
  if (receipt.receiptType !== "run_finalization") {
    throw new TypeError("run finalization receiptの型が一致しません");
  }
  const receiptEvidence: ReceiptChainEvidence = executed
    ? { kind: "none" }
    : { kind: "state_commit", state: observed.evidence };
  verifyReceiptChain(
    [
      { receipt: input.settlementReceipt, evidence: settlementEvidence },
      { receipt, evidence: receiptEvidence },
    ],
    digest,
  );
  port.observePerformanceDetail?.({
    step: "run_finalization_receipt_completed",
    count: final.files.size,
  });
  port.observePerformanceDetail?.({ step: "run_finalization_completed" });
  return Object.freeze({
    kind: "finalized",
    receipt,
    receiptEvidence,
    stateRevision: revision,
    report,
  });
}

/** settlement正本からreportと追跡開始時刻を単一CASで確定する。 */
export async function finalizeRun(
  input: FinalizeRunInput,
  port: FinalizeRunPort,
): Promise<FinalizeRunOutcome> {
  port.observePerformanceDetail?.({ step: "run_finalization_started" });
  const { state: settled, evidence } = await settledState(input, port);
  port = validationPort(port);
  const head = await port.adapter.resolveHead(port.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("run finalizationのstate branchがありません");
  }
  const current = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    head.revision,
  );
  port.observePerformanceDetail?.({
    step: "run_finalization_current_tree_verified",
    count: current.files.size,
  });
  if (
    current.transaction.record.recordDigest !== input.record.recordDigest ||
    current.transaction.marker.runId !== input.record.runIdentity.runId
  ) {
    await port.recordDiagnostic(new TypeError("run finalizationのremote stateが別runへ進みました"));
    return { kind: "conflict", observedHeadRevision: head.revision };
  }
  const invocationId = randomUUID();
  if (current.transaction.marker.phase === "run_finalized") {
    const revision = await finalizationRevision(input, port, head.revision);
    return finalizationReceipt(input, port, settled, evidence, revision, invocationId, false);
  }
  if (current.transaction.marker.phase !== "notifications_settled") {
    await port.recordDiagnostic(new TypeError("run finalizationのremote stateがsettlement前です"));
    return { kind: "conflict", observedHeadRevision: head.revision };
  }
  const committed = await commitRunFinalization(input, port, settled, port.now().toISOString());
  if (committed.kind === "conflict") {
    await port.recordDiagnostic(new TypeError("run finalizationのCASとremote stateが競合しました"));
    return committed;
  }
  if (committed.kind === "state_unconfirmed") {
    await port.recordDiagnostic(new TypeError("run finalizationのCASをremoteで確定できません"));
    return { kind: "state_unconfirmed", stateRevision: head.revision };
  }
  return finalizationReceipt(
    input,
    port,
    settled,
    evidence,
    committed.revision,
    invocationId,
    !committed.observed,
  );
}

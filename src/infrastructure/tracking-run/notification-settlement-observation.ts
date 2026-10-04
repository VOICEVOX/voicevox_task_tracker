import { parseInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { createReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  ManualResolutionReceipt,
  NotificationMessageReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { PreparedDiscordDigestMessage } from "../../discord/payload-contracts.js";
import { isOrthogonalStateCommitScope } from "../../persistence/state-commit-metadata.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { assertSettledNotificationContent } from "./notification-settlement-validation.js";
import type {
  NotificationSettlementInput,
  NotificationSettlementOutcome,
  NotificationSettlementPort,
  SettledMessageReceipt,
} from "./notification-settlement-contracts.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

export function assertNextReceipt(
  previous: Receipt,
  current: Receipt,
  expectedRevision: string,
): void {
  if (
    current.previousReceiptDigest !== previous.receiptDigest ||
    current.phaseSequence !== previous.phaseSequence + 1 ||
    current.expectedStateRevision !== expectedRevision
  ) {
    throw new TypeError("通知settlementのreceipt列またはstate revisionが連続していません");
  }
}

export async function settledRevision(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  headRevision: string,
): Promise<string> {
  const operationId = stateCommitReceiptOperationId(
    "notification_settlement",
    input.record.runIdentity.runId,
    input.record.checkpointDigest,
    digest,
  );
  const finalizationOperationId = stateCommitReceiptOperationId(
    "run_finalization",
    input.record.runIdentity.runId,
    input.record.checkpointDigest,
    digest,
  );
  let revision = headRevision;
  let passedFinalization = false;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await port.adapter.readCommit(revision);
    if (isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      if (commit.parent.status !== "present") {
        throw new TypeError("通知settlementの運用通知commitに親がありません");
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
      commit.metadata.runId !== input.record.runIdentity.runId
    ) {
      throw new TypeError("通知settlementのGit祖先に対象commitがありません");
    }
    if (commit.metadata.operationId === finalizationOperationId && !passedFinalization) {
      if (commit.parent.status !== "present") {
        throw new TypeError("run finalization commitに親がありません");
      }
      passedFinalization = true;
      revision = commit.parent.revision;
      continue;
    }
    if (commit.metadata.operationId !== operationId) {
      throw new TypeError("通知settlementのGit祖先に対象commitがありません");
    }
    return revision;
  }
  throw new TypeError("通知settlementのGit祖先探索が上限を超えています");
}

export async function receiptForSettlement(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  revision: string,
  expectedRevision: string,
  previousReceipt: Receipt,
  messageReceipts: readonly SettledMessageReceipt[],
  finalReceipts: readonly (NotificationMessageReceipt | ManualResolutionReceipt)[],
  initial: NotificationMessageState,
  messages: readonly PreparedDiscordDigestMessage[],
  invocationId: string,
  executed: boolean,
): Promise<Extract<NotificationSettlementOutcome, { kind: "settled" }>> {
  const observed = await observeStateCommitAtRevision(
    port.adapter,
    port.configuration,
    revision,
    input.initialStateReceipt.result.resultingStateRevision,
    "notification_settlement",
    {
      invocationId,
      observedAt: port.now().toISOString(),
      position: {
        kind: "after",
        previousReceiptDigest: previousReceipt.receiptDigest,
        previousPhaseSequence: previousReceipt.phaseSequence,
      },
    },
  );
  if (
    observed.receipt.receiptType !== "notification_settlement" ||
    observed.evidence.receiptType !== "notification_settlement"
  ) {
    throw new TypeError("通知settlementの再観測receipt種別が一致しません");
  }
  const receipt = executed
    ? createReceipt(
        {
          schemaVersion: 1,
          receiptType: "notification_settlement",
          stage: "notifications_settled",
          phase: "notification",
          binding: observed.receipt.binding,
          logicalTarget: input.record.checkpointDigest,
          invocationId,
          localAttemptIndex: 0,
          phaseSequence: previousReceipt.phaseSequence + 1,
          previousReceiptDigest: previousReceipt.receiptDigest,
          expectedStateRevision: expectedRevision,
          receiptKind: "executed",
          observedAt: observed.receipt.observedAt,
          status: "settled",
          effectCertainty: "committed",
          result: observed.receipt.result,
        },
        digest,
      )
    : observed.receipt;
  if (receipt.receiptType !== "notification_settlement") {
    throw new TypeError("通知settlement receiptの型が一致しません");
  }
  assertNextReceipt(previousReceipt, receipt, expectedRevision);
  const evidence: ReceiptChainEvidence = executed
    ? { kind: "none" }
    : { kind: "state_commit", state: observed.evidence };
  verifyReceiptChain([...messageReceipts, { receipt, evidence }], digest);
  const state = await readNotificationMessageState(port.adapter, port.configuration, revision);
  const pagesEvidence = parseInitialPagesPublicationEvidence(input.initialPages.evidence, digest);
  const content = assertSettledNotificationContent(
    input.record,
    initial,
    state,
    messages,
    finalReceipts,
    port.configuration,
  );
  if (
    state.transaction.marker.phase !== "notifications_settled" ||
    receipt.result.notificationLedgerDigest !== content.ledgerDigest ||
    receipt.result.notificationHistoryDigest !== content.historyDigest ||
    receipt.result.action !== input.record.notificationOutbox.action ||
    state.transaction.initialPagesEvidence?.evidenceDigest !== pagesEvidence.evidenceDigest
  ) {
    throw new TypeError("通知settlement receiptと最終stateが一致しません");
  }
  return Object.freeze({
    kind: "settled",
    receipt,
    receiptEvidence: evidence,
    messageReceipts: Object.freeze([...messageReceipts]),
    stateRevision: revision,
    notificationCount: content.notificationCount,
  });
}

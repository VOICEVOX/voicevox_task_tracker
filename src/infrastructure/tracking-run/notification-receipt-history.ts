import { randomUUID } from "node:crypto";

import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type {
  InitialStateCommitReceipt,
  ManualResolutionReceipt,
  NotificationMessageReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { PreparedDiscordDigestMessage } from "../../discord/payload-contracts.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "../../persistence/index.js";
import { createStateCommitOperationId } from "../../persistence/state-commit-metadata.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { observeManualResolutionAtRevision } from "./manual-resolution-observation.js";
import { describeNotificationMessage } from "./notification-message-context.js";
import type { NotificationInitialPagesSource } from "./notification-message-contracts.js";
import { observeNotificationMessageDelivery } from "./notification-message-observation.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { assertNextReceipt } from "./notification-settlement-observation.js";
import type { SettledMessageReceipt } from "./notification-settlement-contracts.js";

type HistoryPort = Readonly<{
  adapter: StateBranchAdapter;
  configuration: StatePersistenceConfiguration;
  now: () => Date;
}>;

type PendingMessage = Readonly<{
  index: number;
  reservationRevision: string;
  operationId: string;
  attemptId: string;
  notificationKeys: readonly string[];
  deliveryId: string;
}>;

/** 初回Pages以後のGit祖先から全試行と各messageの最終結果を分けて復元する。 */
export async function restoreNotificationReceiptHistory(
  port: HistoryPort,
  record: DurablePublicationRecord,
  initialReceipt: InitialStateCommitReceipt,
  initialPages: NotificationInitialPagesSource,
  pagesEntry: ReceiptChainEntry & Readonly<{ receipt: PagesDeploymentReceipt }>,
  messages: readonly PreparedDiscordDigestMessage[],
  throughRevision: string,
): Promise<
  Readonly<{
    messageReceipts: readonly SettledMessageReceipt[];
    finalReceipts: readonly (NotificationMessageReceipt | ManualResolutionReceipt)[];
    nextMessageIndex: number;
    previousReceipt: Receipt;
    stateRevision: string;
    unresolvedReceipt?: NotificationMessageReceipt;
  }>
> {
  const initialRevision = initialReceipt.result.resultingStateRevision;
  const commits: {
    revision: string;
    parentRevision: string;
    scope: string;
    operationId: string;
    runId: string | undefined;
  }[] = [];
  let revision = throughRevision;
  for (let count = 0; revision !== initialRevision && count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await port.adapter.readCommit(revision);
    if (commit.parent.status !== "present") {
      throw new TypeError("通知履歴のGit祖先が初回stateへ到達しません");
    }
    commits.push({
      revision,
      parentRevision: commit.parent.revision,
      scope: commit.metadata.commitScope,
      operationId: commit.metadata.operationId,
      runId: commit.metadata.runId,
    });
    revision = commit.parent.revision;
  }
  if (revision !== initialRevision) {
    throw new TypeError("通知履歴のGit祖先探索が上限を超えました");
  }
  commits.reverse();
  const history: SettledMessageReceipt[] = [];
  const finalReceipts: (NotificationMessageReceipt | ManualResolutionReceipt | undefined)[] =
    Array.from({ length: messages.length });
  let previousReceipt: Receipt = pagesEntry.receipt;
  let expectedRevision = initialRevision;
  let nextMessageIndex = 0;
  let pending: PendingMessage | undefined;
  const appendMessage = async (headRevision: string): Promise<NotificationMessageReceipt> => {
    if (pending == null) {
      throw new TypeError("通知履歴に対応する送達予約がありません");
    }
    const observed = await observeNotificationMessageDelivery(
      {
        record,
        initialStateReceipt: initialReceipt,
        initialPages,
        previousReceipt,
        expectedStateRevision: expectedRevision,
        messageIndex: pending.index,
        invocationId: randomUUID(),
        localAttemptIndex: pending.index,
      },
      port.adapter,
      port.configuration,
      headRevision,
      port.now().toISOString(),
    );
    if (observed == null) {
      throw new TypeError("通知履歴の送達試行をGit祖先から復元できません");
    }
    if (
      observed.receipt.result.reservationStateRevision !== pending.reservationRevision ||
      observed.receipt.operationId !== pending.operationId ||
      serializeCanonicalJson(observed.receipt.result.notificationKeys) !==
        serializeCanonicalJson(pending.notificationKeys)
    ) {
      throw new TypeError("通知履歴の送達試行をGit祖先から復元できません");
    }
    assertNextReceipt(previousReceipt, observed.receipt, expectedRevision);
    history.push({
      receipt: observed.receipt,
      evidence: { kind: "notification_message_state", state: observed.evidence },
    });
    previousReceipt = observed.receipt;
    expectedRevision = observed.stateRevision;
    if (observed.receipt.status !== "ambiguous") {
      finalReceipts[pending.index] = observed.receipt;
      nextMessageIndex = pending.index + 1;
    }
    return observed.receipt;
  };
  for (const commit of commits) {
    if (commit.scope === "operations_alert") {
      await authorizeAdvanceAfterOrthogonalCommits(
        port.adapter,
        port.configuration,
        commit.parentRevision,
        commit.revision,
      );
      continue;
    }
    if (commit.runId !== record.runIdentity.runId) {
      throw new TypeError("通知履歴のGit祖先に別runのcommitがあります");
    }
    if (pending != null) {
      const resultOperationId = createStateCommitOperationId({
        kind: "notification_message",
        deliveryOperationId: pending.operationId,
        deliveryAttemptId: pending.attemptId,
        transition: "result",
      });
      if (commit.scope === "tracking_run" && commit.operationId === resultOperationId) {
        const result = await appendMessage(commit.revision);
        if (result.status === "ambiguous") {
          throw new TypeError("通知履歴の結果commitが送達未確定です");
        }
        pending = undefined;
        continue;
      }
      if (commit.scope === "manual_resolution") {
        const ambiguous = await appendMessage(pending.reservationRevision);
        if (ambiguous.status !== "ambiguous") {
          throw new TypeError("通知履歴の手動解決前が曖昧送達ではありません");
        }
        const resolvedState = await readNotificationMessageState(
          port.adapter,
          port.configuration,
          commit.revision,
        );
        const resolution = resolvedState.ledger.entries.find(
          (entry) => entry.notificationKey === pending?.notificationKeys[0],
        )?.manualResolution;
        if (resolution == null) {
          throw new TypeError("通知履歴の手動解決が対象試行と一致しません");
        }
        if (
          resolution.operationId !== commit.operationId ||
          resolution.deliveryId !== pending.deliveryId ||
          resolution.attemptId !== pending.attemptId
        ) {
          throw new TypeError("通知履歴の手動解決が対象試行と一致しません");
        }
        const observed = await observeManualResolutionAtRevision(
          port.adapter,
          port.configuration,
          commit.revision,
          {
            runId: record.runIdentity.runId,
            checkpointDigest: record.checkpointDigest,
            deliveryId: pending.deliveryId,
            attemptId: pending.attemptId,
            notificationKeys: pending.notificationKeys,
            decision: resolution.decision,
          },
          {
            invocationId: randomUUID(),
            observedAt: port.now().toISOString(),
            receiptKind: "observed",
            previousReceipt,
          },
        );
        assertNextReceipt(previousReceipt, observed.receipt, expectedRevision);
        history.push({
          receipt: observed.receipt,
          evidence: { kind: "manual_resolution_state", state: observed.evidence },
        });
        previousReceipt = observed.receipt;
        expectedRevision = commit.revision;
        if (resolution.decision === "acknowledge") {
          finalReceipts[pending.index] = observed.receipt;
          nextMessageIndex = pending.index + 1;
        } else {
          finalReceipts[pending.index] = undefined;
          nextMessageIndex = pending.index;
        }
        pending = undefined;
        continue;
      }
      throw new TypeError("通知履歴の未確定試行より先に別のstate commitがあります");
    }
    if (commit.scope !== "tracking_run") {
      throw new TypeError("通知履歴に送達試行外の手動判断があります");
    }
    const state = await readNotificationMessageState(
      port.adapter,
      port.configuration,
      commit.revision,
    );
    if (
      state.transaction.record.recordDigest !== record.recordDigest ||
      state.transaction.initialPagesEvidence?.evidenceDigest !==
        initialPages.evidence.evidenceDigest
    ) {
      throw new TypeError("通知履歴のstateが固定runまたは初回Pages証拠と一致しません");
    }
    const index = messages.findIndex((message) => {
      const attempt = state.ledger.entries.find(
        (entry) => entry.notificationKey === message.notificationKeys[0],
      )?.lastDeliveryAttempt;
      return (
        attempt?.result === "started" &&
        serializeCanonicalJson(attempt.notificationKeys) ===
          serializeCanonicalJson(message.notificationKeys) &&
        commit.operationId ===
          createStateCommitOperationId({
            kind: "notification_message",
            deliveryOperationId: attempt.operationId,
            deliveryAttemptId: attempt.attemptId,
            transition: "reservation",
          })
      );
    });
    if (
      index < 0 ||
      (index !== nextMessageIndex &&
        !(index === nextMessageIndex - 1 && finalReceipts[index]?.status === "no_effect"))
    ) {
      throw new TypeError("通知履歴の送達予約が固定outboxの順序と一致しません");
    }
    const described = describeNotificationMessage(
      record,
      state.snapshot,
      initialPages.evidence,
      index,
    );
    const attempt = state.ledger.entries.find(
      (entry) => entry.notificationKey === described.notificationKeys[0],
    )?.lastDeliveryAttempt;
    if (
      attempt == null ||
      state.transaction.marker.phase !== "notifications_in_progress" ||
      state.transaction.marker.lastMessageDeliveryId !== described.deliveryId ||
      state.ledger.entries.some(
        (entry) =>
          described.notificationKeys.includes(entry.notificationKey) &&
          (entry.status !== "delivery_started" ||
            entry.deliveryId !== described.deliveryId ||
            serializeCanonicalJson(entry.lastDeliveryAttempt) !== serializeCanonicalJson(attempt)),
      )
    ) {
      throw new TypeError("通知履歴の送達予約とledgerが一致しません");
    }
    pending = {
      index,
      reservationRevision: commit.revision,
      operationId: attempt.operationId,
      attemptId: attempt.attemptId,
      notificationKeys: described.notificationKeys,
      deliveryId: described.deliveryId,
    };
  }
  let unresolvedReceipt: NotificationMessageReceipt | undefined;
  if (pending != null) {
    const ambiguous = await appendMessage(pending.reservationRevision);
    if (ambiguous.status !== "ambiguous") {
      throw new TypeError("通知履歴の末尾予約が曖昧送達ではありません");
    }
    unresolvedReceipt = ambiguous;
  }
  verifyReceiptChain([pagesEntry, ...history], digest);
  for (let index = 0; index < nextMessageIndex; index += 1) {
    if (finalReceipts[index] == null) {
      throw new TypeError("通知履歴の確定済みmessage結果が欠けています");
    }
  }
  return {
    messageReceipts: history,
    finalReceipts: finalReceipts.filter(
      (receipt): receipt is NotificationMessageReceipt | ManualResolutionReceipt => receipt != null,
    ),
    nextMessageIndex,
    previousReceipt,
    stateRevision: expectedRevision,
    ...(unresolvedReceipt == null ? {} : { unresolvedReceipt }),
  };
}

import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import { writeStateCas, type StateCasCommitRequestFactory } from "../../persistence/state-cas.js";
import type { StateCommitIdentity } from "../../persistence/state-commit-metadata.js";
import { createStateCommitOperationId } from "../../persistence/state-commit-metadata.js";
import { parseStateNotificationLedger } from "../../persistence/state-documents.js";
import type { OrthogonalCommitAdvance } from "../../persistence/state-orthogonal-advance.js";
import { advanceMessageMarker } from "../../persistence/state-notification-transition.js";
import {
  prepareNotificationMessageContext,
  type NotificationMessageContext,
} from "./notification-message-context.js";
import type {
  NotificationMessageDeliveryInput,
  NotificationMessageDeliveryPort,
} from "./notification-message-contracts.js";
import {
  assertCurrentState,
  assertMessageCandidate,
  messageStateUpdates,
  readNotificationMessageState,
  transitionMessageLedger,
  type MessageAttempt,
} from "./notification-message-state.js";

/** 一つのmessageに対応するCAS遷移を確定する。 */
export async function commitMessageTransition(
  input: NotificationMessageDeliveryInput,
  port: NotificationMessageDeliveryPort,
  context: NotificationMessageContext,
  evidence: InitialPagesPublicationEvidence,
  attempt: MessageAttempt,
  expectedStateRevision: string,
  result: "started" | "sent" | "clear_rejection",
): Promise<
  | Readonly<{
      kind: "committed";
      revision: string;
      observed: boolean;
      advance: OrthogonalCommitAdvance;
    }>
  | Readonly<{ kind: "no_effect" }>
  | Readonly<{ kind: "conflict"; revision: string }>
> {
  const operationId = createStateCommitOperationId({
    kind: "notification_message",
    deliveryOperationId: attempt.operationId,
    deliveryAttemptId: attempt.attemptId,
    transition: result === "started" ? "reservation" : "result",
  });
  const commitIdentity = Object.freeze({
    commitScope: "tracking_run",
    operationId,
    runId: input.record.runIdentity.runId,
  } satisfies StateCommitIdentity);
  const request: StateCasCommitRequestFactory = {
    commitIdentity,
    build: async (parent, _advance, readingAdapter) => {
      if (parent.status !== "present") {
        throw new TypeError("通知messageのCAS親がありません");
      }
      const state = await readNotificationMessageState(
        readingAdapter,
        port.configuration,
        parent.revision,
      );
      assertCurrentState(
        state,
        input.record,
        input.initialStateReceipt.result.resultingStateRevision,
        evidence,
      );
      if (result === "started") {
        prepareNotificationMessageContext(
          input.record,
          state.snapshot,
          state.ledger,
          evidence,
          input.messageIndex,
          input.manualResolutionReceipt,
        );
      }
      const nextLedger = transitionMessageLedger(state.ledger, input.record, context, attempt);
      const marker = advanceMessageMarker(
        state.transaction.marker,
        nextLedger,
        evidence,
        input.initialStateReceipt.result.resultingStateRevision,
        parent.revision,
        context.deliveryId,
      );
      const updates = await messageStateUpdates(
        readingAdapter,
        port.configuration,
        state,
        nextLedger,
        marker,
        evidence,
        context,
        result,
        port.repositoryInventory,
        port.knownSecrets,
      );
      return {
        updates,
        deletions: [],
        message: `tracker notification ${result} ${input.record.runIdentity.runId} ${context.deliveryId}`,
        committedAt:
          result === "started" ? attempt.startedAt : (attempt.completedAt ?? attempt.startedAt),
        commitIdentity,
      };
    },
    verifyCandidate: (files, _revision, _request, verified) => {
      if (verified == null) {
        throw new TypeError("通知messageのCAS候補にrun transactionがありません");
      }
      const ledgerFile = files.get(port.configuration.notificationLedgerPath);
      if (ledgerFile?.status !== "present") {
        throw new TypeError("通知messageのCAS候補にledgerがありません");
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(ledgerFile.bytes);
      const ledger = parseStateNotificationLedger(source);
      assertMessageCandidate(verified.marker, ledger, context, result, attempt.attemptId);
    },
  };
  let written = await writeStateCas(
    port.adapter,
    port.configuration,
    { status: "present", revision: expectedStateRevision },
    request,
  );
  for (let retry = 0; retry < 2 && written.status === "no_effect"; retry += 1) {
    written = await writeStateCas(
      port.adapter,
      port.configuration,
      { status: "present", revision: expectedStateRevision },
      request,
    );
  }
  if (written.status === "no_effect") {
    return { kind: "no_effect" };
  }
  if (written.status === "conflict") {
    return {
      kind: "conflict",
      revision:
        written.observedHead.status === "present" ? written.observedHead.revision : "unborn",
    };
  }
  return {
    kind: "committed",
    revision: written.commit.revision,
    observed: written.observed,
    advance: written.advance,
  };
}

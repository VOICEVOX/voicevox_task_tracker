import type {
  NotificationMessageDeliveryInput,
  NotificationMessageDeliveryPort,
  NotificationMessageDeliveryOutcome,
} from "./notification-message-contracts.js";
import { z } from "zod";
import { receiptIdentifiers } from "../../application/tracking-run/receipt-codec.js";
import { createGitHubRepositoryId } from "../../domain/index.js";
import { readExactStateTree } from "../../persistence/index.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import { authorizeAdvanceAfterOrthogonalCommits } from "../../persistence/state-orthogonal-advance.js";
import { parseDurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { verifyInitialStateCommitReceiptAtRevision } from "./initial-pages-source.js";
import { verifyManualResolutionReceipt } from "./manual-resolution.js";
import { commitMessageTransition } from "./notification-message-commit.js";
import { prepareNotificationMessageContext } from "./notification-message-context.js";
import {
  notificationMessageSendOutcomeSchema,
  type NotificationMessageSendOutcome,
} from "./notification-message-http.js";
import {
  observeNotificationMessageDelivery,
  type ObservedNotificationMessage,
} from "./notification-message-observation.js";
import {
  receiptForMessage,
  validatePagesSource,
  validatePreviousReceipt,
} from "./notification-message-receipt.js";
import {
  assertCurrentState,
  readNotificationMessageState,
  type MessageAttempt,
} from "./notification-message-state.js";
import { NotificationStructureError } from "./notification-structure-error.js";

function currentTime(port: NotificationMessageDeliveryPort): string {
  return port.now().toISOString();
}

function observedOutcome(
  observed: ObservedNotificationMessage,
): NotificationMessageDeliveryOutcome {
  const receipt = observed.receipt;
  if (receipt.status === "sent") {
    if (receipt.result.discordMessageId == null) {
      throw new TypeError("再観測した送信成功receiptにDiscord IDがありません");
    }
    return {
      kind: "sent",
      receipt,
      receiptEvidence: { kind: "notification_message_state", state: observed.evidence },
      stateRevision: observed.stateRevision,
      discordMessageId: receipt.result.discordMessageId,
    };
  }
  return {
    kind: receipt.status === "ambiguous" ? "ambiguous" : "clear_rejection",
    receipt,
    receiptEvidence: { kind: "notification_message_state", state: observed.evidence },
    stateRevision: observed.stateRevision,
  };
}

/** 一つのDiscord messageを予約、実行、結果CASの順で送達する。 */
export async function deliverNotificationMessage(
  input: NotificationMessageDeliveryInput,
  port: NotificationMessageDeliveryPort,
): Promise<NotificationMessageDeliveryOutcome> {
  const record = parseDurablePublicationRecord(input.record, digest);
  z.uuid().parse(input.invocationId);
  if (!Number.isSafeInteger(input.localAttemptIndex) || input.localAttemptIndex < 0) {
    throw new TypeError("通知messageの起動内試行番号が不正です");
  }
  validatePreviousReceipt(input, record);
  await verifyInitialStateCommitReceiptAtRevision(
    port.adapter,
    port.configuration,
    input.initialStateReceipt,
    currentTime(port),
  );
  const head = await readExactStateTree(port.adapter, port.configuration.branch);
  if (head.observedHead.status !== "present") {
    throw new TypeError("通知messageのstate branchがありません");
  }
  if (head.observedHead.revision !== input.expectedStateRevision) {
    const observed = await observeNotificationMessageDelivery(
      input,
      port.adapter,
      port.configuration,
      head.observedHead.revision,
      currentTime(port),
    );
    if (observed != null) {
      return observedOutcome(observed);
    }
  }
  try {
    await authorizeAdvanceAfterOrthogonalCommits(
      port.adapter,
      port.configuration,
      input.expectedStateRevision,
      head.observedHead.revision,
    );
  } catch (cause: unknown) {
    await port.recordDiagnostic(cause);
    return { kind: "conflict", observedHeadRevision: head.observedHead.revision };
  }
  const state = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    head.observedHead.revision,
  );
  if (input.manualResolutionReceipt != null) {
    const verified = await verifyManualResolutionReceipt(
      port,
      input.manualResolutionReceipt,
      head.observedHead.revision,
    );
    if (
      verified.receipt.result.resultingStateRevision !== input.expectedStateRevision ||
      verified.receipt.binding.bindingKind !== "checkpoint" ||
      verified.receipt.binding.runId !== record.runIdentity.runId ||
      verified.receipt.binding.checkpointDigest !== record.checkpointDigest
    ) {
      throw new NotificationStructureError(
        "通知messageの手動再送receiptが同じrunの期待revisionと一致しません",
        "no_effect",
      );
    }
  }
  const evidence = validatePagesSource(
    input.initialPages,
    input.initialStateReceipt,
    state.transaction.marker.phase === "initial_state_committed",
  );
  assertCurrentState(
    state,
    record,
    input.initialStateReceipt.result.resultingStateRevision,
    evidence,
  );
  const context = prepareNotificationMessageContext(
    record,
    state.snapshot,
    state.ledger,
    evidence,
    input.messageIndex,
    input.manualResolutionReceipt,
  );
  const identity = receiptIdentifiers(
    {
      binding: input.initialStateReceipt.binding,
      stage: "notifications_settled",
      phase: "notification",
      logicalTarget: `message:${(input.messageIndex + 1).toString()}`,
      invocationId: input.invocationId,
      localAttemptIndex: input.localAttemptIndex,
    },
    digest,
  );
  const startedAt = currentTime(port);
  const attempt: MessageAttempt = Object.freeze({
    ...identity,
    durableAttemptSequence: context.durableAttemptSequence,
    notificationKeys: context.notificationKeys,
    startedAt,
    result: "started",
  });
  assertStatePublicSafety({
    snapshot: state.snapshot,
    repositoryInventory: port.repositoryInventory,
    repositoryAllowlist: record.initialPagesProjection.repositoryAllowlist.map((repository) => ({
      ...repository,
      id: createGitHubRepositoryId(repository.id),
    })),
    additionalValues: [
      record,
      state.ledger,
      evidence,
      context.message.payload.content,
      context.message.payload.embeds,
      context.message.payload.allowed_mentions,
    ],
    knownSecrets: port.knownSecrets,
  });
  const reserved = await commitMessageTransition(
    input,
    port,
    context,
    evidence,
    attempt,
    input.expectedStateRevision,
    "started",
  );
  if (reserved.kind === "conflict") {
    await port.recordDiagnostic(
      new TypeError("通知messageの予約commitとremote stateが競合しました"),
    );
    return { kind: "conflict", observedHeadRevision: reserved.revision };
  }
  if (reserved.kind === "no_effect" || reserved.observed) {
    if (reserved.kind === "committed") {
      const observed = await observeNotificationMessageDelivery(
        input,
        port.adapter,
        port.configuration,
        reserved.revision,
        currentTime(port),
      );
      if (observed != null) {
        return observedOutcome(observed);
      }
    }
    await port.recordDiagnostic(new TypeError("通知messageの予約commitをremoteで確定できません"));
    return {
      kind: "state_unconfirmed",
      stateRevision: reserved.kind === "committed" ? reserved.revision : head.observedHead.revision,
      effectCertainty: reserved.kind === "committed" ? "ambiguous" : "no_effect",
      casOutcome: reserved.kind === "committed" ? "observed" : "no_effect",
      httpOutcome: "not_started",
    };
  }
  let outcome: NotificationMessageSendOutcome;
  try {
    const outbox = record.notificationOutbox;
    if (outbox.action !== "send") {
      throw new TypeError("通知messageの送信設定がありません");
    }
    outcome = notificationMessageSendOutcomeSchema.parse(
      await port.sender.send(
        context.message.payload,
        outbox.settings.webhookSecretName,
        outbox.settings.retry,
      ),
    );
  } catch (cause: unknown) {
    outcome = {
      status: "ambiguous",
      source: record.executionPolicy.effectTarget === "production" ? "production" : "recording",
      observedAt: currentTime(port),
      cause,
    };
  }
  if (
    (record.executionPolicy.effectTarget === "production") !== (outcome.source === "production") ||
    Number.isNaN(Date.parse(outcome.observedAt)) ||
    Date.parse(outcome.observedAt) < Date.parse(startedAt) ||
    (outcome.status === "sent" && outcome.discordMessageId.length === 0)
  ) {
    throw new TypeError("通知messageの送信adapter結果が永続runと一致しません");
  }
  if (outcome.status !== "sent") {
    await port.recordDiagnostic(outcome.cause);
  }
  if (outcome.status === "ambiguous") {
    const receipt = receiptForMessage(
      input,
      context,
      reserved.revision,
      reserved.revision,
      reserved.advance,
      undefined,
      "ambiguous",
      outcome.observedAt,
      undefined,
    );
    return {
      kind: "ambiguous",
      receipt,
      receiptEvidence: { kind: "none" },
      stateRevision: reserved.revision,
    };
  }
  const resultAttempt: MessageAttempt = Object.freeze({
    ...attempt,
    result: outcome.status === "sent" ? "sent" : "clear_rejection",
    completedAt: outcome.observedAt,
    ...(outcome.status === "sent" ? { discordMessageId: outcome.discordMessageId } : {}),
  });
  let result: Awaited<ReturnType<typeof commitMessageTransition>>;
  try {
    result = await commitMessageTransition(
      input,
      port,
      context,
      evidence,
      resultAttempt,
      reserved.revision,
      outcome.status === "sent" ? "sent" : "clear_rejection",
    );
  } catch (cause: unknown) {
    if (!(cause instanceof NotificationStructureError)) {
      throw cause;
    }
    throw new NotificationStructureError(
      "通知messageの結果をstateへ保存できません",
      outcome.status === "sent" ? "committed" : "no_effect",
      {
        cause,
        casOutcome: "no_effect",
        httpOutcome: outcome.status === "sent" ? "committed" : "no_effect",
      },
    );
  }
  if (result.kind !== "committed") {
    const observedHead = await port.adapter.resolveHead(port.configuration.branch);
    if (observedHead.status === "present") {
      const observed = await observeNotificationMessageDelivery(
        input,
        port.adapter,
        port.configuration,
        observedHead.revision,
        currentTime(port),
      );
      if (observed != null) {
        if (
          (outcome.status === "sent" &&
            observed.receipt.status === "sent" &&
            observed.receipt.result.discordMessageId === outcome.discordMessageId) ||
          (outcome.status === "clear_rejection" && observed.receipt.status === "no_effect")
        ) {
          return observedOutcome(observed);
        }
        if (observed.receipt.status !== "ambiguous") {
          throw new NotificationStructureError(
            "通知messageのHTTP結果と保存済み結果が一致しません",
            outcome.status === "sent" ? "committed" : "no_effect",
            {
              casOutcome: "observed",
              httpOutcome: outcome.status === "sent" ? "committed" : "no_effect",
            },
          );
        }
      }
    }
    await port.recordDiagnostic(new TypeError("通知messageの結果commitをremoteで確定できません"));
    return {
      kind: "state_unconfirmed",
      stateRevision: observedHead.status === "present" ? observedHead.revision : reserved.revision,
      effectCertainty: outcome.status === "sent" ? "committed" : "no_effect",
      casOutcome: result.kind === "no_effect" ? "no_effect" : "unknown",
      httpOutcome: outcome.status === "sent" ? "committed" : "no_effect",
      ...(outcome.status === "sent" ? { discordMessageId: outcome.discordMessageId } : {}),
    };
  }
  if (result.observed) {
    const observed = await observeNotificationMessageDelivery(
      input,
      port.adapter,
      port.configuration,
      result.revision,
      currentTime(port),
    );
    if (
      observed == null ||
      (outcome.status === "sent" &&
        (observed.receipt.status !== "sent" ||
          observed.receipt.result.discordMessageId !== outcome.discordMessageId)) ||
      (outcome.status === "clear_rejection" && observed.receipt.status !== "no_effect")
    ) {
      throw new NotificationStructureError(
        "通知messageの再観測結果がHTTP結果と一致しません",
        outcome.status === "sent" ? "committed" : "no_effect",
        {
          casOutcome: "observed",
          httpOutcome: outcome.status === "sent" ? "committed" : "no_effect",
        },
      );
    }
    return observedOutcome(observed);
  }
  const receipt = receiptForMessage(
    input,
    context,
    reserved.revision,
    result.revision,
    reserved.advance,
    result.advance,
    outcome.status === "sent" ? "sent" : "no_effect",
    outcome.observedAt,
    outcome.status === "sent" ? outcome.discordMessageId : undefined,
  );
  return outcome.status === "sent"
    ? {
        kind: "sent",
        receipt,
        receiptEvidence: { kind: "none" },
        stateRevision: result.revision,
        discordMessageId: outcome.discordMessageId,
      }
    : {
        kind: "clear_rejection",
        receipt,
        receiptEvidence: { kind: "none" },
        stateRevision: result.revision,
      };
}

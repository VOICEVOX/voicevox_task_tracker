import { parseInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import {
  notificationMessageStateEvidenceSchema,
  type NotificationMessageStateEvidence,
} from "../../application/tracking-run/receipt-chain-schema.js";
import {
  receiptIdentifiers,
  sealObservedReceipt,
} from "../../application/tracking-run/receipt-codec.js";
import type { NotificationMessageReceipt } from "../../application/tracking-run/receipt-schema.js";
import { assertRunTransactionMarkerTransition } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  createStateCommitOperationId,
  isOrthogonalStateCommitScope,
} from "../../persistence/state-commit-metadata.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import { assertNonNullable } from "../../util/index.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { describeNotificationMessage } from "./notification-message-context.js";
import type { NotificationMessageDeliveryInput } from "./notification-message-contracts.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";

/** 保存済みstateから再構成した一messageの結果。 */
export type ObservedNotificationMessage = Readonly<{
  receipt: NotificationMessageReceipt;
  stateRevision: string;
  evidence: NotificationMessageStateEvidence;
}>;

function assertAttemptEntries(
  state: NotificationMessageState,
  notificationKeys: readonly string[],
  operationId: string,
  attemptId: string,
  result: "started" | "sent" | "clear_rejection",
  deliveryId: string,
): void {
  for (const key of notificationKeys) {
    const entry = state.ledger.entries.find((value) => value.notificationKey === key);
    assertNonNullable(entry, "再観測した通知messageのledger entryがありません");
    const attempt = entry.lastDeliveryAttempt;
    if (
      attempt?.operationId !== operationId ||
      attempt.attemptId !== attemptId ||
      attempt.result !== result ||
      serializeCanonicalJson(attempt.notificationKeys) !==
        serializeCanonicalJson(notificationKeys) ||
      (result === "started" &&
        (entry.status !== "delivery_started" || entry.deliveryId !== deliveryId)) ||
      (result === "sent" &&
        (entry.status !== "sent" || entry.discordMessageId !== attempt.discordMessageId)) ||
      (result === "clear_rejection" && entry.status !== "reserved")
    ) {
      throw new TypeError("再観測した通知messageの全keyに同じ送達試行がありません");
    }
  }
}

function commitOperationId(
  operationId: string,
  attemptId: string,
  transition: "reservation" | "result",
): string {
  return createStateCommitOperationId({
    kind: "notification_message",
    deliveryOperationId: operationId,
    deliveryAttemptId: attemptId,
    transition,
  });
}

/** 同じrunのGit祖先とledgerから実行済みmessageを再観測する。 */
export async function observeNotificationMessageDelivery(
  input: NotificationMessageDeliveryInput,
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  observedHeadRevision: string,
  observedAt: string,
): Promise<ObservedNotificationMessage | undefined> {
  const head = await readNotificationMessageState(adapter, configuration, observedHeadRevision);
  const evidence = head.transaction.initialPagesEvidence;
  if (evidence == null) {
    return undefined;
  }
  if (
    head.transaction.record.recordDigest !== input.record.recordDigest ||
    head.transaction.marker.runId !== input.record.runIdentity.runId ||
    evidence.sourceStateRevision !== input.initialStateReceipt.result.resultingStateRevision ||
    serializeCanonicalJson(evidence) !==
      serializeCanonicalJson(
        parseInitialPagesPublicationEvidence(input.initialPages.evidence, digest),
      )
  ) {
    throw new TypeError("通知message再観測先が同じ永続runではありません");
  }
  const context = describeNotificationMessage(
    input.record,
    head.snapshot,
    evidence,
    input.messageIndex,
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
  const entries = context.notificationKeys.map((key) =>
    head.ledger.entries.find((entry) => entry.notificationKey === key),
  );
  const firstEntry = entries[0];
  if (firstEntry?.lastDeliveryAttempt?.operationId !== identity.operationId) {
    return undefined;
  }
  const attempt = firstEntry.lastDeliveryAttempt;
  if (
    serializeCanonicalJson(attempt.notificationKeys) !==
      serializeCanonicalJson(context.notificationKeys) ||
    entries.some(
      (entry) =>
        entry?.lastDeliveryAttempt == null ||
        serializeCanonicalJson(entry.lastDeliveryAttempt) !== serializeCanonicalJson(attempt),
    )
  ) {
    throw new TypeError("再観測した通知messageの試行記録がkey間で一致しません");
  }
  const reservationOperationId = commitOperationId(
    identity.operationId,
    attempt.attemptId,
    "reservation",
  );
  const resultOperationId = commitOperationId(identity.operationId, attempt.attemptId, "result");
  let reservationRevision: string | undefined;
  let resultRevision: string | undefined;
  let reservationCommit:
    | Omit<
        NotificationMessageStateEvidence["reservation"],
        "expectedTrackingStateRevision" | "interveningOperationsAlertCommits"
      >
    | undefined;
  let resultCommit:
    | Omit<
        NotificationMessageStateEvidence["reservation"],
        "expectedTrackingStateRevision" | "interveningOperationsAlertCommits"
      >
    | undefined;
  let revision = observedHeadRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (revision === input.expectedStateRevision) {
      break;
    }
    const commit = await adapter.readCommit(revision);
    if (commit.parent.status !== "present") {
      throw new TypeError("通知message再観測で期待revisionへ到達できません");
    }
    if (isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      await authorizeAdvanceAfterOrthogonalCommits(
        adapter,
        configuration,
        commit.parent.revision,
        revision,
      );
    } else {
      if (
        commit.metadata.commitScope !== "tracking_run" ||
        commit.metadata.runId !== input.record.runIdentity.runId
      ) {
        throw new TypeError("通知message再観測の祖先に別runのcommitがあります");
      }
      const current = await readNotificationMessageState(adapter, configuration, revision);
      const parent = await readNotificationMessageState(
        adapter,
        configuration,
        commit.parent.revision,
      );
      assertRunTransactionMarkerTransition(
        parent.transaction.marker,
        current.transaction.marker,
        commit.parent.revision,
        current.transaction.initialPagesEvidence,
      );
      if (current.transaction.record.recordDigest !== input.record.recordDigest) {
        throw new TypeError("通知message再観測の祖先で永続recordが変化しています");
      }
      if (commit.metadata.operationId === reservationOperationId) {
        if (reservationRevision != null) {
          throw new TypeError("同じ通知messageの予約commitが重複しています");
        }
        assertAttemptEntries(
          current,
          context.notificationKeys,
          identity.operationId,
          attempt.attemptId,
          "started",
          context.deliveryId,
        );
        reservationRevision = revision;
        reservationCommit = {
          revision,
          parentRevision: commit.parent.revision,
          commitOperationId: commit.metadata.operationId,
          markerPhaseSequence: current.transaction.marker.phaseSequence,
          notificationLedgerDigest: current.transaction.notificationLedgerDigest,
        };
      }
      if (commit.metadata.operationId === resultOperationId) {
        if (resultRevision != null || attempt.result === "started") {
          throw new TypeError("同じ通知messageの結果commitが重複または未実行です");
        }
        assertAttemptEntries(
          current,
          context.notificationKeys,
          identity.operationId,
          attempt.attemptId,
          attempt.result,
          context.deliveryId,
        );
        resultRevision = revision;
        resultCommit = {
          revision,
          parentRevision: commit.parent.revision,
          commitOperationId: commit.metadata.operationId,
          markerPhaseSequence: current.transaction.marker.phaseSequence,
          notificationLedgerDigest: current.transaction.notificationLedgerDigest,
        };
      }
    }
    revision = commit.parent.revision;
  }
  if (
    revision !== input.expectedStateRevision ||
    reservationRevision == null ||
    reservationCommit == null ||
    (attempt.result === "started") !== (resultRevision == null)
  ) {
    throw new TypeError("通知messageの予約と結果をGit祖先から一意に再観測できません");
  }
  const reservationAdvance = await authorizeAdvanceAfterOrthogonalCommits(
    adapter,
    configuration,
    input.expectedStateRevision,
    reservationCommit.parentRevision,
  );
  const resultAdvance =
    resultCommit == null
      ? undefined
      : await authorizeAdvanceAfterOrthogonalCommits(
          adapter,
          configuration,
          reservationRevision,
          resultCommit.parentRevision,
        );
  const resultRevisionForReceipt = resultRevision ?? reservationRevision;
  const status =
    attempt.result === "started" ? "ambiguous" : attempt.result === "sent" ? "sent" : "no_effect";
  const receipt = sealObservedReceipt(
    {
      schemaVersion: 1,
      receiptType: "notification_message",
      stage: "notifications_settled",
      phase: "notification",
      binding: input.initialStateReceipt.binding,
      logicalTarget: `message:${(input.messageIndex + 1).toString()}`,
      invocationId: input.invocationId,
      localAttemptIndex: input.localAttemptIndex,
      phaseSequence: input.previousReceipt.phaseSequence + 1,
      previousReceiptDigest: input.previousReceipt.receiptDigest,
      expectedStateRevision: input.expectedStateRevision,
      receiptKind: "observed",
      observedAt,
      ...(attempt.completedAt == null ? {} : { effectOccurredAt: attempt.completedAt }),
      ...(status === "ambiguous" ? { publicDiagnosticCode: "effect_unconfirmed" } : {}),
      ...(status === "no_effect" ? { publicDiagnosticCode: "action_failed" } : {}),
      status,
      effectCertainty: status === "sent" ? "committed" : status,
      durableAttemptSequence: attempt.durableAttemptSequence,
      result: {
        deliveryId: context.deliveryId,
        notificationKeys: [...context.notificationKeys],
        reservationStateRevision: reservationRevision,
        ledgerStateRevision: resultRevisionForReceipt,
        reservationCommit: {
          ...reservationAdvance,
          interveningOperationsAlertCommits: [
            ...reservationAdvance.interveningOperationsAlertCommits,
          ],
        },
        ...(resultAdvance == null
          ? {}
          : {
              resultCommit: {
                ...resultAdvance,
                interveningOperationsAlertCommits: [
                  ...resultAdvance.interveningOperationsAlertCommits,
                ],
              },
            }),
        ...(attempt.discordMessageId == null ? {} : { discordMessageId: attempt.discordMessageId }),
      },
    },
    digest,
  );
  if (receipt.receiptType !== "notification_message") {
    throw new TypeError("再観測した通知message receiptの型が不正です");
  }
  const stateEvidence = notificationMessageStateEvidenceSchema.parse({
    runId: input.record.runIdentity.runId,
    checkpointDigest: input.record.checkpointDigest,
    publicationRecordDigest: input.record.recordDigest,
    initialStateRevision: input.initialStateReceipt.result.resultingStateRevision,
    initialPagesPublicationEvidenceDigest: evidence.evidenceDigest,
    deliveryId: context.deliveryId,
    attempt,
    reservation: {
      ...reservationCommit,
      expectedTrackingStateRevision: reservationAdvance.expectedTrackingStateRevision,
      interveningOperationsAlertCommits: [...reservationAdvance.interveningOperationsAlertCommits],
    },
    ...(resultCommit == null || resultAdvance == null
      ? {}
      : {
          result: {
            ...resultCommit,
            expectedTrackingStateRevision: resultAdvance.expectedTrackingStateRevision,
            interveningOperationsAlertCommits: [...resultAdvance.interveningOperationsAlertCommits],
          },
        }),
  });
  return Object.freeze({
    receipt,
    stateRevision: resultRevisionForReceipt,
    evidence: stateEvidence,
  });
}

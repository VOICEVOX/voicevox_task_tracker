import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type { ManualResolutionReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { DiscordNotificationSelection } from "../../discord/notification-selection-contracts.js";
import type { PreparedDiscordDigestMessage } from "../../discord/payload-contracts.js";
import { buildDiscordDigestPlan } from "../../discord/payload.js";
import type { StateSnapshot } from "../../persistence/snapshot-v23.js";
import type { StateNotificationLedger } from "../../persistence/state-documents.js";
import { notificationSelectionFromRecord } from "../../persistence/notification-selection-from-record.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { NotificationStructureError } from "./notification-structure-error.js";

/** 永続outboxから一つのDiscord messageを確定した文脈。 */
export type NotificationMessageContext = Readonly<{
  deliveryId: string;
  message: PreparedDiscordDigestMessage;
  notificationKeys: readonly string[];
  durableAttemptSequence: number;
  manualResolutionReceipt?: ManualResolutionReceipt;
}>;

/** 永続outboxから一messageの位置、本文、keyを決定する。 */
export function describeNotificationMessage(
  record: DurablePublicationRecord,
  snapshot: StateSnapshot,
  pagesEvidence: InitialPagesPublicationEvidence,
  messageIndex: number,
): Omit<NotificationMessageContext, "durableAttemptSequence"> {
  const outbox = record.notificationOutbox;
  if (
    outbox.action !== "send" ||
    outbox.delivery !== "send" ||
    outbox.selectedContext.action !== "create_digest" ||
    !outbox.settings.enabled ||
    !Number.isSafeInteger(messageIndex) ||
    messageIndex < 0 ||
    snapshot.run.id !== record.runIdentity.runId ||
    snapshot.generatedAt !== record.initialPagesProjection.generatedAt ||
    pagesEvidence.runId !== record.runIdentity.runId ||
    pagesEvidence.checkpointDigest !== record.checkpointDigest ||
    pagesEvidence.pageUrl !== record.initialPagesProjection.settings.url
  ) {
    throw new NotificationStructureError(
      "通知messageの保存済みrun、outboxまたはPages証拠が一致しません",
      "no_effect",
    );
  }
  const selectedContext = restoreNotificationSelection(record);
  const plan = buildDiscordDigestPlan({
    candidates: selectedContext.candidates,
    ledgerReservations: selectedContext.ledgerReservations,
    items: snapshot.items,
    pagesUrl: pagesEvidence.pageUrl,
    generatedAt: snapshot.generatedAt,
    mentions: outbox.settings.mentions,
  });
  const message = plan.messages[messageIndex];
  if (message == null || message.notificationKeys.length === 0) {
    throw new NotificationStructureError("通知messageの位置が永続outboxの範囲外です", "no_effect");
  }
  const notificationKeys = [...message.notificationKeys];
  if (new Set(notificationKeys).size !== notificationKeys.length) {
    throw new NotificationStructureError(
      "一つの通知message内でnotification keyが重複しています",
      "no_effect",
    );
  }
  return Object.freeze({
    deliveryId: `${plan.digestId}:message:${(messageIndex + 1).toString()}`,
    message,
    notificationKeys: Object.freeze(notificationKeys),
  });
}

/** 永続recordの検証済み配列を非空通知候補へ戻す。 */
export function restoreNotificationSelection(
  record: DurablePublicationRecord,
): Extract<DiscordNotificationSelection, { action: "create_digest" }> {
  try {
    return notificationSelectionFromRecord(record);
  } catch (cause: unknown) {
    if (!(cause instanceof TypeError)) {
      throw cause;
    }
    throw new NotificationStructureError("永続outboxの送信候補が不正です", "no_effect", { cause });
  }
}

/** 保存済みsnapshot、outbox、ledgerとPages URLから送信対象を照合する。 */
export function prepareNotificationMessageContext(
  record: DurablePublicationRecord,
  snapshot: StateSnapshot,
  ledger: StateNotificationLedger,
  pagesEvidence: InitialPagesPublicationEvidence,
  messageIndex: number,
  manualResolutionReceipt: ManualResolutionReceipt | undefined,
): NotificationMessageContext {
  const described = describeNotificationMessage(record, snapshot, pagesEvidence, messageIndex);
  const { notificationKeys } = described;
  const outbox = record.notificationOutbox;
  if (outbox.action !== "send" || outbox.selectedContext.action !== "create_digest") {
    throw new NotificationStructureError("通知messageの予約がありません", "no_effect");
  }
  const current = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  const reservations = new Map(
    outbox.selectedContext.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  let lastAttempt: StateNotificationLedger["entries"][number]["lastDeliveryAttempt"];
  let firstKey = true;
  for (const key of notificationKeys) {
    const entry = current.get(key);
    const reservation = reservations.get(key);
    if (
      entry?.status !== "reserved" ||
      reservation?.status !== "reserved" ||
      entry.itemNodeId !== reservation.itemNodeId ||
      entry.reasonCode !== reservation.reasonCode ||
      entry.severity !== reservation.severity ||
      entry.reservedAt !== reservation.reservedAt ||
      entry.expiresAt !== reservation.expiresAt
    ) {
      throw new NotificationStructureError(
        "通知messageのkeyが現在の予約と一致しません",
        "no_effect",
      );
    }
    const attempt = entry.lastDeliveryAttempt;
    if (
      attempt != null &&
      attempt.result !== "clear_rejection" &&
      (attempt.result !== "started" ||
        entry.manualResolution?.decision !== "retry" ||
        manualResolutionReceipt?.result.decision !== "retry" ||
        entry.manualResolution.operationId !== manualResolutionReceipt.operationId ||
        entry.manualResolution.attemptId !== attempt.attemptId ||
        manualResolutionReceipt.result.deliveryAttemptId !== attempt.attemptId ||
        manualResolutionReceipt.result.deliveryId !== described.deliveryId ||
        serializeCanonicalJson(manualResolutionReceipt.result.notificationKeys) !==
          serializeCanonicalJson(notificationKeys))
    ) {
      throw new NotificationStructureError(
        "未確定または送信済みの通知messageを再送できません",
        "no_effect",
      );
    }
    if (firstKey) {
      lastAttempt = attempt;
      firstKey = false;
    } else if (
      (lastAttempt == null) !== (attempt == null) ||
      (lastAttempt != null &&
        attempt != null &&
        serializeCanonicalJson(lastAttempt) !== serializeCanonicalJson(attempt))
    ) {
      throw new NotificationStructureError(
        "同じ通知messageの送達試行記録が一致しません",
        "no_effect",
      );
    }
  }
  if (
    lastAttempt != null &&
    serializeCanonicalJson(lastAttempt.notificationKeys) !==
      serializeCanonicalJson(notificationKeys)
  ) {
    throw new NotificationStructureError(
      "前回の送達試行と通知messageのkey集合が一致しません",
      "no_effect",
    );
  }
  return Object.freeze({
    ...described,
    durableAttemptSequence: (lastAttempt?.durableAttemptSequence ?? 0) + 1,
    ...(manualResolutionReceipt == null ? {} : { manualResolutionReceipt }),
  });
}

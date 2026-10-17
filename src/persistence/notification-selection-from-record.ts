import type {
  DiscordNotificationCandidate,
  DiscordNotificationSelection,
} from "../discord/notification-selection-contracts.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";

/** 固定outboxの候補、予約、未送信集合を通知選択へ投影する。 */
export function notificationSelectionFromRecord(
  record: DurablePublicationRecord,
): Extract<DiscordNotificationSelection, { action: "create_digest" }> {
  const outbox = record.notificationOutbox;
  if (outbox.action !== "send" || outbox.selectedContext.action !== "create_digest") {
    throw new TypeError("固定outboxに送信候補がありません");
  }
  const candidates = outbox.selectedContext.candidates.map((candidate) => {
    const [first, ...rest] = candidate.reasons;
    if (first == null) {
      throw new TypeError("固定outboxの候補に理由がありません");
    }
    return { ...candidate, reasons: [first, ...rest] } satisfies DiscordNotificationCandidate;
  });
  const [firstCandidate, ...otherCandidates] = candidates;
  const [firstReservation, ...otherReservations] = outbox.selectedContext.ledgerReservations;
  if (firstCandidate == null || firstReservation == null) {
    throw new TypeError("固定outboxの候補または予約が空です");
  }
  return {
    action: "create_digest",
    candidates: [firstCandidate, ...otherCandidates],
    ledgerReservations: [firstReservation, ...otherReservations],
    pendingNotifications: outbox.selectedContext.pendingNotifications,
  };
}

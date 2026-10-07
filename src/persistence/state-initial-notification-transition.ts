import { hashCanonicalJson } from "../canonical-json/index.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { createStateNotificationLedger, type StateNotificationLedger } from "./state-documents.js";

function same(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

/** 親ledgerと固定outboxから初回commitの通常ledgerを導出する。 */
export function initialNotificationLedger(
  previous: StateNotificationLedger,
  record: Pick<DurablePublicationRecord, "notificationOutbox">,
): StateNotificationLedger {
  const outbox = record.notificationOutbox;
  if (hashCanonicalJson(normalNotificationLedgerValue(previous)) !== outbox.previousLedgerDigest) {
    throw new TypeError("固定outboxの親ledger digestがexact親stateと一致しません");
  }
  const entries = new Map(previous.entries.map((entry) => [entry.notificationKey, entry]));
  if (entries.size !== previous.entries.length) {
    throw new TypeError("初回commitの親ledger keyが重複しています");
  }
  let pendingNotifications: StateNotificationLedger["pendingNotifications"];
  if (outbox.action === "send") {
    pendingNotifications = outbox.selectedContext.pendingNotifications;
    if (outbox.selectedContext.action === "create_digest") {
      const selectedKeys = outbox.selectedContext.candidates.flatMap((candidate) =>
        candidate.reasons.map((reason) => reason.notificationKey),
      );
      const reservations = outbox.selectedContext.ledgerReservations;
      if (
        new Set(selectedKeys).size !== selectedKeys.length ||
        new Set(reservations.map((entry) => entry.notificationKey)).size !== reservations.length ||
        !same([...selectedKeys].sort(), reservations.map((entry) => entry.notificationKey).sort())
      ) {
        throw new TypeError("固定outboxの候補と初回予約keyが一致しません");
      }
      for (const reservation of reservations) {
        const old = entries.get(reservation.notificationKey);
        if (old?.status === "sent" || old?.status === "acknowledged") {
          throw new TypeError("固定outboxの初回予約が親ledgerと一致しません");
        }
        entries.set(reservation.notificationKey, reservation);
      }
    } else if (
      outbox.delivery !== "no_candidates" ||
      outbox.selectedContext.reason !== "no_candidates"
    ) {
      throw new TypeError("送信0件の固定outboxが不正です");
    }
  } else {
    pendingNotifications = outbox.pendingNotifications;
    if (outbox.action === "acknowledge-current") {
      const keys = new Set<string>();
      for (const acknowledged of outbox.acknowledgedEntries) {
        const old = entries.get(acknowledged.notificationKey);
        if (
          keys.has(acknowledged.notificationKey) ||
          old?.status === "sent" ||
          old?.status === "acknowledged"
        ) {
          throw new TypeError("固定outboxの初回確認済みentryが親ledgerと一致しません");
        }
        keys.add(acknowledged.notificationKey);
        entries.set(acknowledged.notificationKey, acknowledged);
      }
    }
  }
  const expected = createStateNotificationLedger({
    schemaVersion: previous.schemaVersion,
    entries: [...entries.values()],
    operationsAlerts: previous.operationsAlerts,
    pendingNotifications,
  });
  if (hashCanonicalJson(normalNotificationLedgerValue(expected)) !== outbox.initialLedgerDigest) {
    throw new TypeError("固定outboxの初回ledger digestが導出値と一致しません");
  }
  return expected;
}

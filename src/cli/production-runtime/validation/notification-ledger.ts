import {
  createUtcIsoDateTime,
  type NotificationLedgerEntry,
  type PendingNotification,
} from "../../../domain/index.js";
import {
  createStateNotificationLedger,
  NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
  type StateNotificationLedger,
} from "../../../persistence/index.js";
import type { PendingTrackedItem, RuntimeState } from "../contracts.js";

/** 通知管理記録から追跡対象のentryを取り出す。 */
export function notificationLedgerEntries(
  state: RuntimeState,
  items: readonly PendingTrackedItem[],
): readonly NotificationLedgerEntry[] {
  const itemsByNodeId = new Map<string, PendingTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const entries: NotificationLedgerEntry[] = [];
  for (const entry of state.notificationLedger.entries) {
    const item = itemsByNodeId.get(entry.itemNodeId);
    if (item == null) {
      continue;
    }
    const fields = {
      notificationKey: entry.notificationKey,
      itemNodeId: item.nodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: createUtcIsoDateTime(entry.reservedAt),
    };
    if (entry.status === "reserved") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "reserved",
          expiresAt: createUtcIsoDateTime(entry.expiresAt),
        }),
      );
    } else if (entry.status === "delivery_started") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "delivery_started",
          deliveryId: entry.deliveryId,
          startedAt: createUtcIsoDateTime(entry.startedAt),
        }),
      );
    } else if (entry.status === "sent") {
      entries.push(
        Object.freeze({
          ...fields,
          status: "sent",
          sentAt: createUtcIsoDateTime(entry.sentAt),
          discordMessageId: entry.discordMessageId,
        }),
      );
    } else {
      entries.push(
        Object.freeze({
          ...fields,
          status: "acknowledged",
          acknowledgedAt: createUtcIsoDateTime(entry.acknowledgedAt),
        }),
      );
    }
  }
  return Object.freeze(entries);
}

/** 通知候補のentryと未送信候補を通知管理記録へ統合する。 */
export function mergeNotificationLedger(
  state: RuntimeState,
  entriesToMerge: readonly NotificationLedgerEntry[],
  pendingNotifications: readonly PendingNotification[],
): StateNotificationLedger {
  const entries = new Map(
    state.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  for (const entry of entriesToMerge) {
    const existing = entries.get(entry.notificationKey);
    if (
      entry.status === "acknowledged" &&
      (existing?.status === "sent" || existing?.status === "acknowledged")
    ) {
      continue;
    }
    entries.set(entry.notificationKey, entry);
  }
  return createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: [...entries.values()],
    operationsAlerts: state.notificationLedger.operationsAlerts,
    pendingNotifications,
  });
}

import {
  createGitHubNodeId,
  createUtcIsoDateTime,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
} from "../domain/index.js";
import type { StateNotificationLedger } from "./state-documents.js";

/** 保存済み運用通知ledgerを送達用の型へ変換する。 */
export function operationsAlertLedgerEntry(
  entry: StateNotificationLedger["operationsAlerts"][number],
): OperationsAlertLedgerEntry {
  return Object.freeze({
    ...entry,
    occurredAt: createUtcIsoDateTime(entry.occurredAt),
    sentAt: createUtcIsoDateTime(entry.sentAt),
  });
}

/** 保存済み通知ledgerを送達用の型へ変換する。 */
export function notificationLedgerEntry(
  entry: StateNotificationLedger["entries"][number],
): NotificationLedgerEntry {
  const fields = {
    notificationKey: entry.notificationKey,
    itemNodeId: createGitHubNodeId(entry.itemNodeId),
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    reservedAt: createUtcIsoDateTime(entry.reservedAt),
    ...(entry.lastDeliveryAttempt == null
      ? {}
      : { lastDeliveryAttempt: entry.lastDeliveryAttempt }),
    ...(entry.manualResolution == null ? {} : { manualResolution: entry.manualResolution }),
  };
  if (entry.status === "reserved") {
    return Object.freeze({
      ...fields,
      status: "reserved",
      expiresAt: createUtcIsoDateTime(entry.expiresAt),
    });
  }
  if (entry.status === "delivery_started") {
    return Object.freeze({
      ...fields,
      status: "delivery_started",
      deliveryId: entry.deliveryId,
      startedAt: createUtcIsoDateTime(entry.startedAt),
    });
  }
  if (entry.status === "sent") {
    return Object.freeze({
      ...fields,
      status: "sent",
      sentAt: createUtcIsoDateTime(entry.sentAt),
      discordMessageId: entry.discordMessageId,
    });
  }
  return Object.freeze({
    ...fields,
    status: "acknowledged",
    acknowledgedAt: createUtcIsoDateTime(entry.acknowledgedAt),
  });
}

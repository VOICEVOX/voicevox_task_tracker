import type { z } from "zod";

import type {
  NotificationDeliveryAttempt,
  NotificationManualResolution,
} from "../domain/notification-delivery-attempt.js";
import type { pendingNotificationSchema } from "../domain/pending-notification.js";

type NotificationLedgerValidationEntryBase = Readonly<{
  notificationKey: string;
  reservedAt: string;
  lastDeliveryAttempt?: NotificationDeliveryAttempt | undefined;
  manualResolution?: NotificationManualResolution | undefined;
}>;

type NotificationLedgerValidationEntry = NotificationLedgerValidationEntryBase &
  (
    | Readonly<{ status: "reserved"; expiresAt: string }>
    | Readonly<{ status: "delivery_started"; deliveryId: string; startedAt: string }>
    | Readonly<{ status: "sent"; sentAt: string; discordMessageId: string }>
    | Readonly<{ status: "acknowledged"; acknowledgedAt: string }>
  );

/** 通知ledgerの項目間整合性を検証する入力。 */
export type NotificationLedgerValidationInput = Readonly<{
  entries: readonly NotificationLedgerValidationEntry[];
  operationsAlerts: readonly Readonly<{
    alertKey: string;
    occurredAt: string;
    sentAt: string;
  }>[];
  pendingNotifications: readonly z.output<typeof pendingNotificationSchema>[];
}>;

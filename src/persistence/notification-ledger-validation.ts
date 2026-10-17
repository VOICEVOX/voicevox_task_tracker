import type { RefinementCtx } from "zod";

import type { NotificationLedgerValidationInput } from "./notification-ledger-validation-contracts.js";

export function validateNotificationLedger(
  ledger: NotificationLedgerValidationInput,
  context: RefinementCtx,
): void {
  const keys = ledger.entries.map((entry) => entry.notificationKey);
  const entriesByKey = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "notificationKeyが重複しています",
    });
  }
  const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
  if (new Set(alertKeys).size !== alertKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["operationsAlerts"],
      message: "alertKeyが重複しています",
    });
  }
  for (const [index, entry] of ledger.operationsAlerts.entries()) {
    if (entry.sentAt < entry.occurredAt) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts", index, "sentAt"],
        message: "運用障害通知の送信時刻は発生時刻以後にしてください",
      });
    }
  }
  for (const [index, entry] of ledger.entries.entries()) {
    const attempt = entry.lastDeliveryAttempt;
    const resolution = entry.manualResolution;
    if (
      resolution != null &&
      (attempt?.result !== "started" ||
        attempt.attemptId !== resolution.attemptId ||
        resolution.resolvedAt < attempt.startedAt ||
        (resolution.decision === "retry" && entry.status !== "reserved") ||
        (resolution.decision === "acknowledge" && entry.status !== "acknowledged") ||
        attempt.notificationKeys.some((key) => {
          const peer = entriesByKey.get(key);
          return (
            peer?.lastDeliveryAttempt?.attemptId !== attempt.attemptId ||
            peer.manualResolution?.operationId !== resolution.operationId ||
            peer.manualResolution.decision !== resolution.decision
          );
        }))
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "manualResolution"],
        message: "手動解決が開始済み送達試行と一致しません",
      });
    }
    if (attempt != null) {
      if (
        new Set(attempt.notificationKeys).size !== attempt.notificationKeys.length ||
        !attempt.notificationKeys.includes(entry.notificationKey) ||
        (attempt.result === "started" && resolution == null) !==
          (entry.status === "delivery_started") ||
        (entry.status === "sent" && attempt.result !== "sent") ||
        (attempt.result === "started" &&
          (attempt.completedAt != null || attempt.discordMessageId != null)) ||
        (attempt.result !== "started" && attempt.completedAt == null) ||
        (attempt.result === "sent") !== (attempt.discordMessageId != null) ||
        attempt.startedAt < entry.reservedAt ||
        (attempt.completedAt != null && attempt.completedAt < attempt.startedAt) ||
        (entry.status === "delivery_started" && entry.startedAt !== attempt.startedAt) ||
        (entry.status === "sent" &&
          (entry.discordMessageId !== attempt.discordMessageId ||
            entry.sentAt !== attempt.completedAt)) ||
        (attempt.result === "started" &&
          resolution == null &&
          (entry.status !== "delivery_started" ||
            attempt.notificationKeys.some((key) => {
              const peer = entriesByKey.get(key);
              return (
                peer?.status !== "delivery_started" ||
                peer.lastDeliveryAttempt?.attemptId !== attempt.attemptId ||
                peer.lastDeliveryAttempt.operationId !== attempt.operationId ||
                peer.deliveryId !== entry.deliveryId
              );
            })))
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "lastDeliveryAttempt"],
          message: "通知送達試行の記録がledger entryと一致しません",
        });
      }
    }
    if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "expiresAt"],
        message: "予約期限は予約時刻以後にしてください",
      });
    }
    if (entry.status === "delivery_started" && entry.startedAt < entry.reservedAt) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "startedAt"],
        message: "送信開始時刻は予約時刻以後にしてください",
      });
    }
    if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "sentAt"],
        message: "送信時刻は予約時刻以後にしてください",
      });
    }
    if (entry.status === "acknowledged" && entry.acknowledgedAt < entry.reservedAt) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "acknowledgedAt"],
        message: "確認時刻は予約時刻以後にしてください",
      });
    }
  }
  const pendingKeys = new Set<string>();
  const itemReasonKeys = new Set<string>();
  const personalReminderKeys = new Set<string>();
  const cycleKeys = new Set<string>();
  for (const [index, notification] of ledger.pendingNotifications.entries()) {
    if (pendingKeys.has(notification.notificationKey)) {
      context.addIssue({
        code: "custom",
        path: ["pendingNotifications", index, "notificationKey"],
        message: "送信待ち通知のnotificationKeyが重複しています",
      });
    }
    pendingKeys.add(notification.notificationKey);
    const itemReasonKey = JSON.stringify([notification.itemNodeId, notification.reason.reasonCode]);
    if (notification.target.kind === "cycle") {
      const cycleKey = JSON.stringify([
        notification.itemNodeId,
        notification.reason.reasonCode,
        notification.target.cycleId,
      ]);
      if (cycleKeys.has(cycleKey)) {
        context.addIssue({
          code: "custom",
          path: ["pendingNotifications", index],
          message: "同じ項目、理由、cycleの送信待ち通知が重複しています",
        });
      }
      cycleKeys.add(cycleKey);
    } else if (notification.target.kind === "personal_reminder") {
      const personalReminderKey = JSON.stringify([
        notification.itemNodeId,
        notification.reason.reasonCode,
        notification.target.causeId,
      ]);
      if (personalReminderKeys.has(personalReminderKey)) {
        context.addIssue({
          code: "custom",
          path: ["pendingNotifications", index],
          message: "同じ項目、理由、個人催促原因の送信待ち通知が重複しています",
        });
      }
      personalReminderKeys.add(personalReminderKey);
    } else if (itemReasonKeys.has(itemReasonKey)) {
      context.addIssue({
        code: "custom",
        path: ["pendingNotifications", index],
        message: "同じ項目と理由の送信待ち通知が重複しています",
      });
    } else {
      itemReasonKeys.add(itemReasonKey);
    }
  }
}

import type { InitialPagesPublicationEvidence } from "../application/tracking-run/initial-pages-evidence-codec.js";
import {
  parseRunTransactionMarker,
  type RunTransactionMarker,
} from "../application/tracking-run/run-transaction-marker.js";
import { hashCanonicalJson } from "../canonical-json/index.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type {
  NotificationDeliveryAttempt,
  NotificationManualResolution,
} from "../domain/notification-delivery-attempt.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import { createStateNotificationLedger, type StateNotificationLedger } from "./state-documents.js";

type MessageTarget = Readonly<{
  deliveryId: string;
  notificationKeys: readonly string[];
  manualResolutionOperationId?: string;
}>;

function same(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function reservationMap(
  record: DurablePublicationRecord,
): ReadonlyMap<string, StateNotificationLedger["entries"][number]> {
  const outbox = record.notificationOutbox;
  if (outbox.action !== "send" || outbox.selectedContext.action !== "create_digest") {
    throw new TypeError("固定outboxに送達対象がありません");
  }
  const reservations = new Map(
    outbox.selectedContext.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  if (reservations.size !== outbox.selectedContext.ledgerReservations.length) {
    throw new TypeError("固定outboxの予約keyが重複しています");
  }
  return reservations;
}

/** 親ledger、固定outbox、型付き試行から一messageのledgerを導出する。 */
export function transitionNotificationMessageLedger(
  ledger: StateNotificationLedger,
  record: DurablePublicationRecord,
  target: MessageTarget,
  attempt: NotificationDeliveryAttempt,
): StateNotificationLedger {
  const keys = new Set(target.notificationKeys);
  const reservations = reservationMap(record);
  if (
    keys.size === 0 ||
    keys.size !== target.notificationKeys.length ||
    !same(attempt.notificationKeys, target.notificationKeys) ||
    ledger.entries.filter((entry) => keys.has(entry.notificationKey)).length !== keys.size
  ) {
    throw new TypeError("送達試行の対象keyが固定messageと一致しません");
  }
  const entries = ledger.entries.map((entry): StateNotificationLedger["entries"][number] => {
    if (!keys.has(entry.notificationKey)) {
      return entry;
    }
    const reservation = reservations.get(entry.notificationKey);
    if (
      reservation?.status !== "reserved" ||
      entry.itemNodeId !== reservation.itemNodeId ||
      entry.reasonCode !== reservation.reasonCode ||
      entry.severity !== reservation.severity ||
      entry.reservedAt !== reservation.reservedAt
    ) {
      throw new TypeError("送達試行の元予約が固定outboxと一致しません");
    }
    if (attempt.result === "started") {
      const prior = entry.lastDeliveryAttempt;
      if (
        entry.status !== "reserved" ||
        entry.expiresAt !== reservation.expiresAt ||
        (attempt.startedAt > entry.expiresAt && target.manualResolutionOperationId == null) ||
        attempt.completedAt != null ||
        attempt.discordMessageId != null ||
        attempt.durableAttemptSequence !== (prior?.durableAttemptSequence ?? 0) + 1 ||
        (prior != null &&
          prior.result !== "clear_rejection" &&
          (prior.result !== "started" ||
            entry.manualResolution?.decision !== "retry" ||
            entry.manualResolution.operationId !== target.manualResolutionOperationId)) ||
        (prior == null && target.manualResolutionOperationId != null)
      ) {
        throw new TypeError("送達開始の親予約または試行列が不正です");
      }
      return {
        notificationKey: entry.notificationKey,
        itemNodeId: entry.itemNodeId,
        reasonCode: entry.reasonCode,
        severity: entry.severity,
        reservedAt: entry.reservedAt,
        status: "delivery_started",
        deliveryId: target.deliveryId,
        startedAt: attempt.startedAt,
        lastDeliveryAttempt: { ...attempt, notificationKeys: [...attempt.notificationKeys] },
      };
    }
    const prior = entry.lastDeliveryAttempt;
    if (
      entry.status !== "delivery_started" ||
      entry.deliveryId !== target.deliveryId ||
      prior?.result !== "started" ||
      prior.attemptId !== attempt.attemptId ||
      prior.operationId !== attempt.operationId ||
      prior.durableAttemptSequence !== attempt.durableAttemptSequence ||
      prior.startedAt !== attempt.startedAt ||
      !same(prior.notificationKeys, attempt.notificationKeys) ||
      attempt.completedAt == null ||
      attempt.completedAt < attempt.startedAt ||
      (attempt.result === "sent" && attempt.discordMessageId == null) ||
      (attempt.result === "clear_rejection" && attempt.discordMessageId != null)
    ) {
      throw new TypeError("送達結果が開始済み試行と一致しません");
    }
    const base = {
      notificationKey: entry.notificationKey,
      itemNodeId: entry.itemNodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: entry.reservedAt,
      lastDeliveryAttempt: { ...attempt, notificationKeys: [...attempt.notificationKeys] },
    };
    if (attempt.result === "sent") {
      const discordMessageId = attempt.discordMessageId;
      if (discordMessageId == null) {
        throw new TypeError("送信済みmessageのDiscord IDがありません");
      }
      return {
        ...base,
        status: "sent",
        sentAt: attempt.completedAt,
        discordMessageId,
      };
    }
    return { ...base, status: "reserved", expiresAt: reservation.expiresAt };
  });
  return createStateNotificationLedger({
    schemaVersion: ledger.schemaVersion,
    entries,
    operationsAlerts: ledger.operationsAlerts,
    pendingNotifications:
      attempt.result === "sent"
        ? ledger.pendingNotifications.filter((pending) => !keys.has(pending.notificationKey))
        : ledger.pendingNotifications,
  });
}

/** 親ledger、固定outbox、型付き手動判断から一messageのledgerを導出する。 */
export function transitionManualNotificationLedger(
  ledger: StateNotificationLedger,
  record: DurablePublicationRecord,
  resolution: NotificationManualResolution,
  notificationKeys: readonly string[],
): StateNotificationLedger {
  const keys = new Set(notificationKeys);
  const reservations = reservationMap(record);
  if (keys.size === 0 || keys.size !== notificationKeys.length) {
    throw new TypeError("手動解決の対象keyが重複または空です");
  }
  const entries = ledger.entries.map((entry): StateNotificationLedger["entries"][number] => {
    if (!keys.has(entry.notificationKey)) {
      return entry;
    }
    const reservation = reservations.get(entry.notificationKey);
    const attempt = entry.lastDeliveryAttempt;
    if (
      reservation?.status !== "reserved" ||
      entry.status !== "delivery_started" ||
      entry.deliveryId !== resolution.deliveryId ||
      attempt?.result !== "started" ||
      attempt.attemptId !== resolution.attemptId ||
      !same(attempt.notificationKeys, notificationKeys) ||
      entry.manualResolution != null ||
      resolution.resolvedAt < attempt.startedAt ||
      entry.itemNodeId !== reservation.itemNodeId ||
      entry.reasonCode !== reservation.reasonCode ||
      entry.severity !== reservation.severity ||
      entry.reservedAt !== reservation.reservedAt
    ) {
      throw new TypeError("手動解決の親ledgerが開始済み試行と一致しません");
    }
    const base = {
      notificationKey: entry.notificationKey,
      itemNodeId: entry.itemNodeId,
      reasonCode: entry.reasonCode,
      severity: entry.severity,
      reservedAt: entry.reservedAt,
      lastDeliveryAttempt: attempt,
      manualResolution: resolution,
    };
    return resolution.decision === "retry"
      ? { ...base, status: "reserved", expiresAt: reservation.expiresAt }
      : { ...base, status: "acknowledged", acknowledgedAt: resolution.resolvedAt };
  });
  if (entries.filter((entry) => keys.has(entry.notificationKey)).length !== keys.size) {
    throw new TypeError("手動解決の対象keyが親ledgerにありません");
  }
  return createStateNotificationLedger({
    schemaVersion: ledger.schemaVersion,
    entries,
    operationsAlerts: ledger.operationsAlerts,
    pendingNotifications:
      resolution.decision === "retry"
        ? ledger.pendingNotifications
        : ledger.pendingNotifications.filter((pending) => !keys.has(pending.notificationKey)),
  });
}

/** 親markerと導出済みledgerから一つの通知commit markerを作る。 */
export function advanceMessageMarker(
  previous: RunTransactionMarker,
  ledger: StateNotificationLedger,
  evidence: InitialPagesPublicationEvidence,
  initialStateRevision: string,
  parentRevision: string,
  deliveryId: string,
): RunTransactionMarker {
  return parseRunTransactionMarker({
    ...previous,
    phase: "notifications_in_progress",
    phaseSequence: previous.phaseSequence + 1,
    expectedParentStateRevision: parentRevision,
    initialStateRevision,
    initialPagesPublicationEvidenceDigest: evidence.evidenceDigest,
    notificationLedgerDigest: hashCanonicalJson(normalNotificationLedgerValue(ledger)),
    lastMessageDeliveryId: deliveryId,
  });
}

/** 親markerと確定済み通知ledgerからsettlement markerを作る。 */
export function advanceSettlementMarker(
  previous: RunTransactionMarker,
  evidence: InitialPagesPublicationEvidence,
  initialStateRevision: string,
  parentRevision: string,
  notificationLedgerDigest: string,
): RunTransactionMarker {
  return parseRunTransactionMarker({
    ...previous,
    phase: "notifications_settled",
    phaseSequence: previous.phaseSequence + 1,
    expectedParentStateRevision: parentRevision,
    initialStateRevision,
    initialPagesPublicationEvidenceDigest: evidence.evidenceDigest,
    notificationLedgerDigest,
  });
}

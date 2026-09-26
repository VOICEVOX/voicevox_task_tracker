import type { NotificationLedgerEntry, PendingNotification } from "../../../domain/index.js";
import {
  createAcknowledgedNotificationLedgerEntries,
  selectDiscordNotifications,
  type DiscordNotificationSelection,
} from "../../../discord/index.js";
import type { StateNotificationLedger } from "../../../persistence/index.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import type {
  CollectedItems,
  GraphResult,
  PersonalReminderAnalysis,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { notificationItems } from "./notification-items.js";
import { mergeNotificationLedger, notificationLedgerEntries } from "./notification-ledger.js";

type ValidationNotificationSelection = Readonly<{
  notificationSelection: DiscordNotificationSelection;
  ledgerEntriesToMerge: readonly NotificationLedgerEntry[];
  pendingNotifications: readonly PendingNotification[];
}>;

/** 検証済みrunの通知候補と通知管理記録へ統合する値を選ぶ。 */
export function selectValidationNotifications(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  personalReminderAnalysis: PersonalReminderAnalysis,
): ValidationNotificationSelection {
  const notificationInput = {
    evaluatedAt: collection.evaluatedAt,
    items: notificationItems(
      configuration,
      state,
      inventory,
      collection,
      reduction,
      graph,
      personalReminderAnalysis,
    ),
    ledger: notificationLedgerEntries(state, reduction.items),
    pendingNotifications: state.notificationLedger.pendingNotifications,
    settings: {
      maxItemsPerDigest: configuration.config.notifications.discord.maxItemsPerDigest,
      recentProgressGraceHours: configuration.config.staleness.recentProgressGraceHours,
      minimumAiConfidence: configuration.config.ai.confidence.medium,
    },
  };
  const notificationAction =
    invocation.command.kind === "dry-run" ? "send" : invocation.command.notificationAction;
  const emptyCandidates: readonly [] = Object.freeze([]);
  const emptyLedgerReservations: readonly [] = Object.freeze([]);
  const acknowledgedNotificationLedgerEntries =
    notificationAction === "acknowledge-current"
      ? createAcknowledgedNotificationLedgerEntries(notificationInput)
      : Object.freeze([]);
  const recalculatedSelection = selectDiscordNotifications(notificationInput);
  let notificationSelection: DiscordNotificationSelection;
  if (notificationAction === "acknowledge-current") {
    const acknowledgedKeys = new Set(
      acknowledgedNotificationLedgerEntries.map((entry) => entry.notificationKey),
    );
    const pendingNotifications = recalculatedSelection.pendingNotifications.filter(
      (pending) => !acknowledgedKeys.has(pending.notificationKey),
    );
    notificationSelection = Object.freeze({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: emptyCandidates,
      ledgerReservations: emptyLedgerReservations,
      pendingNotifications: Object.freeze(pendingNotifications),
    });
  } else if (notificationAction === "hold") {
    notificationSelection = Object.freeze({
      action: "skip_digest",
      reason: "held",
      candidates: emptyCandidates,
      ledgerReservations: emptyLedgerReservations,
      pendingNotifications: recalculatedSelection.pendingNotifications,
    });
  } else {
    notificationSelection = recalculatedSelection;
  }
  const notificationLedgerEntriesToMerge =
    notificationAction === "acknowledge-current"
      ? acknowledgedNotificationLedgerEntries
      : notificationSelection.ledgerReservations;
  const notificationPendingToMerge = notificationSelection.pendingNotifications;
  return Object.freeze({
    notificationSelection,
    ledgerEntriesToMerge: notificationLedgerEntriesToMerge,
    pendingNotifications: notificationPendingToMerge,
  });
}

/** 選別済み通知を通知管理記録へ統合する。 */
export function mergeSelectedNotificationLedger(
  state: RuntimeState,
  notification: ValidationNotificationSelection,
): StateNotificationLedger {
  return mergeNotificationLedger(
    state,
    notification.ledgerEntriesToMerge,
    notification.pendingNotifications,
  );
}

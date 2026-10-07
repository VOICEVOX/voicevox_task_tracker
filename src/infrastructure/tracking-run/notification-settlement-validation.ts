import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type {
  ManualResolutionReceipt,
  NotificationMessageReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { hashCanonicalJson } from "../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { PreparedDiscordDigestMessage } from "../../discord/payload-contracts.js";
import { buildDiscordDigestPlan } from "../../discord/payload.js";
import type { StatePersistenceConfiguration } from "../../persistence/branch-adapter.js";
import { joinStatePath } from "../../persistence/branch-adapter.js";
import {
  appendStateHistoryNotificationEvents,
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
} from "../../persistence/history.js";
import type { StateNotificationLedger } from "../../persistence/state-documents.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { normalNotificationLedgerValue, sortByKey } from "../../publication/publication-order.js";
import {
  createNotificationHistoryContext,
  createNotificationHistoryEventsForMessage,
} from "../../persistence/notification-history-events.js";
import { notificationLedgerEntry } from "../../persistence/notification-ledger-normalization.js";
import { restoreNotificationSelection } from "./notification-message-context.js";
import type { NotificationMessageState } from "./notification-message-state.js";
import { NotificationStructureError } from "./notification-structure-error.js";

function same(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function historySource(
  state: NotificationMessageState,
  configuration: StatePersistenceConfiguration,
): string {
  const path = joinStatePath(
    configuration.historyDirectory,
    `${state.snapshot.generatedAt.slice(0, 10)}.jsonl`,
  );
  const file = state.files.get(path);
  if (file?.status !== "present") {
    throw new NotificationStructureError("通知settlementの履歴fileがありません", "no_effect");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  if (serializeStateHistoryRecords(parseStateHistoryRecords(source)) !== source) {
    throw new NotificationStructureError(
      "通知settlementの履歴fileがcanonical形式ではありません",
      "no_effect",
    );
  }
  return source;
}

/** 固定outboxと保存済みsnapshotから送信message列を作る。 */
export function plannedNotificationMessages(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  evidence: InitialPagesPublicationEvidence,
): readonly PreparedDiscordDigestMessage[] {
  const outbox = record.notificationOutbox;
  if (outbox.action !== "send") {
    return Object.freeze([]);
  }
  if (outbox.selectedContext.action === "skip_digest") {
    if (outbox.delivery !== "no_candidates" || outbox.selectedContext.reason !== "no_candidates") {
      throw new NotificationStructureError("送信0件の固定outboxが一致しません", "no_effect");
    }
    return Object.freeze([]);
  }
  if (outbox.delivery !== "send" || !outbox.settings.enabled) {
    throw new NotificationStructureError("送信actionの固定outboxが一致しません", "no_effect");
  }
  const selection = restoreNotificationSelection(record);
  const plan = buildDiscordDigestPlan({
    candidates: selection.candidates,
    ledgerReservations: selection.ledgerReservations,
    items: initial.snapshot.items,
    pagesUrl: evidence.pageUrl,
    generatedAt: initial.snapshot.generatedAt,
    mentions: outbox.settings.mentions,
  });
  const plannedKeys = plan.messages.flatMap((message) => message.notificationKeys);
  const reservedKeys = selection.ledgerReservations.map((entry) => entry.notificationKey);
  if (
    plan.messages.length === 0 ||
    new Set(plannedKeys).size !== plannedKeys.length ||
    !same([...plannedKeys].sort(), [...reservedKeys].sort())
  ) {
    throw new NotificationStructureError(
      "送信messageと固定outboxのkey集合が一致しません",
      "no_effect",
    );
  }
  return plan.messages;
}

/** 初回ledgerと非送信actionの保存値を照合する。 */
export function assertInitialNotificationLedger(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  previous: StateNotificationLedger,
): void {
  const outbox = record.notificationOutbox;
  if (
    initial.transaction.marker.phase !== "initial_state_committed" ||
    initial.transaction.notificationLedgerDigest !== outbox.initialLedgerDigest ||
    initial.snapshot.run.id !== record.runIdentity.runId ||
    hashCanonicalJson(normalNotificationLedgerValue(previous)) !== outbox.previousLedgerDigest
  ) {
    throw new NotificationStructureError(
      "通知settlementの初回ledgerまたはrunが一致しません",
      "no_effect",
    );
  }
  if (outbox.action === "send") {
    if (
      !same(
        sortByKey(initial.ledger.pendingNotifications, (pending) => pending.notificationKey),
        sortByKey(
          outbox.selectedContext.pendingNotifications,
          (pending) => pending.notificationKey,
        ),
      )
    ) {
      throw new NotificationStructureError(
        "送信actionの未送信候補が固定outboxと一致しません",
        "no_effect",
      );
    }
    return;
  }
  if (
    !same(initial.ledger.pendingNotifications, outbox.pendingNotifications) ||
    initial.ledger.entries.some((entry) => entry.status === "delivery_started")
  ) {
    throw new NotificationStructureError(
      "非送信actionの未送信候補またはledger状態が一致しません",
      "no_effect",
    );
  }
  if (outbox.action === "hold") {
    if (!same(initial.ledger.entries, previous.entries)) {
      throw new NotificationStructureError(
        "保留actionで通常ledger entryが変化しています",
        "no_effect",
      );
    }
    return;
  }
  const acknowledgements = new Map(
    outbox.acknowledgedEntries.map((entry) => [entry.notificationKey, entry]),
  );
  const previousEntries = new Map(previous.entries.map((entry) => [entry.notificationKey, entry]));
  for (const entry of initial.ledger.entries) {
    const acknowledged = acknowledgements.get(entry.notificationKey);
    const old = previousEntries.get(entry.notificationKey);
    if (
      (acknowledged != null && !same(entry, acknowledged)) ||
      (entry.status === "acknowledged" && old?.status !== "acknowledged" && acknowledged == null) ||
      ((old?.status === "sent" || old?.status === "acknowledged") && !same(entry, old)) ||
      (acknowledged == null && (old == null || !same(entry, old)))
    ) {
      throw new NotificationStructureError(
        "確認済みactionの初回ledger遷移が固定outboxと一致しません",
        "no_effect",
      );
    }
  }
  if (
    [...acknowledgements.keys()].some(
      (key) => !initial.ledger.entries.some((entry) => entry.notificationKey === key),
    )
  ) {
    throw new NotificationStructureError(
      "確認済みactionのacknowledged entryがledgerにありません",
      "no_effect",
    );
  }
  if (
    previous.entries.some(
      (entry) =>
        !initial.ledger.entries.some(
          (current) => current.notificationKey === entry.notificationKey,
        ),
    )
  ) {
    throw new NotificationStructureError(
      "確認済みactionで既存のledger entryが消えています",
      "no_effect",
    );
  }
}

/** 全message結果と最終ledgerおよび履歴を照合する。 */
export function assertSettledNotificationContent(
  record: DurablePublicationRecord,
  initial: NotificationMessageState,
  current: NotificationMessageState,
  messages: readonly PreparedDiscordDigestMessage[],
  receipts: readonly (NotificationMessageReceipt | ManualResolutionReceipt)[],
  configuration: StatePersistenceConfiguration,
): Readonly<{ ledgerDigest: string; historyDigest: string; notificationCount: number }> {
  if (
    current.transaction.record.recordDigest !== record.recordDigest ||
    current.snapshot.run.id !== record.runIdentity.runId ||
    !same(current.snapshot, initial.snapshot) ||
    messages.length !== receipts.length
  ) {
    throw new NotificationStructureError(
      "通知settlementのrun、snapshotまたはmessage件数が一致しません",
      "no_effect",
    );
  }
  const initialEntries = new Map(
    initial.ledger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const currentEntries = new Map(
    current.ledger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const selectedKeys = new Set(messages.flatMap((message) => message.notificationKeys));
  const sentKeys = new Set<string>();
  if (
    initialEntries.size !== currentEntries.size ||
    initialEntries.size !== initial.ledger.entries.length ||
    currentEntries.size !== current.ledger.entries.length
  ) {
    throw new NotificationStructureError(
      "通知settlementのledger entry集合が変化しています",
      "no_effect",
    );
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const receipt = receipts[index];
    if (
      message == null ||
      receipt == null ||
      (receipt.receiptType === "notification_message" && receipt.status === "ambiguous") ||
      (receipt.receiptType === "notification_message" &&
        receipt.logicalTarget !== `message:${(index + 1).toString()}`) ||
      (receipt.receiptType === "manual_resolution" &&
        (receipt.result.decision !== "acknowledge" ||
          !receipt.result.deliveryId.endsWith(`:message:${(index + 1).toString()}`))) ||
      !same(message.notificationKeys, receipt.result.notificationKeys)
    ) {
      throw new NotificationStructureError(
        "通知settlementに未確定またはoutbox外のmessageがあります",
        "no_effect",
      );
    }
    let firstAttempt:
      NonNullable<(typeof current.ledger.entries)[number]["lastDeliveryAttempt"]> | undefined;
    for (const key of message.notificationKeys) {
      const before = initialEntries.get(key);
      const after = currentEntries.get(key);
      if (before?.status !== "reserved" || after?.lastDeliveryAttempt == null) {
        throw new NotificationStructureError(
          "通知settlementの全keyに送達試行がありません",
          "no_effect",
        );
      }
      const attempt = after.lastDeliveryAttempt;
      if (receipt.receiptType === "manual_resolution") {
        if (
          after.status !== "acknowledged" ||
          attempt.result !== "started" ||
          attempt.attemptId !== receipt.result.deliveryAttemptId ||
          after.manualResolution?.operationId !== receipt.operationId ||
          after.manualResolution.decision !== "acknowledge" ||
          after.acknowledgedAt !== receipt.effectOccurredAt ||
          after.itemNodeId !== before.itemNodeId ||
          after.reasonCode !== before.reasonCode ||
          after.severity !== before.severity ||
          after.reservedAt !== before.reservedAt
        ) {
          throw new NotificationStructureError(
            "手動確認済みmessageと最終ledgerが一致しません",
            "no_effect",
          );
        }
        continue;
      }
      if (
        attempt.operationId !== receipt.operationId ||
        (receipt.receiptKind === "executed" && attempt.attemptId !== receipt.attemptId) ||
        attempt.durableAttemptSequence !== receipt.durableAttemptSequence ||
        !same(attempt.notificationKeys, message.notificationKeys) ||
        attempt.completedAt !== receipt.effectOccurredAt ||
        (firstAttempt != null && !same(attempt, firstAttempt)) ||
        after.itemNodeId !== before.itemNodeId ||
        after.reasonCode !== before.reasonCode ||
        after.severity !== before.severity ||
        after.reservedAt !== before.reservedAt
      ) {
        throw new NotificationStructureError(
          "通知settlementの全keyに同じ送達試行がありません",
          "no_effect",
        );
      }
      firstAttempt = attempt;
      if (receipt.status === "sent") {
        if (
          after.status !== "sent" ||
          attempt.result !== "sent" ||
          after.discordMessageId !== receipt.result.discordMessageId ||
          attempt.discordMessageId !== receipt.result.discordMessageId ||
          after.sentAt !== attempt.completedAt
        ) {
          throw new NotificationStructureError(
            "送信済みmessageと最終ledgerが一致しません",
            "no_effect",
          );
        }
        sentKeys.add(key);
      } else if (
        after.status !== "reserved" ||
        attempt.result !== "clear_rejection" ||
        after.expiresAt !== before.expiresAt ||
        attempt.completedAt == null
      ) {
        throw new NotificationStructureError(
          "明確拒否messageと最終ledgerが一致しません",
          "no_effect",
        );
      }
    }
  }
  for (const [key, before] of initialEntries) {
    const after = currentEntries.get(key);
    if (!selectedKeys.has(key) && (after == null || !same(after, before))) {
      throw new NotificationStructureError(
        "固定outbox外のledger entryが変化しています",
        "no_effect",
      );
    }
  }
  const acknowledgedKeys = new Set(
    receipts
      .filter((receipt) => receipt.receiptType === "manual_resolution")
      .flatMap((receipt) => receipt.result.notificationKeys),
  );
  const expectedPending = initial.ledger.pendingNotifications.filter(
    (pending) =>
      !sentKeys.has(pending.notificationKey) && !acknowledgedKeys.has(pending.notificationKey),
  );
  if (!same(current.ledger.pendingNotifications, expectedPending)) {
    throw new NotificationStructureError(
      "通知settlementの未送信候補が送達結果と一致しません",
      "no_effect",
    );
  }
  let expectedHistory = historySource(initial, configuration);
  if (record.notificationOutbox.action === "send" && messages.length > 0) {
    const context = createNotificationHistoryContext(
      initial.snapshot,
      restoreNotificationSelection(record),
    );
    for (const receipt of receipts) {
      if (receipt.status !== "sent") {
        continue;
      }
      const entries = receipt.result.notificationKeys.map((key) => {
        const entry = currentEntries.get(key);
        if (entry == null) {
          throw new NotificationStructureError(
            "送信済み通知のledger entryがありません",
            "no_effect",
          );
        }
        return notificationLedgerEntry(entry);
      });
      const events = createNotificationHistoryEventsForMessage(initial.snapshot, context, entries);
      expectedHistory = appendStateHistoryNotificationEvents(
        expectedHistory,
        record.runIdentity.runId,
        events,
      );
    }
  }
  const actualHistory = historySource(current, configuration);
  if (expectedHistory !== actualHistory) {
    throw new NotificationStructureError(
      "通知settlementの送信履歴がmessage結果と一致しません",
      "no_effect",
    );
  }
  const records = parseStateHistoryRecords(actualHistory);
  const matching = records.filter((item) => item.runId === record.runIdentity.runId);
  if (matching.length !== 1) {
    throw new NotificationStructureError(
      "通知settlementのrun履歴が一意ではありません",
      "no_effect",
    );
  }
  return Object.freeze({
    ledgerDigest: hashCanonicalJson(normalNotificationLedgerValue(current.ledger)),
    historyDigest: hashCanonicalJson(matching[0]),
    notificationCount: sentKeys.size,
  });
}

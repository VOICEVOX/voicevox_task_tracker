import { receiptIdentifiers } from "../application/tracking-run/receipt-codec.js";
import { canonicalJsonEquals, serializeCanonicalJson } from "../canonical-json/value.js";
import { buildDiscordDigestPlan } from "../discord/payload.js";
import type { NotificationManualResolution } from "../domain/notification-delivery-attempt.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";
import { joinStatePath, type StatePersistenceConfiguration } from "./branch-adapter.js";
import { appendStateHistoryNotificationEvents } from "./history.js";
import { notificationLedgerEntry } from "./notification-ledger-normalization.js";
import { notificationSelectionFromRecord } from "./notification-selection-from-record.js";
import {
  createNotificationHistoryContext,
  createNotificationHistoryEventsForMessage,
} from "./notification-history-events.js";
import { runTransactionSnapshot } from "./state-transaction-files.js";
import { parseRunTransactionNotificationLedger } from "./state-documents.js";
import { createStateCommitOperationId } from "./state-commit-metadata.js";
import {
  advanceMessageMarker,
  transitionManualNotificationLedger,
  transitionNotificationMessageLedger,
} from "./state-notification-transition.js";
import type { VerifiedCommitTree } from "./state-commit-chain-paths.js";

function same(left: unknown, right: unknown): boolean {
  if (left == null || right == null) {
    return left === right;
  }
  return canonicalJsonEquals(left, right);
}

function source(tree: VerifiedCommitTree, path: string): string {
  const file = tree.files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`Git祖先の通知遷移に必要なfileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

function messageIndex(deliveryId: string): number {
  const match = /:message:([1-9][0-9]*)$/u.exec(deliveryId);
  if (match?.[1] == null) {
    throw new TypeError("通知commitのdelivery IDにmessage番号がありません");
  }
  const index = Number(match[1]) - 1;
  if (!Number.isSafeInteger(index)) {
    throw new TypeError("通知commitのmessage番号が安全な整数ではありません");
  }
  return index;
}

function expectedMessageKeys(
  record: DurablePublicationRecord,
  tree: VerifiedCommitTree,
  deliveryId: string,
  actualKeys: readonly string[],
): readonly string[] {
  const index = messageIndex(deliveryId);
  const selection = notificationSelectionFromRecord(record);
  if (tree.transaction.snapshotSchemaVersion !== "23") {
    throw new TypeError("旧通知commitの版別message計画を証明できません");
  }
  const evidence = tree.transaction.initialPagesEvidence;
  const outbox = record.notificationOutbox;
  if (
    evidence?.pageUrl !== record.initialPagesProjection.settings.url ||
    outbox.action !== "send"
  ) {
    throw new TypeError("通知commitのPages証拠が固定outboxと一致しません");
  }
  const value = runTransactionSnapshot(tree.transaction);
  const plan = buildDiscordDigestPlan({
    candidates: selection.candidates,
    ledgerReservations: selection.ledgerReservations,
    items: value.items,
    pagesUrl: evidence.pageUrl,
    generatedAt: value.generatedAt,
    mentions: outbox.settings.mentions,
  });
  const message = plan.messages[index];
  if (
    message == null ||
    deliveryId !== `${plan.digestId}:message:${(index + 1).toString()}` ||
    !same([...message.notificationKeys].sort(), [...actualKeys].sort())
  ) {
    throw new TypeError("通知commitのmessageが固定outboxから導出した値と一致しません");
  }
  return message.notificationKeys;
}

function assertMarkerAndLedger(
  previous: VerifiedCommitTree,
  current: VerifiedCommitTree,
  configuration: StatePersistenceConfiguration,
  deliveryId: string,
  expectedLedger: ReturnType<typeof parseRunTransactionNotificationLedger>["ledger"],
): void {
  const evidence = current.transaction.initialPagesEvidence;
  if (evidence == null) {
    throw new TypeError("通知commitに初回Pages証拠がありません");
  }
  const actualLedger = parseRunTransactionNotificationLedger(
    source(current, configuration.notificationLedgerPath),
  ).ledger;
  const marker = advanceMessageMarker(
    previous.transaction.marker,
    expectedLedger,
    evidence,
    evidence.sourceStateRevision,
    current.transaction.marker.expectedParentStateRevision,
    deliveryId,
  );
  if (
    !same(actualLedger, expectedLedger) ||
    !same(current.transaction.marker, marker) ||
    (previous.transaction.initialPagesEvidence != null &&
      !same(previous.transaction.initialPagesEvidence, evidence))
  ) {
    throw new TypeError(
      "通知commitのledger、pending、markerまたはPages証拠が親stateと一致しません",
    );
  }
}

function manualOperationId(
  record: DurablePublicationRecord,
  deliveryId: string,
  attemptId: string,
  decision: NotificationManualResolution["decision"],
): string {
  return receiptIdentifiers(
    {
      binding: {
        bindingKind: "checkpoint",
        runId: record.runIdentity.runId,
        checkpointDigest: record.checkpointDigest,
        checkpointFileDigest: record.checkpointFileDigest,
        runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
          serializeCanonicalJson(record.runtimeIdentity),
        ),
      },
      stage: "notifications_settled",
      phase: "notification",
      logicalTarget: `manual:${record.checkpointDigest}:${deliveryId}:${attemptId}:${decision}`,
      invocationId: record.runIdentity.invocationId,
      localAttemptIndex: 0,
    },
    nodeContentDigestPort,
  ).operationId;
}

/** 親exact treeと固定outboxから通知commitの全変更値を再導出する。 */
export function assertNotificationCommitTransition(
  previous: VerifiedCommitTree,
  current: VerifiedCommitTree,
  configuration: StatePersistenceConfiguration,
  scope: "tracking_run" | "manual_resolution",
  operationId: string,
): void {
  if (
    current.transaction.marker.phase !== "notifications_in_progress" ||
    (previous.transaction.marker.phase !== "initial_state_committed" &&
      previous.transaction.marker.phase !== "notifications_in_progress")
  ) {
    throw new TypeError("通知commitのphaseが不正です");
  }
  const record = current.transaction.record;
  const prior = parseRunTransactionNotificationLedger(
    source(previous, configuration.notificationLedgerPath),
  ).ledger;
  const next = parseRunTransactionNotificationLedger(
    source(current, configuration.notificationLedgerPath),
  ).ledger;
  const before = new Map(prior.entries.map((entry) => [entry.notificationKey, entry]));
  if (before.size !== prior.entries.length || next.entries.length !== prior.entries.length) {
    throw new TypeError("通知commitのledger entry集合が変化しています");
  }
  if (scope === "manual_resolution") {
    if (previous.transaction.marker.phase !== "notifications_in_progress") {
      throw new TypeError("手動解決の前に送達開始済みmarkerが必要です");
    }
    const changes = next.entries.filter(
      (entry) => !same(entry.manualResolution, before.get(entry.notificationKey)?.manualResolution),
    );
    const resolution = changes[0]?.manualResolution;
    const firstChange = changes[0];
    if (
      resolution == null ||
      firstChange == null ||
      resolution.operationId !== operationId ||
      changes.some((entry) => !same(entry.manualResolution, resolution)) ||
      previous.transaction.marker.lastMessageDeliveryId !== resolution.deliveryId ||
      prior.entries.some(
        (entry) =>
          entry.status === "delivery_started" && entry.deliveryId !== resolution.deliveryId,
      ) ||
      operationId !==
        manualOperationId(record, resolution.deliveryId, resolution.attemptId, resolution.decision)
    ) {
      throw new TypeError("手動解決commitの判断またはoperation IDが不正です");
    }
    const startedKeys = before.get(firstChange.notificationKey)?.lastDeliveryAttempt
      ?.notificationKeys;
    if (
      startedKeys == null ||
      !same([...startedKeys].sort(), changes.map((entry) => entry.notificationKey).sort())
    ) {
      throw new TypeError("手動解決commitのkey集合が開始済み試行と一致しません");
    }
    const keys = expectedMessageKeys(record, current, resolution.deliveryId, startedKeys);
    const expected = transitionManualNotificationLedger(prior, record, resolution, keys);
    assertMarkerAndLedger(previous, current, configuration, resolution.deliveryId, expected);
    return;
  }
  const changes = next.entries.filter(
    (entry) =>
      !same(entry.lastDeliveryAttempt, before.get(entry.notificationKey)?.lastDeliveryAttempt),
  );
  const attempt = changes[0]?.lastDeliveryAttempt;
  const deliveryId = current.transaction.marker.lastMessageDeliveryId;
  if (
    attempt == null ||
    deliveryId == null ||
    changes.some((entry) => !same(entry.lastDeliveryAttempt, attempt))
  ) {
    throw new TypeError("通知commitの送達試行が一意ではありません");
  }
  const keys = expectedMessageKeys(record, current, deliveryId, attempt.notificationKeys);
  const index = messageIndex(deliveryId);
  const expectedOperationId = receiptIdentifiers(
    {
      binding: {
        bindingKind: "checkpoint",
        runId: record.runIdentity.runId,
        checkpointDigest: record.checkpointDigest,
        checkpointFileDigest: record.checkpointFileDigest,
        runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
          serializeCanonicalJson(record.runtimeIdentity),
        ),
      },
      stage: "notifications_settled",
      phase: "notification",
      logicalTarget: `message:${(index + 1).toString()}`,
      invocationId: record.runIdentity.invocationId,
      localAttemptIndex: 0,
    },
    nodeContentDigestPort,
  ).operationId;
  if (
    !same([...keys].sort(), [...attempt.notificationKeys].sort()) ||
    attempt.operationId !== expectedOperationId ||
    operationId !==
      createStateCommitOperationId({
        kind: "notification_message",
        deliveryOperationId: attempt.operationId,
        deliveryAttemptId: attempt.attemptId,
        transition: attempt.result === "started" ? "reservation" : "result",
      })
  ) {
    throw new TypeError("通知commitの送達試行とoperation IDが固定messageと一致しません");
  }
  const firstKey = keys[0];
  if (firstKey == null) {
    throw new TypeError("通知commitのmessageに対象keyがありません");
  }
  const first = before.get(firstKey);
  const expected = transitionNotificationMessageLedger(
    prior,
    record,
    {
      deliveryId,
      notificationKeys: keys,
      ...(first?.manualResolution?.decision === "retry"
        ? { manualResolutionOperationId: first.manualResolution.operationId }
        : {}),
    },
    attempt,
  );
  assertMarkerAndLedger(previous, current, configuration, deliveryId, expected);
  if (attempt.result === "sent") {
    const value = runTransactionSnapshot(previous.transaction);
    const context = createNotificationHistoryContext(
      value,
      notificationSelectionFromRecord(record),
    );
    const entries = keys.map((key) => {
      const entry = expected.entries.find((candidate) => candidate.notificationKey === key);
      if (entry == null) {
        throw new TypeError("通知commitの送信済みledger entryがありません");
      }
      return notificationLedgerEntry(entry);
    });
    const events = createNotificationHistoryEventsForMessage(value, context, entries);
    const historyPath = joinStatePath(
      configuration.historyDirectory,
      `${record.initialPagesProjection.generatedAt.slice(0, 10)}.jsonl`,
    );
    const expectedHistory = appendStateHistoryNotificationEvents(
      source(previous, historyPath),
      record.runIdentity.runId,
      events,
    );
    if (source(current, historyPath) !== expectedHistory) {
      throw new TypeError("通知commitの履歴eventが送信結果から導出した差分と一致しません");
    }
  }
}

import { canonicalJsonEquals } from "../canonical-json/value.js";
import type { BuildDiscordDigestPlanInput } from "../discord/payload-contracts.js";
import { buildDiscordDigestPlan } from "../discord/payload.js";
import type { DurablePublicationRecord } from "../publication/durable-record-schema.js";
import { notificationSelectionFromRecord } from "./notification-selection-from-record.js";
import { normalNotificationLedgerValue } from "../publication/publication-order.js";
import type { StatePersistenceConfiguration } from "./branch-adapter.js";
import { runTransactionSnapshot } from "./state-transaction-files.js";
import { parseRunTransactionNotificationLedger } from "./state-documents.js";
import type { VerifiedCommitTree } from "./state-commit-chain-paths.js";

function requiredSource(tree: VerifiedCommitTree, path: string): string {
  const file = tree.files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`Git祖先のstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonEquals(left, right);
}

function snapshotForPlan(
  initial: VerifiedCommitTree,
): Pick<BuildDiscordDigestPlanInput, "items" | "generatedAt"> {
  return runTransactionSnapshot(initial.transaction);
}

/** 固定outboxからsettlementへ直接進めるphaseか検証する。 */
export function assertSettlementParentPhase(
  record: DurablePublicationRecord,
  previousPhase: VerifiedCommitTree["transaction"]["marker"]["phase"],
): void {
  const planned =
    record.notificationOutbox.action === "send" &&
    record.notificationOutbox.selectedContext.action === "create_digest";
  if (
    (planned && previousPhase !== "notifications_in_progress") ||
    (!planned && previousPhase !== "initial_state_committed")
  ) {
    throw new TypeError("固定outboxと通知settlementのphase経路が一致しません");
  }
}

/** 初回ledgerと全予定messageの終端結果をsettlementのexact treeで照合する。 */
export function assertSettledOutboxLedger(
  initial: VerifiedCommitTree,
  settled: VerifiedCommitTree,
  configuration: StatePersistenceConfiguration,
): void {
  const record = initial.transaction.record;
  const outbox = record.notificationOutbox;
  const initialLedger = parseRunTransactionNotificationLedger(
    requiredSource(initial, configuration.notificationLedgerPath),
  ).ledger;
  const settledLedger = parseRunTransactionNotificationLedger(
    requiredSource(settled, configuration.notificationLedgerPath),
  ).ledger;
  if (
    settled.transaction.marker.phase !== "notifications_settled" ||
    settled.transaction.record.recordDigest !== record.recordDigest ||
    initial.transaction.notificationLedgerDigest !== outbox.initialLedgerDigest
  ) {
    throw new TypeError("固定outboxと通知settlementのstateが一致しません");
  }
  if (outbox.action !== "send" || outbox.selectedContext.action !== "create_digest") {
    if (outbox.action === "send") {
      const selected = outbox.selectedContext;
      if (
        selected.action !== "skip_digest" ||
        outbox.delivery !== "no_candidates" ||
        selected.reason !== "no_candidates"
      ) {
        throw new TypeError("送信0件の固定outboxが一致しません");
      }
    }
    if (
      !same(
        normalNotificationLedgerValue(initialLedger),
        normalNotificationLedgerValue(settledLedger),
      )
    ) {
      throw new TypeError("送信0件の通知settlementで通常ledgerが変化しています");
    }
    return;
  }
  if (outbox.delivery !== "send" || !outbox.settings.enabled) {
    throw new TypeError("送信予定の固定outbox設定が一致しません");
  }
  if (initial.transaction.snapshotSchemaVersion !== "23") {
    throw new TypeError("旧通知settlementの版別message計画を証明できません");
  }
  const evidence = settled.transaction.initialPagesEvidence;
  if (evidence?.pageUrl !== record.initialPagesProjection.settings.url) {
    throw new TypeError("予定messageの初回Pages証拠が固定runと一致しません");
  }
  const reservations = new Map(
    outbox.selectedContext.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  const before = new Map(initialLedger.entries.map((entry) => [entry.notificationKey, entry]));
  const after = new Map(settledLedger.entries.map((entry) => [entry.notificationKey, entry]));
  const candidateKeys = outbox.selectedContext.candidates.flatMap((candidate) =>
    candidate.reasons.map((reason) => reason.notificationKey),
  );
  if (
    new Set(candidateKeys).size !== candidateKeys.length ||
    !same([...candidateKeys].sort(), [...reservations.keys()].sort())
  ) {
    throw new TypeError("固定outboxの候補と予約key集合が一致しません");
  }
  const snapshot = snapshotForPlan(initial);
  if (snapshot.generatedAt !== record.initialPagesProjection.generatedAt) {
    throw new TypeError("固定outboxの生成時刻が初回snapshotと一致しません");
  }
  const plan = buildDiscordDigestPlan({
    candidates: notificationSelectionFromRecord(record).candidates,
    ledgerReservations: outbox.selectedContext.ledgerReservations,
    items: snapshot.items,
    pagesUrl: evidence.pageUrl,
    generatedAt: snapshot.generatedAt,
    mentions: outbox.settings.mentions,
  });
  const groups = plan.messages.map((message) => message.notificationKeys);
  const plannedKeys = groups.flatMap((keys) => keys);
  if (
    groups.length === 0 ||
    new Set(plannedKeys).size !== plannedKeys.length ||
    !same([...plannedKeys].sort(), [...reservations.keys()].sort()) ||
    before.size !== initialLedger.entries.length ||
    after.size !== settledLedger.entries.length ||
    before.size !== after.size
  ) {
    throw new TypeError("固定outboxの全messageと通常ledger key集合が一致しません");
  }
  const completedKeys = new Set<string>();
  for (const [index, keys] of groups.entries()) {
    const firstKey = keys[0];
    if (firstKey == null) {
      throw new TypeError("固定outboxにkeyのないmessageがあります");
    }
    const deliveryId = `${plan.digestId}:message:${(index + 1).toString()}`;
    let groupAttempt: (typeof settledLedger.entries)[number]["lastDeliveryAttempt"];
    let groupStatus: (typeof settledLedger.entries)[number]["status"] | undefined;
    let groupResolution: (typeof settledLedger.entries)[number]["manualResolution"];
    for (const key of keys) {
      const reservation = reservations.get(key);
      const oldEntry = before.get(key);
      const entry = after.get(key);
      const attempt = entry?.lastDeliveryAttempt;
      if (
        reservation?.status !== "reserved" ||
        oldEntry?.status !== "reserved" ||
        entry == null ||
        attempt == null ||
        !same(oldEntry, reservation) ||
        !same(attempt.notificationKeys, keys) ||
        entry.itemNodeId !== oldEntry.itemNodeId ||
        entry.reasonCode !== oldEntry.reasonCode ||
        entry.severity !== oldEntry.severity ||
        entry.reservedAt !== oldEntry.reservedAt ||
        (groupAttempt != null && !same(attempt, groupAttempt)) ||
        (groupStatus != null && entry.status !== groupStatus) ||
        (groupStatus === "acknowledged" && !same(entry.manualResolution, groupResolution))
      ) {
        throw new TypeError("固定outboxのmessageと送達試行が一致しません");
      }
      groupAttempt = attempt;
      groupStatus = entry.status;
      groupResolution = entry.manualResolution;
      if (entry.status === "sent") {
        if (
          attempt.result !== "sent" ||
          entry.sentAt !== attempt.completedAt ||
          entry.discordMessageId !== attempt.discordMessageId ||
          entry.manualResolution != null
        ) {
          throw new TypeError("予定messageの送信済みledger結果が不正です");
        }
        completedKeys.add(key);
      } else if (entry.status === "acknowledged") {
        if (
          attempt.result !== "started" ||
          entry.manualResolution?.decision !== "acknowledge" ||
          entry.manualResolution.deliveryId !== deliveryId ||
          entry.manualResolution.attemptId !== attempt.attemptId ||
          entry.acknowledgedAt !== entry.manualResolution.resolvedAt
        ) {
          throw new TypeError("予定messageの手動確認ledger結果が不正です");
        }
        completedKeys.add(key);
      } else if (
        entry.status !== "reserved" ||
        attempt.result !== "clear_rejection" ||
        attempt.completedAt == null ||
        entry.expiresAt !== reservation.expiresAt ||
        entry.manualResolution != null
      ) {
        throw new TypeError("予定messageの明確拒否ledger結果が不正です");
      }
    }
  }
  for (const [key, oldEntry] of before) {
    const entry = after.get(key);
    if (entry == null || (!plannedKeys.includes(key) && !same(entry, oldEntry))) {
      throw new TypeError("固定outbox外の通常ledger entryが変化しています");
    }
  }
  const expectedPending = initialLedger.pendingNotifications.filter(
    (pending) => !completedKeys.has(pending.notificationKey),
  );
  if (!same(settledLedger.pendingNotifications, expectedPending)) {
    throw new TypeError("通知settlementの未送信候補が全message結果と一致しません");
  }
}

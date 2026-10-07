import { hashCanonicalJson } from "../canonical-json/index.js";
import type { DiscordDigestDelivery } from "../discord/delivery.js";
import type {
  DiscordNotificationCandidate,
  DiscordNotificationSelection,
} from "../discord/notification-selection-contracts.js";
import {
  createNotificationReason,
  type GitHubNodeId,
  type NotificationLedgerEntry,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertConfirmedPersonalReminderTimeBasis } from "../domain/personal-reminder-causes.js";
import { UnreachableError, assertNonNullable } from "../util/index.js";
import { resolveStateHistoryNotificationItemDisplayReference } from "./history-contracts.js";
import type { StateHistoryNotificationEvent } from "./history-contracts.js";
import {
  version19SnapshotFields as version21Fields,
  type StateSnapshot as StateSnapshotV21,
} from "./snapshot-v21.js";
import {
  version19SnapshotFields as version22Fields,
  type StateSnapshot as StateSnapshotV22,
} from "./snapshot-v22.js";
import {
  version19SnapshotFields as version23Fields,
  type StateSnapshot as StateSnapshotV23,
} from "./snapshot-v23.js";

type StateSnapshot = StateSnapshotV21 | StateSnapshotV22 | StateSnapshotV23;

function version19SnapshotFields(snapshot: StateSnapshot): ReturnType<typeof version23Fields> {
  switch (snapshot.schemaVersion) {
    case "21":
      return version21Fields(snapshot);
    case "22":
      return version22Fields(snapshot);
    case "23":
      return version23Fields(snapshot);
  }
}

function createNotificationWaitingOn(
  item: StateSnapshot["items"][number],
  snapshot: StateSnapshot,
): StateHistoryNotificationEvent["waitingOn"] {
  if (item.waitingOn.length === 0) {
    throw new TypeError("通知送信eventの対象itemにwaitingOnがありません");
  }
  type NotificationWaitingOnReference = Extract<
    StateHistoryNotificationEvent["waitingOn"],
    Readonly<{ status: "recorded" }>
  >["values"][number];
  const values = item.waitingOn.map((waitingOn): NotificationWaitingOnReference => {
    switch (waitingOn.kind) {
      case "user":
        return {
          kind: "user",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "team":
        return {
          kind: "team",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "role":
        return {
          kind: "role",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "item": {
        return {
          kind: "item",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
          displayReference: resolveStateHistoryNotificationItemDisplayReference(
            version19SnapshotFields(snapshot),
            waitingOn.candidateId,
          ),
        };
      }
      case "automation":
        return {
          kind: "automation",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      case "unknown":
        return {
          kind: "unknown",
          candidateId: waitingOn.candidateId,
          role: waitingOn.role,
        };
      default:
        throw new UnreachableError(waitingOn.kind);
    }
  });
  return {
    status: "recorded",
    values,
  };
}

/** 通知送信結果を履歴へ照合する文脈。 */
export type NotificationHistoryContext = Readonly<{
  candidateByNodeId: ReadonlyMap<GitHubNodeId, DiscordNotificationCandidate>;
  itemByNodeId: ReadonlyMap<GitHubNodeId, StateSnapshot["items"][number]>;
  candidateMessageIds: Map<GitHubNodeId, string>;
  sentNotificationKeys: Set<string>;
}>;

/** 通知候補とsnapshotから履歴照合文脈を作る。 */
export function createNotificationHistoryContext(
  snapshot: StateSnapshot,
  selection: DiscordNotificationSelection,
): NotificationHistoryContext {
  const candidateByNodeId = new Map<GitHubNodeId, DiscordNotificationCandidate>(
    selection.candidates.map((candidate) => [candidate.itemNodeId, candidate]),
  );
  if (candidateByNodeId.size !== selection.candidates.length) {
    throw new TypeError("通知候補のitem node IDが重複しています");
  }
  const itemByNodeId = new Map<GitHubNodeId, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  if (itemByNodeId.size !== snapshot.items.length) {
    throw new TypeError("snapshotのitem node IDが重複しています");
  }
  return {
    candidateByNodeId,
    itemByNodeId,
    candidateMessageIds: new Map(),
    sentNotificationKeys: new Set(),
  };
}

/** 送信済み通知ledgerのentry。 */
export type SentNotificationLedgerEntry = Extract<NotificationLedgerEntry, { status: "sent" }>;

/** 一つのDiscord messageから履歴eventを作る。 */
export function createNotificationHistoryEventsForMessage(
  snapshot: StateSnapshot,
  context: NotificationHistoryContext,
  entries: readonly NotificationLedgerEntry[],
): readonly StateHistoryNotificationEvent[] {
  const firstEntry = entries[0];
  assertNonNullable(firstEntry, "Discord送信結果にledger entryがありません");
  if (firstEntry.status !== "sent") {
    throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
  }
  const discordMessageId = firstEntry.discordMessageId;
  const entriesByMessageAndItem = new Map<GitHubNodeId, SentNotificationLedgerEntry[]>();
  const messageNotificationKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "sent") {
      throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
    }
    if (entry.discordMessageId !== discordMessageId) {
      throw new TypeError("同じDiscord messageの送信結果に異なるmessage IDがあります");
    }
    if (
      context.sentNotificationKeys.has(entry.notificationKey) ||
      messageNotificationKeys.has(entry.notificationKey)
    ) {
      throw new TypeError("Discord送信結果のnotification keyが重複しています");
    }
    messageNotificationKeys.add(entry.notificationKey);
    const itemEntries = entriesByMessageAndItem.get(entry.itemNodeId);
    if (itemEntries == null) {
      entriesByMessageAndItem.set(entry.itemNodeId, [entry]);
    } else {
      itemEntries.push(entry);
    }
  }
  const candidateMessageIds = new Map<GitHubNodeId, string>();
  const events: StateHistoryNotificationEvent[] = [];
  for (const [itemNodeId, itemEntries] of entriesByMessageAndItem) {
    const candidate = context.candidateByNodeId.get(itemNodeId);
    if (candidate == null) {
      throw new TypeError("Discord送信結果のitemが通知候補にありません");
    }
    const previousMessageId = context.candidateMessageIds.get(itemNodeId);
    if (previousMessageId != null) {
      throw new TypeError("同じitemが複数のDiscord messageへ送信されています");
    }
    const candidateReasonsByKey = new Map(
      candidate.reasons.map((reason) => [reason.notificationKey, reason]),
    );
    if (candidateReasonsByKey.size !== candidate.reasons.length) {
      throw new TypeError("通知候補のnotification keyが重複しています");
    }
    const reasonsByKey = new Map<string, (typeof candidate.reasons)[number]>();
    let sentAt: UtcIsoDateTime | undefined;
    for (const entry of itemEntries) {
      if (entry.itemNodeId !== candidate.itemNodeId) {
        throw new TypeError("Discord送信結果と通知候補のitemまたはseverityが一致しません");
      }
      const candidateReason = candidateReasonsByKey.get(entry.notificationKey);
      if (entry.reasonCode === "none" || candidateReason?.reasonCode !== entry.reasonCode) {
        throw new TypeError("Discord送信結果の通知理由が候補と一致しません");
      }
      if (reasonsByKey.has(entry.notificationKey)) {
        throw new TypeError("Discord送信結果の通知理由が重複しています");
      }
      assertNonNullable(candidateReason, "Discord送信結果の通知理由を取得できません");
      if (entry.severity !== candidateReason.severity) {
        throw new TypeError("Discord送信結果と通知理由のseverityが一致しません");
      }
      reasonsByKey.set(entry.notificationKey, candidateReason);
      if (sentAt == null) {
        sentAt = entry.sentAt;
      } else if (sentAt !== entry.sentAt) {
        throw new TypeError("同じDiscord messageの通知送信時刻が一致しません");
      }
    }
    if (reasonsByKey.size === 0) {
      throw new TypeError("Discord送信結果の通知理由がありません");
    }
    const sentReasons = candidate.reasons.filter((reason) =>
      reasonsByKey.has(reason.notificationKey),
    );
    const reasons = sentReasons.map((reason) =>
      createNotificationReason(reason.reasonCode, reason.threshold),
    );
    const item = context.itemByNodeId.get(itemNodeId);
    assertNonNullable(item, "通知送信eventの対象itemがsnapshotにありません");
    assertNonNullable(sentAt, "Discord送信eventの送信時刻がありません");
    const personalReminders = sentReasons.flatMap((reason) => {
      if (reason.source.kind !== "personal_reminder") {
        return [];
      }
      if (reason.severity === "none") {
        throw new TypeError("個人催促通知理由のseverityがnoneです");
      }
      const context = reason.source.context;
      assertConfirmedPersonalReminderTimeBasis(context.obligationSince);
      assertConfirmedPersonalReminderTimeBasis(context.actionableSince);
      assertConfirmedPersonalReminderTimeBasis(context.stallSince);
      return [
        Object.freeze({
          notificationKey: reason.notificationKey,
          causeId: context.causeId,
          responsibilityId: context.responsibilityId,
          responsible: [...context.responsible],
          action: context.action,
          reason: createNotificationReason(reason.reasonCode, reason.threshold),
          obligationSince: context.obligationSince,
          actionableSince: context.actionableSince,
          stallSince: context.stallSince,
          severity: reason.severity,
        }),
      ];
    });
    candidateMessageIds.set(itemNodeId, discordMessageId);
    events.push({
      kind: "notification_sent",
      deliveryId: hashCanonicalJson([
        "notification-history-v1",
        snapshot.run.id,
        discordMessageId,
        itemNodeId,
      ]),
      itemNodeId: item.nodeId,
      repositoryId: item.repositoryId,
      type: item.type,
      displayReference: item.displayReference,
      number: item.number,
      title: item.title,
      url: item.url,
      waitingOn: createNotificationWaitingOn(item, snapshot),
      reasons,
      personalReminders,
      severity: candidate.severity,
      sentAt,
    });
  }
  for (const notificationKey of messageNotificationKeys) {
    context.sentNotificationKeys.add(notificationKey);
  }
  for (const [itemNodeId] of candidateMessageIds) {
    context.candidateMessageIds.set(itemNodeId, discordMessageId);
  }
  return Object.freeze(events);
}

/** 全Discord送信結果から履歴eventを作る。 */
export function createNotificationHistoryEvents(
  snapshot: StateSnapshot,
  selection: DiscordNotificationSelection,
  delivery: DiscordDigestDelivery,
): readonly StateHistoryNotificationEvent[] {
  if (delivery.status !== "sent") {
    return Object.freeze([]);
  }
  const context = createNotificationHistoryContext(snapshot, selection);
  if (delivery.ledgerEntries.length === 0) {
    throw new TypeError("Discord送信成功結果にledger entryがありません");
  }
  const entriesByMessage = new Map<string, SentNotificationLedgerEntry[]>();
  for (const entry of delivery.ledgerEntries) {
    if (entry.status !== "sent") {
      throw new TypeError("Discord送信成功結果に未送信ledger entryがあります");
    }
    const entries = entriesByMessage.get(entry.discordMessageId);
    if (entries == null) {
      entriesByMessage.set(entry.discordMessageId, [entry]);
    } else {
      entries.push(entry);
    }
  }
  const deliveryMessageIds = new Set(delivery.discordMessageIds);
  if (deliveryMessageIds.size !== delivery.discordMessageIds.length) {
    throw new TypeError("Discord送信結果のmessage IDが重複しています");
  }
  const events: StateHistoryNotificationEvent[] = [];
  for (const [discordMessageId, entries] of entriesByMessage) {
    if (!deliveryMessageIds.has(discordMessageId)) {
      throw new TypeError("Discord送信結果のledgerにないmessage IDがあります");
    }
    events.push(...createNotificationHistoryEventsForMessage(snapshot, context, entries));
  }
  if (context.candidateMessageIds.size !== context.candidateByNodeId.size) {
    throw new TypeError("Discord送信結果のitem数が通知候補と一致しません");
  }
  if (deliveryMessageIds.size !== entriesByMessage.size) {
    throw new TypeError("Discord送信結果のmessage数がledgerと一致しません");
  }
  return Object.freeze(events);
}

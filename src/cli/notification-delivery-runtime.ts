import { resolve } from "node:path";

import { hashCanonicalJson, serializeCanonicalJson } from "../canonical-json/index.js";
import { type Config, type loadConfig } from "../config/index.js";
import {
  calculatePersonalReminderStaleness,
  createGitHubNodeId,
  createLabelEffectsResolver,
  createNotificationReason,
  createUtcIsoDateTime,
  recalculateStalenessSeverity,
  type GitHubNodeId,
  type LabelRule,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type PendingNotification,
  type Repository,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  assertDiscordPersonalReminderSelectionMatchesSnapshot,
  calculateDiscordNotificationCandidateSeverity,
  type sendDiscordDigest,
  type DiscordDigestDelivery,
  type DiscordDeliverySettings,
  type DiscordNotificationCandidate,
  type DiscordNotificationSelection,
  type DiscordOperationsIncident,
  type DiscordPersonalReminderSelectionValidationItem,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../discord/index.js";
import {
  assertStatePublicSafety,
  createStateNotificationLedger,
  NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
  type StateBranchAdapter,
  type StateHistoryNotificationEvent,
  type StateNotificationLedger,
  type StatePersistenceConfiguration,
  type StatePersistenceSession,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../persistence/index.js";
import { resolveStateHistoryNotificationItemDisplayReference } from "../persistence/history.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { type ResolveDiscordDeliveryCliCommand } from "./command.js";
import { requireEnvironmentValue } from "./production-runtime-setup.js";
import { workflowArtifactRepositoryInventory } from "./workflow-artifact.js";

const DISCORD_DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;

type NotificationDeliveryRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  repositoryPath: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
  ) => Promise<StatePersistenceSession>;
  createStateBranchAdapter: () => StateBranchAdapter;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  sendDiscord: typeof sendDiscordDigest;
}>;

type NotificationDeliveryRuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
}>;

type NotificationDeliveryValidatedRun = Readonly<{
  snapshot: StateSnapshot;
  notificationSelection: DiscordNotificationSelection;
}>;

type DiscordDeliveryResult = Readonly<{
  delivery: DiscordDigestDelivery;
  notificationEvents: readonly StateHistoryNotificationEvent[];
}>;

type DiscordResult = DiscordDeliveryResult &
  Readonly<{
    notificationLedger: StateNotificationLedger;
  }>;

function previousSnapshot(state: NotificationDeliveryRuntimeState): StateSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot.snapshot : undefined;
}

function environmentSecretProvider(
  environment: Readonly<NodeJS.ProcessEnv>,
): DiscordSecretProvider {
  return Object.freeze({
    read: (name) => requireEnvironmentValue(environment, name),
  });
}

function operationsAlertLedgerEntry(
  entry: StateNotificationLedger["operationsAlerts"][number],
): OperationsAlertLedgerEntry {
  return Object.freeze({
    ...entry,
    occurredAt: createUtcIsoDateTime(entry.occurredAt),
    sentAt: createUtcIsoDateTime(entry.sentAt),
  });
}

function notificationLedgerEntry(
  entry: StateNotificationLedger["entries"][number],
): NotificationLedgerEntry {
  const fields = {
    notificationKey: entry.notificationKey,
    itemNodeId: createGitHubNodeId(entry.itemNodeId),
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    reservedAt: createUtcIsoDateTime(entry.reservedAt),
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
            snapshot,
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

type NotificationHistoryContext = Readonly<{
  candidateByNodeId: ReadonlyMap<GitHubNodeId, DiscordNotificationCandidate>;
  itemByNodeId: ReadonlyMap<GitHubNodeId, StateSnapshot["items"][number]>;
  candidateMessageIds: Map<GitHubNodeId, string>;
  sentNotificationKeys: Set<string>;
}>;

function createNotificationHistoryContext(
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

type SentNotificationLedgerEntry = Extract<NotificationLedgerEntry, { status: "sent" }>;

function createNotificationHistoryEventsForMessage(
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
      severity: calculateDiscordNotificationCandidateSeverity(sentReasons),
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

function createNotificationHistoryEvents(
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

type DiscordDigestSelection = Extract<DiscordNotificationSelection, { action: "create_digest" }>;
type SkippedDiscordDigestSelection = Extract<
  DiscordNotificationSelection,
  { action: "skip_digest" }
>;

function nonEmptyNotificationReasons(
  reasons: readonly DiscordNotificationCandidate["reasons"][number][],
  itemNodeId: GitHubNodeId,
): DiscordNotificationCandidate["reasons"] {
  const [first, ...rest] = reasons;
  assertNonNullable(first, `${itemNodeId}の通知理由がありません`);
  return Object.freeze([first, ...rest]);
}

function nonEmptyNotificationCandidates(
  candidates: readonly DiscordDigestSelection["candidates"][number][],
): DiscordDigestSelection["candidates"] {
  const [first, ...rest] = candidates;
  assertNonNullable(first, "通知候補がありません");
  return Object.freeze([first, ...rest]);
}

function nonEmptyNotificationReservations(
  reservations: readonly DiscordDigestSelection["ledgerReservations"][number][],
): DiscordDigestSelection["ledgerReservations"] {
  const [first, ...rest] = reservations;
  assertNonNullable(first, "通知候補に対応するledger予約がありません");
  return Object.freeze([first, ...rest]);
}

function filterNotificationSelectionForLedger(
  selection: DiscordNotificationSelection,
  ledgerEntries: ReadonlyMap<string, NotificationLedgerEntry>,
): DiscordNotificationSelection {
  const emptyCandidates: SkippedDiscordDigestSelection["candidates"] = Object.freeze([]);
  const emptyReservations: SkippedDiscordDigestSelection["ledgerReservations"] = Object.freeze([]);
  const pendingNotifications = Object.freeze(
    selection.pendingNotifications.filter((pending) => {
      const entry = ledgerEntries.get(pending.notificationKey);
      return entry?.status !== "sent" && entry?.status !== "acknowledged";
    }),
  );
  if (selection.action === "skip_digest") {
    return Object.freeze({
      action: "skip_digest",
      reason: selection.reason,
      candidates: emptyCandidates,
      ledgerReservations: emptyReservations,
      pendingNotifications,
    });
  }
  const candidates = selection.candidates.flatMap((candidate) => {
    const reasons = candidate.reasons.filter((reason) => {
      const entry = ledgerEntries.get(reason.notificationKey);
      return entry?.status !== "sent" && entry?.status !== "acknowledged";
    });
    if (reasons.length === 0) {
      return [];
    }
    const nonEmptyReasons = nonEmptyNotificationReasons(reasons, candidate.itemNodeId);
    return [
      Object.freeze({
        ...candidate,
        reasons: nonEmptyReasons,
        severity: calculateDiscordNotificationCandidateSeverity(nonEmptyReasons),
      }),
    ];
  });
  const candidateKeys = new Set(
    candidates.flatMap((candidate) => candidate.reasons.map((reason) => reason.notificationKey)),
  );
  const ledgerReservations = selection.ledgerReservations.filter((reservation) =>
    candidateKeys.has(reservation.notificationKey),
  );
  if (candidates.length === 0) {
    return Object.freeze({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: emptyCandidates,
      ledgerReservations: emptyReservations,
      pendingNotifications,
    });
  }
  return Object.freeze({
    action: "create_digest",
    candidates: nonEmptyNotificationCandidates(candidates),
    ledgerReservations: nonEmptyNotificationReservations(ledgerReservations),
    pendingNotifications,
  });
}

function notificationLedgerEntryIdentityMatches(
  left: NotificationLedgerEntry,
  right: NotificationLedgerEntry,
): boolean {
  return (
    left.notificationKey === right.notificationKey &&
    left.itemNodeId === right.itemNodeId &&
    left.reasonCode === right.reasonCode &&
    left.severity === right.severity &&
    left.reservedAt === right.reservedAt
  );
}

function assertNotificationDeliveryBatch(
  selection: DiscordDigestSelection,
  currentEntriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  entries: readonly NotificationLedgerEntry[],
): void {
  const firstEntry = entries[0];
  assertNonNullable(firstEntry, "Discord送信結果にledger entryがありません");
  if (firstEntry.status === "acknowledged") {
    throw new TypeError("Discord送信callbackに確認済みledger entryを渡せません");
  }
  for (const entry of entries) {
    if (entry.status !== firstEntry.status) {
      throw new TypeError("Discord送信callbackのledger statusが一致しません");
    }
  }

  const candidateByKey = new Map<
    string,
    Readonly<{
      candidate: DiscordNotificationCandidate;
      reason: DiscordNotificationCandidate["reasons"][number];
    }>
  >();
  for (const candidate of selection.candidates) {
    for (const reason of candidate.reasons) {
      if (candidateByKey.has(reason.notificationKey)) {
        throw new TypeError("通知候補のnotification keyが重複しています");
      }
      candidateByKey.set(reason.notificationKey, { candidate, reason });
    }
  }

  const reservationByKey = new Map<
    string,
    Extract<NotificationLedgerEntry, { status: "reserved" }>
  >();
  for (const reservation of selection.ledgerReservations) {
    if (reservationByKey.has(reservation.notificationKey)) {
      throw new TypeError("通知予約のnotification keyが重複しています");
    }
    reservationByKey.set(reservation.notificationKey, reservation);
  }
  if (candidateByKey.size !== reservationByKey.size) {
    throw new TypeError("通知候補とledger予約の件数が一致しません");
  }
  for (const notificationKey of candidateByKey.keys()) {
    if (!reservationByKey.has(notificationKey)) {
      throw new TypeError("通知候補とledger予約が一致しません");
    }
  }

  const keysByItemNodeId = new Map<GitHubNodeId, Set<string>>();
  for (const entry of entries) {
    const candidateEntry = candidateByKey.get(entry.notificationKey);
    if (candidateEntry == null) {
      throw new TypeError("Discord送信結果のnotification keyが通知候補にありません");
    }
    const reservation = reservationByKey.get(entry.notificationKey);
    assertNonNullable(reservation, "Discord送信結果に対応する通知予約がありません");
    if (
      !notificationLedgerEntryIdentityMatches(entry, reservation) ||
      entry.itemNodeId !== candidateEntry.candidate.itemNodeId ||
      entry.reasonCode !== candidateEntry.reason.reasonCode ||
      entry.severity !== candidateEntry.reason.severity ||
      reservation.severity !== candidateEntry.reason.severity
    ) {
      throw new TypeError("Discord送信結果と通知候補またはledger予約が一致しません");
    }
    const currentEntry = currentEntriesByKey.get(entry.notificationKey);
    assertNonNullable(currentEntry, "Discord送信結果の現在ledger entryがありません");
    if (!notificationLedgerEntryIdentityMatches(currentEntry, entry)) {
      throw new TypeError("Discord送信結果と現在の通知ledgerが一致しません");
    }
    let itemKeys = keysByItemNodeId.get(entry.itemNodeId);
    if (itemKeys == null) {
      itemKeys = new Set<string>();
      keysByItemNodeId.set(entry.itemNodeId, itemKeys);
    }
    if (itemKeys.has(entry.notificationKey)) {
      throw new TypeError("Discord送信callbackのnotification keyが重複しています");
    }
    itemKeys.add(entry.notificationKey);

    if (firstEntry.status === "delivery_started") {
      if (entry.status !== "delivery_started") {
        throw new TypeError("Discord送信callbackのledger statusが一致しません");
      }
      if (currentEntry.status !== "reserved") {
        throw new TypeError("送信開始callbackは対応する通知予約から遷移させてください");
      }
      if (!notificationLedgerEntryIdentityMatches(currentEntry, reservation)) {
        throw new TypeError("送信開始callbackは対応する通知予約から遷移させてください");
      }
      if (
        currentEntry.expiresAt !== reservation.expiresAt ||
        entry.startedAt < entry.reservedAt ||
        entry.startedAt > reservation.expiresAt ||
        !DISCORD_DELIVERY_ID_PATTERN.test(entry.deliveryId)
      ) {
        throw new TypeError("送信開始callbackは対応する通知予約から遷移させてください");
      }
      if (entry.deliveryId !== firstEntry.deliveryId || entry.startedAt !== firstEntry.startedAt) {
        throw new TypeError("同じDiscord messageの送信開始時刻が一致しません");
      }
    } else if (firstEntry.status === "sent") {
      if (entry.status !== "sent") {
        throw new TypeError("Discord送信callbackのledger statusが一致しません");
      }
      if (
        currentEntry.status !== "delivery_started" ||
        currentEntry.startedAt < currentEntry.reservedAt ||
        entry.sentAt < currentEntry.startedAt
      ) {
        throw new TypeError("送信済みcallbackは送信開始済み通知から遷移させてください");
      }
      const firstCurrentEntry = currentEntriesByKey.get(firstEntry.notificationKey);
      assertNonNullable(firstCurrentEntry, "Discord送信結果の先頭entryが現在ledgerにありません");
      if (
        firstCurrentEntry.status !== "delivery_started" ||
        currentEntry.deliveryId !== firstCurrentEntry.deliveryId ||
        currentEntry.startedAt !== firstCurrentEntry.startedAt ||
        entry.sentAt !== firstEntry.sentAt ||
        entry.discordMessageId !== firstEntry.discordMessageId
      ) {
        throw new TypeError("同じDiscord messageの送信結果が一致しません");
      }
    } else {
      if (entry.status !== "reserved") {
        throw new TypeError("Discord送信callbackのledger statusが一致しません");
      }
      if (currentEntry.status !== "delivery_started" || entry.expiresAt !== reservation.expiresAt) {
        throw new TypeError("予約復帰callbackは送信開始済み通知から遷移させてください");
      }
      const firstCurrentEntry = currentEntriesByKey.get(firstEntry.notificationKey);
      assertNonNullable(firstCurrentEntry, "Discord送信結果の先頭entryが現在ledgerにありません");
      if (
        firstCurrentEntry.status !== "delivery_started" ||
        currentEntry.deliveryId !== firstCurrentEntry.deliveryId ||
        currentEntry.startedAt !== firstCurrentEntry.startedAt
      ) {
        throw new TypeError("同じDiscord messageの予約復帰結果が一致しません");
      }
    }
  }

  for (const [itemNodeId, itemKeys] of keysByItemNodeId) {
    const candidate = selection.candidates.find((value) => value.itemNodeId === itemNodeId);
    assertNonNullable(candidate, "Discord送信結果のitemが通知候補にありません");
    const candidateKeys = new Set(candidate.reasons.map((reason) => reason.notificationKey));
    if (
      itemKeys.size !== candidateKeys.size ||
      [...candidateKeys].some((notificationKey) => !itemKeys.has(notificationKey))
    ) {
      throw new TypeError("Discord送信結果の通知理由数が候補と一致しません");
    }
  }
}

function assertNoStartedNotificationDelivery(
  selection: DiscordNotificationSelection,
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): void {
  for (const candidate of selection.candidates) {
    for (const reason of candidate.reasons) {
      const entry = entriesByKey.get(reason.notificationKey);
      if (entry?.status === "delivery_started") {
        throw new TypeError(
          `通知 ${reason.notificationKey} は送信開始済みです。delivery ID: ${entry.deliveryId}。手動解決を実行してください: resolve-discord-delivery --delivery-id ${entry.deliveryId} --resolution retry または acknowledge`,
        );
      }
    }
  }
}

function createNotificationLedgerFromMaps(
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  operationsAlertsByKey: ReadonlyMap<string, OperationsAlertLedgerEntry>,
  pendingNotifications: readonly PendingNotification[],
): StateNotificationLedger {
  return createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: [...entriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
    pendingNotifications,
  });
}

function assertNotificationDeliveryLedgerConsistency(
  delivery: DiscordDigestDelivery,
  savedEntries: readonly NotificationLedgerEntry[],
): void {
  if (delivery.status !== "sent") {
    if (savedEntries.length !== 0) {
      throw new TypeError("Discord送信結果がないのに送信済みledger entryがあります");
    }
    return;
  }
  const savedEntriesByKey = new Map(savedEntries.map((entry) => [entry.notificationKey, entry]));
  if (savedEntriesByKey.size !== savedEntries.length) {
    throw new TypeError("callbackで保存したDiscord送信結果のnotification keyが重複しています");
  }
  if (delivery.ledgerEntries.length !== savedEntries.length) {
    throw new TypeError("Discord送信結果とcallbackで保存したledgerの件数が一致しません");
  }
  for (const entry of delivery.ledgerEntries) {
    const savedEntry = savedEntriesByKey.get(entry.notificationKey);
    if (
      savedEntry == null ||
      serializeCanonicalJson(savedEntry) !== serializeCanonicalJson(entry)
    ) {
      throw new TypeError("Discord送信結果とcallbackで保存したledgerが一致しません");
    }
  }
}

function notificationCountForSelection(
  selection: DiscordNotificationSelection,
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): number {
  const notificationKeys = new Set(
    selection.candidates.flatMap((candidate) =>
      candidate.reasons.map((reason) => reason.notificationKey),
    ),
  );
  let count = 0;
  for (const notificationKey of notificationKeys) {
    if (entriesByKey.get(notificationKey)?.status === "sent") {
      count += 1;
    }
  }
  return count;
}

function latestSentAtForSelection(
  selection: DiscordNotificationSelection,
  entriesByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): UtcIsoDateTime | null {
  const notificationKeys = new Set(
    selection.candidates.flatMap((candidate) =>
      candidate.reasons.map((reason) => reason.notificationKey),
    ),
  );
  let latestSentAt: UtcIsoDateTime | null = null;
  for (const notificationKey of notificationKeys) {
    const entry = entriesByKey.get(notificationKey);
    if (entry?.status !== "sent") {
      continue;
    }
    if (latestSentAt == null || entry.sentAt > latestSentAt) {
      latestSentAt = entry.sentAt;
    }
  }
  return latestSentAt;
}

function snapshotPersonalReminderSelectionValidationItems(
  snapshot: StateSnapshot,
  config: Config,
  labelRules: readonly LabelRule[],
): readonly DiscordPersonalReminderSelectionValidationItem[] {
  const resolveLabelEffects = createLabelEffectsResolver(labelRules);
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  if (repositoriesById.size !== snapshot.repositories.length) {
    throw new TypeError("送信直前検証対象のsnapshot repository IDが重複しています");
  }
  return Object.freeze(
    snapshot.items.map((item) => {
      const repository = repositoriesById.get(item.repositoryId);
      assertNonNullable(repository, `${item.nodeId}のsnapshot repositoryがありません`);
      const repositoryName = `${repository.owner}/${repository.name}`;
      const staleness = recalculateStalenessSeverity({
        evaluatedAt: snapshot.generatedAt,
        stallSince: item.stallSince,
        confidence: item.confidence,
        minimumAiConfidence: config.ai.confidence.medium,
        repositoryFullName: repositoryName,
        currentLabels: item.labels,
        resolveLabelEffects,
        thresholdsHours: config.staleness.thresholdsHours,
        severityContext: item.severityContext,
      });
      const personalReminderCauses = Object.freeze(
        item.personalReminderCauses.map((cause) =>
          Object.freeze({
            cause,
            staleness: calculatePersonalReminderStaleness({
              cause,
              evaluatedAt: snapshot.generatedAt,
              minimumAiConfidence: config.ai.confidence.medium,
              repositoryFullName: repositoryName,
              currentLabels: item.labels,
              resolveLabelEffects,
              thresholdsHours: config.staleness.thresholdsHours,
            }),
          }),
        ),
      );
      return Object.freeze({
        nodeId: item.nodeId,
        current: Object.freeze({
          status: item.status,
          waitingOn: item.waitingOn,
          severity: staleness.severity,
          severityReason: staleness.severityReason,
          waitClass: staleness.waitClass,
          statusSince: item.statusSince,
          ownerSince: item.ownerSince,
          stallSince: item.stallSince,
          lastProgressAt: item.lastProgressAt,
        }),
        personalReminderCauses,
        personalReminderCausePlanning: item.personalReminderCausePlanning,
      });
    }),
  );
}

/** 保存済みrunを照合してDiscord通知と通知履歴を送達する。 */
export async function deliverDiscord(
  adapters: NotificationDeliveryRuntimeAdapters,
  config: Config,
  labelRules: () => readonly LabelRule[],
  settings: DiscordDeliverySettings,
  state: NotificationDeliveryRuntimeState,
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
  validated: NotificationDeliveryValidatedRun,
  deployedPagesUrl: string,
): Promise<
  Readonly<{
    value: DiscordDeliveryResult;
    notificationEvents: readonly StateHistoryNotificationEvent[];
    notificationLedger: StateNotificationLedger;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const persistedSnapshot = await state.session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord通知対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== validated.snapshot.run.id) {
    throw new TypeError("Discord通知対象のrunがstate snapshotと一致しません");
  }
  const snapshot = persistedSnapshot.snapshot;
  const persistedLedger = await state.session.loadNotificationLedger();
  let notificationEntriesByKey = new Map<string, NotificationLedgerEntry>(
    persistedLedger.entries.map((entry): readonly [string, NotificationLedgerEntry] => {
      const normalizedEntry = notificationLedgerEntry(entry);
      return [normalizedEntry.notificationKey, normalizedEntry];
    }),
  );
  let operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    persistedLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  let pendingNotifications: readonly PendingNotification[] = Object.freeze(
    persistedLedger.pendingNotifications.filter((pending) => {
      const entry = notificationEntriesByKey.get(pending.notificationKey);
      return entry?.status !== "sent" && entry?.status !== "acknowledged";
    }),
  );
  assertNoStartedNotificationDelivery(validated.notificationSelection, notificationEntriesByKey);
  const notificationSelection = filterNotificationSelectionForLedger(
    validated.notificationSelection,
    notificationEntriesByKey,
  );
  if (notificationSelection.action === "create_digest") {
    assertDiscordPersonalReminderSelectionMatchesSnapshot(
      notificationSelection,
      snapshotPersonalReminderSelectionValidationItems(snapshot, config, labelRules()),
    );
  }
  const notificationHistoryContext = createNotificationHistoryContext(
    snapshot,
    notificationSelection,
  );
  const sentNotificationEntries: SentNotificationLedgerEntry[] = [];
  const notificationEvents: StateHistoryNotificationEvent[] = [];

  const persistDelivery = async (
    notificationLedger: StateNotificationLedger,
    events: readonly StateHistoryNotificationEvent[],
    committedAt: UtcIsoDateTime,
  ): Promise<void> => {
    await state.session.persistNotificationDelivery({
      snapshot,
      notificationEvents: events,
      notificationLedger,
      committedAt,
      repositoryInventory,
      knownSecrets,
    });
    await state.session.publish();
  };

  const delivery = await adapters.sendDiscord({
    candidates: notificationSelection.candidates,
    ledgerReservations: notificationSelection.ledgerReservations,
    items: snapshot.items,
    generatedAt: snapshot.generatedAt,
    pagesDeployment: {
      status: "succeeded",
      pagesUrl: deployedPagesUrl,
    },
    settings,
    dependencies: {
      secretProvider: environmentSecretProvider(adapters.environment),
      httpClient: adapters.discordHttpClient,
      runtime: {
        now: adapters.now,
        sleep: adapters.sleep,
        random: adapters.random,
      },
      ledger: {
        hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
        recordNotifications: async (entries) => {
          const firstEntry = entries[0];
          assertNonNullable(firstEntry, "Discord送信結果にledger entryがありません");
          if (notificationSelection.action !== "create_digest") {
            throw new TypeError("通知候補がないdigestから通知ledger callbackを呼び出せません");
          }
          assertNotificationDeliveryBatch(notificationSelection, notificationEntriesByKey, entries);
          let messageEvents: readonly StateHistoryNotificationEvent[] = Object.freeze([]);
          let committedAt: UtcIsoDateTime;
          switch (firstEntry.status) {
            case "delivery_started":
              committedAt = firstEntry.startedAt;
              break;
            case "reserved":
              committedAt = createUtcIsoDateTime(adapters.now().toISOString());
              break;
            case "sent":
              messageEvents = createNotificationHistoryEventsForMessage(
                snapshot,
                notificationHistoryContext,
                entries,
              );
              committedAt = firstEntry.sentAt;
              break;
            case "acknowledged":
              throw new TypeError("Discord送信callbackに確認済みledger entryを渡せません");
          }
          const nextEntriesByKey = new Map(notificationEntriesByKey);
          for (const entry of entries) {
            nextEntriesByKey.set(entry.notificationKey, entry);
          }
          const sentKeys = new Set(
            firstEntry.status === "sent" ? entries.map((entry) => entry.notificationKey) : [],
          );
          const nextPendingNotifications = Object.freeze(
            pendingNotifications.filter((pending) => !sentKeys.has(pending.notificationKey)),
          );
          const notificationLedger = createNotificationLedgerFromMaps(
            nextEntriesByKey,
            operationsAlertsByKey,
            nextPendingNotifications,
          );
          await persistDelivery(notificationLedger, messageEvents, committedAt);
          notificationEntriesByKey = nextEntriesByKey;
          pendingNotifications = nextPendingNotifications;
          if (firstEntry.status === "sent") {
            for (const entry of entries) {
              if (entry.status !== "sent") {
                throw new TypeError("Discord送信結果のstatusが一致しません");
              }
              sentNotificationEntries.push(entry);
            }
          }
          notificationEvents.push(...messageEvents);
        },
        recordOperationsAlert: async (entry) => {
          const nextOperationsAlertsByKey = new Map(operationsAlertsByKey);
          nextOperationsAlertsByKey.set(entry.alertKey, entry);
          const notificationLedger = createNotificationLedgerFromMaps(
            notificationEntriesByKey,
            nextOperationsAlertsByKey,
            pendingNotifications,
          );
          await persistDelivery(notificationLedger, Object.freeze([]), entry.sentAt);
          operationsAlertsByKey = nextOperationsAlertsByKey;
        },
      },
    },
  });
  const sentAt = latestSentAtForSelection(notificationSelection, notificationEntriesByKey);
  assertNotificationDeliveryLedgerConsistency(delivery, sentNotificationEntries);
  const returnedNotificationEvents = createNotificationHistoryEvents(
    snapshot,
    notificationSelection,
    delivery,
  );
  if (
    serializeCanonicalJson(returnedNotificationEvents) !==
    serializeCanonicalJson(notificationEvents)
  ) {
    throw new TypeError("Discord送信結果とcallbackで保存した通知履歴が一致しません");
  }
  const notificationLedger = createNotificationLedgerFromMaps(
    notificationEntriesByKey,
    operationsAlertsByKey,
    pendingNotifications,
  );
  return Object.freeze({
    value: Object.freeze({
      delivery,
      notificationEvents: Object.freeze(notificationEvents),
    }),
    notificationEvents: Object.freeze(notificationEvents),
    notificationLedger,
    notificationCount: notificationCountForSelection(
      notificationSelection,
      notificationEntriesByKey,
    ),
    discordSentAt: sentAt,
  });
}

/** 運用障害通知を送達し、成功した通知管理記録を保存する。 */
export async function deliverOperationsAlert(
  adapters: NotificationDeliveryRuntimeAdapters,
  settings: DiscordDeliverySettings,
  knownSecrets: readonly string[],
  state: NotificationDeliveryRuntimeState,
  incident: DiscordOperationsIncident,
): Promise<
  Readonly<{
    value: DiscordResult;
    notificationCount: number;
    discordSentAt: UtcIsoDateTime | null;
  }>
> {
  const currentNotificationLedger = await state.session.loadNotificationLedger();
  const notificationEntriesByKey = new Map<string, NotificationLedgerEntry>(
    currentNotificationLedger.entries.map((entry): readonly [string, NotificationLedgerEntry] => {
      const normalizedEntry = notificationLedgerEntry(entry);
      return [normalizedEntry.notificationKey, normalizedEntry];
    }),
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    currentNotificationLedger.operationsAlerts.map((entry) => [
      entry.alertKey,
      operationsAlertLedgerEntry(entry),
    ]),
  );
  const delivery = await adapters.sendDiscord({
    candidates: [],
    ledgerReservations: [],
    items: previousSnapshot(state)?.items ?? [],
    generatedAt: incident.occurredAt,
    pagesDeployment: {
      status: "failed",
      incidentId: incident.incidentId,
      kind: incident.kind,
      failedAt: incident.occurredAt,
      retryAttempts: incident.retryAttempts,
    },
    settings,
    dependencies: {
      secretProvider: environmentSecretProvider(adapters.environment),
      httpClient: adapters.discordHttpClient,
      runtime: {
        now: adapters.now,
        sleep: adapters.sleep,
        random: adapters.random,
      },
      ledger: {
        hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
        recordNotifications: (entries) => {
          for (const entry of entries) {
            notificationEntriesByKey.set(entry.notificationKey, entry);
          }
          return Promise.resolve();
        },
        recordOperationsAlert: (entry) => {
          operationsAlertsByKey.set(entry.alertKey, entry);
          return Promise.resolve();
        },
      },
    },
  });
  if (delivery.status !== "skipped" || delivery.reason !== "pages_deployment_failed") {
    return Object.freeze({
      value: Object.freeze({
        delivery,
        notificationEvents: Object.freeze([]),
        notificationLedger: currentNotificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const operationsDelivery = delivery.operationsAlert;
  if (operationsDelivery.status !== "sent") {
    return Object.freeze({
      value: Object.freeze({
        delivery,
        notificationEvents: Object.freeze([]),
        notificationLedger: currentNotificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: [...notificationEntriesByKey.values()],
    operationsAlerts: [...operationsAlertsByKey.values()],
    pendingNotifications: currentNotificationLedger.pendingNotifications,
  });
  const persistenceInput = Object.freeze({
    notificationLedger,
    committedAt: operationsDelivery.ledgerEntry.sentAt,
    knownSecrets,
  });
  if (state.snapshot.status === "missing_branch") {
    await state.session.persistInitialOperationsNotificationLedger(persistenceInput);
  } else {
    await state.session.persistNotificationLedger(persistenceInput);
  }
  await state.session.publish();
  return Object.freeze({
    value: Object.freeze({
      delivery,
      notificationEvents: Object.freeze([]),
      notificationLedger,
    }),
    notificationCount: 1,
    discordSentAt: operationsDelivery.ledgerEntry.sentAt,
  });
}

function acknowledgeDeliveryStartedEntry(
  entry: Extract<NotificationLedgerEntry, { status: "delivery_started" }>,
  acknowledgedAt: UtcIsoDateTime,
): NotificationLedgerEntry {
  return Object.freeze({
    notificationKey: entry.notificationKey,
    itemNodeId: entry.itemNodeId,
    reasonCode: entry.reasonCode,
    severity: entry.severity,
    reservedAt: entry.reservedAt,
    status: "acknowledged",
    acknowledgedAt,
  });
}

/** 送信開始済み通知を手動で確認済みまたは再試行可能にする。 */
export async function resolveDiscordDelivery(
  adapters: NotificationDeliveryRuntimeAdapters,
  command: ResolveDiscordDeliveryCliCommand,
): Promise<void> {
  if (!DISCORD_DELIVERY_ID_PATTERN.test(command.deliveryId)) {
    throw new TypeError("Discord送信のdelivery IDが不正です");
  }
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const session = await adapters.openStateSession(
    adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord送信の手動解決対象となるstate snapshotがありません");
  }
  const currentLedger = await session.loadNotificationLedger();
  const entries = currentLedger.entries.map(notificationLedgerEntry);
  const matchingEntries = entries.filter(
    (entry): entry is Extract<NotificationLedgerEntry, { status: "delivery_started" }> =>
      entry.status === "delivery_started" && entry.deliveryId === command.deliveryId,
  );
  if (matchingEntries.length === 0) {
    throw new TypeError(`指定されたdelivery IDの送信開始記録がありません: ${command.deliveryId}`);
  }
  const matchingKeys = new Set(matchingEntries.map((entry) => entry.notificationKey));
  const resolvedAt = createUtcIsoDateTime(adapters.now().toISOString());
  if (matchingEntries.some((entry) => resolvedAt < entry.startedAt)) {
    throw new TypeError("Discord送信の解決時刻は送信開始時刻以後にしてください");
  }
  let nextEntries: readonly NotificationLedgerEntry[];
  let pendingNotifications: readonly PendingNotification[];
  if (command.resolution === "retry") {
    nextEntries = Object.freeze(
      entries.filter((entry) => !matchingKeys.has(entry.notificationKey)),
    );
    pendingNotifications = currentLedger.pendingNotifications;
  } else {
    nextEntries = Object.freeze(
      entries.map((entry) => {
        if (entry.status !== "delivery_started" || entry.deliveryId !== command.deliveryId) {
          return entry;
        }
        return acknowledgeDeliveryStartedEntry(entry, resolvedAt);
      }),
    );
    pendingNotifications = Object.freeze(
      currentLedger.pendingNotifications.filter(
        (pending) => !matchingKeys.has(pending.notificationKey),
      ),
    );
  }
  const notificationLedger = createStateNotificationLedger({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    entries: nextEntries,
    operationsAlerts: currentLedger.operationsAlerts,
    pendingNotifications,
  });
  const repositoryInventory = workflowArtifactRepositoryInventory({
    snapshot: persistedSnapshot.snapshot,
  });
  assertStatePublicSafety({
    snapshot: persistedSnapshot.snapshot,
    repositoryInventory,
    additionalValues: [currentLedger, notificationLedger],
    knownSecrets: [],
  });
  await session.persistNotificationLedger({
    notificationLedger,
    committedAt: resolvedAt,
    knownSecrets: [],
  });
  await session.publish();
}

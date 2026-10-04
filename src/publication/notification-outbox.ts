import type { ContentDigestPort } from "../application/tracking-run/contracts/content-digest-port.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { DiscordNotificationSelection } from "../discord/index.js";
import type { StateNotificationLedger, StateSnapshot } from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  canonicalEqual,
  canonicalSelection,
  normalNotificationLedgerValue,
  sortByKey,
} from "./publication-order.js";
import type {
  NotificationOutbox,
  PublicationValidatedRun,
  SelectedNotificationContext,
} from "./publication-plan-contracts.js";

function assertSelectedContext(
  run: PublicationValidatedRun,
  selection: Extract<DiscordNotificationSelection, { action: "create_digest" }>,
): SelectedNotificationContext {
  const items = new Map(run.snapshot.items.map((item) => [item.nodeId, item]));
  const reservations = new Map(
    selection.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  const selectedKeys = new Set<string>();
  for (const candidate of selection.candidates) {
    const item = items.get(candidate.itemNodeId);
    if (item == null) {
      throw new TypeError("公開計画の通知候補に対応するsnapshot項目がありません");
    }
    for (const reason of candidate.reasons) {
      if (selectedKeys.has(reason.notificationKey)) {
        throw new TypeError("公開計画の通知keyが重複しています");
      }
      selectedKeys.add(reason.notificationKey);
      const reservation = reservations.get(reason.notificationKey);
      assertNonNullable(reservation, "公開計画の通知理由に対応する予約がありません");
      if (
        reservation.itemNodeId !== candidate.itemNodeId ||
        reservation.reasonCode !== reason.reasonCode ||
        reservation.severity !== reason.severity ||
        reservation.reservedAt !== run.core.generatedAt
      ) {
        throw new TypeError("公開計画の通知理由と予約が一致しません");
      }
      if (reason.source.kind === "personal_reminder") {
        const context = reason.source.context;
        const cause: StateSnapshot["items"][number]["personalReminderCauses"][number] | undefined =
          item.personalReminderCauses.find((value) => value.causeId === context.causeId);
        assertNonNullable(cause, "公開計画の個人催促理由に対応する原因がありません");
        if (
          cause.responsibilityId !== context.responsibilityId ||
          cause.reasonCode !== reason.reasonCode ||
          !canonicalEqual(cause.responsible, context.responsible) ||
          !canonicalEqual(cause.action, context.action) ||
          !canonicalEqual(cause.obligationSince, context.obligationSince) ||
          cause.actionableClock.status !== "observed" ||
          !canonicalEqual(cause.actionableClock.actionableSince, context.actionableSince) ||
          !canonicalEqual(cause.actionableClock.stallSince, context.stallSince)
        ) {
          throw new TypeError("公開計画の個人催促理由とsnapshot原因が一致しません");
        }
      }
    }
  }
  if (selectedKeys.size !== reservations.size) {
    throw new TypeError("公開計画の通知候補と予約のkey集合が一致しません");
  }
  return selection;
}

function assertInitialLedgerTransition(
  run: PublicationValidatedRun,
): readonly Extract<StateNotificationLedger["entries"][number], { status: "acknowledged" }>[] {
  const action = run.core.executionPolicy.notificationAction;
  if (
    !canonicalEqual(
      sortByKey(run.previousNotificationLedger.operationsAlerts, (entry) => entry.alertKey),
      sortByKey(run.notificationLedger.operationsAlerts, (entry) => entry.alertKey),
    ) ||
    !canonicalEqual(
      sortByKey(run.notificationSelection.pendingNotifications, (entry) => entry.notificationKey),
      sortByKey(run.notificationLedger.pendingNotifications, (entry) => entry.notificationKey),
    )
  ) {
    throw new TypeError("公開計画の未送信候補または運用通知ledgerが一致しません");
  }
  const previous = new Map(
    run.previousNotificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  const current = new Map(
    run.notificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  if (
    previous.size !== run.previousNotificationLedger.entries.length ||
    current.size !== run.notificationLedger.entries.length
  ) {
    throw new TypeError("公開計画の通常notification ledger keyが重複しています");
  }
  const selectedReservations = new Map(
    run.notificationSelection.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  const acknowledgements: Extract<
    StateNotificationLedger["entries"][number],
    { status: "acknowledged" }
  >[] = [];
  for (const [key, oldEntry] of previous) {
    if (!current.has(key)) {
      throw new TypeError("公開計画の通常notification ledgerから既存entryが消えています");
    }
    if (action !== "acknowledge-current" && !selectedReservations.has(key)) {
      if (!canonicalEqual(oldEntry, current.get(key))) {
        throw new TypeError("公開計画で非選別ledger entryが変更されています");
      }
    }
  }
  for (const [key, entry] of current) {
    const oldEntry = previous.get(key);
    if (
      (oldEntry?.status === "sent" || oldEntry?.status === "acknowledged") &&
      !canonicalEqual(oldEntry, entry)
    ) {
      throw new TypeError("公開計画で既存送信結果または確認結果が変更されています");
    }
    if (action === "acknowledge-current") {
      if (oldEntry?.status === "sent" || oldEntry?.status === "acknowledged") {
        if (!canonicalEqual(oldEntry, entry)) {
          throw new TypeError("確認済みactionで既存送信結果が変更されています");
        }
      } else if (entry.status === "acknowledged") {
        acknowledgements.push(entry);
      } else if (!canonicalEqual(oldEntry, entry)) {
        throw new TypeError("確認済みactionに想定外のledger遷移があります");
      }
    } else if (selectedReservations.has(key)) {
      if (
        action !== "send" ||
        entry.status !== "reserved" ||
        !canonicalEqual(entry, selectedReservations.get(key))
      ) {
        throw new TypeError("送信actionの初回ledger予約が一致しません");
      }
    } else if (oldEntry == null) {
      throw new TypeError("選別されていない通知keyが初回ledgerへ追加されています");
    }
  }
  if (action === "hold" && selectedReservations.size !== 0) {
    throw new TypeError("保留actionに通知予約があります");
  }
  if (
    action === "acknowledge-current" &&
    acknowledgements.some((entry) =>
      run.notificationLedger.pendingNotifications.some(
        (pending) => pending.notificationKey === entry.notificationKey,
      ),
    )
  ) {
    throw new TypeError("確認済み通知keyが未送信候補に残っています");
  }
  return sortByKey(acknowledgements, (entry) => entry.notificationKey);
}

export function planNotificationOutbox(
  run: PublicationValidatedRun,
  digest: ContentDigestPort,
): NotificationOutbox {
  const action = run.core.executionPolicy.notificationAction;
  const previousLedgerDigest = digest.sha256Utf8(
    serializeCanonicalJson(normalNotificationLedgerValue(run.previousNotificationLedger)),
  );
  const initialLedgerDigest = digest.sha256Utf8(
    serializeCanonicalJson(normalNotificationLedgerValue(run.notificationLedger)),
  );
  const acknowledgedEntries = assertInitialLedgerTransition(run);
  if (action === "hold") {
    if (
      run.notificationSelection.action !== "skip_digest" ||
      run.notificationSelection.reason !== "held"
    ) {
      throw new TypeError("保留actionの通知選別が一致しません");
    }
    return Object.freeze({
      action,
      delivery: "held",
      pendingNotifications: sortByKey(
        run.notificationSelection.pendingNotifications,
        (entry) => entry.notificationKey,
      ),
      previousLedgerDigest,
      initialLedgerDigest,
    });
  }
  if (action === "acknowledge-current") {
    if (
      run.notificationSelection.action !== "skip_digest" ||
      run.notificationSelection.reason !== "no_candidates"
    ) {
      throw new TypeError("確認済みactionの通知選別が一致しません");
    }
    return Object.freeze({
      action,
      delivery: "acknowledged",
      acknowledgedEntries,
      pendingNotifications: sortByKey(
        run.notificationSelection.pendingNotifications,
        (entry) => entry.notificationKey,
      ),
      previousLedgerDigest,
      initialLedgerDigest,
    });
  }
  const selection = canonicalSelection(run.notificationSelection);
  if (selection.action === "skip_digest" && selection.reason !== "no_candidates") {
    throw new TypeError("送信actionの通知省略理由が一致しません");
  }
  return Object.freeze({
    action,
    delivery: selection.action === "create_digest" ? "send" : "no_candidates",
    selectedContext:
      selection.action === "create_digest" ? assertSelectedContext(run, selection) : selection,
    pagesUrl: Object.freeze({ kind: "initial_pages_deployment_url" }),
    settings: run.publicationInputs.discord,
    previousLedgerDigest,
    initialLedgerDigest,
  });
}

/** outboxの対象keyと保存済みledgerから実送信数を数える。 */
export function countSentOutboxNotifications(
  outbox: NotificationOutbox,
  ledger: StateNotificationLedger,
): number {
  if (outbox.action !== "send" || outbox.selectedContext.action !== "create_digest") {
    return 0;
  }
  const entries = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  return outbox.selectedContext.candidates.reduce(
    (count, candidate) =>
      count +
      candidate.reasons.filter((reason) => entries.get(reason.notificationKey)?.status === "sent")
        .length,
    0,
  );
}

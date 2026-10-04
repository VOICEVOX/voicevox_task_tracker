import { serializeCanonicalJson } from "../canonical-json/value.js";
import {
  calculateDiscordNotificationCandidateSeverity,
  type DiscordNotificationCandidate,
  type DiscordNotificationSelection,
} from "../discord/index.js";
import type { StateNotificationLedger } from "../persistence/state-documents.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

export function sortByKey<Value>(
  values: readonly Value[],
  keyOf: (value: Value) => string,
): readonly Value[] {
  const sorted = [...values].sort((left, right) => compareStrings(keyOf(left), keyOf(right)));
  const keys = sorted.map(keyOf);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("公開計画の識別子が重複しています");
  }
  return Object.freeze(sorted);
}

export function canonicalSelection(
  selection: DiscordNotificationSelection,
): DiscordNotificationSelection {
  const pendingNotifications = sortByKey(
    selection.pendingNotifications,
    (pending) => pending.notificationKey,
  );
  if (selection.action === "skip_digest") {
    const emptyCandidates: readonly [] = Object.freeze([]);
    const emptyReservations: readonly [] = Object.freeze([]);
    return Object.freeze({
      action: "skip_digest",
      reason: selection.reason,
      candidates: emptyCandidates,
      ledgerReservations: emptyReservations,
      pendingNotifications,
    });
  }
  const candidates = sortByKey(
    selection.candidates.map((candidate) => {
      const reasons = sortByKey(candidate.reasons, (reason) => reason.notificationKey);
      const [first, ...rest] = reasons;
      if (first == null) {
        throw new TypeError("公開計画の通知候補に理由がありません");
      }
      const selectedReasons: DiscordNotificationCandidate["reasons"] = Object.freeze([
        first,
        ...rest,
      ]);
      if (candidate.severity !== calculateDiscordNotificationCandidateSeverity(selectedReasons)) {
        throw new TypeError("公開計画の通知候補と理由の重要度が一致しません");
      }
      return Object.freeze({ ...candidate, reasons: selectedReasons });
    }),
    (candidate) => candidate.itemNodeId,
  );
  const ledgerReservations = sortByKey(
    selection.ledgerReservations,
    (reservation) => reservation.notificationKey,
  );
  const [firstCandidate, ...restCandidates] = candidates;
  const [firstReservation, ...restReservations] = ledgerReservations;
  if (firstCandidate == null || firstReservation == null) {
    throw new TypeError("公開計画の通知候補と予約が空です");
  }
  const selectedCandidates: Extract<
    DiscordNotificationSelection,
    { action: "create_digest" }
  >["candidates"] = Object.freeze([firstCandidate, ...restCandidates]);
  const selectedReservations: Extract<
    DiscordNotificationSelection,
    { action: "create_digest" }
  >["ledgerReservations"] = Object.freeze([firstReservation, ...restReservations]);
  return Object.freeze({
    action: "create_digest",
    candidates: selectedCandidates,
    ledgerReservations: selectedReservations,
    pendingNotifications,
  });
}

/** runが所有する通常通知ledgerだけをcanonicalな値へ投影する。 */
export function normalNotificationLedgerValue(ledger: StateNotificationLedger): Readonly<{
  schemaVersion: StateNotificationLedger["schemaVersion"];
  entries: readonly StateNotificationLedger["entries"][number][];
  pendingNotifications: readonly StateNotificationLedger["pendingNotifications"][number][];
}> {
  return Object.freeze({
    schemaVersion: ledger.schemaVersion,
    entries: sortByKey(ledger.entries, (entry) => entry.notificationKey),
    pendingNotifications: sortByKey(ledger.pendingNotifications, (entry) => entry.notificationKey),
  });
}

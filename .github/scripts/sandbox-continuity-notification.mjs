import { serializeCanonicalJson } from "../../dist/canonical-json/value.js";

import { sha256 } from "./sandbox-continuity-result.mjs";

/** 2回目runの送信抑止と新規送信、台帳、履歴Pagesを照合する。 */
export function assertSecondNotificationCoverage(input) {
  const {
    firstLedger,
    ledger,
    firstSentKeyDigests,
    firstRecordedSendKeyDigests,
    suppressedKeyDigests,
    outbox,
    messageReceipts,
    historyBuild,
    historyPages,
  } = input;
  const firstSentEntries = firstLedger.entries.filter((entry) => entry.status === "sent");
  const firstSentKeys = new Set(firstSentEntries.map((entry) => entry.notificationKey));
  const currentEntries = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  const newSentKeyDigests = ledger.entries
    .filter((entry) => entry.status === "sent" && !firstSentKeys.has(entry.notificationKey))
    .map((entry) => sha256(entry.notificationKey))
    .sort();
  const sentMessageReceipts = messageReceipts.filter((entry) => entry.status === "sent");
  const recordedSendKeyDigests = sentMessageReceipts
    .flatMap((entry) => entry.result.notificationKeys.map((key) => sha256(key)))
    .sort();
  const selectedContext = outbox.selectedContext;
  const selectedKeyDigests =
    selectedContext.action === "create_digest"
      ? selectedContext.ledgerReservations.map((entry) => sha256(entry.notificationKey)).sort()
      : [];
  const hasNewSentHistory = newSentKeyDigests.length > 0;
  if (
    JSON.stringify(firstSentEntries.map((entry) => sha256(entry.notificationKey)).sort()) !==
      JSON.stringify(firstSentKeyDigests) ||
    !firstRecordedSendKeyDigests.some((key) => suppressedKeyDigests.includes(key)) ||
    suppressedKeyDigests.some(
      (key) => !firstSentKeyDigests.includes(key) || selectedKeyDigests.includes(key),
    ) ||
    firstSentEntries.some((entry) => {
      const current = currentEntries.get(entry.notificationKey);
      return current == null || serializeCanonicalJson(current) !== serializeCanonicalJson(entry);
    }) ||
    messageReceipts.length !== sentMessageReceipts.length ||
    sentMessageReceipts.some((entry) =>
      entry.result.notificationKeys.some((key) => {
        const current = currentEntries.get(key);
        return (
          firstSentKeys.has(key) ||
          current?.status !== "sent" ||
          current.discordMessageId !== entry.result.discordMessageId ||
          current.sentAt !== entry.effectOccurredAt
        );
      }),
    ) ||
    JSON.stringify(recordedSendKeyDigests) !== JSON.stringify(newSentKeyDigests) ||
    JSON.stringify(selectedKeyDigests) !== JSON.stringify(newSentKeyDigests) ||
    (hasNewSentHistory
      ? outbox.delivery !== "send" ||
        selectedContext.action !== "create_digest" ||
        selectedContext.candidates.length === 0 ||
        historyBuild.status !== "built" ||
        historyPages.status !== "deployed" ||
        historyPages.result?.externalReference?.kind !== "recording"
      : outbox.delivery !== "no_candidates" ||
        selectedContext.action !== "skip_digest" ||
        historyBuild.status !== "not_required" ||
        historyPages.status !== "not_required")
  ) {
    throw new TypeError("2回目runの通知key、台帳、receiptまたは履歴Pagesが一致しません");
  }
}

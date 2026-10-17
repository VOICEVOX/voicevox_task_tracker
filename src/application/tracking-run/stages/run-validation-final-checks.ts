import type { AiBudgetLedgerSummary } from "../contracts/ai-budget-ledger.js";
import type { FinalSnapshotCandidate } from "../contracts/final-snapshot.js";
import type { PreviousNotificationLedger } from "../contracts/previous-state.js";
import { publicationPagesUrlSchema } from "../contracts/publication-inputs.js";
import type { NotificationLedgerEntry, PendingNotification } from "../../../domain/index.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  assertRunValueMatches,
  assertRunValuesMatch,
  runValuesById,
} from "./run-validation-compare.js";

/** 通知管理記録の現行版で照合する値。 */
export type RunValidationLedger = PreviousNotificationLedger & Readonly<{ schemaVersion: string }>;

/** 通知選別の参照と予約を照合する値。 */
export type RunNotificationSelection =
  | Readonly<{
      action: "skip_digest";
      reason: "held" | "no_candidates";
      candidates: readonly Readonly<{
        itemNodeId: string;
        reasons: readonly Readonly<{ notificationKey: string }>[];
      }>[];
      ledgerReservations: readonly Readonly<{ notificationKey: string }>[];
      pendingNotifications: readonly PendingNotification[];
    }>
  | Readonly<{
      action: "create_digest";
      candidates: readonly Readonly<{
        itemNodeId: string;
        reasons: readonly Readonly<{ notificationKey: string }>[];
      }>[];
      ledgerReservations: readonly Readonly<{ notificationKey: string }>[];
      pendingNotifications: readonly PendingNotification[];
    }>;

/** 公開値内のURLがGitHubか設定由来のPagesのHTTPS URLを指すことを確認する。 */
export function assertPublicUrls(value: unknown, path: readonly (string | number)[]): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertPublicUrls(entry, [...path, index]);
    return;
  }
  if (typeof value !== "object" || value == null) return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if ((key === "url" || key === "sourceUrl") && typeof entry === "string") {
      const isConfiguredPagesUrl =
        (entryPath.length === 5 &&
          entryPath[0] === "publicValues" &&
          entryPath[1] === 1 &&
          entryPath[2] === "publicationInputs" &&
          entryPath[3] === "pages" &&
          entryPath[4] === "url") ||
        (entryPath.length === 4 &&
          entryPath[0] === "validatedRun" &&
          entryPath[1] === "publicationInputs" &&
          entryPath[2] === "pages" &&
          entryPath[3] === "url");
      if (isConfiguredPagesUrl) {
        if (!publicationPagesUrlSchema.safeParse(entry).success) {
          throw new RunCompletenessError("unsafe_public_value", entry, entryPath, undefined);
        }
        continue;
      }
      if (!URL.canParse(entry)) {
        throw new RunCompletenessError("unsafe_public_value", entry, entryPath, undefined);
      }
      const url = new URL(entry);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        throw new RunCompletenessError("unsafe_public_value", entry, entryPath, undefined);
      }
    }
    assertPublicUrls(entry, entryPath);
  }
}

type NotificationValidationInput = Readonly<{
  finalized: PersonalReminderFinalizedRun;
  candidate: FinalSnapshotCandidate;
  previousNotificationLedger: RunValidationLedger;
  notificationLedger: RunValidationLedger;
  notificationSelection: RunNotificationSelection;
  ledgerEntriesToMerge: readonly NotificationLedgerEntry[];
}>;

/** 前回と今回の通知管理記録を選別結果へ照合する。 */
export function assertNotificationLedger(input: NotificationValidationInput): void {
  const previous = input.finalized.data.snapshotProjection.previousNotificationLedger;
  const { schemaVersion, ...actualPrevious } = input.previousNotificationLedger;
  void schemaVersion;
  assertRunValueMatches(previous, actualPrevious, ["previousNotificationLedger"], "ledger");
  assertRunValueMatches(
    input.notificationSelection.pendingNotifications,
    input.notificationLedger.pendingNotifications,
    ["notificationLedger", "pendingNotifications"],
    "ledger",
  );
  assertRunValueMatches(
    input.previousNotificationLedger.operationsAlerts,
    input.notificationLedger.operationsAlerts,
    ["notificationLedger", "operationsAlerts"],
    "ledger",
  );
  const expectedEntries = new Map(
    input.previousNotificationLedger.entries.map((entry) => [entry.notificationKey, entry]),
  );
  if (expectedEntries.size !== input.previousNotificationLedger.entries.length) {
    throw new RunCompletenessError(
      "duplicate_id",
      "notification",
      ["previousNotificationLedger", "entries"],
      undefined,
    );
  }
  for (const entry of input.ledgerEntriesToMerge) {
    const existing = expectedEntries.get(entry.notificationKey);
    if (
      entry.status === "acknowledged" &&
      (existing?.status === "sent" || existing?.status === "acknowledged")
    ) {
      continue;
    }
    expectedEntries.set(entry.notificationKey, entry);
  }
  assertRunValuesMatch(
    [...expectedEntries.values()],
    input.notificationLedger.entries,
    (entry) => entry.notificationKey,
    (entry) => entry.notificationKey,
    ["notificationLedger", "entries"],
  );
  const action = input.finalized.core.executionPolicy.notificationAction;
  const selection = input.notificationSelection;
  if (
    (action === "hold" && (selection.action !== "skip_digest" || selection.reason !== "held")) ||
    (action === "acknowledge-current" &&
      (selection.action !== "skip_digest" || selection.reason !== "no_candidates")) ||
    (action === "send" &&
      selection.action === "skip_digest" &&
      selection.reason !== "no_candidates")
  ) {
    throw new RunCompletenessError(
      "ledger_mismatch",
      "notification",
      ["notificationSelection"],
      undefined,
    );
  }
  const itemIds = new Set<string>(input.candidate.items.map((item) => item.nodeId));
  const candidates = runValuesById(selection.candidates, (candidate) => candidate.itemNodeId, [
    "notificationSelection",
    "candidates",
  ]);
  const reasons = runValuesById(
    selection.candidates.flatMap((candidate) => candidate.reasons),
    (reason) => reason.notificationKey,
    ["notificationSelection", "candidates", "reasons"],
  );
  const reservations = runValuesById(
    selection.ledgerReservations,
    (reservation) => reservation.notificationKey,
    ["notificationSelection", "ledgerReservations"],
  );
  if (
    (selection.action === "skip_digest" && (candidates.size !== 0 || reservations.size !== 0)) ||
    (selection.action === "create_digest" && (candidates.size === 0 || reservations.size === 0))
  ) {
    throw new RunCompletenessError(
      "ledger_mismatch",
      "notification",
      ["notificationSelection"],
      undefined,
    );
  }
  for (const candidate of selection.candidates) {
    if (!itemIds.has(candidate.itemNodeId)) {
      throw new RunCompletenessError(
        "missing_value",
        candidate.itemNodeId,
        ["notificationSelection", "candidates"],
        undefined,
      );
    }
    if (candidate.reasons.length === 0) {
      throw new RunCompletenessError(
        "missing_value",
        candidate.itemNodeId,
        ["notificationSelection", "candidates", "reasons"],
        undefined,
      );
    }
  }
  for (const key of reasons.keys()) {
    if (!reservations.has(key)) {
      throw new RunCompletenessError(
        "ledger_mismatch",
        key,
        ["notificationSelection", "ledgerReservations"],
        undefined,
      );
    }
  }
  for (const reservation of selection.ledgerReservations) {
    if (!reasons.has(reservation.notificationKey)) {
      throw new RunCompletenessError(
        "ledger_mismatch",
        reservation.notificationKey,
        ["notificationSelection", "candidates", "reasons"],
        undefined,
      );
    }
    const matching = input.notificationLedger.entries.find(
      (entry) => entry.notificationKey === reservation.notificationKey,
    );
    assertRunValueMatches(
      reservation,
      matching,
      ["notificationLedger", "entries", reservation.notificationKey],
      reservation.notificationKey,
    );
  }
  if (action !== "acknowledge-current") {
    assertRunValuesMatch(
      selection.ledgerReservations,
      input.ledgerEntriesToMerge,
      (entry) => entry.notificationKey,
      (entry) => entry.notificationKey,
      ["notificationSelection", "ledgerReservations"],
    );
  }
  for (const pending of selection.pendingNotifications) {
    if (!itemIds.has(pending.itemNodeId)) {
      throw new RunCompletenessError(
        "missing_value",
        pending.itemNodeId,
        ["notificationSelection", "pendingNotifications"],
        undefined,
      );
    }
  }
}

type MetricsValidationInput = Readonly<{
  finalized: PersonalReminderFinalizedRun;
  candidate: FinalSnapshotCandidate;
  metrics: RunValidationMetrics;
}>;

/** 完全性照合に必要なrun指標。 */
export type RunValidationMetrics = Readonly<{
  repositoryCount: number;
  itemCount: number;
  activeEdgeCount: number;
  aiProcessAttemptCount: number;
}>;

/** 公開前の件数と共有予算の実試行数を照合する。 */
export function assertRunMetrics(
  input: MetricsValidationInput,
  summary: AiBudgetLedgerSummary,
): void {
  const { candidate, metrics } = input;
  const counts: readonly (readonly [keyof MetricsValidationInput["metrics"], number])[] = [
    ["repositoryCount", candidate.repositories.length],
    ["itemCount", candidate.items.length],
    ["activeEdgeCount", candidate.relations.filter((relation) => relation.active).length],
    ["aiProcessAttemptCount", summary.processAttemptCount],
  ];
  for (const [field, expected] of counts) {
    if (metrics[field] !== expected) {
      throw new RunCompletenessError("field_mismatch", field, ["metrics", field], undefined);
    }
  }
  if (input.finalized.core.aiBudget.ledgerId !== input.finalized.core.identity.runId) {
    throw new RunCompletenessError(
      "ledger_mismatch",
      "aiBudget",
      ["core", "aiBudget", "ledgerId"],
      undefined,
    );
  }
}

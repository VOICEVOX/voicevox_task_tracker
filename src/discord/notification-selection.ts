import {
  compareSeverity,
  type NotificationLedgerEntry,
  type Severity,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import type {
  CandidateDraft,
  DiscordNotificationCandidate,
  DiscordNotificationSelection,
  EligibleReason,
  NotificationLedgerAcknowledgement,
  NotificationLedgerReservation,
  SelectDiscordNotificationsInput,
  SelectedDiscordNotificationReason,
} from "./notification-selection-contracts.js";
import { compareEligibleReasons, reservationExpiresAt } from "./notification-selection-ledger.js";
import { createPendingSelectionState } from "./notification-selection-pending.js";
import { isTimeNotificationReasonCode } from "./notification-selection-reasons.js";
import { severityRank } from "./notification-selection-signals.js";
import { validateInput } from "./notification-selection-validation.js";
import { compareStrings, parseTimestamp } from "./notification-selection-values.js";

function candidateTier(draft: CandidateDraft): number {
  if (!draft.reasons.some((reason) => reason.signal.highPriorityEligible)) {
    return 1;
  }
  const severity = candidateSeverity(draft);
  if (severity === "critical") {
    return 7;
  }
  if (draft.reasons.some((reason) => reason.signal.reason.reasonCode === "dependency_cycle")) {
    return 6;
  }
  if (severity === "urgent") {
    return 5;
  }
  if (draft.reasons.some((reason) => reason.signal.reason.reasonCode === "newly_unblocked")) {
    return 4;
  }
  if (
    draft.reasons.some((reason) => reason.signal.reason.reasonCode === "responsibility_changed")
  ) {
    return 3;
  }
  if (severity === "watch") {
    return 2;
  }
  return 1;
}

function candidateSeverity(draft: CandidateDraft): Severity {
  let severity: Severity = "none";
  for (const reason of draft.reasons) {
    if (compareSeverity(reason.signal.severity, severity) > 0) {
      severity = reason.signal.severity;
    }
  }
  return severity;
}

/** 選択済み理由の集合からdigest候補の代表severityを再計算する。 */
export function calculateDiscordNotificationCandidateSeverity(
  reasons: readonly SelectedDiscordNotificationReason[],
): Severity {
  const first = reasons[0];
  assertNonNullable(first, "通知候補の理由がありません");
  let severity: Severity = "none";
  for (const reason of reasons) {
    if (compareSeverity(reason.severity, severity) > 0) {
      severity = reason.severity;
    }
  }
  return severity;
}

function candidateStallSince(draft: CandidateDraft, evaluatedTimestamp: number): number {
  const stallTimestamps = draft.reasons.map((reason) => {
    if (reason.signal.source.kind === "personal_reminder") {
      return parseTimestamp(
        reason.signal.source.context.stallSince.at,
        `${draft.item.nodeId}の個人催促stallSince`,
      );
    }
    return parseTimestamp(draft.item.current.stallSince, `${draft.item.nodeId}のstallSince`);
  });
  return evaluatedTimestamp - Math.min(...stallTimestamps);
}

function compareCandidateMetrics(
  left: CandidateDraft,
  right: CandidateDraft,
  evaluatedTimestamp: number,
): -1 | 0 | 1 {
  const severityDifference =
    severityRank(candidateSeverity(right)) - severityRank(candidateSeverity(left));
  if (severityDifference !== 0) {
    return severityDifference < 0 ? -1 : 1;
  }
  const repositoryDifference =
    right.item.graph.downstreamImpact.repositoryCount -
    left.item.graph.downstreamImpact.repositoryCount;
  if (repositoryDifference !== 0) {
    return repositoryDifference < 0 ? -1 : 1;
  }
  const nodeDifference =
    right.item.graph.downstreamImpact.openNodeCount -
    left.item.graph.downstreamImpact.openNodeCount;
  if (nodeDifference !== 0) {
    return nodeDifference < 0 ? -1 : 1;
  }
  const weightDifference = right.item.priorityWeight - left.item.priorityWeight;
  if (weightDifference !== 0) {
    return weightDifference < 0 ? -1 : 1;
  }
  const stallDifference =
    candidateStallSince(right, evaluatedTimestamp) - candidateStallSince(left, evaluatedTimestamp);
  if (stallDifference !== 0) {
    return stallDifference < 0 ? -1 : 1;
  }
  return compareStrings(left.item.nodeId, right.item.nodeId);
}

function compareCandidateDrafts(
  left: CandidateDraft,
  right: CandidateDraft,
  evaluatedTimestamp: number,
): -1 | 0 | 1 {
  const tierDifference = candidateTier(right) - candidateTier(left);
  if (tierDifference !== 0) {
    return tierDifference < 0 ? -1 : 1;
  }
  const metricComparison = compareCandidateMetrics(left, right, evaluatedTimestamp);
  if (metricComparison !== 0) {
    return metricComparison;
  }
  const leftReason = left.reasons[0];
  const rightReason = right.reasons[0];
  return compareEligibleReasons(leftReason, rightReason);
}

function selectedReason(reason: EligibleReason): SelectedDiscordNotificationReason {
  const signalReason = reason.signal.reason;
  const selectionFields = {
    notificationKey: reason.notificationKey,
    severity: reason.signal.severity,
    source: reason.signal.source,
  };
  if (isTimeNotificationReasonCode(signalReason.reasonCode)) {
    if (signalReason.threshold.status === "recorded") {
      return Object.freeze({
        reasonCode: signalReason.reasonCode,
        threshold: Object.freeze({
          status: "recorded",
          hours: signalReason.threshold.hours,
        }),
        ...selectionFields,
      });
    }
    if (signalReason.threshold.status === "not_reached") {
      return Object.freeze({
        reasonCode: signalReason.reasonCode,
        threshold: Object.freeze({
          status: "not_reached",
          elapsedHours: signalReason.threshold.elapsedHours,
        }),
        ...selectionFields,
      });
    }
    throw new TypeError(`時間系通知理由 ${signalReason.reasonCode}の基準時間が未記録です`);
  }
  return Object.freeze({
    reasonCode: signalReason.reasonCode,
    threshold: Object.freeze({
      status: "not_applicable",
    }),
    ...selectionFields,
  });
}

function nonEmptySelectedReasons(
  reasons: readonly SelectedDiscordNotificationReason[],
  context: string,
): readonly [SelectedDiscordNotificationReason, ...SelectedDiscordNotificationReason[]] {
  const [first, ...rest] = reasons;
  assertNonNullable(first, context);
  return Object.freeze([first, ...rest]);
}

function createCandidate(draft: CandidateDraft): DiscordNotificationCandidate {
  const reasons = draft.reasons.map(selectedReason);
  const nonEmptyReasons = nonEmptySelectedReasons(
    reasons,
    `${draft.item.nodeId}の通知理由がありません`,
  );
  return Object.freeze({
    itemNodeId: draft.item.nodeId,
    reasons: nonEmptyReasons,
    severity: calculateDiscordNotificationCandidateSeverity(nonEmptyReasons),
    downstreamImpact: Object.freeze({
      ...draft.item.graph.downstreamImpact,
    }),
    priorityWeight: draft.item.priorityWeight,
  });
}

function createLedgerReservation(
  candidate: DiscordNotificationCandidate,
  reason: SelectedDiscordNotificationReason,
  evaluatedAt: UtcIsoDateTime,
): NotificationLedgerReservation {
  return Object.freeze({
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: reason.severity,
    reservedAt: evaluatedAt,
    expiresAt: reservationExpiresAt(evaluatedAt),
    status: "reserved",
  } satisfies NotificationLedgerEntry);
}

function nonEmptyCandidates(
  candidates: readonly DiscordNotificationCandidate[],
): readonly [DiscordNotificationCandidate, ...DiscordNotificationCandidate[]] {
  const [first, ...rest] = candidates;
  assertNonNullable(first, "通知候補がありません");
  return Object.freeze([first, ...rest]);
}

function nonEmptyLedgerEntries(
  entries: readonly NotificationLedgerReservation[],
): readonly [NotificationLedgerReservation, ...NotificationLedgerReservation[]] {
  const [first, ...rest] = entries;
  assertNonNullable(first, "通知候補に対応するledger予約がありません");
  return Object.freeze([first, ...rest]);
}

/** noise、ledger、順位、件数上限を適用してDiscord通知候補を選ぶ。 */
export function selectDiscordNotifications(
  input: SelectDiscordNotificationsInput,
): DiscordNotificationSelection {
  const evaluatedTimestamp = validateInput(input);
  const pendingSelection = createPendingSelectionState(input, evaluatedTimestamp);
  const candidates = [...pendingSelection.candidateDrafts]
    .sort((left, right) => compareCandidateDrafts(left, right, evaluatedTimestamp))
    .slice(0, input.settings.maxItemsPerDigest)
    .map(createCandidate);
  if (candidates.length === 0) {
    const emptyCandidates: readonly [] = Object.freeze([]);
    const emptyLedgerReservations: readonly [] = Object.freeze([]);
    return Object.freeze({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: emptyCandidates,
      ledgerReservations: emptyLedgerReservations,
      pendingNotifications: pendingSelection.pendingNotifications,
    });
  }

  const selectedCandidates = nonEmptyCandidates(candidates);
  const ledgerReservations = selectedCandidates.flatMap((candidate) =>
    candidate.reasons.map((reason) =>
      createLedgerReservation(candidate, reason, input.evaluatedAt),
    ),
  );
  return Object.freeze({
    action: "create_digest",
    candidates: selectedCandidates,
    ledgerReservations: nonEmptyLedgerEntries(ledgerReservations),
    pendingNotifications: pendingSelection.pendingNotifications,
  });
}

function createAcknowledgedLedgerEntry(
  candidate: DiscordNotificationCandidate,
  reason: SelectedDiscordNotificationReason,
  evaluatedAt: UtcIsoDateTime,
): NotificationLedgerAcknowledgement {
  return Object.freeze({
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: reason.severity,
    reservedAt: evaluatedAt,
    status: "acknowledged",
    acknowledgedAt: evaluatedAt,
  } satisfies NotificationLedgerEntry);
}

/** 現在の全通知候補に対応する確認済みledger entryを上限なしで生成する。 */
export function createAcknowledgedNotificationLedgerEntries(
  input: SelectDiscordNotificationsInput,
): readonly NotificationLedgerAcknowledgement[] {
  const evaluatedTimestamp = validateInput(input);
  const pendingSelection = createPendingSelectionState(
    {
      ...input,
      ledger: Object.freeze([]),
    },
    evaluatedTimestamp,
  );
  const candidates = [...pendingSelection.candidateDrafts]
    .sort((left, right) => compareCandidateDrafts(left, right, evaluatedTimestamp))
    .map(createCandidate);
  const acknowledgedEntries = candidates.flatMap((candidate) =>
    candidate.reasons.map((reason) =>
      createAcknowledgedLedgerEntry(candidate, reason, input.evaluatedAt),
    ),
  );
  return Object.freeze(acknowledgedEntries);
}

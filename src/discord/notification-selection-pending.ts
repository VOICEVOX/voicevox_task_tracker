import {
  currentPersonalReminderAssessment,
  isTerminalStatus,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type GitHubNodeId,
  type NotificationLedgerEntry,
  type PendingNotification,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import type {
  CandidateDraft,
  DiscordNotificationItem,
  DiscordNotificationSelectionSettings,
  DiscordPersonalReminderInput,
  EligibleReason,
  ReasonSignal,
  SelectDiscordNotificationsInput,
} from "./notification-selection-contracts.js";
import { systemReasonSource } from "./notification-selection-contracts.js";
import {
  createNotificationKey,
  legacySystemSignalForPersonalReason,
  personalReminderResponsibleSignature,
  personalReminderScopeIncludesItem,
  responsibilityPeriodStart,
} from "./notification-selection-key.js";
import {
  compareEligibleReasons,
  createCurrentCandidateDrafts,
  isEligibleAgainstLedger,
  toNonEmptyReasons,
} from "./notification-selection-ledger.js";
import {
  isPersonalReminderReasonCode,
  isTimeNotificationReasonCode,
  notificationReasonForSelection,
  overdueReasonCode,
  personalReminderActionKindForReason,
} from "./notification-selection-reasons.js";
import {
  createPersonalReminderSignals,
  hasRecentMeaningfulProgress,
  isImportantNewlyUnblocked,
  isRecentDraft,
  isStateReasonAllowed,
} from "./notification-selection-signals.js";
import { samePersonalReminderTimeBasis } from "./notification-selection-validation.js";
import {
  compareStrings,
  parseTimestamp,
  waitingOnComparisonSignature,
} from "./notification-selection-values.js";

type PendingNotificationDisposition = "send" | "hold" | "drop";

type PendingSelectionState = Readonly<{
  pendingNotifications: readonly PendingNotification[];
  candidateDrafts: readonly CandidateDraft[];
}>;

function pendingReplacementKey(pending: PendingNotification): string {
  if (pending.target.kind === "cycle") {
    return JSON.stringify([pending.itemNodeId, pending.reason.reasonCode, pending.target.cycleId]);
  }
  if (pending.target.kind === "personal_reminder") {
    return JSON.stringify([pending.itemNodeId, pending.reason.reasonCode, pending.target.causeId]);
  }
  return JSON.stringify([pending.itemNodeId, pending.reason.reasonCode]);
}

function pendingMatchesDraft(pending: PendingNotification, draft: PendingNotification): boolean {
  if (pending.notificationKey !== draft.notificationKey) return false;
  if (pending.target.kind !== "personal_reminder") {
    return draft.target.kind !== "personal_reminder";
  }
  if (draft.target.kind !== "personal_reminder") return false;
  return (
    pending.target.causeId === draft.target.causeId &&
    pending.target.responsibilityId === draft.target.responsibilityId &&
    samePersonalReminderTimeBasis(pending.target.actionableSince, draft.target.actionableSince) &&
    samePersonalReminderTimeBasis(pending.target.stallSince, draft.target.stallSince)
  );
}

function legacyPendingEpisodeMatchesCurrent(
  item: DiscordNotificationItem,
  pending: PendingNotification,
): boolean {
  if (pending.target.kind !== "overdue") {
    return false;
  }
  return (
    pending.itemNodeId === item.nodeId &&
    pending.target.status === item.current.status &&
    pending.target.waitClass === item.current.waitClass &&
    pending.target.lastProgressAt === item.current.lastProgressAt &&
    waitingOnComparisonSignature(item.current.waitingOn) ===
      waitingOnComparisonSignature(pending.target.waitingOn)
  );
}

function legacyPendingCauseMatchesBase(
  item: DiscordNotificationItem,
  pending: PendingNotification,
  input: DiscordPersonalReminderInput,
): boolean {
  if (
    pending.target.kind !== "overdue" ||
    !legacyPendingEpisodeMatchesCurrent(item, pending) ||
    !isPersonalReminderReasonCode(pending.reason.reasonCode) ||
    input.cause.itemNodeId !== item.nodeId ||
    input.cause.reasonCode !== pending.reason.reasonCode ||
    input.cause.action.kind !== personalReminderActionKindForReason(input.cause.reasonCode) ||
    !personalReminderScopeIncludesItem(input.cause)
  ) {
    return false;
  }
  return (
    personalReminderResponsibleSignature(input.cause.responsible) ===
    waitingOnComparisonSignature(pending.target.waitingOn)
  );
}

function legacyPendingMatchesPersonalReminderCause(
  item: DiscordNotificationItem,
  pending: PendingNotification,
  input: DiscordPersonalReminderInput,
): boolean {
  if (!legacyPendingCauseMatchesBase(item, pending, input)) {
    return false;
  }
  const reasonCode = pending.reason.reasonCode;
  if (!isPersonalReminderReasonCode(reasonCode)) {
    throw new TypeError(`旧個人催促pendingの理由 ${reasonCode}が不正です`);
  }
  const legacySignal = legacySystemSignalForPersonalReason(item, reasonCode);
  if (legacySignal == null || input.cause.actionableClock.status !== "observed") {
    return false;
  }
  if (
    input.cause.actionableClock.actionableSince.source !== "event" ||
    input.cause.actionableClock.stallSince.source !== "event" ||
    input.cause.actionableClock.actionableSince.at !== responsibilityPeriodStart(item) ||
    input.cause.actionableClock.stallSince.at !== item.current.stallSince
  ) {
    return false;
  }
  return pending.notificationKey === createNotificationKey(item, legacySignal);
}

function migrateLegacyPersonalPending(
  item: DiscordNotificationItem,
  pending: PendingNotification,
): PendingNotification | undefined {
  if (
    pending.target.kind !== "overdue" ||
    !isPersonalReminderReasonCode(pending.reason.reasonCode)
  ) {
    return pending;
  }
  if (
    item.personalReminderCausePlanning.planningVersion !==
      PERSONAL_REMINDER_CAUSE_PLANNING_VERSION ||
    item.personalReminderCausePlanning.status === "pending"
  ) {
    return pending;
  }
  if (item.personalReminderCausePlanning.status === "excluded") {
    return undefined;
  }
  const inputs = item.personalReminderCauses.filter((input) =>
    legacyPendingCauseMatchesBase(item, pending, input),
  );
  const exactInputs = inputs.filter((input) =>
    legacyPendingMatchesPersonalReminderCause(item, pending, input),
  );
  if (exactInputs.length > 1) {
    throw new TypeError(`${item.nodeId}の旧個人催促pendingが複数原因へ一致します`);
  }
  const exactInput = exactInputs[0];
  if (exactInput != null) {
    if (exactInput.cause.actionableClock.status !== "observed") {
      throw new TypeError(`${item.nodeId}の旧個人催促pendingに時計がありません`);
    }
    return Object.freeze({
      ...pending,
      target: Object.freeze({
        kind: "personal_reminder",
        causeId: exactInput.cause.causeId,
        responsibilityId: exactInput.cause.responsibilityId,
        actionableSince: Object.freeze({ ...exactInput.cause.actionableClock.actionableSince }),
        stallSince: Object.freeze({ ...exactInput.cause.actionableClock.stallSince }),
      }),
    });
  }
  if (inputs.length > 0 || item.repositoryFreshness === "stale") {
    return pending;
  }
  return undefined;
}

function pendingReasonSignal(
  item: DiscordNotificationItem,
  pending: PendingNotification,
  currentReason: EligibleReason | undefined,
): ReasonSignal {
  if (currentReason != null) {
    return currentReason.signal;
  }
  if (pending.target.kind === "personal_reminder") {
    const target = pending.target;
    const currentInput = item.personalReminderCauses.find(
      (input) => input.cause.causeId === target.causeId,
    );
    if (currentInput?.staleness.status !== "eligible") {
      throw new TypeError(`${pending.itemNodeId}の個人催促送信待ち通知を復元できません`);
    }
    const currentSignal = createPersonalReminderSignals(item).find(
      (signal) =>
        signal.source.kind === "personal_reminder" &&
        signal.source.context.causeId === target.causeId,
    );
    if (currentSignal == null) {
      throw new TypeError(`${pending.itemNodeId}の個人催促送信待ち通知理由がありません`);
    }
    return currentSignal;
  }
  return Object.freeze({
    reason: pending.reason,
    stateDiscriminator: pending.notificationKey,
    highPriorityEligible: pending.highPriorityEligible,
    target: pending.target,
    severity: item.current.severity,
    source: systemReasonSource(),
  });
}

function personalReminderInputForPending(
  item: DiscordNotificationItem,
  pending: PendingNotification,
): DiscordPersonalReminderInput | undefined {
  if (pending.target.kind !== "personal_reminder") {
    return undefined;
  }
  const target = pending.target;
  return item.personalReminderCauses.find(
    (input) =>
      input.cause.causeId === target.causeId &&
      input.cause.responsibilityId === target.responsibilityId,
  );
}

function personalReminderPendingClockMatchesCurrent(
  input: DiscordPersonalReminderInput,
  pending: PendingNotification,
): boolean {
  if (pending.target.kind !== "personal_reminder") {
    return false;
  }
  if (input.cause.actionableClock.status !== "observed") {
    return false;
  }
  return (
    samePersonalReminderTimeBasis(
      input.cause.actionableClock.actionableSince,
      pending.target.actionableSince,
    ) &&
    samePersonalReminderTimeBasis(input.cause.actionableClock.stallSince, pending.target.stallSince)
  );
}

function personalReminderPendingTargetMatchesCurrent(
  item: DiscordNotificationItem,
  pending: PendingNotification,
): boolean {
  const target = pending.target;
  if (target.kind !== "personal_reminder") {
    return true;
  }
  const input = item.personalReminderCauses.find(
    (candidate) => candidate.cause.causeId === target.causeId,
  );
  if (input == null) {
    if (item.personalReminderCausePlanning.status === "pending") {
      throw new TypeError(`${item.nodeId}の個人催促送信待ち通知の現在の原因を照合できません`);
    }
    return false;
  }
  if (
    input.cause.itemNodeId !== pending.itemNodeId ||
    input.cause.reasonCode !== pending.reason.reasonCode ||
    input.cause.responsibilityId !== target.responsibilityId
  ) {
    return false;
  }
  if (input.cause.actionableClock.status !== "observed") {
    throw new TypeError(`${item.nodeId}の個人催促送信待ち通知の現在の時計を照合できません`);
  }
  return personalReminderPendingClockMatchesCurrent(input, pending);
}

type PersonalReminderPendingState = "send" | "hold" | "drop";

function personalReminderPendingState(
  item: DiscordNotificationItem,
  pending: PendingNotification,
  evaluatedTimestamp: number,
): PersonalReminderPendingState {
  if (
    item.personalReminderCausePlanning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    return "hold";
  }
  switch (item.personalReminderCausePlanning.status) {
    case "pending":
      return "hold";
    case "excluded":
      return "drop";
    case "completed":
      break;
    default:
      throw new UnreachableError(item.personalReminderCausePlanning);
  }
  const input = personalReminderInputForPending(item, pending);
  if (input == null) {
    return item.repositoryFreshness === "stale" ? "hold" : "drop";
  }
  if (input.cause.reasonCode !== pending.reason.reasonCode) {
    return "drop";
  }
  if (input.cause.actionableClock.status !== "observed") {
    return "hold";
  }
  if (!personalReminderPendingClockMatchesCurrent(input, pending)) {
    return "drop";
  }
  const assessment = currentPersonalReminderAssessment(input.cause);
  if (assessment.status !== "available") {
    return "hold";
  }
  switch (assessment.result.verdict) {
    case "duplicate":
    case "not_required":
      return "drop";
    case "waiting":
    case "unknown":
      return "hold";
    case "actionable":
      break;
  }
  if (input.staleness.status !== "eligible") {
    return "hold";
  }
  if (
    input.staleness.severity === "none" ||
    input.staleness.severityReason.crossedThreshold.status !== "reached"
  ) {
    return "drop";
  }
  const currentSignal = createPersonalReminderSignals(item).find(
    (signal) =>
      signal.source.kind === "personal_reminder" &&
      signal.source.context.causeId === input.cause.causeId,
  );
  if (currentSignal == null) {
    throw new TypeError(`${item.nodeId}の個人催促送信待ち通知理由がありません`);
  }
  if (createNotificationKey(item, currentSignal) !== pending.notificationKey) {
    return "drop";
  }
  if (
    parseTimestamp(input.staleness.stallSince.at, `${item.nodeId}の個人催促stallSince`) >
    evaluatedTimestamp
  ) {
    throw new RangeError(`${item.nodeId}の個人催促stallSinceは判定時刻以前にしてください`);
  }
  return "send";
}

function pendingReasonMatchesCurrent(
  item: DiscordNotificationItem,
  pending: PendingNotification,
  evaluatedTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): boolean {
  const reasonCode = pending.reason.reasonCode;
  if (pending.target.kind === "personal_reminder") {
    return personalReminderPendingState(item, pending, evaluatedTimestamp) === "send";
  }
  switch (pending.target.kind) {
    case "responsibility":
      return (
        !isTerminalStatus(item.current.status) &&
        isStateReasonAllowed(item, reasonCode, settings.minimumAiConfidence) &&
        waitingOnComparisonSignature(item.current.waitingOn) ===
          waitingOnComparisonSignature(pending.target.waitingOn)
      );
    case "unblocked":
      return !item.graph.hasOpenBlockers && isImportantNewlyUnblocked(item);
    case "cycle": {
      const cycleId = pending.target.cycleId;
      return item.graph.currentDependencyCycleIds.some(
        (currentCycleId) => currentCycleId === cycleId,
      );
    }
    case "overdue": {
      if (
        pending.target.status !== item.current.status ||
        pending.target.waitClass !== item.current.waitClass ||
        pending.target.lastProgressAt !== item.current.lastProgressAt ||
        waitingOnComparisonSignature(item.current.waitingOn) !==
          waitingOnComparisonSignature(pending.target.waitingOn) ||
        item.current.severity === "none" ||
        hasRecentMeaningfulProgress(item, evaluatedTimestamp, settings.recentProgressGraceHours) ||
        !isStateReasonAllowed(item, reasonCode, settings.minimumAiConfidence)
      ) {
        return false;
      }
      if (isTimeNotificationReasonCode(reasonCode)) {
        if (overdueReasonCode(item.current.status, item.current.waitClass) !== reasonCode) {
          return false;
        }
        return (
          notificationReasonForSelection({
            item,
            reasonCode,
            source: "deterministic",
          }) != null
        );
      }
      if (reasonCode === "owner_unknown") {
        return item.current.status === "unknown" && item.current.waitClass === "owner";
      }
      if (reasonCode === "blocker_overdue") {
        const impact = item.graph.downstreamImpact;
        return (
          (impact.openNodeCount > 0 || impact.repositoryCount > 0) &&
          (item.current.severity === "urgent" || item.current.severity === "critical")
        );
      }
      throw new TypeError(`overdue対象に対応しない通知理由があります。理由: ${reasonCode}`);
    }
  }
}

function pendingNotificationDisposition(
  item: DiscordNotificationItem,
  pending: PendingNotification,
  evaluatedTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): PendingNotificationDisposition {
  if (isTerminalStatus(item.current.status)) {
    return "drop";
  }
  if (item.notificationsSuppressedByLabel || item.notificationClass === "automation_noise") {
    return "drop";
  }
  if (item.repositoryFreshness === "stale") {
    return "hold";
  }
  if (pending.target.kind === "personal_reminder") {
    const personalState = personalReminderPendingState(item, pending, evaluatedTimestamp);
    if (personalState !== "send") {
      return personalState;
    }
  } else if (
    pending.target.kind === "overdue" &&
    isPersonalReminderReasonCode(pending.reason.reasonCode)
  ) {
    return "hold";
  }
  if (!pendingReasonMatchesCurrent(item, pending, evaluatedTimestamp, settings)) {
    return "drop";
  }
  if (
    isRecentDraft(item, evaluatedTimestamp, settings.recentProgressGraceHours) ||
    item.latestChange === "bot_only" ||
    item.latestChange === "preview_update" ||
    item.latestChange === "renovate_dashboard_update"
  ) {
    return "hold";
  }
  return "send";
}

function mergePendingNotifications(
  input: SelectDiscordNotificationsInput,
  currentDrafts: readonly CandidateDraft[],
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  evaluatedTimestamp: number,
): readonly PendingNotification[] {
  const pendingByReplacementKey = new Map<string, PendingNotification>();
  const itemsByNodeId = new Map(input.items.map((item) => [item.nodeId, item]));
  for (const pending of input.pendingNotifications) {
    const item = itemsByNodeId.get(pending.itemNodeId);
    const migrated = item == null ? pending : migrateLegacyPersonalPending(item, pending);
    if (migrated == null) {
      continue;
    }
    if (item != null && !personalReminderPendingTargetMatchesCurrent(item, migrated)) {
      continue;
    }
    const replacementKey = pendingReplacementKey(migrated);
    if (
      migrated.target.kind === "personal_reminder" &&
      pendingByReplacementKey.has(replacementKey)
    ) {
      throw new TypeError(`${migrated.itemNodeId}の個人催促pendingがcause単位で重複しています`);
    }
    pendingByReplacementKey.set(replacementKey, migrated);
  }
  for (const draft of currentDrafts) {
    for (const reason of draft.reasons) {
      const existing = pendingByReplacementKey.get(
        pendingReplacementKey(reason.pendingNotification),
      );
      pendingByReplacementKey.set(
        pendingReplacementKey(reason.pendingNotification),
        existing != null && pendingMatchesDraft(existing, reason.pendingNotification)
          ? existing
          : reason.pendingNotification,
      );
    }
  }

  const currentNotificationKeys = new Set(
    currentDrafts.flatMap((draft) => draft.reasons.map((reason) => reason.notificationKey)),
  );
  return Object.freeze(
    [...pendingByReplacementKey.values()]
      .filter((pending) => {
        const ledgerEntry = ledgerByKey.get(pending.notificationKey);
        if (ledgerEntry?.status === "sent" || ledgerEntry?.status === "acknowledged") {
          return false;
        }
        const item = itemsByNodeId.get(pending.itemNodeId);
        if (item == null) {
          return false;
        }
        if (currentNotificationKeys.has(pending.notificationKey)) {
          return true;
        }
        return (
          pendingNotificationDisposition(item, pending, evaluatedTimestamp, input.settings) !==
          "drop"
        );
      })
      .sort((left, right) => compareStrings(left.notificationKey, right.notificationKey)),
  );
}

export function createPendingSelectionState(
  input: SelectDiscordNotificationsInput,
  evaluatedTimestamp: number,
): PendingSelectionState {
  const ledgerByKey = new Map(input.ledger.map((entry) => [entry.notificationKey, entry]));
  const currentDrafts = createCurrentCandidateDrafts(
    input,
    evaluatedTimestamp,
    ledgerByKey,
    input.ledger,
  );
  const pendingNotifications = mergePendingNotifications(
    input,
    currentDrafts,
    ledgerByKey,
    evaluatedTimestamp,
  );
  const itemsByNodeId = new Map(input.items.map((item) => [item.nodeId, item]));
  const currentNotificationKeys = new Set(
    currentDrafts.flatMap((draft) => draft.reasons.map((reason) => reason.notificationKey)),
  );
  const currentReasonsByKey = new Map(
    currentDrafts.flatMap((draft) =>
      draft.reasons.map((reason) => [reason.notificationKey, reason] as const),
    ),
  );
  const reasonsByNodeId = new Map<GitHubNodeId, EligibleReason[]>();

  for (const pending of pendingNotifications) {
    const item = itemsByNodeId.get(pending.itemNodeId);
    assertNonNullable(item, `送信待ち通知の対象項目がありません。対象: ${pending.itemNodeId}`);
    if (
      !currentNotificationKeys.has(pending.notificationKey) &&
      pendingNotificationDisposition(item, pending, evaluatedTimestamp, input.settings) !== "send"
    ) {
      continue;
    }
    const currentReason = currentReasonsByKey.get(pending.notificationKey);
    const reasonSignal = pendingReasonSignal(item, pending, currentReason);
    if (
      !isEligibleAgainstLedger(
        item,
        reasonSignal,
        pending.notificationKey,
        ledgerByKey,
        input.ledger,
        evaluatedTimestamp,
      )
    ) {
      continue;
    }
    const reasons = reasonsByNodeId.get(item.nodeId);
    const eligibleReason = Object.freeze({
      signal: reasonSignal,
      notificationKey: pending.notificationKey,
      pendingNotification: pending,
    });
    if (reasons == null) {
      reasonsByNodeId.set(item.nodeId, [eligibleReason]);
    } else {
      reasons.push(eligibleReason);
    }
  }

  const candidateDrafts = Object.freeze(
    [...reasonsByNodeId.entries()].map(([nodeId, reasons]) => {
      const item = itemsByNodeId.get(nodeId);
      assertNonNullable(item, `送信待ち通知の対象項目がありません。対象: ${nodeId}`);
      reasons.sort(compareEligibleReasons);
      return {
        item,
        reasons: toNonEmptyReasons(reasons, `${nodeId}の通知理由を選択できませんでした`),
      };
    }),
  );
  return Object.freeze({
    pendingNotifications,
    candidateDrafts,
  });
}

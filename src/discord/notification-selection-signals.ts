import {
  compareSeverity,
  createNotificationReason,
  createUtcIsoDateTime,
  currentPersonalReminderAssessment,
  isTerminalStatus,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type GitHubNodeId,
  type Severity,
} from "../domain/index.js";
import { type DependencyCycleId } from "../graph/index.js";
import { UnreachableError } from "../util/index.js";
import { type NotificationCause } from "./notification-cause-contracts.js";
import type {
  DiscordNotificationItem,
  DiscordNotificationReasonCode,
  DiscordNotificationSelectionSettings,
  DiscordPersonalReminderInput,
  DiscordPersonalReminderNotificationContext,
  ReasonSignal,
} from "./notification-selection-contracts.js";
import {
  RESPONSIBILITY_CHANGE_STALL_HOURS,
  systemReasonSource,
} from "./notification-selection-contracts.js";
import {
  isPersonalReminderReasonCode,
  isTimeNotificationReasonCode,
  notificationReasonForNonTimeSelection,
  notificationReasonForSelection,
  overdueReasonCode,
} from "./notification-selection-reasons.js";
import { pendingTargetForReason } from "./notification-selection-validation.js";
import {
  compareStrings,
  hoursBetween,
  parseTimestamp,
  waitingOnComparisonSignature,
} from "./notification-selection-values.js";

export function isRecentDraft(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
  graceHours: number,
): boolean {
  return (
    item.draftState === "draft" && hoursBetween(item.createdAt, evaluatedTimestamp) < graceHours
  );
}

export function isItemSuppressed(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): boolean {
  if (
    item.repositoryFreshness === "stale" ||
    item.notificationsSuppressedByLabel ||
    item.notificationClass === "automation_noise" ||
    isRecentDraft(item, evaluatedTimestamp, settings.recentProgressGraceHours)
  ) {
    return true;
  }
  switch (item.latestChange) {
    case "none":
    case "human":
      return false;
    case "bot_only":
    case "preview_update":
    case "renovate_dashboard_update":
      return true;
  }
}

export function isStateReasonAllowed(
  item: DiscordNotificationItem,
  reasonCode: DiscordNotificationReasonCode,
  minimumAiConfidence: number,
): boolean {
  if (item.decisionBasis.source === "deterministic") {
    return true;
  }
  return item.decisionBasis.confidence >= minimumAiConfidence || reasonCode === "owner_unknown";
}

function previousSeverity(item: DiscordNotificationItem): Severity {
  return item.previous.availability === "available" ? item.previous.value.severity : "none";
}

function shouldEvaluateOverdue(item: DiscordNotificationItem): boolean {
  const comparison = compareSeverity(item.current.severity, previousSeverity(item));
  if (comparison > 0) {
    return true;
  }
  if (comparison < 0) {
    return false;
  }
  if (
    item.current.status === "waiting_for_work" &&
    item.current.waitClass === "work" &&
    item.current.severityReason.kind === "elapsed_threshold" &&
    item.current.severityReason.crossedThreshold.status === "reached"
  ) {
    return true;
  }
  return item.current.severity === "urgent" || item.current.severity === "critical";
}

export function hasRecentMeaningfulProgress(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
  graceHours: number,
): boolean {
  const graceSince =
    item.draftState !== "not_applicable" &&
    (item.current.status === "waiting_for_owner" || item.current.status === "waiting_for_review")
      ? item.current.stallSince
      : item.current.lastProgressAt;
  return hoursBetween(graceSince, evaluatedTimestamp) < graceHours;
}

function createOverdueSignals(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): ReasonSignal[] {
  if (
    item.current.severity === "none" ||
    !shouldEvaluateOverdue(item) ||
    hasRecentMeaningfulProgress(item, evaluatedTimestamp, settings.recentProgressGraceHours)
  ) {
    return [];
  }
  const signals: ReasonSignal[] = [];
  const reasonCode = overdueReasonCode(item.current.status, item.current.waitClass);
  if (
    reasonCode != null &&
    !isPersonalReminderReasonCode(reasonCode) &&
    isStateReasonAllowed(item, reasonCode, settings.minimumAiConfidence)
  ) {
    const reason = isTimeNotificationReasonCode(reasonCode)
      ? notificationReasonForSelection({
          item,
          reasonCode,
          source: "deterministic",
        })
      : notificationReasonForNonTimeSelection(reasonCode);
    if (reason != null) {
      signals.push({
        reason,
        stateDiscriminator: item.current.waitClass,
        highPriorityEligible: true,
        target: pendingTargetForReason(item, reasonCode, undefined),
        severity: item.current.severity,
        source: systemReasonSource(),
      });
    }
  }

  const impact = item.graph.downstreamImpact;
  const blocksOpenItems = impact.openNodeCount > 0 || impact.repositoryCount > 0;
  const urgentOrCritical =
    item.current.severity === "urgent" || item.current.severity === "critical";
  if (
    blocksOpenItems &&
    urgentOrCritical &&
    isStateReasonAllowed(item, "blocker_overdue", settings.minimumAiConfidence)
  ) {
    signals.push({
      reason: notificationReasonForNonTimeSelection("blocker_overdue"),
      stateDiscriminator: JSON.stringify([impact.openNodeCount, impact.repositoryCount]),
      highPriorityEligible: true,
      target: pendingTargetForReason(item, "blocker_overdue", undefined),
      severity: item.current.severity,
      source: systemReasonSource(),
    });
  }
  return signals;
}

export function isImportantNewlyUnblocked(item: DiscordNotificationItem): boolean {
  const impact = item.graph.downstreamImpact;
  return (
    item.priorityWeight > 0 ||
    impact.openNodeCount > 0 ||
    impact.repositoryCount > 0 ||
    item.current.severity === "urgent" ||
    item.current.severity === "critical"
  );
}

function createNewlyUnblockedSignal(item: DiscordNotificationItem): ReasonSignal | undefined {
  if (!item.graph.newlyUnblocked || !isImportantNewlyUnblocked(item)) {
    return undefined;
  }
  return {
    reason: notificationReasonForNonTimeSelection("newly_unblocked"),
    stateDiscriminator: item.current.statusSince,
    highPriorityEligible: true,
    target: pendingTargetForReason(item, "newly_unblocked", undefined),
    severity: item.current.severity,
    source: systemReasonSource(),
  };
}

function createResponsibilityChangedSignal(
  item: DiscordNotificationItem,
  minimumAiConfidence: number,
): ReasonSignal | undefined {
  if (
    item.previous.availability === "not_available" ||
    isTerminalStatus(item.current.status) ||
    !isStateReasonAllowed(item, "responsibility_changed", minimumAiConfidence)
  ) {
    return undefined;
  }
  const previous = item.previous.value;
  const previousStallHours = hoursBetween(
    previous.stallSince,
    parseTimestamp(previous.observedAt, `${item.nodeId}の前回観測時刻`),
  );
  if (
    previousStallHours < RESPONSIBILITY_CHANGE_STALL_HOURS ||
    waitingOnComparisonSignature(previous.waitingOn) ===
      waitingOnComparisonSignature(item.current.waitingOn)
  ) {
    return undefined;
  }
  return {
    reason: notificationReasonForNonTimeSelection("responsibility_changed"),
    stateDiscriminator: item.current.ownerSince,
    highPriorityEligible: true,
    target: pendingTargetForReason(item, "responsibility_changed", undefined),
    severity: item.current.severity,
    source: systemReasonSource(),
  };
}

function createRecommendationSignal(item: DiscordNotificationItem): ReasonSignal | undefined {
  if (item.notificationRecommendation.availability === "not_available") {
    return undefined;
  }
  const recommendation = item.notificationRecommendation.value;
  if (!recommendation.recommended || recommendation.policy === "suppressed") {
    return undefined;
  }
  if (recommendation.reasonCode === "none") {
    throw new TypeError(`${item.nodeId}のCodex通知提案にreason codeがありません`);
  }
  if (isTimeNotificationReasonCode(recommendation.reasonCode)) {
    if (isPersonalReminderReasonCode(recommendation.reasonCode)) {
      return undefined;
    }
    const deterministicReasonCode = overdueReasonCode(item.current.status, item.current.waitClass);
    if (deterministicReasonCode !== recommendation.reasonCode) {
      return undefined;
    }
  }
  if (recommendation.reasonCode === "dependency_cycle") {
    return undefined;
  }
  const reason = isTimeNotificationReasonCode(recommendation.reasonCode)
    ? notificationReasonForSelection({
        item,
        reasonCode: recommendation.reasonCode,
        source: "codex",
      })
    : notificationReasonForNonTimeSelection(recommendation.reasonCode);
  if (reason == null) {
    return undefined;
  }
  return {
    reason,
    stateDiscriminator: JSON.stringify([item.nodeId, "codex_recommendation"]),
    highPriorityEligible: recommendation.highPriorityEligible,
    target: pendingTargetForReason(item, recommendation.reasonCode, undefined),
    severity: item.current.severity,
    source: systemReasonSource(),
  };
}

function createPersonalReminderContext(
  input: DiscordPersonalReminderInput,
): DiscordPersonalReminderNotificationContext {
  const { cause, staleness } = input;
  if (staleness.status !== "eligible" || cause.actionableClock.status !== "observed") {
    throw new TypeError(`${cause.causeId}の個人催促通知文脈を生成できません`);
  }
  return Object.freeze({
    causeId: cause.causeId,
    responsibilityId: cause.responsibilityId,
    responsible: Object.freeze(
      cause.responsible.map((responsible) => Object.freeze({ ...responsible })),
    ),
    action: Object.freeze({
      kind: cause.action.kind,
      summary: cause.action.summary,
    }),
    obligationSince: Object.freeze({ ...cause.obligationSince }),
    actionableSince: Object.freeze({ ...staleness.actionableSince }),
    stallSince: Object.freeze({ ...staleness.stallSince }),
  });
}

export function createPersonalReminderSignals(
  item: Pick<DiscordNotificationItem, "personalReminderCauses" | "personalReminderCausePlanning">,
): readonly ReasonSignal[] {
  if (
    item.personalReminderCausePlanning.status !== "completed" ||
    item.personalReminderCausePlanning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    return [];
  }
  return item.personalReminderCauses.flatMap((input) => {
    if (input.staleness.status !== "eligible") {
      return [];
    }
    const assessment = currentPersonalReminderAssessment(input.cause);
    if (assessment.status !== "available" || assessment.result.verdict !== "actionable") {
      throw new TypeError(`${input.cause.causeId}の個人催促判定がactionableではありません`);
    }
    if (
      input.staleness.severity === "none" ||
      input.staleness.severityReason.crossedThreshold.status !== "reached"
    ) {
      return [];
    }
    const reason = createNotificationReason(input.cause.reasonCode, {
      status: "recorded",
      hours: input.staleness.severityReason.crossedThreshold.thresholdHours,
    });
    const context = createPersonalReminderContext(input);
    return [
      Object.freeze({
        reason,
        stateDiscriminator: JSON.stringify([
          input.cause.causeId,
          input.cause.responsibilityId,
          input.staleness.waitClass,
        ]),
        highPriorityEligible: true,
        target: Object.freeze({
          kind: "personal_reminder",
          causeId: input.cause.causeId,
          responsibilityId: input.cause.responsibilityId,
          actionableSince: Object.freeze({ ...input.staleness.actionableSince }),
          stallSince: Object.freeze({ ...input.staleness.stallSince }),
        }),
        severity: input.staleness.severity,
        source: Object.freeze({
          kind: "personal_reminder",
          context,
        }),
      }),
    ];
  });
}

function listNewDependencyCycleIds(item: DiscordNotificationItem): readonly DependencyCycleId[] {
  if (item.graph.previousDependencyCycles.availability === "not_available") {
    return [];
  }
  const previousCycleIds = new Set(item.graph.previousDependencyCycles.cycleIds);
  return item.graph.currentDependencyCycleIds.filter((cycleId) => !previousCycleIds.has(cycleId));
}

export function severityRank(severity: Severity): number {
  switch (severity) {
    case "none":
      return 0;
    case "watch":
      return 1;
    case "urgent":
      return 2;
    case "critical":
      return 3;
  }
}

function compareItemMetrics(
  left: DiscordNotificationItem,
  right: DiscordNotificationItem,
  evaluatedTimestamp: number,
): -1 | 0 | 1 {
  const severityDifference =
    severityRank(right.current.severity) - severityRank(left.current.severity);
  if (severityDifference !== 0) {
    return severityDifference < 0 ? -1 : 1;
  }
  const repositoryDifference =
    right.graph.downstreamImpact.repositoryCount - left.graph.downstreamImpact.repositoryCount;
  if (repositoryDifference !== 0) {
    return repositoryDifference < 0 ? -1 : 1;
  }
  const nodeDifference =
    right.graph.downstreamImpact.openNodeCount - left.graph.downstreamImpact.openNodeCount;
  if (nodeDifference !== 0) {
    return nodeDifference < 0 ? -1 : 1;
  }
  const weightDifference = right.priorityWeight - left.priorityWeight;
  if (weightDifference !== 0) {
    return weightDifference < 0 ? -1 : 1;
  }
  const stallDifference =
    hoursBetween(right.current.stallSince, evaluatedTimestamp) -
    hoursBetween(left.current.stallSince, evaluatedTimestamp);
  if (stallDifference !== 0) {
    return stallDifference < 0 ? -1 : 1;
  }
  return compareStrings(left.nodeId, right.nodeId);
}

export function assignNewCycles(
  items: readonly DiscordNotificationItem[],
  evaluatedTimestamp: number,
): ReadonlyMap<GitHubNodeId, readonly DependencyCycleId[]> {
  const representativeByCycleId = new Map<DependencyCycleId, DiscordNotificationItem>();
  for (const item of items) {
    for (const cycleId of listNewDependencyCycleIds(item)) {
      const existing = representativeByCycleId.get(cycleId);
      if (existing == null || compareItemMetrics(item, existing, evaluatedTimestamp) < 0) {
        representativeByCycleId.set(cycleId, item);
      }
    }
  }

  const cycleIdsByNodeId = new Map<GitHubNodeId, DependencyCycleId[]>();
  for (const [cycleId, item] of representativeByCycleId) {
    const cycleIds = cycleIdsByNodeId.get(item.nodeId);
    if (cycleIds == null) {
      cycleIdsByNodeId.set(item.nodeId, [cycleId]);
      continue;
    }
    cycleIds.push(cycleId);
  }
  return new Map(
    [...cycleIdsByNodeId.entries()].map(([nodeId, cycleIds]) => [
      nodeId,
      Object.freeze([...cycleIds].sort(compareStrings)),
    ]),
  );
}

export function createSignals(
  item: DiscordNotificationItem,
  assignedCycleIds: readonly DependencyCycleId[],
  evaluatedTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): readonly ReasonSignal[] {
  const signals = createOverdueSignals(item, evaluatedTimestamp, settings);
  const newlyUnblocked = createNewlyUnblockedSignal(item);
  if (newlyUnblocked != null) {
    signals.push(newlyUnblocked);
  }
  const responsibilityChanged = createResponsibilityChangedSignal(
    item,
    settings.minimumAiConfidence,
  );
  if (responsibilityChanged != null) {
    signals.push(responsibilityChanged);
  }
  for (const cycleId of assignedCycleIds) {
    signals.push({
      reason: notificationReasonForNonTimeSelection("dependency_cycle"),
      stateDiscriminator: JSON.stringify([
        cycleId,
        createUtcIsoDateTime(new Date(evaluatedTimestamp).toISOString()),
      ]),
      highPriorityEligible: true,
      target: pendingTargetForReason(item, "dependency_cycle", cycleId),
      severity: item.current.severity,
      source: systemReasonSource(),
    });
  }
  const recommendation = createRecommendationSignal(item);
  if (
    recommendation != null &&
    !signals.some((signal) => signal.reason.reasonCode === recommendation.reason.reasonCode)
  ) {
    signals.push(recommendation);
  }
  signals.push(...createPersonalReminderSignals(item));
  return signals;
}

export function isReasonSuppressedByCause(
  item: DiscordNotificationItem,
  reasonCode: DiscordNotificationReasonCode,
): boolean {
  const isSelfCause = (cause: NotificationCause): boolean => {
    if (cause.status !== "complete") {
      return false;
    }
    return cause.evidence.every((evidence) => evidence.actor.nodeId === cause.responsible.nodeId);
  };
  switch (reasonCode) {
    case "responsibility_changed":
      return isSelfCause(item.causes.responsibility_changed);
    case "newly_unblocked":
      return isSelfCause(item.causes.newly_unblocked);
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "work_overdue":
    case "owner_unknown":
    case "blocker_overdue":
    case "dependency_cycle":
    case "merge_overdue":
    case "automation_stuck":
      return false;
    default:
      throw new UnreachableError(reasonCode);
  }
}

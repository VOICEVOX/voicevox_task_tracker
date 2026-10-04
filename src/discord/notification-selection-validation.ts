import {
  currentPersonalReminderAssessment,
  isTerminalStatus,
  personalReminderCauseSchema,
  type NotificationLedgerEntry,
  type PendingNotification,
  type PendingNotificationTarget,
  type PersonalReminderTimeBasis,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { type DependencyCycleId } from "../graph/index.js";
import { notificationCauseSchema, type NotificationCause } from "./notification-cause-contracts.js";
import type {
  DiscordNotificationItem,
  DiscordNotificationReasonCode,
  PendingNotificationWaitingOn,
  ReasonSignal,
  SelectDiscordNotificationsInput,
} from "./notification-selection-contracts.js";
import { DELIVERY_ID_PATTERN } from "./notification-selection-contracts.js";
import {
  isPersonalReminderReasonCode,
  personalReminderActionKindForReason,
  waitClassForTimeReasonCode,
} from "./notification-selection-reasons.js";
import { hoursBetween, parseTimestamp } from "./notification-selection-values.js";

function validateProbability(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

function validateNonNegativeInteger(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${context}は0以上の整数にしてください`);
  }
}

function pendingWaitingOnValues(
  waitingOnValues: readonly WaitingOn[],
): readonly PendingNotificationWaitingOn[] {
  return Object.freeze(
    waitingOnValues.map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    ),
  );
}

export function pendingTargetForReason(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  reasonCode: DiscordNotificationReasonCode,
  cycleId: DependencyCycleId | undefined,
): PendingNotificationTarget {
  switch (reasonCode) {
    case "responsibility_changed":
      return Object.freeze({
        kind: "responsibility",
        waitingOn: pendingWaitingOnValues(item.current.waitingOn),
      });
    case "newly_unblocked":
      return Object.freeze({
        kind: "unblocked",
      });
    case "dependency_cycle":
      if (cycleId == null) {
        throw new TypeError(`${item.nodeId}のdependency_cycle通知にcycle IDがありません`);
      }
      return Object.freeze({
        kind: "cycle",
        cycleId,
      });
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "work_overdue":
    case "owner_unknown":
    case "blocker_overdue":
    case "merge_overdue":
    case "automation_stuck":
      return Object.freeze({
        kind: "overdue",
        status: item.current.status,
        waitClass: item.current.waitClass,
        waitingOn: pendingWaitingOnValues(item.current.waitingOn),
        lastProgressAt: item.current.lastProgressAt,
      });
  }
}

export function createPendingNotification(
  item: DiscordNotificationItem,
  signal: ReasonSignal,
  notificationKey: string,
  detectedAt: UtcIsoDateTime,
): PendingNotification {
  return Object.freeze({
    notificationKey,
    itemNodeId: item.nodeId,
    reason: signal.reason,
    detectedAt,
    highPriorityEligible: signal.highPriorityEligible,
    target: signal.target,
  });
}

function validateResponsibility(
  status: Status,
  waitingOnValues: readonly WaitingOn[],
  context: string,
): void {
  if (isTerminalStatus(status)) {
    if (waitingOnValues.length !== 0) {
      throw new TypeError(`${context}のterminal状態にはwaitingOnを設定できません`);
    }
    return;
  }
  if (waitingOnValues.length === 0) {
    throw new TypeError(`${context}の継続中状態にはwaitingOnが1件以上必要です`);
  }
  const signatures = waitingOnValues.map((waitingOn) =>
    JSON.stringify([waitingOn.kind, waitingOn.candidateId, waitingOn.role]),
  );
  if (new Set(signatures).size !== signatures.length) {
    throw new TypeError(`${context}のwaitingOn実体が重複しています`);
  }
}

function validateSeverityReason(item: DiscordNotificationItem, evaluatedTimestamp: number): void {
  const reason = item.current.severityReason;
  switch (reason.kind) {
    case "elapsed_threshold": {
      if (
        item.current.waitClass === "blockedParent" ||
        item.current.waitClass === "notApplicable" ||
        item.current.waitClass !== reason.waitClass
      ) {
        throw new TypeError(`${item.nodeId}のseverity時間判定とwait classが一致しません`);
      }
      if (!Number.isFinite(reason.elapsedHours) || reason.elapsedHours < 0) {
        throw new RangeError(`${item.nodeId}のseverity経過時間は0以上の有限値にしてください`);
      }
      if (reason.elapsedHours !== hoursBetween(item.current.stallSince, evaluatedTimestamp)) {
        throw new TypeError(`${item.nodeId}のseverity経過時間がstallSinceから再現できません`);
      }
      if (reason.crossedThreshold.status === "reached") {
        if (
          !Number.isFinite(reason.crossedThreshold.thresholdHours) ||
          reason.crossedThreshold.thresholdHours < 0
        ) {
          throw new RangeError(`${item.nodeId}のseverity閾値は0以上の有限値にしてください`);
        }
        if (reason.elapsedHours < reason.crossedThreshold.thresholdHours) {
          throw new TypeError(`${item.nodeId}のseverity経過時間が到達閾値を下回っています`);
        }
      } else if (
        !Number.isFinite(reason.crossedThreshold.nextThresholdHours) ||
        reason.crossedThreshold.nextThresholdHours < 0
      ) {
        throw new RangeError(`${item.nodeId}の次のseverity閾値は0以上の有限値にしてください`);
      } else {
        if (reason.elapsedHours >= reason.crossedThreshold.nextThresholdHours) {
          throw new TypeError(`${item.nodeId}のseverity経過時間が次の閾値以上です`);
        }
      }
      return;
    }
    case "not_applicable":
      if (item.current.waitClass !== reason.waitClass) {
        throw new TypeError(`${item.nodeId}の時間判定対象外根拠とwait classが一致しません`);
      }
      return;
  }
}

function validateCurrentState(item: DiscordNotificationItem, evaluatedTimestamp: number): void {
  validateResponsibility(item.current.status, item.current.waitingOn, `${item.nodeId}の現在状態`);
  const terminal = isTerminalStatus(item.current.status);
  if (terminal && item.current.waitClass !== "notApplicable") {
    throw new TypeError(`${item.nodeId}のterminal状態はnotApplicableとして扱ってください`);
  }
  if (!terminal && item.current.waitClass === "notApplicable") {
    throw new TypeError(`${item.nodeId}の継続中状態をnotApplicableにはできません`);
  }
  if (item.current.status === "waiting_for_unblock" && item.current.waitClass !== "blockedParent") {
    throw new TypeError(
      `${item.nodeId}のwaiting_for_unblock状態はblockedParentとして扱ってください`,
    );
  }
  if (item.current.status !== "waiting_for_unblock" && item.current.waitClass === "blockedParent") {
    throw new TypeError(
      `${item.nodeId}のwaiting_for_unblock以外の状態をblockedParentにはできません`,
    );
  }
  validateSeverityReason(item, evaluatedTimestamp);

  const createdTimestamp = parseTimestamp(item.createdAt, `${item.nodeId}の作成時刻`);
  const currentTimes: readonly (readonly [string, UtcIsoDateTime])[] = [
    ["statusSince", item.current.statusSince],
    ["ownerSince", item.current.ownerSince],
    ["stallSince", item.current.stallSince],
    ["lastProgressAt", item.current.lastProgressAt],
  ];
  for (const [name, value] of currentTimes) {
    const timestamp = parseTimestamp(value, `${item.nodeId}の${name}`);
    if (timestamp < createdTimestamp || timestamp > evaluatedTimestamp) {
      throw new RangeError(`${item.nodeId}の${name}は作成時刻以後かつ判定時刻以前にしてください`);
    }
  }
}

function validatePreviousState(item: DiscordNotificationItem, evaluatedTimestamp: number): void {
  if (item.previous.availability === "not_available") {
    return;
  }
  const previous = item.previous.value;
  validateResponsibility(previous.status, previous.waitingOn, `${item.nodeId}の前回状態`);
  const observedTimestamp = parseTimestamp(previous.observedAt, `${item.nodeId}の前回観測時刻`);
  const stallTimestamp = parseTimestamp(previous.stallSince, `${item.nodeId}の前回stallSince`);
  const createdTimestamp = parseTimestamp(item.createdAt, `${item.nodeId}の作成時刻`);
  if (
    stallTimestamp < createdTimestamp ||
    stallTimestamp > observedTimestamp ||
    observedTimestamp > evaluatedTimestamp
  ) {
    throw new RangeError(
      `${item.nodeId}の前回時刻は作成時刻、stallSince、観測時刻、判定時刻の順にしてください`,
    );
  }
}

function validateCycleIds(cycleIds: readonly DependencyCycleId[], context: string): void {
  if (cycleIds.some((cycleId) => cycleId.length === 0)) {
    throw new TypeError(`${context}のcycle IDは空にできません`);
  }
  if (new Set(cycleIds).size !== cycleIds.length) {
    throw new TypeError(`${context}のcycle IDが重複しています`);
  }
}

function validateGraphContext(item: DiscordNotificationItem): void {
  const impact = item.graph.downstreamImpact;
  if (impact.nodeId !== item.nodeId) {
    throw new TypeError(`${item.nodeId}のdownstream impactが別のnodeを参照しています`);
  }
  if (typeof item.graph.hasOpenBlockers !== "boolean") {
    throw new TypeError(`${item.nodeId}のhasOpenBlockersはbooleanにしてください`);
  }
  validateNonNegativeInteger(impact.openNodeCount, `${item.nodeId}のdownstream open node数`);
  validateNonNegativeInteger(impact.repositoryCount, `${item.nodeId}のdownstream repository数`);
  validateCycleIds(item.graph.currentDependencyCycleIds, `${item.nodeId}の現在値`);
  if (item.graph.previousDependencyCycles.availability === "available") {
    validateCycleIds(item.graph.previousDependencyCycles.cycleIds, `${item.nodeId}の前回値`);
  }
}

function validateNotificationRecommendation(item: DiscordNotificationItem): void {
  if (item.notificationRecommendation.availability === "not_available") {
    return;
  }
  const recommendation = item.notificationRecommendation.value;
  if (recommendation.recommended === (recommendation.reasonCode === "none")) {
    throw new TypeError(`${item.nodeId}のCodex通知提案とreason codeが一致しません`);
  }
  if (
    recommendation.highPriorityEligible !==
    (recommendation.recommended && recommendation.policy === "eligible")
  ) {
    throw new TypeError(`${item.nodeId}のCodex通知提案と優先度ポリシーが一致しません`);
  }
  if (recommendation.recommended && recommendation.policy === "suppressed") {
    throw new TypeError(`${item.nodeId}の抑制対象Codex通知提案を推薦扱いにはできません`);
  }
}

function validateNotificationCauses(item: DiscordNotificationItem): void {
  const causeEntries: readonly NotificationCause[] = [
    item.causes.responsibility_changed,
    item.causes.newly_unblocked,
  ];
  for (const cause of causeEntries) {
    notificationCauseSchema.parse(cause);
  }
}

function validatePersonalReminderTimeBasis(
  basis: PersonalReminderTimeBasis,
  evaluatedTimestamp: number,
  context: string,
): void {
  if (parseTimestamp(basis.at, context) > evaluatedTimestamp) {
    throw new RangeError(`${context}は判定時刻以前にしてください`);
  }
  if (basis.source === "reconfirmation_pending") {
    throw new TypeError(`${context}の再確認が完了していません`);
  }
  if (basis.source !== "first_observation" && basis.sourceIds.length === 0) {
    throw new TypeError(`${context}のsource IDは空にできません`);
  }
  if (basis.source === "reconfirmed_observation" && basis.previousAt > basis.at) {
    throw new RangeError(`${context}の旧時計時刻は再確認時刻以前にしてください`);
  }
}

export function samePersonalReminderTimeBasis(
  left: PersonalReminderTimeBasis,
  right: PersonalReminderTimeBasis,
): boolean {
  if (left.source !== right.source || left.at !== right.at) {
    return false;
  }
  if (left.source === "first_observation" || right.source === "first_observation") {
    return left.source === right.source;
  }
  if (
    left.source === "reconfirmed_observation" &&
    right.source === "reconfirmed_observation" &&
    left.previousAt !== right.previousAt
  ) {
    return false;
  }
  const leftSourceIds = [...left.sourceIds].sort();
  const rightSourceIds = [...right.sourceIds].sort();
  return (
    leftSourceIds.length === rightSourceIds.length &&
    leftSourceIds.every((sourceId, index) => sourceId === rightSourceIds[index])
  );
}

function validatePersonalReminderInputs(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
): void {
  const causeIds = new Set<string>();
  for (const personalInput of item.personalReminderCauses) {
    const { cause, staleness } = personalInput;
    personalReminderCauseSchema.parse(cause);
    if (cause.itemNodeId !== item.nodeId) {
      throw new TypeError(`${item.nodeId}の個人催促原因が別の項目を参照しています`);
    }
    if (causeIds.has(cause.causeId)) {
      throw new TypeError(`${item.nodeId}の個人催促原因IDが重複しています`);
    }
    causeIds.add(cause.causeId);
    if (cause.action.kind !== personalReminderActionKindForReason(cause.reasonCode)) {
      throw new TypeError(`${item.nodeId}の個人催促原因と行動種別が一致しません`);
    }
    const responsibleSignatures = cause.responsible.map((responsible) =>
      JSON.stringify([responsible.kind, responsible.candidateId, responsible.role]),
    );
    if (new Set(responsibleSignatures).size !== responsibleSignatures.length) {
      throw new TypeError(`${item.nodeId}の個人催促責任主体が重複しています`);
    }
    if (staleness.waitClass !== waitClassForTimeReasonCode(cause.reasonCode)) {
      throw new TypeError(`${item.nodeId}の個人催促stalenessと理由のwait classが一致しません`);
    }
    validatePersonalReminderTimeBasis(
      cause.obligationSince,
      evaluatedTimestamp,
      `${item.nodeId}の個人催促obligationSince`,
    );
    if (cause.actionableClock.status === "observed") {
      validatePersonalReminderTimeBasis(
        cause.actionableClock.actionableSince,
        evaluatedTimestamp,
        `${item.nodeId}の個人催促actionableSince`,
      );
      validatePersonalReminderTimeBasis(
        cause.actionableClock.stallSince,
        evaluatedTimestamp,
        `${item.nodeId}の個人催促stallSince`,
      );
    }
    if (staleness.status !== "eligible") {
      continue;
    }
    const assessment = currentPersonalReminderAssessment(cause);
    if (assessment.status !== "available" || assessment.result.verdict !== "actionable") {
      throw new TypeError(`${item.nodeId}の通知可能な個人催促原因にactionable判定がありません`);
    }
    if (cause.actionableClock.status !== "observed") {
      throw new TypeError(`${item.nodeId}の通知可能な個人催促原因に時計がありません`);
    }
    if (
      !samePersonalReminderTimeBasis(
        staleness.actionableSince,
        cause.actionableClock.actionableSince,
      ) ||
      !samePersonalReminderTimeBasis(staleness.stallSince, cause.actionableClock.stallSince)
    ) {
      throw new TypeError(`${item.nodeId}の個人催促stalenessと時計が一致しません`);
    }
    if (staleness.severityReason.waitClass !== staleness.waitClass) {
      throw new TypeError(`${item.nodeId}の個人催促severityとwait classが一致しません`);
    }
    if (
      staleness.severityReason.elapsedHours !==
      hoursBetween(staleness.stallSince.at, evaluatedTimestamp)
    ) {
      throw new TypeError(`${item.nodeId}の個人催促severity経過時間がstallSinceから再現できません`);
    }
    if (staleness.severityReason.crossedThreshold.status === "reached") {
      if (staleness.severity === "none") {
        throw new TypeError(`${item.nodeId}の到達severityがnoneです`);
      }
      if (
        staleness.severityReason.elapsedHours <
        staleness.severityReason.crossedThreshold.thresholdHours
      ) {
        throw new TypeError(`${item.nodeId}の個人催促severity経過時間が閾値を下回っています`);
      }
    } else {
      if (staleness.severity !== "none") {
        throw new TypeError(`${item.nodeId}の未到達severityがnoneではありません`);
      }
      if (
        staleness.severityReason.elapsedHours >=
        staleness.severityReason.crossedThreshold.nextThresholdHours
      ) {
        throw new TypeError(`${item.nodeId}の個人催促severity経過時間が次の閾値以上です`);
      }
    }
  }
}

function validateLedger(
  ledger: readonly NotificationLedgerEntry[],
  evaluatedTimestamp: number,
): void {
  const notificationKeys = ledger.map((entry) => entry.notificationKey);
  if (new Set(notificationKeys).size !== notificationKeys.length) {
    throw new TypeError("notification ledgerのnotificationKeyが重複しています");
  }
  for (const entry of ledger) {
    const reservedTimestamp = parseTimestamp(entry.reservedAt, "ledgerの予約時刻");
    if (reservedTimestamp > evaluatedTimestamp) {
      throw new RangeError("ledgerの予約時刻は判定時刻以前にしてください");
    }
    if (entry.status === "reserved") {
      const expiresTimestamp = parseTimestamp(entry.expiresAt, "ledgerの予約期限");
      if (expiresTimestamp < reservedTimestamp) {
        throw new RangeError("ledgerの予約期限は予約時刻以後にしてください");
      }
    } else if (entry.status === "delivery_started") {
      if (!DELIVERY_ID_PATTERN.test(entry.deliveryId)) {
        throw new TypeError("ledgerのdelivery IDが不正です");
      }
      const startedTimestamp = parseTimestamp(entry.startedAt, "ledgerの送信開始時刻");
      if (startedTimestamp < reservedTimestamp || startedTimestamp > evaluatedTimestamp) {
        throw new RangeError("ledgerの送信開始時刻は予約時刻以後かつ判定時刻以前にしてください");
      }
    } else if (entry.status === "sent") {
      const sentTimestamp = parseTimestamp(entry.sentAt, "ledgerの送信時刻");
      if (sentTimestamp < reservedTimestamp || sentTimestamp > evaluatedTimestamp) {
        throw new RangeError("ledgerの送信時刻は予約時刻以後かつ判定時刻以前にしてください");
      }
    } else {
      const acknowledgedTimestamp = parseTimestamp(entry.acknowledgedAt, "ledgerの確認時刻");
      if (acknowledgedTimestamp < reservedTimestamp || acknowledgedTimestamp > evaluatedTimestamp) {
        throw new RangeError("ledgerの確認時刻は予約時刻以後かつ判定時刻以前にしてください");
      }
    }
  }
}

function validatePendingNotifications(
  pendingNotifications: readonly PendingNotification[],
  evaluatedTimestamp: number,
): void {
  const notificationKeys = pendingNotifications.map((pending) => pending.notificationKey);
  if (new Set(notificationKeys).size !== notificationKeys.length) {
    throw new TypeError("送信待ち通知のnotificationKeyが重複しています");
  }
  for (const pending of pendingNotifications) {
    const detectedTimestamp = parseTimestamp(pending.detectedAt, "送信待ち通知の検出時刻");
    if (detectedTimestamp > evaluatedTimestamp) {
      throw new RangeError("送信待ち通知の検出時刻は判定時刻以前にしてください");
    }
    if (
      (pending.target.kind === "responsibility" || pending.target.kind === "overdue") &&
      pending.target.waitingOn.length === 0
    ) {
      throw new TypeError("送信待ち通知の待ち相手は空にできません");
    }
    if (pending.target.kind === "cycle" && pending.target.cycleId.length === 0) {
      throw new TypeError("送信待ち通知のcycle IDは空にできません");
    }
    if (pending.target.kind === "personal_reminder") {
      if (!isPersonalReminderReasonCode(pending.reason.reasonCode)) {
        throw new TypeError("個人催促pendingには個人催促理由を指定してください");
      }
      validatePersonalReminderTimeBasis(
        pending.target.actionableSince,
        evaluatedTimestamp,
        "送信待ち通知のactionableSince",
      );
      validatePersonalReminderTimeBasis(
        pending.target.stallSince,
        evaluatedTimestamp,
        "送信待ち通知のstallSince",
      );
    }
  }
}

export function validateInput(input: SelectDiscordNotificationsInput): number {
  const evaluatedTimestamp = parseTimestamp(input.evaluatedAt, "通知判定時刻");
  if (
    !Number.isInteger(input.settings.maxItemsPerDigest) ||
    input.settings.maxItemsPerDigest <= 0
  ) {
    throw new RangeError("maxItemsPerDigestは1以上の整数にしてください");
  }
  if (
    !Number.isFinite(input.settings.recentProgressGraceHours) ||
    input.settings.recentProgressGraceHours < 0
  ) {
    throw new RangeError("recent progress猶予時間は0以上の有限値にしてください");
  }
  validateProbability(input.settings.minimumAiConfidence, "AI通知の最低confidence");

  const nodeIds = input.items.map((item) => item.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new TypeError("通知判定項目のnode IDが重複しています");
  }
  for (const item of input.items) {
    if (!Number.isFinite(item.priorityWeight)) {
      throw new RangeError(`${item.nodeId}のpriority weightは有限値にしてください`);
    }
    if (item.decisionBasis.source === "ai_only") {
      validateProbability(item.decisionBasis.confidence, `${item.nodeId}のAI confidence`);
    }
    validateNotificationRecommendation(item);
    validateNotificationCauses(item);
    validatePersonalReminderInputs(item, evaluatedTimestamp);
    validateCurrentState(item, evaluatedTimestamp);
    validatePreviousState(item, evaluatedTimestamp);
    validateGraphContext(item);
  }
  validateLedger(input.ledger, evaluatedTimestamp);
  validatePendingNotifications(input.pendingNotifications, evaluatedTimestamp);
  return evaluatedTimestamp;
}

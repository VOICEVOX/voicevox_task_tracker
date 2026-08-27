import { createHash } from "node:crypto";

import {
  compareSeverity,
  createNotificationReason,
  createUtcIsoDateTime,
  isTerminalStatus,
  type GitHubNodeId,
  type NotificationNonTimeReasonCode,
  type NotificationReason,
  type NotificationTimeReasonCode,
  type NotificationLedgerEntry,
  type NotificationReasonCode,
  type Severity,
  type SeverityThresholds,
  type StalenessWaitClass,
  type Status,
  type TrackingNotificationClass,
  type UtcIsoDateTime,
  type WaitClass,
  type WaitingOn,
} from "../domain/index.js";
import { type DependencyCycleId, type DownstreamImpact } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const RESPONSIBILITY_CHANGE_STALL_HOURS = 48;
const RESERVATION_DURATION_MILLISECONDS = MILLISECONDS_PER_DAY;
const STALENESS_WAIT_CLASSES: readonly WaitClass[] = Object.freeze([
  "assessment",
  "owner",
  "decision",
  "review",
  "revision",
  "reply",
  "work",
  "merge",
  "automation",
]);

/** 通知理由として利用できるnone以外のreason code。 */
export type DiscordNotificationReasonCode = Exclude<NotificationReasonCode, "none">;

/** 通知判定に使う最新変更の分類。 */
export type DiscordNotificationLatestChange =
  "none" | "human" | "bot_only" | "preview_update" | "renovate_dashboard_update";

/** 状態判定が確定情報かAIだけに由来するかを表す。 */
export type DiscordNotificationDecisionBasis =
  | Readonly<{
      source: "deterministic";
    }>
  | Readonly<{
      source: "ai_only";
      confidence: number;
    }>;

/** reducerで検証済みのCodex通知提案を利用できるかを表す。 */
export type DiscordNotificationRecommendation =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: Readonly<{
        recommended: boolean;
        reasonCode: NotificationReasonCode;
        reasonSummary: string;
        policy: "eligible" | "normal_priority_only" | "suppressed";
        highPriorityEligible: boolean;
      }>;
    }>;

/** 通知判定時点の項目状態。 */
export type DiscordNotificationCurrentState = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  severity: Severity;
  waitClass: StalenessWaitClass;
  statusSince: UtcIsoDateTime;
  ownerSince: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
  lastProgressAt: UtcIsoDateTime;
}>;

/** 前回状態を利用できる場合の比較値。 */
export type DiscordNotificationPreviousState = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  severity: Severity;
  stallSince: UtcIsoDateTime;
  observedAt: UtcIsoDateTime;
}>;

/** 初回判定または前回値を持つ通知用比較状態。 */
export type DiscordNotificationPrevious =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: DiscordNotificationPreviousState;
    }>;

/** blocks graphの前回cycleと現在の影響範囲。 */
export type DiscordNotificationGraphContext = Readonly<{
  downstreamImpact: DownstreamImpact;
  newlyUnblocked: boolean;
  currentDependencyCycleIds: readonly DependencyCycleId[];
  previousDependencyCycles:
    | Readonly<{
        availability: "not_available";
      }>
    | Readonly<{
        availability: "available";
        cycleIds: readonly DependencyCycleId[];
      }>;
}>;

/** 1項目の通知選別に必要な正規化済み入力。 */
export type DiscordNotificationItem = Readonly<{
  nodeId: GitHubNodeId;
  createdAt: UtcIsoDateTime;
  draftState: "not_applicable" | "draft" | "ready_for_review";
  repositoryFreshness: "fresh" | "stale";
  notificationClass: TrackingNotificationClass;
  notificationsSuppressedByLabel: boolean;
  latestChange: DiscordNotificationLatestChange;
  decisionBasis: DiscordNotificationDecisionBasis;
  notificationRecommendation: DiscordNotificationRecommendation;
  priorityWeight: number;
  current: DiscordNotificationCurrentState;
  previous: DiscordNotificationPrevious;
  graph: DiscordNotificationGraphContext;
}>;

/** 設定から渡す通知上限、cooldown、noise閾値。 */
export type DiscordNotificationSelectionSettings = Readonly<{
  maxItemsPerDigest: number;
  cooldownDays: Readonly<{
    urgent: number;
    critical: number;
  }>;
  recentProgressGraceHours: number;
  minimumAiConfidence: number;
  thresholdsHours: SeverityThresholds;
}>;

/** 通知候補選別へ渡す現在時刻、項目、ledger、設定。 */
export type SelectDiscordNotificationsInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  items: readonly DiscordNotificationItem[];
  ledger: readonly NotificationLedgerEntry[];
  settings: DiscordNotificationSelectionSettings;
}>;

/** 選別された1理由とledger予約情報。 */
export type SelectedDiscordNotificationReason = NotificationReason &
  Readonly<{
    notificationKey: string;
    cooldownUntil: UtcIsoDateTime;
  }>;

/** digestへ1件として渡す通知候補。 */
export type DiscordNotificationCandidate = Readonly<{
  itemNodeId: GitHubNodeId;
  reasons: readonly [SelectedDiscordNotificationReason, ...SelectedDiscordNotificationReason[]];
  severity: Severity;
  downstreamImpact: DownstreamImpact;
  priorityWeight: number;
}>;

type NotificationLedgerReservation = Extract<NotificationLedgerEntry, { status: "reserved" }>;
type NotificationLedgerDismissal = Extract<NotificationLedgerEntry, { status: "dismissed" }>;

/** 空digest抑制を明示する通知選別結果。 */
export type DiscordNotificationSelection =
  | Readonly<{
      action: "skip_digest";
      reason: "no_candidates";
      candidates: readonly [];
      ledgerReservations: readonly [];
    }>
  | Readonly<{
      action: "create_digest";
      candidates: readonly [DiscordNotificationCandidate, ...DiscordNotificationCandidate[]];
      ledgerReservations: readonly [
        NotificationLedgerReservation,
        ...NotificationLedgerReservation[],
      ];
    }>;

type ReasonSignal = Readonly<{
  reason: NotificationReason;
  stateDiscriminator: string;
  repeatable: boolean;
  highPriorityEligible: boolean;
}>;

type EligibleReason = Readonly<{
  signal: ReasonSignal;
  notificationKey: string;
  cooldownUntil: UtcIsoDateTime;
}>;

type CandidateDraft = Readonly<{
  item: DiscordNotificationItem;
  reasons: readonly [EligibleReason, ...EligibleReason[]];
}>;

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

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

function validateThresholdsHours(thresholdsHours: SeverityThresholds): void {
  for (const waitClass of STALENESS_WAIT_CLASSES) {
    const threshold = thresholdsHours[waitClass];
    for (const [severity, value] of Object.entries(threshold)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${waitClass}.${severity}のseverity閾値は0以上の有限値にしてください`);
      }
    }
    if (threshold.watch > threshold.urgent || threshold.urgent > threshold.critical) {
      throw new RangeError(`${waitClass}のseverity閾値はwatch、urgent、criticalの順にしてください`);
    }
  }
}

function waitingOnSignature(waitingOnValues: readonly WaitingOn[]): string {
  return JSON.stringify(
    waitingOnValues.map((waitingOn) => [waitingOn.kind, waitingOn.candidateId, waitingOn.role]),
  );
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
    const cooldownTimestamp = parseTimestamp(entry.cooldownUntil, "ledgerのcooldown終了時刻");
    if (reservedTimestamp > evaluatedTimestamp || cooldownTimestamp < reservedTimestamp) {
      throw new RangeError("ledgerの時刻は予約時刻、cooldown終了時刻の順にしてください");
    }
    if (entry.status === "reserved") {
      const expiresTimestamp = parseTimestamp(entry.expiresAt, "ledgerの予約期限");
      if (expiresTimestamp < reservedTimestamp) {
        throw new RangeError("ledgerの予約期限は予約時刻以後にしてください");
      }
    } else if (entry.status === "sent") {
      const sentTimestamp = parseTimestamp(entry.sentAt, "ledgerの送信時刻");
      if (sentTimestamp < reservedTimestamp || sentTimestamp > evaluatedTimestamp) {
        throw new RangeError("ledgerの送信時刻は予約時刻以後かつ判定時刻以前にしてください");
      }
    } else {
      const dismissedTimestamp = parseTimestamp(entry.dismissedAt, "ledgerの抑制時刻");
      if (dismissedTimestamp < reservedTimestamp || dismissedTimestamp > evaluatedTimestamp) {
        throw new RangeError("ledgerの抑制時刻は予約時刻以後かつ判定時刻以前にしてください");
      }
    }
  }
}

function validateInput(input: SelectDiscordNotificationsInput): number {
  const evaluatedTimestamp = parseTimestamp(input.evaluatedAt, "通知判定時刻");
  if (
    !Number.isInteger(input.settings.maxItemsPerDigest) ||
    input.settings.maxItemsPerDigest <= 0
  ) {
    throw new RangeError("maxItemsPerDigestは1以上の整数にしてください");
  }
  validateNonNegativeInteger(input.settings.cooldownDays.urgent, "urgent cooldown日数");
  validateNonNegativeInteger(input.settings.cooldownDays.critical, "critical cooldown日数");
  validateThresholdsHours(input.settings.thresholdsHours);
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
    validateCurrentState(item, evaluatedTimestamp);
    validatePreviousState(item, evaluatedTimestamp);
    validateGraphContext(item);
  }
  validateLedger(input.ledger, evaluatedTimestamp);
  return evaluatedTimestamp;
}

function hoursBetween(earlier: UtcIsoDateTime, laterTimestamp: number): number {
  return (laterTimestamp - parseTimestamp(earlier, "経過時間の起点")) / MILLISECONDS_PER_HOUR;
}

function isRecentDraft(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
  graceHours: number,
): boolean {
  return (
    item.draftState === "draft" && hoursBetween(item.createdAt, evaluatedTimestamp) < graceHours
  );
}

function isItemSuppressed(
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

function overdueReasonCode(
  status: Status,
  waitClass: StalenessWaitClass,
): DiscordNotificationReasonCode | undefined {
  switch (waitClass) {
    case "assessment":
      return "assessment_overdue";
    case "owner":
      return status === "unknown" ? "owner_unknown" : "owner_overdue";
    case "decision":
      return "decision_overdue";
    case "review":
      return "review_overdue";
    case "revision":
      return "revision_overdue";
    case "reply":
      return "reply_overdue";
    case "merge":
      return "merge_overdue";
    case "automation":
      return "automation_stuck";
    case "work":
    case "blockedParent":
    case "notApplicable":
      return undefined;
  }
}

function waitClassForTimeReasonCode(reasonCode: NotificationTimeReasonCode): WaitClass {
  switch (reasonCode) {
    case "assessment_overdue":
      return "assessment";
    case "owner_overdue":
      return "owner";
    case "decision_overdue":
      return "decision";
    case "review_overdue":
      return "review";
    case "revision_overdue":
      return "revision";
    case "reply_overdue":
      return "reply";
    case "merge_overdue":
      return "merge";
    case "automation_stuck":
      return "automation";
  }
}

function isTimeNotificationReasonCode(
  reasonCode: DiscordNotificationReasonCode,
): reasonCode is NotificationTimeReasonCode {
  switch (reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "merge_overdue":
    case "automation_stuck":
      return true;
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
      return false;
  }
}

type NotificationReasonSelectionInput =
  | Readonly<{
      reasonCode: NotificationTimeReasonCode;
      thresholdsHours: SeverityThresholds;
    }>
  | Readonly<{
      reasonCode: NotificationNonTimeReasonCode;
    }>;

function notificationReasonForSelection(
  input: NotificationReasonSelectionInput,
): NotificationReason {
  switch (input.reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "merge_overdue":
    case "automation_stuck": {
      const waitClass = waitClassForTimeReasonCode(input.reasonCode);
      return createNotificationReason(input.reasonCode, {
        status: "recorded",
        hours: input.thresholdsHours[waitClass].watch,
      });
    }
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
      return createNotificationReason(input.reasonCode, {
        status: "not_applicable",
      });
  }
}

function isStateReasonAllowed(
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
  return item.current.severity === "urgent" || item.current.severity === "critical";
}

function hasRecentMeaningfulProgress(
  item: DiscordNotificationItem,
  evaluatedTimestamp: number,
  graceHours: number,
): boolean {
  return hoursBetween(item.current.lastProgressAt, evaluatedTimestamp) < graceHours;
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
  if (reasonCode != null && isStateReasonAllowed(item, reasonCode, settings.minimumAiConfidence)) {
    const reason = isTimeNotificationReasonCode(reasonCode)
      ? notificationReasonForSelection({
          reasonCode,
          thresholdsHours: settings.thresholdsHours,
        })
      : notificationReasonForSelection({
          reasonCode,
        });
    signals.push({
      reason,
      stateDiscriminator: item.current.waitClass,
      repeatable: true,
      highPriorityEligible: true,
    });
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
      reason: notificationReasonForSelection({
        reasonCode: "blocker_overdue",
      }),
      stateDiscriminator: JSON.stringify([impact.openNodeCount, impact.repositoryCount]),
      repeatable: true,
      highPriorityEligible: true,
    });
  }
  return signals;
}

function isImportantNewlyUnblocked(item: DiscordNotificationItem): boolean {
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
    reason: notificationReasonForSelection({
      reasonCode: "newly_unblocked",
    }),
    stateDiscriminator: item.current.statusSince,
    repeatable: false,
    highPriorityEligible: true,
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
    waitingOnSignature(previous.waitingOn) === waitingOnSignature(item.current.waitingOn)
  ) {
    return undefined;
  }
  return {
    reason: notificationReasonForSelection({
      reasonCode: "responsibility_changed",
    }),
    stateDiscriminator: item.current.ownerSince,
    repeatable: false,
    highPriorityEligible: true,
  };
}

function recommendationIsRepeatable(reasonCode: DiscordNotificationReasonCode): boolean {
  switch (reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "owner_unknown":
    case "blocker_overdue":
    case "merge_overdue":
    case "automation_stuck":
      return true;
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
      return false;
  }
}

function createRecommendationSignal(
  item: DiscordNotificationItem,
  thresholdsHours: SeverityThresholds,
): ReasonSignal | undefined {
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
  const reason = isTimeNotificationReasonCode(recommendation.reasonCode)
    ? notificationReasonForSelection({
        reasonCode: recommendation.reasonCode,
        thresholdsHours,
      })
    : notificationReasonForSelection({
        reasonCode: recommendation.reasonCode,
      });
  return {
    reason,
    stateDiscriminator: JSON.stringify([item.nodeId, "codex_recommendation"]),
    repeatable: recommendationIsRepeatable(recommendation.reasonCode),
    highPriorityEligible: recommendation.highPriorityEligible,
  };
}

function listNewDependencyCycleIds(item: DiscordNotificationItem): readonly DependencyCycleId[] {
  if (item.graph.previousDependencyCycles.availability === "not_available") {
    return [];
  }
  const previousCycleIds = new Set(item.graph.previousDependencyCycles.cycleIds);
  return item.graph.currentDependencyCycleIds.filter((cycleId) => !previousCycleIds.has(cycleId));
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function severityRank(severity: Severity): number {
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

function assignNewCycles(
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

function createSignals(
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
      reason: notificationReasonForSelection({
        reasonCode: "dependency_cycle",
      }),
      stateDiscriminator: cycleId,
      repeatable: false,
      highPriorityEligible: true,
    });
  }
  const recommendation = createRecommendationSignal(item, settings.thresholdsHours);
  if (
    recommendation != null &&
    !signals.some((signal) => signal.reason.reasonCode === recommendation.reason.reasonCode)
  ) {
    signals.push(recommendation);
  }
  return signals;
}

function notificationState(item: DiscordNotificationItem, signal: ReasonSignal): string {
  if (signal.reason.reasonCode === "dependency_cycle") {
    return JSON.stringify([signal.reason.reasonCode, signal.stateDiscriminator]);
  }
  return JSON.stringify([
    item.nodeId,
    signal.reason.reasonCode,
    item.current.status,
    item.current.severity,
    waitingOnSignature(item.current.waitingOn),
    item.current.statusSince,
    item.current.ownerSince,
    item.current.stallSince,
    signal.stateDiscriminator,
  ]);
}

function createNotificationKey(item: DiscordNotificationItem, signal: ReasonSignal): string {
  const stateHash = createHash("sha256").update(notificationState(item, signal)).digest("hex");
  return `discord-notification:v1:${signal.reason.reasonCode}:${stateHash}`;
}

function isSameUtcDate(left: UtcIsoDateTime, right: UtcIsoDateTime): boolean {
  return left.slice(0, 10) === right.slice(0, 10);
}

function isEligibleAgainstLedger(
  item: DiscordNotificationItem,
  signal: ReasonSignal,
  notificationKey: string,
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  evaluatedAt: UtcIsoDateTime,
  evaluatedTimestamp: number,
): boolean {
  const existing = ledgerByKey.get(notificationKey);
  if (existing == null) {
    return true;
  }
  if (existing.status === "reserved") {
    return evaluatedTimestamp >= parseTimestamp(existing.expiresAt, "ledgerの予約期限");
  }
  if (existing.status === "dismissed") {
    return false;
  }
  if (isSameUtcDate(existing.sentAt, evaluatedAt)) {
    return false;
  }
  if (
    !signal.repeatable ||
    (item.current.severity !== "urgent" && item.current.severity !== "critical")
  ) {
    return false;
  }
  return evaluatedTimestamp >= parseTimestamp(existing.cooldownUntil, "ledgerのcooldown終了時刻");
}

function startOfNextUtcDate(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function cooldownUntil(
  severity: Severity,
  evaluatedTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): UtcIsoDateTime {
  const cooldownDays =
    severity === "urgent"
      ? settings.cooldownDays.urgent
      : severity === "critical"
        ? settings.cooldownDays.critical
        : 0;
  const configuredTimestamp = evaluatedTimestamp + cooldownDays * MILLISECONDS_PER_DAY;
  const cooldownTimestamp = Math.max(configuredTimestamp, startOfNextUtcDate(evaluatedTimestamp));
  if (!Number.isFinite(cooldownTimestamp)) {
    throw new RangeError("cooldown終了時刻を計算できません");
  }
  return createUtcIsoDateTime(new Date(cooldownTimestamp).toISOString());
}

function reservationExpiresAt(reservedAt: UtcIsoDateTime): UtcIsoDateTime {
  const expiresTimestamp =
    parseTimestamp(reservedAt, "ledgerの予約時刻") + RESERVATION_DURATION_MILLISECONDS;
  if (!Number.isFinite(expiresTimestamp)) {
    throw new RangeError("ledgerの予約期限を計算できません");
  }
  return createUtcIsoDateTime(new Date(expiresTimestamp).toISOString());
}

function reasonPriority(reasonCode: DiscordNotificationReasonCode): number {
  switch (reasonCode) {
    case "dependency_cycle":
      return 10;
    case "blocker_overdue":
      return 9;
    case "owner_unknown":
      return 8;
    case "newly_unblocked":
      return 7;
    case "responsibility_changed":
      return 6;
    case "merge_overdue":
      return 5;
    case "revision_overdue":
      return 4;
    case "decision_overdue":
    case "reply_overdue":
    case "review_overdue":
      return 3;
    case "owner_overdue":
    case "assessment_overdue":
      return 2;
    case "automation_stuck":
      return 1;
  }
}

function compareEligibleReasons(left: EligibleReason, right: EligibleReason): -1 | 0 | 1 {
  const priorityDifference =
    reasonPriority(right.signal.reason.reasonCode) - reasonPriority(left.signal.reason.reasonCode);
  if (priorityDifference !== 0) {
    return priorityDifference < 0 ? -1 : 1;
  }
  return compareStrings(left.notificationKey, right.notificationKey);
}

function toNonEmptyReasons(
  reasons: readonly EligibleReason[],
  context: string,
): readonly [EligibleReason, ...EligibleReason[]] {
  const [first, ...rest] = reasons;
  assertNonNullable(first, context);
  return Object.freeze([first, ...rest]);
}

function createCandidateDrafts(
  input: SelectDiscordNotificationsInput,
  evaluatedTimestamp: number,
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
): readonly CandidateDraft[] {
  const unsuppressedItems = input.items.filter(
    (item) => !isItemSuppressed(item, evaluatedTimestamp, input.settings),
  );
  const assignedCycles = assignNewCycles(unsuppressedItems, evaluatedTimestamp);
  const drafts: CandidateDraft[] = [];

  for (const item of unsuppressedItems) {
    const signals = createSignals(
      item,
      assignedCycles.get(item.nodeId) ?? [],
      evaluatedTimestamp,
      input.settings,
    );
    const eligibleReasons = signals
      .map((signal) => {
        const notificationKey = createNotificationKey(item, signal);
        return {
          signal,
          notificationKey,
          cooldownUntil: cooldownUntil(item.current.severity, evaluatedTimestamp, input.settings),
        } satisfies EligibleReason;
      })
      .filter((reason) =>
        isEligibleAgainstLedger(
          item,
          reason.signal,
          reason.notificationKey,
          ledgerByKey,
          input.evaluatedAt,
          evaluatedTimestamp,
        ),
      )
      .sort(compareEligibleReasons);
    if (eligibleReasons.length === 0) {
      continue;
    }
    drafts.push({
      item,
      reasons: toNonEmptyReasons(eligibleReasons, `${item.nodeId}の通知理由を選択できませんでした`),
    });
  }
  return drafts;
}

function candidateTier(draft: CandidateDraft): number {
  if (!draft.reasons.some((reason) => reason.signal.highPriorityEligible)) {
    return 1;
  }
  if (draft.item.current.severity === "critical") {
    return 7;
  }
  if (draft.reasons.some((reason) => reason.signal.reason.reasonCode === "dependency_cycle")) {
    return 6;
  }
  if (draft.item.current.severity === "urgent") {
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
  if (draft.item.current.severity === "watch") {
    return 2;
  }
  return 1;
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
  const metricComparison = compareItemMetrics(left.item, right.item, evaluatedTimestamp);
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
    cooldownUntil: reason.cooldownUntil,
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
    return Object.freeze({
      reasonCode: signalReason.reasonCode,
      threshold: Object.freeze({
        status: "not_recorded",
      }),
      ...selectionFields,
    });
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
    severity: draft.item.current.severity,
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
    severity: candidate.severity,
    reservedAt: evaluatedAt,
    expiresAt: reservationExpiresAt(evaluatedAt),
    cooldownUntil: reason.cooldownUntil,
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

/** noise、ledger、cooldown、順位、件数上限を適用してDiscord通知候補を選ぶ。 */
export function selectDiscordNotifications(
  input: SelectDiscordNotificationsInput,
): DiscordNotificationSelection {
  const evaluatedTimestamp = validateInput(input);
  const ledgerByKey = new Map(input.ledger.map((entry) => [entry.notificationKey, entry]));
  const candidates = [...createCandidateDrafts(input, evaluatedTimestamp, ledgerByKey)]
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
  });
}

function createDismissedLedgerEntry(
  candidate: DiscordNotificationCandidate,
  reason: SelectedDiscordNotificationReason,
  evaluatedAt: UtcIsoDateTime,
): NotificationLedgerDismissal {
  return Object.freeze({
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: candidate.severity,
    reservedAt: evaluatedAt,
    cooldownUntil: reason.cooldownUntil,
    status: "dismissed",
    dismissedAt: evaluatedAt,
  } satisfies NotificationLedgerEntry);
}

/** 現在の全通知候補に対応する手動抑制済みledger entryを上限なしで生成する。 */
export function createDismissedNotificationLedgerEntries(
  input: SelectDiscordNotificationsInput,
): readonly NotificationLedgerDismissal[] {
  const evaluatedTimestamp = validateInput(input);
  const candidates = [
    ...createCandidateDrafts(input, evaluatedTimestamp, new Map<string, NotificationLedgerEntry>()),
  ]
    .sort((left, right) => compareCandidateDrafts(left, right, evaluatedTimestamp))
    .map(createCandidate);
  const dismissedEntries = candidates.flatMap((candidate) =>
    candidate.reasons.map((reason) =>
      createDismissedLedgerEntry(candidate, reason, input.evaluatedAt),
    ),
  );
  return Object.freeze(dismissedEntries);
}

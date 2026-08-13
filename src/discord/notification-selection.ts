import {
  calculateStallNotificationSchedule,
  evaluateNormalDigestRun,
  evaluateStallNotificationWindow,
  isOneTimeNotificationDue,
  type NormalDigestRunContext,
} from "./deterministic-notification-windows.js";
import {
  createUtcIsoDateTime,
  isTerminalStatus,
  type GitHubNodeId,
  type NotificationReasonCode,
  type Severity,
  type SeverityThresholds,
  type StalenessWaitClass,
  type Status,
  type TrackingNotificationClass,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { type DependencyCycleId, type DownstreamImpact } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

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

/** 一回限り通知の検証済みイベント。 */
export type DiscordNotificationEvent =
  | Readonly<{
      kind: "newly_unblocked";
      occurredAt: UtcIsoDateTime;
    }>
  | Readonly<{
      kind: "responsibility_changed";
      occurredAt: UtcIsoDateTime;
    }>
  | Readonly<{
      kind: "dependency_cycle";
      cycleId: DependencyCycleId;
      occurredAt: UtcIsoDateTime;
    }>
  | Readonly<{
      kind: "ai_notification";
      reasonCode: DiscordNotificationReasonCode;
      occurredAt: UtcIsoDateTime;
    }>;

/** 現在のblocks graphの影響範囲とcycleイベント。 */
export type DiscordNotificationGraphContext = Readonly<{
  downstreamImpact: DownstreamImpact;
  dependencyCycles: readonly Readonly<{
    cycleId: DependencyCycleId;
    occurredAt: UtcIsoDateTime;
  }>[];
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
  events: readonly DiscordNotificationEvent[];
  graph: DiscordNotificationGraphContext;
}>;

/** 設定から渡す通知上限、再通知間隔、noise閾値、severity閾値。 */
export type DiscordNotificationSelectionSettings = Readonly<{
  maxItemsPerDigest: number;
  repeatDays: Readonly<{
    urgent: number;
    critical: number;
  }>;
  recentProgressGraceHours: number;
  minimumAiConfidence: number;
  severityThresholds: SeverityThresholds;
}>;

/** 通知候補選別へ渡す正規基準時刻、workflow context、項目、設定。 */
export type SelectDiscordNotificationsInput = Readonly<{
  referenceAt: UtcIsoDateTime;
  runContext: NormalDigestRunContext;
  items: readonly DiscordNotificationItem[];
  settings: DiscordNotificationSelectionSettings;
}>;

/** 選別された1理由。 */
export type SelectedDiscordNotificationReason = Readonly<{
  reasonCode: DiscordNotificationReasonCode;
}>;

/** digestへ1件として渡す通知候補。 */
export type DiscordNotificationCandidate = Readonly<{
  itemNodeId: GitHubNodeId;
  reasonCode: DiscordNotificationReasonCode;
  reasons: readonly [SelectedDiscordNotificationReason, ...SelectedDiscordNotificationReason[]];
  severity: Severity;
  downstreamImpact: DownstreamImpact;
  priorityWeight: number;
}>;

/** 空digestまたは通常digestの抑止理由を表す通知選別結果。 */
export type DiscordNotificationSelection =
  | Readonly<{
      action: "skip_digest";
      reason: "no_candidates" | "manual" | "rerun";
      candidates: readonly [];
    }>
  | Readonly<{
      action: "create_digest";
      candidates: readonly [DiscordNotificationCandidate, ...DiscordNotificationCandidate[]];
    }>;

type ReasonSignal = Readonly<{
  reasonCode: DiscordNotificationReasonCode;
  eventAt: UtcIsoDateTime;
  stateDiscriminator: string;
  highPriorityEligible: boolean;
}>;

type CandidateDraft = Readonly<{
  item: DiscordNotificationItem;
  reasons: readonly [ReasonSignal, ...ReasonSignal[]];
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

function validatePositiveInteger(value: number, context: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${context}は1以上の整数にしてください`);
  }
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

function validateCurrentState(item: DiscordNotificationItem): void {
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
    if (timestamp < createdTimestamp) {
      throw new RangeError(`${item.nodeId}の${name}は作成時刻以後にしてください`);
    }
  }
}

function validateEvent(item: DiscordNotificationItem, event: DiscordNotificationEvent): void {
  const eventTimestamp = parseTimestamp(event.occurredAt, `${item.nodeId}のイベント時刻`);
  const createdTimestamp = parseTimestamp(item.createdAt, `${item.nodeId}の作成時刻`);
  if (eventTimestamp < createdTimestamp) {
    throw new RangeError(`${item.nodeId}のイベント時刻は作成時刻以後にしてください`);
  }
  if (event.kind === "dependency_cycle" && event.cycleId.length === 0) {
    throw new TypeError(`${item.nodeId}のdependency cycle IDは空にできません`);
  }
}

function validateEvents(item: DiscordNotificationItem): void {
  const cycleIds = item.events
    .filter((event) => event.kind === "dependency_cycle")
    .map((event) => event.cycleId);
  if (new Set(cycleIds).size !== cycleIds.length) {
    throw new TypeError(`${item.nodeId}のdependency cycle IDが重複しています`);
  }
  for (const event of item.events) {
    validateEvent(item, event);
  }
}

function validateGraphContext(item: DiscordNotificationItem): void {
  const impact = item.graph.downstreamImpact;
  if (impact.nodeId !== item.nodeId) {
    throw new TypeError(`${item.nodeId}のdownstream impactが別のnodeを参照しています`);
  }
  validateNonNegativeInteger(impact.openNodeCount, `${item.nodeId}のdownstream open node数`);
  validateNonNegativeInteger(impact.repositoryCount, `${item.nodeId}のdownstream repository数`);
  const cycleIds = item.graph.dependencyCycles.map((cycle) => cycle.cycleId);
  if (new Set(cycleIds).size !== cycleIds.length) {
    throw new TypeError(`${item.nodeId}のdependency cycle IDが重複しています`);
  }
  for (const cycle of item.graph.dependencyCycles) {
    const eventTimestamp = parseTimestamp(cycle.occurredAt, `${item.nodeId}のdependency cycle時刻`);
    const createdTimestamp = parseTimestamp(item.createdAt, `${item.nodeId}の作成時刻`);
    if (eventTimestamp < createdTimestamp) {
      throw new RangeError(`${item.nodeId}のdependency cycle時刻は作成時刻以後にしてください`);
    }
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

function validateInput(input: SelectDiscordNotificationsInput): number {
  const referenceTimestamp = parseTimestamp(input.referenceAt, "通知基準時刻");
  const runDecision = evaluateNormalDigestRun(input.runContext);
  if (runDecision.allowed && Date.parse(runDecision.scheduledFor) !== referenceTimestamp) {
    throw new RangeError("通知基準時刻はscheduleの予定時刻と一致させてください");
  }
  if (
    !Number.isInteger(input.settings.maxItemsPerDigest) ||
    input.settings.maxItemsPerDigest <= 0
  ) {
    throw new RangeError("maxItemsPerDigestは1以上の整数にしてください");
  }
  validatePositiveInteger(input.settings.repeatDays.urgent, "urgent repeat日数");
  validatePositiveInteger(input.settings.repeatDays.critical, "critical repeat日数");
  if (
    !Number.isFinite(input.settings.recentProgressGraceHours) ||
    input.settings.recentProgressGraceHours < 0
  ) {
    throw new RangeError("recent progress猶予時間は0以上の有限値にしてください");
  }
  validateProbability(input.settings.minimumAiConfidence, "AI通知の最低confidence");
  for (const [waitClass, threshold] of Object.entries(input.settings.severityThresholds)) {
    for (const [severity, value] of Object.entries(threshold)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${waitClass}.${severity}のseverity閾値は0以上の有限値にしてください`);
      }
    }
    if (threshold.watch > threshold.urgent || threshold.urgent > threshold.critical) {
      throw new RangeError(`${waitClass}のseverity閾値はwatch、urgent、criticalの順にしてください`);
    }
  }

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
    validateCurrentState(item);
    validateEvents(item);
    validateGraphContext(item);
  }
  return referenceTimestamp;
}

function hoursBetween(earlier: UtcIsoDateTime, laterTimestamp: number): number {
  return (laterTimestamp - parseTimestamp(earlier, "経過時間の起点")) / MILLISECONDS_PER_HOUR;
}

function isRecentDraft(
  item: DiscordNotificationItem,
  referenceTimestamp: number,
  graceHours: number,
): boolean {
  return (
    item.draftState === "draft" && hoursBetween(item.createdAt, referenceTimestamp) < graceHours
  );
}

function isItemSuppressed(
  item: DiscordNotificationItem,
  referenceTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): boolean {
  if (
    item.repositoryFreshness === "stale" ||
    item.notificationsSuppressedByLabel ||
    item.notificationClass === "automation_noise" ||
    isRecentDraft(item, referenceTimestamp, settings.recentProgressGraceHours)
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

function thresholdForSeverity(
  item: DiscordNotificationItem,
  settings: DiscordNotificationSelectionSettings,
): number | undefined {
  if (item.current.waitClass === "blockedParent" || item.current.waitClass === "notApplicable") {
    return undefined;
  }
  const thresholds = settings.severityThresholds[item.current.waitClass];
  switch (item.current.severity) {
    case "none":
      return undefined;
    case "watch":
      return thresholds.watch;
    case "urgent":
      return thresholds.urgent;
    case "critical":
      return thresholds.critical;
  }
}

function thresholdReachedAt(item: DiscordNotificationItem, thresholdHours: number): UtcIsoDateTime {
  const stallTimestamp = parseTimestamp(item.current.stallSince, `${item.nodeId}のstallSince`);
  const reachedTimestamp = stallTimestamp + thresholdHours * MILLISECONDS_PER_HOUR;
  if (!Number.isFinite(reachedTimestamp)) {
    throw new RangeError(`${item.nodeId}のseverity閾値到達時刻を計算できません`);
  }
  return createUtcIsoDateTime(new Date(reachedTimestamp).toISOString());
}

function isStallNotificationDue(
  item: DiscordNotificationItem,
  referenceAt: UtcIsoDateTime,
  referenceTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): boolean {
  if (
    item.current.severity === "none" ||
    parseTimestamp(item.current.stallSince, `${item.nodeId}のstallSince`) > referenceTimestamp ||
    parseTimestamp(item.current.lastProgressAt, `${item.nodeId}のlastProgressAt`) >
      referenceTimestamp ||
    hoursBetween(item.current.lastProgressAt, referenceTimestamp) <
      settings.recentProgressGraceHours
  ) {
    return false;
  }
  const thresholdHours = thresholdForSeverity(item, settings);
  if (thresholdHours == null) {
    return false;
  }
  const thresholdAt = thresholdReachedAt(item, thresholdHours);
  if (item.current.severity === "watch") {
    return isOneTimeNotificationDue({ eventAt: thresholdAt, referenceAt });
  }
  const schedule = calculateStallNotificationSchedule({
    stallSince: item.current.stallSince,
    severity: item.current.severity,
    thresholdHours,
    repeatDays: settings.repeatDays,
  });
  return evaluateStallNotificationWindow({ schedule, referenceAt }).status === "eligible";
}

function createOverdueSignals(
  item: DiscordNotificationItem,
  referenceAt: UtcIsoDateTime,
  referenceTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): ReasonSignal[] {
  if (!isStallNotificationDue(item, referenceAt, referenceTimestamp, settings)) {
    return [];
  }
  const thresholdHours = thresholdForSeverity(item, settings);
  assertNonNullable(thresholdHours, `${item.nodeId}のseverity閾値がありません`);
  const eventAt = thresholdReachedAt(item, thresholdHours);
  const signals: ReasonSignal[] = [];
  const reasonCode = overdueReasonCode(item.current.status, item.current.waitClass);
  if (reasonCode != null && isStateReasonAllowed(item, reasonCode, settings.minimumAiConfidence)) {
    signals.push({
      reasonCode,
      eventAt,
      stateDiscriminator: item.current.waitClass,
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
      reasonCode: "blocker_overdue",
      eventAt,
      stateDiscriminator: JSON.stringify([impact.openNodeCount, impact.repositoryCount]),
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

function createEventSignals(
  item: DiscordNotificationItem,
  referenceAt: UtcIsoDateTime,
  minimumAiConfidence: number,
): ReasonSignal[] {
  const signals: ReasonSignal[] = [];
  const seenEvents = new Set<string>();
  for (const event of item.events) {
    const eventKey = JSON.stringify([
      event.kind,
      event.occurredAt,
      event.kind === "dependency_cycle" ? event.cycleId : "",
    ]);
    if (seenEvents.has(eventKey)) {
      continue;
    }
    seenEvents.add(eventKey);
    if (!isOneTimeNotificationDue({ eventAt: event.occurredAt, referenceAt })) {
      continue;
    }
    switch (event.kind) {
      case "newly_unblocked":
        if (isImportantNewlyUnblocked(item)) {
          signals.push({
            reasonCode: "newly_unblocked",
            eventAt: event.occurredAt,
            stateDiscriminator: event.occurredAt,
            highPriorityEligible: true,
          });
        }
        break;
      case "responsibility_changed":
        if (
          !isTerminalStatus(item.current.status) &&
          isStateReasonAllowed(item, "responsibility_changed", minimumAiConfidence)
        ) {
          signals.push({
            reasonCode: "responsibility_changed",
            eventAt: event.occurredAt,
            stateDiscriminator: event.occurredAt,
            highPriorityEligible: true,
          });
        }
        break;
      case "dependency_cycle":
        signals.push({
          reasonCode: "dependency_cycle",
          eventAt: event.occurredAt,
          stateDiscriminator: event.cycleId,
          highPriorityEligible: true,
        });
        break;
      case "ai_notification":
        if (
          item.notificationRecommendation.availability === "available" &&
          item.notificationRecommendation.value.recommended &&
          item.notificationRecommendation.value.policy !== "suppressed" &&
          item.notificationRecommendation.value.reasonCode === event.reasonCode &&
          isStateReasonAllowed(item, event.reasonCode, minimumAiConfidence)
        ) {
          signals.push({
            reasonCode: event.reasonCode,
            eventAt: event.occurredAt,
            stateDiscriminator: JSON.stringify([event.reasonCode, event.occurredAt]),
            highPriorityEligible: item.notificationRecommendation.value.highPriorityEligible,
          });
        }
        break;
    }
  }
  return signals;
}

function cycleEvents(item: DiscordNotificationItem): readonly DiscordNotificationEvent[] {
  return item.graph.dependencyCycles.map((cycle) => ({
    kind: "dependency_cycle",
    cycleId: cycle.cycleId,
    occurredAt: cycle.occurredAt,
  }));
}

function createSignals(
  item: DiscordNotificationItem,
  referenceAt: UtcIsoDateTime,
  referenceTimestamp: number,
  settings: DiscordNotificationSelectionSettings,
): readonly ReasonSignal[] {
  const itemEvents = [...item.events, ...cycleEvents(item)];
  const eventSignals = createEventSignals(
    Object.freeze({ ...item, events: Object.freeze(itemEvents) }),
    referenceAt,
    settings.minimumAiConfidence,
  );
  return [
    ...createOverdueSignals(item, referenceAt, referenceTimestamp, settings),
    ...eventSignals,
  ];
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
  referenceTimestamp: number,
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
    hoursBetween(right.current.stallSince, referenceTimestamp) -
    hoursBetween(left.current.stallSince, referenceTimestamp);
  if (stallDifference !== 0) {
    return stallDifference < 0 ? -1 : 1;
  }
  return compareStrings(left.nodeId, right.nodeId);
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

function compareSignals(left: ReasonSignal, right: ReasonSignal): -1 | 0 | 1 {
  const priorityDifference = reasonPriority(right.reasonCode) - reasonPriority(left.reasonCode);
  if (priorityDifference !== 0) {
    return priorityDifference < 0 ? -1 : 1;
  }
  const eventDifference = left.eventAt < right.eventAt ? -1 : left.eventAt > right.eventAt ? 1 : 0;
  if (eventDifference !== 0) {
    return eventDifference;
  }
  return compareStrings(left.stateDiscriminator, right.stateDiscriminator);
}

function toNonEmptyTuple<Value>(
  reasons: readonly Value[],
  context: string,
): readonly [Value, ...Value[]] {
  const [first, ...rest] = reasons;
  assertNonNullable(first, context);
  return Object.freeze([first, ...rest]);
}

function candidateTier(draft: CandidateDraft): number {
  if (!draft.reasons.some((reason) => reason.highPriorityEligible)) {
    return 1;
  }
  if (draft.item.current.severity === "critical") {
    return 7;
  }
  if (draft.reasons.some((reason) => reason.reasonCode === "dependency_cycle")) {
    return 6;
  }
  if (draft.item.current.severity === "urgent") {
    return 5;
  }
  if (draft.reasons.some((reason) => reason.reasonCode === "newly_unblocked")) {
    return 4;
  }
  if (draft.reasons.some((reason) => reason.reasonCode === "responsibility_changed")) {
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
  referenceTimestamp: number,
): -1 | 0 | 1 {
  const tierDifference = candidateTier(right) - candidateTier(left);
  if (tierDifference !== 0) {
    return tierDifference < 0 ? -1 : 1;
  }
  const metricComparison = compareItemMetrics(left.item, right.item, referenceTimestamp);
  if (metricComparison !== 0) {
    return metricComparison;
  }
  return compareSignals(left.reasons[0], right.reasons[0]);
}

function createCandidate(draft: CandidateDraft): DiscordNotificationCandidate {
  const reasons = draft.reasons.map(
    (reason) =>
      Object.freeze({ reasonCode: reason.reasonCode }) satisfies SelectedDiscordNotificationReason,
  );
  const nonEmptyReasons = toNonEmptyTuple(reasons, `${draft.item.nodeId}の通知理由がありません`);
  const first = nonEmptyReasons[0];
  return Object.freeze({
    itemNodeId: draft.item.nodeId,
    reasonCode: first.reasonCode,
    reasons: nonEmptyReasons,
    severity: draft.item.current.severity,
    downstreamImpact: Object.freeze({ ...draft.item.graph.downstreamImpact }),
    priorityWeight: draft.item.priorityWeight,
  });
}

function nonEmptyCandidates(
  candidates: readonly DiscordNotificationCandidate[],
): readonly [DiscordNotificationCandidate, ...DiscordNotificationCandidate[]] {
  const [first, ...rest] = candidates;
  assertNonNullable(first, "通知候補がありません");
  return Object.freeze([first, ...rest]);
}

function createCandidateDrafts(
  input: SelectDiscordNotificationsInput,
  referenceTimestamp: number,
): readonly CandidateDraft[] {
  const unsuppressedItems = input.items.filter(
    (item) => !isItemSuppressed(item, referenceTimestamp, input.settings),
  );
  const drafts: CandidateDraft[] = [];
  for (const item of unsuppressedItems) {
    const signals = [
      ...createSignals(item, input.referenceAt, referenceTimestamp, input.settings),
    ].sort(compareSignals);
    if (signals.length === 0) {
      continue;
    }
    drafts.push({
      item,
      reasons: toNonEmptyTuple(signals, `${item.nodeId}の通知理由を選択できませんでした`),
    });
  }
  return drafts;
}

/** deterministic windowと現行状態だけを使ってDiscord通知候補を選ぶ。 */
export function selectDiscordNotifications(
  input: SelectDiscordNotificationsInput,
): DiscordNotificationSelection {
  const referenceTimestamp = validateInput(input);
  const runDecision = evaluateNormalDigestRun(input.runContext);
  if (!runDecision.allowed) {
    const candidates: readonly [] = Object.freeze([]);
    return Object.freeze({
      action: "skip_digest",
      reason: runDecision.reason,
      candidates,
    });
  }
  const candidates = [...createCandidateDrafts(input, referenceTimestamp)]
    .sort((left, right) => compareCandidateDrafts(left, right, referenceTimestamp))
    .slice(0, input.settings.maxItemsPerDigest)
    .map(createCandidate);
  if (candidates.length === 0) {
    const emptyCandidates: readonly [] = Object.freeze([]);
    return Object.freeze({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: emptyCandidates,
    });
  }
  return Object.freeze({
    action: "create_digest",
    candidates: nonEmptyCandidates(candidates),
  });
}

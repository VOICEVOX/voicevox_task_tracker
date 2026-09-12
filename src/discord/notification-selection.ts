import { createHash } from "node:crypto";

import {
  compareSeverity,
  createNotificationReason,
  createUtcIsoDateTime,
  currentPersonalReminderAssessment,
  isTerminalStatus,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  personalReminderCauseSchema,
  type GitHubNodeId,
  type NotificationNonTimeReasonCode,
  type NotificationReason,
  type NotificationTimeReasonCode,
  type NotificationLedgerEntry,
  type NotificationReasonCode,
  type PendingNotification,
  type PendingNotificationTarget,
  type PersonalReminderActionKind,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
  type PersonalReminderReasonCode,
  type PersonalReminderResponsible,
  type PersonalReminderStaleness,
  type PersonalReminderTimeBasis,
  type Severity,
  type StalenessNotificationSeverityReason,
  type StalenessWaitClass,
  type Status,
  type TrackingNotificationClass,
  type UtcIsoDateTime,
  type WaitClass,
  type WaitingOn,
} from "../domain/index.js";
import { type DependencyCycleId, type DownstreamImpact } from "../graph/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import {
  notificationCauseSchema,
  type NotificationCauses,
  type NotificationCause,
} from "./notification-cause.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const RESPONSIBILITY_CHANGE_STALL_HOURS = 48;
const RESERVATION_DURATION_MILLISECONDS = MILLISECONDS_PER_DAY;
const DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;

/** Discord通知で利用できるnone以外のreason code。 */
export type DiscordNotificationReasonCode = Exclude<NotificationReason["reasonCode"], "none">;

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
  severityReason: StalenessNotificationSeverityReason;
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
  hasOpenBlockers: boolean;
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
  causes: NotificationCauses;
  personalReminderCauses: readonly DiscordPersonalReminderInput[];
  personalReminderCausePlanning: PersonalReminderCausePlanning;
  graph: DiscordNotificationGraphContext;
}>;

/** 個人催促原因と現在のstaleness判定。 */
export type DiscordPersonalReminderInput = Readonly<{
  cause: PersonalReminderCause;
  staleness: PersonalReminderStaleness;
}>;

/** 送信直前にsnapshotから再計算した個人催促選別入力。 */
export type DiscordPersonalReminderSelectionValidationItem = Readonly<{
  nodeId: GitHubNodeId;
  current: Pick<
    DiscordNotificationCurrentState,
    | "status"
    | "waitingOn"
    | "severity"
    | "severityReason"
    | "waitClass"
    | "statusSince"
    | "ownerSince"
    | "stallSince"
    | "lastProgressAt"
  >;
  personalReminderCauses: readonly DiscordPersonalReminderInput[];
  personalReminderCausePlanning: PersonalReminderCausePlanning;
}>;

/** 個人催促通知の選別結果へ渡す原因の文脈。 */
export type DiscordPersonalReminderNotificationContext = Readonly<{
  causeId: PersonalReminderCause["causeId"];
  responsibilityId: PersonalReminderCause["responsibilityId"];
  responsible: readonly PersonalReminderResponsible[];
  action: Readonly<{
    kind: PersonalReminderActionKind;
    summary: string;
  }>;
  obligationSince: PersonalReminderTimeBasis;
  actionableSince: PersonalReminderTimeBasis;
  stallSince: PersonalReminderTimeBasis;
}>;

/** 選別した通知理由のsystemまたは個人催促由来。 */
export type DiscordNotificationReasonSource =
  | Readonly<{
      kind: "system";
    }>
  | Readonly<{
      kind: "personal_reminder";
      context: DiscordPersonalReminderNotificationContext;
    }>;

/** 設定から渡す通知上限、noise閾値。 */
export type DiscordNotificationSelectionSettings = Readonly<{
  maxItemsPerDigest: number;
  recentProgressGraceHours: number;
  minimumAiConfidence: number;
}>;

/** 通知候補選別へ渡す現在時刻、項目、ledger、設定。 */
export type SelectDiscordNotificationsInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  items: readonly DiscordNotificationItem[];
  ledger: readonly NotificationLedgerEntry[];
  pendingNotifications: readonly PendingNotification[];
  settings: DiscordNotificationSelectionSettings;
}>;

/** 選別された1理由とledger予約情報。 */
export type SelectedDiscordNotificationReason = NotificationReason &
  Readonly<{
    notificationKey: string;
    severity: Severity;
    source: DiscordNotificationReasonSource;
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
type NotificationLedgerAcknowledgement = Extract<
  NotificationLedgerEntry,
  { status: "acknowledged" }
>;

/** 空digestを明示する通知選別結果。 */
export type DiscordNotificationSelection =
  | Readonly<{
      action: "skip_digest";
      reason: "no_candidates" | "held";
      candidates: readonly [];
      ledgerReservations: readonly [];
      pendingNotifications: readonly PendingNotification[];
    }>
  | Readonly<{
      action: "create_digest";
      candidates: readonly [DiscordNotificationCandidate, ...DiscordNotificationCandidate[]];
      ledgerReservations: readonly [
        NotificationLedgerReservation,
        ...NotificationLedgerReservation[],
      ];
      pendingNotifications: readonly PendingNotification[];
    }>;

type PendingNotificationWaitingOn = Extract<
  PendingNotificationTarget,
  { kind: "responsibility" }
>["waitingOn"][number];

type ReasonSignal = Readonly<{
  reason: NotificationReason;
  stateDiscriminator: string;
  highPriorityEligible: boolean;
  target: PendingNotificationTarget;
  severity: Severity;
  source: DiscordNotificationReasonSource;
}>;

type EligibleReason = Readonly<{
  signal: ReasonSignal;
  notificationKey: string;
  pendingNotification: PendingNotification;
}>;

type CandidateDraft = Readonly<{
  item: DiscordNotificationItem;
  reasons: readonly [EligibleReason, ...EligibleReason[]];
}>;

function systemReasonSource(): DiscordNotificationReasonSource {
  return Object.freeze({ kind: "system" });
}

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

type WaitingOnReference = Readonly<Pick<WaitingOn, "kind" | "candidateId" | "role">>;

function waitingOnKeySignature(waitingOnValues: readonly WaitingOn[]): string {
  return JSON.stringify(
    waitingOnValues.map((waitingOn) => [waitingOn.kind, waitingOn.candidateId, waitingOn.role]),
  );
}

function waitingOnComparisonSignature(waitingOnValues: readonly WaitingOnReference[]): string {
  return JSON.stringify(normalizedResponsibilityForComparison(waitingOnValues));
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

function pendingTargetForReason(
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

function createPendingNotification(
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
  if (basis.source === "event" && basis.sourceIds.length === 0) {
    throw new TypeError(`${context}のsource IDは空にできません`);
  }
}

function samePersonalReminderTimeBasis(
  left: PersonalReminderTimeBasis,
  right: PersonalReminderTimeBasis,
): boolean {
  if (left.source !== right.source || left.at !== right.at) {
    return false;
  }
  if (left.source === "first_observation" || right.source === "first_observation") {
    return left.source === right.source;
  }
  return true;
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

function validateInput(input: SelectDiscordNotificationsInput): number {
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

const TIME_REASON_WAIT_CLASS = {
  assessment_overdue: "assessment",
  owner_overdue: "owner",
  decision_overdue: "decision",
  review_overdue: "review",
  revision_overdue: "revision",
  reply_overdue: "reply",
  work_overdue: "work",
  merge_overdue: "merge",
  automation_stuck: "automation",
} satisfies Readonly<Record<NotificationTimeReasonCode, WaitClass>>;

const PERSONAL_REMINDER_REASON_CODES = [
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "work_overdue",
  "merge_overdue",
] as const satisfies readonly PersonalReminderReasonCode[];

function isPersonalReminderReasonCode(
  reasonCode: DiscordNotificationReasonCode,
): reasonCode is PersonalReminderReasonCode {
  return PERSONAL_REMINDER_REASON_CODES.some((candidate) => candidate === reasonCode);
}

function personalReminderActionKindForReason(
  reasonCode: PersonalReminderReasonCode,
): PersonalReminderActionKind {
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
    case "work_overdue":
      return "work";
    case "merge_overdue":
      return "merge";
  }
}

function isNotificationTimeReasonCodeKey(value: string): value is NotificationTimeReasonCode {
  return Object.hasOwn(TIME_REASON_WAIT_CLASS, value);
}

function timeReasonCodeForWaitClass(
  waitClass: StalenessWaitClass,
): NotificationTimeReasonCode | undefined {
  for (const [reasonCode, candidateWaitClass] of Object.entries(TIME_REASON_WAIT_CLASS)) {
    if (candidateWaitClass === waitClass) {
      if (!isNotificationTimeReasonCodeKey(reasonCode)) {
        throw new TypeError(`時間系通知理由 ${reasonCode}の型が不正です`);
      }
      return reasonCode;
    }
  }
  return undefined;
}

function overdueReasonCode(
  status: Status,
  waitClass: StalenessWaitClass,
): DiscordNotificationReasonCode | undefined {
  if (waitClass === "owner" && status === "unknown") {
    return "owner_unknown";
  }
  if (waitClass === "work" && status !== "waiting_for_work") {
    return undefined;
  }
  return timeReasonCodeForWaitClass(waitClass);
}

function waitClassForTimeReasonCode(reasonCode: NotificationTimeReasonCode): WaitClass {
  return TIME_REASON_WAIT_CLASS[reasonCode];
}

function isTimeNotificationReasonCode(
  reasonCode: DiscordNotificationReasonCode,
): reasonCode is NotificationTimeReasonCode {
  return isNotificationTimeReasonCodeKey(reasonCode);
}

type NotificationReasonSelectionInput =
  | Readonly<{
      item: Pick<DiscordNotificationItem, "nodeId" | "current">;
      reasonCode: NotificationTimeReasonCode;
      source: "deterministic" | "codex";
    }>
  | Readonly<{
      reasonCode: NotificationNonTimeReasonCode;
    }>;

function notificationReasonForNonTimeSelection(
  reasonCode: NotificationNonTimeReasonCode,
): NotificationReason {
  const reason = notificationReasonForSelection({ reasonCode });
  assertNonNullable(reason, `非時間系通知理由 ${reasonCode}を生成できません`);
  return reason;
}

function notificationReasonForSelection(
  input: NotificationReasonSelectionInput,
): NotificationReason | undefined {
  switch (input.reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "work_overdue":
    case "merge_overdue":
    case "automation_stuck": {
      const waitClass = waitClassForTimeReasonCode(input.reasonCode);
      const current = input.item.current;
      if (current.waitClass !== waitClass) {
        if (input.source === "deterministic") {
          throw new TypeError(
            `${input.item.nodeId}の決定論的通知理由 ${input.reasonCode}とwait classが一致しません`,
          );
        }
        return undefined;
      }
      if (current.severityReason.kind !== "elapsed_threshold") {
        if (input.source === "deterministic") {
          throw new TypeError(
            `${input.item.nodeId}の時間系通知理由にseverityの時間判定根拠がありません`,
          );
        }
        return undefined;
      }
      if (current.severityReason.waitClass !== waitClass) {
        if (input.source === "deterministic") {
          throw new TypeError(
            `${input.item.nodeId}の時間系通知理由とseverityのwait classが一致しません`,
          );
        }
        return undefined;
      }
      return current.severityReason.crossedThreshold.status === "reached"
        ? createNotificationReason(input.reasonCode, {
            status: "recorded",
            hours: current.severityReason.crossedThreshold.thresholdHours,
          })
        : createNotificationReason(input.reasonCode, {
            status: "not_reached",
            elapsedHours: current.severityReason.elapsedHours,
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

function hasRecentMeaningfulProgress(
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

function createPersonalReminderSignals(
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

function isReasonSuppressedByCause(
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

function notificationState(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  signal: ReasonSignal,
): string {
  if (signal.reason.reasonCode === "dependency_cycle") {
    return JSON.stringify([signal.reason.reasonCode, signal.stateDiscriminator]);
  }
  return JSON.stringify([
    item.nodeId,
    signal.reason.reasonCode,
    item.current.status,
    item.current.severity,
    waitingOnKeySignature(item.current.waitingOn),
    item.current.statusSince,
    item.current.ownerSince,
    item.current.stallSince,
    signal.stateDiscriminator,
  ]);
}

function personalReminderResponsibleSignature(
  responsible: readonly PersonalReminderResponsible[],
): string {
  return JSON.stringify(normalizedResponsibilityForComparison(responsible));
}

function normalizedResponsibilityForComparison(
  responsible: readonly WaitingOnReference[],
): readonly (readonly [string, string, string])[] {
  return Object.freeze(
    responsible
      .map((value): readonly [string, string, string] => [
        value.kind,
        value.candidateId.toLowerCase(),
        value.role,
      ])
      .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right))),
  );
}

function personalReminderScopeIncludesItem(cause: PersonalReminderCause): boolean {
  switch (cause.responsibility.scope.kind) {
    case "item":
      return true;
    case "execution_surfaces":
      return false;
    case "item_and_execution_surfaces":
      return true;
  }
}

function responsibilityPeriodStart(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
): UtcIsoDateTime {
  const statusSinceTimestamp = parseTimestamp(
    item.current.statusSince,
    `${item.nodeId}のstatusSince`,
  );
  const ownerSinceTimestamp = parseTimestamp(item.current.ownerSince, `${item.nodeId}のownerSince`);
  return statusSinceTimestamp >= ownerSinceTimestamp
    ? item.current.statusSince
    : item.current.ownerSince;
}

function legacySystemSignalForPersonalReason(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  reasonCode: PersonalReminderReasonCode,
): ReasonSignal | undefined {
  if (overdueReasonCode(item.current.status, item.current.waitClass) !== reasonCode) {
    return undefined;
  }
  const reason = notificationReasonForSelection({
    item,
    reasonCode,
    source: "codex",
  });
  if (reason == null) {
    return undefined;
  }
  return Object.freeze({
    reason,
    stateDiscriminator: item.current.waitClass,
    highPriorityEligible: true,
    target: pendingTargetForReason(item, reasonCode, undefined),
    severity: item.current.severity,
    source: systemReasonSource(),
  });
}

function legacyOverdueSignalForPersonalReminder(
  item: Pick<DiscordNotificationItem, "nodeId" | "current">,
  signal: ReasonSignal,
): ReasonSignal | undefined {
  if (signal.source.kind !== "personal_reminder") {
    return undefined;
  }
  const reasonCode = signal.reason.reasonCode;
  if (!isPersonalReminderReasonCode(reasonCode)) {
    throw new TypeError(`個人催促通知理由 ${reasonCode}が時間系理由ではありません`);
  }
  return legacySystemSignalForPersonalReason(item, reasonCode);
}

function canReuseLegacyPersonalReminderKey(
  item: Pick<DiscordNotificationItem, "nodeId" | "current" | "personalReminderCauses">,
  signal: ReasonSignal,
  legacySignal: ReasonSignal,
): boolean {
  if (signal.source.kind !== "personal_reminder") {
    return false;
  }
  const context = signal.source.context;
  const input = item.personalReminderCauses.find(
    (candidate) => candidate.cause.causeId === context.causeId,
  );
  if (input?.cause.itemNodeId !== item.nodeId) {
    return false;
  }
  const { cause, staleness } = input;
  if (
    !personalReminderScopeIncludesItem(cause) ||
    cause.action.kind !== personalReminderActionKindForReason(cause.reasonCode) ||
    staleness.waitClass !== waitClassForTimeReasonCode(cause.reasonCode) ||
    staleness.waitClass !== item.current.waitClass ||
    signal.reason.reasonCode !== cause.reasonCode ||
    signal.severity !== item.current.severity ||
    signal.reason.threshold.status !== "recorded" ||
    legacySignal.reason.threshold.status !== "recorded" ||
    signal.reason.threshold.hours !== legacySignal.reason.threshold.hours
  ) {
    return false;
  }
  if (
    personalReminderResponsibleSignature(cause.responsible) !==
    waitingOnComparisonSignature(item.current.waitingOn)
  ) {
    return false;
  }
  if (
    context.actionableSince.source !== "event" ||
    context.stallSince.source !== "event" ||
    context.actionableSince.at !== responsibilityPeriodStart(item) ||
    context.stallSince.at !== item.current.stallSince
  ) {
    return false;
  }
  if (cause.actionableClock.status !== "observed") {
    return false;
  }
  return (
    cause.actionableClock.actionableSince.source === "event" &&
    cause.actionableClock.stallSince.source === "event" &&
    cause.actionableClock.actionableSince.at === context.actionableSince.at &&
    cause.actionableClock.stallSince.at === context.stallSince.at
  );
}

function personalReminderNotificationState(
  item: Pick<DiscordNotificationItem, "nodeId">,
  signal: ReasonSignal,
): string {
  if (signal.source.kind !== "personal_reminder") {
    throw new TypeError("個人催促通知のidentityにsystem理由を指定できません");
  }
  if (signal.reason.threshold.status !== "recorded") {
    throw new TypeError("個人催促通知のseverity閾値が未記録です");
  }
  const context = signal.source.context;
  return JSON.stringify([
    "personal-reminder-v1",
    item.nodeId,
    signal.reason.reasonCode,
    context.causeId,
    context.responsibilityId,
    normalizedResponsibilityForComparison(context.responsible),
    context.action.kind,
    context.actionableSince.at,
    context.stallSince.at,
    signal.severity,
    signal.reason.threshold.hours,
  ]);
}

function createNotificationKey(
  item: Pick<DiscordNotificationItem, "nodeId" | "current" | "personalReminderCauses">,
  signal: ReasonSignal,
): string {
  if (signal.source.kind === "personal_reminder") {
    const legacySignal = legacyOverdueSignalForPersonalReminder(item, signal);
    if (legacySignal != null && canReuseLegacyPersonalReminderKey(item, signal, legacySignal)) {
      return createNotificationKey(item, legacySignal);
    }
  }
  const state =
    signal.source.kind === "personal_reminder"
      ? personalReminderNotificationState(item, signal)
      : notificationState(item, signal);
  const stateHash = createHash("sha256").update(state).digest("hex");
  return `discord-notification:v1:${signal.reason.reasonCode}:${stateHash}`;
}

function assertSelectedReasonMatchesSignal(
  item: Pick<DiscordNotificationItem, "nodeId">,
  selectedReason: SelectedDiscordNotificationReason,
  expected: ReasonSignal,
): void {
  if (
    selectedReason.reasonCode !== expected.reason.reasonCode ||
    JSON.stringify(selectedReason.threshold) !== JSON.stringify(expected.reason.threshold) ||
    selectedReason.severity !== expected.severity ||
    JSON.stringify(selectedReason.source) !== JSON.stringify(expected.source)
  ) {
    throw new TypeError(`${item.nodeId}の通知理由が現在の判定結果と一致しません`);
  }
}

/** snapshotと現設定から再計算した個人催促理由を選択結果へ突合する。 */
export function assertDiscordPersonalReminderSelectionMatchesSnapshot(
  selection: DiscordNotificationSelection,
  items: readonly DiscordPersonalReminderSelectionValidationItem[],
): void {
  if (selection.action === "skip_digest") {
    return;
  }
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  if (itemsByNodeId.size !== items.length) {
    throw new TypeError("送信直前の個人催促検証対象node IDが重複しています");
  }
  for (const candidate of selection.candidates) {
    if (!candidate.reasons.some((reason) => reason.source.kind === "personal_reminder")) {
      continue;
    }
    const item = itemsByNodeId.get(candidate.itemNodeId);
    assertNonNullable(item, `${candidate.itemNodeId}の送信直前検証対象がありません`);
    const signalsByCauseId = new Map<string, ReasonSignal>();
    for (const signal of createPersonalReminderSignals(item)) {
      if (signal.source.kind !== "personal_reminder") {
        throw new TypeError("個人催促検証結果にsystem理由があります");
      }
      const causeId = signal.source.context.causeId;
      if (signalsByCauseId.has(causeId)) {
        throw new TypeError(`${causeId}の個人催促通知理由が重複しています`);
      }
      signalsByCauseId.set(causeId, signal);
    }
    for (const selectedReason of candidate.reasons) {
      if (selectedReason.source.kind !== "personal_reminder") {
        continue;
      }
      const expected = signalsByCauseId.get(selectedReason.source.context.causeId);
      assertNonNullable(
        expected,
        `${selectedReason.source.context.causeId}の個人催促判定結果が現在のsnapshotにありません`,
      );
      const expectedKey = createNotificationKey(item, expected);
      if (selectedReason.notificationKey !== expectedKey) {
        throw new TypeError(`${candidate.itemNodeId}の個人催促notification keyが一致しません`);
      }
      assertSelectedReasonMatchesSignal(item, selectedReason, expected);
    }
  }
}

function isEligibleAgainstLedger(
  item: DiscordNotificationItem,
  reason: ReasonSignal,
  notificationKey: string,
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  ledger: readonly NotificationLedgerEntry[],
  evaluatedTimestamp: number,
): boolean {
  const existing = ledgerByKey.get(notificationKey);
  if (existing != null) {
    if (existing.status === "reserved") {
      if (evaluatedTimestamp < parseTimestamp(existing.expiresAt, "ledgerの予約期限")) {
        return false;
      }
    } else {
      return false;
    }
  }
  if (reason.source.kind === "personal_reminder") {
    return true;
  }
  if (
    !isTimeNotificationReasonCode(reason.reason.reasonCode) &&
    reason.reason.reasonCode !== "owner_unknown"
  ) {
    return true;
  }
  const statusSinceTimestamp = parseTimestamp(
    item.current.statusSince,
    `${item.nodeId}のstatusSince`,
  );
  const ownerSinceTimestamp = parseTimestamp(item.current.ownerSince, `${item.nodeId}のownerSince`);
  const periodStartTimestamp = Math.max(statusSinceTimestamp, ownerSinceTimestamp);
  return !ledger.some((entry) => {
    if (
      entry.itemNodeId !== item.nodeId ||
      entry.reasonCode !== reason.reason.reasonCode ||
      entry.severity !== reason.severity ||
      parseTimestamp(entry.reservedAt, "ledgerの予約時刻") < periodStartTimestamp
    ) {
      return false;
    }
    if (entry.status === "reserved") {
      return evaluatedTimestamp < parseTimestamp(entry.expiresAt, "ledgerの予約期限");
    }
    return true;
  });
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
    case "work_overdue":
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

function createCurrentCandidateDrafts(
  input: SelectDiscordNotificationsInput,
  evaluatedTimestamp: number,
  ledgerByKey: ReadonlyMap<string, NotificationLedgerEntry>,
  ledger: readonly NotificationLedgerEntry[],
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
    const signalEntries = signals.map((signal) => {
      const notificationKey = createNotificationKey(item, signal);
      return Object.freeze({ signal, notificationKey });
    });
    const notificationKeys = signalEntries.map((entry) => entry.notificationKey);
    if (new Set(notificationKeys).size !== notificationKeys.length) {
      throw new TypeError(`${item.nodeId}の通知理由でnotificationKeyが衝突しています`);
    }
    const eligibleReasons = signalEntries
      .filter((entry) => !isReasonSuppressedByCause(item, entry.signal.reason.reasonCode))
      .map(({ signal, notificationKey }) => {
        return {
          signal,
          notificationKey,
          pendingNotification: createPendingNotification(
            item,
            signal,
            notificationKey,
            input.evaluatedAt,
          ),
        } satisfies EligibleReason;
      })
      .filter((reason) =>
        isEligibleAgainstLedger(
          item,
          reason.signal,
          reason.notificationKey,
          ledgerByKey,
          ledger,
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
  if (input.cause.actionableClock.status !== "observed") {
    return "hold";
  }
  if (!personalReminderPendingClockMatchesCurrent(input, pending)) {
    return "drop";
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
        existing?.notificationKey === reason.pendingNotification.notificationKey
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

function createPendingSelectionState(
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

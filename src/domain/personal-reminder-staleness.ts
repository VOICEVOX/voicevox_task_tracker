import { type LabelEffectsResolver } from "./label-resolution.js";
import {
  currentPersonalReminderAssessment,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderActionableClock,
  type PersonalReminderCause,
  type PersonalReminderCauseAssessment,
  type PersonalReminderCauseSeed,
  type PersonalReminderLastConfirmedActionability,
  type PersonalReminderTimeBasis,
} from "./personal-reminder-causes.js";
import {
  determineDirectSeverity,
  type DirectSeverityReason,
  type SeverityThresholds,
} from "./severity.js";
import { type Severity, type UtcIsoDateTime, type WaitClass } from "./types.js";

type PersonalReminderClockBasis = Extract<
  PersonalReminderActionableClock,
  { status: "observed" }
>["basis"];

/** 前回保存された個人催促原因時計。 */
export type PreviousPersonalReminderClockState =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: PersonalReminderActionableClock;
    }>;

/** 個人催促停滞の非通知理由。 */
export type PersonalReminderStalenessIneligibleReason =
  | "assessment_unavailable"
  | "assessment_not_actionable"
  | "clock_not_observed"
  | "confidence_below_threshold"
  | "notifications_suppressed";

/** 個人催促原因の停滞判定。 */
export type PersonalReminderStaleness =
  | Readonly<{
      status: "not_eligible";
      eligible: false;
      waitClass: WaitClass;
      reason: PersonalReminderStalenessIneligibleReason;
    }>
  | Readonly<{
      status: "eligible";
      eligible: true;
      waitClass: WaitClass;
      elapsedHours: number;
      severity: Severity;
      severityReason: DirectSeverityReason;
      actionableSince: PersonalReminderTimeBasis;
      stallSince: PersonalReminderTimeBasis;
    }>;

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function validateConfidence(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

function validateBasisAtOrBefore(
  basis: PersonalReminderTimeBasis,
  currentObservedAt: UtcIsoDateTime,
  context: string,
): void {
  if (parseTimestamp(basis.at, context) > parseTimestamp(currentObservedAt, "現在の観測時刻")) {
    throw new RangeError(`${context}は現在の観測時刻以前にしてください`);
  }
}

function waitClassForReason(cause: PersonalReminderCauseSeed): WaitClass {
  switch (cause.reasonCode) {
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

function assessmentIsActionable(
  assessment: CurrentPersonalReminderAssessment,
): assessment is Readonly<{
  status: "available";
  result: Extract<PersonalReminderCauseAssessment, { verdict: "actionable" }>;
}> {
  return assessment.status === "available" && assessment.result.verdict === "actionable";
}

/** 個人催促原因の有効な最新actionabilityを保存値へ反映する。 */
export function updatePersonalReminderLastConfirmedActionability(
  assessment: CurrentPersonalReminderAssessment,
  previous: PersonalReminderLastConfirmedActionability,
): PersonalReminderLastConfirmedActionability {
  if (assessment.status !== "available") {
    return previous;
  }
  switch (assessment.result.verdict) {
    case "actionable":
      return Object.freeze({ status: "confirmed", verdict: "actionable" });
    case "waiting":
      return Object.freeze({
        status: "confirmed",
        verdict: "waiting",
        waitingFor: assessment.result.waitingFor,
      });
    case "duplicate":
      return Object.freeze({
        status: "confirmed",
        verdict: "not_actionable",
        reason: "duplicate",
      });
    case "not_required":
      return Object.freeze({
        status: "confirmed",
        verdict: "not_actionable",
        reason: "not_required",
      });
    case "unknown":
      return previous;
  }
}

function sameBasis(left: PersonalReminderTimeBasis, right: PersonalReminderTimeBasis): boolean {
  if (left.source !== right.source || left.at !== right.at) {
    return false;
  }
  if (left.source === "first_observation" && right.source === "first_observation") {
    return true;
  }
  if (left.source !== "event" || right.source !== "event") {
    return false;
  }
  const leftSourceIds = [...left.sourceIds].sort();
  const rightSourceIds = [...right.sourceIds].sort();
  return (
    leftSourceIds.length === rightSourceIds.length &&
    leftSourceIds.every((sourceId, index) => sourceId === rightSourceIds[index])
  );
}

function sameBasisTime(left: PersonalReminderTimeBasis, right: PersonalReminderTimeBasis): boolean {
  return left.at === right.at;
}

function sameConfirmedWaitingActionability(
  value: PersonalReminderLastConfirmedActionability,
): boolean {
  return value.status === "confirmed" && value.verdict === "waiting";
}

function actionabilityClockBasis(
  actionabilityStart: PersonalReminderTimeBasis,
  obligationSince: PersonalReminderTimeBasis,
): PersonalReminderClockBasis {
  if (actionabilityStart.source === "first_observation") {
    return "first_observation";
  }
  if (sameBasis(actionabilityStart, obligationSince)) {
    return "obligation";
  }
  return "dependency_resolved";
}

function mergeEqualTimeBases(
  left: PersonalReminderTimeBasis,
  right: PersonalReminderTimeBasis,
): PersonalReminderTimeBasis {
  if (!sameBasisTime(left, right)) {
    throw new TypeError("異なる時刻のbasisを結合できません");
  }
  if (left.source === "event" && right.source === "event") {
    const sourceIds = [...new Set([...left.sourceIds, ...right.sourceIds])].sort();
    return {
      source: "event",
      at: left.at,
      sourceIds,
    };
  }
  if (left.source === "event") {
    return left;
  }
  if (right.source === "event") {
    return right;
  }
  return left;
}

function latestBasis(values: readonly PersonalReminderTimeBasis[]): PersonalReminderTimeBasis {
  const first = values[0];
  if (first == null) {
    throw new TypeError("個人催促時計のbasisが1件もありません");
  }
  let latest = first;
  for (const value of values.slice(1)) {
    const latestTimestamp = parseTimestamp(latest.at, "個人催促時計のbasis時刻");
    const valueTimestamp = parseTimestamp(value.at, "個人催促時計のbasis時刻");
    if (valueTimestamp > latestTimestamp) {
      latest = value;
    } else if (valueTimestamp === latestTimestamp) {
      latest = mergeEqualTimeBases(latest, value);
    }
  }
  return latest;
}

function observedClock(
  actionableSince: PersonalReminderTimeBasis,
  stallSince: PersonalReminderTimeBasis,
  basis: PersonalReminderClockBasis,
): PersonalReminderActionableClock {
  return {
    status: "observed",
    actionableSince,
    stallSince,
    basis,
  };
}

function selectActionableSince(
  input: Readonly<{
    cause: PersonalReminderCauseSeed;
    previous: PreviousPersonalReminderClockState;
    actionabilityStart: PersonalReminderTimeBasis | undefined;
  }>,
): Readonly<{
  actionableSince: PersonalReminderTimeBasis;
  basis: PersonalReminderClockBasis;
}> {
  if (
    input.previous.availability === "available" &&
    input.previous.value.status === "observed" &&
    !sameConfirmedWaitingActionability(input.cause.lastConfirmedActionability)
  ) {
    return Object.freeze({
      actionableSince: input.previous.value.actionableSince,
      basis: input.previous.value.basis,
    });
  }
  if (input.actionabilityStart == null) {
    throw new TypeError("実行可能時刻の起点がありません");
  }
  const basis = actionabilityClockBasis(input.actionabilityStart, input.cause.obligationSince);
  return Object.freeze({
    actionableSince: input.actionabilityStart,
    basis,
  });
}

/** 個人催促原因の実行可能性時計を更新する。 */
export function updatePersonalReminderActionableClock(
  input: Readonly<{
    cause: PersonalReminderCauseSeed;
    assessment: CurrentPersonalReminderAssessment;
    previous: PreviousPersonalReminderClockState;
    actionabilityStart: PersonalReminderTimeBasis | undefined;
    relevantProgress: readonly PersonalReminderTimeBasis[];
    responsibleActivity: readonly PersonalReminderTimeBasis[];
    humanReviewActivity: readonly PersonalReminderTimeBasis[];
    currentObservedAt: UtcIsoDateTime;
  }>,
): PersonalReminderActionableClock {
  const currentObservedTimestamp = parseTimestamp(input.currentObservedAt, "現在の観測時刻");
  validateBasisAtOrBefore(input.cause.obligationSince, input.currentObservedAt, "義務時刻");
  if (input.actionabilityStart != null) {
    validateBasisAtOrBefore(input.actionabilityStart, input.currentObservedAt, "実行可能時刻");
  }
  for (const basis of [
    ...input.relevantProgress,
    ...input.responsibleActivity,
    ...input.humanReviewActivity,
  ]) {
    validateBasisAtOrBefore(basis, input.currentObservedAt, "個人催促活動時刻");
  }
  if (!assessmentIsActionable(input.assessment)) {
    if (input.previous.availability === "available") {
      return input.previous.value;
    }
    return { status: "not_observed" };
  }

  const selected = selectActionableSince({
    cause: input.cause,
    previous: input.previous,
    actionabilityStart: input.actionabilityStart,
  });
  validateBasisAtOrBefore(selected.actionableSince, input.currentObservedAt, "実行可能時刻");
  const stallCandidates = [
    selected.actionableSince,
    ...(input.previous.availability === "available" && input.previous.value.status === "observed"
      ? [input.previous.value.stallSince]
      : []),
    ...input.relevantProgress,
    ...input.responsibleActivity,
    ...(input.cause.action.kind === "review" ? input.humanReviewActivity : []),
  ];
  const stallSince = latestBasis(stallCandidates);
  if (parseTimestamp(stallSince.at, "停滞時刻") > currentObservedTimestamp) {
    throw new RangeError("停滞時刻は現在の観測時刻以前にしてください");
  }
  return observedClock(selected.actionableSince, stallSince, selected.basis);
}

function ineligible(
  waitClass: WaitClass,
  reason: PersonalReminderStalenessIneligibleReason,
): PersonalReminderStaleness {
  return Object.freeze({
    status: "not_eligible",
    eligible: false,
    waitClass,
    reason,
  });
}

/** 個人催促原因の時計と閾値から現在の停滞severityを算出する。 */
export function calculatePersonalReminderStaleness(
  input: Readonly<{
    cause: PersonalReminderCause;
    evaluatedAt: UtcIsoDateTime;
    minimumAiConfidence: number;
    repositoryFullName: string;
    currentLabels: readonly string[];
    resolveLabelEffects: LabelEffectsResolver;
    thresholdsHours: SeverityThresholds;
  }>,
): PersonalReminderStaleness {
  const waitClass = waitClassForReason(input.cause);
  validateConfidence(input.minimumAiConfidence, "AI判定の最低confidence");
  if (input.repositoryFullName.length === 0) {
    throw new TypeError("repository full nameは空にできません");
  }
  const assessment = currentPersonalReminderAssessment(input.cause);
  if (assessment.status !== "available") {
    return ineligible(waitClass, "assessment_unavailable");
  }
  if (assessment.result.verdict !== "actionable") {
    return ineligible(waitClass, "assessment_not_actionable");
  }
  if (assessment.result.confidence < input.minimumAiConfidence) {
    return ineligible(waitClass, "confidence_below_threshold");
  }
  const labelEffects = input.resolveLabelEffects(input.repositoryFullName, input.currentLabels);
  if (labelEffects.suppressNotifications) {
    return ineligible(waitClass, "notifications_suppressed");
  }
  if (input.cause.actionableClock.status !== "observed") {
    return ineligible(waitClass, "clock_not_observed");
  }
  const evaluatedTimestamp = parseTimestamp(input.evaluatedAt, "評価時刻");
  const stallTimestamp = parseTimestamp(input.cause.actionableClock.stallSince.at, "停滞時刻");
  if (stallTimestamp > evaluatedTimestamp) {
    throw new RangeError("停滞時刻は評価時刻以前にしてください");
  }
  const elapsedHours = (evaluatedTimestamp - stallTimestamp) / (60 * 60 * 1000);
  const severity = determineDirectSeverity({
    waitClass,
    elapsedHours,
    thresholdsHours: input.thresholdsHours,
    severityLift: labelEffects.severityLift,
    criticalAllowed: true,
  });
  return Object.freeze({
    status: "eligible",
    eligible: true,
    waitClass,
    elapsedHours,
    severity: severity.severity,
    severityReason: severity.reason,
    actionableSince: input.cause.actionableClock.actionableSince,
    stallSince: input.cause.actionableClock.stallSince,
  });
}

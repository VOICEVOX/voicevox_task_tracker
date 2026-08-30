import { type LabelEffectsResolver } from "./label-resolution.js";
import {
  determineMeaningfulProgress,
  isExcludedFromProgressAndHumanActivity,
  type DependencyResolutionProgress,
  type MeaningfulProgress,
  type NaturalLanguageProgressAssessment,
  type NaturalLanguageProgressCandidate,
  type PreviousActivityState,
} from "./meaningful-progress.js";
import {
  compareSeverity,
  determineDirectSeverity,
  type CrossedSeverityThreshold,
  type DirectSeverityReason,
  type SeverityThresholds,
} from "./severity.js";
import { type SourceId } from "./source-id.js";
import { isTerminalStatus } from "./status.js";
import {
  type NormalizedEvent,
  type Severity,
  type Status,
  type UtcIsoDateTime,
  type WaitClass,
  type WaitingOn,
} from "./types.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/**
 * 状態機械が返すstatusまたは責務の遷移根拠。
 * eventはGitHubイベント時刻そのものを表し、inferredはGitHub由来の時刻から決定論的に導いた下限を表す。
 */
export type StalenessTransitionBasis = Readonly<{
  sourceIds: readonly [SourceId, ...SourceId[]];
  occurredAt: UtcIsoDateTime;
  precision: "event" | "inferred";
}>;

/** 停滞時間の算出に必要な状態機械の判定結果。 */
export type StateDecisionForStaleness = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  confidence: number;
  statusBasis: StalenessTransitionBasis;
  responsibilityBasis: StalenessTransitionBasis;
}>;

/** 次回判定との比較に保存する停滞時刻の状態。 */
export type StalenessState = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  statusSince: UtcIsoDateTime;
  ownerSince: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
  lastProgressAt: UtcIsoDateTime;
  lastHumanActivityAt: UtcIsoDateTime;
}>;

/** 初回判定または前回の停滞時刻状態。 */
export type PreviousStalenessState =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: StalenessState;
    }>;

/** blocked親の代わりに通知順位へ使うblocker情報。 */
export type BlockerRanking = Readonly<{
  candidateId: string;
  severity: Severity;
  downstreamImpact: number;
}>;

/** blocked親に対して依存グラフから受け取る通知順位情報。 */
export type BlockedParentContext =
  | Readonly<{
      status: "not_applicable";
    }>
  | Readonly<{
      status: "available";
      blockers: readonly [BlockerRanking, ...BlockerRanking[]];
    }>;

/** 停滞判定で表示する待機分類。 */
export type StalenessWaitClass = WaitClass | "blockedParent" | "notApplicable";

/** severity再計算時に引き継ぐwait classと状態判定の根拠。 */
export type StalenessSeverityContext = Readonly<{
  waitClass: StalenessWaitClass;
  decisionBasis: "deterministic" | "ai_only";
}>;

/** blocked親自身をseverity計時しない根拠。 */
export type BlockedParentSeverityReason = Readonly<{
  kind: "blocked_parent";
  blockerRanking: readonly BlockerRanking[];
  summary: string;
}>;

/** terminal項目をseverity計時しない根拠。 */
export type TerminalSeverityReason = Readonly<{
  kind: "terminal";
  summary: string;
}>;

/** severityを決定した閾値、ラベル効果、または計時対象外の根拠。 */
export type StalenessSeverityReason =
  DirectSeverityReason | BlockedParentSeverityReason | TerminalSeverityReason;

/** 通知選別へ渡すseverity判定の時間根拠。 */
export type StalenessNotificationSeverityReason =
  | Readonly<{
      kind: "elapsed_threshold";
      waitClass: WaitClass;
      elapsedHours: number;
      crossedThreshold: CrossedSeverityThreshold;
    }>
  | Readonly<{
      kind: "not_applicable";
      waitClass: "blockedParent" | "notApplicable";
    }>;

/** status、責務、停滞の連続経過時間。 */
export type StalenessElapsedHours = Readonly<{
  status: number;
  owner: number;
  stall: number;
}>;

/** 停滞時間とseverityを算出する入力。 */
export type CalculateStalenessInput = Readonly<{
  createdAt: UtcIsoDateTime;
  evaluatedAt: UtcIsoDateTime;
  currentDecision: StateDecisionForStaleness;
  decisionBasis: StalenessSeverityContext["decisionBasis"];
  previousState: PreviousStalenessState;
  events: readonly NormalizedEvent[];
  responsibleAccountIdentifiers: ReadonlySet<string>;
  dependencyResolutions: readonly DependencyResolutionProgress[];
  naturalLanguageAssessments: readonly NaturalLanguageProgressAssessment[];
  minimumAiConfidence: number;
  repositoryFullName: string;
  currentLabels: readonly string[];
  resolveLabelEffects: LabelEffectsResolver;
  thresholdsHours: SeverityThresholds;
  blockedParentContext: BlockedParentContext;
}>;

/** 保存済みの停滞起点からseverityだけを再計算する入力。 */
export type RecalculateStalenessSeverityInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
  confidence: number;
  minimumAiConfidence: number;
  repositoryFullName: string;
  currentLabels: readonly string[];
  resolveLabelEffects: LabelEffectsResolver;
  thresholdsHours: SeverityThresholds;
  severityContext: StalenessSeverityContext;
}>;

/** run時刻まで進めた停滞時間とseverity。 */
export type RecalculatedStalenessSeverity = Readonly<{
  elapsedHours: number;
  waitClass: StalenessWaitClass;
  severity: Severity;
  severityReason: StalenessNotificationSeverityReason;
  severityContext: StalenessSeverityContext;
}>;

/** 各時刻、連続経過時間、wait class、severityと根拠。 */
export type StalenessResult = StalenessState &
  Readonly<{
    elapsedHours: StalenessElapsedHours;
    waitClass: StalenessWaitClass;
    severity: Severity;
    severityReason: StalenessSeverityReason;
    severityContext: StalenessSeverityContext;
    meaningfulProgress: readonly MeaningfulProgress[];
    naturalLanguageProgressCandidates: readonly NaturalLanguageProgressCandidate[];
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

function validateStatusAndWaitingOn(
  status: Status,
  waitingOnValues: readonly WaitingOn[],
  context: string,
): void {
  if (isTerminalStatus(status) && waitingOnValues.length !== 0) {
    throw new TypeError(`${context}のterminal状態にはwaitingOnを設定できません`);
  }
  if (!isTerminalStatus(status) && waitingOnValues.length === 0) {
    throw new TypeError(`${context}の継続中状態にはwaitingOnが1件以上必要です`);
  }

  const entityKeys = new Set<string>();
  for (const waitingOn of waitingOnValues) {
    const key = `${waitingOn.kind}\u0000${waitingOn.candidateId}\u0000${waitingOn.role}`;
    if (entityKeys.has(key)) {
      throw new TypeError(`${context}のwaitingOn実体が重複しています`);
    }
    entityKeys.add(key);
  }
}

function validateBlockedParentContext(input: CalculateStalenessInput): void {
  const isBlocked = input.currentDecision.status === "waiting_for_unblock";
  if (!isBlocked && input.blockedParentContext.status !== "not_applicable") {
    throw new TypeError("waiting_for_unblock以外の項目にblocked parent情報は設定できません");
  }
  if (isBlocked && input.blockedParentContext.status !== "available") {
    throw new TypeError(
      "waiting_for_unblock項目にはblockerのseverityとdownstream impactが必要です",
    );
  }
  if (input.blockedParentContext.status !== "available") {
    return;
  }

  const waitingOnCandidateIds = new Set(
    input.currentDecision.waitingOn.map((waitingOn) => waitingOn.candidateId),
  );
  const blockerCandidateIds = new Set<string>();
  for (const blocker of input.blockedParentContext.blockers) {
    if (blocker.candidateId.length === 0) {
      throw new TypeError("blockerのcandidate IDは空にできません");
    }
    if (blockerCandidateIds.has(blocker.candidateId)) {
      throw new TypeError(`blockerの通知順位情報が重複しています。対象: ${blocker.candidateId}`);
    }
    if (!waitingOnCandidateIds.has(blocker.candidateId)) {
      throw new TypeError(
        `blockerの通知順位情報がwaitingOnにない項目を参照しています。対象: ${blocker.candidateId}`,
      );
    }
    if (!Number.isSafeInteger(blocker.downstreamImpact) || blocker.downstreamImpact < 0) {
      throw new RangeError("downstream impactは0以上の安全な整数にしてください");
    }
    blockerCandidateIds.add(blocker.candidateId);
  }
  if (
    blockerCandidateIds.size !== waitingOnCandidateIds.size ||
    [...waitingOnCandidateIds].some((candidateId) => !blockerCandidateIds.has(candidateId))
  ) {
    throw new TypeError("blocked項目のwaitingOnとblocker通知順位情報が一致しません");
  }
}

function validateTimestampRange(
  value: UtcIsoDateTime,
  context: string,
  createdAt: number,
  evaluatedAt: number,
): void {
  const timestamp = parseTimestamp(value, context);
  if (timestamp < createdAt || timestamp > evaluatedAt) {
    throw new RangeError(`${context}は項目作成時刻以後かつ判定時刻以前にしてください`);
  }
}

function validateInput(input: CalculateStalenessInput): void {
  const createdAt = parseTimestamp(input.createdAt, "項目作成時刻");
  const evaluatedAt = parseTimestamp(input.evaluatedAt, "判定時刻");
  if (createdAt > evaluatedAt) {
    throw new RangeError("項目作成時刻は判定時刻以前にしてください");
  }
  validateConfidence(input.currentDecision.confidence, "状態判定のconfidence");
  validateConfidence(input.minimumAiConfidence, "AI判定の最低confidence");
  validateStatusAndWaitingOn(
    input.currentDecision.status,
    input.currentDecision.waitingOn,
    "今回判定",
  );

  validateTimestampRange(
    input.currentDecision.statusBasis.occurredAt,
    "status遷移根拠の時刻",
    createdAt,
    evaluatedAt,
  );
  validateTimestampRange(
    input.currentDecision.responsibilityBasis.occurredAt,
    "責務遷移根拠の時刻",
    createdAt,
    evaluatedAt,
  );

  if (input.previousState.availability === "available") {
    validateStatusAndWaitingOn(
      input.previousState.value.status,
      input.previousState.value.waitingOn,
      "前回状態",
    );
    validateTimestampRange(
      input.previousState.value.statusSince,
      "前回statusSince",
      createdAt,
      evaluatedAt,
    );
    validateTimestampRange(
      input.previousState.value.ownerSince,
      "前回ownerSince",
      createdAt,
      evaluatedAt,
    );
    validateTimestampRange(
      input.previousState.value.stallSince,
      "前回stallSince",
      createdAt,
      evaluatedAt,
    );
    validateTimestampRange(
      input.previousState.value.lastProgressAt,
      "前回lastProgressAt",
      createdAt,
      evaluatedAt,
    );
    validateTimestampRange(
      input.previousState.value.lastHumanActivityAt,
      "前回lastHumanActivityAt",
      createdAt,
      evaluatedAt,
    );
  }
  validateBlockedParentContext(input);
}

function sameWaitingOnEntities(left: readonly WaitingOn[], right: readonly WaitingOn[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((waitingOn, index) => {
    const other = right[index];
    assertNonNullable(other, "比較対象のwaitingOnがありません");
    return (
      waitingOn.kind === other.kind &&
      waitingOn.candidateId === other.candidateId &&
      waitingOn.role === other.role
    );
  });
}

function latestTimestamp(values: readonly UtcIsoDateTime[]): UtcIsoDateTime {
  const first = values[0];
  assertNonNullable(first, "比較する時刻が1件もありません");
  let latest = first;
  for (const value of values.slice(1)) {
    if (value > latest) {
      latest = value;
    }
  }
  return latest;
}

function determineLastResponsibleHumanActivityAt(
  input: CalculateStalenessInput,
): UtcIsoDateTime | undefined {
  const responsibleActivityTimes = input.events
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        (input.responsibleAccountIdentifiers.has(event.actor.login) ||
          input.responsibleAccountIdentifiers.has(event.actor.nodeId)),
    )
    .map((event) => event.occurredAt);
  return responsibleActivityTimes.length === 0
    ? undefined
    : latestTimestamp(responsibleActivityTimes);
}

function determineTransitionTimes(
  input: CalculateStalenessInput,
  lastProgressAt: UtcIsoDateTime,
  lastResponsibleHumanActivityAt: UtcIsoDateTime | undefined,
): Readonly<{
  statusSince: UtcIsoDateTime;
  ownerSince: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
}> {
  if (input.previousState.availability === "not_available") {
    const ownerSince = latestTimestamp([
      input.currentDecision.statusBasis.occurredAt,
      input.currentDecision.responsibilityBasis.occurredAt,
    ]);
    return Object.freeze({
      statusSince: input.currentDecision.statusBasis.occurredAt,
      ownerSince,
      stallSince: latestTimestamp([
        ownerSince,
        lastProgressAt,
        ...(lastResponsibleHumanActivityAt == null ? [] : [lastResponsibleHumanActivityAt]),
      ]),
    });
  }

  const previous = input.previousState.value;
  const statusChanged = previous.status !== input.currentDecision.status;
  const responsibilityChanged = !sameWaitingOnEntities(
    previous.waitingOn,
    input.currentDecision.waitingOn,
  );
  const statusSince = statusChanged
    ? input.currentDecision.statusBasis.occurredAt
    : previous.statusSince;
  let ownerSince = previous.ownerSince;
  if (statusChanged && responsibilityChanged) {
    ownerSince = latestTimestamp([
      input.currentDecision.statusBasis.occurredAt,
      input.currentDecision.responsibilityBasis.occurredAt,
    ]);
  } else if (statusChanged) {
    ownerSince = input.currentDecision.statusBasis.occurredAt;
  } else if (responsibilityChanged) {
    ownerSince = input.currentDecision.responsibilityBasis.occurredAt;
  }

  return Object.freeze({
    statusSince,
    ownerSince,
    stallSince: latestTimestamp([
      ownerSince,
      lastProgressAt,
      ...(lastResponsibleHumanActivityAt == null ? [] : [lastResponsibleHumanActivityAt]),
      ...(statusChanged || responsibilityChanged ? [] : [previous.stallSince]),
    ]),
  });
}

function isAuthorAfterChangesRequested(
  decision: StateDecisionForStaleness,
  events: readonly NormalizedEvent[],
): boolean {
  const basisSourceIds = new Set(decision.responsibilityBasis.sourceIds);
  return events.some(
    (event) =>
      event.kind === "review" &&
      event.actor.type === "human" &&
      event.state === "changes_requested" &&
      basisSourceIds.has(event.sourceId),
  );
}

function determineWaitClass(
  decision: StateDecisionForStaleness,
  events: readonly NormalizedEvent[],
): StalenessWaitClass {
  if (isTerminalStatus(decision.status)) {
    return "notApplicable";
  }
  if (decision.status === "waiting_for_unblock") {
    return "blockedParent";
  }

  const primaryWaitingOn = decision.waitingOn[0];
  assertNonNullable(primaryWaitingOn, "継続中状態のprimary waitingOnがありません");
  if (primaryWaitingOn.kind === "unknown" || primaryWaitingOn.role === "unknown") {
    return "owner";
  }
  if (decision.status === "waiting_for_merge") {
    return "merge";
  }
  if (decision.status === "waiting_for_automation" || primaryWaitingOn.kind === "automation") {
    return "automation";
  }
  if (decision.status === "waiting_for_review" || primaryWaitingOn.role === "reviewer") {
    return "review";
  }
  if (decision.status === "waiting_for_revision") {
    return isAuthorAfterChangesRequested(decision, events) ? "revision" : "work";
  }
  if (decision.status === "waiting_for_reply") {
    return "reply";
  }

  switch (decision.status) {
    case "waiting_for_assessment":
      return "assessment";
    case "waiting_for_owner":
      return "owner";
    case "waiting_for_decision":
      return "decision";
    case "waiting_for_work":
    case "in_progress":
      return "work";
    case "unknown":
      return "owner";
    default:
      throw new UnreachableError(decision.status);
  }
}

function elapsedHours(since: UtcIsoDateTime, evaluatedAt: UtcIsoDateTime): number {
  const elapsed =
    (parseTimestamp(evaluatedAt, "判定時刻") - parseTimestamp(since, "経過時間の起点")) /
    MILLISECONDS_PER_HOUR;
  if (elapsed < 0) {
    throw new RangeError("経過時間の起点は判定時刻以前にしてください");
  }
  return elapsed;
}

function compareBlockerRanking(left: BlockerRanking, right: BlockerRanking): -1 | 0 | 1 {
  const severityComparison = compareSeverity(right.severity, left.severity);
  if (severityComparison !== 0) {
    return severityComparison;
  }
  if (left.downstreamImpact !== right.downstreamImpact) {
    return left.downstreamImpact > right.downstreamImpact ? -1 : 1;
  }
  if (left.candidateId < right.candidateId) {
    return -1;
  }
  if (left.candidateId > right.candidateId) {
    return 1;
  }
  return 0;
}

function determineSeverity(
  input: CalculateStalenessInput,
  severityContext: StalenessSeverityContext,
  stallElapsedHours: number,
): Readonly<{
  severity: Severity;
  severityReason: StalenessSeverityReason;
}> {
  const waitClass = severityContext.waitClass;
  if (waitClass === "notApplicable") {
    return Object.freeze({
      severity: "none",
      severityReason: Object.freeze({
        kind: "terminal",
        summary: "terminal項目は停滞severityの計時対象外です",
      }),
    });
  }
  if (waitClass === "blockedParent") {
    if (input.blockedParentContext.status !== "available") {
      throw new TypeError("blocked parentの通知順位情報がありません");
    }
    const blockerRanking = Object.freeze(
      [...input.blockedParentContext.blockers].sort(compareBlockerRanking),
    );
    return Object.freeze({
      severity: "none",
      severityReason: Object.freeze({
        kind: "blocked_parent",
        blockerRanking,
        summary:
          "blocked親自身の経過時間ではseverityを上げず、blockerのseverityとdownstream impactを通知順位へ使います",
      }),
    });
  }

  const labelEffects = input.resolveLabelEffects(input.repositoryFullName, input.currentLabels);
  const criticalAllowed =
    severityContext.decisionBasis === "deterministic" ||
    input.currentDecision.confidence >= input.minimumAiConfidence;
  const decision = determineDirectSeverity({
    waitClass,
    elapsedHours: stallElapsedHours,
    thresholdsHours: input.thresholdsHours,
    severityLift: labelEffects.severityLift,
    criticalAllowed,
  });
  return Object.freeze({
    severity: decision.severity,
    severityReason: decision.reason,
  });
}

/** stalenessのseverity根拠から通知選別に必要な情報だけを取り出す。 */
export function createStalenessNotificationSeverityReason(
  reason: StalenessSeverityReason,
): StalenessNotificationSeverityReason {
  switch (reason.kind) {
    case "elapsed_threshold":
      return Object.freeze({
        kind: "elapsed_threshold",
        waitClass: reason.waitClass,
        elapsedHours: reason.elapsedHours,
        crossedThreshold: reason.crossedThreshold,
      });
    case "blocked_parent":
      return Object.freeze({
        kind: "not_applicable",
        waitClass: "blockedParent",
      });
    case "terminal":
      return Object.freeze({
        kind: "not_applicable",
        waitClass: "notApplicable",
      });
  }
}

function createSeverityContext(
  input: CalculateStalenessInput,
  waitClass: StalenessWaitClass,
): StalenessSeverityContext {
  return Object.freeze({
    waitClass,
    decisionBasis: input.decisionBasis,
  });
}

/** 保存済みのseverity算出条件を使い、run時刻基準でseverityを再計算する。 */
export function recalculateStalenessSeverity(
  input: RecalculateStalenessSeverityInput,
): RecalculatedStalenessSeverity {
  validateConfidence(input.confidence, "状態判定のconfidence");
  validateConfidence(input.minimumAiConfidence, "AI判定の最低confidence");
  const elapsed = elapsedHours(input.stallSince, input.evaluatedAt);
  const waitClass = input.severityContext.waitClass;
  if (waitClass === "notApplicable" || waitClass === "blockedParent") {
    return Object.freeze({
      elapsedHours: elapsed,
      waitClass,
      severity: "none",
      severityReason: Object.freeze({
        kind: "not_applicable",
        waitClass,
      }),
      severityContext: input.severityContext,
    });
  }

  const labelEffects = input.resolveLabelEffects(input.repositoryFullName, input.currentLabels);
  const decision = determineDirectSeverity({
    waitClass,
    elapsedHours: elapsed,
    thresholdsHours: input.thresholdsHours,
    severityLift: labelEffects.severityLift,
    criticalAllowed:
      input.severityContext.decisionBasis === "deterministic" ||
      input.confidence >= input.minimumAiConfidence,
  });
  return Object.freeze({
    elapsedHours: elapsed,
    waitClass,
    severity: decision.severity,
    severityReason: createStalenessNotificationSeverityReason(decision.reason),
    severityContext: input.severityContext,
  });
}

function createPreviousActivityState(previousState: PreviousStalenessState): PreviousActivityState {
  if (previousState.availability === "not_available") {
    return Object.freeze({
      status: "not_available",
    });
  }
  return Object.freeze({
    status: "available",
    lastProgressAt: previousState.value.lastProgressAt,
    lastHumanActivityAt: previousState.value.lastHumanActivityAt,
  });
}

/** 前回状態、状態機械の遷移根拠、進捗イベントから停滞時間とseverityを算出する。 */
export function calculateStaleness(input: CalculateStalenessInput): StalenessResult {
  validateInput(input);
  const progress = determineMeaningfulProgress({
    createdAt: input.createdAt,
    evaluatedAt: input.evaluatedAt,
    events: input.events,
    dependencyResolutions: input.dependencyResolutions,
    naturalLanguageAssessments: input.naturalLanguageAssessments,
    minimumAiConfidence: input.minimumAiConfidence,
    previousActivity: createPreviousActivityState(input.previousState),
    repositoryFullName: input.repositoryFullName,
    resolveLabelEffects: input.resolveLabelEffects,
  });
  const transitionTimes = determineTransitionTimes(
    input,
    progress.lastProgressAt,
    determineLastResponsibleHumanActivityAt(input),
  );
  const elapsed = Object.freeze({
    status: elapsedHours(transitionTimes.statusSince, input.evaluatedAt),
    owner: elapsedHours(transitionTimes.ownerSince, input.evaluatedAt),
    stall: elapsedHours(transitionTimes.stallSince, input.evaluatedAt),
  });
  const waitClass = determineWaitClass(input.currentDecision, input.events);
  const severityContext = createSeverityContext(input, waitClass);
  const severity = determineSeverity(input, severityContext, elapsed.stall);

  return Object.freeze({
    status: input.currentDecision.status,
    waitingOn: Object.freeze([...input.currentDecision.waitingOn]),
    lastProgressAt: progress.lastProgressAt,
    lastHumanActivityAt: progress.lastHumanActivityAt,
    statusSince: transitionTimes.statusSince,
    ownerSince: transitionTimes.ownerSince,
    stallSince: transitionTimes.stallSince,
    elapsedHours: elapsed,
    waitClass,
    severity: severity.severity,
    severityReason: severity.severityReason,
    severityContext,
    meaningfulProgress: progress.progress,
    naturalLanguageProgressCandidates: progress.naturalLanguageCandidates,
  });
}

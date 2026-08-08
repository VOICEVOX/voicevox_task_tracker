import { z } from "zod";

import { type FreshObservedGitHubIssue } from "./github-item-observation.js";
import { type SourceId } from "./source-id.js";
import { isTerminalStatus } from "./status.js";
import { resolveRepositoryRoleWaitingOn, type ResolvedRepositoryTeams } from "./team-resolution.js";
import {
  type Evidence,
  type EvidenceSupport,
  type GitHubAccountActor,
  type NormalizedEvent,
  type PrimaryWaitingOn,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
  type WaitingOnRole,
} from "./types.js";
import { assertNonNullable } from "../util/index.js";

const confidenceSchema = z.number().min(0).max(1);

/** Issue判定へ適用した決定規則のversion。 */
export const ISSUE_DETERMINISTIC_RULES_VERSION = "issue-v8";

/** 依存グラフからIssue判定へ渡すblocker。 */
export type IssueBlocker = Readonly<{
  candidateId: string;
  state: "open" | "closed" | "merged";
  authority: "authoritative" | "inferred";
  confidence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
  becameBlockingAt: UtcIsoDateTime;
}>;

/** 決定論的な抽出で見つけた明示依頼らしき候補。 */
export type IssueExplicitRequestCandidate = Readonly<{
  sourceId: SourceId;
  occurredAt: UtcIsoDateTime;
}>;

/** 検証済みの外部判定が明示依頼の相手として返す候補。 */
export type IssueExplicitRequestTarget = Readonly<{
  kind: "user" | "team" | "role";
  candidateId: string;
  role: Exclude<WaitingOnRole, "dependency" | "merge_decider" | "ci">;
  sourceIds: readonly [SourceId, ...SourceId[]];
  confidence: number;
}>;

/** 明示依頼候補に対する検証済みの外部判定。 */
export type IssueExplicitRequestAssessment =
  | Readonly<{
      status: "not_assessed";
    }>
  | Readonly<{
      status: "assessed";
      candidateSourceIds: readonly [SourceId, ...SourceId[]];
      verdict: "no_unanswered_request";
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>
  | Readonly<{
      status: "assessed";
      candidateSourceIds: readonly [SourceId, ...SourceId[]];
      verdict: "unanswered_request";
      requestSourceId: SourceId;
      targets: readonly [IssueExplicitRequestTarget, ...IssueExplicitRequestTarget[]];
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** Issue状態機械へ渡す設定解決済み入力。 */
export type IssueStateMachineInput = Readonly<{
  issue: FreshObservedGitHubIssue;
  blockers: readonly IssueBlocker[];
  explicitRequestCandidates: readonly IssueExplicitRequestCandidate[];
  explicitRequestAssessment: IssueExplicitRequestAssessment;
  teams: ResolvedRepositoryTeams;
  confidenceThresholds: Readonly<{
    high: number;
    medium: number;
  }>;
  evaluatedAt: UtcIsoDateTime;
}>;

/**
 * statusまたは責務を生じさせた時刻と根拠。
 * eventはGitHubイベント時刻そのものを表し、inferredはGitHub由来の時刻から決定論的に導いた下限を表す。
 */
export type IssueTransitionBasis = Readonly<{
  sourceIds: readonly [SourceId, ...SourceId[]];
  occurredAt: UtcIsoDateTime;
  precision: "event" | "inferred";
}>;

/** primary waitingOnの選定結果。 */
export type IssuePrimaryWaitingOn = PrimaryWaitingOn;

/** 決定論的なIssue状態機械の判定結果。 */
export type IssueStateDecision = Readonly<{
  deterministicRulesVersion: typeof ISSUE_DETERMINISTIC_RULES_VERSION;
  evaluatedAt: UtcIsoDateTime;
  determination: "determined" | "codex_candidate";
  status: Status;
  waitingOn: readonly WaitingOn[];
  primaryWaitingOn: IssuePrimaryWaitingOn;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
  statusBasis: IssueTransitionBasis;
  responsibilityBasis: IssueTransitionBasis;
}>;

type DecisionDraft = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  primarySelectionReason: string;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  statusBasis: IssueTransitionBasis;
  responsibilityBasis: IssueTransitionBasis;
}>;

interface DecisionContext {
  uncertainties: string[];
  evidence: Evidence[];
  confidenceCap: number;
}

type ResolvedAssignee = Readonly<{
  waitingOn: WaitingOn;
  basis: IssueTransitionBasis;
}>;

type AssigneeEvent = Extract<NormalizedEvent, { kind: "assignee" }>;

type AssigneeEventReplay = Readonly<{
  activeAssignmentByAssigneeNodeId: ReadonlyMap<GitHubAccountActor["nodeId"], AssigneeEvent>;
  lastUnassignedEvent: AssigneeEvent | undefined;
}>;

function validateConfidence(value: number, context: string): void {
  const result = confidenceSchema.safeParse(value);
  if (!result.success) {
    throw new RangeError(`${context}は0以上1以下にしてください`, { cause: result.error });
  }
}

function validateSourceIds(sourceIds: readonly SourceId[], context: string): void {
  if (sourceIds.length === 0) {
    throw new TypeError(`${context}にはsource IDが1件以上必要です`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError(`${context}のsource IDが重複しています`);
  }
}

function validateTeamNodeIdList(teams: ResolvedRepositoryTeams["maintainers"], role: string): void {
  if (teams.length === 0) {
    throw new TypeError(`解決済み${role} teamは1件以上必要です`);
  }
  const nodeIds = teams.map((team) => team.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new TypeError(`解決済み${role} teamのnode IDが重複しています`);
  }
}

function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createSourceIds(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function compareCandidates(
  left: IssueExplicitRequestCandidate,
  right: IssueExplicitRequestCandidate,
): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

function validateAssessment(
  input: IssueStateMachineInput,
  candidates: readonly IssueExplicitRequestCandidate[],
): void {
  const assessment = input.explicitRequestAssessment;
  if (assessment.status === "not_assessed") {
    return;
  }
  if (candidates.length === 0) {
    throw new TypeError("明示依頼候補がないため外部判定を適用できません");
  }

  validateConfidence(assessment.confidence, "明示依頼の外部判定confidence");
  validateSourceIds(assessment.candidateSourceIds, "明示依頼の外部判定対象");
  validateSourceIds(assessment.sourceIds, "明示依頼の外部判定根拠");

  const actualCandidateSourceIds = createSourceIds(
    candidates.map((candidate) => candidate.sourceId),
  );
  const assessedCandidateSourceIds = createSourceIds(assessment.candidateSourceIds);
  if (
    actualCandidateSourceIds.length !== assessedCandidateSourceIds.length ||
    actualCandidateSourceIds.some(
      (sourceId, index) => sourceId !== assessedCandidateSourceIds[index],
    )
  ) {
    throw new TypeError("明示依頼候補と外部判定の対象source IDが一致しません");
  }

  const knownSourceIds = new Set<SourceId>([
    input.issue.sourceId,
    ...input.issue.events.map((event) => event.sourceId),
    ...actualCandidateSourceIds,
  ]);
  for (const sourceId of assessment.sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new TypeError(`明示依頼の外部判定が未知のsource IDを参照しています。対象: ${sourceId}`);
    }
  }

  if (assessment.verdict === "no_unanswered_request") {
    if (!assessment.sourceIds.some((sourceId) => actualCandidateSourceIds.includes(sourceId))) {
      throw new TypeError("明示依頼ではないという外部判定に候補のsource IDがありません");
    }
    return;
  }

  if (!actualCandidateSourceIds.includes(assessment.requestSourceId)) {
    throw new TypeError("外部判定が選んだ明示依頼は現在の候補に含まれていません");
  }
  if (!assessment.sourceIds.includes(assessment.requestSourceId)) {
    throw new TypeError("明示依頼の外部判定根拠に選定した依頼のsource IDがありません");
  }
  if (assessment.targets.length === 0) {
    throw new TypeError("未回答の明示依頼には依頼先が1件以上必要です");
  }

  const targetKeys = new Set<string>();
  for (const target of assessment.targets) {
    if (target.candidateId.length === 0) {
      throw new TypeError("明示依頼先のcandidate IDは空にできません");
    }
    validateConfidence(target.confidence, `明示依頼先 ${target.candidateId}のconfidence`);
    validateSourceIds(target.sourceIds, `明示依頼先 ${target.candidateId}`);
    for (const sourceId of target.sourceIds) {
      if (!assessment.sourceIds.includes(sourceId)) {
        throw new TypeError(
          `明示依頼先の根拠が外部判定の根拠に含まれていません。対象: ${sourceId}`,
        );
      }
    }
    const targetKey = `${target.kind}:${target.candidateId}`;
    if (targetKeys.has(targetKey)) {
      throw new TypeError(`明示依頼先が重複しています。対象: ${target.candidateId}`);
    }
    targetKeys.add(targetKey);
  }
}

function validateInput(input: IssueStateMachineInput): void {
  validateConfidence(input.confidenceThresholds.high, "high confidence閾値");
  validateConfidence(input.confidenceThresholds.medium, "medium confidence閾値");
  if (input.confidenceThresholds.high < input.confidenceThresholds.medium) {
    throw new RangeError("high confidence閾値はmedium confidence閾値以上にしてください");
  }
  if (input.evaluatedAt < input.issue.observedAt) {
    throw new RangeError("判定時刻はIssue観測時刻以後にしてください");
  }

  for (const event of input.issue.events) {
    if (event.itemNodeId !== input.issue.nodeId) {
      throw new TypeError("Issueと正規化イベントのitem node IDが一致しません");
    }
    if (event.occurredAt > input.evaluatedAt) {
      throw new RangeError("正規化イベントの発生時刻は判定時刻以前にしてください");
    }
  }

  const assigneeNodeIds = new Set<string>();
  const assigneeLogins = new Set<string>();
  for (const assignee of input.issue.assignees) {
    if (assignee.login.length === 0) {
      throw new TypeError("Issueのassignee loginは空にできません");
    }
    const normalizedLogin = assignee.login.toLowerCase();
    if (assigneeNodeIds.has(assignee.nodeId) || assigneeLogins.has(normalizedLogin)) {
      throw new TypeError(`Issueのassigneeが重複しています。対象: ${assignee.login}`);
    }
    assigneeNodeIds.add(assignee.nodeId);
    assigneeLogins.add(normalizedLogin);
  }

  const blockerCandidateIds = new Set<string>();
  for (const blocker of input.blockers) {
    if (blocker.candidateId.length === 0) {
      throw new TypeError("blockerのcandidate IDは空にできません");
    }
    if (blockerCandidateIds.has(blocker.candidateId)) {
      throw new TypeError(`blockerが重複しています。対象: ${blocker.candidateId}`);
    }
    blockerCandidateIds.add(blocker.candidateId);
    validateConfidence(blocker.confidence, `blocker ${blocker.candidateId}のconfidence`);
    validateSourceIds(blocker.sourceIds, `blocker ${blocker.candidateId}`);
    if (blocker.becameBlockingAt > input.evaluatedAt) {
      throw new RangeError("blockerになった時刻は判定時刻以前にしてください");
    }
  }

  const candidateSourceIds = new Set<SourceId>();
  const candidates = [...input.explicitRequestCandidates].sort(compareCandidates);
  for (const candidate of candidates) {
    if (candidateSourceIds.has(candidate.sourceId)) {
      throw new TypeError(`明示依頼候補が重複しています。対象: ${candidate.sourceId}`);
    }
    candidateSourceIds.add(candidate.sourceId);
    if (candidate.occurredAt > input.evaluatedAt) {
      throw new RangeError("明示依頼候補の発生時刻は判定時刻以前にしてください");
    }
  }
  validateAssessment(input, candidates);
  validateTeamNodeIdList(input.teams.maintainers, "maintainer");
  validateTeamNodeIdList(input.teams.reviewers, "reviewer");
}

function createBasis(
  sourceIds: readonly SourceId[],
  occurredAt: UtcIsoDateTime,
  precision: IssueTransitionBasis["precision"],
): IssueTransitionBasis {
  return Object.freeze({
    sourceIds: createSourceIds(sourceIds),
    occurredAt,
    precision,
  });
}

function createWaitingOn(
  fields: Omit<WaitingOn, "sourceIds"> & Readonly<{ sourceIds: readonly SourceId[] }>,
): WaitingOn {
  return Object.freeze({
    ...fields,
    sourceIds: createSourceIds(fields.sourceIds),
  });
}

function createEvidence(
  sourceIds: readonly SourceId[],
  supports: EvidenceSupport,
  summary: string,
): readonly Evidence[] {
  return createSourceIds(sourceIds).map((sourceId) =>
    Object.freeze({
      sourceId,
      supports,
      summary,
    }),
  );
}

function compareEvidence(left: Evidence, right: Evidence): -1 | 0 | 1 {
  const sourceComparison = compareSourceIds(left.sourceId, right.sourceId);
  if (sourceComparison !== 0) {
    return sourceComparison;
  }
  if (left.supports < right.supports) {
    return -1;
  }
  if (left.supports > right.supports) {
    return 1;
  }
  if (left.summary < right.summary) {
    return -1;
  }
  if (left.summary > right.summary) {
    return 1;
  }
  return 0;
}

function freezeEvidence(values: readonly Evidence[]): readonly Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const evidence of values) {
    unique.set(`${evidence.sourceId}\u0000${evidence.supports}\u0000${evidence.summary}`, evidence);
  }
  return Object.freeze([...unique.values()].sort(compareEvidence));
}

function addUncertainty(
  context: DecisionContext,
  message: string,
  sourceIds: readonly SourceId[],
  confidenceCap: number,
): void {
  context.uncertainties.push(message);
  context.evidence.push(...createEvidence(sourceIds, "uncertainty", message));
  context.confidenceCap = Math.min(context.confidenceCap, confidenceCap);
}

function finalizeDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
  draft: DecisionDraft,
): IssueStateDecision {
  if (isTerminalStatus(draft.status) && draft.waitingOn.length !== 0) {
    throw new TypeError("terminal状態にwaitingOnを設定できません");
  }
  if (!isTerminalStatus(draft.status) && draft.waitingOn.length === 0) {
    throw new TypeError("継続中の状態にはwaitingOnが1件以上必要です");
  }

  const uncertainties = Object.freeze([...new Set(context.uncertainties)].sort());
  const confidence = Math.min(draft.confidence, context.confidenceCap);
  const waitingOn = Object.freeze(
    draft.waitingOn
      .flatMap((value) => resolveRepositoryRoleWaitingOn(input.teams, value))
      .map((value) =>
        Object.freeze({
          ...value,
          confidence: Math.min(value.confidence, context.confidenceCap),
        }),
      ),
  );
  const primaryWaitingOn =
    waitingOn.length === 0
      ? Object.freeze({
          index: "not_applicable",
          selectionReason: draft.primarySelectionReason,
        } satisfies IssuePrimaryWaitingOn)
      : Object.freeze({
          index: 0,
          selectionReason: draft.primarySelectionReason,
        } satisfies IssuePrimaryWaitingOn);

  return Object.freeze({
    deterministicRulesVersion: ISSUE_DETERMINISTIC_RULES_VERSION,
    evaluatedAt: input.evaluatedAt,
    determination: uncertainties.length === 0 ? "determined" : "codex_candidate",
    status: draft.status,
    waitingOn,
    primaryWaitingOn,
    nextAction: draft.nextAction,
    confidence,
    evidence: freezeEvidence([...draft.evidence, ...context.evidence]),
    uncertainties,
    statusBasis: draft.statusBasis,
    responsibilityBasis: draft.responsibilityBasis,
  });
}

function compareEvents(left: NormalizedEvent, right: NormalizedEvent): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

function getLatestEvent<T extends NormalizedEvent>(events: readonly T[]): T | undefined {
  return [...events].sort(compareEvents).at(-1);
}

function createTerminalDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  const issue = input.issue;
  if (issue.state === "open") {
    return undefined;
  }

  const closedEvent = getLatestEvent(
    issue.events.filter(
      (event): event is NormalizedEvent & Readonly<{ kind: "state"; state: "closed" }> =>
        event.kind === "state" && event.state === "closed",
    ),
  );
  const closedSourceId = closedEvent?.sourceId ?? issue.sourceId;
  const basis = createBasis([closedSourceId], issue.closedAt, "event");
  if (issue.stateReason === "not_planned" || issue.stateReason === "duplicate") {
    return finalizeDecision(input, context, {
      status: "terminal_not_planned",
      waitingOn: [],
      primarySelectionReason: "terminal状態にはprimary waitingOnがありません",
      nextAction: "対応は不要です",
      confidence: 1,
      evidence: createEvidence(
        [closedSourceId],
        "status",
        "Issueは対応しない理由でcloseされています",
      ),
      statusBasis: basis,
      responsibilityBasis: basis,
    });
  }
  if (issue.stateReason === "completed") {
    return finalizeDecision(input, context, {
      status: "terminal_completed",
      waitingOn: [],
      primarySelectionReason: "terminal状態にはprimary waitingOnがありません",
      nextAction: "対応は不要です",
      confidence: 1,
      evidence: createEvidence([closedSourceId], "status", "Issueは完了としてcloseされています"),
      statusBasis: basis,
      responsibilityBasis: basis,
    });
  }

  addUncertainty(
    context,
    "close理由をGitHubの観測値から区別できません",
    [closedSourceId],
    input.confidenceThresholds.medium,
  );
  return finalizeDecision(input, context, {
    status: "terminal_completed",
    waitingOn: [],
    primarySelectionReason: "terminal状態にはprimary waitingOnがありません",
    nextAction: "対応は不要です",
    confidence: input.confidenceThresholds.medium,
    evidence: createEvidence(
      [closedSourceId],
      "status",
      "Issueがcloseされていることだけは確定しています",
    ),
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function compareBlockers(left: IssueBlocker, right: IssueBlocker): -1 | 0 | 1 {
  if (left.authority !== right.authority) {
    return left.authority === "authoritative" ? -1 : 1;
  }
  if (left.confidence !== right.confidence) {
    return left.confidence > right.confidence ? -1 : 1;
  }
  if (left.becameBlockingAt < right.becameBlockingAt) {
    return -1;
  }
  if (left.becameBlockingAt > right.becameBlockingAt) {
    return 1;
  }
  if (left.candidateId < right.candidateId) {
    return -1;
  }
  if (left.candidateId > right.candidateId) {
    return 1;
  }
  return 0;
}

function createBlockedDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  const openBlockers = input.blockers.filter((blocker) => blocker.state === "open");
  const confirmedBlockers = openBlockers
    .filter(
      (blocker) =>
        blocker.authority === "authoritative" ||
        blocker.confidence >= input.confidenceThresholds.high,
    )
    .sort(compareBlockers);
  const uncertainBlockers = openBlockers
    .filter(
      (blocker) =>
        blocker.authority === "inferred" && blocker.confidence < input.confidenceThresholds.high,
    )
    .sort(compareBlockers);

  for (const blocker of uncertainBlockers) {
    addUncertainty(
      context,
      `${blocker.candidateId}が現在のblockerか確定していません`,
      blocker.sourceIds,
      input.confidenceThresholds.medium,
    );
  }
  if (confirmedBlockers.length === 0) {
    return undefined;
  }

  const primaryBlocker = confirmedBlockers[0];
  assertNonNullable(primaryBlocker, "primary blockerを選定できませんでした");
  const waitingOn = confirmedBlockers.map((blocker) =>
    createWaitingOn({
      kind: "item",
      candidateId: blocker.candidateId,
      role: "dependency",
      reasonSummary: "この項目の完了を待っています",
      sourceIds: blocker.sourceIds,
      confidence: blocker.confidence,
    }),
  );
  const allSourceIds = confirmedBlockers.flatMap((blocker) => blocker.sourceIds);
  const primarySelectionReason =
    confirmedBlockers.length === 1
      ? "唯一の確定済みopen blockerをprimaryに選定しました"
      : "authoritative、confidence、blockerになった時刻、candidate IDの順で選定しました";
  const basis = createBasis(primaryBlocker.sourceIds, primaryBlocker.becameBlockingAt, "event");

  return finalizeDecision(input, context, {
    status: "waiting_for_unblock",
    waitingOn,
    primarySelectionReason,
    nextAction: `${primaryBlocker.candidateId}の完了を待つ`,
    confidence: primaryBlocker.confidence,
    evidence: [
      ...createEvidence(allSourceIds, "status", "確定済みのopen blockerがあります"),
      ...createEvidence(allSourceIds, "waiting_on", "open blockerの完了待ちです"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function compareRequestTargets(
  left: IssueExplicitRequestTarget,
  right: IssueExplicitRequestTarget,
): -1 | 0 | 1 {
  const leftKindOrder = getRequestTargetKindOrder(left.kind);
  const rightKindOrder = getRequestTargetKindOrder(right.kind);
  if (leftKindOrder !== rightKindOrder) {
    return leftKindOrder < rightKindOrder ? -1 : 1;
  }
  if (left.candidateId < right.candidateId) {
    return -1;
  }
  if (left.candidateId > right.candidateId) {
    return 1;
  }
  return 0;
}

function getRequestTargetKindOrder(kind: IssueExplicitRequestTarget["kind"]): number {
  switch (kind) {
    case "user":
      return 0;
    case "team":
      return 1;
    case "role":
      return 2;
  }
}

function getRequestDecisionStatus(targets: readonly IssueExplicitRequestTarget[]): Status {
  return targets.every((target) => target.kind === "role" && target.role === "maintainer")
    ? "waiting_for_decision"
    : "waiting_for_work";
}

function createExplicitRequestDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  const candidates = [...input.explicitRequestCandidates].sort(compareCandidates);
  if (candidates.length === 0) {
    return undefined;
  }

  const assessment = input.explicitRequestAssessment;
  if (assessment.status === "not_assessed") {
    addUncertainty(
      context,
      "未回答の明示依頼らしき候補を決定論的に確定できません",
      candidates.map((candidate) => candidate.sourceId),
      input.confidenceThresholds.medium,
    );
    return undefined;
  }

  if (assessment.verdict === "no_unanswered_request") {
    if (assessment.confidence < input.confidenceThresholds.high) {
      addUncertainty(
        context,
        "明示依頼候補に未回答の依頼がないという判定の信頼度が十分ではありません",
        assessment.sourceIds,
        Math.min(input.confidenceThresholds.medium, assessment.confidence),
      );
    } else {
      context.evidence.push(
        ...createEvidence(
          assessment.sourceIds,
          "waiting_on",
          "明示依頼候補に未回答の依頼はありません",
        ),
      );
    }
    return undefined;
  }

  const targets = [...assessment.targets].sort(compareRequestTargets);
  const targetConfidence = Math.min(...targets.map((target) => target.confidence));
  const confidence = Math.min(assessment.confidence, targetConfidence);
  if (confidence < input.confidenceThresholds.medium) {
    addUncertainty(
      context,
      "明示依頼の相手に関する外部判定の信頼度が低いため責務へ反映しません",
      assessment.sourceIds,
      confidence,
    );
    return undefined;
  }
  if (confidence < input.confidenceThresholds.high) {
    addUncertainty(
      context,
      "明示依頼の相手は外部判定による推定です",
      assessment.sourceIds,
      confidence,
    );
  }

  const requestCandidate = candidates.find(
    (candidate) => candidate.sourceId === assessment.requestSourceId,
  );
  assertNonNullable(requestCandidate, "選定済みの明示依頼候補を取得できませんでした");
  const waitingOn = targets.map((target) =>
    createWaitingOn({
      kind: target.kind,
      candidateId: target.candidateId,
      role: target.role,
      reasonSummary: "最新の未回答な明示依頼があります",
      sourceIds: target.sourceIds,
      confidence: Math.min(target.confidence, assessment.confidence),
    }),
  );
  const primaryTarget = targets[0];
  assertNonNullable(primaryTarget, "primaryとなる明示依頼先を選定できませんでした");
  const basis = createBasis(assessment.sourceIds, requestCandidate.occurredAt, "inferred");

  return finalizeDecision(input, context, {
    status: getRequestDecisionStatus(targets),
    waitingOn,
    primarySelectionReason: "明示依頼先をuser、team、role、candidate IDの順で選定しました",
    nextAction: `${primaryTarget.candidateId}が明示依頼へ対応する`,
    confidence,
    evidence: [
      ...createEvidence(assessment.sourceIds, "status", "最新の未回答な明示依頼があります"),
      ...createEvidence(assessment.sourceIds, "waiting_on", "明示依頼先の対応待ちです"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function getAssigneeBasis(
  issue: FreshObservedGitHubIssue,
  assignee: GitHubAccountActor,
  replay: AssigneeEventReplay,
): IssueTransitionBasis {
  const assignmentEvent = replay.activeAssignmentByAssigneeNodeId.get(assignee.nodeId);
  if (assignmentEvent == null) {
    return createBasis([issue.sourceId], issue.createdAt, "inferred");
  }
  return createBasis([assignmentEvent.sourceId], assignmentEvent.occurredAt, "event");
}

function replayAssigneeEvents(events: readonly NormalizedEvent[]): AssigneeEventReplay {
  const activeAssignmentByAssigneeNodeId = new Map<GitHubAccountActor["nodeId"], AssigneeEvent>();
  let lastUnassignedEvent: AssigneeEvent | undefined;
  const assigneeEvents = events
    .filter((event): event is AssigneeEvent => event.kind === "assignee")
    .sort(compareEvents);

  for (const event of assigneeEvents) {
    if (event.action === "added") {
      activeAssignmentByAssigneeNodeId.set(event.assignee.nodeId, event);
      continue;
    }

    const removedActiveAssignment = activeAssignmentByAssigneeNodeId.delete(event.assignee.nodeId);
    if (removedActiveAssignment && activeAssignmentByAssigneeNodeId.size === 0) {
      lastUnassignedEvent = event;
    }
  }

  return Object.freeze({
    activeAssignmentByAssigneeNodeId,
    lastUnassignedEvent,
  });
}

function compareResolvedAssignees(left: ResolvedAssignee, right: ResolvedAssignee): -1 | 0 | 1 {
  if (left.basis.occurredAt < right.basis.occurredAt) {
    return -1;
  }
  if (left.basis.occurredAt > right.basis.occurredAt) {
    return 1;
  }
  if (left.waitingOn.candidateId < right.waitingOn.candidateId) {
    return -1;
  }
  if (left.waitingOn.candidateId > right.waitingOn.candidateId) {
    return 1;
  }
  return 0;
}

function createAssigneeDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  if (input.issue.assignees.length === 0) {
    return undefined;
  }

  const replay = replayAssigneeEvents(input.issue.events);
  const assignees = input.issue.assignees
    .map((assignee) => {
      const basis = getAssigneeBasis(input.issue, assignee, replay);
      return Object.freeze({
        waitingOn: createWaitingOn({
          kind: "user",
          candidateId: assignee.login,
          role: "assignee",
          reasonSummary: "Issueへassignされています",
          sourceIds: basis.sourceIds,
          confidence: 1,
        }),
        basis,
      });
    })
    .sort(compareResolvedAssignees);
  const primaryAssignee = assignees[0];
  assertNonNullable(primaryAssignee, "primary assigneeを選定できませんでした");
  const sourceIds = assignees.flatMap((assignee) => assignee.waitingOn.sourceIds);

  return finalizeDecision(input, context, {
    status: "waiting_for_work",
    waitingOn: assignees.map((assignee) => assignee.waitingOn),
    primarySelectionReason: "assign時刻とcandidate IDの順でassigneeを選定しました",
    nextAction: `${primaryAssignee.waitingOn.candidateId}がIssueを進める`,
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "Issueにassigneeが設定されています"),
      ...createEvidence(sourceIds, "waiting_on", "assigneeの対応待ちです"),
    ],
    statusBasis: primaryAssignee.basis,
    responsibilityBasis: primaryAssignee.basis,
  });
}

function createUnassignedDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision {
  const lastUnassignedEvent = replayAssigneeEvents(input.issue.events).lastUnassignedEvent;
  const basis =
    lastUnassignedEvent == null
      ? createBasis([input.issue.sourceId], input.issue.createdAt, "inferred")
      : createBasis([lastUnassignedEvent.sourceId], lastUnassignedEvent.occurredAt, "event");
  const assessmentEvidenceSourceIds = input.issue.events.flatMap((event) => {
    if (event.kind === "assignee" && event.action === "added") {
      return [event.sourceId];
    }
    if (event.kind !== "comment" || event.actor.type !== "human") {
      return [];
    }
    if (
      input.issue.author.status === "identified" &&
      event.actor.nodeId === input.issue.author.actor.nodeId
    ) {
      return [];
    }
    return [event.sourceId];
  });
  if (input.issue.labels.length > 0) {
    assessmentEvidenceSourceIds.push(input.issue.sourceId);
  }
  const assessmentCompleted = assessmentEvidenceSourceIds.length > 0;
  let nextAction = assessmentCompleted
    ? "maintainerがIssueの担当を決める"
    : "maintainerがIssueの内容を確認する";
  if (context.uncertainties.length > 0) {
    nextAction = assessmentCompleted
      ? "maintainerが不確実な点を確認して担当を決める"
      : "maintainerが不確実な点を確認してIssueの内容を確認する";
  }
  const waitingOn = createWaitingOn({
    kind: "role",
    candidateId: "maintainer",
    role: "maintainer",
    reasonSummary: assessmentCompleted
      ? "内容確認済みの未アサインIssueで担当決定が必要です"
      : "未アサインIssueの内容確認が必要です",
    sourceIds: basis.sourceIds,
    confidence: 1,
  });
  return finalizeDecision(input, context, {
    status: assessmentCompleted ? "waiting_for_owner" : "waiting_for_assessment",
    waitingOn: [waitingOn],
    primarySelectionReason: "未アサインIssueの既定責務としてmaintainerを選定しました",
    nextAction,
    confidence: 1,
    evidence: [
      ...createEvidence(
        assessmentCompleted ? assessmentEvidenceSourceIds : [input.issue.sourceId],
        "status",
        assessmentCompleted
          ? "Issueの内容が確認された根拠があり、assigneeは設定されていません"
          : "Issueにassigneeがなく、内容確認済みの根拠もありません",
      ),
      ...createEvidence(
        basis.sourceIds,
        "waiting_on",
        assessmentCompleted
          ? "未アサインIssueの担当決定はmaintainerの責務です"
          : "未アサインIssueの内容確認はmaintainerの責務です",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

/** T08とT09の解決済み入力からIssueの状態と責務を決定論的に判定する。 */
export function determineIssueState(input: IssueStateMachineInput): IssueStateDecision {
  validateInput(input);
  const context: DecisionContext = {
    uncertainties: [],
    evidence: [],
    confidenceCap: 1,
  };

  const terminalDecision = createTerminalDecision(input, context);
  if (terminalDecision != null) {
    return terminalDecision;
  }

  const blockedDecision = createBlockedDecision(input, context);
  if (blockedDecision != null) {
    return blockedDecision;
  }

  const explicitRequestDecision = createExplicitRequestDecision(input, context);
  if (explicitRequestDecision != null) {
    return explicitRequestDecision;
  }

  const assigneeDecision = createAssigneeDecision(input, context);
  if (assigneeDecision != null) {
    return assigneeDecision;
  }

  return createUnassignedDecision(input, context);
}

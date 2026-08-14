import { z } from "zod";

import {
  type FreshObservedGitHubPullRequest,
  type ObservedGitHubHeadCheckContext,
  type ObservedGitHubHeadChecks,
  resolvePullRequestCheckContextOccurredAt,
  resolvePullRequestCommitOccurredAt,
} from "./github-item-observation.js";
import { type ResolvedLabelEffects } from "./label-resolution.js";
import { resolveRepositoryRoleWaitingOn } from "./maintainer-resolution.js";
import { type SourceId } from "./source-id.js";
import {
  type Evidence,
  type EvidenceSupport,
  type GitHubAccountActor,
  type GitHubNodeId,
  type NormalizedEvent,
  type PrimaryWaitingOn,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
} from "./types.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

const confidenceSchema = z.number().min(0).max(1);

/** Pull Request判定へ適用した決定規則のversion。 */
export const PULL_REQUEST_DETERMINISTIC_RULES_VERSION = "pull-request-v12";

/** 依存グラフからPull Request判定へ渡すblocker。 */
export type PullRequestBlocker = Readonly<{
  candidateId: string;
  state: "open" | "closed" | "merged";
  authority: "authoritative" | "inferred";
  confidence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
  becameBlockingAt: UtcIsoDateTime;
}>;

/** required check失敗原因の決定論的な事前評価。 */
export type PullRequestCheckFailureAssessment =
  | Readonly<{
      cause: "not_assessed";
    }>
  | Readonly<{
      cause: "pull_request_change" | "infrastructure_or_flaky" | "ambiguous";
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** Pull Request状態機械へ渡す設定解決済み入力。 */
export type PullRequestStateMachineInput = Readonly<{
  pullRequest: FreshObservedGitHubPullRequest;
  blockers: readonly PullRequestBlocker[];
  checkFailureAssessment: PullRequestCheckFailureAssessment;
  labelEffects: ResolvedLabelEffects;
  maintainers: readonly string[];
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
export type PullRequestTransitionBasis = Readonly<{
  sourceIds: readonly [SourceId, ...SourceId[]];
  occurredAt: UtcIsoDateTime;
  precision: "event" | "inferred";
}>;

/** primary waitingOnの選定結果。 */
export type PullRequestPrimaryWaitingOn = PrimaryWaitingOn;

/** 決定論的なPull Request状態機械の判定結果。 */
export type PullRequestStateDecision = Readonly<{
  deterministicRulesVersion: typeof PULL_REQUEST_DETERMINISTIC_RULES_VERSION;
  evaluatedAt: UtcIsoDateTime;
  determination: "determined" | "codex_candidate";
  status: Status;
  waitingOn: readonly WaitingOn[];
  primaryWaitingOn: PullRequestPrimaryWaitingOn;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
  statusBasis: PullRequestTransitionBasis;
  responsibilityBasis: PullRequestTransitionBasis;
}>;

type DecisionDraft = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  primarySelectionReason: string;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  statusBasis: PullRequestTransitionBasis;
  responsibilityBasis: PullRequestTransitionBasis;
}>;

interface DecisionContext {
  uncertainties: string[];
  evidence: Evidence[];
  confidenceCap: number;
}

type ReviewEvent = Extract<NormalizedEvent, { kind: "review" }> & {
  actor: GitHubAccountActor & { type: "human" };
};

type HumanCommentEvent = Extract<NormalizedEvent, { kind: "comment" }> & {
  actor: GitHubAccountActor & { type: "human" };
};

type LabelEvent = Extract<NormalizedEvent, { kind: "label" }>;

type LabelEventReplay = Readonly<{
  activeAdditionByLabelName: ReadonlyMap<string, LabelEvent>;
}>;

type ResolvedReviewRequest = Readonly<{
  requestSourceId: SourceId;
  waitingOn: WaitingOn;
  basis: PullRequestTransitionBasis;
}>;

type CheckFailureAnalysis = Readonly<{
  authorAction:
    | Readonly<{
        sourceIds: readonly [SourceId, ...SourceId[]];
        confidence: number;
      }>
    | "not_applicable";
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

function validateMaintainerLoginList(maintainers: readonly string[]): void {
  if (maintainers.length === 0) {
    throw new TypeError("メンテナのGitHub loginは1件以上必要です");
  }
  const normalizedLogins = maintainers.map((login) => login.toLowerCase());
  if (new Set(normalizedLogins).size !== normalizedLogins.length) {
    throw new TypeError("メンテナのGitHub loginが重複しています");
  }
}

function validateInput(input: PullRequestStateMachineInput): void {
  validateConfidence(input.confidenceThresholds.high, "high confidence閾値");
  validateConfidence(input.confidenceThresholds.medium, "medium confidence閾値");
  if (input.confidenceThresholds.high < input.confidenceThresholds.medium) {
    throw new RangeError("high confidence閾値はmedium confidence閾値以上にしてください");
  }
  if (input.evaluatedAt < input.pullRequest.observedAt) {
    throw new RangeError("判定時刻はPull Request観測時刻以後にしてください");
  }
  if (input.pullRequest.headSha !== input.pullRequest.headCommit.sha) {
    throw new TypeError("Pull Requestのhead SHAとhead commit SHAが一致しません");
  }

  for (const event of input.pullRequest.events) {
    if (event.itemNodeId !== input.pullRequest.nodeId) {
      throw new TypeError("Pull Requestと正規化イベントのitem node IDが一致しません");
    }
    if (event.occurredAt > input.evaluatedAt) {
      throw new RangeError("正規化イベントの発生時刻は判定時刻以前にしてください");
    }
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

  if (input.checkFailureAssessment.cause !== "not_assessed") {
    validateConfidence(input.checkFailureAssessment.confidence, "check失敗原因のconfidence");
    validateSourceIds(input.checkFailureAssessment.sourceIds, "check失敗原因の評価");
  }
  validateMaintainerLoginList(input.maintainers);
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

function createBasis(
  sourceIds: readonly SourceId[],
  occurredAt: UtcIsoDateTime,
  precision: PullRequestTransitionBasis["precision"],
): PullRequestTransitionBasis {
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

function isTerminalStatus(status: Status): boolean {
  return (
    status === "terminal_merged" ||
    status === "terminal_completed" ||
    status === "terminal_not_planned"
  );
}

function finalizeDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  draft: DecisionDraft,
): PullRequestStateDecision {
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
      .flatMap((value) => resolveRepositoryRoleWaitingOn(value, input.maintainers))
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
        } satisfies PullRequestPrimaryWaitingOn)
      : Object.freeze({
          index: 0,
          selectionReason: draft.primarySelectionReason,
        } satisfies PullRequestPrimaryWaitingOn);

  return Object.freeze({
    deterministicRulesVersion: PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
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

function replayLabelEvents(events: readonly NormalizedEvent[]): LabelEventReplay {
  const activeAdditionByLabelName = new Map<string, LabelEvent>();
  const labelEvents = events
    .filter((event): event is LabelEvent => event.kind === "label")
    .sort(compareEvents);

  for (const event of labelEvents) {
    if (event.action === "added") {
      activeAdditionByLabelName.set(event.labelName, event);
      continue;
    }
    activeAdditionByLabelName.delete(event.labelName);
  }

  return Object.freeze({ activeAdditionByLabelName });
}

function compareTransitionBases(
  left: PullRequestTransitionBasis,
  right: PullRequestTransitionBasis,
): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceIds[0], right.sourceIds[0]);
}

function resolveMaintainerDecisionLabelBasis(
  pullRequest: FreshObservedGitHubPullRequest,
  labelNames: readonly string[],
): PullRequestTransitionBasis {
  const replay = replayLabelEvents(pullRequest.events);
  const bases = [...new Set(labelNames)].map((labelName) => {
    const additionEvent = replay.activeAdditionByLabelName.get(labelName);
    return additionEvent == null
      ? createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred")
      : createBasis([additionEvent.sourceId], additionEvent.occurredAt, "event");
  });
  return (
    bases.sort(compareTransitionBases)[0] ??
    createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred")
  );
}

type DraftLifecycleEvent = NormalizedEvent &
  Readonly<{ kind: "ready_for_review" | "converted_to_draft" }>;

function resolveDraftIntervalBasis(
  pullRequest: FreshObservedGitHubPullRequest,
): PullRequestTransitionBasis {
  const events = pullRequest.events
    .filter(
      (event): event is DraftLifecycleEvent =>
        event.kind === "ready_for_review" || event.kind === "converted_to_draft",
    )
    .sort(compareEvents);
  const firstEvent = events[0];
  if (firstEvent == null) {
    return createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred");
  }

  let draft = firstEvent.kind === "ready_for_review";
  let intervalStartEvent: DraftLifecycleEvent | undefined;
  for (const event of events) {
    if (event.kind === "ready_for_review") {
      if (!draft) {
        throw new TypeError("non-draftのPull Requestにready for reviewイベントがあります");
      }
      draft = false;
    } else {
      if (draft) {
        throw new TypeError("draftのPull Requestにdraft変換イベントがあります");
      }
      draft = true;
    }
    intervalStartEvent = event;
  }

  if (draft !== pullRequest.draft) {
    throw new TypeError("Pull Requestのdraft状態とlifecycleイベントが一致しません");
  }
  assertNonNullable(intervalStartEvent, "draft区間の開始イベントを取得できませんでした");
  return createBasis([intervalStartEvent.sourceId], intervalStartEvent.occurredAt, "event");
}

function createTerminalDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  const pullRequest = input.pullRequest;
  if (pullRequest.state === "open") {
    return undefined;
  }

  const mergedEvent = getLatestEvent(
    pullRequest.events.filter(
      (event): event is NormalizedEvent & Readonly<{ kind: "state"; state: "merged" }> =>
        event.kind === "state" && event.state === "merged",
    ),
  );
  const reopenedEvent = getLatestEvent(
    pullRequest.events.filter(
      (event): event is NormalizedEvent & Readonly<{ kind: "state"; state: "reopened" }> =>
        event.kind === "state" && event.state === "reopened",
    ),
  );
  if (
    mergedEvent != null &&
    (reopenedEvent == null || compareEvents(reopenedEvent, mergedEvent) < 0)
  ) {
    const basis = createBasis([mergedEvent.sourceId], mergedEvent.occurredAt, "event");
    return finalizeDecision(input, context, {
      status: "terminal_merged",
      waitingOn: [],
      primarySelectionReason: "terminal状態にはprimary waitingOnがありません",
      nextAction: "対応は不要です",
      confidence: 1,
      evidence: createEvidence([mergedEvent.sourceId], "status", "Pull Requestはmerge済みです"),
      statusBasis: basis,
      responsibilityBasis: basis,
    });
  }

  const closedEvent = getLatestEvent(
    pullRequest.events.filter(
      (event): event is NormalizedEvent & Readonly<{ kind: "state"; state: "closed" }> =>
        event.kind === "state" && event.state === "closed",
    ),
  );
  const closedSourceId = closedEvent?.sourceId ?? pullRequest.sourceId;
  const basis = createBasis([closedSourceId], pullRequest.closedAt, "event");
  if (pullRequest.stateReason === "not_planned" || pullRequest.stateReason === "duplicate") {
    return finalizeDecision(input, context, {
      status: "terminal_not_planned",
      waitingOn: [],
      primarySelectionReason: "terminal状態にはprimary waitingOnがありません",
      nextAction: "対応は不要です",
      confidence: 1,
      evidence: createEvidence(
        [closedSourceId],
        "status",
        "Pull Requestは対応しない理由でcloseされています",
      ),
      statusBasis: basis,
      responsibilityBasis: basis,
    });
  }
  if (pullRequest.stateReason === "completed") {
    return finalizeDecision(input, context, {
      status: "terminal_completed",
      waitingOn: [],
      primarySelectionReason: "terminal状態にはprimary waitingOnがありません",
      nextAction: "対応は不要です",
      confidence: 1,
      evidence: createEvidence(
        [closedSourceId],
        "status",
        "Pull Requestは完了としてcloseされています",
      ),
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
      "Pull Requestがcloseされていることだけは確定しています",
    ),
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function compareBlockers(left: PullRequestBlocker, right: PullRequestBlocker): -1 | 0 | 1 {
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
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
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

function getHeadBasis(pullRequest: FreshObservedGitHubPullRequest): PullRequestTransitionBasis {
  const occurredAt = resolvePullRequestCommitOccurredAt(
    pullRequest.headCommit,
    pullRequest.createdAt,
  );
  const precision = pullRequest.headCommit.pushedAt.status === "available" ? "event" : "inferred";
  return createBasis([pullRequest.headCommit.sourceId], occurredAt, precision);
}

type MergeQueueLifecycleEvent = NormalizedEvent &
  Readonly<{ kind: "added_to_merge_queue" | "removed_from_merge_queue" }>;

function resolveMergeQueueBasis(
  pullRequest: FreshObservedGitHubPullRequest,
  headBasis: PullRequestTransitionBasis,
): PullRequestTransitionBasis {
  const events = pullRequest.events
    .filter(
      (event): event is MergeQueueLifecycleEvent =>
        event.kind === "added_to_merge_queue" || event.kind === "removed_from_merge_queue",
    )
    .sort(compareEvents);
  let intervalStartEvent: MergeQueueLifecycleEvent | undefined;
  for (const event of events) {
    intervalStartEvent = event.kind === "added_to_merge_queue" ? event : undefined;
  }
  return intervalStartEvent == null
    ? headBasis
    : createBasis([intervalStartEvent.sourceId], intervalStartEvent.occurredAt, "event");
}

function createAutomationDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  const pullRequest = input.pullRequest;
  const automation: Readonly<{
    waitingOn: WaitingOn;
    basis: PullRequestTransitionBasis;
    nextAction: string;
  }>[] = [];

  if (pullRequest.mergeState.mergeQueue.status === "queued") {
    const basis = resolveMergeQueueBasis(pullRequest, headBasis);
    automation.push({
      waitingOn: createWaitingOn({
        kind: "automation",
        candidateId: "merge_queue",
        role: "ci",
        reasonSummary: "merge queueの処理中です",
        sourceIds: basis.sourceIds,
        confidence: 1,
      }),
      basis,
      nextAction: "merge queueの完了を待つ",
    });
  }
  if (pullRequest.mergeState.autoMerge.status === "enabled") {
    automation.push({
      waitingOn: createWaitingOn({
        kind: "automation",
        candidateId: "auto_merge",
        role: "ci",
        reasonSummary: "auto-mergeの実行待ちです",
        sourceIds: [pullRequest.mergeState.autoMerge.sourceId],
        confidence: 1,
      }),
      basis: createBasis(
        [pullRequest.mergeState.autoMerge.sourceId],
        pullRequest.mergeState.autoMerge.enabledAt,
        "event",
      ),
      nextAction: "auto-mergeの完了を待つ",
    });
  }
  if (
    pullRequest.mergeState.checks.status === "configured" &&
    (pullRequest.mergeState.checks.combinedState === "expected" ||
      pullRequest.mergeState.checks.combinedState === "pending")
  ) {
    automation.push({
      waitingOn: createWaitingOn({
        kind: "automation",
        candidateId: "required_checks",
        role: "ci",
        reasonSummary: "required checksの実行中です",
        sourceIds: [pullRequest.mergeState.checks.sourceId],
        confidence: 1,
      }),
      basis: headBasis,
      nextAction: "required checksの完了を待つ",
    });
  }
  if (automation.length === 0) {
    return undefined;
  }

  const primary = automation[0];
  assertNonNullable(primary, "primary automationを選定できませんでした");
  const sourceIds = automation.flatMap((entry) => entry.waitingOn.sourceIds);
  return finalizeDecision(input, context, {
    status: "waiting_for_automation",
    waitingOn: automation.map((entry) => entry.waitingOn),
    primarySelectionReason: "merge queue、auto-merge、required checksの順で選定しました",
    nextAction: primary.nextAction,
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "人の操作を必要としない処理の実行中です"),
      ...createEvidence(sourceIds, "waiting_on", "自動処理の完了待ちです"),
    ],
    statusBasis: primary.basis,
    responsibilityBasis: primary.basis,
  });
}

function getHumanReviewEvents(pullRequest: FreshObservedGitHubPullRequest): readonly ReviewEvent[] {
  return Object.freeze(
    pullRequest.events
      .filter(
        (event): event is ReviewEvent => event.kind === "review" && event.actor.type === "human",
      )
      .sort(compareEvents),
  );
}

function getHumanCommentEvents(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly HumanCommentEvent[] {
  return Object.freeze(
    pullRequest.events
      .filter(
        (event): event is HumanCommentEvent =>
          event.kind === "comment" && event.actor.type === "human",
      )
      .sort(compareEvents),
  );
}

function getBodyBearingHumanSpeechEvents(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly (HumanCommentEvent | ReviewEvent)[] {
  return Object.freeze(
    [...getHumanCommentEvents(pullRequest), ...getHumanReviewEvents(pullRequest)]
      .filter((event) => !event.bodyEmpty)
      .sort(compareEvents),
  );
}

function getEffectiveReviews(events: readonly ReviewEvent[]): readonly ReviewEvent[] {
  const reviewsByActor = new Map<GitHubNodeId, ReviewEvent>();
  for (const event of events) {
    switch (event.state) {
      case "approved":
      case "changes_requested":
        reviewsByActor.set(event.actor.nodeId, event);
        break;
      case "dismissed":
        reviewsByActor.delete(event.actor.nodeId);
        break;
      case "commented":
        break;
      default:
        throw new UnreachableError(event.state);
    }
  }
  return Object.freeze([...reviewsByActor.values()].sort(compareEvents));
}

function isReviewForCurrentHead(
  review: ReviewEvent,
  pullRequest: FreshObservedGitHubPullRequest,
  headBasis: PullRequestTransitionBasis,
): boolean {
  if (review.occurredAt >= headBasis.occurredAt) {
    return true;
  }
  return review.commitStatus === "available" && review.commitSha === pullRequest.headSha;
}

function createAuthorWaitingOn(
  sourceIds: readonly SourceId[],
  reasonSummary: string,
  confidence: number,
): WaitingOn {
  return createWaitingOn({
    kind: "role",
    candidateId: "author",
    role: "author",
    reasonSummary,
    sourceIds,
    confidence,
  });
}

function createChangesRequestedDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  effectiveReviews: readonly ReviewEvent[],
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  const changesRequested = effectiveReviews.filter(
    (review) =>
      review.state === "changes_requested" &&
      isReviewForCurrentHead(review, input.pullRequest, headBasis),
  );
  if (changesRequested.length === 0) {
    return undefined;
  }

  const sourceIds = changesRequested.map((review) => review.sourceId);
  const firstReview = changesRequested[0];
  assertNonNullable(firstReview, "変更要求reviewを取得できませんでした");
  const latestReview = changesRequested.at(-1);
  assertNonNullable(latestReview, "最新の変更要求reviewを取得できませんでした");
  const author = input.pullRequest.author;
  if (author.status === "identified" && author.actor.type === "human") {
    const authorSpeechEvents = getBodyBearingHumanSpeechEvents(input.pullRequest).filter(
      (event) =>
        event.actor.nodeId === author.actor.nodeId && event.occurredAt > latestReview.occurredAt,
    );
    if (authorSpeechEvents.length > 0) {
      addUncertainty(
        context,
        "変更要求後にauthorが発言しているためreviewer対応が必要か判断できません",
        [latestReview.sourceId, ...authorSpeechEvents.map((event) => event.sourceId)],
        input.confidenceThresholds.medium,
      );
    }
  }
  const basis = createBasis(sourceIds, firstReview.occurredAt, "event");
  return finalizeDecision(input, context, {
    status: "waiting_for_revision",
    waitingOn: [createAuthorWaitingOn(sourceIds, "human reviewerから変更を要求されています", 1)],
    primarySelectionReason: "現行headに対するhumanの変更要求を選定しました",
    nextAction: "変更要求へ対応してpushする",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "現行headにhumanの変更要求があります"),
      ...createEvidence(sourceIds, "waiting_on", "変更対応はauthorの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function getCommentEventsBySourceId(
  pullRequest: FreshObservedGitHubPullRequest,
): ReadonlyMap<SourceId, Extract<NormalizedEvent, { kind: "comment" }>> {
  const comments = new Map<SourceId, Extract<NormalizedEvent, { kind: "comment" }>>();
  for (const event of pullRequest.events) {
    if (event.kind === "comment") {
      comments.set(event.sourceId, event);
    }
  }
  return comments;
}

function createReviewThreadDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  const commentsBySourceId = getCommentEventsBySourceId(input.pullRequest);
  const actionable: Readonly<{
    sourceIds: readonly SourceId[];
    occurredAt: UtcIsoDateTime;
    latestHumanComment: HumanCommentEvent;
  }>[] = [];

  for (const thread of [...input.pullRequest.reviewThreads].sort((left, right) =>
    compareSourceIds(left.sourceId, right.sourceId),
  )) {
    const comments = thread.commentSourceIds.map((sourceId) => {
      const comment = commentsBySourceId.get(sourceId);
      assertNonNullable(comment, `review threadのcomment eventがありません。対象: ${sourceId}`);
      return comment;
    });
    const reviewerComments = comments.filter((comment) => {
      if (comment.actor.type !== "human") {
        return false;
      }
      return (
        input.pullRequest.author.status === "unavailable" ||
        comment.actor.nodeId !== input.pullRequest.author.actor.nodeId
      );
    });
    if (thread.isResolved || reviewerComments.length === 0) {
      continue;
    }

    const sourceIds = reviewerComments.map((comment) => comment.sourceId);
    if (thread.isOutdated) {
      addUncertainty(
        context,
        "未解決のhuman review threadがoutdatedのため対応要否を確定できません",
        sourceIds,
        input.confidenceThresholds.medium,
      );
      continue;
    }
    const humanComments = comments
      .filter((comment): comment is HumanCommentEvent => comment.actor.type === "human")
      .sort(compareEvents);
    const latestHumanComment = humanComments.at(-1);
    assertNonNullable(latestHumanComment, "review threadのhuman commentを取得できませんでした");
    if (
      input.pullRequest.author.status === "identified" &&
      latestHumanComment.actor.nodeId === input.pullRequest.author.actor.nodeId
    ) {
      const authorRepliedSourceIds = [
        ...new Set([
          ...reviewerComments.map((comment) => comment.sourceId),
          latestHumanComment.sourceId,
        ]),
      ];
      addUncertainty(
        context,
        "authorが返信済みのため未解決review threadへの対応が完了したか判断できません",
        authorRepliedSourceIds,
        input.confidenceThresholds.medium,
      );
      continue;
    }
    const firstComment = [...reviewerComments].sort(compareEvents)[0];
    assertNonNullable(firstComment, "review threadのhuman commentを取得できませんでした");
    actionable.push({
      sourceIds,
      occurredAt: firstComment.occurredAt,
      latestHumanComment,
    });
  }
  if (actionable.length === 0) {
    return undefined;
  }

  const reviewThreadCommentSourceIds = new Set(
    input.pullRequest.reviewThreads.flatMap((thread) => thread.commentSourceIds),
  );
  const author = input.pullRequest.author;
  const authorCommentsOutsideThreads =
    author.status === "identified" && author.actor.type === "human"
      ? getHumanCommentEvents(input.pullRequest).filter(
          (comment) =>
            !comment.bodyEmpty &&
            comment.actor.nodeId === author.actor.nodeId &&
            !reviewThreadCommentSourceIds.has(comment.sourceId),
        )
      : [];
  const threadsBeforeAuthorComments = actionable.filter((thread) =>
    authorCommentsOutsideThreads.some(
      (comment) => comment.occurredAt > thread.latestHumanComment.occurredAt,
    ),
  );
  if (threadsBeforeAuthorComments.length > 0) {
    const laterAuthorComments = authorCommentsOutsideThreads.filter((comment) =>
      threadsBeforeAuthorComments.some(
        (thread) => comment.occurredAt > thread.latestHumanComment.occurredAt,
      ),
    );
    addUncertainty(
      context,
      "actionableなreview threadの後にauthorがスレッド外で発言しているため対応済みまたは質問返しか判断できません",
      [
        ...threadsBeforeAuthorComments.map((thread) => thread.latestHumanComment.sourceId),
        ...laterAuthorComments.map((comment) => comment.sourceId),
      ],
      input.confidenceThresholds.medium,
    );
  }

  const threadsWithBodyBearingLatestComment = actionable.filter(
    (thread) => !thread.latestHumanComment.bodyEmpty,
  );
  if (threadsWithBodyBearingLatestComment.length > 0) {
    addUncertainty(
      context,
      "未解決review threadの最終human commentがauthor対応を求める内容か判断できません",
      threadsWithBodyBearingLatestComment.map((thread) => thread.latestHumanComment.sourceId),
      input.confidenceThresholds.medium,
    );
  }

  actionable.sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return compareSourceIds(
      createSourceIds(left.sourceIds)[0],
      createSourceIds(right.sourceIds)[0],
    );
  });
  const firstThread = actionable[0];
  assertNonNullable(firstThread, "actionableなreview threadを取得できませんでした");
  const sourceIds = actionable.flatMap((thread) => thread.sourceIds);
  const basis = createBasis(sourceIds, firstThread.occurredAt, "event");
  return finalizeDecision(input, context, {
    status: "waiting_for_revision",
    waitingOn: [createAuthorWaitingOn(sourceIds, "未解決のhuman review threadがあります", 1)],
    primarySelectionReason: "未解決のhuman review threadをauthor対応として選定しました",
    nextAction: "未解決のreview threadへ対応する",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "actionableな未解決review threadがあります"),
      ...createEvidence(sourceIds, "waiting_on", "review threadへの対応はauthorの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function compareResolvedReviewRequests(
  left: ResolvedReviewRequest,
  right: ResolvedReviewRequest,
): -1 | 0 | 1 {
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

function resolveHumanReviewRequests(
  pullRequest: FreshObservedGitHubPullRequest,
): readonly ResolvedReviewRequest[] {
  const requests = new Map<string, ResolvedReviewRequest>();
  for (const request of pullRequest.reviewRequests) {
    if (request.target.type === "user" && request.target.actor.type === "bot") {
      continue;
    }
    const candidateId =
      request.target.type === "user"
        ? request.target.actor.login
        : `${request.target.organizationLogin}/${request.target.slug}`;
    const kind = request.target.type === "user" ? "user" : "team";
    const basis =
      request.requestedAt.status === "available"
        ? createBasis([request.sourceId], request.requestedAt.value, "event")
        : createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred");
    const resolved = Object.freeze({
      requestSourceId: request.sourceId,
      waitingOn: createWaitingOn({
        kind,
        candidateId,
        role: "reviewer",
        reasonSummary: "現行のreview requestがあります",
        sourceIds: basis.sourceIds,
        confidence: 1,
      }),
      basis,
    });
    const key = `${kind}:${candidateId}`;
    const previous = requests.get(key);
    if (previous == null || compareResolvedReviewRequests(resolved, previous) < 0) {
      requests.set(key, resolved);
    }
  }
  return Object.freeze([...requests.values()].sort(compareResolvedReviewRequests));
}

function createRereviewDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  effectiveReviews: readonly ReviewEvent[],
  headBasis: PullRequestTransitionBasis,
  reviewRequests: readonly ResolvedReviewRequest[],
): PullRequestStateDecision | undefined {
  const previousChangesRequested = effectiveReviews.filter(
    (review) =>
      review.state === "changes_requested" &&
      !isReviewForCurrentHead(review, input.pullRequest, headBasis) &&
      review.occurredAt < headBasis.occurredAt,
  );
  if (previousChangesRequested.length === 0) {
    return undefined;
  }

  const previousReviewerNodeIds = new Set(
    previousChangesRequested.map((review) => review.actor.nodeId),
  );
  const commentedAfterPush = getHumanReviewEvents(input.pullRequest).filter(
    (review) =>
      review.state === "commented" &&
      review.occurredAt > headBasis.occurredAt &&
      previousReviewerNodeIds.has(review.actor.nodeId),
  );
  if (commentedAfterPush.length > 0) {
    addUncertainty(
      context,
      "変更対応push後にreviewerがcommented reviewを返しているため追加のauthor対応が必要か判断できません",
      createSourceIds([
        ...commentedAfterPush.map((review) => review.sourceId),
        ...headBasis.sourceIds,
      ]),
      input.confidenceThresholds.medium,
    );
  }

  if (commentedAfterPush.length === 0) {
    const waitingReviewerNodeIds =
      reviewRequests.length === 0
        ? previousReviewerNodeIds
        : new Set(
            input.pullRequest.reviewRequests.flatMap((request) =>
              request.target.type === "user" && request.target.actor.type === "human"
                ? [request.target.actor.nodeId]
                : [],
            ),
          );
    const commentsAfterPush = getHumanCommentEvents(input.pullRequest).filter(
      (comment) =>
        !comment.bodyEmpty &&
        comment.occurredAt > headBasis.occurredAt &&
        waitingReviewerNodeIds.has(comment.actor.nodeId),
    );
    if (commentsAfterPush.length > 0) {
      addUncertainty(
        context,
        "変更対応push後にreviewerがhuman commentを投稿しているため追加のauthor対応が必要か判断できません",
        createSourceIds([
          ...commentsAfterPush.map((comment) => comment.sourceId),
          ...headBasis.sourceIds,
        ]),
        input.confidenceThresholds.medium,
      );
    }
  }

  const waitingOn =
    reviewRequests.length > 0
      ? reviewRequests.map((request) =>
          createWaitingOn({
            ...request.waitingOn,
            reasonSummary: "変更対応push後の再reviewを待っています",
            sourceIds: [...request.waitingOn.sourceIds, ...headBasis.sourceIds],
          }),
        )
      : previousChangesRequested.map((review) =>
          createWaitingOn({
            kind: "user",
            candidateId: review.actor.login,
            role: "reviewer",
            reasonSummary: "変更対応push後の再reviewを待っています",
            sourceIds: [review.sourceId, ...headBasis.sourceIds],
            confidence: 1,
          }),
        );
  const sourceIds = [
    ...previousChangesRequested.map((review) => review.sourceId),
    ...headBasis.sourceIds,
    ...reviewRequests.flatMap((request) => request.waitingOn.sourceIds),
  ];
  return finalizeDecision(input, context, {
    status: "waiting_for_review",
    waitingOn,
    primarySelectionReason: "変更要求後のhead pushによりreviewer側へ責務を戻しました",
    nextAction: "変更内容を再reviewする",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "変更要求後に新しいheadがpushされています"),
      ...createEvidence(sourceIds, "waiting_on", "再reviewはreviewer側の責務です"),
    ],
    statusBasis: headBasis,
    responsibilityBasis: headBasis,
  });
}

function createReviewRequestDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  reviewRequests: readonly ResolvedReviewRequest[],
): PullRequestStateDecision | undefined {
  if (reviewRequests.length === 0) {
    return undefined;
  }
  const primary = reviewRequests[0];
  assertNonNullable(primary, "primary review requestを選定できませんでした");
  const sourceIds = reviewRequests.flatMap((request) => request.waitingOn.sourceIds);
  const resolvedUserRequestsBySourceId = new Map<SourceId, ResolvedReviewRequest>();
  for (const request of reviewRequests) {
    if (request.waitingOn.kind === "user") {
      resolvedUserRequestsBySourceId.set(request.requestSourceId, request);
    }
  }
  const bodyBearingHumanSpeechEvents = getBodyBearingHumanSpeechEvents(input.pullRequest);
  const reviewerSpeechForRequests = input.pullRequest.reviewRequests.flatMap((request) => {
    const resolvedRequest = resolvedUserRequestsBySourceId.get(request.sourceId);
    if (
      request.target.type !== "user" ||
      request.target.actor.type !== "human" ||
      resolvedRequest == null
    ) {
      return [];
    }
    const reviewerActor = request.target.actor;
    return bodyBearingHumanSpeechEvents
      .filter((event) => event.actor.nodeId === reviewerActor.nodeId)
      .map((event) => ({ request, resolvedRequest, event }));
  });
  const reviewerSpeechAfterRequests = reviewerSpeechForRequests.filter(
    ({ request, event }) =>
      request.requestedAt.status === "available" && event.occurredAt > request.requestedAt.value,
  );
  if (reviewerSpeechAfterRequests.length > 0) {
    addUncertainty(
      context,
      "review依頼後にreviewerが発言しているためauthor対応が必要か判断できません",
      reviewerSpeechAfterRequests.flatMap(({ resolvedRequest, event }) => [
        ...resolvedRequest.waitingOn.sourceIds,
        event.sourceId,
      ]),
      input.confidenceThresholds.medium,
    );
  }
  const reviewerSpeechWithUnavailableRequestedAt = reviewerSpeechForRequests.filter(
    ({ request }) => request.requestedAt.status === "unavailable",
  );
  if (reviewerSpeechWithUnavailableRequestedAt.length > 0) {
    addUncertainty(
      context,
      "review依頼時刻が不明なためreviewerの発言が依頼前か後か判断できません",
      reviewerSpeechWithUnavailableRequestedAt.flatMap(({ resolvedRequest, event }) => [
        ...resolvedRequest.waitingOn.sourceIds,
        event.sourceId,
      ]),
      input.confidenceThresholds.medium,
    );
  }
  return finalizeDecision(input, context, {
    status: "waiting_for_review",
    waitingOn: reviewRequests.map((request) => request.waitingOn),
    primarySelectionReason: "依頼時刻とcandidate IDの順で現行review requestを選定しました",
    nextAction: "依頼されたreviewを行う",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "現行のhuman review requestがあります"),
      ...createEvidence(sourceIds, "waiting_on", "review request先の対応待ちです"),
    ],
    statusBasis: primary.basis,
    responsibilityBasis: primary.basis,
  });
}

function createMaintainerWaitingOn(
  sourceIds: readonly SourceId[],
  role: "maintainer" | "merge_decider",
  reasonSummary: string,
  confidence: number,
): WaitingOn {
  return createWaitingOn({
    kind: "role",
    candidateId: "maintainer",
    role,
    reasonSummary,
    sourceIds,
    confidence,
  });
}

function createLabelDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  if (!input.labelEffects.requiresMaintainerDecision) {
    return undefined;
  }
  const basis = resolveMaintainerDecisionLabelBasis(
    input.pullRequest,
    input.labelEffects.maintainerDecisionLabelNames,
  );
  return finalizeDecision(input, context, {
    status: "waiting_for_decision",
    waitingOn: [
      createMaintainerWaitingOn(
        [input.pullRequest.sourceId],
        "maintainer",
        "ラベル効果によりmaintainer判断が必要です",
        1,
      ),
    ],
    primarySelectionReason: "明示的なmaintainer判断ルールを選定しました",
    nextAction: "maintainerが判断する",
    confidence: 1,
    evidence: [
      ...createEvidence(
        [input.pullRequest.sourceId],
        "status",
        "設定済みラベル効果がmaintainer判断を要求しています",
      ),
      ...createEvidence([input.pullRequest.sourceId], "waiting_on", "判断はmaintainerの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function createDraftDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision | undefined {
  if (!input.pullRequest.draft) {
    return undefined;
  }
  const basis = resolveDraftIntervalBasis(input.pullRequest);
  return finalizeDecision(input, context, {
    status: "in_progress",
    waitingOn: [
      createAuthorWaitingOn(
        [input.pullRequest.sourceId],
        "draftをready for reviewにする作業中です",
        1,
      ),
    ],
    primarySelectionReason: "draftの既定責務としてauthorを選定しました",
    nextAction: "draftを完成させてready for reviewにする",
    confidence: 1,
    evidence: [
      ...createEvidence([input.pullRequest.sourceId], "status", "Pull Requestはdraftです"),
      ...createEvidence(
        [input.pullRequest.sourceId],
        "waiting_on",
        "明示的な他者待ちがないdraftはauthorの責務です",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function addAmbiguousHumanCommentUncertainty(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): void {
  const reviewThreadCommentSourceIds = new Set(
    input.pullRequest.reviewThreads.flatMap((thread) => thread.commentSourceIds),
  );
  const ambiguousEvents = input.pullRequest.events
    .filter((event) => {
      if (event.actor.type !== "human") {
        return false;
      }
      if (event.kind === "comment") {
        return !event.bodyEmpty && !reviewThreadCommentSourceIds.has(event.sourceId);
      }
      return event.kind === "review" && event.state === "commented" && !event.bodyEmpty;
    })
    .sort(compareEvents);
  const latestEvent = ambiguousEvents.at(-1);
  if (latestEvent == null) {
    return;
  }
  addUncertainty(
    context,
    "human commentの意味を決定論的に確定できません",
    [latestEvent.sourceId],
    input.confidenceThresholds.medium,
  );
}

function getCheckSourceIds(
  checks: Extract<ObservedGitHubHeadChecks, { status: "configured" }>,
): readonly [SourceId, ...SourceId[]] {
  return createSourceIds([checks.sourceId, ...checks.contexts.map((context) => context.sourceId)]);
}

function isFailingCheckRunConclusion(
  conclusion: Extract<ObservedGitHubHeadCheckContext, { type: "check_run" }>["conclusion"],
): boolean {
  switch (conclusion) {
    case "action_required":
    case "cancelled":
    case "failure":
    case "stale":
    case "startup_failure":
    case "timed_out":
      return true;
    case "neutral":
    case "not_completed":
    case "skipped":
    case "success":
      return false;
    default:
      throw new UnreachableError(conclusion);
  }
}

function getFailingCheckOccurredAt(
  context: ObservedGitHubHeadCheckContext,
  headOccurredAt: UtcIsoDateTime,
): UtcIsoDateTime | undefined {
  if (context.type === "commit_status") {
    if (context.state !== "error" && context.state !== "failure") {
      return undefined;
    }
    return resolvePullRequestCheckContextOccurredAt(context, headOccurredAt);
  }
  if (!isFailingCheckRunConclusion(context.conclusion)) {
    return undefined;
  }
  return resolvePullRequestCheckContextOccurredAt(context, headOccurredAt);
}

function getSuccessfulCheckOccurredAt(
  context: ObservedGitHubHeadCheckContext,
  headOccurredAt: UtcIsoDateTime,
): UtcIsoDateTime | undefined {
  if (context.type === "commit_status") {
    return context.state === "success"
      ? resolvePullRequestCheckContextOccurredAt(context, headOccurredAt)
      : undefined;
  }
  return context.conclusion === "success"
    ? resolvePullRequestCheckContextOccurredAt(context, headOccurredAt)
    : undefined;
}

function analyzeCheckFailure(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): CheckFailureAnalysis {
  const checks = input.pullRequest.mergeState.checks;
  const failing =
    checks.status === "configured" &&
    (checks.combinedState === "error" || checks.combinedState === "failure");
  if (!failing) {
    if (input.checkFailureAssessment.cause !== "not_assessed") {
      throw new TypeError("required checksが失敗していないため失敗原因を評価できません");
    }
    return Object.freeze({
      authorAction: "not_applicable",
    });
  }

  const checkSourceIds = getCheckSourceIds(checks);
  const assessment = input.checkFailureAssessment;
  switch (assessment.cause) {
    case "pull_request_change": {
      const sourceIds = createSourceIds([...checkSourceIds, ...assessment.sourceIds]);
      if (assessment.confidence >= input.confidenceThresholds.high) {
        return Object.freeze({
          authorAction: Object.freeze({
            sourceIds,
            confidence: assessment.confidence,
          }),
        });
      }
      addUncertainty(
        context,
        "required check失敗がPull Requestの変更に起因するか確定していません",
        sourceIds,
        input.confidenceThresholds.medium,
      );
      return Object.freeze({
        authorAction: "not_applicable",
      });
    }
    case "infrastructure_or_flaky": {
      const sourceIds = createSourceIds([...checkSourceIds, ...assessment.sourceIds]);
      addUncertainty(
        context,
        "required check失敗にinfrastructureまたはflakyの疑いがあります",
        sourceIds,
        input.confidenceThresholds.medium,
      );
      return Object.freeze({
        authorAction: "not_applicable",
      });
    }
    case "ambiguous": {
      const sourceIds = createSourceIds([...checkSourceIds, ...assessment.sourceIds]);
      addUncertainty(
        context,
        "required check失敗の原因を確定できません",
        sourceIds,
        input.confidenceThresholds.medium,
      );
      return Object.freeze({
        authorAction: "not_applicable",
      });
    }
    case "not_assessed":
      addUncertainty(
        context,
        "required check失敗の原因が未評価です",
        checkSourceIds,
        input.confidenceThresholds.medium,
      );
      return Object.freeze({
        authorAction: "not_applicable",
      });
  }
}

function createCheckFailureDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  analysis: CheckFailureAnalysis,
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  if (analysis.authorAction === "not_applicable") {
    return undefined;
  }
  const checks = input.pullRequest.mergeState.checks;
  if (checks.status !== "configured") {
    throw new TypeError("required checksが未設定のため失敗時刻を解決できません");
  }
  const failureOccurredAt = checks.contexts
    .flatMap((checkContext) => {
      const occurredAt = getFailingCheckOccurredAt(checkContext, headBasis.occurredAt);
      return occurredAt == null ? [] : [occurredAt];
    })
    .sort()[0];
  const basis =
    failureOccurredAt == null || failureOccurredAt === headBasis.occurredAt
      ? headBasis
      : createBasis(analysis.authorAction.sourceIds, failureOccurredAt, "event");
  return finalizeDecision(input, context, {
    status: "waiting_for_revision",
    waitingOn: [
      createAuthorWaitingOn(
        analysis.authorAction.sourceIds,
        "Pull Requestの変更に起因するrequired check失敗があります",
        analysis.authorAction.confidence,
      ),
    ],
    primarySelectionReason: "高信頼のPull Request起因check失敗を選定しました",
    nextAction: "required check失敗を修正してpushする",
    confidence: analysis.authorAction.confidence,
    evidence: [
      ...createEvidence(
        analysis.authorAction.sourceIds,
        "status",
        "Pull Request起因のrequired check失敗です",
      ),
      ...createEvidence(analysis.authorAction.sourceIds, "waiting_on", "修正はauthorの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function createConflictDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  if (input.pullRequest.mergeState.mergeability !== "conflicting") {
    return undefined;
  }
  const basis = createBasis(headBasis.sourceIds, headBasis.occurredAt, "inferred");
  return finalizeDecision(input, context, {
    status: "waiting_for_revision",
    waitingOn: [
      createAuthorWaitingOn(
        [input.pullRequest.sourceId],
        "base branchとのmerge conflictがあります",
        1,
      ),
    ],
    primarySelectionReason: "他の明示的な待ち先がないmerge conflictを選定しました",
    nextAction: "base branchの変更を取り込みconflictを解消する",
    confidence: 1,
    evidence: [
      ...createEvidence(
        [input.pullRequest.sourceId],
        "status",
        "GitHubがmerge conflictを報告しています",
      ),
      ...createEvidence([input.pullRequest.sourceId], "waiting_on", "branch更新はauthorの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function createWaitingForMergeDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  effectiveReviews: readonly ReviewEvent[],
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  const checks = input.pullRequest.mergeState.checks;
  const checksSatisfied = checks.status === "not_configured" || checks.combinedState === "success";
  const mergeRequirementsSatisfied =
    input.pullRequest.mergeState.mergeability === "mergeable" &&
    input.pullRequest.mergeState.mergeState === "clean";
  if (!checksSatisfied || !mergeRequirementsSatisfied) {
    return undefined;
  }

  const effectiveApprovals = effectiveReviews.filter(
    (review) =>
      review.state === "approved" && isReviewForCurrentHead(review, input.pullRequest, headBasis),
  );
  const approvalSourceIds = effectiveApprovals.map((review) => review.sourceId);
  const sourceIds =
    checks.status === "configured"
      ? [input.pullRequest.sourceId, checks.sourceId, ...approvalSourceIds]
      : [input.pullRequest.sourceId, ...approvalSourceIds];
  const successfulCheckOccurredAts =
    checks.status === "configured"
      ? checks.contexts.flatMap((checkContext) => {
          const occurredAt = getSuccessfulCheckOccurredAt(checkContext, headBasis.occurredAt);
          return occurredAt == null ? [] : [occurredAt];
        })
      : [];
  const occurredAt = [
    headBasis.occurredAt,
    ...effectiveApprovals.map((review) => review.occurredAt),
    ...successfulCheckOccurredAts,
  ]
    .sort()
    .at(-1);
  assertNonNullable(occurredAt, "merge可能になった時刻を解決できませんでした");
  const basis = createBasis(sourceIds, occurredAt, "inferred");
  return finalizeDecision(input, context, {
    status: "waiting_for_merge",
    waitingOn: [
      createMaintainerWaitingOn(
        sourceIds,
        "merge_decider",
        "merge要件を満たしておりmerge判断を待っています",
        1,
      ),
    ],
    primarySelectionReason: "merge要件を満たしたためmaintainerのmerge判断を選定しました",
    nextAction: "maintainerがmerge可否を判断する",
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "GitHub上のmerge要件を満たしています"),
      ...createEvidence(sourceIds, "waiting_on", "最終merge判断はmaintainerの責務です"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function addMergeStateUncertainty(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): void {
  if (
    input.pullRequest.mergeState.mergeability !== "unknown" &&
    input.pullRequest.mergeState.mergeState !== "unknown"
  ) {
    return;
  }
  addUncertainty(
    context,
    "GitHubがmerge可否を確定できていません",
    [input.pullRequest.sourceId],
    input.confidenceThresholds.medium,
  );
}

function createOwnerDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
): PullRequestStateDecision {
  const basis = resolveDraftIntervalBasis(input.pullRequest);
  return finalizeDecision(input, context, {
    status: "waiting_for_owner",
    waitingOn: [
      createMaintainerWaitingOn(
        [input.pullRequest.sourceId],
        "maintainer",
        "ready for reviewですが現行review requestがありません",
        1,
      ),
    ],
    primarySelectionReason: "review未依頼の既定責務としてmaintainerを選定しました",
    nextAction:
      context.uncertainties.length === 0
        ? "maintainerがreview担当を決める"
        : "maintainerが不確実な点を確認して担当を決める",
    confidence: 1,
    evidence: [
      ...createEvidence(
        [input.pullRequest.sourceId],
        "status",
        "ready for reviewですが現行review requestがありません",
      ),
      ...createEvidence(
        [input.pullRequest.sourceId],
        "waiting_on",
        "review担当の決定はmaintainerの責務です",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

/** T08とT09の解決済み入力からPull Requestの状態と責務を決定論的に判定する。 */
export function determinePullRequestState(
  input: PullRequestStateMachineInput,
): PullRequestStateDecision {
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

  const headBasis = getHeadBasis(input.pullRequest);
  const checkFailure = analyzeCheckFailure(input, context);
  const automationDecision = createAutomationDecision(input, context, headBasis);
  if (automationDecision != null) {
    return automationDecision;
  }

  const effectiveReviews = getEffectiveReviews(getHumanReviewEvents(input.pullRequest));
  const changesRequestedDecision = createChangesRequestedDecision(
    input,
    context,
    effectiveReviews,
    headBasis,
  );
  if (changesRequestedDecision != null) {
    return changesRequestedDecision;
  }

  const reviewThreadDecision = createReviewThreadDecision(input, context);
  if (reviewThreadDecision != null) {
    return reviewThreadDecision;
  }

  const reviewRequests = resolveHumanReviewRequests(input.pullRequest);
  const rereviewDecision = createRereviewDecision(
    input,
    context,
    effectiveReviews,
    headBasis,
    reviewRequests,
  );
  if (rereviewDecision != null) {
    return rereviewDecision;
  }

  const reviewRequestDecision = createReviewRequestDecision(input, context, reviewRequests);
  if (reviewRequestDecision != null) {
    return reviewRequestDecision;
  }

  const labelDecision = createLabelDecision(input, context);
  if (labelDecision != null) {
    return labelDecision;
  }

  addAmbiguousHumanCommentUncertainty(input, context);

  const draftDecision = createDraftDecision(input, context);
  if (draftDecision != null) {
    return draftDecision;
  }

  const checkFailureDecision = createCheckFailureDecision(input, context, checkFailure, headBasis);
  if (checkFailureDecision != null) {
    return checkFailureDecision;
  }

  const conflictDecision = createConflictDecision(input, context, headBasis);
  if (conflictDecision != null) {
    return conflictDecision;
  }

  const waitingForMergeDecision = createWaitingForMergeDecision(
    input,
    context,
    effectiveReviews,
    headBasis,
  );
  if (waitingForMergeDecision != null) {
    return waitingForMergeDecision;
  }

  addMergeStateUncertainty(input, context);
  return createOwnerDecision(input, context);
}

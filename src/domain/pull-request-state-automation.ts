import { assertNonNullable, UnreachableError } from "../util/index.js";
import {
  type FreshObservedGitHubPullRequest,
  type ObservedGitHubHeadCheckContext,
  type ObservedGitHubHeadChecks,
  resolvePullRequestCommitOccurredAt,
} from "./github-item-observation.js";
import type {
  CheckFailureAnalysis,
  DecisionContext,
  PullRequestStateDecision,
  PullRequestStateMachineInput,
  PullRequestTransitionBasis,
} from "./pull-request-state-contracts.js";
import {
  addAssessmentTrace,
  addUncertainty,
  compareEvents,
  createBasis,
  createEvidence,
  createWaitingOn,
  finalizeDecision,
} from "./pull-request-state-decision.js";
import { createAuthorWaitingOn } from "./pull-request-state-revision.js";
import { createSourceIds } from "./pull-request-state-validation.js";
import { type SourceId } from "./source-id.js";
import { type NormalizedEvent, type UtcIsoDateTime, type WaitingOn } from "./types.js";

export function getHeadBasis(
  pullRequest: FreshObservedGitHubPullRequest,
): PullRequestTransitionBasis {
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

export function createAutomationDecision(
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
    return context.createdAt < headOccurredAt ? headOccurredAt : context.createdAt;
  }
  if (!isFailingCheckRunConclusion(context.conclusion)) {
    return undefined;
  }
  return context.completedAt == null || context.completedAt < headOccurredAt
    ? headOccurredAt
    : context.completedAt;
}

export function getSuccessfulCheckOccurredAt(
  context: ObservedGitHubHeadCheckContext,
): UtcIsoDateTime | undefined {
  if (context.type === "commit_status") {
    return context.state === "success" ? context.createdAt : undefined;
  }
  return context.conclusion === "success" ? context.completedAt : undefined;
}

export function analyzeCheckFailure(
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
        ["status", "waitingOn", "nextAction"],
      );
      addAssessmentTrace(context, {
        kind: "check_failure",
        assessment,
      });
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
        ["status", "waitingOn", "nextAction"],
      );
      addAssessmentTrace(context, {
        kind: "check_failure",
        assessment,
      });
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
        ["status", "waitingOn", "nextAction"],
      );
      addAssessmentTrace(context, {
        kind: "check_failure",
        assessment,
      });
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
        ["status", "waitingOn", "nextAction"],
      );
      addAssessmentTrace(context, {
        kind: "check_failure",
        assessment,
      });
      return Object.freeze({
        authorAction: "not_applicable",
      });
  }
}

export function createCheckFailureDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  analysis: CheckFailureAnalysis,
  headBasis: PullRequestTransitionBasis,
): PullRequestStateDecision | undefined {
  if (analysis.authorAction === "not_applicable") {
    return undefined;
  }
  addAssessmentTrace(context, {
    kind: "check_failure",
    assessment: input.checkFailureAssessment,
  });
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

export function createConflictDecision(
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

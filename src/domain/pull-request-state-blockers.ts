import { assertNonNullable } from "../util/index.js";
import type {
  DecisionContext,
  PullRequestBlocker,
  PullRequestStateDecision,
  PullRequestStateMachineInput,
} from "./pull-request-state-contracts.js";
import {
  addUncertainty,
  compareEvents,
  createBasis,
  createEvidence,
  createWaitingOn,
  finalizeDecision,
  getLatestEvent,
} from "./pull-request-state-decision.js";
import { type NormalizedEvent } from "./types.js";

export function createTerminalDecision(
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
      primarySelectionReason: "terminal状態にはprimaryの待ち相手がありません",
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
      primarySelectionReason: "terminal状態にはprimaryの待ち相手がありません",
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
      primarySelectionReason: "terminal状態にはprimaryの待ち相手がありません",
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
    ["status"],
  );
  return finalizeDecision(input, context, {
    status: "terminal_completed",
    waitingOn: [],
    primarySelectionReason: "terminal状態にはprimaryの待ち相手がありません",
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

export function createBlockedDecision(
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
      ["status", "waitingOn", "nextAction"],
    );
  }
  if (confirmedBlockers.length === 0) {
    context.blockerDecisionTrace = Object.freeze({
      status: "evaluated",
      result: "fallthrough",
      uncertainBlockerIds: Object.freeze(uncertainBlockers.map((blocker) => blocker.candidateId)),
    });
    return undefined;
  }

  const primaryBlocker = confirmedBlockers[0];
  assertNonNullable(primaryBlocker, "primary blockerを選定できませんでした");
  context.blockerDecisionTrace = Object.freeze({
    status: "evaluated",
    result: "blocked",
    confirmedBlockers: Object.freeze(
      confirmedBlockers.map((blocker) =>
        Object.freeze({
          candidateId: blocker.candidateId,
          authority: blocker.authority,
        }),
      ),
    ),
    uncertainBlockerIds: Object.freeze(uncertainBlockers.map((blocker) => blocker.candidateId)),
    primaryBlockerId: primaryBlocker.candidateId,
  });
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

import { assertNonNullable } from "../util/index.js";
import type {
  DecisionContext,
  IssueBlocker,
  IssueStateDecision,
  IssueStateMachineInput,
} from "./issue-state-contracts.js";
import {
  addUncertainty,
  createBasis,
  createEvidence,
  createWaitingOn,
  finalizeDecision,
  getLatestEvent,
} from "./issue-state-decision.js";
import { type NormalizedEvent } from "./types.js";

export function createTerminalDecision(
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
      primarySelectionReason: "terminal状態にはprimaryの待ち相手がありません",
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
      primarySelectionReason: "terminal状態にはprimaryの待ち相手がありません",
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

export function createBlockedDecision(
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

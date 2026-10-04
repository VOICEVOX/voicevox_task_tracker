import {
  analyzeCheckFailure,
  createAutomationDecision,
  createCheckFailureDecision,
  createConflictDecision,
  getHeadBasis,
} from "./pull-request-state-automation.js";
import { createBlockedDecision, createTerminalDecision } from "./pull-request-state-blockers.js";
import type {
  DecisionContext,
  PullRequestStateDecision,
  PullRequestStateMachineInput,
} from "./pull-request-state-contracts.js";
import {
  addAmbiguousHumanCommentUncertainty,
  addMergeStateUncertainty,
  createDraftDecision,
  createLabelDecision,
  createOwnerDecision,
  createWaitingForMergeDecision,
} from "./pull-request-state-owner.js";
import {
  createRereviewDecision,
  createReviewRequestDecision,
  resolveHumanReviewRequests,
} from "./pull-request-state-review-requests.js";
import { getEffectiveReviews, getHumanReviewEvents } from "./pull-request-state-review-sources.js";
import {
  createChangesRequestedDecision,
  createReviewThreadDecision,
} from "./pull-request-state-revision.js";
import { validateInput } from "./pull-request-state-validation.js";

/** T08とT09の解決済み入力からPull Requestの状態と責務を決定論的に判定する。 */
export function determinePullRequestState(
  input: PullRequestStateMachineInput,
): PullRequestStateDecision {
  validateInput(input);
  const context: DecisionContext = {
    uncertainties: [],
    evidence: [],
    confidenceCap: 1,
    uncertainStateElements: new Set(),
    assessmentTrace: [],
    blockerDecisionTrace: Object.freeze({ status: "not_evaluated" }),
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

/** block適用前のPull Requestローカル責務を決定する。 */
export function determinePullRequestLocalResponsibility(
  input: Omit<PullRequestStateMachineInput, "blockers">,
): PullRequestStateDecision {
  return determinePullRequestState({ ...input, blockers: [] });
}

/** Pull Requestの状態機械branchから個人催促責務のauthorityを判定する。 */
export function determinePullRequestPersonalReminderResponsibilityAuthority(
  decision: PullRequestStateDecision,
): "fixed" {
  switch (decision.status) {
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "waiting_for_revision":
    case "waiting_for_review":
    case "waiting_for_decision":
    case "waiting_for_owner":
    case "waiting_for_merge":
    case "in_progress":
      return "fixed";
    default:
      throw new TypeError(
        `個人催促責務に対応するPull Request state branchがありません。対象: ${decision.status}`,
      );
  }
}

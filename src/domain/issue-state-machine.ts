import { type FreshObservedGitHubIssue } from "./github-item-observation.js";
import { createBlockedDecision, createTerminalDecision } from "./issue-state-blockers.js";
import type {
  DecisionContext,
  IssueStateDecision,
  IssueStateMachineInput,
} from "./issue-state-contracts.js";
import {
  createAssigneeDecision,
  createEffectiveAssigneeDecision,
  createExplicitRequestDecision,
  createUnassignedDecision,
} from "./issue-state-responsibility.js";
import { validateInput } from "./issue-state-validation.js";

/** T08とT09の解決済み入力からIssueの状態と責務を決定論的に判定する。 */
export function determineIssueState(input: IssueStateMachineInput): IssueStateDecision {
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

  const explicitRequestDecision = createExplicitRequestDecision(input, context);
  if (explicitRequestDecision != null) {
    return explicitRequestDecision;
  }

  const assigneeDecision = createAssigneeDecision(input, context);
  if (assigneeDecision != null) {
    return assigneeDecision;
  }

  const effectiveAssigneeDecision = createEffectiveAssigneeDecision(input, context);
  if (effectiveAssigneeDecision != null) {
    return effectiveAssigneeDecision;
  }

  return createUnassignedDecision(input, context);
}

/** block適用前のIssueローカル責務を決定する。 */
export function determineIssueLocalResponsibility(
  input: Omit<IssueStateMachineInput, "blockers">,
): IssueStateDecision {
  return determineIssueState({ ...input, blockers: [] });
}

/** Issueの状態機械branchから個人催促責務のauthorityを判定する。 */
export function determineIssuePersonalReminderResponsibilityAuthority(
  input: Readonly<{
    issue: FreshObservedGitHubIssue;
    decision: IssueStateDecision;
  }>,
): "fixed" | "semantic" {
  switch (input.decision.status) {
    case "waiting_for_reply":
    case "waiting_for_decision":
      return "semantic";
    case "waiting_for_work":
      return input.issue.assignees.length === 0 ? "semantic" : "fixed";
    case "waiting_for_assessment":
    case "waiting_for_owner":
      return "fixed";
    default:
      throw new TypeError(
        `個人催促責務に対応するIssue state branchがありません。対象: ${input.decision.status}`,
      );
  }
}

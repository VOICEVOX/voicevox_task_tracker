import { UnreachableError } from "../util/index.js";
import {
  type PersonalReminderCause,
  type PersonalReminderCauseSeed,
  type PersonalReminderResponsible,
} from "./personal-reminder-causes.js";
import { createSourceIds, sameResponsible } from "./personal-reminder-planning-common.js";
import {
  assigneeMatches,
  eventAfter,
  eventSort,
  responsibilityEpisodeContinues,
  type ResponsibilityValue,
} from "./personal-reminder-planning-continuity.js";
import {
  type PersonalReminderCauseDraft,
  type PersonalReminderItem,
  type PersonalReminderLocalDecision,
  type PersonalReminderReviewRequestTarget,
  type PersonalReminderStructuralEndInput,
} from "./personal-reminder-planning-contracts.js";
import { isPullRequestRevisionResponsibilityResolved } from "./pull-request-state-owner.js";
import { type GitHubNodeId, type GraphNodeId, type UtcIsoDateTime } from "./types.js";
import { type Relation } from "./relation.js";

function targetMatchesResponsible(
  target: PersonalReminderReviewRequestTarget,
  responsible: PersonalReminderResponsible,
): boolean {
  return (
    target.kind === responsible.kind &&
    responsible.role === "reviewer" &&
    target.candidateId.toLowerCase() === responsible.candidateId.toLowerCase()
  );
}

function currentReviewRequestNodeIds(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
): ReadonlySet<GitHubNodeId> {
  if (item.type !== "pull_request") {
    return new Set();
  }
  const nodeIds = new Set<GitHubNodeId>();
  for (const request of item.reviewRequests) {
    for (const responsible of cause.responsible) {
      if (responsible.role !== "reviewer") {
        continue;
      }
      if (
        request.target.type === "user" &&
        responsible.kind === "user" &&
        request.target.actor.login.toLowerCase() === responsible.candidateId.toLowerCase()
      ) {
        nodeIds.add(request.target.actor.nodeId);
      }
      if (
        request.target.type === "team" &&
        responsible.kind === "team" &&
        `${request.target.organizationLogin}/${request.target.slug}`.toLowerCase() ===
          responsible.candidateId.toLowerCase()
      ) {
        nodeIds.add(request.target.nodeId);
      }
    }
  }
  return nodeIds;
}

function reviewRequestEpisodeRestarted(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  if (cause.action.kind !== "review" || item.type !== "pull_request") {
    return false;
  }
  const currentTargetNodeIds = currentReviewRequestNodeIds(item, cause);
  let removed = false;
  for (const event of [...item.events].sort(eventSort)) {
    if (
      event.kind !== "review_request" ||
      !currentTargetNodeIds.has(event.target.nodeId) ||
      !eventAfter(event, previousObservedAt)
    ) {
      continue;
    }
    if (event.action === "removed") {
      removed = true;
      continue;
    }
    if (removed) {
      return true;
    }
  }
  return false;
}

function currentResponsibleDraftExists(
  cause: PersonalReminderCause,
  drafts: readonly PersonalReminderCauseDraft[],
): boolean {
  return drafts.some(
    (draft) =>
      draft.action.kind === cause.action.kind &&
      sameResponsible(draft.responsible, cause.responsible) &&
      responsibilityEpisodeContinues(cause.responsibility, draft.responsibility),
  );
}

function allExecutionSurfacesEnded(
  responsibility: ResponsibilityValue,
  states: ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge">,
): boolean {
  if (responsibility.scope.kind !== "execution_surfaces") {
    return false;
  }
  for (const surface of responsibility.scope.surfaces) {
    const state = states.get(surface.nodeId);
    if (state == null || state === "open") {
      return false;
    }
  }
  return true;
}

function hasAssignmentEndEvent(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  return item.events.some(
    (event) =>
      event.kind === "assignee" &&
      event.action === "removed" &&
      eventAfter(event, previousObservedAt) &&
      cause.responsible.some((responsible) => assigneeMatches(responsible, event)),
  );
}

function hasReadyResolutionEvent(
  item: PersonalReminderItem,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  return item.events.some(
    (event) =>
      item.type === "pull_request" &&
      !item.draft &&
      event.kind === "ready_for_review" &&
      eventAfter(event, previousObservedAt),
  );
}

function currentDecisionCanConfirmResponsibilityEnd(
  status: PersonalReminderLocalDecision["status"],
): boolean {
  switch (status) {
    case "unknown":
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "in_progress":
      return false;
    default:
      return true;
  }
}

function hasCurrentDraftWithAction(
  input: PersonalReminderStructuralEndInput,
  actionKind: PersonalReminderCauseDraft["action"]["kind"],
): boolean {
  const successorDrafts = input.successorDrafts ?? input.currentDrafts;
  return successorDrafts.some(
    (draft) => draft.itemNodeId === input.item.nodeId && draft.action.kind === actionKind,
  );
}

function isAssessmentSuccessorAction(
  actionKind: PersonalReminderCauseDraft["action"]["kind"],
): boolean {
  switch (actionKind) {
    case "owner":
    case "work":
    case "reply":
    case "decision":
      return true;
    case "assessment":
    case "review":
    case "revision":
    case "merge":
      return false;
    default:
      throw new UnreachableError(actionKind);
  }
}

function hasCurrentAssessmentSuccessorDraft(input: PersonalReminderStructuralEndInput): boolean {
  const successorDrafts = input.successorDrafts ?? input.currentDrafts;
  return successorDrafts.some(
    (draft) =>
      draft.itemNodeId === input.item.nodeId && isAssessmentSuccessorAction(draft.action.kind),
  );
}

function hasPullRequestOwnerResolutionEvidence(
  input: PersonalReminderStructuralEndInput,
  cause: PersonalReminderCause,
): boolean {
  if (input.item.type !== "pull_request") {
    return false;
  }
  if (input.currentReviewRequestTargets.length > 0) {
    return true;
  }
  return input.item.events.some(
    (event) =>
      eventAfter(event, cause.obligationSince.at) &&
      ((event.kind === "review_request" && event.action === "added") ||
        (event.kind === "review" && event.actor.type === "human")),
  );
}

function fixedResponsibilityCauseEnded(
  input: PersonalReminderStructuralEndInput,
  cause: PersonalReminderCause,
): boolean {
  if (
    !input.complete ||
    input.item.state !== "open" ||
    cause.responsibility.authority !== "fixed" ||
    cause.responsibility.scope.kind !== "item" ||
    !currentDecisionCanConfirmResponsibilityEnd(input.currentDecisionStatus)
  ) {
    return false;
  }

  if (cause.action.kind === "assessment") {
    return (
      input.item.type === "issue" &&
      cause.reasonCode === "assessment_overdue" &&
      hasCurrentAssessmentSuccessorDraft(input)
    );
  }

  if (cause.action.kind !== "owner" || cause.reasonCode !== "owner_overdue") {
    return false;
  }
  if (input.item.type === "issue") {
    return (
      input.currentDecisionStatus === "waiting_for_work" && hasCurrentDraftWithAction(input, "work")
    );
  }
  if (input.item.draft) {
    return false;
  }
  return hasPullRequestOwnerResolutionEvidence(input, cause);
}

/** 原因が構造的に終了したか判定する。 */
export function structuralCauseEnded(
  input: PersonalReminderStructuralEndInput,
  cause: PersonalReminderCause,
): boolean {
  if (fixedResponsibilityCauseEnded(input, cause)) {
    return true;
  }
  if (!input.complete) {
    return false;
  }
  if (input.item.state === "closed") {
    return true;
  }
  if (allExecutionSurfacesEnded(cause.responsibility, input.executionSurfaceStates)) {
    return true;
  }
  const previousObservedAt = input.previous.observedAt;
  const successorDrafts = input.successorDrafts ?? input.currentDrafts;
  if (cause.action.kind === "review" && input.item.type === "pull_request") {
    if (reviewRequestEpisodeRestarted(input.item, cause, previousObservedAt)) {
      return true;
    }
    const currentReviewerExists = input.currentReviewRequestTargets.some((target) =>
      cause.responsible.some((responsible) => targetMatchesResponsible(target, responsible)),
    );
    if (!currentReviewerExists && !currentResponsibleDraftExists(cause, successorDrafts)) {
      return true;
    }
  }
  if (
    cause.action.kind === "work" &&
    hasAssignmentEndEvent(input.item, cause, previousObservedAt)
  ) {
    return true;
  }
  if (
    cause.action.kind === "revision" &&
    input.item.type === "pull_request" &&
    !currentResponsibleDraftExists(cause, successorDrafts) &&
    (currentDecisionCanConfirmResponsibilityEnd(input.currentDecisionStatus) ||
      (cause.obligationSince.source === "event" &&
        isPullRequestRevisionResponsibilityResolved({
          pullRequest: input.item,
          previousResponsibilityBasis: {
            sourceIds: createSourceIds(cause.obligationSince.sourceIds),
            occurredAt: cause.obligationSince.at,
            precision: "event",
          },
        })))
  ) {
    return true;
  }
  if (cause.action.kind === "work" && hasReadyResolutionEvent(input.item, previousObservedAt)) {
    return true;
  }
  return false;
}

/** relationが原因の対象範囲に触れるか判定する。 */
export function relationTouchesCauseScope(
  relation: Relation,
  cause: PersonalReminderCauseSeed | PersonalReminderCause,
): boolean {
  const nodeIds = new Set<GraphNodeId>([cause.itemNodeId]);
  if (cause.responsibility.scope.kind !== "item") {
    for (const surface of cause.responsibility.scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds.has(relation.fromNodeId) || nodeIds.has(relation.toNodeId);
}

import { isExcludedFromProgressAndHumanActivity } from "../../../domain/meaningful-progress.js";
import type {
  PersonalReminderActionKind,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderItem,
  PersonalReminderLocalDecision,
} from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { NormalizedEvent, UtcIsoDateTime } from "../../../domain/types.js";
import {
  actionKindForDecision,
  basisFromEvent,
  isPersonalReminderResponsibleWaitingOn,
} from "./personal-reminder-runtime-context-values.js";
import type { PersonalReminderRuntimeActivity } from "./personal-reminder-runtime-contracts.js";

function timeBasisFromTransitionBasis(
  basis: Readonly<{
    sourceIds: readonly SourceId[];
    occurredAt: UtcIsoDateTime;
    precision: "event" | "inferred";
  }>,
  clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderTimeBasis | undefined {
  if (basis.precision !== "event") {
    return undefined;
  }
  const sourceIds = basis.sourceIds.filter(
    (sourceId) => clockEventOccurredAtBySourceId.get(sourceId) === basis.occurredAt,
  );
  if (sourceIds.length === 0) {
    return undefined;
  }
  return Object.freeze({
    source: "event",
    at: basis.occurredAt,
    sourceIds,
  });
}

function isRelevantProgressEvent(
  event: NormalizedEvent,
  actionKind: PersonalReminderActionKind | undefined,
): boolean {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return false;
  }
  if (actionKind === "work") {
    return event.kind === "push" || event.kind === "state";
  }
  if (actionKind === "reply") {
    return false;
  }
  if (actionKind === "review" || actionKind === "revision") {
    return event.kind === "review" && event.actor.type === "human";
  }
  if (actionKind === "owner") {
    return event.kind === "state" || event.kind === "label";
  }
  if (actionKind === "merge") {
    return event.kind === "state";
  }
  return (
    event.kind === "state" ||
    (event.kind === "relation" && event.relationType === "blocks" && event.action === "removed")
  );
}

function isResponsibleActivityEvent(
  event: NormalizedEvent,
  actionKind: PersonalReminderActionKind | undefined,
): boolean {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return false;
  }
  switch (actionKind) {
    case "work":
    case "revision":
      return event.kind === "push" || event.kind === "state";
    case "review":
      return event.kind === "review" && event.actor.type === "human";
    case "reply":
      return (
        (event.kind === "comment" && !event.bodyEmpty) ||
        (event.kind === "review" && event.state === "commented" && !event.bodyEmpty)
      );
    case "owner":
      return event.kind === "assignee" || event.kind === "label" || event.kind === "state";
    case "merge":
      return event.kind === "state";
    case "assessment":
    case "decision":
    case undefined:
      return false;
  }
}

/** 行動種別に対応する進捗と担当者の活動を集める。 */
export function createActionActivity(
  item: PersonalReminderItem,
  actionKind: PersonalReminderActionKind | undefined,
  responsibleCandidateIds: ReadonlySet<string>,
  clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderRuntimeActivity {
  const clockEvents = item.events.filter(
    (event) => clockEventOccurredAtBySourceId.get(event.sourceId) === event.occurredAt,
  );
  const relevantProgress = clockEvents
    .filter((event) => isRelevantProgressEvent(event, actionKind))
    .map(basisFromEvent);
  const responsibleActivity = clockEvents
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        responsibleCandidateIds.has(event.actor.login.toLowerCase()) &&
        isResponsibleActivityEvent(event, actionKind),
    )
    .map(basisFromEvent);
  const humanReviewActivity = clockEvents
    .filter(
      (event) =>
        !isExcludedFromProgressAndHumanActivity(event) &&
        event.actor.type === "human" &&
        event.kind === "review",
    )
    .map(basisFromEvent);
  return Object.freeze({
    relevantProgress: Object.freeze(relevantProgress),
    responsibleActivity: Object.freeze(responsibleActivity),
    humanReviewActivity: Object.freeze(humanReviewActivity),
    actionabilityStartByAction: new Map(),
  });
}

/** local decisionに対応する活動を集める。 */
export function createRuntimeActivity(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderRuntimeActivity {
  const actionKind = actionKindForDecision(decision);
  const responsibleCandidateIds = new Set(
    decision.waitingOn
      .filter(isPersonalReminderResponsibleWaitingOn)
      .map((waitingOn) => waitingOn.candidateId.toLowerCase()),
  );
  const activity = createActionActivity(
    item,
    actionKind,
    responsibleCandidateIds,
    clockEventOccurredAtBySourceId,
  );
  if (actionKind == null) {
    return activity;
  }
  const actionabilityStartByAction = new Map(activity.actionabilityStartByAction);
  actionabilityStartByAction.set(
    actionKind,
    timeBasisFromTransitionBasis(decision.responsibilityBasis, clockEventOccurredAtBySourceId),
  );
  return Object.freeze({ ...activity, actionabilityStartByAction });
}

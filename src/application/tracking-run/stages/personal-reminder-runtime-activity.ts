import type {
  PersonalReminderActionKind,
  PersonalReminderCause,
  PersonalReminderCauseSeed,
  PersonalReminderMissingInput,
  PersonalReminderResponsible,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import { isPullRequestRevisionResponsibilityResolved } from "../../../domain/pull-request-state-owner.js";
import type { GraphNodeId, NormalizedEvent, UtcIsoDateTime } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  createNonEmptySourceIds,
  determineLocalDecision,
} from "./personal-reminder-runtime-common.js";
import { createActionActivity } from "./personal-reminder-runtime-context-activity.js";
import {
  actionKindForDecision,
  basisFromEvent,
  isPersonalReminderResponsibleWaitingOn,
} from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderRuntimeActivity,
  PersonalReminderRuntimeActivityProjection,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeItem,
} from "./personal-reminder-runtime-contracts.js";
import { compareEventOccurrence } from "./personal-reminder-runtime-event-order.js";

function firstObservationBasis(at: UtcIsoDateTime): PersonalReminderTimeBasis {
  return Object.freeze({ source: "first_observation", at });
}

type PersonalReminderWaitingTarget = Readonly<{
  item: PersonalReminderRuntimeItem;
  actionKind: PersonalReminderActionKind;
  responsible: readonly PersonalReminderResponsible[];
}>;

function waitingTargetForCause(
  item: PersonalReminderRuntimeContextItem,
  waitingFor: Readonly<{ itemNodeId: GraphNodeId; action: string }>,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderWaitingTarget | undefined {
  const seededTargets = currentSeeds.filter(
    (currentSeed) =>
      currentSeed.origin === "current_draft" &&
      currentSeed.seed.itemNodeId === waitingFor.itemNodeId &&
      currentSeed.seed.action.summary === waitingFor.action,
  );
  if (seededTargets.length > 1) {
    return undefined;
  }
  const seededTarget = seededTargets[0];
  if (seededTarget != null) {
    return Object.freeze({
      item: seededTarget.item.item,
      actionKind: seededTarget.seed.action.kind,
      responsible: seededTarget.seed.responsible,
    });
  }
  const related = [
    Object.freeze({ item: item.item, localDecision: item.localDecision }),
    ...item.relatedContexts.map((context) =>
      Object.freeze({
        item: context.item,
        localDecision:
          context.localDecision == null ? undefined : determineLocalDecision(context.localDecision),
      }),
    ),
  ].filter((context) => context.item.nodeId === waitingFor.itemNodeId);
  if (related.length !== 1) {
    return undefined;
  }
  const target = related[0];
  assertNonNullable(target, "待機先itemを取得できませんでした");
  if (target.localDecision?.nextAction !== waitingFor.action) {
    return undefined;
  }
  const actionKind = actionKindForDecision(target.localDecision);
  if (actionKind == null) {
    return undefined;
  }
  const responsible = target.localDecision.waitingOn
    .filter(isPersonalReminderResponsibleWaitingOn)
    .map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  return Object.freeze({ item: target.item, actionKind, responsible });
}

function eventActorMatchesResponsible(
  event: NormalizedEvent,
  responsible: readonly PersonalReminderResponsible[],
): boolean {
  const actor = event.actor;
  if (actor.type !== "human") {
    return false;
  }
  return responsible.some(
    (value) =>
      value.kind === "user" && value.candidateId.toLowerCase() === actor.login.toLowerCase(),
  );
}

function isStructuredWaitingResolutionEvent(
  event: NormalizedEvent,
  target: PersonalReminderWaitingTarget,
): boolean {
  if (!eventActorMatchesResponsible(event, target.responsible)) {
    if (target.actionKind !== "work" && target.actionKind !== "merge") {
      return false;
    }
  }
  switch (target.actionKind) {
    case "review":
      return event.kind === "review" && event.actor.type === "human" && event.state !== "commented";
    case "revision":
      return event.kind === "push";
    case "reply":
      return false;
    case "owner":
      return event.kind === "assignee" && event.action === "added";
    case "work":
      return event.kind === "state" && (event.state === "closed" || event.state === "merged");
    case "merge":
      return event.kind === "state" && event.state === "merged";
    case "assessment":
    case "decision":
      return false;
  }
}

function scopedActivityForCause(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
): PersonalReminderRuntimeActivityProjection {
  const responsibleCandidateIds = new Set(
    seed.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
  );
  const activities: PersonalReminderRuntimeActivity[] = [];
  const missing = new Set<PersonalReminderMissingInput>();
  if (seed.responsibility.scope.kind !== "execution_surfaces") {
    activities.push(
      createActionActivity(
        item.item,
        seed.action.kind,
        responsibleCandidateIds,
        item.clockEventOccurredAtBySourceId,
      ),
    );
  }
  for (const surface of seed.responsibility.scope.kind === "item"
    ? []
    : seed.responsibility.scope.surfaces) {
    const related = item.relatedContexts.find((context) => context.item.nodeId === surface.nodeId);
    if (related == null) {
      missing.add("related_item");
      continue;
    }
    if (related.item.type !== surface.kind) {
      throw new TypeError(`causeのexecution surface種別が一致しません。対象: ${surface.nodeId}`);
    }
    if (related.localDecision == null) {
      missing.add("related_timeline");
    }
    activities.push(
      createActionActivity(
        related.item,
        seed.action.kind,
        responsibleCandidateIds,
        item.clockEventOccurredAtBySourceId,
      ),
    );
  }
  return Object.freeze({
    activity: Object.freeze({
      relevantProgress: Object.freeze(activities.flatMap((value) => value.relevantProgress)),
      responsibleActivity: Object.freeze(activities.flatMap((value) => value.responsibleActivity)),
      humanReviewActivity: Object.freeze(activities.flatMap((value) => value.humanReviewActivity)),
      actionabilityStartByAction: new Map<
        PersonalReminderActionKind,
        PersonalReminderTimeBasis | undefined
      >(),
    }),
    missing: Object.freeze([...missing]),
  });
}

function actionabilityEventForCause(
  item: PersonalReminderRuntimeContextItem,
  previousCause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderTimeBasis | undefined {
  if (
    previousCause.lastConfirmedActionability.status !== "confirmed" ||
    previousCause.lastConfirmedActionability.verdict !== "waiting"
  ) {
    return undefined;
  }
  const waitingFor = previousCause.lastConfirmedActionability.waitingFor;
  const target = waitingTargetForCause(item, waitingFor, currentSeeds);
  if (target?.item.nodeId !== waitingFor.itemNodeId) {
    return undefined;
  }
  const previousTimestamp = Date.parse(previousObservedAt);
  if (!Number.isFinite(previousTimestamp)) {
    throw new TypeError("前回の観測時刻が不正です");
  }
  const events = target.item.events
    .filter((event) => item.clockEventOccurredAtBySourceId.get(event.sourceId) === event.occurredAt)
    .filter((event) => {
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isFinite(occurredAt)) {
        throw new TypeError(`待機解消イベントの時刻が不正です。対象: ${event.sourceId}`);
      }
      return occurredAt > previousTimestamp;
    })
    .filter((event) => isStructuredWaitingResolutionEvent(event, target))
    .sort(compareEventOccurrence);
  if (target.actionKind === "revision" && target.item.type === "pull_request") {
    const resolved = isPullRequestRevisionResponsibilityResolved({
      pullRequest: target.item,
      previousResponsibilityBasis: {
        sourceIds: createNonEmptySourceIds([target.item.sourceId], "revision待機起点"),
        occurredAt: previousObservedAt,
        precision: "inferred",
      },
    });
    if (!resolved) {
      return undefined;
    }
  }
  const event = events.at(-1);
  return event == null ? undefined : basisFromEvent(event);
}

/** 原因ごとの活動と行動可能時刻を集める。 */
export function activityForCause(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  previousCause: PersonalReminderCause | undefined,
  evaluatedAt: UtcIsoDateTime,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimeActivityProjection {
  const projection = scopedActivityForCause(item, seed);
  const actionabilityStartByAction = new Map(projection.activity.actionabilityStartByAction);
  if (previousCause == null) {
    const actionabilityStart =
      seed.responsibility.authority === "fixed" && seed.obligationSince.source === "event"
        ? seed.obligationSince
        : firstObservationBasis(evaluatedAt);
    actionabilityStartByAction.set(seed.action.kind, actionabilityStart);
  } else if (
    previousCause.lastConfirmedActionability.status === "confirmed" &&
    previousCause.lastConfirmedActionability.verdict === "waiting"
  ) {
    actionabilityStartByAction.set(
      seed.action.kind,
      actionabilityEventForCause(item, previousCause, item.previous.observedAt, currentSeeds) ??
        firstObservationBasis(evaluatedAt),
    );
  } else {
    actionabilityStartByAction.set(
      seed.action.kind,
      previousCause.actionableClock.status === "not_observed"
        ? firstObservationBasis(evaluatedAt)
        : undefined,
    );
  }
  return Object.freeze({
    activity: Object.freeze({
      relevantProgress: projection.activity.relevantProgress,
      responsibleActivity: projection.activity.responsibleActivity,
      humanReviewActivity: projection.activity.humanReviewActivity,
      actionabilityStartByAction,
    }),
    missing: projection.missing,
  });
}

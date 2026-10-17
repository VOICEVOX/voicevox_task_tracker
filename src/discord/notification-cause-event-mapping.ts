import type {
  FreshObservedGitHubIssue,
  FreshObservedGitHubPullRequest,
  NormalizedEvent,
  SourceId,
  UtcIsoDateTime,
  WaitingOn,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import type { CreateNotificationCausesInput } from "./notification-cause-contracts.js";

type FreshObservedGitHubItem = FreshObservedGitHubIssue | FreshObservedGitHubPullRequest;

type WaitingOnSignature = Readonly<Pick<WaitingOn, "kind" | "candidateId" | "role">>;

export type WaitingOnDifference = Readonly<{
  added: readonly WaitingOn[];
  removed: readonly WaitingOn[];
}>;

export type MappedEvent = Readonly<{
  event: NormalizedEvent;
  addedSignatures: readonly string[];
  removedSignatures: readonly string[];
}>;

export function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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

export function waitingOnSignature(waitingOn: WaitingOnSignature): string {
  return JSON.stringify([waitingOn.kind, waitingOn.candidateId, waitingOn.role]);
}

export function eventInWindow(
  event: NormalizedEvent,
  previousObservedAt: UtcIsoDateTime,
  evaluatedAt: UtcIsoDateTime,
): boolean {
  return event.occurredAt > previousObservedAt && event.occurredAt <= evaluatedAt;
}

export function eventsInWindow(input: CreateNotificationCausesInput): readonly NormalizedEvent[] {
  const previous = input.previous;
  if (previous.availability === "not_available") {
    return [];
  }
  const previousObservedAt = previous.value.observedAt;
  return Object.freeze(
    input.item.events
      .filter((event) => eventInWindow(event, previousObservedAt, input.evaluatedAt))
      .sort(compareEvents),
  );
}

function isImplicitMaintainerWaitingOn(waitingOn: WaitingOn): boolean {
  return (
    waitingOn.role === "maintainer" && (waitingOn.kind === "role" || waitingOn.kind === "user")
  );
}

export function currentResponsibilityBasisContains(
  input: CreateNotificationCausesInput,
  sourceId: SourceId,
): boolean {
  return input.currentResponsibilityBasis.sourceIds.includes(sourceId);
}

function normalPushIsProvenByForcePush(
  input: CreateNotificationCausesInput,
  event: Extract<NormalizedEvent, { kind: "push" }>,
): boolean {
  const item = input.item;
  if (event.forcePush || item.type !== "pull_request") {
    return false;
  }
  const previous = input.previous;
  if (previous.availability === "not_available") {
    return false;
  }
  return input.item.events.some(
    (candidate) =>
      candidate.kind === "push" &&
      candidate.forcePush &&
      candidate.headCommitSha === event.headCommitSha &&
      candidate.headCommitSha === item.headCommit.sha &&
      eventInWindow(candidate, previous.value.observedAt, input.evaluatedAt),
  );
}

export function eventAssigneeMatches(
  event: Extract<NormalizedEvent, { kind: "assignee" }>,
  waitingOn: WaitingOn,
): boolean {
  return (
    waitingOn.kind === "user" &&
    waitingOn.role === "assignee" &&
    event.assignee.login.toLowerCase() === waitingOn.candidateId.toLowerCase()
  );
}

function mapAssigneeEvent(
  event: Extract<NormalizedEvent, { kind: "assignee" }>,
  input: CreateNotificationCausesInput,
  difference: WaitingOnDifference,
): MappedEvent | undefined {
  if (event.action === "added" && !currentResponsibilityBasisContains(input, event.sourceId)) {
    return undefined;
  }
  const sourceWaitingOn = event.action === "added" ? difference.added : difference.removed;
  const matchingWaitingOn = sourceWaitingOn.find((waitingOn) =>
    eventAssigneeMatches(event, waitingOn),
  );
  if (matchingWaitingOn == null) {
    return undefined;
  }
  const signature = waitingOnSignature(matchingWaitingOn);
  const implicitMaintainerWaitingOn =
    event.action === "added" ? difference.removed.filter(isImplicitMaintainerWaitingOn) : [];
  return Object.freeze({
    event,
    addedSignatures: event.action === "added" ? [signature] : [],
    removedSignatures:
      event.action === "removed"
        ? [signature]
        : implicitMaintainerWaitingOn.map(waitingOnSignature),
  });
}

function mapConvertedToDraftEvent(
  event: NormalizedEvent,
  input: CreateNotificationCausesInput,
  item: FreshObservedGitHubItem,
  difference: WaitingOnDifference,
): MappedEvent | undefined {
  if (
    event.kind !== "converted_to_draft" ||
    item.type !== "pull_request" ||
    difference.added.length !== 1 ||
    !currentResponsibilityBasisContains(input, event.sourceId)
  ) {
    return undefined;
  }
  const current = difference.added[0];
  assertNonNullable(current, "converted_to_draftによる現在のwaitingOnを取得できませんでした");
  if (current.kind !== "role" || current.candidateId !== "author" || current.role !== "author") {
    return undefined;
  }
  return Object.freeze({
    event,
    addedSignatures: [waitingOnSignature(current)],
    removedSignatures: difference.removed.map(waitingOnSignature),
  });
}

function mapForcePushEvent(
  event: NormalizedEvent,
  input: CreateNotificationCausesInput,
  item: FreshObservedGitHubItem,
  difference: WaitingOnDifference,
): MappedEvent | undefined {
  if (
    event.kind !== "push" ||
    item.type !== "pull_request" ||
    !event.forcePush ||
    event.headCommitSha !== item.headCommit.sha ||
    difference.added.length !== 1 ||
    !currentResponsibilityBasisContains(input, item.headCommit.sourceId)
  ) {
    return undefined;
  }
  const current = difference.added[0];
  assertNonNullable(current, "force-pushによる現在のwaitingOnを取得できませんでした");
  if (current.kind !== "user" || current.role !== "reviewer") {
    return undefined;
  }
  return Object.freeze({
    event,
    addedSignatures: [waitingOnSignature(current)],
    removedSignatures: difference.removed.map(waitingOnSignature),
  });
}

export function previousWaitingOn(input: CreateNotificationCausesInput): readonly WaitingOn[] {
  return input.previous.availability === "available" ? input.previous.value.waitingOn : [];
}

export function responsibilitySourceIds(
  input: CreateNotificationCausesInput,
): ReadonlySet<SourceId> {
  return new Set([
    ...input.currentResponsibilityBasis.sourceIds,
    ...input.currentWaitingOn.flatMap((waitingOn) => waitingOn.sourceIds),
    ...previousWaitingOn(input).flatMap((waitingOn) => waitingOn.sourceIds),
  ]);
}

function waitingOnHasRole(
  waitingOn: readonly WaitingOn[],
  roles: readonly WaitingOn["role"][],
): boolean {
  return waitingOn.some((value) => roles.includes(value.role));
}

export function eventMayAffectResponsibility(
  event: NormalizedEvent,
  input: CreateNotificationCausesInput,
  difference: WaitingOnDifference,
): boolean {
  if (event.kind === "push" && !event.forcePush) {
    return (
      currentResponsibilityBasisContains(input, event.sourceId) &&
      !normalPushIsProvenByForcePush(input, event)
    );
  }
  if (responsibilitySourceIds(input).has(event.sourceId)) {
    return true;
  }
  switch (event.kind) {
    case "comment":
      return false;
    case "assignee": {
      const affectedWaitingOn = event.action === "added" ? difference.added : difference.removed;
      return affectedWaitingOn.some((waitingOn) => eventAssigneeMatches(event, waitingOn));
    }
    case "push":
      if (
        input.item.type !== "pull_request" ||
        !event.forcePush ||
        event.headCommitSha !== input.item.headCommit.sha
      ) {
        return false;
      }
      return (
        waitingOnHasRole(input.currentWaitingOn, ["author", "reviewer"]) ||
        waitingOnHasRole(previousWaitingOn(input), ["author", "reviewer"])
      );
    case "converted_to_draft":
      return (
        input.item.type === "pull_request" &&
        (waitingOnHasRole(input.currentWaitingOn, ["author"]) ||
          waitingOnHasRole(previousWaitingOn(input), ["author", "reviewer"]))
      );
    case "review":
    case "review_request":
      return (
        waitingOnHasRole(input.currentWaitingOn, ["author", "reviewer"]) ||
        waitingOnHasRole(previousWaitingOn(input), ["author", "reviewer"])
      );
    case "label":
    case "state":
    case "relation":
    case "ready_for_review":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return false;
    default:
      throw new UnreachableError(event);
  }
}

export function unsupportedEventInWindow(
  event: NormalizedEvent,
  input: CreateNotificationCausesInput,
  difference: WaitingOnDifference,
): boolean {
  if (!eventMayAffectResponsibility(event, input, difference)) {
    return false;
  }
  if (mappedEventFor(event, input, input.item, difference) != null) {
    return false;
  }
  switch (event.kind) {
    case "comment":
      return false;
    case "assignee":
      return false;
    case "push":
      return true;
    case "converted_to_draft":
      return false;
    case "ready_for_review":
    case "review":
    case "review_request":
    case "label":
    case "state":
    case "relation":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return true;
    default:
      throw new UnreachableError(event);
  }
}

export function mappedEventFor(
  event: NormalizedEvent,
  input: CreateNotificationCausesInput,
  item: FreshObservedGitHubItem,
  difference: WaitingOnDifference,
): MappedEvent | undefined {
  switch (event.kind) {
    case "assignee":
      return mapAssigneeEvent(event, input, difference);
    case "converted_to_draft":
      return mapConvertedToDraftEvent(event, input, item, difference);
    case "push":
      return mapForcePushEvent(event, input, item, difference);
    case "comment":
    case "ready_for_review":
    case "review":
    case "review_request":
    case "label":
    case "state":
    case "relation":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return undefined;
    default:
      throw new UnreachableError(event);
  }
}

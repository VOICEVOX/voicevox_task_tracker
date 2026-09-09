import { z } from "zod";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  parseSourceId,
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type NormalizedEvent,
  type SourceId,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

/** causeの責任者または根拠イベントを起こしたhuman actor。 */
export type NotificationCauseActor = GitHubAccountActor & Readonly<{ type: "human" }>;

type FreshObservedGitHubItem = FreshObservedGitHubIssue | FreshObservedGitHubPullRequest;

/** causeが直接対応付けた構造化timeline eventの要約。 */
export type NotificationCauseEvidence = Readonly<{
  sourceId: SourceId;
  occurredAt: UtcIsoDateTime;
  actor: NotificationCauseActor;
}>;

const notificationCauseActorSchema = z
  .strictObject({
    type: z.literal("human"),
    nodeId: z.string().min(1),
    login: z.string().min(1),
  })
  .transform(({ nodeId, login }): NotificationCauseActor =>
    Object.freeze({
      type: "human",
      nodeId: createGitHubNodeId(nodeId),
      login,
    }),
  );

const notificationCauseSourceIdSchema = z
  .string()
  .min(3)
  .transform((sourceId) => {
    const parts = parseSourceId(sourceId);
    return buildSourceId(parts.kind, parts.originalId);
  });

const notificationCauseEvidenceSchema = z
  .strictObject({
    sourceId: notificationCauseSourceIdSchema,
    occurredAt: z.iso
      .datetime({
        offset: true,
        error: "タイムゾーンを含むISO 8601日時を指定してください",
      })
      .transform(createUtcIsoDateTime),
    actor: notificationCauseActorSchema,
  })
  .transform((evidence): NotificationCauseEvidence => Object.freeze(evidence));

const notificationCauseEvidenceListSchema = z
  .array(notificationCauseEvidenceSchema)
  .min(1)
  .transform((evidence): readonly [NotificationCauseEvidence, ...NotificationCauseEvidence[]] => {
    const [first, ...rest] = evidence;
    assertNonNullable(first, "cause evidenceがありません");
    return Object.freeze([first, ...rest]);
  });

const notificationDependencyCauseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_applicable"),
  }),
  z.strictObject({
    status: z.literal("complete"),
    evidence: notificationCauseEvidenceListSchema,
  }),
  z.strictObject({
    status: z.literal("indeterminate"),
  }),
]);

/** 通知理由の原因対応結果を検証するcause schema。 */
export const notificationCauseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    responsible: notificationCauseActorSchema,
    evidence: notificationCauseEvidenceListSchema,
  }),
  z.strictObject({
    status: z.literal("indeterminate"),
  }),
]);

/** 通知理由の原因対応結果を表す検証済みcause。 */
export type NotificationCause = z.output<typeof notificationCauseSchema>;

type NotificationCauseEvidenceList = readonly [
  NotificationCauseEvidence,
  ...NotificationCauseEvidence[],
];

/** 責任者が確定する前の依存解消cause。 */
export type NotificationDependencyCause =
  | Readonly<{
      status: "not_applicable";
    }>
  | Readonly<{
      status: "complete";
      evidence: NotificationCauseEvidenceList;
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

type PreviousResponsibility = Readonly<{
  waitingOn: readonly WaitingOn[];
  observedAt: UtcIsoDateTime;
}>;

/** 通知理由のcauseを正規化eventと依存解消から導出する入力。 */
export type CreateNotificationCausesInput = Readonly<{
  item: FreshObservedGitHubItem;
  currentWaitingOn: readonly WaitingOn[];
  previous:
    | Readonly<{
        availability: "not_available";
      }>
    | Readonly<{
        availability: "available";
        value: PreviousResponsibility;
      }>;
  currentResponsibilityBasis: Readonly<{
    sourceIds: readonly [SourceId, ...SourceId[]];
    occurredAt: UtcIsoDateTime;
  }>;
  dependencyCause: NotificationDependencyCause;
  selfCommitmentCause: NotificationCause;
  hasUnobservedHeadChange: boolean;
  evaluatedAt: UtcIsoDateTime;
}>;

/** 通知選別へ渡す理由ごとのcause。 */
export type NotificationCauses = Readonly<{
  responsibility_changed: NotificationCause;
  newly_unblocked: NotificationCause;
}>;

type WaitingOnSignature = Readonly<Pick<WaitingOn, "kind" | "candidateId" | "role">>;

type WaitingOnDifference = Readonly<{
  added: readonly WaitingOn[];
  removed: readonly WaitingOn[];
}>;

type MappedEvent = Readonly<{
  event: NormalizedEvent;
  addedSignatures: readonly string[];
  removedSignatures: readonly string[];
}>;

type LocalCauseResolution =
  | Readonly<{
      status: "not_applicable";
    }>
  | Readonly<{
      status: "complete";
      evidence: NotificationCauseEvidenceList;
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
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

function waitingOnSignature(waitingOn: WaitingOnSignature): string {
  return JSON.stringify([waitingOn.kind, waitingOn.candidateId, waitingOn.role]);
}

function waitingOnDifference(
  previous: readonly WaitingOn[],
  current: readonly WaitingOn[],
): WaitingOnDifference {
  const previousBySignature = new Map(
    previous.map((waitingOn) => [waitingOnSignature(waitingOn), waitingOn]),
  );
  const currentBySignature = new Map(
    current.map((waitingOn) => [waitingOnSignature(waitingOn), waitingOn]),
  );
  return Object.freeze({
    added: Object.freeze(
      current.filter((waitingOn) => !previousBySignature.has(waitingOnSignature(waitingOn))),
    ),
    removed: Object.freeze(
      previous.filter((waitingOn) => !currentBySignature.has(waitingOnSignature(waitingOn))),
    ),
  });
}

function isDependencyWaitingOn(waitingOn: WaitingOn): boolean {
  return waitingOn.kind === "item" || waitingOn.role === "dependency";
}

function actorIdentity(actor: GitHubAccountActor): string {
  return actor.nodeId;
}

function actorFromAuthor(item: FreshObservedGitHubItem): GitHubAccountActor[] {
  if (item.author.status === "unavailable") {
    return [];
  }
  return [item.author.actor];
}

function actorFromPullRequestReviewRequests(item: FreshObservedGitHubItem): GitHubAccountActor[] {
  if (item.type !== "pull_request") {
    return [];
  }
  return item.reviewRequests.flatMap((request) =>
    request.target.type === "user" ? [request.target.actor] : [],
  );
}

function candidateActors(item: FreshObservedGitHubItem): readonly GitHubAccountActor[] | undefined {
  const candidates = [
    ...actorFromAuthor(item),
    ...item.assignees,
    ...actorFromPullRequestReviewRequests(item),
    ...item.events.flatMap((event) => (event.actor.type === "system" ? [] : [event.actor])),
  ];
  const actorsByIdentity = new Map<string, GitHubAccountActor>();
  for (const candidate of candidates) {
    const identity = actorIdentity(candidate);
    const existing = actorsByIdentity.get(identity);
    if (existing == null) {
      actorsByIdentity.set(identity, candidate);
      continue;
    }
    if (
      existing.type !== candidate.type ||
      existing.login.toLowerCase() !== candidate.login.toLowerCase()
    ) {
      return undefined;
    }
  }
  return Object.freeze([...actorsByIdentity.values()]);
}

function actorForWaitingOnEntry(
  item: FreshObservedGitHubItem,
  target: WaitingOn,
): NotificationCauseActor | undefined {
  if (target.kind === "role") {
    if (target.candidateId !== "author" || target.role !== "author") {
      return undefined;
    }
    if (item.author.status === "unavailable" || item.author.actor.type !== "human") {
      return undefined;
    }
    const author = notificationCauseHumanActor(item.author.actor);
    assertNonNullable(author, "authorのcause actorを取得できませんでした");
    return author;
  }
  if (target.kind !== "user" || target.role === "unknown") {
    return undefined;
  }
  const candidates = candidateActors(item);
  if (candidates == null) {
    return undefined;
  }
  const login = target.candidateId.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.login.toLowerCase() === login);
  if (matches.length !== 1) {
    return undefined;
  }
  const actor = matches[0];
  assertNonNullable(actor, "waitingOnのcause actorを取得できませんでした");
  if (actor.type !== "human") {
    return undefined;
  }
  const responsible = notificationCauseHumanActor(actor);
  assertNonNullable(responsible, "waitingOnのcause actorを取得できませんでした");
  return responsible;
}

function actorForWaitingOn(
  item: FreshObservedGitHubItem,
  waitingOn: readonly WaitingOn[],
): NotificationCauseActor | undefined {
  if (waitingOn.length !== 1) {
    return undefined;
  }
  const target = waitingOn[0];
  assertNonNullable(target, "waitingOnのcause対象を取得できませんでした");
  return actorForWaitingOnEntry(item, target);
}

function notificationCauseHumanActor(
  actor: GitHubAccountActor,
): NotificationCauseActor | undefined {
  if (actor.type !== "human") {
    return undefined;
  }
  return Object.freeze({
    type: "human",
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

function eventInWindow(
  event: NormalizedEvent,
  previousObservedAt: UtcIsoDateTime,
  evaluatedAt: UtcIsoDateTime,
): boolean {
  return event.occurredAt > previousObservedAt && event.occurredAt <= evaluatedAt;
}

function eventsInWindow(input: CreateNotificationCausesInput): readonly NormalizedEvent[] {
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

function currentResponsibilityBasisContains(
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

function eventAssigneeMatches(
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

function previousWaitingOn(input: CreateNotificationCausesInput): readonly WaitingOn[] {
  return input.previous.availability === "available" ? input.previous.value.waitingOn : [];
}

function responsibilitySourceIds(input: CreateNotificationCausesInput): ReadonlySet<SourceId> {
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

function eventMayAffectResponsibility(
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

function unsupportedEventInWindow(
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

function mappedEventFor(
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

function evidenceFromEvents(
  events: readonly NormalizedEvent[],
): readonly [NotificationCauseEvidence, ...NotificationCauseEvidence[]] | undefined {
  const evidenceBySourceId = new Map<SourceId, NotificationCauseEvidence>();
  for (const event of events) {
    if (event.actor.type !== "human") {
      return undefined;
    }
    const actor = notificationCauseHumanActor(event.actor);
    assertNonNullable(actor, "cause evidenceのactorを取得できませんでした");
    evidenceBySourceId.set(
      event.sourceId,
      Object.freeze({
        sourceId: event.sourceId,
        occurredAt: event.occurredAt,
        actor,
      }),
    );
  }
  const evidence = [...evidenceBySourceId.values()].sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return compareSourceIds(left.sourceId, right.sourceId);
  });
  const [first, ...rest] = evidence;
  if (first == null) {
    return undefined;
  }
  return Object.freeze([first, ...rest]);
}

function mergeEvidence(
  evidenceGroups: readonly (readonly NotificationCauseEvidence[])[],
): NotificationCauseEvidenceList | undefined {
  const evidenceBySourceId = new Map<SourceId, NotificationCauseEvidence>();
  for (const evidenceGroup of evidenceGroups) {
    for (const evidence of evidenceGroup) {
      evidenceBySourceId.set(evidence.sourceId, evidence);
    }
  }
  const evidence = [...evidenceBySourceId.values()].sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return compareSourceIds(left.sourceId, right.sourceId);
  });
  const [first, ...rest] = evidence;
  if (first == null) {
    return undefined;
  }
  return Object.freeze([first, ...rest]);
}

function hasWaitingOnDifference(difference: WaitingOnDifference): boolean {
  return difference.added.length > 0 || difference.removed.length > 0;
}

function localWaitingOnDifference(difference: WaitingOnDifference): WaitingOnDifference {
  return Object.freeze({
    added: Object.freeze(difference.added.filter((waitingOn) => !isDependencyWaitingOn(waitingOn))),
    removed: Object.freeze(
      difference.removed.filter((waitingOn) => !isDependencyWaitingOn(waitingOn)),
    ),
  });
}

function localWaitingOn(waitingOn: readonly WaitingOn[]): readonly WaitingOn[] {
  return Object.freeze(waitingOn.filter((value) => !isDependencyWaitingOn(value)));
}

function waitingOnSignaturesEqual(
  left: readonly WaitingOn[],
  right: readonly WaitingOn[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSignatures = new Set(right.map(waitingOnSignature));
  return left.every((waitingOn) => rightSignatures.has(waitingOnSignature(waitingOn)));
}

function responsibilityBasisEvents(
  input: CreateNotificationCausesInput,
): readonly NormalizedEvent[] | undefined {
  const eventsBySourceId = new Map<SourceId, NormalizedEvent>();
  for (const event of input.item.events) {
    eventsBySourceId.set(event.sourceId, event);
  }
  const events: NormalizedEvent[] = [];
  for (const sourceId of input.currentResponsibilityBasis.sourceIds) {
    const event = eventsBySourceId.get(sourceId);
    if (event == null) {
      return undefined;
    }
    events.push(event);
  }
  return Object.freeze(events);
}

function responsibilityBasisEventMatchesWaitingOn(
  event: NormalizedEvent,
  item: FreshObservedGitHubItem,
  waitingOn: WaitingOn,
  responsible: NotificationCauseActor,
): boolean {
  switch (event.kind) {
    case "assignee":
      return (
        waitingOn.kind === "user" &&
        waitingOn.role === "assignee" &&
        event.action === "added" &&
        event.assignee.nodeId === responsible.nodeId &&
        event.assignee.login.toLowerCase() === waitingOn.candidateId.toLowerCase()
      );
    case "converted_to_draft":
      return (
        item.type === "pull_request" &&
        waitingOn.kind === "role" &&
        waitingOn.candidateId === "author" &&
        waitingOn.role === "author"
      );
    case "push":
      return (
        item.type === "pull_request" &&
        waitingOn.kind === "user" &&
        waitingOn.role === "reviewer" &&
        event.headCommitSha === item.headCommit.sha
      );
    case "review":
      return (
        item.type === "pull_request" &&
        waitingOn.kind === "role" &&
        waitingOn.candidateId === "author" &&
        waitingOn.role === "author" &&
        event.state === "changes_requested"
      );
    case "review_request":
      return (
        item.type === "pull_request" &&
        waitingOn.kind === "user" &&
        waitingOn.role === "reviewer" &&
        event.action === "added" &&
        event.target.type === "user" &&
        event.target.nodeId === responsible.nodeId
      );
    case "comment":
    case "ready_for_review":
    case "label":
    case "state":
    case "relation":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return false;
    default:
      throw new UnreachableError(event);
  }
}

function currentResponsibilityWasContinuous(
  input: CreateNotificationCausesInput,
  responsible: NotificationCauseActor,
): boolean {
  if (input.previous.availability === "not_available") {
    return false;
  }
  const currentLocalWaitingOn = localWaitingOn(input.currentWaitingOn);
  if (currentLocalWaitingOn.length !== 1) {
    return false;
  }
  const previous = input.previous;
  const previousLocalWaitingOn = localWaitingOn(previous.value.waitingOn);
  if (waitingOnSignaturesEqual(previousLocalWaitingOn, currentLocalWaitingOn)) {
    const previousResponsible = actorForWaitingOn(input.item, previousLocalWaitingOn);
    return previousResponsible?.nodeId === responsible.nodeId;
  }
  if (previousLocalWaitingOn.length !== 0) {
    return false;
  }
  const current = currentLocalWaitingOn[0];
  assertNonNullable(current, "現在のlocal waitingOnを取得できませんでした");
  const basisEvents = responsibilityBasisEvents(input);
  if (basisEvents == null || basisEvents.length === 0) {
    return false;
  }
  const earliestBasisEvent = basisEvents.reduce((earliest, event) =>
    event.occurredAt < earliest.occurredAt ? event : earliest,
  );
  if (earliestBasisEvent.occurredAt !== input.currentResponsibilityBasis.occurredAt) {
    return false;
  }
  return basisEvents.every(
    (event) =>
      event.occurredAt <= previous.value.observedAt &&
      responsibilityBasisEventMatchesWaitingOn(event, input.item, current, responsible),
  );
}

function dependencyExplainedDifference(
  input: CreateNotificationCausesInput,
  difference: WaitingOnDifference,
  responsible: NotificationCauseActor,
): WaitingOnDifference {
  if (input.previous.availability === "not_available") {
    return difference;
  }
  const localDifference = localWaitingOnDifference(difference);
  const previousLocalWaitingOn = localWaitingOn(input.previous.value.waitingOn);
  if (
    localDifference.removed.length !== 0 ||
    localDifference.added.length !== 1 ||
    previousLocalWaitingOn.length !== 0 ||
    !currentResponsibilityWasContinuous(input, responsible)
  ) {
    return difference;
  }
  const added = localDifference.added[0];
  assertNonNullable(added, "依存解消で説明するlocal waitingOnを取得できませんでした");
  const currentLocalWaitingOn = localWaitingOn(input.currentWaitingOn);
  const current = currentLocalWaitingOn[0];
  assertNonNullable(current, "依存解消後のlocal waitingOnを取得できませんでした");
  if (waitingOnSignature(added) !== waitingOnSignature(current)) {
    return difference;
  }
  return Object.freeze({
    added: Object.freeze(
      difference.added.filter(
        (waitingOn) => waitingOnSignature(waitingOn) !== waitingOnSignature(added),
      ),
    ),
    removed: difference.removed,
  });
}

function dependencyEvidenceSourceIds(
  dependencyCause: NotificationDependencyCause,
): ReadonlySet<SourceId> {
  return new Set(
    dependencyCause.status === "complete"
      ? dependencyCause.evidence.map((evidence) => evidence.sourceId)
      : [],
  );
}

function verifiedSelfCommitmentEvidence(
  input: CreateNotificationCausesInput,
): readonly NotificationCauseEvidence[] {
  const cause = input.selfCommitmentCause;
  if (cause.status !== "complete") {
    return [];
  }
  if (input.previous.availability === "not_available") {
    return [];
  }
  const previousObservedAt = input.previous.value.observedAt;
  for (const evidence of cause.evidence) {
    const event = input.item.events.find((candidate) => candidate.sourceId === evidence.sourceId);
    if (
      event?.kind !== "comment" ||
      event.actor.type !== "human" ||
      event.actor.nodeId !== cause.responsible.nodeId ||
      event.actor.nodeId !== evidence.actor.nodeId ||
      !eventInWindow(event, previousObservedAt, input.evaluatedAt)
    ) {
      return [];
    }
  }
  return cause.evidence;
}

function selfCommitmentEvidenceForWaitingOn(
  waitingOn: WaitingOn,
  evidence: readonly NotificationCauseEvidence[],
): readonly NotificationCauseEvidence[] {
  return evidence.filter((entry) => waitingOn.sourceIds.includes(entry.sourceId));
}

function selfCommitmentExplainsWaitingOn(
  input: CreateNotificationCausesInput,
  waitingOn: WaitingOn,
  evidence: readonly NotificationCauseEvidence[],
): boolean {
  const cause = input.selfCommitmentCause;
  if (cause.status !== "complete") {
    return false;
  }
  const responsible = actorForWaitingOnEntry(input.item, waitingOn);
  return (
    responsible?.nodeId === cause.responsible.nodeId &&
    selfCommitmentEvidenceForWaitingOn(waitingOn, evidence).length > 0
  );
}

function hasRelevantUnobservedHeadChange(input: CreateNotificationCausesInput): boolean {
  if (!input.hasUnobservedHeadChange || input.item.type !== "pull_request") {
    return false;
  }
  if (input.previous.availability === "not_available") {
    return false;
  }
  const previousObservedAt = input.previous.value.observedAt;
  const item = input.item;
  return (
    responsibilitySourceIds(input).has(item.headCommit.sourceId) &&
    !item.events.some(
      (event) =>
        event.kind === "push" &&
        event.forcePush &&
        event.headCommitSha === item.headSha &&
        event.actor.type === "human" &&
        eventInWindow(event, previousObservedAt, input.evaluatedAt),
    )
  );
}

function localResponsibilityCause(
  input: CreateNotificationCausesInput,
  difference: WaitingOnDifference,
  dependencyCause: NotificationDependencyCause,
): LocalCauseResolution {
  const localDifference = localWaitingOnDifference(difference);
  if (!hasWaitingOnDifference(localDifference)) {
    return Object.freeze({ status: "not_applicable" });
  }
  const dependencySourceIds = dependencyEvidenceSourceIds(dependencyCause);
  const events = eventsInWindow(input).filter((event) => !dependencySourceIds.has(event.sourceId));
  const selfEvidence = verifiedSelfCommitmentEvidence(input);
  const selfSourceIds = new Set(selfEvidence.map((evidence) => evidence.sourceId));
  if (
    events.some(
      (event) =>
        event.kind === "comment" &&
        responsibilitySourceIds(input).has(event.sourceId) &&
        !selfSourceIds.has(event.sourceId),
    )
  ) {
    return Object.freeze({ status: "indeterminate" });
  }
  if (events.some((event) => unsupportedEventInWindow(event, input, localDifference))) {
    return Object.freeze({ status: "indeterminate" });
  }
  const mappedEvents = events.flatMap((event) => {
    const mapped = mappedEventFor(event, input, input.item, localDifference);
    return mapped == null ? [] : [mapped];
  });
  const addedSignatures = new Set<string>();
  const removedSignatures = new Set<string>();
  const causeEvents: NormalizedEvent[] = [];
  for (const mapped of mappedEvents) {
    if (mapped.event.actor.type !== "human") {
      return Object.freeze({ status: "indeterminate" });
    }
    for (const signature of mapped.addedSignatures) {
      addedSignatures.add(signature);
    }
    for (const signature of mapped.removedSignatures) {
      removedSignatures.add(signature);
    }
    causeEvents.push(mapped.event);
  }
  const expectedAddedSignatures = new Set(localDifference.added.map(waitingOnSignature));
  const expectedRemovedSignatures = new Set(localDifference.removed.map(waitingOnSignature));
  const selfTransitionAdded = localDifference.added.filter((waitingOn) =>
    selfCommitmentExplainsWaitingOn(input, waitingOn, selfEvidence),
  );
  for (const waitingOn of localDifference.added) {
    if (selfCommitmentExplainsWaitingOn(input, waitingOn, selfEvidence)) {
      addedSignatures.add(waitingOnSignature(waitingOn));
    }
  }
  if (selfTransitionAdded.length === 1 && localDifference.added.length === 1) {
    for (const waitingOn of localDifference.removed) {
      removedSignatures.add(waitingOnSignature(waitingOn));
    }
  }
  if (
    addedSignatures.size !== expectedAddedSignatures.size ||
    [...expectedAddedSignatures].some((signature) => !addedSignatures.has(signature)) ||
    removedSignatures.size !== expectedRemovedSignatures.size ||
    [...expectedRemovedSignatures].some((signature) => !removedSignatures.has(signature))
  ) {
    return Object.freeze({ status: "indeterminate" });
  }
  const evidence = mergeEvidence([
    evidenceFromEvents(causeEvents) ?? [],
    selfEvidence.filter((entry) =>
      [...localDifference.added, ...localDifference.removed].some((waitingOn) =>
        waitingOn.sourceIds.includes(entry.sourceId),
      ),
    ),
  ]);
  if (evidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({ status: "complete", evidence });
}

function eventMayAffectNewlyUnblockedResponsibility(
  event: NormalizedEvent,
  input: CreateNotificationCausesInput,
): boolean {
  if (event.kind === "assignee") {
    return (
      responsibilitySourceIds(input).has(event.sourceId) ||
      [...input.currentWaitingOn, ...previousWaitingOn(input)].some((waitingOn) =>
        eventAssigneeMatches(event, waitingOn),
      )
    );
  }
  if (event.kind === "comment") {
    return responsibilitySourceIds(input).has(event.sourceId);
  }
  const difference = waitingOnDifference(previousWaitingOn(input), input.currentWaitingOn);
  return eventMayAffectResponsibility(event, input, difference);
}

function newlyUnblockedLocalCause(
  input: CreateNotificationCausesInput,
  dependencyCause: NotificationDependencyCause,
): LocalCauseResolution {
  const dependencySourceIds = dependencyEvidenceSourceIds(dependencyCause);
  const selfEvidence = verifiedSelfCommitmentEvidence(input);
  const selfSourceIds = new Set(selfEvidence.map((evidence) => evidence.sourceId));
  const events = eventsInWindow(input).filter(
    (event) =>
      !dependencySourceIds.has(event.sourceId) &&
      eventMayAffectNewlyUnblockedResponsibility(event, input),
  );
  if (events.some((event) => event.kind === "comment" && !selfSourceIds.has(event.sourceId))) {
    return Object.freeze({ status: "indeterminate" });
  }
  if (events.length === 0) {
    return Object.freeze({ status: "not_applicable" });
  }
  const relevantSelfEvidence = selfEvidence.filter((entry) =>
    events.some((event) => event.sourceId === entry.sourceId),
  );
  const causeEvents: NormalizedEvent[] = [];
  for (const event of events) {
    if (event.actor.type !== "human") {
      return Object.freeze({ status: "indeterminate" });
    }
    switch (event.kind) {
      case "assignee":
      case "ready_for_review":
      case "converted_to_draft":
      case "review":
      case "review_request":
        causeEvents.push(event);
        break;
      case "push":
        if (!event.forcePush) {
          return Object.freeze({ status: "indeterminate" });
        }
        causeEvents.push(event);
        break;
      case "comment":
        break;
      case "label":
      case "state":
      case "relation":
      case "added_to_merge_queue":
      case "removed_from_merge_queue":
      case "auto_merge_enabled":
      case "auto_merge_disabled":
        return Object.freeze({ status: "indeterminate" });
      default:
        throw new UnreachableError(event);
    }
  }
  const evidence = mergeEvidence([evidenceFromEvents(causeEvents) ?? [], relevantSelfEvidence]);
  if (evidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({ status: "complete", evidence });
}

function newlyUnblockedCause(input: CreateNotificationCausesInput): NotificationCause {
  if (input.dependencyCause.status !== "complete") {
    return Object.freeze({ status: "indeterminate" });
  }
  if (hasRelevantUnobservedHeadChange(input)) {
    return Object.freeze({ status: "indeterminate" });
  }
  if (input.previous.availability === "not_available") {
    return Object.freeze({ status: "indeterminate" });
  }
  const responsible = actorForWaitingOn(input.item, input.currentWaitingOn);
  if (responsible == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  const difference = waitingOnDifference(previousWaitingOn(input), input.currentWaitingOn);
  const causeDifference = dependencyExplainedDifference(input, difference, responsible);
  const localCause = localResponsibilityCause(input, causeDifference, input.dependencyCause);
  if (localCause.status === "indeterminate") {
    return Object.freeze({ status: "indeterminate" });
  }
  if (
    localCause.status === "not_applicable" &&
    !currentResponsibilityWasContinuous(input, responsible)
  ) {
    return Object.freeze({ status: "indeterminate" });
  }
  const additionalLocalCause = newlyUnblockedLocalCause(input, input.dependencyCause);
  if (additionalLocalCause.status === "indeterminate") {
    return Object.freeze({ status: "indeterminate" });
  }
  const evidence = mergeEvidence([
    input.dependencyCause.evidence,
    localCause.status === "complete" ? localCause.evidence : [],
    additionalLocalCause.status === "complete" ? additionalLocalCause.evidence : [],
  ]);
  if (evidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    responsible: Object.freeze({ ...responsible }),
    evidence,
  });
}

function validateCauseInput(input: CreateNotificationCausesInput): void {
  if (input.item.observedAt > input.evaluatedAt) {
    throw new RangeError("項目の観測時刻は評価時刻以前でなければなりません");
  }
  if (input.currentResponsibilityBasis.occurredAt > input.evaluatedAt) {
    throw new RangeError("現在の責務根拠の発生時刻は評価時刻以前でなければなりません");
  }
  if (
    input.previous.availability === "available" &&
    input.previous.value.observedAt > input.evaluatedAt
  ) {
    throw new RangeError("前回観測時刻は評価時刻以前でなければなりません");
  }
  if (
    new Set(input.currentResponsibilityBasis.sourceIds).size !==
    input.currentResponsibilityBasis.sourceIds.length
  ) {
    throw new TypeError("現在の責務根拠のsource IDが重複しています");
  }
  notificationDependencyCauseSchema.parse(input.dependencyCause);
  notificationCauseSchema.parse(input.selfCommitmentCause);
  for (const event of input.item.events) {
    if (event.itemNodeId !== input.item.nodeId) {
      throw new TypeError("項目と正規化イベントのitem node IDが一致しません");
    }
  }
}

function responsibilityChangedCause(input: CreateNotificationCausesInput): NotificationCause {
  if (input.previous.availability === "not_available") {
    return Object.freeze({ status: "indeterminate" });
  }
  if (hasRelevantUnobservedHeadChange(input)) {
    return Object.freeze({ status: "indeterminate" });
  }
  const responsible = actorForWaitingOn(input.item, input.currentWaitingOn);
  if (responsible == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  const difference = waitingOnDifference(input.previous.value.waitingOn, input.currentWaitingOn);
  if (!hasWaitingOnDifference(difference)) {
    return Object.freeze({ status: "indeterminate" });
  }
  const dependencyChanged = [...difference.added, ...difference.removed].some(
    isDependencyWaitingOn,
  );
  const dependencyEvidence =
    dependencyChanged && input.dependencyCause.status === "complete"
      ? input.dependencyCause.evidence
      : [];
  if (dependencyChanged && input.dependencyCause.status !== "complete") {
    return Object.freeze({ status: "indeterminate" });
  }
  const causeDifference = dependencyExplainedDifference(input, difference, responsible);
  const localCause = localResponsibilityCause(input, causeDifference, input.dependencyCause);
  if (localCause.status === "indeterminate") {
    return Object.freeze({ status: "indeterminate" });
  }
  if (localCause.status === "not_applicable" && !dependencyChanged) {
    return Object.freeze({ status: "indeterminate" });
  }
  const evidence = mergeEvidence([
    dependencyEvidence,
    localCause.status === "complete" ? localCause.evidence : [],
  ]);
  if (evidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    responsible: Object.freeze({ ...responsible }),
    evidence,
  });
}

/** 同一項目のtimelineから通知理由ごとのcauseを生成する。 */
export function createNotificationCauses(input: CreateNotificationCausesInput): NotificationCauses {
  validateCauseInput(input);
  return Object.freeze({
    responsibility_changed: responsibilityChangedCause(input),
    newly_unblocked: newlyUnblockedCause(input),
  });
}

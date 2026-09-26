import type {
  GraphNodeId,
  NormalizedEvent,
  Relation,
  SourceId,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type {
  NotificationCauseEvidence,
  NotificationDependencyCause,
} from "../../../discord/index.js";
import type { EnumeratedGitHubItem, FreshObservedGitHubItem } from "../../../github/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { CollectedItems } from "../contracts.js";
import type { RelationProgressEvent } from "./dependency-resolution-contracts.js";
import { enumeratedTerminal } from "./dependency-resolution-indexes.js";
import { relationProgressKey } from "./dependency-resolution-keys.js";

type NotificationCauseEvidenceList = readonly [
  NotificationCauseEvidence,
  ...NotificationCauseEvidence[],
];

type DependencyBlockerCause =
  | Readonly<{
      status: "complete";
      evidence: readonly NotificationCauseEvidence[];
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

function notificationCauseEvidenceForEvent(
  event: NormalizedEvent,
): NotificationCauseEvidence | undefined {
  const actor = event.actor;
  if (actor.type !== "human") {
    return undefined;
  }
  const humanActor: NotificationCauseEvidence["actor"] = Object.freeze({
    type: "human",
    nodeId: actor.nodeId,
    login: actor.login,
  });
  return Object.freeze({
    sourceId: event.sourceId,
    occurredAt: event.occurredAt,
    actor: humanActor,
  });
}

type RelationCauseResolution =
  | Readonly<{
      status: "not_applicable";
      evidence: readonly NotificationCauseEvidence[];
    }>
  | Readonly<{
      status: "complete";
      evidence: readonly NotificationCauseEvidence[];
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

function nonEmptyNotificationCauseEvidence(
  evidence: readonly NotificationCauseEvidence[],
): NotificationCauseEvidenceList | undefined {
  const evidenceBySourceId = new Map<SourceId, NotificationCauseEvidence>();
  for (const entry of evidence) {
    evidenceBySourceId.set(entry.sourceId, entry);
  }
  const sortedEvidence = [...evidenceBySourceId.values()].sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return left.sourceId.localeCompare(right.sourceId);
  });
  const [first, ...rest] = sortedEvidence;
  if (first == null) {
    return undefined;
  }
  return Object.freeze([first, ...rest]);
}

function terminalCauseForBlocker(
  collection: CollectedItems,
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>,
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>,
  blockerNodeId: GraphNodeId,
  previousObservedAt: UtcIsoDateTime,
): DependencyBlockerCause | undefined {
  const terminal = enumeratedTerminal(enumeratedItemsByNodeId.get(blockerNodeId));
  if (terminal == null) {
    return undefined;
  }
  if (terminal.occurredAt <= previousObservedAt || terminal.occurredAt > collection.evaluatedAt) {
    return Object.freeze({ status: "indeterminate" });
  }
  const observed = observedItemsByNodeId.get(blockerNodeId);
  if (observed == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  const matchingEvents = observed.events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "state" }> =>
      event.kind === "state" &&
      event.itemNodeId === blockerNodeId &&
      event.state === terminal.state &&
      event.occurredAt === terminal.occurredAt &&
      event.occurredAt > previousObservedAt &&
      event.occurredAt <= collection.evaluatedAt,
  );
  if (matchingEvents.length !== 1) {
    return Object.freeze({ status: "indeterminate" });
  }
  const event = matchingEvents[0];
  assertNonNullable(event, `blocker ${blockerNodeId}のterminal state eventがありません`);
  const evidence = notificationCauseEvidenceForEvent(event);
  if (evidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    evidence: Object.freeze([evidence]),
  });
}

function relationCauseForEdge(
  collection: CollectedItems,
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>,
  edge: Relation,
  previousObservedAt: UtcIsoDateTime,
): RelationCauseResolution {
  const matchingEvents = (
    relationEventsByKey.get(
      relationProgressKey(edge.type, edge.provenance, edge.fromNodeId, edge.toNodeId),
    ) ?? []
  )
    .filter(
      (event) =>
        event.target.type === "node" &&
        event.relationType === edge.type &&
        event.provenance === edge.provenance &&
        event.occurredAt >= edge.firstSeenAt &&
        event.occurredAt > previousObservedAt &&
        event.occurredAt <= collection.evaluatedAt &&
        (event.direction === "from_item"
          ? event.itemNodeId === edge.fromNodeId && event.target.nodeId === edge.toNodeId
          : event.itemNodeId === edge.toNodeId && event.target.nodeId === edge.fromNodeId),
    )
    .sort((left, right) => {
      if (left.occurredAt < right.occurredAt) {
        return -1;
      }
      if (left.occurredAt > right.occurredAt) {
        return 1;
      }
      return left.sourceId.localeCompare(right.sourceId);
    });
  const latestEvent = matchingEvents.at(-1);
  if (latestEvent == null) {
    return Object.freeze({ status: "not_applicable", evidence: Object.freeze([]) });
  }
  const latestEvents = matchingEvents.filter(
    (event) => event.occurredAt === latestEvent.occurredAt,
  );
  const hasAddedEvent = latestEvents.some((event) => event.action === "added");
  const hasRemovedEvent = latestEvents.some((event) => event.action === "removed");
  if (hasAddedEvent && hasRemovedEvent) {
    return Object.freeze({ status: "indeterminate" });
  }
  if (!hasRemovedEvent) {
    return Object.freeze({ status: "not_applicable", evidence: Object.freeze([]) });
  }
  const evidence: NotificationCauseEvidence[] = [];
  for (const event of matchingEvents) {
    if (event.action !== "removed") {
      continue;
    }
    const eventEvidence = notificationCauseEvidenceForEvent(event);
    if (eventEvidence == null) {
      return Object.freeze({ status: "indeterminate" });
    }
    evidence.push(eventEvidence);
  }
  return Object.freeze({ status: "complete", evidence: Object.freeze(evidence) });
}

function dependencyCauseForBlocker(
  collection: CollectedItems,
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>,
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>,
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>,
  blockerNodeId: GraphNodeId,
  edges: readonly (Relation & Readonly<{ active: true }>)[],
  previousObservedAt: UtcIsoDateTime,
): DependencyBlockerCause {
  const terminalCause = terminalCauseForBlocker(
    collection,
    enumeratedItemsByNodeId,
    observedItemsByNodeId,
    blockerNodeId,
    previousObservedAt,
  );
  if (terminalCause?.status === "indeterminate") {
    return terminalCause;
  }
  const relationEvidence: NotificationCauseEvidence[] = [];
  let allRelationsRemoved = true;
  for (const edge of edges) {
    const relationCause = relationCauseForEdge(
      collection,
      relationEventsByKey,
      edge,
      previousObservedAt,
    );
    if (relationCause.status === "indeterminate") {
      return Object.freeze({ status: "indeterminate" });
    }
    if (relationCause.status === "not_applicable") {
      allRelationsRemoved = false;
    } else {
      relationEvidence.push(...relationCause.evidence);
    }
  }
  if (terminalCause == null && !allRelationsRemoved) {
    return Object.freeze({ status: "indeterminate" });
  }
  const completeEvidence = nonEmptyNotificationCauseEvidence([
    ...(terminalCause?.status === "complete" ? terminalCause.evidence : []),
    ...relationEvidence,
  ]);
  if (completeEvidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({ status: "complete", evidence: completeEvidence });
}

/** 複数のblockerから通知の依存解消原因を確定する。 */
export function dependencyCauseForBlockers(
  collection: CollectedItems,
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>,
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>,
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>,
  edgesByBlockerNodeId: ReadonlyMap<
    GraphNodeId,
    readonly (Relation & Readonly<{ active: true }>)[]
  >,
  previousObservedAt: UtcIsoDateTime,
): NotificationDependencyCause {
  const evidence: NotificationCauseEvidence[] = [];
  for (const [blockerNodeId, edges] of edgesByBlockerNodeId) {
    const blockerCause = dependencyCauseForBlocker(
      collection,
      enumeratedItemsByNodeId,
      observedItemsByNodeId,
      relationEventsByKey,
      blockerNodeId,
      edges,
      previousObservedAt,
    );
    if (blockerCause.status === "indeterminate") {
      return Object.freeze({ status: "indeterminate" });
    }
    evidence.push(...blockerCause.evidence);
  }
  const completeEvidence = nonEmptyNotificationCauseEvidence(evidence);
  if (completeEvidence == null) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    evidence: completeEvidence,
  });
}

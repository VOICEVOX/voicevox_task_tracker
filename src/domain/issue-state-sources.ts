import { assertNonNullable } from "../util/index.js";
import type {
  AssigneeEvent,
  AssigneeEventReplay,
  IssueExplicitRequestCandidate,
} from "./issue-state-contracts.js";
import { type SourceId } from "./source-id.js";
import { type GitHubAccountActor, type NormalizedEvent } from "./types.js";

export function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function createSourceIds(
  sourceIds: readonly SourceId[],
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

export function compareCandidates(
  left: IssueExplicitRequestCandidate,
  right: IssueExplicitRequestCandidate,
): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

export function compareEvents(left: NormalizedEvent, right: NormalizedEvent): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

export function replayAssigneeEvents(events: readonly NormalizedEvent[]): AssigneeEventReplay {
  const activeAssignmentByAssigneeNodeId = new Map<GitHubAccountActor["nodeId"], AssigneeEvent>();
  let lastUnassignedEvent: AssigneeEvent | undefined;
  const assigneeEvents = events
    .filter((event): event is AssigneeEvent => event.kind === "assignee")
    .sort(compareEvents);

  for (const event of assigneeEvents) {
    if (event.action === "added") {
      activeAssignmentByAssigneeNodeId.set(event.assignee.nodeId, event);
      continue;
    }

    const removedActiveAssignment = activeAssignmentByAssigneeNodeId.delete(event.assignee.nodeId);
    if (removedActiveAssignment && activeAssignmentByAssigneeNodeId.size === 0) {
      lastUnassignedEvent = event;
    }
  }

  return Object.freeze({
    activeAssignmentByAssigneeNodeId,
    lastUnassignedEvent,
  });
}

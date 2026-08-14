import { z } from "zod";

import { type DependencyReplayInputEvent } from "../graph/dependency-replay-types.js";
import { type GitHubNodeId } from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { type GitHubReferencedItem, type GitHubTimelineEvent } from "./item-detail-types.js";

type GitHubDependencyTimelineEvent = Extract<
  GitHubTimelineEvent,
  {
    kind: "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";
  }
>;

type GitHubUnavailableReferencedItem = Readonly<{
  status: "unavailable";
  reason: "github_did_not_return_item";
}>;
type GitHubDependencyRelatedItem = GitHubReferencedItem | GitHubUnavailableReferencedItem;

type RelatedNodeResolution =
  | Readonly<{
      status: "resolved";
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "unresolved";
      reason: "related_node_unavailable";
    }>;

const unavailableReferencedItemSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: z.literal("github_did_not_return_item"),
  })
  .strict();

function isDependencyTimelineEvent(
  event: GitHubTimelineEvent,
): event is GitHubDependencyTimelineEvent {
  switch (event.kind) {
    case "blocked_by_added":
    case "blocked_by_removed":
    case "blocking_added":
    case "blocking_removed":
      return true;
    default:
      return false;
  }
}

function resolveRelatedNode(item: GitHubDependencyRelatedItem | null): RelatedNodeResolution {
  assertNonNullable(item, "依存関係イベントの相手項目がありません");
  if ("status" in item) {
    const validation = unavailableReferencedItemSchema.safeParse(item);
    if (!validation.success) {
      throw new TypeError("依存関係イベントの相手項目状態が不正です", {
        cause: validation.error,
      });
    }
    return Object.freeze({
      status: "unresolved",
      reason: "related_node_unavailable",
    });
  }
  return Object.freeze({
    status: "resolved",
    nodeId: item.nodeId,
  });
}

function createAdaptedEvent(
  event: GitHubDependencyTimelineEvent,
  relatedItem: GitHubDependencyRelatedItem,
  action: "added" | "removed",
  direction: "blocked_by" | "blocking",
): DependencyReplayInputEvent {
  const relatedNode = resolveRelatedNode(relatedItem);
  if (relatedNode.status === "unresolved") {
    return Object.freeze({
      status: "unresolved",
      sourceId: event.sourceId,
      originItemNodeId: event.nodeId,
      direction,
      action,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      reason: relatedNode.reason,
    });
  }
  const fromNodeId = direction === "blocked_by" ? relatedNode.nodeId : event.nodeId;
  const toNodeId = direction === "blocked_by" ? event.nodeId : relatedNode.nodeId;
  return Object.freeze({
    status: "resolved",
    sourceId: event.sourceId,
    originItemNodeId: event.nodeId,
    fromNodeId,
    toNodeId,
    action,
    occurredAt: event.occurredAt,
    sequence: event.sequence,
  });
}

function adaptDependencyEvent(event: GitHubDependencyTimelineEvent): DependencyReplayInputEvent {
  switch (event.kind) {
    case "blocked_by_added":
      return createAdaptedEvent(event, event.blockingIssue, "added", "blocked_by");
    case "blocked_by_removed":
      return createAdaptedEvent(event, event.blockingIssue, "removed", "blocked_by");
    case "blocking_added":
      return createAdaptedEvent(event, event.blockedIssue, "added", "blocking");
    case "blocking_removed":
      return createAdaptedEvent(event, event.blockedIssue, "removed", "blocking");
    default:
      throw new UnreachableError(event);
  }
}

/** GitHub timelineの依存関係専用イベントだけをcanonicalな入力へ変換する。 */
export function adaptGitHubDependencyEvents(
  events: readonly GitHubTimelineEvent[],
): readonly DependencyReplayInputEvent[] {
  const adaptedEvents: DependencyReplayInputEvent[] = [];
  for (const event of events) {
    if (isDependencyTimelineEvent(event)) {
      adaptedEvents.push(adaptDependencyEvent(event));
    }
  }
  return Object.freeze(adaptedEvents);
}

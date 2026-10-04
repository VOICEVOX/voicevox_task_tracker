import { z } from "zod";

import {
  createGitHubNodeId,
  type GitHubNodeId,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { GitHubResponseValidationError } from "./errors.js";
import {
  normalizeActor,
  normalizeAssignee,
  normalizeForcePushCommitSha,
  normalizeReferencedItem,
  normalizeReviewRequestTarget,
  normalizeTimelineReferencedItem,
} from "./item-detail-accounts.js";
import { parseGraphqlResponse } from "./item-detail-connection.js";
import type {
  commitSchema,
  RawTimelineNode,
  timelineEventBaseSchema,
} from "./item-detail-response-schema.js";
import {
  addedToMergeQueueEventSchema,
  assignedEventSchema,
  autoMergeDisabledEventSchema,
  autoMergeEnabledEventSchema,
  closedEventSchema,
  connectedEventSchema,
  convertToDraftEventSchema,
  crossReferencedEventSchema,
  disconnectedEventSchema,
  headRefForcePushedEventSchema,
  labeledEventSchema,
  mergedEventSchema,
  parentIssueAddedEventSchema,
  parentIssueRemovedEventSchema,
  pullRequestCommitEventSchema,
  readyForReviewEventSchema,
  removedFromMergeQueueEventSchema,
  reopenedEventSchema,
  reviewRequestedEventSchema,
  reviewRequestRemovedEventSchema,
  subIssueAddedEventSchema,
  subIssueRemovedEventSchema,
  unassignedEventSchema,
  unlabeledEventSchema,
} from "./item-detail-response-schema.js";
import {
  type GitHubCommitPushedAt,
  type GitHubDetailActor,
  type GitHubInboundCrossReferenceCandidate,
  type GitHubPullRequestCommit,
  type GitHubTimelineEvent,
} from "./item-detail-types.js";
import { type EnumeratedGitHubItem } from "./item-enumeration.js";
import { buildProductionSourceId, buildPullRequestCommitSourceId } from "./production-source-id.js";

export function normalizeCommit(
  pullRequestNodeId: GitHubNodeId,
  commit: z.output<typeof commitSchema>,
): GitHubPullRequestCommit {
  const nodeId = createGitHubNodeId(commit.id);
  const pushedAt: GitHubCommitPushedAt =
    commit.pushedDate == null
      ? Object.freeze({
          status: "unavailable",
          reason: "github_did_not_return_pushed_at",
        })
      : Object.freeze({
          status: "available",
          value: commit.pushedDate,
        });
  return Object.freeze({
    sourceId: buildPullRequestCommitSourceId(pullRequestNodeId, nodeId),
    nodeId,
    sha: commit.oid,
    committedAt: commit.committedDate,
    pushedAt,
  });
}

function normalizeTimelineBase(
  event: z.output<typeof timelineEventBaseSchema>,
  sequence: number,
): Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  occurredAt: UtcIsoDateTime;
  actor: GitHubDetailActor;
}> {
  const nodeId = createGitHubNodeId(event.id);
  return {
    sourceId: buildProductionSourceId("github_timeline_event", nodeId),
    nodeId,
    sequence,
    occurredAt: event.createdAt,
    actor: normalizeActor(event.actor),
  };
}

function normalizeSimpleTimelineEvent(
  event: z.output<typeof timelineEventBaseSchema>,
  sequence: number,
  kind:
    | "closed"
    | "reopened"
    | "merged"
    | "ready_for_review"
    | "converted_to_draft"
    | "added_to_merge_queue"
    | "removed_from_merge_queue"
    | "auto_merge_enabled"
    | "auto_merge_disabled",
): GitHubTimelineEvent {
  return Object.freeze({
    ...normalizeTimelineBase(event, sequence),
    kind,
  });
}

function normalizeTimelineNode(
  node: RawTimelineNode,
  sequence: number,
  item: EnumeratedGitHubItem,
): GitHubTimelineEvent {
  switch (node.__typename) {
    case "ClosedEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(closedEventSchema, node, "ClosedEvent"),
        sequence,
        "closed",
      );
    case "ReopenedEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(reopenedEventSchema, node, "ReopenedEvent"),
        sequence,
        "reopened",
      );
    case "MergedEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(mergedEventSchema, node, "MergedEvent"),
        sequence,
        "merged",
      );
    case "AssignedEvent": {
      const event = parseGraphqlResponse(assignedEventSchema, node, "AssignedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "assigned",
        assignee: normalizeAssignee(event.assignee),
      });
    }
    case "UnassignedEvent": {
      const event = parseGraphqlResponse(unassignedEventSchema, node, "UnassignedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "unassigned",
        assignee: normalizeAssignee(event.assignee),
      });
    }
    case "LabeledEvent": {
      const event = parseGraphqlResponse(labeledEventSchema, node, "LabeledEvent");
      const labelNodeId = createGitHubNodeId(event.label.id);
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "labeled",
        label: Object.freeze({
          sourceId: buildProductionSourceId("github_label", labelNodeId),
          nodeId: labelNodeId,
          name: event.label.name,
        }),
      });
    }
    case "UnlabeledEvent": {
      const event = parseGraphqlResponse(unlabeledEventSchema, node, "UnlabeledEvent");
      const labelNodeId = createGitHubNodeId(event.label.id);
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "unlabeled",
        label: Object.freeze({
          sourceId: buildProductionSourceId("github_label", labelNodeId),
          nodeId: labelNodeId,
          name: event.label.name,
        }),
      });
    }
    case "ReviewRequestedEvent": {
      const event = parseGraphqlResponse(reviewRequestedEventSchema, node, "ReviewRequestedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "review_requested",
        target: normalizeReviewRequestTarget(event.requestedReviewer),
      });
    }
    case "ReviewRequestRemovedEvent": {
      const event = parseGraphqlResponse(
        reviewRequestRemovedEventSchema,
        node,
        "ReviewRequestRemovedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "review_request_removed",
        target: normalizeReviewRequestTarget(event.requestedReviewer),
      });
    }
    case "ReadyForReviewEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(readyForReviewEventSchema, node, "ReadyForReviewEvent"),
        sequence,
        "ready_for_review",
      );
    case "ConvertToDraftEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(convertToDraftEventSchema, node, "ConvertToDraftEvent"),
        sequence,
        "converted_to_draft",
      );
    case "CrossReferencedEvent": {
      const event = parseGraphqlResponse(crossReferencedEventSchema, node, "CrossReferencedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "cross_referenced",
        source: normalizeReferencedItem(event.source),
        willCloseTarget: event.willCloseTarget,
      });
    }
    case "ConnectedEvent": {
      const event = parseGraphqlResponse(connectedEventSchema, node, "ConnectedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "connected",
        subject: normalizeReferencedItem(event.subject),
      });
    }
    case "DisconnectedEvent": {
      const event = parseGraphqlResponse(disconnectedEventSchema, node, "DisconnectedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "disconnected",
        subject: normalizeReferencedItem(event.subject),
      });
    }
    case "SubIssueAddedEvent": {
      const event = parseGraphqlResponse(subIssueAddedEventSchema, node, "SubIssueAddedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "sub_issue_added",
        subIssue: normalizeTimelineReferencedItem(event.subIssue),
      });
    }
    case "SubIssueRemovedEvent": {
      const event = parseGraphqlResponse(subIssueRemovedEventSchema, node, "SubIssueRemovedEvent");
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "sub_issue_removed",
        subIssue: normalizeTimelineReferencedItem(event.subIssue),
      });
    }
    case "ParentIssueAddedEvent": {
      const event = parseGraphqlResponse(
        parentIssueAddedEventSchema,
        node,
        "ParentIssueAddedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "parent_issue_added",
        parent: normalizeTimelineReferencedItem(event.parent),
      });
    }
    case "ParentIssueRemovedEvent": {
      const event = parseGraphqlResponse(
        parentIssueRemovedEventSchema,
        node,
        "ParentIssueRemovedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "parent_issue_removed",
        parent: normalizeTimelineReferencedItem(event.parent),
      });
    }
    case "HeadRefForcePushedEvent": {
      const event = parseGraphqlResponse(
        headRefForcePushedEventSchema,
        node,
        "HeadRefForcePushedEvent",
      );
      return Object.freeze({
        ...normalizeTimelineBase(event, sequence),
        kind: "head_ref_force_pushed",
        beforeSha: normalizeForcePushCommitSha(event.beforeCommit),
        afterSha: normalizeForcePushCommitSha(event.afterCommit),
      });
    }
    case "PullRequestCommit": {
      const event = parseGraphqlResponse(pullRequestCommitEventSchema, node, "PullRequestCommit");
      const nodeId = createGitHubNodeId(event.id);
      if (item.type !== "pull_request") {
        throw new GitHubResponseValidationError("Pull Request timeline event", {
          cause: new TypeError("IssueのtimelineにPullRequestCommitがあります"),
        });
      }
      return Object.freeze({
        sourceId: buildProductionSourceId("github_timeline_event", nodeId),
        nodeId,
        sequence,
        kind: "commit_added",
        commit: normalizeCommit(item.nodeId, event.commit),
      });
    }
    case "AddedToMergeQueueEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(addedToMergeQueueEventSchema, node, "AddedToMergeQueueEvent"),
        sequence,
        "added_to_merge_queue",
      );
    case "RemovedFromMergeQueueEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(removedFromMergeQueueEventSchema, node, "RemovedFromMergeQueueEvent"),
        sequence,
        "removed_from_merge_queue",
      );
    case "AutoMergeEnabledEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(autoMergeEnabledEventSchema, node, "AutoMergeEnabledEvent"),
        sequence,
        "auto_merge_enabled",
      );
    case "AutoMergeDisabledEvent":
      return normalizeSimpleTimelineEvent(
        parseGraphqlResponse(autoMergeDisabledEventSchema, node, "AutoMergeDisabledEvent"),
        sequence,
        "auto_merge_disabled",
      );
    default:
      throw new GitHubResponseValidationError("timeline event", {
        cause: new TypeError(`未対応のtimeline eventです。種別: ${node.__typename}`),
      });
  }
}

export function normalizeTimeline(
  nodes: readonly RawTimelineNode[],
  item: EnumeratedGitHubItem,
): readonly GitHubTimelineEvent[] {
  return Object.freeze(nodes.map((node, sequence) => normalizeTimelineNode(node, sequence, item)));
}

export function collectInboundCrossReferences(
  targetNodeId: GitHubNodeId,
  timeline: readonly GitHubTimelineEvent[],
): readonly GitHubInboundCrossReferenceCandidate[] {
  const candidates: GitHubInboundCrossReferenceCandidate[] = [];
  for (const event of timeline) {
    if (event.kind !== "cross_referenced" || event.source.nodeId === targetNodeId) {
      continue;
    }
    candidates.push(
      Object.freeze({
        sourceId: buildProductionSourceId(
          "github_inbound_cross_reference",
          `${event.nodeId}:${event.source.nodeId}`,
        ),
        candidateOnly: true,
        provenance: "cross_reference",
        eventSourceId: event.sourceId,
        sourceItem: event.source,
        willCloseTarget: event.willCloseTarget,
      }),
    );
  }
  return Object.freeze(candidates);
}

import { parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { PersonalReminderItem } from "../../../domain/personal-reminder-planning.js";
import type { GitHubNodeId, NormalizedEvent, UtcIsoDateTime } from "../../../domain/types.js";
import type { GitHubItemDetail, GitHubTimelineEvent } from "../../../github/item-detail-types.js";
import {
  buildProductionSourceId,
  buildPullRequestCommitSourceId,
} from "../../../github/production-source-id.js";
import { RunCompletenessError } from "./run-completeness-error.js";

/** 詳細と正規化イベントの双方で実測時刻を確認した個人催促時計source。 */
export type PersonalReminderClockEventSource = Readonly<{
  sourceId: SourceId;
  itemNodeId: GitHubNodeId;
  kind: NormalizedEvent["kind"] | "review_request";
  occurredAt: UtcIsoDateTime;
}>;

function clockSourceError(
  code: "missing_source" | "future_source" | "wrong_owner" | "kind_mismatch" | "source_id_conflict",
  sourceId: SourceId,
): RunCompletenessError {
  return new RunCompletenessError(
    code,
    sourceId,
    ["personalReminderCauses", "clock", sourceId],
    undefined,
  );
}

function assertDetailSourceId(
  sourceId: SourceId,
  kind:
    | "github_issue_comment"
    | "github_pull_request_review_comment"
    | "github_pull_request_review"
    | "github_timeline_event"
    | "github_review_request",
  nodeId: GitHubNodeId,
): void {
  if (sourceId !== buildProductionSourceId(kind, nodeId)) {
    throw clockSourceError("source_id_conflict", sourceId);
  }
}

function timelineEventKind(event: GitHubTimelineEvent): NormalizedEvent["kind"] | undefined {
  switch (event.kind) {
    case "assigned":
    case "unassigned":
      return "assignee";
    case "labeled":
    case "unlabeled":
      return "label";
    case "review_requested":
    case "review_request_removed":
      return "review_request";
    case "closed":
    case "reopened":
    case "merged":
      return "state";
    case "cross_referenced":
    case "connected":
    case "disconnected":
      return "relation";
    case "head_ref_force_pushed":
      return "push";
    case "ready_for_review":
    case "converted_to_draft":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return event.kind;
    case "sub_issue_added":
    case "sub_issue_removed":
    case "parent_issue_added":
    case "parent_issue_removed":
    case "commit_added":
      return undefined;
  }
}

function eventSourceFromDetail(
  event: NormalizedEvent,
  item: PersonalReminderItem,
  detail: GitHubItemDetail,
): PersonalReminderClockEventSource | undefined {
  const sourceKind = parseSourceId(event.sourceId).kind;
  if (
    sourceKind === "github_native_dependency" ||
    sourceKind === "github_native_hierarchy" ||
    sourceKind === "github_native_closing_issue"
  ) {
    return undefined;
  }
  let detailOccurredAt: UtcIsoDateTime | undefined;
  if (sourceKind === "github_issue_comment") {
    if (event.kind !== "comment") throw clockSourceError("kind_mismatch", event.sourceId);
    const comment = detail.comments.find((value) => value.sourceId === event.sourceId);
    if (comment != null) {
      assertDetailSourceId(comment.sourceId, sourceKind, comment.nodeId);
      detailOccurredAt = comment.createdAt;
    }
  } else if (sourceKind === "github_pull_request_review_comment") {
    if (event.kind !== "comment" || detail.type !== "pull_request") {
      throw clockSourceError("kind_mismatch", event.sourceId);
    }
    const comment = detail.reviewThreads
      .flatMap((thread) => thread.comments)
      .find((value) => value.sourceId === event.sourceId);
    if (comment != null) {
      assertDetailSourceId(comment.sourceId, sourceKind, comment.nodeId);
      detailOccurredAt = comment.createdAt;
    }
  } else if (sourceKind === "github_pull_request_review") {
    if (event.kind !== "review" || detail.type !== "pull_request") {
      throw clockSourceError("kind_mismatch", event.sourceId);
    }
    const review = detail.reviews.find((value) => value.sourceId === event.sourceId);
    if (review != null) {
      assertDetailSourceId(review.sourceId, sourceKind, review.nodeId);
      detailOccurredAt = review.submittedAt;
    }
  } else if (sourceKind === "github_pull_request_commit") {
    if (event.kind !== "push" || detail.type !== "pull_request") {
      throw clockSourceError("kind_mismatch", event.sourceId);
    }
    const commits = [
      detail.headCommit,
      ...detail.timeline.flatMap((value) => (value.kind === "commit_added" ? [value.commit] : [])),
    ].filter((value) => value.sourceId === event.sourceId);
    if (commits.length === 0) throw clockSourceError("missing_source", event.sourceId);
    for (const commit of commits) {
      if (commit.sourceId !== buildPullRequestCommitSourceId(item.nodeId, commit.nodeId)) {
        throw clockSourceError("source_id_conflict", event.sourceId);
      }
      if (commit.sha !== event.headCommitSha) {
        throw clockSourceError("source_id_conflict", event.sourceId);
      }
      if (commit.pushedAt.status !== "available" || commit.pushedAt.value < item.createdAt) {
        return undefined;
      }
      if (detailOccurredAt != null && detailOccurredAt !== commit.pushedAt.value) {
        throw clockSourceError("source_id_conflict", event.sourceId);
      }
      detailOccurredAt = commit.pushedAt.value;
    }
  } else if (sourceKind === "github_timeline_event") {
    const timeline = detail.timeline.find((value) => value.sourceId === event.sourceId);
    if (timeline == null) throw clockSourceError("missing_source", event.sourceId);
    assertDetailSourceId(timeline.sourceId, sourceKind, timeline.nodeId);
    if (timelineEventKind(timeline) !== event.kind || timeline.kind === "commit_added") {
      throw clockSourceError("kind_mismatch", event.sourceId);
    }
    detailOccurredAt = timeline.occurredAt;
  } else {
    throw clockSourceError("kind_mismatch", event.sourceId);
  }
  if (detailOccurredAt == null) throw clockSourceError("missing_source", event.sourceId);
  if (detailOccurredAt !== event.occurredAt) {
    throw clockSourceError("source_id_conflict", event.sourceId);
  }
  return Object.freeze({
    sourceId: event.sourceId,
    itemNodeId: item.nodeId,
    kind: event.kind,
    occurredAt: detailOccurredAt,
  });
}

/** 今回収集した完全な項目と詳細から時計に使えるsourceを一意に確定する。 */
export function createPersonalReminderClockEventSources(
  contexts: readonly Readonly<{ item: PersonalReminderItem; detail: GitHubItemDetail }>[],
  evaluatedAt: UtcIsoDateTime,
): ReadonlyMap<SourceId, PersonalReminderClockEventSource> {
  const sources = new Map<SourceId, PersonalReminderClockEventSource>();
  for (const { item, detail } of contexts) {
    if (item.nodeId !== detail.nodeId || item.type !== detail.type) {
      throw clockSourceError("wrong_owner", detail.sourceId);
    }
    if (item.observedAt !== detail.observedAt || detail.observedAt !== evaluatedAt) {
      throw clockSourceError("source_id_conflict", detail.sourceId);
    }
    for (const event of item.events) {
      if (event.itemNodeId !== item.nodeId) throw clockSourceError("wrong_owner", event.sourceId);
      const source = eventSourceFromDetail(event, item, detail);
      if (source == null) continue;
      if (source.occurredAt > evaluatedAt) throw clockSourceError("future_source", source.sourceId);
      const previous = sources.get(source.sourceId);
      if (
        previous != null &&
        (previous.itemNodeId !== source.itemNodeId ||
          previous.kind !== source.kind ||
          previous.occurredAt !== source.occurredAt)
      ) {
        throw clockSourceError("source_id_conflict", source.sourceId);
      }
      sources.set(source.sourceId, source);
    }
    if (detail.type !== "pull_request") continue;
    for (const request of detail.reviewRequests.current) {
      if (request.requestedAt.status !== "available") continue;
      assertDetailSourceId(request.sourceId, "github_review_request", request.nodeId);
      const source: PersonalReminderClockEventSource = Object.freeze({
        sourceId: request.sourceId,
        itemNodeId: item.nodeId,
        kind: "review_request",
        occurredAt: request.requestedAt.value,
      });
      if (source.occurredAt > evaluatedAt) throw clockSourceError("future_source", source.sourceId);
      const previous = sources.get(source.sourceId);
      if (
        previous != null &&
        (previous.itemNodeId !== source.itemNodeId ||
          previous.kind !== source.kind ||
          previous.occurredAt !== source.occurredAt)
      ) {
        throw clockSourceError("source_id_conflict", source.sourceId);
      }
      sources.set(source.sourceId, source);
    }
  }
  return sources;
}

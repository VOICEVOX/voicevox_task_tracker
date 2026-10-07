import { parseSourceId } from "../../../domain/source-id.js";
import {
  buildProductionSourceId,
  buildPullRequestCommitSourceId,
} from "../../../github/production-source-id.js";
import type {
  GitHubDetailActor,
  GitHubHeadChecks,
  GitHubItemDetail,
  GitHubPullRequestCommit,
  GitHubReferencedItem,
  GitHubReviewRequestTarget,
  GitHubTimelineEvent,
} from "../../../github/item-detail-types.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type {
  CurrentSourceFact,
  ItemSourceKind,
  SharedSourceKind,
  SourceImmutableFields,
} from "../contracts/evidence-catalog.js";
import { EvidenceCatalog } from "./evidence-catalog.js";

function assertSourceId(sourceId: SourceId, expected: SourceId): void {
  if (sourceId !== expected) {
    throw new TypeError(`収集recordのsource IDが種別または元IDと一致しません。対象: ${sourceId}`);
  }
}

function sharedFact(
  sourceKind: SharedSourceKind,
  sourceId: SourceId,
  immutable: SourceImmutableFields,
  origin: CurrentSourceFact["origin"],
): CurrentSourceFact {
  return Object.freeze({ scope: "shared", sourceKind, sourceId, origin, immutable });
}

function itemFact(
  sourceKind: ItemSourceKind,
  sourceId: SourceId,
  itemNodeId: GitHubNodeId,
  immutable: SourceImmutableFields,
  origin: CurrentSourceFact["origin"],
): CurrentSourceFact {
  return Object.freeze({ scope: "item", sourceKind, sourceId, itemNodeId, origin, immutable });
}

function actorNodeId(actor: GitHubDetailActor): GitHubNodeId | undefined {
  return actor.status === "identified" ? actor.account.nodeId : undefined;
}

function actorImmutableFields(
  actor: GitHubDetailActor,
): Pick<SourceImmutableFields, "actorNodeId"> {
  const nodeId = actorNodeId(actor);
  return nodeId == null ? {} : { actorNodeId: nodeId };
}

function addActor(catalog: EvidenceCatalog, actor: GitHubDetailActor): void {
  if (actor.status !== "identified") return;
  const account = actor.account;
  assertSourceId(account.sourceId, buildProductionSourceId("github_actor", account.nodeId));
  catalog.registerCurrentSource(
    sharedFact("github_actor", account.sourceId, { nodeId: account.nodeId }, "item_detail"),
  );
}

function addReferencedItem(catalog: EvidenceCatalog, item: GitHubReferencedItem): void {
  assertSourceId(item.sourceId, buildProductionSourceId("github_item", item.nodeId));
  catalog.registerCurrentSource(
    sharedFact(
      "github_item",
      item.sourceId,
      {
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        itemType: item.type,
        itemNumber: item.number,
      },
      "item_detail",
    ),
  );
}

function addReviewTarget(catalog: EvidenceCatalog, target: GitHubReviewRequestTarget): void {
  if ("status" in target) return;
  const sourceKind = target.type === "user" ? "github_user" : "github_team";
  assertSourceId(target.sourceId, buildProductionSourceId(sourceKind, target.nodeId));
  catalog.registerCurrentSource(
    sharedFact(sourceKind, target.sourceId, { nodeId: target.nodeId }, "item_detail"),
  );
}

function addPullRequestCommit(
  catalog: EvidenceCatalog,
  itemNodeId: GitHubNodeId,
  commit: GitHubPullRequestCommit,
): void {
  assertSourceId(commit.sourceId, buildPullRequestCommitSourceId(itemNodeId, commit.nodeId));
  catalog.registerCurrentSource(
    itemFact(
      "github_pull_request_commit",
      commit.sourceId,
      itemNodeId,
      { nodeId: commit.nodeId, sha: commit.sha, committedAt: commit.committedAt },
      "item_detail",
    ),
  );
}

function addTimelineEvent(
  catalog: EvidenceCatalog,
  itemNodeId: GitHubNodeId,
  event: GitHubTimelineEvent,
): void {
  assertSourceId(event.sourceId, buildProductionSourceId("github_timeline_event", event.nodeId));
  catalog.registerCurrentSource(
    itemFact(
      "github_timeline_event",
      event.sourceId,
      itemNodeId,
      {
        nodeId: event.nodeId,
        recordKind: event.kind,
        ...(event.kind === "commit_added" ? {} : { occurredAt: event.occurredAt }),
        ...(event.kind === "commit_added" ? {} : actorImmutableFields(event.actor)),
      },
      "item_detail",
    ),
  );
  if (event.kind === "commit_added") {
    addPullRequestCommit(catalog, itemNodeId, event.commit);
    return;
  }
  addActor(catalog, event.actor);
  if (event.kind === "assigned" || event.kind === "unassigned") {
    if ("type" in event.assignee) {
      addActor(catalog, { status: "identified", account: event.assignee.account });
    }
  } else if (event.kind === "labeled" || event.kind === "unlabeled") {
    assertSourceId(
      event.label.sourceId,
      buildProductionSourceId("github_label", event.label.nodeId),
    );
    catalog.registerCurrentSource(
      sharedFact(
        "github_label",
        event.label.sourceId,
        { nodeId: event.label.nodeId },
        "item_detail",
      ),
    );
  } else if (event.kind === "review_requested" || event.kind === "review_request_removed") {
    addReviewTarget(catalog, event.target);
  } else if (event.kind === "cross_referenced") {
    addReferencedItem(catalog, event.source);
  } else if (event.kind === "connected" || event.kind === "disconnected") {
    addReferencedItem(catalog, event.subject);
  } else if (event.kind === "sub_issue_added" || event.kind === "sub_issue_removed") {
    if (!("status" in event.subIssue)) addReferencedItem(catalog, event.subIssue);
  } else if (event.kind === "parent_issue_added" || event.kind === "parent_issue_removed") {
    if (!("status" in event.parent)) addReferencedItem(catalog, event.parent);
  }
}

function addHeadChecks(catalog: EvidenceCatalog, checks: GitHubHeadChecks): void {
  if (checks.status !== "configured") return;
  assertSourceId(
    checks.sourceId,
    buildProductionSourceId("github_status_check_rollup", checks.nodeId),
  );
  catalog.registerCurrentSource(
    sharedFact(
      "github_status_check_rollup",
      checks.sourceId,
      { nodeId: checks.nodeId },
      "item_detail",
    ),
  );
  for (const context of checks.contexts) {
    const sourceKind = context.type === "check_run" ? "github_check_run" : "github_commit_status";
    assertSourceId(context.sourceId, buildProductionSourceId(sourceKind, context.nodeId));
    catalog.registerCurrentSource(
      sharedFact(sourceKind, context.sourceId, { nodeId: context.nodeId }, "item_detail"),
    );
  }
}

/** GitHub詳細record内のsource事実を登録する。 */
export function addItemDetailSources(catalog: EvidenceCatalog, detail: GitHubItemDetail): void {
  const owner = detail.nodeId;
  assertSourceId(detail.sourceId, buildProductionSourceId("github_item_detail", owner));
  assertSourceId(detail.bodySourceId, buildProductionSourceId("github_item_body", owner));
  catalog.registerCurrentSource(
    sharedFact(
      "github_item",
      buildProductionSourceId("github_item", owner),
      {
        nodeId: owner,
        repositoryId: detail.repositoryId,
        itemType: detail.type,
        itemNumber: detail.number,
      },
      "item_detail",
    ),
  );
  catalog.registerCurrentSource(
    itemFact(
      "github_item_detail",
      detail.sourceId,
      owner,
      { repositoryId: detail.repositoryId, itemType: detail.type, itemNumber: detail.number },
      "item_detail",
    ),
  );
  catalog.registerCurrentSource(
    itemFact(
      "github_item_body",
      detail.bodySourceId,
      owner,
      { repositoryId: detail.repositoryId, itemNumber: detail.number },
      "item_detail",
    ),
  );
  for (const comment of detail.comments) {
    assertSourceId(
      comment.sourceId,
      buildProductionSourceId("github_issue_comment", comment.nodeId),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_issue_comment",
        comment.sourceId,
        owner,
        {
          nodeId: comment.nodeId,
          occurredAt: comment.createdAt,
          ...actorImmutableFields(comment.author),
        },
        "item_detail",
      ),
    );
    addActor(catalog, comment.author);
  }
  for (const event of detail.timeline) addTimelineEvent(catalog, owner, event);
  for (const reference of detail.inboundCrossReferences) {
    const eventId = parseSourceId(reference.eventSourceId);
    assertSourceId(
      reference.sourceId,
      buildProductionSourceId(
        "github_inbound_cross_reference",
        `${eventId.originalId}:${reference.sourceItem.nodeId}`,
      ),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_inbound_cross_reference",
        reference.sourceId,
        owner,
        { relatedNodeId: reference.sourceItem.nodeId },
        "item_detail",
      ),
    );
    addReferencedItem(catalog, reference.sourceItem);
  }
  if (detail.type === "issue") {
    if (detail.nativeDependencies.availability === "available") {
      for (const relation of detail.nativeDependencies.relations) {
        assertSourceId(
          relation.sourceId,
          buildProductionSourceId(
            "github_native_dependency",
            `${owner}:${relation.direction}:${relation.relatedItem.nodeId}`,
          ),
        );
        catalog.registerCurrentSource(
          itemFact(
            "github_native_dependency",
            relation.sourceId,
            owner,
            { relatedNodeId: relation.relatedItem.nodeId, relationKind: relation.direction },
            "item_detail",
          ),
        );
        addReferencedItem(catalog, relation.relatedItem);
      }
    }
    if (detail.nativeHierarchy.availability === "available") {
      for (const relation of detail.nativeHierarchy.relations) {
        assertSourceId(
          relation.sourceId,
          buildProductionSourceId(
            "github_native_hierarchy",
            `${owner}:${relation.relationship}:${relation.relatedItem.nodeId}`,
          ),
        );
        catalog.registerCurrentSource(
          itemFact(
            "github_native_hierarchy",
            relation.sourceId,
            owner,
            { relatedNodeId: relation.relatedItem.nodeId, relationKind: relation.relationship },
            "item_detail",
          ),
        );
        addReferencedItem(catalog, relation.relatedItem);
      }
    }
    return;
  }
  addPullRequestCommit(catalog, owner, detail.headCommit);
  for (const commit of detail.commitMembership.commits) {
    addPullRequestCommit(catalog, owner, commit);
  }
  for (const review of detail.reviews) {
    assertSourceId(
      review.sourceId,
      buildProductionSourceId("github_pull_request_review", review.nodeId),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_pull_request_review",
        review.sourceId,
        owner,
        {
          nodeId: review.nodeId,
          occurredAt: review.submittedAt,
          ...actorImmutableFields(review.author),
        },
        "item_detail",
      ),
    );
    addActor(catalog, review.author);
    if (review.commit.status === "available") {
      assertSourceId(
        review.commit.sourceId,
        buildProductionSourceId("github_commit", review.commit.nodeId),
      );
      catalog.registerCurrentSource(
        sharedFact(
          "github_commit",
          review.commit.sourceId,
          { nodeId: review.commit.nodeId, sha: review.commit.sha },
          "item_detail",
        ),
      );
    }
  }
  for (const thread of detail.reviewThreads) {
    assertSourceId(
      thread.sourceId,
      buildProductionSourceId("github_pull_request_review_thread", thread.nodeId),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_pull_request_review_thread",
        thread.sourceId,
        owner,
        { nodeId: thread.nodeId },
        "item_detail",
      ),
    );
    addActor(catalog, thread.resolvedBy);
    for (const comment of thread.comments) {
      assertSourceId(
        comment.sourceId,
        buildProductionSourceId("github_pull_request_review_comment", comment.nodeId),
      );
      catalog.registerCurrentSource(
        itemFact(
          "github_pull_request_review_comment",
          comment.sourceId,
          owner,
          {
            nodeId: comment.nodeId,
            occurredAt: comment.createdAt,
            ...actorImmutableFields(comment.author),
          },
          "item_detail",
        ),
      );
      addActor(catalog, comment.author);
    }
  }
  for (const request of detail.reviewRequests.current) {
    assertSourceId(
      request.sourceId,
      buildProductionSourceId("github_review_request", request.nodeId),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_review_request",
        request.sourceId,
        owner,
        {
          nodeId: request.nodeId,
          ...("status" in request.target ? {} : { relatedNodeId: request.target.nodeId }),
          ...(request.requestedAt.status === "available"
            ? { occurredAt: request.requestedAt.value }
            : {}),
        },
        "item_detail",
      ),
    );
    addReviewTarget(catalog, request.target);
  }
  for (const relation of detail.nativeClosingIssues) {
    assertSourceId(
      relation.sourceId,
      buildProductionSourceId(
        "github_native_closing_issue",
        `${owner}:${relation.relatedItem.nodeId}`,
      ),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_native_closing_issue",
        relation.sourceId,
        owner,
        { relatedNodeId: relation.relatedItem.nodeId },
        "item_detail",
      ),
    );
    addReferencedItem(catalog, relation.relatedItem);
  }
  addHeadChecks(catalog, detail.mergeState.checks);
  if (detail.mergeState.autoMerge.status === "enabled") {
    assertSourceId(
      detail.mergeState.autoMerge.sourceId,
      buildProductionSourceId("github_auto_merge_request", owner),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_auto_merge_request",
        detail.mergeState.autoMerge.sourceId,
        owner,
        {},
        "item_detail",
      ),
    );
    addActor(catalog, detail.mergeState.autoMerge.enabledBy);
  }
  if (detail.mergeState.mergeQueue.status === "queued") {
    assertSourceId(
      detail.mergeState.mergeQueue.sourceId,
      buildProductionSourceId("github_merge_queue_entry", detail.mergeState.mergeQueue.nodeId),
    );
    catalog.registerCurrentSource(
      itemFact(
        "github_merge_queue_entry",
        detail.mergeState.mergeQueue.sourceId,
        owner,
        { nodeId: detail.mergeState.mergeQueue.nodeId },
        "item_detail",
      ),
    );
  }
}

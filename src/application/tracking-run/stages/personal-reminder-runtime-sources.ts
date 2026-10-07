import type { PersonalReminderEvidenceScope } from "../../../codex/personal-reminder-input-contracts.js";
import { resolvePullRequestCommitOccurredAt } from "../../../domain/github-item-observation.js";
import type { PersonalReminderActionKind } from "../../../domain/personal-reminder-causes.js";
import type { PersonalReminderItem } from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, UtcIsoDateTime } from "../../../domain/types.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import { compareSourceIds, determineLocalDecision } from "./personal-reminder-runtime-common.js";
import {
  actorCandidateId,
  actorTypeForItem,
  addRuntimeSource,
  detailActorCandidateId,
  detailActorType,
  eventActorCandidateId,
  eventActorType,
  sourceContext,
  sourceSummaryForEvent,
  sourceSummaryForReviewRequest,
} from "./personal-reminder-runtime-source-projection.js";
import {
  actionKindForDecision,
  checkContextOccurredAt,
  latestUtcIsoDateTime,
} from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderRuntimeLocalDecision,
  PersonalReminderRuntimeRelatedContext,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import { createPersonalReminderClockEventSources } from "./personal-reminder-clock-sources.js";

/** 項目と詳細から原因計画用の根拠sourceを収集する。 */
export function createRuntimeSources(
  item: PersonalReminderItem,
  detail: GitHubItemDetail,
  localDecision: PersonalReminderRuntimeLocalDecision,
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
  evaluatedAt: UtcIsoDateTime,
): Readonly<{
  sources: readonly PersonalReminderRuntimeSource[];
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>;
  seedEvidence: readonly Evidence[];
  evidenceScopes: readonly PersonalReminderEvidenceScope[];
}> {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  const seedEvidence = new Map<SourceId, Evidence>();
  const contexts = [Object.freeze({ item, detail, localDecision }), ...relatedContexts];
  const clockEventSources = createPersonalReminderClockEventSources(contexts, evaluatedAt);
  for (const context of contexts) {
    const contextItem = context.item;
    const contextDetail = context.detail;
    const contextDecision =
      context.localDecision == null ? undefined : determineLocalDecision(context.localDecision);
    const contextActionKind =
      contextDecision == null ? undefined : actionKindForDecision(contextDecision);
    const statusSourceIds = new Set([
      ...(contextDecision?.statusBasis.sourceIds ?? []),
      ...(contextDecision?.responsibilityBasis.sourceIds ?? []),
    ]);
    if (contextItem.nodeId !== contextDetail.nodeId || contextItem.type !== contextDetail.type) {
      throw new TypeError(
        `個人催促runtimeのitemとdetailが一致しません。対象: ${contextItem.nodeId}`,
      );
    }
    addRuntimeSource(
      sources,
      sourceContext(
        contextItem.nodeId,
        contextItem.sourceId,
        "item",
        actorTypeForItem(contextItem),
        actorCandidateId(contextItem.author),
        contextItem.createdAt,
        "GitHub item",
        false,
      ),
    );
    sourceOccurredAtById.set(contextItem.sourceId, contextItem.createdAt);
    if (contextDetail.body.length !== 0) {
      addRuntimeSource(
        sources,
        sourceContext(
          contextItem.nodeId,
          contextDetail.bodySourceId,
          "body",
          actorTypeForItem(contextItem),
          actorCandidateId(contextItem.author),
          contextItem.createdAt,
          contextDetail.body,
          false,
        ),
      );
      sourceOccurredAtById.set(contextDetail.bodySourceId, contextItem.createdAt);
    }
    const detailContentSourceIds = new Set<SourceId>([
      ...contextDetail.comments.map((comment) => comment.sourceId),
      ...(contextDetail.type === "pull_request"
        ? [
            ...contextDetail.reviews.map((review) => review.sourceId),
            ...contextDetail.reviewThreads.flatMap((thread) =>
              thread.comments.map((comment) => comment.sourceId),
            ),
          ]
        : []),
    ]);
    for (const event of contextItem.events) {
      if (detailContentSourceIds.has(event.sourceId)) {
        continue;
      }
      const causalPush =
        contextActionKind === "revision" &&
        statusSourceIds.has(event.sourceId) &&
        event.kind === "push";
      addRuntimeSource(
        sources,
        sourceContext(
          contextItem.nodeId,
          event.sourceId,
          event.kind,
          eventActorType(event),
          eventActorCandidateId(event),
          event.occurredAt,
          sourceSummaryForEvent(event),
          causalPush,
        ),
      );
      sourceOccurredAtById.set(event.sourceId, event.occurredAt);
    }
    for (const comment of contextDetail.comments) {
      if (comment.body.length === 0) {
        continue;
      }
      addRuntimeSource(
        sources,
        sourceContext(
          contextItem.nodeId,
          comment.sourceId,
          "comment",
          detailActorType(comment.author),
          detailActorCandidateId(comment.author),
          comment.createdAt,
          comment.body,
          false,
        ),
      );
      sourceOccurredAtById.set(comment.sourceId, comment.createdAt);
    }
    if (contextDetail.type === "pull_request") {
      for (const thread of contextDetail.reviewThreads) {
        for (const comment of thread.comments) {
          if (comment.body.length === 0) {
            continue;
          }
          addRuntimeSource(
            sources,
            sourceContext(
              contextItem.nodeId,
              comment.sourceId,
              "review_comment",
              detailActorType(comment.author),
              detailActorCandidateId(comment.author),
              comment.createdAt,
              comment.body,
              false,
            ),
          );
          sourceOccurredAtById.set(comment.sourceId, comment.createdAt);
        }
      }
      for (const review of contextDetail.reviews) {
        const reviewCommit =
          review.commit.status === "available" ? review.commit.sha : "commit-unavailable";
        addRuntimeSource(
          sources,
          sourceContext(
            contextItem.nodeId,
            review.sourceId,
            "review",
            detailActorType(review.author),
            detailActorCandidateId(review.author),
            review.submittedAt,
            `GitHub review ${review.state} ${reviewCommit}: ${review.body}`,
            false,
          ),
        );
        sourceOccurredAtById.set(review.sourceId, review.submittedAt);
      }
      for (const request of contextDetail.reviewRequests.current) {
        if (request.requestedAt.status === "unavailable") {
          continue;
        }
        if (sources.has(request.sourceId)) {
          continue;
        }
        addRuntimeSource(
          sources,
          sourceContext(
            contextItem.nodeId,
            request.sourceId,
            "review_request",
            "system",
            undefined,
            request.requestedAt.value,
            sourceSummaryForReviewRequest(request),
            false,
          ),
        );
        sourceOccurredAtById.set(request.sourceId, request.requestedAt.value);
      }
      addRuntimePullRequestSources(
        sources,
        sourceOccurredAtById,
        contextItem,
        contextDetail,
        statusSourceIds,
        contextActionKind,
      );
    }
    if (contextDecision != null) {
      for (const evidence of contextDecision.evidence) {
        if (evidence.sourceId === contextItem.sourceId || sources.has(evidence.sourceId)) {
          seedEvidence.set(evidence.sourceId, evidence);
        }
      }
    }
  }
  const evidenceScopes = [...sources.values()].map((entry) =>
    Object.freeze({ sourceId: entry.source.sourceId, roles: [...entry.roles] }),
  );
  return Object.freeze({
    sources: Object.freeze(
      [...sources.values()].sort((left, right) =>
        compareSourceIds(left.source.sourceId, right.source.sourceId),
      ),
    ),
    sourceOccurredAtById,
    clockEventOccurredAtBySourceId: new Map(
      [...clockEventSources].map(([sourceId, source]) => [sourceId, source.occurredAt]),
    ),
    seedEvidence: Object.freeze([...seedEvidence.values()]),
    evidenceScopes: Object.freeze(evidenceScopes),
  });
}

function addRuntimePullRequestSources(
  sources: Map<SourceId, PersonalReminderRuntimeSource>,
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  item: PersonalReminderItem,
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
  causalSourceIds: ReadonlySet<SourceId>,
  actionKind: PersonalReminderActionKind | undefined,
): void {
  const headOccurredAt = resolvePullRequestCommitOccurredAt(detail.headCommit, item.createdAt);
  const causalPush =
    actionKind === "revision" &&
    detail.headCommit.pushedAt.status === "available" &&
    causalSourceIds.has(detail.headCommit.sourceId);
  const existingHead = sources.get(detail.headCommit.sourceId);
  if (existingHead == null) {
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        detail.headCommit.sourceId,
        "commit_added",
        "system",
        undefined,
        headOccurredAt,
        "GitHub head commit",
        causalPush,
      ),
    );
    sourceOccurredAtById.set(detail.headCommit.sourceId, headOccurredAt);
  } else {
    if (causalPush && !existingHead.causalPush) {
      addRuntimeSource(sources, Object.freeze({ ...existingHead, causalPush: true }));
    }
    sourceOccurredAtById.set(detail.headCommit.sourceId, existingHead.source.occurredAt);
  }

  if (detail.mergeState.autoMerge.status === "enabled") {
    const autoMerge = detail.mergeState.autoMerge;
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        autoMerge.sourceId,
        "auto_merge_request",
        detailActorType(autoMerge.enabledBy),
        detailActorCandidateId(autoMerge.enabledBy),
        autoMerge.enabledAt,
        `GitHub auto-merge ${autoMerge.mergeMethod}`,
        false,
      ),
    );
    sourceOccurredAtById.set(autoMerge.sourceId, autoMerge.enabledAt);
  }
  if (detail.mergeState.checks.status !== "configured") {
    return;
  }
  const checkOccurredAts: UtcIsoDateTime[] = [];
  for (const check of detail.mergeState.checks.contexts) {
    const occurredAt = checkContextOccurredAt(headOccurredAt, check);
    let summary: string;
    if (check.type === "check_run") {
      summary = `GitHub check_run ${check.name} ${check.conclusion}`;
    } else {
      summary = `GitHub commit_status ${check.context} ${check.state}`;
    }
    addRuntimeSource(
      sources,
      sourceContext(
        item.nodeId,
        check.sourceId,
        check.type,
        "system",
        undefined,
        occurredAt,
        summary,
        false,
      ),
    );
    sourceOccurredAtById.set(check.sourceId, occurredAt);
    checkOccurredAts.push(occurredAt);
  }
  const rollup = detail.mergeState.checks;
  const rollupOccurredAt = latestUtcIsoDateTime(
    [headOccurredAt, ...checkOccurredAts],
    `required check rollup ${rollup.sourceId}`,
  );
  addRuntimeSource(
    sources,
    sourceContext(
      item.nodeId,
      rollup.sourceId,
      "required_check_rollup",
      "system",
      undefined,
      rollupOccurredAt,
      `GitHub required checks ${rollup.combinedState}`,
      false,
    ),
  );
  sourceOccurredAtById.set(rollup.sourceId, rollupOccurredAt);
}

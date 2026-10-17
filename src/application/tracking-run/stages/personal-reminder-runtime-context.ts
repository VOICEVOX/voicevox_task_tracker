import type { PersonalReminderAiItemContext } from "../../../codex/personal-reminder-input-contracts.js";
import type { AiAnalysisDependencyReconciliationContext } from "../../../domain/ai-analysis-dependencies.js";
import { aiAnalysisDependencyForRelationCandidate } from "../../../domain/ai-analysis-dependencies.js";
import type { PersonalReminderItem } from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, GitHubNodeId, GraphNodeId, UtcIsoDateTime } from "../../../domain/types.js";
import { reconcileRetainedPersonalReminderCause } from "./personal-reminder-retained-cause.js";
import {
  createPreviousCauses,
  determineLocalDecision,
  validateLocalDecision,
} from "./personal-reminder-runtime-common.js";
import { createRuntimeActivity } from "./personal-reminder-runtime-context-activity.js";
import { createResponsibilities } from "./personal-reminder-runtime-context-responsibility.js";
import type {
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeCollection,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeExternalReference,
  PersonalReminderRuntimeGraph,
  PersonalReminderRuntimeItem,
  PersonalReminderRuntimeRelatedContext,
  PersonalReminderRuntimeState,
} from "./personal-reminder-runtime-contracts.js";
import { currentReviewTargetFromItem } from "./personal-reminder-runtime-relation-projection.js";
import { createRuntimeSources } from "./personal-reminder-runtime-sources.js";
import { validateCollectedItem } from "./personal-reminder-runtime-source-projection.js";

/** graph端点から実行面の状態を取得する。 */
export function executionSurfaceStates(
  graph: PersonalReminderRuntimeGraph,
  contexts: readonly PersonalReminderRuntimeRelatedContext[],
): ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge"> {
  const states = new Map<GitHubNodeId, "open" | "merged" | "closed_without_merge">();
  for (const context of contexts) {
    const state = graph.endpointStates.get(context.item.nodeId);
    if (state === "open") {
      states.set(context.item.nodeId, "open");
    } else if (state === "merged") {
      states.set(context.item.nodeId, "merged");
    } else if (state === "closed") {
      states.set(context.item.nodeId, "closed_without_merge");
    }
  }
  return states;
}

function pullRequestReviewState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_requested" | "requested" | "changes_requested" | "approved" | "mixed" | "unknown" {
  const reviewStates = item.events
    .filter((event) => event.kind === "review")
    .map((event) => event.state);
  const hasChangesRequested = reviewStates.includes("changes_requested");
  const hasApproved = reviewStates.includes("approved");
  if (hasChangesRequested && hasApproved) {
    return "mixed";
  }
  if (hasChangesRequested) {
    return "changes_requested";
  }
  if (hasApproved) {
    return "approved";
  }
  return item.reviewRequests.length === 0 ? "not_requested" : "requested";
}

function pullRequestCheckState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_required" | "passing" | "pending" | "failing" | "unknown" {
  if (item.mergeState.checks.status !== "configured") {
    return "not_required";
  }
  switch (item.mergeState.checks.combinedState) {
    case "success":
      return "passing";
    case "expected":
    case "pending":
      return "pending";
    case "error":
    case "failure":
      return "failing";
  }
}

function pullRequestMergeState(
  item: Extract<PersonalReminderItem, { type: "pull_request" }>,
): "not_ready" | "ready" | "queued" | "merged" | "closed_unmerged" | "unknown" {
  if (item.events.some((event) => event.kind === "state" && event.state === "merged")) {
    return "merged";
  }
  if (item.state === "closed") {
    return "closed_unmerged";
  }
  if (item.mergeState.mergeQueue.status === "queued") {
    return "queued";
  }
  if (item.mergeState.mergeState === "clean" && item.mergeState.mergeability === "mergeable") {
    return "ready";
  }
  if (item.mergeState.mergeability === "unknown" || item.mergeState.mergeState === "unknown") {
    return "unknown";
  }
  return "not_ready";
}

function createItemContext(item: PersonalReminderRuntimeItem): PersonalReminderAiItemContext {
  if (item.type === "issue") {
    return {
      nodeId: item.nodeId,
      url: item.url,
      title: item.title,
      type: "issue",
      state: item.state,
    };
  }
  const mergeState = pullRequestMergeState(item);
  let state: "open" | "closed_unmerged" | "merged" = "closed_unmerged";
  if (item.state === "open") {
    state = "open";
  } else if (mergeState === "merged") {
    state = "merged";
  }
  return {
    nodeId: item.nodeId,
    url: item.url,
    title: item.title,
    type: "pull_request",
    state,
    draft: item.draft,
    reviewState: pullRequestReviewState(item),
    checkState: pullRequestCheckState(item),
    mergeState,
  };
}

function createExternalReferenceItemContext(
  reference: PersonalReminderRuntimeExternalReference,
): PersonalReminderAiItemContext {
  return Object.freeze({
    nodeId: reference.nodeId,
    url: reference.url,
    title: reference.title,
    type: "external_reference",
    state: reference.state,
  });
}

function indexCandidateRelationsByTargetNodeId(
  graph: PersonalReminderRuntimeGraph,
): ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeCandidateRelation[]> {
  const candidatesByTargetNodeId = new Map<
    GraphNodeId,
    PersonalReminderRuntimeCandidateRelation[]
  >();
  for (const candidate of graph.candidateRelations) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      const endpoint = graph.candidateEndpointItemsByNodeId.get(endpointNodeId);
      if (endpoint?.type !== "issue") {
        continue;
      }
      const candidates = candidatesByTargetNodeId.get(endpointNodeId);
      if (candidates == null) {
        candidatesByTargetNodeId.set(endpointNodeId, [candidate]);
      } else {
        candidates.push(candidate);
      }
    }
  }
  return new Map(
    [...candidatesByTargetNodeId.entries()].map(([nodeId, candidates]) => [
      nodeId,
      Object.freeze(candidates),
    ]),
  );
}

/** 収集済み値から個人催促cause判定用のpure contextを作る。 */
export function createPersonalReminderRuntimeContext(
  input: Readonly<{
    evaluatedAt: UtcIsoDateTime;
    state: PersonalReminderRuntimeState;
    collection: PersonalReminderRuntimeCollection;
    graph: PersonalReminderRuntimeGraph;
    aiDependencyContext: AiAnalysisDependencyReconciliationContext;
    currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
  }>,
): PersonalReminderRuntimeContext {
  const items: PersonalReminderRuntimeContextItem[] = [];
  const graph = Object.freeze({
    ...input.graph,
    candidateRelations: Object.freeze(
      input.graph.candidateRelations.map((candidate) =>
        Object.freeze({
          ...candidate,
          aiDependency: aiAnalysisDependencyForRelationCandidate(
            candidate.candidateId,
            candidate.endpointNodeIds,
            candidate.aiDependency,
          ),
        }),
      ),
    ),
  });
  const nodeIds = new Set<GitHubNodeId>();
  const externalNodeIds = new Set<GraphNodeId>();
  const externalItemContexts = input.graph.externalReferences.map((reference) => {
    if (externalNodeIds.has(reference.nodeId)) {
      throw new TypeError(`外部参照node IDが重複しています。対象: ${reference.nodeId}`);
    }
    externalNodeIds.add(reference.nodeId);
    return createExternalReferenceItemContext(reference);
  });
  for (const item of input.collection.items) {
    validateCollectedItem(item);
    if (nodeIds.has(item.item.nodeId)) {
      throw new TypeError(
        `個人催促runtime item node IDが重複しています。対象: ${item.item.nodeId}`,
      );
    }
    nodeIds.add(item.item.nodeId);
    if (item.localDecision.itemType !== item.item.type) {
      throw new TypeError(
        `個人催促runtimeのlocal decision種別が一致しません。対象: ${item.item.nodeId}`,
      );
    }
    const relatedNodeIds = new Set<GitHubNodeId>();
    for (const related of item.relatedContexts) {
      validateLocalDecision(
        related.item.type,
        related.localDecision,
        `個人催促runtimeの関連項目 ${related.item.nodeId}`,
      );
      if (
        related.detail.nodeId !== related.item.nodeId ||
        related.detail.type !== related.item.type
      ) {
        throw new TypeError(
          `個人催促runtimeの関連itemとdetailが一致しません。対象: ${related.item.nodeId}`,
        );
      }
      if (relatedNodeIds.has(related.item.nodeId) || related.item.nodeId === item.item.nodeId) {
        throw new TypeError(
          `個人催促runtimeの関連item node IDが重複しています。対象: ${related.item.nodeId}`,
        );
      }
      relatedNodeIds.add(related.item.nodeId);
    }
    const localDecision = determineLocalDecision(item.localDecision);
    const sourceProjection = createRuntimeSources(
      item.item,
      item.detail,
      item.localDecision,
      item.relatedContexts,
      input.evaluatedAt,
    );
    const responsibilities = createResponsibilities(
      item.item,
      localDecision,
      sourceProjection.sources,
      item.relatedContexts,
    );
    const previousCauses = createPreviousCauses(input.state, item);
    const previous = Object.freeze({
      ...previousCauses,
      causes: Object.freeze(
        previousCauses.causes.map((cause) =>
          reconcileRetainedPersonalReminderCause(cause, input.aiDependencyContext),
        ),
      ),
    });
    const activity = createRuntimeActivity(
      item.item,
      localDecision,
      sourceProjection.clockEventOccurredAtBySourceId,
    );
    const allContexts = [
      Object.freeze({ item: item.item, detail: item.detail, localDecision: item.localDecision }),
      ...item.relatedContexts,
    ];
    const itemContext = createItemContext(item.item);
    const relatedItemContexts = Object.freeze(
      item.relatedContexts.map((context) => createItemContext(context.item)),
    );
    items.push(
      Object.freeze({
        ...item,
        localDecision,
        previous,
        sources: sourceProjection.sources,
        activity,
        stale: input.collection.staleNodeIds.has(item.item.nodeId),
        currentReviewRequestTargets: currentReviewTargetFromItem(item.item),
        executionSurfaceStates: executionSurfaceStates(graph, allContexts),
        sourceOccurredAtById: sourceProjection.sourceOccurredAtById,
        clockEventOccurredAtBySourceId: sourceProjection.clockEventOccurredAtBySourceId,
        seedEvidence: sourceProjection.seedEvidence,
        evidenceScopes: sourceProjection.evidenceScopes,
        responsibilities: responsibilities ?? Object.freeze([]),
        itemContext,
        relatedItemContexts,
        externalItemContexts: Object.freeze(externalItemContexts),
        endpointStates: graph.endpointStates,
      }),
    );
  }
  const candidateRelationsByTargetNodeId = indexCandidateRelationsByTargetNodeId(graph);
  return Object.freeze({
    evaluatedAt: input.evaluatedAt,
    state: input.state,
    items: Object.freeze(items),
    graph,
    aiDependencyContext: input.aiDependencyContext,
    candidateRelationsByTargetNodeId,
    currentEvidenceBySourceId: input.currentEvidenceBySourceId,
  });
}

import {
  ISSUE_DETERMINISTIC_RULES_VERSION,
  type Evidence,
  type GitHubNodeId,
  type GraphNodeId,
  type IssueStateDecision,
  type PullRequestStateDecision,
  type SourceId,
} from "../../../domain/index.js";
import type { FreshObservedGitHubItem, GitHubItemDetail } from "../../../github/index.js";
import {
  createPersonalReminderEvidenceSourceIndex,
  type StateSnapshot,
} from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  PersonalReminderRuntimeCollectedItem,
  PersonalReminderRuntimeLocalDecision,
  PersonalReminderRuntimeRelatedContext,
  PersonalReminderRuntimeState,
} from "../../personal-reminder-runtime.js";
import type {
  CollectedItems,
  DeterministicAnalysis,
  GraphResult,
  ReducedAnalysis,
  ReducedItemAnalysis,
  RuntimeState,
} from "../contracts.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";

function personalReminderRuntimeLocalDecision(
  analysis: Readonly<{
    item: FreshObservedGitHubItem;
    localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  }>,
): PersonalReminderRuntimeLocalDecision {
  const decision = analysis.localResponsibilityDecision;
  if (decision.deterministicRulesVersion === ISSUE_DETERMINISTIC_RULES_VERSION) {
    if (analysis.item.type !== "issue") {
      throw new TypeError(`Issueのlocal decision種別が一致しません。対象: ${analysis.item.nodeId}`);
    }
    return Object.freeze({ itemType: "issue", value: decision });
  }
  if (analysis.item.type !== "pull_request") {
    throw new TypeError(
      `Pull Requestのlocal decision種別が一致しません。対象: ${analysis.item.nodeId}`,
    );
  }
  return Object.freeze({ itemType: "pull_request", value: decision });
}

function personalReminderRuntimeItem(
  collection: CollectedItems,
  item: FreshObservedGitHubItem,
): PersonalReminderRuntimeCollectedItem["item"] {
  const enumerated = collection.enumeratedItems.find(
    (candidate) => candidate.nodeId === item.nodeId,
  );
  assertNonNullable(enumerated, `個人催促対象の列挙値がありません。対象: ${item.nodeId}`);
  return Object.freeze({
    ...item,
    url: enumerated.url,
    title: enumerated.title,
  });
}

type PersonalReminderRelatedContextProjection = Readonly<{
  contexts: readonly PersonalReminderRuntimeRelatedContext[];
}>;

function personalReminderRelatedContexts(
  analysis: Readonly<{
    item: FreshObservedGitHubItem;
    localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  }>,
  collection: CollectedItems,
  graph: GraphResult,
  analysesByNodeId: ReadonlyMap<
    GitHubNodeId,
    Readonly<{
      item: FreshObservedGitHubItem;
      localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
    }>
  >,
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>,
): PersonalReminderRelatedContextProjection {
  const relatedNodeIds = new Set<GitHubNodeId>();
  const isGitHubNode = (nodeId: GraphNodeId): nodeId is GitHubNodeId =>
    !graph.externalReferences.some((reference) => reference.nodeId === nodeId);
  for (const edge of graph.edges) {
    if (!edge.active || edge.type === "related_to") {
      continue;
    }
    if (edge.fromNodeId === analysis.item.nodeId) {
      if (!isGitHubNode(edge.toNodeId)) {
        continue;
      }
      const relatedItem =
        analysesByNodeId.get(edge.toNodeId)?.item ??
        collection.observedItems.find((item) => item.nodeId === edge.toNodeId);
      if (relatedItem != null) {
        relatedNodeIds.add(relatedItem.nodeId);
      }
    }
    if (edge.toNodeId === analysis.item.nodeId) {
      if (!isGitHubNode(edge.fromNodeId)) {
        continue;
      }
      const relatedItem =
        analysesByNodeId.get(edge.fromNodeId)?.item ??
        collection.observedItems.find((item) => item.nodeId === edge.fromNodeId);
      if (relatedItem != null) {
        relatedNodeIds.add(relatedItem.nodeId);
      }
    }
  }
  const contexts: PersonalReminderRuntimeRelatedContext[] = [];
  for (const nodeId of [...relatedNodeIds].sort()) {
    const relatedAnalysis = analysesByNodeId.get(nodeId);
    const detail = detailsByNodeId.get(nodeId);
    const relatedItem =
      relatedAnalysis?.item ?? collection.observedItems.find((item) => item.nodeId === nodeId);
    if (detail == null || relatedItem == null) {
      continue;
    }
    contexts.push(
      Object.freeze({
        item: personalReminderRuntimeItem(collection, relatedItem),
        detail,
        localDecision:
          relatedAnalysis == null
            ? undefined
            : personalReminderRuntimeLocalDecision(relatedAnalysis),
      }),
    );
  }
  return Object.freeze({
    contexts: Object.freeze(contexts),
  });
}

export function personalReminderRuntimeCollection(
  collection: CollectedItems,
  deterministicAnalysis: DeterministicAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>,
): Readonly<{
  collection: Readonly<{
    items: readonly PersonalReminderRuntimeCollectedItem[];
    staleNodeIds: ReadonlySet<GitHubNodeId>;
  }>;
  analyses: ReadonlyMap<GitHubNodeId, ReducedItemAnalysis>;
}> {
  const analysesByNodeId = new Map(
    reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  const detailsByNodeId = new Map(collection.details.map((detail) => [detail.nodeId, detail]));
  const staleNodeIds = new Set(collection.staleItems.map((item) => item.nodeId));
  const items: PersonalReminderRuntimeCollectedItem[] = [];
  for (const analysis of deterministicAnalysis.items) {
    if (unavailableConsumerNodeIds.has(analysis.item.nodeId)) {
      continue;
    }
    const currentAnalysis = analysesByNodeId.get(analysis.item.nodeId);
    assertNonNullable(
      currentAnalysis,
      `個人催促対象のgeneric採用後分析がありません。対象: ${analysis.item.nodeId}`,
    );
    const detail = detailsByNodeId.get(analysis.item.nodeId);
    assertNonNullable(detail, `個人催促対象の詳細がありません。対象: ${analysis.item.nodeId}`);
    if (detail.type !== analysis.item.type) {
      throw new TypeError(`個人催促対象の詳細種別が一致しません。対象: ${analysis.item.nodeId}`);
    }
    const relatedProjection = personalReminderRelatedContexts(
      currentAnalysis,
      collection,
      graph,
      analysesByNodeId,
      detailsByNodeId,
    );
    items.push(
      Object.freeze({
        item: personalReminderRuntimeItem(collection, analysis.item),
        detail,
        localDecision: personalReminderRuntimeLocalDecision(currentAnalysis),
        aiAnalysisApplications: currentAnalysis.aiAnalysisApplications,
        relatedContexts: relatedProjection.contexts,
        completeness: Object.freeze({ status: "complete" }),
        repositoryFullName: repositoryFullName(
          findRepository(deterministicAnalysis.inventory, analysis.item.repositoryId),
        ),
        currentLabels: analysis.item.labels,
      }),
    );
  }
  return Object.freeze({
    collection: Object.freeze({
      items: Object.freeze(items),
      staleNodeIds,
    }),
    analyses: analysesByNodeId,
  });
}

function previousPersonalReminderEvidenceBySourceId(
  snapshot: StateSnapshot | undefined,
): ReadonlyMap<SourceId, readonly Evidence[]> {
  return createPersonalReminderEvidenceSourceIndex([
    ...(snapshot?.items.map((item) => item.evidence) ?? []),
    ...(snapshot?.relations.map((relation) => relation.evidence) ?? []),
  ]);
}

export function personalReminderPreviousState(state: RuntimeState): PersonalReminderRuntimeState {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return Object.freeze({
      previousCausesByNodeId: new Map(),
      previousEvidenceByNodeId: new Map(),
      previousEvidenceBySourceId: new Map(),
    });
  }
  return Object.freeze({
    previousCausesByNodeId: new Map(
      snapshot.items.map((item) => [
        item.nodeId,
        Object.freeze({ observedAt: item.observedAt, causes: item.personalReminderCauses }),
      ]),
    ),
    previousEvidenceByNodeId: new Map(snapshot.items.map((item) => [item.nodeId, item.evidence])),
    previousEvidenceBySourceId: previousPersonalReminderEvidenceBySourceId(snapshot),
  });
}

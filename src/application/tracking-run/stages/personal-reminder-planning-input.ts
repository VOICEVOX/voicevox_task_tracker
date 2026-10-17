import { ISSUE_DETERMINISTIC_RULES_VERSION } from "../../../domain/issue-state-contracts.js";
import {
  aiAnalysisDependencyForRelationCandidate,
  type AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import type { Evidence, GitHubNodeId, GraphNodeId, SourceId } from "../../../domain/index.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GraphReconciledRun } from "./graph-reconciliation.js";
import type { GraphReducedItem } from "./graph-reconciliation-contracts.js";
import { indexPersonalReminderEvidence } from "./personal-reminder-evidence-index.js";
import { createPersonalReminderRuntimeContext } from "./personal-reminder-runtime-context.js";
import type {
  PersonalReminderRuntimeCollectedItem,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeGraph,
  PersonalReminderRuntimeLocalDecision,
  PersonalReminderRuntimeRelatedContext,
  PersonalReminderRuntimeState,
} from "./personal-reminder-runtime-contracts.js";

/** 個人催促の前回根拠と最終graphから作る計画入力。 */
export type PersonalReminderPlanningContext = Readonly<{
  context: PersonalReminderRuntimeContext;
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>;
}>;

function localDecision(analysis: GraphReducedItem): PersonalReminderRuntimeLocalDecision {
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

function runtimeItem(
  run: GraphReconciledRun,
  item: FreshObservedGitHubItem,
): PersonalReminderRuntimeCollectedItem["item"] {
  const enumerated = run.data.collection.enumeratedItems.find(
    (candidate) => candidate.nodeId === item.nodeId,
  );
  assertNonNullable(enumerated, `個人催促対象の列挙値がありません。対象: ${item.nodeId}`);
  return Object.freeze({ ...item, url: enumerated.url, title: enumerated.title });
}

function relatedContexts(
  run: GraphReconciledRun,
  analysis: GraphReducedItem,
  analysesByNodeId: ReadonlyMap<GitHubNodeId, GraphReducedItem>,
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>,
): readonly PersonalReminderRuntimeRelatedContext[] {
  const relatedNodeIds = new Set<GitHubNodeId>();
  const isGitHubNode = (nodeId: GraphNodeId): nodeId is GitHubNodeId =>
    !run.data.graph.externalReferences.some((reference) => reference.nodeId === nodeId);
  for (const edge of run.data.graph.edges) {
    if (!edge.active || edge.type === "related_to") {
      continue;
    }
    const otherNodeId =
      edge.fromNodeId === analysis.item.nodeId
        ? edge.toNodeId
        : edge.toNodeId === analysis.item.nodeId
          ? edge.fromNodeId
          : undefined;
    if (otherNodeId != null && isGitHubNode(otherNodeId)) {
      const relatedItem =
        analysesByNodeId.get(otherNodeId)?.item ??
        run.data.collection.observedItems.find((item) => item.nodeId === otherNodeId);
      if (relatedItem != null) {
        relatedNodeIds.add(relatedItem.nodeId);
      }
    }
  }
  const contexts: PersonalReminderRuntimeRelatedContext[] = [];
  for (const nodeId of [...relatedNodeIds].sort()) {
    const relatedAnalysis = analysesByNodeId.get(nodeId);
    const detail = detailsByNodeId.get(nodeId);
    const item =
      relatedAnalysis?.item ??
      run.data.collection.observedItems.find((observed) => observed.nodeId === nodeId);
    if (detail == null || item == null) {
      continue;
    }
    contexts.push(
      Object.freeze({
        item: runtimeItem(run, item),
        detail,
        localDecision: relatedAnalysis == null ? undefined : localDecision(relatedAnalysis),
      }),
    );
  }
  return Object.freeze(contexts);
}

function runtimeGraph(run: GraphReconciledRun): PersonalReminderRuntimeGraph {
  return Object.freeze({
    activeRelations: Object.freeze(
      run.data.graph.edges.filter(
        (edge): edge is ReconciledGraphEdge & Readonly<{ active: true }> => edge.active,
      ),
    ),
    candidateRelations: run.data.context.candidateRelations,
    candidateResolutions: run.data.graph.candidateResolutions,
    endpointStates: new Map(run.data.context.endpointStates),
    candidateEndpointItemsByNodeId: new Map(run.data.context.candidateEndpointItems),
    externalReferences: Object.freeze(
      run.data.graph.externalReferences.map((reference) =>
        Object.freeze({
          nodeId: reference.nodeId,
          url: reference.url,
          title: reference.title,
          state: reference.state,
        }),
      ),
    ),
  });
}

function previousState(run: GraphReconciledRun): PersonalReminderRuntimeState {
  const { previousItems, previousRelations } = run.core.personalReminderInput;
  return Object.freeze({
    previousCausesByNodeId: new Map(
      previousItems.map((item) => [
        item.nodeId,
        Object.freeze({ observedAt: item.observedAt, causes: item.personalReminderCauses }),
      ]),
    ),
    previousEvidenceByNodeId: new Map(previousItems.map((item) => [item.nodeId, item.evidence])),
    previousEvidenceBySourceId: indexPersonalReminderEvidence([
      ...previousItems.map((item) => item.evidence),
      ...previousRelations.map((relation) => relation.evidence),
    ]),
  });
}

function aiDependencyContext(run: GraphReconciledRun): AiAnalysisDependencyReconciliationContext {
  return Object.freeze({
    applicationsByNodeId: new Map(
      run.data.finalItems.map((item) => [item.nodeId, item.aiAnalysis.applications]),
    ),
    relationsById: new Map(run.data.graph.edges.map((edge) => [edge.id, edge])),
    candidatesById: new Map(
      run.data.context.candidateRelations.map((candidate) => [
        candidate.candidateId,
        Object.freeze({
          endpointNodeIds: candidate.endpointNodeIds,
          ownerNodeId: candidate.ownerNodeId,
          aiDependency: aiAnalysisDependencyForRelationCandidate(
            candidate.candidateId,
            candidate.endpointNodeIds,
            candidate.aiDependency,
          ),
        }),
      ]),
    ),
  });
}

/** 最終項目、関係、前回値から個人催促の計画入力を一度だけ組み立てる。 */
export function createPersonalReminderPlanningContext(
  run: GraphReconciledRun,
): PersonalReminderPlanningContext {
  const analysesByNodeId = new Map(
    run.data.reduction.currentItems.map((analysis) => [analysis.item.nodeId, analysis]),
  );
  if (analysesByNodeId.size !== run.data.reduction.currentItems.length) {
    throw new TypeError("個人催促対象の最終項目IDが重複しています");
  }
  const detailsByNodeId = new Map(
    run.data.collection.details.map((detail) => [detail.nodeId, detail]),
  );
  const unavailableConsumerNodeIds = new Set(run.data.facts.unavailableConsumerNodeIds);
  const repositoriesById = new Map(
    run.data.approvedRepositories.map((repository) => [repository.id, repository]),
  );
  const items: PersonalReminderRuntimeCollectedItem[] = [];
  for (const fact of run.data.facts.items) {
    if (unavailableConsumerNodeIds.has(fact.item.nodeId)) {
      continue;
    }
    const analysis = analysesByNodeId.get(fact.item.nodeId);
    const detail = detailsByNodeId.get(fact.item.nodeId);
    assertNonNullable(analysis, `個人催促対象の最終項目がありません。対象: ${fact.item.nodeId}`);
    assertNonNullable(detail, `個人催促対象の詳細がありません。対象: ${fact.item.nodeId}`);
    if (detail.type !== analysis.item.type) {
      throw new TypeError(`個人催促対象の詳細種別が一致しません。対象: ${fact.item.nodeId}`);
    }
    const repository = repositoriesById.get(analysis.item.repositoryId);
    assertNonNullable(
      repository,
      `個人催促対象の公開リポジトリがありません。対象: ${fact.item.nodeId}`,
    );
    items.push(
      Object.freeze({
        item: runtimeItem(run, analysis.item),
        detail,
        localDecision: localDecision(analysis),
        aiAnalysisApplications: analysis.aiAnalysisApplications,
        relatedContexts: relatedContexts(run, analysis, analysesByNodeId, detailsByNodeId),
        completeness: Object.freeze({ status: "complete" }),
        repositoryFullName: `${repository.owner}/${repository.name}`,
        currentLabels: analysis.item.labels,
      }),
    );
  }
  const currentEvidenceBySourceId = indexPersonalReminderEvidence([
    ...run.data.finalItems.map((item) => item.evidence),
    ...run.data.graph.edges.map((edge) => edge.evidence),
  ]);
  const state = previousState(run);
  const context = createPersonalReminderRuntimeContext({
    evaluatedAt: run.data.collection.evaluatedAt,
    state,
    collection: Object.freeze({
      items: Object.freeze(items),
      staleNodeIds: new Set(run.data.collection.staleItems.map((item) => item.nodeId)),
    }),
    graph: runtimeGraph(run),
    aiDependencyContext: aiDependencyContext(run),
    currentEvidenceBySourceId,
  });
  return Object.freeze({
    context,
    currentEvidenceBySourceId,
    previousEvidenceBySourceId: state.previousEvidenceBySourceId,
    unavailableConsumerNodeIds,
  });
}

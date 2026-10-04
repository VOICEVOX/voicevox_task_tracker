import { createGraphReconciledStageProof } from "../contracts/proofs.js";
import {
  createFinalGraphProjection,
  type FinalGraphProjection,
} from "../../../graph/final-graph-projection.js";
import { projectGraphReconciledRunCore, type StageState } from "../contracts/run-core.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import type { GraphFinalItem } from "../contracts/graph-final-item.js";
import type {
  GraphReconciliationResult,
  GraphReduction,
  GraphWorkingReduction,
  GraphWorkingResult,
} from "./graph-reconciliation-contracts.js";
import { blockerValueAiDependencies } from "./graph-reconciliation-blocker-values.js";
import { createGraphFinalContext, type GraphFinalContext } from "./graph-reconciliation-context.js";
import { finalizeGraphItems } from "./graph-reconciliation-final-items.js";
import { projectFinalSnapshotGraph } from "./final-snapshot-collection.js";
import { reconcileGraphPass } from "./graph-reconciliation-graph.js";
import {
  blockerNodeAiDependenciesByBlockedNodeId,
  graphAiDependenciesByNodeId,
} from "./graph-reconciliation-graph-indexes.js";
import { graphReconciliationCollection } from "./graph-reconciliation-input.js";
import { reduceAnalysisPass } from "./graph-reconciliation-item-reduction.js";
import { graphWorkingState } from "./graph-reconciliation-previous-items.js";
import { previousGraphIndex } from "./graph-reconciliation-previous.js";

/** 最終関係、グラフ指標、項目値とAI依存が確定したrun。 */
export type GraphReconciledRun = StageState<
  "graph_reconciled",
  Readonly<{
    approvedRepositories: GenericAiAdoptedRun["data"]["approvedRepositories"];
    allowlistDigest: GenericAiAdoptedRun["data"]["allowlistDigest"];
    collection: GenericAiAdoptedRun["data"]["collection"];
    sourceCatalog: GenericAiAdoptedRun["data"]["sourceCatalog"];
    facts: GenericAiAdoptedRun["data"]["facts"];
    aiItems: readonly GenericAiItemAdoption[];
    reduction: GraphReduction;
    graph: GraphReconciliationResult;
    finalItems: readonly GraphFinalItem[];
    finalGraphProjection: FinalGraphProjection;
    context: GraphFinalContext;
    snapshotProjection: ReturnType<typeof projectFinalSnapshotGraph>;
  }>
>;

function canonicalEntries<Key, Value>(
  values: ReadonlyMap<Key, Value>,
): readonly (readonly [Key, Value])[] {
  return Object.freeze(
    [...values.entries()].map(([key, value]): readonly [Key, Value] => Object.freeze([key, value])),
  );
}

function canonicalReduction(
  working: GraphWorkingReduction,
  graph: GraphWorkingResult,
  finalItems: readonly GraphFinalItem[],
): GraphReduction {
  const blockerNodeDependencies = blockerNodeAiDependenciesByBlockedNodeId(graph);
  const negativeBlockerDependencies = graphAiDependenciesByNodeId(
    graph.negativeBlockerAiDependencies,
    "negative blocker AI依存",
  );
  return Object.freeze({
    items: finalItems,
    currentItems: Object.freeze(
      working.currentItems.map((current) =>
        Object.freeze({
          ...current,
          blockerValueAiDependencies: blockerValueAiDependencies(
            current.item.nodeId,
            current.deterministicDecision.blockerDecisionTrace,
            blockerNodeDependencies,
            negativeBlockerDependencies,
          ),
        }),
      ),
    ),
    stalenessByNodeId: canonicalEntries(working.stalenessByNodeId),
    relationAssessments: working.relationAssessments,
    retainedNotificationRecommendations: canonicalEntries(
      working.retainedNotificationRecommendations,
    ),
    runStatus: working.runStatus,
  });
}

function canonicalGraph(working: GraphWorkingResult): GraphReconciliationResult {
  return Object.freeze({
    ...working,
    effectiveStateByNodeId: canonicalEntries(working.effectiveStateByNodeId),
    relationCandidateAiDependencies: canonicalEntries(working.relationCandidateAiDependencies),
    openNodeIds: Object.freeze([...working.openNodeIds]),
  });
}

/** 採用済みAIと決定論的factsから最終graphと全項目値を確定する。 */
export function reconcileAdoptedGraph(adopted: GenericAiAdoptedRun): GraphReconciledRun {
  const configuration = Object.freeze({ config: adopted.core.graphInput.config });
  const state = graphWorkingState(adopted.core.graphInput.previousSnapshot);
  const inventory = Object.freeze({ repositories: adopted.data.approvedRepositories });
  const collection = graphReconciliationCollection(adopted);
  const previousIndex = previousGraphIndex(adopted.core.graphInput.previousSnapshot);
  const firstReduction = reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    adopted,
    undefined,
    previousIndex,
  );
  const provisionalGraph = reconcileGraphPass(
    configuration,
    state,
    collection,
    firstReduction,
    previousIndex,
  );
  const secondReduction = reduceAnalysisPass(
    configuration,
    state,
    inventory,
    collection,
    adopted,
    provisionalGraph,
    previousIndex,
  );
  const finalGraph = reconcileGraphPass(
    configuration,
    state,
    collection,
    secondReduction,
    previousIndex,
  );
  const finalItems = finalizeGraphItems(
    configuration,
    state,
    inventory,
    collection,
    secondReduction,
    finalGraph,
    adopted.data.items,
  );
  return Object.freeze({
    stage: "graph_reconciled",
    core: projectGraphReconciledRunCore(adopted.core),
    data: Object.freeze({
      approvedRepositories: adopted.data.approvedRepositories,
      allowlistDigest: adopted.data.allowlistDigest,
      collection: adopted.data.collection,
      sourceCatalog: adopted.data.sourceCatalog,
      facts: adopted.data.facts,
      aiItems: adopted.data.items,
      reduction: canonicalReduction(secondReduction, finalGraph, finalItems),
      graph: canonicalGraph(finalGraph),
      finalItems,
      snapshotProjection: projectFinalSnapshotGraph(
        adopted,
        collection,
        finalItems,
        secondReduction.runStatus,
      ),
      finalGraphProjection: createFinalGraphProjection({
        evaluatedAt: collection.evaluatedAt,
        timezone: adopted.core.graphInput.config.staleness.timezone,
        items: finalItems,
        staleRepositoryIds: new Set(
          collection.repositoryResults
            .filter((result) => result.freshness === "stale")
            .map((result) => result.repository.id),
        ),
        relations: finalGraph.edges,
        effectiveStateByNodeId: [...finalGraph.effectiveStateByNodeId],
        analysis: finalGraph.analysis,
      }),
      context: createGraphFinalContext(state, collection, finalItems, finalGraph),
    }),
    proof: createGraphReconciledStageProof(),
  });
}

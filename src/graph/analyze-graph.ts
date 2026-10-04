import { downstreamImpactAiDependency } from "./analyze-graph-contributors.js";
import {
  createActionableFrontier,
  createDependencyCycles,
  createDirectedBlocksGraph,
  indexSnapshot,
  stronglyConnectedComponents,
} from "./analyze-graph-core.js";
import {
  blocksArcDependencies,
  downstreamImpactAiDependenciesWithCandidates,
  relationSetAiDependencies,
} from "./analyze-graph-dependencies.js";
import {
  createDownstreamImpacts,
  createImpactAnalysis,
  createReachability,
} from "./analyze-graph-impact.js";
import {
  createPublicValueSensitivityIndex,
  validateCandidateDecisionProofs,
} from "./analyze-graph-proof.js";
import {
  createConnectedComponents,
  createReclassificationTargets,
} from "./analyze-graph-reclassification.js";
import { validateInput } from "./analyze-graph-schema.js";
import { normalizePositiveSupportArcs, potentialBlocksArcs } from "./analyze-graph-support-arcs.js";
import {
  type AnalyzeGraphAiDependenciesInput,
  type AnalyzeGraphAiDependenciesResult,
  type AnalyzeGraphInput,
  type AnalyzeGraphResult,
} from "./analyze-graph-types.js";

/** 確定graphからcycle、frontier、impact、component、隣接変化を算出する。 */
export function analyzeGraph(input: AnalyzeGraphInput): AnalyzeGraphResult {
  validateInput(input);
  const current = indexSnapshot(input.current, "現在snapshot");
  const previous =
    input.previous.availability === "available"
      ? indexSnapshot(input.previous.snapshot, "前回snapshot")
      : undefined;
  const directedBlocksGraph = createDirectedBlocksGraph(
    current.nodesById,
    current.effectiveBlocksEdges,
  );
  const stronglyConnected = stronglyConnectedComponents(directedBlocksGraph);
  const dependencyCycles = createDependencyCycles(
    directedBlocksGraph,
    stronglyConnected,
    current.effectiveBlocksEdges,
  );
  const reachability = createReachability(
    directedBlocksGraph,
    stronglyConnected,
    current.nodesById,
  );
  const reclassification = createReclassificationTargets(current, previous);

  return Object.freeze({
    dependencyCycles,
    actionableFrontier: createActionableFrontier(
      directedBlocksGraph,
      current.nodesById,
      dependencyCycles,
    ),
    downstreamImpacts: createDownstreamImpacts(current.nodesById, stronglyConnected, reachability),
    downstreamImpactAiDependencies: downstreamImpactAiDependency(
      current.nodesById,
      current.effectiveBlocksEdges,
      Object.freeze({
        graph: directedBlocksGraph,
        stronglyConnected,
        reachability,
      }),
    ),
    connectedComponents: createConnectedComponents(current.nodesById, current.activeEdges),
    reclassificationTargets: reclassification.targets,
    newlyUnblockedNodeIds: reclassification.newlyUnblockedNodeIds,
  });
}

/** 関係候補の不在proofを含むgraphからAI依存を算出する。 */
export function analyzeGraphAiDependencies(
  input: AnalyzeGraphAiDependenciesInput,
): AnalyzeGraphAiDependenciesResult {
  const result = analyzeGraph({
    current: input.current,
    previous: input.previous,
  });
  const current = indexSnapshot(input.current, "現在snapshot");
  const candidateProofSnapshot = indexSnapshot(input.candidateProofSnapshot, "関係候補snapshot");
  const proofs = validateCandidateDecisionProofs(
    candidateProofSnapshot,
    input.candidateDecisionProofs,
  );
  const valueSensitivity = createPublicValueSensitivityIndex(current, candidateProofSnapshot);
  const valueProofs = proofs.filter((proof) =>
    proof.endpointNodeIds.every((nodeId) => valueSensitivity.nodesById.has(nodeId)),
  );
  const positiveSupportArcs = normalizePositiveSupportArcs(valueSensitivity.effectiveBlocksEdges);
  const base = createImpactAnalysis(valueSensitivity.nodesById, positiveSupportArcs);
  const potentialArcs = potentialBlocksArcs(valueSensitivity, proofs);
  const blockerDependencies = blocksArcDependencies(
    valueSensitivity.nodesById,
    valueSensitivity.effectiveBlocksEdges,
    potentialArcs,
  );
  return Object.freeze({
    ...result,
    downstreamImpactAiDependencies: Object.freeze(
      downstreamImpactAiDependenciesWithCandidates(
        valueSensitivity.nodesById,
        base,
        positiveSupportArcs,
        potentialArcs,
      ).filter((entry) => current.nodesById.has(entry.nodeId)),
    ),
    blockerSetAiDependencies: Object.freeze(
      blockerDependencies.blockerSetAiDependencies.filter((entry) =>
        current.nodesById.has(entry.nodeId),
      ),
    ),
    blockerNodeAiDependencies: Object.freeze(
      blockerDependencies.blockerNodeAiDependencies.filter((entry) =>
        current.nodesById.has(entry.blockedNodeId),
      ),
    ),
    negativeBlockerAiDependencies: Object.freeze(
      blockerDependencies.negativeBlockerAiDependencies.filter((entry) =>
        current.nodesById.has(entry.nodeId),
      ),
    ),
    relationSetAiDependencies: Object.freeze(
      relationSetAiDependencies(
        valueSensitivity.nodesById,
        valueSensitivity.activeEdges,
        valueProofs,
      ).filter((entry) => current.nodesById.has(entry.nodeId)),
    ),
  });
}

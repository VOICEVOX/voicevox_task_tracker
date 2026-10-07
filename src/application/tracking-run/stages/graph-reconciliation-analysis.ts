import {
  analyzeGraph,
  analyzeGraphAiDependencies,
  type AnalyzeGraphAiDependenciesResult,
  type AnalyzeGraphResult,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type ReconciledGraphEdge,
  type ReconcileGraphResult,
} from "../../../graph/index.js";

type GraphAnalysisInput = Readonly<{
  graphNodes: readonly GraphAnalysisNode[];
  aiGraphNodes: readonly GraphAnalysisNode[];
  edges: readonly ReconciledGraphEdge[];
  aiEdges: readonly ReconciledGraphEdge[];
  previous: GraphAnalysisSnapshot | undefined;
  candidateDecisionProofs: ReconcileGraphResult["candidateDecisionProofs"];
}>;

/** 現在のグラフと候補証明用グラフを解析する。 */
export function analyzeCurrentGraph(input: GraphAnalysisInput): Readonly<{
  analysis: AnalyzeGraphResult;
  aiAnalysis: AnalyzeGraphAiDependenciesResult;
}> {
  const { graphNodes, aiGraphNodes, edges, aiEdges, previous, candidateDecisionProofs } = input;
  const analysis = analyzeGraph({
    current: {
      nodes: graphNodes,
      edges,
    },
    previous:
      previous == null
        ? {
            availability: "unavailable",
          }
        : {
            availability: "available",
            snapshot: previous,
          },
  });
  const aiAnalysis = analyzeGraphAiDependencies({
    current: {
      nodes: graphNodes,
      edges,
    },
    candidateProofSnapshot: {
      nodes: aiGraphNodes,
      edges: aiEdges,
    },
    previous:
      previous == null
        ? {
            availability: "unavailable",
          }
        : {
            availability: "available",
            snapshot: previous,
          },
    candidateDecisionProofs,
  });
  return Object.freeze({ analysis, aiAnalysis });
}

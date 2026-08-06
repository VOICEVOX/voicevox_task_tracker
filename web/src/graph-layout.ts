import {
  Graph,
  layout,
  type EdgeLabel,
  type GraphLabel,
  type NodeLabel,
  type Point,
} from "@dagrejs/dagre";

import type { GraphViewEdge, GraphViewNode, ItemGraphView } from "./graph-model.js";

/** 自動配置後のgraph node。 */
export type LayoutedGraphNode = Readonly<{
  node: GraphViewNode;
  x: number;
  y: number;
}>;

/** 自動配置後のgraph edge。 */
export type LayoutedGraphEdge = Readonly<{
  edge: GraphViewEdge;
  points: readonly Point[];
  labelPoint: Point;
}>;

/** SVG viewBoxへ渡す自動配置結果。 */
export type GraphLayout = Readonly<{
  width: number;
  height: number;
  nodes: readonly LayoutedGraphNode[];
  edges: readonly LayoutedGraphEdge[];
}>;

function requiredFiniteNumber(value: number | undefined, name: string): number {
  if (value == null || !Number.isFinite(value)) {
    throw new TypeError(`${name}を自動配置結果から取得できません`);
  }
  return value;
}

function edgeWeight(edge: GraphViewEdge): number {
  switch (edge.type) {
    case "blocks":
      return 6;
    case "parent_of":
      return 4;
    case "implements":
      return 3;
    case "duplicates":
      return 2;
    case "related_to":
      return 1;
  }
}

function labelPoint(points: readonly Point[]): Point {
  const point = points[Math.floor(points.length / 2)];
  if (point == null) {
    throw new TypeError("graph edgeの自動配置点がありません");
  }
  return point;
}

/** Dagreでblockerからblocked itemへ左から右に自動配置する。 */
export function layoutItemGraph(view: ItemGraphView): GraphLayout {
  if (view.displayNodes.length === 0) {
    throw new TypeError("自動配置するgraph nodeがありません");
  }
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({
    directed: true,
    multigraph: true,
    compound: false,
  })
    .setGraph({
      rankdir: "LR",
      nodesep: 32,
      edgesep: 18,
      ranksep: 92,
      marginx: 36,
      marginy: 36,
      acyclicer: "greedy",
      ranker: "longest-path",
    })
    .setDefaultEdgeLabel(() => ({}));

  for (const node of view.displayNodes) {
    graph.setNode(node.id, {
      width: node.width,
      height: node.height,
    });
  }
  for (const edge of view.displayEdges) {
    graph.setEdge(
      edge.fromNodeId,
      edge.toNodeId,
      {
        minlen: 1,
        weight: edgeWeight(edge),
      },
      edge.id,
    );
  }

  layout(graph);
  const graphLabel = graph.graph();
  const nodes = view.displayNodes.map((node) => {
    const nodeLabel = graph.node(node.id);
    return {
      node,
      x: requiredFiniteNumber(nodeLabel.x, `graph node ${node.id}のx座標`),
      y: requiredFiniteNumber(nodeLabel.y, `graph node ${node.id}のy座標`),
    };
  });
  const edges = view.displayEdges.map((edge) => {
    const edgeLabel = graph.edge(edge.fromNodeId, edge.toNodeId, edge.id);
    if (edgeLabel.points == null || edgeLabel.points.length === 0) {
      throw new TypeError(`graph edge ${edge.id}の自動配置点がありません`);
    }
    return {
      edge,
      points: edgeLabel.points.map((point) => ({
        x: point.x,
        y: point.y,
      })),
      labelPoint: labelPoint(edgeLabel.points),
    };
  });

  return {
    width: requiredFiniteNumber(graphLabel.width, "graph全体の幅"),
    height: requiredFiniteNumber(graphLabel.height, "graph全体の高さ"),
    nodes,
    edges,
  };
}

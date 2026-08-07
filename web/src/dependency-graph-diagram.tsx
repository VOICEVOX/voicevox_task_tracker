import { type VNode } from "preact";
import { useEffect, useState } from "preact/hooks";

import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import type { GraphLayout, LayoutedGraphNode } from "./graph-layout.js";
import { graphNodeKindLabel, type ItemGraphView, type GraphViewNode } from "./graph-model.js";
import { ContentState } from "./layout.js";

type GraphDiagramNavigation = Readonly<{
  status: "item_details";
  createItemHref: (nodeId: string) => string;
  onSelectItem: (nodeId: string) => void;
}>;

type DependencyGraphDiagramProps = Readonly<{
  description: string;
  idPrefix: string;
  navigation: GraphDiagramNavigation;
  title: string;
  view: ItemGraphView;
}>;

type LayoutState =
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      layout: GraphLayout;
    }>
  | Readonly<{
      status: "failed";
    }>;

function truncateGraphText(value: string, maximumLength: number): string {
  const characters = [...value];
  if (characters.length <= maximumLength) {
    return value;
  }
  return `${characters.slice(0, maximumLength - 1).join("")}…`;
}

function nodeIcon(node: GraphViewNode): string {
  switch (node.kind) {
    case "issue":
      return "ISSUE";
    case "pull_request":
      return "PR";
    case "external_reference":
      return "外部";
    default:
      throw new UnreachableError(node.kind);
  }
}

function nodeShape(nodeLayout: LayoutedGraphNode): VNode {
  const { node, x, y } = nodeLayout;
  const left = x - node.width / 2;
  const top = y - node.height / 2;
  switch (node.kind) {
    case "issue":
      return (
        <rect x={left} y={top} width={node.width} height={node.height} rx={node.height * 0.2} />
      );
    case "pull_request": {
      const corner = node.height * 0.22;
      return (
        <polygon
          points={[
            `${left + corner},${top}`,
            `${left + node.width - corner},${top}`,
            `${left + node.width},${y}`,
            `${left + node.width - corner},${top + node.height}`,
            `${left + corner},${top + node.height}`,
            `${left},${y}`,
          ].join(" ")}
        />
      );
    }
    case "external_reference":
      return (
        <polygon
          points={[
            `${x},${top}`,
            `${left + node.width},${y}`,
            `${x},${top + node.height}`,
            `${left},${y}`,
          ].join(" ")}
        />
      );
    default:
      throw new UnreachableError(node.kind);
  }
}

function graphPath(points: GraphLayout["edges"][number]["points"]): string {
  const firstPoint = points[0];
  assertNonNullable(firstPoint, "graph edgeの始点がありません");
  return [
    `M ${firstPoint.x.toString()} ${firstPoint.y.toString()}`,
    ...points.slice(1).map((point) => `L ${point.x.toString()} ${point.y.toString()}`),
  ].join(" ");
}

function GraphSvgNode({
  navigation,
  nodeLayout,
}: Readonly<{
  navigation: GraphDiagramNavigation;
  nodeLayout: LayoutedGraphNode;
}>) {
  const { node, x, y } = nodeLayout;
  const frontierLabel = node.frontier ? "、着手可能な項目" : "";
  const centralLabel = node.central ? "、中心項目" : "";
  const content = (
    <g
      class={`graph-node graph-node-${node.kind} ${node.central ? "graph-node-central" : ""}`}
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-central={node.central ? "true" : "false"}
      data-frontier={node.frontier ? "true" : "false"}
      role="group"
      aria-label={`${graphNodeKindLabel(node.kind)}、${node.reference}、${node.title}${centralLabel}${frontierLabel}`}
    >
      <title>
        {node.reference} {node.title}
      </title>
      {nodeShape(nodeLayout)}
      {node.central && (
        <text class="graph-central-label" x={x} y={y - node.height / 2 - 8}>
          中心項目
        </text>
      )}
      <text class="graph-node-icon" x={x} y={y - node.height * 0.25}>
        {nodeIcon(node)}
      </text>
      <text class="graph-node-reference" x={x} y={y - 2}>
        {truncateGraphText(node.reference, 28)}
      </text>
      <text class="graph-node-title" x={x} y={y + node.height * 0.2}>
        {truncateGraphText(node.title, 32)}
      </text>
      {node.frontier && (
        <text class="graph-frontier-label" x={x} y={y + node.height * 0.39}>
          ▶ 着手可能
        </text>
      )}
    </g>
  );
  if (node.central || (node.kind !== "issue" && node.kind !== "pull_request")) {
    return content;
  }
  return (
    <a
      class="graph-node-link"
      href={navigation.createItemHref(node.id)}
      aria-label={`${node.reference} ${node.title}の詳細ページへ`}
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) {
          return;
        }
        event.preventDefault();
        navigation.onSelectItem(node.id);
      }}
    >
      {content}
    </a>
  );
}

function GraphSvg({
  description,
  idPrefix,
  layout,
  navigation,
  title,
}: Readonly<{
  description: string;
  idPrefix: string;
  layout: GraphLayout;
  navigation: GraphDiagramNavigation;
  title: string;
}>) {
  return (
    <div class="graph-viewport" data-layout-status="ready">
      <svg
        class="dependency-graph-svg"
        viewBox={`0 0 ${layout.width.toString()} ${layout.height.toString()}`}
        width={Math.max(layout.width, 760)}
        height={Math.max(layout.height, 360)}
        role="group"
        aria-labelledby={`${idPrefix}-title ${idPrefix}-description`}
        data-rendered-node-count={layout.nodes.length}
      >
        <title id={`${idPrefix}-title`}>{title}</title>
        <desc id={`${idPrefix}-description`}>{description}</desc>
        <defs>
          <marker
            id={`${idPrefix}-arrow`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <g class="graph-edges">
          {layout.edges.map(({ edge, points, labelPoint }) => (
            <g
              key={edge.id}
              class={`graph-edge graph-edge-${edge.type} ${
                edge.authoritative ? "graph-edge-authoritative" : "graph-edge-inferred"
              }`}
              data-edge-id={edge.id}
              data-edge-type={edge.type}
              data-authority={edge.authoritative ? "authoritative" : "inferred"}
            >
              <path d={graphPath(points)} marker-end={`url(#${idPrefix}-arrow)`} />
              <text x={labelPoint.x} y={labelPoint.y - 5}>
                <tspan x={labelPoint.x}>{edge.typeLabel}</tspan>
                <tspan x={labelPoint.x} dy="1.15em">
                  {edge.authorityLabel}
                </tspan>
              </text>
            </g>
          ))}
        </g>
        <g class="graph-nodes">
          {layout.nodes.map((nodeLayout) => (
            <GraphSvgNode
              key={nodeLayout.node.id}
              nodeLayout={nodeLayout}
              navigation={navigation}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

/** 項目の部分グラフを自動配置してSVGで表示する。 */
export function DependencyGraphDiagram({
  description,
  idPrefix,
  navigation,
  title,
  view,
}: DependencyGraphDiagramProps) {
  const [layoutState, setLayoutState] = useState<LayoutState>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setLayoutState({
      status: "loading",
    });
    void import("./graph-layout.js")
      .then(({ layoutItemGraph }) => layoutItemGraph(view))
      .then((layout) => {
        if (active) {
          setLayoutState({
            status: "loaded",
            layout,
          });
        }
      })
      .catch((error: unknown) => {
        console.error("依存グラフの自動配置に失敗しました", error);
        if (active) {
          setLayoutState({
            status: "failed",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [view]);

  let graph: VNode;
  switch (layoutState.status) {
    case "loading":
      graph = (
        <ContentState
          className="graph-loading"
          data-layout-status="loading"
          message="依存グラフを自動配置しています。"
          status="loading"
        />
      );
      break;
    case "loaded":
      graph = (
        <GraphSvg
          description={description}
          idPrefix={idPrefix}
          layout={layoutState.layout}
          navigation={navigation}
          title={title}
        />
      );
      break;
    case "failed":
      graph = (
        <ContentState
          className="graph-load-failure"
          data-layout-status="failed"
          message="依存グラフを自動配置できませんでした。"
          status="failed"
        />
      );
      break;
    default:
      throw new UnreachableError(layoutState);
  }

  return (
    <div class="dependency-graph-diagram">
      <p class="graph-node-size-description">
        ノードの大きさは、停滞の長さと、その項目がブロックしている項目の広がりで決まります。
      </p>
      {graph}
    </div>
  );
}

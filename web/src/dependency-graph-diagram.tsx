import { type VNode } from "preact";
import { useEffect, useState } from "preact/hooks";

import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { shouldHandleClientNavigation } from "./client-navigation.js";
import type { GraphLayout, LayoutedGraphNode } from "./graph-layout.js";
import {
  graphNodeKindLabel,
  type GraphViewEdge,
  type GraphViewNode,
  type ItemGraphView,
} from "./graph-model.js";
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

const GRAPH_NODE_FILL_CLASS_NAMES = {
  external_reference: "fill-graph-node-external-reference-background",
  issue: "fill-graph-node-issue-background",
  pull_request: "fill-graph-node-pull-request-background",
} satisfies Readonly<Record<GraphViewNode["kind"], string>>;

const GRAPH_NODE_STROKE_CLASS_NAMES = {
  external_reference: "stroke-graph-node-external-reference-border [stroke-dasharray:7_3]",
  issue: "stroke-graph-node-issue-border",
  pull_request: "stroke-graph-node-pull-request-border",
} satisfies Readonly<Record<GraphViewNode["kind"], string>>;

const GRAPH_NODE_TEXT_CLASS_NAME =
  "fill-text-primary [dominant-baseline:central] [text-anchor:middle] pointer-events-none";
const GRAPH_NODE_FITTED_TEXT_CLASS_NAME =
  "h-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-text-primary text-graph-label leading-5";
const GRAPH_EDGE_TEXT_CLASS_NAME =
  "fill-text-secondary stroke-surface-sunken [stroke-width:var(--stroke-width-graph-edge-label)] [paint-order:stroke] [text-anchor:middle] text-graph-label font-bold";
const GRAPH_NODE_TEXT_LINE_HEIGHT = 20;
const GRAPH_NODE_TEXT_HORIZONTAL_PADDING = 16;

type GraphNodeRow = "icon" | "reference" | "title" | "metrics" | "frontier";

function graphNodeShapeClassName(node: GraphViewNode, linked: boolean): string {
  const strokeClassName = node.central
    ? "stroke-graph-node-central-accent [stroke-width:var(--stroke-width-graph-node-emphasis)]"
    : `${GRAPH_NODE_STROKE_CLASS_NAMES[node.kind]} [stroke-width:var(--stroke-width-graph-node)]`;
  const linkedClassName = linked
    ? "group-hover:stroke-graph-node-central-accent group-hover:[stroke-width:var(--stroke-width-graph-node-emphasis)] group-focus-visible:stroke-graph-node-central-accent group-focus-visible:[stroke-width:var(--stroke-width-graph-node-emphasis)]"
    : "";
  return `${GRAPH_NODE_FILL_CLASS_NAMES[node.kind]} ${strokeClassName} ${linkedClassName}`;
}

function graphEdgePathClassName(edge: GraphViewEdge): string {
  const colorClassName = edge.authoritative
    ? "stroke-graph-edge-authoritative"
    : "stroke-graph-edge-inferred";
  const widthClassName = edge.authoritative
    ? "[stroke-width:var(--stroke-width-graph-edge-authoritative)]"
    : "[stroke-width:var(--stroke-width-graph-edge)]";
  const patternClassName = edge.authoritative ? "" : "[stroke-dasharray:8_6]";
  return `fill-none ${colorClassName} ${widthClassName} ${patternClassName}`;
}

function graphEdgeAuthorityLabel(edge: GraphViewEdge): "確定関係" | "推定関係" {
  return edge.authoritative ? "確定関係" : "推定関係";
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
      throw new UnreachableError(node);
  }
}

function nodeShape(nodeLayout: LayoutedGraphNode, linked: boolean): VNode {
  const { node, x, y } = nodeLayout;
  const left = x - node.width / 2;
  const top = y - node.height / 2;
  const className = graphNodeShapeClassName(node, linked);
  switch (node.kind) {
    case "issue":
      return (
        <rect
          class={className}
          x={left}
          y={top}
          width={node.width}
          height={node.height}
          rx={node.height * 0.2}
        />
      );
    case "pull_request": {
      const corner = node.height * 0.22;
      return (
        <polygon
          class={className}
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
          class={className}
          points={[
            `${x},${top}`,
            `${left + node.width},${y}`,
            `${x},${top + node.height}`,
            `${left},${y}`,
          ].join(" ")}
        />
      );
    default:
      throw new UnreachableError(node);
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

function graphNodeTextWidth(node: GraphViewNode, verticalOffset: number): number {
  const offsetRatio = Math.abs(verticalOffset) / (node.height / 2);
  let shapeInset: number;
  switch (node.kind) {
    case "issue":
      shapeInset = 0;
      break;
    case "pull_request":
      shapeInset = node.height * 0.22 * offsetRatio;
      break;
    case "external_reference":
      shapeInset = (node.width / 2) * offsetRatio;
      break;
    default:
      throw new UnreachableError(node);
  }
  return node.width - 2 * (GRAPH_NODE_TEXT_HORIZONTAL_PADDING + shapeInset);
}

function graphNodeRows(node: GraphViewNode): readonly GraphNodeRow[] {
  const rows: GraphNodeRow[] = ["icon", "reference", "title"];
  if (node.kind !== "external_reference") {
    rows.push("metrics");
  }
  if (node.frontier) {
    rows.push("frontier");
  }
  return rows;
}

function graphNodeRowOffset(row: GraphNodeRow, rows: readonly GraphNodeRow[]): number {
  const rowIndex = rows.indexOf(row);
  if (rowIndex === -1) {
    throw new TypeError(`graph nodeに${row}行がありません`);
  }
  return (rowIndex - (rows.length - 1) / 2) * GRAPH_NODE_TEXT_LINE_HEIGHT;
}

function FittedGraphNodeText({
  className,
  value,
  width,
  x,
  y,
}: Readonly<{
  className: string;
  value: string;
  width: number;
  x: number;
  y: number;
}>): VNode {
  return (
    <foreignObject
      class="pointer-events-none overflow-hidden"
      x={x - width / 2}
      y={y - GRAPH_NODE_TEXT_LINE_HEIGHT / 2}
      width={width}
      height={GRAPH_NODE_TEXT_LINE_HEIGHT}
    >
      <div class={`${className} ${GRAPH_NODE_FITTED_TEXT_CLASS_NAME}`}>{value}</div>
    </foreignObject>
  );
}

function GraphSvgNode({
  navigation,
  nodeLayout,
}: Readonly<{
  navigation: GraphDiagramNavigation;
  nodeLayout: LayoutedGraphNode;
}>) {
  const { node, x, y } = nodeLayout;
  const linked = !node.central && (node.kind === "issue" || node.kind === "pull_request");
  const ariaLabelParts = [graphNodeKindLabel(node.kind), node.fullReference, node.title];
  if (node.central) {
    ariaLabelParts.push("中心項目");
  }
  if (node.frontier) {
    ariaLabelParts.push("着手可能な項目");
  }
  if (node.kind !== "external_reference") {
    ariaLabelParts.push(
      `停滞日数${Math.floor(node.stallDays).toString()}日`,
      `影響するopen項目${node.impactOpenNodeCount.toString()}件`,
    );
  }
  const ariaLabel = ariaLabelParts.join("、");
  const rows = graphNodeRows(node);
  const iconOffset = graphNodeRowOffset("icon", rows);
  const referenceOffset = graphNodeRowOffset("reference", rows);
  const titleOffset = graphNodeRowOffset("title", rows);
  const content = (
    <g
      class={`graph-node graph-node-${node.kind} ${node.central ? "graph-node-central" : ""}`}
      data-node-id={node.id}
      data-node-kind={node.kind}
      data-central={node.central ? "true" : "false"}
      data-frontier={node.frontier ? "true" : "false"}
      role="group"
      aria-label={ariaLabel}
    >
      <title>
        {node.fullReference} {node.title}
      </title>
      {nodeShape(nodeLayout, linked)}
      <text
        class={`graph-node-icon ${GRAPH_NODE_TEXT_CLASS_NAME} text-graph-label font-extrabold tracking-widest`}
        x={x}
        y={y + iconOffset}
      >
        {nodeIcon(node)}
      </text>
      <FittedGraphNodeText
        className="graph-node-reference font-extrabold"
        value={node.shortReference}
        width={graphNodeTextWidth(node, referenceOffset)}
        x={x}
        y={y + referenceOffset}
      />
      <FittedGraphNodeText
        className="graph-node-title"
        value={node.title}
        width={graphNodeTextWidth(node, titleOffset)}
        x={x}
        y={y + titleOffset}
      />
      {node.kind !== "external_reference" && (
        <FittedGraphNodeText
          className="graph-node-metrics font-semibold"
          value={`停滞${Math.floor(node.stallDays).toString()}日・影響${node.impactOpenNodeCount.toString()}件`}
          width={graphNodeTextWidth(node, graphNodeRowOffset("metrics", rows))}
          x={x}
          y={y + graphNodeRowOffset("metrics", rows)}
        />
      )}
      {node.frontier && (
        <text
          class={`graph-frontier-label ${GRAPH_NODE_TEXT_CLASS_NAME} fill-graph-frontier-text text-graph-label font-extrabold`}
          x={x}
          y={y + graphNodeRowOffset("frontier", rows)}
        >
          ▶ 着手可能
        </text>
      )}
    </g>
  );
  if (!linked) {
    return content;
  }
  return (
    <a
      class="graph-node-link group cursor-pointer"
      href={navigation.createItemHref(node.id)}
      aria-label={`${ariaLabel}、詳細ページへ`}
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
    <div
      class="graph-viewport max-h-200 overflow-auto rounded-xl border border-border-subtle bg-surface-sunken"
      data-layout-status="ready"
    >
      <svg
        class="dependency-graph-svg mx-auto block max-w-none bg-dependency-grid [background-size:2rem_2rem]"
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
            id={`${idPrefix}-arrow-authoritative`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path class="fill-graph-edge-authoritative" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
          <marker
            id={`${idPrefix}-arrow-inferred`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path class="fill-graph-edge-inferred" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <g class="graph-edges">
          {layout.edges.map(({ edge, points, labelPoint }) => {
            const authorityLabel = graphEdgeAuthorityLabel(edge);
            return (
              <g
                key={edge.id}
                class={`graph-edge graph-edge-${edge.type} ${
                  edge.authoritative ? "graph-edge-authoritative" : "graph-edge-inferred"
                }`}
                data-edge-id={edge.id}
                data-edge-type={edge.type}
                data-authority={edge.authoritative ? "authoritative" : "inferred"}
                role="group"
                aria-label={`${edge.typeLabel}、${authorityLabel}`}
              >
                <path
                  class={graphEdgePathClassName(edge)}
                  d={graphPath(points)}
                  marker-end={`url(#${idPrefix}-arrow-${
                    edge.authoritative ? "authoritative" : "inferred"
                  })`}
                />
                <text class={GRAPH_EDGE_TEXT_CLASS_NAME} x={labelPoint.x} y={labelPoint.y}>
                  {edge.typeLabel}
                </text>
              </g>
            );
          })}
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
    <div class="dependency-graph-diagram grid gap-3">
      <p class="graph-node-size-description m-0 text-text-secondary">
        ノードはすべて同じ大きさで表示します。
      </p>
      {graph}
    </div>
  );
}

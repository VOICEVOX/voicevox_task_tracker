import {
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphNodeDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const GRAPH_NODE_WIDTH = 240;
const GRAPH_NODE_HEIGHT = 112;

type GraphNodeKind = PublicGraphNodeDto["kind"];
type GraphNodeSeverity = PublicItemSummaryDto["severity"];
type RelationType = PublicGraphEdgeDto["type"];

/** 項目の部分グラフで描画するnode。 */
export type GraphViewNode = Readonly<{
  id: string;
  kind: GraphNodeKind;
  reference: string;
  title: string;
  central: boolean;
  frontier: boolean;
  stallDays: number;
  impactOpenNodeCount: number;
  impactRepositoryCount: number;
  width: number;
  height: number;
}>;

/** 自動レイアウトへ渡すedge表現。 */
export type GraphViewEdge = Readonly<{
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: RelationType;
  typeLabel: string;
  authorityLabel: "確定関係" | "推定関係";
  authoritative: boolean;
}>;

/** 項目の部分グラフに表示するnodeとedge。 */
export type ItemGraphView = Readonly<{
  displayNodes: readonly GraphViewNode[];
  displayEdges: readonly GraphViewEdge[];
  sourceEdges: readonly GraphViewEdge[];
  representedSourceNodeCount: number;
  omittedSourceNodeCount: number;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}は0以上の有限数にしてください`);
  }
}

/** graph node種別の色に依存しない表示名を返す。 */
export function graphNodeKindLabel(kind: GraphNodeKind): string {
  switch (kind) {
    case "issue":
      return "Issue";
    case "pull_request":
      return "Pull Request";
    case "external_reference":
      return "外部参照";
    default:
      throw new UnreachableError(kind);
  }
}

function relationTypeLabel(type: RelationType): string {
  switch (type) {
    case "blocks":
      return "ブロック";
    case "parent_of":
      return "親子";
    case "implements":
      return "実装";
    case "related_to":
      return "関連";
    case "duplicates":
      return "重複";
    default:
      throw new UnreachableError(type);
  }
}

function severityRank(severity: GraphNodeSeverity): number {
  switch (severity) {
    case "none":
      return 0;
    case "watch":
      return 1;
    case "urgent":
      return 2;
    case "critical":
      return 3;
    default:
      throw new UnreachableError(severity);
  }
}

function createTrackedGraphNode(
  node: Extract<PublicGraphNodeDto, Readonly<{ kind: "issue" | "pull_request" }>>,
  item: PublicItemSummaryDto,
  centralNodeIds: ReadonlySet<string>,
  frontierNodeIds: ReadonlySet<string>,
  now: Date,
): GraphViewNode {
  if (node.kind !== item.type) {
    throw new TypeError(`graph node ${node.nodeId}の種別がsummaryと一致しません`);
  }
  if (node.repositoryId !== item.repositoryId) {
    throw new TypeError(`graph node ${node.nodeId}のrepositoryがsummaryと一致しません`);
  }
  const stallDays = (now.getTime() - Date.parse(item.stallSince)) / MILLISECONDS_PER_DAY;
  finiteNonNegative(stallDays, `graph node ${node.nodeId}の停滞日数`);
  return {
    id: node.nodeId,
    kind: node.kind,
    reference: item.displayReference,
    title: item.title,
    central: centralNodeIds.has(node.nodeId),
    frontier: frontierNodeIds.has(node.nodeId),
    stallDays,
    impactOpenNodeCount: item.downstreamImpact.openNodeCount,
    impactRepositoryCount: item.downstreamImpact.repositoryCount,
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
  };
}

function createExternalGraphNode(
  node: Extract<PublicGraphNodeDto, Readonly<{ kind: "external_reference" }>>,
  centralNodeIds: ReadonlySet<string>,
  frontierNodeIds: ReadonlySet<string>,
): GraphViewNode {
  return {
    id: node.nodeId,
    kind: node.kind,
    reference: node.displayReference,
    title: node.title,
    central: centralNodeIds.has(node.nodeId),
    frontier: frontierNodeIds.has(node.nodeId),
    stallDays: 0,
    impactOpenNodeCount: 0,
    impactRepositoryCount: 0,
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
  };
}

function createEdgeView(edge: PublicGraphEdgeDto): GraphViewEdge {
  const authoritative = edge.provenance === "native";
  return {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    typeLabel: relationTypeLabel(edge.type),
    authorityLabel: authoritative ? "確定関係" : "推定関係",
    authoritative,
  };
}

function graphNodeSeverityRank(
  node: GraphViewNode,
  itemsByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
): number {
  if (node.kind === "external_reference") {
    return severityRank("none");
  }
  const item = itemsByNodeId.get(node.id);
  assertNonNullable(item, `graph node ${node.id}のsummary itemがありません`);
  return severityRank(item.severity);
}

function compareNodePriority(
  left: GraphViewNode,
  right: GraphViewNode,
  itemsByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
): number {
  const frontierOrder = Number(right.frontier) - Number(left.frontier);
  if (frontierOrder !== 0) {
    return frontierOrder;
  }
  const severityOrder =
    graphNodeSeverityRank(right, itemsByNodeId) - graphNodeSeverityRank(left, itemsByNodeId);
  if (severityOrder !== 0) {
    return severityOrder;
  }
  const repositoryImpactOrder = right.impactRepositoryCount - left.impactRepositoryCount;
  if (repositoryImpactOrder !== 0) {
    return repositoryImpactOrder;
  }
  const itemImpactOrder = right.impactOpenNodeCount - left.impactOpenNodeCount;
  if (itemImpactOrder !== 0) {
    return itemImpactOrder;
  }
  const stallOrder = right.stallDays - left.stallDays;
  if (stallOrder !== 0) {
    return stallOrder;
  }
  return compareStrings(left.id, right.id);
}

function assertPublicDetailsMatchSummary(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
): void {
  if (summary.runId !== details.runId || summary.generatedAt !== details.generatedAt) {
    throw new TypeError("summaryとdetailsの生成runが一致しません");
  }
}

function createSourceNodes(
  details: PublicDetailsDto,
  nodeIds: readonly string[],
  centralNodeIds: ReadonlySet<string>,
  itemsByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
  now: Date,
): readonly GraphViewNode[] {
  const graphNodesById = new Map(details.graph.nodes.map((node) => [node.nodeId, node]));
  const frontierNodeIds = new Set(details.graph.frontierNodeIds);

  return nodeIds.map((nodeId) => {
    const node = graphNodesById.get(nodeId);
    assertNonNullable(node, `部分グラフのgraph node ${nodeId}がありません`);
    if (node.kind === "external_reference") {
      return createExternalGraphNode(node, centralNodeIds, frontierNodeIds);
    }
    const item = itemsByNodeId.get(node.nodeId);
    assertNonNullable(item, `graph node ${node.nodeId}のsummary itemがありません`);
    return createTrackedGraphNode(node, item, centralNodeIds, frontierNodeIds, now);
  });
}

function selectDisplayNodes(
  sourceNodes: readonly GraphViewNode[],
  centralNodeIds: ReadonlySet<string>,
  itemsByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
  maxNodes: number,
): readonly GraphViewNode[] {
  const comparePriority = (left: GraphViewNode, right: GraphViewNode): number =>
    compareNodePriority(left, right, itemsByNodeId);
  const requiredNodes = sourceNodes.filter((node) => centralNodeIds.has(node.id));
  requiredNodes.sort(comparePriority);
  const requiredIds = new Set(requiredNodes.map((node) => node.id));
  const candidates = sourceNodes.filter((node) => !requiredIds.has(node.id)).sort(comparePriority);
  const remainingCapacity = Math.max(0, maxNodes - requiredNodes.length);
  return [...requiredNodes, ...candidates.slice(0, remainingCapacity)].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
}

function validateMaxNodes(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError("maxNodesは正の整数にしてください");
  }
}

/** 項目とactive edgeで直接つながる1 hopを設定上限付きの描画モデルへ変換する。 */
export function createItemGraphView(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
  nodeId: string,
  now: Date,
): ItemGraphView {
  assertPublicDetailsMatchSummary(summary, details);
  validateMaxNodes(summary.graph.maxNodes);
  const centerItem = summary.items.find((item) => item.nodeId === nodeId);
  assertNonNullable(centerItem, `summaryに中心項目 ${nodeId}がありません`);
  const centerNode = details.graph.nodes.find((node) => node.nodeId === centerItem.nodeId);
  assertNonNullable(centerNode, `detailsに中心項目 ${nodeId}のgraph nodeがありません`);
  if (centerNode.kind === "external_reference") {
    throw new TypeError(`中心項目 ${nodeId}を外部参照として表示できません`);
  }
  const activeEdges = details.graph.edges
    .filter(
      (edge) =>
        edge.active &&
        (edge.fromNodeId === centerNode.nodeId || edge.toNodeId === centerNode.nodeId),
    )
    .sort((left, right) => compareStrings(left.id, right.id));
  const nodeIds = [
    ...new Set([
      centerNode.nodeId,
      ...activeEdges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]),
    ]),
  ].sort(compareStrings);
  const centralNodeIds = new Set([centerNode.nodeId]);
  const itemsByNodeId = new Map(summary.items.map((item) => [item.nodeId, item]));
  const sourceNodes = createSourceNodes(details, nodeIds, centralNodeIds, itemsByNodeId, now);
  const displayNodes = selectDisplayNodes(
    sourceNodes,
    centralNodeIds,
    itemsByNodeId,
    summary.graph.maxNodes,
  );
  const representedNodeIds = new Set(displayNodes.map((node) => node.id));
  const sourceEdges = activeEdges
    .filter(
      (edge) => representedNodeIds.has(edge.fromNodeId) && representedNodeIds.has(edge.toNodeId),
    )
    .map(createEdgeView);

  return {
    displayNodes,
    displayEdges: sourceEdges,
    sourceEdges,
    representedSourceNodeCount: representedNodeIds.size,
    omittedSourceNodeCount: nodeIds.length - representedNodeIds.size,
  };
}

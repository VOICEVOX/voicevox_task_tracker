import type { Relation } from "../domain/index.js";
import type { FinalGraphProjection } from "../graph/final-graph-projection.js";
import type { StateSnapshot } from "../persistence/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import type {
  PublicGraphEdgeDto,
  PublicGraphNodeDto,
  PublicItemSummaryDto,
  PublicSummaryDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

export type PublicGraph = Readonly<{
  nodes: readonly PublicGraphNodeDto[];
  edges: readonly PublicGraphEdgeDto[];
}>;
type PublicAiCurrentness = PublicGraphEdgeDto["aiCurrentness"];

function createPublicAiCurrentness(relation: Relation): PublicAiCurrentness {
  if (relation.provenance === "native" && relation.aiDependency.status !== "not_dependent") {
    throw new PublicDtoSemanticError(
      `native relation ${relation.id}のAI依存はnot_dependentでなければなりません`,
    );
  }
  switch (relation.aiDependency.status) {
    case "not_dependent":
      return "not_dependent";
    case "current":
      return "current";
    case "unverified":
    case "unknown":
      return "unverified";
    default:
      throw new UnreachableError(relation.aiDependency);
  }
}

function createPublicGraphEdge(relation: Relation): PublicGraphEdgeDto {
  const fields = {
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    aiCurrentness: createPublicAiCurrentness(relation),
  };
  if (relation.active) {
    return {
      ...fields,
      active: true,
    };
  }
  return {
    ...fields,
    active: false,
  };
}

/** snapshotの確定graphを公開graphへ写す。 */
export function createPublicGraph(snapshot: StateSnapshot): PublicGraph {
  const effectiveStateByNodeId = new Map(
    snapshot.finalGraphProjection.nodes.map((node) => [node.nodeId, node.effectiveState]),
  );
  const nodes: PublicGraphNodeDto[] = snapshot.items.map((item) => {
    const state = effectiveStateByNodeId.get(item.nodeId);
    assertNonNullable(state, `公開graph node ${item.nodeId}のeffective stateがありません`);
    return {
      nodeId: item.nodeId,
      kind: item.type,
      repositoryId: item.repositoryId,
      state,
      status: item.status,
      severity: item.severity,
    };
  });
  nodes.push(
    ...snapshot.externalReferences.map((reference) => ({
      nodeId: reference.nodeId,
      kind: reference.kind,
      repositoryFullName: reference.repositoryFullName,
      displayReference: `${reference.repositoryFullName}#${reference.number.toString()}`,
      url: reference.url,
      title: reference.title,
      state: reference.state,
    })),
  );
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(snapshot.relations.map(createPublicGraphEdge)),
  });
}

function graphNodeAttentionScore(
  node: PublicGraphNodeDto,
  summaryByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
): number {
  if (node.kind === "external_reference") {
    return 0;
  }
  const summary = summaryByNodeId.get(node.nodeId);
  assertNonNullable(summary, `node ${node.nodeId}のsummaryがありません`);
  return summary.attention.score;
}

function graphNodeImpact(
  node: PublicGraphNodeDto,
  impactByNodeId: ReadonlyMap<string, PublicItemSummaryDto["downstreamImpact"]>,
): Readonly<{
  openNodeCount: number;
  repositoryCount: number;
}> {
  const impact = impactByNodeId.get(node.nodeId);
  assertNonNullable(impact, `node ${node.nodeId}のimpactがありません`);
  return impact;
}

function requiredInitialGraphNodes(
  graph: PublicGraph,
  items: readonly PublicItemSummaryDto[],
): readonly PublicGraphNodeDto[] {
  const summaryItemNodeIds = new Set(items.map((item) => item.nodeId));
  const graphNodesByNodeId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const waitingOnItemCandidateIds = new Set<string>();
  for (const item of items) {
    const waitingOnValues = [
      ...item.waitingOn,
      ...item.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (waitingOn.kind === "item") {
        waitingOnItemCandidateIds.add(waitingOn.candidateId);
      }
    }
    for (const response of item.currentResponses) {
      if (response.status === "waiting") {
        waitingOnItemCandidateIds.add(response.waitingFor.itemNodeId);
      }
    }
  }
  const requiredNodes: PublicGraphNodeDto[] = [];
  for (const candidateId of waitingOnItemCandidateIds) {
    if (summaryItemNodeIds.has(candidateId)) {
      continue;
    }
    const graphNode = graphNodesByNodeId.get(candidateId);
    if (graphNode == null) {
      throw new PublicDtoSemanticError(`waitingOn項目 ${candidateId}の公開graph nodeがありません`);
    }
    if (graphNode.kind !== "external_reference") {
      throw new PublicDtoSemanticError(
        `waitingOn項目 ${candidateId}はexternal_referenceではありません`,
      );
    }
    requiredNodes.push(graphNode);
  }
  return Object.freeze(requiredNodes);
}

/** 初期表示へ含めるgraph nodeを選ぶ。 */
export function createInitialGraph(
  graph: PublicGraph,
  items: readonly PublicItemSummaryDto[],
  projection: FinalGraphProjection,
  maxInitialGraphNodes: number,
): PublicSummaryDto["graph"] {
  const summaryByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const impactByNodeId = new Map<string, PublicItemSummaryDto["downstreamImpact"]>(
    projection.nodes.map((node) => [
      node.nodeId,
      { nodeId: node.nodeId, ...node.downstreamImpact },
    ]),
  );
  const requiredNodes = requiredInitialGraphNodes(graph, items);
  if (requiredNodes.length > maxInitialGraphNodes) {
    throw new PublicDtoSemanticError(
      `waitingOnの必須external_reference node数 ${requiredNodes.length.toString()} がinitial graph上限 ${maxInitialGraphNodes.toString()}を超えています`,
    );
  }
  const rankedNodes = [...graph.nodes].sort((left, right) => {
    const attentionOrder =
      graphNodeAttentionScore(right, summaryByNodeId) -
      graphNodeAttentionScore(left, summaryByNodeId);
    if (attentionOrder !== 0) {
      return attentionOrder;
    }
    const leftImpact = graphNodeImpact(left, impactByNodeId);
    const rightImpact = graphNodeImpact(right, impactByNodeId);
    const impactOrder = rightImpact.openNodeCount - leftImpact.openNodeCount;
    if (impactOrder !== 0) {
      return impactOrder;
    }
    const leftSummary = summaryByNodeId.get(left.nodeId);
    const rightSummary = summaryByNodeId.get(right.nodeId);
    if (left.kind === "external_reference" || right.kind === "external_reference") {
      if (left.kind === right.kind) {
        return compareStrings(left.nodeId, right.nodeId);
      }
      return left.kind === "external_reference" ? 1 : -1;
    }
    assertNonNullable(leftSummary, `node ${left.nodeId}のsummaryがありません`);
    assertNonNullable(rightSummary, `node ${right.nodeId}のsummaryがありません`);
    const stallOrder = compareStrings(leftSummary.stallSince, rightSummary.stallSince);
    if (stallOrder !== 0) {
      return stallOrder;
    }
    return compareStrings(left.nodeId, right.nodeId);
  });
  const requiredNodeIds = new Set(requiredNodes.map((node) => node.nodeId));
  const selectedNodes = [
    ...requiredNodes,
    ...rankedNodes
      .filter((node) => !requiredNodeIds.has(node.nodeId))
      .slice(0, maxInitialGraphNodes - requiredNodes.length),
  ].sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  return {
    nodes: selectedNodes.map((node) =>
      node.kind === "external_reference"
        ? {
            nodeId: node.nodeId,
            kind: node.kind,
            displayReference: node.displayReference,
          }
        : {
            nodeId: node.nodeId,
            kind: node.kind,
          },
    ),
    maxNodes: maxInitialGraphNodes,
  };
}

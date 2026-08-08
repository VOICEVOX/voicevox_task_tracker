import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sampleSummarySource from "../public/data/summary.json";
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphNodeDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { DependencyGraphDiagram } from "./dependency-graph-diagram.js";
import { createItemGraphView } from "./graph-model.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const sampleSummary = createPublicSummaryDto(sampleSummarySource);

let container: HTMLDivElement | undefined;

function currentContainer(): HTMLDivElement {
  assertNonNullable(container, "テスト用の描画先がありません");
  return container;
}

function createItem(
  nodeId: string,
  type: PublicItemSummaryDto["type"],
  number: number,
  stallSince: string,
): PublicItemSummaryDto {
  const source = sampleSummary.items[0];
  assertNonNullable(source, "部分グラフfixtureの基準項目がありません");
  const path = type === "issue" ? "issues" : "pull";
  return {
    ...source,
    nodeId,
    type,
    repositoryId: "sample-repository-editor",
    displayReference: `VOICEVOX/sample-editor#${number.toString()}`,
    number,
    url: `https://github.com/VOICEVOX/sample-editor/${path}/${number.toString()}`,
    title: `部分グラフfixture ${nodeId}`,
    status: "in_progress",
    severity: "watch",
    stallSince,
    blockerNodeIds: [],
    downstreamImpact: {
      nodeId,
      openNodeCount: number % 7,
      repositoryCount: number % 3,
    },
  };
}

function trackedGraphNode(item: PublicItemSummaryDto): PublicGraphNodeDto {
  return {
    nodeId: item.nodeId,
    kind: item.type,
    repositoryId: item.repositoryId,
    state: item.state,
    status: item.status,
    severity: item.severity,
  };
}

function externalGraphNode(nodeId: string): PublicGraphNodeDto {
  return {
    nodeId,
    kind: "external_reference",
    repositoryFullName: "external/example",
    displayReference: "external/example#9",
    url: "https://github.com/external/example/issues/9",
    title: "外部依存fixture",
    state: "open",
  };
}

function initialGraphNode(node: PublicGraphNodeDto): PublicSummaryDto["graph"]["nodes"][number] {
  if (node.kind === "external_reference") {
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      displayReference: node.displayReference,
    };
  }
  return {
    nodeId: node.nodeId,
    kind: node.kind,
  };
}

function createEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  type: PublicGraphEdgeDto["type"],
  provenance: PublicGraphEdgeDto["provenance"],
): Extract<PublicGraphEdgeDto, Readonly<{ active: true }>> {
  return {
    id,
    fromNodeId,
    toNodeId,
    type,
    provenance,
    confidence: provenance === "native" ? 1 : 0.9,
    active: true,
  };
}

type GraphFixtureOptions = Readonly<{
  items: readonly PublicItemSummaryDto[];
  nodes: readonly PublicGraphNodeDto[];
  edges: readonly PublicGraphEdgeDto[];
  frontierNodeIds: readonly string[];
  maxNodes: number;
}>;

function createGraphFixture(options: GraphFixtureOptions): Readonly<{
  summary: PublicSummaryDto;
  details: PublicDetailsDto;
}> {
  const summary = createPublicSummaryDto({
    ...sampleSummary,
    schemaVersion: "5",
    runId: "run-item-graph-fixture",
    generatedAt: "2026-07-31T00:05:00.000Z",
    repositories: sampleSummary.repositories,
    items: options.items,
    graph: {
      nodes: options.nodes.slice(0, options.maxNodes).map(initialGraphNode),
      maxNodes: options.maxNodes,
    },
  });
  const details = createPublicDetailsDto({
    schemaVersion: "5",
    runId: summary.runId,
    generatedAt: summary.generatedAt,
    items: [],
    graph: {
      nodes: options.nodes,
      edges: options.edges,
      frontierNodeIds: options.frontierNodeIds,
    },
  });
  return {
    summary,
    details,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(currentContainer());
});

afterEach(() => {
  render(null, currentContainer());
  document.body.replaceChildren();
  container = undefined;
});

describe("項目詳細の依存グラフ", () => {
  it("停滞日数、影響範囲、種別によらず240×112で表示する", () => {
    const center = createItem("node:fixed-center", "issue", 31, "2026-08-01T00:00:00.000Z");
    const highImpact = {
      ...createItem("node:fixed-high-impact", "pull_request", 32, "2020-01-01T00:00:00.000Z"),
      downstreamImpact: {
        nodeId: "node:fixed-high-impact",
        openNodeCount: 1_000,
        repositoryCount: 100,
      },
    } satisfies PublicItemSummaryDto;
    const external = externalGraphNode("node:fixed-external");
    const fixture = createGraphFixture({
      items: [center, highImpact],
      nodes: [trackedGraphNode(center), trackedGraphNode(highImpact), external],
      edges: [
        createEdge("edge:fixed-high-impact", highImpact.nodeId, center.nodeId, "blocks", "native"),
        createEdge(
          "edge:fixed-external",
          external.nodeId,
          center.nodeId,
          "related_to",
          "explicit_text",
        ),
      ],
      frontierNodeIds: [],
      maxNodes: 10,
    });

    const view = createItemGraphView(fixture.summary, fixture.details, center.nodeId, NOW);

    expect(view.displayNodes).toHaveLength(3);
    expect(view.displayNodes.every((node) => node.width === 240 && node.height === 112)).toBe(true);
  });

  it("中心項目を識別して1 hop表示へ必ず含める", () => {
    const center = createItem("node:center", "issue", 41, "2026-07-31T00:00:00.000Z");
    const neighbor = createItem("node:neighbor", "pull_request", 42, "2026-07-01T00:00:00.000Z");
    const fixture = createGraphFixture({
      items: [center, neighbor],
      nodes: [trackedGraphNode(center), trackedGraphNode(neighbor)],
      edges: [createEdge("edge:center", neighbor.nodeId, center.nodeId, "blocks", "native")],
      frontierNodeIds: [neighbor.nodeId],
      maxNodes: 10,
    });

    const view = createItemGraphView(fixture.summary, fixture.details, center.nodeId, NOW);

    expect(view.displayNodes.map((node) => node.id)).toContain(center.nodeId);
    expect(view.displayNodes.filter((node) => node.central).map((node) => node.id)).toEqual([
      center.nodeId,
    ]);
  });

  it("中心項目への入力edgeと中心項目からの出力edgeを全種別から表示する", () => {
    const center = createItem("node:center", "issue", 51, "2026-07-31T00:00:00.000Z");
    const neighbors = Array.from({ length: 4 }, (_, index) =>
      createItem(
        `node:neighbor:${index.toString()}`,
        index % 2 === 0 ? "issue" : "pull_request",
        52 + index,
        "2026-07-20T00:00:00.000Z",
      ),
    );
    const external = externalGraphNode("node:external-neighbor");
    const blocksNeighbor = neighbors[0];
    const parentNeighbor = neighbors[1];
    const relatedNeighbor = neighbors[2];
    const duplicateNeighbor = neighbors[3];
    assertNonNullable(blocksNeighbor, "blocks fixtureの隣接項目がありません");
    assertNonNullable(parentNeighbor, "parent_of fixtureの隣接項目がありません");
    assertNonNullable(relatedNeighbor, "related_to fixtureの隣接項目がありません");
    assertNonNullable(duplicateNeighbor, "duplicates fixtureの隣接項目がありません");
    const edges = [
      createEdge("edge:1-blocks", blocksNeighbor.nodeId, center.nodeId, "blocks", "native"),
      createEdge(
        "edge:2-parent",
        center.nodeId,
        parentNeighbor.nodeId,
        "parent_of",
        "explicit_text",
      ),
      createEdge(
        "edge:3-implements",
        external.nodeId,
        center.nodeId,
        "implements",
        "closing_keyword",
      ),
      createEdge(
        "edge:4-related",
        center.nodeId,
        relatedNeighbor.nodeId,
        "related_to",
        "cross_reference",
      ),
      createEdge(
        "edge:5-duplicates",
        duplicateNeighbor.nodeId,
        center.nodeId,
        "duplicates",
        "ai_inference",
      ),
    ] satisfies readonly PublicGraphEdgeDto[];
    const fixture = createGraphFixture({
      items: [center, ...neighbors],
      nodes: [trackedGraphNode(center), ...neighbors.map(trackedGraphNode), external],
      edges,
      frontierNodeIds: [],
      maxNodes: 10,
    });

    const view = createItemGraphView(fixture.summary, fixture.details, center.nodeId, NOW);

    expect(
      view.sourceEdges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        type: edge.type,
      })),
    ).toEqual(edges.map(({ fromNodeId, toNodeId, type }) => ({ fromNodeId, toNodeId, type })));
    expect(view.sourceEdges[0]?.authorityLabel).toBe("確定関係");
    expect(view.sourceEdges.slice(1).every((edge) => edge.authorityLabel === "推定関係")).toBe(
      true,
    );
  });

  it("表示上限を超えても中心項目を残してseverityが高い隣接項目を選ぶ", () => {
    const center = {
      ...createItem("node:z-center", "issue", 61, "2026-08-01T00:00:00.000Z"),
      severity: "none",
      downstreamImpact: {
        nodeId: "node:z-center",
        openNodeCount: 0,
        repositoryCount: 0,
      },
    } satisfies PublicItemSummaryDto;
    const highestPriorityNeighbor = {
      ...createItem("node:high", "issue", 62, "2026-07-31T00:00:00.000Z"),
      severity: "critical",
    } satisfies PublicItemSummaryDto;
    const lowerPriorityNeighbors = [
      createItem("node:low-a", "issue", 63, "2026-07-01T00:00:00.000Z"),
      createItem("node:low-b", "pull_request", 64, "2026-07-01T00:00:00.000Z"),
    ];
    const neighbors = [highestPriorityNeighbor, ...lowerPriorityNeighbors];
    const fixture = createGraphFixture({
      items: [center, ...neighbors],
      nodes: [...neighbors.map(trackedGraphNode), trackedGraphNode(center)],
      edges: neighbors.map((neighbor, index) =>
        createEdge(
          `edge:limit:${index.toString()}`,
          neighbor.nodeId,
          center.nodeId,
          "blocks",
          "native",
        ),
      ),
      frontierNodeIds: [],
      maxNodes: 2,
    });

    const view = createItemGraphView(fixture.summary, fixture.details, center.nodeId, NOW);

    expect(view.displayNodes.map((node) => node.id)).toEqual([
      highestPriorityNeighbor.nodeId,
      center.nodeId,
    ]);
    expect(view.displayNodes.find((node) => node.central)?.id).toBe(center.nodeId);
    expect(view.omittedSourceNodeCount).toBe(2);
  });

  it("Issue、Pull Request、外部参照を形とテキストで区別し着手可能を表示する", async () => {
    const center = createItem("node:center-ui", "issue", 71, "2026-07-31T00:00:00.000Z");
    const pullRequest = createItem(
      "node:pull-request-ui",
      "pull_request",
      72,
      "2026-07-20T00:00:00.000Z",
    );
    const external = externalGraphNode("node:external-ui");
    const fixture = createGraphFixture({
      items: [center, pullRequest],
      nodes: [trackedGraphNode(center), trackedGraphNode(pullRequest), external],
      edges: [
        createEdge("edge:ui-pr", pullRequest.nodeId, center.nodeId, "blocks", "native"),
        createEdge(
          "edge:ui-external",
          external.nodeId,
          center.nodeId,
          "related_to",
          "explicit_text",
        ),
        createEdge(
          "edge:ui-external-implements",
          external.nodeId,
          center.nodeId,
          "implements",
          "closing_keyword",
        ),
      ],
      frontierNodeIds: [pullRequest.nodeId],
      maxNodes: 10,
    });
    const view = createItemGraphView(fixture.summary, fixture.details, center.nodeId, NOW);

    render(
      <DependencyGraphDiagram
        description="部分グラフfixture"
        idPrefix="item-graph-fixture"
        navigation={{
          status: "item_details",
          createItemHref: (nodeId) => `/items/${encodeURIComponent(nodeId)}`,
          onSelectItem: () => undefined,
        }}
        title="項目の部分グラフ"
        view={view}
      />,
      currentContainer(),
    );
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    const issue = currentContainer().querySelector('[data-node-kind="issue"]');
    const pr = currentContainer().querySelector('[data-node-kind="pull_request"]');
    const externalNode = currentContainer().querySelector('[data-node-kind="external_reference"]');
    expect(issue?.querySelector("rect")).not.toBeNull();
    expect(pr?.querySelector("polygon")).not.toBeNull();
    expect(externalNode?.querySelector("polygon")).not.toBeNull();
    expect(currentContainer().querySelector('[class*="graph-severity-"]')).toBeNull();
    expect(pr?.textContent).toContain("PR");
    expect(pr?.textContent).toContain("着手可能");
    expect(externalNode?.textContent).toContain("外部");
    expect(currentContainer().querySelector(".graph-node-size-description")?.textContent).toBe(
      "ノードはすべて同じ大きさで表示します。",
    );
    expect(currentContainer().querySelector(".graph-edge-authoritative")?.textContent).toContain(
      "ブロック確定関係",
    );
    expect(currentContainer().querySelector(".graph-edge-inferred")?.textContent).toContain(
      "関連推定関係",
    );
    const authoritativePath = currentContainer().querySelector(
      ".graph-edge-authoritative path[marker-end]",
    );
    const inferredPaths = [
      ...currentContainer().querySelectorAll(".graph-edge-inferred path[marker-end]"),
    ];
    expect(authoritativePath?.getAttribute("class")).not.toContain("stroke-dasharray");
    expect(authoritativePath?.getAttribute("marker-end")).toBe(
      "url(#item-graph-fixture-arrow-authoritative)",
    );
    expect(inferredPaths).toHaveLength(2);
    expect(
      inferredPaths.every((path) => path.getAttribute("class")?.includes("stroke-dasharray:8_6")),
    ).toBe(true);
    expect(
      inferredPaths.every(
        (path) => path.getAttribute("marker-end") === "url(#item-graph-fixture-arrow-inferred)",
      ),
    ).toBe(true);
    expect(
      currentContainer().querySelector("#item-graph-fixture-arrow-authoritative path")?.classList,
    ).toContain("fill-graph-edge-authoritative");
    expect(
      currentContainer().querySelector("#item-graph-fixture-arrow-inferred path")?.classList,
    ).toContain("fill-graph-edge-inferred");
    expect(issue?.querySelector(".graph-node-reference")?.classList).toContain("text-ellipsis");
    expect(issue?.querySelector(".graph-node-title")?.classList).toContain("text-ellipsis");
  });
});

import { render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import sampleSummarySource from "../public/data/summary.json";
import sampleDetailsSource from "../public/data/details.json";
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphHistoryEventDto,
  type PublicGraphNodeDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable } from "../../src/util/index.js";
import { App } from "./app.js";
import { DependencyGraph } from "./dependency-graph.js";
import {
  calculateGraphNodeSize,
  createComponentGraphView,
  createRepositoryGraphView,
  graphNodeKindLabel,
  MAX_GRAPH_NODE_SIZE,
} from "./graph-model.js";
import type { GraphSelection } from "./url-state.js";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const LOCALE = "ja-JP";
const COMPONENT_ID = "component:test";
const sampleSummary = createPublicSummaryDto(sampleSummarySource);
const sampleDetails = createPublicDetailsDto(sampleDetailsSource);

let container: HTMLDivElement | undefined;

function currentContainer(): HTMLDivElement {
  assertNonNullable(container, "テスト用の描画先がありません");
  return container;
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = currentContainer().querySelector<ElementType>(selector);
  assertNonNullable(element, `要素がありません: ${selector}`);
  return element;
}

function createItem(
  nodeId: string,
  type: PublicItemSummaryDto["type"],
  number: number,
  stallSince: string,
): PublicItemSummaryDto {
  const source = sampleSummary.items[0];
  assertNonNullable(source, "graph fixtureの基準項目がありません");
  const path = type === "issue" ? "issues" : "pull";
  return {
    ...source,
    nodeId,
    type,
    repositoryId: "sample-repository-editor",
    displayReference: `VOICEVOX/sample-editor#${number.toString()}`,
    number,
    url: `https://github.com/VOICEVOX/sample-editor/${path}/${number.toString()}`,
    title: `graph fixture ${nodeId}`,
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
    evidence: [
      {
        sourceId: `source:${id}`,
        supports: "relation",
        summary: `${type}の根拠`,
        sourceUrl: "https://github.com/VOICEVOX/sample-editor/issues/1",
      },
    ],
    contradictions: [],
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastConfirmedAt: "2026-07-31T00:00:00.000Z",
    active: true,
  };
}

type EdgeHistoryValue = Extract<
  PublicGraphHistoryEventDto["after"],
  Readonly<{ state: "present" }>
>["value"];

function edgeHistoryValue(edge: PublicGraphEdgeDto): EdgeHistoryValue {
  const fields = {
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence.map((entry) => ({
      sourceId: entry.sourceId,
      supports: entry.supports,
      summary: entry.summary,
    })),
    contradictions: edge.contradictions,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
  };
  if (edge.active) {
    return {
      ...fields,
      active: true,
    };
  }
  return {
    ...fields,
    active: false,
    removedAt: edge.removedAt,
  };
}

type GraphFixtureOptions = Readonly<{
  items: readonly PublicItemSummaryDto[];
  nodes: readonly PublicGraphNodeDto[];
  edges: readonly PublicGraphEdgeDto[];
  frontierNodeIds: readonly string[];
  cycles: PublicDetailsDto["graph"]["cycles"];
  history: readonly PublicGraphHistoryEventDto[];
  maxNodes: number;
}>;

function createGraphFixture(options: GraphFixtureOptions): Readonly<{
  summary: PublicSummaryDto;
  details: PublicDetailsDto;
}> {
  const edgeIds = options.edges.filter((edge) => edge.active).map((edge) => edge.id);
  const repositoryIds = [
    ...new Set(
      options.nodes.flatMap((node) =>
        node.kind === "external_reference" ? [] : [node.repositoryId],
      ),
    ),
  ];
  const repositoryClusters = repositoryIds.map((repositoryId) => {
    const nodeIds = options.nodes.flatMap((node) =>
      node.kind !== "external_reference" && node.repositoryId === repositoryId ? [node.nodeId] : [],
    );
    const nodeIdSet = new Set(nodeIds);
    const edgeIds = options.edges
      .filter(
        (edge) => nodeIdSet.has(edge.fromNodeId) && nodeIdSet.has(edge.toNodeId) && edge.active,
      )
      .map((edge) => edge.id);
    return {
      repositoryId,
      nodeIds,
      edgeIds,
    };
  });
  const component = {
    id: COMPONENT_ID,
    nodeIds: options.nodes.map((node) => node.nodeId),
    repositoryIds,
    edgeIds,
  };
  const summary = createPublicSummaryDto({
    ...sampleSummary,
    runId: "run-graph-fixture",
    generatedAt: "2026-07-31T00:05:00.000Z",
    repositories: sampleSummary.repositories.map((repository) => ({
      ...repository,
      itemCount: options.items.filter((item) => item.repositoryId === repository.id).length,
    })),
    items: options.items,
    graph: {
      nodes: options.nodes.slice(0, options.maxNodes),
      edges: options.edges
        .filter((edge) => edge.active)
        .slice(0, options.maxNodes)
        .map((edge) => ({
          id: edge.id,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          type: edge.type,
        })),
      components: [
        {
          id: COMPONENT_ID,
          nodeCount: options.nodes.length,
          repositoryIds,
          edgeCount: edgeIds.length,
          frontierCount: options.frontierNodeIds.length,
          cycleCount: options.cycles.length,
        },
      ],
      clusterByRepository: true,
      repositoryClusters: repositoryClusters.map((cluster) => {
        const nodeIdSet = new Set(cluster.nodeIds);
        return {
          repositoryId: cluster.repositoryId,
          nodeCount: cluster.nodeIds.length,
          edgeCount: cluster.edgeIds.length,
          frontierCount: options.frontierNodeIds.filter((nodeId) => nodeIdSet.has(nodeId)).length,
          cycleCount: options.cycles.filter((cycle) =>
            cycle.nodeIds.every((nodeId) => nodeIdSet.has(nodeId)),
          ).length,
        };
      }),
      frontierNodeIds: options.frontierNodeIds,
      cycles: options.cycles,
      maxNodes: options.maxNodes,
      omittedNodeCount: Math.max(0, options.nodes.length - options.maxNodes),
    },
  });
  const details = createPublicDetailsDto({
    schemaVersion: "2",
    runId: summary.runId,
    generatedAt: summary.generatedAt,
    items: [],
    graph: {
      nodes: options.nodes,
      edges: options.edges,
      components: [component],
      repositoryClusters,
      frontierNodeIds: options.frontierNodeIds,
      cycles: options.cycles,
      downstreamImpacts: options.items.map((item) => ({
        ...item.downstreamImpact,
      })),
      history: options.history,
    },
  });
  return {
    summary,
    details,
  };
}

function DependencyGraphHarness({
  loadDetails,
  summary,
}: Readonly<{
  loadDetails: () => Promise<PublicDetailsDto>;
  summary: PublicSummaryDto;
}>) {
  const [selection, setSelection] = useState<GraphSelection>({
    status: "none",
  });
  return (
    <DependencyGraph
      summary={summary}
      loadDetails={loadDetails}
      locale={LOCALE}
      now={NOW}
      selection={selection}
      onSelectionChange={setSelection}
    />
  );
}

function renderDependencyGraph(
  summary: PublicSummaryDto,
  loadDetails: () => Promise<PublicDetailsDto>,
): void {
  render(
    <DependencyGraphHarness summary={summary} loadDetails={loadDetails} />,
    currentContainer(),
  );
}

async function selectFirstComponent(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("[data-component-id]");
  act(() => {
    button.click();
  });
  await vi.waitFor(() => {
    expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/voicevox_task_tracker/");
  container = document.createElement("div");
  document.body.replaceChildren(currentContainer());
});

afterEach(() => {
  render(null, currentContainer());
  document.body.replaceChildren();
  container = undefined;
});

describe("依存グラフの表示モデル", () => {
  it("停滞1日、10日、30日の順で大きくし上限を超えない", () => {
    const oneDay = calculateGraphNodeSize(1, 0, 0);
    const tenDays = calculateGraphNodeSize(10, 0, 0);
    const thirtyDays = calculateGraphNodeSize(30, 0, 0);
    const oneImpactedItem = calculateGraphNodeSize(1, 1, 0);
    const oneImpactedRepository = calculateGraphNodeSize(1, 0, 1);
    const extreme = calculateGraphNodeSize(1_000_000, 1_000_000, 1_000_000);

    expect(oneDay).toBeLessThan(tenDays);
    expect(tenDays).toBeLessThan(thirtyDays);
    expect(oneDay).toBeLessThan(oneImpactedItem);
    expect(oneDay).toBeLessThan(oneImpactedRepository);
    expect(thirtyDays).toBeLessThanOrEqual(MAX_GRAPH_NODE_SIZE);
    expect(extreme).toBe(MAX_GRAPH_NODE_SIZE);
  });

  it("全edge型の向きとauthoritative、推定関係を保持する", () => {
    const issue = createItem("node:issue", "issue", 1, "2026-07-30T00:00:00.000Z");
    const pullRequest = createItem(
      "node:pull-request",
      "pull_request",
      2,
      "2026-07-20T00:00:00.000Z",
    );
    const external = externalGraphNode("node:external");
    const edges = [
      createEdge("edge:blocks", issue.nodeId, pullRequest.nodeId, "blocks", "native"),
      createEdge("edge:parent", issue.nodeId, pullRequest.nodeId, "parent_of", "explicit_text"),
      createEdge(
        "edge:implements",
        pullRequest.nodeId,
        external.nodeId,
        "implements",
        "closing_keyword",
      ),
      createEdge("edge:related", external.nodeId, issue.nodeId, "related_to", "cross_reference"),
      createEdge("edge:duplicates", pullRequest.nodeId, issue.nodeId, "duplicates", "ai_inference"),
    ] satisfies readonly PublicGraphEdgeDto[];
    const fixture = createGraphFixture({
      items: [issue, pullRequest],
      nodes: [trackedGraphNode(issue), trackedGraphNode(pullRequest), external],
      edges,
      frontierNodeIds: [issue.nodeId],
      cycles: [],
      history: [],
      maxNodes: 10,
    });

    const view = createComponentGraphView(
      fixture.summary,
      fixture.details,
      COMPONENT_ID,
      new Set(),
      NOW,
    );

    expect(view.displayEdges.map((edge) => edge.type)).toEqual([
      "blocks",
      "parent_of",
      "implements",
      "related_to",
      "duplicates",
    ]);
    expect(view.displayEdges[0]).toMatchObject({
      fromNodeId: issue.nodeId,
      toNodeId: pullRequest.nodeId,
      authorityLabel: "確定関係",
    });
    expect(view.displayEdges.slice(1).every((edge) => edge.authorityLabel === "推定関係")).toBe(
      true,
    );
  });
});

describe("依存グラフUI", () => {
  it("Issue、Pull Request、外部参照を形とテキストで区別しfrontierを一覧にも表示する", async () => {
    const issue = createItem("node:issue", "issue", 1, "2026-07-30T00:00:00.000Z");
    const pullRequest = createItem(
      "node:pull-request",
      "pull_request",
      2,
      "2026-07-20T00:00:00.000Z",
    );
    const external = externalGraphNode("node:external");
    const fixture = createGraphFixture({
      items: [issue, pullRequest],
      nodes: [trackedGraphNode(issue), trackedGraphNode(pullRequest), external],
      edges: [
        createEdge("edge:issue-pr", issue.nodeId, pullRequest.nodeId, "blocks", "native"),
        createEdge(
          "edge:pr-external",
          pullRequest.nodeId,
          external.nodeId,
          "implements",
          "closing_keyword",
        ),
      ],
      frontierNodeIds: [issue.nodeId],
      cycles: [],
      history: [],
      maxNodes: 10,
    });
    const loadDetails = vi.fn(() => Promise.resolve(fixture.details));
    renderDependencyGraph(fixture.summary, loadDetails);

    expect(loadDetails).not.toHaveBeenCalled();
    expect(currentContainer().querySelector(".dependency-graph-svg")).toBeNull();
    expect(currentContainer().textContent).toContain("確認したいまとまりを選びます");
    const componentButton = requiredElement<HTMLButtonElement>("[data-component-id]");
    expect(componentButton.textContent).toContain("着手可能 1件");
    expect(componentButton.textContent).toContain("全3項目・依存関係2件");
    await selectFirstComponent();

    expect(loadDetails).toHaveBeenCalledTimes(1);
    const legend = requiredElement<HTMLDetailsElement>(".graph-legend details");
    const alternative = requiredElement<HTMLDetailsElement>(".graph-alternative");
    const edgeHistory = requiredElement<HTMLDetailsElement>(".edge-history");
    expect(legend.open).toBe(false);
    expect(alternative.open).toBe(false);
    expect(edgeHistory.open).toBe(false);
    act(() => {
      requiredElement<HTMLElement>(".graph-legend summary").click();
      requiredElement<HTMLElement>(".graph-alternative > summary").click();
    });
    expect(legend.open).toBe(true);
    expect(alternative.open).toBe(true);
    expect(currentContainer().querySelectorAll("[data-legend-edge-type]")).toHaveLength(5);
    const issueNode = requiredElement<SVGGElement>('[data-node-kind="issue"]');
    const pullRequestNode = requiredElement<SVGGElement>('[data-node-kind="pull_request"]');
    const externalNode = requiredElement<SVGGElement>('[data-node-kind="external_reference"]');
    expect(issueNode.querySelector(":scope > rect")).not.toBeNull();
    expect(issueNode.textContent).toContain("ISSUE");
    expect(pullRequestNode.querySelector(":scope > polygon")).not.toBeNull();
    expect(pullRequestNode.textContent).toContain("PR");
    expect(externalNode.querySelector(":scope > polygon")).not.toBeNull();
    expect(externalNode.textContent).toContain("外部");
    expect(graphNodeKindLabel("issue")).not.toBe(graphNodeKindLabel("pull_request"));
    expect(issueNode.textContent).toContain("▶ 着手可能");
    const frontierRow = requiredElement<HTMLTableRowElement>(
      '.graph-node-table tr[data-node-id="node:issue"]',
    );
    expect(frontierRow.dataset["frontier"]).toBe("true");
    expect(frontierRow.textContent).toContain("▶ 着手可能");
  });

  it("削除済みedgeを選び追加、型とconfidenceの変更、削除を古い順に表示する", async () => {
    const issue = createItem("node:history:issue", "issue", 31, "2026-07-20T00:00:00.000Z");
    const pullRequest = createItem(
      "node:history:pull-request",
      "pull_request",
      32,
      "2026-07-21T00:00:00.000Z",
    );
    const relationId = "edge:history:removed";
    const addedEdge = {
      ...createEdge(relationId, issue.nodeId, pullRequest.nodeId, "related_to", "ai_inference"),
      confidence: 0.8,
      lastConfirmedAt: "2026-07-29T00:00:00.000Z",
    } satisfies PublicGraphEdgeDto;
    const changedEdge = {
      ...addedEdge,
      type: "implements",
      confidence: 0.9,
      lastConfirmedAt: "2026-07-30T00:00:00.000Z",
    } satisfies PublicGraphEdgeDto;
    const removedEdge = {
      ...changedEdge,
      active: false,
      removedAt: "2026-07-31T00:00:00.000Z",
    } satisfies PublicGraphEdgeDto;
    const history = [
      {
        kind: "edge_changed",
        runId: "run-edge-added",
        recordedAt: "2026-07-29T00:00:00.000Z",
        relationId,
        before: {
          state: "absent",
        },
        after: {
          state: "present",
          value: edgeHistoryValue(addedEdge),
        },
      },
      {
        kind: "edge_changed",
        runId: "run-edge-changed",
        recordedAt: "2026-07-30T00:00:00.000Z",
        relationId,
        before: {
          state: "present",
          value: edgeHistoryValue(addedEdge),
        },
        after: {
          state: "present",
          value: edgeHistoryValue(changedEdge),
        },
      },
      {
        kind: "edge_changed",
        runId: "run-edge-removed",
        recordedAt: "2026-07-31T00:00:00.000Z",
        relationId,
        before: {
          state: "present",
          value: edgeHistoryValue(changedEdge),
        },
        after: {
          state: "present",
          value: edgeHistoryValue(removedEdge),
        },
      },
    ] satisfies readonly PublicGraphHistoryEventDto[];
    const fixture = createGraphFixture({
      items: [issue, pullRequest],
      nodes: [trackedGraphNode(issue), trackedGraphNode(pullRequest)],
      edges: [removedEdge],
      frontierNodeIds: [issue.nodeId, pullRequest.nodeId],
      cycles: [],
      history,
      maxNodes: 10,
    });
    renderDependencyGraph(fixture.summary, () => Promise.resolve(fixture.details));
    await selectFirstComponent();

    expect(currentContainer().querySelectorAll(".graph-edge")).toHaveLength(0);
    expect(currentContainer().querySelectorAll("[data-edge-event-kind]")).toHaveLength(0);
    const edgeHistory = requiredElement<HTMLDetailsElement>(".edge-history");
    expect(edgeHistory.open).toBe(false);
    act(() => {
      requiredElement<HTMLElement>(".edge-history > summary").click();
    });
    expect(edgeHistory.open).toBe(true);
    const historyButton = requiredElement<HTMLButtonElement>(
      `[data-history-relation-id="${relationId}"]`,
    );
    expect(historyButton.textContent).toContain("削除済み");

    act(() => {
      historyButton.click();
    });

    const historyEvents = [
      ...currentContainer().querySelectorAll<HTMLElement>("[data-edge-event-kind]"),
    ];
    expect(historyEvents.map((event) => event.dataset["edgeEventKind"])).toEqual([
      "added",
      "changed",
      "removed",
    ]);
    expect(currentContainer().textContent).toContain("3件の変更を古い順に表示");
    expect(historyEvents.map((event) => event.textContent)).toEqual([
      expect.stringContaining("関連"),
      expect.stringMatching(/関連.*実装.*80%.*90%/su),
      expect.stringContaining("実装"),
    ]);
  });

  it("1000 node componentを選択し設定上限だけ自動配置する", async () => {
    const nodeCount = 1000;
    const maxNodes = 40;
    const items = Array.from({ length: nodeCount }, (_, index) =>
      createItem(
        `node:large:${index.toString().padStart(4, "0")}`,
        index % 2 === 0 ? "issue" : "pull_request",
        index + 1,
        "2026-07-01T00:00:00.000Z",
      ),
    );
    const nodes = items.map(trackedGraphNode);
    const edges = items.slice(0, -1).map((item, index) => {
      const target = items[index + 1];
      assertNonNullable(target, `大規模fixtureの${index.toString()}番目の接続先がありません`);
      return createEdge(
        `edge:large:${index.toString().padStart(4, "0")}`,
        item.nodeId,
        target.nodeId,
        "blocks",
        "native",
      );
    });
    const firstItem = items[0];
    assertNonNullable(firstItem, "大規模fixtureの先頭nodeがありません");
    const fixture = createGraphFixture({
      items,
      nodes,
      edges,
      frontierNodeIds: [firstItem.nodeId],
      cycles: [],
      history: [],
      maxNodes,
    });
    const loadDetails = vi.fn(() => Promise.resolve(fixture.details));
    renderDependencyGraph(fixture.summary, loadDetails);

    expect(currentContainer().textContent).toContain("全1,000項目");
    await selectFirstComponent();

    const svg = requiredElement<SVGSVGElement>(".dependency-graph-svg");
    expect(loadDetails).toHaveBeenCalledTimes(1);
    expect(svg.dataset["renderedNodeCount"]).toBe(maxNodes.toString());
    expect(currentContainer().textContent).toContain("上限外の960件");
  }, 10_000);

  it("repository clusterへ切り替えてrepository内のnodeとedgeだけを表示する", async () => {
    const editorIssue = createItem("node:editor:issue", "issue", 21, "2026-07-10T00:00:00.000Z");
    const editorPullRequest = createItem(
      "node:editor:pull-request",
      "pull_request",
      22,
      "2026-07-11T00:00:00.000Z",
    );
    const engineIssue: PublicItemSummaryDto = {
      ...createItem("node:engine:issue", "issue", 23, "2026-07-12T00:00:00.000Z"),
      repositoryId: "sample-repository-engine",
      displayReference: "VOICEVOX/sample-engine#23",
      url: "https://github.com/VOICEVOX/sample-engine/issues/23",
    };
    const internalEdge = createEdge(
      "edge:editor:internal",
      editorIssue.nodeId,
      editorPullRequest.nodeId,
      "blocks",
      "native",
    );
    const crossRepositoryEdge = createEdge(
      "edge:editor:engine",
      editorPullRequest.nodeId,
      engineIssue.nodeId,
      "blocks",
      "native",
    );
    const fixture = createGraphFixture({
      items: [editorIssue, editorPullRequest, engineIssue],
      nodes: [editorIssue, editorPullRequest, engineIssue].map(trackedGraphNode),
      edges: [internalEdge, crossRepositoryEdge],
      frontierNodeIds: [editorIssue.nodeId, engineIssue.nodeId],
      cycles: [],
      history: [],
      maxNodes: 10,
    });
    const repositoryView = createRepositoryGraphView(
      fixture.summary,
      fixture.details,
      "sample-repository-editor",
      new Set(),
      NOW,
    );
    expect(repositoryView.sourceNodes.map((node) => node.id)).toEqual([
      editorIssue.nodeId,
      editorPullRequest.nodeId,
    ]);
    expect(repositoryView.sourceEdges.map((edge) => edge.id)).toEqual([internalEdge.id]);

    const loadDetails = vi.fn(() => Promise.resolve(fixture.details));
    renderDependencyGraph(fixture.summary, loadDetails);
    const repositoryMode = requiredElement<HTMLInputElement>(
      'input[name="graph-cluster-kind"][value="repository"]',
    );
    act(() => {
      repositoryMode.click();
    });
    const repositoryButton = requiredElement<HTMLButtonElement>(
      '.component-browser [data-repository-id="sample-repository-editor"]',
    );
    act(() => {
      repositoryButton.click();
    });
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    expect(repositoryMode.checked).toBe(true);
    expect(repositoryButton.getAttribute("aria-pressed")).toBe("true");
    expect(loadDetails).toHaveBeenCalledTimes(1);
    expect(
      [...currentContainer().querySelectorAll<SVGGElement>(".graph-node")].map(
        (node) => node.dataset["nodeId"],
      ),
    ).toEqual([editorIssue.nodeId, editorPullRequest.nodeId]);
    expect(
      [...currentContainer().querySelectorAll<SVGGElement>(".graph-edge")].map(
        (edge) => edge.dataset["edgeId"],
      ),
    ).toEqual([internalEdge.id]);
    expect(currentContainer().textContent).not.toContain(engineIssue.displayReference);
    expect(currentContainer().textContent).not.toContain(crossRepositoryEdge.id);
  });

  it("repository clusterのdeep linkから選択と表示を復元する", async () => {
    window.history.replaceState(
      {},
      "",
      "/voicevox_task_tracker/graph/repository/sample-repository-editor",
    );
    const loadDetails = vi.fn(() => Promise.resolve(sampleDetails));
    render(
      <App
        basePath="/voicevox_task_tracker/"
        loadDetails={loadDetails}
        locale={LOCALE}
        now={NOW}
        summary={sampleSummary}
        title="VOICEVOX Task Tracker"
      />,
      currentContainer(),
    );
    await vi.waitFor(() => {
      expect(currentContainer().querySelector('[data-layout-status="ready"]')).not.toBeNull();
    });

    const repositoryMode = requiredElement<HTMLInputElement>(
      'input[name="graph-cluster-kind"][value="repository"]',
    );
    const repositoryButton = requiredElement<HTMLButtonElement>(
      '.component-browser [data-repository-id="sample-repository-editor"]',
    );
    expect(repositoryMode.checked).toBe(true);
    expect(repositoryButton.getAttribute("aria-pressed")).toBe("true");
    expect(loadDetails).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(
      "/voicevox_task_tracker/graph/repository/sample-repository-editor",
    );
    expect(window.location.search).toBe("");
    expect(
      [...currentContainer().querySelectorAll<SVGGElement>(".graph-node")].map(
        (node) => node.dataset["nodeId"],
      ),
    ).toEqual(["sample-item-editor-101", "sample-item-editor-103"]);
  });

  it("3 node cycleを折り畳んで表示し構成nodeへ展開する", async () => {
    const items = [
      createItem("node:cycle:a", "issue", 11, "2026-07-01T00:00:00.000Z"),
      createItem("node:cycle:b", "issue", 12, "2026-07-02T00:00:00.000Z"),
      createItem("node:cycle:c", "issue", 13, "2026-07-03T00:00:00.000Z"),
    ];
    const first = items[0];
    const second = items[1];
    const third = items[2];
    assertNonNullable(first, "cycle fixtureの先頭nodeがありません");
    assertNonNullable(second, "cycle fixtureの2番目のnodeがありません");
    assertNonNullable(third, "cycle fixtureの3番目のnodeがありません");
    const edges = [
      createEdge("edge:cycle:a-b", first.nodeId, second.nodeId, "blocks", "native"),
      createEdge("edge:cycle:b-c", second.nodeId, third.nodeId, "blocks", "native"),
      createEdge("edge:cycle:c-a", third.nodeId, first.nodeId, "blocks", "native"),
    ] satisfies readonly PublicGraphEdgeDto[];
    const fixture = createGraphFixture({
      items,
      nodes: items.map(trackedGraphNode),
      edges,
      frontierNodeIds: [],
      cycles: [
        {
          id: "cycle:three",
          nodeIds: items.map((item) => item.nodeId),
          edgeIds: edges.map((edge) => edge.id),
        },
      ],
      history: [],
      maxNodes: 10,
    });
    renderDependencyGraph(fixture.summary, () => Promise.resolve(fixture.details));
    await selectFirstComponent();

    expect(currentContainer().querySelectorAll(".graph-node")).toHaveLength(1);
    expect(requiredElement('[data-node-kind="dependency_cycle"]').textContent).toContain("循環");
    const expandButton = requiredElement<HTMLButtonElement>('[data-cycle-id="cycle:three"] button');
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      expandButton.click();
    });
    await vi.waitFor(() => {
      expect(currentContainer().querySelectorAll(".graph-node")).toHaveLength(3);
    });

    expect(currentContainer().querySelectorAll(".graph-node-cycle-member")).toHaveLength(3);
    expect(expandButton.getAttribute("aria-expanded")).toBe("true");
  });
});

import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createExternalReferenceNodeId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GraphNodeId,
  type RelationType,
  type TrackedItemState,
} from "../src/domain/index.js";
import {
  analyzeGraph,
  type AnalyzeGraphInput,
  type AnalyzeGraphResult,
  type ExternalGraphAnalysisNode,
  type GraphAnalysisNode,
  type GraphAnalysisSnapshot,
  type ReconciledGraphEdge,
  type TrackedGraphAnalysisNode,
} from "../src/graph/index.js";

const OBSERVED_AT = createUtcIsoDateTime("2026-07-31T00:00:00Z");

type CreateTrackedNodeOptions = Readonly<{
  nodeId: string;
  repositoryId: string;
  kind: "issue" | "pull_request";
  state: TrackedItemState;
}>;

function createTrackedNode(options: CreateTrackedNodeOptions): TrackedGraphAnalysisNode {
  return {
    kind: options.kind,
    nodeId: createGitHubNodeId(options.nodeId),
    repositoryId: createGitHubRepositoryId(options.repositoryId),
    state: options.state,
    directNotification: "eligible",
  };
}

type CreateExternalNodeOptions = Readonly<{
  nodeId: string;
  repositoryFullName: string;
  state: TrackedItemState;
}>;

function createExternalNode(options: CreateExternalNodeOptions): ExternalGraphAnalysisNode {
  return {
    kind: "external_reference",
    nodeId: createExternalReferenceNodeId(options.nodeId),
    repositoryFullName: options.repositoryFullName,
    state: options.state,
    directNotification: "not_eligible",
  };
}

function createActiveEdge(
  id: string,
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
  type: RelationType,
): ReconciledGraphEdge & Readonly<{ active: true }> {
  return {
    id: `rel:${id}`,
    fromNodeId,
    toNodeId,
    type,
    provenance: "native",
    confidence: 1,
    evidence: [
      {
        sourceId: buildSourceId("graph_fixture", id),
        supports: "relation",
        summary: "グラフ解析fixtureの関係です",
      },
    ],
    authoritative: true,
    contradictions: [],
    firstSeenAt: OBSERVED_AT,
    lastConfirmedAt: OBSERVED_AT,
    active: true,
  };
}

function createInactiveEdge(
  edge: ReconciledGraphEdge & Readonly<{ active: true }>,
): ReconciledGraphEdge & Readonly<{ active: false }> {
  return {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    authoritative: edge.authoritative,
    contradictions: edge.contradictions,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
    active: false,
    removedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
  };
}

function unavailablePrevious(): AnalyzeGraphInput["previous"] {
  return {
    availability: "unavailable",
  };
}

function availablePrevious(snapshot: GraphAnalysisSnapshot): AnalyzeGraphInput["previous"] {
  return {
    availability: "available",
    snapshot,
  };
}

function runAnalysis(
  nodes: readonly GraphAnalysisNode[],
  edges: readonly ReconciledGraphEdge[],
  previous: AnalyzeGraphInput["previous"],
): AnalyzeGraphResult {
  return analyzeGraph({
    current: {
      nodes,
      edges,
    },
    previous,
  });
}

function impactFor(
  result: AnalyzeGraphResult,
  nodeId: GraphNodeId,
): AnalyzeGraphResult["downstreamImpacts"][number] {
  const impact = result.downstreamImpacts.find((entry) => entry.nodeId === nodeId);
  if (impact == null) {
    throw new TypeError(`node ${nodeId}のdownstream impactがありません`);
  }
  return impact;
}

describe("dependency cycle", () => {
  it("A→B→C→Aを反復処理で1つのcycle componentにする", () => {
    const nodeA = createTrackedNode({
      nodeId: "I_A",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const nodeB = createTrackedNode({
      nodeId: "I_B",
      repositoryId: "R_engine",
      kind: "issue",
      state: "open",
    });
    const nodeC = createTrackedNode({
      nodeId: "I_C",
      repositoryId: "R_project",
      kind: "issue",
      state: "open",
    });
    const edgeAB = createActiveEdge("A-B", nodeA.nodeId, nodeB.nodeId, "blocks");
    const edgeBC = createActiveEdge("B-C", nodeB.nodeId, nodeC.nodeId, "blocks");
    const edgeCA = createActiveEdge("C-A", nodeC.nodeId, nodeA.nodeId, "blocks");

    const result = runAnalysis(
      [nodeC, nodeA, nodeB],
      [edgeBC, edgeCA, edgeAB],
      unavailablePrevious(),
    );
    const reordered = runAnalysis(
      [nodeA, nodeB, nodeC],
      [edgeAB, edgeBC, edgeCA],
      unavailablePrevious(),
    );

    expect(result.dependencyCycles).toHaveLength(1);
    expect(result.dependencyCycles[0]).toMatchObject({
      kind: "dependency_cycle",
      nodeIds: [nodeA.nodeId, nodeB.nodeId, nodeC.nodeId],
    });
    expect(result.dependencyCycles[0]?.edges.map((edge) => edge.id)).toEqual([
      edgeAB.id,
      edgeBC.id,
      edgeCA.id,
    ]);
    expect(result.dependencyCycles).toEqual(reordered.dependencyCycles);
    expect(result.actionableFrontier).toEqual([]);
  });

  it("自己ループをdependency_cycleとして扱う", () => {
    const node = createTrackedNode({
      nodeId: "I_self",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const edge = createActiveEdge("self", node.nodeId, node.nodeId, "blocks");

    const result = runAnalysis([node], [edge], unavailablePrevious());

    expect(result.dependencyCycles).toMatchObject([
      {
        kind: "dependency_cycle",
        nodeIds: [node.nodeId],
        edges: [{ id: edge.id }],
      },
    ]);
    expect(result.actionableFrontier).toEqual([]);
  });
});

describe("actionable frontier", () => {
  it("open blockerを持たない追跡対象だけをfrontierにする", () => {
    const nodeA = createTrackedNode({
      nodeId: "I_A",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const nodeB = createTrackedNode({
      nodeId: "I_B",
      repositoryId: "R_engine",
      kind: "issue",
      state: "open",
    });
    const nodeC = createTrackedNode({
      nodeId: "I_C",
      repositoryId: "R_project",
      kind: "pull_request",
      state: "open",
    });
    const nodeD = createTrackedNode({
      nodeId: "I_D",
      repositoryId: "R_project",
      kind: "issue",
      state: "open",
    });
    const terminal = createTrackedNode({
      nodeId: "I_terminal",
      repositoryId: "R_core",
      kind: "issue",
      state: "closed",
    });
    const externalBlocker = createExternalNode({
      nodeId: "external:blocker",
      repositoryFullName: "external/dependency",
      state: "open",
    });
    const edges = [
      createActiveEdge("A-B", nodeA.nodeId, nodeB.nodeId, "blocks"),
      createActiveEdge("B-C", nodeB.nodeId, nodeC.nodeId, "blocks"),
      createActiveEdge("terminal-D", terminal.nodeId, nodeD.nodeId, "blocks"),
      createActiveEdge("external-A", externalBlocker.nodeId, nodeA.nodeId, "blocks"),
    ];

    const result = runAnalysis(
      [nodeA, nodeB, nodeC, nodeD, terminal, externalBlocker],
      edges,
      unavailablePrevious(),
    );

    expect(result.actionableFrontier).toEqual([nodeD.nodeId]);
  });
});

describe("downstream impact", () => {
  it("既知DAGの推移的なopen node数とrepository数を算出する", () => {
    const nodeA = createTrackedNode({
      nodeId: "I_A",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const nodeB = createTrackedNode({
      nodeId: "I_B",
      repositoryId: "R_engine",
      kind: "issue",
      state: "open",
    });
    const nodeC = createTrackedNode({
      nodeId: "I_C",
      repositoryId: "R_core",
      kind: "pull_request",
      state: "open",
    });
    const nodeD = createTrackedNode({
      nodeId: "I_D",
      repositoryId: "R_project",
      kind: "issue",
      state: "open",
    });
    const terminal = createTrackedNode({
      nodeId: "I_terminal",
      repositoryId: "R_other",
      kind: "issue",
      state: "closed",
    });
    const edges = [
      createActiveEdge("A-B", nodeA.nodeId, nodeB.nodeId, "blocks"),
      createActiveEdge("A-C", nodeA.nodeId, nodeC.nodeId, "blocks"),
      createActiveEdge("B-D", nodeB.nodeId, nodeD.nodeId, "blocks"),
      createActiveEdge("C-D", nodeC.nodeId, nodeD.nodeId, "blocks"),
      createActiveEdge("D-terminal", nodeD.nodeId, terminal.nodeId, "blocks"),
      createActiveEdge("terminal-A", terminal.nodeId, nodeA.nodeId, "blocks"),
    ];

    const result = runAnalysis(
      [nodeA, nodeB, nodeC, nodeD, terminal],
      edges,
      unavailablePrevious(),
    );

    expect(impactFor(result, nodeA.nodeId)).toEqual({
      nodeId: nodeA.nodeId,
      openNodeCount: 3,
      repositoryCount: 3,
    });
    expect(impactFor(result, nodeB.nodeId)).toEqual({
      nodeId: nodeB.nodeId,
      openNodeCount: 1,
      repositoryCount: 1,
    });
    expect(impactFor(result, nodeC.nodeId)).toEqual({
      nodeId: nodeC.nodeId,
      openNodeCount: 1,
      repositoryCount: 1,
    });
    expect(impactFor(result, nodeD.nodeId)).toEqual({
      nodeId: nodeD.nodeId,
      openNodeCount: 0,
      repositoryCount: 0,
    });
    expect(impactFor(result, terminal.nodeId)).toEqual({
      nodeId: terminal.nodeId,
      openNodeCount: 0,
      repositoryCount: 0,
    });
  });
});

describe("connected component", () => {
  it("project、core、engineをまたぐedgeと型と向きを1つの表示単位に保持する", () => {
    const project = createTrackedNode({
      nodeId: "I_project",
      repositoryId: "R_project",
      kind: "issue",
      state: "open",
    });
    const core = createTrackedNode({
      nodeId: "I_core",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const engine = createTrackedNode({
      nodeId: "I_engine",
      repositoryId: "R_engine",
      kind: "pull_request",
      state: "open",
    });
    const projectCore = createActiveEdge("project-core", project.nodeId, core.nodeId, "parent_of");
    const coreEngine = createActiveEdge("core-engine", core.nodeId, engine.nodeId, "blocks");

    const result = runAnalysis(
      [project, core, engine],
      [projectCore, coreEngine],
      unavailablePrevious(),
    );
    const reordered = runAnalysis(
      [engine, project, core],
      [coreEngine, projectCore],
      unavailablePrevious(),
    );

    expect(result.connectedComponents).toHaveLength(1);
    expect(result.connectedComponents[0]).toMatchObject({
      nodeIds: [core.nodeId, engine.nodeId, project.nodeId],
      repositoryKeys: ["organization:R_core", "organization:R_engine", "organization:R_project"],
      edges: [
        {
          id: coreEngine.id,
          fromNodeId: core.nodeId,
          toNodeId: engine.nodeId,
          type: "blocks",
          provenance: "native",
          evidence: [{ supports: "relation" }],
        },
        {
          id: projectCore.id,
          fromNodeId: project.nodeId,
          toNodeId: core.nodeId,
          type: "parent_of",
          provenance: "native",
          evidence: [{ supports: "relation" }],
        },
      ],
    });
    expect(result.connectedComponents[0]?.id).toBe(reordered.connectedComponents[0]?.id);
  });
});

describe("隣接変化の伝播", () => {
  it("blockerのcloseだけで本文未更新の古いPRをnewly_unblockedにする", () => {
    const openBlocker = createTrackedNode({
      nodeId: "I_blocker",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const closedBlocker = createTrackedNode({
      nodeId: "I_blocker",
      repositoryId: "R_core",
      kind: "issue",
      state: "closed",
    });
    const oldPullRequest = createTrackedNode({
      nodeId: "PR_old",
      repositoryId: "R_engine",
      kind: "pull_request",
      state: "open",
    });
    const edge = createActiveEdge(
      "blocker-old-pr",
      openBlocker.nodeId,
      oldPullRequest.nodeId,
      "blocks",
    );
    const previous = {
      nodes: [openBlocker, oldPullRequest],
      edges: [edge],
    } satisfies GraphAnalysisSnapshot;

    const result = runAnalysis(
      [closedBlocker, oldPullRequest],
      [edge],
      availablePrevious(previous),
    );

    expect(result.reclassificationTargets).toEqual([
      {
        nodeId: oldPullRequest.nodeId,
        reasons: ["dependency_state_changed"],
        newlyUnblocked: true,
      },
    ]);
    expect(result.newlyUnblockedNodeIds).toEqual([oldPullRequest.nodeId]);
    expect(result.actionableFrontier).toEqual([oldPullRequest.nodeId]);
  });

  it("blocks edgeの削除でも隣接nodeを再分類する", () => {
    const blocker = createTrackedNode({
      nodeId: "I_blocker",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const blocked = createTrackedNode({
      nodeId: "I_blocked",
      repositoryId: "R_engine",
      kind: "issue",
      state: "open",
    });
    const activeEdge = createActiveEdge(
      "removed-blocker",
      blocker.nodeId,
      blocked.nodeId,
      "blocks",
    );
    const inactiveEdge = createInactiveEdge(activeEdge);
    const previous = {
      nodes: [blocker, blocked],
      edges: [activeEdge],
    } satisfies GraphAnalysisSnapshot;

    const result = runAnalysis([blocker, blocked], [inactiveEdge], availablePrevious(previous));

    expect(result.reclassificationTargets).toEqual([
      {
        nodeId: blocked.nodeId,
        reasons: ["dependency_edge_changed"],
        newlyUnblocked: true,
      },
    ]);
    expect(result.newlyUnblockedNodeIds).toEqual([blocked.nodeId]);
  });

  it("外部ghostを依存計算に含めるが通知対象にはしない", () => {
    const external = createExternalNode({
      nodeId: "external:blocker",
      repositoryFullName: "external/dependency",
      state: "open",
    });
    const tracked = createTrackedNode({
      nodeId: "I_tracked",
      repositoryId: "R_core",
      kind: "issue",
      state: "open",
    });
    const edge = createActiveEdge("external-tracked", external.nodeId, tracked.nodeId, "blocks");

    const result = runAnalysis([external, tracked], [edge], unavailablePrevious());

    expect(result.actionableFrontier).toEqual([]);
    expect(result.reclassificationTargets).toEqual([]);
    expect(impactFor(result, external.nodeId)).toEqual({
      nodeId: external.nodeId,
      openNodeCount: 1,
      repositoryCount: 1,
    });
  });
});

describe("性能", () => {
  it("5,000 nodeと10,000 edgeを実用的な時間で解析する", () => {
    const nodeCount = 5_000;
    const nodes = Array.from({ length: nodeCount }, (_, index) =>
      createTrackedNode({
        nodeId: `I_${index.toString().padStart(4, "0")}`,
        repositoryId: `R_${(index % 20).toString().padStart(2, "0")}`,
        kind: index % 2 === 0 ? "issue" : "pull_request",
        state: "open",
      }),
    );
    const edges: ReconciledGraphEdge[] = [];
    for (let index = 0; index < nodeCount - 1; index += 1) {
      const fromNode = nodes[index];
      const toNode = nodes[index + 1];
      if (fromNode == null || toNode == null) {
        throw new TypeError("性能fixtureの連続nodeがありません");
      }
      edges.push(
        createActiveEdge(`chain-${index.toString()}`, fromNode.nodeId, toNode.nodeId, "blocks"),
      );
    }
    for (let index = 0; index < nodeCount - 2; index += 1) {
      const fromNode = nodes[index];
      const toNode = nodes[index + 2];
      if (fromNode == null || toNode == null) {
        throw new TypeError("性能fixtureのskip nodeがありません");
      }
      edges.push(
        createActiveEdge(`skip-${index.toString()}`, fromNode.nodeId, toNode.nodeId, "blocks"),
      );
    }
    const finalNode = nodes[nodeCount - 1];
    if (finalNode == null) {
      throw new TypeError("性能fixtureの最終nodeがありません");
    }
    for (let index = 0; index < 3; index += 1) {
      const fromNode = nodes[index];
      if (fromNode == null) {
        throw new TypeError("性能fixtureの追加edge始点がありません");
      }
      edges.push(
        createActiveEdge(`final-${index.toString()}`, fromNode.nodeId, finalNode.nodeId, "blocks"),
      );
    }

    const startedAt = performance.now();
    const result = runAnalysis(nodes, edges, unavailablePrevious());
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(nodes).toHaveLength(5_000);
    expect(edges).toHaveLength(10_000);
    expect(result.dependencyCycles).toEqual([]);
    expect(result.connectedComponents).toHaveLength(1);
    const firstNode = nodes[0];
    if (firstNode == null) {
      throw new TypeError("性能fixtureの先頭nodeがありません");
    }
    expect(impactFor(result, firstNode.nodeId)).toMatchObject({
      openNodeCount: 4_999,
      repositoryCount: 20,
    });
    expect(elapsedMilliseconds).toBeLessThan(5_000);
  }, 10_000);
});

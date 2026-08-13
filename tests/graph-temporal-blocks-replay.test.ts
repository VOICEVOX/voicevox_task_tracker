import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type GraphNodeId,
  type SourceId,
} from "../src/domain/index.js";
import {
  replayTemporalBlocksGraph,
  type TemporalBlocksCurrentNode,
  type TemporalBlocksGraphReplayInput,
  type TemporalBlocksNodeStateHistory,
  type TemporalBlocksStateEpoch,
} from "../src/graph/temporal-blocks-graph-replay.js";

const nodeA = createGitHubNodeId("node-a");
const nodeB = createGitHubNodeId("node-b");
const nodeC = createGitHubNodeId("node-c");
const nodeX = createGitHubNodeId("node-x");

function sourceId(value: string): SourceId {
  return buildSourceId("temporal-test", value);
}

function time(value: string): ReturnType<typeof createUtcIsoDateTime> {
  return createUtcIsoDateTime(`2026-01-01T00:${value}:00.000Z`);
}

function edge(
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
): Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
}> {
  return { fromNodeId, toNodeId };
}

function stateEpoch(
  state: TemporalBlocksStateEpoch["state"],
  occurredAt: ReturnType<typeof time>,
  source: string,
  sequence: number,
): TemporalBlocksStateEpoch {
  return {
    state,
    occurredAt,
    sourceIds: [sourceId(source)],
    sequence,
  };
}

function stateHistory(
  nodeId: GraphNodeId,
  epochs: readonly TemporalBlocksStateEpoch[],
): TemporalBlocksNodeStateHistory {
  return {
    nodeId,
    history: {
      status: "exact",
      epochs,
    },
  };
}

function openHistories(nodes: readonly GraphNodeId[]): readonly TemporalBlocksNodeStateHistory[] {
  return nodes.map((nodeId, index) =>
    stateHistory(nodeId, [stateEpoch("open", time("00"), `open-${index.toString()}`, index)]),
  );
}

function resolvedRelation(
  source: string,
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
  action: "added" | "removed",
  occurredAt: ReturnType<typeof time>,
  sequence: number,
  originItemNodeId: GraphNodeId = toNodeId,
): Extract<
  TemporalBlocksGraphReplayInput["relationHistory"],
  { status: "exact" }
>["mutations"][number] {
  return {
    status: "resolved",
    sourceId: sourceId(source),
    originItemNodeId,
    fromNodeId,
    toNodeId,
    action,
    occurredAt,
    sequence,
  };
}

function currentNodes(
  nodes: readonly [GraphNodeId, ...GraphNodeId[]],
  state: TemporalBlocksCurrentNode["state"] = "open",
): readonly TemporalBlocksCurrentNode[] {
  return nodes.map((nodeId) => ({ nodeId, state }));
}

function input(
  nodes: readonly TemporalBlocksCurrentNode[],
  canonicalBlocksEdges: readonly ReturnType<typeof edge>[],
  nodeStateHistories: readonly TemporalBlocksNodeStateHistory[],
  mutations: Extract<
    TemporalBlocksGraphReplayInput["relationHistory"],
    { status: "exact" }
  >["mutations"],
): TemporalBlocksGraphReplayInput {
  return {
    current: {
      nodes,
      canonicalBlocksEdges,
    },
    nodeStateHistories,
    relationHistory: {
      status: "exact",
      mutations,
    },
  };
}

describe("replayTemporalBlocksGraph", () => {
  it("複数blockerでは最後のopen blockerがなくなった時刻だけを返す", () => {
    const relation = edge(nodeA, nodeX);
    const relationB = edge(nodeB, nodeX);
    const result = replayTemporalBlocksGraph(
      input(currentNodes([nodeA, nodeB, nodeX]), [], openHistories([nodeA, nodeB, nodeX]), [
        resolvedRelation("add-a", nodeA, nodeX, "added", time("01"), 1),
        resolvedRelation("add-b", nodeB, nodeX, "added", time("01"), 2),
        resolvedRelation("remove-a", nodeA, nodeX, "removed", time("02"), 1),
        resolvedRelation("remove-b", nodeB, nodeX, "removed", time("03"), 1),
      ]),
    );

    expect(result.newlyUnblockedFacts).toEqual([
      {
        status: "exact",
        value: {
          blockedNodeId: nodeX,
          occurredAt: time("03"),
          sourceIds: [sourceId("remove-b")],
          blockerNodeIds: [nodeB],
        },
      },
    ]);
    expect(relation).toEqual(edge(nodeA, nodeX));
    expect(relationB).toEqual(edge(nodeB, nodeX));
  });

  it("blockerのcloseとreopenを同時刻batchで扱い途中状態を通知しない", () => {
    const result = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA, nodeX]),
        [edge(nodeA, nodeX)],
        [
          stateHistory(nodeA, [
            stateEpoch("open", time("00"), "a-open", 0),
            stateEpoch("closed", time("02"), "a-close", 1),
            stateEpoch("open", time("02"), "a-reopen", 2),
          ]),
          ...openHistories([nodeX]),
        ],
        [resolvedRelation("add", nodeA, nodeX, "added", time("01"), 0)],
      ),
    );

    expect(result.newlyUnblockedFacts).toEqual([]);
  });

  it("last blockerのcloseだけをnewly unblockedとして返しreopenでは再通知しない", () => {
    const result = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA, nodeX]),
        [edge(nodeA, nodeX)],
        [
          stateHistory(nodeA, [
            stateEpoch("open", time("00"), "a-open", 0),
            stateEpoch("closed", time("02"), "a-close", 0),
            stateEpoch("open", time("03"), "a-reopen", 0),
          ]),
          ...openHistories([nodeX]),
        ],
        [resolvedRelation("add", nodeA, nodeX, "added", time("01"), 0)],
      ),
    );

    expect(result.newlyUnblockedFacts).toEqual([
      {
        status: "exact",
        value: {
          blockedNodeId: nodeX,
          occurredAt: time("02"),
          sourceIds: [sourceId("a-close")],
          blockerNodeIds: [nodeA],
        },
      },
    ]);
  });

  it("blocked nodeの前後stateを同時刻batchの前後で判定する", () => {
    const result = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA, nodeX]),
        [edge(nodeA, nodeX)],
        [
          stateHistory(nodeA, [
            stateEpoch("open", time("00"), "a-open", 0),
            stateEpoch("closed", time("02"), "a-close", 0),
            stateEpoch("open", time("03"), "a-reopen", 0),
          ]),
          stateHistory(nodeX, [
            stateEpoch("open", time("00"), "x-open", 0),
            stateEpoch("closed", time("02"), "x-close", 1),
            stateEpoch("open", time("02"), "x-reopen", 2),
          ]),
        ],
        [resolvedRelation("add", nodeA, nodeX, "added", time("01"), 0)],
      ),
    );

    expect(result.newlyUnblockedFacts).toEqual([
      {
        status: "exact",
        value: {
          blockedNodeId: nodeX,
          occurredAt: time("02"),
          sourceIds: [sourceId("a-close")],
          blockerNodeIds: [nodeA],
        },
      },
    ]);
  });

  it("同時刻のremoveとaddは最終状態だけをcycle判定へ渡す", () => {
    const result = replayTemporalBlocksGraph(
      input(currentNodes([nodeA, nodeB]), [], openHistories([nodeA, nodeB]), [
        resolvedRelation("add-first", nodeA, nodeB, "added", time("01"), 0),
        resolvedRelation("remove-first", nodeA, nodeB, "removed", time("01"), 1),
      ]),
    );

    expect(result.newlyUnblockedFacts).toEqual([]);
    expect(result.cycleCreatedFacts).toEqual([]);
  });

  it("cycleの追加削除再追加をそれぞれの初回成立時刻として返す", () => {
    const cycleEdges = [edge(nodeA, nodeB), edge(nodeB, nodeA)];
    const result = replayTemporalBlocksGraph(
      input(currentNodes([nodeA, nodeB]), cycleEdges, openHistories([nodeA, nodeB]), [
        resolvedRelation("add-ab", nodeA, nodeB, "added", time("01"), 0),
        resolvedRelation("add-ab-mirrored", nodeA, nodeB, "added", time("01"), 0, nodeA),
        resolvedRelation("add-ba", nodeB, nodeA, "added", time("01"), 1),
        resolvedRelation("remove-ba", nodeB, nodeA, "removed", time("02"), 0),
        resolvedRelation("add-ba-again", nodeB, nodeA, "added", time("03"), 0),
      ]),
    );

    const exactFacts = result.cycleCreatedFacts
      .filter((fact) => fact.status === "exact")
      .map((fact) => fact.value);
    expect(exactFacts).toHaveLength(2);
    expect(exactFacts.map((fact) => [fact.occurredAt, fact.sourceIds])).toEqual([
      [time("01"), [sourceId("add-ab"), sourceId("add-ab-mirrored"), sourceId("add-ba")]],
      [time("03"), [sourceId("add-ba-again")]],
    ]);
  });

  it("current graphは現在値から作りterminal endpointのedgeをinactiveにする", () => {
    const result = replayTemporalBlocksGraph(
      input(
        [
          { nodeId: nodeA, state: "closed" },
          { nodeId: nodeX, state: "closed" },
        ],
        [edge(nodeA, nodeX)],
        [
          stateHistory(nodeA, [
            stateEpoch("open", time("00"), "a-open", 0),
            stateEpoch("closed", time("01"), "a-close", 1),
          ]),
          stateHistory(nodeX, [
            stateEpoch("open", time("00"), "x-open", 0),
            stateEpoch("closed", time("01"), "x-close", 1),
          ]),
        ],
        [resolvedRelation("add", nodeA, nodeX, "added", time("00"), 1)],
      ),
    );

    expect(result.currentGraph.canonicalBlocksEdges).toEqual([edge(nodeA, nodeX)]);
    expect(result.currentGraph.activeBlocksEdges).toEqual([]);
    expect(result.newlyUnblockedFacts).toEqual([]);
  });

  it("unresolved relationはcurrent graphを変えず影響するfactをunknownにする", () => {
    const result = replayTemporalBlocksGraph({
      current: {
        nodes: currentNodes([nodeA, nodeX]),
        canonicalBlocksEdges: [],
      },
      nodeStateHistories: openHistories([nodeA, nodeX]),
      relationHistory: {
        status: "exact",
        mutations: [
          {
            status: "unresolved",
            sourceId: sourceId("unknown-relation"),
            originItemNodeId: nodeX,
            direction: "blocked_by",
            action: "removed",
            occurredAt: time("01"),
            sequence: 0,
            reason: "related_node_unavailable",
          },
        ],
      },
    });

    expect(result.currentGraph.activeBlocksEdges).toEqual([]);
    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [nodeX],
      reason: "relation_mutation_unresolved",
    });
    expect(result.cycleCreatedFacts).toContainEqual({
      status: "unknown",
      scope: "global",
      nodeIds: [],
      reason: "relation_mutation_unresolved",
    });
  });

  it("state historyがunknownでもcurrent graphを現在値から作る", () => {
    const result = replayTemporalBlocksGraph({
      current: {
        nodes: currentNodes([nodeA, nodeX]),
        canonicalBlocksEdges: [],
      },
      nodeStateHistories: [
        {
          nodeId: nodeA,
          history: { status: "unknown", reason: "history_unavailable" },
        },
        ...openHistories([nodeX]),
      ],
      relationHistory: {
        status: "exact",
        mutations: [
          resolvedRelation("a-add", nodeA, nodeX, "added", time("01"), 0),
          resolvedRelation("a-remove", nodeA, nodeX, "removed", time("02"), 0),
        ],
      },
    });

    expect(result.currentGraph.nodes).toEqual(currentNodes([nodeA, nodeX]));
    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [nodeA],
      reason: "state_history_unavailable",
    });
  });

  it("relation history unknownではunavailableだけを返す", () => {
    const result = replayTemporalBlocksGraph({
      current: {
        nodes: currentNodes([nodeA, nodeX]),
        canonicalBlocksEdges: [],
      },
      nodeStateHistories: openHistories([nodeA, nodeX]),
      relationHistory: {
        status: "unknown",
        reason: "history_unavailable",
      },
    });

    expect(result.newlyUnblockedFacts).toEqual([
      {
        status: "unknown",
        scope: "global",
        nodeIds: [],
        reason: "relation_history_unavailable",
      },
    ]);
    expect(result.cycleCreatedFacts).toEqual([
      {
        status: "unknown",
        scope: "global",
        nodeIds: [],
        reason: "relation_history_unavailable",
      },
    ]);
  });

  it("relation replayのcurrent mismatchではcurrent graphを変えずfactをglobal unknownにする", () => {
    const result = replayTemporalBlocksGraph({
      current: {
        nodes: currentNodes([nodeA, nodeX]),
        canonicalBlocksEdges: [edge(nodeA, nodeX)],
      },
      nodeStateHistories: openHistories([nodeA, nodeX]),
      relationHistory: {
        status: "exact",
        mutations: [],
      },
    });

    expect(result.currentGraph.activeBlocksEdges).toEqual([edge(nodeA, nodeX)]);
    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "global",
      nodeIds: [],
      reason: "relation_history_current_mismatch",
    });
    expect(result.cycleCreatedFacts).toContainEqual({
      status: "unknown",
      scope: "global",
      nodeIds: [],
      reason: "relation_history_current_mismatch",
    });
  });

  it("state replayのcurrent mismatchでは該当nodeのfactだけをunknownにする", () => {
    const result = replayTemporalBlocksGraph({
      current: {
        nodes: [
          { nodeId: nodeA, state: "closed" },
          { nodeId: nodeX, state: "open" },
        ],
        canonicalBlocksEdges: [edge(nodeA, nodeX)],
      },
      nodeStateHistories: [
        stateHistory(nodeA, [stateEpoch("open", time("00"), "a-open", 0)]),
        ...openHistories([nodeX]),
      ],
      relationHistory: {
        status: "exact",
        mutations: [resolvedRelation("add", nodeA, nodeX, "added", time("01"), 0)],
      },
    });

    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [nodeA],
      reason: "state_history_current_mismatch",
    });
    expect(result.currentGraph.activeBlocksEdges).toEqual([]);
  });

  it("入力順を入れ替えても同じ結果になる", () => {
    const histories = [
      stateHistory(nodeA, [stateEpoch("open", time("00"), "a-open", 0)]),
      stateHistory(nodeB, [stateEpoch("open", time("00"), "b-open", 0)]),
      stateHistory(nodeC, [stateEpoch("open", time("00"), "c-open", 0)]),
    ];
    const mutations = [
      resolvedRelation("add-ab", nodeA, nodeB, "added", time("01"), 2),
      resolvedRelation("add-bc", nodeB, nodeC, "added", time("01"), 1),
      resolvedRelation("add-ca", nodeC, nodeA, "added", time("01"), 0),
    ];
    const first = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA, nodeB, nodeC]),
        [edge(nodeA, nodeB), edge(nodeB, nodeC), edge(nodeC, nodeA)],
        histories,
        mutations,
      ),
    );
    const second = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeC, nodeB, nodeA]),
        [edge(nodeC, nodeA), edge(nodeB, nodeC), edge(nodeA, nodeB)],
        [...histories].reverse(),
        [...mutations].reverse(),
      ),
    );

    expect(second).toEqual(first);
  });

  it("同じsource IDの異なるstate epochとmerged後の遷移を例外にする", () => {
    expect(() =>
      replayTemporalBlocksGraph(
        input(
          currentNodes([nodeA]),
          [],
          [
            stateHistory(nodeA, [
              stateEpoch("open", time("00"), "same-source", 0),
              stateEpoch("closed", time("01"), "same-source", 1),
            ]),
          ],
          [],
        ),
      ),
    ).toThrowError(TypeError);

    expect(() =>
      replayTemporalBlocksGraph(
        input(
          currentNodes([nodeA]),
          [],
          [
            stateHistory(nodeA, [
              stateEpoch("merged", time("00"), "merged", 0),
              stateEpoch("open", time("01"), "reopened", 1),
            ]),
          ],
          [],
        ),
      ),
    ).toThrowError(TypeError);
  });
});

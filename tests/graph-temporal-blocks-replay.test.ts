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
    position: { kind: "timeline", sequence },
  };
}

function initialStateEpoch(
  state: TemporalBlocksStateEpoch["state"],
  occurredAt: ReturnType<typeof time>,
  source: string,
): TemporalBlocksStateEpoch {
  return {
    state,
    occurredAt,
    sourceIds: [sourceId(source)],
    position: { kind: "initial" },
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

function resolvedRelationWithOrigin(
  source: string,
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
  action: "added" | "removed",
  occurredAt: ReturnType<typeof time>,
  sequence: number,
  originItemNodeId: GraphNodeId,
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

function resolvedRelation(
  source: string,
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
  action: "added" | "removed",
  occurredAt: ReturnType<typeof time>,
  sequence: number,
): Extract<
  TemporalBlocksGraphReplayInput["relationHistory"],
  { status: "exact" }
>["mutations"][number] {
  return resolvedRelationWithOrigin(
    source,
    fromNodeId,
    toNodeId,
    action,
    occurredAt,
    sequence,
    toNodeId,
  );
}

function unresolvedRelation(
  source: string,
  originItemNodeId: GraphNodeId,
  direction: "blocked_by" | "blocking",
  action: "added" | "removed",
  occurredAt: ReturnType<typeof time>,
  sequence: number,
): Extract<
  TemporalBlocksGraphReplayInput["relationHistory"],
  { status: "exact" }
>["mutations"][number] {
  return {
    status: "unresolved",
    sourceId: sourceId(source),
    originItemNodeId,
    direction,
    action,
    occurredAt,
    sequence,
    reason: "related_node_unavailable",
  };
}

function currentNodesWithState(
  nodes: readonly [GraphNodeId, ...GraphNodeId[]],
  state: TemporalBlocksCurrentNode["state"],
): readonly TemporalBlocksCurrentNode[] {
  return nodes.map((nodeId) => ({ nodeId, state }));
}

function currentNodes(
  nodes: readonly [GraphNodeId, ...GraphNodeId[]],
): readonly TemporalBlocksCurrentNode[] {
  return currentNodesWithState(nodes, "open");
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
      localUnknowns: [],
    },
  };
}

describe("replayTemporalBlocksGraph", () => {
  it("initialとtimelineのstate epoch positionを受け入れる", () => {
    const result = replayTemporalBlocksGraph(
      input(
        currentNodesWithState([nodeA], "closed"),
        [],
        [
          stateHistory(nodeA, [
            initialStateEpoch("open", time("00"), "initial"),
            stateEpoch("closed", time("00"), "closed", 1),
          ]),
        ],
        [],
      ),
    );

    expect(result.newlyUnblockedFacts).toEqual([]);
    expect(result.cycleCreatedFacts).toEqual([]);
  });

  it("state epoch positionのproperty順に依存しない", () => {
    const sharedSourceId = sourceId("same-position");
    const sharedSourceIds: readonly [SourceId] = [sharedSourceId];
    const result = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA]),
        [],
        [
          stateHistory(nodeA, [
            {
              state: "open",
              occurredAt: time("00"),
              sourceIds: sharedSourceIds,
              position: { kind: "timeline", sequence: 1 },
            },
            {
              state: "open",
              occurredAt: time("00"),
              sourceIds: sharedSourceIds,
              position: { sequence: 1, kind: "timeline" },
            },
          ]),
        ],
        [],
      ),
    );

    expect(result.currentGraph.nodes).toEqual(currentNodes([nodeA]));
  });

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
        resolvedRelationWithOrigin("add-ab-mirrored", nodeA, nodeB, "added", time("01"), 0, nodeA),
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
        localUnknowns: [],
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
        localUnknowns: [],
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
        localUnknowns: [],
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
        localUnknowns: [],
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

  it("同じ編集sourceの複数edge mutationを一つのbatchで扱う", () => {
    const sharedSource = "shared-edit";
    const result = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA, nodeB]),
        [edge(nodeA, nodeB), edge(nodeB, nodeA)],
        openHistories([nodeA, nodeB]),
        [
          resolvedRelationWithOrigin(sharedSource, nodeA, nodeB, "added", time("01"), 1, nodeA),
          resolvedRelationWithOrigin(sharedSource, nodeB, nodeA, "added", time("01"), 1, nodeA),
        ],
      ),
    );

    expect(
      result.cycleCreatedFacts.some(
        (fact) =>
          fact.status === "exact" &&
          fact.value.sourceIds.length === 1 &&
          fact.value.sourceIds[0] === sourceId(sharedSource),
      ),
    ).toBe(true);
    expect(result.newlyUnblockedFacts).toEqual([]);
    expect(result.currentGraph.activeBlocksEdges).toEqual([edge(nodeA, nodeB), edge(nodeB, nodeA)]);
  });

  it("同じ編集sourceのresolvedとunresolvedと異なるedgeとactionを共存させる", () => {
    const sharedSource = "shared-mixed-edit";
    const mutations = [
      resolvedRelationWithOrigin(sharedSource, nodeA, nodeX, "added", time("01"), 1, nodeX),
      resolvedRelationWithOrigin(sharedSource, nodeB, nodeX, "removed", time("01"), 1, nodeX),
      unresolvedRelation(sharedSource, nodeX, "blocked_by", "added", time("01"), 1),
    ];
    const result = replayTemporalBlocksGraph(
      input(
        currentNodes([nodeA, nodeB, nodeX]),
        [edge(nodeA, nodeX)],
        openHistories([nodeA, nodeB, nodeX]),
        mutations,
      ),
    );

    expect(result.currentGraph.activeBlocksEdges).toEqual([edge(nodeA, nodeX)]);
    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [nodeX],
      reason: "relation_mutation_unresolved",
    });
  });

  it("同じ編集sourceの同一edgeでactionが衝突したら拒否する", () => {
    const sharedSource = "shared-edge-action-conflict";
    expect(() =>
      replayTemporalBlocksGraph(
        input(currentNodes([nodeA, nodeX]), [], openHistories([nodeA, nodeX]), [
          resolvedRelationWithOrigin(sharedSource, nodeA, nodeX, "added", time("01"), 1, nodeX),
          resolvedRelationWithOrigin(sharedSource, nodeA, nodeX, "removed", time("01"), 1, nodeX),
        ]),
      ),
    ).toThrow("同じsource IDの同じedgeでactionが衝突");
  });

  it("局所relation unknownは影響nodeのnewly unblockedだけを抑止する", () => {
    const mutations = [
      resolvedRelation("unknown-add", nodeA, nodeX, "added", time("01"), 1),
      resolvedRelation("exact-add", nodeB, nodeC, "added", time("01"), 2),
      resolvedRelation("unknown-remove", nodeA, nodeX, "removed", time("02"), 1),
      resolvedRelation("exact-remove", nodeB, nodeC, "removed", time("02"), 2),
    ];
    const replayInput = input(
      currentNodes([nodeA, nodeB, nodeC, nodeX]),
      [],
      openHistories([nodeA, nodeB, nodeC, nodeX]),
      mutations,
    );
    const result = replayTemporalBlocksGraph({
      ...replayInput,
      relationHistory: {
        status: "exact",
        mutations,
        localUnknowns: [{ originItemNodeId: nodeA }],
      },
    });

    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [nodeA],
      reason: "relation_mutation_unresolved",
    });
    expect(result.newlyUnblockedFacts).toContainEqual({
      status: "exact",
      value: {
        blockedNodeId: nodeC,
        occurredAt: time("02"),
        sourceIds: [sourceId("exact-remove")],
        blockerNodeIds: [nodeB],
      },
    });
    expect(
      result.newlyUnblockedFacts.some(
        (fact) => fact.status === "exact" && fact.value.blockedNodeId === nodeX,
      ),
    ).toBe(false);
  });

  it("局所relation unknownは影響componentのcycleだけを抑止する", () => {
    const mutations = [
      resolvedRelation("unknown-cycle-a-x", nodeA, nodeX, "added", time("01"), 1),
      resolvedRelation("unknown-cycle-x-a", nodeX, nodeA, "added", time("01"), 2),
      resolvedRelation("exact-cycle-b-c", nodeB, nodeC, "added", time("01"), 3),
      resolvedRelation("exact-cycle-c-b", nodeC, nodeB, "added", time("01"), 4),
    ];
    const replayInput = input(
      currentNodes([nodeA, nodeB, nodeC, nodeX]),
      [edge(nodeA, nodeX), edge(nodeB, nodeC), edge(nodeC, nodeB), edge(nodeX, nodeA)],
      openHistories([nodeA, nodeB, nodeC, nodeX]),
      mutations,
    );
    const result = replayTemporalBlocksGraph({
      ...replayInput,
      relationHistory: {
        status: "exact",
        mutations,
        localUnknowns: [{ originItemNodeId: nodeA }],
      },
    });

    expect(result.cycleCreatedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [nodeA],
      reason: "relation_mutation_unresolved",
    });
    expect(
      result.cycleCreatedFacts.some(
        (fact) =>
          fact.status === "exact" &&
          fact.value.nodeIds.length === 2 &&
          fact.value.nodeIds[0] === nodeB &&
          fact.value.nodeIds[1] === nodeC,
      ),
    ).toBe(true);
    expect(
      result.cycleCreatedFacts.some(
        (fact) =>
          fact.status === "exact" &&
          fact.value.nodeIds.some((nodeId) => nodeId === nodeA || nodeId === nodeX),
      ),
    ).toBe(false);
  });

  it("同じsource IDの時刻、origin、state event衝突を拒否する", () => {
    expect(() =>
      replayTemporalBlocksGraph(
        input(currentNodes([nodeA, nodeX]), [edge(nodeA, nodeX)], openHistories([nodeA, nodeX]), [
          resolvedRelation("relation-conflict", nodeA, nodeX, "added", time("01"), 0),
          resolvedRelation("relation-conflict", nodeA, nodeX, "removed", time("02"), 0),
        ]),
      ),
    ).toThrowError(TypeError);

    expect(() =>
      replayTemporalBlocksGraph(
        input(
          currentNodes([nodeA, nodeX]),
          [edge(nodeA, nodeX)],
          [
            stateHistory(nodeA, [stateEpoch("open", time("00"), "state-conflict", 0)]),
            ...openHistories([nodeX]),
          ],
          [resolvedRelation("state-conflict", nodeA, nodeX, "added", time("01"), 0)],
        ),
      ),
    ).toThrowError(TypeError);
  });
});

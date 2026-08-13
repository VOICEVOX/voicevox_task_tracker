import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemUrl,
  type SourceId,
} from "../src/domain/index.js";
import {
  adaptGitHubDependencyEvents,
  type GitHubDetailActor,
  type GitHubReferencedItem,
  type GitHubTimelineEvent,
} from "../src/github/index.js";
import { replayDependencyEvents, type DependencyReplayInputEvent } from "../src/graph/index.js";

type ResolvedDependencyReplayEvent = Extract<DependencyReplayInputEvent, { status: "resolved" }>;
type UnavailableReferencedItem = Readonly<{
  status: "unavailable";
  reason: "github_did_not_return_item";
}>;
type DependencyTimelineKind =
  "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";

const repositoryId = createGitHubRepositoryId("R_dependency_replay");
const defaultOccurredAt = "2026-08-01T00:00:00Z";
const unavailableActor: Extract<GitHubDetailActor, { status: "unavailable" }> = {
  status: "unavailable",
  reason: "github_did_not_return_actor",
};

function sourceId(value: string): SourceId {
  return buildSourceId("github_timeline_event", value);
}

function createReferencedItem(
  nodeIdValue: string,
  number: number,
  type: "issue" | "pull_request",
): GitHubReferencedItem {
  const nodeId = createGitHubNodeId(nodeIdValue);
  const url: GitHubItemUrl =
    type === "issue"
      ? `https://github.com/VOICEVOX/replay/issues/${number.toString()}`
      : `https://github.com/VOICEVOX/replay/pull/${number.toString()}`;
  return {
    sourceId: buildSourceId("github_item", nodeIdValue),
    nodeId,
    repositoryId,
    repositoryOwner: "VOICEVOX",
    repositoryName: "replay",
    repositoryArchived: false,
    repositoryDisabled: false,
    type,
    number,
    url,
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00Z"),
    state: "open",
  };
}

function createTimelineEvent(options: {
  kind: DependencyTimelineKind;
  nodeIdValue: string;
  sourceIdValue: string;
  sequence: number;
  occurredAt?: string;
  target: GitHubReferencedItem | UnavailableReferencedItem;
}): GitHubTimelineEvent {
  const base = {
    sourceId: sourceId(options.sourceIdValue),
    nodeId: createGitHubNodeId(options.nodeIdValue),
    sequence: options.sequence,
    occurredAt: createUtcIsoDateTime(options.occurredAt ?? defaultOccurredAt),
    actor: unavailableActor,
  };
  switch (options.kind) {
    case "blocked_by_added":
      return { ...base, kind: options.kind, blockingIssue: options.target };
    case "blocked_by_removed":
      return { ...base, kind: options.kind, blockingIssue: options.target };
    case "blocking_added":
      return { ...base, kind: options.kind, blockedIssue: options.target };
    case "blocking_removed":
      return { ...base, kind: options.kind, blockedIssue: options.target };
  }
}

function createResolvedEvent(options: {
  sourceIdValue: string;
  originItemNodeId: string;
  fromNodeId: string;
  toNodeId: string;
  action: "added" | "removed";
  occurredAt?: string;
  sequence: number;
}): ResolvedDependencyReplayEvent {
  return {
    status: "resolved",
    sourceId: sourceId(options.sourceIdValue),
    originItemNodeId: createGitHubNodeId(options.originItemNodeId),
    fromNodeId: createGitHubNodeId(options.fromNodeId),
    toNodeId: createGitHubNodeId(options.toNodeId),
    action: options.action,
    occurredAt: createUtcIsoDateTime(options.occurredAt ?? defaultOccurredAt),
    sequence: options.sequence,
  };
}

describe("GitHub依存関係イベントadapter", () => {
  it("4種類のイベントをIssueとPull Requestのcanonicalな向きへ変換する", () => {
    const events = [
      createTimelineEvent({
        kind: "blocked_by_added",
        nodeIdValue: "I_blocked",
        sourceIdValue: "blocked-by-added",
        sequence: 0,
        target: createReferencedItem("I_blocker", 1, "issue"),
      }),
      createTimelineEvent({
        kind: "blocked_by_removed",
        nodeIdValue: "I_blocked",
        sourceIdValue: "blocked-by-removed",
        sequence: 1,
        target: createReferencedItem("PR_blocker", 2, "pull_request"),
      }),
      createTimelineEvent({
        kind: "blocking_added",
        nodeIdValue: "PR_blocker",
        sourceIdValue: "blocking-added",
        sequence: 2,
        target: createReferencedItem("I_blocked", 3, "issue"),
      }),
      createTimelineEvent({
        kind: "blocking_removed",
        nodeIdValue: "PR_blocker",
        sourceIdValue: "blocking-removed",
        sequence: 3,
        target: createReferencedItem("PR_blocked", 4, "pull_request"),
      }),
    ];

    expect(adaptGitHubDependencyEvents(events)).toMatchObject([
      {
        status: "resolved",
        fromNodeId: createGitHubNodeId("I_blocker"),
        toNodeId: createGitHubNodeId("I_blocked"),
        action: "added",
      },
      {
        status: "resolved",
        fromNodeId: createGitHubNodeId("PR_blocker"),
        toNodeId: createGitHubNodeId("I_blocked"),
        action: "removed",
      },
      {
        status: "resolved",
        fromNodeId: createGitHubNodeId("PR_blocker"),
        toNodeId: createGitHubNodeId("I_blocked"),
        action: "added",
      },
      {
        status: "resolved",
        fromNodeId: createGitHubNodeId("PR_blocker"),
        toNodeId: createGitHubNodeId("PR_blocked"),
        action: "removed",
      },
    ]);
  });

  it("相手項目がunavailableでもunresolved入力を返し、推測しない", () => {
    const event = createTimelineEvent({
      kind: "blocked_by_added",
      nodeIdValue: "I_blocked",
      sourceIdValue: "missing-target",
      sequence: 7,
      target: {
        status: "unavailable",
        reason: "github_did_not_return_item",
      },
    });

    const adapted = adaptGitHubDependencyEvents([event]);
    expect(adapted).toEqual([
      {
        status: "unresolved",
        sourceId: sourceId("missing-target"),
        originItemNodeId: createGitHubNodeId("I_blocked"),
        direction: "blocked_by",
        action: "added",
        occurredAt: createUtcIsoDateTime(defaultOccurredAt),
        sequence: 7,
        reason: "related_node_unavailable",
      },
    ]);
    expect(replayDependencyEvents(adapted)).toMatchObject({
      relations: [],
      transitions: [],
      batches: [],
      unresolvedEvents: adapted,
    });
  });
});

describe("依存関係interval reducer", () => {
  it("同一source IDの同一編集による複数edgeを保持し完全同一eventだけdedupeする", () => {
    const firstEdge = createResolvedEvent({
      sourceIdValue: "same-source",
      originItemNodeId: "I_blocker",
      fromNodeId: "I_blocker",
      toNodeId: "I_blocked",
      action: "added",
      sequence: 0,
    });
    const secondEdge = createResolvedEvent({
      sourceIdValue: "same-source",
      originItemNodeId: "I_blocker",
      fromNodeId: "I_blocker",
      toNodeId: "I_other",
      action: "added",
      sequence: 0,
    });
    const first = replayDependencyEvents([secondEdge, firstEdge, firstEdge, secondEdge]);
    const second = replayDependencyEvents([firstEdge, secondEdge]);

    expect(first).toEqual(second);
    expect(first.transitions).toHaveLength(2);
    expect(first.transitions.map((transition) => transition.sourceIds)).toEqual([
      [sourceId("same-source")],
      [sourceId("same-source")],
    ]);
    expect(first.relations).toHaveLength(2);
    expect(first.relations.every((relation) => relation.intervals[0].status === "active")).toBe(
      true,
    );
  });

  it("同一source IDのorigin、時刻、sequence差を真のconflictとして拒否する", () => {
    const base = createResolvedEvent({
      sourceIdValue: "same-identity-source",
      originItemNodeId: "I_blocker",
      fromNodeId: "I_blocker",
      toNodeId: "I_blocked",
      action: "added",
      sequence: 0,
    });
    const conflicts: readonly ResolvedDependencyReplayEvent[] = [
      { ...base, originItemNodeId: createGitHubNodeId("I_blocked") },
      { ...base, occurredAt: createUtcIsoDateTime("2026-08-01T01:00:00Z") },
      { ...base, sequence: 1 },
    ];
    for (const conflict of conflicts) {
      expect(() => replayDependencyEvents([base, conflict])).toThrow(
        "同じsource IDが異なる依存関係イベントを指しています",
      );
    }
  });

  it("同一source IDの同一edgeのaction違いを拒否する", () => {
    const added = createResolvedEvent({
      sourceIdValue: "same-edge-action",
      originItemNodeId: "I_blocker",
      fromNodeId: "I_blocker",
      toNodeId: "I_blocked",
      action: "added",
      sequence: 0,
    });
    const removed = { ...added, action: "removed" as const };
    expect(() => replayDependencyEvents([added, removed])).toThrow(
      "同じsource IDの同じedgeでactionが衝突",
    );
  });

  it("同一source IDのresolved、unresolved、複数edgeとactionを同じ編集として保持する", () => {
    const unresolved: DependencyReplayInputEvent = {
      status: "unresolved",
      sourceId: sourceId("same-edit-source"),
      originItemNodeId: createGitHubNodeId("I_blocker"),
      direction: "blocking",
      action: "removed",
      occurredAt: createUtcIsoDateTime(defaultOccurredAt),
      sequence: 0,
      reason: "related_node_unavailable",
    };
    const firstResolved = createResolvedEvent({
      sourceIdValue: "same-edit-source",
      originItemNodeId: "I_blocker",
      fromNodeId: "I_blocker",
      toNodeId: "I_blocked",
      action: "added",
      sequence: 0,
    });
    const secondResolved = createResolvedEvent({
      sourceIdValue: "same-edit-source",
      originItemNodeId: "I_blocker",
      fromNodeId: "I_blocker",
      toNodeId: "I_other",
      action: "removed",
      sequence: 0,
    });

    const result = replayDependencyEvents([unresolved, secondResolved, firstResolved]);

    expect(result.unresolvedEvents).toEqual([unresolved]);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]?.edge).toEqual({
      fromNodeId: createGitHubNodeId("I_blocker"),
      toNodeId: createGitHubNodeId("I_blocked"),
    });
    expect(result.relations[0]?.current.status).toBe("active");
    expect(result.transitions).toContainEqual({
      kind: "added",
      edge: {
        fromNodeId: createGitHubNodeId("I_blocker"),
        toNodeId: createGitHubNodeId("I_blocked"),
      },
      occurredAt: createUtcIsoDateTime(defaultOccurredAt),
      sourceIds: [sourceId("same-edit-source")],
    });
    expect(result.transitions).toContainEqual({
      kind: "unmatched_removed",
      edge: {
        fromNodeId: createGitHubNodeId("I_blocker"),
        toNodeId: createGitHubNodeId("I_other"),
      },
      occurredAt: createUtcIsoDateTime(defaultOccurredAt),
      sourceIds: [sourceId("same-edit-source")],
    });
  });

  it("mirroredな追加と削除を一つのtransitionへ統合する", () => {
    const addedAt = "2026-08-01T00:00:00Z";
    const removedAt = "2026-08-02T00:00:00Z";
    const events = [
      createResolvedEvent({
        sourceIdValue: "add-from-blocker",
        originItemNodeId: "I_blocker",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "added",
        occurredAt: addedAt,
        sequence: 0,
      }),
      createResolvedEvent({
        sourceIdValue: "add-from-blocked",
        originItemNodeId: "I_blocked",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "added",
        occurredAt: addedAt,
        sequence: 1,
      }),
      createResolvedEvent({
        sourceIdValue: "remove-from-blocker",
        originItemNodeId: "I_blocker",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "removed",
        occurredAt: removedAt,
        sequence: 2,
      }),
      createResolvedEvent({
        sourceIdValue: "remove-from-blocked",
        originItemNodeId: "I_blocked",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "removed",
        occurredAt: removedAt,
        sequence: 3,
      }),
    ];

    const result = replayDependencyEvents(events);
    expect(result.transitions.map((transition) => [transition.kind, transition.sourceIds])).toEqual(
      [
        ["added", [sourceId("add-from-blocked"), sourceId("add-from-blocker")]],
        ["removed", [sourceId("remove-from-blocked"), sourceId("remove-from-blocker")]],
      ],
    );
    expect(result.batches).toHaveLength(2);
    expect(result.relations[0]?.current).toEqual({
      status: "inactive",
      removedAt: createUtcIsoDateTime(removedAt),
    });
    expect(result.relations[0]?.intervals[0]).toEqual({
      status: "removed",
      addedAt: createUtcIsoDateTime(addedAt),
      addedSourceIds: [sourceId("add-from-blocked"), sourceId("add-from-blocker")],
      removedAt: createUtcIsoDateTime(removedAt),
      removedSourceIds: [sourceId("remove-from-blocked"), sourceId("remove-from-blocker")],
    });
  });

  it("active中の追加をconfirmationとして統合し、remove後の再追加を新区間にする", () => {
    const result = replayDependencyEvents([
      createResolvedEvent({
        sourceIdValue: "first-add",
        originItemNodeId: "I_blocker",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "added",
        occurredAt: "2026-08-01T00:00:00Z",
        sequence: 0,
      }),
      createResolvedEvent({
        sourceIdValue: "confirmation",
        originItemNodeId: "I_blocked",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "added",
        occurredAt: "2026-08-02T00:00:00Z",
        sequence: 0,
      }),
      createResolvedEvent({
        sourceIdValue: "first-remove",
        originItemNodeId: "I_blocked",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "removed",
        occurredAt: "2026-08-03T00:00:00Z",
        sequence: 1,
      }),
      createResolvedEvent({
        sourceIdValue: "second-add",
        originItemNodeId: "I_blocker",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "added",
        occurredAt: "2026-08-04T00:00:00Z",
        sequence: 2,
      }),
    ]);

    expect(result.transitions.map((transition) => transition.kind)).toEqual([
      "added",
      "confirmed",
      "removed",
      "added",
    ]);
    const relation = result.relations[0];
    expect(relation?.firstSeenAt).toBe(createUtcIsoDateTime("2026-08-01T00:00:00Z"));
    expect(relation?.current).toEqual({
      status: "active",
      lastConfirmedAt: createUtcIsoDateTime("2026-08-04T00:00:00Z"),
    });
    expect(relation?.intervals.map((interval) => interval.status)).toEqual(["removed", "active"]);
    expect(relation?.intervals[1]).toEqual({
      status: "active",
      addedAt: createUtcIsoDateTime("2026-08-04T00:00:00Z"),
      sourceIds: [sourceId("second-add")],
      lastConfirmedAt: createUtcIsoDateTime("2026-08-04T00:00:00Z"),
    });
  });

  it("inactive状態のremoveをunmatched診断として保持する", () => {
    const result = replayDependencyEvents([
      createResolvedEvent({
        sourceIdValue: "unmatched-remove",
        originItemNodeId: "I_blocked",
        fromNodeId: "I_blocker",
        toNodeId: "I_blocked",
        action: "removed",
        sequence: 0,
      }),
    ]);
    expect(result.transitions[0]).toMatchObject({
      kind: "unmatched_removed",
      edge: {
        fromNodeId: createGitHubNodeId("I_blocker"),
        toNodeId: createGitHubNodeId("I_blocked"),
      },
    });
    expect(result.relations).toEqual([]);
  });

  it("入力順によらずorigin、sequence、source IDの順で同時刻を再生する", () => {
    const add = createResolvedEvent({
      sourceIdValue: "z-add",
      originItemNodeId: "Z_blocker",
      fromNodeId: "Z_blocker",
      toNodeId: "A_blocked",
      action: "added",
      sequence: 2,
    });
    const remove = createResolvedEvent({
      sourceIdValue: "a-remove",
      originItemNodeId: "A_blocked",
      fromNodeId: "Z_blocker",
      toNodeId: "A_blocked",
      action: "removed",
      sequence: 1,
    });
    const first = replayDependencyEvents([add, remove]);
    const second = replayDependencyEvents([remove, add]);

    expect(second).toEqual(first);
    expect(first.batches).toHaveLength(1);
    expect(first.batches[0]?.transitions.map((transition) => transition.kind)).toEqual([
      "unmatched_removed",
      "added",
    ]);
    expect(first.batches[0]?.activeEdges).toEqual([
      {
        fromNodeId: createGitHubNodeId("Z_blocker"),
        toNodeId: createGitHubNodeId("A_blocked"),
      },
    ]);
  });
});

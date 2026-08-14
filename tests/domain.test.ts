import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildSourceId,
  compareSeverity,
  createGitHubNodeId,
  createTrackedItemLatestEventActor,
  createUtcIsoDateTime,
  isTerminalStatus,
  parseSourceId,
  type GitHubAccountActor,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type NormalizedEvent,
} from "../src/domain/index.js";

describe("ドメイン識別子", () => {
  it("GitHub node IDとrepository IDを異なる型として扱う", () => {
    expectTypeOf<GitHubNodeId>().not.toEqualTypeOf<GitHubRepositoryId>();
  });
});

describe("source ID", () => {
  it("要件定義の例と同じ形式で組み立てる", () => {
    expect(buildSourceId("body", "current")).toBe("body:current");
    expect(buildSourceId("comment", "bot:1")).toBe("comment:bot:1");
    expect(buildSourceId("github", "native-dependency:45")).toBe("github:native-dependency:45");
  });

  it("同じ種別と元IDから常に同じsource IDを組み立てる", () => {
    const first = buildSourceId("comment", "IC_kwDOBB:123");
    const second = buildSourceId("comment", "IC_kwDOBB:123");

    expect(first).toBe(second);
  });

  it("区切り文字や日本語を含む元IDを往復変換する", () => {
    const originalId = "VOICEVOX/example#42:要確認%";
    const sourceId = buildSourceId("relation", originalId);

    expect(parseSourceId(sourceId)).toEqual({
      kind: "relation",
      originalId,
    });
  });

  it("同じ元IDを表せる非正規形式を拒否する", () => {
    expect(() => parseSourceId("comment:%3A")).toThrow("source IDが正規形式ではありません");
  });
});

describe("severity比較", () => {
  it("none、watch、urgent、criticalの順に比較する", () => {
    expect(compareSeverity("none", "watch")).toBe(-1);
    expect(compareSeverity("watch", "urgent")).toBe(-1);
    expect(compareSeverity("urgent", "critical")).toBe(-1);
    expect(compareSeverity("critical", "none")).toBe(1);
    expect(compareSeverity("urgent", "urgent")).toBe(0);
  });
});

describe("terminal判定", () => {
  it("3種類のterminal状態を終了状態と判定する", () => {
    expect(isTerminalStatus("terminal_merged")).toBe(true);
    expect(isTerminalStatus("terminal_completed")).toBe(true);
    expect(isTerminalStatus("terminal_not_planned")).toBe(true);
  });

  it("継続中の状態を終了状態と判定しない", () => {
    expect(isTerminalStatus("waiting_for_assessment")).toBe(false);
    expect(isTerminalStatus("waiting_for_owner")).toBe(false);
    expect(isTerminalStatus("waiting_for_unblock")).toBe(false);
    expect(isTerminalStatus("unknown")).toBe(false);
  });
});

describe("正規化イベント", () => {
  const itemNodeId = createGitHubNodeId("I_kwDOItem");
  const occurredAt = createUtcIsoDateTime("2026-07-31T00:00:00Z");
  const actor = {
    type: "human",
    nodeId: createGitHubNodeId("U_kwDOActor"),
    login: "reviewer",
  } satisfies GitHubAccountActor;
  const eventBase = {
    itemNodeId,
    occurredAt,
    actor,
  };

  function describeEvent(event: NormalizedEvent): string {
    switch (event.kind) {
      case "comment":
        return `${event.bodyFingerprint}:${String(event.bodyEmpty)}:${event.replyToCommentNodeId ?? "返信先なし"}`;
      case "push":
        return `${event.headCommitSha}:${String(event.forcePush)}`;
      case "review":
        return event.commitStatus === "available"
          ? `${event.state}:${event.commitSha}`
          : `${event.state}:commit不明`;
      case "review_request":
        return `${event.target.type}:${event.target.nodeId}:${event.action}`;
      case "label":
        return `${event.labelName}:${event.action}`;
      case "assignee":
        return `${event.assignee.login}:${event.action}`;
      case "state":
        return event.state === "closed" ? `${event.state}:${event.stateReason}` : event.state;
      case "relation": {
        const target = event.target.type === "node" ? event.target.nodeId : event.target.url;
        return `${event.relationType}:${target}:${event.action}:${event.provenance}:${event.direction}`;
      }
      case "ready_for_review":
      case "converted_to_draft":
      case "added_to_merge_queue":
      case "removed_from_merge_queue":
      case "auto_merge_enabled":
      case "auto_merge_disabled":
        return event.kind;
    }
  }

  it("変更種別ごとの内容を保持し、コメント本文は保持しない", () => {
    const commentEvent = {
      ...eventBase,
      kind: "comment",
      sourceId: buildSourceId("comment", "IC_kwDOComment"),
      bodyFingerprint: "sha256:comment",
      bodyEmpty: false,
      replyToCommentNodeId: createGitHubNodeId("PRRC_kwDOParent"),
    } satisfies NormalizedEvent;
    const events = [
      commentEvent,
      {
        ...eventBase,
        kind: "push",
        sourceId: buildSourceId("push", "head"),
        headCommitSha: "0123456789abcdef",
        forcePush: true,
      },
      {
        ...eventBase,
        kind: "review",
        sourceId: buildSourceId("review", "PRR_kwDOReview"),
        state: "approved",
        bodyFingerprint: "sha256:review",
        bodyEmpty: false,
        commitStatus: "available",
        commitSha: "0123456789abcdef",
      },
      {
        ...eventBase,
        kind: "review_request",
        sourceId: buildSourceId("review_request", "request:1"),
        target: {
          type: "team",
          nodeId: createGitHubNodeId("T_kwDOTeam"),
        },
        action: "added",
      },
      {
        ...eventBase,
        kind: "label",
        sourceId: buildSourceId("label", "bug:added"),
        labelName: "bug",
        action: "added",
      },
      {
        ...eventBase,
        kind: "assignee",
        sourceId: buildSourceId("assignee", "reviewer:removed"),
        assignee: actor,
        action: "removed",
      },
      {
        ...eventBase,
        kind: "state",
        sourceId: buildSourceId("state", "closed"),
        state: "closed",
        stateReason: "completed",
      },
      {
        ...eventBase,
        kind: "relation",
        sourceId: buildSourceId("relation", "blocks:1"),
        relationType: "blocks",
        target: {
          type: "node",
          nodeId: createGitHubNodeId("I_kwDORelated"),
        },
        action: "added",
        provenance: "native",
        direction: "from_item",
      },
    ] satisfies readonly NormalizedEvent[];

    expect(events.map(describeEvent)).toEqual([
      "sha256:comment:false:PRRC_kwDOParent",
      "0123456789abcdef:true",
      "approved:0123456789abcdef",
      "team:T_kwDOTeam:added",
      "bug:added",
      "reviewer:removed",
      "closed:completed",
      "blocks:I_kwDORelated:added:native:from_item",
    ]);
    expect(commentEvent).not.toHaveProperty("body");
  });

  it("review stateを4種類に区別する", () => {
    const reviewStates = [
      "approved",
      "changes_requested",
      "commented",
      "dismissed",
    ] satisfies readonly Extract<NormalizedEvent, { kind: "review" }>["state"][];

    expect(reviewStates).toEqual(["approved", "changes_requested", "commented", "dismissed"]);
  });

  it("state遷移を区別し、closedだけstate reasonを持つ", () => {
    const stateEvents = [
      {
        ...eventBase,
        kind: "state",
        sourceId: buildSourceId("state", "open"),
        state: "open",
      },
      {
        ...eventBase,
        kind: "state",
        sourceId: buildSourceId("state", "closed"),
        state: "closed",
        stateReason: "not_planned",
      },
      {
        ...eventBase,
        kind: "state",
        sourceId: buildSourceId("state", "merged"),
        state: "merged",
      },
      {
        ...eventBase,
        kind: "state",
        sourceId: buildSourceId("state", "reopened"),
        state: "reopened",
      },
    ] satisfies readonly Extract<NormalizedEvent, { kind: "state" }>[];

    expect(stateEvents.map(describeEvent)).toEqual([
      "open",
      "closed:not_planned",
      "merged",
      "reopened",
    ]);
  });
});

describe("追跡項目の最新イベントアクター", () => {
  const itemNodeId = createGitHubNodeId("I_kwDOLatestEventActor");

  function createCommentEvent(
    sourceOriginalId: string,
    occurredAt: string,
    actorLogin: string,
  ): Extract<NormalizedEvent, { kind: "comment" }> {
    return {
      kind: "comment",
      sourceId: buildSourceId("comment", sourceOriginalId),
      itemNodeId,
      occurredAt: createUtcIsoDateTime(occurredAt),
      actor: {
        type: "human",
        nodeId: createGitHubNodeId(`U_${actorLogin}`),
        login: actorLogin,
      },
      bodyFingerprint: `sha256:${sourceOriginalId}`,
      bodyEmpty: false,
    };
  }

  it("イベントがない場合はアクターなしを返す", () => {
    expect(createTrackedItemLatestEventActor([])).toEqual({
      status: "absent",
    });
  });

  it("入力順にかかわらず発生時刻が最も新しいアクターを返す", () => {
    const newestEvent = createCommentEvent("newest", "2026-08-02T02:00:00Z", "newest");
    const events = [
      newestEvent,
      createCommentEvent("oldest", "2026-08-02T00:00:00Z", "oldest"),
      createCommentEvent("middle", "2026-08-02T01:00:00Z", "middle"),
    ];

    expect(createTrackedItemLatestEventActor(events)).toEqual({
      status: "present",
      actor: newestEvent.actor,
    });
  });

  it("発生時刻が同じ場合はsource IDが最も大きいアクターを返す", () => {
    const smallerSourceEvent = createCommentEvent("a", "2026-08-02T00:00:00Z", "smaller");
    const largerSourceEvent = createCommentEvent("z", "2026-08-02T00:00:00Z", "larger");

    expect(createTrackedItemLatestEventActor([smallerSourceEvent, largerSourceEvent])).toEqual({
      status: "present",
      actor: largerSourceEvent.actor,
    });
    expect(createTrackedItemLatestEventActor([largerSourceEvent, smallerSourceEvent])).toEqual({
      status: "present",
      actor: largerSourceEvent.actor,
    });
  });
});

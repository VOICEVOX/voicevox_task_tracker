import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  replayItemHistory,
  type Actor,
  type GitHubAccountActor,
  type GitHubNodeId,
  type NormalizedEvent,
  type ReplayCurrentItem,
  type ReplayEvent,
} from "../src/domain/index.js";

const createdAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const observedAt = createUtcIsoDateTime("2026-08-01T12:00:00Z");
const trackingStartAt = createUtcIsoDateTime("2026-08-01T04:00:00Z");
const issueNodeId = createGitHubNodeId("I_replay");
const pullRequestNodeId = createGitHubNodeId("PR_replay");
const humanActor = {
  type: "human",
  nodeId: createGitHubNodeId("U_replay_human"),
  login: "human",
} satisfies GitHubAccountActor;
const botActor = {
  type: "bot",
  nodeId: createGitHubNodeId("B_replay_bot"),
  login: "bot[bot]",
} satisfies GitHubAccountActor;
const systemActor = {
  type: "system",
  name: "github",
} satisfies Actor;

type ReplayCurrentReviewRequest = Extract<
  ReplayCurrentItem,
  { type: "pull_request" }
>["reviewRequests"][number];

function withSequence<T extends NormalizedEvent>(
  event: T,
  sequence: number,
): T & { sequence: number } {
  return { ...event, sequence };
}

function createStateEvent(
  nodeId: GitHubNodeId,
  sourceName: string,
  state: Extract<NormalizedEvent, { kind: "state" }>["state"],
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
  sequence: number,
): ReplayEvent {
  if (state === "closed") {
    return withSequence(
      {
        kind: "state",
        sourceId: buildSourceId("github_timeline_event", sourceName),
        itemNodeId: nodeId,
        occurredAt,
        actor: systemActor,
        state,
        stateReason: "completed",
      },
      sequence,
    );
  }
  return withSequence(
    {
      kind: "state",
      sourceId: buildSourceId("github_timeline_event", sourceName),
      itemNodeId: nodeId,
      occurredAt,
      actor: systemActor,
      state,
    },
    sequence,
  );
}

function createIssue(
  overrides: Partial<Extract<ReplayCurrentItem, { type: "issue" }>> = {},
): Extract<ReplayCurrentItem, { type: "issue" }> {
  return {
    type: "issue",
    sourceId: buildSourceId("github_issue", "replay"),
    nodeId: issueNodeId,
    createdAt,
    observedAt,
    state: "open",
    closedAt: null,
    assignees: [],
    reviewRequests: [],
    ...overrides,
  };
}

function createPullRequest(
  overrides: Partial<Extract<ReplayCurrentItem, { type: "pull_request" }>> = {},
): Extract<ReplayCurrentItem, { type: "pull_request" }> {
  return {
    type: "pull_request",
    sourceId: buildSourceId("github_pull_request", "replay"),
    nodeId: pullRequestNodeId,
    createdAt,
    observedAt,
    state: "open",
    closedAt: null,
    mergedAt: null,
    draft: false,
    assignees: [],
    reviewRequests: [],
    ...overrides,
  };
}

function createAssigneeEvent(
  action: "added" | "removed",
  sourceName: string,
  assigneeNodeId: GitHubNodeId,
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
  sequence: number,
): ReplayEvent {
  return withSequence(
    {
      kind: "assignee",
      sourceId: buildSourceId("github_timeline_event", sourceName),
      itemNodeId: pullRequestNodeId,
      occurredAt,
      actor: humanActor,
      assignee: {
        type: "human",
        nodeId: assigneeNodeId,
        login: assigneeNodeId,
      },
      action,
    },
    sequence,
  );
}

function createReviewRequestEvent(
  action: "added" | "removed",
  sourceName: string,
  target: { type: "user" | "team"; nodeId: GitHubNodeId },
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
  sequence: number,
): ReplayEvent {
  return withSequence(
    {
      kind: "review_request",
      sourceId: buildSourceId("github_timeline_event", sourceName),
      itemNodeId: pullRequestNodeId,
      occurredAt,
      actor: humanActor,
      target,
      action,
    },
    sequence,
  );
}

describe("イベント再生", () => {
  it("Issueのclose、reopenをtracking.startAt前のイベントも含めて再生する", () => {
    const closedAt = createUtcIsoDateTime("2026-08-01T02:00:00Z");
    const reopenedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createIssue(),
      history: {
        availability: "available",
        events: [
          createStateEvent(issueNodeId, "reopen", "reopened", reopenedAt, 2),
          createStateEvent(issueNodeId, "close", "closed", closedAt, 1),
        ],
      },
    });

    expect(result.stateEpochs).toEqual({
      status: "known",
      value: [
        {
          occurredAt: createdAt,
          sourceIds: [buildSourceId("github_issue", "replay")],
          state: "open",
        },
        {
          occurredAt: closedAt,
          sourceIds: [buildSourceId("github_timeline_event", "close")],
          state: "closed",
        },
        {
          occurredAt: reopenedAt,
          sourceIds: [buildSourceId("github_timeline_event", "reopen")],
          state: "open",
        },
      ],
    });
    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: reopenedAt,
        sourceIds: [buildSourceId("github_timeline_event", "reopen")],
        state: "open",
      },
    });
  });

  it("tracking.startAtが観測時刻より後でも日時だけを検証して再生する", () => {
    const futureTrackingStartAt = createUtcIsoDateTime("2026-08-02T00:00:00Z");
    const result = replayItemHistory({
      trackingStartAt: futureTrackingStartAt,
      currentItem: createIssue(),
      history: { availability: "available", events: [] },
    });

    expect(result.trackingStartAt).toBe(futureTrackingStartAt);
    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: createdAt,
        sourceIds: [buildSourceId("github_issue", "replay")],
        state: "open",
      },
    });
  });

  it("Pull Requestのmergeとdraftの区間を再生する", () => {
    const convertedAt = createUtcIsoDateTime("2026-08-01T01:00:00Z");
    const readyAt = createUtcIsoDateTime("2026-08-01T02:00:00Z");
    const mergedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest({
        state: "merged",
        closedAt: mergedAt,
        mergedAt,
        draft: false,
      }),
      history: {
        availability: "available",
        events: [
          withSequence(
            {
              kind: "ready_for_review",
              sourceId: buildSourceId("github_timeline_event", "ready"),
              itemNodeId: pullRequestNodeId,
              occurredAt: readyAt,
              actor: systemActor,
            },
            3,
          ),
          withSequence(
            {
              kind: "converted_to_draft",
              sourceId: buildSourceId("github_timeline_event", "draft"),
              itemNodeId: pullRequestNodeId,
              occurredAt: convertedAt,
              actor: systemActor,
            },
            2,
          ),
          createStateEvent(pullRequestNodeId, "merge", "merged", mergedAt, 4),
          createStateEvent(pullRequestNodeId, "close", "closed", mergedAt, 5),
        ],
      },
    });

    expect(result.currentState).toBe("merged");
    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: mergedAt,
        sourceIds: [
          buildSourceId("github_timeline_event", "close"),
          buildSourceId("github_timeline_event", "merge"),
        ],
        state: "merged",
      },
    });
    expect(result.draftEpochs).toEqual({
      status: "known",
      value: [
        {
          occurredAt: createdAt,
          sourceIds: [buildSourceId("github_pull_request", "replay")],
          draft: false,
        },
        {
          occurredAt: convertedAt,
          sourceIds: [buildSourceId("github_timeline_event", "draft")],
          draft: true,
        },
        {
          occurredAt: readyAt,
          sourceIds: [buildSourceId("github_timeline_event", "ready")],
          draft: false,
        },
      ],
    });
  });

  it("assigneeとreview requestの変更からcurrent owner epochを復元する", () => {
    const assigneeNodeId = createGitHubNodeId("U_replay_assignee");
    const reviewerNodeId = createGitHubNodeId("U_replay_reviewer");
    const assignedAt = createUtcIsoDateTime("2026-08-01T01:00:00Z");
    const requestedAt = createUtcIsoDateTime("2026-08-01T02:00:00Z");
    const unassignedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const request: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "reviewer"),
      target: { type: "user", nodeId: reviewerNodeId },
      requestedAt: { status: "available", value: requestedAt },
    };
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest({
        reviewRequests: [request],
      }),
      history: {
        availability: "available",
        events: [
          createAssigneeEvent("removed", "unassign", assigneeNodeId, unassignedAt, 3),
          createReviewRequestEvent(
            "added",
            "request",
            { type: "user", nodeId: reviewerNodeId },
            requestedAt,
            2,
          ),
          createAssigneeEvent("added", "assign", assigneeNodeId, assignedAt, 1),
        ],
      },
    });

    expect(result.currentResponsibilities).toEqual([
      { kind: "review_request", target: "user", nodeId: reviewerNodeId },
    ]);
    expect(result.currentOwnerEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: unassignedAt,
        sourceIds: [buildSourceId("github_timeline_event", "unassign")],
        targets: [{ kind: "review_request", target: "user", nodeId: reviewerNodeId }],
      },
    });
  });

  it("現行review requestのrequestedAt取得不能を責務履歴だけunknownにする", () => {
    const reviewerNodeId = createGitHubNodeId("U_replay_history_unavailable_reviewer");
    const request: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "history-unavailable"),
      target: { type: "user", nodeId: reviewerNodeId },
      requestedAt: { status: "unavailable", reason: "history_unavailable" },
    };
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest({ reviewRequests: [request] }),
      history: { availability: "available", events: [] },
    });

    expect(result.currentResponsibilities).toEqual([
      { kind: "review_request", target: "user", nodeId: reviewerNodeId },
    ]);
    expect(result.stateEpochs.status).toBe("known");
    expect(result.responsibilityEpochs).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
    expect(result.currentOwnerEpoch).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
  });

  it("責務対象の不可能なaddedとremovedを例外にする", () => {
    const assigneeNodeId = createGitHubNodeId("U_replay_invalid_assignee");
    const addedAt = createUtcIsoDateTime("2026-08-01T01:00:00Z");
    const removedAt = createUtcIsoDateTime("2026-08-01T02:00:00Z");
    const added = createAssigneeEvent("added", "invalid-add", assigneeNodeId, addedAt, 1);
    const duplicateAdded = createAssigneeEvent(
      "added",
      "invalid-duplicate-add",
      assigneeNodeId,
      removedAt,
      2,
    );
    expect(() =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createPullRequest({ assignees: [{ ...humanActor, nodeId: assigneeNodeId }] }),
        history: { availability: "available", events: [added, duplicateAdded] },
      }),
    ).toThrow("既にactiveな責務対象をaddedできません");

    const removed = createAssigneeEvent("removed", "invalid-remove", assigneeNodeId, addedAt, 1);
    expect(() =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createPullRequest(),
        history: { availability: "available", events: [removed] },
      }),
    ).toThrow("activeでない責務対象をremovedできません");
  });

  it("現行review requestのsource IDまたは責務targetが重複していれば例外にする", () => {
    const reviewerNodeId = createGitHubNodeId("U_replay_duplicate_reviewer");
    const firstRequest: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "duplicate-first"),
      target: { type: "user", nodeId: reviewerNodeId },
      requestedAt: { status: "available", value: createdAt },
    };
    const secondRequest: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "duplicate-second"),
      target: { type: "user", nodeId: reviewerNodeId },
      requestedAt: { status: "available", value: createdAt },
    };
    expect(() =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createPullRequest({ reviewRequests: [firstRequest, secondRequest] }),
        history: { availability: "available", events: [] },
      }),
    ).toThrow("現行review requestの責務対象が重複しています");
  });

  it("同時刻はsequenceで並べ、コメント、review、commitを履歴へ保持する", () => {
    const sameTime = createUtcIsoDateTime("2026-08-01T05:00:00Z");
    const pushAt = createUtcIsoDateTime("2026-08-01T06:00:00Z");
    const reviewAt = createUtcIsoDateTime("2026-08-01T07:00:00Z");
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest(),
      history: {
        availability: "available",
        events: [
          withSequence(
            {
              kind: "review",
              sourceId: buildSourceId("github_pull_request_review", "bot"),
              itemNodeId: pullRequestNodeId,
              occurredAt: reviewAt,
              actor: botActor,
              state: "approved",
              bodyFingerprint: "sha256:bot",
              bodyEmpty: true,
              commitStatus: "unavailable",
            },
            4,
          ),
          withSequence(
            {
              kind: "push",
              sourceId: buildSourceId("github_commit", "head"),
              itemNodeId: pullRequestNodeId,
              occurredAt: pushAt,
              actor: systemActor,
              headCommitSha: "head",
              forcePush: false,
            },
            3,
          ),
          withSequence(
            {
              kind: "comment",
              sourceId: buildSourceId("github_comment", "comment"),
              itemNodeId: pullRequestNodeId,
              occurredAt: sameTime,
              actor: humanActor,
              bodyFingerprint: "sha256:comment",
              bodyEmpty: false,
            },
            2,
          ),
          withSequence(
            {
              kind: "review",
              sourceId: buildSourceId("github_pull_request_review", "human"),
              itemNodeId: pullRequestNodeId,
              occurredAt: reviewAt,
              actor: humanActor,
              state: "commented",
              bodyFingerprint: "sha256:human",
              bodyEmpty: false,
              commitStatus: "available",
              commitSha: "head",
            },
            1,
          ),
        ],
      },
    });

    expect(result.orderedEvents.map((event) => event.sourceId)).toEqual([
      buildSourceId("github_comment", "comment"),
      buildSourceId("github_commit", "head"),
      buildSourceId("github_pull_request_review", "human"),
      buildSourceId("github_pull_request_review", "bot"),
    ]);
  });

  it("同じsource IDの同一内容は1件にし、異なる内容は例外にする", () => {
    const sourceId = buildSourceId("github_comment", "duplicate");
    const first = withSequence(
      {
        kind: "comment",
        sourceId,
        itemNodeId: issueNodeId,
        occurredAt: createUtcIsoDateTime("2026-08-01T01:00:00Z"),
        actor: humanActor,
        bodyFingerprint: "sha256:same",
        bodyEmpty: false,
      },
      2,
    );
    const second = withSequence({ ...first, sequence: 1 }, 1);
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createIssue(),
      history: { availability: "available", events: [first, second] },
    });
    expect(result.orderedEvents).toHaveLength(1);
    expect(result.orderedEvents[0]?.sequence).toBe(1);

    const different = withSequence({ ...first, bodyFingerprint: "sha256:different" }, 3);
    expect(() =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createIssue(),
        history: { availability: "available", events: [first, different] },
      }),
    ).toThrow("同じsource IDに異なるイベント内容があります");
  });

  it("履歴取得不能と現行target取得不能をunknownで保持する", () => {
    const unavailableRequest: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "unavailable"),
      target: { status: "unavailable", reason: "actor_unavailable" },
      requestedAt: { status: "unavailable", reason: "history_unavailable" },
    };
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest({
        state: "closed",
        closedAt: observedAt,
        reviewRequests: [unavailableRequest],
      }),
      history: {
        availability: "unavailable",
        reason: "history_unavailable",
      },
    });

    expect(result.currentState).toBe("closed");
    expect(result.stateEpochs).toEqual({ status: "unknown", reason: "history_unavailable" });
    expect(result.currentOwnerEpoch).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
  });

  it("複数のunavailable review requestをsource ID単位で保持する", () => {
    const firstRequest: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "unavailable-first"),
      target: { status: "unavailable", reason: "actor_unavailable" },
      requestedAt: { status: "unavailable", reason: "history_unavailable" },
    };
    const secondRequest: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "unavailable-second"),
      target: { status: "unavailable", reason: "actor_unavailable" },
      requestedAt: { status: "unavailable", reason: "history_unavailable" },
    };
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest({ reviewRequests: [firstRequest, secondRequest] }),
      history: { availability: "available", events: [] },
    });

    expect(result.currentResponsibilities).toHaveLength(2);
    expect(result.currentOwnerEpoch).toEqual({
      status: "unknown",
      reason: "actor_unavailable",
    });
  });

  it("あり得ないstate遷移と現行値との矛盾を例外にする", () => {
    const reopenedAt = createUtcIsoDateTime("2026-08-01T01:00:00Z");
    expect(() =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createIssue(),
        history: {
          availability: "available",
          events: [createStateEvent(issueNodeId, "invalid-reopen", "reopened", reopenedAt, 1)],
        },
      }),
    ).toThrow("open状態からreopenできません");

    expect(() =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createIssue({ state: "closed", closedAt: observedAt }),
        history: {
          availability: "available",
          events: [],
        },
      }),
    ).toThrow("イベント再生結果と現行GitHub状態が一致しません");
  });
});

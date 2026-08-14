import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  replayItemHistory,
  ResponsibilityReplayMismatchError,
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

  it("IssueとPull Requestの重複ClosedEventをeventLogへ残し状態区間を増やさない", () => {
    const fixtureCreatedAt = createUtcIsoDateTime("2023-02-01T00:00:00Z");
    const fixtureObservedAt = createUtcIsoDateTime("2024-06-20T00:00:00Z");
    const fixtureTrackingStartAt = createUtcIsoDateTime("2023-02-01T00:00:00Z");
    const firstClosedAt = createUtcIsoDateTime("2023-02-07T22:43:09Z");
    const duplicateClosedAt = createUtcIsoDateTime("2023-02-07T22:48:28Z");
    const firstReopenedAt = createUtcIsoDateTime("2023-02-07T22:48:32Z");
    const secondClosedAt = createUtcIsoDateTime("2023-02-12T06:52:39Z");
    const secondReopenedAt = createUtcIsoDateTime("2024-06-19T16:02:26Z");
    const cases = [
      {
        nodeId: issueNodeId,
        currentItem: createIssue({
          createdAt: fixtureCreatedAt,
          observedAt: fixtureObservedAt,
        }),
      },
      {
        nodeId: pullRequestNodeId,
        currentItem: createPullRequest({
          createdAt: fixtureCreatedAt,
          observedAt: fixtureObservedAt,
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const firstClosed = createStateEvent(
        testCase.nodeId,
        "voicevox-engine-618-closed-1",
        "closed",
        firstClosedAt,
        1,
      );
      const duplicateClosed = createStateEvent(
        testCase.nodeId,
        "voicevox-engine-618-closed-2",
        "closed",
        duplicateClosedAt,
        2,
      );
      const firstReopened = createStateEvent(
        testCase.nodeId,
        "voicevox-engine-618-reopened-1",
        "reopened",
        firstReopenedAt,
        3,
      );
      const secondClosed = createStateEvent(
        testCase.nodeId,
        "voicevox-engine-618-closed-3",
        "closed",
        secondClosedAt,
        4,
      );
      const secondReopened = createStateEvent(
        testCase.nodeId,
        "voicevox-engine-618-reopened-2",
        "reopened",
        secondReopenedAt,
        5,
      );
      const result = replayItemHistory({
        trackingStartAt: fixtureTrackingStartAt,
        currentItem: testCase.currentItem,
        history: {
          availability: "available",
          events: [secondReopened, secondClosed, firstReopened, duplicateClosed, firstClosed],
        },
      });

      expect(result.stateEpochs).toEqual({
        status: "known",
        value: [
          {
            occurredAt: fixtureCreatedAt,
            sourceIds: [testCase.currentItem.sourceId],
            state: "open",
          },
          {
            occurredAt: firstClosedAt,
            sourceIds: [firstClosed.sourceId],
            state: "closed",
          },
          {
            occurredAt: firstReopenedAt,
            sourceIds: [firstReopened.sourceId],
            state: "open",
          },
          {
            occurredAt: secondClosedAt,
            sourceIds: [secondClosed.sourceId],
            state: "closed",
          },
          {
            occurredAt: secondReopenedAt,
            sourceIds: [secondReopened.sourceId],
            state: "open",
          },
        ],
      });
      expect(result.orderedEvents.map((event) => event.sourceId)).toEqual([
        firstClosed.sourceId,
        duplicateClosed.sourceId,
        firstReopened.sourceId,
        secondClosed.sourceId,
        secondReopened.sourceId,
      ]);
    }
  });

  it("Pull Requestのmergeと同時刻および後刻closeを状態変化なしで扱う", () => {
    const fixtureCreatedAt = createUtcIsoDateTime("2023-02-01T00:00:00Z");
    const mergedAt = createUtcIsoDateTime("2024-06-19T16:00:00Z");
    const laterClosedAt = createUtcIsoDateTime("2024-06-19T16:00:01Z");
    const fixtureObservedAt = createUtcIsoDateTime("2024-06-20T00:00:00Z");
    const merged = createStateEvent(
      pullRequestNodeId,
      "merge-after-close-merged",
      "merged",
      mergedAt,
      1,
    );
    const sameTimeClosed = createStateEvent(
      pullRequestNodeId,
      "merge-after-close-same-time-closed",
      "closed",
      mergedAt,
      2,
    );
    const currentItem = createPullRequest({
      createdAt: fixtureCreatedAt,
      observedAt: fixtureObservedAt,
      state: "merged",
      closedAt: mergedAt,
      mergedAt,
    });

    const result = replayItemHistory({
      trackingStartAt: fixtureCreatedAt,
      currentItem,
      history: {
        availability: "available",
        events: [sameTimeClosed, merged],
      },
    });
    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: mergedAt,
        sourceIds: [sameTimeClosed.sourceId, merged.sourceId].sort(),
        state: "merged",
      },
    });

    const laterClosed = createStateEvent(
      pullRequestNodeId,
      "merge-after-close-later-closed",
      "closed",
      laterClosedAt,
      3,
    );
    const laterResult = replayItemHistory({
      trackingStartAt: fixtureCreatedAt,
      currentItem,
      history: {
        availability: "available",
        events: [laterClosed, merged],
      },
    });
    expect(laterResult.orderedEvents.map((event) => event.sourceId)).toEqual([
      merged.sourceId,
      laterClosed.sourceId,
    ]);
    expect(laterResult.stateEpochs).toEqual({
      status: "known",
      value: [
        {
          occurredAt: fixtureCreatedAt,
          sourceIds: [currentItem.sourceId],
          state: "open",
        },
        {
          occurredAt: mergedAt,
          sourceIds: [merged.sourceId],
          state: "merged",
        },
      ],
    });
    expect(laterResult.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: mergedAt,
        sourceIds: [merged.sourceId],
        state: "merged",
      },
    });

    const reopenedAt = createUtcIsoDateTime("2024-06-19T16:00:02Z");
    const reopened = createStateEvent(
      pullRequestNodeId,
      "merge-after-close-reopened",
      "reopened",
      reopenedAt,
      4,
    );
    expect(() =>
      replayItemHistory({
        trackingStartAt: fixtureCreatedAt,
        currentItem,
        history: {
          availability: "available",
          events: [reopened, laterClosed, merged],
        },
      }),
    ).toThrow("open状態からreopenできません");

    const remerged = createStateEvent(
      pullRequestNodeId,
      "merge-after-close-remerged",
      "merged",
      reopenedAt,
      5,
    );
    expect(() =>
      replayItemHistory({
        trackingStartAt: fixtureCreatedAt,
        currentItem,
        history: {
          availability: "available",
          events: [remerged, laterClosed, merged],
        },
      }),
    ).toThrow("open状態以外をmergeできません");
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

  it("同時刻の責務イベントを一つのepochへ統合してsource IDを並べる", () => {
    const sameTime = createUtcIsoDateTime("2026-08-01T02:00:00Z");
    const assigneeNodeId = createGitHubNodeId("U_replay_same_time_assignee");
    const reviewerNodeId = createGitHubNodeId("U_replay_same_time_reviewer");
    const request: ReplayCurrentReviewRequest = {
      sourceId: buildSourceId("github_review_request", "same-time-reviewer"),
      target: { type: "user", nodeId: reviewerNodeId },
      requestedAt: { status: "available", value: sameTime },
    };
    const assigneeEvent = createAssigneeEvent(
      "added",
      "same-time-assignee",
      assigneeNodeId,
      sameTime,
      1,
    );
    const reviewRequestEvent = createReviewRequestEvent(
      "added",
      "same-time-review-request",
      { type: "user", nodeId: reviewerNodeId },
      sameTime,
      2,
    );
    const result = replayItemHistory({
      trackingStartAt,
      currentItem: createPullRequest({
        assignees: [{ ...humanActor, nodeId: assigneeNodeId }],
        reviewRequests: [request],
      }),
      history: {
        availability: "available",
        events: [reviewRequestEvent, assigneeEvent],
      },
    });

    expect(result.responsibilityEpochs.status).toBe("known");
    if (result.responsibilityEpochs.status !== "known") {
      throw new TypeError("責務履歴がknownではありません");
    }
    const sameTimeEpochs = result.responsibilityEpochs.value.filter(
      (epoch) => epoch.occurredAt === sameTime,
    );
    expect(sameTimeEpochs).toHaveLength(1);
    expect(sameTimeEpochs[0]).toEqual({
      occurredAt: sameTime,
      sourceIds: [assigneeEvent.sourceId, reviewRequestEvent.sourceId].sort(),
      targets: [
        { kind: "assignee", nodeId: assigneeNodeId },
        { kind: "review_request", target: "user", nodeId: reviewerNodeId },
      ],
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

  it("責務集合の不一致だけは対象node IDを持つ専用エラーにする", () => {
    const result = () =>
      replayItemHistory({
        trackingStartAt,
        currentItem: createIssue({
          assignees: [humanActor],
        }),
        history: {
          availability: "available",
          events: [],
        },
      });

    expect(result).toThrow(ResponsibilityReplayMismatchError);
    try {
      result();
      throw new TypeError("責務集合不一致のfixtureが例外を投げませんでした");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ResponsibilityReplayMismatchError);
      if (!(error instanceof ResponsibilityReplayMismatchError)) {
        throw error;
      }
      expect(error.itemNodeId).toBe(issueNodeId);
      expect(error.message).toBe("責務イベントの再生結果と現行GitHub状態が一致しません");
    }
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

import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubNodeId,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  createGitHubBodyFingerprint,
  type EnumeratedGitHubItem,
  type GitHubItemAuthor,
  type GitHubItemBodyLocator,
  type GitHubItemAccount,
} from "../src/github/item-enumeration.js";
import {
  replayGitHubItemHistory,
  type ReplayGitHubItemHistoryOptions,
} from "../src/github/item-history-replay-adapter.js";
import {
  type GitHubDetailAccount,
  type GitHubDetailActor,
  type GitHubCurrentReviewRequest,
  type GitHubItemDetail,
  type GitHubNativeDependencyCollection,
  type GitHubNativeHierarchyCollection,
  type GitHubTimelineEvent,
  type GitHubUserContentEditCollection,
} from "../src/github/item-detail-types.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";

const createdAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const observedAt = createUtcIsoDateTime("2026-08-01T12:00:00Z");
const trackingStartAt = createUtcIsoDateTime("2026-08-01T04:00:00Z");
const repositoryGlobalId = createGitHubRepositoryId("R_replay_adapter");
const repositoryId = createPublicRepositoryAllowlist([
  {
    id: repositoryGlobalId,
    owner: "VOICEVOX",
    name: "replay-adapter",
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt,
  },
]).require(repositoryGlobalId).id;
const issueNodeId = createGitHubNodeId("I_replay_adapter");
const pullRequestNodeId = createGitHubNodeId("PR_replay_adapter");

const humanAccount: GitHubItemAccount = Object.freeze({
  nodeId: createGitHubNodeId("U_replay_adapter_human"),
  login: "human",
  apiType: "User",
});
const reviewerAccount: GitHubItemAccount = Object.freeze({
  nodeId: createGitHubNodeId("U_replay_adapter_reviewer"),
  login: "reviewer",
  apiType: "User",
});
const identifiedActor: GitHubDetailActor = Object.freeze({
  status: "identified",
  account: Object.freeze({
    sourceId: buildSourceId("github_actor", humanAccount.nodeId),
    ...humanAccount,
  }),
});
const unavailableActor: GitHubDetailActor = Object.freeze({
  status: "unavailable",
  reason: "github_did_not_return_actor",
});
const displayReference = "VOICEVOX/replay-adapter#1" satisfies `${string}/${string}#${number}`;
const issueUrl =
  "https://github.com/VOICEVOX/replay-adapter/issues/1" satisfies `https://github.com/${string}`;
const pullRequestUrl =
  "https://github.com/VOICEVOX/replay-adapter/pull/1" satisfies `https://github.com/${string}`;
const availableEdits = {
  availability: "available",
  edits: [],
} satisfies GitHubUserContentEditCollection;
const availableDependencies = {
  availability: "available",
  relations: [],
} satisfies GitHubNativeDependencyCollection;
const availableHierarchy = {
  availability: "available",
  relations: [],
} satisfies GitHubNativeHierarchyCollection;
const itemAuthor = {
  kind: "account",
  account: humanAccount,
} satisfies GitHubItemAuthor;

function sourceId(kind: string, value: string): ReturnType<typeof buildSourceId> {
  return buildSourceId(kind, value);
}

function detailAccount(account: GitHubItemAccount): GitHubDetailAccount {
  return {
    sourceId: sourceId("github_actor", account.nodeId),
    ...account,
  };
}

function createItem(
  type: "issue" | "pull_request",
  state: "open" | "closed",
  options: Readonly<{
    nodeId: GitHubNodeId;
    assignees?: readonly GitHubItemAccount[];
    draft?: boolean;
    mergedAt?: UtcIsoDateTime;
    closedAt?: UtcIsoDateTime;
  }>,
): EnumeratedGitHubItem {
  const url = type === "issue" ? issueUrl : pullRequestUrl;
  const bodyLocator = {
    kind: "github_item_body",
    repositoryId,
    itemNodeId: options.nodeId,
    number: 1,
  } satisfies GitHubItemBodyLocator;
  const base = {
    nodeId: options.nodeId,
    repositoryId,
    displayReference,
    number: 1,
    url,
    title: "再生adapter fixture",
    bodyFingerprint: createGitHubBodyFingerprint("body"),
    bodyLocator,
    author: itemAuthor,
    createdAt,
    updatedAt: observedAt,
    assignees: options.assignees ?? [],
    labels: [],
    milestone: null,
    itemFingerprint: createGitHubBodyFingerprint("item"),
    observedAt,
  } satisfies Readonly<{
    displayReference: `${string}/${string}#${number}`;
    url: `https://github.com/${string}`;
    bodyLocator: GitHubItemBodyLocator;
  }> &
    Record<string, unknown>;
  if (type === "issue") {
    if (state === "open") {
      return Object.freeze({
        ...base,
        state: "open",
        stateReason: null,
        closedAt: null,
        type: "issue",
        draft: "not_applicable",
      } satisfies EnumeratedGitHubItem);
    }
    const closedAt = options.closedAt ?? observedAt;
    return Object.freeze({
      ...base,
      state: "closed",
      stateReason: "completed",
      closedAt,
      type: "issue",
      draft: "not_applicable",
    } satisfies EnumeratedGitHubItem);
  }
  if (options.mergedAt != null && state !== "closed") {
    throw new TypeError("merge済みfixtureにはclosed stateが必要です");
  }
  if (state === "open") {
    return Object.freeze({
      ...base,
      state: "open",
      stateReason: null,
      closedAt: null,
      type: "pull_request",
      draft: options.draft ?? false,
      mergeStatus: "not_merged",
    } satisfies EnumeratedGitHubItem);
  }
  const closedAt = options.closedAt ?? observedAt;
  if (options.mergedAt == null) {
    return Object.freeze({
      ...base,
      state: "closed",
      stateReason: "completed",
      closedAt,
      type: "pull_request",
      draft: options.draft ?? false,
      mergeStatus: "not_merged",
    } satisfies EnumeratedGitHubItem);
  }
  return Object.freeze({
    ...base,
    state: "closed",
    stateReason: "completed",
    closedAt,
    type: "pull_request",
    draft: options.draft ?? false,
    mergeStatus: "merged",
    mergedAt: options.mergedAt,
  } satisfies EnumeratedGitHubItem);
}

function createDetail(
  item: EnumeratedGitHubItem,
  timeline: readonly GitHubTimelineEvent[],
  currentReviewRequests: Extract<
    GitHubItemDetail,
    { type: "pull_request" }
  >["reviewRequests"]["current"],
): GitHubItemDetail {
  const common = {
    sourceId: sourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    bodySourceId: sourceId("github_item_body", item.nodeId),
    body: "本文",
    lastEditedAt: null,
    bodyUserContentEdits: availableEdits,
    comments: [],
    timeline,
    inboundCrossReferences: [],
    observedAt: item.observedAt,
  } satisfies Readonly<{
    bodyUserContentEdits: GitHubUserContentEditCollection;
  }> &
    Record<string, unknown>;
  if (item.type === "issue") {
    return Object.freeze({
      ...common,
      type: "issue",
      nativeDependencies: availableDependencies,
      nativeHierarchy: availableHierarchy,
    } satisfies GitHubItemDetail);
  }
  return Object.freeze({
    ...common,
    type: "pull_request",
    reviewDecision: null,
    reviews: [],
    reviewThreads: [],
    reviewRequests: {
      current: currentReviewRequests,
      history: timeline.filter(
        (
          event,
        ): event is Extract<
          GitHubTimelineEvent,
          { kind: "review_requested" | "review_request_removed" }
        > => event.kind === "review_requested" || event.kind === "review_request_removed",
      ),
    },
    nativeClosingIssues: [],
    headSha: "head",
    headCommit: {
      sourceId: sourceId("github_commit", item.nodeId),
      nodeId: createGitHubNodeId("C_replay_adapter"),
      sha: "head",
      committedAt: createdAt,
      pushedAt: { status: "unavailable", reason: "github_did_not_return_pushed_at" },
    },
    mergeState: {
      mergeability: "unknown",
      mergeState: "unknown",
      autoMerge: { status: "not_enabled" },
      mergeQueue: { status: "not_queued" },
      checks: { status: "not_configured" },
    },
  } satisfies GitHubItemDetail);
}

function createStateEvent(
  kind: "closed" | "reopened" | "merged",
  nodeId: GitHubNodeId,
  occurredAt: UtcIsoDateTime,
  sequence: number,
  actor: GitHubDetailActor = identifiedActor,
): GitHubTimelineEvent {
  return Object.freeze({
    sourceId: sourceId("github_timeline_event", `${nodeId}:${kind}:${sequence.toString()}`),
    nodeId: createGitHubNodeId(`TE_${nodeId}_${kind}_${sequence.toString()}`),
    sequence,
    occurredAt,
    actor,
    kind,
  } satisfies GitHubTimelineEvent);
}

function createReplayOptions(
  item: EnumeratedGitHubItem,
  detail: GitHubItemDetail,
): ReplayGitHubItemHistoryOptions {
  return {
    item,
    detail,
    trackingStartAt,
    isBot: () => false,
  };
}

describe("GitHub item history replay adapter", () => {
  it("現行値とtimelineのstate、draft、assignee、review requestをsequence付きで再生する", () => {
    const assignedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const convertedAt = createUtcIsoDateTime("2026-08-01T01:00:00Z");
    const readyAt = createUtcIsoDateTime("2026-08-01T02:00:00Z");
    const mergedAt = createUtcIsoDateTime("2026-08-01T04:00:00Z");
    const item = createItem("pull_request", "closed", {
      nodeId: pullRequestNodeId,
      assignees: [humanAccount],
      draft: false,
      mergedAt,
      closedAt: mergedAt,
    });
    const request = {
      sourceId: sourceId("github_review_request", "reviewer"),
      nodeId: createGitHubNodeId("RR_replay_adapter"),
      target: {
        type: "user",
        sourceId: sourceId("github_user", reviewerAccount.nodeId),
        nodeId: reviewerAccount.nodeId,
        login: reviewerAccount.login,
        apiType: reviewerAccount.apiType,
      },
      requestedAt: { status: "available", value: assignedAt },
    } satisfies GitHubCurrentReviewRequest;
    const detail = createDetail(
      item,
      [
        createStateEvent("merged", pullRequestNodeId, mergedAt, 6),
        {
          sourceId: sourceId("github_timeline_event", "ready"),
          nodeId: createGitHubNodeId("TE_ready"),
          sequence: 4,
          occurredAt: readyAt,
          actor: identifiedActor,
          kind: "ready_for_review",
        },
        {
          sourceId: sourceId("github_timeline_event", "request"),
          nodeId: createGitHubNodeId("TE_request"),
          sequence: 5,
          occurredAt: assignedAt,
          actor: identifiedActor,
          kind: "review_requested",
          target: request.target,
        },
        createStateEvent("closed", pullRequestNodeId, mergedAt, 7),
        {
          sourceId: sourceId("github_timeline_event", "assigned"),
          nodeId: createGitHubNodeId("TE_assigned"),
          sequence: 3,
          occurredAt: assignedAt,
          actor: identifiedActor,
          kind: "assigned",
          assignee: { type: "account", account: detailAccount(humanAccount) },
        },
        {
          sourceId: sourceId("github_timeline_event", "draft"),
          nodeId: createGitHubNodeId("TE_draft"),
          sequence: 2,
          occurredAt: convertedAt,
          actor: identifiedActor,
          kind: "converted_to_draft",
        },
      ],
      [request],
    );

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.orderedEvents.map((event) => [event.kind, event.sequence])).toEqual([
      ["converted_to_draft", 2],
      ["ready_for_review", 4],
      ["assignee", 3],
      ["review_request", 5],
      ["state", 6],
      ["state", 7],
    ]);
    expect(result.currentState).toBe("merged");
    expect(result.currentDraft).toEqual({ status: "known", value: false });
    expect(result.currentOwnerEpoch.status).toBe("known");
    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: mergedAt,
        sourceIds: [
          sourceId("github_timeline_event", `${pullRequestNodeId}:closed:7`),
          sourceId("github_timeline_event", `${pullRequestNodeId}:merged:6`),
        ],
        state: "merged",
      },
    });
  });

  it("項目作成時刻と観測時刻の境界を含むIssue履歴を扱う", () => {
    const item = createItem("issue", "closed", {
      nodeId: issueNodeId,
      closedAt: observedAt,
    });
    const detail = createDetail(item, [createStateEvent("closed", issueNodeId, observedAt, 0)], []);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: observedAt,
        sourceIds: [sourceId("github_timeline_event", `${issueNodeId}:closed:0`)],
        state: "closed",
      },
    });
  });

  it("現行terminal時刻とstate epochが一致しない場合はstate履歴だけunknownにする", () => {
    const item = createItem("pull_request", "closed", {
      nodeId: pullRequestNodeId,
      closedAt: observedAt,
      mergedAt: observedAt,
    });
    const detail = createDetail(
      item,
      [
        createStateEvent("merged", pullRequestNodeId, createdAt, 0),
        createStateEvent("closed", pullRequestNodeId, createdAt, 1),
      ],
      [],
    );

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentState).toBe("merged");
    expect(result.stateEpochs).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
    expect(result.currentStateEpoch).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
  });

  it("対象イベントのactor取得不能をsystemへ変換せずunknownへ渡す", () => {
    const item = createItem("issue", "closed", { nodeId: issueNodeId, closedAt: observedAt });
    const detail = createDetail(
      item,
      [createStateEvent("closed", issueNodeId, observedAt, 0, unavailableActor)],
      [],
    );

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.orderedEvents[0]?.actor).toEqual({
      status: "unavailable",
      reason: "actor_unavailable",
    });
    expect(result.stateEpochs.status).toBe("known");
  });

  it("現行review requestの対象取得不能を保持してowner epochをunknownにする", () => {
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const detail = createDetail(
      item,
      [
        {
          sourceId: sourceId("github_timeline_event", "unavailable-request"),
          nodeId: createGitHubNodeId("TE_unavailable_request"),
          sequence: 0,
          occurredAt: createdAt,
          actor: identifiedActor,
          kind: "review_requested",
          target: { status: "unavailable", reason: "github_did_not_return_actor" },
        },
      ],
      [
        {
          sourceId: sourceId("github_review_request", "unavailable"),
          nodeId: createGitHubNodeId("RR_unavailable"),
          target: { status: "unavailable", reason: "github_did_not_return_actor" },
          requestedAt: { status: "unavailable", reason: "timeline_event_not_found" },
        },
      ],
    );

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toContainEqual({
      kind: "review_request",
      status: "unavailable",
      reason: "actor_unavailable",
    });
    expect(result.currentOwnerEpoch).toEqual({
      status: "unknown",
      reason: "actor_unavailable",
    });
    expect(result.stateEpochs.status).toBe("known");
    expect(result.responsibilityEpochs).toEqual({
      status: "unknown",
      reason: "actor_unavailable",
    });
  });

  it("現行review requestのrequestedAt取得不能を責務履歴だけunknownにする", () => {
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const detail = createDetail(
      item,
      [],
      [
        {
          sourceId: sourceId("github_review_request", "history-unavailable"),
          nodeId: createGitHubNodeId("RR_history_unavailable"),
          target: {
            type: "user",
            sourceId: sourceId("github_user", reviewerAccount.nodeId),
            nodeId: reviewerAccount.nodeId,
            login: reviewerAccount.login,
            apiType: reviewerAccount.apiType,
          },
          requestedAt: { status: "unavailable", reason: "timeline_event_not_found" },
        },
      ],
    );

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toContainEqual({
      kind: "review_request",
      target: "user",
      nodeId: reviewerAccount.nodeId,
    });
    expect(result.stateEpochs.status).toBe("known");
    expect(result.currentOwnerEpoch).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
    expect(result.responsibilityEpochs).toEqual({
      status: "unknown",
      reason: "history_unavailable",
    });
  });

  it("timelineのassignee取得不能を責務履歴だけunknownにする", () => {
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const detail = createDetail(
      item,
      [
        {
          sourceId: sourceId("github_timeline_event", "unavailable-assignee"),
          nodeId: createGitHubNodeId("TE_unavailable_assignee"),
          sequence: 0,
          occurredAt: createdAt,
          actor: identifiedActor,
          kind: "assigned",
          assignee: unavailableActor,
        },
      ],
      [],
    );

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.stateEpochs.status).toBe("known");
    expect(result.draftEpochs).toMatchObject({ status: "known" });
    expect(result.responsibilityEpochs).toEqual({
      status: "unknown",
      reason: "actor_unavailable",
    });
  });

  it("現行観測値と再生結果が一致しない場合は例外にする", () => {
    const item = createItem("issue", "open", { nodeId: issueNodeId });
    const detail = createDetail(item, [createStateEvent("closed", issueNodeId, observedAt, 0)], []);

    expect(() => replayGitHubItemHistory(createReplayOptions(item, detail))).toThrow(
      "イベント再生結果と現行GitHub状態が一致しません",
    );
  });

  it("同じsource IDの同一イベントは再生器の規則で一件へ統合する", () => {
    const item = createItem("issue", "closed", { nodeId: issueNodeId, closedAt: observedAt });
    const event = createStateEvent("closed", issueNodeId, observedAt, 0);
    const detail = createDetail(item, [event, event], []);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.orderedEvents).toHaveLength(1);
  });
});

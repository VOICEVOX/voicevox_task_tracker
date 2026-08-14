import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  ResponsibilityReplayMismatchError,
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
  type GitHubPullRequestReview,
  type GitHubReviewRequestTarget,
  type GitHubTimelineEvent,
  type GitHubUserContentEditCollection,
} from "../src/github/item-detail-types.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";

const createdAt = createUtcIsoDateTime("2026-07-01T00:00:00Z");
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
const botAccount: GitHubItemAccount = Object.freeze({
  nodeId: createGitHubNodeId("BOT_kgDOCnlnWA"),
  login: "copilot-pull-request-reviewer",
  apiType: "Bot",
});
const identifiedActor: GitHubDetailActor = Object.freeze({
  status: "identified",
  account: Object.freeze({
    sourceId: buildSourceId("github_actor", humanAccount.nodeId),
    ...humanAccount,
  }),
});
const identifiedBotActor: GitHubDetailActor = Object.freeze({
  status: "identified",
  account: Object.freeze({
    sourceId: buildSourceId("github_actor", botAccount.nodeId),
    ...botAccount,
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
    createdAt?: UtcIsoDateTime;
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
    createdAt: options.createdAt ?? createdAt,
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

function withReviews(
  detail: GitHubItemDetail,
  reviews: readonly GitHubPullRequestReview[],
): GitHubItemDetail {
  if (detail.type !== "pull_request") {
    throw new TypeError("review fixtureにはPull Requestが必要です");
  }
  return Object.freeze({
    ...detail,
    reviews,
  });
}

function createReviewRequestEvent(
  target: GitHubReviewRequestTarget,
  occurredAt: UtcIsoDateTime,
  sequence: number,
  name: string,
): GitHubTimelineEvent {
  return Object.freeze({
    sourceId: sourceId("github_timeline_event", name),
    nodeId: createGitHubNodeId(`TE_${name}`),
    sequence,
    occurredAt,
    actor: identifiedActor,
    kind: "review_requested",
    target,
  } satisfies GitHubTimelineEvent);
}

function createReviewRequestRemovedEvent(
  target: GitHubReviewRequestTarget,
  occurredAt: UtcIsoDateTime,
  sequence: number,
  name: string,
): GitHubTimelineEvent {
  return Object.freeze({
    sourceId: sourceId("github_timeline_event", name),
    nodeId: createGitHubNodeId(`TE_${name}`),
    sequence,
    occurredAt,
    actor: identifiedActor,
    kind: "review_request_removed",
    target,
  } satisfies GitHubTimelineEvent);
}

function createCurrentReviewRequest(
  target: GitHubReviewRequestTarget,
  requestedAt: UtcIsoDateTime,
  name: string,
): GitHubCurrentReviewRequest {
  return Object.freeze({
    sourceId: sourceId("github_review_request", name),
    nodeId: createGitHubNodeId(`RR_${name}`),
    target,
    requestedAt: { status: "available", value: requestedAt },
  } satisfies GitHubCurrentReviewRequest);
}

function createReview(
  author: GitHubDetailActor,
  submittedAt: UtcIsoDateTime,
  state: GitHubPullRequestReview["state"],
  sequence: number,
  name: string,
): GitHubPullRequestReview {
  return Object.freeze({
    sourceId: sourceId("github_pull_request_review", name),
    nodeId: createGitHubNodeId(`PRR_${name}`),
    sequence,
    state,
    author,
    commit: { status: "unavailable", reason: "github_did_not_return_commit" },
    submittedAt,
    body: "review",
    url: pullRequestUrl,
  } satisfies GitHubPullRequestReview);
}

function createStateEvent(
  kind: "closed" | "reopened" | "merged",
  nodeId: GitHubNodeId,
  occurredAt: UtcIsoDateTime,
  sequence: number,
  actor: GitHubDetailActor,
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
        createStateEvent("merged", pullRequestNodeId, mergedAt, 6, identifiedActor),
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
        createStateEvent("closed", pullRequestNodeId, mergedAt, 7, identifiedActor),
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

  it("merged後の後刻ClosedEventを状態変化なしで再生する", () => {
    const fixtureCreatedAt = createUtcIsoDateTime("2026-06-20T00:00:00Z");
    const mergedAt = createUtcIsoDateTime("2026-06-21T01:57:42Z");
    const laterClosedAt = createUtcIsoDateTime("2026-06-21T01:57:43Z");
    const item = createItem("pull_request", "closed", {
      nodeId: pullRequestNodeId,
      createdAt: fixtureCreatedAt,
      mergedAt,
      closedAt: mergedAt,
    });
    const merged = createStateEvent("merged", pullRequestNodeId, mergedAt, 1, identifiedActor);
    const laterClosed = createStateEvent(
      "closed",
      pullRequestNodeId,
      laterClosedAt,
      2,
      identifiedActor,
    );

    const result = replayGitHubItemHistory(
      createReplayOptions(item, createDetail(item, [laterClosed, merged], [])),
    );

    expect(result.orderedEvents.map((event) => event.sourceId)).toEqual([
      merged.sourceId,
      laterClosed.sourceId,
    ]);
    expect(result.stateEpochs.status).toBe("known");
    if (result.stateEpochs.status !== "known") {
      throw new TypeError("状態epochが不明です");
    }
    expect(result.stateEpochs.value).toHaveLength(2);
    expect(result.stateEpochs.value.at(-1)).toEqual({
      occurredAt: mergedAt,
      sourceIds: [merged.sourceId],
      state: "merged",
    });
    expect(result.currentStateEpoch).toEqual({
      status: "known",
      value: {
        occurredAt: mergedAt,
        sourceIds: [merged.sourceId],
        state: "merged",
      },
    });
  });

  it("activeなUser review requestは同じUserの後続reviewで責務を閉じる", () => {
    const requestAt = createUtcIsoDateTime("2026-07-13T15:01:08Z");
    const reviewAt = createUtcIsoDateTime("2026-07-13T15:03:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", botAccount.nodeId),
      nodeId: botAccount.nodeId,
      login: botAccount.login,
      apiType: botAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "pr133-request");
    const review = createReview(identifiedBotActor, reviewAt, "commented", 0, "pr133-review");
    const detail = withReviews(createDetail(item, [request], []), [review]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([]);
    expect(result.orderedEvents.at(-1)).toMatchObject({
      kind: "review_request",
      sourceId: review.sourceId,
      action: "removed",
      target: { type: "user", nodeId: botAccount.nodeId },
    });
    expect(result.responsibilityEpochs.status).toBe("known");
    if (result.responsibilityEpochs.status !== "known") {
      throw new TypeError("責務履歴がknownではありません");
    }
    expect(result.responsibilityEpochs.value.at(-1)?.targets).toEqual([]);
  });

  it("Bot review requestにmatching reviewがない場合は不一致を維持する", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:03:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", botAccount.nodeId),
      nodeId: botAccount.nodeId,
      login: botAccount.login,
      apiType: botAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "bot-request-without-review");
    const detail = createDetail(item, [request], []);

    expect(() => replayGitHubItemHistory(createReplayOptions(item, detail))).toThrow(
      ResponsibilityReplayMismatchError,
    );
  });

  it("humanのreview requestも同じUserのreviewで責務を閉じる", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:03:36Z");
    const reviewAt = createUtcIsoDateTime("2026-08-01T05:04:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "human-request");
    const review = createReview(identifiedActor, reviewAt, "commented", 0, "human-review");
    const detail = withReviews(createDetail(item, [request], []), [review]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([]);
    expect(result.orderedEvents.at(-1)).toMatchObject({
      kind: "review_request",
      sourceId: review.sourceId,
      action: "removed",
      target: { type: "user", nodeId: humanAccount.nodeId },
    });
  });

  it("同時刻の合成removeと別Userの追加を一つの責務epochへ統合する", () => {
    const requestAAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const sameTime = createUtcIsoDateTime("2026-08-01T05:03:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const targetA = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const targetB = {
      type: "user",
      sourceId: sourceId("github_user", reviewerAccount.nodeId),
      nodeId: reviewerAccount.nodeId,
      login: reviewerAccount.login,
      apiType: reviewerAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const requestA = createReviewRequestEvent(targetA, requestAAt, 0, "same-time-a-request");
    const requestB = createReviewRequestEvent(targetB, sameTime, 1, "same-time-b-request");
    const reviewA = createReview(identifiedActor, sameTime, "commented", 0, "same-time-a-review");
    const currentRequestB = createCurrentReviewRequest(targetB, sameTime, "same-time-b-current");
    const detail = withReviews(createDetail(item, [requestA, requestB], [currentRequestB]), [
      reviewA,
    ]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([
      { kind: "review_request", target: "user", nodeId: reviewerAccount.nodeId },
    ]);
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
      sourceIds: [requestB.sourceId, reviewA.sourceId].sort(),
      targets: [{ kind: "review_request", target: "user", nodeId: reviewerAccount.nodeId }],
    });
  });

  it("同じUserのreview requestとreviewを交互に処理する", () => {
    const firstRequestAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const firstReviewAt = createUtcIsoDateTime("2026-08-01T05:03:36Z");
    const secondRequestAt = createUtcIsoDateTime("2026-08-01T05:05:36Z");
    const secondReviewAt = createUtcIsoDateTime("2026-08-01T05:07:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const firstRequest = createReviewRequestEvent(
      target,
      firstRequestAt,
      0,
      "interleaved-first-request",
    );
    const secondRequest = createReviewRequestEvent(
      target,
      secondRequestAt,
      1,
      "interleaved-second-request",
    );
    const detail = withReviews(createDetail(item, [firstRequest, secondRequest], []), [
      createReview(identifiedActor, firstReviewAt, "commented", 0, "interleaved-first-review"),
      createReview(identifiedActor, secondReviewAt, "commented", 1, "interleaved-second-review"),
    ]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([]);
    expect(result.orderedEvents.filter((event) => event.kind === "review_request")).toHaveLength(4);
  });

  it("review後の明示removeは合成removeを重ねない", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const reviewAt = createUtcIsoDateTime("2026-08-01T05:03:36Z");
    const removeAt = createUtcIsoDateTime("2026-08-01T05:05:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "explicit-after-review-request");
    const remove = createReviewRequestRemovedEvent(
      target,
      removeAt,
      1,
      "explicit-after-review-remove",
    );
    const review = createReview(identifiedActor, reviewAt, "approved", 0, "explicit-after-review");
    const detail = withReviews(createDetail(item, [request, remove], []), [review]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([]);
    expect(
      result.orderedEvents.filter(
        (event) => event.kind === "review_request" && event.action === "removed",
      ),
    ).toHaveLength(1);
    expect(result.orderedEvents.at(-1)?.sourceId).toBe(remove.sourceId);
  });

  it("明示remove後の再requestは後続reviewで閉じる", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const removeAt = createUtcIsoDateTime("2026-08-01T05:02:08Z");
    const secondRequestAt = createUtcIsoDateTime("2026-08-01T05:03:08Z");
    const reviewAt = createUtcIsoDateTime("2026-08-01T05:04:08Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "re-request-first");
    const remove = createReviewRequestRemovedEvent(target, removeAt, 1, "re-request-remove");
    const secondRequest = createReviewRequestEvent(target, secondRequestAt, 2, "re-request-second");
    const review = createReview(
      identifiedActor,
      reviewAt,
      "changes_requested",
      0,
      "re-request-review",
    );
    const detail = withReviews(createDetail(item, [request, remove, secondRequest], []), [review]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([]);
    expect(
      result.orderedEvents.filter(
        (event) => event.kind === "review_request" && event.action === "removed",
      ),
    ).toHaveLength(2);
    expect(result.orderedEvents.at(-1)?.sourceId).toBe(review.sourceId);
  });

  it("requestと同時刻のreviewは順序不明のため不一致にする", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "same-time-request");
    const review = createReview(identifiedActor, requestAt, "dismissed", 0, "same-time-review");
    const detail = withReviews(createDetail(item, [request], []), [review]);

    expect(() => replayGitHubItemHistory(createReplayOptions(item, detail))).toThrow(
      ResponsibilityReplayMismatchError,
    );
  });

  it("現行User requestが残る場合はmatching reviewがあっても合成removeを作らない", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const requestEvent = createReviewRequestEvent(target, requestAt, 0, "current-request-event");
    const currentRequest = createCurrentReviewRequest(target, requestAt, "current-request");
    const review = createReview(
      identifiedActor,
      createUtcIsoDateTime("2026-08-01T05:02:08Z"),
      "commented",
      0,
      "current-request-review",
    );
    const detail = withReviews(createDetail(item, [requestEvent], [currentRequest]), [review]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([
      { kind: "review_request", target: "user", nodeId: humanAccount.nodeId },
    ]);
    expect(
      result.orderedEvents.some(
        (event) =>
          event.kind === "review_request" &&
          event.sourceId === review.sourceId &&
          event.action === "removed",
      ),
    ).toBe(false);
  });

  it.each(["approved", "changes_requested", "commented", "dismissed"] satisfies readonly [
    "approved",
    "changes_requested",
    "commented",
    "dismissed",
  ])("%s reviewは提出済みreviewとして扱う", (state) => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:01:08Z");
    const reviewAt = createUtcIsoDateTime("2026-08-01T05:02:08Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "user",
      sourceId: sourceId("github_user", humanAccount.nodeId),
      nodeId: humanAccount.nodeId,
      login: humanAccount.login,
      apiType: humanAccount.apiType,
    } satisfies Extract<GitHubReviewRequestTarget, { type: "user" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, `review-state-${state}-request`);
    const review = createReview(identifiedActor, reviewAt, state, 0, `review-state-${state}`);
    const detail = withReviews(createDetail(item, [request], []), [review]);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.currentResponsibilities).toEqual([]);
  });

  it("Teamのreview requestはreviewがあっても不一致を維持する", () => {
    const requestAt = createUtcIsoDateTime("2026-08-01T05:03:36Z");
    const item = createItem("pull_request", "open", { nodeId: pullRequestNodeId });
    const target = {
      type: "team",
      sourceId: sourceId("github_team", "reviewers"),
      nodeId: createGitHubNodeId("T_replay_adapter_reviewers"),
      organizationLogin: "VOICEVOX",
      slug: "reviewers",
      name: "reviewers",
    } satisfies Extract<GitHubReviewRequestTarget, { type: "team" }>;
    const request = createReviewRequestEvent(target, requestAt, 0, "team-request");
    const review = createReview(identifiedActor, requestAt, "commented", 0, "team-review");
    const detail = withReviews(createDetail(item, [request], []), [review]);

    expect(() => replayGitHubItemHistory(createReplayOptions(item, detail))).toThrow(
      ResponsibilityReplayMismatchError,
    );
  });

  it("項目作成時刻と観測時刻の境界を含むIssue履歴を扱う", () => {
    const item = createItem("issue", "closed", {
      nodeId: issueNodeId,
      closedAt: observedAt,
    });
    const detail = createDetail(
      item,
      [createStateEvent("closed", issueNodeId, observedAt, 0, identifiedActor)],
      [],
    );

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
        createStateEvent("merged", pullRequestNodeId, createdAt, 0, identifiedActor),
        createStateEvent("closed", pullRequestNodeId, createdAt, 1, identifiedActor),
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
    const detail = createDetail(
      item,
      [createStateEvent("closed", issueNodeId, observedAt, 0, identifiedActor)],
      [],
    );

    expect(() => replayGitHubItemHistory(createReplayOptions(item, detail))).toThrow(
      "イベント再生結果と現行GitHub状態が一致しません",
    );
  });

  it("同じsource IDの同一イベントは再生器の規則で一件へ統合する", () => {
    const item = createItem("issue", "closed", { nodeId: issueNodeId, closedAt: observedAt });
    const event = createStateEvent("closed", issueNodeId, observedAt, 0, identifiedActor);
    const detail = createDetail(item, [event, event], []);

    const result = replayGitHubItemHistory(createReplayOptions(item, detail));

    expect(result.orderedEvents).toHaveLength(1);
  });
});

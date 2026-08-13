import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type ReplayItemHistoryResult,
  type GitHubItemUrl,
} from "../src/domain/index.js";
import {
  createGitHubItemCacheDocument,
  restoreGitHubItemCache,
} from "../src/github/item-cache-adapter.js";
import {
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubItem,
} from "../src/github/item-normalization.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";
import { parseSha256Hash } from "../src/persistence/canonical-json.js";

const repositoryId = createGitHubRepositoryId("R_ITEM_CACHE_ADAPTER");
const repository = {
  repositoryId,
  owner: "VOICEVOX",
  name: "item-cache-adapter",
};
const publicRepository = createPublicRepositoryAllowlist([
  {
    id: repositoryId,
    owner: repository.owner,
    name: repository.name,
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt: createUtcIsoDateTime("2026-01-01T00:00:00Z"),
  },
]).repositories[0];
if (publicRepository == null) {
  throw new Error("公開repository fixtureがありません");
}

const nodeId = createGitHubNodeId("I_ITEM_CACHE_ADAPTER");
const createdAt = createUtcIsoDateTime("2026-01-01T00:00:00Z");
const updatedAt = createUtcIsoDateTime("2026-01-02T00:00:00Z");
const observedAt = createUtcIsoDateTime("2026-01-05T00:00:00Z");
const terminalAt = createUtcIsoDateTime("2026-01-04T00:00:00Z");
const itemUrl: GitHubItemUrl = "https://github.com/VOICEVOX/item-cache-adapter/issues/1";
const targetUrl: GitHubItemUrl = "https://github.com/VOICEVOX/item-cache-adapter/issues/2";
const pullRequestUrl: GitHubItemUrl = "https://github.com/VOICEVOX/item-cache-adapter/pull/3";
const bodyFingerprint = parseSha256Hash(
  "sha256:1111111111111111111111111111111111111111111111111111111111111111",
);
const itemFingerprint = parseSha256Hash(
  "sha256:2222222222222222222222222222222222222222222222222222222222222222",
);
const analysisRulesFingerprint = parseSha256Hash(
  "sha256:3333333333333333333333333333333333333333333333333333333333333333",
);

const observation = {
  freshness: "fresh",
  sourceId: buildSourceId("github_item", "I_ITEM_CACHE_ADAPTER"),
  nodeId,
  repositoryId: publicRepository.id,
  displayReference: "VOICEVOX/item-cache-adapter#1",
  number: 1,
  url: itemUrl,
  title: "cache fixture",
  bodySourceId: buildSourceId("github_item_body", "I_ITEM_CACHE_ADAPTER"),
  bodyFingerprint,
  itemFingerprint,
  createdAt,
  githubUpdatedAt: updatedAt,
  state: "closed",
  stateReason: "completed",
  closedAt: terminalAt,
  author: {
    status: "unavailable",
    reason: "deleted_account",
  },
  assignees: [],
  labels: [],
  milestone: null,
  inboundCrossReferences: [],
  events: [
    {
      kind: "comment",
      sourceId: buildSourceId("github_comment", "comment-1"),
      itemNodeId: nodeId,
      occurredAt: updatedAt,
      actor: {
        type: "system",
        name: "github",
      },
      bodyFingerprint,
      bodyEmpty: false,
    },
  ],
  observedAt,
  type: "issue",
  draft: "not_applicable",
  nativeDependencies: {
    availability: "available",
    relations: [],
  },
  nativeHierarchy: {
    availability: "available",
    relations: [],
  },
} satisfies FreshObservedGitHubIssue;

const replay = {
  trackingStartAt: createdAt,
  orderedEvents: [],
  currentState: "closed",
  currentDraft: { status: "not_applicable" },
  currentResponsibilities: [],
  stateEpochs: {
    status: "known",
    value: [
      {
        occurredAt: createdAt,
        sourceIds: [buildSourceId("github_item", "I_ITEM_CACHE_ADAPTER")],
        state: "open",
      },
      {
        occurredAt: terminalAt,
        sourceIds: [buildSourceId("github_event", "item-closed")],
        state: "closed",
      },
    ],
  },
  currentStateEpoch: {
    status: "known",
    value: {
      occurredAt: terminalAt,
      sourceIds: [buildSourceId("github_event", "item-closed")],
      state: "closed",
    },
  },
  draftEpochs: { status: "not_applicable" },
  currentDraftEpoch: { status: "not_applicable" },
  responsibilityEpochs: {
    status: "known",
    value: [
      {
        occurredAt: createdAt,
        sourceIds: [buildSourceId("github_item", "I_ITEM_CACHE_ADAPTER")],
        targets: [],
      },
    ],
  },
  currentOwnerEpoch: {
    status: "known",
    value: {
      occurredAt: createdAt,
      sourceIds: [buildSourceId("github_item", "I_ITEM_CACHE_ADAPTER")],
      targets: [],
    },
  },
} satisfies ReplayItemHistoryResult;

type FreshObservedGitHubPullRequest = Extract<FreshObservedGitHubItem, { type: "pull_request" }>;
type FreshConfiguredChecks = Extract<
  FreshObservedGitHubPullRequest["mergeState"]["checks"],
  { status: "configured" }
>;

const pullRequestCheckRunContext: FreshConfiguredChecks["contexts"][number] = {
  type: "check_run",
  nodeId: createGitHubNodeId("C_CHECK_RUN_ITEM_CACHE_ADAPTER"),
  name: "test",
  sourceId: buildSourceId("github_check_run", "check-run-1"),
  status: "completed",
  conclusion: "success",
  completedAt: observedAt,
};
const pullRequestCommitStatusContext: FreshConfiguredChecks["contexts"][number] = {
  type: "commit_status",
  nodeId: createGitHubNodeId("C_COMMIT_STATUS_ITEM_CACHE_ADAPTER"),
  context: "ci",
  sourceId: buildSourceId("github_commit_status", "commit-status-1"),
  state: "success",
  createdAt: updatedAt,
};
const pullRequestCheckContexts: FreshConfiguredChecks["contexts"] = [
  pullRequestCheckRunContext,
  pullRequestCommitStatusContext,
];

const pullRequestObservation = {
  ...observation,
  sourceId: buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER"),
  number: 3,
  url: pullRequestUrl,
  displayReference: "VOICEVOX/item-cache-adapter#3",
  state: "closed",
  stateReason: "completed",
  closedAt: terminalAt,
  type: "pull_request",
  draft: false,
  headSha: "abcdef1234567890",
  headCommit: {
    sourceId: buildSourceId("github_commit", "abcdef1234567890"),
    nodeId: createGitHubNodeId("C_ITEM_CACHE_ADAPTER"),
    sha: "abcdef1234567890",
    committedAt: updatedAt,
    pushedAt: {
      status: "unavailable",
      reason: "github_did_not_return_pushed_at",
    },
  },
  reviewThreads: [],
  reviewRequests: [],
  mergeState: {
    mergeability: "mergeable",
    mergeState: "clean",
    autoMerge: {
      status: "not_enabled",
    },
    mergeQueue: {
      status: "not_queued",
    },
    checks: {
      status: "configured",
      sourceId: buildSourceId("github_checks", "P_ITEM_CACHE_ADAPTER"),
      nodeId: createGitHubNodeId("C_CHECKS_ITEM_CACHE_ADAPTER"),
      combinedState: "success",
      contexts: pullRequestCheckContexts,
    },
  },
} satisfies FreshObservedGitHubPullRequest;

function createReviewRequestFixture(
  index: number,
): FreshObservedGitHubPullRequest["reviewRequests"][number] {
  const suffix = index.toString().padStart(3, "0");
  const actorNodeId = createGitHubNodeId(`U_REVIEW_REQUEST_${suffix}`);
  return {
    sourceId: buildSourceId("github_review_request", `request-${suffix}`),
    nodeId: createGitHubNodeId(`RR_REVIEW_REQUEST_${suffix}`),
    target: {
      type: "user",
      actor: {
        type: "human",
        nodeId: actorNodeId,
        login: `reviewer-${suffix}`,
      },
    },
    requestedAt: {
      status: "available",
      value: updatedAt,
    },
  };
}

function createReviewThreadFixture(
  index: number,
): FreshObservedGitHubPullRequest["reviewThreads"][number] {
  const suffix = index.toString().padStart(3, "0");
  return {
    sourceId: buildSourceId("github_review_thread", `thread-${suffix}`),
    nodeId: createGitHubNodeId(`T_REVIEW_THREAD_${suffix}`),
    isResolved: false,
    isOutdated: false,
    path: `src/review-${suffix}.ts`,
    resolvedBy: {
      status: "unavailable",
      reason: "github_did_not_return_actor",
    },
    commentSourceIds:
      index === 0
        ? Array.from({ length: 101 }, (_, commentIndex) =>
            buildSourceId(
              "github_review_comment",
              `comment-${commentIndex.toString().padStart(3, "0")}`,
            ),
          )
        : [],
  };
}

const manyReviewRequests = Array.from({ length: 101 }, (_, index) =>
  createReviewRequestFixture(index),
);
const manyReviewThreads = Array.from({ length: 101 }, (_, index) =>
  createReviewThreadFixture(index),
);
const manyReviewRequestTargets: ReplayItemHistoryResult["currentResponsibilities"] =
  manyReviewRequests.map((request) => {
    if (request.target.type !== "user") {
      throw new Error("review request fixtureがuserではありません");
    }
    return {
      kind: "review_request",
      target: "user",
      nodeId: request.target.actor.nodeId,
    };
  });
const manyPullRequestObservation: FreshObservedGitHubPullRequest = {
  ...pullRequestObservation,
  reviewRequests: manyReviewRequests,
  reviewThreads: manyReviewThreads,
};

const pullRequestReplay: ReplayItemHistoryResult = {
  ...replay,
  currentState: "merged",
  currentDraft: {
    status: "known",
    value: false,
  },
  stateEpochs: {
    status: "known",
    value: [
      {
        occurredAt: createdAt,
        sourceIds: [buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER")],
        state: "open",
      },
      {
        occurredAt: terminalAt,
        sourceIds: [buildSourceId("github_event", "pull-request-merged")],
        state: "merged",
      },
    ],
  },
  currentStateEpoch: {
    status: "known",
    value: {
      occurredAt: terminalAt,
      sourceIds: [buildSourceId("github_event", "pull-request-merged")],
      state: "merged",
    },
  },
  draftEpochs: {
    status: "known",
    value: [
      {
        occurredAt: createdAt,
        sourceIds: [buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER")],
        draft: false,
      },
    ],
  },
  currentDraftEpoch: {
    status: "known",
    value: {
      occurredAt: createdAt,
      sourceIds: [buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER")],
      draft: false,
    },
  },
  responsibilityEpochs: {
    status: "known",
    value: [
      {
        occurredAt: createdAt,
        sourceIds: [buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER")],
        targets: [],
      },
    ],
  },
  currentOwnerEpoch: {
    status: "known",
    value: {
      occurredAt: createdAt,
      sourceIds: [buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER")],
      targets: [],
    },
  },
};

function createDocument() {
  return createGitHubItemCacheDocument({
    repository,
    observation,
    state: "closed",
    draftState: "not_applicable",
    analysisRulesFingerprint,
    deterministicRulesVersion: "issue-v1",
    lifecycle: {
      kind: "terminal",
      terminalAt,
      expiresAt: createUtcIsoDateTime("2026-07-03T00:00:00Z"),
    },
    relationCandidates: [
      {
        id: "rel:fixture",
        sourceIds: [buildSourceId("relation", "fixture")],
        authority: "inferred",
        provenance: "explicit_text",
        relation: {
          type: "unclassified",
          referencing: {
            scope: "organization",
            kind: "issue",
            nodeId,
            repositoryOwner: repository.owner,
            repositoryName: repository.name,
            number: 1,
            url: itemUrl,
            state: "closed",
          },
          referenced: {
            scope: "organization",
            kind: "issue",
            nodeId: createGitHubNodeId("I_ITEM_CACHE_ADAPTER_TARGET"),
            repositoryOwner: repository.owner,
            repositoryName: repository.name,
            number: 2,
            url: targetUrl,
            state: "open",
          },
        },
      },
    ],
    relationMutations: [],
    replay,
    history: {
      status: "complete",
      events: [],
    },
    aiCacheReference: {
      status: "unavailable",
    },
  });
}

describe("GitHub item cache adapter", () => {
  it("安全な観測値、relation候補、replayを作成して同じ入力から復元する", () => {
    const document = createDocument();
    const restored = restoreGitHubItemCache(document, {
      mode: "fresh",
      bodyFingerprint,
      itemFingerprint,
      analysisRulesFingerprint,
    });

    expect(restored).toEqual({
      status: "hit",
      freshness: "fresh",
      document,
    });
    expect(Object.hasOwn(document, "body")).toBe(false);
    expect(JSON.stringify(document)).not.toContain('"diff"');
    expect(JSON.stringify(document)).not.toContain("cache fixtureのraw本文");
  });

  it("current fingerprintが変われば明示的なcache missにする", () => {
    const result = restoreGitHubItemCache(createDocument(), {
      mode: "fresh",
      bodyFingerprint,
      itemFingerprint: parseSha256Hash(
        "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      ),
      analysisRulesFingerprint,
    });

    expect(result).toEqual({
      status: "cache_miss",
      reason: "current_fingerprint_mismatch",
    });
  });

  it("GitHub取得失敗時は観測時刻以後ならstaleとして復元する", () => {
    const failedAt = createUtcIsoDateTime("2026-01-05T00:00:00Z");
    const result = restoreGitHubItemCache(createDocument(), {
      mode: "stale",
      failedAt,
    });

    expect(result).toMatchObject({
      status: "hit",
      freshness: "stale",
      failedAt,
    });
  });

  it("stale復元の失敗時刻が観測時刻より前なら拒否する", () => {
    expect(() =>
      restoreGitHubItemCache(createDocument(), {
        mode: "stale",
        failedAt: createUtcIsoDateTime("2026-01-02T23:59:59Z"),
      }),
    ).toThrow("失敗時刻は観測時刻以後");
  });

  it("Pull Requestのreview、merge、check観測値をraw本文なしで保存する", () => {
    const document = createGitHubItemCacheDocument({
      repository,
      observation: pullRequestObservation,
      state: "merged",
      draftState: "ready_for_review",
      analysisRulesFingerprint,
      deterministicRulesVersion: "pull-request-v1",
      lifecycle: {
        kind: "terminal",
        terminalAt,
        expiresAt: createUtcIsoDateTime("2026-07-03T00:00:00Z"),
      },
      relationCandidates: [],
      relationMutations: [],
      replay: pullRequestReplay,
      history: {
        status: "complete",
        events: [],
      },
      aiCacheReference: {
        status: "unavailable",
      },
    });

    expect(document.currentObservation.type).toBe("pull_request");
    if (document.currentObservation.type !== "pull_request") {
      throw new Error("Pull Request観測値ではありません");
    }
    expect(document.currentObservation.mergeState.checks).toMatchObject({
      status: "configured",
      contexts: [{ type: "check_run" }, { type: "commit_status" }],
    });
  });

  it("完全paginationされた101件のreview request、thread、comment IDを保存する", () => {
    type ReplayResponsibilityEpoch = Extract<
      ReplayItemHistoryResult["responsibilityEpochs"],
      { status: "known" }
    >["value"][number];
    const responsibilityEpoch: ReplayResponsibilityEpoch = {
      occurredAt: createdAt,
      sourceIds: [buildSourceId("github_item", "P_ITEM_CACHE_ADAPTER")],
      targets: manyReviewRequestTargets,
    };
    const document = createGitHubItemCacheDocument({
      repository,
      observation: manyPullRequestObservation,
      state: "merged",
      draftState: "ready_for_review",
      analysisRulesFingerprint,
      deterministicRulesVersion: "pull-request-v1",
      lifecycle: {
        kind: "terminal",
        terminalAt,
        expiresAt: createUtcIsoDateTime("2026-07-03T00:00:00Z"),
      },
      relationCandidates: [],
      relationMutations: [],
      replay: {
        ...pullRequestReplay,
        currentResponsibilities: manyReviewRequestTargets,
        responsibilityEpochs: {
          status: "known",
          value: [responsibilityEpoch],
        },
        currentOwnerEpoch: {
          status: "known",
          value: responsibilityEpoch,
        },
      },
      history: {
        status: "complete",
        events: [],
      },
      aiCacheReference: {
        status: "unavailable",
      },
    });

    if (document.currentObservation.type !== "pull_request") {
      throw new Error("Pull Request観測値ではありません");
    }
    expect(document.currentObservation.reviewRequests).toHaveLength(101);
    expect(document.currentObservation.reviewThreads).toHaveLength(101);
    expect(document.currentObservation.reviewThreads[0]?.commentSourceIds).toHaveLength(101);
  });
});

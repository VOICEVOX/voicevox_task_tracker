import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type ReplayItemHistoryResult,
  type SourceId,
} from "../src/domain/index.js";
import {
  adaptCachedTemporalBlocksGraph,
  adaptFreshTemporalBlocksGraph,
} from "../src/github/temporal-blocks-graph-adapter.js";
import {
  type GitHubDetailActor,
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubReferencedItem,
  type GitHubUserContentEdit,
  type GitHubUserContentEditCollection,
} from "../src/github/item-detail-types.js";
import { createGitHubItemCacheDocument } from "../src/github/item-cache-adapter.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";
import { parseSha256Hash } from "../src/persistence/canonical-json.js";
import { type FreshObservedGitHubIssue } from "../src/github/item-normalization.js";
import {
  type CacheTemporalEvent,
  type GitHubItemCacheDocument,
} from "../src/persistence/cache-documents.js";
import {
  adaptGitHubRelationMutationSource,
  type GitHubRelationMutationSourceResult,
} from "../src/github/relation-mutation-adapter.js";
import { type RelationCandidate } from "../src/graph/relation-candidate-types.js";

const createdAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const observedAt = createUtcIsoDateTime("2026-08-01T12:00:00Z");
const dependencyAt = createUtcIsoDateTime("2026-08-01T02:00:00Z");
const repositoryGlobalId = createGitHubRepositoryId("R_temporal_blocks_adapter");
const repository = createPublicRepositoryAllowlist([
  {
    id: repositoryGlobalId,
    owner: "VOICEVOX",
    name: "temporal-blocks-adapter",
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt,
  },
]).require(repositoryGlobalId);
const blockerNodeId = createGitHubNodeId("I_temporal_blocks_blocker");
const blockedNodeId = createGitHubNodeId("I_temporal_blocks_blocked");
const pullRequestNodeId = createGitHubNodeId("PR_temporal_blocks");
const unavailableActor = {
  status: "unavailable",
  reason: "github_did_not_return_actor",
} satisfies GitHubDetailActor;
const availableEmptyEdits = {
  availability: "available",
  edits: [],
} satisfies GitHubUserContentEditCollection;
const blockedBySourceId = buildSourceId("github_timeline_event", "blocked-by");

function sourceId(kind: string, value: string): SourceId {
  return buildSourceId(kind, value);
}

function createReplay(
  nodeId: ReturnType<typeof createGitHubNodeId>,
  type: "issue" | "pull_request",
): ReplayItemHistoryResult {
  const itemSourceId = sourceId("github_item", nodeId);
  const itemSourceIds: readonly [SourceId] = [itemSourceId];
  const stateEpoch = {
    occurredAt: createdAt,
    sourceIds: itemSourceIds,
    state: "open" as const,
  };
  const responsibilityEpoch = {
    occurredAt: createdAt,
    sourceIds: itemSourceIds,
    targets: [],
  };
  return {
    trackingStartAt: createdAt,
    orderedEvents: [],
    currentState: "open",
    currentDraft:
      type === "issue" ? { status: "not_applicable" } : { status: "known", value: false },
    currentResponsibilities: [],
    stateEpochs: { status: "known", value: [stateEpoch] },
    currentStateEpoch: { status: "known", value: stateEpoch },
    draftEpochs:
      type === "issue"
        ? { status: "not_applicable" }
        : {
            status: "known",
            value: [{ occurredAt: createdAt, sourceIds: itemSourceIds, draft: false }],
          },
    currentDraftEpoch:
      type === "issue"
        ? { status: "not_applicable" }
        : {
            status: "known",
            value: { occurredAt: createdAt, sourceIds: itemSourceIds, draft: false },
          },
    responsibilityEpochs: { status: "known", value: [responsibilityEpoch] },
    currentOwnerEpoch: { status: "known", value: responsibilityEpoch },
  } satisfies ReplayItemHistoryResult;
}

function createReferencedItem(
  nodeId: ReturnType<typeof createGitHubNodeId>,
  number: number,
): GitHubReferencedItem {
  return {
    sourceId: sourceId("github_item", nodeId),
    nodeId,
    repositoryId: repositoryGlobalId,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: "issue",
    number,
    url: `https://github.com/${repository.owner}/${repository.name}/issues/${number.toString()}`,
    createdAt,
    state: "open",
  };
}

function createIssueDetail(
  nodeId: ReturnType<typeof createGitHubNodeId>,
  options: Readonly<{
    body: string;
    bodyUserContentEdits: GitHubUserContentEditCollection;
    timeline?: GitHubItemDetail["timeline"];
    comments?: readonly GitHubIssueComment[];
  }>,
): Extract<GitHubItemDetail, { type: "issue" }> {
  return {
    sourceId: sourceId("github_item_detail", nodeId),
    nodeId,
    repositoryId: repository.id,
    number: nodeId === blockedNodeId ? 2 : 1,
    bodySourceId: sourceId("github_item_body", nodeId),
    body: options.body,
    lastEditedAt: null,
    bodyUserContentEdits: options.bodyUserContentEdits,
    comments: options.comments ?? [],
    timeline: options.timeline ?? [],
    inboundCrossReferences: [],
    observedAt,
    type: "issue",
    nativeDependencies: { availability: "available", relations: [] },
    nativeHierarchy: { availability: "available", relations: [] },
  };
}

function createCurrentGraph(
  nodes: readonly ReturnType<typeof createGitHubNodeId>[],
  canonicalBlocksEdges: readonly Readonly<{
    fromNodeId: ReturnType<typeof createGitHubNodeId>;
    toNodeId: ReturnType<typeof createGitHubNodeId>;
  }>[],
) {
  return {
    nodes: nodes.map((nodeId) => ({ nodeId, state: "open" as const })),
    canonicalBlocksEdges,
  };
}

function createEdit(
  value: Readonly<{
    id: string;
    sequence: number;
    editedAt: ReturnType<typeof createUtcIsoDateTime>;
    diff: string;
  }>,
): GitHubUserContentEdit {
  return {
    sourceId: sourceId("github_user_content_edit", value.id),
    sequence: value.sequence,
    createdAt,
    deletedAt: null,
    diff: value.diff,
    editedAt: value.editedAt,
    editor: unavailableActor,
    updatedAt: value.editedAt,
  };
}

function createIssueComment(
  nodeId: ReturnType<typeof createGitHubNodeId>,
  body: string,
  userContentEdits: GitHubUserContentEditCollection,
): GitHubIssueComment {
  return {
    sourceId: sourceId("github_issue_comment", nodeId),
    nodeId,
    sequence: 0,
    author: unavailableActor,
    body,
    createdAt,
    lastEditedAt: null,
    updatedAt: observedAt,
    url: `https://github.com/${repository.owner}/${repository.name}/issues/2#issuecomment-1`,
    userContentEdits,
  };
}

function createBlocksCandidate(): RelationCandidate {
  const candidateSourceIds: readonly [SourceId] = [
    sourceId("github_native_dependency", "temporal-blocks"),
  ];
  return {
    id: "rel:temporal-blocks",
    sourceIds: candidateSourceIds,
    authority: "authoritative",
    provenance: "native",
    relation: {
      type: "blocks",
      blocker: {
        scope: "organization",
        kind: "issue",
        nodeId: blockerNodeId,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        number: 1,
        url: `https://github.com/${repository.owner}/${repository.name}/issues/1`,
        state: "open",
      },
      blocked: {
        scope: "organization",
        kind: "issue",
        nodeId: blockedNodeId,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        number: 2,
        url: `https://github.com/${repository.owner}/${repository.name}/issues/2`,
        state: "open",
      },
    },
  };
}

function createObservation(): FreshObservedGitHubIssue {
  const bodyFingerprint = parseSha256Hash(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  );
  const itemFingerprint = parseSha256Hash(
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  );
  return {
    freshness: "fresh",
    sourceId: sourceId("github_item", blockedNodeId),
    nodeId: blockedNodeId,
    createdAt,
    author: { status: "unavailable", reason: "deleted_account" },
    assignees: [],
    events: [],
    observedAt,
    state: "open",
    stateReason: null,
    closedAt: null,
    type: "issue",
    repositoryId: repository.id,
    displayReference: `${repository.owner}/${repository.name}#2`,
    number: 2,
    url: `https://github.com/${repository.owner}/${repository.name}/issues/2`,
    title: "temporal blocks fixture",
    bodySourceId: sourceId("github_item_body", blockedNodeId),
    bodyFingerprint,
    itemFingerprint,
    githubUpdatedAt: observedAt,
    labels: [],
    milestone: null,
    inboundCrossReferences: [],
    draft: "not_applicable",
    nativeDependencies: { availability: "available", relations: [] },
    nativeHierarchy: { availability: "available", relations: [] },
  };
}

function createCacheDocument(
  relationCandidates: readonly RelationCandidate[],
  relationMutations: readonly GitHubRelationMutationSourceResult[],
  historyEvents: readonly CacheTemporalEvent[],
): GitHubItemCacheDocument {
  const observation = createObservation();
  const replay = createReplay(blockedNodeId, "issue");
  return createGitHubItemCacheDocument({
    repository: {
      repositoryId: repositoryGlobalId,
      owner: repository.owner,
      name: repository.name,
    },
    observation,
    state: "open",
    draftState: "not_applicable",
    analysisRulesFingerprint: observation.itemFingerprint,
    deterministicRulesVersion: "issue-v1",
    aiAnalysisStatus: "not_required",
    lifecycle: { kind: "open" },
    relationCandidates,
    relationMutations: relationMutations.map((result) => result.result),
    replay,
    history: {
      status: "complete",
      events: [...historyEvents],
    },
    analysisFacts: {
      bodyEmpty: true,
      explicitRequestCandidates: [],
      mentionedWaitingOnCandidates: [],
      inputEvents: [],
      codexValidationContext: {
        schemaVersion: "1",
        purpose: "semantic_validation_only",
        now: observedAt,
        item: {
          nodeId: blockedNodeId,
          url: observation.url,
          type: "issue",
        },
        candidates: { waitingOn: [], relations: [] },
        sources: [
          {
            id: observation.sourceId,
            kind: "item",
            actorType: "system",
            createdAt,
          },
          {
            id: observation.bodySourceId,
            kind: "body",
            actorType: "system",
            createdAt,
          },
        ],
        nativeRelationConstraints: [],
      },
    },
    aiCacheReference: { status: "unavailable" },
  });
}

describe("GitHub temporal blocks graph adapter", () => {
  it("fresh detailとrawを含まないcacheでnative dependency入力を同値にする", () => {
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [
        {
          sourceId: blockedBySourceId,
          nodeId: createGitHubNodeId("TE_temporal_blocks_dependency"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocked_by_added",
          blockingIssue: createReferencedItem(blockerNodeId, 1),
        },
      ],
    });
    const current = createCurrentGraph(
      [blockerNodeId, blockedNodeId],
      [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
    );
    const fresh = adaptFreshTemporalBlocksGraph({
      current,
      relationCandidates: [],
      items: [{ detail, itemCreatedAt: createdAt, replay: createReplay(blockedNodeId, "issue") }],
    });
    const cached = adaptCachedTemporalBlocksGraph({
      current,
      documents: [
        createCacheDocument(
          [],
          [],
          [
            {
              sourceId: blockedBySourceId,
              kind: "blocked_by_added",
              sequence: 1,
              occurredAt: dependencyAt,
              actor: { status: "unavailable" },
              relatedNodeIds: [blockerNodeId],
            },
          ],
        ),
      ],
    });

    expect(fresh).toEqual(cached);
    expect(fresh.input.relationHistory).toEqual({
      status: "exact",
      mutations: [
        {
          status: "resolved",
          sourceId: blockedBySourceId,
          originItemNodeId: blockedNodeId,
          fromNodeId: blockerNodeId,
          toNodeId: blockedNodeId,
          action: "added",
          occurredAt: dependencyAt,
          sequence: 1,
        },
      ],
    });
  });

  it("本文履歴のunknownをnative dependencyの履歴全体へ波及させない", () => {
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: { availability: "unavailable", reason: "connection_null" },
      timeline: [
        {
          sourceId: blockedBySourceId,
          nodeId: createGitHubNodeId("TE_temporal_blocks_dependency_unknown"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocked_by_added",
          blockingIssue: createReferencedItem(blockerNodeId, 1),
        },
      ],
    });
    const result = adaptFreshTemporalBlocksGraph({
      current: createCurrentGraph([blockerNodeId, blockedNodeId], []),
      relationCandidates: [],
      items: [{ detail, itemCreatedAt: createdAt, replay: createReplay(blockedNodeId, "issue") }],
    });

    expect(result.input.relationHistory.status).toBe("exact");
    expect(result.unknownRelationMutations).toEqual([
      {
        contentSourceId: detail.bodySourceId,
        reason: "connection_unavailable",
      },
    ]);
  });

  it("本文とIssue commentの確定mutationだけをcurrent blocks edgeへ接続する", () => {
    const relationUrl = `https://github.com/${repository.owner}/${repository.name}/issues/1`;
    const bodyEditedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const commentEditedAt = createUtcIsoDateTime("2026-08-01T04:00:00Z");
    const bodyHistory: GitHubUserContentEditCollection = {
      availability: "available",
      edits: [
        createEdit({ id: "body-empty", sequence: 0, editedAt: bodyEditedAt, diff: "" }),
        createEdit({
          id: "body-reference",
          sequence: 1,
          editedAt: bodyEditedAt,
          diff: relationUrl,
        }),
      ],
    };
    const commentHistory: GitHubUserContentEditCollection = {
      availability: "available",
      edits: [
        createEdit({ id: "comment-empty", sequence: 0, editedAt: commentEditedAt, diff: "" }),
        createEdit({
          id: "comment-reference",
          sequence: 1,
          editedAt: commentEditedAt,
          diff: relationUrl,
        }),
      ],
    };
    const comment = createIssueComment(
      createGitHubNodeId("IC_temporal_blocks"),
      relationUrl,
      commentHistory,
    );
    const detail = createIssueDetail(blockedNodeId, {
      body: relationUrl,
      bodyUserContentEdits: bodyHistory,
      comments: [comment],
    });
    const candidate = createBlocksCandidate();
    const current = createCurrentGraph(
      [blockerNodeId, blockedNodeId],
      [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
    );
    const mutationSources = [
      adaptGitHubRelationMutationSource({
        kind: "item_body",
        contentSourceId: detail.bodySourceId,
        contentCreatedAt: createdAt,
        currentMarkdown: detail.body,
        history: detail.bodyUserContentEdits,
      }),
      adaptGitHubRelationMutationSource({
        kind: "issue_comment",
        contentSourceId: comment.sourceId,
        contentCreatedAt: comment.createdAt,
        currentMarkdown: comment.body,
        history: comment.userContentEdits,
      }),
    ];
    const fresh = adaptFreshTemporalBlocksGraph({
      current,
      relationCandidates: [candidate],
      items: [{ detail, itemCreatedAt: createdAt, replay: createReplay(blockedNodeId, "issue") }],
    });
    const cached = adaptCachedTemporalBlocksGraph({
      current,
      documents: [createCacheDocument([candidate], mutationSources, [])],
    });

    expect(fresh).toEqual(cached);
    expect(fresh.unknownRelationMutations).toEqual([]);
    expect(fresh.input.relationHistory).toMatchObject({
      status: "exact",
      mutations: [
        {
          status: "resolved",
          action: "added",
          fromNodeId: blockerNodeId,
          toNodeId: blockedNodeId,
          occurredAt: bodyEditedAt,
        },
        {
          status: "resolved",
          action: "added",
          fromNodeId: blockerNodeId,
          toNodeId: blockedNodeId,
          occurredAt: commentEditedAt,
        },
      ],
    });
  });

  it("Pull Request review commentをrelation mutation sourceへ流さない", () => {
    const reviewCommentSourceId = sourceId(
      "github_pull_request_review_comment",
      "temporal-review-comment",
    );
    const detail = {
      ...createIssueDetail(pullRequestNodeId, {
        body: "",
        bodyUserContentEdits: availableEmptyEdits,
      }),
      type: "pull_request" as const,
      reviews: [],
      reviewThreads: [
        {
          sourceId: sourceId("github_pull_request_review_thread", "temporal-thread"),
          nodeId: createGitHubNodeId("PRRT_temporal_blocks"),
          sequence: 0,
          isResolved: false,
          isOutdated: false,
          path: "src/example.ts",
          resolvedBy: unavailableActor,
          comments: [
            {
              sourceId: reviewCommentSourceId,
              nodeId: createGitHubNodeId("PRRC_temporal_blocks"),
              sequence: 0,
              author: unavailableActor,
              body: "",
              createdAt,
              lastEditedAt: null,
              updatedAt: observedAt,
              url: `https://github.com/${repository.owner}/${repository.name}/pull/3#discussion_r1`,
              userContentEdits: {
                availability: "unavailable",
                reason: "connection_null",
              },
            },
          ],
        },
      ],
      reviewRequests: { current: [], history: [] },
      nativeClosingIssues: [],
      headSha: "head",
      headCommit: {
        sourceId: sourceId("github_commit", "temporal-head"),
        nodeId: createGitHubNodeId("C_temporal_blocks"),
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
    } satisfies GitHubItemDetail;
    const result = adaptFreshTemporalBlocksGraph({
      current: createCurrentGraph([pullRequestNodeId], []),
      relationCandidates: [],
      items: [
        {
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(pullRequestNodeId, "pull_request"),
        },
      ],
    });

    expect(result.unknownRelationMutations).not.toContainEqual(
      expect.objectContaining({ contentSourceId: reviewCommentSourceId }),
    );
  });

  it("同じsource IDのtimelineイベントを受けたら例外にする", () => {
    const event = {
      sourceId: blockedBySourceId,
      nodeId: createGitHubNodeId("TE_temporal_blocks_duplicate"),
      sequence: 1,
      occurredAt: dependencyAt,
      actor: unavailableActor,
      kind: "blocked_by_added" as const,
      blockingIssue: createReferencedItem(blockerNodeId, 1),
    };
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [event, event],
    });

    expect(() =>
      adaptFreshTemporalBlocksGraph({
        current: createCurrentGraph([blockerNodeId, blockedNodeId], []),
        relationCandidates: [],
        items: [{ detail, itemCreatedAt: createdAt, replay: createReplay(blockedNodeId, "issue") }],
      }),
    ).toThrow("同じsource IDのイベントが重複");
  });
});

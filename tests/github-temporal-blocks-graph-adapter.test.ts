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
  adaptMixedTemporalBlocksGraph,
  type MixedTemporalBlocksGraphCurrent,
  type MixedTemporalBlocksGraphItem,
} from "../src/github/temporal-blocks-graph-adapter.js";
import {
  type GitHubDetailActor,
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubReferencedItem,
  type GitHubTimelineEvent,
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
import { replayDependencyEvents } from "../src/graph/replay-dependency-events.js";
import {
  replayTemporalBlocksGraph,
  type TemporalBlocksCurrentNode,
} from "../src/graph/temporal-blocks-graph-replay.js";

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
const secondBlockerNodeId = createGitHubNodeId("I_temporal_blocks_second_blocker");
const blockedNodeId = createGitHubNodeId("I_temporal_blocks_blocked");
const cachedExactBlockerNodeId = createGitHubNodeId("I_temporal_blocks_cached_exact_blocker");
const cachedExactBlockedNodeId = createGitHubNodeId("I_temporal_blocks_cached_exact_blocked");
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
  const itemSourceId = sourceId("github_item_detail", nodeId);
  const itemSourceIds: readonly [SourceId] = [itemSourceId];
  const stateEpoch = {
    occurredAt: createdAt,
    sourceIds: itemSourceIds,
    state: "open",
  } satisfies Readonly<{
    occurredAt: ReturnType<typeof createUtcIsoDateTime>;
    sourceIds: readonly [SourceId];
    state: "open" | "closed" | "merged";
  }>;
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

function createReplayWithStateSourceId(
  nodeId: ReturnType<typeof createGitHubNodeId>,
  type: "issue" | "pull_request",
  stateSourceId: SourceId,
): ReplayItemHistoryResult {
  const replay = createReplay(nodeId, type);
  const stateSourceIds: readonly [SourceId] = [stateSourceId];
  const stateEpoch: Extract<
    ReplayItemHistoryResult["stateEpochs"],
    { status: "known" }
  >["value"][number] = {
    occurredAt: createdAt,
    sourceIds: stateSourceIds,
    state: "open",
  };
  return {
    ...replay,
    stateEpochs: { status: "known", value: [stateEpoch] },
    currentStateEpoch: { status: "known", value: stateEpoch },
  };
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
): Omit<MixedTemporalBlocksGraphCurrent, "scope"> {
  return {
    nodes: nodes.map((nodeId): TemporalBlocksCurrentNode => ({ nodeId, state: "open" })),
    canonicalBlocksEdges,
  };
}

function createMixedCurrentGraph(
  nodes: readonly ReturnType<typeof createGitHubNodeId>[],
  canonicalBlocksEdges: readonly Readonly<{
    fromNodeId: ReturnType<typeof createGitHubNodeId>;
    toNodeId: ReturnType<typeof createGitHubNodeId>;
  }>[],
): MixedTemporalBlocksGraphCurrent {
  return {
    ...createCurrentGraph(nodes, canonicalBlocksEdges),
    scope: "eligible_tracked_items_only",
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

function createBlocksCandidateBetween(
  blocker: Readonly<{
    nodeId: ReturnType<typeof createGitHubNodeId>;
    number: number;
  }>,
  blocked: Readonly<{
    nodeId: ReturnType<typeof createGitHubNodeId>;
    number: number;
  }>,
  id: string,
): RelationCandidate {
  const candidateSourceIds: readonly [SourceId] = [sourceId("github_native_dependency", id)];
  return {
    id: `rel:${id}`,
    sourceIds: candidateSourceIds,
    authority: "authoritative",
    provenance: "native",
    relation: {
      type: "blocks",
      blocker: {
        scope: "organization",
        kind: "issue",
        nodeId: blocker.nodeId,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        number: blocker.number,
        url: `https://github.com/${repository.owner}/${repository.name}/issues/${blocker.number.toString()}`,
        state: "open",
      },
      blocked: {
        scope: "organization",
        kind: "issue",
        nodeId: blocked.nodeId,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        number: blocked.number,
        url: `https://github.com/${repository.owner}/${repository.name}/issues/${blocked.number.toString()}`,
        state: "open",
      },
    },
  };
}

function createBlocksCandidate(): RelationCandidate {
  return createBlocksCandidateBetween(
    { nodeId: blockerNodeId, number: 1 },
    { nodeId: blockedNodeId, number: 2 },
    "temporal-blocks",
  );
}

function createUnclassifiedCandidate(): RelationCandidate {
  const blocks = createBlocksCandidate();
  if (blocks.relation.type !== "blocks") {
    throw new TypeError("blocks候補fixtureの関係種別が不正です");
  }
  return {
    id: blocks.id,
    sourceIds: blocks.sourceIds,
    authority: "inferred",
    provenance: "explicit_text",
    relation: {
      type: "unclassified",
      referencing: blocks.relation.blocked,
      referenced: blocks.relation.blocker,
    },
  };
}

function createObservation(
  nodeId: ReturnType<typeof createGitHubNodeId>,
): FreshObservedGitHubIssue {
  const itemNumber = nodeId === blockedNodeId ? 2 : 1;
  const bodyFingerprint = parseSha256Hash(
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  );
  const itemFingerprint = parseSha256Hash(
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  );
  return {
    freshness: "fresh",
    sourceId: sourceId("github_item_detail", nodeId),
    nodeId,
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
    displayReference:
      nodeId === blockedNodeId
        ? `${repository.owner}/${repository.name}#2`
        : `${repository.owner}/${repository.name}#1`,
    number: itemNumber,
    url:
      nodeId === blockedNodeId
        ? `https://github.com/${repository.owner}/${repository.name}/issues/2`
        : `https://github.com/${repository.owner}/${repository.name}/issues/1`,
    title: "temporal blocks fixture",
    bodySourceId: sourceId("github_item_body", nodeId),
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
  nodeId: ReturnType<typeof createGitHubNodeId>,
  relationCandidates: readonly RelationCandidate[],
  relationMutations: readonly GitHubRelationMutationSourceResult[],
  historyEvents: readonly CacheTemporalEvent[],
): GitHubItemCacheDocument {
  const observation = createObservation(nodeId);
  const replay = createReplay(nodeId, "issue");
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
          nodeId,
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

function reverseCachedMutationSource(
  source: GitHubRelationMutationSourceResult,
): GitHubRelationMutationSourceResult {
  if (source.result.status !== "available") {
    throw new TypeError("mutation fixtureが利用可能ではありません");
  }
  return {
    ...source,
    result: {
      ...source.result,
      mutations: [...source.result.mutations].reverse(),
    },
  };
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
      [blockedNodeId, blockerNodeId],
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
          blockedNodeId,
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
    const mixedFresh = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockedNodeId, blockerNodeId],
        [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [
        {
          kind: "fresh",
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(blockedNodeId, "issue"),
        },
      ],
    });
    const mixedCache = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockedNodeId, blockerNodeId],
        [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [
        {
          kind: "cached",
          document: createCacheDocument(
            blockedNodeId,
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
        },
      ],
    });

    expect(fresh).toEqual(cached);
    expect(mixedFresh).toEqual(fresh);
    expect(mixedCache).toEqual(cached);
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
      localUnknowns: [],
    });
  });

  it("state epochのtimeline source IDにsequenceがなければ例外にする", () => {
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
    });
    const replay = createReplayWithStateSourceId(
      blockedNodeId,
      "issue",
      sourceId("github_state_event", "missing-sequence"),
    );

    expect(() =>
      adaptFreshTemporalBlocksGraph({
        current: createCurrentGraph([blockedNodeId], []),
        relationCandidates: [],
        items: [{ detail, itemCreatedAt: createdAt, replay }],
      }),
    ).toThrow("timeline sequence");
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
        originItemNodeId: blockedNodeId,
        contentSourceId: detail.bodySourceId,
        reason: "connection_unavailable",
        edit: { status: "unavailable" },
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
      documents: [createCacheDocument(blockedNodeId, [candidate], mutationSources, [])],
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

  it("unclassified本文候補の追加と削除と再追加をcurrent blocks edgeへ接続する", () => {
    const relationUrl = `https://github.com/${repository.owner}/${repository.name}/issues/1`;
    const addedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const removedAt = createUtcIsoDateTime("2026-08-01T04:00:00Z");
    const readdedAt = createUtcIsoDateTime("2026-08-01T05:00:00Z");
    const bodyHistory: GitHubUserContentEditCollection = {
      availability: "available",
      edits: [
        createEdit({ id: "unclassified-empty", sequence: 0, editedAt: createdAt, diff: "" }),
        createEdit({
          id: "unclassified-added",
          sequence: 1,
          editedAt: addedAt,
          diff: relationUrl,
        }),
        createEdit({ id: "unclassified-removed", sequence: 2, editedAt: removedAt, diff: "" }),
        createEdit({
          id: "unclassified-readded",
          sequence: 3,
          editedAt: readdedAt,
          diff: relationUrl,
        }),
      ],
    };
    const detail = createIssueDetail(blockedNodeId, {
      body: relationUrl,
      bodyUserContentEdits: bodyHistory,
    });
    const adapted = adaptFreshTemporalBlocksGraph({
      current: createCurrentGraph(
        [blockerNodeId, blockedNodeId],
        [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
      ),
      relationCandidates: [createUnclassifiedCandidate()],
      items: [{ detail, itemCreatedAt: createdAt, replay: createReplay(blockedNodeId, "issue") }],
    });
    if (adapted.input.relationHistory.status !== "exact") {
      throw new TypeError("unclassified本文候補のrelation historyがexactではありません");
    }

    const replay = replayDependencyEvents(adapted.input.relationHistory.mutations);
    const relation = replay.relations[0];

    expect(adapted.unknownRelationMutations).toEqual([]);
    expect(adapted.input.relationHistory.mutations).toMatchObject([
      { action: "added", occurredAt: addedAt },
      { action: "removed", occurredAt: removedAt },
      { action: "added", occurredAt: readdedAt },
    ]);
    expect(relation?.intervals.at(-1)).toEqual({
      status: "active",
      addedAt: readdedAt,
      sourceIds: [sourceId("github_user_content_edit", "unclassified-readded")],
      lastConfirmedAt: readdedAt,
    });
  });

  it("削除済みunclassified本文候補を過去のexact方向だけでnewly unblockedへ復元する", () => {
    const relationUrl = `https://github.com/${repository.owner}/${repository.name}/issues/1`;
    const addedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const removedAt = createUtcIsoDateTime("2026-08-01T04:00:00Z");
    const historicalCandidate = createUnclassifiedCandidate();
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: {
        availability: "available",
        edits: [
          createEdit({ id: "historical-empty", sequence: 0, editedAt: createdAt, diff: "" }),
          createEdit({
            id: "historical-added",
            sequence: 1,
            editedAt: addedAt,
            diff: relationUrl,
          }),
          createEdit({
            id: "historical-removed",
            sequence: 2,
            editedAt: removedAt,
            diff: "",
          }),
        ],
      },
    });
    const adapted = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph([blockerNodeId, blockedNodeId], []),
      notificationHistory: {
        exactBlocksEdges: [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
        relationCandidates: [historicalCandidate],
      },
      relationCandidates: [],
      items: [
        {
          kind: "fresh",
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(blockedNodeId, "issue"),
        },
        {
          kind: "fresh",
          detail: createIssueDetail(blockerNodeId, {
            body: "",
            bodyUserContentEdits: availableEmptyEdits,
          }),
          itemCreatedAt: createdAt,
          replay: createReplay(blockerNodeId, "issue"),
        },
      ],
    });
    const replay = replayTemporalBlocksGraph(adapted.input);

    expect(adapted.unknownRelationMutations).toEqual([]);
    expect(adapted.input.relationHistory).toMatchObject({
      status: "exact",
      mutations: [
        { action: "added", occurredAt: addedAt },
        { action: "removed", occurredAt: removedAt },
      ],
    });
    expect(replay.currentGraph.activeBlocksEdges).toEqual([]);
    expect(replay.newlyUnblockedFacts).toContainEqual({
      status: "exact",
      value: {
        blockedNodeId,
        blockerNodeIds: [blockerNodeId],
        occurredAt: removedAt,
        sourceIds: [sourceId("github_user_content_edit", "historical-removed")],
      },
    });
  });

  it("一つの編集から複数relationを作りfreshとcacheで順序を正規化する", () => {
    const firstUrl = `https://github.com/${repository.owner}/${repository.name}/issues/1`;
    const secondUrl = `https://github.com/${repository.owner}/${repository.name}/issues/3`;
    const bodyEditedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const bodyHistory: GitHubUserContentEditCollection = {
      availability: "available",
      edits: [
        createEdit({ id: "multi-relation-empty", sequence: 0, editedAt: bodyEditedAt, diff: "" }),
        createEdit({
          id: "multi-relation-additions",
          sequence: 1,
          editedAt: bodyEditedAt,
          diff: `${firstUrl}\n${secondUrl}`,
        }),
      ],
    };
    const detail = createIssueDetail(blockedNodeId, {
      body: `${firstUrl}\n${secondUrl}`,
      bodyUserContentEdits: bodyHistory,
    });
    const firstCandidate = createBlocksCandidate();
    const secondCandidate = createBlocksCandidateBetween(
      { nodeId: secondBlockerNodeId, number: 3 },
      { nodeId: blockedNodeId, number: 2 },
      "temporal-blocks-second",
    );
    const current = createCurrentGraph(
      [blockerNodeId, secondBlockerNodeId, blockedNodeId],
      [
        { fromNodeId: blockerNodeId, toNodeId: blockedNodeId },
        { fromNodeId: secondBlockerNodeId, toNodeId: blockedNodeId },
      ],
    );
    const mutationSource = adaptGitHubRelationMutationSource({
      kind: "item_body",
      contentSourceId: detail.bodySourceId,
      contentCreatedAt: createdAt,
      currentMarkdown: detail.body,
      history: detail.bodyUserContentEdits,
    });
    const fresh = adaptFreshTemporalBlocksGraph({
      current,
      relationCandidates: [firstCandidate, secondCandidate],
      items: [{ detail, itemCreatedAt: createdAt, replay: createReplay(blockedNodeId, "issue") }],
    });
    const mutationSources = [mutationSource];
    const firstMutationSource = mutationSources[0];
    if (firstMutationSource == null) {
      throw new TypeError("mutation fixtureがありません");
    }
    const cached = adaptCachedTemporalBlocksGraph({
      current,
      documents: [
        createCacheDocument(
          blockedNodeId,
          [secondCandidate, firstCandidate],
          [reverseCachedMutationSource(firstMutationSource)],
          [],
        ),
      ],
    });

    expect(cached).toEqual(fresh);
    expect(fresh.input.relationHistory).toMatchObject({
      status: "exact",
      mutations: [
        {
          sourceId: sourceId("github_user_content_edit", "multi-relation-additions"),
          originItemNodeId: blockedNodeId,
          occurredAt: bodyEditedAt,
          sequence: 1,
        },
        {
          sourceId: sourceId("github_user_content_edit", "multi-relation-additions"),
          originItemNodeId: blockedNodeId,
          occurredAt: bodyEditedAt,
          sequence: 1,
        },
      ],
    });
    if (fresh.input.relationHistory.status !== "exact") {
      throw new TypeError("relation historyがexactではありません");
    }
    expect(
      fresh.input.relationHistory.mutations.map((mutation) =>
        mutation.status === "resolved" ? [mutation.fromNodeId, mutation.toNodeId] : [],
      ),
    ).toEqual([
      [blockerNodeId, blockedNodeId],
      [secondBlockerNodeId, blockedNodeId],
    ]);
  });

  it("freshの同一編集にresolvedとunknownがあってもcache側のexact factへ波及させない", () => {
    const knownUrl = `https://github.com/${repository.owner}/${repository.name}/issues/1`;
    const unknownUrl = `https://github.com/${repository.owner}/${repository.name}/issues/999`;
    const bodyEditedAt = createUtcIsoDateTime("2026-08-01T03:00:00Z");
    const cachedRemovedAt = createUtcIsoDateTime("2026-08-01T05:00:00Z");
    const detail = createIssueDetail(blockedNodeId, {
      body: `${knownUrl}\n${unknownUrl}`,
      bodyUserContentEdits: {
        availability: "available",
        edits: [
          createEdit({ id: "mixed-empty", sequence: 0, editedAt: createdAt, diff: "" }),
          createEdit({
            id: "mixed-resolved-unresolved",
            sequence: 1,
            editedAt: bodyEditedAt,
            diff: `${knownUrl}\n${unknownUrl}`,
          }),
        ],
      },
    });
    const cachedAddedSourceId = sourceId("github_timeline_event", "cached-exact-added");
    const cachedRemovedSourceId = sourceId("github_timeline_event", "cached-exact-removed");
    const adapted = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockerNodeId, blockedNodeId, cachedExactBlockerNodeId, cachedExactBlockedNodeId],
        [
          { fromNodeId: blockerNodeId, toNodeId: blockedNodeId },
          { fromNodeId: blockedNodeId, toNodeId: cachedExactBlockerNodeId },
        ],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [createBlocksCandidate()],
      items: [
        {
          kind: "fresh",
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(blockedNodeId, "issue"),
        },
        {
          kind: "fresh",
          detail: createIssueDetail(blockerNodeId, {
            body: "",
            bodyUserContentEdits: availableEmptyEdits,
          }),
          itemCreatedAt: createdAt,
          replay: createReplay(blockerNodeId, "issue"),
        },
        {
          kind: "cached",
          document: createCacheDocument(cachedExactBlockerNodeId, [], [], []),
        },
        {
          kind: "cached",
          document: createCacheDocument(
            cachedExactBlockedNodeId,
            [],
            [],
            [
              {
                sourceId: cachedAddedSourceId,
                kind: "blocked_by_added",
                sequence: 1,
                occurredAt: dependencyAt,
                actor: { status: "unavailable" },
                relatedNodeIds: [cachedExactBlockerNodeId],
              },
              {
                sourceId: cachedRemovedSourceId,
                kind: "blocked_by_removed",
                sequence: 2,
                occurredAt: cachedRemovedAt,
                actor: { status: "unavailable" },
                relatedNodeIds: [cachedExactBlockerNodeId],
              },
            ],
          ),
        },
      ],
    });
    const replay = replayTemporalBlocksGraph(adapted.input);
    const editSourceId = sourceId("github_user_content_edit", "mixed-resolved-unresolved");

    if (adapted.input.relationHistory.status !== "exact") {
      throw new TypeError("freshとcacheの混在relation historyがexactではありません");
    }
    expect(adapted.input.relationHistory.localUnknowns).toEqual([
      { originItemNodeId: blockedNodeId },
    ]);
    expect(adapted.input.relationHistory.mutations).toContainEqual({
      status: "resolved",
      sourceId: editSourceId,
      originItemNodeId: blockedNodeId,
      fromNodeId: blockerNodeId,
      toNodeId: blockedNodeId,
      action: "added",
      occurredAt: bodyEditedAt,
      sequence: 1,
    });
    expect(adapted.unknownRelationMutations).toContainEqual({
      originItemNodeId: blockedNodeId,
      contentSourceId: detail.bodySourceId,
      reason: "relation_endpoint_unavailable",
      edit: {
        status: "available",
        sourceId: editSourceId,
        editedAt: bodyEditedAt,
        sequence: 1,
      },
    });
    expect(replay.newlyUnblockedFacts).toContainEqual({
      status: "unknown",
      scope: "node",
      nodeIds: [blockedNodeId],
      reason: "relation_mutation_unresolved",
    });
    expect(replay.newlyUnblockedFacts).toContainEqual({
      status: "exact",
      value: {
        blockedNodeId: cachedExactBlockedNodeId,
        occurredAt: cachedRemovedAt,
        sourceIds: [cachedRemovedSourceId],
        blockerNodeIds: [cachedExactBlockerNodeId],
      },
    });
    expect(
      replay.newlyUnblockedFacts.some(
        (fact) => fact.status === "unknown" && fact.scope === "global",
      ),
    ).toBe(false);
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
      type: "pull_request",
      reviewDecision: null,
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
    const event: GitHubTimelineEvent = {
      sourceId: blockedBySourceId,
      nodeId: createGitHubNodeId("TE_temporal_blocks_duplicate"),
      sequence: 1,
      occurredAt: dependencyAt,
      actor: unavailableActor,
      kind: "blocked_by_added",
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

  it("freshとcacheの関係イベントを統合してnewly unblockedを復元する", () => {
    const removeSourceId = sourceId("github_timeline_event", "cache-unblock");
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [
        {
          sourceId: sourceId("github_timeline_event", "fresh-block"),
          nodeId: createGitHubNodeId("TE_temporal_blocks_fresh_block"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocked_by_added",
          blockingIssue: createReferencedItem(blockerNodeId, 1),
        },
      ],
    });
    const result = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph([blockedNodeId, blockerNodeId], []),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [
        {
          kind: "fresh",
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(blockedNodeId, "issue"),
        },
        {
          kind: "cached",
          document: createCacheDocument(
            blockerNodeId,
            [],
            [],
            [
              {
                sourceId: removeSourceId,
                kind: "blocking_removed",
                sequence: 2,
                occurredAt: createUtcIsoDateTime("2026-08-01T03:00:00Z"),
                actor: { status: "unavailable" },
                relatedNodeIds: [blockedNodeId],
              },
            ],
          ),
        },
      ],
    });

    const replay = replayTemporalBlocksGraph(result.input);

    expect(
      replay.newlyUnblockedFacts.some(
        (fact) => fact.status === "exact" && fact.value.blockedNodeId === blockedNodeId,
      ),
    ).toBe(true);
  });

  it("freshとcacheの関係イベントを統合してcycle作成候補を復元する", () => {
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [
        {
          sourceId: sourceId("github_timeline_event", "fresh-cycle"),
          nodeId: createGitHubNodeId("TE_temporal_blocks_fresh_cycle"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocking_added",
          blockedIssue: createReferencedItem(blockerNodeId, 1),
        },
      ],
    });
    const result = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockerNodeId, blockedNodeId],
        [
          { fromNodeId: blockerNodeId, toNodeId: blockedNodeId },
          { fromNodeId: blockedNodeId, toNodeId: blockerNodeId },
        ],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [
        {
          kind: "fresh",
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(blockedNodeId, "issue"),
        },
        {
          kind: "cached",
          document: createCacheDocument(
            blockerNodeId,
            [],
            [],
            [
              {
                sourceId: sourceId("github_timeline_event", "cache-cycle"),
                kind: "blocking_added",
                sequence: 2,
                occurredAt: createUtcIsoDateTime("2026-08-01T03:00:00Z"),
                actor: { status: "unavailable" },
                relatedNodeIds: [blockedNodeId],
              },
            ],
          ),
        },
      ],
    });

    const replay = replayTemporalBlocksGraph(result.input);

    expect(replay.currentCycles).toHaveLength(1);
    expect(replay.cycleCreatedFacts).toContainEqual(expect.objectContaining({ status: "exact" }));
  });

  it("freshのunknown診断をcacheの確定関係へ波及させない", () => {
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: { availability: "unavailable", reason: "connection_null" },
    });
    const result = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockerNodeId, blockedNodeId],
        [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [
        {
          kind: "fresh",
          detail,
          itemCreatedAt: createdAt,
          replay: createReplay(blockedNodeId, "issue"),
        },
        {
          kind: "cached",
          document: createCacheDocument(
            blockerNodeId,
            [],
            [],
            [
              {
                sourceId: sourceId("github_timeline_event", "cache-known"),
                kind: "blocking_added",
                sequence: 1,
                occurredAt: dependencyAt,
                actor: { status: "unavailable" },
                relatedNodeIds: [blockedNodeId],
              },
            ],
          ),
        },
      ],
    });

    expect(result.input.relationHistory.status).toBe("exact");
    expect(result.unknownRelationMutations).toEqual([
      {
        originItemNodeId: blockedNodeId,
        contentSourceId: detail.bodySourceId,
        reason: "connection_unavailable",
        edit: { status: "unavailable" },
      },
    ]);
  });

  it("混在入力のnodeと関係sourceの重複を拒否する", () => {
    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
    });
    expect(() =>
      adaptMixedTemporalBlocksGraph({
        current: createMixedCurrentGraph([blockerNodeId, blockedNodeId], []),
        notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
        relationCandidates: [],
        items: [
          {
            kind: "fresh",
            detail,
            itemCreatedAt: createdAt,
            replay: createReplay(blockedNodeId, "issue"),
          },
          {
            kind: "cached",
            document: createCacheDocument(blockedNodeId, [], [], []),
          },
        ],
      }),
    ).toThrow("node IDが重複");

    const duplicateSource = sourceId("github_timeline_event", "mixed-duplicate");
    const duplicateDetail = createIssueDetail(blockerNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [
        {
          sourceId: duplicateSource,
          nodeId: createGitHubNodeId("TE_temporal_blocks_mixed_duplicate"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocking_added",
          blockedIssue: createReferencedItem(blockedNodeId, 2),
        },
      ],
    });
    const firstDetail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [
        {
          sourceId: duplicateSource,
          nodeId: createGitHubNodeId("TE_temporal_blocks_mixed_duplicate_2"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocked_by_added",
          blockingIssue: createReferencedItem(blockerNodeId, 1),
        },
      ],
    });
    expect(() =>
      adaptMixedTemporalBlocksGraph({
        current: createMixedCurrentGraph([blockerNodeId, blockedNodeId], []),
        notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
        relationCandidates: [],
        items: [
          {
            kind: "fresh",
            detail: firstDetail,
            itemCreatedAt: createdAt,
            replay: createReplay(blockedNodeId, "issue"),
          },
          {
            kind: "fresh",
            detail: duplicateDetail,
            itemCreatedAt: createdAt,
            replay: createReplay(blockerNodeId, "issue"),
          },
        ],
      }),
    ).toThrow("同じsource IDのイベントが重複");
  });

  it("混在入力のcurrent edge端点不足を拒否し入力順に依存しない", () => {
    expect(() =>
      adaptMixedTemporalBlocksGraph({
        current: createMixedCurrentGraph(
          [blockedNodeId],
          [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
        ),
        notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
        relationCandidates: [],
        items: [],
      }),
    ).toThrow("存在しないnode");

    const detail = createIssueDetail(blockedNodeId, {
      body: "",
      bodyUserContentEdits: availableEmptyEdits,
      timeline: [
        {
          sourceId: sourceId("github_timeline_event", "mixed-order"),
          nodeId: createGitHubNodeId("TE_temporal_blocks_mixed_order"),
          sequence: 1,
          occurredAt: dependencyAt,
          actor: unavailableActor,
          kind: "blocked_by_added",
          blockingIssue: createReferencedItem(blockerNodeId, 1),
        },
      ],
    });
    const fresh = {
      kind: "fresh",
      detail,
      itemCreatedAt: createdAt,
      replay: createReplay(blockedNodeId, "issue"),
    } satisfies MixedTemporalBlocksGraphItem;
    const cached = {
      kind: "cached",
      document: createCacheDocument(blockerNodeId, [], [], []),
    } satisfies MixedTemporalBlocksGraphItem;
    const first = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockerNodeId, blockedNodeId],
        [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [fresh, cached],
    });
    const second = adaptMixedTemporalBlocksGraph({
      current: createMixedCurrentGraph(
        [blockedNodeId, blockerNodeId],
        [{ fromNodeId: blockerNodeId, toNodeId: blockedNodeId }],
      ),
      notificationHistory: { exactBlocksEdges: [], relationCandidates: [] },
      relationCandidates: [],
      items: [cached, fresh],
    });

    expect(first).toEqual(second);
  });
});

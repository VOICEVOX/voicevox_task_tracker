import { describe, expect, it } from "vitest";

import {
  adaptGitHubItemDetailRelationMutations,
  adaptGitHubRelationMutationSource,
  type GitHubUserContentEditCollection,
  type GitHubRelationMutationSource,
  type GitHubDetailActor,
  type GitHubItemDetail,
} from "../src/github/index.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type SourceId,
} from "../src/domain/index.js";
import { createPublicRepositoryAllowlist } from "../src/github/index.js";

function sourceId(kind: string, value: string): SourceId {
  return buildSourceId(kind, value);
}

function editCollection(): Extract<GitHubUserContentEditCollection, { availability: "available" }> {
  return {
    availability: "available",
    edits: [
      {
        sourceId: sourceId("github_user_content_edit", "adapter-edit"),
        sequence: 0,
        createdAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        deletedAt: null,
        diff: "adapter-only raw snapshot\nhttps://github.com/VOICEVOX/example/issues/1",
        editedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
        editor: {
          status: "unavailable",
          reason: "github_did_not_return_actor",
        },
        updatedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
      },
    ],
  };
}

describe("GitHub relation mutation adapter", () => {
  it("IssueまたはPull Request本文のhistoryをpure入力へ変換する", () => {
    const source = {
      kind: "item_body",
      contentSourceId: sourceId("github_item_body", "adapter-body"),
      contentCreatedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
      currentMarkdown: "https://github.com/VOICEVOX/example/issues/1",
      history: editCollection(),
    } satisfies GitHubRelationMutationSource;

    const adapted = adaptGitHubRelationMutationSource(source);

    expect(adapted.kind).toBe("item_body");
    expect(adapted.result).toMatchObject({
      status: "available",
      temporalKnowledge: { status: "exact" },
    });
    expect(JSON.stringify(adapted)).not.toContain("adapter-only raw snapshot");
  });

  it("Issue commentをrelation sourceとして扱う", () => {
    const source = {
      kind: "issue_comment",
      contentSourceId: sourceId("github_issue_comment", "adapter-comment"),
      contentCreatedAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
      currentMarkdown: "https://github.com/VOICEVOX/example/issues/1",
      history: {
        availability: "unavailable",
        reason: "connection_null",
      },
    } satisfies GitHubRelationMutationSource;

    const adapted = adaptGitHubRelationMutationSource(source);

    expect(adapted.kind).toBe("issue_comment");
    expect(adapted.result).toMatchObject({
      status: "unknown",
      reason: "connection_unavailable",
    });
  });

  it("item detailの結果にPull Request review commentを含めない", () => {
    const observedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
    const repositoryId = createGitHubRepositoryId("R_relation_adapter");
    const publicRepositoryId = createPublicRepositoryAllowlist([
      {
        id: repositoryId,
        owner: "VOICEVOX",
        name: "example",
        visibility: "public",
        archived: false,
        disabled: false,
        observedAt,
      },
    ]).require(repositoryId).id;
    const unavailableActor = {
      status: "unavailable",
      reason: "github_did_not_return_actor",
    } satisfies GitHubDetailActor;
    const detail = {
      sourceId: sourceId("github_item_detail", "adapter-detail"),
      nodeId: createGitHubNodeId("PR_adapter_detail"),
      repositoryId: publicRepositoryId,
      number: 1,
      bodySourceId: sourceId("github_item_body", "adapter-detail"),
      body: "https://github.com/VOICEVOX/example/issues/1",
      lastEditedAt: null,
      bodyUserContentEdits: {
        availability: "available",
        edits: editCollection().edits,
      },
      comments: [],
      timeline: [],
      inboundCrossReferences: [],
      observedAt,
      type: "pull_request",
      reviewDecision: null,
      reviews: [],
      reviewThreads: [
        {
          sourceId: sourceId("github_pull_request_review_thread", "adapter-thread"),
          nodeId: createGitHubNodeId("PRRT_adapter_thread"),
          sequence: 0,
          isResolved: false,
          isOutdated: false,
          path: "src/example.ts",
          resolvedBy: unavailableActor,
          comments: [
            {
              sourceId: sourceId(
                "github_pull_request_review_comment",
                "adapter-detail-review-comment",
              ),
              nodeId: createGitHubNodeId("PRRC_adapter_detail"),
              sequence: 0,
              author: unavailableActor,
              body: "https://github.com/VOICEVOX/example/issues/1",
              createdAt: observedAt,
              lastEditedAt: null,
              updatedAt: observedAt,
              url: "https://github.com/VOICEVOX/example/pull/1#discussion_r1",
              userContentEdits: {
                availability: "available",
                edits: editCollection().edits,
              },
            },
          ],
        },
      ],
      reviewRequests: { current: [], history: [] },
      nativeClosingIssues: [],
      headSha: "head-sha",
      headCommit: {
        sourceId: sourceId("github_commit", "adapter-head"),
        nodeId: createGitHubNodeId("C_adapter_head"),
        sha: "head-sha",
        committedAt: observedAt,
        pushedAt: {
          status: "unavailable",
          reason: "github_did_not_return_pushed_at",
        },
      },
      mergeState: {
        mergeability: "unknown",
        mergeState: "unknown",
        autoMerge: { status: "not_enabled" },
        mergeQueue: { status: "not_queued" },
        checks: { status: "not_configured" },
      },
    } satisfies GitHubItemDetail;

    const results = adaptGitHubItemDetailRelationMutations(detail, observedAt);

    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("item_body");
    expect(results[0]?.result).toMatchObject({
      status: "available",
      temporalKnowledge: { status: "exact", intervals: [{ addedAt: observedAt }] },
    });
  });
});

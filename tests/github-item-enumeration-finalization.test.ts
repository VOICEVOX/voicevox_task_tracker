import { describe, expect, it } from "vitest";

import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  buildSourceId,
  type GitHubItemDisplayReference,
} from "../src/domain/index.js";
import { GitHubResponseValidationError } from "../src/github/errors.js";
import {
  finalizeGitHubItemsWithVolatileMetadata,
  type ProvisionalGitHubItem,
} from "../src/github/item-enumeration-finalization.js";
import {
  createGitHubBodyFingerprint,
  type EnumeratedGitHubItem,
} from "../src/github/item-enumeration.js";
import {
  createGitHubPullRequestVolatileMetadata,
  type GitHubPullRequestVolatileMetadata,
  type GitHubPullRequestReviewDecision,
  type GitHubVolatileReviewRequest,
} from "../src/github/item-volatile-metadata.js";
import { type GitHubHeadChecks } from "../src/github/item-detail-types.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";

const observedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const repositoryId = createGitHubRepositoryId("R_enumeration_finalization");
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

function createItem(type: "issue" | "pull_request", nodeIdValue: string): ProvisionalGitHubItem {
  const nodeId = createGitHubNodeId(nodeIdValue);
  const fingerprint = createGitHubBodyFingerprint(`body-${nodeIdValue}`);
  const number = type === "issue" ? 1 : 2;
  const displayReference: GitHubItemDisplayReference =
    type === "issue" ? "VOICEVOX/example#1" : "VOICEVOX/example#2";
  const url =
    type === "issue"
      ? "https://github.com/VOICEVOX/example/issues/1"
      : "https://github.com/VOICEVOX/example/pull/2";
  const common = {
    nodeId,
    repositoryId: publicRepositoryId,
    displayReference,
    number,
    url,
    title: `${type}-${nodeIdValue}`,
    bodyFingerprint: fingerprint,
    bodyLocator: {
      kind: "github_item_body",
      repositoryId: publicRepositoryId,
      itemNodeId: nodeId,
      number,
    },
    author: { kind: "deleted_account" },
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00Z"),
    updatedAt: observedAt,
    state: "open",
    stateReason: null,
    closedAt: null,
    assignees: [],
    labels: [],
    milestone: null,
    itemFingerprint: fingerprint,
    observedAt,
  } satisfies Omit<EnumeratedGitHubItem, "type" | "draft" | "mergeStatus" | "mergedAt">;
  if (type === "issue") {
    return Object.freeze({ ...common, type, draft: "not_applicable" });
  }
  return Object.freeze({ ...common, type, draft: false, mergeStatus: "not_merged" });
}

function createMetadata(
  nodeIdValue: string,
  headSha: string,
  overrides: Readonly<{
    reviewDecision?: GitHubPullRequestReviewDecision;
    reviewRequests?: readonly GitHubVolatileReviewRequest[];
    mergeability?: "conflicting" | "mergeable" | "unknown";
    mergeState?:
      "behind" | "blocked" | "clean" | "dirty" | "draft" | "has_hooks" | "unknown" | "unstable";
    checks?: GitHubHeadChecks;
  }>,
): GitHubPullRequestVolatileMetadata {
  return createGitHubPullRequestVolatileMetadata({
    nodeId: createGitHubNodeId(nodeIdValue),
    headSha,
    reviewDecision: overrides.reviewDecision ?? null,
    reviewRequests: overrides.reviewRequests ?? [],
    mergeState: {
      mergeability: overrides.mergeability ?? "mergeable",
      mergeState: overrides.mergeState ?? "clean",
      autoMerge: { status: "not_enabled" },
      mergeQueue: { status: "not_queued" },
      checks: overrides.checks ?? { status: "not_configured" },
    },
  });
}

describe("GitHub item enumeration finalization", () => {
  it("Issueを変更せずPull Requestだけprobe metadataで確定する", () => {
    const issue = createItem("issue", "I_finalization");
    const pullRequest = createItem("pull_request", "PR_finalization");
    const metadata = createMetadata("PR_finalization", "head-1", {});

    const result = finalizeGitHubItemsWithVolatileMetadata({
      items: [issue, pullRequest],
      volatileMetadata: [metadata],
    });

    expect(result.status).toBe("finalized");
    expect(result.items[0]).toBe(issue);
    const finalized = result.items[1];
    if (finalized?.type !== "pull_request") {
      throw new Error("確定済みPull Requestがありません");
    }
    expect(finalized.itemFingerprint).not.toBe(pullRequest.itemFingerprint);
    expect("currentMetadataFingerprint" in finalized).toBe(false);
    expect(result.volatileMetadataByNodeId.get(finalized.nodeId)).toBe(metadata);
  });

  it("同じ入力からmetadataの順序に依存しない", () => {
    const issue = createItem("issue", "I_order");
    const firstPullRequest = createItem("pull_request", "PR_order_1");
    const secondPullRequest = createItem("pull_request", "PR_order_2");
    const firstMetadata = createMetadata("PR_order_1", "head-1", {});
    const secondMetadata = createMetadata("PR_order_2", "head-2", {});

    const forward = finalizeGitHubItemsWithVolatileMetadata({
      items: [issue, firstPullRequest, secondPullRequest],
      volatileMetadata: [firstMetadata, secondMetadata],
    });
    const reverse = finalizeGitHubItemsWithVolatileMetadata({
      items: [secondPullRequest, issue, firstPullRequest],
      volatileMetadata: [secondMetadata, firstMetadata],
    });

    expect(reverse.items).toEqual(forward.items);
    expect([...reverse.volatileMetadataByNodeId.keys()]).toEqual([
      firstMetadata.nodeId,
      secondMetadata.nodeId,
    ]);
    expect(reverse.volatileMetadataByNodeId.get(firstMetadata.nodeId)).toBe(firstMetadata);
    expect(reverse.volatileMetadataByNodeId.get(secondMetadata.nodeId)).toBe(secondMetadata);
  });

  it.each(["重複した列挙値", "重複したprobe結果", "probe不足", "probe余剰"])(
    "対応関係の不整合を拒否する %s",
    (caseName) => {
      const first = createItem("pull_request", "PR_pair_1");
      const second = createItem("pull_request", "PR_pair_2");
      const firstMetadata = createMetadata("PR_pair_1", "head-1", {});
      const secondMetadata = createMetadata("PR_pair_2", "head-2", {});
      if (caseName === "重複した列挙値") {
        expect(() =>
          finalizeGitHubItemsWithVolatileMetadata({
            items: [first, first],
            volatileMetadata: [firstMetadata],
          }),
        ).toThrow(GitHubResponseValidationError);
        return;
      }
      if (caseName === "重複したprobe結果") {
        expect(() =>
          finalizeGitHubItemsWithVolatileMetadata({
            items: [first],
            volatileMetadata: [firstMetadata, firstMetadata],
          }),
        ).toThrow(GitHubResponseValidationError);
        return;
      }
      if (caseName === "probe不足") {
        expect(() =>
          finalizeGitHubItemsWithVolatileMetadata({
            items: [first, second],
            volatileMetadata: [firstMetadata],
          }),
        ).toThrow(GitHubResponseValidationError);
        return;
      }
      expect(() =>
        finalizeGitHubItemsWithVolatileMetadata({
          items: [first],
          volatileMetadata: [firstMetadata, secondMetadata],
        }),
      ).toThrow(GitHubResponseValidationError);
    },
  );

  it("head SHAの変更を最終item fingerprintへ反映する", () => {
    const item = createItem("pull_request", "PR_head");
    const first = finalizeGitHubItemsWithVolatileMetadata({
      items: [item],
      volatileMetadata: [createMetadata("PR_head", "head-1", {})],
    });
    const second = finalizeGitHubItemsWithVolatileMetadata({
      items: [item],
      volatileMetadata: [createMetadata("PR_head", "head-2", {})],
    });

    expect(first.items[0]).not.toEqual(second.items[0]);
  });

  it("review decision、review request、check、merge stateの変更を反映する", () => {
    const item = createItem("pull_request", "PR_volatile_changes");
    const base = finalizeGitHubItemsWithVolatileMetadata({
      items: [item],
      volatileMetadata: [createMetadata("PR_volatile_changes", "head", {})],
    });
    const reviewRequest = {
      requestNodeId: createGitHubNodeId("RR_volatile_changes"),
      target: {
        status: "identified",
        kind: "actor",
        nodeId: createGitHubNodeId("U_volatile_changes"),
        apiType: "User",
      },
    } satisfies GitHubVolatileReviewRequest;
    const configuredChecks = {
      status: "configured",
      sourceId: buildSourceId("github_status_check_rollup", "SCR_volatile_changes"),
      nodeId: createGitHubNodeId("SCR_volatile_changes"),
      combinedState: "failure",
      contexts: [],
    } satisfies GitHubHeadChecks;
    const changedMetadata = [
      createMetadata("PR_volatile_changes", "head", { reviewDecision: "approved" }),
      createMetadata("PR_volatile_changes", "head", { reviewRequests: [reviewRequest] }),
      createMetadata("PR_volatile_changes", "head", { checks: configuredChecks }),
      createMetadata("PR_volatile_changes", "head", { mergeState: "blocked" }),
    ];

    for (const metadata of changedMetadata) {
      const changed = finalizeGitHubItemsWithVolatileMetadata({
        items: [item],
        volatileMetadata: [metadata],
      });
      expect(changed.items[0]?.itemFingerprint).not.toBe(base.items[0]?.itemFingerprint);
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  createAiCacheEntry,
  createAiCacheKey,
  createCodexAnalysisInput,
  createCodexCacheValidationContext,
  hashCanonicalJson,
  type AiCacheEntry,
  type AiCacheIdentity,
} from "../src/codex/index.js";
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
  restoreGitHubItemCacheRelationMutationResult,
  restoreGitHubItemCache,
  restoreGitHubItemCacheForAnalysis,
  validateGitHubItemCacheAiEntry,
  type CreateGitHubItemCacheDocumentInput,
} from "../src/github/item-cache-adapter.js";
import {
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubItem,
} from "../src/github/item-normalization.js";
import { createPublicRepositoryAllowlist } from "../src/github/public-repository-allowlist.js";
import { parseSha256Hash } from "../src/persistence/canonical-json.js";
import { type GitHubItemCacheDocument } from "../src/persistence/cache-documents.js";
import { type RelationMutationResult } from "../src/graph/relation-mutation.js";

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
const pullRequestClosedAt = createUtcIsoDateTime("2026-01-04T12:00:00Z");
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
  closedAt: pullRequestClosedAt,
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

function createDefaultDocument(): GitHubItemCacheDocument {
  return createDocument({ status: "unavailable" }, { status: "complete", events: [] }, []);
}

function createDocument(
  aiCacheReference: GitHubItemCacheDocument["aiCacheReference"],
  history: GitHubItemCacheDocument["history"],
  relationMutations: readonly RelationMutationResult[],
): GitHubItemCacheDocument {
  return createGitHubItemCacheDocument({
    repository,
    observation,
    state: "closed",
    draftState: "not_applicable",
    analysisRulesFingerprint,
    deterministicRulesVersion: "issue-v1",
    aiAnalysisStatus: aiCacheReference.status === "available" ? "used" : "not_required",
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
    relationMutations,
    replay,
    history,
    analysisFacts: createAnalysisFacts(observation),
    aiCacheReference,
  });
}

function createAnalysisFacts(
  sourceObservation: FreshObservedGitHubItem,
): CreateGitHubItemCacheDocumentInput["analysisFacts"] {
  return {
    bodyEmpty: false,
    explicitRequestCandidates: [
      {
        sourceId: sourceObservation.bodySourceId,
        occurredAt: sourceObservation.createdAt,
      },
    ],
    mentionedWaitingOnCandidates: [],
    inputEvents: sourceObservation.events.map((event) => ({
      sourceId: event.sourceId,
      url: sourceObservation.url,
    })),
    codexValidationContext: {
      schemaVersion: "1" satisfies "1",
      purpose: "semantic_validation_only" satisfies "semantic_validation_only",
      now: sourceObservation.observedAt,
      item: {
        nodeId: sourceObservation.nodeId,
        url: sourceObservation.url,
        type: sourceObservation.type,
      },
      candidates: {
        waitingOn: [],
        relations: [],
      },
      sources: [
        {
          id: sourceObservation.sourceId,
          kind: "item",
          actorType: "system" satisfies "system",
          createdAt: sourceObservation.createdAt,
        },
        {
          id: sourceObservation.bodySourceId,
          kind: "body",
          actorType: "system" satisfies "system",
          createdAt: sourceObservation.createdAt,
        },
      ],
      nativeRelationConstraints: [],
    },
  };
}

function createAiEntryForDocument(document: GitHubItemCacheDocument): AiCacheEntry {
  const inputHash = hashCanonicalJson({ fixture: "item-cache-validation" });
  const identity: AiCacheIdentity = {
    deterministicRulesVersion: "issue-v1",
    model: "fixture-model",
    reasoningEffort: "medium" satisfies "medium",
    backendVersion: "fixture-backend",
    promptVersion: "fixture-prompt",
    schemaVersion: "1",
    inputHash,
  };
  const cacheKey = createAiCacheKey(identity);
  const output = {
    schemaVersion: "2" satisfies "2",
    item: {
      nodeId: document.nodeId,
      url: document.url,
    },
    status: "terminal_completed" satisfies "terminal_completed",
    waitingOn: [],
    nextAction: "完了を確認する",
    relations: [],
    progress: {
      latestMeaningfulSourceId: null,
      reasonSummary: "意味のある進捗を確認する",
      confidence: 1,
    },
    importance: {
      significantFeature: false,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "fixture",
    },
    evidence: [
      {
        sourceId: document.currentObservation.sourceId,
        supports: "status" satisfies "status",
        summary: "現在の状態を確認しました",
      },
    ],
    confidence: 1,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知不要です",
    },
  };
  return createAiCacheEntry({
    cacheKey,
    sourceHash: hashCanonicalJson({ source: "item-cache-validation" }),
    graphNeighborhoodHash: bodyFingerprint,
    repository,
    nodeId: document.nodeId,
    metadata: {
      deterministicRulesVersion: identity.deterministicRulesVersion,
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      backendVersion: identity.backendVersion,
      promptVersion: identity.promptVersion,
      schemaVersion: identity.schemaVersion,
      inputHash,
      outputHash: hashCanonicalJson(output),
      executedAt: observedAt,
    },
    output,
  });
}

describe("GitHub item cache adapter", () => {
  it("安全な観測値、relation候補、replayを作成して同じ入力から復元する", () => {
    const document = createDefaultDocument();
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

  it("relation mutationのedit unionをflat cache形式へ保存し、復元時に戻す", () => {
    const bodySourceId = buildSourceId("github_item_body", nodeId);
    const commentSourceId = buildSourceId("github_issue_comment", "edit-union-comment");
    const editSourceId = buildSourceId("github_user_content_edit", "edit-union");
    const document = createDocument({ status: "unavailable" }, { status: "complete", events: [] }, [
      {
        status: "unknown",
        contentSourceId: bodySourceId,
        reason: "diff_null",
        edit: { status: "unavailable" },
      },
      {
        status: "unknown",
        contentSourceId: commentSourceId,
        reason: "deleted_edit",
        edit: {
          status: "available",
          sourceId: editSourceId,
          editedAt: updatedAt,
          sequence: 0,
        },
      },
    ]);

    expect(document.relationMutations).toEqual([
      {
        status: "unknown",
        contentSourceId: commentSourceId,
        reason: "deleted_edit",
        sourceId: editSourceId,
        editedAt: updatedAt,
        sequence: 0,
      },
      {
        status: "unknown",
        contentSourceId: bodySourceId,
        reason: "diff_null",
      },
    ]);
    expect(document.relationMutations.map(restoreGitHubItemCacheRelationMutationResult)).toEqual([
      {
        status: "unknown",
        contentSourceId: commentSourceId,
        reason: "deleted_edit",
        edit: {
          status: "available",
          sourceId: editSourceId,
          editedAt: updatedAt,
          sequence: 0,
        },
      },
      {
        status: "unknown",
        contentSourceId: bodySourceId,
        reason: "diff_null",
        edit: { status: "unavailable" },
      },
    ]);
  });

  it("warm解析sourceがcold文書の決定論的事実とunknown履歴を保持する", () => {
    const coldDocument = createDocument(
      { status: "unavailable" },
      {
        status: "unavailable",
        reason: "redacted",
      },
      [],
    );
    const restored = restoreGitHubItemCacheForAnalysis(coldDocument, {
      mode: "fresh",
      bodyFingerprint,
      itemFingerprint,
      analysisRulesFingerprint,
    });

    expect(restored.status).toBe("hit");
    if (restored.status !== "hit") {
      throw new Error("item cacheを復元できません");
    }
    expect(restored.source.observation).toMatchObject(coldDocument.currentObservation);
    expect(restored.source.relationCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rel:fixture",
          authority: "inferred",
          provenance: "explicit_text",
        }),
      ]),
    );
    expect(restored.source.relationMutations).toEqual(coldDocument.relationMutations);
    expect(restored.source.replay).toEqual(coldDocument.replay);
    expect(restored.source.analysisFacts).toEqual(coldDocument.analysisFacts);
    expect(restored.source.history).toEqual({
      status: "unavailable",
      reason: "redacted",
    });
    expect(JSON.stringify(coldDocument)).not.toContain("raw本文のfixture");
    expect(JSON.stringify(coldDocument)).not.toContain("raw commentのfixture");
    expect(JSON.stringify(coldDocument)).not.toContain("raw reviewのfixture");
    expect(JSON.stringify(coldDocument)).not.toContain("raw diffのfixture");
    expect(JSON.stringify(coldDocument.analysisFacts.codexValidationContext)).not.toContain(
      "inputHash",
    );
  });

  it("Codex入力からraw値を除いたstrict contextを生成する", () => {
    const input = createCodexAnalysisInput({
      schemaVersion: "1",
      now: observedAt,
      item: {
        nodeId,
        url: itemUrl,
        type: "issue",
        title: "raw title marker",
        content: "raw content marker",
      },
      candidates: {
        waitingOn: [
          {
            id: "requested-user",
            kind: "user",
            sourceIds: [buildSourceId("github_item_body", "I_ITEM_CACHE_ADAPTER")],
          },
        ],
        relations: [
          {
            id: "rel:target",
            targetUrl,
          },
        ],
      },
      sources: [
        {
          id: buildSourceId("github_item_body", "I_ITEM_CACHE_ADAPTER"),
          kind: "body",
          actorType: "human",
          createdAt,
        },
      ],
      deterministicSignals: {
        nativeBlockedBy: ["rel:target"],
      },
      priorAnalysis: null,
    });
    const context = createCodexCacheValidationContext(input);

    expect(context.item).toEqual({
      nodeId,
      url: itemUrl,
      type: "issue",
    });
    expect(JSON.stringify(context)).not.toContain("raw title marker");
    expect(JSON.stringify(context)).not.toContain("raw content marker");
    expect(JSON.stringify(context)).not.toContain("inputHash");
    expect(context.nativeRelationConstraints).toEqual([
      {
        candidateId: "rel:target",
        verdict: "current_is_blocked_by_target",
      },
    ]);
  });

  it("exact AI entryをcache contextのnode、URL、source範囲で再検証する", () => {
    const unavailableDocument = createDefaultDocument();
    const entry = createAiEntryForDocument(unavailableDocument);
    const identityHash = hashCanonicalJson({
      backendVersion: entry.metadata.backendVersion,
      deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
      model: entry.metadata.model,
      promptVersion: entry.metadata.promptVersion,
      reasoningEffort: entry.metadata.reasoningEffort,
      schemaVersion: entry.metadata.schemaVersion,
    });
    const document = createDocument(
      {
        status: "available",
        cacheKey: entry.cacheKey,
        sourceHash: entry.sourceHash,
        inputHash: parseSha256Hash(entry.metadata.inputHash),
        graphNeighborhoodHash: bodyFingerprint,
        identityHash,
      },
      { status: "complete", events: [] },
      [],
    );
    const validation = validateGitHubItemCacheAiEntry(document, {
      status: "available",
      value: entry,
    });

    expect(validation.status).toBe("validated");
    if (validation.status !== "validated") {
      throw new Error("AI entryを検証できません");
    }
    expect(validation.output.item.nodeId).toBe(document.nodeId);
    expect(validation.output.item.url).toBe(document.url);
    expect(validation.output.evidence[0]?.sourceId).toBe(document.currentObservation.sourceId);
    expect(JSON.stringify(document)).not.toContain("完了を確認する");

    const futureEntry = createAiCacheEntry({
      ...entry,
      metadata: {
        ...entry.metadata,
        executedAt: "2026-01-06T00:00:00Z",
      },
    });
    expect(() =>
      validateGitHubItemCacheAiEntry(document, {
        status: "available",
        value: futureEntry,
      }),
    ).toThrow("実行時刻がsemantic validation contextより後です");
  });

  it("AI参照またはentryがない場合はunavailableまたはcache missを返す", () => {
    const document = createDefaultDocument();
    expect(validateGitHubItemCacheAiEntry(document, { status: "missing" })).toEqual({
      status: "unavailable",
      reason: "ai_cache_reference_unavailable",
    });

    const entry = createAiEntryForDocument(document);
    const referencedDocument = createDocument(
      {
        status: "available",
        cacheKey: entry.cacheKey,
        sourceHash: entry.sourceHash,
        inputHash: parseSha256Hash(entry.metadata.inputHash),
        graphNeighborhoodHash: bodyFingerprint,
        identityHash: itemFingerprint,
      },
      { status: "complete", events: [] },
      [],
    );
    expect(validateGitHubItemCacheAiEntry(referencedDocument, { status: "missing" })).toEqual({
      status: "cache_miss",
      reason: "ai_cache_entry_unavailable",
    });
  });

  it("current fingerprintが変われば明示的なcache missにする", () => {
    const result = restoreGitHubItemCache(createDefaultDocument(), {
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
    const result = restoreGitHubItemCache(createDefaultDocument(), {
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
      restoreGitHubItemCache(createDefaultDocument(), {
        mode: "stale",
        failedAt: createUtcIsoDateTime("2026-01-02T23:59:59Z"),
      }),
    ).toThrow("失敗時刻は観測時刻以後");
  });

  it("Pull Requestのmerge時刻とclosedAtが異なっても観測値を保存する", () => {
    const input: CreateGitHubItemCacheDocumentInput = {
      repository,
      observation: pullRequestObservation,
      state: "merged",
      draftState: "ready_for_review",
      analysisRulesFingerprint,
      deterministicRulesVersion: "pull-request-v1",
      aiAnalysisStatus: "not_required",
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
      analysisFacts: createAnalysisFacts(pullRequestObservation),
      aiCacheReference: {
        status: "unavailable",
      },
    };
    const document = createGitHubItemCacheDocument(input);

    expect(document.currentObservation.type).toBe("pull_request");
    if (document.currentObservation.type !== "pull_request") {
      throw new Error("Pull Request観測値ではありません");
    }
    expect(document.lifecycle).toEqual({
      kind: "terminal",
      terminalAt,
      expiresAt: createUtcIsoDateTime("2026-07-03T00:00:00Z"),
    });
    expect(document.currentObservation.closedAt).toBe(pullRequestClosedAt);
    expect(document.currentObservation.mergeState.checks).toMatchObject({
      status: "configured",
      contexts: [{ type: "check_run" }, { type: "commit_status" }],
    });

    if (
      pullRequestReplay.stateEpochs.status !== "known" ||
      pullRequestReplay.currentStateEpoch.status !== "known"
    ) {
      throw new Error("Pull Request replayのstate epochがknownではありません");
    }
    const incorrectEpoch = {
      ...pullRequestReplay.currentStateEpoch.value,
      occurredAt: pullRequestClosedAt,
    };
    const invalidReplay: ReplayItemHistoryResult = {
      ...pullRequestReplay,
      stateEpochs: {
        status: "known",
        value: [...pullRequestReplay.stateEpochs.value.slice(0, -1), incorrectEpoch],
      },
      currentStateEpoch: {
        status: "known",
        value: incorrectEpoch,
      },
    };
    expect(() =>
      createGitHubItemCacheDocument({
        ...input,
        replay: invalidReplay,
      }),
    ).toThrow("terminal itemのcurrent state epochがterminalAtに一致しません");
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
      aiAnalysisStatus: "not_required",
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
      analysisFacts: createAnalysisFacts(manyPullRequestObservation),
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

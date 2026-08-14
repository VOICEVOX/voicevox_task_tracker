import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
} from "../src/domain/index.js";
import {
  assertCacheDocumentSemantic,
  assertCacheDocumentPublicSafety,
  CacheDocumentPublicSafetyError,
  CacheDocumentSchemaError,
  CacheDocumentSemanticError,
  createCacheDocument,
  createCacheTerminalExpiry,
  parseCacheDocument,
  serializeCacheDocument,
  type AiLatestImportanceCacheDocument,
  type CacheRepositoryIdentity,
  type GitHubItemCacheDocument,
  type GitHubRepositoryCacheDocument,
} from "../src/persistence/index.js";

const REPOSITORY: CacheRepositoryIdentity = Object.freeze({
  repositoryId: createGitHubRepositoryId("R_cache_documents"),
  owner: "VOICEVOX",
  name: "example",
});
const ITEM_NODE_ID = createGitHubNodeId("I_cache_documents");
const ACTOR_NODE_ID = createGitHubNodeId("U_cache_documents");
const CREATED_AT = createUtcIsoDateTime("2026-01-01T00:00:00Z");
const UPDATED_AT = createUtcIsoDateTime("2026-01-02T00:00:00Z");
const OBSERVED_AT = createUtcIsoDateTime("2026-02-02T00:00:00Z");
const TERMINAL_AT = createUtcIsoDateTime("2026-02-01T00:00:00Z");
const BODY_FINGERPRINT = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const ITEM_FINGERPRINT = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const RULES_FINGERPRINT = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const CACHE_KEY = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
const SOURCE_HASH = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
const INPUT_HASH = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
const GRAPH_HASH = "sha256:7777777777777777777777777777777777777777777777777777777777777777";
const IDENTITY_HASH = "sha256:8888888888888888888888888888888888888888888888888888888888888888";

function createAvailableAiCacheReference(): GitHubItemCacheDocument["aiCacheReference"] {
  return {
    status: "available",
    cacheKey: CACHE_KEY,
    sourceHash: SOURCE_HASH,
    inputHash: INPUT_HASH,
    graphNeighborhoodHash: GRAPH_HASH,
    identityHash: IDENTITY_HASH,
  };
}

function createOpenIndex(): GitHubRepositoryCacheDocument["items"][number] {
  return {
    nodeId: ITEM_NODE_ID,
    repositoryId: REPOSITORY.repositoryId,
    type: "issue",
    number: 1,
    url: "https://github.com/VOICEVOX/example/issues/1",
    state: "open",
    draftState: "not_applicable",
    bodyFingerprint: BODY_FINGERPRINT,
    itemFingerprint: ITEM_FINGERPRINT,
    analysisRulesFingerprint: RULES_FINGERPRINT,
    deterministicRulesVersion: "issue-v1",
    aiAnalysisStatus: "used",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    observedAt: OBSERVED_AT,
    lifecycle: {
      kind: "open",
    },
  };
}

function createTerminalIndex(): GitHubRepositoryCacheDocument["items"][number] {
  return {
    ...createOpenIndex(),
    state: "closed",
    lifecycle: {
      kind: "terminal",
      terminalAt: TERMINAL_AT,
      expiresAt: createCacheTerminalExpiry(TERMINAL_AT),
    },
  };
}

function createCompleteHistory(): Extract<
  GitHubItemCacheDocument["history"],
  { status: "complete" }
> {
  return {
    status: "complete",
    events: [
      {
        sourceId: buildSourceId("github_event", "first"),
        kind: "assigned",
        sequence: 0,
        occurredAt: createUtcIsoDateTime("2026-01-01T01:00:00Z"),
        actor: {
          status: "identified",
          nodeId: ACTOR_NODE_ID,
        },
        relatedNodeIds: [],
      },
      {
        sourceId: buildSourceId("github_event", "second"),
        kind: "closed",
        sequence: 0,
        occurredAt: createUtcIsoDateTime("2026-02-01T01:00:00Z"),
        actor: {
          status: "unavailable",
        },
        relatedNodeIds: [ACTOR_NODE_ID],
      },
    ],
  };
}

function createCurrentObservation(): GitHubItemCacheDocument["currentObservation"] {
  return {
    freshness: "fresh",
    sourceId: buildSourceId("github_item", ITEM_NODE_ID),
    nodeId: ITEM_NODE_ID,
    repositoryId: REPOSITORY.repositoryId,
    type: "issue",
    number: 1,
    url: "https://github.com/VOICEVOX/example/issues/1",
    title: "cache item",
    bodySourceId: buildSourceId("github_item_body", ITEM_NODE_ID),
    bodyEmpty: true,
    bodyFingerprint: BODY_FINGERPRINT,
    itemFingerprint: ITEM_FINGERPRINT,
    createdAt: CREATED_AT,
    githubUpdatedAt: UPDATED_AT,
    observedAt: OBSERVED_AT,
    state: "closed",
    stateReason: "completed",
    closedAt: TERMINAL_AT,
    draft: "not_applicable",
    author: {
      status: "unavailable",
      reason: "deleted_account",
    },
    assignees: [],
    labels: [],
    milestone: null,
    events: [],
  };
}

function createReplay(): GitHubItemCacheDocument["replay"] {
  type StateEpoch = Extract<
    GitHubItemCacheDocument["replay"]["stateEpochs"],
    { status: "known" }
  >["value"][number];
  const stateEpoch: StateEpoch = {
    occurredAt: TERMINAL_AT,
    sourceIds: [buildSourceId("github_event", "second")],
    state: "closed",
  };
  const initialStateEpoch: StateEpoch = {
    occurredAt: CREATED_AT,
    sourceIds: [buildSourceId("github_item", ITEM_NODE_ID)],
    state: "open",
  };
  type ResponsibilityEpoch = Extract<
    GitHubItemCacheDocument["replay"]["responsibilityEpochs"],
    { status: "known" }
  >["value"][number];
  const responsibilityEpoch: ResponsibilityEpoch = {
    occurredAt: CREATED_AT,
    sourceIds: [buildSourceId("github_item", ITEM_NODE_ID)],
    targets: [],
  };
  return {
    trackingStartAt: CREATED_AT,
    currentState: "closed",
    currentDraft: { status: "not_applicable" },
    currentResponsibilities: [],
    stateEpochs: { status: "known", value: [initialStateEpoch, stateEpoch] },
    currentStateEpoch: { status: "known", value: stateEpoch },
    draftEpochs: { status: "not_applicable" },
    currentDraftEpoch: { status: "not_applicable" },
    responsibilityEpochs: { status: "known", value: [responsibilityEpoch] },
    currentOwnerEpoch: { status: "known", value: responsibilityEpoch },
  };
}

function createValidItem(): GitHubItemCacheDocument {
  const itemSourceId = buildSourceId("github_item", ITEM_NODE_ID);
  const bodySourceId = buildSourceId("github_item_body", ITEM_NODE_ID);
  return {
    schemaVersion: "2",
    kind: "github_item",
    repository: REPOSITORY,
    ...createTerminalIndex(),
    currentObservation: createCurrentObservation(),
    analysisFacts: {
      explicitRequestCandidates: [],
      mentionedWaitingOnCandidates: [],
      inputEvents: [],
      codexValidationContext: {
        schemaVersion: "1",
        purpose: "semantic_validation_only",
        now: OBSERVED_AT,
        item: {
          nodeId: ITEM_NODE_ID,
          url: "https://github.com/VOICEVOX/example/issues/1",
          type: "issue",
        },
        candidates: {
          waitingOn: [],
          relations: [],
        },
        sources: [
          {
            id: itemSourceId,
            kind: "item",
            actorType: "system",
            createdAt: CREATED_AT,
          },
          {
            id: bodySourceId,
            kind: "body",
            actorType: "system",
            createdAt: CREATED_AT,
          },
        ],
        nativeRelationConstraints: [],
      },
    },
    relationCandidates: [],
    relationMutations: [],
    replay: createReplay(),
    history: createCompleteHistory(),
    aiCacheReference: createAvailableAiCacheReference(),
  };
}

type RelationResult = GitHubItemCacheDocument["relationMutations"][number];
type AvailableRelationResult = Extract<RelationResult, { status: "available" }>;
type ExactRelationResult = Omit<AvailableRelationResult, "temporalKnowledge"> & {
  temporalKnowledge: Extract<AvailableRelationResult["temporalKnowledge"], { status: "exact" }>;
};

function createAvailableRelationMutation(): ExactRelationResult {
  type RelationReference = Extract<
    RelationResult,
    { status: "available" }
  >["currentReferences"][number];
  type RelationMutation = Extract<RelationResult, { status: "available" }>["mutations"][number];
  const relation: RelationReference = {
    repositoryOwner: REPOSITORY.owner,
    repositoryName: REPOSITORY.name,
    itemType: "issue",
    number: 2,
  };
  const mutation: RelationMutation = {
    relation,
    action: "added",
    editedAt: UPDATED_AT,
    sourceId: buildSourceId("github_user_content_edit", "edit-1"),
    contentSourceId: buildSourceId("github_item_body", ITEM_NODE_ID),
    sequence: 0,
  };
  const result: ExactRelationResult = {
    status: "available",
    contentSourceId: mutation.contentSourceId,
    currentReferences: [relation],
    replayedReferences: [relation],
    consistency: "consistent",
    temporalKnowledge: {
      status: "exact",
      intervals: [
        {
          status: "active",
          relation,
          addedAt: UPDATED_AT,
          addedSourceIds: [mutation.sourceId],
          lastConfirmedAt: OBSERVED_AT,
        },
      ],
    },
    mutations: [mutation],
    unmatchedRemovals: [],
  };
  return result;
}

function createValidRepository(): GitHubRepositoryCacheDocument {
  return {
    schemaVersion: "2",
    kind: "github_repository",
    repository: REPOSITORY,
    successfulAt: OBSERVED_AT,
    items: [createOpenIndex()],
  };
}

function createValidLatestImportance(): AiLatestImportanceCacheDocument {
  const reference = createAvailableAiCacheReference();
  if (reference.status !== "available") {
    throw new TypeError("latest importance fixtureに利用可能なAI参照がありません");
  }
  return {
    schemaVersion: "2",
    kind: "ai_latest_importance",
    repository: REPOSITORY,
    nodeId: ITEM_NODE_ID,
    importance: {
      significantFeature: true,
      explicitDeadline: false,
      futureRisk: true,
      rationale: "重要度の理由です",
    },
    confidence: 0.8,
    aiCacheReference: {
      status: "available",
      cacheKey: reference.cacheKey,
      sourceHash: reference.sourceHash,
      inputHash: reference.inputHash,
      identityHash: reference.identityHash,
    },
    metadata: {
      deterministicRulesVersion: "issue-v1",
      model: "model-v1",
      reasoningEffort: "medium",
      backendVersion: "backend-v1",
      promptVersion: "prompt-v1",
      analysisSchemaVersion: "analysis-v1",
      executedAt: OBSERVED_AT,
    },
  };
}

describe("cache文書契約", () => {
  it("schema parseとcanonical serializeのround tripが一致する", () => {
    const document = createValidItem();
    const serialized = serializeCacheDocument(document);
    const parsed = parseCacheDocument(serialized);

    expect(parsed).toEqual(document);
    expect(serializeCacheDocument(parsed)).toBe(serialized);
  });

  it("repository cacheとopen lifecycleを検証する", () => {
    const document = createCacheDocument(createValidRepository());

    expect(document.kind).toBe("github_repository");
    if (document.kind !== "github_repository") {
      throw new Error("repository cacheではありません");
    }
    expect(document.items[0]?.lifecycle).toEqual({ kind: "open" });
  });

  it("terminal lifecycleのexpiresAtが180日後なら受け入れる", () => {
    const document = createCacheDocument(createValidItem());

    expect(document.kind).toBe("github_item");
    if (document.kind !== "github_item") {
      throw new Error("item cacheではありません");
    }
    expect(document.lifecycle).toEqual({
      kind: "terminal",
      terminalAt: TERMINAL_AT,
      expiresAt: createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    });
  });

  it.each([
    createUtcIsoDateTime("2026-07-30T23:59:59.999Z"),
    createUtcIsoDateTime("2026-07-31T00:00:00.001Z"),
  ])("terminal lifecycleのexpiresAtが180日と一致しない場合は拒否する: %s", (expiresAt) => {
    const value = {
      ...createValidItem(),
      lifecycle: {
        kind: "terminal",
        terminalAt: TERMINAL_AT,
        expiresAt,
      },
    };

    expect(() => createCacheDocument(value)).toThrow(CacheDocumentSemanticError);
  });

  it("未知のkeyをstrict schemaで拒否する", () => {
    const value: Record<string, unknown> = {
      ...createValidItem(),
      unknown: true,
    };

    expect(() => createCacheDocument(value)).toThrow(CacheDocumentSchemaError);
  });

  it("旧cache schema versionを互換扱いせず拒否する", () => {
    const legacyValue: Record<string, unknown> = {
      ...createValidItem(),
      schemaVersion: "1",
    };

    expect(() => createCacheDocument(legacyValue)).toThrow(CacheDocumentSchemaError);
  });

  it("schema検証のZod error causeとissueCountを保持する", () => {
    let thrown: unknown;
    try {
      createCacheDocument({
        ...createValidItem(),
        unknown: true,
      });
    } catch (error: unknown) {
      thrown = error;
    }
    if (!(thrown instanceof CacheDocumentSchemaError)) {
      throw new Error("CacheDocumentSchemaErrorではありません");
    }

    expect(thrown.cause).toBeInstanceOf(ZodError);
    expect(thrown.issueCount).toBeGreaterThan(0);
  });

  it("型付け済み文書のsemantic検証はschemaと公開安全性を再検証しない", () => {
    const document = createCacheDocument(createValidItem());
    Object.assign(document, { body: "保存禁止の本文" });

    expect(() => {
      assertCacheDocumentSemantic(document);
    }).not.toThrow();
  });

  it("body、diff、raw系fieldを再帰検査して拒否する", () => {
    const value: Record<string, unknown> = {
      ...createValidItem(),
      history: {
        status: "complete",
        events: [],
        nested: {
          rawDiff: "本文ではない値",
        },
      },
    };

    const execute = () => createCacheDocument(value);
    expect(execute).toThrow(CacheDocumentPublicSafetyError);
    expect(execute).toThrow("forbidden_content_field");
  });

  it.each(["commentBody", "reviewBody", "reviewCommentBody", "diff"])(
    "本文系field %s を公開cacheへ保存しない",
    (fieldName) => {
      const value: Record<string, unknown> = {
        ...createValidItem(),
        [fieldName]: "保存禁止の本文",
      };

      expect(() => createCacheDocument(value)).toThrow(CacheDocumentPublicSafetyError);
      expect(() => createCacheDocument(value)).toThrow("forbidden_content_field");
    },
  );

  it("credential fieldとsecret patternを拒否する", () => {
    const value: Record<string, unknown> = {
      ...createValidItem(),
      metadata: {
        token: "github_pat_12345678",
      },
    };

    const execute = () => createCacheDocument(value);
    expect(execute).toThrow(CacheDocumentPublicSafetyError);
    expect(execute).toThrow("credential_field");
    expect(execute).toThrow("secret");
  });

  it("過大な文字列を再帰検査して拒否する", () => {
    const value: Record<string, unknown> = {
      ...createValidItem(),
      extra: "a".repeat(4097),
    };

    expect(() => createCacheDocument(value)).toThrow("oversized_string");
  });

  it("known secretを公開安全性検査で拒否する", () => {
    const document = createValidItem();

    expect(() => {
      assertCacheDocumentPublicSafety({
        document,
        knownSecrets: ["known-secret-value"],
      });
    }).not.toThrow();
    expect(() => {
      assertCacheDocumentPublicSafety({
        document: {
          ...document,
          model: "known-secret-value",
        },
        knownSecrets: ["known-secret-value"],
      });
    }).toThrow("secret");
  });

  it("temporal eventのsource ID重複を拒否する", () => {
    const history = createCompleteHistory();
    const value = {
      ...createValidItem(),
      history: {
        status: "complete",
        events: [history.events[0], history.events[0]],
      },
    };

    expect(() => createCacheDocument(value)).toThrow("source IDが重複");
  });

  it("通知結果をtemporal eventのkindへ保存できない", () => {
    const value = {
      ...createValidItem(),
      history: {
        status: "complete",
        events: [
          {
            ...createCompleteHistory().events[0],
            kind: "notification",
          },
        ],
      },
    };

    expect(() => createCacheDocument(value)).toThrow(CacheDocumentSchemaError);
  });

  it("temporal eventの決定的sort違反を拒否する", () => {
    const history = createCompleteHistory();
    const value = {
      ...createValidItem(),
      history: {
        status: "complete",
        events: [...history.events].reverse(),
      },
    };

    expect(() => createCacheDocument(value)).toThrow("決定的な順序");
  });

  it("repository itemのnode ID昇順違反を拒否する", () => {
    const first = {
      ...createOpenIndex(),
      nodeId: createGitHubNodeId("Z_cache_documents"),
      number: 2,
      url: "https://github.com/VOICEVOX/example/issues/2",
    };
    const second = {
      ...createOpenIndex(),
      nodeId: createGitHubNodeId("A_cache_documents"),
      number: 3,
      url: "https://github.com/VOICEVOX/example/issues/3",
    };
    const value = {
      ...createValidRepository(),
      items: [first, second],
    };

    expect(() => createCacheDocument(value)).toThrow("item node IDが決定的な順序");
  });

  it("temporal eventのrelated node ID昇順違反を拒否する", () => {
    const history = createCompleteHistory();
    const value = {
      ...createValidItem(),
      history: {
        status: "complete",
        events: [
          history.events[0],
          {
            ...history.events[1],
            relatedNodeIds: [
              createGitHubNodeId("Z_cache_documents"),
              createGitHubNodeId("A_cache_documents"),
            ],
          },
        ],
      },
    };

    expect(() => createCacheDocument(value)).toThrow(
      "related node IDが決定的な順序で並んでいません",
    );
  });

  it.each([
    createUtcIsoDateTime("2025-12-31T23:59:59Z"),
    createUtcIsoDateTime("2026-02-02T00:00:01Z"),
  ])("normalized eventが観測範囲外なら拒否する: $occurredAt", (occurredAt) => {
    const value = {
      ...createValidItem(),
      currentObservation: {
        ...createCurrentObservation(),
        events: [
          {
            sourceId: buildSourceId("github_comment", "out-of-range"),
            itemNodeId: ITEM_NODE_ID,
            occurredAt,
            actor: {
              type: "system",
              name: "github",
            },
            kind: "comment",
            bodyFingerprint: BODY_FINGERPRINT,
            bodyEmpty: false,
          },
        ],
      },
    };

    expect(() => createCacheDocument(value)).toThrow("createdAtからobservedAtの範囲");
  });

  it("空のhuman commentをexplicit request候補へ保存できない", () => {
    const document = createValidItem();
    const commentSourceId = buildSourceId("github_comment", "empty-human");
    const value = {
      ...document,
      currentObservation: {
        ...document.currentObservation,
        events: [
          {
            sourceId: commentSourceId,
            itemNodeId: ITEM_NODE_ID,
            occurredAt: UPDATED_AT,
            actor: {
              type: "human" as const,
              nodeId: ACTOR_NODE_ID,
              login: "human",
            },
            kind: "comment" as const,
            bodyFingerprint: BODY_FINGERPRINT,
            bodyEmpty: true,
          },
        ],
      },
      analysisFacts: {
        ...document.analysisFacts,
        inputEvents: [
          {
            sourceId: commentSourceId,
            url: document.url,
          },
        ],
        explicitRequestCandidates: [
          {
            sourceId: commentSourceId,
            occurredAt: UPDATED_AT,
          },
        ],
        codexValidationContext: {
          ...document.analysisFacts.codexValidationContext,
          sources: [
            ...document.analysisFacts.codexValidationContext.sources,
            {
              id: commentSourceId,
              kind: "comment",
              actorType: "human" as const,
              createdAt: UPDATED_AT,
            },
          ],
        },
      },
    };

    expect(() => createCacheDocument(value)).toThrow(
      "空のcommentをexplicit request候補にできません",
    );
  });

  it("explicit request候補のcomment sourceがcontextにない場合は拒否する", () => {
    const document = createValidItem();
    const commentSourceId = buildSourceId("github_comment", "missing-explicit-context");
    const value = {
      ...document,
      currentObservation: {
        ...document.currentObservation,
        events: [
          {
            sourceId: commentSourceId,
            itemNodeId: ITEM_NODE_ID,
            occurredAt: UPDATED_AT,
            actor: {
              type: "human" as const,
              nodeId: ACTOR_NODE_ID,
              login: "human",
            },
            kind: "comment" as const,
            bodyFingerprint: BODY_FINGERPRINT,
            bodyEmpty: false,
          },
        ],
      },
      analysisFacts: {
        ...document.analysisFacts,
        inputEvents: [
          {
            sourceId: commentSourceId,
            url: document.url,
          },
        ],
        explicitRequestCandidates: [
          {
            sourceId: commentSourceId,
            occurredAt: UPDATED_AT,
          },
        ],
      },
    };

    expect(() => createCacheDocument(value)).toThrow(
      "explicit request候補のsource IDがcontextにありません",
    );
  });

  it("mention候補のcomment sourceがcontextにない場合は拒否する", () => {
    const document = createValidItem();
    const commentSourceId = buildSourceId("github_comment", "missing-mention-context");
    const value = {
      ...document,
      currentObservation: {
        ...document.currentObservation,
        events: [
          {
            sourceId: commentSourceId,
            itemNodeId: ITEM_NODE_ID,
            occurredAt: UPDATED_AT,
            actor: {
              type: "human" as const,
              nodeId: ACTOR_NODE_ID,
              login: "human",
            },
            kind: "comment" as const,
            bodyFingerprint: BODY_FINGERPRINT,
            bodyEmpty: false,
          },
        ],
      },
      analysisFacts: {
        ...document.analysisFacts,
        inputEvents: [
          {
            sourceId: commentSourceId,
            url: document.url,
          },
        ],
        mentionedWaitingOnCandidates: [
          {
            id: "requested-user",
            kind: "user" as const,
            sourceIds: [commentSourceId],
          },
        ],
      },
    };

    expect(() => createCacheDocument(value)).toThrow("mention候補のsource IDがcontextにありません");
  });

  it("replay epochの時系列とcurrent値の改ざんを拒否する", () => {
    const document = createValidItem();
    const stateEpochs = document.replay.stateEpochs;
    if (stateEpochs.status !== "known") {
      throw new Error("state epoch fixtureがknownではありません");
    }
    const lastStateEpoch = stateEpochs.value.at(-1);
    if (lastStateEpoch == null) {
      throw new Error("state epoch fixtureが空です");
    }
    expect(() =>
      createCacheDocument({
        ...document,
        replay: {
          ...document.replay,
          stateEpochs: {
            status: "known",
            value: [
              ...stateEpochs.value,
              {
                ...lastStateEpoch,
                occurredAt: createUtcIsoDateTime("2026-02-02T00:00:01Z"),
                sourceIds: [buildSourceId("github_event", "out-of-range-state")],
              },
            ],
          },
        },
      }),
    ).toThrow("createdAtからobservedAtの範囲");
    expect(() =>
      createCacheDocument({
        ...document,
        replay: {
          ...document.replay,
          currentStateEpoch: {
            status: "known",
            value: {
              ...lastStateEpoch,
              state: "open",
            },
          },
        },
      }),
    ).toThrow("current state epochがstate epochの末尾と一致しません");
  });

  it("relation mutation intervalの時刻とcurrent referenceの整合を検証する", () => {
    const relationMutation = createAvailableRelationMutation();
    const interval = relationMutation.temporalKnowledge.intervals[0];
    if (interval == null) {
      throw new Error("relation interval fixtureがありません");
    }
    expect(() =>
      createCacheDocument({
        ...createValidItem(),
        relationMutations: [
          {
            ...relationMutation,
            temporalKnowledge: {
              status: "exact",
              intervals: [
                {
                  ...interval,
                  addedAt: createUtcIsoDateTime("2025-12-31T23:59:59Z"),
                },
              ],
            },
          },
        ],
      }),
    ).toThrow("relation interval.addedAtはcreatedAtからobservedAtの範囲");
    expect(() =>
      createCacheDocument({
        ...createValidItem(),
        relationMutations: [
          {
            ...relationMutation,
            currentReferences: [],
          },
        ],
      }),
    ).toThrow("relation intervalとcurrent referenceが一致しません");
  });

  it("relation mutationのcontent source kindをrelation対象だけに制限する", () => {
    const relationMutation = createAvailableRelationMutation();
    expect(() =>
      createCacheDocument({
        ...createValidItem(),
        relationMutations: [
          {
            ...relationMutation,
            contentSourceId: buildSourceId(
              "github_pull_request_review_comment",
              "cache-review-comment",
            ),
          },
        ],
      }),
    ).toThrow("relation mutationのcontent source kindがrelation対象外です");
  });

  it("relationの削除後再追加をactive intervalとして受理する", () => {
    const relation = {
      repositoryOwner: REPOSITORY.owner,
      repositoryName: REPOSITORY.name,
      itemType: "issue" as const,
      number: 2,
    };
    const contentSourceId = buildSourceId("github_item_body", ITEM_NODE_ID);
    const initialSourceId = buildSourceId("github_user_content_edit", "initial");
    const removedSourceId = buildSourceId("github_user_content_edit", "removed");
    const readdedSourceId = buildSourceId("github_user_content_edit", "readded");
    const document = createValidItem();
    expect(() =>
      createCacheDocument({
        ...document,
        relationMutations: [
          {
            status: "available",
            contentSourceId,
            currentReferences: [relation],
            replayedReferences: [relation],
            consistency: "consistent",
            temporalKnowledge: {
              status: "exact",
              intervals: [
                {
                  status: "removed",
                  relation,
                  addedAt: CREATED_AT,
                  addedSourceIds: [initialSourceId],
                  removedAt: UPDATED_AT,
                  removedSourceIds: [removedSourceId],
                },
                {
                  status: "active",
                  relation,
                  addedAt: OBSERVED_AT,
                  addedSourceIds: [readdedSourceId],
                  lastConfirmedAt: OBSERVED_AT,
                },
              ],
            },
            mutations: [
              {
                relation,
                action: "removed",
                editedAt: UPDATED_AT,
                sourceId: removedSourceId,
                contentSourceId,
                sequence: 0,
              },
              {
                relation,
                action: "added",
                editedAt: OBSERVED_AT,
                sourceId: readdedSourceId,
                contentSourceId,
                sequence: 1,
              },
            ],
            unmatchedRemovals: [],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("GitHubの全ページ取得結果を任意の配列上限で拒否しない", () => {
    const candidateNode = (index: number) => ({
      scope: "organization" as const,
      kind: "issue" as const,
      nodeId: createGitHubNodeId(`I_bulk_${index.toString().padStart(4, "0")}`),
      repositoryOwner: REPOSITORY.owner,
      repositoryName: REPOSITORY.name,
      number: index + 2,
      url: `https://github.com/${REPOSITORY.owner}/${REPOSITORY.name}/issues/${(index + 2).toString()}`,
      state: "open" as const,
    });
    const relationCandidates = Array.from({ length: 1001 }, (_, index) => ({
      id: `rel:bulk-${index.toString().padStart(4, "0")}`,
      sourceIds: [buildSourceId("relation", `bulk-${index.toString().padStart(4, "0")}`)],
      authority: "inferred" as const,
      provenance: "explicit_text" as const,
      relation: {
        type: "unclassified" as const,
        referencing: candidateNode(index),
        referenced: candidateNode(index + 1001),
      },
    }));
    const relationMutationResults = Array.from({ length: 1001 }, (_, index) => ({
      status: "unknown" as const,
      contentSourceId: buildSourceId(
        "github_item_body",
        `bulk-${index.toString().padStart(4, "0")}`,
      ),
      reason: "diff_null" as const,
    }));
    const manySourceIds = Array.from({ length: 31 }, (_, index) =>
      buildSourceId("relation", `source-${index.toString().padStart(3, "0")}`),
    );
    const manyEvents = Array.from({ length: 10001 }, (_, index) => ({
      sourceId: buildSourceId("github_comment", `bulk-${index.toString().padStart(5, "0")}`),
      itemNodeId: ITEM_NODE_ID,
      occurredAt: UPDATED_AT,
      actor: {
        type: "system" as const,
        name: "github",
      },
      kind: "comment" as const,
      bodyFingerprint: BODY_FINGERPRINT,
      bodyEmpty: false,
    }));
    const manyRelatedNodeIds = Array.from({ length: 101 }, (_, index) =>
      createGitHubNodeId(`N_bulk_${index.toString().padStart(3, "0")}`),
    );
    const validItem = createValidItem();

    expect(() =>
      createCacheDocument({
        ...createValidItem(),
        relationCandidates,
      }),
    ).not.toThrow();
    expect(() =>
      createCacheDocument({
        ...createValidItem(),
        relationCandidates: [
          {
            ...relationCandidates[0],
            sourceIds: manySourceIds,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      createCacheDocument({
        ...createValidItem(),
        relationMutations: relationMutationResults,
      }),
    ).not.toThrow();
    expect(() =>
      createCacheDocument({
        ...validItem,
        currentObservation: {
          ...createCurrentObservation(),
          labels: Array.from(
            { length: 101 },
            (_, index) => `label-${index.toString().padStart(3, "0")}`,
          ),
          events: manyEvents,
        },
        analysisFacts: {
          ...validItem.analysisFacts,
          inputEvents: manyEvents.map((event) => ({
            sourceId: event.sourceId,
            url: validItem.url,
          })),
        },
        history: {
          ...createCompleteHistory(),
          events: [
            createCompleteHistory().events[0],
            {
              ...createCompleteHistory().events[1],
              relatedNodeIds: manyRelatedNodeIds,
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it.each([
    { status: "unavailable", reason: "not_returned" },
    { status: "unavailable", reason: "redacted" },
    { status: "unavailable", reason: "cache_miss" },
  ])("history unavailableの理由を保持する: $reason", (history) => {
    const value = {
      ...createValidItem(),
      history,
    };
    const document = createCacheDocument(value);

    expect(document.kind).toBe("github_item");
    if (document.kind !== "github_item") {
      throw new Error("item cacheではありません");
    }
    expect(document.history).toEqual(history);
  });

  it("updatedAtがcreatedAtより前なら拒否する", () => {
    const value = {
      ...createValidItem(),
      createdAt: UPDATED_AT,
      updatedAt: CREATED_AT,
    };

    expect(() => createCacheDocument(value)).toThrow("updatedAtはcreatedAt以後");
  });

  it("updatedAtがobservedAtより後なら拒否する", () => {
    const value = {
      ...createValidItem(),
      updatedAt: createUtcIsoDateTime("2026-02-03T00:00:00Z"),
    };

    expect(() => createCacheDocument(value)).toThrow("updatedAtはobservedAt以前");
  });

  it("trackingStartAtがobservedAtより後なら拒否する", () => {
    const value = {
      ...createValidItem(),
      replay: {
        ...createValidItem().replay,
        trackingStartAt: createUtcIsoDateTime("2026-02-03T00:00:00Z"),
      },
    };

    expect(() => createCacheDocument(value)).toThrow("trackingStartAtはobservedAt以前");
  });

  it("terminal itemのcurrent state epochがterminalAtと一致しなければ拒否する", () => {
    const valid = createValidItem();
    if (valid.replay.stateEpochs.status !== "known") {
      throw new Error("state epochがknownではありません");
    }
    if (valid.replay.currentStateEpoch.status !== "known") {
      throw new Error("current state epochがknownではありません");
    }
    const incorrectEpoch = {
      ...valid.replay.currentStateEpoch.value,
      occurredAt: UPDATED_AT,
    };
    const value = {
      ...valid,
      replay: {
        ...valid.replay,
        stateEpochs: {
          status: "known" as const,
          value: [valid.replay.stateEpochs.value[0], incorrectEpoch],
        },
        currentStateEpoch: {
          status: "known" as const,
          value: incorrectEpoch,
        },
      },
    };

    expect(() => createCacheDocument(value)).toThrow(
      "terminal itemのcurrent state epochがterminalAtとclosedAtに一致しません",
    );
  });

  it("terminalAtがobservedAtより後なら拒否する", () => {
    const terminalAt = createUtcIsoDateTime("2026-02-03T00:00:00Z");
    const value = {
      ...createValidItem(),
      lifecycle: {
        kind: "terminal" as const,
        terminalAt,
        expiresAt: createCacheTerminalExpiry(terminalAt),
      },
    };

    expect(() => createCacheDocument(value)).toThrow("terminalAtはobservedAt以前");
  });

  it("closedAtがobservedAtより後なら拒否する", () => {
    const closedAt = createUtcIsoDateTime("2026-02-03T00:00:00Z");
    const value = {
      ...createValidItem(),
      currentObservation: {
        ...createCurrentObservation(),
        closedAt,
      },
    };

    expect(() => createCacheDocument(value)).toThrow("current observation.closedAt");
  });

  it("complete historyのeventが観測範囲外なら拒否する", () => {
    const value = {
      ...createValidItem(),
      history: {
        status: "complete" as const,
        events: [
          {
            ...createCompleteHistory().events[0],
            occurredAt: createUtcIsoDateTime("2026-02-03T00:00:00Z"),
          },
        ],
      },
    };

    expect(() => createCacheDocument(value)).toThrow("temporal event.occurredAt");
  });

  it("repository itemのobservedAtがsuccessfulAtより後なら拒否する", () => {
    const successfulAt = createUtcIsoDateTime("2026-01-02T00:00:00Z");
    const value = {
      ...createValidRepository(),
      successfulAt,
    };

    expect(() => createCacheDocument(value)).toThrow(
      "repository itemのobservedAtはsuccessfulAt以前",
    );
  });

  it("GitHub URLがrepository、type、numberと一致しなければ拒否する", () => {
    const value = {
      ...createValidItem(),
      url: "https://github.com/VOICEVOX/other/issues/1",
    };

    expect(() => createCacheDocument(value)).toThrow("GitHub URL");
  });

  it("latest importanceは利用可能なAI cache参照を必須にする", () => {
    const value = {
      ...createValidLatestImportance(),
      aiCacheReference: {
        status: "unavailable",
      },
    };

    expect(() => createCacheDocument(value)).toThrow("cache文書のschema検証に失敗しました");
  });

  it("latest importanceのrationaleを非空かつ120文字以内で検証する", () => {
    const validValue = {
      ...createValidLatestImportance(),
      importance: {
        ...createValidLatestImportance().importance,
        rationale: "あ".repeat(120),
      },
    };
    expect(() => createCacheDocument(validValue)).not.toThrow();

    const emptyValue = {
      ...createValidLatestImportance(),
      importance: {
        ...createValidLatestImportance().importance,
        rationale: "",
      },
    };
    expect(() => createCacheDocument(emptyValue)).toThrow(CacheDocumentSchemaError);

    const oversizedValue = {
      ...createValidLatestImportance(),
      importance: {
        ...createValidLatestImportance().importance,
        rationale: "あ".repeat(121),
      },
    };
    expect(() => createCacheDocument(oversizedValue)).toThrow(CacheDocumentSchemaError);
  });

  it("latest importanceのrationaleも公開安全性検査の対象にする", () => {
    const value = {
      ...createValidLatestImportance(),
      importance: {
        ...createValidLatestImportance().importance,
        rationale: "github_pat_12345678",
      },
    };

    expect(() => createCacheDocument(value)).toThrow(CacheDocumentPublicSafetyError);
  });

  it("JSON構文エラーのcauseとissueCountを保持する", () => {
    let thrown: unknown;
    try {
      parseCacheDocument("{");
    } catch (error: unknown) {
      thrown = error;
    }
    if (!(thrown instanceof CacheDocumentSchemaError)) {
      throw new Error("CacheDocumentSchemaErrorではありません");
    }

    expect(thrown.cause).toBeInstanceOf(SyntaxError);
    expect(thrown.issueCount).toBe(1);
  });
});

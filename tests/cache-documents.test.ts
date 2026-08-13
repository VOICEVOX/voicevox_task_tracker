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
const OBSERVED_AT = createUtcIsoDateTime("2026-01-03T00:00:00Z");
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

function createValidItem(): GitHubItemCacheDocument {
  return {
    schemaVersion: "1",
    kind: "github_item",
    repository: REPOSITORY,
    ...createTerminalIndex(),
    history: createCompleteHistory(),
    aiCacheReference: createAvailableAiCacheReference(),
  };
}

function createValidRepository(): GitHubRepositoryCacheDocument {
  return {
    schemaVersion: "1",
    kind: "github_repository",
    repository: REPOSITORY,
    successfulAt: OBSERVED_AT,
    items: [createOpenIndex()],
  };
}

function createValidLatestImportance(): AiLatestImportanceCacheDocument {
  return {
    schemaVersion: "1",
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
    aiCacheReference: createAvailableAiCacheReference(),
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

  it("GitHub URLがrepository、type、numberと一致しなければ拒否する", () => {
    const value = {
      ...createValidItem(),
      url: "https://github.com/VOICEVOX/other/issues/1",
    };

    expect(() => createCacheDocument(value)).toThrow("GitHub URL");
  });

  it("latest importanceは完全一致AI cache参照を必須にする", () => {
    const value = {
      ...createValidLatestImportance(),
      aiCacheReference: {
        status: "unavailable",
      },
    };

    expect(() => createCacheDocument(value)).toThrow("完全一致AI cache参照");
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

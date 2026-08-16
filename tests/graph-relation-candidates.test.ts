import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  type GitHubItemUrl,
  type SourceId,
  type TrackedItemState,
} from "../src/domain/index.js";
import {
  extractRelationCandidates,
  RelationReferenceConflictError,
  type ExtractRelationCandidatesInput,
  type PublicGitHubRelationItem,
  type RelationCandidate,
  type RelationExtractionItem,
  type RelationTextSource,
} from "../src/graph/index.js";

type CreateItemOptions = Readonly<{
  nodeId: string;
  owner: string;
  repository: string;
  type: "issue" | "pull_request";
  number: number;
  state: TrackedItemState;
}>;

type CreateExtractionItemOptions = Readonly<{
  item: PublicGitHubRelationItem;
  body: RelationTextSource;
  comments: readonly RelationTextSource[];
  crossReferences: RelationExtractionItem["crossReferences"];
  nativeDependencies: RelationExtractionItem["nativeDependencies"];
  nativeHierarchy: RelationExtractionItem["nativeHierarchy"];
}>;

function createItem(options: CreateItemOptions): PublicGitHubRelationItem {
  const itemPath = options.type === "issue" ? "issues" : "pull";
  const url =
    `https://github.com/${options.owner}/${options.repository}/${itemPath}/${options.number.toString()}` satisfies GitHubItemUrl;
  return {
    nodeId: createGitHubNodeId(options.nodeId),
    repositoryOwner: options.owner,
    repositoryName: options.repository,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: options.type,
    number: options.number,
    url,
    state: options.state,
  };
}

function createTextSource(kind: string, originalId: string, markdown: string): RelationTextSource {
  return {
    sourceId: buildSourceId(kind, originalId),
    markdown,
  };
}

function createExtractionItem(options: CreateExtractionItemOptions): RelationExtractionItem {
  return {
    ...options.item,
    body: options.body,
    comments: options.comments,
    crossReferences: options.crossReferences,
    nativeDependencies: options.nativeDependencies,
    nativeHierarchy: options.nativeHierarchy,
    nativeClosingIssues: [],
  };
}

function extract(
  item: RelationExtractionItem,
  knownItems: readonly PublicGitHubRelationItem[],
): readonly RelationCandidate[] {
  const input = {
    organization: "VOICEVOX",
    item,
    knownItems,
    relationReferenceAliases: new Map(),
  } satisfies ExtractRelationCandidatesInput;
  return extractRelationCandidates(input);
}

function captureThrownError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new TypeError("期待したエラーが投げられませんでした");
}

function relationDescription(candidate: RelationCandidate): string {
  switch (candidate.relation.type) {
    case "blocks":
      return `blocks:${candidate.relation.blocker.nodeId}->${candidate.relation.blocked.nodeId}`;
    case "parent_of":
      return `parent_of:${candidate.relation.parent.nodeId}->${candidate.relation.subtask.nodeId}`;
    case "implements":
      return `implements:${candidate.relation.implementation.nodeId}->${candidate.relation.target.nodeId}`;
    case "unclassified":
      return `unclassified:${candidate.relation.referencing.nodeId}->${candidate.relation.referenced.nodeId}`;
  }
}

describe("authoritativeな関係候補", () => {
  it("native dependencyのblocked-byとblockingをcanonicalな向きで区別する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const blocker = createItem({
      nodeId: "I_blocker",
      owner: "VOICEVOX",
      repository: "dependency",
      type: "issue",
      number: 2,
      state: "open",
    });
    const blocked = createItem({
      nodeId: "I_blocked",
      owner: "VOICEVOX",
      repository: "consumer",
      type: "issue",
      number: 3,
      state: "open",
    });
    const blockedBySourceId = buildSourceId("github_native_dependency", "blocked-by");
    const blockingSourceId = buildSourceId("github_native_dependency", "blocking");
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: createTextSource("github_item_body", "I_current", ""),
        comments: [],
        crossReferences: [],
        nativeDependencies: [
          {
            sourceId: blockedBySourceId,
            direction: "blocked_by",
            relatedItem: blocker,
          },
          {
            sourceId: blockingSourceId,
            direction: "blocking",
            relatedItem: blocked,
          },
        ],
        nativeHierarchy: [],
      }),
      [],
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.authority === "authoritative")).toBe(true);
    expect(candidates.every((candidate) => candidate.provenance === "native")).toBe(true);
    expect(candidates.map(relationDescription).sort()).toEqual([
      "blocks:I_blocker->I_current",
      "blocks:I_current->I_blocked",
    ]);
    expect(candidates.flatMap((candidate) => candidate.sourceIds).sort()).toEqual(
      [blockedBySourceId, blockingSourceId].sort(),
    );
  });

  it("native parentとsub-issueをauthoritativeな階層として区別する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const parent = createItem({
      nodeId: "I_parent",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const child = createItem({
      nodeId: "I_child",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 3,
      state: "open",
    });
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: createTextSource("github_item_body", "I_current", ""),
        comments: [],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [
          {
            sourceId: buildSourceId("github_native_hierarchy", "parent"),
            relationship: "parent",
            relatedItem: parent,
          },
          {
            sourceId: buildSourceId("github_native_hierarchy", "sub-issue"),
            relationship: "sub_issue",
            relatedItem: child,
          },
        ],
      }),
      [],
    );

    expect(candidates.map(relationDescription).sort()).toEqual([
      "parent_of:I_current->I_child",
      "parent_of:I_parent->I_current",
    ]);
    expect(candidates.every((candidate) => candidate.authority === "authoritative")).toBe(true);
  });

  it("native closingをauthoritativeなimplementsへ昇格して本文候補より優先する", () => {
    const pullRequest = createItem({
      nodeId: "PR_implementation",
      owner: "VOICEVOX",
      repository: "core",
      type: "pull_request",
      number: 10,
      state: "open",
    });
    const issue = createItem({
      nodeId: "I_target",
      owner: "VOICEVOX",
      repository: "core",
      type: "issue",
      number: 11,
      state: "open",
    });
    const nativeSourceId = buildSourceId(
      "github_native_closing_issue",
      "PR_implementation:I_target",
    );
    const candidates = extract(
      {
        ...createExtractionItem({
          item: pullRequest,
          body: createTextSource("github_item_body", "PR_implementation", "close #11"),
          comments: [],
          crossReferences: [],
          nativeDependencies: [],
          nativeHierarchy: [],
        }),
        nativeClosingIssues: [
          {
            sourceId: nativeSourceId,
            relatedItem: issue,
          },
        ],
      },
      [issue],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      authority: "authoritative",
      provenance: "native",
      sourceIds: [nativeSourceId],
      relation: {
        type: "implements",
        implementation: {
          nodeId: pullRequest.nodeId,
        },
        target: {
          nodeId: issue.nodeId,
        },
      },
    });
  });

  it("willCloseTarget付きcross-referenceをauthoritativeなimplementsへ昇格する", () => {
    const issue = createItem({
      nodeId: "I_target",
      owner: "VOICEVOX",
      repository: "core",
      type: "issue",
      number: 11,
      state: "open",
    });
    const pullRequest = createItem({
      nodeId: "PR_implementation",
      owner: "VOICEVOX",
      repository: "core",
      type: "pull_request",
      number: 10,
      state: "open",
    });
    const sourceId = buildSourceId("github_timeline_event", "CRE_closing");
    const candidates = extract(
      createExtractionItem({
        item: issue,
        body: createTextSource("github_item_body", "I_target", ""),
        comments: [],
        crossReferences: [
          {
            sourceId,
            sourceItem: pullRequest,
            willCloseTarget: true,
          },
        ],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [],
    );

    expect(candidates).toMatchObject([
      {
        authority: "authoritative",
        provenance: "native",
        sourceIds: [sourceId],
        relation: {
          type: "implements",
          implementation: {
            nodeId: pullRequest.nodeId,
          },
          target: {
            nodeId: issue.nodeId,
          },
        },
      },
    ]);
  });
});

describe("推定関係候補", () => {
  it("relation aliasはknownItems内の項目だけを参照する", () => {
    const current = createItem({
      nodeId: "I_alias_source",
      owner: "VOICEVOX",
      repository: "alias-source",
      type: "issue",
      number: 1,
      state: "open",
    });
    const input = {
      organization: "VOICEVOX",
      item: createExtractionItem({
        item: current,
        body: createTextSource(
          "github_item_body",
          "I_alias_source",
          "https://github.com/old-owner/old-name/issues/2",
        ),
        comments: [],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      knownItems: [],
      relationReferenceAliases: new Map([["old-owner/old-name#2", current]]),
    } satisfies ExtractRelationCandidatesInput;

    expect(() => extractRelationCandidates(input)).toThrow(
      "relation reference aliasの対象項目がknownItemsにありません",
    );
  });

  it("PRのclosing keywordをimplementsにしblocksにしない", () => {
    const pullRequest = createItem({
      nodeId: "PR_implementation",
      owner: "VOICEVOX",
      repository: "editor",
      type: "pull_request",
      number: 10,
      state: "open",
    });
    const issue = createItem({
      nodeId: "I_feature",
      owner: "VOICEVOX",
      repository: "editor",
      type: "issue",
      number: 11,
      state: "open",
    });
    const bodySourceId = buildSourceId("github_item_body", "PR_implementation");
    const candidates = extract(
      createExtractionItem({
        item: pullRequest,
        body: {
          sourceId: bodySourceId,
          markdown: "Fixes #11",
        },
        comments: [],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [issue],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      authority: "inferred",
      provenance: "closing_keyword",
      sourceIds: [bodySourceId],
      relation: {
        type: "implements",
        implementation: {
          nodeId: pullRequest.nodeId,
        },
        target: {
          nodeId: issue.nodeId,
        },
      },
    });
    expect(candidates.some((candidate) => candidate.relation.type === "blocks")).toBe(false);
  });

  it("入れ子のMarkdown checklistから段階的なparent候補を作る", () => {
    const current = createItem({
      nodeId: "I_release",
      owner: "VOICEVOX",
      repository: "core",
      type: "issue",
      number: 1,
      state: "open",
    });
    const first = createItem({
      nodeId: "I_first",
      owner: "VOICEVOX",
      repository: "core",
      type: "issue",
      number: 2,
      state: "open",
    });
    const second = createItem({
      nodeId: "I_second",
      owner: "VOICEVOX",
      repository: "core",
      type: "issue",
      number: 3,
      state: "open",
    });
    const third = createItem({
      nodeId: "I_third",
      owner: "VOICEVOX",
      repository: "core",
      type: "issue",
      number: 4,
      state: "closed",
    });
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: createTextSource(
          "github_item_body",
          "I_release",
          "- [ ] #2\n  - [ ] #3\n    - [x] #4",
        ),
        comments: [],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [third, first, second],
    );

    expect(candidates.map(relationDescription).sort()).toEqual([
      "parent_of:I_first->I_second",
      "parent_of:I_release->I_first",
      "parent_of:I_second->I_third",
    ]);
    expect(candidates.every((candidate) => candidate.provenance === "checklist")).toBe(true);
    expect(candidates.every((candidate) => candidate.authority === "inferred")).toBe(true);
  });

  it("単なるlinkとcross-referenceをblocksにせず未確定候補に保つ", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const linked = createItem({
      nodeId: "I_linked",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const commented = createItem({
      nodeId: "I_commented",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 3,
      state: "open",
    });
    const inboundSource = createItem({
      nodeId: "PR_inbound",
      owner: "VOICEVOX",
      repository: "consumer",
      type: "pull_request",
      number: 4,
      state: "open",
    });
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: createTextSource(
          "github_item_body",
          "I_current",
          "[関連情報](https://github.com/VOICEVOX/tracker/issues/2)",
        ),
        comments: [createTextSource("github_issue_comment", "IC_related", "Related #3")],
        crossReferences: [
          {
            sourceId: buildSourceId("github_timeline_event", "CRE_inbound"),
            sourceItem: inboundSource,
            willCloseTarget: false,
          },
        ],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [linked, commented],
    );

    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => candidate.authority === "inferred")).toBe(true);
    expect(candidates.every((candidate) => candidate.relation.type === "unclassified")).toBe(true);
    expect(candidates.some((candidate) => candidate.relation.type === "blocks")).toBe(false);
    expect(candidates.map(relationDescription).sort()).toEqual([
      "unclassified:I_current->I_commented",
      "unclassified:I_current->I_linked",
      "unclassified:PR_inbound->I_current",
    ]);
  });

  it("5種類のprovenanceと根拠source IDを保持する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const closing = createItem({
      nodeId: "I_closing",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const checklist = createItem({
      nodeId: "I_checklist",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 3,
      state: "open",
    });
    const explicit = createItem({
      nodeId: "I_explicit",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 4,
      state: "open",
    });
    const inbound = createItem({
      nodeId: "I_inbound",
      owner: "VOICEVOX",
      repository: "other",
      type: "issue",
      number: 5,
      state: "open",
    });
    const native = createItem({
      nodeId: "I_native",
      owner: "VOICEVOX",
      repository: "dependency",
      type: "issue",
      number: 6,
      state: "open",
    });
    const bodySourceId = buildSourceId("github_item_body", "I_current");
    const commentSourceId = buildSourceId("github_issue_comment", "IC_explicit");
    const crossReferenceSourceId = buildSourceId("github_timeline_event", "CRE_inbound");
    const nativeSourceId = buildSourceId("github_native_dependency", "blocked-by");
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: {
          sourceId: bodySourceId,
          markdown: "Resolves #2\n\n- [ ] #3",
        },
        comments: [
          {
            sourceId: commentSourceId,
            markdown: "See #4",
          },
        ],
        crossReferences: [
          {
            sourceId: crossReferenceSourceId,
            sourceItem: inbound,
            willCloseTarget: false,
          },
        ],
        nativeDependencies: [
          {
            sourceId: nativeSourceId,
            direction: "blocked_by",
            relatedItem: native,
          },
        ],
        nativeHierarchy: [],
      }),
      [explicit, checklist, closing],
    );

    expect([...new Set(candidates.map((candidate) => candidate.provenance))].sort()).toEqual([
      "checklist",
      "closing_keyword",
      "cross_reference",
      "explicit_text",
      "native",
    ]);
    expect(candidates.flatMap((candidate) => candidate.sourceIds).sort()).toEqual(
      [bodySourceId, bodySourceId, commentSourceId, crossReferenceSourceId, nativeSourceId].sort(),
    );
  });
});

describe("候補の識別と対象解決", () => {
  it("入力配列の順序によらず同じ候補IDと結果を返す", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const first = createItem({
      nodeId: "I_first",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const second = createItem({
      nodeId: "I_second",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 3,
      state: "open",
    });
    const firstComment = createTextSource("github_issue_comment", "IC_first", "See #2");
    const secondComment = createTextSource("github_issue_comment", "IC_second", "See #3");
    const baseItem = {
      ...current,
      body: createTextSource("github_item_body", "I_current", ""),
      crossReferences: [],
      nativeDependencies: [],
      nativeHierarchy: [],
      nativeClosingIssues: [],
    };
    const firstResult = extract(
      {
        ...baseItem,
        comments: [firstComment, secondComment],
      },
      [first, second],
    );
    const secondResult = extract(
      {
        ...baseItem,
        comments: [secondComment, firstComment],
      },
      [second, first],
    );

    expect(secondResult).toEqual(firstResult);
    expect(firstResult.every((candidate) => /^rel:[0-9a-f]{64}$/u.test(candidate.id))).toBe(true);
  });

  it("Organization外の公開項目を決定論的なexternal referenceへ解決する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const external = createItem({
      nodeId: "I_external",
      owner: "external-org",
      repository: "public-tool",
      type: "issue",
      number: 9,
      state: "open",
    });
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: createTextSource(
          "github_item_body",
          "I_current",
          "See https://github.com/external-org/public-tool/issues/9",
        ),
        comments: [],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [external],
    );

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    if (candidate?.relation.type !== "unclassified") {
      throw new TypeError("external referenceの未確定候補がありません");
    }
    expect(candidate.relation.referenced).toEqual({
      scope: "external_public",
      kind: "external_reference",
      nodeId: "external:github:I_external",
      githubNodeId: "I_external",
      githubItemType: "issue",
      repositoryOwner: "external-org",
      repositoryName: "public-tool",
      number: 9,
      url: "https://github.com/external-org/public-tool/issues/9",
      state: "open",
    });
  });

  it.each([
    {
      description: "archive済み",
      repositoryArchived: true,
      repositoryDisabled: false,
    },
    {
      description: "disabled",
      repositoryArchived: false,
      repositoryDisabled: true,
    },
  ])(
    "Organization外の$description repository参照を候補へ含めない",
    ({ repositoryArchived, repositoryDisabled }) => {
      const current = createItem({
        nodeId: "I_current",
        owner: "VOICEVOX",
        repository: "tracker",
        type: "issue",
        number: 1,
        state: "open",
      });
      const external = {
        ...createItem({
          nodeId: "I_external",
          owner: "external-org",
          repository: "public-tool",
          type: "issue",
          number: 9,
          state: "open",
        }),
        repositoryArchived,
        repositoryDisabled,
      } satisfies PublicGitHubRelationItem;
      const candidates = extract(
        createExtractionItem({
          item: current,
          body: createTextSource(
            "github_item_body",
            "I_current",
            "See https://github.com/external-org/public-tool/issues/9",
          ),
          comments: [],
          crossReferences: [],
          nativeDependencies: [],
          nativeHierarchy: [],
        }),
        [external],
      );

      expect(candidates).toEqual([]);
    },
  );

  it("repository状態が不足した参照入力を拒否する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const external = createItem({
      nodeId: "I_external",
      owner: "external-org",
      repository: "public-tool",
      type: "issue",
      number: 9,
      state: "open",
    });
    Reflect.deleteProperty(external, "repositoryArchived");
    const item = createExtractionItem({
      item: current,
      body: createTextSource(
        "github_item_body",
        "I_current",
        "See https://github.com/external-org/public-tool/issues/9",
      ),
      comments: [],
      crossReferences: [],
      nativeDependencies: [],
      nativeHierarchy: [],
    });

    expect(() => extract(item, [external])).toThrow(
      "公開参照項目のrepository状態はbooleanで指定してください",
    );
  });

  it("未解決参照と想定外のGitHub URL形状を候補へ含めない", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const known = createItem({
      nodeId: "I_known",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: createTextSource(
          "github_item_body",
          "I_current",
          [
            "Unknown #99",
            "https://github.com/VOICEVOX/tracker/issues/2/files",
            "https://github.com/VOICEVOX/tracker/issues/2?query=1",
          ].join("\n"),
        ),
        comments: [],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [known],
    );

    expect(candidates).toEqual([]);
  });

  it("同じ明示参照の複数source IDを1候補へ集約する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const referenced = createItem({
      nodeId: "I_referenced",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const bodySourceId = buildSourceId("github_item_body", "I_current");
    const commentSourceId = buildSourceId("github_issue_comment", "IC_reference");
    const candidates = extract(
      createExtractionItem({
        item: current,
        body: {
          sourceId: bodySourceId,
          markdown: "See #2",
        },
        comments: [
          {
            sourceId: commentSourceId,
            markdown: "Related #2",
          },
        ],
        crossReferences: [],
        nativeDependencies: [],
        nativeHierarchy: [],
      }),
      [referenced],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceIds).toEqual(
      [bodySourceId, commentSourceId].sort() satisfies SourceId[],
    );
  });
});

describe("公開参照項目の衝突", () => {
  it("同じnode IDのstateだけの食い違いをretry対象として識別する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const existing = createItem({
      nodeId: "I_conflict_state",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 2,
      state: "open",
    });
    const incoming = { ...existing, state: "closed" } satisfies PublicGitHubRelationItem;
    const item = createExtractionItem({
      item: current,
      body: createTextSource("github_item_body", "I_current", ""),
      comments: [],
      crossReferences: [],
      nativeDependencies: [],
      nativeHierarchy: [],
    });

    const error = captureThrownError(() => extract(item, [existing, incoming]));

    expect(error).toBeInstanceOf(RelationReferenceConflictError);
    if (!(error instanceof RelationReferenceConflictError)) {
      throw new TypeError("関係参照の衝突エラーではありません");
    }
    expect(error.mismatches).toEqual([
      { field: "state", existingValue: "open", incomingValue: "closed" },
    ]);
    expect(error.isStateOnlyConflict).toBe(true);
  });

  it("同じnode IDの食い違いを安全な値だけとともに保持する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const existing = {
      ...createItem({
        nodeId: "I_conflict",
        owner: "owner-existing-canary",
        repository: "repository-existing-canary",
        type: "issue",
        number: 2,
        state: "closed",
      }),
      repositoryDisabled: true,
    } satisfies PublicGitHubRelationItem;
    const incoming = {
      ...createItem({
        nodeId: "I_conflict",
        owner: "owner-incoming-canary",
        repository: "repository-incoming-canary",
        type: "pull_request",
        number: 3,
        state: "merged",
      }),
      repositoryArchived: true,
    } satisfies PublicGitHubRelationItem;
    const item = createExtractionItem({
      item: current,
      body: createTextSource("github_item_body", "I_current", ""),
      comments: [],
      crossReferences: [],
      nativeDependencies: [],
      nativeHierarchy: [],
    });

    const error = captureThrownError(() => extract(item, [existing, incoming]));

    expect(error).toBeInstanceOf(RelationReferenceConflictError);
    if (!(error instanceof RelationReferenceConflictError)) {
      throw new TypeError("関係参照の衝突エラーではありません");
    }
    expect(error.conflictKind).toBe("node_id");
    expect(error.isStateOnlyConflict).toBe(false);
    expect(error.mismatches).toEqual([
      { field: "repositoryOwner" },
      { field: "repositoryName" },
      {
        field: "repositoryArchived",
        existingValue: false,
        incomingValue: true,
      },
      {
        field: "repositoryDisabled",
        existingValue: true,
        incomingValue: false,
      },
      {
        field: "type",
        existingValue: "issue",
        incomingValue: "pull_request",
      },
      { field: "number" },
      { field: "url" },
      {
        field: "state",
        existingValue: "closed",
        incomingValue: "merged",
      },
    ]);
  });

  it("同じrepositoryと番号の食い違いをnode IDのフィールド名だけで保持する", () => {
    const current = createItem({
      nodeId: "I_current",
      owner: "VOICEVOX",
      repository: "tracker",
      type: "issue",
      number: 1,
      state: "open",
    });
    const existing = createItem({
      nodeId: "I_existing_canary",
      owner: "VOICEVOX",
      repository: "same-repository-canary",
      type: "issue",
      number: 2,
      state: "open",
    });
    const incoming = {
      ...existing,
      nodeId: createGitHubNodeId("I_incoming_canary"),
    } satisfies PublicGitHubRelationItem;
    const item = createExtractionItem({
      item: current,
      body: createTextSource("github_item_body", "I_current", ""),
      comments: [],
      crossReferences: [],
      nativeDependencies: [],
      nativeHierarchy: [],
    });

    const error = captureThrownError(() => extract(item, [existing, incoming]));

    expect(error).toBeInstanceOf(RelationReferenceConflictError);
    if (!(error instanceof RelationReferenceConflictError)) {
      throw new TypeError("関係参照の衝突エラーではありません");
    }
    expect(error.conflictKind).toBe("repository_number");
    expect(error.isStateOnlyConflict).toBe(false);
    expect(error.mismatches).toEqual([{ field: "nodeId" }]);
  });
});

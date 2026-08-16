import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type SourceId,
} from "../src/domain/index.js";
import {
  GitHubPublicBoundaryViolationError,
  createPublicRepositoryAllowlist,
  sanitizeRelationMutationsForPublicBoundary,
} from "../src/github/index.js";
import { type RelationMutationResult } from "../src/graph/relation-mutation.js";

const organization = "VOICEVOX";
const sourceItemNodeId = createGitHubNodeId("I_relation_mutation_boundary_target");
const contentSourceId = buildSourceId("github_item_body", "relation-mutation-boundary-body");
const editedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const editSourceId = buildSourceId("github_user_content_edit", "relation-boundary-edit");
const repositoryId = createGitHubRepositoryId("R_relation_mutation_boundary");
const allowlist = createPublicRepositoryAllowlist([
  {
    id: repositoryId,
    owner: organization,
    name: "allowed",
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt: editedAt,
  },
]);

type AvailableRelationMutationResult = Extract<RelationMutationResult, { status: "available" }>;
type RelationReference = AvailableRelationMutationResult["currentReferences"][number];
type RelationMutation = AvailableRelationMutationResult["mutations"][number];
type RelationInterval = Extract<
  AvailableRelationMutationResult["temporalKnowledge"],
  { status: "exact" }
>["intervals"][number];

function createReference(
  repositoryOwner: string,
  repositoryName: string,
  itemType: RelationReference["itemType"],
  number: number,
): RelationReference {
  return { repositoryOwner, repositoryName, itemType, number };
}

function createMutation(
  relation: RelationReference,
  action: RelationMutation["action"],
): RelationMutation {
  return {
    relation,
    action,
    editedAt,
    sourceId: editSourceId,
    contentSourceId,
    sequence: 0,
  };
}

function createInterval(relation: RelationReference): RelationInterval {
  return {
    status: "active",
    relation,
    addedAt: editedAt,
    addedSourceIds: [editSourceId],
    lastConfirmedAt: editedAt,
  };
}

function createAvailableResult(
  input: Readonly<{
    currentReferences: readonly RelationReference[];
    replayedReferences: readonly RelationReference[];
    mutations: readonly RelationMutation[];
    unmatchedRemovals: readonly RelationMutation[];
    intervals: readonly RelationInterval[];
  }>,
): AvailableRelationMutationResult {
  return {
    status: "available",
    contentSourceId,
    currentReferences: input.currentReferences,
    replayedReferences: input.replayedReferences,
    consistency: "consistent",
    temporalKnowledge: {
      status: "exact",
      intervals: input.intervals,
    },
    mutations: input.mutations,
    unmatchedRemovals: input.unmatchedRemovals,
  };
}

function sanitize(
  relationMutations: readonly RelationMutationResult[],
  verifiedExternalReferences: readonly RelationReference[],
): Readonly<{
  relationMutations: readonly RelationMutationResult[];
  unknownContentSourceCount: number;
}> {
  const currentReferencesByContentSource = new Map<
    SourceId,
    | Readonly<{
        status: "available";
        references: readonly RelationReference[];
      }>
    | Readonly<{
        status: "unknown";
      }>
  >();
  const verifiedExternalReferencesByContentSource = new Map<
    SourceId,
    readonly RelationReference[]
  >();
  for (const currentContentSourceId of new Set(
    relationMutations.map((result) => result.contentSourceId),
  )) {
    const result = relationMutations.find(
      (candidate) => candidate.contentSourceId === currentContentSourceId,
    );
    if (result == null) {
      throw new TypeError("relation mutation test fixtureのsourceがありません");
    }
    currentReferencesByContentSource.set(
      currentContentSourceId,
      result.status === "available"
        ? { status: "available", references: result.currentReferences }
        : { status: "unknown" },
    );
    verifiedExternalReferencesByContentSource.set(
      currentContentSourceId,
      currentContentSourceId === contentSourceId ? verifiedExternalReferences : [],
    );
  }
  return sanitizeRelationMutationsForPublicBoundary({
    sourceItemNodeId,
    organization,
    allowlist,
    currentReferencesByContentSource,
    verifiedExternalReferencesByContentSource,
    relationMutations,
  });
}

function expectUnknownRelationMutation(relationMutation: AvailableRelationMutationResult): void {
  const result = sanitize([relationMutation], []);

  expect(result.unknownContentSourceCount).toBe(1);
  expect(result.relationMutations).toEqual([
    {
      status: "unknown",
      contentSourceId,
      reason: "repository_public_boundary_unverified",
      edit: { status: "unavailable" },
    },
  ]);
}

describe("relation mutation公開境界sanitizer", () => {
  it("current referenceの重複をcanonical keyでまとめて違反を投げる", () => {
    const pullRequest = createReference("VOICEVOX", "not-allowlisted", "pull_request", 42);
    const pullRequestDuplicate = createReference("voicevox", "NOT-ALLOWLISTED", "pull_request", 42);
    const issue = createReference("VOICEVOX", "not-allowlisted", "issue", 42);
    const relationMutation = createAvailableResult({
      currentReferences: [pullRequest, pullRequestDuplicate, issue],
      replayedReferences: [],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });

    let thrown: unknown;
    try {
      sanitize([relationMutation], []);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubPublicBoundaryViolationError);
    if (!(thrown instanceof GitHubPublicBoundaryViolationError)) {
      throw thrown;
    }
    expect(thrown.details).toEqual({
      scope: "cache_item_relation",
      sourceItemNodeId,
      violationKind: "cache_relation_mutation",
      violationCount: 1,
    });
  });

  it("replayedReferencesだけの未証明参照をcontent source全体のunknownにする", () => {
    const currentReference = createReference(organization, "allowed", "issue", 1);
    const historicalReference = createReference(
      organization,
      "unverified-history-repository",
      "pull_request",
      9876,
    );
    const relationMutation = createAvailableResult({
      currentReferences: [currentReference],
      replayedReferences: [historicalReference],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });

    expectUnknownRelationMutation(relationMutation);
  });

  it("mutationsだけの未証明参照をcontent source全体のunknownにする", () => {
    const currentReference = createReference(organization, "allowed", "issue", 1);
    const historicalReference = createReference(
      organization,
      "unverified-mutation-repository",
      "pull_request",
      9877,
    );
    const relationMutation = createAvailableResult({
      currentReferences: [currentReference],
      replayedReferences: [],
      mutations: [createMutation(historicalReference, "added")],
      unmatchedRemovals: [],
      intervals: [],
    });

    expectUnknownRelationMutation(relationMutation);
  });

  it("unmatchedRemovalsだけの未証明参照をcontent source全体のunknownにする", () => {
    const currentReference = createReference(organization, "allowed", "issue", 1);
    const historicalReference = createReference(
      organization,
      "unverified-removal-repository",
      "pull_request",
      9878,
    );
    const relationMutation = createAvailableResult({
      currentReferences: [currentReference],
      replayedReferences: [],
      mutations: [],
      unmatchedRemovals: [createMutation(historicalReference, "removed")],
      intervals: [],
    });

    expectUnknownRelationMutation(relationMutation);
  });

  it("exact intervalだけの未証明参照をunknownにしてraw値を保持しない", () => {
    const currentReference = createReference(organization, "allowed", "issue", 1);
    const historicalReference = createReference(
      organization,
      "unverified-interval-repository",
      "pull_request",
      9879,
    );
    const relationMutation = createAvailableResult({
      currentReferences: [currentReference],
      replayedReferences: [],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [createInterval(historicalReference)],
    });

    const result = sanitize([relationMutation], []);

    expect(result.unknownContentSourceCount).toBe(1);
    expect(result.relationMutations).toEqual([
      {
        status: "unknown",
        contentSourceId,
        reason: "repository_public_boundary_unverified",
        edit: { status: "unavailable" },
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("unverified-interval-repository");
    expect(serialized).not.toContain("9879");
    expect(serialized).not.toContain(sourceItemNodeId);
    expect(serialized).not.toContain("raw-history-diff");
  });

  it("currentの未証明external referenceをfail closedにする", () => {
    const externalReference = createReference("external-owner", "unverified-external", "issue", 2);
    const relationMutation = createAvailableResult({
      currentReferences: [externalReference],
      replayedReferences: [],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });

    let thrown: unknown;
    try {
      sanitize([relationMutation], []);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubPublicBoundaryViolationError);
    if (!(thrown instanceof GitHubPublicBoundaryViolationError)) {
      throw thrown;
    }
    expect(thrown.details).toEqual({
      scope: "cache_item_relation",
      sourceItemNodeId,
      violationKind: "cache_relation_mutation",
      violationCount: 1,
    });
  });

  it("historicalの未証明external referenceをwhole-source unknownにする", () => {
    const currentReference = createReference(organization, "allowed", "issue", 1);
    const externalReference = createReference(
      "external-owner",
      "unverified-external-history",
      "issue",
      3,
    );
    const relationMutation = createAvailableResult({
      currentReferences: [currentReference],
      replayedReferences: [externalReference],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });

    expectUnknownRelationMutation(relationMutation);
  });

  it("proof済みexternal referenceを維持する", () => {
    const externalReference = createReference("external-owner", "public-external", "issue", 4);
    const relationMutation = createAvailableResult({
      currentReferences: [externalReference],
      replayedReferences: [externalReference],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });

    const result = sanitize([relationMutation], [externalReference]);

    expect(result.unknownContentSourceCount).toBe(0);
    expect(result.relationMutations).toEqual([relationMutation]);
  });

  it("別content sourceのproofを流用しない", () => {
    const externalReference = createReference("external-owner", "public-external", "issue", 4);
    const otherContentSourceId = buildSourceId(
      "github_issue_comment",
      "relation-mutation-boundary-comment",
    );
    const relationMutation = {
      ...createAvailableResult({
        currentReferences: [externalReference],
        replayedReferences: [],
        mutations: [],
        unmatchedRemovals: [],
        intervals: [],
      }),
      contentSourceId: otherContentSourceId,
    };

    let thrown: unknown;
    try {
      sanitizeRelationMutationsForPublicBoundary({
        sourceItemNodeId,
        organization,
        allowlist,
        currentReferencesByContentSource: new Map([
          [
            otherContentSourceId,
            { status: "available", references: relationMutation.currentReferences },
          ],
        ]),
        verifiedExternalReferencesByContentSource: new Map([
          [contentSourceId, [externalReference]],
          [otherContentSourceId, []],
        ]),
        relationMutations: [relationMutation],
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubPublicBoundaryViolationError);
  });

  it("allowlist内と既存unknownを変更しない", () => {
    const allowlistedReference = createReference(organization, "allowed", "issue", 1);
    const allowlistedResult = createAvailableResult({
      currentReferences: [allowlistedReference],
      replayedReferences: [allowlistedReference],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });
    const existingUnknown: RelationMutationResult = {
      status: "unknown",
      contentSourceId: buildSourceId("github_item_body", "relation-boundary-other-body"),
      reason: "diff_null",
      edit: { status: "unavailable" },
    };

    const result = sanitize([allowlistedResult, existingUnknown], []);

    expect(result.unknownContentSourceCount).toBe(0);
    expect(result.relationMutations).toEqual([allowlistedResult, existingUnknown]);
  });

  it("同じcontent sourceのmutation結果重複を拒否する", () => {
    const relation = createReference(organization, "allowed", "issue", 1);
    const result = createAvailableResult({
      currentReferences: [relation],
      replayedReferences: [relation],
      mutations: [],
      unmatchedRemovals: [],
      intervals: [],
    });

    expect(() => sanitize([result, result], [])).toThrow(
      "relation mutationの現在参照sourceが一致しません",
    );
  });

  it("top-level unknownでも独立したcurrent参照の未証明を拒否する", () => {
    const externalReference = createReference("external-owner", "public-external", "issue", 4);
    const result: RelationMutationResult = {
      status: "unknown",
      contentSourceId,
      reason: "connection_unavailable",
      edit: { status: "unavailable" },
    };

    let thrown: unknown;
    try {
      sanitizeRelationMutationsForPublicBoundary({
        sourceItemNodeId,
        organization,
        allowlist,
        currentReferencesByContentSource: new Map([
          [contentSourceId, { status: "available", references: [externalReference] }],
        ]),
        verifiedExternalReferencesByContentSource: new Map([[contentSourceId, []]]),
        relationMutations: [result],
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubPublicBoundaryViolationError);
    if (!(thrown instanceof GitHubPublicBoundaryViolationError)) {
      throw thrown;
    }
    expect(thrown.details).toEqual({
      scope: "cache_item_relation",
      sourceItemNodeId,
      violationKind: "cache_relation_mutation",
      violationCount: 1,
    });
  });

  it("current参照のunknownを空配列の証明として扱わない", () => {
    const relationMutation: RelationMutationResult = {
      status: "unknown",
      contentSourceId,
      reason: "connection_unavailable",
      edit: { status: "unavailable" },
    };

    expect(() =>
      sanitizeRelationMutationsForPublicBoundary({
        sourceItemNodeId,
        organization,
        allowlist,
        currentReferencesByContentSource: new Map([[contentSourceId, { status: "unknown" }]]),
        verifiedExternalReferencesByContentSource: new Map([[contentSourceId, []]]),
        relationMutations: [relationMutation],
      }),
    ).not.toThrow();
  });
});

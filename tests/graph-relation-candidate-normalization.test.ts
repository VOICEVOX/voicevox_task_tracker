import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  type GitHubItemUrl,
  type SourceId,
} from "../src/domain/index.js";
import {
  buildRelationCandidateId,
  normalizeRelationCandidates,
  type CandidateBlocksRelation,
  type CandidateImplementsRelation,
  type ClosingKeywordRelationCandidate,
  type NativeRelationCandidate,
  type OrganizationRelationCandidateNode,
} from "../src/graph/index.js";

function createNode(nodeId: string, number: number): OrganizationRelationCandidateNode {
  const url =
    `https://github.com/VOICEVOX/relation-normalization/issues/${number.toString()}` satisfies GitHubItemUrl;
  return Object.freeze({
    scope: "organization",
    kind: "issue",
    nodeId: createGitHubNodeId(nodeId),
    repositoryOwner: "VOICEVOX",
    repositoryName: "relation-normalization",
    number,
    url,
    state: "open",
  });
}

function createNativeCandidate(
  blocker: OrganizationRelationCandidateNode,
  blocked: OrganizationRelationCandidateNode,
  sourceId: SourceId,
): NativeRelationCandidate {
  const relation = Object.freeze({
    type: "blocks",
    blocker,
    blocked,
  }) satisfies CandidateBlocksRelation;
  return Object.freeze({
    id: buildRelationCandidateId("native", relation),
    authority: "authoritative",
    provenance: "native",
    relation,
    sourceIds: Object.freeze([sourceId] satisfies [SourceId, ...SourceId[]]),
  });
}

describe("関係候補の正規化", () => {
  it("候補IDごとにsource IDを統合して決定論的に整列する", () => {
    const first = createNode("I_first", 1);
    const second = createNode("I_second", 2);
    const third = createNode("I_third", 3);
    const firstSourceId = buildSourceId("github_native_dependency", "first-source");
    const secondSourceId = buildSourceId("github_native_dependency", "second-source");
    const thirdSourceId = buildSourceId("github_native_dependency", "third-source");
    const firstCandidate = createNativeCandidate(first, second, firstSourceId);
    const duplicateCandidate = createNativeCandidate(first, second, secondSourceId);
    const otherCandidate = createNativeCandidate(second, third, thirdSourceId);
    const input = [otherCandidate, duplicateCandidate, firstCandidate];

    const normalized = normalizeRelationCandidates(input);
    const mergedCandidate = normalized.find((candidate) => candidate.id === firstCandidate.id);

    expect(normalized.map((candidate) => candidate.id)).toEqual(
      [firstCandidate.id, otherCandidate.id].sort(),
    );
    expect(mergedCandidate?.sourceIds).toEqual([firstSourceId, secondSourceId].sort());
    expect(normalizeRelationCandidates([...input].reverse())).toEqual(normalized);
  });

  it("同じ候補IDに異なる関係が指定された場合は例外にする", () => {
    const blocker = createNode("I_blocker", 1);
    const blocked = createNode("I_blocked", 2);
    const otherBlocked = createNode("I_other_blocked", 3);
    const candidate = createNativeCandidate(
      blocker,
      blocked,
      buildSourceId("github_native_dependency", "original"),
    );
    const conflictingRelation = Object.freeze({
      type: "blocks",
      blocker,
      blocked: otherBlocked,
    }) satisfies CandidateBlocksRelation;
    const conflictingCandidate = Object.freeze({
      id: candidate.id,
      authority: "authoritative",
      provenance: "native",
      relation: conflictingRelation,
      sourceIds: Object.freeze([
        buildSourceId("github_native_dependency", "conflicting"),
      ] satisfies [SourceId, ...SourceId[]]),
    }) satisfies NativeRelationCandidate;

    expect(() => normalizeRelationCandidates([candidate, conflictingCandidate])).toThrowError(
      `同じ候補ID ${candidate.id}に異なる関係が指定されています`,
    );
  });

  it("同じimplements関係のnative候補を本文由来候補より優先する", () => {
    const implementation = createNode("PR_implementation", 1);
    const target = createNode("I_target", 2);
    const relation = Object.freeze({
      type: "implements",
      implementation,
      target,
    }) satisfies CandidateImplementsRelation;
    const nativeCandidate = Object.freeze({
      id: buildRelationCandidateId("native", relation),
      authority: "authoritative",
      provenance: "native",
      relation,
      sourceIds: Object.freeze([
        buildSourceId("github_native_closing_issue", "PR_implementation:I_target"),
      ] satisfies [SourceId, ...SourceId[]]),
    }) satisfies NativeRelationCandidate;
    const inferredCandidate = Object.freeze({
      id: buildRelationCandidateId("closing_keyword", relation),
      authority: "inferred",
      provenance: "closing_keyword",
      relation,
      sourceIds: Object.freeze([buildSourceId("github_item_body", "PR_implementation")] satisfies [
        SourceId,
        ...SourceId[],
      ]),
    }) satisfies ClosingKeywordRelationCandidate;

    expect(normalizeRelationCandidates([inferredCandidate, nativeCandidate])).toEqual([
      nativeCandidate,
    ]);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type GitHubItemUrl,
  type SourceId,
  type TrackedItemState,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  buildRelationCandidateId,
  reconcileGraph,
  type CandidateBlocksRelation,
  type CandidateUnclassifiedRelation,
  type ExplicitTextRelationCandidate,
  type NativeRelationCandidate,
  type OrganizationRelationCandidateNode,
  type ReconcileGraphInput,
  type ReconcileGraphResult,
  type ReconciledGraphEdge,
  type ReconciledGraphState,
  type RelationAssessmentVerdict,
  type RelationCandidate,
  type RelationCandidateAssessment,
} from "../src/graph/index.js";

const EMPTY_GRAPH = {
  edges: [],
  historyEvents: [],
} satisfies ReconciledGraphState;
const SOURCE_OCCURRED_AT = createUtcIsoDateTime("2026-07-29T00:00:00Z");

type CreateNodeOptions = Readonly<{
  nodeId: string;
  repository: string;
  number: number;
  state: TrackedItemState;
}>;

function createNode(options: CreateNodeOptions): OrganizationRelationCandidateNode {
  const url =
    `https://github.com/VOICEVOX/${options.repository}/issues/${options.number.toString()}` satisfies GitHubItemUrl;
  return {
    scope: "organization",
    kind: "issue",
    nodeId: createGitHubNodeId(options.nodeId),
    repositoryOwner: "VOICEVOX",
    repositoryName: options.repository,
    number: options.number,
    url,
    state: options.state,
  };
}

function createExplicitCandidate(
  current: OrganizationRelationCandidateNode,
  target: OrganizationRelationCandidateNode,
  sourceId: SourceId,
): ExplicitTextRelationCandidate {
  const relation = {
    type: "unclassified",
    referencing: current,
    referenced: target,
  } satisfies CandidateUnclassifiedRelation;
  return {
    id: buildRelationCandidateId("explicit_text", relation),
    authority: "inferred",
    provenance: "explicit_text",
    relation,
    sourceIds: [sourceId],
  };
}

function createNativeBlocksCandidate(
  blocker: OrganizationRelationCandidateNode,
  blocked: OrganizationRelationCandidateNode,
  sourceId: SourceId,
): NativeRelationCandidate {
  const relation = {
    type: "blocks",
    blocker,
    blocked,
  } satisfies CandidateBlocksRelation;
  return {
    id: buildRelationCandidateId("native", relation),
    authority: "authoritative",
    provenance: "native",
    relation,
    sourceIds: [sourceId],
  };
}

function createAssessment(
  candidate: RelationCandidate,
  currentNode: OrganizationRelationCandidateNode,
  verdict: RelationAssessmentVerdict,
  confidence: number,
): RelationCandidateAssessment {
  return {
    candidateId: candidate.id,
    currentNodeId: currentNode.nodeId,
    verdict,
    reasonSummary: "fixtureの関係を判定しました",
    sourceIds: candidate.sourceIds,
    confidence,
  };
}

function reconcile(
  previousGraph: ReconciledGraphState,
  candidates: readonly RelationCandidate[],
  assessments: readonly RelationCandidateAssessment[],
  reconciledAt: UtcIsoDateTime,
): ReconcileGraphResult {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const candidate of candidates) {
    for (const sourceId of candidate.sourceIds) {
      sourceOccurredAtById.set(sourceId, SOURCE_OCCURRED_AT);
    }
  }
  const input = {
    previousGraph,
    candidates,
    assessments,
    sourceOccurredAtById,
    minimumInferredConfidence: 0.65,
    reconciledAt,
  } satisfies ReconcileGraphInput;
  return reconcileGraph(input);
}

function findEdge(result: ReconcileGraphResult, candidate: RelationCandidate): ReconciledGraphEdge {
  const edge = result.edges.find((currentEdge) => currentEdge.id === candidate.id);
  if (edge == null) {
    throw new TypeError(`edge ${candidate.id}がありません`);
  }
  return edge;
}

describe("新規edgeのfirstSeenAt", () => {
  it("最古の根拠時刻を使いreconcile時刻だけが違っても同じ値にする", () => {
    const blocked = createNode({
      nodeId: "I_deterministic_blocked",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const blocker = createNode({
      nodeId: "I_deterministic_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const newerSourceId = buildSourceId("github_native_dependency", "newer");
    const olderSourceId = buildSourceId("github_native_dependency", "older");
    const candidates = [
      createNativeBlocksCandidate(blocker, blocked, newerSourceId),
      createNativeBlocksCandidate(blocker, blocked, olderSourceId),
    ];
    const olderOccurredAt = createUtcIsoDateTime("2026-07-10T00:00:00Z");
    const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>([
      [newerSourceId, createUtcIsoDateTime("2026-07-20T00:00:00Z")],
      [olderSourceId, olderOccurredAt],
    ]);
    const commonInput = {
      previousGraph: EMPTY_GRAPH,
      candidates,
      assessments: [],
      sourceOccurredAtById,
      minimumInferredConfidence: 0.65,
    };

    const first = reconcileGraph({
      ...commonInput,
      reconciledAt: createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    });
    const second = reconcileGraph({
      ...commonInput,
      reconciledAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
    });

    expect(first.activeEdges[0]?.firstSeenAt).toBe(olderOccurredAt);
    expect(second.activeEdges[0]?.firstSeenAt).toBe(olderOccurredAt);
    expect(first.activeEdges[0]?.lastConfirmedAt).not.toBe(second.activeEdges[0]?.lastConfirmedAt);
  });

  it("保存済みedgeのfirstSeenAtを根拠時刻で置き換えない", () => {
    const blocked = createNode({
      nodeId: "I_saved_blocked",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const blocker = createNode({
      nodeId: "I_saved_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const sourceId = buildSourceId("github_native_dependency", "saved");
    const candidate = createNativeBlocksCandidate(blocker, blocked, sourceId);
    const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>([
      [sourceId, createUtcIsoDateTime("2026-07-10T00:00:00Z")],
    ]);
    const initial = reconcileGraph({
      previousGraph: EMPTY_GRAPH,
      candidates: [candidate],
      assessments: [],
      sourceOccurredAtById,
      minimumInferredConfidence: 0.65,
      reconciledAt: createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    });
    const initialEdge = initial.activeEdges[0];
    if (initialEdge == null) {
      throw new TypeError("保存済みfirstSeenAt fixtureのedgeがありません");
    }
    const savedFirstSeenAt = createUtcIsoDateTime("2026-07-30T00:00:00Z");
    const savedEdge = {
      ...initialEdge,
      firstSeenAt: savedFirstSeenAt,
    } satisfies ReconciledGraphEdge;

    const reconciled = reconcileGraph({
      previousGraph: {
        edges: [savedEdge],
        historyEvents: [],
      },
      candidates: [candidate],
      assessments: [],
      sourceOccurredAtById,
      minimumInferredConfidence: 0.65,
      reconciledAt: createUtcIsoDateTime("2026-08-01T00:00:00Z"),
    });

    expect(reconciled.activeEdges[0]?.firstSeenAt).toBe(savedFirstSeenAt);
  });

  it("採用候補の根拠時刻を解決できなければ例外にする", () => {
    const blocked = createNode({
      nodeId: "I_missing_time_blocked",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const blocker = createNode({
      nodeId: "I_missing_time_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const candidate = createNativeBlocksCandidate(
      blocker,
      blocked,
      buildSourceId("github_native_dependency", "missing-time"),
    );

    expect(() =>
      reconcileGraph({
        previousGraph: EMPTY_GRAPH,
        candidates: [candidate],
        assessments: [],
        sourceOccurredAtById: new Map<SourceId, UtcIsoDateTime>(),
        minimumInferredConfidence: 0.65,
        reconciledAt: createUtcIsoDateTime("2026-07-31T00:00:00Z"),
      }),
    ).toThrowError(/対応する発生時刻がありません/u);
  });
});

describe("authoritative edgeのreconcile", () => {
  it("AIが反対してもnative edgeを維持して矛盾を注記する", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const blocker = createNode({
      nodeId: "I_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const candidate = createNativeBlocksCandidate(
      blocker,
      current,
      buildSourceId("github_native_dependency", "blocked-by"),
    );
    const result = reconcile(
      EMPTY_GRAPH,
      [candidate],
      [createAssessment(candidate, current, "current_blocks_target", 0.99)],
      createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    );

    expect(result.activeEdges).toHaveLength(1);
    expect(result.activeEdges[0]).toMatchObject({
      id: candidate.id,
      fromNodeId: blocker.nodeId,
      toNodeId: current.nodeId,
      type: "blocks",
      authoritative: true,
      confidence: 1,
      active: true,
    });
    expect(result.activeEdges[0]?.contradictions).toMatchObject([
      {
        verdict: "current_blocks_target",
        confidence: 0.99,
      },
    ]);
    expect(result.activeEdges[0]?.evidence.some((item) => item.supports === "uncertainty")).toBe(
      true,
    );
  });

  it("復元時にevidenceを失った同じ矛盾を変更として検出しない", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const blocker = createNode({
      nodeId: "I_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const candidate = createNativeBlocksCandidate(
      blocker,
      current,
      buildSourceId("github_native_dependency", "continued-contradiction"),
    );
    const assessment = createAssessment(candidate, current, "current_blocks_target", 0.99);
    const first = reconcile(
      EMPTY_GRAPH,
      [candidate],
      [assessment],
      createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    );
    const firstEdge = first.activeEdges[0];
    if (firstEdge == null) {
      throw new TypeError("継続する矛盾の初回edgeがありません");
    }
    const restoredEdge = Object.freeze({
      ...firstEdge,
      contradictions: Object.freeze(
        firstEdge.contradictions.map((contradiction) =>
          Object.freeze({
            verdict: contradiction.verdict,
            confidence: contradiction.confidence,
            evidence: Object.freeze([]),
          }),
        ),
      ),
    }) satisfies ReconciledGraphEdge;

    const second = reconcile(
      {
        edges: [restoredEdge],
        historyEvents: first.historyEvents,
      },
      [candidate],
      [assessment],
      createUtcIsoDateTime("2026-08-01T00:00:00Z"),
    );

    expect(restoredEdge.contradictions[0]?.evidence).toEqual([]);
    expect(second.activeEdges[0]?.contradictions[0]?.evidence.length).toBeGreaterThan(0);
    expect(second.emittedHistoryEvents).toEqual([]);
  });

  it("GitHub上からnative候補が消えたらedgeを非activeにする", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const blocker = createNode({
      nodeId: "I_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const candidate = createNativeBlocksCandidate(
      blocker,
      current,
      buildSourceId("github_native_dependency", "removed-native"),
    );
    const addedAt = createUtcIsoDateTime("2026-07-31T00:00:00Z");
    const removedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
    const added = reconcile(EMPTY_GRAPH, [candidate], [], addedAt);
    const removed = reconcile(added, [], [], removedAt);
    const edge = findEdge(removed, candidate);

    expect(edge).toMatchObject({
      active: false,
      firstSeenAt: SOURCE_OCCURRED_AT,
      lastConfirmedAt: addedAt,
      removedAt,
    });
    expect(removed.activeEdges).toEqual([]);
    expect(removed.emittedHistoryEvents.map((event) => event.kind)).toEqual(["removed"]);
  });
});

describe("Codex verdictのcanonical変換", () => {
  it("AがBを待つ判定をBからAへのblocks edgeにしてblockedByを導出する", () => {
    const current = createNode({
      nodeId: "I_A",
      repository: "consumer",
      number: 1,
      state: "open",
    });
    const target = createNode({
      nodeId: "I_B",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const candidate = createExplicitCandidate(
      current,
      target,
      buildSourceId("github_item_body", "waits-for-B"),
    );
    const result = reconcile(
      EMPTY_GRAPH,
      [candidate],
      [createAssessment(candidate, current, "current_is_blocked_by_target", 0.9)],
      createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    );

    expect(result.activeEdges[0]).toMatchObject({
      fromNodeId: target.nodeId,
      toNodeId: current.nodeId,
      type: "blocks",
      provenance: "explicit_text",
      confidence: 0.9,
      authoritative: false,
    });
    expect(result.activeEdges[0]?.evidence.length).toBeGreaterThan(0);
    expect(
      result.activeEdges[0]?.evidence.every(
        (item) => item.sourceId === candidate.sourceIds[0] && item.supports === "relation",
      ),
    ).toBe(true);
    expect(result.blockedBy).toEqual([
      {
        nodeId: current.nodeId,
        blockedBy: [target.nodeId],
      },
    ]);
  });

  it("全verdictを現在項目から見た表現から正しい型と向きへ変換する", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const verdictFixtures = [
      {
        verdict: "current_is_blocked_by_target",
        type: "blocks",
        direction: "target_to_current",
      },
      {
        verdict: "current_blocks_target",
        type: "blocks",
        direction: "current_to_target",
      },
      {
        verdict: "current_implements_target",
        type: "implements",
        direction: "current_to_target",
      },
      {
        verdict: "target_is_subtask_of_current",
        type: "parent_of",
        direction: "current_to_target",
      },
      {
        verdict: "current_is_subtask_of_target",
        type: "parent_of",
        direction: "target_to_current",
      },
      {
        verdict: "duplicates",
        type: "duplicates",
        direction: "current_to_target",
      },
      {
        verdict: "related",
        type: "related_to",
        direction: "current_to_target",
      },
      {
        verdict: "none",
        type: "none",
        direction: "none",
      },
    ] as const;
    const candidates = verdictFixtures.map((fixture, index) => {
      const target = createNode({
        nodeId: `I_target_${index.toString()}`,
        repository: "target",
        number: index + 2,
        state: "open",
      });
      const candidate = createExplicitCandidate(
        current,
        target,
        buildSourceId("github_issue_comment", `verdict-${index.toString()}`),
      );
      return {
        fixture,
        target,
        candidate,
        assessment: createAssessment(candidate, current, fixture.verdict, 0.9),
      };
    });
    const result = reconcile(
      EMPTY_GRAPH,
      candidates.map((entry) => entry.candidate),
      candidates.map((entry) => entry.assessment),
      createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    );
    const activeEdgesById = new Map(result.activeEdges.map((edge) => [edge.id, edge]));

    for (const entry of candidates) {
      const edge = activeEdgesById.get(entry.candidate.id);
      if (entry.fixture.verdict === "none") {
        expect(edge).toBeUndefined();
        expect(
          result.candidateResolutions.find(
            (resolution) => resolution.candidateId === entry.candidate.id,
          ),
        ).toMatchObject({
          status: "rejected",
          reason: "verdict_none",
        });
        continue;
      }
      expect(edge?.type).toBe(entry.fixture.type);
      const currentToTarget = entry.fixture.direction === "current_to_target";
      expect(edge?.fromNodeId).toBe(currentToTarget ? current.nodeId : entry.target.nodeId);
      expect(edge?.toNodeId).toBe(currentToTarget ? entry.target.nodeId : current.nodeId);
    }

    expect([...new Set(result.activeEdges.map((edge) => edge.type))].sort()).toEqual([
      "blocks",
      "duplicates",
      "implements",
      "parent_of",
      "related_to",
    ]);
  });
});

describe("推定edgeの採否", () => {
  it("AI判定が無い候補と低confidence候補を未確定にしてactive edgeを作らない", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const missingTarget = createNode({
      nodeId: "I_missing",
      repository: "target",
      number: 2,
      state: "open",
    });
    const lowTarget = createNode({
      nodeId: "I_low",
      repository: "target",
      number: 3,
      state: "open",
    });
    const missing = createExplicitCandidate(
      current,
      missingTarget,
      buildSourceId("github_item_body", "missing-assessment"),
    );
    const low = createExplicitCandidate(
      current,
      lowTarget,
      buildSourceId("github_issue_comment", "low-confidence"),
    );
    const result = reconcile(
      EMPTY_GRAPH,
      [missing, low],
      [createAssessment(low, current, "related", 0.64)],
      createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    );

    expect(result.activeEdges).toEqual([]);
    expect(result.candidateResolutions).toHaveLength(2);
    expect(
      result.candidateResolutions.find((resolution) => resolution.candidateId === low.id),
    ).toEqual({
      candidateId: low.id,
      status: "pending",
      reason: "confidence_below_threshold",
      confidence: 0.64,
    });
    expect(
      result.candidateResolutions.find((resolution) => resolution.candidateId === missing.id),
    ).toEqual({
      candidateId: missing.id,
      status: "pending",
      reason: "assessment_missing",
    });
  });

  it("完了した推定blockerをactive graphから外す", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const openBlocker = createNode({
      nodeId: "I_blocker",
      repository: "dependency",
      number: 2,
      state: "open",
    });
    const openCandidate = createExplicitCandidate(
      current,
      openBlocker,
      buildSourceId("github_item_body", "dependency-state"),
    );
    const added = reconcile(
      EMPTY_GRAPH,
      [openCandidate],
      [createAssessment(openCandidate, current, "current_is_blocked_by_target", 0.9)],
      createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    );
    const closedBlocker = createNode({
      nodeId: "I_blocker",
      repository: "dependency",
      number: 2,
      state: "closed",
    });
    const closedCandidate = createExplicitCandidate(
      current,
      closedBlocker,
      buildSourceId("github_item_body", "dependency-state"),
    );
    const removedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
    const removed = reconcile(
      added,
      [closedCandidate],
      [createAssessment(closedCandidate, current, "current_is_blocked_by_target", 0.9)],
      removedAt,
    );

    expect(removed.activeEdges).toEqual([]);
    expect(findEdge(removed, closedCandidate)).toMatchObject({
      active: false,
      removedAt,
    });
    expect(removed.candidateResolutions).toEqual([
      {
        candidateId: closedCandidate.id,
        status: "rejected",
        reason: "blocker_not_open",
        confidence: 0.9,
      },
    ]);
  });

  it("根拠が消えた推定edgeを削除せず非activeで保持する", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const target = createNode({
      nodeId: "I_target",
      repository: "target",
      number: 2,
      state: "open",
    });
    const candidate = createExplicitCandidate(
      current,
      target,
      buildSourceId("github_issue_comment", "deleted-comment"),
    );
    const addedAt = createUtcIsoDateTime("2026-07-31T00:00:00Z");
    const removedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
    const added = reconcile(
      EMPTY_GRAPH,
      [candidate],
      [createAssessment(candidate, current, "related", 0.8)],
      addedAt,
    );
    const removed = reconcile(added, [], [], removedAt);
    const edge = findEdge(removed, candidate);

    expect(removed.edges).toHaveLength(1);
    expect(edge).toEqual({
      ...added.activeEdges[0],
      active: false,
      removedAt,
    });
  });
});

describe("edge履歴", () => {
  it("追加、型とconfidenceの変更、削除を3イベントとして保持する", () => {
    const current = createNode({
      nodeId: "I_current",
      repository: "tracker",
      number: 1,
      state: "open",
    });
    const target = createNode({
      nodeId: "I_target",
      repository: "target",
      number: 2,
      state: "open",
    });
    const candidate = createExplicitCandidate(
      current,
      target,
      buildSourceId("github_item_body", "history"),
    );
    const addedAt = createUtcIsoDateTime("2026-07-31T00:00:00Z");
    const changedAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
    const removedAt = createUtcIsoDateTime("2026-08-02T00:00:00Z");

    const added = reconcile(
      EMPTY_GRAPH,
      [candidate],
      [createAssessment(candidate, current, "related", 0.8)],
      addedAt,
    );
    const changed = reconcile(
      added,
      [candidate],
      [createAssessment(candidate, current, "current_implements_target", 0.9)],
      changedAt,
    );
    const removed = reconcile(changed, [], [], removedAt);
    const edge = findEdge(removed, candidate);

    expect(removed.historyEvents.map((event) => event.kind)).toEqual([
      "added",
      "changed",
      "removed",
    ]);
    expect(removed.historyEvents[1]).toMatchObject({
      kind: "changed",
      changedFields: ["type", "confidence"],
      before: {
        type: "related_to",
        confidence: 0.8,
      },
      after: {
        type: "implements",
        confidence: 0.9,
      },
    });
    expect(edge).toMatchObject({
      active: false,
      firstSeenAt: SOURCE_OCCURRED_AT,
      lastConfirmedAt: changedAt,
      removedAt,
    });
  });
});

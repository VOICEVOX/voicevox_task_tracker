import { describe, expect, it } from "vitest";

import {
  calculateImportance,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type CalculateImportanceInput,
  type ImportanceWeights,
  type TrackedItemMilestone,
} from "../src/domain/index.js";

const EVALUATED_AT = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const weights = Object.freeze({
  priorityLabelMultiplier: 1,
  blockedItem: 3,
  blockedRepository: 5,
  downstreamImpactMax: 30,
  milestoneWithDueDate: 10,
  milestoneDueSoon: 15,
}) satisfies ImportanceWeights;
const levels = Object.freeze({
  high: 40,
  medium: 20,
});
const baseInput = Object.freeze({
  priorityWeight: 0,
  downstreamImpact: Object.freeze({
    openNodeCount: 0,
    repositoryCount: 0,
  }),
  milestone: null,
  evaluatedAt: EVALUATED_AT,
  weights,
  dueSoonDays: 14,
  levels,
}) satisfies CalculateImportanceInput;

function createMilestone(dueOn: string): TrackedItemMilestone {
  return Object.freeze({
    nodeId: createGitHubNodeId(`M_${dueOn}`),
    number: 1,
    title: "重要度テスト",
    state: "open",
    dueOn: createUtcIsoDateTime(dueOn),
  });
}

describe("重要度の決定論的な加点", () => {
  it("優先度ラベルの重みだけを倍率で加点する", () => {
    const importance = calculateImportance({
      ...baseInput,
      priorityWeight: 25,
    });

    expect(importance).toMatchObject({
      score: 25,
      level: "medium",
      factors: [
        {
          kind: "priorityLabel",
          points: 25,
        },
      ],
    });
  });

  it("downstream impactの加点を設定上限で頭打ちにする", () => {
    const importance = calculateImportance({
      ...baseInput,
      downstreamImpact: {
        openNodeCount: 20,
        repositoryCount: 5,
      },
    });

    expect(importance).toMatchObject({
      score: 30,
      level: "medium",
      factors: [
        {
          kind: "downstreamImpact",
          points: 30,
        },
      ],
    });
  });

  it("milestone期限が期限間近日数以内なら追加点を加える", () => {
    const importance = calculateImportance({
      ...baseInput,
      milestone: createMilestone("2026-08-15T00:00:00Z"),
    });

    expect(importance).toMatchObject({
      score: 25,
      level: "medium",
      factors: [
        {
          kind: "milestoneDeadline",
          points: 25,
        },
      ],
    });
  });

  it("milestone期限が期限間近日数より先なら期限付きの点だけを加える", () => {
    const importance = calculateImportance({
      ...baseInput,
      milestone: createMilestone("2026-08-15T00:00:01Z"),
    });

    expect(importance).toMatchObject({
      score: 10,
      level: "low",
      factors: [
        {
          kind: "milestoneDeadline",
          points: 10,
        },
      ],
    });
  });

  it("加点要因がなければscore 0のlowにする", () => {
    expect(calculateImportance(baseInput)).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
  });

  it("要因をpointsの降順に並べて合計からhighを判定する", () => {
    const importance = calculateImportance({
      ...baseInput,
      priorityWeight: 25,
      downstreamImpact: {
        openNodeCount: 2,
        repositoryCount: 1,
      },
      milestone: createMilestone("2026-09-01T00:00:00Z"),
    });

    expect(importance.score).toBe(46);
    expect(importance.level).toBe("high");
    expect(importance.factors.map((factor) => [factor.kind, factor.points])).toEqual([
      ["priorityLabel", 25],
      ["downstreamImpact", 11],
      ["milestoneDeadline", 10],
    ]);
  });

  it("factor合計を整数へ丸めて100で頭打ちにする", () => {
    expect(
      calculateImportance({
        ...baseInput,
        priorityWeight: 100.4,
      }).score,
    ).toBe(100);
    expect(
      calculateImportance({
        ...baseInput,
        priorityWeight: 19.6,
      }),
    ).toMatchObject({
      score: 20,
      level: "medium",
    });
  });

  it("closedまたは期限なしのmilestoneを加点しない", () => {
    const milestone = createMilestone("2026-08-02T00:00:00Z");

    expect(
      calculateImportance({
        ...baseInput,
        milestone: {
          ...milestone,
          state: "closed",
        },
      }).factors,
    ).toEqual([]);
    expect(
      calculateImportance({
        ...baseInput,
        milestone: {
          ...milestone,
          dueOn: null,
        },
      }).factors,
    ).toEqual([]);
  });
});

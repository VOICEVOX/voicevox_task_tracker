import { describe, expect, it } from "vitest";

import {
  calculateAttention,
  type CalculateAttentionInput,
  type ImportanceLevel,
  type SeverityThresholds,
  type StalenessWaitClass,
} from "../src/domain/index.js";

const THRESHOLDS_HOURS = Object.freeze({
  assessment: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  owner: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  decision: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  review: Object.freeze({ watch: 48, urgent: 120, critical: 240 }),
  revision: Object.freeze({ watch: 72, urgent: 168, critical: 336 }),
  reply: Object.freeze({ watch: 48, urgent: 120, critical: 240 }),
  work: Object.freeze({ watch: 168, urgent: 336, critical: 720 }),
  merge: Object.freeze({ watch: 24, urgent: 72, critical: 168 }),
  automation: Object.freeze({ watch: 6, urgent: 24, critical: 72 }),
}) satisfies SeverityThresholds;

const BASE_INPUT = Object.freeze({
  importanceScore: 100,
  elapsedHours: 0,
  waitClass: "assessment",
  thresholdsHours: THRESHOLDS_HOURS,
  recencyFloor: 0.4,
  levels: Object.freeze({
    high: 40,
    medium: 20,
  }),
}) satisfies CalculateAttentionInput;

describe("要対応度", () => {
  it.each([
    { elapsedHours: 0, expectedScore: 100 },
    { elapsedHours: 48, expectedScore: 70 },
    { elapsedHours: 96, expectedScore: 55 },
    { elapsedHours: 480, expectedScore: 40 },
  ])(
    "watch閾値48時間に対して停滞$elapsedHours時間なら$expectedScore点になる",
    ({ elapsedHours, expectedScore }) => {
      expect(
        calculateAttention({
          ...BASE_INPUT,
          elapsedHours,
        }).score,
      ).toBe(expectedScore);
    },
  );

  it("重要度35へ0.7の鮮度係数を掛けた24.5をMath.roundで25にする", () => {
    expect(
      calculateAttention({
        ...BASE_INPUT,
        importanceScore: 35,
        elapsedHours: 48,
      }).score,
    ).toBe(25);
  });

  it("十分に長い停滞時間ではrecencyFloorへ張り付く", () => {
    expect(
      calculateAttention({
        ...BASE_INPUT,
        importanceScore: 50,
        elapsedHours: Number.MAX_VALUE,
      }),
    ).toEqual({
      score: 20,
      level: "medium",
    });
  });

  it("recencyFloorの0と1を鮮度係数の境界として扱う", () => {
    expect(
      calculateAttention({
        ...BASE_INPUT,
        importanceScore: 50,
        elapsedHours: Number.MAX_VALUE,
        recencyFloor: 0,
      }).score,
    ).toBe(0);
    expect(
      calculateAttention({
        ...BASE_INPUT,
        importanceScore: 50,
        elapsedHours: Number.MAX_VALUE,
        recencyFloor: 1,
      }).score,
    ).toBe(50);
  });

  it("停滞時間とwatch閾値の比が同じならwait classが異なっても同じ点数になる", () => {
    const assessment = calculateAttention({
      ...BASE_INPUT,
      elapsedHours: 48,
      waitClass: "assessment",
    });
    const work = calculateAttention({
      ...BASE_INPUT,
      elapsedHours: 168,
      waitClass: "work",
    });

    expect(assessment.score).toBe(70);
    expect(work.score).toBe(assessment.score);
  });

  it.each(["notApplicable", "blockedParent"] satisfies readonly StalenessWaitClass[])(
    "%sは要対応度を0にする",
    (waitClass) => {
      expect(
        calculateAttention({
          ...BASE_INPUT,
          waitClass,
        }),
      ).toEqual({
        score: 0,
        level: "low",
      });
    },
  );

  it.each([
    { importanceScore: 40, expectedLevel: "high" },
    { importanceScore: 20, expectedLevel: "medium" },
    { importanceScore: 19, expectedLevel: "low" },
  ] satisfies readonly {
    importanceScore: number;
    expectedLevel: ImportanceLevel;
  }[])(
    "要対応度$importanceScore点を$expectedLevel levelにする",
    ({ importanceScore, expectedLevel }) => {
      expect(
        calculateAttention({
          ...BASE_INPUT,
          importanceScore,
        }).level,
      ).toBe(expectedLevel);
    },
  );
});

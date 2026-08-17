import { describe, expect, it } from "vitest";

import {
  assertEndToEndPerformanceProfilePassed,
  evaluateEndToEndPerformanceMeasurement,
} from "../src/performance/end-to-end-profile.js";

function createPassingMeasurement() {
  return Object.freeze({
    durationMilliseconds: 1_000,
    githubApi: Object.freeze({
      limit: 15_000,
      used: 5_000,
      remaining: 10_000,
      usedRatio: 1 / 3,
    }),
    codex: Object.freeze({
      calls: 300,
      configuredMaxCalls: 300,
    }),
    webInitialSummary: Object.freeze({
      gzipBytes: 100_000,
      limitBytes: 1_048_576,
    }),
  });
}

describe("end-to-end性能profileの閾値", () => {
  it("全閾値以内なら成功する", () => {
    const profile = evaluateEndToEndPerformanceMeasurement(createPassingMeasurement());

    expect(profile.status).toBe("passed");
    expect(() => {
      assertEndToEndPerformanceProfilePassed(profile);
    }).not.toThrow();
  });

  it.each([
    ["処理時間", { durationMilliseconds: 1_800_001 }],
    [
      "GitHub API予算",
      {
        githubApi: Object.freeze({
          limit: 15_000,
          used: 10_501,
          remaining: 4_499,
          usedRatio: 10_501 / 15_000,
        }),
      },
    ],
    [
      "Codex呼び出し上限",
      {
        codex: Object.freeze({
          calls: 301,
          configuredMaxCalls: 300,
        }),
      },
    ],
    [
      "summary gzip上限",
      {
        webInitialSummary: Object.freeze({
          gzipBytes: 1_048_577,
          limitBytes: 1_048_576,
        }),
      },
    ],
  ])("%sを超えた場合は失敗する", (_name, override) => {
    const profile = evaluateEndToEndPerformanceMeasurement(
      Object.freeze({
        ...createPassingMeasurement(),
        ...override,
      }),
    );

    expect(profile.status).toBe("failed");
    expect(() => {
      assertEndToEndPerformanceProfilePassed(profile);
    }).toThrow("end-to-end性能profileが閾値を満たしません");
  });
});

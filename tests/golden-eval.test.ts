import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  OfflineRunRunner,
  parseCliArguments,
  readGoldenFixtureFiles,
  type GoldenFixture,
  type OfflineAnalysisMetrics,
  type OfflineRunDependencies,
} from "../src/cli/index.js";
import {
  analyzeGoldenFixture,
  evaluateGoldenRegression,
  goldenEvalInputSchema,
  goldenEvalOutputSchema,
  type GoldenFixtureAnalysisResult,
} from "../src/eval/index.js";

const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "golden");
const FIXTURE_NAMES = Object.freeze([
  "author-acknowledgement-after-changes-requested",
  "author-question-after-changes-requested",
  "changes-requested",
  "clear-review-request",
  "cross-repo-umbrella",
  "large",
  "nested-checklist",
  "private-sentinel",
  "prompt-injection",
  "stale-blocker",
]);

type EvaluatedFixture = Readonly<{
  fixture: GoldenFixture;
  analysis: GoldenFixtureAnalysisResult;
}>;

let evaluatedFixtures: readonly EvaluatedFixture[] = Object.freeze([]);

function requireEvaluatedFixture(name: string): EvaluatedFixture {
  const evaluated = evaluatedFixtures.find((candidate) => candidate.fixture.name === name);
  if (evaluated == null) {
    throw new TypeError(`golden fixture ${name}がありません`);
  }
  return evaluated;
}

function emptyMetrics(): OfflineAnalysisMetrics {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    aiRetainedResultCount: 0,
    estimatedInputTokens: 0,
    staleRepositoryCount: 0,
  });
}

function createRegressedOutput(name: string, value: unknown): unknown {
  const output = goldenEvalOutputSchema.parse(value);
  if (output.kind === "large") {
    return output;
  }
  if (name === "clear-review-request") {
    return goldenEvalOutputSchema.parse({
      ...output,
      items: output.items.map((item) =>
        item.nodeId === "clear-review-pr"
          ? {
              ...item,
              severity: "none",
            }
          : item,
      ),
    });
  }
  if (name === "prompt-injection") {
    return goldenEvalOutputSchema.parse({
      ...output,
      notifications: [
        ...output.notifications,
        {
          itemNodeId: "prompt-injection-issue",
          reasonCodes: ["owner_unknown"],
        },
      ],
    });
  }
  return output;
}

beforeAll(async () => {
  const fixtures = await readGoldenFixtureFiles(FIXTURE_ROOT);
  evaluatedFixtures = Object.freeze(
    fixtures.map((fixture) =>
      Object.freeze({
        fixture,
        analysis: analyzeGoldenFixture(fixture.input),
      }),
    ),
  );
});

describe("golden fixture suite", () => {
  it("共通fixture十件を決定論的順序で読み込む", () => {
    expect(evaluatedFixtures.map((evaluated) => evaluated.fixture.name)).toEqual(FIXTURE_NAMES);
  });

  it("各fixtureのstatus、waitingOn、severity、関係、通知候補が期待結果と一致する", () => {
    for (const evaluated of evaluatedFixtures) {
      expect(evaluated.analysis.output, evaluated.fixture.name).toEqual(evaluated.fixture.expected);
    }
  });

  it("standard fixtureは08:00 JSTの通知基準時刻をevaluatedAt以前に明示する", () => {
    for (const evaluated of evaluatedFixtures) {
      const input = goldenEvalInputSchema.parse(evaluated.fixture.input);
      if (input.kind !== "standard") {
        continue;
      }
      const referenceTimestamp = Date.parse(input.notificationReferenceAt);
      const evaluatedTimestamp = Date.parse(input.evaluatedAt);
      const jstReference = new Date(referenceTimestamp + 9 * 60 * 60 * 1000);

      expect(jstReference.getUTCHours(), evaluated.fixture.name).toBe(8);
      expect(jstReference.getUTCMinutes(), evaluated.fixture.name).toBe(0);
      expect(jstReference.getUTCSeconds(), evaluated.fixture.name).toBe(0);
      expect(jstReference.getUTCMilliseconds(), evaluated.fixture.name).toBe(0);
      expect(referenceTimestamp, evaluated.fixture.name).toBeLessThanOrEqual(evaluatedTimestamp);
    }
  });

  it("standard入力は通知基準時刻を必須とし代用時刻を受け付けない", () => {
    const input = goldenEvalInputSchema.parse(
      requireEvaluatedFixture("stale-blocker").fixture.input,
    );
    if (input.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    const withoutReferenceAt = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "notificationReferenceAt"),
    );
    expect(() => goldenEvalInputSchema.parse(withoutReferenceAt)).toThrow();
    expect(() =>
      analyzeGoldenFixture({
        ...input,
        notificationReferenceAt: "2026-08-01T23:00:00.000Z",
      }),
    ).toThrow("evaluatedAt以前");
    expect(() =>
      analyzeGoldenFixture({
        ...input,
        notificationReferenceAt: "2026-07-31T22:00:00.000Z",
      }),
    ).toThrow("08:00 JST");
  });

  it("一回通知は正確なreview requestイベントだけから責務変更を作る", () => {
    const input = goldenEvalInputSchema.parse(
      requireEvaluatedFixture("stale-blocker").fixture.input,
    );
    if (input.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    const output = goldenEvalOutputSchema.parse(
      analyzeGoldenFixture({
        ...input,
        notificationReferenceAt: "2026-07-27T23:00:00.000Z",
      }).output,
    );
    if (output.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    expect(output.notifications).toEqual([
      {
        itemNodeId: "stale-blocker-pr",
        reasonCodes: ["responsibility_changed"],
      },
    ]);
  });

  it("blocked parentのassignee eventはwaitingOnを変えないため責務変更通知にしない", () => {
    const input = goldenEvalInputSchema.parse(
      requireEvaluatedFixture("cross-repo-umbrella").fixture.input,
    );
    if (input.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }
    const blockedParent = input.items.find((item) => item.nodeId === "umbrella-core-issue");
    if (blockedParent?.type !== "issue") {
      throw new TypeError("blocked parent fixtureがありません");
    }
    const assignee = {
      type: "human",
      nodeId: "fixture-blocked-parent-worker",
      login: "blocked-parent-worker",
    } satisfies (typeof blockedParent.assignees)[number];
    const assigneeEvent = {
      kind: "assignee",
      id: "blocked-parent-assigned",
      occurredAt: "2026-07-31T12:00:00.000Z",
      actor: {
        type: "human",
        nodeId: "fixture-maintainer-five",
        login: "maintainer-five",
      },
      assignee,
      action: "added",
    } satisfies (typeof blockedParent.events)[number];
    const modifiedInput = {
      ...input,
      items: input.items.map((item) =>
        item.nodeId === blockedParent.nodeId
          ? {
              ...item,
              assignees: [assignee],
              events: [...item.events, assigneeEvent],
            }
          : item,
      ),
    };
    const output = goldenEvalOutputSchema.parse(analyzeGoldenFixture(modifiedInput).output);
    if (output.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    expect(output.notifications).not.toContainEqual({
      itemNodeId: "umbrella-core-issue",
      reasonCodes: ["responsibility_changed"],
    });
  });

  it("実在ケースのURLとloginをfixtureへ持ち込まない", async () => {
    const sources = await Promise.all(
      FIXTURE_NAMES.map((name) => readFile(join(FIXTURE_ROOT, name, "fixture.json"), "utf8")),
    );
    const source = sources.join("\n");

    expect(source).not.toMatch(
      /voicevox_project|voicevox_engine|voicevox_core|onnxruntime-builder|kanalizer/iu,
    );
    expect(source).not.toMatch(/https:\/\/github\.com\/VOICEVOX\/(?!fixture-)/u);
  });
});

describe("固定AI判定と公開境界", () => {
  it("明確なreview requestをAIなしで判定し、曖昧なchecklistを固定AI結果で判定する", () => {
    const deterministic = goldenEvalOutputSchema.parse(
      requireEvaluatedFixture("clear-review-request").analysis.output,
    );
    const fixedAi = goldenEvalOutputSchema.parse(
      requireEvaluatedFixture("nested-checklist").analysis.output,
    );
    if (deterministic.kind !== "standard" || fixedAi.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    expect(deterministic.fixedAi).toEqual({
      acceptedOutputCount: 0,
      rejectedOutputCount: 0,
      networkCallCount: 0,
    });
    expect(fixedAi.fixedAi).toEqual({
      acceptedOutputCount: 2,
      rejectedOutputCount: 0,
      networkCallCount: 0,
    });
  });

  it("prompt injectionの命令を採用せずschema準拠出力だけを受理する", () => {
    const output = goldenEvalOutputSchema.parse(
      requireEvaluatedFixture("prompt-injection").analysis.output,
    );
    if (output.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    expect(output.items[0]).toMatchObject({
      status: "waiting_for_work",
      waitingOn: [
        {
          candidateId: "reviewer-two",
        },
      ],
    });
    expect(output.fixedAi).toEqual({
      acceptedOutputCount: 1,
      rejectedOutputCount: 1,
      networkCallCount: 0,
    });
  });

  it("private sentinel検出時はstate、Pages、Discord通知候補の公開を停止する", () => {
    const output = goldenEvalOutputSchema.parse(
      requireEvaluatedFixture("private-sentinel").analysis.output,
    );
    if (output.kind !== "standard") {
      throw new TypeError("標準golden fixtureではありません");
    }

    expect(output.publication).toEqual({
      status: "stopped",
      reason: "private_repository_data",
    });
    expect(output.notifications).toEqual([]);
  });
});

describe("回帰基準と性能", () => {
  it("現行fixtureはcritical・urgent再現率と誤通知率の基準を満たす", () => {
    const summary = evaluateGoldenRegression(
      evaluatedFixtures.map((evaluated) => ({
        name: evaluated.fixture.name,
        expected: evaluated.fixture.expected,
        actual: evaluated.analysis.output,
      })),
    );

    expect(summary).toMatchObject({
      status: "passed",
      criticalUrgentRecall: {
        value: 1,
        minimum: 0.95,
        passed: true,
      },
      falseNotificationRate: {
        value: 0,
        maximum: 0.1,
        passed: true,
      },
    });
  });

  it("critical・urgent見落としと誤通知を入れたevalを失敗させる", async () => {
    const evaluatedByInput = new Map(
      evaluatedFixtures.map((evaluated) => [JSON.stringify(evaluated.fixture.input), evaluated]),
    );
    const artifacts: unknown[] = [];
    const dependencies = {
      engine: {
        replayFixture: (fixture) => {
          const evaluated = evaluatedByInput.get(JSON.stringify(fixture.input));
          if (evaluated == null) {
            throw new TypeError("評価済みfixtureがありません");
          }
          return Promise.resolve({
            status: "success" as const,
            output: createRegressedOutput(evaluated.fixture.name, evaluated.analysis.output),
            metrics: emptyMetrics(),
            diagnostics: Object.freeze([]),
          });
        },
        replayState: () => Promise.reject(new TypeError("state replayは実行しません")),
      },
      readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
      readState: () => Promise.reject(new TypeError("stateは読みません")),
      readGoldenFixtures: () =>
        Promise.resolve(evaluatedFixtures.map((evaluated) => evaluated.fixture)),
      writeArtifact: (_path, value) => {
        artifacts.push(value);
        return Promise.resolve();
      },
      writeReport: () => Promise.resolve(),
    } satisfies OfflineRunDependencies;
    const runner = new OfflineRunRunner(dependencies, {
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    const command = parseCliArguments([
      "eval",
      "--fixtures",
      FIXTURE_ROOT,
      "--scheduled-for",
      "2026-08-01T00:00:00.000Z",
    ]);
    if (command.kind !== "eval") {
      throw new TypeError("eval commandではありません");
    }

    const result = await runner.run(command);

    expect(result.report).toMatchObject({
      status: "failure",
      complete: false,
      diagnostics: [expect.stringContaining("golden_regression_threshold_failed")],
    });
    expect(artifacts[0]).toMatchObject({
      status: "failed",
      regression: {
        status: "failed",
        criticalUrgentRecall: {
          passed: false,
        },
        falseNotificationRate: {
          passed: false,
        },
      },
    });
  });

  it("large fixtureを30分以内に処理しsummaryをgzip 1 MiB以内にする", () => {
    const evaluated = requireEvaluatedFixture("large");
    const output = goldenEvalOutputSchema.parse(evaluated.analysis.output);
    if (output.kind !== "large") {
      throw new TypeError("large golden fixtureではありません");
    }

    expect(output).toMatchObject({
      itemCount: 5_000,
      activeEdgeCount: 10_000,
      changedItemCount: 300,
      items: [
        {
          count: 5_000,
          status: "in_progress",
          waitingOn: [
            {
              kind: "role",
              candidateId: "assignee",
              role: "assignee",
            },
          ],
          severity: "none",
        },
      ],
      relations: [
        {
          count: 10_000,
          type: "blocks",
          provenance: "native",
        },
      ],
      notifications: [],
      processingWithinThirtyMinutes: true,
      summaryGzipWithinOneMiB: true,
      githubApiBudgetWithinSeventyPercent: true,
      codexBudgetWithinConfiguredLimit: true,
    });
    expect(evaluated.analysis.diagnostics).toEqual([
      expect.stringMatching(/^large_duration_milliseconds=\d+(?:\.\d+)$/u),
      expect.stringMatching(/^large_summary_gzip_bytes=\d+$/u),
    ]);
  });
});

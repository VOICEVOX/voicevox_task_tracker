import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArguments } from "../src/cli/index.js";

describe("CLI引数解析", () => {
  it("verify-stateのstateディレクトリを解析する", () => {
    expect(parseCliArguments(["verify-state", "--state-directory", "tracker-state/state"])).toEqual(
      {
        kind: "verify-state",
        stateDirectory: "tracker-state/state",
      },
    );
  });

  it("dailyの既定値と明示した予定時刻を解析する", () => {
    expect(parseCliArguments(["daily", "--scheduled-for", "2026-07-31T08:00:00+09:00"])).toEqual({
      kind: "daily",
      configPath: "config.yml",
      reportPath: "artifacts/run-reports/daily.json",
      schedule: {
        kind: "specified",
        value: "2026-07-30T23:00:00.000Z",
      },
    });
  });

  it("dry-runの設定、artifact、reportを解析する", () => {
    expect(
      parseCliArguments([
        "dry-run",
        "--config",
        "fixture.yml",
        "--artifact",
        "output/result.json",
        "--report",
        "output/report.json",
      ]),
    ).toEqual({
      kind: "dry-run",
      configPath: "fixture.yml",
      artifactPath: "output/result.json",
      reportPath: "output/report.json",
      schedule: {
        kind: "current_time",
      },
    });
  });

  it("backfillのmodeと複数repository filterを決定論的順序にする", () => {
    expect(
      parseCliArguments([
        "backfill",
        "--mode",
        "all-open",
        "--repository",
        "VOICEVOX/voicevox_engine",
        "--repository",
        "VOICEVOX/voicevox",
      ]),
    ).toEqual({
      kind: "backfill",
      configPath: "config.yml",
      mode: "all-open",
      repositoryFilter: ["VOICEVOX/voicevox", "VOICEVOX/voicevox_engine"],
      reportPath: "artifacts/run-reports/backfill.json",
      schedule: {
        kind: "current_time",
      },
    });
  });

  it("workflowの各stageと成果物pathを解析する", () => {
    expect(
      parseCliArguments([
        "collect-analyze",
        "--mode",
        "linked",
        "--repository",
        "VOICEVOX/voicevox",
      ]),
    ).toMatchObject({
      kind: "collect-analyze",
      mode: "linked",
      repositoryFilter: ["VOICEVOX/voicevox"],
      artifactPath: "artifacts/workflow/validated-run.json",
    });
    expect(parseCliArguments(["persist-cache"])).toEqual({
      kind: "persist-cache",
      configPath: "config.yml",
      artifactPath: "artifacts/workflow/validated-run.json",
    });
    expect(parseCliArguments(["build-pages"])).toEqual({
      kind: "build-pages",
      configPath: "config.yml",
      artifactPath: "artifacts/workflow/validated-run.json",
      outputDirectory: "artifacts/workflow/pages",
    });
    expect(
      parseCliArguments([
        "notify-discord",
        "--pages-url",
        "https://voicevox.github.io/voicevox_task_tracker/",
      ]),
    ).toEqual({
      kind: "notify-discord",
      configPath: "config.yml",
      artifactPath: "artifacts/workflow/validated-run.json",
      pagesUrl: "https://voicevox.github.io/voicevox_task_tracker/",
    });
    expect(
      parseCliArguments([
        "notify-operations",
        "--kind",
        "collection",
        "--incident-id",
        "collection-run-1",
        "--occurred-at",
        "2026-08-01T00:00:00.000Z",
      ]),
    ).toEqual({
      kind: "notify-operations",
      configPath: "config.yml",
      incidentKind: "collection",
      incidentId: "collection-run-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      retryAttempts: 1,
    });
    expect(
      parseCliArguments([
        "notify-operations",
        "--kind",
        "discord",
        "--incident-id",
        "discord-run-1",
        "--occurred-at",
        "2026-08-01T00:00:00.000Z",
      ]),
    ).toEqual({
      kind: "notify-operations",
      configPath: "config.yml",
      incidentKind: "discord",
      incidentId: "discord-run-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      retryAttempts: 1,
    });
    expect(
      parseCliArguments([
        "report-workflow",
        "--run-id",
        "123456789",
        "--run-attempt",
        "2",
        "--test-eval-result",
        "success",
        "--collect-analyze-result",
        "failure",
        "--persist-cache-result",
        "skipped",
        "--build-pages-result",
        "skipped",
        "--deploy-pages-result",
        "skipped",
        "--notify-discord-result",
        "skipped",
        "--notify-operations-result",
        "success",
      ]),
    ).toEqual({
      kind: "report-workflow",
      collectAnalyzeReportPath: "artifacts/run-reports/collect-analyze.json",
      outputPath: "artifacts/run-reports/workflow.json",
      workflowRunId: "123456789",
      workflowRunAttempt: 2,
      jobResults: {
        "test-eval": "success",
        "collect-analyze": "failure",
        "persist-cache": "skipped",
        "build-pages": "skipped",
        "deploy-pages": "skipped",
        "notify-discord": "skipped",
        "notify-operations": "success",
      },
    });
  });

  it("replayのfixtureとstateを区別する", () => {
    expect(parseCliArguments(["replay", "--fixture", "fixtures/run.json"])).toMatchObject({
      kind: "replay",
      source: {
        kind: "fixture",
        path: "fixtures/run.json",
      },
    });
    expect(parseCliArguments(["replay", "--state", "state/snapshot.json"])).toMatchObject({
      kind: "replay",
      source: {
        kind: "state",
        path: "state/snapshot.json",
      },
    });
  });

  it("evalのfixture pathを解析する", () => {
    expect(parseCliArguments(["eval", "--fixtures", "tests/fixtures/golden"])).toEqual({
      kind: "eval",
      fixturesPath: "tests/fixtures/golden",
      artifactPath: "artifacts/eval.json",
      reportPath: "artifacts/run-reports/eval.json",
      schedule: {
        kind: "current_time",
      },
    });
  });

  it("不正な引数を拒否する", () => {
    const invalidArguments: readonly (readonly string[])[] = [
      [],
      ["unknown"],
      ["daily", "--unknown", "value"],
      ["backfill", "--mode", "invalid"],
      ["backfill", "--mode", "none", "--repository", "VOICEVOX/voicevox"],
      ["backfill", "--mode", "linked", "--repository", "other/repository"],
      ["replay"],
      ["replay", "--fixture", "a.json", "--state", "b.json"],
      ["eval"],
      ["dry-run", "--artifact", "same.json", "--report", "same.json"],
      ["collect-analyze", "--mode", "none", "--repository", "VOICEVOX/voicevox"],
      ["notify-discord"],
      ["notify-discord", "--pages-url", "http://example.com/"],
      ["report-workflow", "--run-id", "123", "--run-attempt", "0"],
      ["persist-state"],
      [
        "report-workflow",
        "--run-id",
        "123",
        "--run-attempt",
        "1",
        "--test-eval-result",
        "success",
        "--collect-analyze-result",
        "success",
        "--persist-state-result",
        "success",
        "--build-pages-result",
        "success",
        "--deploy-pages-result",
        "success",
        "--notify-discord-result",
        "success",
        "--notify-operations-result",
        "skipped",
      ],
    ];
    for (const args of invalidArguments) {
      expect(() => parseCliArguments(args)).toThrow(CliUsageError);
    }
  });
});

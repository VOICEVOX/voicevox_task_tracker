import { describe, expect, it } from "vitest";

import {
  createRunReport,
  createWorkflowRunReport,
  type RunMetrics,
  type RunReport,
  type WorkflowJobResults,
} from "../src/cli/index.js";

const STARTED_AT = "2026-08-01T23:00:00.000Z";
const FINISHED_AT = "2026-08-01T23:00:01.000Z";
const REQUIRED_METRICS = [
  "repositoryCount",
  "itemCount",
  "changedItemCount",
  "activeEdgeCount",
  "aiCallCount",
  "aiCacheHitCount",
  "aiRetainedResultCount",
  "estimatedInputTokens",
  "githubApiRemaining",
  "staleRepositoryCount",
  "notificationCount",
  "scheduleDelayMilliseconds",
  "durationMilliseconds",
];

function metrics(): RunMetrics {
  return Object.freeze({
    repositoryCount: 2,
    itemCount: 3,
    changedItemCount: 1,
    activeEdgeCount: 4,
    aiCallCount: 5,
    aiCacheHitCount: 6,
    aiRetainedResultCount: 7,
    estimatedInputTokens: 7,
    githubApiRemaining: 8,
    staleRepositoryCount: 9,
    notificationCount: 10,
    scheduleDelayMilliseconds: 0,
    durationMilliseconds: 1000,
  });
}

function collectAnalyzeReport(status: "success" | "failure"): RunReport {
  const fields = {
    schemaVersion: "1",
    runId: "tracker-run:workflow-report-fixture",
    command: "collect-analyze",
    scheduledFor: STARTED_AT,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    discordSentAt: null,
    metrics: metrics(),
    diagnostics: [],
  };
  if (status === "failure") {
    return createRunReport({
      ...fields,
      status,
      complete: false,
      failedStage: "incremental_collection",
    });
  }
  return createRunReport({
    ...fields,
    status,
    complete: true,
  });
}

function successfulJobResults(): WorkflowJobResults {
  return Object.freeze({
    "test-eval": "success",
    "collect-analyze": "success",
    "persist-state": "success",
    "build-pages": "success",
    "deploy-pages": "success",
    "notify-discord": "success",
    "notify-operations": "skipped",
  });
}

function expectRequiredMetrics(values: RunMetrics): void {
  expect(Object.keys(values).sort()).toEqual([...REQUIRED_METRICS].sort());
  for (const value of Object.values(values)) {
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

describe("workflow run report", () => {
  it("収集失敗reportの必須metricと全job結果を保持する", () => {
    const report = createWorkflowRunReport({
      workflowRunId: "123456789",
      workflowRunAttempt: 2,
      jobs: {
        "test-eval": "success",
        "collect-analyze": "failure",
        "persist-state": "skipped",
        "build-pages": "skipped",
        "deploy-pages": "skipped",
        "notify-discord": "skipped",
        "notify-operations": "success",
      },
      collectAnalyzeReport: collectAnalyzeReport("failure"),
    });

    expect(report).toMatchObject({
      workflowRunId: "123456789",
      workflowRunAttempt: 2,
      status: "failure",
      complete: false,
      jobs: {
        "collect-analyze": "failure",
        "notify-operations": "success",
      },
    });
    expectRequiredMetrics(report.metrics);
    expect(report.metrics).toEqual(metrics());
    expect(report.collectAnalyzeReport?.status).toBe("failure");
  });

  it("後続jobが失敗したら収集metricを維持してworkflow全体を失敗にする", () => {
    const report = createWorkflowRunReport({
      workflowRunId: "123456789",
      workflowRunAttempt: 1,
      jobs: {
        ...successfulJobResults(),
        "build-pages": "failure",
        "deploy-pages": "skipped",
        "notify-discord": "skipped",
        "notify-operations": "success",
      },
      collectAnalyzeReport: collectAnalyzeReport("success"),
    });

    expect(report.status).toBe("failure");
    expect(report.complete).toBe(false);
    expect(report.jobs["build-pages"]).toBe("failure");
    expectRequiredMetrics(report.metrics);
    expect(report.metrics).toEqual(metrics());
  });

  it("収集report作成前の失敗でも全必須metricを0で記録する", () => {
    const report = createWorkflowRunReport({
      workflowRunId: "123456789",
      workflowRunAttempt: 1,
      jobs: {
        "test-eval": "failure",
        "collect-analyze": "skipped",
        "persist-state": "skipped",
        "build-pages": "skipped",
        "deploy-pages": "skipped",
        "notify-discord": "skipped",
        "notify-operations": "skipped",
      },
      collectAnalyzeReport: null,
    });

    expect(report.status).toBe("failure");
    expect(report.collectAnalyzeReport).toBeNull();
    expectRequiredMetrics(report.metrics);
    expect(Object.values(report.metrics).every((value) => value === 0)).toBe(true);
  });
});

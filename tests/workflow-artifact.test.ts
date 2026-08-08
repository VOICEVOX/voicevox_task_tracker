import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CliWorkflowArtifactError,
  WorkflowStageRunner,
  assertWorkflowArtifactPublicSafety,
  createWorkflowArtifact,
  parseCliArguments,
  readWorkflowArtifactFile,
  type WorkflowArtifact,
  type WorkflowRunMetadata,
  type WorkflowStageCliCommand,
} from "../src/cli/index.js";
import { StatePublicSafetyError } from "../src/persistence/index.js";

const NOW = "2026-07-31T00:00:00.000Z";
const PAGES_URL = "https://voicevox.github.io/voicevox_task_tracker/";

function emptyRunMetadataMetrics(): WorkflowRunMetadata["metrics"] {
  return Object.freeze({
    repositoryCount: 0,
    itemCount: 0,
    changedItemCount: 0,
    activeEdgeCount: 0,
    aiCallCount: 0,
    aiCacheHitCount: 0,
    estimatedInputTokens: 0,
    githubApiRemaining: 0,
    staleRepositoryCount: 0,
    scheduleDelayMilliseconds: 0,
  });
}

function createEmptyWorkflowArtifact(): WorkflowArtifact {
  const runId = "tracker-run:workflow-artifact-fixture";
  return createWorkflowArtifact({
    schemaVersion: "1",
    kind: "validated_public_run",
    repositoryAllowlist: [],
    historyInputEvents: [],
    snapshot: {
      schemaVersion: "7",
      generatedAt: NOW,
      trackingStartAt: {
        status: "fixed",
        value: NOW,
        source: "first_complete_run",
      },
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
      collection: {
        repositories: [],
      },
      repositories: [],
      items: [],
      externalReferences: [],
      relations: [],
      run: {
        id: runId,
        status: "success",
        complete: true,
      },
    },
    notificationLedger: {
      schemaVersion: "2",
      entries: [],
      operationsAlerts: [],
    },
    notificationSelection: {
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
      ledgerReservations: [],
    },
    runMetadata: {
      scheduledFor: NOW,
      startedAt: NOW,
      metrics: emptyRunMetadataMetrics(),
      diagnostics: [],
    },
    aiCacheEntries: [],
    pagesUrl: PAGES_URL,
    discordSettings: {
      enabled: false,
      webhookSecretName: "DISCORD_WEBHOOK_URL",
      operationsWebhookSecretName: "DISCORD_WEBHOOK_URL",
      mentions: {
        enabled: false,
        users: {},
      },
      retry: {
        maxAttempts: 3,
        initialDelaySeconds: 1,
        maxDelaySeconds: 10,
      },
    },
  });
}

function parseWorkflowStageCommand(args: readonly string[]): WorkflowStageCliCommand {
  const command = parseCliArguments(args);
  if (
    command.kind !== "persist-state" &&
    command.kind !== "build-pages" &&
    command.kind !== "notify-discord" &&
    command.kind !== "notify-operations" &&
    command.kind !== "report-workflow"
  ) {
    throw new TypeError("workflow stage commandではありません");
  }
  return command;
}

describe("workflow artifact", () => {
  it("公開snapshot、通知候補、run metadataを再検証する", () => {
    const artifact = createEmptyWorkflowArtifact();

    expect(artifact).toMatchObject({
      schemaVersion: "1",
      kind: "validated_public_run",
      pagesUrl: PAGES_URL,
      notificationSelection: {
        action: "skip_digest",
      },
    });
  });

  it("既知secretを含むartifactを生成境界で拒否する", () => {
    const secret = "workflow-canary-secret-value";
    const source = createEmptyWorkflowArtifact();
    const artifact = createWorkflowArtifact({
      ...source,
      runMetadata: {
        ...source.runMetadata,
        diagnostics: [secret],
      },
    });

    expect(() => {
      assertWorkflowArtifactPublicSafety(artifact, [], [secret]);
    }).toThrow(StatePublicSafetyError);
  });

  it("前stageのartifactが無ければ明示的に失敗する", async () => {
    const missingPath = join(import.meta.dirname, "fixtures", "missing-workflow-artifact.json");

    await expect(readWorkflowArtifactFile(missingPath)).rejects.toThrow(
      "前stageの成果物がありません",
    );
    await expect(readWorkflowArtifactFile(missingPath)).rejects.toBeInstanceOf(
      CliWorkflowArtifactError,
    );
  });
});

describe("workflow stage", () => {
  it("各stageを単独で対応する副作用境界へ渡す", async () => {
    const persistState = vi.fn(() => Promise.resolve());
    const buildPages = vi.fn(() => Promise.resolve());
    const notifyDiscord = vi.fn(() => Promise.resolve());
    const notifyOperations = vi.fn(() => Promise.resolve());
    const reportWorkflow = vi.fn(() => Promise.resolve());
    const runner = new WorkflowStageRunner({
      persistState,
      buildPages,
      notifyDiscord,
      notifyOperations,
      reportWorkflow,
    });
    const commands = [
      parseWorkflowStageCommand(["persist-state"]),
      parseWorkflowStageCommand(["build-pages"]),
      parseWorkflowStageCommand(["notify-discord", "--pages-url", PAGES_URL]),
      parseWorkflowStageCommand([
        "notify-operations",
        "--kind",
        "pages",
        "--incident-id",
        "pages-fixture",
        "--occurred-at",
        NOW,
      ]),
      parseWorkflowStageCommand([
        "report-workflow",
        "--run-id",
        "123456789",
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
      ]),
    ];

    for (const command of commands) {
      await runner.run(command);
    }

    expect(persistState).toHaveBeenCalledOnce();
    expect(buildPages).toHaveBeenCalledOnce();
    expect(notifyDiscord).toHaveBeenCalledOnce();
    expect(notifyOperations).toHaveBeenCalledOnce();
    expect(reportWorkflow).toHaveBeenCalledOnce();
  });

  it("各stageは前stageのartifactが無ければ失敗する", async () => {
    const missingPath = join(import.meta.dirname, "fixtures", "missing-workflow-artifact.json");
    const readMissingArtifact = async (): Promise<void> => {
      await readWorkflowArtifactFile(missingPath);
    };
    const runner = new WorkflowStageRunner({
      persistState: readMissingArtifact,
      buildPages: readMissingArtifact,
      notifyDiscord: readMissingArtifact,
      notifyOperations: readMissingArtifact,
      reportWorkflow: readMissingArtifact,
    });
    const commands = [
      parseWorkflowStageCommand(["persist-state"]),
      parseWorkflowStageCommand(["build-pages"]),
      parseWorkflowStageCommand(["notify-discord", "--pages-url", PAGES_URL]),
      parseWorkflowStageCommand([
        "notify-operations",
        "--kind",
        "collection",
        "--incident-id",
        "collection-fixture",
        "--occurred-at",
        NOW,
      ]),
    ];

    for (const command of commands) {
      await expect(runner.run(command)).rejects.toThrow(CliWorkflowArtifactError);
    }
  });
});

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
import {
  measurePublicSummarySize,
  type PublicDetailsDto,
  type PublicSummaryDto,
} from "../src/pages/index.js";
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
    aiRetainedResultCount: 0,
    estimatedInputTokens: 0,
    githubApiRemaining: 0,
    staleRepositoryCount: 0,
    scheduleDelayMilliseconds: 0,
  });
}

function createEmptyWorkflowArtifact(): WorkflowArtifact {
  const runId = "tracker-run:workflow-artifact-fixture";
  const summary: PublicSummaryDto = {
    schemaVersion: "5",
    runId,
    generatedAt: NOW,
    observedAt: NOW,
    timezone: "Asia/Tokyo",
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    confidenceThresholds: {
      high: 0.8,
      medium: 0.5,
    },
    repositories: [],
    items: [],
    graph: {
      nodes: [],
      maxNodes: 1,
    },
  };
  const details: PublicDetailsDto = {
    schemaVersion: "5",
    runId,
    generatedAt: NOW,
    items: [],
    graph: {
      nodes: [],
      edges: [],
      frontierNodeIds: [],
    },
  };
  return createWorkflowArtifact({
    schemaVersion: "2",
    kind: "validated_public_run",
    repositoryAllowlist: [],
    snapshot: {
      schemaVersion: "8",
      generatedAt: NOW,
      trackingStartAt: {
        status: "fixed",
        value: NOW,
        source: "configuration",
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
    notificationSelection: {
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
    },
    runMetadata: {
      scheduledFor: NOW,
      startedAt: NOW,
      metrics: emptyRunMetadataMetrics(),
      diagnostics: [],
    },
    pages: {
      summary,
      details,
      summarySize: measurePublicSummarySize(summary, 1_000_000),
    },
    cacheOnlyPayload: {
      repositoryCaches: [],
      itemCaches: [],
      latestImportanceCaches: [],
      aiCacheEntries: [],
    },
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
    command.kind !== "persist-cache" &&
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
      schemaVersion: "2",
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

  it("通知ledgerを含む旧artifactをstrict schemaで拒否する", () => {
    const source = createEmptyWorkflowArtifact();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        notificationLedger: {
          schemaVersion: "2",
          entries: [],
          operationsAlerts: [],
        },
      }),
    ).toThrow();
  });

  it("historyInputEventsを含む旧artifactをschema v2で拒否する", () => {
    const source = createEmptyWorkflowArtifact();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        schemaVersion: "1",
        historyInputEvents: [],
      }),
    ).toThrow();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        historyInputEvents: [],
      }),
    ).toThrow();
  });

  it("Pages DTOのrun ID、件数、実測値を再検証する", () => {
    const source = createEmptyWorkflowArtifact();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        pages: {
          ...source.pages,
          summary: {
            ...source.pages.summary,
            runId: "tracker-run:other",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        pages: {
          ...source.pages,
          summarySize: {
            ...source.pages.summarySize,
            gzipBytes: source.pages.summarySize.gzipBytes + 1,
          },
        },
      }),
    ).toThrow();
  });

  it("cache-only payloadのstrict schemaとraw本文を拒否する", () => {
    const source = createEmptyWorkflowArtifact();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        cacheOnlyPayload: {
          ...source.cacheOnlyPayload,
          repositoryCaches: [{ kind: "github_repository" }],
        },
      }),
    ).toThrow();
    const forbiddenFields: readonly ("body" | "comment" | "diff")[] = ["body", "comment", "diff"];
    for (const forbiddenField of forbiddenFields) {
      expect(() =>
        createWorkflowArtifact({
          ...source,
          cacheOnlyPayload: {
            ...source.cacheOnlyPayload,
            itemCaches: [{ [forbiddenField]: "GitHub由来のraw値" }],
          },
        }),
      ).toThrow();
    }
  });

  it("通知候補とrepository allowlistの整合性を拒否する", () => {
    const source = createEmptyWorkflowArtifact();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        notificationSelection: {
          action: "create_digest",
          candidates: [
            {
              itemNodeId: "I_missing",
              reasonCode: "owner_unknown",
              reasons: [{ reasonCode: "owner_unknown" }],
              severity: "watch",
              downstreamImpact: {
                nodeId: "I_missing",
                openNodeCount: 0,
                repositoryCount: 0,
              },
              priorityWeight: 1,
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      createWorkflowArtifact({
        ...source,
        repositoryAllowlist: [
          {
            id: "R_not_in_snapshot",
            owner: "VOICEVOX",
            name: "not-in-snapshot",
          },
        ],
      }),
    ).toThrow(StatePublicSafetyError);
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
    const persistCache = vi.fn(() => Promise.resolve());
    const buildPages = vi.fn(() => Promise.resolve());
    const notifyDiscord = vi.fn(() => Promise.resolve());
    const notifyOperations = vi.fn(() => Promise.resolve());
    const reportWorkflow = vi.fn(() => Promise.resolve());
    const runner = new WorkflowStageRunner({
      persistCache,
      buildPages,
      notifyDiscord,
      notifyOperations,
      reportWorkflow,
    });
    const commands = [
      parseWorkflowStageCommand(["persist-cache"]),
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
        "--persist-cache-result",
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

    expect(persistCache).toHaveBeenCalledOnce();
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
      persistCache: readMissingArtifact,
      buildPages: readMissingArtifact,
      notifyDiscord: readMissingArtifact,
      notifyOperations: readMissingArtifact,
      reportWorkflow: readMissingArtifact,
    });
    const commands = [
      parseWorkflowStageCommand(["persist-cache"]),
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

import type { SequentialRunDependencies } from "../sequential-run-contracts.js";
import { createAnalysisStages } from "./analysis-stages.js";

import { planPublication } from "../../../publication/plan-publication.js";
import { nodeContentDigestPort } from "../content-digest.js";
import { createPostSaveExactProofScope } from "../state-receipt-observation.js";
import { GitHubRunSessions } from "../github-port.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";
import { createReadCompletedReportStage } from "./daily-startup/completed-report.js";
import {
  createReadAiProcessAttemptCountStage,
  createValidateConfigurationStage,
} from "./daily-startup/configuration.js";
import { createInspectLaunchStage } from "./daily-startup/launch.js";
import { createPendingRunStage } from "./daily-startup/pending.js";
import { createPrepareRunStage } from "./daily-startup/preparation.js";
import { createLoadStateStage } from "./daily-startup/state.js";
import {
  createWriteCollectAnalyzeArtifactStage,
  createWriteDryRunArtifactStage,
  createWriteReceiptChainStage,
  createWriteReportStage,
} from "./publication/artifact.js";
import { createFinalizeRunStage } from "./publication/completion.js";
import {
  createBuildNotificationHistoryPagesStage,
  createDeployNotificationHistoryPagesStage,
} from "./publication/history-pages.js";
import { createSettleNotificationsStage } from "./publication/notification.js";
import { createBuildPagesStage, createDeployPagesStage } from "./publication/pages.js";
import {
  createCommitPreparedCheckpointStage,
  createPrepareCheckpointStage,
  createReadCommittedStateStage,
} from "./publication/persistence.js";

/** 日次transactionの各段階を既存アダプターへ接続する。 */
export function createDailyDependencies(
  adapters: ProductionRuntimeAdapters,
): SequentialRunDependencies {
  const proofScope = createPostSaveExactProofScope(
    adapters.createStateBranchAdapter,
    adapters.observePerformanceDetail,
  );
  const runAdapters: ProductionRuntimeAdapters = Object.freeze({
    ...adapters,
    createStateBranchAdapter: proofScope.createStateBranchAdapter,
  });
  const githubSessions = new GitHubRunSessions();
  const inspectLaunch = createInspectLaunchStage(runAdapters, adapters.now);
  return Object.freeze({
    ...(adapters.diagnosticsRecorder == null
      ? {}
      : { diagnosticsRecorder: adapters.diagnosticsRecorder }),
    stateProofScope: Object.freeze({
      beginRun: (runId: string): void => {
        proofScope.beginRun(runId);
      },
      endRun: (runId: string): void => {
        proofScope.endRun(runId);
      },
    }),
    readAiProcessAttemptCount: createReadAiProcessAttemptCountStage(),
    inspectLaunch,
    readCompletedReport: createReadCompletedReportStage(runAdapters),
    pendingRun: (request, invocationId, getRunId, onReceiptRecorded) =>
      createPendingRunStage(
        runAdapters,
        request,
        invocationId,
        inspectLaunch,
        getRunId,
        onReceiptRecorded,
      ),
    validateConfiguration: createValidateConfigurationStage(runAdapters),
    loadState: createLoadStateStage(runAdapters),
    prepareRun: createPrepareRunStage(),
    createAnalysisStages: (context, progress) =>
      createAnalysisStages(runAdapters, githubSessions, context, progress),
    planPublication: (validated) => planPublication(validated, nodeContentDigestPort),
    prepareCheckpoint: createPrepareCheckpointStage(runAdapters),
    commitPreparedCheckpoint: createCommitPreparedCheckpointStage(runAdapters),
    readCommittedState: createReadCommittedStateStage(runAdapters),
    buildPages: createBuildPagesStage(runAdapters),
    deployPages: createDeployPagesStage(runAdapters),
    settleNotifications: createSettleNotificationsStage(runAdapters),
    finalizeRun: createFinalizeRunStage(runAdapters),
    buildNotificationHistoryPages: createBuildNotificationHistoryPagesStage(runAdapters),
    deployNotificationHistoryPages: createDeployNotificationHistoryPagesStage(runAdapters),
    writeDryRunArtifact: createWriteDryRunArtifactStage(),
    writeCollectAnalyzeArtifact: createWriteCollectAnalyzeArtifactStage(runAdapters),
    writeReport: createWriteReportStage(runAdapters),
    writeReceiptChain: createWriteReceiptChainStage(runAdapters),
  } satisfies SequentialRunDependencies);
}

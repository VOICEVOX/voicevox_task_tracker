import type { SequentialRunDependencies } from "../sequential-run-contracts.js";
import { createAnalysisStages } from "./analysis-stages.js";

import { planPublication } from "../../../publication/plan-publication.js";
import { nodeContentDigestPort } from "../content-digest.js";
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
  const githubSessions = new GitHubRunSessions();
  const inspectLaunch = createInspectLaunchStage(adapters, adapters.now);
  return Object.freeze({
    ...(adapters.diagnosticsRecorder == null
      ? {}
      : { diagnosticsRecorder: adapters.diagnosticsRecorder }),
    readAiProcessAttemptCount: createReadAiProcessAttemptCountStage(),
    inspectLaunch,
    readCompletedReport: createReadCompletedReportStage(adapters),
    pendingRun: (request, invocationId, getRunId, onReceiptRecorded) =>
      createPendingRunStage(
        adapters,
        request,
        invocationId,
        inspectLaunch,
        getRunId,
        onReceiptRecorded,
      ),
    validateConfiguration: createValidateConfigurationStage(adapters),
    loadState: createLoadStateStage(adapters),
    prepareRun: createPrepareRunStage(),
    createAnalysisStages: (context, progress) =>
      createAnalysisStages(adapters, githubSessions, context, progress),
    planPublication: (validated) => planPublication(validated, nodeContentDigestPort),
    prepareCheckpoint: createPrepareCheckpointStage(adapters),
    commitPreparedCheckpoint: createCommitPreparedCheckpointStage(adapters),
    readCommittedState: createReadCommittedStateStage(adapters),
    buildPages: createBuildPagesStage(adapters),
    deployPages: createDeployPagesStage(adapters),
    settleNotifications: createSettleNotificationsStage(adapters),
    finalizeRun: createFinalizeRunStage(adapters),
    buildNotificationHistoryPages: createBuildNotificationHistoryPagesStage(adapters),
    deployNotificationHistoryPages: createDeployNotificationHistoryPagesStage(adapters),
    writeDryRunArtifact: createWriteDryRunArtifactStage(adapters),
    writeCollectAnalyzeArtifact: createWriteCollectAnalyzeArtifactStage(adapters),
    writeReport: createWriteReportStage(adapters),
    writeReceiptChain: createWriteReceiptChainStage(adapters),
  } satisfies SequentialRunDependencies);
}

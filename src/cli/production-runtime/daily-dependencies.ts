import type { DailyTransactionDependencies } from "../daily-transaction.js";
import type { ProductionRuntimeAdapters } from "./adapters.js";
import { createAnalyzeWithCodexStage } from "./codex/stage.js";
import { createCollectIncrementalItemsStage } from "./collection/stage.js";
import type { ProductionTypes } from "./contracts.js";
import {
  createReadAiProcessAttemptCountStage,
  createValidateConfigurationStage,
} from "./daily-startup/configuration.js";
import { createAuthenticateGitHubStage } from "./daily-startup/github-authentication.js";
import { createCollectRepositoryInventoryStage } from "./daily-startup/repository-inventory.js";
import { createLoadStateStage } from "./daily-startup/state.js";
import { createApplyDeterministicRulesStage } from "./deterministic/stage.js";
import { createReconcileGraphStage } from "./graph/stage.js";
import { createAnalyzePersonalRemindersStage } from "./personal-reminder/stage.js";
import {
  createWriteCollectAnalyzeArtifactStage,
  createWriteDryRunArtifactStage,
  createWriteReportStage,
} from "./publication/artifact.js";
import { createCompleteRunStage } from "./publication/completion.js";
import {
  createSendDiscordStage,
  createSendOperationsAlertStage,
} from "./publication/notification.js";
import { createBuildPagesStage } from "./publication/pages.js";
import { createPersistStateStage } from "./publication/persistence.js";
import { createReduceAnalysisStage } from "./reduction/stage.js";
import { createValidateCompletenessStage } from "./validation/stage.js";

/** 日次transactionの各段階を既存アダプターへ接続する。 */
export function createDailyDependencies(
  adapters: ProductionRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes> {
  return Object.freeze({
    ...(adapters.diagnosticsRecorder == null
      ? {}
      : { diagnosticsRecorder: adapters.diagnosticsRecorder }),
    readAiProcessAttemptCount: createReadAiProcessAttemptCountStage(),
    validateConfiguration: createValidateConfigurationStage(adapters),
    loadState: createLoadStateStage(adapters),
    authenticateGitHub: createAuthenticateGitHubStage(adapters),
    collectRepositoryInventory: createCollectRepositoryInventoryStage(adapters),
    collectIncrementalItems: createCollectIncrementalItemsStage(adapters),
    applyDeterministicRules: createApplyDeterministicRulesStage(),
    analyzeWithCodex: createAnalyzeWithCodexStage(adapters),
    reduceAnalysis: createReduceAnalysisStage(),
    reconcileGraph: createReconcileGraphStage(),
    analyzePersonalReminders: createAnalyzePersonalRemindersStage(adapters),
    validateCompleteness: createValidateCompletenessStage(),
    persistState: createPersistStateStage(),
    buildPages: createBuildPagesStage(adapters),
    sendDiscord: createSendDiscordStage(adapters),
    completeRun: createCompleteRunStage(adapters),
    sendOperationsAlert: createSendOperationsAlertStage(adapters),
    writeDryRunArtifact: createWriteDryRunArtifactStage(adapters),
    writeCollectAnalyzeArtifact: createWriteCollectAnalyzeArtifactStage(adapters),
    writeReport: createWriteReportStage(adapters),
  } satisfies DailyTransactionDependencies<ProductionTypes>);
}

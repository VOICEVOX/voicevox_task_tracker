import type {
  PublicationPlannedRun,
  PublicationValidatedRun,
} from "../../publication/publication-plan-contracts.js";
import type { PersistedRun } from "./publication/contracts.js";
import type { RunInvocation } from "./run-invocation.js";
import type {
  AnalysisProgress,
  AnalysisRuntimeContext,
  AnalysisStages,
} from "./runtime/analysis-contracts.js";
import type { RuntimeConfiguration, RuntimeState } from "./runtime/contracts.js";
import type { SequentialPublicationInput } from "./sequential-publication-input.js";
import type { NotificationStageResult } from "./sequential-result.js";

import type { CompletedRun } from "../../application/tracking-run/complete-run.js";
import type { AnalysisRunStageName } from "../../application/tracking-run/contracts/closed-values.js";
import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import type { InitialStateCommitReference } from "../../application/tracking-run/engine.js";
import {
  type PendingRunPorts,
  type TrackingRunLaunchDecision,
} from "../../application/tracking-run/engine.js";
import type { StateCommitReceiptEvidence } from "../../application/tracking-run/observed-state-commit.js";
import type { PreparedRun } from "../../application/tracking-run/prepare-run.js";
import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import type {
  NotificationSettlementReceipt,
  Receipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { RunIdentity, RunRequest } from "../../application/tracking-run/request.js";
import type { DiagnosticsJsonlRecorder } from "../../diagnostics/recorder.js";
import type { StateRunReport } from "../../persistence/state-run-report.js";
import { type RunMetrics, type RunReport } from "../../publication/run-report.js";
import type { NotificationSettlementOutcome } from "./notification-settlement-contracts.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";
import type {
  InitialPagesPreparedRun,
  InitialPagesPublishedRun,
  NotificationHistoryPagesPreparedRun,
  NotificationHistoryPublishedRun,
} from "./publication/contracts.js";
import type { RecoveryStageInput } from "./recovery-stage.js";
import type { FinalizeRunOutcome } from "./run-finalization-contracts.js";
import { type DryRunArtifact } from "./sequential-report.js";

export type { DryRunArtifact } from "./sequential-report.js";

/** 日次transactionの外部接続と各モジュールの結合境界。 */
export type SequentialRunDependencies = Readonly<{
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  readAiProcessAttemptCount: (configuration: RuntimeConfiguration) => number;
  inspectLaunch: (
    request: RunRequest,
    invocationId: string,
    intent: Readonly<{ kind: "start_new" } | { kind: "retry_run"; runId: string }>,
  ) => Promise<TrackingRunLaunchDecision<RecoveryStageInput>>;
  readCompletedReport: (request: RunRequest, completed: CompletedRun) => Promise<StateRunReport>;
  pendingRun: (
    request: RunRequest,
    invocationId: string,
    getRunId: () => string,
    onReceiptRecorded: (receipt: Receipt) => void,
  ) => PendingRunPorts<RecoveryStageInput>;
  validateConfiguration: (
    input: Readonly<{
      request: RunRequest;
      baseStateHead: BaseStateRevision;
    }>,
  ) => Promise<RuntimeConfiguration>;
  loadState: (
    input: Readonly<{
      invocation: RunInvocation;
      configuration: RuntimeConfiguration;
    }>,
  ) => Promise<RuntimeState>;
  prepareRun: (
    input: Readonly<{
      request: RunRequest;
      identity: RunIdentity;
      configuration: RuntimeConfiguration;
      state: RuntimeState;
    }>,
  ) => PreparedRun;
  createAnalysisStages: (
    context: AnalysisRuntimeContext,
    progress: AnalysisProgress,
  ) => AnalysisStages;
  planPublication: (validated: PublicationValidatedRun) => PublicationPlannedRun;
  prepareCheckpoint: (input: SequentialPublicationInput) => Promise<BoundPublicationCheckpoint>;
  commitPreparedCheckpoint: (
    input: SequentialPublicationInput,
    checkpoint: BoundPublicationCheckpoint,
  ) => Promise<PersistedRun>;
  readCommittedState: (
    input: Readonly<{
      configuration: RuntimeConfiguration;
      reference: InitialStateCommitReference;
    }>,
  ) => Promise<
    PersistedRun &
      Readonly<{
        stateContentDigest: string;
        receiptEvidence: Extract<
          StateCommitReceiptEvidence,
          { receiptType: "initial_state_commit" }
        >;
      }>
  >;
  buildPages: (
    input: Readonly<{
      invocation: RunInvocation;
      configuration: RuntimeConfiguration;
      persisted: PersistedRun;
    }>,
  ) => Promise<InitialPagesPreparedRun>;
  deployPages: (
    input: Readonly<{
      invocation: RunInvocation;
      configuration: RuntimeConfiguration;
      persisted: PersistedRun;
      pagesPrepared: InitialPagesPreparedRun;
    }>,
  ) => Promise<InitialPagesPublishedRun>;
  settleNotifications: (
    input: Readonly<{
      invocation: RunInvocation;
      configuration: RuntimeConfiguration;
      persisted: PersistedRun;
      pages: InitialPagesPublishedRun;
    }>,
  ) => Promise<
    NotificationStageResult<Extract<NotificationSettlementOutcome, { kind: "settled" }>>
  >;
  finalizeRun: (
    input: Readonly<{
      invocation: RunInvocation;
      configuration: RuntimeConfiguration;
      persisted: PersistedRun;
      notifications: Extract<NotificationSettlementOutcome, { kind: "settled" }>;
    }>,
  ) => Promise<Extract<FinalizeRunOutcome, { kind: "finalized" }>>;
  buildNotificationHistoryPages: (
    input: Readonly<{
      configuration: RuntimeConfiguration;
      settlementReceipt: NotificationSettlementReceipt;
      finalizationReceipt: RunFinalizationReceipt;
    }>,
  ) => Promise<NotificationHistoryPagesPreparedRun>;
  deployNotificationHistoryPages: (
    input: Readonly<{
      configuration: RuntimeConfiguration;
      prepared: NotificationHistoryPagesPreparedRun;
      settlementReceipt: NotificationSettlementReceipt;
      finalizationReceipt: RunFinalizationReceipt;
      runId: string;
    }>,
  ) => Promise<NotificationHistoryPublishedRun>;
  writeDryRunArtifact: (
    path: string,
    artifact: DryRunArtifact<PublicationPlannedRun>,
  ) => Promise<void>;
  writeCollectAnalyzeArtifact: (
    path: string,
    input: Readonly<{
      invocation: RunInvocation;
      completedStages: readonly AnalysisRunStageName[];
      configuration: RuntimeConfiguration;
      state: RuntimeState;
      planned: PublicationPlannedRun;
      metrics: RunMetrics;
      status: "success" | "fallback";
      diagnostics: readonly string[];
    }>,
  ) => Promise<void>;
  writeReport: (path: string, report: RunReport) => Promise<void>;
  writeReceiptChain: (runId: string, entries: readonly ReceiptChainEntry[]) => Promise<void>;
}>;

import { randomUUID } from "node:crypto";
import type { PersonalReminderExecutedRun } from "../../application/tracking-run/stages/personal-reminder-execution.js";
import type { PersonalReminderFinalizedRun } from "../../application/tracking-run/stages/personal-reminder-finalization.js";
import type { PersonalReminderPlannedRun } from "../../application/tracking-run/stages/personal-reminder-plan.js";
import { assertNonNullable } from "../../util/index.js";
import type { RunInvocation } from "./run-invocation.js";
import type { AnalysisStages } from "./runtime/analysis-contracts.js";
import type { SequentialRunDependencies } from "./sequential-run-contracts.js";
import type {
  DailyRunEffects,
  DailyRunExecutionResult,
  DailyRunRuntime,
} from "./sequential-result.js";

import type { BaseStateRevision } from "../../application/tracking-run/contracts/run-core.js";
import {
  runTrackingAnalysis,
  runTrackingRunSequentially,
  type NewRunStagePorts,
  type TrackingRunFailurePort,
} from "../../application/tracking-run/engine.js";
import {
  createFailedRun,
  type FailedRun,
} from "../../application/tracking-run/failure-artifact.js";
import type { PreparedRun } from "../../application/tracking-run/prepare-run.js";
import type { Receipt } from "../../application/tracking-run/receipt-schema.js";
import type { RunIdentity, RunRequest } from "../../application/tracking-run/request.js";
import type { CollectedRun } from "../../application/tracking-run/stages/collection.js";
import type { DeterministicallyAnalyzedRun } from "../../application/tracking-run/stages/deterministic.js";
import type { GenericAiAdoptedRun } from "../../application/tracking-run/stages/generic-ai-adoption.js";
import type { GenericAiExecutedRun } from "../../application/tracking-run/stages/generic-ai-execution.js";
import type { GenericAiPlannedRun } from "../../application/tracking-run/stages/generic-ai-plan-contracts.js";
import type { GraphReconciledRun } from "../../application/tracking-run/stages/graph-reconciliation.js";
import type { InventoryCollectedRun } from "../../application/tracking-run/stages/inventory.js";
import type { UtcIsoDateTime } from "../../domain/index.js";
import {
  StateFormatError,
  StatePersonalReminderAiDependencyMismatchError,
} from "../../persistence/index.js";
import {
  createEmptyRunMetrics,
  type RunMetrics,
  type RunReport,
  type RunStage,
} from "../../publication/run-report.js";
import type {
  BackfillCliCommand,
  CollectAnalyzeCliCommand,
  DailyCliCommand,
  DryRunCliCommand,
  RunSequentialCliCommand,
} from "./command-input.js";
import { safeErrorDiagnostic } from "./error-diagnostic.js";
import { createDryRunResultSpool, type DryRunResultSpool } from "./dry-run-result-spool.js";
import { observeCliFailureContext } from "./failure-context.js";
import { publicBoundaryDiagnosticDetails } from "./public-boundary-diagnostic.js";
import { isPublicBoundaryViolation } from "./public-boundary-error.js";
import { publicDiagnosticCode } from "./public-failure-boundary.js";
import type { RecoveryStageInput } from "./recovery-stage.js";
import { RunCoordinator, type CoordinatedRunResult } from "./run-coordinator.js";
import { parseRunRequest } from "./run-request-input.js";
import type { PostCheckpointPublicationContext } from "./sequential-publication-input.js";
import {
  createDailyPublicationStages,
  type DailyPublicationStageValues,
  type PublicationStageInput,
} from "./sequential-publication.js";
import {
  completedReport,
  completedReportFromState,
  createDryRunArtifactMetadata,
  currentTime,
  failureReport,
  isPreCheckpointFailureStage,
  reportContextForFailure,
  reportStageForEngine,
  updateMetrics,
} from "./sequential-report.js";
import { createRunIdentity } from "./tracking-run/identity.js";

export type { DryRunArtifact } from "./sequential-report.js";

import type { CanonicalCollectedItems } from "./runtime/analysis-contracts.js";
import type { PublicationValidatedRun } from "../../publication/publication-plan-contracts.js";
import type { RuntimeConfiguration, RuntimeState } from "./runtime/contracts.js";

/** ネットワークを利用する日次transaction系のサブコマンド。 */
export type OnlineCliCommand =
  | DailyCliCommand
  | DryRunCliCommand
  | BackfillCliCommand
  | CollectAnalyzeCliCommand
  | RunSequentialCliCommand;

type SequentialEngineStageValues = Readonly<{
  prepared: PreparedRun;
  inventory_collected: InventoryCollectedRun;
  collected: CollectedRun<CanonicalCollectedItems>;
  deterministically_analyzed: DeterministicallyAnalyzedRun;
  generic_ai_planned: GenericAiPlannedRun;
  generic_ai_executed: GenericAiExecutedRun;
  generic_ai_adopted: GenericAiAdoptedRun;
  graph_reconciled: GraphReconciledRun;
  personal_reminder_planned: PersonalReminderPlannedRun;
  personal_reminder_executed: PersonalReminderExecutedRun;
  personal_reminder_finalized: PersonalReminderFinalizedRun;
  validated: PublicationValidatedRun;
}> &
  DailyPublicationStageValues;

interface MutableEffects {
  stateCommitted: boolean;
  pagesBuilt: boolean;
  discordAttempted: boolean;
  artifactWritten: boolean;
}

function freezeEffects(effects: MutableEffects): DailyRunEffects {
  return Object.freeze({ ...effects });
}

function initialEffects(): MutableEffects {
  return {
    stateCommitted: false,
    pagesBuilt: false,
    discordAttempted: false,
    artifactWritten: false,
  };
}

function required<Value>(value: Value, message: string): NonNullable<Value> {
  assertNonNullable(value, message);
  return value;
}

function personalReminderAiDependencyMismatchError(
  error: unknown,
): StatePersonalReminderAiDependencyMismatchError | undefined {
  if (error instanceof StatePersonalReminderAiDependencyMismatchError) {
    return error;
  }
  if (error instanceof StateFormatError) {
    if (error.cause instanceof StatePersonalReminderAiDependencyMismatchError) {
      return error.cause;
    }
    if (
      error.cause instanceof TypeError &&
      error.cause.cause instanceof StatePersonalReminderAiDependencyMismatchError
    ) {
      return error.cause.cause;
    }
  }
  return undefined;
}

/** Daily transactionを順序保証付きで実行する。 */
export class SequentialRunRunner {
  readonly #coordinator: RunCoordinator<DailyRunExecutionResult>;
  readonly #dependencies: SequentialRunDependencies;
  readonly #runtime: DailyRunRuntime;

  public constructor(dependencies: SequentialRunDependencies, runtime: DailyRunRuntime) {
    this.#dependencies = dependencies;
    this.#runtime = runtime;
    this.#coordinator = new RunCoordinator((result) => result.report.status !== "failure");
  }

  #metricsWithAiProcessAttemptCount(
    metrics: RunMetrics,
    configuration: RuntimeConfiguration | undefined,
  ): RunMetrics {
    if (configuration == null) {
      return metrics;
    }
    return updateMetrics(metrics, {
      aiProcessAttemptCount: this.#dependencies.readAiProcessAttemptCount(configuration),
    });
  }

  async #writeFailure(
    invocation: RunInvocation,
    reportPath: string,
    stage: RunStage,
    failureKind: Extract<RunReport, { status: "failure" }>["failureKind"],
    metrics: RunMetrics,
    configuration: RuntimeConfiguration | undefined,
    diagnostics: readonly string[],
    discordSentAt: UtcIsoDateTime | null,
    effects: MutableEffects,
  ): Promise<DailyRunExecutionResult> {
    const report = failureReport(
      invocation,
      stage,
      failureKind,
      this.#metricsWithAiProcessAttemptCount(metrics, configuration),
      diagnostics,
      discordSentAt,
      currentTime(this.#runtime),
    );
    await this.#dependencies.writeReport(reportPath, report);
    return Object.freeze({
      report,
      effects: freezeEffects(effects),
    });
  }

  async #recordError(
    invocation: RunInvocation,
    stage: RunStage,
    event: string,
    error: unknown,
  ): Promise<string | undefined> {
    const recorder = this.#dependencies.diagnosticsRecorder;
    if (recorder == null) {
      return undefined;
    }
    const recordId = randomUUID();
    const mismatchError =
      event === "cli.stage.failed" ? personalReminderAiDependencyMismatchError(error) : undefined;
    try {
      await recorder.append({
        event,
        details: {
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          command: invocation.commandKind,
          stage,
          recordId,
          ...publicBoundaryDiagnosticDetails(error),
          ...(mismatchError != null
            ? {
                personalReminderAiDependencyMismatch: mismatchError.diagnosticDetails(),
              }
            : {}),
        },
        error,
      });
      return recordId;
    } catch (recordingError: unknown) {
      throw new AggregateError([error, recordingError], "CLI段階エラーの診断記録に失敗しました", {
        cause: error,
      });
    }
  }

  async #execute(
    command: OnlineCliCommand,
    initialInvocation: RunInvocation,
    request: RunRequest,
    identity: RunIdentity,
  ): Promise<DailyRunExecutionResult> {
    let invocation = initialInvocation;
    let stage: RunStage = "configuration";
    let metrics = updateMetrics(createEmptyRunMetrics(), {
      scheduleDelayMilliseconds:
        Date.parse(invocation.startedAt) - Date.parse(invocation.scheduledFor),
    });
    const diagnostics: string[] = [];
    const effects = initialEffects();
    let discordSentAt: UtcIsoDateTime | null = null;
    let configuration: RuntimeConfiguration | undefined;
    let state: RuntimeState | undefined;
    let prepared: PreparedRun | undefined;
    let analysisStages: AnalysisStages | undefined;
    let publicationInput: PublicationStageInput | undefined;
    let publicationContext: PostCheckpointPublicationContext | undefined;
    let dryRunResultSpool: DryRunResultSpool | undefined;
    let boundEvidence: Extract<FailedRun["evidence"], { bindingKind: "checkpoint" }> | undefined;
    let runStatus: "success" | "fallback" = "success";
    let lastReceipt: Receipt | undefined;
    let failedResult: DailyRunExecutionResult | undefined;
    let baseStateHead: BaseStateRevision | undefined;
    const publicationStages = createDailyPublicationStages(
      this.#dependencies,
      this.#runtime,
      {
        stateCommitted: () => {
          effects.stateCommitted = true;
        },
        pagesBuilt: () => {
          effects.pagesBuilt = true;
        },
        notificationStarted: () => {
          effects.discordAttempted = request.executionPolicy.notificationAction === "send";
        },
        notificationsSettled: (notifications) => {
          discordSentAt = notifications.discordSentAt;
          metrics = updateMetrics(metrics, {
            notificationCount: notifications.notificationCount,
          });
        },
        receiptRecorded: (receipt) => {
          lastReceipt = receipt;
        },
      },
      () => required(publicationContext, "結合済み公開段階の入力がありません"),
    );
    const boundary: TrackingRunFailurePort = {
      beforeStage: (failedStage) => {
        stage = reportStageForEngine(failedStage);
        this.#runtime.beforeStage?.(failedStage);
        return Promise.resolve();
      },
      fail: async (failedStage, error) => {
        const reportContext = reportContextForFailure(invocation, failedStage, error);
        const recordId = await this.#recordError(
          reportContext.invocation,
          reportContext.stage,
          "cli.stage.failed",
          error,
        );
        if (recordId == null) {
          throw new TypeError("失敗runに必要な暗号化診断recorderがありません", { cause: error });
        }
        const failureKind = isPublicBoundaryViolation(error) ? "public_boundary" : "other";
        const reported = await this.#writeFailure(
          reportContext.invocation,
          request.reportPath,
          reportContext.stage,
          failureKind,
          metrics,
          configuration,
          [...diagnostics, safeErrorDiagnostic(reportContext.stage, error)],
          discordSentAt,
          effects,
        );
        const failureEvidence =
          boundEvidence ??
          (prepared == null || !isPreCheckpointFailureStage(reportContext.stage)
            ? undefined
            : {
                bindingKind: "run_pre_checkpoint_alert" as const,
                runId: prepared.core.identity.runId,
                baseStateRevision: prepared.core.baseState.revision,
                configDigest: prepared.core.configDigest,
              });
        const context = await observeCliFailureContext(
          command,
          error,
          {
            command: invocation.commandKind,
            exitCode: 1,
            execution: "executed",
            result: {
              ...reported,
              failureDiagnosticRecordId: recordId,
              ...(failureEvidence == null ? {} : { failureEvidence }),
            },
          },
          failedStage,
          lastReceipt,
        );
        const effectiveStage =
          context.evidence.bindingKind === "state_bootstrap_alert"
            ? "runtime_bootstrap"
            : context.failedStage;
        const failure = createFailedRun({
          invocationId: invocation.invocationId,
          failedStage: effectiveStage,
          failureKind: context.failureKind,
          failedOperationEffectCertainty: context.failedOperationEffectCertainty,
          evidence: context.evidence,
          ...(context.runId == null ? {} : { runId: context.runId }),
          ...(context.checkpointDigest == null
            ? {}
            : { checkpointDigest: context.checkpointDigest }),
          ...(context.checkpointFileDigest == null
            ? {}
            : { checkpointFileDigest: context.checkpointFileDigest }),
          ...(context.finalStateRevision == null
            ? {}
            : { finalStateRevision: context.finalStateRevision }),
          publicDiagnostics: { code: publicDiagnosticCode(context.failureKind) },
          encryptedDiagnosticsRecordIds: [recordId],
          lastVerifiedReceipt:
            context.lastVerifiedReceipt != null &&
            (lastReceipt == null ||
              context.lastVerifiedReceipt.phaseSequence > lastReceipt.phaseSequence)
              ? context.lastVerifiedReceipt
              : lastReceipt,
          stateObservation: context.stateObservation,
        });
        failedResult = Object.freeze({
          ...reported,
          failureDiagnosticRecordId: recordId,
          failedRun: failure,
          ...(failureEvidence == null ? {} : { failureEvidence }),
        });
        return failure;
      },
    };
    const stages = {
      prepare: async () => {
        configuration = await this.#dependencies.validateConfiguration({
          request,
          baseStateHead: required(baseStateHead, "run開始時のstate headがありません"),
        });
        state = await this.#dependencies.loadState({ invocation, configuration });
        prepared = this.#dependencies.prepareRun({ request, identity, configuration, state });
        invocation = Object.freeze({ ...invocation, ...prepared.core.identity });
        analysisStages = this.#dependencies.createAnalysisStages(
          { invocation, configuration, state },
          {
            record: (values, records, status) => {
              metrics = updateMetrics(metrics, values);
              diagnostics.push(...records);
              if (status === "fallback") runStatus = "fallback";
            },
            readMetrics: () => this.#metricsWithAiProcessAttemptCount(metrics, configuration),
            readDiagnostics: () => Object.freeze([...diagnostics]),
          },
        );
        return prepared;
      },
      inventoryCollected: (value) =>
        required(analysisStages, "解析adapterがありません").inventoryCollected(value),
      collected: (value) => required(analysisStages, "解析adapterがありません").collected(value),
      deterministicallyAnalyzed: (value) =>
        required(analysisStages, "解析adapterがありません").deterministicallyAnalyzed(value),
      genericAiPlanned: (value) =>
        required(analysisStages, "解析adapterがありません").genericAiPlanned(value),
      genericAiExecuted: (value) =>
        required(analysisStages, "解析adapterがありません").genericAiExecuted(value),
      genericAiAdopted: (value) =>
        required(analysisStages, "解析adapterがありません").genericAiAdopted(value),
      graphReconciled: (value) =>
        required(analysisStages, "解析adapterがありません").graphReconciled(value),
      personalReminderPlanned: (value) =>
        required(analysisStages, "解析adapterがありません").personalReminderPlanned(value),
      personalReminderExecuted: (value) =>
        required(analysisStages, "解析adapterがありません").personalReminderExecuted(value),
      personalReminderFinalized: (value) =>
        required(analysisStages, "解析adapterがありません").personalReminderFinalized(value),
      validated: (value) => required(analysisStages, "解析adapterがありません").validated(value),
      publicationPlanned: (validated) => {
        const planned = this.#dependencies.planPublication(validated);
        analysisStages = undefined;
        publicationInput = {
          invocation,
          configuration: required(configuration, "実行設定がありません"),
          state: required(state, "前回stateがありません"),
          planned,
          metrics,
          status: runStatus,
          diagnostics,
        } satisfies PublicationStageInput;
        return Promise.resolve(publicationInput);
      },
      afterCheckpointBound: async (bound) => {
        boundEvidence = Object.freeze({
          bindingKind: "checkpoint",
          runId: bound.checkpoint.runIdentity.runId,
          checkpointDigest: bound.checkpointDigest,
          checkpointFileDigest: bound.bindingProof.checkpointFileDigest,
          runtimeIdentityDigest: bound.bindingProof.runtimeIdentityDigest,
          baseStateRevision: bound.checkpoint.baseStateRevision,
        });
        const input = required(publicationInput, "結合直後の公開計画がありません");
        if (request.output.kind === "dry_run_artifact") {
          dryRunResultSpool = await createDryRunResultSpool(input.planned);
        }
        publicationContext = Object.freeze({
          invocation: input.invocation,
          configuration: input.configuration,
        });
        publicationInput = undefined;
        analysisStages = undefined;
        state = undefined;
        prepared = undefined;
      },
      ...publicationStages,
    } satisfies NewRunStagePorts<
      SequentialEngineStageValues,
      Awaited<ReturnType<typeof publicationStages.encodeCheckpoint>>
    >;
    if (request.output.kind !== "analysis_artifact") {
      try {
        let pendingRunId: string | undefined;
        const outcome = await runTrackingRunSequentially<
          SequentialEngineStageValues,
          Awaited<ReturnType<typeof publicationStages.encodeCheckpoint>>,
          RecoveryStageInput
        >(
          async () => {
            const launch = await this.#dependencies.inspectLaunch(
              request,
              invocation.invocationId,
              {
                kind: "start_new",
              },
            );
            if (launch.decision.kind === "start_new") {
              baseStateHead = launch.decision.baseRevision;
            } else if (launch.decision.kind === "resume_pending") {
              pendingRunId = launch.decision.pending.record.runIdentity.runId;
              invocation = Object.freeze({
                ...invocation,
                runId: pendingRunId,
              });
              lastReceipt = launch.decision.pending.receiptChain.at(-1);
            } else if (launch.decision.kind === "completed") {
              invocation = Object.freeze({ ...invocation, runId: launch.decision.runId });
              lastReceipt = launch.decision.completed.chain.receipts.at(-1);
            }
            return launch;
          },
          stages,
          this.#dependencies.pendingRun(
            request,
            invocation.invocationId,
            () => required(pendingRunId, "再開run IDがありません"),
            (receipt) => {
              lastReceipt = receipt;
            },
          ),
          boundary,
        );
        if (outcome.status === "failed") {
          return required(failedResult, "失敗runの報告結果がありません");
        }
        try {
          const stateReport = await this.#dependencies.readCompletedReport(request, outcome);
          if (request.output.kind === "dry_run_artifact") {
            await this.#dependencies.writeDryRunArtifact(
              request.output.path,
              createDryRunArtifactMetadata(
                invocation,
                stateReport.status,
                stateReport.metrics,
                stateReport.diagnostics,
                currentTime(this.#runtime),
                outcome,
              ),
              required(dryRunResultSpool, "dry-runの一時結果がありません"),
            );
            effects.artifactWritten = true;
          }
          const report = completedReportFromState(invocation, stateReport, outcome);
          await this.#dependencies.writeReport(request.reportPath, report);
          return Object.freeze({
            report,
            effects: freezeEffects(effects),
            completedRun: outcome,
          });
        } catch (error: unknown) {
          await boundary.fail("completed", error);
          return required(failedResult, "失敗runの報告結果がありません");
        }
      } finally {
        if (dryRunResultSpool != null) {
          await dryRunResultSpool.dispose();
          dryRunResultSpool = undefined;
        }
      }
    }
    const launch = await this.#dependencies.inspectLaunch(request, invocation.invocationId, {
      kind: "start_new",
    });
    if (launch.decision.kind !== "start_new") {
      throw new TypeError("解析artifactの起動時に未完了runがあります");
    }
    baseStateHead = launch.decision.baseRevision;
    const analysis = await runTrackingAnalysis<
      SequentialEngineStageValues,
      Awaited<ReturnType<typeof publicationStages.encodeCheckpoint>>
    >(stages, boundary);
    if (analysis.kind === "failed") {
      return required(failedResult, "失敗runの報告結果がありません");
    }
    try {
      const input = analysis.value;
      stage = "artifact";
      await this.#dependencies.writeCollectAnalyzeArtifact(request.output.path, {
        ...input,
        completedStages: analysis.completedStages,
      });
      effects.artifactWritten = true;
      const report = completedReport(
        invocation,
        runStatus,
        this.#metricsWithAiProcessAttemptCount(metrics, configuration),
        diagnostics,
        discordSentAt,
        currentTime(this.#runtime),
      );
      await this.#dependencies.writeReport(request.reportPath, report);
      return Object.freeze({
        report,
        effects: freezeEffects(effects),
      });
    } catch (error: unknown) {
      await boundary.fail(
        stage === "artifact" ? "checkpoint_encoding" : "workflow_effect_observation",
        error,
      );
      return required(failedResult, "失敗runの報告結果がありません");
    }
  }

  /** サブコマンドを排他かつ同じrun IDで冪等に実行する。 */
  public async run(
    command: OnlineCliCommand,
    invocationId: string,
  ): Promise<CoordinatedRunResult<DailyRunExecutionResult>> {
    const request = parseRunRequest(command, this.#runtime.now(), invocationId);
    const identity = createRunIdentity(request);
    const invocation: RunInvocation = Object.freeze({
      ...identity,
      executionPolicy: request.executionPolicy,
      commandKind: command.kind,
    });
    return this.#coordinator.runExclusive(invocation.runId, async () => {
      this.#dependencies.stateProofScope?.beginRun(invocation.runId);
      try {
        return await this.#execute(command, invocation, request, identity);
      } finally {
        this.#dependencies.stateProofScope?.endRun(invocation.runId);
      }
    });
  }
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { completeTrackingRun } from "../../application/tracking-run/complete-run.js";
import type { TrackingRunStageName } from "../../application/tracking-run/contracts/closed-values.js";
import { runTrackingStageOnce } from "../../application/tracking-run/engine.js";
import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { assertNonNullable } from "../../util/index.js";
import type { CollectAnalyzeCliCommand } from "./command-input.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { decodeInitialPagesBuildArtifact } from "./initial-pages-build-artifact.js";
import { readInitialPagesDeploymentOutcome } from "./initial-pages-deployment.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "./notification-history-pages-deployment-outcome.js";
import { readPublicationCheckpointHeader } from "./publication-checkpoint-file.js";
import {
  preflightWorkflowPagesDeployment,
  recordWorkflowPagesDeployment,
} from "./publication/deployment.js";
import {
  preflightWorkflowNotificationHistoryDeployment,
  recordWorkflowNotificationHistoryDeployment,
} from "./publication/workflow-history-deployment.js";
import { prepareWorkflowNotificationHistoryPages } from "./publication/workflow-history-pages.js";
import {
  finalizeWorkflowRun,
  settleWorkflowNotifications,
} from "./publication/workflow-notifications.js";
import { buildWorkflowPages } from "./publication/workflow-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { DailyRunExecutionResult } from "./sequential-result.js";
import { SequentialRunRunner } from "./sequential-run.js";
import type { RunStageCliCommand } from "./split-command-input.js";
import { splitStagePaths } from "./split-stage-paths.js";
import { initialPagesEvidenceForSplitReceipt } from "./split-stage-receipts.js";
import { commitSplitInitialState } from "./split-stage-initial-commit.js";
import { priorReceipts, saveStageReceipts } from "./split-stage-receipt-recovery.js";
import { inspectSplitState, scopedAdapters, verifySplitState } from "./split-stage-state.js";

/** 一段実行した分割runの結果。 */
export type SplitStageExecutionResult = Readonly<{
  result?: DailyRunExecutionResult;
}>;

function previousStage(entries: readonly ReceiptChainEntry[]): TrackingRunStageName {
  const last = entries.at(-1)?.receipt;
  if (last == null || last.stage === "operations_alert") {
    throw new TypeError("分割runの直前receiptがありません");
  }
  if (last.receiptType === "notification_message" || last.receiptType === "manual_resolution") {
    return "initial_pages_published";
  }
  return last.stage;
}

/** 指定された分割stageを一段実行する。 */
export async function runSplitStage(
  runtimeAdapters: ProductionRuntimeAdapters,
  dailyRunner: SequentialRunRunner,
  command: RunStageCliCommand,
  invocationId: string,
): Promise<SplitStageExecutionResult> {
  if (command.stage === "analyze") {
    const analysis: CollectAnalyzeCliCommand = {
      kind: "collect-analyze",
      configPath: command.configPath,
      reportPath: "artifacts/run-reports/run-stage-analyze.json",
      artifactPath: "artifacts/workflow/validated-run.cpk",
      schedule: command.schedule,
      notificationAction: command.notificationAction,
      mode: command.mode,
      repositoryFilter: command.repositoryFilter,
      sandboxContextPath: command.sandboxContextPath,
    };
    const coordinated = await dailyRunner.run(analysis, invocationId);
    if (coordinated.value.report.status !== "failure") {
      const header = await readPublicationCheckpointHeader(
        resolve(runtimeAdapters.repositoryPath, analysis.artifactPath),
      );
      if (header.runIdentity.runId !== coordinated.value.report.runId) {
        throw new TypeError("解析artifactとrun reportのrun IDが一致しません");
      }
      await runtimeAdapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          runId: header.runIdentity.runId,
          stage: "publication_planned",
          checkpointPath: resolve(runtimeAdapters.repositoryPath, analysis.artifactPath),
        }),
      );
    }
    return { result: coordinated.value };
  }
  const runId = command.runId;
  assertNonNullable(runId, "分割runのrun IDがありません");
  const paths = splitStagePaths(runtimeAdapters.repositoryPath, runId);
  const adapters = scopedAdapters(runtimeAdapters, runId);
  if (command.stage === "commit-initial-state") {
    await commitSplitInitialState(adapters, command, invocationId, paths, runId);
    return {};
  }
  const state = await inspectSplitState(adapters, command.configPath, runId);
  const prior = await priorReceipts(adapters, paths, runId, state, command.configPath);
  await verifySplitState(state, runId, invocationId, adapters.now().toISOString(), prior);
  const current = previousStage(prior);
  const execute = <Value>(
    completed: TrackingRunStageName,
    next: TrackingRunStageName,
    action: () => Promise<Value>,
  ): Promise<Value> => {
    if (current !== completed) {
      throw new TypeError("分割runの指定段階と直前receiptが一致しません");
    }
    return runTrackingStageOnce(completed, next, action);
  };
  switch (command.stage) {
    case "prepare-initial-pages": {
      await execute("initial_state_committed", "initial_pages_prepared", () =>
        buildWorkflowPages(
          { adapters },
          {
            configPath: command.configPath,
            initialStateReceiptPath: paths.initialReceipt,
            buildArtifactPath: paths.initialBuild,
            outputDirectory: paths.pagesOutput,
          },
        ),
      );
      const build = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
      await saveStageReceipts(adapters, paths, runId, prior, [
        { receipt: build.receipt, evidence: { kind: "none" } },
      ]);
      return {};
    }
    case "preflight-initial-pages-deployment":
      if (current !== "initial_pages_prepared") {
        throw new TypeError("初回Pages deploy前のbuild receiptがありません");
      }
      await preflightWorkflowPagesDeployment(adapters, {
        configPath: command.configPath,
        initialStateReceiptPath: paths.initialReceipt,
        buildArtifactPath: paths.initialBuild,
        previousOutcomePath: paths.initialDeployment,
        preflightPath: paths.initialPreflight,
        runAttempt: command.runAttempt,
      });
      await adapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          runId,
          stage: command.stage,
          preflightPath: paths.initialPreflight,
        }),
      );
      return {};
    case "record-initial-pages-deployment": {
      await execute("initial_pages_prepared", "initial_pages_published", () =>
        recordWorkflowPagesDeployment(adapters, {
          buildArtifactPath: paths.initialBuild,
          preflightPath: paths.initialPreflight,
          outcomePath: paths.initialDeployment,
        }),
      );
      const build = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
      const outcome = await readInitialPagesDeploymentOutcome(paths.initialDeployment, build);
      if (outcome.kind !== "success") {
        throw new TypeError("初回Pagesの成功receiptがありません");
      }
      const evidence = await initialPagesEvidenceForSplitReceipt(
        state.adapter,
        state.config.state,
        outcome.receipt,
      );
      await saveStageReceipts(adapters, paths, runId, prior, [
        { receipt: outcome.receipt, evidence },
      ]);
      return {};
    }
    case "settle-notifications": {
      const pagesIndex = prior.findLastIndex(
        (entry) =>
          entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
      );
      const pagesReceipt = prior[pagesIndex]?.receipt;
      if (pagesReceipt?.receiptType !== "pages_deployment") {
        throw new TypeError("通知段階の先行Pages receiptがありません");
      }
      const outcome = await execute("initial_pages_published", "notifications_settled", () =>
        settleWorkflowNotifications(
          adapters,
          {
            configPath: command.configPath,
            initialStateReceiptPath: paths.initialReceipt,
            buildArtifactPath: paths.initialBuild,
            deploymentOutcomePath: paths.initialDeployment,
            settlementReceiptPath: paths.settlementReceipt,
            ...(command.manualResolutionReceiptPath == null
              ? {}
              : { manualResolutionReceiptPath: command.manualResolutionReceiptPath }),
          },
          pagesReceipt,
        ),
      );
      await saveStageReceipts(adapters, paths, runId, prior.slice(0, pagesIndex + 1), [
        ...outcome.messageReceipts,
        { receipt: outcome.receipt, evidence: outcome.receiptEvidence },
      ]);
      return {};
    }
    case "finalize-run": {
      const outcome = await execute("notifications_settled", "run_finalized", () =>
        finalizeWorkflowRun(adapters, {
          configPath: command.configPath,
          initialStateReceiptPath: paths.initialReceipt,
          settlementReceiptPath: paths.settlementReceipt,
          finalizationReceiptPath: paths.finalizationReceipt,
        }),
      );
      await saveStageReceipts(adapters, paths, runId, prior, [
        { receipt: outcome.receipt, evidence: outcome.receiptEvidence },
      ]);
      return {};
    }
    case "prepare-history-pages": {
      await execute("run_finalized", "notification_history_pages_prepared", () =>
        prepareWorkflowNotificationHistoryPages(adapters, {
          configPath: command.configPath,
          settlementReceiptPath: paths.settlementReceipt,
          finalizationReceiptPath: paths.finalizationReceipt,
          buildArtifactPath: paths.historyBuild,
          outputDirectory: paths.pagesOutput,
        }),
      );
      const build = decodeNotificationHistoryPagesBuildArtifact(await readFile(paths.historyBuild));
      await saveStageReceipts(adapters, paths, runId, prior, [
        { receipt: build.receipt, evidence: { kind: "none" } },
      ]);
      return {};
    }
    case "preflight-history-pages-deployment":
      if (current !== "notification_history_pages_prepared") {
        throw new TypeError("通知履歴Pages deploy前のbuild receiptがありません");
      }
      await preflightWorkflowNotificationHistoryDeployment(adapters, {
        configPath: command.configPath,
        settlementReceiptPath: paths.settlementReceipt,
        finalizationReceiptPath: paths.finalizationReceipt,
        buildArtifactPath: paths.historyBuild,
        previousOutcomePath: paths.historyDeployment,
        preflightPath: paths.historyPreflight,
        runAttempt: command.runAttempt,
      });
      await adapters.writeStandardOutput(
        serializeCanonicalJsonLine({
          runId,
          stage: command.stage,
          preflightPath: paths.historyPreflight,
        }),
      );
      return {};
    case "record-history-pages-deployment": {
      await execute(
        "notification_history_pages_prepared",
        "notification_history_pages_published",
        () =>
          recordWorkflowNotificationHistoryDeployment(adapters, {
            buildArtifactPath: paths.historyBuild,
            preflightPath: paths.historyPreflight,
            outcomePath: paths.historyDeployment,
          }),
      );
      const build = decodeNotificationHistoryPagesBuildArtifact(await readFile(paths.historyBuild));
      const outcome = decodeNotificationHistoryPagesDeploymentOutcome(
        await readFile(paths.historyDeployment),
        build,
      );
      if (outcome.kind === "failure") {
        throw new TypeError("通知履歴Pagesの成功receiptがありません");
      }
      await saveStageReceipts(adapters, paths, runId, prior, [
        { receipt: outcome.receipt, evidence: { kind: "none" } },
      ]);
      return {};
    }
    case "complete": {
      const completed = await execute("notification_history_pages_published", "completed", () => {
        const finalization = prior.findLast(
          (entry) => entry.receipt.receiptType === "run_finalization",
        )?.receipt;
        if (finalization?.receiptType !== "run_finalization") {
          throw new TypeError("完了に必要なfinalization receiptがありません");
        }
        return Promise.resolve(
          completeTrackingRun(
            {
              entries: prior,
              finalStateRevision: finalization.result.resultingStateRevision,
              invocationId,
              observedAt: adapters.now().toISOString(),
            },
            digest,
          ),
        );
      });
      await adapters.writeJsonArtifact(paths.completionReceipt, completed.receipt);
      await saveStageReceipts(adapters, paths, runId, prior, [
        { receipt: completed.receipt, evidence: { kind: "none" } },
      ]);
      return {};
    }
  }
}

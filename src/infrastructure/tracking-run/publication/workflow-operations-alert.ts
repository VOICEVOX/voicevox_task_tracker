import { resolve } from "node:path";

import { operationsIncidentKindForFailure } from "../../../application/tracking-run/failure-primary.js";
import {
  DiscordOperationsPostSendError,
  DiscordWebhookDeliveryUnknownError,
} from "../../../discord/index.js";
import {
  assertOperationsAlertLedgerWritable,
  loadOperationsAlertLedger,
} from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/assert-non-nullable.js";
import { OperationsAlertReceiptFailureError } from "../failure-context-error.js";
import {
  OperationsAlertCommitFailureError,
  OperationsAlertNoEffectError,
  OperationsAlertPendingDeliveryError,
  deliverOperationsAlert,
} from "../notification-delivery-runtime.js";
import type { NotifyOperationsCliCommand } from "../operations-command-input.js";
import {
  createWorkflowInfrastructureFailure,
  primaryAlertFailure,
  readWorkflowFailureArtifacts,
} from "../operations-failure-selection.js";
import { readPriorOperationsAlertReceipts } from "../operations-alert-receipt-file.js";
import { assertPriorOperationsAlertDeliveries } from "../operations-alert-receipt-state.js";
import { createOperationsAlertReceipt } from "../operations-alert-receipt.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import type { RunPublicationAdapters } from "./contracts.js";
import { discordDeliverySettings } from "./settings.js";

type WorkflowDeliveryAdapters = Pick<
  RunPublicationAdapters,
  | "environment"
  | "repositoryPath"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "now"
  | "sleep"
  | "random"
  | "sendDiscord"
  | "diagnosticsRecorder"
  | "writeJsonArtifact"
>;

/** workflowの障害通知を実行する。 */
export async function notifyWorkflowOperations(
  dependencies: Readonly<{ adapters: WorkflowDeliveryAdapters }>,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  const failureDirectory = resolve(dependencies.adapters.repositoryPath, command.failureDirectory);
  const outputFailureDirectory = resolve(
    dependencies.adapters.repositoryPath,
    command.outputFailureDirectory,
  );
  if (failureDirectory === outputFailureDirectory) {
    throw new TypeError("元jobの公開失敗artifactと通知jobの出力先が同じです");
  }
  const configuredFailureDirectory =
    dependencies.adapters.environment["VOICEVOX_TASK_TRACKER_FAILURE_DIRECTORY"];
  if (
    configuredFailureDirectory != null &&
    resolve(dependencies.adapters.repositoryPath, configuredFailureDirectory) !==
      outputFailureDirectory
  ) {
    throw new TypeError("通知jobの公開失敗artifact出力先がCLI境界と一致しません");
  }
  const artifacts = await readWorkflowFailureArtifacts(failureDirectory);
  if (artifacts.some((artifact) => artifact.failure.failureKind === "public_boundary")) {
    return;
  }
  const recorder = dependencies.adapters.diagnosticsRecorder;
  let primary;
  if (artifacts.length === 0) {
    assertNonNullable(recorder, "運用障害通知の暗号化診断recorderがありません");
    primary = await createWorkflowInfrastructureFailure(
      outputFailureDirectory,
      command.failedJobs,
      recorder,
    );
  } else {
    primary = primaryAlertFailure(artifacts);
  }
  if (primary == null) {
    throw new TypeError("公開失敗artifactの主因を選べません");
  }
  const incidentKind = operationsIncidentKindForFailure(primary.failure);
  const incidentId = `${command.workflowRunId}:${incidentKind}:${primary.failure.failedStage}`;
  createOperationsAlertReceipt(
    primary,
    incidentId,
    dependencies.adapters.now().toISOString(),
    { status: "no_effect" },
    undefined,
  );
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    config.staleness.timezone,
  );
  await assertOperationsAlertLedgerWritable(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
    session.baseRevision,
  );
  const snapshot = await session.loadSnapshot();
  const state = Object.freeze({
    session,
    snapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const priorReceipts = await readPriorOperationsAlertReceipts(
    resolve(dependencies.adapters.repositoryPath, command.receiptPath),
    resolve(dependencies.adapters.repositoryPath, command.previousReceiptsDirectory),
    resolve(dependencies.adapters.repositoryPath, command.previousFailuresDirectory),
    command.workflowRunId,
    command.workflowRunAttempt,
    command.workflowKind,
    primary,
    incidentId,
  );
  const priorDeliveries = priorReceipts.filter((receipt) => receipt.status !== "no_effect");
  if (priorDeliveries.length > 0) {
    const dedicated = await loadOperationsAlertLedger(
      dependencies.adapters.createStateBranchAdapter(),
      config.state,
    );
    await assertPriorOperationsAlertDeliveries(
      dependencies.adapters.createStateBranchAdapter(),
      dedicated.head,
      dedicated.ledger.operationsAlerts,
      session.baseRevision,
      state.notificationLedger.operationsAlerts,
      priorDeliveries,
      incidentId,
      incidentKind,
    );
  }
  const knownSecrets = config.notifications.discord.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          dependencies.adapters.environment,
          config.notifications.discord.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  const hasFinalEvidence =
    primary.failure.failedStage === "notification_history_pages_prepared" ||
    primary.failure.failedStage === "notification_history_pages_published" ||
    (primary.failure.failedStage === "workflow_effect_observation" &&
      primary.failure.failureKind === "diagnostics_encryption_failure");
  let delivered: Awaited<ReturnType<typeof deliverOperationsAlert>>;
  try {
    delivered = await deliverOperationsAlert(
      dependencies.adapters,
      discordDeliverySettings(config),
      knownSecrets,
      state,
      config.state,
      {
        incidentId,
        kind: incidentKind,
        occurredAt: command.occurredAt,
        retryAttempts: command.retryAttempts,
        context: {
          failureKind: primary.failure.failureKind,
          failedStage: primary.failure.failedStage,
          ...(hasFinalEvidence && primary.failure.finalStateRevision != null
            ? { finalStateRevision: primary.failure.finalStateRevision }
            : {}),
          ...(hasFinalEvidence && primary.failure.lastReceiptDigest != null
            ? { lastReceiptDigest: primary.failure.lastReceiptDigest }
            : {}),
        },
      },
    );
  } catch (error: unknown) {
    if (
      !(error instanceof OperationsAlertCommitFailureError) &&
      !(error instanceof OperationsAlertPendingDeliveryError) &&
      !(error instanceof OperationsAlertNoEffectError) &&
      !(error instanceof DiscordOperationsPostSendError) &&
      !(error instanceof DiscordWebhookDeliveryUnknownError)
    ) {
      throw error;
    }
    let delivery: Parameters<typeof createOperationsAlertReceipt>[3];
    if (error instanceof OperationsAlertNoEffectError) {
      delivery = { status: "no_effect" };
    } else if (error instanceof OperationsAlertCommitFailureError) {
      delivery = {
        status: "ambiguous",
        discordMessageId: error.discordMessageId,
        observedOperationsLedgerState: error.observedState,
      };
    } else if (error instanceof DiscordOperationsPostSendError) {
      delivery = { status: "ambiguous", discordMessageId: error.discordMessageId };
    } else {
      delivery = { status: "ambiguous" };
    }
    try {
      const receipt = createOperationsAlertReceipt(
        primary,
        incidentId,
        dependencies.adapters.now().toISOString(),
        delivery,
        undefined,
      );
      await dependencies.adapters.writeJsonArtifact(
        resolve(dependencies.adapters.repositoryPath, command.receiptPath),
        receipt,
      );
    } catch (receiptError: unknown) {
      throw new OperationsAlertReceiptFailureError(
        delivery.status === "no_effect" ? "no_effect" : "ambiguous",
        new AggregateError(
          [error, receiptError],
          "運用障害通知の失敗receiptを保存できませんでした",
          {
            cause: error,
          },
        ),
      );
    }
    throw error;
  }
  const operationsDelivery = delivered.delivery;
  try {
    const receipt = createOperationsAlertReceipt(
      primary,
      incidentId,
      dependencies.adapters.now().toISOString(),
      operationsDelivery.status === "sent"
        ? { status: "sent", discordMessageId: operationsDelivery.discordMessageId }
        : { status: "no_effect" },
      delivered.operationsCommit,
    );
    await dependencies.adapters.writeJsonArtifact(
      resolve(dependencies.adapters.repositoryPath, command.receiptPath),
      receipt,
    );
  } catch (error: unknown) {
    throw new OperationsAlertReceiptFailureError(
      operationsDelivery.status === "sent" ? "committed" : "no_effect",
      error,
    );
  }
}

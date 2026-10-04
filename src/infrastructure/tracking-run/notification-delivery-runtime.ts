import {
  DiscordOperationsPostSendError,
  DiscordPayloadError,
  DiscordWebhookDeliveryUnknownError,
  DiscordWebhookRequestError,
  DiscordWebhookSecretInvalidError,
  DiscordWebhookSecretMissingError,
  DiscordWebhookSecretReadError,
  buildDiscordOperationsAlertPlan,
  sendDiscordOperationsAlert,
  type DiscordDeliveryDependencies,
  type DiscordDeliverySettings,
  type DiscordOperationsAlertDelivery,
  type DiscordOperationsIncident,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
} from "../../discord/index.js";
import {
  buildDiscordInfrastructureAlertPlan,
  sendDiscordInfrastructureAlert,
  type WorkflowInfrastructureIncident,
} from "../../discord/infrastructure-alert.js";
import { createUtcIsoDateTime, type OperationsAlertLedgerEntry } from "../../domain/index.js";
import {
  assertExistingStatePublicSafety,
  assertOperationsAlertLedgerWritable,
  commitOperationsAlertLedger,
  loadOperationsAlertLedger,
  releaseOperationsAlertDelivery,
  reserveOperationsAlertDelivery,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateOperationsAlertReservation,
  type StatePersistenceConfiguration,
  type StatePersistenceSession,
  type StateSnapshot,
  type StateSnapshotReadResult,
} from "../../persistence/index.js";
import { operationsAlertLedgerEntry } from "../../persistence/notification-ledger-normalization.js";
import { requireEnvironmentValue } from "./production-runtime-setup.js";

type NotificationDeliveryRuntimeAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  createStateBranchAdapter: () => StateBranchAdapter;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
}>;

type NotificationDeliveryRuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
}>;

type OperationsIncident =
  | (DiscordOperationsIncident &
      Readonly<{
        context?: Readonly<{
          failureKind: string;
          failedStage: string;
          finalStateRevision?: string;
          lastReceiptDigest?: string;
        }>;
      }>)
  | WorkflowInfrastructureIncident;

/** Discord送信後に専用ledgerへの確定記録が失敗したことを表す。 */
export class OperationsAlertCommitFailureError extends Error {
  public readonly discordMessageId: string;
  public readonly observedState: "sent" | "reserved" | "absent" | "unverified";

  public constructor(
    discordMessageId: string,
    observedState: "sent" | "reserved" | "absent" | "unverified",
    cause: unknown,
  ) {
    super("運用障害通知の送信後にledgerを確定できませんでした", { cause });
    this.discordMessageId = discordMessageId;
    this.observedState = observedState;
  }
}

/** 送信結果未確定の予約が残るため同じ通知を停止する。 */
export class OperationsAlertPendingDeliveryError extends Error {
  public constructor(cause?: unknown) {
    super("運用障害通知の送信結果が未確定です。手動で確認してください", { cause });
  }
}

/** 明確な不送信後に予約を解除したことを表す。 */
export class OperationsAlertNoEffectError extends Error {
  public constructor(cause: unknown) {
    super("運用障害通知は送信されませんでした", { cause });
  }
}

function previousSnapshot(state: NotificationDeliveryRuntimeState): StateSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot.snapshot : undefined;
}

function environmentSecretProvider(
  environment: Readonly<NodeJS.ProcessEnv>,
): DiscordSecretProvider {
  return Object.freeze({
    read: (name) => requireEnvironmentValue(environment, name),
  });
}

async function observeOperationsAlertState(
  adapters: NotificationDeliveryRuntimeAdapters,
  configuration: StatePersistenceConfiguration,
  alertKey: string,
  discordMessageId: string,
): Promise<"sent" | "reserved" | "absent" | "unverified"> {
  const adapter = adapters.createStateBranchAdapter();
  const { ledger } = await loadOperationsAlertLedger(adapter, configuration);
  const sent = ledger.operationsAlerts.find((entry) => entry.alertKey === alertKey);
  if (sent != null) {
    return sent.discordMessageId === discordMessageId ? "sent" : "unverified";
  }
  return ledger.deliveryReservations.some((entry) => entry.alertKey === alertKey)
    ? "reserved"
    : "absent";
}

/** 運用障害通知を送達し、成功した通知管理記録を保存する。 */
export async function deliverOperationsAlert(
  adapters: NotificationDeliveryRuntimeAdapters,
  settings: DiscordDeliverySettings,
  knownSecrets: readonly string[],
  state: NotificationDeliveryRuntimeState,
  configuration: StatePersistenceConfiguration,
  incident: OperationsIncident,
): Promise<
  Readonly<{
    delivery: DiscordOperationsAlertDelivery;
    operationsCommit?: StateBranchCommitResult;
  }>
> {
  const currentNotificationLedger = await state.session.loadNotificationLedger();
  await assertOperationsAlertLedgerWritable(
    adapters.createStateBranchAdapter(),
    configuration,
    state.session.baseRevision,
  );
  const existing = await loadOperationsAlertLedger(
    adapters.createStateBranchAdapter(),
    configuration,
  );
  assertExistingStatePublicSafety(
    previousSnapshot(state),
    await state.session.loadHistoryRecords(),
    currentNotificationLedger,
    [incident, existing.ledger],
    knownSecrets,
  );
  if (!settings.enabled) {
    return Object.freeze({ delivery: { status: "disabled" } });
  }
  const alertKey =
    incident.kind === "workflow_infrastructure_failure"
      ? buildDiscordInfrastructureAlertPlan(incident).alertKey
      : buildDiscordOperationsAlertPlan(incident).alertKey;
  const recorded = [
    ...currentNotificationLedger.operationsAlerts,
    ...existing.ledger.operationsAlerts,
  ].find((entry) => entry.alertKey === alertKey);
  if (recorded != null) {
    if (recorded.incidentId !== incident.incidentId || recorded.kind !== incident.kind) {
      throw new TypeError("運用障害通知ledgerのincidentが一致しません");
    }
    return Object.freeze({ delivery: { status: "already_recorded", alertKey } });
  }
  if (existing.ledger.deliveryReservations.some((entry) => entry.alertKey === alertKey)) {
    throw new OperationsAlertPendingDeliveryError();
  }
  const startedAt = createUtcIsoDateTime(adapters.now().toISOString());
  if (startedAt < incident.occurredAt) {
    throw new RangeError("運用障害通知の開始時刻が障害発生時刻より前です");
  }
  const reservation: StateOperationsAlertReservation = {
    alertKey,
    incidentId: incident.incidentId,
    kind: incident.kind,
    occurredAt: incident.occurredAt,
    startedAt,
  };
  const reservationCommit = await reserveOperationsAlertDelivery(
    adapters.createStateBranchAdapter(),
    configuration,
    existing.head,
    reservation,
  );
  const operationsAlertsByKey = new Map<string, OperationsAlertLedgerEntry>(
    [...currentNotificationLedger.operationsAlerts, ...existing.ledger.operationsAlerts].map(
      (entry) => [entry.alertKey, operationsAlertLedgerEntry(entry)],
    ),
  );
  const deliveryDependencies: DiscordDeliveryDependencies = {
    secretProvider: environmentSecretProvider(adapters.environment),
    httpClient: adapters.discordHttpClient,
    runtime: {
      now: adapters.now,
      sleep: adapters.sleep,
      random: adapters.random,
    },
    ledger: {
      hasOperationsAlert: (alertKey) => Promise.resolve(operationsAlertsByKey.has(alertKey)),
      recordNotifications: () =>
        Promise.reject(new TypeError("運用通知から通常ledgerを更新できません")),
      recordOperationsAlert: (entry) => {
        operationsAlertsByKey.set(entry.alertKey, entry);
        return Promise.resolve();
      },
    },
  };
  let operationsAlert: DiscordOperationsAlertDelivery;
  try {
    operationsAlert =
      incident.kind === "workflow_infrastructure_failure"
        ? await sendDiscordInfrastructureAlert(incident, settings, deliveryDependencies)
        : await sendDiscordOperationsAlert({
            incident,
            settings,
            dependencies: deliveryDependencies,
          });
  } catch (error: unknown) {
    if (
      error instanceof DiscordWebhookRequestError ||
      error instanceof DiscordWebhookSecretInvalidError ||
      error instanceof DiscordWebhookSecretMissingError ||
      error instanceof DiscordWebhookSecretReadError ||
      error instanceof DiscordPayloadError
    ) {
      try {
        await releaseOperationsAlertDelivery(
          adapters.createStateBranchAdapter(),
          configuration,
          { status: "present", revision: reservationCommit.revision },
          reservation,
        );
      } catch (releaseError: unknown) {
        throw new OperationsAlertPendingDeliveryError(
          new AggregateError([error, releaseError], "運用障害通知の送信予約を解除できませんでした"),
        );
      }
      throw new OperationsAlertNoEffectError(error);
    }
    if (
      error instanceof DiscordOperationsPostSendError ||
      error instanceof DiscordWebhookDeliveryUnknownError
    ) {
      throw error;
    }
    throw new OperationsAlertPendingDeliveryError(error);
  }
  const operationsDelivery = operationsAlert;
  if (operationsDelivery.status !== "sent") {
    throw new OperationsAlertPendingDeliveryError(
      new TypeError("送信予約後の運用障害通知に送信結果がありません"),
    );
  }
  let operationsCommit: StateBranchCommitResult;
  try {
    operationsCommit = await commitOperationsAlertLedger(
      adapters.createStateBranchAdapter(),
      configuration,
      { status: "present", revision: reservationCommit.revision },
      operationsDelivery.ledgerEntry,
    );
  } catch (error: unknown) {
    let observedState: "sent" | "reserved" | "absent" | "unverified" = "unverified";
    let cause = error;
    try {
      observedState = await observeOperationsAlertState(
        adapters,
        configuration,
        alertKey,
        operationsDelivery.discordMessageId,
      );
    } catch (observationError: unknown) {
      cause = new AggregateError(
        [error, observationError],
        "運用障害通知ledgerを再観測できませんでした",
        {
          cause: error,
        },
      );
    }
    throw new OperationsAlertCommitFailureError(
      operationsDelivery.discordMessageId,
      observedState,
      cause,
    );
  }
  return Object.freeze({
    delivery: operationsDelivery,
    operationsCommit,
  });
}

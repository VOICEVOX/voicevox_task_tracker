import {
  DiscordDigestDeliveryError,
  DiscordLedgerError,
  DiscordWebhookRetryExhaustedError,
} from "./errors.js";
import {
  buildDiscordDigestPlan,
  buildDiscordOperationsAlertPlan,
  type DiscordMentionSettings,
  type DiscordOperationsIncident,
} from "./payload.js";
import { type DiscordNotificationCandidate } from "./notification-selection.js";
import {
  executeDiscordWebhook,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
  type DiscordWebhookRetrySettings,
  type DiscordWebhookRuntime,
} from "./webhook.js";
import {
  createUtcIsoDateTime,
  type NotificationLedgerEntry,
  type OperationsAlertLedgerEntry,
  type TrackedItem,
  type UtcIsoDateTime,
} from "../domain/index.js";

export type DiscordDeliverySettings = Readonly<{
  enabled: boolean;
  webhookSecretName: string;
  operationsWebhookSecretName: string;
  mentions: DiscordMentionSettings;
  retry: DiscordWebhookRetrySettings;
}>;

export type DiscordDeliveryLedger = Readonly<{
  hasOperationsAlert: (alertKey: string) => Promise<boolean>;
  recordNotifications: (entries: readonly NotificationLedgerEntry[]) => Promise<void>;
  recordOperationsAlert: (entry: OperationsAlertLedgerEntry) => Promise<void>;
}>;

export type DiscordDeliveryDependencies = Readonly<{
  secretProvider: DiscordSecretProvider;
  httpClient: DiscordWebhookHttpClient;
  runtime: DiscordWebhookRuntime;
  ledger: DiscordDeliveryLedger;
}>;

export type DiscordPagesDeployment =
  | Readonly<{
      status: "succeeded";
      pagesUrl: string;
    }>
  | Readonly<{
      status: "failed";
      incidentId: string;
      kind: DiscordOperationsIncident["kind"];
      failedAt: UtcIsoDateTime;
      retryAttempts: number;
    }>;

export type SendDiscordDigestInput = Readonly<{
  candidates: readonly DiscordNotificationCandidate[];
  ledgerReservations: readonly NotificationLedgerEntry[];
  items: readonly TrackedItem[];
  generatedAt: UtcIsoDateTime;
  pagesDeployment: DiscordPagesDeployment;
  settings: DiscordDeliverySettings;
  dependencies: DiscordDeliveryDependencies;
}>;

export type SendDiscordOperationsAlertInput = Readonly<{
  incident: DiscordOperationsIncident;
  settings: DiscordDeliverySettings;
  dependencies: DiscordDeliveryDependencies;
}>;

export type DiscordOperationsAlertDelivery =
  | Readonly<{
      status: "disabled";
    }>
  | Readonly<{
      status: "already_recorded";
      alertKey: string;
    }>
  | Readonly<{
      status: "sent";
      alertKey: string;
      discordMessageId: string;
      ledgerEntry: OperationsAlertLedgerEntry;
    }>;

export type DiscordDigestDelivery =
  | Readonly<{
      status: "disabled";
    }>
  | Readonly<{
      status: "skipped";
      reason: "no_candidates";
    }>
  | Readonly<{
      status: "skipped";
      reason: "pages_deployment_failed";
      operationsAlert: DiscordOperationsAlertDelivery;
    }>
  | Readonly<{
      status: "sent";
      digestId: string;
      discordMessageIds: readonly string[];
      ledgerEntries: readonly NotificationLedgerEntry[];
    }>;

function createSafeLedgerCause(error: unknown): Error {
  if (error instanceof Error && error.message.length > 0) {
    return new Error(error.message);
  }
  return new Error("ledger adapterの処理が失敗しました");
}

function currentUtcDateTime(runtime: DiscordWebhookRuntime): UtcIsoDateTime {
  const current = runtime.now();
  if (!Number.isFinite(current.getTime())) {
    throw new TypeError("Discord runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(current.toISOString());
}

function createSentNotificationEntries(
  reservations: ReadonlyMap<string, NotificationLedgerEntry>,
  notificationKeys: readonly string[],
  sentAt: UtcIsoDateTime,
  discordMessageId: string,
): readonly NotificationLedgerEntry[] {
  const sentEntries = notificationKeys.map((notificationKey) => {
    const reservation = reservations.get(notificationKey);
    if (reservation?.status !== "reserved") {
      throw new DiscordLedgerError("write", {
        cause: new TypeError("送信messageに対応するledger予約がありません"),
      });
    }
    if (sentAt < reservation.reservedAt) {
      throw new DiscordLedgerError("write", {
        cause: new RangeError("ledgerの送信時刻が予約時刻より前です"),
      });
    }
    if (sentAt > reservation.expiresAt) {
      throw new DiscordLedgerError("write", {
        cause: new RangeError("ledgerの送信時刻が予約期限より後です"),
      });
    }
    return Object.freeze({
      notificationKey: reservation.notificationKey,
      itemNodeId: reservation.itemNodeId,
      reasonCode: reservation.reasonCode,
      severity: reservation.severity,
      reservedAt: reservation.reservedAt,
      cooldownUntil: reservation.cooldownUntil,
      status: "sent",
      sentAt,
      discordMessageId,
    } satisfies NotificationLedgerEntry);
  });
  return Object.freeze(sentEntries);
}

async function recordSentNotifications(
  ledger: DiscordDeliveryLedger,
  entries: readonly NotificationLedgerEntry[],
): Promise<void> {
  try {
    await ledger.recordNotifications(entries);
  } catch (error: unknown) {
    throw new DiscordLedgerError("write", {
      cause: createSafeLedgerCause(error),
    });
  }
}

async function hasOperationsAlert(
  ledger: DiscordDeliveryLedger,
  alertKey: string,
): Promise<boolean> {
  try {
    return await ledger.hasOperationsAlert(alertKey);
  } catch (error: unknown) {
    throw new DiscordLedgerError("read", {
      cause: createSafeLedgerCause(error),
    });
  }
}

async function recordOperationsAlert(
  ledger: DiscordDeliveryLedger,
  entry: OperationsAlertLedgerEntry,
): Promise<void> {
  try {
    await ledger.recordOperationsAlert(entry);
  } catch (error: unknown) {
    throw new DiscordLedgerError("write", {
      cause: createSafeLedgerCause(error),
    });
  }
}

function operationsAlertStatus(
  delivery: DiscordOperationsAlertDelivery,
): "sent" | "already_recorded" | "failed" {
  switch (delivery.status) {
    case "sent":
      return "sent";
    case "already_recorded":
      return "already_recorded";
    case "disabled":
      return "failed";
  }
}

async function reportDiscordDeliveryFailure(
  digestId: string,
  failure: DiscordWebhookRetryExhaustedError,
  input: SendDiscordDigestInput,
): Promise<never> {
  const occurredAt = currentUtcDateTime(input.dependencies.runtime);
  try {
    const delivery = await sendDiscordOperationsAlert({
      incident: {
        incidentId: digestId,
        kind: "discord",
        occurredAt,
        retryAttempts: failure.attempts,
      },
      settings: input.settings,
      dependencies: input.dependencies,
    });
    throw new DiscordDigestDeliveryError(digestId, operationsAlertStatus(delivery), {
      cause: failure,
    });
  } catch (error: unknown) {
    if (error instanceof DiscordDigestDeliveryError) {
      throw error;
    }
    throw new DiscordDigestDeliveryError(digestId, "failed", {
      cause: new AggregateError(
        [failure, error],
        "通常digestと運用障害通知のDiscord送信が失敗しました",
      ),
    });
  }
}

/** 運用障害を通常digestと別messageで一度だけ送信しledgerへ記録する。 */
export async function sendDiscordOperationsAlert(
  input: SendDiscordOperationsAlertInput,
): Promise<DiscordOperationsAlertDelivery> {
  if (!input.settings.enabled) {
    return Object.freeze({
      status: "disabled",
    });
  }
  const plan = buildDiscordOperationsAlertPlan(input.incident);
  if (await hasOperationsAlert(input.dependencies.ledger, plan.alertKey)) {
    return Object.freeze({
      status: "already_recorded",
      alertKey: plan.alertKey,
    });
  }
  const execution = await executeDiscordWebhook({
    secretName: input.settings.operationsWebhookSecretName,
    payload: plan.payload,
    retry: input.settings.retry,
    secretProvider: input.dependencies.secretProvider,
    httpClient: input.dependencies.httpClient,
    runtime: input.dependencies.runtime,
  });
  const sentAt = currentUtcDateTime(input.dependencies.runtime);
  if (sentAt < input.incident.occurredAt) {
    throw new DiscordLedgerError("write", {
      cause: new RangeError("運用障害通知の送信時刻が障害発生時刻より前です"),
    });
  }
  const ledgerEntry = Object.freeze({
    alertKey: plan.alertKey,
    incidentId: input.incident.incidentId,
    kind: input.incident.kind,
    occurredAt: input.incident.occurredAt,
    sentAt,
    discordMessageId: execution.discordMessageId,
  } satisfies OperationsAlertLedgerEntry);
  await recordOperationsAlert(input.dependencies.ledger, ledgerEntry);
  return Object.freeze({
    status: "sent",
    alertKey: plan.alertKey,
    discordMessageId: execution.discordMessageId,
    ledgerEntry,
  });
}

/** Pages成功後にだけ通常digestを送り、各message成功直後にledgerへ記録する。 */
export async function sendDiscordDigest(
  input: SendDiscordDigestInput,
): Promise<DiscordDigestDelivery> {
  if (!input.settings.enabled) {
    return Object.freeze({
      status: "disabled",
    });
  }
  if (input.pagesDeployment.status === "failed") {
    const operationsAlert = await sendDiscordOperationsAlert({
      incident: {
        incidentId: input.pagesDeployment.incidentId,
        kind: input.pagesDeployment.kind,
        occurredAt: input.pagesDeployment.failedAt,
        retryAttempts: input.pagesDeployment.retryAttempts,
      },
      settings: input.settings,
      dependencies: input.dependencies,
    });
    return Object.freeze({
      status: "skipped",
      reason: "pages_deployment_failed",
      operationsAlert,
    });
  }
  if (input.candidates.length === 0) {
    if (input.ledgerReservations.length !== 0) {
      throw new DiscordLedgerError("read", {
        cause: new TypeError("通知候補が0件のときledger予約は空にしてください"),
      });
    }
    return Object.freeze({
      status: "skipped",
      reason: "no_candidates",
    });
  }

  const plan = buildDiscordDigestPlan({
    candidates: input.candidates,
    ledgerReservations: input.ledgerReservations,
    items: input.items,
    pagesUrl: input.pagesDeployment.pagesUrl,
    generatedAt: input.generatedAt,
    mentions: input.settings.mentions,
  });
  const reservations = new Map(
    input.ledgerReservations.map((reservation) => [reservation.notificationKey, reservation]),
  );
  const discordMessageIds: string[] = [];
  const ledgerEntries: NotificationLedgerEntry[] = [];
  for (const message of plan.messages) {
    let execution;
    try {
      execution = await executeDiscordWebhook({
        secretName: input.settings.webhookSecretName,
        payload: message.payload,
        retry: input.settings.retry,
        secretProvider: input.dependencies.secretProvider,
        httpClient: input.dependencies.httpClient,
        runtime: input.dependencies.runtime,
      });
    } catch (error: unknown) {
      if (error instanceof DiscordWebhookRetryExhaustedError) {
        return reportDiscordDeliveryFailure(plan.digestId, error, input);
      }
      throw error;
    }
    const sentEntries = createSentNotificationEntries(
      reservations,
      message.notificationKeys,
      currentUtcDateTime(input.dependencies.runtime),
      execution.discordMessageId,
    );
    await recordSentNotifications(input.dependencies.ledger, sentEntries);
    discordMessageIds.push(execution.discordMessageId);
    ledgerEntries.push(...sentEntries);
  }
  return Object.freeze({
    status: "sent",
    digestId: plan.digestId,
    discordMessageIds: Object.freeze(discordMessageIds),
    ledgerEntries: Object.freeze(ledgerEntries),
  });
}

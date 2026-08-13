import { DiscordDigestDeliveryError, DiscordWebhookRetryExhaustedError } from "./errors.js";
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
import { createUtcIsoDateTime, type TrackedItem, type UtcIsoDateTime } from "../domain/index.js";

export type DiscordDeliverySettings = Readonly<{
  enabled: boolean;
  webhookSecretName: string;
  operationsWebhookSecretName: string;
  mentions: DiscordMentionSettings;
  retry: DiscordWebhookRetrySettings;
}>;

export type DiscordDeliveryDependencies = Readonly<{
  secretProvider: DiscordSecretProvider;
  httpClient: DiscordWebhookHttpClient;
  runtime: DiscordWebhookRuntime;
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
      status: "sent";
      alertKey: string;
      discordMessageId: string;
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
    }>;

function currentUtcDateTime(runtime: DiscordWebhookRuntime): UtcIsoDateTime {
  const current = runtime.now();
  if (!Number.isFinite(current.getTime())) {
    throw new TypeError("Discord runtimeのnowは有効な日時を返してください");
  }
  return createUtcIsoDateTime(current.toISOString());
}

function operationsAlertStatus(delivery: DiscordOperationsAlertDelivery): "sent" | "failed" {
  switch (delivery.status) {
    case "sent":
      return "sent";
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

/** 運用障害を通常digestと別messageで送信する。 */
export async function sendDiscordOperationsAlert(
  input: SendDiscordOperationsAlertInput,
): Promise<DiscordOperationsAlertDelivery> {
  if (!input.settings.enabled) {
    return Object.freeze({
      status: "disabled",
    });
  }
  const plan = buildDiscordOperationsAlertPlan(input.incident);
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
    throw new RangeError("運用障害通知の送信時刻が障害発生時刻より前です");
  }
  return Object.freeze({
    status: "sent",
    alertKey: plan.alertKey,
    discordMessageId: execution.discordMessageId,
  });
}

/** Pages成功後にだけ通常digestを送信する。 */
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
    return Object.freeze({
      status: "skipped",
      reason: "no_candidates",
    });
  }

  const plan = buildDiscordDigestPlan({
    candidates: input.candidates,
    items: input.items,
    pagesUrl: input.pagesDeployment.pagesUrl,
    generatedAt: input.generatedAt,
    mentions: input.settings.mentions,
  });
  const discordMessageIds: string[] = [];
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
    discordMessageIds.push(execution.discordMessageId);
  }
  return Object.freeze({
    status: "sent",
    digestId: plan.digestId,
    discordMessageIds: Object.freeze(discordMessageIds),
  });
}
